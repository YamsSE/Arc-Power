// Arc Power - M17f the Level Zero Sysman power-limits consumer (the PL2
// companion). The IGCL powerLimit control writes the SUSTAINED (PL1) limit
// only; the burst/boost (PL2) limit is a separate domain. This consumer
// reads/writes the Sysman pair (ze_loader.dll -> zesPowerGetLimits/
// zesPowerSetLimits - the M2b bindings, see docs/sysman.md for the struct
// layouts) so the apply path can sync the burst limit after the IGCL write.
//
// The seam is INJECTABLE (constructor opts) so the unit tests + the mock
// mode substitute a fake loader/lib - the real ze_loader.dll is never
// loaded in tests/mock. Everything is DEFENSIVE: the loader or the card
// power domain absent -> readLimits() returns null + setLimits() answers
// { ok: false, errorCode: 'unavailable' } - the honest degrade, never a
// throw (the apply path treats a sysman failure as best-effort).

import koffi from 'koffi';
import {
  findZeLoaderDll, loadSysman, zeOk, describeZeResultWithMap,
  selectZeResultMap, enumerateHandles, ZES_STRUCTURE_TYPE_FREQ_PROPERTIES,
  ZES_STRUCTURE_TYPE_OVERCLOCK_PROPERTIES, ZES_DOMAIN_TYPE_GPU, ZES_VF_TYPE, ZES_VF_ARRAY_TYPE,
  ZES_OVERCLOCK_CONTROL_VF, ZES_GPU_OVERCLOCK_DOMAIN_PRIORITY,
} from './sysman-bindings.js';

// M17h: the enum binding joins the REQUIRED exports - the domain resolution
// is enum-FIRST (see ensure() below), so a loader without the enum symbol
// must degrade honestly (the missing-exports reason), never throw.
const REQUIRED_EXPORTS = [
  'zeInit', 'zeDriverGet', 'zeDeviceGet',
  'zesInit', 'zesDriverGet', 'zesDeviceGet',
  'zesDeviceEnumPowerDomains', 'zesDeviceGetCardPowerDomain',
  'zesPowerGetLimits', 'zesPowerSetLimits',
];

// M26: the optional frequency-domain exports. Missing exports degrade ONLY
// voltage methods - the existing PL consumer is never affected.
const FREQ_READ_EXPORTS = [
  'zesDeviceEnumFrequencyDomains',
  'zesFrequencyGetProperties',
  'zesFrequencyOcGetVoltageTarget',
];
// M26: the user-approved Alchemist-wide voltage range (canonical volts).
// Stock UI clamps at -0.500 V; Advanced UI may reach -0.800 V. The live
// capability 0/0 offset bounds are diagnostic only. Positive max remains
// the existing per-card +0.234/+0.288 V.
export const SAFE_VOLT_OFFSET_MIN_V = -0.800;
const VF_READ_EXPORTS = [
  'zesDeviceEnumOverclockDomains',
  'zesOverclockGetDomainProperties',
  'zesOverclockGetDomainVFProperties',
  'zesOverclockGetVFPointValues',
];

export const VF_VOLTAGE_MIN_MV = 1;
export const VF_VOLTAGE_MAX_MV = 0xffffffff;

/** Convert a DEFAULT unsigned-mV point to an idempotent lowered point. */
export function transformDefaultVoltageMv(defaultMv, magnitudeV, {
  minMv = VF_VOLTAGE_MIN_MV, maxMv = VF_VOLTAGE_MAX_MV, stepMv = 1,
} = {}) {
  if (!Number.isFinite(defaultMv) || !Number.isFinite(magnitudeV) || magnitudeV < 0) return null;
  const step = Number.isFinite(stepMv) && stepMv > 0 ? Math.max(1, Math.round(stepMv)) : 1;
  const requested = Math.max(0, Math.round(magnitudeV * 1000));
  const aligned = Math.floor(requested / step) * step;
  const floor = Math.max(VF_VOLTAGE_MIN_MV, Math.ceil(Number.isFinite(minMv) ? minMv : VF_VOLTAGE_MIN_MV));
  const ceiling = Math.min(VF_VOLTAGE_MAX_MV, Math.floor(Number.isFinite(maxMv) ? maxMv : VF_VOLTAGE_MAX_MV));
  if (floor > ceiling) return null;
  return Math.max(floor, Math.min(ceiling, Math.round(defaultMv) - aligned)) >>> 0;
}

export function isUnsignedVoltageMv(value) {
  return Number.isInteger(value) && value >= 0 && value <= VF_VOLTAGE_MAX_MV;
}
export const SAFE_VOLT_OFFSET_MAX_V = 0.234;

// M26: the live A770 driver boundary is integer millivolts despite the
// public header's volts wording. `Math.round(offsetV * 1000)` converts
// canonical volts to the driver's mV. No live probe may write below -300 mV.

const W = (powerMw) => Math.round((powerMw / 1000) * 10) / 10;

/**
 * The real sysman power-limits adapter. Lazily resolves ze_loader.dll + the
 * card power domain on the FIRST call; a failure latches the honest
 * unavailable state (the once-per-session degrade note - the M17c
 * no-sensor-latch precedent: a missing loader/domain must not re-run the
 * whole init chain on every telemetry/apply tick).
 *
 * Contract (the plan's interface, pinned):
 *   readLimits(deviceId) -> { sustainedW, burstW, peakW } | null
 *   setLimits({ sustainedW, burstW }) -> { ok, errorCode?, message? }
 *
 * The real adapter is DEVICE-AGNOSTIC: the layer resolves the enumerated
 * card power domain once (ze/zes enumerate the same devices in the same
 * order), so readLimits accepts the deviceId for the MOCK-scoped contract
 * and ignores it (the M17f step-4 N2 note: the domain is per-device; the
 * MOCK keys on the deviceId - the real layer reads the one card domain).
 *
 * @param {{
 *   findLoader?: () => string | null,
 *   load?: (dllPath: string) => object,
 *   log?: (s: string) => void,
 * }} [opts]
 */
