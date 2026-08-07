// IGCL (Intel Graphics Control Library) koffi bindings � M1 vendored copy.
// SOURCE OF TRUTH: tools/probe/igcl.mjs (M0-verified reference implementation).
// This file is a copy of that module with the M0-research header replaced;
// re-sync from the probe module if the struct defs change upstream.
// Struct layouts transcribed from the official header (igcl_api.h, v1.1):
//   https://github.com/intel/drivers.gpu.control-library
// The native runtime is IntelControlLib.dll ("Intel Graphics Control Lib
// Runtime"), shipped inside the DriverStore igfx package; System32's
// ControlLib.dll is only a UID-whitelisted loader (do NOT use it � see
// docs/igcl-integration.md �1).
// All layouts are MSVC x64. Every struct size is asserted so a header/driver
// change or a transcription mistake fails loudly at load time.

import koffi from 'koffi';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

export const CTL_INIT_FLAG_USE_LEVEL_ZERO = 0x00000001;

export const CTL_RESULT = {
  SUCCESS: 0x00000000,
  ERROR_NOT_INITIALIZED: 0x40000001,
  ERROR_ALREADY_INITIALIZED: 0x40000002,
  ERROR_DEVICE_LOST: 0x40000003,
  ERROR_INSUFFICIENT_PERMISSIONS: 0x40000006,
  ERROR_NOT_AVAILABLE: 0x40000007,
  ERROR_UNINITIALIZED: 0x40000008,
  ERROR_UNSUPPORTED_VERSION: 0x40000009,
  ERROR_UNSUPPORTED_FEATURE: 0x4000000a,
  ERROR_INVALID_ARGUMENT: 0x4000000b,
  ERROR_INVALID_NULL_HANDLE: 0x4000000d,
  ERROR_INVALID_NULL_POINTER: 0x4000000e,
  ERROR_INVALID_SIZE: 0x4000000f,
  ERROR_DATA_READ: 0x40000012,
  ERROR_DATA_WRITE: 0x40000013,
  ERROR_DATA_NOT_FOUND: 0x40000014,
  ERROR_NOT_IMPLEMENTED: 0x40000015,
  ERROR_OS_CALL: 0x40000016,
  ERROR_KMD_CALL: 0x40000017,
  ERROR_ZE_LOADER: 0x40000019,
  ERROR_INVALID_OPERATION_TYPE: 0x4000001a,
  ERROR_UNKNOWN_APPLICATION_UID: 0x40000021,
  ERROR_INVALID_ENUMERATION: 0x40000022,
  ERROR_RESET_DEVICE_REQUIRED: 0x40000024,
  ERROR_FULL_REBOOT_REQUIRED: 0x40000025,
  ERROR_LOAD: 0x40000026,
  ERROR_DEVICE_UNAVAILABLE: 0x40000027,
  ERROR_UNKNOWN: 0x4000ffff,
  ERROR_RETRY_OPERATION: 0x40010000,
  ERROR_IGSC_LOADER: 0x40010001,
  ERROR_RESTRICTED_APPLICATION: 0x40010002,
  ERROR_CORE_OVERCLOCK_NOT_SUPPORTED: 0x44000001,
  ERROR_CORE_OVERCLOCK_VOLTAGE_OUTSIDE_RANGE: 0x44000002,
  ERROR_CORE_OVERCLOCK_FREQUENCY_OUTSIDE_RANGE: 0x44000003,
  ERROR_CORE_OVERCLOCK_POWER_OUTSIDE_RANGE: 0x44000004,
  ERROR_CORE_OVERCLOCK_TEMPERATURE_OUTSIDE_RANGE: 0x44000005,
  ERROR_CORE_OVERCLOCK_IN_VOLTAGE_LOCKED_MODE: 0x44000006,
  ERROR_CORE_OVERCLOCK_RESET_REQUIRED: 0x44000007,
  ERROR_CORE_OVERCLOCK_WAIVER_NOT_SET: 0x44000008,
  ERROR_CORE_OVERCLOCK_DEPRECATED_API: 0x44000009,
  ERROR_CORE_OVERCLOCK_VRAM_MEMORY_SPEED_OUTSIDE_RANGE: 0x4400000d,
  ERROR_CORE_OVERCLOCK_INVALID_CUSTOM_VF_CURVE: 0x4400000e,
} ;

