//! Native `profiles-save` / `profiles-delete` writes.
//!
//! `sanitize_settings` is a direct port of `sanitizeSettings` in
//! `src/main/ipc-core.js`: same 15-control whitelist, same finite-number and
//! VF cross-rules, same error text. The store still owns the schemaVersion and
//! physical-GPU identity normalization; this module only builds the payload
//! the Electron handler would have handed to `ProfileStore.saveProfile`.
use super::{
    native_store::NativeStore,
    platform_context,
    profile_store::{is_js_whitespace, js_trim},
    services::native_json,
    wire::WireValue,
};
use serde_json::{json, Map, Value};

const CONTROLS: [&str; 15] = [
    "powerLimitW",
    "gpuVoltOffsetV",
    "gpuFreqOffsetMhz",
    "tempLimitC",
    "vramFreqOffsetGts",
    "vramVoltOffsetV",
    "gpuLock",
    "vfCurve",
    "vfCurveResetToDefault",
    "vfCurveProfileStock",
    "vfCurveBaseline",
    "vfCurveStockReference",
    "fanMode",
    "fanCurve",
    "fixedFanPct",
];
const SCALAR_CONTROLS: [&str; 7] = [
    "powerLimitW",
    "gpuVoltOffsetV",
    "gpuFreqOffsetMhz",
    "tempLimitC",
    "vramFreqOffsetGts",
    "vramVoltOffsetV",
    "fixedFanPct",
];
const FAN_MODES: [&str; 3] = ["auto", "curve", "fixed"];
// ctl_fan_speed_table_t.table size - must match pure/curve.ts MAX_CURVE_POINTS.
const MAX_CURVE_POINTS: usize = 32;

fn field<'a>(entries: &'a [(String, WireValue)], key: &str) -> Option<&'a WireValue> {
    entries.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

/// `Number.isFinite` plus the tagged wire values: `-0` is a finite JavaScript
/// number, while NaN/Infinity and `undefined` are rejected. JSON.stringify
/// serializes JavaScript `-0` as 0, which is the persisted form here too.
fn finite_json(value: &WireValue) -> Option<Value> {
    match value {
        WireValue::Number(number) => Some(Value::Number(number.clone())),
        WireValue::SpecialNumber(text) if text == "-0" => Some(json!(0)),
        _ => None,
    }
}

fn is_scalar(key: &str) -> bool {
    SCALAR_CONTROLS.contains(&key)
}

fn sanitize_curve(key: &str, value: &WireValue) -> Result<Value, String> {
    let WireValue::Array(points) = value else {
        return Err(format!(
            "{key} must be a non-empty array of at most {MAX_CURVE_POINTS} points"
        ));
    };
    if points.is_empty() || points.len() > MAX_CURVE_POINTS {
        return Err(format!(
            "{key} must be a non-empty array of at most {MAX_CURVE_POINTS} points"
        ));
    }
    let fields: [&str; 2] = if key != "fanCurve" {
        ["voltageV", "freqMhz"]
    } else {
        ["t", "speedPct"]
    };
    let mut clean_points = Vec::with_capacity(points.len());
    for point in points {
        let WireValue::Object(entries) = point else {
            return Err(format!(
                "{key} points must be objects with finite {}",
                fields.join(", ")
            ));
        };
        let mut clean = Map::new();
        for name in fields {
            let Some(raw) = field(entries, name) else {
                return Err(format!(
                    "{key} points must be objects with finite {}",
                    fields.join(", ")
                ));
            };
            let Some(value) = finite_json(raw) else {
                return Err(format!(
                    "{key} points must be objects with finite {}",
                    fields.join(", ")
                ));
            };
            clean.insert(name.to_owned(), value);
        }
        clean_points.push(Value::Object(clean));
    }
    Ok(Value::Array(clean_points))
}

