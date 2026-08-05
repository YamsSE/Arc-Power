// Arc Power — M1 MockBackend: deterministic fixture implementation of
// IOCBackend matching the verified A770 capability matrix (same ranges,
// units), with telemetry that ramps deterministically. Used by tests and
// demo mode (RID_BACKEND=mock / `--mock`).
//
// Fan difference vs the real A770 (deliberate, per the M2a prompt): the mock
// reports canControl=true with modes auto/curve/fixed so the fan editor is
// fully testable in mock mode. Pass `fanCanControl: false` to get the exact
// A770 read-only fan fixture (used to verify the read-only UI path).

import { clampAndSnap, clampGpuLock, clampFanPct, normalizeFanCurve } from './units.js';

const DEFAULT_STATE = Object.freeze({
  powerLimitW: 210,
  gpuVoltOffsetV: 0,
  gpuFreqOffsetMhz: 0,
  tempLimitC: 90,
  vramFreqOffsetGts: null,
  vramVoltOffsetV: null,
  gpuLock: { voltageV: 0, freqMhz: 0 },
  vfCurve: null,
  fanMode: 'curve',
  fanCurve: [
    { t: 20, speedPct: 20 }, { t: 55, speedPct: 23 }, { t: 70, speedPct: 28 },
    { t: 78, speedPct: 30 }, { t: 80, speedPct: 30 }, { t: 82, speedPct: 40 },
    { t: 84, speedPct: 50 }, { t: 86, speedPct: 78 }, { t: 88, speedPct: 100 },
    { t: 90, speedPct: 100 },
  ],
  fixedFanPct: null,
});

// A770 read-only fan fixture (canControl=false).
const FAN_READONLY = Object.freeze({ canControl: false, modes: ['fixed'], maxRpm: -1, maxCurvePoints: 10 });
// Editable fan fixture (mock default): full mode set + a sane maxRPM for the
// RPM marker math.
const FAN_EDITABLE = Object.freeze({ canControl: true, modes: ['auto', 'curve', 'fixed'], maxRpm: 3000, maxCurvePoints: 10 });

const DEFAULT_CAPS = Object.freeze({
  oemName: 'Intel (mock)',
  deviceName: 'Mock Arc A770 Graphics (fixture)',
  waiverAccepted: false,
  controls: {
    gpuFreqOffset: true, gpuVoltOffset: true, gpuLock: true,
    vramFreqOffset: false, vramVoltOffset: false,
    powerLimit: true, tempLimit: true, vfCurve: false,
  },
  ranges: {
    gpuFreqOffsetMhz: { min: 0, max: 300, step: 1, default: 0, units: 'MHz' },
    gpuVoltOffsetV: { min: 0, max: 0.234, step: 0.005, default: 0, units: 'V' },
    powerLimitW: { min: 105, max: 252, step: 1, default: 210, units: 'W' },
    tempLimitC: { min: 60, max: 90, step: 1, default: 90, units: 'C' },
  },
  fan: FAN_READONLY,
});

const DEVICE_FIXTURE = Object.freeze({
  id: 0,
  name: 'Mock Arc A770 Graphics (fixture)',
  type: 'GRAPHICS',
  pciVendorId: '0x00008086',
  pciDeviceId: '0x000056a0',
  revId: 8,
  bdf: { bus: 3, device: 0, function: 0 },
  driverVersion: '0x002000000065229d',
  graphicsClockMHz: 2100,
  numXeCores: 32,
});

export class MockBackend {
  /**
   * @param {{
   *   failOn?: Record<string, string>,   // control -> errorCode to force (tests)
   *   fanCanControl?: boolean,           // false -> exact A770 read-only fan fixture (default true)
   *   offGridFreqMhz?: number,           // report a driver freq offset off the 1 MHz grid (ui-verify only)
   *   telemetryIntervalS?: number,       // mock wall-clock between samples (default 0.5)
   *   energyStepJ?: number,              // energy added per sample (default 19.4 -> 38.8 W @ 0.5 s)
   * }} opts
   */
  constructor(opts = {}) {
    this.kind = 'mock';
    this._failOn = opts.failOn ?? {};
    this._failOnce = {};
    this._intervalS = opts.telemetryIntervalS ?? 0.5;
    this._energyStepJ = opts.energyStepJ ?? 19.4;
    this._fanCanControl = opts.fanCanControl !== false;
    this._state = { ...DEFAULT_STATE, gpuLock: { ...DEFAULT_STATE.gpuLock }, fanCurve: [...DEFAULT_STATE.fanCurve] };
    if (opts.offGridFreqMhz !== undefined) this._state.gpuFreqOffsetMhz = opts.offGridFreqMhz;
    this._caps = JSON.parse(JSON.stringify(DEFAULT_CAPS));
    if (this._fanCanControl) this._caps.fan = { ...FAN_EDITABLE };
    this._waiverAccepted = false;
    this._tick = 0;
    this._telemetryCbs = new Set();
  }

