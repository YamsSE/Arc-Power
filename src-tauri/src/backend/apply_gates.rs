//! Pure apply gates and range shaping (port of src/main/apply-routing.js).
//! These functions decide before any clamp whether a request is acceptable
//! and which runtime owns each control; they perform no writes.
use super::device_limits::{
    default_limits_of, device_limits_of, DeviceLimits, EXTENDED_PL_MAX_W,
    EXTENDED_TL_MAX_C, STD_PL_MAX_W, STD_TL_MAX_C,
};
use serde_json::{json, Map, Value};

pub const ALCHEMIST_NEGATIVE_VOLT_OFFSET_MIN_V: f64 = -0.200;
pub const OC_MODE_STOCK: &str = "stock";
pub const OC_MODE_ADVANCED: &str = "advanced";
pub const OC_MODE_REFUSAL_MSG: &str = "This value is beyond the standard Intel limit and Advanced OC Mode is off. Enable Advanced OC Mode to apply extended power/temperature limits. Nothing was changed.";
pub const OC_CEILING_REFUSAL_MSG: &str = "This value is above the maximum the GPU can accept. Nothing was changed.";
pub const EXTENDED_UNAVAILABLE_MSG: &str = "extended power/temp limit requires the bundled 2023 IGCL runtime - it failed to load on this driver";