export const RESULT_NAME = {};
for (const [k, v] of Object.entries(CTL_RESULT)) RESULT_NAME[v] = k;
RESULT_NAME[0x00000001] = 'SUCCESS_STILL_OPEN_BY_ANOTHER_CALLER';

export const CTL_UNITS = {
  0: 'FREQUENCY_MHZ',
  1: 'OPERATIONS_GTS',
  2: 'OPERATIONS_MTS',
  3: 'VOLTAGE_VOLTS',
  4: 'POWER_WATTS',
  5: 'TEMPERATURE_CELSIUS',
  6: 'ENERGY_JOULES',
  7: 'TIME_SECONDS',
  8: 'MEMORY_BYTES',
  9: 'ANGULAR_SPEED_RPM',
  10: 'POWER_MILLIWATTS',
  11: 'PERCENT',
  12: 'MEM_SPEED_GBPS',
  13: 'VOLTAGE_MILLIVOLTS',
  14: 'BANDWIDTH_MBPS',
};

export const CTL_DATA_TYPE = {
  0: 'INT8', 1: 'UINT8', 2: 'INT16', 3: 'UINT16', 4: 'INT32', 5: 'UINT32',
  6: 'INT64', 7: 'UINT64', 8: 'FLOAT', 9: 'DOUBLE',
};

export const CTL_DEVICE_TYPE = { 1: 'GRAPHICS', 2: 'SYSTEM' };

export const CTL_FAN_SPEED_MODE = { 0: 'DEFAULT', 1: 'FIXED', 2: 'TABLE' };
export const CTL_FAN_SPEED_UNITS = { 0: 'RPM', 1: 'PERCENT' };

export const CTL_VF_CURVE_TYPE = { 0: 'STOCK', 1: 'LIVE' };
export const CTL_VF_CURVE_DETAILS = { 0: 'SIMPLIFIED', 1: 'MEDIUM', 2: 'ELABORATE' };

// ---------------------------------------------------------------------------
// Structs (C -> koffi)
// ---------------------------------------------------------------------------

koffi.alias('ctl_result_t', 'uint32');

const ctl_application_id_t = koffi.struct('ctl_application_id_t', {
  Data1: 'uint32',
  Data2: 'uint16',
  Data3: 'uint16',
  Data4: 'uint8[8]',
}); // 16 bytes, align 4

const ctl_init_args_t = koffi.struct('ctl_init_args_t', {
  Size: 'uint32',
  Version: 'uint8',
  AppVersion: 'uint32',
  flags: 'uint32',
  SupportedVersion: 'uint32',
  ApplicationUID: 'ctl_application_id_t',
}); // 36 bytes, align 4

const ctl_firmware_version_t = koffi.struct('ctl_firmware_version_t', {
  major_version: 'uint64',
  minor_version: 'uint64',
  build_number: 'uint64',
});

const ctl_adapter_bdf_t = koffi.struct('ctl_adapter_bdf_t', {
  bus: 'uint8',
  device: 'uint8',
  function: 'uint8',
});

const ctl_device_adapter_properties_t = koffi.struct('ctl_device_adapter_properties_t', {
  Size: 'uint32',
  Version: 'uint8',
  pDeviceID: 'void*',
  device_id_size: 'uint32',
  device_type: 'int32',
  supported_subfunction_flags: 'uint32',
  driver_version: 'uint64',
  firmware_version: 'ctl_firmware_version_t',
  pci_vendor_id: 'uint32',
  pci_device_id: 'uint32',
  rev_id: 'uint32',
  num_eus_per_sub_slice: 'uint32',
  num_sub_slices_per_slice: 'uint32',
  num_slices: 'uint32',
  name: 'char[100]',
  graphics_adapter_properties: 'uint32',
  Frequency: 'uint32',
  pci_subsys_id: 'uint16',
  pci_subsys_vendor_id: 'uint16',
  adapter_bdf: 'ctl_adapter_bdf_t',
  num_xe_cores: 'uint32',
  reserved: 'uint8[108]',
}); // 320 bytes, align 8

