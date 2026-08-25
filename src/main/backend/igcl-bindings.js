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
import path from 'node:path';
import os from 'node:os';
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
// ctl_power_limits_t is the fixed V1 power-pair layout used by the bundled
// runtime and its regression seam.
export const CTL_POWER_LIMITS_SIZE = 36;

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

// M8 (the Graphics tab) - the 3D-feature enums (igcl_api.h v290):
// ctl_3d_feature_t feature ids, ctl_property_value_type_t value types and
// the per-feature value tables (flip-mode flags are a BITMASK; low-latency
// and frame-generation are plain enums). The numeric values are pinned by
// the M8 checkpoint-1 live probe (the same values the driver accepted in
// set->read-back->restore round trips).
export const CTL_3D_FEATURE = {
  FRAME_PACING: 0,
  ENDURANCE_GAMING: 1,
  FRAME_LIMIT: 2,
  ANISOTROPIC: 3,
  CMAA: 4,
  TEXTURE_FILTERING_QUALITY: 5,
  ADAPTIVE_TESSELLATION: 6,
  SHARPENING_FILTER: 7,
  MSAA: 8,
  GAMING_FLIP_MODES: 9,
  ADAPTIVE_SYNC_PLUS: 10,
  APP_PROFILES: 11,
  APP_PROFILE_DETAILS: 12,
  EMULATED_TYPED_64BIT_ATOMICS: 13,
  VRR_WINDOWED_BLT: 14,
  GLOBAL_OR_PER_APP: 15,
  LOW_LATENCY: 16,
  FRAME_GENERATION: 17,
  PREBUILT_SHADER_DOWNLOAD: 18,
  LIVE_STATE: 19,
};

export const CTL_PROPERTY_VALUE_TYPE = {
  BOOL: 0,
  FLOAT: 1,
  INT32: 2,
  UINT32: 3,
  ENUM: 4,
  CUSTOM: 5,
};

// ctl_gaming_flip_mode_flag_t - a bitmask (one bit per mode). The
// supported bits come from the caps' SupportedTypes.
export const CTL_GAMING_FLIP_MODE_FLAG = {
  APPLICATION_DEFAULT: 1,
  VSYNC_OFF: 2,
  VSYNC_ON: 4,
  SMOOTH_SYNC: 8,
  SPEED_FRAME: 16,
  CAPPED_FPS: 32,
  VSYNC_OFF_IGNORE_ALLOW_LIST: 64,
};

// ctl_3d_low_latency_types_t / ctl_3d_frame_generation_override_t - plain
// enum values.
export const CTL_3D_LOW_LATENCY = {
  TURN_OFF: 0,
  TURN_ON: 1,
  TURN_ON_BOOST_MODE_ON: 2,
};

export const CTL_3D_FRAME_GENERATION_OVERRIDE = {
  APP_CHOICE: 0,
  X2: 1,
  X3: 2,
  X4: 3,
};

// M10b (the Graphics "Display" view) - the display-module enums (igcl_api.h
// v290; the numeric values pinned by the M10b checkpoint-1 live probe,
// pipeline/live-display-feature.md - the display-output / wire-format /
// display-settings / scaling / retro-scaling / Arc Sync surfaces the probe
// exercised on the A770 driver). ScalingType / RetroScalingType are FLAG
// values in the structs (the caps bitmasks use the same numbering) - the
// VALUE decoders read the flag, not an enum index (0 = no flag set).
export const CTL_DISPLAY_OUTPUT_TYPE = {
  0: 'INVALID', 1: 'DISPLAYPORT', 2: 'HDMI', 3: 'DVI', 4: 'MIPI', 5: 'CRT',
};

export const CTL_DISPLAY_BPC_FLAG = { 0: '6BPC', 1: '8BPC', 2: '10BPC', 3: '12BPC' };

export const CTL_DISPLAY_CONFIG_FLAG = {
  0: 'DISPLAY_ACTIVE', 1: 'DISPLAY_ATTACHED', 2: 'IS_DONGLE_CONNECTED', 3: 'DITHERING_ENABLED',
};

export const CTL_DISPLAY_SETTING_FLAG = {
  0: 'LOW_LATENCY', 1: 'SOURCE_TM', 2: 'CONTENT_TYPE', 3: 'QUANTIZATION_RANGE',
  4: 'PICTURE_AR', 5: 'AUDIO',
};

export const CTL_QUANTIZATION_RANGE = { 0: 'DEFAULT', 1: 'LIMITED_RANGE', 2: 'FULL_RANGE' };

// ScalingType / RetroScalingType FLAG values (the caps bitmasks use the same
// numbering - the driver's current-scaling read returns a FLAG, live 1 =
// IDENTITY on the A770).
export const CTL_SCALING_TYPE_FLAG = {
  1: 'IDENTITY', 2: 'CENTERED', 4: 'STRETCHED', 8: 'ASPECT_RATIO_CENTERED_MAX', 16: 'CUSTOM',
};

export const CTL_RETRO_SCALING_TYPE_FLAG = { 1: 'INTEGER', 2: 'NEAREST_NEIGHBOUR' };

// The BIT-INDEX-keyed tables for the caps bitmask decodes (the probe's
// flagsOf tables: the caps bits sit at 0..4, the struct VALUE is the flag -
// the two keyings must never be conflated).
export const CTL_SCALING_TYPE = {
  0: 'IDENTITY', 1: 'CENTERED', 2: 'STRETCHED', 3: 'ASPECT_RATIO_CENTERED_MAX', 4: 'CUSTOM',
};

export const CTL_RETRO_SCALING_TYPE = { 0: 'INTEGER', 1: 'NEAREST_NEIGHBOUR' };

export const CTL_WIRE_COLOR_MODEL = { 0: 'RGB', 1: 'YCBCR_420', 2: 'YCBCR_422', 3: 'YCBCR_444' };

export const CTL_WIRE_OPERATION = { 0: 'GET', 1: 'SET', 2: 'RESTORE_DEFAULT' };

export const CTL_SIGNAL_STANDARD = { 0: 'UNKNOWN', 1: 'CUSTOM', 2: 'DMT', 3: 'GTF', 4: 'CVT', 5: 'CTA' };

export const CTL_ARC_SYNC_PROFILE = {
  0: 'INVALID', 1: 'RECOMMENDED', 2: 'EXCELLENT', 3: 'GOOD', 4: 'COMPATIBLE',
  5: 'OFF', 6: 'VESA', 7: 'CUSTOM',
};

// Public IGCL Media API feature used by the IGS Color page. The current
// Display page only needs Standard Color Correction (Hue, Saturation,
// Brightness and Contrast); the other media features remain unbound.
export const CTL_VIDEO_PROCESSING_FEATURE = { STANDARD_COLOR_CORRECTION: 5 };
export const CTL_VIDEO_PROCESSING_VALUE_TYPE = { CUSTOM: 5 };

// The EDID / panel-descriptor op codes used by the monitor-name read (the
// values the probe used: READ_EDID=1, the MONITOR EdidType=3, the panel
// READ=1).
export const CTL_DISPLAY_EDID_OP_READ = 1;
export const CTL_DISPLAY_EDID_TYPE_MONITOR = 3;
export const CTL_PANEL_DESCRIPTOR_OP_READ = 1;

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

// M4-D2 (driver ReBAR state): ctlPciGetProperties structs, transcribed
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
// M8 (the Graphics tab) - the IGCL 3D-feature surface (igcl_api.h v290):
// ctlGetSupported3DCapabilities + ctlGetSet3DFeature. The layouts below are
// transcribed from the v290 header and LIVE-VERIFIED by the M8 checkpoint-1
// probe (pipeline/live-3d-feature.md, 2026-08-09, A770 driver 32.0.101.8861):
// every field offset was exercised by driver reads AND set->read-back->
// restore round trips for all four features (XeSS FG override, flip modes,
// frame limit, low latency). The driver's Size validation is an UPPER bound
// (getset <= 56, caps <= 24; larger values refuse with ERROR_INVALID_SIZE),
// so the v290 header sizes are the pinned ceiling. ApplicationName is a
// POINTER (char*) - the backend passes a zeroed 1-byte buffer ("" = the
// GLOBAL settings scope; per-app overrides are out of scope for M8).
// ---------------------------------------------------------------------------

