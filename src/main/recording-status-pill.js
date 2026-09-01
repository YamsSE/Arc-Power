// Arc Power - desktop-level recording status indicator.
//
// This is intentionally a sibling of the telemetry HUD. It has its own small
// transparent window so the status pill stays in the top-right display corner
// regardless of where the telemetry HUD is positioned, and never covers HUD
// rows or takes focus from a game.

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyWindowIconLifecycle, resolveWindowIconPath } from './window-icon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PILL_WIDTH = 238;
const PILL_HEIGHT = 52;
const PILL_MARGIN = 16;
const STATUS_CHANNEL = 'recording:state';

function isCaptureActive(state) {
  if (!state || typeof state !== 'object') return false;
  const modes = state.activeModes;
  if (modes && typeof modes === 'object') return modes.video === true || modes.replay === true;
  return state.running === true && (state.mode === 'video' || state.mode === 'replay');
}

export function createRecordingStatusPillWindow({
  getAnchorWindow = () => null,
  getRecordingState = () => null,
} = {}) {
  let win = null;
  let enabled = false;
  let recordingState = null;
  let queuedState = null;
  let topmostTimer = null;

  try { recordingState = getRecordingState?.() ?? null; } catch { recordingState = null; }

  const boundsFor = () => {
    try {
      const anchor = getAnchorWindow?.();
      const anchorBounds = anchor && !anchor.isDestroyed?.() ? anchor.getBounds() : null;
      const display = anchorBounds ? screen.getDisplayMatching(anchorBounds) : screen.getPrimaryDisplay();
      return {
        x: display.bounds.x + display.bounds.width - PILL_WIDTH - PILL_MARGIN,
        y: display.bounds.y + PILL_MARGIN,
        width: PILL_WIDTH,
        height: PILL_HEIGHT,
      };
    } catch {
      const display = screen.getPrimaryDisplay();
      return {
        x: display.bounds.x + display.bounds.width - PILL_WIDTH - PILL_MARGIN,
        y: display.bounds.y + PILL_MARGIN,
        width: PILL_WIDTH,
        height: PILL_HEIGHT,
      };
    }
  };

  const reassertTopmost = () => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* shutdown race */ }
  };

  const sendState = () => {
    if (!win || win.isDestroyed() || !win.webContents) return;
    if (win.webContents.isLoading()) {
      queuedState = recordingState;
      return;
    }
    win.webContents.send(STATUS_CHANNEL, recordingState);
  };

  const updateVisibility = () => {
    if (!win || win.isDestroyed()) return;
    if (!enabled || !isCaptureActive(recordingState)) {
      if (win.isVisible()) win.hide();
      return;
    }
    try { win.setBounds(boundsFor()); } catch { /* window is closing */ }
    try { win.setAlwaysOnTop(true, 'screen-saver'); } catch { /* best effort */ }
    try { win.showInactive(); } catch { try { win.show(); } catch { /* shutdown race */ } }
  };

  const build = () => {
    if (win && !win.isDestroyed()) return win;
    win = new BrowserWindow({
      ...boundsFor(),
      icon: resolveWindowIconPath(),
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
    applyWindowIconLifecycle(win);
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    topmostTimer = setInterval(reassertTopmost, 3000);
    win.on('closed', () => {
      if (topmostTimer) clearInterval(topmostTimer);
      topmostTimer = null;
      win = null;
    });
    win.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) {
        if (queuedState !== null) recordingState = queuedState;
        queuedState = null;
        sendState();
        updateVisibility();
      }
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'recording-status-pill.html'));
    return win;
  };

  const apply = (nextEnabled) => {
    enabled = nextEnabled === true;
    if (!enabled) {
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
      return;
    }
    build();
    if (win && !win.isDestroyed()) {
      try { win.setBounds(boundsFor()); } catch { /* display/window race */ }
      sendState();
      updateVisibility();
    }
  };

  const setRecordingState = (state) => {
    recordingState = state && typeof state === 'object' ? state : null;
    if (!enabled) return;
    if (!win || win.isDestroyed()) build();
    sendState();
    updateVisibility();
  };

  const destroy = () => {
    if (topmostTimer) clearInterval(topmostTimer);
    topmostTimer = null;
    queuedState = null;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  };

  return {
    getWindow: () => (win && !win.isDestroyed() ? win : null),
    getState: () => ({
      exists: !!(win && !win.isDestroyed()),
      visible: !!(win && !win.isDestroyed() && win.isVisible()),
      enabled,
      active: isCaptureActive(recordingState),
      bounds: win && !win.isDestroyed() ? win.getBounds() : null,
    }),
    apply,
    setRecordingState,
    destroy,
  };
}
