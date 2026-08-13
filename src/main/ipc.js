// Arc Power - IPC registration over ipcMain. The whitelisted channel set and
// all handler logic live in ipc-core.js (electron-free, unit-testable); this
// module only binds the map to ipcMain.handle.

import { app, ipcMain } from 'electron';
import { createIpcHandlers } from './ipc-core.js';
import { createStartup } from './startup.js';
import { createDriverInfo } from './driver-info.js';
import { createRegistryCatalog, REGISTRY_CATALOG } from './registry-catalog.js';
import { createRegistryApply } from './registry-apply.js';
import { createDxgiFpsAdapter } from './fps-dxgi.js';
import { createSysStats } from './sys-stats.js';
import { createMonitorLog } from './monitor-log.js';
import { isElevated as isElevatedReal } from './elevation.js';

/**
 * Register every whitelisted handler on ipcMain. Returns a teardown that
 * stops all telemetry services (call on app quit).
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   getWindow: () => import('electron').BrowserWindow,
 *   startup?: import('./startup.js').RunKeyStartup,
 *   driverInfo?: ReturnType<typeof createDriverInfo>,
 *   sysinfo?: { get: () => Promise<unknown> },  // M4-D
 *   windowOps?: {                              // M4-D: BrowserWindow ops
 *     minimize: () => Promise<unknown>,
 *     maximizeToggle: () => Promise<unknown>,
 *     close: () => Promise<unknown>,
 *   },
 *   openExternal?: (url: string) => Promise<unknown>,  // M4-H: shell.openExternal (sidebar GitHub link)
 *   registryCatalog?: ReturnType<typeof createRegistryCatalog>,
 *   registryApply?: ReturnType<typeof createRegistryApply>,
 *   fpsAdapter?: { poll: (deviceId: number) => Promise<unknown>, stop?: () => Promise<void> },
 *   presentMonLane?: { poll: (deviceId: number) => Promise<unknown>, stop?: () => Promise<void> } | null,  // M17c: the ETW/PresentMon lane (main.js wires the real lane in the product path)
 *   foregroundApi?: { detect: () => Promise<string | null> },  // M10a: the foreground-window Graphics-API detector (the real koffi probe; the DEFAULT is the null-returning detector - mock/ui-verify never run it)
 *   memoryUtil?: { detect: () => Promise<number | null> },  // M12/M14: the RAM detector (GlobalMemoryStatusEx -> the USED RAM in BYTES - total - avail; the real koffi probe; the DEFAULT is the null-returning detector - mock/ui-verify never run it)
 *   sysStats?: { sample: () => Promise<unknown> },
 *   monitorLog?: { append: (sample: object) => Promise<unknown> },
 *   rebuildTray?: () => Promise<unknown>,
 *   oldIgcl?: object,
 *   applyRunner?: object | null,
 *   isElevated?: () => boolean,
 *   buildKind?: 'installed' | 'portable' | 'dev',  // M4-E: app:build-info
 *   bootApplyOutcome?: () => ({ ok: boolean, detail: string, at: number } | null),  // M4N: the window-path boot apply's outcome record (main.js; null when no boot apply ran)
 *   mock?: { listFeaturesets: () => Promise<unknown>, setFeatureset: (id: string) => Promise<unknown>, runBootApply?: () => Promise<unknown>, bootApplyLog?: () => Promise<unknown> } | null,
 *   getOverlayWindow?: () => import('electron').BrowserWindow | null,  // M5: the overlay window (null when absent - the emit null-guards it)
 *   overlayOps?: { getState: () => Promise<unknown>, toggle: () => Promise<unknown> },  // M5: the overlay-window ops (main.js wires the real handle)
 *   onOverlaySettings?: (patch: object) => Promise<unknown>,  // M5: the overlay settings reaction (profiles-settings-save)
 *   sysmanPowerLimits?: object | null,  // M17f: the sysman power-limits consumer (the PL2 companion + the 'power-limits:read' source)
 * }} ctx
 * @returns {() => Promise<void>}
 */
export function registerIpc({ backend, store, getWindow, startup = createStartup(), driverInfo = createDriverInfo(), sysinfo, windowOps, openExternal = async () => {}, registryCatalog = createRegistryCatalog(), registryApply = createRegistryApply(REGISTRY_CATALOG, { isElevated: isElevatedReal }), fpsAdapter = createDxgiFpsAdapter(), presentMonLane = null, foregroundApi = { detect: async () => null }, memoryUtil = { detect: async () => null }, sysStats = createSysStats(), monitorLog = createMonitorLog({ getDocumentsDir: () => app.getPath('documents') }), rebuildTray = async () => {}, oldIgcl, applyRunner = null, isElevated, buildKind = 'dev', bootApplyOutcome = () => null, mock = null, getOverlayWindow = () => null, overlayOps = { getState: async () => ({ exists: false, visible: false, bounds: null, position: 'top-left', scale: 1, enabled: false, hotkeyRegistered: false }), toggle: async () => {} }, onOverlaySettings = async () => {}, sysmanPowerLimits = null }) {
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend,
    store,
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
    sysStats,
    monitorLog,
    rebuildTray,
    appVersion: app.getVersion(),
    buildKind,
    bootApplyOutcome,
    oldIgcl,
    applyRunner,
    isElevated,
    mock,
    overlayOps,
    onOverlaySettings,
    sysmanPowerLimits,
    emit: (channel, payload) => {
      // Only push-style channels cross the window boundary; request/response
      // channels return their payload via the invoke promise.
      if (channel !== 'telemetry:sample') return;
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
      // M5: the telemetry push forwards to the OVERLAY window too (its
      // stat lines + frametime series live off the same sample stream).
      // NULL-GUARDED: the overlay may not exist yet when the first sample
      // arrives (and never exists in headless/apply modes).
      const overlayWin = getOverlayWindow();
      if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, payload);
    },
  });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  }
  // M17c: the teardown kills the PresentMon sidecar too (no orphaned ETW
  // session / child process on app exit).
  const stopFps = () => Promise.all([
    fpsAdapter.stop?.().catch(() => {}),
    presentMonLane?.stop?.().catch(() => {}),
  ]);
  return async () => {
    await stopAllTelemetry();
    await stopFps();
  };
}
