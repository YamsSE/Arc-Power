// Arc Power — M1 IgclBackend: the primary IOCBackend implementation,
// driving the native IGCL runtime (IntelControlLib.dll) through koffi.
//
// Loading/init policy (docs/igcl-integration.md §1–§2):
//   - the runtime DLL is re-discovered every launch via the DriverStore scan
//     (findIgclDll: active-driver-version matching, never "newest folder");
//   - ctlInit uses the all-zeros application UID + CTL_INIT_FLAG_USE_LEVEL_ZERO
//     (invented UIDs are rejected on the current driver);
//   - V2 OC APIs + capability-unit conversion (canonical Settings fields in
//     W/V/MHz/C/GTS; never assume mV/mW) — pinned per-API unit contract
//     (docs/igcl-integration.md §4).
//
// Safety contract:
//   - every apply clamps to the capability range and verifies by read-back;
//   - fan setters are invoked ONLY when the EFFECTIVE fan canControl === true
//     (properties.canControl || the live reversible probe result — M3-D: the
//     A770's canControl=false property is a lie, the driver honors table
//     writes with the FAN enum's PERCENT encoding);
//   - ctlOverclockWaiverSet is called only when constructed with
//     allowAutoWaiver: true (smoke/tests) or via setWaiverAccepted()
//     (explicit user acceptance — M2a product path).

import koffi from 'koffi';
import {
  CTL_INIT_FLAG_USE_LEVEL_ZERO, CTL_RESULT, CTL_FAN_SPEED_MODE, CTL_FAN_SPEED_UNITS,
  describeResult, makeVersion, loadIgcl, findIgclDll, decodeItem,
} from './igcl-bindings.js';
import { igclErrorCode } from './backend.interface.js';
import { canonicalToIgcl, igclToCanonical, clampAndSnap, clampGpuLock, clampFanPct, normalizeFanCurve, nearlyEqual, TEMP_LIMIT_MAX_C } from './units.js';
import { EXTENDED_PL_MAX_W, EXTENDED_TL_MAX_C } from '../old-igcl.js';

const ZERO_UID = { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] };

// ctl_fan_config_t.mode -> canonical fanMode.
const FAN_MODE_CANONICAL = { 0: 'auto', 1: 'fixed', 2: 'curve' };

// CTL_FAN_SPEED_UNITS maps numeric codes -> names ({1: 'PERCENT'}), so the
// ctl_fan_speed_t.units field needs the numeric code — look it up by name.
const FAN_UNITS_PERCENT = Number(Object.entries(CTL_FAN_SPEED_UNITS).find(([, n]) => n === 'PERCENT')[0]);

const OC_UNIT_FIELDS = {
  powerLimit: 'powerLimit',
  gpuVoltOffset: 'gpuVoltageOffset',
  gpuFreqOffset: 'gpuFrequencyOffset',
  tempLimit: 'temperatureLimit',
  vramFreqOffset: 'vramMemSpeedLimit',
  vramVoltOffset: 'vramVoltageOffset',
};

export class IgclBackend {
  /**
   * @param {{
   *   dllPath?: string|null,          // override discovery (tests / explicit path)
   *   allowAutoWaiver?: boolean,      // smoke/tests only — never in product paths
   *   lib?: object|null,              // injected bound lib (tests); loaded at init() otherwise
   *   findDll?: () => string|null,    // injectable discovery (tests)
   *   extended?: { isCapable: () => Promise<boolean> },  // M2C-C bundled-2023-runtime probe
   *   ocMode?: 'stock'|'advanced',    // M3-C-E: which range set getCapabilities
   *                                   // exposes (default 'stock' — the real
   *                                   // product default; mock passes advanced)
   *   fanProbe?: boolean,             // M3-D: run the reversible fan-capability
   *                                   // probe on canControl=false devices
   *                                   // (default true; tests pass false to keep
   *                                   // read-only fixtures read-only)
   * }} opts
   */
  constructor(opts = {}) {
    this.kind = 'igcl';
    this._dllPath = opts.dllPath ?? null;
    this._allowAutoWaiver = opts.allowAutoWaiver === true;
    this._lib = opts.lib ?? null;
    this._findDll = opts.findDll ?? findIgclDll;
    this._extended = opts.extended ?? null;
    this._ocMode = opts.ocMode === 'advanced' ? 'advanced' : 'stock';
    this._apiHandle = null;
    this._levelZeroOk = false;
    this._initError = null;
    this._devices = null;
    this._caps = new Map(); // deviceId -> Capabilities
    this._ocUnits = new Map(); // deviceId -> {field -> CTL_UNITS}
    this._fanHandles = new Map(); // deviceId -> [handles]
    this._waiverAccepted = new Map(); // deviceId -> bool
    this._telemetryCbs = new Map(); // deviceId -> Set<cb>
    this._activity = new Map(); // M3-C-L: deviceId -> { t, counter } for the utilPct delta method
    // M3-D: the fan-capability probe cache — deviceId -> Promise<{probeOk,
    // writeAccepted}>. DEDICATED: the caps cache is invalidated by ocMode
    // flips (setOcMode), the probe result must NOT be (the card's write
    // acceptance does not change with the app's OC mode). Promise-keyed so
    // concurrent first caps reads share ONE probe — never a double probe.
    this._fanProbeCache = new Map();
    this._fanProbeEnabled = opts.fanProbe !== false;
  }

