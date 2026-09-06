// M188c Stability Lab report sidecar. Reports are bounded and published
// atomically so a completed run survives restart without touching settings.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { STABILITY_MAX_REPORTS, STABILITY_SCHEMA_VERSION, normalizeStabilityReport } from '../stability-pure.js';

function defaultDataDir() { return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ArcPower'); }

export class StabilityStore {
  constructor({ dir = defaultDataDir(), limit = STABILITY_MAX_REPORTS } = {}) {
    this.dir = dir;
    this.filePath = path.join(dir, 'stability.json');
    this.limit = Math.max(1, Math.min(STABILITY_MAX_REPORTS, Math.round(Number(limit) || STABILITY_MAX_REPORTS)));
    this._mutationQueue = Promise.resolve();
  }

  _enqueue(operation) {
    const work = this._mutationQueue.then(() => operation());
    this._mutationQueue = work.catch(() => {});
    return work;
  }

  _readRaw() {
    if (!fs.existsSync(this.filePath)) return null;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^\uFEFF/, '')); }
    catch (error) { throw new Error(`Cannot load stability.json: invalid JSON (${error.message})`); }
    if (raw?.schemaVersion > STABILITY_SCHEMA_VERSION) throw new Error('stability.json was created by a newer Arc Power version');
    return raw;
  }

  _data() {
    const raw = this._readRaw();
    const reports = Array.isArray(raw?.reports) ? raw.reports.map(normalizeStabilityReport).filter(Boolean).slice(-this.limit) : [];
    return { schemaVersion: STABILITY_SCHEMA_VERSION, reports };
  }

  _write(data) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeFileSync(fd, JSON.stringify(data, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp, this.filePath);
  }

  loadSync() { return this._data(); }
  async load() { await this._mutationQueue; return this._data(); }
  async list() { return (await this.load()).reports; }
  async latest() { const reports = await this.list(); return reports.at(-1) ?? null; }
  async append(report) {
    const normalized = normalizeStabilityReport(report);
    if (!normalized) throw new Error('Invalid stability report');
    return this._enqueue(() => {
      const current = this._data();
      const reports = [...current.reports.filter((item) => item.runId !== normalized.runId), normalized].slice(-this.limit);
      this._write({ schemaVersion: STABILITY_SCHEMA_VERSION, reports });
      return normalized;
    });
  }
}

export { defaultDataDir };
