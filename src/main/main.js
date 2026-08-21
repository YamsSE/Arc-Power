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
//   electron . --sysman-helper <reqFile> <outFile> -> M17i sysman helper:
//     the IGCL-free process running the power-limits consumer (no backend,
//     no OldIgcl - the bare-context zesInit path), spawned directly by the
//     helper proxy, exits after writing the result file.
//   electron . --sysman-helper-pipe -> M17m DETACHED sysman helper: the
//     same IGCL-free consumer process, but the transport is the Windows
//     named pipe \\.\pipe\arcpower-sysman (node's net) and the lifecycle
//     is DETACHED - a client disconnect NEVER exits the helper (only the
//     idle timeout does; RID_SYSMAN_HELPER_IDLE_MS, default 0 = NEVER -
//     M17o the never-dying helper), so its ze context (init'd when the
//     machine was idle) outlives the app sessions. M17o2: the ze init is
//     a SINGLE attempt - a fresh process's init ALWAYS lands (5/5
//     live-proven) while the in-process retry was provably permanently
//     stuck; a failed init EXITS 77 and the proxy's HEAL respawns a
//     fresh helper. Its own log file lives at
//     %TEMP%\arcpower-sysman-helper.log. NO args.
//     M17o3 (the live finding, 2026-08-14): the proxy NO LONGER spawns
//     THIS branch - it spawns the ELECTRON-FREE helper-entry.js
//     (src/main/sysman/helper-entry.js) with ELECTRON_RUN_AS_NODE=1 (a
//     PLAIN NODE process - the packaged helper spawned as the ELECTRON
//     EXE fails its ze init EVERY time, 3/3 measured, while a node
//     process's init succeeds 5/5 + the RUNASNODE probe). THIS branch
//     stays for the DIRECT-INVOCATION parity only (the pipeline's
//     live-detached-e2e + the gate harness still call it).
//     (The M17j/M17l PERSISTENT stdin form `--sysman-helper-persist` was
//     REMOVED in M17m run B - the detached pipe form supersedes it.)
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
import { runUiVerify, runFeaturesetVerify, runTweaksApplyVerify, runFanGateVerify, runBootApplyVerify, runBootApplyExtVerify, runTrayApplyVerify, runNoIntelVerify, runLaptopSysinfoVerify, runOverlayVerify, runGraphicsVerify, runNoSysmanVerify, runAdvancedOverlayVerify } from './ui-verify.js';
import { collectHealth } from './health.js';
import { registerIpc } from './ipc.js';
import { seedWaiverState, probeWaiverState, seedOcMode, resolveBootDeviceId, clampOverlayScale, waiverProbeDue } from './ipc-core.js';
import { ProfileStore, OVERLAY_POSITIONS, OVERLAY_STAT_IDS, OVERLAY_STATS_DEFAULT, OVERLAY_THEMES, OVERLAY_THEME_DEFAULT } from './store/profile-store.js';
import { createOverlayWindow } from './overlay.js';
// M23 (Part B): the ADVANCED overlay module (the AMD-Adrenaline-style
// interactive side panel - CONTROL + <letter>, stock P). The HUD's
// overlay.js stays untouched - this panel has its own lifecycle + its own
// interactivity (NO setIgnoreMouseEvents).
import { createAdvancedOverlayWindow } from './advanced-overlay.js';
import { createStartup, createMockStartup, resolveLogonExecPath } from './startup.js';
import { createDriverInfo, createMockDriverInfo } from './driver-info.js';
import { REGISTRY_CATALOG, createRegistryCatalog, createMockRegistryCatalog, createMockRegistryState } from './registry-catalog.js';
import { createRegistryApply, createMockRegistryApply } from './registry-apply.js';
import { createDxgiFpsAdapter } from './fps-dxgi.js';
import { createPresentMonFpsSource, createPresentMonLane, createPresentMonSourceChain } from './fps-etw.js';
import { createPmFpsSource } from './fps-pm.js';
import { createForegroundApiDetector } from './foreground-api.js';
import { createMemoryUtilDetector } from './memory-util.js';
import { createSysStats, createMockSysStats } from './sys-stats.js';
import { createMsrReader } from './msr-reader.js';
import { createMonitorLog } from './monitor-log.js';
import { collectSysinfo, createMockSysinfo, vramBytesOfDevice, applyDriverReBar, createDriverReBar } from './sysinfo.js';
import { applyProfile, runApplyOnStartup, applyProfileBoot, resolveApplyDeviceId } from './apply-on-boot.js';
import { runBootApplyMode } from './boot-apply-mode.js';
import { shouldUseInstanceLock, acquireInstanceLock, focusExistingWindow } from './single-instance.js';
import { createBootSetup, taskActionMatches } from './setup-boot.js';
import { deriveBuildKind } from './build-kind.js';
import { createTray, buildTrayMenuTemplate, trayToggleAction, TRAY_LABEL_TOGGLE, TRAY_LABEL_APPLY_PROFILE, trayBalloonForOutcome } from './tray.js';
import { trayApplyActiveProfile } from './tray-apply.js';
import { isElevated as isElevatedReal } from './elevation.js';
import { OldIgcl } from './old-igcl.js';
import { executeApply } from './apply-routing.js';
import { runApplyWorker } from './apply-worker.js';
import {
  runSysmanHelperMode,
  runSysmanHelperPipeMode,
  createSysmanHelperLogFileWriter,
} from './sysman/helper-mode.js';
// M17i: the helper proxy - the parent-side client of the --sysman-helper
// mode (the IGCL-free process running the power-limits consumer). The REAL
// path constructs the proxy instead of the raw consumer everywhere the
// consumer would run inside an electron+IGCL process (the M17i measured
// poison); the raw consumer is constructed ONLY in the --sysman-helper
// branch itself (the bare context).
import { createSysmanHelperProxy } from './sysman/helper-proxy.js';
import { createApplyRunner } from './elevated-apply.js';
import { createMockOldIgcl } from './backend/mock-backend.js';
import { createUnifiedGpuBackend } from './gpu-inventory.js';
// M17f: the sysman power-limits consumer (the PL2 companion + the
// 'power-limits:read' source). The REAL adapter lazily loads ze_loader.dll;
// the MOCK seam (mock/ui-verify) answers the fixture limits through the
// backend and never touches the DLL.
import { createSysmanPowerLimits, createMockSysmanPowerLimits } from './sysman/power-limits.js';
// M17d (Run E): the --profile-boot stage-timing harness (env-gated; a no-op
// in product runs - see profile-boot.js).
import { markProfileBoot, bootProfilingEnabled, profileElapsedMs } from './profile-boot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// M17d (Run E): the harness gate - ARC_POWER_PROFILE_BOOT=1 OR
// --profile-boot. When on, the boot stages log elapsed-from-launch lines and
// the window path auto-exits after the renderer boot completes (a
// measurement run, never a lingering session).
const profileBoot = bootProfilingEnabled();

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
// M17i sysman-helper mode: `--sysman-helper <reqFile> <outFile>` (the
// IGCL-free process running the power-limits consumer - spawned by the
// helper proxy, never by a user).
const sysmanHelperIdx = process.argv.indexOf('--sysman-helper');
const sysmanHelperReqFile = sysmanHelperIdx >= 0 ? process.argv[sysmanHelperIdx + 1] : null;
const sysmanHelperOutFile = sysmanHelperIdx >= 0 ? process.argv[sysmanHelperIdx + 2] : null;
// M17m DETACHED PIPE sysman-helper mode: `--sysman-helper-pipe` (NO args) -
// the named-pipe server form (run A ADDED the pipe mode ALONGSIDE the M17l
// stdin mode; run B REMOVED the stdin mode + its `--sysman-helper-persist`
// branch + swapped the proxy's spawn arg - no dead-flag window).
const sysmanHelperPipeIdx = process.argv.indexOf('--sysman-helper-pipe');

// M19 THE BOUNDED BOOT WARM (the PL2 fix - the user: 'PL2 needs to apply
// instantly like it should have before', 'if i do 300W it should do
// 300w/300w'). The M17k boot-order promise ('the helper's ze init lands
// while the machine is idle, before the backend load opens the arbitration
// window') was never HONORED: `void realSysmanLimits.warm?.()` is fire-and-
// forget, so the helper's ze init RACES the backend's IGCL load + the boot
// probe writes. A fresh ze init INSIDE the window fails (the M17j measured
// window: fresh inits fail for 8+ s after an IGCL write - zesInit
// ERROR_UNINITIALIZED), so the helper never establishes its ze context and
// every apply that session answers the instant not-ready verdict -> the
// V2-clamp -> PL2 = min(requested, 252) = 252 (the user's exact complaint).
// THE FIX: bound-AWAIT the warm - the fresh helper's ze init lands in
// ~0.5 s (the M17o2 live evidence: 5/5, even 2 s after a write; the Acer
// Predator tool applies its profile 300/300 instantly by spawning a fresh
// helper per apply), so the boot warm gets up to SYSMAN_WARM_BOUND_MS to
// establish the context BEFORE the backend load; a helper that genuinely
// cannot init never stalls the boot past the bound (the apply's own
// bounded fresh-spawn retry in runSysmanCompanion covers the rest).
const SYSMAN_WARM_BOUND_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** M19: bound-await the proxy warm (idempotent, never throws). The warm
 *  resolves on the SOCKET CONNECT (helper-proxy's ensureConnected) - NOT
 *  the helper's ready line, so the ze init may still be in flight when it
 *  lands; the bounded fresh-spawn retry in runSysmanCompanion covers that
 *  residual ze-init gap. A warm that lands inside the bound gives the whole
 *  session working PL2 (300/300 on every apply).
 *  @param {{ warm?: () => Promise<unknown> } | null | undefined} proxy */
async function boundWarm(proxy) {
  if (!proxy || typeof proxy.warm !== 'function') return;
  try {
    await Promise.race([proxy.warm(), sleep(SYSMAN_WARM_BOUND_MS)]);
  } catch {
    // a warm failure degrades silently - the apply's not-ready retry covers it
  }
}

// M23 CHANGE 3 / PART A (the full-close reap): the SYSMAN SHUTDOWN BOUND -
// the helper-proxy shutdown handshake bound (~1 s, the proxy's own
// shutdownBoundMs). The worker + boot-apply branches BOUND-AWAIT the
// shutdown BEFORE app.exit: those branches exit immediately after the
// apply, so a fire-and-forget socket.write would be torn down before the
// op flushes and the helper would survive (the boot task must not leave a
// helper behind either). ~1 s is fine on the sequential exit paths.
const SYSMAN_SHUTDOWN_BOUND_MS = 1000;

/** M23: bound-await the proxy shutdown (idempotent, never throws). */
async function boundShutdown(proxy) {
  if (!proxy || typeof proxy.shutdown !== 'function') return;
  try {
    await Promise.race([proxy.shutdown(), sleep(SYSMAN_SHUTDOWN_BOUND_MS)]);
  } catch {
    // a shutdown failure degrades silently - the helper-side idle backstop reaps it
  }
}

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
    // M17d (Run E): the profile run forwards the renderer's info-level
    // marks too (the first-paint / first-caps / boot-complete stages live in
    // the renderer boot path - the harness's stage table needs them; a
    // product run never forwards info lines). The receipt elapsed stamps the
    // renderer marks with the same clock as the main-process stages.
    if (profileBoot && level === 0) console.log(`[renderer @+${profileElapsedMs()}ms] ${message}`);
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
  // M17d (Run E): the profile window run passes the harness flag to the
  // renderer via the load query (the renderer is sandboxed - no env access;
  // its boot marks are gated on the same flag so product runs never emit
  // the harness lines).
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), profileBoot ? { query: { profileBoot: '1' } } : undefined);
  return win;
}

