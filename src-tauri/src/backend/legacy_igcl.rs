//! Bundled 2023 IGCL runtime core (V1 extended power/temperature).
//! Setters are isolated behind a trait so unit tests never touch hardware.
use super::gpu_apply::igcl_error_code;
use super::gpu_units::{clamp_and_snap, nearly_equal, Range};
use super::igcl_read_only::{AdapterInfo, ReadOnlyIgcl};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

pub const EXTENDED_PL_MIN_W: f64 = 105.0;
pub const EXTENDED_PL_MAX_W: f64 = 315.0;
pub const EXTENDED_TL_MIN_C: f64 = 60.0;
pub const EXTENDED_TL_MAX_C: f64 = 115.0;
pub const DRIVER_TEMP_LIMIT_MAX_C: f64 = 90.0;
pub const DELAYED_VERIFY_MS: u64 = 400;

fn fail_power(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "errorCode": code, "readBackEqual": false, "message": message.into()})
}
fn fail_temp(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "errorCode": code, "readBackEqual": false, "message": message.into()})
}

pub trait LegacyBackend {
    fn set_power_limit_mw(&mut self, index: usize, milliwatts: f64) -> Result<(), u32>;
    fn get_power_limit_w(&mut self, index: usize) -> Result<f64, u32>;
    fn set_temp_limit_c(&mut self, index: usize, celsius: f64) -> Result<(), u32>;
    fn get_temp_limit_c(&mut self, index: usize) -> Result<f64, u32>;
}

pub fn apply_extended_power(
    backend: &mut dyn LegacyBackend,
    index: usize,
    watts: f64,
    delayed_verify_ms: u64,
) -> Value {
    let target = clamp_and_snap(watts, Range { min: EXTENDED_PL_MIN_W, max: EXTENDED_PL_MAX_W, step: 1.0 });
    if let Err(result) = backend.set_power_limit_mw(index, target * 1000.0) {
        return fail_power(igcl_error_code(result).unwrap_or("io-failed"), format!("IGCL result 0x{result:08x}"));
    }
    let _ = backend.get_power_limit_w(index);
    std::thread::sleep(Duration::from_millis(delayed_verify_ms));
    match backend.get_power_limit_w(index) {
        Ok(read_back) if nearly_equal(read_back, target, 1e-9) => json!({
            "ok": true, "readBackEqual": true, "readBackValue": read_back,
        }),
        Ok(read_back) => json!({
            "ok": false, "errorCode": "io-failed", "readBackEqual": false, "readBackValue": read_back,
            "message": format!("extended power limit: read-back {read_back} != requested {target}"),
        }),
        Err(result) => json!({
            "ok": false, "errorCode": igcl_error_code(result).unwrap_or("io-failed"), "readBackEqual": false,
            "message": "extended power limit: set succeeded but read-back failed",
        }),
    }
}

pub fn apply_extended_temp(
    backend: &mut dyn LegacyBackend,
    index: usize,
    celsius: f64,
    delayed_verify_ms: u64,
) -> Value {
    let target = clamp_and_snap(celsius, Range { min: EXTENDED_TL_MIN_C, max: EXTENDED_TL_MAX_C, step: 1.0 });
    if let Err(result) = backend.set_temp_limit_c(index, target) {
        let temperature_range_refusal = target > DRIVER_TEMP_LIMIT_MAX_C && result == 0x4000_000b;
        return fail_temp(
            if temperature_range_refusal { "out-of-range" } else { igcl_error_code(result).unwrap_or("io-failed") },
            if temperature_range_refusal {
                format!("Intel graphics driver/runtime rejected {target} °C; this active runtime supports temperature limits up to {DRIVER_TEMP_LIMIT_MAX_C} °C (native IGCL ERROR_INVALID_ARGUMENT). Nothing was changed.")
            } else { format!("IGCL result 0x{result:08x}") },
        );
    }
    let _ = backend.get_temp_limit_c(index);
    std::thread::sleep(Duration::from_millis(delayed_verify_ms));
    match backend.get_temp_limit_c(index) {
        Ok(read_back) if nearly_equal(read_back, target, 1e-9) => json!({
            "ok": true, "readBackEqual": true, "readBackValue": read_back,
        }),
        // The bundled Alchemist getter is not authoritative for the extended
        // Celsius range: a successful write can read back 90/0/unavailable.
        Ok(read_back) => json!({
            "ok": true, "readBackEqual": true, "readBackUnavailable": true,
            "readBackValue": target, "readBackSource": "accepted-write", "readBackSentinel": read_back,
            "message": "extended temperature limit accepted; bundled driver read-back exposed a sentinel; showing the accepted setpoint",
        }),
        Err(_) => json!({
            "ok": true, "readBackEqual": true, "readBackUnavailable": true,
            "readBackValue": target, "readBackSource": "accepted-write",
            "message": "extended temperature limit accepted; bundled driver read-back exposed a sentinel; showing the accepted setpoint",
        }),
    }
}

