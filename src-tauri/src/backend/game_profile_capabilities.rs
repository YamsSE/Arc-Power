//! Read-only IGCL per-application 3D feature capabilities. Only the feature
//! detail surface is queried; no driver value is written here.
use super::gpu_capabilities::open_for_device;
use super::igcl_raw::ctl_3d_feature_details_t;
use serde_json::{json, Value};
use std::path::Path;

const FEATURE_ENDURANCE_GAMING: i32 = 1;
const FEATURE_SHARPENING_FILTER: i32 = 7;
const FEATURE_FRAME_GENERATION: i32 = 17;
const VALUE_INT32: i32 = 2;
const VALUE_UINT32: i32 = 3;
const VALUE_ENUM: i32 = 4;
const MISC_FLAG_LIVE_CHANGE: i16 = 0x10;
const FRAME_GEN_OPTIONS: &[&str] = &["app-choice", "2x", "3x", "4x"];

const XESS_FG_ALLOWLIST: &[&str] = &[
    "acblackflag.exe", "acshadows.exe", "cyberpunk2077.exe", "f1_24.exe", "f1_24_dx12.exe",
    "f1_25.exe", "hogwartslegacy.exe", "outlaws.exe", "robocoproguecity-win64-shipping.exe",
];
const XESS_FG_RUNTIME: &str = "libxess_fg.dll";
const UNKNOWN_REASON: &str = "XeFG is available only for known XeFG games or executables that ship the XeFG runtime.";
const INELIGIBLE_REASON: &str = "XeFG is not applicable to benchmark or software executables.";
const INVALID_REASON: &str = "XeFG requires a valid executable path.";

fn basename(path: &str) -> String {
    path.rsplit(['\\', '/']).next().unwrap_or(path).trim().to_owned()
}

fn explicitly_ineligible(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    const TERMS: &[&str] = &[
        "3dmark", "benchmark", "benchmate", "furmark", "unigine", "superposition", "heaven",
        "valley", "occt", "cinebench", "aida64", "gpu-z", "gpu_z", "gpu z", "hwinfo",
        "afterburner", "presentmon", "blender", "stress",
    ];
    if TERMS.iter().any(|term| lower.contains(term)) { return true; }
    const SOFTWARE: &[&str] = &[
        "steam", "discord", "chrome", "firefox", "edge", "explorer", "launcher", "setup",
        "install", "update", "uninstall", "crash", "overlay", "service",
    ];
    SOFTWARE.iter().any(|term| {
        lower == *term
            || lower.starts_with(&format!("{term}."))
            || lower.starts_with(&format!("{term}_"))
            || lower.starts_with(&format!("{term}-"))
            || lower.starts_with(&format!("{term} "))
            || lower.ends_with(&format!("{term}.exe"))
            || lower.contains(&format!("-{term}.exe"))
            || lower.contains(&format!("_{term}.exe"))
            || lower.contains(&format!(".{term}.exe"))
            || lower.contains(&format!(" {term}.exe"))
    })
}

pub fn classify_xe_fg_executable(exe_path: Option<&str>) -> (bool, Option<&'static str>) {
    let Some(exe_path) = exe_path.map(str::trim).filter(|value| !value.is_empty() && value.to_ascii_lowercase().ends_with(".exe")) else {
        return (false, Some(INVALID_REASON));
    };
    let name = basename(exe_path).to_ascii_lowercase();
    if name.is_empty() || explicitly_ineligible(&name) { return (false, Some(INELIGIBLE_REASON)); }
    if XESS_FG_ALLOWLIST.contains(&name.as_str()) { return (true, None); }
    let runtime = Path::new(exe_path).parent().map(|directory| directory.join(XESS_FG_RUNTIME));
    if runtime.is_some_and(|path| path.is_file()) { return (true, None); }
    (false, Some(UNKNOWN_REASON))
}

fn feature(features: &[ctl_3d_feature_details_t], feature_type: i32) -> Option<ctl_3d_feature_details_t> {
    features.iter().copied().find(|detail| detail.FeatureType == feature_type)
}

