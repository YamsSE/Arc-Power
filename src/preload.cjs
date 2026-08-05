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
  getIgsServiceState: () => ipcRenderer.invoke('igs-service-state'),
  disableIgsService: () => ipcRenderer.invoke('igs-service-disable'),
  enableIgsService: () => ipcRenderer.invoke('igs-service-enable'),
  startupGet: () => ipcRenderer.invoke('startup-get'),
  startupSet: (enabled, profileId) => ipcRenderer.invoke('startup-set', enabled, profileId),
  driverInfo: () => ipcRenderer.invoke('driver-info'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  fpsPoll: (deviceId) => ipcRenderer.invoke('fps-poll', deviceId),
  profilesList: () => ipcRenderer.invoke('profiles-list'),
  profilesSave: (profile) => ipcRenderer.invoke('profiles-save', profile),
  profilesDelete: (id) => ipcRenderer.invoke('profiles-delete', id),
  profilesRename: (id, name) => ipcRenderer.invoke('profiles-rename', id, name),
  profilesSettingsSave: (patch) => ipcRenderer.invoke('profiles-settings-save', patch),
  trayRebuild: () => ipcRenderer.invoke('tray-rebuild'),
  onTelemetrySample: (cb) => {
    const listener = (_event, sample) => cb(sample);
    ipcRenderer.on('telemetry:sample', listener);
    return () => ipcRenderer.removeListener('telemetry:sample', listener);
  },
});