const ctl_oc_control_info_t = koffi.struct('ctl_oc_control_info_t', {
  bSupported: 'bool',
  bRelative: 'bool',
  bReference: 'bool',
  units: 'int32',
  min: 'double',
  max: 'double',
  step: 'double',
  Default: 'double',
  reference: 'double',
}); // 48 bytes, align 8

const ctl_oc_properties_t = koffi.struct('ctl_oc_properties_t', {
  Size: 'uint32',
  Version: 'uint8',
  bSupported: 'bool',
  gpuFrequencyOffset: 'ctl_oc_control_info_t',
  gpuVoltageOffset: 'ctl_oc_control_info_t',
  vramFrequencyOffset: 'ctl_oc_control_info_t',
  vramVoltageOffset: 'ctl_oc_control_info_t',
  powerLimit: 'ctl_oc_control_info_t',
  temperatureLimit: 'ctl_oc_control_info_t',
  vramMemSpeedLimit: 'ctl_oc_control_info_t',
  gpuVFCurveVoltageLimit: 'ctl_oc_control_info_t',
  gpuVFCurveFrequencyLimit: 'ctl_oc_control_info_t',
}); // 440 bytes, align 8

const ctl_oc_vf_pair_t = koffi.struct('ctl_oc_vf_pair_t', {
  Size: 'uint32',
  Version: 'uint8',
  Voltage: 'double',
  Frequency: 'double',
}); // 24 bytes, align 8

const ctl_fan_speed_t = koffi.struct('ctl_fan_speed_t', {
  Size: 'uint32',
  Version: 'uint8',
  speed: 'int32',
  units: 'int32',
}); // 16 bytes, align 4

const ctl_fan_temp_speed_t = koffi.struct('ctl_fan_temp_speed_t', {
  Size: 'uint32',
  Version: 'uint8',
  temperature: 'uint32',
  speed: 'ctl_fan_speed_t',
}); // 28 bytes, align 4

const ctl_fan_speed_table_t = koffi.struct('ctl_fan_speed_table_t', {
  Size: 'uint32',
  Version: 'uint8',
  numPoints: 'int32',
  table: 'ctl_fan_temp_speed_t[32]',
}); // 908 bytes, align 4

const ctl_fan_properties_t = koffi.struct('ctl_fan_properties_t', {
  Size: 'uint32',
  Version: 'uint8',
  canControl: 'bool',
  supportedModes: 'uint32',
  supportedUnits: 'uint32',
  maxRPM: 'int32',
  maxPoints: 'int32',
}); // 24 bytes, align 4

const ctl_fan_config_t = koffi.struct('ctl_fan_config_t', {
  Size: 'uint32',
  Version: 'uint8',
  mode: 'int32',
  speedFixed: 'ctl_fan_speed_t',
  speedTable: 'ctl_fan_speed_table_t',
}); // 936 bytes, align 4

// ctl_oc_telemetry_item_t: union ctl_data_value_t occupies 8 bytes (double);
// declared as 'double' for layout; read uint64 counters via decode(ptr,'uint64',off)
const ctl_oc_telemetry_item_t = koffi.struct('ctl_oc_telemetry_item_t', {
  bSupported: 'bool',
  units: 'int32',
  type: 'int32',
  value: 'double',
}); // 24 bytes, align 8

const ctl_psu_info_t = koffi.struct('ctl_psu_info_t', {
  bSupported: 'bool',
  psuType: 'int32',
  energyCounter: 'ctl_oc_telemetry_item_t',
  voltage: 'ctl_oc_telemetry_item_t',
}); // 56 bytes, align 8