const ctl_3d_feature_caps_t = koffi.struct('ctl_3d_feature_caps_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  NumSupportedFeatures: 'uint32', // @8
  pFeatureDetails: 'void*',       // @16 (ctl_3d_feature_details_t* array)
}); // 24 bytes, align 8

const ctl_3d_feature_details_t = koffi.struct('ctl_3d_feature_details_t', {
  FeatureType: 'int32',           // @0  (ctl_3d_feature_t; MSVC enum = 4 bytes)
  ValueType: 'int32',             // @4  (ctl_property_value_type_t)
  Value: 'uint8[24]',             // @8  (ctl_property_info_t union: 20 bytes
                                  //     of members padded to 24 for 8-align)
  CustomValueSize: 'int32',       // @32
  pCustomValue: 'void*',          // @40
  PerAppSupport: 'bool',          // @48
  ConflictingFeatures: 'int64',   // @56
  FeatureMiscSupport: 'int16',    // @64
  Reserved: 'int16',              // @66
  Reserved1: 'int16',             // @68
  Reserved2: 'int16',             // @70
}); // 72 bytes, align 8

const ctl_3d_feature_getset_t = koffi.struct('ctl_3d_feature_getset_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  FeatureType: 'int32',           // @8  (ctl_3d_feature_t)
  ApplicationName: 'void*',       // @16 (char* - empty string = global)
  ApplicationNameLength: 'int8',  // @24
  bSet: 'bool',                   // @25
  ValueType: 'int32',             // @28 (ctl_property_value_type_t)
  Value: 'uint8[8]',              // @32 (ctl_property_t union:
                                  //     Enable/EnableType@32, scalar@36)
  CustomValueSize: 'int32',       // @40
  pCustomValue: 'void*',          // @48
}); // 56 bytes, align 8

// M17c (the iGPU temperature fallback): the temperature-sensor surface
// (igcl_api.h v1.1). ctlEnumTemperatureSensors enumerates per-sensor
// HANDLES (the count-then-fill pattern of ctlEnumerateDevices);
// ctlTemperatureGetProperties reads the sensor type
// (ctl_temp_sensors_t: GLOBAL 0 / GPU 1 / MEMORY 2 - the max-across-
// sensors types); ctlTemperatureGetState returns the CURRENT temperature
// in degrees C via a double* (NOT a struct - the plan's "state struct"
// name is wrong vs the actual header; the double is the whole contract).
const ctl_temp_properties_t = koffi.struct('ctl_temp_properties_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  type: 'int32',                  // @8  (ctl_temp_sensors_t)
  maxTemperature: 'double',       // @16 (degrees C)
}); // 24 bytes, align 8

// ---------------------------------------------------------------------------
// M10b (the Graphics "Display" view) - the display-module structs (igcl_api.h
// v290). The layouts are transcribed from the header AND live-corrected by
// the M10b checkpoint-1 probe (pipeline/live-display-feature.md, 2026-08-10,
// A770 driver): the byte-truth sentinel runs + size sweeps resolved the TRUE
// v290 layouts where earlier transcriptions were wrong (display settings
// Set@5 + QuantizationRange@32 - the 156-byte Set@8 transcription was wrong;
// scaling settings Enable@5 + ScalingType@8 FLAG values + HardwareModeSet@20 +
// PreferredScalingType@24 - the 32/24-byte transcriptions were wrong;
// retro-scaling settings Get@5/Enable@6/Type@8 - the 20-byte Get@8
// transcription was wrong; arc-sync monitor IsSupported@5 + MinRefresh@8/
// MaxRefresh@12 floats - the 28-byte transcription was wrong). The DRIVER's
// Size validation is an UPPER bound; THIS driver build's ceiling (wire
// config 80 vs the v290 96) is handled by the callers passing the DRIVER
// size in the Size field - see the encode helpers below.
// ---------------------------------------------------------------------------

const ctl_display_timing_t = koffi.struct('ctl_display_timing_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  PixelClock: 'uint64',           // @8
  HActive: 'uint32',              // @16
  VActive: 'uint32',              // @20
  HTotal: 'uint32',               // @24
  VTotal: 'uint32',               // @28
  HBlank: 'uint32',               // @32
  VBlank: 'uint32',               // @36
  HSync: 'uint32',                // @40
  VSync: 'uint32',                // @44
  RefreshRate: 'float',           // @48 (Hz)
  SignalStandard: 'int32',        // @52 (ctl_signal_standard_t)
  VicId: 'uint8',                 // @56
}); // 64 bytes, align 8

const ctl_display_properties_t = koffi.struct('ctl_display_properties_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  Os_display_encoder_handle: 'uint8[16]', // @8 (union: uint32 / {void* pData;
                                  //     uint32 size} = 16 bytes, align 8)
  Type: 'int32',                  // @24 (ctl_display_output_type_t)
  AttachedDisplayMuxType: 'int32', // @28
  ProtocolConverterOutput: 'int32', // @32 (ctl_display_output_type_t; INVALID = native)
  SupportedSpec: 'uint8[3]',      // @36
  SupportedOutputBPCFlags: 'uint32', // @40 (bitmask: 0=6BPC 1=8BPC 2=10BPC 3=12BPC)
  ProtocolConverterType: 'uint32', // @44
  DisplayConfigFlags: 'uint32',   // @48 (bitmask: 0=ACTIVE 1=ATTACHED ...)
  FeatureEnabledFlags: 'uint32',  // @52 (std features bitmask)
  FeatureSupportedFlags: 'uint32', // @56
  AdvancedFeatureEnabledFlags: 'uint32', // @60 (intel features bitmask)
  AdvancedFeatureSupportedFlags: 'uint32', // @64
  Display_Timing_Info: 'ctl_display_timing_t', // @72
  ReservedFields: 'uint32[16]',   // @136
}); // 200 bytes, align 8

const ctl_wire_format_t = koffi.struct('ctl_wire_format_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  ColorModel: 'int32',            // @8  (ctl_wire_format_color_model_t)
  ColorDepth: 'uint32',           // @12 (bits: 6/8/10/12)
}); // 16 bytes, align 4

const ctl_get_set_wire_format_config_t = koffi.struct('ctl_get_set_wire_format_config_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  pad: 'uint8[3]',                // @5
  Operation: 'int32',             // @8  (ctl_get_set_operation_t: GET/SET/RESTORE_DEFAULT)
  pad2: 'uint8[4]',               // @12 - the array is 8-aligned in the v290
                                  //     header: the M10b probe's sentinel runs
                                  //     (pipeline/live-display-feature.md 3b)
                                  //     show the driver writing entries at
                                  //     16/32/48/64, never at 12/28/44/60
  SupportedWireFormat: 'ctl_wire_format_t[4]', // @16
  WireFormat: 'ctl_wire_format_t', // @80 (the current/target format)
}); // 96 bytes, align 8

const ctl_display_settings_t = koffi.struct('ctl_display_settings_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  Set: 'bool',                    // @5  (true = SET, false = GET)
  SupportedFlags: 'uint32',       // @8  (ctl_display_setting_flag_t bitmask)
  ControllableFlags: 'uint32',    // @12
  ValidFlags: 'uint32',           // @16 (the flags being set in a SET)
  LowLatency: 'int32',            // @20
  SourceTM: 'int32',              // @24
  ContentType: 'int32',           // @28
  QuantizationRange: 'int32',     // @32 (ctl_quantization_range_t)
  SupportedPictureAR: 'uint32',   // @36
  PictureAR: 'uint32',            // @40
  AudioSettings: 'int32',         // @44
  Reserved: 'int32[25]',          // @48
}); // 148 bytes, align 4

