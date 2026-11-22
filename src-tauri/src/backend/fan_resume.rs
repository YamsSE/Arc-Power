//! Native fan-resume controller. Restores the user-confirmed fan mode after
//! sleep by resolving the saved physical GPU proof and reusing the native,
//! read-back-verified fan apply core. No fan write is attempted during tests.
use super::{
    apply_lock, fan_apply, fan_resume_store,
    gpu_capabilities, gpu_devices,
    native_store::NativeStore,
    wire::{self, WireValue},
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, OnceLock, Weak},
    time::Duration,
};

const STATUS_CHANNEL: &str = "fan-resume:status";

pub fn status_channel() -> &'static str { STATUS_CHANNEL }
static HUB: OnceLock<Mutex<Weak<FanResumeHub>>> = OnceLock::new();

fn hub_slot() -> &'static Mutex<Weak<FanResumeHub>> {
    HUB.get_or_init(|| Mutex::new(Weak::new()))
}

struct Status {
    state: &'static str,
    error: Option<String>,
    generation: u64,
}

pub struct FanResumeHub {
    store: Arc<NativeStore>,
    notify: Box<dyn Fn() + Send + Sync>,
    status: Mutex<Status>,
    invalid: Mutex<HashSet<String>>,
}

fn process_elevated() -> bool {
    #[cfg(windows)]
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
    #[cfg(not(windows))]
    false
}

fn store_json(store: &NativeStore, method: &str, args: Value) -> Result<Value, String> {
    let encoded = wire::encode_json(&args)?;
    let reply = store.invoke(method, &encoded)?;
    let value = wire::decode(&reply)?.into_json()?;
    Ok(value.get("result").cloned().unwrap_or(value))
}

fn keys_of(device: &Value) -> HashSet<String> {
    let mut keys = HashSet::new();
    if let Some(key) = device.get("deviceKey").and_then(Value::as_str) { keys.insert(key.to_owned()); }
    for key in device.get("deviceKeys").and_then(Value::as_array).into_iter().flatten() {
        if let Some(key) = key.as_str() { keys.insert(key.to_owned()); }
    }
    keys
}

fn proof_of(device: &Value) -> Value {
    json!({
        "deviceKey": device.get("deviceKey").cloned().unwrap_or(Value::Null),
        "pnpDeviceId": device.get("pnpDeviceId").cloned().unwrap_or(Value::Null),
        "pciVendorId": device.get("pciVendorId").cloned().unwrap_or(Value::Null),
        "pciDeviceId": device.get("pciDeviceId").cloned().unwrap_or(Value::Null),
        "bdf": device.get("bdf").cloned().unwrap_or(Value::Null),
        "osLuid": device.get("luid").cloned().unwrap_or(Value::Null),
    })
}

fn proof_matches(device: &Value, proof: &Value) -> bool {
    let mut matched = false;
    let mut compare = |device_key: &str, proof_key: &str| -> bool {
        let actual = device.get(device_key).filter(|value| !value.is_null());
        let expected = proof.get(proof_key).filter(|value| !value.is_null());
        match (actual, expected) {
            (Some(actual), Some(expected)) if actual.is_string() || actual.is_number() => {
                matched = true;
                actual == expected
            }
            (Some(actual), Some(expected)) if actual.is_object() || actual.is_array() => {
                matched = true;
                actual == expected
            }
            _ => true,
        }
    };
    if !compare("pnpDeviceId", "pnpDeviceId") { return false; }
    if !compare("pciVendorId", "pciVendorId") { return false; }
    if !compare("pciDeviceId", "pciDeviceId") { return false; }
    if !compare("bdf", "bdf") { return false; }
    if !compare("luid", "osLuid") { return false; }
    let expected_key = proof.get("deviceKey").and_then(Value::as_str);
    if !matched {
        if let Some(expected_key) = expected_key { return keys_of(device).contains(expected_key); }
    }
    matched
}

fn target_device_id(devices: &[Value], device_key: &str) -> Result<(usize, Value), String> {
    let matches: Vec<(usize, Value)> = devices.iter().cloned().enumerate()
        .filter(|(_, device)| keys_of(device).contains(device_key)).collect();
    match matches.len() {
        1 => Ok(matches.into_iter().next().unwrap()),
        0 => Err("fan-resume: selected GPU identity changed".into()),
        _ => Err("fan-resume: GPU identity is ambiguous or read-only".into()),
    }
}

