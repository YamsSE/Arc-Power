// Arc Power — M1 MockBackend: deterministic fixture implementation of
// IOCBackend, driven by the M2D mock distribution file (mock/featuresets/
// *.json — RID_MOCK_FEATURESET=<id> selects the device line, default a770).
// Every cap, range, control, fan config and telemetry constant derives from
// the featureset; env knobs (RID_MOCK_FAN_READONLY, RID_MOCK_OFFGRID_FREQ_MHZ,
// RID_MOCK_EXTENDED_RANGES, RID_MOCK_EXTENDED_FAIL) and constructor opts act
// as OVERLAYS on top of the featureset base. Used by tests, demo mode
// (RID_BACKEND=mock / `--mock`) and --ui-verify.
//
// Fan fixture vs the real A770 (M3-D): the a770 featureset carries the real
// card's TRUE capability — canControl=true + modes ['auto','curve'] — learned
// from the LIVE reversible probe (table writes SUCCESS with the FAN enum's
// PERCENT encoding; fixed writes are genuinely unsupported, so 'fixed' is
// never offered). RID_MOCK_FAN_READONLY=1 (the `fanCanControl:false` overlay)
// reproduces the read-only surface WITHOUT pretending the modes are ['fixed']
// — the card's modes are ['auto','curve'] regardless of the control grant
// (same honest-vs-reality principle as the real backend's probe-fail path).

import { clampAndSnap, clampGpuLock, clampFanPct, formatDeviceName, normalizeFanCurve } from './units.js';
import { EXTENDED_UNAVAILABLE_MSG } from '../apply-routing.js';
import { collectHealth } from '../health.js';
import { loadFeaturesetOrFallback, listFeaturesetFiles, CONTROL_TO_CANONICAL } from './featuresets.js';

// The mock's default driver fan curve (10 points) — reported by every
// fan-bearing featureset and restored by resetToDefaults.
const DEFAULT_FAN_CURVE = [
  { t: 20, speedPct: 20 }, { t: 55, speedPct: 23 }, { t: 70, speedPct: 28 },
  { t: 78, speedPct: 30 }, { t: 80, speedPct: 30 }, { t: 82, speedPct: 40 },
  { t: 84, speedPct: 50 }, { t: 86, speedPct: 78 }, { t: 88, speedPct: 100 },
  { t: 90, speedPct: 100 },
];

// Editable fan fixture (mock overlay): the real A770's LEARNED mode set
// ['auto','curve'] (never 'fixed' — fixed writes are unsupported on this
// card, live-verified M3-D) + a sane maxRPM for the RPM marker math.
// Read-only / no-fan shapes are derived in _buildFanCaps.
const FAN_EDITABLE = Object.freeze({ canControl: true, modes: ['auto', 'curve'], maxRpm: 3000, maxCurvePoints: 10 });

// ctl_vf_curve table cap — mirrors pure/curve.ts MAX_CURVE_POINTS.
const MAX_VF_POINTS = 32;