const ctl_scaling_caps_t = koffi.struct('ctl_scaling_caps_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  SupportedScaling: 'uint32',     // @8 (ctl_scaling_type_flag_t bitmask)
}); // 12 bytes, align 4

const ctl_scaling_settings_t = koffi.struct('ctl_scaling_settings_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  Enable: 'bool',                 // @5
  ScalingType: 'uint32',          // @8  (ctl_scaling_type_flag_t FLAG value)
  CustomScalingX: 'uint32',       // @12
  CustomScalingY: 'uint32',       // @16
  HardwareModeSet: 'bool',        // @20
  PreferredScalingType: 'uint32', // @24
}); // 28 bytes, align 4

const ctl_retro_scaling_caps_t = koffi.struct('ctl_retro_scaling_caps_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  SupportedRetroScaling: 'uint32', // @8 (ctl_retro_scaling_type_flag_t bitmask)
}); // 12 bytes, align 4

const ctl_retro_scaling_settings_t = koffi.struct('ctl_retro_scaling_settings_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  Get: 'bool',                    // @5  (true = GET, false = SET)
  Enable: 'bool',                 // @6
  RetroScalingType: 'uint32',     // @8  (ctl_retro_scaling_type_flag_t FLAG value)
}); // 12 bytes, align 4

const ctl_intel_arc_sync_monitor_params_t = koffi.struct('ctl_intel_arc_sync_monitor_params_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  IsIntelArcSyncSupported: 'bool', // @5
  MinimumRefreshRateInHz: 'float', // @8
  MaximumRefreshRateInHz: 'float', // @12
  MaxFrameTimeIncreaseInUs: 'uint32', // @16
  MaxFrameTimeDecreaseInUs: 'uint32', // @20
}); // 24 bytes, align 4

const ctl_intel_arc_sync_profile_params_t = koffi.struct('ctl_intel_arc_sync_profile_params_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  IntelArcSyncProfile: 'int32',   // @8  (ctl_intel_arc_sync_profile_t)
  MaxRefreshRateInHz: 'float',    // @12
  MinRefreshRateInHz: 'float',    // @16
  MaxFrameTimeIncreaseInUs: 'uint32', // @20
  MaxFrameTimeDecreaseInUs: 'uint32', // @24
}); // 28 bytes, align 4

const ctl_panel_descriptor_access_args_t = koffi.struct('ctl_panel_descriptor_access_args_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  OpType: 'int32',                // @8  (ctl_panel_descriptor_op_type_t: READ=1)
  BlockNumber: 'uint32',          // @12
  DescriptorDataSize: 'uint32',   // @16 (in/out)
  pDescriptorData: 'void*',       // @24
}); // 32 bytes, align 8

const ctl_edid_management_args_t = koffi.struct('ctl_edid_management_args_t', {
  Size: 'uint32',                 // @0
  Version: 'uint8',               // @4
  OpType: 'int32',                // @8  (ctl_edid_op_type_t: READ_EDID=1)
  EdidType: 'int32',              // @12 (ctl_edid_type_t: MONITOR=3)
  EdidSize: 'uint32',             // @16 (in/out)
  pEdidBuf: 'void*',              // @24
  OutFlags: 'uint32',             // @32
}); // 40 bytes, align 8

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
  // (koffi/MSVC 8-aligns the tail � the DRIVER's real layout is 20 bytes
  // without the tail pad, which is why the flags sit at 52/53), properties 64.
  ctl_pci_address_t: 24,
  ctl_pci_speed_t: 24,
  ctl_pci_properties_t: 64,
  // M8 (the Graphics tab): the 3D-feature structs - sizes live-verified by
  // the M8 checkpoint-1 probe (pipeline/live-3d-feature.md): the driver's
  // Size validation is an upper bound (getset <=56, caps <=24 - 60+/28+
  // refuse ERROR_INVALID_SIZE), so the v290 header sizes are the ceiling.
  ctl_3d_feature_caps_t: 24,
  ctl_3d_feature_details_t: 72,
  ctl_3d_feature_getset_t: 56,
  // M17c (the iGPU temperature fallback): ctl_temp_properties_t 24 bytes
  // (Size@0 u32, Version@4 u8, type@8 i32, maxTemperature@16 double - MSVC
  // x64, align 8).
  ctl_temp_properties_t: 24,
  // M10b (the Graphics "Display" view): the display-module structs - the
  // v290 header sizes recorded by the M10b checkpoint-1 LIVE probe
  // (pipeline/live-display-feature.md, 2026-08-10, A770 driver): display
  // properties 200 (accepted 200/160/144/136/96/72), display settings 148
  // (accepted 148/144/136/128/104/80/56 - the 156-byte Set@8 transcription
  // was wrong), scaling settings 28 (accepted 28/24/16), retro-scaling
  // settings 12 (ONLY 12 accepted), arc-sync monitor 24 (accepted 24/20/16),
  // scaling caps 12 (accepted 12/8), retro caps 12. The WIRE-FORMAT config
  // is the exception: v290 96 but THIS driver's ceiling is 80 (the Size
  // field the calls pass) while the full 96-byte struct is still written.
  ctl_display_timing_t: 64,
  ctl_display_properties_t: 200,
  ctl_wire_format_t: 16,
  ctl_get_set_wire_format_config_t: 96,
  ctl_display_settings_t: 148,
  ctl_scaling_caps_t: 12,
  ctl_scaling_settings_t: 28,
  ctl_retro_scaling_caps_t: 12,
  ctl_retro_scaling_settings_t: 12,
  ctl_intel_arc_sync_monitor_params_t: 24,
  ctl_intel_arc_sync_profile_params_t: 28,
  ctl_panel_descriptor_access_args_t: 32,
  ctl_edid_management_args_t: 40,
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

// M17d (Run E): the stable-path cache file (the app data-dir pattern -
// %APPDATA%\ArcPower, the same dir the profile store uses). The cache
// records { driverVersion, path } - the active-driver-version-matched
// runtime path. On the next launch the version is re-read (cheap) and
// compared: a match + an existing DLL skips the DriverStore scan entirely; a
// mismatch (driver update) re-scans. The cache is advisory - a corrupt
// read or a failed write never breaks the scan path.
export const IGCL_DLL_CACHE_FILENAME = 'igcl-dll-cache.json';

export function igclDllCacheFile() {
  const dir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(dir, 'ArcPower', IGCL_DLL_CACHE_FILENAME);
}

function readIgclDllCache(cacheFile) {
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data.driverVersion === 'string' && typeof data.path === 'string') {
      return { driverVersion: data.driverVersion, path: data.path };
    }
  } catch {
    // missing / corrupt / unreadable -> a miss (the scan re-runs)
  }
  return null;
}

function writeIgclDllCache(cacheFile, entry) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(entry));
  } catch {
    // a failed cache write never breaks the scan path
  }
}

/**
 * Locate the DriverStore IGCL runtime DLL. M17d (Run E): a stable-path
 * cache keyed on the active driver version - `{ driverVersion, path }` in
 * the app data dir; a hit (version match + the DLL still exists) returns
 * the cached path WITHOUT the DriverStore walk; a mismatch re-scans and
 * re-caches. The version re-validation itself is the cheap per-subkey reg
 * read (activeDriverVersion) - the old `reg query /s` recursive dump was
 * the measured ~1.5 s of every boot (see pipeline/startup-boot-before.md).
 * @param {{
 *   store?: string,                       // DriverStore FileRepository dir (tests)
 *   cacheFile?: string,                   // the cache file path (tests)
 *   activeDriverVersion?: () => string|null, // the version re-validation source (tests)
 *   scanCounter?: { scans: number, hits: number }, // the regression pin (tests)
 * }} [opts]
 * @returns {string|null}
 */
