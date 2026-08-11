// Arc Power - M5 software overlay (the MSI Afterburner / RTSS-style HUD).
//
// The overlay is a TRANSPARENT, frameless, always-on-top BrowserWindow that
// shows bold text over the screen/game. This module owns:
//   - the GEOMETRY: anchored to the PRIMARY display bounds; the position
//     setting (top-left STOCK / top-right / bottom-left / bottom-right)
//     with an 8px margin; the size = the base overlay size (~460x170 CSS px
//     at scale 1.0 - the stock RTSS-ish footprint) x the overlayScale;
//   - the VISIBILITY: shown when overlayEnabled (apply() drives it - the
//     enabled-driven show/hide); toggle() is the SHORTCUT flip - M7b (fix
//     5): gated on the enabled master (pressing it while the master is OFF
//     does NOTHING - no window change, no persist) and when the master is
//     ON it flips the SESSION visibility ONLY - overlayEnabled (persisted)
//     is written by NOTHING here: the Overlay-page toggle is its only
//     writer (profilesSettingsSave -> onOverlaySettings -> apply());
//   - getState() -> { exists, visible, bounds, position, scale, enabled,
//     hotkeyRegistered } - hotkeyRegistered is DERIVED LIVE from the
//     registration state the hotkey seam reports (main.js product path:
//     globalShortcut.register's return; ui-verify: the counting probe). A
//     failed register (CTRL+<letter> taken by another app) reads false and
//     the Overlay page shows the honest note;
//   - the LIFECYCLE rule (S2): the overlay NEVER keeps the app alive by
//     itself - the main window's closed event destroys it + unregisters the
//     hotkey (the pre-M5 exit behavior is preserved: closing the main
//     window with closeToTray OFF still quits the app), and will-quit
//     closes both.
//
// The window is created UNCONDITIONALLY on the product window path (HIDDEN
// when overlayEnabled is false - apply() shows it when the user enables it
// through the Overlay page; a lazy create would break the enable path).
// NEVER in headless/boot-apply/apply-profile modes; ui-verify creates it
// only under RID_MOCK_OVERLAY=1.

import { BrowserWindow, screen } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The base overlay size (CSS px at scale 1.0) - the stock RTSS-ish size.
 *  The renderer's HUD spans this width (the overlay.css rem sizes derive
 *  from the same 14px base font at scale 1.0); the ui-verify corner assert
 *  pins the resulting geometry live, so a drift fails the verify.
 *  M13: the height grew from 150 to 170 - the SIX stat lines (FPS, CPU,
 *  RAM, GPU, VRAM, API) + the frametime strip + the value line measure
 *  ~162 px and the base needs the headroom. */
const OVERLAY_BASE_WIDTH = 460;
const OVERLAY_BASE_HEIGHT = 170;
/** The margin from the display edge (every corner). */
const OVERLAY_MARGIN = 8;

const OVERLAY_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
const OVERLAY_SCALE_MIN = 0.5;
const OVERLAY_SCALE_MAX = 2.0;

// M6: the canonical overlay stat ids (the persisted-truth owner is
// profile-store.js; the renderer mirror is pure/overlay.ts - keep the
// three in lockstep like the positions).
// M7a: 'fps-1pct-low' + 'fps-99pct' (the 1% Low / 99% FPS row stats) ride
// the list right after the M12 AVG / 0.1% Low pair.
// M10a: 'api' (the foreground-window Graphics-API badge) rides AFTER
// 'fps-99pct' (the lockstep owner is profile-store.js; the renderer mirror
// is pure/overlay.ts). M13: the badge renders its OWN standalone row (the
// apiLine - the field left the FPS row).
// M12: 'fps-avg' + 'fps-01pct-low' ride right after 'fps' and
// 'memory-util' (the Memory row) joins after the CPU stats; 'gpu-vram'
// stays where it was - it now feeds the standalone VRAM row.
// M13: 'cpu-power' (the CPU wattage field) joins right after 'cpu-temp'.
const OVERLAY_STAT_IDS = [
  'fps', 'fps-avg', 'fps-01pct-low', 'fps-1pct-low', 'fps-99pct', 'api', 'cpu-util', 'cpu-clock', 'cpu-temp', 'cpu-power',
  'memory-util', 'gpu-util', 'gpu-clock', 'gpu-mem-clock', 'gpu-vram',
  'gpu-temp', 'gpu-power', 'gpu-fan', 'frametime',
];
// M6: the stock overlay text color (white - the M5 pre-color default).
const OVERLAY_COLOR_DEFAULT = '#ffffff';
// M7b: the overlay background box - black at 0.5 opacity (the defaults
// when absent/garbage; the renderer mirror lives in pure/overlay.ts).
const OVERLAY_BG_COLOR_DEFAULT = '#000000';
const OVERLAY_BG_OPACITY_DEFAULT = 0.5;

