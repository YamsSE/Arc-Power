//! Pure port of src/main/store/migrations.js. No persistence or hardware access.
use serde_json::{json, Map, Value};

pub const SCHEMA_VERSION: u64 = 3;

fn schema_version_of(data: &Value) -> Result<f64, String> {
    let object = data.as_object().ok_or_else(|| {
        let kind = match data {
            Value::Null => "null", Value::Array(_) => "array",
            Value::Bool(_) => "boolean", Value::Number(_) => "number",
            Value::String(_) => "string", Value::Object(_) => unreachable!(),
        };
        format!("Cannot migrate store data: expected an object, got {kind}")
    })?;
    let value = match object.get("schemaVersion") {
        None | Some(Value::Null) => return Ok(0.0),
        Some(value) => value,
    };
    match value.as_f64() {
        Some(v) if v.is_finite() && v >= 0.0 && v.fract() == 0.0 => Ok(v),
        _ => Err(format!("Cannot migrate store data: schemaVersion {value} is not a non-negative integer")),
    }
}

fn assert_supported(version: f64) -> Result<(), String> {
    if version > SCHEMA_VERSION as f64 {
        return Err(format!("Store data has schemaVersion {version}, but this app only supports up to {SCHEMA_VERSION}. Refusing to load - the file was written by a newer version of Arc Power."));
    }
    Ok(())
}

// JavaScript object spread also accepts arrays and primitive values.
fn spread(value: &Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map.clone(),
        Value::Array(items) => items.iter().enumerate().map(|(i, v)| (i.to_string(), v.clone())).collect(),
        Value::String(text) => text.encode_utf16().enumerate().map(|(i, c)| {
            // JSON strings cannot represent lone UTF-16 surrogates; valid Unicode
            // scalar input is preserved in ordinary persisted store strings.
            (i.to_string(), Value::String(String::from_utf16_lossy(&[c])))
        }).collect(),
        _ => Map::new(),
    }
}

fn normalized_settings(data: &Value, version: u64) -> Value {
    json!({"schemaVersion": version,
        "waiverAccepted": data.get("waiverAccepted") == Some(&Value::Bool(true)),
        "ocOnBoot": data.get("ocOnBoot") == Some(&Value::Bool(true)),
        "activeProfileId": data.get("activeProfileId").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null)})
}

fn bump_profiles(data: &Value, version: u64) -> Result<Value, String> {
    let mut out = spread(data);
    out.insert("schemaVersion".into(), json!(version));
    if let Some(profiles) = data.get("profiles").and_then(Value::as_array) {
        // JS object spread splits strings into UTF-16 code units. serde_json
        // cannot preserve isolated surrogates; refuse this malformed profile
        // instead of replacing its characters and persisting altered data.
        if profiles.iter().any(|profile| profile.as_str().is_some_and(|text| text.chars().any(|character| character.len_utf16() > 1))) {
            return Err("Cannot migrate malformed string profile containing UTF-16 surrogate pairs".into());
        }
        out.insert("profiles".into(), Value::Array(profiles.iter().map(|p| {
            let mut profile = spread(p);
            profile.insert("schemaVersion".into(), json!(version));
            Value::Object(profile)
        }).collect()));
    }
    Ok(Value::Object(out))
}

pub fn migrate_store_data(data: &Value, kind: &str) -> Result<Value, String> {
    let mut version = schema_version_of(data)?;
    assert_supported(version)?;
    let mut out = data.clone();
    while version < SCHEMA_VERSION as f64 {
        out = match (version as u64, kind == "profiles") {
            (0, true) => {
                let mut profiles = Vec::new();
                if let Some(raw) = out.get("profiles").and_then(Value::as_array) {
                    for (i, p) in raw.iter().enumerate() {
                        if p.is_null() { return Err("Cannot migrate null profile".into()); }
                        let settings = p.get("settings").filter(|s| s.is_object() || s.is_array()).map(spread).unwrap_or_default();
                        profiles.push(json!({
                            "id": p.get("id").and_then(Value::as_str).filter(|id| !id.is_empty()).map(str::to_owned).unwrap_or_else(|| format!("profile-{i}")),
                            "name": p.get("name").and_then(Value::as_str).map(str::to_owned).unwrap_or_else(|| format!("Profile {}", i + 1)),
                            "createdAt": p.get("createdAt").and_then(Value::as_str).unwrap_or("1970-01-01T00:00:00.000Z"),
                            "schemaVersion": 1, "settings": settings,
                            "ocOnBoot": p.get("ocOnBoot") == Some(&Value::Bool(true))
                        }));
                    }
                }
                json!({"schemaVersion": 1, "profiles": profiles})
            }
            (0, false) => normalized_settings(&out, 1),
            (1 | 2, true) => bump_profiles(&out, version as u64 + 1)?,
            (1, false) => {
                let mut next = normalized_settings(&out, 2);
                if matches!(out.get("ocMode").and_then(Value::as_str), Some("stock" | "advanced")) {
                    next["ocMode"] = out["ocMode"].clone();
                }
                next
            }
            (2, false) => {
                let mut next = spread(&out);
                next.insert("schemaVersion".into(), json!(3));
                if let Some(stats) = out.get("overlayStats").and_then(Value::as_array) {
                    let mut stats = stats.clone();
                    for id in ["gpu-voltage", "gpu-vram-temp"] {
                        if !stats.iter().any(|v| v.as_str() == Some(id)) { stats.push(json!(id)); }
                    }
                    next.insert("overlayStats".into(), Value::Array(stats));
                }
                Value::Object(next)
            }
            _ => return Err(format!("No migration path from schemaVersion {version} (corrupt migration chain?)")),
        };
        version += 1.0;
    }
    Ok(out)
}

