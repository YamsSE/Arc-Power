//! Native non-Intel vendor telemetry: NVIDIA NVML and AMD ADL. Ports
//! src/main/vendor-telemetry/{nvml,adl}.js. Every provider call is optional;
//! an absent DLL, symbol or failed read omits only that field.
use serde_json::{json, Map, Value};
use std::ffi::c_void;
use std::ptr;

struct Module(usize);
impl Module {
    fn load(name: &str) -> Option<Self> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::LibraryLoader::LoadLibraryW;
        let wide: Vec<u16> = std::ffi::OsStr::new(name).encode_wide().chain(std::iter::once(0)).collect();
        let handle = unsafe { LoadLibraryW(wide.as_ptr()) };
        (!handle.is_null()).then_some(Self(handle as usize))
    }
    unsafe fn symbol<T: Copy>(&self, name: &str) -> Option<T> {
        use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
        let address = unsafe { GetProcAddress(self.0 as _, format!("{name}\0").as_ptr()) }?;
        Some(unsafe { std::mem::transmute_copy::<usize, T>(&(address as usize)) })
    }
}
impl Drop for Module {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::FreeLibrary(self.0 as _); } }
}

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct NvmlUtilization { gpu: u32, memory: u32 }
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct NvmlMemory { total: u64, free: u64, used: u64 }
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct NvmlFieldValue { field_id: u32, unused: u32, value: i64, return_status: i32, _padding: i32, data: u64 }

type NvmlInit = unsafe extern "system" fn() -> i32;
type NvmlShutdown = unsafe extern "system" fn() -> i32;
type NvmlHandleByIndex = unsafe extern "system" fn(u32, *mut *mut c_void) -> i32;
type NvmlClock = unsafe extern "system" fn(*mut c_void, u32, *mut u32) -> i32;
type NvmlTemperature = unsafe extern "system" fn(*mut c_void, u32, *mut u32) -> i32;
type NvmlUtilizationFn = unsafe extern "system" fn(*mut c_void, *mut NvmlUtilization) -> i32;
type NvmlMemoryFn = unsafe extern "system" fn(*mut c_void, *mut NvmlMemory) -> i32;
type NvmlU32Fn = unsafe extern "system" fn(*mut c_void, *mut u32) -> i32;
type NvmlFieldValues = unsafe extern "system" fn(*mut c_void, i32, *mut NvmlFieldValue) -> i32;
type NvmlCount = unsafe extern "system" fn(*mut u32) -> i32;
type NvmlPciInfo = unsafe extern "system" fn(*mut c_void, *mut u8) -> i32;

struct NvmlFunctions {
    init: NvmlInit, shutdown: NvmlShutdown, handle_by_index: NvmlHandleByIndex,
    clock: Option<NvmlClock>, temperature: Option<NvmlTemperature>,
    utilization: Option<NvmlUtilizationFn>, memory: Option<NvmlMemoryFn>,
    power: Option<NvmlU32Fn>, fan: Option<NvmlU32Fn>, cores: Option<NvmlU32Fn>,
    field_values: Option<NvmlFieldValues>, count: Option<NvmlCount>, pci_info: Option<NvmlPciInfo>,
}
struct Nvml { _module: Module, functions: NvmlFunctions, handle: *mut c_void, initialized: bool }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VendorBdf { pub bus: u32, pub device: u32, pub function: u32 }

fn target_bdf(target: Option<&Value>) -> Option<VendorBdf> {
    let value = target?.get("bdf")?;
    if let Some(object) = value.as_object() {
        return Some(VendorBdf {
            bus: object.get("bus")?.as_u64()? as u32,
            device: object.get("device")?.as_u64()? as u32,
            function: object.get("function").and_then(Value::as_u64).unwrap_or(0) as u32,
        });
    }
    let text = value.as_str()?.trim();
    parse_bdf_text(text)
}