  /**
   * Dev-only knob: force `control` to fail with `errorCode` (null clears).
   * `once: true` fails only the NEXT apply that touches the control — lets
   * tests/ui-verify pin that an instant apply makes exactly ONE attempt
   * and reports the failure honestly (a one-shot failure must never be
   * silently retried); persistent failures pin the honest-failure path.
   */
  injectFail(control, errorCode, once = false) {
    if (errorCode) {
      this._failOn[control] = errorCode;
      this._failOnce[control] = once === true;
    } else {
      delete this._failOn[control];
      delete this._failOnce[control];
    }
  }

  _consumeFailOnce(control) {
    if (this._failOnce[control]) this.injectFail(control, null);
  }

  async init() {
    // Nothing to do — fixture-backed.
  }

  async close() {
    this._telemetryCbs.clear();
  }

  async listDevices() {
    return [{ ...DEVICE_FIXTURE }];
  }

  async getCapabilities() {
    const caps = JSON.parse(JSON.stringify(this._caps));
    caps.waiverAccepted = this._waiverAccepted;
    return caps;
  }

  async getCurrentSettings() {
    const s = this._state;
    return {
      powerLimitW: s.powerLimitW,
      gpuVoltOffsetV: s.gpuVoltOffsetV,
      gpuFreqOffsetMhz: s.gpuFreqOffsetMhz,
      tempLimitC: s.tempLimitC,
      vramFreqOffsetGts: s.vramFreqOffsetGts,
      vramVoltOffsetV: s.vramVoltOffsetV,
      gpuLock: { ...s.gpuLock },
      vfCurve: s.vfCurve ? s.vfCurve.map((p) => ({ ...p })) : null,
      fanMode: s.fanMode,
      fanCurve: s.fanCurve.map((p) => ({ ...p })),
      fixedFanPct: s.fixedFanPct,
    };
  }

  async applySettings(_deviceId, settings = {}, opts = {}) {
    const result = { ok: true, perControl: {} };
    const caps = this._caps;

    const applyScalar = (control, canonicalName, value) => {
      if (value === null || value === undefined) return;
      if (!caps.controls[control]) {
        result.perControl[canonicalName] = { ok: false, errorCode: 'unsupported', message: 'control not supported on this device' };
        result.ok = false;
        return;
      }
      if (this._failOn[canonicalName]) {
        result.perControl[canonicalName] = { ok: false, errorCode: this._failOn[canonicalName], message: `injected failure (${canonicalName})` };
        result.ok = false;
        this._consumeFailOnce(canonicalName);
        return;
      }
      const range = caps.ranges[canonicalName];
      const clamped = opts.snapToStep === false
        ? Math.min(range.max, Math.max(range.min, Number.isFinite(value) ? value : range.min))
        : clampAndSnap(value, range);
      this._state[canonicalName] = clamped;
      result.perControl[canonicalName] = { ok: true, readBackEqual: true };
    };

    applyScalar('powerLimit', 'powerLimitW', settings.powerLimitW);
    applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', settings.gpuVoltOffsetV);
    applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', settings.gpuFreqOffsetMhz);
    applyScalar('tempLimit', 'tempLimitC', settings.tempLimitC);
    applyScalar('vramFreqOffset', 'vramFreqOffsetGts', settings.vramFreqOffsetGts);
    applyScalar('vramVoltOffset', 'vramVoltOffsetV', settings.vramVoltOffsetV);

    if (settings.gpuLock) {
      if (!caps.controls.gpuLock) {
        result.perControl.gpuLock = { ok: false, errorCode: 'unsupported', message: 'GPU lock not supported on this device' };
        result.ok = false;
      } else {
        // Mirror IgclBackend.applyLock: clamp to the documented lock bounds.
        this._state.gpuLock = clampGpuLock(settings.gpuLock, caps.ranges);
        result.perControl.gpuLock = { ok: true, readBackEqual: true };
      }
    }

    if (settings.vfCurve) {
      result.perControl.vfCurve = { ok: false, errorCode: 'unsupported', message: 'custom VF curve not supported on this device' };
      result.ok = false;
    }

    // Fan: read-only fixture (A770-style, canControl=false) — any fan
    // request is answered with unsupported, mirroring the real-card gate.
    if (!this._fanCanControl) {
      for (const c of ['fanMode', 'fanCurve', 'fixedFanPct']) {
        if (settings[c] !== null && settings[c] !== undefined) {
          result.perControl[c] = { ok: false, errorCode: 'unsupported', message: 'fan control is read-only on this device (canControl=false)' };
          result.ok = false;
        }
      }
      this._reconcileWaiver(result);
      return result;
    }

    // Editable fixture: mirror the IgclBackend fan apply semantics — mode
    // resolution, curve point clamp + ascending temps, 0..100 fixed %.
    const requestedFan = ['fanMode', 'fanCurve', 'fixedFanPct']
      .filter((c) => settings[c] !== null && settings[c] !== undefined);
    if (requestedFan.length > 0) {
      let mode = settings.fanMode;
      if (!mode) {
        if (settings.fanCurve) mode = 'curve';
        else if (settings.fixedFanPct !== undefined && settings.fixedFanPct !== null) mode = 'fixed';
      }
      if (!caps.fan.modes.includes(mode)) {
        for (const c of requestedFan) {
          result.perControl[c] = { ok: false, errorCode: 'unsupported', message: `fan mode ${mode} not supported on this device` };
          result.ok = false;
        }
        this._reconcileWaiver(result);
        return result;
      }

      if (settings.fanCurve) {
        if (this._failOn.fanCurve) {
          result.perControl.fanCurve = { ok: false, errorCode: this._failOn.fanCurve, message: `injected failure (fanCurve)` };
          result.ok = false;
          this._consumeFailOnce('fanCurve');
        } else {
          this._state.fanCurve = normalizeFanCurve(settings.fanCurve, caps.fan.maxCurvePoints);
          this._state.fanMode = 'curve';
          result.perControl.fanCurve = { ok: true, readBackEqual: true };
          result.perControl.fanMode = { ok: true, readBackEqual: true };
        }
      }

      if (settings.fixedFanPct !== null && settings.fixedFanPct !== undefined) {
        if (this._failOn.fixedFanPct) {
          result.perControl.fixedFanPct = { ok: false, errorCode: this._failOn.fixedFanPct, message: `injected failure (fixedFanPct)` };
          result.ok = false;
          this._consumeFailOnce('fixedFanPct');
        } else {
          this._state.fixedFanPct = clampFanPct(settings.fixedFanPct);
          this._state.fanMode = 'fixed';
          result.perControl.fixedFanPct = { ok: true, readBackEqual: true };
          result.perControl.fanMode = { ok: true, readBackEqual: true };
        }
      }

      if (settings.fanMode === 'auto') {
        if (this._failOn.fanMode) {
          result.perControl.fanMode = { ok: false, errorCode: this._failOn.fanMode, message: `injected failure (fanMode)` };
          result.ok = false;
          this._consumeFailOnce('fanMode');
        } else {
          this._state.fanMode = 'auto';
          result.perControl.fanMode = { ok: true, readBackEqual: true };
        }
      }
    }

    this._reconcileWaiver(result);
    return result;
  }

