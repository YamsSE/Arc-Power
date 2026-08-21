// Arc Power - M1 MockBackend: deterministic fixture implementation of
// IOCBackend, driven by the M2D mock distribution file (mock/featuresets/
// *.json - RID_MOCK_FEATURESET=<id> selects the device line, default a770).
// Every cap, range, control, fan config and telemetry constant derives from
// the featureset; env knobs (RID_MOCK_FAN_READONLY, RID_MOCK_FAN_FIXED,
// RID_MOCK_OFFGRID_FREQ_MHZ, RID_MOCK_EXTENDED_RANGES,
// RID_MOCK_EXTENDED_FAIL) and constructor opts act as OVERLAYS on top of the
// featureset base. Used by tests, demo mode (RID_BACKEND=mock / `--mock`)
// and --ui-verify.
//
// Fan fixture vs the real A770 (M3-D): the a770 featureset carries the real
// card's TRUE capability - canControl=true + modes ['auto','curve'] - learned
// from the LIVE reversible probe (table writes SUCCESS with the FAN enum's
// PERCENT encoding; fixed writes are genuinely unsupported, so 'fixed' is
// never offered). RID_MOCK_FAN_READONLY=1 (the `fanCanControl:false` overlay)
// reproduces the read-only surface WITHOUT pretending the modes are ['fixed']
// - the card's modes are ['auto','curve'] regardless of the control grant
// (same honest-vs-reality principle as the real backend's probe-fail path).
// M20-B: RID_MOCK_FAN_FIXED=1 models the ALchemist FIXED unlock - the probe's
// flat-table fallback learned 'fixed' (the dedicated API refuses, a FLAT
// speed table IS the fixed mechanism): the caps report modes
// ['auto','curve','fixed'] and the read-back derives 'fixed' from a flat
// table (the same numPoints>=2 + all-equal + PERCENT derivation the real
// backend runs) - the mock round trip the ui-verify knob variant pins.

import { clampAndSnap, clampGpuLock, clampFanPct, formatDeviceName, normalizeFanCurve, sortDevicesDiscreteFirst, deviceHardwareKey } from './units.js';
import { EXTENDED_UNAVAILABLE_MSG } from '../apply-routing.js';
import { collectHealth } from '../health.js';
import { loadFeaturesetOrFallback, listFeaturesetFiles, CONTROL_TO_CANONICAL } from './featuresets.js';
// M17c: the pure AIB decode (aibOf + the laptop branch) - the SAME decode
// the real backend runs in getCapabilities (the renderer TS imports fine
// under the packaged Electron - Node 22.21 type stripping).
import { aibOf, laptopAibOf } from '../../renderer/pure/aib.ts';
// M17c/M17d: the per-device limits table - the MOCK mirrors the real
// backend's getCapabilities finalize (step-4 N1) for the Alchemist family
// (A770/A750/A380/A310) with the STOCK/ADVANCED split. Advanced rows keep
// each card's documented extended PL/TL ceiling visible even if the
// bundled-runtime capability flag is false; routing still refuses values
// that runtime cannot honor.
import { deviceLimitsOf, defaultLimitsOf } from '../../renderer/pure/device-limits.ts';
// M17e: the listed-card lockRange fallback table (the mock mirrors the real
// backend's caps-level fallback when the fixture carries no lockRange row
// on a gpuLock-capable device).
import { lockRangeOf } from '../../renderer/pure/lock-ranges.ts';
// M17c: the session refused-ceiling store (the mock mirrors the real
// backend's parent-side merge - getCapabilities merges the store so the
// mock-refusal fixture exercises the same merge the renderer sees).
import { createRefusedCeilingStore, mergeIntoRanges, recordRefusalEnvelope } from './refused-ceilings.js';

// M21: the mock V1 (extendedApply) PL write-range max - a SEPARATE 315
// constant mirroring the real bundled-2023-runtime V1 clamp (old-igcl.js
// EXTENDED_PL_RANGE max: the V1 setter refuses >315 W 0x44000004 - live-
// verified 2026-08-06). The mock's EXPOSED caps max comes from
// fs.extended.plMax (375 on the a770 - the sysman-primary ceiling), but the
// V1 write itself must still refuse/clamp at 315 exactly like the real
// runtime, so the >315 routing (which NEVER hands the V1 a >315 value) is
// what applies the sysman range - never the mock V1 setter. Behaviorally
// neutral for the a750/acer-a750 (fs.extended.plMax 270 -> the same 315
// clamp; the A750 advanced gate refuses 271+ first).
const MOCK_V1_PL_MAX_W = 315;

// M8 (the Graphics tab): the mock's graphics fixture - mirrors the
// M8 checkpoint-1 probe record (pipeline/live-3d-feature.md, the A770
// driver): all four 3D features supported; the flip-mode caps 0x6f expose
// application-default/vsync-on/vsync-off/smooth-sync but NOT speed-frame
// (the Speed Sync dropdown option is gated off, exactly like the live
// driver); the low-latency caps 0x3 expose off/on but NOT on-boost; the
// XeSS FG caps expose no restrictions (all four options); the frame-limit
// range is the probe-recorded 30-300-1-60 (the plan's fallback is the
// same values). The apply records the payload - the read-back reflects it
// (the mock round trip the ui-verify pins).
const GRAPHICS_FIXTURE = Object.freeze({
  supported: { frameGen: true, flipModes: true, frameLimit: true, lowLatency: true },
  supportedOptions: {
    frameGen: ['app-choice', '2x', '3x', '4x'],
    flipModes: ['application-default', 'vsync-on', 'vsync-off', 'smooth-sync'],
    lowLatency: ['off', 'on'],
  },
  frameLimitRange: { min: 30, max: 300, step: 1, default: 60 },
  values: {
    frameGenOverride: 'app-choice',
    flipMode: 'application-default',
    frameLimit: { enabled: false, value: 60 },
    lowLatency: 'off',
  },
});

// The honest all-false degrade (device 1 in the multi-device session + the
// RID_MOCK_GRAPHICS_UNSUPPORTED knob + the no-Intel session).
const GRAPHICS_DEGRADED = Object.freeze({
  supported: { frameGen: false, flipModes: false, frameLimit: false, lowLatency: false },
  supportedOptions: { frameGen: [], flipModes: [], lowLatency: [] },
  frameLimitRange: null,
  values: { frameGenOverride: null, flipMode: null, frameLimit: null, lowLatency: null },
});