#[derive(Clone, Copy, Debug, Default)]
pub struct LimitsKey<'a> {
    pub pci_device_id: Option<&'a str>,
    pub aib_vendor: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OcRefusal {
    pub mode: &'static str,
    pub controls: Vec<&'static str>,
    pub message: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ExtendedUnavailable {
    pub controls: Vec<&'static str>,
    pub message: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TempCapabilityRefusal {
    pub controls: Vec<&'static str>,
    pub capability_ceiling: f64,
    pub message: String,
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}

fn setting(settings: &Value, key: &str) -> Option<f64> {
    settings.get(key).and_then(number)
}

fn units(ranges: Option<&Value>, key: &str) -> Option<String> {
    ranges?.get(key)?.get("units")?.as_str().map(str::to_owned)
}

fn is_wc_units(ranges: Option<&Value>, key: &str) -> bool {
    match units(ranges, key) {
        None => true,
        Some(value) if key == "powerLimitW" => value == "W",
        Some(value) => value == "C",
    }
}

fn limits_of(key: Option<LimitsKey<'_>>, advanced: bool) -> DeviceLimits {
    match key {
        Some(key) => device_limits_of(key.pci_device_id, key.aib_vendor, advanced),
        None => default_limits_of(advanced),
    }
}

pub fn device_gate_thresholds(key: Option<LimitsKey<'_>>, advanced: bool, ranges: Option<&Value>) -> (f64, f64) {
    let limits = limits_of(key, advanced);
    let default_pl = if advanced { EXTENDED_PL_MAX_W } else { STD_PL_MAX_W };
    let default_tl = if advanced { EXTENDED_TL_MAX_C } else { STD_TL_MAX_C };
    if !limits.listed { return (default_pl, default_tl); }
    let live_power_max = ranges
        .filter(|ranges| units(Some(ranges), "powerLimitW").as_deref() == Some("W"))
        .and_then(|ranges| ranges.get("powerLimitW")?.get("max").and_then(number));
    let pl = limits.power_limit_w.and_then(|limit| limit.max)
        .or(live_power_max)
        .unwrap_or(default_pl);
    let tl = limits.temp_limit_c.and_then(|limit| limit.max).unwrap_or(default_tl);
    (pl, tl)
}

pub fn oc_mode_refusal(mode: &str, settings: &Value, ranges: Option<&Value>, key: Option<LimitsKey<'_>>) -> Option<OcRefusal> {
    if !settings.is_object() { return None; }
    let advanced = mode == OC_MODE_ADVANCED;
    let (pl_max, tl_max) = device_gate_thresholds(key, advanced, ranges);
    let mut controls = Vec::new();
    if setting(settings, "powerLimitW").is_some_and(|value| value > pl_max && is_wc_units(ranges, "powerLimitW")) {
        controls.push("powerLimitW");
    }
    if setting(settings, "tempLimitC").is_some_and(|value| value > tl_max && is_wc_units(ranges, "tempLimitC")) {
        controls.push("tempLimitC");
    }
    if controls.is_empty() { return None; }
    Some(OcRefusal {
        mode: if advanced { OC_MODE_ADVANCED } else { OC_MODE_STOCK },
        controls,
        message: if advanced { OC_CEILING_REFUSAL_MSG } else { OC_MODE_REFUSAL_MSG },
    })
}

pub fn refusal_per_control(refusal: &OcRefusal) -> Value {
    let mut out = Map::new();
    for control in &refusal.controls {
        out.insert((*control).to_owned(), json!({
            "ok": false, "errorCode": "out-of-range", "message": refusal.message,
        }));
    }
    Value::Object(out)
}

/// Classify a leased temperature apply reply as a pre-setter capability/mode
/// refusal: the OC gate (or an equivalent pre-setter capability refusal) answered
/// before any setter ran, so the apply never changed hardware.
///
/// A pre-setter mode-gate refusal (`ocModeRefused`) arrives with an `out-of-range`
/// per-control entry that carries no capability ceiling and no attempted setter
/// value. The temperature lease finish contract cannot publish that shape as a
/// driver refusal (the finish requires an attempted value or a finite capability
/// ceiling for an `out-of-range` refusal), so such a decline must finish the lease
/// as `not-applied` and return the compatibility broker's authoritative envelope.
///
/// Anything that reached a setter (`attempted_temperature == Some`) keeps the
/// fail-closed unknown path instead of falling back and re-applying.
pub fn is_pre_setter_refusal(
    result: &Value,
    attempted_temperature: Option<f64>,
    oc_mode_refused: bool,
) -> bool {
    attempted_temperature.is_none()
        && result.get("ok").and_then(Value::as_bool) == Some(false)
        && oc_mode_refused
}

pub fn is_sysman_primary_power_request(settings: &Value, ranges: Option<&Value>, has_sysman: bool) -> bool {
    has_sysman
        && setting(settings, "powerLimitW").is_some_and(|value| value > STD_PL_MAX_W)
        && units(ranges, "powerLimitW").as_deref() == Some("W")
}

pub fn extended_unavailable_refusal(settings: &Value, caps: &Value, has_sysman: bool) -> Option<ExtendedUnavailable> {
    if !settings.is_object() { return None; }
    let ranges = caps.get("ranges");
    let explicit = caps.get("extendedControls").filter(|value| value.is_object());
    let mut controls = Vec::new();
    if let Some(explicit) = explicit {
        if setting(settings, "powerLimitW").is_some_and(|value| value > STD_PL_MAX_W
            && is_wc_units(ranges, "powerLimitW")
            && (explicit.get("powerLimitW") != Some(&Value::Bool(true))
                || (value > EXTENDED_PL_MAX_W && !has_sysman))
            && !is_sysman_primary_power_request(settings, ranges, has_sysman)) {
            controls.push("powerLimitW");
        }
        if setting(settings, "tempLimitC").is_some_and(|value| value > STD_TL_MAX_C
            && is_wc_units(ranges, "tempLimitC")
            && explicit.get("tempLimitC") != Some(&Value::Bool(true))) {
            controls.push("tempLimitC");
        }
        return (!controls.is_empty()).then_some(ExtendedUnavailable { controls, message: EXTENDED_UNAVAILABLE_MSG });
    }
    let sysman_primary = is_sysman_primary_power_request(settings, ranges, has_sysman);
    let over_extended = setting(settings, "powerLimitW").is_some_and(|value| value > EXTENDED_PL_MAX_W);
    if caps.get("extendedRanges") == Some(&Value::Bool(true)) && !(over_extended && !has_sysman) {
        return None;
    }
    if over_extended && is_wc_units(ranges, "powerLimitW") && !has_sysman {
        controls.push("powerLimitW");
    }
    if setting(settings, "powerLimitW").is_some_and(|value| value > STD_PL_MAX_W)
        && is_wc_units(ranges, "powerLimitW") && !sysman_primary {
        controls.push("powerLimitW");
    }
    if setting(settings, "tempLimitC").is_some_and(|value| value > STD_TL_MAX_C
        && is_wc_units(ranges, "tempLimitC")) {
        controls.push("tempLimitC");
    }
    controls.dedup();
    (!controls.is_empty()).then_some(ExtendedUnavailable { controls, message: EXTENDED_UNAVAILABLE_MSG })
}

pub fn wc_unit_controls(settings: &Value, ranges: Option<&Value>) -> Vec<&'static str> {
    let mut out = Vec::new();
    if setting(settings, "powerLimitW").is_some() && is_wc_units(ranges, "powerLimitW") { out.push("powerLimitW"); }
    if setting(settings, "tempLimitC").is_some() && is_wc_units(ranges, "tempLimitC") { out.push("tempLimitC"); }
    out
}

/// Verify every selected V1 control before the apply transaction starts.
pub fn unsupported_legacy_targets(targets: &[&str], caps: &Value) -> Vec<&'static str> {
    let controls = caps.get("extendedControls").and_then(Value::as_object);
    targets.iter().filter_map(|control| {
        let key = match *control {
            "powerLimitW" => "powerLimitW",
            "tempLimitC" => "tempLimitC",
            _ => return None,
        };
        (controls.and_then(|controls| controls.get(key)) != Some(&Value::Bool(true))).then_some(key)
    }).collect()
}