impl Nvml {
    fn new_with(bdf: Option<VendorBdf>, allow_single: bool) -> Option<Self> {
        let module = Module::load("nvml.dll")?;
        let functions = unsafe { NvmlFunctions {
            init: module.symbol("nvmlInit_v2")?, shutdown: module.symbol("nvmlShutdown")?,
            handle_by_index: module.symbol("nvmlDeviceGetHandleByIndex_v2")?,
            clock: module.symbol("nvmlDeviceGetClockInfo"),
            temperature: module.symbol("nvmlDeviceGetTemperature"),
            utilization: module.symbol("nvmlDeviceGetUtilizationRates"),
            memory: module.symbol("nvmlDeviceGetMemoryInfo"),
            power: module.symbol("nvmlDeviceGetPowerUsage"),
            fan: module.symbol("nvmlDeviceGetFanSpeed"),
            cores: module.symbol("nvmlDeviceGetNumGpuCores"),
            field_values: module.symbol("nvmlDeviceGetFieldValues"),
            count: module.symbol("nvmlDeviceGetCount_v2"),
            pci_info: module.symbol("nvmlDeviceGetPciInfo_v3").or_else(|| module.symbol("nvmlDeviceGetPciInfo_v2")),
        } };
        if unsafe { (functions.init)() } != 0 { return None; }
        let count = functions.count.map(|count| {
            let mut value = 0u32;
            if unsafe { count(&mut value) } == 0 { value } else { 1 }
        }).unwrap_or(1);
        let mut selected = None;
        if let Some(wanted) = bdf {
            for index in 0..count {
                let Some(handle) = nvml_handle(&functions, index) else { continue; };
                if nvml_bdf(&functions, handle) == Some(wanted) { selected = Some(handle); break; }
            }
        }
        let handle = selected.or_else(|| allow_single.then(|| nvml_handle(&functions, 0)).flatten());
        let Some(handle) = handle else {
            unsafe { (functions.shutdown)(); }
            return None;
        };
        Some(Self { _module: module, functions, handle, initialized: true })
    }
    fn u32_arg(&self, function: Option<NvmlClock>, arg: u32) -> Option<u32> {
        let function = function?;
        let mut value = 0u32;
        (unsafe { function(self.handle, arg, &mut value) } == 0).then_some(value)
    }
    fn u32_no_arg(&self, function: Option<NvmlU32Fn>) -> Option<u32> {
        let function = function?;
        let mut value = 0u32;
        (unsafe { function(self.handle, &mut value) } == 0).then_some(value)
    }
    fn sample(&self) -> Map<String, Value> {
        let mut out = Map::new();
        if let Some(value) = self.u32_arg(self.functions.clock, 1) { out.insert("gpuClockMhz".into(), json!(value)); }
        if let Some(value) = self.u32_arg(self.functions.clock, 2) { out.insert("memClockMhz".into(), json!(value)); }
        if let Some(value) = self.u32_arg(self.functions.temperature, 0) { out.insert("tempC".into(), json!(value)); }
        if let Some(function) = self.functions.utilization {
            let mut utilization = NvmlUtilization::default();
            if unsafe { function(self.handle, &mut utilization) } == 0 { out.insert("utilPct".into(), json!(utilization.gpu)); }
        }
        if let Some(function) = self.functions.memory {
            let mut memory = NvmlMemory::default();
            if unsafe { function(self.handle, &mut memory) } == 0 { out.insert("gpuMemUsedBytes".into(), json!(memory.used)); }
        }
        if let Some(value) = self.u32_no_arg(self.functions.power) { out.insert("powerW".into(), json!(f64::from(value) / 1000.0)); }
        if let Some(value) = self.u32_no_arg(self.functions.fan) { out.insert("fanRpm".into(), json!([value])); }
        if let Some(value) = self.u32_no_arg(self.functions.cores) { out.insert("numCores".into(), json!(value)); }
        if let Some(function) = self.functions.field_values {
            let mut field = NvmlFieldValue { field_id: 82, ..NvmlFieldValue::default() };
            if unsafe { function(self.handle, 1, &mut field) } == 0 && field.return_status == 0 {
                let value = field.data as u32;
                out.insert("vramTempC".into(), json!(value));
            }
        }
        out
    }
    fn close(&mut self) {
        if self.initialized { unsafe { (self.functions.shutdown)(); } self.initialized = false; }
    }
    fn device_info(&self) -> VendorDeviceInfo {
        let mut vram_bytes = None;
        if let Some(function) = self.functions.memory {
            let mut memory = NvmlMemory::default();
            if unsafe { function(self.handle, &mut memory) } == 0 && memory.total > 0 { vram_bytes = Some(memory.total); }
        }
        VendorDeviceInfo { vram_bytes, compute_cores: self.u32_no_arg(self.functions.cores) }
    }
}
fn nvml_handle(functions: &NvmlFunctions, index: u32) -> Option<*mut c_void> {
    let mut handle = ptr::null_mut();
    (unsafe { (functions.handle_by_index)(index, &mut handle) } == 0 && !handle.is_null()).then_some(handle)
}

