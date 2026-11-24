//! Foundational read-only IGCL boundary; loading is explicit, never automatic.
//! ABI verified against Intel's primary header at commit
//! 52c15725b52e372ca53a9896976cf08f47a39053:
//! https://github.com/intel/drivers.gpu.control-library/blob/52c15725b52e372ca53a9896976cf08f47a39053/include/igcl_api.h
//! Local parity: src/main/backend/igcl-bindings.js and igcl-backend.js.
//! Enumeration symbols are mandatory; control/fan/VF/display getters bind
//! optionally.
use super::fan_apply::{FanBackend, FanConfig};
use super::gpu_apply::{ScalarBackend, ScalarControl, ScalarUnits};
use super::gpu_units::igcl_to_canonical;
use super::lock_apply::LockBackend;
use super::vf_apply::VfBackend;
use super::display_color_capabilities::{
    classify_color_capability_blocks, ColorCapabilityClassification,
    ColorTransformBlockMetadata,
};
use super::igcl_raw::{
    ctl_3d_feature_caps_t, ctl_3d_feature_details_t, ctl_3d_feature_getset_t,
    ctl_fan_config_t, ctl_fan_properties_t, ctl_fan_speed_t, ctl_fan_speed_table_t,
    ctl_fan_temp_speed_t, ctl_oc_properties_t, ctl_oc_vf_pair_t, ctl_voltage_frequency_point_t,
    ctlEnumFansFn, ctlFanGetConfigFn, ctlFanGetPropertiesFn, ctlFanSetDefaultModeFn,
    ctlFanSetFixedSpeedModeFn, ctlFanSetSpeedTableModeFn, ctlGetSupported3DCapabilitiesFn,
    ctlGetSet3DFeatureFn,
    ctlOverclockGetPropertiesFn, ctlOverclockGpuFrequencyOffsetGetV2Fn, ctlOverclockGpuFrequencyOffsetSetV2Fn,
    ctlOverclockGpuLockGetFn, ctlOverclockGpuLockSetFn, ctlOverclockGpuMaxVoltageOffsetGetV2Fn, ctlOverclockGpuMaxVoltageOffsetSetV2Fn,
    ctlOverclockResetToDefaultFn,
    ctlOverclockPowerLimitGetV2Fn, ctlOverclockPowerLimitSetV2Fn, ctlOverclockReadVFCurveFn,
    ctlOverclockTemperatureLimitGetV2Fn, ctlOverclockTemperatureLimitSetV2Fn, ctlOverclockVramMemSpeedLimitGetV2Fn,
    ctlOverclockVramMemSpeedLimitSetV2Fn, ctlOverclockWaiverSetFn, ctlOverclockWriteCustomVFCurveFn,
    ctlOverclockPowerLimitGetFn, ctlOverclockPowerLimitSetFn,
    ctlOverclockTemperatureLimitGetFn, ctlOverclockTemperatureLimitSetFn,
    ctl_display_properties_t, ctl_display_settings_t, ctl_edid_management_args_t,
    ctl_intel_arc_sync_monitor_params_t, ctl_intel_arc_sync_profile_params_t,
    ctl_get_set_wire_format_config_t, ctl_retro_scaling_caps_t, ctl_retro_scaling_settings_t,
    ctl_scaling_caps_t, ctl_scaling_settings_t, ctl_wire_format_t,
    ctlEnumerateDisplayOutputsFn, ctlEdidManagementFn, ctlGetCurrentScalingFn, ctlSetCurrentScalingFn,
    ctlGetDisplayPropertiesFn, ctlGetSetDisplaySettingsFn, ctlGetSetRetroScalingFn,
    ctlPciGetPropertiesFn,
    ctlGetIntelArcSyncInfoForMonitorFn, ctlGetIntelArcSyncProfileFn, ctlSetIntelArcSyncProfileFn,
    ctlGetSetWireFormatFn, ctlGetSupportedRetroScalingCapabilityFn,
    ctlGetSupportedScalingCapabilityFn, ctlPanelDescriptorAccessFn,
    ctlPixelTransformationGetConfigFn, ctlPixelTransformationSetConfigFn,
    ctl_panel_descriptor_access_args_t,
};
use serde::Serialize;
use std::{ffi::{c_void, CString}, fmt, marker::PhantomData, path::Path, ptr, rc::Rc};

type Handle = *mut c_void;
const SUCCESS: u32 = 0;
const STILL_OPEN_BY_ANOTHER_CALLER: u32 = 1;
const ERROR_IGSC_LOADER: u32 = 0x4001_0001;
const ERROR_NOT_AVAILABLE: u32 = 0x4000_0007;
#[cfg(test)]
const ERROR_DATA_READ: u32 = 0x4000_0012;
const ERROR_UNSUPPORTED_FEATURE: u32 = 0x4000_000a;
const ERROR_INVALID_ARGUMENT: u32 = 0x4000_000b;
const ERROR_INVALID_NULL_HANDLE: u32 = 0x4000_000d;
const ERROR_INVALID_SIZE: u32 = 0x4000_000f;
const ERROR_UNSUPPORTED_VERSION: u32 = 0x4000_0009;
/// FAN-enum percent units used by the table/fixed ABI (not CTL_UNITS 11).
const FAN_CONTROL_UNITS: i32 = 1;
const FAN_MODE_DEFAULT: i32 = 0;
const FAN_MODE_FIXED: i32 = 1;
const FAN_MODE_TABLE: i32 = 2;
const FAN_PROBE_MAX_POINTS: usize = 10;
const USE_LEVEL_ZERO: u32 = 1;
const IGSC_FULL: u32 = 2;
// Defensive allocation bound, not an IGCL capability or adapter limit.
const MAX_ENUMERATED_HANDLES: u32 = 4096;
/// Electron's display-output count sanity cap (`count < 64`).
const MAX_DISPLAY_OUTPUTS: u32 = 64;
/// EDID/panel-descriptor block bounds from `_readDisplayEdid`.
const DISPLAY_BLOCK_MIN: u32 = 128;
const DISPLAY_BLOCK_MAX: u32 = 4096;
/// Electron allocates this many writable bytes after the Arc Sync profile ABI record.
const ARC_SYNC_PROFILE_HEADROOM: usize = 16;
/// ctl_display_edid_op_type_t / ctl_panel_descriptor_op_type_t READ.
const DISPLAY_BLOCK_OP_READ: i32 = 1;
/// ctl_display_edid_type_t MONITOR.
const DISPLAY_EDID_TYPE_MONITOR: i32 = 3;
/// `ctl_pixel_transformation_*` raw-buffer layout from the oracle: the local
/// IGCL headers do not declare these structs, so the probe-verified byte
/// offsets are isolated here and only the output format is decoded.
const PIXEL_GET_CONFIG_SIZE: usize = 272;
const PIXEL_FORMAT_SIZE: u32 = 120;
const PIXEL_BLOCK_CONFIG_SIZE: usize = 144;
const PIXEL_MATRIX_CONFIG_SIZE: u32 = 128;
const PIXEL_LUT_CONFIG_SIZE: u32 = 40;
const PIXEL_SET_CONFIG_SIZE: usize = 32;
const PIXEL_QUERY_CAPABILITIES: u32 = 0;
const PIXEL_BLOCK_LUT_1D: u32 = 1;
const PIXEL_BLOCK_MATRIX_3X3: u32 = 3;
const PIXEL_SET_CUSTOM: u32 = 2;
const PIXEL_MAX_BLOCKS: u32 = 64;
const PIXEL_MAX_LUT_SAMPLES: u32 = 8192;

/// The one pixel-transformation field the Display read consumes: the output
/// colour model and its bits-per-colour. `bits` is signed because the oracle
/// decodes the driver's uint32 through an int32.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct PixelTransformation {
    pub(crate) output_model: i32,
    pub(crate) output_bits_per_color: i32,
}

#[derive(Clone, Debug)]
struct PixelColorCapabilityBlock {
    id: u32,
    block_type: u32,
    sampling_type: Option<u32>,
    samples_per_channel: Option<u32>,
    channels: Option<u32>,
    raw: Vec<u8>,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ApplicationId { data1: u32, data2: u16, data3: u16, data4: [u8; 8] }
#[repr(C)]
#[derive(Clone, Copy, Debug)]
struct InitArgs {
    size: u32, version: u8, app_version: u32, flags: u32,
    supported_version: u32, application_uid: ApplicationId,
}
impl InitArgs {
    fn new(flags: u32) -> Self {
        Self { size: std::mem::size_of::<Self>() as u32, version: 0,
            app_version: (1 << 16) | 1, flags, supported_version: 0,
            application_uid: ApplicationId::default() }
    }
}
#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct FirmwareVersion { major: u64, minor: u64, build: u64 }
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
pub struct AdapterBdf { pub bus: u8, pub device: u8, pub function: u8 }
#[repr(C)]
struct AdapterProperties {
    size: u32, version: u8, device_id: *mut c_void, device_id_size: u32,
    device_type: i32, supported_subfunction_flags: u32, driver_version: u64,
    firmware_version: FirmwareVersion, pci_vendor_id: u32, pci_device_id: u32,
    rev_id: u32, num_eus_per_sub_slice: u32, num_sub_slices_per_slice: u32,
    num_slices: u32, name: [u8; 100], graphics_adapter_properties: u32,
    frequency: u32, pci_subsys_id: u16, pci_subsys_vendor_id: u16,
    adapter_bdf: AdapterBdf, num_xe_cores: u32, reserved: [u8; 108],
}
#[repr(C, align(8))]
struct DeviceId([u8; 8]);
impl AdapterProperties {
    fn new(luid: &mut DeviceId) -> Self {
        // All-zero scalars, byte arrays and a null raw pointer are valid here.
        let mut value: Self = unsafe { std::mem::zeroed() };
        value.size = std::mem::size_of::<Self>() as u32;
        value.version = 3;
        value.device_id = luid.0.as_mut_ptr().cast();
        value.device_id_size = luid.0.len() as u32;
        value
    }
}

// CTL_APICALL is explicitly __cdecl in Intel's header, hence extern "C".
type InitFn = unsafe extern "C" fn(*mut InitArgs, *mut Handle) -> u32;
type CloseFn = unsafe extern "C" fn(Handle) -> u32;
type EnumerateFn = unsafe extern "C" fn(Handle, *mut u32, *mut Handle) -> u32;
type PropertiesFn = unsafe extern "C" fn(Handle, *mut AdapterProperties) -> u32;
#[derive(Clone, Copy)]
#[allow(dead_code)] // setter fields are bound for the native apply slice
struct Functions {
    init: InitFn, close: CloseFn, enumerate: EnumerateFn, properties: PropertiesFn,
    pci_properties: Option<ctlPciGetPropertiesFn>,
    overclock: Option<ctlOverclockGetPropertiesFn>,
    supported_3d: Option<ctlGetSupported3DCapabilitiesFn>,
    set_3d: Option<ctlGetSet3DFeatureFn>,
    enum_fans: Option<ctlEnumFansFn>,
    fan: Option<ctlFanGetPropertiesFn>,
    fan_config: Option<ctlFanGetConfigFn>,
    fan_set_default: Option<ctlFanSetDefaultModeFn>,
    fan_set_fixed: Option<ctlFanSetFixedSpeedModeFn>,
    fan_set_table: Option<ctlFanSetSpeedTableModeFn>,

    power_limit: Option<ctlOverclockPowerLimitGetV2Fn>,
    temp_limit: Option<ctlOverclockTemperatureLimitGetV2Fn>,
    voltage_offset: Option<ctlOverclockGpuMaxVoltageOffsetGetV2Fn>,
    frequency_offset: Option<ctlOverclockGpuFrequencyOffsetGetV2Fn>,
    vram_freq: Option<ctlOverclockVramMemSpeedLimitGetV2Fn>,
    power_limit_set: Option<ctlOverclockPowerLimitSetV2Fn>,
    temp_limit_set: Option<ctlOverclockTemperatureLimitSetV2Fn>,
    voltage_offset_set: Option<ctlOverclockGpuMaxVoltageOffsetSetV2Fn>,
    frequency_offset_set: Option<ctlOverclockGpuFrequencyOffsetSetV2Fn>,
    vram_freq_set: Option<ctlOverclockVramMemSpeedLimitSetV2Fn>,
    vf_write: Option<ctlOverclockWriteCustomVFCurveFn>,
    overclock_reset: Option<ctlOverclockResetToDefaultFn>,
    waiver_set: Option<ctlOverclockWaiverSetFn>,
    legacy_power_get: Option<ctlOverclockPowerLimitGetFn>,
    legacy_power_set: Option<ctlOverclockPowerLimitSetFn>,
    legacy_temp_get: Option<ctlOverclockTemperatureLimitGetFn>,
    legacy_temp_set: Option<ctlOverclockTemperatureLimitSetFn>,
    gpu_lock: Option<ctlOverclockGpuLockGetFn>,
    gpu_lock_set: Option<ctlOverclockGpuLockSetFn>,
    vf_curve: Option<ctlOverclockReadVFCurveFn>,

    // Display surface read exports plus the two EDID paths and the
    // colour-path/scaling/Arc Sync GETs.
    // `ctlGetSetDisplaySettings`, `ctlGetSetWireFormat` and
    // `ctlGetSetRetroScaling` is shared with SET; the read path calls it in
    // GET mode only (`Get = 1`). Its write is reachable only through the
    // separate private DisplayApplyIgcl facade.
    // The Arc Sync profile setter is bound only to mirror the oracle's
    // capability metadata; this slice never calls it.
    enumerate_displays: Option<ctlEnumerateDisplayOutputsFn>,
    display_properties: Option<ctlGetDisplayPropertiesFn>,
    display_settings: Option<ctlGetSetDisplaySettingsFn>,
    edid: Option<ctlEdidManagementFn>,
    panel_descriptor: Option<ctlPanelDescriptorAccessFn>,
    wire_format: Option<ctlGetSetWireFormatFn>,
    pixel_transformation: Option<ctlPixelTransformationGetConfigFn>,
    // The read-only layer reports whether matching SET exports exist but
    // never invokes them. Display setters are reachable only through the
    // separate private DisplayApplyIgcl facade.
    pixel_transformation_set: Option<ctlPixelTransformationSetConfigFn>,
    scaling_caps: Option<ctlGetSupportedScalingCapabilityFn>,
    current_scaling: Option<ctlGetCurrentScalingFn>,
    // Bound optionally for the private scaling apply facade; the ordinary
    // Display reader never invokes it.
    set_current_scaling: Option<ctlSetCurrentScalingFn>,
    retro_scaling_caps: Option<ctlGetSupportedRetroScalingCapabilityFn>,
    retro_scaling: Option<ctlGetSetRetroScalingFn>,
    arc_sync_monitor: Option<ctlGetIntelArcSyncInfoForMonitorFn>,
    arc_sync_profile_get: Option<ctlGetIntelArcSyncProfileFn>,
    // Bound only so the read surface can report Electron's control-capability
    // bit. This native slice never calls the setter.
    arc_sync_profile_set: Option<ctlSetIntelArcSyncProfileFn>,
}

#[derive(Debug)]
pub struct IgclError { pub operation: &'static str, pub status: Option<u32>, pub detail: String }
impl IgclError {
    fn local(operation: &'static str, detail: impl Into<String>) -> Self {
        Self { operation, status: None, detail: detail.into() }
    }
    fn native(operation: &'static str, status: u32) -> Self {
        Self { operation, status: Some(status), detail: format!("IGCL returned 0x{status:08x}") }
    }
}
impl fmt::Display for IgclError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}: {}", self.operation, self.detail) }
}
impl std::error::Error for IgclError {}

/// Owned data only: no native pointer escapes the session.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterInfo {
    pub index: usize, pub name: String, pub device_type: i32,
    pub pci_vendor_id: u32, pub pci_device_id: u32, pub rev_id: u32,
    pub pci_subsys_id: u16, pub pci_subsys_vendor_id: u16,
    pub bdf: AdapterBdf, pub luid: Option<String>, pub driver_version: String,
    pub graphics_adapter_properties: u32, pub graphics_clock_mhz: u32, pub num_xe_cores: u32,
}

/// Confined to its creating thread. Call `close` to observe cleanup failures;
/// Drop is a fallback. A DLL is deliberately retained if native close fails,
/// because unloading code while the native context may remain alive is unsafe.
pub struct ReadOnlyIgcl {
    functions: Functions, api: Handle, close_failed: bool,
    pub igsc_full_available: bool,
    legacy_properties: bool,
    handles: Vec<Handle>,
    #[cfg(windows)]
    library: Option<Library>,
    _thread_affinity: PhantomData<Rc<()>>,
}

/// Narrow, explicit write capability for private Display setter transactions.
/// The ordinary Display reader keeps using `ReadOnlyIgcl` and never receives
/// this facade.
pub(crate) struct DisplayApplyIgcl<'a> {
    session: &'a ReadOnlyIgcl,
}

pub(crate) struct ControlSnapshot {
    pub(crate) oc: ctl_oc_properties_t,
    pub(crate) fan: ctl_fan_properties_t,
    pub(crate) fan_config: Option<ctl_fan_config_t>,
    pub(crate) power_limit: Option<f64>,
    pub(crate) temp_limit: Option<f64>,
    pub(crate) voltage_offset: Option<f64>,
    pub(crate) frequency_offset: Option<f64>,
    pub(crate) vram_freq: Option<f64>,
    pub(crate) gpu_lock: Option<ctl_oc_vf_pair_t>,
    pub(crate) vf_stock: Option<Vec<ctl_voltage_frequency_point_t>>,
    pub(crate) vf_live: Option<Vec<ctl_voltage_frequency_point_t>>,
}

/// Result of the reversible fan write probe; mirrors Electron's
/// `{probeOk, writeAccepted, fixedOk}` shape.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct FanProbe {
    pub(crate) probe_ok: bool,
    pub(crate) write_accepted: bool,
    pub(crate) fixed_ok: bool,
}

/// Raw IGCL V2 scalar adapter for the apply core. It performs exactly one
/// setter/getter call per method; clamping/validation lives in `gpu_apply`.
#[allow(dead_code)] // wired after the write-verification approval
pub(crate) struct IgclScalarBackend<'a> {
    session: &'a ReadOnlyIgcl,
    handle: Handle,
}

impl ScalarBackend for IgclScalarBackend<'_> {
    fn set_scalar(&mut self, control: ScalarControl, igcl_value: f64) -> u32 {
        let function = match control {
            ScalarControl::GpuFreqOffset => self.session.functions.frequency_offset_set.map(|function| function as unsafe extern "C" fn(*mut c_void, f64) -> u32),
            ScalarControl::GpuVoltOffset => self.session.functions.voltage_offset_set.map(|function| function as unsafe extern "C" fn(*mut c_void, f64) -> u32),
            ScalarControl::PowerLimit => self.session.functions.power_limit_set.map(|function| function as unsafe extern "C" fn(*mut c_void, f64) -> u32),
            ScalarControl::TempLimit => self.session.functions.temp_limit_set.map(|function| function as unsafe extern "C" fn(*mut c_void, f64) -> u32),
            ScalarControl::VramFreqOffset => self.session.functions.vram_freq_set.map(|function| function as unsafe extern "C" fn(*mut c_void, f64) -> u32),
        };
        match function {
            Some(function) => unsafe { function(self.handle, igcl_value) },
            None => ERROR_UNSUPPORTED_FEATURE,
        }
    }

    fn get_scalar(&mut self, control: ScalarControl) -> Result<f64, u32> {
        let function = match control {
            ScalarControl::GpuFreqOffset => self.session.functions.frequency_offset.map(|function| function as unsafe extern "C" fn(*mut c_void, *mut f64) -> u32),
            ScalarControl::GpuVoltOffset => self.session.functions.voltage_offset.map(|function| function as unsafe extern "C" fn(*mut c_void, *mut f64) -> u32),
            ScalarControl::PowerLimit => self.session.functions.power_limit.map(|function| function as unsafe extern "C" fn(*mut c_void, *mut f64) -> u32),
            ScalarControl::TempLimit => self.session.functions.temp_limit.map(|function| function as unsafe extern "C" fn(*mut c_void, *mut f64) -> u32),
            ScalarControl::VramFreqOffset => self.session.functions.vram_freq.map(|function| function as unsafe extern "C" fn(*mut c_void, *mut f64) -> u32),
        };
        let Some(function) = function else { return Err(ERROR_UNSUPPORTED_FEATURE); };
        let mut value = 0.0_f64;
        let status = unsafe { function(self.handle, &mut value) };
        if status == SUCCESS { Ok(value) } else { Err(status) }
    }
}

/// Raw IGCL VF adapter for the native curve write core (staged until the
/// live VF verification is explicitly approved).
#[allow(dead_code)]
pub(crate) struct IgclVfBackend<'a> {
    session: &'a ReadOnlyIgcl,
    handle: Handle,
    units: ScalarUnits,
}

impl IgclVfBackend<'_> {
    #[allow(dead_code)] // trait methods below are the staged public surface
    fn read(&self, kind: i32) -> Result<Vec<(u32, u32)>, u32> {
        self.session.read_vf_points(self.handle, kind)
            .map(|points| points.iter().map(|point| (point.Voltage, point.Frequency)).collect())
    }
}

impl VfBackend for IgclVfBackend<'_> {
    fn read_stock(&mut self) -> Result<Vec<(u32, u32)>, u32> { self.read(0) }
    fn read_live(&mut self) -> Result<Vec<(u32, u32)>, u32> { self.read(1) }

    fn write_curve(&mut self, points: &[(u32, u32)]) -> u32 {
        let Some(function) = self.session.functions.vf_write else { return ERROR_UNSUPPORTED_FEATURE; };
        let Ok(count) = u32::try_from(points.len()) else { return ERROR_INVALID_ARGUMENT; };
        let mut native: Vec<ctl_voltage_frequency_point_t> = points.iter()
            .map(|(voltage, frequency)| ctl_voltage_frequency_point_t { Voltage: *voltage, Frequency: *frequency })
            .collect();
        unsafe { function(self.handle, count, native.as_mut_ptr()) }
    }

    fn read_offsets(&mut self) -> Result<(f64, f64), u32> {
        let frequency = self.session.functions.frequency_offset.ok_or(ERROR_UNSUPPORTED_FEATURE)?;
        let voltage = self.session.functions.voltage_offset.ok_or(ERROR_UNSUPPORTED_FEATURE)?;
        let mut frequency_value = 0.0_f64;
        let mut voltage_value = 0.0_f64;
        let frequency_status = unsafe { frequency(self.handle, &mut frequency_value) };
        if frequency_status != SUCCESS { return Err(frequency_status); }
        let voltage_status = unsafe { voltage(self.handle, &mut voltage_value) };
        if voltage_status != SUCCESS { return Err(voltage_status); }
        Ok((
            igcl_to_canonical(frequency_value, f64::from(self.units.gpu_freq_offset)),
            igcl_to_canonical(voltage_value, f64::from(self.units.gpu_volt_offset)),
        ))
    }
}