/// Port of `sanitizeSettings` (`src/main/ipc-core.js`).
pub fn sanitize_settings(payload: &WireValue) -> Result<Value, String> {
    let WireValue::Object(entries) = payload else {
        return Err("apply-settings payload must be a plain object".into());
    };
    let mut out = Map::new();
    for (key, value) in entries {
        if !CONTROLS.contains(&key.as_str()) {
            return Err(format!("unknown control: {key}"));
        }
        if is_scalar(key) {
            let Some(number) = finite_json(value) else {
                return Err(format!("{key} must be a finite number"));
            };
            out.insert(key.clone(), number);
        } else if key == "fanMode" {
            let WireValue::String(mode) = value else {
                return Err("fanMode must be one of: auto, curve, fixed".into());
            };
            if !FAN_MODES.contains(&mode.as_str()) {
                return Err("fanMode must be one of: auto, curve, fixed".into());
            }
            out.insert(key.clone(), json!(mode));
        } else if key == "gpuLock" {
            let WireValue::Object(lock) = value else {
                return Err("gpuLock must be { voltageV: number, freqMhz: number }".into());
            };
            let voltage = field(lock, "voltageV").and_then(finite_json);
            let frequency = field(lock, "freqMhz").and_then(finite_json);
            let (Some(voltage), Some(frequency)) = (voltage, frequency) else {
                return Err("gpuLock must be { voltageV: number, freqMhz: number }".into());
            };
            out.insert(
                key.clone(),
                json!({"voltageV": voltage, "freqMhz": frequency}),
            );
        } else if key == "vfCurveResetToDefault" {
            if value != &WireValue::Bool(true) {
                return Err("vfCurveResetToDefault must be true".into());
            }
            out.insert(key.clone(), json!(true));
        } else if key == "vfCurveProfileStock" {
            if value != &WireValue::Bool(true) {
                return Err("vfCurveProfileStock must be true".into());
            }
            out.insert(key.clone(), json!(true));
        } else if key == "vfCurve"
            || key == "vfCurveBaseline"
            || key == "vfCurveStockReference"
            || key == "fanCurve"
        {
            out.insert(key.clone(), sanitize_curve(key, value)?);
        }
    }
    let refs: Vec<&str> = ["vfCurveBaseline", "vfCurveStockReference"]
        .into_iter()
        .filter(|key| out.contains_key(*key))
        .collect();
    if refs.len() > 1
        || (!refs.is_empty()
            && (!out.get("vfCurve").is_some_and(Value::is_array)
                || out.get("vfCurveResetToDefault") == Some(&Value::Bool(true))))
    {
        return Err("VF references require vfCurve and cannot be combined with each other or reset intent".into());
    }
    for key in &refs {
        let points = out[*key].as_array().expect("validated curve");
        let curve = out["vfCurve"].as_array().expect("guard checked vfCurve");
        let valid = points.len() >= 2
            && points.len() == curve.len()
            && points.iter().enumerate().all(|(index, point)| {
                let voltage = point["voltageV"].as_f64().unwrap_or(f64::NAN);
                let frequency = point["freqMhz"].as_f64().unwrap_or(f64::NAN);
                voltage > 0.0
                    && frequency >= 0.0
                    && (index == 0 || {
                        let previous = &points[index - 1];
                        voltage > previous["voltageV"].as_f64().unwrap_or(f64::NAN)
                            && frequency >= previous["freqMhz"].as_f64().unwrap_or(f64::NAN)
                    })
            });
        if !valid {
            return Err("Invalid VF reference shape".into());
        }
    }
    if out.get("vfCurveResetToDefault") == Some(&Value::Bool(true))
        && !out.get("vfCurve").is_some_and(Value::is_array)
    {
        return Err("vfCurveResetToDefault requires vfCurve".into());
    }
    if out.get("vfCurveProfileStock") == Some(&Value::Bool(true))
        && (out.get("vfCurve").is_some_and(Value::is_array)
            || !refs.is_empty()
            || out.get("vfCurveResetToDefault") == Some(&Value::Bool(true)))
    {
        return Err("vfCurveProfileStock cannot include explicit VF curve points or reference metadata".into());
    }
    if out.get("vfCurveProfileStock") == Some(&Value::Bool(true))
        && (out
            .get("gpuFreqOffsetMhz")
            .and_then(Value::as_f64)
            .is_some_and(|value| value != 0.0)
            || out
                .get("gpuVoltOffsetV")
                .and_then(Value::as_f64)
                .is_some_and(|value| value != 0.0))
    {
        return Err("vfCurveProfileStock cannot be combined with nonzero core offsets".into());
    }
    Ok(Value::Object(out))
}

fn now_iso(now: Option<&str>) -> Result<String, String> {
    match now {
        Some(now) => Ok(now.to_owned()),
        None => platform_context::clock_snapshot()
            .map(|clock| clock.now_iso)
            .map_err(|error| error.to_string()),
    }
}

/// Store-facing profile identity. `undefined` means the Electron conditional
/// spread omits the field, so the store keeps any prior binding. `null` is the
/// only explicit nullish value the store treats as "fall back to the previous
/// profile"; every other non-string is an explicit invalid value that must
/// normalize to null instead. A boolean preserves that distinction without
/// pretending to be a valid identity.
fn identity_value(value: &WireValue) -> Option<Value> {
    match value {
        WireValue::Undefined => None,
        WireValue::String(text) => Some(json!(text)),
        WireValue::Null => Some(Value::Null),
        _ => Some(json!(false)),
    }
}

