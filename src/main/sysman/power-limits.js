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
import { findZeLoaderDll, loadSysman, zeOk, describeZeResult, enumerateHandles } from './sysman-bindings.js';

// M17h: the enum binding joins the REQUIRED exports - the domain resolution
// is enum-FIRST (see ensure() below), so a loader without the enum symbol
// must degrade honestly (the missing-exports reason), never throw.
const REQUIRED_EXPORTS = [
  'zeInit', 'zeDriverGet', 'zeDeviceGet',
  'zesInit', 'zesDriverGet', 'zesDeviceGet',
  'zesDeviceEnumPowerDomains', 'zesDeviceGetCardPowerDomain',
  'zesPowerGetLimits', 'zesPowerSetLimits',
];

const W = (powerMw) => Math.round((powerMw / 1000) * 10) / 10;

// The legacy Alchemist Sysman frequency target surface is exposed by the
// current Intel loader as millivolts, although the public Level Zero header
// documents the doubles in volts. Keep the conversion in this adapter so
// every caller deals only in canonical volts. Zero is accepted as the clear
// operation; negative offsets are capped at -200 mV.
export const ALCHEMIST_NEGATIVE_VOLT_OFFSET_MIN_V = -0.200;
const VOLT_EPSILON = 0.0005;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const voltageFromNative = (value) => finite(value) && Math.abs(value) > 10 ? value / 1000 : value;
const voltageToNative = (value, scale) => scale === 1000 ? Math.round(value * 1000) : value;
const nativeVoltageScale = (caps) => [
  caps?.maxFactoryDefaultVoltage,
  caps?.maxOcVoltage,
  caps?.minOcVoltageOffset,
  caps?.maxOcVoltageOffset,
].some((value) => finite(value) && Math.abs(value) > 10) ? 1000 : 1;
const resultFailure = (res) => ({
  ok: false,
  errorCode: describeZeResult(res).split(' ')[0],
  message: describeZeResult(res),
});

/**
 * The real sysman power-limits adapter. Lazily resolves ze_loader.dll + the
 * card power domain on the FIRST call; a failure latches the honest
 * unavailable state (the once-per-session degrade note - the M17c
 * no-sensor-latch precedent: a missing loader/domain must not re-run the
 * whole init chain on every telemetry/apply tick).
 *
 * Contract (the plan's interface, pinned):
 *   readLimits(deviceId, physicalTarget) -> { sustainedW, burstW, peakW } | null
 *   setLimits({ sustainedW, burstW }, deviceId, physicalTarget) -> { ok, errorCode?, message? }
 *
 * The real adapter keeps one power-domain context per Sysman device. The
 * physical BDF proof from the parent inventory selects that context; a
 * multi-GPU request without a matching proof is refused instead of falling
 * back to the first enumerated card. This is required because the helper's
 * Sysman enumeration order is not the app's GPU order.
 *
 * @param {{
 *   findLoader?: () => string | null,
 *   load?: (dllPath: string) => object,
 *   ensureVoltageWaiver?: (args: { physicalTarget: object|null, accepted: boolean }) => { ok: boolean, errorCode?: string, message?: string } | null,
 *   log?: (s: string) => void,
 * }} [opts]
 */
