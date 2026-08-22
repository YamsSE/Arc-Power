// Arc Power - M2b Level Zero Sysman koffi bindings (the IGS-independent OC
// experiment). Transcribed from the official Level Zero headers, pinned to
// oneapi-src/level-zero v1.32.0 (see docs/sysman.md for exact URLs):
//   ze_api.h  (zeInit/zeDriverGet/zeDeviceGet, ze_result_t)
//   zes_api.h (zes* Sysman APIs: power limits + overclock controls)
//
// The IGS hypothesis (plan §9 M2b): IGCL power/freq/temp setters are refused
// while IGS components run (half-states) and raw sets above the 252 W cap
// return 0x44000004 - the cap is enforced inside IntelControlLib. The Level
// Zero Sysman path sits BELOW IntelControlLib (ze_loader.dll -> KMD) and may
// not share its arbitration/cap; this module + tools/validate/sysman-probe.js
// test that hypothesis on the real A770.
//
// ze_loader.dll ships in System32 with the driver; it forwards every ze/zes
// export, so GetProcAddress over the loader covers the whole surface. All
// struct layouts are MSVC x64 and size-asserted at load time (a loader built
// from a different header revision that changes a layout must fail loudly,
// exactly like the IGCL bindings).
//
// NOTE on result codes: the driver's ze_loader.dll was built from an older
// header than v1.32.0. Two eras of ze_result_t are mapped (the old
// 0x7800xxxx "validation" block and the v1.32 0x7000xxxx "core" block); the
// OC-specific codes (0x78000023..0x78000038) are stable across both. The
// probe always prints the raw hex alongside the mapped name, so an unmapped
// code is still interpretable.

import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Enums (zes_api.h v1.32.0)
// ---------------------------------------------------------------------------

// zes_overclock_domain_t - bitmask values.
export const ZES_OVERCLOCK_DOMAIN = {
  1: 'CARD',
  2: 'PACKAGE',
  4: 'GPU_ALL',
  8: 'GPU_RENDER_COMPUTE',
  16: 'GPU_RENDER',
  32: 'GPU_COMPUTE',
  64: 'GPU_MEDIA',
  128: 'VRAM',
  256: 'ADM',
};

// zes_overclock_control_t - bitmask values.
export const ZES_OVERCLOCK_CONTROL = {
  1: 'VF',
  2: 'FREQ_OFFSET',
  4: 'VMAX_OFFSET',
  8: 'FREQ',
  16: 'VOLT_LIMIT',
  32: 'POWER_SUSTAINED_LIMIT',
  64: 'POWER_BURST_LIMIT',
  128: 'POWER_PEAK_LIMIT',
  256: 'ICCMAX_LIMIT',
  512: 'TEMP_LIMIT',
  1024: 'ITD_DISABLE',
  2048: 'ACM_DISABLE',
};

// zes_pending_action_t
export const ZES_PENDING_ACTION = {
  0: 'PENDING_NONE',
  1: 'PENDING_IMMINENT',
  2: 'PENDING_COLD_RESET',
  3: 'PENDING_WARM_RESET',
};

// zes_control_state_t
export const ZES_CONTROL_STATE = {
  0: 'STATE_UNSET',
  2: 'STATE_ACTIVE',
  3: 'STATE_DISABLED',
};

// zes_overclock_mode_t
export const ZES_OVERCLOCK_MODE = {
  0: 'MODE_OFF',
  2: 'MODE_STOCK',
  3: 'MODE_ON',
  4: 'MODE_UNAVAILABLE',
  5: 'MODE_DISABLED',
};

export function bitmaskNames(mask, map) {
  const names = [];
  for (const [bit, name] of Object.entries(map)) {
    if ((mask & Number(bit)) !== 0) names.push(name);
  }
  return names;
}

// ---------------------------------------------------------------------------
// ze_result_t - dual-era map (see header note above)
// ---------------------------------------------------------------------------

