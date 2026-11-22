//! Native per-application 3D feature apply. Mirrors the product IGCL path:
//! select the driver scope, write only supplied controls, then verify each
//! value by reading it back. No write is reported successful without read-back.
use super::game_profile_capabilities::intel_integrated_or_mobile;
use super::gpu_capabilities::open_for_device;
use super::igcl_raw::ctl_3d_feature_details_t;
use super::igcl_read_only::{IgclError, ReadOnlyIgcl};
use serde_json::{json, Value};
use std::path::Path;

const FEATURE_ENDURANCE_GAMING: i32 = 1;
const FEATURE_FRAME_LIMIT: i32 = 2;
const FEATURE_SHARPENING_FILTER: i32 = 7;
const FEATURE_GAMING_FLIP_MODES: i32 = 9;
const FEATURE_GLOBAL_OR_PER_APP: i32 = 15;
const FEATURE_LOW_LATENCY: i32 = 16;
const FEATURE_FRAME_GENERATION: i32 = 17;
const VALUE_INT32: i32 = 2;
const VALUE_UINT32: i32 = 3;
const VALUE_ENUM: i32 = 4;
const ERROR_UNSUPPORTED: u32 = 0x4000_000a;
const ERROR_INVALID_ARGUMENT: u32 = 0x4000_000b;
const ERROR_PERMISSION: u32 = 0x4000_0006;

trait FeatureIo {
    fn features(&mut self, index: usize) -> Result<Vec<ctl_3d_feature_details_t>, IgclError>;
    fn set_scope(&mut self, index: usize, enabled: bool, application: &str) -> Result<(), IgclError>;
    fn read_enum(&mut self, index: usize, feature: i32, application: &str) -> Result<u32, IgclError>;
    fn write_enum(&mut self, index: usize, feature: i32, value: u32, application: &str) -> Result<(), IgclError>;
    fn read_int(&mut self, index: usize, feature: i32, application: &str) -> Result<(bool, i32), IgclError>;
    fn write_int(&mut self, index: usize, feature: i32, enabled: bool, value: i32, application: &str) -> Result<(), IgclError>;
}

impl FeatureIo for ReadOnlyIgcl {
    fn features(&mut self, index: usize) -> Result<Vec<ctl_3d_feature_details_t>, IgclError> { self.supported_3d_features(index) }
    fn set_scope(&mut self, index: usize, enabled: bool, application: &str) -> Result<(), IgclError> { self.set_3d_scope(index, enabled, application) }
    fn read_enum(&mut self, index: usize, feature: i32, application: &str) -> Result<u32, IgclError> { self.read_3d_enum(index, feature, application) }
    fn write_enum(&mut self, index: usize, feature: i32, value: u32, application: &str) -> Result<(), IgclError> { self.write_3d_enum(index, feature, value, application) }
    fn read_int(&mut self, index: usize, feature: i32, application: &str) -> Result<(bool, i32), IgclError> { self.read_3d_int(index, feature, application) }
    fn write_int(&mut self, index: usize, feature: i32, enabled: bool, value: i32, application: &str) -> Result<(), IgclError> { self.write_3d_int(index, feature, enabled, value, application) }
}

fn basename(path: &str) -> String { path.rsplit(['\\', '/']).next().unwrap_or(path).trim().to_owned() }

pub(crate) fn error_code(error: &IgclError) -> &'static str {
    match error.status {
        Some(ERROR_UNSUPPORTED) => "unsupported",
        Some(ERROR_INVALID_ARGUMENT) => "invalid-argument",
        Some(ERROR_PERMISSION) => "permission-denied",
        _ => "io-failed",
    }
}

pub(crate) fn int_range(detail: &ctl_3d_feature_details_t) -> Option<(i32, i32, i32, i32)> {
    let read = |offset: usize| -> Option<i32> {
        if offset + 4 > detail.Value.len() { return None; }
        Some(i32::from_le_bytes(detail.Value[offset..offset + 4].try_into().ok()?))
    };
    Some((read(4)?, read(8)?, read(12)?, read(16)?))
}

pub(crate) fn enum_supported(detail: &ctl_3d_feature_details_t) -> Option<u64> {
    if detail.Value.len() < 8 { return None; }
    Some(u64::from_le_bytes(detail.Value[0..8].try_into().ok()?))
}

