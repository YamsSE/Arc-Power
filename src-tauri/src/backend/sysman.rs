//! Minimal Level Zero Sysman binding (ze_loader.dll): BDF-matched device
//! selection, sustained/burst limits, and the legacy frequency-domain
//! voltage-target sequence used by Alchemist undervolt.
use super::sysman_power::{PowerLimits, SysmanPower};
use super::sysman_voltage::{SysmanVoltage, VoltageCapabilities, VoltageReading};
use std::ffi::c_void;
use std::path::{Path, PathBuf};
use std::ptr;

type Handle = *mut c_void;
type ZeResult = u32;
type InitFn = unsafe extern "system" fn(u32) -> ZeResult;
type DriverGetFn = unsafe extern "system" fn(*mut u32, *mut Handle) -> ZeResult;
type DeviceGetFn = unsafe extern "system" fn(Handle, *mut u32, *mut Handle) -> ZeResult;
type PciGetFn = unsafe extern "system" fn(Handle, *mut PciProperties) -> ZeResult;
type EnumPowerFn = unsafe extern "system" fn(Handle, *mut u32, *mut Handle) -> ZeResult;
type PowerGetFn = unsafe extern "system" fn(Handle, *mut PowerSustained, *mut PowerBurst, *mut PowerPeak) -> ZeResult;
type PowerSetFn = unsafe extern "system" fn(Handle, *mut PowerSustained, *mut PowerBurst, *mut PowerPeak) -> ZeResult;
type EnumFreqFn = unsafe extern "system" fn(Handle, *mut u32, *mut Handle) -> ZeResult;
type FreqPropsFn = unsafe extern "system" fn(Handle, *mut FrequencyProperties) -> ZeResult;
type FreqStateFn = unsafe extern "system" fn(Handle, *mut FrequencyState) -> ZeResult;
type FreqCapsFn = unsafe extern "system" fn(Handle, *mut FrequencyCaps) -> ZeResult;
type FreqOcGetVoltageFn = unsafe extern "system" fn(Handle, *mut f64, *mut f64) -> ZeResult;
type FreqOcSetVoltageFn = unsafe extern "system" fn(Handle, f64, f64) -> ZeResult;
type FreqOcSetModeFn = unsafe extern "system" fn(Handle, u32) -> ZeResult;
type FreqOcSetFreqFn = unsafe extern "system" fn(Handle, f64) -> ZeResult;
type DeviceWaiverFn = unsafe extern "system" fn(Handle) -> ZeResult;