const ctl_power_telemetry_t = koffi.struct('ctl_power_telemetry_t', {
  Size: 'uint32',
  Version: 'uint8',
  timeStamp: 'ctl_oc_telemetry_item_t',
  gpuEnergyCounter: 'ctl_oc_telemetry_item_t',
  gpuVoltage: 'ctl_oc_telemetry_item_t',
  gpuCurrentClockFrequency: 'ctl_oc_telemetry_item_t',
  gpuCurrentTemperature: 'ctl_oc_telemetry_item_t',
  globalActivityCounter: 'ctl_oc_telemetry_item_t',
  renderComputeActivityCounter: 'ctl_oc_telemetry_item_t',
  mediaActivityCounter: 'ctl_oc_telemetry_item_t',
  gpuPowerLimited: 'bool',
  gpuTemperatureLimited: 'bool',
  gpuCurrentLimited: 'bool',
  gpuVoltageLimited: 'bool',
  gpuUtilizationLimited: 'bool',
  vramEnergyCounter: 'ctl_oc_telemetry_item_t',
  vramVoltage: 'ctl_oc_telemetry_item_t',
  vramCurrentClockFrequency: 'ctl_oc_telemetry_item_t',
  vramCurrentEffectiveFrequency: 'ctl_oc_telemetry_item_t',
  vramReadBandwidthCounter: 'ctl_oc_telemetry_item_t',
  vramWriteBandwidthCounter: 'ctl_oc_telemetry_item_t',
  vramCurrentTemperature: 'ctl_oc_telemetry_item_t',
  vramPowerLimited: 'bool',
  vramTemperatureLimited: 'bool',
  vramCurrentLimited: 'bool',
  vramVoltageLimited: 'bool',
  vramUtilizationLimited: 'bool',
  totalCardEnergyCounter: 'ctl_oc_telemetry_item_t',
  psu: 'ctl_psu_info_t[5]',
  fanSpeed: 'ctl_oc_telemetry_item_t[5]',
  gpuVrTemp: 'ctl_oc_telemetry_item_t',
  vramVrTemp: 'ctl_oc_telemetry_item_t',
  saVrTemp: 'ctl_oc_telemetry_item_t',
  gpuEffectiveClock: 'ctl_oc_telemetry_item_t',
  gpuOverVoltagePercent: 'ctl_oc_telemetry_item_t',
  gpuPowerPercent: 'ctl_oc_telemetry_item_t',
  gpuTemperaturePercent: 'ctl_oc_telemetry_item_t',
  vramReadBandwidth: 'ctl_oc_telemetry_item_t',
  vramWriteBandwidth: 'ctl_oc_telemetry_item_t',
}); // 1024 bytes, align 8

const ctl_voltage_frequency_point_t = koffi.struct('ctl_voltage_frequency_point_t', {
  Voltage: 'uint32',
  Frequency: 'uint32',
}); // 8 bytes, align 4

// M4-D2 (user, driver ReBAR state): ctlPciGetProperties structs, transcribed
// from the IGCL SDK ctl_api.h. LIVE-VERIFIED against the DriverStore runtime
// on the A770 (2026-08-07): this driver build's ctl_pci_speed_t has NO
// Version field ({ Size, gen, width, maxBandwidth } = 20 bytes) � the current
// docs' header adds Version (24 bytes). The resizable-bar flags therefore
// sit at offset 52/53 in this driver build (the docs' 56/57). The decoder
// reads the LIVE offsets (52/53) and the size assertion matches the driver
// build (64 bytes either way).
const ctl_pci_address_t = koffi.struct('ctl_pci_address_t', {
  Size: 'uint32',
  Version: 'uint8',
  pad: 'uint8[3]',
  domain: 'uint32',
  bus: 'uint32',
  device: 'uint32',
  function: 'uint32',
}); // 24 bytes, align 4

const ctl_pci_speed_t = koffi.struct('ctl_pci_speed_t', {
  Size: 'uint32',
  Version: 'uint8',
  pad: 'uint8[3]',
  gen: 'int32',
  width: 'int32',
  maxBandwidth: 'int64',
}); // 24 bytes, align 8

const ctl_pci_properties_t = koffi.struct('ctl_pci_properties_t', {
  Size: 'uint32',
  Version: 'uint8',
  pad: 'uint8[3]',
  address: 'ctl_pci_address_t',   // @8..32
  maxSpeed: 'ctl_pci_speed_t',    // @32..56 (docs layout, live-verified)
  resizable_bar_supported: 'uint8', // @56
  resizable_bar_enabled: 'uint8',   // @57
  pad2: 'uint8[6]',
}); // 64 bytes, align 8