  /**
   * M3-C-E: switch the OC mode and INVALIDATE the per-device caps cache —
   * the next getCapabilities re-derives the ranges from the new mode
   * (extended ranges exposed only in advanced). Returns the effective mode.
   * @param {'stock'|'advanced'} mode
   * @returns {'stock'|'advanced'}
   */
  setOcMode(mode) {
    const next = mode === 'advanced' ? 'advanced' : 'stock';
    if (next !== this._ocMode) {
      this._ocMode = next;
      this._caps.clear();
    }
    return next;
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
        throw new Error('ctlInit symbol unavailable in the IGCL runtime — driver too old or wrong DLL loaded.');
      }
      const initArgs = koffi.alloc('ctl_init_args_t', 1);
      koffi.encode(initArgs, 'ctl_init_args_t', {
        Size: koffi.sizeof('ctl_init_args_t'),
        Version: 0,
        AppVersion: makeVersion(1, 1),
        flags: CTL_INIT_FLAG_USE_LEVEL_ZERO,
        SupportedVersion: 0,
        ApplicationUID: ZERO_UID,
      });
      const apiHandleBuf = koffi.alloc('void*', 1);
      const result = lib.ctlInit(initArgs, apiHandleBuf);
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

  async _ensureDevices() {
    if (this._devices) return this._devices;
    await this.init();
    const lib = this._libOrThrow();
    const api = this._apiHandle;

    const countBuf = koffi.alloc('uint32', 1);
    koffi.encode(countBuf, 'uint32', 0);
    let result = lib.ctlEnumerateDevices(api, countBuf, null);
    if (result !== CTL_RESULT.SUCCESS) {
      throw new Error(`ctlEnumerateDevices(count) failed: ${describeResult(result)}`);
    }
    const count = koffi.decode(countBuf, 'uint32');
    const devices = [];
    if (count === 0) return (this._devices = devices);

    const handlesBuf = koffi.alloc('void*', count);
    koffi.encode(countBuf, 'uint32', count);
    result = lib.ctlEnumerateDevices(api, countBuf, handlesBuf);
    if (result !== CTL_RESULT.SUCCESS) {
      throw new Error(`ctlEnumerateDevices(fill) failed: ${describeResult(result)}`);
    }

    for (let i = 0; i < count; i++) {
      const handle = koffi.decode(handlesBuf, i * 8, 'void*');
      const propsBuf = koffi.alloc('ctl_device_adapter_properties_t', 1);
      koffi.encode(propsBuf, 'ctl_device_adapter_properties_t', { Size: koffi.sizeof('ctl_device_adapter_properties_t'), Version: 3 });
      result = lib.ctlGetDeviceProperties(handle, propsBuf);
      if (result !== CTL_RESULT.SUCCESS) {
        throw new Error(`ctlGetDeviceProperties(${i}) failed: ${describeResult(result)}`);
      }
      const p = koffi.decode(propsBuf, 'ctl_device_adapter_properties_t');
      devices.push({
        id: i,
        handle,
        name: (p.name || '').replace(/\0+$/, ''),
        type: 'GRAPHICS',
        pciVendorId: `0x${(Number(p.pci_vendor_id) >>> 0).toString(16).padStart(8, '0')}`,
        pciDeviceId: `0x${(Number(p.pci_device_id) >>> 0).toString(16).padStart(8, '0')}`,
        revId: p.rev_id,
        bdf: { bus: p.adapter_bdf.bus, device: p.adapter_bdf.device, function: p.adapter_bdf.function },
        driverVersion: '0x' + p.driver_version.toString(16).padStart(16, '0'),
        graphicsClockMHz: p.Frequency,
        numXeCores: p.num_xe_cores,
      });
    }
    return (this._devices = devices);
  }

