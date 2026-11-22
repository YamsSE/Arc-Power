//! Physical GPU identity proof for multi-session apply preflight.
//! A numeric inventory index alone is not stable across re-enumeration.
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ApplyIdentity {
    pub(crate) device_key: String,
    pub(crate) vendor: u32,
    pub(crate) device: u32,
    pub(crate) bus: u32,
    pub(crate) slot: u32,
    pub(crate) function: u32,
    pub(crate) luid: Option<String>,
}

impl ApplyIdentity {
}

fn pci_id(value: &Value) -> Option<u32> {
    let text = value.as_str()?.strip_prefix("0x")?;
    if text.len() != 8 || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    u32::from_str_radix(text, 16).ok().filter(|id| *id != 0 && *id <= 0xffff)
}

pub(crate) fn identity_from_row(row: &Value) -> Result<ApplyIdentity, String> {
    let vendor = pci_id(&row["pciVendorId"]).ok_or("GPU vendor identity is unavailable")?;
    let device = pci_id(&row["pciDeviceId"]).ok_or("GPU device identity is unavailable")?;
    let coordinate = |name: &str, max: u64| row["bdf"][name].as_u64().filter(|n| *n <= max).map(|n| n as u32);
    let bus = coordinate("bus", 255).ok_or("GPU PCI address is unavailable")?;
    let slot = coordinate("device", 31).ok_or("GPU PCI address is unavailable")?;
    let function = coordinate("function", 7).ok_or("GPU PCI address is unavailable")?;
    if (bus, slot, function) == (0, 0, 0) { return Err("GPU PCI address is unavailable".into()); }
    let key = row["deviceKey"].as_str().filter(|key| !key.is_empty()).ok_or("GPU key is unavailable")?;
    if key != super::gpu_devices::device_key(row) { return Err("GPU key does not match physical identity".into()); }
    let luid = row["luid"].as_str().filter(|value| !value.is_empty()).map(str::to_owned);
    Ok(ApplyIdentity { device_key: key.into(), vendor, device, bus, slot, function, luid })
}

pub(crate) fn ensure_same_target(expected: &ApplyIdentity, current: &ApplyIdentity) -> Result<(), String> {
    if expected.device_key != current.device_key || expected.vendor != current.vendor
        || expected.device != current.device || expected.bus != current.bus
        || expected.slot != current.slot || expected.function != current.function
        || expected.luid.as_ref().is_some_and(|value| current.luid.as_ref() != Some(value))
    { return Err("GPU identity changed during apply; refresh and try again".into()); }
    Ok(())
}

/// Resolve the expected device only when exactly one inventory row has its
/// physical identity. Malformed rows cannot establish a match.
pub(crate) fn unique_target_index(rows: &[Value], expected: &ApplyIdentity) -> Result<usize, String> {
    let mut found = rows.iter().enumerate().filter_map(|(index, row)| {
        identity_from_row(row).ok().filter(|current| current.device_key == expected.device_key).map(|current| (index, current))
    });
    let (index, current) = found.next().ok_or("GPU identity no longer resolves")?;
    if found.next().is_some() { return Err("GPU identity is ambiguous".into()); }
    ensure_same_target(expected, &current)?;
    Ok(index)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn row(bus: u32) -> Value { json!({"pciVendorId":"0x00008086", "pciDeviceId":"0x0000e20b",
        "deviceKey":format!("pci:0x00008086:0x0000e20b@{bus}:0.0"),
        "bdf":{"bus":bus,"device":0,"function":0}, "luid":"0x00000001:0x00000002"}) }
    #[test]
    fn rejects_missing_ambiguous_or_changed_identity() {
        let expected = identity_from_row(&row(3)).unwrap();
        assert!(identity_from_row(&row(0)).is_err());
        assert!(ensure_same_target(&expected, &identity_from_row(&row(4)).unwrap()).is_err());
        assert!(unique_target_index(&[row(3), row(3)], &expected).is_err());
        assert_eq!(unique_target_index(&[row(4), row(3)], &expected).unwrap(), 1);
        let mut spoof = row(3); spoof["deviceKey"] = json!("other");
        assert!(identity_from_row(&spoof).is_err());
    }
    #[test]
    fn rejects_conflicting_luid_even_when_pci_address_matches() {
        let expected = identity_from_row(&row(3)).unwrap();
        let mut changed = row(3); changed["luid"] = json!("0x00000003:0x00000004");
        assert!(ensure_same_target(&expected, &identity_from_row(&changed).unwrap()).is_err());
        assert!(unique_target_index(&[row(3), changed], &expected).is_err());
        let mut missing = row(3); missing["luid"] = Value::Null;
        assert!(ensure_same_target(&expected, &identity_from_row(&missing).unwrap()).is_err());
    }
}
