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

import { clampAndSnap, clampGpuLock, clampFanPct, formatDeviceName, normalizeFanCurve, sortDevicesDiscreteFirst, deviceHardwareKey, isIntegratedStyleDevice } from './units.js';
import { EXTENDED_UNAVAILABLE_MSG } from '../apply-routing.js';
import { collectHealth } from '../health.js';
import { loadFeaturesetOrFallback, listFeaturesetFiles, CONTROL_TO_CANONICAL } from './featuresets.js';
import { classifyXeFgExecutable } from '../game-profile-capabilities.js';
import {
  DISPLAY_QUANTIZATION_OPTIONS, DISPLAY_WIRE_FORMAT_OPTIONS, DISPLAY_BPC_OPTIONS,
  DISPLAY_SCALING_MODE_OPTIONS, DISPLAY_RETRO_SCALING_METHOD_OPTIONS,
  DISPLAY_ARC_SYNC_PROFILE_OPTIONS, DISPLAY_GLOBAL_VRR_MODE_OPTIONS,
  DISPLAY_SCALING_FLASH_WARNING,
} from './backend.interface.js';
// M17c: the pure AIB decode (aibOf + the laptop branch) - the SAME decode
// the real backend runs in getCapabilities (the renderer TS imports fine
// under the packaged Electron - Node 22.21 type stripping).
import { aibOf, laptopAibOf } from '../../renderer/pure/aib.ts';
// M17c/M17d: the per-device limits table - the MOCK mirrors the real
// backend's getCapabilities finalize (step-4 N1) with the STOCK/ADVANCED
// SPLIT (round-1 S1): the listed rows' ceilings per ACTIVE shape (the
// stock per-AIB maxes + the TL 90 caps; the advanced per-card KMD ceilings
// - a770 375/115, a750 270/115 - the A750 TL probe-verified 2026-08-12;
// the round-3-N3 rule flipped) so the mock
// slider never offers a window the real caps refuse.
import { deviceLimitsOf, defaultLimitsOf } from '../../renderer/pure/device-limits.ts';
// M17e: the listed-card lockRange fallback table (the mock mirrors the real
// backend's caps-level fallback when the fixture carries no lockRange row
// on a gpuLock-capable device).
import { lockRangeOf } from '../../renderer/pure/lock-ranges.ts';
// M17c: the session refused-ceiling store (the mock mirrors the real
// backend's parent-side merge - getCapabilities merges the store so the
// mock-refusal fixture exercises the same merge the renderer sees).
import { createRefusedCeilingStore, mergeIntoRanges, recordedCeilingsFor, recordRefusalEnvelope } from './refused-ceilings.js';

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

const displayCapability = (value, supported, controllable = false, reason = null, source = 'mock-fixture') => ({ value, supported, controllable, reason, source });
const DISPLAY_FIXTURE = Object.freeze({
  displays: [{
    id: 0,
    displayKey: null,
    identityVerified: true,
    name: 'Arc Power Mock Display',
    connection: 'DisplayPort',
    resolution: { width: 2560, height: 1440 },
    refreshRate: 144,
    colorDepth: 10,
    colorFormat: 'RGB',
    quantizationRange: 'default',
    scalingMode: 'identity',
    scalingDetails: { customX: 100, customY: 100, hardwareModeSet: false, preferredScalingType: 'identity' },
    scalingMethod: displayCapability({ enabled: true, method: 'integer' }, true, true, null, 'mock-fixture'),
    globalVrrMode: displayCapability('fullscreen', true, true, null, 'mock-fixture'),
    vrrMode: displayCapability('recommended', true, true, null, 'mock-fixture'),
    variableRefreshRate: displayCapability(true, true, true, null, 'mock-fixture'),
    vrrCurrentRange: displayCapability('90 Hz - 180 Hz', true, false, 'Read-only fixture capability', 'mock-fixture'),
    vrrMaximumRange: displayCapability('48 Hz - 180 Hz', true, false, 'Read-only fixture capability', 'mock-fixture'),
    hdcpSupport: displayCapability(true, true),
    fourKSupport: displayCapability(false, true),
    hdrSupport: displayCapability(false, true),
    hue: displayCapability(0, true, true, null, 'mock-color-correction'),
    saturation: displayCapability(1, true, true, null, 'mock-color-correction'),
    brightness: displayCapability(0, true, true, null, 'mock-color-correction'),
    contrast: displayCapability(1, true, true, null, 'mock-color-correction'),
    supportedOptions: {
      scalingModes: [...DISPLAY_SCALING_MODE_OPTIONS],
      scalingMethods: [...DISPLAY_RETRO_SCALING_METHOD_OPTIONS],
      globalVrrModes: [...DISPLAY_GLOBAL_VRR_MODE_OPTIONS],
      vrrModes: [...DISPLAY_ARC_SYNC_PROFILE_OPTIONS],
      wireFormats: [...DISPLAY_WIRE_FORMAT_OPTIONS],
      bpcDepths: [...DISPLAY_BPC_OPTIONS].filter((depth) => depth === 8 || depth === 10),
      quantizationRanges: [...DISPLAY_QUANTIZATION_OPTIONS],
      colorRanges: {
        hue: { min: -180, max: 180, step: 1, default: 0 },
        saturation: { min: 0, max: 2, step: 0.01, default: 1 },
        brightness: { min: -100, max: 100, step: 1, default: 0 },
        contrast: { min: 0, max: 2, step: 0.01, default: 1 },
      },
    },
    flags: { active: true, attached: true, dongleConnected: false, ditheringEnabled: false },
    arcSync: { supported: true, minRefreshHz: 48, maxRefreshHz: 180, profile: 'recommended' },
  }],
});