  async listDevices() {
    const devices = await this._ensureDevices();
    return devices.map(({ id, name, type, pciVendorId, pciDeviceId, revId, bdf, driverVersion, graphicsClockMHz, numXeCores }) => ({
      id, name, type, pciVendorId, pciDeviceId, revId, bdf, driverVersion, graphicsClockMHz, numXeCores,
    }));
  }

  async _device(deviceId) {
    const devices = await this._ensureDevices();
    const dev = devices[deviceId];
    if (!dev) throw new Error(`unknown device id ${deviceId}`);
    return dev;
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
   * M3-D: the fan-capability probe cache accessor — deviceId ->
   * Promise<{probeOk: boolean, writeAccepted: boolean}>. The DEDICATED
   * promise-keyed cache lives OUTSIDE the caps cache: concurrent first
   * calls share ONE probe promise (never a double probe) and ocMode flips
   * never re-probe (the card's write acceptance does not change with the
   * app's OC mode). A throwing probe degrades to probeOk=false +
   * writeAccepted=false — the fan stays read-only, never a hard crash of
   * getCapabilities. `maxPoints` (fan properties) sizes the sample table
   * (F3); the same device always reports the same value, so it is safe
   * under the deviceId-keyed cache.
   * @param {number} deviceId
   * @param {number} [maxPoints]
   * @returns {Promise<{ probeOk: boolean, writeAccepted: boolean }>}
   */
  _probeFanCapability(deviceId, maxPoints) {
    if (this._fanProbeCache.has(deviceId)) return this._fanProbeCache.get(deviceId);
    const p = this._runFanProbe(deviceId, maxPoints).catch((err) => {
      console.error(`[igcl-backend] fan capability probe threw for device ${deviceId}: ${err.message} — fan stays read-only`);
      return { probeOk: false, writeAccepted: false };
    });
    this._fanProbeCache.set(deviceId, p);
    return p;
  }

  /**
   * M3-D: the reversible fan-capability probe (the Alchemist unlock,
   * live-verified on the A770 2026-08-06). The driver reports
   * canControl=false but honors table/default writes when the table uses
   * the FAN enum's PERCENT units (1 — NOT the general CTL_UNITS.PERCENT 11;
   * that was why earlier probes failed) and Intel's sample encoding
   * (Size/Version filled, points ascending). Probe = write a safe 0-90%
   * sample table of min(10, maxPoints) points (F3: a maxPoints<10 card
   * would otherwise stay read-only despite accepting tables), read back +
   * verify exact point match, restore default mode, verify. The restore is
   * retried on failure — a failed probe must NEVER leave the card in table
   * mode (a stuck table mode is itself treated as probe failure with an
   * honest retry/report). The write outcome decides honesty — the probe is
   * NOT gated on elevation (non-elevated writes fail -> read-only), and
   * writeAccepted (the table write succeeded, F2) is reported separately
   * from probeOk (full verify passed) so the caller can keep the real
   * modes for a card that demonstrably accepts tables even when a later
   * step failed (stuck restore, IGS reapply race).
   * @param {number} deviceId
   * @param {number} [maxPoints]  fan properties' maxPoints (default 10)
   * @returns {Promise<{ probeOk: boolean, writeAccepted: boolean }>}
   */
  async _runFanProbe(deviceId, maxPoints) {
    const lib = this._libOrThrow();
    const fanHandles = await this._fanHandlesOf(deviceId);
    const fan = fanHandles[0];
    if (!fan || this._isUnavailable(lib.ctlFanSetSpeedTableMode)
      || this._isUnavailable(lib.ctlFanSetDefaultMode)
      || this._isUnavailable(lib.ctlFanGetConfig)) {
      return { probeOk: false, writeAccepted: false };
    }

    // Intel's sample encoding: Size/Version filled, FAN-enum PERCENT units
    // (1), strictly ascending temps, safe speeds 0-90%. Point count honors
    // the card's maxPoints (capped at the live-verified 10-point sample).
    const pointCount = Number.isInteger(maxPoints) && maxPoints > 0 ? Math.min(10, maxPoints) : 10;
    const expected = [];
    for (let i = 0; i < pointCount; i++) expected.push({ t: 20 + i * 8, speedPct: i * 10 });
    const table = expected.map((p) => ({
      Size: koffi.sizeof('ctl_fan_temp_speed_t'),
      Version: 0,
      temperature: p.t,
      speed: { Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: p.speedPct, units: FAN_UNITS_PERCENT },
    }));
    const tableObj = { Size: koffi.sizeof('ctl_fan_speed_table_t'), Version: 0, numPoints: table.length, table };

    const setResult = lib.ctlFanSetSpeedTableMode(fan, tableObj);
    const writeAccepted = setResult === CTL_RESULT.SUCCESS;
    if (!writeAccepted) {
      // The write itself failed: the card was never put in table mode, so
      // no restore is needed — the refusal IS the honest answer.
      console.error(`[igcl-backend] fan probe: ctlFanSetSpeedTableMode refused (${describeResult(setResult)}) — fan stays read-only`);
      return { probeOk: false, writeAccepted };
    }

    // Read-back verify: exact point match, PERCENT units.
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
          return tp.speed.units === FAN_UNITS_PERCENT
            && nearlyEqual(tp.temperature, p.t, 1)
            && nearlyEqual(tp.speed.speed, p.speedPct, 1);
        });
    }
    if (!readOk) {
      console.error('[igcl-backend] fan probe: table read-back did not match the sample — probe fails');
    }

