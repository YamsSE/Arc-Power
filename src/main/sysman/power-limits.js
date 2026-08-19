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
import { findZeLoaderDll, loadSysman, zeOk, describeZeResult, enumerateHandles, ZES_STRUCTURE_TYPE_FREQ_PROPERTIES, ZES_DOMAIN_TYPE_GPU } from './sysman-bindings.js';

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
const FREQ_EXPORTS = [
  'zesDeviceEnumFrequencyDomains',
  'zesFrequencyGetProperties',
  'zesFrequencyOcGetVoltageTarget',
  'zesFrequencyOcSetVoltageTarget',
];

// M26: the user-approved Alchemist-wide voltage range (canonical volts).
// Stock UI clamps at -0.500 V; Advanced UI may reach -0.800 V. The live
// capability 0/0 offset bounds are diagnostic only. Positive max remains
// the existing per-card +0.234/+0.288 V.
export const SAFE_VOLT_OFFSET_MIN_V = -0.800;
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
  /** @type {{ lib: object, freqHandle: unknown } | null} */
  let freqReady = null;
  /** @type {string | null} */
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
      if (!zeOk(r)) throw new Error(`zeInit: ${describeZeResult(r)}`);
      const zeDriverCountBuf = koffi.alloc('uint32', 1);
      r = lib.zeDriverGet(zeDriverCountBuf, null);
      if (!zeOk(r)) throw new Error(`zeDriverGet count: ${describeZeResult(r)}`);
      const zeDriverCount = koffi.decode(zeDriverCountBuf, 'uint32');
      if (zeDriverCount === 0) throw new Error('no ze drivers');
      const zeDriversBuf = koffi.alloc('void*', zeDriverCount);
      r = lib.zeDriverGet(zeDriverCountBuf, zeDriversBuf);
      if (!zeOk(r)) throw new Error(`zeDriverGet fill: ${describeZeResult(r)}`);
      const zeDriver = koffi.decode(zeDriversBuf, 0, 'void*');
      const zeCountBuf = koffi.alloc('uint32', 1);
      r = lib.zeDeviceGet(zeDriver, zeCountBuf, null);
      if (!zeOk(r)) throw new Error(`zeDeviceGet count: ${describeZeResult(r)}`);
      const zeDevCount = koffi.decode(zeCountBuf, 'uint32');
      if (zeDevCount === 0) throw new Error('no ze devices');
      const zeDevBuf = koffi.alloc('void*', zeDevCount);
      r = lib.zeDeviceGet(zeDriver, zeCountBuf, zeDevBuf);
      if (!zeOk(r)) throw new Error(`zeDeviceGet fill: ${describeZeResult(r)}`);

      r = lib.zesInit(0);
      if (!zeOk(r)) throw new Error(`zesInit: ${describeZeResult(r)}`);
      const zesDriverCountBuf = koffi.alloc('uint32', 1);
      r = lib.zesDriverGet(zesDriverCountBuf, null);
      if (!zeOk(r)) throw new Error(`zesDriverGet count: ${describeZeResult(r)}`);
      const zesDriverCount = koffi.decode(zesDriverCountBuf, 'uint32');
      if (zesDriverCount === 0) throw new Error('no zes drivers');
      const zesDriversBuf = koffi.alloc('void*', zesDriverCount);
      r = lib.zesDriverGet(zesDriverCountBuf, zesDriversBuf);
      if (!zeOk(r)) throw new Error(`zesDriverGet fill: ${describeZeResult(r)}`);
      const zesDriver = koffi.decode(zesDriversBuf, 0, 'void*');
      const zesCountBuf = koffi.alloc('uint32', 1);
      r = lib.zesDeviceGet(zesDriver, zesCountBuf, null);
      if (!zeOk(r)) throw new Error(`zesDeviceGet count: ${describeZeResult(r)}`);
      const zesDevCount = koffi.decode(zesCountBuf, 'uint32');
      if (zesDevCount === 0) throw new Error('no zes devices');
      const zesDevBuf = koffi.alloc('void*', zesDevCount);
      r = lib.zesDeviceGet(zesDriver, zesCountBuf, zesDevBuf);
      if (!zeOk(r)) throw new Error(`zesDeviceGet fill: ${describeZeResult(r)}`);

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
        enumVerdict = `zesDeviceEnumPowerDomains: ${describeZeResult(en.result)}`;
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
          throw new Error(`no usable power domain: ${enumVerdict}; fallback zesDeviceGetCardPowerDomain: ${describeZeResult(r)}`);
        }
      }
      ready = { lib, pwrHandle };

      // M26: resolve the GPU frequency domain alongside the power domain.
      // Missing frequency exports/domain degrade ONLY voltage methods -
      // the existing PL consumer is never affected.
      const hasFreqExports = FREQ_EXPORTS.every((n) => typeof lib[n] === 'function');
      if (hasFreqExports) {
        try {
          const freqEn = enumerateHandles((countBuf, arr) => lib.zesDeviceEnumFrequencyDomains(zesDev, countBuf, arr));
          if (zeOk(freqEn.result) && freqEn.handles.length > 0) {
            // Find the GPU frequency domain by probing properties.
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
                const r = lib.zesFrequencyGetProperties(candidate, fpBuf);
                if (zeOk(r)) {
                  const fp = koffi.decode(fpBuf, 'zes_freq_properties_t');
                  // The live driver uses type 0 for ZES_DOMAIN_TYPE_GPU.
                  if (fp.type === ZES_DOMAIN_TYPE_GPU) {
                    freqReady = { lib, freqHandle: candidate };
                    break;
                  }
                }
              } catch {
                // skip this candidate
              }
            }
          }
        } catch {
          // frequency domain resolution is best-effort
        }
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
          return { ok: false, errorCode: describeZeResult(res).split(' ')[0], message: describeZeResult(res) };
        }
        return { ok: true };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        noteDegrade();
        return { ok: false, errorCode: 'io-failed', message: msg };
      }
    },

    /**
     * M26: read the current GPU voltage offset via the Sysman frequency OC
     * getter. Returns { offsetV } in canonical volts on success, null when
     * the frequency domain is unavailable. The getter receives two allocated
     * double* output pointers (target + offset) per the safety invariant.
     * The driver returns integer-mV values despite the public header's volts
     * wording; the consumer converts to canonical volts (/ 1000).
     * @param {number} [_deviceId] accepted for device-scoped consumer parity;
     *   the real adapter resolves one enumerated card domain and ignores it.
     * @returns {{ targetV: number, offsetV: number } | null}
     */
    readVoltageOffset(_deviceId = 0) {
      // Voltage operations are direct consumers too: initialize the loader
      // and resolve the frequency domain before inspecting freqReady.
      ensure();
      const fr = freqReady;
      if (!fr) return null;
      try {
        const targetBuf = koffi.alloc('double', 1);
        const offsetBuf = koffi.alloc('double', 1);
        const res = fr.lib.zesFrequencyOcGetVoltageTarget(fr.freqHandle, targetBuf, offsetBuf);
        if (!zeOk(res)) return null;
        const targetRaw = koffi.decode(targetBuf, 'double');
        const offsetRaw = koffi.decode(offsetBuf, 'double');
        if (!Number.isFinite(targetRaw) || !Number.isFinite(offsetRaw) || targetRaw <= 0) return null;
        // The live A770 driver boundary: raw values are integer mV.
        // Convert to canonical volts for the public interface.
        return { targetV: targetRaw / 1000, offsetV: offsetRaw / 1000 };
      } catch {
        return null;
      }
    },

    /**
     * M26: set the GPU voltage offset via the Sysman frequency OC setter.
     * Reads the current target first, converts canonical volts to the
     * driver's mV boundary with `Math.round(offsetV * 1000)` and rounded
     * raw target, supplies both as finite inputs, writes, and verifies via
     * the same getter.
     *
     * The adapter enforces the approved Advanced range: [-0.800, +0.234] V.
     * The stock apply route clamps to -0.500 V before it reaches this method;
     * live diagnostic probes have a separate -0.300 V hard stop.
     *
     * Every successful write is read-back verified; a mismatch is a failed
     * per-control result.
     *
     * @param {{ offsetV: number }} params
     * @param {number} [_deviceId] accepted for device-scoped consumer parity;
     *   the real adapter resolves one enumerated card domain and ignores it.
     * @returns {{ ok: boolean, offsetV?: number, errorCode?: string, message?: string }}
     */
    setVoltageOffset({ offsetV }, _deviceId = 0) {
      if (!Number.isFinite(offsetV)) {
        return { ok: false, errorCode: 'invalid-argument', message: 'offsetV must be a finite number' };
      }
      // A direct first voltage operation must initialize Sysman, just like
      // the power-limit operations do.
      ensure();
      const fr = freqReady;
      // Safety: direct adapter calls reject values outside the approved
      // Advanced range. The stock routed path clamps to -0.500 V before it
      // reaches this method; diagnostic probes have their own -0.300 V cap.
      const clamped = Math.max(SAFE_VOLT_OFFSET_MIN_V, Math.min(SAFE_VOLT_OFFSET_MAX_V, offsetV));
      if (clamped !== offsetV) {
        return { ok: false, errorCode: 'out-of-range', message: `offsetV ${offsetV} V is outside the safe range [${SAFE_VOLT_OFFSET_MIN_V}, ${SAFE_VOLT_OFFSET_MAX_V}] V` };
      }
      try {
        // Read the current target first (the setter receives both target
        // and offset as finite inputs per the safety invariant).
        const targetBuf = koffi.alloc('double', 1);
        const offsetBuf = koffi.alloc('double', 1);
        const readRes = fr.lib.zesFrequencyOcGetVoltageTarget(fr.freqHandle, targetBuf, offsetBuf);
        if (!zeOk(readRes)) {
          return { ok: false, errorCode: describeZeResult(readRes).split(' ')[0], message: `failed to read current voltage target: ${describeZeResult(readRes)}` };
        }
        const rawTarget = koffi.decode(targetBuf, 'double');
        const rawGetterOffset = koffi.decode(offsetBuf, 'double');
        if (!Number.isFinite(rawTarget) || rawTarget <= 0) {
          return { ok: false, errorCode: 'invalid-argument', message: 'current voltage target must be finite and strictly positive' };
        }
        if (!Number.isFinite(rawGetterOffset)) {
          return { ok: false, errorCode: 'invalid-argument', message: 'current voltage offset must be finite' };
        }
        // Preserve the native integer-mV target boundary. Rounding must not
        // turn a tiny positive getter value into the old unsafe zero target.
        const finiteTarget = Math.round(rawTarget);
        if (!Number.isFinite(finiteTarget) || finiteTarget <= 0) {
          return { ok: false, errorCode: 'invalid-argument', message: 'current voltage target rounds to a non-positive native value' };
        }
        // Convert canonical offset to driver mV boundary.
        const rawOffsetMv = Math.round(clamped * 1000);
        const writeRes = fr.lib.zesFrequencyOcSetVoltageTarget(fr.freqHandle, finiteTarget, rawOffsetMv);
        if (!zeOk(writeRes)) {
          return { ok: false, errorCode: describeZeResult(writeRes).split(' ')[0], message: describeZeResult(writeRes) };
        }
        const verifyTargetBuf = koffi.alloc('double', 1);
        const verifyOffsetBuf = koffi.alloc('double', 1);
        const verifyRes = fr.lib.zesFrequencyOcGetVoltageTarget(fr.freqHandle, verifyTargetBuf, verifyOffsetBuf);
        if (!zeOk(verifyRes)) {
          return { ok: false, errorCode: 'io-failed', message: `write succeeded but read-back failed: ${describeZeResult(verifyRes)}` };
        }
        const readBackTarget = koffi.decode(verifyTargetBuf, 'double');
        const readBackOffset = koffi.decode(verifyOffsetBuf, 'double');
        if (!Number.isFinite(readBackTarget) || readBackTarget <= 0 || !Number.isFinite(readBackOffset)) {
          return { ok: false, errorCode: 'io-failed', message: 'write succeeded but read-back voltage values were not finite' };
        }
        const readBackV = readBackOffset / 1000;
        if (!Number.isFinite(readBackV) || Math.abs(readBackV - clamped) > 0.001) {
          return { ok: false, errorCode: 'io-failed', message: `read-back mismatch: wrote ${clamped} V but read ${readBackV} V` };
        }
        return { ok: true, offsetV: readBackV };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        noteDegrade();
        return { ok: false, errorCode: 'io-failed', message: msg };
      }
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
