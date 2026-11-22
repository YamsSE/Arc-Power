//! Native device-selection ownership: the process-lifetime main-renderer
//! selection generation, the durable device-set writer, and the read-only
//! automatic focus preference.
//!
//! `device-selection-push` is deliberately split from the generic services
//! dispatcher: its event carries renderer-owned `caps`/`state` values, so the
//! hub relays the original tagged wire values instead of reducing them through
//! serde_json. Ordinary JSON would turn `undefined` into a missing property and
//! reject non-finite numbers, both of which are legal renderer cache values.
use super::{
    gpu_devices,
    native_store::NativeStore,
    wire::{self, WireValue},
};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::atomic::{AtomicI64, Ordering},
};

pub const REQUEST_CHANNEL: &str = "device-selection:request";
pub const UPDATED_CHANNEL: &str = "device-selection:updated";

const GENERATION_CHANNEL: &str = "device-selection-generation-get";
const REQUEST_COMMAND: &str = "device-selection-request";
const PUSH_COMMAND: &str = "device-selection-push";

type Emit = Box<dyn Fn(&str, Value) + Send + Sync>;
type LoadSettings = Box<dyn Fn() -> Result<Value, String> + Send + Sync>;

/// The event fan-out is role-targeted, not label-targeted: recreated overlay
/// windows carry unique labels, while their role is stable.
pub fn target_roles(channel: &str) -> &'static [&'static str] {
    match channel {
        REQUEST_CHANNEL => &["main"],
        UPDATED_CHANNEL => &["main", "overlay", "advanced-overlay"],
        // The Graphics read-back is rendered by the main page and mirrored by
        // the advanced overlay panel only.
        super::graphics::STATE_UPDATED_CHANNEL => super::graphics::target_roles(channel),
        _ => &[],
    }
}

pub struct DeviceSelectionHub {
    generation: AtomicI64,
    load_settings: LoadSettings,
    emit: Emit,
}

impl DeviceSelectionHub {
    pub fn new(store: std::sync::Arc<NativeStore>, emit: Emit) -> Self {
        Self::with_loader(Box::new(move || load_settings(&store)), emit)
    }

    fn with_loader(load_settings: LoadSettings, emit: Emit) -> Self {
        Self { generation: AtomicI64::new(-1), load_settings, emit }
    }

    pub fn handles(channel: &str) -> bool {
        matches!(channel, GENERATION_CHANNEL | REQUEST_COMMAND | PUSH_COMMAND)
    }

    pub fn handle(&self, channel: &str, args: &Value) -> Option<Result<Value, String>> {
        match channel {
            GENERATION_CHANNEL => Some(self.generation_get(args)),
            REQUEST_COMMAND => Some(self.request(args)),
            PUSH_COMMAND => Some(self.push(args)),
            _ => None,
        }
    }

    fn generation_get(&self, args: &Value) -> Result<Value, String> {
        no_payload(GENERATION_CHANNEL, args)?;
        wire::encode_json(&json!({"generation": self.generation.load(Ordering::SeqCst)}))
    }

    fn request(&self, args: &Value) -> Result<Value, String> {
        let items = args_array(args)?;
        let Some(WireValue::String(device_key)) = items.into_iter().next() else {
            return Err("deviceKey must be a non-empty string".into());
        };
        if device_key.is_empty() { return Err("deviceKey must be a non-empty string".into()); }
        // The preload listener receives one callback argument, so the event
        // args stay a one-element array whose value is `{ deviceKey }`.
        let payload = WireValue::Object(vec![("deviceKey".into(), WireValue::String(device_key))]);
        (self.emit)(REQUEST_CHANNEL, wire::tagged(&WireValue::Array(vec![payload])));
        wire::encode_json(&json!({"accepted": true}))
    }