pub fn extended_unavailable_per_control(controls: &[&str]) -> Value {
    let mut out = Map::new();
    for control in controls {
        out.insert((*control).to_owned(), json!({
            "ok": false, "errorCode": "unsupported", "message": EXTENDED_UNAVAILABLE_MSG,
        }));
    }
    Value::Object(out)
}

pub fn temp_capability_refusal(settings: &Value, ranges: Option<&Value>) -> Option<TempCapabilityRefusal> {
    let value = setting(settings, "tempLimitC")?;
    let range = ranges?.get("tempLimitC")?;
    if range.get("units").and_then(Value::as_str) != Some("C") { return None; }
    let min = range.get("min").and_then(number)?;
    let max = range.get("max").and_then(number)?;
    if max < min || value <= max { return None; }
    Some(TempCapabilityRefusal {
        controls: vec!["tempLimitC"],
        capability_ceiling: max,
        message: format!("temperature limit {} °C exceeds the effective capability ceiling of {} °C. Nothing was changed.",
            js_number(value), js_number(max)),
    })
}

pub fn temp_capability_per_control(refusal: &TempCapabilityRefusal) -> Value {
    let mut out = Map::new();
    for control in &refusal.controls {
        out.insert((*control).to_owned(), json!({
            "ok": false, "errorCode": "out-of-range",
            "capabilityCeiling": refusal.capability_ceiling,
            "message": refusal.message,
        }));
    }
    Value::Object(out)
}

pub fn valid_learned_temp_ceiling(learned: f64, range: &Value) -> bool {
    let min = range.get("min").and_then(number);
    let max = range.get("max").and_then(number);
    let step = range.get("step").and_then(number);
    let (Some(min), Some(max), Some(step)) = (min, max, step) else { return false; };
    if max < min || step <= 0.0 || learned < min || learned > EXTENDED_TL_MAX_C { return false; }
    let grid = (learned - min) / step;
    if !grid.is_finite() { return false; }
    let snapped = min + grid.round() * step;
    let scale = 1.0_f64.max(learned.abs()).max(snapped.abs()).max(min.abs());
    (learned - snapped).abs() <= f64::EPSILON * 16.0 * scale
}