export function findIgclDll(opts = {}) {
  // Loader (ControlLib.dll, System32) enforces a UID whitelist (registered
  // Intel UIDs only - an invented UID is rejected with
  // CTL_RESULT_ERROR_UNKNOWN_APPLICATION_UID). The runtime
  // (IntelControlLib.dll, "Intel Graphics Control Lib Runtime", DriverStore
  // igfx package) accepts any UID - that is what the probe uses.
  //
  // The DriverStore keeps packages from every install, so there can be
  // several iigd_dch_d.inf_amd64_* folders. Selection order:
  //   1. the package whose INF DriverVer matches the ACTIVE display driver
  //      version (read from the display class registry key, preferring the
  //      discrete-GPU block - see activeDriverVersion()) - the newest
  //      folder is NOT necessarily the active driver (staged/rolled-back
  //      packages linger);
  //   2. the most recently written package;
  //   3. env IGCL_DLL_PATH, then System32 ControlLib.dll (loader - init will
  //      fail with a clear "unregistered UID" error), then System32
  //      IntelControlLib.dll (runtime), then the IGS dir.
  const store = opts.store ?? 'C:\\Windows\\System32\\DriverStore\\FileRepository';
  const cacheFile = opts.cacheFile ?? igclDllCacheFile();
  const activeOf = opts.activeDriverVersion ?? activeDriverVersion;
  const scanCounter = opts.scanCounter ?? null;

  const active = activeOf();
  if (active) {
    // The cache hit: same active driver version + the cached DLL still on
    // disk -> the scan is skipped (the fs-walk counter pin).
    const hit = readIgclDllCache(cacheFile);
    if (hit && hit.driverVersion === active && typeof hit.path === 'string' && requireFSSync(hit.path)) {
      if (scanCounter) scanCounter.hits += 1;
      return hit.path;
    }
  }
  if (scanCounter) scanCounter.scans += 1;
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
    if (active) {
      const match = candidates.find((c) => c.driverVer === active);
      if (match) {
        // The ACTIVE-version match is the deterministic selection - cache it
        // for the next launch (the re-validation is the cheap version read).
        writeIgclDllCache(cacheFile, { driverVersion: active, path: match.path });
        return match.path;
      }
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
  // Some driver packages ship UTF-16 LE INFs - sniff the BOM before decoding.
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
  // M17d (Run E): the TARGETED reads - `reg query <class key>` lists the
  // 000N adapter blocks (~15 ms) + ONE `/v` value query per needed value
  // per block (~15 ms each). The old approaches were measured on the dev
  // box: `reg query <key> /s` = ~1.5 s (a ~146 KB recursive dump) and
  // `reg query <000N>` (all values) = ~1.3 s (the block's value set is
  // huge - binary device parameters). The /v-targeted reads are ~60 ms
  // total and were the profile's #2 stage fix (see
  // pipeline/startup-boot-before.md); the same blocks, the same selection.
  //
  // Selection order (avoids the iGPU-vs-dGPU trap on multi-GPU boxes, where
  // "last Intel block" can be the integrated adapter's subkey):
  //   1. Intel blocks whose DriverDesc names a discrete GPU (Intel's discrete
  //      product line is "Arc"); the last such block wins - the iGPU block
  //      ("UHD/Iris/HD Graphics") is never picked while a discrete block
  //      exists;
  //   2. otherwise the last block with an Intel DriverDesc;
  //   3. otherwise the last block (any vendor).
  try {
    const key = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
    const listing = execFileSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true });
    const blocks = [];
    for (const line of listing.split(/\r?\n/)) {
      const m = line.match(/^HKEY_LOCAL_MACHINE\\.*\\Class\\\{[^}]+\}\\(\d{4})$/);
      if (!m) continue;
      const sub = `${key}\\${m[1]}`;
      const block = { desc: '', version: null, matchingId: '' };
      for (const [name, field] of [['DriverDesc', 'desc'], ['DriverVersion', 'version'], ['MatchingDeviceId', 'matchingId']]) {
        try {
          const out = execFileSync('reg', ['query', sub, '/v', name], { encoding: 'utf8', windowsHide: true });
          const line2 = out.split(/\r?\n/).find((l) => l.includes(`REG_SZ`));
          const value = line2 ? line2.replace(/^.*REG_SZ\s+/, '').trim() : '';
          if (name === 'DriverVersion') block[field] = value || null;
          else block[field] = value;
        } catch {
          // a missing value / denied block just contributes nothing
        }
      }
      blocks.push(block);
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

  // M4-D2: the driver's PCI properties - resizable_bar_supported /
  // resizable_bar_enabled (the same driver state IGS + GPU-Z report).
  // Raw 'void*' params: a typed 'ctl_pci_properties_t*' arg makes koffi
  // validate the buffer type and reject the raw 64-byte buffer the caller
  // passes (live-verified - the driver build's struct differs from koffi's
  // padded layout, so the caller allocates raw bytes + Size 64).
  bind('ctlPciGetProperties', 'ctl_result_t', ['void*', 'void*']);

  // M8 (the Graphics tab): the 3D-feature surface. Raw 'void*' params for
  // the same reason as ctlPciGetProperties - the callers pass raw buffers
  // (the probe-verified v290 layout; a typed struct arg would make koffi
  // reject the raw buffer). The bind() try/catch records an absent export
  // in fn.unavailable - the graphics surface then degrades honestly while
  // the OC surface stays untouched.
  bind('ctlGetSupported3DCapabilities', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetSet3DFeature', 'ctl_result_t', ['void*', 'void*']);

  // M17c (the iGPU temperature fallback): the temperature-sensor surface.
  // ctlEnumTemperatureSensors fills a handle ARRAY (the ctlEnumerateDevices
  // pattern - count-then-fill); ctlTemperatureGetState returns the current
  // temperature via a double* (degrees C). A driver runtime may omit the
  // symbols - bind() records the gap and the fallback degrades honestly.
  bind('ctlEnumTemperatureSensors', 'ctl_result_t', ['void*', 'uint32*', 'void**']);
  bind('ctlTemperatureGetProperties', 'ctl_result_t', ['void*', 'ctl_temp_properties_t*']);
  bind('ctlTemperatureGetState', 'ctl_result_t', ['void*', 'double*']);
  // M10b (the Graphics "Display" view): the display-output surface. Raw
  // 'void*' params like the M8 3D bindings (the callers pass raw buffers -
  // the probe-verified v290 layouts; a typed struct arg would make koffi
  // reject them). ctlEnumerateDisplayOutputs is the ONE three-arg call
  // (handle + count* + handle*); the M10b probe caught the uniform-2-arg
  // mistake - a missing third arg drops the output-handle writes and the
  // display list comes back empty. The bind() try/catch records an absent
  // export in fn.unavailable - the display surface then degrades honestly
  // while the OC/3D surfaces stay untouched.
  bind('ctlEnumerateDisplayOutputs', 'ctl_result_t', ['void*', 'uint32*', 'void**']);
  bind('ctlGetDisplayProperties', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetSetWireFormat', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetSetDisplaySettings', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetSupportedScalingCapability', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetCurrentScaling', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlSetCurrentScaling', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetSupportedRetroScalingCapability', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetSetRetroScaling', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetIntelArcSyncInfoForMonitor', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetIntelArcSyncProfile', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlSetIntelArcSyncProfile', 'ctl_result_t', ['void*', 'void*']);
  // Standard Color Correction is adapter-scoped, not output-scoped. The
  // caller still presents it beside the selected output because that is how
  // IGS presents the global display calibration surface.
  bind('ctlGetSupportedVideoProcessingCapabilities', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlGetSetVideoProcessingFeature', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlPanelDescriptorAccess', 'ctl_result_t', ['void*', 'void*']);
  bind('ctlEdidManagement', 'ctl_result_t', ['void*', 'void*']);

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
 * M4-D2: decode a ctl_pci_properties_t buffer into plain JS. The
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

// ---------------------------------------------------------------------------
// M8 (the Graphics tab) - 3D-feature helpers. The raw-buffer layouts are
// the probe-verified v290 offsets (pipeline/live-3d-feature.md); the koffi
// structs above exist to pin the sizes at module load, the CALLS go through
// raw buffers (the ctlPciGetProperties precedent - koffi typed args would
// reject them).
// ---------------------------------------------------------------------------

/**
 * Decode ONE ctl_3d_feature_details_t entry from the raw details array the
 * driver filled (ctlGetSupported3DCapabilities phase 2). The Value union
 * (offset 8, 24 bytes) is interpreted per the entry's ValueType: enum ->
 * SupportedTypes bitmask + DefaultType; int/uint -> DefaultEnable + the
 * RangeInfo (min/max/step/default).
 * @param {unknown} buf raw details-array buffer
 * @param {number} index entry index (stride = sizeof(ctl_3d_feature_details_t))
 * @returns {{ featureType: number, valueType: number, enumSupportedTypes: bigint|null, enumDefaultType: number|null, intRange: { min: number, max: number, step: number, default: number }|null, perAppSupport: boolean }}
 */
export function decode3dFeatureDetails(buf, index) {
  const off = index * koffi.sizeof('ctl_3d_feature_details_t');
  const valueOff = koffi.offsetof('ctl_3d_feature_details_t', 'Value');
  const featureType = koffi.decode(buf, off + koffi.offsetof('ctl_3d_feature_details_t', 'FeatureType'), 'int32') | 0;
  const valueType = koffi.decode(buf, off + koffi.offsetof('ctl_3d_feature_details_t', 'ValueType'), 'int32') | 0;
  const perAppSupport = koffi.decode(buf, off + koffi.offsetof('ctl_3d_feature_details_t', 'PerAppSupport'), 'bool');
  const u = off + valueOff;
  if (valueType === CTL_PROPERTY_VALUE_TYPE.ENUM) {
    return {
      featureType,
      valueType,
      // uint64 decode may yield a Number when the value fits - normalize to
      // BigInt so bit tests are uniform.
      enumSupportedTypes: BigInt(koffi.decode(buf, u, 'uint64')),
      // M8 finding-2: the v290 ctl_property_info_enum_t is
      // { uint64_t SupportedTypes @0; uint32_t DefaultType @8 } - the field
      // sits at u+8, NOT u+16 (u+16 is the union's trailing padding - the
      // old read returned padding, and the probe record's "DefaultType=0"
      // was a padding read, not the driver value).
      enumDefaultType: koffi.decode(buf, u + 8, 'uint32') | 0,
      intRange: null,
      perAppSupport,
    };
  }
  if (valueType === CTL_PROPERTY_VALUE_TYPE.INT32 || valueType === CTL_PROPERTY_VALUE_TYPE.UINT32) {
    return {
      featureType,
      valueType,
      enumSupportedTypes: null,
      enumDefaultType: null,
      intRange: {
        min: koffi.decode(buf, u + 4, 'int32') | 0,
        max: koffi.decode(buf, u + 8, 'int32') | 0,
        step: koffi.decode(buf, u + 12, 'int32') | 0,
        default: koffi.decode(buf, u + 16, 'int32') | 0,
      },
      perAppSupport,
    };
  }
  return { featureType, valueType, enumSupportedTypes: null, enumDefaultType: null, intRange: null, perAppSupport };
}

/**
 * Build a raw ctl_3d_feature_getset_t buffer (v290, probe-verified).
 * ApplicationName is a null-terminated UTF-8 executable name. An empty name
 * selects the GLOBAL settings scope; a non-empty name selects the driver's
 * per-application profile for that executable. The returned object holds the
 * backing buffer so it stays alive across the driver call.
 * @param {{
 *   featureType: number, valueType: number, bSet: boolean,
 *   enumValue?: number,   // ENUM: Value.EnableType (union offset 32)
 *   intEnable?: boolean,  // INT32/UINT32: Value.Enable (offset 32)
 *   intValue?: number,    // INT32/UINT32: Value.Value (offset 36)
 *   applicationName?: string, // executable name, or "" for global scope
 * }} o
 * @returns {{ buf: unknown, appName: unknown }}
 */
export function encode3dFeatureGetset({ featureType, valueType, bSet, enumValue, intEnable, intValue, applicationName = '' }) {
  const encodedName = Buffer.from(`${typeof applicationName === 'string' ? applicationName : ''}\0`, 'utf8');
  const appName = koffi.alloc('uint8', Math.max(1, encodedName.length));
  for (let i = 0; i < encodedName.length; i += 1) koffi.encode(appName, i, 'uint8', encodedName[i]);
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_3d_feature_getset_t'));
  const valueOff = koffi.offsetof('ctl_3d_feature_getset_t', 'Value');
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'Size'), 'uint32', koffi.sizeof('ctl_3d_feature_getset_t'));
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'Version'), 'uint8', 0);
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'FeatureType'), 'int32', featureType);
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'ApplicationName'), 'void*', koffi.address(appName));
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'ApplicationNameLength'), 'int8', Math.min(127, Math.max(0, encodedName.length - 1)));
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'bSet'), 'bool', bSet === true);
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'ValueType'), 'int32', valueType);
  if (valueType === CTL_PROPERTY_VALUE_TYPE.ENUM) {
    koffi.encode(buf, valueOff, 'uint32', enumValue ?? 0);
  } else {
    koffi.encode(buf, valueOff, 'bool', intEnable === true);
    koffi.encode(buf, valueOff + 4, 'int32', Number.isInteger(intValue) ? intValue : 0);
  }
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'CustomValueSize'), 'int32', 0);
  koffi.encode(buf, koffi.offsetof('ctl_3d_feature_getset_t', 'pCustomValue'), 'void*', 0n);
  return { buf, appName };
}