    // Restore default mode, retried: a failed probe must NEVER leave the
    // card in table mode.
    const restoreOk = await this._restoreFanDefault(fan, deviceId);

    const probeOk = readOk && restoreOk;
    console.log(`[igcl-backend] fan probe device ${deviceId}: table write ${writeAccepted ? 'accepted' : 'refused'}, read-back ${readOk ? 'OK' : 'FAILED'}, restore-to-default ${restoreOk ? 'OK' : 'FAILED'} — effective canControl=${probeOk}`);
    return { probeOk, writeAccepted };
  }

  /**
   * M3-D: ctlFanSetDefaultMode + read-back verify, retried once. True only
   * when the card reads back in DEFAULT (auto) mode. A stuck table mode is
   * reported loudly — the caller treats it as probe failure.
   * @param {object} fan
   * @param {number} deviceId
   * @returns {Promise<boolean>}
   */
  async _restoreFanDefault(fan, deviceId) {
    const lib = this._libOrThrow();
    if (this._isUnavailable(lib.ctlFanSetDefaultMode) || this._isUnavailable(lib.ctlFanGetConfig)) return false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const setResult = lib.ctlFanSetDefaultMode(fan);
      if (setResult !== CTL_RESULT.SUCCESS) {
        console.error(`[igcl-backend] fan probe: restore-to-default attempt ${attempt} failed (${describeResult(setResult)}) — retrying`);
        continue;
      }
      const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
      koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
      const getResult = lib.ctlFanGetConfig(fan, cfgBuf);
      if (getResult === CTL_RESULT.SUCCESS && koffi.decode(cfgBuf, 'ctl_fan_config_t').mode === 0 /* DEFAULT */) return true;
    }
    console.error(`[igcl-backend] fan probe: restore-to-default FAILED after retries for device ${deviceId} — the card may be left in table mode`);
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

  async getCapabilities(deviceId) {
    await this._device(deviceId);
    if (this._caps.has(deviceId)) {
      const cached = this._caps.get(deviceId);
      // waiverAccepted is live state, not a static capability — refresh it
      // so a later setWaiverAccepted() is reflected without re-reading IGCL.
      // Return a copy: callers must never be able to poison the cache.
      const out = structuredClone(cached);
      out.waiverAccepted = this._waiverAccepted.get(deviceId) ?? false;
      return out;
    }
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);

    const caps = {
      oemName: 'Intel',
      deviceName: dev.name,
      waiverAccepted: this._waiverAccepted.get(deviceId) ?? false,
      controls: {
        gpuFreqOffset: false, gpuVoltOffset: false, gpuLock: false,
        vramFreqOffset: false, vramVoltOffset: false,
        powerLimit: false, tempLimit: false, vfCurve: false,
      },
      ranges: {},
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
        // above 90 C with 0x44000005 even if the props ever drift above it —
        // pin the EXPOSED max to TEMP_LIMIT_MAX_C so the UI/presets/validation
        // can never offer an un-appliable value (plan.md M2C-A F3). M2C-C:
        // the pin yields to the extended range when the bundled 2023 runtime
        // is capable (values above 90 C then route to that runtime).
        if (caps.ranges.tempLimitC && caps.ranges.tempLimitC.max > TEMP_LIMIT_MAX_C) {
          caps.ranges.tempLimitC = { ...caps.ranges.tempLimitC, max: TEMP_LIMIT_MAX_C };
        }
        // M2C-C extended ranges: when the bundled 2023 IGCL runtime loads on
        // this driver AND the OC mode is advanced (M3-C-E), report the FULL
        // range (PL max 315 W — live-verified ceiling, TL max 115 C — min/default stay
        // the DriverStore values) + the extendedRanges flag. The UI exposes
        // those maxes; applies above the DriverStore clamp route to the
        // 2023 runtime (apply-routing.js). In stock mode the extended maxes
        // are NEVER exposed — the mode gate refuses them before any clamp.
        const extendedCapable = this._extended
          ? await this._extended.isCapable()
          : false;
        if (extendedCapable && this._ocMode === 'advanced') {
          if (caps.ranges.powerLimitW) {
            caps.ranges.powerLimitW = { ...caps.ranges.powerLimitW, max: EXTENDED_PL_MAX_W };
          }
          if (caps.ranges.tempLimitC) {
            caps.ranges.tempLimitC = { ...caps.ranges.tempLimitC, max: EXTENDED_TL_MAX_C };
          }
          caps.extendedRanges = true;
        }
        // gpuLock: supported when the symbol pair exists (0,0 pair = dynamic,
        // still supported).
        caps.controls.gpuLock = !this._isUnavailable(lib.ctlOverclockGpuLockGet)
          && !this._isUnavailable(lib.ctlOverclockGpuLockSet);
        // vfCurve: supported only when the read path answers (on Alchemist it
        // errors with DATA_READ — report unsupported so the UI hides it).
        caps.controls.vfCurve = this._vfCurveReadable(dev.handle);
      }
    }

    // --- Fan ---
    const fanHandles = await this._fanHandlesOf(deviceId);
    if (fanHandles.length > 0 && !this._isUnavailable(lib.ctlFanGetProperties)) {
      const propBuf = koffi.alloc('ctl_fan_properties_t', 1);
      koffi.encode(propBuf, 'ctl_fan_properties_t', { Size: koffi.sizeof('ctl_fan_properties_t'), Version: 0 });
      const result = lib.ctlFanGetProperties(fanHandles[0], propBuf);
      if (result === CTL_RESULT.SUCCESS) {
        const fp = koffi.decode(propBuf, 'ctl_fan_properties_t');
        // M3-D: canControl=false is a LIE on this A770 — the driver honors
        // table/default writes anyway (live-verified 2026-08-06). The probe
        // is the unlock AND the mode-truth: the 1<<mode derivation from
        // supportedModes=0x2 yields ['fixed'] — the ONE mode this card
        // genuinely refuses — so the probe runs whenever properties refuse
        // control OR the derived modes claim 'fixed' (F1: with the IGS
        // app/service running canControl=TRUE and the derivation would
        // still gate the Fan page to fixed-only in the primary usage;
        // never gate the probe on !canControl). Reversible: write the
        // sample table (min(10, maxPoints) points, FAN-enum PERCENT
        // units), read back, restore default — restore retried, never left
        // in table mode. The result is cached OUTSIDE the caps cache and
        // shared across concurrent first calls; effective canControl =
        // properties.canControl || probeOk. Probe-learned modes follow the
        // WRITE-ACCEPTED rule (F2): when the table WRITE was accepted the
        // real modes are ['auto','curve'] (the card demonstrably accepts
        // tables — even when a later step failed, e.g. a stuck restore or
        // an IGS reapply race); a write-REFUSED probe keeps the derived
        // modes (claiming auto/curve on a genuinely fixed-only card would
        // lie). The derivation stays only for cards that never probe
        // (probe disabled, or probe symbols missing).
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
          const probe = await this._probeFanCapability(deviceId, fp.maxPoints);
          canControl = fp.canControl || probe.probeOk;
          modes = probe.writeAccepted ? ['auto', 'curve'] : modes;
        }
        caps.fan = {
          canControl,
          // Map through the same table as fan-mode read-back so
          // caps.fan.modes and DeviceState.fanMode share one vocabulary
          // (auto|curve|fixed) — never raw IGCL names.
          modes,
          maxRpm: fp.maxRPM,
          maxCurvePoints: fp.maxPoints,
        };
      }
    }

    this._caps.set(deviceId, caps);
    return structuredClone(caps);
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
      default: return `UNITS_${units}`;
    }
  }

  _vfCurveReadable(handle) {
    const lib = this._libOrThrow();
    if (this._isUnavailable(lib.ctlOverclockReadVFCurve)) return false;
    try {
      const numBuf = koffi.alloc('uint32', 1);
      koffi.encode(numBuf, 'uint32', 0);
      const result = lib.ctlOverclockReadVFCurve(handle, 0 /* STOCK */, 2 /* ELABORATE */, numBuf, null);
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
        state.gpuLock = { voltageV: lock.Voltage, freqMhz: lock.Frequency };
      }
    }

    // vfCurve (read-only in M1; unsupported on Alchemist)
    if (caps.controls.vfCurve && !this._isUnavailable(lib.ctlOverclockReadVFCurve)) {
      const numBuf = koffi.alloc('uint32', 1);
      koffi.encode(numBuf, 'uint32', 0);
      let result = lib.ctlOverclockReadVFCurve(dev.handle, 0, 2, numBuf, null);
      const num = koffi.decode(numBuf, 'uint32');
      if (result === CTL_RESULT.SUCCESS && num > 0 && num < 10000) {
        const curveBuf = koffi.alloc('ctl_voltage_frequency_point_t', num);
        result = lib.ctlOverclockReadVFCurve(dev.handle, 0, 2, numBuf, curveBuf);
        if (result === CTL_RESULT.SUCCESS) {
          const sz = koffi.sizeof('ctl_voltage_frequency_point_t');
          state.vfCurve = [];
          for (let i = 0; i < num; i++) {
            const pt = koffi.decode(curveBuf, i * sz, 'ctl_voltage_frequency_point_t');
            state.vfCurve.push({ voltageV: pt.Voltage, freqMhz: pt.Frequency });
          }
        }
      }
    }

    // Fan read-back (read-only here even when the EFFECTIVE canControl is
    // false — the A770 still reports config/state; setters stay gated).
    const fanHandles = await this._fanHandlesOf(deviceId);
    if (fanHandles.length > 0 && !this._isUnavailable(lib.ctlFanGetConfig)) {
      const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
      koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
      const result = lib.ctlFanGetConfig(fanHandles[0], cfgBuf);
      if (result === CTL_RESULT.SUCCESS) {
        const cfg = koffi.decode(cfgBuf, 'ctl_fan_config_t');
        state.fanMode = FAN_MODE_CANONICAL[cfg.mode] ?? null;
        if (cfg.speedTable.numPoints > 0 && cfg.speedTable.numPoints <= 32) {
          state.fanCurve = [];
          for (let i = 0; i < cfg.speedTable.numPoints; i++) {
            const tp = cfg.speedTable.table[i];
            state.fanCurve.push({
              t: tp.temperature,
              // RPM tables cannot be normalized to % (maxRPM is unknown on
              // Alchemist) — only PERCENT units become canonical % values.
              speedPct: tp.speed.units === FAN_UNITS_PERCENT ? tp.speed.speed : null,
            });
          }
          // Mixed/unknown units make the canonical % curve meaningless.
          if (state.fanCurve.some((p) => p.speedPct === null)) state.fanCurve = null;
        }
        if (cfg.speedFixed.units === FAN_UNITS_PERCENT) {
          state.fixedFanPct = cfg.speedFixed.speed;
        } else {
          state.fixedFanPct = null; // RPM fixed speed (no maxRPM to normalize) or none set
        }
      }
    }

    return state;
  }

  // -------------------------------------------------------------------------
  // Apply
  // -------------------------------------------------------------------------

  /**
   * Apply settings. `opts.snapToStep` (default true) controls step-snapping:
   * product applies snap to the capability step; the smoke no-op round trip
   * passes snapToStep:false so an off-grid current value (e.g. the A770's
   * 48.3 MHz offset) is written back EXACTLY as read — never changed.
   */
  async applySettings(deviceId, settings = {}, opts = {}) {
    await this._device(deviceId);
    const caps = await this.getCapabilities(deviceId);
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const units = await this._ocUnitsOf(deviceId);
    const result = { ok: true, perControl: {} };

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
        // read-back did not change — the driver accepted nothing. This is a
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
        fail('gpuLock', 'unsupported', 'GPU lock not supported on this device');
        return;
      }
      if (this._isUnavailable(lib.ctlOverclockGpuLockSet) || this._isUnavailable(lib.ctlOverclockGpuLockGet)) {
        fail('gpuLock', 'unavailable-symbol', 'GPU lock API missing in the IGCL runtime');
        return;
      }
      // Never assume the caller's pair is in range (backend contract): the
      // lock pair has no capability range, so clamp to the documented bounds.
      const bounded = clampGpuLock(lock, caps.ranges);
      const pair = { Size: koffi.sizeof('ctl_oc_vf_pair_t'), Version: 0, Voltage: bounded.voltageV, Frequency: bounded.freqMhz };
      const setResult = lib.ctlOverclockGpuLockSet(dev.handle, pair);
      if (setResult !== CTL_RESULT.SUCCESS) {
        fail('gpuLock', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
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
        readBackEqual = nearlyEqual(got.Voltage, bounded.voltageV) && nearlyEqual(got.Frequency, bounded.freqMhz);
        message = readBackEqual ? undefined : `read-back ${got.Voltage}V/${got.Frequency}MHz != requested`;
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
    };

    const applyFan = async () => {
      const requested = ['fanMode', 'fanCurve', 'fixedFanPct']
        .filter((c) => settings[c] !== null && settings[c] !== undefined);
      if (requested.length === 0) return;

      // Hard safety rule: fan setters only when the EFFECTIVE canControl is
      // true (properties.canControl || probeOk — M3-D: the A770's property
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
      const fan = fanHandles[0];

      // Resolve the mode to switch to (explicit fanMode, else implied by data).
      let mode = settings.fanMode;
      if (!mode) {
        if (settings.fanCurve) mode = 'curve';
        else if (settings.fixedFanPct !== undefined && settings.fixedFanPct !== null) mode = 'fixed';
      }
      // Mode gate (F5, mock parity): refuse modes outside caps.fan.modes —
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

      const pct = (p) => ({ Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: clampFanPct(p), units: FAN_UNITS_PERCENT });

      // Read-back verification for fan applies (plan §5: every apply is
      // followed by read-back verification). `expected.curve` is an array of
      // { t, speedPct } of the ROUNDED points that were sent; `expected.fixedPct`
      // is the rounded fixed speed. The mode must match the requested canonical
      // mode; table points / fixed speed are compared (within tolerance) when
      // the read-back reports PERCENT units — RPM values cannot be normalized
      // without maxRPM, so mode match suffices there.
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
            got.push({ t: tp.temperature, speedPct: tp.speed.units === FAN_UNITS_PERCENT ? tp.speed.speed : null });
          }
          if (got.some((p) => p.speedPct === null)) {
            return { ok: false, message: 'fan curve read-back is not in PERCENT units — cannot verify' };
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
        if (expected.fixedPct !== undefined && cfg.speedFixed.units === FAN_UNITS_PERCENT) {
          if (!nearlyEqual(cfg.speedFixed.speed, expected.fixedPct, 1)) {
            return { ok: false, message: `fixed fan speed read-back ${cfg.speedFixed.speed}% != requested ${expected.fixedPct}%` };
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
          // requires an ascending table) — shared with MockBackend so both
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
              curve: table.map((p) => ({ t: p.temperature, speedPct: p.speed.speed })),
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
        if (this._isUnavailable(lib.ctlFanSetFixedSpeedMode)) {
          fail('fixedFanPct', 'unavailable-symbol', 'fixed fan speed API missing in the IGCL runtime');
        } else {
          const fixed = pct(settings.fixedFanPct);
          const setResult = lib.ctlFanSetFixedSpeedMode(fan, fixed);
          if (setResult === CTL_RESULT.SUCCESS) {
            const v = verifyFanConfig(fan, 'fixed', { fixedPct: fixed.speed });
            result.perControl.fixedFanPct = { ok: v.ok, readBackEqual: v.ok, errorCode: v.ok ? undefined : 'io-failed', message: v.message };
            fixedOk = v.ok;
            if (!v.ok) result.ok = false;
          } else {
            fail('fixedFanPct', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
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
    await applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', 'gpuVoltOffset', settings.gpuVoltOffsetV);
    await applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', 'gpuFreqOffset', settings.gpuFreqOffsetMhz);
    await applyScalar('tempLimit', 'tempLimitC', 'tempLimit', settings.tempLimitC);
    await applyScalar('vramFreqOffset', 'vramFreqOffsetGts', 'vramFreqOffset', settings.vramFreqOffsetGts);
    await applyScalar('vramVoltOffset', 'vramVoltOffsetV', 'vramVoltOffset', settings.vramVoltOffsetV);
    await applyLock(settings.gpuLock);
    await applyFan();

    // vfCurve write path (Battlemage; not exercised in M1 on Alchemist).
    if (settings.vfCurve !== null && settings.vfCurve !== undefined) {
      if (!caps.controls.vfCurve || this._isUnavailable(lib.ctlOverclockWriteCustomVFCurve)) {
        fail('vfCurve', 'unsupported', 'custom VF curve not supported on this device');
      } else {
        const points = settings.vfCurve.map((p) => ({ Voltage: p.voltageV, Frequency: p.freqMhz }));
        const setResult = lib.ctlOverclockWriteCustomVFCurve(dev.handle, points.length, points);
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
            let res = lib.ctlOverclockReadVFCurve(dev.handle, 0, 2, numBuf, null);
            const num = koffi.decode(numBuf, 'uint32');
            if (res !== CTL_RESULT.SUCCESS) {
              v = { ok: false, message: `VF curve write succeeded but read-back failed (${describeResult(res)})` };
            } else if (num !== points.length) {
              v = { ok: false, message: `VF curve read-back ${num} points != requested ${points.length}` };
            } else {
              const curveBuf = koffi.alloc('ctl_voltage_frequency_point_t', num);
              res = lib.ctlOverclockReadVFCurve(dev.handle, 0, 2, numBuf, curveBuf);
              if (res !== CTL_RESULT.SUCCESS) {
                v = { ok: false, message: `VF curve read-back failed (${describeResult(res)})` };
              } else {
                const sz = koffi.sizeof('ctl_voltage_frequency_point_t');
                v = { ok: true };
                for (let i = 0; i < num; i++) {
                  const pt = koffi.decode(curveBuf, i * sz, 'ctl_voltage_frequency_point_t');
                  const want = points[i];
                  if (!nearlyEqual(pt.Voltage, want.Voltage, 1e-6) || !nearlyEqual(pt.Frequency, want.Frequency, 1e-6)) {
                    v = { ok: false, message: `VF curve point ${i} read-back ${pt.Voltage}V/${pt.Frequency}MHz != requested ${want.Voltage}V/${want.Frequency}MHz` };
                    break;
                  }
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

    // Reconciliation for a driver-level waiver loss (G2): the driver can
    // lose the waiver (reinstall, IGS reset) while settings.json still says
    // accepted — every setter then answers waiver-not-set. Clear the stale
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
      throw new Error(`ctlOverclockWaiverSet failed: ${describeResult(result)}`);
    }
    this._waiverAccepted.set(deviceId, true);
  }

  /**
   * Boot-time seeding of a persisted waiver acceptance (F1): sets ONLY the
   * in-memory flag — NEVER calls ctlOverclockWaiverSet, which must run only
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
    if (this._isUnavailable(lib.ctlPowerTelemetryGet)) {
      throw new Error('ctlPowerTelemetryGet symbol unavailable in the IGCL runtime');
    }
    const telBuf = koffi.alloc('ctl_power_telemetry_t', 1);
    koffi.encode(telBuf, 'ctl_power_telemetry_t', { Size: koffi.sizeof('ctl_power_telemetry_t'), Version: 1 });
    const result = lib.ctlPowerTelemetryGet(dev.handle, telBuf);
    if (result !== CTL_RESULT.SUCCESS) {
      throw new Error(`ctlPowerTelemetryGet failed: ${describeResult(result)}`);
    }

    const item = (n) => {
      const it = decodeItem(telBuf, 'ctl_power_telemetry_t', n);
      return it.bSupported ? it.value : undefined;
    };
    const throttleBool = (n) => {
      try { return koffi.decode(telBuf, koffi.offsetof('ctl_power_telemetry_t', n), 'bool'); } catch { return undefined; }
    };

    const sample = {
      t: item('timeStamp'),
      gpuClockMhz: item('gpuCurrentClockFrequency'),
      memClockMhz: item('vramCurrentClockFrequency'),
      tempC: item('gpuCurrentTemperature'),
      vramTempC: item('vramCurrentTemperature'),
      gpuVoltageV: item('gpuVoltage'),
      gpuEnergyJ: item('gpuEnergyCounter'),
      vramEnergyJ: item('vramEnergyCounter'),
      totalEnergyJ: item('totalCardEnergyCounter'),
      fanRpm: [],
      throttle: {
        power: throttleBool('gpuPowerLimited'),
        temp: throttleBool('gpuTemperatureLimited'),
        current: throttleBool('gpuCurrentLimited'),
        voltage: throttleBool('gpuVoltageLimited'),
        util: throttleBool('gpuUtilizationLimited'),
      },
    };
    try {
      const off = koffi.offsetof('ctl_power_telemetry_t', 'fanSpeed');
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

    // M3-C-L: utilization from the IGCL activity counters over timestamp
    // deltas — the DOCUMENTED sample-delta method (igcl_api.h
    // §ctl_power_telemetry_t): globalActivityCounter / renderComputeActivity-
    // Counter measure busy TIME IN SECONDS (accurate to 1 ms) that any GPU
    // engine / the 3D-compute engines are busy; dividing the delta by the
    // timestamp delta (also seconds, timeStamp = seconds since epoch) yields
    // the average percentage utilization. The GLOBAL counter is preferred;
    // renderCompute is the fallback — which is populated on this card is
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
   * Clamped to [0, 100] — a counter that runs slightly ahead of the
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