/**
 * Normalize a raw settings object into the overlay's applied shape (the
 * defaults fill absent/garbage fields - the same absent-field mechanism as
 * the store).
 * @param {object} raw
 */
function normalizeSettings(raw = {}) {
  const position = typeof raw.position === 'string' && OVERLAY_POSITIONS.includes(raw.position)
    ? raw.position
    : 'top-left';
  const scale = typeof raw.scale === 'number' && Number.isFinite(raw.scale)
    ? Math.min(OVERLAY_SCALE_MAX, Math.max(OVERLAY_SCALE_MIN, raw.scale))
    : 1.0;
  const hotkeyLetter = typeof raw.hotkeyLetter === 'string' && /^[A-Za-z]$/.test(raw.hotkeyLetter)
    ? raw.hotkeyLetter.toUpperCase()
    : 'O';
  // M6: the text color (a /^#[0-9a-fA-F]{6}$/ hex - the stock white
  // default) + the enabled stats (known ids, deduped; absent/garbage ->
  // the FULL set - the stock overlay).
  const color = typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)
    ? raw.color
    : OVERLAY_COLOR_DEFAULT;
  // M7b: the background box - enabled off / black / 0.5 opacity when
  // absent or garbage (the same absent-field mechanism).
  const bgColor = typeof raw.overlayBgColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.overlayBgColor)
    ? raw.overlayBgColor
    : OVERLAY_BG_COLOR_DEFAULT;
  const bgOpacity = typeof raw.overlayBgOpacity === 'number' && Number.isFinite(raw.overlayBgOpacity)
    ? Math.min(1, Math.max(0, raw.overlayBgOpacity))
    : OVERLAY_BG_OPACITY_DEFAULT;
  let stats = OVERLAY_STAT_IDS;
  if (Array.isArray(raw.stats)) {
    const seen = new Set();
    stats = [];
    for (const id of raw.stats) {
      if (typeof id === 'string' && OVERLAY_STAT_IDS.includes(id) && !seen.has(id)) {
        seen.add(id);
        stats.push(id);
      }
    }
  }
  return {
    enabled: raw.enabled === true,
    position,
    scale,
    hotkeyLetter,
    color,
    stats,
    overlayBgEnabled: raw.overlayBgEnabled === true,
    overlayBgColor: bgColor,
    overlayBgOpacity: bgOpacity,
  };
}

/**
 * Create the overlay window.
 * @param {{
 *   getOverlaySettings: () => object,   // the CURRENT persisted settings
 *                                       // (main.js: store.loadSettingsSync)
 * }} deps
 * @returns {{
 *   getWindow: () => import('electron').BrowserWindow | null,
 *   getState: () => { exists: boolean, visible: boolean, bounds: object | null, position: string, scale: number, enabled: boolean, hotkeyRegistered: boolean },
 *   apply: (settings: object) => void,   // idempotent geometry + visibility
 *                                        // application (boot + every change)
 *   toggle: () => Promise<void>,         // the SHORTCUT flip - gated on the
 *                                        // enabled master; never persists
 *   setHotkeyRegistered: (flag: boolean) => void,  // the hotkey seam's live flag
 *   destroy: () => void,
 * }}
 */
