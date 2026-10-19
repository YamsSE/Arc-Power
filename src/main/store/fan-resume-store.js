import fs from 'node:fs';
import path from 'node:path';

const EMPTY = Object.freeze({ schemaVersion: 1, devices: [] });

function cleanRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.deviceKey !== 'string' || !raw.deviceKey.trim()
    || !raw.physicalTarget || typeof raw.physicalTarget !== 'object'
    || !raw.settings || typeof raw.settings !== 'object') return null;
  const s = raw.settings;
  if (!['auto', 'curve', 'fixed'].includes(s.fanMode)) return null;
  const settings = { fanMode: s.fanMode };
  if (s.fanMode === 'curve') {
    if (!Array.isArray(s.fanCurve) || s.fanCurve.length < 2 || s.fanCurve.length > 32
      || !s.fanCurve.every((p, index, points) => Number.isFinite(p?.t) && p.t >= 0 && p.t <= 100
        && Number.isFinite(p?.speedPct) && p.speedPct >= 0 && p.speedPct <= 100
        && (index === 0 || p.t > points[index - 1].t))) return null;
    settings.fanCurve = s.fanCurve.map(({ t, speedPct }) => ({ t, speedPct }));
  }
  if (s.fanMode === 'fixed') {
    if (!Number.isFinite(s.fixedFanPct) || s.fixedFanPct < 0 || s.fixedFanPct > 100) return null;
    settings.fixedFanPct = s.fixedFanPct;
  }
  return { deviceKey: raw.deviceKey.trim(), physicalTarget: structuredClone(raw.physicalTarget), settings };
}

export class FanResumeStore {
  constructor({ dir, filePath } = {}) {
    this.filePath = filePath ?? path.join(dir ?? process.cwd(), 'FanResume.json');
    this.queue = Promise.resolve();
  }
  async _run(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => {});
    return next;
  }
  _read() {
    if (!fs.existsSync(this.filePath)) return { ...EMPTY, devices: [] };
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.devices)) throw new Error('FanResume.json has invalid format');
    return { schemaVersion: 1, devices: raw.devices.map(cleanRecord).filter(Boolean) };
  }
  get(deviceKey) { return this._run(() => this._read().devices.find((d) => d.deviceKey === deviceKey) ?? null); }
  list() { return this._run(() => this._read().devices); }
  set(record) {
    const clean = cleanRecord(record);
    if (!clean) return Promise.reject(new Error('fan-resume: invalid record'));
    return this._run(() => {
      const data = this._read();
      data.devices = [...data.devices.filter((d) => d.deviceKey !== clean.deviceKey), clean];
      this._write(data);
      return clean;
    });
  }
  remove(deviceKey) {
    return this._run(() => {
      const data = this._read();
      data.devices = data.devices.filter((d) => d.deviceKey !== deviceKey);
      this._write(data);
    });
  }
  _write(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    try { fs.renameSync(tmp, this.filePath); } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
  }
}

export function createFanResumeStore(options) { return new FanResumeStore(options); }
