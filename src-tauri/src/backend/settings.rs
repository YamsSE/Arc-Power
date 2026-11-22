//! Pure settings read normalization, ported from ProfileStore._settingsFromData.
//! No filesystem access, migrations, caches, settings writes or hardware calls.
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

/// The telemetry sample cadence shared by every lane: the native lane thread,
/// the persisted `overlayPollMs` default and the Electron compatibility push.
/// Kept here because this module is the normalization owner of the persisted
/// cadence, so the Rust and renderer defaults cannot drift apart.
pub const TELEMETRY_POLL_MS_DEFAULT: u64 = 600;

/// The persisted UI themes. The settings patch validator reuses this list so a
/// garbage `theme` patch keeps the current value instead of resetting it.
pub(crate) const THEMES: &[&str] = &["dark", "midnight", "light", "red", "yellow"];
const POSITIONS: &[&str] = &["top-left", "top-right", "bottom-left", "bottom-right"];
const STATS: &[&str] = &["fps", "fps-avg", "fps-01pct-low", "fps-1pct-low", "fps-99pct", "api", "cpu-util", "cpu-clock", "cpu-temp", "cpu-power", "memory-util", "gpu-util", "gpu-clock", "gpu-voltage", "gpu-temp", "gpu-power", "gpu-fan", "gpu-mem-clock", "gpu-vram", "gpu-vram-temp", "frametime"];
const DEFAULT_STATS: &[&str] = &["cpu-util", "cpu-temp", "cpu-power", "memory-util", "gpu-util", "gpu-temp", "gpu-power", "gpu-vram", "fps", "api", "frametime"];
const LOG_METRICS: &[&str] = &["gpu-util", "gpu-clock", "gpu-voltage", "gpu-temperature", "gpu-power", "gpu-fan", "gpu-vram", "gpu-memory-clock", "gpu-vram-temperature", "cpu-util", "cpu-clock", "cpu-temperature", "cpu-power", "system-memory", "system-memory-capacity", "fps", "frame-time", "fps-average", "fps-1-low", "fps-0.1-low", "fps-p99"];