  /**
   * G2: mirror IgclBackend — when the driver reports the waiver as lost
   * (any per-control waiver-not-set), clear the stale in-memory flag so
   * getCapabilities reports unaccepted and the next apply re-shows the
   * dialog. Never accepts anything — re-acceptance still requires the
   * explicit waiver-accept path.
   * @param {{ perControl: Record<string, { errorCode?: string }> }} result
   */
  _reconcileWaiver(result) {
    if (Object.values(result.perControl).some((p) => p.errorCode === 'waiver-not-set')) {
      this._waiverAccepted = false;
    }
  }

  async resetToDefaults() {
    this._state = { ...DEFAULT_STATE, gpuLock: { ...DEFAULT_STATE.gpuLock }, fanCurve: [...DEFAULT_STATE.fanCurve] };
  }

  async setWaiverAccepted() {
    this._waiverAccepted = true;
  }

  /**
   * Boot-time seeding of a persisted waiver acceptance (F1): sets ONLY the
   * in-memory flag — never accepts on the driver. Mirrors
   * IgclBackend.restoreWaiverState; the driver-side acceptance runs only on
   * explicit user acceptance (waiver-accept -> setWaiverAccepted).
   * @param {number} _deviceId
   * @param {boolean} accepted
   */
  async restoreWaiverState(_deviceId, accepted) {
    this._waiverAccepted = accepted === true;
  }

  async sampleRawTelemetry() {
    const tick = this._tick++;
    // Deterministic ramp: energy +intervalS-interval per tick; clock/temp
    // climb; throttle flag fires on every 10th tick (temp limited).
    const sample = {
      t: 9662.768701 + tick * this._intervalS,
      gpuClockMhz: 600 + tick * 100,
      memClockMhz: 2000,
      tempC: 36 + (tick % 30),
      vramTempC: 44 + (tick % 10),
      gpuVoltageV: 0.652,
      gpuEnergyJ: 395809.938172 + tick * this._energyStepJ,
      fanRpm: [1030],
      throttle: {
        power: false,
        temp: tick % 10 === 9,
        current: false,
        voltage: false,
        util: false,
      },
    };
    for (const cb of this._telemetryCbs) { try { cb(sample); } catch { /* ignore */ } }
    return sample;
  }

  onRawTelemetry(_deviceId, cb) {
    this._telemetryCbs.add(cb);
    return () => this._telemetryCbs.delete(cb);
  }

  async health() {
    return {
      igclLoaded: true,
      driverVersion: '32.0.101.8861 (mock fixture)',
      levelZeroOk: true,
    };
  }
}
