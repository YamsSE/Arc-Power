// Arc Power - M2C-C bundled 2023 IGCL runtime (extended-range unlock).
//
// The DriverStore IGCL runtime (v1.2.x) clamps OC writes CLIENT-SIDE: the
// power limit is refused above 252 W (0x44000004) and the temp limit above
// 90 C (0x44000005) for any zero-UID client. The bundled 2023 runtime
// (IntelControlLib.dll v1.0.100, from the Arc OC Tool distribution - see
// THIRD_PARTY_NOTICES.txt) + AppVersion 1.0 + zero UID + waiver + ELEVATION
// writes 280/300/315 W and 100/110/115 C - SUCCESS and PERSISTED (verified
// live on this machine, 2026-08-05, docs/igcl-integration.md §8c).
//
// This module is the ONLY product-code consumer of that DLL. It uses the V1
// fixed-unit setters (ctlOverclockPowerLimitSet = mW,
// ctlOverclockTemperatureLimitSet = C), the 2023-era init args (Size 36,
// Version 0, AppVersion MAKE_VERSION(1,0), CTL_INIT_FLAG_USE_LEVEL_ZERO,
// zero UID) and the 2023-era properties struct (ctl_oc_properties_old_t).
//
// Verification lesson (the momentary lie): non-elevated OC writes return
// SUCCESS with a momentary read-back match and then revert. Every setter
// here therefore ALWAYS re-reads once after ~400 ms before reporting ok -
// an immediate match is never trusted on this runtime (the lie's shape is
// match-then-revert); a delayed match is a real persisted write, a mismatch
// (immediate or delayed) is an honest per-control failure. The DriverStore
// runtime keeps its immediate-only verification (elevated persistence is
// live-proven for it, docs/igcl-integration.md §8c).
//
// Safety ceilings (verified on the A770, KMD-refused above these):
//   315 W power limit, 115 C temp limit - never exceeded here.
//
// Electron-free so tests run under plain `node --test` (koffi lib injected).

import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CTL_INIT_FLAG_USE_LEVEL_ZERO, CTL_RESULT, loadIgcl, makeVersion, describeResult,
} from './backend/igcl-bindings.js';
import { igclErrorCode } from './backend/backend.interface.js';
import { clampAndSnap, nearlyEqual, deviceHardwareKey, sortDevicesDiscreteFirst } from './backend/units.js';

export const OLD_IGCL_VERSION = '1.0.100';
export const OLD_IGCL_FILENAME = 'IntelControlLib.dll';

// Verified ceilings (docs/igcl-integration.md §8c): the KMD accepts 315 W
// and 115 C; 125 C clamps to 115. These are the ONLY extended range bounds
// the old runtime ever writes.
// M3-C-D: the exposed extended PL ceiling. LIVE-VERIFIED 2026-08-06:
// 400/350/330 W are refused by the runtime (0x44000004), 315 W persists -
// 315 W IS the ceiling on this card. Requests above it are refused honestly
// (never clamped) - the refusal regression test pins that.
export const EXTENDED_PL_MAX_W = 315;
export const EXTENDED_PL_MIN_W = 105;
export const EXTENDED_TL_MAX_C = 115;
export const EXTENDED_TL_MIN_C = 60;
export const EXTENDED_STEP = 1;

// The momentary-lie guard: re-read once after this delay when the immediate
// read-back does not match.
export const DELAYED_VERIFY_MS = 400;

export const EXTENDED_PL_RANGE = Object.freeze({ min: EXTENDED_PL_MIN_W, max: EXTENDED_PL_MAX_W, step: EXTENDED_STEP });
export const EXTENDED_TL_RANGE = Object.freeze({ min: EXTENDED_TL_MIN_C, max: EXTENDED_TL_MAX_C, step: EXTENDED_STEP });

const ZERO_UID = { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] };

// 2023-era ctl_oc_properties_t (igcl repo ~v109/v127): 6 controls, Size 296,
// Version 0. Uses the ctl_oc_control_info_t layout already defined by
// igcl-bindings.js. Read for diagnostics only - never gates anything (the
// verified probes prove init/enum/waiver/V1 writes work without it).
koffi.struct('ctl_oc_properties_old_t', {
  Size: 'uint32',
  Version: 'uint8',
  bSupported: 'bool',
  gpuFrequencyOffset: 'ctl_oc_control_info_t',
  gpuVoltageOffset: 'ctl_oc_control_info_t',
  vramFrequencyOffset: 'ctl_oc_control_info_t',
  vramVoltageOffset: 'ctl_oc_control_info_t',
  powerLimit: 'ctl_oc_control_info_t',
  temperatureLimit: 'ctl_oc_control_info_t',
}); // 296 bytes, align 8

