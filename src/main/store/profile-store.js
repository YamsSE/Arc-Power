// Arc Power - M1 ProfileStore: profiles.json + settings.json at
// %APPDATA%\ArcPower, schemaVersion'd, migrated on load, written
// atomically (temp file + rename) so a crash mid-write can never corrupt
// the real file. Unknown/newer schema versions are refused with a clear
// error - never clobbered.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateStoreData, SCHEMA_VERSION } from './migrations.js';

// 1.0.1 Themes: the canonical theme ids - the persisted-truth owner of the
// list. The renderer mirror lives in src/renderer/pure/theme.ts and the
// envelope-validation mirror in src/main/ipc-core.js (keep the three in
// lockstep). Absent on old settings files -> 'dark'; a garbage value
// degrades to 'dark' at the STORE (the channel keeps the current theme -
// never a silent reset).
const THEMES = ['dark', 'midnight', 'light'];

// M5: the canonical overlay corner ids - the persisted-truth owner of the
// list (the THEMES pattern). The renderer mirror lives in
// src/renderer/pure/overlay.ts and the envelope validation in
// src/main/ipc-core.js (keep the three in lockstep). Absent on old settings
// files -> 'top-left'; a garbage value degrades to 'top-left' at the STORE.
const OVERLAY_POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
// M5: the overlay scale slider's range (mirrored in pure/overlay.ts).
const OVERLAY_SCALE_MIN = 0.5;
const OVERLAY_SCALE_MAX = 2.0;

// M6: the canonical overlay stat ids - the persisted-truth owner of the
// list (the OVERLAY_POSITIONS pattern). The renderer mirror lives in
// src/renderer/pure/overlay.ts and the envelope validation in
// src/main/ipc-core.js (keep the three in lockstep). Absent on old settings
// files -> the FULL set (the stock overlay shows everything); a garbage
// value degrades to the full set at the STORE.
// M7a: 'fps-1pct-low' + 'fps-99pct' (the 1% Low / 99% FPS row stats) ride
// the list right after the M12 AVG / 0.1% Low pair (ipc-core imports this
// list - the ids propagate automatically).
// M10a: 'api' (the foreground-window Graphics-API badge) rides AFTER
// 'fps-99pct' - the tickbox renders after '99% FPS' while the badge
// renders in its OWN standalone overlay row (M13: the apiLine - the api
// field LEFT the FPS row; the row order and the tickbox order are
// independent - the apiLine content is explicit in pure/overlay.ts).
// M12: 'fps-avg' + 'fps-01pct-low' (the window-AVG / 0.1% Low row stats)
// ride right after 'fps' (the row field order) and 'memory-util' (the
// Memory row) joins after the CPU stats; 'gpu-vram' stays where it was -
// it now feeds the standalone VRAM row.
// M13: 'cpu-power' (the CPU wattage field) joins right after 'cpu-temp'
// (the insertion shifts 'memory-util' one slot later).
// M16: 'gpu-voltage' (the standalone Voltage row) joins after 'gpu-clock';
// 'gpu-mem-clock' LEFT the GPU row (it now leads the VRAM row) and
// 'gpu-vram-temp' (the VRAM row's trailing field) closes the GPU stats.
const OVERLAY_STAT_IDS = [
  'fps', 'fps-avg', 'fps-01pct-low', 'fps-1pct-low', 'fps-99pct', 'api', 'cpu-util', 'cpu-clock', 'cpu-temp', 'cpu-power',
  'memory-util', 'gpu-util', 'gpu-clock', 'gpu-voltage',
  'gpu-temp', 'gpu-power', 'gpu-fan', 'gpu-mem-clock', 'gpu-vram', 'gpu-vram-temp', 'frametime',
];
// M6: the stock overlay text color (white - the M5 pre-color default).
const OVERLAY_COLOR_DEFAULT = '#ffffff';
// M7b: the overlay background box (the Appearance card's Background
// section) - the box color defaults to black and the opacity to 0.5 (a
// translucent box behind the HUD); garbage degrades to these at the STORE.
const OVERLAY_BG_COLOR_DEFAULT = '#000000';
const OVERLAY_BG_OPACITY_DEFAULT = 0.5;
// M17e (the user addition - the overlay polling-rate slider): the
// telemetry push cadence range + default (100-2000 ms, step 50, default
// 500 - the telemetry-service default). The persisted-truth owner; the
// renderer slider (overlay-settings.ts) + the ipc-core patch validation
// mirror the clamp. Absent on old files -> 500; garbage degrades to 500.
const OVERLAY_POLL_MS_DEFAULT = 500;
const OVERLAY_POLL_MS_MIN = 100;
const OVERLAY_POLL_MS_MAX = 2000;

