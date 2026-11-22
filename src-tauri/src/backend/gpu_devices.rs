//! Read-only GPU inventory mapped to the existing DeviceInfo contract.
//! Enumeration is opt-in: `list_devices` is only called by the live probe or
//! after the caller supplies the trusted IntelControlLib.dll path.
use super::igcl_read_only::{AdapterInfo, ReadOnlyIgcl};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const GDDR6_TOKENS: &[&str] = &["a310", "a350", "a370", "a380", "a580", "a750", "a770", "b50", "b570", "b580", "b60"];

#[cfg(windows)]
pub(crate) fn registry_vram_bytes(adapter: &AdapterInfo) -> Option<u64> {
    let subsys = (adapter.pci_subsys_id != 0 && adapter.pci_subsys_vendor_id != 0)
        .then(|| format!("{:04X}{:04X}", adapter.pci_subsys_id, adapter.pci_subsys_vendor_id));
    super::os_gpu_inventory::registry_memory(adapter.pci_vendor_id as u16, adapter.pci_device_id as u16, subsys.as_deref())
}

#[cfg(not(windows))]
fn registry_vram_bytes(_adapter: &AdapterInfo) -> Option<u64> { None }

fn strip_vram_suffix(name: &str) -> String {
    regex::Regex::new(r"(?i)\s+\d+\s*GB(?:\s+\S+)?$").unwrap().replace(name, "").into_owned()
}

pub(crate) fn is_integrated_style(name: &str) -> bool {
    let name = strip_vram_suffix(name);
    let has = |pattern: &str| regex::Regex::new(pattern).unwrap().is_match(&name);
    if has(r"(?i)\b(?:iris|uhd|hd graphics|xe graphics)\b") { return true; }
    if has(r"(?i)\barc\b") && has(r"(?i)\b(?:[ab]\d{2,4}m|b(?:370|390)|mobile|integrated|igpu)\b") { return true; }
    if has(r"(?i)\bintel(?:\s*\([^)]*\))?\s+graphics\b") && !has(r"(?i)\barc\b") { return true; }
    has(r"(?i)\barc\b") && !has(r"(?i)\b(?:a\d{3}|b\d{2,3}|pro)\b")
}

pub(crate) fn is_mobile(name: &str) -> bool {
    regex::Regex::new(r"(?i)\b(?:[ab]\d{3,4}m|b(?:370|390)|mobile)\b").unwrap().is_match(name)
}

fn mem_type(name: &str) -> Value {
    let tokens: std::collections::HashSet<String> = regex::Regex::new(r"[a-z0-9]+").unwrap()
        .find_iter(&name.to_lowercase()).map(|token| token.as_str().to_owned()).collect();
    if GDDR6_TOKENS.iter().any(|token| tokens.contains(*token)) { json!("GDDR6") } else { Value::Null }
}

fn format_device_name(name: &str, vram_bytes: Option<u64>) -> String {
    let Some(bytes) = vram_bytes.filter(|bytes| *bytes > 0) else { return name.to_owned(); };
    if bytes >= 1024 * 1024 * 1024 {
        let gib = (bytes + (1024 * 1024 * 1024) - 1) / (1024 * 1024 * 1024);
        let suffix = match mem_type(name) { Value::String(value) => format!(" {value}"), _ => String::new() };
        format!("{name} {gib}GB{suffix}")
    } else {
        format!("{name} {} MB", bytes / (1024 * 1024))
    }
}

/// Decode IGCL's little-endian 8-byte device id into the Windows LUID pair.
/// The string is formatted byte-by-byte from `to_le_bytes()`, so the first
/// four bytes are the low part and the next four are the high part.
fn luid_parts(text: &str) -> Option<(u32, u32)> {
    if text.len() != 16 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    let mut bytes = [0u8; 8];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16).ok()?;
    }
    let value = u64::from_le_bytes(bytes);
    Some(((value >> 32) as u32, value as u32))
}