const OLD_PROPS_EXPECTED_SIZE = 296;

/**
 * Layout sanity for the 2023-era properties struct (N2): assert the koffi
 * layout once at CONSTRUCTION (the load/isCapable path) so a koffi version
 * change fails at the first real use - never at module import, which runs
 * in every mode (incl. headless/mock) even when the old runtime is never
 * loaded. `sizeofFn` is injectable for tests.
 * @param {(name: string) => number} sizeofFn
 */
export function checkOldPropsSize(sizeofFn = (name) => koffi.sizeof(name)) {
  const actual = sizeofFn('ctl_oc_properties_old_t');
  if (actual !== OLD_PROPS_EXPECTED_SIZE) {
    throw new Error(`Layout mismatch: koffi sizeof(ctl_oc_properties_old_t) = ${actual}, expected ${OLD_PROPS_EXPECTED_SIZE}`);
  }
  return actual;
}

/** W -> mW (the V1 power-limit unit contract is fixed mW). */
export function wToMw(w) {
  return w * 1000;
}

/** mW -> W. */
export function mwToW(mw) {
  return mw / 1000;
}

/**
 * Locate the vendored 2023 runtime DLL. Packaged apps keep it in
 * resources/app.asar.unpacked (asarUnpack - native DLLs cannot load from
 * inside the asar archive); dev runs read the repo copy.
 * @returns {string}
 */
export function oldIgclDllPath() {
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'main', 'backend', 'igcl2023', OLD_IGCL_FILENAME);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  return fileURLToPath(new URL('./backend/igcl2023/IntelControlLib.dll', import.meta.url));
}

/**
 * Old-runtime per-control result (same shape as the backend perControl
 * entries so the routed apply core can merge them 1:1).
 * @typedef {{ ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean, silentNoop?: boolean }} OldIgclPerControl
 */

/**
 * The bundled-2023-runtime adapter. Lazy-initialized; `isCapable()` runs the
 * init/enum/waiver sequence exactly once (the extendedCapable gate). The
 * setters write only extended values (>252 W / >90 C) through the V1 API
 * with the delayed re-read verification.
 */
export class OldIgcl {
  /**
   * @param {{
   *   dllPath?: string|null,       // override discovery (tests)
   *   lib?: object|null,           // injected bound lib (tests); loaded at init otherwise
   *   findDll?: () => string|null, // injectable discovery (tests)
   *   delayedVerifyMs?: number,    // momentary-lie re-read delay (default 400)
   *   sleep?: (ms: number) => Promise<void>,
   * }} opts
   */
  constructor(opts = {}) {
    // N2: the 2023-era struct layout assert runs at construction (the load
    // path) - module import never throws, in any mode.
    checkOldPropsSize();
    this._dllPath = opts.dllPath ?? null;
    this._lib = opts.lib ?? null;
    this._findDll = opts.findDll ?? oldIgclDllPath;
    this._delayedVerifyMs = opts.delayedVerifyMs ?? DELAYED_VERIFY_MS;
    this._sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this._apiHandle = null;
    this._device = null;
    this._devices = [];
    this._identityAvailable = false;
    this._waivedDevices = new Set();
    this._setQueue = Promise.resolve();
    this._capable = null; // tri-state: null = unknown
    this._tempCapable = null; // cached V1 temperature-symbol capability
    this._lastError = null;
    this._props = null;
    // CONCURRENTLY (the boot warm-up + the first caps query + a boot-apply
    // all race for the same probe). The first caller owns the init/enum/
    // waiver sequence; every concurrent caller awaits the SAME promise -
    // the 2023 runtime is never ctlInit'd twice in one process.
    this._capablePromise = null;
    this._tempCapablePromise = null;
  }

  get lastError() {
    return this._lastError;
  }