export function createSysmanPowerLimits({ findLoader = findZeLoaderDll, load = loadSysman, ensureVoltageWaiver = null, log = (s) => console.log(`[sysman] ${s}`) } = {}) {
  /** @type {{ lib: object, devices: Array<{ zesHandle: unknown, pwrHandle: unknown|null, freqHandle: unknown|null, freqProperties: object|null, bdf: string|null }> } | null} */
  let ready = null;
  /** @type {string | null} */
  let degradeReason = null;
  let degradeNoted = false;

  const normalizeBdf = (value) => {
    if (typeof value === 'string') {
      const match = value.trim().match(/^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i);
      if (!match) return null;
      return `${Number.parseInt(match[1] ?? '0', 16).toString(16).padStart(4, '0')}:${Number.parseInt(match[2], 16).toString(16).padStart(2, '0')}:${Number.parseInt(match[3], 16).toString(16).padStart(2, '0')}.${match[4]}`;
    }
    if (!value || typeof value !== 'object') return null;
    const bdf = value;
    const domain = Number(bdf.domain ?? bdf.segment ?? 0);
    const bus = Number(bdf.bus);
    const device = Number(bdf.device);
    const fn = Number(bdf.function ?? bdf.func ?? 0);
    if (![domain, bus, device, fn].every(Number.isInteger)
      || domain < 0 || bus < 0 || device < 0 || fn < 0) return null;
    return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
  };

  const targetBdf = (physicalTarget) => normalizeBdf(physicalTarget?.bdf ?? physicalTarget?.controllerBdf);

  const resolveDevice = (devices, deviceId = 0, physicalTarget = null, forProbe = false) => {
    const wantedBdf = targetBdf(physicalTarget);
    if (wantedBdf) {
      const matches = devices.filter((device) => device.bdf === wantedBdf);
      return matches.length === 1 ? matches[0] : null;
    }
    if (devices.length === 1) return devices[0];
    // The helper's init probe is read-only and needs one usable context to
    // establish readiness. Actual reads/writes always carry the parent
    // physical proof after the IPC routing fix, so no production operation
    // can use this ordinal fallback.
    if (forProbe && devices.length > 0) return devices[0];
    return null;
  };

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
      // The ze/zes init chain (the M2b probe pattern). The ze list is kept
      // for loader/device readiness, while the Sysman list below is routed
      // by each adapter's own PCI/BDF properties rather than by ordinal.
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

      // M163: resolve a power-domain context for EVERY Sysman device. The
      // PCI API is optional on older loaders, but when present it gives the
      // exact BDF needed to route A770/B580 (and arbitrary future MGPU
      // combinations) without trusting enumeration order.
      const devices = [];
      for (let i = 0; i < zesDevCount; i++) {
        const zesDev = koffi.decode(zesDevBuf, i * 8, 'void*');
        let bdf = null;
        if (typeof lib.zesDevicePciGetProperties === 'function') {
          try {
            const pciBuf = koffi.alloc('zes_pci_properties_t', 1);
            koffi.encode(pciBuf, 'zes_pci_properties_t', { stype: 2, pNext: null });
            const pciRes = lib.zesDevicePciGetProperties(zesDev, pciBuf);
            if (zeOk(pciRes)) {
              const props = koffi.decode(pciBuf, 'zes_pci_properties_t');
              bdf = normalizeBdf(props.address);
            }
          } catch {
            bdf = null;
          }
        }

        // Legacy frequency target APIs are optional. When present, keep the
        // GPU frequency domain alongside the power domain so the voltage
        // write can preserve the active core-clock target. Frequency domain
        // type 0 is the GPU render/compute domain used by Alchemist.
        let freqHandle = null;
        let freqProperties = null;
        if (typeof lib.zesDeviceEnumFrequencyDomains === 'function'
          && typeof lib.zesFrequencyGetProperties === 'function') {
          try {
            const freq = enumerateHandles((countBuf, arr) => lib.zesDeviceEnumFrequencyDomains(zesDev, countBuf, arr));
            if (zeOk(freq.result)) {
              for (const candidate of freq.handles) {
                const propsBuf = koffi.alloc('zes_frequency_properties_t', 1);
                koffi.encode(propsBuf, 'zes_frequency_properties_t', { stype: 9, pNext: null });
                const propsResult = lib.zesFrequencyGetProperties(candidate, propsBuf);
                if (!zeOk(propsResult)) continue;
                const props = koffi.decode(propsBuf, 'zes_frequency_properties_t');
                if (Number(props.type) === 0) {
                  freqHandle = candidate;
                  freqProperties = props;
                  break;
                }
              }
            }
          } catch (err) {
            log(`Sysman GPU ${i + 1} frequency-domain discovery failed (${err.message})`);
          }
        }

        // Prefer the enumerated power domains, with the card-domain getter
        // as the compatibility fallback used by older Intel drivers.
        const en = enumerateHandles((countBuf, arr) => lib.zesDeviceEnumPowerDomains(zesDev, countBuf, arr));
        let pwrHandle = null;
        let enumVerdict = null;
        if (!zeOk(en.result)) {
          enumVerdict = `zesDeviceEnumPowerDomains: ${describeZeResult(en.result)}`;
        } else if (en.handles.length === 0) {
          enumVerdict = 'zesDeviceEnumPowerDomains yielded no domains (count 0)';
        } else {
          for (const candidate of en.handles) {
            const sb = koffi.alloc('zes_power_sustained_limit_t', 1);
            const bb = koffi.alloc('zes_power_burst_limit_t', 1);
            const pb = koffi.alloc('zes_power_peak_limit_t', 1);
            if (zeOk(lib.zesPowerGetLimits(candidate, sb, bb, pb))) { pwrHandle = candidate; break; }
          }
          if (pwrHandle === null) enumVerdict = 'the enumerated power domains failed the one-shot zesPowerGetLimits probe';
        }
        if (pwrHandle === null) {
          const pwrBuf = koffi.alloc('void*', 1);
          r = lib.zesDeviceGetCardPowerDomain(zesDev, pwrBuf);
          if (zeOk(r)) {
            pwrHandle = koffi.decode(pwrBuf, 0, 'void*');
          } else {
            // One adapter without a power domain must not hide the usable
            // contexts of the other adapters.
            log(`Sysman GPU ${i + 1} has no usable power domain (${enumVerdict}; fallback ${describeZeResult(r)})`);
          }
        }
        if (pwrHandle !== null || freqHandle !== null) devices.push({ zesHandle: zesDev, pwrHandle, freqHandle, freqProperties, bdf });
      }
      if (devices.length === 0) throw new Error('no usable power or frequency domain on any Sysman device');
      ready = { lib, devices };
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

  const readFrequencyState = (r, device) => {
    if (!device?.freqHandle || typeof r.lib.zesFrequencyGetState !== 'function') return null;
    try {
      const stateBuf = koffi.alloc('zes_frequency_state_t', 1);
      koffi.encode(stateBuf, 'zes_frequency_state_t', { stype: 0x1b, pNext: null });
      const stateResult = r.lib.zesFrequencyGetState(device.freqHandle, stateBuf);
      if (!zeOk(stateResult)) return null;
      const state = koffi.decode(stateBuf, 'zes_frequency_state_t');
      for (const key of ['tdp', 'actual', 'request', 'efficient']) {
        if (finite(state[key]) && state[key] > 0) return state[key];
      }
    } catch {
      return null;
    }
    return null;
  };

  const readFrequencyTarget = (r, device) => {
    if (!device?.freqHandle) return null;
    // The driver's OcGetFrequencyTarget can report the maximum OC target
    // (4250 MHz on the live A770) even while the active workload is at the
    // factory target (2400 MHz). Prefer the live state and domain property so
    // the voltage write does not accidentally promote a stable FurMark run
    // to a stale maximum-frequency request.
    const live = readFrequencyState(r, device);
    if (finite(live) && live > 0) return live;
    const maximum = device.freqProperties?.max;
    return finite(maximum) && maximum > 0 ? maximum : null;
  };

  const readVoltage = (r, device) => {
    if (!device?.freqHandle || typeof r.lib.zesFrequencyOcGetVoltageTarget !== 'function') return null;
    const targetBuf = koffi.alloc('double', 1);
    const offsetBuf = koffi.alloc('double', 1);
    const voltageResult = r.lib.zesFrequencyOcGetVoltageTarget(device.freqHandle, targetBuf, offsetBuf);
    if (!zeOk(voltageResult)) return resultFailure(voltageResult);
    const nativeTarget = koffi.decode(targetBuf, 'double');
    const nativeOffset = koffi.decode(offsetBuf, 'double');
    // Infer the unit once from the absolute target and apply it to the
    // offset too. A magnitude-only conversion misreads native -1..-10 mV as
    // -1..-10 V, because those small millivolt values are numerically inside
    // the public-volts range. The target is the stable discriminator on the
    // active Alchemist path (for example 883 mV), while cold 0/0 remains
    // zero in either unit and is still rejected for non-zero writes below.
    const scale = finite(nativeTarget) && Math.abs(nativeTarget) > 10 ? 1000 : 1;
    const frequencyTargetMhz = readFrequencyTarget(r, device);
    return {
      ok: true,
      targetV: finite(nativeTarget) ? nativeTarget / scale : nativeTarget,
      offsetV: finite(nativeOffset) ? nativeOffset / scale : nativeOffset,
      ...(frequencyTargetMhz !== null ? { frequencyTargetMhz } : {}),
    };
  };

  const currentVoltageTarget = (r, device, current) => {
    if (current?.ok === true && finite(current.targetV) && current.targetV > 0) return current.targetV;
    // Prefer the driver's factory target over the instantaneous voltage
    // sample. Under FurMark the sample is load-dependent and must not become
    // the next target, otherwise a -100 mV write could accidentally stack an
    // additional droop on top of the requested offset.
    if (typeof r.lib.zesFrequencyOcGetCapabilities === 'function') {
      try {
        const capsBuf = koffi.alloc('zes_frequency_oc_capabilities_t', 1);
        koffi.encode(capsBuf, 'zes_frequency_oc_capabilities_t', { stype: 0x1c, pNext: null });
        const capsResult = r.lib.zesFrequencyOcGetCapabilities(device.freqHandle, capsBuf);
        if (zeOk(capsResult)) {
          const caps = koffi.decode(capsBuf, 'zes_frequency_oc_capabilities_t');
          const factory = voltageFromNative(caps.maxFactoryDefaultVoltage);
          if (finite(factory) && factory > 0) return factory;
        }
      } catch {
        // Fall through to the live state.
      }
    }
    try {
      if (device?.freqHandle && typeof r.lib.zesFrequencyGetState === 'function') {
        const stateBuf = koffi.alloc('zes_frequency_state_t', 1);
        koffi.encode(stateBuf, 'zes_frequency_state_t', { stype: 0x1b, pNext: null });
        if (zeOk(r.lib.zesFrequencyGetState(device.freqHandle, stateBuf))) {
          const state = koffi.decode(stateBuf, 'zes_frequency_state_t');
          if (finite(state.currentVoltage) && state.currentVoltage > 0) return voltageFromNative(state.currentVoltage);
        }
      }
    } catch {
      // Fall through to the factory capability.
    }
    return null;
  };

  return {
    /** M163: resolve the requested Sysman power domain by physical BDF.
     *  A multi-GPU request without a matching proof is an honest null, never
     *  an ordinal fallback to the first GPU.
     *  @param {number} [deviceId]
     *  @param {object|null} [physicalTarget]
     *  @returns {{ sustainedW: number, burstW: number, peakW: number } | null} */
    readLimits(deviceId = 0, physicalTarget = null) {
      const r = ensure();
      if (!r) { noteDegrade(); return null; }
      const device = resolveDevice(r.devices, deviceId, physicalTarget, physicalTarget?.probe === true);
      if (!device || !device.pwrHandle) {
        log('Sysman read skipped: the requested GPU has no unique PCI/BDF power-domain match');
        return null;
      }
      try {
        const sb = koffi.alloc('zes_power_sustained_limit_t', 1);
        const bb = koffi.alloc('zes_power_burst_limit_t', 1);
        const pb = koffi.alloc('zes_power_peak_limit_t', 1);
        const res = r.lib.zesPowerGetLimits(device.pwrHandle, sb, bb, pb);
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
     * @param {number} [deviceId]
     * @param {object|null} [physicalTarget]
     * @returns {{ ok: boolean, errorCode?: string, message?: string }}
     */
    setLimits({ sustainedW, burstW }, deviceId = 0, physicalTarget = null) {
      if (!Number.isFinite(sustainedW) || !Number.isFinite(burstW)) {
        return { ok: false, errorCode: 'invalid-argument', message: 'sustainedW and burstW must be finite numbers' };
      }
      const r = ensure();
      if (!r) { noteDegrade(); return { ok: false, errorCode: 'unavailable', message: 'the sysman layer is unavailable (ze_loader.dll or the card power domain absent)' }; }
      const device = resolveDevice(r.devices, deviceId, physicalTarget);
      if (!device || !device.pwrHandle) {
        return { ok: false, errorCode: 'unsupported', message: 'the requested GPU has no unique PCI/BDF Sysman power-domain match' };
      }
      try {
        // Preserve the current interval (the sustained struct's interval
        // field - ms) from a live read when one is available.
        let interval = 2000;
        const sb = koffi.alloc('zes_power_sustained_limit_t', 1);
        const bb = koffi.alloc('zes_power_burst_limit_t', 1);
        const pb = koffi.alloc('zes_power_peak_limit_t', 1);
        const cur = r.lib.zesPowerGetLimits(device.pwrHandle, sb, bb, pb);
        if (zeOk(cur)) {
          const sustained = koffi.decode(sb, 'zes_power_sustained_limit_t');
          if (Number.isFinite(sustained.interval)) interval = sustained.interval;
        }
        koffi.encode(sb, 'zes_power_sustained_limit_t', { enabled: 1, power: Math.round(sustainedW * 1000), interval });
        koffi.encode(bb, 'zes_power_burst_limit_t', { enabled: 1, power: Math.round(burstW * 1000) });
        const res = r.lib.zesPowerSetLimits(device.pwrHandle, sb, bb, null);
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

    /** Read the legacy Sysman voltage target/offset in canonical volts. */
    readVoltageOffset(deviceId = 0, physicalTarget = null) {
      const r = ensure();
      if (!r) { noteDegrade(); return null; }
      const device = resolveDevice(r.devices, deviceId, physicalTarget);
      if (!device || !device.freqHandle) {
        return { ok: false, errorCode: 'unsupported', message: 'the Sysman legacy GPU frequency voltage-target API is unavailable on this GPU' };
      }
      try {
        return readVoltage(r, device);
      } catch (err) {
        return { ok: false, errorCode: 'io-failed', message: err instanceof Error ? err.message : String(err) };
      }
    },

    /**
     * Apply a canonical negative Alchemist voltage offset through the legacy
     * Sysman frequency-domain target API. The current frequency target is
     * retained (with live-state/property fallbacks), and the proven
     * mode -> frequency -> voltage sequence is used.
     */
    setVoltageOffset({ offsetV, targetV: requestedTargetV, frequencyTargetMhz: requestedFrequencyMhz, waiverAccepted = false } = {}, deviceId = 0, physicalTarget = null) {
      if (!finite(offsetV)) return { ok: false, errorCode: 'invalid-argument', message: 'offsetV must be a finite number' };
      if (offsetV > 0) return { ok: false, errorCode: 'invalid-argument', message: 'the Sysman voltage offset path accepts only negative offsets or zero to clear' };
      const clampedOffsetV = Math.max(ALCHEMIST_NEGATIVE_VOLT_OFFSET_MIN_V, offsetV);
      // The legacy Sysman target setter is still guarded by the driver's
      // IGCL overclock-waiver state. Establish that state in the helper
      // process BEFORE zesInit: loading IGCL after Sysman has initialized is
      // the poisoned ordering measured on this driver. The bridge never
      // accepts consent; it only replays the parent-side accepted flag.
      if (typeof ensureVoltageWaiver === 'function') {
        const waiver = ensureVoltageWaiver({ physicalTarget, accepted: waiverAccepted === true });
        if (!waiver || waiver.ok !== true) return waiver ?? { ok: false, errorCode: 'unavailable', message: 'the IGCL overclock-waiver bridge returned no result' };
      } else if (waiverAccepted !== true) {
        return { ok: false, errorCode: 'waiver-not-set', message: 'the Sysman voltage write requires an accepted overclock waiver' };
      }
      const r = ensure();
      if (!r) { noteDegrade(); return { ok: false, errorCode: 'unavailable', message: 'the Sysman voltage offset setter is unavailable (ze_loader.dll or the legacy frequency domain is absent)' }; }
      const device = resolveDevice(r.devices, deviceId, physicalTarget);
      if (!device || !device.freqHandle) {
        return { ok: false, errorCode: 'unsupported', message: 'the Sysman voltage offset setter is unavailable on the requested GPU' };
      }
      const required = ['zesFrequencyOcSetMode', 'zesFrequencyOcSetFrequencyTarget', 'zesFrequencyOcSetVoltageTarget'];
      const missing = required.filter((name) => typeof r.lib[name] !== 'function');
      if (missing.length > 0) return { ok: false, errorCode: 'unsupported', message: `the Sysman voltage offset setter is missing exports: ${missing.join(', ')}` };
      try {
        const current = readVoltage(r, device);
        if (current?.ok === false) return current;
        const targetV = finite(requestedTargetV) && requestedTargetV > 0
          ? requestedTargetV
          : currentVoltageTarget(r, device, current);
        const frequencyTargetMhz = finite(requestedFrequencyMhz) && requestedFrequencyMhz > 0
          ? requestedFrequencyMhz
          : current?.frequencyTargetMhz ?? readFrequencyTarget(r, device);
        if (!finite(targetV) || targetV <= 0) return { ok: false, errorCode: 'unavailable', message: 'the Sysman voltage offset setter could not establish the current/factory voltage target' };
        if (!finite(frequencyTargetMhz) || frequencyTargetMhz <= 0) return { ok: false, errorCode: 'unavailable', message: 'the Sysman voltage offset setter could not establish the current core-frequency target' };

        let caps = null;
        if (typeof r.lib.zesFrequencyOcGetCapabilities === 'function') {
          const capsBuf = koffi.alloc('zes_frequency_oc_capabilities_t', 1);
          koffi.encode(capsBuf, 'zes_frequency_oc_capabilities_t', { stype: 0x1c, pNext: null });
          const capsResult = r.lib.zesFrequencyOcGetCapabilities(device.freqHandle, capsBuf);
          if (zeOk(capsResult)) caps = koffi.decode(capsBuf, 'zes_frequency_oc_capabilities_t');
        }
        // A caps failure is still writable on the live Alchemist driver; its
        // proven ABI uses integer mV. Use that as the conservative fallback.
        const scale = caps ? nativeVoltageScale(caps) : 1000;
        // Some loader revisions expose the Sysman waiver entry point but
        // return ERROR_UNSUPPORTED_FEATURE for this legacy target path. The
        // actual per-process waiver was established through IGCL above; this
        // optional Sysman call is therefore informational and never masks a
        // working IGCL waiver.
        if (typeof r.lib.zesDeviceSetOverclockWaiver === 'function') {
          const waiver = r.lib.zesDeviceSetOverclockWaiver(device.zesHandle);
          if (!zeOk(waiver)) log(`Sysman overclock-waiver replay returned ${describeZeResult(waiver)}; continuing with the IGCL waiver state`);
        }
        let res = r.lib.zesFrequencyOcSetMode(device.freqHandle, 2);
        if (!zeOk(res)) {
          log(`Sysman voltage write: zesFrequencyOcSetMode(2) returned ${describeZeResult(res)}`);
          return resultFailure(res);
        }
        res = r.lib.zesFrequencyOcSetFrequencyTarget(device.freqHandle, frequencyTargetMhz);
        if (!zeOk(res)) {
          log(`Sysman voltage write: zesFrequencyOcSetFrequencyTarget(${frequencyTargetMhz}) returned ${describeZeResult(res)}`);
          return resultFailure(res);
        }
        res = r.lib.zesFrequencyOcSetVoltageTarget(
          device.freqHandle,
          voltageToNative(targetV, scale),
          voltageToNative(clampedOffsetV, scale),
        );
        if (!zeOk(res)) {
          log(`Sysman voltage write: zesFrequencyOcSetVoltageTarget(${voltageToNative(targetV, scale)}, ${voltageToNative(clampedOffsetV, scale)}) returned ${describeZeResult(res)}`);
          return resultFailure(res);
        }
        const after = readVoltage(r, device);
        const offsetMatches = after?.ok === true && finite(after.offsetV)
          && Math.abs(after.offsetV - clampedOffsetV) <= VOLT_EPSILON;
        // The target is an absolute driver-selected VF target, not the
        // requested offset. On Alchemist the driver can quantize/re-resolve
        // it after the write (for example 886 -> 883 mV), so requiring an
        // exact target match rejects a write whose offset really landed.
        // A cold 0/0 getter remains a hard failure: it is the known silent
        // no-op response from this legacy API.
        const targetReadBackValid = after?.ok === true && finite(after.targetV)
          && (clampedOffsetV === 0 ? after.targetV >= 0 : after.targetV > 0);
        // The live state may report an actual/requested clock that moves by
        // a step while the GPU is ramping. The setter was still given the
        // preserved target above; only reject an explicitly reported invalid
        // (zero/non-finite) read-back, never a normal live-clock adjustment.
        const frequencyReadBackValid = after?.ok === true
          && (after.frequencyTargetMhz === undefined
            || (finite(after.frequencyTargetMhz) && after.frequencyTargetMhz > 0));
        if (!offsetMatches || !targetReadBackValid || !frequencyReadBackValid) {
          return {
            ok: false,
            errorCode: 'io-failed',
            message: 'the Sysman voltage offset write did not persist (target, offset, or frequency read-back was invalid)',
            ...(after?.targetV !== undefined ? { targetV: after.targetV } : {}),
            ...(after?.offsetV !== undefined ? { offsetV: after.offsetV } : {}),
            ...(after?.frequencyTargetMhz !== undefined ? { frequencyTargetMhz: after.frequencyTargetMhz } : {}),
          };
        }
        return { ok: true, targetV: after.targetV, offsetV: after.offsetV, ...(after.frequencyTargetMhz !== undefined ? { frequencyTargetMhz: after.frequencyTargetMhz } : {}) };
      } catch (err) {
        return { ok: false, errorCode: 'io-failed', message: err instanceof Error ? err.message : String(err) };
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
 * (Battlemage) are converted to their card's published board-power class
 * before the W-only readout is returned; the mock's percent fixture value
 * must never masquerade as the same number of watts. setLimits() RECORDS the call (the
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
  const voltageOffsets = new Map();
  const battlemagePowerReferenceW = (deviceName = '') => {
    if (/\bB570\b/i.test(deviceName)) return 150;
    if (/\bB50\b/i.test(deviceName)) return 70;
    return 190;
  };
  const battlemage = (deviceName = '') => /battlemage|\bB\d{2,4}\b/i.test(deviceName);
  const capsFor = async (deviceId) => {
    try {
      return await backend.getCapabilities?.(deviceId) ?? null;
    } catch {
      return null;
    }
  };
  const percentToWatts = (value, caps) => value * battlemagePowerReferenceW(caps?.deviceName) / 100;
  const wattsToPercent = (value, caps) => value * 100 / battlemagePowerReferenceW(caps?.deviceName);
  return {
    /** the recorded setLimits calls ({ sustainedW, burstW } each) */
    get calls() { return calls; },
    /** M163: DEVICE-SCOPED - the mock keys on deviceId and accepts the same
     *  physicalTarget argument as the real Sysman adapter. */
    async readLimits(deviceId = 0, physicalTarget = null) {
      let pl = null;
      try {
        const s = await backend.getCurrentSettings(deviceId);
        pl = typeof s?.powerLimitW === 'number' && Number.isFinite(s.powerLimitW) ? s.powerLimitW : null;
      } catch {
        pl = null;
      }
      if (pl === null) return null;
      const caps = await capsFor(deviceId);
      const units = caps?.ranges?.powerLimitW?.units;
      if (units !== undefined && units !== 'W' && units !== '%') return null;
      const watts = units === '%' && battlemage(caps?.deviceName)
        ? percentToWatts(pl, caps)
        : pl;
      return { sustainedW: watts, burstW: watts, peakW: 800 };
    },
    /** M163: the routed companion passes both the deviceId and physical
     *  target through the same contract used by the real adapter. */
    async setLimits({ sustainedW, burstW }, deviceId = 0, physicalTarget = null) {
      calls.push({ sustainedW, burstW });
      // M21: the sysman-PRIMARY state write (see the doc above) - the
      // CANONICAL per-device accessor; silent about its verdict (the mock
      // sysman's ok answer is unconditional - the read-back verification is
      // what the routed block checks).
      try {
        const entry = backend._entry?.(deviceId);
        const caps = await capsFor(deviceId);
        const units = caps?.ranges?.powerLimitW?.units;
        const rawValue = units === '%' && battlemage(caps?.deviceName)
          ? wattsToPercent(sustainedW, caps)
          : sustainedW;
        if (entry && entry.state) entry.state.powerLimitW = rawValue;
      } catch {
        // no _entry seam (or an unknown device id) - the recording + the ok
        // answer stay unconditional
      }
      return { ok: true };
    },
    async readVoltageOffset(deviceId = 0, physicalTarget = null) {
      const id = deviceId ?? 0;
      const offsetV = voltageOffsets.get(id) ?? 0;
      return { ok: true, targetV: 1.028, offsetV, frequencyTargetMhz: 2400 };
    },
    async setVoltageOffset({ offsetV } = {}, deviceId = 0, physicalTarget = null) {
      if (!Number.isFinite(offsetV)) return { ok: false, errorCode: 'invalid-argument', message: 'offsetV must be a finite number' };
      if (offsetV > 0) return { ok: false, errorCode: 'invalid-argument', message: 'the Sysman voltage offset path accepts only negative offsets or zero to clear' };
      const applied = Math.max(ALCHEMIST_NEGATIVE_VOLT_OFFSET_MIN_V, offsetV);
      voltageOffsets.set(deviceId ?? 0, applied);
      try {
        const entry = backend._entry?.(deviceId ?? 0);
        if (entry?.state && entry.caps?.ranges?.gpuVoltOffsetV?.units === 'V') entry.state.gpuVoltOffsetV = applied;
      } catch {
        // The mock's call result remains deterministic for bare test seams.
      }
      return { ok: true, targetV: 1.028, offsetV: applied, frequencyTargetMhz: 2400 };
    },
  };
}
