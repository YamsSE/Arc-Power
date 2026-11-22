//! Identity-matched registry fallback for Intel's adapter-wide global VRR mode.
//!
//! The production service may call this only after the IGCL global-VRR SET
//! returns `ERROR_INSUFFICIENT_PERMISSIONS` in an elevated host. The adapter
//! key is resolved from `MatchingDeviceId`; enumeration order and conventional
//! `0000` naming are never used as identity. The injected access trait keeps
//! resolver and write-path coverage independent from the live registry.

use serde_json::Value;

const DISPLAY_CLASS_KEY: &str =
    r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
const DISPLAY_3D_KEYS_SUBKEY: &str = "3DKeys";
const GLOBAL_VRR_REGISTRY_VALUE: &str = "Global_VRRWindowedBLT";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RegistryAdapterEntry {
    pub key_path: String,
    pub matching_device_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum VrrRegistryError {
    Query,
    TargetNotFound,
    Write,
}

impl VrrRegistryError {
    pub(crate) fn code(&self) -> &'static str {
        match self {
            Self::Query => "registry-query-failed",
            Self::TargetNotFound => "registry-target-not-found",
            Self::Write => "registry-write-failed",
        }
    }

    pub(crate) fn message(&self) -> &'static str {
        match self {
            Self::Query => "The display adapter registry could not be queried; no VRR value was changed.",
            Self::TargetNotFound => "The matching display adapter registry entry could not be resolved; no VRR value was changed.",
            Self::Write => "The elevated VRR registry write failed; no VRR value was changed.",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct AdapterPciIdentity {
    vendor: String,
    device: String,
    subsystem_tokens: Vec<String>,
}

fn normalize_hex(value: &Value) -> Option<String> {
    let raw = match value {
        Value::String(text) => text.trim().strip_prefix("0x").or_else(|| text.trim().strip_prefix("0X"))
            .unwrap_or(text.trim()).to_owned(),
        Value::Number(number) => format!("{:x}", number.as_u64()?),
        _ => return None,
    };
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    let normalized = raw.trim_start_matches('0').to_ascii_lowercase();
    let normalized = if normalized.is_empty() { "0" } else { &normalized };
    Some(format!("{normalized:0>4}"))
}

impl AdapterPciIdentity {
    fn from_device(device: &Value) -> Option<Self> {
        let vendor = normalize_hex(&device["pciVendorId"])?;
        let id = normalize_hex(&device["pciDeviceId"])?;
        if vendor == "0000" || id == "0000" { return None; }
        let subsystem_vendor = normalize_hex(&device["pciSubsysVendorId"]);
        let subsystem_id = normalize_hex(&device["pciSubsysId"]);
        let subsystem_tokens = match (subsystem_vendor, subsystem_id) {
            (Some(vendor), Some(id)) if vendor != "0000" && id != "0000" => {
                vec![format!("{id}{vendor}"), format!("{vendor}{id}")]
            }
            _ => Vec::new(),
        };
        Some(Self { vendor, device: id, subsystem_tokens })
    }
}

#[derive(Default)]
struct MatchingDeviceIdentity {
    vendor: Option<String>,
    device: Option<String>,
    subsystem: Option<String>,
}

fn matching_component(value: &str, prefix: &str, width: usize) -> Option<String> {
    value.trim().split(['\\', '&']).find_map(|part| {
        let hex = part.strip_prefix(prefix)?;
        if hex.len() != width || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
        Some(hex.to_ascii_lowercase())
    })
}

fn parse_matching_device_id(value: &str) -> MatchingDeviceIdentity {
    let normalized = value.trim().to_ascii_uppercase();
    MatchingDeviceIdentity {
        vendor: matching_component(&normalized, "VEN_", 4),
        device: matching_component(&normalized, "DEV_", 4),
        subsystem: matching_component(&normalized, "SUBSYS_", 8),
    }
}

/// Mirror Electron's `resolveVrrAdapterEntry`: exact subsystem match wins;
/// otherwise only one generic VEN/DEV entry can be used. A target without
/// subsystem data also requires a unique generic entry.
pub(crate) fn resolve_adapter_entry<'a>(
    entries: &'a [RegistryAdapterEntry],
    device: &Value,
) -> Option<&'a RegistryAdapterEntry> {
    let target = AdapterPciIdentity::from_device(device)?;
    let candidates: Vec<_> = entries.iter().filter(|entry| {
        let parsed = parse_matching_device_id(&entry.matching_device_id);
        parsed.vendor.as_deref() == Some(target.vendor.as_str())
            && parsed.device.as_deref() == Some(target.device.as_str())
    }).collect();
    if candidates.is_empty() { return None; }

    if !target.subsystem_tokens.is_empty() {
        let exact: Vec<_> = candidates.iter().copied().filter(|entry| {
            let parsed = parse_matching_device_id(&entry.matching_device_id);
            parsed.subsystem.as_ref().is_some_and(|subsystem| target.subsystem_tokens.contains(subsystem))
        }).collect();
        match exact.as_slice() {
            [entry] => return Some(*entry),
            [] => {}
            _ => return None,
        }
    }

    let generic: Vec<_> = candidates.into_iter().filter(|entry| {
        parse_matching_device_id(&entry.matching_device_id).subsystem.is_none()
    }).collect();
    match generic.as_slice() {
        [entry] => Some(*entry),
        _ => None,
    }
}