fn true_value(value: Option<&Value>) -> bool { value == Some(&Value::Bool(true)) }
fn finite_number(value: Option<&Value>) -> Option<f64> { value.and_then(Value::as_f64).filter(|v| v.is_finite()) }
fn integer(value: Option<&Value>, max: f64) -> bool {
    finite_number(value).is_some_and(|n| n >= 0.0 && n <= max && n.fract() == 0.0)
}
fn js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}
fn array_primitive(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(array_primitive).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}
fn number_string(text: &str) -> Option<f64> {
    let text = text.trim_matches(js_whitespace);
    if text.is_empty() { return Some(0.0); }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0b", "0B"], 2), (["0o", "0O"], 8)] {
        if prefixes.iter().any(|prefix| text.starts_with(prefix)) {
            let digits = &text[2..];
            if digits.is_empty() { return None; }
            let mut n = 0.0;
            for digit in digits.chars() { n = n * f64::from(radix) + f64::from(digit.to_digit(radix)?); }
            return n.is_finite().then_some(n);
        }
    }
    if !text.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'+' | b'-' | b'.' | b'e' | b'E')) { return None; }
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}
/// JavaScript Number coercion is intentional here: Arc Sleep accepts numeric
/// strings, booleans, null and single-item arrays, unlike the overlay sliders.
fn js_number(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Null => Some(0.0),
        Value::Bool(v) => Some(if *v { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64().filter(|v| v.is_finite()),
        Value::String(s) => number_string(s),
        value @ Value::Array(_) => number_string(&array_primitive(value)),
        Value::Object(_) => None,
    }
}
fn bounded(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    js_number(value).map(|n| (n + 0.5).floor().clamp(min, max)).unwrap_or(fallback)
}
fn enum_value(value: Option<&Value>, allowed: &[&str], fallback: &str) -> Value {
    json!(value.and_then(Value::as_str).filter(|v| allowed.contains(v)).unwrap_or(fallback))
}
fn color(value: Option<&Value>) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| s.len() == 7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit))
}
fn valid_key(value: &str) -> bool { !value.is_empty() && value.encode_utf16().count() <= 256 }
fn filtered_strings(value: Option<&Value>, allowed: Option<&[&str]>, fallback: Value) -> Value {
    let Some(values) = value.and_then(Value::as_array) else { return fallback; };
    let mut seen = BTreeSet::new();
    Value::Array(values.iter().filter_map(|v| v.as_str()).filter(|v| {
        allowed.map(|a| a.contains(v)).unwrap_or_else(|| valid_key(v)) && seen.insert((*v).to_owned())
    }).map(|s| json!(s)).collect())
}
fn normalized_map(value: Option<&Value>, modes: bool) -> Value {
    let mut out = Map::new();
    if let Some(map) = value.and_then(Value::as_object) {
        // Object.entries puts canonical array-index property names first,
        // numerically sorted, then other keys in their original insertion order.
        let index = |key: &str| key.parse::<u32>().ok().filter(|n| *n != u32::MAX && n.to_string() == key);
        let mut entries: Vec<_> = map.iter().collect();
        entries.sort_by_key(|(key, _)| index(key).map(|n| (0, n)).unwrap_or((1, 0)));
        for (key, value) in entries {
            // JavaScript out={} assignment to __proto__ does not create an own
            // property for the accepted string values. Match its JSON result.
            if key == "__proto__" || !valid_key(key) { continue; }
            if let Some(s) = value.as_str() {
                if if modes { matches!(s, "stock" | "advanced") } else { valid_key(s) } {
                    out.insert(key.clone(), json!(s));
                }
            }
        }
    }
    Value::Object(out)
}
fn valid_modified_hotkey(text: &str, insensitive: bool) -> bool {
    let parts: Vec<_> = text.split('+').collect();
    if !(2..=4).contains(&parts.len()) { return false; }
    if !parts[..parts.len()-1].iter().all(|s| {
        if insensitive { ["Control", "Alt", "Shift"].iter().any(|m| s.eq_ignore_ascii_case(m)) }
        else { ["Control", "Alt", "Shift"].contains(s) }
    }) { return false; }
    let key = parts[parts.len()-1];
    if key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric() { return true; }
    let Some(tail) = key.strip_prefix('F').or_else(|| if insensitive { key.strip_prefix('f') } else { None }) else { return false; };
    if tail.starts_with('0') || tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) { return false; }
    tail.parse::<u8>().is_ok_and(|n| (1..=24).contains(&n))
}
fn hotkey(value: Option<&Value>, fallback: &str, overlay: bool, insensitive: bool) -> Value {
    let valid = value.and_then(Value::as_str).filter(|s| {
        (overlay && (*s == "None" || (s.len() == 1 && s.as_bytes()[0].is_ascii_alphabetic()))) || valid_modified_hotkey(s, insensitive)
    });
    json!(valid.unwrap_or(fallback))
}
fn arc_sleep(value: Option<&Value>) -> Value {
    let get = |key| value.and_then(Value::as_object).and_then(|v| v.get(key));
    let min = bounded(get("adaptiveMinFps"), 60.0, 30.0, 1000.0);
    let max = bounded(get("adaptiveMaxFps"), 144.0, 30.0, 1000.0);
    json!({"idleEnabled":true_value(get("idleEnabled")), "adaptiveEnabled":true_value(get("adaptiveEnabled")),
        "idleAfterSeconds":bounded(get("idleAfterSeconds"),300.0,60.0,3600.0) as u64,
        "idleFps":bounded(get("idleFps"),30.0,15.0,120.0) as u64,
        "adaptiveMinFps":if min >= max {60} else {min as u64}, "adaptiveMaxFps":if min >= max {144} else {max as u64},
        "adaptiveTargetLoadPct":bounded(get("adaptiveTargetLoadPct"),85.0,50.0,99.0) as u64})
}

