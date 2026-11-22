//! Native port of `src/main/driver-monitor.js`.
//!
//! The sidecar is keyed by a stable physical-adapter identity, never by the
//! enumeration ordinal, so a reordered multi-GPU inventory cannot create a
//! false driver change. The document keeps the Electron schema verbatim:
//! `schemaVersion: 1`, `observations`, `transitions`, bounded to 256 and 512
//! entries by insertion order. Reads silently reset on corrupt JSON (the
//! Electron behavior) but fail closed on a newer schema. Writes use a unique
//! temp file plus `MoveFileExW(REPLACE_EXISTING|WRITE_THROUGH)`.
use super::store_file::{atomic_replace, reject_reparse_components};
use serde_json::{json, Map, Value};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, PathBuf},
    sync::Mutex,
};

pub const DRIVER_MONITOR_SCHEMA_VERSION: u64 = 1;
pub const MAX_OBSERVATIONS: usize = 256;
pub const MAX_TRANSITIONS: usize = MAX_OBSERVATIONS * 2;
const SIDECAR_FILE_NAME: &str = "driver-observations.json";

/// JavaScript `Number(value)`, limited to the scalar shapes present in the GPU
/// inventory. `undefined` is represented by a missing map entry.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => if *value { 1.0 } else { 0.0 },
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() { 0.0 } else { trimmed.parse::<f64>().unwrap_or(f64::NAN) }
        }
        _ => f64::NAN,
    }
}

/// JavaScript `Number.isInteger` plus the i64 formatting range used by the key.
fn js_integer(value: &Value) -> Option<i64> {
    let number = js_number(value);
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= i64::MAX as f64)
        .then_some(number as i64)
}

/// JavaScript `??`: null and missing both fall through to the next candidate.
fn first_defined<'a>(object: &'a Map<String, Value>, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| object.get(*key).filter(|value| !value.is_null()))
}

fn nonempty_trimmed(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|text| !text.is_empty()).map(str::to_owned)
}

/// Exact port of `stableDriverDeviceKey` in `driver-monitor.js`.
pub fn stable_driver_device_key(device: &Value) -> Option<String> {
    let Some(device) = device.as_object() else { return None; };
    if let Some(key) = nonempty_trimmed(device.get("deviceKey")) { return Some(key); }
    if let Some(pnp) = nonempty_trimmed(device.get("pnpDeviceId")) { return Some(format!("pnp:{pnp}")); }
    if let Some(controller) = device.get("osController").and_then(Value::as_object) {
        if let Some(pnp) = nonempty_trimmed(controller.get("pnpDeviceId")) { return Some(format!("pnp:{pnp}")); }
    }
    if let Some(bdf) = device.get("bdf").and_then(Value::as_object) {
        let bus = bdf.get("bus").and_then(js_integer);
        let slot = bdf.get("device").and_then(js_integer);
        let function = match first_defined(bdf, &["function", "func"]) {
            Some(value) => js_integer(value),
            None => Some(0),
        };
        let domain = match bdf.get("domain") {
            None | Some(Value::Null) => Some(0),
            Some(value) => js_integer(value),
        };
        if let (Some(bus), Some(slot), Some(function), Some(domain)) = (bus, slot, function, domain) {
            return Some(format!("bdf:{domain}:{bus}:{slot}.{function}"));
        }
    }
    if let Some(luid) = nonempty_trimmed(first_defined(device, &["osLuid", "luid", "adapterLuid"])) {
        return Some(format!("luid:{luid}"));
    }
    None
}

/// JavaScript `Math.round` (ties toward +Infinity, unlike Rust's away-from-zero).
fn js_round(value: f64) -> i64 { (value + 0.5).floor() as i64 }

/// JavaScript `String#slice` counts UTF-16 code units. A split surrogate is
/// replaced because Rust strings cannot carry a lone surrogate.
fn truncate_utf16(text: &str, max_units: usize) -> String {
    let units: Vec<u16> = text.encode_utf16().take(max_units).collect();
    String::from_utf16_lossy(&units)
}