    fn push(&self, args: &Value) -> Result<Value, String> {
        let items = args_array(args)?;
        let Some(WireValue::Object(entries)) = items.into_iter().next() else {
            return Err("selection payload must be an object".into());
        };
        let mut device_id = None;
        let mut device_key = None;
        let mut selection_generation = None;
        let mut caps = None;
        let mut state = None;
        for (key, value) in entries {
            match key.as_str() {
                "deviceId" => device_id = Some(value),
                "deviceKey" => device_key = Some(value),
                "selectionGeneration" => selection_generation = Some(value),
                "caps" => caps = Some(value),
                "state" => state = Some(value),
                _ => {}
            }
        }
        let device_id_wire = device_id.unwrap_or(WireValue::Undefined);
        let device_id = valid_device_id(&device_id_wire)?;
        let device_key = match device_key {
            Some(WireValue::String(value)) => Some(value),
            Some(WireValue::Null) => None,
            _ => return Err("selection deviceKey must be a string or null".into()),
        };
        let generation = match selection_generation {
            None | Some(WireValue::Undefined) => None,
            Some(WireValue::Number(number)) => Some(
                number.as_u64().and_then(|value| i64::try_from(value).ok())
                    .ok_or("selectionGeneration must be a non-negative integer")?),
            Some(WireValue::SpecialNumber(number)) if number == "-0" => Some(0),
            Some(_) => return Err("selectionGeneration must be a non-negative integer".into()),
        };
        let caps = match caps {
            Some(value @ WireValue::Object(_)) => value,
            _ => return Err("selection payload must carry caps and state".into()),
        };
        let state = match state {
            Some(value @ WireValue::Object(_)) => value,
            _ => return Err("selection payload must carry caps and state".into()),
        };

        if let Some(generation) = generation {
            if !self.reserve(generation) { return Err(stale()); }
        }
        // Reserve before the settings read; a slower earlier push must not fan
        // out after a newer generation has already been observed.
        let persisted = (self.load_settings)()?;
        if let Some(generation) = generation {
            if self.generation.load(Ordering::SeqCst) != generation { return Err(stale()); }
        } else if !persisted_pair_matches(&persisted, device_id, device_key.as_deref()) {
            return Err(stale());
        }

        let event = WireValue::Object(vec![
            ("deviceId".into(), device_id_wire),
            ("deviceKey".into(), device_key.map(WireValue::String).unwrap_or(WireValue::Null)),
            ("caps".into(), caps),
            ("state".into(), state),
        ]);
        (self.emit)(UPDATED_CHANNEL, wire::tagged(&WireValue::Array(vec![event])));
        wire::encode_json(&json!({"accepted": true}))
    }

    /// Reserve a monotonic generation before any asynchronous work. The caller
    /// re-checks after its settings read; a reservation that lost the race must
    /// not roll the counter back, matching the Electron owner.
    fn reserve(&self, generation: i64) -> bool {
        let mut current = self.generation.load(Ordering::SeqCst);
        loop {
            if generation <= current { return false; }
            match self.generation.compare_exchange(current, generation, Ordering::SeqCst, Ordering::SeqCst) {
                Ok(_) => return true,
                Err(actual) => current = actual,
            }
        }
    }
}

fn stale() -> String { "stale device selection payload".into() }

fn args_array(args: &Value) -> Result<Vec<WireValue>, String> {
    match wire::decode(args)? {
        WireValue::Array(items) => Ok(items),
        _ => Err("Expected argument array".into()),
    }
}

fn no_payload(channel: &str, args: &Value) -> Result<(), String> {
    if args_array(args)?.is_empty() { Ok(()) } else { Err(format!("{channel} takes no payload")) }
}

fn load_settings(store: &NativeStore) -> Result<Value, String> {
    let encoded = store.invoke("load-settings", &wire::encode_json(&json!([]))?)?;
    wire::decode(&encoded)?.into_json()
}

fn persisted_pair_matches(persisted: &Value, device_id: u64, device_key: Option<&str>) -> bool {
    let Some(persisted_id) = persisted.get("deviceId").filter(|value| !value.is_null()) else {
        return true;
    };
    let id_matches = persisted_id.as_u64() == Some(device_id)
        || persisted_id.as_f64().is_some_and(|value| value == device_id as f64);
    id_matches && persisted.get("deviceKey").and_then(Value::as_str) == device_key
}

fn valid_device_id(value: &WireValue) -> Result<u64, String> {
    match value {
        WireValue::Number(number) => number.as_u64()
            .ok_or_else(|| format!("invalid device id: {}", js_json(value))),
        // JavaScript's `Number.isInteger(-0)` is true and `-0 < 0` is false.
        WireValue::SpecialNumber(number) if number == "-0" => Ok(0),
        _ => Err(format!("invalid device id: {}", js_json(value))),
    }
}

/// JSON.stringify-equivalent rendering used by the Electron validation
/// messages. `undefined` and non-finite numbers intentionally follow JS
/// rendering (`undefined`, `null`) rather than Rust JSON errors.
fn js_json(value: &WireValue) -> String {
    match value {
        WireValue::Undefined => "undefined".into(),
        WireValue::Null => "null".into(),
        WireValue::Bool(value) => value.to_string(),
        WireValue::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into()),
        WireValue::Number(value) => value.to_string(),
        WireValue::SpecialNumber(value) => if value == "-0" { "0".into() } else { "null".into() },
        WireValue::BigInt(value) => value.clone(),
        WireValue::Array(values) => format!("[{}]", values.iter().map(js_json).collect::<Vec<_>>().join(",")),
        WireValue::Object(values) => format!("{{{}}}", values.iter().map(|(key, value)| format!(
            "{}:{}", serde_json::to_string(key).unwrap_or_default(), js_json(value))).collect::<Vec<_>>().join(",")),
    }
}

fn stable_key(device: &Value) -> String {
    device.get("deviceKey").and_then(Value::as_str).filter(|key| !key.is_empty())
        .map(str::to_owned).unwrap_or_else(|| gpu_devices::device_key(device))
}

fn identity_tokens(device: &Value) -> Vec<String> {
    let mut tokens = vec![stable_key(device)];
    if let Some(keys) = device.get("deviceKeys").and_then(Value::as_array) {
        tokens.extend(keys.iter().filter_map(Value::as_str).filter(|key| !key.is_empty()).map(str::to_owned));
    }
    tokens.sort();
    tokens.dedup();
    tokens
}

