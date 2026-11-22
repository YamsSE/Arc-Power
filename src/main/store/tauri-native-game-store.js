import path from 'node:path';
import os from 'node:os';

function profileIds(value) {
  if (value == null) return null;
  if (!(value instanceof Set) && !Array.isArray(value)) throw new TypeError('validProfileIds must be a Set or array');
  return [...value];
}

/** Rust owns persistence, executable validation and the catalog path cache. */
export class NativeGameProfileStore {
  constructor({ dir, request } = {}) {
    if (typeof request !== 'function') throw new TypeError('Native game store requires a private request function');
    this.dir = dir ?? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
    this.filePath = path.join(this.dir, 'game-profiles.json');
    this._request = request;
    this._mutation = Promise.resolve();
  }
  get _mutationQueue() { return this._mutation; }
  _mutate(work) {
    const next = this._mutation.then(work, work);
    this._mutation = next.catch(() => {});
    return next;
  }
  _call(method, args) { return this._mutate(() => this._request(method, args)); }
  async load(validProfileIds = null) { return this._call('game-load', [profileIds(validProfileIds)]); }
  async save(associations) { return this._call('game-save', [associations]); }
  async upsert(raw, validProfileIds = null) { return this._call('game-upsert', [raw, profileIds(validProfileIds)]); }
  async delete(profileId, exePath, validProfileIds = null) { return this._call('game-delete', [profileId, exePath, profileIds(validProfileIds)]); }
  async cleanupProfile(profileId, validProfileIds = null) { return this._call('game-cleanup-profile', [profileId, profileIds(validProfileIds)]); }
  async loadCatalog() { return this._call('game-load-catalog', []); }
  async hasCatalogPath(value) { return this._call('game-has-catalog-path', [value]); }
  async syncCatalog(entries, options = {}) { return this._call('game-sync-catalog', [entries, options]); }
  async addCatalogEntry(raw) { return this._call('game-add-catalog-entry', [raw]); }
  async saveSettings(raw) { return this._call('game-save-settings', [raw]); }
  async deleteSettings(exePath) { return this._call('game-delete-settings', [exePath]); }
}
