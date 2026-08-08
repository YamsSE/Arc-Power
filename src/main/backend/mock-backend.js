// Arc Power - M1 MockBackend: deterministic fixture implementation of
// IOCBackend, driven by the M2D mock distribution file (mock/featuresets/
// *.json - RID_MOCK_FEATURESET=<id> selects the device line, default a770).
// Every cap, range, control, fan config and telemetry constant derives from
// the featureset; env knobs (RID_MOCK_FAN_READONLY, RID_MOCK_OFFGRID_FREQ_MHZ,
// RID_MOCK_EXTENDED_RANGES, RID_MOCK_EXTENDED_FAIL) and constructor opts act
// as OVERLAYS on top of the featureset base. Used by tests, demo mode
// (RID_BACKEND=mock / `--mock`) and --ui-verify.
//
// Fan fixture vs the real A770 (M3-D): the a770 featureset carries the real
// card's TRUE capability - canControl=true + modes ['auto','curve'] - learned
// from the LIVE reversible probe (table writes SUCCESS with the FAN enum's
// PERCENT encoding; fixed writes are genuinely unsupported, so 'fixed' is
// never offered). RID_MOCK_FAN_READONLY=1 (the `fanCanControl:false` overlay)
// reproduces the read-only surface WITHOUT pretending the modes are ['fixed']
// - the card's modes are ['auto','curve'] regardless of the control grant
// (same honest-vs-reality principle as the real backend's probe-fail path).

import { clampAndSnap, clampGpuLock, clampFanPct, formatDeviceName, normalizeFanCurve } from './units.js';
import { EXTENDED_UNAVAILABLE_MSG } from '../apply-routing.js';
import { collectHealth } from '../health.js';
import { loadFeaturesetOrFallback, listFeaturesetFiles, CONTROL_TO_CANONICAL } from './featuresets.js';

// The mock's default driver fan curve (10 points) - reported by every
// fan-bearing featureset and restored by resetToDefaults.
const DEFAULT_FAN_CURVE = [
  { t: 20, speedPct: 20 }, { t: 55, speedPct: 23 }, { t: 70, speedPct: 28 },
  { t: 78, speedPct: 30 }, { t: 80, speedPct: 30 }, { t: 82, speedPct: 40 },
  { t: 84, speedPct: 50 }, { t: 86, speedPct: 78 }, { t: 88, speedPct: 100 },
  { t: 90, speedPct: 100 },
];

// Editable fan fixture (mock overlay): the real A770's LEARNED mode set
// ['auto','curve'] (never 'fixed' - fixed writes are unsupported on this
// card, live-verified M3-D) + a sane maxRPM for the RPM marker math.
// Read-only / no-fan shapes are derived in _buildFanCaps.
const FAN_EDITABLE = Object.freeze({ canControl: true, modes: ['auto', 'curve'], maxRpm: 3000, maxCurvePoints: 10 });

