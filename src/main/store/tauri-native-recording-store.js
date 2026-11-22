import path from 'node:path';
import os from 'node:os';

function fullCache(response) {
  const cache = response?.cache;
  if (!response || !Object.hasOwn(response, 'result') || !cache || typeof cache !== 'object' || Array.isArray(cache)
    || !Number.isInteger(cache.schemaVersion) || cache.schemaVersion < 1
    || !cache.settings || typeof cache.settings !== 'object' || Array.isArray(cache.settings)
    || !Array.isArray(cache.clips) || !Array.isArray(cache.markers)) {
    throw new TypeError('Native recording store returned invalid full cache');
  }
  return structuredClone(cache);
}

/** Directory properties are descriptive; all authority remains in the host. */
export class NativeRecordingStore {
  constructor({ dir, defaultLocation = '', request } = {}) {
    if (typeof request !== 'function') throw new TypeError('Native recording store requires a private request function');
    this.dir = dir ?? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower');
    this.filePath = path.join(this.dir, 'recording.json');
    this.defaultLocation = defaultLocation;
    this._request = request;
    this._cache = null;
    this._mutationQueue = Promise.resolve();
  }
  _enqueueMutation(operation) {
    const work = this._mutationQueue.then(operation);
    this._mutationQueue = work.catch(() => {});
    return work;
  }
  _call(method, args) {
    return this._enqueueMutation(async () => {
      const response = await this._request(method, args);
      const cache = fullCache(response);
      this._cache = cache;
      return response.result;
    });
  }
  loadSync() {
    if (!this._cache) throw new Error('Native recording store must be loaded before synchronous access');
    return structuredClone(this._cache);
  }
  async load() { return this._call('recording-load', []); }
  async settings() { return this._call('recording-settings', []); }
  async saveSettings(patch) { return this._call('recording-save-settings', [patch]); }
  async demoteEncoder(selectionId, adapterTarget = null) { return this._call('recording-demote-encoder', [selectionId, adapterTarget]); }
  async listClips() { return this._call('recording-list-clips', []); }
  async scanClips() { return this._call('recording-scan-clips', []); }
  async replaceClips(clips) { return this._call('recording-replace-clips', [clips]); }
  async addMarker(marker) { return this._call('recording-add-marker', [marker]); }
  async listMarkers(options = {}) { return this._call('recording-list-markers', [options]); }
  async recordClip(options = {}) { return this._call('recording-record-clip', [options]); }
  async attachMarkersToClip(options = {}) { return this._call('recording-attach-markers-to-clip', [options]); }
  async clipById(id) { return this._call('recording-clip-by-id', [id]); }
  async deleteClip(id) { return this._call('recording-delete-clip', [id]); }
}