const SUCCESS: ZeResult = 0;
const ERROR_NOT_AVAILABLE: ZeResult = 0x7800_0009;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PowerSustained { enabled: u8, power: i32, interval: i32 }
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PowerBurst { enabled: u8, power: i32 }
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PowerPeak { power_ac: i32, power_dc: i32 }
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PciAddress { domain: u32, bus: u32, device: u32, function: u32 }
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PciSpeed { gen: i32, width: i32, max_bandwidth: i64 }
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct PciProperties {
    stype: u32, next: *mut c_void, address: PciAddress, max_speed: PciSpeed,
    have_bandwidth_counters: u8, have_packet_counters: u8, have_replay_counters: u8,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FrequencyProperties {
    stype: u32, next: *mut c_void, r#type: u32, on_subdevice: u8, subdevice_id: u32,
    can_control: u8, is_throttle_event_supported: u8, min: f64, max: f64,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FrequencyCaps {
    stype: u32, next: *mut c_void, is_oc_supported: u8,
    max_factory_default_frequency: f64, max_factory_default_voltage: f64,
    max_oc_frequency: f64, min_oc_voltage_offset: f64, max_oc_voltage_offset: f64,
    max_oc_voltage: f64, is_tj_max_supported: u8, is_icc_max_supported: u8,
    is_high_volt_mode_capable: u8, is_high_volt_mode_enabled: u8,
    is_extended_mode_supported: u8, is_fixed_mode_supported: u8,
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct FrequencyState {
    stype: u32, next: *mut c_void, current_voltage: f64, request: f64,
    tdp: f64, efficient: f64, actual: f64, throttle_reasons: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bdf { pub domain: u32, pub bus: u32, pub device: u32, pub function: u32 }

struct Library(usize);
impl Library {
    fn load(path: &Path) -> Result<Self, String> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        let handle = unsafe { LoadLibraryW(wide.as_ptr()) };
        if handle.is_null() { return Err(format!("could not load {}", path.display())); }
        Ok(Self(handle as usize))
    }
    unsafe fn symbol<T: Copy>(&self, name: &str) -> Option<T> {
        use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
        let address = unsafe { GetProcAddress(self.0 as _, format!("{name}\0").as_ptr()) }?;
        Some(unsafe { std::mem::transmute_copy::<usize, T>(&(address as usize)) })
    }
}
impl Drop for Library {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::FreeLibrary(self.0 as _); } }
}

struct Functions {
    init: InitFn, driver_get: DriverGetFn, device_get: DeviceGetFn,
    pci_get: PciGetFn, enum_power: EnumPowerFn, power_get: PowerGetFn, power_set: PowerSetFn,
    enum_freq: Option<EnumFreqFn>, freq_props: Option<FreqPropsFn>, freq_state: Option<FreqStateFn>,
    freq_caps: Option<FreqCapsFn>, oc_get_voltage: Option<FreqOcGetVoltageFn>,
    oc_set_voltage: Option<FreqOcSetVoltageFn>, oc_set_mode: Option<FreqOcSetModeFn>,
    oc_set_freq: Option<FreqOcSetFreqFn>, device_waiver: Option<DeviceWaiverFn>,
}
struct Device {
    handle: Handle,
    bdf: Option<Bdf>,
    power: Option<Handle>,
    freq: Option<Handle>,
    freq_max: f64,
}

pub struct SysmanSession {
    _library: Library,
    functions: Functions,
    devices: Vec<Device>,
}

fn unique_device_index(devices: &[Device], bdf: Bdf) -> Option<usize> {
    let mut matches = devices.iter().enumerate().filter(|(_, device)| device.bdf == Some(bdf));
    let (index, _) = matches.next()?;
    if matches.next().is_some() { return None; }
    Some(index)
}

impl SysmanSession {
    pub fn load() -> Result<Self, String> {
        let path = locate_loader().ok_or("ze_loader.dll was not found")?;
        Self::load_from(&path)
    }
    pub fn load_from(path: &Path) -> Result<Self, String> {
        let library = Library::load(path)?;
        let functions = unsafe { Functions {
            init: library.symbol("zesInit").ok_or("missing zesInit")?,
            driver_get: library.symbol("zesDriverGet").ok_or("missing zesDriverGet")?,
            device_get: library.symbol("zesDeviceGet").ok_or("missing zesDeviceGet")?,
            pci_get: library.symbol("zesDevicePciGetProperties").ok_or("missing zesDevicePciGetProperties")?,
            enum_power: library.symbol("zesDeviceEnumPowerDomains").ok_or("missing zesDeviceEnumPowerDomains")?,
            power_get: library.symbol("zesPowerGetLimits").ok_or("missing zesPowerGetLimits")?,
            power_set: library.symbol("zesPowerSetLimits").ok_or("missing zesPowerSetLimits")?,
            enum_freq: library.symbol("zesDeviceEnumFrequencyDomains"),
            freq_props: library.symbol("zesFrequencyGetProperties"),
            freq_state: library.symbol("zesFrequencyGetState"),
            freq_caps: library.symbol("zesFrequencyOcGetCapabilities"),
            oc_get_voltage: library.symbol("zesFrequencyOcGetVoltageTarget"),
            oc_set_voltage: library.symbol("zesFrequencyOcSetVoltageTarget"),
            oc_set_mode: library.symbol("zesFrequencyOcSetMode"),
            oc_set_freq: library.symbol("zesFrequencyOcSetFrequencyTarget"),
            device_waiver: library.symbol("zesDeviceSetOverclockWaiver"),
        } };
        if unsafe { (functions.init)(0) } != SUCCESS { return Err("zesInit failed".into()); }
        let mut driver_count = 0u32;
        if unsafe { (functions.driver_get)(&mut driver_count, ptr::null_mut()) } != SUCCESS || driver_count == 0 {
            return Err("no Level Zero Sysman drivers".into());
        }
        let mut drivers = vec![ptr::null_mut(); driver_count as usize];
        if unsafe { (functions.driver_get)(&mut driver_count, drivers.as_mut_ptr()) } != SUCCESS {
            return Err("zesDriverGet failed".into());
        }
        let mut devices = Vec::new();
        for driver in drivers.into_iter().take(driver_count as usize) {
            let mut count = 0u32;
            if unsafe { (functions.device_get)(driver, &mut count, ptr::null_mut()) } != SUCCESS || count == 0 { continue; }
            let mut handles = vec![ptr::null_mut(); count as usize];
            if unsafe { (functions.device_get)(driver, &mut count, handles.as_mut_ptr()) } != SUCCESS { continue; }
            for handle in handles.into_iter().take(count as usize) {
                if handle.is_null() { continue; }
                let mut properties = PciProperties::default();
                properties.stype = 2; // ZES_STRUCTURE_TYPE_PCI_PROPERTIES
                let bdf = if unsafe { (functions.pci_get)(handle, &mut properties) } == SUCCESS {
                    Some(Bdf { domain: properties.address.domain, bus: properties.address.bus,
                        device: properties.address.device, function: properties.address.function })
                } else { None };
                let power = usable_power_domain(&functions, handle);
                let (freq, freq_max) = gpu_frequency_domain(&functions, handle);
                if power.is_some() || freq.is_some() {
                    devices.push(Device { handle, bdf, power, freq, freq_max });
                }
            }
        }
        if devices.is_empty() { return Err("no usable Sysman power or frequency domain".into()); }
        Ok(Self { _library: library, functions, devices })
    }

    pub fn device(&mut self, bdf: Bdf) -> Option<SysmanDevice<'_>> {
        let index = unique_device_index(&self.devices, bdf)?;
        Some(SysmanDevice { session: self, index })
    }
}

