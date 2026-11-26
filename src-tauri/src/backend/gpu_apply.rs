//! Scalar V2 apply core (port of Electron's `applyScalar` loop).
//! One setter call per control plus exact canonical read-back. The caller
//! supplies a backend so unit/mock tests never touch hardware.
use super::gpu_units::{canonical_to_igcl, clamp_and_snap, igcl_to_canonical, nearly_equal, Range};
use super::igcl_raw::ctl_oc_properties_t;
use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScalarControl {
    GpuFreqOffset,
    GpuVoltOffset,
    PowerLimit,
    TempLimit,
    VramFreqOffset,
}

impl ScalarControl {
    pub fn canonical(self) -> &'static str {
        match self {
            Self::GpuFreqOffset => "gpuFreqOffsetMhz",
            Self::GpuVoltOffset => "gpuVoltOffsetV",
            Self::PowerLimit => "powerLimitW",
            Self::TempLimit => "tempLimitC",
            Self::VramFreqOffset => "vramFreqOffsetGts",
        }
    }

    pub fn capability(self) -> &'static str {
        match self {
            Self::GpuFreqOffset => "gpuFreqOffset",
            Self::GpuVoltOffset => "gpuVoltOffset",
            Self::PowerLimit => "powerLimit",
            Self::TempLimit => "tempLimit",
            Self::VramFreqOffset => "vramFreqOffset",
        }
    }
}

pub const SCALAR_CONTROLS: [ScalarControl; 5] = [
    ScalarControl::PowerLimit,
    ScalarControl::TempLimit,
    ScalarControl::VramFreqOffset,
    ScalarControl::GpuFreqOffset,
    ScalarControl::GpuVoltOffset,
];

#[derive(Clone, Copy, Debug, Default)]
pub struct ScalarUnits {
    pub gpu_freq_offset: i32,
    pub gpu_volt_offset: i32,
    pub power_limit: i32,
    pub temp_limit: i32,
    pub vram_freq_offset: i32,
}

impl ScalarUnits {
    #[allow(dead_code)] // used by the native apply backend in the next slice
    pub(crate) fn from_oc(oc: &ctl_oc_properties_t) -> Self {
        Self {
            gpu_freq_offset: oc.gpuFrequencyOffset.units,
            gpu_volt_offset: oc.gpuVoltageOffset.units,
            power_limit: oc.powerLimit.units,
            temp_limit: oc.temperatureLimit.units,
            vram_freq_offset: oc.vramMemSpeedLimit.units,
        }
    }

    fn of(self, control: ScalarControl) -> i32 {
        match control {
            ScalarControl::GpuFreqOffset => self.gpu_freq_offset,
            ScalarControl::GpuVoltOffset => self.gpu_volt_offset,
            ScalarControl::PowerLimit => self.power_limit,
            ScalarControl::TempLimit => self.temp_limit,
            ScalarControl::VramFreqOffset => self.vram_freq_offset,
        }
    }
}

/// Native boundary used by the real IGCL writer and by mock tests.
pub trait ScalarBackend {
    /// Returns the raw `ctl_result_t` from the V2 setter.
    fn set_scalar(&mut self, control: ScalarControl, igcl_value: f64) -> u32;
    /// Returns the raw IGCL value from the V2 getter or the raw result code.
    fn get_scalar(&mut self, control: ScalarControl) -> Result<f64, u32>;
}

pub fn is_momentary_lie_candidate(per: &Value) -> bool {
    if per.get("ok") != Some(&Value::Bool(false)) { return false; }
    if per.get("readBackEqual") == Some(&Value::Bool(true)) { return false; }
    let code = per.get("errorCode").and_then(Value::as_str);
    if code.is_some_and(|code| code != "io-failed") { return false; }
    per.get("silentNoop") == Some(&Value::Bool(true)) || code == Some("io-failed")
}

/// The clamped canonical target for one scalar control (for delayed re-reads).
pub fn clamped_scalar(settings: &Value, caps: &Value, control: ScalarControl, snap_to_step: bool) -> Option<f64> {
    let value = number(settings.get(control.canonical())?)?;
    let range = range_of(caps, control.canonical())?;
    Some(if snap_to_step {
        clamp_and_snap(value, range)
    } else {
        range.max.min(range.min.max(value))
    })
}