function displayFixtureFor(deviceKey, adapterName, options = {}) {
  const displays = JSON.parse(JSON.stringify(DISPLAY_FIXTURE.displays));
  displays[0].displayKey = typeof deviceKey === 'string' ? `${deviceKey}|display|mock-encoder-0` : null;
  displays[0].adapterName = adapterName ?? null;
  if (options.displayDuplicateIdentity === true) {
    displays.push({ ...JSON.parse(JSON.stringify(displays[0])), id: 1, name: `${displays[0].name} (duplicate identity)` });
  }
  if (options.displayRetroSymbolsMissing === true) {
    displays.forEach((display) => {
      display.scalingMethod = displayCapability(null, false, false, 'The retro-scaling API is missing in the IGCL runtime.', 'mock-missing-symbol');
      display.supportedOptions.scalingMethods = [];
    });
  }
  if (options.displayArcSyncSymbolsMissing === true) {
    displays.forEach((display) => {
      display.vrrMode = displayCapability(null, false, false, 'The Arc Sync profile API is missing in the IGCL runtime.', 'mock-missing-symbol');
      display.variableRefreshRate = displayCapability(null, false, false, 'The Intel Arc Sync profile API is missing in the IGCL runtime.', 'mock-missing-symbol');
      display.supportedOptions.vrrModes = [];
    });
  }
  if (options.displayArcSyncUnsupported === true || options.displayArcSyncUnrecognizedProfile === true) {
    displays.forEach((display) => {
      const monitorSupported = options.displayArcSyncUnsupported !== true;
      display.arcSync = {
        supported: monitorSupported,
        minRefreshHz: monitorSupported ? display.arcSync.minRefreshHz : null,
        maxRefreshHz: monitorSupported ? display.arcSync.maxRefreshHz : null,
        profile: options.displayArcSyncUnrecognizedProfile === true ? null : (monitorSupported ? display.arcSync.profile : null),
      };
      display.vrrMode = displayCapability(null, false, false, 'The display does not report a recognized Arc Sync profile.', 'mock-unsupported');
      display.variableRefreshRate = displayCapability(null, false, false, 'The display does not report supported Arc Sync monitor/profile state.', 'mock-unsupported');
      display.supportedOptions.vrrModes = [];
    });
  }
  return displays;
}

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
   *                                      // unless the opt-in integrated graphics
   *                                      // verifier path is enabled
   *   displayUnsupported?: boolean,     // honest empty Display surface
   *   displayWireReadonly?: boolean,    // simulate the real driver's
   *                                      // silent/no-readback wire-format surface
   *   displayRetroSymbolsMissing?: boolean, // retro-scaling API unavailable
   *   displayArcSyncSymbolsMissing?: boolean, // Arc Sync API unavailable
   *   displayArcSyncUnsupported?: boolean, // monitor does not support Arc Sync
   *   displayArcSyncUnrecognizedProfile?: boolean, // profile read is unknown
   *   displayDuplicateIdentity?: boolean, // duplicate stable display key
   *   displayRetroSilentNoop?: boolean, // setter succeeds, read-back unchanged
   *   displayArcSyncSilentNoop?: boolean, // setter succeeds, read-back unchanged
   *   displayRetroReadbackFailure?: boolean, // setter succeeds, read-back fails
   *   displayArcSyncReadbackFailure?: boolean, // setter succeeds, read-back fails
   *   enduranceGamingSupported?: boolean, // expose Endurance on the mock iGPU
   *   laptopInfoOf?: () => object|null,  // M17c: the laptop sysinfo provider
   *                                      // (the real backend's vramBytesOf-style
   *                                      // injection - the caps AIB decode's
   *                                      // laptop branch mirrors it)
   * }} opts
   */
  constructor(opts = {}) {
    this.kind = 'mock';
    this._failOnce = {};
    this._hasSysmanCapabilitySeam = Object.prototype.hasOwnProperty.call(opts, 'sysmanPowerCapable');
    this._sysmanPowerCapable = this._hasSysmanCapabilitySeam ? opts.sysmanPowerCapable === true : null;
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
    // M53's duplicate-PNP overlay is self-contained and expands this to the
    // three rows required by its identity fixture.
    this._duplicatePnpOverlay = process.env.RID_MOCK_DUPLICATE_PNP_OVERLAY === '1';
    this._multiDevice = opts.multiDevice === true
      || process.env.RID_MOCK_MULTI_DEVICE === '1'
      || this._duplicatePnpOverlay;
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
    this._displayUnsupported = opts.displayUnsupported === true || process.env.RID_MOCK_DISPLAY_UNSUPPORTED === '1';
    this._displayWireReadonly = opts.displayWireReadonly === true || process.env.RID_MOCK_DISPLAY_WIRE_READONLY === '1';
    this._displayRetroSymbolsMissing = opts.displayRetroSymbolsMissing === true;
    this._displayArcSyncSymbolsMissing = opts.displayArcSyncSymbolsMissing === true;
    this._displayArcSyncUnsupported = opts.displayArcSyncUnsupported === true;
    this._displayArcSyncUnrecognizedProfile = opts.displayArcSyncUnrecognizedProfile === true;
    this._displayDuplicateIdentity = opts.displayDuplicateIdentity === true;
    this._displayRetroSilentNoop = opts.displayRetroSilentNoop === true;
    this._displayArcSyncSilentNoop = opts.displayArcSyncSilentNoop === true;
    this._displayRetroReadbackFailure = opts.displayRetroReadbackFailure === true;
    this._displayArcSyncReadbackFailure = opts.displayArcSyncReadbackFailure === true;
    this._enduranceGamingSupported = opts.enduranceGamingSupported === true || process.env.RID_MOCK_ENDURANCE === '1';
    this._gameGraphics = new Map();
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
    this._displayApplies = [];
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
        displays: this._displays,
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
        graphics: {
          ...JSON.parse(JSON.stringify(GRAPHICS_FIXTURE.values)),
          ...(device.integrated && this._enduranceGamingSupported ? {
            enduranceGaming: 'auto',
            enduranceGamingMode: 'balanced',
            sharedMemoryOverride: { enabled: false, percentage: 57 },
          } : {}),
        },
        displays: displayFixtureFor(device.deviceKey, device.name, {
          displayDuplicateIdentity: this._displayDuplicateIdentity,
          displayRetroSymbolsMissing: this._displayRetroSymbolsMissing,
          displayArcSyncSymbolsMissing: this._displayArcSyncSymbolsMissing,
          displayArcSyncUnsupported: this._displayArcSyncUnsupported,
          displayArcSyncUnrecognizedProfile: this._displayArcSyncUnrecognizedProfile,
        }),
      };
    };

    const entries = [makeEntry(fs, 0)];
    if (this._duplicatePnpOverlay) {
      entries.push(makeEntry(fs, 1));
      entries.push(makeEntry(fs, 2));
    } else if (this._multiDevice) {
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
    this._displays = first.displays;
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
      // Mirror the real backend's stable identity so the old-runtime mock
      // and the real apply route exercise the same target contract.
      deviceKey,
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
    const powerCapable = this._hasSysmanCapabilitySeam ? this._sysmanPowerCapable : extended;
    caps.extendedControls = {
      powerLimitW: Boolean(powerCapable && ranges.powerLimitW?.units === 'W'),
      tempLimitC: Boolean(extended && ranges.tempLimitC?.units === 'C'),
    };
    // M2C-C: the bundled-2023-runtime flag - the UI exposes the extended
    // maxes only when it is set AND the OC mode is advanced (M3-C-E).
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
    const duplicatePnp = this._duplicatePnpOverlay;
    const bdf = duplicatePnp
      ? id === 0 ? { bus: 3, device: 0, function: 0 }
        : id === 1 ? { bus: 0, device: 2, function: 0 }
          : null
      : id === 0 ? { bus: 3, device: 0, function: 0 } : { bus: 0, device: 2, function: 0 };
    const duplicatePnpId = 'PCI\\VEN_8086&DEV_56A0&SUBSYS_DUPLICATE';
    const plainName = duplicatePnp && id === 2
      ? 'Mock Ambiguous Arc Graphics'
      : fs.deviceName;
    const integrated = fs.integrated === true || isIntegratedStyleDevice({ name: plainName });
    const mobile = fs.mobile === true || /\b(?:A|B)\d{3,4}M\b|\bMobile\b/i.test(plainName);
    return {
      id,
      // M4-B: the VRAM suffix is formatted ONCE here (listDevices time) -
      // the header, device card and dialogs all read device.name, so the
      // suffix reaches every consumer by construction, never per-render.
      // M4-I (S1): the memType rides the DEVICE payload (the renderer's
      // VRAM row type source - the fixture supplies it; the mock name
      // token would derive it anyway).
      name: duplicatePnp && id === 2
        ? 'Mock Ambiguous Arc Graphics'
        : formatDeviceName(fs.deviceName, fs.vramBytes ?? null, fs.memType ?? undefined),
      type: 'GRAPHICS',
      pciVendorId: '0x00008086',
      pciDeviceId: fs.pciDeviceId ?? '0x000056a0',
      revId: 8,
      // M4-F: the second device sits at its own bus/device slot (an iGPU
      // fixture - distinct from the primary card's bdf).
      bdf,
      driverVersion: fs.driverVersion,
      graphicsClockMHz: fs.graphicsClockMHz,
      numXeCores: fs.numXeCores,
      integrated,
      mobile,
      vramBytes: fs.vramBytes ?? null,
      sharedMemoryBytes: fs.sharedMemoryBytes ?? null,
      sharedMemorySource: fs.sharedMemorySource ?? null,
      memType: fs.memType ?? null,
      ...(duplicatePnp ? { pnpDeviceId: duplicatePnpId } : {}),
      deviceKey: deviceHardwareKey({
        pciVendorId: '0x00008086',
        pciDeviceId: fs.pciDeviceId ?? '0x000056a0',
        bdf,
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
    // M46: displayed Advanced W/C ceilings are mode-selected, independent
    // from the bundled-runtime capability flag. The real backend exposes the
    // documented 375 W / 115 C shape in Advanced even when the runtime probe
    // is unavailable; the apply gate still owns the honest runtime refusal.
    const advanced = this._ocMode === 'advanced';
    caps.ocMode = this._ocMode;
    const limits = deviceLimitsOf(identity, { advanced });
    if (limits) {
      const row = limits.listed ? limits : defaultLimitsOf(advanced);
      for (const [canonical, override] of Object.entries(row)) {
        if (canonical === 'listed') continue;
        const range = caps.ranges[canonical];
        if (!range) continue;
        // The M4-E units rule: the table speaks W/V/C - percent-unit
        // ranges (Battlemage: volt/PL/TL as %) are never touched.
        if (canonical === 'powerLimitW' && range.units !== 'W') continue;
        if (canonical === 'tempLimitC' && range.units !== 'C') continue;
        if (canonical === 'gpuVoltOffsetV' && range.units !== 'V') continue;
        let next = range;
        if (typeof override.max === 'number') {
          if (canonical === 'gpuVoltOffsetV') {
            next = { ...next, max: override.max };
          } else if (advanced) {
            next = { ...next, max: override.max };
          } else {
            next = { ...next, max: Math.min(range.max, override.max) };
          }
          if (typeof range.default === 'number' && Number.isFinite(range.default)) {
            next = { ...next, default: Math.min(range.default, next.max) };
          }
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
    const learnedCeilings = recordedCeilingsFor(this._refusedCeilings, deviceId);
    if (Object.keys(learnedCeilings).length > 0) caps.learnedCeilings = learnedCeilings;
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
   * (the mock round trip). Device 1 (the multi-device iGPU) keeps the
   * historical degraded surface by default; RID_MOCK_ENDURANCE=1 opts into
   * the integrated-only graphics cards for end-to-end UI verification.
   * @param {number} [deviceId]
   * @returns {Promise<object>} the GraphicsState shape
   */
  async getGraphicsSettings(deviceId = 0) {
    const id = deviceId === undefined || deviceId === null ? 0 : deviceId;
    const e = this._entry(id);
    const integratedControls = e.device?.integrated === true && this._enduranceGamingSupported;
    const degraded = (id !== 0 && !integratedControls) || this._graphicsUnsupported || this._noIntel;
    if (degraded) {
      return JSON.parse(JSON.stringify(GRAPHICS_DEGRADED));
    }
    const optional = e.device?.integrated === true && this._enduranceGamingSupported;
    const supported = { ...GRAPHICS_FIXTURE.supported };
    const supportedOptions = JSON.parse(JSON.stringify(GRAPHICS_FIXTURE.supportedOptions));
    if (optional) {
      supported.enduranceGaming = true;
      supported.enduranceGamingMode = true;
      supported.sharedMemoryOverride = true;
      supportedOptions.enduranceGaming = ['off', 'on', 'auto'];
      supportedOptions.enduranceGamingModes = ['performance', 'balanced', 'battery'];
    }
    return {
      supported,
      supportedOptions,
      frameLimitRange: { ...GRAPHICS_FIXTURE.frameLimitRange },
      ...(optional ? { sharedMemoryRange: { min: 13, max: 87, step: 1, default: 57 } } : {}),
      values: JSON.parse(JSON.stringify(e.graphics)),
    };
  }

  async getGameProfileCapabilities(deviceId = 0, exePath) {
    const id = deviceId === undefined || deviceId === null ? 0 : deviceId;
    const entry = this._entry(id);
    // Match the real backend's hard gate: only the adapter-properties
    // integrated bit qualifies. A name such as A370M or "Mobile" is not
    // enough because those are discrete mobile GPUs too.
    const integrated = entry.device?.integrated === true;
    const supported = integrated && this._enduranceGamingSupported;
    const executable = classifyXeFgExecutable(exePath);
    const xeFg = id === 0
      && !this._graphicsUnsupported
      && !this._noIntel
      && GRAPHICS_FIXTURE.supported.frameGen === true
      && executable.supported;
    return {
      enduranceGaming: supported,
      xeFg,
      xeFgOptions: xeFg ? [...GRAPHICS_FIXTURE.supportedOptions.frameGen] : [],
      reason: supported ? null : (integrated
        ? 'The mock driver does not expose Endurance Gaming for this fixture.'
        : 'Endurance Gaming is available only on integrated Intel graphics.'),
      xeFgReason: xeFg ? null : (!executable.supported
        ? executable.reason
        : 'XeFG is unavailable for this graphics adapter.'),
    };
  }

  async setGameProfileSettings(deviceId = 0, exePath, settings = {}, enabled = true) {
    const id = deviceId === undefined || deviceId === null ? 0 : deviceId;
    const result = { ok: true, perControl: {} };
    if (typeof exePath !== 'string' || exePath.length === 0) {
      return { ok: false, perControl: { profileScope: { ok: false, errorCode: 'invalid-argument', message: 'an executable path is required' } } };
    }
    const mapKey = `${id}:${exePath.toLowerCase()}`;
    if (enabled !== true) {
      this._gameGraphics.delete(mapKey);
      return { ok: true, perControl: { profileScope: { ok: true, readBackEqual: true, message: 'global settings restored' } } };
    }
    const controls = ['enduranceGaming', 'frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency']
      .filter((key) => settings[key] !== null && settings[key] !== undefined);
    const profileCaps = await this.getGameProfileCapabilities(id, exePath);
    if (settings.enduranceGaming !== undefined && settings.enduranceGaming !== null && !profileCaps.enduranceGaming) {
      result.ok = false;
      result.perControl.enduranceGaming = { ok: false, errorCode: 'unsupported', message: profileCaps.reason };
    }
    if (settings.frameGenOverride !== undefined && settings.frameGenOverride !== null && !profileCaps.xeFg) {
      result.ok = false;
      result.perControl.frameGenOverride = { ok: false, errorCode: 'unsupported', message: profileCaps.xeFgReason };
    }
    const previous = this._gameGraphics.get(mapKey) ?? {};
    const next = { ...previous };
    result.perControl.profileScope = { ok: true, readBackEqual: true, message: 'per-game settings active' };
    for (const key of ['frameGenOverride', 'flipMode', 'lowLatency']) {
      if (settings[key] === undefined || settings[key] === null || result.perControl[key]) continue;
      next[key] = settings[key];
      result.perControl[key] = { ok: next[key] === settings[key], readBackEqual: next[key] === settings[key] };
    }
    if (settings.frameLimit !== undefined && settings.frameLimit !== null && !result.perControl.frameLimit) {
      const clamped = clampAndSnap(settings.frameLimit.value, GRAPHICS_FIXTURE.frameLimitRange);
      next.frameLimit = { enabled: settings.frameLimit.enabled === true, value: clamped };
      result.perControl.frameLimit = { ok: true, readBackEqual: true };
    }
    if (settings.enduranceGaming !== undefined && settings.enduranceGaming !== null && !result.perControl.enduranceGaming) {
      next.enduranceGaming = settings.enduranceGaming;
      result.perControl.enduranceGaming = { ok: true, readBackEqual: true };
    }
    if (Object.keys(next).length > 0) this._gameGraphics.set(mapKey, next);
    if (controls.length === 0) result.ok = true;
    return result;
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
    const controls = ['enduranceGaming', 'enduranceGamingMode', 'sharedMemoryOverride', 'frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency']
      .filter((c) => settings[c] !== null && settings[c] !== undefined);
    const e = this._entry(id);
    const integratedControls = e.device?.integrated === true && this._enduranceGamingSupported;
    const degraded = (id !== 0 && !integratedControls) || this._graphicsUnsupported || this._noIntel;
    if (degraded) {
      for (const c of controls) {
        result.perControl[c] = { ok: false, errorCode: 'unsupported', message: 'graphics features are not supported on this device' };
      }
      result.ok = controls.length === 0;
      return result;
    }
    if (!integratedControls) {
      for (const c of ['enduranceGaming', 'enduranceGamingMode', 'sharedMemoryOverride']) {
        if (settings[c] !== null && settings[c] !== undefined) {
          result.perControl[c] = { ok: false, errorCode: 'unsupported', message: 'integrated-only graphics features are not supported on this device' };
          result.ok = false;
        }
      }
    }
    if (integratedControls && settings.enduranceGaming !== undefined && settings.enduranceGaming !== null) {
      if (!['off', 'on', 'auto'].includes(settings.enduranceGaming)) {
        result.perControl.enduranceGaming = { ok: false, errorCode: 'out-of-range', message: 'unknown Endurance Gaming control' };
        result.ok = false;
      } else {
        e.graphics.enduranceGaming = settings.enduranceGaming;
        result.perControl.enduranceGaming = { ok: true, readBackEqual: true };
      }
    }
    if (integratedControls && settings.enduranceGamingMode !== undefined && settings.enduranceGamingMode !== null) {
      if (!['performance', 'balanced', 'battery'].includes(settings.enduranceGamingMode)) {
        result.perControl.enduranceGamingMode = { ok: false, errorCode: 'out-of-range', message: 'unknown Endurance Gaming preset' };
        result.ok = false;
      } else {
        e.graphics.enduranceGamingMode = settings.enduranceGamingMode;
        result.perControl.enduranceGamingMode = { ok: true, readBackEqual: true };
      }
    }
    if (integratedControls && settings.sharedMemoryOverride !== undefined && settings.sharedMemoryOverride !== null) {
      const memory = settings.sharedMemoryOverride;
      const percentage = Number(memory?.percentage);
      if (typeof memory !== 'object' || memory === null || !Number.isInteger(percentage) || percentage < 13 || percentage > 87) {
        result.perControl.sharedMemoryOverride = { ok: false, errorCode: 'out-of-range', message: 'Memory limit must be between 13% and 87%.' };
        result.ok = false;
      } else {
        e.graphics.sharedMemoryOverride = { enabled: memory.enabled === true, percentage };
        result.perControl.sharedMemoryOverride = { ok: true, readBackEqual: true, warning: 'Restart Windows for the new shared-memory limit to take effect.' };
      }
    }
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

  /** Display fixture read-back. Every call returns a clone so tests exercise
   * the same fresh-state contract as the native backend. */
  async getDisplaySettings(deviceId = 0) {
    const id = deviceId === undefined || deviceId === null ? 0 : deviceId;
    const e = this._entry(id);
    if (id !== 0 || this._displayUnsupported || this._noIntel) {
      return { deviceKey: e.device.deviceKey ?? null, adapterName: e.device.name ?? null, displays: [] };
    }
    const displays = JSON.parse(JSON.stringify(e.displays ?? []));
    if (this._displayWireReadonly) {
      for (const display of displays) {
        display.supportedOptions.wireFormats = [];
        display.supportedOptions.bpcDepths = [];
        display.colorDepth = null;
      }
    }
    return { deviceKey: e.device.deviceKey ?? null, adapterName: e.device.name ?? null, displays };
  }

  /** Display fixture write/readback path. The request must use the durable
   * adapter key and the display key; ordinal ids are intentionally rejected. */
  async setDisplaySettings(deviceId = 0, request = {}) {
    const id = deviceId === undefined || deviceId === null ? 0 : deviceId;
    const e = this._entry(id);
    const patch = request?.patch && typeof request.patch === 'object' ? request.patch : {};
    const result = { ok: true, perControl: {} };
    const controls = ['quantizationRange', 'wireFormat', 'scalingMode', 'displayScalingMethod', 'scalingMethod', 'globalVrrMode', 'variableRefreshRate', 'vrrMode', 'hue', 'saturation', 'brightness', 'contrast']
      .filter((key) => patch[key] !== null && patch[key] !== undefined);
    const fail = (key, errorCode, message) => {
      result.perControl[key] = { ok: false, errorCode, message };
      result.ok = false;
    };
    if (id !== 0 || this._displayUnsupported || this._noIntel) {
      for (const key of controls) fail(key, 'unsupported', 'display settings are not supported on this device');
      return result;
    }
    if (request.deviceKey !== e.device.deviceKey) {
      for (const key of controls) fail(key, 'stale-target', 'the selected graphics adapter identity is stale');
      return result;
    }
    const matches = (e.displays ?? []).filter((candidate) => candidate.displayKey === request.displayKey && candidate.identityVerified === true);
    if (matches.length !== 1) {
      const errorCode = matches.length > 1 ? 'ambiguous-target' : 'stale-target';
      const message = matches.length > 1 ? 'the selected display identity is ambiguous' : 'the selected display is no longer connected';
      for (const key of controls) fail(key, errorCode, message);
      return result;
    }
    const display = matches[0];
    const scalingAlias = patch.displayScalingMethod;
    const gpuScalingAlias = ['centered', 'stretched', 'aspect-ratio-centered-max'].includes(scalingAlias);
    const retroScalingAlias = ['integer', 'nearest-neighbour'].includes(scalingAlias);
    const scalingAliasError = gpuScalingAlias
      ? (patch.scalingMode !== scalingAlias
        ? 'a GPU Scaling Method must match the coupled raw scalingMode'
        : patch.scalingMethod?.enabled === true
          ? 'a GPU Scaling Method cannot enable Retro Scaling in the same request'
          : null)
      : retroScalingAlias
        ? (patch.scalingMode !== 'identity'
          || !patch.scalingMethod
          || patch.scalingMethod.method !== scalingAlias
          || typeof patch.scalingMethod.enabled !== 'boolean'
          ? 'a Retro Scaling Method must match the coupled raw scalingMode and scalingMethod'
          : null)
        : scalingAlias === 'maintain-display-scaling' && patch.scalingMode !== undefined && patch.scalingMode !== 'identity'
          ? 'Maintain Display Scaling must match raw scalingMode identity'
          : (scalingAlias === 'maintain-display-scaling' || scalingAlias === 'custom') && patch.scalingMethod?.enabled === true
            ? 'Display Scaling cannot enable Retro Scaling in the same request'
            : scalingAlias === 'custom' && patch.scalingMode !== undefined && patch.scalingMode !== 'custom'
              ? 'Custom Display Scaling must match raw scalingMode custom'
              : scalingAlias === 'custom'
                && (!patch.scalingCustom || typeof patch.scalingCustom !== 'object'
                  || !Number.isFinite(patch.scalingCustom.x) || patch.scalingCustom.x < 0 || patch.scalingCustom.x > 100
                  || !Number.isFinite(patch.scalingCustom.y) || patch.scalingCustom.y < 0 || patch.scalingCustom.y > 100)
                ? 'Custom Display Scaling requires valid horizontal and vertical percentages'
            : null;
    if (scalingAliasError) {
      fail('displayScalingMethod', 'out-of-range', scalingAliasError);
      if (patch.scalingMode !== undefined && patch.scalingMode !== null) {
        fail('scalingMode', 'out-of-range', 'the coupled scaling payload was rejected before any write');
      }
      return result;
    }
    if (patch.quantizationRange !== undefined && patch.quantizationRange !== null) {
      if (!DISPLAY_QUANTIZATION_OPTIONS.includes(patch.quantizationRange)) fail('quantizationRange', 'out-of-range', `unknown quantization range '${patch.quantizationRange}'`);
      else if (!display.supportedOptions.quantizationRanges.includes(patch.quantizationRange)) fail('quantizationRange', 'unsupported', 'quantization range is not supported by this display');
      else {
        display.quantizationRange = patch.quantizationRange;
        result.perControl.quantizationRange = { ok: display.quantizationRange === patch.quantizationRange, readBackEqual: display.quantizationRange === patch.quantizationRange };
      }
    }
    if (patch.wireFormat !== undefined && patch.wireFormat !== null) {
      const { model, depth } = patch.wireFormat;
      if (!DISPLAY_WIRE_FORMAT_OPTIONS.includes(model) || !DISPLAY_BPC_OPTIONS.includes(depth)) fail('wireFormat', 'out-of-range', 'unknown wire format');
      else if (this._displayWireReadonly || !display.supportedOptions.wireFormats.includes(model) || !display.supportedOptions.bpcDepths.includes(depth)) fail('wireFormat', 'unsupported', 'wire format is read-only on this driver surface');
      else {
        display.colorFormat = model;
        display.colorDepth = depth;
        result.perControl.wireFormat = { ok: true, readBackEqual: true };
      }
    }
    if (patch.scalingMode !== undefined && patch.scalingMode !== null) {
      if (!DISPLAY_SCALING_MODE_OPTIONS.includes(patch.scalingMode)) fail('scalingMode', 'out-of-range', `unknown scaling mode '${patch.scalingMode}'`);
      else if (!display.supportedOptions.scalingModes.includes(patch.scalingMode)) fail('scalingMode', 'unsupported', 'scaling mode is not supported by this display');
      else {
        display.scalingMode = patch.scalingMode;
        if (patch.scalingMode === 'custom' && patch.scalingCustom && typeof patch.scalingCustom === 'object') {
          display.scalingDetails = {
            customX: Math.max(0, Math.min(100, Number(patch.scalingCustom.x))),
            customY: Math.max(0, Math.min(100, Number(patch.scalingCustom.y))),
            hardwareModeSet: patch.scalingCustom.hardwareModeSet === true,
            preferredScalingType: display.scalingDetails?.preferredScalingType ?? 'identity',
          };
        }
        result.perControl.scalingMode = { ok: true, readBackEqual: true, warning: DISPLAY_SCALING_FLASH_WARNING };
      }
    }
    let retroMethodAlias = false;
    if (patch.displayScalingMethod !== undefined && patch.displayScalingMethod !== null) {
      const gpuMethodAlias = ['centered', 'stretched', 'aspect-ratio-centered-max'].includes(patch.displayScalingMethod);
      retroMethodAlias = ['integer', 'nearest-neighbour'].includes(patch.displayScalingMethod);
      if (gpuMethodAlias || retroMethodAlias) {
        const coupled = gpuMethodAlias
          ? patch.scalingMode === patch.displayScalingMethod
          : patch.scalingMethod && patch.scalingMode !== undefined && patch.scalingMode !== null;
        if (!coupled) fail('displayScalingMethod', 'out-of-range', 'a raw GPU or Retro Scaling Method must include its matching coupled payload');
        else if (gpuMethodAlias && result.perControl.scalingMode) result.perControl.displayScalingMethod = { ...result.perControl.scalingMode };
        // Retro is processed below; its result is mirrored after the native
        // compatibility path so the mock matches the IGCL backend ordering.
      } else if (!['maintain-display-scaling', 'custom'].includes(patch.displayScalingMethod)) fail('displayScalingMethod', 'out-of-range', 'unknown Display Scaling method');
      else {
        const next = patch.displayScalingMethod === 'custom' ? 'custom' : 'identity';
        if (!display.supportedOptions.scalingModes.includes(next)) fail('displayScalingMethod', 'unsupported', 'Display Scaling method is not supported by this display');
        else {
          display.scalingMode = next;
          if (patch.displayScalingMethod === 'custom' && patch.scalingCustom && typeof patch.scalingCustom === 'object') {
            display.scalingDetails = {
              customX: Math.max(0, Math.min(100, Number(patch.scalingCustom.x))),
              customY: Math.max(0, Math.min(100, Number(patch.scalingCustom.y))),
              hardwareModeSet: patch.scalingCustom.hardwareModeSet === true,
              preferredScalingType: display.scalingDetails?.preferredScalingType ?? 'identity',
            };
          }
          result.perControl.displayScalingMethod = { ok: true, readBackEqual: true, warning: DISPLAY_SCALING_FLASH_WARNING };
        }
      }
    }
    if (patch.scalingMethod !== undefined && patch.scalingMethod !== null) {
      const value = patch.scalingMethod;
      if (typeof value !== 'object' || typeof value.enabled !== 'boolean' || !DISPLAY_RETRO_SCALING_METHOD_OPTIONS.includes(value.method)) fail('scalingMethod', 'out-of-range', 'unknown retro-scaling method');
      else if (this._displayRetroSymbolsMissing) fail('scalingMethod', 'unavailable-symbol', 'the retro-scaling API is missing in the IGCL runtime');
      else if (!display.supportedOptions.scalingMethods.includes(value.method) || display.scalingMethod?.controllable !== true) fail('scalingMethod', 'unsupported', 'retro scaling is not supported by this display');
      else if (this._displayRetroSilentNoop || this._displayRetroReadbackFailure) {
        result.perControl.scalingMethod = {
          ok: false,
          errorCode: 'io-failed',
          message: this._displayRetroReadbackFailure ? 'set succeeded but retro-scaling read-back failed' : 'retro-scaling set succeeded but read-back was unchanged',
          readBackEqual: false,
          silentNoop: true,
          warning: DISPLAY_SCALING_FLASH_WARNING,
        };
        result.ok = false;
      }
      else {
        display.scalingMethod.value = { enabled: value.enabled, method: value.method };
        result.perControl.scalingMethod = { ok: true, readBackEqual: display.scalingMethod.value.enabled === value.enabled && display.scalingMethod.value.method === value.method, warning: DISPLAY_SCALING_FLASH_WARNING };
      }
    }
    if (retroMethodAlias && result.perControl.scalingMethod) {
      result.perControl.displayScalingMethod = { ...result.perControl.scalingMethod };
    }
    if (patch.variableRefreshRate !== undefined && patch.variableRefreshRate !== null) {
      if (typeof patch.variableRefreshRate !== 'boolean') fail('variableRefreshRate', 'out-of-range', 'Variable Refresh Rate must be enabled or disabled');
      else if (display.variableRefreshRate?.controllable !== true) fail('variableRefreshRate', 'unsupported', 'Variable Refresh Rate is not supported by this display');
      else {
        display.variableRefreshRate.value = patch.variableRefreshRate;
        // Intel Graphics Software implements this separate switch by moving
        // the Arc Sync profile to RECOMMENDED when enabled and OFF when
        // disabled. Keep the mock coupled to that same contract so renderer
        // tests cannot accidentally validate an impossible independent state.
        display.vrrMode.value = patch.variableRefreshRate ? 'recommended' : 'off';
        display.arcSync.profile = display.vrrMode.value;
        result.perControl.variableRefreshRate = { ok: display.variableRefreshRate.value === patch.variableRefreshRate, readBackEqual: display.variableRefreshRate.value === patch.variableRefreshRate };
      }
    }
    if (patch.globalVrrMode !== undefined && patch.globalVrrMode !== null) {
      if (!DISPLAY_GLOBAL_VRR_MODE_OPTIONS.includes(patch.globalVrrMode)) fail('globalVrrMode', 'out-of-range', `unknown global Variable Refresh Rate Mode '${patch.globalVrrMode}'`);
      else if (!display.supportedOptions.globalVrrModes.includes(patch.globalVrrMode) || display.globalVrrMode?.controllable !== true) fail('globalVrrMode', 'unsupported', 'global Variable Refresh Rate Mode is not supported by this display');
      else {
        display.globalVrrMode.value = patch.globalVrrMode;
        result.perControl.globalVrrMode = { ok: display.globalVrrMode.value === patch.globalVrrMode, readBackEqual: display.globalVrrMode.value === patch.globalVrrMode };
      }
    }
    if (patch.vrrMode !== undefined && patch.vrrMode !== null) {
      if (!DISPLAY_ARC_SYNC_PROFILE_OPTIONS.includes(patch.vrrMode)) fail('vrrMode', 'out-of-range', `unknown Arc Sync profile '${patch.vrrMode}'`);
      else if (this._displayArcSyncSymbolsMissing) fail('vrrMode', 'unavailable-symbol', 'the Arc Sync profile API is missing in the IGCL runtime');
      else if (!display.supportedOptions.vrrModes.includes(patch.vrrMode) || display.vrrMode?.controllable !== true) fail('vrrMode', 'unsupported', 'Arc Sync profile control is not supported by this display');
      else if (this._displayArcSyncSilentNoop || this._displayArcSyncReadbackFailure) {
        result.perControl.vrrMode = {
          ok: false,
          errorCode: 'io-failed',
          message: this._displayArcSyncReadbackFailure ? 'set succeeded but Arc Sync read-back failed' : 'Arc Sync set succeeded but read-back was unchanged',
          readBackEqual: false,
          silentNoop: true,
        };
        result.ok = false;
      }
      else {
        display.vrrMode.value = patch.vrrMode;
        display.arcSync.profile = patch.vrrMode;
        display.variableRefreshRate.value = patch.vrrMode !== 'off';
        result.perControl.vrrMode = { ok: display.vrrMode.value === patch.vrrMode, readBackEqual: display.vrrMode.value === patch.vrrMode };
      }
    }
    for (const key of ['hue', 'saturation', 'brightness', 'contrast']) {
      if (patch[key] === undefined || patch[key] === null) continue;
      const range = display.supportedOptions.colorRanges?.[key];
      const capability = display[key];
      if (!range || capability?.controllable !== true) {
        fail(key, 'unsupported', 'color correction is not supported by this display');
        continue;
      }
      const value = Math.min(range.max, Math.max(range.min, Number(patch[key])));
      capability.value = value;
      result.perControl[key] = { ok: capability.value === value, readBackEqual: capability.value === value };
    }
    if (controls.length > 0) {
      this._displayApplies.push({ deviceId: id, displayKey: request.displayKey ?? null, patch: JSON.parse(JSON.stringify(patch)) });
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
    isTempCapable: async (deviceId) => {
      if (typeof backend.getCapabilities === 'function') {
        return (await backend.getCapabilities(deviceId ?? 0)).extendedControls?.tempLimitC === true;
      }
      return backend.extendedCapable;
    },
    setPowerLimitW: async (w, deviceId) => backend.extendedApply('powerLimitW', w, deviceId),
    setTempLimitC: async (c, deviceId) => backend.extendedApply('tempLimitC', c, deviceId),
    close: async () => {},
  };
}