/// `profiles-save` handler body. `now` overrides the fallback createdAt for
/// fixture tests; production passes `None` and reads the platform clock.
pub fn save_profile(
    store: &NativeStore,
    args: &WireValue,
    now: Option<&str>,
) -> Result<Value, String> {
    let WireValue::Array(items) = args else {
        return Err("Expected argument array".into());
    };
    let profile = items.first().unwrap_or(&WireValue::Undefined);
    let WireValue::Object(entries) = profile else {
        return Err("profiles-save: profile must be an object".into());
    };
    let Some(WireValue::String(id)) = field(entries, "id") else {
        return Err("profiles-save: id must be a non-empty string".into());
    };
    if id.is_empty() {
        return Err("profiles-save: id must be a non-empty string".into());
    }
    if id.chars().any(is_js_whitespace) {
        return Err("profiles-save: id must not contain whitespace".into());
    }
    let Some(WireValue::String(name)) = field(entries, "name") else {
        return Err("profiles-save: name must be a non-empty string".into());
    };
    let name = js_trim(name);
    if name.is_empty() {
        return Err("profiles-save: name must be a non-empty string".into());
    }
    let Some(WireValue::Bool(oc_on_boot)) = field(entries, "ocOnBoot") else {
        return Err("profiles-save: ocOnBoot must be a boolean".into());
    };
    let settings = match field(entries, "settings") {
        None | Some(WireValue::Undefined) | Some(WireValue::Null) => json!({}),
        Some(value) => sanitize_settings(value)?,
    };
    let profiles = native_json(store, "load-profiles", json!([]))?;
    let existing = profiles
        .as_array()
        .and_then(|list| {
            list.iter().find(|candidate| {
                candidate.get("id").and_then(Value::as_str) == Some(id.as_str())
            })
        });
    let created_at = if let Some(value) = existing
        .and_then(|profile| profile.get("createdAt"))
        .filter(|value| !value.is_null())
    {
        value.clone()
    } else if let Some(WireValue::String(value)) = field(entries, "createdAt") {
        json!(value)
    } else {
        json!(now_iso(now)?)
    };
    let mut saved = Map::new();
    saved.insert("id".into(), json!(id));
    saved.insert("name".into(), json!(name));
    saved.insert("createdAt".into(), created_at);
    saved.insert("settings".into(), settings);
    saved.insert("ocOnBoot".into(), json!(oc_on_boot));
    for key in ["deviceKey", "deviceName"] {
        if let Some(value) = field(entries, key).and_then(identity_value) {
            saved.insert(key.into(), value);
        }
    }
    native_json(store, "save-profile", json!([Value::Object(saved)]))?;
    let profiles = native_json(store, "load-profiles", json!([]))?;
    let settings = native_json(store, "load-settings", json!([]))?;
    Ok(json!({"profiles": profiles, "settings": settings}))
}

fn active_map_without(settings: &Value, id: &str) -> Option<Value> {
    let active = settings.get("activeProfileIds")?;
    if !active.is_object() && !active.is_array() {
        return None;
    }
    let mut out = Map::new();
    if let Some(map) = active.as_object() {
        for (device_key, profile_id) in map {
            if profile_id.as_str() != Some(id) {
                out.insert(device_key.clone(), profile_id.clone());
            }
        }
    } else if let Some(array) = active.as_array() {
        for (index, profile_id) in array.iter().enumerate() {
            if profile_id.as_str() != Some(id) {
                out.insert(index.to_string(), profile_id.clone());
            }
        }
    }
    Some(Value::Object(out))
}

