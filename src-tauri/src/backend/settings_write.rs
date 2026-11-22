//! Pure preparation of ProfileStore._saveSettingsNow's persisted envelope and
//! next cache. Deliberately performs no filesystem access or cache mutation.
use super::migrations::SCHEMA_VERSION;
use super::settings::normalize_settings;
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct SettingsWrite {
    pub persisted: Value,
    pub cache: Value,
}

fn is_true(value: Option<&Value>) -> bool {
    value == Some(&Value::Bool(true))
}

/// Normalize one field through the read normalizer without building a whole
/// envelope. The settings patch reuses this for `monitorLogMetrics`, whose
/// patch-time normalization is the same function the read path applies.
pub(crate) fn normalized_field(key: &str, value: &Value, default: &str) -> Value {
    let mut data = Map::new();
    data.insert(key.to_owned(), value.clone());
    normalize_settings(Some(&Value::Object(data)), default)[key].clone()
}

/// Pure equivalent of an immediate write, after the caller has serialized its
/// write queue and loaded the current cache. Generic settings snapshots cannot
/// replace Arc Sleep state; only arc_sleep_patch owns those fields.
///
/// Persisted and cache values must not be collapsed into one: legacy additive
/// fields, unnormalized cached Arc Sleep data, activeProfileId and inherited
/// recordingToastsEnabled can intentionally produce different envelopes.
pub fn prepare_settings_write(
    settings: &Value,
    cached: &Value,
    arc_sleep_patch: Option<&Value>,
    oc_mode_default: &str,
) -> Result<SettingsWrite, String> {
    if settings.is_null() {
        return Err("Cannot read properties of null (reading 'waiverAccepted')".into());
    }
    if cached.is_null() {
        return Err("Cannot read properties of null (reading 'arcSleep')".into());
    }
    let normalized = normalize_settings(Some(settings), oc_mode_default);
    let mut persisted = Map::new();
    persisted.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    // Keep the source envelope's insertion order as well as its values.
    for key in [
        "waiverAccepted", "ocOnBoot", "activeProfileId", "ocMode", "advancedModeAccepted",
        "startWithWindows", "startMinimized", "closeToTray", "monitorLogToFile",
        "deviceId", "deviceKey", "theme", "memorySavingMode", "overlayEnabled",
        "overlayHotkeyLetter", "postprocessScaleHotkey", "overlayPosition", "overlayScale",
        "overlayColor", "overlayLabelColor", "overlayValueColor", "overlayTemperatureUnit",
        "overlayDeviceKeys", "overlayStats", "overlayBgEnabled", "overlayBgColor",
        "overlayBgOpacity", "overlayChipNames", "overlayPollMs", "overlayTheme",
        "overlayRecordingPill", "advancedOverlayEnabled", "advancedOverlayHotkeyLetter",
        "advancedOverlayPosition",
    ] {
        persisted.insert(key.into(), normalized[key].clone());
    }
    // Save uses ?? null here; read normalization accepts strings only.
    persisted.insert("activeProfileId".into(), settings.get("activeProfileId").cloned().unwrap_or(Value::Null));
    let memory_saving = json!(is_true(settings.get("memorySavingMode").or_else(|| cached.get("memorySavingMode"))));
    persisted.insert("memorySavingMode".into(), memory_saving.clone());

    let mut arc_sleep = cached.get("arcSleep").cloned().unwrap_or(Value::Null);
    if let Some(patch) = arc_sleep_patch.and_then(|p| p.get("arcSleep")) {
        // Object spread only contributes named policy keys from JSON objects;
        // strings/arrays contribute numeric properties which normalization drops.
        let mut merged = arc_sleep.as_object().cloned().unwrap_or_default();
        if let Some(patch) = patch.as_object() {
            for (key, value) in patch { merged.insert(key.clone(), value.clone()); }
        }
        arc_sleep = Value::Object(merged);
    }
    let arc_sleep = normalized_field("arcSleep", &arc_sleep, oc_mode_default);
    persisted.insert("arcSleep".into(), arc_sleep.clone());

    // The effective additive values are also used when creating the next cache.
    // Inherited values are normalized on persist for maps/metrics, while a
    // cached renderer value is persisted as-is, matching the existing writer.
    let mut effective = Map::new();
    for key in ["monitorLogMetrics", "activeProfileIds", "ocModes"] {
        if let Some(value) = settings.get(key).or_else(|| cached.get(key)) {
            let value = normalized_field(key, value, oc_mode_default);
            persisted.insert(key.into(), value.clone());
            effective.insert(key.into(), value);
        }
    }
    if let Some(value) = settings.get("rtssOnBoot").or_else(|| cached.get("rtssOnBoot")) {
        let value = json!(is_true(Some(value)));
        persisted.insert("rtssOnBoot".into(), value.clone());
        effective.insert("rtssOnBoot".into(), value);
    }
    if let Some(value) = settings.get("recordingToastsEnabled").or_else(|| cached.get("recordingToastsEnabled")) {
        // Intentionally not copied to effective: the original cache rebuild
        // spreads settings, so an omitted inherited true becomes false in cache.
        persisted.insert("recordingToastsEnabled".into(), json!(is_true(Some(value))));
    }
    if let Some(value) = settings.get("overlayRenderer") {
        let value = normalized_field("overlayRenderer", value, oc_mode_default);
        persisted.insert("overlayRenderer".into(), value.clone());
        effective.insert("overlayRenderer".into(), value);
    } else if let Some(value) = cached.get("overlayRenderer") {
        persisted.insert("overlayRenderer".into(), value.clone());
        effective.insert("overlayRenderer".into(), value.clone());
    }

    for key in ["arcSleepFrameLimitBase", "arcSleepJournal"] {
        let value = if let Some(value) = arc_sleep_patch.and_then(|patch| patch.get(key)) {
            normalized_field(key, value, oc_mode_default)
        } else {
            // The source trusts these cached fields on persist; the next
            // settings read normalizes them. Nullish cache values become null.
            cached.get(key).cloned().unwrap_or(Value::Null)
        };
        persisted.insert(key.into(), value);
    }
    let pending = json!(is_true(arc_sleep_patch.and_then(|patch| patch.get("arcSleepPendingBaseDisable")).or_else(|| cached.get("arcSleepPendingBaseDisable"))));
    persisted.insert("arcSleepPendingBaseDisable".into(), pending.clone());
    let expected = if pending == Value::Bool(true) {
        let value = arc_sleep_patch.and_then(|patch| patch.get("arcSleepPendingBaseDisableExpected"))
            .or_else(|| cached.get("arcSleepPendingBaseDisableExpected")).cloned().unwrap_or(Value::Null);
        normalize_settings(Some(&json!({"arcSleepPendingBaseDisable":true,"arcSleepPendingBaseDisableExpected":value})), oc_mode_default)["arcSleepPendingBaseDisableExpected"].clone()
    } else { Value::Null };
    persisted.insert("arcSleepPendingBaseDisableExpected".into(), expected);

    let mut cache_input = settings.as_object().cloned().unwrap_or_default();
    for (key, value) in effective { cache_input.insert(key, value); }
    cache_input.insert("memorySavingMode".into(), memory_saving);
    cache_input.insert("arcSleep".into(), arc_sleep);
    for key in ["arcSleepFrameLimitBase", "arcSleepJournal", "arcSleepPendingBaseDisable", "arcSleepPendingBaseDisableExpected"] {
        cache_input.insert(key.into(), persisted[key].clone());
    }
    cache_input.insert("schemaVersion".into(), json!(SCHEMA_VERSION));
    let cache = normalize_settings(Some(&Value::Object(cache_input)), oc_mode_default);
    Ok(SettingsWrite { persisted: Value::Object(persisted), cache })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn equivalent(actual: &Value, expected: &Value) -> bool {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b)),
            (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b))),
            _ => actual == expected,
        }
    }

    #[test]
    fn original_javascript_write_and_cache_differential_fixtures() {
        // Generated from _saveSettingsNow with _settingsCache explicitly seeded
        // and _writeAtomic replaced by an in-memory capture. No files were read
        // or written by ProfileStore. Shared values only compress the fixtures.
        let fixture_data: Value = serde_json::from_str(include_str!("fixtures/settings-write-parity.json")).unwrap();
        let values = fixture_data["values"].as_array().unwrap();
        let fixtures = fixture_data["fixtures"].as_array().unwrap();
        assert_eq!(fixtures.len(), 300);
        for (index, fixture) in fixtures.iter().enumerate() {
            let get = |key: &str| &values[fixture[key].as_u64().unwrap() as usize];
            let result = prepare_settings_write(get("settings"), get("cached"), Some(get("patch")), fixture["mode"].as_str().unwrap());
            if let Some(error) = fixture.get("error") {
                assert_eq!(result.unwrap_err(), error.as_str().unwrap(), "fixture {index}");
                continue;
            }
            let result = result.unwrap_or_else(|error| panic!("fixture {index}: {error}"));
            let changes = get("expectedChanges");
            for (field, actual) in [("persisted", &result.persisted), ("cache", &result.cache)] {
                let mut expected = fixture_data["baseline"][field].clone();
                for (key, value) in changes[field].as_object().unwrap() {
                    expected.as_object_mut().unwrap().insert(key.clone(), value.clone());
                }
                assert!(equivalent(actual, &expected), "fixture {index} {field}: actual={actual} expected={expected}");
            }
            let actual_keys: Vec<_> = result.persisted.as_object().unwrap().keys().map(String::as_str).collect();
            let expected_keys: Vec<_> = get("persistedKeys").as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
            assert_eq!(actual_keys, expected_keys, "fixture {index}: persisted envelope order");
        }
    }

    #[test]
    fn generic_stale_snapshot_cannot_replace_arc_sleep_owned_state() {
        let cached = json!({
            "arcSleep":{"idleEnabled":true,"idleAfterSeconds":720},
            "arcSleepFrameLimitBase":{"enabled":true,"value":77},
            "arcSleepJournal":{"session":"current"},
            "arcSleepPendingBaseDisable":true,
            "arcSleepPendingBaseDisableExpected":{"limit":77,"denominator":1,"limiterEnabled":true}
        });
        let stale = json!({"arcSleep":{"idleEnabled":false},"arcSleepFrameLimitBase":null,"arcSleepJournal":null,"arcSleepPendingBaseDisable":false});
        let result = prepare_settings_write(&stale, &cached, None, "stock").unwrap();
        assert_eq!(result.persisted["arcSleep"]["idleEnabled"], true);
        assert_eq!(result.persisted["arcSleepFrameLimitBase"]["value"], 77);
        assert_eq!(result.persisted["arcSleepJournal"]["session"], "current");
        assert_eq!(result.cache["arcSleepPendingBaseDisable"], true);
        assert_eq!(result.cache["arcSleepPendingBaseDisableExpected"]["limit"], 77);
        let patched = prepare_settings_write(&stale, &cached, Some(&json!({"arcSleep":{"idleEnabled":false},"arcSleepPendingBaseDisable":false})), "stock").unwrap();
        assert_eq!(patched.persisted["arcSleep"]["idleEnabled"], false);
        assert_eq!(patched.persisted["arcSleep"]["idleAfterSeconds"], 720);
        assert_eq!(patched.persisted["arcSleepPendingBaseDisableExpected"], Value::Null);
    }

    #[test]
    fn inherited_toast_and_unvalidated_profile_id_distinguish_cache_from_disk() {
        let result = prepare_settings_write(&json!({"activeProfileId":42}), &json!({"recordingToastsEnabled":true}), None, "stock").unwrap();
        assert_eq!(result.persisted["recordingToastsEnabled"], true);
        assert_eq!(result.cache["recordingToastsEnabled"], false);
        assert_eq!(result.persisted["activeProfileId"], 42);
        assert_eq!(result.cache["activeProfileId"], Value::Null);
        let legacy = prepare_settings_write(&json!({}), &json!({}), None, "stock").unwrap();
        assert!(legacy.persisted.get("recordingToastsEnabled").is_none());
        assert_eq!(legacy.cache["recordingToastsEnabled"], false);
    }
}