export class MockBackend {
  /**
   * @param {{
   *   featureset?: object,               // M2D: injectable featureset object (tests);
   *                                      // absent -> RID_MOCK_FEATURESET env, default a770
   *   failOn?: Record<string, string>,   // control -> errorCode to force (tests)
   *   fanCanControl?: boolean,           // overlay: false -> read-only fan (ui-verify
   *                                      // RID_MOCK_FAN_READONLY); a hasFan:false
   *                                      // featureset always stays fan-less
   *   offGridFreqMhz?: number,           // report a driver freq offset off the 1 MHz grid (ui-verify only)
   *   telemetryIntervalS?: number,       // mock wall-clock between samples (default 0.5)
   *   energyStepJ?: number,              // energy added per sample (default from the
   *                                      // featureset powerW: powerW * intervalS)
   *   extendedRanges?: boolean,          // overlay on the featureset extendedRanges flag
   *   extendedFail?: boolean,            // extended applies fail with the honest unavailable message
   * }} opts
   */
  constructor(opts = {}) {
    this.kind = 'mock';
    this._failOnce = {};
    this._intervalS = opts.telemetryIntervalS ?? 0.5;
    this._extendedFail = opts.extendedFail === true;
    this._featuresetWarning = null;
    if (opts.featureset) {
      this._featureset = opts.featureset;
    } else {
      const { featureset, warning } = loadFeaturesetOrFallback();
      this._featureset = featureset;
      if (warning) {
        this._featuresetWarning = warning;
        console.error(`[mock-backend] ${warning}`);
      }
    }
    // Session overlays on the featureset base (ui-verify env knobs). Kept
    // across live swaps — they describe the verify session, not the device.
    this._extendedOverlay = opts.extendedRanges !== undefined ? opts.extendedRanges === true : undefined;
    this._fanOverlay = opts.fanCanControl !== undefined ? opts.fanCanControl === true : undefined;
    // M3-C-E: the mock's OC mode. Default ADVANCED (mock/ui-verify default
    // per the plan — the extended-flow pins stay green); RID_MOCK_STOCK_MODE
    // or the constructor opt flips it to stock so the refusal path is
    // exercisable without hardware. A session knob, kept across swaps.
    this._ocMode = opts.ocMode === 'stock' ? 'stock' : 'advanced';
    // The energy step override is a session knob too — _applyFeatureset
    // recomputes the step from the ACTIVE featureset's powerW (M2D: after a
    // swap the monitoring power readout must derive from the new device).
    this._energyStepOverride = opts.energyStepJ !== undefined ? opts.energyStepJ : null;
    this._applyFeatureset(this._featureset);
    // Constructor-injected failures land AFTER _applyFeatureset (which resets
    // the fail maps — a featureset swap clears dev-injected failures).
    this._failOn = opts.failOn ?? {};
    if (opts.offGridFreqMhz !== undefined) this._state.gpuFreqOffsetMhz = opts.offGridFreqMhz;
    this._waiverAccepted = false;
    this._tick = 0;
    this._telemetryCbs = new Set();
  }

  /** M2D: the active featureset id (the swap dropdown selection). */
  get featuresetId() {
    return this._featureset.id;
  }

  /** M2C-C: the mock's extended-capability flag (mirrors OldIgcl.isCapable). */
  get extendedCapable() {
    return this._extended;
  }

  /** Apply one featureset: rebuild caps, device fixture and state. */
  _applyFeatureset(fs) {
    this._featureset = fs;
    // M2D: the energy step derives from the ACTIVE featureset (powerW *
    // interval) so the monitoring power readout follows a swap; a
    // constructor-injected override (test knob) stays a session constant.
    this._energyStepJ = this._energyStepOverride !== null
      ? this._energyStepOverride
      : fs.telemetry.powerW * this._intervalS;
    this._extended = this._extendedOverlay !== undefined
      ? this._extendedOverlay
      : fs.extendedRanges === true;
    this._fanCanControl = fs.hasFan && (this._fanOverlay !== undefined
      ? this._fanOverlay
      : fs.fanCanControl === true);
    this._caps = this._buildCaps(fs);
    this._device = this._buildDevice(fs);
    this._state = this._buildState(fs);
    this._failOn = {};
    this._failOnce = {};
    // A swap is a fresh device: the telemetry timeline restarts (one
    // no-power sample while the energy counter resets, then the new
    // featureset's wattage — never a blended value).
    this._tick = 0;
  }

  _buildCaps(fs) {
    // Parity with IgclBackend: every control key is emitted explicitly
    // (supported -> true, otherwise false) so consumers never see undefined.
    const controls = {
      gpuFreqOffset: false, gpuVoltOffset: false, gpuLock: false,
      vramFreqOffset: false, vramVoltOffset: false,
      powerLimit: false, tempLimit: false, vfCurve: false,
    };
    for (const c of fs.supportedControls) controls[c] = true;
    const ranges = JSON.parse(JSON.stringify(fs.ranges));
    // M3-C-E: the extended maxes are exposed ONLY in advanced mode — stock
    // mode reports the standard ranges (mirrors IgclBackend).
    if (this._extended && this._ocMode === 'advanced' && ranges.powerLimitW && fs.extended?.plMax) {
      ranges.powerLimitW.max = fs.extended.plMax;
    }
    if (this._extended && this._ocMode === 'advanced' && ranges.tempLimitC && fs.extended?.tlMax) {
      ranges.tempLimitC.max = fs.extended.tlMax;
    }
    const caps = {
      oemName: 'Intel (mock)',
      // M4-B step-4 F1: the VRAM suffix is formatted HERE too (not only in
      // _buildDevice) — every dialog (boot waiver, apply-time waiver,
      // advanced-mode confirm) renders caps.deviceName, so mock and real
      // backends must agree and the dialogs must match the header/card.
      deviceName: formatDeviceName(fs.deviceName, fs.vramBytes ?? null),
      waiverAccepted: false,
      controls,
      ranges,
      fan: this._buildFanCaps(fs),
    };
    // M2C-C: the bundled-2023-runtime flag — the UI exposes the extended
    // maxes only when it is set AND the OC mode is advanced (M3-C-E).
    if (this._extended && this._ocMode === 'advanced') caps.extendedRanges = true;
    return caps;
  }

