//! Read-only Windows display-class inventory for OS-only GPU rows. Uses
//! SetupAPI for the hardware/PNP identity and the display class registry for
//! VRAM. No driver API is loaded or written.
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OsAdapter {
    pub name: String,
    pub pnp: String,
    pub vendor_id: u16,
    pub device_id: u16,
    pub subsys: Option<String>,
    pub bdf: Option<(u32, u32, u32)>,
    pub vram_bytes: Option<u64>,
    pub gpu_vendor: &'static str,
    pub integrated: bool,
    pub mobile: bool,
}

#[cfg(windows)]
pub fn enumerate() -> Vec<OsAdapter> {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::*;
    use std::ptr;
    let handle = unsafe { SetupDiGetClassDevsW(&GUID_DEVCLASS_DISPLAY, ptr::null(), ptr::null_mut(), DIGCF_PRESENT) };
    if handle == -1 { return Vec::new(); }
    let mut result = Vec::new();
    let mut index = 0u32;
    loop {
        let mut info: SP_DEVINFO_DATA = unsafe { std::mem::zeroed() };
        info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
        if unsafe { SetupDiEnumDeviceInfo(handle, index, &mut info) } == 0 { break; }
        index += 1;
        let Some(pnp) = instance_id(handle, &info) else { continue; };
        let Some(name) = registry_string(handle, &info, SPDRP_DEVICEDESC) else { continue; };
        if !real_controller(&name, &pnp) { continue; }
        let Some(hardware) = registry_string(handle, &info, SPDRP_HARDWAREID) else { continue; };
        let Some((vendor_id, device_id, subsys)) = parse_hardware_id(&hardware) else { continue; };
        let bdf = registry_string(handle, &info, SPDRP_LOCATION_INFORMATION).and_then(|value| parse_location(&value));
        let vram_bytes = registry_memory(vendor_id, device_id, subsys.as_deref());
        let gpu_vendor = vendor_name(vendor_id);
        let integrated = super::gpu_devices::is_integrated_style(&name);
        let mobile = super::gpu_devices::is_mobile(&name);
        result.push(OsAdapter {
            name, pnp: normalize_pnp(&pnp), vendor_id, device_id, subsys, bdf, vram_bytes, gpu_vendor,
            integrated, mobile,
        });
    }
    unsafe { SetupDiDestroyDeviceInfoList(handle); }
    result
}

#[cfg(not(windows))]
pub fn enumerate() -> Vec<OsAdapter> { Vec::new() }

/// Enumerate a complete SetupAPI display-class snapshot for private physical
/// alias validation. Unlike `enumerate()`, this fails the whole snapshot when
/// SetupAPI cannot prove that every present real controller has a PNP id,
/// PCI ids, and a usable PCI location. Callers must not infer uniqueness from
/// the best-effort inventory above.
#[cfg(windows)]
pub(crate) fn enumerate_for_alias_validation() -> Result<Vec<OsAdapter>, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Devices::DeviceAndDriverInstallation::*,
        Foundation::{GetLastError, ERROR_NO_MORE_ITEMS},
    };

    let handle = unsafe {
        SetupDiGetClassDevsW(&GUID_DEVCLASS_DISPLAY, ptr::null(), ptr::null_mut(), DIGCF_PRESENT)
    };
    if handle == -1 {
        return Err(format!("SetupAPI display enumeration failed ({})", unsafe { GetLastError() }));
    }

    let result = (|| {
        let mut adapters = Vec::new();
        let mut index = 0u32;
        loop {
            let mut info: SP_DEVINFO_DATA = unsafe { std::mem::zeroed() };
            info.cbSize = std::mem::size_of::<SP_DEVINFO_DATA>() as u32;
            if unsafe { SetupDiEnumDeviceInfo(handle, index, &mut info) } == 0 {
                let error = unsafe { GetLastError() };
                if error == ERROR_NO_MORE_ITEMS { break; }
                return Err(format!("SetupAPI display row enumeration failed ({error})"));
            }
            index = index.checked_add(1).ok_or("SetupAPI display row count overflow")?;

            let pnp = checked_instance_id(handle, &info)?;
            let name = checked_registry_string(handle, &info, SPDRP_DEVICEDESC)?;
            // The best-effort shared inventory filters generic names such as
            // "Microsoft Basic Display Adapter". A PNP PCI row can still be
            // the physical GPU under a fallback driver, so include every PCI
            // display row regardless of name. Brand-named non-PCI rows are
            // also treated as candidates and will fail closed without BDF.
            if !alias_identity_candidate(&name, &pnp) { continue; }

            let hardware = checked_registry_string(handle, &info, SPDRP_HARDWAREID)?;
            let (vendor_id, device_id, subsys) = parse_hardware_id(&hardware)
                .ok_or_else(|| format!("SetupAPI returned an incomplete hardware identity for {pnp}"))?;
            if !pnp_matches_pci(&pnp, vendor_id, device_id) {
                return Err(format!("SetupAPI PNP and PCI identities disagree for {pnp}"));
            }
            let location = checked_registry_string(handle, &info, SPDRP_LOCATION_INFORMATION)?;
            let bdf = parse_location(&location)
                .filter(|(bus, device, function)| *bus <= 255 && *device <= 31 && *function <= 7
                    && (*bus, *device, *function) != (0, 0, 0))
                .ok_or_else(|| format!("SetupAPI returned an incomplete PCI location for {pnp}"))?;
            let gpu_vendor = vendor_name(vendor_id);
            adapters.push(OsAdapter {
                name: name.clone(),
                pnp: normalize_pnp(&pnp),
                vendor_id,
                device_id,
                subsys,
                bdf: Some(bdf),
                vram_bytes: None,
                gpu_vendor,
                integrated: super::gpu_devices::is_integrated_style(&name),
                mobile: super::gpu_devices::is_mobile(&name),
            });
        }
        Ok(adapters)
    })();
    unsafe { SetupDiDestroyDeviceInfoList(handle); }
    result
}