fn parse_bdf_text(text: &str) -> Option<VendorBdf> {
    let text = text.trim();
    let parts: Vec<&str> = text.split(':').collect();
    let (bus, rest) = match parts.as_slice() {
        [bus, rest] => (*bus, *rest),
        [_domain, bus, rest] => (*bus, *rest),
        _ => return None,
    };
    let (device, function) = rest.split_once('.')?;
    Some(VendorBdf {
        bus: u32::from_str_radix(bus, 16).ok()?,
        device: u32::from_str_radix(device, 16).ok()?,
        function: function.parse().ok()?,
    })
}

fn nvml_bdf(functions: &NvmlFunctions, handle: *mut c_void) -> Option<VendorBdf> {
    let pci_info = functions.pci_info?;
    let mut buffer = [0u8; 64];
    if unsafe { pci_info(handle, buffer.as_mut_ptr()) } != 0 { return None; }
    let end = buffer[..32].iter().position(|byte| *byte == 0).unwrap_or(32);
    if let Some(bdf) = parse_bdf_text(&String::from_utf8_lossy(&buffer[..end])) { return Some(bdf); }
    let read = |offset: usize| u32::from_le_bytes(buffer[offset..offset + 4].try_into().unwrap());
    Some(VendorBdf { bus: read(36), device: read(40), function: read(44) })
}

impl Drop for Nvml { fn drop(&mut self) { self.close(); } }

#[repr(C)]
#[derive(Default, Clone, Copy)]
struct AdlActivity {
    engine_clock: i32, memory_clock: i32, vddc: i32, gpu_util_percent: i32,
    current_activity_percent: i32, current_performance_level: i32, current_bus_speed: i32,
    current_bus_lanes_per_link: i32, current_bus_lanes_in_use: i32, temperature: i32, power_draw: i32,
}
type AdlCreate = unsafe extern "system" fn(*mut c_void, i32) -> i32;
type AdlNoArg = unsafe extern "system" fn() -> i32;
type AdlCount = unsafe extern "system" fn(*mut i32) -> i32;
type AdlActive = unsafe extern "system" fn(i32, *mut i32) -> i32;
type AdlActivityFn = unsafe extern "system" fn(i32, *mut AdlActivity) -> i32;
type AdlFan = unsafe extern "system" fn(i32, *mut i32, *mut i32) -> i32;
type AdlAdapterInfoFn = unsafe extern "system" fn(*mut u8, i32) -> i32;

