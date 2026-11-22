//! Native profile transfer: `profiles-export` envelope creation and
//! `profiles-import` validation/planning/commit.
//!
//! This is a direct port of `src/main/profile-transfer.js`; the Electron
//! handlers remain the compatibility oracle. The module is deliberately
//! split into pure create/validate/plan functions plus a `TransferWrite`
//! commit seam so a failing commit double can prove the compensating
//! rollback order.
use super::{
    native_store::NativeStore,
    profile_store::js_trim,
    services::{native_json, recording_settings},
    wire::WireValue,
};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

pub const PROFILE_TRANSFER_FORMAT: &str = "arc-power-profile-transfer";
pub const PROFILE_TRANSFER_SCHEMA_VERSION: i64 = 1;
const MAX_PROFILES: usize = 500;
const MAX_DEVICE_KEYS: usize = 256;

const GLOBAL_KEYS: [&str; 25] = [
    "theme",
    "overlayEnabled",
    "overlayHotkeyLetter",
    "overlayPosition",
    "overlayScale",
    "overlayRenderer",
    "overlayColor",
    "overlayLabelColor",
    "overlayValueColor",
    "overlayTemperatureUnit",
    "overlayStats",
    "overlayDeviceKeys",
    "overlayBgEnabled",
    "overlayBgColor",
    "overlayBgOpacity",
    "overlayChipNames",
    "overlayPollMs",
    "overlayTheme",
    "overlayRecordingPill",
    "recordingToastsEnabled",
    "advancedOverlayEnabled",
    "advancedOverlayHotkeyLetter",
    "advancedOverlayPosition",
    "activeProfileId",
    "activeProfileIds",
];
const RECORDING_KEYS: [&str; 13] = [
    "mode",
    "fps",
    "resolution",
    "encoderId",
    "bitrateKbps",
    "captureTarget",
    "captureColorMode",
    "showCursor",
    "replayLengthSec",
    "instantReplayAutoStart",
    "replayMarkersEnabled",
    "hotkeys",
    "audio",
];

/// JavaScript `Number.isInteger`.
fn is_integer(value: &Value) -> bool {
    value
        .as_f64()
        .is_some_and(|number| number.is_finite() && number.fract() == 0.0)
}

fn js_number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value == f64::INFINITY {
        return "Infinity".into();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".into();
    }
    if value == 0.0 {
        return "0".into();
    }
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    format!("{value}")
}

