// Compatibility-facing store API backed by the native host's private store
// service. Directory properties describe local ownership only: no path or
// authority is transmitted to the host by this adapter.
import path from 'node:path';
import os from 'node:os';

function settingsObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Native store returned invalid settings cache');
  return value;
}

export class NativeProfileStore {
  constructor({ dir, ocModeDefault, request } = {}) {
    if (typeof request !== 'function') throw new TypeError('Native store requires a private request function');
    this.dir = dir ?? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
    this.ocModeDefault = ocModeDefault === 'advanced' ? 'advanced' : 'stock';
    this.profilesPath = path.join(this.dir, 'profiles.json');
    this.settingsPath = path.join(this.dir, 'settings.json');
    this._request = request;
    this._settingsCache = null;
  }

  async loadProfiles() {
    return this._request('load-profiles', []);
  }

  async saveProfiles(profiles) {
    await this._request('save-profiles', [profiles]);
  }

  async saveProfile(profile) {
    await this._request('save-profile', [profile]);
  }

  async deleteProfile(id) {
    const result = await this._request('delete-profile', [id]);
    if (typeof result !== 'boolean') throw new TypeError('Native store returned invalid delete result');
    return result;
  }

  async loadSettings() {
    const settings = settingsObject(await this._request('load-settings', []));
    this._settingsCache = settings;
    return settings;
  }

  loadSettingsSync() {
    return this._settingsCache ? { ...this._settingsCache } : null;
  }

  acceptSettingsSnapshot(settings) {
    this._settingsCache = settingsObject(settings);
  }

  async _saveSettings(method, args) {
    const response = await this._request(method, args);
    const cache = settingsObject(response?.cache);
    this._settingsCache = cache;
  }

  async saveSettings(settings) {
    await this._saveSettings('save-settings', [settings]);
  }

  async patchSettings(patch) {
    await this._saveSettings('patch-settings', [patch]);
  }

  async applyOverlayLayout(layout) {
    await this._saveSettings('apply-overlay-layout', [layout]);
  }

  async saveArcSleepState(patch = {}) {
    await this._saveSettings('save-arc-sleep-state', [patch]);
  }

  async saveSettingsWithArcSleep(settings, arcSleepPatch) {
    await this._saveSettings('save-settings-with-arc-sleep', [settings, arcSleepPatch]);
  }
}
