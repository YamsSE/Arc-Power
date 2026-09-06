// The canonical icon source for every Electron BrowserWindow.
//
// The packaged app keeps this ICO outside app.asar so Windows can resolve it
// from the extracted Portable process as well as from installed builds. Dev
// windows use the same checked-in asset from src/assets.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeImage } from 'electron';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEV_ICON_PATH = path.join(__dirname, '..', 'assets', 'app-icon.ico');
const PACKAGED_TASKBAR_ICON_PATH = path.join(process.resourcesPath ?? '', 'ArcPowerTaskbar.ico');
const PACKAGED_ICON_PATH = path.join(process.resourcesPath ?? '', 'app-icon.ico');
const PACKAGED_FALLBACK_ICON_PATH = path.join(process.resourcesPath ?? '', 'app-icon-fallback.ico');
const BUILD_ICON_PATH = path.join(__dirname, '..', '..', 'build', 'icon.ico');

export function resolveWindowIconPath() {
  const candidates = process.resourcesPath
    ? [PACKAGED_TASKBAR_ICON_PATH, PACKAGED_ICON_PATH, PACKAGED_FALLBACK_ICON_PATH]
    : [DEV_ICON_PATH, BUILD_ICON_PATH];
  return candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  }) ?? (process.resourcesPath ? PACKAGED_ICON_PATH : DEV_ICON_PATH);
}

/** Apply the canonical native image after a BrowserWindow handle exists. */
export function applyWindowIcon(win) {
  if (!win || win.isDestroyed?.()) return;
  try {
    const icon = nativeImage.createFromPath(resolveWindowIconPath());
    if (!icon.isEmpty()) win.setIcon(icon);
  } catch {
    // A closing/test window must never turn icon branding into a startup error.
  }
}

/** Apply the icon at construction and at the two Windows identity races. */
export function applyWindowIconLifecycle(win) {
  applyWindowIcon(win);
  win?.webContents?.once('did-finish-load', () => applyWindowIcon(win));
  win?.once('ready-to-show', () => applyWindowIcon(win));
}
