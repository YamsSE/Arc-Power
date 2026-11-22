//! Read-only discovery of the package installed for each present Intel display
//! instance. No runtime loading, hardware calls, directory scans or fallback.
//!
//! Verified SDK: Windows Kits/10/Include/10.0.26100.0/{shared/devpkey.h,
//! shared/devguid.h,um/setupapi.h}; keys are imported from windows-sys.
//! Primary contracts:
//! https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupdigetdevicepropertyw
//! https://learn.microsoft.com/en-us/windows/win32/api/setupapi/nf-setupapi-setupgetinfdriverstorelocationw
//! https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-getwindowsdirectoryw
use serde::Serialize;
use std::{fmt, path::{Path, PathBuf}};

const MAX_DEVICES: u32 = 4096;
const MAX_STRING_UNITS: usize = 4096;
const MAX_PATH_UNITS: usize = 260;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverPackage {
    pub instance_id: String,
    pub version: String,
    pub published_inf: PathBuf,
    pub store_inf: PathBuf,
    pub dll_path: PathBuf,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DiscoveryStatus { Available, Partial, Unavailable, NoIntelDisplay }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePackageFailure { pub instance_id: String, pub error: DiscoveryError }
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DriverPackageDiscovery {
    pub status: DiscoveryStatus,
    pub packages: Vec<DriverPackage>,
    pub failures: Vec<DevicePackageFailure>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryError { pub operation: &'static str, pub os_code: Option<u32>, pub detail: String }
impl DiscoveryError {
    fn local(operation: &'static str, detail: impl Into<String>) -> Self {
        Self { operation, os_code: None, detail: detail.into() }
    }
    #[cfg(windows)]
    fn last(operation: &'static str) -> Self {
        let error = std::io::Error::last_os_error();
        Self { operation, os_code: error.raw_os_error().map(|code| code as u32), detail: error.to_string() }
    }
}
impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { write!(f, "{}: {}", self.operation, self.detail) }
}
impl std::error::Error for DiscoveryError {}

#[derive(Clone, Copy)]
enum DriverProperty { InfPath, Version }
trait PackageApi {
    fn windows_directory(&self) -> Result<PathBuf, DiscoveryError>;
    fn next_device(&mut self, index: u32) -> Result<Option<String>, DiscoveryError>;
    fn property(&self, property: DriverProperty) -> Result<String, DiscoveryError>;
    fn store_inf(&self, published: &Path) -> Result<PathBuf, DiscoveryError>;
    fn validate_file(&self, path: &Path) -> Result<(), DiscoveryError>;
}

fn intel_pci_instance(instance: &str) -> bool {
    let mut sections = instance.split('\\');
    sections.next().is_some_and(|s| s.eq_ignore_ascii_case("PCI"))
        && sections.next().is_some_and(|id| id.split('&').any(|part| part.eq_ignore_ascii_case("VEN_8086")))
}
fn published_inf_name(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.strip_prefix("oem").and_then(|s| s.strip_suffix(".inf"))
        .is_some_and(|digits| !digits.is_empty() && digits.len() <= 4 && digits.bytes().all(|b| b.is_ascii_digit()))
}
fn decode_string(units: &[u16]) -> Result<String, DiscoveryError> {
    if units.is_empty() || units.len() > MAX_STRING_UNITS || units.last() != Some(&0)
        || units[..units.len()-1].contains(&0) {
        return Err(DiscoveryError::local("decode-string", "invalid bounded NUL-terminated UTF-16 string"));
    }
    let value = String::from_utf16(&units[..units.len()-1])
        .map_err(|_| DiscoveryError::local("decode-string", "invalid UTF-16"))?;
    if value.is_empty() { return Err(DiscoveryError::local("decode-string", "empty property")); }
    Ok(value)
}
fn resolve_current(api: &impl PackageApi, windows: &Path, instance_id: String) -> Result<DriverPackage, DiscoveryError> {
    let inf_name = api.property(DriverProperty::InfPath)?;
    if !published_inf_name(&inf_name) { return Err(DiscoveryError::local("published-inf", "expected the installed OEMnnn.inf basename")); }
    let version = api.property(DriverProperty::Version)?;
    if version.is_empty() { return Err(DiscoveryError::local("driver-version", "empty installed version")); }
    let published_inf = windows.join("INF").join(inf_name);
    api.validate_file(&published_inf)?;
    let store_inf = api.store_inf(&published_inf)?;
    if !store_inf.is_absolute() || !store_inf.extension().is_some_and(|s| s.eq_ignore_ascii_case("inf")) {
        return Err(DiscoveryError::local("store-inf", "SetupAPI returned an invalid absolute INF path"));
    }
    api.validate_file(&store_inf)?;
    let parent = store_inf.parent().ok_or_else(|| DiscoveryError::local("store-inf", "missing package directory"))?;
    let dll_path = parent.join("IntelControlLib.dll");
    api.validate_file(&dll_path)?;
    Ok(DriverPackage {instance_id, version, published_inf, store_inf, dll_path})
}
fn discover(api: &mut impl PackageApi) -> Result<DriverPackageDiscovery, DiscoveryError> {
    let windows = api.windows_directory()?;
    if !windows.is_absolute() { return Err(DiscoveryError::local("windows-directory", "Windows API returned a nonabsolute directory")); }
    let mut packages = Vec::new(); let mut failures = Vec::new();
    for index in 0..=MAX_DEVICES {
        let Some(instance_id) = api.next_device(index)? else {
            let status = match (packages.is_empty(), failures.is_empty()) {
                (false,true) => DiscoveryStatus::Available, (false,false) => DiscoveryStatus::Partial,
                (true,false) => DiscoveryStatus::Unavailable, (true,true) => DiscoveryStatus::NoIntelDisplay,
            };
            return Ok(DriverPackageDiscovery {status, packages, failures});
        };
        if index == MAX_DEVICES { return Err(DiscoveryError::local("enumerate", "display enumeration exceeds safety bound")); }
        if !intel_pci_instance(&instance_id) { continue; }
        match resolve_current(api, &windows, instance_id.clone()) {
            Ok(package) => packages.push(package),
            Err(error) => failures.push(DevicePackageFailure {instance_id, error}),
        }
    }
    unreachable!()
}

/// Returns every matching present instance, leaving target selection explicit.
/// Presence and installed package identity do not prove this is the rendering
/// adapter or that its runtime will initialize. No DLL is loaded by discovery.
#[cfg(windows)]
pub fn discover_active_intel_display_packages() -> Result<DriverPackageDiscovery, DiscoveryError> {
    discover(&mut native::Devices::open()?)
}
#[cfg(not(windows))]
pub fn discover_active_intel_display_packages() -> Result<DriverPackageDiscovery, DiscoveryError> {
    Err(DiscoveryError::local("platform", "Windows SetupAPI discovery is unavailable"))
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::{os::windows::{ffi::OsStrExt, fs::MetadataExt}, path::{Component, Prefix}, ptr};
    use windows_sys::Win32::{Devices::{DeviceAndDriverInstallation::*, Properties::{
        DEVPKEY_Device_DriverInfPath, DEVPKEY_Device_DriverVersion, DEVPROP_TYPE_STRING}},
        Foundation::{ERROR_NO_MORE_ITEMS, ERROR_INSUFFICIENT_BUFFER},
        Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
        System::SystemInformation::GetWindowsDirectoryW};
    pub(super) struct Devices { handle: HDEVINFO, current: SP_DEVINFO_DATA }
    impl Devices {
        pub(super) fn open() -> Result<Self, DiscoveryError> {
            let handle = unsafe { SetupDiGetClassDevsW(&GUID_DEVCLASS_DISPLAY, ptr::null(), ptr::null_mut(), DIGCF_PRESENT) };
            // HDEVINFO is an isize in windows-sys, INVALID_HANDLE_VALUE is -1.
            if handle == -1 { return Err(DiscoveryError::last("SetupDiGetClassDevsW")); }
            Ok(Self {handle, current: unsafe {std::mem::zeroed()}})
        }
    }
    impl Drop for Devices {
        fn drop(&mut self) { unsafe { SetupDiDestroyDeviceInfoList(self.handle); } }
    }
    impl PackageApi for Devices {
        fn windows_directory(&self) -> Result<PathBuf, DiscoveryError> {
            let mut buffer = [0_u16; MAX_PATH_UNITS];
            let length = unsafe { GetWindowsDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) } as usize;
            if length == 0 { return Err(DiscoveryError::last("GetWindowsDirectoryW")); }
            if length >= buffer.len() { return Err(DiscoveryError::local("GetWindowsDirectoryW", "directory exceeds MAX_PATH")); }
            Ok(PathBuf::from(decode_string(&buffer[..=length])?))
        }
        fn next_device(&mut self, index: u32) -> Result<Option<String>, DiscoveryError> {
            self.current = unsafe {std::mem::zeroed()};
            self.current.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
            if unsafe { SetupDiEnumDeviceInfo(self.handle, index, &mut self.current) } == 0 {
                let error = DiscoveryError::last("SetupDiEnumDeviceInfo");
                if error.os_code == Some(ERROR_NO_MORE_ITEMS) { return Ok(None); }
                return Err(error);
            }
            let mut buffer = [0_u16; MAX_STRING_UNITS]; let mut required = 0;
            if unsafe { SetupDiGetDeviceInstanceIdW(self.handle, &self.current, buffer.as_mut_ptr(), buffer.len() as u32, &mut required) } == 0 {
                return Err(DiscoveryError::last("SetupDiGetDeviceInstanceIdW"));
            }
            if required == 0 || required as usize > buffer.len() { return Err(DiscoveryError::local("instance-id", "invalid required size")); }
            Ok(Some(decode_string(&buffer[..required as usize])?))
        }
        fn property(&self, property: DriverProperty) -> Result<String, DiscoveryError> {
            let key = match property {DriverProperty::InfPath => DEVPKEY_Device_DriverInfPath, DriverProperty::Version => DEVPKEY_Device_DriverVersion};
            let mut property_type = 0; let mut required = 0;
            let result = unsafe { SetupDiGetDevicePropertyW(self.handle, &self.current, &key, &mut property_type,
                ptr::null_mut(), 0, &mut required, 0) };
            if result == 0 {
                let error = DiscoveryError::last("SetupDiGetDevicePropertyW(size)");
                if error.os_code != Some(ERROR_INSUFFICIENT_BUFFER) { return Err(error); }
            }
            if property_type != DEVPROP_TYPE_STRING || required < 2 || required % 2 != 0 || required as usize > MAX_STRING_UNITS*2 {
                return Err(DiscoveryError::local("property-size", "expected a bounded UTF-16 DEVPROP_TYPE_STRING"));
            }
            let mut buffer = vec![0_u16; required as usize / 2]; let capacity = required;
            if unsafe { SetupDiGetDevicePropertyW(self.handle, &self.current, &key, &mut property_type,
                buffer.as_mut_ptr().cast(), capacity, &mut required, 0) } == 0 {
                return Err(DiscoveryError::last("SetupDiGetDevicePropertyW(read)"));
            }
            if property_type != DEVPROP_TYPE_STRING || required < 2 || required % 2 != 0 || required > capacity {
                return Err(DiscoveryError::local("property-read", "property type or length changed"));
            }
            decode_string(&buffer[..required as usize / 2])
        }
        fn store_inf(&self, published: &Path) -> Result<PathBuf, DiscoveryError> {
            let mut input: Vec<u16> = published.as_os_str().encode_wide().collect();
            if input.contains(&0) { return Err(DiscoveryError::local("store-inf", "embedded NUL")); }
            input.push(0);
            let mut output = [0_u16; MAX_PATH_UNITS]; let mut required = 0;
            // Both reserved inputs are native NULL pointers, never marshaled strings.
            if unsafe { SetupGetInfDriverStoreLocationW(input.as_ptr(), ptr::null(), ptr::null(),
                output.as_mut_ptr(), output.len() as u32, &mut required) } == 0 {
                return Err(DiscoveryError::last("SetupGetInfDriverStoreLocationW"));
            }
            if required == 0 || required as usize > output.len() { return Err(DiscoveryError::local("store-inf", "invalid MAX_PATH result size")); }
            Ok(PathBuf::from(decode_string(&output[..required as usize])?))
        }
        fn validate_file(&self, path: &Path) -> Result<(), DiscoveryError> { validate_file(path) }
    }
    fn validate_file(path: &Path) -> Result<(), DiscoveryError> {
        if !path.is_absolute() || !matches!(path.components().next(), Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))) {
            return Err(DiscoveryError::local("validate-path", "expected an absolute local-drive path"));
        }
        let mut current = PathBuf::new();
        for part in path.components() {
            if matches!(part, Component::ParentDir | Component::CurDir)
                || matches!(part, Component::Normal(value) if value.to_string_lossy().contains(':')) {
                return Err(DiscoveryError::local("validate-path", "relative components or alternate streams forbidden"));
            }
            current.push(part.as_os_str());
            if matches!(part, Component::Prefix(_)) { continue; }
            let metadata = std::fs::symlink_metadata(&current).map_err(|error| DiscoveryError::local("validate-path", error.to_string()))?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(DiscoveryError::local("validate-path", "reparse components forbidden"));
            }
        }
        if !std::fs::symlink_metadata(path).map_err(|error| DiscoveryError::local("validate-path", error.to_string()))?.is_file() {
            return Err(DiscoveryError::local("validate-path", "candidate is not an existing file"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake { ids: Vec<String>, current: usize, missing: bool, fail_property: bool, fail_enum: bool }
    fn root() -> PathBuf { PathBuf::from(if cfg!(windows) {r"C:\Windows"} else {"/windows"}) }
    impl PackageApi for Fake {
        fn windows_directory(&self) -> Result<PathBuf, DiscoveryError> { Ok(root()) }
        fn next_device(&mut self, index: u32) -> Result<Option<String>, DiscoveryError> {
            if self.fail_enum { return Err(DiscoveryError::local("fake-enum", "device set unavailable")); }
            self.current = index as usize; Ok(self.ids.get(self.current).cloned())
        }
        fn property(&self, property: DriverProperty) -> Result<String, DiscoveryError> {
            if self.fail_property { return Err(DiscoveryError::local("fake-property", "missing installed property")); }
            Ok(match property {DriverProperty::InfPath => format!("oem{}.inf", self.current+1), DriverProperty::Version => "32.0.101.9999".into()})
        }
        fn store_inf(&self, _published: &Path) -> Result<PathBuf, DiscoveryError> {
            Ok(root().join("System32").join("DriverStore").join("exact-package").join("iigd_dch_d.inf"))
        }
        fn validate_file(&self, path: &Path) -> Result<(), DiscoveryError> {
            if self.missing && self.current == 0 && path.file_name().is_some_and(|name| name == "IntelControlLib.dll") {
                return Err(DiscoveryError::local("fake-file", "runtime absent in exact package"));
            }
            Ok(())
        }
    }
    fn fake() -> Fake { Fake {ids: vec![r"PCI\VEN_8086&DEV_E20B\TARGET".into()],current:0,missing:false,fail_property:false,fail_enum:false} }
    #[test]
    fn exact_package_identity_is_retained_without_loading_or_fallback() {
        let result = discover(&mut fake()).unwrap(); assert_eq!(result.status, DiscoveryStatus::Available);
        assert_eq!(result.packages[0].published_inf, root().join("INF").join("oem1.inf"));
        assert_eq!(result.packages[0].dll_path, root().join("System32").join("DriverStore").join("exact-package").join("IntelControlLib.dll"));
        assert_eq!(result.packages[0].version, "32.0.101.9999");
    }
    #[test]
    fn missing_runtime_and_property_failures_never_report_available_empty() {
        let mut api = fake(); api.missing = true; let result = discover(&mut api).unwrap();
        assert_eq!(result.status, DiscoveryStatus::Unavailable); assert!(result.packages.is_empty()); assert_eq!(result.failures.len(),1);
        api.missing = false; api.fail_property = true;
        assert_eq!(discover(&mut api).unwrap().status, DiscoveryStatus::Unavailable);
        api.fail_enum = true; assert!(discover(&mut api).is_err());
    }
    #[test]
    fn no_matching_present_instance_is_a_distinct_status() {
        let mut api = fake(); api.ids = vec![r"PCI\VEN_10DE&DEV_1234\X".into()];
        assert_eq!(discover(&mut api).unwrap().status, DiscoveryStatus::NoIntelDisplay);
        for id in [r"USB\VEN_8086\X",r"PCI\VEN_80860&DEV_1234\X",r"PCI\DEV_8086\X"] { assert!(!intel_pci_instance(id)); }
        assert!(intel_pci_instance(r"pci\ven_8086&dev_e20b\x"));
    }
    #[test]
    fn one_working_package_does_not_hide_another_instances_failure() {
        let mut api = fake(); api.ids.push(r"PCI\VEN_8086&DEV_56A0\SECOND".into()); api.missing = true;
        let result = discover(&mut api).unwrap();
        assert_eq!(result.status, DiscoveryStatus::Partial);
        assert_eq!(result.packages.len(), 1); assert_eq!(result.failures.len(), 1);
        assert_eq!(result.packages[0].instance_id, api.ids[1]);
        assert_eq!(result.failures[0].instance_id, api.ids[0]);
    }
    #[test]
    fn published_inf_is_a_basename_not_an_untrusted_path() {
        assert!(published_inf_name("oem123.inf")); assert!(published_inf_name("OEM0.INF"));
        for bad in ["oem.inf","oem12345.inf","../oem1.inf",r"C:\oem1.inf","oem1.inf:stream","iigd_dch_d.inf"] { assert!(!published_inf_name(bad)); }
    }
    #[test]
    fn strings_reject_truncation_embedded_nul_and_invalid_utf16() {
        assert_eq!(decode_string(&[65,0]).unwrap(), "A");
        for bad in [vec![],vec![65],vec![65,0,66,0],vec![0xd800,0],vec![0]] { assert!(decode_string(&bad).is_err()); }
        assert!(decode_string(&vec![0; MAX_STRING_UNITS+1]).is_err());
    }
}
