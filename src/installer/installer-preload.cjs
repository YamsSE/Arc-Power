const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arcPowerInstaller', {
  getState: () => ipcRenderer.invoke('installer:state'),
  chooseDirectory: () => ipcRenderer.invoke('installer:choose-directory'),
  install: (options) => ipcRenderer.invoke('installer:install', options),
  uninstall: () => ipcRenderer.invoke('installer:uninstall'),
  close: () => ipcRenderer.invoke('installer:close'),
  onProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('installer:progress', listener);
    return () => ipcRenderer.removeListener('installer:progress', listener);
  },
});