#[cfg(not(windows))]
pub(crate) fn enumerate_for_alias_validation() -> Result<Vec<OsAdapter>, String> {
    Err("complete SetupAPI display enumeration is only available on Windows".into())
}

#[cfg(windows)]
fn checked_instance_id(
    handle: isize,
    info: &windows_sys::Win32::Devices::DeviceAndDriverInstallation::SP_DEVINFO_DATA,
) -> Result<String, String> {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::SetupDiGetDeviceInstanceIdW;
    let mut buffer = [0u16; 4096];
    let mut required = 0u32;
    if unsafe { SetupDiGetDeviceInstanceIdW(handle, info, buffer.as_mut_ptr(), buffer.len() as u32, &mut required) } == 0 {
        return Err(format!("SetupAPI PNP identity read failed ({})", unsafe {
            windows_sys::Win32::Foundation::GetLastError()
        }));
    }
    if required == 0 || required as usize > buffer.len() {
        return Err("SetupAPI returned an invalid PNP identity length".into());
    }
    let end = buffer[..required as usize].iter().position(|unit| *unit == 0).unwrap_or(required as usize);
    let value = String::from_utf16(&buffer[..end]).map_err(|_| "SetupAPI returned malformed PNP identity")?;
    if normalize_pnp(&value).is_empty() { return Err("SetupAPI returned an empty PNP identity".into()); }
    Ok(value)
}

#[cfg(windows)]
fn checked_registry_string(
    handle: isize,
    info: &windows_sys::Win32::Devices::DeviceAndDriverInstallation::SP_DEVINFO_DATA,
    property: u32,
) -> Result<String, String> {
    use std::ptr;
    use windows_sys::Win32::{
        Devices::DeviceAndDriverInstallation::SetupDiGetDeviceRegistryPropertyW,
        Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER},
    };
    let mut kind = 0u32;
    let mut required = 0u32;
    let first = unsafe {
        SetupDiGetDeviceRegistryPropertyW(handle, info, property, &mut kind, ptr::null_mut(), 0, &mut required)
    };
    if first != 0 || unsafe { GetLastError() } != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!("SetupAPI display property {property} is unavailable"));
    }
    if required < 2 || required as usize > 8192 || required % 2 != 0 {
        return Err(format!("SetupAPI display property {property} has an invalid size"));
    }
    let mut bytes = vec![0u8; required as usize];
    let mut actual = 0u32;
    if unsafe {
        SetupDiGetDeviceRegistryPropertyW(handle, info, property, &mut kind, bytes.as_mut_ptr(), required, &mut actual)
    } == 0 {
        return Err(format!("SetupAPI display property {property} read failed ({})", unsafe { GetLastError() }));
    }
    if actual < 2 || actual as usize > bytes.len() || actual % 2 != 0 {
        return Err(format!("SetupAPI display property {property} returned an invalid length"));
    }
    let units: Vec<u16> = bytes[..actual as usize].chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]])).collect();
    let end = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
    if end == 0 { return Err(format!("SetupAPI display property {property} is empty")); }
    String::from_utf16(&units[..end]).map_err(|_| format!("SetupAPI display property {property} is malformed"))
}