pub fn extended_ranges_for(caps: &Value) -> Value {
    let Some(ranges) = caps.get("ranges").and_then(Value::as_object) else { return json!({}); };
    let mut out = ranges.clone();
    if let Some(power) = out.get_mut("powerLimitW") {
        if power.get("units").and_then(Value::as_str) == Some("W") {
            let advanced = limits_of(Some(LimitsKey {
                pci_device_id: caps.get("pciDeviceId").and_then(Value::as_str),
                aib_vendor: caps.get("aibVendor").and_then(Value::as_str),
            }), true);
            let live = power.get("max").and_then(number);
            let max = advanced.power_limit_w.and_then(|limit| limit.max)
                .or_else(|| advanced.listed.then_some(live).flatten())
                .unwrap_or(EXTENDED_PL_MAX_W);
            if let Some(map) = power.as_object_mut() { map.insert("max".into(), json!(max)); }
        }
    }
    if let Some(temp) = out.get_mut("tempLimitC") {
        if temp.get("units").and_then(Value::as_str) == Some("C") {
            let learned = caps.get("learnedCeilings").and_then(|value| value.get("tempLimitC")).and_then(number);
            let max = learned.filter(|value| valid_learned_temp_ceiling(*value, temp)).unwrap_or(EXTENDED_TL_MAX_C);
            if let Some(map) = temp.as_object_mut() { map.insert("max".into(), json!(max)); }
        }
    }
    if let Some(volt) = out.get_mut("gpuVoltOffsetV") {
        if volt.get("units").and_then(Value::as_str) == Some("V") {
            if let Some(map) = volt.as_object_mut() {
                map.insert("min".into(), json!(ALCHEMIST_NEGATIVE_VOLT_OFFSET_MIN_V));
            }
        }
    }
    Value::Object(out)
}

pub fn split_by_runtime(settings: &Value, ranges: Option<&Value>, mode: Option<&str>, has_sysman: bool, key: Option<LimitsKey<'_>>) -> (Value, Value) {
    let mut driverstore = Map::new();
    let mut extended = Map::new();
    let advanced_mode = mode == Some(OC_MODE_ADVANCED);
    let advanced_power_threshold = if advanced_mode && key.is_some() {
        device_gate_thresholds(key, false, ranges).0
    } else { STD_PL_MAX_W };
    let Some(entries) = settings.as_object() else { return (Value::Object(driverstore), Value::Object(extended)); };
    for (name, value) in entries {
        if value.is_null() { continue; }
        let Some(number_value) = value.as_f64() else {
            driverstore.insert(name.clone(), value.clone());
            continue;
        };
        let wc = is_wc_units(ranges, name);
        let is_wc_control = name == "powerLimitW" || name == "tempLimitC";
        let advanced_power = advanced_mode && name == "powerLimitW" && wc
            && (key.is_none() || number_value > advanced_power_threshold);
        let advanced_temp = advanced_mode && name == "tempLimitC" && wc && number_value > STD_TL_MAX_C;
        if advanced_power || advanced_temp {
            if !(name == "powerLimitW" && is_sysman_primary_power_request(settings, ranges, has_sysman)) {
                extended.insert(name.clone(), value.clone());
            }
        } else if mode == Some(OC_MODE_STOCK) && is_wc_control && wc {
            driverstore.insert(name.clone(), value.clone());
        } else if name == "powerLimitW" && number_value > STD_PL_MAX_W && wc {
            extended.insert(name.clone(), value.clone());
        } else if name == "tempLimitC" && number_value > STD_TL_MAX_C && wc {
            extended.insert(name.clone(), value.clone());
        } else {
            driverstore.insert(name.clone(), value.clone());
        }
    }
    (Value::Object(driverstore), Value::Object(extended))
}

pub fn requires_extended_range(settings: &Value, ranges: Option<&Value>) -> bool {
    let pl_ok = ranges.and_then(|ranges| ranges.get("powerLimitW")).is_none_or(|range| range.get("units").and_then(Value::as_str) == Some("W"));
    let tl_ok = ranges.and_then(|ranges| ranges.get("tempLimitC")).is_none_or(|range| range.get("units").and_then(Value::as_str) == Some("C"));
    (setting(settings, "powerLimitW").is_some_and(|value| value > STD_PL_MAX_W) && pl_ok)
        || (setting(settings, "tempLimitC").is_some_and(|value| value > STD_TL_MAX_C) && tl_ok)
}

