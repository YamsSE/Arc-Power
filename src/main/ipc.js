// Arc Power - IPC registration over ipcMain. The whitelisted channel set and
// all handler logic live in ipc-core.js (electron-free, unit-testable); this
// module only binds the map to ipcMain.handle.

import { app, ipcMain } from 'electron';
import { createIpcHandlers, DEVICE_STATE_UPDATED_CHANNEL, GRAPHICS_STATE_UPDATED_CHANNEL, DEVICE_SELECTION_UPDATED_CHANNEL, DEVICE_SELECTION_REQUEST_CHANNEL } from './ipc-core.js';
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
 *   sysStats?: { sample: () => Promise<{ cpuUtilPct: number | null, cpuTempC: number | null, cpuFreqMhz: number | null, gpuMemUsedBytes: number | null }>, sampleFast?: () => Promise<object>, sampleSlow?: () => Promise<object>, startSlowLane?: (cadenceMs?: number) => void, stopSlowLane?: () => void } | { current: object | null },  // M4-D2: CPU/GPU system stats (OS-formatted counters, single-sample). M17g: the telemetry push samples the FAST lane (sampleFast) per tick - never the slow PowerShell query; the slow lane runs on the adapter's own background timer (startSlowLane/stopSlowLane, tied to the telemetry session lifecycle). M17p: main.js may pass a MUTABLE HOLDER ({ current: null } - the sysStats block lands AFTER registerIpc; createIpcHandlers' ONE normalize unwraps it per-access; a plain adapter passes through).
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
 *   getAdvancedOverlayWindow?: () => import('electron').BrowserWindow | null,  // M23: the ADVANCED overlay window (the telemetry push's THIRD consumer; null when absent - the emit null-guards it)
 *   advancedOverlayOps?: { getState: () => Promise<unknown>, toggle: () => Promise<unknown> },  // M23: the advanced-overlay-window ops (main.js wires the real panel handle)
 *   advancedOverlayClose?: () => Promise<unknown>,  // M23: the panel's custom close op (the dedicated 'advanced-overlay-close' channel)
 *   onAdvancedOverlaySettings?: (patch: object) => Promise<unknown>,  // M23: the advanced-overlay settings reaction (profiles-settings-save)
 *   sysmanPowerLimits?: object | null,  // M17f: the sysman power-limits consumer (the PL2 companion + the 'power-limits:read' source)
 * }} ctx
 * @returns {() => Promise<void>}
 */
export function registerIpc({ backend, store, getWindow, startup = createStartup(), driverInfo = createDriverInfo(), sysinfo, windowOps, openExternal = async () => {}, registryCatalog = createRegistryCatalog(), registryApply = createRegistryApply(REGISTRY_CATALOG, { isElevated: isElevatedReal }), fpsAdapter = createDxgiFpsAdapter(), presentMonLane = null, foregroundApi = { detect: async () => null }, memoryUtil = { detect: async () => null }, sysStats = createSysStats(), monitorLog = createMonitorLog({ getDocumentsDir: () => app.getPath('documents') }), rebuildTray = async () => {}, oldIgcl, applyRunner = null, isElevated, buildKind = 'dev', bootApplyOutcome = () => null, mock = null, getOverlayWindow = () => null, overlayOps = { getState: async () => ({ exists: false, visible: false, bounds: null, position: 'top-left', scale: 1, enabled: false, hotkeyRegistered: false }), toggle: async () => {} }, onOverlaySettings = async () => {}, getAdvancedOverlayWindow = () => null, advancedOverlayOps = { getState: async () => ({ exists: false, visible: false, bounds: null, position: 'right', enabled: false, hotkeyRegistered: false }), toggle: async () => {} }, advancedOverlayClose = async () => {}, onAdvancedOverlaySettings = async () => {}, sysmanPowerLimits = null }) {
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
    advancedOverlayOps,
    advancedOverlayClose,
    onAdvancedOverlaySettings,
    sysmanPowerLimits,
    emit: (channel, payload) => {
      // Push-style selection request goes only to the main renderer. The
      // panel never receives its own request and cannot recurse through the
      // device-set persistence channel.
      if (channel === DEVICE_SELECTION_REQUEST_CHANNEL) {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
        return;
      }
      if (channel === DEVICE_SELECTION_UPDATED_CHANNEL) {
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
        const overlayWin = getOverlayWindow();
        if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send(channel, payload);
        const advancedOverlayWin = getAdvancedOverlayWindow();
        if (advancedOverlayWin && !advancedOverlayWin.isDestroyed()) advancedOverlayWin.webContents.send(channel, payload);
        return;
      }
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
      // M23: the telemetry push forwards to the ADVANCED overlay window as
      // the THIRD consumer (the panel's live clock/temp/fan/power readout
      // strip rides the same sample stream). NULL-GUARDED like the HUD.
      const advancedOverlayWin = getAdvancedOverlayWindow();
      if (advancedOverlayWin && !advancedOverlayWin.isDestroyed()) advancedOverlayWin.webContents.send(channel, payload);
    },
  });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      if (channel === 'device-selection-push') {
        const win = getWindow();
        if (!win || win.isDestroyed() || event.sender !== win.webContents) {
          throw new Error('device-selection-push is restricted to the main renderer');
        }
      }
      const out = await fn(...args);
      // M24 (Part B): the cross-window settings sync - an apply/reset from
      // ANY renderer (the main window OR the advanced-overlay panel) pushes
      // the FRESH read-back to BOTH windows, so the other surface re-renders
      // in place (today a panel apply writes the driver but the main window
      // keeps showing the stale value until a full page re-render). Both
      // sends null-guard the windows (the emit pattern); the main window's
      // OWN applies get a redundant push (same state, ocStateChanged false ->
      // no visible change; the app.ts handler already guards the deviceId).
      // The panel's own onStateUpdated re-renders from its push too
      // (bidirectional freshness, free).
      if ((channel === 'apply-settings' || channel === 'reset-to-defaults') && out && out.state != null) {
        const payload = { deviceId: args[0], state: out.state };
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(DEVICE_STATE_UPDATED_CHANNEL, payload);
        const advancedOverlayWin = getAdvancedOverlayWindow();
        if (advancedOverlayWin && !advancedOverlayWin.isDestroyed()) advancedOverlayWin.webContents.send(DEVICE_STATE_UPDATED_CHANNEL, payload);
      } else if (channel === 'graphics:apply' && out && out.graphicsState != null) {
        const payload = { deviceId: args[0], graphicsState: out.graphicsState };
        const win = getWindow();
        if (win && !win.isDestroyed()) win.webContents.send(GRAPHICS_STATE_UPDATED_CHANNEL, payload);
        const advancedOverlayWin = getAdvancedOverlayWindow();
        if (advancedOverlayWin && !advancedOverlayWin.isDestroyed()) advancedOverlayWin.webContents.send(GRAPHICS_STATE_UPDATED_CHANNEL, payload);
      }
      return out;
    });
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
