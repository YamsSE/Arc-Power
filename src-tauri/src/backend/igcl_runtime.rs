//! Explicit, read-only native IGCL worker. A selected present display instance
//! resolves its exact installed DriverStore package; no directory scan/fallback.
//! All native handles, calls and DLL lifetime remain on one dedicated thread.
//! This foundation does not implement the application's full telemetry contract.
use super::{driver_package::{self, DriverPackage}, igcl_raw::*};
use serde::Serialize;
use std::{collections::BTreeMap, ffi::c_void, fmt, ptr, sync::{mpsc, Mutex, atomic::{AtomicBool, Ordering}}, thread};

macro_rules! insert_telemetry_items {
    ($items:ident, $data:ident, $($name:ident),* $(,)?) => {
        $(if let Some(value) = decode_item($data.$name) { $items.insert(stringify!($name).to_owned(), value); })*
    };
}

type Handle = *mut c_void;
const SUCCESS: u32 = 0;
const ERROR_IGSC_LOADER: u32 = 0x4001_0001;
const MAX_ADAPTERS: u32 = 4096;
static ACTIVE_RUNTIME: Mutex<()> = Mutex::new(());
static CLEANUP_FAILED: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeError { pub operation: &'static str, pub status: Option<u32>, pub detail: String }
impl RuntimeError {
    fn local(operation: &'static str, detail: impl Into<String>) -> Self {
        Self { operation, status: None, detail: detail.into() }
    }
    fn native(operation: &'static str, status: u32) -> Self {
        Self { operation, status: Some(status), detail: format!("IGCL returned 0x{status:08x}") }
    }
}
impl fmt::Display for RuntimeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}: {}", self.operation, self.detail) }
}
impl std::error::Error for RuntimeError {}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAdapter {
    pub index: usize, pub name: String, pub device_type: i32,
    pub pci_vendor_id: u32, pub pci_device_id: u32, pub rev_id: u32,
    pub pci_subsys_id: u16, pub pci_subsys_vendor_id: u16,
    pub bus: u8, pub device: u8, pub function: u8,
    pub luid: Option<String>, pub driver_version: String,
    pub graphics_adapter_properties: u32, pub graphics_clock_mhz: u32, pub num_xe_cores: u32,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub package: DriverPackage, pub adapters: Vec<NativeAdapter>, pub igsc_full_available: bool,
}

/// Native union interpretation with the original numeric unit/type tags. Exact
/// 64-bit integers are strings; values outside JS's safe integer range are
/// omitted from `value` rather than silently rounded across the WebView bridge.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryItem {
    pub units: i32, pub data_type: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exact_integer: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawTelemetry {
    pub adapter_index: usize, pub api: &'static str,
    pub items: BTreeMap<String, TelemetryItem>, pub fan_rpm: Vec<TelemetryItem>,
    pub throttle: BTreeMap<String, bool>,
}