/// A row is ambiguous when its stable key or any alternate `deviceKeys` entry
/// is shared with another row, or when the inventory already declared it
/// ambiguous. Native IGCL rows do not carry `identityAmbiguous`, so collision
/// detection is the native equivalent of the Electron inventory flag.
fn ambiguous_ref_indices(rows: &[&Value]) -> HashSet<usize> {
    let mut owners: HashMap<String, HashSet<usize>> = HashMap::new();
    for (index, device) in rows.iter().enumerate() {
        for token in identity_tokens(device) {
            owners.entry(token).or_default().insert(index);
        }
    }
    let mut result: HashSet<usize> = rows.iter().enumerate()
        .filter(|(_, device)| device.get("identityAmbiguous").and_then(Value::as_bool) == Some(true))
        .map(|(index, _)| index).collect();
    for indexes in owners.values().filter(|indexes| indexes.len() > 1) {
        result.extend(indexes);
    }
    result
}

fn ambiguous_indices(rows: &[Value]) -> HashSet<usize> {
    let refs: Vec<&Value> = rows.iter().collect();
    ambiguous_ref_indices(&refs)
}

fn is_integrated_focus_device(device: &Value) -> bool {
    if device.get("integrated").and_then(Value::as_bool) == Some(true) { return true; }
    if device.get("synthetic").and_then(Value::as_bool) != Some(true)
        && device.get("integrated").and_then(Value::as_bool) == Some(false) { return false; }
    let name = device.get("name").and_then(Value::as_str).unwrap_or("");
    if gpu_devices::is_integrated_style(name) { return true; }
    let has = |pattern: &str| regex::Regex::new(pattern).unwrap().is_match(name);
    has(r"(?i)\b(?:igpu|integrated)\b")
        || has(r"(?i)\b(?:amd\s+)?radeon(?:\s*\([^)]*\))?\s+graphics\b")
        || has(r"(?i)\b(?:radeon|vega)(?:\s*\([^)]*\))?\s+\d{3,4}m\b")
}

fn automatic_candidates<'a>(rows: &[&'a Value]) -> Vec<&'a Value> {
    let ambiguous = ambiguous_ref_indices(rows);
    rows.iter().enumerate().filter(|(index, _)| !ambiguous.contains(index)).map(|(_, device)| *device).collect()
}

fn display_hint(device: &Value) -> Option<bool> {
    let direct = device.get("displayActive").and_then(Value::as_bool);
    let controller = device.pointer("/osController/displayActive").and_then(Value::as_bool);
    match (direct, controller) {
        (Some(true), _) | (_, Some(true)) => Some(true),
        (Some(false), _) | (_, Some(false)) => Some(false),
        (None, None) => None,
    }
}

fn device_luids(device: &Value) -> Vec<String> {
    let mut luids: Vec<String> = ["luid", "osLuid", "adapterLuid"].iter()
        .filter_map(|key| device.get(*key).and_then(Value::as_str))
        .filter(|luid| !luid.is_empty())
        .map(str::to_ascii_lowercase)
        .collect();
    if let Some(luid) = device.pointer("/osController/luid").and_then(Value::as_str).filter(|luid| !luid.is_empty()) {
        luids.push(luid.to_ascii_lowercase());
    }
    luids
}

fn active_display_ids(candidates: &[&Value], active_luids: Option<&HashSet<String>>) -> (HashSet<u64>, bool) {
    let mut active = HashSet::new();
    // Provenance must hold for every candidate, not merely one of them: a
    // mixed IGCL + OS-only inventory cannot rank correctly if any row has no
    // display-active evidence at all.
    let mut proof = !candidates.is_empty();
    for device in candidates {
        let hint = display_hint(device);
        let luids = device_luids(device);
        let covered = hint.is_some() || (active_luids.is_some() && !luids.is_empty());
        proof = proof && covered;
        let luid_active = active_luids.is_some_and(|active_luids| {
            luids.iter().any(|luid| active_luids.contains(luid))
        });
        if hint == Some(true) || luid_active {
            if let Some(id) = device.get("id").and_then(Value::as_u64) { active.insert(id); }
        }
    }
    (active, proof)
}

fn preferred_pair(device: &Value) -> Value {
    let device_id = device.get("id").and_then(Value::as_u64).map(Value::from).unwrap_or(Value::Null);
    let device_key = device.get("deviceKey").and_then(Value::as_str).filter(|key| !key.is_empty())
        .map(|key| json!(key)).unwrap_or_else(|| json!(stable_key(device)));
    json!({"deviceId": device_id, "deviceKey": device_key})
}

fn null_pair() -> Value { json!({"deviceId": Value::Null, "deviceKey": Value::Null}) }

