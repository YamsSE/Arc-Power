// Arc Power - Electron main process entry.
//
// Modes:
//   electron .                -> UI (M2a: design system, Dashboard, OC, Fan)
//   electron . --headless     -> M1 smoke sequence on the real A770, exit 0/1
//   electron . --headless --mock -> smoke against MockBackend (no hardware)
//   electron . --apply-worker <reqFile> <outFile> -> M2C-C elevated
//     self-worker: hidden (no window/tray), never re-elevates, exits after
//     writing the result file. Spawned by the non-elevated app via
//     Start-Process -Verb RunAs (one UAC per apply).
//
// The smoke path constructs the backend with allowAutoWaiver: true - the
// ONLY place product code may do that (developer's own machine, no value
// changes). The normal app path never auto-accepts a waiver; the renderer
// asks the user and calls waiver-accept over IPC.

import { app, BrowserWindow, Tray, Menu, dialog, nativeImage, shell, globalShortcut } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createBackend } from './backend/index.js';
import { runSmoke } from './smoke.js';
import { runUiVerify, runFeaturesetVerify, runTweaksApplyVerify, runFanGateVerify, runBootApplyVerify, runBootApplyExtVerify, runNoIntelVerify, runOverlayVerify, runGraphicsVerify, runDisplayVerify } from './ui-verify.js';
import { collectHealth } from './health.js';
import { registerIpc } from './ipc.js';
import { seedWaiverState, probeWaiverState, seedOcMode, resolveBootDeviceId, clampOverlayScale } from './ipc-core.js';
import { ProfileStore, OVERLAY_POSITIONS, OVERLAY_STAT_IDS } from './store/profile-store.js';
import { createOverlayWindow } from './overlay.js';
import { createStartup, createMockStartup, resolveLogonExecPath } from './startup.js';
import { createDriverInfo, createMockDriverInfo } from './driver-info.js';
import { REGISTRY_CATALOG, createRegistryCatalog, createMockRegistryCatalog, createMockRegistryState } from './registry-catalog.js';
import { createRegistryApply, createMockRegistryApply } from './registry-apply.js';
import { createDxgiFpsAdapter } from './fps-dxgi.js';
import { createForegroundApiDetector } from './foreground-api.js';
import { createSysStats, createMockSysStats } from './sys-stats.js';
import { createMsrReader } from './msr-reader.js';
import { createMonitorLog } from './monitor-log.js';
import { collectSysinfo, createMockSysinfo, vramBytesOfDevice, applyDriverReBar } from './sysinfo.js';
import { applyProfile, runApplyOnStartup, applyProfileBoot, resolveApplyDeviceId } from './apply-on-boot.js';
import { runBootApplyMode } from './boot-apply-mode.js';
import { shouldUseInstanceLock, acquireInstanceLock, focusExistingWindow } from './single-instance.js';
import { createBootSetup, taskActionMatches } from './setup-boot.js';
import { deriveBuildKind } from './build-kind.js';
import { createTray, buildTrayMenuTemplate, trayToggleAction, TRAY_LABEL_TOGGLE, trayBalloonForOutcome } from './tray.js';
import { isElevated as isElevatedReal } from './elevation.js';
import { OldIgcl } from './old-igcl.js';
import { executeApply } from './apply-routing.js';
import { runApplyWorker } from './apply-worker.js';
import { createApplyRunner } from './elevated-apply.js';
import { createMockOldIgcl } from './backend/mock-backend.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const headless = process.argv.includes('--headless');
const uiVerify = process.argv.includes('--ui-verify');
// M4-E: the ArcPowerBootApply logon task's action (`"<exe>" --boot-apply`).
// No id argument - reads the ACTIVE profile from the store like the
// window-path boot apply; exits silently when the boot setting is off and
// NEVER lingers (no long-lived tray process). The task runs ELEVATED so the
// in-process apply persists.
const bootApply = process.argv.includes('--boot-apply');
// --ui-verify is dev tooling: it ALWAYS uses the mock backend (never touches
// hardware), so treat it as mock for backend selection.
const mock = process.argv.includes('--mock') || process.env.RID_BACKEND === 'mock' || uiVerify;
const applyProfileIdx = process.argv.indexOf('--apply-profile');
const applyProfileId = applyProfileIdx >= 0 ? process.argv[applyProfileIdx + 1] : null;
// M2C-C apply-worker mode: `--apply-worker <reqFile> <outFile>`.
const applyWorkerIdx = process.argv.indexOf('--apply-worker');
const workerReqFile = applyWorkerIdx >= 0 ? process.argv[applyWorkerIdx + 1] : null;
const workerOutFile = applyWorkerIdx >= 0 ? process.argv[applyWorkerIdx + 2] : null;

function createWindow(backgroundColor = '#0f1116', show = true) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    title: 'Arc Power',
    // 1.0.1 Themes (M3): the persisted theme's background (the caller
    // resolves it before createWindow; the Dark Steel default here).
    backgroundColor,
    // M4J (G): Start minimized -> the TRAY. The window is created HIDDEN
    // (show:false - tray-only, no taskbar entry, no minimize race) when
    // the pre-create settings read says startMinimized; ready-to-show does
    // nothing then. The tray toggle's hidden->show branch restores it.
    show,
    // M2C-B B6: the blue "AP" logo (generated by scripts/make-icon.js).
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    // M2b UX: no visible Electron menu bar (an Alt-key shortcut can reveal
    // it later if ever needed).
    autoHideMenuBar: true,
    // M4-D: the INTEGRATED title bar - the window is frameless and
    // the renderer draws the title bar (draggable region + brand + window
    // controls wired to window-minimize/maximize-toggle/close). Resizing
    // still works (resizable defaults true - Windows draws the edge resize
    // handles for frameless windows).
    frame: false,
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
  // M4-D: the pushed window:maximized-changed channel - the
  // title-bar max button follows the live maximize state (the renderer
  // subscribes via preload's onWindowMaximizedChanged).
  const sendMaximized = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximized-changed', { maximized: win.isMaximized() });
    }
  };
  win.on('maximize', sendMaximized);
  win.on('unmaximize', sendMaximized);
  // M4-D: push the INITIAL state once the renderer is up - the max
  // button must reflect a window that starts (or was restored to) the
  // maximized state even before any later maximize/unmaximize event.
  win.webContents.on('did-finish-load', sendMaximized);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  return win;
}

// --- system tray (normal app path only - never headless) -------------------
// The menu is rebuilt from the persisted active profile at boot; M2b-B can
// rebuild it when the profile changes. M4J (G/S2): setupTray runs BEFORE
// createWindow (it needs only the store + closures; getWindow: () => win
// resolves lazily) - a start-hidden (tray) session is never stranded without
// its tray. `createTrayImpl` is injectable: --ui-verify passes a COUNTING
// probe (the windowOps pattern - no real Tray mid-verify) that records the
// toggle handler so 'a tray click shows the hidden window' is assertable.
let trayRef = null;
async function setupTray({ getWindow, backend, store, oldIgcl, applyRunner, createTrayImpl = createTray }) {
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
        if (!win) return;
        // M4-D Round-1 F5 (tray restore): a MINIMIZED window reports
        // isVisible() === true - the old `if (win.isVisible()) hide()` would
        // hide a minimized window instead of restoring it (the user could
        // never restore a start-hidden (tray) session from the tray). The
        // isMinimized -> restore branch runs FIRST; only a visible,
        // non-minimized window toggles to hidden.
        const action = trayToggleAction({ isMinimized: win.isMinimized(), isVisible: win.isVisible() });
        if (action === 'restore') {
          win.restore();
          win.focus();
        } else if (action === 'hide') {
          win.hide();
        } else {
          win.show();
          win.focus();
        }
      },
      onApplyProfile: async () => {
        try {
          const settings = await store.loadSettings();
          const profiles = await store.loadProfiles();
          const profile = profiles.find((p) => p.id === settings.activeProfileId);
          // M3-C-D (double-dialog decision): the per-apply extended-range
          // confirm is DROPPED from the tray entirely - in Advanced mode the
          // mode-enable confirm already warned; in Stock mode the shared
          // oc-mode gate refuses extended values with a balloon (never a
          // dead-end confirm). applyProfile below owns that honesty.
          // Explicit user action: skips the ocOnBoot gate (like the
          // renderer's Load button) but keeps the waiver gates. The balloon
          // only claims "defaults restored" when a restore actually ran
          // (M2b review F1) - gate refusals (incl. the oc-mode refusal)
          // get a reason-specific message.
          // M4-F (S2): the tray apply targets the PERSISTED/SELECTED device
          // (resolved like every other apply - explicit id ?? persisted ?? devices[0]).
          const deviceId = await resolveApplyDeviceId(backend, store, null);
          const out = await applyProfile({ backend, store, profileId: settings.activeProfileId, deviceId, oldIgcl, applyRunner });
          if (!out.applied && trayRef && !trayRef.isDestroyed()) {
            let name = 'unknown';
            try {
              const ps = await store.loadProfiles();
              const p = ps.find((x) => x.id === settings.activeProfileId);
              if (p) name = p.name;
            } catch { /* best effort name */ }
            const content = trayBalloonForOutcome(out, name);
            if (content) trayRef.displayBalloon({ title: 'Arc Power', content });
          }
        } catch (err) {
          console.error(`[tray] apply active profile failed: ${err.message}`);
          if (trayRef && !trayRef.isDestroyed()) {
            trayRef.displayBalloon({ title: 'Arc Power', content: `Arc Power: profile apply failed - ${err.message}` });
          }
        }
      },
      onQuit: () => app.quit(),
    });
  };
  const tray = createTrayImpl({ tray: Tray, nativeImage, Menu, template: await menuTemplate() });
  trayRef = tray;
  // Rebuild the menu when the active profile changes (M2b-B calls this via
  // the window; for now the boot-time state is enough).
  tray.rebuildMenu = async () => { tray.setContextMenu(Menu.buildFromTemplate(await menuTemplate())); };
  return tray;
}