fn resolve_record(devices: &[Value], record: &Value) -> Result<(usize, Value), String> {
    let key = record.get("deviceKey").and_then(Value::as_str).unwrap_or("");
    let proof = record.get("physicalTarget").cloned().unwrap_or(Value::Null);
    let key_matches: Vec<(usize, Value)> = devices.iter().cloned().enumerate()
        .filter(|(_, device)| keys_of(device).contains(key) && proof_matches(device, &proof)).collect();
    if key_matches.len() == 1 { return Ok(key_matches.into_iter().next().unwrap()); }
    if key_matches.len() > 1 { return Err("Ambiguous saved fan settings: multiple records identify this GPU. Turn fan resume off and enable it again.".into()); }
    let proof_matches_rows: Vec<(usize, Value)> = devices.iter().cloned().enumerate()
        .filter(|(_, device)| proof_matches(device, &proof)).collect();
    match proof_matches_rows.len() {
        1 => Ok(proof_matches_rows.into_iter().next().unwrap()),
        0 => Err("selected GPU identity could not be resolved".into()),
        _ => Err("Ambiguous saved fan settings: multiple records identify this GPU. Turn fan resume off and enable it again.".into()),
    }
}

fn mode_waiver(store: &NativeStore, device_key: &str) -> (String, bool) {
    let settings = store_json(store, "load-settings", json!([])).unwrap_or_else(|_| json!({}));
    let mode = settings.get("ocModes").and_then(|value| value.get(device_key)).and_then(Value::as_str)
        .or_else(|| settings.get("ocMode").and_then(Value::as_str)).unwrap_or("stock").to_owned();
    (mode, settings.get("waiverAccepted").and_then(Value::as_bool) == Some(true))
}

fn apply_fan_to_device(store: &NativeStore, device_id: u64, device_key: &str, settings: &Value) -> Result<Value, String> {
    let path = gpu_devices::locate_dll().ok_or("fan-resume: IGCL runtime is unavailable")?;
    let (mode, waiver) = mode_waiver(store, device_key);
    let caps = gpu_capabilities::capabilities(&path, device_id, &mode, waiver)?;
    if caps["fan"]["canControl"].as_bool() != Some(true) {
        return Err("Fan control capabilities are not ready yet.".into());
    }
    if !caps["fan"]["modes"].as_array().is_some_and(|modes| modes.iter().any(|mode| mode.as_str() == settings["fanMode"].as_str())) {
        return Err("The saved fan mode or curve is no longer supported by this GPU.".into());
    }
    if settings["fanMode"].as_str() == Some("curve") {
        let points = settings["fanCurve"].as_array().map(Vec::len).unwrap_or(0);
        let maximum = caps["fan"]["maxCurvePoints"].as_f64().unwrap_or(0.0);
        if points > maximum as usize { return Err("The saved fan mode or curve is no longer supported by this GPU.".into()); }
    }
    let _lock = apply_lock::acquire()?;
    let (mut igcl, raw_index, _) = gpu_capabilities::open_for_device(&path, device_id)?;
    if waiver { let _ = igcl.apply_waiver(raw_index); }
    let result = match igcl.fan_backend(raw_index) {
        Some(mut backend) => fan_apply::apply_fan(settings, &caps, &mut backend),
        None => json!({"ok": false, "perControl": {"fanMode": {"ok": false, "errorCode": "unsupported", "message": "no fans enumerated on this device"}}}),
    };
    let _ = igcl.close();
    let state = gpu_capabilities::current_settings(&path, device_id).ok();
    Ok(json!({"ok": result["ok"].as_bool() == Some(true), "perControl": result["perControl"], "state": state}))
}

fn fan_state(store: &NativeStore, device_id: u64, device_key: &str) -> Result<(Value, Value), String> {
    let path = gpu_devices::locate_dll().ok_or("fan-resume: IGCL runtime is unavailable")?;
    let (mode, waiver) = mode_waiver(store, device_key);
    let caps = gpu_capabilities::capabilities(&path, device_id, &mode, waiver)?;
    let state = gpu_capabilities::current_settings(&path, device_id)?;
    Ok((caps, state))
}