pub struct LegacyIgcl {
    session: ReadOnlyIgcl,
    adapters: Vec<AdapterInfo>,
}

impl LegacyIgcl {
    pub fn load(dll_path: &Path) -> Result<Self, String> {
        let mut session = ReadOnlyIgcl::load_legacy(dll_path).map_err(|error| error.to_string())?;
        let adapters = session.enumerate_adapters().map_err(|error| error.to_string())?;
        if adapters.is_empty() { return Err("legacy IGCL enumerated no adapters".into()); }
        Ok(Self { session, adapters })
    }
    pub fn index_for_bdf(&self, bus: u32, device: u32, function: u32) -> Option<usize> {
        self.adapters.iter().position(|adapter| {
            adapter.bdf.bus as u32 == bus && adapter.bdf.device as u32 == device
                && adapter.bdf.function as u32 == function
        })
    }
    pub fn unique_index_for_bdf(&self, bus: u32, device: u32, function: u32) -> Result<usize, String> {
        let mut matches = self.adapters.iter().enumerate().filter(|(_, adapter)| {
            adapter.bdf.bus as u32 == bus && adapter.bdf.device as u32 == device
                && adapter.bdf.function as u32 == function
        });
        let (index, _) = matches.next().ok_or("legacy IGCL target no longer resolves")?;
        if matches.next().is_some() { return Err("legacy IGCL target identity is ambiguous".into()); }
        Ok(index)
    }
    pub(crate) fn unique_index_for_identity(&self, identity: &super::gpu_apply_identity::ApplyIdentity) -> Result<(usize, bool), String> {
        let rows = self.adapters.iter().map(|adapter| if adapter.name.trim().is_empty() { (0, 0, 0, 0, 0) } else {
            (adapter.pci_vendor_id, adapter.pci_device_id, u32::from(adapter.bdf.bus),
                u32::from(adapter.bdf.device), u32::from(adapter.bdf.function)) }).collect::<Vec<_>>();
        select_legacy_identity(&rows, identity.vendor, identity.device, identity.bus, identity.slot, identity.function)
    }
    pub fn supports_power(&self) -> bool { self.session.legacy_supports_power() }
    pub fn supports_temp(&self) -> bool { self.session.legacy_supports_temp() }
    pub fn apply_waiver(&self, index: usize) -> Result<(), String> {
        self.session.apply_waiver(index).map_err(|error| error.to_string())
    }
}

fn select_legacy_identity(rows: &[(u32, u32, u32, u32, u32)], vendor: u32, device: u32,
    bus: u32, slot: u32, function: u32) -> Result<(usize, bool), String> {
    let exact: Vec<_> = rows.iter().enumerate().filter(|(_, row)| **row == (vendor, device, bus, slot, function)).map(|(i, _)| i).collect();
    if exact.len() == 1 { return Ok((exact[0], false)); }
    if !rows.is_empty() && rows.iter().all(|row| (row.2, row.3, row.4) == (0, 0, 0)) {
        let pci: Vec<_> = rows.iter().enumerate().filter(|(_, row)| row.0 == vendor && row.1 == device).map(|(i, _)| i).collect();
        if pci.len() == 1 { return Ok((pci[0], true)); }
    }
    Err("legacy IGCL target identity is missing or ambiguous".into())
}