  /**
   * Whether the V1 temperature writer is usable. This deliberately requires
   * the initialized runtime plus BOTH temperature symbols; the power
   * capability probe is not sufficient because some bundled runtimes expose
   * only the power APIs.
   * @returns {Promise<boolean>}
   */
  async isTempCapable() {
    if (this._tempCapable !== null) return this._tempCapable;
    if (!this._tempCapablePromise) {
      this._tempCapablePromise = (async () => {
        try {
          // Share the capability probe's readiness promise. Calling
          // _ensureReady() directly here can overlap isCapable() during
          // startup and issue duplicate ctlInit/enumeration/waiver calls;
          // that race can falsely hide the working 115 C V1 path.
          if (!(await this.isCapable())) {
            this._tempCapable = false;
            return this._tempCapable;
          }
          this._tempCapable = typeof this._lib?.ctlOverclockTemperatureLimitGet === 'function'
            && typeof this._lib?.ctlOverclockTemperatureLimitSet === 'function';
        } catch (err) {
          this._tempCapable = false;
          this._lastError = err.message;
        }
        return this._tempCapable;
      })();
    }
    return this._tempCapablePromise;
  }

  /**
   * Whether the bundled runtime is installed, independent of whether this
   * process can initialize it. The UI process can be unelevated while the
   * elevated apply worker owns the actual V1 write.
   * @returns {boolean}
   */
  isAvailable() {
    const dllPath = this._dllPath ?? this._findDll();
    return typeof dllPath === 'string' && dllPath.length > 0 && fs.existsSync(dllPath);
  }


  /**
   * extendedCapable(): init + enumerate + waiver all SUCCESS on the bundled
   * runtime. Cached; a failure sets `_capable = false` forever (the old
   * runtime either works on this driver or it does not).
   * @returns {Promise<boolean>}
   */
  async isCapable() {
    if (this._capable !== null) return this._capable;
    if (!this._capablePromise) {
      this._capablePromise = (async () => {
        try {
          await this._ensureReady();
          this._capable = true;
        } catch (err) {
          this._capable = false;
          this._lastError = err.message;
        }
        return this._capable;
      })();
    }
    return this._capablePromise;
  }

