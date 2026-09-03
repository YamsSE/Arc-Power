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
 *   log?: (s: string) => void,
 * }} [opts]
 */
export function createSysmanPowerLimits({ findLoader = findZeLoaderDll, load = loadSysman, log = (s) => console.log(`[sysman] ${s}`) } = {}) {
  /** @type {{ lib: object, devices: Array<{ pwrHandle: unknown, bdf: string|null }> } | null} */
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
        if (pwrHandle !== null) devices.push({ pwrHandle, bdf });
      }
      if (devices.length === 0) throw new Error('no usable power domain on any Sysman device');
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
      if (!device) {
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
      if (!device) {
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
  };
}