pub(crate) fn current_identity_is_unique(adapters: &[AdapterInfo], identity: &super::gpu_apply_identity::ApplyIdentity, index: usize) -> bool {
    let rows = adapters.iter().map(|adapter| (adapter.pci_vendor_id, adapter.pci_device_id,
        u32::from(adapter.bdf.bus), u32::from(adapter.bdf.device), u32::from(adapter.bdf.function))).collect::<Vec<_>>();
    current_rows_unique(&rows, (identity.vendor, identity.device, identity.bus, identity.slot, identity.function), index)
}

fn current_rows_unique(rows: &[(u32, u32, u32, u32, u32)], expected: (u32, u32, u32, u32, u32), index: usize) -> bool {
    let matching: Vec<_> = rows.iter().enumerate().filter(|(_, row)| row.0 == expected.0 && row.1 == expected.1).collect();
    matching.len() == 1 && matching[0].0 == index && *matching[0].1 == expected
}

impl LegacyBackend for LegacyIgcl {
    fn set_power_limit_mw(&mut self, index: usize, milliwatts: f64) -> Result<(), u32> {
        self.session.legacy_set_power_limit_mw(index, milliwatts)
    }
    fn get_power_limit_w(&mut self, index: usize) -> Result<f64, u32> {
        self.session.legacy_get_power_limit_w(index)
    }
    fn set_temp_limit_c(&mut self, index: usize, celsius: f64) -> Result<(), u32> {
        self.session.legacy_set_temp_limit_c(index, celsius)
    }
    fn get_temp_limit_c(&mut self, index: usize) -> Result<f64, u32> {
        self.session.legacy_get_temp_limit_c(index)
    }
}

pub fn capability() -> (bool, bool) {
    static CACHE: OnceLock<Mutex<Option<(bool, bool)>>> = OnceLock::new();
    if let Some(value) = CACHE.get().and_then(|cache| cache.lock().ok().and_then(|cache| *cache)) {
        return value;
    }
    let value = locate_dll().and_then(|path| LegacyIgcl::load(&path).ok()).map(|legacy| {
        // Capability reporting must stay read-only. Applying a waiver here
        // mutates ordinal zero, which may be a different GPU from the target
        // and can run before apply preflight. The selected-target apply path
        // performs its own consent-gated waiver call after identity checks.
        (legacy.supports_power(), legacy.supports_temp())
    }).unwrap_or((false, false));
    if let Ok(mut cache) = CACHE.get_or_init(|| Mutex::new(None)).lock() { *cache = Some(value); }
    value
}