pub fn assert_current_schema(data: &Value) -> Result<&Value, String> {
    let version = schema_version_of(data)?;
    assert_supported(version)?;
    if version != SCHEMA_VERSION as f64 {
        return Err(format!("Migration failed: expected schemaVersion {SCHEMA_VERSION}, got {version}"));
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_malformed_surrogate_profile_without_changing_input() {
        let data = json!({"schemaVersion":1,"profiles":["😀"]});
        let original = data.clone();
        assert!(migrate_store_data(&data, "profiles").is_err());
        assert_eq!(data, original);
    }

    #[test]
    fn legacy_profiles_normalize_and_drop_legacy_extras_without_mutating() {
        let input = json!({"extra":1,"profiles":[{"id":"","name":false,"settings":[1,2],"ocOnBoot":1,"extra":9},{"id":"kept","name":"","createdAt":"custom","settings":{"x":1},"ocOnBoot":true}]});
        let original = input.clone();
        let out = migrate_store_data(&input, "profiles").unwrap();
        assert_eq!(input, original);
        assert_eq!(out, json!({"schemaVersion":3,"profiles":[{"id":"profile-0","name":"Profile 1","createdAt":"1970-01-01T00:00:00.000Z","schemaVersion":3,"settings":{"0":1,"1":2},"ocOnBoot":false},{"id":"kept","name":"","createdAt":"custom","schemaVersion":3,"settings":{"x":1},"ocOnBoot":true}]}));
    }

    #[test]
    fn legacy_settings_normalize_and_mode_is_only_kept_from_v1() {
        assert_eq!(migrate_store_data(&json!({"schemaVersion":null,"waiverAccepted":1,"ocOnBoot":true,"activeProfileId":false,"ocMode":"advanced","extra":1}),"settings").unwrap(), json!({"schemaVersion":3,"waiverAccepted":false,"ocOnBoot":true,"activeProfileId":null}));
        for mode in ["stock", "advanced", "invalid"] {
            let out = migrate_store_data(&json!({"schemaVersion":1,"ocMode":mode,"extra":1}),"settings").unwrap();
            assert_eq!(out.get("ocMode").and_then(Value::as_str), if mode == "invalid" {None} else {Some(mode)});
            assert!(out.get("extra").is_none());
        }
    }

    #[test]
    fn overlay_union_is_once_preserves_duplicates_unknown_values_and_v2_fields() {
        let input = json!({"schemaVersion":2,"extra":{"nested":[1]},"overlayStats":["fps","fps",null,4,"gpu-vram-temp"]});
        let before = input.clone();
        let mut out = migrate_store_data(&input,"settings").unwrap();
        assert_eq!(input,before);
        assert_eq!(out["extra"],input["extra"]);
        assert_eq!(out["overlayStats"],json!(["fps","fps",null,4,"gpu-vram-temp","gpu-voltage"]));
        out["overlayStats"] = json!(["fps"]);
        assert_eq!(migrate_store_data(&out,"settings").unwrap(),out);
        assert_eq!(migrate_store_data(&json!({"schemaVersion":2,"overlayStats":[]}),"settings").unwrap()["overlayStats"],json!(["gpu-voltage","gpu-vram-temp"]));
    }

    #[test]
    fn missing_or_invalid_overlay_stats_are_preserved_for_load_defaults() {
        for stats in [Value::Null,json!(false),json!("fps"),json!({"x":1})] {
            let input = json!({"schemaVersion":2,"overlayStats":stats});
            assert_eq!(migrate_store_data(&input,"settings").unwrap()["overlayStats"],input["overlayStats"]);
        }
        assert!(migrate_store_data(&json!({"schemaVersion":2}),"settings").unwrap().get("overlayStats").is_none());
    }

    #[test]
    fn profile_bumps_preserve_unknown_fields_and_non_array_shape() {
        for version in [1,2] {
            let out = migrate_store_data(&json!({"schemaVersion":version,"extra":1,"profiles":[{"custom":true},null,["x"]]}),"profiles").unwrap();
            assert_eq!(out,json!({"schemaVersion":3,"extra":1,"profiles":[{"custom":true,"schemaVersion":3},{"schemaVersion":3},{"0":"x","schemaVersion":3}]}));
            for profiles in [Value::Null,json!({"custom":1}),json!(false)] {
                let out = migrate_store_data(&json!({"schemaVersion":version,"profiles":profiles}),"profiles").unwrap();
                assert_eq!(out["profiles"],profiles);
            }
            assert!(migrate_store_data(&json!({"schemaVersion":version}),"profiles").unwrap().get("profiles").is_none());
        }
    }

    #[test]
    fn invalid_or_newer_files_are_refused_and_current_schema_checked() {
        for input in [Value::Null,json!([]),json!(true),json!(3),json!("x")] {
            assert!(migrate_store_data(&input,"settings").is_err());
            assert!(assert_current_schema(&input).is_err());
        }
        for version in [json!(-1),json!(1.5),json!("3"),json!(true),json!({}),json!([]),json!(4),json!(1e20)] {
            let input = json!({"schemaVersion":version});
            assert!(migrate_store_data(&input,"profiles").is_err());
            assert!(assert_current_schema(&input).is_err());
        }
        assert!(assert_current_schema(&json!({})).is_err());
        let current = json!({"schemaVersion":3.0,"extra":[1]});
        assert_eq!(assert_current_schema(&current).unwrap(),&current);
        assert_eq!(migrate_store_data(&current,"settings").unwrap(),current);
        assert_eq!(migrate_store_data(&json!({"profiles":false}),"profiles").unwrap(),json!({"schemaVersion":3,"profiles":[]}));
        assert!(migrate_store_data(&json!({"profiles":[null]}),"profiles").is_err());
    }
}