struct AdlFunctions {
    destroy: Option<AdlNoArg>, active: Option<AdlActive>,
    activity: Option<AdlActivityFn>, fan: Option<AdlFan>,
    adapter_info: Option<AdlAdapterInfoFn>,
}
struct Adl { _module: Module, functions: AdlFunctions, adapter: i32, initialized: bool }
impl Adl {
    fn new_with(bdf: Option<VendorBdf>, allow_single: bool) -> Option<Self> {
        let module = Module::load("atiadlxx.dll")?;
        let functions = unsafe { AdlFunctions {
            destroy: module.symbol("ADL_Main_Control_Destroy"),
            active: module.symbol("ADL_Adapter_Active_Get"),
            activity: module.symbol("ADL_Overdrive5_CurrentActivity_Get"),
            fan: module.symbol("ADL_Overdrive5_FanSpeed_Get"),
            adapter_info: module.symbol("ADL_Adapter_AdapterInfo_Get"),
        } };
        let create: AdlCreate = unsafe { module.symbol("ADL_Main_Control_Create")? };
        let count: AdlCount = unsafe { module.symbol("ADL_Adapter_NumberOfAdapters_Get")? };
        if unsafe { create(ptr::null_mut(), 1) } != 0 { return None; }
        let mut adapter_count = 0i32;
        if unsafe { count(&mut adapter_count) } != 0 || adapter_count <= 0 {
            if let Some(destroy) = functions.destroy { unsafe { destroy(); } }
            return None;
        }
        let mut adapter = None;
        if let Some(wanted) = bdf {
            if let (Some(adapter_info), true) = (functions.adapter_info, adapter_count > 0) {
                let stride = 1572usize;
                let mut buffer = vec![0u8; stride * adapter_count as usize];
                if unsafe { adapter_info(buffer.as_mut_ptr(), buffer.len() as i32) } == 0 {
                    for index in 0..adapter_count as usize {
                        if adl_bdf(&buffer, index, stride) == Some(wanted) { adapter = Some(index as i32); break; }
                    }
                }
            }
        }
        if adapter.is_none() && allow_single {
            let mut index = 0i32;
            let mut found = false;
            if let Some(active) = functions.active {
                for candidate in 0..adapter_count {
                    let mut value = 0i32;
                    if unsafe { active(candidate, &mut value) } == 0 && value != 0 { index = candidate; found = true; break; }
                }
            }
            if !found { index = 0; }
            adapter = Some(index);
        }
        let Some(adapter) = adapter else {
            if let Some(destroy) = functions.destroy { unsafe { destroy(); } }
            return None;
        };
        Some(Self { _module: module, functions, adapter, initialized: true })
    }
    fn sample(&self) -> Map<String, Value> {
        let mut out = Map::new();
        if let Some(function) = self.functions.activity {
            let mut activity = AdlActivity::default();
            if unsafe { function(self.adapter, &mut activity) } == 0 {
                if activity.engine_clock > 0 { out.insert("gpuClockMhz".into(), json!(activity.engine_clock)); }
                if activity.memory_clock > 0 { out.insert("memClockMhz".into(), json!(activity.memory_clock)); }
                if (0..=100).contains(&activity.gpu_util_percent) { out.insert("utilPct".into(), json!(activity.gpu_util_percent)); }
                if activity.temperature > 0 { out.insert("tempC".into(), json!(activity.temperature)); }
                if activity.power_draw > 0 { out.insert("powerW".into(), json!(f64::from(activity.power_draw) / 1000.0)); }
            }
        }
        if let Some(function) = self.functions.fan {
            let (mut percent, mut rpm) = (0i32, 0i32);
            if unsafe { function(self.adapter, &mut percent, &mut rpm) } == 0 && rpm > 0 {
                out.insert("fanRpm".into(), json!([rpm]));
            }
        }
        out
    }
    fn close(&mut self) {
        if self.initialized {
            if let Some(destroy) = self.functions.destroy { unsafe { destroy(); } }
            self.initialized = false;
        }
    }
    fn device_info(&self) -> VendorDeviceInfo { VendorDeviceInfo::default() }
}
fn adl_bdf(buffer: &[u8], index: usize, stride: usize) -> Option<VendorBdf> {
    let base = index.checked_mul(stride)?;
    if base + 276 > buffer.len() { return None; }
    let read = |offset: usize| i32::from_le_bytes(buffer[base + offset..base + offset + 4].try_into().unwrap());
    let size = read(0);
    let (bus, device, function) = (read(264), read(268), read(272));
    if size <= 0 || !(0..=0xff).contains(&bus) || !(0..=0xff).contains(&device)
        || !(0..=7).contains(&function) || (bus == 0 && device == 0) { return None; }
    Some(VendorBdf { bus: bus as u32, device: device as u32, function: function as u32 })
}

impl Drop for Adl { fn drop(&mut self) { self.close(); } }

pub struct VendorTelemetry { inner: Inner }
enum Inner { Nvml(Nvml), Adl(Adl) }

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct VendorDeviceInfo { pub vram_bytes: Option<u64>, pub compute_cores: Option<u32> }

impl VendorTelemetry {
    /// `hint` is "nvidia", "amd", or None for auto-detection.
    pub fn start(hint: Option<&str>) -> Option<Self> { Self::start_for_target(None, hint) }