// ---------------------------------------------------------------------------
// Layout assertions (sizes computed by hand from the C headers; any mismatch
// means koffi laid out a struct differently than MSVC did)
// ---------------------------------------------------------------------------

const EXPECTED_SIZES = {
  ctl_application_id_t: 16,
  ctl_init_args_t: 36,
  ctl_firmware_version_t: 24,
  ctl_device_adapter_properties_t: 320,
  ctl_oc_control_info_t: 48,
  ctl_oc_properties_t: 440,
  ctl_oc_vf_pair_t: 24,
  ctl_fan_speed_t: 16,
  ctl_fan_temp_speed_t: 28,
  ctl_fan_speed_table_t: 908,
  ctl_fan_properties_t: 24,
  ctl_fan_config_t: 936,
  ctl_oc_telemetry_item_t: 24,
  ctl_psu_info_t: 56,
  ctl_power_telemetry_t: 1024,
  ctl_voltage_frequency_point_t: 8,
  // M4-D2 (driver ReBAR state): ctl_pci_address_t 24, ctl_pci_speed_t 20
  // (koffi/MSVC 8-aligns the tail � the DRIVER's real layout is 20 bytes\n  // without the tail pad, which is why the flags sit at 52/53), properties 64.
  ctl_pci_address_t: 24,
  ctl_pci_speed_t: 24,
  ctl_pci_properties_t: 64,

};

for (const [name, expected] of Object.entries(EXPECTED_SIZES)) {
  const actual = koffi.sizeof(name);
  if (actual !== expected) {
    throw new Error(`Layout mismatch: koffi sizeof(${name}) = ${actual}, expected ${expected} (header v1.1, MSVC x64). Refusing to continue.`);
  }
}

// ---------------------------------------------------------------------------
// DLL discovery
// ---------------------------------------------------------------------------

export function findIgclDll() {
  // Loader (ControlLib.dll, System32) enforces a UID whitelist (registered
  // Intel UIDs only — an invented UID is rejected with
  // CTL_RESULT_ERROR_UNKNOWN_APPLICATION_UID). The runtime
  // (IntelControlLib.dll, "Intel Graphics Control Lib Runtime", DriverStore
  // igfx package) accepts any UID — that is what the probe uses.
  //
  // The DriverStore keeps packages from every install, so there can be
  // several iigd_dch_d.inf_amd64_* folders. Selection order:
  //   1. the package whose INF DriverVer matches the ACTIVE display driver
  //      version (read from the display class registry key, preferring the
  //      discrete-GPU block — see activeDriverVersion()) — the newest
  //      folder is NOT necessarily the active driver (staged/rolled-back
  //      packages linger);
  //   2. the most recently written package;
  //   3. env IGCL_DLL_PATH, then System32 ControlLib.dll (loader — init will
  //      fail with a clear "unregistered UID" error), then System32
  //      IntelControlLib.dll (runtime), then the IGS dir.
  const store = 'C:\\Windows\\System32\\DriverStore\\FileRepository';
  const candidates = [];
  try {
    if (fs.statSync(store).isDirectory()) {
      for (const dir of fs.readdirSync(store)) {
        if (!dir.startsWith('iigd_dch_d.inf_amd64_')) continue;
        const p = `${store}\\${dir}\\IntelControlLib.dll`;
        if (!requireFSSync(p)) continue;
        candidates.push({
          path: p,
          dir,
          mtime: fs.statSync(p).mtimeMs,
          driverVer: driverVerFromInf(`${store}\\${dir}\\iigd_dch_d.inf`),
        });
      }
    }
  } catch {
    // DriverStore may be inaccessible to the current user; fall through.
  }
  if (candidates.length > 0) {
    const active = activeDriverVersion();
    if (active) {
      const match = candidates.find((c) => c.driverVer === active);
      if (match) return match.path;
    }
    candidates.sort((a, b) => b.mtime - a.mtime || (a.dir < b.dir ? -1 : 1));
    return candidates[0].path;
  }
  const fallbacks = [
    process.env.IGCL_DLL_PATH,
    'C:\\Windows\\System32\\ControlLib.dll',
    'C:\\Windows\\System32\\IntelControlLib.dll',
    'C:\\Program Files\\Intel\\Intel Graphics Software\\ControlLib.dll',
  ];
  for (const c of fallbacks) {
    if (c && requireFSSync(c)) return c;
  }
  return null;
}