export { THEMES, OVERLAY_POSITIONS, OVERLAY_STAT_IDS, OVERLAY_COLOR_DEFAULT, OVERLAY_POLL_MS_DEFAULT };

function defaultDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
}

/** M6: clamp a scale value to the slider's range (garbage degrades to 1.0). */
function clampOverlayScale(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : 1.0;
  return Math.min(OVERLAY_SCALE_MAX, Math.max(OVERLAY_SCALE_MIN, n));
}

/** M7b: clamp the background opacity to 0..1 (garbage degrades to the 0.5
 *  default - the same clamp semantics as the scale slider). */
function clampOverlayBgOpacity(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : OVERLAY_BG_OPACITY_DEFAULT;
  return Math.min(1, Math.max(0, n));
}

/** M17e: clamp the overlay polling rate to the slider's 100-2000 ms range
 *  (garbage degrades to the 500 ms default - the same clamp semantics as
 *  the scale slider; the slider cannot produce an out-of-range value). */
function clampOverlayPollMs(v) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : OVERLAY_POLL_MS_DEFAULT;
  return Math.min(OVERLAY_POLL_MS_MAX, Math.max(OVERLAY_POLL_MS_MIN, Math.round(n)));
}

/** M6: normalize a raw overlayStats value - an array of KNOWN ids, deduped
 *  (order preserved); absent/garbage -> the FULL set (the stock default).
 *  The store mirror of the renderer's normalizeOverlayStats.
 *  M16 (B1): this normalize is deliberately FILTER-ONLY - the one-time
 *  upgrade of PERSISTED pre-M16 lists (gaining 'gpu-voltage' +
 *  'gpu-vram-temp') runs in the store's v2 -> v3 schema migration, NOT
 *  here. A save-path union would resurrect a stat the user just unchecked
 *  (the tickbox round trip). A file at v3 already carries the user's
 *  choices; the migration ran exactly once. */