fn fan_capabilities_for_identity(
    store: &NativeStore,
    identity: &super::gpu_apply_identity::ApplyIdentity,
) -> Result<Value, String> {
    let path = gpu_devices::locate_dll().ok_or("fan-resume: IGCL runtime is unavailable")?;
    let (mode, waiver) = mode_waiver(store, &identity.device_key);
    gpu_capabilities::capabilities_for_identity(&path, identity, &mode, waiver)
}

fn capture_fan_settings(state: &Value, caps: &Value) -> Result<Value, String> {
    let mode = state.get("fanMode").and_then(Value::as_str).filter(|mode| ["auto", "curve", "fixed"].contains(mode))
        .ok_or("fan-resume: fan control or current mode is unavailable")?;
    let mut settings = json!({"fanMode":mode});
    if mode == "curve" {
        let curve = state.get("fanCurve").cloned().unwrap_or_else(|| json!([]));
        let points = curve.as_array().map(Vec::len).unwrap_or(0);
        let maximum = caps["fan"]["maxCurvePoints"].as_f64().unwrap_or(0.0);
        if points < 2 || points > maximum as usize { return Err("fan-resume: current curve exceeds the GPU point limit".into()); }
        settings["fanCurve"] = curve;
    } else if mode == "fixed" {
        settings["fixedFanPct"] = state.get("fixedFanPct").cloned().ok_or("fan-resume: fan control or current mode is unavailable")?;
    }
    fan_resume_store::fan_only_settings(&settings)
}

impl FanResumeHub {
    pub fn new(store: Arc<NativeStore>, notify: Box<dyn Fn() + Send + Sync>) -> Arc<Self> {
        let hub = Arc::new(Self {
            store,
            notify,
            status: Mutex::new(Status { state: "off", error: None, generation: 0 }),
            invalid: Mutex::new(HashSet::new()),
        });
        if let Ok(mut slot) = hub_slot().lock() { *slot = Arc::downgrade(&hub); }
        let records = store_json(&hub.store, "fan-resume-list", json!([])).unwrap_or_else(|_| json!([]));
        let armed = records.as_array().is_some_and(|records| !records.is_empty());
        hub.set_status(if armed { "armed" } else { "off" }, None);
        hub
    }

    pub fn handles(channel: &str) -> bool { matches!(channel, "fan-resume:get" | "fan-resume:set") }

    pub fn handle(&self, channel: &str, args: &Value) -> Result<Value, String> {
        match channel {
            "fan-resume:get" => {
                let payload = one_object(args, channel)?;
                let device_id = payload.get("deviceId").and_then(Value::as_u64);
                let device_key = payload.get("deviceKey").and_then(Value::as_str).map(str::to_owned);
                self.get(device_id, device_key.as_deref())
            }
            "fan-resume:set" => {
                let payload = one_object(args, channel)?;
                self.set(payload)
            }
            _ => Err("Unknown fan-resume channel".into()),
        }
    }

    pub fn on_power(&self, payload: &Value) {
        match payload.get("state").and_then(Value::as_str) {
            Some("resume") => self.on_resume(),
            Some("suspend") => self.on_suspend(),
            _ => {}
        }
    }

    fn set_status(&self, state: &'static str, error: Option<String>) {
        if let Ok(mut status) = self.status.lock() { status.state = state; status.error = error; }
        (self.notify)();
    }

    fn status_value(&self) -> (&'static str, Option<String>) {
        self.status.lock().map(|status| (status.state, status.error.clone())).unwrap_or(("unavailable", None))
    }

    fn records(&self) -> Result<Vec<Value>, String> {
        Ok(store_json(&self.store, "fan-resume-list", json!([]))?.as_array().cloned().unwrap_or_default())
    }