pub fn locate_dll() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("ARC_POWER_OLD_IGCL_DLL") { candidates.push(PathBuf::from(path)); }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(root) = exe.parent() {
            candidates.push(root.join("compatibility-backend/resources/app.asar.unpacked/src/main/backend/igcl2023/IntelControlLib.dll"));
            candidates.push(root.join("resources/app.asar.unpacked/src/main/backend/igcl2023/IntelControlLib.dll"));
            candidates.push(root.join("compatibility-backend/src/main/backend/igcl2023/IntelControlLib.dll"));
        }
    }
    candidates.push(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
        .join("src/main/backend/igcl2023/IntelControlLib.dll"));
    candidates.into_iter().find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_selection_requires_exact_or_unique_pci_when_all_bdfs_missing() {
        let target = (0x8086, 0xe20b, 3, 0, 0);
        assert_eq!(select_legacy_identity(&[target], target.0, target.1, target.2, target.3, target.4).unwrap(), (0, false));
        assert_eq!(select_legacy_identity(&[(0x8086, 0x1234, 0, 0, 0), (0x8086, 0xe20b, 0, 0, 0)], target.0, target.1, 3, 0, 0).unwrap(), (1, true));
        assert!(select_legacy_identity(&[(0x8086, 0xe20b, 0, 0, 0); 2], target.0, target.1, 3, 0, 0).is_err());
        assert!(select_legacy_identity(&[(0x8086, 0xe20b, 0, 0, 0), (0x8086, 0x1234, 4, 0, 0)], target.0, target.1, 3, 0, 0).is_err());
        assert!(select_legacy_identity(&[(0x8086, 0x1234, 3, 0, 0)], target.0, target.1, 3, 0, 0).is_err());
        assert!(current_rows_unique(&[target], target, 0));
        assert!(!current_rows_unique(&[target, (0x8086, 0xe20b, 4, 0, 0)], target, 0));
        assert!(!current_rows_unique(&[target], target, 1));
    }

    struct Mock {
        power: f64, temp: f64,
        power_set: u32, temp_set: u32,
        power_read: Option<u32>, temp_read: Option<u32>,
        power_read_value: Option<f64>, temp_read_value: Option<f64>,
    }
    impl Default for Mock { fn default() -> Self { Self {
        power: 0.0, temp: 0.0, power_set: 0, temp_set: 0,
        power_read: None, temp_read: None, power_read_value: None, temp_read_value: None,
    } } }
    impl LegacyBackend for Mock {
        fn set_power_limit_mw(&mut self, _index: usize, milliwatts: f64) -> Result<(), u32> { if self.power_set != 0 { Err(self.power_set) } else { self.power = milliwatts / 1000.0; Ok(()) } }
        fn get_power_limit_w(&mut self, _index: usize) -> Result<f64, u32> {
            if let Some(result) = self.power_read { Err(result) } else { Ok(self.power_read_value.unwrap_or(self.power)) }
        }
        fn set_temp_limit_c(&mut self, _index: usize, celsius: f64) -> Result<(), u32> { if self.temp_set != 0 { Err(self.temp_set) } else { self.temp = celsius; Ok(()) } }
        fn get_temp_limit_c(&mut self, _index: usize) -> Result<f64, u32> {
            if let Some(result) = self.temp_read { Err(result) } else { Ok(self.temp_read_value.unwrap_or(self.temp)) }
        }
    }

    #[test]
    fn extended_power_clamps_and_verifies() {
        let mut mock = Mock::default();
        assert_eq!(apply_extended_power(&mut mock, 0, 400.0, 0)["ok"], true);
        assert_eq!(mock.power, 315.0);
        let mut refused = Mock { power_set: 0x4400_0004, ..Mock::default() };
        assert_eq!(apply_extended_power(&mut refused, 0, 250.0, 0)["errorCode"], "out-of-range");
        let mut mismatch = Mock::default();
        mismatch.power_read = Some(0x4000_0006);
        assert_eq!(apply_extended_power(&mut mismatch, 0, 250.0, 0)["ok"], false);
    }

    #[test]
    fn extended_temp_treats_sentinel_readback_as_accepted() {
        let mut mock = Mock::default();
        assert_eq!(apply_extended_temp(&mut mock, 0, 115.0, 0)["ok"], true);
        assert_eq!(mock.temp, 115.0);
        let mut sentinel = Mock { temp_read_value: Some(90.0), ..Mock::default() };
        let result = apply_extended_temp(&mut sentinel, 0, 110.0, 0);
        assert_eq!(result["ok"], true);
        assert_eq!(result["readBackUnavailable"], true);
        assert_eq!(result["readBackValue"], 110.0);
        let mut mismatch = Mock { temp_read_value: Some(90.0), temp_read: Some(0x4000_0006), ..Mock::default() };
        assert_eq!(apply_extended_temp(&mut mismatch, 0, 100.0, 0)["readBackSource"], "accepted-write");
        let mut refused = Mock { temp_set: 0x4000_000b, ..Mock::default() };
        assert_eq!(apply_extended_temp(&mut refused, 0, 110.0, 0)["errorCode"], "out-of-range");
    }
}
