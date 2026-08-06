// Arc Power — sandboxed preload bridge (CommonJS: sandboxed preloads cannot
// be ESM). Exposes a typed, whitelisted surface to the renderer; every
// channel is validated in src/main/ipc-core.js before reaching the backend.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arcPower', {
  health: () => ipcRenderer.invoke('health'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  getCapabilities: (deviceId) => ipcRenderer.invoke('get-capabilities', deviceId),
  getCurrentSettings: (deviceId) => ipcRenderer.invoke('get-current-settings', deviceId),
  applySettings: (deviceId, settings) => ipcRenderer.invoke('apply-settings', deviceId, settings),
  resetToDefaults: (deviceId) => ipcRenderer.invoke('reset-to-defaults', deviceId),
  waiverGet: (deviceId) => ipcRenderer.invoke('waiver-get', deviceId),
  waiverAccept: (deviceId) => ipcRenderer.invoke('waiver-accept', deviceId),
  telemetryStart: (deviceId) => ipcRenderer.invoke('telemetry-start', deviceId),
  telemetryStop: (deviceId) => ipcRenderer.invoke('telemetry-stop', deviceId),
  registryCatalog: () => ipcRenderer.invoke('registry-catalog'),
  registryApply: (entryId, action) => ipcRenderer.invoke('registry-apply', entryId, action),
  startupGet: () => ipcRenderer.invoke('startup-get'),
  startupSet: (enabled, profileId) => ipcRenderer.invoke('startup-set', enabled, profileId),
  driverInfo: () => ipcRenderer.invoke('driver-info'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  appElevated: () => ipcRenderer.invoke('app-elevated'),
  ocModeGet: () => ipcRenderer.invoke('oc-mode-get'),
  ocModeSet: (ocMode) => ipcRenderer.invoke('oc-mode-set', ocMode),
  fpsPoll: (deviceId) => ipcRenderer.invoke('fps-poll', deviceId),
  profilesList: () => ipcRenderer.invoke('profiles-list'),
  profilesSave: (profile) => ipcRenderer.invoke('profiles-save', profile),
  profilesDelete: (id) => ipcRenderer.invoke('profiles-delete', id),
  profilesRename: (id, name) => ipcRenderer.invoke('profiles-rename', id, name),
  profilesSettingsSave: (patch) => ipcRenderer.invoke('profiles-settings-save', patch),
  trayRebuild: () => ipcRenderer.invoke('tray-rebuild'),
  // M2D: mock-only featureset control. The channels exist ONLY in mock mode
  // (real mode rejects with "No handler registered" — the renderer never
  // calls them there: the dropdown renders only when health.backend === 'mock').
  mockListFeaturesets: () => ipcRenderer.invoke('mock:list-featuresets'),
  mockSetFeatureset: (id) => ipcRenderer.invoke('mock:set-featureset', id),
  onTelemetrySample: (cb) => {
    const listener = (_event, sample) => cb(sample);
    ipcRenderer.on('telemetry:sample', listener);
    return () => ipcRenderer.removeListener('telemetry:sample', listener);
  },
});