enum Request {
    Sample(usize, mpsc::SyncSender<Result<RawTelemetry, RuntimeError>>),
    Close(mpsc::SyncSender<Result<(), RuntimeError>>),
}
/// No raw handle or DLL function pointer crosses this boundary. Creation is
/// explicit and requires the SetupAPI instance identity chosen by the host.
pub struct IgclRuntime {
    info: RuntimeInfo,
    requests: Option<mpsc::SyncSender<Request>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl IgclRuntime {
    pub fn start(instance_id: &str) -> Result<Self, RuntimeError> {
        if instance_id.is_empty() { return Err(RuntimeError::local("start", "display instance identity is required")); }
        let instance_id = instance_id.to_owned();
        let (requests, receiver) = mpsc::sync_channel(8);
        let (started, ready) = mpsc::sync_channel(1);
        let worker = thread::Builder::new().name("arc-igcl-read-only".into()).spawn(move || {
            // IGCL initialization has process-global effects. Never create a
            // second worker/session concurrently, including for another device.
            let _exclusive = match ACTIVE_RUNTIME.try_lock() {
                Ok(guard) => guard,
                Err(_) => { let _ = started.send(Err(RuntimeError::local("start", "another native IGCL runtime is active or failed"))); return; }
            };
            if CLEANUP_FAILED.load(Ordering::Acquire) {
                let _ = started.send(Err(RuntimeError::local("start", "a previous native cleanup failed; restart the application before retrying"))); return;
            }
            let opened = Session::open_instance(&instance_id);
            let (mut session, info) = match opened {
                Ok(opened) => opened,
                Err(error) => { let _ = started.send(Err(error)); return; }
            };
            if started.send(Ok(info)).is_err() { return; }
            while let Ok(request) = receiver.recv() {
                match request {
                    Request::Sample(index, reply) => { let _ = reply.send(session.sample(index)); }
                    Request::Close(reply) => { let _ = reply.send(session.close()); break; }
                }
            }
        }).map_err(|e| RuntimeError::local("worker-start", e.to_string()))?;
        match ready.recv() {
            Ok(Ok(info)) => Ok(Self { info, requests: Some(requests), worker: Some(worker) }),
            result => {
                let _ = worker.join();
                Err(match result { Ok(Err(error)) => error, _ => RuntimeError::local("worker-start", "worker stopped during initialization") })
            }
        }
    }
    pub fn info(&self) -> &RuntimeInfo { &self.info }
    pub fn sample(&self, adapter_index: usize) -> Result<RawTelemetry, RuntimeError> {
        let (reply, response) = mpsc::sync_channel(1);
        self.requests.as_ref().ok_or_else(|| RuntimeError::local("sample", "runtime is closed"))?
            .send(Request::Sample(adapter_index, reply)).map_err(|_| RuntimeError::local("sample", "worker is unavailable"))?;
        response.recv().map_err(|_| RuntimeError::local("sample", "worker stopped before responding"))?
    }
    pub fn shutdown(&mut self) -> Result<(), RuntimeError> {
        let result = if let Some(requests) = self.requests.take() {
            let (reply, response) = mpsc::sync_channel(1);
            requests.send(Request::Close(reply)).map_err(|_| RuntimeError::local("close", "worker is unavailable"))
                .and_then(|()| response.recv().map_err(|_| RuntimeError::local("close", "worker stopped before responding")))
                .and_then(|result| result)
        } else { Ok(()) };
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() { return Err(RuntimeError::local("close", "worker panicked")); }
        }
        result
    }
}
impl Drop for IgclRuntime { fn drop(&mut self) { let _ = self.shutdown(); } }