/**
 * Decode the Value union of a filled ctl_3d_feature_getset_t raw buffer.
 * @param {unknown} buf raw getset buffer
 * @param {number} valueType the buffer's ValueType
 * @returns {{ enableType?: number, enable?: boolean, value?: number }}
 */
export function decode3dFeatureGetsetValue(buf, valueType) {
  const valueOff = koffi.offsetof('ctl_3d_feature_getset_t', 'Value');
  if (valueType === CTL_PROPERTY_VALUE_TYPE.ENUM) {
    return { enableType: koffi.decode(buf, valueOff, 'uint32') | 0 };
  }
  return {
    enable: koffi.decode(buf, valueOff, 'bool'),
    value: koffi.decode(buf, valueOff + 4, 'int32') | 0,
  };
}

// ---------------------------------------------------------------------------
// M10b (the Graphics "Display" view) - display helpers. The raw-buffer
// layouts are the probe-verified v290 offsets (pipeline/live-display-
// feature.md, the byte-truth record); the koffi structs above pin the sizes
// at module load, the CALLS go through raw buffers (the ctlPciGetProperties
// / M8 precedent). The encode helpers allocate the DRIVER-safe buffer sizes
// (the full v290 allocation + headroom - this driver build validates the
// wire-format Size as <=80 but writes its full 96-byte struct anyway) and
// fill the Size field with the DRIVER-SIZE ceiling where it differs from
// the v290 header size.
// ---------------------------------------------------------------------------

const DISPLAY_HEADROOM = 16;

/**
 * Decode a numeric bitmask into the table's name list (the probe's flagsOf).
 * @param {number} flags
 * @param {Record<number, string>} table bit -> name
 * @returns {string[]}
 */
export function displayFlagNames(flags, table) {
  const names = [];
  for (const [bit, name] of Object.entries(table)) {
    if ((flags & (1 << Number(bit))) !== 0) names.push(name);
  }
  return names;
}

/**
 * Allocate a zeroed ctl_display_properties_t raw buffer (Size 200, Version 0).
 * @returns {{ buf: unknown }}
 */
export function encodeDisplayProperties() {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_display_properties_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_display_properties_t'));
  koffi.encode(buf, 4, 'uint8', 0);
  return { buf };
}

