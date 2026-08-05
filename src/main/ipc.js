// Arc Power — IPC registration over ipcMain. The whitelisted channel set and
// all handler logic live in ipc-core.js (electron-free, unit-testable); this
// module only binds the map to ipcMain.handle.

import { app, ipcMain } from 'electron';
import { createIpcHandlers } from './ipc-core.js';
import { createStartup } from './startup.js';
import { createDriverInfo } from './driver-info.js';
import { createRegistryCatalog } from './registry-catalog.js';
import { createPresentmonAdapter } from './presentmon/presentmon-client.js';

/**
 * Register every whitelisted handler on ipcMain. Returns a teardown that
 * stops all telemetry services (call on app quit).
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   getWindow: () => import('electron').BrowserWindow,
 *   startup?: import('./startup.js').RunKeyStartup,
 *   driverInfo?: ReturnType<typeof createDriverInfo>,
 *   registryCatalog?: ReturnType<typeof createRegistryCatalog>,
 *   presentmon?: { poll: (deviceId: number) => Promise<unknown>, stop?: () => Promise<void> },
 *   rebuildTray?: () => Promise<unknown>,
 *   oldIgcl?: object,
 *   applyRunner?: object | null,
 *   isElevated?: () => boolean,
 *   mock?: { listFeaturesets: () => Promise<unknown>, setFeatureset: (id: string) => Promise<unknown> } | null,
 * }} ctx
 * @returns {() => Promise<void>}
 */
export function registerIpc({ backend, store, getWindow, startup = createStartup(), driverInfo = createDriverInfo(), registryCatalog = createRegistryCatalog(), presentmon = createPresentmonAdapter(), rebuildTray = async () => {}, oldIgcl, applyRunner = null, isElevated, mock = null }) {
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend,
    store,
    startup,
    driverInfo,
    registryCatalog,
    presentmon,
    rebuildTray,
    appVersion: app.getVersion(),
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
  const stopPresentmon = () => presentmon.stop?.().catch(() => {});
  return async () => {
    await stopAllTelemetry();
    await stopPresentmon();
  };
}
