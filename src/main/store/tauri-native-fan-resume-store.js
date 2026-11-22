import path from 'node:path';

/** FanResume.json persistence is owned by the Rust host; this adapter owns no files. */
export class NativeFanResumeStore {
  constructor({ dir, filePath, request } = {}) {
    if (typeof request !== 'function') throw new TypeError('Native fan-resume store requires a private request function');
    this.filePath = filePath ?? path.join(dir ?? process.cwd(), 'FanResume.json');
    this._request = request;
    this._queue = Promise.resolve();
  }
  _run(work) {
    const next = this._queue.then(work, work);
    this._queue = next.catch(() => {});
    return next;
  }
  get(deviceKey) { return this._run(() => this._request('fan-resume-get', [deviceKey])); }
  list() { return this._run(() => this._request('fan-resume-list', [])); }
  set(record) { return this._run(() => this._request('fan-resume-set', [record])); }
  remove(deviceKey) {
    return this._run(async () => { await this._request('fan-resume-remove', [deviceKey]); });
  }
}

export function createNativeFanResumeStore(options) { return new NativeFanResumeStore(options); }