fn normalize_observation(value: &Value, now: f64) -> Option<Value> {
    let source = value.as_object();
    let device_key = nonempty_trimmed(source.and_then(|source| source.get("deviceKey")))?;
    let version = nonempty_trimmed(source.and_then(|source| source.get("driverVersion")))
        .map(|text| truncate_utf16(&text, 256));
    let date = nonempty_trimmed(source.and_then(|source| source.get("driverDate")))
        .map(|text| truncate_utf16(&text, 128));
    let observed_at = source.and_then(|source| source.get("observedAt"))
        .and_then(Value::as_f64).filter(|value| value.is_finite())
        .map(js_round).unwrap_or_else(|| js_round(now));
    Some(json!({
        "deviceKey": device_key,
        "driverVersion": version,
        "driverDate": date,
        "observedAt": observed_at,
    }))
}

fn empty_document() -> (Map<String, Value>, Map<String, Value>) { (Map::new(), Map::new()) }

fn object_or_empty(value: Option<&Value>) -> Map<String, Value> {
    value.and_then(Value::as_object).cloned().unwrap_or_default()
}

fn tail(map: Map<String, Value>, max: usize) -> Map<String, Value> {
    let skip = map.len().saturating_sub(max);
    map.into_iter().skip(skip).collect()
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

pub struct DriverMonitor {
    root: PathBuf,
    lock: Mutex<()>,
}

impl DriverMonitor {
    /// The root is the fixed application data directory (`%APPDATA%\ArcPower`
    /// in production, a temp root in tests); the filename is never supplied by
    /// the renderer.
    pub fn new(root: PathBuf) -> Result<Self, String> {
        if !root.is_absolute() || root.components().any(|component| matches!(component, Component::ParentDir)) {
            return Err("Driver monitor root must be an absolute fixed path without parent traversal".into());
        }
        reject_reparse_components(&root)?;
        if root.exists() && !root.is_dir() { return Err("Driver monitor root must be a directory".into()); }
        Ok(Self { root, lock: Mutex::new(()) })
    }

    fn read_unlocked(&self) -> Result<(Map<String, Value>, Map<String, Value>), String> {
        let path = self.root.join(SIDECAR_FILE_NAME);
        reject_reparse_components(&path)?;
        let bytes = match fs::read(&path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(empty_document()),
            Err(error) => return Err(format!("Cannot read {SIDECAR_FILE_NAME}: {error}")),
        };
        let content = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&bytes);
        let raw: Value = match serde_json::from_slice(content) {
            Ok(value) => value,
            // Electron treats a corrupt observation sidecar as empty and later
            // rewrites it; this is deliberately different from the schema
            // stores, which refuse to overwrite corruption.
            Err(_) => return Ok(empty_document()),
        };
        if let Some(schema) = raw.get("schemaVersion") {
            if js_number(schema) > DRIVER_MONITOR_SCHEMA_VERSION as f64 {
                return Err("driver observations use a newer unsupported schema".into());
            }
        }
        Ok((object_or_empty(raw.get("observations")), object_or_empty(raw.get("transitions"))))
    }

    fn write_unlocked(&self, data: &Value) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(data).map_err(|error| error.to_string())?;
        // Electron writes JSON.stringify(data, null, 2) without a trailing LF.
        reject_reparse_components(&self.root)?;
        fs::create_dir_all(&self.root).map_err(|error| error.to_string())?;
        let destination = self.root.join(SIDECAR_FILE_NAME);
        reject_reparse_components(&destination)?;
        let temporary = self.root.join(format!(".{SIDECAR_FILE_NAME}.{:032x}.tmp", rand::random::<u128>()));
        let mut handle = OpenOptions::new().create_new(true).write(true).open(&temporary).map_err(|error| error.to_string())?;
        let result = (|| {
            handle.write_all(&bytes).map_err(|error| error.to_string())?;
            handle.flush().map_err(|error| error.to_string())?;
            handle.sync_all().map_err(|error| error.to_string())?;
            drop(handle);
            reject_reparse_components(&temporary)?;
            reject_reparse_components(&destination)?;
            atomic_replace(&temporary, &destination)
        })();
        if result.is_err() { let _ = fs::remove_file(&temporary); }
        result
    }

    pub fn status(&self) -> Result<Value, String> {
        let _lock = self.lock.lock().map_err(|_| "Driver monitor lock was poisoned")?;
        let (observations, transitions) = self.read_unlocked()?;
        Ok(json!({
            "schemaVersion": DRIVER_MONITOR_SCHEMA_VERSION,
            "observations": observations,
            "transitions": transitions,
        }))
    }

    /// Exact port of `DriverMonitor.observe`: one transition per stable
    /// device/previous/next tuple, bounded documents, and `changes` appended
    /// only to the returned value (never persisted).
    pub fn observe(&self, devices: &Value, driver_date: Option<&str>, now: f64) -> Result<Value, String> {
        let _lock = self.lock.lock().map_err(|_| "Driver monitor lock was poisoned")?;
        let (current_observations, current_transitions) = self.read_unlocked()?;
        let mut observations = current_observations;
        let mut transitions = current_transitions;
        let mut changes = Vec::new();
        for device in devices.as_array().into_iter().flatten() {
            let Some(device_key) = stable_driver_device_key(device) else { continue; };
            let Some(device) = device.as_object() else { continue; };
            let driver_version = first_defined(device, &["driverVersion"]).cloned().or_else(|| {
                device.get("osController").and_then(Value::as_object)
                    .and_then(|controller| controller.get("driverVersion")).cloned()
            });
            let observed_date = first_defined(device, &["driverDate"]).cloned()
                .or_else(|| driver_date.map(|value| json!(value)));
            let next = normalize_observation(&json!({
                "deviceKey": device_key,
                "driverVersion": driver_version.unwrap_or(Value::Null),
                "driverDate": observed_date.unwrap_or(Value::Null),
                "observedAt": now,
            }), now).expect("a stable device key always normalizes");
            let previous = observations.get(&device_key).and_then(|value| normalize_observation(value, now));
            if let Some(previous) = &previous {
                if string_field(previous, "driverVersion") != string_field(&next, "driverVersion")
                    || string_field(previous, "driverDate") != string_field(&next, "driverDate") {
                    let dedupe_key = format!("{}|{}|{}|{}|{}", device_key,
                        string_field(previous, "driverVersion").unwrap_or_default(),
                        string_field(previous, "driverDate").unwrap_or_default(),
                        string_field(&next, "driverVersion").unwrap_or_default(),
                        string_field(&next, "driverDate").unwrap_or_default());
                    if !transitions.contains_key(&dedupe_key) {
                        let change = json!({
                            "deviceKey": device_key,
                            "previous": previous,
                            "current": next,
                            "observedAt": now,
                            "dedupeKey": dedupe_key,
                        });
                        changes.push(change.clone());
                        transitions.insert(dedupe_key, change);
                    }
                }
            }
            observations.insert(device_key, next);
        }
        let observations = tail(observations, MAX_OBSERVATIONS);
        let transitions = tail(transitions, MAX_TRANSITIONS);
        let document = json!({
            "schemaVersion": DRIVER_MONITOR_SCHEMA_VERSION,
            "observations": observations,
            "transitions": transitions,
        });
        self.write_unlocked(&document)?;
        let mut result = document;
        result["changes"] = Value::Array(changes);
        Ok(result)
    }
}

