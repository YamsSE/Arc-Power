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
      data = JSON.parse(raw);
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
   * @returns {Promise<{ waiverAccepted: boolean, ocOnBoot: boolean, activeProfileId: string|null, ocMode: 'stock'|'advanced', advancedModeAccepted: boolean, startWithWindows: boolean, startMinimized: boolean }>}
   */
  async loadSettings() {
    const data = this._readMigrated(this.settingsPath, 'settings');
    if (data === null) {
      return {
        waiverAccepted: false, ocOnBoot: false, activeProfileId: null,
        ocMode: this.ocModeDefault, advancedModeAccepted: false,
        // M4-D: absent -> false (the Settings-tab fields ride the
        // absent-field defaults mechanism — NO schema bump).
        startWithWindows: false, startMinimized: false,
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
    };
  }

  /**
   * @param {{ waiverAccepted?: boolean, ocOnBoot?: boolean, activeProfileId?: string|null, ocMode?: 'stock'|'advanced', advancedModeAccepted?: boolean, startWithWindows?: boolean, startMinimized?: boolean }} settings
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
    });
  }
}