pub(crate) fn device_key(device: &Value) -> String {
    let vendor = device["pciVendorId"].as_str().unwrap_or("").to_lowercase();
    let pci = device["pciDeviceId"].as_str().unwrap_or("").to_lowercase();
    let bus = device["bdf"]["bus"].as_i64().unwrap_or(-1);
    let slot = device["bdf"]["device"].as_i64().unwrap_or(-1);
    let function = device["bdf"]["function"].as_i64().unwrap_or(-1);
    // A zeroed adapter_bdf is the binding's "not supplied" shape.
    let has_bdf = bus != 0 || slot != 0 || function != 0;
    format!("pci:{vendor}:{pci}@{}:{}.{}", if has_bdf { bus } else { -1 },
        if has_bdf { slot } else { -1 }, if has_bdf { function } else { -1 })
}

/// Map IGCL adapters to the renderer's exact listDevices shape. `vram` is
/// injected so the sysinfo owner can supply the registry value; without it
/// the plain adapter name is preserved.
pub fn map_adapters(adapters: &[AdapterInfo], vram: impl Fn(&AdapterInfo) -> Option<u64>) -> Value {
    let mut mapped: Vec<(bool, String, usize, Value)> = Vec::new();
    for (index, adapter) in adapters.iter().enumerate() {
        let name = adapter.name.trim().to_owned();
        let integrated = (adapter.graphics_adapter_properties & 1) != 0 || is_integrated_style(&name);
        let vram_bytes = vram(adapter);
        let luid = adapter.luid.as_deref().and_then(luid_parts)
            .map(|(high, low)| format!("0x{high:08x}:0x{low:08x}"));
        let mut device = json!({
            "id": 0,
            "name": format_device_name(&name, vram_bytes),
            "type": "GRAPHICS",
            "pciVendorId": format!("0x{:08x}", adapter.pci_vendor_id),
            "pciDeviceId": format!("0x{:08x}", adapter.pci_device_id),
            "revId": adapter.rev_id,
            "bdf": {"bus": adapter.bdf.bus, "device": adapter.bdf.device, "function": adapter.bdf.function},
            "luid": luid,
            "driverVersion": adapter.driver_version,
            "graphicsClockMHz": adapter.graphics_clock_mhz,
            "numXeCores": adapter.num_xe_cores,
            "integrated": integrated,
            "mobile": is_mobile(&name),
            "vramBytes": vram_bytes,
            "sharedMemoryBytes": Value::Null,
            "sharedMemorySource": Value::Null,
            "memType": mem_type(&name),
            "pciSubsysVendorId": if adapter.pci_subsys_vendor_id == 0 { Value::Null } else { json!(adapter.pci_subsys_vendor_id) },
            "pciSubsysId": if adapter.pci_subsys_id == 0 { Value::Null } else { json!(adapter.pci_subsys_id) },
            "deviceKey": Value::Null,
        });
        let key = device_key(&device);
        device["deviceKey"] = json!(key);
        mapped.push((integrated, key, index, device));
    }
    // Discrete first, then stable hardware key, then enumeration order.
    mapped.sort_by(|left, right| left.0.cmp(&right.0).then(left.1.cmp(&right.1)).then(left.2.cmp(&right.2)));
    Value::Array(mapped.into_iter().enumerate().map(|(id, (_, _, _, mut device))| {
        device["id"] = json!(id);
        device
    }).collect())
}

pub fn list_devices(dll_path: &Path) -> Result<Value, String> {
    let mut igcl = ReadOnlyIgcl::load(dll_path).map_err(|error| error.to_string())?;
    let adapters = match igcl.enumerate_adapters() {
        Ok(adapters) => adapters,
        Err(error) => { let _ = igcl.close(); return Err(error.to_string()); }
    };
    igcl.close().map_err(|error| error.to_string())?;
    Ok(map_adapters(&adapters, registry_vram_bytes))
}