async function main() {
  // --- M2C-C apply-worker mode (`--apply-worker <req> <out>`): ------------
  // hidden (no window, no tray), never re-elevates, exits after writing the
  // result file. Runs the SAME routed instant-apply core as the UI path.
  if (workerReqFile) {
    if (!workerOutFile) {
      console.error('--apply-worker requires <reqFile> <outFile>');
      app.exit(1);
      return;
    }
    // M2C-C S1: the extended-capability probe is constructed BEFORE the
    // backend and injected - the worker's getCapabilities (its clamp ranges)
    // must report the same extended ranges the UI path does.
    // M3-C-E: the worker's backend is pinned to ADVANCED mode so its caps
    // report the extended ranges whenever the 2023 runtime is capable (the
    // M3-C step-5 F1 capability refusal keys on the SAME probe result -
    // when the runtime cannot load, the worker's caps report the standard
    // ranges and extended values refuse with EXTENDED_UNAVAILABLE_MSG). The
    // worker's MODE refusal gate keys on the request's ocMode (a stock-mode
    // clamp here would silently cap extended values in advanced sessions:
    // exactly the forbidden behavior).
    const workerOldIgcl = new OldIgcl();
    const code = await runApplyWorker({
      reqPath: workerReqFile,
      outPath: workerOutFile,
      backend: createBackend({
        kind: 'igcl',
        igcl: {
          extended: { isCapable: () => workerOldIgcl.isCapable() },
          ocMode: 'advanced',
        },
      }),
      oldIgcl: workerOldIgcl,
      log: (s) => console.log(`[apply-worker] ${s}`),
    });
    app.exit(code);
    return;
  }

  // --- M4-E --boot-apply mode (the ArcPowerBootApply logon task's action): --
  // no id arg - reads the ACTIVE profile from the store. ocOnBoot off / no
  // active profile -> exit 0 SILENTLY (no window, no tray - the task's logon
  // spawn is invisible when off). On -> the boot-gated IN-PROCESS apply
  // (applyProfileBoot: applyRunner-less, defaults-restore fallback skipped
  // regardless of errorCode - the task runs ELEVATED so the apply persists).
  // BOTH outcomes exit: success -> right after the apply; failure -> tray
  // balloon + ~10 s dwell so it is visible, then app.exit(0). An invisible
  // elevated process + tray icon must NEVER linger after a logon apply.
  if (bootApply) {
    await app.whenReady();
    const bootStore = new ProfileStore({
      dir: mock ? path.join(os.tmpdir(), 'arcpower-mock') : undefined,
      ocModeDefault: mock ? 'advanced' : 'stock',
    });
    const bootOldIgcl = mock ? null : new OldIgcl();
    const bootBackend = createBackend({
      kind: mock ? 'mock' : 'igcl',
      igcl: bootOldIgcl ? { extended: { isCapable: () => bootOldIgcl.isCapable() } } : {},
      mock: {},
    });
    // Mirror the window/apply-profile boot seeding (bootBackend): the
    // persisted waiver acceptance + OC mode must ride into the in-process
    // apply - the ELEVATED task's apply gates on them exactly like the
    // window path's (never calls the driver, never auto-accepts).
    try { await bootBackend.init(); } catch { /* health-level degrade */ }
    try { await seedWaiverState(bootBackend, bootStore); } catch (err) {
      console.log(`[boot-apply] waiver seeding skipped: ${err.message}`);
    }
    try {
      const s = await bootStore.loadSettings();
      if (typeof bootBackend.setOcMode === 'function') bootBackend.setOcMode(s.ocMode);
    } catch (err) {
      console.log(`[boot-apply] oc-mode seeding skipped: ${err.message}`);
    }
    // M4-F (S2): resolve the persisted/selected device the SAME way the
    // window path does (persisted ?? devices[0]) - the logon apply must
    // target the selected GPU, never silently devices[0] (the 2-GPU iGPU trap).
    let bootDeviceId = null;
    try {
      bootDeviceId = await resolveApplyDeviceId(bootBackend, bootStore, null);
    } catch (err) {
      console.log(`[boot-apply] deviceId resolution skipped: ${err.message}`);
    }
    try {
      const out = await runBootApplyMode({
        store: bootStore,
        apply: (profileId) => applyProfileBoot({
          backend: bootBackend,
          store: bootStore,
          profileId,
          deviceId: bootDeviceId,
          oldIgcl: mock ? createMockOldIgcl(bootBackend) : bootOldIgcl,
          log: (s) => console.log(`[boot-apply] ${s}`),
        }),
        setupTray: () => setupTray({
          getWindow: () => null,
          backend: bootBackend,
          store: bootStore,
          oldIgcl: mock ? createMockOldIgcl(bootBackend) : bootOldIgcl,
          applyRunner: null,
        }),
        log: (s) => console.log(`[boot-apply] ${s}`),
      });
      console.log(`[boot-apply] ${out.action}${out.reason ? ` - ${out.reason}` : ''} - exiting 0`);
    } catch (err) {
      console.log(`[boot-apply] mode failed (${err.message}) - exiting 0`);
    } finally {
      await bootBackend.close().catch(() => {});
    }
    app.exit(0);
    return;
  }

  if (headless) {
    // M2C-C S1: the smoke path is a real-backend path too - same probe wiring
    // as the app/worker so its caps match the product path. The bundled
    // 2023-runtime probe degrades safely here: a missing/unloadable DLL makes
    // OldIgcl.isCapable() return false (cached), so the smoke's caps stay in
    // the standard range and every health line still runs - the smoke never
    // fails on the probe alone.
    // M4J (A): the smoke wires the REAL VRAM enrichment too (one CIM query -
    // the same collectSysinfo the window path uses) so the dev/packaged
    // smoke proves the "8GB GDDR6" name suffix LIVE on the real machine.
    // A query failure degrades to the plain name (the smoke never fails on
    // sysinfo).
    const smokeOldIgcl = mock ? null : new OldIgcl();
    let smokeVramBytesOf;
    if (!mock) {
      try {
        const smokeCached = await collectSysinfo({ timeoutMs: 10000 });
        smokeVramBytesOf = (device) => vramBytesOfDevice(device, smokeCached);
      } catch {
        smokeVramBytesOf = undefined;
      }
    }
    const backend = createBackend({
      kind: mock ? 'mock' : 'igcl',
      igcl: {
        allowAutoWaiver: true, // smoke/tests only (plan §9 M1 waiver clause)
        extended: smokeOldIgcl ? { isCapable: () => smokeOldIgcl.isCapable() } : undefined,
        // M3-C-E: the smoke's no-op round trips must never clamp a device
        // that currently holds an extended value - expose the full range.
        ocMode: 'advanced',
        ...(smokeVramBytesOf ? { vramBytesOf: smokeVramBytesOf } : {}),
      },
      mock: {},
    });
    try {
      // M4-D2 (§13 smoke gate): unelevated smoke runs SKIP the no-op write
      // round trips (reported as "skipped (unelevated)") - the real A770
      // refuses/silently-lies unelevated, and the packaged gate must stay
      // exit 0. Mock smoke reports elevated (its round trips genuinely
      // pass) so the full sequence still runs in --headless --mock.
      const { lines } = await runSmoke(backend, {
        isElevated: mock ? () => true : isElevatedReal,
      });
      console.log('\nSMOKE OK - ' + lines.filter((l) => l.startsWith('[health]')).length + ' health line(s), see above for the full sequence.');
      app.exit(0);
    } catch (err) {
      console.error(`\nSMOKE FAILED: ${err.message}`);
      app.exit(1);
    }
    return;
  }

  await app.whenReady();

  // --- M4-F single-instance lock (UI WINDOW mode ONLY) ---------------------
  // Helpers (--headless / --ui-verify / --boot-apply / --apply-profile /
  // --apply-worker) + mock-UI skip the lock BY CONSTRUCTION
  // (shouldUseInstanceLock) - the gate decides per mode, so this block sits
  // EARLY (right after ready) and the second UI instance quits FAST instead
  // of booting the backend first (~20 s). --apply-worker is the hard case
  // (M2C-C S1): the elevated-apply worker is a SECOND instance spawned
  // WHILE the UI runs - if it failed the lock it would quit without writing
  // the out file and every elevated apply would hang. When the lock is NOT
  // acquired, another instance holds it: quit immediately (the holder's
  // second-instance event restores its window). The lock is userData-based:
  // portable + installed builds share %APPDATA%\ArcPower -> mutually
  // exclusive; the dev tree + the packaged app also share the userData
  // (expected - close one before launching the other).
  const instanceLockMode = { headless, uiVerify, bootApply, applyProfileId, workerReqFile, mock };
  let windowForInstance = null;
  if (shouldUseInstanceLock(instanceLockMode)) {
    const { acquired } = acquireInstanceLock({
      requestSingleInstanceLock: () => app.requestSingleInstanceLock(),
      mode: instanceLockMode,
    });
    if (!acquired) {
      console.log('[boot] another Arc Power instance is running - quitting');
      app.quit();
      return;
    }
    app.on('second-instance', () => {
      // Focus/restore the existing window (the tray-restore pattern: a
      // MINIMIZED window reports isVisible() === true - restore first).
      focusExistingWindow(windowForInstance);
    });
  }
  // --ui-verify runs against MockBackend; the env knobs act as OVERLAYS on
  // the featureset base (mock/featuresets/*.json, RID_MOCK_FEATURESET):
  //   - the a770 featureset base is the real card's TRUE editable fan fixture
  //     (canControl=true + modes ['auto','curve'] - M3-D live-verified probe
  //     path); RID_MOCK_FAN_READONLY=1 flips it to the read-only overlay (the
  //     card's modes are kept, only the control grant differs - a hasFan:false
  //     featureset always stays fan-less regardless of the overlay);
  //   - RID_MOCK_OFFGRID_FREQ_MHZ makes the mock report a freq offset off the
  //     1 MHz grid (verifies the off-grid driver readout);
  //   - RID_MOCK_EXTENDED_RANGES / RID_MOCK_EXTENDED_FAIL are session knobs
  //     on top of the featureset extendedRanges flag (a770 carries it
  //     natively).
  const mockOpts = {};
  if (uiVerify) {
    mockOpts.fanCanControl = process.env.RID_MOCK_FAN_READONLY !== '1';
  }
  // M8 (the Graphics tab): RID_MOCK_GRAPHICS_UNSUPPORTED=1 runs the mock in
  // the unsupported-graphics session - the WHOLE graphics surface degrades
  // to the supported-all-false state (the honest note on all four cards);
  // the ui-verify graphics block asserts the no-controls state under the
  // knob (the RID_MOCK_FAN_READONLY pattern).
  if (uiVerify && process.env.RID_MOCK_GRAPHICS_UNSUPPORTED === '1') {
    mockOpts.graphicsUnsupported = true;
  }
  if (uiVerify && process.env.RID_MOCK_OFFGRID_FREQ_MHZ !== undefined) {
    mockOpts.offGridFreqMhz = Number(process.env.RID_MOCK_OFFGRID_FREQ_MHZ);
  }
  if (uiVerify && process.env.RID_MOCK_EXTENDED_RANGES === '1') mockOpts.extendedRanges = true;
  if (uiVerify && process.env.RID_MOCK_EXTENDED_FAIL === '1') mockOpts.extendedFail = true;
  // M3-C-E: RID_MOCK_STOCK_MODE=1 flips the mock's OC mode to stock - the
  // ui-verify stock variant exercises the refusal path (extended values
  // refuse with the mode message; no confirm dialog anywhere). The mock
  // default is advanced (the extended-flow pins stay green).
  if (mock && process.env.RID_MOCK_STOCK_MODE === '1') mockOpts.ocMode = 'stock';
  // 1.0.1 no-Intel round: RID_MOCK_NO_INTEL=1 runs the mock in the no-Intel
  // session - listDevices enumerates nothing + health reports igclLoaded
  // false (the exact shape a real AMD machine reports after the init
  // degrade); the ui-verify no-intel variant pins the whole no-device flow.
  if (mock && process.env.RID_MOCK_NO_INTEL === '1') mockOpts.noIntel = true;
  // M2C-C S1: the real bundled-2023-runtime adapter is constructed BEFORE
  // the backend (mock mode leaves it null - the mock adapter wraps the
  // backend instead). The backend's extended probe consults it lazily
  // (isCapable runs on the first caps query).
  const realOldIgcl = mock ? null : new OldIgcl();
  // M4-D: the sysinfo cache (PowerShell CIM, ONE query per session - the
  // dashboard CPU card + the real-GPU VRAM suffix source). Run BEFORE the
  // backend so the VRAM lookup can enrich the device names at enumeration
  // time. Mock/ui-verify uses the fixed fixture (never spawns PowerShell).
  // M4-D review F3: the query timeout is SHORT (10 s) - a hung PowerShell
  // must not block the first window for a minute; the timeout degrades to
  // the honest os.cpus() fallback (cpu populated, RAM speed + video
  // controllers null/empty).
  let sysinfo;
  // M4J (A): the sysinfo CACHE is hoisted OUT of the else branch - the
  // backend's vramBytesOf provider below (outside the if/else) closes over
  // it. The pre-fix wiring passed the lazy ADAPTER (`sysinfo` - a .get()
  // with no .videoControllers), so the real-path VRAM lookup ALWAYS
  // returned null (the device never gained "8GB GDDR6").
  let cached = null;
  if (mock) {
    sysinfo = createMockSysinfo();
  } else if (applyProfileId) {
    // M4-D review F3 (logon latency): the --apply-profile flow is TRAY-ONLY -
    // the VRAM name suffix is never displayed there, so the PowerShell CIM
    // query (1-5 s typical, up to the 10 s timeout) would only delay the
    // apply. Skip it: vramBytesOfDevice(device, undefined) degrades to null
    // and formatDeviceName keeps the plain name. The window path still runs
    // the query - it enriches the real-GPU name and the CPU card.
    sysinfo = null;
  } else {
    // M4-D FIX (the CPU card was EMPTY in the product): the sysinfo:get
    // handler calls `sysinfo.get()` - the REAL path previously passed the raw
    // query RESULT here, so the handler threw and the renderer degraded to
    // null (empty card; the mock adapter masked it in tests/ui-verify). Wrap
    // the cached result in the SAME adapter shape the mock uses.
    // M4-D2 (ReBAR): the driver's BAR state (ctlPciGetProperties -
    // resizable_bar_enabled) is the PRIMARY ReBAR source - the same driver
    // state IGS + GPU-Z report (live-verified: this A770's driver reports
    // resizable_bar_enabled=1 while the OS resource map shows no large BAR
    // window on this Z97 platform). The OS-resource check stays as the
    // fallback when the driver cannot report (unbound symbol / ctl error).
    // The driver query runs ONCE, LAZILY at the first sysinfo:get (the
    // renderer asks after boot - the backend exists by then; no boot
    // latency added).
    const cachedResult = await collectSysinfo({ timeoutMs: 10000 });
    cached = cachedResult;
    let driverBarCached = null;
    let driverBarDone = false;
    const driverReBar = async () => {
      if (driverBarDone) return driverBarCached;
      driverBarDone = true;
      try {
        const devices = await backend.listDevices();
        if (devices.length === 0) return (driverBarCached = null);
        const p = await backend.pciProperties(devices[0].id);
        driverBarCached = p ? (p.resizableBarEnabled ? true : false) : null;
      } catch {
        driverBarCached = null;
      }
      return driverBarCached;
    };
    sysinfo = {
      get: async () => {
        const verdict = await driverReBar();
        return verdict === null ? cachedResult : applyDriverReBar(cachedResult, verdict);
      },
    };
  }
  const backend = createBackend({
    kind: mock ? 'mock' : 'igcl',
    igcl: realOldIgcl
      ? {
          extended: { isCapable: () => realOldIgcl.isCapable() },
          // M4J (A): pass the CACHED CIM data (with .videoControllers) - the
          // pre-fix adapter passed `sysinfo` (the lazy .get() wrapper), so
          // the lookup ALWAYS returned null on the real path and the A770
          // never gained its "8GB GDDR6" suffix.
          vramBytesOf: (device) => vramBytesOfDevice(device, cached),
        }
      : {},
    mock: mockOpts,
  });
  // M2C-C: the bundled 2023 IGCL runtime adapter (extended-range writes).
  // Mock mode (incl. --ui-verify) uses the mock adapter - the real DLL is
  // never loaded there. In the real path the OLD runtime is probed lazily
  // (isCapable runs on the first extended write or caps query) and both
  // runtimes can coexist in one process (probe-verified, §8c). S1: the real
  // adapter is constructed BEFORE the backend so the backend's extended
  // probe (above) can consult it - the extended ranges are wired into
  // getCapabilities on hardware, never dead code.
  const oldIgcl = mock ? createMockOldIgcl(backend) : realOldIgcl;
  // M2C-C elevation probe: real detection in the product path; ui-verify
  // knobs let the mock report elevated (RID_MOCK_ELEVATED=1) so the
  // elevated-in-app UI state is verifiable without elevation. Declared HERE
  // (before the applyRunner block below) - the runner's deps evaluate this
  // identifier eagerly, so any later declaration would be a TDZ crash on the
  // real product path (step-5 S1).
  const isElevated = mock
    ? () => process.env.RID_MOCK_ELEVATED === '1'
    : isElevatedReal;
  // M2C-C: the elevation-aware apply runner. The product path (non-mock)
  // delegates applies to the elevated self-worker when not elevated; mock
  // mode applies in-process (applyRunner null) - ui-verify's worker-apply
  // toast variant injects a FAKE runner (never spawns anything).
  let applyRunner = null;
  if (!mock) {
    applyRunner = createApplyRunner({
      isElevated,
      execPath: process.execPath,
      // Dev mode (`electron .`): process.execPath is electron.exe - the
      // worker spawn must pass the app path along. Packaged EXEs ignore it.
      appPath: process.defaultApp ? app.getAppPath() : null,
      inProcess: {
        // M4O: forward the profileApply flag into executeApply's opts - the
        // clamp then uses the driver's TRUE limits (extendedRangesFor) and
        // the safety-net capability refusal keys on the runtime probe.
        apply: async ({ deviceId, settings, profileApply }) => executeApply({ backend, oldIgcl, deviceId, settings, opts: { profileApply } }),
        waiverAccept: async (deviceId) => { await backend.setWaiverAccepted(deviceId); },
        reset: async (deviceId) => {
          await backend.resetToDefaults(deviceId);
          const state = await backend.getCurrentSettings(deviceId);
          return { state };
        },
        // M8 (the Graphics tab): the in-process graphics executor - the
        // DEDICATED apply path (no OC waiver, no OC-mode gate). Returns the
        // { ok, perControl, graphicsState } envelope with the FRESH read-back.
        graphicsApply: async ({ deviceId, settings }) => {
          const out = await backend.setGraphicsSettings(deviceId, settings);
          let graphicsState = null;
          try { graphicsState = await backend.getGraphicsSettings(deviceId); } catch { /* degraded */ }
          return { ok: out.ok, perControl: out.perControl, graphicsState };
        },
        // M10b (the Graphics "Display" view): the in-process display
        // executor - the DEDICATED apply path (no OC waiver, no OC-mode
        // gate). Returns the { ok, perControl, displayState } envelope with
        // the FRESH read-back.
        displayApply: async ({ deviceId, displayId, settings }) => {
          const out = await backend.setDisplaySettings(deviceId, displayId, settings);
          let displayState = null;
          try { displayState = await backend.getDisplaySettings(deviceId); } catch { /* degraded */ }
          return { ok: out.ok, perControl: out.perControl, displayState };
        },
      },
      log: (s) => console.log(s),
    });
  } else if (uiVerify && process.env.RID_MOCK_WORKER_APPLY === '1') {
    // Dev-only: report the worker-apply path (elevation toast UX) while
    // still applying in-process - never spawns a worker in mock mode.
    // M4O: forward the profileApply flag like the real runner - a
    // RID_MOCK_WORKER_APPLY + stock combo must behave like the real worker
    // (which is pinned advanced).
    applyRunner = {
      needsWorker: () => true,
      apply: async ({ deviceId, settings, profileApply }) => executeApply({ backend, oldIgcl, deviceId, settings, opts: { profileApply } }),
      waiverAccept: async (deviceId) => { await backend.setWaiverAccepted(deviceId); },
      reset: async (deviceId) => {
        await backend.resetToDefaults(deviceId);
        return { ok: true, state: await backend.getCurrentSettings(deviceId) };
      },
      // M8: the fake runner's graphics path (in-process - never spawns).
      graphicsApply: async ({ deviceId, settings }) => {
        const out = await backend.setGraphicsSettings(deviceId, settings);
        let graphicsState = null;
        try { graphicsState = await backend.getGraphicsSettings(deviceId); } catch { /* degraded */ }
        return { ok: out.ok, perControl: out.perControl, graphicsState };
      },
      // M10b: the fake runner's display path (in-process - never spawns).
      displayApply: async ({ deviceId, displayId, settings }) => {
        const out = await backend.setDisplaySettings(deviceId, displayId, settings);
        let displayState = null;
        try { displayState = await backend.getDisplaySettings(deviceId); } catch { /* degraded */ }
        return { ok: out.ok, perControl: out.perControl, displayState };
      },
    };
  }
  // M3-C-E: the store's OC-mode default - real product stock; mock/ui-verify
  // advanced (extended-flow pins stay green), except RID_MOCK_STOCK_MODE=1
  // which flips the whole mock session to stock (the refusal-path variant).
  // M3-C review F4: mock/ui-verify sessions NEVER touch the real
  // %APPDATA%\ArcPower\settings.json - they read/write an ISOLATED temp
  // data dir (%TEMP%\arcpower-mock). A default mock run used to silently
  // flip the real product's persisted mode to advanced (and a stock variant
  // made the next real launch refuse a saved 300 W profile); with the
  // isolated dir the real settings.json stays untouched forever. Variant-to-
  // variant isolation is kept by the explicit session seed below (each mock
  // session seeds its own mode into the isolated store before anything
  // reads it).
  const mockDataDir = mock ? path.join(os.tmpdir(), 'arcpower-mock') : null;
  const store = new ProfileStore({
    dir: mockDataDir ?? undefined,
    ocModeDefault: mock ? (process.env.RID_MOCK_STOCK_MODE === '1' ? 'stock' : 'advanced') : 'stock',
  });
  // Mock/ui-verify sessions seed the session mode into the ISOLATED store
  // (never the real settings.json - F4 above). The real product path never
  // writes at boot.
  if (mock) {
    try {
      const cur = await store.loadSettings();
      await store.saveSettings({ ...cur, ocMode: process.env.RID_MOCK_STOCK_MODE === '1' ? 'stock' : 'advanced' });
    } catch (err) {
      console.log(`[boot] oc-mode session seed skipped: ${err.message}`);
    }
    // 1.0.1 Themes (M2): every mock session seeds theme 'dark' like the
    // ocMode/waiver seeds - a leaked light/midnight theme from an
    // interrupted run must never bleed into the next variant (the isolated
    // mock dir is shared across variants). RID_MOCK_THEME=light flips the
    // session (the light-boot sanity pin).
    try {
      const cur = await store.loadSettings();
      await store.saveSettings({ ...cur, theme: process.env.RID_MOCK_THEME === 'light' ? 'light' : 'dark' });
    } catch (err) {
      console.log(`[boot] theme session seed skipped: ${err.message}`);
    }
    // M4J (G): RID_MOCK_START_MINIMIZED=1 seeds startMinimized:true into
    // the isolated mock store - the pre-create read then creates the window
    // HIDDEN (tray-only) and the ui-verify tray-start probe drives the
    // block (a tray click shows it). Seeded DETERMINISTICALLY like the
    // ocMode/theme/waiver seeds: a leaked 'true' from a previous
    // start-minimized run must never bleed into the next variant (the
    // shared isolated mock dir).
    try {
      const cur = await store.loadSettings();
      await store.saveSettings({ ...cur, startMinimized: process.env.RID_MOCK_START_MINIMIZED === '1' });
    } catch (err) {
      console.log(`[boot] start-minimized session seed skipped: ${err.message}`);
    }
    // M5: RID_MOCK_OVERLAY=1 seeds overlayEnabled:true into the isolated
    // mock store - the overlay variant boots with the overlay SHOWN (the
    // same deterministic session-seed pattern; a leaked 'false' from an
    // interrupted run must never hide the overlay for the next variant).
    // The OTHER overlay fields reset to their defaults under the knob too -
    // a crashed run that left letter 'P' / bottom-right / scale 2 must
    // never bleed into the next overlay run (the variant's pins are
    // deterministic).
    // M6: the color + the stats reset the same way (the new pins change
    // them mid-run - a crashed run must never bleed a non-white color or a
    // trimmed stat set into the next overlay variant).
    // M7b: the background box resets the same way (the new pins toggle it
    // mid-run - a crashed run must never bleed a visible box / non-black
    // color / non-0.5 opacity into the next overlay variant).
    try {
      const cur = await store.loadSettings();
      const overlayOn = process.env.RID_MOCK_OVERLAY === '1';
      await store.saveSettings({
        ...cur,
        overlayEnabled: overlayOn,
        overlayHotkeyLetter: overlayOn ? 'O' : cur.overlayHotkeyLetter,
        overlayPosition: overlayOn ? 'top-left' : cur.overlayPosition,
        overlayScale: overlayOn ? 1 : cur.overlayScale,
        overlayColor: overlayOn ? '#ffffff' : cur.overlayColor,
        overlayStats: overlayOn ? OVERLAY_STAT_IDS : cur.overlayStats,
        overlayBgEnabled: overlayOn ? false : cur.overlayBgEnabled,
        overlayBgColor: overlayOn ? '#000000' : cur.overlayBgColor,
        overlayBgOpacity: overlayOn ? 0.5 : cur.overlayBgOpacity,
      });
    } catch (err) {
      console.log(`[boot] overlay session seed skipped: ${err.message}`);
    }
    // M4-A/M4-B: deterministic waiver session seed - every mock session    // boots UNACCEPTED so the boot waiver prompt shows in the classic
    // Cancel/Accept state (ui-verify F4: the prompt would otherwise hit
    // every variant unpredictably, and a previous run's persisted
    // acceptance would change its state). The RID_MOCK_WAIVER_PERSISTED=1
    // ui-verify variant seeds an ACCEPTED store instead - M4-D (PERMANENT
    // acceptance: "skipped IF permanently accepted after accepting
    // once"): the accepted store means the boot prompt is SKIPPED entirely
    // (the accepted-state reminder dialog is REMOVED - the dashboard health
    // row remains the status display), and an apply-time waiver-not-set is
    // silently re-set + retried in main.
    try {
      const cur = await store.loadSettings();
      await store.saveSettings({ ...cur, waiverAccepted: process.env.RID_MOCK_WAIVER_PERSISTED === '1' });
    } catch (err) {
      console.log(`[boot] waiver session seed skipped: ${err.message}`);
    }
    // M4M (F6): the deterministic boot-apply session seed - every mock
    // session writes ocOnBoot: RID_MOCK_BOOT_APPLY === '1' + activeProfileId
    // (the variant's probe profile id, else null) into the ISOLATED store,
    // so a failed/crashed run that leaked ocOnBoot=true can never make the
    // NEXT variant boot an automatic apply (the M4-F device-0 baseline pin
    // requires the clean state). Runs AFTER the waiver seed (which writes
    // false for this variant and would clobber it) and BEFORE
    // seedWaiverState (the device-side in-memory flag lands too -
    // applyProfileBoot refuses on a false store flag). The variant ALSO
    // seeds waiverAccepted: true + the probe profile itself.
    // M4O: the seed keys on RID_MOCK_BOOT_APPLY_EXT too (NEVER combined -
    // it branches the PROFILE seed, not piggybacks) - the EXT variant seeds
    // the SAME probe profile id with the EXTENDED 315 W values so the
    // window-path boot apply exercises the profileApply path against a
    // stock-mode session (the report shape).
    try {
      const cur = await store.loadSettings();
      const bootApplyOn = process.env.RID_MOCK_BOOT_APPLY === '1';
      const bootApplyExtOn = process.env.RID_MOCK_BOOT_APPLY_EXT === '1';
      const seedOn = bootApplyOn || bootApplyExtOn;
      await store.saveSettings({
        ...cur,
        ocOnBoot: seedOn,
        activeProfileId: seedOn ? 'boot-apply-probe' : null,
        waiverAccepted: seedOn ? true : cur.waiverAccepted,
      });
      if (seedOn) {
        await store.saveProfile({
          id: 'boot-apply-probe',
          name: 'Boot Apply Probe',
          settings: bootApplyExtOn
            ? {
                // M4O: the EXT variant's profile carries ADVANCED values
                // (315 W - beyond the stock ceiling); the plain BOOT
                // variant keeps the in-range 230 W seed.
                powerLimitW: 315,
                gpuFreqOffsetMhz: 100,
                tempLimitC: 90,
                gpuVoltOffsetV: 0.05,
                fanMode: 'auto',
              }
            : {
                powerLimitW: 230,
                gpuFreqOffsetMhz: 100,
                tempLimitC: 90,
                gpuVoltOffsetV: 0.05,
                fanMode: 'auto',
              },
          ocOnBoot: false,
        });
      }
    } catch (err) {
      console.log(`[boot] boot-apply session seed skipped: ${err.message}`);
    }
    // M4-B (fix)/M4-D: RID_MOCK_WAIVER_LOST=1 reproduces the
    // report - the store says the waiver is ACCEPTED (persisted) but the
    // DRIVER lost it. The boot probe (probeWaiverState) writes the current
    // power limit (value-neutral) and surfaces the waiver-not-set. M4-D
    // (PERMANENT acceptance): with the persisted acceptance true the probe
    // now RESTORES the driver waiver (setWaiverAccepted) - the consent
    // stands, the store is never flipped to false, and the boot prompt
    // stays SKIPPED like the plain persisted variant (ui-verify:
    // RID_MOCK_WAIVER_PERSISTED=1 + RID_MOCK_WAIVER_LOST=1 asserts NO boot
    // dialog + waiver-get accepted).
    if (process.env.RID_MOCK_WAIVER_LOST === '1') {
      try {
        backend.injectFail('powerLimitW', 'waiver-not-set', true);
        await probeWaiverState(backend, store);
      } catch (err) {
        console.log(`[boot] waiver probe skipped: ${err.message}`);
      }
    }
    // M4-B: deterministic Advanced-mode-warning session seed - every
    // mock session boots with the warning UNACCEPTED so the first
    // Stock->Advanced toggle shows the disclaimer (the shared isolated mock
    // dir would otherwise leak a previous run's acceptance). The
    // RID_MOCK_ADVANCED_ACCEPTED=1 ui-verify variant seeds an ACCEPTED
    // store instead - its step asserts the toggle then shows NO dialog
    // ("once accepted, saved, next boot doesn't need this accept").
    try {
      const cur = await store.loadSettings();
      await store.saveSettings({ ...cur, advancedModeAccepted: process.env.RID_MOCK_ADVANCED_ACCEPTED === '1' });
    } catch (err) {
      console.log(`[boot] advanced-mode session seed skipped: ${err.message}`);
    }
    // M4-A review F2: seed the backend's IN-MEMORY waiver flag HERE, before
    // createWindow - the renderer's FIRST getCapabilities (right after the
    // window loads) must already see the seeded flag. A post-window seed
    // races the renderer boot: the persisted variant would show the boot
    // prompt despite the accepted store. Same pattern as seedOcMode above
    // (seedWaiverState only touches the in-memory flag - safe pre-init in
    // mock mode; listDevices is fixture-backed).
    try {
      await seedWaiverState(backend, store);
    } catch (err) {
      console.log(`[boot] waiver flag pre-seed skipped: ${err.message}`);
    }
  } else {
    // M4-A review F1 (M4-B/M4-D update): the REAL path must pre-seed the
    // waiver flag BEFORE createWindow too - the renderer's FIRST
    // getCapabilities (right after the window loads) must already see a
    // persisted acceptance, or the M4-D boot decision renders wrong: the
    // accepted store must SKIP the boot prompt entirely (permanent
    // acceptance), and an unaccepted store must show the classic dialog.
    // backend.init() is idempotent and
    // bootBackend re-runs it below; an init failure here degrades into the
    // health system (collectHealth reports the init error and the window
    // stays up degraded).
    try {
      await backend.init();
    } catch {
      // health() reports the init error; the window stays up degraded.
    }
    try {
      await seedWaiverState(backend, store);
    } catch (err) {
      console.log(`[boot] waiver flag pre-seed skipped: ${err.message}`);
    }
    // M4-B (fix): boot-time driver-truth probe - the persisted
    // acceptance can be STALE (the driver lost the waiver while settings.json
    // still says accepted - the report: "the popup said already
    // accepted, then voltage changes threw a no-accepted-waiver error").
    // Only when ELEVATED (the packaged EXE always is): a value-neutral write
    // of the current power limit surfaces waiver-not-set when the driver
    // lost it; probeWaiverState then clears the stale flag + store so the
    // boot prompt shows the REAL state and applies work first-try. Never in
    // non-elevated dev (a probe write there would raise a UAC prompt).
    if (isElevated()) {
      try {
        await probeWaiverState(backend, store);
      } catch (err) {
        console.log(`[boot] waiver truth probe skipped: ${err.message}`);
      }
    }
  }
  // M3-C review F3: seed the persisted OC mode into the backend BEFORE the
  // window and the IPC surface exist - the renderer's FIRST getCapabilities
  // must already expose the right range set (a persisted-advanced session
  // must never render 252 W / 90 C sliders until a later self-heal). For
  // mock/ui-verify this reads the ISOLATED store (the variant's mode seeded
  // above), so the backend gets the same mode the variant expects. setOcMode
  // is an in-memory caps-cache invalidation - safe before backend.init().
  const seededMode = await seedOcMode(backend, store);
  if (seededMode) console.log(`[boot] oc-mode pre-seed: ${seededMode}`);
  // Run-key adapter: the real one writes HKCU only on an explicit user click
  // (startup-set IPC); mock mode (incl. --ui-verify) never touches the
  // registry.
  const startup = mock
    ? createMockStartup()
    : createStartup({ logonExecPath: await resolveLogonExecPath({ execPath: process.execPath, isPackaged: app.isPackaged }) });
  // Driver-date adapter: real reg.exe query in the product path; mock mode
  // (incl. --ui-verify) returns the fixture date and never spawns reg.exe.
  const driverInfo = mock ? createMockDriverInfo() : createDriverInfo();
  // M3-A/M3-B registry-catalog + registry-apply adapters (Tweaks page):
  // real read-only reg.exe queries + elevated reg.exe writes in the product
  // path; mock mode (incl. --ui-verify) returns the fixture states and the
  // mock apply flips the SAME in-memory state (never spawns, never
  // elevates). The two mock adapters share one mock registry state so the
  // post-apply state refresh honestly reflects the "written" values.
  const mockRegistryState = mock ? createMockRegistryState() : null;
  const registryCatalog = mock ? createMockRegistryCatalog(REGISTRY_CATALOG, { state: mockRegistryState }) : createRegistryCatalog();
  // ui-verify knobs: RID_MOCK_REGAPPLY_FAIL='<entryId>:<action>' simulates a
  // mid-way reg failure (clamped to the action's last step, so single-step
  // actions still exercise a step-1 failure); RID_MOCK_REGAPPLY_CANCEL=1
  // simulates a UAC decline for the mpo entry; RID_MOCK_REGAPPLY_DELAY_MS
  // adds simulated elevation latency so the in-flight disabled button state
  // can be asserted - all exercise the honest partial/cancel/in-flight UI
  // paths.
  const regApplyFail = process.env.RID_MOCK_REGAPPLY_FAIL;
  const regApplyDelay = Number(process.env.RID_MOCK_REGAPPLY_DELAY_MS);
  const registryApply = mock
    ? createMockRegistryApply(REGISTRY_CATALOG, {
        state: mockRegistryState,
        failAt: regApplyFail
          ? (() => {
              const [entryId, action] = regApplyFail.split(':');
              return { entryId, action, step: 1 };
            })()
          : null,
        canceledActions: process.env.RID_MOCK_REGAPPLY_CANCEL === '1' ? new Set(['mpo']) : new Set(),
        delayMs: regApplyDelay > 0 ? regApplyDelay : 0,
      })
    : // M3-C-B: the real adapter is elevation-aware - an elevated process
      // (the packaged EXE always is) runs reg.exe directly with per-step
      // honest reporting; non-elevated dev keeps the PowerShell RunAs chain.
      // M4-B: the CATALOG is the first argument (a deps-only call used to
      // land the deps in `catalog` -> "catalog.find is not a function").
      createRegistryApply(REGISTRY_CATALOG, { isElevated });
  // FPS adapter (M4-D2): DXGI GetFrameStatistics - unelevated, system-wide,
  // no service. Mock mode reports unavailable (never loads dxgi.dll/koffi),
  // counts polls so --ui-verify can assert the Monitoring page stops
  // polling on navigation away (M2b review F4), and returns a FIXED sample
  // ONLY under RID_MOCK_FPS=1 (the new pin). M7a: the fixed sample carries
  // the percentile stats (52 / 58 - the ui-verify FPS-row pins).
  // M10a: RID_MOCK_API=1 rides the SAME inline sample (api 'dx12' - the
  // fixture) - the knobs travel together (RID_MOCK_API without
  // RID_MOCK_FPS=1 produces nothing, because the poll returns null).
  let fpsPolls = 0;
  const fpsAdapter = mock
    ? {
        poll: async () => {
          fpsPolls += 1;
          if (process.env.RID_MOCK_FPS === '1') {
            const sample = { fps: 60, frameTimeMs: 16.7, gpuBusy: 0.6, low1Pct: 52, p99: 58 };
            if (process.env.RID_MOCK_API === '1') sample.api = 'dx12';
            return sample;
          }
          return null;
        },
      }
    : createDxgiFpsAdapter();
  // M10a: the foreground-window Graphics-API detector. THE DETERMINISM
  // SEAM (plan-review M-3): the REAL koffi detector runs ONLY in the
  // non-mock path - mock/ui-verify mode leaves the null-returning DEFAULT
  // in place, because the verify machine's own Electron/Chromium
  // foreground process would honestly report 'dx11' and break the
  // none-case pins nondeterministically.
  const foregroundApi = mock ? undefined : createForegroundApiDetector();
  // M4-D2: the system-stats adapter (CPU util/freq/temp + GPU memory used).
  // Mock: fixed deterministic values. Real: the rolling-delta CIM adapter;
  // its GPU-memory match needs the backend device's LUID - the IGCL
  // bindings expose none, so the DXGI display-enumeration link resolves it
  // (GetDesc1: DeviceId -> LUID), matched against the sysinfo video
  // controllers' PCI device id (DEV_56A0 on the A770). Unmatched -> null
  // (honest '-').
  let sysStats;
  let msrReader = null;
  if (mock) {
    sysStats = createMockSysStats();
  } else {
    let deviceIdHex = null;
    try {
      const cached = await sysinfo?.get?.();
      const row = Array.isArray(cached?.videoControllers)
        ? cached.videoControllers.find((c) => c?.pnpDeviceId)
        : null;
      const m = typeof row?.pnpDeviceId === 'string' ? row.pnpDeviceId.match(/DEV_([0-9A-Fa-f]{4})/) : null;
      if (m) deviceIdHex = `0x${m[1].toLowerCase()}`;
    } catch {
      deviceIdHex = null;
    }
    // M4L (B): the PawnIO MSR reader (CPU temp + wattage - the HWiNFO-class
    // route). Lazy open + module load once per session (the reader's
    // contract); every read returns null on any error (device absent,
    // install failed, AV quarantine) - the honest degrade. The install
    // state is checked by the reader at the first sample (the bundled
    // official setup runs silently once when the device is absent).
    msrReader = createMsrReader({});
    sysStats = createSysStats({
      deviceIdHex,
      luidOf: async (devId) => fpsAdapter.adapterLuidOf?.(devId) ?? null,
      msrReader,
      // M4L (B4): the once-per-session honest degrade note (the pawnio.eu
      // download link included) - logged when the MSR path is unavailable.
      onMsrDegrade: (text) => {
        console.log(`[sys-stats] ${text}`);
      },
    });
  }
  // M4-D2: the Monitoring log-to-file writer. RID_MOCK_LOG_DIR redirects
  // the directory (ui-verify); the default is <Documents>\Arc Power.
  const monitorLog = createMonitorLog({
    getDocumentsDir: () => app.getPath('documents'),
  });

  let teardown = null;
  // M4-D: close-to-tray - the tray's Quit (app.quit) must NOT be
  // swallowed by the window close interception (the close event fires
  // during a quit too; the flag lets it through).
  let isQuitting = false;
  app.on('before-quit', () => {
    isQuitting = true;
    void teardown?.().catch(() => {});
    void backend.close().catch(() => {});
    void oldIgcl?.close?.().catch(() => {});
    // M4L (N2): release the PawnIO device handle (msr-reader close hygiene).
    try { msrReader?.close?.(); } catch { /* best effort */ }
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
    // M3-C-E: seed the backend's OC mode from the persisted settings so
    // getCapabilities exposes the right range set from the first query (a
    // persisted 'advanced' must not wait for the next manual toggle).
    try {
      const s = await store.loadSettings();
      if (typeof backend.setOcMode === 'function') backend.setOcMode(s.ocMode);
    } catch (err) {
      console.log(`[boot] oc-mode seeding skipped: ${err.message}`);
    }
  };

  // --- apply-on-startup (`--apply-profile <id>`): no window, tray only ----
  if (applyProfileId && !uiVerify) {
    await bootBackend();
    // M2b review F2: the flow creates exactly ONE tray (it keeps the app
    // alive in this tray-only mode) and reuses it for the failure balloon.
    // M2C-C: the boot task runs with /rl highest (elevated) so applies are
    // in-process here (applyRunner stays null - a manual non-elevated run
    // fails honestly per control instead of prompting).
    const bootOldIgcl = mock ? createMockOldIgcl(backend) : new OldIgcl();
    // M4-F (S2): the logon apply targets the persisted/selected device -
    // never silently devices[0] (the 2-GPU iGPU trap).
    let applyDeviceId = null;
    try {
      applyDeviceId = await resolveApplyDeviceId(backend, store, null);
    } catch (err) {
      console.log(`[apply-profile] deviceId resolution skipped: ${err.message}`);
    }
    await runApplyOnStartup({
      backend,
      store,
      profileId: applyProfileId,
      deviceId: applyDeviceId,
      oldIgcl: bootOldIgcl,
      setupTray: () => setupTray({ getWindow: () => null, backend, store, oldIgcl: bootOldIgcl, applyRunner: null }),
      log: (s) => console.log(s),
    });
    return;
  }

  // M4-E (setup gate - UI window path ONLY): placed IMMEDIATELY before
  // createWindow and AFTER the --apply-profile early return above - the gate
  // feeds ONLY the window-path boot-apply decision at the bottom, so it must
  // NEVER run on the --apply-profile path (the tray-only, latency-optimized
  // logon apply: no gate queries, no UAC prompt) nor in --headless /
  // --boot-apply / --ui-verify (all return earlier); the dev tree and the
  // PORTABLE build never run it either (installedBuild - that env var is set
  // ONLY by the portable wrapper). Gate GREEN = the ArcPowerBootApply task
  // exists AND its action's exe path equals the CURRENT installed exe AND
  // the task is enabled (unelevated reads; a reinstall to a different dir
  // must never leave a dead-action task silently - the stale-action hole; a
  // DISABLED task reads NOT green so the elevated setup re-runs with /f and
  // self-heals). Gate NOT green -> the elevated setup spawns ONCE per launch
  // (create/overwrite with /f; a declined UAC is non-fatal - the gate
  // re-triggers next launch) and the window-path boot apply below STAYS
  // (never a silent-dead logon apply on installed builds until the setup
  // lands). The schtasks reads are unelevated + quick; a check failure
  // degrades to "gate unknown" (the in-app apply stays - the safe side).
  // The check is started WITHOUT awaiting (a hung schtasks must never stall
  // the first window). M4M (F): the verdict is INFORMATIONAL ONLY - the
  // in-app boot apply ALWAYS runs on the window path (the old gate-green
  // skip is REMOVED: the logon task still owns LOGON applies, and a logon
  // double-apply with the Run-launched app is idempotent).
  const installedBuild = app.isPackaged && !process.env.PORTABLE_EXECUTABLE_DIR;
  let bootGate = null; // { green: boolean } | null - null = not applicable/unknown
  let bootGateCheck = null; // the in-flight check promise (informational since M4M)
  if (installedBuild && !mock) {
    const bootSetup = createBootSetup();
    // NOT awaited: the first window must never wait on schtasks (two
    // queries, 10 s timeout each). The promise never rejects - the catch
    // degrades to null ("gate unknown" -> the in-app apply stays).
    bootGateCheck = bootSetup.check()
      .then((task) => {
        bootGate = { green: taskActionMatches(task, process.execPath) };
        console.log(`[boot] setup gate: ${bootGate.green ? 'GREEN' : 'NOT GREEN'} (task ${task.exists ? 'exists' : 'missing'}, action exe ${task.command ? `'${task.command}'` : 'unknown'})`);
        if (!bootGate.green) {
          // Fire-and-forget: the UAC prompt must not block the window boot.
          // createBootSetup latches - exactly ONE elevated spawn per launch.
          bootSetup.setup({ execPath: process.execPath })
            .then((r) => {
              if (r.ok) console.log('[boot] elevated setup OK - ArcPowerBootApply task created/overwritten');
              else if (r.alreadyStarted) console.log('[boot] elevated setup already started this launch');
              else console.log('[boot] elevated setup declined or failed - the gate re-triggers next launch');
            })
            .catch((err) => console.log(`[boot] elevated setup spawn failed: ${err.message}`));
        }
        return bootGate;
      })
      .catch((err) => {
        console.log(`[boot] setup gate check failed: ${err.message}`);
        bootGate = null; // unknown -> keep the in-app apply (never a silent-dead logon apply)
        return null;
      });
  }

  // 1.0.1 Themes (M3): the BrowserWindow backgroundColor follows the
  // persisted theme - a light theme with a dark flash at open would look
  // broken (and the seed/probe sequence above already has the settings in
  // hand on the mock path; the real path reads its own settings.json).
  // Best effort - a read failure keeps the Dark Steel default.
  // M4J (G): the SAME pre-create read decides the Start-minimized behavior -
  // the window is created HIDDEN (show:false, tray-only) when the persisted
  // setting is on; ready-to-show does nothing (never a visible-then-hidden
  // window, never a minimize race). RID_MOCK_START_MINIMIZED=1 lets the
  // --ui-verify tray-start probe drive the block (the seed above wrote
  // startMinimized:true into the isolated mock store).
  let windowBackground = '#0f1116';
  let startMinimizedAtBoot = false;
  try {
    const bootSettings = await store.loadSettings();
    windowBackground = bootSettings.theme === 'light' ? '#f2f4f8' : bootSettings.theme === 'midnight' ? '#0b1020' : '#0f1116';
    startMinimizedAtBoot = bootSettings.startMinimized === true;
  } catch {
    // keep the Dark Steel default - never block the window on a settings read
  }
  // M4J (G/S2): the ui-verify TRAY probe (the windowOps pattern) - counts
  // the menu builds + records the Show/Hide toggle handler so the verify
  // can assert 'a tray click shows the hidden window' without a real Tray
  // (creating one mid-verify would disrupt the assertions).
  const trayProbe = {
    builds: 0,
    toggleHandler: null,
    probe: {
      setContextMenu: () => {},
      setToolTip: () => {},
      displayBalloon: () => {},
      isDestroyed: () => false,
    },
  };
  const createTrayProbe = ({ template }) => {
    trayProbe.builds += 1;
    const toggle = template.find((i) => i.label === TRAY_LABEL_TOGGLE);
    trayProbe.toggleHandler = toggle && typeof toggle.click === 'function' ? toggle.click : null;
    return trayProbe.probe;
  };
  // M4J (G/S2): setupTray runs BEFORE createWindow - the tray exists from
  // the FIRST moment (a start-hidden (tray) session is never stranded without
  // it); getWindow: () => win resolves lazily. --ui-verify injects the
  // counting probe.
  await setupTray({
    getWindow: () => win,
    backend,
    store,
    oldIgcl,
    applyRunner,
    createTrayImpl: uiVerify ? createTrayProbe : createTray,
  });

  // M4M (F): the boot-apply decision runs BEFORE createWindow - the
  // renderer's boot device-state-get (right after the window loads) reads
  // the POST-apply state, so the sliders/readout show the applied profile
  // on the first paint (the old post-window position made even a successful
  // apply invisible in that launch - the "checked the box, started the app,
  // nothing applied" report). The M4-E setup gate (above) still spawns the
  // first-run elevated logon-task setup; the old gate-green SKIP is REMOVED
  // - the boot-gated in-app apply (applyProfileBoot: applyRunner-less,
  // defaults-restore fallback skipped regardless of errorCode) runs on
  // EVERY window-path launch when ocOnBoot + an active profile are set
  // (installed, portable, and dev alike - the logon task still owns LOGON
  // applies; a logon double-apply with the Run-launched app is idempotent).
  // The failure balloon: the ELEVATED product path (isElevated - the
  // packaged app always is) balloons the honest apply reason via
  // trayBalloonForOutcome; the unelevated dev tree keeps the old
  // admin-approval line. Mock mode records the attempt in the mock
  // boot-apply log. Never crashes - every failure is a logged balloon or a
  // console line.
  const mockBootApplyLog = [];
  const recordBootApply = (profileId, out) => {
    mockBootApplyLog.push({
      profileId,
      applied: out.applied === true,
      reason: out.reason ?? null,
      at: Date.now(),
    });
  };
  // M4N (A.1): the WINDOW-PATH boot apply's OUTCOME record - the renderer's
  // boot fetch reads it ('boot-apply-outcome') so the dashboard OC Status
  // row flips GREEN after a successful boot apply (the apply runs before
  // createWindow - this record is how the renderer learns the result; the
  // renderer's dashboard render sig includes lastApply, so the fetch
  // re-renders the row no matter when it lands). Null when no boot apply
  // ran this session. The mock-only mock:run-boot-apply channel does NOT
  // update this record (documented decision: the mid-session probe leaves
  // the OC row as the boot outcome - the record is the window-path apply's
  // own).
  let bootApplyOutcome = null;
  // M4-F (§4 boot resolution): the persisted deviceId wins when it matches
  // an enumerated id; else devices[0] AND the fallback is RE-PERSISTED
  // (self-healing, M7 - a stale selection or an absent field must never
  // wedge the app on a dead id). The renderer's boot read (device-get) and
  // the window-path boot apply both consume this resolution.
  let bootDeviceId = null;
  try {
    bootDeviceId = await resolveBootDeviceId(backend, store);
  } catch (err) {
    console.log(`[boot] deviceId resolution skipped: ${err.message}`);
  }
  try {
    const bootSettings = await store.loadSettings();
    if (bootSettings.ocOnBoot === true && bootSettings.activeProfileId) {
      const out = await applyProfileBoot({
        backend,
        store,
        profileId: bootSettings.activeProfileId,
        deviceId: bootDeviceId,
        oldIgcl,
        log: (s) => console.log(s),
      });
      if (mock) recordBootApply(bootSettings.activeProfileId, out);
      // M4N (A.1): record the outcome for the renderer's boot fetch. The
      // success detail = "Profile '<name>' applied" with the name resolved
      // like the balloon (the same loadProfiles lookup); a failure carries
      // the apply's reason. A THROWN apply records too (the catch below) -
      // an attempted-and-failed apply must never leave the row claiming
      // "No OC apply yet".
      let profileName = null;
      try {
        const ps = await store.loadProfiles();
        profileName = ps.find((p) => p.id === bootSettings.activeProfileId)?.name ?? null;
      } catch { /* best effort name */ }
      bootApplyOutcome = {
        ok: out.applied === true,
        at: Date.now(),
        detail: out.applied === true
          ? `Profile '${profileName ?? bootSettings.activeProfileId}' applied`
          : `Profile apply failed: ${out.reason}`,
      };
      if (!out.applied && trayRef && !trayRef.isDestroyed()) {
        // M4M (F4): the moved block holds only the profile ID - the NAME is
        // resolved here (the runApplyOnStartup pattern) for the honest
        // reason balloon.
        const content = isElevated()
          ? trayBalloonForOutcome(out, profileName)
          : 'Profile apply needs administrator approval - the elevated logon apply is not set up.';
        if (content) trayRef.displayBalloon({ title: 'Arc Power', content });
      }
    }
  } catch (err) {
    console.log(`[boot] in-app boot apply skipped: ${err.message}`);
    // M4N (A.1): a THROWN apply records the failure - the OC row must never
    // claim "No OC apply yet" after an attempted-and-failed boot apply.
    bootApplyOutcome = { ok: false, at: Date.now(), detail: `Profile apply failed: ${err.message}` };
  }

  const win = createWindow(windowBackground, !startMinimizedAtBoot);
  windowForInstance = win;
  // M4-D2 (§1 close-to-tray FIX): the close handler reads the SYNC settings
  // cache (loadSettingsSync) and calls event.preventDefault() IN THE SAME
  // TICK - the old async loadSettings().then(...) ran preventDefault too
  // late (the window had already closed - the "toggle doesn't
  // work"). The handler is registered in EVERY mode (incl. --ui-verify,
  // plan-review F2): the mock store updates the sync cache correctly, and
  // the REAL close-interception probe needs the handler live. A settings
  // read failure degrades to the normal close (never silently swallows a
  // quit - isQuitting lets the tray Quit through).
  win.on('close', (event) => {
    if (event.defaultPrevented) return;
    if (win.isDestroyed() || isQuitting) return;
    try {
      const settings = store.loadSettingsSync();
      if (settings && settings.closeToTray === true) {
        event.preventDefault();
        win.hide();
      }
    } catch {
      // fall through: normal close
    }
  });
  // M5 (S2): the overlay LIFECYCLE rule - the product path has NO
  // window-all-closed handler (Electron's default quit fires only when
  // EVERY window closes; with the overlay alive, closing the main window
  // with closeToTray OFF would leave the app running headless forever).
  // The main window's closed event destroys the overlay + unregisters the
  // hotkey (the pre-M5 exit behavior is preserved); will-quit closes both
  // (the tray-Quit path already works via app.quit).
  win.on('closed', () => {
    overlayHandle?.destroy();
    unregisterOverlayHotkey();
  });

  // --- M5: the software overlay (the MSI Afterburner/RTSS-style HUD) ------
  // Created UNCONDITIONALLY on the product window path (HIDDEN when
  // overlayEnabled is false - apply() shows it when the user enables it
  // through the Overlay page; a lazy create would break the enable path).
  // NEVER in headless/boot-apply/apply-profile (they return earlier);
  // ui-verify creates it only under RID_MOCK_OVERLAY=1 (the variant's
  // real-window pins). M7b (fix 5): the hotkey/shortcut NEVER shows the
  // overlay while the master overlayEnabled is OFF - the gate lives in
  // overlay.js toggle().
  let overlayHandle = null;
  let overlayHotkeyAccelerator = null;
  // The hotkey seam (M6): product path - a REAL globalShortcut registration
  // ('Control+<letter>' - CTRL fixed, only the letter is user-changeable),
  // unregistered on will-quit + re-registered on a letter change. ui-verify
  // injects a COUNTING probe that NEVER registers (a real system hotkey
  // mid-verify would disrupt the session) + a mid-run settable failure fake
  // (the register-failure honesty pin). register() returning false (the
  // accelerator taken by another app) surfaces hotkeyRegistered:false -
  // the Overlay page then shows the honest note (the Show-the-overlay
  // toggle still works; the hotkey does not).
  const overlayHotkeyProbe = { registrations: [], failRegister: false };
  const registerOverlayHotkey = (letter) => {
    if (!overlayHandle) return;
    const normalized = typeof letter === 'string' && /^[A-Za-z]$/.test(letter) ? letter.toUpperCase() : 'O';
    const accel = `Control+${normalized}`;
    if (uiVerify) {
      overlayHotkeyProbe.registrations.push(accel);
      overlayHandle.setHotkeyRegistered(!overlayHotkeyProbe.failRegister);
      return;
    }
    if (overlayHotkeyAccelerator) {
      try { globalShortcut.unregister(overlayHotkeyAccelerator); } catch { /* best effort */ }
      overlayHotkeyAccelerator = null;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => { void overlayHandle.toggle(); });
    } catch {
      ok = false;
    }
    overlayHotkeyAccelerator = ok ? accel : null;
    overlayHandle.setHotkeyRegistered(ok);
    if (!ok) {
      console.log(`[overlay] hotkey ${accel} registration failed (taken by another application?)`);
    }
  };
  const unregisterOverlayHotkey = () => {
    if (overlayHotkeyAccelerator) {
      try { globalShortcut.unregister(overlayHotkeyAccelerator); } catch { /* best effort */ }
      overlayHotkeyAccelerator = null;
    }
    overlayHandle?.setHotkeyRegistered(false);
  };
  // The overlay settings reaction (the rebuildTray pattern): re-apply the
  // geometry/visibility from the FRESH store + re-register the hotkey on a
  // letter change. 'overlay:settings' is NOT an ipc-core push - the overlay
  // module sends it DIRECTLY to the overlay window (webContents.send);
  // ipc.js's emit stays telemetry-only (N1).
  const onOverlaySettings = async (patch) => {
    if (!overlayHandle) return;
    applyOverlaySettings();
    if (patch && typeof patch.overlayHotkeyLetter === 'string') {
      registerOverlayHotkey(patch.overlayHotkeyLetter);
    }
  };
  const applyOverlaySettings = () => {
    if (!overlayHandle) return;
    let settings = {};
    try {
      settings = store.loadSettingsSync() ?? {};
    } catch {
      settings = {};
    }
    overlayHandle.apply({
      enabled: settings.overlayEnabled === true,
      position: OVERLAY_POSITIONS.includes(settings.overlayPosition) ? settings.overlayPosition : 'top-left',
      scale: clampOverlayScale(settings.overlayScale),
      hotkeyLetter: typeof settings.overlayHotkeyLetter === 'string'
        && /^[A-Za-z]$/.test(settings.overlayHotkeyLetter)
        ? settings.overlayHotkeyLetter
        : 'O',
      // M6: the text color + the enabled stats ride the same envelope -
      // the renderer applies them via CSSOM on the push (a color/stats
      // change must re-render the HUD immediately). Garbage degrades to
      // the stock white + the full set - the overlay.js normalize is the
      // final gate.
      color: typeof settings.overlayColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(settings.overlayColor)
        ? settings.overlayColor
        : '#ffffff',
      stats: Array.isArray(settings.overlayStats) ? settings.overlayStats : undefined,
      // M7b (fix 4, plan-review F2): the background box - the three fields
      // MUST be forwarded here or payload() always pushes the defaults and
      // the box never appears (a required-but-insufficient owner set would
      // silently ship a dead feature). The overlay.js normalize is the
      // final gate for garbage.
      overlayBgEnabled: settings.overlayBgEnabled === true,
      overlayBgColor: typeof settings.overlayBgColor === 'string'
        && /^#[0-9a-fA-F]{6}$/.test(settings.overlayBgColor)
        ? settings.overlayBgColor
        : '#000000',
      overlayBgOpacity: typeof settings.overlayBgOpacity === 'number'
        && Number.isFinite(settings.overlayBgOpacity)
        ? Math.min(1, Math.max(0, settings.overlayBgOpacity))
        : 0.5,
    });
  };
  if (uiVerify ? process.env.RID_MOCK_OVERLAY === '1' : true) {
    overlayHandle = createOverlayWindow({
      // The CURRENT persisted settings - the sync cache (the same cache the
      // close handler reads; a read failure degrades to the defaults).
      getOverlaySettings: () => {
        try {
          return store.loadSettingsSync() ?? {};
        } catch {
          return {};
        }
      },
    });
    applyOverlaySettings();
    // Boot the hotkey with the persisted letter (default 'O').
    let bootLetter = 'O';
    try {
      const s = store.loadSettingsSync() ?? {};
      if (typeof s.overlayHotkeyLetter === 'string' && /^[A-Za-z]$/.test(s.overlayHotkeyLetter)) {
        bootLetter = s.overlayHotkeyLetter;
      }
    } catch { /* default O */ }
    registerOverlayHotkey(bootLetter);
  }
  app.on('will-quit', () => {
    overlayHandle?.destroy();
    unregisterOverlayHotkey();
  });
  // M4J (G): the OLD post-window start-minimized block (minimize-to-taskbar
  // after ready-to-show) is REMOVED - the window is created show:false when
  // the pre-create settings read says startMinimized (see createWindow
  // above), and the tray toggle's hidden->show branch restores it. A
  // hidden tray-only window has NO taskbar entry and NO minimize race.
  // M2D: the mock-featureset IPC surface exists ONLY in mock mode - real
  // mode has no such channel (the renderer's dropdown never renders either).
  // M4-D2: mock mode ALSO records every boot-apply attempt in a session
  // mock apply log + exposes the REAL boot-apply flow as a mock-only
  // channel (mock:run-boot-apply) - ui-verify proves the flow: the log
  // records the active profile with no refusal. (mockBootApplyLog +
  // recordBootApply live ABOVE the window-path apply block - the moved
  // block calls recordBootApply and the defs must precede it.)
  const runMockBootApply = async () => {
    let settings;
    try {
      settings = await store.loadSettings();
    } catch (err) {
      return { applied: false, reason: `settings read failed: ${err.message}`, log: mockBootApplyLog.slice() };
    }
    if (settings.ocOnBoot !== true || !settings.activeProfileId) {
      return { applied: false, reason: 'Start-at-boot is disabled or no active profile', log: mockBootApplyLog.slice() };
    }
    // The REAL boot-apply code path: boot-gated, applyRunner-less
    // (in-process only), defaults-restore skipped regardless of errorCode.
    // M4-F (S2): targets the persisted/selected device (the run-2 pin
    // "boot apply targets the selected device" asserts the OTHER device is
    // untouched through this resolution).
    let mockBootDeviceId = null;
    try {
      mockBootDeviceId = await resolveApplyDeviceId(backend, store, null);
    } catch (err) {
      console.log(`[mock-boot-apply] deviceId resolution skipped: ${err.message}`);
    }
    const out = await applyProfileBoot({
      backend,
      store,
      profileId: settings.activeProfileId,
      deviceId: mockBootDeviceId,
      oldIgcl,
      log: (s) => console.log(`[mock-boot-apply] ${s}`),
    });
    recordBootApply(settings.activeProfileId, out);
    return { ...out, log: mockBootApplyLog.slice() };
  };
  const mockCtl = mock
    ? {
        listFeaturesets: () => backend.listFeaturesets(),
        setFeatureset: (id) => backend.setFeatureset(id),
        runBootApply: runMockBootApply,
        bootApplyLog: async () => mockBootApplyLog.slice(),
      }
    : null;
  // Whitelisted IPC + telemetry ownership; the renderer drives everything.
  // --ui-verify never creates a tray, so rebuildTray guards the null ref.
  let trayRebuilds = 0;
  // M4-D: the injected window ops for the integrated title bar. The product
  // path performs the real BrowserWindow ops; --ui-verify mode injects
  // COUNTING probes instead (performing minimize/close mid-verify would
  // disrupt the assertions) - run 2 pins the title-bar buttons through
  // getWindowOpCounts.
  let windowOpCounts = { minimize: 0, maximizeToggle: 0, close: 0 };
  const windowOps = uiVerify
    ? {
        minimize: async () => { windowOpCounts.minimize += 1; },
        maximizeToggle: async () => { windowOpCounts.maximizeToggle += 1; },
        close: async () => { windowOpCounts.close += 1; },
      }
    : {
        minimize: async () => { if (!win.isDestroyed()) win.minimize(); },
        maximizeToggle: async () => {
          if (win.isDestroyed()) return;
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
        },
        close: async () => { if (!win.isDestroyed()) win.close(); },
      };
  // M4-H (D1): the open-external op - shell.openExternal in the product
  // path; --ui-verify injects a COUNTING probe (opening a real browser
  // mid-verify would disrupt the assertions) - the GitHub-link pin asserts
  // the count ticked and the strict URL validation rejects bad hosts.
  let openExternalCount = 0;
  const openExternal = uiVerify
    ? async () => { openExternalCount += 1; }
    : async (url) => { await shell.openExternal(url); };
  teardown = registerIpc({
    backend,
    store,
    getWindow: () => win,
    // M5: the overlay window (the telemetry emit forwards to BOTH windows;
    // null when no overlay exists - the emit null-guards it).
    getOverlayWindow: () => (overlayHandle ? overlayHandle.getWindow() : null),
    // M5: the injected overlay ops - the REAL overlay handle in both the
    // product path and the RID_MOCK_OVERLAY=1 ui-verify variant (the
    // variant's overlay window is real, like the main window - the toggle
    // really flips it). When no overlay exists (other ui-verify variants)
    // the DEFAULT no-window ops keep the channels honest.
    overlayOps: overlayHandle
      ? {
          getState: async () => overlayHandle.getState(),
          toggle: async () => { await overlayHandle.toggle(); },
        }
      : undefined,
    // M5: the overlay settings reaction (the rebuildTray pattern) - called
    // by profiles-settings-save when an overlay field changed.
    onOverlaySettings,
    startup,
    driverInfo,
    sysinfo,
    windowOps,
    openExternal,
    registryCatalog,
    registryApply,
    fpsAdapter,
    foregroundApi,
    sysStats,
    monitorLog,
    oldIgcl,
    applyRunner,
    isElevated,
    // M4-E: the distribution kind for app:build-info (the Settings
    // start-with-Windows hint differentiates by it). Mock/ui-verify reports
    // 'portable' (the mock applies in-process like the portable build); the
    // packaged PORTABLE build (PORTABLE_EXECUTABLE_DIR set) reports
    // 'portable' too - never 'dev' (deriveBuildKind pin).
    buildKind: deriveBuildKind({ mock, installedBuild, isPackaged: app.isPackaged }),
    // M4N (A.1): the window-path boot apply's outcome record (the renderer
    // boot fetch reads it - the dashboard OC row flips green after a
    // successful boot apply; null when no boot apply ran this session).
    bootApplyOutcome: () => bootApplyOutcome,
    mock: mockCtl,
    rebuildTray: async () => {
      try { await trayRef?.rebuildMenu?.(); } catch { /* tray unavailable */ }
      // Dev-only probe: lets --ui-verify assert that profile changes reach
      // the tray rebuild hook without a real tray existing.
      if (uiVerify) trayRebuilds += 1;
    },
  });

  if (uiVerify) {
    // Dev-only end-to-end check against MockBackend (never hardware). The
    // waiver flag is already seeded above (pre-window, F2) - no re-seed.
    await backend.init();
    await new Promise((resolve) => {
      if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve);
      else resolve();
    });
    // M2D featureset variant: RID_MOCK_FEATURESET=<id> (b580 / pro-b50 /
    // arc-igpu) runs the reduced per-featureset verification flow - the full
    // default flow is pinned to A770 values.
    const fsVariant = process.env.RID_MOCK_FEATURESET;
    if (process.env.RID_MOCK_NO_INTEL === '1') {
      // 1.0.1 no-Intel round: the no-intel variant - an EARLY-diverging
      // reduced flow (no waiver boot step: the no-device boot never prompts)
      // pinning the whole no-Intel behavior end to end.
      await runNoIntelVerify(win);
    } else if (fsVariant && fsVariant !== 'a770') {
      await runFeaturesetVerify(win, fsVariant);
    } else if (process.env.RID_MOCK_TWEAKS_APPLY === '1') {
      // M3-B tweaks-apply variant: drives the full apply flow (mock adapter,
      // no elevation) - enable/disable/revert round trips, per-step toasts,
      // the partial-failure + UAC-cancel honesty paths.
      await runTweaksApplyVerify(win);
    } else if (process.env.RID_MOCK_FAN_GATE === '1') {
      // M4-A fan-gate variant: the unaccepted-waiver fan apply regression -
      // dialog -> Cancel aborts with the honest toast, dialog -> Accept
      // lands, and the G2 self-heal re-shows the dialog after the driver
      // loses the waiver (the "fan applies fail without a prompt" bug).
      await runFanGateVerify(win, backend);
    } else if (process.env.RID_MOCK_BOOT_APPLY === '1') {
      // M4M (F7): the boot-apply variant - the session seed wrote
      // ocOnBoot:true + activeProfileId 'boot-apply-probe' + an accepted
      // waiver, so the WINDOW-PATH apply (moved BEFORE createWindow above)
      // ran automatically at boot. Asserts the mock apply log recorded it
      // AND the tuning page reflects the POST-apply state (the regression
      // assertion for the ordering fix).
      await runBootApplyVerify(win, backend, store);
    } else if (process.env.RID_MOCK_BOOT_APPLY_EXT === '1') {
      // M4O: the boot-apply-EXT variant (run WITH RID_MOCK_STOCK_MODE=1) -
      // the seed wrote the EXTENDED 315 W probe profile, so the automatic
      // window-path apply must land it against a STOCK-mode session (the
      // profileApply path ignores the OC-mode gate - the regression pin for
      // the report: stock mode + advanced profile values used to fail
      // at boot with the "Nothing was changed" mode message).
      await runBootApplyExtVerify(win, backend, store);
    } else if (process.env.RID_MOCK_OVERLAY === '1') {
      // M5: the overlay variant - the overlay window is REAL (created above
      // under the knob, seeded overlayEnabled:true); the hotkey is the
      // counting probe (never a real registration). Three matrix configs:
      // 'overlay' alone (the 'FPS -  1% Low -  99% FPS -' pin), 'overlay+fps'
      // (RID_MOCK_FPS=1 - 'FPS 60  1% Low 52  99% FPS 58') and
      // 'overlay+fps+api' (RID_MOCK_API=1 - 'FPS 60  DX12  1% Low 52
      // 99% FPS 58' - the Graphics-API badge rides the same sample).
      // M8: the graphics block runs FIRST (runOverlayVerify exits the app).
      // M10b: the display block rides right after (the Display view also
      // runs under the overlay variants).
      await runGraphicsVerify(win, backend);
      await runDisplayVerify(win, backend);
      await runOverlayVerify(win, overlayHandle, store, overlayHotkeyProbe);
    } else {
      // M4-D: the window-ops probe rides along - run 2 pins the title-bar
      // buttons via getWindowOpCounts. M4-H: the open-external probe rides
      // too (the GitHub-link pin asserts the counting op ticked). M4J (G):
      // the tray probe rides as well (the tray-start pin).
      await runUiVerify(win, backend, store, () => trayRebuilds, () => fpsPolls, () => windowOpCounts, () => openExternalCount, () => trayProbe);
    }
    return;
  }

  await bootBackend();
  const health = await collectHealth(backend);
  console.log(`[health] ${JSON.stringify(health)}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}\n${err.stack}`);
  app.exit(1);
});
