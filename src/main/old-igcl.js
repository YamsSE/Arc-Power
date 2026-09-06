// Arc Power - M2C-C bundled 2023 IGCL runtime (extended-range unlock).
//
// The DriverStore IGCL runtime clamps OC writes CLIENT-SIDE: the power limit
// is refused above 252 W (0x44000004) and the temp limit above 90 C
// (0x44000005). The bundled 2023 runtime (IntelControlLib.dll v1.0.100,
// from the Arc OC Tool distribution - see THIRD_PARTY_NOTICES.txt) writes
// 280/300/315 W and 100/110/115 C when initialized with a supported
// application UID + AppVersion 1.0 + waiver + elevation.
//
// This module is the ONLY product-code consumer of that DLL. It uses the V1
// fixed-unit setters (ctlOverclockPowerLimitSet = mW,
// ctlOverclockTemperatureLimitSet = C), the 2023-era init args (Size 36,
// Version 0, AppVersion MAKE_VERSION(1,0), CTL_INIT_FLAG_USE_LEVEL_ZERO,
// zero UID with the registered ArcTool UID fallback) and the 2023-era
// properties struct (ctl_oc_properties_old_t).
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
// M3-C-D: the exposed extended PL ceiling. LIVE-VERIFIED 2026-08-06:
// 400/350/330 W are refused by the runtime (0x44000004), 315 W persists -
// 315 W IS the ceiling on this card. Requests above it are refused honestly
// (never clamped) - the refusal regression test pins that.
// M50: the active DriverStore package observed on this product rejects V1
// temperatures above 90 C with ERROR_INVALID_ARGUMENT, even though the
// bundled runtime advertises the historical 115 C shape. Keep the bundled
// write range intact so the native result can be surfaced honestly.
export const DRIVER_TEMP_LIMIT_MAX_C = 90;
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
// ArcTool's bundled runtime registers this application UID. Newer driver
// packages can reject the zero UID with ERROR_KMD_CALL even though the same
// runtime accepts the registered ArcTool identity and its extended controls.
const ARC_TOOL_UID = {
  Data1: 0xe8e10f95,
  Data2: 0x1a70,
  Data3: 0x4b27,
  Data4: [0x9c, 0xcf, 0x02, 0x01, 0x02, 0x64, 0xe9, 0xc8],
};
function normalizePciId(value) {
  const text = String(value ?? '').trim().replace(/^0x/i, '').toLowerCase();
  return /^[0-9a-f]+$/.test(text) ? text.slice(-4).padStart(4, '0') : null;
}

function pciIdsFromTargetKey(deviceKey) {
  if (typeof deviceKey !== 'string') return null;
  const pnp = deviceKey.match(/^pnp:.*?\bVEN_([0-9a-f]{4}).*?\bDEV_([0-9a-f]{4})/i);
  if (pnp) return { vendor: pnp[1].toLowerCase(), device: pnp[2].toLowerCase() };
  const pci = deviceKey.match(/^pci:([^:]+):([^@]+)@/i);
  if (!pci) return null;
  const vendor = normalizePciId(pci[1]);
  const device = normalizePciId(pci[2]);
  return vendor && device ? { vendor, device } : null;
}

