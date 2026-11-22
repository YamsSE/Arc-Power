import path from 'node:path';

/** window-state.json persistence is owned by the Rust host; this adapter owns no files. */
export class NativeWindowStateStore {
  constructor({ dir, filePath, request } = {}) {
    if (typeof request !== 'function') throw new TypeError('Native window-state store requires a private request function');
    this.filePath = filePath ?? path.join(dir ?? process.cwd(), 'window-state.json');
    this._request = request;
  }
  async load() { return this._request('window-state-load', []); }
  async save(state) { await this._request('window-state-save', [state]); }
  async restore(displays) { return this._request('window-state-restore', [displays]); }
  async saveCurrent(normalBounds, maximized) {
    await this._request('window-state-save-current', [normalBounds, maximized]);
  }
}

export function createNativeWindowStateStore(options) { return new NativeWindowStateStore(options); }