/**
 * Decode a filled ctl_display_properties_t raw buffer (the probe's per-field
 * reads at the v290 offsets).
 * @param {unknown} buf
 * @returns {{
 *   type: number, protocolConverterOutput: number, bpcFlags: number,
 *   configFlags: number, featureEnabledFlags: number, featureSupportedFlags: number,
 *   advancedFeatureEnabledFlags: number, advancedFeatureSupportedFlags: number,
 *   timing: { pixelClockHz: number, hActive: number, vActive: number,
 *     hTotal: number, vTotal: number, refreshRate: number,
 *     signalStandard: number, vicId: number },
 * }}
 */
export function decodeDisplayProperties(buf) {
  const t = koffi.offsetof('ctl_display_properties_t', 'Display_Timing_Info');
  const encoderOffset = koffi.offsetof('ctl_display_properties_t', 'Os_display_encoder_handle');
  const encoderBytes = Array.from({ length: 16 }, (_, i) => Number(koffi.decode(buf, encoderOffset + i, 'uint8')));
  const encoderId = encoderBytes.some((value) => value !== 0)
    ? encoderBytes.map((value) => value.toString(16).padStart(2, '0')).join('')
    : null;
  return {
    encoderId,
    type: koffi.decode(buf, koffi.offsetof('ctl_display_properties_t', 'Type'), 'int32') | 0,
    protocolConverterOutput: koffi.decode(buf, koffi.offsetof('ctl_display_properties_t', 'ProtocolConverterOutput'), 'int32') | 0,
    bpcFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_properties_t', 'SupportedOutputBPCFlags'), 'uint32')) >>> 0,
    configFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_properties_t', 'DisplayConfigFlags'), 'uint32')) >>> 0,
    featureEnabledFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_properties_t', 'FeatureEnabledFlags'), 'uint32')) >>> 0,
    featureSupportedFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_properties_t', 'FeatureSupportedFlags'), 'uint32')) >>> 0,
    advancedFeatureEnabledFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_properties_t', 'AdvancedFeatureEnabledFlags'), 'uint32')) >>> 0,
    advancedFeatureSupportedFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_properties_t', 'AdvancedFeatureSupportedFlags'), 'uint32')) >>> 0,
    timing: {
      pixelClockHz: Number(koffi.decode(buf, t + koffi.offsetof('ctl_display_timing_t', 'PixelClock'), 'uint64')),
      hActive: Number(koffi.decode(buf, t + koffi.offsetof('ctl_display_timing_t', 'HActive'), 'uint32')) >>> 0,
      vActive: Number(koffi.decode(buf, t + koffi.offsetof('ctl_display_timing_t', 'VActive'), 'uint32')) >>> 0,
      hTotal: Number(koffi.decode(buf, t + koffi.offsetof('ctl_display_timing_t', 'HTotal'), 'uint32')) >>> 0,
      vTotal: Number(koffi.decode(buf, t + koffi.offsetof('ctl_display_timing_t', 'VTotal'), 'uint32')) >>> 0,
      refreshRate: Number(koffi.decode(buf, t + koffi.offsetof('ctl_display_timing_t', 'RefreshRate'), 'float')),
      signalStandard: koffi.decode(buf, t + koffi.offsetof('ctl_display_timing_t', 'SignalStandard'), 'int32') | 0,
      vicId: Number(koffi.decode(buf, t + koffi.offsetof('ctl_display_timing_t', 'VicId'), 'uint8')),
    },
  };
}

/**
 * Allocate a zeroed ctl_get_set_wire_format_config_t raw buffer for one
 * operation. The Size field carries THIS driver build's ceiling (80 - the
 * probe's size sweep: 96/112/128 answer ERROR_INVALID_SIZE) while the
 * allocation covers the FULL v290 struct + headroom (the driver validates
 * Size<=80 but writes its whole 96-byte struct anyway - the current member
 * at 80-95 IS populated, live-verified).
 * @param {{ operation: number, colorModel?: number, colorDepth?: number }} o
 *   operation: 0 GET / 1 SET / 2 RESTORE_DEFAULT; the SET fills the current
 *   WireFormat member (ColorModel@88, ColorDepth@92 in the full struct).
 * @returns {{ buf: unknown }}
 */
export function encodeWireFormatConfig({ operation, colorModel, colorDepth }) {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_get_set_wire_format_config_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', 80); // the DRIVER ceiling, not the v290 96
  koffi.encode(buf, 4, 'uint8', 0);
  koffi.encode(buf, koffi.offsetof('ctl_get_set_wire_format_config_t', 'Operation'), 'int32', operation);
  const cur = koffi.offsetof('ctl_get_set_wire_format_config_t', 'WireFormat');
  if (Number.isInteger(colorModel)) {
    koffi.encode(buf, cur + koffi.offsetof('ctl_wire_format_t', 'ColorModel'), 'int32', colorModel);
  }
  if (Number.isInteger(colorDepth)) {
    koffi.encode(buf, cur + koffi.offsetof('ctl_wire_format_t', 'ColorDepth'), 'uint32', colorDepth);
  }
  return { buf };
}

/**
 * Decode a filled ctl_get_set_wire_format_config_t raw buffer (a GET
 * result). A supported entry with ColorDepth 0 is an EMPTY driver slot
 * (skipped). THIS driver build never populates the ColorDepth field - the
 * supported list is empty, the current member reports a model only and
 * currentUnavailable is true (the SET is a silent no-op; the COLOR card
 * degrades honestly).
 * @param {unknown} buf
 * @returns {{
 *   supported: Array<{ model: string, depth: number }>,
 *   current: { model: string, depth: number } | null,
 *   currentModel: string | null,
 *   currentUnavailable: boolean,
 * }}
 */
export function decodeWireFormatConfig(buf) {
  const supported = [];
  const supportedOff = koffi.offsetof('ctl_get_set_wire_format_config_t', 'SupportedWireFormat');
  const entrySize = koffi.sizeof('ctl_wire_format_t');
  for (let i = 0; i < 4; i++) {
    const o = supportedOff + i * entrySize;
    const model = koffi.decode(buf, o + koffi.offsetof('ctl_wire_format_t', 'ColorModel'), 'int32') | 0;
    const depth = Number(koffi.decode(buf, o + koffi.offsetof('ctl_wire_format_t', 'ColorDepth'), 'uint32')) >>> 0;
    if (depth === 0) continue; // a zero-filled slot (depth 0 = empty, never a real entry)
    supported.push({ model: CTL_WIRE_COLOR_MODEL[model] ?? `MODEL_${model}`, depth });
  }
  const cur = koffi.offsetof('ctl_get_set_wire_format_config_t', 'WireFormat');
  const currentModel = koffi.decode(buf, cur + koffi.offsetof('ctl_wire_format_t', 'ColorModel'), 'int32') | 0;
  const currentDepth = Number(koffi.decode(buf, cur + koffi.offsetof('ctl_wire_format_t', 'ColorDepth'), 'uint32')) >>> 0;
  return {
    supported,
    current: currentDepth !== 0 ? { model: CTL_WIRE_COLOR_MODEL[currentModel] ?? `MODEL_${currentModel}`, depth: currentDepth } : null,
    currentModel: currentDepth === 0 ? (CTL_WIRE_COLOR_MODEL[currentModel] ?? `MODEL_${currentModel}`) : null,
    currentUnavailable: currentDepth === 0,
  };
}

/**
 * Allocate a zeroed ctl_display_settings_t raw buffer (Size 148 = the v290
 * size AND this driver's ceiling - accepted 148/144/136/128/104/80/56; the
 * 156-byte Set@8 transcription was wrong, live-verified).
 * @param {{ set?: boolean, validFlags?: number, quantizationRange?: number }} o
 *   A GET sets nothing else; a SET carries Set=true + the ValidFlags bitmask
 *   (QUANTIZATION_RANGE = 1<<3) + the QuantizationRange value.
 * @returns {{ buf: unknown }}
 */