export function createOverlayWindow({ getOverlaySettings }) {
  let win = null;
  let visible = false;
  let hotkeyRegistered = false;
  // The applied settings (the single source the geometry + the pushed
  // 'overlay:settings' payload both derive from - M7: the push and the
  // resize are applied together, never a race).
  let applied = normalizeSettings(getOverlaySettings());

  const build = () => {
    if (win && !win.isDestroyed()) return win;
    const { bounds } = screen.getPrimaryDisplay();
    const size = sizeFor(applied.scale);
    win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: xFor(applied.position, bounds, size.width),
      y: yFor(applied.position, bounds, size.height),
      // Transparent + frameless + no shadow: the text floats directly on
      // the screen - no window chrome, no boxes.
      transparent: true,
      frame: false,
      skipTaskbar: true,
      focusable: false,
      resizable: false,
      hasShadow: false,
      // Created hidden - the visibility is applied by apply() (the
      // hotkey-enable path must work before the user ever enables it).
      show: false,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '..', 'preload.cjs'),
        // The overlay is an always-on-top HUD: Chromium must never throttle
        // its timers (the 1 s fps poll + the frametime series) when the
        // window is treated as background/occluded - a throttled page would
        // freeze the FPS line and the graph.
        backgroundThrottling: false,
      },
    });
    // The always-on-top level 'screen-saver' (above normal windows + the
    // taskbar edge cases); the overlay never takes focus or mouse input.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    win.webContents.on('console-message', (event) => {
      // Electron >= 30: the event object carries { level, message, ... }.
      const level = typeof event.level === 'number' ? event.level : 0;
      const message = typeof event.message === 'string' ? event.message : '';
      if (level >= 2) console.error(`[overlay] ${message}`);
    });
    // F3: the INITIAL 'overlay:settings' push fires right after
    // did-finish-load so the scale applies at boot (the push otherwise
    // fires only on CHANGE - the renderer would never learn the initial
    // scale). The renderer registers its listener SYNCHRONOUSLY at script
    // top, so this push is never missed.
    win.webContents.on('did-finish-load', () => {
      if (win && !win.isDestroyed()) win.webContents.send('overlay:settings', payload());
    });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'overlay.html'));
    return win;
  };

  const sizeFor = (scale) => ({
    width: Math.round(OVERLAY_BASE_WIDTH * scale),
    height: Math.round(OVERLAY_BASE_HEIGHT * scale),
  });

  const xFor = (position, bounds, width) => (
    position === 'top-right' || position === 'bottom-right'
      ? bounds.x + bounds.width - width - OVERLAY_MARGIN
      : bounds.x + OVERLAY_MARGIN
  );

  const yFor = (position, bounds, height) => (
    position === 'bottom-left' || position === 'bottom-right'
      ? bounds.y + bounds.height - height - OVERLAY_MARGIN
      : bounds.y + OVERLAY_MARGIN
  );

  /** The payload pushed to the overlay renderer (the scale source of truth). */
  const payload = () => ({
    enabled: applied.enabled,
    position: applied.position,
    scale: applied.scale,
    hotkeyLetter: applied.hotkeyLetter,
    // M6: the color + the stats ride the same push - the renderer applies
    // them via CSSOM on every settings push (a color/stats change must
    // re-render the HUD immediately, not on the next telemetry tick).
    color: applied.color,
    stats: applied.stats,
    // M7b: the background box rides the same push - without the three
    // fields the renderer would always apply the defaults and the box
    // would never appear (the main.js applyOverlaySettings MUST forward
    // them - plan-review F2).
    overlayBgEnabled: applied.overlayBgEnabled,
    overlayBgColor: applied.overlayBgColor,
    overlayBgOpacity: applied.overlayBgOpacity,
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
        scale: applied.scale,
        enabled: applied.enabled,
        // M1: derived LIVE from the hotkey seam's current flag - a
        // mid-session re-register failure must surface immediately (the
        // Overlay page re-queries get-state on every render).
        hotkeyRegistered,
      };
    },

    /**
     * Idempotently apply the geometry + visibility from the given settings
     * (boot + every settings change). The resize and the push to the
     * renderer happen TOGETHER (M7) - the renderer re-renders against the
     * SAME pushed scale the window was resized with (no race, no clipping).
     */
    apply(rawSettings) {
      applied = normalizeSettings(rawSettings);
      if (!win) build();
      if (win && !win.isDestroyed()) {
        const { bounds } = screen.getPrimaryDisplay();
        const size = sizeFor(applied.scale);
        win.setBounds({
          x: xFor(applied.position, bounds, size.width),
          y: yFor(applied.position, bounds, size.height),
          width: size.width,
          height: size.height,
        });
        if (applied.enabled) {
          if (!win.isVisible()) win.show();
          visible = true;
        } else {
          if (win.isVisible()) win.hide();
          visible = false;
        }
        win.webContents.send('overlay:settings', payload());
      }
    },

    /**
     * M7b (fix 5): the SHORTCUT toggle - the hotkey + the 'overlay:toggle'
     * channel both end here. overlayEnabled (persisted) is the MASTER
     * switch, set ONLY by the Overlay-page toggle (profilesSettingsSave ->
     * onOverlaySettings -> apply()). When the master is OFF the shortcut
     * does NOTHING (no window change, no persist - the pre-fix behavior
     * showed the overlay + flipped the persisted state); when ON it flips
     * the SESSION visibility only - it NEVER writes overlayEnabled (the
     * persisted master stays; a reboot shows the overlay again when it is
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