fn value_i32(detail: &ctl_3d_feature_details_t, offset: usize) -> Option<i32> {
    if offset + 4 > detail.Value.len() { return None; }
    Some(i32::from_le_bytes(detail.Value[offset..offset + 4].try_into().ok()?))
}

fn per_app(detail: &ctl_3d_feature_details_t) -> bool { detail.PerAppSupport != 0 }
fn live_change(detail: &ctl_3d_feature_details_t) -> bool { detail.FeatureMiscSupport & MISC_FLAG_LIVE_CHANGE != 0 }

pub(crate) fn intel_integrated_or_mobile(device: &Value) -> bool {    let vendor = device["pciVendorId"].as_str().unwrap_or("").trim().to_ascii_lowercase()
        .trim_start_matches("0x").to_owned();
    if !vendor.is_empty() && !vendor.ends_with("8086") { return false; }
    device["integrated"].as_bool() == Some(true) || device["mobile"].as_bool() == Some(true)
}

fn sharpening_capability(detail: Option<ctl_3d_feature_details_t>) -> (bool, Value, bool, String) {
    let Some(detail) = detail else {
        return (false, Value::Null, false, "the driver did not report the 3D sharpening feature".into());
    };
    let range = if detail.ValueType == VALUE_INT32 {
        Some((value_i32(&detail, 4), value_i32(&detail, 8), value_i32(&detail, 12), value_i32(&detail, 16)))
    } else { None };
    let valid = range.is_some_and(|(min, max, step, default)| {
        matches!((min, max, step, default), (Some(0), Some(100), Some(1), Some(default)) if (0..=100).contains(&default))
    }) && per_app(&detail);
    let range_json = match range {
        Some((Some(min), Some(max), Some(step), Some(default))) => json!({"min":min,"max":max,"step":step,"default":default}),
        _ => Value::Null,
    };
    let reason = if valid {
        String::new()
    } else {
        format!("The driver does not advertise per-game sharpening as an integer 0-100 control (valueType={}; perApp={}).",
            detail.ValueType, per_app(&detail))
    };
    (valid, range_json, live_change(&detail), reason)
}