/// `profiles-delete` handler body.
pub fn delete_profile(store: &NativeStore, args: &WireValue) -> Result<Value, String> {
    let WireValue::Array(items) = args else {
        return Err("Expected argument array".into());
    };
    let Some(WireValue::String(id)) = items.first() else {
        return Err("profiles-delete: id must be a non-empty string".into());
    };
    if id.is_empty() {
        return Err("profiles-delete: id must be a non-empty string".into());
    }
    native_json(store, "delete-profile", json!([id]))?;
    let settings = native_json(store, "load-settings", json!([]))?;
    let active_map = active_map_without(&settings, id);
    let scalar_matches = settings.get("activeProfileId").and_then(Value::as_str) == Some(id.as_str());
    if active_map.is_some() || scalar_matches {
        let mut next = settings.as_object().cloned().unwrap_or_default();
        next.insert(
            "activeProfileIds".into(),
            active_map.unwrap_or_else(|| json!({})),
        );
        let scalar = if scalar_matches {
            Value::Null
        } else {
            settings.get("activeProfileId").cloned().unwrap_or(Value::Null)
        };
        next.insert("activeProfileId".into(), scalar);
        native_json(store, "save-settings", json!([Value::Object(next)]))?;
    }
    let remaining = native_json(store, "load-profiles", json!([]))?;
    // The native game store only accepts string ids. Non-string legacy ids
    // can never match an association key, so dropping them preserves the
    // Electron cleanup outcome while keeping the best-effort call valid.
    let remaining_ids: Vec<Value> = remaining
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|profile| profile.get("id").and_then(Value::as_str).map(|id| json!(id)))
        .collect();
    let _ = native_json(store, "game-cleanup-profile", json!([id, remaining_ids]));
    let profiles = native_json(store, "load-profiles", json!([]))?;
    let settings = native_json(store, "load-settings", json!([]))?;
    Ok(json!({"profiles": profiles, "settings": settings}))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Temp(std::path::PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "arc-profile-write-test-{:032x}",
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
    }

    /// Fixture values carry `{ "$wire": "nan" | "undefined" | "-0" | ... }`
    /// markers because JSON cannot express the tagged wire vocabulary.
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

    fn fixture_args(values: &Value) -> WireValue {
        WireValue::Array(
            values
                .as_array()
                .expect("fixture args array")
                .iter()
                .map(fixture_wire)
                .collect(),
        )
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

    fn assert_after(store: &NativeStore, expected: &Value, label: &str) {
        let expected: Value = serde_json::from_str(expected.as_str().expect("expectedAfterJson")).unwrap();
        // save/delete never touch the recording sidecar; compare the two
        // sidecars they own.
        let after = json!({
            "profiles": call(store, "load-profiles", json!([])).unwrap(),
            "settings": call(store, "load-settings", json!([])).unwrap(),
        });
        let expected = json!({"profiles": expected["profiles"], "settings": expected["settings"]});
        assert!(json_equal(&after, &expected), "{label}\nactual: {after}\nexpected: {expected}");
    }

    #[test]
    fn sanitize_fixture_matches_the_electron_validator() {
        let data = fixture();
        for case in data["sanitize"].as_array().unwrap() {
            let result = sanitize_settings(&fixture_wire(&case["input"]));
            match case["error"].as_str() {
                Some(error) => assert_eq!(
                    result.unwrap_err(),
                    error,
                    "sanitize case {}",
                    case["name"]
                ),
                None => assert_eq!(
                    serde_json::to_string(&result.unwrap()).unwrap(),
                    case["expectedJson"].as_str().unwrap(),
                    "sanitize case {}",
                    case["name"]
                ),
            }
        }
    }

    #[test]
    fn save_fixture_matches_the_electron_handler() {
        let data = fixture();
        let now = data["fixedNow"].as_str().unwrap();
        for case in data["save"].as_array().unwrap() {
            let temp = Temp::new();
            let store = temp.store();
            seed(&store, &case["initial"]);
            let result = save_profile(&store, &fixture_args(&case["args"]), Some(now));
            match case["error"].as_str() {
                Some(error) => {
                    assert_eq!(result.unwrap_err(), error, "save case {}", case["name"]);
                    assert_after(&store, &case["expectedAfterJson"], case["name"].as_str().unwrap());
                }
                None => assert_json_equal(
                    &result.unwrap(),
                    case["expectedJson"].as_str().unwrap(),
                    case["name"].as_str().unwrap(),
                ),
            }
        }
    }

    #[test]
    fn delete_fixture_matches_the_electron_handler() {
        let data = fixture();
        for case in data["delete"].as_array().unwrap() {
            let temp = Temp::new();
            let store = temp.store();
            seed(&store, &case["initial"]);
            let result = delete_profile(&store, &fixture_args(&case["args"]));
            match case["error"].as_str() {
                Some(error) => {
                    assert_eq!(result.unwrap_err(), error, "delete case {}", case["name"]);
                    assert_after(&store, &case["expectedAfterJson"], case["name"].as_str().unwrap());
                }
                None => assert_json_equal(
                    &result.unwrap(),
                    case["expectedJson"].as_str().unwrap(),
                    case["name"].as_str().unwrap(),
                ),
            }
        }
    }
}