function normalizeOverlayStats(v) {
  if (!Array.isArray(v)) return [...OVERLAY_STAT_IDS];
  const seen = new Set();
  const out = [];
  for (const id of v) {
    if (typeof id === 'string' && OVERLAY_STAT_IDS.includes(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * @typedef {import('../backend/backend.interface.js').Profile} Profile
 */

export class ProfileStore {
  /**
   * @param {{ dir?: string, ocModeDefault?: 'stock'|'advanced' }} opts -
   *   dir defaults to %APPDATA%\ArcPower; ocModeDefault is the mode used
   *   while settings.json has no persisted ocMode (M3-C-E: real product
   *   default 'stock', mock/ui-verify default 'advanced').
   */
  constructor(opts = {}) {
    this.dir = opts.dir ?? defaultDataDir();
    this.ocModeDefault = opts.ocModeDefault === 'advanced' ? 'advanced' : 'stock';
    this.profilesPath = path.join(this.dir, 'profiles.json');
    this.settingsPath = path.join(this.dir, 'settings.json');
    // M4-D2 (§1 close-to-tray fix): the in-memory settings cache. The REAL
    // bug was main.js's close handler reading settings ASYNC (loadSettings
    // .then) and calling event.preventDefault() too late - the window had
    // already closed. The close handler now reads loadSettingsSync()
    // SYNCHRONOUSLY. The cache is initialized by the first loadSettings
    // (and refreshed by every subsequent one); saveSettings updates it in
    // the same write, so the sync view never lags the persisted truth.
    this._settingsCache = null;
  }

  _ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Atomic write: temp file in the same directory, fsync'd, then renamed
   * over the target (same volume -> atomic replace). The fsync before the
   * rename guarantees the renamed file is flushed to disk - a power loss
   * right after the rename cannot leave an empty/unflushed target. A stale
   * .tmp from a previous crash is cleaned up.
   * @param {string} filePath
   * @param {object} data
   */
  _writeAtomic(filePath, data) {
    this._ensureDir();
    const tmp = `${filePath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, filePath);
  }

  /**
   * Read + migrate a store file. Missing file -> null; newer/unknown schema
   * -> throw; corrupt JSON -> throw. When a migration actually ran, the
   * migrated data is persisted back (one-time upgrade on load).
   * @param {string} filePath
   * @param {'profiles'|'settings'} kind
   * @returns {object|null}
   */
  _readMigrated(filePath, kind) {
    if (!fs.existsSync(filePath)) return null;
    // Clean up any stale temp from a crashed writer before the next write.
    const tmp = `${filePath}.tmp`;
    if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch { /* best effort */ } }
    const raw = fs.readFileSync(filePath, 'utf8');
    let data;
    try {
      // M4-D2 (reported): tolerate a UTF-8 BOM - a settings/profiles
      // file saved by a third-party tool with a BOM (or an editor save)
      // must never brick every settings operation with an opaque parse
      // error. The app's own writer never emits a BOM.
      data = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch (err) {
      throw new Error(`Cannot load ${path.basename(filePath)}: invalid JSON (${err.message})`);
    }
    const pre = data.schemaVersion ?? 0;
    const migrated = migrateStoreData(data, kind);
    if (pre !== migrated.schemaVersion) this._writeAtomic(filePath, migrated);
    return migrated;
  }

  /**
   * @returns {Promise<Profile[]>}
   */
  async loadProfiles() {
    const data = this._readMigrated(this.profilesPath, 'profiles');
    if (data === null) return [];
    if (!Array.isArray(data.profiles)) {
      throw new Error('profiles.json is missing the "profiles" array');
    }
    return data.profiles;
  }

  /**
   * @param {Profile[]} profiles
   */
  async saveProfiles(profiles) {
    this._writeAtomic(this.profilesPath, { schemaVersion: SCHEMA_VERSION, profiles });
  }

  /**
   * @param {Profile} profile
   */
  async saveProfile(profile) {
    const profiles = await this.loadProfiles();
    const idx = profiles.findIndex((p) => p.id === profile.id);
    if (idx >= 0) profiles[idx] = { ...profile, schemaVersion: SCHEMA_VERSION };
    else profiles.push({ ...profile, schemaVersion: SCHEMA_VERSION });
    await this.saveProfiles(profiles);
  }

  /**
   * @param {string} id
   * @returns {Promise<boolean>} true when a profile was deleted
   */
  async deleteProfile(id) {
    const profiles = await this.loadProfiles();
    const next = profiles.filter((p) => p.id !== id);
    if (next.length === profiles.length) return false;
    await this.saveProfiles(next);
    return true;
  }

  /**
   * M4-F: `deviceId` - the persisted GPU selection (number | null). Absent
   * on old files -> null (the devices[0] default resolves at boot); stored
   * via the device-set channel, NEVER through profiles-settings-save (which
   * carries it read-modify-write so a Settings/Profiles save can never
   * clobber it).
   * M5: the software-overlay fields (overlayEnabled/overlayHotkeyLetter/
   * overlayPosition/overlayScale) - absent on old files -> the defaults.
   * M6: overlayColor + overlayStats ride the same mechanism (stock white +
   * the full stat set when absent).
   * M7b: overlayBgEnabled/overlayBgColor/overlayBgOpacity (the background
   * box) ride it too (off / #000000 / 0.5 when absent).
   * M17b: overlayChipNames (the chip-name row labels) rides it too (off =
   * the stock 'CPU '/'GPU ' prefixes when absent).
   * M17e: overlayPollMs (the overlay telemetry push cadence) rides it too
   * (500 ms when absent).
   * @returns {Promise<{ waiverAccepted: boolean, ocOnBoot: boolean, activeProfileId: string|null, ocMode: 'stock'|'advanced', advancedModeAccepted: boolean, startWithWindows: boolean, startMinimized: boolean, closeToTray: boolean, monitorLogToFile: boolean, deviceId: number|null, theme: 'dark'|'midnight'|'light', overlayEnabled: boolean, overlayHotkeyLetter: string, overlayPosition: string, overlayScale: number, overlayColor: string, overlayStats: string[], overlayBgEnabled: boolean, overlayBgColor: string, overlayBgOpacity: number, overlayChipNames: boolean, overlayPollMs: number }>}
   */
  async loadSettings() {
    const data = this._readMigrated(this.settingsPath, 'settings');
    const settings = this._settingsFromData(data);
    this._settingsCache = settings;
    return settings;
  }

  /**
   * M4-D2 (§1): the SYNC settings read - serves the in-memory cache
   * (initialized by the first loadSettings / updated by every
   * saveSettings). Used by main.js's window close handler where an async
   * read races the close: preventDefault() must run in the same tick.
   * Returns null when no settings have been loaded or saved yet (the
   * caller degrades to the default close behavior - never blocks).
   * @returns {object|null}
   */
  loadSettingsSync() {
    return this._settingsCache ? { ...this._settingsCache } : null;
  }

  /**
   * M4-D2: normalize one raw settings file into the canonical shape (the
   * absent-field defaults mechanism - no schema bump).
   * @param {object|null} data
   */
  _settingsFromData(data) {
    if (data === null) {
      return {
        waiverAccepted: false, ocOnBoot: false, activeProfileId: null,
        ocMode: this.ocModeDefault, advancedModeAccepted: false,
        // M4-D: absent -> false (the Settings-tab fields ride the
        // absent-field defaults mechanism - NO schema bump).
        startWithWindows: false, startMinimized: false, closeToTray: false,
        // M4-D2: absent -> false (the Monitoring log-to-file toggle).
        monitorLogToFile: false,
        // M4-F: absent -> null (the devices[0] fallback resolves at boot).
        deviceId: null,
        // 1.0.1 Themes: absent -> 'dark' (same absent-field mechanism).
        theme: 'dark',
        // M5: the software-overlay settings. Absent on old files -> the
        // defaults (enabled off, letter 'O', top-left, scale 1.0 - the same
        // absent-field mechanism, NO schema bump).
        // M6: the color defaults to the stock white '#ffffff' and the stats
        // to the FULL set (the stock overlay shows everything) - same
        // absent-field mechanism.
        overlayEnabled: false,
        overlayHotkeyLetter: 'O',
        overlayPosition: 'top-left',
        overlayScale: 1.0,
        overlayColor: OVERLAY_COLOR_DEFAULT,
        overlayStats: [...OVERLAY_STAT_IDS],
        // M7b: the background box - absent -> off, black, 0.5 opacity (the
        // same absent-field mechanism, NO schema bump).
        overlayBgEnabled: false,
        overlayBgColor: OVERLAY_BG_COLOR_DEFAULT,
        overlayBgOpacity: OVERLAY_BG_OPACITY_DEFAULT,
        // M17b: the chip-name row labels - absent -> off (the stock
        // 'CPU '/'GPU ' prefixes; the same absent-field mechanism, NO
        // schema bump - the overlay renderer reads the pushed setting).
        overlayChipNames: false,
        // M17e: the overlay polling-rate - absent -> 500 ms (the same
        // absent-field mechanism; the telemetry-service default).
        overlayPollMs: OVERLAY_POLL_MS_DEFAULT,
      };
    }
    return {
      waiverAccepted: data.waiverAccepted === true,
      ocOnBoot: data.ocOnBoot === true,
      activeProfileId: typeof data.activeProfileId === 'string' ? data.activeProfileId : null,
      // M3-C-E: absent ocMode follows the store default (stock for the real
      // product, advanced for mock/ui-verify); a persisted value always wins.
      ocMode: data.ocMode === 'advanced' || data.ocMode === 'stock' ? data.ocMode : this.ocModeDefault,
      // M4-B: the Advanced OC Mode warning is accepted ONCE and
      // persisted - a re-boot must not re-ask. Absent on old files -> false.
      advancedModeAccepted: data.advancedModeAccepted === true,
      // M4-D: the Settings-tab fields. Absent on old files -> false (same
      // absent-field default mechanism as ocMode/advancedModeAccepted).
      startWithWindows: data.startWithWindows === true,
      startMinimized: data.startMinimized === true,
      closeToTray: data.closeToTray === true,
      // M4-D2: the Monitoring "Log to file" toggle (same mechanism).
      monitorLogToFile: data.monitorLogToFile === true,
      // M4-F: the persisted GPU selection. Absent on old files -> null
      // (devices[0] resolves at boot - same absent-field mechanism as
      // ocMode; a garbage value never crashes, it degrades to null).
      deviceId: Number.isInteger(data.deviceId) && data.deviceId >= 0 ? data.deviceId : null,
      // 1.0.1 Themes: the persisted UI theme. Absent on old files -> 'dark'
      // (same absent-field mechanism); a garbage value degrades to 'dark'
      // - never a crash.
      theme: THEMES.includes(data.theme) ? data.theme : 'dark',
      // M5: the software-overlay settings (same mechanism): enabled off
      // when absent, the letter 'O', top-left, scale 1.0; a garbage value
      // degrades to the default - never a crash.
      overlayEnabled: data.overlayEnabled === true,
      overlayHotkeyLetter: typeof data.overlayHotkeyLetter === 'string'
        && /^[A-Za-z]$/.test(data.overlayHotkeyLetter)
        ? data.overlayHotkeyLetter
        : 'O',
      overlayPosition: OVERLAY_POSITIONS.includes(data.overlayPosition)
        ? data.overlayPosition
        : 'top-left',
      overlayScale: clampOverlayScale(data.overlayScale),
      // M6: the overlay text color - a /^#[0-9a-fA-F]{6}$/ hex or the stock
      // white default (same absent-field mechanism; a garbage value never
      // crashes).
      overlayColor: typeof data.overlayColor === 'string'
        && /^#[0-9a-fA-F]{6}$/.test(data.overlayColor)
        ? data.overlayColor
        : OVERLAY_COLOR_DEFAULT,
      // M6: the enabled stat ids - known ids only, deduped; absent/garbage
      // degrades to the FULL set (the stock overlay).
      overlayStats: normalizeOverlayStats(data.overlayStats),
      // M7b: the background box - enabled off / black / 0.5 opacity when
      // absent; a garbage value degrades to the default - never a crash.
      overlayBgEnabled: data.overlayBgEnabled === true,
      overlayBgColor: typeof data.overlayBgColor === 'string'
        && /^#[0-9a-fA-F]{6}$/.test(data.overlayBgColor)
        ? data.overlayBgColor
        : OVERLAY_BG_COLOR_DEFAULT,
      overlayBgOpacity: clampOverlayBgOpacity(data.overlayBgOpacity),
      // M17b: the chip-name row labels - absent on old files -> false (the
      // stock 'CPU '/'GPU ' prefixes; a garbage value degrades to false -
      // never a crash).
      overlayChipNames: data.overlayChipNames === true,
      // M17e: the overlay polling-rate - absent on old files -> 500 ms (the
      // telemetry-service default; a garbage value degrades to 500 - never
      // a crash, never an out-of-range cadence).
      overlayPollMs: clampOverlayPollMs(data.overlayPollMs),
    };
  }

  /**
   * @param {{ waiverAccepted?: boolean, ocOnBoot?: boolean, activeProfileId?: string|null, ocMode?: 'stock'|'advanced', advancedModeAccepted?: boolean, startWithWindows?: boolean, startMinimized?: boolean, closeToTray?: boolean, monitorLogToFile?: boolean, deviceId?: number|null, theme?: 'dark'|'midnight'|'light', overlayEnabled?: boolean, overlayHotkeyLetter?: string, overlayPosition?: string, overlayScale?: number, overlayColor?: string, overlayStats?: string[], overlayBgEnabled?: boolean, overlayBgColor?: string, overlayBgOpacity?: number, overlayChipNames?: boolean, overlayPollMs?: number }} settings
   */
  async saveSettings(settings) {
    this._writeAtomic(this.settingsPath, {
      schemaVersion: SCHEMA_VERSION,
      waiverAccepted: settings.waiverAccepted === true,
      ocOnBoot: settings.ocOnBoot === true,
      activeProfileId: settings.activeProfileId ?? null,
      ocMode: settings.ocMode === 'advanced' || settings.ocMode === 'stock' ? settings.ocMode : this.ocModeDefault,
      advancedModeAccepted: settings.advancedModeAccepted === true,
      startWithWindows: settings.startWithWindows === true,
      startMinimized: settings.startMinimized === true,
      closeToTray: settings.closeToTray === true,
      monitorLogToFile: settings.monitorLogToFile === true,
      // M4-F: non-negative integers only; anything else (absent, null,
      // garbage) persists as null - the boot resolution + self-heal then
      // repersists devices[0].
      deviceId: Number.isInteger(settings.deviceId) && settings.deviceId >= 0 ? settings.deviceId : null,
      // 1.0.1 Themes: validated on save - an absent/garbage theme persists
      // as 'dark' (the channel already guards patch.theme, so the store
      // fallback only ever sees absent fields on direct callers).
      theme: THEMES.includes(settings.theme) ? settings.theme : 'dark',
      // M5: the software-overlay settings - validated on save like the
      // theme (the channel validates first; the store fallback covers
      // direct callers).
      overlayEnabled: settings.overlayEnabled === true,
      overlayHotkeyLetter: typeof settings.overlayHotkeyLetter === 'string'
        && /^[A-Za-z]$/.test(settings.overlayHotkeyLetter)
        ? settings.overlayHotkeyLetter
        : 'O',
      overlayPosition: OVERLAY_POSITIONS.includes(settings.overlayPosition)
        ? settings.overlayPosition
        : 'top-left',
      overlayScale: clampOverlayScale(settings.overlayScale),
      // M6: the overlay text color - validated on save like the rest (the
      // channel validates first; the store fallback covers direct callers).
      overlayColor: typeof settings.overlayColor === 'string'
        && /^#[0-9a-fA-F]{6}$/.test(settings.overlayColor)
        ? settings.overlayColor
        : OVERLAY_COLOR_DEFAULT,
      overlayStats: normalizeOverlayStats(settings.overlayStats),
      // M7b: the background box - validated on save like the rest (the
      // channel validates first; the store fallback covers direct callers).
      overlayBgEnabled: settings.overlayBgEnabled === true,
      overlayBgColor: typeof settings.overlayBgColor === 'string'
        && /^#[0-9a-fA-F]{6}$/.test(settings.overlayBgColor)
        ? settings.overlayBgColor
        : OVERLAY_BG_COLOR_DEFAULT,
      overlayBgOpacity: clampOverlayBgOpacity(settings.overlayBgOpacity),
      // M17b: the chip-name row labels - validated on save like the rest
      // (the channel validates first; the store fallback covers direct
      // callers - an absent/garbage value persists as false).
      overlayChipNames: settings.overlayChipNames === true,
      // M17e: the overlay polling-rate - clamped to the 100-2000 ms range
      // on save like the scale/opacity (the channel validates first; the
      // store fallback covers direct callers - an absent/garbage value
      // persists as the 500 ms default).
      overlayPollMs: clampOverlayPollMs(settings.overlayPollMs),
    });
    // M4-D2: keep the sync cache in lockstep with the persisted write - the
    // close handler must see the very toggle it just persisted.
    this._settingsCache = this._settingsFromData({
      ...settings,
      schemaVersion: SCHEMA_VERSION,
    });
  }
}
