// Arc Power — IPC registration over ipcMain. The whitelisted channel set and
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
 *   registryCatalog?: ReturnType<typeof createRegistryCatalog>,
 *   registryApply?: ReturnType<typeof createRegistryApply>,
 *   fpsAdapter?: { poll: (deviceId: number) => Promise<unknown>, stop?: () => Promise<void> },
 *   sysStats?: { sample: () => Promise<unknown> },
 *   monitorLog?: { append: (sample: object) => Promise<unknown> },
 *   rebuildTray?: () => Promise<unknown>,
 *   oldIgcl?: object,
 *   applyRunner?: object | null,
 *   isElevated?: () => boolean,
 *   buildKind?: 'installed' | 'portable' | 'dev',  // M4-E: app:build-info
 *   mock?: { listFeaturesets: () => Promise<unknown>, setFeatureset: (id: string) => Promise<unknown>, runBootApply?: () => Promise<unknown>, bootApplyLog?: () => Promise<unknown> } | null,
 * }} ctx
 * @returns {() => Promise<void>}
 */
export function registerIpc({ backend, store, getWindow, startup = createStartup(), driverInfo = createDriverInfo(), sysinfo, windowOps, registryCatalog = createRegistryCatalog(), registryApply = createRegistryApply(REGISTRY_CATALOG, { isElevated: isElevatedReal }), fpsAdapter = createDxgiFpsAdapter(), sysStats = createSysStats(), monitorLog = createMonitorLog({ getDocumentsDir: () => app.getPath('documents') }), rebuildTray = async () => {}, oldIgcl, applyRunner = null, isElevated, buildKind = 'dev', mock = null }) {
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend,
    store,
    startup,
    driverInfo,
    sysinfo,
    windowOps,
    registryCatalog,
    registryApply,
    fpsAdapter,
    sysStats,
    monitorLog,
    rebuildTray,
    appVersion: app.getVersion(),
    buildKind,
    oldIgcl,
    applyRunner,
    isElevated,
    mock,
    emit: (channel, payload) => {
      // Only push-style channels cross the window boundary; request/response
      // channels return their payload via the invoke promise.
      if (channel !== 'telemetry:sample') return;
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  }
  const stopFps = () => fpsAdapter.stop?.().catch(() => {});
  return async () => {
    await stopAllTelemetry();
    await stopFps();
  };
}
