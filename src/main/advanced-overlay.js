// Arc Power - M23 the ADVANCED overlay (the AMD-Adrenaline-style interactive
// side panel - CONTROL + <letter>, stock P). The HUD's overlay.js stays
// untouched (different lifecycle, different interactivity): this is a small
// INTERACTIVE always-on-top panel - sliders/buttons receive input, the
// OPPOSITE of the HUD's setIgnoreMouseEvents(true). Three tabs: Tuning
// (OC sliders + the M22-safe lock editor), Fan (the reused fan editor),
// Graphics (the four M8 cards).
//
// This module owns:
//   - the GEOMETRY: a compact fixed panel (~360x640 CSS px) anchored to the
//     PRIMARY display edge per advancedOverlayPosition ('left'|'right', an
//     8px margin); frameless, resizable false, skipTaskbar true;
//   - the VISIBILITY: hidden until apply() shows it (the hotkey-enable path
//     must work before the master is on - the M5 overlay pattern);
//   - the INTERACTIVITY: NO setIgnoreMouseEvents - the CSS drag region
//     (.adv-overlay-drag) + the custom close button call the injected window
//     ops (a DEDICATED 'advanced-overlay-close' channel - the main window is
//     never closed by the panel);
//   - getState() -> { exists, visible, bounds, position, enabled,
//     hotkeyRegistered } - hotkeyRegistered is DERIVED LIVE from the SECOND
//     hotkey seam (main.js product path: globalShortcut.register's return;
//     ui-verify: the counting probe). A failed register reads false and the
//     Overlay view shows the honest note;
//   - toggle() -> the SHORTCUT flip (M7b fix-5 semantics): gated on the
//     persisted advancedOverlayEnabled MASTER - while the master is OFF it
//     does NOTHING (no window change, no persist); when ON it flips the
//     SESSION visibility only - it NEVER writes advancedOverlayEnabled
//     (the Overlay view's Advanced card is its only writer);
//   - the LIFECYCLE rule (S2): the panel NEVER keeps the app alive by
//     itself - the main window's closed event destroys it + unregisters its
//     hotkey, and will-quit closes both. The panel itself is INTERACTIVE:
//     a HELD-OPEN panel is irrelevant to quit (the main window's closing
//     destroys it regardless) - the destroy-unregister pair lives with the
//     main window.
//
// The window is created UNCONDITIONALLY on the product window path (HIDDEN
// when advancedOverlayEnabled is false - apply() shows it when the user
// enables it through the Overlay view; a lazy create would break the enable
// path). NEVER in headless/boot-apply/apply-profile modes; ui-verify creates
// it only under RID_MOCK_ADV_OVERLAY=1.

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The panel's fixed compact size (CSS px - NO scale key, the panel is a
 *  control surface, not a HUD). */
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 640;
/** The margin from the anchored display edge. */
const PANEL_MARGIN = 8;

const ADVANCED_OVERLAY_POSITIONS = ['left', 'right'];

/**
 * Normalize a raw settings object into the panel's applied shape (the
 * defaults fill absent/garbage fields - the same absent-field mechanism as
 * the store; the persisted-truth owners are profile-store.js + the main.js
 * applyAdvancedOverlaySettings forwarding).
 * @param {object} raw
 */
function normalizeSettings(raw = {}) {
  const position = typeof raw.position === 'string' && ADVANCED_OVERLAY_POSITIONS.includes(raw.position)
    ? raw.position
    : 'right';
  const hotkeyLetter = typeof raw.hotkeyLetter === 'string' && /^[A-Za-z]$/.test(raw.hotkeyLetter)
    ? raw.hotkeyLetter.toUpperCase()
    : 'P';
  return {
    enabled: raw.enabled === true,
    position,
    hotkeyLetter,
  };
}

