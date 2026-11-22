const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('arcPowerSplash', {
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('splash:update-status', listener);
    return () => ipcRenderer.removeListener('splash:update-status', listener);
  },
  onDownloadProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('update:download-progress', listener);
    return () => ipcRenderer.removeListener('update:download-progress', listener);
  },
  updateNow: () => ipcRenderer.invoke('splash:update-now'),
  skipUpdate: () => ipcRenderer.invoke('splash:update-choice', 'skip'),
});