fn parse_js_number(text: &str) -> f64 {
    let text = js_trim(text);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let lower = text.to_ascii_lowercase();
    if let Some(hex) = lower.strip_prefix("0x") {
        return u128::from_str_radix(hex, 16).map(|value| value as f64).unwrap_or(f64::NAN);
    }
    if let Some(binary) = lower.strip_prefix("0b") {
        return u128::from_str_radix(binary, 2).map(|value| value as f64).unwrap_or(f64::NAN);
    }
    if let Some(octal) = lower.strip_prefix("0o") {
        return u128::from_str_radix(octal, 8).map(|value| value as f64).unwrap_or(f64::NAN);
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// JavaScript `Number(value)` for the JSON shapes this module sees.
fn js_number(value: &Value) -> f64 {
    match value {
        Value::Null => 0.0,
        Value::Bool(value) => {
            if *value {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(number) => number.as_f64().unwrap_or(f64::NAN),
        Value::String(text) => parse_js_number(text),
        Value::Array(_) => parse_js_number(&js_string_value(value)),
        Value::Object(_) => f64::NAN,
    }
}

/// JavaScript `String(value)` for the JSON shapes this module sees.
fn js_string_value(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(true) => "true".into(),
        Value::Bool(false) => "false".into(),
        Value::Number(number) => js_number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                other => js_string_value(other),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

fn js_string_or_empty(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string_value(value),
    }
}

/// JavaScript string `.length` (UTF-16 code units).
fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

/// JavaScript `slice(0, count)` measured in UTF-16 code units, truncated at a
/// code-point boundary. Electron can slice through a surrogate pair and carry
/// a lone surrogate into its JSON; this host stores UTF-8, so a dangling high
/// surrogate is dropped instead of being replaced with U+FFFD. The shared
/// parity fixture deliberately does not pin Electron's lone-surrogate bytes.
fn utf16_slice(text: &str, count: usize) -> String {
    let mut out = String::new();
    let mut used = 0;
    for character in text.chars() {
        let units = character.len_utf16();
        if used + units > count {
            break;
        }
        used += units;
        out.push(character);
    }
    out
}

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(number) => number.as_f64().is_some_and(|value| value != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `{ ...value }` for the JSON shapes used here.
fn spread_object(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        Value::String(text) => text
            .chars()
            .enumerate()
            .map(|(index, value)| (index.to_string(), json!(value.to_string())))
            .collect(),
        _ => Map::new(),
    }
}

fn object_entries(value: &Value) -> Vec<(String, Value)> {
    match value {
        Value::Object(map) => map.iter().map(|(key, value)| (key.clone(), value.clone())).collect(),
        Value::Array(items) => items
            .iter()
            .enumerate()
            .map(|(index, value)| (index.to_string(), value.clone()))
            .collect(),
        Value::String(text) => text
            .chars()
            .enumerate()
            .map(|(index, value)| (index.to_string(), json!(value.to_string())))
            .collect(),
        _ => Vec::new(),
    }
}

/// JavaScript `cloneJson`: a JSON round-trip of a store-backed value. Store
/// values are already ordinary JSON, so absent/null maps to the caller's
/// fallback and everything else is cloned.
fn clone_json(value: &Value) -> Value {
    value.clone()
}

fn pick(source: Option<&Value>, keys: &[&str]) -> Value {
    let mut out = Map::new();
    if let Some(Value::Object(map)) = source {
        for key in keys {
            if let Some(value) = map.get(*key) {
                out.insert((*key).to_owned(), clone_json(value));
            }
        }
    }
    Value::Object(out)
}

fn normalize_path_policy(value: Option<&Value>) -> Result<Value, String> {
    let source = match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    };
    let mode = if source.get("mode").and_then(Value::as_str) == Some("portable") {
        "portable"
    } else {
        "stripped"
    };
    let roots = match source.get("roots").and_then(Value::as_array) {
        Some(values) => {
            let mut seen = HashSet::new();
            let mut roots = Vec::new();
            for root in values {
                let Some(text) = root.as_str() else { continue };
                let trimmed = js_trim(text);
                if trimmed.is_empty() || utf16_len(text) > 4096 {
                    continue;
                }
                if seen.insert(trimmed.to_owned()) {
                    roots.push(json!(trimmed));
                    if roots.len() == 16 {
                        break;
                    }
                }
            }
            Value::Array(roots)
        }
        None => json!([]),
    };
    if mode == "portable" && roots.as_array().is_some_and(Vec::is_empty) {
        return Err("Portable profile paths require at least one validated root".into());
    }
    Ok(json!({"mode": mode, "roots": roots}))
}

/// `profileTransferDeviceKey` (`stableKeyOf`).
pub fn stable_device_key(device: &Value) -> Option<String> {
    let object = device.as_object()?;
    if let Some(Value::String(key)) = object.get("deviceKey") {
        let trimmed = js_trim(key);
        if !trimmed.is_empty() {
            return Some(trimmed.to_owned());
        }
    }
    if let Some(Value::String(pnp)) = object.get("pnpDeviceId") {
        let trimmed = js_trim(pnp);
        if !trimmed.is_empty() {
            return Some(format!("pnp:{trimmed}"));
        }
    }
    let bdf = object.get("bdf")?.as_object()?;
    let bus = bdf.get("bus").map(js_number).unwrap_or(f64::NAN);
    let device_number = bdf.get("device").map(js_number).unwrap_or(f64::NAN);
    if bus.is_finite()
        && bus.fract() == 0.0
        && device_number.is_finite()
        && device_number.fract() == 0.0
    {
        let domain = bdf
            .get("domain")
            .filter(|value| !value.is_null())
            .map(js_number)
            .unwrap_or(0.0);
        let function = bdf
            .get("function")
            .filter(|value| !value.is_null())
            .map(js_number)
            .unwrap_or(0.0);
        return Some(format!(
            "bdf:{}:{}:{}.{}",
            js_number_to_string(domain),
            js_number_to_string(bus),
            js_number_to_string(device_number),
            js_number_to_string(function)
        ));
    }
    None
}

/// `createProfileTransferEnvelope` with an explicit clock value.
pub fn create_envelope(
    app_version: &str,
    profiles: &Value,
    settings: &Value,
    recording_settings: &Value,
    devices: &Value,
    now: &str,
) -> Value {
    let mut seen = HashSet::new();
    let mut device_keys = Vec::new();
    for device in devices.as_array().into_iter().flatten() {
        if let Some(key) = stable_device_key(device) {
            if seen.insert(key.clone()) {
                device_keys.push(json!(key));
                if device_keys.len() == MAX_DEVICE_KEYS {
                    break;
                }
            }
        }
    }
    let mut clean_profiles = Vec::new();
    for profile in profiles.as_array().into_iter().flatten().take(MAX_PROFILES) {
        let object = profile.as_object();
        let id = object
            .and_then(|map| map.get("id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let name = object
            .and_then(|map| map.get("name"))
            .and_then(Value::as_str)
            .map(|name| utf16_slice(name, 128))
            .unwrap_or_else(|| "Profile".into());
        let created_at = object
            .and_then(|map| map.get("createdAt"))
            .and_then(Value::as_str)
            .map(|value| json!(value))
            .unwrap_or_else(|| json!(now));
        let schema_version = object
            .and_then(|map| map.get("schemaVersion"))
            .filter(|value| is_integer(value))
            .cloned()
            .unwrap_or_else(|| json!(1));
        let profile_settings = object
            .and_then(|map| map.get("settings"))
            .filter(|value| !value.is_null())
            .map(clone_json)
            .unwrap_or_else(|| json!({}));
        let oc_on_boot = object
            .and_then(|map| map.get("ocOnBoot"))
            .and_then(Value::as_bool)
            == Some(true);
        let mut clean = Map::new();
        clean.insert("id".into(), json!(id));
        clean.insert("name".into(), json!(name));
        clean.insert("createdAt".into(), created_at);
        clean.insert("schemaVersion".into(), schema_version);
        clean.insert("settings".into(), profile_settings);
        clean.insert("ocOnBoot".into(), json!(oc_on_boot));
        if let Some(Value::String(device_key)) = object.and_then(|map| map.get("deviceKey")) {
            let trimmed = js_trim(device_key);
            if !trimmed.is_empty() {
                clean.insert("deviceKey".into(), json!(trimmed));
            }
        }
        if let Some(Value::String(device_name)) = object.and_then(|map| map.get("deviceName")) {
            let trimmed = js_trim(device_name);
            if !trimmed.is_empty() {
                clean.insert("deviceName".into(), json!(utf16_slice(trimmed, 256)));
            }
        }
        clean_profiles.push(Value::Object(clean));
    }
    json!({
        "format": PROFILE_TRANSFER_FORMAT,
        "schemaVersion": PROFILE_TRANSFER_SCHEMA_VERSION,
        "productVersion": app_version,
        "exportedAt": now,
        "pathPolicy": {"mode": "stripped", "roots": []},
        "deviceKeys": device_keys,
        "profiles": clean_profiles,
        "settings": pick(Some(settings), &GLOBAL_KEYS),
        "recording": pick(Some(recording_settings), &RECORDING_KEYS),
    })
}

fn valid_profile_id(id: &str) -> bool {
    !id.is_empty()
        && utf16_len(id) <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// `validateProfileTransferEnvelope`.
pub fn validate_envelope(value: &Value) -> Result<Value, String> {
    let Some(object) = value.as_object() else {
        return Err("Profile import must be a JSON object".into());
    };
    if object.get("format").and_then(Value::as_str) != Some(PROFILE_TRANSFER_FORMAT) {
        return Err("Profile import is not an Arc Power profile export".into());
    }
    let schema_version = object.get("schemaVersion");
    if !schema_version.is_some_and(is_integer)
        || schema_version
            .and_then(Value::as_f64)
            .is_some_and(|value| value < 1.0)
    {
        return Err("Profile import has an invalid schema version".into());
    }
    if schema_version
        .and_then(Value::as_f64)
        .is_some_and(|value| value > PROFILE_TRANSFER_SCHEMA_VERSION as f64)
    {
        return Err("Profile import uses a newer unsupported schema".into());
    }
    let path_policy = normalize_path_policy(object.get("pathPolicy"))?;
    let incoming_profiles = object
        .get("profiles")
        .and_then(Value::as_array)
        .filter(|profiles| profiles.len() <= MAX_PROFILES)
        .ok_or_else(|| "Profile import contains too many profiles".to_owned())?;
    let mut profiles = Vec::with_capacity(incoming_profiles.len());
    for profile in incoming_profiles {
        let Some(profile_map) = profile.as_object() else {
            return Err("Profile import contains an invalid profile".into());
        };
        let Some(id) = profile_map.get("id").and_then(Value::as_str) else {
            return Err("Profile import contains an invalid profile id".into());
        };
        if !valid_profile_id(id) {
            return Err("Profile import contains an invalid profile id".into());
        }
        let Some(name) = profile_map.get("name").and_then(Value::as_str) else {
            return Err("Profile import contains an invalid profile name".into());
        };
        if js_trim(name).is_empty() || utf16_len(name) > 128 {
            return Err("Profile import contains an invalid profile name".into());
        }
        if let Some(version) = profile_map.get("schemaVersion") {
            if !is_integer(version)
                || version.as_f64().is_some_and(|value| value < 1.0)
            {
                return Err("Profile import contains an invalid profile schema version".into());
            }
        }
        let Some(profile_settings) = profile_map.get("settings").filter(|value| value.is_object()) else {
            return Err("Profile import contains invalid tuning settings".into());
        };
        let trimmed_name = js_trim(name);
        let mut clean = profile_map.clone();
        clean.insert("name".into(), json!(trimmed_name));
        clean.insert("settings".into(), clone_json(profile_settings));
        clean.insert(
            "ocOnBoot".into(),
            json!(profile_map.get("ocOnBoot").and_then(Value::as_bool) == Some(true)),
        );
        if let Some(Value::String(device_key)) = profile_map.get("deviceKey") {
            let trimmed = js_trim(device_key);
            if !trimmed.is_empty() {
                clean.insert("deviceKey".into(), json!(trimmed));
            }
        }
        if let Some(Value::String(device_name)) = profile_map.get("deviceName") {
            let trimmed = js_trim(device_name);
            if !trimmed.is_empty() {
                clean.insert("deviceName".into(), json!(utf16_slice(trimmed, 256)));
            }
        }
        profiles.push(Value::Object(clean));
    }
    let settings = match object.get("settings") {
        Some(Value::Object(_)) => pick(object.get("settings"), &GLOBAL_KEYS),
        _ => json!({}),
    };
    let recording = match object.get("recording") {
        Some(Value::Object(_)) => pick(object.get("recording"), &RECORDING_KEYS),
        _ => json!({}),
    };
    let mut device_keys = Vec::new();
    if let Some(values) = object.get("deviceKeys").and_then(Value::as_array) {
        let mut seen = HashSet::new();
        for value in values {
            let Some(text) = value.as_str() else { continue };
            let trimmed = js_trim(text);
            if trimmed.is_empty() {
                continue;
            }
            if seen.insert(trimmed.to_owned()) {
                device_keys.push(json!(trimmed));
                if device_keys.len() == MAX_DEVICE_KEYS {
                    break;
                }
            }
        }
    }
    Ok(json!({
        "format": PROFILE_TRANSFER_FORMAT,
        "schemaVersion": PROFILE_TRANSFER_SCHEMA_VERSION,
        "productVersion": js_string_or_empty(object.get("productVersion")),
        "exportedAt": js_string_or_empty(object.get("exportedAt")),
        "pathPolicy": path_policy,
        "deviceKeys": device_keys,
        "profiles": profiles,
        "settings": settings,
        "recording": recording,
    }))
}

fn profile_schema_version(profile: &Value) -> f64 {
    profile
        .get("schemaVersion")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && value.fract() == 0.0)
        .unwrap_or(1.0)
}

fn imported_name(name: &str, used_names: &HashSet<String>) -> String {
    let base = js_trim(name).to_owned();
    if !used_names.contains(&base.to_lowercase()) {
        return base;
    }
    let mut suffix = 1;
    loop {
        let candidate = format!("{base} (imported {suffix})");
        if !used_names.contains(&candidate.to_lowercase()) {
            return candidate;
        }
        suffix += 1;
    }
}

#[derive(Debug)]
pub struct Plan {
    pub envelope: Value,
    pub profiles: Value,
    pub settings: Value,
    pub applied: Vec<Value>,
    pub skipped: Vec<Value>,
    pub orphaned: Vec<Value>,
    pub identity_warnings: Vec<Value>,
}

/// `planProfileTransferImport`.
pub fn plan_import(
    incoming: &Value,
    existing: &Value,
    devices: &Value,
    current_settings: &Value,
) -> Result<Plan, String> {
    let envelope = validate_envelope(incoming)?;
    let current = existing.as_array().cloned().unwrap_or_default();
    let mut device_counts: HashMap<String, usize> = HashMap::new();
    for device in devices.as_array().into_iter().flatten() {
        if let Some(key) = stable_device_key(device) {
            *device_counts.entry(key).or_insert(0) += 1;
        }
    }
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for profile in &current {
        if let Some(id) = profile.get("id").and_then(Value::as_str) {
            by_id.insert(id.to_owned(), profile.clone());
        }
    }
    let mut used_names: HashSet<String> = HashSet::new();
    for profile in &current {
        let name = match profile {
            Value::Object(map) => map
                .get("name")
                .filter(|value| !value.is_null())
                .map(js_string_value)
                .unwrap_or_default(),
            _ => String::new(),
        };
        let trimmed = js_trim(&name).to_lowercase();
        if !trimmed.is_empty() {
            used_names.insert(trimmed);
        }
    }
    let mut applied: Vec<Value> = Vec::new();
    let mut skipped: Vec<Value> = Vec::new();
    let mut orphaned: Vec<Value> = Vec::new();
    let mut identity_warnings: Vec<Value> = Vec::new();
    let mut replacements: Vec<(String, Value)> = Vec::new();
    let mut orphan_ids: HashSet<String> = HashSet::new();
    for profile in envelope["profiles"].as_array().into_iter().flatten() {
        let id = profile["id"]
            .as_str()
            .expect("validated profile id")
            .to_owned();
        if let Some(previous) = by_id.get(&id) {
            if profile_schema_version(profile) <= profile_schema_version(previous) {
                skipped.push(json!(id));
                continue;
            }
        }
        let device_key = profile
            .get("deviceKey")
            .and_then(Value::as_str)
            .filter(|value| !js_trim(value).is_empty())
            .map(str::to_owned);
        if let Some(key) = &device_key {
            let count = device_counts.get(key).copied().unwrap_or(0);
            if count != 1 {
                orphaned.push(json!(id));
                orphan_ids.insert(id.clone());
                identity_warnings.push(json!({
                    "type": if device_counts.contains_key(key) { "duplicate-device-key" } else { "missing-device-key" },
                    "profileId": id,
                    "deviceKey": key,
                }));
            } else {
                applied.push(json!(id));
            }
        } else {
            applied.push(json!(id));
        }
        let name = imported_name(
            profile["name"].as_str().expect("validated profile name"),
            &used_names,
        );
        used_names.insert(name.to_lowercase());
        let mut replacement = profile.clone();
        replacement["name"] = json!(name);
        match replacements.iter_mut().find(|(key, _)| key == &id) {
            Some((_, value)) => *value = replacement,
            None => replacements.push((id, replacement)),
        }
    }
    let mut merged_profiles = current.clone();
    for (id, profile) in &replacements {
        match merged_profiles
            .iter()
            .position(|item| item.get("id").and_then(Value::as_str) == Some(id.as_str()))
        {
            Some(index) => merged_profiles[index] = profile.clone(),
            None => merged_profiles.push(profile.clone()),
        }
    }
    let mut merged_settings = spread_object(current_settings);
    let envelope_settings = envelope["settings"].as_object().expect("validated settings");
    for (key, value) in envelope_settings {
        if key != "activeProfileId" && key != "activeProfileIds" {
            merged_settings.insert(key.clone(), value.clone());
        }
    }
    let applied_set: HashSet<&str> = applied.iter().filter_map(Value::as_str).collect();
    let orphan_set: HashSet<&str> = orphaned.iter().filter_map(Value::as_str).collect();
    if let Some(id) = envelope_settings.get("activeProfileId") {
        let allowed = id
            .as_str()
            .is_some_and(|id| applied_set.contains(id) && !orphan_set.contains(id));
        if allowed {
            merged_settings.insert("activeProfileId".into(), id.clone());
        } else {
            identity_warnings.push(json!({
                "type": "active-profile-skipped",
                "scope": "scalar",
                "profileId": if id.is_null() { Value::Null } else { id.clone() },
            }));
        }
    }
    if let Some(imported_active) = envelope_settings.get("activeProfileIds") {
        let mut active = match current_settings.get("activeProfileIds") {
            Some(value) if js_truthy(value) && (value.is_object() || value.is_array()) => {
                spread_object(value)
            }
            _ => Map::new(),
        };
        let imported_entries = if imported_active.is_object() || imported_active.is_array() {
            object_entries(imported_active)
        } else {
            Vec::new()
        };
        for (device_key, profile_id) in imported_entries {
            let replacement = profile_id
                .as_str()
                .and_then(|id| replacements.iter().find(|(key, _)| key == id))
                .map(|(_, profile)| profile);
            let bound_key = replacement
                .and_then(|profile| profile.get("deviceKey"))
                .and_then(Value::as_str);
            let profile_id_text = profile_id.as_str();
            if !profile_id_text.is_some_and(|id| applied_set.contains(id))
                || profile_id_text.is_some_and(|id| orphan_set.contains(id))
                || bound_key != Some(device_key.as_str())
            {
                identity_warnings.push(json!({
                    "type": "active-profile-skipped",
                    "scope": "device",
                    "deviceKey": device_key,
                    "profileId": profile_id,
                }));
                continue;
            }
            let existing_id = active.get(&device_key).cloned();
            if existing_id.as_ref().is_some_and(js_truthy)
                && existing_id.as_ref() != Some(&profile_id)
            {
                identity_warnings.push(json!({
                    "type": "active-profile-conflict",
                    "scope": "device",
                    "deviceKey": device_key,
                    "profileId": profile_id,
                    "existingProfileId": existing_id,
                }));
                continue;
            }
            active.insert(device_key, profile_id);
        }
        merged_settings.insert("activeProfileIds".into(), Value::Object(active));
    }
    Ok(Plan {
        envelope,
        profiles: Value::Array(merged_profiles),
        settings: Value::Object(merged_settings),
        applied,
        skipped,
        orphaned,
        identity_warnings,
    })
}

pub trait TransferWrite {
    fn save_profiles(&self, profiles: &Value) -> Result<(), String>;
    fn save_settings(&self, settings: &Value) -> Result<(), String>;
    fn save_recording(&self, settings: &Value) -> Result<(), String>;
}

pub struct NativeTransfer<'a> {
    pub store: &'a NativeStore,
}

impl TransferWrite for NativeTransfer<'_> {
    fn save_profiles(&self, profiles: &Value) -> Result<(), String> {
        native_json(self.store, "save-profiles", json!([profiles])).map(|_| ())
    }
    fn save_settings(&self, settings: &Value) -> Result<(), String> {
        native_json(self.store, "save-settings", json!([settings])).map(|_| ())
    }
    fn save_recording(&self, settings: &Value) -> Result<(), String> {
        native_json(self.store, "recording-save-settings", json!([settings])).map(|_| ())
    }
}

/// Commit a validated plan: profiles, settings, then recording only when the
/// envelope carries recording keys. Any failure restores every pre-image
/// best-effort and returns the original error (never a rollback error).
pub fn commit_import<W: TransferWrite>(
    writer: &W,
    plan: &Plan,
    existing: &Value,
    current_settings: &Value,
    recording_preimage: Option<&Value>,
) -> Result<(), String> {
    let mut settings = spread_object(&plan.settings);
    settings.insert(
        "deviceId".into(),
        current_settings
            .get("deviceId")
            .cloned()
            .unwrap_or(Value::Null),
    );
    settings.insert(
        "deviceKey".into(),
        current_settings
            .get("deviceKey")
            .cloned()
            .unwrap_or(Value::Null),
    );
    let settings = Value::Object(settings);
    let recording = plan.envelope["recording"]
        .as_object()
        .filter(|recording| !recording.is_empty());
    let merged_recording = recording.map(|recording| {
        let mut merged = spread_object(recording_preimage.unwrap_or(&Value::Null));
        for (key, value) in recording {
            merged.insert(key.clone(), value.clone());
        }
        Value::Object(merged)
    });
    let result = writer
        .save_profiles(&plan.profiles)
        .and_then(|_| writer.save_settings(&settings))
        .and_then(|_| match &merged_recording {
            Some(recording) => writer.save_recording(recording),
            None => Ok(()),
        });
    if let Err(error) = result {
        let _ = writer.save_profiles(existing);
        let _ = writer.save_settings(current_settings);
        if let Some(preimage) = recording_preimage {
            let _ = writer.save_recording(preimage);
        }
        return Err(error);
    }
    Ok(())
}

/// `profiles-export` handler body.
pub fn export_envelope(store: &NativeStore, devices: &Value, now: &str) -> Result<Value, String> {
    let profiles = native_json(store, "load-profiles", json!([]))?;
    let settings = native_json(store, "load-settings", json!([]))?;
    let recording = recording_settings(store)?;
    Ok(create_envelope(
        env!("CARGO_PKG_VERSION"),
        &profiles,
        &settings,
        &recording,
        devices,
        now,
    ))
}

fn wire_field<'a>(entries: &'a [(String, WireValue)], key: &str) -> Option<&'a WireValue> {
    entries.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// Top-level transfer settings/recording are consumed by `pick`, whose
/// per-key `cloneJson` turns an own `undefined` property into `null`. Build
/// that source from the raw wire object so the property is retained; nested
/// profile settings still use JSON.stringify semantics (undefined dropped).
fn wire_pick_source(value: &WireValue) -> Result<Option<Value>, String> {
    let WireValue::Object(entries) = value else {
        return Ok(None);
    };
    let mut picked = Map::new();
    for (key, value) in entries {
        picked.insert(key.clone(), wire_payload_json(value)?);
    }
    Ok(Some(Value::Object(picked)))
}

/// JSON.stringify semantics for an import payload arriving over the wire:
/// object properties holding `undefined` disappear, array `undefined` and
/// non-finite numbers become null, and `-0` becomes 0.
fn wire_payload_json(value: &WireValue) -> Result<Value, String> {
    Ok(match value {
        WireValue::Undefined => Value::Null,
        WireValue::Null => Value::Null,
        WireValue::Bool(value) => json!(value),
        WireValue::String(value) => json!(value),
        WireValue::Number(number) => Value::Number(number.clone()),
        WireValue::SpecialNumber(text) if text == "-0" => json!(0),
        WireValue::SpecialNumber(_) => Value::Null,
        WireValue::BigInt(_) => {
            return Err("Do not know how to serialize a BigInt".into());
        }
        WireValue::Array(items) => Value::Array(
            items
                .iter()
                .map(wire_payload_json)
                .collect::<Result<_, _>>()?,
        ),
        WireValue::Object(entries) => {
            let mut map = Map::new();
            for (key, value) in entries {
                if matches!(value, WireValue::Undefined) {
                    continue;
                }
                map.insert(key.clone(), wire_payload_json(value)?);
            }
            Value::Object(map)
        }
    })
}

/// `profiles-import` handler body.
pub fn import_payload(
    store: &NativeStore,
    payload: &WireValue,
    devices: &Value,
) -> Result<Value, String> {
    if matches!(payload, WireValue::Undefined | WireValue::Null) {
        return Err("Profile import must be a JSON object".into());
    }
    let mut incoming = wire_payload_json(payload)?;
    if let (WireValue::Object(entries), Some(incoming)) = (payload, incoming.as_object_mut()) {
        for key in ["settings", "recording"] {
            if let Some(raw) = wire_field(entries, key) {
                if let Some(picked) = wire_pick_source(raw)? {
                    incoming.insert(key.into(), picked);
                }
            }
        }
    }
    let existing = native_json(store, "load-profiles", json!([]))?;
    let current_settings = native_json(store, "load-settings", json!([]))?;
    let plan = plan_import(&incoming, &existing, devices, &current_settings)?;
    let recording_preimage = recording_settings(store)?;
    let writer = NativeTransfer { store };
    commit_import(
        &writer,
        &plan,
        &existing,
        &current_settings,
        Some(&recording_preimage),
    )?;
    let profiles = native_json(store, "load-profiles", json!([]))?;
    let settings = native_json(store, "load-settings", json!([]))?;
    Ok(json!({
        "profiles": profiles,
        "settings": settings,
        "applied": plan.applied,
        "skipped": plan.skipped,
        "orphaned": plan.orphaned,
        "identityWarnings": plan.identity_warnings,
        "imported": plan.applied.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "arc-profile-transfer-test-{:032x}",
                rand::random::<u128>()
            ));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn store(&self) -> NativeStore {
            NativeStore::new(self.0.clone(), "advanced").unwrap()
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn call(store: &NativeStore, method: &str, args: Value) -> Result<Value, String> {
        let encoded = store.invoke(method, &super::super::wire::encode_json(&args)?)?;
        super::super::wire::decode(&encoded)?.into_json()
    }

    fn seed(store: &NativeStore, initial: &Value) {
        if let Some(profiles) = initial.get("profiles") {
            call(store, "save-profiles", json!([profiles])).unwrap();
        }
        if let Some(settings) = initial.get("settings") {
            call(store, "save-settings", json!([settings])).unwrap();
        }
        if let Some(recording) = initial.get("recordingSettings") {
            call(store, "recording-save-settings", json!([recording])).unwrap();
        }
    }

    fn fixture_wire(value: &Value) -> WireValue {
        if let Value::Object(map) = value {
            if map.len() == 1 {
                if let Some(Value::String(marker)) = map.get("$wire") {
                    return match marker.as_str() {
                        "undefined" => WireValue::Undefined,
                        "nan" => WireValue::SpecialNumber("NaN".into()),
                        "infinity" => WireValue::SpecialNumber("Infinity".into()),
                        "-infinity" => WireValue::SpecialNumber("-Infinity".into()),
                        "-0" => WireValue::SpecialNumber("-0".into()),
                        other => panic!("unknown wire marker {other}"),
                    };
                }
            }
            return WireValue::Object(
                map.iter()
                    .map(|(key, value)| (key.clone(), fixture_wire(value)))
                    .collect(),
            );
        }
        match value {
            Value::Null => WireValue::Null,
            Value::Bool(value) => WireValue::Bool(*value),
            Value::String(value) => WireValue::String(value.clone()),
            Value::Number(number) => WireValue::Number(number.clone()),
            Value::Array(items) => WireValue::Array(items.iter().map(fixture_wire).collect()),
            Value::Object(_) => unreachable!(),
        }
    }

    fn fixture() -> Value {
        serde_json::from_str(include_str!("fixtures/profile-transfer-parity.json")).unwrap()
    }

    /// Store-owned normalization is free to order map keys and print integral
    /// numbers as floats; the Electron fixture pins values, not the native
    /// settings owner's serialization order.
    fn json_equal(actual: &Value, expected: &Value) -> bool {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => {
                a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
            }
            (Value::Object(a), Value::Object(b)) => {
                a.len() == b.len()
                    && a.iter()
                        .all(|(key, value)| b.get(key).is_some_and(|other| json_equal(value, other)))
            }
            _ => actual == expected,
        }
    }

    fn assert_json_equal(actual: &Value, expected: &str, label: &str) {
        let expected: Value = serde_json::from_str(expected).unwrap();
        assert!(json_equal(actual, &expected), "{label}\nactual: {actual}\nexpected: {expected}");
    }

    /// Validation failures never touch the recording sidecar, and the native
    /// default recording location differs from the fixture's temporary root.
    fn assert_unchanged_profiles_and_settings(store: &NativeStore, expected: &Value, label: &str) {
        let expected: Value = serde_json::from_str(expected.as_str().expect("expectedAfterJson")).unwrap();
        let after = json!({
            "profiles": call(store, "load-profiles", json!([])).unwrap(),
            "settings": call(store, "load-settings", json!([])).unwrap(),
        });
        let expected = json!({"profiles": expected["profiles"], "settings": expected["settings"]});
        assert!(json_equal(&after, &expected), "{label}\nactual: {after}\nexpected: {expected}");
    }

    #[test]
    fn export_fixture_matches_the_electron_sources() {
        let data = fixture();
        for case in data["export"].as_array().unwrap() {
            let initial = &case["initial"];
            let actual = create_envelope(
                env!("CARGO_PKG_VERSION"),
                &initial["profiles"],
                &initial["settings"],
                &initial["recordingSettings"],
                &case["devices"],
                data["fixedNow"].as_str().unwrap(),
            );
            assert_eq!(
                serde_json::to_string(&actual).unwrap(),
                case["expectedJson"].as_str().unwrap(),
                "export case {}",
                case["name"]
            );
        }
    }

    #[test]
    fn import_fixture_matches_the_electron_handler() {
        let data = fixture();
        for case in data["import"].as_array().unwrap() {
            let temp = Temp::new();
            let store = temp.store();
            seed(&store, &case["initial"]);
            let payload = case["args"]
                .as_array()
                .and_then(|args| args.first())
                .map(fixture_wire)
                .unwrap_or(WireValue::Undefined);
            let result = import_payload(&store, &payload, &case["devices"]);
            match case["error"].as_str() {
                Some(error) => {
                    assert_eq!(result.unwrap_err(), error, "import case {}", case["name"]);
                    assert_unchanged_profiles_and_settings(
                        &store,
                        &case["expectedAfterJson"],
                        case["name"].as_str().unwrap(),
                    );
                }
                None => assert_json_equal(
                    &result.unwrap(),
                    case["expectedJson"].as_str().unwrap(),
                    case["name"].as_str().unwrap(),
                ),
            }
            if let Some(expected) = case["expectedAfterRecordingJson"].as_str() {
                assert_json_equal(
                    &recording_settings(&store).unwrap(),
                    expected,
                    &format!("{} recording", case["name"]),
                );
            }
        }
    }

    #[test]
    fn export_envelope_reads_native_recording_settings_and_keeps_the_subset() {
        let temp = Temp::new();
        let store = temp.store();
        seed(
            &store,
            &json!({
                "profiles": [{"id": "p1", "name": "Gaming", "createdAt": "2024-01-01T00:00:00.000Z", "schemaVersion": 1, "settings": {}, "ocOnBoot": false, "deviceKey": "gpu-a"}],
                "settings": {"theme": "light"},
                "recordingSettings": {"mode": "video", "fps": 30, "resolution": "1080p", "location": "C:\\Fixture\\Recordings"},
            }),
        );
        let devices = json!([{"deviceKey": "gpu-a"}, {"deviceKey": "gpu-a"}]);
        let envelope = export_envelope(&store, &devices, "2026-11-10T12:34:56.789Z").unwrap();
        assert_eq!(envelope["productVersion"], env!("CARGO_PKG_VERSION"));
        assert_eq!(envelope["exportedAt"], "2026-11-10T12:34:56.789Z");
        assert_eq!(envelope["deviceKeys"], json!(["gpu-a"]));
        assert_eq!(envelope["recording"]["fps"], 30);
        assert_eq!(envelope["recording"]["resolution"], "1080p");
        assert!(envelope["recording"].get("location").is_none());
    }

    #[test]
    fn native_import_preserves_device_identity_and_writes_the_recording_patch() {
        let temp = Temp::new();
        let store = temp.store();
        seed(
            &store,
            &json!({
                "profiles": [],
                "settings": {"deviceId": 4, "deviceKey": "gpu-a", "theme": "dark"},
                "recordingSettings": {"mode": "video", "fps": 60, "location": "C:\\Fixture\\Recordings"},
            }),
        );
        let payload = json!({
            "format": PROFILE_TRANSFER_FORMAT,
            "schemaVersion": 1,
            "profiles": [{
                "id": "p1", "name": "Imported", "schemaVersion": 1,
                "settings": {}, "ocOnBoot": false, "deviceKey": "gpu-a",
            }],
            "settings": {"theme": "light"},
            "recording": {"fps": 30},
        });
        let payload = super::super::wire::decode(
            &super::super::wire::encode_json(&payload).unwrap(),
        )
        .unwrap();
        let result = import_payload(&store, &payload, &json!([{"deviceKey": "gpu-a"}])).unwrap();
        assert_eq!(result["settings"]["deviceId"], 4);
        assert_eq!(result["settings"]["deviceKey"], "gpu-a");
        assert_eq!(result["settings"]["theme"], "light");
        assert_eq!(result["imported"], 1);
        let recording = recording_settings(&store).unwrap();
        assert_eq!(recording["fps"], 30);
        assert_eq!(recording["location"], "C:\\Fixture\\Recordings");
    }

    #[test]
    fn export_truncates_names_at_code_point_boundaries() {
        let name = format!("{}😀", "a".repeat(127));
        let device_name = format!("{}😀", "a".repeat(255));
        let envelope = create_envelope(
            env!("CARGO_PKG_VERSION"),
            &json!([{
                "id": "p1", "name": name, "createdAt": "2024-01-01T00:00:00.000Z",
                "schemaVersion": 1, "settings": {}, "ocOnBoot": false,
                "deviceName": device_name,
            }]),
            &json!({}),
            &json!({}),
            &json!([]),
            "2026-11-10T12:34:56.789Z",
        );
        let profile = &envelope["profiles"][0];
        assert_eq!(profile["name"], "a".repeat(127));
        assert_eq!(profile["deviceName"], "a".repeat(255));
        let serialized = serde_json::to_string(&envelope).unwrap();
        assert!(!serialized.contains('\u{fffd}'));
    }

    struct FakeWriter {
        profiles: std::cell::RefCell<Value>,
        settings: std::cell::RefCell<Value>,
        recording: std::cell::RefCell<Value>,
        fail_step: String,
        failed: std::cell::Cell<bool>,
        calls: std::cell::RefCell<Vec<&'static str>>,
    }
    impl FakeWriter {
        fn new(initial: &Value, fail_step: &str) -> Self {
            Self {
                profiles: std::cell::RefCell::new(initial["profiles"].clone()),
                settings: std::cell::RefCell::new(initial["settings"].clone()),
                recording: std::cell::RefCell::new(initial["recordingSettings"].clone()),
                fail_step: fail_step.to_owned(),
                failed: std::cell::Cell::new(false),
                calls: std::cell::RefCell::new(Vec::new()),
            }
        }
        fn step(&self, step: &'static str) -> Result<(), String> {
            self.calls.borrow_mut().push(step);
            if step == self.fail_step && !self.failed.replace(true) {
                return Err(format!("{step} write failed"));
            }
            Ok(())
        }
    }
    impl TransferWrite for FakeWriter {
        fn save_profiles(&self, profiles: &Value) -> Result<(), String> {
            self.step("profiles")?;
            *self.profiles.borrow_mut() = profiles.clone();
            Ok(())
        }
        fn save_settings(&self, settings: &Value) -> Result<(), String> {
            self.step("settings")?;
            *self.settings.borrow_mut() = settings.clone();
            Ok(())
        }
        fn save_recording(&self, settings: &Value) -> Result<(), String> {
            self.step("recording")?;
            *self.recording.borrow_mut() = settings.clone();
            Ok(())
        }
    }

    #[test]
    fn failed_import_restores_every_preimage_and_returns_the_original_error() {
        let data = fixture();
        let rollback = &data["importRollback"];
        let initial = &rollback["initial"];
        for result in rollback["results"].as_array().unwrap() {
            let fail_step = result["failStep"].as_str().unwrap();
            assert_eq!(
                result["initialJson"].as_str().unwrap(),
                result["afterJson"].as_str().unwrap(),
                "{fail_step} fixture state"
            );
            let plan = plan_import(
                &rollback["payload"],
                &initial["profiles"],
                &rollback["devices"],
                &initial["settings"],
            )
            .unwrap();
            let writer = FakeWriter::new(initial, fail_step);
            let error = commit_import(
                &writer,
                &plan,
                &initial["profiles"],
                &initial["settings"],
                Some(&initial["recordingSettings"]),
            )
            .unwrap_err();
            assert_eq!(error, result["error"].as_str().unwrap());
            assert_eq!(*writer.profiles.borrow(), initial["profiles"], "{fail_step}");
            assert_eq!(*writer.settings.borrow(), initial["settings"], "{fail_step}");
            assert_eq!(*writer.recording.borrow(), initial["recordingSettings"], "{fail_step}");
            let calls = writer.calls.borrow();
            let prefix = match fail_step {
                "profiles" => vec!["profiles"],
                "settings" => vec!["profiles", "settings"],
                _ => vec!["profiles", "settings", "recording"],
            };
            assert_eq!(&calls[..prefix.len()], prefix.as_slice());
            // Rollback always restores all three pre-images (best-effort).
            assert_eq!(
                &calls[prefix.len()..],
                &["profiles", "settings", "recording"],
                "{fail_step}"
            );
        }
    }

    #[test]
    fn import_merges_recording_keys_over_the_preimage() {
        let initial = json!({
            "profiles": [],
            "settings": {},
            "recordingSettings": {"mode": "video", "fps": 60, "location": "C:\\Fixture"},
        });
        let plan = plan_import(
            &json!({
                "format": PROFILE_TRANSFER_FORMAT,
                "schemaVersion": 1,
                "profiles": [],
                "recording": {"fps": 30, "showCursor": true, "location": "C:\\Nope"},
            }),
            &initial["profiles"],
            &json!([]),
            &initial["settings"],
        )
        .unwrap();
        let writer = FakeWriter::new(&initial, "");
        commit_import(
            &writer,
            &plan,
            &initial["profiles"],
            &initial["settings"],
            Some(&initial["recordingSettings"]),
        )
        .unwrap();
        assert_eq!(&*writer.calls.borrow(), &["profiles", "settings", "recording"]);
        let recording = writer.recording.borrow();
        assert_eq!(recording["fps"], 30);
        assert_eq!(recording["showCursor"], true);
        assert_eq!(recording["mode"], "video");
        assert_eq!(recording["location"], "C:\\Fixture");
    }

    #[test]
    fn import_skips_recording_writes_when_the_envelope_has_no_recording_keys() {
        let initial = json!({"profiles": [], "settings": {}, "recordingSettings": {}});
        let plan = plan_import(
            &json!({
                "format": PROFILE_TRANSFER_FORMAT,
                "schemaVersion": 1,
                "profiles": [],
            }),
            &initial["profiles"],
            &json!([]),
            &initial["settings"],
        )
        .unwrap();
        let writer = FakeWriter::new(&initial, "");
        commit_import(
            &writer,
            &plan,
            &initial["profiles"],
            &initial["settings"],
            Some(&initial["recordingSettings"]),
        )
        .unwrap();
        assert_eq!(&*writer.calls.borrow(), &["profiles", "settings"]);
        assert_eq!(*writer.recording.borrow(), initial["recordingSettings"]);
    }
}