/// Read the current active display adapter LUIDs. The shape matches
/// `gpu_devices` (`0x{high:08x}:0x{low:08x}`), so merged IGCL rows can be
/// matched without probing vendor display APIs. This is read-only.
#[cfg(windows)]
pub(crate) fn display_active_luids() -> Option<HashSet<String>> {
    use windows_sys::Win32::Devices::Display::{
        GetDisplayConfigBufferSizes, QueryDisplayConfig, DISPLAYCONFIG_MODE_INFO,
        DISPLAYCONFIG_PATH_INFO, QDC_ONLY_ACTIVE_PATHS,
    };
    let mut path_count = 0u32;
    let mut mode_count = 0u32;
    if unsafe { GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count) } != 0 {
        return None;
    }
    if path_count == 0 { return Some(HashSet::new()); }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
    if unsafe { QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut path_count, paths.as_mut_ptr(),
        &mut mode_count, modes.as_mut_ptr(), std::ptr::null_mut()) } != 0 {
        return None;
    }
    let mut result = HashSet::new();
    for path in paths.iter().take(path_count as usize) {
        let adapter = path.sourceInfo.adapterId;
        result.insert(format!("0x{:08x}:0x{:08x}", adapter.HighPart as u32, adapter.LowPart));
    }
    Some(result)
}

#[cfg(not(windows))]
pub(crate) fn display_active_luids() -> Option<HashSet<String>> { None }

/// Native `device-preferred-get`. `None` means the channel must stay delegated
/// to Electron (empty/unavailable inventory or no display proof). Once those
/// preconditions are proven this never throws; an unresolvable/ambiguous
/// candidate set becomes an explicit null pair.
pub fn preferred_from_inventory(rows: &[Value]) -> Option<Value> {
    if rows.is_empty() { return None; }
    let active = display_active_luids();
    preferred_from_rows(rows, active.as_ref())
}

pub(crate) fn preferred_from_rows(rows: &[Value], active_luids: Option<&HashSet<String>>) -> Option<Value> {
    if rows.is_empty() { return None; }
    let all: Vec<&Value> = rows.iter().collect();
    let known = automatic_candidates(&all);
    let all_discrete: Vec<&Value> = rows.iter().filter(|device| !is_integrated_focus_device(device)).collect();
    let discrete = automatic_candidates(&all_discrete);
    // An ambiguous dGPU must never make an iGPU win by ordinal. If every dGPU
    // is ambiguous the candidate set is empty, not the integrated fallback.
    let candidates = if all_discrete.is_empty() { known } else { discrete };
    if candidates.is_empty() { return Some(null_pair()); }
    let (active, proof) = active_display_ids(&candidates, active_luids);
    if !proof { return None; }
    let mut ranked: Vec<(usize, &Value, bool, String)> = candidates.iter().enumerate()
        .map(|(index, device)| (index, *device,
            device.get("id").and_then(Value::as_u64).is_some_and(|id| active.contains(&id)),
            stable_key(device)))
        .collect();
    ranked.sort_by(|left, right| right.2.cmp(&left.2)
        .then_with(|| left.3.cmp(&right.3)).then_with(|| left.0.cmp(&right.0)));
    Some(preferred_pair(ranked[0].1))
}

/// Native `device-set`. `None` delegates when reliable inventory is absent;
/// otherwise validation and persistence follow the Electron order/messages.
pub fn device_set_or_none(store: &NativeStore, rows: &[Value], args: &Value) -> Option<Result<Value, String>> {
    if rows.is_empty() { return None; }
    Some(device_set(store, rows, args))
}