fn usable_power_domain(functions: &Functions, handle: Handle) -> Option<Handle> {
    let mut power_count = 0u32;
    if unsafe { (functions.enum_power)(handle, &mut power_count, ptr::null_mut()) } != SUCCESS || power_count == 0 {
        return None;
    }
    let mut handles = vec![ptr::null_mut(); power_count as usize];
    if unsafe { (functions.enum_power)(handle, &mut power_count, handles.as_mut_ptr()) } != SUCCESS {
        return None;
    }
    for candidate in handles.into_iter().take(power_count as usize) {
        let (mut s, mut b, mut p) = (PowerSustained::default(), PowerBurst::default(), PowerPeak::default());
        if unsafe { (functions.power_get)(candidate, &mut s, &mut b, &mut p) } == SUCCESS {
            return Some(candidate);
        }
    }
    None
}

fn gpu_frequency_domain(functions: &Functions, handle: Handle) -> (Option<Handle>, f64) {
    let (Some(enum_freq), Some(freq_props)) = (functions.enum_freq, functions.freq_props) else {
        return (None, 0.0);
    };
    let mut count = 0u32;
    if unsafe { enum_freq(handle, &mut count, ptr::null_mut()) } != SUCCESS || count == 0 {
        return (None, 0.0);
    }
    let mut handles = vec![ptr::null_mut(); count as usize];
    if unsafe { enum_freq(handle, &mut count, handles.as_mut_ptr()) } != SUCCESS {
        return (None, 0.0);
    }
    for candidate in handles.into_iter().take(count as usize) {
        let mut properties = FrequencyProperties::default();
        properties.stype = 9; // ZES_STRUCTURE_TYPE_FREQUENCY_PROPERTIES
        if unsafe { freq_props(candidate, &mut properties) } != SUCCESS { continue; }
        // Type 0 is the GPU render/compute domain used by Alchemist.
        if properties.r#type == 0 {
            let max = if properties.max.is_finite() && properties.max > 0.0 { properties.max } else { 0.0 };
            return (Some(candidate), max);
        }
    }
    (None, 0.0)
}

pub struct SysmanDevice<'a> { session: &'a mut SysmanSession, index: usize }

impl SysmanDevice<'_> {
    fn read_frequency_state(&self) -> Option<FrequencyState> {
        let device = &self.session.devices[self.index];
        let function = self.session.functions.freq_state?;
        let mut state = FrequencyState::default();
        state.stype = 0x1b; // ZES_STRUCTURE_TYPE_FREQUENCY_STATE
        (unsafe { function(device.freq?, &mut state) } == SUCCESS).then_some(state)
    }
    fn live_frequency_mhz(&self) -> Option<f64> {
        let state = self.read_frequency_state()?;
        [state.tdp, state.actual, state.request, state.efficient]
            .into_iter().find(|value| value.is_finite() && *value > 0.0)
    }
}

impl SysmanPower for SysmanDevice<'_> {
    fn read_limits(&mut self) -> Result<PowerLimits, u32> {
        let device = &self.session.devices[self.index];
        let power = device.power.ok_or(ERROR_NOT_AVAILABLE)?;
        let (mut sustained, mut burst, mut peak) = (PowerSustained::default(), PowerBurst::default(), PowerPeak::default());
        let status = unsafe { (self.session.functions.power_get)(power, &mut sustained, &mut burst, &mut peak) };
        if status != SUCCESS { return Err(status); }
        Ok(PowerLimits {
            sustained_enabled: sustained.enabled,
            sustained_w: f64::from(sustained.power) / 1000.0,
            burst_enabled: burst.enabled,
            burst_w: f64::from(burst.power) / 1000.0,
            peak_w: f64::from(peak.power_ac) / 1000.0,
            interval_ms: sustained.interval,
        })
    }
    fn set_limits(&mut self, sustained_w: f64, burst_w: f64, interval_ms: i32) -> u32 {
        let device = &self.session.devices[self.index];
        let Some(power) = device.power else { return ERROR_NOT_AVAILABLE; };
        let mut sustained = PowerSustained { enabled: 1, power: (sustained_w * 1000.0).round() as i32, interval: interval_ms };
        let mut burst = PowerBurst { enabled: 1, power: (burst_w * 1000.0).round() as i32 };
        unsafe { (self.session.functions.power_set)(power, &mut sustained, &mut burst, ptr::null_mut()) }
    }
}

