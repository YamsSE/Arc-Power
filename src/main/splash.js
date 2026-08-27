// Arc Power startup splash. This window is deliberately small, frameless, and
// self-contained so it can appear while the backend and renderer initialize.

import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const assetPath = (name) => path.join(__dirname, '..', 'assets', name);

/**
 * Create the startup loading window. The caller owns the returned window and
 * closes it when the main renderer reports that boot has completed.
 * @returns {import('electron').BrowserWindow}
 */
export function createStartupSplash() {
  const splash = new BrowserWindow({
    width: 500,
    height: 396,
    useContentSize: true,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Arc Power',
    backgroundColor: '#090b12',
    icon: assetPath('ArcPowerIcon.png'),
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.showInactive();
  });
  return splash;
}