    /// Select the provider instance that matches the target's BDF. With one
    /// adapter for the vendor, index 0 is safe; with several, an unmatched
    /// target is an honest null rather than a wrong-device sample.
    pub fn start_for_target(target: Option<&Value>, hint: Option<&str>) -> Option<Self> {
        let explicit_vendor = vendor_hint_for_target(target);
        if target.is_some() && explicit_vendor.is_none() { return None; }
        let hint = hint.or(explicit_vendor);
        let bdf = target_bdf(target);
        let allow_single = target.and_then(|target| target.get("vendorCount"))
            .and_then(Value::as_u64).unwrap_or(1) <= 1;
        match hint {
            Some("nvidia") => Nvml::new_with(bdf, allow_single).map(|nvml| Self { inner: Inner::Nvml(nvml) }),
            Some("amd") => Adl::new_with(bdf, allow_single).map(|adl| Self { inner: Inner::Adl(adl) }),
            _ => Nvml::new_with(bdf, allow_single).map(|nvml| Self { inner: Inner::Nvml(nvml) })
                .or_else(|| Adl::new_with(bdf, allow_single).map(|adl| Self { inner: Inner::Adl(adl) })),
        }
    }
    pub fn sample(&self) -> Map<String, Value> {
        match &self.inner { Inner::Nvml(nvml) => nvml.sample(), Inner::Adl(adl) => adl.sample() }
    }
    pub fn device_info(&self) -> VendorDeviceInfo {
        match &self.inner { Inner::Nvml(nvml) => nvml.device_info(), Inner::Adl(adl) => adl.device_info() }
    }
}
unsafe impl Send for VendorTelemetry {}

pub fn vendor_hint_for_target(target: Option<&Value>) -> Option<&'static str> {
    let vendor = target?.get("pciVendorId")?.as_str()?;
    let vendor = u32::from_str_radix(vendor.trim_start_matches("0x"), 16).ok()?;
    match vendor { 0x10de => Some("nvidia"), 0x1002 => Some("amd"), _ => None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts_match_the_vendor_sdk_x64_contract() {
        assert_eq!(std::mem::size_of::<NvmlUtilization>(), 8);
        assert_eq!(std::mem::size_of::<NvmlMemory>(), 24);
        assert_eq!(std::mem::size_of::<NvmlFieldValue>(), 32);
        assert_eq!(std::mem::size_of::<AdlActivity>(), 44);
    }

    #[test]
    fn vendor_hints_are_limited_to_non_intel_ids() {
        assert_eq!(vendor_hint_for_target(Some(&json!({"pciVendorId":"0x000010de"}))), Some("nvidia"));
        assert_eq!(vendor_hint_for_target(Some(&json!({"pciVendorId":"0x00001002"}))), Some("amd"));
        assert_eq!(vendor_hint_for_target(Some(&json!({"pciVendorId":"0x00008086"}))), None);
        assert_eq!(vendor_hint_for_target(None), None);
    }

    #[test]
    fn target_and_provider_bdf_parsing_selects_the_requested_adapter() {
        let object = json!({"bdf":{"bus":1,"device":2,"function":3}});
        assert_eq!(target_bdf(Some(&object)), Some(VendorBdf { bus: 1, device: 2, function: 3 }));
        assert_eq!(target_bdf(Some(&json!({"bdf":"0000:01:02.3"}))), Some(VendorBdf { bus: 1, device: 2, function: 3 }));
        assert_eq!(parse_bdf_text("0000:0a:1f.7"), Some(VendorBdf { bus: 10, device: 31, function: 7 }));
        let mut adl = vec![0u8; 1572];
        adl[0..4].copy_from_slice(&1572i32.to_le_bytes());
        adl[264..268].copy_from_slice(&1i32.to_le_bytes());
        adl[268..272].copy_from_slice(&2i32.to_le_bytes());
        adl[272..276].copy_from_slice(&3i32.to_le_bytes());
        assert_eq!(adl_bdf(&adl, 0, 1572), Some(VendorBdf { bus: 1, device: 2, function: 3 }));
        assert_eq!(adl_bdf(&adl, 1, 1572), None);
    }
}
