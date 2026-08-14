// Arc Power - M1 IgclBackend: the primary IOCBackend implementation,
// driving the native IGCL runtime (IntelControlLib.dll) through koffi.
//
// Loading/init policy (docs/igcl-integration.md §1–§2):
//   - the runtime DLL is re-discovered every launch via the DriverStore scan
//     (findIgclDll: active-driver-version matching, never "newest folder");
//   - ctlInit uses the all-zeros application UID + CTL_INIT_FLAG_USE_LEVEL_ZERO
//     (invented UIDs are rejected on the current driver);
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
  CTL_INIT_FLAG_USE_LEVEL_ZERO, CTL_RESULT, CTL_FAN_SPEED_MODE, CTL_FAN_SPEED_UNITS,
  describeResult, makeVersion, loadIgcl, findIgclDll, decodeItem, decodePciProperties,
  CTL_3D_FEATURE, CTL_PROPERTY_VALUE_TYPE, CTL_GAMING_FLIP_MODE_FLAG,
  CTL_3D_LOW_LATENCY, CTL_3D_FRAME_GENERATION_OVERRIDE,
  encode3dFeatureGetset, decode3dFeatureGetsetValue, decode3dFeatureDetails,
} from './igcl-bindings.js';
import {
  igclErrorCode, GRAPHICS_FRAME_GEN_OPTIONS, GRAPHICS_FLIP_MODE_OPTIONS,
  GRAPHICS_LOW_LATENCY_OPTIONS,
} from './backend.interface.js';
import { canonicalToIgcl, igclToCanonical, clampAndSnap, clampGpuLock, clampFanPct, formatDeviceName, normalizeFanCurve, nearlyEqual, TEMP_LIMIT_MAX_C, vramMemTypeOfName } from './units.js';
import { EXTENDED_PL_MAX_W, EXTENDED_TL_MAX_C } from '../old-igcl.js';
// M17c: the pure AIB decode (aibOf + the laptop branch). The renderer TS
// imports fine under the packaged Electron (Node 22.21 - type stripping is
// default since 22.18); the pure module carries no runtime TS-only features.
import { aibOf, laptopAibOf } from '../../renderer/pure/aib.ts';
// M17c: the per-device limits table (the listed rows + the default row) -
// applied main-side in getCapabilities AFTER the driver-props loop. The
// renderer TS imports fine under the packaged Electron (see aib.ts).
import { deviceLimitsOf, defaultLimitsOf } from '../../renderer/pure/device-limits.ts';
// M17e: the listed-card lockRange fallback table (the pure module - the
// a770/a750 documented-class rows; the caps-level fallback when the driver
// props do not report the VF-curve limits; the live A770 driver answers
// bSupported:false - the probe-3 evidence).
import { lockRangeOf } from '../../renderer/pure/lock-ranges.ts';
// M17c: the session refused-ceiling store (parent-side merge + the shared
// recording helper - run B wires the store into getCapabilities + the
// apply paths; the pure module ships the primitives).
import { createRefusedCeilingStore, mergeIntoRanges, recordRefusalEnvelope } from './refused-ceilings.js';

const ZERO_UID = { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] };

// ctl_fan_config_t.mode -> canonical fanMode.
const FAN_MODE_CANONICAL = { 0: 'auto', 1: 'fixed', 2: 'curve' };

// CTL_FAN_SPEED_UNITS maps numeric codes -> names ({1: 'PERCENT'}), so the
// ctl_fan_speed_t.units field needs the numeric code - look it up by name.
const FAN_UNITS_PERCENT = Number(Object.entries(CTL_FAN_SPEED_UNITS).find(([, n]) => n === 'PERCENT')[0]);