pub fn igcl_error_code(code: u32) -> Option<&'static str> {
    match code {
        0x4400_0008 => Some("waiver-not-set"),
        0x4400_0002 | 0x4400_0003 | 0x4400_0004 | 0x4400_0005 | 0x4400_000d | 0x4400_000e => Some("out-of-range"),
        0x4400_0006 => Some("locked-mode"),
        0x4400_0007 => Some("reset-required"),
        0x4000_000a => Some("unsupported"),
        0x4000_0006 => Some("permission-denied"),
        0x4000_000b => Some("invalid-argument"),
        _ => None,
    }
}

fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|value| value.is_finite())
}

fn range_of(caps: &Value, key: &str) -> Option<Range> {
    let range = caps.get("ranges")?.get(key)?;
    Some(Range {
        min: range.get("min").and_then(number)?,
        max: range.get("max").and_then(number)?,
        step: range.get("step").and_then(number).unwrap_or(0.0),
    })
}

fn fail(per_control: &mut Map<String, Value>, ok: &mut bool, control: &str, error_code: &str, message: String) {
    *ok = false;
    per_control.insert(control.to_owned(), json!({
        "ok": false, "errorCode": error_code, "message": message,
    }));
}

/// Apply the scalar controls present in `settings`. Lock, fan and VF writes
/// are deliberately outside this subset; callers must route those elsewhere.
pub fn apply_scalars(
    settings: &Value,
    caps: &Value,
    units: &ScalarUnits,
    backend: &mut dyn ScalarBackend,
    snap_to_step: bool,
) -> Value {
    let mut per_control = Map::new();
    let mut ok = true;
    let Some(settings) = settings.as_object() else {
        return json!({"ok": false, "perControl": {}});
    };
    for control in SCALAR_CONTROLS {
        let canonical = control.canonical();
        let Some(value) = settings.get(canonical) else { continue; };
        if value.is_null() { continue; }
        if caps.get("controls").and_then(|controls| controls.get(control.capability())) != Some(&Value::Bool(true)) {
            fail(&mut per_control, &mut ok, canonical, "unsupported", "control not supported on this device".into());
            continue;
        }
        let Some(range) = range_of(caps, canonical) else {
            fail(&mut per_control, &mut ok, canonical, "unsupported", "no capability range reported for this control".into());
            continue;
        };
        if canonical == "gpuVoltOffsetV" && caps["ranges"]["gpuVoltOffsetV"]["units"].as_str() == Some("V")
            && number(value).is_some_and(|value| value < 0.0) {
            fail(&mut per_control, &mut ok, canonical, "unsupported", "negative Alchemist voltage offsets use the Sysman apply route".into());
            continue;
        }
        let Some(value) = number(value) else {
            fail(&mut per_control, &mut ok, canonical, "invalid-argument", "value must be a finite number".into());
            continue;
        };
        let clamped = if snap_to_step {
            clamp_and_snap(value, range)
        } else {
            range.max.min(range.min.max(if value.is_finite() { value } else { range.min }))
        };
        let unit = units.of(control);
        let igcl_value = canonical_to_igcl(clamped, f64::from(unit));
        let set_result = backend.set_scalar(control, igcl_value);
        if set_result != 0 {
            fail(&mut per_control, &mut ok, canonical,
                igcl_error_code(set_result).unwrap_or("io-failed"),
                format!("IGCL result 0x{set_result:08x}"));
            continue;
        }
        let (read_back_equal, message) = match backend.get_scalar(control) {
            Ok(raw) => {
                let read_back = igcl_to_canonical(raw, f64::from(unit));
                let equal = nearly_equal(read_back, clamped, 1e-9);
                (equal, (!equal).then(|| format!("read-back {read_back} != requested {clamped}")))
            }
            Err(result) => (false, Some(format!("set succeeded but read-back failed (result 0x{result:08x})"))),
        };
        if !read_back_equal { ok = false; }
        let mut entry = Map::new();
        entry.insert("ok".into(), json!(read_back_equal));
        if !read_back_equal { entry.insert("errorCode".into(), json!("io-failed")); }
        if let Some(message) = message { entry.insert("message".into(), json!(message)); }
        entry.insert("readBackEqual".into(), json!(read_back_equal));
        entry.insert("silentNoop".into(), json!(!read_back_equal));
        per_control.insert(canonical.to_owned(), Value::Object(entry));
    }
    json!({"ok": ok, "perControl": per_control})
}

