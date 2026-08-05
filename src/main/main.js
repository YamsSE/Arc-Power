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

import { app, BrowserWindow, Tray, Menu, nativeImage } from 'electron';
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
import { createStartup, createMockStartup } from './startup.js';
import { createDriverInfo, createMockDriverInfo } from './driver-info.js';
import { createPresentmonAdapter } from './presentmon/presentmon-client.js';
import { applyProfile, runApplyOnStartup } from './apply-on-boot.js';
import { createTray, buildTrayMenuTemplate, TRAY_LABEL_TOGGLE, trayBalloonForOutcome } from './tray.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const headless = process.argv.includes('--headless');
const uiVerify = process.argv.includes('--ui-verify');
// --ui-verify is dev tooling: it ALWAYS uses the mock backend (never touches
// hardware), so treat it as mock for backend selection.
const mock = process.argv.includes('--mock') || process.env.RID_BACKEND === 'mock' || uiVerify;
const applyProfileIdx = process.argv.indexOf('--apply-profile');
const applyProfileId = applyProfileIdx >= 0 ? process.argv[applyProfileIdx + 1] : null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Arc Power',
    backgroundColor: '#0f1116',
    // M2b UX: no visible Electron menu bar (an Alt-key shortcut can reveal
    // it later if ever needed).
    autoHideMenuBar: true,
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

// --- system tray (normal app path only — never headless) -------------------
// The menu is rebuilt from the persisted active profile at boot; M2b-B can
// rebuild it when the profile changes.
let trayRef = null;
async function setupTray({ getWindow, backend, store }) {
  const menuTemplate = async () => {
    let hasActiveProfile = false;
    try {
      const settings = await store.loadSettings();
      const profiles = await store.loadProfiles();
      hasActiveProfile = settings.activeProfileId !== null
        && profiles.some((p) => p.id === settings.activeProfileId);
    } catch {
      hasActiveProfile = false;
    }
    return buildTrayMenuTemplate({
      hasActiveProfile,
      onToggle: () => {
        const win = getWindow();
        if (win) {
          if (win.isVisible()) win.hide();
          else { win.show(); win.focus(); }
        }
      },
      onApplyProfile: async () => {
        try {
          const activeProfileId = (await store.loadSettings()).activeProfileId;
          // Explicit user action: skips the ocOnBoot gate (like the
          // renderer's Load button) but keeps the waiver gates. The balloon
          // only claims "defaults restored" when a restore actually ran
          // (M2b review F1) — gate refusals get a reason-specific message.
          const out = await applyProfile({ backend, store, profileId: activeProfileId, getIgsState: () => igs.getState() });
          if (!out.applied && trayRef && !trayRef.isDestroyed()) {
            let name = 'unknown';
            try {
              const profiles = await store.loadProfiles();
              const p = profiles.find((x) => x.id === activeProfileId);
              if (p) name = p.name;
            } catch { /* best effort name */ }
            const content = trayBalloonForOutcome(out, name);
            if (content) trayRef.displayBalloon({ title: 'Arc Power', content });
          }
        } catch (err) {
          console.error(`[tray] apply active profile failed: ${err.message}`);
        }
      },
      onQuit: () => app.quit(),
    });
  };
  const tray = createTray({ tray: Tray, nativeImage, Menu, template: await menuTemplate() });
  trayRef = tray;
  // Rebuild the menu when the active profile changes (M2b-B calls this via
  // the window; for now the boot-time state is enough).
  tray.rebuildMenu = async () => { tray.setContextMenu(Menu.buildFromTemplate(await menuTemplate())); };
  return tray;
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
  // ONLY on an explicit user click (renderer-invoked). The mock default is
  // fully ON (this machine); the ui-verify retry scenarios run the IGS-off
  // variant via RID_MOCK_IGS_RUNNING=0 RID_MOCK_IGS_APP=0 (the fully-on fast
  // path legitimately takes a single attempt, so the retry UI only exercises
  // in the off variant).
  const igs = mock ? createMockIgs() : createIgs();
  // Run-key adapter: the real one writes HKCU only on an explicit user click
  // (startup-set IPC); mock mode (incl. --ui-verify) never touches the
  // registry.
  const startup = mock ? createMockStartup() : createStartup();
  // Driver-date adapter: real reg.exe query in the product path; mock mode
  // (incl. --ui-verify) returns the fixture date and never spawns reg.exe.
  const driverInfo = mock ? createMockDriverInfo() : createDriverInfo();
  // FPS adapter: mock mode reports unavailable (never loads koffi/PresentMon);
  // the product path starts the real client lazily on the first fps-poll.
  // On this machine the real client degrades to unavailable too (no
  // PresentMon service) — both modes show 'FPS unavailable'. The mock counts
  // polls so --ui-verify can assert the Monitoring page stops polling on
  // navigation away (M2b review F4).
  let fpsPolls = 0;
  const presentmon = mock
    ? { poll: async () => { fpsPolls += 1; return null; } }
    : createPresentmonAdapter();

  let teardown = null;
  app.on('before-quit', () => {
    void teardown?.().catch(() => {});
    void backend.close().catch(() => {});
  });

  // Boot-time health + waiver seeding (shared by the window path and the
  // apply-on-startup path).
  const bootBackend = async () => {
    try {
      await backend.init();
    } catch {
      // health() reports the init error; the window stays up degraded.
    }
    try { await seedWaiverState(backend, store); } catch (err) {
      console.log(`[boot] waiver seeding skipped: ${err.message}`);
    }
  };

  // --- apply-on-startup (`--apply-profile <id>`): no window, tray only ----
  if (applyProfileId && !uiVerify) {
    await bootBackend();
    // M2b review F2: the flow creates exactly ONE tray (it keeps the app
    // alive in this tray-only mode) and reuses it for the failure balloon.
    await runApplyOnStartup({
      backend,
      store,
      profileId: applyProfileId,
      setupTray: () => setupTray({ getWindow: () => null, backend, store }),
      log: (s) => console.log(s),
      getIgsState: () => igs.getState(),
    });
    return;
  }

  const win = createWindow();
  // Whitelisted IPC + telemetry ownership; the renderer drives everything.
  // --ui-verify never creates a tray, so rebuildTray guards the null ref.
  let trayRebuilds = 0;
  teardown = registerIpc({
    backend,
    store,
    getWindow: () => win,
    igs,
    startup,
    driverInfo,
    presentmon,
    // --ui-verify: short retry schedule so the io-failed retry scenarios
    // finish within the verification waits (persistent failure gives up fast
    // instead of holding the UI ~60 s). The product path uses the defaults.
    ...(uiVerify ? { applyRetryBackoffs: [100, 200, 300, 400, 500, 600, 700, 800], applyBudgetMs: 2500 } : {}),
    rebuildTray: async () => {
      try { await trayRef?.rebuildMenu?.(); } catch { /* tray unavailable */ }
      // Dev-only probe: lets --ui-verify assert that profile changes reach
      // the tray rebuild hook without a real tray existing.
      if (uiVerify) trayRebuilds += 1;
    },
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
    await runUiVerify(win, backend, () => trayRebuilds, () => fpsPolls);
    return;
  }

  await bootBackend();
  const health = await collectHealth(backend);
  console.log(`[health] ${JSON.stringify(health)}`);

  await setupTray({ getWindow: () => win, backend, store });
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}`);
  app.exit(1);
});
