// Arc Power - sandboxed preload bridge (CommonJS: sandboxed preloads cannot
// be ESM). Exposes a typed, whitelisted surface to the renderer; every
// channel is validated in src/main/ipc-core.js before reaching the backend.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arcPower', {
  health: () => ipcRenderer.invoke('health'),
  listDevices: () => ipcRenderer.invoke('list-devices'),
  // M29: device identity carries the session id plus durable PCI/BDF key.
  deviceGet: () => ipcRenderer.invoke('device-get'),
  deviceSet: (selection) => ipcRenderer.invoke('device-set', selection),
  getCapabilities: (deviceId) => ipcRenderer.invoke('get-capabilities', deviceId),
  getCurrentSettings: (deviceId) => ipcRenderer.invoke('get-current-settings', deviceId),
  // M17f: the sysman PL2 read-out ({ sustainedW, burstW, peakW } when the
  // sysman layer answers, null when absent - the power-limit card's PL2
  // line). M17f (step-4 N2): DEVICE-SCOPED like every read channel (the
  // domain is per-device).
  powerLimitsRead: (deviceId) => ipcRenderer.invoke('power-limits:read', deviceId),
  // M8 (the Graphics tab): the 3D-feature surface - the page's ONLY IPC
  // surface (the dedicated graphics apply path - NOT the OC apply-routing
  // machinery: 3D features have no OC waiver).
  graphicsGet: (deviceId) => ipcRenderer.invoke('graphics:get', deviceId),
  graphicsApply: (deviceId, settings) => ipcRenderer.invoke('graphics:apply', deviceId, settings),
  // M4O: the third arg carries apply options - { profileApply: true } marks
  // a PROFILE apply (the Profiles-page Apply button), which skips the
  // OC-mode gate (the mode is the interactive slider gate ONLY).
  applySettings: (deviceId, settings, opts) => ipcRenderer.invoke('apply-settings', deviceId, settings, opts),
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
  // M17d: the vendor-lane static info ({ vramBytes, computeCores } - the
  // no-Intel dashboard VRAM/Compute rows' source; honest nulls when no
  // vendor adapter resolves). No payload.
  vendorInfo: () => ipcRenderer.invoke('vendor-info:get'),
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
  // M4N (A.1): the window-path boot apply's outcome ({ ok, detail, at } or
  // null when no boot apply ran this session) - the dashboard OC Status row
  // reads it at boot.
  bootApplyOutcome: () => ipcRenderer.invoke('boot-apply-outcome'),
  appElevated: () => ipcRenderer.invoke('app-elevated'),
  ocModeGet: () => ipcRenderer.invoke('oc-mode-get'),
  ocModeSet: (ocMode) => ipcRenderer.invoke('oc-mode-set', ocMode),
  advancedModeAcceptedGet: () => ipcRenderer.invoke('advanced-mode-accepted-get'),
  advancedModeAcceptedSet: () => ipcRenderer.invoke('advanced-mode-accepted-set'),
  fpsPoll: (deviceId) => ipcRenderer.invoke('fps-poll', deviceId),
  // M4-D2/M4J: append one full telemetry sample as an aligned fixed-width
  // line (Log to file - monitor-YYYYMMDD.txt).
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
  // M16-F1: pushed POST-APPLY device read-backs ({ deviceId, state } on
  // 'device:state-updated') - the tray "Apply active profile" runs entirely
  // in main, so main pushes the fresh read-back; the renderer refreshes its
  // store `state` slot (the dashboard OC status row derives from the live
  // read-back and must flip after a tray apply).
  onStateUpdated: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('device:state-updated', listener);
    return () => ipcRenderer.removeListener('device:state-updated', listener);
  },
  // M24 (Part B): pushed POST-APPLY GRAPHICS read-backs ({ deviceId,
  // graphicsState } on 'graphics:state-updated') - the onStateUpdated twin
  // for the graphics surface: a panel/external graphics apply pushes the
  // fresh read-back, and the main window's Graphics page + the panel's
  // Graphics tab re-render from it in place (the cross-window sync).
  onGraphicsStateUpdated: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('graphics:state-updated', listener);
    return () => ipcRenderer.removeListener('graphics:state-updated', listener);
  },
  // M5: the software overlay (the Overlay window's surface - the main
  // window never calls these; the channels validate in ipc-core.js).
  // onOverlaySettings receives the pushed 'overlay:settings' payload (the
  // scale source of truth - sent by main on every apply, incl. the initial
  // did-finish-load push); overlayGetState/overlayToggle drive the
  // Settings Overlay card.
  onOverlaySettings: (cb) => {
    const listener = (_event, settings) => cb(settings);
    ipcRenderer.on('overlay:settings', listener);
    return () => ipcRenderer.removeListener('overlay:settings', listener);
  },
  overlayGetState: () => ipcRenderer.invoke('overlay:get-state'),
  overlayToggle: () => ipcRenderer.invoke('overlay:toggle'),
  // M23: the ADVANCED overlay (the M5 triad, new names - the
  // AMD-Adrenaline-style interactive side panel). onAdvancedOverlaySettings
  // receives the pushed 'advanced-overlay:settings' payload (carrying
  // { position, enabled, hotkeyLetter } - sent by main on every apply,
  // incl. the initial did-finish-load push); advancedOverlayGetState/
  // advancedOverlayToggle drive the Overlay view's Advanced card.
  onAdvancedOverlaySettings: (cb) => {
    const listener = (_event, settings) => cb(settings);
    ipcRenderer.on('advanced-overlay:settings', listener);
    return () => ipcRenderer.removeListener('advanced-overlay:settings', listener);
  },
  advancedOverlayGetState: () => ipcRenderer.invoke('advanced-overlay:get-state'),
  advancedOverlayToggle: () => ipcRenderer.invoke('advanced-overlay:toggle'),
  // M23: the panel's custom close button - the DEDICATED
  // 'advanced-overlay:close' channel (a SESSION hide; the main window is
  // never closed by the panel).
  advancedOverlayClose: () => ipcRenderer.invoke('advanced-overlay:close'),
  // M25: auto-update IPC (GitHub Releases check/download/install).
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateDownload: (assetUrl) => ipcRenderer.invoke('update:download', assetUrl),
  updateInstall: (filePath) => ipcRenderer.invoke('update:install', filePath),
});