pub const REFUSAL_PLAIN_MSG: &str = "The GPU driver refused the change.";
pub const HARD_ERROR_CODES: [&str; 9] = [
    "waiver-not-set", "out-of-range", "locked-mode", "reset-required", "invalid-argument",
    "unsupported", "unavailable-symbol", "driver-adjustment-out-of-range", "driver-noop",
];

pub fn is_verified_success(per: &Value) -> bool {
    per.get("ok") == Some(&Value::Bool(true))
        && (per.get("readBackEqual") != Some(&Value::Bool(false))
            || per.get("normalized") == Some(&Value::Bool(true)))
}

pub fn refusal_message(control: &str, per: &Value) -> Option<String> {
    if per.is_null() || is_verified_success(per) { return None; }
    if matches!(control, "vfCurve" | "fanCurve" | "fanMode" | "fixedFanPct") {
        if let Some(message) = per.get("message").and_then(Value::as_str).filter(|message| !message.trim().is_empty()) {
            return Some(message.to_owned());
        }
    }
    let code = per.get("errorCode").and_then(Value::as_str);
    if code.is_some_and(|code| HARD_ERROR_CODES.contains(&code)) { return None; }
    Some(match code {
        Some(code) => format!("{REFUSAL_PLAIN_MSG} ({code})"),
        None => REFUSAL_PLAIN_MSG.to_owned(),
    })
}

/// Port of `applyOnce`'s result normalization: refusals get the plain message,
/// hard outcomes keep their diagnostic-free shape, and `ok` is recomputed from
/// verified successes only.
pub fn finalize_apply_result(mut result: Value) -> Value {
    let Some(per_control) = result.get_mut("perControl").and_then(Value::as_object_mut) else {
        return result;
    };
    let controls: Vec<String> = per_control.keys().cloned().collect();
    for control in controls {
        let Some(entry) = per_control.get(&control) else { continue; };
        let message = refusal_message(&control, entry);
        let mut map = entry.as_object().cloned().unwrap_or_default();
        if let Some(message) = message {
            map.insert("message".into(), json!(message));
            map.insert("ok".into(), json!(false));
        } else if map.contains_key("message") && map.get("normalized") != Some(&Value::Bool(true)) {
            map.remove("message");
        }
        per_control.insert(control, Value::Object(map));
    }
    let ok = per_control.is_empty() || per_control.values().all(is_verified_success);
    result["ok"] = json!(ok);
    result
}

/// Derive the capabilityCeilingRefused / capabilityCeilingPartial markers from
/// the FINAL per-control results (after `finalize_apply_result` and any planned
/// refusal merge), mirroring `withCapabilityFlags` in apply-routing.js. The flags
/// are derived solely from valid native capability markers; malformed markers
/// never become capability refusals and never leak stale flags.
///
/// Returns `(refused, partial)`: refused is true when at least one final control
/// was refused by a capability ceiling; partial is true when a refused
/// capability control sits beside another control (never true on its own).
pub fn capability_ceiling_flags(result: &Value) -> (bool, bool) {
    let Some(per_control) = result.get("perControl").and_then(Value::as_object) else { return (false, false); };
    let mut valid = 0_usize;
    let mut total = 0_usize;
    for entry in per_control.values() {
        total += 1;
        if entry.get("ok") == Some(&Value::Bool(false))
            && entry.get("errorCode").and_then(Value::as_str) == Some("out-of-range")
            && entry.get("capabilityCeiling").and_then(Value::as_f64).is_some_and(|ceiling| ceiling.is_finite())
        {
            valid += 1;
        }
    }
    (valid > 0, valid > 0 && total > valid)
}

