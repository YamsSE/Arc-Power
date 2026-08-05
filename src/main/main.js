// Arc Power — Electron main process entry.
//
// Modes:
//   electron .                -> UI (M2a: design system, Dashboard, OC, Fan)
//   electron . --headless     -> M1 smoke sequence on the real A770, exit 0/1
//   electron . --headless --mock -> smoke against MockBackend (no hardware)
//
// The smoke path constructs the backend with allowAutoWaiver: true — the
// ONLY place product code may do that (developer's own machine, no value
// changes). The normal app path never auto-accepts a waiver; the renderer
// asks the user and calls waiver-accept over IPC.

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBackend } from './backend/index.js';
import { runSmoke } from './smoke.js';
import { runUiVerify } from './ui-verify.js';
import { collectHealth } from './health.js';
import { registerIpc } from './ipc.js';
import { seedWaiverState } from './ipc-core.js';
import { ProfileStore } from './store/profile-store.js';
import { createIgs, createMockIgs } from './igs-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const headless = process.argv.includes('--headless');
const uiVerify = process.argv.includes('--ui-verify');
// --ui-verify is dev tooling: it ALWAYS uses the mock backend (never touches
// hardware), so treat it as mock for backend selection.
const mock = process.argv.includes('--mock') || process.env.RID_BACKEND === 'mock' || uiVerify;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Arc Power',
    backgroundColor: '#0f1116',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '..', 'preload.cjs'),
    },
  });
  win.webContents.on('console-message', (event) => {
    // Electron >= 30: the event object carries { level, message, ... }.
    const level = typeof event.level === 'number' ? event.level : 0;
    const message = typeof event.message === 'string' ? event.message : '';
    if (level >= 2) console.error(`[renderer] ${message}`);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

async function main() {
  if (headless) {
    const backend = createBackend({
      kind: mock ? 'mock' : 'igcl',
      igcl: { allowAutoWaiver: true }, // smoke/tests only (plan §9 M1 waiver clause)
      mock: {},
    });
    try {
      const { lines } = await runSmoke(backend);
      console.log('\nSMOKE OK — ' + lines.filter((l) => l.startsWith('[health]')).length + ' health line(s), see above for the full sequence.');
      app.exit(0);
    } catch (err) {
      console.error(`\nSMOKE FAILED: ${err.message}`);
      app.exit(1);
    }
    return;
  }

  await app.whenReady();
  const win = createWindow();
  // --ui-verify runs against MockBackend; RID_MOCK_FAN_READONLY=1 switches
  // the mock to the A770 read-only fan fixture (verifies the read-only UI);
  // RID_MOCK_OFFGRID_FREQ_MHZ makes the mock report a freq offset off the
  // 1 MHz grid (verifies the off-grid driver readout). Both knobs are
  // mock-only dev tooling.
  const mockOpts = {};
  if (uiVerify && process.env.RID_MOCK_FAN_READONLY === '1') mockOpts.fanCanControl = false;
  if (uiVerify && process.env.RID_MOCK_OFFGRID_FREQ_MHZ !== undefined) {
    mockOpts.offGridFreqMhz = Number(process.env.RID_MOCK_OFFGRID_FREQ_MHZ);
  }
  const backend = createBackend({ kind: mock ? 'mock' : 'igcl', mock: mockOpts });
  const store = new ProfileStore();
  // IGS service adapter: mock mode (incl. --ui-verify) never touches the real
  // service; the real adapter only runs sc.exe probes, and disable/enable run
  // ONLY on an explicit user click (renderer-invoked).
  const igs = mock ? createMockIgs() : createIgs();
  // Whitelisted IPC + telemetry ownership; the renderer drives everything.
  const teardown = registerIpc({ backend, store, getWindow: () => win, igs });

  app.on('before-quit', () => {
    void teardown().catch(() => {});
    void backend.close().catch(() => {});
  });

  if (uiVerify) {
    // Dev-only end-to-end check against MockBackend (never hardware).
    await backend.init();
    // Seed a persisted waiver acceptance (F1) so the dialog does not re-show
    // across runs that share the settings.json data dir.
    try { await seedWaiverState(backend, store); } catch (err) {
      console.log(`[boot] waiver seeding skipped: ${err.message}`);
    }
    await new Promise((resolve) => {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
      else resolve();
    });
    await runUiVerify(win, backend);
    return;
  }

  // Boot-time health (degraded mode surfaces via the header status dot).
  try {
    await backend.init();
  } catch {
    // health() reports the init error; the window stays up degraded.
  }
  // Boot-time waiver seeding: a persisted acceptance from a previous launch
  // must not re-show the dialog. restoreWaiverState never calls the driver.
  try { await seedWaiverState(backend, store); } catch (err) {
    console.log(`[boot] waiver seeding skipped: ${err.message}`);
  }
  const health = await collectHealth(backend);
  console.log(`[health] ${JSON.stringify(health)}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  app.exit(1);
});