fn clamp_snap(value: f64, min: i32, max: i32, step: i32) -> i32 {
    let step = step.max(1);
    let clamped = value.round().clamp(min as f64, max as f64) as i32;
    let snapped = min + ((clamped - min + step / 2) / step) * step;
    snapped.clamp(min, max)
}

pub(crate) fn feature(features: &[ctl_3d_feature_details_t], feature_type: i32) -> Option<ctl_3d_feature_details_t> {
    features.iter().copied().find(|detail| detail.FeatureType == feature_type)
}

fn fail(result: &mut Value, control: &str, error_code: &str, message: impl Into<String>) {
    result["ok"] = json!(false);
    result["perControl"][control] = json!({"ok": false, "errorCode": error_code, "message": message.into()});
}

fn set_enum_control(
    io: &mut dyn FeatureIo, result: &mut Value, index: usize, app: &str,
    control: &str, feature_type: i32, detail: Option<ctl_3d_feature_details_t>, requested: u32, gate_supported: bool,
) {
    let Some(detail) = detail else {
        fail(result, control, "unsupported", format!("{control} is not supported by this driver"));
        return;
    };
    if !app.is_empty() && detail.PerAppSupport == 0 {
        fail(result, control, "unsupported", format!("{control} is not exposed as a per-game driver setting"));
        return;
    }
    if gate_supported {
        if let Some(supported) = enum_supported(&detail) {
            if detail.ValueType == VALUE_ENUM && supported & u64::from(requested) == 0 {
                fail(result, control, "unsupported", format!("the requested {control} option is not supported by this driver"));
                return;
            }
        }
    }
    if let Err(error) = io.write_enum(index, feature_type, requested, app) {
        fail(result, control, error_code(&error), error.to_string());
        return;
    }
    let read_back = io.read_enum(index, feature_type, app);
    let equal = read_back.as_ref().is_ok_and(|value| *value == requested);
    result["perControl"][control] = json!({
        "ok": equal, "readBackEqual": equal,
        "errorCode": if equal { Value::Null } else { json!("io-failed") },
        "message": if equal { Value::Null } else { json!(format!("read-back did not match requested {} value", control)) },
        "silentNoop": !equal,
    });
    if !equal { result["ok"] = json!(false); }
}

fn set_frame_limit(
    io: &mut dyn FeatureIo, result: &mut Value, index: usize, app: &str,
    detail: Option<ctl_3d_feature_details_t>, limit: &Value,
) {
    let Some(detail) = detail else {
        fail(result, "frameLimit", "unsupported", "the frame limit is not supported on this device");
        return;
    };
    if !app.is_empty() && detail.PerAppSupport == 0 {
        fail(result, "frameLimit", "unsupported", "frame limit is not exposed as a per-game driver setting");
        return;
    }
    let Some((min, max, step, _default)) = int_range(&detail) else {
        fail(result, "frameLimit", "unsupported", "no capability range reported for the frame limit");
        return;
    };
    let value = clamp_snap(limit.get("value").and_then(Value::as_f64).unwrap_or(min as f64), min, max, step);
    let enabled = limit.get("enabled").and_then(Value::as_bool) == Some(true);
    if let Err(error) = io.write_int(index, FEATURE_FRAME_LIMIT, enabled, value, app) {
        fail(result, "frameLimit", error_code(&error), error.to_string());
        return;
    }
    let equal = io.read_int(index, FEATURE_FRAME_LIMIT, app).is_ok_and(|(read_enabled, read_value)| read_enabled == enabled && read_value == value);
    result["perControl"]["frameLimit"] = json!({
        "ok": equal, "readBackEqual": equal,
        "errorCode": if equal { Value::Null } else { json!("io-failed") },
        "message": if equal { Value::Null } else { json!(format!("read-back did not match requested frame limit {value}")) },
        "silentNoop": !equal,
    });
    if !equal { result["ok"] = json!(false); }
}

