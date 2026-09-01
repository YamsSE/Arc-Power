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
import { applyWindowIconLifecycle, resolveWindowIconPath } from './window-icon.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The base overlay size (CSS px at scale 1.0) - the stock RTSS-ish size.
 *  The renderer's HUD spans this width (the overlay.css rem sizes derive
 *  from the same 14px base font at scale 1.0); the ui-verify corner assert
 *  pins the resulting geometry live, so a drift fails the verify.
 *  M13: the height grew from 150 to 170 - the SIX stat lines (FPS, CPU,
 *  RAM, GPU, VRAM, API) + the frametime strip + the value line measure
 *  ~162 px and the base needs the headroom.
 *  M16 (amended 2026-08-11): the height stays 170 - the standalone Voltage
 *  row is GONE (the GPU voltage is a field INSIDE the GPU row now), so the
 *  M16 200px bump is rolled back. */
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
// M16: 'gpu-voltage' (the GPU-row voltage field - the amended shape has NO
// standalone Voltage row) joins after 'gpu-clock'; 'gpu-mem-clock' LEFT the
// GPU row (it leads the VRAM row now) and 'gpu-vram-temp' (the VRAM row's
// trailing field) closes the GPU stats.
const OVERLAY_STAT_IDS = [
  'fps', 'fps-avg', 'fps-01pct-low', 'fps-1pct-low', 'fps-99pct', 'api', 'cpu-util', 'cpu-clock', 'cpu-temp', 'cpu-power',
  'memory-util', 'gpu-util', 'gpu-clock', 'gpu-voltage',
  'gpu-temp', 'gpu-power', 'gpu-fan', 'gpu-mem-clock', 'gpu-vram', 'gpu-vram-temp', 'frametime',
];
// M17g (the user's stock overlay settings): the DEFAULT overlayStats set -
// the user's 11 ON / the others OFF (the same default the store +
// renderer/pure/overlay.ts carry - keep the three in lockstep). The
// normalize's absent/garbage fallback (the store always normalizes, so
// this fires only for direct callers without a stats field).
const OVERLAY_STATS_DEFAULT = [
  'fps', 'api', 'cpu-util', 'cpu-temp', 'cpu-power',
  'memory-util', 'gpu-util', 'gpu-temp', 'gpu-power', 'gpu-vram', 'frametime',
];
// M6: the stock overlay text color (white - the M5 pre-color default).
const OVERLAY_COLOR_DEFAULT = '#ffffff';
// M7b: the overlay background box - black at 0.5 opacity (the defaults
// when absent/garbage; the renderer mirror lives in pure/overlay.ts).
const OVERLAY_BG_COLOR_DEFAULT = '#000000';
const OVERLAY_BG_OPACITY_DEFAULT = 0.5;
// M24: the overlay THEME ids (the persisted-truth owner is profile-store.js;
// the renderer mirror is pure/overlay.ts - keep the three in lockstep).
// 'arc' is the PRODUCT default (the Intel-Arc harness redesign; 'classic'
// stays one click away via the Overlay Settings Theme row).
const OVERLAY_THEMES = ['classic', 'arc'];
const OVERLAY_THEME_DEFAULT = 'arc';

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
  // the DEFAULT set - M17g: the user's 11 ON / the others OFF, the same
  // default the store + the renderer pure mirror carry). M16 (B1): this
  // normalize is the FILTER-only mirror - the persisted one-time upgrade of
  // old lists (the M15 -> M16 stat ids) runs in the store's v2 -> v3
  // migration, so a stat the user just unchecked is never resurrected here.
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
  let stats = OVERLAY_STATS_DEFAULT;
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
  const deviceKeys = Array.isArray(raw.deviceKeys)
    ? [...new Set(raw.deviceKeys.filter((key) => typeof key === 'string' && key.length > 0 && key.length <= 256))]
    : null;
  return {
    enabled: raw.enabled === true,
    position,
    scale,
    hotkeyLetter,
    color,
    deviceKeys,
    stats,
    overlayBgEnabled: raw.overlayBgEnabled === true,
    overlayBgColor: bgColor,
    overlayBgOpacity: bgOpacity,
    // M17b: the chip-name row labels - off when absent/garbage (the stock
    // 'CPU '/'GPU ' prefixes; the payload carries the flag so the overlay
    // renderer can fetch + apply the chip names).
    overlayChipNames: raw.overlayChipNames === true,
    // M17e: the overlay polling-rate - clamped to the 100-2000 ms range,
    // 400 ms when absent/garbage (M17g: the stock polling rate FLIPS 500 ->
    // 400 - the telemetry-service default; the payload carries it so the
    // renderer/verify know the cadence - the cadence itself is owned by
    // ipc-core's startTelemetry + the live restart).
    overlayPollMs: typeof raw.overlayPollMs === 'number'
      && Number.isFinite(raw.overlayPollMs)
      ? Math.min(2000, Math.max(100, Math.round(raw.overlayPollMs)))
      : 400,
    // M24: the overlay theme - 'arc' when absent/garbage (the redesign IS
    // the product default; 'classic' stays one click away). The payload
    // carries the theme so the renderer applies it from the push (the
    // single-source-of-truth rule).
    theme: OVERLAY_THEMES.includes(raw.theme) ? raw.theme : OVERLAY_THEME_DEFAULT,
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
 *   apply: (settings: object, options?: { preserveVisibility?: boolean }) => void,
 *                                        // idempotent geometry + visibility
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
  // M24 (user): the overlay must NOT show on boot  -  only when the shortcut
  // is pressed. The first apply() is the boot apply: it applies geometry +
  // pushes settings but does NOT show the window. Subsequent applies
  // (Settings toggle) show/hide normally.
  let bootApply = true;
  // The applied settings (the single source the geometry + the pushed
  // 'overlay:settings' payload both derive from - M7: the push and the
  // resize are applied together, never a race).
  let applied = normalizeSettings(getOverlaySettings());
  let measuredDeviceCount = 1;

  const build = () => {
    if (win && !win.isDestroyed()) return win;
    const { bounds } = screen.getPrimaryDisplay();
    const size = sizeFor(applied.scale);
    win = new BrowserWindow({
      width: size.width,
      height: size.height,
      x: xFor(applied.position, bounds, size.width),
      y: yFor(applied.position, bounds, size.height),
      icon: resolveWindowIconPath(),
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
    applyWindowIconLifecycle(win);
    // The always-on-top level 'screen-saver' (above normal windows + the
    // taskbar edge cases); the overlay never takes focus or mouse input.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    // M16 (the always-on-top investigation): Windows DWM does not guarantee
    // a topmost window stays above every windowed/borderless program - a
    // game can re-raise itself above the overlay (SetWindowPos z-order
    // fights are common with borderless fullscreen; exclusive fullscreen
    // still bypasses the desktop entirely - the documented limit). The
    // mitigation: REASSERT the topmost flag periodically + on show, so the
    // overlay climbs back over any window that jumped it. The reassert is
    // cheap (a no-op SetWindowPos when nothing changed) and only runs while
    // the overlay is visible.
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
  const sizeFor = (scale) => {
    // M36: each monitored secondary GPU adds a GPU + VRAM pair. Keep the
    // stock 170px geometry unchanged until the renderer reports the actual
    // all-devices inventory; explicit per-GPU selections are still known
    // synchronously from the persisted keys.
    const configuredCount = Array.isArray(applied.deviceKeys)
      ? applied.deviceKeys.length
      : 1;
    const deviceCount = Math.max(configuredCount, measuredDeviceCount);
    const secondaryCount = Math.max(0, deviceCount - 1);
    return {
      width: Math.round(OVERLAY_BASE_WIDTH * scale),
      height: Math.round((OVERLAY_BASE_HEIGHT + secondaryCount * 28) * scale),
    };
  };

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
    deviceKeys: applied.deviceKeys,
    // M7b: the background box rides the same push - without the three
    // fields the renderer would always apply the defaults and the box
    // would never appear (the main.js applyOverlaySettings MUST forward
    // them - plan-review F2).
    overlayBgEnabled: applied.overlayBgEnabled,
    overlayBgColor: applied.overlayBgColor,
    overlayBgOpacity: applied.overlayBgOpacity,
    // M17b: the chip-name row labels ride the same push - without the flag
    // the renderer would never know when to apply the chip names (the
    // main.js applyOverlaySettings MUST forward it - the overlay.js
    // normalize is the final gate).
    overlayChipNames: applied.overlayChipNames,
    // M17e: the polling-rate rides the same push (the main.js forwarding +
    // the normalize clamp are the final gates for garbage).
    overlayPollMs: applied.overlayPollMs,
    // M24: the theme rides the same push - without it the renderer would
    // never know when to flip the arc harness / the classic HUD (the
    // main.js applyOverlaySettings MUST forward it; the normalize is the
    // final gate).
    theme: applied.theme,
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
    resize(deviceCount) {
      if (!Number.isInteger(deviceCount) || deviceCount < 1) return;
      measuredDeviceCount = Math.min(32, deviceCount);
      if (!win || win.isDestroyed()) return;
      const { bounds } = screen.getPrimaryDisplay();
      const size = sizeFor(applied.scale);
      win.setBounds({
        x: xFor(applied.position, bounds, size.width),
        y: yFor(applied.position, bounds, size.height),
        width: size.width,
        height: size.height,
      });
    },

    /**
     * Idempotently apply the geometry + visibility from the given settings
     * (boot + every settings change). The resize and the push to the
     * renderer happen TOGETHER (M7) - the renderer re-renders against the
     * SAME pushed scale the window was resized with (no race, no clipping).
     */
    apply(rawSettings, { preserveVisibility = false } = {}) {
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
        // M24 (user): the first apply() is the boot apply  -  apply geometry
        // + push settings but do NOT show the window. The hotkey still works
        // (toggle() checks applied.enabled, not visible). Subsequent applies
        // (Settings toggle) show/hide normally.
        if (preserveVisibility) {
          // Geometry/content changes must not turn a shortcut-hidden HUD
          // back on. The master overlayEnabled change is the only settings
          // reaction that owns session visibility.
        } else if (bootApply) {
          bootApply = false;
        } else if (applied.enabled) {
          if (!win.isVisible()) win.show();
          // M16: reassert the topmost state right after a show - a
          // show() can land the window under a program that raised itself
          // while the overlay was hidden.
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