#[cfg(windows)]
fn instance_id(handle: isize, info: &windows_sys::Win32::Devices::DeviceAndDriverInstallation::SP_DEVINFO_DATA) -> Option<String> {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::SetupDiGetDeviceInstanceIdW;
    let mut buffer = [0u16; 4096];
    let mut required = 0u32;
    if unsafe { SetupDiGetDeviceInstanceIdW(handle, info, buffer.as_mut_ptr(), buffer.len() as u32, &mut required) } == 0 {
        return None;
    }
    if required == 0 || required as usize > buffer.len() { return None; }
    Some(String::from_utf16_lossy(&buffer[..required as usize]))
}

#[cfg(windows)]
fn registry_string(handle: isize, info: &windows_sys::Win32::Devices::DeviceAndDriverInstallation::SP_DEVINFO_DATA,
    property: u32) -> Option<String> {
    use windows_sys::Win32::Devices::DeviceAndDriverInstallation::SetupDiGetDeviceRegistryPropertyW;
    let mut kind = 0u32;
    let mut required = 0u32;
    unsafe { SetupDiGetDeviceRegistryPropertyW(handle, info, property, &mut kind, std::ptr::null_mut(), 0, &mut required) };
    if required < 2 || required as usize > 8192 { return None; }
    let mut buffer = vec![0u8; required as usize];
    let mut actual = 0u32;
    if unsafe { SetupDiGetDeviceRegistryPropertyW(handle, info, property, &mut kind, buffer.as_mut_ptr(), buffer.len() as u32, &mut actual) } == 0 {
        return None;
    }
    if actual < 2 || actual as usize > buffer.len() { return None; }
    let units: Vec<u16> = buffer[..actual as usize].chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]])).collect();
    let end = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
    (end > 0).then(|| String::from_utf16_lossy(&units[..end]))
}

fn real_controller(name: &str, pnp: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    if ["basic", "microsoft", "virtual", "remote", "displaylink", "indirect", "mirror"]
        .iter().any(|token| lowered.contains(token)) { return false; }
    pnp.to_ascii_uppercase().contains("VEN_8086") || pnp.to_ascii_uppercase().contains("VEN_1002")
        || pnp.to_ascii_uppercase().contains("VEN_10DE") || lowered.contains("intel")
        || lowered.contains("nvidia") || lowered.contains("radeon") || lowered.contains("geforce")
        || lowered.contains("arc") || lowered.contains("ati")
}

fn parse_hardware_id(value: &str) -> Option<(u16, u16, Option<String>)> {
    static HARDWARE: OnceLock<regex::Regex> = OnceLock::new();
    let regex = HARDWARE.get_or_init(|| regex::Regex::new(r"(?i)VEN_([0-9a-f]{4}).*DEV_([0-9a-f]{4})(?:.*SUBSYS_([0-9a-f]{8}))?").unwrap());
    let captures = regex.captures(value)?;
    let vendor = u16::from_str_radix(&captures[1], 16).ok()?;
    let device = u16::from_str_radix(&captures[2], 16).ok()?;
    let subsys = captures.get(3).map(|capture| capture.as_str().to_ascii_uppercase());
    Some((vendor, device, subsys))
}

fn parse_location(value: &str) -> Option<(u32, u32, u32)> {
    static LOCATION: OnceLock<regex::Regex> = OnceLock::new();
    let regex = LOCATION.get_or_init(|| regex::Regex::new(r"(?i)bus\s*(\d+)\s*,?\s*device\s*(\d+)\s*,?\s*function\s*(\d+)").unwrap());
    let captures = regex.captures(value)?;
    Some((captures[1].parse().ok()?, captures[2].parse().ok()?, captures[3].parse().ok()?))
}

fn pnp_matches_pci(pnp: &str, vendor_id: u16, device_id: u16) -> bool {
    fn component(pnp: &str, marker: &str) -> Option<u16> {
        let normalized = pnp.to_ascii_uppercase();
        let start = normalized.find(marker)? + marker.len();
        let hex = normalized.get(start..start + 4)?;
        if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
        u16::from_str_radix(hex, 16).ok()
    }
    component(pnp, "VEN_") == Some(vendor_id) && component(pnp, "DEV_") == Some(device_id)
}

fn alias_identity_candidate(name: &str, pnp: &str) -> bool {
    if pnp.trim_start().to_ascii_uppercase().starts_with("PCI\\") { return true; }
    let lowered = name.to_ascii_lowercase();
    ["intel", "nvidia", "radeon", "geforce", "arc", "ati"]
        .iter().any(|token| lowered.contains(token))
}

pub fn vendor_name(vendor_id: u16) -> &'static str {
    match vendor_id { 0x8086 => "intel", 0x1002 => "amd", 0x10de => "nvidia", _ => "unknown" }
}