export function encodeDisplaySettings({ set = false, validFlags, quantizationRange } = {}) {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_display_settings_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_display_settings_t'));
  koffi.encode(buf, 4, 'uint8', 0);
  koffi.encode(buf, koffi.offsetof('ctl_display_settings_t', 'Set'), 'bool', set === true);
  if (Number.isInteger(validFlags)) {
    koffi.encode(buf, koffi.offsetof('ctl_display_settings_t', 'ValidFlags'), 'uint32', validFlags);
  }
  if (Number.isInteger(quantizationRange)) {
    koffi.encode(buf, koffi.offsetof('ctl_display_settings_t', 'QuantizationRange'), 'int32', quantizationRange);
  }
  return { buf };
}

/**
 * Decode a filled ctl_display_settings_t raw buffer (a GET result) - the
 * TRUE v290 offsets (SupportedFlags@8, ControllableFlags@12, ValidFlags@16,
 * QuantizationRange@32 - live-verified byte-truth).
 * @param {unknown} buf
 * @returns {{ supportedFlags: number, controllableFlags: number, validFlags: number, quantizationRange: number }}
 */
export function decodeDisplaySettings(buf) {
  return {
    supportedFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_settings_t', 'SupportedFlags'), 'uint32')) >>> 0,
    controllableFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_settings_t', 'ControllableFlags'), 'uint32')) >>> 0,
    validFlags: Number(koffi.decode(buf, koffi.offsetof('ctl_display_settings_t', 'ValidFlags'), 'uint32')) >>> 0,
    quantizationRange: koffi.decode(buf, koffi.offsetof('ctl_display_settings_t', 'QuantizationRange'), 'int32') | 0,
  };
}

/**
 * Allocate a zeroed ctl_scaling_settings_t raw buffer (Size 28 = the v290
 * size AND this driver's ceiling - accepted 28/24/16; the 32/24-byte
 * Enable@8 transcriptions were wrong, live-verified). ScalingType is a FLAG
 * value (1=IDENTITY 2=CENTERED 4=STRETCHED 8=ASPECT_RATIO_CENTERED_MAX
 * 16=CUSTOM), not an enum index.
 * @param {{ enable?: boolean, scalingType?: number, customScalingX?: number,
 *   customScalingY?: number, hardwareModeSet?: boolean, preferredScalingType?: number }} o
 * @returns {{ buf: unknown }}
 */
export function encodeScalingSettings({ enable = false, scalingType, customScalingX, customScalingY, hardwareModeSet, preferredScalingType } = {}) {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_scaling_settings_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_scaling_settings_t'));
  koffi.encode(buf, 4, 'uint8', 0);
  koffi.encode(buf, koffi.offsetof('ctl_scaling_settings_t', 'Enable'), 'bool', enable === true);
  if (Number.isInteger(scalingType)) {
    koffi.encode(buf, koffi.offsetof('ctl_scaling_settings_t', 'ScalingType'), 'uint32', scalingType);
  }
  if (Number.isInteger(customScalingX)) {
    koffi.encode(buf, koffi.offsetof('ctl_scaling_settings_t', 'CustomScalingX'), 'uint32', customScalingX);
  }
  if (Number.isInteger(customScalingY)) {
    koffi.encode(buf, koffi.offsetof('ctl_scaling_settings_t', 'CustomScalingY'), 'uint32', customScalingY);
  }
  if (typeof hardwareModeSet === 'boolean') {
    koffi.encode(buf, koffi.offsetof('ctl_scaling_settings_t', 'HardwareModeSet'), 'bool', hardwareModeSet);
  }
  if (Number.isInteger(preferredScalingType)) {
    koffi.encode(buf, koffi.offsetof('ctl_scaling_settings_t', 'PreferredScalingType'), 'uint32', preferredScalingType);
  }
  return { buf };
}

/**
 * Decode a filled ctl_scaling_settings_t raw buffer (a ctlGetCurrentScaling
 * result) - the TRUE v290 offsets (Enable@5, ScalingType@8 FLAG value,
 * CustomX@12, CustomY@16, HardwareModeSet@20, PreferredScalingType@24).
 * @param {unknown} buf
 * @returns {{ enable: boolean, scalingType: number, customX: number, customY: number, hardwareModeSet: boolean, preferredScalingType: number }}
 */
export function decodeScalingSettings(buf) {
  return {
    enable: koffi.decode(buf, koffi.offsetof('ctl_scaling_settings_t', 'Enable'), 'bool'),
    scalingType: Number(koffi.decode(buf, koffi.offsetof('ctl_scaling_settings_t', 'ScalingType'), 'uint32')) >>> 0,
    customX: Number(koffi.decode(buf, koffi.offsetof('ctl_scaling_settings_t', 'CustomScalingX'), 'uint32')) >>> 0,
    customY: Number(koffi.decode(buf, koffi.offsetof('ctl_scaling_settings_t', 'CustomScalingY'), 'uint32')) >>> 0,
    hardwareModeSet: koffi.decode(buf, koffi.offsetof('ctl_scaling_settings_t', 'HardwareModeSet'), 'bool'),
    preferredScalingType: Number(koffi.decode(buf, koffi.offsetof('ctl_scaling_settings_t', 'PreferredScalingType'), 'uint32')) >>> 0,
  };
}

/** Allocate a zeroed ctl_retro_scaling_caps_t raw buffer for the supported
 * retro-scaling capability query. The returned SupportedRetroScaling member
 * is a bitmask whose bits are represented by CTL_RETRO_SCALING_TYPE. */
export function encodeRetroScalingCaps() {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_retro_scaling_caps_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_retro_scaling_caps_t'));
  koffi.encode(buf, 4, 'uint8', 0);
  return { buf };
}

/** Decode the supported retro-scaling bitmask. */
export function decodeRetroScalingCaps(buf) {
  return {
    supportedRetroScaling: Number(koffi.decode(buf, koffi.offsetof('ctl_retro_scaling_caps_t', 'SupportedRetroScaling'), 'uint32')) >>> 0,
  };
}

/**
 * Allocate a zeroed ctl_retro_scaling_settings_t raw buffer (Size 12 = the
 * v290 size AND this driver's ceiling - ONLY 12 is accepted; the 20-byte
 * Get@8 transcription was wrong, live-verified). Get=true reads, Get=false
 * writes (Enable@6 + RetroScalingType@8 - a FLAG value: 1=INTEGER
 * 2=NEAREST_NEIGHBOUR).
 * @param {{ get?: boolean, enable?: boolean, retroScalingType?: number }} o
 * @returns {{ buf: unknown }}
 */
export function encodeRetroScalingSettings({ get = false, enable = false, retroScalingType } = {}) {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_retro_scaling_settings_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_retro_scaling_settings_t'));
  koffi.encode(buf, 4, 'uint8', 0);
  koffi.encode(buf, koffi.offsetof('ctl_retro_scaling_settings_t', 'Get'), 'bool', get === true);
  koffi.encode(buf, koffi.offsetof('ctl_retro_scaling_settings_t', 'Enable'), 'bool', enable === true);
  if (Number.isInteger(retroScalingType)) {
    koffi.encode(buf, koffi.offsetof('ctl_retro_scaling_settings_t', 'RetroScalingType'), 'uint32', retroScalingType);
  }
  return { buf };
}

/**
 * Decode a filled ctl_retro_scaling_settings_t raw buffer (a GET result) -
 * the TRUE v290 offsets (Get@5, Enable@6, RetroScalingType@8 FLAG value).
 * @param {unknown} buf
 * @returns {{ enable: boolean, retroScalingType: number }}
 */
export function decodeRetroScalingSettings(buf) {
  return {
    enable: koffi.decode(buf, koffi.offsetof('ctl_retro_scaling_settings_t', 'Enable'), 'bool'),
    retroScalingType: Number(koffi.decode(buf, koffi.offsetof('ctl_retro_scaling_settings_t', 'RetroScalingType'), 'uint32')) >>> 0,
  };
}

