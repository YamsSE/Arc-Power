// Arc Power - M1 IgclBackend: the primary IOCBackend implementation,
// driving the native IGCL runtime (IntelControlLib.dll) through koffi.
//
// Loading/init policy (docs/igcl-integration.md §1–§2):
//   - the runtime DLL is re-discovered every launch via the DriverStore scan
//     (findIgclDll: active-driver-version matching, never "newest folder");
//   - ctlInit uses the all-zeros application UID + Level Zero + IGSC full
//     functionality flags (invented UIDs are rejected on the current driver);
//   - V2 OC APIs + capability-unit conversion (canonical Settings fields in
//     W/V/MHz/C/GTS; never assume mV/mW) - pinned per-API unit contract
//     (docs/igcl-integration.md §4).
//
// Safety contract:
//   - every apply clamps to the capability range and verifies by read-back;
//   - fan setters are invoked ONLY when the EFFECTIVE fan canControl === true
//     (properties.canControl || the live reversible probe result - M3-D: the
//     A770's canControl=false property is a lie, the driver honors table
//     writes with the FAN enum's PERCENT encoding);
//   - ctlOverclockWaiverSet is called only when constructed with
//     allowAutoWaiver: true (smoke/tests) or via setWaiverAccepted()
//     (explicit user acceptance - M2a product path).

import koffi from 'koffi';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CTL_INIT_FLAG_USE_LEVEL_ZERO, CTL_INIT_FLAG_IGSC_FUL, CTL_RESULT, CTL_FAN_SPEED_MODE, CTL_FAN_SPEED_UNITS,
  CTL_ADAPTER_PROPERTIES_FLAG,
  describeResult, makeVersion, loadIgcl, findIgclDll, decodeItem, decodePciProperties,
  CTL_3D_FEATURE, CTL_PROPERTY_VALUE_TYPE, CTL_GAMING_FLIP_MODE_FLAG,
  CTL_3D_LOW_LATENCY, CTL_3D_FRAME_GENERATION_OVERRIDE,
  encode3dFeatureGetset, decode3dFeatureGetsetValue, decode3dFeatureDetails,
  // M10b (the Graphics "Display" view): the display-module surface.
  CTL_SCALING_TYPE, CTL_RETRO_SCALING_TYPE, CTL_WIRE_COLOR_MODEL,
  displayFlagNames, encodeDisplayProperties, decodeDisplayProperties,
  encodeWireFormatConfig, decodeWireFormatConfig, encodeDisplaySettings,
  decodeDisplaySettings, encodeScalingSettings, decodeScalingSettings,
  encodeRetroScalingCaps, decodeRetroScalingCaps, encodeRetroScalingSettings,
  decodeRetroScalingSettings, decodeArcSyncMonitor, decodeArcSyncProfile,
  encodeArcSyncProfile, encodeEdidManagementArgs,
  encodePanelDescriptorArgs, edidMonitorName,
} from './igcl-bindings.js';
import {
  igclErrorCode, GRAPHICS_FRAME_GEN_OPTIONS, GRAPHICS_FLIP_MODE_OPTIONS,
  GRAPHICS_LOW_LATENCY_OPTIONS, DISPLAY_QUANTIZATION_OPTIONS,
  DISPLAY_WIRE_FORMAT_OPTIONS, DISPLAY_BPC_OPTIONS, DISPLAY_SCALING_MODE_OPTIONS,
  DISPLAY_RETRO_SCALING_METHOD_OPTIONS, DISPLAY_ARC_SYNC_PROFILE_OPTIONS,
  DISPLAY_GLOBAL_VRR_MODE_OPTIONS,
  DISPLAY_SCALING_FLASH_WARNING,
} from './backend.interface.js';
import { canonicalToIgcl, igclToCanonical, clampAndSnap, clampGpuLock, clampFanPct, formatDeviceName, normalizeFanCurve, nearlyEqual, TEMP_LIMIT_MAX_C, vramMemTypeOfName, sortDevicesDiscreteFirst, deviceHardwareKey, isIntegratedStyleDevice, isIntelIntegratedOrMobileArc } from './units.js';
import { EXTENDED_TL_MAX_C } from '../old-igcl.js';
import { classifyXeFgExecutable } from '../game-profile-capabilities.js';
// M17c: the pure AIB decode (aibOf + the laptop branch). The renderer TS
// imports fine under the packaged Electron (Node 22.21 - type stripping is
// default since 22.18); the pure module carries no runtime TS-only features.
import { aibOf, laptopAibOf } from '../../renderer/pure/aib.ts';
// M17c: the per-device limits table (the listed rows + the default row) -
// applied main-side in getCapabilities AFTER the driver-props loop. The
// renderer TS imports fine under the packaged Electron (see aib.ts).
import { deviceLimitsOf, defaultLimitsOf } from '../../renderer/pure/device-limits.ts';
// M21: the sysman-primary PL ceiling (the >315 W exposed max) - the same
// pure module the renderer pins the slider max from.
import { SYSMAN_PL_MAX_W } from '../../renderer/pure/settings.ts';
// M17e: the listed-card lockRange fallback table (the pure module - the
// a770/a750 documented-class rows; the caps-level fallback when the driver
// props do not report the VF-curve limits; the live A770 driver answers
// bSupported:false - the probe-3 evidence).
import { lockRangeOf } from '../../renderer/pure/lock-ranges.ts';
import { isBattlemageGpuName } from '../../renderer/pure/hardware-icons.ts';
// M17c: the session refused-ceiling store (parent-side merge + the shared
// recording helper - run B wires the store into getCapabilities + the
// apply paths; the pure module ships the primitives).
import { createRefusedCeilingStore, mergeIntoRanges, recordedCeilingsFor, recordRefusalEnvelope } from './refused-ceilings.js';
import {
  createVrrRegistry,
  SCALING_STATE_GPU,
  SCALING_STATE_DISPLAY,
} from './vrr-registry.js';
import { createSharedMemoryOverride, sharedMemoryPlatformSupported } from './shared-memory-override.js';

const ZERO_UID = { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] };

// V2 -> V1 is primarily an ABI compatibility fallback. Some Battlemage
// driver builds expose the V2 symbol but answer NOT_AVAILABLE for the newer
// surface while the legacy structure still works. Treat that one result as
// an API-surface absence, not as a dead device; genuine device/KMD failures
// remain visible to the caller.
const POWER_TELEMETRY_V2_COMPATIBILITY_ERRORS = new Set([
  CTL_RESULT.ERROR_UNSUPPORTED_FEATURE,
  CTL_RESULT.ERROR_UNSUPPORTED_VERSION,
  CTL_RESULT.ERROR_UNSUPPORTED_SIZE,
  CTL_RESULT.ERROR_NOT_IMPLEMENTED,
  CTL_RESULT.ERROR_NOT_AVAILABLE,
]);

function isPowerTelemetryV2CompatibilityError(result) {
  return POWER_TELEMETRY_V2_COMPATIBILITY_ERRORS.has(result);
}

// ctl_fan_config_t.mode -> canonical fanMode.
const FAN_MODE_CANONICAL = { 0: 'auto', 1: 'fixed', 2: 'curve' };

// CTL_FAN_SPEED_UNITS maps numeric codes -> names ({0: 'RPM', 1: 'PERCENT'}),
// while ctl_fan_properties_t.supportedUnits is a bit mask over those codes.
const FAN_UNITS_PERCENT = Number(Object.entries(CTL_FAN_SPEED_UNITS).find(([, n]) => n === 'PERCENT')[0]);
const FAN_UNITS_RPM = Number(Object.entries(CTL_FAN_SPEED_UNITS).find(([, n]) => n === 'RPM')[0]);

function fanUnitForProperties(properties) {
  const supported = Number(properties?.supportedUnits) >>> 0;
  // Prefer percent when the driver advertises it: it is the canonical UI
  // unit and preserves the existing Alchemist/IGS route.
  if ((supported & (1 << FAN_UNITS_PERCENT)) !== 0) return FAN_UNITS_PERCENT;
  // `supportedUnits` describes the unit accepted by the fan-state API, not
  // the unit used by the temperature/speed table API. Both Arc generations
  // on the live driver advertise RPM here (and the Alchemist reports
  // maxRPM=-1), while ctlFanSetSpeedTableMode still requires the FAN enum's
  // PERCENT unit. Keep RPM as the state-unit answer even when maxRPM is
  // unknown; fanPctFromSpeed will reject an RPM value it cannot normalize.
  if ((supported & (1 << FAN_UNITS_RPM)) !== 0) return FAN_UNITS_RPM;
  return null;
}

// Intel's ctl_fan_speed_t table/fixed APIs use the FAN enum's PERCENT value
// (1) on the Arc driver even when ctl_fan_properties_t advertises RPM only.
// This is deliberately separate from fanUnitForProperties: selecting RPM for
// writes makes the probe fail on both A770 and B580, which leaves the UI with
// no Curve control despite the table setter accepting percent values.
const FAN_CONTROL_UNITS = FAN_UNITS_PERCENT;

function fanSpeedFromPct(value, units, maxRpm) {
  const pct = clampFanPct(value);
  return units === FAN_UNITS_RPM ? Math.round((pct / 100) * maxRpm) : pct;
}

function fanPctFromSpeed(value, units, maxRpm) {
  if (units === FAN_UNITS_PERCENT) return Number(value);
  if (units === FAN_UNITS_RPM && Number(maxRpm) > 0) return (Number(value) / Number(maxRpm)) * 100;
  return null;
}

// M17p: the fan-probe PERSISTED cache (the igcl-dll-cache precedent -
// %APPDATA%\ArcPower, NOT temp which the OS cleans). The in-memory
// _fanProbeCache is per-process, so the probe (~400-480 ms on this box:
// the failing write/read-back/restore-retries) re-ran at EVERY boot.
// SUCCESS-ONLY + PROBE-VERSIONED persistence: only a cached probeOk:true
// from the CURRENT probe logic (probeVersion matches FAN_PROBE_VERSION) is
// trusted across boots - the probe verdict is driver/device-bound, but the
// fallback capability CHANGES with the probe code, so an OLD probe-logic
// entry (e.g. a pre-M20-B fixed-only probe that never learned the flat-table
// fallback) is never trusted and the probe re-runs once; a cached failure
// is NEVER trusted - the verdict flips with the IGS service state, and a
// persisted failure would lock a transiently-failing machine read-only for
// a whole driver version (the session cache's re-probe self-heals). Key =
// probeVersion + driverVersion + stable deviceKey; deviceId is retained only
// as legacy metadata and MUST NOT decide a cache hit after reorder.
export const FAN_PROBE_CACHE_FILENAME = 'fan-probe-cache.json';

// M20-B cache: the probe-LOGIC version. v1 = the pre-M20-B fixed-only probe
// (the dedicated ctlFanSetFixedSpeedMode path only); v2 = the M20-B
// flat-table fallback. The learned fixed capability depends on the probe
// code, so a persisted v1 verdict (fixedOk:false from a probe that never
// tried the fallback) must NOT be trusted once the code grew the fallback -
// the version gates the cache: a missing/mismatched probeVersion is a miss
// (the probe re-runs once and re-persists under the current version).
// v3: the Arc table/fixed write unit is now kept separate from the
// properties/state unit. This invalidates v2 successes that were learned
// with the RPM-derived write encoding.
export const FAN_PROBE_VERSION = 3;

export function fanProbeCacheFile() {
  const dir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(dir, 'ArcPower', FAN_PROBE_CACHE_FILENAME);
}

function readFanProbeCache(cacheFile) {
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.driverVersion === 'string'
      && typeof data.deviceId === 'number'
      && typeof data.probeOk === 'boolean'
      && typeof data.writeAccepted === 'boolean'
      && typeof data.fixedOk === 'boolean') {
      return data;
    }
  } catch {
    // missing / corrupt / unreadable -> a miss (the probe re-runs)
  }
  return null;
}

function writeFanProbeCache(cacheFile, entry) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(entry));
  } catch {
    // a failed cache write never breaks the probe path
  }
}

const OC_UNIT_FIELDS = {
  powerLimit: 'powerLimit',
  gpuVoltOffset: 'gpuVoltageOffset',
  gpuFreqOffset: 'gpuFrequencyOffset',
  tempLimit: 'temperatureLimit',
  vramFreqOffset: 'vramMemSpeedLimit',
  vramVoltOffset: 'vramVoltageOffset',
};

// M8 (the Graphics tab): the canonical <-> IGCL value tables for the three
// enum features (the numeric side is the v290 enum; the canonical strings
// are the shared contract - backend.interface.js option lists).
const GRAPHICS_FG_TO_IGCL = { 'app-choice': 0, '2x': 1, '3x': 2, '4x': 3 };
const GRAPHICS_FG_FROM_IGCL = { 0: 'app-choice', 1: '2x', 2: '3x', 3: '4x' };
const GRAPHICS_FLIP_TO_IGCL = {
  'application-default': CTL_GAMING_FLIP_MODE_FLAG.APPLICATION_DEFAULT,
  'smart-vsync': CTL_GAMING_FLIP_MODE_FLAG.CAPPED_FPS,
  'vsync-off': CTL_GAMING_FLIP_MODE_FLAG.VSYNC_OFF,
  'vsync-on': CTL_GAMING_FLIP_MODE_FLAG.VSYNC_ON,
  'smooth-sync': CTL_GAMING_FLIP_MODE_FLAG.SMOOTH_SYNC,
  'speed-frame': CTL_GAMING_FLIP_MODE_FLAG.SPEED_FRAME,
};
const GRAPHICS_FLIP_FROM_IGCL = Object.fromEntries(
  Object.entries(GRAPHICS_FLIP_TO_IGCL).map(([k, v]) => [v, k]),
);
const GRAPHICS_LL_TO_IGCL = { off: 0, on: 1, 'on-boost': 2 };
const GRAPHICS_LL_FROM_IGCL = { 0: 'off', 1: 'on', 2: 'on-boost' };
const GLOBAL_OR_PER_APP_TO_IGCL = { global: 2, 'per-app': 1 };

function selectGlobal3dScope(lib, adapterHandle, features) {
  const detail = features?.get(CTL_3D_FEATURE.GLOBAL_OR_PER_APP);
  if (!detail || detail.valueType !== CTL_PROPERTY_VALUE_TYPE.ENUM) {
    return {
      ok: false,
      errorCode: 'unsupported',
      message: 'the driver does not expose the IGCL global/per-application scope selector',
    };
  }
  // IGS selects GLOBAL first, then reads/writes VRR_WINDOWED_BLT with an empty
  // executable name. Sending feature 14 alone leaves the previous per-app
  // scope selected on drivers that enforce the selector contract.
  const scope = encode3dFeatureGetset({
    featureType: CTL_3D_FEATURE.GLOBAL_OR_PER_APP,
    valueType: CTL_PROPERTY_VALUE_TYPE.ENUM,
    bSet: true,
    enumValue: GLOBAL_OR_PER_APP_TO_IGCL.global,
    applicationName: '',
  });
  let result;
  try {
    result = lib.ctlGetSet3DFeature(adapterHandle, scope.buf);
  } catch {
    return {
      ok: false,
      errorCode: 'io-failed',
      message: 'IGCL global VRR scope selection failed while calling the driver. No VRR value was changed.',
    };
  }
  if (result !== CTL_RESULT.SUCCESS) {
    return {
      ok: false,
      errorCode: igclErrorCode(result) ?? 'io-failed',
      message: `IGCL global VRR scope selection failed (${describeResult(result)}). Update the Intel graphics driver or apply this setting from Intel Graphics Software; no VRR value was changed.`,
    };
  }
  return { ok: true };
}

// Most drivers accept the global VRR feature directly with an empty
// application name. A small set requires feature 15 to select GLOBAL first;
// Version mismatches can be reported as either INVALID_ARGUMENT or
// UNSUPPORTED_VERSION, depending on the driver build.
// Permission/unsupported/IO failures are real refusals and must not trigger a
// second write path or be reported as applied.
function globalVrrRequest(lib, adapterHandle, features, { bSet, enumValue } = {}) {
  const makeRequest = () => encode3dFeatureGetset({
    featureType: CTL_3D_FEATURE.VRR_WINDOWED_BLT,
    valueType: CTL_PROPERTY_VALUE_TYPE.ENUM,
    bSet,
    enumValue,
    applicationName: '',
  });
  let request = makeRequest();
  let result;
  try {
    result = lib.ctlGetSet3DFeature(adapterHandle, request.buf);
  } catch {
    return { result: null, request, errorCode: 'io-failed', message: 'IGCL global Variable Refresh Rate access failed while calling the driver.' };
  }
  if (result !== CTL_RESULT.ERROR_INVALID_ARGUMENT) return { result, request };
  const scope = selectGlobal3dScope(lib, adapterHandle, features);
  if (!scope.ok) return { result, request, scope };
  request = makeRequest();
  try {
    result = lib.ctlGetSet3DFeature(adapterHandle, request.buf);
  } catch {
    return { result: null, request, errorCode: 'io-failed', message: 'IGCL global Variable Refresh Rate access failed while calling the driver after selecting GLOBAL scope.' };
  }
  return { result, request, usedScopeFallback: true };
}

function endurancePlatformSupported(device, laptopInfo = null) {
  // IGS exposes these controls on built-in/integrated Arc and mobile Arc
  // adapters. Real desktop discrete GPUs have neither identity and remain
  // excluded.
  return isIntelIntegratedOrMobileArc(device);
}

const ENDURANCE_CONTROL_TO_IGCL = Object.freeze({ off: 0, on: 1, auto: 2 });
const ENDURANCE_CONTROL_FROM_IGCL = Object.freeze({ 0: 'off', 1: 'on', 2: 'auto' });
const ENDURANCE_MODE_TO_FPS = Object.freeze({ performance: 60, balanced: 40, battery: 30 });
const ENDURANCE_MODE_FROM_FPS = Object.freeze({ 60: 'performance', 40: 'balanced', 30: 'battery' });
const ENDURANCE_CONTROL_OPTIONS = Object.freeze(['off', 'on', 'auto']);
const ENDURANCE_MODE_OPTIONS = Object.freeze(['performance', 'balanced', 'battery']);

function enduranceValueTypeSupported(valueType) {
  return [
    CTL_PROPERTY_VALUE_TYPE.ENUM,
    CTL_PROPERTY_VALUE_TYPE.INT32,
    CTL_PROPERTY_VALUE_TYPE.UINT32,
  ].includes(valueType);
}

function enduranceControlOptionsOf(detail) {
  if (!detail || !enduranceValueTypeSupported(detail.valueType)) return [];
  if (detail.valueType !== CTL_PROPERTY_VALUE_TYPE.ENUM || detail.enumSupportedTypes == null || detail.enumSupportedTypes === 0n) {
    return detail.valueType === CTL_PROPERTY_VALUE_TYPE.INT32 || detail.valueType === CTL_PROPERTY_VALUE_TYPE.UINT32
      ? ['off', 'on']
      : [...ENDURANCE_CONTROL_OPTIONS];
  }
  return ENDURANCE_CONTROL_OPTIONS.filter((name) => (
    detail.enumSupportedTypes & (1n << BigInt(ENDURANCE_CONTROL_TO_IGCL[name]))
  ) !== 0n);
}

function enduranceModeOptionsOf(detail) {
  if (detail?.valueType !== CTL_PROPERTY_VALUE_TYPE.INT32 && detail?.valueType !== CTL_PROPERTY_VALUE_TYPE.UINT32) return [];
  const range = detail.intRange;
  if (!range) return [];
  return ENDURANCE_MODE_OPTIONS.filter((mode) => ENDURANCE_MODE_TO_FPS[mode] >= range.min && ENDURANCE_MODE_TO_FPS[mode] <= range.max);
}

function enduranceControlFromValue(value) {
  return ENDURANCE_CONTROL_FROM_IGCL[value] ?? null;
}

function enduranceModeFromFps(value) {
  return ENDURANCE_MODE_FROM_FPS[value] ?? null;
}