fn normalize_pnp(value: &str) -> String {
    value.chars().filter(|character| !character.is_whitespace() && *character != '\0').collect::<String>().to_ascii_uppercase()
}

#[cfg(windows)]
pub fn registry_memory(vendor_id: u16, device_id: u16, subsys: Option<&str>) -> Option<u64> {
    use std::ffi::c_void;
    #[link(name = "advapi32")]
    extern "system" {
        fn RegGetValueW(key: *mut c_void, subkey: *const u16, value: *const u16, flags: u32,
            value_type: *mut u32, data: *mut c_void, byte_count: *mut u32) -> i32;
    }
    const HKEY_LOCAL_MACHINE: isize = -2147483646;
    const RRF_RT_REG_SZ: u32 = 0x00000002;
    const RRF_RT_REG_QWORD: u32 = 0x00000040;
    let class = "SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}";
    for index in 0..64 {
        let subkey: Vec<u16> = format!("{class}\\{index:04}").encode_utf16().chain(std::iter::once(0)).collect();
        let value: Vec<u16> = "MatchingDeviceId\0".encode_utf16().collect();
        let mut matching = [0u16; 512];
        let mut bytes = std::mem::size_of_val(&matching) as u32;
        let mut kind = 0u32;
        if unsafe { RegGetValueW(HKEY_LOCAL_MACHINE as *mut c_void, subkey.as_ptr(), value.as_ptr(),
            RRF_RT_REG_SZ, &mut kind, matching.as_mut_ptr().cast(), &mut bytes) } != 0 { continue; }
        let end = matching.iter().position(|unit| *unit == 0).unwrap_or(matching.len());
        let text = String::from_utf16_lossy(&matching[..end]).to_ascii_uppercase();
        if !text.contains(&format!("DEV_{device_id:04X}")) { continue; }
        if !text.contains(&format!("VEN_{vendor_id:04X}")) { continue; }
        if let Some(subsys) = subsys { if !text.contains(&format!("SUBSYS_{subsys}")) { continue; } }
        let value: Vec<u16> = "HardwareInformation.qwMemorySize\0".encode_utf16().collect();
        let mut memory = 0u64;
        let mut bytes = std::mem::size_of::<u64>() as u32;
        let mut kind = 0u32;
        if unsafe { RegGetValueW(HKEY_LOCAL_MACHINE as *mut c_void, subkey.as_ptr(), value.as_ptr(),
            RRF_RT_REG_QWORD, &mut kind, (&mut memory as *mut u64).cast(), &mut bytes) } == 0 && memory > 0 {
            return Some(memory);
        }
    }
    None
}

#[cfg(not(windows))]
pub fn registry_memory(_vendor_id: u16, _device_id: u16, _subsys: Option<&str>) -> Option<u64> { None }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hardware_and_location_parsing_is_case_insensitive() {
        assert_eq!(parse_hardware_id("PCI\\VEN_10DE&DEV_2684&SUBSYS_146219da&REV_A1"),
            Some((0x10de, 0x2684, Some("146219DA".into()))));
        assert_eq!(parse_location("PCI bus 1, device 0, function 0"), Some((1, 0, 0)));
        assert_eq!(parse_location("bus 3 device 2 function 1"), Some((3, 2, 1)));
        assert!(parse_hardware_id("not a pci id").is_none());
    }
    #[test]
    fn vendor_and_filter_helpers_match_the_sysinfo_rules() {
        assert_eq!(vendor_name(0x10de), "nvidia");
        assert_eq!(vendor_name(0x1002), "amd");
        assert!(!real_controller("Microsoft Basic Display Adapter", "PCI\\VEN_8086&DEV_1234"));
        assert!(real_controller("NVIDIA GeForce RTX 4070", "PCI\\VEN_10DE&DEV_2684"));
    }
    #[test]
    fn alias_snapshot_keeps_pci_rows_even_when_the_display_name_looks_generic() {
        assert!(alias_identity_candidate(
            "Microsoft Basic Display Adapter", "PCI\\VEN_8086&DEV_E20B",
        ));
        assert!(alias_identity_candidate("Intel Arc B580", "ROOT\\DISPLAY\\0000"));
        assert!(!alias_identity_candidate("Microsoft Remote Display Adapter", "ROOT\\RDP\\0000"));
        assert!(pnp_matches_pci("PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000", 0x8086, 0xe20b));
        assert!(!pnp_matches_pci("PCI\\VEN_1002&DEV_E20B", 0x8086, 0xe20b));
    }
    #[test]
    #[ignore = "live read-only SetupAPI/registry display enumeration"]
    fn live_enumeration_when_requested() {
        for adapter in enumerate() {
            eprintln!("{}", serde_json::to_string(&adapter).unwrap());
        }
    }
}