    fn get(&self, device_id: Option<u64>, device_key: Option<&str>) -> Result<Value, String> {
        let records = self.records()?;
        let devices = gpu_devices::list_devices_merged().as_array().cloned().unwrap_or_default();
        let device = device_id.and_then(|id| devices.get(id as usize).cloned());
        let aliases = device.as_ref().map(keys_of).unwrap_or_default();
        if let Some(key) = device_key {
            if !aliases.is_empty() && !aliases.contains(key) {
                return Ok(json!({"enabled":false,"state":"unavailable","error":"Saved GPU identity is ambiguous. Turn fan resume off to clear its saved selection.","settings":Value::Null}));
            }
        }
        let matching: Vec<&Value> = records.iter().filter(|record| {
            let key = record.get("deviceKey").and_then(Value::as_str).unwrap_or("");
            (aliases.is_empty() && device_key == Some(key)) || aliases.contains(key)
                || device.as_ref().is_some_and(|device| proof_matches(device, record.get("physicalTarget").unwrap_or(&Value::Null)))
        }).collect();
        if matching.len() > 1 {
            return Ok(json!({"enabled":false,"state":"unavailable","error":"Saved GPU identity is ambiguous. Turn fan resume off to clear its saved selection.","settings":Value::Null}));
        }
        let record = matching.first().copied();
        let invalid = record.is_some_and(|record| record.get("deviceKey").and_then(Value::as_str)
            .is_some_and(|key| self.invalid.lock().map(|keys| keys.contains(key)).unwrap_or(false)));
        let (state, error) = self.status_value();
        Ok(json!({
            "enabled": record.is_some(),
            "state": if invalid { "needs-confirmed-apply" } else { state },
            "error": if invalid { Some(error.unwrap_or_else(|| "Apply a valid fan mode to capture a new restore target.".into())) } else { error },
            "settings": if invalid { Value::Null } else { record.map(|record| record["settings"].clone()).unwrap_or(Value::Null) },
        }))
    }

    fn set(&self, payload: Value) -> Result<Value, String> {
        let enabled = payload.get("enabled").and_then(Value::as_bool).ok_or("fan-resume: invalid request")?;
        let device_key = payload.get("deviceKey").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
            .ok_or("fan-resume: invalid request")?.to_owned();
        let device_id = payload.get("deviceId").and_then(Value::as_u64);
        if !enabled {
            let devices = gpu_devices::list_devices_merged().as_array().cloned().unwrap_or_default();
            let aliases = device_id.and_then(|id| devices.get(id as usize)).map(keys_of).unwrap_or_default();
            let records = self.records()?;
            let mut remove = HashSet::new();
            for record in &records {
                let key = record.get("deviceKey").and_then(Value::as_str).unwrap_or("");
                if key == device_key || aliases.contains(key)
                    || device_id.and_then(|id| devices.get(id as usize)).is_some_and(|device| proof_matches(device, record.get("physicalTarget").unwrap_or(&Value::Null))) {
                    remove.insert(key.to_owned());
                }
            }
            if remove.is_empty() { remove.insert(device_key.clone()); }
            for key in remove {
                let _ = store_json(&self.store, "fan-resume-remove", json!([key]));
                if let Ok(mut invalid) = self.invalid.lock() { invalid.remove(&key); }
            }
            let remaining = self.records()?;
            self.set_status(if remaining.is_empty() { "off" } else { "armed" }, None);
            return self.get(device_id, Some(&device_key));
        }
        let device_id = device_id.ok_or("fan-resume: selected GPU identity unavailable")?;
        let path = gpu_devices::locate_dll().ok_or("fan-resume: IGCL runtime is unavailable")?;
        let devices = gpu_devices::list_devices(&path)?;
        let rows = devices.as_array().cloned().unwrap_or_default();
        let (index, device) = target_device_id(&rows, &device_key)?;
        if device.get("synthetic").and_then(Value::as_bool) == Some(true) || device.get("backendKind").and_then(Value::as_str) == Some("os") {
            return Err("fan-resume: GPU identity is ambiguous or read-only".into());
        }
        if index as u64 != device_id {
            // The merged inventory id is stable for IGCL rows, but tolerate a
            // key-resolved row when the caller supplied an equivalent alias.
            let merged = gpu_devices::list_devices_merged().as_array().cloned().unwrap_or_default();
            if merged.get(device_id as usize).map(keys_of).is_none_or(|keys| !keys.contains(&device_key)) {
                return Err("fan-resume: selected GPU identity changed".into());
            }
        }
        let (caps, state) = fan_state(&self.store, device_id, &device_key)?;
        if caps["fan"]["canControl"].as_bool() != Some(true) {
            return Err("fan-resume: fan control or current mode is unavailable".into());
        }
        let settings = capture_fan_settings(&state, &caps)?;
        let record = json!({"deviceKey":device_key,"physicalTarget":proof_of(&device),"settings":settings});
        store_json(&self.store, "fan-resume-set", json!([record]))?;
        if let Ok(mut invalid) = self.invalid.lock() { invalid.remove(&device_key); }
        self.set_status("armed", None);
        self.get(Some(device_id), Some(&device_key))
    }