// ctl_vf_curve table cap - mirrors pure/curve.ts MAX_CURVE_POINTS.
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
 *   multiDevice?: boolean,             // M4-F: emit device ids 0 AND 1 (device 1 =
   *                                      // the arc-igpu line) - the RID_MOCK_MULTI_DEVICE=1
   *                                      // ui-verify knob; tests pass the flag directly
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
    // across live swaps - they describe the verify session, not the device.
    this._extendedOverlay = opts.extendedRanges !== undefined ? opts.extendedRanges === true : undefined;
    this._fanOverlay = opts.fanCanControl !== undefined ? opts.fanCanControl === true : undefined;
    // M3-C-E: the mock's OC mode. Default ADVANCED (mock/ui-verify default
    // per the plan - the extended-flow pins stay green); RID_MOCK_STOCK_MODE
    // or the constructor opt flips it to stock so the refusal path is
    // exercisable without hardware. A session knob, kept across swaps.
    this._ocMode = opts.ocMode === 'stock' ? 'stock' : 'advanced';
    // The energy step override is a session knob too - _applyFeatureset
    // recomputes the step from the ACTIVE featureset's powerW (M2D: after a
    // swap the monitoring power readout must derive from the new device).
    this._energyStepOverride = opts.energyStepJ !== undefined ? opts.energyStepJ : null;
    // M4-F: the multi-device session - device ids 0 AND 1 under the
    // RID_MOCK_MULTI_DEVICE=1 knob (or the constructor flag for tests);
    // device 1 is the arc-igpu line with DISTINCT caps/state/telemetry.
    this._multiDevice = opts.multiDevice === true || process.env.RID_MOCK_MULTI_DEVICE === '1';
    // 1.0.1 no-Intel round: the no-Intel session (RID_MOCK_NO_INTEL=1 or the
    // constructor flag) - listDevices enumerates NOTHING and health reports
    // igclLoaded false, the exact shape a REAL no-Intel machine reports
    // (the IGCL init failure degrades to an empty list in main). The
    // renderer then boots in the no-device mode.
    this._noIntel = opts.noIntel === true || process.env.RID_MOCK_NO_INTEL === '1';
    // Devices > 0 live here; device 0 is the legacy single-device fields
    // (_device/_caps/_state/_tick/_energyStepJ/_waiverAccepted/
    // _telemetryCbs - the pre-M4-F mock, pinned directly by tests).
    this._extraDevices = new Map();
    this._applyFeatureset(this._featureset);
    // Constructor-injected failures land AFTER _applyFeatureset (which resets
    // the fail maps - a featureset swap clears dev-injected failures).
    this._failOn = opts.failOn ?? {};
    if (opts.offGridFreqMhz !== undefined) this._state.gpuFreqOffsetMhz = opts.offGridFreqMhz;
  }

  /** M2D: the active featureset id (the swap dropdown selection). */
  get featuresetId() {
    return this._featureset.id;
  }

  /** M2C-C: the mock's extended-capability flag (mirrors OldIgcl.isCapable). */
  get extendedCapable() {
    return this._extended;
  }

  /**
   * M4-F: resolve the per-device state for one device id. Device 0 is the
   * legacy single-device fields (the pre-M4-F mock - tests pin them
   * directly); devices > 0 live in _extraDevices. An unknown id throws
   * (honest - the caller asked for a device that does not exist).
   * @param {number|undefined|null} deviceId
   */
  _entry(deviceId) {
    const id = deviceId === undefined || deviceId === null ? 0 : deviceId;
    if (id === 0) {
      return {
        device: this._device,
        caps: this._caps,
        state: this._state,
        featureset: this._featureset,
        energyStepJ: this._energyStepJ,
        waiverAccepted: this._waiverAccepted,
        telemetryCbs: this._telemetryCbs,
      };
    }
    const e = this._extraDevices.get(id);
    if (!e) throw new Error(`mock-backend: unknown device id ${id}`);
    return e;
  }

  /** M4-F: the second device's featureset (the arc-igpu line - fixed). */
  _secondFeatureset() {
    const { featureset, warning } = loadFeaturesetOrFallback('arc-igpu');
    if (warning) {
      this._featuresetWarning = warning;
      console.error(`[mock-backend] ${warning}`);
    }
    return featureset;
  }

  /**
   * Apply one featureset to device 0 (and rebuild device 1 in the
   * multi-device session - the swap re-renders BOTH devices): rebuild caps,
   * device fixture and state. The in-memory waiver acceptance + the
   * telemetry subscriptions survive per device (they are app/session
   * consent, not driver state - the swap rebuilds caps/state/timeline only).
   */
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
    // Carry the per-device consent + subscriptions across the rebuild (the
    // swap is caps/state/timeline only - never a silent waiver reset).
    const prevWaiver = this._waiverAccepted;
    const prevCbs = this._telemetryCbs;
    const prevExtraWaivers = new Map([...this._extraDevices].map(([id, e]) => [id, e.waiverAccepted]));
    const prevExtraCbs = new Map([...this._extraDevices].map(([id, e]) => [id, e.telemetryCbs]));
    this._caps = this._buildCaps(fs, this._extended, this._fanCanControl);
    this._device = this._buildDevice(fs, 0);
    this._state = this._buildState(fs);
    // A swap is a fresh device: the telemetry timeline restarts (one
    // no-power sample while the energy counter resets, then the new
    // featureset's wattage - never a blended value).
    this._tick = 0;
    this._waiverAccepted = prevWaiver === undefined ? false : prevWaiver;
    this._telemetryCbs = prevCbs === undefined ? new Set() : prevCbs;
    if (this._multiDevice) {
      const fs2 = this._secondFeatureset();
      this._extraDevices.set(1, {
        device: this._buildDevice(fs2, 1),
        caps: this._buildCaps(fs2, fs2.extendedRanges === true, fs2.hasFan && fs2.fanCanControl === true),
        state: this._buildState(fs2),
        featureset: fs2,
        energyStepJ: fs2.telemetry.powerW * this._intervalS,
        tick: 0,
        waiverAccepted: prevExtraWaivers.get(1) ?? false,
        telemetryCbs: prevExtraCbs.get(1) ?? new Set(),
      });
    }
    this._failOn = {};
    this._failOnce = {};
  }

  _buildCaps(fs, extended, fanCanControl = this._fanCanControl) {
    // Parity with IgclBackend: every control key is emitted explicitly
    // (supported -> true, otherwise false) so consumers never see undefined.
    const controls = {
      gpuFreqOffset: false, gpuVoltOffset: false, gpuLock: false,
      vramFreqOffset: false, vramVoltOffset: false,
      powerLimit: false, tempLimit: false, vfCurve: false,
    };
    for (const c of fs.supportedControls) controls[c] = true;
    const ranges = JSON.parse(JSON.stringify(fs.ranges));
    // M3-C-E: the extended maxes are exposed ONLY in advanced mode - stock
    // mode reports the standard ranges (mirrors IgclBackend). M4-F: the
    // per-device flag (device 0: the session overlay; device 1: its own
    // featureset - the arc-igpu is never extended-capable).
    if (extended && this._ocMode === 'advanced' && ranges.powerLimitW && fs.extended?.plMax) {
      ranges.powerLimitW.max = fs.extended.plMax;
    }
    if (extended && this._ocMode === 'advanced' && ranges.tempLimitC && fs.extended?.tlMax) {
      ranges.tempLimitC.max = fs.extended.tlMax;
    }
    const caps = {
      oemName: 'Intel (mock)',
      // M4-B step-4 F1: the VRAM suffix is formatted HERE too (not only in
      // _buildDevice) - every dialog (boot waiver, apply-time waiver,
      // advanced-mode confirm) renders caps.deviceName, so mock and real
      // backends must agree and the dialogs must match the header/card.
      // M4-I (S1): the memType rides the caps payload too (the VRAM row's
      // type source - the fixture supplies it; the mock name token would
      // derive it anyway).
      deviceName: formatDeviceName(fs.deviceName, fs.vramBytes ?? null, fs.memType ?? undefined),
      memType: fs.memType ?? null,
      waiverAccepted: false,
      controls,
      ranges,
      fan: this._buildFanCaps(fs, fanCanControl),
    };
    // M2C-C: the bundled-2023-runtime flag - the UI exposes the extended
    // maxes only when it is set AND the OC mode is advanced (M3-C-E).
    if (extended && this._ocMode === 'advanced') caps.extendedRanges = true;
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
      // M4-F: the mode is global (not per-device) - the caps cache of BOTH
      // devices is invalidated (the arc-igpu has no extended ranges either
      // way; rebuilding it keeps its caps honest under the stock flip).
      this._caps = this._buildCaps(this._featureset, this._extended, this._fanCanControl);
      for (const e of this._extraDevices.values()) {
        e.caps = this._buildCaps(e.featureset, e.featureset.extendedRanges === true, e.featureset.hasFan && e.featureset.fanCanControl === true);
      }
    }
    return next;
  }

  _buildFanCaps(fs, fanCanControl = this._fanCanControl) {
    if (!fs.hasFan) {
      return { canControl: false, modes: [], maxRpm: -1, maxCurvePoints: 0 };
    }
    if (fanCanControl) {
      return { ...FAN_EDITABLE, maxCurvePoints: fs.fanMaxCurvePoints || 10 };
    }
    // Read-only overlay (M3-D round-2 F1): the modes stay the card's TRUE
    // modes ['auto','curve'] - the read-only fixture must not claim ['fixed'],
    // which would repeat the honest-vs-reality lie. Only the control grant
    // differs.
    return { canControl: false, modes: ['auto', 'curve'], maxRpm: -1, maxCurvePoints: fs.fanMaxCurvePoints || 10 };
  }

  _buildDevice(fs, id = 0) {
    return {
      id,
      // M4-B: the VRAM suffix is formatted ONCE here (listDevices time) -
      // the header, device card and dialogs all read device.name, so the
      // suffix reaches every consumer by construction, never per-render.
      // M4-I (S1): the memType rides the DEVICE payload (the renderer's
      // VRAM row type source - the fixture supplies it; the mock name
      // token would derive it anyway).
      name: formatDeviceName(fs.deviceName, fs.vramBytes ?? null, fs.memType ?? undefined),
      type: 'GRAPHICS',
      pciVendorId: '0x00008086',
      pciDeviceId: fs.pciDeviceId ?? '0x000056a0',
      revId: 8,
      // M4-F: the second device sits at its own bus/device slot (an iGPU
      // fixture - distinct from the primary card's bdf).
      bdf: id === 0 ? { bus: 3, device: 0, function: 0 } : { bus: 0, device: 2, function: 0 },
      driverVersion: fs.driverVersion,
      graphicsClockMHz: fs.graphicsClockMHz,
      numXeCores: fs.numXeCores,
      vramBytes: fs.vramBytes ?? null,
      memType: fs.memType ?? null,
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
   * M4-F: device-0 scoped by construction - the OldIgcl duck type carries no
   * deviceId (extended values only exist on the primary device; the
   * arc-igpu line has no PL/TL controls at all).
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
  // M2D - featureset list + live swap (mock mode only; the IPC surface exists
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
      // M2D: the featureset's own driver date (null when unverified) - the
      // renderer replaces the boot date so the card never pairs the new
      // driver version with a stale boot date.
      driverDate: featureset.driverDate ?? null,
      // collectHealth adds the `backend` kind - the renderer gates the
      // dropdown on it, so the swap health must match the boot health.
      health: await collectHealth(this),
    };
  }

  /**
   * Dev-only knob: force `control` to fail with `errorCode` (null clears).
   * `once: true` fails only the NEXT apply that touches the control - lets
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
    // Nothing to do - fixture-backed.
  }

  async close() {
    this._telemetryCbs.clear();
    for (const e of this._extraDevices.values()) e.telemetryCbs.clear();
  }

  async listDevices() {
    // 1.0.1 no-Intel round: the no-Intel session enumerates NOTHING - the
    // renderer's no-device boot path (the same shape a real no-Intel
    // machine produces after the init-failure degrade in main).
    if (this._noIntel) return [];
    const out = [{ ...this._device }];
    for (const e of this._extraDevices.values()) out.push({ ...e.device });
    return out;
  }

  /**
   * M4-D2 (user: driver ReBAR state): the mock reports the fixture's driver
   * PCI properties - the PRIMARY device's resizableBarEnabled defaults TRUE
   * (the pinned green pill), overridable via the knob for the off-state pin.
   * M4-F: per device - the second device (iGPU) has no ReBAR capability
   * (honest: resizableBarSupported false, no BAR window).
   * @returns {Promise<object>}
   */
  async pciProperties(deviceId = 0) {
    if (deviceId === 0) {
      const enabled = process.env.RID_MOCK_REBAR_ENABLED !== '0';
      return {
        domain: 0,
        bus: 3,
        device: 0,
        function: 0,
        gen: 4,
        width: 16,
        maxBandwidth: 31547565840,
        resizableBarSupported: true,
        resizableBarEnabled: enabled,
      };
    }
    const e = this._extraDevices.get(deviceId);
    if (!e) throw new Error(`mock-backend: unknown device id ${deviceId}`);
    return {
      domain: 0,
      bus: 0,
      device: 2,
      function: 0,
      gen: 4,
      width: 0,
      maxBandwidth: 0,
      resizableBarSupported: false,
      resizableBarEnabled: false,
    };
  }

  async getCapabilities(deviceId = 0) {
    const e = this._entry(deviceId);
    const caps = JSON.parse(JSON.stringify(e.caps));
    caps.waiverAccepted = e.waiverAccepted;
    return caps;
  }

  async getCurrentSettings(deviceId = 0) {
    const s = this._entry(deviceId).state;
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

  async applySettings(deviceId, settings = {}, opts = {}) {
    // M4-F: operate on the TARGET device's caps + state (device 0 keeps the
    // legacy fields; devices > 0 hit their map entry).
    const e = this._entry(deviceId);
    const caps = e.caps;
    const state = e.state;
    const result = { ok: true, perControl: {} };

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
      state[canonicalName] = clamped;
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
        state.gpuLock = clampGpuLock(settings.gpuLock);
        result.perControl.gpuLock = { ok: true, readBackEqual: true };
      }
    }

    if (settings.vfCurve) {
      if (!caps.controls.vfCurve) {
        result.perControl.vfCurve = { ok: false, errorCode: 'unsupported', message: 'custom VF curve not supported on this device' };
        result.ok = false;
      } else {
        // M2D (b580 featureset): vfCurve R/W - store a sanitized copy (the
        // driver curve table cap), mirroring the driver accepting the write.
        state.vfCurve = settings.vfCurve
          .slice(0, MAX_VF_POINTS)
          .map((p) => ({ voltageV: p.voltageV, freqMhz: p.freqMhz }));
        result.perControl.vfCurve = { ok: true, readBackEqual: true };
      }
    }

    // Fan: read-only overlay (RID_MOCK_FAN_READONLY - the M3-D read-only
    // surface: the card's true modes, control withheld) - any fan
    // request is answered with unsupported, mirroring the real-card gate.
    // M4-F: keyed on the DEVICE's caps (the iGPU has no fan at all).
    if (!caps.fan.canControl) {
      for (const c of ['fanMode', 'fanCurve', 'fixedFanPct']) {
        if (settings[c] !== null && settings[c] !== undefined) {
          result.perControl[c] = { ok: false, errorCode: 'unsupported', message: 'fan control is read-only on this device (canControl=false)' };
          result.ok = false;
        }
      }
      this._reconcileWaiver(result, deviceId);
      return result;
    }

    // Editable fixture: mirror the IgclBackend fan apply semantics - mode
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
        this._reconcileWaiver(result, deviceId);
        return result;
      }

      if (settings.fanCurve) {
        if (this._failOn.fanCurve) {
          result.perControl.fanCurve = { ok: false, errorCode: this._failOn.fanCurve, message: `injected failure (fanCurve)` };
          result.ok = false;
          this._consumeFailOnce('fanCurve');
        } else {
          state.fanCurve = normalizeFanCurve(settings.fanCurve, caps.fan.maxCurvePoints);
          state.fanMode = 'curve';
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
          state.fixedFanPct = clampFanPct(settings.fixedFanPct);
          state.fanMode = 'fixed';
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
          state.fanMode = 'auto';
          result.perControl.fanMode = { ok: true, readBackEqual: true };
        }
      }
    }

    this._reconcileWaiver(result, deviceId);
    return result;
  }

  /**
   * G2: mirror IgclBackend - when the driver reports the waiver as lost
   * (any per-control waiver-not-set), clear the stale in-memory flag so
   * getCapabilities reports unaccepted and the next apply re-shows the
   * dialog. Never accepts anything - re-acceptance still requires the
   * explicit waiver-accept path. M4-F: the flag is PER-DEVICE (mirror the
   * real backend's per-device Map).
   * @param {{ perControl: Record<string, { errorCode?: string }> }} result
   * @param {number} deviceId
   */
  _reconcileWaiver(result, deviceId) {
    if (!Object.values(result.perControl).some((p) => p.errorCode === 'waiver-not-set')) return;
    if (deviceId === undefined || deviceId === null || deviceId === 0) {
      this._waiverAccepted = false;
    } else {
      const e = this._extraDevices.get(deviceId);
      if (e) e.waiverAccepted = false;
    }
  }

  async resetToDefaults(deviceId = 0) {
    const e = this._entry(deviceId);
    if (deviceId === undefined || deviceId === null || deviceId === 0) {
      this._state = this._buildState(this._featureset);
    } else {
      e.state = this._buildState(e.featureset);
    }
  }

  async setWaiverAccepted(deviceId = 0) {
    if (deviceId === undefined || deviceId === null || deviceId === 0) {
      this._waiverAccepted = true;
      return;
    }
    const e = this._extraDevices.get(deviceId);
    if (!e) throw new Error(`mock-backend: unknown device id ${deviceId}`);
    e.waiverAccepted = true;
  }

  /**
   * Boot-time seeding of a persisted waiver acceptance (F1): sets ONLY the
   * in-memory flag - never accepts on the driver. Mirrors
   * IgclBackend.restoreWaiverState; the driver-side acceptance runs only on
   * explicit user acceptance (waiver-accept -> setWaiverAccepted). M4-F: the
   * flag is PER-DEVICE (mirror the real backend's per-device Map).
   * @param {number} deviceId
   * @param {boolean} accepted
   */
  async restoreWaiverState(deviceId, accepted) {
    if (deviceId === undefined || deviceId === null || deviceId === 0) {
      this._waiverAccepted = accepted === true;
      return;
    }
    const e = this._extraDevices.get(deviceId);
    if (!e) throw new Error(`mock-backend: unknown device id ${deviceId}`);
    e.waiverAccepted = accepted === true;
  }

  async sampleRawTelemetry(deviceId) {
    // M4-F: PER-DEVICE ramps - each device owns its featureset-derived
    // bases + energy step + timeline (device 1 = the arc-igpu line ramps
    // differently: a smaller energy step, its own clock/temp bases, its own
    // t timeline so the two devices' samples never collide).
    const isPrimary = deviceId === undefined || deviceId === null || deviceId === 0;
    const e = this._entry(deviceId);
    const tick = isPrimary ? this._tick++ : e.tick++;
    const tel = e.featureset.telemetry;
    const energyStepJ = isPrimary ? this._energyStepJ : e.energyStepJ;
    const tBase = isPrimary ? 9662.768701 : 109662.768701;
    // Deterministic ramp: energy +intervalS-interval per tick; clock/temp
    // climb; throttle flag fires on every 10th tick (temp limited). Bases
    // come from the featureset.
    // M4-H (N1): the sample ALSO emits a DETERMINISTIC utilPct - the real
    // igcl backend emits it (activity-counter delta); the mock never did,
    // so the dashboard GPU-util tile would read '-' in verify. Fixed value
    // (same on every device - the pins pin the value, not a ramp).
    const sample = {
      t: tBase + tick * this._intervalS,
      gpuClockMhz: tel.gpuClockBaseMhz + tick * 100,
      memClockMhz: tel.memClockMhz,
      tempC: tel.tempCBase + (tick % 30),
      vramTempC: tel.tempCBase + 8 + (tick % 10),
      gpuVoltageV: 0.652,
      gpuEnergyJ: 395809.938172 + tick * energyStepJ,
      fanRpm: tel.fanRpm,
      utilPct: 42,
      throttle: {
        power: false,
        temp: tick % 10 === 9,
        current: false,
        voltage: false,
        util: false,
      },
    };
    for (const cb of e.telemetryCbs) { try { cb(sample); } catch { /* ignore */ } }
    return sample;
  }

  onRawTelemetry(deviceId, cb) {
    // M4-F: subscriptions are PER-DEVICE (device 0 keeps the legacy set).
    const e = this._entry(deviceId);
    e.telemetryCbs.add(cb);
    return () => e.telemetryCbs.delete(cb);
  }

  async health() {
    // 1.0.1 no-Intel round: the no-Intel session reports the same shape a
    // REAL no-Intel machine reports - IGCL not loaded (the renderer keys
    // the no-device mode on health.igclLoaded false + an empty device
    // list). No error text - the honest no-Intel rows must never show the
    // raw IGCL error.
    if (this._noIntel) {
      return {
        igclLoaded: false,
        driverVersion: null,
        levelZeroOk: false,
      };
    }
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
 * mock's read-back reflects them. Tests and --ui-verify use this - the real
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
