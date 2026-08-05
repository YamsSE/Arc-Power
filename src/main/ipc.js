// Arc Power — IPC registration over ipcMain. The whitelisted channel set and
// all handler logic live in ipc-core.js (electron-free, unit-testable); this
// module only binds the map to ipcMain.handle.

import { ipcMain } from 'electron';
import { createIpcHandlers } from './ipc-core.js';

/**
 * Register every whitelisted handler on ipcMain. Returns a teardown that
 * stops all telemetry services (call on app quit).
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   store: import('./store/profile-store.js').ProfileStore,
 *   getWindow: () => import('electron').BrowserWindow,
 *   igs: import('./igs-service.js').IgsService,
 * }} ctx
 * @returns {() => Promise<void>}
 */
export function registerIpc({ backend, store, getWindow, igs }) {
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend,
    store,
    igs,
    emit: (channel, payload) => {
      if (channel !== 'telemetry:sample') return;
      const win = getWindow();
      if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
    },
  });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, (_event, ...args) => fn(...args));
  }
  return stopAllTelemetry;
}