impl SysmanVoltage for SysmanDevice<'_> {
    fn read_voltage(&mut self) -> Result<VoltageReading, u32> {
        let device = &self.session.devices[self.index];
        let freq = device.freq.ok_or(ERROR_NOT_AVAILABLE)?;
        let function = self.session.functions.oc_get_voltage.ok_or(ERROR_NOT_AVAILABLE)?;
        let (mut target, mut offset) = (0.0_f64, 0.0_f64);
        let status = unsafe { function(freq, &mut target, &mut offset) };
        if status != SUCCESS { return Err(status); }
        let state = self.read_frequency_state();
        Ok(VoltageReading {
            target_native: target,
            offset_native: offset,
            frequency_target_mhz: self.live_frequency_mhz().filter(|value| *value > 0.0),
            state_voltage_native: state.map(|state| state.current_voltage),
        })
    }
    fn max_frequency_mhz(&self) -> f64 { self.session.devices[self.index].freq_max }
    fn read_capabilities(&mut self) -> Option<VoltageCapabilities> {
        let device = &self.session.devices[self.index];
        let function = self.session.functions.freq_caps?;
        let mut caps = FrequencyCaps::default();
        caps.stype = 0x1c; // ZES_STRUCTURE_TYPE_FREQUENCY_OC_CAPABILITIES
        (unsafe { function(device.freq?, &mut caps) } == SUCCESS).then_some(VoltageCapabilities {
            max_factory_default_voltage: caps.max_factory_default_voltage,
            min_oc_voltage_offset: caps.min_oc_voltage_offset,
            max_oc_voltage_offset: caps.max_oc_voltage_offset,
            max_oc_voltage: caps.max_oc_voltage,
        })
    }
    fn set_mode(&mut self, mode: u32) -> u32 {
        let device = &self.session.devices[self.index];
        let Some(freq) = device.freq else { return ERROR_NOT_AVAILABLE; };
        match self.session.functions.oc_set_mode {
            Some(function) => unsafe { function(freq, mode) },
            None => ERROR_NOT_AVAILABLE,
        }
    }
    fn set_frequency_target(&mut self, mhz: f64) -> u32 {
        let device = &self.session.devices[self.index];
        let Some(freq) = device.freq else { return ERROR_NOT_AVAILABLE; };
        match self.session.functions.oc_set_freq {
            Some(function) => unsafe { function(freq, mhz) },
            None => ERROR_NOT_AVAILABLE,
        }
    }
    fn set_voltage_target(&mut self, target_native: f64, offset_native: f64) -> u32 {
        let device = &self.session.devices[self.index];
        let Some(freq) = device.freq else { return ERROR_NOT_AVAILABLE; };
        match self.session.functions.oc_set_voltage {
            Some(function) => unsafe { function(freq, target_native, offset_native) },
            None => ERROR_NOT_AVAILABLE,
        }
    }
    fn apply_waiver(&mut self) -> Option<u32> {
        let device = &self.session.devices[self.index];
        self.session.functions.device_waiver.map(|function| unsafe { function(device.handle) })
    }
}

pub fn locate_loader() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("LZ_LOADER_PATH") { candidates.push(PathBuf::from(path)); }
    candidates.push(PathBuf::from(r"C:\Windows\System32\ze_loader.dll"));
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn device(bdf: Option<Bdf>) -> Device {
        Device { handle: std::ptr::null_mut(), bdf, power: None, freq: None, freq_max: 0.0 }
    }

    #[test]
    fn sysman_bdf_resolution_rejects_duplicate_physical_matches() {
        let target = Bdf { domain: 0, bus: 3, device: 0, function: 0 };
        assert_eq!(unique_device_index(&[device(Some(target))], target), Some(0));
        assert_eq!(unique_device_index(&[device(Some(target)), device(Some(target))], target), None);
        assert_eq!(unique_device_index(&[device(Some(Bdf { bus: 4, ..target }))], target), None);
    }

    #[test]
    fn layouts_match_the_level_zero_msvc_x64_contract() {
        assert_eq!(std::mem::size_of::<PowerSustained>(), 12);
        assert_eq!(std::mem::size_of::<PowerBurst>(), 8);
        assert_eq!(std::mem::size_of::<PowerPeak>(), 8);
        assert_eq!(std::mem::size_of::<PciProperties>(), 56);
        assert_eq!(std::mem::size_of::<FrequencyProperties>(), 48);
        assert_eq!(std::mem::size_of::<FrequencyCaps>(), 80);
        assert_eq!(std::mem::size_of::<FrequencyState>(), 64);
    }
}