export function createSysmanPowerLimits({ findLoader = findZeLoaderDll, load = loadSysman, log = (s) => console.log(`[sysman] ${s}`) } = {}) {
  /** @type {{ lib: object, pwrHandle: unknown } | null} */
  let ready = null;
  /** @type {Map<number, { lib: object, freqHandle: unknown, deviceId: number }>} */
  const freqReady = new Map();
  /** @type {Map<number, unknown>} */
  const deviceHandles = new Map();
  /** @type {Map<number, { domain: unknown, pointCount: number, stepMv: number, minMv: number, maxMv: number, defaults: number[] }>} */
  const vfReady = new Map();
  /** @type {Map<number, string>} */
  const freqStatus = new Map();
  /** @type {Map<number, string>} */
  const vfStatus = new Map();
  const waiverReady = new Set();
  let resultMap = selectZeResultMap(null);
  let degradeReason = null;
  let degradeNoted = false;

  const ensure = () => {
    if (ready !== null) return ready;
    if (degradeReason !== null) return null;
    const dllPath = findLoader();
    if (!dllPath) {
      degradeReason = 'ze_loader.dll not found - the PL2 read-out stays \'-\' (the honest degrade)';
      return null;
    }
    let lib;
    try {
      lib = load(dllPath);
    } catch (err) {
      degradeReason = `ze_loader.dll load failed: ${err.message}`;
      return null;
    }
    const missing = REQUIRED_EXPORTS.filter((n) => typeof lib[n] !== 'function');
    if (missing.length > 0) {
      degradeReason = `ze_loader.dll is missing exports: ${missing.join(', ')}`;
      return null;
    }
    try {
      // The ze/zes init chain (the M2b probe pattern - match by
      // enumeration order: ze and zes enumerate the same devices in the
      // same order, the documented Level Zero contract).
      let r = lib.zeInit(0);
      if (!zeOk(r)) throw new Error(`zeInit: ${resultText(r)}`);
      const zeDriverCountBuf = koffi.alloc('uint32', 1);
      r = lib.zeDriverGet(zeDriverCountBuf, null);
      if (!zeOk(r)) throw new Error(`zeDriverGet count: ${resultText(r)}`);
      const zeDriverCount = koffi.decode(zeDriverCountBuf, 'uint32');
      if (zeDriverCount === 0) throw new Error('no ze drivers');
      const zeDriversBuf = koffi.alloc('void*', zeDriverCount);
      r = lib.zeDriverGet(zeDriverCountBuf, zeDriversBuf);
      if (!zeOk(r)) throw new Error(`zeDriverGet fill: ${resultText(r)}`);
      const zeDriver = koffi.decode(zeDriversBuf, 0, 'void*');
      if (typeof lib.zeDriverGetApiVersion === 'function') {
        try {
          const versionBuf = koffi.alloc('uint32', 1);
          const versionResult = lib.zeDriverGetApiVersion(zeDriver, versionBuf);
          if (zeOk(versionResult)) resultMap = selectZeResultMap(koffi.decode(versionBuf, 'uint32'));
        } catch {
          resultMap = selectZeResultMap(null);
        }
      }
      const zeCountBuf = koffi.alloc('uint32', 1);
      r = lib.zeDeviceGet(zeDriver, zeCountBuf, null);
      if (!zeOk(r)) throw new Error(`zeDeviceGet count: ${resultText(r)}`);
      const zeDevCount = koffi.decode(zeCountBuf, 'uint32');
      if (zeDevCount === 0) throw new Error('no ze devices');
      const zeDevBuf = koffi.alloc('void*', zeDevCount);
      r = lib.zeDeviceGet(zeDriver, zeCountBuf, zeDevBuf);
      if (!zeOk(r)) throw new Error(`zeDeviceGet fill: ${resultText(r)}`);

      r = lib.zesInit(0);
      if (!zeOk(r)) throw new Error(`zesInit: ${resultText(r)}`);
      const zesDriverCountBuf = koffi.alloc('uint32', 1);
      r = lib.zesDriverGet(zesDriverCountBuf, null);
      if (!zeOk(r)) throw new Error(`zesDriverGet count: ${resultText(r)}`);
      const zesDriverCount = koffi.decode(zesDriverCountBuf, 'uint32');
      if (zesDriverCount === 0) throw new Error('no zes drivers');
      const zesDriversBuf = koffi.alloc('void*', zesDriverCount);
      r = lib.zesDriverGet(zesDriverCountBuf, zesDriversBuf);
      if (!zeOk(r)) throw new Error(`zesDriverGet fill: ${resultText(r)}`);
      const zesDriver = koffi.decode(zesDriversBuf, 0, 'void*');
      const zesCountBuf = koffi.alloc('uint32', 1);
      r = lib.zesDeviceGet(zesDriver, zesCountBuf, null);
      if (!zeOk(r)) throw new Error(`zesDeviceGet count: ${resultText(r)}`);
      const zesDevCount = koffi.decode(zesCountBuf, 'uint32');
      if (zesDevCount === 0) throw new Error('no zes devices');
      const zesDevBuf = koffi.alloc('void*', zesDevCount);
      r = lib.zesDeviceGet(zesDriver, zesCountBuf, zesDevBuf);
      if (!zeOk(r)) throw new Error(`zesDeviceGet fill: ${resultText(r)}`);
      deviceHandles.clear();
      for (let i = 0; i < zesDevCount; i++) {
        deviceHandles.set(i, koffi.decode(zesDevBuf, i * 8, 'void*'));
      }

      // M17h THE DOMAIN-RESOLUTION FIX (the root cause of the dev-box
      // 'PL1 - / PL2 -' + the companion degrade): the power domain resolves
      // via zesDeviceEnumPowerDomains FIRST (the two-step count+fill - the
      // enumerateHandles helper, sysman-bindings.js - the general spec'd
      // contract; the dev A770: SUCCESS count 1, the domain reads the
      // limits) with zesDeviceGetCardPowerDomain as the FALLBACK when the
      // enum yields NO USABLE domain (count 0, an enum error, OR the
      // enumerated handle FAILS a one-shot zesPowerGetLimits probe at
      // ensure()-time - the Acer box's getter path is PROVEN-GOOD today
      // while its enum behavior is unknown, so the fallback fires on 'no
      // usable domain from the enum', never only on the enum call failing).
      const zesDev = koffi.decode(zesDevBuf, 0, 'void*');
      const en = enumerateHandles((countBuf, arr) => lib.zesDeviceEnumPowerDomains(zesDev, countBuf, arr));
      let pwrHandle = null;
      let enumVerdict = null;
      if (!zeOk(en.result)) {
        enumVerdict = `zesDeviceEnumPowerDomains: ${resultText(en.result)}`;
      } else if (en.handles.length === 0) {
        enumVerdict = 'zesDeviceEnumPowerDomains yielded no domains (count 0)';
      } else {
        // The one-shot probe: the FIRST enumerated handle that reads the
        // limits is the usable domain; every handle failing the probe
        // means the enum yielded NO usable domain (the round-1 S2 trigger).
        for (const candidate of en.handles) {
          const sb = koffi.alloc('zes_power_sustained_limit_t', 1);
          const bb = koffi.alloc('zes_power_burst_limit_t', 1);
          const pb = koffi.alloc('zes_power_peak_limit_t', 1);
          if (zeOk(lib.zesPowerGetLimits(candidate, sb, bb, pb))) { pwrHandle = candidate; break; }
        }
        if (pwrHandle === null) enumVerdict = 'the enumerated power domains failed the one-shot zesPowerGetLimits probe';
      }
      if (pwrHandle === null) {
        // The getter fallback (the M17f consumer's original call).
        const pwrBuf = koffi.alloc('void*', 1);
        r = lib.zesDeviceGetCardPowerDomain(zesDev, pwrBuf);
        if (zeOk(r)) {
          pwrHandle = koffi.decode(pwrBuf, 0, 'void*');
        } else {
          throw new Error(`no usable power domain: ${enumVerdict}; fallback zesDeviceGetCardPowerDomain: ${resultText(r)}`);
        }
      }
      ready = { lib, pwrHandle };

      // M26: resolve the GPU frequency domain alongside the power domain.
      // Missing frequency exports/domain degrade ONLY voltage methods -
      // the existing PL consumer is never affected.
      const hasFreqExports = FREQ_READ_EXPORTS.every((n) => typeof lib[n] === 'function');
      const unsupportedFreqResult = (result) => {
        try {
          const text = resultText(result);
          return text.includes('UNSUPPORTED') || text.includes('NOT_SUPPORTED');
        } catch {
          return false;
        }
      };
      for (const [deviceId, device] of deviceHandles.entries()) {
        if (!hasFreqExports) {
          freqStatus.set(deviceId, 'unsupported');
          continue;
        }
        let status = 'unsupported';
        try {
          const freqEn = enumerateHandles((countBuf, arr) => lib.zesDeviceEnumFrequencyDomains(device, countBuf, arr));
          if (!zeOk(freqEn.result)) {
            status = unsupportedFreqResult(freqEn.result) ? 'unsupported' : 'io-failed';
          } else if (freqEn.handles.length > 0) {
            let propertyReadFailed = false;
            for (const candidate of freqEn.handles) {
              try {
                const fpBuf = koffi.alloc('zes_freq_properties_t', 1);
                koffi.encode(fpBuf, 'zes_freq_properties_t', {
                  stype: ZES_STRUCTURE_TYPE_FREQ_PROPERTIES,
                  pNext: null,
                  type: 0,
                  onSubdevice: 0,
                  subdeviceId: 0,
                  canControl: 0,
                  isThrottleEventSupported: 0,
                  min: 0,
                  max: 0,
                });
                const freqResult = lib.zesFrequencyGetProperties(candidate, fpBuf);
                if (!zeOk(freqResult)) {
                  propertyReadFailed = true;
                  continue;
                }
                const fp = koffi.decode(fpBuf, 'zes_freq_properties_t');
                if (fp.type === ZES_DOMAIN_TYPE_GPU) {
                  freqReady.set(deviceId, { lib, freqHandle: candidate, deviceId });
                  status = 'ready';
                  break;
                }
              } catch {
                propertyReadFailed = true;
              }
            }
            if (status !== 'ready' && propertyReadFailed) status = 'io-failed';
          }
        } catch {
          status = 'io-failed';
        }
        freqStatus.set(deviceId, status);
      }

      return ready;
    } catch (err) {
      degradeReason = err instanceof Error ? err.message : String(err);
      return null;
    }
  };

  const noteDegrade = () => {
    if (degradeNoted) return;
    degradeNoted = true;
    log(degradeReason ?? 'the sysman layer is unavailable');
  };
  const resultText = (code) => describeZeResultWithMap(code, resultMap);

  const readVfCurves = (lib, vf) => {
    const curves = { user: [], defaults: [], live: [] };
    const arrays = [
      ['user', ZES_VF_ARRAY_TYPE.USER],
      ['defaults', ZES_VF_ARRAY_TYPE.DEFAULT],
      ['live', ZES_VF_ARRAY_TYPE.LIVE],
    ];
    for (let i = 0; i < vf.pointCount; i++) {
      for (const [name, arrayType] of arrays) {
        const pointBuf = koffi.alloc('uint32', 1);
        const result = lib.zesOverclockGetVFPointValues(vf.domain, ZES_VF_TYPE.VOLT, arrayType, i, pointBuf);
        if (!zeOk(result)) return null;
        const value = koffi.decode(pointBuf, 'uint32');
        if (!isUnsignedVoltageMv(value)) return null;
        curves[name].push(value);
      }
    }
    return curves;
  };

  const ensureVf = (deviceId = 0) => {
    if (vfReady.has(deviceId)) return vfReady.get(deviceId);
    if (vfStatus.has(deviceId)) return null;
    const r = ensure();
    if (!r || !deviceHandles.has(deviceId)) {
      vfStatus.set(deviceId, 'unsupported');
      return null;
    }
    const missing = VF_READ_EXPORTS.filter((name) => typeof r.lib[name] !== 'function');
    if (missing.length > 0) {
      vfStatus.set(deviceId, 'unsupported');
      return null;
    }
    const unsupportedResult = (result) => {
      const code = result >>> 0;
      const text = resultText(result);
      // The installed A770 v1.32 driver reports this optional-domain
      // capability absence as 0x78000003 even when its version query is
      // unavailable; this is an unsupported VF surface, not a transient I/O
      // failure. Keep the generic result formatter version-aware elsewhere.
      return code === 0x78000003 || code === 0x7800000d
        || text.includes('UNSUPPORTED') || text.includes('NOT_SUPPORTED');
    };
    const dev = deviceHandles.get(deviceId);
    try {
      const domains = enumerateHandles((countBuf, arr) => r.lib.zesDeviceEnumOverclockDomains(dev, countBuf, arr));
      if (!zeOk(domains.result)) {
        vfStatus.set(deviceId, unsupportedResult(domains.result) ? 'unsupported' : 'io-failed');
        return null;
      }
      const candidates = [];
      let propertyIoFailure = false;
      for (const domain of domains.handles) {
        const propsBuf = koffi.alloc('zes_overclock_properties_t', 1);
        koffi.encode(propsBuf, 'zes_overclock_properties_t', {
          stype: ZES_STRUCTURE_TYPE_OVERCLOCK_PROPERTIES,
          pNext: null,
          domainType: 0,
          AvailableControls: 0,
          VFProgramType: 0,
          NumberOfVFPoints: 0,
        });
        let propsResult;
        try {
          propsResult = r.lib.zesOverclockGetDomainProperties(domain, propsBuf);
        } catch {
          propertyIoFailure = true;
          continue;
        }
        if (!zeOk(propsResult)) {
          if (!unsupportedResult(propsResult)) propertyIoFailure = true;
          continue;
        }
        let props;
        try {
          props = koffi.decode(propsBuf, 'zes_overclock_properties_t');
        } catch {
          propertyIoFailure = true;
          continue;
        }
        const rank = ZES_GPU_OVERCLOCK_DOMAIN_PRIORITY.indexOf(props.domainType);
        if (rank < 0 || (props.AvailableControls & ZES_OVERCLOCK_CONTROL_VF) === 0
          || !Number.isInteger(props.NumberOfVFPoints) || props.NumberOfVFPoints <= 0) continue;
        candidates.push({ domain, props, rank });
      }
      candidates.sort((a, b) => a.rank - b.rank);
      if (candidates.length === 0) {
        vfStatus.set(deviceId, propertyIoFailure ? 'io-failed' : 'unsupported');
        return null;
      }
      let readFailure = false;
      for (const { domain, props } of candidates) {
        const vfPropsBuf = koffi.alloc('zes_vf_property_t', 1);
        const vfPropsResult = r.lib.zesOverclockGetDomainVFProperties(domain, vfPropsBuf);
        if (!zeOk(vfPropsResult)) {
          readFailure = true;
          continue;
        }
        const vfProps = koffi.decode(vfPropsBuf, 'zes_vf_property_t');
        const found = {
          domain,
          pointCount: props.NumberOfVFPoints,
          stepMv: Number.isFinite(vfProps.StepVolt) && vfProps.StepVolt > 0 ? vfProps.StepVolt : 1,
          minMv: Number.isFinite(vfProps.MinVolt) ? vfProps.MinVolt : VF_VOLTAGE_MIN_MV,
          maxMv: Number.isFinite(vfProps.MaxVolt) ? vfProps.MaxVolt : VF_VOLTAGE_MAX_MV,
        };
        const curves = readVfCurves(r.lib, found);
        if (!curves) {
          readFailure = true;
          continue;
        }
        found.defaults = curves.defaults;
        found.users = curves.user;
        found.live = curves.live;
        found.lib = r.lib;
        vfReady.set(deviceId, found);
        vfStatus.set(deviceId, 'ready');
        return found;
      }
      vfStatus.set(deviceId, readFailure ? 'io-failed' : 'unsupported');
    } catch {
      vfStatus.set(deviceId, 'io-failed');
    }
    return null;
  };

  const ensureWaiver = (deviceId = 0) => {
    if (waiverReady.has(deviceId)) return { ok: true };
    const r = ensure();
    const dev = deviceHandles.get(deviceId);
    if (!r || !dev || typeof r.lib.zesDeviceSetOverclockWaiver !== 'function') {
      return { ok: false, errorCode: 'unsupported', message: 'Sysman overclock waiver is unavailable' };
    }
    const result = r.lib.zesDeviceSetOverclockWaiver(dev);
    if (zeOk(result) || (result >>> 0) === 0x78000033) {
      waiverReady.add(deviceId);
      return { ok: true };
    }
    return { ok: false, errorCode: resultText(result).split(' ')[0], message: resultText(result) };
  };


  return {
    /** M17f (step-4 N2): the deviceId is ACCEPTED for the mock-scoped
     *  contract and IGNORED - the real layer resolves the one enumerated
     *  card power domain (device-agnostic).
     *  @param {number} [deviceId]
     *  @returns {{ sustainedW: number, burstW: number, peakW: number } | null} */
    readLimits(deviceId) {
      const r = ensure();
      if (!r) { noteDegrade(); return null; }
      try {
        const sb = koffi.alloc('zes_power_sustained_limit_t', 1);
        const bb = koffi.alloc('zes_power_burst_limit_t', 1);
        const pb = koffi.alloc('zes_power_peak_limit_t', 1);
        const res = r.lib.zesPowerGetLimits(r.pwrHandle, sb, bb, pb);
        if (!zeOk(res)) { noteDegrade(); return null; }
        const sustained = koffi.decode(sb, 'zes_power_sustained_limit_t');
        const burst = koffi.decode(bb, 'zes_power_burst_limit_t');
        const peak = koffi.decode(pb, 'zes_power_peak_limit_t');
        return { sustainedW: W(sustained.power), burstW: W(burst.power), peakW: W(peak.powerAC) };
      } catch (err) {
        noteDegrade();
        return null;
      }
    },

    /**
     * Write the sustained + burst pair (mW in the structs - the legacy
     * zes_power_set_limits_t contract). Preserves the current sustained
     * interval. A failure returns { ok: false, errorCode, message } - the
     * errorCode is the MAPPED ze_result name (e.g. 'ERROR_NOT_AVAILABLE' -
     * the arbitration-vs-enforcement taxonomy keys on it).
     * @param {{ sustainedW: number, burstW: number }} limits
     * @returns {{ ok: boolean, errorCode?: string, message?: string }}
     */
    setLimits({ sustainedW, burstW }) {
      if (!Number.isFinite(sustainedW) || !Number.isFinite(burstW)) {
        return { ok: false, errorCode: 'invalid-argument', message: 'sustainedW and burstW must be finite numbers' };
      }
      const r = ensure();
      if (!r) { noteDegrade(); return { ok: false, errorCode: 'unavailable', message: 'the sysman layer is unavailable (ze_loader.dll or the card power domain absent)' }; }
      try {
        // Preserve the current interval (the sustained struct's interval
        // field - ms) from a live read when one is available.
        let interval = 2000;
        const sb = koffi.alloc('zes_power_sustained_limit_t', 1);
        const bb = koffi.alloc('zes_power_burst_limit_t', 1);
        const pb = koffi.alloc('zes_power_peak_limit_t', 1);
        const cur = r.lib.zesPowerGetLimits(r.pwrHandle, sb, bb, pb);
        if (zeOk(cur)) {
          const sustained = koffi.decode(sb, 'zes_power_sustained_limit_t');
          if (Number.isFinite(sustained.interval)) interval = sustained.interval;
        }
        koffi.encode(sb, 'zes_power_sustained_limit_t', { enabled: 1, power: Math.round(sustainedW * 1000), interval });
        koffi.encode(bb, 'zes_power_burst_limit_t', { enabled: 1, power: Math.round(burstW * 1000) });
        const res = r.lib.zesPowerSetLimits(r.pwrHandle, sb, bb, null);
        if (!zeOk(res)) {
          return { ok: false, errorCode: resultText(res).split(' ')[0], message: resultText(res) };
        }
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        noteDegrade();
        return { ok: false, errorCode: 'io-failed', message: msg };
      }
    },

    /**
     * Read the legacy target first. A target is authoritative only when
     * finite and strictly positive; otherwise use a verified VF LIVE curve.
     */
    readVoltageOffsetResult(deviceId = 0) {
      ensure();
      const fr = freqReady.get(deviceId) ?? null;
      const lib = fr?.lib ?? ensure()?.lib ?? null;
      let legacy = null;
      let legacyReadFailed = false;
      let legacyInvalid = false;

      // Preserve the legacy target as the primary read whenever its target is
      // finite and positive. VF is queried afterward only to detect a
      // USER/LIVE curve that still needs clearing.
      if (fr && typeof lib?.zesFrequencyOcGetVoltageTarget === 'function') {
        try {
          const targetBuf = koffi.alloc('double', 1);
          const offsetBuf = koffi.alloc('double', 1);
          const result = lib.zesFrequencyOcGetVoltageTarget(fr.freqHandle, targetBuf, offsetBuf);
          const target = koffi.decode(targetBuf, 'double');
          const offset = koffi.decode(offsetBuf, 'double');
          const rawScale = target > 10 ? 1000 : 1;
          if (zeOk(result) && Number.isFinite(target) && target > 0 && Number.isFinite(offset)) {
            legacy = { targetV: target / rawScale, offsetV: offset / rawScale };
          } else if (!zeOk(result)) {
            const text = resultText(result);
            if (!text.includes('UNSUPPORTED') && !text.includes('NOT_SUPPORTED')) legacyReadFailed = true;
          } else if (!Number.isFinite(target) || !Number.isFinite(offset)) {
            legacyInvalid = true;
          }
        } catch {
          legacyReadFailed = true;
      }
      }
      if (legacyReadFailed) {
        return { ok: false, errorCode: 'io-failed', message: 'frequency voltage target read failed' };
      }
      if (legacyInvalid) {
        return { ok: false, errorCode: 'unsupported', message: 'frequency voltage target returned invalid values' };
      }

      const vf = ensureVf(deviceId);
      if (vf) {
        try {
          const curves = readVfCurves(lib ?? vf.lib, vf);
          if (!curves) {
            return { ok: false, errorCode: 'io-failed', message: 'VF USER/DEFAULT/LIVE voltage read failed' };
          }
          const base = curves.defaults.reduce((sum, value) => sum + value, 0);
          const user = curves.user.reduce((sum, value) => sum + value, 0);
          const live = curves.live.reduce((sum, value) => sum + value, 0);
          const needsClear = curves.user.some((value, index) => value !== curves.defaults[index])
            || curves.live.some((value, index) => value !== curves.defaults[index]);
          return {
            ok: true,
            targetV: legacy?.targetV ?? live / Math.max(1, vf.pointCount) / 1000,
            offsetV: legacy?.offsetV ?? (live - base) / vf.pointCount / 1000,
            userOffsetV: (user - base) / vf.pointCount / 1000,
            needsClear,
          };
        } catch (err) {
          return { ok: false, errorCode: 'io-failed', message: err instanceof Error ? err.message : String(err) };
        }
      }
      if (freqStatus.get(deviceId) === 'io-failed') {
        return { ok: false, errorCode: 'io-failed', message: 'frequency voltage target read failed' };
      }
      if (vfStatus.get(deviceId) === 'io-failed') {
        return { ok: false, errorCode: 'io-failed', message: 'VF USER/DEFAULT/LIVE voltage read failed' };
      }
      if (legacy) return { ok: true, ...legacy };
      return { ok: false, errorCode: 'unsupported', message: 'no verified voltage capability' };
    },

    readVoltageOffset(deviceId = 0) {
      const result = this.readVoltageOffsetResult(deviceId);
      return result.ok === true ? { targetV: result.targetV, offsetV: result.offsetV } : null;
    },

    /**
     * Apply an exact legacy target/offset when the legacy getter is valid;
     * otherwise apply DEFAULT-baseline unsigned-mV VF points idempotently.
     */
    setVoltageOffset({ offsetV }, deviceId = 0) {
      if (!Number.isFinite(offsetV)) return { ok: false, errorCode: 'invalid-argument', message: 'offsetV must be finite' };
      ensure();
      const clamped = Math.max(SAFE_VOLT_OFFSET_MIN_V, Math.min(SAFE_VOLT_OFFSET_MAX_V, offsetV));
      if (clamped !== offsetV) return { ok: false, errorCode: 'out-of-range', message: `offsetV ${offsetV} V is outside the safe range` };
      const fr = freqReady.get(deviceId) ?? null;
      const lib = fr?.lib ?? ensure()?.lib ?? null;
      let vf = null;
      let forceVfClear = false;
      if (clamped === 0) {
        vf = ensureVf(deviceId);
        if (vf) {
          const current = readVfCurves(lib ?? vf.lib, vf);
          if (!current) return { ok: false, errorCode: 'io-failed', message: 'VF USER/DEFAULT/LIVE voltage read failed' };
          forceVfClear = current.user.some((value, index) => value !== current.defaults[index])
            || current.live.some((value, index) => value !== current.defaults[index]);
        } else if (vfStatus.get(deviceId) === 'io-failed') {
          return { ok: false, errorCode: 'io-failed', message: 'VF USER/DEFAULT/LIVE voltage read failed' };
        }
      }
      try {
        if (!forceVfClear && fr && typeof lib?.zesFrequencyOcGetVoltageTarget === 'function'
          && typeof lib.zesFrequencyOcSetVoltageTarget === 'function') {
          const tb = koffi.alloc('double', 1);
          const ob = koffi.alloc('double', 1);
          const readResult = lib.zesFrequencyOcGetVoltageTarget(fr.freqHandle, tb, ob);
          const target = koffi.decode(tb, 'double');
          const currentOffset = koffi.decode(ob, 'double');
          if (!zeOk(readResult)) {
            const text = resultText(readResult);
            if (!text.includes('UNSUPPORTED') && !text.includes('NOT_SUPPORTED')) {
              return { ok: false, errorCode: 'io-failed', message: 'frequency voltage target read failed' };
            }
          } else if (!Number.isFinite(target) || !Number.isFinite(currentOffset)) {
            return { ok: false, errorCode: 'unsupported', message: 'frequency voltage target returned invalid values' };
          }
          const rawScale = target > 10 ? 1000 : 1;
          if (zeOk(readResult) && Number.isFinite(target) && target > 0 && Number.isFinite(currentOffset)) {
            if (typeof lib.zesDeviceSetOverclockWaiver !== 'function') {
              return { ok: false, errorCode: 'unsupported', message: 'Sysman overclock waiver is unavailable' };
            }
            const waiver = ensureWaiver(deviceId);
            if (!waiver.ok) return waiver;
            const nativeOffset = rawScale === 1000 ? Math.round(clamped * rawScale) : clamped;
            const writeResult = lib.zesFrequencyOcSetVoltageTarget(fr.freqHandle, target, nativeOffset);
            if (!zeOk(writeResult)) return { ok: false, errorCode: resultText(writeResult).split(' ')[0], message: resultText(writeResult) };
            let verifyTarget = Number.NaN;
            let verifyOffset = Number.NaN;
            let verifyResult = 0xffffffff;
            try {
              const vb = koffi.alloc('double', 1);
              const vo = koffi.alloc('double', 1);
              verifyResult = lib.zesFrequencyOcGetVoltageTarget(fr.freqHandle, vb, vo);
              verifyTarget = koffi.decode(vb, 'double');
              verifyOffset = koffi.decode(vo, 'double');
            } catch {
              verifyResult = 0xffffffff;
            }
            if (!zeOk(verifyResult) || !Number.isFinite(verifyTarget) || !Number.isFinite(verifyOffset)
              || verifyTarget !== target || verifyOffset !== nativeOffset) {
              let restored = false;
              try {
                const restoreResult = lib.zesFrequencyOcSetVoltageTarget(fr.freqHandle, target, currentOffset);
                if (zeOk(restoreResult)) {
                  const rbTarget = koffi.alloc('double', 1);
                  const rbOffset = koffi.alloc('double', 1);
                  const rbResult = lib.zesFrequencyOcGetVoltageTarget(fr.freqHandle, rbTarget, rbOffset);
                  restored = zeOk(rbResult)
                    && koffi.decode(rbTarget, 'double') === target
                    && koffi.decode(rbOffset, 'double') === currentOffset;
                }
              } catch {
                restored = false;
              }
              return {
                ok: false,
                errorCode: restored ? 'io-failed' : 'restoration-failed',
                message: `legacy voltage target read-back mismatch${restored ? '' : '; legacy voltage restoration verification failed'}`,
              };
            }
            return { ok: true, offsetV: rawScale === 1000 ? Math.round((verifyOffset / rawScale) * 1000) / 1000 : verifyOffset };
          }
        }
      } catch (err) {
        return { ok: false, errorCode: 'io-failed', message: err instanceof Error ? err.message : String(err) };
      }

      if (!vf) vf = ensureVf(deviceId);
      if (!vf) {
        const errorCode = (freqStatus.get(deviceId) === 'io-failed' || vfStatus.get(deviceId) === 'io-failed')
          ? 'io-failed' : 'unsupported';
        return {
          ok: false,
          errorCode,
          message: errorCode === 'io-failed'
            ? 'frequency or VF voltage read failed'
            : 'legacy voltage target is unavailable and the device has no verified VF voltage capability',
        };
      }
      if (typeof vf.lib.zesOverclockSetVFPointValues !== 'function'
        || typeof vf.lib.zesDeviceSetOverclockWaiver !== 'function') {
        return {
          ok: false,
          errorCode: 'unsupported',
          message: 'the device has VF read capability but no verified VF write capability',
        };
      }
      const waiver = ensureWaiver(deviceId);
      if (!waiver.ok) return waiver;
      const requestedMagnitude = Math.max(0, -clamped);
      const written = new Set();
      const beforeCurves = [];
      const desired = [];
      try {
        const initial = readVfCurves(lib ?? vf.lib, vf);
        if (!initial) throw new Error('VF USER/DEFAULT/LIVE voltage read failed');
        beforeCurves.push(initial);
        for (let i = 0; i < vf.pointCount; i++) {
          const current = initial.user[i];
          if (!isUnsignedVoltageMv(current)) throw new Error('VF USER voltage is not unsigned millivolts');
          desired.push(clamped >= 0
            ? vf.defaults[i]
            : transformDefaultVoltageMv(vf.defaults[i], requestedMagnitude, vf));
        }
        for (let i = 0; i < desired.length; i++) {
          if (desired[i] === null || !isUnsignedVoltageMv(desired[i])) {
            throw new Error('VF voltage transform is outside unsigned-mV bounds');
          }
          if (desired[i] === initial.user[i] && desired[i] === initial.live[i]) continue;
          written.add(i);
          const writeResult = lib.zesOverclockSetVFPointValues(vf.domain, ZES_VF_TYPE.VOLT, i, desired[i]);
          if (!zeOk(writeResult)) throw new Error(resultText(writeResult));
        }

        // Verify every array after the complete write. USER and LIVE must
        // both be the exact DEFAULT-baseline transform; an averaged LIVE
        // offset is not sufficient because one stale point can remain active.
        const after = readVfCurves(lib ?? vf.lib, vf);
        if (!after) throw new Error('VF USER/DEFAULT/LIVE voltage read-back failed');
        for (let i = 0; i < vf.pointCount; i++) {
          if (after.defaults[i] !== vf.defaults[i]
            || after.user[i] !== desired[i]
            || after.live[i] !== desired[i]) {
            throw new Error(`VF voltage read-back mismatch at point ${i}`);
          }
        }
        const liveDeltaMv = after.live.reduce((sum, value, i) => sum + value - after.defaults[i], 0);
        return {
          ok: true,
          offsetV: liveDeltaMv / vf.pointCount / 1000,
        };
      } catch (err) {
        const initial = beforeCurves[0] ?? null;
        let restored = true;
        if (initial) {
          for (const i of written) {
            if (initial.user[i] === undefined) {
              restored = false;
              continue;
            }
            try {
              const rr = lib.zesOverclockSetVFPointValues(vf.domain, ZES_VF_TYPE.VOLT, i, initial.user[i]);
              if (!zeOk(rr)) restored = false;
            } catch {
              restored = false;
            }
          }
          try {
            const restoredCurves = readVfCurves(lib ?? vf.lib, vf);
            if (!restoredCurves
              || restoredCurves.user.some((value, i) => value !== initial.user[i])
              || restoredCurves.defaults.some((value, i) => value !== initial.defaults[i])
              || restoredCurves.live.some((value, i) => value !== initial.live[i])) {
              restored = false;
            }
          } catch {
            restored = false;
          }
        }
        return {
          ok: false,
          errorCode: restored ? 'io-failed' : 'restoration-failed',
          message: `${err instanceof Error ? err.message : String(err)}${restored ? '' : '; VF restoration verification failed'}`,
        };
      }
    },

    setOverclockWaiver(deviceId = 0) {
      return ensureWaiver(deviceId);
    },
  };
}