fn device_set(store: &NativeStore, rows: &[Value], args: &Value) -> Result<Value, String> {
    let first = args_array(args)?.into_iter().next().unwrap_or(WireValue::Undefined);
    let (device_id, provided_key) = match &first {
        WireValue::Number(_) | WireValue::SpecialNumber(_) => (valid_device_id(&first)?, None),
        WireValue::Object(entries) => {
            let mut id = None;
            let mut key = None;
            for (name, value) in entries {
                match name.as_str() {
                    "deviceId" => id = Some(value),
                    // Electron treats an explicitly undefined key as absent,
                    // but null is a provided non-string and therefore a mismatch.
                    "deviceKey" => key = if matches!(value, WireValue::Undefined) { None } else { Some(value.clone()) },
                    _ => {}
                }
            }
            (valid_device_id(id.unwrap_or(&WireValue::Undefined))?, key)
        }
        // An array is an object to JavaScript, but `selection.deviceId` is
        // undefined; keep Electron's rendered error instead of showing `[]`.
        WireValue::Array(_) => return Err("invalid device id: undefined".into()),
        other => return Err(format!("invalid device id: {}", js_json(other))),
    };
    let index = rows.iter().position(|device| device.get("id").and_then(Value::as_u64) == Some(device_id))
        .ok_or_else(|| format!("unknown device id {device_id}"))?;
    if ambiguous_indices(rows).contains(&index) {
        return Err(format!("cannot persist selection for device id {device_id}: physical identity is ambiguous"));
    }
    let device_key = stable_key(&rows[index]);
    if let Some(provided) = provided_key {
        if !matches!(&provided, WireValue::String(key) if key == &device_key) {
            return Err(format!("device key mismatch for device id {device_id}"));
        }
    }
    let mut settings = super::services::native_json(store, "load-settings", json!([]))?;
    if !settings.is_object() { settings = json!({}); }
    settings["deviceId"] = json!(device_id);
    settings["deviceKey"] = json!(device_key);
    super::services::native_json(store, "save-settings", json!([settings]))?;
    // Normal Tauri runs own the RTSS OSD natively, so Electron's
    // `requestRtssOverlaySync` reaction is a no-op here. Do not duplicate it.
    Ok(json!({"deviceId": device_id, "deviceKey": device_key}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs, path::PathBuf, sync::{mpsc, Arc, Barrier, Mutex}, thread,
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("arc-device-selection-{:032x}", rand::random::<u128>()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn store(&self) -> Arc<NativeStore> { Arc::new(NativeStore::new(self.0.clone(), "advanced").unwrap()) }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path()) { let _ = fs::remove_dir_all(&self.0); }
        }
    }

    #[derive(Clone, Default)]
    struct Recorded(Arc<Mutex<Vec<(String, Value)>>>);
    impl Recorded {
        fn events(&self) -> Vec<(String, Value)> { self.0.lock().unwrap().clone() }
        fn emitter(&self) -> Emit {
            let events = self.0.clone();
            Box::new(move |channel, args| events.lock().unwrap().push((channel.to_owned(), args)))
        }
    }

    fn hub(store: Arc<NativeStore>, recorded: &Recorded) -> DeviceSelectionHub {
        DeviceSelectionHub::new(store, recorded.emitter())
    }

    fn args(values: Vec<Value>) -> Value { wire::encode_json(&Value::Array(values)).unwrap() }

    fn call(hub: &DeviceSelectionHub, channel: &str, args: Value) -> Result<Value, String> {
        hub.handle(channel, &args).unwrap()
    }

    fn decoded(reply: Value) -> Value { wire::decode(&reply).unwrap().into_json().unwrap() }

    fn save_settings(store: &NativeStore, settings: Value) {
        store.invoke("save-settings", &wire::encode_json(&json!([settings])).unwrap()).unwrap();
    }

    fn load_settings(store: &NativeStore) -> Value {
        wire::decode(&store.invoke("load-settings", &wire::encode_json(&json!([])).unwrap()).unwrap())
            .unwrap().into_json().unwrap()
    }

    fn push_payload(device_id: u64, device_key: &str, generation: Option<i64>) -> Value {
        let mut payload = json!({"deviceId": device_id, "deviceKey": device_key, "caps": {}, "state": {}});
        if let Some(generation) = generation { payload["selectionGeneration"] = json!(generation); }
        payload
    }

    #[test]
    fn generation_starts_at_minus_one_and_takes_no_payload() {
        let fixture = Fixture::new();
        let recorded = Recorded::default();
        let hub = hub(fixture.store(), &recorded);
        let reply = decoded(call(&hub, GENERATION_CHANNEL, args(vec![])).unwrap());
        assert_eq!(reply, json!({"generation": -1}));
        assert_eq!(call(&hub, GENERATION_CHANNEL, args(vec![json!(1)])).unwrap_err(),
            "device-selection-generation-get takes no payload");
    }

    #[test]
    fn request_emits_main_only_with_a_device_key_payload() {
        let fixture = Fixture::new();
        let recorded = Recorded::default();
        let hub = hub(fixture.store(), &recorded);
        let reply = decoded(call(&hub, REQUEST_COMMAND, args(vec![json!("pci:gpu-a")])).unwrap());
        assert_eq!(reply, json!({"accepted": true}));
        let events = recorded.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].0, REQUEST_CHANNEL);
        assert_eq!(wire::decode(&events[0].1).unwrap().into_json().unwrap(),
            json!([{"deviceKey": "pci:gpu-a"}]));
        assert_eq!(target_roles(REQUEST_CHANNEL), &["main"][..]);
        assert_eq!(call(&hub, REQUEST_COMMAND, args(vec![json!("")])).unwrap_err(),
            "deviceKey must be a non-empty string");
        assert_eq!(recorded.events().len(), 1);
    }

    #[test]
    fn updated_event_roles_are_exactly_main_and_both_overlays() {
        assert_eq!(target_roles(UPDATED_CHANNEL), &["main", "overlay", "advanced-overlay"][..]);
        assert!(target_roles("device-selection:other").is_empty());
    }

    #[test]
    fn push_rejects_invalid_payloads_in_electron_order() {
        let fixture = Fixture::new();
        let hub = hub(fixture.store(), &Recorded::default());
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![])).unwrap_err(),
            "selection payload must be an object");
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![json!({"deviceId": -1, "deviceKey": null, "caps": {}, "state": {}})])).unwrap_err(),
            "invalid device id: -1");
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![json!({"deviceId": 1.5, "deviceKey": null, "caps": {}, "state": {}})])).unwrap_err(),
            "invalid device id: 1.5");
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![json!({"deviceId": 0, "caps": {}, "state": {}})])).unwrap_err(),
            "selection deviceKey must be a string or null");
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![json!({"deviceId": 0, "deviceKey": 3, "caps": {}, "state": {}})])).unwrap_err(),
            "selection deviceKey must be a string or null");
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![json!({"deviceId": 0, "deviceKey": null,
            "selectionGeneration": -1, "caps": {}, "state": {}})])).unwrap_err(),
            "selectionGeneration must be a non-negative integer");
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![json!({"deviceId": 0, "deviceKey": null, "state": {}})])).unwrap_err(),
            "selection payload must carry caps and state");
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![json!({"deviceId": 0, "deviceKey": null, "caps": {}, "state": []})])).unwrap_err(),
            "selection payload must carry caps and state");
    }

    #[test]
    fn generation_reservation_rejects_out_of_order_and_repeated_pushes() {
        let fixture = Fixture::new();
        let recorded = Recorded::default();
        let hub = hub(fixture.store(), &recorded);
        assert_eq!(decoded(call(&hub, PUSH_COMMAND, args(vec![push_payload(0, "pci:a", Some(2))])).unwrap()),
            json!({"accepted": true}));
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![push_payload(0, "pci:a", Some(1))])).unwrap_err(),
            "stale device selection payload");
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![push_payload(0, "pci:a", Some(2))])).unwrap_err(),
            "stale device selection payload");
        assert_eq!(decoded(call(&hub, PUSH_COMMAND, args(vec![push_payload(1, "pci:b", Some(3))])).unwrap()),
            json!({"accepted": true}));
        assert_eq!(recorded.events().len(), 2);
    }

    #[test]
    fn reload_handshake_accepts_the_next_generation() {
        let fixture = Fixture::new();
        let recorded = Recorded::default();
        let hub = hub(fixture.store(), &recorded);
        call(&hub, PUSH_COMMAND, args(vec![push_payload(0, "pci:a", Some(5))])).unwrap();
        let generation = decoded(call(&hub, GENERATION_CHANNEL, args(vec![])).unwrap());
        assert_eq!(generation, json!({"generation": 5}));
        call(&hub, PUSH_COMMAND, args(vec![push_payload(1, "pci:b", Some(6))])).unwrap();
        assert_eq!(recorded.events().len(), 2);
    }

    #[test]
    fn concurrent_same_generation_pushes_emit_once() {
        let fixture = Fixture::new();
        let recorded = Recorded::default();
        let hub = Arc::new(hub(fixture.store(), &recorded));
        let barrier = Arc::new(Barrier::new(2));
        let mut threads = Vec::new();
        for _ in 0..2 {
            let hub = hub.clone();
            let barrier = barrier.clone();
            threads.push(thread::spawn(move || {
                barrier.wait();
                call(&hub, PUSH_COMMAND, args(vec![push_payload(0, "pci:a", Some(4))]))
            }));
        }
        let results: Vec<Result<Value, String>> = threads.into_iter().map(|thread| thread.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.as_ref().is_err_and(|error| error.as_str() == "stale device selection payload")).count(), 1);
        assert_eq!(recorded.events().len(), 1);
    }

    #[test]
    fn slower_older_generation_rechecks_after_the_settings_read() {
        let recorded = Recorded::default();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let loader = {
            let calls = calls.clone();
            let release_rx = release_rx.clone();
            move || {
                if calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    let _ = entered_tx.send(());
                    let _ = release_rx.lock().unwrap().recv();
                }
                Ok(json!({"deviceId": Value::Null, "deviceKey": Value::Null}))
            }
        };
        let hub = Arc::new(DeviceSelectionHub::with_loader(Box::new(loader), recorded.emitter()));
        let first_hub = hub.clone();
        let first = thread::spawn(move || call(&first_hub, PUSH_COMMAND, args(vec![push_payload(0, "pci:a", Some(10))])));
        entered_rx.recv().unwrap();
        call(&hub, PUSH_COMMAND, args(vec![push_payload(1, "pci:b", Some(11))])).unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap_err(), "stale device selection payload");
        let events = recorded.events();
        assert_eq!(events.len(), 1);
        let payload = wire::decode(&events[0].1).unwrap().into_json().unwrap();
        assert_eq!(payload[0]["deviceId"], 1);
    }

    #[test]
    fn missing_generation_compares_the_persisted_pair_when_present() {
        let fixture = Fixture::new();
        let store = fixture.store();
        save_settings(&store, json!({"deviceId": 1, "deviceKey": "pci:b"}));
        let recorded = Recorded::default();
        let hub = hub(store, &recorded);
        call(&hub, PUSH_COMMAND, args(vec![push_payload(1, "pci:b", None)])).unwrap();
        assert_eq!(call(&hub, PUSH_COMMAND, args(vec![push_payload(0, "pci:a", None)])).unwrap_err(),
            "stale device selection payload");
        assert_eq!(recorded.events().len(), 1);
    }

    #[test]
    fn missing_generation_accepts_when_no_device_is_persisted() {
        let fixture = Fixture::new();
        let recorded = Recorded::default();
        let hub = hub(fixture.store(), &recorded);
        call(&hub, PUSH_COMMAND, args(vec![push_payload(7, "pci:new", None)])).unwrap();
        assert_eq!(recorded.events().len(), 1);
    }

    #[test]
    fn opaque_caps_and_state_wire_values_survive_the_relay() {
        let fixture = Fixture::new();
        let recorded = Recorded::default();
        let hub = hub(fixture.store(), &recorded);
        let raw = json!({"t":"array","v":[{"t":"object","v":[
            ["deviceId",{"t":"number","v":0}],
            ["deviceKey",{"t":"null"}],
            ["caps",{"t":"object","v":[
                ["missing",{"t":"undefined"}],
                ["nan",{"t":"number","v":"NaN"}]
            ]}],
            ["state",{"t":"object","v":[
                ["infinite",{"t":"number","v":"Infinity"}]
            ]}]
        ]}]});
        call(&hub, PUSH_COMMAND, raw).unwrap();
        let events = recorded.events();
        assert_eq!(events.len(), 1);
        let WireValue::Array(items) = wire::decode(&events[0].1).unwrap() else { panic!("event args must be an array") };
        let WireValue::Object(payload) = &items[0] else { panic!("event payload must be an object") };
        let field = |name: &str| payload.iter().find(|(key, _)| key.as_str() == name).map(|(_, value)| value).unwrap();
        let WireValue::Object(caps) = field("caps") else { panic!("caps must stay an object") };
        assert!(caps.iter().any(|(key, value)| key.as_str() == "missing" && *value == WireValue::Undefined));
        assert!(caps.iter().any(|(key, value)| key.as_str() == "nan" && matches!(value, WireValue::SpecialNumber(number) if number.as_str() == "NaN")));
        let WireValue::Object(state) = field("state") else { panic!("state must stay an object") };
        assert!(state.iter().any(|(key, value)| key.as_str() == "infinite" && matches!(value, WireValue::SpecialNumber(number) if number.as_str() == "Infinity")));
    }

    fn row(id: u64, name: &str, integrated: bool, key: &str) -> Value {
        json!({
            "id": id, "name": name, "integrated": integrated, "synthetic": false,
            "pciVendorId": "0x00008086", "pciDeviceId": "0x0000e20b",
            "bdf": {"bus": 3, "device": 0, "function": 0}, "deviceKey": key,
        })
    }

    fn with_display(mut value: Value, active: Option<bool>) -> Value {
        value["displayActive"] = match active { Some(active) => json!(active), None => Value::Null };
        value
    }

    #[test]
    fn preferred_prefers_discrete_even_when_integrated_is_enumerated_first() {
        let rows = vec![
            with_display(row(0, "Intel(R) UHD Graphics 770", true, "pci:igpu"), Some(true)),
            with_display(row(1, "Intel(R) Arc(TM) B580 Graphics", false, "pci:b580"), Some(false)),
        ];
        let selected = preferred_from_rows(&rows, None).unwrap();
        assert_eq!(selected, json!({"deviceId": 1, "deviceKey": "pci:b580"}));
    }

    #[test]
    fn preferred_uses_native_active_luids_before_device_key_order() {
        let mut first = with_display(row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:a"), None);
        first["luid"] = json!("0x00000000:0x00000001");
        let mut second = with_display(row(1, "Intel(R) Arc(TM) B570 Graphics", false, "pci:b"), None);
        second["luid"] = json!("0x00000000:0x00000002");
        let active: HashSet<String> = ["0x00000000:0x00000002".to_owned()].into_iter().collect();
        assert_eq!(preferred_from_rows(&[first.clone(), second.clone()], Some(&active)).unwrap(),
            json!({"deviceId": 1, "deviceKey": "pci:b"}));
        let both: HashSet<String> = ["0x00000000:0x00000001".to_owned(), "0x00000000:0x00000002".to_owned()]
            .into_iter().collect();
        assert_eq!(preferred_from_rows(&[first, second], Some(&both)).unwrap(),
            json!({"deviceId": 0, "deviceKey": "pci:a"}));
    }

    #[test]
    fn preferred_accepts_os_controller_display_proof() {
        let mut first = row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:a");
        first["displayActive"] = json!(false);
        first["osController"] = json!({"displayActive": true});
        let second = with_display(row(1, "Intel(R) Arc(TM) B570 Graphics", false, "pci:b"), Some(false));
        assert_eq!(preferred_from_rows(&[first, second], None).unwrap(),
            json!({"deviceId": 0, "deviceKey": "pci:a"}));
    }

    #[test]
    fn preferred_drops_ambiguous_discrete_rows_without_falling_back_to_integrated() {
        let rows = vec![
            with_display(row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:dup"), Some(false)),
            with_display(row(1, "Intel(R) Arc(TM) B580 Graphics", false, "pci:dup"), Some(false)),
            with_display(row(2, "Intel(R) UHD Graphics 770", true, "pci:igpu"), Some(true)),
        ];
        assert_eq!(preferred_from_rows(&rows, None).unwrap(),
            json!({"deviceId": Value::Null, "deviceKey": Value::Null}));
    }

    #[test]
    fn preferred_drops_rows_with_alternate_key_collisions_or_the_inventory_flag() {
        let mut first = with_display(row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:a"), Some(false));
        first["deviceKeys"] = json!(["pci:a", "pnp:Shared"]);
        let mut second = with_display(row(1, "Intel(R) Arc(TM) B570 Graphics", false, "pci:b"), Some(false));
        second["deviceKeys"] = json!(["pci:b", "pnp:Shared"]);
        assert_eq!(preferred_from_rows(&[first, second], None).unwrap(),
            json!({"deviceId": Value::Null, "deviceKey": Value::Null}));
        let mut flagged = with_display(row(2, "Intel(R) Arc(TM) A770 Graphics", false, "pci:c"), Some(false));
        flagged["identityAmbiguous"] = json!(true);
        assert_eq!(preferred_from_rows(&[flagged], None).unwrap(),
            json!({"deviceId": Value::Null, "deviceKey": Value::Null}));
    }

    #[test]
    fn preferred_delegates_when_display_proof_is_unavailable() {
        let rows = vec![row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:a")];
        assert!(preferred_from_rows(&rows, None).is_none());
        let active: HashSet<String> = ["0x00000000:0x00000001".to_owned()].into_iter().collect();
        assert!(preferred_from_rows(&rows, Some(&active)).is_none());
    }

    #[test]
    fn preferred_delegates_when_one_mixed_inventory_candidate_lacks_provenance() {
        let mut igcl = with_display(row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:igcl"), None);
        igcl["luid"] = json!("0x00000000:0x00000001");
        let mut os_only = with_display(row(1, "NVIDIA GeForce RTX 4070", false, "pnp:os-only"), None);
        os_only["synthetic"] = json!(true);
        os_only["backendKind"] = json!("os");
        let active: HashSet<String> = ["0x00000000:0x00000001".to_owned()].into_iter().collect();
        assert!(preferred_from_rows(&[igcl, os_only], Some(&active)).is_none());
    }

    #[test]
    fn preferred_delegates_for_empty_inventory() {
        assert!(preferred_from_inventory(&[]).is_none());
    }

    #[test]
    fn preferred_falls_back_to_the_pci_hardware_key() {
        let mut device = with_display(row(0, "Intel(R) Arc(TM) B580 Graphics", false, ""), Some(false));
        device["deviceKey"] = Value::Null;
        assert_eq!(preferred_from_rows(&[device], None).unwrap(),
            json!({"deviceId": 0, "deviceKey": "pci:0x00008086:0x0000e20b@3:0.0"}));
    }

    fn set_args(first: Value) -> Value { args(vec![first]) }

    #[test]
    fn device_set_accepts_numbers_objects_and_extra_args() {
        let fixture = Fixture::new();
        let store = fixture.store();
        save_settings(&store, json!({"theme": "midnight"}));
        let rows = vec![row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:b580")];
        let result = device_set_or_none(&store, &rows, &set_args(json!(0))).unwrap().unwrap();
        assert_eq!(result, json!({"deviceId": 0, "deviceKey": "pci:b580"}));
        assert_eq!(load_settings(&store)["theme"], "midnight");
        let result = device_set_or_none(&store, &rows,
            &args(vec![json!({"deviceId": 0, "deviceKey": "pci:b580"}), json!("ignored")])).unwrap().unwrap();
        assert_eq!(result, json!({"deviceId": 0, "deviceKey": "pci:b580"}));
    }

    #[test]
    fn device_set_rejects_unknown_ambiguous_and_mismatched_keys() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let rows = vec![row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:b580")];
        assert_eq!(device_set_or_none(&store, &rows, &set_args(json!(9))).unwrap().unwrap_err(),
            "unknown device id 9");
        assert_eq!(device_set_or_none(&store, &rows, &set_args(json!({"deviceId": 0, "deviceKey": "pci:other"})))
            .unwrap().unwrap_err(), "device key mismatch for device id 0");
        let mut first = row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:dup");
        first["deviceKeys"] = json!(["pci:dup", "pnp:Shared"]);
        let mut second = row(1, "Intel(R) Arc(TM) B570 Graphics", false, "pci:b570");
        second["deviceKeys"] = json!(["pci:b570", "pnp:Shared"]);
        assert_eq!(device_set_or_none(&store, &[first, second], &set_args(json!(0))).unwrap().unwrap_err(),
            "cannot persist selection for device id 0: physical identity is ambiguous");
    }

    #[test]
    fn device_set_delegates_when_inventory_is_empty() {
        let fixture = Fixture::new();
        let store = fixture.store();
        assert!(device_set_or_none(&store, &[], &set_args(json!(0))).is_none());
    }

    #[test]
    fn device_set_treats_an_explicitly_undefined_key_as_absent() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let rows = vec![row(0, "Intel(R) Arc(TM) B580 Graphics", false, "pci:b580")];
        let raw = json!({"t":"array","v":[{"t":"object","v":[
            ["deviceId",{"t":"number","v":0}],
            ["deviceKey",{"t":"undefined"}]
        ]}]});
        assert_eq!(device_set_or_none(&store, &rows, &raw).unwrap().unwrap(),
            json!({"deviceId": 0, "deviceKey": "pci:b580"}));
    }
}