  async _ensureReady() {
    if (this._device) return;
    if (!this._lib) {
      this._dllPath = this._dllPath ?? this._findDll();
      if (!this._dllPath || !fs.existsSync(this._dllPath)) {
        throw new Error(`bundled 2023 IGCL runtime not found (${this._dllPath ?? 'no path'}) - see THIRD_PARTY_NOTICES.txt`);
      }
      this._lib = loadIgcl(this._dllPath);
    }
    if (typeof this._lib.ctlInit !== 'function') {
      throw new Error('bundled 2023 IGCL runtime has no ctlInit symbol');
    }
    const initArgs = koffi.alloc('ctl_init_args_t', 1);
    koffi.encode(initArgs, 'ctl_init_args_t', {
      Size: 36,
      Version: 0,
      AppVersion: makeVersion(1, 0),
      flags: CTL_INIT_FLAG_USE_LEVEL_ZERO,
      SupportedVersion: 0,
      ApplicationUID: ZERO_UID,
    });
    const apiBuf = koffi.alloc('void*', 1);
    const initRes = this._lib.ctlInit(initArgs, apiBuf);
    if (initRes !== CTL_RESULT.SUCCESS) {
      throw new Error(`bundled 2023 IGCL runtime init failed: ${describeResult(initRes)}`);
    }
    this._apiHandle = koffi.decode(apiBuf, 0, 'void*');
    if (!this._apiHandle) throw new Error('bundled 2023 IGCL runtime ctlInit returned SUCCESS but the handle is NULL');

    // Enumerate - the old runtime needs the two-pass pattern like any IGCL
    // runtime: count with a null list, then fill. Keep every raw handle and,
    // when the property binding exists, derive the same PCI/BDF identity used
    // by the main backend before applying the stable discrete-first order.
    const countBuf = koffi.alloc('uint32', 1);
    koffi.encode(countBuf, 'uint32', 0);
    let res = this._lib.ctlEnumerateDevices(this._apiHandle, countBuf, null);
    const count = res === CTL_RESULT.SUCCESS ? koffi.decode(countBuf, 'uint32') : 0;
    if (count <= 0) throw new Error(`bundled 2023 IGCL runtime enumerated ${count} devices (${describeResult(res)})`);
    const list = koffi.alloc('void*', count);
    koffi.encode(countBuf, 'uint32', count);
    res = this._lib.ctlEnumerateDevices(this._apiHandle, countBuf, list);
    if (res !== CTL_RESULT.SUCCESS) {
      throw new Error(`bundled 2023 IGCL runtime device enumeration failed: ${describeResult(res)}`);
    }
    const rawHandles = [];
    for (let i = 0; i < count; i++) rawHandles.push(koffi.decode(list, i * 8, 'void*'));

    const getProperties = this._lib.ctlGetDeviceProperties;
    const entries = [];
    let identityAvailable = typeof getProperties === 'function';
    if (identityAvailable) {
      for (const handle of rawHandles) {
        let identity = null;
        try {
          const propsBuf = koffi.alloc('ctl_device_adapter_properties_t', 1);
          koffi.encode(propsBuf, 'ctl_device_adapter_properties_t', {
            Size: koffi.sizeof('ctl_device_adapter_properties_t'),
            Version: 0,
          });
          const propertyRes = getProperties(handle, propsBuf);
          if (propertyRes === CTL_RESULT.SUCCESS) {
            const p = koffi.decode(propsBuf, 'ctl_device_adapter_properties_t');
            const bdf = p.adapter_bdf;
            const name = String(p.name ?? '').replace(/\0+$/, '').trim();
            const candidate = {
              name,
              pciVendorId: `0x${(Number(p.pci_vendor_id) >>> 0).toString(16).padStart(8, '0')}`,
              pciDeviceId: `0x${(Number(p.pci_device_id) >>> 0).toString(16).padStart(8, '0')}`,
              bdf: {
                bus: Number(bdf?.bus),
                device: Number(bdf?.device),
                function: Number(bdf?.function),
              },
            };
            if (name.length > 0 && Number.isFinite(candidate.bdf.bus)
              && Number.isFinite(candidate.bdf.device)
              && Number.isFinite(candidate.bdf.function)) {
              identity = { ...candidate, deviceKey: deviceHardwareKey(candidate) };
            }
          }
        } catch {
          identity = null;
        }
        if (!identity) identityAvailable = false;
        entries.push({ handle, identity });
      }
    } else {
      for (const handle of rawHandles) entries.push({ handle, identity: null });
    }
    this._identityAvailable = identityAvailable;
    const ordered = identityAvailable
      ? sortDevicesDiscreteFirst(entries.map((entry) => entry.identity))
        .map((identity) => entries.find((entry) => entry.identity === identity))
      : entries;
    this._devices = ordered;
    this._device = ordered[0]?.handle ?? null;
    if (!this._device) throw new Error('bundled 2023 IGCL runtime returned a NULL device handle');
    await this._ensureWaiver(this._device, ordered[0]?.identity?.deviceKey ?? 'primary');

    // Diagnostics-only props read (2023 struct). Never gates: the verified
    // probes write without reading props.
    try {
      const propsBuf = koffi.alloc('ctl_oc_properties_old_t', 1);
      koffi.encode(propsBuf, 'ctl_oc_properties_old_t', { Size: OLD_PROPS_EXPECTED_SIZE, Version: 0 });
      const pr = this._lib.ctlOverclockGetProperties(this._device, propsBuf);
      if (pr === CTL_RESULT.SUCCESS) {
        this._props = koffi.decode(propsBuf, 'ctl_oc_properties_old_t');
      }
    } catch {
      this._props = null;
    }
  }

  async _ensureWaiver(device, key = 'primary') {
    const waiverKey = key ?? 'primary';
    if (this._waivedDevices.has(waiverKey)) return true;
    const waiverRes = this._lib.ctlOverclockWaiverSet(device);
    if (waiverRes !== CTL_RESULT.SUCCESS) {
      throw new Error(`bundled 2023 IGCL runtime waiver failed: ${describeResult(waiverRes)}`);
    }
    this._waivedDevices.add(waiverKey);
  }

  async _selectDevice(deviceId, deviceKey) {
    const hasKey = typeof deviceKey === 'string' && deviceKey.length > 0;
    if (!hasKey) {
      if (deviceId != null && deviceId !== 0) return null;
      // Legacy primary behavior remains safe for a single raw handle. With
      // multiple handles, an unbound property API cannot prove even id 0 is
      // the main-backend primary, so refuse before any native write.
      if (!this._identityAvailable && this._devices.length > 1) return null;
      return this._devices[0] ?? null;
    }
    // A keyed request is identity-sensitive. Older bundled runtimes without
    // ctlGetDeviceProperties cannot prove which raw handle is the target.
    if (!this._identityAvailable) return null;
    const selected = this._devices.find((entry) => entry.identity?.deviceKey === deviceKey);
    if (!selected) return null;
    try {
      await this._ensureWaiver(selected.handle, selected.identity.deviceKey);
    } catch {
      return null;
    }
    this._device = selected.handle;
    return selected;
  }