export const ZE_RESULT_NAME = {
  // shared / stable
  0x00000000: 'SUCCESS',
  0x00000001: 'NOT_READY',
  // OLD era (driver's loader is built against this; the 0x78000001..
  // 0x78000021 "validation" block shifted meaning in v1.32 - the OLD names
  // are the ones the driver actually returns, so they win on collision)
  0x78000001: 'ERROR_UNINITIALIZED',
  0x78000002: 'ERROR_DEVICE_LOST',
  0x78000003: 'ERROR_INVALID_ARGUMENT',
  0x78000004: 'ERROR_OUT_OF_HOST_MEMORY',
  0x78000005: 'ERROR_OUT_OF_DEVICE_MEMORY',
  0x78000006: 'ERROR_MODULE_BUILD_FAILURE',
  0x78000007: 'ERROR_MODULE_LINK_FAILURE',
  0x78000008: 'ERROR_INSUFFICIENT_PERMISSIONS',
  0x78000009: 'ERROR_NOT_AVAILABLE',
  0x7800000a: 'ERROR_NOT_IMPLEMENTED',
  0x7800000b: 'ERROR_INVALID_NULL_HANDLE',
  0x7800000c: 'ERROR_INVALID_NULL_POINTER',
  0x7800000d: 'ERROR_INVALID_SIZE',
  0x7800000e: 'ERROR_UNSUPPORTED_SIZE',
  0x7800000f: 'ERROR_UNSUPPORTED_VERSION',
  0x78000010: 'ERROR_INVALID_FORMAT',
  0x78000011: 'ERROR_INVALID_SYNCHRONIZATION_OBJECT',
  0x78000012: 'ERROR_INVALID_ENUMERATION',
  0x78000013: 'ERROR_UNSUPPORTED_ENUMERATION',
  0x78000014: 'ERROR_UNSUPPORTED_IMAGE_FORMAT',
  0x78000015: 'ERROR_INVALID_NATIVE_BINARY',
  0x78000016: 'ERROR_INVALID_GLOBAL_NAME',
  0x78000017: 'ERROR_INVALID_KERNEL_NAME',
  0x78000018: 'ERROR_INVALID_FUNCTION_NAME',
  0x78000019: 'ERROR_INVALID_GROUP_SIZE_DIMENSION',
  0x7800001a: 'ERROR_INVALID_GLOBAL_WIDTH_DIMENSION',
  0x7800001b: 'ERROR_INVALID_KERNEL_ARGUMENT_INDEX',
  0x7800001c: 'ERROR_INVALID_KERNEL_ARGUMENT_SIZE',
  0x7800001d: 'ERROR_INVALID_KERNEL_ATTRIBUTE_VALUE',
  0x7800001e: 'ERROR_INVALID_MODULE_UNLINKED',
  0x7800001f: 'ERROR_INVALID_COMMAND_LIST_TYPE',
  0x78000020: 'ERROR_OVERLAPPING_REGIONS',
  0x78000021: 'ERROR_UNKNOWN',
  0x78000022: 'ERROR_UNSUPPORTED_FEATURE',
  // OC-specific (stable across eras)
  0x78000023: 'ERROR_INVALID_OVERCLOCK_SETTING',
  0x78000024: 'ERROR_OVERCLOCK_NOT_SUPPORTED',
  0x78000025: 'ERROR_OVERCLOCK_OUT_OF_RANGE',
  0x78000026: 'ERROR_OVERCLOCK_WAIVER_NOT_SET',
  0x78000027: 'ERROR_OVERCLOCK_IGNORE_VOLTAGE_LIMIT_REQUIRED',
  0x78000028: 'ERROR_OVERCLOCK_INSUFFICIENT_PERMISSIONS',
  0x78000029: 'ERROR_INVALID_DEVICE',
  0x7800002a: 'ERROR_OUT_OF_DEVICE_MEMORY_ALIASED',
  0x7800002c: 'ERROR_OPERATIONS_SYNCHRONIZATION',
  0x7800002d: 'ERROR_INVALID_OVERCLOCK_FREQUENCY',
  0x7800002e: 'ERROR_INVALID_OVERCLOCK_POWER',
  0x7800002f: 'ERROR_INVALID_OVERCLOCK_TEMPERATURE',
  0x78000030: 'ERROR_INVALID_OVERCLOCK_VOLTAGE',
  0x78000031: 'ERROR_OVERCLOCK_NOT_FOUND',
  0x78000032: 'ERROR_OVERCLOCK_FAILURE',
  0x78000033: 'ERROR_OVERCLOCK_WAIVER_ALREADY_SET',
  0x78000034: 'ERROR_MULTIPLE_INITIALIZATIONS',
  0x78000035: 'ERROR_MULTIPLE_DEVICES',
  0x78000036: 'ERROR_INVALID_POWER_LEVEL',
  0x78000037: 'ERROR_INVALID_POWER_LEVEL_INTERVAL',
  0x78000038: 'ERROR_INVALID_POWER_LEVEL_AND_INTERVAL',
  0x78000039: 'ERROR_DEVICE_REQUIRES_RESET',
  // NEW era core codes (v1.32.0 moved the core block to 0x7000xxxx - no
  // collision with the old block; added for completeness)
  0x70000001: 'ERROR_DEVICE_LOST',
  0x70000002: 'ERROR_OUT_OF_HOST_MEMORY',
  0x70000003: 'ERROR_OUT_OF_DEVICE_MEMORY',
  0x70000004: 'ERROR_MODULE_BUILD_FAILURE',
  0x70000005: 'ERROR_MODULE_LINK_FAILURE',
  0x70000006: 'ERROR_DEVICE_REQUIRES_RESET',
  0x70000007: 'ERROR_DEVICE_IN_LOW_POWER_STATE',
  0x70010000: 'ERROR_INSUFFICIENT_PERMISSIONS',
  0x70010001: 'ERROR_NOT_AVAILABLE',
  0x70020000: 'ERROR_DEPENDENCY_UNAVAILABLE',
  0x70020001: 'WARNING_DROPPED_DATA',
  0x7ffffffe: 'ERROR_UNKNOWN',
};