/**
 * The MOCK seam (mock/ui-verify + tests): never touches ze_loader.dll.
 * readLimits() answers the FIXTURE values - the mock backend's CURRENT
 * powerLimitW for both the sustained and the burst domain (the a770
 * fixture's stock default 210 W at boot; the applied value after an apply -
 * the per-apply read-out freshness, deterministic for the ui-verify pins);
 * peakW is the documented A770 peak 800 W. PERCENT-UNIT devices
 * (Battlemage) answer null - the honest '-': the real sysman layer reads
 * WATTS regardless of the IGCL units, and the mock's percent fixture value
 * must never masquerade as W. setLimits() RECORDS the call (the
 * companion-sync-path assertion surface) and answers ok. M21: setLimits
 * ALSO WRITES the canonical per-device state
 * (`backend._entry(deviceId).state.powerLimitW`) - for the >315 W
 * sysman-PRIMARY case the mock sysman IS the state setter (the state was
 * previously always set by the IGCL write the companion runs after; a
 * >315 W apply skips the V1 write, so the sysman write must land the state
 * itself). The write goes through the CANONICAL per-device accessor (the
 * flat `_state` for device 0 / `_extraDevices` for devices > 0) - NEVER
 * backend.applySettings (refuses >252) and NEVER extendedApply (clamps to
 * the V1 write range 315). GUARD: no-ops when the injected backend lacks
 * the `_entry` seam (power-limits.test.js injects a bare
 * getCurrentSettings-only backend) - the recording + the ok answer stay
 * unconditional.
 * @param {{ getCurrentSettings: (deviceId: number) => Promise<{ powerLimitW?: number | null }>, getCapabilities?: (deviceId: number) => Promise<{ ranges?: Record<string, { units?: string }> }>, _entry?: (deviceId: number) => { state: Record<string, unknown> } }} backend
 */