// M17p: the fan-probe PERSISTED cache (the igcl-dll-cache precedent -
// %APPDATA%\ArcPower, NOT temp which the OS cleans). The in-memory
// _fanProbeCache is per-process, so the probe (~400-480 ms on this box:
// the failing write/read-back/restore-retries) re-ran at EVERY boot.
// SUCCESS-ONLY persistence: only a cached probeOk:true is trusted across
// boots (the probe verdict is driver/device-bound and stable); a cached
// failure is NEVER trusted - the verdict flips with the IGS service state,
// and a persisted failure would lock a transiently-failing machine
// read-only for a whole driver version (the session cache's re-probe
// self-heals). Key = driverVersion + deviceId; the file is single-entry
// (the last successful probe wins - the igcl-dll-cache shape).
export const FAN_PROBE_CACHE_FILENAME = 'fan-probe-cache.json';

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
   *   laptopInfoOf?: () => object|null,  // M17c: the laptop sysinfo provider
   *                                   // ({ manufacturer, model, pcSystemType,
   *                                   // chassisTypes } from the CIM query -
   *                                   // the cached sysinfo in main.js; null
   *                                   // on desktops) - the getCapabilities
   *                                   // AIB decode's laptop branch feeds on
   *                                   // it (the vramBytesOf injection pattern)
   * }} opts
   */
  constructor(opts = {}) {
    this.kind = 'igcl';
    this._dllPath = opts.dllPath ?? null;
    this._allowAutoWaiver = opts.allowAutoWaiver === true;
    this._lib = opts.lib ?? null;
    this._findDll = opts.findDll ?? findIgclDll;
    this._extended = opts.extended ?? null;
    // M4-D: the VRAM provider for formatDeviceName (constructor opt - main.js
    // runs the sysinfo cache BEFORE constructing the backend, so the lookup
    // is available at enumeration time; setVramBytesOf re-formats an already
    // enumerated device list).
    this._vramBytesOf = typeof opts.vramBytesOf === 'function' ? opts.vramBytesOf : null;
    // M17c: the laptop sysinfo provider (the cached CIM laptop fields) - the
    // vramBytesOf injection pattern; null on desktops (the subsystem decode
    // then stays authoritative).
    this._laptopInfoOf = typeof opts.laptopInfoOf === 'function' ? opts.laptopInfoOf : null;
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
  }

  /**
   * M3-C-E: switch the OC mode and INVALIDATE the per-device caps cache -
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
      const vramBytes = this._vramBytesOf ? this._vramBytesOf(dev) : null;
      dev.vramBytes = Number.isInteger(vramBytes) && vramBytes > 0 ? vramBytes : null;
      dev.name = formatDeviceName(plainName, dev.vramBytes);
      devices.push(dev);
    }
    return (this._devices = devices);
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
        const vramBytes = this._vramBytesOf ? this._vramBytesOf(dev) : null;
        dev.vramBytes = Number.isInteger(vramBytes) && vramBytes > 0 ? vramBytes : null;
        dev.name = formatDeviceName(dev._plainName ?? dev.name, dev.vramBytes);
      }
    }
  }

  async listDevices() {
    const devices = await this._ensureDevices();
    return devices.map(({ id, name, type, pciVendorId, pciDeviceId, revId, bdf, driverVersion, graphicsClockMHz, numXeCores, vramBytes, memType, pciSubsysVendorId, pciSubsysId }) => ({
      id, name, type, pciVendorId, pciDeviceId, revId, bdf, driverVersion, graphicsClockMHz, numXeCores, vramBytes, memType, pciSubsysVendorId, pciSubsysId,
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
  async _probeFanCapability(deviceId, maxPoints) {
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
    const p = this._runFanProbe(deviceId, maxPoints).catch((err) => {
      console.error(`[igcl-backend] fan capability probe threw for device ${deviceId}: ${err.message} - fan stays read-only`);
      return { probeOk: false, writeAccepted: false, fixedOk: false };
    });
    this._fanProbeCache.set(deviceId, p);
    // M17p: SUCCESS-ONLY persistence - only a verified success is written
    // (a failure writes nothing and re-probes next boot; the write itself
    // is best-effort - a cache failure never breaks the probe path).
    void p.then((result) => {
      if (result?.probeOk === true) this._persistFanProbeCache(deviceId, result);
    });
    return p;
  }

  /**
   * M17p: the persisted-cache READ (SUCCESS-ONLY). Returns the cached
   * verdict ONLY when the entry is a probeOk:true success for THIS
   * device's driverVersion + deviceId (a missing / corrupt / mismatched /
   * failed entry is a miss - the probe re-runs and re-persists on
   * success). Never throws (the read is best-effort).
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
      if (entry.driverVersion !== driverVersion || entry.deviceId !== deviceId) return null; // the key mismatch
      return { probeOk: true, writeAccepted: entry.writeAccepted === true, fixedOk: entry.fixedOk === true };
    } catch {
      return null; // a cache read failure never blocks the probe
    }
  }

  /**
   * M17p: the SUCCESS-ONLY persistence write - { driverVersion, deviceId,
   * probeOk, writeAccepted, fixedOk } in the single-entry cache file (the
   * last successful probe wins). A failure writes nothing and never
   * deletes (the stale entry stays inert - the key check keeps it a miss).
   * Best-effort: a write failure never breaks the probe path.
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
      writeFanProbeCache(cacheFile, {
        driverVersion,
        deviceId,
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
   * `fixedOk` = one reversible 50% write via ctlFanSetFixedSpeedMode +
   * read-back verify + restore to default mode (the SAME restore-retry
   * semantics: a failed restore is a probe failure - the fan must NEVER be
   * left at 50% fixed). Only a fully verified fixed probe adds 'fixed' to
   * the learned modes.
   * @param {number} deviceId
   * @param {number} [maxPoints]  fan properties' maxPoints (default 10)
   * @returns {Promise<{ probeOk: boolean, writeAccepted: boolean, fixedOk: boolean }>}
   */
  async _runFanProbe(deviceId, maxPoints) {
    const lib = this._libOrThrow();
    const fanHandles = await this._fanHandlesOf(deviceId);
    const fan = fanHandles[0];
    if (!fan || this._isUnavailable(lib.ctlFanSetSpeedTableMode)
      || this._isUnavailable(lib.ctlFanSetDefaultMode)
      || this._isUnavailable(lib.ctlFanGetConfig)) {
      return { probeOk: false, writeAccepted: false, fixedOk: false };
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
      // no restore is needed - the refusal IS the honest answer. The fixed
      // sub-probe never runs here (a refused table write tells us nothing
      // about fixed writes).
      console.error(`[igcl-backend] fan probe: ctlFanSetSpeedTableMode refused (${describeResult(setResult)}) - fan stays read-only`);
      return { probeOk: false, writeAccepted, fixedOk: false };
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
      console.error('[igcl-backend] fan probe: table read-back did not match the sample - probe fails');
    }

    // Restore default mode, retried: a failed probe must NEVER leave the
    // card in table mode.
    const restoreOk = await this._restoreFanDefault(fan, deviceId);

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
    // probe shape ('fixed' is never offered) - the plan's "honest read-only"
    // intent for the fixed path. Reversibility is intact: the restore is
    // always attempted after a successful fixed write, retried twice, and
    // verified DEFAULT-mode.
    let fixedOk = false;
    if (restoreOk && !this._isUnavailable(lib.ctlFanSetFixedSpeedMode)) {
      fixedOk = await this._runFixedProbe(fan, deviceId);
    }
    return { probeOk, writeAccepted, fixedOk };
  }

  /**
   * M4-C: the fixed-write sub-probe - one reversible 50% write via
   * ctlFanSetFixedSpeedMode + read-back verify (FIXED mode, PERCENT units,
   * 50%) + restore to default mode via ctlFanSetDefaultMode with the SAME
   * restore-retry semantics as the table probe (`_restoreFanDefault`: a
   * failed restore is a probe failure - the fan must NEVER be left at 50%
   * fixed). Runs once per device per session inside the SAME promise-keyed
   * probe cache as the table probe (never a re-probe per caps read; ocMode
   * flips never re-probe). `fixedOk` = write + read-back + restore all
   * succeeded; a refused write needs no restore (the card never entered
   * fixed mode) and is the honest `false`.
   * @param {object} fan
   * @param {number} deviceId
   * @returns {Promise<boolean>}
   */
  async _runFixedProbe(fan, deviceId) {
    const lib = this._libOrThrow();
    const FIXED_PCT = 50;
    const fixed = { Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: FIXED_PCT, units: FAN_UNITS_PERCENT };
    const setResult = lib.ctlFanSetFixedSpeedMode(fan, fixed);
    const writeAccepted = setResult === CTL_RESULT.SUCCESS;
    if (!writeAccepted) {
      // The write itself failed: the card was never put in fixed mode, so
      // no restore is needed - the refusal IS the honest answer.
      console.error(`[igcl-backend] fixed fan probe: ctlFanSetFixedSpeedMode refused (${describeResult(setResult)}) - 'fixed' stays out of the learned modes`);
      return false;
    }

    // Read-back verify: FIXED mode + PERCENT units + the 50% sample.
    let readOk = false;
    const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
    koffi.encode(cfgBuf, 'ctl_fan_config_t', { Size: koffi.sizeof('ctl_fan_config_t'), Version: 0 });
    const getResult = lib.ctlFanGetConfig(fan, cfgBuf);
    if (getResult === CTL_RESULT.SUCCESS) {
      const cfg = koffi.decode(cfgBuf, 'ctl_fan_config_t');
      readOk = cfg.mode === 1 /* FIXED */
        && cfg.speedFixed.units === FAN_UNITS_PERCENT
        && nearlyEqual(cfg.speedFixed.speed, FIXED_PCT, 1);
    }
    if (!readOk) {
      console.error('[igcl-backend] fixed fan probe: read-back did not match the 50% fixed sample - probe fails');
    }

    // Restore default mode, retried: a failed fixed probe must NEVER leave
    // the fan at 50% fixed.
    const restoreOk = await this._restoreFanDefault(fan, deviceId);

    const fixedOk = readOk && restoreOk;
    console.log(`[igcl-backend] fixed fan probe device ${deviceId}: 50% write ${writeAccepted ? 'accepted' : 'refused'}, read-back ${readOk ? 'OK' : 'FAILED'}, restore-to-default ${restoreOk ? 'OK' : 'FAILED'} - fixedOk=${fixedOk}`);
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
  async _restoreFanDefault(fan, deviceId) {
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
          speed: { Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: 30 + i * 20, units: FAN_UNITS_PERCENT },
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
      out.waiverAccepted = this._waiverAccepted.get(deviceId) ?? false;
      return this._finalizeCaps(deviceId, out, this._devices?.[deviceId] ?? null);
    }
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);

    const caps = {
      oemName: 'Intel',
      deviceName: dev.name,
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
        // M2C-C extended ranges: when the bundled 2023 IGCL runtime loads on
        // this driver AND the OC mode is advanced (M3-C-E), report the FULL
        // range (PL max 315 W - live-verified ceiling, TL max 115 C - min/default stay
        // the DriverStore values) + the extendedRanges flag. The UI exposes
        // those maxes; applies above the DriverStore clamp route to the
        // 2023 runtime (apply-routing.js). In stock mode the extended maxes
        // are NEVER exposed - the mode gate refuses them before any clamp.
        const extendedCapable = this._extended
          ? await this._extended.isCapable()
          : false;
        // M4E: the extended concept is W/C-only (the bundled 2023 runtime
        // speaks W/C). Percent-unit ranges (Battlemage: volt/PL/TL as %)
        // must never be overwritten with the 315 W / 115 C maxes nor flip
        // the flag - their range max is the ceiling. Each override is
        // guarded by its own units; the flag is set only when a genuine
        // W/C extended range was exposed.
        const wcExtended = extendedCapable && this._ocMode === 'advanced'
          && ((caps.ranges.powerLimitW && caps.ranges.powerLimitW.units === 'W')
            || (caps.ranges.tempLimitC && caps.ranges.tempLimitC.units === 'C'));
        if (wcExtended) {
          if (caps.ranges.powerLimitW && caps.ranges.powerLimitW.units === 'W') {
            caps.ranges.powerLimitW = { ...caps.ranges.powerLimitW, max: EXTENDED_PL_MAX_W };
          }
          if (caps.ranges.tempLimitC && caps.ranges.tempLimitC.units === 'C') {
            caps.ranges.tempLimitC = { ...caps.ranges.tempLimitC, max: EXTENDED_TL_MAX_C };
          }
          caps.extendedRanges = true;
        }
        // gpuLock: supported when the symbol pair exists (0,0 pair = dynamic,
        // still supported).
        caps.controls.gpuLock = !this._isUnavailable(lib.ctlOverclockGpuLockGet)
          && !this._isUnavailable(lib.ctlOverclockGpuLockSet);
        // vfCurve: supported only when the read path answers (on Alchemist it
        // errors with DATA_READ - report unsupported so the UI hides it).
        caps.controls.vfCurve = this._vfCurveReadable(dev.handle);
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
      const result = lib.ctlFanGetProperties(fanHandles[0], propBuf);
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
        // sub-probe (reversible 50% write) extends the same cached shape -
        // only a fully verified fixed probe (fixedOk) adds 'fixed' to the
        // learned modes (a refused fixed write keeps ['auto','curve']).
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
          // M4-C: the fixed sub-probe extends the write-accepted rule -
          // only a FULLY verified fixed probe (write + read-back + restore
          // all succeeded, fixedOk) adds 'fixed' to the learned modes; a
          // refused/partial fixed probe keeps ['auto','curve'] (claiming
          // fixed on a card that refuses fixed writes would lie).
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
    const identity = {
      pciDeviceId: caps.pciDeviceId ?? dev?.pciDeviceId ?? null,
      aibVendor: caps.aibVendor ?? null,
      aibModel: caps.aibModel ?? null,
    };
    // M17d: the STOCK/ADVANCED SPLIT (round-1 S1) - the finalize selects
    // the ADVANCED shape when caps.extendedRanges is true (the extended
    // 2023-runtime path is active) and the STOCK shape otherwise - NOT the
    // same row in both modes. The advanced shape carries the per-card KMD
    // ceilings (A770 315/115 - the M17c TL cap at 90 REMOVED; A750 270/115 -
    // the TL 115 probe-verified 2026-08-12: 100 AND 115 C applied via the
    // app path, the KMD ceiling class the same as the A770's); the stock
    // shape the per-AIB maxes + the TL 90 caps (the round-3-N3 rule FLIPS
    // to "listed-row advanced ceiling = the app-verified KMD ceiling").
    const limits = deviceLimitsOf(identity, { advanced: caps.extendedRanges === true });
    if (limits) {
      // The UNLISTED path gets the DEFAULT row of the ACTIVE range set
      // (stock 252/90, extended 315/115 - never null, never the wrong
      // shape); a LISTED card's row is the ACTIVE shape (stock or
      // advanced) - the extended maxes of the props/2023 runtime are
      // capped down to the listed shape's ceilings.
      const row = limits.listed ? limits : defaultLimitsOf(caps.extendedRanges === true);
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
    caps.ranges = mergeIntoRanges(this._refusedCeilings, deviceId, caps.ranges);
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
            // M17e (round-1 N9): ctl_voltage_frequency_point_t.Voltage is a
            // uint32 and the IGCL header documents NO unit for it - the
            // struct comment-free field cannot hold volts (volts are
            // untenable in a uint32), and the lock API's mV-vs-V lie (probe
            // 2: the @brief says mV while the pair struct says Volts) is
            // the strongest signal the sibling VF struct is the same
            // contract. But NO blind conversion: the RAW uint32 is surfaced
            // into the canonical voltageV field + the named status records
            // the unverified units until a vfCurve-capable device probe
            // (Battlemage) pins the scale. Live impact today is zero - the
            // A770's curve read answers ERROR_DATA_READ (Alchemist).
            state.vfCurve.push({ voltageV: pt.Voltage, freqMhz: pt.Frequency });
            state.vfCurveUnits = 'vf-curve-units-unverified';
          }
        }
      }
    }

    // Fan read-back (read-only here even when the EFFECTIVE canControl is
    // false - the A770 still reports config/state; setters stay gated).
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
              // Alchemist) - only PERCENT units become canonical % values.
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
      if (this._isUnavailable(lib.ctlGetSupported3DCapabilities) || this._isUnavailable(lib.ctlGetSet3DFeature)) {
        return this._graphicsDegraded();
      }
      const dev = await this._device(deviceId);
      const features = await this._graphicsCapsOf(deviceId, dev.handle);
      if (!features) return this._graphicsDegraded();

      const supported = {
        frameGen: features.has(CTL_3D_FEATURE.FRAME_GENERATION),
        flipModes: features.has(CTL_3D_FEATURE.GAMING_FLIP_MODES),
        frameLimit: features.has(CTL_3D_FEATURE.FRAME_LIMIT),
        lowLatency: features.has(CTL_3D_FEATURE.LOW_LATENCY),
      };
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
      const values = {
        frameGenOverride: supported.frameGen ? readEnum(CTL_3D_FEATURE.FRAME_GENERATION, GRAPHICS_FG_FROM_IGCL) : null,
        flipMode: supported.flipModes ? readEnum(CTL_3D_FEATURE.GAMING_FLIP_MODES, GRAPHICS_FLIP_FROM_IGCL) : null,
        frameLimit: null,
        lowLatency: supported.lowLatency ? readEnum(CTL_3D_FEATURE.LOW_LATENCY, GRAPHICS_LL_FROM_IGCL) : null,
      };
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

      return { supported, supportedOptions, frameLimitRange, values };
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
  async setGraphicsSettings(deviceId, settings = {}) {
    const lib = this._libOrThrow();
    const dev = await this._device(deviceId);
    const result = { ok: true, perControl: {} };
    const fail = (control, errorCode, message) => {
      result.perControl[control] = { ok: false, errorCode, message };
      result.ok = false;
    };
    const features = await this._graphicsCapsOf(deviceId, dev.handle);
    const surfaceUp = features !== null
      && !this._isUnavailable(lib.ctlGetSupported3DCapabilities)
      && !this._isUnavailable(lib.ctlGetSet3DFeature);
    const controls = ['frameGenOverride', 'flipMode', 'frameLimit', 'lowLatency']
      .filter((c) => settings[c] !== null && settings[c] !== undefined);
    if (!surfaceUp) {
      for (const c of controls) {
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
      const gs = encode3dFeatureGetset({ featureType, valueType: CTL_PROPERTY_VALUE_TYPE.ENUM, bSet: true, enumValue: igclValue });
      const setResult = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
      if (setResult !== CTL_RESULT.SUCCESS) {
        fail(control, igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
        return;
      }
      // Read-back verification (the plan's every-apply-verified rule).
      const rb = encode3dFeatureGetset({ featureType, valueType: CTL_PROPERTY_VALUE_TYPE.ENUM, bSet: false });
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
          // Never assume the caller's value is in range (backend contract):
          // clamp to the driver-reported range, snap to the step.
          const clamped = clampAndSnap(settings.frameLimit.value, range);
          const gs = encode3dFeatureGetset({
            featureType: CTL_3D_FEATURE.FRAME_LIMIT,
            valueType: CTL_PROPERTY_VALUE_TYPE.INT32,
            bSet: true,
            intEnable: settings.frameLimit.enabled === true,
            intValue: clamped,
          });
          const setResult = lib.ctlGetSet3DFeature(dev.handle, gs.buf);
          if (setResult !== CTL_RESULT.SUCCESS) {
            fail('frameLimit', igclErrorCode(setResult) ?? 'io-failed', `IGCL ${describeResult(setResult)}`);
          } else {
            const rb = encode3dFeatureGetset({ featureType: CTL_3D_FEATURE.FRAME_LIMIT, valueType: CTL_PROPERTY_VALUE_TYPE.INT32, bSet: false });
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
    if (settings.gpuLock
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
        fail('gpuLock', 'unsupported', 'GPU lock not supported on this device');
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
      const fan = fanHandles[0];

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

      const pct = (p) => ({ Size: koffi.sizeof('ctl_fan_speed_t'), Version: 0, speed: clampFanPct(p), units: FAN_UNITS_PERCENT });

      // Read-back verification for fan applies (plan §5: every apply is
      // followed by read-back verification). `expected.curve` is an array of
      // { t, speedPct } of the ROUNDED points that were sent; `expected.fixedPct`
      // is the rounded fixed speed. The mode must match the requested canonical
      // mode; table points / fixed speed are compared (within tolerance) when
      // the read-back reports PERCENT units - RPM values cannot be normalized
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
            return { ok: false, message: 'fan curve read-back is not in PERCENT units - cannot verify' };
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
    //     offset writes before the unlock;
    //   - neither (offsets only, or a lone lock/unlock): the historical
    //     order (offsets then lock).
    const hasLockPair = settings.gpuLock !== undefined && settings.gpuLock !== null;
    const lockIsUnlock = !hasLockPair || (settings.gpuLock.voltageV === 0 && settings.gpuLock.freqMhz === 0);
    const hasOffsetWrites = (settings.gpuVoltOffsetV !== undefined && settings.gpuVoltOffsetV !== null)
      || (settings.gpuFreqOffsetMhz !== undefined && settings.gpuFreqOffsetMhz !== null);
    if (!lockIsUnlock) {
      // The non-zero lock: zero-offset writes first, then the lock.
      await applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', 'gpuVoltOffset', settings.gpuVoltOffsetV);
      await applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', 'gpuFreqOffset', settings.gpuFreqOffsetMhz);
      await applyLock(settings.gpuLock);
    } else if (hasLockPair && hasOffsetWrites) {
      // The (0,0) unlock + offsets: the unlock first, then the offsets.
      await applyLock(settings.gpuLock);
      await applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', 'gpuVoltOffset', settings.gpuVoltOffsetV);
      await applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', 'gpuFreqOffset', settings.gpuFreqOffsetMhz);
    } else {
      await applyScalar('gpuVoltOffset', 'gpuVoltOffsetV', 'gpuVoltOffset', settings.gpuVoltOffsetV);
      await applyScalar('gpuFreqOffset', 'gpuFreqOffsetMhz', 'gpuFreqOffset', settings.gpuFreqOffsetMhz);
      if (hasLockPair) await applyLock(settings.gpuLock);
    }
    await applyFan();

    // vfCurve write path (Battlemage; not exercised in M1 on Alchemist).
    if (settings.vfCurve !== null && settings.vfCurve !== undefined) {
      if (!caps.controls.vfCurve || this._isUnavailable(lib.ctlOverclockWriteCustomVFCurve)) {
        fail('vfCurve', 'unsupported', 'custom VF curve not supported on this device');
      } else {
        // M17e (round-1 N9): ctl_voltage_frequency_point_t.Voltage is a
        // uint32 - a fractional volt (0.9) encodes into it by TRUNCATION
        // (~0): a uint32 truncation must NEVER silently write 0. The scale
        // is unverified (the same mV-vs-V hazard the lock API proved), so
        // the honest gate refuses non-INTEGER volts - integer volts are the
        // only values representable in the field regardless of the scale.
        const nonInteger = settings.vfCurve.filter((p) => !Number.isInteger(p.voltageV));
        if (nonInteger.length > 0) {
          fail('vfCurve', 'out-of-range', `VF curve voltages must be whole volts - the ctl_voltage_frequency_point_t.Voltage field is a uint32 (a fractional volt would truncate to 0) and its unit is unverified on this device`);
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
                    // M17e (finding 4): the raw uint32 is NEVER labeled as V
                    // (the units are unverified - N9) - the message labels the
                    // read-back honestly as the raw field value.
                    if (!nearlyEqual(pt.Voltage, want.Voltage, 1e-6) || !nearlyEqual(pt.Frequency, want.Frequency, 1e-6)) {
                      v = { ok: false, message: `VF curve point ${i} read-back ${pt.Voltage} (raw uint32, units unverified) / ${pt.Frequency} MHz != requested ${want.Voltage} V / ${want.Frequency} MHz` };
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