/// IGCL rows keep their existing ids; OS-only rows are appended afterwards.
/// This preserves native control/capability routing for Intel adapters while
/// making non-Intel and hybrid inventory visible to the renderer.
pub fn list_devices_merged() -> Value {
    let mut rows: Vec<Value> = locate_dll().and_then(|path| list_devices(&path).ok())
        .and_then(|devices| devices.as_array().cloned()).unwrap_or_default();
    let append_all = rows.is_empty();
    let mut os_rows = Vec::new();
    for adapter in super::os_gpu_inventory::enumerate() {
        if !append_all && adapter.vendor_id == 0x8086 { continue; }
        if rows.iter().any(|row| os_matches_igcl(&adapter, row)) { continue; }
        os_rows.push(os_row(&adapter, rows.len() + os_rows.len()));
    }
    rows.extend(os_rows);
    let mut next_index: HashMap<String, u32> = HashMap::new();
    for row in rows.iter_mut() {
        let vendor = row.get("gpuVendor").and_then(Value::as_str).map(str::to_owned)
            .unwrap_or_else(|| super::os_gpu_inventory::vendor_name(vendor_id_of(row)).to_owned());
        let next = next_index.entry(vendor.clone()).or_insert(0);
        row["gpuVendor"] = json!(vendor);
        row["vendorIndex"] = json!(*next);
        *next += 1;
    }
    let counts: HashMap<String, u32> = rows.iter().filter_map(|row| {
        row.get("gpuVendor").and_then(Value::as_str).map(str::to_owned)
    }).fold(HashMap::new(), |mut counts, vendor| { *counts.entry(vendor).or_insert(0) += 1; counts });
    for row in rows.iter_mut() {
        let count = row.get("gpuVendor").and_then(Value::as_str)
            .and_then(|vendor| counts.get(vendor)).copied().unwrap_or(1);
        row["vendorCount"] = json!(count);
    }
    Value::Array(rows)
}

fn vendor_id_of(row: &Value) -> u16 {
    row.get("pciVendorId").and_then(Value::as_str)
        .and_then(|value| u32::from_str_radix(value.trim_start_matches("0x"), 16).ok())
        .map(|value| value as u16)
        .unwrap_or(0)
}

fn pci_device_id_of(row: &Value) -> Option<u16> {
    row.get("pciDeviceId").and_then(Value::as_str)
        .and_then(|value| u32::from_str_radix(value.trim_start_matches("0x"), 16).ok())
        .map(|value| value as u16)
}

fn os_matches_igcl(adapter: &super::os_gpu_inventory::OsAdapter, row: &Value) -> bool {
    if vendor_id_of(row) != adapter.vendor_id { return false; }
    if pci_device_id_of(row) != Some(adapter.device_id) { return false; }
    let row_bdf = (row["bdf"]["bus"].as_u64(), row["bdf"]["device"].as_u64(), row["bdf"]["function"].as_u64());
    if let (Some((bus, device, function)), (Some(row_bus), Some(row_device), Some(row_function))) = (adapter.bdf, row_bdf) {
        return bus as u64 == row_bus && device as u64 == row_device && function as u64 == row_function;
    }
    true
}

fn os_row(adapter: &super::os_gpu_inventory::OsAdapter, id: usize) -> Value {
    let bdf = adapter.bdf.map(|(bus, device, function)| json!({
        "bus": bus, "device": device, "function": function,
    })).unwrap_or(Value::Null);
    let key = format!("pnp:{}", adapter.pnp);
    let mut keys = vec![key.clone()];
    if let Some((bus, device, function)) = adapter.bdf {
        keys.push(format!("pci:0x{:08x}:0x{:08x}@{}:{}.{}", adapter.vendor_id, adapter.device_id, bus, device, function));
    }
    let driver_version = Value::String(String::new());
    json!({
        "id": id,
        "name": adapter.name,
        "type": "GRAPHICS",
        "pciVendorId": format!("0x{:08x}", adapter.vendor_id),
        "pciDeviceId": format!("0x{:08x}", adapter.device_id),
        "revId": 0,
        "bdf": bdf,
        "luid": Value::Null,
        "driverVersion": driver_version,
        "graphicsClockMHz": 0,
        "numXeCores": 0,
        "integrated": adapter.integrated,
        "mobile": adapter.mobile,
        "synthetic": true,
        "backendKind": "os",
        "deviceKey": key,
        "deviceKeys": keys,
        "pnpDeviceId": adapter.pnp,
        "gpuVendor": adapter.gpu_vendor,
        "vendorIndex": 0,
        "vendorCount": 0,
        "vramBytes": adapter.vram_bytes,
        "sharedMemoryBytes": Value::Null,
        "sharedMemorySource": Value::Null,
        "memType": Value::Null,
        "pciSubsysVendorId": Value::Null,
        "pciSubsysId": Value::Null,
        "displayActive": Value::Null,
        "osController": {
            "name": adapter.name,
            "vramBytes": adapter.vram_bytes,
            "sharedMemoryBytes": Value::Null,
            "sharedMemorySource": Value::Null,
            "pnpDeviceId": adapter.pnp,
            "driverVersion": Value::Null,
            "displayActive": Value::Null,
            "rebarActive": Value::Null,
            "luid": Value::Null,
        },
        "osLuid": Value::Null,
    })
}