/// Service entry point for `driver-monitor-check`. Device enumeration and the
/// display-class driver date are injected so production uses the native
/// inventory and unit tests never touch live hardware. A process-wide lock
/// keeps two service calls from losing each other's read-modify-write cycle.
pub fn check(root: PathBuf, devices: &Value, driver_date: Option<&str>, now: f64) -> Result<Value, String> {
    static CHECK_LOCK: Mutex<()> = Mutex::new(());
    let _guard = CHECK_LOCK.lock().map_err(|_| "Driver monitor service lock was poisoned")?;
    DriverMonitor::new(root)?.observe(devices, driver_date, now)
}

#[cfg(test)]
thread_local! {
    static CHECK_SEAM: std::cell::RefCell<Option<(Value, Option<String>)>> = const { std::cell::RefCell::new(None) };
}

/// Test-only injection for the service arm: avoids live GPU enumeration.
#[cfg(test)]
pub fn set_check_seam(devices: Value, driver_date: Option<String>) {
    CHECK_SEAM.with(|seam| { *seam.borrow_mut() = Some((devices, driver_date)); });
}

#[cfg(test)]
pub fn check_seam() -> Option<(Value, Option<String>)> {
    CHECK_SEAM.with(|seam| seam.borrow().clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("arc-driver-monitor-test-{:032x}", rand::random::<u128>()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path()) { let _ = fs::remove_dir_all(&self.0); }
        }
    }

    fn monitor(temp: &Temp) -> DriverMonitor { DriverMonitor::new(temp.0.clone()).unwrap() }

    #[test]
    fn stable_key_uses_the_documented_priority_and_pnp_fallbacks() {
        let cases = [
            (json!({"deviceKey":" pci:key ", "pnpDeviceId":"PCI\\A"}), Some("pci:key")),
            (json!({"deviceKey":"", "pnpDeviceId":" PCI\\A "}), Some("pnp:PCI\\A")),
            (json!({"osController":{"pnpDeviceId":"PCI\\B"}}), Some("pnp:PCI\\B")),
            (json!({"bdf":{"domain":1,"bus":3,"device":0,"function":0}}), Some("bdf:1:3:0.0")),
            (json!({"bdf":{"bus":3,"device":0}}), Some("bdf:0:3:0.0")),
            (json!({"osLuid":"0x00000001:0x00000002"}), Some("luid:0x00000001:0x00000002")),
            (json!({"luid":"luid-a"}), Some("luid:luid-a")),
            (json!({"adapterLuid":"adapter-a"}), Some("luid:adapter-a")),
            (json!({"bdf":{"bus":Value::Null,"device":0}}), Some("bdf:0:0:0.0")),
            (json!({"bdf":{"bus":3,"device":0,"function":"not-a-number"},"osLuid":"luid-fallback"}), Some("luid:luid-fallback")),
            (json!({"bdf":{"bus":3,"device":0,"domain":"not-a-number"},"osLuid":"luid-fallback"}), Some("luid:luid-fallback")),
            (json!({"deviceKey":"   "}), None),
            (json!([]), None),
        ];
        for (device, expected) in cases {
            assert_eq!(stable_driver_device_key(&device).as_deref(), expected, "{device}");
        }
    }

    #[test]
    fn native_inventory_device_key_matches_electron_device_hardware_key_shape() {
        // `gpu_devices` already emits this exact `deviceHardwareKey` shape (its
        // own tests pin `pci:0x00008086:0x000056a0@3:0.0` and the zeroed-BDF
        // `@-1:-1.-1` fallback). The monitor consumes that string first, so the
        // sidecar identity is the same as Electron's hardware key without
        // needing live hardware here.
        for key in ["pci:0x00008086:0x000056a0@3:0.0", "pci:0x00008086:0x000056a0@-1:-1.-1"] {
            assert_eq!(stable_driver_device_key(&json!({"deviceKey": key})).as_deref(), Some(key));
        }
    }

    #[test]
    fn observe_records_one_transition_per_tuple_and_dedupes_repeats() {
        let temp = Temp::new();
        let monitor = monitor(&temp);
        let devices = json!([{"deviceKey":"pci:a","driverVersion":"1.2.3.4"}]);
        let first = monitor.observe(&devices, Some("9-1-2026"), 1000.0).unwrap();
        assert_eq!(first["observations"]["pci:a"]["driverDate"], "9-1-2026");
        assert_eq!(first["changes"].as_array().unwrap().len(), 0);
        let changed = json!([{"deviceKey":"pci:a","driverVersion":"1.2.3.5"}]);
        let second = monitor.observe(&changed, Some("9-1-2026"), 2000.0).unwrap();
        assert_eq!(second["changes"].as_array().unwrap().len(), 1);
        assert_eq!(second["transitions"].as_object().unwrap().len(), 1);
        let transition = second["changes"][0].clone();
        assert_eq!(transition["previous"]["driverVersion"], "1.2.3.4");
        assert_eq!(transition["current"]["driverVersion"], "1.2.3.5");
        let third = monitor.observe(&changed, Some("9-1-2026"), 3000.0).unwrap();
        assert_eq!(third["changes"].as_array().unwrap().len(), 0, "the stored transition dedupes the same tuple");
        let reverted = monitor.observe(&devices, Some("9-1-2026"), 4000.0).unwrap();
        assert_eq!(reverted["changes"].as_array().unwrap().len(), 1);
        assert_eq!(reverted["transitions"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn observation_and_transition_caps_keep_the_newest_insertion_order() {
        let temp = Temp::new();
        let monitor = monitor(&temp);
        let devices: Vec<Value> = (0..(MAX_OBSERVATIONS + 20))
            .map(|index| json!({"deviceKey":format!("pci:{index}"),"driverVersion":"1.0.0.0"}))
            .collect();
        let result = monitor.observe(&Value::Array(devices), None, 1000.0).unwrap();
        let observations = result["observations"].as_object().unwrap();
        assert_eq!(observations.len(), MAX_OBSERVATIONS);
        assert!(!observations.contains_key("pci:0"), "oldest observation is trimmed");
        assert!(observations.contains_key(&format!("pci:{}", MAX_OBSERVATIONS + 19)));
        let keys: Vec<_> = observations.keys().cloned().collect();
        assert_eq!(keys.first().unwrap(), &format!("pci:{}", 20));

        for version in 0..(MAX_TRANSITIONS + 10) {
            let next = json!([{"deviceKey":"pci:one","driverVersion":format!("2.0.0.{version}")}]);
            monitor.observe(&next, None, 1000.0 + version as f64).unwrap();
        }
        let status = monitor.status().unwrap();
        assert_eq!(status["transitions"].as_object().unwrap().len(), MAX_TRANSITIONS);
        assert_eq!(status["observations"].as_object().unwrap().len(), MAX_OBSERVATIONS);
    }

    #[test]
    fn newer_schema_fails_closed_without_overwriting_and_bom_reads_work() {
        let temp = Temp::new();
        let path = temp.0.join(SIDECAR_FILE_NAME);
        fs::write(&path, b"{\"schemaVersion\":2,\"observations\":{}}").unwrap();
        let monitor = monitor(&temp);
        assert!(monitor.status().unwrap_err().contains("newer unsupported schema"));
        let original = fs::read(&path).unwrap();
        assert!(monitor.observe(&json!([]), None, 1.0).unwrap_err().contains("newer unsupported schema"));
        assert_eq!(fs::read(&path).unwrap(), original);

        fs::write(&path, b"\xef\xbb\xbf{\"schemaVersion\":1,\"observations\":{\"pci:a\":{\"deviceKey\":\"pci:a\",\"driverVersion\":\"1.0.0.0\",\"driverDate\":null,\"observedAt\":5}},\"transitions\":{}}").unwrap();
        let status = monitor.status().unwrap();
        assert_eq!(status["observations"]["pci:a"]["driverVersion"], "1.0.0.0");
    }

    #[test]
    fn corrupt_sidecar_resets_to_an_empty_document_and_atomic_write_leaves_no_temp_file() {
        let temp = Temp::new();
        let path = temp.0.join(SIDECAR_FILE_NAME);
        fs::write(&path, b"not json").unwrap();
        let monitor = monitor(&temp);
        assert_eq!(monitor.status().unwrap()["observations"], json!({}));
        monitor.observe(&json!([{"deviceKey":"pci:a","driverVersion":"1.0.0.0"}]), None, 1.0).unwrap();
        let raw = fs::read(&path).unwrap();
        assert!(serde_json::from_slice::<Value>(&raw).is_ok());
        let mut names = Vec::new();
        for entry in fs::read_dir(&temp.0).unwrap() { names.push(entry.unwrap().file_name().to_string_lossy().into_owned()); }
        assert_eq!(names, vec![SIDECAR_FILE_NAME.to_owned()]);
    }

    #[test]
    fn normalization_truncates_like_javascript_and_rounds_observed_at() {
        let long_version = "v".repeat(300);
        let long_date = "d".repeat(200);
        let normalized = normalize_observation(&json!({
            "deviceKey":" pci:a ", "driverVersion": long_version, "driverDate": long_date, "observedAt": 1.6
        }), 5.0).unwrap();
        assert_eq!(normalized["deviceKey"], "pci:a");
        assert_eq!(normalized["driverVersion"].as_str().unwrap().len(), 256);
        assert_eq!(normalized["driverDate"].as_str().unwrap().len(), 128);
        assert_eq!(normalized["observedAt"], 2);
        assert!(normalize_observation(&json!({"deviceKey":"   "}), 1.0).is_none());
    }
}
