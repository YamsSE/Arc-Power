// Arc Power - desktop-level recording notifications.
//
// This window is intentionally separate from the telemetry HUD. It is a
// small, click-through, always-on-top notification surface that can remain
// visible while another application is focused without taking focus itself.

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOAST_WIDTH = 390;
const TOAST_HEIGHT = 88;
const TOAST_MARGIN = 22;
const TOAST_DURATION_MS = 4200;
const NOTIFICATION_CHANNEL = 'recording:notification';

function normalizeNotification(input) {
  const source = input && typeof input === 'object' ? input : {};
  const variant = source.variant === 'error' || source.variant === 'info' ? source.variant : 'success';
  const title = String(source.title ?? 'Arc Power').trim().slice(0, 120) || 'Arc Power';
  const message = String(source.message ?? '').trim().slice(0, 360);
  const durationMs = Number.isFinite(source.durationMs)
    ? Math.min(12000, Math.max(1600, Math.round(source.durationMs)))
    : TOAST_DURATION_MS;
  return { variant, title, message, durationMs };
}

export function createRecordingToastWindow({ getAnchorWindow = () => null } = {}) {
  let win = null;
  let queued = null;
  let hideTimer = null;
  let topmostTimer = null;

  const boundsFor = () => {
    try {
      const anchor = getAnchorWindow?.();
      const anchorBounds = anchor && !anchor.isDestroyed?.() ? anchor.getBounds() : null;
      const display = anchorBounds ? screen.getDisplayMatching(anchorBounds) : screen.getPrimaryDisplay();
      return {
        x: display.bounds.x + display.bounds.width - TOAST_WIDTH - TOAST_MARGIN,
        y: display.bounds.y + display.bounds.height - TOAST_HEIGHT - TOAST_MARGIN,
        width: TOAST_WIDTH,
        height: TOAST_HEIGHT,
      };
    } catch {
      const display = screen.getPrimaryDisplay();
      return {
        x: display.bounds.x + display.bounds.width - TOAST_WIDTH - TOAST_MARGIN,
        y: display.bounds.y + display.bounds.height - TOAST_HEIGHT - TOAST_MARGIN,
        width: TOAST_WIDTH,
        height: TOAST_HEIGHT,
      };
    }
  };

  const reassertTopmost = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* best effort during shutdown */ }
  };

  const build = () => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      ...boundsFor(),
      transparent: true,
      frame: false,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '..', 'preload.cjs'),
        backgroundThrottling: false,
      },
    });
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    topmostTimer = setInterval(reassertTopmost, 3000);
    win.on('closed', () => {
      if (topmostTimer) clearInterval(topmostTimer);
      topmostTimer = null;
      win = null;
    });
    win.webContents.on('did-finish-load', () => {
      if (!queued || !win || win.isDestroyed()) return;
      const next = queued;
      queued = null;
      win.webContents.send(NOTIFICATION_CHANNEL, next);
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'recording-toast.html'));
    return win;
  };

  const show = (notification) => {
    const payload = normalizeNotification(notification);
    const target = build();
    target.setBounds(boundsFor());
    if (target.webContents.isLoading()) queued = payload;
    else target.webContents.send(NOTIFICATION_CHANNEL, payload);
    try { target.setAlwaysOnTop(true, 'screen-saver'); } catch { /* best effort */ }
    try { target.showInactive(); } catch { try { target.show(); } catch { return; } }
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (win && !win.isDestroyed()) win.hide();
      hideTimer = null;
    }, payload.durationMs);
  };

  const destroy = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = null;
    if (topmostTimer) clearInterval(topmostTimer);
    topmostTimer = null;
    queued = null;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  };

  return {
    getWindow: () => (win && !win.isDestroyed() ? win : null),
    show,
    destroy,
  };
}