  _read(control, device = this._device) {
    const getFn = control === 'powerLimitW' ? this._lib.ctlOverclockPowerLimitGet : this._lib.ctlOverclockTemperatureLimitGet;
    const buf = koffi.alloc('double', 1);
    const res = getFn(device, buf);
    if (res !== CTL_RESULT.SUCCESS) return null;
    const raw = koffi.decode(buf, 'double');
    return control === 'powerLimitW' ? mwToW(raw) : raw;
  }


  /**
   * One extended write with the momentary-lie guard. Target selection,
   * waiver, native write, and both reads are serialized per adapter instance
   * so concurrent applies cannot cross handles through `this._device`.
   * @param {'powerLimitW'|'tempLimitC'} control
   * @param {number} value canonical W or C
   * @param {number|undefined|null} deviceId
   * @param {string|undefined|null} deviceKey stable PCI/BDF identity
   * @returns {Promise<OldIgclPerControl>}
   */
  async _setScalar(control, value, deviceId = 0, deviceKey = null) {
    const run = this._setQueue.then(() => this._setScalarLocked(control, value, deviceId, deviceKey));
    this._setQueue = run.catch(() => {});
    return run;
  }

  async _setScalarLocked(control, value, deviceId = 0, deviceKey = null) {
    if (control === 'tempLimitC' ? !(await this.isTempCapable()) : !(await this.isCapable())) {
      return {
        ok: false,
        errorCode: 'unsupported',
        readBackEqual: false,
        message: 'extended power/temp limit requires the bundled 2023 IGCL runtime - it failed to load on this driver',
      };
    }
    const selected = await this._selectDevice(deviceId, deviceKey);
    if (!selected) {
      return {
        ok: false,
        errorCode: 'unsupported',
        readBackEqual: false,
        message: typeof deviceKey === 'string' && deviceKey.length > 0
          ? 'extended power/temp limit cannot establish the requested PCI/BDF target with the bundled 2023 IGCL runtime'
          : 'extended power/temp limit cannot target a non-primary device with the bundled 2023 IGCL runtime',
      };
    }
    const range = control === 'powerLimitW' ? EXTENDED_PL_RANGE : EXTENDED_TL_RANGE;
    const target = clampAndSnap(value, range);
    const setFn = control === 'powerLimitW' ? this._lib.ctlOverclockPowerLimitSet : this._lib.ctlOverclockTemperatureLimitSet;
    const igclValue = control === 'powerLimitW' ? wToMw(target) : target;
    const setRes = setFn(this._device, igclValue);
    if (setRes !== CTL_RESULT.SUCCESS) {
      return {
        ok: false,
        errorCode: igclErrorCode(setRes) ?? 'io-failed',
        readBackEqual: false,
        message: `IGCL ${describeResult(setRes)}`,
      };
    }
    this._read(control);
    await this._sleep(this._delayedVerifyMs);
    const readBack = this._read(control);
    if (readBack !== null && nearlyEqual(readBack, target)) {
      return { ok: true, readBackEqual: true };
    }
    const label = control === 'powerLimitW' ? 'power limit' : 'temperature limit';
    return {
      ok: false,
      errorCode: 'io-failed',
      readBackEqual: false,
      message: readBack === null
        ? `extended ${label}: set succeeded but read-back failed`
        : `extended ${label}: read-back ${readBack} != requested ${target}`,
    };
  }

  /**
   * Extended power/temperature limits. The optional deviceId and stable
   * deviceKey are accepted by the shared apply-routing seam. A keyed target
   * is selected by PCI/BDF identity; a runtime without property binding
   * refuses keyed requests rather than risking a write to another adapter.
   * Writes only values above the DriverStore clamp; routing guarantees that.
   * @param {number} value
   * @param {number|undefined|null} deviceId
   * @param {string|undefined|null} deviceKey
   * @returns {Promise<OldIgclPerControl>}
   */
  async setPowerLimitW(w, deviceId = 0, deviceKey = null) {
    return this._setScalar('powerLimitW', w, deviceId, deviceKey);
  }

  async setTempLimitC(c, deviceId = 0, deviceKey = null) {
    return this._setScalar('tempLimitC', c, deviceId, deviceKey);
  }

  async close() {
    if (this._apiHandle && this._lib && typeof this._lib.ctlClose === 'function') {
      try { this._lib.ctlClose(this._apiHandle); } catch { /* best effort */ }
    }
    this._apiHandle = null;
    this._device = null;
  }
}
