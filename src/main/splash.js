// Arc Power startup splash. This window is deliberately small, frameless, and
// self-contained so it can appear while the backend and renderer initialize.

import { BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFatalSplashFallback } from './startup-update.js';
import { applyWindowIconLifecycle, resolveWindowIconPath } from './window-icon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPLASH_PRELOAD = path.join(__dirname, '..', 'renderer', 'splash-preload.cjs');

function publishStartupUpdateStatus(splash, payload) {
  if (!splash || splash.isDestroyed()) return;
  try { splash.webContents.send('splash:update-status', payload); } catch { /* closing during boot */ }
}

/**
 * Create the startup loading window. The caller owns the returned window and
 * closes it when the main renderer reports that boot has completed.
 * @returns {import('electron').BrowserWindow}
 */
export function createStartupSplash({ onFatalLoad = null } = {}) {
  const splash = new BrowserWindow({
    width: 500,
    height: 500,
    useContentSize: true,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    // The splash is normally passive, but becomes an update prompt when a
    // release is available. It must be focusable so the two prompt buttons
    // can receive clicks and keyboard focus.
    focusable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    title: 'Arc Power',
    backgroundColor: '#090b12',
    icon: resolveWindowIconPath(),
    webPreferences: {
      preload: SPLASH_PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  applyWindowIconLifecycle(splash);

  const fatalSplashFallback = createFatalSplashFallback({
    onFailure: onFatalLoad,
    close: () => { if (!splash.isDestroyed()) splash.close(); },
  });
  void splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html')).catch(fatalSplashFallback);
  splash.webContents.once('did-fail-load', fatalSplashFallback);
  splash.webContents.once('render-process-gone', fatalSplashFallback);
  splash.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.showInactive();
  });
  return splash;
}

/**
 * Attach the main-owned startup status to the splash. The latest status is
 * buffered until the document/preload is ready and replayed to late listeners.
 */
export function attachStartupUpdateStatus(splash, coordinator) {
  let loaded = false;
  let latest = coordinator.latest();
  const publish = (payload) => {
    latest = payload;
    if (loaded) publishStartupUpdateStatus(splash, payload);
  };
  splash.webContents.once('did-finish-load', () => {
    loaded = true;
    publishStartupUpdateStatus(splash, latest);
  });
  const unsubscribe = coordinator.subscribe(publish);
  splash.once('closed', unsubscribe);
  return unsubscribe;
}