fn set_sharpening(
    io: &mut dyn FeatureIo, result: &mut Value, index: usize, app: &str,
    detail: Option<ctl_3d_feature_details_t>, sharpening: &Value,
) {
    let Some(detail) = detail else {
        fail(result, "sharpening", "unsupported", "the driver does not report the 3D sharpening feature");
        return;
    };
    if !app.is_empty() && detail.PerAppSupport == 0 {
        fail(result, "sharpening", "unsupported", "sharpening is not exposed as a per-game driver setting");
        return;
    }
    let Some((min, max, step, _default)) = int_range(&detail) else {
        fail(result, "sharpening", "unsupported", "the driver did not report a sharpening integer range");
        return;
    };
    if detail.ValueType != VALUE_INT32 || min != 0 || max != 100 || step != 1 {
        fail(result, "sharpening", "unsupported", "the driver does not advertise sharpening as an integer 0-100 control");
        return;
    }
    let Some(enabled) = sharpening.get("enabled").and_then(Value::as_bool) else {
        fail(result, "sharpening", "out-of-range", "Sharpening requires an enabled flag and an integer percentage from 0 to 100.");
        return;
    };
    let Some(percentage) = sharpening.get("percentage").and_then(Value::as_u64).filter(|value| *value <= 100) else {
        fail(result, "sharpening", "out-of-range", "Sharpening requires an enabled flag and an integer percentage from 0 to 100.");
        return;
    };
    let value = percentage as i32;
    if let Err(error) = io.write_int(index, FEATURE_SHARPENING_FILTER, enabled, value, app) {
        fail(result, "sharpening", error_code(&error), error.to_string());
        return;
    }
    let equal = io.read_int(index, FEATURE_SHARPENING_FILTER, app).is_ok_and(|(read_enabled, read_value)| read_enabled == enabled && read_value == value);
    result["perControl"]["sharpening"] = json!({
        "ok": equal, "readBackEqual": equal,
        "errorCode": if equal { Value::Null } else { json!("io-failed") },
        "message": if equal { Value::Null } else { json!("read-back did not match the requested sharpening value") },
        "silentNoop": !equal,
    });
    if !equal { result["ok"] = json!(false); }
}

fn read_with(io: &mut dyn FeatureIo, index: usize, exe_path: &str) -> Value {
    let app = basename(exe_path);
    let features = io.features(index).unwrap_or_default();
    let enum_value = |io: &mut dyn FeatureIo, feature_type: i32| -> Option<u32> {
        feature(&features, feature_type).and_then(|detail| {
            if detail.ValueType != VALUE_ENUM { return None; }
            io.read_enum(index, feature_type, &app).ok()
        })
    };
    let int_value = |io: &mut dyn FeatureIo, feature_type: i32| -> Option<(bool, i32)> {
        feature(&features, feature_type).and_then(|_| io.read_int(index, feature_type, &app).ok())
    };
    let frame_gen = enum_value(io, FEATURE_FRAME_GENERATION).and_then(|value| match value {
        0 => Some("app-choice"), 1 => Some("2x"), 2 => Some("3x"), 3 => Some("4x"), _ => None,
    });
    let flip = enum_value(io, FEATURE_GAMING_FLIP_MODES).and_then(|value| match value {
        1 => Some("application-default"), 2 => Some("vsync-off"), 4 => Some("vsync-on"),
        8 => Some("smooth-sync"), 16 => Some("speed-frame"), 32 => Some("smart-vsync"), _ => None,
    });
    let latency = enum_value(io, FEATURE_LOW_LATENCY).and_then(|value| match value {
        0 => Some("off"), 1 => Some("on"), 2 => Some("on-boost"), _ => None,
    });
    let endurance = match feature(&features, FEATURE_ENDURANCE_GAMING) {
        Some(detail) if detail.ValueType == VALUE_ENUM => enum_value(io, FEATURE_ENDURANCE_GAMING).and_then(|value| match value {
            0 => Some("off"), 1 => Some("on"), 2 => Some("auto"), _ => None,
        }),
        Some(_) => int_value(io, FEATURE_ENDURANCE_GAMING).map(|(enabled, _)| if enabled { "on" } else { "off" }),
        None => None,
    };
    let frame_limit = int_value(io, FEATURE_FRAME_LIMIT).map(|(enabled, value)| json!({"enabled": enabled, "value": value}));
    let sharpening = int_value(io, FEATURE_SHARPENING_FILTER).map(|(enabled, percentage)| json!({"enabled": enabled, "percentage": percentage}));
    json!({
        "exePath": exe_path,
        "applicationName": app,
        "graphics": {
            "enduranceGaming": endurance,
            "frameGenOverride": frame_gen,
            "flipMode": flip,
            "lowLatency": latency,
            "frameLimit": frame_limit,
            "sharpening": sharpening,
        }
    })
}