/**
 * Create the advanced-overlay window.
 * @param {{
 *   getOverlaySettings: () => object,   // the CURRENT persisted settings
 *                                       // (main.js: store.loadSettingsSync)
 *   close: () => Promise<unknown> | unknown,  // the injected panel-close op
 *                                       // (the DEDICATED advanced-overlay
 *                                       // close channel - the main window is
 *                                       // never closed by the panel)
 * }} deps
 * @returns {{
 *   getWindow: () => import('electron').BrowserWindow | null,
 *   getState: () => { exists: boolean, visible: boolean, bounds: object | null, position: string, enabled: boolean, hotkeyRegistered: boolean },
 *   apply: (settings: object) => void,   // idempotent geometry + visibility
 *                                        // application (boot + every change)
 *   toggle: () => Promise<void>,         // the SHORTCUT flip - gated on the
 *                                        // enabled master; never persists
 *   setHotkeyRegistered: (flag: boolean) => void,  // the hotkey seam's live flag
 *   destroy: () => void,
 * }}
 */
export function createAdvancedOverlayWindow({ getOverlaySettings }) {
  let win = null;
  let visible = false;
  let hotkeyRegistered = false;
  // The applied settings (the single source the geometry + the pushed
  // 'advanced-overlay:settings' payload both derive from).
  let applied = normalizeSettings(getOverlaySettings());

  const build = () => {
    if (win && !win.isDestroyed()) return win;
    const { bounds } = screen.getPrimaryDisplay();
    const geom = geometryFor(applied.position, bounds);
    win = new BrowserWindow({
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      x: geom.x,
      y: geom.y,
      // Frameless + no taskbar entry: a floating control surface, never a
      // window you Alt-Tab to. INTERACTIVE - no setIgnoreMouseEvents.
      frame: false,
      skipTaskbar: true,
      resizable: false,
      hasShadow: true,
      backgroundColor: '#0f1116',
      // Created hidden - the visibility is applied by apply() (the
      // hotkey-enable path must work before the user ever enables it).
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '..', 'preload.cjs'),
        // The panel shows LIVE telemetry (the clock/temp/fan/power readout
        // strip): Chromium must never throttle its timers when the window is
        // treated as background - a throttled page would freeze the readout.
        backgroundThrottling: false,
      },
    });
    // The always-on-top level 'screen-saver' (above normal windows + the
    // taskbar edge cases).
    win.setAlwaysOnTop(true, 'screen-saver');
    // M16 (the always-on-top investigation, the SAME mitigation as the HUD):
    // Windows DWM does not guarantee a topmost window stays above every
    // windowed/borderless program - a game can re-raise itself above the
    // panel (SetWindowPos z-order fights). The mitigation: REASSERT the
    // topmost flag periodically + on apply so the panel climbs back over any
    // window that jumped it.
    const reassertTopmost = () => {
      if (win && !win.isDestroyed() && win.isVisible()) {
        try {
          win.setAlwaysOnTop(true, 'screen-saver');
        } catch {
          // a destroyed mid-tick window must never throw through the timer
        }
      }
    };
    const topmostTimer = setInterval(reassertTopmost, 3000);
    win.on('closed', () => clearInterval(topmostTimer));
    win.webContents.on('console-message', (event) => {
      // Electron >= 30: the event object carries { level, message, ... }.
      const level = typeof event.level === 'number' ? event.level : 0;
      const message = typeof event.message === 'string' ? event.message : '';
      if (level >= 2) console.error(`[advanced-overlay] ${message}`);
    });
    // The INITIAL 'advanced-overlay:settings' push fires right after
    // did-finish-load so the position + the shortcut hint apply at boot (the
    // push otherwise fires only on CHANGE - the panel would never learn the
    // initial position/hotkeyLetter). The panel registers its listener
    // SYNCHRONOUSLY at script top, so this push is never missed.
    win.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) win.webContents.send('advanced-overlay:settings', payload());
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'advanced-overlay.html'));
    return win;
  };

  /** The panel's anchored geometry on the PRIMARY display (an 8px margin,
   *  clamped so the fixed panel never exceeds the display height). */
  const geometryFor = (position, bounds) => {
    const height = Math.min(PANEL_HEIGHT, Math.max(0, bounds.height - PANEL_MARGIN * 2));
    const x = position === 'left'
      ? bounds.x + PANEL_MARGIN
      : bounds.x + bounds.width - PANEL_WIDTH - PANEL_MARGIN;
    const y = bounds.y + PANEL_MARGIN;
    return { x, y, height };
  };

  /** The payload pushed to the panel renderer ({ position, enabled,
   *  hotkeyLetter } - the HUD's push parity; the letter rides it so the
   *  panel can render its own shortcut hint). */
  const payload = () => ({
    position: applied.position,
    enabled: applied.enabled,
    hotkeyLetter: applied.hotkeyLetter,
  });

  return {
    getWindow: () => (win && !win.isDestroyed() ? win : null),

    getState() {
      const alive = win && !win.isDestroyed();
      return {
        exists: !!alive,
        visible: alive ? win.isVisible() : false,
        bounds: alive ? win.getBounds() : null,
        position: applied.position,
        enabled: applied.enabled,
        // M23: derived LIVE from the second hotkey seam's current flag - a
        // mid-session re-register failure must surface immediately (the
        // renderer re-queries get-state on every render).
        hotkeyRegistered,
      };
    },

    /**
     * Idempotently apply the geometry + visibility from the given settings
     * (boot + every settings change). The geometry and the push to the
     * renderer happen TOGETHER - the panel renders against the SAME pushed
     * position/hotkeyLetter the window was placed with.
     */
    apply(rawSettings) {
      applied = normalizeSettings(rawSettings);
      if (!win) build();
      if (win && !win.isDestroyed()) {
        const { bounds } = screen.getPrimaryDisplay();
        const geom = geometryFor(applied.position, bounds);
        win.setBounds({
          x: geom.x,
          y: geom.y,
          width: PANEL_WIDTH,
          height: geom.height,
        });
        if (applied.enabled) {
          if (!win.isVisible()) win.show();
          try {
            win.setAlwaysOnTop(true, 'screen-saver');
          } catch {
            // never throw through the apply path
          }
          visible = true;
        } else {
          if (win.isVisible()) win.hide();
          visible = false;
        }
        win.webContents.send('advanced-overlay:settings', payload());
      }
    },

    /**
     * M23 (M7b fix-5 semantics): the SHORTCUT toggle - the hotkey + the
     * 'advanced-overlay:toggle' channel both end here.
     * advancedOverlayEnabled (persisted) is the MASTER switch, set ONLY by
     * the Overlay view's Advanced card (profilesSettingsSave ->
     * onAdvancedOverlaySettings -> apply()). When the master is OFF the
     * shortcut does NOTHING (no window change, no persist); when ON it flips
     * the SESSION visibility only - it NEVER writes advancedOverlayEnabled
     * (the persisted master stays; a reboot shows the panel again when it is
     * enabled). apply() is the only path that shows/hides on the master.
     */
    async toggle() {
      if (!applied.enabled) return;
      const next = !visible;
      const alive = win && !win.isDestroyed();
      if (alive) {
        if (next) win.show();
        else win.hide();
      }
      visible = next;
    },

    /** M23 (step-4 S1): the panel's custom close button - a SESSION hide.
     *  Performs the hide DIRECTLY (the original design routed through an
     *  injected `close` op that main.js never provided, leaving the X a
     *  dead no-op). Never touches the persisted master, never closes the
     *  main window; the hotkey can re-show the panel. */
    async closePanel() {
      const alive = win && !win.isDestroyed();
      if (alive) win.hide();
      visible = false;
    },

    /** The hotkey seam's live flag (main.js product: register's return;
     *  ui-verify: the counting probe's failure fake). */
    setHotkeyRegistered(flag) {
      hotkeyRegistered = flag === true;
    },

    destroy() {
      if (win && !win.isDestroyed()) {
        win.destroy();
      }
      win = null;
    },
  };
}