  /**
   * M3-C-E: switch the mock's OC mode and rebuild the caps (the extended
   * ranges appear/disappear exactly like the real backend's caps cache
   * invalidation). Returns the effective mode.
   * @param {'stock'|'advanced'} mode
   * @returns {'stock'|'advanced'}
   */
  setOcMode(mode) {
    const next = mode === 'stock' ? 'stock' : 'advanced';
    if (next !== this._ocMode) {
      this._ocMode = next;
      this._caps = this._buildCaps(this._featureset);
    }
    return next;
  }

  _buildFanCaps(fs) {
    if (!fs.hasFan) {
      return { canControl: false, modes: [], maxRpm: -1, maxCurvePoints: 0 };
    }
    if (this._fanCanControl) {
      return { ...FAN_EDITABLE, maxCurvePoints: fs.fanMaxCurvePoints || 10 };
    }
    // Read-only overlay (M3-D round-2 F1): the modes stay the card's TRUE
    // modes ['auto','curve'] — the read-only fixture must not claim ['fixed'],
    // which would repeat the honest-vs-reality lie. Only the control grant
    // differs.
    return { canControl: false, modes: ['auto', 'curve'], maxRpm: -1, maxCurvePoints: fs.fanMaxCurvePoints || 10 };
  }

  _buildDevice(fs) {
    return {
      id: 0,
      // M4-B: the VRAM suffix is formatted ONCE here (listDevices time) —
      // the header, device card and dialogs all read device.name, so the
      // suffix reaches every consumer by construction, never per-render.
      name: formatDeviceName(fs.deviceName, fs.vramBytes ?? null),
      type: 'GRAPHICS',
      pciVendorId: '0x00008086',
      pciDeviceId: fs.pciDeviceId ?? '0x000056a0',
      revId: 8,
      bdf: { bus: 3, device: 0, function: 0 },
      driverVersion: fs.driverVersion,
      graphicsClockMHz: fs.graphicsClockMHz,
      numXeCores: fs.numXeCores,
      vramBytes: fs.vramBytes ?? null,
    };
  }

  _buildState(fs) {
    const state = {
      gpuLock: fs.supportedControls.includes('gpuLock') ? { voltageV: 0, freqMhz: 0 } : null,
      vfCurve: null,
      fanMode: null,
      fanCurve: null,
      fixedFanPct: null,
    };
    for (const [control, canonical] of Object.entries(CONTROL_TO_CANONICAL)) {
      state[canonical] = fs.supportedControls.includes(control) && fs.ranges[canonical]
        ? fs.ranges[canonical].default
        : null;
    }
    if (fs.hasFan) {
      state.fanMode = 'curve';
      state.fanCurve = DEFAULT_FAN_CURVE.map((p) => ({ ...p }));
    }
    return state;
  }

  /**
   * M2C-C mock of the bundled 2023 runtime's extended setters: applies the
   * value to the mock state when extended ranges are enabled; otherwise (or
   * with extendedFail) answers with the honest unavailable message.
   * @param {'powerLimitW'|'tempLimitC'} control
   * @param {number} value
   * @returns {Promise<{ ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean }>}
   */
  async extendedApply(control, value) {
    if (!this._extended || this._extendedFail) {
      return { ok: false, errorCode: 'unsupported', readBackEqual: false, message: EXTENDED_UNAVAILABLE_MSG };
    }
    const range = this._caps.ranges[control];
    const clamped = clampAndSnap(value, range);
    this._state[control] = clamped;
    return { ok: true, readBackEqual: true };
  }

  // ---------------------------------------------------------------------------
  // M2D — featureset list + live swap (mock mode only; the IPC surface exists
  // only when the app runs with a mock backend)
  // ---------------------------------------------------------------------------