pub fn capabilities(dll_path: &Path, device_id: u64, exe_path: Option<&str>) -> Result<Value, String> {
    let (mut igcl, raw_index, device) = open_for_device(dll_path, device_id)?;
    let features = igcl.supported_3d_features(raw_index).map_err(|error| error.to_string());
    let _ = igcl.close();
    let features = features?;

    let endurance_detail = feature(&features, FEATURE_ENDURANCE_GAMING);
    let platform = intel_integrated_or_mobile(&device);
    let endurance = platform && endurance_detail.is_some_and(|detail| {
        matches!(detail.ValueType, VALUE_ENUM | VALUE_INT32 | VALUE_UINT32) && per_app(&detail)
    });
    let endurance_reason = if endurance {
        Value::Null
    } else if !platform {
        json!("Endurance Gaming is available only on integrated Intel graphics.")
    } else if endurance_detail.is_none() {
        json!("The driver does not expose Endurance Gaming for this adapter.")
    } else if !per_app(&endurance_detail.unwrap()) {
        json!("The driver does not expose Endurance Gaming as a per-game control.")
    } else {
        json!("Endurance Gaming is not available on this driver surface.")
    };

    let frame_gen_detail = feature(&features, FEATURE_FRAME_GENERATION);
    let driver_xe_fg = frame_gen_detail.is_some_and(|detail| detail.ValueType == VALUE_ENUM && per_app(&detail));
    let (executable_supported, executable_reason) = classify_xe_fg_executable(exe_path);
    let xe_fg = driver_xe_fg && executable_supported;
    let xe_fg_reason = if xe_fg {
        Value::Null
    } else if !executable_supported {
        json!(executable_reason.unwrap_or(UNKNOWN_REASON))
    } else if frame_gen_detail.is_none() {
        json!("The driver does not expose XeFG for this adapter.")
    } else if !per_app(&frame_gen_detail.unwrap()) {
        json!("The driver does not expose XeFG as a per-game control.")
    } else {
        json!("XeFG is not available on this driver surface.")
    };

    let (sharpening, sharpening_range, sharpening_live, sharpening_reason) =
        sharpening_capability(feature(&features, FEATURE_SHARPENING_FILTER));

    Ok(json!({
        "enduranceGaming": endurance,
        "xeFg": xe_fg,
        "xeFgOptions": if xe_fg { json!(FRAME_GEN_OPTIONS) } else { json!([]) },
        "sharpening": sharpening,
        "sharpeningRange": sharpening_range,
        "sharpeningLiveChange": sharpening && sharpening_live,
        "sharpeningReason": if sharpening { Value::Null } else { json!(sharpening_reason) },
        "reason": endurance_reason,
        "xeFgReason": xe_fg_reason,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xe_fg_classifier_matches_known_runtime_and_deny_rules() {
        assert_eq!(classify_xe_fg_executable(Some(r"C:\Games\Cyberpunk2077.exe")), (true, None));
        assert_eq!(classify_xe_fg_executable(Some(r"C:\Games\3DMark.exe")).0, false);
        assert_eq!(classify_xe_fg_executable(Some(r"C:\Games\unknown.exe")).0, false);
        assert_eq!(classify_xe_fg_executable(None), (false, Some(INVALID_REASON)));
        assert_eq!(classify_xe_fg_executable(Some(r"C:\Games\notes.txt")), (false, Some(INVALID_REASON)));
        assert_eq!(classify_xe_fg_executable(Some(r"C:\Games\steam.exe")), (false, Some(INELIGIBLE_REASON)));
    }

    #[test]
    fn sharpening_range_requires_the_exact_integer_contract() {
        let mut detail: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
        detail.FeatureType = FEATURE_SHARPENING_FILTER;
        detail.ValueType = VALUE_INT32;
        detail.PerAppSupport = 1;
        detail.Value[4..8].copy_from_slice(&0i32.to_le_bytes());
        detail.Value[8..12].copy_from_slice(&100i32.to_le_bytes());
        detail.Value[12..16].copy_from_slice(&1i32.to_le_bytes());
        detail.Value[16..20].copy_from_slice(&50i32.to_le_bytes());
        let (supported, range, live, reason) = sharpening_capability(Some(detail));
        assert!(supported);
        assert_eq!(range, json!({"min":0,"max":100,"step":1,"default":50}));
        assert!(!live);
        assert!(reason.is_empty());
        detail.PerAppSupport = 0;
        assert!(!sharpening_capability(Some(detail)).0);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "read-only live IGCL capability probe; run explicitly on Intel hardware"]
    fn live_capability_read_is_bounded_and_shape_stable() {
        let dll = crate::backend::gpu_devices::locate_dll().expect("IntelControlLib.dll");
        let caps = capabilities(&dll, 0, Some(r"C:\Games\Cyberpunk2077.exe")).expect("capabilities");
        assert!(caps["enduranceGaming"].is_boolean());
        assert!(caps["xeFg"].is_boolean());
        assert!(caps["sharpening"].is_boolean());
        assert!(caps["xeFgOptions"].is_array());
        eprintln!("live game-profile capabilities: {caps}");
    }

    #[test]
    fn integrated_identity_rejects_known_non_intel_and_accepts_mobile_arc() {
        assert!(intel_integrated_or_mobile(&json!({"pciVendorId":"0x00008086","integrated":true})));
        assert!(intel_integrated_or_mobile(&json!({"pciVendorId":"0x00008086","mobile":true})));
        assert!(!intel_integrated_or_mobile(&json!({"pciVendorId":"0x00001002","integrated":true})));
        assert!(!intel_integrated_or_mobile(&json!({"pciVendorId":"0x00008086","integrated":false,"mobile":false})));
    }
}
