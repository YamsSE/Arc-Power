// Arc Power - sandboxed preload bridge (CommonJS: sandboxed preloads cannot
// be ESM). Exposes a typed, whitelisted surface to the renderer; every
// channel is validated in src/main/ipc-core.js before reaching the backend.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arcPower', {
  health: () => ipcRenderer.invoke('health'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  // M4-F: the persisted GPU selection (device-get reads it at boot;
  // device-set is the ONLY writer - like oc-mode-set).
  deviceGet: () => ipcRenderer.invoke('device-get'),
  deviceSet: (deviceId) => ipcRenderer.invoke('device-set', deviceId),
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
  startupSet: (enabled) => ipcRenderer.invoke('startup-set', enabled),
  sysinfo: () => ipcRenderer.invoke('sysinfo:get'),
  // M4-D: the integrated-title-bar window controls (no payload - the
  // channels assert it in main).
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximizeToggle: () => ipcRenderer.invoke('window-maximize-toggle'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  // M4-H: the sidebar GitHub link - opens the URL in the default browser
  // via shell.openExternal (STRICTLY validated in ipc-core.js: https: +
  // github.com + the /YamsSE/Arc-Power path).
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  driverInfo: () => ipcRenderer.invoke('driver-info'),
  appVersion: () => ipcRenderer.invoke('app-version'),
  // M4-E: distribution kind - 'installed' | 'portable' | 'dev'
  // (the Settings start-with-Windows hint differentiates by it).
  appBuildInfo: () => ipcRenderer.invoke('app:build-info'),
  appElevated: () => ipcRenderer.invoke('app-elevated'),
  ocModeGet: () => ipcRenderer.invoke('oc-mode-get'),
  ocModeSet: (ocMode) => ipcRenderer.invoke('oc-mode-set', ocMode),
  advancedModeAcceptedGet: () => ipcRenderer.invoke('advanced-mode-accepted-get'),
  advancedModeAcceptedSet: () => ipcRenderer.invoke('advanced-mode-accepted-set'),
  fpsPoll: (deviceId) => ipcRenderer.invoke('fps-poll', deviceId),
  // M4-D2: append one full telemetry sample as a CSV line (Log to file).
  monitorLogAppend: (sample) => ipcRenderer.invoke('monitor-log-append', sample),
  profilesList: () => ipcRenderer.invoke('profiles-list'),
  profilesSave: (profile) => ipcRenderer.invoke('profiles-save', profile),
  profilesDelete: (id) => ipcRenderer.invoke('profiles-delete', id),
  profilesRename: (id, name) => ipcRenderer.invoke('profiles-rename', id, name),
  profilesSettingsSave: (patch) => ipcRenderer.invoke('profiles-settings-save', patch),
  trayRebuild: () => ipcRenderer.invoke('tray-rebuild'),
  // M2D: mock-only featureset control. The channels exist ONLY in mock mode
  // (real mode rejects with "No handler registered" - the renderer never
  // calls them there: the dropdown renders only when health.backend === 'mock').
  mockListFeaturesets: () => ipcRenderer.invoke('mock:list-featuresets'),
  mockSetFeatureset: (id) => ipcRenderer.invoke('mock:set-featureset', id),
  // M4-D2: mock-only boot-apply flow probe (the REAL window-path boot apply
  // in mock mode; the log records what it did). Mock mode only.
  mockRunBootApply: () => ipcRenderer.invoke('mock:run-boot-apply'),
  mockBootApplyLog: () => ipcRenderer.invoke('mock:boot-apply-log'),
  onTelemetrySample: (cb) => {
    const listener = (_event, sample) => cb(sample);
    ipcRenderer.on('telemetry:sample', listener);
    return () => ipcRenderer.removeListener('telemetry:sample', listener);
  },
  // M4-D: pushed window-maximize state (the title-bar max button icon
  // follows the live state; main sends on maximize/unmaximize).
  onWindowMaximizedChanged: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on('window:maximized-changed', listener);
    return () => ipcRenderer.removeListener('window:maximized-changed', listener);
  },
});