/// Merge planned pre-clamp refusals into the final apply result and recompute
/// `ok` from the final per-control entries only, so a refused control is never
/// reported as applied. Returns true when at least one planned refusal existed.
pub fn merge_planned_refusals(result: &mut Value, plan_refusals: &Value) -> bool {
    let Some(per_control) = result.get_mut("perControl").and_then(Value::as_object_mut) else { return false; };
    let Some(refusals) = plan_refusals.as_object() else { return false; };
    if refusals.is_empty() { return false; }
    for (key, value) in refusals {
        per_control.insert(key.clone(), value.clone());
    }
    result["ok"] = json!(per_control.values().all(|entry| entry.get("ok") == Some(&Value::Bool(true))));
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct Mock {
        sets: Vec<(ScalarControl, f64)>,
        reads: HashMap<usize, f64>,
        set_result: u32,
        get_result: Option<u32>,
    }

    fn key(control: ScalarControl) -> usize {
        match control {
            ScalarControl::GpuFreqOffset => 0,
            ScalarControl::GpuVoltOffset => 1,
            ScalarControl::PowerLimit => 2,
            ScalarControl::TempLimit => 3,
            ScalarControl::VramFreqOffset => 4,
        }
    }

    impl ScalarBackend for Mock {
        fn set_scalar(&mut self, control: ScalarControl, igcl_value: f64) -> u32 {
            self.sets.push((control, igcl_value));
            self.set_result
        }
        fn get_scalar(&mut self, control: ScalarControl) -> Result<f64, u32> {
            if let Some(result) = self.get_result { return Err(result); }
            Ok(self.reads.get(&key(control)).copied().unwrap_or_else(|| {
                self.sets.iter().rev().find(|(item, _)| *item == control).map(|(_, value)| *value).unwrap_or(0.0)
            }))
        }
    }

    fn caps() -> Value {
        json!({
            "controls": {"gpuFreqOffset": true, "gpuVoltOffset": true, "powerLimit": true, "tempLimit": true, "vramFreqOffset": true},
            "ranges": {
                "gpuFreqOffsetMhz": {"units": "MHz", "min": -100, "max": 200, "step": 10},
                "gpuVoltOffsetV": {"units": "V", "min": -0.5, "max": 0.5, "step": 0.001},
                "powerLimitW": {"units": "W", "min": 50, "max": 250, "step": 1},
                "tempLimitC": {"units": "C", "min": 50, "max": 90, "step": 1},
                "vramFreqOffsetGts": {"units": "GTS", "min": -5, "max": 5, "step": 0.5}
            }
        })
    }

    fn units() -> ScalarUnits {
        ScalarUnits { gpu_freq_offset: 0, gpu_volt_offset: 13, power_limit: 4, temp_limit: 5, vram_freq_offset: 1 }
    }

    #[test]
    fn scalar_apply_clamps_converts_and_verifies() {
        let mut mock = Mock::default();
        let result = apply_scalars(
            &json!({"gpuFreqOffsetMhz": 205, "gpuVoltOffsetV": 0.45, "powerLimitW": 114, "tempLimitC": 80, "vramFreqOffsetGts": 1.25}),
            &caps(), &units(), &mut mock, true,
        );
        assert_eq!(result["ok"], true);
        assert_eq!(result["perControl"]["gpuFreqOffsetMhz"]["readBackEqual"], true);
        assert_eq!(result["perControl"]["gpuVoltOffsetV"]["readBackEqual"], true);
        let set_value = |control| mock.sets.iter().find(|(item, _)| *item == control).unwrap().1;
        assert_eq!(set_value(ScalarControl::GpuFreqOffset), 200.0);
        assert_eq!(set_value(ScalarControl::GpuVoltOffset), 450.0);
        assert_eq!(set_value(ScalarControl::PowerLimit), 114.0);
        assert_eq!(set_value(ScalarControl::VramFreqOffset), 1.5);
    }

    #[test]
    fn mismatch_is_a_silent_noop_and_setter_refusal_maps_codes() {
        let mut mock = Mock::default();
        mock.reads.insert(0, 999.0);
        let result = apply_scalars(&json!({"gpuFreqOffsetMhz": 50, "powerLimitW": 100}), &caps(), &units(), &mut mock, true);
        assert_eq!(result["ok"], false);
        assert_eq!(result["perControl"]["gpuFreqOffsetMhz"]["errorCode"], "io-failed");
        assert_eq!(result["perControl"]["gpuFreqOffsetMhz"]["silentNoop"], true);
        assert_eq!(result["perControl"]["gpuFreqOffsetMhz"]["readBackEqual"], false);
        let mut mock = Mock { set_result: 0x4400_0004, ..Mock::default() };
        let result = apply_scalars(&json!({"powerLimitW": 100}), &caps(), &units(), &mut mock, true);
        assert_eq!(result["perControl"]["powerLimitW"]["errorCode"], "out-of-range");
        assert!(result["perControl"]["powerLimitW"].get("readBackEqual").is_none());
        let mut mock = Mock { get_result: Some(0x4000_0006), ..Mock::default() };
        let result = apply_scalars(&json!({"powerLimitW": 100}), &caps(), &units(), &mut mock, true);
        assert_eq!(result["perControl"]["powerLimitW"]["errorCode"], "io-failed");
        assert!(result["perControl"]["powerLimitW"]["message"].as_str().unwrap().contains("read-back failed"));
    }

    #[test]
    fn unsupported_missing_range_and_negative_voltage_fail_before_writes() {
        let mut caps = caps();
        caps["controls"]["tempLimit"] = json!(false);
        caps["ranges"].as_object_mut().unwrap().remove("vramFreqOffsetGts");
        let mut mock = Mock::default();
        let result = apply_scalars(
            &json!({"tempLimitC": 80, "vramFreqOffsetGts": 1, "gpuVoltOffsetV": -0.1, "unknown": 1}),
            &caps, &units(), &mut mock, true,
        );
        assert_eq!(result["perControl"]["tempLimitC"]["errorCode"], "unsupported");
        assert_eq!(result["perControl"]["vramFreqOffsetGts"]["errorCode"], "unsupported");
        assert_eq!(result["perControl"]["gpuVoltOffsetV"]["errorCode"], "unsupported");
        assert!(result["perControl"].get("unknown").is_none());
        assert!(mock.sets.is_empty());
    }

    #[test]
    fn absent_and_null_values_are_skipped_and_empty_payload_is_ok() {
        let mut mock = Mock::default();
        let result = apply_scalars(&json!({"powerLimitW": null}), &caps(), &units(), &mut mock, true);
        assert_eq!(result, json!({"ok": true, "perControl": {}}));
        assert!(mock.sets.is_empty());
        assert_eq!(igcl_error_code(0x4000_000a), Some("unsupported"));
        assert_eq!(igcl_error_code(0x1234_5678), None);
    }

    #[test]
    fn finalize_matches_apply_once_classification() {
        let result = json!({"ok": true, "perControl": {
            "powerLimitW": {"ok": false, "errorCode": "io-failed", "message": "read-back 1 != 2", "readBackEqual": false, "silentNoop": true},
            "tempLimitC": {"ok": false, "errorCode": "out-of-range", "message": "IGCL result"},
            "gpuFreqOffsetMhz": {"ok": true, "message": "diagnostic", "readBackEqual": true}
        }});
        let out = finalize_apply_result(result);
        assert_eq!(out["ok"], false);
        assert_eq!(out["perControl"]["powerLimitW"]["message"], "The GPU driver refused the change. (io-failed)");
        assert!(out["perControl"]["tempLimitC"].get("message").is_none());
        assert!(out["perControl"]["gpuFreqOffsetMhz"].get("message").is_none());
        assert_eq!(out["perControl"]["gpuFreqOffsetMhz"]["ok"], true);

        let unverified = finalize_apply_result(json!({"ok": true, "perControl": {"x": {"ok": true, "readBackEqual": false}}}));
        assert_eq!(unverified["ok"], false);
        assert_eq!(unverified["perControl"]["x"]["message"], "The GPU driver refused the change.");
        let curve = finalize_apply_result(json!({"ok": false, "perControl": {"vfCurve": {"ok": false, "errorCode": "io-failed", "message": "point 3 mismatch"}}}));
        assert_eq!(curve["perControl"]["vfCurve"]["message"], "point 3 mismatch");
        for control in ["fanCurve", "fanMode", "fixedFanPct"] {
            for code in ["io-failed", "invalid-argument"] {
                let input = json!({"ok": false, "perControl": {control: {"ok": false, "errorCode": code, "message": "fan curve point 1 read-back 53C/40% != requested 53C/45%"}}});
                let output = finalize_apply_result(input);
                assert_eq!(output["perControl"][control]["message"], "fan curve point 1 read-back 53C/40% != requested 53C/45%");
                assert_eq!(output["perControl"][control]["ok"], false);
            }
        }
    }

    #[test]
    fn planned_refusals_merge_after_finalize_and_never_claim_success() {
        let applied = json!({"ok": true, "perControl": {
            "powerLimitW": {"ok": true, "readBackEqual": true},
            "gpuFreqOffsetMhz": {"ok": true, "readBackEqual": true},
        }});
        let refusal = json!({"tempLimitC": {
            "ok": false, "errorCode": "out-of-range", "capabilityCeiling": 90.0,
            "message": "temperature limit 95 °C exceeds the effective capability ceiling of 90 °C. Nothing was changed.",
        }});
        // The plan refusal is merged AFTER finalize: finalize alone strips the
        // refusal message (out-of-range is a hard code), so the order matters.
        let mut result = finalize_apply_result(applied);
        assert_eq!(result["ok"], true);
        assert_eq!(capability_ceiling_flags(&result), (false, false));
        assert!(merge_planned_refusals(&mut result, &refusal));
        assert_eq!(result["ok"], false);
        assert_eq!(result["perControl"]["tempLimitC"]["ok"], false);
        assert_eq!(result["perControl"]["tempLimitC"]["capabilityCeiling"], json!(90.0));
        assert!(result["perControl"]["tempLimitC"]["message"].as_str().is_some_and(|message| message.contains("capability ceiling")));
        // The control that actually applied is still reported applied.
        assert_eq!(result["perControl"]["powerLimitW"]["ok"], true);
        assert_eq!(capability_ceiling_flags(&result), (true, true));
        // Finalizing again may strip the message but never resurrects the
        // refused control or recomputes ok from a stale value.
        let refinalized = finalize_apply_result(result.clone());
        assert_eq!(refinalized["ok"], false);
        assert_eq!(refinalized["perControl"]["tempLimitC"]["ok"], false);
        assert_eq!(capability_ceiling_flags(&refinalized), (true, true));
        // An empty plan merges nothing and leaves the recomputed result intact.
        let mut untouched = result.clone();
        assert!(!merge_planned_refusals(&mut untouched, &json!({})));
        assert_eq!(untouched, result);
        // A result without a per-control object cannot accept a merge.
        let mut malformed = json!({"ok": true});
        assert!(!merge_planned_refusals(&mut malformed, &refusal));
        assert_eq!(malformed, json!({"ok": true}));
    }

    #[test]
    fn capability_flags_come_from_valid_final_markers_only() {
        let refused = json!({"perControl": {"tempLimitC": {
            "ok": false, "errorCode": "out-of-range", "capabilityCeiling": 90.0,
        }}});
        assert_eq!(capability_ceiling_flags(&refused), (true, false));
        let partial = json!({"perControl": {
            "tempLimitC": {"ok": false, "errorCode": "out-of-range", "capabilityCeiling": 90.0},
            "powerLimitW": {"ok": true, "readBackEqual": true},
        }});
        assert_eq!(capability_ceiling_flags(&partial), (true, true));
        // A mode-gate refusal carries no ceiling: never a capability refusal.
        let mode_gate = json!({"perControl": {"tempLimitC": {"ok": false, "errorCode": "out-of-range"}}});
        assert_eq!(capability_ceiling_flags(&mode_gate), (false, false));
        // Malformed or non-finite ceilings never become capability refusals.
        for ceiling in [json!("90"), json!(null), json!(false)] {
            let malformed = json!({"perControl": {"tempLimitC": {
                "ok": false, "errorCode": "out-of-range", "capabilityCeiling": ceiling,
            }}});
            assert_eq!(capability_ceiling_flags(&malformed), (false, false));
        }
        // A success never counts, and partial never appears without refused.
        let success = json!({"perControl": {"tempLimitC": {
            "ok": true, "errorCode": "out-of-range", "capabilityCeiling": 90.0,
        }}});
        assert_eq!(capability_ceiling_flags(&success), (false, false));
        assert_eq!(capability_ceiling_flags(&json!({})), (false, false));
    }

    #[test]
    #[ignore = "live read-only power limit"]
    fn live_read_power_limit() {
        let path = crate::backend::gpu_devices::locate_dll().expect("IGCL DLL not found");
        let caps = crate::backend::gpu_capabilities::capabilities(&path, 0, "stock", false).expect("capabilities");
        let state = crate::backend::gpu_capabilities::current_settings(&path, 0).expect("state");
        println!("LIVE_DEVICE {}", caps["deviceName"]);
        println!("LIVE_POWER_LIMIT {}", state["powerLimitW"]);
        println!("LIVE_TEMP_LIMIT {}", state["tempLimitC"]);
    }

    #[test]
    #[ignore = "live reversible scalar write; requires explicit approval"]
    fn live_reversible_power_limit_when_approved() {
        use crate::backend::igcl_read_only::ReadOnlyIgcl;
        let path = crate::backend::gpu_devices::locate_dll().expect("IGCL DLL not found");
        let caps = crate::backend::gpu_capabilities::capabilities(&path, 0, "stock", false).expect("capabilities");
        assert!(caps["deviceName"].as_str().unwrap_or("").contains("B580"), "expected the B580 device");
        let state = crate::backend::gpu_capabilities::current_settings(&path, 0).expect("state");
        let original = state["powerLimitW"].as_f64().expect("current power limit");
        let range = &caps["ranges"]["powerLimitW"];
        let min = range["min"].as_f64().expect("power min");
        let max = range["max"].as_f64().expect("power max");
        let step = range["step"].as_f64().filter(|value| *value > 0.0).unwrap_or(1.0);
        let target = if original + step <= max { original + step } else { original - step };
        assert!(target >= min && target <= max, "target {target} outside [{min}, {max}]");

        let mut igcl = ReadOnlyIgcl::load(&path).expect("IGCL session");
        igcl.enumerate_adapters().expect("enumerate");
        let snapshot = igcl.controls_snapshot(0).expect("controls");
        let units = ScalarUnits::from_oc(&snapshot.oc);
        let first = {
            let mut backend = igcl.scalar_backend(0).expect("scalar backend");
            apply_scalars(&json!({"powerLimitW": target}), &caps, &units, &mut backend, true)
        };
        // Restore unconditionally, even if the first write reported a mismatch.
        let restored = {
            let mut backend = igcl.scalar_backend(0).expect("scalar backend");
            apply_scalars(&json!({"powerLimitW": original}), &caps, &units, &mut backend, true)
        };
        let _ = igcl.close();
        eprintln!("{}", serde_json::to_string_pretty(&json!({
            "original": original, "target": target, "first": first, "restored": restored,
        })).unwrap());
        assert_eq!(first["perControl"]["powerLimitW"]["ok"], json!(true), "target write failed");
        assert_eq!(restored["perControl"]["powerLimitW"]["ok"], json!(true), "restore failed");
        let after = crate::backend::gpu_capabilities::current_settings(&path, 0).expect("state after");
        assert!(nearly_equal(after["powerLimitW"].as_f64().expect("restored power limit"), original, 1e-9),
            "power limit was not restored");
    }
}

