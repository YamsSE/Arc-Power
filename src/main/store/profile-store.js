// Arc Power — M1 ProfileStore: profiles.json + settings.json at
// %APPDATA%\ArcPower, schemaVersion'd, migrated on load, written
// atomically (temp file + rename) so a crash mid-write can never corrupt
// the real file. Unknown/newer schema versions are refused with a clear
// error — never clobbered.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { migrateStoreData, SCHEMA_VERSION } from './migrations.js';

function defaultDataDir() {
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
}

/**
 * @typedef {import('../backend/backend.interface.js').Profile} Profile
 */

export class ProfileStore {
  /**
   * @param {{ dir?: string, ocModeDefault?: 'stock'|'advanced' }} opts —
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
    // .then) and calling event.preventDefault() too late — the window had
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
   * rename guarantees the renamed file is flushed to disk — a power loss
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
      // M4-D2 (user-reported): tolerate a UTF-8 BOM — a settings/profiles
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
   * M4-F: `deviceId` — the persisted GPU selection (number | null). Absent
   * on old files -> null (the devices[0] default resolves at boot); stored
   * via the device-set channel, NEVER through profiles-settings-save (which
   * carries it read-modify-write so a Settings/Profiles save can never
   * clobber it).
   * @returns {Promise<{ waiverAccepted: boolean, ocOnBoot: boolean, activeProfileId: string|null, ocMode: 'stock'|'advanced', advancedModeAccepted: boolean, startWithWindows: boolean, startMinimized: boolean, closeToTray: boolean, monitorLogToFile: boolean, deviceId: number|null }>}
   */
  async loadSettings() {
    const data = this._readMigrated(this.settingsPath, 'settings');
    const settings = this._settingsFromData(data);
    this._settingsCache = settings;
    return settings;
  }

  /**
   * M4-D2 (§1): the SYNC settings read — serves the in-memory cache
   * (initialized by the first loadSettings / updated by every
   * saveSettings). Used by main.js's window close handler where an async
   * read races the close: preventDefault() must run in the same tick.
   * Returns null when no settings have been loaded or saved yet (the
   * caller degrades to the default close behavior — never blocks).
   * @returns {object|null}
   */
  loadSettingsSync() {
    return this._settingsCache ? { ...this._settingsCache } : null;
  }

  /**
   * M4-D2: normalize one raw settings file into the canonical shape (the
   * absent-field defaults mechanism — no schema bump).
   * @param {object|null} data
   */
  _settingsFromData(data) {
    if (data === null) {
      return {
        waiverAccepted: false, ocOnBoot: false, activeProfileId: null,
        ocMode: this.ocModeDefault, advancedModeAccepted: false,
        // M4-D: absent -> false (the Settings-tab fields ride the
        // absent-field defaults mechanism — NO schema bump).
        startWithWindows: false, startMinimized: false, closeToTray: false,
        // M4-D2: absent -> false (the Monitoring log-to-file toggle).
        monitorLogToFile: false,
        // M4-F: absent -> null (the devices[0] fallback resolves at boot).
        deviceId: null,
      };
    }
    return {
      waiverAccepted: data.waiverAccepted === true,
      ocOnBoot: data.ocOnBoot === true,
      activeProfileId: typeof data.activeProfileId === 'string' ? data.activeProfileId : null,
      // M3-C-E: absent ocMode follows the store default (stock for the real
      // product, advanced for mock/ui-verify); a persisted value always wins.
      ocMode: data.ocMode === 'advanced' || data.ocMode === 'stock' ? data.ocMode : this.ocModeDefault,
      // M4-B (user): the Advanced OC Mode warning is accepted ONCE and
      // persisted — a re-boot must not re-ask. Absent on old files -> false.
      advancedModeAccepted: data.advancedModeAccepted === true,
      // M4-D: the Settings-tab fields. Absent on old files -> false (same
      // absent-field default mechanism as ocMode/advancedModeAccepted).
      startWithWindows: data.startWithWindows === true,
      startMinimized: data.startMinimized === true,
      closeToTray: data.closeToTray === true,
      // M4-D2: the Monitoring "Log to file" toggle (same mechanism).
      monitorLogToFile: data.monitorLogToFile === true,
      // M4-F: the persisted GPU selection. Absent on old files -> null
      // (devices[0] resolves at boot — same absent-field mechanism as
      // ocMode; a garbage value never crashes, it degrades to null).
      deviceId: Number.isInteger(data.deviceId) && data.deviceId >= 0 ? data.deviceId : null,
    };
  }

  /**
   * @param {{ waiverAccepted?: boolean, ocOnBoot?: boolean, activeProfileId?: string|null, ocMode?: 'stock'|'advanced', advancedModeAccepted?: boolean, startWithWindows?: boolean, startMinimized?: boolean, closeToTray?: boolean, monitorLogToFile?: boolean, deviceId?: number|null }} settings
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
      // garbage) persists as null — the boot resolution + self-heal then
      // repersists devices[0].
      deviceId: Number.isInteger(settings.deviceId) && settings.deviceId >= 0 ? settings.deviceId : null,
    });
    // M4-D2: keep the sync cache in lockstep with the persisted write — the
    // close handler must see the very toggle it just persisted.
    this._settingsCache = this._settingsFromData({
      ...settings,
      schemaVersion: SCHEMA_VERSION,
    });
  }
}