fn js_number(value: f64) -> String {
    if value.fract() == 0.0 { format!("{}", value as i64) } else { format!("{value}") }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a750() -> LimitsKey<'static> {
        LimitsKey { pci_device_id: Some("0x000056a1"), aib_vendor: Some("ASRock") }
    }

    #[test]
    fn thresholds_and_mode_gates_match_electron() {
        assert_eq!(device_gate_thresholds(Some(a750()), false, None), (216.0, 90.0));
        assert_eq!(device_gate_thresholds(Some(a750()), true, None), (270.0, 115.0));
        assert_eq!(device_gate_thresholds(None, false, None), (252.0, 90.0));
        let ranges = json!({"powerLimitW":{"units":"W","max":300},"tempLimitC":{"units":"C","max":100}});
        let refusal = oc_mode_refusal(OC_MODE_STOCK, &json!({"powerLimitW":250,"tempLimitC":95}), Some(&ranges), Some(a750())).unwrap();
        assert_eq!(refusal.mode, OC_MODE_STOCK);
        assert_eq!(refusal.controls, vec!["powerLimitW", "tempLimitC"]);
        assert_eq!(refusal.message, OC_MODE_REFUSAL_MSG);
        let advanced = oc_mode_refusal(OC_MODE_ADVANCED, &json!({"powerLimitW":280}), Some(&ranges), Some(a750())).unwrap();
        assert_eq!(advanced.controls, vec!["powerLimitW"]);
        assert_eq!(advanced.message, OC_CEILING_REFUSAL_MSG);
        assert_eq!(oc_mode_refusal(OC_MODE_STOCK, &json!({"powerLimitW":250}), Some(&ranges), Some(LimitsKey { pci_device_id: Some("0x0000e20b"), aib_vendor: None })), None);
        assert_eq!(refusal_per_control(&refusal)["powerLimitW"]["ok"], false);
    }

    #[test]
    fn pre_setter_refusals_are_declined_not_published_as_driver_refusals() {
        // An above-ceiling profile: the mode gate refuses before any setter
        // ran, so the leased apply must finish `not-applied` and hand the
        // authoritative envelope to the broker instead of poisoning the
        // refusal cache through the driver-refusal finish.
        let envelope = json!({"ok": false, "perControl": {"tempLimitC": {
            "ok": false, "errorCode": "out-of-range", "message": OC_CEILING_REFUSAL_MSG,
        }}});
        assert!(is_pre_setter_refusal(&envelope, None, true));
        // A power-only above-ceiling refusal carries no tempLimitC entry at
        // all; the classification still declines before any setter ran.
        let power_only = json!({"ok": false, "perControl": {"powerLimitW": {
            "ok": false, "errorCode": "out-of-range", "message": OC_CEILING_REFUSAL_MSG,
        }}});
        assert!(is_pre_setter_refusal(&power_only, None, true));
        // A capability-ceiling refusal carries a finite ceiling and stays on
        // the native driver-refusal finish (no pre-setter decline).
        let capability = json!({"ok": false, "perControl": {"tempLimitC": {
            "ok": false, "errorCode": "out-of-range", "capabilityCeiling": 100.0,
            "message": "temperature limit 95 °C exceeds the effective capability ceiling of 90 °C. Nothing was changed.",
        }}});
        assert!(!is_pre_setter_refusal(&capability, None, false));
        // A refusal that reached a setter keeps the fail-closed unknown path.
        assert!(!is_pre_setter_refusal(&json!({"ok": false, "perControl": {}}), Some(90.0), true));
        // A successful apply is not a refusal.
        assert!(!is_pre_setter_refusal(&json!({"ok": true, "perControl": {}}), None, false));
    }

    #[test]
    fn extended_refusals_are_unit_aware_and_sysman_exempt() {
        let caps = json!({"ranges":{"powerLimitW":{"units":"W"},"tempLimitC":{"units":"C"}},"extendedRanges":false});
        let refusal = extended_unavailable_refusal(&json!({"powerLimitW":260,"tempLimitC":95}), &caps, false).unwrap();
        assert_eq!(refusal.controls, vec!["powerLimitW", "tempLimitC"]);
        assert_eq!(refusal.message, EXTENDED_UNAVAILABLE_MSG);
        assert_eq!(extended_unavailable_refusal(&json!({"powerLimitW":330}), &caps, true), None);
        assert!(is_sysman_primary_power_request(&json!({"powerLimitW":260}), Some(&json!({"powerLimitW":{"units":"W"}})), true));
        let explicit = json!({"ranges":{"powerLimitW":{"units":"W"},"tempLimitC":{"units":"C"}},"extendedControls":{"powerLimitW":true,"tempLimitC":true}});
        assert_eq!(extended_unavailable_refusal(&json!({"powerLimitW":260,"tempLimitC":100}), &explicit, false), None);
        assert_eq!(wc_unit_controls(&json!({"powerLimitW":260,"tempLimitC":95,"gpuFreqOffsetMhz":50}), Some(&json!({"powerLimitW":{"units":"W"},"tempLimitC":{"units":"%"}}))), vec!["powerLimitW"]);
        assert_eq!(extended_unavailable_per_control(&["tempLimitC"])["tempLimitC"]["errorCode"], "unsupported");
    }

    #[test]
    fn selected_legacy_controls_require_per_control_support() {
        let caps = json!({"extendedControls":{"powerLimitW":false,"tempLimitC":true}});
        assert_eq!(
            unsupported_legacy_targets(&["powerLimitW", "tempLimitC"], &caps),
            vec!["powerLimitW"],
        );
        assert!(unsupported_legacy_targets(&["tempLimitC"], &caps).is_empty());
        assert_eq!(unsupported_legacy_targets(&["powerLimitW"], &json!({})), vec!["powerLimitW"]);
    }

    #[test]
    fn temperature_capability_and_extended_range_shaping_match_electron() {
        let ranges = json!({"tempLimitC":{"units":"C","min":50,"max":90}});
        let refusal = temp_capability_refusal(&json!({"tempLimitC":95}), Some(&ranges)).unwrap();
        assert_eq!(refusal.capability_ceiling, 90.0);
        assert_eq!(refusal.message, "temperature limit 95 °C exceeds the effective capability ceiling of 90 °C. Nothing was changed.");
        assert_eq!(temp_capability_per_control(&refusal)["tempLimitC"]["errorCode"], "out-of-range");
        let caps = json!({
            "pciDeviceId":"0x000056a1","aibVendor":"ASRock",
            "ranges":{
                "powerLimitW":{"units":"W","max":216,"min":0,"step":1},
                "tempLimitC":{"units":"C","max":90,"min":50,"step":1},
                "gpuVoltOffsetV":{"units":"V","min":0,"max":0.2,"step":0.001}
            }
        });
        let shaped = extended_ranges_for(&caps);
        assert_eq!(shaped["powerLimitW"]["max"], 270.0);
        assert_eq!(shaped["tempLimitC"]["max"], 115.0);
        assert_eq!(shaped["gpuVoltOffsetV"]["min"], -0.2);
        let learned = json!({"ranges":{"tempLimitC":{"units":"C","min":50,"max":90,"step":1}},"learnedCeilings":{"tempLimitC":85}});
        assert_eq!(extended_ranges_for(&learned)["tempLimitC"]["max"], 85.0);
        assert_eq!(extended_ranges_for(&json!({"ranges":{"tempLimitC":{"units":"C","min":50,"max":90,"step":1}},"learnedCeilings":{"tempLimitC":85.5}}))["tempLimitC"]["max"], 115.0);
    }

    #[test]
    fn runtime_split_matches_electron() {
        let ranges = json!({"powerLimitW":{"units":"W"},"tempLimitC":{"units":"C"}});
        let settings = json!({"powerLimitW":250,"tempLimitC":95,"gpuFreqOffsetMhz":50});
        let (driverstore, extended) = split_by_runtime(&settings, Some(&ranges), Some(OC_MODE_ADVANCED), false, Some(LimitsKey { pci_device_id: Some("0x0000e20b"), aib_vendor: None }));
        assert_eq!(driverstore, json!({"powerLimitW":250,"gpuFreqOffsetMhz":50}));
        assert_eq!(extended, json!({"tempLimitC":95}));
        let (driverstore, extended) = split_by_runtime(&json!({"powerLimitW":250,"tempLimitC":95}), Some(&ranges), Some(OC_MODE_ADVANCED), false, Some(a750()));
        assert_eq!(driverstore, json!({}));
        assert_eq!(extended, json!({"powerLimitW":250,"tempLimitC":95}));
        assert!(requires_extended_range(&json!({"powerLimitW":260}), Some(&json!({"powerLimitW":{"units":"W"}}))));
        assert!(!requires_extended_range(&json!({"powerLimitW":260}), Some(&json!({"powerLimitW":{"units":"%"}}))));
    }

}