    fn on_suspend(&self) {
        if let Ok(mut status) = self.status.lock() { status.generation += 1; }
        let records = self.records().unwrap_or_default();
        self.set_status(if records.is_empty() { "off" } else { "armed" }, None);
    }

    fn on_resume(&self) {
        let records = self.records().unwrap_or_default();
        if records.is_empty() { self.set_status("off", None); return; }
        if !process_elevated() {
            self.set_status("needs-elevation", Some("Run Arc Power as administrator to restore fan settings after sleep.".into()));
            return;
        }
        let generation = {
            let mut status = match self.status.lock() { Ok(status) => status, Err(_) => return };
            status.generation += 1;
            status.generation
        };
        let weak = hub_slot().lock().map(|slot| slot.clone()).unwrap_or_else(|_| Weak::new());
        let Some(hub) = weak.upgrade() else { return; };
        self.set_status("waiting", None);
        std::thread::spawn(move || {
            for delay in [2_000u64, 5_000, 10_000] {
                std::thread::sleep(Duration::from_millis(delay));
                if hub.status.lock().map(|status| status.generation).unwrap_or(generation) != generation { return; }
                let records = match hub.records() { Ok(records) => records, Err(error) => { hub.set_status("failed", Some(format!("Could not load saved fan settings: {error}"))); return; } };
                if records.is_empty() { hub.set_status("off", None); return; }
                let path = match gpu_devices::locate_dll() { Some(path) => path, None => continue };
                let devices = match gpu_devices::list_devices(&path).and_then(|value| Ok(value.as_array().cloned().unwrap_or_default())) {
                    Ok(devices) => devices,
                    Err(error) => { hub.set_status("failed", Some(error)); return; }
                };
                let mut all_done = true;
                let mut restored = false;
                for record in records {
                    let key = record.get("deviceKey").and_then(Value::as_str).unwrap_or("").to_owned();
                    let (index, device) = match resolve_record(&devices, &record) {
                        Ok(value) => value,
                        Err(error) => { hub.set_status("failed", Some(error)); all_done = true; continue; }
                    };
                    if !proof_matches(&device, record.get("physicalTarget").unwrap_or(&Value::Null)) { all_done = false; continue; }
                    match apply_fan_to_device(&hub.store, index as u64, &key, &record["settings"]) {
                        Ok(result) if result["ok"].as_bool() == Some(true) => { restored = true; all_done = true; }
                        Ok(result) => {
                            let error = result["perControl"].as_object().and_then(|controls| controls.values().find_map(|value| value.get("message").and_then(Value::as_str)))
                                .unwrap_or("Fan settings could not be confirmed yet.");
                            hub.set_status("failed", Some(error.to_owned()));
                            all_done = true;
                        }
                        Err(error) => { hub.set_status("failed", Some(error)); all_done = true; }
                    }
                }
                if all_done {
                    if restored { hub.set_status("restored", None); }
                    return;
                }
            }
            hub.set_status("failed", Some("Fan settings could not be confirmed after resume.".into()));
        });
    }