export function describeZeResult(code) {
  const c = code >>> 0;
  const hex = `0x${c.toString(16).padStart(8, '0')}`;
  return `${ZE_RESULT_NAME[c] ?? 'UNKNOWN'} (${hex})`;
}

export function zeOk(code) {
  return (code >>> 0) === 0x0;
}

// ---------------------------------------------------------------------------
// Structs (C -> koffi), MSVC x64
// ---------------------------------------------------------------------------

// zes_power_sustained_limit_t { ze_bool_t enabled; int32_t power; int32_t interval; } = 12
const zes_power_sustained_limit_t = koffi.struct('zes_power_sustained_limit_t', {
  enabled: 'uint8',
  power: 'int32',
  interval: 'int32',
});

// zes_power_burst_limit_t { ze_bool_t enabled; int32_t power; } = 8
const zes_power_burst_limit_t = koffi.struct('zes_power_burst_limit_t', {
  enabled: 'uint8',
  power: 'int32',
});

// zes_power_peak_limit_t { int32_t powerAC; int32_t powerDC; } = 8
const zes_power_peak_limit_t = koffi.struct('zes_power_peak_limit_t', {
  powerAC: 'int32',
  powerDC: 'int32',
});

// zes_overclock_properties_t { stype u32 @0, pNext void* @8, domainType u32
//   @16, AvailableControls u32 @20, VFProgramType u32 @24, NumberOfVFPoints
//   u32 @28 } = 32 (align 8)
const zes_overclock_properties_t = koffi.struct('zes_overclock_properties_t', {
  stype: 'uint32',
  pNext: 'void*',
  domainType: 'int32',
  AvailableControls: 'uint32',
  VFProgramType: 'uint32',
  NumberOfVFPoints: 'uint32',
});

// zes_control_property_t { 5 x double } = 40
const zes_control_property_t = koffi.struct('zes_control_property_t', {
  MinValue: 'double',
  MaxValue: 'double',
  StepValue: 'double',
  RefValue: 'double',
  DefaultValue: 'double',
});

const EXPECTED_SIZES = {
  zes_power_sustained_limit_t: 12,
  zes_power_burst_limit_t: 8,
  zes_power_peak_limit_t: 8,
  zes_overclock_properties_t: 32,
  zes_control_property_t: 40,
};

for (const [name, expected] of Object.entries(EXPECTED_SIZES)) {
  const actual = koffi.sizeof(name);
  if (actual !== expected) {
    throw new Error(`Layout mismatch: koffi sizeof(${name}) = ${actual}, expected ${expected} (zes_api.h v1.32.0, MSVC x64). Refusing to continue.`);
  }
}

// ---------------------------------------------------------------------------
// DLL discovery
// ---------------------------------------------------------------------------