pub fn read(dll_path: &Path, device_id: u64, exe_path: &str) -> Result<Value, String> {
    let (mut igcl, raw_index, _device) = open_for_device(dll_path, device_id)?;
    let result = read_with(&mut igcl, raw_index, exe_path);
    let _ = igcl.close();
    Ok(result)
}

fn apply_with(io: &mut dyn FeatureIo, index: usize, device: &Value, exe_path: &str, settings: &Value, enabled: bool) -> Value {    let app = basename(exe_path);
    if app.is_empty() { return json!({"ok": false, "perControl": {"profileScope": {"ok": false, "errorCode": "invalid-argument", "message": "an executable name is required"}}}); }
    let features = match io.features(index) {
        Ok(features) => features,
        Err(error) => return json!({"ok": false, "perControl": {"profileScope": {"ok": false, "errorCode": error_code(&error), "message": error.to_string()}}}),
    };
    let scope_detail = feature(&features, FEATURE_GLOBAL_OR_PER_APP);
    if scope_detail.is_none_or(|detail| detail.ValueType != VALUE_ENUM) {
        return json!({"ok": false, "perControl": {"profileScope": {"ok": false, "errorCode": "unsupported", "message": "the driver does not expose a per-game global/per-application selector"}}});
    }
    if let Err(error) = io.set_scope(index, enabled, &app) {
        return json!({"ok": false, "perControl": {"profileScope": {"ok": false, "errorCode": error_code(&error), "message": error.to_string()}}});
    }
    let requested_scope = if enabled { 1 } else { 2 };
    let scope_equal = io.read_enum(index, FEATURE_GLOBAL_OR_PER_APP, &app).is_ok_and(|value| value == requested_scope);
    let mut result = json!({
        "ok": scope_equal,
        "perControl": {"profileScope": {
            "ok": scope_equal, "readBackEqual": scope_equal,
            "errorCode": if scope_equal { Value::Null } else { json!("io-failed") },
            "message": if scope_equal { Value::Null } else { json!("scope read-back did not match the requested mode") },
        }},
    });
    if !scope_equal || !enabled { return result; }

    if let Some(value) = settings.get("enduranceGaming").and_then(Value::as_str) {
        let detail = feature(&features, FEATURE_ENDURANCE_GAMING);
        let platform = intel_integrated_or_mobile(device);
        if !platform || detail.is_none_or(|detail| !matches!(detail.ValueType, VALUE_ENUM | VALUE_INT32 | VALUE_UINT32)) {
            fail(&mut result, "enduranceGaming", "unsupported", "Endurance Gaming is only available on supported Intel integrated or mobile graphics.");
        } else if !app.is_empty() && detail.unwrap().PerAppSupport == 0 {
            fail(&mut result, "enduranceGaming", "unsupported", "Endurance Gaming is not exposed as a per-game driver setting.");
        } else if detail.unwrap().ValueType == VALUE_ENUM {
            let requested = match value { "on" => 1, "off" => 0, "auto" => 2, _ => { fail(&mut result, "enduranceGaming", "out-of-range", format!("unknown Endurance Gaming control '{value}'")); return result; } };
            set_enum_control(io, &mut result, index, &app, "enduranceGaming", FEATURE_ENDURANCE_GAMING, detail, requested, true);
        } else {
            // Older integer ABI: enable bit plus the driver's default target FPS.
            let default_fps = int_range(&detail.unwrap()).map(|(_, _, _, default)| default).unwrap_or(60);
            let requested_enabled = value == "on";
            let write = io.write_int(index, FEATURE_ENDURANCE_GAMING, requested_enabled, default_fps, &app);
            let equal = write.is_ok() && io.read_int(index, FEATURE_ENDURANCE_GAMING, &app).is_ok_and(|(read_enabled, _)| read_enabled == requested_enabled);
            result["perControl"]["enduranceGaming"] = json!({
                "ok": equal, "readBackEqual": equal,
                "errorCode": if equal { Value::Null } else { json!("io-failed") },
                "message": if equal { Value::Null } else { json!("read-back did not match the requested Endurance Gaming value") },
            });
            if !equal { result["ok"] = json!(false); }
        }
    }

    if let Some(value) = settings.get("frameGenOverride").and_then(Value::as_str) {
        let requested = match value { "app-choice" => 0, "2x" => 1, "3x" => 2, "4x" => 3, _ => { fail(&mut result, "frameGenOverride", "out-of-range", format!("unknown frameGenOverride value '{value}'")); return result; } };
        set_enum_control(io, &mut result, index, &app, "frameGenOverride", FEATURE_FRAME_GENERATION, feature(&features, FEATURE_FRAME_GENERATION), requested, false);
    }

    if let Some(value) = settings.get("flipMode").and_then(Value::as_str) {
        let requested = match value {
            "application-default" => 1, "vsync-off" => 2, "vsync-on" => 4, "smooth-sync" => 8,
            "speed-frame" => 16, "smart-vsync" => 32,
            _ => { fail(&mut result, "flipMode", "out-of-range", format!("unknown flipMode value '{value}'")); return result; }
        };
        set_enum_control(io, &mut result, index, &app, "flipMode", FEATURE_GAMING_FLIP_MODES, feature(&features, FEATURE_GAMING_FLIP_MODES), requested, true);
    }

    if let Some(value) = settings.get("lowLatency").and_then(Value::as_str) {
        let requested = match value { "off" => 0, "on" => 1, "on-boost" => 2, _ => { fail(&mut result, "lowLatency", "out-of-range", format!("unknown lowLatency value '{value}'")); return result; } };
        set_enum_control(io, &mut result, index, &app, "lowLatency", FEATURE_LOW_LATENCY, feature(&features, FEATURE_LOW_LATENCY), requested, false);
    }

    if let Some(limit) = settings.get("frameLimit").filter(|value| value.is_object()) {
        set_frame_limit(io, &mut result, index, &app, feature(&features, FEATURE_FRAME_LIMIT), limit);
    }

    if let Some(sharpening) = settings.get("sharpening").filter(|value| value.is_object()) {
        set_sharpening(io, &mut result, index, &app, feature(&features, FEATURE_SHARPENING_FILTER), sharpening);
    }

    result
}