    fn note_apply(&self, expected: &super::gpu_apply_identity::ApplyIdentity, settings: &Value, result: &Value) {
        let has_fan = ["fanMode", "fanCurve", "fixedFanPct"].iter().any(|key| settings.get(*key).is_some_and(|value| !value.is_null()));
        if !has_fan { return; }
        let devices = gpu_devices::list_devices_merged().as_array().cloned().unwrap_or_default();
        let matches: Vec<usize> = devices.iter().enumerate().filter_map(|(index, device)| {
            super::gpu_apply_identity::identity_from_row(device).ok()
                .filter(|actual| super::gpu_apply_identity::ensure_same_target(expected, actual).is_ok())
                .map(|_| index)
        }).collect();
        if matches.len() != 1 { return; }
        let device = &devices[matches[0]];
        let aliases = keys_of(device);
        let records = self.records().unwrap_or_default();
        let Some(record) = records.iter().find(|record| {
            let key = record.get("deviceKey").and_then(Value::as_str).unwrap_or("");
            aliases.contains(key) || proof_matches(device, record.get("physicalTarget").unwrap_or(&Value::Null))
        }) else { return; };
        let key = record.get("deviceKey").and_then(Value::as_str).unwrap_or("").to_owned();
        let per = result.get("perControl").and_then(Value::as_object);
        let failed = per.is_some_and(|controls| ["fanMode", "fanCurve", "fixedFanPct"].iter().any(|name| {
            controls.get(*name).is_some_and(|value| value.get("ok").and_then(Value::as_bool) != Some(true))
        }));
        if failed || result.get("ok").and_then(Value::as_bool) != Some(true) {
            if let Ok(mut invalid) = self.invalid.lock() { invalid.insert(key.clone()); }
            let _ = store_json(&self.store, "fan-resume-remove", json!([key]));
            self.set_status("armed-no-target", Some("A fan apply failed; select and apply a valid fan mode again.".into()));
            return;
        }
        let Some(state) = result.get("state").filter(|state| state.is_object()) else { return; };
        let caps = fan_capabilities_for_identity(&self.store, expected).unwrap_or(Value::Null);
        if let Ok(settings) = capture_fan_settings(state, &caps) {
            let updated = json!({"deviceKey":key,"physicalTarget":proof_of(device),"settings":settings});
            if store_json(&self.store, "fan-resume-set", json!([updated])).is_ok() {
                if let Ok(mut invalid) = self.invalid.lock() { invalid.remove(&key); }
                self.set_status("armed", None);
            }
        }
    }
}

pub(crate) fn notify_native_apply(
    expected: &super::gpu_apply_identity::ApplyIdentity,
    settings: &Value,
    result: &Value,
) {
    let weak = hub_slot().lock().map(|slot| slot.clone()).unwrap_or_else(|_| Weak::new());
    if let Some(hub) = weak.upgrade() { hub.note_apply(expected, settings, result); }
}

fn one_object(args: &Value, channel: &str) -> Result<Value, String> {
    let WireValue::Array(values) = wire::decode(args)? else { return Err("Expected argument array".into()); };
    if values.len() != 1 { return Err(format!("{channel} expects one payload")); }
    let value = values[0].clone().into_json()?;
    if !value.is_object() { return Err(format!("{channel}: payload must be an object")); }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn physical_proofs_require_consistent_strong_identity() {
        let device = json!({"deviceKey":"gpu-a","pciVendorId":"0x8086","pciDeviceId":"0xe20b","bdf":{"bus":3,"device":0,"function":0},"luid":"0x1:0x2"});
        let proof = proof_of(&device);
        assert!(proof_matches(&device, &proof));
        assert!(!proof_matches(&device, &json!({"pciDeviceId":"0x1234"})));
        assert!(proof_matches(&device, &json!({"deviceKey":"gpu-a"})));
    }

    #[test]
    fn fan_capture_only_keeps_the_active_mode() {
        let caps = json!({"fan":{"canControl":true,"maxCurvePoints":16}});
        assert_eq!(capture_fan_settings(&json!({"fanMode":"auto"}), &caps).unwrap(), json!({"fanMode":"auto"}));
        assert_eq!(capture_fan_settings(&json!({"fanMode":"fixed","fixedFanPct":42}), &caps).unwrap(), json!({"fanMode":"fixed","fixedFanPct":42}));
        assert!(capture_fan_settings(&json!({"fanMode":"curve","fanCurve":[{"t":40,"speedPct":20}]}), &caps).is_err());
    }
}
