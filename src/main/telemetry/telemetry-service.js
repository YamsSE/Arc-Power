// Arc Power - M1 TelemetryService.
//
// Owns the poll cadence (default 400 ms - M17g: the stock polling rate
// FLIPS 500 -> 400; clamped to the 50 ms IGCL rate
// limit), derives powerW from energy-counter deltas, and keeps a ring
// buffer of derived samples. Backends expose raw 1:1 samples; this service
// turns them into TelemetrySample for consumers (M2b IPC push).

/**
 * @typedef {import('../backend/backend.interface.js').RawTelemetrySample} RawTelemetrySample
 * @typedef {import('../backend/backend.interface.js').TelemetrySample} TelemetrySample
 * @typedef {import('../backend/backend.interface.js').IOCBackend} IOCBackend
 */

export const IGCL_MIN_POLL_MS = 50;

export class TelemetryService {
  /**
   * @param {IOCBackend} backend
   * @param {number} deviceId
   * @param {{ pollMs?: number, ringSize?: number }} opts
   */
  constructor(backend, deviceId, opts = {}) {
    this.backend = backend;
    this.deviceId = deviceId;
    this.pollMs = Math.max(opts.pollMs ?? 400, IGCL_MIN_POLL_MS);
    this.ringSize = Math.max(opts.ringSize ?? 300, 2);
    this._ring = [];
    this._lastRaw = null;
    this._sampleCbs = new Set();
    this._timer = null;
    this._unsubRaw = null;
    this._running = false;
  }

  get running() {
    return this._running;
  }

  /**
   * Start polling: subscribe to the backend raw tap + own timer that pulls
   * one raw sample per tick.
   */
  async start() {
    if (this._running) return;
    this._unsubRaw = this.backend.onRawTelemetry(this.deviceId, (raw) => this.handleSample(raw));
    this._running = true;
    this._timer = setInterval(() => {
      this.backend.sampleRawTelemetry(this.deviceId)
        .catch((err) => this._onPollError(err));
    }, this.pollMs);
  }

  async stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this._unsubRaw) {
      this._unsubRaw();
      this._unsubRaw = null;
    }
    this._lastRaw = null;
  }

  /** @type {(err: Error) => void} */
  onPollError(cb) {
    this._pollErrorCb = cb;
  }

  _onPollError(err) {
    if (this._pollErrorCb) { try { this._pollErrorCb(err); } catch { /* ignore */ } }
  }

  /**
   * Process one raw sample: derive powerW, append to the ring, notify
   * subscribers. Public as a test seam and for future IPC pushes.
   * @param {RawTelemetrySample} raw
   * @returns {TelemetrySample}
   */
  handleSample(raw) {
    const sample = { ...raw };
    const energyKey = raw && raw.powerEnergyJ !== undefined ? 'powerEnergyJ' : 'gpuEnergyJ';
    const previousEnergyKey = this._lastRaw?._powerEnergyKey;
    if (this._lastRaw && raw && energyKey === previousEnergyKey
      && raw[energyKey] !== undefined && this._lastRaw[energyKey] !== undefined) {
      const dt = raw.t - this._lastRaw.t;
      const de = raw[energyKey] - this._lastRaw[energyKey];
      if (Number.isFinite(dt) && Number.isFinite(de) && dt > 0 && de >= 0) {
        sample.powerW = de / dt;
      }
    }
    this._lastRaw = { ...raw, _powerEnergyKey: energyKey };
    this._ring.push(sample);
    if (this._ring.length > this.ringSize) this._ring.splice(0, this._ring.length - this.ringSize);
    for (const cb of this._sampleCbs) { try { cb(sample); } catch { /* ignore */ } }
    return sample;
  }

  /**
   * Subscribe to derived samples. Returns an unsubscribe function.
   * @param {(s: TelemetrySample) => void} cb
   * @returns {() => void}
   */
  onSample(cb) {
    this._sampleCbs.add(cb);
    return () => this._sampleCbs.delete(cb);
  }

  /**
   * Most recent derived sample (or null before any sample arrives).
   * @returns {TelemetrySample|null}
   */
  latest() {
    return this._ring.length > 0 ? this._ring[this._ring.length - 1] : null;
  }

  /**
   * Copy of the ring buffer (oldest first).
   * @returns {TelemetrySample[]}
   */
  getRing() {
    return [...this._ring];
  }
}