/// Raw IGCL fan adapter for the native fan apply core.
#[allow(dead_code)] // staged until fan apply is wired
pub(crate) struct IgclFanBackend<'a> {
    session: &'a ReadOnlyIgcl,
    fan: Handle,
}

impl FanBackend for IgclFanBackend<'_> {
    fn set_table(&mut self, points: &[(u32, i32)]) -> u32 {
        let Some(function) = self.session.functions.fan_set_table else { return ERROR_UNSUPPORTED_FEATURE; };
        let mut table = fan_table(points);
        unsafe { function(self.fan, &mut table) }
    }
    fn set_fixed(&mut self, percent: i32) -> u32 {
        let Some(function) = self.session.functions.fan_set_fixed else { return ERROR_UNSUPPORTED_FEATURE; };
        let mut speed = fan_speed(percent);
        unsafe { function(self.fan, &mut speed) }
    }
    fn set_default(&mut self) -> u32 {
        let Some(function) = self.session.functions.fan_set_default else { return ERROR_UNSUPPORTED_FEATURE; };
        unsafe { function(self.fan) }
    }
    fn read_config(&mut self) -> Result<FanConfig, u32> {
        let Some(function) = self.session.functions.fan_config else { return Err(ERROR_UNSUPPORTED_FEATURE); };
        let config = self.session.read_fan_config(self.fan, function).ok_or(ERROR_INVALID_ARGUMENT)?;
        Ok(FanConfig {
            mode: config.mode,
            table: (0..config.speedTable.numPoints.max(0) as usize).take(32)
                .map(|index| {
                    let point = &config.speedTable.table[index];
                    (point.temperature as i32, point.speed.speed, point.speed.units)
                }).collect(),
            fixed_speed: config.speedFixed.speed,
            fixed_units: config.speedFixed.units,
        })
    }
}

/// Raw IGCL lock adapter for the native lock apply core.
#[allow(dead_code)] // staged until lock apply is wired
pub(crate) struct IgclLockBackend<'a> {
    session: &'a ReadOnlyIgcl,
    handle: Handle,
}

impl LockBackend for IgclLockBackend<'_> {
    fn set_lock(&mut self, voltage_mv: i64, freq_mhz: i64) -> u32 {
        let Some(function) = self.session.functions.gpu_lock_set else { return ERROR_UNSUPPORTED_FEATURE; };
        let pair = ctl_oc_vf_pair_t {
            Size: std::mem::size_of::<ctl_oc_vf_pair_t>() as u32,
            Version: 0,
            Voltage: voltage_mv as f64,
            Frequency: freq_mhz as f64,
        };
        unsafe { function(self.handle, pair) }
    }
    fn get_lock(&mut self) -> Result<(f64, f64), u32> {
        let Some(function) = self.session.functions.gpu_lock else { return Err(ERROR_UNSUPPORTED_FEATURE); };
        let mut pair: ctl_oc_vf_pair_t = unsafe { std::mem::zeroed() };
        pair.Size = std::mem::size_of::<ctl_oc_vf_pair_t>() as u32;
        pair.Version = 0;
        let status = unsafe { function(self.handle, &mut pair) };
        if status != SUCCESS { return Err(status); }
        Ok((pair.Voltage / 1000.0, pair.Frequency))
    }
}

/// A nested `ctl_wire_format_t` with its own Size/Version header.
fn wire_format_header() -> ctl_wire_format_t {
    let mut header: ctl_wire_format_t = unsafe { std::mem::zeroed() };
    header.Size = std::mem::size_of::<ctl_wire_format_t>() as u32;
    header.Version = 0;
    header
}

/// Electron allocates sixteen zeroed bytes after the 92-byte wire-format
/// config for both GET and SET. Keep the same headroom; the outer config
/// pointer remains correctly aligned and its declared ABI size stays 92.
#[repr(C)]
struct WireFormatBuffer {
    config: ctl_get_set_wire_format_config_t,
    _headroom: [u8; 16],
}

fn wire_format_buffer(operation: i32, target: Option<(i32, u32)>) -> WireFormatBuffer {
    let mut buffer: WireFormatBuffer = unsafe { std::mem::zeroed() };
    buffer.config.Size = std::mem::size_of::<ctl_get_set_wire_format_config_t>() as u32;
    buffer.config.Version = 0;
    buffer.config.Operation = operation; // GET=0 / SET=1 / RESTORE_DEFAULT=2
    for entry in buffer.config.SupportedWireFormat.iter_mut() { *entry = wire_format_header(); }
    buffer.config.WireFormat = wire_format_header();
    if let Some((model, depth_flag)) = target {
        buffer.config.WireFormat.ColorModel = model;
        buffer.config.WireFormat.ColorDepth = depth_flag;
    }
    buffer
}

/// The pixel-transformation buffers are raw bytes with a pointer at offset 264,
/// so their storage must be pointer-aligned. `Vec<u64>` guarantees it.
fn zeroed_aligned(size: usize) -> Vec<u64> { vec![0; size.div_ceil(8)] }

fn aligned_bytes_mut(words: &mut [u64]) -> &mut [u8] {
    // SAFETY: the slice covers exactly the words' own storage, is uniquely
    // borrowed for the returned lifetime, and u8 has no invalid bit patterns.
    unsafe { std::slice::from_raw_parts_mut(words.as_mut_ptr().cast(), words.len() * 8) }
}