/**
 * Decode a filled ctl_intel_arc_sync_monitor_params_t raw buffer - the TRUE
 * v290 offsets (IsSupported@5, MinRefresh@8, MaxRefresh@12 floats - live
 * 48.0/180.0 on the A770; the 28-byte transcription was wrong, only 24 is
 * accepted).
 * @param {unknown} buf
 * @returns {{ supported: boolean, minRefreshHz: number, maxRefreshHz: number, maxFrameTimeIncreaseUs: number, maxFrameTimeDecreaseUs: number }}
 */
export function decodeArcSyncMonitor(buf) {
  return {
    supported: koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_monitor_params_t', 'IsIntelArcSyncSupported'), 'bool'),
    minRefreshHz: Number(koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_monitor_params_t', 'MinimumRefreshRateInHz'), 'float')),
    maxRefreshHz: Number(koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_monitor_params_t', 'MaximumRefreshRateInHz'), 'float')),
    maxFrameTimeIncreaseUs: Number(koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_monitor_params_t', 'MaxFrameTimeIncreaseInUs'), 'uint32')) >>> 0,
    maxFrameTimeDecreaseUs: Number(koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_monitor_params_t', 'MaxFrameTimeDecreaseInUs'), 'uint32')) >>> 0,
  };
}

/**
 * Decode a filled ctl_intel_arc_sync_profile_params_t raw buffer (profile@8,
 * max refresh@12, min refresh@16 floats - live RECOMMENDED 90.0-180.0 on the
 * A770 - frame-time us@20/24).
 * @param {unknown} buf
 * @returns {{ profile: number, minRefreshHz: number, maxRefreshHz: number, maxFrameTimeIncreaseUs: number, maxFrameTimeDecreaseUs: number }}
 */
export function decodeArcSyncProfile(buf) {
  return {
    profile: koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'IntelArcSyncProfile'), 'int32') | 0,
    minRefreshHz: Number(koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'MinRefreshRateInHz'), 'float')),
    maxRefreshHz: Number(koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'MaxRefreshRateInHz'), 'float')),
    maxFrameTimeIncreaseUs: Number(koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'MaxFrameTimeIncreaseInUs'), 'uint32')) >>> 0,
    maxFrameTimeDecreaseUs: Number(koffi.decode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'MaxFrameTimeDecreaseInUs'), 'uint32')) >>> 0,
  };
}

/** Allocate a ctl_intel_arc_sync_profile_params_t buffer. GET callers leave
 * the values at their defaults; SET callers provide the complete profile
 * record so the driver can preserve its monitor timing parameters. */
export function encodeArcSyncProfile({ profile = 0, minRefreshHz = 0, maxRefreshHz = 0, maxFrameTimeIncreaseUs = 0, maxFrameTimeDecreaseUs = 0 } = {}) {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_intel_arc_sync_profile_params_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_intel_arc_sync_profile_params_t'));
  koffi.encode(buf, 4, 'uint8', 0);
  koffi.encode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'IntelArcSyncProfile'), 'int32', Number.isInteger(profile) ? profile : 0);
  koffi.encode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'MaxRefreshRateInHz'), 'float', Number.isFinite(maxRefreshHz) ? maxRefreshHz : 0);
  koffi.encode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'MinRefreshRateInHz'), 'float', Number.isFinite(minRefreshHz) ? minRefreshHz : 0);
  koffi.encode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'MaxFrameTimeIncreaseInUs'), 'uint32', Number.isInteger(maxFrameTimeIncreaseUs) ? maxFrameTimeIncreaseUs : 0);
  koffi.encode(buf, koffi.offsetof('ctl_intel_arc_sync_profile_params_t', 'MaxFrameTimeDecreaseInUs'), 'uint32', Number.isInteger(maxFrameTimeDecreaseUs) ? maxFrameTimeDecreaseUs : 0);
  return { buf };
}

/**
 * Allocate a zeroed ctl_edid_management_args_t raw buffer (Size 40) for the
 * 2-pass EDID read (READ_EDID + the MONITOR type; pass 1 queries EdidSize
 * with a null buffer, pass 2 fills pEdidBuf).
 * @param {{ edidSize?: number, pEdidBuf?: unknown }} o
 * @returns {{ buf: unknown }}
 */
export function encodeEdidManagementArgs({ edidSize = 0, pEdidBuf = null } = {}) {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_edid_management_args_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_edid_management_args_t'));
  koffi.encode(buf, 4, 'uint8', 0);
  koffi.encode(buf, koffi.offsetof('ctl_edid_management_args_t', 'OpType'), 'int32', CTL_DISPLAY_EDID_OP_READ);
  koffi.encode(buf, koffi.offsetof('ctl_edid_management_args_t', 'EdidType'), 'int32', CTL_DISPLAY_EDID_TYPE_MONITOR);
  koffi.encode(buf, koffi.offsetof('ctl_edid_management_args_t', 'EdidSize'), 'uint32', edidSize);
  koffi.encode(buf, koffi.offsetof('ctl_edid_management_args_t', 'pEdidBuf'), 'void*', pEdidBuf ?? 0n);
  return { buf };
}

/**
 * Allocate a zeroed ctl_panel_descriptor_access_args_t raw buffer (Size 32)
 * for the 2-pass panel-descriptor read (READ + block 0; pass 1 queries
 * DescriptorDataSize with a null buffer, pass 2 fills pDescriptorData).
 * @param {{ dataSize?: number, pData?: unknown }} o
 * @returns {{ buf: unknown }}
 */
export function encodePanelDescriptorArgs({ dataSize = 0, pData = null } = {}) {
  const buf = koffi.alloc('uint8', koffi.sizeof('ctl_panel_descriptor_access_args_t') + DISPLAY_HEADROOM);
  koffi.encode(buf, 0, 'uint32', koffi.sizeof('ctl_panel_descriptor_access_args_t'));
  koffi.encode(buf, 4, 'uint8', 0);
  koffi.encode(buf, koffi.offsetof('ctl_panel_descriptor_access_args_t', 'OpType'), 'int32', CTL_PANEL_DESCRIPTOR_OP_READ);
  koffi.encode(buf, koffi.offsetof('ctl_panel_descriptor_access_args_t', 'BlockNumber'), 'uint32', 0);
  koffi.encode(buf, koffi.offsetof('ctl_panel_descriptor_access_args_t', 'DescriptorDataSize'), 'uint32', dataSize);
  koffi.encode(buf, koffi.offsetof('ctl_panel_descriptor_access_args_t', 'pDescriptorData'), 'void*', pData ?? 0n);
  return { buf };
}

/**
 * Extract the EDID block-0 monitor name (the 0xFC display-name descriptor:
 * 00 00 00 FC 00 <13 ASCII> 0A 20 at 0x36 + n*18). Null when the descriptor
 * is absent. The probe's exact parser (the MSI G27C4 E3 read on the A770).
 * @param {unknown} data EDID buffer (128 bytes for block 0)
 * @param {number} size
 * @returns {string | null}
 */
export function edidMonitorName(data, size) {
  const n = Math.min(size, 128);
  const bytes = [];
  for (let i = 0; i < n; i++) bytes.push(Number(koffi.decode(data, i, 'uint8')));
  for (let o = 0x36; o + 18 <= n; o += 18) {
    if (bytes[o] === 0 && bytes[o + 1] === 0 && bytes[o + 2] === 0
      && bytes[o + 3] === 0xfc && bytes[o + 4] === 0) {
      const name = bytes.slice(o + 5, o + 18)
        .filter((b) => b >= 0x20 && b < 0x7f)
        .map((b) => String.fromCharCode(b)).join('')
        .replace(/[ \t]+$/, '');
      if (name.trim().length > 0) return name.trim();
    }
  }
  return null;
}