export function createMockSysmanPowerLimits({ backend }) {
  const calls = [];
  return {
    /** the recorded setLimits calls ({ sustainedW, burstW } each) */
    get calls() { return calls; },
    /** M17f (step-4 N2): DEVICE-SCOPED - the read keys on the deviceId
     *  (the multi-device read-out mismatch fix: the mock hardcoded device
     *  0, so the iGPU's honest no-PL '-' was masked by the a770's fixture
     *  mirror). The domain is per-device. */
    async readLimits(deviceId = 0) {
      let pl = null;
      try {
        const s = await backend.getCurrentSettings(deviceId);
        pl = typeof s?.powerLimitW === 'number' && Number.isFinite(s.powerLimitW) ? s.powerLimitW : null;
      } catch {
        pl = null;
      }
      if (pl === null) return null;
      try {
        const caps = await backend.getCapabilities?.(deviceId);
        const units = caps?.ranges?.powerLimitW?.units;
        if (units !== undefined && units !== 'W') return null;
      } catch {
        // degraded caps read - keep the fixture mirror
      }
      return { sustainedW: pl, burstW: pl, peakW: 800 };
    },
    /** M21: the deviceId rides as the SECOND argument (the routed companion
     *  passes its own deviceId through; the real adapter + the proxy take
     *  the limits object only and ignore the extra argument). */
    async setLimits({ sustainedW, burstW }, deviceId = 0) {
      calls.push({ sustainedW, burstW });
      // M21: the sysman-PRIMARY state write (see the doc above) - the
      // CANONICAL per-device accessor; silent about its verdict (the mock
      // sysman's ok answer is unconditional - the read-back verification is
      // what the routed block checks).
      try {
        const entry = backend._entry?.(deviceId);
        if (entry && entry.state) entry.state.powerLimitW = sustainedW;
      } catch {
        // no _entry seam (or an unknown device id) - the recording + the ok
        // answer stay unconditional
      }
      return { ok: true };
    },

    // M26: mock parity methods for voltage offset. Deterministic state
    // mutation - never touches ze_loader.dll.

    /**
     * Read the current voltage offset from the mock device state.
     * @param {number} [deviceId]
     * @returns {{ targetV: number, offsetV: number } | null}
     */
    readVoltageOffset(deviceId = 0) {
      const s = backend._entry?.(deviceId)?.state;
      if (!s || !Number.isFinite(s.gpuVoltOffsetV)) return null;
      const target = typeof s._sysmanVoltageTarget === 'number' ? s._sysmanVoltageTarget : 1.028;
      return Number.isFinite(target) && target > 0 ? { targetV: target, offsetV: s.gpuVoltOffsetV } : null;
    },

    /**
     * Set the voltage offset in the mock device state. Validates the safe
     * range, converts to mV, writes the canonical value, and returns a
     * read-back-verified result.
     * @param {{ offsetV: number }} params
     * @param {number} [deviceId]
     * @returns {{ ok: boolean, offsetV?: number, errorCode?: string, message?: string }}
     */
    setVoltageOffset({ offsetV }, deviceId = 0) {
      if (!Number.isFinite(offsetV)) {
        return { ok: false, errorCode: 'invalid-argument', message: 'offsetV must be a finite number' };
      }
      const entry = backend._entry?.(deviceId);
      if (!entry) return { ok: false, errorCode: 'unavailable', message: 'no device entry' };
      if (entry.caps?.ranges?.gpuVoltOffsetV?.units !== 'V') {
        return { ok: false, errorCode: 'unsupported', message: 'the device has no V-unit GPU voltage offset control' };
      }
      const clamped = Math.max(SAFE_VOLT_OFFSET_MIN_V, Math.min(SAFE_VOLT_OFFSET_MAX_V, offsetV));
      if (clamped !== offsetV) {
        return { ok: false, errorCode: 'out-of-range', message: `offsetV ${offsetV} V is outside the safe range [${SAFE_VOLT_OFFSET_MIN_V}, ${SAFE_VOLT_OFFSET_MAX_V}] V` };
      }
      // Deterministic state mutation: write the canonical value and record
      // the mV conversion for the mock round trip.
      entry.state.gpuVoltOffsetV = clamped;
      entry.state._sysmanVoltageMv = Math.round(clamped * 1000);
      return { ok: true, offsetV: clamped };
    },
  };
}