pub(crate) trait VrrRegistryAccess {
    fn query_adapters(&mut self) -> Result<Vec<RegistryAdapterEntry>, ()>;
    fn write_dword(&mut self, key_path: &str, value_name: &str, value: u32) -> Result<(), ()>;
}

fn vrr_value_key_path(adapter_key_path: &str) -> String {
    if adapter_key_path.eq_ignore_ascii_case(DISPLAY_3D_KEYS_SUBKEY)
        || adapter_key_path.to_ascii_lowercase().ends_with("\\3dkeys")
    {
        adapter_key_path.to_owned()
    } else {
        format!("{adapter_key_path}\\{DISPLAY_3D_KEYS_SUBKEY}")
    }
}

pub(crate) fn set_global_vrr_mode(
    registry: &mut impl VrrRegistryAccess,
    device: &Value,
    value: u32,
) -> Result<(), VrrRegistryError> {
    let entries = registry.query_adapters().map_err(|_| VrrRegistryError::Query)?;
    let entry = resolve_adapter_entry(&entries, device).ok_or(VrrRegistryError::TargetNotFound)?;
    registry.write_dword(
        &vrr_value_key_path(&entry.key_path),
        GLOBAL_VRR_REGISTRY_VALUE,
        value,
    ).map_err(|_| VrrRegistryError::Write)
}

#[cfg(windows)]
pub(crate) struct SystemVrrRegistry;

#[cfg(windows)]
impl VrrRegistryAccess for SystemVrrRegistry {
    fn query_adapters(&mut self) -> Result<Vec<RegistryAdapterEntry>, ()> {
        use winreg::{enums::{HKEY_LOCAL_MACHINE, KEY_READ}, RegKey};

        let root = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey_with_flags(DISPLAY_CLASS_KEY, KEY_READ)
            .map_err(|_| ())?;
        let mut entries = Vec::new();
        for subkey in root.enum_keys() {
            let subkey = subkey.map_err(|_| ())?;
            let Ok(adapter) = root.open_subkey_with_flags(&subkey, KEY_READ) else { continue; };
            let Ok(matching_device_id) = adapter.get_value::<String, _>("MatchingDeviceId") else { continue; };
            entries.push(RegistryAdapterEntry {
                key_path: format!(r"{DISPLAY_CLASS_KEY}\{subkey}"),
                matching_device_id,
            });
        }
        Ok(entries)
    }

    fn write_dword(&mut self, key_path: &str, value_name: &str, value: u32) -> Result<(), ()> {
        use winreg::{enums::{HKEY_LOCAL_MACHINE, KEY_CREATE_SUB_KEY, KEY_SET_VALUE}, RegKey};

        let (key, _) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .create_subkey_with_flags(key_path, KEY_CREATE_SUB_KEY | KEY_SET_VALUE)
            .map_err(|_| ())?;
        key.set_value(value_name, &value).map_err(|_| ())
    }
}

#[cfg(not(windows))]
pub(crate) struct SystemVrrRegistry;