// The mock's default driver fan curve (10 points) - reported by every
// fan-bearing featureset and restored by resetToDefaults. MUST equal
// pure/curve.ts STOCK_FAN_CURVE (the canonical stock Intel table - the
// M4N fixed table capped at 50 % @ 85 C; pinned by test/mock-backend.test.js;
// the main bundle cannot import renderer TS, so the literal stays here
// with the pin as the sync guarantee).
export const DEFAULT_FAN_CURVE = [
  { t: 20, speedPct: 20 }, { t: 30, speedPct: 22 }, { t: 40, speedPct: 25 },
  { t: 50, speedPct: 28 }, { t: 60, speedPct: 32 }, { t: 65, speedPct: 35 },
  { t: 70, speedPct: 40 }, { t: 75, speedPct: 44 }, { t: 80, speedPct: 47 },
  { t: 85, speedPct: 50 },
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
   *   fanFixed?: boolean,                // M20-B: overlay - the flat-table-fixed session
   *                                      // (RID_MOCK_FAN_FIXED=1): the learned modes
   *                                      // include 'fixed' + the read-back derives
   *                                      // 'fixed' from a flat table
   *   offGridFreqMhz?: number,           // report a driver freq offset off the 1 MHz grid (ui-verify only)
   *   telemetryIntervalS?: number,       // mock wall-clock between samples (default 0.5)
   *   energyStepJ?: number,              // energy added per sample (default from the
   *                                      // featureset powerW: powerW * intervalS)
   *   extendedRanges?: boolean,          // overlay on the featureset extendedRanges flag
   *   extendedFail?: boolean,            // extended applies fail with the honest unavailable message
   *   multiDevice?: boolean,             // emit the dGPU + iGPU fixture
   *   reverseEnumeration?: boolean,      // reverse raw fixture order before sorting
   *   graphicsUnsupported?: boolean,     // honest all-false graphics surface
   *                                      // (RID_MOCK_GRAPHICS_UNSUPPORTED=1)
   *                                      // the multi-device iGPU degrades regardless
   *   laptopInfoOf?: () => object|null,  // M17c: the laptop sysinfo provider
   *                                      // (the real backend's vramBytesOf-style
   *                                      // injection - the caps AIB decode's
   *                                      // laptop branch mirrors it)
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
    this._reverseEnumeration = opts.reverseEnumeration === true || process.env.RID_MOCK_REVERSED_ENUM === '1';
    // M20-B: the flat-table-fixed session knob (RID_MOCK_FAN_FIXED=1) - the
    // probe's flat-table fallback learned 'fixed' (modes
    // ['auto','curve','fixed']) and the read-back derives 'fixed' from a
    // flat table. The mock default keeps the honest no-fixed card (the M4-C
    // pins stay green); the knob variant pins the enabled Fixed chip + the
    // fixed apply round trip.
    this._fanFixed = opts.fanFixed === true || process.env.RID_MOCK_FAN_FIXED === '1';
    // 1.0.1 no-Intel round: the no-Intel session (RID_MOCK_NO_INTEL=1 or the
    // constructor flag) - listDevices enumerates NOTHING and health reports
    // igclLoaded false, the exact shape a REAL no-Intel machine reports
    // (the IGCL init failure degrades to an empty list in main). The
    // renderer then boots in the no-device mode.
    this._noIntel = opts.noIntel === true || process.env.RID_MOCK_NO_INTEL === '1';
    // M8: the unsupported-graphics session knob (the RID_MOCK_FAN_READONLY
    // pattern) - the WHOLE graphics surface degrades to the
    // supported-all-false state. The multi-device iGPU (device 1) degrades
    // regardless (honest - an iGPU exposes no 3D-feature overrides).
    this._graphicsUnsupported = opts.graphicsUnsupported === true || process.env.RID_MOCK_GRAPHICS_UNSUPPORTED === '1';
    // M17c: the laptop sysinfo provider (the caps AIB decode's laptop
    // branch - mirrors the real backend's injection).
    this._laptopInfoOf = typeof opts.laptopInfoOf === 'function' ? opts.laptopInfoOf : null;
    // M17c: the iGPU temperature-fallback parity knob (RID_MOCK_SENSOR_TEMP
    // _FALLBACK=1): sampleRawTelemetry simulates an ABSENT telemetry
    // temperature item and supplies tempC from the mock "sensor" source -
    // the real backend's ctlTemperatureGetState fallback mirror.
    this._sensorTempFallback = opts.sensorTempFallback === true || process.env.RID_MOCK_SENSOR_TEMP_FALLBACK === '1';
    // M17c: the session refused-ceiling store (the real backend's
    // parent-side merge mirror - getCapabilities merges it).
    this._refusedCeilings = createRefusedCeilingStore();
    // M17g: the V2-COMPANION-CALL RECORDING (the deterministic pin
    // surface for the PL2-on-advanced companion - the sysman mock's calls
    // recording pattern): every applySettings call carrying a W-unit
    // powerLimitW in an ADVANCED session IS the companion write (the
    // routed split never sends PL to the driverstore block in advanced
    // mode - the V1 path owns it; a stock-mode apply never records by the
    // same gate). Session-level, never reset by a featureset swap.
    this._v2CompanionCalls = [];
    // Device ids are session enumeration ids. Consent/subscriptions survive
    // rebuilds in this durable-keyed registry, never in an id-keyed cache.
    this._deviceStateByKey = new Map();
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
        featureset: this._primaryFeatureset,
        waiverAccepted: this._waiverAccepted,
        extendedCapable: this._extended,
        telemetryCbs: this._telemetryCbs,
        // M8: the graphics state (the fixture values the apply mutates).
        graphics: this._graphics,
      };
    }
    const e = this._extraDevices.get(id);
    if (!e) throw new Error(`mock-backend: unknown device id ${id}`);
    return e;
  }

  /** M29: the second device is Arc iGPU by default; mixed mode uses A750. */
  _secondFeatureset() {
    const { featureset, warning } = loadFeaturesetOrFallback(
      process.env.RID_MOCK_MULTI_ARC === '1' ? 'a750' : 'arc-igpu',
    );
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
   * telemetry subscriptions survive per device (the swap rebuilds caps/state/timeline only).
   */
  _applyFeatureset(fs) {
    // Rebuild the capability/state surface without allowing session ids to
    // rebind consent or telemetry subscriptions to another physical adapter.
    // Device ids are assigned only after the fresh devices have been sorted;
    // the durable deviceKey is the sole state/cache identity.
    const remember = (entry) => {
      if (!entry?.device?.deviceKey) return;
      this._deviceStateByKey.set(entry.device.deviceKey, {
        waiverAccepted: entry.waiverAccepted === true,
        telemetryCbs: entry.telemetryCbs instanceof Set ? entry.telemetryCbs : new Set(),
      });
    };
    if (this._device) {
      remember({
        device: this._device,
        waiverAccepted: this._waiverAccepted,
        telemetryCbs: this._telemetryCbs,
      });
      for (const entry of this._extraDevices.values()) remember(entry);
    }

    // Refusal ceilings are session-id keyed. A featureset rebuild creates a
    // fresh session surface, so discard them rather than applying an old
    // numeric id's ceiling to a newly sorted adapter.
    this._refusedCeilings = createRefusedCeilingStore();
    this._featureset = fs;
    this._energyStepJ = this._energyStepOverride !== null
      ? this._energyStepOverride
      : fs.telemetry.powerW * this._intervalS;
    this._extended = this._extendedOverlay !== undefined
      ? this._extendedOverlay
      : fs.extendedRanges === true;
    this._fanCanControl = fs.hasFan && (this._fanOverlay !== undefined
      ? this._fanOverlay
      : fs.fanCanControl === true);

    const makeEntry = (featureset, rawId, extended = this._extended, fanCanControl = this._fanCanControl) => {
      const device = this._buildDevice(featureset, rawId);
      const prior = this._deviceStateByKey.get(device.deviceKey);
      return {
        device,
        caps: this._buildCaps(featureset, extended, fanCanControl, device.deviceKey),
        state: this._buildState(featureset),
        featureset,
        extendedCapable: extended,
        energyStepJ: this._energyStepOverride !== null
          ? this._energyStepOverride
          : featureset.telemetry.powerW * this._intervalS,
        tick: 0,
        waiverAccepted: prior?.waiverAccepted === true,
        telemetryCbs: prior?.telemetryCbs instanceof Set ? prior.telemetryCbs : new Set(),
        graphics: JSON.parse(JSON.stringify(GRAPHICS_FIXTURE.values)),
      };
    };

    const entries = [makeEntry(fs, 0)];
    if (this._multiDevice) {
      const fs2 = this._secondFeatureset();
      entries.push(makeEntry(fs2, 1, fs2.extendedRanges === true, fs2.hasFan && fs2.fanCanControl === true));
    }
    const ordered = this._reverseEnumeration
      ? sortDevicesDiscreteFirst([...entries].reverse().map((entry) => entry.device))
      : sortDevicesDiscreteFirst(entries.map((entry) => entry.device));
    const byDevice = new Map(entries.map((entry) => [entry.device.deviceKey, entry]));
    const first = byDevice.get(ordered[0].deviceKey);
    first.device.id = 0;
    this._device = first.device;
    this._caps = first.caps;
    this._state = first.state;
    // Keep _primaryFeatureset tied to the sorted session-id-0 fixture. The
    // requested physical primary remains _featureset for listFeaturesets()
    // and swap identity responses.
    this._primaryFeatureset = first.featureset;
    // The legacy extended runtime is also device-0 scoped; after sorting it
    // must follow the actual primary rather than the requested dropdown fs.
    this._extended = this._extendedOverlay !== undefined
      ? this._extendedOverlay
      : first.featureset.extendedRanges === true;
    this._energyStepJ = first.energyStepJ;
    this._tick = first.tick;
    this._waiverAccepted = first.waiverAccepted;
    this._telemetryCbs = first.telemetryCbs;
    this._graphics = first.graphics;
    this._extraDevices.clear();
    for (let index = 1; index < ordered.length; index += 1) {
      const entry = byDevice.get(ordered[index].deviceKey);
      entry.device.id = index;
      this._extraDevices.set(index, entry);
    }
    this._failOn = {};
    this._failOnce = {};
  }

  _buildCaps(fs, extended, fanCanControl = this._fanCanControl, deviceKey = null) {
    // Parity with IgclBackend: every control key is emitted explicitly
    // (supported -> true, otherwise false) so consumers never see undefined.
    const controls = {
      gpuFreqOffset: false, gpuVoltOffset: false, gpuLock: false,
      vramFreqOffset: false, vramVoltOffset: false,
      powerLimit: false, tempLimit: false, vfCurve: false,
    };
    for (const c of fs.supportedControls) controls[c] = true;
    const ranges = JSON.parse(JSON.stringify(fs.ranges));
    // M33: the selected OC mode owns the visible W/C capability shape. The
    // `extended` argument remains the bundled-runtime capability signal;
    // routing refuses values above that runtime when it is unavailable.
    const advancedShape = this._ocMode === 'advanced';
    if (advancedShape && ranges.powerLimitW && fs.extended?.plMax > 0) {
      ranges.powerLimitW.max = fs.extended.plMax;
    }
    if (advancedShape && ranges.tempLimitC && fs.extended?.tlMax > 0) {
      ranges.tempLimitC.max = fs.extended.tlMax;
    }
    const caps = {
      oemName: 'Intel (mock)',
      // Mirror the real backend's stable identity so the old-runtime mock
      // and the real apply route exercise the same target contract.
      deviceKey,
      // M33: expose the selected mode separately from runtime availability
      // so the renderer keeps Advanced ceilings visible when routing degrades.
      ocMode: this._ocMode,
      // M4-B step-4 F1: the VRAM suffix is formatted HERE too (not only in
      // _buildDevice) - every dialog (boot waiver, apply-time waiver,
      // advanced-mode confirm) renders caps.deviceName, so mock and real
      // backends must agree and the dialogs must match the header/card.
      // M4-I (S1): the memType rides the caps payload too (the VRAM row's
      // type source - the fixture supplies it; the mock name token would
      // derive it anyway).
      deviceName: formatDeviceName(fs.deviceName, fs.vramBytes ?? null, fs.memType ?? undefined),
      memType: fs.memType ?? null,
      controls,
      // M17: mirror IgclBackend - a device with no OC control (pro-b50 /
      // arc-igpu) has no warranty waiver; the UI must not prompt for it.
      overclockingSupported: Object.values(controls).some(Boolean),
      ranges,
      fan: this._buildFanCaps(fs, fanCanControl),
    };
    // M33: the bundled-2023-runtime flag is separate from the visible
    // capability shape. It is advertised only when the runtime is capable in
    // the selected advanced mode; routing uses it for honest refusal.
    if (extended && this._ocMode === 'advanced') caps.extendedRanges = true;
    // M17c: the AIB-identity fields - the SAME decode the real backend
    // runs in getCapabilities (pure/aib.ts from the fixture subsystem
    // fields + the injected laptopInfoOf provider - the mock mirrors the
    // laptop branch too, so the mock-refusal/verify sessions exercise the
    // same payload the renderer sees). Absent fixture fields -> null.
    caps.pciDeviceId = typeof fs.pciDeviceId === 'string' ? fs.pciDeviceId : null;
    // M17e: the per-GPU gpuLock bounds (the caps.lockRange payload - the
    // fixture row when present; ABSENT otherwise, exactly like the real
    // backend whose driver reports no range - the renderer's documented
    // fallback covers it). Mirror the real backend's LISTED-CARD fallback
    // (pure/lock-ranges.ts) when the fixture carries no row on a
    // gpuLock-capable device - the drift guard keeps mock caps == real caps
    // for the same card.
    if (fs.lockRange) {
      caps.lockRange = fs.lockRange;
    } else if (controls.gpuLock === true && typeof caps.pciDeviceId === 'string') {
      const listed = lockRangeOf(caps.pciDeviceId);
      if (listed) caps.lockRange = listed;
    }
    const laptopInfo = this._laptopInfoOf ? this._laptopInfoOf() : null;
    const laptopDecoded = laptopInfo ? laptopAibOf(laptopInfo) : null;
    const subsysVendor = typeof fs.pciSubsysVendorId === 'number' ? fs.pciSubsysVendorId : null;
    const subsysId = typeof fs.pciSubsysId === 'number' ? fs.pciSubsysId : null;
    const aib = laptopDecoded ?? aibOf(subsysVendor, subsysId);
    caps.aibVendor = aib?.vendor ?? null;
    caps.aibModel = aib?.model ?? null;
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
      const sortedPrimary = this._primaryFeatureset;
      const primaryExtended = this._extendedOverlay !== undefined
        ? this._extendedOverlay
        : sortedPrimary.extendedRanges === true;
      const primaryFan = sortedPrimary.hasFan && (this._fanOverlay !== undefined
        ? this._fanOverlay
        : sortedPrimary.fanCanControl === true);
      this._caps = this._buildCaps(sortedPrimary, primaryExtended, primaryFan, this._device?.deviceKey ?? null);
      for (const e of this._extraDevices.values()) {
        e.caps = this._buildCaps(e.featureset, e.featureset.extendedRanges === true, e.featureset.hasFan && e.featureset.fanCanControl === true, e.device.deviceKey);
      }
    }
    return next;
  }

  _buildFanCaps(fs, fanCanControl = this._fanCanControl) {
    if (!fs.hasFan) {
      return { canControl: false, modes: [], maxRpm: -1, maxCurvePoints: 0 };
    }
    if (fanCanControl) {
      // M20-B: the flat-table-fixed session (RID_MOCK_FAN_FIXED=1) models
      // the probe's fallback verdict - the learned modes include 'fixed'
      // (the real A770 after the flat-table fallback probe).
      const modes = this._fanFixed ? ['auto', 'curve', 'fixed'] : FAN_EDITABLE.modes;
      return { ...FAN_EDITABLE, modes, maxCurvePoints: fs.fanMaxCurvePoints || 10 };
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
      bdf: id === 0 ? { bus: 3, device: 0, function: 0 } : { bus: 0, device: 2, function: 0 },
      deviceKey: deviceHardwareKey({
        pciVendorId: '0x00008086',
        pciDeviceId: fs.pciDeviceId ?? '0x000056a0',
        bdf: id === 0 ? { bus: 3, device: 0, function: 0 } : { bus: 0, device: 2, function: 0 },
      }),
      pciSubsysVendorId: typeof fs.pciSubsysVendorId === 'number' ? fs.pciSubsysVendorId : null,
      pciSubsysId: typeof fs.pciSubsysId === 'number' ? fs.pciSubsysId : null,
    };
  }

  _buildState(fs) {
    const state = {
      gpuLock: fs.supportedControls.includes('gpuLock') ? { voltageV: 0, freqMhz: 0 } : null,
      vfCurve: null,
      vfCurveUnits: null,
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
   * M4-F/M29: the target device id is optional for compatibility with the
   * historical one-argument adapter calls; omitted means session id 0.
   * Target caps/featureset/state remain paired after discrete-first sorting.
   * @param {'powerLimitW'|'tempLimitC'} control
   * @param {number} value
   * @param {number|undefined|null} deviceId
   * @returns {Promise<{ ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean }>}
   */
  async extendedApply(control, value, deviceId = 0) {
    const entry = this._entry(deviceId);
    // M17d (Run E): the injected waiver-not-set fail reaches the V1 path -
    // the bundled 2023 runtime's write answers the SAME driver-state code
    // (0x44000008) any write answers when the driver lost the waiver, so
    // the mock's V1 setter must mirror it (the ui-verify renderer-side
    // re-prompt pin drives exactly this). ONLY the waiver-not-set code is
    // honored here: the other injected codes (out-of-range / io-failed /
    // unsupported) stay V2-path-scoped by the existing pins - they model
    // RUNTIME-specific answers (the V2 client clamp, the V1 clamp) whose
    // injection point is deliberately the driverstore path.
    if (this._failOn[control] === 'waiver-not-set') {
      const errorCode = this._failOn[control];
      this._consumeFailOnce(control);
      return { ok: false, errorCode, readBackEqual: false, message: `injected failure (${control})` };
    }
    if (!entry.extendedCapable || this._extendedFail) {
      return { ok: false, errorCode: 'unsupported', readBackEqual: false, message: EXTENDED_UNAVAILABLE_MSG };
    }
    // M4O + M21: clamp against the real bundled 2023 runtime's write range -
    // the FEATURE's TL max (fs.extended.tlMax - featureset-faithful:
    // 115 for a770; keeps b580/pro-b50 honest if their maxes differ) and
    // the pinned V1 PL write-range 315 (MOCK_V1_PL_MAX_W - the real
    // ctlOverclockPowerLimitSet clamps at EXTENDED_PL_RANGE 315; the mock
    // must refuse a >315 value via the V1 path exactly like the real
    // runtime even though fs.extended.plMax now exposes 375). NEVER
    // this._caps.ranges - that range
    // set is MODE-GATED (252 in a stock session) while the real bundled
    // 2023 runtime clamps mode-independently (old-igcl.js EXTENDED_PL_RANGE/
    // EXTENDED_TL_RANGE). The mock must mirror the real runtime: a stock
    // session's extendedApply accepts the same values the driver does.
    const fs = entry.featureset;
    const extendedMax = control === 'powerLimitW' ? MOCK_V1_PL_MAX_W : fs.extended?.tlMax;
    const base = entry.caps.ranges[control];
    const range = {
      ...base,
      max: typeof extendedMax === 'number' ? extendedMax : base?.max,
    };
    const clamped = clampAndSnap(value, range);
    entry.state[control] = clamped;
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
   * the renderer can re-render the WHOLE UI surface from one response.
   * `activeDeviceKey` identifies the requested physical slot even when
   * discrete-first sorting assigns that device a different session id.
   * @param {string} id
   * @returns {Promise<{ featureset: {id: string, name: string, tag: string}, activeDeviceKey: string, devices: object[], caps: object, state: object, health: object }>}
   */
  async setFeatureset(id) {
    const { featureset, warning } = loadFeaturesetOrFallback(id);
    if (warning) {
      this._featuresetWarning = warning;
      console.error(`[mock-backend] ${warning}`);
    }
    this._applyFeatureset(featureset);
    const devices = await this.listDevices();
    const active = devices.find((device) => device.deviceKey === this._buildDevice(featureset, 0).deviceKey);
    if (!active) throw new Error('mock-backend: active featureset device disappeared');
    return {
      featureset: { id: featureset.id, name: featureset.name, tag: featureset.tag ?? '' },
      activeDeviceKey: active.deviceKey,
      devices,
      caps: await this.getCapabilities(active.id),
      state: await this.getCurrentSettings(active.id),
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
    const raw = [{ ...this._device }];
    for (const e of this._extraDevices.values()) raw.push({ ...e.device });
    return sortDevicesDiscreteFirst(raw).map((device, id) => ({ ...device, id }));
  }

  /**
   * M4-D2 (driver ReBAR state): the mock reports the fixture's driver
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

  /**
   * M17c/M17d (step-4 N1 + round-1 S1): the DEVICE-LIMITS table application
   * - the mock mirrors the real backend's _finalizeCaps table section (the
   * same pure table, the same row resolution + units guard + min-cap + step
   * rules) with the STOCK/ADVANCED SPLIT: the ACTIVE shape's ceilings apply
   * (the stock per-AIB maxes + the TL 90 caps; the advanced per-card KMD
   * ceilings - a770 375/115, a750 270/115 - the A750 TL probe-verified
   * 2026-08-12). The mock must expose the SAME
   * ranges as the real caps or the mock slider offers a window the real
   * caps refuse. MUTATES caps.ranges in place
   * (deterministic + idempotent - a re-finalize is a no-op); the caller
   * passes the fresh per-read clone.
   * @param {number} deviceId
   * @param {object} caps the per-read caps clone (carries the AIB fields)
   */
  _finalizeCaps(deviceId, caps) {
    const identity = {
      pciDeviceId: caps.pciDeviceId ?? null,
      aibVendor: caps.aibVendor ?? null,
      aibModel: caps.aibModel ?? null,
    };
    // M33: selected persisted OC mode owns the visible capability shape;
    // the bundled-runtime flag remains separate and reports availability.
    const advancedShape = this._ocMode === 'advanced';
    const limits = deviceLimitsOf(identity, { advanced: advancedShape });
    if (limits) {
      // The UNLISTED path gets the DEFAULT row of the ACTIVE range set
      // (stock 252/90, advanced 315/115); a LISTED card's row is the ACTIVE
      // shape (stock or advanced - round-2 S8).
      const row = limits.listed ? limits : defaultLimitsOf(advancedShape);
      for (const [canonical, override] of Object.entries(row)) {
        if (canonical === 'listed') continue;
        const range = caps.ranges[canonical];
        if (!range) continue;
        // The M4-E units rule: the table speaks W/V/C - percent-unit
        // ranges (Battlemage) are never touched.
        if (canonical === 'powerLimitW' && range.units !== 'W') continue;
        if (canonical === 'tempLimitC' && range.units !== 'C') continue;
        if (canonical === 'gpuVoltOffsetV' && range.units !== 'V') continue;
        let next = range;
        if (typeof override.max === 'number') {
          if (canonical === 'gpuVoltOffsetV') {
            // The volt maxes are the M15 probe-ceiling PINS (both
            // directions); the store merge below is the only downward force.
            next = { ...next, max: override.max };
          } else if (advancedShape) {
            next = { ...next, max: override.max };
          } else {
            next = { ...next, max: Math.min(range.max, override.max) };
          }
          if (typeof range.default === 'number' && Number.isFinite(range.default)) {
            next = { ...next, default: Math.min(range.default, next.max) };
          }
        }
        // M26: mirror the real backend - a device-limits min is authoritative
        // for a V-unit row, even when the raw fixture already supplies a
        // shallower or stale min.
        if (typeof override.min === 'number' && Number.isFinite(override.min)) {
          next = { ...next, min: override.min };
        }
        if (typeof override.step === 'number' && Number.isFinite(override.step)) {
          next = { ...next, step: override.step };
        }
        if (next !== range) caps.ranges[canonical] = next;
      }
    }
  }

  async getCapabilities(deviceId = 0) {
    const e = this._entry(deviceId);
    const caps = JSON.parse(JSON.stringify(e.caps));
    caps.waiverAccepted = e.waiverAccepted;
    // M17c: the session refused-ceiling store merge + the DEVICE-LIMITS
    // table - the mock mirrors the real backend's getCapabilities finalize
    // (table first, THEN the store merge - the same order the real
    // _finalizeCaps runs; a store-degraded ceiling is never re-raised by
    // the table). Step-4 N1: the table mirror closes the mock gap where
    // the listed a770 advanced TL 115 stayed exposed while the real caps
    // cap it at the documented 90 - the mock-refusal/verify sessions now
    // exercise the same final ranges the renderer sees. The mock
    // featuresets still encode the per-card BASE ranges (the fixture's
    // driver-props truth); the table + the store ride on top like the real
    // backend's caps.
    this._finalizeCaps(deviceId, caps);
    caps.ranges = mergeIntoRanges(this._refusedCeilings, deviceId, caps.ranges);
    return caps;
  }

  /**
   * M17c: the SHARED refusal recording (the real backend's
   * recordApplyRefusals mirror - the ipc-core/apply-on-boot apply paths
   * feed it; the next getCapabilities read merges the degraded ceiling).
   * @param {number} deviceId
   * @param {{ perControl?: object }} result the apply result envelope
   * @param {object|null|undefined} settings the ATTEMPTED settings
   */
  recordApplyRefusals(deviceId, result, settings) {
    if (!result || typeof result !== 'object' || !result.perControl) return;
    const entry = deviceId === undefined || deviceId === null || deviceId === 0
      ? { caps: this._caps }
      : this._extraDevices.get(deviceId);
    if (!entry) return;
    const ranges = entry.caps?.ranges ?? null;
    recordRefusalEnvelope(this._refusedCeilings, deviceId, result.perControl, settings, ranges);
  }

  async getCurrentSettings(deviceId = 0) {
    const s = this._entry(deviceId).state;
    // M20-B: the flat-table -> 'fixed' derivation mirrors the real backend's
    // read-back - a flat fanCurve (>= 2 points, all speeds equal within 1,
    // PERCENT units - the mock curve is canonical % by construction) in
    // TABLE/curve mode IS a fixed speed. The dual report keeps fanCurve
    // populated (the Curve chip still shows the points).
    const flatCurve = s.fanMode === 'curve' && s.fanCurve !== null && s.fanCurve.length >= 2
      && s.fanCurve.every((p) => p.speedPct !== null && Math.abs(p.speedPct - s.fanCurve[0].speedPct) <= 1);
    return {
      powerLimitW: s.powerLimitW,
      gpuVoltOffsetV: s.gpuVoltOffsetV,
      gpuFreqOffsetMhz: s.gpuFreqOffsetMhz,
      tempLimitC: s.tempLimitC,
      vramFreqOffsetGts: s.vramFreqOffsetGts,
      vramVoltOffsetV: s.vramVoltOffsetV,
      gpuLock: s.gpuLock ? { ...s.gpuLock } : null,
      vfCurve: s.vfCurve ? s.vfCurve.map((p) => ({ ...p })) : null,
      fanMode: flatCurve ? 'fixed' : s.fanMode,
      fanCurve: s.fanCurve ? s.fanCurve.map((p) => ({ ...p })) : null,
      fixedFanPct: flatCurve ? s.fanCurve[0].speedPct : s.fixedFanPct,
    };
  }

  /**
   * M8: the Graphics tab's mock state. Device 0 serves the fixture (all
   * four features supported, the probe-recorded frame-limit range, the
   * option lists mirroring the live caps - no speed-frame, no on-boost);
   * the apply mutates the device's own copy so the next read reflects it
   * (the mock round trip). Device 1 (the multi-device iGPU) and the
   * RID_MOCK_GRAPHICS_UNSUPPORTED knob serve the honest supported-all-false
   * degrade - a device switch must never crash the page. Never throws.
   * @param {number} [deviceId]
   * @returns {Promise<object>} the GraphicsState shape
   */
  async getGraphicsSettings(deviceId = 0) {
    const id = deviceId === undefined || deviceId === null ? 0 : deviceId;
    const degraded = id !== 0 || this._graphicsUnsupported || this._noIntel;
    if (degraded) {
      return JSON.parse(JSON.stringify(GRAPHICS_DEGRADED));
    }
    const e = this._entry(id);
    return {
      supported: { ...GRAPHICS_FIXTURE.supported },
      supportedOptions: JSON.parse(JSON.stringify(GRAPHICS_FIXTURE.supportedOptions)),
      frameLimitRange: { ...GRAPHICS_FIXTURE.frameLimitRange },
      values: JSON.parse(JSON.stringify(e.graphics)),
    };
  }

  /**
   * M8: apply the Graphics tab's settings (the mock round trip): the
   * payload lands in the device's graphics state (frame-limit value clamped
   * to the fixture range - mirror the real backend's clamp); the next
   * getGraphicsSettings read-back reflects it. The degraded surfaces refuse
   * every control with the honest 'unsupported' (a device switch must never
   * crash). Returns the ApplyResult shape.
   * @param {number} [deviceId]
   * @param {object} settings
   * @returns {Promise<{ ok: boolean, perControl: object }>}
   */
  async setGraphicsSettings(deviceId = 0, settings = {}) {
    const id = deviceId === undefined || deviceId === null ? 0 : deviceId;
    const result = { ok: true, perControl: {} };
    const controls = ['frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency']
      .filter((c) => settings[c] !== null && settings[c] !== undefined);
    const degraded = id !== 0 || this._graphicsUnsupported || this._noIntel;
    if (degraded) {
      for (const c of controls) {
        result.perControl[c] = { ok: false, errorCode: 'unsupported', message: 'graphics features are not supported on this device' };
      }
      result.ok = controls.length === 0;
      return result;
    }
    const e = this._entry(id);
    if (settings.frameGenOverride !== undefined && settings.frameGenOverride !== null) {
      e.graphics.frameGenOverride = settings.frameGenOverride;
      result.perControl.frameGenOverride = { ok: true, readBackEqual: true };
    }
    if (settings.flipMode !== undefined && settings.flipMode !== null) {
      e.graphics.flipMode = settings.flipMode;
      result.perControl.flipMode = { ok: true, readBackEqual: true };
    }
    if (settings.lowLatency !== undefined && settings.lowLatency !== null) {
      e.graphics.lowLatency = settings.lowLatency;
      result.perControl.lowLatency = { ok: true, readBackEqual: true };
    }
    if (settings.frameLimit !== undefined && settings.frameLimit !== null) {
      const clamped = clampAndSnap(settings.frameLimit.value, GRAPHICS_FIXTURE.frameLimitRange);
      e.graphics.frameLimit = { enabled: settings.frameLimit.enabled === true, value: clamped };
      result.perControl.frameLimit = { ok: true, readBackEqual: true };
    }
    return result;
  }

  async applySettings(deviceId, settings = {}, opts = {}) {
    // M4-F: operate on the TARGET device's caps + state (device 0 keeps the
    // legacy fields; devices > 0 hit their map entry).
    const e = this._entry(deviceId);
    const caps = e.caps;
    const state = e.state;
    const result = { ok: true, perControl: {} };

    // M22: the apply-while-LOCKED refusal mirror - the HONEST behavior the
    // renderer's fixed payloads now produce. A NON-ZERO HELD lock
    // (state.gpuLock - evaluated on the PRE-payload held lock, before ANY
    // state mutation) refuses the payload's ORIGINAL offset keys
    // (gpuFreqOffsetMhz / gpuVoltOffsetV - INCLUDING zero-valued ones: the
    // lock editor's 0/0 reset is an offset-reset payload, refused like any
    // offset write) with the IN_VOLTAGE_LOCKED_MODE class (per-control
    // errorCode 'locked-mode', NO message - applyFailureText prefers
    // per.message over the mapping, so the reworded errors.ts 'locked-mode'
    // text only renders here; the real backend always emits its IGCL status
    // message). The refusal is measured against the PRE-NORMALIZATION
    // payload (rawSettings) - the M17e lock-vs-offset normalization below
    // ADDS synthetic zero-offset keys to LOCK-ONLY payloads, and those
    // synthetic keys must NOT trigger the refusal (a LOCK-ONLY payload is  not
    // an offset apply; its final state stays lock + offsets 0). The gpuLock
    // key itself processes normally regardless (a non-zero pair
    // lands/changes the lock; a {0,0} pair still writes per the mock's existing
    // {0,0} handling - the renderer never sends it, but the backend contract
    // for a direct caller stays). The refusal is evaluated BEFORE the scalar
    // applies - the lock editor's OWN atomic payloads (zero offsets + a pair)
    // applied while a DIFFERENT lock is held refuse their offset keys and
    // still LAND the lock - coherent with the real backend's offsets-first
    // write order on a locked driver (the real driver refuses the offset
    // writes and the lock write proceeds).
    const rawSettings = settings;
    const heldLock = state.gpuLock;
    const heldLockNonZero = !!(heldLock && (heldLock.voltageV !== 0 || heldLock.freqMhz !== 0));
    const payloadHadOffsetKey = (key) => rawSettings[key] !== null && rawSettings[key] !== undefined;

    // M17e (round-1 S1b, mock parity): mirror IgclBackend's UNIVERSAL
    // lock-vs-offset normalization - a non-zero gpuLock forces the carried
    // freq/volt offsets to 0 (a legacy/hand-edited profile with lock +
    // non-zero offsets ends at lock + offsets 0; PL/TL untouched). The mock
    // has no IN_VOLTAGE_LOCKED_MODE, but its final STATE must equal the real
    // backend's - the drift guard.
    // M17e (round-2 S1, mock parity): the zeroed offset keys are ADDED
    // UNCONDITIONALLY - a LOCK-ONLY payload (no offset keys carried) must
    // STILL zero the driver's offsets (the real backend writes the two
    // zero-offset applies before the lock; the mock mirrors the final
    // state: lock + offsets 0).
    if (settings.gpuLock
      && !(settings.gpuLock.voltageV === 0 && settings.gpuLock.freqMhz === 0)) {
      const out = { ...settings };
      out.gpuFreqOffsetMhz = 0;
      out.gpuVoltOffsetV = 0;
      settings = out;
    }

    // M17g: the V2-companion recording (the deterministic pin surface) -
    // in an ADVANCED session every applySettings call carrying a W-unit
    // powerLimitW IS the V2 companion write (the routed split sends PL to
    // the bundled-2023-runtime V1 path in advanced mode, never the
    // driverstore block; a STOCK-mode apply never records by the same
    // gate). Units-aware: the percent-unit b580 never records (the units
    // gate in apply-routing skips the companion there too).
    const plUnits = caps.ranges.powerLimitW?.units;
    if (this._ocMode === 'advanced'
      && settings.powerLimitW !== undefined
      && (plUnits === undefined || plUnits === 'W')) {
      this._v2CompanionCalls.push(settings.powerLimitW);
    }

    const applyScalar = (control, canonicalName, value) => {
      if (value === null || value === undefined) return;
      // M22: the locked-refusal mirror - while a non-zero lock is HELD and
      // the ORIGINAL payload carried this offset key, refuse it per-control
      // (the lock editor's 0/0 reset is an offset-reset payload, so
      // zero-valued offsets refuse the same way); the refusal wins over the
      // inject-fail + clamp machinery (the driver refuses BEFORE any
      // acceptance logic).
      if (heldLockNonZero
        && (canonicalName === 'gpuVoltOffsetV' || canonicalName === 'gpuFreqOffsetMhz')
        && payloadHadOffsetKey(canonicalName)) {
        result.perControl[canonicalName] = { ok: false, errorCode: 'locked-mode' };
        result.ok = false;
        return;
      }
      if (canonicalName === 'powerLimitW' || canonicalName === 'tempLimitC') {
      }
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
      // M17g: the V2/DriverStore acceptance ceiling (the PL2-on-advanced
      // mock parity - the 0x44000004 refusal class). The DriverStore path
      // itself accepts only up to the FIXTURE's stock props max (252 a770 /
      // 216 a750 - the same values the M17d probes pinned: the DriverStore
      // path refuses 228/235/250 with 0x44000004 on the Acer A750). The
      // gate is MODE-INDEPENDENT because the DRIVER's acceptance is
      // mode-independent: the app's session mode only changes the app-side
      // exposed max (the V1/KMD ceiling), never what the V2 setter accepts.
      // The V2 companion is the ONLY backend PL writer above the stock
      // ceiling - the routed split sends advanced PL to the V1 path (never
      // the driverstore block) and the stock-mode execute path pre-clamps
      // at the app-side ceiling, so the gate models the driver's own
      // refusal exactly where the mock needs it.
      // Test-only corner (honest direction): a DIRECT backend.applySettings
      // call in a stock session with a value above the stock ceiling
      // REFUSES here while the real IgclBackend.applySettings clamps to the
      // stock caps and reports ok - no product path reaches the backend
      // un-clamped (stock applies are pre-gated + executeApply-clamped), so
      // the mock's refusal is the honest direction (the M4O 'never silently
      // reduce a saved profile' intent).
      if (canonicalName === 'powerLimitW' && range && range.units === 'W') {
        const stockMax = this._entry(deviceId).featureset.ranges.powerLimitW?.max;
        if (typeof stockMax === 'number' && Number.isFinite(stockMax) && value > stockMax) {
          result.perControl[canonicalName] = { ok: false, errorCode: 'out-of-range', message: `the V2/DriverStore path refuses above the driver ceiling (${stockMax} W)` };
          result.ok = false;
          return;
        }
      }
      const clamped = opts.snapToStep === false
        ? Math.min(range.max, Math.max(range.min, Number.isFinite(value) ? value : range.min))
        : clampAndSnap(value, range);
      state[canonicalName] = clamped;
      result.perControl[canonicalName] = { ok: true, readBackEqual: true };
    };

    applyScalar('powerLimit', 'powerLimitW', settings.powerLimitW);
    applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', settings.gpuFreqOffsetMhz);
    applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', settings.gpuVoltOffsetV);
    applyScalar('tempLimit', 'tempLimitC', settings.tempLimitC);
    applyScalar('vramFreqOffset', 'vramFreqOffsetGts', settings.vramFreqOffsetGts);
    applyScalar('vramVoltOffset', 'vramVoltOffsetV', settings.vramVoltOffsetV);

    if (settings.gpuLock) {
      if (!caps.controls.gpuLock) {
        result.perControl.gpuLock = { ok: false, errorCode: 'unsupported', message: 'GPU lock not supported on this device' };
        result.ok = false;
      } else {
        // Mirror IgclBackend.applyLock: clamp to the per-device lockRange
        // when the caps carry one, else the documented lock bounds (the
        // (0,0) unlock pair always passes unclamped).
        state.gpuLock = clampGpuLock(settings.gpuLock, caps.lockRange);
        result.perControl.gpuLock = { ok: true, readBackEqual: true };
      }
    }

    if (settings.vfCurve) {
      if (!caps.controls.vfCurve) {
        result.perControl.vfCurve = { ok: false, errorCode: 'unsupported', message: 'custom VF curve not supported on this device' };
        result.ok = false;
      } else {
        // M17e (N9, mock parity): mirror IgclBackend's non-integer-volts
        // gate - the real ctl_voltage_frequency_point_t.Voltage is a uint32
        // (a fractional volt truncates to 0), so the mock refuses the same
        // payloads the real backend refuses (the drift guard).
        const nonInteger = settings.vfCurve.filter((p) => !Number.isInteger(p.voltageV));
        if (nonInteger.length > 0) {
          result.perControl.vfCurve = { ok: false, errorCode: 'out-of-range', message: 'VF curve voltages must be whole volts - the ctl_voltage_frequency_point_t.Voltage field is a uint32 (a fractional volt would truncate to 0) and its unit is unverified on this device' };
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
          // M20-B: the flat-table-fixed session mirrors the real backend's
          // fallback mechanism - a fixed apply WRITES A FLAT TABLE (the
          // card stays in TABLE mode; the read-back derivation flips it to
          // 'fixed'). The default (no knob) keeps the old direct-fixed mock
          // shape.
          if (this._fanFixed) {
            state.fanCurve = [
              { t: 20, speedPct: state.fixedFanPct },
              { t: 100, speedPct: state.fixedFanPct },
            ];
            state.fanMode = 'curve';
          } else {
            state.fanMode = 'fixed';
          }
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
      this._state = this._buildState(this._primaryFeatureset);
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
    // M17c: the iGPU temperature-fallback parity - under the
    // RID_MOCK_SENSOR_TEMP_FALLBACK knob the telemetry temperature ITEM is
    // ABSENT (the unsupported-item shape the real fallback exists for) and
    // tempC comes from the mock "sensor" source (the ctlTemperatureGetState
    // mirror) instead.
    const sensorFallback = this._sensorTempFallback;
    const itemTempC = sensorFallback ? undefined : tel.tempCBase + (tick % 30);
    const sample = {
      t: tBase + tick * this._intervalS,
      gpuClockMhz: tel.gpuClockBaseMhz + tick * 100,
      memClockMhz: tel.memClockMhz,
      tempC: itemTempC,
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
    if (sensorFallback) {
      // The mock sensor source: the same tempCBase ramp from a DIFFERENT
      // offset (the sensor read ≠ the telemetry item - the pin proves the
      // fallback path supplied the value).
      sample.tempC = tel.tempCBase + 2;
    }
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
 * M2C-C/M29: optional device ids are forwarded through the same seam. The
 * omitted target remains device 0 for old callers.
 * @param {MockBackend} backend
 */
export function createMockOldIgcl(backend) {
  return {
    isCapable: async (deviceId) => {
      if (deviceId === undefined || deviceId === null) return backend.extendedCapable;
      if (typeof backend.getCapabilities === 'function') return (await backend.getCapabilities(deviceId)).extendedRanges === true;
      return backend._entry(deviceId).extendedCapable;
    },
    setPowerLimitW: async (w, deviceId) => backend.extendedApply('powerLimitW', w, deviceId),
    setTempLimitC: async (c, deviceId) => backend.extendedApply('tempLimitC', c, deviceId),
    close: async () => {},
  };
}