  /**
   * The distribution files + the active selection (drives the header
   * dropdown in mock mode).
   * @returns {Promise<{ featuresets: Array<{id: string, name: string, tag: string}>, current: string }>}
   */
  async listFeaturesets() {
    return { featuresets: listFeaturesetFiles(), current: this._featureset.id };
  }

  /**
   * Swap the mock device line. Re-reads the fresh caps/state/device/health so
   * the renderer can re-render the WHOLE UI surface from one response. The
   * in-memory waiver acceptance is preserved across swaps (it is app
   * consent, not a driver-side per-device state); state resets to the new
   * featureset's defaults (a fresh device).
   * @param {string} id
   * @returns {Promise<{ featureset: {id: string, name: string, tag: string}, devices: object[], caps: object, state: object, health: object }>}
   */
  async setFeatureset(id) {
    const { featureset, warning } = loadFeaturesetOrFallback(id);
    if (warning) {
      this._featuresetWarning = warning;
      console.error(`[mock-backend] ${warning}`);
    }
    this._applyFeatureset(featureset);
    return {
      featureset: { id: featureset.id, name: featureset.name, tag: featureset.tag ?? '' },
      devices: await this.listDevices(),
      caps: await this.getCapabilities(0),
      state: await this.getCurrentSettings(0),
      // M2D: the featureset's own driver date (null when unverified) — the
      // renderer replaces the boot date so the card never pairs the new
      // driver version with a stale boot date.
      driverDate: featureset.driverDate ?? null,
      // collectHealth adds the `backend` kind — the renderer gates the
      // dropdown on it, so the swap health must match the boot health.
      health: await collectHealth(this),
    };
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
    return [{ ...this._device }];
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
      gpuLock: s.gpuLock ? { ...s.gpuLock } : null,
      vfCurve: s.vfCurve ? s.vfCurve.map((p) => ({ ...p })) : null,
      fanMode: s.fanMode,
      fanCurve: s.fanCurve ? s.fanCurve.map((p) => ({ ...p })) : null,
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
        this._state.gpuLock = clampGpuLock(settings.gpuLock);
        result.perControl.gpuLock = { ok: true, readBackEqual: true };
      }
    }

    if (settings.vfCurve) {
      if (!caps.controls.vfCurve) {
        result.perControl.vfCurve = { ok: false, errorCode: 'unsupported', message: 'custom VF curve not supported on this device' };
        result.ok = false;
      } else {
        // M2D (b580 featureset): vfCurve R/W — store a sanitized copy (the
        // driver curve table cap), mirroring the driver accepting the write.
        this._state.vfCurve = settings.vfCurve
          .slice(0, MAX_VF_POINTS)
          .map((p) => ({ voltageV: p.voltageV, freqMhz: p.freqMhz }));
        result.perControl.vfCurve = { ok: true, readBackEqual: true };
      }
    }

    // Fan: read-only overlay (RID_MOCK_FAN_READONLY — the M3-D read-only
    // surface: the card's true modes, control withheld) — any fan
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
    this._state = this._buildState(this._featureset);
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
    const tel = this._featureset.telemetry;
    // Deterministic ramp: energy +intervalS-interval per tick; clock/temp
    // climb; throttle flag fires on every 10th tick (temp limited). Bases
    // come from the featureset.
    const sample = {
      t: 9662.768701 + tick * this._intervalS,
      gpuClockMhz: tel.gpuClockBaseMhz + tick * 100,
      memClockMhz: tel.memClockMhz,
      tempC: tel.tempCBase + (tick % 30),
      vramTempC: tel.tempCBase + 8 + (tick % 10),
      gpuVoltageV: 0.652,
      gpuEnergyJ: 395809.938172 + tick * this._energyStepJ,
      fanRpm: tel.fanRpm,
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
      driverVersion: `${this._featureset.driverVersion} (mock fixture)`,
      levelZeroOk: true,
    };
  }
}

/**
 * M2C-C: the mock bundled-2023-runtime adapter (OldIgcl duck type). Routes
 * extended-range writes back into the MockBackend's extendedApply so the
 * mock's read-back reflects them. Tests and --ui-verify use this — the real
 * OldIgcl never loads in mock mode.
 * @param {MockBackend} backend
 */
export function createMockOldIgcl(backend) {
  return {
    isCapable: async () => backend.extendedCapable,
    setPowerLimitW: async (w) => backend.extendedApply('powerLimitW', w),
    setTempLimitC: async (c) => backend.extendedApply('tempLimitC', c),
    close: async () => {},
  };
}