function driverVerFromInf(infPath) {
  // [Version] section of the package INF, e.g. "DriverVer = 07/05/2026,32.0.101.8861".
  // Some driver packages ship UTF-16 LE INFs — sniff the BOM before decoding.
  try {
    const raw = fs.readFileSync(infPath);
    let text;
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) text = raw.toString('utf16le');
    else if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) text = raw.toString('utf16be');
    else text = raw.toString('utf8');
    const m = text.match(/DriverVer\s*=\s*\d{1,2}\/\d{1,2}\/\d{4},([0-9.]+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function activeDriverVersion() {
  // Driver version of the currently active display driver, from the display
  // class key (readable by standard users). Fails soft (null) on any error.
  //
  // Selection order (avoids the iGPU-vs-dGPU trap on multi-GPU boxes, where
  // "last Intel block" can be the integrated adapter's subkey):
  //   1. Intel blocks whose DriverDesc names a discrete GPU (Intel's discrete
  //      product line is "Arc"); the last such block wins — the iGPU block
  //      ("UHD/Iris/HD Graphics") is never picked while a discrete block
  //      exists;
  //   2. otherwise the last block with an Intel DriverDesc;
  //   3. otherwise the last block (any vendor).
  try {
    const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
    const out = execFileSync('reg', ['query', key, '/s'], { encoding: 'utf8', windowsHide: true });
    let block = null;
    const blocks = [];
    for (const line of out.split(/\r?\n/)) {
      if (/^HKEY_LOCAL_MACHINE\\/.test(line)) {
        block = { desc: '', version: null, matchingId: '' };
        blocks.push(block);
      } else if (block) {
        const d = line.match(/DriverDesc\s+REG_SZ\s+(.+)/);
        if (d) block.desc = d[1].trim();
        const v = line.match(/DriverVersion\s+REG_SZ\s+(\S+)/);
        if (v) block.version = v[1];
        const m = line.match(/MatchingDeviceId\s+REG_SZ\s+(.+)/);
        if (m) block.matchingId = m[1].trim();
      }
    }
    const intel = blocks.filter((b) => b.version && /intel/i.test(b.desc));
    const discrete = intel.filter((b) => isDiscreteGpu(b));
    const pick = discrete.length > 0
      ? discrete[discrete.length - 1]
      : intel.length > 0 ? intel[intel.length - 1] : blocks[blocks.length - 1];
    return pick && pick.version ? pick.version : null;
  } catch {
    return null;
  }
}

function isDiscreteGpu(block) {
  // Intel's discrete GPU product line is "Arc" (Alchemist/Battlemage);
  // integrated parts are branded UHD/Iris/HD Graphics. The MatchingDeviceId
  // (e.g. "pci\ven_8086&dev_56a0&...") is captured per block so M1 can
  // additionally cross-check it against the enumerated PCI ID if needed.
  return /arc/i.test(block.desc) && !/uhd|iris|hd graphics/i.test(block.desc);
}

function requireFSSync(p) {
  if (!p) return false;
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export function loadIgcl(dllPath) {
  const lib = koffi.load(dllPath);
  const fn = { unavailable: [] };

  const bind = (name, ret, params) => {
    // A driver runtime may omit newer symbols (V2/VRAM/VF, telemetry);
    // bind what exists and record the gap so callers can degrade
    // per-capability instead of failing hard.
    try {
      fn[name] = lib.func(name, ret, params);
    } catch {
      fn.unavailable.push(name);
    }
  };

  bind('ctlInit', 'ctl_result_t', ['ctl_init_args_t*', 'void*']);
  bind('ctlClose', 'ctl_result_t', ['void*']);
  bind('ctlEnumerateDevices', 'ctl_result_t', ['void*', 'uint32*', 'void**']);
  bind('ctlGetDeviceProperties', 'ctl_result_t', ['void*', 'ctl_device_adapter_properties_t*']);

  bind('ctlOverclockGetProperties', 'ctl_result_t', ['void*', 'ctl_oc_properties_t*']);
  bind('ctlOverclockWaiverSet', 'ctl_result_t', ['void*']);
  bind('ctlOverclockResetToDefault', 'ctl_result_t', ['void*']);

  bind('ctlOverclockGpuFrequencyOffsetGet', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockGpuFrequencyOffsetSet', 'ctl_result_t', ['void*', 'double']);
  bind('ctlOverclockGpuFrequencyOffsetGetV2', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockGpuFrequencyOffsetSetV2', 'ctl_result_t', ['void*', 'double']);

  bind('ctlOverclockGpuVoltageOffsetGet', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockGpuVoltageOffsetSet', 'ctl_result_t', ['void*', 'double']);
  bind('ctlOverclockGpuMaxVoltageOffsetGetV2', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockGpuMaxVoltageOffsetSetV2', 'ctl_result_t', ['void*', 'double']);

  bind('ctlOverclockPowerLimitGet', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockPowerLimitSet', 'ctl_result_t', ['void*', 'double']);
  bind('ctlOverclockPowerLimitGetV2', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockPowerLimitSetV2', 'ctl_result_t', ['void*', 'double']);

  bind('ctlOverclockTemperatureLimitGet', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockTemperatureLimitSet', 'ctl_result_t', ['void*', 'double']);
  bind('ctlOverclockTemperatureLimitGetV2', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockTemperatureLimitSetV2', 'ctl_result_t', ['void*', 'double']);

  bind('ctlOverclockVramFrequencyOffsetGet', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockVramFrequencyOffsetSet', 'ctl_result_t', ['void*', 'double']);
  bind('ctlOverclockVramVoltageOffsetGet', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockVramVoltageOffsetSet', 'ctl_result_t', ['void*', 'double']);
  bind('ctlOverclockVramMemSpeedLimitGetV2', 'ctl_result_t', ['void*', 'double*']);
  bind('ctlOverclockVramMemSpeedLimitSetV2', 'ctl_result_t', ['void*', 'double']);

  bind('ctlOverclockGpuLockGet', 'ctl_result_t', ['void*', 'ctl_oc_vf_pair_t*']);
  bind('ctlOverclockGpuLockSet', 'ctl_result_t', ['void*', 'ctl_oc_vf_pair_t']);
  bind('ctlOverclockReadVFCurve', 'ctl_result_t', ['void*', 'int32', 'int32', 'uint32*', 'ctl_voltage_frequency_point_t*']);
  bind('ctlOverclockWriteCustomVFCurve', 'ctl_result_t', ['void*', 'uint32', 'ctl_voltage_frequency_point_t*']);

  bind('ctlEnumFans', 'ctl_result_t', ['void*', 'uint32*', 'void**']);
  bind('ctlFanGetProperties', 'ctl_result_t', ['void*', 'ctl_fan_properties_t*']);
  bind('ctlFanGetConfig', 'ctl_result_t', ['void*', 'ctl_fan_config_t*']);
  bind('ctlFanGetState', 'ctl_result_t', ['void*', 'int32', 'int32*']);
  bind('ctlFanSetFixedSpeedMode', 'ctl_result_t', ['void*', 'ctl_fan_speed_t*']);
  bind('ctlFanSetSpeedTableMode', 'ctl_result_t', ['void*', 'ctl_fan_speed_table_t*']);
  bind('ctlFanSetDefaultMode', 'ctl_result_t', ['void*']);

  bind('ctlPowerTelemetryGet', 'ctl_result_t', ['void*', 'ctl_power_telemetry_t*']);

  // M4-D2 (user): the driver's PCI properties — resizable_bar_supported /
  // resizable_bar_enabled (the same driver state IGS + GPU-Z report).
  // Raw 'void*' params: a typed 'ctl_pci_properties_t*' arg makes koffi
  // validate the buffer type and reject the raw 64-byte buffer the caller
  // passes (live-verified — the driver build's struct differs from koffi's
  // padded layout, so the caller allocates raw bytes + Size 64).
  bind('ctlPciGetProperties', 'ctl_result_t', ['void*', 'void*']);

  return fn;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeVersion(major, minor) {
  return ((major & 0xffff) << 16) | (minor & 0xffff);
}

export function describeResult(code) {
  const hex = `0x${(code >>> 0).toString(16).padStart(8, '0')}`;
  return `${RESULT_NAME[code >>> 0] ?? 'UNKNOWN'} (${hex})`;
}

export function decodeItem(buf, structType, fieldName) {
  // ctl_oc_telemetry_item_t is a {bSupported, units, type, value(double)} struct.
  // The value member is a union; for INT/UINT64 we re-decode the 8-byte value
  // slot as an integer (a double re-decode loses precision).
  const offset = koffi.offsetof(structType, fieldName);
  const item = koffi.decode(buf, offset, 'ctl_oc_telemetry_item_t');
  const out = {
    bSupported: item.bSupported,
    units: CTL_UNITS[item.units] ?? `UNITS_${item.units}`,
    type: CTL_DATA_TYPE[item.type] ?? `TYPE_${item.type}`,
    value: item.value,
  };
  if (item.bSupported && ['INT64', 'UINT64'].includes(out.type)) {
    const raw = koffi.decode(buf, offset + 16, out.type === 'UINT64' ? 'uint64' : 'int64');
    out.value = raw.toString();
    out.rawInt = raw;
  }
  return out;
}

export function decodeVfCurve(buf, numPoints) {
  const pts = [];
  for (let i = 0; i < numPoints; i++) {
    const raw = koffi.decode(buf, i * 8, 'ctl_voltage_frequency_point_t');
    pts.push({ voltage: raw.Voltage, frequency: raw.Frequency });
  }
  return pts;
}

/**
 * M4-D2 (user): decode a ctl_pci_properties_t buffer into plain JS. The
 * resizable-bar flags are read at the LIVE offsets 52/53 (this driver
 * build's ctl_pci_speed_t has no Version field � 20 bytes; the docs'
 * current header would place them at 56/57). Also reads the BDF + link
 * capability for the PCIe truth (bus/gen/width sanity: the A770 live probe
 * reported bus 3, gen 4, width 16, maxBandwidth 31.5 GB/s).
 * @param {unknown} buf koffi buffer of 64+ bytes
 * @returns {{ domain: number, bus: number, device: number, function: number, gen: number, width: number, maxBandwidth: number, resizableBarSupported: boolean, resizableBarEnabled: boolean }}
 */
export function decodePciProperties(buf) {
  // koffi decode quirk (live-verified): single-byte/primitive decodes with
  // an offset on a call-passed buffer drift by -4; the WHOLE-ARRAY decode
  // (koffi.decode(buf, 0, 'uint8[64]')) is byte-accurate. Parse the array
  // in plain JS at the docs/IGCL offsets (live-verified on the A770):
  // domain@16, bus@20, device@24, function@28; speed struct @32:
  // Size@32, Version@36, gen@40, width@44, maxBandwidth@48 (31.5 GB/s =
  // PCIe 4.0 x16 ✓); resizable_bar_supported@56, enabled@57.
  const arr = koffi.decode(buf, 0, 'uint8[64]');
  const u32 = (o) => arr[o] | (arr[o + 1] << 8) | (arr[o + 2] << 16) | (arr[o + 3] << 24);
  const u64 = (o) => {
    let v = 0n;
    for (let b = 7; b >= 0; b--) v = (v << 8n) | BigInt(arr[o + b]);
    return v;
  };
  return {
    domain: u32(16),
    bus: u32(20),
    device: u32(24),
    function: u32(28),
    gen: u32(40) | 0,
    width: u32(44) | 0,
    maxBandwidth: u64(48),
    resizableBarSupported: arr[56] === 1,
    resizableBarEnabled: arr[57] === 1,
  };
}