fn driver_store_dll() -> Option<PathBuf> {
    let root = Path::new(r"C:\Windows\System32\DriverStore\FileRepository");
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        if !entry.file_name().to_string_lossy().starts_with("iigd_dch_d.inf_amd64_") { continue; }
        let path = entry.path().join("IntelControlLib.dll");
        if !path.is_file() { continue; }
        let modified = std::fs::metadata(&path).and_then(|metadata| metadata.modified()).ok();
        match (modified, &best) {
            (Some(modified), Some((best_time, _))) if modified <= *best_time => {}
            (Some(modified), _) => best = Some((modified, path)),
            (None, None) => best = Some((std::time::UNIX_EPOCH, path)),
            (None, Some(_)) => {}
        }
    }
    best.map(|(_, path)| path)
}

pub fn locate_dll() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("ARC_POWER_IGCL_DLL") { candidates.push(PathBuf::from(path)); }
    if let Some(path) = driver_store_dll() { candidates.push(path); }
    if let Some(root) = std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf)) {
        candidates.push(root.join("compatibility-backend/resources/app.asar.unpacked/src/main/backend/igcl2023/IntelControlLib.dll"));
        candidates.push(root.join("resources/app.asar.unpacked/src/main/backend/igcl2023/IntelControlLib.dll"));
        candidates.push(root.join("compatibility-backend/src/main/backend/igcl2023/IntelControlLib.dll"));
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
        .join("src/main/backend/igcl2023/IntelControlLib.dll"));
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::igcl_read_only::AdapterBdf;
    fn adapter(name: &str, device: u32, integrated: bool) -> AdapterInfo {
        AdapterInfo { index: 0, name: name.into(), device_type: 1, pci_vendor_id: 0x8086,
            pci_device_id: device, rev_id: 8, pci_subsys_id: 0, pci_subsys_vendor_id: 0,
            bdf: AdapterBdf { bus: 3, device: 0, function: 0 },
            luid: Some("0100000000000000".into()), driver_version: "0x0000000000000001".into(),
            graphics_adapter_properties: if integrated { 1 } else { 0 },
            graphics_clock_mhz: 2400, num_xe_cores: 512 }
    }
    #[test]
    fn os_only_rows_keep_the_renderer_inventory_shape() {
        let adapter = crate::backend::os_gpu_inventory::OsAdapter {
            name: "NVIDIA GeForce RTX 4070".into(),
            pnp: "PCI\\VEN_10DE&DEV_2684&SUBSYS_146219DA".into(),
            vendor_id: 0x10de, device_id: 0x2684, subsys: Some("146219DA".into()),
            bdf: Some((1, 0, 0)), vram_bytes: Some(12 * 1024 * 1024 * 1024),
            gpu_vendor: "nvidia", integrated: false, mobile: false,
        };
        let row = os_row(&adapter, 3);
        assert_eq!(row["id"], 3);
        assert_eq!(row["synthetic"], true);
        assert_eq!(row["backendKind"], "os");
        assert_eq!(row["deviceKey"], "pnp:PCI\\VEN_10DE&DEV_2684&SUBSYS_146219DA");
        assert_eq!(row["bdf"], json!({"bus":1,"device":0,"function":0}));
        assert_eq!(row["gpuVendor"], "nvidia");
        assert_eq!(row["vendorIndex"], 0);
        assert_eq!(row["osController"]["pnpDeviceId"], adapter.pnp);
        assert_eq!(row["deviceKeys"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn os_rows_match_igcl_identity_by_pci_and_bdf() {
        let adapter = crate::backend::os_gpu_inventory::OsAdapter {
            name: "Intel Arc".into(), pnp: "PCI\\VEN_8086&DEV_56A0".into(),
            vendor_id: 0x8086, device_id: 0x56a0, subsys: None, bdf: Some((3, 0, 0)),
            vram_bytes: None, gpu_vendor: "intel", integrated: false, mobile: false,
        };
        assert!(os_matches_igcl(&adapter, &json!({"pciVendorId":"0x00008086","pciDeviceId":"0x000056a0","bdf":{"bus":3,"device":0,"function":0}})));
        assert!(!os_matches_igcl(&adapter, &json!({"pciVendorId":"0x00008086","pciDeviceId":"0x000056a0","bdf":{"bus":4,"device":0,"function":0}})));
        assert!(!os_matches_igcl(&adapter, &json!({"pciVendorId":"0x000010de","pciDeviceId":"0x000056a0"})));
    }
    #[test]
    #[ignore = "live read-only IGCL + SetupAPI inventory"]
    fn live_merged_inventory_when_requested() {
        let devices = list_devices_merged();
        eprintln!("{}", serde_json::to_string_pretty(&devices).unwrap());
        assert!(devices.as_array().is_some_and(|devices| !devices.is_empty()));
    }
    #[test]
    fn maps_and_sorts_discrete_before_integrated() {
        let adapters = vec![adapter("Intel(R) UHD Graphics 770", 0x4680, true), adapter("Intel(R) Arc(TM) A770 Graphics", 0x56a0, false)];
        let devices = map_adapters(&adapters, |adapter| if adapter.pci_device_id == 0x56a0 { Some(16 * 1024 * 1024 * 1024) } else { None });
        let devices = devices.as_array().unwrap();
        assert_eq!(devices.len(), 2);
        assert_eq!(devices[0]["id"], json!(0));
        assert_eq!(devices[0]["name"], json!("Intel(R) Arc(TM) A770 Graphics 16GB GDDR6"));
        assert_eq!(devices[0]["integrated"], json!(false));
        assert_eq!(devices[0]["memType"], json!("GDDR6"));
        assert_eq!(devices[0]["deviceKey"], json!("pci:0x00008086:0x000056a0@3:0.0"));
        assert_eq!(devices[0]["luid"], json!("0x00000000:0x00000001"));
        assert_eq!(devices[1]["id"], json!(1));
        assert_eq!(devices[1]["integrated"], json!(true));
        assert_eq!(devices[1]["memType"], Value::Null);
    }
    #[test]
    fn zeroed_bdf_and_subsystem_ids_preserve_the_unknown_shape() {
        let mut adapter = adapter("Intel(R) Arc(TM) A770 Graphics", 0x56a0, false);
        adapter.bdf = AdapterBdf { bus: 0, device: 0, function: 0 };
        let devices = map_adapters(&[adapter], |_| None);
        assert_eq!(devices[0]["deviceKey"], json!("pci:0x00008086:0x000056a0@-1:-1.-1"));
        assert_eq!(devices[0]["pciSubsysVendorId"], Value::Null);
        assert_eq!(devices[0]["pciSubsysId"], Value::Null);
    }
    #[test]
    #[ignore = "live read-only IGCL enumeration; requires the trusted IntelControlLib.dll"]
    fn live_enumeration_when_requested() {
        let path = locate_dll().expect("IGCL DLL not found");
        let devices = list_devices(&path).expect("IGCL enumeration failed");
        eprintln!("{}", serde_json::to_string_pretty(&devices).unwrap());
    }
}