/// Input is already-migrated JSON data; None and JSON null both represent the
/// missing-settings envelope. Optional additive fields stay absent unless the
/// input contained them. Non-object JSON matches JS boxed-property defaults.
/// oc_mode_default follows ProfileStore constructor normalization.
pub fn normalize_settings(data: Option<&Value>, oc_mode_default: &str) -> Value {
    let data = data.filter(|v| !v.is_null());
    let get = |key| data.and_then(Value::as_object).and_then(|v| v.get(key));
    let mut out = Map::new();
    for key in ["waiverAccepted", "ocOnBoot", "advancedModeAccepted", "startWithWindows", "startMinimized", "closeToTray", "monitorLogToFile", "memorySavingMode", "overlayEnabled", "overlayBgEnabled", "overlayChipNames", "overlayRecordingPill", "recordingToastsEnabled", "arcSleepPendingBaseDisable", "advancedOverlayEnabled"] {
        out.insert(key.into(), json!(true_value(get(key))));
    }
    out.insert("activeProfileId".into(), get("activeProfileId").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null));
    out.insert("ocMode".into(), enum_value(get("ocMode"), &["advanced", "stock"], if oc_mode_default == "advanced" {"advanced"} else {"stock"}));
    out.insert("deviceId".into(), get("deviceId").filter(|_| integer(get("deviceId"), f64::MAX)).cloned().unwrap_or(Value::Null));
    out.insert("deviceKey".into(), get("deviceKey").filter(|v| v.as_str().is_some_and(|s| !s.is_empty())).cloned().unwrap_or(Value::Null));
    out.insert("theme".into(), enum_value(get("theme"), THEMES, "dark"));
    out.insert("overlayHotkeyLetter".into(), hotkey(get("overlayHotkeyLetter"), "Alt+F8", true, false));
    out.insert("postprocessScaleHotkey".into(), hotkey(get("postprocessScaleHotkey"), "Alt+F10", false, false));
    out.insert("advancedOverlayHotkeyLetter".into(), hotkey(get("advancedOverlayHotkeyLetter"), "Alt+F9", true, true));
    out.insert("overlayPosition".into(), enum_value(get("overlayPosition"), POSITIONS, "top-left"));
    out.insert("advancedOverlayPosition".into(), enum_value(get("advancedOverlayPosition"), &["left", "right"], "right"));
    let scale = finite_number(get("overlayScale")).unwrap_or(1.0).clamp(0.5, 2.0);
    out.insert("overlayScale".into(), json!((scale / 0.25 + 0.5).floor() * 0.25));
    let base_color = color(get("overlayColor")).unwrap_or("#ffffff");
    out.insert("overlayColor".into(), json!(base_color));
    for key in ["overlayLabelColor", "overlayValueColor"] { out.insert(key.into(), json!(color(get(key)).unwrap_or(base_color))); }
    out.insert("overlayTemperatureUnit".into(), enum_value(get("overlayTemperatureUnit"), &["F"], "C"));
    let keys = filtered_strings(get("overlayDeviceKeys"), None, Value::Null);
    out.insert("overlayDeviceKeys".into(), if keys.as_array().is_some_and(Vec::is_empty) { Value::Null } else { keys });
    out.insert("overlayStats".into(), filtered_strings(get("overlayStats"), Some(STATS), json!(DEFAULT_STATS)));
    out.insert("overlayBgColor".into(), json!(color(get("overlayBgColor")).unwrap_or("#000000")));
    out.insert("overlayBgOpacity".into(), json!(finite_number(get("overlayBgOpacity")).unwrap_or(0.5).clamp(0.0, 1.0)));
    out.insert("overlayPollMs".into(), json!((finite_number(get("overlayPollMs")).unwrap_or(TELEMETRY_POLL_MS_DEFAULT as f64) + 0.5).floor().clamp(100.0, 2000.0) as u64));
    out.insert("overlayTheme".into(), enum_value(get("overlayTheme"), &["classic", "arc"], "arc"));
    out.insert("arcSleep".into(), arc_sleep(get("arcSleep")));
    let base = get("arcSleepFrameLimitBase").and_then(Value::as_object).map(|v| json!({"enabled":true_value(v.get("enabled")), "value":bounded(v.get("value"),60.0,1.0,1000.0) as u64})).unwrap_or(Value::Null);
    out.insert("arcSleepFrameLimitBase".into(), base);
    out.insert("arcSleepJournal".into(), get("arcSleepJournal").filter(|v| v.is_object()).cloned().unwrap_or(Value::Null));
    let expected = get("arcSleepPendingBaseDisableExpected").and_then(Value::as_object).filter(|v| {
        true_value(get("arcSleepPendingBaseDisable")) && integer(v.get("limit"), u32::MAX as f64) && integer(v.get("denominator"), u32::MAX as f64) && v.get("limiterEnabled").is_some_and(Value::is_boolean)
    }).map(|v| json!({"limit":v["limit"], "denominator":v["denominator"], "limiterEnabled":v["limiterEnabled"]})).unwrap_or(Value::Null);
    out.insert("arcSleepPendingBaseDisableExpected".into(), expected);
    for (key, modes) in [("activeProfileIds", false), ("ocModes", true)] { if get(key).is_some() { out.insert(key.into(), normalized_map(get(key), modes)); } }
    if get("monitorLogMetrics").is_some() { out.insert("monitorLogMetrics".into(), filtered_strings(get("monitorLogMetrics"), Some(LOG_METRICS), json!(LOG_METRICS))); }
    if get("rtssOnBoot").is_some() { out.insert("rtssOnBoot".into(), json!(true_value(get("rtssOnBoot")))); }
    if get("overlayRenderer").is_some() { out.insert("overlayRenderer".into(), enum_value(get("overlayRenderer"), &["rtss", "capframex"], "rtss")); }
    Value::Object(out)
}