pub fn apply(dll_path: &Path, device_id: u64, exe_path: &str, settings: &Value, enabled: bool) -> Result<Value, String> {
    #[cfg(test)]
    if let Some(result) = TEST_APPLY.lock().ok().and_then(|mut queue| queue.pop()) {
        return Ok(result);
    }
    let (mut igcl, raw_index, device) = open_for_device(dll_path, device_id)?;
    let result = apply_with(&mut igcl, raw_index, &device, exe_path, settings, enabled);
    let _ = igcl.close();
    Ok(result)
}

#[cfg(test)]
pub static TEST_APPLY: std::sync::Mutex<Vec<Value>> = std::sync::Mutex::new(Vec::new());

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeIo {
        details: Vec<ctl_3d_feature_details_t>,
        enums: HashMap<(i32, String), u32>,
        ints: HashMap<(i32, String), (bool, i32)>,
        fail_readback: bool,
        fail_scope: bool,
    }
    impl FakeIo {
        fn new() -> Self {
            let mut details = Vec::new();
            for (feature_type, value_type, per_app) in [
                (FEATURE_ENDURANCE_GAMING, VALUE_ENUM, 1),
                (FEATURE_FRAME_LIMIT, VALUE_INT32, 1),
                (FEATURE_SHARPENING_FILTER, VALUE_INT32, 1),
                (FEATURE_GAMING_FLIP_MODES, VALUE_ENUM, 1),
                (FEATURE_GLOBAL_OR_PER_APP, VALUE_ENUM, 1),
                (FEATURE_LOW_LATENCY, VALUE_ENUM, 1),
                (FEATURE_FRAME_GENERATION, VALUE_ENUM, 1),
            ] {
                let mut detail: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
                detail.FeatureType = feature_type; detail.ValueType = value_type; detail.PerAppSupport = per_app;
                if feature_type == FEATURE_FRAME_LIMIT {
                    detail.Value[4..8].copy_from_slice(&30i32.to_le_bytes());
                    detail.Value[8..12].copy_from_slice(&240i32.to_le_bytes());
                    detail.Value[12..16].copy_from_slice(&1i32.to_le_bytes());
                    detail.Value[16..20].copy_from_slice(&60i32.to_le_bytes());
                }
                if feature_type == FEATURE_SHARPENING_FILTER {
                    detail.Value[4..8].copy_from_slice(&0i32.to_le_bytes());
                    detail.Value[8..12].copy_from_slice(&100i32.to_le_bytes());
                    detail.Value[12..16].copy_from_slice(&1i32.to_le_bytes());
                    detail.Value[16..20].copy_from_slice(&50i32.to_le_bytes());
                }
                if matches!(feature_type, FEATURE_ENDURANCE_GAMING | FEATURE_FRAME_GENERATION | FEATURE_GAMING_FLIP_MODES | FEATURE_LOW_LATENCY) {
                    detail.Value[0..8].copy_from_slice(&0x7fu64.to_le_bytes());
                }
                details.push(detail);
            }
            Self { details, enums: HashMap::new(), ints: HashMap::new(), fail_readback: false, fail_scope: false }
        }
    }
    impl FeatureIo for FakeIo {
        fn features(&mut self, _index: usize) -> Result<Vec<ctl_3d_feature_details_t>, IgclError> { Ok(self.details.clone()) }
        fn set_scope(&mut self, _index: usize, enabled: bool, application: &str) -> Result<(), IgclError> {
            let value = if enabled { 1 } else { 2 };
            if self.fail_scope {
                self.enums.insert((FEATURE_GLOBAL_OR_PER_APP, application.to_owned()), if enabled { 2 } else { 1 });
            } else {
                self.enums.insert((FEATURE_GLOBAL_OR_PER_APP, application.to_owned()), value);
            }
            Ok(())
        }
        fn read_enum(&mut self, _index: usize, feature: i32, application: &str) -> Result<u32, IgclError> {
            if feature == FEATURE_GLOBAL_OR_PER_APP { return Ok(*self.enums.get(&(feature, application.to_owned())).unwrap_or(&2)); }
            Ok(*self.enums.get(&(feature, application.to_owned())).unwrap_or(&0))
        }
        fn write_enum(&mut self, _index: usize, feature: i32, value: u32, application: &str) -> Result<(), IgclError> {
            let stored = if self.fail_readback && feature != FEATURE_GLOBAL_OR_PER_APP { value.wrapping_add(1) } else { value };
            self.enums.insert((feature, application.to_owned()), stored); Ok(())
        }
        fn read_int(&mut self, _index: usize, feature: i32, application: &str) -> Result<(bool, i32), IgclError> {
            Ok(*self.ints.get(&(feature, application.to_owned())).unwrap_or(&(false, 0)))
        }
        fn write_int(&mut self, _index: usize, feature: i32, enabled: bool, value: i32, application: &str) -> Result<(), IgclError> {
            let stored = if self.fail_readback { (enabled, value.wrapping_add(1)) } else { (enabled, value) };
            self.ints.insert((feature, application.to_owned()), stored); Ok(())
        }
    }

    #[test]
    fn applies_supported_per_game_controls_and_verifies_each_value() {
        let mut io = FakeIo::new();
        let result = apply_with(&mut io, 0, &json!({"integrated": true, "pciVendorId": "0x00008086"}),
            r"C:\Games\Game.exe",
            &json!({
                "enduranceGaming": "on", "frameGenOverride": "2x", "flipMode": "vsync-on",
                "lowLatency": "on-boost", "frameLimit": {"enabled": true, "value": 120},
                "sharpening": {"enabled": true, "percentage": 75},
            }), true);
        assert_eq!(result["ok"], true, "{result}");
        for control in ["enduranceGaming", "frameGenOverride", "flipMode", "lowLatency", "frameLimit", "sharpening"] {
            assert_eq!(result["perControl"][control]["ok"], true, "{control}: {result}");
        }
        assert_eq!(io.enums[&(FEATURE_FRAME_GENERATION, "Game.exe".into())], 1);
        assert_eq!(io.enums[&(FEATURE_GAMING_FLIP_MODES, "Game.exe".into())], 4);
        assert_eq!(io.enums[&(FEATURE_LOW_LATENCY, "Game.exe".into())], 2);
        assert_eq!(io.ints[&(FEATURE_FRAME_LIMIT, "Game.exe".into())], (true, 120));
        assert_eq!(io.ints[&(FEATURE_SHARPENING_FILTER, "Game.exe".into())], (true, 75));
    }

    #[test]
    fn disable_selects_global_scope_without_writing_controls() {
        let mut io = FakeIo::new();
        let result = apply_with(&mut io, 0, &json!({}), r"C:\Games\Game.exe", &json!({"frameLimit": {"enabled": true, "value": 60}}), false);
        assert_eq!(result["ok"], true);
        assert_eq!(io.enums.len(), 1);
        assert_eq!(io.enums[&(FEATURE_GLOBAL_OR_PER_APP, "Game.exe".into())], 2);
        assert!(io.ints.is_empty());
    }

    #[test]
    fn read_maps_the_supported_feature_values() {
        let mut io = FakeIo::new();
        io.enums.insert((FEATURE_FRAME_GENERATION, "Game.exe".into()), 2);
        io.enums.insert((FEATURE_GAMING_FLIP_MODES, "Game.exe".into()), 4);
        io.enums.insert((FEATURE_LOW_LATENCY, "Game.exe".into()), 2);
        io.enums.insert((FEATURE_ENDURANCE_GAMING, "Game.exe".into()), 1);
        io.ints.insert((FEATURE_FRAME_LIMIT, "Game.exe".into()), (true, 120));
        io.ints.insert((FEATURE_SHARPENING_FILTER, "Game.exe".into()), (true, 75));
        let state = read_with(&mut io, 0, r"C:\Games\Game.exe");
        assert_eq!(state["graphics"]["frameGenOverride"], "3x");
        assert_eq!(state["graphics"]["flipMode"], "vsync-on");
        assert_eq!(state["graphics"]["lowLatency"], "on-boost");
        assert_eq!(state["graphics"]["enduranceGaming"], "on");
        assert_eq!(state["graphics"]["frameLimit"], json!({"enabled": true, "value": 120}));
        assert_eq!(state["graphics"]["sharpening"], json!({"enabled": true, "percentage": 75}));
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "read-only live per-app feature read; set ARC_POWER_TEST_GAME_EXE to a game executable"]
    fn live_read_of_one_game_is_bounded() {
        let exe = std::env::var("ARC_POWER_TEST_GAME_EXE").expect("ARC_POWER_TEST_GAME_EXE");
        let dll = crate::backend::gpu_devices::locate_dll().expect("IntelControlLib.dll");
        let state = read(&dll, 0, &exe).expect("per-app read");
        assert!(state["graphics"].is_object());
        eprintln!("live per-app baseline: {state}");
    }

    #[test]
    fn readback_mismatch_fails_closed() {
        let mut io = FakeIo::new();
        io.fail_readback = true;
        let result = apply_with(&mut io, 0, &json!({}), r"C:\Games\Game.exe", &json!({"frameLimit": {"enabled": true, "value": 60}}), true);
        assert_eq!(result["ok"], false);
        assert_eq!(result["perControl"]["frameLimit"]["errorCode"], "io-failed");
    }

    #[test]
    fn missing_feature_is_reported_without_a_write() {
        let mut io = FakeIo::new();
        io.details.retain(|detail| detail.FeatureType != FEATURE_FRAME_GENERATION);
        let result = apply_with(&mut io, 0, &json!({}), r"C:\Games\Game.exe", &json!({"frameGenOverride": "2x"}), true);
        assert_eq!(result["ok"], false);
        assert_eq!(result["perControl"]["frameGenOverride"]["errorCode"], "unsupported");
        assert!(!io.enums.contains_key(&(FEATURE_FRAME_GENERATION, "Game.exe".into())));
    }
}