// M23 (user): --ui-verify windows must NOT flash on the user's screen - the
// suite drives the DOM/IPC/bounds/isVisible pins (all of which work on an
// opacity-0 window: it stays SHOWN + laid out at its real coordinates, only
// the OS presentation is transparent), so every window the harness creates
// (main, HUD overlay, advanced overlay) is made invisible this way. Product
// runs never call it (opacity stays 1).
function stealthVerifyWindow(win) {
  if (!uiVerify) return;
  try {
    win.setOpacity(0);
  } catch { /* best effort - a destroyed mid-verify window never throws */ }
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
async function setupTray({ getWindow, backend, store, oldIgcl, applyRunner, sysmanPowerLimits = null, createTrayImpl = createTray }) {
  // M17e (the user addition): the SHOW-WINDOW action - restores a
  // minimized window + focuses it; shows + focuses a hidden one. Shared by
  // the menu toggle's show branch and the tray DOUBLE-CLICK (the user's
  // request: double-clicking the tray icon opens the app - the left-click
  // single click behavior is unchanged, the context menu owns the toggle).
  const showMainWindow = () => {
    const win = getWindow();
    if (!win) return;
    if (win.isMinimized()) {
      win.restore();
      win.focus();
    } else {
      win.show();
      win.focus();
    }
  };
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
          showMainWindow();
        }
      },
      onApplyProfile: () => trayApplyActiveProfile({
        backend,
        store,
        oldIgcl,
        applyRunner,
        // M17i: the tray apply is an in-process electron+IGCL apply of the
        // acceptance-1 class - the sysman companion must delegate to the
        // IGCL-free helper there too (the proxy; null in the mock seam's
        // no-sysman variant - the honest skip).
        sysmanPowerLimits,
        // M16-F1 (D2): the renderer state push needs the main window
        // (resolved lazily - the tray can exist before the window in a
        // start-minimized session; a destroyed window never receives).
        getWindow,
        // The module-level trayRef is assigned AFTER setupTray returns -
        // pass a getter so the click handler sees the LIVE tray, never a
        // stale null (the balloon path needs it).
        getTray: () => trayRef,
        log: (s) => console.error(s),
      }),
      onQuit: () => app.quit(),
    });
  };
  const tray = createTrayImpl({ tray: Tray, nativeImage, Menu, template: await menuTemplate() });
  trayRef = tray;
  // M17e: the tray DOUBLE-CLICK shows/focuses the main window (the user's
  // request). Electron's Tray emits 'double-click' on Windows; the
  // ui-verify probe's .on records the handler so the wiring is assertable.
  if (typeof tray.on === 'function') {
    tray.on('double-click', showMainWindow);
  }
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
    // M17k: the EARLY warm-up in the worker branch (the same shape as the
    // window path): the proxy is constructed + WARMED BEFORE the worker's
    // backend/IGCL creation - the helper spawns while the machine is idle,
    // so its ze init lands before this process's own IGCL activity (the
    // worker's backend load) could open the arbitration window; the
    // worker's first sysman call then rides the ready helper (the
    // in-flight latch shares one connect with the warm - never a
    // double-spawn).
    const workerSysmanLimits = createSysmanHelperProxy({
      execPath: process.execPath,
      appPath: process.defaultApp ? app.getAppPath() : null,
      log: (s) => console.log(`[sysman-helper] ${s}`),
    });
    // M19: the warm is BOUND-AWAITED (not fire-and-forget) - the worker's
    // helper must be ready before ITS backend/IGCL load (the M17k shape).
    await boundWarm(workerSysmanLimits);
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
    const workerBackend = createBackend({
      kind: 'igcl',
      igcl: {
        extended: { isCapable: () => workerOldIgcl.isCapable() },
        ocMode: 'advanced',
      },
    });
    // M30: the worker receives the durable key and uses the same routing
    // wrapper. With no OS snapshot in the short-lived worker, an OS-only key
    // cannot resolve and therefore refuses closed-loop rather than falling
    // back to IGCL adapter 0.
    const workerRoutedBackend = createUnifiedGpuBackend({ backend: workerBackend, sysinfo: null });
    const code = await runApplyWorker({
      reqPath: workerReqFile,
      outPath: workerOutFile,
      backend: workerRoutedBackend,
      oldIgcl: workerOldIgcl,
      // M17f/M17i: the worker is the ELEVATED apply process - the sysman
      // companion syncs the PL2 burst there too. M17i: the companion
      // DELEGATES to the IGCL-free helper (this process carries the IGCL
      // backend + OldIgcl - the measured zesInit poison combo) through the
      // proxy; the helper inherits the worker's elevation (the direct
      // spawn, no RunAs). M17k: the proxy is the WARMED one above (the
      // same shape as the window path).
      sysmanPowerLimits: workerSysmanLimits,
      log: (s) => console.log(`[apply-worker] ${s}`),
    });
    // M23 CHANGE 3 (Part A): the ELEVATED worker's full close reaps the
    // helper BEFORE app.exit - the branch exits immediately after the
    // apply, so a fire-and-forget write would be torn down before the op
    // flushes (the worker must not leave a helper behind either). Bounded
    // (~1 s); the stated tradeoff (conscious): a full close mid-apply
    // kills the helper under the worker's in-flight set - the socket close
    // resolves that set as a failure. Benign - the process is exiting.
    await boundShutdown(workerSysmanLimits);
    app.exit(code);
    return;
  }

  // --- M17m --sysman-helper-pipe mode (NO args): -------------------------
  // the DETACHED machine-level sysman helper (M17m): the same IGCL-free
  // consumer process, but the transport is a Windows NAMED PIPE
  // (\\.\pipe\arcpower-sysman, node's net) and the lifecycle is DETACHED:
  // a client disconnect NEVER exits the helper - only the idle timeout
  // (RID_SYSMAN_HELPER_IDLE_MS, default 0 = NEVER - M17o the never-dying
  // helper) does, so the helper's ze context (init'd when the machine was
  // idle) outlives the app sessions. M17o2 THE MEASURED TRUTH: the
  // '12-20+ min arbitration window' NEVER EXISTED for FRESH processes - a
  // fresh process's ze init succeeds ALWAYS (5/5 live-proven, even 2 s
  // after a real elevated write), while the IN-PROCESS retry was provably
  // PERMANENTLY STUCK (PID 9404: attempt 1459+ over 50+ min; the ze
  // loader's per-process state after a failed init never recovers - a
  // FRESH PROCESS is required per retry). The init is therefore a SINGLE
  // attempt: a failed probe EXITS 77 (HELPER_INIT_FAILED_EXIT_CODE) and
  // the proxy's HEAL respawns a fresh helper. The per-connection ready
  // semantics + the globally serialized dispatch + the bind-conflict exit
  // (EADDRINUSE -> 0) live in runSysmanHelperPipeMode. THE HELPER'S OWN
  // LOG FILE (round-1 S3): %TEMP%\arcpower-sysman-helper.log carries the
  // init lines + the ready/response events + the PID + the init timestamp
  // (the same-helper assertion surface) - the consumer's log is pinned to
  // the SAME file. Like the one-shot branch, it sits BEFORE app.whenReady()
  // and therefore BEFORE the instance-lock gate: the helper is a SECOND
  // instance spawned while the UI holds the lock and must NEVER touch it
  // (single-instance.js untouched). (Run B: the M17j/M17l PERSISTENT
  // stdin branch was REMOVED in the same change as the proxy's spawn-arg
  // swap to this mode - no dead-flag window.)
  // M17o3 (the live finding, 2026-08-14): THE PROXY SPAWNS
  // src/main/sysman/helper-entry.js (the no-electron wiring of THIS
  // branch) with ELECTRON_RUN_AS_NODE=1 - a PLAIN NODE process, whose ze
  // init works (5/5 + the RUNASNODE probe: PL1 300 PL2 252 read back),
  // while the packaged helper spawned as the ELECTRON EXE fails its ze
  // init EVERY time (zesInit ERROR_UNINITIALIZED - 3/3 measured). THIS
  // BRANCH therefore stays ONLY for the DIRECT-INVOCATION parity (the
  // pipeline's live-detached-e2e + the gate harness run
  // `electron . --sysman-helper-pipe` directly) - the app never reaches
  // it anymore.
  if (sysmanHelperPipeIdx >= 0) {
    const helperLog = createSysmanHelperLogFileWriter();
    const code = await runSysmanHelperPipeMode({
      // M17o2 THE SINGLE INIT ATTEMPT on a FRESH consumer (the real
      // createSysmanPowerLimits LATCHES its degrade - a failed ze init
      // stays unavailable on that instance forever; the in-process retry
      // is gone, the fresh-process retry is the proxy's HEAL respawn).
      // The consumer's log is pinned to the helper's OWN log file.
      createConsumer: () => createSysmanPowerLimits({ log: (s) => helperLog(`[sysman] ${s}`) }),
      log: (s) => helperLog(s),
    });
    app.exit(code);
    return;
  }

  // --- M17i --sysman-helper mode (`--sysman-helper <req> <out>`): --------
  // the sysman power-limits consumer in a DEDICATED IGCL-free process (the
  // M17i measured root cause: the consumer's zesInit fails with
  // ERROR_UNINITIALIZED ONLY when the IGCL is loaded inside an ELECTRON
  // process). This branch constructs NO backend and NO OldIgcl - the bare
  // context, so no IGCL DLL ever loads here. It sits BEFORE app.whenReady()
  // and therefore BEFORE the instance-lock gate: the helper is a SECOND
  // instance spawned while the UI holds the lock and must NEVER touch it
  // (single-instance.js untouched). Gated on the flag INDEX (round-1 N3) -
  // a bare `--sysman-helper` (zero args) must fail fast at the arg-count
  // guard below, never fall through to the UI path.
  if (sysmanHelperIdx >= 0) {
    if (!sysmanHelperOutFile) {
      console.error('--sysman-helper requires <reqFile> <outFile>');
      app.exit(1);
      return;
    }
    const code = await runSysmanHelperMode({
      reqPath: sysmanHelperReqFile,
      outPath: sysmanHelperOutFile,
      consumer: createSysmanPowerLimits({}),
      log: (s) => console.log(`[sysman-helper] ${s}`),
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
    // M17k: the EARLY warm-up in the boot-apply branch (the same shape as
    // the window path): the REAL proxy is constructed + WARMED BEFORE the
    // backend/IGCL creation - the logon task's helper spawns while the
    // machine is idle, so its ze init lands before this process's own IGCL
    // activity (the boot apply's backend load + the waiver-probe writes)
    // could open the arbitration window; the apply then rides the ready
    // helper. The MOCK seam stays at the bootSysmanLimits const below (the
    // mock consumer wraps the backend and can only exist after it).
    const bootRealSysmanLimits = mock ? null : createSysmanHelperProxy({
      execPath: process.execPath,
      appPath: process.defaultApp ? app.getAppPath() : null,
      log: (s) => console.log(`[sysman-helper] ${s}`),
    });
    // M19: the warm is BOUND-AWAITED (not fire-and-forget) - the boot
    // apply's helper must be ready before the boot backend load.
    if (!mock) await boundWarm(bootRealSysmanLimits);
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
    // M17f/M17i: the boot apply runs ELEVATED (the logon task) - the
    // sysman companion syncs the PL2 burst there too (the mock seam
    // in mock mode). M17i: the REAL companion DELEGATES to the IGCL-free
    // helper through the proxy (this process carries the IGCL backend +
    // OldIgcl - the measured zesInit poison combo); the helper inherits the
    // task's elevation (the direct spawn, no RunAs). Constructed ONCE for
    // this mode and shared by the apply closure and the tray closure.
    const bootSysmanLimits = mock
      ? createMockSysmanPowerLimits({ backend: bootBackend })
      : bootRealSysmanLimits;
    try {
      const out = await runBootApplyMode({
        store: bootStore,
        apply: (profileId) => applyProfileBoot({
          backend: bootBackend,
          store: bootStore,
          profileId,
          deviceId: bootDeviceId,
          oldIgcl: mock ? createMockOldIgcl(bootBackend) : bootOldIgcl,
          sysmanPowerLimits: bootSysmanLimits,
          log: (s) => console.log(`[boot-apply] ${s}`),
        }),
        setupTray: () => setupTray({
          getWindow: () => null,
          backend: bootBackend,
          store: bootStore,
          oldIgcl: mock ? createMockOldIgcl(bootBackend) : bootOldIgcl,
          applyRunner: null,
          sysmanPowerLimits: bootSysmanLimits,
        }),
        log: (s) => console.log(`[boot-apply] ${s}`),
      });
      console.log(`[boot-apply] ${out.action}${out.reason ? ` - ${out.reason}` : ''} - exiting 0`);
    } catch (err) {
      console.log(`[boot-apply] mode failed (${err.message}) - exiting 0`);
    } finally {
      await bootBackend.close().catch(() => {});
    }
    // M23 CHANGE 3 (Part A): the boot task's full close reaps the helper
    // BEFORE app.exit - the same bounded-await rationale as the worker
    // branch (the branch exits immediately after the apply; a
    // fire-and-forget write would be torn down before the op flushes and
    // the boot task must not leave a helper behind either). The mock seam
    // never built a proxy (bootRealSysmanLimits is null in mock mode).
    await boundShutdown(bootRealSysmanLimits);
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
  markProfileBoot('when-ready');

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
  markProfileBoot('instance-lock');
  // M17k + M19: the EARLY helper warm-up (the boot-order fix for the 30-90 s
  // apply hangs - the M17j debug log: the persistent helper CONNECTED but
  // every request timed out because its ze init retried INSIDE the
  // arbitration window the app's own IGCL activity had opened). The REAL
  // proxy is constructed + WARMED here - AFTER the instance-lock gate (the
  // second-instance quit path above must NEVER orphan a spawned helper)
  // and BEFORE the backend/IGCL creation below - so the helper's ze init
  // lands while the machine is idle (the persist-proof: attempt 1), long
  // before the backend load + the caps probes (incl. the fan-probe WRITES)
  // + the renderer's boot caps fetch. M19: the warm is BOUND-AWAITED (the
  // M17k `void warm?.()` was fire-and-forget - the helper's ze init RACED
  // the backend's IGCL load and lost, so the session had no ze context and
  // every apply answered not-ready -> the V2-clamp -> PL2 252; the bound-
  // await gives the fresh init (~0.5 s) time to establish BEFORE the load
  // opens the window - PL2 = 300/300 on every apply; a helper that cannot
  // init never stalls the boot past SYSMAN_WARM_BOUND_MS). warm() is
  // idempotent + never throws: a failure degrades silently and the first
  // readLimits/setLimits re-attempts the connect as today. The MOCK seam
  // stays at the sysmanPowerLimits const below (the mock consumer wraps
  // the backend and can only exist after it).
  const realSysmanLimits = mock ? null : createSysmanHelperProxy({
    execPath: process.execPath,
    appPath: process.defaultApp ? app.getAppPath() : null,
    log: (s) => console.log(`[sysman-helper] ${s}`),
  });
  if (!mock) await boundWarm(realSysmanLimits);
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
  // M20-B (the Alchemist fan Fixed mode): RID_MOCK_FAN_FIXED=1 runs the mock
  // in the flat-table-fixed session - the probe's flat-table fallback
  // learned 'fixed' (modes ['auto','curve','fixed']) and the read-back
  // derives 'fixed' from a flat table. The ui-verify knob variant pins the
  // enabled Fixed chip + the fixed apply round trip (the RID_MOCK_FAN_READONLY
  // pattern; the mock default keeps the honest no-fixed card - the M4-C pins
  // stay green).
  if (uiVerify && process.env.RID_MOCK_FAN_FIXED === '1') {
    mockOpts.fanFixed = true;
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
  // M17d (Run E): warm the bundled-2023-runtime probe in parallel with the
  // pre-window sequence - its load + ctlInit + enum + waiver takes hundreds
  // of ms and today the FIRST extended-value consumer pays it serially (the
  // boot-apply's routing on this box, the renderer's first getCapabilities
  // on a no-boot-apply box - see pipeline/startup-boot-before.md). The
  // result is tri-state-cached + the isCapable latch shares ONE in-flight
  // sequence with any concurrent caller (never a second ctlInit of the same
  // runtime in one process). Never rejects (isCapable catches internally);
  // the caps read stays lazy - this only pre-starts the load.
  if (!mock) void realOldIgcl.isCapable();
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
  // M17c: the laptop-sysinfo ui-verify knob (RID_MOCK_LAPTOP=1) - the mock
  // sysinfo fixture gains the PORTABLE shape (the MSI Claw: 'Micro-Star
  // International Co., Ltd.' + a portable chassis) AND the backend's
  // laptopInfoOf provider serves it, so the caps AIB decode takes the
  // laptop branch end to end (the 'MSI (<model>)' Dashboard entry).
  const laptopFixture = process.env.RID_MOCK_LAPTOP === '1'
    ? { laptop: { manufacturer: 'Micro-Star International Co., Ltd.', model: 'Claw 8 AI+', pcSystemType: 2, chassisTypes: [10] } }
    : {};
  // M17d (Run B): the no-intel ui-verify variant with the vendor lane
  // (RID_MOCK_NO_INTEL=1 + RID_MOCK_VENDOR=nvml) - the sysinfo fixture's
  // REAL controller becomes the GTX 980-class shape: the NVIDIA part whose
  // PNP SUBSYS_36811458 decodes 'Gigabyte' through the aib table (the
  // no-Intel Board-partner row pin), whose vramBytes simulates the OS
  // VRAM source (4 GiB - the AdapterRAM/registry fallback) and whose
  // rebarActive simulates the RESOLVED OS verdict (the fixed two-line-
  // pnputil / PnPEntity cross-check output - the pre-fix sources left it
  // null). The vendor lane's fixture adapter (mock/vendor/nvml.json) then
  // feeds the live clocks + the deviceInfo() seam (the NVML total + cores).
  const noIntelVendorFixture = process.env.RID_MOCK_NO_INTEL === '1' && process.env.RID_MOCK_VENDOR === 'nvml'
    ? {
        noIntelController: {
          name: 'NVIDIA GeForce GTX 980',
          vramBytes: 4294967296, // 4 GiB (the OS AdapterRAM/registry value)
          pnpDeviceId: 'PCI\\VEN_10DE&DEV_13C2&SUBSYS_36811458&REV_A1',
          driverVersion: '31.0.15.6262',
          rebarActive: false, // the resolved OS verdict (ReBAR off - a pre-ReBAR part)
        },
      }
    : {};
  let rawBackend = null;
  if (mock) {
    sysinfo = createMockSysinfo({ ...laptopFixture, ...noIntelVendorFixture });
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
    // M17d (Run E): the CIM query is FIRED here but not awaited - the
    // profile's #1 stage (~3.1 s; a single PowerShell spawn with the
    // per-controller pnputil ReBAR sources) overlaps the pre-window
    // construction/init/seed span; the FIRST hard await sits in the
    // sysinfoResult helper below (the sysStats block), still before the
    // boot-apply gate and the window. The vramBytesOf/laptopInfoOf
    // providers read the mutable holder - a pre-landing enumeration (the
    // first listDevices at the waiver seed) sees plain names and the
    // helper re-enriches the cached devices IN PLACE (setVramBytesOf) as
    // soon as the query lands, so every post-window consumer (the
    // renderer's listDevices + caps + sysinfo:get) sees the enriched
    // names exactly as before.
    const sysinfoPromise = collectSysinfo({ timeoutMs: 10000 });
    let sysinfoLanded = false;
    const sysinfoResult = async () => {
      if (!sysinfoLanded) {
        const result = await sysinfoPromise;
        cached = result;
        sysinfoLanded = true;
        markProfileBoot('sysinfo');
        try {
          backend.setVramBytesOf((device) => vramBytesOfDevice(device, result));
        } catch {
          // the backend is not constructible/enumerable yet - the
          // constructor provider (reading the holder) covers it
        }
      }
      return cached;
    };
    // M19: the driver-BAR reader is the MEMOIZED-PROMISE seam (sysinfo.js
    // createDriverReBar) - the one-shot latch RACED: the main renderer
    // (app.ts:347) and the overlay (overlay.ts:372) fire sysinfo:get
    // CONCURRENTLY at boot, caller B saw the latch and returned the
    // STILL-NULL cache -> the dashboard ReBAR pill rendered gray for the
    // whole session. The seam shares ONE in-flight promise - both callers
    // await the SAME resolving verdict (green pill on the first landing);
    // a query failure still resolves null (the honest gray + the OS
    // fallback stays), cached for the session.
    // M19 (round-2 S1): the seam is DEFERRED to the first get() - the
    // backend binding is declared AFTER this block (TDZ: an eager seam
    // construction at this point evaluates the backend before its
    // declaration and throws on the real boot - the mock/headless paths
    // return before it, so every harness stayed green). get() is only
    // reachable once the whole boot body has run, so `backend` exists by
    // then; the null-guard creates the seam exactly once and its returned
    // reader memoizes its own in-flight promise (the M19 boot-race
    // semantics stay intact).
    let driverReBar = null;
    sysinfo = {
      get: async () => {
        const result = await sysinfoResult();
        if (driverReBar === null) driverReBar = createDriverReBar(rawBackend);
        const verdict = await driverReBar();
        return verdict === null ? result : applyDriverReBar(result, verdict);
      },
    };
  }
  let backend = createBackend({
    kind: mock ? 'mock' : 'igcl',
    igcl: realOldIgcl
      ? {
          extended: {
            isCapable: () => realOldIgcl.isCapable(),
            // M33: the main UI is unelevated; the elevated apply worker owns
            // the actual init/waiver/write probe.
            isAvailable: () => realOldIgcl.isAvailable(),
          },
          // M4J (A): pass the CACHED CIM data (with .videoControllers) - the
          // pre-fix adapter passed `sysinfo` (the lazy .get() wrapper), so
          // the lookup ALWAYS returned null on the real path and the A770
          // never gained its "8GB GDDR6" suffix.
          vramBytesOf: (device) => vramBytesOfDevice(device, cached),
          // M17c: the laptop sysinfo provider - the CACHED CIM laptop
          // fields (Win32_ComputerSystem Manufacturer/Model/PCSystemType +
          // Win32_SystemEnclosure ChassisTypes), the vramBytesOf injection
          // pattern; the caps AIB decode's laptop branch consumes them
          // lazily ONCE (a desktop's non-portable shape -> the subsystem
          // decode stays authoritative).
          laptopInfoOf: () => (cached && cached.laptop ? cached.laptop : null),
        }
      : {},
    // M17c: the mock mirrors the laptop provider shape (the mock caps
    // decode's laptop branch; the mock fixture's laptop field rides the
    // caps through the constructor opt in tests / the Run-B verify knob -
    // RID_MOCK_LAPTOP=1 serves the portable fixture to BOTH the sysinfo
    // payload and the caps AIB decode).
    mock: { ...mockOpts, laptopInfoOf: () => (cached && cached.laptop ? cached.laptop : (Object.keys(laptopFixture).length > 0 ? laptopFixture.laptop : null)) },
  });
  rawBackend = backend;
  // M30: all later consumers use the same Windows/IGCL inventory.  The
  // wrapper is intentionally installed before oldIgcl, boot/profile/tray,
  // IPC, and sysman closures are created so no path can bypass its target
  // resolution or accidentally apply an OS-only adapter.
  backend = createUnifiedGpuBackend({ backend, sysinfo });
  // M2C-C: the bundled 2023 IGCL runtime adapter (extended-range writes).
  // Mock mode (incl. --ui-verify) uses the mock adapter - the real DLL is
  // never loaded there. In the real path the OLD runtime is probed lazily
  // (isCapable runs on the first extended write or caps query) and both
  // runtimes can coexist in one process (probe-verified, §8c). S1: the real
  // adapter is constructed BEFORE the backend so the backend's extended
  // probe (above) can consult it - the extended ranges are wired into
  // getCapabilities on hardware, never dead code.
  const oldIgcl = mock ? createMockOldIgcl(backend) : realOldIgcl;
  // M17f/M17i: the sysman power-limits source - the PL2 companion + the
  // 'power-limits:read' channel. M17i: the REAL path is the HELPER PROXY -
  // the consumer runs in the dedicated IGCL-free `--sysman-helper` process
  // (this window process carries the IGCL backend + OldIgcl - the measured
  // zesInit poison combo; the raw consumer would degrade to the honest
  // null + the '-' read-out here). Constructed ONCE per process and shared
  // by the window-path boot apply, the tray apply, the IPC apply + the
  // 'power-limits:read' source. The MOCK seam is UNCHANGED: the mock
  // consumer answers the fixture limits through the backend (the applied
  // powerLimitW for both domains - the deterministic ui-verify read-out)
  // and never touches the DLL. M17g: RID_MOCK_NO_SYSMAN=1 knocks the mock
  // seam OUT entirely (sysmanPowerLimits null) - the ui-verify variant
  // pins the honest '-' read-out + the envelope-fed '(set)' render on the
  // power-limit card.
  const sysmanPowerLimits = mock
    ? (process.env.RID_MOCK_NO_SYSMAN === '1' ? null : createMockSysmanPowerLimits({ backend }))
    : realSysmanLimits;
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
        // M17d (Run D): forward the ocMode too - executeApply threads it
        // into splitByRuntime (the V1-call pin: the mode-based W/C routing).
        apply: async ({ deviceId, deviceKey, physicalTarget, settings, ocMode, profileApply }) => { await backend.assertDeviceTarget?.(deviceId, deviceKey, physicalTarget); return executeApply({ backend, oldIgcl, deviceId, deviceKey, physicalTarget, settings, opts: { profileApply }, ocMode, sysmanPowerLimits }); },
        waiverAccept: async (deviceId, deviceKey, physicalTarget) => { await backend.assertDeviceTarget?.(deviceId, deviceKey, physicalTarget); await backend.setWaiverAccepted(deviceId); },
        reset: async (deviceId, deviceKey, physicalTarget) => {
          await backend.assertDeviceTarget?.(deviceId, deviceKey, physicalTarget);
          await backend.resetToDefaults(deviceId);
          const state = await backend.getCurrentSettings(deviceId);
          return { state };
        },
        // M8 (the Graphics tab): the in-process graphics executor - the
        // DEDICATED apply path (no OC waiver, no OC-mode gate). Returns the
        // { ok, perControl, graphicsState } envelope with the FRESH read-back.
        graphicsApply: async ({ deviceId, deviceKey, physicalTarget, settings }) => {
          await backend.assertDeviceTarget?.(deviceId, deviceKey, physicalTarget);
          const out = await backend.setGraphicsSettings(deviceId, settings);
          let graphicsState = null;
          try { graphicsState = await backend.getGraphicsSettings(deviceId); } catch { /* degraded */ }
          return { ok: out.ok, perControl: out.perControl, graphicsState };
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
      // M17f: the fake worker carries the sysman companion too (the real
      // elevated worker wires it - the mock mirrors the apply core).
      apply: async ({ deviceId, deviceKey, physicalTarget, settings, ocMode, profileApply }) => { await backend.assertDeviceTarget?.(deviceId, deviceKey, physicalTarget); return executeApply({ backend, oldIgcl, deviceId, deviceKey, physicalTarget, settings, opts: { profileApply }, ocMode, sysmanPowerLimits }); },
      waiverAccept: async (deviceId, deviceKey, physicalTarget) => { await backend.assertDeviceTarget?.(deviceId, deviceKey, physicalTarget); await backend.setWaiverAccepted(deviceId); },
      reset: async (deviceId, deviceKey, physicalTarget) => {
        await backend.assertDeviceTarget?.(deviceId, deviceKey, physicalTarget);
        await backend.resetToDefaults(deviceId);
        return { ok: true, state: await backend.getCurrentSettings(deviceId) };
      },
      // M8: the fake runner's graphics path (in-process - never spawns).
      graphicsApply: async ({ deviceId, deviceKey, physicalTarget, settings }) => {
        await backend.assertDeviceTarget?.(deviceId, deviceKey, physicalTarget);
        const out = await backend.setGraphicsSettings(deviceId, settings);
        let graphicsState = null;
        try { graphicsState = await backend.getGraphicsSettings(deviceId); } catch { /* degraded */ }
        return { ok: out.ok, perControl: out.perControl, graphicsState };
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
    // M30: mock sessions are independent verification runs. Always start on
    // the first writable inventory row (or the first synthetic OS row when
    // no writable adapter exists) so a previous multi-GPU run's persisted
    // iGPU selection cannot suppress the boot waiver or change the surface
    // under test. Real-product durable selection remains untouched.
    try {
      const devices = await backend.listDevices();
      const preferred = devices.find((device) => device.synthetic !== true && device.backendKind !== 'os')
        ?? devices[0]
        ?? null;
      const cur = await store.loadSettings();
      await store.saveSettings({
        ...cur,
        deviceId: preferred?.id ?? null,
        deviceKey: preferred?.deviceKey ?? null,
      });
    } catch (err) {
      console.log(`[boot] mock device-selection seed skipped: ${err.message}`);
    }
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
    // M24: the overlay THEME is seeded DETERMINISTICALLY the same way -
    // every non-overlay session resets overlayTheme to the PRODUCT default
    // 'arc' (the m24-theme-default pin asserts it on the fresh store; the
    // RID_MOCK_OVERLAY seed block BELOW then overrides to 'classic' when
    // its knob is on, so the overlay variant still boots classic).
    try {
      const cur = await store.loadSettings();
      await store.saveSettings({
        ...cur,
        theme: process.env.RID_MOCK_THEME === 'light' ? 'light' : 'dark',
        overlayTheme: 'arc',
      });
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
    // M17g: the stats reset to the DEFAULT set now (the user's 11 ON / the
    // others OFF - the M6 full-set default FLIPS; the overlay variant's
    // boot pins + the round trips are deterministic against it).
    // M7b: the background box resets the same way (the new pins toggle it
    // mid-run - a crashed run must never bleed a visible box / non-black
    // color / non-0.5 opacity into the next overlay variant).
    // M24: the overlay THEME resets the same way - the overlay variant is
    // CLASSIC-seeded (the M5-M17g backdrop pins assert the .visible/var/
    // display mechanics that arc's always-visible backdrop would break);
    // the PRODUCT default stays 'arc' (the non-overlay variants never
    // touch the theme).
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
        overlayStats: overlayOn ? OVERLAY_STATS_DEFAULT : cur.overlayStats,
        overlayBgEnabled: overlayOn ? false : cur.overlayBgEnabled,
        overlayBgColor: overlayOn ? '#000000' : cur.overlayBgColor,
        overlayBgOpacity: overlayOn ? 0.5 : cur.overlayBgOpacity,
        overlayTheme: overlayOn ? 'classic' : cur.overlayTheme,
      });
    } catch (err) {
      console.log(`[boot] overlay session seed skipped: ${err.message}`);
    }
    // M23 (Part B): RID_MOCK_ADV_OVERLAY=1 seeds advancedOverlayEnabled:true
    // into the isolated mock store - the advanced-overlay variant boots with
    // the panel SHOWN (the HUD-overlay parity - the same deterministic
    // session-seed pattern; a leaked 'false' from an interrupted run must
    // never hide the panel for the next variant). The OTHER advanced fields
    // reset to their defaults under the knob too (letter 'P' / right) - a
    // crashed run that left another letter/edge must never bleed into the
    // next advanced-overlay run (the variant's pins are deterministic).
    // The HUD overlay fields are ALSO reset under the knob (the two overlay
    // variants may share the isolated dir - the advanced pins must not see a
    // leaked HUD letter 'P' that would collide with the advanced defaults).
    try {
      const cur = await store.loadSettings();
      const advOn = process.env.RID_MOCK_ADV_OVERLAY === '1';
      const hudOn = process.env.RID_MOCK_OVERLAY === '1';
      await store.saveSettings({
        ...cur,
        overlayEnabled: hudOn,
        overlayHotkeyLetter: 'O',
        advancedOverlayEnabled: advOn,
        advancedOverlayHotkeyLetter: advOn ? 'P' : cur.advancedOverlayHotkeyLetter,
        advancedOverlayPosition: advOn ? 'right' : cur.advancedOverlayPosition,
      });
    } catch (err) {
      console.log(`[boot] advanced-overlay session seed skipped: ${err.message}`);
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
    // M16-F1 (D2): RID_MOCK_TRAY_APPLY=1 seeds the SAME probe profile (the
    // in-range 230 W values) WITHOUT ocOnBoot - the active profile exists
    // for the tray "Apply active profile" click, and the boot NEVER
    // auto-applies (the tray-apply ui-verify pin drives the recorded tray
    // handler itself and asserts the renderer state push flips the OC row).
    try {
      const cur = await store.loadSettings();
      const bootApplyOn = process.env.RID_MOCK_BOOT_APPLY === '1';
      const bootApplyExtOn = process.env.RID_MOCK_BOOT_APPLY_EXT === '1';
      const trayApplyOn = process.env.RID_MOCK_TRAY_APPLY === '1';
      const seedOn = bootApplyOn || bootApplyExtOn || trayApplyOn;
      await store.saveSettings({
        ...cur,
        ocOnBoot: bootApplyOn || bootApplyExtOn,
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
    markProfileBoot('backend-init');
    try {
      await seedWaiverState(backend, store);
    } catch (err) {
      console.log(`[boot] waiver flag pre-seed skipped: ${err.message}`);
    }
    markProfileBoot('seed-waiver');
    // M4-B (fix): boot-time driver-truth probe - the persisted
    // acceptance can be STALE (the driver lost the waiver while settings.json
    // still says accepted - the report: "the popup said already
    // accepted, then voltage changes threw a no-accepted-waiver error").
    // Only when ELEVATED (the packaged EXE always is): a value-neutral write
    // of the current power limit surfaces waiver-not-set when the driver
    // lost it; probeWaiverState then clears the stale flag + store so the
    // boot prompt shows the REAL state and applies work first-try. Never in
    // non-elevated dev (a probe write there would raise a UAC prompt).
    // M17d (Run E): the probe is gated to the FIRST boot per driver version
    // (waiverProbeDue) - a driver round trip that exists for
    // driver-version-bound waiver losses (reinstall / IGS reset) is
    // redundant on every later boot of the SAME version; the gate key is
    // persisted only AFTER a successful probe (a failure re-probes next
    // boot - the safe side).
    if (isElevated()) {
      try {
        const verdict = await waiverProbeDue(backend, store);
        if (verdict.due) {
          await probeWaiverState(backend, store);
          if (verdict.key !== null) {
            const s = await store.loadSettings();
            await store.saveSettings({ ...s, waiverProbedDriverVersion: verdict.key });
          }
        }
      } catch (err) {
        console.log(`[boot] waiver truth probe skipped: ${err.message}`);
      }
    }
    markProfileBoot('probe-waiver');
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
  markProfileBoot('seed-oc-mode');
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
  markProfileBoot('adapters');
  // FPS adapter (M4-D2): DXGI GetFrameStatistics - unelevated, system-wide,
  // no service. Mock mode reports unavailable (never loads dxgi.dll/koffi),
  // counts polls so --ui-verify can assert the Monitoring page stops
  // polling on navigation away (M2b review F4), and returns a FIXED sample
  // ONLY under RID_MOCK_FPS=1 (the new pin). M7a: the fixed sample carries
  // the percentile stats (52 / 58 - the ui-verify FPS-row pins).
  // M12: the fixed sample also carries avgFps 58 + low01Pct 42 (the new
  // percentile fields - the ui-verify AVG / 0.1% Low pins); the
  // frameTimeMs 16.7 passthrough + the gpuBusy 0.6 MUST stay - the
  // frametime-canvas + the '16.7 ms' value-line pins depend on them (N7).
  // M10a: RID_MOCK_API=1 rides the SAME inline sample (api 'dx12' - the
  // fixture) - the knobs travel together (RID_MOCK_API without
  // RID_MOCK_FPS=1 produces nothing, because the poll returns null).
  let fpsPolls = 0;
  const fpsAdapter = mock
    ? {
        poll: async () => {
          fpsPolls += 1;
          if (process.env.RID_MOCK_FPS === '1') {
            const sample = { fps: 60, avgFps: 58, frameTimeMs: 16.7, gpuBusy: 0.6, low1Pct: 52, low01Pct: 42, p99: 58 };
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
  // M12/M14: the RAM detector (GlobalMemoryStatusEx -> the USED RAM in
  // bytes - total - avail - the Memory row's source). THE DETERMINISM
  // SEAM (the foregroundApi pattern): the REAL koffi detector runs ONLY
  // in the non-mock path - mock/ui-verify mode leaves the null-returning
  // DEFAULT in place and the sysStats fixture's memoryUsedBytes
  // 12400000000 wins (the fixture-wins composition, pinned by the
  // 'RAM 12.4 GB' ui-verify pin).
  const memoryUtil = mock ? undefined : createMemoryUtilDetector();
  // M4-D2: the system-stats adapter (CPU util/freq/temp + GPU memory used).
  // M17p: the sysStats MUTABLE HOLDER - the sysStats block (the CIM
  // query's first hard await) now lands AFTER registerIpc (the window +
  // the IPC surface exist first; the block still awaits the SAME in-flight
  // sysinfoPromise, so its absolute landing time is unchanged). registerIpc
  // receives the HOLDER (a by-value capture would freeze null - the block
  // runs after registration); createIpcHandlers unwraps it per-access via
  // its ONE normalize line, so the telemetry consumption sites see the
  // adapter assigned after registration. The declarations + the
  // before-quit teardown stay here. Mock: fixed deterministic values.
  // Real: the rolling-delta CIM adapter; its GPU-memory match needs
  // the backend device's LUID - the IGCL bindings expose none, so the DXGI
  // display-enumeration link resolves it (GetDesc1: DeviceId -> LUID),
  // matched against the backend's OWN enumerated PCI id (the exact
  // monitored device - the pre-M17d source was the CIM controller list's
  // first pnpDeviceId, which could name a different adapter on multi-GPU
  // boxes). Unmatched -> null (honest '-').
  const sysStatsHolder = { current: null };
  let msrReader = null;
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
    // M23 CHANGE 3 (Part A): the window path's full close reaps the
    // sysman helper - BOUNDED + FIRE-AND-FORGET, never blocks quit (the
    // window-close teardown normally flushes the small write; the helper-
    // side idle backstop covers a dropped op). Unconditional: this
    // session's proxy kills the machine-level helper even if a prior
    // session spawned it (there is only ONE helper - EADDRINUSE dedupes;
    // the user wants NO 'Arc Power Helper' tasks after full close).
    // M17o2's live proof (a FRESH process's ze init ALWAYS lands, 5/5)
    // makes the reap safe - the next session's warm() respawns a fresh
    // helper.
    void realSysmanLimits?.shutdown?.().catch(() => {});
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
    // M17f/M17i/M17k: the logon apply is ELEVATED (the /rl highest task) -
    // the sysman companion runs there too. M17i: the REAL companion
    // DELEGATES to the IGCL-free helper through the proxy (this process
    // carries the IGCL backend - the measured zesInit poison combo). M17k:
    // the branch REUSES the window path's WARMED shared proxy
    // (sysmanPowerLimits - constructed + warmed above, before the backend
    // block) - the duplicate construction is DELETED and the flow rides the
    // warm helper, whose init landed before this branch's waiver-truth
    // probe write (the apply-profile's PL2 landing is ACTUALLY fixed, not
    // just warmed). The branch's MOCK flow now honors RID_MOCK_NO_SYSMAN
    // too (the shared mock branch's knob - a behavior change, recorded +
    // pinned).
    await runApplyOnStartup({
      backend,
      store,
      profileId: applyProfileId,
      deviceId: applyDeviceId,
      oldIgcl: bootOldIgcl,
      sysmanPowerLimits,
      setupTray: () => setupTray({ getWindow: () => null, backend, store, oldIgcl: bootOldIgcl, applyRunner: null, sysmanPowerLimits }),
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
    // M16-F1 (D2): the "Apply active profile" click handler - the
    // tray-apply ui-verify pin drives it (main-side apply -> pushed
    // device:state-updated -> the dashboard OC row flips in place).
    applyHandler: null,
    // M17e: the DOUBLE-CLICK handler - setupTray registers it via
    // tray.on('double-click') (the REAL Tray's event); the probe's .on
    // records it so the verify pin can assert the wiring + fire it.
    doubleClickHandler: null,
    probe: {
      setContextMenu: () => {},
      setToolTip: () => {},
      displayBalloon: () => {},
      isDestroyed: () => false,
      on: (event, handler) => {
        if (event === 'double-click') trayProbe.doubleClickHandler = typeof handler === 'function' ? handler : null;
      },
    },
  };
  const createTrayProbe = ({ template }) => {
    trayProbe.builds += 1;
    const toggle = template.find((i) => i.label === TRAY_LABEL_TOGGLE);
    trayProbe.toggleHandler = toggle && typeof toggle.click === 'function' ? toggle.click : null;
    const apply = template.find((i) => i.label === TRAY_LABEL_APPLY_PROFILE);
    trayProbe.applyHandler = apply && typeof apply.click === 'function' ? apply.click : null;
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
    // M17i: the window path's ONE proxy (constructed above) - the tray
    // "Apply active profile" lands PL2 through the IGCL-free helper too.
    sysmanPowerLimits,
    createTrayImpl: uiVerify ? createTrayProbe : createTray,
  });
  markProfileBoot('tray');

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
  // boot fetch reads it ('boot-apply-outcome'). M16: the dashboard OC
  // Status row NO LONGER displays this record - the row derives its
  // stock-state verdict from the LIVE driver read-back (the post-apply
  // state the boot fetch also receives), so this record is kept for the
  // boot fetch contract + the boot-apply ui-verify pins, not for the row's
  // text. Null when no boot apply ran this session. The mock-only
  // mock:run-boot-apply channel does NOT update this record (documented
  // decision: the mid-session probe leaves the OC row as the boot outcome -
  // the record is the window-path apply's own).
  let bootApplyOutcome = null;
  // M4-F (§4 boot resolution): a matching durable key selects its device.
  // Legacy numeric-only settings remain read-only/self-healed to the
  // preferred row, but a disappeared persisted key returns null so the
  // regular boot profile path reaches stale-target refusal rather than
  // silently writing another GPU.
  let bootDeviceId = null;
  try {
    bootDeviceId = await resolveBootDeviceId(backend, store);
  } catch (err) {
    console.log(`[boot] deviceId resolution skipped: ${err.message}`);
  }
  markProfileBoot('device-resolve');
  try {
    const bootSettings = await store.loadSettings();
    if (bootSettings.ocOnBoot === true && bootSettings.activeProfileId) {
      const out = await applyProfileBoot({
        backend,
        store,
        profileId: bootSettings.activeProfileId,
        deviceId: bootDeviceId,
        oldIgcl,
        // M17i: the window-path boot apply is an in-process electron+IGCL
        // apply of the acceptance-1 class - the sysman companion delegates
        // to the IGCL-free helper through the window path's proxy (the
        // mock seam in mock mode; null under RID_MOCK_NO_SYSMAN).
        sysmanPowerLimits,
        log: (s) => console.log(s),
      });
      if (mock) recordBootApply(bootSettings.activeProfileId, out);
      // M4N (A.1): record the outcome for the renderer's boot fetch. The
      // success detail = "Profile '<name>' applied" with the name resolved
      // like the balloon (the same loadProfiles lookup); a failure carries
      // the apply's reason. A THROWN apply records too (the catch below).
      // M16: the dashboard OC row no longer displays this record (it shows
      // the STOCK-STATE verdict from the driver read-back) - the record is
      // kept for the boot fetch contract + the boot-apply ui-verify pins.
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
    // M4N (A.1): a THROWN apply records the failure. M16: the OC row's
    // stock-state verdict derives from the driver read-back, never from
    // this record - it is kept for the boot fetch + the verify pins.
    bootApplyOutcome = { ok: false, at: Date.now(), detail: `Profile apply failed: ${err.message}` };
  }
  markProfileBoot('boot-apply-gate');

  const win = createWindow(windowBackground, !startMinimizedAtBoot);
  stealthVerifyWindow(win);
  windowForInstance = win;
  markProfileBoot('window');
  // M17d (Run E): the profile window run exits by itself - after the
  // renderer's boot-complete mark lands, dwell briefly (the trailing main
  // marks - bootBackend/health - run concurrently with the renderer boot)
  // and exit 0. A 60 s fallback keeps a renderer-load failure from hanging
  // the measurement. Mock/ui-verify never auto-exit (their own flows own
  // the session).
  if (profileBoot && !mock && !uiVerify) {
    let exited = false;
    const exitProfileRun = () => {
      if (exited) return;
      exited = true;
      markProfileBoot('profile-exit');
      app.exit(0);
    };
    win.webContents.on('console-message', (event) => {
      const message = typeof event.message === 'string' ? event.message : '';
      if (message.includes('renderer:boot-complete')) setTimeout(exitProfileRun, 1000);
    });
    setTimeout(exitProfileRun, 60000);
  }
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
    // M23 (Part B): the ADVANCED overlay rides the SAME lifecycle rule - the
    // main window's close destroys the panel + unregisters its hotkey (the
    // panel NEVER keeps the app alive by itself). The handle is NULLED (not
    // just destroyed) - an onAdvancedOverlaySettings reaction in flight at
    // the close instant must not re-create the panel via apply()
    // (step-5 N2: the `if (!advancedOverlayHandle) return` guards make the
    // reaction a no-op after the null).
    advancedOverlayHandle?.destroy();
    advancedOverlayHandle = null;
    unregisterAdvancedOverlayHotkey();
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
      // M35: the selected overlay GPU identities ride the same settings
      // envelope so the renderer can restart only the requested telemetry
      // lanes without changing the main window's device selection.
      deviceKeys: Array.isArray(settings.overlayDeviceKeys)
        ? settings.overlayDeviceKeys
        : null,
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
      // M17b: the chip-name row labels - forwarded like the background box
      // (a required-but-insufficient owner set would silently ship a dead
      // feature; the overlay.js normalize is the final gate for garbage).
      overlayChipNames: settings.overlayChipNames === true,
      // M17e: the overlay polling-rate - forwarded like the rest (the
      // payload carries it so the ui-verify pins + the overlay renderer
      // know the cadence; ipc-core's startTelemetry + the live restart are
      // the cadence owners; garbage degrades to the 400 ms default - M17g:
      // the stock polling rate FLIPS 500 -> 400).
      overlayPollMs: typeof settings.overlayPollMs === 'number'
        && Number.isFinite(settings.overlayPollMs)
        ? Math.min(2000, Math.max(100, Math.round(settings.overlayPollMs)))
        : 400,
      // M24: the overlay THEME - forwarded like the rest (the payload
      // shortens to 'theme'; the renderer applies it from the push -
      // dataset.overlayTheme + the arc canvas gradient). Garbage degrades
      // to the 'arc' product default (the overlay.js normalize is the
      // final gate).
      theme: OVERLAY_THEMES.includes(settings.overlayTheme)
        ? settings.overlayTheme
        : OVERLAY_THEME_DEFAULT,
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
    // M23: the harness must not flash the HUD overlay on the user's screen.
    stealthVerifyWindow(overlayHandle.getWindow?.() ?? null);
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

  // --- M23 (Part B): the ADVANCED overlay (the AMD-Adrenaline-style        ---
  // interactive side panel - CONTROL + <letter>, stock P). Created
  // UNCONDITIONALLY on the product window path (HIDDEN when
  // advancedOverlayEnabled is false - apply() shows it when the user enables
  // it through the Overlay view; a lazy create would break the enable path).
  // NEVER in headless/boot-apply/apply-profile (they return earlier);
  // ui-verify creates it only under RID_MOCK_ADV_OVERLAY=1 (the variant's
  // real-window pins). M7b (fix-5 semantics): the hotkey/shortcut NEVER
  // shows the panel while the master advancedOverlayEnabled is OFF - the
  // gate lives in advanced-overlay.js toggle().
  let advancedOverlayHandle = null;
  let advancedOverlayHotkeyAccelerator = null;
  // The SECOND hotkey seam (the registerOverlayHotkey mirror): product path -
  // a REAL globalShortcut registration ('Control+<letter>' - CTRL fixed,
  // only the letter is user-changeable), unregistered on will-quit + window
  // closed + a letter change. ui-verify injects a COUNTING probe that NEVER
  // registers (a real system hotkey mid-verify would disrupt the session) +
  // a mid-run settable failure fake (the register-failure honesty pin).
  // register() returning false (the accelerator taken by another app / the
  // COLLIDING HUD letter - the renderer refuses the same-letter save with a
  // toast, but the seam still handles a failed register honestly) surfaces
  // hotkeyRegistered:false - the Overlay view then shows the honest note.
  const advancedOverlayHotkeyProbe = { registrations: [], failRegister: false };
  const registerAdvancedOverlayHotkey = (letter) => {
    if (!advancedOverlayHandle) return;
    const normalized = typeof letter === 'string' && /^[A-Za-z]$/.test(letter) ? letter.toUpperCase() : 'P';
    const accel = `Control+${normalized}`;
    if (uiVerify) {
      advancedOverlayHotkeyProbe.registrations.push(accel);
      advancedOverlayHandle.setHotkeyRegistered(!advancedOverlayHotkeyProbe.failRegister);
      return;
    }
    if (advancedOverlayHotkeyAccelerator) {
      try { globalShortcut.unregister(advancedOverlayHotkeyAccelerator); } catch { /* best effort */ }
      advancedOverlayHotkeyAccelerator = null;
    }
    let ok = false;
    try {
      ok = globalShortcut.register(accel, () => { void advancedOverlayHandle.toggle(); });
    } catch {
      ok = false;
    }
    advancedOverlayHotkeyAccelerator = ok ? accel : null;
    advancedOverlayHandle.setHotkeyRegistered(ok);
    if (!ok) {
      console.log(`[advanced-overlay] hotkey ${accel} registration failed (taken by another application?)`);
    }
  };
  const unregisterAdvancedOverlayHotkey = () => {
    if (advancedOverlayHotkeyAccelerator) {
      try { globalShortcut.unregister(advancedOverlayHotkeyAccelerator); } catch { /* best effort */ }
      advancedOverlayHotkeyAccelerator = null;
    }
    advancedOverlayHandle?.setHotkeyRegistered(false);
  };
  // The advanced-overlay settings reaction (the onOverlaySettings pattern):
  // re-apply the geometry/visibility from the FRESH store + re-register the
  // hotkey on a letter change. 'advanced-overlay:settings' is NOT an
  // ipc-core push - the advanced-overlay module sends it DIRECTLY to the
  // panel window (webContents.send).
  const onAdvancedOverlaySettings = async (patch) => {
    if (!advancedOverlayHandle) return;
    applyAdvancedOverlaySettings();
    if (patch && typeof patch.advancedOverlayHotkeyLetter === 'string') {
      registerAdvancedOverlayHotkey(patch.advancedOverlayHotkeyLetter);
    }
  };
  const applyAdvancedOverlaySettings = () => {
    if (!advancedOverlayHandle) return;
    let settings = {};
    try {
      settings = store.loadSettingsSync() ?? {};
    } catch {
      settings = {};
    }
    advancedOverlayHandle.apply({
      enabled: settings.advancedOverlayEnabled === true,
      position: settings.advancedOverlayPosition === 'left' || settings.advancedOverlayPosition === 'right'
        ? settings.advancedOverlayPosition
        : 'right',
      hotkeyLetter: typeof settings.advancedOverlayHotkeyLetter === 'string'
        && /^[A-Za-z]$/.test(settings.advancedOverlayHotkeyLetter)
        ? settings.advancedOverlayHotkeyLetter
        : 'P',
    });
  };
  // The dedicated panel-close op (the 'advanced-overlay:close' channel's
  // handler): a SESSION hide - the panel's own close button never closes the
  // main window and never touches the persisted master.
  const advancedOverlayClose = async () => {
    if (advancedOverlayHandle) await advancedOverlayHandle.closePanel();
  };
  if (uiVerify ? process.env.RID_MOCK_ADV_OVERLAY === '1' : true) {
    advancedOverlayHandle = createAdvancedOverlayWindow({
      // The CURRENT persisted settings - the sync cache (like the HUD).
      getOverlaySettings: () => {
        try {
          return store.loadSettingsSync() ?? {};
        } catch {
          return {};
        }
      },
      // The panel's custom close is a SESSION hide performed inside the
      // module (step-4 S1: closePanel hides the window directly - the
      // earlier injected-op design left the X a dead no-op); the
      // 'advanced-overlay:close' channel routes here.
    });
    // M23: the harness must not flash the advanced panel on the user's screen.
    stealthVerifyWindow(advancedOverlayHandle.getWindow?.() ?? null);
    applyAdvancedOverlaySettings();
    // Boot the hotkey with the persisted letter (default 'P').
    let bootLetter = 'P';
    try {
      const s = store.loadSettingsSync() ?? {};
      if (typeof s.advancedOverlayHotkeyLetter === 'string' && /^[A-Za-z]$/.test(s.advancedOverlayHotkeyLetter)) {
        bootLetter = s.advancedOverlayHotkeyLetter;
      }
    } catch { /* default P */ }
    // M23 (step-5 N1): the upgrade-path collision reconcile. A PRE-M23
    // persisted HUD letter 'P' + the new advanced default 'P' would
    // register TWO same-app Control+P accelerators back to back - same-app
    // register REPLACES and returns true, so one hotkey dies silently with
    // hotkeyRegistered still true on both cards (the honest note could not
    // detect it). At BOOT only: when the persisted letters collide, SKIP the
    // advanced registration and surface hotkeyRegistered:false - the
    // Advanced card then shows the honest "could not be registered" note
    // (accurate: the HUD holds the key) and the user picks a letter. The
    // persisted state is NEVER silently changed. The renderer's symmetric
    // envelope rejection keeps any FUTURE same-letter save from landing.
    let hudBootLetter = 'O';
    try {
      const s = store.loadSettingsSync() ?? {};
      if (typeof s.overlayHotkeyLetter === 'string' && /^[A-Za-z]$/.test(s.overlayHotkeyLetter)) {
        hudBootLetter = s.overlayHotkeyLetter.toUpperCase();
      }
    } catch { /* default O */ }
    if (bootLetter.toUpperCase() === hudBootLetter) {
      console.log(`[advanced-overlay] boot hotkey ${bootLetter.toUpperCase()} collides with the HUD letter - the advanced registration is SKIPPED (the honest note shows; the user picks another letter)`);
      advancedOverlayHandle.setHotkeyRegistered(false);
    } else {
      registerAdvancedOverlayHotkey(bootLetter);
    }
  }
  app.on('will-quit', () => {
    advancedOverlayHandle?.destroy();
    unregisterAdvancedOverlayHotkey();
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
      sysmanPowerLimits,
      log: (s) => console.log(`[mock-boot-apply] ${s}`),
    });
    recordBootApply(settings.activeProfileId, out);
    return { ...out, log: mockBootApplyLog.slice() };
  };
  const mockCtl = mock
    ? {
        listFeaturesets: () => backend.listFeaturesets(),
        setFeatureset: async (id) => {
          // M30: the proxy fallback invokes the raw MockBackend with its
          // receiver, so this first response keeps the feature metadata and
          // health while the device payload is normalized below.
          const response = await backend.setFeatureset(id);
          const unifiedDevices = await backend.listDevices();
          if (!Array.isArray(unifiedDevices) || unifiedDevices.length === 0) {
            return response;
          }

          // The raw mock and the unified inventory normalize PCI ids
          // differently (zero-padded vs canonical). Keep the durable-key
          // match first, then bridge the response's raw session id to the
          // unified backendId before falling back to the first writable row.
          const responseActive = Array.isArray(response?.devices)
            ? response.devices.find((device) => device.deviceKey === response?.activeDeviceKey)
            : null;
          const active = unifiedDevices.find((device) => device.deviceKey === response?.activeDeviceKey)
            ?? (Number.isInteger(responseActive?.id)
              ? unifiedDevices.find((device) => device.backendId === responseActive.id)
              : null)
            ?? unifiedDevices.find((device) => device.synthetic !== true
              && device.backendKind !== 'os'
              && Number.isInteger(device.backendId))
              ?? unifiedDevices[0];
          const devices = unifiedDevices.filter((device) => !device.synthetic || device.deviceKey === active.deviceKey);

          return {
            ...response,
            devices,
            activeDeviceKey: active.deviceKey,
            caps: await backend.getCapabilities(active.id),
            state: await backend.getCurrentSettings(active.id),
          };
        },
        runBootApply: runMockBootApply,
        bootApplyLog: async () => mockBootApplyLog.slice(),
      }
    : null;
  // M17c/M17d: the ETW/PresentMon FPS lane - the PREFERRED FPS source in
  // the product path (the game's per-frame present rate via the dxgkrnl
  // ETW stream; the packaged app runs elevated, which ETW realtime sessions
  // require - the dev run degrades to the DXGI fallback honestly). THE
  // DETERMINISM SEAM (the foregroundApi pattern): the lane exists ONLY in
  // the non-mock path - mock/ui-verify never spawn the sidecar or probe
  // the foreground. M17d (Run C): the lane consumes the SOURCE CHAIN - the
  // PresentMon SERVICE source (the IGS-class DISPLAYED_FPS when the driver
  // ships the service: pmOpenSession + pmStartTrackingProcess + the
  // DISPLAYED_FPS/PRESENT_RUNTIME dynamic query - the plan's primary lane;
  // on this dev box the probe finds NO SCM service - the IGS spawns its
  // middleware as a child - so the pm source stays idle) + the M17c
  // vendored console-exe sidecar (the display-cadence columns); the chain
  // orders pm data first, the sidecar second, and the fps-poll falls back
  // to the DXGI desktop-rate tier when both are idle. The lane is LAZY:
  // the sidecar spawns / the pm probe runs on the first fps-poll (no
  // capture before anything asks for FPS); the retarget check runs per
  // poll (getForegroundWindow + GetWindowThreadProcessId - the cheap
  // foreground-api probe ops). ownPids = the main process + the windows'
  // renderer processes - the lane never measures the app itself (the
  // foreground over Arc Power keeps the last game target instead).
  let presentMonLane = null;
  if (!mock) {
    presentMonLane = createPresentMonLane({
      source: createPresentMonSourceChain({
        pmSource: createPmFpsSource({}),
        sidecarSource: createPresentMonFpsSource({}),
      }),
      resolveForegroundPid: async () => await foregroundApi.detectPid(),
      isOwnPid: async (pid) => {
        const own = new Set([process.pid]);
        for (const w of [win, overlayHandle?.getWindow?.()]) {
          if (w && !w.isDestroyed()) {
            try { own.add(w.webContents.getOSProcessId()); } catch { /* best effort */ }
          }
        }
        return own.has(pid);
      },
    });
  }
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
    // M23 (Part B): the ADVANCED overlay window - the telemetry push's THIRD
    // consumer (the panel's live clock/temp/fan/power readout strip rides
    // the same sample stream; null when no panel exists - the emit
    // null-guards it).
    getAdvancedOverlayWindow: () => (advancedOverlayHandle ? advancedOverlayHandle.getWindow() : null),
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
    // M23 (Part B): the injected ADVANCED-overlay ops - the REAL panel
    // handle in both the product path and the RID_MOCK_ADV_OVERLAY=1
    // ui-verify variant (the variant's panel window is real, like the main
    // window - the toggle really flips it). When no panel exists (other
    // ui-verify variants) the DEFAULT no-window ops keep the channels honest.
    advancedOverlayOps: advancedOverlayHandle
      ? {
          getState: async () => advancedOverlayHandle.getState(),
          toggle: async () => { await advancedOverlayHandle.toggle(); },
        }
      : undefined,
    // M23 (Part B): the panel's custom close op (the dedicated
    // 'advanced-overlay-close' channel - never the main window's close).
    advancedOverlayClose,
    // M23 (Part B): the advanced-overlay settings reaction (the
    // onOverlaySettings pattern) - called by profiles-settings-save when an
    // advancedOverlay* field changed.
    onAdvancedOverlaySettings,
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
    presentMonLane,
    foregroundApi,
    memoryUtil,
    // M17p: the sysStats MUTABLE HOLDER (never the by-value null - the
    // sysStats block below lands AFTER registerIpc; createIpcHandlers
    // unwraps the holder per-access).
    sysStats: sysStatsHolder,
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
    // boot fetch reads it; M16: the dashboard OC row no longer displays it -
    // the row derives its stock-state verdict from the driver read-back -
    // the record is kept for the boot fetch contract + the ui-verify pins;
    // null when no boot apply ran this session).
    bootApplyOutcome: () => bootApplyOutcome,
    mock: mockCtl,
    // M17f: the sysman power-limits consumer (the PL2 companion + the
    // 'power-limits:read' source).
    sysmanPowerLimits,
    rebuildTray: async () => {
      try { await trayRef?.rebuildMenu?.(); } catch { /* tray unavailable */ }
      // Dev-only probe: lets --ui-verify assert that profile changes reach
      // the tray rebuild hook without a real tray existing.
      if (uiVerify) trayRebuilds += 1;
    },
  });

  // M17p: the sysStats/MSR assignment (MOVED here from its pre-window
  // position - the fast-boot reorder: boot-apply gate -> createWindow ->
  // registerIpc -> THIS block -> the rest). The window AND the IPC surface
  // exist before the CIM query's first hard await (registerIpc MUST run
  // before this block - a 3.1-s block between the window and registerIpc
  // would reject every renderer invoke during boot). The block still
  // awaits the SAME in-flight sysinfoPromise (fired above), so its
  // ABSOLUTE landing time is unchanged (~+3.3 s) - only the window no
  // longer waits for it. Everything the block consumes (sysinfo, backend,
  // fpsAdapter) exists by now and nothing after registerIpc uses
  // sysStats/msrReader before this block (the before-quit teardown reads
  // msrReader at quit). The assignments write the MUTABLE HOLDER
  // (sysStatsHolder) that registerIpc already received - createIpcHandlers
  // unwraps it per-access (the by-value capture fix, S4/N1-r2). The
  // landing re-enriches the enumerated device names (setVramBytesOf in
  // sysinfoResult); the renderer's FIRST listDevices (right after the
  // window loads, ~2.9 s before the landing) saw plain names - the app.ts
  // boot re-fetches devices after sysinfo:get so the header/dashboard/
  // dropdown get the enriched names.
  if (mock) {
    sysStatsHolder.current = createMockSysStats();
  } else {
    // M4L (B): the PawnIO MSR reader (CPU temp + wattage - the HWiNFO-class
    // route). Lazy open + module load once per session (the reader's
    // contract); every read returns null on any error (device absent,
    // install failed, AV quarantine) - the honest degrade. The install
    // state is checked by the reader at the first sample (the bundled
    // official setup runs silently once when the device is absent).
    // M15 (F2): Win32_Processor.Manufacturer (the CIM payload - awaited at
    // the sysinfo landing inside this block) selects the module - an AMD
    // vendor string loads AMDFamily17.bin (SMN temp + the RAPL pair),
    // anything else the IntelMSR.bin path. The module itself re-checks the
    // CPUID vendor + family 0x17-0x1A.
    let deviceIdHex = null;
    try {
      const cached = await sysinfo?.get?.();
      // The GPU-memory match's PCI id now comes from the backend's OWN
      // enumerated device payload (the exact monitored device), not the
      // CIM controller list's first pnpDeviceId (a multi-GPU box could
      // name a different adapter).
      const devices = await backend.listDevices();
      const row = devices.find((d) => typeof d?.pciDeviceId === 'string' && /0x[0-9a-fA-F]{6,8}/.test(d.pciDeviceId)) ?? devices[0];
      const m = typeof row?.pciDeviceId === 'string' ? row.pciDeviceId.match(/0x0*([0-9a-fA-F]{1,4})$/) : null;
      if (m) deviceIdHex = `0x${m[1].toLowerCase()}`;
      msrReader = createMsrReader({ cpuVendor: cached?.cpu?.manufacturer ?? null });
    } catch {
      deviceIdHex = null;
      msrReader = createMsrReader({ cpuVendor: null });
    }
    sysStatsHolder.current = createSysStats({
      deviceIdHex,
      luidOf: async (devId, bdf) => fpsAdapter.adapterLuidOf?.(devId, bdf) ?? null,
      msrReader,
      // M4L (B4): the once-per-session honest degrade note (the pawnio.eu
      // download link included) - logged when the MSR path is unavailable.
      onMsrDegrade: (text) => {
        console.log(`[sys-stats] ${text}`);
      },
      // M17g: the RAM detector (GlobalMemoryStatusEx - native) - the FAST
      // lane's memoryUsedBytes source (the M17g move: the emit-site
      // composition is replaced by the fast-lane field; undefined in mock
      // mode - the createSysStats null-returning default keeps the
      // determinism seam, and the mock adapter is used there anyway).
      memoryUtil,
    });
  }

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
    } else if (process.env.RID_MOCK_LAPTOP === '1') {
      // M17c: the laptop-sysinfo variant - the mock sysinfo fixture +
      // the caps AIB decode both serve the PORTABLE shape (the MSI Claw):
      // the Dashboard Board partner row reads 'MSI (Claw 8 AI+)' (the
      // laptop-manufacturer branch, round-3 N2).
      await runLaptopSysinfoVerify(win);
    } else if (fsVariant && fsVariant !== 'a770') {
      await runFeaturesetVerify(win, fsVariant, backend);
    } else if (process.env.RID_MOCK_NO_SYSMAN === '1') {
      // M17g: the no-sysman variant - the sysman layer is ABSENT (the
      // main.js sysman wiring is null under the knob) - pins the honest
      // '-' read-out at boot, the envelope-fed '(set)' marker + the
      // refused-ceiling sentence on the power-limit card, and the V2
      // companion's recorded calls (the advanced-only recording gate).
      await runNoSysmanVerify(win, backend);
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
    } else if (process.env.RID_MOCK_TRAY_APPLY === '1') {
      // M16-F1 (D2): the tray-apply variant - the seed wrote an ACTIVE
      // profile (230 W, no ocOnBoot - the boot NEVER auto-applies) so the
      // tray menu's "Apply active profile" item is enabled. The recorded
      // tray click handler runs the REAL main-side apply; the variant
      // asserts the pushed post-apply read-back flips the dashboard OC
      // status row IN PLACE (the D2 regression: the tray path used to
      // leave the stale pre-apply verdict for the rest of the session).
      await runTrayApplyVerify(win, backend, store, () => trayProbe);
    } else if (process.env.RID_MOCK_OVERLAY === '1') {
      // M5: the overlay variant - the overlay window is REAL (created above
      // under the knob, seeded overlayEnabled:true); the hotkey is the
      // counting probe (never a real registration). Three matrix configs:
      // 'overlay' alone (the 'FPS   -  AVG -  1% Low -  0.1% Low -  99% FPS
      // -' pin), 'overlay+fps' (RID_MOCK_FPS=1 - 'FPS   60  AVG 58  1% Low
      // 52  0.1% Low 42  99% FPS 58') and 'overlay+fps+api'
      // (RID_MOCK_API=1 - the standalone API row reads the padded
      // 'API   DX12' - M13: the api field LEFT the FPS row; M19b: the
      // SIXTH labeled row with the 'API' header after the divider).
      // M8: the graphics block runs FIRST (runOverlayVerify exits the app).
      await runGraphicsVerify(win, backend);
      await runOverlayVerify(win, overlayHandle, store, overlayHotkeyProbe, () => fpsPolls);
    } else if (process.env.RID_MOCK_ADV_OVERLAY === '1') {
      // M23 (Part B): the ADVANCED-overlay variant - the panel window is
      // REAL (created above under the knob, seeded advancedOverlayEnabled:
      // true - the panel boots SHOWN); the hotkey is the counting probe
      // (never a real registration). The mock backend is passed so the
      // M22-safe payload pins can record the apply-settings payloads (the
      // NO-gpuLock-key shape assertions).
      await runAdvancedOverlayVerify(win, advancedOverlayHandle, store, advancedOverlayHotkeyProbe, backend);
    } else {
      // M4-D: the window-ops probe rides along - run 2 pins the title-bar
      // buttons via getWindowOpCounts. M4-H: the open-external probe rides
      // too (the GitHub-link pin asserts the counting op ticked). M4J (G):
      // the tray probe rides as well (the tray-start pin).
      await runUiVerify(win, backend, store, () => trayRebuilds, () => fpsPolls, () => windowOpCounts, () => openExternalCount, () => trayProbe, sysmanPowerLimits);
    }
    return;
  }

  await bootBackend();
  markProfileBoot('boot-backend');
  const health = await collectHealth(backend);
  markProfileBoot('health');
  console.log(`[health] ${JSON.stringify(health)}`);
}

main().catch((err) => {
  console.error(`FATAL: ${err.message}\n${err.stack}`);
  app.exit(1);
});