fn write_u32(buffer: &mut [u8], offset: usize, value: u32) {
    buffer[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn read_u32(buffer: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(buffer[offset..offset + 4].try_into().unwrap_or([0; 4]))
}

#[cfg(test)]
fn read_u64(buffer: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(buffer[offset..offset + 8].try_into().unwrap_or([0; 8]))
}

#[cfg(test)]
fn read_f64(buffer: &[u8], offset: usize) -> f64 { f64::from_bits(read_u64(buffer, offset)) }

fn write_u64(buffer: &mut [u8], offset: usize, value: u64) {
    buffer[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

/// `pixelGetConfigBuffer`: the fixed 272-byte header plus the optional block
/// list. Query type 0 is the capability read the Display surface uses.
fn write_pixel_config_header(buffer: &mut [u8], count: u32, blocks: u64) {
    write_u32(buffer, 0, PIXEL_GET_CONFIG_SIZE as u32);
    buffer[4] = 0;
    write_u32(buffer, 8, PIXEL_QUERY_CAPABILITIES);
    write_u32(buffer, 16, PIXEL_FORMAT_SIZE);
    write_u32(buffer, 136, PIXEL_FORMAT_SIZE);
    write_u32(buffer, 256, count);
    write_u64(buffer, 264, blocks);
}

/// The capability query's header mirrors `makePipeGet` in the Electron
/// implementation. In particular, it leaves the output-format slots zeroed;
/// those fields belong to the separate output-format query above.
fn write_pixel_capability_header(buffer: &mut [u8], count: u32, blocks: u64) {
    write_u32(buffer, 0, PIXEL_GET_CONFIG_SIZE as u32);
    buffer[4] = 0;
    write_u32(buffer, 8, PIXEL_QUERY_CAPABILITIES);
    write_u32(buffer, 256, count);
    write_u64(buffer, 264, blocks);
}

fn query_pixel_color_capability_blocks(
    function: ctlPixelTransformationGetConfigFn,
    handle: Handle,
) -> Result<Vec<PixelColorCapabilityBlock>, IgclError> {
    if handle.is_null() {
        return Err(IgclError::native("ctlPixelTransformationGetConfig", ERROR_INVALID_NULL_HANDLE));
    }
    let mut count_words = zeroed_aligned(PIXEL_GET_CONFIG_SIZE + 16);
    let count_buffer = aligned_bytes_mut(&mut count_words);
    write_pixel_capability_header(count_buffer, 0, 0);
    let count_status = unsafe { function(handle, count_buffer.as_mut_ptr().cast()) };
    let count = read_u32(count_buffer, 256);
    if count_status != SUCCESS && count_status != ERROR_INVALID_SIZE {
        return Err(IgclError::native("ctlPixelTransformationGetConfig(CAPABILITY count)", count_status));
    }
    if !(1..=PIXEL_MAX_BLOCKS).contains(&count) {
        return Err(IgclError::local("ctlPixelTransformationGetConfig", format!("unsafe capability block count ({count})")));
    }

    let block_bytes_len = PIXEL_BLOCK_CONFIG_SIZE * count as usize + 16;
    let mut block_words = zeroed_aligned(block_bytes_len);
    let blocks = aligned_bytes_mut(&mut block_words);
    for index in 0..count as usize {
        let offset = index * PIXEL_BLOCK_CONFIG_SIZE;
        write_u32(blocks, offset, PIXEL_BLOCK_CONFIG_SIZE as u32);
        blocks[offset + 4] = 0;
    }
    let block_address = blocks.as_mut_ptr() as usize as u64;
    let mut config_words = zeroed_aligned(PIXEL_GET_CONFIG_SIZE + 16);
    let config = aligned_bytes_mut(&mut config_words);
    write_pixel_capability_header(config, count, block_address);
    let status = unsafe { function(handle, config.as_mut_ptr().cast()) };
    if status != SUCCESS {
        return Err(IgclError::native("ctlPixelTransformationGetConfig(CAPABILITY)", status));
    }
    let returned_count = read_u32(config, 256);
    if !(1..=count).contains(&returned_count) {
        return Err(IgclError::local("ctlPixelTransformationGetConfig", format!("invalid returned capability block count ({returned_count})")));
    }
    let mut output = Vec::with_capacity(returned_count as usize);
    for index in 0..returned_count as usize {
        let offset = index * PIXEL_BLOCK_CONFIG_SIZE;
        let block = &mut blocks[offset..offset + PIXEL_BLOCK_CONFIG_SIZE];
        if read_u32(block, 0) != PIXEL_BLOCK_CONFIG_SIZE as u32 {
            return Err(IgclError::local("ctlPixelTransformationGetConfig", format!("invalid capability block size at index {index}")));
        }
        let block_type = read_u32(block, 12);
        let is_lut = block_type == PIXEL_BLOCK_LUT_1D;
        let id = read_u32(block, 8);
        let sampling_type = is_lut.then(|| read_u32(block, 24));
        let samples_per_channel = is_lut.then(|| read_u32(block, 28));
        let channels = is_lut.then(|| read_u32(block, 32));
        if is_lut {
            // Capability responses may contain driver-owned pointer values.
            // Do not retain or reuse them.
            write_u64(block, 40, 0);
            write_u64(block, 48, 0);
        }
        output.push(PixelColorCapabilityBlock {
            id, block_type, sampling_type, samples_per_channel, channels, raw: block.to_vec(),
        });
    }
    Ok(output)
}

fn set_pixel_color_block(
    function: ctlPixelTransformationSetConfigFn,
    handle: Handle,
    block: &[u8],
    sample_values: Option<&mut [f64]>,
) -> Result<(), IgclError> {
    if handle.is_null() { return Err(IgclError::local("ctlPixelTransformationSetConfig", "null display-output handle")); }
    if block.len() != PIXEL_BLOCK_CONFIG_SIZE || read_u32(block, 0) != PIXEL_BLOCK_CONFIG_SIZE as u32 {
        return Err(IgclError::local("ctlPixelTransformationSetConfig", "invalid pixel-transformation block"));
    }
    if read_u32(block, 12) == PIXEL_BLOCK_LUT_1D && sample_values.is_none() {
        return Err(IgclError::local("ctlPixelTransformationSetConfig", "LUT sample storage is unavailable"));
    }
    let mut block_words = zeroed_aligned(PIXEL_BLOCK_CONFIG_SIZE + 16);
    let blocks = aligned_bytes_mut(&mut block_words);
    blocks[..PIXEL_BLOCK_CONFIG_SIZE].copy_from_slice(block);
    if let Some(samples) = sample_values {
        if samples.is_empty() { return Err(IgclError::local("ctlPixelTransformationSetConfig", "LUT sample storage is empty")); }
        write_u64(blocks, 40, samples.as_mut_ptr() as usize as u64);
        write_u64(blocks, 48, 0);
    }
    let block_address = blocks.as_mut_ptr() as usize as u64;
    let mut config_words = zeroed_aligned(PIXEL_SET_CONFIG_SIZE + 16);
    let config = aligned_bytes_mut(&mut config_words);
    write_u32(config, 0, PIXEL_SET_CONFIG_SIZE as u32);
    config[4] = 0;
    write_u32(config, 8, PIXEL_SET_CUSTOM);
    write_u32(config, 12, 0);
    write_u32(config, 16, 1);
    write_u64(config, 24, block_address);
    let status = unsafe { function(handle, config.as_mut_ptr().cast()) };
    if status == SUCCESS { Ok(()) }
    else { Err(IgclError::native("ctlPixelTransformationSetConfig", status)) }
}

fn matrix_for_display_color(hue: f64, saturation: f64) -> [f64; 9] {
    // Keep Electron's exact neutral transform. The rounded BT.709 coefficients
    // below otherwise leave tiny non-zero chroma terms at hue=0/saturation=1.
    if hue == 0.0 && saturation == 1.0 {
        return [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    }
    let angle = hue.to_radians();
    let cosine = angle.cos();
    let sine = angle.sin();
    let to_yuv = [
        0.2126, 0.7152, 0.0722,
        -0.114572, -0.385428, 0.5,
        0.5, -0.454153, -0.045847,
    ];
    let from_yuv = [
        1.0, 0.0, 1.5748,
        1.0, -0.187324, -0.468124,
        1.0, 1.8556, 0.0,
    ];
    let rotate_scale = [
        1.0, 0.0, 0.0,
        0.0, saturation * cosine, -saturation * sine,
        0.0, saturation * sine, saturation * cosine,
    ];
    let multiply = |left: &[f64; 9], right: &[f64; 9]| {
        let mut output = [0.0; 9];
        for row in 0..3 { for column in 0..3 { for index in 0..3 {
            output[row * 3 + column] += left[row * 3 + index] * right[index * 3 + column];
        } } }
        output
    };
    let middle = multiply(&rotate_scale, &to_yuv);
    multiply(&from_yuv, &middle)
}

fn lut_for_display_color(brightness: f64, contrast: f64, count: usize) -> Vec<f64> {
    let offset = brightness / 400.0;
    let ctl_contrast = 1.0 + ((contrast - 1.0) * 0.25);
    let curve: Vec<_> = (0..count).map(|index| {
        let input = index as f64 / (count - 1) as f64;
        ((input * ctl_contrast) + offset).clamp(0.0, 1.0)
    }).collect();
    [curve.as_slice(), curve.as_slice(), curve.as_slice()].concat()
}

pub(crate) fn describe_pixel_transformation_result(status: u32) -> String {
    let name = match status {
        0x0000_0000 => "SUCCESS",
        0x0000_0001 => "SUCCESS_STILL_OPEN_BY_ANOTHER_CALLER",
        0x4000_0001 => "ERROR_NOT_INITIALIZED",
        0x4000_0002 => "ERROR_ALREADY_INITIALIZED",
        0x4000_0003 => "ERROR_DEVICE_LOST",
        0x4000_0006 => "ERROR_INSUFFICIENT_PERMISSIONS",
        0x4000_0007 => "ERROR_NOT_AVAILABLE",
        0x4000_0008 => "ERROR_UNINITIALIZED",
        0x4000_0009 => "ERROR_UNSUPPORTED_VERSION",
        0x4000_000a => "ERROR_UNSUPPORTED_FEATURE",
        0x4000_000b => "ERROR_INVALID_ARGUMENT",
        0x4000_000d => "ERROR_INVALID_NULL_HANDLE",
        0x4000_000e => "ERROR_INVALID_NULL_POINTER",
        0x4000_000f => "ERROR_INVALID_SIZE",
        0x4000_0010 => "ERROR_UNSUPPORTED_SIZE",
        0x4000_0012 => "ERROR_DATA_READ",
        0x4000_0013 => "ERROR_DATA_WRITE",
        0x4000_0014 => "ERROR_DATA_NOT_FOUND",
        0x4000_0015 => "ERROR_NOT_IMPLEMENTED",
        0x4000_0016 => "ERROR_OS_CALL",
        0x4000_0017 => "ERROR_KMD_CALL",
        0x4000_0019 => "ERROR_ZE_LOADER",
        0x4000_001a => "ERROR_INVALID_OPERATION_TYPE",
        0x4000_0021 => "ERROR_UNKNOWN_APPLICATION_UID",
        0x4000_0022 => "ERROR_INVALID_ENUMERATION",
        0x4000_0024 => "ERROR_RESET_DEVICE_REQUIRED",
        0x4000_0025 => "ERROR_FULL_REBOOT_REQUIRED",
        0x4000_0026 => "ERROR_LOAD",
        0x4000_0027 => "ERROR_DEVICE_UNAVAILABLE",
        0x4000_ffff => "ERROR_UNKNOWN",
        0x4001_0000 => "ERROR_RETRY_OPERATION",
        0x4001_0001 => "ERROR_IGSC_LOADER",
        0x4001_0002 => "ERROR_RESTRICTED_APPLICATION",
        0x4400_0001 => "ERROR_CORE_OVERCLOCK_NOT_SUPPORTED",
        0x4400_0002 => "ERROR_CORE_OVERCLOCK_VOLTAGE_OUTSIDE_RANGE",
        0x4400_0003 => "ERROR_CORE_OVERCLOCK_FREQUENCY_OUTSIDE_RANGE",
        0x4400_0004 => "ERROR_CORE_OVERCLOCK_POWER_OUTSIDE_RANGE",
        0x4400_0005 => "ERROR_CORE_OVERCLOCK_TEMPERATURE_OUTSIDE_RANGE",
        0x4400_0006 => "ERROR_CORE_OVERCLOCK_IN_VOLTAGE_LOCKED_MODE",
        0x4400_0007 => "ERROR_CORE_OVERCLOCK_RESET_REQUIRED",
        0x4400_0008 => "ERROR_CORE_OVERCLOCK_WAIVER_NOT_SET",
        0x4400_0009 => "ERROR_CORE_OVERCLOCK_DEPRECATED_API",
        0x4400_000d => "ERROR_CORE_OVERCLOCK_VRAM_MEMORY_SPEED_OUTSIDE_RANGE",
        0x4400_000e => "ERROR_CORE_OVERCLOCK_INVALID_CUSTOM_VF_CURVE",
        _ => "UNKNOWN",
    };
    format!("{name} (0x{status:08x})")
}

fn fan_speed(percent: i32) -> ctl_fan_speed_t {    ctl_fan_speed_t {
        Size: std::mem::size_of::<ctl_fan_speed_t>() as u32,
        Version: 0,
        speed: percent,
        units: FAN_CONTROL_UNITS,
    }
}

fn fan_table(points: &[(u32, i32)]) -> ctl_fan_speed_table_t {
    let mut table: ctl_fan_speed_table_t = unsafe { std::mem::zeroed() };
    table.Size = std::mem::size_of::<ctl_fan_speed_table_t>() as u32;
    table.numPoints = points.len() as i32;
    for (index, (temperature, percent)) in points.iter().enumerate() {
        table.table[index] = ctl_fan_temp_speed_t {
            Size: std::mem::size_of::<ctl_fan_temp_speed_t>() as u32,
            Version: 0,
            temperature: *temperature,
            speed: fan_speed(*percent),
        };
    }
    table
}

fn fan_pct_from_speed(value: i32, units: i32, max_rpm: i32) -> Option<f64> {
    match (units, max_rpm) {
        (FAN_CONTROL_UNITS, _) => Some(value as f64),
        (0, max_rpm) if max_rpm > 0 => Some(value as f64 / max_rpm as f64 * 100.0),
        _ => None,
    }
}

fn nearly_equal(actual: f64, expected: f64, tolerance: f64) -> bool {
    (actual - expected).abs() <= tolerance
}
fn feature_request(feature_type: i32, value_type: i32, set: bool, enable: bool, value: i32, application_name: &str) -> Result<(ctl_3d_feature_getset_t, CString), IgclError> {
    let name = CString::new(application_name).map_err(|_| IgclError::local("3d-feature", "application name contains NUL"))?;
    let length = name.as_bytes().len();
    if length > 127 { return Err(IgclError::local("3d-feature", "application name exceeds the IGCL length limit")); }
    let mut request: ctl_3d_feature_getset_t = unsafe { std::mem::zeroed() };
    request.Size = std::mem::size_of::<ctl_3d_feature_getset_t>() as u32;
    request.Version = 0;
    request.FeatureType = feature_type;
    request.ApplicationName = name.as_ptr() as *mut c_void;
    request.ApplicationNameLength = length as i8;
    request.bSet = u8::from(set);
    request.ValueType = value_type;
    if value_type == 4 {
        request.Value[0..4].copy_from_slice(&(value as u32).to_le_bytes());
    } else {
        request.Value[0] = u8::from(enable);
        request.Value[4..8].copy_from_slice(&value.to_le_bytes());
    }
    request.CustomValueSize = 0;
    request.pCustomValue = ptr::null_mut();
    Ok((request, name))
}

// Electron's byte-buffer ABI allocates DISPLAY_HEADROOM bytes after every
// display settings struct while keeping Size equal to the declared IGCL size.
// Keep that allocation contract without changing the ABI struct itself.
#[repr(C)]
struct DisplaySettingsBuffer {
    settings: ctl_display_settings_t,
    _headroom: [u8; 16],
}

fn display_settings_buffer() -> DisplaySettingsBuffer {
    let mut buffer: DisplaySettingsBuffer = unsafe { std::mem::zeroed() };
    buffer.settings.Size = std::mem::size_of::<ctl_display_settings_t>() as u32;
    buffer.settings.Version = 0;
    buffer
}

impl ReadOnlyIgcl {
    /// Caller supplies the host-validated trusted DLL. This method additionally
    /// rejects relative paths, network/device namespaces and reparse components.
    /// It does not discover a runtime, change DLL directories or request a waiver.
    #[cfg(all(windows, target_pointer_width = "64"))]
    pub fn load(dll_path: &Path) -> Result<Self, IgclError> {
        let library = Library::load(dll_path)?;
        let functions = unsafe { library.functions()? };
        Self::initialize(functions, Some(library))
    }
    #[cfg(all(windows, target_pointer_width = "64"))]
    pub(crate) fn load_legacy(dll_path: &Path) -> Result<Self, IgclError> {
        let library = Library::load(dll_path)?;
        let functions = unsafe { library.functions()? };
        Self::initialize_legacy(functions, Some(library))
    }
    #[cfg(not(all(windows, target_pointer_width = "64")))]
    pub(crate) fn load_legacy(_dll_path: &Path) -> Result<Self, IgclError> {
        Err(IgclError::local("load", "only the verified Windows x64 ABI is supported"))
    }
    #[cfg(not(all(windows, target_pointer_width = "64")))]
    pub fn load(_dll_path: &Path) -> Result<Self, IgclError> {
        Err(IgclError::local("load", "only the verified Windows x64 ABI is supported"))
    }

    fn initialize(functions: Functions, #[cfg(windows)] library: Option<Library>) -> Result<Self, IgclError> {
        let mut session = Self { functions, api: ptr::null_mut(), close_failed: false,
            igsc_full_available: false, legacy_properties: false, handles: Vec::new(), #[cfg(windows)] library, _thread_affinity: PhantomData };
        let mut args = InitArgs::new(USE_LEVEL_ZERO | IGSC_FULL);
        let mut result = unsafe { (functions.init)(&mut args, &mut session.api) };
        if result == ERROR_IGSC_LOADER {
            // Match the established source's sole flag fallback. Never change UID.
            session.close()?;
            args = InitArgs::new(USE_LEVEL_ZERO);
            result = unsafe { (functions.init)(&mut args, &mut session.api) };
        } else {
            session.igsc_full_available = result == SUCCESS;
        }
        if result != SUCCESS {
            let mut error = IgclError::native("ctlInit", result);
            if let Err(cleanup) = session.close() { error.detail.push_str(&format!("; cleanup: {cleanup}")); }
            return Err(error);
        }
        if session.api.is_null() { return Err(IgclError::local("ctlInit", "success returned a null API handle")); }
        Ok(session)
    }

    fn initialize_legacy(functions: Functions, #[cfg(windows)] library: Option<Library>) -> Result<Self, IgclError> {
        let mut session = Self { functions, api: ptr::null_mut(), close_failed: false,
            igsc_full_available: false, legacy_properties: true, handles: Vec::new(), #[cfg(windows)] library, _thread_affinity: PhantomData };
        let mut args = InitArgs::new(USE_LEVEL_ZERO);
        args.app_version = 1 << 16;
        let mut result = unsafe { (functions.init)(&mut args, &mut session.api) };
        if result == 0x4000_0017 || result == 0x4000_0021 {
            session.close()?;
            args.application_uid = ApplicationId { data1: 0xe8e10f95, data2: 0x1a70, data3: 0x4b27,
                data4: [0x9c, 0xcf, 0x02, 0x01, 0x02, 0x64, 0xe9, 0xc8] };
            result = unsafe { (functions.init)(&mut args, &mut session.api) };
        }
        if result != SUCCESS {
            let mut error = IgclError::native("ctlInit", result);
            if let Err(cleanup) = session.close() { error.detail.push_str(&format!("; cleanup: {cleanup}")); }
            return Err(error);
        }
        if session.api.is_null() { return Err(IgclError::local("ctlInit", "success returned a null API handle")); }
        Ok(session)
    }

    pub fn enumerate_adapters(&mut self) -> Result<Vec<AdapterInfo>, IgclError> {
        if self.api.is_null() || self.close_failed { return Err(IgclError::local("enumerate", "session is closed or cleanup failed")); }
        let mut count = 0;
        let result = unsafe { (self.functions.enumerate)(self.api, &mut count, ptr::null_mut()) };
        if result != SUCCESS { return Err(IgclError::native("ctlEnumerateDevices(count)", result)); }
        if count > MAX_ENUMERATED_HANDLES { return Err(IgclError::local("enumerate", "driver adapter count exceeds allocation bound")); }
        if count == 0 { self.handles.clear(); return Ok(Vec::new()); }
        let capacity = count;
        let mut handles = vec![ptr::null_mut(); capacity as usize];
        let result = unsafe { (self.functions.enumerate)(self.api, &mut count, handles.as_mut_ptr()) };
        if result != SUCCESS { return Err(IgclError::native("ctlEnumerateDevices(fill)", result)); }
        if count > capacity { return Err(IgclError::local("enumerate", "driver increased count beyond supplied capacity")); }
        let mut devices = Vec::with_capacity(count as usize);
        for (index, handle) in handles.iter().copied().take(count as usize).enumerate() {
            if handle.is_null() { return Err(IgclError::local("enumerate", "driver returned a null adapter handle")); }
            let mut luid = DeviceId([0_u8; 8]);
            let mut props = AdapterProperties::new(&mut luid);
            if self.legacy_properties {
                props.version = 0;
                props.device_id = ptr::null_mut();
                props.device_id_size = 0;
            }
            let result = unsafe { (self.functions.properties)(handle, &mut props) };
            if result != SUCCESS { return Err(IgclError::native("ctlGetDeviceProperties", result)); }
            // Never dereference a pointer returned or rewritten by the driver.
            let luid = (props.device_id_size == 8 && luid.0.iter().any(|b| *b != 0))
                .then(|| luid.0.iter().map(|b| format!("{b:02x}")).collect::<String>());
            let end = props.name.iter().position(|b| *b == 0).unwrap_or(props.name.len());
            devices.push(AdapterInfo { index, name: String::from_utf8_lossy(&props.name[..end]).into_owned(),
                device_type: props.device_type, pci_vendor_id: props.pci_vendor_id,
                pci_device_id: props.pci_device_id, rev_id: props.rev_id,
                pci_subsys_id: props.pci_subsys_id, pci_subsys_vendor_id: props.pci_subsys_vendor_id,
                bdf: props.adapter_bdf, luid, driver_version: format!("0x{:016x}", props.driver_version),
                graphics_adapter_properties: props.graphics_adapter_properties,
                graphics_clock_mhz: props.frequency, num_xe_cores: props.num_xe_cores });
        }
        self.handles = handles.into_iter().take(count as usize).collect();
        Ok(devices)
    }

    // -----------------------------------------------------------------------
    // Display read surface (read-only)
    // -----------------------------------------------------------------------

    /// Electron's surface gate: `ctlEnumerateDisplayOutputs` and
    /// `ctlGetDisplayProperties` must both be bound before a read is attempted.
    pub(crate) fn display_available(&self) -> bool {
        self.functions.enumerate_displays.is_some() && self.functions.display_properties.is_some()
    }

    /// Enumerate this adapter's display-output handles. Output handles are
    /// topology-scoped, so this is never cached: every Display read calls it.
    /// A successful zero count is an empty topology; missing symbols, native
    /// refusal, and unsafe counts remain errors so callers can broker them.
    pub(crate) fn display_outputs(&self, index: usize) -> Result<Vec<Handle>, IgclError> {
        if self.api.is_null() || self.close_failed {
            return Err(IgclError::local("display-outputs", "session is closed or cleanup failed"));
        }
        let adapter = *self.handles.get(index)
            .ok_or_else(|| IgclError::local("display-outputs", "unknown adapter index"))?;
        let enumerate = self.functions.enumerate_displays
            .ok_or_else(|| IgclError::local("display-outputs", "ctlEnumerateDisplayOutputs is unavailable"))?;
        let mut count = 0_u32;
        let status = unsafe { enumerate(adapter, &mut count, ptr::null_mut()) };
        if status != SUCCESS { return Err(IgclError::native("ctlEnumerateDisplayOutputs(count)", status)); }
        if count == 0 { return Ok(Vec::new()); }
        // The probe counted 30 outputs on the A770; reject an implausible
        // count instead of reporting a false, successful empty topology.
        if count >= MAX_DISPLAY_OUTPUTS {
            return Err(IgclError::local("display-outputs", "driver output count exceeds allocation bound"));
        }
        let capacity = count;
        let mut handles = vec![ptr::null_mut(); capacity as usize];
        let status = unsafe { enumerate(adapter, &mut count, handles.as_mut_ptr()) };
        if status != SUCCESS { return Err(IgclError::native("ctlEnumerateDisplayOutputs(fill)", status)); }
        if count > capacity {
            return Err(IgclError::local("display-outputs", "driver increased count beyond supplied capacity"));
        }
        handles.truncate(count as usize);
        if handles.iter().any(|handle| handle.is_null()) {
            return Err(IgclError::local("display-outputs", "driver returned a null display-output handle"));
        }
        Ok(handles)
    }

    /// The Display global-VRR read requires the same full-IGSC and 3D symbols
    /// as Electron. `ctlGetSet3DFeature` is used below only with `bSet = 0`.
    pub(crate) fn display_igsc_full_available(&self) -> bool {
        self.igsc_full_available
    }

    pub(crate) fn display_global_vrr_api_available(&self) -> bool {
        self.functions.supported_3d.is_some() && self.functions.set_3d.is_some()
    }

    /// Read the global VRR enum on the adapter. The empty application name is
    /// the IGCL global value used by Electron. This helper never selects a
    /// scope: the Display read is strictly GET-only.
    pub(crate) fn display_global_vrr_mode(&mut self, index: usize) -> Result<u32, IgclError> {
        self.read_3d_enum(index, 14, "")
    }

    /// `ctlGetDisplayProperties` GET. `None` on an absent symbol or any
    /// non-success result: the caller keeps the all-false flags.
    pub(crate) fn display_properties(&self, handle: Handle) -> Option<ctl_display_properties_t> {
        let function = self.functions.display_properties?;
        if handle.is_null() { return None; }
        let mut data: ctl_display_properties_t = unsafe { std::mem::zeroed() };
        data.Size = std::mem::size_of::<ctl_display_properties_t>() as u32;
        data.Version = 0;
        let status = unsafe { function(handle, (&mut data as *mut ctl_display_properties_t).cast()) };
        (status == SUCCESS).then_some(data)
    }

    /// `ctlGetSetDisplaySettings` in GET mode. This getter never sets `Set = 1`
    /// or a `ValidFlags` bit; staged setters use the separate
    /// `DisplayApplyIgcl` facade.
    pub(crate) fn display_settings(&self, handle: Handle) -> Option<ctl_display_settings_t> {
        let function = self.functions.display_settings?;
        if handle.is_null() { return None; }
        let mut buffer = display_settings_buffer();
        buffer.settings.Set = 0;
        let status = unsafe {
            function(handle, (&mut buffer.settings as *mut ctl_display_settings_t).cast())
        };
        (status == SUCCESS).then_some(buffer.settings)
    }

    /// Create the narrow Display apply capability. Keeping setters behind a
    /// separately named facade makes the read path's GET-only calls explicit.
    pub(crate) fn display_apply_api(&self) -> DisplayApplyIgcl<'_> {
        DisplayApplyIgcl { session: self }
    }

    /// The adapter handle for the adapter-scoped display GETs. Retro scaling is
    /// documented against the adapter handle (`adapterHandle ?? handle` in the
    /// oracle); everything else is output-scoped.
    pub(crate) fn display_adapter_handle(&self, index: usize) -> Option<Handle> {
        self.handles.get(index).copied().filter(|handle| !handle.is_null())
    }

    /// The driver's own Resizable-BAR verdict (`ctlPciGetProperties`).
    /// The 64-byte layout and the sentinel-initialised flags at offsets 56/57
    /// match the verified Electron binding; a call that leaves a sentinel or
    /// fails degrades to None rather than claiming ReBAR is off.
    pub(crate) fn rebar_enabled(&self, index: usize) -> Option<bool> {
        let Some(function) = self.functions.pci_properties else {
            eprintln!("[rebar] ctlPciGetProperties is not exported by this driver");
            return None;
        };
        let Some(handle) = self.display_adapter_handle(index) else {
            eprintln!("[rebar] no IGCL adapter handle for index {index}");
            return None;
        };
        #[repr(align(8))]
        struct PciPropertiesBuffer([u8; 64]);
        let mut buffer = PciPropertiesBuffer([0u8; 64]);
        buffer.0[..4].copy_from_slice(&64u32.to_ne_bytes());
        buffer.0[56] = 0xff;
        buffer.0[57] = 0xff;
        let status = unsafe { function(handle as *mut std::ffi::c_void, buffer.0.as_mut_ptr() as *mut std::ffi::c_void) };
        if status != SUCCESS {
            eprintln!("[rebar] ctlPciGetProperties failed with status 0x{status:x}");
            return None;
        }
        let supported = buffer.0[56];
        let enabled = buffer.0[57];
        if !matches!(supported, 0 | 1) || !matches!(enabled, 0 | 1)
            || (enabled == 1 && supported != 1)
        {
            eprintln!("[rebar] invalid BAR flags (supported=0x{supported:02x} enabled=0x{enabled:02x})");
            return None;
        }
        Some(enabled == 1)
    }

    /// `ctlGetSetWireFormat` GET (`Operation = 0`). Every nested
    /// `ctl_wire_format_t` carries its own Size/Version header; without them the
    /// driver accepts the outer call and leaves the slots empty.
    pub(crate) fn display_wire_format(&self, handle: Handle) -> Option<ctl_get_set_wire_format_config_t> {
        let function = self.functions.wire_format?;
        if handle.is_null() { return None; }
        let mut buffer = wire_format_buffer(0, None);
        let status = unsafe {
            function(handle, (&mut buffer.config as *mut ctl_get_set_wire_format_config_t).cast())
        };
        (status == SUCCESS).then_some(buffer.config)
    }

    /// The scaling block's availability gate: `_readDisplayOutput` skips the
    /// whole block (caps and current) when either export is missing.
    pub(crate) fn display_scaling_gate(&self) -> bool {
        self.functions.scaling_caps.is_some() && self.functions.current_scaling.is_some()
    }

    /// Setter availability is checked separately from the read-only display
    /// gate so a native owner can decline before any write if the symbol is
    /// absent and safely leave the request with Electron.
    pub(crate) fn display_scaling_set_available(&self) -> bool {
        self.functions.set_current_scaling.is_some()
    }

    /// The retro-scaling block's availability gate: both exports must be bound.
    pub(crate) fn display_retro_scaling_gate(&self) -> bool {
        self.functions.retro_scaling_caps.is_some() && self.functions.retro_scaling.is_some()
    }

    /// `ctlGetSupportedScalingCapability` GET: the driver's SupportedScaling
    /// bitmask (the offered options).
    pub(crate) fn display_scaling_caps(&self, handle: Handle) -> Option<ctl_scaling_caps_t> {        let function = self.functions.scaling_caps?;
        if handle.is_null() { return None; }
        let mut caps: ctl_scaling_caps_t = unsafe { std::mem::zeroed() };
        caps.Size = std::mem::size_of::<ctl_scaling_caps_t>() as u32;
        caps.Version = 0;
        let status = unsafe { function(handle, (&mut caps as *mut ctl_scaling_caps_t).cast()) };
        (status == SUCCESS).then_some(caps)
    }

    /// `ctlGetCurrentScaling` GET. Version 1 adds the OS-persisted
    /// PreferredScalingType; older drivers only accept version 0, so a version-1
    /// `ERROR_INVALID_ARGUMENT`/`ERROR_UNSUPPORTED_VERSION` retries at 0 exactly
    /// like `readDisplayScaling`. The returned version is the one that answered.
    pub(crate) fn display_scaling(&self, handle: Handle) -> Option<(u8, ctl_scaling_settings_t)> {
        let function = self.functions.current_scaling?;
        if handle.is_null() { return None; }
        for version in [1_u8, 0_u8] {
            let mut buffer = scaling_settings_buffer(version, false, 0, None, false);
            let status = unsafe {
                function(handle, (&mut buffer.settings as *mut ctl_scaling_settings_t).cast())
            };
            if status == SUCCESS { return Some((version, buffer.settings)); }
            if version == 1 && !matches!(status, ERROR_INVALID_ARGUMENT | ERROR_UNSUPPORTED_VERSION) { return None; }
        }
        None
    }

    /// `ctlGetSupportedRetroScalingCapability` GET on the adapter handle.
    pub(crate) fn display_retro_scaling_caps(&self, adapter: Handle) -> Option<ctl_retro_scaling_caps_t> {
        let function = self.functions.retro_scaling_caps?;
        if adapter.is_null() { return None; }
        let mut caps: ctl_retro_scaling_caps_t = unsafe { std::mem::zeroed() };
        caps.Size = std::mem::size_of::<ctl_retro_scaling_caps_t>() as u32;
        caps.Version = 0;
        let status = unsafe { function(adapter, (&mut caps as *mut ctl_retro_scaling_caps_t).cast()) };
        (status == SUCCESS).then_some(caps)
    }

    /// `ctlGetSetRetroScaling` GET (`Get = 1`). The same export writes when
    /// `Get = 0`; this build never clears that flag.
    pub(crate) fn display_retro_scaling(&self, adapter: Handle) -> Option<ctl_retro_scaling_settings_t> {
        let function = self.functions.retro_scaling?;
        if adapter.is_null() { return None; }
        let mut settings: ctl_retro_scaling_settings_t = unsafe { std::mem::zeroed() };
        settings.Size = std::mem::size_of::<ctl_retro_scaling_settings_t>() as u32;
        settings.Version = 0;
        settings.Get = 1;
        settings.Enable = 0;
        settings.RetroScalingType = 0;
        let status = unsafe { function(adapter, (&mut settings as *mut ctl_retro_scaling_settings_t).cast()) };
        (status == SUCCESS).then_some(settings)
    }

    /// `ctlGetIntelArcSyncInfoForMonitor` GET. This is output-scoped and
    /// reports the panel's advertised VRR range without changing its profile.
    pub(crate) fn display_arc_sync_monitor(&self, handle: Handle) -> Option<ctl_intel_arc_sync_monitor_params_t> {
        let function = self.functions.arc_sync_monitor?;
        if handle.is_null() { return None; }
        let mut words = zeroed_aligned(std::mem::size_of::<ctl_intel_arc_sync_monitor_params_t>() + 16);
        let params = words.as_mut_ptr().cast::<ctl_intel_arc_sync_monitor_params_t>();
        unsafe { (*params).Size = std::mem::size_of::<ctl_intel_arc_sync_monitor_params_t>() as u32; (*params).Version = 0; }
        let status = unsafe { function(handle, params.cast()) };
        (status == SUCCESS).then(|| unsafe { *params })
    }

    /// `ctlGetIntelArcSyncProfile` GET. Electron only exposes this query when
    /// the full IGSC loader initialized; no profile setter is invoked here.
    pub(crate) fn display_arc_sync_profile(&self, handle: Handle) -> Option<ctl_intel_arc_sync_profile_params_t> {
        if !self.igsc_full_available { return None; }
        let function = self.functions.arc_sync_profile_get?;
        if handle.is_null() { return None; }
        let mut words = zeroed_aligned(std::mem::size_of::<ctl_intel_arc_sync_profile_params_t>() + 16);
        let params = words.as_mut_ptr().cast::<ctl_intel_arc_sync_profile_params_t>();
        unsafe { (*params).Size = std::mem::size_of::<ctl_intel_arc_sync_profile_params_t>() as u32; (*params).Version = 0; }
        let status = unsafe { function(handle, params.cast()) };
        (status == SUCCESS).then(|| unsafe { *params })
    }

    /// Profile control is advertised only when both the full IGSC loader and
    /// both profile symbols exist, matching Electron's read-only capability
    /// metadata. The setter remains unused by this module.
    pub(crate) fn display_arc_sync_profile_control_available(&self) -> bool {
        self.igsc_full_available
            && self.functions.arc_sync_profile_get.is_some()
            && self.functions.arc_sync_profile_set.is_some()
    }

    /// `readPixelTransformation` over the raw buffer layout: a capability count
    /// query, then a second GET that fills one block per count entry. Only the
    /// output format is decoded because that is the desktop colour path the
    /// Display read prefers over the legacy wire-format slot.
    pub(crate) fn display_pixel_transformation(&self, handle: Handle) -> Option<PixelTransformation> {
        let function = self.functions.pixel_transformation?;
        if handle.is_null() { return None; }
        let mut count_words = zeroed_aligned(PIXEL_GET_CONFIG_SIZE);
        let count_buffer = aligned_bytes_mut(&mut count_words);
        write_pixel_config_header(count_buffer, 0, 0);
        let status = unsafe { function(handle, count_buffer.as_mut_ptr().cast()) };
        if status != SUCCESS { return None; }
        let count = read_u32(count_buffer, 256);
        if !(1..=PIXEL_MAX_BLOCKS).contains(&count) { return None; }
        let mut block_words = zeroed_aligned(PIXEL_BLOCK_CONFIG_SIZE * count as usize + 8);
        let blocks = aligned_bytes_mut(&mut block_words);
        for index in 0..count as usize {
            let offset = index * PIXEL_BLOCK_CONFIG_SIZE;
            write_u32(blocks, offset, PIXEL_MATRIX_CONFIG_SIZE + 16);
            blocks[offset + 4] = 0;
        }
        let address = blocks.as_mut_ptr() as u64;
        let mut config_words = zeroed_aligned(PIXEL_GET_CONFIG_SIZE);
        let config = aligned_bytes_mut(&mut config_words);
        write_pixel_config_header(config, count, address);
        let status = unsafe { function(handle, config.as_mut_ptr().cast()) };
        if status != SUCCESS { return None; }
        Some(PixelTransformation {
            output_bits_per_color: read_u32(config, 136 + 8) as i32,
            output_model: read_u32(config, 136 + 24) as i32,
        })
    }

    /// Read the display's pixel-transformation capability blocks using
    /// IGCL's two-phase count/fill query. The result contains copied metadata
    /// only; no native block pointer or payload escapes this call.
    pub(crate) fn display_color_capabilities(
        &self,
        handle: Handle,
    ) -> Result<ColorCapabilityClassification, String> {
        if handle.is_null() {
            return Err(format!(
                "IGCL {}",
                describe_pixel_transformation_result(ERROR_INVALID_NULL_HANDLE),
            ));
        }
        let Some(function) = self.functions.pixel_transformation else {
            return Err(format!(
                "ctlPixelTransformationGetConfig is not exposed by this IGCL runtime ({})",
                describe_pixel_transformation_result(ERROR_UNSUPPORTED_FEATURE),
            ));
        };

        // Phase one: accept INVALID_SIZE only as IGCL's sizing response, and
        // only when the driver also returned a bounded, nonzero count.
        let mut count_words = zeroed_aligned(PIXEL_GET_CONFIG_SIZE + 16);
        let count_buffer = aligned_bytes_mut(&mut count_words);
        write_pixel_capability_header(count_buffer, 0, 0);
        let count_status = unsafe { function(handle, count_buffer.as_mut_ptr().cast()) };
        let count = read_u32(count_buffer, 256);
        if count_status != SUCCESS && count_status != ERROR_INVALID_SIZE {
            return Err(format!(
                "Pixel transformation block count query failed: IGCL {}",
                describe_pixel_transformation_result(count_status),
            ));
        }
        if !(1..=PIXEL_MAX_BLOCKS).contains(&count) {
            return Err(format!(
                "Pixel transformation returned an unsafe block count ({count})"
            ));
        }

        // Phase two: every caller-owned block starts with the exact size and
        // version expected by the ABI. Keep the list pointer aligned and
        // bound all allocation by the count check above.
        let block_bytes_len = PIXEL_BLOCK_CONFIG_SIZE * count as usize + 16;
        let mut block_words = zeroed_aligned(block_bytes_len);
        let blocks = aligned_bytes_mut(&mut block_words);
        for index in 0..count as usize {
            let offset = index * PIXEL_BLOCK_CONFIG_SIZE;
            write_u32(blocks, offset, PIXEL_BLOCK_CONFIG_SIZE as u32);
            blocks[offset + 4] = 0;
        }
        let block_address = blocks.as_mut_ptr() as usize as u64;
        let mut config_words = zeroed_aligned(PIXEL_GET_CONFIG_SIZE + 16);
        let config = aligned_bytes_mut(&mut config_words);
        write_pixel_capability_header(config, count, block_address);
        let status = unsafe { function(handle, config.as_mut_ptr().cast()) };
        if status != SUCCESS {
            return Err(format!(
                "Pixel transformation block query failed: IGCL {}",
                describe_pixel_transformation_result(status),
            ));
        }

        let returned_count = read_u32(config, 256);
        if !(1..=count).contains(&returned_count) {
            return Err(format!(
                "Pixel transformation returned an invalid block count ({returned_count})"
            ));
        }

        let mut metadata = Vec::with_capacity(returned_count as usize);
        for index in 0..returned_count as usize {
            let offset = index * PIXEL_BLOCK_CONFIG_SIZE;
            let block = &mut blocks[offset..offset + PIXEL_BLOCK_CONFIG_SIZE];
            if read_u32(block, 0) != PIXEL_BLOCK_CONFIG_SIZE as u32 {
                return Err(format!(
                    "Pixel transformation returned an invalid block size for block {index}"
                ));
            }
            let block_type = read_u32(block, 12);
            let is_lut = block_type == 1;
            metadata.push(ColorTransformBlockMetadata {
                id: read_u32(block, 8),
                block_type,
                sampling_type: is_lut.then(|| read_u32(block, 24)),
                num_samples_per_channel: is_lut.then(|| read_u32(block, 28)),
                num_channels: is_lut.then(|| read_u32(block, 32)),
            });
            if is_lut {
                // Capability queries do not supply sample buffers. Even if a
                // driver rewrites these fields, do not retain its addresses.
                write_u64(block, 40, 0);
                write_u64(block, 48, 0);
            }
        }
        Ok(classify_color_capability_blocks(&metadata))
    }

    /// Whether the runtime exports the pixel-transformation setter. This is
    /// metadata only; this read-only layer does not call the setter.
    pub(crate) fn display_pixel_transformation_set_available(&self) -> bool {
        self.functions.pixel_transformation_set.is_some()
    }

    /// The raw EDID / panel-descriptor candidates for one output, in Electron's
    /// preference order (`ctlEdidManagement`, then `ctlPanelDescriptorAccess`).
    /// A payload without a 0xFC name is still returned: the raw bytes feed the
    /// identity fingerprint even when the monitor name is unknown. The caller
    /// applies `_readDisplayEdid`'s selection rule.
    pub(crate) fn display_edid_blocks(&self, handle: Handle) -> Vec<Vec<u8>> {
        let mut blocks = Vec::new();
        if handle.is_null() { return blocks; }
        if let Some(function) = self.functions.edid {
            if let Some(data) = Self::read_edid_block(handle, function) { blocks.push(data); }
        }
        if let Some(function) = self.functions.panel_descriptor {
            if let Some(data) = Self::read_panel_descriptor(handle, function) { blocks.push(data); }
        }
        blocks
    }

    fn read_edid_block(handle: Handle, function: ctlEdidManagementFn) -> Option<Vec<u8>> {
        let mut args = Self::edid_args(0, ptr::null_mut());
        let status = unsafe { function(handle, (&mut args as *mut ctl_edid_management_args_t).cast()) };
        if status != SUCCESS { return None; }
        let size = args.EdidSize;
        if !(DISPLAY_BLOCK_MIN..=DISPLAY_BLOCK_MAX).contains(&size) { return None; }
        let mut data = vec![0_u8; size as usize];
        let mut args = Self::edid_args(size, data.as_mut_ptr().cast());
        let status = unsafe { function(handle, (&mut args as *mut ctl_edid_management_args_t).cast()) };
        (status == SUCCESS).then_some(data)
    }

    fn edid_args(edid_size: u32, buffer: *mut c_void) -> ctl_edid_management_args_t {
        let mut args: ctl_edid_management_args_t = unsafe { std::mem::zeroed() };
        args.Size = std::mem::size_of::<ctl_edid_management_args_t>() as u32;
        args.Version = 0;
        args.OpType = DISPLAY_BLOCK_OP_READ;
        args.EdidType = DISPLAY_EDID_TYPE_MONITOR;
        args.EdidSize = edid_size;
        args.pEdidBuf = buffer;
        args
    }

    fn read_panel_descriptor(handle: Handle, function: ctlPanelDescriptorAccessFn) -> Option<Vec<u8>> {
        let mut args = Self::panel_args(0, ptr::null_mut());
        let status = unsafe { function(handle, (&mut args as *mut ctl_panel_descriptor_access_args_t).cast()) };
        if status != SUCCESS { return None; }
        let size = args.DescriptorDataSize;
        if !(DISPLAY_BLOCK_MIN..=DISPLAY_BLOCK_MAX).contains(&size) { return None; }
        let mut data = vec![0_u8; size as usize];
        let mut args = Self::panel_args(size, data.as_mut_ptr().cast());
        let status = unsafe { function(handle, (&mut args as *mut ctl_panel_descriptor_access_args_t).cast()) };
        (status == SUCCESS).then_some(data)
    }

    fn panel_args(data_size: u32, buffer: *mut c_void) -> ctl_panel_descriptor_access_args_t {
        let mut args: ctl_panel_descriptor_access_args_t = unsafe { std::mem::zeroed() };
        args.Size = std::mem::size_of::<ctl_panel_descriptor_access_args_t>() as u32;
        args.Version = 0;
        args.OpType = DISPLAY_BLOCK_OP_READ;
        args.BlockNumber = 0;
        args.DescriptorDataSize = data_size;
        args.pDescriptorData = buffer;
        args
    }

    /// Read the driver's supported 3D feature details for one adapter. This is
    /// a bounded read-only query; absent symbols or a failed second call fail
    /// closed instead of inventing capability.
    pub(crate) fn supported_3d_features(&mut self, index: usize) -> Result<Vec<ctl_3d_feature_details_t>, IgclError> {        if self.api.is_null() || self.close_failed { return Err(IgclError::local("3d-features", "session is closed or cleanup failed")); }
        let handle = *self.handles.get(index).ok_or_else(|| IgclError::local("3d-features", "unknown adapter index"))?;
        let function = self.functions.supported_3d
            .ok_or_else(|| IgclError::local("3d-features", "ctlGetSupported3DCapabilities is unavailable"))?;
        let mut caps: ctl_3d_feature_caps_t = unsafe { std::mem::zeroed() };
        caps.Size = std::mem::size_of::<ctl_3d_feature_caps_t>() as u32;
        caps.Version = 0;
        let status = unsafe { function(handle, (&mut caps as *mut ctl_3d_feature_caps_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSupported3DCapabilities(count)", status)); }
        let count = caps.NumSupportedFeatures as usize;
        if count == 0 { return Ok(Vec::new()); }
        if count > 256 { return Err(IgclError::local("3d-features", "driver feature count exceeds allocation bound")); }
        let mut details: Vec<ctl_3d_feature_details_t> = vec![unsafe { std::mem::zeroed() }; count];
        caps.NumSupportedFeatures = count as u32;
        caps.pFeatureDetails = details.as_mut_ptr().cast();
        let status = unsafe { function(handle, (&mut caps as *mut ctl_3d_feature_caps_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSupported3DCapabilities(fill)", status)); }
        let actual = (caps.NumSupportedFeatures as usize).min(count);
        details.truncate(actual);
        Ok(details)
    }

    fn feature_handle(&self, index: usize) -> Result<Handle, IgclError> {
        if self.api.is_null() || self.close_failed { return Err(IgclError::local("3d-feature", "session is closed or cleanup failed")); }
        self.handles.get(index).copied().filter(|handle| !handle.is_null())
            .ok_or_else(|| IgclError::local("3d-feature", "unknown adapter index"))
    }

    pub(crate) fn read_3d_enum(&mut self, index: usize, feature_type: i32, application_name: &str) -> Result<u32, IgclError> {
        let handle = self.feature_handle(index)?;
        let function = self.functions.set_3d.ok_or_else(|| IgclError::local("3d-feature", "ctlGetSet3DFeature is unavailable"))?;
        let (mut request, _name) = feature_request(feature_type, 4, false, false, 0, application_name)?;
        let status = unsafe { function(handle, (&mut request as *mut ctl_3d_feature_getset_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSet3DFeature", status)); }
        Ok(u32::from_le_bytes(request.Value[0..4].try_into().unwrap()))
    }

    pub(crate) fn write_3d_enum(&mut self, index: usize, feature_type: i32, value: u32, application_name: &str) -> Result<(), IgclError> {
        let handle = self.feature_handle(index)?;
        let function = self.functions.set_3d.ok_or_else(|| IgclError::local("3d-feature", "ctlGetSet3DFeature is unavailable"))?;
        let (mut request, _name) = feature_request(feature_type, 4, true, false, value as i32, application_name)?;
        let status = unsafe { function(handle, (&mut request as *mut ctl_3d_feature_getset_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSet3DFeature", status)); }
        Ok(())
    }

    pub(crate) fn read_3d_int(&mut self, index: usize, feature_type: i32, application_name: &str) -> Result<(bool, i32), IgclError> {
        let handle = self.feature_handle(index)?;
        let function = self.functions.set_3d.ok_or_else(|| IgclError::local("3d-feature", "ctlGetSet3DFeature is unavailable"))?;
        let (mut request, _name) = feature_request(feature_type, 2, false, false, 0, application_name)?;
        let status = unsafe { function(handle, (&mut request as *mut ctl_3d_feature_getset_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSet3DFeature", status)); }
        Ok((request.Value[0] != 0, i32::from_le_bytes(request.Value[4..8].try_into().unwrap())))
    }

    pub(crate) fn write_3d_int(&mut self, index: usize, feature_type: i32, enabled: bool, value: i32, application_name: &str) -> Result<(), IgclError> {
        let handle = self.feature_handle(index)?;
        let function = self.functions.set_3d.ok_or_else(|| IgclError::local("3d-feature", "ctlGetSet3DFeature is unavailable"))?;
        let (mut request, _name) = feature_request(feature_type, 2, true, enabled, value, application_name)?;
        let status = unsafe { function(handle, (&mut request as *mut ctl_3d_feature_getset_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSet3DFeature", status)); }
        Ok(())
    }

    /// Read a BOOL 3D feature. `ctl_3d_feature_getset_t.Value` carries the
    /// enable byte at offset 0 for `CTL_PROPERTY_VALUE_TYPE_BOOL`.
    pub(crate) fn read_3d_bool(&mut self, index: usize, feature_type: i32, application_name: &str) -> Result<bool, IgclError> {
        let handle = self.feature_handle(index)?;
        let function = self.functions.set_3d.ok_or_else(|| IgclError::local("3d-feature", "ctlGetSet3DFeature is unavailable"))?;
        let (mut request, _name) = feature_request(feature_type, 0, false, false, 0, application_name)?;
        let status = unsafe { function(handle, (&mut request as *mut ctl_3d_feature_getset_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSet3DFeature", status)); }
        Ok(request.Value[0] != 0)
    }

    pub(crate) fn write_3d_bool(&mut self, index: usize, feature_type: i32, enabled: bool, application_name: &str) -> Result<(), IgclError> {
        let handle = self.feature_handle(index)?;
        let function = self.functions.set_3d.ok_or_else(|| IgclError::local("3d-feature", "ctlGetSet3DFeature is unavailable"))?;
        let (mut request, _name) = feature_request(feature_type, 0, true, enabled, 0, application_name)?;
        let status = unsafe { function(handle, (&mut request as *mut ctl_3d_feature_getset_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSet3DFeature", status)); }
        Ok(())
    }

    /// Select the driver's global or per-application 3D scope. `enabled=true`
    /// selects per-app (1); false selects global (2). The application name is
    /// still supplied in both directions, matching the existing product path.
    pub(crate) fn set_3d_scope(&mut self, index: usize, enabled: bool, application_name: &str) -> Result<(), IgclError> {
        let handle = self.feature_handle(index)?;
        let function = self.functions.set_3d.ok_or_else(|| IgclError::local("3d-feature", "ctlGetSet3DFeature is unavailable"))?;
        let (mut request, _name) = feature_request(15, 4, true, false, if enabled { 1 } else { 2 }, application_name)?;
        let status = unsafe { function(handle, (&mut request as *mut ctl_3d_feature_getset_t).cast()) };
        if status != SUCCESS { return Err(IgclError::native("ctlGetSet3DFeature(scope)", status)); }
        Ok(())
    }

    /// Read the OC/fan/VF/current-control surface for one enumerated adapter.
    /// Every optional symbol is bound from the same trusted DLL; an absent
    /// symbol leaves the corresponding capability unsupported rather than
    /// inventing a value.
    pub(crate) fn controls_snapshot(&mut self, index: usize) -> Result<ControlSnapshot, IgclError> {
        let handle = *self.handles.get(index)
            .ok_or_else(|| IgclError::local("controls", "unknown adapter index"))?;
        let mut oc: ctl_oc_properties_t = unsafe { std::mem::zeroed() };
        oc.Size = std::mem::size_of::<ctl_oc_properties_t>() as u32;
        oc.Version = 1;
        let overclock = self.functions.overclock
            .ok_or_else(|| IgclError::local("controls", "ctlOverclockGetProperties is unavailable"))?;
        let status = unsafe { overclock(handle, &mut oc) };
        if status != SUCCESS { return Err(IgclError::native("ctlOverclockGetProperties", status)); }
        let fan_handle = self.preferred_fan_handle(handle);
        let fan = fan_handle.and_then(|fan| self.fan_properties(fan)).unwrap_or_else(|| {
            let mut properties: ctl_fan_properties_t = unsafe { std::mem::zeroed() };
            properties.Size = std::mem::size_of::<ctl_fan_properties_t>() as u32;
            properties
        });
        let fan_config = fan_handle
            .zip(self.functions.fan_config)
            .and_then(|(fan, function)| self.read_fan_config(fan, function));
        let read_value = |function: Option<unsafe extern "C" fn(*mut c_void, *mut f64) -> u32>| {
            let function = function?;
            let mut value = 0.0f64;
            (unsafe { function(handle, &mut value) } == SUCCESS && value.is_finite()).then_some(value)
        };
        let gpu_lock = self.functions.gpu_lock.and_then(|function| {
            let mut lock: ctl_oc_vf_pair_t = unsafe { std::mem::zeroed() };
            lock.Size = std::mem::size_of::<ctl_oc_vf_pair_t>() as u32;
            lock.Version = 0;
            (unsafe { function(handle, &mut lock) } == SUCCESS).then_some(lock)
        });
        let read_vf = |kind: i32| self.read_vf_points(handle, kind).ok();
        Ok(ControlSnapshot {
            oc, fan, fan_config,
            power_limit: read_value(self.functions.power_limit),
            temp_limit: read_value(self.functions.temp_limit),
            voltage_offset: read_value(self.functions.voltage_offset),
            frequency_offset: read_value(self.functions.frequency_offset),
            vram_freq: read_value(self.functions.vram_freq),
            gpu_lock,
            vf_stock: read_vf(0),
            vf_live: read_vf(1),
        })
    }

    fn read_vf_points(&self, handle: Handle, kind: i32) -> Result<Vec<ctl_voltage_frequency_point_t>, u32> {
        let function = self.functions.vf_curve.ok_or(ERROR_UNSUPPORTED_FEATURE)?;
        let mut count = 0u32;
        let _ = unsafe { function(handle, kind, 0, &mut count, ptr::null_mut()) };
        if count < 2 || count > 64 { return Err(ERROR_INVALID_ARGUMENT); }
        let mut points: Vec<ctl_voltage_frequency_point_t> =
            (0..count).map(|_| unsafe { std::mem::zeroed() }).collect();
        let status = unsafe { function(handle, kind, 0, &mut count, points.as_mut_ptr()) };
        if status != SUCCESS { return Err(status); }
        points.truncate((count as usize).min(points.len()));
        if points.len() < 2 { Err(ERROR_INVALID_ARGUMENT) } else { Ok(points) }
    }

    /// Enumerate the fan handles belonging to one adapter.
    fn fan_handles(&self, device: Handle) -> Vec<Handle> {
        let Some(function) = self.functions.enum_fans else { return Vec::new(); };
        let mut count = 0u32;
        let status = unsafe { function(device, &mut count, ptr::null_mut()) };
        if status != SUCCESS || count == 0 || count > MAX_ENUMERATED_HANDLES { return Vec::new(); }
        let capacity = count;
        let mut handles = vec![ptr::null_mut(); capacity as usize];
        let status = unsafe { function(device, &mut count, handles.as_mut_ptr()) };
        if status != SUCCESS { return Vec::new(); }
        handles.truncate((count as usize).min(handles.len()));
        handles
    }

    /// Prefer the handle whose properties advertise control, otherwise the
    /// first enumerated fan - the same selection Electron uses for writes.
    fn preferred_fan_handle(&self, device: Handle) -> Option<Handle> {
        let handles = self.fan_handles(device);
        let first = *handles.first()?;
        let Some(function) = self.functions.fan else { return Some(first); };
        handles.into_iter().find(|handle| {
            let mut properties: ctl_fan_properties_t = unsafe { std::mem::zeroed() };
            properties.Size = std::mem::size_of::<ctl_fan_properties_t>() as u32;
            (unsafe { function(*handle, &mut properties) }) == SUCCESS && properties.canControl != 0
        }).or(Some(first))
    }

    fn fan_properties(&self, fan: Handle) -> Option<ctl_fan_properties_t> {
        let function = self.functions.fan?;
        let mut properties: ctl_fan_properties_t = unsafe { std::mem::zeroed() };
        properties.Size = std::mem::size_of::<ctl_fan_properties_t>() as u32;
        (unsafe { function(fan, &mut properties) } == SUCCESS).then_some(properties)
    }

    fn read_fan_config(&self, fan: Handle, function: ctlFanGetConfigFn) -> Option<ctl_fan_config_t> {
        let mut config: ctl_fan_config_t = unsafe { std::mem::zeroed() };
        config.Size = std::mem::size_of::<ctl_fan_config_t>() as u32;
        config.speedFixed.Size = std::mem::size_of_val(&config.speedFixed) as u32;
        config.speedTable.Size = std::mem::size_of_val(&config.speedTable) as u32;
        (unsafe { function(fan, &mut config) } == SUCCESS).then_some(config)
    }

    /// Replay the user's persisted OC waiver for this session before writes
    /// that the driver gates on it (voltage offset / VF). Never auto-accepts
    /// unless the caller established persisted consent.
    pub(crate) fn apply_waiver(&self, index: usize) -> Result<(), IgclError> {
        let handle = *self.handles.get(index)
            .ok_or_else(|| IgclError::local("waiver", "unknown adapter index"))?;
        let function = self.functions.waiver_set
            .ok_or_else(|| IgclError::local("waiver", "ctlOverclockWaiverSet is unavailable"))?;
        let status = unsafe { function(handle) };
        if status == SUCCESS { Ok(()) } else { Err(IgclError::native("ctlOverclockWaiverSet", status)) }
    }

    /// The driver's whole-device OC reset. This is the same primitive Electron
    /// calls for "Reset to defaults"; callers must hold the shared apply lock
    /// and verify the read-back before reporting success.
    pub(crate) fn reset_to_default(&self, index: usize) -> Result<(), IgclError> {
        let handle = *self.handles.get(index)
            .ok_or_else(|| IgclError::local("reset", "unknown adapter index"))?;
        let function = self.functions.overclock_reset
            .ok_or_else(|| IgclError::local("reset", "ctlOverclockResetToDefault is unavailable"))?;
        let status = unsafe { function(handle) };
        if status == SUCCESS { Ok(()) } else { Err(IgclError::native("ctlOverclockResetToDefault", status)) }
    }

    pub(crate) fn legacy_supports_power(&self) -> bool {
        self.functions.legacy_power_get.is_some() && self.functions.legacy_power_set.is_some()
    }
    pub(crate) fn legacy_supports_temp(&self) -> bool {
        self.functions.legacy_temp_get.is_some() && self.functions.legacy_temp_set.is_some()
    }
    pub(crate) fn legacy_set_power_limit_mw(&self, index: usize, milliwatts: f64) -> Result<(), u32> {
        let handle = *self.handles.get(index).ok_or(ERROR_INVALID_ARGUMENT)?;
        let function = self.functions.legacy_power_set.ok_or(ERROR_UNSUPPORTED_FEATURE)?;
        let status = unsafe { function(handle, milliwatts) };
        if status == SUCCESS { Ok(()) } else { Err(status) }
    }
    pub(crate) fn legacy_get_power_limit_w(&self, index: usize) -> Result<f64, u32> {
        let handle = *self.handles.get(index).ok_or(ERROR_INVALID_ARGUMENT)?;
        let function = self.functions.legacy_power_get.ok_or(ERROR_UNSUPPORTED_FEATURE)?;
        let mut value = 0.0_f64;
        let status = unsafe { function(handle, &mut value) };
        if status == SUCCESS && value.is_finite() { Ok(value / 1000.0) } else if status == SUCCESS { Err(ERROR_INVALID_ARGUMENT) } else { Err(status) }
    }
    pub(crate) fn legacy_set_temp_limit_c(&self, index: usize, celsius: f64) -> Result<(), u32> {
        let handle = *self.handles.get(index).ok_or(ERROR_INVALID_ARGUMENT)?;
        let function = self.functions.legacy_temp_set.ok_or(ERROR_UNSUPPORTED_FEATURE)?;
        let status = unsafe { function(handle, celsius) };
        if status == SUCCESS { Ok(()) } else { Err(status) }
    }
    pub(crate) fn legacy_get_temp_limit_c(&self, index: usize) -> Result<f64, u32> {
        let handle = *self.handles.get(index).ok_or(ERROR_INVALID_ARGUMENT)?;
        let function = self.functions.legacy_temp_get.ok_or(ERROR_UNSUPPORTED_FEATURE)?;
        let mut value = 0.0_f64;
        let status = unsafe { function(handle, &mut value) };
        if status == SUCCESS && value.is_finite() { Ok(value) } else if status == SUCCESS { Err(ERROR_INVALID_ARGUMENT) } else { Err(status) }
    }

    /// Raw scalar backend for one enumerated adapter (mock-verified apply core).
    #[allow(dead_code)] // wired after the write-verification approval
    pub(crate) fn scalar_backend(&self, index: usize) -> Option<IgclScalarBackend<'_>> {
        let handle = *self.handles.get(index)?;
        Some(IgclScalarBackend { session: self, handle })
    }

    /// Raw VF backend for one enumerated adapter (staged VF slice).
    #[allow(dead_code)]
    pub(crate) fn vf_backend(&self, index: usize, units: ScalarUnits) -> Option<IgclVfBackend<'_>> {
        let handle = *self.handles.get(index)?;
        Some(IgclVfBackend { session: self, handle, units })
    }

    /// Raw fan backend for one enumerated adapter.
    #[allow(dead_code)]
    pub(crate) fn fan_backend(&self, index: usize) -> Option<IgclFanBackend<'_>> {
        let device = *self.handles.get(index)?;
        Some(IgclFanBackend { session: self, fan: self.preferred_fan_handle(device)? })
    }

    /// Raw lock backend for one enumerated adapter.
    #[allow(dead_code)]
    pub(crate) fn lock_backend(&self, index: usize) -> Option<IgclLockBackend<'_>> {
        let handle = *self.handles.get(index)?;
        Some(IgclLockBackend { session: self, handle })
    }

    /// Reversibly learn whether the driver honours fan-table/fixed writes even
    /// when its properties report `canControl == false`. Port of the Electron
    /// `_runFanProbe` / `_runFixedProbe` contract: write a safe sample table,
    /// verify the exact read-back, restore default mode with retries and a
    /// mode-flip recovery, then probe fixed mode only after a verified restore.
    /// A false result is never treated as control capability.
    pub(crate) fn probe_fan_control(&mut self, index: usize, max_points: i32) -> FanProbe {
        let failed = FanProbe::default();
        let Some(device) = self.handles.get(index).copied() else { return failed; };
        let (Some(set_table), Some(set_default), Some(get_config)) = (
            self.functions.fan_set_table, self.functions.fan_set_default, self.functions.fan_config,
        ) else { return failed; };
        let Some(fan) = self.preferred_fan_handle(device) else { return failed; };
        let max_rpm = self.fan_properties(fan).map(|properties| properties.maxRPM).unwrap_or(-1);

        // Intel's sample encoding: min(10, maxPoints) strictly ascending
        // temperatures and safe 0-90% speeds in the FAN enum's PERCENT units.
        let point_count = if max_points > 0 {
            (max_points as usize).min(FAN_PROBE_MAX_POINTS)
        } else {
            FAN_PROBE_MAX_POINTS
        };
        let expected: Vec<(u32, i32)> = (0..point_count)
            .map(|index| (20 + index as u32 * 8, index as i32 * 10))
            .collect();
        let mut table = fan_table(&expected);
        let set_status = unsafe { set_table(fan, &mut table) };
        let write_accepted = set_status == SUCCESS;
        if !write_accepted {
            eprintln!("[gpu_capabilities] fan probe: table write refused (0x{set_status:08x})");
            return failed;
        }

        let read_ok = self.read_fan_config(fan, get_config).is_some_and(|config| {
            config.mode == FAN_MODE_TABLE
                && config.speedTable.numPoints == expected.len() as i32
                && expected.iter().enumerate().all(|(index, (temperature, speed))| {
                    let point = &config.speedTable.table[index];
                    point.speed.units == FAN_CONTROL_UNITS
                        && nearly_equal(point.temperature as f64, *temperature as f64, 1.0)
                        && fan_pct_from_speed(point.speed.speed, point.speed.units, max_rpm)
                            .is_some_and(|value| nearly_equal(value, *speed as f64, 1.0))
                })
        });
        if !read_ok { eprintln!("[gpu_capabilities] fan probe: table read-back did not match"); }

        let restore_ok = self.restore_fan_default(fan, set_default, set_table, get_config, max_rpm);
        if !restore_ok { eprintln!("[gpu_capabilities] fan probe: restore-to-default failed"); }
        let probe_ok = read_ok && restore_ok;
        let fixed_ok = restore_ok
            && self.probe_fan_fixed(fan, set_default, set_table, get_config, max_rpm);
        FanProbe { probe_ok, write_accepted, fixed_ok }
    }

    /// Restore `ctlFanSetDefaultMode` and verify DEFAULT mode: two direct
    /// attempts with a settle delay, then a fresh 3-point table flip and one
    /// more default write. Never reports success without a verified read-back.
    fn restore_fan_default(
        &self,
        fan: Handle,
        set_default: ctlFanSetDefaultModeFn,
        set_table: ctlFanSetSpeedTableModeFn,
        get_config: ctlFanGetConfigFn,
        _max_rpm: i32,
    ) -> bool {
        let in_default = || self.read_fan_config(fan, get_config)
            .is_some_and(|config| config.mode == FAN_MODE_DEFAULT);
        for _ in 0..2 {
            if (unsafe { set_default(fan) }) == SUCCESS && in_default() { return true; }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        let mut table = fan_table(&[(20, 30), (50, 50), (80, 70)]);
        if (unsafe { set_table(fan, &mut table) }) == SUCCESS {
            std::thread::sleep(std::time::Duration::from_millis(150));
            if (unsafe { set_default(fan) }) == SUCCESS && in_default() { return true; }
        }
        false
    }

    /// One reversible 50% fixed write. The dedicated setter is the primary;
    /// `ERROR_UNSUPPORTED_FEATURE` / `ERROR_NOT_AVAILABLE` or an absent symbol
    /// fall back to a flat 2-point table (the Alchemist mechanism).
    fn probe_fan_fixed(
        &self,
        fan: Handle,
        set_default: ctlFanSetDefaultModeFn,
        set_table: ctlFanSetSpeedTableModeFn,
        get_config: ctlFanGetConfigFn,
        max_rpm: i32,
    ) -> bool {
        const FIXED_PCT: i32 = 50;
        let mut fixed = fan_speed(FIXED_PCT);
        let primary = self.functions.fan_set_fixed
            .map(|function| unsafe { function(fan, &mut fixed) });
        let write_accepted = primary == Some(SUCCESS);
        let flat_fallback = !write_accepted && matches!(
            primary, None | Some(ERROR_UNSUPPORTED_FEATURE) | Some(ERROR_NOT_AVAILABLE)
        );
        if !write_accepted && !flat_fallback { return false; }

        if write_accepted {
            let read_ok = self.read_fan_config(fan, get_config).is_some_and(|config| {
                config.mode == FAN_MODE_FIXED
                    && config.speedFixed.units == FAN_CONTROL_UNITS
                    && fan_pct_from_speed(config.speedFixed.speed, config.speedFixed.units, max_rpm)
                        .is_some_and(|value| nearly_equal(value, FIXED_PCT as f64, 1.0))
            });
            let restore_ok = self.restore_fan_default(fan, set_default, set_table, get_config, max_rpm);
            return read_ok && restore_ok;
        }

        let mut table = fan_table(&[(20, FIXED_PCT), (100, FIXED_PCT)]);
        if (unsafe { set_table(fan, &mut table) }) != SUCCESS { return false; }
        let read_ok = self.read_fan_config(fan, get_config).is_some_and(|config| {
            config.mode == FAN_MODE_TABLE
                && config.speedTable.numPoints >= 2
                && config.speedTable.numPoints <= 32
                && (0..config.speedTable.numPoints as usize).all(|index| {
                    let point = &config.speedTable.table[index];
                    point.speed.units == FAN_CONTROL_UNITS
                        && fan_pct_from_speed(point.speed.speed, point.speed.units, max_rpm)
                            .is_some_and(|value| nearly_equal(value, FIXED_PCT as f64, 1.0))
                })
        });
        let restore_ok = self.restore_fan_default(fan, set_default, set_table, get_config, max_rpm);
        read_ok && restore_ok
    }

    pub fn close(&mut self) -> Result<(), IgclError> {
        if self.api.is_null() { return Ok(()); }
        let result = unsafe { (self.functions.close)(self.api) };
        if result != SUCCESS && result != STILL_OPEN_BY_ANOTHER_CALLER {
            self.close_failed = true;
            return Err(IgclError::native("ctlClose", result));
        }
        self.api = ptr::null_mut(); self.close_failed = false;
        Ok(())
    }
}

impl DisplayApplyIgcl<'_> {
    /// Apply one unique IGS color block through the private Display setter
    /// facade. Electron has no reliable effective-value read-back for these
    /// blocks on all drivers; callers must preserve the readback-unavailable
    /// contract and persist intent only after this SET reports success.
    pub(crate) fn set_pixel_color_group(
        &self,
        handle: *mut c_void,
        hue_saturation: bool,
        first: f64,
        second: f64,
    ) -> Result<(), IgclError> {
        if self.session.api.is_null() || self.session.close_failed {
            return Err(IgclError::local("display-color-set", "session is closed or cleanup failed"));
        }
        if handle.is_null() { return Err(IgclError::local("display-color-set", "null display-output handle")); }
        let (first_min, first_max, second_min, second_max) = if hue_saturation {
            (-180.0, 180.0, 0.0, 2.0)
        } else {
            (-100.0, 100.0, 0.0, 2.0)
        };
        if !first.is_finite() || !second.is_finite()
            || !(first_min..=first_max).contains(&first) || !(second_min..=second_max).contains(&second)
        {
            return Err(IgclError::local("display-color-set", "color values are outside the supported finite range"));
        }
        let get = self.session.functions.pixel_transformation
            .ok_or_else(|| IgclError::local("display-color-set", "ctlPixelTransformationGetConfig is unavailable"))?;
        let set = self.session.functions.pixel_transformation_set
            .ok_or_else(|| IgclError::local("display-color-set", "ctlPixelTransformationSetConfig is unavailable"))?;
        let blocks = query_pixel_color_capability_blocks(get, handle)?;
        let metadata: Vec<_> = blocks.iter().map(|block| ColorTransformBlockMetadata {
            id: block.id,
            block_type: block.block_type,
            sampling_type: block.sampling_type,
            num_samples_per_channel: block.samples_per_channel,
            num_channels: block.channels,
        }).collect();
        let classification = classify_color_capability_blocks(&metadata);
        let (block_id, block_type) = if hue_saturation {
            (classification.hue_saturation_block_id, PIXEL_BLOCK_MATRIX_3X3)
        } else {
            (classification.brightness_contrast_block_id, PIXEL_BLOCK_LUT_1D)
        };
        let block_id = block_id.ok_or_else(|| IgclError::local(
            "display-color-set",
            if hue_saturation {
                classification.hue_saturation_unsupported_reason.unwrap_or("hue/saturation matrix is unavailable")
            } else {
                classification.brightness_contrast_unsupported_reason.unwrap_or("RGB color LUT is unavailable")
            },
        ))?;
        let mut selected = blocks.iter().filter(|block| block.id == block_id && block.block_type == block_type);
        let mut block = selected.next().cloned()
            .ok_or_else(|| IgclError::local("display-color-set", "selected color capability block is unavailable"))?;
        if selected.next().is_some() {
            return Err(IgclError::local("display-color-set", "selected color capability block is ambiguous"));
        }

        if hue_saturation {
            if read_u32(&block.raw, 0) != PIXEL_BLOCK_CONFIG_SIZE as u32
                || read_u32(&block.raw, 8) != block.id || read_u32(&block.raw, 12) != PIXEL_BLOCK_MATRIX_3X3
            {
                return Err(IgclError::local("display-color-set", "matrix capability block identity is invalid"));
            }
            write_u32(&mut block.raw, 16, PIXEL_MATRIX_CONFIG_SIZE);
            block.raw[20] = 0;
            for index in 0..3 {
                write_u64(&mut block.raw, 24 + index * 8, 0);
                write_u64(&mut block.raw, 48 + index * 8, 0);
            }
            let matrix = matrix_for_display_color(first, second);
            for (index, value) in matrix.iter().enumerate() {
                write_u64(&mut block.raw, 72 + index * 8, value.to_bits());
            }
            set_pixel_color_block(set, handle, &block.raw, None)
        } else {
            let sample_count = block.samples_per_channel.unwrap_or(0);
            if block.sampling_type != Some(0) || !(2..=PIXEL_MAX_LUT_SAMPLES).contains(&sample_count)
                || block.channels != Some(3)
            {
                return Err(IgclError::local("display-color-set", "RGB LUT capability metadata is invalid or unsupported"));
            }
            write_u32(&mut block.raw, 16, PIXEL_LUT_CONFIG_SIZE);
            block.raw[20] = 0;
            write_u32(&mut block.raw, 24, block.sampling_type.unwrap_or(0));
            write_u32(&mut block.raw, 28, sample_count);
            write_u32(&mut block.raw, 32, 3);
            write_u64(&mut block.raw, 40, 0);
            write_u64(&mut block.raw, 48, 0);
            let mut samples = lut_for_display_color(first, second, sample_count as usize);
            set_pixel_color_block(set, handle, &block.raw, Some(&mut samples))
        }
    }

    /// Set only `QUANTIZATION_RANGE`, using the same ABI shape as Electron's
    /// `ctlGetSetDisplaySettings` path. Callers must complete adapter/output
    /// identity checks and read-back verification around this single write.
    pub(crate) fn set_quantization_range(&self, handle: *mut c_void, value: i32) -> Result<(), IgclError> {
        if self.session.api.is_null() || self.session.close_failed {
            return Err(IgclError::local("display-settings-set", "session is closed or cleanup failed"));
        }
        let function = self.session.functions.display_settings
            .ok_or_else(|| IgclError::local("display-settings-set", "ctlGetSetDisplaySettings is unavailable"))?;
        set_quantization_range_with(function, handle, value)
    }

    /// Set one wire-format model/depth pair. `color_depth` is an exact BPC
    /// flag, matching the nested IGCL struct contract and the reader's
    /// verification representation.
    pub(crate) fn set_wire_format(&self, handle: *mut c_void, model: i32, color_depth: u32) -> Result<(), IgclError> {
        if self.session.api.is_null() || self.session.close_failed {
            return Err(IgclError::local("display-wire-format-set", "session is closed or cleanup failed"));
        }
        let function = self.session.functions.wire_format
            .ok_or_else(|| IgclError::local("display-wire-format-set", "ctlGetSetWireFormat is unavailable"))?;
        set_wire_format_with(function, handle, model, color_depth)
    }

    /// Set one output's scaling selector through the private Display apply
    /// facade. Electron tries version 1, then retries version 0 only for the
    /// two documented version-rejection statuses. This helper is deliberately
    /// not exposed to the read-only Display path.
    pub(crate) fn set_scaling(
        &self,
        handle: *mut c_void,
        enabled: bool,
        scaling_type: u32,
        custom: Option<(u32, u32)>,
        hardware_mode_set: bool,
    ) -> Result<u8, IgclError> {
        if self.session.api.is_null() || self.session.close_failed {
            return Err(IgclError::local("display-scaling-set", "session is closed or cleanup failed"));
        }
        let function = self.session.functions.set_current_scaling
            .ok_or_else(|| IgclError::local("display-scaling-set", "ctlSetCurrentScaling is unavailable"))?;
        if !(1..=16).contains(&scaling_type) || ![1, 2, 4, 8, 16].contains(&scaling_type)
            || hardware_mode_set != (scaling_type == 16)
            || match (scaling_type, custom) {
                (16, Some((x, y))) => x > 100 || y > 100,
                (16, None) => true,
                (_, Some(_)) => true,
                (_, None) => false,
            }
        {
            return Err(IgclError::local("display-scaling-set", "unknown scaling type, custom coordinates, or hardware-mode flag"));
        }
        for version in [1_u8, 0_u8] {
            match set_scaling_with(function, handle, version, enabled, scaling_type, custom, hardware_mode_set) {
                Ok(()) => return Ok(version),
                Err(error) if version == 1 && matches!(error.status, Some(ERROR_INVALID_ARGUMENT) | Some(ERROR_UNSUPPORTED_VERSION)) => {}
                Err(error) => return Err(error),
            }
        }
        Err(IgclError::local("display-scaling-set", "no supported scaling version was attempted"))
    }

    /// Set adapter-level Retro Scaling through the private Display apply
    /// facade. The transaction caller verifies adapter/output identity and
    /// advertised method support before reaching this narrow ABI boundary.
    pub(crate) fn set_retro_scaling(
        &self,
        adapter: Handle,
        enabled: bool,
        scaling_type: u32,
    ) -> Result<(), IgclError> {
        if self.session.api.is_null() || self.session.close_failed {
            return Err(IgclError::local("display-retro-scaling-set", "session is closed or cleanup failed"));
        }
        if adapter.is_null() || !matches!(scaling_type, 1 | 2) {
            return Err(IgclError::local("display-retro-scaling-set", "null adapter handle or unknown Retro Scaling type"));
        }
        let function = self.session.functions.retro_scaling
            .ok_or_else(|| IgclError::local("display-retro-scaling-set", "ctlGetSetRetroScaling is unavailable"))?;
        let mut settings: ctl_retro_scaling_settings_t = unsafe { std::mem::zeroed() };
        settings.Size = std::mem::size_of::<ctl_retro_scaling_settings_t>() as u32;
        settings.Version = 0;
        settings.Get = 0;
        settings.Enable = u8::from(enabled);
        settings.RetroScalingType = scaling_type;
        let status = unsafe { function(adapter, (&mut settings as *mut ctl_retro_scaling_settings_t).cast()) };
        if status == SUCCESS { Ok(()) } else { Err(IgclError::native("ctlGetSetRetroScaling SET", status)) }
    }

    /// Set one output's Arc Sync profile while preserving the driver's current
    /// refresh and frame-time parameters. The caller must re-read and compare
    /// those parameters immediately before invoking this setter.
    pub(crate) fn set_arc_sync_profile(
        &self,
        handle: Handle,
        profile: i32,
        max_refresh_hz: f32,
        min_refresh_hz: f32,
        max_frame_time_increase_us: u32,
        max_frame_time_decrease_us: u32,
    ) -> Result<(), IgclError> {
        if self.session.api.is_null() || self.session.close_failed {
            return Err(IgclError::local("display-arc-sync-set", "session is closed or cleanup failed"));
        }
        if !self.session.igsc_full_available {
            return Err(IgclError::local("display-arc-sync-set", "the IGSC full loader is unavailable"));
        }
        if handle.is_null() || !(1..=7).contains(&profile)
            || !max_refresh_hz.is_finite() || !min_refresh_hz.is_finite()
            || max_refresh_hz < min_refresh_hz
        {
            return Err(IgclError::local("display-arc-sync-set", "invalid output handle, profile, or refresh range"));
        }
        let function = self.session.functions.arc_sync_profile_set
            .ok_or_else(|| IgclError::local("display-arc-sync-set", "ctlSetIntelArcSyncProfile is unavailable"))?;
        let mut buffer = arc_sync_profile_buffer(
            profile, max_refresh_hz, min_refresh_hz,
            max_frame_time_increase_us, max_frame_time_decrease_us,
        );
        let status = unsafe {
            function(handle, (&mut buffer.settings as *mut ctl_intel_arc_sync_profile_params_t).cast())
        };
        if status == SUCCESS { Ok(()) } else { Err(IgclError::native("ctlSetIntelArcSyncProfile", status)) }
    }
}

#[repr(C)]
struct ArcSyncProfileBuffer {
    settings: ctl_intel_arc_sync_profile_params_t,
    _headroom: [u8; ARC_SYNC_PROFILE_HEADROOM],
}

fn arc_sync_profile_buffer(
    profile: i32,
    max_refresh_hz: f32,
    min_refresh_hz: f32,
    max_frame_time_increase_us: u32,
    max_frame_time_decrease_us: u32,
) -> ArcSyncProfileBuffer {
    let mut buffer: ArcSyncProfileBuffer = unsafe { std::mem::zeroed() };
    buffer.settings.Size = std::mem::size_of::<ctl_intel_arc_sync_profile_params_t>() as u32;
    buffer.settings.Version = 0;
    buffer.settings.IntelArcSyncProfile = profile;
    buffer.settings.MaxRefreshRateInHz = max_refresh_hz;
    buffer.settings.MinRefreshRateInHz = min_refresh_hz;
    buffer.settings.MaxFrameTimeIncreaseInUs = max_frame_time_increase_us;
    buffer.settings.MaxFrameTimeDecreaseInUs = max_frame_time_decrease_us;
    buffer
}

#[repr(C)]
struct ScalingSettingsBuffer {
    settings: ctl_scaling_settings_t,
    // Electron allocates DISPLAY_HEADROOM after the native record.
    _headroom: [u8; 16],
}

fn scaling_settings_buffer(
    version: u8,
    enabled: bool,
    scaling_type: u32,
    custom: Option<(u32, u32)>,
    hardware_mode_set: bool,
) -> ScalingSettingsBuffer {
    let mut buffer: ScalingSettingsBuffer = unsafe { std::mem::zeroed() };
    buffer.settings.Size = std::mem::size_of::<ctl_scaling_settings_t>() as u32;
    buffer.settings.Version = version;
    buffer.settings.Enable = u8::from(enabled);
    buffer.settings.ScalingType = scaling_type;
    if let Some((x, y)) = custom {
        buffer.settings.CustomScalingX = x;
        buffer.settings.CustomScalingY = y;
    }
    buffer.settings.HardwareModeSet = u8::from(hardware_mode_set);
    // PreferredScalingType remains zeroed, matching Electron's SET encoder
    // which omits this GET-only observation field from its write request.
    buffer
}

fn set_scaling_with(
    function: ctlSetCurrentScalingFn,
    handle: *mut c_void,
    version: u8,
    enabled: bool,
    scaling_type: u32,
    custom: Option<(u32, u32)>,
    hardware_mode_set: bool,
) -> Result<(), IgclError> {
    if handle.is_null() {
        return Err(IgclError::local("display-scaling-set", "null display-output handle"));
    }
    let mut buffer = scaling_settings_buffer(version, enabled, scaling_type, custom, hardware_mode_set);
    let status = unsafe {
        function(handle, (&mut buffer.settings as *mut ctl_scaling_settings_t).cast())
    };
    if status == SUCCESS { Ok(()) } else { Err(IgclError::native("ctlSetCurrentScaling(SET)", status)) }
}

fn set_wire_format_with(
    function: ctlGetSetWireFormatFn,
    handle: *mut c_void,
    model: i32,
    color_depth: u32,
) -> Result<(), IgclError> {
    if handle.is_null() {
        return Err(IgclError::local("display-wire-format-set", "null display-output handle"));
    }
    if !(0..=3).contains(&model) || ![1, 2, 4, 8].contains(&color_depth) {
        return Err(IgclError::local("display-wire-format-set", "unknown wire-format model or depth flag"));
    }
    let mut buffer = wire_format_buffer(1, Some((model, color_depth)));
    let status = unsafe {
        function(handle, (&mut buffer.config as *mut ctl_get_set_wire_format_config_t).cast())
    };
    if status == SUCCESS { Ok(()) } else { Err(IgclError::native("ctlGetSetWireFormat(SET)", status)) }
}

fn set_quantization_range_with(
    function: ctlGetSetDisplaySettingsFn,
    handle: *mut c_void,
    value: i32,
) -> Result<(), IgclError> {
    if handle.is_null() {
        return Err(IgclError::local("display-settings-set", "null display-output handle"));
    }
    if !(0..=2).contains(&value) {
        return Err(IgclError::local("display-settings-set", "unknown quantization range value"));
    }
    let mut buffer = display_settings_buffer();
    buffer.settings.Set = 1;
    buffer.settings.ValidFlags = 1 << 3; // ctl_display_setting_flag_t::QUANTIZATION_RANGE
    buffer.settings.QuantizationRange = value;
    let status = unsafe {
        function(handle, (&mut buffer.settings as *mut ctl_display_settings_t).cast())
    };
    if status == SUCCESS { Ok(()) } else { Err(IgclError::native("ctlGetSetDisplaySettings(SET)", status)) }
}
impl Drop for ReadOnlyIgcl {
    fn drop(&mut self) {
        if !self.close_failed { let _ = self.close(); }
        #[cfg(windows)]
        if !self.api.is_null() {
            if let Some(library) = self.library.take() { std::mem::forget(library); }
        }
    }
}

#[cfg(windows)]
struct Library(windows_sys::Win32::Foundation::HMODULE);
#[cfg(windows)]
impl Library {
    fn load(path: &Path) -> Result<Self, IgclError> {
        use std::{os::windows::{ffi::OsStrExt, fs::MetadataExt}, path::{Component, Prefix}};
        use windows_sys::Win32::{Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
            System::LibraryLoader::{LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32}};
        if !path.is_absolute() { return Err(IgclError::local("load", "DLL path must be absolute")); }
        if !matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))) {
            return Err(IgclError::local("load", "DLL path must use a local drive prefix"));
        }
        let mut checked = std::path::PathBuf::new();
        for component in path.components() {
            if matches!(component, Component::ParentDir | Component::CurDir) {
                return Err(IgclError::local("load", "relative path components are forbidden"));
            }
            checked.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) { continue; }
            let metadata = std::fs::symlink_metadata(&checked)
                .map_err(|error| IgclError::local("load", error.to_string()))?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(IgclError::local("load", "reparse path components are forbidden"));
            }
        }
        if !std::fs::metadata(path).map_err(|e| IgclError::local("load", e.to_string()))?.is_file()
            || !path.extension().is_some_and(|e| e.eq_ignore_ascii_case("dll")) {
            return Err(IgclError::local("load", "path must identify an existing DLL file"));
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) { return Err(IgclError::local("load", "embedded NUL in DLL path")); }
        wide.push(0);
        // The host must ensure trusted ACLs for the DLL and its directory.
        // SEARCH_DLL_LOAD_DIR permits only adjacent trusted dependencies;
        // SEARCH_SYSTEM32 excludes current directory and PATH resolution.
        let module = unsafe { LoadLibraryExW(wide.as_ptr(), ptr::null_mut(),
            LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32) };
        if module.is_null() { return Err(IgclError::local("LoadLibraryExW", std::io::Error::last_os_error().to_string())); }
        Ok(Self(module))
    }
    unsafe fn functions(&self) -> Result<Functions, IgclError> {
        use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
        macro_rules! bind {
            ($name:literal, $ty:ty) => {{
                let function = unsafe { GetProcAddress(self.0, concat!($name, "\0").as_ptr()) }
                    .ok_or_else(|| IgclError::local("GetProcAddress", concat!("missing ", $name)))?;
                // Every signature is independently declared above from igcl_api.h.
                unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(function) }
            }};
        }
        macro_rules! optional {
            ($name:literal, $ty:ty) => {{
                unsafe { GetProcAddress(self.0, concat!($name, "\0").as_ptr()) }
                    .map(|function| unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(function) })
            }};
        }
        Ok(Functions {
            init: bind!("ctlInit", InitFn), close: bind!("ctlClose", CloseFn),
            enumerate: bind!("ctlEnumerateDevices", EnumerateFn), properties: bind!("ctlGetDeviceProperties", PropertiesFn),
            pci_properties: optional!("ctlPciGetProperties", ctlPciGetPropertiesFn),
            overclock: optional!("ctlOverclockGetProperties", ctlOverclockGetPropertiesFn),
            supported_3d: optional!("ctlGetSupported3DCapabilities", ctlGetSupported3DCapabilitiesFn),
            set_3d: optional!("ctlGetSet3DFeature", ctlGetSet3DFeatureFn),
            enum_fans: optional!("ctlEnumFans", ctlEnumFansFn),
            fan: optional!("ctlFanGetProperties", ctlFanGetPropertiesFn),
            fan_config: optional!("ctlFanGetConfig", ctlFanGetConfigFn),
            fan_set_default: optional!("ctlFanSetDefaultMode", ctlFanSetDefaultModeFn),
            fan_set_fixed: optional!("ctlFanSetFixedSpeedMode", ctlFanSetFixedSpeedModeFn),
            fan_set_table: optional!("ctlFanSetSpeedTableMode", ctlFanSetSpeedTableModeFn),

            power_limit: optional!("ctlOverclockPowerLimitGetV2", ctlOverclockPowerLimitGetV2Fn),
            temp_limit: optional!("ctlOverclockTemperatureLimitGetV2", ctlOverclockTemperatureLimitGetV2Fn),
            voltage_offset: optional!("ctlOverclockGpuMaxVoltageOffsetGetV2", ctlOverclockGpuMaxVoltageOffsetGetV2Fn),
            frequency_offset: optional!("ctlOverclockGpuFrequencyOffsetGetV2", ctlOverclockGpuFrequencyOffsetGetV2Fn),
            vram_freq: optional!("ctlOverclockVramMemSpeedLimitGetV2", ctlOverclockVramMemSpeedLimitGetV2Fn),
            power_limit_set: optional!("ctlOverclockPowerLimitSetV2", ctlOverclockPowerLimitSetV2Fn),
            temp_limit_set: optional!("ctlOverclockTemperatureLimitSetV2", ctlOverclockTemperatureLimitSetV2Fn),
            voltage_offset_set: optional!("ctlOverclockGpuMaxVoltageOffsetSetV2", ctlOverclockGpuMaxVoltageOffsetSetV2Fn),
            frequency_offset_set: optional!("ctlOverclockGpuFrequencyOffsetSetV2", ctlOverclockGpuFrequencyOffsetSetV2Fn),
            vram_freq_set: optional!("ctlOverclockVramMemSpeedLimitSetV2", ctlOverclockVramMemSpeedLimitSetV2Fn),
            vf_write: optional!("ctlOverclockWriteCustomVFCurve", ctlOverclockWriteCustomVFCurveFn),
            overclock_reset: optional!("ctlOverclockResetToDefault", ctlOverclockResetToDefaultFn),
            waiver_set: optional!("ctlOverclockWaiverSet", ctlOverclockWaiverSetFn),
            legacy_power_get: optional!("ctlOverclockPowerLimitGet", ctlOverclockPowerLimitGetFn),
            legacy_power_set: optional!("ctlOverclockPowerLimitSet", ctlOverclockPowerLimitSetFn),
            legacy_temp_get: optional!("ctlOverclockTemperatureLimitGet", ctlOverclockTemperatureLimitGetFn),
            legacy_temp_set: optional!("ctlOverclockTemperatureLimitSet", ctlOverclockTemperatureLimitSetFn),
            gpu_lock: optional!("ctlOverclockGpuLockGet", ctlOverclockGpuLockGetFn),
            gpu_lock_set: optional!("ctlOverclockGpuLockSet", ctlOverclockGpuLockSetFn),
            vf_curve: optional!("ctlOverclockReadVFCurve", ctlOverclockReadVFCurveFn),
            enumerate_displays: optional!("ctlEnumerateDisplayOutputs", ctlEnumerateDisplayOutputsFn),
            display_properties: optional!("ctlGetDisplayProperties", ctlGetDisplayPropertiesFn),
            display_settings: optional!("ctlGetSetDisplaySettings", ctlGetSetDisplaySettingsFn),
            edid: optional!("ctlEdidManagement", ctlEdidManagementFn),
            panel_descriptor: optional!("ctlPanelDescriptorAccess", ctlPanelDescriptorAccessFn),
            wire_format: optional!("ctlGetSetWireFormat", ctlGetSetWireFormatFn),
            pixel_transformation: optional!("ctlPixelTransformationGetConfig", ctlPixelTransformationGetConfigFn),
            pixel_transformation_set: optional!("ctlPixelTransformationSetConfig", ctlPixelTransformationSetConfigFn),
            scaling_caps: optional!("ctlGetSupportedScalingCapability", ctlGetSupportedScalingCapabilityFn),
            current_scaling: optional!("ctlGetCurrentScaling", ctlGetCurrentScalingFn),
            set_current_scaling: optional!("ctlSetCurrentScaling", ctlSetCurrentScalingFn),
            retro_scaling_caps: optional!("ctlGetSupportedRetroScalingCapability", ctlGetSupportedRetroScalingCapabilityFn),
            retro_scaling: optional!("ctlGetSetRetroScaling", ctlGetSetRetroScalingFn),
            arc_sync_monitor: optional!("ctlGetIntelArcSyncInfoForMonitor", ctlGetIntelArcSyncInfoForMonitorFn),
            arc_sync_profile_get: optional!("ctlGetIntelArcSyncProfile", ctlGetIntelArcSyncProfileFn),
            arc_sync_profile_set: optional!("ctlSetIntelArcSyncProfile", ctlSetIntelArcSyncProfileFn),
        })
    }
}
#[cfg(windows)]
impl Drop for Library {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::FreeLibrary(self.0); } }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::{Cell, RefCell}, mem::{align_of, size_of}};
    use std::sync::{atomic::{AtomicUsize, Ordering}, Mutex};
    static ARC_SYNC_SET_CALLS: AtomicUsize = AtomicUsize::new(0);
    // The Arc Sync setter counter is process-global, so the tests that observe
    // it must not run concurrently with each other under the parallel harness.
    static ARC_SYNC_SET_TEST_LOCK: Mutex<()> = Mutex::new(());
    thread_local! { static PIXEL_TRANSFORMATION_SET_CALLS: Cell<usize> = const { Cell::new(0) }; }
    thread_local! { static ARC_SYNC_SET_CAPTURE: RefCell<Option<(i32, f32, f32, u32, u32)>> = const { RefCell::new(None) }; }

    #[derive(Default)]
    struct State {
        flags: Vec<u32>, init_results: Vec<u32>, close_result: u32, closes: usize,
        count: u32, fill_count: Option<u32>, enum_result: u32, props_result: u32, null_api: bool,
    }
    thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }

    #[derive(Default)]
    struct DisplayEnumerationDriver {
        count: u32,
        fill_count: Option<u32>,
        count_status: u32,
        fill_status: u32,
        null_handle: bool,
    }
    thread_local! { static DISPLAY_ENUMERATION_DRIVER: RefCell<DisplayEnumerationDriver> = RefCell::new(DisplayEnumerationDriver::default()); }

    #[derive(Default)]
    struct GlobalVrrDriver {
        supported_types: u64,
        current_value: u32,
        current_scope: u32,
        get_status: u32,
        set_status: u32,
        requests: Vec<(u8, i32, i32, i8, String, [u8; 8])>,
    }
    thread_local! { static GLOBAL_VRR_DRIVER: RefCell<GlobalVrrDriver> = RefCell::new(GlobalVrrDriver::default()); }

    #[derive(Default)]
    struct DisplayGetSetDriver {
        settings: Vec<(u32, u8, u8, u32)>,
        setting_sets: Vec<(u32, u8, u8, u32, u32, u32, i32)>,
        settings_headroom: Vec<(bool, [u8; 16])>,
        settings_result: u32,
        wire_format: Vec<(u32, u8, i32, [(u32, u8, i32, u32); 4], (u32, u8, i32, u32))>,
        wire_format_headroom: Vec<(bool, [u8; 16])>,
        retro_scaling: Vec<(u32, u8, u8, u8, u32)>,
        write_attempts: usize,
    }
    thread_local! { static DISPLAY_GETSET_DRIVER: RefCell<DisplayGetSetDriver> = RefCell::new(DisplayGetSetDriver::default()); }

    unsafe extern "C" fn fake_display_enumerate(_adapter: Handle, count: *mut u32, outputs: *mut Handle) -> u32 {
        DISPLAY_ENUMERATION_DRIVER.with(|state| {
            let state = state.borrow();
            if outputs.is_null() {
                unsafe { *count = state.count; }
                state.count_status
            } else {
                let capacity = unsafe { *count };
                for index in 0..capacity {
                    let handle = if state.null_handle { ptr::null_mut() } else { (index as usize + 10) as Handle };
                    unsafe { *outputs.add(index as usize) = handle; }
                }
                unsafe { *count = state.fill_count.unwrap_or(state.count); }
                state.fill_status
            }
        })
    }

    unsafe extern "C" fn fake_display_settings(_handle: Handle, raw: *mut c_void) -> u32 {
        let settings = unsafe { &mut *raw.cast::<ctl_display_settings_t>() };
        let headroom = unsafe {
            std::slice::from_raw_parts_mut(
                raw.cast::<u8>().add(size_of::<ctl_display_settings_t>()), 16,
            )
        };
        let headroom_was_zero = headroom.iter().all(|byte| *byte == 0);
        headroom.fill(0xa5);
        let mut headroom_after_fake = [0; 16];
        headroom_after_fake.copy_from_slice(headroom);
        let result = DISPLAY_GETSET_DRIVER.with(|state| {
            let mut state = state.borrow_mut();
            state.settings_headroom.push((headroom_was_zero, headroom_after_fake));
            if settings.Set != 0 || settings.ValidFlags != 0 { state.write_attempts += 1; }
            state.settings.push((settings.Size, settings.Version, settings.Set, settings.ValidFlags));
            if settings.Set != 0 {
                state.setting_sets.push((settings.Size, settings.Version, settings.Set,
                    settings.SupportedFlags, settings.ControllableFlags, settings.ValidFlags,
                    settings.QuantizationRange));
            }
            state.settings_result
        });
        settings.QuantizationRange = 2;
        settings.ControllableFlags = 1 << 3;
        result
    }

    unsafe extern "C" fn fake_display_wire_format(_handle: Handle, raw: *mut c_void) -> u32 {
        let config = unsafe { &mut *raw.cast::<ctl_get_set_wire_format_config_t>() };
        let headroom = unsafe {
            std::slice::from_raw_parts_mut(
                raw.cast::<u8>().add(size_of::<ctl_get_set_wire_format_config_t>()), 16,
            )
        };
        let was_zero = headroom.iter().all(|byte| *byte == 0);
        headroom.fill(0xa5);
        let mut tail = [0; 16];
        tail.copy_from_slice(headroom);
        let headroom_record = (was_zero, tail);
        let supported = std::array::from_fn(|index| {
            let entry = config.SupportedWireFormat[index];
            (entry.Size, entry.Version, entry.ColorModel, entry.ColorDepth)
        });
        let current = config.WireFormat;
        DISPLAY_GETSET_DRIVER.with(|state| {
            let mut state = state.borrow_mut();
            if config.Operation != 0 { state.write_attempts += 1; }
            state.wire_format_headroom.push(headroom_record);
            state.wire_format.push((config.Size, config.Version, config.Operation, supported,
                (current.Size, current.Version, current.ColorModel, current.ColorDepth)));
        });
        config.SupportedWireFormat[0].ColorModel = 1;
        config.SupportedWireFormat[0].ColorDepth = 0b0011;
        config.WireFormat.ColorModel = 2;
        config.WireFormat.ColorDepth = 0b0100;
        SUCCESS
    }

    unsafe extern "C" fn fake_display_retro_scaling(_handle: Handle, raw: *mut c_void) -> u32 {
        let settings = unsafe { &mut *raw.cast::<ctl_retro_scaling_settings_t>() };
        DISPLAY_GETSET_DRIVER.with(|state| {
            let mut state = state.borrow_mut();
            if settings.Get != 1 { state.write_attempts += 1; }
            state.retro_scaling.push((settings.Size, settings.Version, settings.Get,
                settings.Enable, settings.RetroScalingType));
        });
        settings.Enable = 1;
        settings.RetroScalingType = 2;
        SUCCESS
    }

    #[test]
    fn display_shared_get_set_exports_are_called_get_only_and_fully_initialized() {
        DISPLAY_GETSET_DRIVER.with(|state| *state.borrow_mut() = DisplayGetSetDriver::default());
        let session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.display_settings = Some(fake_display_settings);
            functions.wire_format = Some(fake_display_wire_format);
            functions.retro_scaling = Some(fake_display_retro_scaling);
        }).unwrap();

        let settings = session.display_settings(2 as Handle).unwrap();
        assert_eq!(settings.QuantizationRange, 2);
        assert_eq!(settings.ControllableFlags, 1 << 3);
        let wire_format = session.display_wire_format(2 as Handle).unwrap();
        assert_eq!((wire_format.WireFormat.ColorModel, wire_format.WireFormat.ColorDepth), (2, 0b0100));
        let retro_scaling = session.display_retro_scaling(2 as Handle).unwrap();
        assert_eq!((retro_scaling.Get, retro_scaling.Enable, retro_scaling.RetroScalingType), (1, 1, 2));

        DISPLAY_GETSET_DRIVER.with(|state| {
            let state = state.borrow();
            assert_eq!(state.settings, vec![(
                size_of::<ctl_display_settings_t>() as u32, 0, 0, 0,
            )], "display settings must enter the shared export with Set and ValidFlags clear");
            assert_eq!(size_of::<DisplaySettingsBuffer>(), size_of::<ctl_display_settings_t>() + 16);
            assert_eq!(state.settings_headroom, vec![(true, [0xa5; 16])]);

            let wire_header = size_of::<ctl_wire_format_t>() as u32;
            assert_eq!(state.wire_format, vec![(
                size_of::<ctl_get_set_wire_format_config_t>() as u32,
                0,
                0,
                [(wire_header, 0, 0, 0); 4],
                (wire_header, 0, 0, 0),
            )], "wire-format GET must initialize the outer and every nested header");
            assert_eq!(state.wire_format_headroom, vec![(true, [0xa5; 16])],
                "wire-format GET must include the same zeroed 16-byte tail as Electron");

            assert_eq!(state.retro_scaling, vec![(
                size_of::<ctl_retro_scaling_settings_t>() as u32, 0, 1, 0, 0,
            )], "retro scaling must enter the shared export with Get set and no requested values");
            assert_eq!(state.write_attempts, 0, "the Display read never uses these shared exports in SET mode");
        });
    }

    #[test]
    fn retro_scaling_apply_uses_set_mode_and_the_selected_method() {
        DISPLAY_GETSET_DRIVER.with(|state| *state.borrow_mut() = DisplayGetSetDriver::default());
        let session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.retro_scaling = Some(fake_display_retro_scaling);
        }).unwrap();

        session.display_apply_api().set_retro_scaling(12 as Handle, true, 2).unwrap();

        DISPLAY_GETSET_DRIVER.with(|state| {
            let state = state.borrow();
            assert_eq!(state.retro_scaling, vec![(
                size_of::<ctl_retro_scaling_settings_t>() as u32, 0, 0, 1, 2,
            )], "Retro Scaling SET must clear Get and send the requested enabled/type pair");
            assert_eq!(state.write_attempts, 1);
        });
    }

    #[test]
    fn quantization_apply_uses_only_the_validated_display_setting_flag() {
        DISPLAY_GETSET_DRIVER.with(|state| *state.borrow_mut() = DisplayGetSetDriver::default());
        let session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.display_settings = Some(fake_display_settings);
        }).unwrap();

        for value in 0..=2 {
            session.display_apply_api().set_quantization_range(12 as Handle, value).unwrap();
        }

        DISPLAY_GETSET_DRIVER.with(|state| {
            let state = state.borrow();
            assert_eq!(state.setting_sets, [0, 1, 2].map(|value| (
                size_of::<ctl_display_settings_t>() as u32,
                0,
                1,
                0,
                0,
                1 << 3,
                value,
            )));
            assert_eq!(size_of::<DisplaySettingsBuffer>(), size_of::<ctl_display_settings_t>() + 16);
            assert_eq!(state.settings_headroom, vec![(true, [0xa5; 16]); 3]);
            assert_eq!(state.write_attempts, 3);
        });
    }

    #[test]
    fn quantization_apply_rejects_invalid_targets_and_reports_driver_refusal() {
        DISPLAY_GETSET_DRIVER.with(|state| *state.borrow_mut() = DisplayGetSetDriver::default());
        let session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.display_settings = Some(fake_display_settings);
        }).unwrap();
        assert!(session.display_apply_api().set_quantization_range(ptr::null_mut(), 2).is_err());
        assert!(session.display_apply_api().set_quantization_range(12 as Handle, 3).is_err());
        DISPLAY_GETSET_DRIVER.with(|state| assert_eq!(state.borrow().write_attempts, 0));

        DISPLAY_GETSET_DRIVER.with(|state| state.borrow_mut().settings_result = ERROR_DATA_READ);
        let error = session.display_apply_api().set_quantization_range(12 as Handle, 2).unwrap_err();
        assert_eq!(error.operation, "ctlGetSetDisplaySettings(SET)");
        assert_eq!(error.status, Some(ERROR_DATA_READ));
    }

    #[test]
    fn wire_format_apply_uses_set_operation_nested_headers_and_zeroed_headroom() {
        DISPLAY_GETSET_DRIVER.with(|state| *state.borrow_mut() = DisplayGetSetDriver::default());
        let session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.wire_format = Some(fake_display_wire_format);
        }).unwrap();

        session.display_apply_api().set_wire_format(12 as Handle, 3, 0b0100).unwrap();
        assert!(session.display_apply_api().set_wire_format(ptr::null_mut(), 3, 0b0100).is_err());
        assert!(session.display_apply_api().set_wire_format(12 as Handle, 4, 0b0100).is_err());
        assert!(session.display_apply_api().set_wire_format(12 as Handle, 3, 0b0011).is_err(),
            "combined depth flags are not an exact readable wire-format pair");

        DISPLAY_GETSET_DRIVER.with(|state| {
            let state = state.borrow();
            let wire_header = size_of::<ctl_wire_format_t>() as u32;
            assert_eq!(state.wire_format, vec![(
                size_of::<ctl_get_set_wire_format_config_t>() as u32,
                0,
                1,
                [(wire_header, 0, 0, 0); 4],
                (wire_header, 0, 3, 0b0100),
            )]);
            assert_eq!(size_of::<WireFormatBuffer>(), size_of::<ctl_get_set_wire_format_config_t>() + 16);
            assert_eq!(state.wire_format_headroom, vec![(true, [0xa5; 16])]);
            assert_eq!(state.write_attempts, 1);
        });
    }

    unsafe extern "C" fn fake_supported_3d(_adapter: Handle, raw: *mut c_void) -> u32 {
        let caps = unsafe { &mut *raw.cast::<ctl_3d_feature_caps_t>() };
        if caps.pFeatureDetails.is_null() {
            caps.NumSupportedFeatures = 1;
            return SUCCESS;
        }
        let count = caps.NumSupportedFeatures as usize;
        let details = unsafe {
            std::slice::from_raw_parts_mut(caps.pFeatureDetails.cast::<ctl_3d_feature_details_t>(), count)
        };
        let mut detail: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
        detail.FeatureType = 14;
        detail.ValueType = 4;
        GLOBAL_VRR_DRIVER.with(|state| {
            let mask = state.borrow().supported_types.to_le_bytes();
            detail.Value[0..8].copy_from_slice(&mask);
        });
        if let Some(slot) = details.first_mut() { *slot = detail; }
        caps.NumSupportedFeatures = 1;
        SUCCESS
    }

    unsafe extern "C" fn fake_supported_3d_with_scope(_adapter: Handle, raw: *mut c_void) -> u32 {
        let caps = unsafe { &mut *raw.cast::<ctl_3d_feature_caps_t>() };
        if caps.pFeatureDetails.is_null() {
            caps.NumSupportedFeatures = 2;
            return SUCCESS;
        }
        let count = caps.NumSupportedFeatures as usize;
        let details = unsafe {
            std::slice::from_raw_parts_mut(caps.pFeatureDetails.cast::<ctl_3d_feature_details_t>(), count)
        };
        let mut vrr: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
        vrr.FeatureType = 14;
        vrr.ValueType = 4;
        let mut scope: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
        scope.FeatureType = 15;
        scope.ValueType = 4;
        GLOBAL_VRR_DRIVER.with(|state| {
            vrr.Value[0..8].copy_from_slice(&state.borrow().supported_types.to_le_bytes());
        });
        scope.Value[0..8].copy_from_slice(&(1_u64 << 2).to_le_bytes());
        if let Some(slot) = details.first_mut() { *slot = vrr; }
        if let Some(slot) = details.get_mut(1) { *slot = scope; }
        caps.NumSupportedFeatures = 2;
        SUCCESS
    }

    unsafe extern "C" fn fake_global_vrr_getset(_adapter: Handle, raw: *mut c_void) -> u32 {
        let request = unsafe { &mut *raw.cast::<ctl_3d_feature_getset_t>() };
        let application_name = if request.ApplicationName.is_null() { "<null>".to_owned() } else {
            unsafe { std::ffi::CStr::from_ptr(request.ApplicationName.cast()) }
                .to_string_lossy().into_owned()
        };
        let mut initial_value = [0_u8; 8];
        initial_value.copy_from_slice(&request.Value);
        GLOBAL_VRR_DRIVER.with(|state| {
            let mut state = state.borrow_mut();
            state.requests.push((request.bSet, request.FeatureType, request.ValueType,
                request.ApplicationNameLength, application_name, initial_value));
            if request.bSet != 0 {
                if state.set_status != SUCCESS { return state.set_status; }
                let value = u32::from_le_bytes(request.Value[0..4].try_into().unwrap());
                match request.FeatureType {
                    14 => state.current_value = value,
                    15 => state.current_scope = value,
                    _ => return ERROR_INVALID_ARGUMENT,
                }
                return SUCCESS;
            }
            request.Value[0..4].copy_from_slice(&state.current_value.to_le_bytes());
            state.get_status
        })
    }

    #[derive(Clone, Copy, Debug, Default)]
    struct PixelBlockFixture {
        size: u32,
        id: u32,
        block_type: u32,
        sampling_type: u32,
        num_samples_per_channel: u32,
        num_channels: u32,
    }
    #[derive(Default)]
    struct PixelDriver {
        calls: usize,
        count_status: u32,
        count: u32,
        fill_status: u32,
        returned_count: Option<u32>,
        blocks: Vec<PixelBlockFixture>,
    }
    thread_local! { static PIXEL_DRIVER: RefCell<PixelDriver> = RefCell::new(PixelDriver::default()); }
    thread_local! { static PIXEL_SET_CAPTURE: RefCell<Option<(Vec<u8>, Vec<f64>)>> = const { RefCell::new(None) }; }

    unsafe extern "C" fn fake_pixel_transformation(_handle: Handle, raw: *mut c_void) -> u32 {
        let header = unsafe {
            std::slice::from_raw_parts_mut(raw.cast::<u8>(), PIXEL_GET_CONFIG_SIZE + 16)
        };
        assert_eq!(read_u32(header, 0), PIXEL_GET_CONFIG_SIZE as u32);
        assert_eq!(header[4], 0);
        assert_eq!(read_u32(header, 8), PIXEL_QUERY_CAPABILITIES);
        assert_eq!(read_u32(header, 16), 0, "capability header omits format output fields");
        assert_eq!(read_u32(header, 136), 0, "capability header omits format output fields");
        assert_eq!(&header[PIXEL_GET_CONFIG_SIZE..], &[0; 16], "GET header has Electron's 16-byte headroom");

        PIXEL_DRIVER.with(|state| {
            let mut state = state.borrow_mut();
            let call = state.calls;
            state.calls += 1;
            if call == 0 {
                assert_eq!(read_u32(header, 256), 0);
                assert_eq!(read_u64(header, 264), 0);
                write_u32(header, 256, state.count);
                return state.count_status;
            }

            let count = read_u32(header, 256);
            assert_eq!(count, state.count);
            let address = read_u64(header, 264) as usize;
            assert_ne!(address, 0);
            assert_eq!(address % align_of::<u64>(), 0, "block list remains pointer-aligned");
            let blocks = unsafe {
                std::slice::from_raw_parts_mut(
                    address as *mut u8,
                    PIXEL_BLOCK_CONFIG_SIZE * count as usize + 16,
                )
            };
            let returned_count = state.returned_count.unwrap_or(state.count);
            write_u32(header, 256, returned_count);
            for (index, fixture) in state.blocks.iter().take(count as usize).enumerate() {
                let offset = index * PIXEL_BLOCK_CONFIG_SIZE;
                assert_eq!(read_u32(blocks, offset), PIXEL_BLOCK_CONFIG_SIZE as u32);
                assert_eq!(blocks[offset + 4], 0);
                write_u32(blocks, offset, fixture.size);
                write_u32(blocks, offset + 8, fixture.id);
                write_u32(blocks, offset + 12, fixture.block_type);
                write_u32(blocks, offset + 16, if fixture.block_type == PIXEL_BLOCK_LUT_1D {
                    PIXEL_LUT_CONFIG_SIZE
                } else {
                    PIXEL_MATRIX_CONFIG_SIZE
                });
                write_u32(blocks, offset + 24, fixture.sampling_type);
                write_u32(blocks, offset + 28, fixture.num_samples_per_channel);
                write_u32(blocks, offset + 32, fixture.num_channels);
                if fixture.block_type == 1 {
                    write_u64(blocks, offset + 40, 0x1234_5678);
                    write_u64(blocks, offset + 48, 0x8765_4321);
                }
            }
            state.fill_status
        })
    }

    unsafe extern "C" fn fake_pixel_transformation_set(_handle: Handle, raw: *mut c_void) -> u32 {
        PIXEL_TRANSFORMATION_SET_CALLS.with(|calls| calls.set(calls.get() + 1));
        let header = unsafe { std::slice::from_raw_parts(raw.cast::<u8>(), PIXEL_SET_CONFIG_SIZE + 16) };
        assert_eq!(read_u32(header, 0), PIXEL_SET_CONFIG_SIZE as u32);
        assert_eq!(header[4], 0);
        assert_eq!(read_u32(header, 8), PIXEL_SET_CUSTOM);
        assert_eq!(read_u32(header, 12), 0);
        assert_eq!(read_u32(header, 16), 1);
        let address = read_u64(header, 24) as usize;
        assert_ne!(address, 0);
        assert_eq!(address % align_of::<u64>(), 0);
        let block = unsafe { std::slice::from_raw_parts(address as *const u8, PIXEL_BLOCK_CONFIG_SIZE + 16) };
        assert_eq!(read_u32(block, 0), PIXEL_BLOCK_CONFIG_SIZE as u32);
        assert_eq!(block[4], 0);
        let raw_block = block[..PIXEL_BLOCK_CONFIG_SIZE].to_vec();
        let samples = if read_u32(block, 12) == PIXEL_BLOCK_LUT_1D {
            let count = read_u32(block, 28) as usize;
            let channels = read_u32(block, 32) as usize;
            let pointer = read_u64(block, 40) as usize;
            assert_ne!(pointer, 0);
            assert_eq!(pointer % align_of::<f64>(), 0);
            let values = unsafe { std::slice::from_raw_parts(pointer as *const f64, count * channels) };
            values.to_vec()
        } else { Vec::new() };
        PIXEL_SET_CAPTURE.with(|capture| *capture.borrow_mut() = Some((raw_block, samples)));
        SUCCESS
    }

    fn pixel_matrix(id: u32) -> PixelBlockFixture {
        PixelBlockFixture { size: PIXEL_BLOCK_CONFIG_SIZE as u32, id, block_type: 3, ..PixelBlockFixture::default() }
    }

    fn pixel_lut(id: u32, sampling_type: u32, samples: u32, channels: u32) -> PixelBlockFixture {
        PixelBlockFixture {
            size: PIXEL_BLOCK_CONFIG_SIZE as u32, id, block_type: 1, sampling_type,
            num_samples_per_channel: samples, num_channels: channels,
        }
    }

    fn start_pixel(driver: PixelDriver, set_available: bool) -> ReadOnlyIgcl {
        PIXEL_DRIVER.with(|state| *state.borrow_mut() = driver);
        PIXEL_SET_CAPTURE.with(|capture| *capture.borrow_mut() = None);
        PIXEL_TRANSFORMATION_SET_CALLS.with(|calls| calls.set(0));
        start_with(State { count: 1, ..State::default() }, |functions| {
            functions.pixel_transformation = Some(fake_pixel_transformation);
            functions.pixel_transformation_set = set_available.then_some(fake_pixel_transformation_set);
        }).unwrap()
    }
    fn pixel_set_call_count() -> usize { PIXEL_TRANSFORMATION_SET_CALLS.with(Cell::get) }
    unsafe extern "C" fn fake_init(args: *mut InitArgs, api: *mut Handle) -> u32 {
        let args = unsafe { &*args };
        assert_eq!(args.size, 36); assert_eq!(args.version, 0); assert_eq!(args.app_version, 0x10001);
        assert_eq!(args.supported_version, 0); assert_eq!(args.application_uid, ApplicationId::default());
        STATE.with(|state| { let mut state = state.borrow_mut(); state.flags.push(args.flags);
            unsafe { *api = if state.null_api { ptr::null_mut() } else { 1_usize as Handle }; }
            if state.init_results.is_empty() { 0 } else { state.init_results.remove(0) }
        })
    }
    unsafe extern "C" fn fake_close(_api: Handle) -> u32 {
        STATE.with(|s| { let mut s = s.borrow_mut(); s.closes += 1; s.close_result })
    }
    unsafe extern "C" fn fake_enum(_api: Handle, count: *mut u32, handles: *mut Handle) -> u32 {
        STATE.with(|s| { let s = s.borrow();
            if handles.is_null() { unsafe { *count = s.count; } }
            else { let capacity = unsafe { *count }; for index in 0..capacity { unsafe { *handles.add(index as usize) = (index as usize + 2) as Handle; } }
                unsafe { *count = s.fill_count.unwrap_or(s.count); } }
            s.enum_result
        })
    }
    unsafe extern "C" fn fake_properties(_device: Handle, props: *mut AdapterProperties) -> u32 {
        let props = unsafe { &mut *props };
        assert_eq!(props.size, 320); assert_eq!(props.version, 3); assert_eq!(props.device_id_size, 8);
        assert!(!props.device_id.is_null());
        assert_eq!(props.device_id as usize % 8, 0);
        unsafe { std::ptr::copy_nonoverlapping([1_u8,2,3,4,5,6,7,8].as_ptr(), props.device_id.cast(), 8); }
        props.name[..4].copy_from_slice(b"Arc\0"); props.pci_vendor_id = 0x8086;
        props.device_type = 1; props.driver_version = 0x1234; props.num_xe_cores = 20;
        STATE.with(|s| s.borrow().props_result)
    }
    fn base_functions() -> Functions {
        Functions {init: fake_init, close: fake_close, enumerate: fake_enum, properties: fake_properties, supported_3d: None, set_3d: None,
            pci_properties: None, overclock: None, enum_fans: None, fan: None, fan_config: None,
            fan_set_default: None, fan_set_fixed: None, fan_set_table: None,
            power_limit: None, temp_limit: None,
            voltage_offset: None, frequency_offset: None, vram_freq: None, gpu_lock: None, gpu_lock_set: None, vf_curve: None,
            power_limit_set: None, temp_limit_set: None, voltage_offset_set: None,
            frequency_offset_set: None, vram_freq_set: None, vf_write: None, overclock_reset: None, waiver_set: None,
            legacy_power_get: None, legacy_power_set: None, legacy_temp_get: None, legacy_temp_set: None,
            enumerate_displays: None, display_properties: None, display_settings: None,
            edid: None, panel_descriptor: None,
            wire_format: None, pixel_transformation: None, pixel_transformation_set: None,
            scaling_caps: None, current_scaling: None, set_current_scaling: None,
            retro_scaling_caps: None, retro_scaling: None,
            arc_sync_monitor: None, arc_sync_profile_get: None, arc_sync_profile_set: None}
    }
    fn start(state: State) -> Result<ReadOnlyIgcl, IgclError> {
        start_with(state, |_| {})
    }
    fn start_with(state: State, configure: impl FnOnce(&mut Functions)) -> Result<ReadOnlyIgcl, IgclError> {
        STATE.with(|s| *s.borrow_mut() = state);
        let mut functions = base_functions();
        configure(&mut functions);
        ReadOnlyIgcl::initialize(functions, #[cfg(windows)] None)
    }

    #[test]
    fn legacy_init_uses_2023_arguments_and_retries_only_uid_errors() {
        use std::cell::RefCell;
        thread_local! { static CALLS: RefCell<Vec<InitArgs>> = const { RefCell::new(Vec::new()) }; }
        unsafe extern "C" fn init(args: *mut InitArgs, api: *mut Handle) -> u32 {
            let args = unsafe { *args };
            CALLS.with(|calls| calls.borrow_mut().push(args));
            if args.application_uid == ApplicationId::default() { return 0x4000_0021; }
            unsafe { *api = 1_usize as Handle; }
            0
        }
        unsafe extern "C" fn properties(_handle: Handle, props: *mut AdapterProperties) -> u32 {
            let props = unsafe { &*props };
            assert_eq!(props.version, 0);
            assert!(props.device_id.is_null());
            assert_eq!(props.device_id_size, 0);
            0
        }
        STATE.with(|state| *state.borrow_mut() = State { count: 1, ..State::default() });
        CALLS.with(|calls| calls.borrow_mut().clear());
        let mut functions = base_functions();
        functions.init = init;
        functions.properties = properties;
        let mut session = ReadOnlyIgcl::initialize_legacy(functions, #[cfg(windows)] None).unwrap();
        session.enumerate_adapters().unwrap();
        CALLS.with(|calls| {
            let calls = calls.borrow();
            assert_eq!(calls.len(), 2);
            assert_eq!((calls[0].size, calls[0].version, calls[0].app_version, calls[0].flags), (36, 0, 0x10000, USE_LEVEL_ZERO));
            assert_eq!(calls[0].application_uid, ApplicationId::default());
            assert_eq!(calls[1].application_uid.data1, 0xe8e10f95);
            assert_eq!(calls[1].application_uid.data4, [0x9c, 0xcf, 0x02, 0x01, 0x02, 0x64, 0xe9, 0xc8]);
        });
    }

    #[test]
    fn display_output_enumeration_keeps_empty_topology_distinct_from_failures() {
        DISPLAY_ENUMERATION_DRIVER.with(|state| *state.borrow_mut() = DisplayEnumerationDriver::default());
        let mut session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.enumerate_displays = Some(fake_display_enumerate);
        }).unwrap();
        session.enumerate_adapters().unwrap();
        assert!(session.display_outputs(0).unwrap().is_empty(), "a successful zero count is a valid empty topology");

        DISPLAY_ENUMERATION_DRIVER.with(|state| *state.borrow_mut() = DisplayEnumerationDriver {
            count: 1, count_status: ERROR_DATA_READ, ..DisplayEnumerationDriver::default()
        });
        let error = session.display_outputs(0).unwrap_err();
        assert_eq!(error.operation, "ctlEnumerateDisplayOutputs(count)");
        assert_eq!(error.status, Some(ERROR_DATA_READ));

        DISPLAY_ENUMERATION_DRIVER.with(|state| *state.borrow_mut() = DisplayEnumerationDriver {
            count: MAX_DISPLAY_OUTPUTS, ..DisplayEnumerationDriver::default()
        });
        assert!(session.display_outputs(0).unwrap_err().detail.contains("allocation bound"));

        DISPLAY_ENUMERATION_DRIVER.with(|state| *state.borrow_mut() = DisplayEnumerationDriver {
            count: 1, fill_status: ERROR_DATA_READ, ..DisplayEnumerationDriver::default()
        });
        let error = session.display_outputs(0).unwrap_err();
        assert_eq!(error.operation, "ctlEnumerateDisplayOutputs(fill)");
        assert_eq!(error.status, Some(ERROR_DATA_READ));
    }

    #[test]
    fn global_vrr_get_uses_enum_global_adapter_request_and_never_sets() {
        GLOBAL_VRR_DRIVER.with(|state| *state.borrow_mut() = GlobalVrrDriver {
            supported_types: 0b101,
            current_value: 2,
            ..GlobalVrrDriver::default()
        });
        let mut session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.supported_3d = Some(fake_supported_3d);
            functions.set_3d = Some(fake_global_vrr_getset);
        }).unwrap();
        session.enumerate_adapters().unwrap();
        assert!(session.display_igsc_full_available());
        assert!(session.display_global_vrr_api_available());
        let details = session.supported_3d_features(0).unwrap();
        assert_eq!(details.len(), 1);
        assert_eq!((details[0].FeatureType, details[0].ValueType), (14, 4));
        assert_eq!(session.display_global_vrr_mode(0).unwrap(), 2);
        GLOBAL_VRR_DRIVER.with(|state| {
            let state = state.borrow();
            assert_eq!(state.requests.len(), 1);
            let (set, feature, value_type, app_len, app_name, initial_value) = &state.requests[0];
            assert_eq!((*set, *feature, *value_type, *app_len, app_name.as_str()), (0, 14, 4, 0, ""));
            assert_eq!(*initial_value, [0; 8]);
        });
    }

    #[test]
    fn global_vrr_invalid_argument_is_a_read_refusal_without_scope_set_retry() {
        GLOBAL_VRR_DRIVER.with(|state| *state.borrow_mut() = GlobalVrrDriver {
            supported_types: 0b111,
            get_status: ERROR_INVALID_ARGUMENT,
            ..GlobalVrrDriver::default()
        });
        let mut session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.supported_3d = Some(fake_supported_3d);
            functions.set_3d = Some(fake_global_vrr_getset);
        }).unwrap();
        session.enumerate_adapters().unwrap();
        let error = session.display_global_vrr_mode(0).unwrap_err();
        assert_eq!(error.status, Some(ERROR_INVALID_ARGUMENT));
        GLOBAL_VRR_DRIVER.with(|state| {
            let requests = &state.borrow().requests;
            assert_eq!(requests.len(), 1, "the read path never retries by setting a global/per-app scope");
            assert_eq!(requests[0].0, 0, "the sole request is GET-only");
        });
    }

    #[test]
    fn global_vrr_set_uses_enum_feature_14_and_selects_feature_15_global_value_two() {
        GLOBAL_VRR_DRIVER.with(|state| *state.borrow_mut() = GlobalVrrDriver {
            supported_types: 0b111,
            current_value: 0,
            ..GlobalVrrDriver::default()
        });
        let mut session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.supported_3d = Some(fake_supported_3d_with_scope);
            functions.set_3d = Some(fake_global_vrr_getset);
        }).unwrap();
        session.enumerate_adapters().unwrap();
        let details = session.supported_3d_features(0).unwrap();
        assert_eq!(details.iter().map(|detail| (detail.FeatureType, detail.ValueType)).collect::<Vec<_>>(),
            vec![(14, 4), (15, 4)]);

        session.write_3d_enum(0, 14, 2, "").unwrap();
        session.set_3d_scope(0, false, "").unwrap();
        GLOBAL_VRR_DRIVER.with(|state| {
            let state = state.borrow();
            assert_eq!(state.current_value, 2);
            assert_eq!(state.current_scope, 2);
            assert_eq!(state.requests.len(), 2);
            let (set, feature, value_type, app_len, app_name, value) = &state.requests[0];
            assert_eq!((*set, *feature, *value_type, *app_len, app_name.as_str()), (1, 14, 4, 0, ""));
            assert_eq!(u32::from_le_bytes(value[0..4].try_into().unwrap()), 2);
            let (set, feature, value_type, app_len, app_name, value) = &state.requests[1];
            assert_eq!((*set, *feature, *value_type, *app_len, app_name.as_str()), (1, 15, 4, 0, ""));
            assert_eq!(u32::from_le_bytes(value[0..4].try_into().unwrap()), 2);
        });
    }

    unsafe extern "C" fn fake_arc_sync_monitor(_handle: Handle, raw: *mut c_void) -> u32 {
        let params = unsafe { &mut *raw.cast::<ctl_intel_arc_sync_monitor_params_t>() };
        assert_eq!(params.Size, size_of::<ctl_intel_arc_sync_monitor_params_t>() as u32);
        assert_eq!(params.Version, 0);
        params.IsIntelArcSyncSupported = 1;
        params.MinimumRefreshRateInHz = 48.0;
        params.MaximumRefreshRateInHz = 180.0;
        params.MaxFrameTimeIncreaseInUs = 2_000;
        params.MaxFrameTimeDecreaseInUs = 1_000;
        SUCCESS
    }
    unsafe extern "C" fn fake_arc_sync_profile(_handle: Handle, raw: *mut c_void) -> u32 {
        let params = unsafe { &mut *raw.cast::<ctl_intel_arc_sync_profile_params_t>() };
        assert_eq!(params.Size, size_of::<ctl_intel_arc_sync_profile_params_t>() as u32);
        assert_eq!(params.Version, 0);
        params.IntelArcSyncProfile = 1;
        params.MaxRefreshRateInHz = 180.0;
        params.MinRefreshRateInHz = 90.0;
        params.MaxFrameTimeIncreaseInUs = 2_000;
        params.MaxFrameTimeDecreaseInUs = 1_000;
        SUCCESS
    }
    unsafe extern "C" fn fake_arc_sync_profile_set(_handle: Handle, raw: *mut c_void) -> u32 {
        ARC_SYNC_SET_CALLS.fetch_add(1, Ordering::SeqCst);
        assert_eq!(
            std::mem::size_of::<ArcSyncProfileBuffer>(),
            std::mem::size_of::<ctl_intel_arc_sync_profile_params_t>() + ARC_SYNC_PROFILE_HEADROOM,
        );
        assert_eq!(
            std::mem::align_of::<ArcSyncProfileBuffer>(),
            std::mem::align_of::<ctl_intel_arc_sync_profile_params_t>(),
        );
        let tail = unsafe {
            std::slice::from_raw_parts(
                raw.cast::<u8>().add(std::mem::size_of::<ctl_intel_arc_sync_profile_params_t>()),
                ARC_SYNC_PROFILE_HEADROOM,
            )
        };
        assert!(tail.iter().all(|byte| *byte == 0), "Arc Sync SET headroom must be zero-filled and writable");
        let params = unsafe { &*raw.cast::<ctl_intel_arc_sync_profile_params_t>() };
        assert_eq!(params.Size, size_of::<ctl_intel_arc_sync_profile_params_t>() as u32);
        assert_eq!(params.Version, 0);
        ARC_SYNC_SET_CAPTURE.with(|capture| {
            *capture.borrow_mut() = Some((params.IntelArcSyncProfile, params.MaxRefreshRateInHz,
                params.MinRefreshRateInHz, params.MaxFrameTimeIncreaseInUs, params.MaxFrameTimeDecreaseInUs));
        });
        SUCCESS
    }
    #[test]
    fn fake_driver_reads_owned_adapter_data_and_closes_exactly_once() {
        let mut session = start(State {count: 1, ..State::default()}).unwrap();
        assert!(session.igsc_full_available);
        let info = session.enumerate_adapters().unwrap();
        assert_eq!(info[0].name, "Arc"); assert_eq!(info[0].luid.as_deref(), Some("0102030405060708"));
        assert_eq!(info[0].driver_version, "0x0000000000001234");
        session.close().unwrap(); session.close().unwrap();
        assert!(session.enumerate_adapters().is_err()); drop(session);
        STATE.with(|s| { let s = s.borrow(); assert_eq!(s.flags, [3]); assert_eq!(s.closes, 1); });
    }
    #[test]
    fn fake_arc_sync_gets_use_versioned_headers_and_never_call_the_setter() {
        let _guard = ARC_SYNC_SET_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ARC_SYNC_SET_CALLS.store(0, Ordering::SeqCst);
        ARC_SYNC_SET_CAPTURE.with(|capture| *capture.borrow_mut() = None);
        let session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.arc_sync_monitor = Some(fake_arc_sync_monitor);
            functions.arc_sync_profile_get = Some(fake_arc_sync_profile);
            functions.arc_sync_profile_set = Some(fake_arc_sync_profile_set);
        }).unwrap();

        let monitor = session.display_arc_sync_monitor(2 as Handle).unwrap();
        assert_eq!(monitor.IsIntelArcSyncSupported, 1);
        assert_eq!((monitor.MinimumRefreshRateInHz, monitor.MaximumRefreshRateInHz), (48.0, 180.0));
        assert_eq!((monitor.MaxFrameTimeIncreaseInUs, monitor.MaxFrameTimeDecreaseInUs), (2_000, 1_000));
        let profile = session.display_arc_sync_profile(2 as Handle).unwrap();
        assert_eq!(profile.IntelArcSyncProfile, 1);
        assert_eq!((profile.MinRefreshRateInHz, profile.MaxRefreshRateInHz), (90.0, 180.0));
        assert!(session.display_arc_sync_profile_control_available());
        assert_eq!(ARC_SYNC_SET_CALLS.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn arc_sync_profile_set_uses_output_handle_and_preserves_current_timing_fields() {
        let _guard = ARC_SYNC_SET_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ARC_SYNC_SET_CALLS.store(0, Ordering::SeqCst);
        ARC_SYNC_SET_CAPTURE.with(|capture| *capture.borrow_mut() = None);
        let session = start_with(State { count: 1, ..State::default() }, |functions| {
            functions.arc_sync_profile_get = Some(fake_arc_sync_profile);
            functions.arc_sync_profile_set = Some(fake_arc_sync_profile_set);
        }).unwrap();
        session.display_apply_api().set_arc_sync_profile(2 as Handle, 4, 180.0, 90.0, 2_000, 1_000).unwrap();
        assert_eq!(ARC_SYNC_SET_CALLS.load(Ordering::SeqCst), 1);
        ARC_SYNC_SET_CAPTURE.with(|capture| assert_eq!(
            *capture.borrow(), Some((4, 180.0, 90.0, 2_000, 1_000)),
        ));
    }

    #[test]
    fn arc_sync_profile_get_is_unavailable_after_igsc_fallback() {
        // The setter counter is process-global: serialize against the other Arc
        // Sync tests and start from zero so this proves the fallback path itself
        // performs no Arc Sync SET, regardless of test order.
        let _guard = ARC_SYNC_SET_TEST_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        ARC_SYNC_SET_CALLS.store(0, Ordering::SeqCst);
        let session = start_with(State { init_results: vec![ERROR_IGSC_LOADER, 0], ..State::default() }, |functions| {
            functions.arc_sync_profile_get = Some(fake_arc_sync_profile);
            functions.arc_sync_profile_set = Some(fake_arc_sync_profile_set);
        }).unwrap();
        assert!(!session.display_arc_sync_profile_control_available());
        assert!(session.display_arc_sync_profile(2 as Handle).is_none());
        assert_eq!(ARC_SYNC_SET_CALLS.load(Ordering::SeqCst), 0);
    }
    #[test]
    fn fallback_closes_partial_handle_and_keeps_zero_uid() {
        let session = start(State {init_results: vec![ERROR_IGSC_LOADER, 0], ..State::default()}).unwrap();
        assert!(!session.igsc_full_available); drop(session);
        STATE.with(|s| { let s = s.borrow(); assert_eq!(s.flags, [3,1]); assert_eq!(s.closes, 2); });
    }
    #[test]
    fn failures_do_not_change_uid_retry_other_errors_or_leak_partial_handles() {
        assert!(start(State {init_results: vec![0x4000_0021], ..State::default()}).is_err());
        STATE.with(|s| { let s = s.borrow(); assert_eq!(s.flags, [3]); assert_eq!(s.closes, 1); });
        assert!(start(State {null_api: true, ..State::default()}).is_err());
        STATE.with(|s| assert_eq!(s.borrow().closes, 0));
    }
    #[test]
    fn count_bounds_and_changed_fill_count_are_checked() {
        let mut session = start(State::default()).unwrap(); assert!(session.enumerate_adapters().unwrap().is_empty()); drop(session);
        let mut session = start(State {count: MAX_ENUMERATED_HANDLES + 1, ..State::default()}).unwrap();
        assert!(session.enumerate_adapters().is_err()); drop(session);
        let mut session = start(State {count: 1, fill_count: Some(2), ..State::default()}).unwrap();
        assert!(session.enumerate_adapters().is_err()); drop(session);
        let mut session = start(State {count: 2, fill_count: Some(1), ..State::default()}).unwrap();
        assert_eq!(session.enumerate_adapters().unwrap().len(), 1);
    }
    #[test]
    fn native_read_failure_surfaces_without_success_data() {
        let mut session = start(State {count: 1, props_result: 0x4000_0012, ..State::default()}).unwrap();
        let error = session.enumerate_adapters().unwrap_err(); assert_eq!(error.status, Some(0x4000_0012));
        drop(session);
        let mut session = start(State {enum_result: 0x4000_0003, ..State::default()}).unwrap();
        assert_eq!(session.enumerate_adapters().unwrap_err().operation, "ctlEnumerateDevices(count)");
    }
    #[test]
    fn missing_scalar_symbols_report_unsupported() {
        let mut session = start(State { count: 1, ..State::default() }).unwrap();
        session.enumerate_adapters().unwrap();
        let mut backend = session.scalar_backend(0).unwrap();
        assert_eq!(backend.set_scalar(ScalarControl::PowerLimit, 100.0), ERROR_UNSUPPORTED_FEATURE);
        assert_eq!(backend.get_scalar(ScalarControl::PowerLimit), Err(ERROR_UNSUPPORTED_FEATURE));
    }
    #[test]
    fn failed_close_is_observable_and_drop_does_not_retry_unknown_state() {
        let mut session = start(State {close_result: 0x4000_0003, ..State::default()}).unwrap();
        assert_eq!(session.close().unwrap_err().operation, "ctlClose"); drop(session);
        STATE.with(|s| assert_eq!(s.borrow().closes, 1));
        let mut session = start(State {close_result: STILL_OPEN_BY_ANOTHER_CALLER, ..State::default()}).unwrap();
        session.close().unwrap(); drop(session);
        STATE.with(|s| assert_eq!(s.borrow().closes, 1));
    }
    #[test]
    fn fallback_does_not_continue_when_partial_handle_cleanup_fails() {
        assert!(start(State {init_results: vec![ERROR_IGSC_LOADER, 0], close_result: 0x4000_0003, ..State::default()}).is_err());
        STATE.with(|s| { let s = s.borrow(); assert_eq!(s.flags, [3]); assert_eq!(s.closes, 1); });
    }
    #[test]
    #[cfg(windows)]
    fn loader_rejects_relative_and_device_namespace_paths_before_loading() {
        for path in ["IntelControlLib.dll", r"C:IntelControlLib.dll", r"\\server\share\IntelControlLib.dll", r"\\.\IntelControlLib.dll"] {
            assert!(Library::load(Path::new(path)).is_err());
        }
    }

    #[derive(Default)]
    struct ScalingDriver {
        calls: Vec<u8>, accepted: Vec<u8>, refused: u32,
        set_calls: Vec<(u8, u8, u32, u32, u32, u8, u32)>,
        set_accepted: Vec<u8>, set_refused: u32,
    }
    thread_local! { static SCALING_DRIVER: RefCell<ScalingDriver> = RefCell::new(ScalingDriver::default()); }
    unsafe extern "C" fn fake_current_scaling(_handle: Handle, buffer: *mut c_void) -> u32 {
        let settings = unsafe { &mut *buffer.cast::<ctl_scaling_settings_t>() };
        assert_eq!(settings.Size, std::mem::size_of::<ctl_scaling_settings_t>() as u32);
        assert_eq!(settings.Enable, 0, "a GET never pre-fills the enable flag");
        let tail = unsafe { std::slice::from_raw_parts(
            buffer.cast::<u8>().add(std::mem::size_of::<ctl_scaling_settings_t>()), 16,
        ) };
        assert_eq!(tail, &[0; 16], "scaling GET retains Electron's zeroed display headroom");
        let version = settings.Version;
        SCALING_DRIVER.with(|driver| {
            let mut driver = driver.borrow_mut();
            driver.calls.push(version);
            if driver.accepted.contains(&version) {
                settings.Enable = 1;
                settings.ScalingType = 4;
                settings.CustomScalingX = 100;
                settings.CustomScalingY = 80;
                settings.PreferredScalingType = 2;
                0
            } else { driver.refused }
        })
    }
    unsafe extern "C" fn fake_set_current_scaling(_handle: Handle, buffer: *mut c_void) -> u32 {
        let settings = unsafe { &mut *buffer.cast::<ctl_scaling_settings_t>() };
        assert_eq!(settings.Size, std::mem::size_of::<ctl_scaling_settings_t>() as u32);
        let tail = unsafe { std::slice::from_raw_parts(
            buffer.cast::<u8>().add(std::mem::size_of::<ctl_scaling_settings_t>()), 16,
        ) };
        assert_eq!(tail, &[0; 16], "scaling SET retains Electron's zeroed display headroom");
        let call = (
            settings.Version, settings.Enable, settings.ScalingType,
            settings.CustomScalingX, settings.CustomScalingY,
            settings.HardwareModeSet, settings.PreferredScalingType,
        );
        SCALING_DRIVER.with(|driver| {
            let mut driver = driver.borrow_mut();
            driver.set_calls.push(call);
            if driver.set_accepted.contains(&settings.Version) { 0 } else { driver.set_refused }
        })
    }
    fn start_scaling(driver: ScalingDriver) -> ReadOnlyIgcl {
        SCALING_DRIVER.with(|state| *state.borrow_mut() = driver);
        start_with(State { count: 1, ..State::default() },
            |functions| functions.current_scaling = Some(fake_current_scaling)).unwrap()
    }
    fn start_scaling_writer(driver: ScalingDriver) -> ReadOnlyIgcl {
        SCALING_DRIVER.with(|state| *state.borrow_mut() = driver);
        start_with(State { count: 1, ..State::default() }, |functions| {
            functions.current_scaling = Some(fake_current_scaling);
            functions.set_current_scaling = Some(fake_set_current_scaling);
        }).unwrap()
    }

    #[test]
    fn scaling_get_prefers_version_one_and_reports_which_version_answered() {
        let session = start_scaling(ScalingDriver { accepted: vec![1], refused: ERROR_INVALID_ARGUMENT, ..ScalingDriver::default() });
        let (version, settings) = session.display_scaling(2 as Handle).unwrap();
        assert_eq!(version, 1);
        // The struct was filled by the driver, not by the read helper.
        assert_eq!((settings.Enable, settings.ScalingType, settings.PreferredScalingType), (1, 4, 2));
        SCALING_DRIVER.with(|state| assert_eq!(state.borrow().calls, vec![1]));

        // A version-1 refusal that is a version error retries at 0 and yields
        // the older surface (no PreferredScalingType contract).
        let session = start_scaling(ScalingDriver { accepted: vec![0], refused: ERROR_UNSUPPORTED_VERSION, ..ScalingDriver::default() });
        let (version, settings) = session.display_scaling(2 as Handle).unwrap();
        assert_eq!(version, 0);
        assert_eq!(settings.ScalingType, 4);
        SCALING_DRIVER.with(|state| assert_eq!(state.borrow().calls, vec![1, 0]));
    }

    #[test]
    fn scaling_get_does_not_retry_version_zero_for_other_failures() {
        for refused in [ERROR_UNSUPPORTED_FEATURE, 0x4000_0007] {
            let session = start_scaling(ScalingDriver { accepted: Vec::new(), refused, ..ScalingDriver::default() });
            assert!(session.display_scaling(2 as Handle).is_none());
            SCALING_DRIVER.with(|state| assert_eq!(state.borrow().calls, vec![1], "0x{refused:08x}"));
        }
    }

    #[test]
    fn scaling_set_matches_electron_abi_and_retries_only_supported_version_refusals() {
        let session = start_scaling_writer(ScalingDriver {
            set_accepted: vec![1], set_refused: ERROR_INVALID_ARGUMENT, ..ScalingDriver::default()
        });
        let version = session.display_apply_api().set_scaling(2 as Handle, true, 4, None, false).unwrap();
        assert_eq!(version, 1);
        SCALING_DRIVER.with(|state| assert_eq!(state.borrow().set_calls, vec![(1, 1, 4, 0, 0, 0, 0)]));

        let session = start_scaling_writer(ScalingDriver {
            set_accepted: vec![0], set_refused: ERROR_UNSUPPORTED_VERSION, ..ScalingDriver::default()
        });
        let version = session.display_apply_api().set_scaling(2 as Handle, true, 16, Some((37, 62)), true).unwrap();
        assert_eq!(version, 0);
        SCALING_DRIVER.with(|state| assert_eq!(state.borrow().set_calls, vec![
            (1, 1, 16, 37, 62, 1, 0), (0, 1, 16, 37, 62, 1, 0),
        ]));

        let session = start_scaling_writer(ScalingDriver {
            set_accepted: vec![], set_refused: ERROR_UNSUPPORTED_FEATURE, ..ScalingDriver::default()
        });
        let error = session.display_apply_api().set_scaling(2 as Handle, true, 2, None, false).unwrap_err();
        assert_eq!(error.status, Some(ERROR_UNSUPPORTED_FEATURE));
        SCALING_DRIVER.with(|state| assert_eq!(state.borrow().set_calls.len(), 1));
    }

    #[test]
    fn pixel_capability_query_accepts_sizing_response_and_uses_two_read_only_phases() {
        let session = start_pixel(PixelDriver {
            count_status: ERROR_INVALID_SIZE,
            count: 2,
            blocks: vec![pixel_matrix(41), pixel_lut(9, 0, 256, 3)],
            ..PixelDriver::default()
        }, true);
        let result = session.display_color_capabilities(2 as Handle).unwrap();
        assert_eq!(result.hue_saturation_block_id, Some(41));
        assert_eq!(result.brightness_contrast_block_id, Some(9));
        assert!(result.hue_saturation_supported);
        assert!(result.brightness_contrast_supported);
        assert_eq!(result.hue_saturation_unsupported_reason, None);
        assert_eq!(result.brightness_contrast_unsupported_reason, None);
        assert!(session.display_pixel_transformation_set_available());
        PIXEL_DRIVER.with(|state| assert_eq!(state.borrow().calls, 2));
        assert_eq!(pixel_set_call_count(), 0);
    }

    #[test]
    fn pixel_hue_saturation_set_matches_electron_nested_abi_and_matrix_payload() {
        let session = start_pixel(PixelDriver {
            count: 1, blocks: vec![pixel_matrix(41)], ..PixelDriver::default()
        }, true);
        session.display_apply_api().set_pixel_color_group(2 as Handle, true, 90.0, 1.5).unwrap();
        assert_eq!(pixel_set_call_count(), 1);
        PIXEL_DRIVER.with(|state| assert_eq!(state.borrow().calls, 2));
        PIXEL_SET_CAPTURE.with(|capture| {
            let (block, samples) = capture.borrow().clone().expect("fake setter captured the block");
            assert!(samples.is_empty());
            assert_eq!(read_u32(&block, 8), 41);
            assert_eq!(read_u32(&block, 12), PIXEL_BLOCK_MATRIX_3X3);
            assert_eq!(read_u32(&block, 16), PIXEL_MATRIX_CONFIG_SIZE);
            for index in 0..3 {
                assert_eq!(read_f64(&block, 24 + index * 8), 0.0);
                assert_eq!(read_f64(&block, 48 + index * 8), 0.0);
            }
            let expected = matrix_for_display_color(90.0, 1.5);
            for (index, value) in expected.iter().enumerate() {
                assert!((read_f64(&block, 72 + index * 8) - value).abs() < 1e-12);
            }
        });
    }

    #[test]
    fn neutral_hue_saturation_matrix_is_exactly_identity_like_electron() {
        assert_eq!(
            matrix_for_display_color(0.0, 1.0),
            [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
        );
    }

    #[test]
    fn pixel_brightness_contrast_set_uses_owned_aligned_lut_samples() {
        let session = start_pixel(PixelDriver {
            count: 1, blocks: vec![pixel_lut(9, 0, 4, 3)], ..PixelDriver::default()
        }, true);
        session.display_apply_api().set_pixel_color_group(2 as Handle, false, 100.0, 2.0).unwrap();
        assert_eq!(pixel_set_call_count(), 1);
        PIXEL_SET_CAPTURE.with(|capture| {
            let (block, samples) = capture.borrow().clone().expect("fake setter captured the block");
            assert_eq!(read_u32(&block, 8), 9);
            assert_eq!(read_u32(&block, 12), PIXEL_BLOCK_LUT_1D);
            assert_eq!(read_u32(&block, 16), PIXEL_LUT_CONFIG_SIZE);
            assert_eq!(read_u32(&block, 24), 0);
            assert_eq!(read_u32(&block, 28), 4);
            assert_eq!(read_u32(&block, 32), 3);
            assert_eq!(read_u64(&block, 48), 0);
            let expected = lut_for_display_color(100.0, 2.0, 4);
            assert_eq!(samples.len(), 12);
            for (actual, expected) in samples.iter().zip(expected) { assert!((actual - expected).abs() < 1e-12); }
        });
    }

    #[test]
    fn pixel_color_set_fails_before_writing_without_setter_or_unique_capability() {
        let session = start_pixel(PixelDriver {
            count: 1, blocks: vec![pixel_matrix(41)], ..PixelDriver::default()
        }, false);
        assert!(session.display_apply_api().set_pixel_color_group(2 as Handle, true, 0.0, 1.0).is_err());
        assert_eq!(pixel_set_call_count(), 0);

        let session = start_pixel(PixelDriver {
            count: 2, blocks: vec![pixel_matrix(41), pixel_matrix(42)], ..PixelDriver::default()
        }, true);
        assert!(session.display_apply_api().set_pixel_color_group(2 as Handle, true, 0.0, 1.0).is_err());
        assert_eq!(pixel_set_call_count(), 0);
    }

    #[test]
    fn pixel_capability_query_matches_electron_failures_and_bounds_each_phase() {
        let session = start_with(State::default(), |functions| {
            functions.pixel_transformation_set = Some(fake_pixel_transformation_set);
        }).unwrap();
        assert_eq!(
            session.display_color_capabilities(ptr::null_mut()).unwrap_err(),
            "IGCL ERROR_INVALID_NULL_HANDLE (0x4000000d)",
        );
        assert_eq!(
            session.display_color_capabilities(2 as Handle).unwrap_err(),
            "ctlPixelTransformationGetConfig is not exposed by this IGCL runtime (ERROR_UNSUPPORTED_FEATURE (0x4000000a))",
        );
        assert!(session.display_pixel_transformation_set_available());

        let session = start_pixel(PixelDriver { count_status: ERROR_DATA_READ, count: 2, ..PixelDriver::default() }, false);
        assert_eq!(
            session.display_color_capabilities(2 as Handle).unwrap_err(),
            "Pixel transformation block count query failed: IGCL ERROR_DATA_READ (0x40000012)",
        );
        PIXEL_DRIVER.with(|state| assert_eq!(state.borrow().calls, 1));

        for count in [0, PIXEL_MAX_BLOCKS + 1] {
            let session = start_pixel(PixelDriver { count, count_status: ERROR_INVALID_SIZE, ..PixelDriver::default() }, false);
            assert_eq!(
                session.display_color_capabilities(2 as Handle).unwrap_err(),
                format!("Pixel transformation returned an unsafe block count ({count})"),
            );
            PIXEL_DRIVER.with(|state| assert_eq!(state.borrow().calls, 1));
        }

        let session = start_pixel(PixelDriver {
            count: 1,
            fill_status: ERROR_UNSUPPORTED_FEATURE,
            blocks: vec![pixel_matrix(4)],
            ..PixelDriver::default()
        }, false);
        assert_eq!(
            session.display_color_capabilities(2 as Handle).unwrap_err(),
            "Pixel transformation block query failed: IGCL ERROR_UNSUPPORTED_FEATURE (0x4000000a)",
        );
        PIXEL_DRIVER.with(|state| assert_eq!(state.borrow().calls, 2));

        for returned_count in [0, 2] {
            let session = start_pixel(PixelDriver {
                count: 1,
                returned_count: Some(returned_count),
                blocks: vec![pixel_matrix(4)],
                ..PixelDriver::default()
            }, false);
            assert_eq!(
                session.display_color_capabilities(2 as Handle).unwrap_err(),
                format!("Pixel transformation returned an invalid block count ({returned_count})"),
            );
        }

        let session = start_pixel(PixelDriver {
            count: 1,
            blocks: vec![PixelBlockFixture { size: 128, ..pixel_matrix(4) }],
            ..PixelDriver::default()
        }, false);
        assert_eq!(
            session.display_color_capabilities(2 as Handle).unwrap_err(),
            "Pixel transformation returned an invalid block size for block 0",
        );
    }

    #[test]
    fn absent_colour_exports_bind_nothing_and_never_call_the_driver() {
        let mut session = start(State { count: 1, ..State::default() }).unwrap();
        assert!(!session.display_available());
        assert!(session.display_wire_format(2 as Handle).is_none());
        assert!(session.display_scaling_caps(2 as Handle).is_none());
        assert!(session.display_scaling(2 as Handle).is_none());
        assert!(session.display_retro_scaling_caps(2 as Handle).is_none());
        assert!(session.display_retro_scaling(2 as Handle).is_none());
        assert!(session.display_pixel_transformation(2 as Handle).is_none());
        // The adapter handle itself comes from the mandatory enumeration.
        session.enumerate_adapters().unwrap();
        assert_eq!(session.display_adapter_handle(0), Some(2_usize as Handle));
        assert_eq!(session.display_adapter_handle(4), None);
    }
}