#[cfg(test)]
mod tests {
    use super::*;
    // Fixtures generated by executing only ProfileStore._settingsFromData.
    // The constructor and normalization do not access the filesystem.
    const BASELINE: &str = include_str!("fixtures/settings-read-baseline.json");
    const FIXTURES: &str = include_str!("fixtures/settings-read-cases.json");

    fn equivalent(actual: &Value, expected: &Value) -> bool {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a,b)| equivalent(a,b)),
            (Value::Object(a), Value::Object(b)) => a.len() == b.len() && a.iter().all(|(key,a)| b.get(key).is_some_and(|b| equivalent(a,b))),
            _ => actual == expected,
        }
    }

    #[test]
    fn original_javascript_differential_fixtures_cover_every_read_key() {
        let baseline: Value = serde_json::from_str(BASELINE).unwrap();
        let fixtures: Vec<Value> = serde_json::from_str(FIXTURES).unwrap();
        for (index, fixture) in fixtures.iter().enumerate() {
            let mut expected = baseline.clone();
            for (key, value) in fixture["overrides"].as_object().unwrap() {
                expected.as_object_mut().unwrap().insert(key.clone(), value.clone());
            }
            let actual = normalize_settings(Some(&fixture["input"]), fixture["mode"].as_str().unwrap());
            assert!(equivalent(&actual, &expected), "fixture {index}: input={} actual={} expected={}", fixture["input"], actual, expected);
        }
        assert!(equivalent(&normalize_settings(None, "stock"), &baseline));
    }

    #[test]
    fn telemetry_cadence_default_is_600_ms() {
        assert_eq!(TELEMETRY_POLL_MS_DEFAULT, 600);
        assert_eq!(normalize_settings(None, "stock")["overlayPollMs"], json!(600));
        let explicit = normalize_settings(Some(&json!({"overlayPollMs": 250})), "stock");
        assert_eq!(explicit["overlayPollMs"], json!(250), "an explicit cadence is preserved");
    }

    #[test]
    fn legacy_additive_presence_and_map_order_are_preserved() {
        let old = normalize_settings(None, "stock");
        for key in ["activeProfileIds", "ocModes", "monitorLogMetrics", "rtssOnBoot", "overlayRenderer"] {
            assert!(old.get(key).is_none());
        }
        let input: Value = serde_json::from_str(r#"{"activeProfileIds":{"z":"last","a":"first"},"ocModes":null,"rtssOnBoot":null,"monitorLogMetrics":[],"overlayRenderer":null}"#).unwrap();
        let output = normalize_settings(Some(&input), "stock");
        assert_eq!(output["activeProfileIds"].as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(), vec!["z", "a"]);
        assert_eq!(output["ocModes"], json!({}));
        assert_eq!(output["monitorLogMetrics"], json!([]));
        assert_eq!(output["rtssOnBoot"], false);
        assert_eq!(output["overlayRenderer"], "rtss");
    }
}