#[derive(Clone, Copy)]
struct Functions {
    init: ctlInitFn, close: ctlCloseFn, enumerate: ctlEnumerateDevicesFn,
    properties: ctlGetDevicePropertiesFn,
    telemetry_v1: Option<ctlPowerTelemetryGetFn>, telemetry_v2: Option<ctlPowerTelemetryGetV2Fn>,
}
struct Session {
    functions: Functions, api: Handle, handles: Vec<Handle>, igsc_full_available: bool,
    close_failed: bool,
    #[cfg(windows)]
    library: Option<Library>,
}
impl Session {
    fn open_instance(instance_id: &str) -> Result<(Self, RuntimeInfo), RuntimeError> {
        let discovery = driver_package::discover_active_intel_display_packages()
            .map_err(|e| RuntimeError::local("driver-package", e.to_string()))?;
        let mut matches = discovery.packages.into_iter().filter(|p| p.instance_id.eq_ignore_ascii_case(instance_id));
        let package = matches.next().ok_or_else(|| RuntimeError::local("driver-package", "selected present Intel display package is unavailable"))?;
        if matches.next().is_some() { return Err(RuntimeError::local("driver-package", "ambiguous display instance identity")); }
        #[cfg(all(windows, target_pointer_width = "64"))]
        {
            let library = Library::load(&package.dll_path)?;
            let functions = unsafe { library.functions()? };
            let mut session = Self::initialize(functions, Some(library))?;
            let adapters = session.enumerate()?;
            let info = RuntimeInfo { package, adapters, igsc_full_available: session.igsc_full_available };
            Ok((session, info))
        }
        #[cfg(not(all(windows, target_pointer_width = "64")))]
        { let _ = package; Err(RuntimeError::local("load", "only the verified Windows x64 ABI is supported")) }
    }
    fn initialize(functions: Functions, #[cfg(windows)] library: Option<Library>) -> Result<Self, RuntimeError> {
        let mut session = Self { functions, api: ptr::null_mut(), handles: Vec::new(),
            igsc_full_available: false, close_failed: false, #[cfg(windows)] library };
        let mut args: ctl_init_args_t = unsafe { std::mem::zeroed() };
        args.Size = std::mem::size_of::<ctl_init_args_t>() as u32;
        args.AppVersion = 0x10001; args.flags = 3;
        let mut result = unsafe { (functions.init)(&mut args, (&mut session.api as *mut Handle).cast()) };
        if result == ERROR_IGSC_LOADER {
            session.close()?;
            // Sole source fallback, with a fresh zero UID and no write waiver.
            args = unsafe { std::mem::zeroed() };
            args.Size = std::mem::size_of::<ctl_init_args_t>() as u32;
            args.AppVersion = 0x10001; args.flags = 1;
            result = unsafe { (functions.init)(&mut args, (&mut session.api as *mut Handle).cast()) };
        } else { session.igsc_full_available = result == SUCCESS; }
        if result != SUCCESS {
            let mut error = RuntimeError::native("ctlInit", result);
            if let Err(cleanup) = session.close() { error.detail.push_str(&format!("; cleanup: {cleanup}")); }
            return Err(error);
        }
        if session.api.is_null() { return Err(RuntimeError::local("ctlInit", "success returned a null API handle")); }
        Ok(session)
    }
    fn enumerate(&mut self) -> Result<Vec<NativeAdapter>, RuntimeError> {
        self.ensure_open()?;
        let mut count = 0;
        let status = unsafe { (self.functions.enumerate)(self.api, &mut count, ptr::null_mut()) };
        if status != SUCCESS { return Err(RuntimeError::native("ctlEnumerateDevices(count)", status)); }
        if count > MAX_ADAPTERS { return Err(RuntimeError::local("enumerate", "adapter count exceeds allocation bound")); }
        let capacity = count;
        let mut handles = vec![ptr::null_mut(); count as usize];
        if count != 0 {
            let status = unsafe { (self.functions.enumerate)(self.api, &mut count, handles.as_mut_ptr()) };
            if status != SUCCESS { return Err(RuntimeError::native("ctlEnumerateDevices(fill)", status)); }
            if count > capacity { return Err(RuntimeError::local("enumerate", "adapter count increased beyond supplied capacity")); }
        }
        handles.truncate(count as usize);
        let mut adapters = Vec::with_capacity(handles.len());
        for (index, handle) in handles.iter().copied().enumerate() {
            if handle.is_null() { return Err(RuntimeError::local("enumerate", "null adapter handle")); }
            let mut luid = 0_u64; // Native LUID storage must be 8-byte aligned.
            let mut props: ctl_device_adapter_properties_t = unsafe { std::mem::zeroed() };
            props.Size = std::mem::size_of::<ctl_device_adapter_properties_t>() as u32;
            props.Version = 3; props.pDeviceID = (&mut luid as *mut u64).cast(); props.device_id_size = 8;
            let status = unsafe { (self.functions.properties)(handle, &mut props) };
            if status != SUCCESS { return Err(RuntimeError::native("ctlGetDeviceProperties", status)); }
            let bytes: Vec<u8> = props.name.iter().take_while(|b| **b != 0).map(|b| *b as u8).collect();
            // Read only our buffer, never a pointer rewritten by the driver.
            let luid = (props.device_id_size == 8 && luid != 0)
                .then(|| luid.to_le_bytes().iter().map(|b| format!("{b:02x}")).collect());
            adapters.push(NativeAdapter { index, name: String::from_utf8_lossy(&bytes).into_owned(),
                device_type: props.device_type, pci_vendor_id: props.pci_vendor_id, pci_device_id: props.pci_device_id,
                rev_id: props.rev_id, pci_subsys_id: props.pci_subsys_id, pci_subsys_vendor_id: props.pci_subsys_vendor_id,
                bus: props.adapter_bdf.bus, device: props.adapter_bdf.device, function: props.adapter_bdf.function,
                luid, driver_version: format!("0x{:016x}", props.driver_version),
                graphics_adapter_properties: props.graphics_adapter_properties, graphics_clock_mhz: props.Frequency,
                num_xe_cores: props.num_xe_cores });
        }
        self.handles = handles;
        Ok(adapters)
    }
    fn ensure_open(&self) -> Result<(), RuntimeError> {
        if self.api.is_null() || self.close_failed { Err(RuntimeError::local("session", "session is closed or cleanup failed")) } else { Ok(()) }
    }
    fn sample(&mut self, index: usize) -> Result<RawTelemetry, RuntimeError> {
        self.ensure_open()?;
        let handle = *self.handles.get(index).ok_or_else(|| RuntimeError::local("sample", "unknown adapter index"))?;
        if let Some(function) = self.functions.telemetry_v2 {
            let mut data: ctl_power_telemetry_v2_t = unsafe { std::mem::zeroed() };
            data.Size = std::mem::size_of::<ctl_power_telemetry_v2_t>() as u32; data.Version = 1;
            let status = unsafe { function(handle, &mut data) };
            if status == SUCCESS { return Ok(telemetry_snapshot!(index, "ctlPowerTelemetryGetV2", data)); }
            if !v2_compatibility_error(status) || self.functions.telemetry_v1.is_none() {
                return Err(RuntimeError::native("ctlPowerTelemetryGetV2", status));
            }
        }
        let function = self.functions.telemetry_v1.ok_or_else(|| RuntimeError::local("sample", "no power telemetry symbol is available"))?;
        let mut data: ctl_power_telemetry_t = unsafe { std::mem::zeroed() };
        data.Size = std::mem::size_of::<ctl_power_telemetry_t>() as u32; data.Version = 1;
        let status = unsafe { function(handle, &mut data) };
        if status != SUCCESS { return Err(RuntimeError::native("ctlPowerTelemetryGet", status)); }
        Ok(telemetry_snapshot!(index, "ctlPowerTelemetryGet", data))
    }
    fn close(&mut self) -> Result<(), RuntimeError> {
        if self.api.is_null() { return Ok(()); }
        let status = unsafe { (self.functions.close)(self.api) };
        if status != SUCCESS && status != 1 {
            self.close_failed = true;
            return Err(RuntimeError::native("ctlClose", status));
        }
        self.api = ptr::null_mut(); self.handles.clear(); self.close_failed = false;
        Ok(())
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        if !self.close_failed { let _ = self.close(); }
        // Failed cleanup leaves native ownership uncertain: retain the DLL so
        // a live native context never points into an unloaded module.
        #[cfg(windows)]
        if !self.api.is_null() { if let Some(library) = self.library.take() {
            CLEANUP_FAILED.store(true, Ordering::Release);
            std::mem::forget(library);
        } }
    }
}

fn v2_compatibility_error(status: u32) -> bool {
    matches!(status, 0x40000007 | 0x40000009 | 0x4000000a | 0x40000010 | 0x40000015)
}
fn decode_item(item: ctl_oc_telemetry_item_t) -> Option<TelemetryItem> {
    if item.bSupported == 0 { return None; }
    let bits = item.value.to_bits();
    let mut exact_integer = None;
    let value = match item.r#type {
        0 => Some(bits as i8 as f64), 1 => Some(bits as u8 as f64),
        2 => Some(bits as i16 as f64), 3 => Some(bits as u16 as f64),
        4 => Some(bits as i32 as f64), 5 => Some(bits as u32 as f64),
        6 => { let n = bits as i64; exact_integer = Some(n.to_string()); (n.unsigned_abs() <= 9_007_199_254_740_991).then_some(n as f64) }
        7 => { exact_integer = Some(bits.to_string()); (bits <= 9_007_199_254_740_991).then_some(bits as f64) }
        8 => Some(f32::from_bits(bits as u32) as f64), 9 => Some(item.value),
        _ => return None,
    }.filter(|value| value.is_finite());
    if value.is_none() && exact_integer.is_none() { return None; }
    Some(TelemetryItem { units: item.units, data_type: item.r#type, value, exact_integer })
}

// Both ABI versions expose these common items. V1-only VRAM throttle bits are
// deliberately excluded; this snapshot never pretends they exist in V2.
macro_rules! telemetry_snapshot {
    ($index:expr, $api:expr, $data:expr) => {{
        let data = $data;
        let mut items = BTreeMap::new();
        insert_telemetry_items!(items, data, timeStamp, gpuEnergyCounter, gpuVoltage, gpuCurrentClockFrequency, gpuCurrentTemperature,
            globalActivityCounter, renderComputeActivityCounter, mediaActivityCounter,
            vramEnergyCounter, vramVoltage, vramCurrentClockFrequency, vramCurrentEffectiveFrequency,
            vramReadBandwidthCounter, vramWriteBandwidthCounter, vramCurrentTemperature,
            totalCardEnergyCounter, gpuVrTemp, vramVrTemp, saVrTemp, gpuEffectiveClock,
            gpuOverVoltagePercent, gpuPowerPercent, gpuTemperaturePercent, vramReadBandwidth, vramWriteBandwidth);
        let throttle = BTreeMap::from([
            ("power".into(), data.gpuPowerLimited != 0), ("temp".into(), data.gpuTemperatureLimited != 0),
            ("current".into(), data.gpuCurrentLimited != 0), ("voltage".into(), data.gpuVoltageLimited != 0),
            ("util".into(), data.gpuUtilizationLimited != 0),
        ]);
        RawTelemetry { adapter_index: $index, api: $api, items,
            fan_rpm: data.fanSpeed.into_iter().filter_map(decode_item).collect(), throttle }
    }};
}
use telemetry_snapshot;

#[cfg(windows)]
struct Library(windows_sys::Win32::Foundation::HMODULE);
#[cfg(windows)]
impl Library {
    fn load(path: &std::path::Path) -> Result<Self, RuntimeError> {
        use std::{os::windows::{ffi::OsStrExt, fs::MetadataExt}, path::{Component, Prefix}};
        use windows_sys::Win32::{Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
            System::LibraryLoader::{LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, LOAD_LIBRARY_SEARCH_SYSTEM32}};
        if !path.is_absolute() || !matches!(path.components().next(), Some(Component::Prefix(p))
            if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))) {
            return Err(RuntimeError::local("load", "absolute local drive DLL path is required"));
        }
        let mut checked = std::path::PathBuf::new();
        for component in path.components() {
            if matches!(component, Component::ParentDir | Component::CurDir) { return Err(RuntimeError::local("load", "relative path component")); }
            checked.push(component.as_os_str());
            if matches!(component, Component::Prefix(_)) { continue; }
            let metadata = std::fs::symlink_metadata(&checked).map_err(|e| RuntimeError::local("load", e.to_string()))?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 { return Err(RuntimeError::local("load", "reparse path component")); }
        }
        if !path.file_name().is_some_and(|name| name.eq_ignore_ascii_case("IntelControlLib.dll"))
            || !std::fs::metadata(path).map_err(|e| RuntimeError::local("load", e.to_string()))?.is_file() {
            return Err(RuntimeError::local("load", "expected the installed IntelControlLib.dll file"));
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) { return Err(RuntimeError::local("load", "embedded NUL in DLL path")); }
        wide.push(0);
        let module = unsafe { LoadLibraryExW(wide.as_ptr(), ptr::null_mut(), LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32) };
        if module.is_null() { return Err(RuntimeError::local("LoadLibraryExW", std::io::Error::last_os_error().to_string())); }
        Ok(Self(module))
    }
    unsafe fn functions(&self) -> Result<Functions, RuntimeError> {
        use windows_sys::Win32::System::LibraryLoader::GetProcAddress;
        macro_rules! optional {
            ($name:literal, $ty:ty) => {
                unsafe { GetProcAddress(self.0, concat!($name, "\0").as_ptr()) }
                    .map(|address| unsafe { std::mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(address) })
            };
        }
        macro_rules! required {
            ($name:literal, $ty:ty) => { optional!($name, $ty).ok_or_else(|| RuntimeError::local("GetProcAddress", concat!("missing ", $name)))? };
        }
        // Explicit read-only allowlist. Mutation and waiver symbols never bind.
        Ok(Functions {
            init: required!("ctlInit", ctlInitFn), close: required!("ctlClose", ctlCloseFn),
            enumerate: required!("ctlEnumerateDevices", ctlEnumerateDevicesFn), properties: required!("ctlGetDeviceProperties", ctlGetDevicePropertiesFn),
            telemetry_v1: optional!("ctlPowerTelemetryGet", ctlPowerTelemetryGetFn), telemetry_v2: optional!("ctlPowerTelemetryGetV2", ctlPowerTelemetryGetV2Fn),
        })
    }
}
#[cfg(windows)]
impl Drop for Library { fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::FreeLibrary(self.0); } } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct Fake {
        flags: Vec<u32>, init_results: Vec<u32>, closes: usize, close_status: u32,
        count: u32, fill_count: Option<u32>, null_api: bool,
        v1_calls: usize, v2_calls: usize, v2_status: u32,
    }
    thread_local! { static FAKE: RefCell<Fake> = RefCell::new(Fake::default()); }
    unsafe extern "C" fn init(args: *mut ctl_init_args_t, output: *mut c_void) -> u32 {
        let args = unsafe { &*args };
        assert_eq!(args.Size, 36); assert_eq!(args.Version, 0); assert_eq!(args.AppVersion, 0x10001);
        assert_eq!(args.ApplicationUID.Data1, 0); assert_eq!(args.ApplicationUID.Data2, 0);
        assert_eq!(args.ApplicationUID.Data3, 0); assert_eq!(args.ApplicationUID.Data4, [0; 8]);
        FAKE.with(|fake| {
            let mut fake = fake.borrow_mut(); fake.flags.push(args.flags);
            unsafe { *output.cast::<Handle>() = if fake.null_api { ptr::null_mut() } else { 1_usize as Handle }; }
            if fake.init_results.is_empty() { 0 } else { fake.init_results.remove(0) }
        })
    }
    unsafe extern "C" fn close(_: Handle) -> u32 {
        FAKE.with(|fake| { let mut fake = fake.borrow_mut(); fake.closes += 1; fake.close_status })
    }
    unsafe extern "C" fn enumerate(_: Handle, count: *mut u32, handles: *mut Handle) -> u32 {
        FAKE.with(|fake| {
            let fake = fake.borrow();
            if handles.is_null() { unsafe { *count = fake.count; } }
            else {
                for i in 0..unsafe { *count } { unsafe { *handles.add(i as usize) = (i as usize + 2) as Handle; } }
                unsafe { *count = fake.fill_count.unwrap_or(fake.count); }
            }
            SUCCESS
        })
    }
    unsafe extern "C" fn properties(_: Handle, properties: *mut ctl_device_adapter_properties_t) -> u32 {
        let properties = unsafe { &mut *properties };
        assert_eq!(properties.Size, 320); assert_eq!(properties.Version, 3);
        assert_eq!(properties.pDeviceID as usize % 8, 0); assert_eq!(properties.device_id_size, 8);
        unsafe { *properties.pDeviceID.cast::<u64>() = 0x0807060504030201; }
        properties.name[0] = b'A' as i8; properties.pci_vendor_id = 0x8086;
        SUCCESS
    }
    unsafe extern "C" fn v1(_: Handle, data: *mut ctl_power_telemetry_t) -> u32 {
        let data = unsafe { &mut *data }; assert_eq!(data.Version, 1);
        assert_eq!(data.Size as usize, std::mem::size_of::<ctl_power_telemetry_t>());
        FAKE.with(|fake| fake.borrow_mut().v1_calls += 1); SUCCESS
    }
    unsafe extern "C" fn v2(_: Handle, data: *mut ctl_power_telemetry_v2_t) -> u32 {
        let data = unsafe { &mut *data }; assert_eq!(data.Version, 1);
        assert_eq!(data.Size as usize, std::mem::size_of::<ctl_power_telemetry_v2_t>());
        FAKE.with(|fake| { let mut fake = fake.borrow_mut(); fake.v2_calls += 1; fake.v2_status })
    }
    fn session(fake: Fake) -> Result<Session, RuntimeError> {
        FAKE.with(|state| *state.borrow_mut() = fake);
        Session::initialize(Functions { init, close, enumerate, properties, telemetry_v1: Some(v1), telemetry_v2: Some(v2) }, #[cfg(windows)] None)
    }
    fn item(kind: i32, bits: u64) -> ctl_oc_telemetry_item_t {
        ctl_oc_telemetry_item_t { bSupported: 1, units: 0, r#type: kind, value: f64::from_bits(bits) }
    }
    #[test]
    fn union_values_decode_without_precision_or_nonfinite_loss() {
        assert_eq!(decode_item(item(0, 0xff)).unwrap().value, Some(-1.0));
        assert_eq!(decode_item(item(8, (1.25_f32).to_bits() as u64)).unwrap().value, Some(1.25));
        let huge = decode_item(item(7, u64::MAX)).unwrap();
        assert_eq!(huge.exact_integer.as_deref(), Some("18446744073709551615"));
        assert!(huge.value.is_none());
        assert_eq!(decode_item(item(6, (-123_i64) as u64)).unwrap().value, Some(-123.0));
        assert!(decode_item(item(9, f64::NAN.to_bits())).is_none());
        assert!(decode_item(item(10, 0)).is_none());
        let mut absent = item(9, 0); absent.bSupported = 0; assert!(decode_item(absent).is_none());
    }
    #[test]
    fn only_source_compatibility_errors_allow_v1_retry() {
        for status in [0x40000007, 0x40000009, 0x4000000a, 0x40000010, 0x40000015] { assert!(v2_compatibility_error(status)); }
        for status in [0, 0x40000003, 0x40000006, 0x40000017] { assert!(!v2_compatibility_error(status)); }
    }
    #[test]
    fn snapshots_keep_unsupported_fields_absent_and_v1_v2_storage_distinct() {
        let mut v1: ctl_power_telemetry_t = unsafe { std::mem::zeroed() };
        v1.gpuCurrentTemperature = item(9, 55_f64.to_bits());
        v1.gpuPowerLimited = 1;
        let one = telemetry_snapshot!(0, "v1", v1);
        assert_eq!(one.items.len(), 1); assert_eq!(one.items["gpuCurrentTemperature"].value, Some(55.0));
        assert_eq!(one.throttle["power"], true);
        let v2: ctl_power_telemetry_v2_t = unsafe { std::mem::zeroed() };
        assert!(telemetry_snapshot!(0, "v2", v2).items.is_empty());
    }
    #[test]
    fn fallback_cleans_partial_init_and_preserves_zero_uid() {
        let mut session = session(Fake { init_results: vec![ERROR_IGSC_LOADER, SUCCESS], count: 1, ..Fake::default() }).unwrap();
        assert!(!session.igsc_full_available);
        let devices = session.enumerate().unwrap();
        assert_eq!(devices[0].luid.as_deref(), Some("0102030405060708"));
        assert_eq!(devices[0].name, "A");
        session.close().unwrap(); drop(session);
        FAKE.with(|fake| { let fake = fake.borrow(); assert_eq!(fake.flags, [3, 1]); assert_eq!(fake.closes, 2); });
    }
    #[test]
    fn invalid_or_growing_enumeration_fails_before_sampling() {
        let mut session = session(Fake { count: 1, fill_count: Some(2), ..Fake::default() }).unwrap();
        assert!(session.enumerate().is_err()); assert!(session.sample(0).is_err());
        assert!(session.handles.is_empty());
        FAKE.with(|fake| { assert_eq!(fake.borrow().v1_calls, 0); assert_eq!(fake.borrow().v2_calls, 0); });
    }
    #[test]
    fn telemetry_fallback_is_limited_to_compatibility_statuses() {
        let mut session = session(Fake { count: 1, v2_status: 0x40000007, ..Fake::default() }).unwrap();
        session.enumerate().unwrap();
        assert_eq!(session.sample(0).unwrap().api, "ctlPowerTelemetryGet");
        FAKE.with(|fake| fake.borrow_mut().v2_status = 0x40000003);
        assert_eq!(session.sample(0).unwrap_err().status, Some(0x40000003));
        FAKE.with(|fake| { let fake = fake.borrow(); assert_eq!(fake.v1_calls, 1); assert_eq!(fake.v2_calls, 2); });
    }
    #[test]
    fn failed_close_blocks_further_calls_and_is_not_retried_by_drop() {
        let mut session = session(Fake { close_status: 0x40000017, ..Fake::default() }).unwrap();
        assert!(session.close().is_err()); assert!(session.enumerate().is_err());
        drop(session); FAKE.with(|fake| assert_eq!(fake.borrow().closes, 1));
    }
    #[test]
    fn null_api_and_excessive_counts_are_rejected() {
        assert!(session(Fake { null_api: true, ..Fake::default() }).is_err());
        let mut session = session(Fake { count: MAX_ADAPTERS + 1, ..Fake::default() }).unwrap();
        assert!(session.enumerate().is_err());
    }
}