export function findZeLoaderDll() {
  // ze_loader.dll ships in System32 with the driver package (plan §9 M2b
  // research verdict). Fallbacks: the DriverStore igfx package dirs (some
  // driver packages also place it there) and the LZ_LOADER_PATH env override
  // (dev only - lets a test point at a fixture).
  const candidates = [
    process.env.LZ_LOADER_PATH,
    'C:\\Windows\\System32\\ze_loader.dll',
  ];
  try {
    const store = 'C:\\Windows\\System32\\DriverStore\\FileRepository';
    if (fs.statSync(store).isDirectory()) {
      for (const dir of fs.readdirSync(store)) {
        if (dir.startsWith('iigd_dch_d.inf_amd64_')) candidates.push(path.join(store, dir, 'ze_loader.dll'));
      }
    }
  } catch {
    // DriverStore may be inaccessible; fall through to the plain candidates.
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/**
 * Bind the ze/zes surface from ze_loader.dll. Every entry point is resolved
 * via the loader's exports; symbols the loader lacks are recorded in
 * `unavailable` (callers degrade per-symbol instead of failing hard).
 * @param {string} dllPath
 */
export function loadSysman(dllPath) {
  const lib = koffi.load(dllPath);
  const fn = { unavailable: [] };
  const bind = (name, ret, params) => {
    try {
      fn[name] = lib.func(name, ret, params);
    } catch {
      fn.unavailable.push(name);
    }
  };

  // Core (ze_api.h)
  bind('zeInit', 'uint32', ['uint32']); // ze_init_flags_t
  bind('zeDriverGet', 'uint32', ['uint32*', 'void**']); // ze_driver_handle_t*
  bind('zeDeviceGet', 'uint32', ['void*', 'uint32*', 'void**']); // (driver, count, ze_device_handle_t*)

  // Sysman (zes_api.h)
  bind('zesInit', 'uint32', ['uint32']); // zes_init_flags_t (must be 0)
  bind('zesDriverGet', 'uint32', ['uint32*', 'void**']); // zes_driver_handle_t*
  bind('zesDeviceGet', 'uint32', ['void*', 'uint32*', 'void**']); // (zes driver, count, zes_device_handle_t*)

  // Overclock waiver + state
  bind('zesDeviceSetOverclockWaiver', 'uint32', ['void*']);
  bind('zesDeviceReadOverclockState', 'uint32', ['void*', 'int32*', 'uint8*', 'uint8*', 'int32*', 'uint8*']);
  bind('zesDeviceResetOverclockSettings', 'uint32', ['void*', 'uint8']);
  bind('zesDeviceGetOverclockDomains', 'uint32', ['void*', 'uint32*']); // bitmask of zes_overclock_domain_t
  bind('zesDeviceGetOverclockControls', 'uint32', ['void*', 'int32', 'uint32*']); // (device, domain, bitmask)
  bind('zesDeviceEnumOverclockDomains', 'uint32', ['void*', 'uint32*', 'void**']); // deprecated handle API

  // Overclock control values (domain handle based)
  bind('zesOverclockGetDomainProperties', 'uint32', ['void*', 'zes_overclock_properties_t*']);
  bind('zesOverclockGetDomainControlProperties', 'uint32', ['void*', 'int32', 'zes_control_property_t*']);
  bind('zesOverclockGetControlCurrentValue', 'uint32', ['void*', 'int32', 'double*']);
  bind('zesOverclockSetControlUserValue', 'uint32', ['void*', 'int32', 'double', 'int32*']); // zes_pending_action_t*

  // VF curve point values (zes_api.h - not exposed by IGCL but may be
  // available via Sysman directly on some drivers)
  bind('zesOverclockGetVFPointValues', 'uint32', ['void*', 'uint32*', 'void*']); // (device, count*, points)
  bind('zesOverclockSetVFPointValues', 'uint32', ['void*', 'uint32', 'void*']); // (device, count, points*)

  // Power domains + limits
  bind('zesDeviceEnumPowerDomains', 'uint32', ['void*', 'uint32*', 'void**']);
  bind('zesDeviceGetCardPowerDomain', 'uint32', ['void*', 'void**']);
  bind('zesPowerGetLimits', 'uint32', ['void*', 'zes_power_sustained_limit_t*', 'zes_power_burst_limit_t*', 'zes_power_peak_limit_t*']);
  bind('zesPowerSetLimits', 'uint32', ['void*', 'zes_power_sustained_limit_t*', 'zes_power_burst_limit_t*', 'zes_power_peak_limit_t*']);

  return fn;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Two-step handle enumeration (count query with null array, then fill),
 * the standard Level Zero pattern.
 * @param {(countBuf: unknown, array: unknown) => number} enumFn
 * @returns {{ result: number, handles: unknown[] }}
 */
export function enumerateHandles(enumFn) {
  const countBuf = koffi.alloc('uint32', 1);
  const r0 = enumFn(countBuf, null);
  if (!zeOk(r0)) return { result: r0 >>> 0, handles: [] };
  const count = koffi.decode(countBuf, 'uint32');
  if (count === 0) return { result: 0, handles: [] };
  const buf = koffi.alloc('void*', count);
  const r1 = enumFn(countBuf, buf);
  if (!zeOk(r1)) return { result: r1 >>> 0, handles: [] };
  const handles = [];
  for (let i = 0; i < count; i++) handles.push(koffi.decode(buf, i * 8, 'void*'));
  return { result: 0, handles };
}

/**
 * Decode the three legacy power-limit structs from a raw buffer (12 + 8 + 8
 * contiguous bytes) into plain JS. `interval` is int32 in the header.
 * @param {unknown} buf koffi buffer of 28+ bytes
 * @param {number} [offset]
 */
export function decodePowerLimits(buf, offset = 0) {
  const sustained = koffi.decode(buf, offset, 'zes_power_sustained_limit_t');
  const burst = koffi.decode(buf, offset + 12, 'zes_power_burst_limit_t');
  const peak = koffi.decode(buf, offset + 20, 'zes_power_peak_limit_t');
  return { sustained, burst, peak };
}