#[cfg(not(windows))]
impl VrrRegistryAccess for SystemVrrRegistry {
    fn query_adapters(&mut self) -> Result<Vec<RegistryAdapterEntry>, ()> { Err(()) }
    fn write_dword(&mut self, _key_path: &str, _value_name: &str, _value: u32) -> Result<(), ()> { Err(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn adapter(key: &str, matching_device_id: &str) -> RegistryAdapterEntry {
        RegistryAdapterEntry { key_path: key.into(), matching_device_id: matching_device_id.into() }
    }

    fn device(subsystem_vendor: Option<u64>, subsystem_id: Option<u64>) -> Value {
        json!({
            "pciVendorId": "0x00008086",
            "pciDeviceId": "0x000056a0",
            "pciSubsysVendorId": subsystem_vendor,
            "pciSubsysId": subsystem_id,
        })
    }

    #[test]
    fn exact_subsystem_match_wins_over_generic_and_other_board_entries() {
        let entries = [
            adapter(r"HKLM\Class\0000", r"PCI\VEN_8086&DEV_56A0"),
            adapter(r"HKLM\Class\0001", r"PCI\VEN_8086&DEV_56A0&SUBSYS_12345678"),
            adapter(r"HKLM\Class\0002", r"PCI\VEN_8086&DEV_56A0&SUBSYS_60011849&REV_01"),
        ];
        assert_eq!(resolve_adapter_entry(&entries, &device(Some(0x1849), Some(0x6001))), Some(&entries[2]));
    }

    #[test]
    fn ambiguous_exact_and_missing_or_ambiguous_generic_targets_fail_closed() {
        let exact = [
            adapter(r"HKLM\Class\0001", r"PCI\VEN_8086&DEV_56A0&SUBSYS_60011849"),
            adapter(r"HKLM\Class\0002", r"PCI\VEN_8086&DEV_56A0&SUBSYS_18496001"),
        ];
        assert!(resolve_adapter_entry(&exact, &device(Some(0x1849), Some(0x6001))).is_none());

        let generic = [adapter(r"HKLM\Class\0000", r"PCI\VEN_8086&DEV_56A0")];
        assert_eq!(resolve_adapter_entry(&generic, &device(Some(0x1849), Some(0x6001))), Some(&generic[0]));
        assert_eq!(resolve_adapter_entry(&generic, &device(None, None)), Some(&generic[0]));

        let ambiguous = [
            adapter(r"HKLM\Class\0000", r"PCI\VEN_8086&DEV_56A0"),
            adapter(r"HKLM\Class\0001", r"PCI\VEN_8086&DEV_56A0"),
        ];
        assert!(resolve_adapter_entry(&ambiguous, &device(None, None)).is_none());
        let absent = [adapter(r"HKLM\Class\0000", r"PCI\VEN_10DE&DEV_2684")];
        assert!(resolve_adapter_entry(&absent, &device(None, None)).is_none());
    }

    #[test]
    fn subsystem_match_is_order_independent_and_requires_both_ids() {
        let first = adapter(r"HKLM\Class\0002", r"PCI\VEN_8086&DEV_56A0&SUBSYS_60011849");
        let second = adapter(r"HKLM\Class\0003", r"PCI\VEN_8086&DEV_56A0&SUBSYS_12345678");
        assert_eq!(resolve_adapter_entry(&[second.clone(), first.clone()], &device(Some(0x1849), Some(0x6001))), Some(&first));
        assert_eq!(resolve_adapter_entry(&[first.clone(), second.clone()], &device(Some(0x1849), Some(0x6001))), Some(&first));
        assert!(resolve_adapter_entry(&[first, second], &device(Some(0x1849), None)).is_none());
    }

    #[derive(Default)]
    struct FakeRegistry {
        entries: Vec<RegistryAdapterEntry>,
        query_fails: bool,
        write_fails: bool,
        writes: Vec<(String, String, u32)>,
    }

    impl VrrRegistryAccess for FakeRegistry {
        fn query_adapters(&mut self) -> Result<Vec<RegistryAdapterEntry>, ()> {
            if self.query_fails { Err(()) } else { Ok(self.entries.clone()) }
        }

        fn write_dword(&mut self, key_path: &str, value_name: &str, value: u32) -> Result<(), ()> {
            self.writes.push((key_path.into(), value_name.into(), value));
            if self.write_fails { Err(()) } else { Ok(()) }
        }
    }

    #[test]
    fn writer_targets_resolved_adapter_and_exact_value_without_key_order_assumptions() {
        let mut registry = FakeRegistry {
            entries: vec![
                adapter(r"HKLM\Class\0000", r"PCI\VEN_8086&DEV_56A0&SUBSYS_12345678"),
                adapter(r"HKLM\Class\0007", r"PCI\VEN_8086&DEV_56A0&SUBSYS_60011849"),
            ],
            ..FakeRegistry::default()
        };
        set_global_vrr_mode(&mut registry, &device(Some(0x1849), Some(0x6001)), 2).unwrap();
        assert_eq!(registry.writes, vec![(
            r"HKLM\Class\0007\3DKeys".into(),
            GLOBAL_VRR_REGISTRY_VALUE.into(),
            2,
        )]);
    }

    #[test]
    fn query_target_and_write_failures_are_distinct_and_do_not_write_ambiguous_keys() {
        let mut registry = FakeRegistry { query_fails: true, ..FakeRegistry::default() };
        assert_eq!(set_global_vrr_mode(&mut registry, &device(None, None), 1), Err(VrrRegistryError::Query));
        assert!(registry.writes.is_empty());

        let mut registry = FakeRegistry {
            entries: vec![adapter(r"HKLM\Class\0001", r"PCI\VEN_8086&DEV_56A0&SUBSYS_12345678")],
            ..FakeRegistry::default()
        };
        assert_eq!(set_global_vrr_mode(&mut registry, &device(Some(0x1849), Some(0x6001)), 1), Err(VrrRegistryError::TargetNotFound));
        assert!(registry.writes.is_empty());

        let mut registry = FakeRegistry {
            entries: vec![adapter(r"HKLM\Class\0007", r"PCI\VEN_8086&DEV_56A0&SUBSYS_60011849")],
            write_fails: true,
            writes: Vec::new(),
            query_fails: false,
        };
        assert_eq!(set_global_vrr_mode(&mut registry, &device(Some(0x1849), Some(0x6001)), 0), Err(VrrRegistryError::Write));
        assert_eq!(registry.writes.len(), 1);
    }
}