/**
 * Normalize the BDF shapes that cross the parent -> worker boundary.  The
 * old IGCL properties API returns an object while the unified inventory sends
 * the canonical `domain:bus:device.function` string.  Keep the comparison
 * physical and lossless; never use an adapter ordinal as a fallback.
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeBdf(value) {
  if (typeof value === 'string') {
    const match = value.trim().match(/^(?:([0-9a-f]{1,4}):)?([0-9a-f]{1,2}):([0-9a-f]{1,2})\.([0-7])$/i);
    if (!match) return null;
    return `${Number.parseInt(match[1] ?? '0', 16).toString(16).padStart(4, '0')}:${Number.parseInt(match[2], 16).toString(16).padStart(2, '0')}:${Number.parseInt(match[3], 16).toString(16).padStart(2, '0')}.${match[4]}`;
  }
  if (!value || typeof value !== 'object') return null;
  const bdf = /** @type {{ domain?: unknown, segment?: unknown, bus?: unknown, device?: unknown, function?: unknown, func?: unknown }} */ (value);
  const domain = Number(bdf.domain ?? bdf.segment ?? 0);
  const bus = Number(bdf.bus);
  const device = Number(bdf.device);
  const fn = Number(bdf.function ?? bdf.func ?? 0);
  if (![domain, bus, device, fn].every(Number.isInteger)
    || domain < 0 || bus < 0 || device < 0 || fn < 0) return null;
  return `${domain.toString(16).padStart(4, '0')}:${bus.toString(16).padStart(2, '0')}:${device.toString(16).padStart(2, '0')}.${fn}`;
}


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
    const apiBuf = koffi.alloc('void*', 1);
    koffi.encode(initArgs, 'ctl_init_args_t', {
      Size: 36,
      Version: 0,
      AppVersion: makeVersion(1, 0),
      flags: CTL_INIT_FLAG_USE_LEVEL_ZERO,
      SupportedVersion: 0,
      ApplicationUID: ZERO_UID,
    });
    let initRes = this._lib.ctlInit(initArgs, apiBuf);
    // The bundled ArcTool runtime on newer driver packages rejects the
    // zero UID with ERROR_KMD_CALL/ERROR_UNKNOWN_APPLICATION_UID, although
    // its registered ArcTool UID is accepted and unlocks the V1 115 C
    // temperature path. Keep zero-UID behavior first for older runtimes,
    // then use the known registered identity only for this failure.
    if (initRes === CTL_RESULT.ERROR_KMD_CALL || initRes === CTL_RESULT.ERROR_UNKNOWN_APPLICATION_UID) {
      koffi.encode(initArgs, koffi.offsetof('ctl_init_args_t', 'ApplicationUID'), 'ctl_application_id_t', ARC_TOOL_UID);
      initRes = this._lib.ctlInit(initArgs, apiBuf);
    }
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

  async _selectDevice(deviceId, deviceKey, physicalTarget = null) {
    // M163: resolve the parent-provided physical proof before any legacy
    // primary/device-id shortcut. The proof is the only safe selector when
    // the unified inventory has no durable key or when the two runtimes
    // enumerate adapters in different orders.
    const proofBdf = normalizeBdf(physicalTarget?.bdf ?? physicalTarget?.controllerBdf);
    const proofVendor = normalizePciId(physicalTarget?.pciVendorId);
    const proofDevice = normalizePciId(physicalTarget?.pciDeviceId);
    const proofMatches = proofBdf
      ? this._devices.filter((entry) => {
          const identity = entry.identity;
          if (!identity || normalizeBdf(identity.bdf) !== proofBdf) return false;
          if (proofVendor && normalizePciId(identity.pciVendorId) !== proofVendor) return false;
          if (proofDevice && normalizePciId(identity.pciDeviceId) !== proofDevice) return false;
          return true;
        })
      : [];
    if (proofBdf) {
      let selected = proofMatches.length === 1 ? proofMatches[0] : null;
      // M164: the bundled 2023 runtime used on this driver can expose a
      // zeroed adapter_bdf for every handle, while the parent backend has a
      // real BDF from Windows. In that shape the BDFs cannot agree, but a
      // unique PCI vendor/device pair still identifies the physical adapter.
      // Permit that fallback only when every legacy identity has an unknown
      // BDF; if the legacy runtime exposes any real BDF, a mismatch remains a
      // hard refusal so an identical card is never guessed by ordinal.
      if (!selected && proofVendor && proofDevice) {
        const pciMatches = this._devices.filter((entry) => entry.identity
          && normalizePciId(entry.identity.pciVendorId) === proofVendor
          && normalizePciId(entry.identity.pciDeviceId) === proofDevice);
        const legacyBdfUnavailable = this._devices.length > 0
          && this._devices.every((entry) => normalizeBdf(entry.identity?.bdf) === null
            || normalizeBdf(entry.identity?.bdf) === '0000:00:00.0');
        if (legacyBdfUnavailable && pciMatches.length === 1) selected = pciMatches[0];
      }
      if (!selected || !selected.identity) return null;
      try {
        await this._ensureWaiver(selected.handle, selected.identity.deviceKey);
      } catch {
        return null;
      }
      this._device = selected.handle;
      return selected;
    }

    const hasKey = typeof deviceKey === 'string' && deviceKey.length > 0;
    if (!hasKey) {
      if (deviceId != null && deviceId !== 0) return null;
      // Legacy primary behavior remains safe for a single raw handle. With
      // multiple handles, an unbound property API cannot prove even id 0 is
      // the main-backend primary, so refuse before any native write.
      if (!this._identityAvailable && this._devices.length > 1) return null;
      return this._devices[0] ?? null;
    }
    // The parent inventory now uses a PNP-first durable key. The bundled
    // runtime exposes only PCI vendor/device properties on this driver, and
    // some runtimes expose those properties for only a subset of enumerated
    // handles. Accept a PNP key when exactly one known legacy identity has
    // the same PCI pair; never guess between duplicate adapters.
    // M163: the parent proof is authoritative when the unified inventory
    // key and the old runtime's enumeration disagree. This is the failure
    // mode that made an Alchemist advanced PL/TL write hit the other GPU and
    // return ERROR_INVALID_ARGUMENT/read-back differences. Select by the
    // exact physical BDF + PCI pair first; never let an ordinal or a cached
    // primary handle win on a multi-GPU system.
    const exact = this._devices.find((entry) => entry.identity?.deviceKey === deviceKey);
    const pci = exact ? null : pciIdsFromTargetKey(deviceKey);
    const pciMatches = pci
      ? this._devices.filter((entry) => entry.identity
        && normalizePciId(entry.identity.pciVendorId) === pci.vendor
        && normalizePciId(entry.identity.pciDeviceId) === pci.device)
      : [];
    const selected = exact ?? (pciMatches.length === 1 ? pciMatches[0] : null);
    // A keyed request is identity-sensitive. Older bundled runtimes without
    // any usable property identity still cannot prove the requested handle.
    if (!selected || !selected.identity) return null;
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
   * @param {object|null} physicalTarget parent-validated physical proof
   * @returns {Promise<OldIgclPerControl>}
   */
  async _setScalar(control, value, deviceId = 0, deviceKey = null, physicalTarget = null) {
    const run = this._setQueue.then(() => this._setScalarLocked(control, value, deviceId, deviceKey, physicalTarget));
    this._setQueue = run.catch(() => {});
    return run;
  }

  async _setScalarLocked(control, value, deviceId = 0, deviceKey = null, physicalTarget = null) {
    if (control === 'tempLimitC' ? !(await this.isTempCapable()) : !(await this.isCapable())) {
      return {
        ok: false,
        errorCode: 'unsupported',
        readBackEqual: false,
        message: 'extended power/temp limit requires the bundled 2023 IGCL runtime - it failed to load on this driver',
      };
    }
    const selected = await this._selectDevice(deviceId, deviceKey, physicalTarget);
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
    const targetHandle = selected.handle;
    const setRes = setFn(targetHandle, igclValue);
    if (setRes !== CTL_RESULT.SUCCESS) {
      const temperatureRangeRefusal = control === 'tempLimitC'
        && target > DRIVER_TEMP_LIMIT_MAX_C
        && setRes === CTL_RESULT.ERROR_INVALID_ARGUMENT;
      return {
        ok: false,
        // ERROR_INVALID_ARGUMENT is a capability/refusal for this native
        // temperature route once target selection has succeeded; classify it
        // as a refusal instead of a misleading target/contract failure.
        errorCode: temperatureRangeRefusal ? 'out-of-range' : (igclErrorCode(setRes) ?? 'io-failed'),
        readBackEqual: false,
        ...(temperatureRangeRefusal ? { capabilityCeiling: DRIVER_TEMP_LIMIT_MAX_C } : {}),
        message: temperatureRangeRefusal
          ? `Intel graphics driver/runtime rejected ${target} °C; this active runtime supports temperature limits up to ${DRIVER_TEMP_LIMIT_MAX_C} °C (native IGCL ERROR_INVALID_ARGUMENT). Nothing was changed.`
          : `IGCL ${describeResult(setRes)}`,
      };
    }
    this._read(control, targetHandle);
    await this._sleep(this._delayedVerifyMs);
    const readBack = this._read(control, targetHandle);
    if (readBack !== null && nearlyEqual(readBack, target)) {
      return { ok: true, readBackEqual: true, readBackValue: readBack };
    }
    // The bundled Alchemist getter is not an authoritative extended
    // temperature surface. On affected driver packages it can return the
    // stock 90 C ceiling after a successful 100/115 C write (and other
    // packages return the documented zero sentinel or no value at all).
    // ctlOverclockTemperatureLimitSet already returned SUCCESS, so a
    // post-write temperature mismatch is an unavailable read-back, not an
    // honest write refusal. Keep the distinction explicit: the native setter
    // refusal above remains the only failure gate for this extended route.
    const extendedTemperatureSentinel = control === 'tempLimitC'
      && target >= DRIVER_TEMP_LIMIT_MAX_C
      && (readBack === null || readBack === 0 || readBack === DRIVER_TEMP_LIMIT_MAX_C);
    if (extendedTemperatureSentinel) {
      return {
        ok: true,
        // Retain the historical true value for old callers that only use
        // this flag as an apply-success gate; readBackUnavailable is the
        // authoritative distinction for current UI/state consumers.
        readBackEqual: true,
        readBackUnavailable: true,
        readBackSentinel: readBack,
        message: 'extended temperature limit accepted; bundled driver read-back unavailable',
      };
    }
    const label = control === 'powerLimitW' ? 'power limit' : 'temperature limit';
    return {
      ok: false,
      errorCode: 'io-failed',
      readBackEqual: false,
      // Presence of this field marks a bundled-runtime read-back attempt,
      // including a finite mismatch. The routed layer must not replace that
      // authoritative result with the unrelated DriverStore surface.
      readBackValue: readBack,
      message: readBack === null
        ? `extended ${label}: set succeeded but read-back failed`
        : `extended ${label}: read-back ${readBack} != requested ${target}`,
    };
  }

  /**
   * Extended power/temperature limits. The optional deviceId and stable
   * deviceKey are accepted by the shared apply-routing seam. A keyed target
   * is selected by exact PCI/BDF identity or a unique PNP vendor/device pair;
   * a runtime without any usable property identity refuses keyed requests
   * rather than risking a write to another adapter.
   * Writes only values above the DriverStore clamp; routing guarantees that.
   * @param {number} value
   * @param {number|undefined|null} deviceId
   * @param {string|undefined|null} deviceKey
   * @param {object|null} physicalTarget parent-validated physical proof
   * @returns {Promise<OldIgclPerControl>}
   */
  async setPowerLimitW(w, deviceId = 0, deviceKey = null, physicalTarget = null) {
    return this._setScalar('powerLimitW', w, deviceId, deviceKey, physicalTarget);
  }

  async setTempLimitC(c, deviceId = 0, deviceKey = null, physicalTarget = null) {
    return this._setScalar('tempLimitC', c, deviceId, deviceKey, physicalTarget);
  }

  async close() {
    if (this._apiHandle && this._lib && typeof this._lib.ctlClose === 'function') {
      try { this._lib.ctlClose(this._apiHandle); } catch { /* best effort */ }
    }
    this._apiHandle = null;
    this._device = null;
  }
}