function readEnduranceGamingValue(lib, adapterHandle, detail, applicationName = '') {
  if (!detail || !enduranceValueTypeSupported(detail.valueType)) return null;
  try {
    if (detail.valueType === CTL_PROPERTY_VALUE_TYPE.ENUM) {
      const gs = encode3dFeatureGetset({
        featureType: CTL_3D_FEATURE.ENDURANCE_GAMING,
        valueType: detail.valueType,
        bSet: false,
        applicationName,
      });
      if (lib.ctlGetSet3DFeature(adapterHandle, gs.buf) !== CTL_RESULT.SUCCESS) return null;
      const raw = decode3dFeatureGetsetValue(gs.buf, detail.valueType);
      return { enduranceGaming: enduranceControlFromValue(raw.enableType), enduranceGamingMode: null };
    }
    if (detail.valueType === CTL_PROPERTY_VALUE_TYPE.INT32 || detail.valueType === CTL_PROPERTY_VALUE_TYPE.UINT32) {
      const gs = encode3dFeatureGetset({
        featureType: CTL_3D_FEATURE.ENDURANCE_GAMING,
        valueType: detail.valueType,
        bSet: false,
        applicationName,
      });
      if (lib.ctlGetSet3DFeature(adapterHandle, gs.buf) !== CTL_RESULT.SUCCESS) return null;
      const raw = decode3dFeatureGetsetValue(gs.buf, detail.valueType);
      return {
        enduranceGaming: raw.enable === true ? 'on' : 'off',
        enduranceGamingMode: enduranceModeFromFps(raw.value),
        enduranceGamingFps: raw.value,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * A few driver branches answer the Endurance GET but omit feature 1 from
 * ctlGetSupported3DCapabilities. Probe the documented generic INT32 ABI so
 * eligible mobile/iGPU adapters are not incorrectly reduced to desktop cards.
 * A failed probe remains unsupported; no UI capability is invented.
 */
function probeEnduranceGamingDetail(lib, adapterHandle) {
  if (typeof lib?.ctlGetSet3DFeature !== 'function') return null;
  try {
    const gs = encode3dFeatureGetset({
      featureType: CTL_3D_FEATURE.ENDURANCE_GAMING,
      valueType: CTL_PROPERTY_VALUE_TYPE.INT32,
      bSet: false,
    });
    if (lib.ctlGetSet3DFeature(adapterHandle, gs.buf) !== CTL_RESULT.SUCCESS) return null;
    const current = decode3dFeatureGetsetValue(gs.buf, CTL_PROPERTY_VALUE_TYPE.INT32);
    if (!Number.isFinite(current?.value)) return null;
    return {
      featureType: CTL_3D_FEATURE.ENDURANCE_GAMING,
      valueType: CTL_PROPERTY_VALUE_TYPE.INT32,
      enumSupportedTypes: null,
      intRange: { min: 30, max: 60, step: 1, default: 60 },
      perAppSupport: false,
      probed: true,
    };
  } catch {
    return null;
  }
}

function enduranceDetailOf(lib, adapterHandle, features) {
  const detail = features?.get(CTL_3D_FEATURE.ENDURANCE_GAMING);
  return enduranceValueTypeSupported(detail?.valueType)
    ? detail
    : probeEnduranceGamingDetail(lib, adapterHandle);
}

// M10b (the Graphics "Display" view): the canonical <-> IGCL value tables
// for the display controls (the numeric side is the v290 enum/flag; the
// canonical strings are the shared contract - backend.interface.js option
// lists). ScalingType is a FLAG value in the struct - the probe-pinned
// numbers 1/2/4/8/16 (the bindings' CTL_SCALING_TYPE_FLAG table maps those
// numbers to NAMES; the canonical side needs the numbers themselves).
const DISPLAY_CONNECTION_CANONICAL = { 1: 'DisplayPort', 2: 'HDMI', 3: 'DVI', 4: 'MIPI', 5: 'CRT' };
const DISPLAY_QUANT_TO_IGCL = { default: 0, limited: 1, full: 2 };
const DISPLAY_QUANT_FROM_IGCL = { 0: 'default', 1: 'limited', 2: 'full' };
const DISPLAY_WIRE_MODEL_TO_IGCL = { RGB: 0, YCbCr420: 1, YCbCr422: 2, YCbCr444: 3 };
const DISPLAY_WIRE_MODEL_FROM_IGCL = { 0: 'RGB', 1: 'YCbCr420', 2: 'YCbCr422', 3: 'YCbCr444' };
const DISPLAY_SCALING_MODE_TO_IGCL = {
  identity: 1, centered: 2, stretched: 4,
  'aspect-ratio-centered-max': 8, custom: 16,
};
const DISPLAY_SCALING_MODE_FROM_IGCL = { 1: 'identity', 2: 'centered', 4: 'stretched', 8: 'aspect-ratio-centered-max', 16: 'custom' };

// Intel Graphics Software writes the versioned ctl_scaling_settings_t surface
// with Version 1 for every scaling mode. Older drivers may reject that
// version, so retain a narrowly-scoped Version 0 compatibility fallback. A
// successful setter is still not reported as applied until fresh scaling
// read-back agrees. Raw compatibility writes use the virtual-modeset path;
// the explicit GPU-method alias requests the physical modeset/black-screen
// transition used by IGS. Custom scaling remains caller-controlled because
// it may need the physical display transition exposed by IGS.
function setScalingWithCompatibility(lib, handle, { flag, custom, hardwareModeSet = false }) {
  const versions = [1, 0];
  let lastResult = CTL_RESULT.ERROR_INVALID_ARGUMENT;
  let lastBuf = null;
  for (const version of versions) {
    const gs = encodeScalingSettings({
      enable: true,
      scalingType: flag,
      customScalingX: custom?.x,
      customScalingY: custom?.y,
      hardwareModeSet: custom ? custom.hardwareModeSet !== false : hardwareModeSet,
      // PreferredScalingType is an [out] field according to IGCL. It is
      // reported by GET, but must not be supplied as an input on SET.
      version,
    });
    lastBuf = gs.buf;
    lastResult = lib.ctlSetCurrentScaling(handle, gs.buf);
    if (lastResult === CTL_RESULT.SUCCESS
      || (lastResult !== CTL_RESULT.ERROR_INVALID_ARGUMENT && lastResult !== CTL_RESULT.ERROR_UNSUPPORTED_VERSION)) break;
  }
  return { setResult: lastResult, request: lastBuf };
}

function getScalingWithCompatibility(lib, handle) {
  let lastResult = CTL_RESULT.ERROR_INVALID_ARGUMENT;
  for (const version of [1, 0]) {
    const { buf } = encodeScalingSettings({ version });
    lastResult = lib.ctlGetCurrentScaling(handle, buf);
    if (lastResult === CTL_RESULT.SUCCESS) {
      return { getResult: lastResult, version, settings: decodeScalingSettings(buf) };
    }
    if (lastResult !== CTL_RESULT.ERROR_INVALID_ARGUMENT && lastResult !== CTL_RESULT.ERROR_UNSUPPORTED_VERSION) break;
  }
  return { getResult: lastResult, version: null, settings: null };
}
// The caps-bit decode yields the bindings' SCREAMING names ('IDENTITY',
// ...) - map them to the canonical strings.
const DISPLAY_SCALING_NAME_TO_CANONICAL = {
  IDENTITY: 'identity', CENTERED: 'centered', STRETCHED: 'stretched',
  ASPECT_RATIO_CENTERED_MAX: 'aspect-ratio-centered-max', CUSTOM: 'custom',
};
const DISPLAY_ARC_SYNC_PROFILE_CANONICAL = {
  1: 'recommended', 2: 'excellent', 3: 'good', 4: 'compatible', 5: 'off', 6: 'vesa', 7: 'custom',
};
const DISPLAY_RETRO_SCALING_NAME_TO_CANONICAL = {
  INTEGER: 'integer', NEAREST_NEIGHBOUR: 'nearest-neighbour',
};
// ctl_retro_scaling_settings_t carries the flag VALUE, not the caps bit
// index: INTEGER=1 and NEAREST_NEIGHBOUR=2. A disabled driver may normalize
// the type field to 0, so the disabled read-back path treats type as opaque.
const DISPLAY_RETRO_SCALING_METHOD_FROM_IGCL = { 1: 'integer', 2: 'nearest-neighbour' };
const DISPLAY_RETRO_SCALING_METHOD_TO_IGCL = { integer: 1, 'nearest-neighbour': 2 };
const DISPLAY_ARC_SYNC_PROFILE_TO_IGCL = {
  recommended: 1, excellent: 2, good: 3, compatible: 4, off: 5, vesa: 6, custom: 7,
};
// IGS Display > General exposes GlobalVrr as three user-facing modes. The
// public IGCL enum uses Auto/On/Off, which map to Fullscreen,
// Fullscreen & Windowed, and Disabled respectively.
const DISPLAY_GLOBAL_VRR_MODE_FROM_IGCL = { 0: 'fullscreen', 1: 'fullscreen-windowed', 2: 'disabled' };
const DISPLAY_GLOBAL_VRR_MODE_TO_IGCL = { fullscreen: 0, 'fullscreen-windowed': 1, disabled: 2 };
function scalingAliasPayloadError(patch) {
  const alias = patch?.displayScalingMethod;
  if (alias === undefined || alias === null) return null;
  const gpuAlias = alias === 'centered' || alias === 'stretched' || alias === 'aspect-ratio-centered-max';
  const retroAlias = alias === 'integer' || alias === 'nearest-neighbour';
  if (gpuAlias) {
    if (patch.scalingMode !== alias) return 'a GPU Scaling Method must match the coupled raw scalingMode';
    if (patch.scalingMethod?.enabled === true) return 'a GPU Scaling Method cannot enable Retro Scaling in the same request';
    return null;
  }
  if (retroAlias) {
    if (patch.scalingMode !== 'identity'
      || !patch.scalingMethod
      || patch.scalingMethod.method !== alias
      || typeof patch.scalingMethod.enabled !== 'boolean') {
      return 'a Retro Scaling Method must match the coupled raw scalingMode and scalingMethod';
    }
    return null;
  }
  if (alias === 'maintain-display-scaling' && patch.scalingMode !== undefined && patch.scalingMode !== 'identity') {
    return 'Maintain Display Scaling must match raw scalingMode identity';
  }
  if ((alias === 'maintain-display-scaling' || alias === 'custom') && patch.scalingMethod?.enabled === true) {
    return 'Display Scaling cannot enable Retro Scaling in the same request';
  }
  if (alias === 'custom' && patch.scalingMode !== undefined && patch.scalingMode !== 'custom') {
    return 'Custom Display Scaling must match raw scalingMode custom';
  }
  if (alias === 'custom') {
    const custom = patch.scalingCustom;
    if (!custom || typeof custom !== 'object'
      || !Number.isFinite(custom.x) || custom.x < 0 || custom.x > 100
      || !Number.isFinite(custom.y) || custom.y < 0 || custom.y > 100) {
      return 'Custom Display Scaling requires valid horizontal and vertical percentages';
    }
  }
  return null;
}

// Older callers used displayScalingMethod as the writable field. Normalize
// that compatibility shape into the same coupled raw payload used by the
// current renderer before any control list, native call, or read-back path is
// selected. Keeping the alias on the object lets the response mirror the
// caller's control name without maintaining a second native implementation.
function normalizeDisplayScalingAlias(patch) {
  if (!patch || patch.scalingMode !== undefined || patch.displayScalingMethod === undefined || patch.displayScalingMethod === null) {
    return patch;
  }
  const alias = patch.displayScalingMethod;
  if (alias === 'centered' || alias === 'stretched' || alias === 'aspect-ratio-centered-max') {
    return { ...patch, scalingMode: alias };
  }
  if (alias === 'integer' || alias === 'nearest-neighbour') {
    return {
      ...patch,
      scalingMode: 'identity',
      scalingMethod: patch.scalingMethod ?? { enabled: true, method: alias },
    };
  }
  if (alias === 'maintain-display-scaling') return { ...patch, scalingMode: 'identity' };
  if (alias === 'custom') return { ...patch, scalingMode: 'custom' };
  return patch;
}
function globalVrrOptionsOf(detail) {
  if (detail?.enumSupportedTypes == null) return [];
  return DISPLAY_GLOBAL_VRR_MODE_OPTIONS.filter((mode) => {
    const value = DISPLAY_GLOBAL_VRR_MODE_TO_IGCL[mode];
    return (detail.enumSupportedTypes & (1n << BigInt(value))) !== 0n;
  });
}
// ctl_std_display_feature_flag_t is a bitmask. These values are deliberately
// named here instead of treating the flags as anonymous shifts at each read.
const DISPLAY_FEATURE_HDCP = 1 << 0;
const DISPLAY_FEATURE_ADAPTIVE_SYNC_VRR = 1 << 3;
const DISPLAY_FEATURE_HDR = 1 << 5;
const displayCapability = (value, supported, controllable = false, reason = null, source = 'igcl') => ({
  value, supported, controllable, reason, source,
});

// Intel's Media API structures are not present in the older local binding
// set. Keep the byte contract isolated here so a missing/newer runtime can
// fail closed without taking down the Display page. The sizes/offsets mirror
// the public v1.1 header: the feature list contains a custom-value pointer and
// Standard Color Correction is a 88-byte custom structure.
const MEDIA_FEATURE_CAPS_SIZE = 88;
const MEDIA_FEATURE_DETAILS_SIZE = 120;
const MEDIA_FEATURE_GETSET_SIZE = 120;
const MEDIA_COLOR_INFO_SIZE = 152;
const MEDIA_COLOR_VALUE_SIZE = 88;
const MEDIA_COLOR_FEATURE = 5;
const MEDIA_CUSTOM_VALUE_TYPE = 5;
const MEDIA_STRUCT_VERSION = 0;

// ctl_pixel_transformation_* is a display-output pipeline, not an adapter
// video-processing feature.  The local IGCL headers do not contain these
// structs, so keep their byte layout isolated and versioned here.  These
// offsets were checked against the installed A770 runtime and the public
// IGCL v1.1 header: the matrix-and-offsets block is the writable 3x3 color
// transform used for desktop output calibration.
const PIXEL_FORMAT_SIZE = 120;
const PIXEL_BLOCK_CONFIG_SIZE = 144;
const PIXEL_MATRIX_CONFIG_SIZE = 128;
const PIXEL_GET_CONFIG_SIZE = 272;
const PIXEL_SET_CONFIG_SIZE = 32;
const PIXEL_BLOCK_TYPE_MATRIX_AND_OFFSETS = 4;
const PIXEL_QUERY_CAPABILITIES = 0;
const PIXEL_QUERY_CURRENT = 1;
const PIXEL_OPERATION_RESTORE_DEFAULT = 1;
const PIXEL_OPERATION_SET = 2;
// ctl_pixtx_color_model_t has separate full/limited entries, unlike the
// legacy wire-format enum. Collapse those pairs only when presenting the
// active output format to the Display page.
const PIXEL_COLOR_MODEL_TO_WIRE = {
  0: 'RGB', 1: 'RGB',
  2: 'YCbCr422', 3: 'YCbCr422',
  4: 'YCbCr420', 5: 'YCbCr420',
  6: 'YCbCr444', 7: 'YCbCr444',
};

function pixelWrite(buf, offset, type, value) {
  koffi.encode(buf, offset, type, value);
}

function pixelRead(buf, offset, type) {
  return koffi.decode(buf, offset, type);
}

function pixelFormatOf(buf, offset) {
  const model = Number(pixelRead(buf, offset + 24, 'int32')) | 0;
  const bits = Number(pixelRead(buf, offset + 8, 'uint32')) | 0;
  return { model, bitsPerColor: bits };
}

function pixelGetConfigBuffer(blocks = null, queryType = PIXEL_QUERY_CAPABILITIES) {
  const buf = koffi.alloc('uint8', PIXEL_GET_CONFIG_SIZE + 16);
  pixelWrite(buf, 0, 'uint32', PIXEL_GET_CONFIG_SIZE);
  pixelWrite(buf, 4, 'uint8', 0);
  pixelWrite(buf, 8, 'uint32', queryType);
  pixelWrite(buf, 16, 'uint32', PIXEL_FORMAT_SIZE);
  pixelWrite(buf, 136, 'uint32', PIXEL_FORMAT_SIZE);
  pixelWrite(buf, 256, 'uint32', blocks?.count ?? 0);
  pixelWrite(buf, 264, 'void*', blocks?.address ?? 0n);
  return buf;
}

function pixelBlockOf(buf, offset) {
  const configOffset = offset + 16;
  const preOffsets = [];
  const postOffsets = [];
  const matrixOffset = configOffset + 56;
  const matrix = [];
  // ctl_pixtx_matrix_config_t stores PreOffsets, PostOffsets, and Matrix
  // as doubles. Reading/writing these as float32 values produces a buffer
  // the driver may accept while applying no visible transform.
  for (let i = 0; i < 3; i += 1) {
    preOffsets.push(Number(pixelRead(buf, configOffset + 8 + i * 8, 'double')));
    postOffsets.push(Number(pixelRead(buf, configOffset + 32 + i * 8, 'double')));
  }
  for (let i = 0; i < 9; i += 1) matrix.push(Number(pixelRead(buf, matrixOffset + i * 8, 'double')));
  return {
    id: Number(pixelRead(buf, offset + 8, 'uint32')) >>> 0,
    type: Number(pixelRead(buf, offset + 12, 'uint32')) >>> 0,
    preOffsets,
    postOffsets,
    matrix,
  };
}

/**
 * Read the display-output pixel transformation capabilities or current
 * configuration through the same GET surface. The query type is kept
 * explicit because capability data must never be mistaken for apply
 * read-back. GET availability is independent from SET availability.
 */
function readPixelTransformation(lib, displayHandle, { queryType = PIXEL_QUERY_CAPABILITIES, requireSet = false } = {}) {
  if (!displayHandle || typeof lib?.ctlPixelTransformationGetConfig !== 'function'
    || lib.ctlPixelTransformationGetConfig.unavailable
    || (requireSet && (typeof lib?.ctlPixelTransformationSetConfig !== 'function'
      || lib.ctlPixelTransformationSetConfig.unavailable))) return null;
  try {
    const countBuf = pixelGetConfigBuffer(null, queryType);
    let result = lib.ctlPixelTransformationGetConfig(displayHandle, countBuf);
    if (result !== CTL_RESULT.SUCCESS) return null;
    const count = Number(pixelRead(countBuf, 256, 'uint32'));
    if (!Number.isInteger(count) || count < 1 || count > 64) return null;
    const blockBuf = koffi.alloc('uint8', PIXEL_BLOCK_CONFIG_SIZE * count + 16);
    for (let i = 0; i < count; i += 1) {
      const offset = i * PIXEL_BLOCK_CONFIG_SIZE;
      pixelWrite(blockBuf, offset, 'uint32', PIXEL_MATRIX_CONFIG_SIZE + 16);
      pixelWrite(blockBuf, offset + 4, 'uint8', 0);
    }
    const get = pixelGetConfigBuffer({ count, address: koffi.address(blockBuf) }, queryType);
    result = lib.ctlPixelTransformationGetConfig(displayHandle, get);
    if (result !== CTL_RESULT.SUCCESS) return null;
    const blocks = [];
    for (let i = 0; i < count; i += 1) blocks.push(pixelBlockOf(blockBuf, i * PIXEL_BLOCK_CONFIG_SIZE));
    return {
      inputFormat: pixelFormatOf(get, 16),
      outputFormat: pixelFormatOf(get, 136),
      queryType,
      blocks,
      matrixBlock: blocks.find((block) => block.type === PIXEL_BLOCK_TYPE_MATRIX_AND_OFFSETS) ?? null,
    };
  } catch {
    return null;
  }
}

function pixelMatrixForColors({ hue = 0, saturation = 1, brightness = 0, contrast = 1 }) {
  const angle = (Number(hue) * Math.PI) / 180;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const lum = [0.2126, 0.7152, 0.0722];
  const sat = Number(saturation);
  const satMatrix = [
    lum[0] * (1 - sat) + sat, lum[1] * (1 - sat), lum[2] * (1 - sat),
    lum[0] * (1 - sat), lum[1] * (1 - sat) + sat, lum[2] * (1 - sat),
    lum[0] * (1 - sat), lum[1] * (1 - sat), lum[2] * (1 - sat) + sat,
  ];
  const hueMatrix = [
    lum[0] + c * (1 - lum[0]) - s * lum[0], lum[1] * (1 - c) + s * lum[1], lum[2] * (1 - c) + s * lum[2],
    lum[0] * (1 - c) + s * 0.143, lum[1] + c * (1 - lum[1]) - s * 0.14, lum[2] * (1 - c) + s * 0.283,
    lum[0] * (1 - c) - s * (1 - lum[0]), lum[1] * (1 - c) + s * lum[1], lum[2] + c * (1 - lum[2]) - s * lum[2],
  ];
  const multiply = (a, b) => {
    const out = Array(9).fill(0);
    for (let row = 0; row < 3; row += 1) {
      for (let col = 0; col < 3; col += 1) {
        for (let k = 0; k < 3; k += 1) out[row * 3 + col] += a[row * 3 + k] * b[k * 3 + col];
      }
    }
    return out;
  };
  const scale = Number(contrast);
  const matrix = multiply(hueMatrix, satMatrix).map((value) => value * scale);
  const offset = 0.5 * (1 - scale) + Number(brightness) / 100;
  return { matrix, offsets: [offset, offset, offset] };
}

function pixelMatrixMatches(block, expected, tolerance = 0.00001) {
  if (!block || !Array.isArray(block.matrix) || block.matrix.length !== 9
    || !Array.isArray(block.preOffsets) || !Array.isArray(block.postOffsets)) return false;
  const values = [...block.preOffsets, ...block.postOffsets, ...block.matrix];
  const wanted = [0, 0, 0, ...expected.offsets, ...expected.matrix];
  return values.length === wanted.length
    && values.every((value, index) => Number.isFinite(value) && Math.abs(value - wanted[index]) <= tolerance);
}

function pixelMatrixIsNeutral(block) {
  return pixelMatrixMatches(block, {
    offsets: [0, 0, 0],
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  });
}

function pixelSetMatrix(lib, displayHandle, block, colors) {
  if (!block || typeof lib?.ctlPixelTransformationSetConfig !== 'function'
    || lib.ctlPixelTransformationSetConfig.unavailable) {
    return { ok: false, errorCode: 'unsupported', message: 'display pixel color transformation is not exposed by this driver' };
  }
  try {
    const blocks = koffi.alloc('uint8', PIXEL_BLOCK_CONFIG_SIZE + 16);
    pixelWrite(blocks, 0, 'uint32', PIXEL_MATRIX_CONFIG_SIZE + 16);
    pixelWrite(blocks, 4, 'uint8', 0);
    pixelWrite(blocks, 8, 'uint32', block.id);
    pixelWrite(blocks, 12, 'uint32', PIXEL_BLOCK_TYPE_MATRIX_AND_OFFSETS);
    const matrix = pixelMatrixForColors(colors);
    pixelWrite(blocks, 16, 'uint32', PIXEL_MATRIX_CONFIG_SIZE);
    pixelWrite(blocks, 20, 'uint8', 0);
    for (let i = 0; i < 3; i += 1) {
      pixelWrite(blocks, 24 + i * 8, 'double', 0);
      pixelWrite(blocks, 48 + i * 8, 'double', matrix.offsets[i]);
    }
    for (let i = 0; i < matrix.matrix.length; i += 1) pixelWrite(blocks, 72 + i * 8, 'double', matrix.matrix[i]);
    const set = koffi.alloc('uint8', PIXEL_SET_CONFIG_SIZE + 16);
    pixelWrite(set, 0, 'uint32', PIXEL_SET_CONFIG_SIZE);
    pixelWrite(set, 4, 'uint8', 0);
    pixelWrite(set, 8, 'uint32', PIXEL_OPERATION_SET);
    pixelWrite(set, 12, 'uint32', 1);
    pixelWrite(set, 16, 'uint32', 1);
    pixelWrite(set, 24, 'void*', koffi.address(blocks));
    const result = lib.ctlPixelTransformationSetConfig(displayHandle, set);
    return result === CTL_RESULT.SUCCESS
      ? { ok: true, readBackEqual: undefined, requested: { ...colors }, matrix }
      : { ok: false, errorCode: igclErrorCode(result) ?? 'io-failed', message: `IGCL ${describeResult(result)}` };
  } catch (error) {
    return { ok: false, errorCode: 'io-failed', message: error instanceof Error ? error.message : String(error) };
  }
}

function mediaStructHeader(buf, size) {
  mediaWrite(buf, 0, 'uint32', size);
  mediaWrite(buf, 4, 'uint8', MEDIA_STRUCT_VERSION);
}

function mediaWrite(buf, offset, type, value) {
  koffi.encode(buf, offset, type, value);
}

function mediaRead(buf, offset, type) {
  return koffi.decode(buf, offset, type);
}

function mediaRange(buf, offset) {
  return {
    min: Number(mediaRead(buf, offset + 4, 'float')),
    max: Number(mediaRead(buf, offset + 8, 'float')),
    step: Number(mediaRead(buf, offset + 12, 'float')),
    default: Number(mediaRead(buf, offset + 16, 'float')),
  };
}

/**
 * Probe/read the adapter-global Standard Color Correction feature. A driver
 * must advertise the feature, return all four ranges, and accept a read-back
 * before the renderer is allowed to show writable sliders.
 */
function readMediaColorCorrection(lib, adapterHandle) {
  if (!adapterHandle || typeof lib?.ctlGetSupportedVideoProcessingCapabilities !== 'function'
    || typeof lib?.ctlGetSetVideoProcessingFeature !== 'function'
    || lib.ctlGetSupportedVideoProcessingCapabilities.unavailable
    || lib.ctlGetSetVideoProcessingFeature.unavailable) return null;
  try {
    const caps = koffi.alloc('uint8', MEDIA_FEATURE_CAPS_SIZE + 16);
    mediaWrite(caps, 0, 'uint32', MEDIA_FEATURE_CAPS_SIZE);
    mediaWrite(caps, 4, 'uint8', 0);
    mediaWrite(caps, 8, 'uint32', 0);
    mediaWrite(caps, 16, 'void*', 0n);
    let result = lib.ctlGetSupportedVideoProcessingCapabilities(adapterHandle, caps);
    if (result !== CTL_RESULT.SUCCESS) return null;
    const count = Number(mediaRead(caps, 8, 'uint32'));
    if (!Number.isInteger(count) || count < 1 || count > 64) return null;
    const details = koffi.alloc('uint8', MEDIA_FEATURE_DETAILS_SIZE * count + 16);
    for (let i = 0; i < count; i++) {
      const off = i * MEDIA_FEATURE_DETAILS_SIZE;
      mediaWrite(details, off, 'uint32', MEDIA_FEATURE_DETAILS_SIZE);
      mediaWrite(details, off + 4, 'uint8', 0);
    }
    mediaWrite(caps, 16, 'void*', koffi.address(details));
    result = lib.ctlGetSupportedVideoProcessingCapabilities(adapterHandle, caps);
    if (result !== CTL_RESULT.SUCCESS) return null;
    let detailOffset = -1;
    let customSize = MEDIA_COLOR_INFO_SIZE;
    for (let i = 0; i < count; i++) {
      const off = i * MEDIA_FEATURE_DETAILS_SIZE;
      if (Number(mediaRead(details, off + 8, 'int32')) === MEDIA_COLOR_FEATURE) {
        detailOffset = off;
        const advertised = Number(mediaRead(details, off + 40, 'int32'));
        if (advertised > 0 && advertised <= 4096) customSize = advertised;
        break;
      }
    }
    if (detailOffset < 0) return null;
    const infoSize = Math.max(customSize, MEDIA_COLOR_INFO_SIZE);
    const info = koffi.alloc('uint8', infoSize + 16);
    mediaStructHeader(info, infoSize);
    mediaWrite(details, detailOffset + 40, 'int32', infoSize);
    mediaWrite(details, detailOffset + 48, 'void*', koffi.address(info));
    result = lib.ctlGetSupportedVideoProcessingCapabilities(adapterHandle, caps);
    if (result !== CTL_RESULT.SUCCESS) return null;

    // ctl_property_info_float_t is { bool enable; padding; four floats }.
    const ranges = {
      brightness: mediaRange(info, 8),
      contrast: mediaRange(info, 28),
      hue: mediaRange(info, 48),
      saturation: mediaRange(info, 68),
    };
    if (!Object.values(ranges).every((range) => Number.isFinite(range.min)
      && Number.isFinite(range.max) && Number.isFinite(range.step)
      && range.max >= range.min && range.step > 0)) return null;

    const appName = koffi.alloc('uint8', 1);
    mediaWrite(appName, 0, 'uint8', 0);
    const custom = koffi.alloc('uint8', MEDIA_COLOR_VALUE_SIZE + 16);
    mediaStructHeader(custom, MEDIA_COLOR_VALUE_SIZE);
    const getset = koffi.alloc('uint8', MEDIA_FEATURE_GETSET_SIZE + 16);
    mediaWrite(getset, 0, 'uint32', MEDIA_FEATURE_GETSET_SIZE);
    mediaWrite(getset, 4, 'uint8', 0);
    mediaWrite(getset, 8, 'int32', MEDIA_COLOR_FEATURE);
    mediaWrite(getset, 16, 'void*', koffi.address(appName));
    mediaWrite(getset, 24, 'int8', 0);
    mediaWrite(getset, 25, 'bool', false);
    mediaWrite(getset, 28, 'int32', MEDIA_CUSTOM_VALUE_TYPE);
    mediaWrite(getset, 40, 'int32', MEDIA_COLOR_VALUE_SIZE);
    mediaWrite(getset, 48, 'void*', koffi.address(custom));
    result = lib.ctlGetSetVideoProcessingFeature(adapterHandle, getset);
    if (result !== CTL_RESULT.SUCCESS) return null;
    return {
      enabled: mediaRead(custom, 5, 'bool'),
      values: {
        brightness: Number(mediaRead(custom, 8, 'float')),
        contrast: Number(mediaRead(custom, 12, 'float')),
        hue: Number(mediaRead(custom, 16, 'float')),
        saturation: Number(mediaRead(custom, 20, 'float')),
      },
      ranges,
      buffers: { appName, custom, getset },
    };
  } catch {
    return null;
  }
}

function mediaColorReadback(lib, adapterHandle) {
  return readMediaColorCorrection(lib, adapterHandle);
}

function mediaColorApply(lib, adapterHandle, patch, before) {
  const current = before ?? readMediaColorCorrection(lib, adapterHandle);
  if (!current) return { ok: false, errorCode: 'unsupported', message: 'standard color correction is not exposed by this driver' };
  const appName = current.buffers.appName;
  const custom = koffi.alloc('uint8', MEDIA_COLOR_VALUE_SIZE + 16);
  const getset = koffi.alloc('uint8', MEDIA_FEATURE_GETSET_SIZE + 16);
  mediaStructHeader(custom, MEDIA_COLOR_VALUE_SIZE);
  mediaWrite(custom, 5, 'bool', true);
  mediaWrite(custom, 8, 'float', Number(patch.brightness ?? current.values.brightness));
  mediaWrite(custom, 12, 'float', Number(patch.contrast ?? current.values.contrast));
  mediaWrite(custom, 16, 'float', Number(patch.hue ?? current.values.hue));
  mediaWrite(custom, 20, 'float', Number(patch.saturation ?? current.values.saturation));
  mediaWrite(getset, 0, 'uint32', MEDIA_FEATURE_GETSET_SIZE);
  mediaWrite(getset, 4, 'uint8', 0);
  mediaWrite(getset, 8, 'int32', MEDIA_COLOR_FEATURE);
  mediaWrite(getset, 16, 'void*', koffi.address(appName));
  mediaWrite(getset, 24, 'int8', 0);
  mediaWrite(getset, 25, 'bool', true);
  mediaWrite(getset, 28, 'int32', MEDIA_CUSTOM_VALUE_TYPE);
  mediaWrite(getset, 40, 'int32', MEDIA_COLOR_VALUE_SIZE);
  mediaWrite(getset, 48, 'void*', koffi.address(custom));
  const setResult = lib.ctlGetSetVideoProcessingFeature(adapterHandle, getset);
  if (setResult !== CTL_RESULT.SUCCESS) return { ok: false, errorCode: igclErrorCode(setResult) ?? 'io-failed', message: `IGCL ${describeResult(setResult)}` };
  const readBack = mediaColorReadback(lib, adapterHandle);
  if (!readBack) return { ok: false, errorCode: 'io-failed', message: 'set succeeded but color read-back failed', readBackEqual: false };
  return { ok: true, readBack, requested: { ...patch }, readBackEqual: Object.entries(patch).every(([key, value]) => Math.abs(readBack.values[key] - Number(value)) <= Math.max(0.0001, current.ranges[key]?.step ?? 0.0001)) };
}

export class IgclBackend {
  /**
   * @param {{
   *   dllPath?: string|null,          // override discovery (tests / explicit path)
   *   allowAutoWaiver?: boolean,      // smoke/tests only - never in product paths
   *   lib?: object|null,              // injected bound lib (tests); loaded at init() otherwise
   *   findDll?: () => string|null,    // injectable discovery (tests)
   *   extended?: { isCapable: () => Promise<boolean> },  // M2C-C bundled-2023-runtime probe
   *   ocMode?: 'stock'|'advanced',    // M3-C-E: which range set getCapabilities
   *                                   // exposes (default 'stock' - the real
   *                                   // product default; mock passes advanced)
 *   fanProbe?: boolean,             // M3-D: run the reversible fan-capability
 *                                   // probe on canControl=false devices
 *                                   // (default true; tests pass false to keep
 *                                   // read-only fixtures read-only)
 *   fanProbeCacheFile?: string,     // M17p: the persisted fan-probe cache
 *                                   // file path (tests inject a temp file;
 *                                   // the default is %APPDATA%\ArcPower\
 *                                   // fan-probe-cache.json - the findIgclDll
 *                                   // opts.cacheFile injection pattern)
   *   vramBytesOf?: (device: object) => number|null,  // M4-D: VRAM source for
   *                                   // the display-name suffix (the sysinfo
   *                                   // cache in main.js; null = plain name)
   *   adapterMemoryInfoOf?: (device: object) => object|null, // synchronous
   *                                   // DXGI dedicated/shared capacity source
   *   sharedMemoryBytesOf?: (device: object) => number|object|null, // synchronous
   *                                   // shared-capacity fallback seam
   *   laptopInfoOf?: () => object|null,  // M17c: the laptop sysinfo provider
   *                                   // ({ manufacturer, model, pcSystemType,
   *                                   // chassisTypes } from the CIM query -
   *                                   // the cached sysinfo in main.js; null
   *                                   // on desktops) - the getCapabilities
   *                                   // AIB decode's laptop branch feeds on
   *                                   // it (the vramBytesOf injection pattern)
   *   sharedMemoryOverride?: object|null, // DxgKrnl shared GPU/NPU memory
   *                                   // registry adapter; omitted in native
   *                                   // test fakes and created for product use
   *   systemInfoOf?: () => object|null, // trusted cached CPU/RAM snapshot
   * }} opts
   */
  constructor(opts = {}) {
    this.kind = 'igcl';
    this._dllPath = opts.dllPath ?? null;
    this._allowAutoWaiver = opts.allowAutoWaiver === true;
    this._lib = opts.lib ?? null;
    this._findDll = opts.findDll ?? findIgclDll;
    this._extended = opts.extended ?? null;
    // M48: an explicit Sysman seam owns the W-unit Advanced extension. The
    // absent-option case preserves older injected backends whose aggregate
    // V1 capability was the only available contract.
    this._hasSysmanCapabilitySeam = Object.prototype.hasOwnProperty.call(opts, 'sysmanPowerLimits')
      || Object.prototype.hasOwnProperty.call(opts, 'sysmanPowerCapable');
    this._sysmanPowerLimits = opts.sysmanPowerLimits ?? null;
    this._sysmanPowerCapable = opts.sysmanPowerCapable;
    // runs the sysinfo cache BEFORE constructing the backend, so the lookup
    // is available at enumeration time; setVramBytesOf re-formats an already
    // enumerated device list).
    this._vramBytesOf = typeof opts.vramBytesOf === 'function' ? opts.vramBytesOf : null;
    this._adapterMemoryInfoOf = typeof opts.adapterMemoryInfoOf === 'function' ? opts.adapterMemoryInfoOf : null;
    this._sharedMemoryBytesOf = typeof opts.sharedMemoryBytesOf === 'function' ? opts.sharedMemoryBytesOf : null;
    // M17c: the laptop sysinfo provider (the cached CIM laptop fields) - the
    // vramBytesOf injection pattern; null on desktops (the subsystem decode
    // then stays authoritative).
    this._laptopInfoOf = typeof opts.laptopInfoOf === 'function' ? opts.laptopInfoOf : null;
    this._systemInfoOf = typeof opts.systemInfoOf === 'function' ? opts.systemInfoOf : null;
    // Intel Graphics Software stores the integrated shared-memory limit in
    // DxgKrnl's MemoryManager key rather than in IGCL's 3D feature table.
    // Keep the adapter injectable so tests never touch the real registry.
    this._sharedMemoryOverride = Object.prototype.hasOwnProperty.call(opts, 'sharedMemoryOverride')
      ? opts.sharedMemoryOverride
      : (opts.lib ? null : createSharedMemoryOverride());
    // Injected native libraries are test seams. They must never cause a test
    // to query or write the real Windows registry; a product backend without
    // an injected lib gets the real, identity-resolved fallback instead.
    this._vrrRegistry = Object.prototype.hasOwnProperty.call(opts, 'vrrRegistry')
      ? opts.vrrRegistry
      : (opts.lib ? null : createVrrRegistry());
    this._ocMode = opts.ocMode === 'advanced' ? 'advanced' : 'stock';
    // Stock/Advanced is a tuning-surface preference, not a process-global
    // GPU setting. Keep a separate mode for each enumerated adapter so
    // changing an Alchemist card cannot rebuild Battlemage's limits (or the
    // other way around). `_ocMode` remains the legacy/default fallback.
    this._ocModeByDevice = new Map();
    this._apiHandle = null;
    this._levelZeroOk = false;
    this._igscFullOk = null;
    this._initError = null;
    this._devices = null;
    this._caps = new Map(); // deviceId -> Capabilities
    this._ocUnits = new Map(); // deviceId -> {field -> CTL_UNITS}
    this._fanHandles = new Map(); // deviceId -> [handles]
    this._fanPreferredHandle = new Map(); // deviceId -> handle with control-capable properties
    this._waiverAccepted = new Map(); // deviceId -> bool
    this._telemetryCbs = new Map(); // deviceId -> Set<cb>
    this._activity = new Map(); // M3-C-L: deviceId -> { t, counter } for the utilPct delta method
    // M3-D: the fan-capability probe cache - deviceId -> Promise<{probeOk,
    // writeAccepted, fixedOk}>. DEDICATED: the caps cache is invalidated by
    // ocMode flips (setOcMode), the probe result must NOT be (the card's write
    // acceptance does not change with the app's OC mode). Promise-keyed so
    // concurrent first caps reads share ONE probe - never a double probe.
    // M4-C: the fixed-write sub-probe (reversible 50% write) runs INSIDE the
    // same probe, so the whole shape is one promise per device per session.
    this._fanProbeCache = new Map();
    this._fanProbeEnabled = opts.fanProbe !== false;
    // M17p: the persisted fan-probe cache file (the findIgclDll
    // opts.cacheFile injection pattern - tests inject a temp file; null =
    // the default %APPDATA%\ArcPower\fan-probe-cache.json, resolved at the
    // first probe).
    this._fanProbeCacheFile = typeof opts.fanProbeCacheFile === 'string' ? opts.fanProbeCacheFile : null;
    // M8 (the Graphics tab): the per-device 3D-feature caps cache (the
    // supported-feature table from ctlGetSupported3DCapabilities - stable
    // per driver/device; the VALUES are never cached, every read is fresh).
    this._graphicsCapsCache = new Map();
    // M17c: the session refused-ceiling store (Map<deviceId, Map<control,
    // ceiling>>). The PARENT-side recording: the parent's getCapabilities
    // merges it (both the cache-hit and cold paths); the WORKER's own store
    // is useless (module state evaporates), so the parent records from the
    // worker's result envelope (recordApplyRefusals).
    this._refusedCeilings = createRefusedCeilingStore();
    // M17c: per-device flags for the ONCE-PER-SESSION temperature-sensor
    // degrade note (the N4-style honest note must not spam every tick).
    this._tempSensorDegradeNoted = new Set();
    // M17c (step-5 N2): the per-device NO-SENSOR verdict latch - a device
    // whose temperature fallback probe failed (no sensor / enum failure /
    // read failure) is marked so the native churn (enum probe + fill +
    // per-sensor ctlTemperatureGetProperties + state read) stops after the
    // FIRST failed probe instead of re-running every 500 ms telemetry tick;
    // a device that HAS a sensor is never latched and keeps reading.
    this._tempSensorNoSensor = new Set();
    // M10b (the Graphics "Display" view): the per-device display-output
    // handles cache (ctlEnumerateDisplayOutputs - stable per session like
    // the fan handles; the per-display VALUES are never cached, every
    // getDisplaySettings reads fresh).
    this._displayHandles = new Map();
    // Keep the complete color state only after a verified pixel-transform
    // write. A fresh process never assumes that the driver's transform is
    // neutral; the GET path establishes that before exposing a writable row.
    this._displayPixelColors = new Map();
  }

  /**
   * M3-C-E: switch the OC mode and invalidate the selected device's caps
   * cache. A missing device id keeps the legacy/default mode for callers
   * that do not yet have an inventory target.
   * @param {'stock'|'advanced'} mode
   * @param {number|null|undefined} [deviceId]
   * @returns {'stock'|'advanced'}
   */
  setOcMode(mode, deviceId = null) {
    const next = mode === 'advanced' ? 'advanced' : 'stock';
    if (Number.isInteger(deviceId) && deviceId >= 0) {
      this._ocModeByDevice.set(deviceId, next);
      this._caps.delete(deviceId);
      return next;
    }
    if (next !== this._ocMode) {
      this._ocMode = next;
      this._caps.clear();
    }
    return next;
  }

  _ocModeFor(deviceId) {
    return this._ocModeByDevice.get(deviceId) ?? this._ocMode;
  }

  /**
   * 1.0.1 no-Intel round: the init-class failure - null when init()
   * succeeded (or never ran). The list-devices IPC handler degrades to an
   * EMPTY list ONLY when this is set (an AMD machine: the IGCL runtime DLL
   * is missing, ctlInit fails, or device enumeration fails) - any other
   * list-devices throw stays a hard IPC failure.
   * @returns {Error | null}
   */
  get initError() {
    return this._initError ?? null;
  }

  _libOrThrow() {
    if (!this._lib) throw new Error('backend not initialized (call init() first)');
    return this._lib;
  }

  _isUnavailable(fn) {
    return typeof fn !== 'function';
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async init() {
    if (this._apiHandle) return;
    if (this._initError) throw this._initError;
    try {
      if (!this._lib) {
        this._dllPath = this._dllPath ?? this._findDll();
        if (!this._dllPath) {
          throw new Error(
            'IGCL runtime DLL not found. Scanned DriverStore (iigd_dch_d.inf_amd64_*) by active driver version; no fallback matched. See docs/igcl-integration.md §1.',
          );
        }
        this._lib = loadIgcl(this._dllPath);
      }
      const lib = this._lib;
      if (this._isUnavailable(lib.ctlInit)) {
        throw new Error('ctlInit symbol unavailable in the IGCL runtime - driver too old or wrong DLL loaded.');
      }
      const initArgs = koffi.alloc('ctl_init_args_t', 1);
      const apiHandleBuf = koffi.alloc('void*', 1);
      const encodeInitArgs = (flags) => koffi.encode(initArgs, 'ctl_init_args_t', {
        Size: koffi.sizeof('ctl_init_args_t'),
        Version: 0,
        AppVersion: makeVersion(1, 1),
        flags,
        SupportedVersion: 0,
        ApplicationUID: ZERO_UID,
      });
      const closeFailedHandle = () => {
        const failedHandle = koffi.decode(apiHandleBuf, 0, 'void*');
        if (failedHandle && typeof lib.ctlClose === 'function') {
          try { lib.ctlClose(failedHandle); } catch { /* best effort */ }
        }
        koffi.encode(apiHandleBuf, 0, 'void*', 0n);
      };
      const initWithFlags = (flags) => {
        encodeInitArgs(flags);
        koffi.encode(apiHandleBuf, 0, 'void*', 0n);
        return lib.ctlInit(initArgs, apiHandleBuf);
      };
      let result = initWithFlags(CTL_INIT_FLAG_USE_LEVEL_ZERO | CTL_INIT_FLAG_IGSC_FUL);
      if ((result >>> 0) === CTL_RESULT.ERROR_IGSC_LOADER) {
        // A missing Intel Graphics Software loader must not take down the
        // Level-Zero telemetry/OC path. If a broken runtime returned a handle
        // alongside the refusal, release it before the one permitted retry.
        closeFailedHandle();
        result = initWithFlags(CTL_INIT_FLAG_USE_LEVEL_ZERO);
        this._igscFullOk = false;
      } else {
        this._igscFullOk = result === CTL_RESULT.SUCCESS;
      }
      if (result !== CTL_RESULT.SUCCESS) {
        if ((result >>> 0) === CTL_RESULT.ERROR_ZE_LOADER) {
          throw new Error('ctlInit failed: Level Zero loader (ze_loader.dll) not resolvable (CTL_RESULT_ERROR_ZE_LOADER).');
        }
        if ((result >>> 0) === CTL_RESULT.ERROR_UNKNOWN_APPLICATION_UID) {
          throw new Error('ctlInit failed: application UID rejected (ERROR_UNKNOWN_APPLICATION_UID). The DriverStore runtime accepts the zero UID; a ControlLib.dll loader may have been picked instead.');
        }
        throw new Error(`ctlInit failed: ${describeResult(result)}`);
      }
      this._apiHandle = koffi.decode(apiHandleBuf, 0, 'void*');
      if (!this._apiHandle) throw new Error('ctlInit returned SUCCESS but the API handle is NULL.');
      this._levelZeroOk = true;
    } catch (err) {
      this._initError = err;
      throw err;
    }
  }

  async close() {
    this._telemetryCbs.clear();
    if (this._apiHandle && this._lib && typeof this._lib.ctlClose === 'function') {
      try { this._lib.ctlClose(this._apiHandle); } catch { /* best effort */ }
    }
    this._apiHandle = null;
  }

  // -------------------------------------------------------------------------
  // Devices + capabilities
  // -------------------------------------------------------------------------

  /**
   * 1.0.1 no-Intel round: record an ENUMERATION failure as an init-CLASS
   * failure (initError) before rethrowing - ctlEnumerateDevices /
   * ctlGetDeviceProperties failing means the backend cannot enumerate any
   * usable GPU, which is the same no-Intel degrade the list-devices IPC
   * maps to [] (health then reports igclLoaded false). Never overwrites a
   * real init failure.
   * @param {Error} err
   */
  _enumFail(err) {
    if (!this._initError) this._initError = err;
    throw err;
  }

  async _ensureDevices() {
    if (this._devices) return this._devices;
    await this.init();
    const lib = this._libOrThrow();
    const api = this._apiHandle;

    const countBuf = koffi.alloc('uint32', 1);
    koffi.encode(countBuf, 'uint32', 0);
    let result = lib.ctlEnumerateDevices(api, countBuf, null);
    if (result !== CTL_RESULT.SUCCESS) {
      this._enumFail(new Error(`ctlEnumerateDevices(count) failed: ${describeResult(result)}`));
    }
    const count = koffi.decode(countBuf, 'uint32');
    const devices = [];
    if (count === 0) return (this._devices = devices);

    const handlesBuf = koffi.alloc('void*', count);
    koffi.encode(countBuf, 'uint32', count);
    result = lib.ctlEnumerateDevices(api, countBuf, handlesBuf);
    if (result !== CTL_RESULT.SUCCESS) {
      this._enumFail(new Error(`ctlEnumerateDevices(fill) failed: ${describeResult(result)}`));
    }

    for (let i = 0; i < count; i++) {
      const handle = koffi.decode(handlesBuf, i * 8, 'void*');
      const propsBuf = koffi.alloc('ctl_device_adapter_properties_t', 1);
      koffi.encode(propsBuf, 'ctl_device_adapter_properties_t', { Size: koffi.sizeof('ctl_device_adapter_properties_t'), Version: 3 });
      result = lib.ctlGetDeviceProperties(handle, propsBuf);
      if (result !== CTL_RESULT.SUCCESS) {
        this._enumFail(new Error(`ctlGetDeviceProperties(${i}) failed: ${describeResult(result)}`));
      }
      const p = koffi.decode(propsBuf, 'ctl_device_adapter_properties_t');
      // M4-B/M4-D: VRAM source - the bundled bindings expose NO memory-size
      // field (verified against igcl-bindings.js + docs/igcl-integration.md:
      // no MEMORY_BYTES surface exists in the bound structs), so the REAL
      // backend gets its vramBytes from the M4-D sysinfo cache
      // (Win32_VideoController AdapterRAM) through the injected vramBytesOf
      // provider: formatDeviceName appends the "16 GB" suffix when the
      // lookup matches the IGCL device name (GPU-family token match, else
      // the primary non-basic adapter) and the AdapterRAM value is
      // trustworthy. Honest null when unmatched - the plain IGCL name. A
      // future ctlGetMemoryInfo binding would land here as a better source.
      const plainName = (p.name || '').replace(/\0+$/, '');
      const mobile = /\b(?:A|B)\d{3,4}M\b|\bB(?:370|390)\b|\bMobile\b/i.test(plainName);
      const integrated = (Number(p.graphics_adapter_properties) & CTL_ADAPTER_PROPERTIES_FLAG.INTEGRATED) !== 0
        || isIntegratedStyleDevice({ name: plainName });
      const dev = {
        id: i,
        handle,
        name: plainName,
        type: 'GRAPHICS',
        pciVendorId: `0x${(Number(p.pci_vendor_id) >>> 0).toString(16).padStart(8, '0')}`,
        pciDeviceId: `0x${(Number(p.pci_device_id) >>> 0).toString(16).padStart(8, '0')}`,
        revId: p.rev_id,
        bdf: { bus: p.adapter_bdf.bus, device: p.adapter_bdf.device, function: p.adapter_bdf.function },
        driverVersion: '0x' + p.driver_version.toString(16).padStart(16, '0'),
        graphicsClockMHz: p.Frequency,
        numXeCores: p.num_xe_cores,
        integrated,
        mobile,
        vramBytes: null,
        // M17c: the ALREADY-BOUND IGCL subsystem fields (igcl-bindings.js:
        // 217-218 - pci_subsys_vendor_id / pci_subsys_id, a 1:1 mapping to
        // the PNP SUBSYS_60011849 fields, exact per device). Carried on the
        // device payload (listDevices + the caps decode); the pure/aib.ts
        // decode keys on them - NO CIM/name-match dependency. Null when the
        // struct reports 0 (the iGPU / unknown-board shape).
        pciSubsysVendorId: p.pci_subsys_vendor_id || null,
        pciSubsysId: p.pci_subsys_id || null,
        // M4-I (S1): the memory type is derived ONCE from the token table
        // (vramMemTypeOfName - A-series + B-series = GDDR6, unknown ->
        // null) and CARRIED on the device payload (DeviceInfo + caps); the
        // renderer's VRAM row never re-derives it.
        memType: vramMemTypeOfName(plainName),
      };
      // Internal-only: the pre-suffix name (setVramBytesOf re-formats from
      // it) - never surfaced by listDevices (it destructures explicit fields).
      dev._plainName = plainName;
      this._refreshMemoryInfo(dev);
      dev.name = formatDeviceName(plainName, dev.vramBytes);
      devices.push(dev);
    }
    const ordered = sortDevicesDiscreteFirst(devices);
    ordered.forEach((dev, id) => {
      dev.id = id;
      dev.deviceKey = deviceHardwareKey(dev);
    });
    return (this._devices = ordered);
  }

  /**
   * M4-D: inject (or replace) the VRAM provider AFTER construction and
   * re-format the already-enumerated device names in place. The constructor
   * opt is the main.js path (sysinfo runs before the backend exists); the
   * setter exists for tests + late wiring.
   * @param {(device: object) => number | null} fn
   */
  setVramBytesOf(fn) {
    this._vramBytesOf = typeof fn === 'function' ? fn : null;
    if (this._devices) {
      for (const dev of this._devices) {
        this._refreshMemoryInfo(dev);
        dev.name = formatDeviceName(dev._plainName ?? dev.name, dev.vramBytes);
      }
    }
  }

  _refreshMemoryInfo(dev) {
    const validBytes = (value) => Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : null;
    let info = null;
    try { info = this._adapterMemoryInfoOf ? this._adapterMemoryInfoOf(dev) : null; } catch { info = null; }
    const dedicatedFromDxgi = validBytes(info?.dedicatedVideoMemoryBytes);
    // DXGI reports the adapter's actual dedicated segment size.  The WMI /
    // registry value is retained as a fallback because older drivers can
    // omit the DXGI descriptor, but it may under-report Battlemage cards
    // (11 GiB shown for a 12 GiB B580).
    const dedicatedFromVram = validBytes(this._vramBytesOf ? this._vramBytesOf(dev) : null);
    dev.vramBytes = dedicatedFromDxgi ?? dedicatedFromVram;
    dev.sharedMemoryBytes = null;
    dev.sharedMemorySource = null;
    // Shared capacity is not VRAM. It is eligible only for an explicitly
    // integrated/mobile adapter, and only while dedicated capacity is absent.
    if (dev.vramBytes === null && (dev.integrated === true || dev.mobile === true)) {
      let shared = validBytes(info?.sharedSystemMemoryBytes);
      let source = shared === null ? null : 'dxgi';
      if (shared === null && this._sharedMemoryBytesOf) {
        let provided = null;
        try { provided = this._sharedMemoryBytesOf(dev); } catch { provided = null; }
        if (typeof provided === 'object' && provided !== null) {
          shared = validBytes(provided.bytes ?? provided.sharedMemoryBytes ?? provided.sharedSystemMemoryBytes);
          source = shared === null ? null : (typeof provided.source === 'string' ? provided.source : 'provider');
        } else {
          shared = validBytes(provided);
          source = shared === null ? null : 'provider';
        }
      }
      dev.sharedMemoryBytes = shared;
      dev.sharedMemorySource = source;
    }
  }

  /** Install the synchronous DXGI dedicated/shared capacity provider. */
  setAdapterMemoryInfoOf(fn) {
    this._adapterMemoryInfoOf = typeof fn === 'function' ? fn : null;
    if (this._devices) {
      for (const dev of this._devices) {
        this._refreshMemoryInfo(dev);
        dev.name = formatDeviceName(dev._plainName ?? dev.name, dev.vramBytes);
      }
    }
  }

  /** Install a synchronous shared-capacity provider used only for
   * explicitly integrated/mobile devices without dedicated capacity. */
  setSharedMemoryBytesOf(fn) {
    this._sharedMemoryBytesOf = typeof fn === 'function' ? fn : null;
    if (this._devices) for (const dev of this._devices) this._refreshMemoryInfo(dev);
  }

  async listDevices() {
    const devices = await this._ensureDevices();
    return devices.map(({ id, name, type, pciVendorId, pciDeviceId, revId, bdf, driverVersion, graphicsClockMHz, numXeCores, integrated, mobile, vramBytes, sharedMemoryBytes, sharedMemorySource, memType, pciSubsysVendorId, pciSubsysId, deviceKey }) => ({
      id, name, type, pciVendorId, pciDeviceId, revId, bdf, driverVersion, graphicsClockMHz, numXeCores, integrated, mobile, vramBytes, sharedMemoryBytes, sharedMemorySource, memType, pciSubsysVendorId, pciSubsysId, deviceKey,
    }));
  }

  async _device(deviceId) {
    const devices = await this._ensureDevices();
    const dev = devices[deviceId];
    if (!dev) throw new Error(`unknown device id ${deviceId}`);
    return dev;
  }

  /**
   * M4-D2 ("read the driver's BAR state"): the driver's PCI
   * properties via ctlPciGetProperties - resizable_bar_supported /
   * resizable_bar_enabled (the same driver state IGS + GPU-Z report).
   * Read-only, unelevated. Degrades to null on any failure (unbound
   * symbol, ctl error, garbage) - the sysinfo layer falls back to the OS
   * resource check then.
   * @param {number} deviceId
   * @returns {Promise<{
   *   domain: number, bus: number, device: number, function: number,
   *   gen: number, width: number, maxBandwidth: number,
   *   resizableBarSupported: boolean, resizableBarEnabled: boolean
   * } | null>}
   */
  async pciProperties(deviceId) {
    try {
      const lib = this._libOrThrow();
      if (this._isUnavailable(lib.ctlPciGetProperties)) return null;
      const dev = await this._device(deviceId);
      const buf = koffi.alloc('uint8', 64);
      // Size MUST be the DRIVER's real struct size (64) - koffi's own
      // sizeof is 72 (8-align tail padding that the driver build lacks);
      // a 72 would answer ERROR_INVALID_SIZE (live-verified).
      koffi.encode(buf, 0, 'uint32', 64);
      koffi.encode(buf, 4, 'uint8', 0);
      const result = lib.ctlPciGetProperties(dev.handle, buf);
      if (result !== CTL_RESULT.SUCCESS) return null;
      return decodePciProperties(buf);
    } catch {
      return null;
    }
  }

  async _fanHandlesOf(deviceId) {
    if (this._fanHandles.has(deviceId)) return this._fanHandles.get(deviceId);
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const handles = [];
    if (!this._isUnavailable(lib.ctlEnumFans)) {
      const countBuf = koffi.alloc('uint32', 1);
      koffi.encode(countBuf, 'uint32', 0);
      let result = lib.ctlEnumFans(dev.handle, countBuf, null);
      const count = koffi.decode(countBuf, 'uint32');
      if (result === CTL_RESULT.SUCCESS && count > 0) {
        const fanBuf = koffi.alloc('void*', count);
        koffi.encode(countBuf, 'uint32', count);
        result = lib.ctlEnumFans(dev.handle, countBuf, fanBuf);
        if (result === CTL_RESULT.SUCCESS) {
          for (let i = 0; i < count; i++) handles.push(koffi.decode(fanBuf, i * 8, 'void*'));
        }
      }
    }
    this._fanHandles.set(deviceId, handles);
    return handles;
  }

  /**
   * Battlemage boards can enumerate more than one fan handle. The first
   * handle is not guaranteed to be the writable controller, so prefer a
   * handle whose properties explicitly advertise control and retain the
   * first handle as the honest read-only fallback for telemetry/config reads.
   */
  async _fanHandleForControl(deviceId) {
    if (this._fanPreferredHandle.has(deviceId)) return this._fanPreferredHandle.get(deviceId);
    const handles = await this._fanHandlesOf(deviceId);
    if (handles.length === 0) return null;
    const lib = this._libOrThrow();
    if (this._isUnavailable(lib.ctlFanGetProperties)) {
      this._fanPreferredHandle.set(deviceId, handles[0]);
      return handles[0];
    }
    for (const handle of handles) {
      try {
        const buf = koffi.alloc('ctl_fan_properties_t', 1);
        koffi.encode(buf, 'ctl_fan_properties_t', { Size: koffi.sizeof('ctl_fan_properties_t'), Version: 0 });
        if (lib.ctlFanGetProperties(handle, buf) === CTL_RESULT.SUCCESS
          && koffi.decode(buf, 'ctl_fan_properties_t').canControl === true) {
          this._fanPreferredHandle.set(deviceId, handle);
          return handle;
        }
      } catch { /* try the next enumerated fan */ }
    }
    this._fanPreferredHandle.set(deviceId, handles[0]);
    return handles[0];
  }

  /**
   * M3-D: the fan-capability probe cache accessor - deviceId ->
   * Promise<{probeOk: boolean, writeAccepted: boolean, fixedOk: boolean}>
   * (M4-C: the fixed-write sub-probe extends the shape - one probe per
   * device per session for the table AND the fixed path). The DEDICATED
   * promise-keyed cache lives OUTSIDE the caps cache: concurrent first
   * calls share ONE probe promise (never a double probe) and ocMode flips
   * never re-probe (the card's write acceptance does not change with the
   * app's OC mode). A throwing probe degrades to probeOk=false +
   * writeAccepted=false + fixedOk=false - the fan stays read-only, never a
   * hard crash of getCapabilities. `maxPoints` (fan properties) sizes the
   * sample table (F3); the same device always reports the same value, so it
   * is safe under the deviceId-keyed cache.
   * @param {number} deviceId
   * @param {number} [maxPoints]
   * @returns {Promise<{ probeOk: boolean, writeAccepted: boolean, fixedOk: boolean }>}
   */
  async _probeFanCapability(deviceId, maxPoints, fanProperties = null) {
    if (this._fanProbeCache.has(deviceId)) return this._fanProbeCache.get(deviceId);
    // M17p: the PERSISTED cache - SUCCESS-ONLY trust: a cached
    // probeOk:true for THIS driverVersion+deviceId skips the probe across
    // boots (the ~400-480 ms probe cost disappears on probe-SUCCESS
    // machines); a cached failure is never trusted - the probe re-runs
    // every boot (the verdict flips with the IGS service state).
    const cached = await this._cachedFanProbe(deviceId);
    // The re-check: a CONCURRENT first caller may have landed (and cached
    // its promise) while this call awaited the persisted-cache read - the
    // M3-D share-ONE-probe contract must hold (never a double probe).
    if (this._fanProbeCache.has(deviceId)) return this._fanProbeCache.get(deviceId);
    if (cached) {
      const p = Promise.resolve(cached);
      this._fanProbeCache.set(deviceId, p);
      return p;
    }
    const p = this._runFanProbe(deviceId, maxPoints, fanProperties).catch((err) => {
      console.error(`[igcl-backend] fan capability probe threw for device ${deviceId}: ${err.message} - fan stays read-only`);
      return { probeOk: false, writeAccepted: false, fixedOk: false };
    });
    this._fanProbeCache.set(deviceId, p);
    // M17p: SUCCESS-ONLY + versioned persistence - only a verified success
    // of the CURRENT probe logic is written (a failure writes nothing and
    // re-probes next boot; an old-version success re-probes too - the
    // probeVersion key gates it). The write itself is best-effort - a cache
    // failure never breaks the probe path.
    void p.then((result) => {
      if (result?.probeOk === true) this._persistFanProbeCache(deviceId, result);
    });
    return p;
  }

  /**
   * M17p: the persisted-cache READ (SUCCESS-ONLY + probe-versioned).
   * Returns the cached verdict ONLY when the entry is a probeOk:true
   * success from the CURRENT probe logic (probeVersion matches
   * FAN_PROBE_VERSION - an OLD probe-logic entry is never trusted, the
   * fallback capability changes with the probe code) for THIS device's
   * driverVersion + deviceId (a missing / corrupt / mismatched / failed
   * entry is a miss - the probe re-runs and re-persists on success).
   * Never throws (the read is best-effort).
   * @param {number} deviceId
   * @returns {Promise<{ probeOk: boolean, writeAccepted: boolean, fixedOk: boolean } | null>}
   */
  async _cachedFanProbe(deviceId) {
    try {
      const devices = await this._ensureDevices();
      const dev = devices[deviceId];
      const driverVersion = typeof dev?.driverVersion === 'string' && dev.driverVersion ? dev.driverVersion : null;
      if (!driverVersion) return null;
      const cacheFile = this._fanProbeCacheFile ?? fanProbeCacheFile();
      const entry = readFanProbeCache(cacheFile);
      if (!entry || entry.probeOk !== true) return null; // SUCCESS-ONLY
      if (entry.probeVersion !== FAN_PROBE_VERSION) return null; // the probe-logic version (an old entry never trusted)
      const deviceKey = typeof dev?.deviceKey === 'string' ? dev.deviceKey : deviceHardwareKey(dev);
      if (entry.driverVersion !== driverVersion || entry.deviceKey !== deviceKey) return null; // stable identity + driver are mandatory
      return {
        probeOk: true,
        writeAccepted: entry.writeAccepted === true,
        fixedOk: entry.fixedOk === true,
      };
    } catch {
      return null; // a cache read failure never blocks the probe
    }
  }

  /**
   * M17p: the SUCCESS-ONLY persistence write - { driverVersion, deviceId,
   * probeVersion, probeOk, writeAccepted, fixedOk } in the single-entry
   * cache file (the last successful probe wins). A failure writes nothing
   * and never deletes (the stale entry stays inert - the key checks keep
   * it a miss). Best-effort: a write failure never breaks the probe path.
   * @param {number} deviceId
   * @param {{ probeOk: boolean, writeAccepted: boolean, fixedOk: boolean }} result
   * @returns {Promise<void>}
   */
  async _persistFanProbeCache(deviceId, result) {
    try {
      const devices = await this._ensureDevices();
      const dev = devices[deviceId];
      const driverVersion = typeof dev?.driverVersion === 'string' && dev.driverVersion ? dev.driverVersion : null;
      if (!driverVersion) return;
      const cacheFile = this._fanProbeCacheFile ?? fanProbeCacheFile();
      const deviceKey = typeof dev?.deviceKey === 'string' ? dev.deviceKey : deviceHardwareKey(dev);
      writeFanProbeCache(cacheFile, {
        driverVersion,
        deviceId,
        deviceKey,
        probeVersion: FAN_PROBE_VERSION,
        probeOk: result.probeOk === true,
        writeAccepted: result.writeAccepted === true,
        fixedOk: result.fixedOk === true,
      });
    } catch {
      // a failed persistence never breaks the probe path
    }
  }

  /**
   * M3-D: the reversible fan-capability probe (the Alchemist unlock,
   * live-verified on the A770 2026-08-06). The driver reports
   * canControl=false but honors table/default writes when the table uses
   * the FAN enum's PERCENT units (1 - NOT the general CTL_UNITS.PERCENT 11;
   * that was why earlier probes failed) and Intel's sample encoding
   * (Size/Version filled, points ascending). Probe = write a safe 0-90%
   * sample table of min(10, maxPoints) points (F3: a maxPoints<10 card
   * would otherwise stay read-only despite accepting tables), read back +
   * verify exact point match, restore default mode, verify. The restore is
   * retried on failure - a failed probe must NEVER leave the card in table
   * mode (a stuck table mode is itself treated as probe failure with an
   * honest retry/report). The write outcome decides honesty - the probe is
   * NOT gated on elevation (non-elevated writes fail -> read-only), and
   * writeAccepted (the table write succeeded, F2) is reported separately
   * from probeOk (full verify passed) so the caller can keep the real
   * modes for a card that demonstrably accepts tables even when a later
   * step failed (stuck restore, IGS reapply race).
   *
   * M4-C: the fixed-write sub-probe extends the shape with `fixedOk`. It
   * runs INSIDE this probe (same promise-keyed cache - one per device per
   * session, never a re-probe per caps read) and ONLY when the table path
   * is available: after the table restore succeeded. A refused table write
   * tells us nothing about fixed writes and a stuck table mode must never
   * be left behind - so the fixed sub-probe never runs independently.
   * M20-B: `fixedOk` = one reversible 50% write + read-back verify +
   * restore to default mode (the SAME restore-retry semantics: a failed
   * restore is a probe failure - the fan must NEVER be left at 50% fixed).
   * The dedicated ctlFanSetFixedSpeedMode write is the primary; when it is
   * unavailable or refuses with ERROR_UNSUPPORTED_FEATURE /
   * ERROR_NOT_AVAILABLE (the live A770 verdict), the FLAT-TABLE fallback
   * (a 2-point flat 50% table via ctlFanSetSpeedTableMode - the IGS/Acer
   * Alchemist mechanism) is the honest fixed route. Only a fully verified
   * fixed probe (either path) adds 'fixed' to the learned modes.
   * @param {number} deviceId
   * @param {number} [maxPoints]  fan properties' maxPoints (default 10)
   * @returns {Promise<{ probeOk: boolean, writeAccepted: boolean, fixedOk: boolean }>}
   */
  async _runFanProbe(deviceId, maxPoints, fanProperties = null) {
    const lib = this._libOrThrow();
    const fanHandles = await this._fanHandlesOf(deviceId);
    const fan = await this._fanHandleForControl(deviceId);
    if (!fan || this._isUnavailable(lib.ctlFanSetSpeedTableMode)
      || this._isUnavailable(lib.ctlFanSetDefaultMode)
      || this._isUnavailable(lib.ctlFanGetConfig)) {
      return { probeOk: false, writeAccepted: false, fixedOk: false };
    }

    if (!fanProperties && !this._isUnavailable(lib.ctlFanGetProperties)) {
      const propBuf = koffi.alloc('ctl_fan_properties_t', 1);
      koffi.encode(propBuf, 'ctl_fan_properties_t', { Size: koffi.sizeof('ctl_fan_properties_t'), Version: 0 });
      if (lib.ctlFanGetProperties(fan, propBuf) === CTL_RESULT.SUCCESS) fanProperties = koffi.decode(propBuf, 'ctl_fan_properties_t');
    }

    // The table/fixed control ABI is independent of the state-unit bitmask.
    // Arc boards commonly report RPM-only properties but accept the FAN
    // enum's PERCENT table encoding.
    const fanUnits = FAN_CONTROL_UNITS;
    const maxRpm = Number(fanProperties?.maxRPM);

    // Intel's sample encoding: Size/Version filled, FAN-enum PERCENT units,
    // strictly ascending temps, safe speeds 0-90%. Point count honors
    // the card's maxPoints (capped at the live-verified 10-point sample).
    const pointCount = Number.isInteger(maxPoints) && maxPoints > 0 ? Math.min(10, maxPoints) : 10;
    const expected = [];
    for (let i = 0; i < pointCount; i++) expected.push({ t: 20 + i * 8, speedPct: i * 10 });
    const table = expected.map((p) => ({
      Size: koffi.sizeof('ctl_fan_temp_speed_t'),
      Version: 0,
      temperature: p.t,
      speed: { Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: fanSpeedFromPct(p.speedPct, fanUnits, maxRpm), units: fanUnits },
    }));
    const tableObj = { Size: koffi.sizeof('ctl_fan_speed_table_t'), Version: 0, numPoints: table.length, table };

    const setResult = lib.ctlFanSetSpeedTableMode(fan, tableObj);
    const writeAccepted = setResult === CTL_RESULT.SUCCESS;
    if (!writeAccepted) {
      // The write itself failed: the card was never put in table mode, so
      // no restore is needed - the refusal IS the honest answer. The fixed
      // sub-probe never runs here (a refused table write tells us nothing
      // about fixed writes).
      console.error(`[igcl-backend] fan probe: ctlFanSetSpeedTableMode refused (${describeResult(setResult)}) - fan stays read-only`);
      return { probeOk: false, writeAccepted, fixedOk: false };
    }

    // Read-back verify: exact point match in the native unit, normalized to %.
    let readOk = false;
    const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
    koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
    const getResult = lib.ctlFanGetConfig(fan, cfgBuf);
    if (getResult === CTL_RESULT.SUCCESS) {
      const cfg = koffi.decode(cfgBuf, 'ctl_fan_config_t');
      readOk = cfg.mode === 2 /* TABLE */
        && cfg.speedTable.numPoints === expected.length
        && expected.every((p, i) => {
          const tp = cfg.speedTable.table[i];
          return tp.speed.units === fanUnits
            && nearlyEqual(tp.temperature, p.t, 1)
            && nearlyEqual(fanPctFromSpeed(tp.speed.speed, tp.speed.units, maxRpm), p.speedPct, 1);
        });
    }
    if (!readOk) {
      console.error('[igcl-backend] fan probe: table read-back did not match the sample - probe fails');
    }

    // Restore default mode, retried: a failed probe must NEVER leave the
    // card in table mode.
    const restoreOk = await this._restoreFanDefault(fan, deviceId, fanUnits, maxRpm);

    const probeOk = readOk && restoreOk;
    console.log(`[igcl-backend] fan probe device ${deviceId}: table write ${writeAccepted ? 'accepted' : 'refused'}, read-back ${readOk ? 'OK' : 'FAILED'}, restore-to-default ${restoreOk ? 'OK' : 'FAILED'} - effective canControl=${probeOk}`);

    // M4-C: the fixed-write sub-probe - ONLY when the table path is
    // available (the table restore succeeded): a stuck table mode must
    // never be left behind, and the fixed path is independent evidence.
    //
    // M4-C (round-1 review, confirmed interpretation): a failed FIXED
    // restore (the driver wedged at 50% fixed) does NOT downgrade whole-fan
    // canControl - probeOk stays true (the TABLE probe fully verified) and
    // the editor stays open: the table editor is the ONLY recovery path
    // (a curve apply issues ctlFanSetSpeedTableMode, which exits fixed
    // mode), so making the whole fan read-only would strand the user at 50%
    // fixed with no recourse. fixedOk=false is reported honestly in the
    // probe shape - the plan's "honest read-only" intent for the fixed
    // path. Reversibility is intact: the restore is always attempted after
    // a successful fixed write, retried twice, and verified DEFAULT-mode.
    //
    // M20-B: the F1 gate flip - the fixed sub-probe runs when the FIXED
    // symbol OR the TABLE path is available. On the Alchemist driver
    // (live-probed) ctlFanSetFixedSpeedMode refuses with
    // ERROR_UNSUPPORTED_FEATURE while the TABLE API works - the probe's
    // flat-table fallback (a flat 2-point table = a fixed speed) is the
    // honest fixed mechanism there. A card with NEITHER symbol still
    // honestly reports no fixed (the probe cannot run).
    let fixedOk = false;
    if (restoreOk && (!this._isUnavailable(lib.ctlFanSetFixedSpeedMode) || !this._isUnavailable(lib.ctlFanSetSpeedTableMode))) {
      fixedOk = await this._runFixedProbe(fan, deviceId, fanUnits, maxRpm);
    }
    return { probeOk, writeAccepted, fixedOk };
  }

  /**
   * M4-C: the fixed-write sub-probe - one reversible 50% write +
   * read-back verify (FIXED mode, PERCENT units, 50%) + restore to default
   * mode via ctlFanSetDefaultMode with the SAME restore-retry semantics as
   * the table probe (`_restoreFanDefault`: a failed restore is a probe
   * failure - the fan must NEVER be left at 50% fixed). Runs once per
   * device per session inside the SAME promise-keyed probe cache as the
   * table probe (never a re-probe per caps read; ocMode flips never
   * re-probe). `fixedOk` = write + read-back + restore all succeeded; a
   * refused write needs no restore (the card never entered fixed mode) and
   * is the honest `false`.
   *
   * M20-B: the Alchemist fallback - when the dedicated API is unavailable
   * or refuses with ERROR_UNSUPPORTED_FEATURE / ERROR_NOT_AVAILABLE (the
   * live A770 + driver 0x00200000006522a0 verdict: ctlFanSetFixedSpeedMode
   * returns 0x4000000A), Fixed = a FLAT speed table via
   * ctlFanSetSpeedTableMode (the IGS/Acer mechanism, live-proven on the
   * same card: flat 30% -> 210 RPM, flat 60% -> 1980 RPM, clean restore).
   * The fallback writes a 2-point flat 50% table (20C/100C, PERCENT units),
   * read-back verifies TABLE mode + every point 50% PERCENT within 1 +
   * numPoints >= 2, then restores via `_restoreFanDefault` - the fan is
   * never left in table mode. An unavailable table API keeps the honest
   * `fixedOk=false` (no flat-table probe possible). `fixedOk = readOk &&
   * restoreOk` on both paths.
   * @param {object} fan
   * @param {number} deviceId
   * @returns {Promise<boolean>}
   */
  async _runFixedProbe(fan, deviceId, fanUnits = FAN_CONTROL_UNITS, maxRpm = -1) {
    const lib = this._libOrThrow();
    const FIXED_PCT = 50;
    const fixed = { Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: fanSpeedFromPct(FIXED_PCT, fanUnits, maxRpm), units: fanUnits };
    // M20-B (F1): the PRIMARY write is guarded - an unavailable symbol
    // skips straight to the flat-table fallback, never a throw.
    let setResult;
    if (!this._isUnavailable(lib.ctlFanSetFixedSpeedMode)) {
      setResult = lib.ctlFanSetFixedSpeedMode(fan, fixed);
    }
    const writeAccepted = setResult === CTL_RESULT.SUCCESS;
    // M20-B: the flat-table fallback triggers on the unavailable symbol OR
    // the two refusal codes the Alchemist driver answers with; any OTHER
    // failure is the honest `false` (the card was never put in fixed mode,
    // so no restore is needed - the refusal IS the honest answer).
    const flatFallback = !writeAccepted
      && (setResult === undefined
        || setResult === CTL_RESULT.ERROR_UNSUPPORTED_FEATURE
        || setResult === CTL_RESULT.ERROR_NOT_AVAILABLE);
    if (!writeAccepted && !flatFallback) {
      console.error(`[igcl-backend] fixed fan probe: ctlFanSetFixedSpeedMode refused (${describeResult(setResult)}) - 'fixed' stays out of the learned modes`);
      return false;
    }

    if (writeAccepted) {
      // Read-back verify: FIXED mode + the driver's native unit + the 50% sample.
      let readOk = false;
      const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
      koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
      const getResult = lib.ctlFanGetConfig(fan, cfgBuf);
      if (getResult === CTL_RESULT.SUCCESS) {
        const cfg = koffi.decode(cfgBuf, 'ctl_fan_config_t');
        readOk = cfg.mode === 1 /* FIXED */
          && cfg.speedFixed.units === fanUnits
          && nearlyEqual(fanPctFromSpeed(cfg.speedFixed.speed, cfg.speedFixed.units, maxRpm), FIXED_PCT, 1);
      }
      if (!readOk) {
        console.error('[igcl-backend] fixed fan probe: read-back did not match the 50% fixed sample - probe fails');
      }

      // Restore default mode, retried: a failed fixed probe must NEVER leave
      // the fan at 50% fixed.
      const restoreOk = await this._restoreFanDefault(fan, deviceId, fanUnits, maxRpm);

      const fixedOk = readOk && restoreOk;
      console.log(`[igcl-backend] fixed fan probe device ${deviceId}: 50% write ${writeAccepted ? 'accepted' : 'refused'}, read-back ${readOk ? 'OK' : 'FAILED'}, restore-to-default ${restoreOk ? 'OK' : 'FAILED'} - fixedOk=${fixedOk}`);
      return fixedOk;
    }

    // M20-B: the FLAT-TABLE fallback probe (the Alchemist fixed mechanism).
    if (this._isUnavailable(lib.ctlFanSetSpeedTableMode)) {
      console.error('[igcl-backend] fixed fan probe: the dedicated API refused and ctlFanSetSpeedTableMode is unavailable - no flat-table fallback possible, fixedOk stays false');
      return false;
    }
    // A flat 2-point 50% table (20C/100C, FAN-enum PERCENT units - the probe
    // convention shared with the apply path).
    const table = [20, 100].map((t) => ({
      Size: koffi.sizeof('ctl_fan_temp_speed_t'),
      Version: 0,
      temperature: t,
      speed: { Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: fanSpeedFromPct(FIXED_PCT, fanUnits, maxRpm), units: fanUnits },
    }));
    const tableObj = { Size: koffi.sizeof('ctl_fan_speed_table_t'), Version: 0, numPoints: table.length, table };
    const setTableResult = lib.ctlFanSetSpeedTableMode(fan, tableObj);
    if (setTableResult !== CTL_RESULT.SUCCESS) {
      // The flat-table write itself failed: the card was never put in
      // table mode - no restore needed, the refusal IS the honest answer.
      console.error(`[igcl-backend] fixed fan probe: the flat-table fallback write refused (${describeResult(setTableResult)}) - 'fixed' stays out of the learned modes`);
      return false;
    }

    // Read-back verify: TABLE mode + >= 2 points, native units, ~50%.
    let readOk = false;
    const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
    koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
    const getResult = lib.ctlFanGetConfig(fan, cfgBuf);
    if (getResult === CTL_RESULT.SUCCESS) {
      const cfg = koffi.decode(cfgBuf, 'ctl_fan_config_t');
      readOk = cfg.mode === 2 /* TABLE */
        && cfg.speedTable.numPoints >= 2
        && cfg.speedTable.numPoints <= 32
        && Array.from({ length: cfg.speedTable.numPoints }, (_, i) => cfg.speedTable.table[i])
          .every((tp) => tp.speed.units === fanUnits
            && nearlyEqual(fanPctFromSpeed(tp.speed.speed, tp.speed.units, maxRpm), FIXED_PCT, 1));
    }
    if (!readOk) {
      console.error('[igcl-backend] fixed fan probe: the flat-table read-back did not match the 50% sample - probe fails');
    }

    // Restore default mode, retried: a failed probe must NEVER leave the
    // fan in table mode.
    const restoreOk = await this._restoreFanDefault(fan, deviceId, fanUnits, maxRpm);

    const fixedOk = readOk && restoreOk;
    console.log(`[igcl-backend] fixed fan probe device ${deviceId}: flat-table 50% write accepted (result ${describeResult(setTableResult)}), read-back ${readOk ? 'OK' : 'FAILED'}, restore-to-default ${restoreOk ? 'OK' : 'FAILED'} - fixedOk=${fixedOk}`);
    return fixedOk;
  }

  /**
   * M3-D: ctlFanSetDefaultMode + read-back verify, retried once. True only
   * when the card reads back in DEFAULT (auto) mode. A stuck table mode is
   * reported loudly - the caller treats it as probe failure.
   * M4J (J): the recovery is STRENGTHENED for the live failure mode
   * ("table write accepted, read-back FAILED, restore-to-default FAILED" -
   * reproduced on the real A770 2026-08-08, ERROR_NOT_AVAILABLE on the
   * SetDefaultMode writes): (1) a short settle delay between attempts (the
   * driver may still be processing the table write); (2) a FINAL mode-flip
   * recovery - re-assert a FRESH sample table (a new state transition
   * out of any wedged table mode), then SetDefaultMode again. Every attempt
   * verifies by read-back. A card the driver refuses to restore stays
   * honestly reported (probeOk=false - never a fake unlock).
   * @param {object} fan
   * @param {number} deviceId
   * @returns {Promise<boolean>}
   */
  async _restoreFanDefault(fan, deviceId, fanUnits = FAN_CONTROL_UNITS, maxRpm = -1) {
    const lib = this._libOrThrow();
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    if (this._isUnavailable(lib.ctlFanSetDefaultMode) || this._isUnavailable(lib.ctlFanGetConfig)) return false;
    const inDefaultMode = () => {
      const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
      koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
      const getResult = lib.ctlFanGetConfig(fan, cfgBuf);
      return getResult === CTL_RESULT.SUCCESS && koffi.decode(cfgBuf, 'ctl_fan_config_t').mode === 0 /* DEFAULT */;
    };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const setResult = lib.ctlFanSetDefaultMode(fan);
      if (setResult !== CTL_RESULT.SUCCESS) {
        console.error(`[igcl-backend] fan probe: restore-to-default attempt ${attempt} failed (${describeResult(setResult)}) - retrying`);
        await settle(150);
        continue;
      }
      if (inDefaultMode()) return true;
      await settle(150);
    }
    // M4J (J): the mode-flip recovery - re-assert the TABLE mode with a
    // fresh safe sample table (a new state transition, distinct from the
    // probe's own table), then SetDefaultMode again. A card wedged in table
    // mode gets a fresh state transition; a card that never left default
    // mode is left untouched by the re-assert + default.
    try {
      const pointCount = 3;
      const table = [];
      for (let i = 0; i < pointCount; i++) {
        table.push({
          Size: koffi.sizeof('ctl_fan_temp_speed_t'),
          Version: 0,
          temperature: 20 + i * 30,
          speed: { Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: fanSpeedFromPct(30 + i * 20, fanUnits, maxRpm), units: fanUnits },
        });
      }
      const tableObj = { Size: koffi.sizeof('ctl_fan_speed_table_t'), Version: 0, numPoints: table.length, table };
      const flipSet = lib.ctlFanSetSpeedTableMode(fan, tableObj);
      if (flipSet === CTL_RESULT.SUCCESS) {
        await settle(150);
        const flipDefault = lib.ctlFanSetDefaultMode(fan);
        if (flipDefault === CTL_RESULT.SUCCESS && inDefaultMode()) return true;
      }
    } catch {
      // the flip recovery threw - the honest failure below stands
    }
    console.error(`[igcl-backend] fan probe: restore-to-default FAILED after retries + the mode-flip recovery for device ${deviceId} - the card may be left in table mode`);
    return false;
  }

  async _ocUnitsOf(deviceId) {
    if (this._ocUnits.has(deviceId)) return this._ocUnits.get(deviceId);
    const dev = await this._device(deviceId);
    const lib = this._libOrThrow();
    const ocBuf = koffi.alloc('ctl_oc_properties_t', 1);
    koffi.encode(ocBuf, 'ctl_oc_properties_t', { Size: koffi.sizeof('ctl_oc_properties_t'), Version: 1 });
    const result = lib.ctlOverclockGetProperties(dev.handle, ocBuf);
    if (result !== CTL_RESULT.SUCCESS) return null;
    const props = koffi.decode(ocBuf, 'ctl_oc_properties_t');
    const out = {};
    for (const [control, field] of Object.entries(OC_UNIT_FIELDS)) {
      out[control] = props[field].units;
    }
    this._ocUnits.set(deviceId, out);
    return out;
  }

  _v2GetterName(control) {
    switch (control) {
      case 'gpuFreqOffset': return 'ctlOverclockGpuFrequencyOffsetGetV2';
      case 'gpuVoltOffset': return 'ctlOverclockGpuMaxVoltageOffsetGetV2';
      case 'powerLimit': return 'ctlOverclockPowerLimitGetV2';
      case 'tempLimit': return 'ctlOverclockTemperatureLimitGetV2';
      case 'vramFreqOffset': return 'ctlOverclockVramMemSpeedLimitGetV2';
      case 'vramVoltOffset': return 'ctlOverclockVramVoltageOffsetGetV2';
      default: return null;
    }
  }

  _v2SetterName(control) {
    switch (control) {
      case 'gpuFreqOffset': return 'ctlOverclockGpuFrequencyOffsetSetV2';
      case 'gpuVoltOffset': return 'ctlOverclockGpuMaxVoltageOffsetSetV2';
      case 'powerLimit': return 'ctlOverclockPowerLimitSetV2';
      case 'tempLimit': return 'ctlOverclockTemperatureLimitSetV2';
      case 'vramFreqOffset': return 'ctlOverclockVramMemSpeedLimitSetV2';
      case 'vramVoltOffset': return 'ctlOverclockVramVoltageOffsetSetV2';
      default: return null;
    }
  }

  async _sysmanPowerCapability() {
    if (!this._hasSysmanCapabilitySeam) return null;
    if (typeof this._sysmanPowerCapable === 'function') {
      try { return (await this._sysmanPowerCapable()) === true; } catch { return false; }
    }
    return this._sysmanPowerCapable !== undefined
      ? this._sysmanPowerCapable === true
      : this._sysmanPowerLimits !== null;
  }

  async getCapabilities(deviceId) {
    await this._device(deviceId);
    if (this._caps.has(deviceId)) {
      const cached = this._caps.get(deviceId);
      // waiverAccepted is live state, not a static capability - refresh it
      // so a later setWaiverAccepted() is reflected without re-reading IGCL.
      // Return a copy: callers must never be able to poison the cache.
      // M17c: the device-scoped limits table + the session refused-ceiling
      // store merge run AFTER the cache read on BOTH paths (the store is
      // session state - the merge must never be cached into the caps).
      const out = structuredClone(cached);
      out.deviceKey = out.deviceKey ?? this._devices?.[deviceId]?.deviceKey ?? deviceHardwareKey(this._devices?.[deviceId]);
      out.waiverAccepted = this._waiverAccepted.get(deviceId) ?? false;
      return this._finalizeCaps(deviceId, out, this._devices?.[deviceId] ?? null);
    }
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const ocMode = this._ocModeFor(deviceId);

    const caps = {
      oemName: 'Intel',
      deviceName: dev.name,
      // Stable PCI/BDF identity is carried with capabilities so apply routing
      // can bind the old runtime's raw handle to the selected main-backend
      // device instead of assuming both enumerations share an order.
      deviceKey: dev.deviceKey ?? deviceHardwareKey(dev),
      // M4-I (S1): the memory type rides the caps payload (the waiver
      // dialogs + the VRAM row's type source - same token-table value the
      // device payload carries).
      memType: dev.memType ?? null,
      waiverAccepted: this._waiverAccepted.get(deviceId) ?? false,
      controls: {
        gpuFreqOffset: false, gpuVoltOffset: false, gpuLock: false,
        vramFreqOffset: false, vramVoltOffset: false,
        powerLimit: false, tempLimit: false, vfCurve: false,
      },
      ranges: {},
      controlStatus: { gpuLock: { state: 'unknown', reason: null } },
      // M48: independent W Sysman and C V1 extension capabilities.
      extendedControls: { powerLimitW: false, tempLimitC: false },
      fan: { canControl: false, modes: [], maxRpm: -1, maxCurvePoints: 0 },
    };

    // --- OC properties ---
    if (!this._isUnavailable(lib.ctlOverclockGetProperties)) {
      const ocBuf = koffi.alloc('ctl_oc_properties_t', 1);
      koffi.encode(ocBuf, 'ctl_oc_properties_t', { Size: koffi.sizeof('ctl_oc_properties_t'), Version: 1 });
      const result = lib.ctlOverclockGetProperties(dev.handle, ocBuf);
      if (result === CTL_RESULT.SUCCESS) {
        const props = koffi.decode(ocBuf, 'ctl_oc_properties_t');
        const map = [
          ['gpuFreqOffset', 'gpuFrequencyOffset', 'gpuFreqOffsetMhz'],
          ['gpuVoltOffset', 'gpuVoltageOffset', 'gpuVoltOffsetV'],
          ['powerLimit', 'powerLimit', 'powerLimitW'],
          ['tempLimit', 'temperatureLimit', 'tempLimitC'],
          ['vramFreqOffset', 'vramMemSpeedLimit', 'vramFreqOffsetGts'],
          ['vramVoltOffset', 'vramVoltageOffset', 'vramVoltOffsetV'],
        ];
        for (const [control, ocField, canonicalName] of map) {
          const c = props[ocField];
          const supported = Boolean(c.bSupported)
            && !this._isUnavailable(lib[this._v2GetterName(control)])
            && !this._isUnavailable(lib[this._v2SetterName(control)]);
          caps.controls[control] = supported;
          if (supported) {
            caps.ranges[canonicalName] = {
              min: igclToCanonical(c.min, c.units),
              max: igclToCanonical(c.max, c.units),
              step: igclToCanonical(c.step, c.units),
              default: igclToCanonical(c.Default, c.units),
              units: this._canonicalUnitName(c.units),
            };
          }
        }
        // F3 PT range fix (M2C-A): the driver setter refuses temp limits
        // above 90 C with 0x44000005 even if the props ever drift above it -
        // pin the EXPOSED max to TEMP_LIMIT_MAX_C so the UI/presets/validation
        // can never offer an un-appliable value (plan.md M2C-A F3). M2C-C:
        // the pin yields to the extended range when the bundled 2023 runtime
        // is capable (values above 90 C then route to that runtime).
        // M4-E: the pin is a C-UNIT rule - percent-unit ranges (Battlemage:
        // temp limit as %, max 100) are not DriverStore °C limits and must
        // pass through untouched (their max IS the honest ceiling).
        // M17c/M17d: the pre-device-limits F3 pin stays as the DRIVERSTORE-
        // floor (the stock-mode ceiling); the device-scoped table application
        // (_finalizeCaps) applies the ACTIVE shape's TL ceiling - the A750's
        // advanced TL is the probe-verified 115 (the 2026-08-12 app-path
        // probe: 100 AND 115 C applied), the A770's advanced TL is
        // the restored 115 (the app-verified KMD ceiling - the M17c row cap
        // at 90 is REMOVED, the round-3-N3 rule flipped).
        if (caps.ranges.tempLimitC && caps.ranges.tempLimitC.units === 'C' && caps.ranges.tempLimitC.max > TEMP_LIMIT_MAX_C) {
          caps.ranges.tempLimitC = { ...caps.ranges.tempLimitC, max: TEMP_LIMIT_MAX_C };
        }
        // M17c: the GLOBAL M15 volt pin is GONE (the global 0.234 clamp
        // wrongly capped the A750's 0.288 - the 2026-08-12 probe: props max
        // 0.288 V step 0.005). The A770-scoped pin (the same
        // both-directions probe-ceiling semantics, keyed on caps.pciDeviceId)
        // now lives in the pure device-limits table and is applied by
        // _finalizeCaps AFTER the extended-ranges block below.
        // M2C-C extended ranges: when the bundled 2023 IGCL runtime is
        // installed and OC mode is advanced (M3-C-E), expose the documented
        // W/C ceilings. The parent UI may be unelevated and see ERROR_KMD_CALL
        // during its probe; the actual apply path still checks isCapable()
        // before any V1 write. Missing DLLs remain an honest unavailable
        // signal.

        const installed = this._extended
          && typeof this._extended.isAvailable === 'function'
          && this._extended.isAvailable() === true;
        const runtimeCapable = this._extended
          ? installed || await this._extended.isCapable()
          : false;
        const explicitControlContract = this._hasSysmanCapabilitySeam
          || typeof this._extended?.isTempCapable === 'function';
        if (!explicitControlContract) {
          delete caps.extendedControls;
          if (runtimeCapable && ocMode === 'advanced'
            && ((caps.ranges.powerLimitW?.units === 'W') || (caps.ranges.tempLimitC?.units === 'C'))) {
            if (caps.ranges.powerLimitW?.units === 'W') {
              caps.ranges.powerLimitW = { ...caps.ranges.powerLimitW, max: SYSMAN_PL_MAX_W };
            }
            if (caps.ranges.tempLimitC?.units === 'C') {
              caps.ranges.tempLimitC = { ...caps.ranges.tempLimitC, max: EXTENDED_TL_MAX_C };
            }
            caps.extendedRanges = true;
          }
        } else {
          // isAvailable only proves that the bundled DLL was found. The
          // temperature writer has its own capability probe and must be
          // required before exposing the extended Celsius range. Power keeps
          // its separate Sysman/runtime capability path below.
          const tempCapable = this._extended
            ? (typeof this._extended.isTempCapable === 'function'
              ? (await this._extended.isTempCapable()) === true
              : false)
            : false;
          const explicitSysmanPower = await this._sysmanPowerCapability();
          const powerCapable = explicitSysmanPower === null ? runtimeCapable : explicitSysmanPower;
          const hasW = caps.ranges.powerLimitW?.units === 'W';
          const hasC = caps.ranges.tempLimitC?.units === 'C';
          caps.extendedControls = {
            powerLimitW: Boolean(powerCapable && hasW),
            tempLimitC: Boolean(tempCapable && hasC),
          };
          if (ocMode === 'advanced' && (caps.extendedControls.powerLimitW || caps.extendedControls.tempLimitC)) {
            if (caps.extendedControls.powerLimitW) {
              caps.ranges.powerLimitW = { ...caps.ranges.powerLimitW, max: SYSMAN_PL_MAX_W };
            }
            if (caps.extendedControls.tempLimitC) {
              caps.ranges.tempLimitC = { ...caps.ranges.tempLimitC, max: EXTENDED_TL_MAX_C };
            } else if (hasC) {
              caps.ranges.tempLimitC = { ...caps.ranges.tempLimitC, max: TEMP_LIMIT_MAX_C };
            }
            caps.extendedRanges = true;
          } else if (ocMode === 'advanced' && hasC) {
            caps.ranges.tempLimitC = { ...caps.ranges.tempLimitC, max: TEMP_LIMIT_MAX_C };
          }
        }
        // gpuLock: the pair API is a VOLT/MHz fixed-lock surface. Battlemage
        // exposes its voltage offset in percent units and may still export
        // the legacy symbols; accepting those symbols would send a bogus
        // mV lock to the driver and produce the observed fixed-frequency
        // refusal. Require the native units to be unambiguous before the
        // control is exposed. Offsets remain independently editable.
        const lockUnitsSupported = caps.ranges.gpuVoltOffsetV?.units === 'V'
          && caps.ranges.gpuFreqOffsetMhz?.units === 'MHz';
        caps.controls.gpuLock = lockUnitsSupported
          && !this._isUnavailable(lib.ctlOverclockGpuLockGet)
          && !this._isUnavailable(lib.ctlOverclockGpuLockSet);
        caps.controlStatus.gpuLock = caps.controls.gpuLock
          ? { state: 'available', reason: null }
          : {
            state: 'unsupported',
            reason: !lockUnitsSupported
              ? 'Fixed Clock / Voltage lock is not exposed for this adapter’s native voltage units.'
              : 'The driver does not expose both GPU lock read/write symbols.',
          };
        // Custom live VF curves are a Battlemage surface. Alchemist exposes
        // the legacy symbols on some runtimes but rejects this curve ABI.
        const battlemage = isBattlemageGpuName(dev.name, dev);
        caps.controls.vfCurve = battlemage
          && this._vfCurveReadable(dev.handle)
          && !this._isUnavailable(lib.ctlOverclockWriteCustomVFCurve);
        // M17e (round-1 S3): the per-device gpuLock bounds - derived from the
        // props' gpuVFCurveVoltageLimit / gpuVFCurveFrequencyLimit (the
        // bounds the custom-VF-curve validation references) THROUGH the units
        // decode (igclToCanonical - never a raw pass: the fields carry a
        // units int32 with the same mV hazard the lock API proved). Both
        // limits must be reported supported + sane; otherwise lockRange stays
        // ABSENT and the listed-card fallback below + the documented bounds
        // apply (the live A770 driver answers bSupported:false - the probe-3
        // evidence, 2026-08-13).
        const vfVolt = props.gpuVFCurveVoltageLimit;
        const vfFreq = props.gpuVFCurveFrequencyLimit;
        if (vfVolt && vfFreq && vfVolt.bSupported && vfFreq.bSupported
          && Number.isFinite(vfVolt.min) && Number.isFinite(vfVolt.max)
          && Number.isFinite(vfFreq.min) && Number.isFinite(vfFreq.max)) {
          caps.lockRange = {
            voltMin: Math.max(0, igclToCanonical(vfVolt.min, vfVolt.units)),
            voltMax: igclToCanonical(vfVolt.max, vfVolt.units),
            freqMin: Math.max(0, igclToCanonical(vfFreq.min, vfFreq.units)),
            freqMax: igclToCanonical(vfFreq.max, vfFreq.units),
          };
        }
        if (battlemage && vfVolt && vfFreq && vfVolt.bSupported && vfFreq.bSupported
          && Number.isFinite(vfVolt.min) && Number.isFinite(vfVolt.max)
          && Number.isFinite(vfFreq.min) && Number.isFinite(vfFreq.max)) {
          const voltageMinV = Math.max(0, igclToCanonical(vfVolt.min, vfVolt.units));
          const voltageMaxV = igclToCanonical(vfVolt.max, vfVolt.units);
          const freqMinMhz = Math.max(0, igclToCanonical(vfFreq.min, vfFreq.units));
          const freqMaxMhz = igclToCanonical(vfFreq.max, vfFreq.units);
          if (voltageMaxV > voltageMinV && freqMaxMhz > freqMinMhz) {
            caps.vfCurveRange = { voltageMinV, voltageMaxV, freqMinMhz, freqMaxMhz, maxPoints: 32 };
          }
        }
      }
    }
    // M17e (the user addition + round-2 N3): the LISTED-CARD fallback table
    // (pure/lock-ranges.ts - the a770/a750 documented-class rows) fills the
    // caps.lockRange when the driver props did not report the limits (or the
    // whole props read failed) on a gpuLock-capable device; b580/arc-igpu/
    // pro-b50 have no gpuLock control at all - no lockRange (the clamps +
    // the renderer fall back to the documented absolute bounds).
    if (caps.controls.gpuLock === true && !caps.lockRange) {
      const listed = lockRangeOf(dev.pciDeviceId ?? null);
      if (listed) caps.lockRange = listed;
    }
    // M17 (B50-class): OC-locked devices (Arc B50 / Arc Pro B50 and friends)
    // have NO overclocking surface - ctlOverclockGetProperties fails (or
    // reports every control unsupported) and ctlOverclockWaiverSet answers
    // ERROR_UNSUPPORTED_FEATURE: there is no warranty waiver to accept. The
    // flag lets the UI skip the boot prompt, the clickable dashboard row and
    // the apply-time waiver gate on such devices (the driver's per-control
    // 'unsupported' refusals stay the honest floor).
    caps.overclockingSupported = Object.values(caps.controls).some(Boolean);

    // M17c: the AIB-identity fields - the DECODE happens HERE via pure/aib.ts
    // (the subsystem fields ride the device payload from _ensureDevices -
    // pci_subsys_vendor_id / pci_subsys_id, the PNP SUBSYS_ mapping, exact
    // per device). The LAPTOP BRANCH (user request) overrides the subsystem
    // decode when the system is portable: the injected laptopInfoOf provider
    // (the cached CIM laptop shape from main.js - manufacturer/model/
    // pcSystemType/chassisTypes, the vramBytesOf injection pattern) feeds
    // laptopAibOf; a non-portable system returns null there and the
    // subsystem decode stays authoritative. Unknown subsystem vendor ->
    // null (the honest '-' - the Dashboard AIB row renders it). These are
    // APPENDED caps fields (absent -> null).
    caps.pciDeviceId = dev.pciDeviceId ?? null;
    caps.deviceKey = dev.deviceKey ?? deviceHardwareKey(dev);
    const laptopInfo = this._laptopInfoOf ? this._laptopInfoOf() : null;
    const laptopDecoded = laptopInfo ? laptopAibOf(laptopInfo) : null;
    const aib = laptopDecoded ?? aibOf(dev.pciSubsysVendorId, dev.pciSubsysId);
    caps.aibVendor = aib?.vendor ?? null;
    caps.aibModel = aib?.model ?? null;

    // --- Fan ---
    const fanHandles = await this._fanHandlesOf(deviceId);
    if (fanHandles.length > 0 && !this._isUnavailable(lib.ctlFanGetProperties)) {
      const propBuf = koffi.alloc('ctl_fan_properties_t', 1);
      koffi.encode(propBuf, 'ctl_fan_properties_t', { Size: koffi.sizeof('ctl_fan_properties_t'), Version: 0 });
      const result = lib.ctlFanGetProperties(await this._fanHandleForControl(deviceId), propBuf);
      if (result === CTL_RESULT.SUCCESS) {
        const fp = koffi.decode(propBuf, 'ctl_fan_properties_t');
        // M3-D: canControl=false is a LIE on this A770 - the driver honors
        // table/default writes anyway (live-verified 2026-08-06). The probe
        // is the unlock AND the mode-truth: the 1<<mode derivation from
        // supportedModes=0x2 yields ['fixed'] - the ONE mode this card
        // genuinely refuses - so the probe runs whenever properties refuse
        // control OR the derived modes claim 'fixed' (F1: with the IGS
        // app/service running canControl=TRUE and the derivation would
        // still gate the Fan page to fixed-only in the primary usage;
        // never gate the probe on !canControl). Reversible: write the
        // sample table (min(10, maxPoints) points, FAN-enum PERCENT
        // units), read back, restore default - restore retried, never left
        // in table mode. The result is cached OUTSIDE the caps cache and
        // shared across concurrent first calls; effective canControl =
        // properties.canControl || probeOk. Probe-learned modes follow the
        // WRITE-ACCEPTED rule (F2): when the table WRITE was accepted the
        // real modes are ['auto','curve'] (the card demonstrably accepts
        // tables - even when a later step failed, e.g. a stuck restore or
        // an IGS reapply race); a write-REFUSED probe keeps the derived
        // modes (claiming auto/curve on a genuinely fixed-only card would
        // lie). The derivation stays only for cards that never probe
        // (probe disabled, or probe symbols missing). M4-C: the fixed-write
        // sub-probe (reversible 50% write, M20-B: with the flat-table
        // fallback when the dedicated API refuses - the Alchemist route)
        // extends the same cached shape - only a fully verified fixed probe
        // (fixedOk) adds 'fixed' to the learned modes (a refused fixed
        // route keeps ['auto','curve']).
        let modes = Object.entries(CTL_FAN_SPEED_MODE)
          .filter(([v]) => (fp.supportedModes & (1 << Number(v))) !== 0)
          .map(([v]) => FAN_MODE_CANONICAL[Number(v)]);
        const probeRuns = this._fanProbeEnabled
          && !this._isUnavailable(lib.ctlFanSetSpeedTableMode)
          && !this._isUnavailable(lib.ctlFanSetDefaultMode)
          && !this._isUnavailable(lib.ctlFanGetConfig)
          && (!fp.canControl || modes.includes('fixed'));
        let canControl = fp.canControl;
        if (probeRuns) {
          const probe = await this._probeFanCapability(deviceId, fp.maxPoints, fp);
          canControl = fp.canControl || probe.probeOk;
          // M4-C: the fixed sub-probe extends the write-accepted rule -
          // only a FULLY verified fixed probe (write + read-back + restore
          // all succeeded, fixedOk) adds 'fixed' to the learned modes; a
          // refused/partial fixed probe keeps ['auto','curve'] (claiming
          // fixed on a card that refuses every fixed route would lie).
          // M20-B: on the Alchemist driver the fixed sub-probe now learns
          // 'fixed' through the FLAT-TABLE fallback (the dedicated API
          // refuses, the flat table works) - the same fixedOk verdicts.
          if (probe.writeAccepted) {
            modes = probe.fixedOk ? ['auto', 'curve', 'fixed'] : ['auto', 'curve'];
          }
        }
        caps.fan = {
          canControl,
          // Map through the same table as fan-mode read-back so
          // caps.fan.modes and DeviceState.fanMode share one vocabulary
          // (auto|curve|fixed) - never raw IGCL names.
          modes,
          maxRpm: fp.maxRPM,
          maxCurvePoints: fp.maxPoints,
          // The native API uses a bit mask for supportedUnits. Battlemage
          // commonly exposes RPM only for state, while the Arc table/fixed
          // control path accepts the FAN enum's percent encoding. Keep the
          // state-unit report honest; the write boundary uses
          // FAN_CONTROL_UNITS above.
          speedUnits: fanUnitForProperties(fp) === FAN_UNITS_RPM ? 'rpm' : 'percent',
        };
      }
    }

    this._caps.set(deviceId, caps);
    const finalized = this._finalizeCaps(deviceId, caps, dev);
    // M17c (step-4 N4): the CACHE holds the FINALIZED caps of the cold
    // read - the driver-props truth + the AIB fields + the device-limits
    // table + the session-store merge AS OF THAT READ (the finalize above
    // mutates the cached object in place). That is safe because the
    // finalize is DETERMINISTIC + IDEMPOTENT: the table application is a
    // pure min-cap/step/unclamp per control (a re-finalize on the cache-hit
    // path is a no-op) and the session-store merge re-runs on EVERY
    // returned copy (line 1044) - the merge is monotone (only ever
    // lower), so a refusal recorded AFTER the cold read still degrades the
    // next read and nothing re-raises a degraded ceiling.
    return structuredClone(finalized);
  }

  /**
   * M17c: the device-scoped caps finalize - runs AFTER the cache read on
   * BOTH getCapabilities paths (the cache-hit path and the cold path):
   *   1. the per-device limits table (pure/device-limits.ts): the listed
   *      rows' per-control { max, step } overrides (the A770 volt 0.234 +
   *      step 0.001, the per-AIB PL ceilings, the TL 90 caps, the A750
   *      unclamp) + the default row for UNLISTED cards (252/90 stock,
   *      315/115 extended - today's pins exactly, so no stock-mode gap
   *      opens between the slider and the apply gates). Driver props stay
   *      the runtime authority; the table only caps to documented ceilings
   *      (PL/TL maxes apply as min-caps) - EXCEPT the volt maxes, which
   *      are the LIVE-PROBE ceiling pins (the M15 both-directions
   *      semantics scoped to the A770: a props under-report of 0.230 is
   *      raised to the 0.234 ceiling; the session store merge below can
   *      still degrade it). Percent-unit ranges (Battlemage) are never
   *      touched (the M4-E rule).
   *   2. the session refused-ceiling store merge (mergeIntoRanges -
   *      NEVER raises; a refused apply's degraded ceiling caps the max +
   *      default).
   * @param {number} deviceId
   * @param {object} caps the (cloned) caps to finalize
   * @param {object|null} dev the device payload (the AIB fields fallback)
   * @returns {object} the finalized caps (the input mutated - callers pass
   *   a fresh clone)
   */
  _finalizeCaps(deviceId, caps, dev) {
    // M39/M46: the selected OC mode controls the displayed W/C shape.
    // `extendedRanges` remains the separate runtime-write capability signal;
    // an installed but KMD-rejected companion must not make Advanced render
    // as Stock while the apply path reports its honest limitation.
    const ocMode = this._ocModeFor(deviceId);
    caps.ocMode = ocMode;
    const identity = {
      pciDeviceId: caps.pciDeviceId ?? dev?.pciDeviceId ?? null,
      aibVendor: caps.aibVendor ?? null,
      aibModel: caps.aibModel ?? null,
    };
    const limits = deviceLimitsOf(identity, { advanced: ocMode === 'advanced' });
    if (limits) {
      // The UNLISTED path gets the DEFAULT row of the selected mode
      // (stock 252/90, advanced 315/115); a LISTED card's row is the
      // selected mode's AIB/KMD shape.
      const row = limits.listed ? limits : defaultLimitsOf(ocMode === 'advanced');
      for (const [canonical, override] of Object.entries(row)) {
        if (canonical === 'listed') continue;
        const range = caps.ranges[canonical];
        if (!range) continue;
        // The M4-E units rule: the table speaks W/V/C - percent-unit
        // ranges (Battlemage) are never touched (their max IS the ceiling).
        if (canonical === 'powerLimitW' && range.units !== 'W') continue;
        if (canonical === 'tempLimitC' && range.units !== 'C') continue;
        if (canonical === 'gpuVoltOffsetV' && range.units !== 'V') continue;
        let next = range;
        if (typeof override.max === 'number') {
          if (canonical === 'gpuVoltOffsetV') {
            // The volt maxes are the M15 probe-ceiling PINS (both
            // directions - the props may under-report the grid-aligned
            // 0.230); the store merge below is the only downward force.
            next = { ...next, max: override.max };
          } else if (ocMode === 'advanced') {
            // Advanced W/C controls expose the documented KMD ceiling even
            // when the bundled V1 runtime is unavailable; the apply gate
            // separately refuses values that require that runtime.
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
    // M48: finalize the independent control ceilings after device-scoped
    // limits. A false seam must never leave an Advanced slider at an
    // unwriteable extended maximum.
    if (caps.extendedControls && caps.ranges.powerLimitW?.units === 'W'
      && caps.extendedControls.powerLimitW !== true) {
      const range = caps.ranges.powerLimitW;
      caps.ranges.powerLimitW = {
        ...range,
        max: Math.min(range.max, 252),
        ...(typeof range.default === 'number' ? { default: Math.min(range.default, 252) } : {}),
      };
    }
    if (caps.extendedControls && caps.ranges.tempLimitC?.units === 'C'
      && caps.extendedControls.tempLimitC !== true) {
      const range = caps.ranges.tempLimitC;
      caps.ranges.tempLimitC = {
        ...range,
        max: Math.min(range.max, TEMP_LIMIT_MAX_C),
        ...(typeof range.default === 'number' ? { default: Math.min(range.default, TEMP_LIMIT_MAX_C) } : {}),
      };
    }
    caps.ranges = mergeIntoRanges(this._refusedCeilings, deviceId, caps.ranges);
    const learnedCeilings = recordedCeilingsFor(this._refusedCeilings, deviceId);
    if (Object.keys(learnedCeilings).length > 0) caps.learnedCeilings = learnedCeilings;
    return caps;
  }

  /**
   * M17c: the SHARED refusal recording (the parent-side apply paths feed
   * it - recordRefusalEnvelope walks the per-control result map + the
   * attempted settings and snaps the exposed ceiling DOWN one step per
   * 'out-of-range' refusal; monotone - only ever lowered). Both feeding
   * paths use it:
   *   (a) the WORKER result envelope (the parent-merge - the envelope's
   *       `refused` map = the attempted values of the refused controls);
   *   (b) the IN-PROCESS perControl result + the attempted settings (the
   *       always-elevated packaged EXE applies in-process).
   * The ranges (step/min for the snap) come from the cached caps - absent
   * per-control ranges skip that control. Garbage envelopes are no-ops
   * (never a throw, never an invented degrade).
   * @param {number} deviceId
   * @param {{ perControl?: object }} result the apply result envelope
   * @param {object|null|undefined} settings the ATTEMPTED settings (the
   *   values the driver refused - the store never guesses)
   */
  recordApplyRefusals(deviceId, result, settings) {
    if (!result || typeof result !== 'object' || !result.perControl) return;
    const ranges = this._caps.get(deviceId)?.ranges ?? null;
    recordRefusalEnvelope(this._refusedCeilings, deviceId, result.perControl, settings, ranges);
  }

  _canonicalUnitName(units) {
    switch (units) {
      case 0: return 'MHz';
      case 1: return 'GTS';
      case 2: return 'MTS';
      case 3: return 'V';
      case 4: return 'W';
      case 5: return 'C';
      case 10: return 'mW';
      case 13: return 'mV';
      // M4-E: percent-unit controls (Battlemage - volt/PL/TL as % per the
      // IGCL sample) must surface the canonical '%' like the mock featureset
      // (a 'UNITS_11' string would render "120 UNITS_11" in the UI and drift
      // from the mock's '%').
      case 11: return '%';
      // M4-G: Battlemage VRAM speed uses MEM_SPEED_GBPS (12) - display as
      // MHz (x125 for GDDR6: 19 Gbps = 2375 MHz)
      case 12: return 'MHz';
      default: return `UNITS_${units}`;
    }
  }

  _vfCurveReadable(handle) {
    const lib = this._libOrThrow();
    if (this._isUnavailable(lib.ctlOverclockReadVFCurve)) return false;
    try {
      const numBuf = koffi.alloc('uint32', 1);
      koffi.encode(numBuf, 'uint32', 0);
      const result = lib.ctlOverclockReadVFCurve(handle, 1 /* LIVE */, 2 /* ELABORATE */, numBuf, null);
      return result === CTL_RESULT.SUCCESS;
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Read-back
  // -------------------------------------------------------------------------

  async getCurrentSettings(deviceId) {
    await this._device(deviceId);
    const caps = await this.getCapabilities(deviceId);
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const units = await this._ocUnitsOf(deviceId);

    const state = {
      powerLimitW: null, gpuVoltOffsetV: null, gpuFreqOffsetMhz: null, tempLimitC: null,
      vramFreqOffsetGts: null, vramVoltOffsetV: null, gpuLock: null, vfCurve: null,
      vfCurveUnits: null,
      fanMode: null, fanCurve: null, fixedFanPct: null,
    };

    const readV2 = (control, canonicalName, unitField) => {
      if (!caps.controls[control]) return null;
      const fn = lib[this._v2GetterName(control)];
      if (this._isUnavailable(fn)) return null;
      const buf = koffi.alloc('double', 1);
      const result = fn(dev.handle, buf);
      if (result !== CTL_RESULT.SUCCESS) return null;
      const unit = units ? units[unitField] : 0;
      return igclToCanonical(koffi.decode(buf, 'double'), unit);
    };

    state.powerLimitW = readV2('powerLimit', 'powerLimitW', 'powerLimit');
    state.gpuVoltOffsetV = readV2('gpuVoltOffset', 'gpuVoltOffsetV', 'gpuVoltOffset');
    state.gpuFreqOffsetMhz = readV2('gpuFreqOffset', 'gpuFreqOffsetMhz', 'gpuFreqOffset');
    state.tempLimitC = readV2('tempLimit', 'tempLimitC', 'tempLimit');
    state.vramFreqOffsetGts = readV2('vramFreqOffset', 'vramFreqOffsetGts', 'vramFreqOffset');
    state.vramVoltOffsetV = readV2('vramVoltOffset', 'vramVoltOffsetV', 'vramVoltOffset');

    // gpuLock (VF pair; 0,0 = dynamic/unlocked)
    if (caps.controls.gpuLock && !this._isUnavailable(lib.ctlOverclockGpuLockGet)) {
      const lockBuf = koffi.alloc('ctl_oc_vf_pair_t', 1);
      koffi.encode(lockBuf, 'ctl_oc_vf_pair_t', { Size: koffi.sizeof('ctl_oc_vf_pair_t'), Version: 0 });
      const result = lib.ctlOverclockGpuLockGet(dev.handle, lockBuf);
      if (result === CTL_RESULT.SUCCESS) {
        const lock = koffi.decode(lockBuf, 'ctl_oc_vf_pair_t');
        // M17e: the lock read-back is MILLIVOLTS (probe 2, 2026-08-12) -
        // convert to the canonical volts shape (0,0 = dynamic).
        state.gpuLock = { voltageV: lock.Voltage / 1000, freqMhz: lock.Frequency };
      }
    }

    // VF curve is the LIVE Battlemage curve shown by the editor. Voltage is
    // documented by IGCL as millivolts; the renderer/backend contract uses V.
    if (caps.controls.vfCurve && !this._isUnavailable(lib.ctlOverclockReadVFCurve)) {
      const numBuf = koffi.alloc('uint32', 1);
      koffi.encode(numBuf, 'uint32', 0);
      let result = lib.ctlOverclockReadVFCurve(dev.handle, 1, 2, numBuf, null);
      const num = koffi.decode(numBuf, 'uint32');
      if (result === CTL_RESULT.SUCCESS && num > 0 && num < 10000) {
        const curveBuf = koffi.alloc('ctl_voltage_frequency_point_t', num);
        result = lib.ctlOverclockReadVFCurve(dev.handle, 1, 2, numBuf, curveBuf);
        if (result === CTL_RESULT.SUCCESS) {
          const sz = koffi.sizeof('ctl_voltage_frequency_point_t');
          state.vfCurve = [];
          for (let i = 0; i < num; i++) {
            const pt = koffi.decode(curveBuf, i * sz, 'ctl_voltage_frequency_point_t');
            state.vfCurve.push({ voltageV: pt.Voltage / 1000, freqMhz: pt.Frequency });
          }
          state.vfCurveUnits = 'V';
        }
      }
    }

    // Fan read-back (read-only here even when the EFFECTIVE canControl is
    // false - the A770 still reports config/state; setters stay gated).
    const fanHandles = await this._fanHandlesOf(deviceId);
    if (fanHandles.length > 0 && !this._isUnavailable(lib.ctlFanGetConfig)) {
      let fanProperties = null;
      if (!this._isUnavailable(lib.ctlFanGetProperties)) {
        const propBuf = koffi.alloc('ctl_fan_properties_t', 1);
        koffi.encode(propBuf, 'ctl_fan_properties_t', { Size: koffi.sizeof('ctl_fan_properties_t'), Version: 0 });
        if (lib.ctlFanGetProperties(await this._fanHandleForControl(deviceId), propBuf) === CTL_RESULT.SUCCESS) {
          fanProperties = koffi.decode(propBuf, 'ctl_fan_properties_t');
        }
      }
      const fanUnits = fanUnitForProperties(fanProperties);
      const fanMaxRpm = Number(fanProperties?.maxRPM);
      const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
      koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
      const result = lib.ctlFanGetConfig(await this._fanHandleForControl(deviceId), cfgBuf);
      if (result === CTL_RESULT.SUCCESS) {
        const cfg = koffi.decode(cfgBuf, 'ctl_fan_config_t');
        state.fanMode = FAN_MODE_CANONICAL[cfg.mode] ?? null;
        if (cfg.speedTable.numPoints > 0 && cfg.speedTable.numPoints <= 32) {
          state.fanCurve = [];
          for (let i = 0; i < cfg.speedTable.numPoints; i++) {
            const tp = cfg.speedTable.table[i];
            state.fanCurve.push({
              t: tp.temperature,
              // Keep the canonical profile unit as percent while converting
              // RPM-only Battlemage tables with the advertised maxRPM.
              speedPct: fanPctFromSpeed(tp.speed.speed, tp.speed.units, fanMaxRpm),
            });
          }
          // Mixed/unknown units make the canonical % curve meaningless.
          if (state.fanCurve.some((p) => p.speedPct === null)) state.fanCurve = null;
        }
        // M20-B (F3/F4): a FLAT table IS a fixed speed (the Alchemist
        // mechanism - the read-back flips a mode-2 flat table to the honest
        // 'fixed' state: TABLE mode + numPoints >= 2 (a 1-point table is
        // vacuously "all equal" - gated out) + every point's speed equal
        // (within 1) + PERCENT units). The derivation DUAL-REPORTS:
        // state.fanCurve keeps the table points (the Curve chip still shows
        // the user's points; the saved profile keeps fanMode='curve' +
        // fanCurve untouched - only the live display flips, and honestly: a
        // flat table IS a fixed speed). A non-flat table keeps the current
        // 'curve' + fanCurve behavior.
        const flatTable = state.fanMode === 'curve' /* TABLE */
          && state.fanCurve !== null && state.fanCurve.length >= 2
          && state.fanCurve.every((p) => Math.abs(p.speedPct - state.fanCurve[0].speedPct) <= 1);
        if (flatTable) {
          state.fanMode = 'fixed';
          state.fixedFanPct = state.fanCurve[0].speedPct;
        } else if (fanUnits !== null && cfg.speedFixed.units === fanUnits) {
          state.fixedFanPct = fanPctFromSpeed(cfg.speedFixed.speed, cfg.speedFixed.units, fanMaxRpm);
        } else {
          state.fixedFanPct = null; // unsupported native unit or no maxRPM to normalize
        }
      }
    }

    return state;
  }

  // -------------------------------------------------------------------------
  // M8 - Graphics (the IGCL 3D-feature surface)
  // -------------------------------------------------------------------------

  /**
   * The NEVER-THROW degraded GraphicsState - the honest "not supported on
   * this GPU" surface the page caps-gates on. Mirrored by the mock's
   * per-device degrade (the RID_MOCK_MULTI_DEVICE iGPU + the
   * RID_MOCK_GRAPHICS_UNSUPPORTED knob).
   * @returns {import('./backend.interface.js').GraphicsState}
   */
  _graphicsDegraded() {
    return {
      supported: { frameGen: false, flipModes: false, frameLimit: false, lowLatency: false },
      supportedOptions: { frameGen: [], flipModes: [], lowLatency: [] },
      frameLimitRange: null,
      values: { frameGenOverride: null, flipMode: null, frameLimit: null, lowLatency: null },
    };
  }

  /**
   * M8: the per-device cached 3D-feature caps (the supported feature table
   * from ctlGetSupported3DCapabilities). The caps are stable per driver/
   * device - cached like the OC caps; the VALUES are never cached (every
   * read-back is fresh). Null on any failure (the caller degrades).
   * @param {number} deviceId
   * @param {object} handle the device handle
   * @returns {Promise<Map<number, object> | null>} featureType -> details
   */
  async _graphicsCapsOf(deviceId, handle) {
    if (this._graphicsCapsCache.has(deviceId)) return this._graphicsCapsCache.get(deviceId);
    const lib = this._libOrThrow();
    const capsBuf = koffi.alloc('uint8', 24);
    koffi.encode(capsBuf, 0, 'uint32', 24);
    koffi.encode(capsBuf, 4, 'uint8', 0);
    koffi.encode(capsBuf, 8, 'uint32', 0);
    koffi.encode(capsBuf, 16, 'void*', 0n);
    let result = lib.ctlGetSupported3DCapabilities(handle, capsBuf);
    if (result !== CTL_RESULT.SUCCESS) return null;
    const num = Number(koffi.decode(capsBuf, 8, 'uint32'));
    if (!Number.isInteger(num) || num <= 0 || num > 256) return null;
    const detailsBuf = koffi.alloc('uint8', num * koffi.sizeof('ctl_3d_feature_details_t'));
    koffi.encode(capsBuf, 8, 'uint32', num);
    koffi.encode(capsBuf, 16, 'void*', koffi.address(detailsBuf));
    result = lib.ctlGetSupported3DCapabilities(handle, capsBuf);
    if (result !== CTL_RESULT.SUCCESS) return null;
    const features = new Map();
    for (let i = 0; i < num; i++) {
      const d = decode3dFeatureDetails(detailsBuf, i);
      features.set(d.featureType, d);
    }
    this._graphicsCapsCache.set(deviceId, features);
    return features;
  }

  /**
   * Read the IGS Global VRR mode independently from the Arc Sync profile.
   * The separate Display > General > Variable Refresh Rate switch is backed
   * by ctlGet/SetIntelArcSyncProfile; it is deliberately not inferred from
   * Adaptive Sync Plus (feature 10), which is absent on the A770 runtime.
   */
  async _readGlobalVrrMode(deviceId, adapterHandle) {
    const unavailable = (reason) => ({
      capability: displayCapability(null, false, false, reason, 'igcl-global-vrr'),
      options: [],
    });
    try {
      if (this._igscFullOk === false) {
        return unavailable('The IGSC full loader is unavailable; global Variable Refresh Rate is not exposed by this runtime.');
      }
      const lib = this._libOrThrow();
      if (this._isUnavailable(lib.ctlGetSupported3DCapabilities) || this._isUnavailable(lib.ctlGetSet3DFeature)) {
        return unavailable('The global Variable Refresh Rate Mode API is not available in this IGCL runtime.');
      }
      const features = await this._graphicsCapsOf(deviceId, adapterHandle);
      const detail = features?.get(CTL_3D_FEATURE.VRR_WINDOWED_BLT);
      if (!detail || detail.valueType !== CTL_PROPERTY_VALUE_TYPE.ENUM) {
        return unavailable('The global Variable Refresh Rate Mode feature is not reported by the driver.');
      }
      const options = globalVrrOptionsOf(detail);
      if (options.length === 0) {
        return unavailable('The driver did not advertise any supported global Variable Refresh Rate modes.');
      }
      const read = globalVrrRequest(lib, adapterHandle, features, { bSet: false });
      if (read.scope && !read.scope.ok) {
        return {
          capability: displayCapability(null, true, false, read.scope.message, 'igcl-global-vrr'),
          options,
        };
      }
      if (read.errorCode || read.result !== CTL_RESULT.SUCCESS) {
        return {
          capability: displayCapability(null, true, false, read.message ?? `The driver reported global Variable Refresh Rate modes but refused read-back (${describeResult(read.result)}).`, 'igcl-global-vrr'),
          options,
        };
      }
      const value = decode3dFeatureGetsetValue(read.request.buf, CTL_PROPERTY_VALUE_TYPE.ENUM).enableType;
      const mode = DISPLAY_GLOBAL_VRR_MODE_FROM_IGCL[value] ?? null;
      if (!mode || !options.includes(mode)) {
        return {
          capability: displayCapability(null, true, false, 'The driver returned an unknown or unsupported global Variable Refresh Rate Mode.', 'igcl-global-vrr'),
          options,
        };
      }
      return {
        capability: displayCapability(mode, true, true, null, 'igcl-global-vrr'),
        options,
      };
    } catch {
      return unavailable('The global Variable Refresh Rate Mode could not be read from this driver runtime.');
    }
  }

  /**
   * Return only Game Profile capabilities that are safe to expose for this
   * adapter. Endurance Gaming requires an integrated or mobile Arc adapter and
   * a driver-reported per-application feature surface.
   */
  async getGameProfileCapabilities(deviceId, exePath) {
    try {
      const dev = await this._device(deviceId);
      const features = await this._graphicsCapsOf(deviceId, dev.handle);
      const detail = features?.get(CTL_3D_FEATURE.ENDURANCE_GAMING);
      const frameGenDetail = features?.get(CTL_3D_FEATURE.FRAME_GENERATION);
      const platform = endurancePlatformSupported(dev, this._laptopInfoOf ? this._laptopInfoOf() : null);
      const supported = platform
        && enduranceValueTypeSupported(detail?.valueType)
        && detail.perAppSupport === true;
      // XeFG is a per-executable control only when the driver reports the
      // frame-generation feature with the enum ABI and explicitly marks it
      // as per-app capable. The option is deliberately hidden otherwise;
      // device-level support alone must not make a game-profile control look
      // writable.
      // Use package evidence as well as the known-title fallback so new XeFG
      // games are not silently omitted until the next app release. The
      // explicit classifier deny list still prevents benchmark/software
      // executables from receiving a game-only control.
      const executable = classifyXeFgExecutable(exePath, { inspectRuntime: true });
      const xeFg = frameGenDetail?.valueType === CTL_PROPERTY_VALUE_TYPE.ENUM
        && frameGenDetail.perAppSupport === true;
      const xeFgAllowed = xeFg && executable.supported;
      return {
        enduranceGaming: supported,
        xeFg: xeFgAllowed,
        xeFgOptions: xeFgAllowed ? [...GRAPHICS_FRAME_GEN_OPTIONS] : [],
        reason: supported ? null : (!platform
          ? 'Endurance Gaming is available only on integrated Intel graphics.'
          : !detail
            ? 'The driver does not expose Endurance Gaming for this adapter.'
            : detail.perAppSupport !== true
              ? 'The driver does not expose Endurance Gaming as a per-game control.'
              : 'Endurance Gaming is not available on this driver surface.'),
        xeFgReason: xeFgAllowed ? null : (!executable.supported
          ? executable.reason
          : !frameGenDetail
            ? 'The driver does not expose XeFG for this adapter.'
          : frameGenDetail.perAppSupport !== true
            ? 'The driver does not expose XeFG as a per-game control.'
            : 'XeFG is not available on this driver surface.'),
      };
    } catch {
      return {
        enduranceGaming: false,
        xeFg: false,
        xeFgOptions: [],
        reason: 'Endurance Gaming could not be read from this driver.',
        xeFgReason: 'XeFG could not be read from this driver.',
      };
    }
  }

  async setGameProfileSettings(deviceId, exePath, settings = {}, enabled = true) {
    const appName = typeof exePath === 'string' && exePath.length > 0 ? path.win32.basename(exePath) : '';
    if (!appName) return { ok: false, perControl: { profileScope: { ok: false, errorCode: 'invalid-argument', message: 'an executable name is required' } } };
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const features = await this._graphicsCapsOf(deviceId, dev.handle);
    const detail = features?.get(CTL_3D_FEATURE.GLOBAL_OR_PER_APP);
    const result = { ok: true, perControl: {} };
    let settingsForApply = settings;
    if (enabled === true && settings.frameGenOverride !== null && settings.frameGenOverride !== undefined) {
      const profileCaps = await this.getGameProfileCapabilities(deviceId, exePath);
      if (!profileCaps.xeFg) {
        result.ok = false;
        result.perControl.frameGenOverride = {
          ok: false,
          errorCode: 'unsupported',
          message: profileCaps.xeFgReason,
        };
        // Preserve the legacy per-game controls in a mixed request. The
        // unsupported XeFG field is omitted before the native apply so the
        // driver cannot receive it accidentally.
        const { frameGenOverride: _ignored, ...legacySettings } = settings;
        settingsForApply = legacySettings;
      }
    }
    const scope = enabled === true ? 'per-app' : 'global';
    const igclValue = GLOBAL_OR_PER_APP_TO_IGCL[scope];
    // GLOBAL_OR_PER_APP is the scope selector itself. Its ApplicationName
    // field is what makes the value executable-scoped, so do not require the
    // selector's own PerAppSupport bit (that bit describes whether the
    // selector can be nested under another app scope, not whether it can
    // select an app scope).
    if (!detail || detail.valueType !== CTL_PROPERTY_VALUE_TYPE.ENUM) {
      return { ok: false, perControl: { profileScope: { ok: false, errorCode: 'unsupported', message: 'the driver does not expose a per-game global/per-application selector' } } };
    }
    const gs = encode3dFeatureGetset({ featureType: CTL_3D_FEATURE.GLOBAL_OR_PER_APP, valueType: CTL_PROPERTY_VALUE_TYPE.ENUM, bSet: true, enumValue: igclValue, applicationName: appName });
    const setResult = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
    if (setResult !== CTL_RESULT.SUCCESS) {
      return { ok: false, perControl: { profileScope: { ok: false, errorCode: igclErrorCode(setResult) ?? 'io-failed', message: `IGCL ${describeResult(setResult)}` } } };
    }
    const rb = encode3dFeatureGetset({ featureType: CTL_3D_FEATURE.GLOBAL_OR_PER_APP, valueType: CTL_PROPERTY_VALUE_TYPE.ENUM, bSet: false, applicationName: appName });
    const getResult = lib.ctlGetSet3DFeature(dev.handle, rb.buf);
    const got = getResult === CTL_RESULT.SUCCESS ? decode3dFeatureGetsetValue(rb.buf, CTL_PROPERTY_VALUE_TYPE.ENUM).enableType : null;
    const readBackEqual = got === igclValue;
    result.perControl.profileScope = {
      ok: readBackEqual,
      errorCode: readBackEqual ? undefined : 'io-failed',
      message: readBackEqual ? undefined : `read-back ${got ?? describeResult(getResult)} != requested ${scope}`,
      readBackEqual,
    };
    if (!readBackEqual) return { ...result, ok: false };
    if (enabled !== true) return result;
    const applied = await this.setGraphicsSettings(deviceId, settingsForApply, appName);
    return { ok: result.ok && applied.ok, perControl: { ...result.perControl, ...applied.perControl } };
  }

  /**
   * M8: read the Graphics tab's driver state. NEVER throws - every failure
   * (missing symbols, ctl errors, the ArcticControl read-crash) degrades to
   * the all-false/null GraphicsState. The per-feature reads are defensive
   * (try/catch per feature - a crash artifact must never take the surface
   * down). The `supportedOptions` lists gate the page's dropdown options on
   * the driver's SupportedTypes bitmask (Speed Sync etc.).
   * @param {number} deviceId
   * @returns {Promise<import('./backend.interface.js').GraphicsState>}
   */
  async getGraphicsSettings(deviceId) {
    try {
      const lib = this._libOrThrow();
      const dev = await this._device(deviceId);
      const threeDSurface = !this._isUnavailable(lib.ctlGetSupported3DCapabilities)
        && !this._isUnavailable(lib.ctlGetSet3DFeature);
      // The shared-memory override is a DxgKrnl registry control, not an
      // IGCL 3D feature. Keep it readable on an integrated/mobile adapter even if a
      // particular runtime lacks the optional 3D symbols.
      const features = threeDSurface ? await this._graphicsCapsOf(deviceId, dev.handle) : new Map();
      if (threeDSurface && !features) return this._graphicsDegraded();

      const supported = {
        frameGen: features.has(CTL_3D_FEATURE.FRAME_GENERATION),
        flipModes: features.has(CTL_3D_FEATURE.GAMING_FLIP_MODES),
        frameLimit: features.has(CTL_3D_FEATURE.FRAME_LIMIT),
        lowLatency: features.has(CTL_3D_FEATURE.LOW_LATENCY),
      };
      const prebuiltDetail = features.get(CTL_3D_FEATURE.PREBUILT_SHADER_DOWNLOAD);
      const prebuiltSupported = isBattlemageGpuName(dev.name, dev)
        && prebuiltDetail?.valueType === CTL_PROPERTY_VALUE_TYPE.BOOL;
      if (prebuiltSupported) supported.prebuiltShaderDownload = true;
      const flipDetail = features.get(CTL_3D_FEATURE.GAMING_FLIP_MODES);
      const llDetail = features.get(CTL_3D_FEATURE.LOW_LATENCY);
      const supportedOptions = {
        // M8 probe: the driver exposes NO flag restrictions on the XeSS FG
        // override (SupportedTypes 0x0) - all four options are offered while
        // the feature is supported.
        frameGen: supported.frameGen ? [...GRAPHICS_FRAME_GEN_OPTIONS] : [],
        flipModes: supported.flipModes && flipDetail?.enumSupportedTypes != null
          ? GRAPHICS_FLIP_MODE_OPTIONS.filter((m) => (flipDetail.enumSupportedTypes & BigInt(GRAPHICS_FLIP_TO_IGCL[m])) !== 0n)
          : [],
        lowLatency: supported.lowLatency && llDetail?.enumSupportedTypes != null
          ? GRAPHICS_LOW_LATENCY_OPTIONS.filter((m) => (llDetail.enumSupportedTypes & (1n << BigInt(GRAPHICS_LL_TO_IGCL[m]))) !== 0n)
          : [],
      };
      const flDetail = features.get(CTL_3D_FEATURE.FRAME_LIMIT);
      const frameLimitRange = flDetail?.intRange ? { ...flDetail.intRange } : null;

      // Defensive per-feature reads (the ArcticControl read-crash caveat):
      // one try/catch per feature, a throwing/refused read degrades to null.
      const readEnum = (featureType, fromIgcl) => {
        try {
          const gs = encode3dFeatureGetset({ featureType, valueType: CTL_PROPERTY_VALUE_TYPE.ENUM, bSet: false });
          const r = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
          if (r !== CTL_RESULT.SUCCESS) return null;
          const { enableType } = decode3dFeatureGetsetValue(gs.buf, CTL_PROPERTY_VALUE_TYPE.ENUM);
          return fromIgcl[enableType] ?? null;
        } catch {
          return null;
        }
      };
      const readBool = (featureType) => {
        try {
          const gs = encode3dFeatureGetset({ featureType, valueType: CTL_PROPERTY_VALUE_TYPE.BOOL, bSet: false });
          const r = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
          return r === CTL_RESULT.SUCCESS
            ? decode3dFeatureGetsetValue(gs.buf, CTL_PROPERTY_VALUE_TYPE.BOOL).enable === true
            : null;
        } catch {
          return null;
        }
      };
      const values = {
        frameGenOverride: supported.frameGen ? readEnum(CTL_3D_FEATURE.FRAME_GENERATION, GRAPHICS_FG_FROM_IGCL) : null,
        flipMode: supported.flipModes ? readEnum(CTL_3D_FEATURE.GAMING_FLIP_MODES, GRAPHICS_FLIP_FROM_IGCL) : null,
        frameLimit: null,
        lowLatency: supported.lowLatency ? readEnum(CTL_3D_FEATURE.LOW_LATENCY, GRAPHICS_LL_FROM_IGCL) : null,
      };
      if (prebuiltSupported) values.prebuiltShaderDownload = readBool(CTL_3D_FEATURE.PREBUILT_SHADER_DOWNLOAD);
      if (supported.frameLimit) {
        try {
          const gs = encode3dFeatureGetset({ featureType: CTL_3D_FEATURE.FRAME_LIMIT, valueType: CTL_PROPERTY_VALUE_TYPE.INT32, bSet: false });
          const r = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
          if (r === CTL_RESULT.SUCCESS) {
            const v = decode3dFeatureGetsetValue(gs.buf, CTL_PROPERTY_VALUE_TYPE.INT32);
            values.frameLimit = { enabled: v.enable === true, value: v.value };
          }
        } catch {
          values.frameLimit = null;
        }
      }

      const platform = endurancePlatformSupported(dev, this._laptopInfoOf ? this._laptopInfoOf() : null);
      const sharedMemoryPlatform = sharedMemoryPlatformSupported(dev, this._systemInfoOf ? this._systemInfoOf() : null);
      let sharedMemoryRange;
      if (platform) {
        const enduranceDetail = enduranceDetailOf(lib, dev.handle, features);
        if (enduranceValueTypeSupported(enduranceDetail?.valueType)) {
          const enduranceOptions = enduranceControlOptionsOf(enduranceDetail);
          const enduranceModes = enduranceModeOptionsOf(enduranceDetail);
          supported.enduranceGaming = enduranceOptions.length > 0;
          supportedOptions.enduranceGaming = enduranceOptions;
          supportedOptions.enduranceGamingModes = enduranceModes;
          const enduranceValue = readEnduranceGamingValue(lib, dev.handle, enduranceDetail);
          values.enduranceGaming = enduranceValue?.enduranceGaming ?? null;
          values.enduranceGamingMode = enduranceValue?.enduranceGamingMode ?? null;
        } else {
          supported.enduranceGaming = false;
          supportedOptions.enduranceGaming = [];
          supportedOptions.enduranceGamingModes = [];
          values.enduranceGaming = null;
          values.enduranceGamingMode = null;
        }

      }

      // Shared GPU/NPU memory is independent of the 3D feature table. Keep
      // it outside the Endurance branch so a driver that omits feature 1
      // cannot hide a valid MemoryManager-backed control.
      if (sharedMemoryPlatform && this._sharedMemoryOverride && typeof this._sharedMemoryOverride.read === 'function') {
        try {
          const shared = await this._sharedMemoryOverride.read(dev);
          if (shared) {
            supported.sharedMemoryOverride = true;
            values.sharedMemoryOverride = {
              enabled: shared.enabled === true,
              percentage: Number(shared.percentage),
            };
            sharedMemoryRange = shared.range ? { ...shared.range } : null;
          }
        } catch {
          // A registry read failure must not hide the IGCL controls.
        }
      }

      return {
        supported,
        supportedOptions,
        frameLimitRange,
        ...(sharedMemoryRange ? { sharedMemoryRange } : {}),
        values,
      };
    } catch {
      return this._graphicsDegraded();
    }
  }

  /**
   * M8: apply the Graphics tab's settings (the DEDICATED graphics apply
   * path - NOT the OC apply-routing machinery: 3D features have no OC
   * waiver and no OC-mode gate). Returns the ApplyResult shape with one
   * per-control entry per requested feature. Every set is followed by a
   * read-back verification (the plan's every-apply-verified rule). The
   * error mapping reuses the generic branch of igclErrorCode; the
   * 0x60000000-range 3D codes fall through to the honest 'io-failed'
   * fallback (never raw hex in the UI).
   * @param {number} deviceId
   * @param {import('./backend.interface.js').GraphicsSettings} settings
   * @returns {Promise<import('./backend.interface.js').ApplyResult>}
   */
  async setGraphicsSettings(deviceId, settings = {}, applicationName = '') {
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    // IGCL's ApplicationName field is the executable name, not a full system
    // path. Normalize callers' catalog paths here so per-game read/write uses
    // the same identity the driver expects.
    const appScope = typeof applicationName === 'string' && applicationName.length > 0
      ? path.win32.basename(applicationName)
      : '';
    const result = { ok: true, perControl: {} };
    const fail = (control, errorCode, message) => {
      result.perControl[control] = { ok: false, errorCode, message };
      result.ok = false;
    };
    const threeDSurface = !this._isUnavailable(lib.ctlGetSupported3DCapabilities)
      && !this._isUnavailable(lib.ctlGetSet3DFeature);
    const featureMap = threeDSurface ? await this._graphicsCapsOf(deviceId, dev.handle) : null;
    const features = featureMap ?? new Map();
    const surfaceUp = featureMap !== null && threeDSurface;
    const controls = ['enduranceGaming', 'enduranceGamingMode', 'sharedMemoryOverride', 'frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency', 'prebuiltShaderDownload']
      .filter((c) => settings[c] !== null && settings[c] !== undefined);

    // Shared GPU/NPU memory is a Windows graphics-memory-manager setting and
    // is intentionally independent of the 3D-feature surface.
    if (settings.sharedMemoryOverride !== null && settings.sharedMemoryOverride !== undefined) {
      const platform = sharedMemoryPlatformSupported(dev, this._systemInfoOf ? this._systemInfoOf() : null);
      if (!platform) {
        fail('sharedMemoryOverride', 'unsupported', 'Shared GPU/NPU Memory Override requires an eligible Intel integrated or mobile platform.');
      } else if (!this._sharedMemoryOverride || typeof this._sharedMemoryOverride.set !== 'function') {
        fail('sharedMemoryOverride', 'unavailable-symbol', 'the Windows graphics-memory manager adapter is unavailable');
      } else {
        try {
          const memoryResult = await this._sharedMemoryOverride.set(dev, settings.sharedMemoryOverride);
          result.perControl.sharedMemoryOverride = {
            ok: memoryResult?.ok === true,
            errorCode: memoryResult?.ok === true ? undefined : (memoryResult?.errorCode ?? 'io-failed'),
            message: memoryResult?.message,
            readBackEqual: memoryResult?.readBackEqual,
            warning: memoryResult?.requiresRestart === true
              ? 'Restart Windows for the new shared-memory limit to take effect.'
              : undefined,
          };
          if (memoryResult?.ok !== true) result.ok = false;
        } catch {
          fail('sharedMemoryOverride', 'io-failed', 'the shared-memory override could not be applied');
        }
      }
    }

    const nativeControls = controls.filter((c) => c !== 'sharedMemoryOverride');
    if (!surfaceUp) {
      for (const c of nativeControls) {
        fail(c, 'unavailable-symbol', 'the 3D-feature API is missing in the IGCL runtime');
      }
      return result;
    }

    const setEnum = (control, featureType, canonical, toIgcl, optionOk) => {
      const igclValue = toIgcl[canonical];
      if (igclValue === undefined) {
        fail(control, 'out-of-range', `unknown ${control} value '${canonical}'`);
        return;
      }
      if (optionOk && !optionOk(igclValue)) {
        fail(control, 'unsupported', `the '${canonical}' option is not supported by this driver`);
        return;
      }
      const detail = features.get(featureType);
      if (appScope && detail?.perAppSupport !== true) {
        fail(control, 'unsupported', `${control} is not exposed as a per-game driver setting`);
        return;
      }
      const gs = encode3dFeatureGetset({ featureType, valueType: CTL_PROPERTY_VALUE_TYPE.ENUM, bSet: true, enumValue: igclValue, applicationName: appScope });
      const setResult = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
      if (setResult !== CTL_RESULT.SUCCESS) {
        fail(control, igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
        return;
      }
      // Read-back verification (the plan's every-apply-verified rule).
      const rb = encode3dFeatureGetset({ featureType, valueType: CTL_PROPERTY_VALUE_TYPE.ENUM, bSet: false, applicationName: appScope });
      const getResult = lib.ctlGetSet3DFeature(dev.handle, rb.buf);
      let readBackEqual = false;
      let message;
      if (getResult !== CTL_RESULT.SUCCESS) {
        message = `set succeeded but read-back failed (${describeResult(getResult)})`;
      } else {
        const got = decode3dFeatureGetsetValue(rb.buf, CTL_PROPERTY_VALUE_TYPE.ENUM).enableType;
        readBackEqual = got === igclValue;
        message = readBackEqual ? undefined : `read-back ${got} != requested ${igclValue}`;
      }
      result.perControl[control] = {
        ok: readBackEqual,
        errorCode: readBackEqual ? undefined : 'io-failed',
        message,
        readBackEqual,
        // F3 silent no-op: SUCCESS from the setter with an unchanged value.
        silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
      };
      if (!readBackEqual) result.ok = false;
    };

    const setBool = (control, featureType, requested) => {
      const detail = features.get(featureType);
      if (!detail || detail.valueType !== CTL_PROPERTY_VALUE_TYPE.BOOL) {
        fail(control, 'unsupported', `${control} is not supported by this driver`);
        return;
      }
      if (appScope && detail.perAppSupport !== true) {
        fail(control, 'unsupported', `${control} is not exposed as a per-game driver setting`);
        return;
      }
      const gs = encode3dFeatureGetset({ featureType, valueType: CTL_PROPERTY_VALUE_TYPE.BOOL, bSet: true, intEnable: requested, applicationName: appScope });
      const setResult = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
      if (setResult !== CTL_RESULT.SUCCESS) {
        fail(control, igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
        return;
      }
      const rb = encode3dFeatureGetset({ featureType, valueType: CTL_PROPERTY_VALUE_TYPE.BOOL, bSet: false, applicationName: appScope });
      const getResult = lib.ctlGetSet3DFeature(dev.handle, rb.buf);
      const got = getResult === CTL_RESULT.SUCCESS
        ? decode3dFeatureGetsetValue(rb.buf, CTL_PROPERTY_VALUE_TYPE.BOOL).enable === true
        : null;
      const readBackEqual = got === (requested === true);
      result.perControl[control] = {
        ok: readBackEqual,
        errorCode: readBackEqual ? undefined : 'io-failed',
        message: readBackEqual ? undefined : `read-back ${got} != requested ${requested === true}`,
        readBackEqual,
        silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
      };
      if (!readBackEqual) result.ok = false;
    };

    if (settings.prebuiltShaderDownload !== null && settings.prebuiltShaderDownload !== undefined) {
      if (!features.has(CTL_3D_FEATURE.PREBUILT_SHADER_DOWNLOAD)
        || !isBattlemageGpuName(dev.name, dev)) {
        fail('prebuiltShaderDownload', 'unsupported', 'Precompiled Shaders are not supported on this GPU');
      } else {
        setBool('prebuiltShaderDownload', CTL_3D_FEATURE.PREBUILT_SHADER_DOWNLOAD, settings.prebuiltShaderDownload);
      }
    }

    if ((settings.enduranceGaming !== null && settings.enduranceGaming !== undefined)
      || (settings.enduranceGamingMode !== null && settings.enduranceGamingMode !== undefined)) {
      const platform = endurancePlatformSupported(dev, this._laptopInfoOf ? this._laptopInfoOf() : null);
      const detail = platform ? enduranceDetailOf(lib, dev.handle, features) : null;
      const valueType = detail?.valueType;
      if (!platform || !detail || !enduranceValueTypeSupported(valueType)) {
        if (settings.enduranceGaming !== null && settings.enduranceGaming !== undefined) {
          fail('enduranceGaming', 'unsupported', 'Endurance Gaming is only available on supported Intel integrated or mobile graphics.');
        }
        if (settings.enduranceGamingMode !== null && settings.enduranceGamingMode !== undefined) {
          fail('enduranceGamingMode', 'unsupported', 'Endurance Gaming presets are only available on supported Intel integrated or mobile graphics.');
        }
      } else if (appScope && detail.perAppSupport !== true) {
        if (settings.enduranceGaming !== null && settings.enduranceGaming !== undefined) {
          fail('enduranceGaming', 'unsupported', 'Endurance Gaming is not exposed as a per-game driver setting.');
        }
        if (settings.enduranceGamingMode !== null && settings.enduranceGamingMode !== undefined) {
          fail('enduranceGamingMode', 'unsupported', 'Endurance Gaming presets are not exposed as a per-game driver setting.');
        }
      } else if (valueType === CTL_PROPERTY_VALUE_TYPE.ENUM
        && settings.enduranceGamingMode !== null && settings.enduranceGamingMode !== undefined) {
        fail('enduranceGamingMode', 'unsupported', 'This driver exposes Endurance Gaming without selectable FPS presets.');
      } else if (valueType === CTL_PROPERTY_VALUE_TYPE.ENUM) {
        // Older driver branches report the control as an enum. They do not
        // expose the separate FPS presets on this ABI.
        const optionOk = (v) => enduranceControlOptionsOf(detail).some((name) => ENDURANCE_CONTROL_TO_IGCL[name] === v);
        setEnum('enduranceGaming', CTL_3D_FEATURE.ENDURANCE_GAMING, settings.enduranceGaming, ENDURANCE_CONTROL_TO_IGCL, optionOk);
      } else if (valueType === CTL_PROPERTY_VALUE_TYPE.INT32 || valueType === CTL_PROPERTY_VALUE_TYPE.UINT32) {
        // Some older IGCL builds describe Endurance as an integer feature:
        // the enable bit controls Off/On and the integer is the DC-mode
        // target FPS. The IGS Performance/Balanced/Battery presets are
        // exactly 60/40/30 FPS on this ABI.
        const requestedControl = settings.enduranceGaming;
        const requestedMode = settings.enduranceGamingMode;
        const current = readEnduranceGamingValue(lib, dev.handle, detail, appScope);
        const options = enduranceControlOptionsOf(detail);
        const modes = enduranceModeOptionsOf(detail);
        if (requestedControl === 'auto') {
          fail('enduranceGaming', 'unsupported', 'This IGCL driver exposes Endurance Gaming as an On/Off FPS control; Auto is managed by the Intel Graphics Software profile layer.');
        } else if (requestedControl !== null && requestedControl !== undefined && !options.includes(requestedControl)) {
          fail('enduranceGaming', 'out-of-range', `unknown Endurance Gaming control '${requestedControl}'`);
        } else if (requestedMode !== null && requestedMode !== undefined && !modes.includes(requestedMode)) {
          fail('enduranceGamingMode', 'unsupported', 'The requested Endurance Gaming preset is outside this driver\'s supported FPS range.');
        } else if ((requestedControl === null || requestedControl === undefined || requestedMode === null || requestedMode === undefined)
          && (!current
            || (requestedControl !== null && requestedControl !== undefined && !Number.isFinite(current.enduranceGamingFps))
            || (requestedMode !== null && requestedMode !== undefined && typeof current.enduranceGaming !== 'string'))) {
          // A partial update must preserve the omitted sibling. If the
          // current per-app/global value could not be read, refuse without a
          // write instead of silently resetting the sibling to a fallback.
          if (requestedControl !== null && requestedControl !== undefined) {
            fail('enduranceGaming', 'io-failed', 'The current Endurance Gaming value could not be read; no change was written.');
          }
          if (requestedMode !== null && requestedMode !== undefined) {
            fail('enduranceGamingMode', 'io-failed', 'The current Endurance Gaming value could not be read; no change was written.');
          }
        } else if (
          (requestedControl !== null && requestedControl !== undefined)
          || (requestedMode !== null && requestedMode !== undefined)
        ) {
          const range = detail.intRange;
          const requestedFps = requestedMode !== null && requestedMode !== undefined
            ? ENDURANCE_MODE_TO_FPS[requestedMode]
            : current?.enduranceGamingFps;
          const targetFps = range && Number.isFinite(requestedFps)
            ? clampAndSnap(requestedFps, range)
            : range && Number.isFinite(range.default) ? clampAndSnap(range.default, range) : 60;
          const enabled = requestedControl === 'on'
            ? true
            : requestedControl === 'off'
              ? false
              : current?.enduranceGaming === 'on';
          const gs = encode3dFeatureGetset({
            featureType: CTL_3D_FEATURE.ENDURANCE_GAMING,
            valueType,
            bSet: true,
            intEnable: enabled,
            intValue: targetFps,
            applicationName: appScope,
          });
          const setResult = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            const errorCode = igclErrorCode(setResult) ?? 'io-failed';
            if (requestedControl !== null && requestedControl !== undefined) fail('enduranceGaming', errorCode, `IGCL ${describeResult(setResult)}`);
            if (requestedMode !== null && requestedMode !== undefined) fail('enduranceGamingMode', errorCode, `IGCL ${describeResult(setResult)}`);
          } else {
            const rb = encode3dFeatureGetset({ featureType: CTL_3D_FEATURE.ENDURANCE_GAMING, valueType, bSet: false, applicationName: appScope });
            const getResult = lib.ctlGetSet3DFeature(dev.handle, rb.buf);
            const got = getResult === CTL_RESULT.SUCCESS ? decode3dFeatureGetsetValue(rb.buf, valueType) : null;
            const controlEqual = requestedControl === null || requestedControl === undefined || got?.enable === enabled;
            const modeEqual = requestedMode === null || requestedMode === undefined || got?.value === targetFps;
            const readBackMessage = (equal) => equal ? undefined : `read-back ${got ? JSON.stringify(got) : describeResult(getResult)} did not match the requested Endurance Gaming value`;
            if (requestedControl !== null && requestedControl !== undefined) {
              result.perControl.enduranceGaming = {
                ok: controlEqual,
                errorCode: controlEqual ? undefined : 'io-failed',
                message: readBackMessage(controlEqual),
                readBackEqual: controlEqual,
                silentNoop: setResult === CTL_RESULT.SUCCESS && !controlEqual,
              };
              if (!controlEqual) result.ok = false;
            }
            if (requestedMode !== null && requestedMode !== undefined) {
              result.perControl.enduranceGamingMode = {
                ok: modeEqual,
                errorCode: modeEqual ? undefined : 'io-failed',
                message: readBackMessage(modeEqual),
                readBackEqual: modeEqual,
                silentNoop: setResult === CTL_RESULT.SUCCESS && !modeEqual,
              };
              if (!modeEqual) result.ok = false;
            }
          }
        }
      } else {
        if (settings.enduranceGaming !== null && settings.enduranceGaming !== undefined) {
          fail('enduranceGaming', 'unsupported', 'This driver exposes an undocumented Endurance Gaming value type.');
        }
        if (settings.enduranceGamingMode !== null && settings.enduranceGamingMode !== undefined) {
          fail('enduranceGamingMode', 'unsupported', 'This driver exposes an undocumented Endurance Gaming value type.');
        }
      }
    }

    if (settings.frameGenOverride !== null && settings.frameGenOverride !== undefined) {
      if (!features.has(CTL_3D_FEATURE.FRAME_GENERATION)) {
        fail('frameGenOverride', 'unsupported', 'XeSS frame generation is not supported on this device');
      } else {
        setEnum('frameGenOverride', CTL_3D_FEATURE.FRAME_GENERATION, settings.frameGenOverride, GRAPHICS_FG_TO_IGCL, null);
      }
    }

    if (settings.flipMode !== null && settings.flipMode !== undefined) {
      if (!features.has(CTL_3D_FEATURE.GAMING_FLIP_MODES)) {
        fail('flipMode', 'unsupported', 'frame synchronization is not supported on this device');
      } else {
        const detail = features.get(CTL_3D_FEATURE.GAMING_FLIP_MODES);
        const optionOk = detail?.enumSupportedTypes != null
          ? (v) => (detail.enumSupportedTypes & BigInt(v)) !== 0n
          : null;
        setEnum('flipMode', CTL_3D_FEATURE.GAMING_FLIP_MODES, settings.flipMode, GRAPHICS_FLIP_TO_IGCL, optionOk);
      }
    }

    if (settings.lowLatency !== null && settings.lowLatency !== undefined) {
      if (!features.has(CTL_3D_FEATURE.LOW_LATENCY)) {
        fail('lowLatency', 'unsupported', 'low latency mode is not supported on this device');
      } else {
        // M10b (fix): NO caps pre-gate on the low-latency set - the M8
        // probe recorded LOW_LATENCY caps 0x3 (off/on only) yet the driver
        // ACCEPTS TURN_ON_BOOST_MODE_ON (the Intel Graphics Software proves
        // it); the old optionOk gate refused 'on-boost' BEFORE the set and
        // the apply failed with 'not supported in the driver' while
        // IGS itself offers On + Boost and it works. The set now attempts
        // the REAL driver set and lets the driver's ACTUAL result decide - a
        // genuine refusal still surfaces honestly through the ApplyResult
        // machinery (fail() below). The caps stay a UI hint only (the
        // getGraphicsSettings supportedOptions list still mirrors them).
        setEnum('lowLatency', CTL_3D_FEATURE.LOW_LATENCY, settings.lowLatency, GRAPHICS_LL_TO_IGCL, null);
      }
    }

    if (settings.frameLimit !== null && settings.frameLimit !== undefined) {
      if (!features.has(CTL_3D_FEATURE.FRAME_LIMIT)) {
        fail('frameLimit', 'unsupported', 'the frame limit is not supported on this device');
      } else {
        const detail = features.get(CTL_3D_FEATURE.FRAME_LIMIT);
        const range = detail?.intRange;
        if (!range) {
          // M8 finding-5: no early `return result` here - the block closes
          // via the fall-through like the other controls (frameLimit being
          // the last control made the return behavior-equivalent, but it
          // was fragile: a control appended after it would be skipped).
          fail('frameLimit', 'unsupported', 'no capability range reported for the frame limit');
        } else {
          if (appScope && detail.perAppSupport !== true) {
            fail('frameLimit', 'unsupported', 'frame limit is not exposed as a per-game driver setting');
          } else {
          // Never assume the caller's value is in range (backend contract):
          // clamp to the driver-reported range, snap to the step.
          const clamped = clampAndSnap(settings.frameLimit.value, range);
          const gs = encode3dFeatureGetset({
            featureType: CTL_3D_FEATURE.FRAME_LIMIT,
            valueType: CTL_PROPERTY_VALUE_TYPE.INT32,
            bSet: true,
            intEnable: settings.frameLimit.enabled === true,
            intValue: clamped,
            applicationName: appScope,
          });
          const setResult = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            fail('frameLimit', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          } else {
            const rb = encode3dFeatureGetset({ featureType: CTL_3D_FEATURE.FRAME_LIMIT, valueType: CTL_PROPERTY_VALUE_TYPE.INT32, bSet: false, applicationName: appScope });
            const getResult = lib.ctlGetSet3DFeature(dev.handle, rb.buf);
            let readBackEqual = false;
            let message;
            if (getResult !== CTL_RESULT.SUCCESS) {
              message = `set succeeded but read-back failed (${describeResult(getResult)})`;
            } else {
              const got = decode3dFeatureGetsetValue(rb.buf, CTL_PROPERTY_VALUE_TYPE.INT32);
              readBackEqual = got.enable === (settings.frameLimit.enabled === true) && got.value === clamped;
              message = readBackEqual ? undefined : `read-back ${JSON.stringify(got)} != requested { enable: ${settings.frameLimit.enabled}, value: ${clamped} }`;
            }
            result.perControl.frameLimit = {
              ok: readBackEqual,
              errorCode: readBackEqual ? undefined : 'io-failed',
              message,
              readBackEqual,
              silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
            };
            if (!readBackEqual) result.ok = false;
          }
        }
      }
    }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // M10b - Display (the IGCL display-output surface)
  // -------------------------------------------------------------------------

  /**
   * The NEVER-THROW degraded DisplayState - the honest "no display
   * controls" surface (an empty display list: no display outputs
   * enumerated, or the display module's symbols are missing). Mirrored by
   * the mock's per-device degrade (the RID_MOCK_MULTI_DEVICE iGPU + the
   * RID_MOCK_DISPLAY_UNSUPPORTED knob).
   * @returns {import('./backend.interface.js').DisplayState}
   */
  _displayDegraded() {
    return { displays: [] };
  }

  /**
   * M10b: the per-device display-output handle cache (ctlEnumerate-
   * DisplayOutputs - the 3-arg signature: handle + count* + handles*; the
   * M10b probe caught the uniform-2-arg mistake that silently dropped the
   * output-handle writes and produced an empty display list). Handles are
   * stable per session (cached like the fan handles); the per-display
   * VALUES are never cached - every getDisplaySettings reads fresh.
   * @param {number} deviceId
   * @returns {Promise<object[]>}
   */
  async _displayOutputsOf(deviceId, refresh = false) {
    if (!refresh && this._displayHandles.has(deviceId)) return this._displayHandles.get(deviceId);
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const handles = [];
    if (!this._isUnavailable(lib.ctlEnumerateDisplayOutputs)) {
      const countBuf = koffi.alloc('uint32', 1);
      koffi.encode(countBuf, 'uint32', 0);
      let result = lib.ctlEnumerateDisplayOutputs(dev.handle, countBuf, null);
      const count = Number(koffi.decode(countBuf, 'uint32'));
      // Sanity-cap the count (a corrupt driver write must never size an
      // allocation); the probe: 30 outputs on the A770.
      if (result === CTL_RESULT.SUCCESS && count > 0 && count < 64) {
        const handlesBuf = koffi.alloc('void*', count);
        koffi.encode(countBuf, 'uint32', count);
        result = lib.ctlEnumerateDisplayOutputs(dev.handle, countBuf, handlesBuf);
        if (result === CTL_RESULT.SUCCESS) {
          for (let i = 0; i < count; i++) handles.push(koffi.decode(handlesBuf, i * 8, 'void*'));
        }
      }
    }
    this._displayHandles.set(deviceId, handles);
    return handles;
  }

  /**
   * M10b: the monitor-name read (the EDID 0xFC display-name descriptor).
   * ctlEdidManagement 2-pass (READ, MONITOR) first; ctlPanelDescriptorAccess
   * 2-pass (READ, block 0) is the fallback. The M10b probe: the management
   * call answered ERROR_KMD_CALL on the A770 and the panel-descriptor path
   * served the 128-byte block (name: MSI G27C4 E3). Null on any failure
   * path (never throws - the caller wraps it).
   * @param {object} handle the display handle
   * @returns {Promise<string | null>}
   */
  async _readDisplayName(handle) {
    const lib = this._libOrThrow();
    if (!this._isUnavailable(lib.ctlEdidManagement)) {
      try {
        let args = encodeEdidManagementArgs({ edidSize: 0 });
        let r = lib.ctlEdidManagement(handle, args.buf);
        if (r === CTL_RESULT.SUCCESS) {
          const size = Number(koffi.decode(args.buf, koffi.offsetof('ctl_edid_management_args_t', 'EdidSize'), 'uint32'));
          if (Number.isInteger(size) && size > 0 && size <= 4096) {
            const data = koffi.alloc('uint8', size);
            args = encodeEdidManagementArgs({ edidSize: size, pEdidBuf: koffi.address(data) });
            r = lib.ctlEdidManagement(handle, args.buf);
            if (r === CTL_RESULT.SUCCESS) {
              const name = edidMonitorName(data, size);
              if (name) return name;
            }
          }
        }
      } catch {
        // fall through to the panel-descriptor path
      }
    }
    if (!this._isUnavailable(lib.ctlPanelDescriptorAccess)) {
      try {
        let args = encodePanelDescriptorArgs({ dataSize: 0 });
        let r = lib.ctlPanelDescriptorAccess(handle, args.buf);
        if (r === CTL_RESULT.SUCCESS) {
          const size = Number(koffi.decode(args.buf, koffi.offsetof('ctl_panel_descriptor_access_args_t', 'DescriptorDataSize'), 'uint32'));
          if (Number.isInteger(size) && size > 0 && size <= 4096) {
            const data = koffi.alloc('uint8', size);
            args = encodePanelDescriptorArgs({ dataSize: size, pData: koffi.address(data) });
            r = lib.ctlPanelDescriptorAccess(handle, args.buf);
            if (r === CTL_RESULT.SUCCESS) {
              const name = edidMonitorName(data, size);
              if (name) return name;
            }
          }
        }
      } catch {
        // no name path succeeded - null
      }
    }
    return null;
  }

  /**
   * M10b: the plausible-timing filter (the probe's rule: an inactive
   * output reports an IMPLAUSIBLE 0x0 @ 0 Hz timing; a plausible timing is
   * the driver actually driving the output).
   * @param {{ pixelClockHz: number, hActive: number, vActive: number, refreshRate: number }} t
   * @returns {boolean}
   */
  _plausibleDisplayTiming(t) {
    return Number.isFinite(t.refreshRate) && t.refreshRate > 10 && t.refreshRate <= 1000
      && t.hActive > 320 && t.hActive <= 16384
      && t.vActive > 200 && t.vActive <= 16384
      && Number.isInteger(t.pixelClockHz) && t.pixelClockHz > 0 && t.pixelClockHz < 20000000000;
  }

  /**
   * M10b: one display output's canonical read. Every per-feature read is
   * defensive (try/catch per feature - a crash artifact or a refused read
   * degrades THAT feature only, never the surface). A display whose
   * properties read failed keeps the all-false flags - the caller excludes
   * it via flags.active (the probe: 30 outputs, ONE active on the A770).
   * @param {number} index the output index (display-only presentation id)
   * @param {object} handle the display handle
   * @param {string|null} deviceKey the stable physical adapter key
   * @param {object|null} adapterHandle the parent adapter handle (required by
   * the adapter-scoped retro/media APIs)
   * @returns {Promise<object>} the canonical display shape
   */
  async _readDisplayOutput(index, handle, deviceKey = null, adapterHandle = null, globalVrr = null, registryScalingState = null) {
    const lib = this._libOrThrow();
    const d = {
      id: index,
      displayKey: null,
      identityVerified: false,
      name: null,
      connection: 'Unknown',
      resolution: null,
      refreshRate: null,
      colorDepth: null,
      colorFormat: null,
      quantizationRange: null,
      scalingMode: null,
      preferredScalingMode: null,
      scalingPreference: null,
      scalingDetails: null,
      scalingMethod: displayCapability(null, false, false, 'Retro scaling is not exposed by the driver interface.'),
      globalVrrMode: displayCapability(null, null, false, 'Global Variable Refresh Rate Mode is not exposed by the driver interface.'),
      vrrMode: displayCapability(null, null, false, 'Arc Sync profile control is not exposed by the driver interface.'),
      variableRefreshRate: displayCapability(null, null, false, 'Variable refresh rate is controlled by Windows/the display path.'),
      vrrCurrentRange: displayCapability(null, null, false, 'The current variable refresh-rate range is not exposed by the driver interface.'),
      vrrMaximumRange: displayCapability(null, null, false, 'The maximum variable refresh-rate range is not exposed by the driver interface.'),
      hdcpSupport: displayCapability(null, null, false, 'HDCP support is not exposed by the driver interface.'),
      fourKSupport: displayCapability(null, null, false, '4K support is not exposed by the driver interface.'),
      hdrSupport: displayCapability(null, null, false, 'HDR support is not exposed by the driver interface.'),
      hue: displayCapability(null, false, false, 'Color calibration is not exposed by the driver interface.'),
      saturation: displayCapability(null, false, false, 'Color calibration is not exposed by the driver interface.'),
      brightness: displayCapability(null, false, false, 'Color calibration is not exposed by the driver interface.'),
      contrast: displayCapability(null, false, false, 'Color calibration is not exposed by the driver interface.'),
      supportedOptions: {
        scalingModes: [],
        scalingMethods: [],
        vrrModes: [],
        globalVrrModes: [],
        wireFormats: [],
        bpcDepths: [],
        quantizationRanges: [],
        colorRanges: {},
      },
      flags: { active: false, attached: false, dongleConnected: false, ditheringEnabled: false },
      arcSync: { supported: false, minRefreshHz: null, maxRefreshHz: null, profile: null },
    };
    if (globalVrr) {
      d.globalVrrMode = globalVrr.capability;
      d.supportedOptions.globalVrrModes = [...globalVrr.options];
    }
    // The canonical wire-model name (the bindings' enum names are
    // SCREAMING: 'YCBCR_422' -> the shared 'YCbCr422').
    const canonicalWireModel = (name) => {
      if (!name) return null;
      const num = Object.entries(CTL_WIRE_COLOR_MODEL).find(([, n]) => n === name)?.[0];
      return num === undefined ? null : (DISPLAY_WIRE_MODEL_FROM_IGCL[num] ?? null);
    };

    // Properties - the ONLY mandatory read (an inactive output's feature
    // reads refuse with ERROR_KMD_CALL anyway; the probe record).
    try {
      if (!this._isUnavailable(lib.ctlGetDisplayProperties)) {
        const { buf } = encodeDisplayProperties();
        const r = lib.ctlGetDisplayProperties(handle, buf);
        if (r === CTL_RESULT.SUCCESS) {
          const p = decodeDisplayProperties(buf);
          if (typeof deviceKey === 'string' && p.encoderId) {
            // The encoder handle is the driver-provided physical output
            // identity. The ordinal is intentionally excluded from this key
            // so hot-plug/re-enumeration cannot retarget another monitor.
            d.displayKey = `${deviceKey}|display|${p.encoderId}`;
            d.identityVerified = true;
          }
          d.connection = DISPLAY_CONNECTION_CANONICAL[p.type] ?? 'Unknown';
          d.flags = {
            active: (p.configFlags & 1) !== 0,
            attached: (p.configFlags & 2) !== 0,
            dongleConnected: (p.configFlags & 4) !== 0,
            ditheringEnabled: (p.configFlags & 8) !== 0,
          };
          // IGCL exposes standard display capabilities as bitmasks. HDCP and
          // HDR used to remain null because only the Adaptive Sync bit was
          // decoded here, even though the driver reported all three flags.
          const vrrSupported = (p.featureSupportedFlags & DISPLAY_FEATURE_ADAPTIVE_SYNC_VRR) !== 0;
          const vrrEnabled = (p.featureEnabledFlags & DISPLAY_FEATURE_ADAPTIVE_SYNC_VRR) !== 0;
          d.hdcpSupport = displayCapability(
            (p.featureSupportedFlags & DISPLAY_FEATURE_HDCP) !== 0,
            (p.featureSupportedFlags & DISPLAY_FEATURE_HDCP) !== 0,
            false,
            'Read-only display capability.',
            'igcl-display-properties',
          );
          d.hdrSupport = displayCapability(
            (p.featureSupportedFlags & DISPLAY_FEATURE_HDR) !== 0,
            (p.featureSupportedFlags & DISPLAY_FEATURE_HDR) !== 0,
            false,
            'Read-only display capability.',
            'igcl-display-properties',
          );
          if (this._plausibleDisplayTiming(p.timing)) {
            d.resolution = { width: p.timing.hActive, height: p.timing.vActive };
            d.refreshRate = p.timing.refreshRate;
          }
        }
      }
    } catch {
      // degrade this display's fields
    }
    if (!d.flags.active) return d;

    // Display settings (the quantization range + the driver's own
    // Controllable contract - a UI hint for the offered options; the SET
    // itself is never pre-gated, the driver's actual result decides).
    try {
      if (!this._isUnavailable(lib.ctlGetSetDisplaySettings)) {
        const { buf } = encodeDisplaySettings({ set: false });
        const r = lib.ctlGetSetDisplaySettings(handle, buf);
        if (r === CTL_RESULT.SUCCESS) {
          const ds = decodeDisplaySettings(buf);
          d.quantizationRange = DISPLAY_QUANT_FROM_IGCL[ds.quantizationRange] ?? null;
          if ((ds.controllableFlags & (1 << 3)) !== 0) {
            d.supportedOptions.quantizationRanges = [...DISPLAY_QUANTIZATION_OPTIONS];
          }
        }
      }
    } catch {
      // degrade the quantization surface
    }

    // Wire format. The nested structs are fully versioned and BPC values are
    // decoded from the driver's bitmask. A driver that returns only a
    // model-without-depth remains read-only because it cannot prove a
    // format/depth apply.
    try {
      if (!this._isUnavailable(lib.ctlGetSetWireFormat)) {
        const { buf } = encodeWireFormatConfig({ operation: 0 });
        const r = lib.ctlGetSetWireFormat(handle, buf);
        if (r === CTL_RESULT.SUCCESS) {
          const wf = decodeWireFormatConfig(buf);
          d.supportedOptions.wireFormats = [...new Set((wf.supportedModels ?? wf.supported.map((s) => s.model)).map((s) => canonicalWireModel(s)))].filter(Boolean);
          d.supportedOptions.bpcDepths = [...new Set(wf.supported.map((s) => s.depth))];
          if (wf.currentUnavailable) {
            d.colorFormat = canonicalWireModel(wf.currentModel);
            d.colorDepth = null;
          } else if (wf.current) {
            d.colorFormat = canonicalWireModel(wf.current.model);
            d.colorDepth = wf.current.depth;
          }
        }
      }
    } catch {
      // degrade the wire-format surface
    }

    // Pixel transformation is the per-output desktop color path. Prefer its
    // output format over the legacy wire-format read when both are present:
    // the A770 reports an empty-depth YCbCr422 wire slot even while the
    // active output is RGB (the state shown by IGS).
    let pixelTransform = null;
    let pixelCurrent = null;
    try {
      pixelTransform = readPixelTransformation(lib, handle);
      pixelCurrent = readPixelTransformation(lib, handle, { queryType: PIXEL_QUERY_CURRENT });
      if (pixelTransform?.outputFormat) {
        const outputModel = PIXEL_COLOR_MODEL_TO_WIRE[pixelTransform.outputFormat.model] ?? null;
        if (outputModel) d.colorFormat = outputModel;
        if (pixelTransform.outputFormat.bitsPerColor > 0) d.colorDepth = pixelTransform.outputFormat.bitsPerColor;
      }
    } catch {
      pixelTransform = null;
    }

    // Scaling: the driver's SupportedScaling bitmask (the offered options)
    // + the current scaling type (a FLAG value - the probe's live read:
    // 0x1 = IDENTITY).
    try {
      if (!this._isUnavailable(lib.ctlGetSupportedScalingCapability) && !this._isUnavailable(lib.ctlGetCurrentScaling)) {
        const capsBuf = koffi.alloc('uint8', koffi.sizeof('ctl_scaling_caps_t') + 16);
        koffi.encode(capsBuf, 0, 'uint32', koffi.sizeof('ctl_scaling_caps_t'));
        koffi.encode(capsBuf, 4, 'uint8', 0);
        const capsResult = lib.ctlGetSupportedScalingCapability(handle, capsBuf);
        if (capsResult === CTL_RESULT.SUCCESS) {
          const capsFlags = Number(koffi.decode(capsBuf, 8, 'uint32')) >>> 0;
          d.supportedOptions.scalingModes = displayFlagNames(capsFlags, CTL_SCALING_TYPE)
            .map((n) => DISPLAY_SCALING_NAME_TO_CANONICAL[n])
            .filter(Boolean);
        }
        // Version 1 includes the OS-persisted PreferredScalingType field;
        // older drivers may only accept the Version 0 active/native surface.
        const current = getScalingWithCompatibility(lib, handle);
        if (current.getResult === CTL_RESULT.SUCCESS && current.settings) {
          const sc = current.settings;
          d.scalingMode = DISPLAY_SCALING_MODE_FROM_IGCL[sc.scalingType] ?? null;
          d.preferredScalingMode = current.version === 1
            ? DISPLAY_SCALING_MODE_FROM_IGCL[sc.preferredScalingType] ?? null
            : null;
          d.scalingDetails = {
            customX: sc.customX,
            customY: sc.customY,
            hardwareModeSet: sc.hardwareModeSet,
            preferredScalingType: current.version === 1
              ? DISPLAY_SCALING_MODE_FROM_IGCL[sc.preferredScalingType] ?? null
              : null,
          };
          // Some Intel driver builds keep returning IDENTITY from the
          // output-handle GET while IGS persists the ordinary GPU/Display
          // choice in NNScalingState. Keep that preference as a separate
          // view hint; it cannot identify Centered/Stretch/Aspect Ratio.
          if (d.scalingMode === 'identity' && registryScalingState?.ok === true) {
            d.scalingPreference = registryScalingState.value === SCALING_STATE_GPU ? 'gpu-scaling' : 'display-scaling';
            d.scalingDetails.registryScalingState = registryScalingState.value;
          }
        }
      }
    } catch {
      // degrade the scaling surface
    }

    // Retro scaling is a separate driver surface from ordinary scaling. Read
    // both the capability bitmask and the current enabled/type pair so the
    // renderer can expose it only when a complete verified contract exists.
    try {
      if (!this._isUnavailable(lib.ctlGetSupportedRetroScalingCapability)
        && !this._isUnavailable(lib.ctlGetSetRetroScaling)) {
        const caps = encodeRetroScalingCaps();
        const capsResult = lib.ctlGetSupportedRetroScalingCapability(adapterHandle ?? handle, caps.buf);
        if (capsResult === CTL_RESULT.SUCCESS) {
          const flags = decodeRetroScalingCaps(caps.buf).supportedRetroScaling;
          d.supportedOptions.scalingMethods = displayFlagNames(flags, CTL_RETRO_SCALING_TYPE)
            .map((name) => ({ INTEGER: 'integer', NEAREST_NEIGHBOUR: 'nearest-neighbour' }[name]))
            .filter(Boolean);
          // The driver exposes these as the two canonical flag values. Keep
          // the mapping explicit so an unexpected future flag cannot become a
          // writable option by accident.
          d.supportedOptions.scalingMethods = [...new Set(d.supportedOptions.scalingMethods)];
          const current = encodeRetroScalingSettings({ get: true });
          const currentResult = lib.ctlGetSetRetroScaling(adapterHandle ?? handle, current.buf);
          if (currentResult === CTL_RESULT.SUCCESS) {
            const value = decodeRetroScalingSettings(current.buf);
            const method = DISPLAY_RETRO_SCALING_METHOD_FROM_IGCL[value.retroScalingType] ?? null;
            d.scalingMethod = displayCapability(
              method ? { enabled: value.enable, method } : null,
              d.supportedOptions.scalingMethods.length > 0,
              d.supportedOptions.scalingMethods.length > 0,
              method ? null : 'The driver returned an unknown retro-scaling method.',
            );
          } else {
            d.scalingMethod = displayCapability(null, d.supportedOptions.scalingMethods.length > 0, false, 'Retro scaling read-back failed.');
          }
        }
      }
    } catch {
      // degrade the retro-scaling surface
    }

    // Arc Sync - read the monitor capability and current profile. The setter
    // is advertised as controllable only when both GET and SET symbols exist;
    // every write still performs a same-output read-back.
    try {
      if (!this._isUnavailable(lib.ctlGetIntelArcSyncInfoForMonitor)) {
        const buf = koffi.alloc('uint8', koffi.sizeof('ctl_intel_arc_sync_monitor_params_t') + 16);
        koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_intel_arc_sync_monitor_params_t'));
        koffi.encode(buf, 4, 'uint8', 0);
        const r = lib.ctlGetIntelArcSyncInfoForMonitor(handle, buf);
        if (r === CTL_RESULT.SUCCESS) {
          const m = decodeArcSyncMonitor(buf);
          d.arcSync.supported = m.supported === true;
          d.arcSync.minRefreshHz = m.supported ? m.minRefreshHz : null;
          d.arcSync.maxRefreshHz = m.supported ? m.maxRefreshHz : null;
          d.vrrMaximumRange = displayCapability(m.supported ? `${m.minRefreshHz} Hz - ${m.maxRefreshHz} Hz` : null, m.supported, false, 'Read-only driver capability.');
        }
      }
    } catch {
      // degrade the arc-sync surface
    }
    try {
      if (this._igscFullOk !== false && !this._isUnavailable(lib.ctlGetIntelArcSyncProfile)) {
        const current = encodeArcSyncProfile();
        const buf = current.buf;
        const r = lib.ctlGetIntelArcSyncProfile(handle, buf);
        if (r === CTL_RESULT.SUCCESS) {
          const p = decodeArcSyncProfile(buf);
          d.arcSync.profile = DISPLAY_ARC_SYNC_PROFILE_CANONICAL[p.profile] ?? null;
          const canControl = !this._isUnavailable(lib.ctlGetIntelArcSyncProfile)
            && !this._isUnavailable(lib.ctlSetIntelArcSyncProfile);
          d.vrrMode = displayCapability(
            d.arcSync.profile,
            d.arcSync.supported,
            d.arcSync.supported && canControl,
            d.arcSync.supported && d.arcSync.profile
              ? (canControl ? null : 'Arc Sync setter is not available in this driver runtime.')
              : 'Arc Sync is not supported by this display.',
          );
          // Intel Graphics Software implements its separate Variable Refresh
          // Rate switch by selecting the Arc Sync RECOMMENDED profile (1) or
          // OFF profile (5). Keep the profile's timing fields untouched and
          // expose the switch as enabled for every non-OFF profile.
          const variableRefreshRateControllable = !this._isUnavailable(lib.ctlGetIntelArcSyncProfile)
            && !this._isUnavailable(lib.ctlSetIntelArcSyncProfile);
          const recognizedProfile = d.arcSync.supported
            && DISPLAY_ARC_SYNC_PROFILE_CANONICAL[p.profile] !== undefined;
          d.variableRefreshRate = displayCapability(
            recognizedProfile ? p.profile !== DISPLAY_ARC_SYNC_PROFILE_TO_IGCL.off : null,
            recognizedProfile,
            recognizedProfile && variableRefreshRateControllable,
            recognizedProfile
              ? (variableRefreshRateControllable ? null : 'Arc Sync setter is not available in this driver runtime.')
              : 'Arc Sync monitor support or the current Arc Sync profile is unavailable.',
            'igcl-arc-sync-profile',
          );
          if (Number.isFinite(p.minRefreshHz) && Number.isFinite(p.maxRefreshHz)
            && p.maxRefreshHz > 0 && p.maxRefreshHz >= p.minRefreshHz) {
            d.vrrCurrentRange = displayCapability(
              `${p.minRefreshHz} Hz - ${p.maxRefreshHz} Hz`,
              d.arcSync.supported,
              false,
              'Read-only driver capability.',
            );
          }
          if (recognizedProfile) d.supportedOptions.vrrModes = [...DISPLAY_ARC_SYNC_PROFILE_OPTIONS];
        }
      }
    } catch {
      // degrade the arc-sync profile
    }

    // Standard Color Correction is adapter-global in IGCL, while pixel
    // transformation is the per-output desktop path. Prefer the latter when
    // its matrix block is available so Apply changes the visible desktop
    // output rather than only the adapter's video-processing path.
    try {
      const color = readMediaColorCorrection(lib, adapterHandle);
      const ranges = color?.ranges ?? {
        hue: { min: -180, max: 180, step: 1, default: 0 },
        saturation: { min: 0, max: 10, step: 0.1, default: 1 },
        brightness: { min: -100, max: 100, step: 1, default: 0 },
        contrast: { min: 0, max: 10, step: 0.1, default: 1 },
      };
      if (pixelTransform?.matrixBlock) {
        const key = d.displayKey;
        const cached = typeof key === 'string' ? this._displayPixelColors.get(key) : null;
        const nativeCurrent = pixelCurrent?.matrixBlock ?? null;
        const defaults = Object.fromEntries(Object.entries(ranges).map(([name, range]) => [name, range.default]));
        const cachedMatchesDriver = cached && nativeCurrent
          ? pixelMatrixMatches(nativeCurrent, pixelMatrixForColors(cached))
          : false;
        const values = cachedMatchesDriver
          ? cached
          : (!cached && pixelMatrixIsNeutral(nativeCurrent) ? defaults : null);
        if (typeof key === 'string' && !cached && values) this._displayPixelColors.set(key, values);
        const setterAvailable = !this._isUnavailable(lib.ctlPixelTransformationSetConfig);
        const currentAvailable = nativeCurrent !== null;
        const canControl = setterAvailable && currentAvailable && values !== null;
        const reason = canControl
          ? null
          : !setterAvailable
            ? 'Pixel transformation setter is not available in this driver runtime.'
            : !currentAvailable
              ? 'Pixel transformation current configuration is not available for safe partial updates.'
              : 'The driver has an existing color transform that Arc Power cannot safely merge; reset it in IGS first.';
        for (const name of ['hue', 'saturation', 'brightness', 'contrast']) {
          d[name] = displayCapability(values?.[name] ?? null, true, canControl, reason, 'igcl-pixel-transformation');
          d.supportedOptions.colorRanges[name] = ranges[name];
        }
      } else if (color) {
        for (const key of ['hue', 'saturation', 'brightness', 'contrast']) {
          d[key] = displayCapability(color.values[key], true, true, null, 'igcl-media');
          d.supportedOptions.colorRanges[key] = color.ranges[key];
        }
      }
    } catch {
      // Keep the honest read-only color capability defaults.
    }

    // The EDID monitor name (defensive - a failing name read keeps null).
    try {
      d.name = await this._readDisplayName(handle);
    } catch {
      d.name = null;
    }
    return d;
  }

  /**
   * M10b: read the Display view's driver state. NEVER throws - every
   * failure (missing symbols, ctl errors, crashes) degrades to
   * { displays: [] } (the honest no-controls surface). Only ACTIVE display
   * outputs are returned (the M10b probe: 30 enumerated outputs, ONE
   * active on the A770 - the inactive outputs report implausible timings
   * and refuse every feature read); the per-feature reads are defensive.
   * @param {number} deviceId
   * @returns {Promise<import('./backend.interface.js').DisplayState>}
   */
  async getDisplaySettings(deviceId) {
    try {
      const lib = this._libOrThrow();
      const dev = await this._device(deviceId);
      const deviceKey = dev.deviceKey ?? deviceHardwareKey(dev);
      if (this._isUnavailable(lib.ctlEnumerateDisplayOutputs) || this._isUnavailable(lib.ctlGetDisplayProperties)) {
        return { deviceKey, adapterName: dev.name ?? null, displays: [] };
      }
      // Output handles are topology-scoped. Re-enumerate for every Display
      // read so hot-plug/re-enumeration cannot leave the view on stale handles.
      const handles = await this._displayOutputsOf(deviceId, true);
      const globalVrr = await this._readGlobalVrrMode(deviceId, dev.handle);
      const registryScalingState = this._vrrRegistry && typeof this._vrrRegistry.getScalingState === 'function'
        ? await this._vrrRegistry.getScalingState(dev).catch(() => null)
        : null;
      const displays = [];
      for (let i = 0; i < handles.length; i++) {
        const d = await this._readDisplayOutput(i, handles[i], deviceKey, dev.handle, globalVrr, registryScalingState);
        if (d.flags.active) displays.push(d);
      }
      return { deviceKey, adapterName: dev.name ?? null, displays };
    } catch {
      return this._displayDegraded();
    }
  }

  /**
   * M10b: apply the Display view's settings for ONE display (the DEDICATED
   * display apply path - NOT the OC machinery: display settings have no OC
   * waiver and no OC-mode gate). Returns the ApplyResult shape with one
   * per-control entry per requested field. Every set is followed by a
   * read-back verification (the plan's every-apply-verified rule); a
   * SUCCESS-with-unchanged-read-back surfaces as the honest silentNoop
   * (the probe's wire-format finding: the SET answers SUCCESS but the
   * read-back never changes - read-only in effect on this driver build).
   * The error mapping reuses igclErrorCode; the 0x60000000-range display
   * codes fall through to the honest 'io-failed' fallback (never raw hex
   * in the UI). The scaling entry carries the honest modeset-flash warning
   * (the probe skipped the scaling SET by design - a scaling change is a
   * PHYSICAL MODESET = a screen flash).
   * @param {number} deviceId
   * @param {{ deviceKey: string, displayKey: string, patch: import('./backend.interface.js').DisplaySettings }} request
   * @returns {Promise<import('./backend.interface.js').ApplyResult>}
   */
  async setDisplaySettings(deviceId, request = {}) {
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const deviceKey = typeof request.deviceKey === 'string' ? request.deviceKey : null;
    const displayKey = typeof request.displayKey === 'string' ? request.displayKey : null;
    let patch = normalizeDisplayScalingAlias(request.patch && typeof request.patch === 'object' ? request.patch : {});
    const result = { ok: true, perControl: {} };
    const fail = (control, errorCode, message) => {
      result.perControl[control] = { ok: false, errorCode, message };
      result.ok = false;
    };
    let controls = ['quantizationRange', 'wireFormat', 'scalingMode', 'displayScalingMethod', 'scalingMethod', 'globalVrrMode', 'variableRefreshRate', 'vrrMode', 'hue', 'saturation', 'brightness', 'contrast']
      .filter((c) => patch[c] !== null && patch[c] !== undefined);

    // The whole-surface gate (the M8 setGraphicsSettings pattern): when NO
    // display API is bound, the surface is absent - every requested control
    // fails with unavailable-symbol BEFORE the handle lookup (a surface-less
    // runtime cannot even resolve display ids).
    if (this._isUnavailable(lib.ctlGetSetDisplaySettings)
      && this._isUnavailable(lib.ctlGetSetWireFormat)
      && this._isUnavailable(lib.ctlSetCurrentScaling)
      && this._isUnavailable(lib.ctlGetSetRetroScaling)
      && this._isUnavailable(lib.ctlSetIntelArcSyncProfile)
      && this._isUnavailable(lib.ctlPixelTransformationSetConfig)
      && this._isUnavailable(lib.ctlGetSetVideoProcessingFeature)
      && this._isUnavailable(lib.ctlGetSet3DFeature)) {
      for (const c of controls) {
        fail(c, 'unavailable-symbol', 'the display-settings API is missing in the IGCL runtime');
      }
      return result;
    }

    if (!deviceKey || !displayKey || deviceKey !== (dev.deviceKey ?? deviceHardwareKey(dev))) {
      for (const c of controls) fail(c, 'stale-target', 'the selected graphics adapter identity is stale; refresh Display and try again');
      return result;
    }
    // Output handles are topology-scoped. Re-enumerate immediately before
    // resolving a write target, so a hot-plug cannot retarget a stale handle.
    const handles = await this._displayOutputsOf(deviceId, true);
    const registryScalingState = this._vrrRegistry && typeof this._vrrRegistry.getScalingState === 'function'
      ? await this._vrrRegistry.getScalingState(dev).catch(() => null)
      : null;
    const fresh = [];
    for (let i = 0; i < handles.length; i++) {
      const output = await this._readDisplayOutput(i, handles[i], deviceKey, dev.handle, null, registryScalingState);
      if (output.flags.active) fresh.push({ output, handle: handles[i] });
    }
    const matches = fresh.filter(({ output }) => output.displayKey === displayKey && output.identityVerified === true);
    if (matches.length !== 1) {
      for (const c of controls) fail(c, matches.length === 0 ? 'stale-target' : 'ambiguous-target', 'the selected display is no longer uniquely connected; refresh Display and try again');
      return result;
    }
    const handle = matches[0].handle;
    const selectedDisplay = matches[0].output;

    // A legacy alias must carry the same Retro-disable companion that the
    // current renderer sends when leaving Retro Scaling. Otherwise an alias
    // can change the ordinary output flag while Retro remains the effective
    // scaler. Add that companion only when Retro is actually active so a
    // non-Retro caller does not need the adapter-level symbol.
    const aliasIsRetroMethod = patch.displayScalingMethod === 'integer' || patch.displayScalingMethod === 'nearest-neighbour';
    if (patch.displayScalingMethod !== undefined && patch.displayScalingMethod !== null
      && !aliasIsRetroMethod && patch.scalingMethod === undefined
      && selectedDisplay.scalingMethod?.value?.enabled === true) {
      patch = {
        ...patch,
        scalingMethod: {
          enabled: false,
          method: selectedDisplay.scalingMethod.value.method ?? 'integer',
        },
      };
      controls = ['quantizationRange', 'wireFormat', 'scalingMode', 'displayScalingMethod', 'scalingMethod', 'globalVrrMode', 'variableRefreshRate', 'vrrMode', 'hue', 'saturation', 'brightness', 'contrast']
        .filter((c) => patch[c] !== null && patch[c] !== undefined);
    }

    // Compatibility callers may still send the old user-facing method alias.
    // Validate the complete coupled shape before any native or registry write;
    // a contradictory alias must never partially change Scaling Mode first.
    const scalingAliasError = scalingAliasPayloadError(patch);
    if (scalingAliasError) {
      fail('displayScalingMethod', 'out-of-range', scalingAliasError);
      if (patch.scalingMode !== null && patch.scalingMode !== undefined) {
        fail('scalingMode', 'out-of-range', 'the coupled scaling payload was rejected before any write');
      }
      return result;
    }

    // The renderer couples the three-way raw scaling selector to the legacy
    // retro enable/type payload. Leaving Retro must disable the adapter-level
    // retro surface before the output-handle scaling modeset; otherwise the
    // driver can accept the first write, reject the second, and leave the UI
    // claiming a partial apply.
    let coupledRetroResult = null;
    const coupledRetro = patch.scalingMode !== null && patch.scalingMode !== undefined
      && patch.scalingMethod && typeof patch.scalingMethod === 'object';
    const leavingRetro = coupledRetro
      && selectedDisplay.scalingMethod?.value?.enabled === true
      && patch.scalingMethod.enabled === false
      && DISPLAY_SCALING_MODE_TO_IGCL[patch.scalingMode] !== undefined;
    if (leavingRetro) {
      if (this._isUnavailable(lib.ctlGetSetRetroScaling)) {
        coupledRetroResult = { ok: false, errorCode: 'unavailable-symbol', message: 'the retro-scaling API is missing in the IGCL runtime' };
      } else {
        const type = DISPLAY_RETRO_SCALING_METHOD_TO_IGCL[patch.scalingMethod.method];
        if (type === undefined) {
          coupledRetroResult = { ok: false, errorCode: 'out-of-range', message: 'unknown retro-scaling method' };
        } else {
          const gs = encodeRetroScalingSettings({ get: false, enable: false, retroScalingType: type });
          const setResult = lib.ctlGetSetRetroScaling(dev.handle, gs.buf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            coupledRetroResult = { ok: false, errorCode: igclErrorCode(setResult) ?? 'io-failed', message: `IGCL ${describeResult(setResult)}` };
          } else {
            const rb = encodeRetroScalingSettings({ get: true });
            const getResult = lib.ctlGetSetRetroScaling(dev.handle, rb.buf);
            const got = getResult === CTL_RESULT.SUCCESS ? decodeRetroScalingSettings(rb.buf) : null;
            const readBackEqual = got?.enable === false;
            coupledRetroResult = {
              ok: readBackEqual,
              errorCode: readBackEqual ? undefined : 'io-failed',
              message: readBackEqual ? undefined : `retro scaling read-back enabled=${got?.enable ?? describeResult(getResult)} != requested false`,
              readBackEqual,
              silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
              internal: true,
            };
          }
        }
      }
      result.perControl.scalingMethod = coupledRetroResult;
      if (!coupledRetroResult.ok) result.ok = false;
    }

    if (patch.quantizationRange !== null && patch.quantizationRange !== undefined) {
      if (this._isUnavailable(lib.ctlGetSetDisplaySettings)) {
        fail('quantizationRange', 'unavailable-symbol', 'the display-settings API is missing in the IGCL runtime');
      } else {
        const igclValue = DISPLAY_QUANT_TO_IGCL[patch.quantizationRange];
        if (igclValue === undefined) {
          fail('quantizationRange', 'out-of-range', `unknown quantization range '${patch.quantizationRange}'`);
        } else {
          // The M10b-fix lesson: NO Controllable-flag pre-gate - the flag
          // stays a UI hint (the supportedOptions list); the set reaches
          // the driver and the driver's ACTUAL result decides (a genuine
          // refusal still surfaces honestly through the ApplyResult
          // machinery). The probe-verified set shape: Set@5=true +
          // ValidFlags@16=1<<3 (QUANTIZATION_RANGE) + QuantizationRange@32.
          const gs = encodeDisplaySettings({ set: true, validFlags: 1 << 3, quantizationRange: igclValue });
          const setResult = lib.ctlGetSetDisplaySettings(handle, gs.buf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            fail('quantizationRange', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          } else {
            const rb = encodeDisplaySettings({ set: false });
            const getResult = lib.ctlGetSetDisplaySettings(handle, rb.buf);
            let readBackEqual = false;
            let message;
            if (getResult !== CTL_RESULT.SUCCESS) {
              message = `set succeeded but read-back failed (${describeResult(getResult)})`;
            } else {
              const got = decodeDisplaySettings(rb.buf).quantizationRange;
              readBackEqual = got === igclValue;
              message = readBackEqual ? undefined : `read-back ${got} != requested ${igclValue}`;
            }
            result.perControl.quantizationRange = {
              ok: readBackEqual,
              errorCode: readBackEqual ? undefined : 'io-failed',
              message,
              readBackEqual,
              // F3 silent no-op: SUCCESS from the setter with an unchanged
              // read-back - the driver accepted nothing; NEVER "applied".
              silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
            };
            if (!readBackEqual) result.ok = false;
          }
        }
      }
    }

    if (patch.wireFormat !== null && patch.wireFormat !== undefined) {
      if (this._isUnavailable(lib.ctlGetSetWireFormat)) {
        fail('wireFormat', 'unavailable-symbol', 'the wire-format API is missing in the IGCL runtime');
      } else {
        const modelNum = DISPLAY_WIRE_MODEL_TO_IGCL[patch.wireFormat.model];
        const depth = patch.wireFormat.depth;
        if (modelNum === undefined || !DISPLAY_BPC_OPTIONS.includes(depth)) {
          fail('wireFormat', 'out-of-range', `unknown wire format '${patch.wireFormat.model}' ${depth}-bpc`);
        } else {
          const gs = encodeWireFormatConfig({ operation: 1, colorModel: modelNum, colorDepth: depth });
          const setResult = lib.ctlGetSetWireFormat(handle, gs.buf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            fail('wireFormat', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          } else {
            // Read-back verify. A successful setter with an unchanged or
            // model-only read-back is a silent no-op, never a fake "applied".
            const rb = encodeWireFormatConfig({ operation: 0 });
            const getResult = lib.ctlGetSetWireFormat(handle, rb.buf);
            let readBackEqual = false;
            let message;
            if (getResult !== CTL_RESULT.SUCCESS) {
              message = `set succeeded but read-back failed (${describeResult(getResult)})`;
            } else {
              const wf = decodeWireFormatConfig(rb.buf);
              if (wf.currentUnavailable) {
                const curModel = DISPLAY_WIRE_MODEL_FROM_IGCL[
                  Object.entries(CTL_WIRE_COLOR_MODEL).find(([, n]) => n === wf.currentModel)?.[0]
                ] ?? null;
                // A model-only read-back is not sufficient proof of a wire
                // format apply: ColorDepth is absent on this driver surface.
                // Keep the successful setter classified as a silent no-op.
                readBackEqual = false;
                message = `read-back ${curModel ?? 'unknown'} with unverifiable depth != requested ${patch.wireFormat.model} ${depth}-bpc - the wire-format surface is read-only in effect on this driver build`;
              } else if (wf.current) {
                readBackEqual = wf.current.model === patch.wireFormat.model && wf.current.depth === depth;
                message = readBackEqual
                  ? undefined
                  : `read-back ${wf.current.model} ${wf.current.depth}-bpc != requested ${patch.wireFormat.model} ${depth}-bpc`;
              } else {
                message = 'set succeeded but the read-back reports no current wire format';
              }
            }
            result.perControl.wireFormat = {
              ok: readBackEqual,
              errorCode: readBackEqual ? undefined : 'io-failed',
              message,
              readBackEqual,
              silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
            };
            if (!readBackEqual) result.ok = false;
          }
        }
      }
    }

    const enteringRetro = patch.scalingMode === 'identity'
      && patch.scalingMethod?.enabled === true;
    if (patch.scalingMode !== null && patch.scalingMode !== undefined && !enteringRetro) {
      if (leavingRetro && coupledRetroResult && !coupledRetroResult.ok) {
        fail('scalingMode', coupledRetroResult.errorCode ?? 'io-failed', 'raw scaling was not changed because Retro Scaling could not be disabled first');
      } else {
      if (this._isUnavailable(lib.ctlSetCurrentScaling) || this._isUnavailable(lib.ctlGetCurrentScaling)) {
        fail('scalingMode', 'unavailable-symbol', 'the scaling API is missing in the IGCL runtime');
      } else {
        const flag = DISPLAY_SCALING_MODE_TO_IGCL[patch.scalingMode];
        if (flag === undefined) {
          fail('scalingMode', 'out-of-range', `unknown scaling mode '${patch.scalingMode}'`);
        } else {
          const custom = patch.scalingCustom && typeof patch.scalingCustom === 'object'
            && Number.isFinite(patch.scalingCustom.x) && Number.isFinite(patch.scalingCustom.y)
            ? {
              x: Math.max(0, Math.min(100, Math.round(patch.scalingCustom.x))),
              y: Math.max(0, Math.min(100, Math.round(patch.scalingCustom.y))),
              hardwareModeSet: patch.scalingCustom.hardwareModeSet !== false,
            } : null;
          if (flag === DISPLAY_SCALING_MODE_TO_IGCL.custom && patch.scalingCustom !== undefined && !custom) {
            fail('scalingMode', 'out-of-range', 'custom scaling percentages must be finite values from 0 to 100');
          } else {
          // The M10b-fix lesson: NO SupportedScaling pre-gate - the caps
          // bitmask stays a UI hint (the supportedOptions list); the set
          // reaches the driver and the driver's ACTUAL result decides.
          // ScalingType is a FLAG value in the struct (1/2/4/8/16). The
          // renderer includes the coupled GPU-method alias for IGS-style
          // method changes; that is the signal for a physical modeset.
          const gpuMethodRequested = patch.displayScalingMethod === 'centered'
            || patch.displayScalingMethod === 'stretched'
            || patch.displayScalingMethod === 'aspect-ratio-centered-max';
          const { setResult } = setScalingWithCompatibility(lib, handle, {
            flag,
            custom,
            hardwareModeSet: gpuMethodRequested,
          });
          // NNScalingState only distinguishes the Display-vs-GPU preference;
          // it cannot prove which exact GPU method was accepted. Use it as a
          // fallback for Display Scaling (identity) only, never as a false
          // success for Centered/Stretch/Aspect Ratio.
          const registryFallbackAllowed = (setResult === CTL_RESULT.ERROR_INVALID_ARGUMENT
            || setResult === CTL_RESULT.ERROR_UNSUPPORTED_VERSION)
            && patch.scalingMode === 'identity';
          let registryFallback = null;
          if (setResult !== CTL_RESULT.SUCCESS && !custom && registryFallbackAllowed && typeof this._vrrRegistry?.setScalingState === 'function') {
            // IGS persists ordinary GPU/Display selection in NNScalingState
            // on driver builds that reject the versioned native payload. The
            // registry adapter resolves the exact PCI/subsystem entry and
            // verifies the binary read-back, but this never substitutes for
            // a successful native scaling transition.
            const registryValue = patch.scalingMode === 'identity' ? SCALING_STATE_DISPLAY : SCALING_STATE_GPU;
            registryFallback = await this._vrrRegistry.setScalingState(dev, registryValue).catch(() => null);
          }
          if (setResult !== CTL_RESULT.SUCCESS) {
            // NNScalingState is only a persisted preference. It is useful as
            // a compatibility write, but it is never evidence that the
            // native output scaler changed. In particular, do not surface
            // the physical-modeset warning after the native setter refused.
            result.perControl.scalingMode = {
              ok: false,
              errorCode: igclErrorCode(setResult) ?? 'io-failed',
              message: `IGCL ${describeResult(setResult)}${registryFallback?.ok === true ? '; registry preference persisted, but the native scaling transition was refused' : ''}`,
              readBackEqual: false,
              activeReadBackEqual: false,
              preferredReadBackEqual: false,
              registryReadBackEqual: registryFallback?.ok === true,
              silentNoop: false,
            };
            result.ok = false;
          } else {
            // The probe never set-tested scaling (the physical-modeset
            // flash); the read-back gets a short settle - a scaling change
            // is a real modeset and the driver may need a beat to report
            // the new state.
            await new Promise((r) => setTimeout(r, 400));
            // Version 1 includes PreferredScalingType, the persisted IGS
            // selection. Version 0 can only prove the active/native scaler.
            const current = getScalingWithCompatibility(lib, handle);
            const getResult = current.getResult;
            let readBackEqual = false;
            let message;
            let activeReadBackEqual = false;
            let preferredReadBackEqual = false;
            let got = null;
            if (getResult !== CTL_RESULT.SUCCESS) {
              message = `set succeeded but read-back failed (${describeResult(getResult)})`;
            } else {
              got = current.settings;
              activeReadBackEqual = got.enable === true
                && got.scalingType === flag
                && (!custom || (got.customX === custom.x && got.customY === custom.y));
              preferredReadBackEqual = current.version === 1 && !custom && got.preferredScalingType === flag;
              message = activeReadBackEqual ? undefined : `read-back ${JSON.stringify(got)} != requested ${JSON.stringify({ scalingType: flag, ...custom })}`;
            }
            const registryWriterAvailable = !custom && typeof this._vrrRegistry?.setScalingState === 'function';
            const registryReaderAvailable = registryWriterAvailable && typeof this._vrrRegistry?.getScalingState === 'function';
            const registryAvailable = registryWriterAvailable;
            let registryReadBackEqual = false;
            if (registryAvailable) {
              const registryValue = patch.scalingMode === 'identity' ? SCALING_STATE_DISPLAY : SCALING_STATE_GPU;
              const registryNeedsSync = registryScalingState?.ok !== true || registryScalingState.value !== registryValue;
              if (registryNeedsSync && registryFallback?.ok !== true) registryFallback = await this._vrrRegistry.setScalingState(dev, registryValue).catch(() => null);
              const postRegistry = registryReaderAvailable
                ? await this._vrrRegistry.getScalingState(dev).catch(() => null)
                : null;
              registryReadBackEqual = postRegistry?.ok === true
                ? postRegistry.value === registryValue
                : registryFallback?.ok === true || (!registryNeedsSync && registryScalingState?.value === registryValue);
            }
            // A registry preference alone cannot prove that the selected
            // output scaler changed. For ordinary GPU methods, however, IGCL
            // can legitimately keep the active output at Identity while the
            // version-1 PreferredScalingType records the requested GPU
            // method. That is the same active/preferred split used by IGS;
            // accept it only when the native preferred field matches the
            // exact requested flag. Registry state remains persistence
            // support, never proof of the method itself.
            const preferredGpuMethodReadBackEqual = !custom
              && flag !== DISPLAY_SCALING_MODE_TO_IGCL.identity
              && current.version === 1
              && got?.scalingType === DISPLAY_SCALING_MODE_TO_IGCL.identity
              && preferredReadBackEqual;
            const nativeReadBackEqual = activeReadBackEqual || preferredGpuMethodReadBackEqual;
            const persistedReadBackEqual = custom !== null || !registryAvailable || registryReadBackEqual;
            readBackEqual = nativeReadBackEqual && persistedReadBackEqual;
            if (preferredGpuMethodReadBackEqual) {
              message = 'preferred GPU scaling method verified; the active output remains Identity for the current display timing';
            }
            if (!readBackEqual && !message) {
              message = `scaling read-back did not prove the requested active and persisted mode (active=${activeReadBackEqual}, preferred=${preferredReadBackEqual}, registry=${registryReadBackEqual})`;
            }
            result.perControl.scalingMode = {
              ok: readBackEqual,
              errorCode: readBackEqual ? undefined : 'io-failed',
              message,
              readBackEqual,
              activeReadBackEqual,
              preferredReadBackEqual,
              registryReadBackEqual,
              ...(registryFallback?.ok === true ? { writeTransport: 'registry' } : {}),
              silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
              // The honest modeset note - the scaling card warns the user
              // (the M10b probe skipped the scaling SET by design; the
              // header documents the same flash for retro scaling).
              warning: DISPLAY_SCALING_FLASH_WARNING,
            };
            if (!readBackEqual) result.ok = false;
          }
          }
        }
      }
      }
    }
    if (patch.displayScalingMethod !== null && patch.displayScalingMethod !== undefined) {
      const gpuMethodAlias = patch.displayScalingMethod === 'centered'
        || patch.displayScalingMethod === 'stretched'
        || patch.displayScalingMethod === 'aspect-ratio-centered-max';
      const retroMethodAlias = patch.displayScalingMethod === 'integer' || patch.displayScalingMethod === 'nearest-neighbour';
      // The renderer sends the method together with the coupled raw scaling
      // type when Custom is selected. Reusing the result of that write is
      // important: two back-to-back physical scaling writes can race the
      // driver's read-back and make a valid Custom request look like a
      // silent no-op.
      if ((gpuMethodAlias && patch.scalingMode !== patch.displayScalingMethod)
        || (retroMethodAlias && (patch.scalingMode === null || patch.scalingMode === undefined || !patch.scalingMethod))) {
        fail('displayScalingMethod', 'out-of-range', 'a raw GPU or Retro Scaling Method must include its matching coupled scaling payload');
      } else if (patch.scalingMode !== null && patch.scalingMode !== undefined
        && (result.perControl.scalingMode || (enteringRetro && result.perControl.scalingMethod))) {
        result.perControl.displayScalingMethod = {
          ...(result.perControl.scalingMode ?? result.perControl.scalingMethod),
        };
      } else {
      if (this._isUnavailable(lib.ctlSetCurrentScaling) || this._isUnavailable(lib.ctlGetCurrentScaling)) {
        fail('displayScalingMethod', 'unavailable-symbol', 'the scaling API is missing in the IGCL runtime');
      } else {
        const flag = patch.displayScalingMethod === 'custom' ? DISPLAY_SCALING_MODE_TO_IGCL.custom : DISPLAY_SCALING_MODE_TO_IGCL.identity;
        if (flag === undefined) {
          fail('displayScalingMethod', 'out-of-range', `unknown Display Scaling method '${patch.displayScalingMethod}'`);
        } else {
          const custom = patch.displayScalingMethod === 'custom' && patch.scalingCustom && typeof patch.scalingCustom === 'object'
            && Number.isFinite(patch.scalingCustom.x) && Number.isFinite(patch.scalingCustom.y)
            ? {
              x: Math.max(0, Math.min(100, Math.round(patch.scalingCustom.x))),
              y: Math.max(0, Math.min(100, Math.round(patch.scalingCustom.y))),
              hardwareModeSet: patch.scalingCustom.hardwareModeSet !== false,
            } : null;
          if (patch.displayScalingMethod === 'custom' && !custom) {
            fail('displayScalingMethod', 'out-of-range', 'custom scaling percentages must be finite values from 0 to 100');
          } else {
            const { setResult } = setScalingWithCompatibility(lib, handle, {
              flag,
              custom,
              hardwareModeSet: gpuMethodAlias,
            });
            if (setResult !== CTL_RESULT.SUCCESS) {
              fail('displayScalingMethod', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
            } else {
              await new Promise((r) => setTimeout(r, 400));
              const current = getScalingWithCompatibility(lib, handle);
              const getResult = current.getResult;
              const got = current.settings;
              const readBackEqual = got !== null
                && got.enable === true
                && got.scalingType === flag
                && (!custom || (got.customX === custom.x && got.customY === custom.y));
              result.perControl.displayScalingMethod = {
                ok: readBackEqual,
                errorCode: readBackEqual ? undefined : 'io-failed',
                message: readBackEqual ? undefined : (getResult === CTL_RESULT.SUCCESS
                  ? `read-back ${JSON.stringify(got)} != requested ${JSON.stringify({ scalingType: flag, ...custom })}`
                  : `set succeeded but read-back failed (${describeResult(getResult)})`),
                readBackEqual,
                silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
                warning: DISPLAY_SCALING_FLASH_WARNING,
              };
              if (!readBackEqual) result.ok = false;
            }
          }
        }
      }
      }
    }

    if (patch.scalingMethod !== null && patch.scalingMethod !== undefined && !coupledRetroResult) {
      if (this._isUnavailable(lib.ctlGetSetRetroScaling)) {
        fail('scalingMethod', 'unavailable-symbol', 'the retro-scaling API is missing in the IGCL runtime');
      } else {
        const requested = patch.scalingMethod;
        const type = requested && DISPLAY_RETRO_SCALING_METHOD_TO_IGCL[requested.method];
        if (!requested || typeof requested.enabled !== 'boolean' || type === undefined) {
          fail('scalingMethod', 'out-of-range', 'unknown retro-scaling method or enable value');
        } else {
          const retroHandle = dev.handle;
          const gs = encodeRetroScalingSettings({ get: false, enable: requested.enabled, retroScalingType: type });
          const setResult = lib.ctlGetSetRetroScaling(retroHandle, gs.buf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            fail('scalingMethod', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          } else {
            await new Promise((r) => setTimeout(r, 400));
            const rb = encodeRetroScalingSettings({ get: true });
            const getResult = lib.ctlGetSetRetroScaling(retroHandle, rb.buf);
            let readBackEqual = false;
            let message;
            if (getResult !== CTL_RESULT.SUCCESS) {
              message = `set succeeded but read-back failed (${describeResult(getResult)})`;
            } else {
              const got = decodeRetroScalingSettings(rb.buf);
              readBackEqual = got.enable === requested.enabled
                && (!requested.enabled || got.retroScalingType === type);
              message = readBackEqual ? undefined : requested.enabled
                ? `read-back enabled=${got.enable} type=${got.retroScalingType} != requested enabled=true type=${type}`
                : `read-back enabled=${got.enable} != requested enabled=false`;
            }
            result.perControl.scalingMethod = {
              ok: readBackEqual,
              errorCode: readBackEqual ? undefined : 'io-failed',
              message,
              readBackEqual,
              silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
              warning: DISPLAY_SCALING_FLASH_WARNING,
            };
            if (!readBackEqual) result.ok = false;
          }
        }
      }
    }

    // The renderer uses the Display-row control name for all three IGS
    // Scaling Mode views. GPU/Display aliases are mirrored above from the
    // raw scaling result; Retro's second-row method is verified by the
    // adapter-level retro surface here, so mirror that result as well.
    if (patch.displayScalingMethod !== null && patch.displayScalingMethod !== undefined
      && (patch.displayScalingMethod === 'integer' || patch.displayScalingMethod === 'nearest-neighbour')
      && result.perControl.scalingMethod) {
      result.perControl.displayScalingMethod = { ...result.perControl.scalingMethod };
    }

    const colorKeys = ['hue', 'saturation', 'brightness', 'contrast'].filter((key) => patch[key] !== null && patch[key] !== undefined);
    if (colorKeys.length > 0) {
      // Capability and current-configuration queries are separate IGCL
      // operations. The former tells us which block can be written; the
      // latter is the only safe source for verifying a completed transform.
      const pixel = readPixelTransformation(lib, handle);
      const pixelCurrent = readPixelTransformation(lib, handle, { queryType: PIXEL_QUERY_CURRENT });
      const media = readMediaColorCorrection(lib, dev.handle);
      const ranges = media?.ranges ?? {
        hue: { min: -180, max: 180, step: 1, default: 0 },
        saturation: { min: 0, max: 10, step: 0.1, default: 1 },
        brightness: { min: -100, max: 100, step: 1, default: 0 },
        contrast: { min: 0, max: 10, step: 0.1, default: 1 },
      };
      if (pixel?.matrixBlock) {
        const setterAvailable = !this._isUnavailable(lib.ctlPixelTransformationSetConfig);
        if (!setterAvailable) {
          for (const key of colorKeys) fail(key, 'unavailable-symbol', 'the pixel-transformation setter is missing in the IGCL runtime');
        } else {
          const cached = this._displayPixelColors.get(displayKey);
          const nativeCurrent = pixelCurrent?.matrixBlock ?? null;
          const defaults = Object.fromEntries(Object.entries(ranges).map(([name, range]) => [name, range.default]));
          const cachedMatchesDriver = cached && nativeCurrent
            ? pixelMatrixMatches(nativeCurrent, pixelMatrixForColors(cached))
            : false;
          const current = cachedMatchesDriver
            ? cached
            : pixelMatrixIsNeutral(nativeCurrent)
              ? defaults
              : null;
          // A partial slider apply must not replace an existing transform with
          // neutral or stale defaults. Only a verified complete state, or an
          // explicitly neutral current transform, can be used as the base.
          if (!current) {
            for (const key of colorKeys) fail(key, 'unsupported', nativeCurrent
              ? 'the driver has an existing color transform that Arc Power cannot safely merge; reset it in IGS first'
              : 'the driver current color transform could not be read safely');
          } else {
            const normalized = {};
            for (const key of colorKeys) {
              const range = ranges[key];
              const requested = Number(patch[key]);
              const bounded = Math.min(range.max, Math.max(range.min, requested));
              const snapped = range.step > 0 ? range.min + Math.round((bounded - range.min) / range.step) * range.step : bounded;
              normalized[key] = Math.min(range.max, Math.max(range.min, snapped));
            }
            const next = { ...current, ...normalized };
            const applied = pixelSetMatrix(lib, handle, nativeCurrent ?? pixel.matrixBlock, next);
            if (!applied.ok) {
              for (const key of colorKeys) fail(key, applied.errorCode ?? 'io-failed', applied.message ?? 'display color transformation failed');
            } else {
              const readBack = readPixelTransformation(lib, handle, { queryType: PIXEL_QUERY_CURRENT, requireSet: true });
              const readBackEqual = pixelMatrixMatches(readBack?.matrixBlock, applied.matrix);
              if (!readBackEqual) {
                for (const key of colorKeys) fail(key, 'io-failed', 'the driver accepted the color transform but current-configuration read-back did not match it');
              } else {
                this._displayPixelColors.set(displayKey, next);
                for (const key of colorKeys) {
                  result.perControl[key] = {
                    ok: true,
                    readBackEqual: true,
                    silentNoop: false,
                  };
                }
              }
            }
          }
        }
      } else if (this._isUnavailable(lib.ctlGetSupportedVideoProcessingCapabilities)
        || this._isUnavailable(lib.ctlGetSetVideoProcessingFeature)) {
        for (const key of colorKeys) fail(key, 'unavailable-symbol', 'the color-correction API is missing in the IGCL runtime');
      } else {
        const current = media;
        if (!current) {
          for (const key of colorKeys) fail(key, 'unsupported', 'standard color correction is not exposed by this driver');
        } else {
          const normalized = {};
          for (const key of colorKeys) {
            const range = current.ranges[key];
            const requested = Number(patch[key]);
            const bounded = Math.min(range.max, Math.max(range.min, requested));
            const snapped = range.step > 0 ? range.min + Math.round((bounded - range.min) / range.step) * range.step : bounded;
            normalized[key] = Math.min(range.max, Math.max(range.min, snapped));
          }
          const applied = mediaColorApply(lib, dev.handle, normalized, current);
          if (!applied.ok || !applied.readBack) {
            for (const key of colorKeys) fail(key, applied.errorCode ?? 'io-failed', applied.message ?? 'color correction read-back failed');
          } else {
            for (const key of colorKeys) {
              const range = current.ranges[key];
              const readBackEqual = Math.abs(applied.readBack.values[key] - normalized[key]) <= Math.max(0.0001, range.step);
              result.perControl[key] = {
                ok: readBackEqual,
                errorCode: readBackEqual ? undefined : 'io-failed',
                message: readBackEqual ? undefined : `read-back ${applied.readBack.values[key]} != requested ${normalized[key]}`,
                readBackEqual,
                silentNoop: !readBackEqual,
              };
              if (!readBackEqual) result.ok = false;
            }
          }
        }
      }
    }

    if (patch.variableRefreshRate !== null && patch.variableRefreshRate !== undefined) {
      const requested = patch.variableRefreshRate === true;
      if (typeof patch.variableRefreshRate !== 'boolean') {
        fail('variableRefreshRate', 'out-of-range', 'Variable Refresh Rate must be enabled or disabled');
      } else if (this._isUnavailable(lib.ctlGetIntelArcSyncProfile) || this._isUnavailable(lib.ctlSetIntelArcSyncProfile)) {
        fail('variableRefreshRate', 'unavailable-symbol', 'the Intel Arc Sync profile API is missing in the IGCL runtime');
      } else if (selectedDisplay.arcSync?.supported !== true
        || !Object.prototype.hasOwnProperty.call(DISPLAY_ARC_SYNC_PROFILE_TO_IGCL, selectedDisplay.arcSync?.profile)) {
        fail('variableRefreshRate', 'unsupported', 'Variable Refresh Rate is not supported by this display or its Arc Sync profile is unknown');
      } else {
        // Mirror Intel Graphics Software's setVRRMode: GET the complete Arc
        // Sync profile, change only the profile enum (RECOMMENDED=1 for
        // enabled, OFF=5 for disabled), then SET the preserved timing and
        // frame-time fields back through the Arc Sync profile API.
        const current = encodeArcSyncProfile();
        const currentResult = lib.ctlGetIntelArcSyncProfile(handle, current.buf);
        if (currentResult !== CTL_RESULT.SUCCESS) {
          fail('variableRefreshRate', igclErrorCode(currentResult) ?? 'io-failed', `Arc Sync profile read-back failed (${describeResult(currentResult)})`);
        } else {
          const now = decodeArcSyncProfile(current.buf);
          const profile = requested ? DISPLAY_ARC_SYNC_PROFILE_TO_IGCL.recommended : DISPLAY_ARC_SYNC_PROFILE_TO_IGCL.off;
          const set = encodeArcSyncProfile({
            profile,
            minRefreshHz: now.minRefreshHz,
            maxRefreshHz: now.maxRefreshHz,
            maxFrameTimeIncreaseUs: now.maxFrameTimeIncreaseUs,
            maxFrameTimeDecreaseUs: now.maxFrameTimeDecreaseUs,
          });
          const setResult = lib.ctlSetIntelArcSyncProfile(handle, set.buf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            fail('variableRefreshRate', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          } else {
            await new Promise((r) => setTimeout(r, 400));
            const rb = encodeArcSyncProfile();
            const readResult = lib.ctlGetIntelArcSyncProfile(handle, rb.buf);
            const got = readResult === CTL_RESULT.SUCCESS ? decodeArcSyncProfile(rb.buf) : null;
            const readBackEqual = got?.profile === profile;
            result.perControl.variableRefreshRate = {
              ok: readBackEqual,
              errorCode: readBackEqual ? undefined : (readResult === CTL_RESULT.SUCCESS ? 'io-failed' : (igclErrorCode(readResult) ?? 'io-failed')),
              message: readBackEqual ? undefined : `read-back profile ${got?.profile ?? describeResult(readResult)} != requested ${profile}`,
              readBackEqual,
              silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
            };
            if (!readBackEqual) result.ok = false;
          }
        }
      }
    }

    if (patch.globalVrrMode !== null && patch.globalVrrMode !== undefined) {
      const requested = patch.globalVrrMode;
      const igclValue = DISPLAY_GLOBAL_VRR_MODE_TO_IGCL[requested];
      if (igclValue === undefined) {
        fail('globalVrrMode', 'out-of-range', `unknown global Variable Refresh Rate Mode '${requested}'`);
      } else if (this._igscFullOk === false) {
        fail('globalVrrMode', 'unavailable-symbol', 'The IGSC full loader is unavailable after Level Zero-only fallback; global Variable Refresh Rate writes are disabled.');
      } else if (this._isUnavailable(lib.ctlGetSupported3DCapabilities) || this._isUnavailable(lib.ctlGetSet3DFeature)) {
        fail('globalVrrMode', 'unavailable-symbol', 'the global Variable Refresh Rate Mode API is missing in the IGCL runtime');
      } else {
        const features = await this._graphicsCapsOf(deviceId, dev.handle);
        const detail = features?.get(CTL_3D_FEATURE.VRR_WINDOWED_BLT);
        if (!detail || detail.valueType !== CTL_PROPERTY_VALUE_TYPE.ENUM) {
          fail('globalVrrMode', 'unsupported', 'the driver does not expose the global Variable Refresh Rate Mode feature');
        } else if (!globalVrrOptionsOf(detail).includes(requested)) {
          fail('globalVrrMode', 'unsupported', 'the requested global Variable Refresh Rate Mode is not advertised by this driver');
        } else {
          let set = globalVrrRequest(lib, dev.handle, features, { bSet: true, enumValue: igclValue });
          let registryFallback = false;
          // Intel Graphics Software persists this value in the display-class
          // adapter key on drivers that expose the feature but reject the
          // direct IGCL SET with insufficient permissions. Resolve and write
          // only after that exact permission result; all other failures stay
          // on the direct path and are not retried through the registry.
          if (set.result === CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS && this._vrrRegistry?.setGlobalVrrMode) {
            let fallback;
            try {
              fallback = await this._vrrRegistry.setGlobalVrrMode(dev, igclValue);
            } catch {
              fallback = { ok: false, errorCode: 'registry-write-failed', message: 'The elevated VRR registry fallback failed; no VRR value was changed.' };
            }
            if (fallback?.ok === true) {
              registryFallback = true;
              // The registry is only the write transport. Keep the native
              // IGCL read below as the authority before reporting success.
              set = { ...set, result: CTL_RESULT.SUCCESS, errorCode: undefined, message: undefined };
            } else {
              fail('globalVrrMode', fallback?.errorCode ?? 'permission-denied', fallback?.message ?? 'The direct IGCL VRR write was denied and the registry fallback did not complete; no VRR value was changed.');
            }
          }
          if (set.scope && !set.scope.ok) {
            fail('globalVrrMode', set.scope.errorCode, set.scope.message);
          } else if (result.perControl.globalVrrMode?.ok === false || set.errorCode || set.result !== CTL_RESULT.SUCCESS) {
            if (!result.perControl.globalVrrMode) {
              fail('globalVrrMode', set.errorCode ?? igclErrorCode(set.result) ?? 'io-failed', set.message ?? `IGCL ${describeResult(set.result)}; no VRR value was changed.`);
            }
          } else {
            const read = globalVrrRequest(lib, dev.handle, features, { bSet: false });
            if (read.scope && !read.scope.ok) {
              fail('globalVrrMode', read.scope.errorCode, read.scope.message);
            } else {
              const got = !read.errorCode && read.result === CTL_RESULT.SUCCESS
                ? DISPLAY_GLOBAL_VRR_MODE_FROM_IGCL[decode3dFeatureGetsetValue(read.request.buf, CTL_PROPERTY_VALUE_TYPE.ENUM).enableType]
                : null;
              const readBackEqual = got === requested;
              result.perControl.globalVrrMode = {
                ok: readBackEqual,
                errorCode: readBackEqual ? undefined : (read.errorCode ?? (read.result === CTL_RESULT.SUCCESS ? 'io-failed' : (igclErrorCode(read.result) ?? 'io-failed'))),
                message: readBackEqual ? undefined : `read-back ${got ?? (read.errorCode ?? (read.result === CTL_RESULT.SUCCESS ? 'unknown' : describeResult(read.result)))} != requested ${requested}`,
                readBackEqual,
                silentNoop: set.result === CTL_RESULT.SUCCESS && !readBackEqual,
                ...(registryFallback ? { writeTransport: 'registry' } : {}),
              };
              if (!readBackEqual) result.ok = false;
            }
          }
        }
      }
    }

    if (patch.vrrMode !== null && patch.vrrMode !== undefined) {
      if (this._isUnavailable(lib.ctlGetIntelArcSyncProfile) || this._isUnavailable(lib.ctlSetIntelArcSyncProfile)) {
        fail('vrrMode', 'unavailable-symbol', 'the Arc Sync profile API is missing in the IGCL runtime');
      } else if (selectedDisplay.arcSync?.supported !== true
        || !Object.prototype.hasOwnProperty.call(DISPLAY_ARC_SYNC_PROFILE_TO_IGCL, selectedDisplay.arcSync?.profile)) {
        fail('vrrMode', 'unsupported', 'Arc Sync profile control is not supported by this display or its current profile is unknown');
      } else {
        const profile = DISPLAY_ARC_SYNC_PROFILE_TO_IGCL[patch.vrrMode];
        if (profile === undefined) {
          fail('vrrMode', 'out-of-range', `unknown Arc Sync profile '${patch.vrrMode}'`);
        } else {
          // Preserve the driver's current timing parameters; only the profile
          // enum is being changed by this control.
          const current = encodeArcSyncProfile();
          const currentResult = lib.ctlGetIntelArcSyncProfile(handle, current.buf);
          if (currentResult !== CTL_RESULT.SUCCESS) {
            fail('vrrMode', igclErrorCode(currentResult) ?? 'io-failed', `Arc Sync read-back failed (${describeResult(currentResult)})`);
          } else {
            const now = decodeArcSyncProfile(current.buf);
            const set = encodeArcSyncProfile({
              profile,
              minRefreshHz: now.minRefreshHz,
              maxRefreshHz: now.maxRefreshHz,
              maxFrameTimeIncreaseUs: now.maxFrameTimeIncreaseUs,
              maxFrameTimeDecreaseUs: now.maxFrameTimeDecreaseUs,
            });
            const setResult = lib.ctlSetIntelArcSyncProfile(handle, set.buf);
            if (setResult !== CTL_RESULT.SUCCESS) {
              fail('vrrMode', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
            } else {
              await new Promise((r) => setTimeout(r, 400));
              const rb = encodeArcSyncProfile();
              const getResult = lib.ctlGetIntelArcSyncProfile(handle, rb.buf);
              let readBackEqual = false;
              let message;
              if (getResult !== CTL_RESULT.SUCCESS) {
                message = `set succeeded but read-back failed (${describeResult(getResult)})`;
              } else {
                const got = decodeArcSyncProfile(rb.buf);
                readBackEqual = got.profile === profile;
                message = readBackEqual ? undefined : `read-back profile ${got.profile} != requested ${profile}`;
              }
              result.perControl.vrrMode = {
                ok: readBackEqual,
                errorCode: readBackEqual ? undefined : 'io-failed',
                message,
                readBackEqual,
                silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
              };
              if (!readBackEqual) result.ok = false;
            }
          }
        }
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  /**
   * Apply settings. `opts.snapToStep` (default true) controls step-snapping:
   * product applies snap to the capability step; the smoke no-op round trip
   * passes snapToStep:false so an off-grid current value (e.g. the A770's
   * 48.3 MHz offset) is written back EXACTLY as read - never changed.
   */
  async applySettings(deviceId, settings = {}, opts = {}) {
    await this._device(deviceId);
    const caps = await this.getCapabilities(deviceId);
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const units = await this._ocUnitsOf(deviceId);
    const result = { ok: true, perControl: {} };

    // M17e (round-1 S1b): the UNIVERSAL lock-vs-offset normalization - a
    // NON-ZERO gpuLock forces the freq/volt offsets to 0 in EVERY apply
    // path (the elevated worker, boot, tray, --apply-profile all route
    // through this method). The driver's lock and offset families fight
    // (CTL_RESULT_ERROR_CORE_OVERCLOCK_IN_VOLTAGE_LOCKED_MODE refuses
    // offset writes while locked), so the atomic-lock contract is that a
    // lock zeroes the offsets; a legacy/hand-edited profile whose lock
    // rides with non-zero offsets gets normalized here (the pinned
    // behavior: the driver state ends at the lock + the offsets 0). Power
    // Limit + Temp Limit are NEVER touched (the user's rule - they never
    // ride the lock payload and are never reset by a lock apply).
    // M17e (round-2 S1): the zeroed offset keys are ADDED UNCONDITIONALLY -
    // a LOCK-ONLY payload (no offset keys carried - a legacy/hand-edited
    // profile or a direct apply-settings of { gpuLock } only) must STILL
    // write the zero offsets (the offsets-first write-order branch below
    // then writes them): skipping the absent keys would leave the driver
    // holding non-zero offsets when the lock lands - the exact
    // lock-vs-offset fight the atomic design targets. The zeroed offsets'
    // per-control entries land too (the driver state ends at lock +
    // offsets 0 - the pinned behavior).
    if (caps.controls.gpuLock && settings.gpuLock
      && !(settings.gpuLock.voltageV === 0 && settings.gpuLock.freqMhz === 0)) {
      const out = { ...settings };
      out.gpuFreqOffsetMhz = 0;
      out.gpuVoltOffsetV = 0;
      settings = out;
    }

    const fail = (control, errorCode, message) => {
      result.perControl[control] = { ok: false, errorCode, message };
      result.ok = false;
    };

    // Waiver gate: auto-accept only under allowAutoWaiver (smoke/tests).
    if (this._allowAutoWaiver && !(this._waiverAccepted.get(deviceId) ?? false)) {
      await this.setWaiverAccepted(deviceId);
    }

    const applyScalar = async (control, canonicalName, unitField, value) => {
      if (value === null || value === undefined) return;
      if (!caps.controls[control]) {
        fail(canonicalName, 'unsupported', 'control not supported on this device');
        return;
      }
      const getFn = lib[this._v2GetterName(control)];
      const setFn = lib[this._v2SetterName(control)];
      if (this._isUnavailable(getFn) || this._isUnavailable(setFn)) {
        fail(canonicalName, 'unavailable-symbol', 'V2 API symbol missing in the IGCL runtime');
        return;
      }
      const range = caps.ranges[canonicalName];
      if (!range) {
        fail(canonicalName, 'unsupported', 'no capability range reported for this control');
        return;
      }
      const clamped = opts.snapToStep === false
        ? Math.min(range.max, Math.max(range.min, Number.isFinite(value) ? value : range.min))
        : clampAndSnap(value, range);
      const unit = units ? units[unitField] : 0;
      const igclValue = canonicalToIgcl(clamped, unit);

      const setResult = setFn(dev.handle, igclValue);
      if (setResult !== CTL_RESULT.SUCCESS) {
        fail(canonicalName, igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
        return;
      }
      const buf = koffi.alloc('double', 1);
      const getResult = getFn(dev.handle, buf);
      let readBackEqual = false;
      let message;
      if (getResult !== CTL_RESULT.SUCCESS) {
        message = `set succeeded but read-back failed (${describeResult(getResult)})`;
      } else {
        const readBack = igclToCanonical(koffi.decode(buf, 'double'), unit);
        readBackEqual = nearlyEqual(readBack, clamped);
        message = readBackEqual ? undefined : `read-back ${readBack} != requested ${clamped}`;
      }
      result.perControl[canonicalName] = {
        ok: readBackEqual,
        errorCode: readBackEqual ? undefined : 'io-failed',
        message,
        readBackEqual,
        // F3 silent no-op (plan M2C-A): the setter returned SUCCESS but the
        // read-back did not change - the driver accepted nothing. This is a
        // refusal, NEVER "applied"; the apply core keys off silentNoop to
        // classify it before the generic io-failed class (M2C-B instant
        // apply: the silent no-op fails instantly with the refusal message).
        silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
      };
      if (!readBackEqual) result.ok = false;
    };

    const applyLock = async (lock) => {
      if (!lock) return;
      if (!caps.controls.gpuLock) {
        const percentVoltage = caps.ranges.gpuVoltOffsetV?.units === '%';
        fail('gpuLock', 'unsupported', percentVoltage
          ? 'Fixed Clock / Voltage lock is not supported on Battlemage percent-unit voltage controls; use the independent frequency and voltage offsets.'
          : 'GPU lock not supported on this device');
        return;
      }
      if (this._isUnavailable(lib.ctlOverclockGpuLockSet) || this._isUnavailable(lib.ctlOverclockGpuLockGet)) {
        fail('gpuLock', 'unavailable-symbol', 'GPU lock API missing in the IGCL runtime');
        return;
      }
      // Never assume the caller's pair is in range (backend contract): the
      // lock pair has no capability range, so clamp to the per-device
      // lockRange when the caps carry one (the M17e props-derived bounds),
      // else the documented absolute bounds (the (0,0) unlock always passes
      // unclamped - a positive voltMin must never clamp the unlock).
      const bounded = clampGpuLock(lock, caps.lockRange);
      // M17e (2026-08-12 live probe, probe 2): ctlOverclockGpuLockSet is
      // MILLIVOLTS despite the struct comment - the header contradicts
      // itself (ctl_oc_vf_pair_t says 'in Volts'; the ctlOverclockGpuLockSet
      // @brief says 'Locks the GPU voltage for Overclocking in mV'). The
      // probe proved it: (0.95 V, 2400 MHz) -> VOLTAGE_OUTSIDE_RANGE (the
      // driver read 0.95 mV), (950 mV, 2400 MHz) -> SUCCESS + read-back
      // (950, 2400) stuck. The canonical settings shape stays VOLTS; the
      // mV conversion happens ONLY at this native boundary (and the
      // read-back converts back). M17e step-4 finding 2: the write is
      // ROUNDED to the integer-mV grid (Math.round) - a fractional-mV
      // write (0.9505 V -> 950.5 mV) never reaches the driver (either
      // refused or truncated into a confusing read-back mismatch); the
      // read-back compare below stays against `bounded.voltageV`, so a
      // real 1-mV driver discrepancy remains flagged.
      const pair = { Size: koffi.sizeof('ctl_oc_vf_pair_t'), Version: 0, Voltage: Math.round(bounded.voltageV * 1000), Frequency: bounded.freqMhz };
      const setResult = lib.ctlOverclockGpuLockSet(dev.handle, pair);
      if (setResult !== CTL_RESULT.SUCCESS) {
        const message = `Fixed Clock / Voltage lock was refused by the driver (${describeResult(setResult)}).`;
        fail('gpuLock', igclErrorCode(setResult) ?? 'io-failed', message);
        const cached = this._caps.get(deviceId);
        if (cached) cached.controlStatus = { ...(cached.controlStatus ?? {}), gpuLock: { state: 'runtime-refused', reason: message } };
        return;
      }
      const lockBuf = koffi.alloc('ctl_oc_vf_pair_t', 1);
      koffi.encode(lockBuf, 'ctl_oc_vf_pair_t', { Size: koffi.sizeof('ctl_oc_vf_pair_t'), Version: 0 });
      const getResult = lib.ctlOverclockGpuLockGet(dev.handle, lockBuf);
      let readBackEqual = false;
      let message;
      if (getResult !== CTL_RESULT.SUCCESS) {
        message = `set succeeded but read-back failed (${describeResult(getResult)})`;
      } else {
        const got = koffi.decode(lockBuf, 'ctl_oc_vf_pair_t');
        // The read-back is mV too - convert back to the canonical volts.
        readBackEqual = nearlyEqual(got.Voltage / 1000, bounded.voltageV) && nearlyEqual(got.Frequency, bounded.freqMhz);
        message = readBackEqual ? undefined : `read-back ${got.Voltage}mV/${got.Frequency}MHz != requested ${bounded.voltageV}V/${bounded.freqMhz}MHz`;
      }
      result.perControl.gpuLock = {
        ok: readBackEqual,
        errorCode: readBackEqual ? undefined : 'io-failed',
        message,
        readBackEqual,
        // F3 silent no-op: SUCCESS from the setter with an unchanged pair.
        silentNoop: setResult === CTL_RESULT.SUCCESS && !readBackEqual,
      };
      if (!readBackEqual) result.ok = false;
      if (!readBackEqual) {
        const cached = this._caps.get(deviceId);
        if (cached) cached.controlStatus = { ...(cached.controlStatus ?? {}), gpuLock: { state: 'runtime-refused', reason: message ?? 'The driver did not verify the requested fixed lock.' } };
      }
    };

    const applyFan = async () => {
      const requested = ['fanMode', 'fanCurve', 'fixedFanPct']
        .filter((c) => settings[c] !== null && settings[c] !== undefined);
      if (requested.length === 0) return;

      // Hard safety rule: fan setters only when the EFFECTIVE canControl is
      // true (properties.canControl || probeOk - M3-D: the A770's property
      // lies, the probe is the unlock). Never gated on elevation: the write
      // outcome decides honesty.
      if (!caps.fan.canControl) {
        for (const c of requested) fail(c, 'unsupported', 'fan control is read-only on this device (canControl=false)');
        return;
      }
      const fanHandles = await this._fanHandlesOf(deviceId);
      if (fanHandles.length === 0) {
        for (const c of requested) fail(c, 'unsupported', 'no fans enumerated on this device');
        return;
      }
      const fan = await this._fanHandleForControl(deviceId);

      // Resolve the mode to switch to (explicit fanMode, else implied by data).
      let mode = settings.fanMode;
      if (!mode) {
        if (settings.fanCurve) mode = 'curve';
        else if (settings.fixedFanPct !== undefined && settings.fixedFanPct !== null) mode = 'fixed';
      }
      // Mode gate (F5, mock parity): refuse modes outside caps.fan.modes -
      // the driver genuinely refuses them (e.g. fixed writes are
      // UNSUPPORTED_FEATURE on this card) and the mock answers the same
      // way ('unsupported', no driver write attempted).
      if (!caps.fan.modes.includes(mode)) {
        for (const c of requested) fail(c, 'unsupported', `fan mode ${mode} not supported on this device`);
        return;
      }
      if (mode === 'curve' && !settings.fanCurve) {
        fail('fanMode', 'out-of-range', 'fanCurve is required for curve mode');
        return;
      }
      if (mode === 'fixed' && (settings.fixedFanPct === undefined || settings.fixedFanPct === null)) {
        fail('fanMode', 'out-of-range', 'fixedFanPct is required for fixed mode');
        return;
      }

      // Do not derive the write unit from caps.fan.speedUnits. That field
      // reflects the state API's advertised unit, while the Arc table/fixed
      // setters accept FAN-enum PERCENT on both A770 and B580.
      const fanUnits = FAN_CONTROL_UNITS;
      const fanMaxRpm = Number(caps.fan.maxRpm);
      const pct = (p) => ({
        Size: koffi.sizeof('ctl_fan_speed_t'),
        Version: 0,
        speed: fanSpeedFromPct(p, fanUnits, fanMaxRpm),
        units: fanUnits,
      });

      // Read-back verification for fan applies (plan §5: every apply is
      // followed by read-back verification). `expected.curve` is an array of
      // { t, speedPct } of the ROUNDED points that were sent; `expected.fixedPct`
      // is the rounded fixed speed. The mode must match the requested canonical
      // mode; table points / fixed speed are compared (within tolerance) when
      // the read-back reports the advertised native unit. RPM values are
      // normalized with maxRPM before comparison.
      // M20-B (F2): `expected.flatPct` verifies a FLAT-table fixed write -
      // the canonical 'curve' mode (a flat table reads back mode 2) + every
      // table point's speed within 1 of flatPct (temperatures ignored - the
      // fallback's 20/100 convention is NOT user curve data).
      const verifyFanConfig = (fan, expectedMode, expected = {}) => {
        if (this._isUnavailable(lib.ctlFanGetConfig)) {
          return { ok: false, message: 'fan set succeeded but read-back (ctlFanGetConfig) is unavailable' };
        }
        const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
        koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
        const res = lib.ctlFanGetConfig(fan, cfgBuf);
        if (res !== CTL_RESULT.SUCCESS) {
          return { ok: false, message: `fan set succeeded but read-back failed (${describeResult(res)})` };
        }
        const cfg = koffi.decode(cfgBuf, 'ctl_fan_config_t');
        const gotMode = FAN_MODE_CANONICAL[cfg.mode] ?? null;
        if (gotMode !== expectedMode) {
          return { ok: false, message: `fan mode read-back ${gotMode} != requested ${expectedMode}` };
        }
        if (expected.curve) {
          const numPoints = cfg.speedTable.numPoints;
          if (numPoints < 0 || numPoints > 32) {
            return { ok: false, message: 'fan curve read-back has invalid point count' };
          }
          const got = [];
          for (let i = 0; i < numPoints; i++) {
            const tp = cfg.speedTable.table[i];
            got.push({ t: tp.temperature, speedPct: fanPctFromSpeed(tp.speed.speed, tp.speed.units, fanMaxRpm) });
          }
          if (got.some((p) => p.speedPct === null)) {
            return { ok: false, message: 'fan curve read-back uses an unsupported speed unit - cannot verify' };
          }
          if (got.length !== expected.curve.length) {
            return { ok: false, message: `fan curve read-back ${got.length} points != requested ${expected.curve.length}` };
          }
          for (let i = 0; i < got.length; i++) {
            if (!nearlyEqual(got[i].t, expected.curve[i].t, 1) || !nearlyEqual(got[i].speedPct, expected.curve[i].speedPct, 1)) {
              return { ok: false, message: `fan curve point ${i} read-back ${got[i].t}C/${got[i].speedPct}% != requested ${expected.curve[i].t}C/${expected.curve[i].speedPct}%` };
            }
          }
        }
        // M20-B (F2): the flat-table verify branch - every table point's
        // speed (PERCENT units) must be within 1 of flatPct; numPoints >= 2
        // (F3: a 1-point table is vacuously "all equal"); temperatures are
        // the fallback's 20/100 convention, never user curve data.
        if (expected.flatPct !== undefined) {
          const numPoints = cfg.speedTable.numPoints;
          if (numPoints < 2 || numPoints > 32) {
            return { ok: false, message: 'flat-table read-back has an invalid point count' };
          }
          for (let i = 0; i < numPoints; i++) {
            const tp = cfg.speedTable.table[i];
            const speedPct = fanPctFromSpeed(tp.speed.speed, tp.speed.units, fanMaxRpm);
            if (speedPct === null) {
              return { ok: false, message: 'flat-table read-back uses an unsupported speed unit - cannot verify' };
            }
            if (!nearlyEqual(speedPct, expected.flatPct, 1)) {
              return { ok: false, message: `flat-table point ${i} read-back ${speedPct}% != requested ${expected.flatPct}%` };
            }
          }
        }
        if (expected.fixedPct !== undefined) {
          const speedPct = fanPctFromSpeed(cfg.speedFixed.speed, cfg.speedFixed.units, fanMaxRpm);
          if (speedPct === null || !nearlyEqual(speedPct, expected.fixedPct, 1)) {
            return { ok: false, message: `fixed fan speed read-back ${speedPct ?? 'unknown'}% != requested ${expected.fixedPct}%` };
          }
        }
        return { ok: true };
      };

      let curveOk = false;
      if (settings.fanCurve) {
        if (this._isUnavailable(lib.ctlFanSetSpeedTableMode)) {
          fail('fanCurve', 'unavailable-symbol', 'fan curve API missing in the IGCL runtime');
        } else {
          // Normalize before the driver write (plan §5 item 3): clamp % to
          // 0..100, sort by temp, enforce strictly ascending temps (IGCL
          // requires an ascending table) - shared with MockBackend so both
          // backends accept identical payloads.
          const table = normalizeFanCurve(settings.fanCurve, caps.fan.maxCurvePoints).map((p) => ({
            Size: koffi.sizeof('ctl_fan_temp_speed_t'),
            Version: 0,
            temperature: p.t,
            speed: pct(p.speedPct),
          }));
          const tableObj = {
            Size: koffi.sizeof('ctl_fan_speed_table_t'),
            Version: 0,
            numPoints: table.length,
            table,
          };
          const setResult = lib.ctlFanSetSpeedTableMode(fan, tableObj);
          if (setResult === CTL_RESULT.SUCCESS) {
            const v = verifyFanConfig(fan, 'curve', {
              curve: table.map((p, i) => ({ t: p.temperature, speedPct: normalizeFanCurve(settings.fanCurve, caps.fan.maxCurvePoints)[i].speedPct })),
            });
            result.perControl.fanCurve = { ok: v.ok, readBackEqual: v.ok, errorCode: v.ok ? undefined : 'io-failed', message: v.message };
            curveOk = v.ok;
            if (!v.ok) result.ok = false;
          } else {
            fail('fanCurve', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          }
        }
      }

      let fixedOk = false;
      if (settings.fixedFanPct !== null && settings.fixedFanPct !== undefined) {
        const fixed = pct(settings.fixedFanPct);
        // M20-B: the fixed apply falls back to the FLAT-TABLE mechanism
        // (the Alchemist route) when the dedicated API is unavailable or
        // refuses with ERROR_UNSUPPORTED_FEATURE / ERROR_NOT_AVAILABLE -
        // the same contract as the probe.
        let flatTableFallback = false;
        if (this._isUnavailable(lib.ctlFanSetFixedSpeedMode)) {
          flatTableFallback = true;
        } else {
          const setResult = lib.ctlFanSetFixedSpeedMode(fan, fixed);
          if (setResult === CTL_RESULT.SUCCESS) {
            const v = verifyFanConfig(fan, 'fixed', { fixedPct: clampFanPct(settings.fixedFanPct) });
            result.perControl.fixedFanPct = { ok: v.ok, readBackEqual: v.ok, errorCode: v.ok ? undefined : 'io-failed', message: v.message };
            fixedOk = v.ok;
            if (!v.ok) result.ok = false;
          } else if (setResult === CTL_RESULT.ERROR_UNSUPPORTED_FEATURE || setResult === CTL_RESULT.ERROR_NOT_AVAILABLE) {
            flatTableFallback = true;
          } else {
            fail('fixedFanPct', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          }
        }
        if (flatTableFallback) {
          if (this._isUnavailable(lib.ctlFanSetSpeedTableMode)) {
            fail('fixedFanPct', 'unavailable-symbol', 'fixed fan speed API missing in the IGCL runtime');
          } else {
            // Fixed on this card = a FLAT speed table (every temperature ->
            // the same speed - the IGS/Acer Alchemist mechanism). Write the
            // 2-point flat table (20C/100C, PERCENT units) and verify via
            // the CANONICAL 'curve' mode + the flatPct branch (a flat table
            // reads back mode 2 = 'curve').
            const flatTable = [20, 100].map((t) => ({
              Size: koffi.sizeof('ctl_fan_temp_speed_t'),
              Version: 0,
              temperature: t,
              speed: { Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: fixed.speed, units: fanUnits },
            }));
            const tableObj = { Size: koffi.sizeof('ctl_fan_speed_table_t'), Version: 0, numPoints: flatTable.length, table: flatTable };
            const setResult = lib.ctlFanSetSpeedTableMode(fan, tableObj);
            if (setResult === CTL_RESULT.SUCCESS) {
              const v = verifyFanConfig(fan, 'curve', { flatPct: clampFanPct(settings.fixedFanPct) });
              result.perControl.fixedFanPct = { ok: v.ok, readBackEqual: v.ok, errorCode: v.ok ? undefined : 'io-failed', message: v.message };
              fixedOk = v.ok;
              if (!v.ok) result.ok = false;
            } else {
              fail('fixedFanPct', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
            }
          }
        }
      }

      if (settings.fanMode) {
        if (mode === 'curve') {
          result.perControl.fanMode = curveOk ? { ok: true, readBackEqual: true } : (result.perControl.fanMode ?? { ok: false, errorCode: 'io-failed', message: 'fan curve apply failed' });
          if (!curveOk) result.ok = false;
        } else if (mode === 'fixed') {
          result.perControl.fanMode = fixedOk ? { ok: true, readBackEqual: true } : (result.perControl.fanMode ?? { ok: false, errorCode: 'io-failed', message: 'fixed fan speed apply failed' });
          if (!fixedOk) result.ok = false;
        } else if (mode === 'auto') {
          if (this._isUnavailable(lib.ctlFanSetDefaultMode)) {
            fail('fanMode', 'unavailable-symbol', 'fan default-mode API missing in the IGCL runtime');
          } else {
            const setResult = lib.ctlFanSetDefaultMode(fan);
            if (setResult === CTL_RESULT.SUCCESS) {
              const v = verifyFanConfig(fan, 'auto');
              result.perControl.fanMode = { ok: v.ok, readBackEqual: v.ok, errorCode: v.ok ? undefined : 'io-failed', message: v.message };
              if (!v.ok) result.ok = false;
            } else {
              fail('fanMode', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
            }
          }
        } else {
          fail('fanMode', 'out-of-range', `unknown fan mode ${settings.fanMode}`);
        }
      }
    };

    await applyScalar('powerLimit', 'powerLimitW', 'powerLimit', settings.powerLimitW);
    await applyScalar('tempLimit', 'tempLimitC', 'tempLimit', settings.tempLimitC);
    await applyScalar('vramFreqOffset', 'vramFreqOffsetGts', 'vramFreqOffset', settings.vramFreqOffsetGts);
    await applyScalar('vramVoltOffset', 'vramVoltOffsetV', 'vramVoltOffset', settings.vramVoltOffsetV);

    // M17e (round-1 S1a): the LOCK/OFFSET WRITE ORDER. The driver's lock
    // and offset families genuinely fight (IN_VOLTAGE_LOCKED_MODE refuses
    // offset writes while a lock is set), so the order depends on the
    // payload the caller composed (pinned by the call-order tests on the
    // fake lib's calls.sets):
    //   - a NON-ZERO lock (the atomic lock - the normalization zeroed any
    //     carried offsets): the zero-offset writes FIRST, then the lock -
    //     the driver must not still sit in offset mode when the lock lands;
    //   - a (0,0) unlock + non-zero offsets (the atomic unlock): the
    //     UNLOCK FIRST, then the offsets - a locked driver refuses the
    //     offset writes before the unlock. M22: the RENDERER no longer
    //     composes this shape (a {0,0} GpuLockSet write switches the 8974
    //     driver into a lock mode - the M17e atomic-unlock design is dead;
    //     offset applies carry no lock, the lock editor's 0/0 is the
    //     offset-reset payload with no lock key). The branch STAYS for
    //     direct/legacy callers - the backend contract is unchanged;
    //   - neither (offsets only, or a lone lock/unlock): the historical
    //     order (offsets then lock).
    const hasLockPair = settings.gpuLock !== undefined && settings.gpuLock !== null;
    const lockIsUnlock = !hasLockPair || (settings.gpuLock.voltageV === 0 && settings.gpuLock.freqMhz === 0);
    const hasOffsetWrites = (settings.gpuVoltOffsetV !== undefined && settings.gpuVoltOffsetV !== null)
      || (settings.gpuFreqOffsetMhz !== undefined && settings.gpuFreqOffsetMhz !== null);
    if (!lockIsUnlock) {
      // The non-zero lock: zero-offset writes first, then the lock.
      await applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', 'gpuFreqOffset', settings.gpuFreqOffsetMhz);
      await applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', 'gpuVoltOffset', settings.gpuVoltOffsetV);
      await applyLock(settings.gpuLock);
    } else if (hasLockPair && hasOffsetWrites) {
      // The (0,0) unlock + offsets: the unlock first, then the offsets.
      await applyLock(settings.gpuLock);
      await applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', 'gpuFreqOffset', settings.gpuFreqOffsetMhz);
      await applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', 'gpuVoltOffset', settings.gpuVoltOffsetV);
    } else {
      await applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', 'gpuFreqOffset', settings.gpuFreqOffsetMhz);
      await applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', 'gpuVoltOffset', settings.gpuVoltOffsetV);
      if (hasLockPair) await applyLock(settings.gpuLock);
    }
    await applyFan();

    // VF curve write path. The public contract is canonical volts/MHz while
    // the IGCL point struct is millivolts/MHz.
    if (settings.vfCurve !== null && settings.vfCurve !== undefined) {
      if (!caps.controls.vfCurve || this._isUnavailable(lib.ctlOverclockWriteCustomVFCurve)) {
        fail('vfCurve', 'unsupported', 'custom VF curve not supported on this device');
      } else {
        const curve = settings.vfCurve;
        const curveRange = caps.vfCurveRange;
        const validShape = Array.isArray(curve) && curve.length >= 2 && curve.length <= (curveRange?.maxPoints ?? 32)
          && curve.every((p) => Number.isFinite(p?.voltageV) && Number.isFinite(p?.freqMhz));
        const validOrder = validShape && curve.every((p, i) => i === 0
          || (p.voltageV > curve[i - 1].voltageV && p.freqMhz > curve[i - 1].freqMhz));
        const validRange = validShape && (!curveRange || curve.every((p) =>
          p.voltageV >= curveRange.voltageMinV && p.voltageV <= curveRange.voltageMaxV
          && p.freqMhz >= curveRange.freqMinMhz && p.freqMhz <= curveRange.freqMaxMhz));
        if (!validShape || !validOrder || !validRange) {
          fail('vfCurve', 'out-of-range', 'VF curve points must be ordered and stay within the driver voltage/frequency range');
        } else {
          const points = curve.map((p) => ({ Voltage: Math.round(p.voltageV * 1000), Frequency: Math.round(p.freqMhz) }));
          const pointsBuf = koffi.alloc('ctl_voltage_frequency_point_t', points.length);
          const pointSize = koffi.sizeof('ctl_voltage_frequency_point_t');
          points.forEach((point, index) => {
            koffi.encode(pointsBuf, index * pointSize, 'ctl_voltage_frequency_point_t', point);
          });
          const setResult = lib.ctlOverclockWriteCustomVFCurve(dev.handle, points.length, pointsBuf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            fail('vfCurve', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          } else {
            // Read-back verification (plan §5): re-read the curve and compare
            // point-by-point before reporting readBackEqual.
            let v;
            if (this._isUnavailable(lib.ctlOverclockReadVFCurve)) {
              v = { ok: false, message: 'VF curve write succeeded but read-back (ctlOverclockReadVFCurve) is unavailable' };
            } else {
              const numBuf = koffi.alloc('uint32', 1);
              koffi.encode(numBuf, 'uint32', 0);
              let res = lib.ctlOverclockReadVFCurve(dev.handle, 1, 2, numBuf, null);
              const num = koffi.decode(numBuf, 'uint32');
              if (res !== CTL_RESULT.SUCCESS) {
                v = { ok: false, message: `VF curve write succeeded but read-back failed (${describeResult(res)})` };
              } else if (num !== points.length) {
                v = { ok: false, message: `VF curve read-back ${num} points != requested ${points.length}` };
              } else {
                const curveBuf = koffi.alloc('ctl_voltage_frequency_point_t', num);
                res = lib.ctlOverclockReadVFCurve(dev.handle, 1, 2, numBuf, curveBuf);
                if (res !== CTL_RESULT.SUCCESS) {
                  v = { ok: false, message: `VF curve read-back failed (${describeResult(res)})` };
                } else {
                  const sz = koffi.sizeof('ctl_voltage_frequency_point_t');
                  v = { ok: true, previousVoltage: 0, previousFrequency: 0 };
                  for (let i = 0; i < num; i++) {
                    const pt = koffi.decode(curveBuf, i * sz, 'ctl_voltage_frequency_point_t');
                    if (!Number.isFinite(pt.Voltage) || !Number.isFinite(pt.Frequency)
                      || (i > 0 && (pt.Voltage <= v.previousVoltage || pt.Frequency <= v.previousFrequency))) {
                      v = { ok: false, message: `VF curve point ${i} read-back is not a valid ordered LIVE point` };
                      break;
                    }
                    // The native fields are integer millivolts/MHz. Allow
                    // one native unit of driver quantization, but do not
                    // accept an unrelated ordered curve as applied.
                    if (Math.abs(pt.Voltage - points[i].Voltage) > 1
                      || Math.abs(pt.Frequency - points[i].Frequency) > 1) {
                      v = { ok: false, message: `VF curve point ${i} read-back ${pt.Voltage} mV / ${pt.Frequency} MHz != requested ${points[i].Voltage} mV / ${points[i].Frequency} MHz` };
                      break;
                    }
                    v.previousVoltage = pt.Voltage;
                    v.previousFrequency = pt.Frequency;
                  }
                }
              }
            }
            result.perControl.vfCurve = {
              ok: v.ok,
              readBackEqual: v.ok,
              errorCode: v.ok ? undefined : 'io-failed',
              message: v.message,
              // F3 silent no-op: SUCCESS from the write with a mismatch on re-read.
              silentNoop: setResult === CTL_RESULT.SUCCESS && !v.ok,
            };
            if (!v.ok) result.ok = false;
          }
        }
      }
    }

    // Reconciliation for a driver-level waiver loss (G2): the driver can
    // lose the waiver (reinstall, IGS reset) while settings.json still says
    // accepted - every setter then answers waiver-not-set. Clear the stale
    // in-memory flag so getCapabilities reports unaccepted and the next
    // apply re-shows the waiver dialog. This NEVER accepts anything;
    // re-acceptance still requires the explicit waiver-accept path.
    if (Object.values(result.perControl).some((p) => p.errorCode === 'waiver-not-set')) {
      this._waiverAccepted.delete(deviceId);
    }

    return result;
  }

  async resetToDefaults(deviceId) {
    await this._device(deviceId);
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    if (this._isUnavailable(lib.ctlOverclockResetToDefault)) {
      throw new Error('ctlOverclockResetToDefault symbol unavailable in the IGCL runtime');
    }
    const result = lib.ctlOverclockResetToDefault(dev.handle);
    if (result !== CTL_RESULT.SUCCESS) {
      throw new Error(`ctlOverclockResetToDefault failed: ${describeResult(result)}`);
    }
  }

  async setWaiverAccepted(deviceId) {
    await this._device(deviceId);
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    if (this._isUnavailable(lib.ctlOverclockWaiverSet)) {
      throw new Error('ctlOverclockWaiverSet symbol unavailable in the IGCL runtime');
    }
    const result = lib.ctlOverclockWaiverSet(dev.handle);
    if (result !== CTL_RESULT.SUCCESS) {
      // M17 (B50-class): the driver refuses the waiver on OC-locked devices
      // (ERROR_UNSUPPORTED_FEATURE) - the raw code is a dead end for the
      // user, name the actual situation. getCapabilities already reports
      // overclockingSupported:false on such devices, so the product paths
      // never get here; this maps the honest residual (a stale UI, a
      // race, an elevated worker) to a message instead of a hex code.
      if (result === CTL_RESULT.ERROR_UNSUPPORTED_FEATURE) {
        throw new Error('Overclocking is not supported on this GPU - the driver refused the warranty waiver (ERROR_UNSUPPORTED_FEATURE)');
      }
      throw new Error(`ctlOverclockWaiverSet failed: ${describeResult(result)}`);
    }
    this._waiverAccepted.set(deviceId, true);
  }

  /**
   * Boot-time seeding of a persisted waiver acceptance (F1): sets ONLY the
   * in-memory flag - NEVER calls ctlOverclockWaiverSet, which must run only
   * on explicit user acceptance (waiver-accept -> setWaiverAccepted). Called
   * from main at boot with the ProfileStore's persisted settings.
   * @param {number} deviceId
   * @param {boolean} accepted
   */
  async restoreWaiverState(deviceId, accepted) {
    if (accepted) this._waiverAccepted.set(deviceId, true);
    else this._waiverAccepted.delete(deviceId);
  }

  // -------------------------------------------------------------------------
  // Telemetry (raw, 1:1 from IGCL)
  // -------------------------------------------------------------------------

  async sampleRawTelemetry(deviceId) {
    await this._device(deviceId);
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const integratedOrMobile = dev.integrated === true || dev.mobile === true;
    const hasV2 = !this._isUnavailable(lib.ctlPowerTelemetryGetV2);
    const hasV1 = !this._isUnavailable(lib.ctlPowerTelemetryGet);
    if (!hasV2 && !hasV1) throw new Error('no IGCL power telemetry API is available in the runtime');

    let telemetryType;
    let telBuf;
    let result;
    if (hasV2) {
      telemetryType = 'ctl_power_telemetry_v2_t';
      telBuf = koffi.alloc(telemetryType, 1);
      koffi.encode(telBuf, telemetryType, { Size: koffi.sizeof(telemetryType), Version: 1 });
      result = lib.ctlPowerTelemetryGetV2(dev.handle, telBuf);
      if (isPowerTelemetryV2CompatibilityError(result) && hasV1) {
        telemetryType = 'ctl_power_telemetry_t';
        telBuf = koffi.alloc(telemetryType, 1);
        koffi.encode(telBuf, telemetryType, { Size: koffi.sizeof(telemetryType), Version: 1 });
        result = lib.ctlPowerTelemetryGet(dev.handle, telBuf);
      }
    } else {
      telemetryType = 'ctl_power_telemetry_t';
      telBuf = koffi.alloc(telemetryType, 1);
      koffi.encode(telBuf, telemetryType, { Size: koffi.sizeof(telemetryType), Version: 1 });
      result = lib.ctlPowerTelemetryGet(dev.handle, telBuf);
    }
    if (result !== CTL_RESULT.SUCCESS) {
      const api = telemetryType === 'ctl_power_telemetry_v2_t' ? 'ctlPowerTelemetryGetV2' : 'ctlPowerTelemetryGet';
      throw new Error(`${api} failed: ${describeResult(result)}`);
    }

    const item = (n) => {
      const it = decodeItem(telBuf, telemetryType, n);
      return it.bSupported ? it.value : undefined;
    };
    const throttleBool = (n) => {
      try { return koffi.decode(telBuf, koffi.offsetof(telemetryType, n), 'bool'); } catch { return undefined; }
    };

    const currentClockMhz = item('gpuCurrentClockFrequency');
    const effectiveClockMhz = item('gpuEffectiveClock');
    const gpuEnergyJ = item('gpuEnergyCounter');
    const totalEnergyJ = item('totalCardEnergyCounter');
    const sample = {
      t: item('timeStamp'),
      // IGCL exposes both an instantaneous clock and an effective clock. The
      // effective value matches the shared-clock behavior of iGPUs/mobile
      // parts, while discrete adapters must retain the instantaneous value
      // used by the existing telemetry contract. Either field can be absent.
      gpuClockMhz: integratedOrMobile
        ? (effectiveClockMhz ?? currentClockMhz)
        : (currentClockMhz ?? effectiveClockMhz),
      memClockMhz: item('vramCurrentClockFrequency'),
      tempC: item('gpuCurrentTemperature'),
      vramTempC: item('vramCurrentTemperature'),
      gpuVoltageV: item('gpuVoltage'),
      gpuEnergyJ,
      vramEnergyJ: item('vramEnergyCounter'),
      totalEnergyJ,
      fanRpm: [],
      throttle: {
        power: throttleBool('gpuPowerLimited'),
        temp: throttleBool('gpuTemperatureLimited'),
        current: throttleBool('gpuCurrentLimited'),
        voltage: throttleBool('gpuVoltageLimited'),
        util: throttleBool('gpuUtilizationLimited'),
      },
    };
    if (integratedOrMobile) sample.powerEnergyJ = totalEnergyJ ?? gpuEnergyJ;
    try {
      const off = koffi.offsetof(telemetryType, 'fanSpeed');
      const sz = koffi.sizeof('ctl_oc_telemetry_item_t');
      for (let i = 0; i < 5; i++) {
        const f = koffi.decode(telBuf, off + i * sz, 'ctl_oc_telemetry_item_t');
        if (f.bSupported) sample.fanRpm.push(f.value);
      }
    } catch { /* keep empty */ }
    if (sample.fanRpm.length === 0) delete sample.fanRpm;

    for (const k of Object.keys(sample)) {
      if (sample[k] === undefined || sample[k] === null) delete sample[k];
    }

    // M17c (the iGPU temperature fallback): when the telemetry item is
    // ABSENT (unsupported - the gpuCurrentTemperature item can be missing
    // on integrated adapters / driver builds), fall back to the
    // temperature-sensor API (ctlEnumTemperatureSensors +
    // ctlTemperatureGetState - the igcl_api.h temperature surface). The
    // honest '-' stays when the driver reports no sensor (the N4-style
    // once-per-session degrade note - the 32.0.101.8860 regression
    // precedent). M17c (step-5 N2): the NO-SENSOR verdict latches per
    // device - a failed probe (no sensor / enum / read failure) is marked
    // so the fallback does NOT re-enumerate + re-scan sensor properties
    // on every 500 ms tick (the native churn stops after the first failed
    // probe); a device that HAS a sensor keeps reading every tick.
    if (sample.tempC === undefined) {
      const sensorTemp = this._tempSensorNoSensor.has(deviceId)
        ? undefined
        : this._temperatureSensorTempC(dev, deviceId);
      if (sensorTemp !== undefined) {
        sample.tempC = sensorTemp;
      } else {
        this._tempSensorNoSensor.add(deviceId);
      }
    }

    // M3-C-L: utilization from the IGCL activity counters over timestamp
    // deltas - the DOCUMENTED sample-delta method (igcl_api.h
    // §ctl_power_telemetry_t): globalActivityCounter / renderComputeActivity-
    // Counter measure busy TIME IN SECONDS (accurate to 1 ms) that any GPU
    // engine / the 3D-compute engines are busy; dividing the delta by the
    // timestamp delta (also seconds, timeStamp = seconds since epoch) yields
    // the average percentage utilization. The GLOBAL counter is preferred;
    // renderCompute is the fallback - which is populated on this card is
    // validated by the live probe (tools/validate/m3c-util-probe.js).
    const globalActivity = item('globalActivityCounter');
    const renderCompute = item('renderComputeActivityCounter');
    const counter = (typeof globalActivity === 'number' && Number.isFinite(globalActivity)) ? globalActivity
      : (typeof renderCompute === 'number' && Number.isFinite(renderCompute)) ? renderCompute
      : undefined;
    const utilPct = this._computeUtilPct(deviceId, sample.t, counter);
    if (utilPct !== undefined) sample.utilPct = utilPct;

    this._emitTelemetry(deviceId, sample);
    return sample;
  }

  /**
   * M3-C-L: utilization = activityCounterDelta / timestampDelta * 100.
   * Undefined on the first sample (no delta), on missing/non-finite inputs,
   * on a counter reset (negative delta) and on non-positive time deltas.
   * Clamped to [0, 100] - a counter that runs slightly ahead of the
   * timestamp never reports >100%.
   * @param {number} deviceId
   * @param {number} t telemetry timestamp (seconds)
   * @param {number | undefined} counter the busy-time counter (seconds)
   * @returns {number | undefined} utilPct
   */
  _computeUtilPct(deviceId, t, counter) {
    if (typeof counter !== 'number' || typeof t !== 'number' || !Number.isFinite(t)) return undefined;
    const prev = this._activity.get(deviceId);
    this._activity.set(deviceId, { t, counter });
    if (!prev || typeof prev.counter !== 'number') return undefined;
    const dt = t - prev.t;
    const dc = counter - prev.counter;
    if (!Number.isFinite(dt) || !Number.isFinite(dc) || dt <= 0 || dc < 0) return undefined;
    const util = (dc / dt) * 100;
    if (!Number.isFinite(util)) return undefined;
    return Math.min(100, Math.max(0, util));
  }

  /**
   * M17c: the iGPU temperature fallback source - the IGCL temperature-
   * sensor API (ctlEnumTemperatureSensors handle-array enumeration +
   * ctlTemperatureGetState, which returns the current temperature in
   * degrees C via a double* - the igcl_api.h contract, NOT a state struct;
   * see igcl-bindings.js). PREFERS the GPU-domain sensor (type 1), falls
   * back to the first enumerated sensor. EVERYTHING null-safe:
   * - unbound symbols -> undefined (the sample keeps the honest absent
   *   tempC);
   * - a failed enumeration -> undefined;
   * - zero sensors -> undefined + the ONCE-PER-SESSION N4-style degrade
   *   note (the 32.0.101.8860 regression precedent: a driver build that
   *   reports no sensor must not spam every telemetry tick);
   * - a failed read -> undefined.
   * @param {object} dev the device payload (handle)
   * @param {number} deviceId for the once-per-session note flag
   * @returns {number | undefined} the current GPU temperature in C
   */
  _temperatureSensorTempC(dev, deviceId) {
    const lib = this._libOrThrow();
    if (this._isUnavailable(lib.ctlEnumTemperatureSensors) || this._isUnavailable(lib.ctlTemperatureGetState)) {
      return undefined;
    }
    const noteNoSensor = (extra) => {
      if (this._tempSensorDegradeNoted.has(deviceId)) return;
      this._tempSensorDegradeNoted.add(deviceId);
      console.warn(`[igcl-backend] temperature fallback: ${extra} on device ${deviceId} - the GPU temp row stays '-' (the 32.0.101.8860 no-sensor regression precedent)`);
    };
    try {
      // Phase 1: the count probe (the ctlEnumerateDevices pattern). The
      // handles pointer is [optional] in the header - pass a dummy buffer
      // (null-pointer handling varies across koffi versions).
      const countBuf = koffi.alloc('uint32', 1);
      koffi.encode(countBuf, 0, 'uint32', 0);
      const probeBuf = koffi.alloc('uint8', 8);
      let result = lib.ctlEnumTemperatureSensors(dev.handle, countBuf, probeBuf);
      if (result !== CTL_RESULT.SUCCESS) return undefined;
      const count = koffi.decode(countBuf, 0, 'uint32') | 0;
      if (count === 0) {
        noteNoSensor('ctlEnumTemperatureSensors reports no sensor');
        return undefined;
      }
      // Phase 2: the fill - a raw handle array (8 bytes per handle).
      const handlesBuf = koffi.alloc('uint8', count * 8);
      result = lib.ctlEnumTemperatureSensors(dev.handle, countBuf, handlesBuf);
      if (result !== CTL_RESULT.SUCCESS) return undefined;
      // Prefer the GPU-domain sensor (type 1); fall back to the first.
      let pick = -1;
      if (!this._isUnavailable(lib.ctlTemperatureGetProperties)) {
        for (let i = 0; i < count; i++) {
          const propBuf = koffi.alloc('ctl_temp_properties_t', 1);
          koffi.encode(propBuf, 'ctl_temp_properties_t', { Size: koffi.sizeof('ctl_temp_properties_t'), Version: 0 });
          const handle = koffi.decode(handlesBuf, i * 8, 'void*');
          if (lib.ctlTemperatureGetProperties(handle, propBuf) === CTL_RESULT.SUCCESS) {
            const props = koffi.decode(propBuf, 'ctl_temp_properties_t');
            if (props.type === 1) { pick = i; break; } // CTL_TEMP_SENSORS_GPU
          }
        }
      }
      if (pick < 0 && count > 0) pick = 0;
      const sensorHandle = koffi.decode(handlesBuf, pick * 8, 'void*');
      const tempBuf = koffi.alloc('double', 1);
      result = lib.ctlTemperatureGetState(sensorHandle, tempBuf);
      if (result !== CTL_RESULT.SUCCESS) return undefined;
      const temp = koffi.decode(tempBuf, 0, 'double');
      return typeof temp === 'number' && Number.isFinite(temp) ? temp : undefined;
    } catch {
      return undefined;
    }
  }

  _emitTelemetry(deviceId, sample) {
    const cbs = this._telemetryCbs.get(deviceId);
    if (cbs) for (const cb of cbs) { try { cb(sample); } catch { /* subscriber errors must not break the loop */ } }
  }

  onRawTelemetry(deviceId, cb) {
    if (!this._telemetryCbs.has(deviceId)) this._telemetryCbs.set(deviceId, new Set());
    this._telemetryCbs.get(deviceId).add(cb);
    return () => {
      const set = this._telemetryCbs.get(deviceId);
      if (set) set.delete(cb);
    };
  }

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  async health() {
    let driverVersion = null;
    let error;
    try {
      if (this._apiHandle) {
        const devices = await this._ensureDevices();
        driverVersion = devices[0]?.driverVersion ?? null;
      }
    } catch (e) {
      error = e.message;
    }
    return {
      igclLoaded: Boolean(this._apiHandle),
      driverVersion,
      levelZeroOk: this._levelZeroOk,
      error: this._initError?.message ?? error,
    };
  }
}
