//! Native replacement for the Electron Graphics-tab IPC surface.
//!
//! Ports `graphics:get` / `graphics:apply` from `src/main/ipc-core.js` (the
//! `graphicsExpectedDeviceKey` / `resolveSelectedGraphicsDevice` /
//! `readGraphicsState` / `graphics:apply` handlers) and the IGCL 3D-feature
//! surface from `src/main/backend/igcl-backend.js`
//! (`getGraphicsSettings` / `setGraphicsSettings`), with three deliberate
//! differences documented at their call sites:
//!
//! 1. Arc Sleep: the native host owns the Arc Sleep controller in the same
//!    elevated, non-mock runs, so the narrowed gate delegates to the
//!    compatibility broker only for a journal record this build cannot parse
//!    (a foreign owner). The controller is the only writer of the Base Cap and
//!    journal; a Graphics apply routes the frame limit through its transaction
//!    (`FrameLimitOwner`).
//! 2. Sharpening is read/written directly through 3D feature 7 instead of the
//!    Electron isolated child helper.
//! 3. There is no elevated worker branch - the native path only runs when the
//!    host is already elevated; otherwise the channel delegates.
//!
//! Crash isolation: the Electron sharpening helper exists because IGCL's 3D
//! surface can fault inside the driver. Reading/writing feature 7 in-process
//! (the `game_profile_apply` precedent) removes that isolation, so an IGCL
//! access violation on the sharpening control now takes down the native host
//! instead of a disposable helper. The calls are one feature read/write per
//! request and every other feature was already in-process; the remaining
//! exposure is documented rather than mitigated.
use super::arc_sleep_limiter::{parse_journal, parse_raw_state, RawState};
use super::game_profile_apply::{enum_supported, error_code, feature, int_range};
use super::game_profile_capabilities::intel_integrated_or_mobile;
use super::gpu_capabilities::open_for_device;
use super::igcl_raw::ctl_3d_feature_details_t;
use super::igcl_read_only::{IgclError, ReadOnlyIgcl};
use super::native_store::NativeStore;
use super::shared_memory_override::{self, RegistryAccess};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex, OnceLock};

pub const STATE_UPDATED_CHANNEL: &str = "graphics:state-updated";

const FEATURE_ENDURANCE_GAMING: i32 = 1;
const FEATURE_FRAME_LIMIT: i32 = 2;
const FEATURE_SHARPENING_FILTER: i32 = 7;
const FEATURE_GAMING_FLIP_MODES: i32 = 9;
const FEATURE_LOW_LATENCY: i32 = 16;
const FEATURE_FRAME_GENERATION: i32 = 17;
const FEATURE_PREBUILT_SHADER_DOWNLOAD: i32 = 18;

const VALUE_BOOL: i32 = 0;
const VALUE_INT32: i32 = 2;
const VALUE_UINT32: i32 = 3;
const VALUE_ENUM: i32 = 4;
const MISC_FLAG_LIVE_CHANGE: i16 = 0x10;

const GRAPHICS_FRAME_GEN_OPTIONS: &[&str] = &["app-choice", "2x", "3x", "4x"];
/// Order matters: the sanitizer's error message joins this list verbatim.
const GRAPHICS_FLIP_MODE_OPTIONS: &[&str] = &[
    "application-default",
    "vsync-on",
    "vsync-off",
    "smooth-sync",
    "speed-frame",
    "smart-vsync",
];
const GRAPHICS_LOW_LATENCY_OPTIONS: &[&str] = &["off", "on", "on-boost"];
const ENDURANCE_CONTROL_OPTIONS: &[&str] = &["off", "on", "auto"];
const ENDURANCE_MODE_OPTIONS: &[&str] = &["performance", "balanced", "battery"];

/// The frame-limit clamp fallback. The driver range wins when it is reported;
/// otherwise the probe-recorded 30-300-1-60 surface is used.
const FRAME_LIMIT_FALLBACK: Range = Range { min: 30, max: 300, step: 1, default: 60 };
/// RTSS exposes a wider global range than the Intel driver.
const RTSS_FRAME_LIMIT_RANGE: Range = Range { min: 1, max: 1000, step: 1, default: 60 };

const SHARPENING_UNAVAILABLE: &str = "The sharpening control is unavailable for this adapter.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Range {
    min: i64,
    max: i64,
    step: i64,
    default: i64,
}
impl Range {
    fn from_detail(detail: &ctl_3d_feature_details_t) -> Option<Self> {
        if !matches!(detail.ValueType, VALUE_INT32 | VALUE_UINT32) { return None; }
        let (min, max, step, default) = int_range(detail)?;
        Some(Range {
            min: min as i64,
            max: max as i64,
            step: step as i64,
            default: default as i64,
        })
    }

    fn from_json(value: &Value) -> Option<Self> {
        let min = value.get("min").and_then(Value::as_f64)?;
        let max = value.get("max").and_then(Value::as_f64)?;
        let step = value.get("step").and_then(Value::as_f64)?;
        let default = value.get("default").and_then(Value::as_f64)?;
        if !(min.is_finite() && max.is_finite() && step.is_finite() && default.is_finite()) {
            return None;
        }
        (max > min).then(|| Range {
            min: min as i64,
            max: max as i64,
            step: step as i64,
            default: default as i64,
        })
    }

    fn json(self) -> Value {
        json!({"min": self.min, "max": self.max, "step": self.step, "default": self.default})
    }

    /// `units.js clampAndSnap`: snap to the step grid from `min`, then clamp.
    fn clamp_snap(self, value: f64) -> i64 {
        if !value.is_finite() { return self.min; }
        let step = self.step.max(1) as f64;
        let snapped = if self.step > 0 {
            self.min as f64 + ((value - self.min as f64) / step).round() * step
        } else {
            value
        };
        (snapped.round() as i64).clamp(self.min, self.max)
    }

    /// `ipc-core.js sanitizeGraphicsSettings`: the frame-limit clamp snaps on a
    /// grid anchored at zero (not at `min`), then clamps into the range.
    fn snap_from_zero(self, value: f64) -> i64 {
        if !value.is_finite() { return self.min; }
        let snapped = if self.step > 0 {
            (value / self.step as f64).round() * self.step as f64
        } else {
            value
        };
        (snapped.round() as i64).clamp(self.min, self.max)
    }
}

// ---------------------------------------------------------------------------
// Driver seams
// ---------------------------------------------------------------------------

/// The 3D-feature calls the Graphics surface needs. Implemented by
/// `ReadOnlyIgcl` in production and by a fake in tests so no test can reach a
/// live driver.
pub(crate) trait GraphicsFeatureIo {
    fn rebar_enabled(&self, index: usize) -> Option<bool>;
    fn features(&mut self, index: usize) -> Result<Vec<ctl_3d_feature_details_t>, IgclError>;
    fn read_enum(&mut self, index: usize, feature: i32, app: &str) -> Result<u32, IgclError>;
    fn write_enum(&mut self, index: usize, feature: i32, value: u32, app: &str) -> Result<(), IgclError>;
    fn read_int(&mut self, index: usize, feature: i32, app: &str) -> Result<(bool, i32), IgclError>;
    fn write_int(&mut self, index: usize, feature: i32, enabled: bool, value: i32, app: &str) -> Result<(), IgclError>;
    fn read_bool(&mut self, index: usize, feature: i32, app: &str) -> Result<bool, IgclError>;
    fn write_bool(&mut self, index: usize, feature: i32, enabled: bool, app: &str) -> Result<(), IgclError>;
}

impl GraphicsFeatureIo for ReadOnlyIgcl {
    fn rebar_enabled(&self, index: usize) -> Option<bool> { self.rebar_enabled(index) }
    fn features(&mut self, index: usize) -> Result<Vec<ctl_3d_feature_details_t>, IgclError> {
        self.supported_3d_features(index)
    }
    fn read_enum(&mut self, index: usize, feature: i32, app: &str) -> Result<u32, IgclError> {
        self.read_3d_enum(index, feature, app)
    }
    fn write_enum(&mut self, index: usize, feature: i32, value: u32, app: &str) -> Result<(), IgclError> {
        self.write_3d_enum(index, feature, value, app)
    }
    fn read_int(&mut self, index: usize, feature: i32, app: &str) -> Result<(bool, i32), IgclError> {
        self.read_3d_int(index, feature, app)
    }
    fn write_int(&mut self, index: usize, feature: i32, enabled: bool, value: i32, app: &str) -> Result<(), IgclError> {
        self.write_3d_int(index, feature, enabled, value, app)
    }
    fn read_bool(&mut self, index: usize, feature: i32, app: &str) -> Result<bool, IgclError> {
        self.read_3d_bool(index, feature, app)
    }
    fn write_bool(&mut self, index: usize, feature: i32, enabled: bool, app: &str) -> Result<(), IgclError> {
        self.write_3d_bool(index, feature, enabled, app)
    }
}

/// One opened adapter: the IGCL session plus the mapped device row the reads
/// need for their platform gates.
pub(crate) struct DriverSession {
    pub io: Box<dyn GraphicsFeatureIo>,
    pub index: usize,
    pub device: Value,
}

/// RTSS global frame-limit seam. Production delegates to the existing
/// `NativeStore` RTSS profile controller.
pub(crate) trait FrameLimitIo {
    fn read(&self) -> Value;
    fn apply(&self, options: &Value) -> Value;
    fn restore(&self, token: &Value) -> Value;
}

pub(crate) struct StoreFrameLimit<'a>(pub &'a NativeStore);

impl FrameLimitIo for StoreFrameLimit<'_> {
    fn read(&self) -> Value {
        super::services::native_json(self.0, "rtss-frame-limit-get", json!([{}]))
            .unwrap_or_else(|error| json!({"ok": false, "error": error}))
    }
    fn apply(&self, options: &Value) -> Value {
        super::services::native_json(self.0, "rtss-frame-limit-apply", json!([options]))
            .unwrap_or_else(|error| json!({"ok": false, "used": false, "error": error}))
    }
    fn restore(&self, token: &Value) -> Value {
        super::services::native_json(self.0, "rtss-frame-limit-restore", json!([token]))
            .unwrap_or_else(|error| json!({"ok": false, "error": error}))
    }
}

// ---------------------------------------------------------------------------
// Arc Sleep gate
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SleepGate {
    /// `arcSleepFrameLimitBase` is materialized (even when disabled).
    pub base_present: bool,
    pub base_enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum GateDecision {
    Delegate,
    Proceed(SleepGate),
}

/// The narrowed Arc Sleep gate. Arc Sleep is native in this host, so its own
/// journal, pending Base Cap change and enabled Base Cap are handled here
/// instead of being delegated. A journal this build cannot parse belongs to a
/// foreign owner and still delegates untouched. Mock runs, unelevated hosts and
/// settings-read failures are rejected before the gate is consulted.
pub(crate) fn gate(settings: &Value) -> GateDecision {
    if let Some(journal) = settings.get("arcSleepJournal").filter(|value| !value.is_null()) {
        if parse_journal(journal).is_none() { return GateDecision::Delegate; }
    }
    match settings.get("arcSleepFrameLimitBase") {
        Some(Value::Object(base)) => {
            let enabled = base.get("enabled") == Some(&Value::Bool(true));
            GateDecision::Proceed(SleepGate { base_present: true, base_enabled: enabled })
        }
        _ => GateDecision::Proceed(SleepGate { base_present: false, base_enabled: false }),
    }
}

fn base_value(settings: &Value) -> Option<u64> {
    settings
        .get("arcSleepFrameLimitBase")
        .and_then(|base| base.get("value"))
        .and_then(Value::as_u64)
}

/// The Base Cap owner a Graphics apply must use. The Arc Sleep controller
/// transaction implements this so the global limiter and its journal have one
/// writer only.
pub(crate) trait FrameLimitOwner {
    fn set_base_frame_limit(&mut self, limit: &Value, device_key: Option<&str>) -> Value;
    fn rollback(&mut self) -> Value;
}

impl FrameLimitOwner for super::arc_sleep_controller::Transaction<'_> {
    fn set_base_frame_limit(&mut self, limit: &Value, device_key: Option<&str>) -> Value {
        super::arc_sleep_controller::Transaction::set_base_frame_limit(self, limit, device_key)
    }
    fn rollback(&mut self) -> Value { super::arc_sleep_controller::Transaction::rollback(self) }
}

// ---------------------------------------------------------------------------
// Validation (ipc-core.js sanitizeGraphicsSettings)
// ---------------------------------------------------------------------------

fn js_number_key(value: &Value) -> bool {
    value.as_f64().is_some_and(f64::is_finite)
}

/// Validate a graphics-settings payload and return a clean copy. The
/// frame-limit value is clamped to the supplied range (30-300-1-60 fallback).
pub(crate) fn sanitize_graphics_settings(payload: &Value, range: Option<Range>) -> Result<Value, String> {
    let Some(payload) = payload.as_object() else {
        return Err("graphics-settings payload must be a plain object".into());
    };
    let mut out = Map::new();
    for (key, value) in payload {
        match key.as_str() {
            "enduranceGaming" => {
                let Some(value) = value.as_str().filter(|v| ENDURANCE_CONTROL_OPTIONS.contains(v)) else {
                    return Err("enduranceGaming must be one of: off, on, auto".into());
                };
                out.insert(key.clone(), json!(value));
            }
            "enduranceGamingMode" => {
                let Some(value) = value.as_str().filter(|v| ENDURANCE_MODE_OPTIONS.contains(v)) else {
                    return Err("enduranceGamingMode must be one of: performance, balanced, battery".into());
                };
                out.insert(key.clone(), json!(value));
            }
            "sharedMemoryOverride" => {
                let enabled = value.get("enabled").and_then(Value::as_bool);
                let percentage = value.get("percentage").and_then(Value::as_i64);
                let valid = enabled.is_some()
                    && percentage.is_some_and(|percentage| {
                        (shared_memory_override::SHARED_MEMORY_OVERRIDE_MIN as i64
                            ..=100).contains(&percentage)
                    });
                if !valid {
                    return Err(format!(
                        "sharedMemoryOverride must be {{ enabled: boolean, percentage: integer {}-100 }}",
                        shared_memory_override::SHARED_MEMORY_OVERRIDE_MIN
                    ));
                }
                out.insert(key.clone(), json!({"enabled": enabled.unwrap(), "percentage": percentage.unwrap()}));
            }
            "frameGenOverride" => {
                let Some(value) = value.as_str().filter(|v| GRAPHICS_FRAME_GEN_OPTIONS.contains(v)) else {
                    return Err(format!(
                        "frameGenOverride must be one of: {}",
                        GRAPHICS_FRAME_GEN_OPTIONS.join(", ")
                    ));
                };
                out.insert(key.clone(), json!(value));
            }
            "flipMode" => {
                let Some(value) = value.as_str().filter(|v| GRAPHICS_FLIP_MODE_OPTIONS.contains(v)) else {
                    return Err(format!(
                        "flipMode must be one of: {}",
                        GRAPHICS_FLIP_MODE_OPTIONS.join(", ")
                    ));
                };
                out.insert(key.clone(), json!(value));
            }
            "lowLatency" => {
                let Some(value) = value.as_str().filter(|v| GRAPHICS_LOW_LATENCY_OPTIONS.contains(v)) else {
                    return Err(format!(
                        "lowLatency must be one of: {}",
                        GRAPHICS_LOW_LATENCY_OPTIONS.join(", ")
                    ));
                };
                out.insert(key.clone(), json!(value));
            }
            "prebuiltShaderDownload" => {
                let Some(value) = value.as_bool() else {
                    return Err("prebuiltShaderDownload must be enabled or disabled".into());
                };
                out.insert(key.clone(), json!(value));
            }
            "sharpening" => {
                let nested_valid = value.as_object().is_some_and(|value| {
                    value.keys().all(|nested| nested == "enabled" || nested == "percentage")
                });
                let enabled = value.get("enabled").and_then(Value::as_bool);
                let percentage = value.get("percentage").and_then(Value::as_i64);
                if !nested_valid
                    || enabled.is_none()
                    || !percentage.is_some_and(|percentage| (0..=100).contains(&percentage))
                {
                    return Err("sharpening must be { enabled: boolean, percentage: integer 0-100 }".into());
                }
                out.insert(key.clone(), json!({"enabled": enabled.unwrap(), "percentage": percentage.unwrap()}));
            }
            "frameLimit" => {
                let enabled = value.get("enabled").and_then(Value::as_bool);
                let number = value.get("value").filter(|value| js_number_key(value)).and_then(Value::as_f64);
                let (Some(enabled), Some(number)) = (enabled, number) else {
                    return Err("frameLimit must be { enabled: boolean, value: number }".into());
                };
                let range = range.unwrap_or(FRAME_LIMIT_FALLBACK);
                out.insert(
                    key.clone(),
                    json!({"enabled": enabled, "value": range.snap_from_zero(number)}),
                );
            }
            other => return Err(format!("unknown graphics setting: {other}")),
        }
    }
    Ok(Value::Object(out))
}

// ---------------------------------------------------------------------------
// Target resolution (ipc-core.js graphicsExpectedDeviceKey / resolveSelectedGraphicsDevice)
// ---------------------------------------------------------------------------

fn row_key(row: &Value) -> Option<&str> {
    row.get("deviceKey").and_then(Value::as_str).filter(|key| !key.is_empty())
}

fn row_has_key(row: &Value, expected: &str) -> bool {
    row_key(row) == Some(expected)
        || row
            .get("deviceKeys")
            .and_then(Value::as_array)
            .is_some_and(|keys| keys.iter().any(|key| key.as_str() == Some(expected)))
}

fn row_ambiguous(row: &Value) -> bool {
    row.get("identityAmbiguous") == Some(&Value::Bool(true))
}

pub(crate) fn expected_device_key(
    settings: &Value,
    device_id: u64,
    supplied: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(supplied) = supplied {
        if supplied.trim().is_empty() {
            return Err("invalid GPU target: expected device key must be a nonempty string".into());
        }
        return Ok(Some(supplied.to_owned()));
    }
    if let Some(key) = settings.get("deviceKey").and_then(Value::as_str).filter(|key| !key.is_empty()) {
        match settings.get("deviceId") {
            Some(Value::Number(number)) if number.as_u64().is_some() => {
                if number.as_u64() != Some(device_id) {
                    return Err(format!(
                        "stale GPU target: selected device identity {key} does not match requested device id {device_id}"
                    ));
                }
            }
            Some(_) => {
                return Err("stale GPU target: the saved device identity has no associated device id".into())
            }
            None => {
                return Err("stale GPU target: the saved device identity has no associated device id".into())
            }
        }
        return Ok(Some(key.to_owned()));
    }
    // Electron consults `backend.resolvePhysicalTarget`; the native inventory
    // always carries physical proof, so a saved identity is mandatory here.
    Err("stale GPU target: a stable selected device identity is required".into())
}

#[derive(Clone, Debug)]
pub(crate) struct Resolved {
    pub id: u64,
    pub target: Value,
}

pub(crate) fn resolve_selected(
    rows: &[Value],
    requested: u64,
    expected: Option<&str>,
) -> Result<Resolved, String> {
    let Some(expected) = expected else {
        return Ok(Resolved {
            id: requested,
            target: rows.get(requested as usize).cloned().unwrap_or(Value::Null),
        });
    };
    let matches: Vec<&Value> = rows
        .iter()
        .filter(|row| !row_ambiguous(row) && row_has_key(row, expected) && row.get("id").and_then(Value::as_u64).is_some())
        .collect();
    if matches.len() != 1 {
        return Err(format!(
            "stale GPU target: selected device identity {expected} is {}",
            if matches.is_empty() { "missing" } else { "ambiguous" }
        ));
    }
    let id = matches[0]["id"].as_u64().expect("filtered on an integer id");
    let target = rows.get(id as usize).cloned().unwrap_or(Value::Null);
    if target.is_null() || row_ambiguous(&target) || !row_has_key(&target, expected) {
        return Err(format!(
            "stale GPU target: device id {id} could not verify {expected}"
        ));
    }
    Ok(Resolved { id, target })
}

fn target_is_synthetic(target: &Value) -> bool {
    target.get("synthetic").and_then(Value::as_bool) == Some(true)
        || target.get("backendKind").and_then(Value::as_str) == Some("os")
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

pub(crate) struct Runtime<'a> {
    pub devices: Vec<Value>,
    pub settings: Value,
    pub open: &'a dyn Fn(u64) -> Result<DriverSession, String>,
    pub frame_limit: &'a dyn FrameLimitIo,
    pub shared_memory: &'a dyn RegistryAccess,
}

fn degraded_state() -> Value {
    json!({
        "supported": {"frameGen": false, "flipModes": false, "frameLimit": false, "lowLatency": false, "sharpening": false},
        "supportedOptions": {"frameGen": [], "flipModes": [], "lowLatency": []},
        "frameLimitRange": Value::Null,
        "frameLimitLiveChange": false,
        "values": {"frameGenOverride": Value::Null, "flipMode": Value::Null, "frameLimit": Value::Null,
            "lowLatency": Value::Null, "sharpening": Value::Null},
        "sharpeningRange": Value::Null,
        "sharpeningReason": SHARPENING_UNAVAILABLE,
        "sharpeningPerAppSupport": false,
        "sharpeningLiveChange": false,
    })
}

fn read_enum_value(io: &mut dyn GraphicsFeatureIo, index: usize, feature_type: i32) -> Option<u32> {
    io.read_enum(index, feature_type, "").ok()
}

fn read_int_value(io: &mut dyn GraphicsFeatureIo, index: usize, feature_type: i32) -> Option<(bool, i32)> {
    io.read_int(index, feature_type, "").ok()
}

fn read_bool_value(io: &mut dyn GraphicsFeatureIo, index: usize, feature_type: i32) -> Option<bool> {
    io.read_bool(index, feature_type, "").ok()
}

fn enum_options(detail: &ctl_3d_feature_details_t, table: &[(&str, u32)]) -> Vec<String> {
    if detail.ValueType != VALUE_ENUM { return Vec::new(); }
    let Some(supported) = enum_supported(detail) else { return Vec::new() };
    table
        .iter()
        .filter(|(_, bit)| supported & u64::from(*bit) != 0)
        .map(|(name, _)| (*name).to_owned())
        .collect()
}

/// Low latency is a plain enum, not a flag: the capability mask is
/// `1 << value` (`(1n << BigInt(GRAPHICS_LL_TO_IGCL[m]))` in Electron).
fn low_latency_options(detail: &ctl_3d_feature_details_t) -> Vec<String> {
    if detail.ValueType != VALUE_ENUM { return Vec::new(); }
    let Some(supported) = enum_supported(detail) else { return Vec::new() };
    low_latency_table()
        .iter()
        .filter(|(_, value)| supported & (1_u64 << value) != 0)
        .map(|(name, _)| (*name).to_owned())
        .collect()
}

fn flip_table() -> [(&'static str, u32); 6] {
    [
        ("application-default", 1),
        ("smart-vsync", 32),
        ("vsync-off", 2),
        ("vsync-on", 4),
        ("smooth-sync", 8),
        ("speed-frame", 16),
    ]
}

fn low_latency_table() -> [(&'static str, u32); 3] {
    [("off", 0), ("on", 1), ("on-boost", 2)]
}

fn is_battlemage(name: &str, device: &Value) -> bool {
    let name = name.trim().to_ascii_lowercase();
    if name.contains("battlemage") { return true; }
    let is_b_series = {
        let bytes = name.as_bytes();
        let mut found = false;
        for (index, byte) in bytes.iter().enumerate() {
            if *byte != b'b' { continue; }
            let digits = bytes[index + 1..].iter().take_while(|byte| byte.is_ascii_digit()).count();
            let boundary = bytes.get(index + 1 + digits).is_none_or(|next| !next.is_ascii_alphanumeric());
            if (2..=4).contains(&digits) && boundary { found = true; break; }
        }
        found
    };
    if is_b_series { return true; }
    let pci = |key: &str| -> String {
        device
            .get(key)
            .and_then(Value::as_str)
            .map(|value| value.trim().to_ascii_lowercase())
            .map(|value| value.strip_prefix("0x").map(str::to_owned).unwrap_or(value))
            .filter(|value| (1..=8).contains(&value.len()) && value.chars().all(|c| c.is_ascii_hexdigit()))
            .map(|value| format!("{value:0>4}"))
            .map(|value| value[value.len().saturating_sub(4)..].to_owned())
            .unwrap_or_default()
    };
    pci("pciVendorId") == "8086" && pci("pciDeviceId").starts_with("e2")
}

fn endurance_value_type_supported(value_type: i32) -> bool {
    matches!(value_type, VALUE_ENUM | VALUE_INT32 | VALUE_UINT32)
}

fn endurance_control_from(value: u32) -> Option<&'static str> {
    match value {
        0 => Some("off"),
        1 => Some("on"),
        2 => Some("auto"),
        _ => None,
    }
}

fn endurance_mode_from_fps(value: i32) -> Option<&'static str> {
    match value {
        60 => Some("performance"),
        40 => Some("balanced"),
        30 => Some("battery"),
        _ => None,
    }
}

fn endurance_control_options(detail: &ctl_3d_feature_details_t) -> Vec<String> {
    if !endurance_value_type_supported(detail.ValueType) { return Vec::new(); }
    if detail.ValueType != VALUE_ENUM || enum_supported(detail).is_none_or(|mask| mask == 0) {
        return if matches!(detail.ValueType, VALUE_INT32 | VALUE_UINT32) {
            vec!["off".into(), "on".into()]
        } else {
            ENDURANCE_CONTROL_OPTIONS.iter().map(|name| (*name).to_owned()).collect()
        };
    }
    let mask = enum_supported(detail).unwrap_or(0);
    [("off", 0_u32), ("on", 1), ("auto", 2)]
        .iter()
        .filter(|(_, bit)| mask & (1_u64 << bit) != 0)
        .map(|(name, _)| (*name).to_owned())
        .collect()
}

fn endurance_mode_options(detail: &ctl_3d_feature_details_t) -> Vec<String> {
    if !matches!(detail.ValueType, VALUE_INT32 | VALUE_UINT32) { return Vec::new(); }
    let Some(range) = Range::from_detail(detail) else { return Vec::new() };
    [("performance", 60_i64), ("balanced", 40), ("battery", 30)]
        .iter()
        .filter(|(_, fps)| (range.min..=range.max).contains(fps))
        .map(|(name, _)| (*name).to_owned())
        .collect()
}

#[derive(Clone, Debug, Default)]
struct EnduranceValue {
    control: Option<&'static str>,
    mode: Option<&'static str>,
    fps: Option<i32>,
}

fn read_endurance_value(
    io: &mut dyn GraphicsFeatureIo,
    index: usize,
    detail: &ctl_3d_feature_details_t,
) -> Option<EnduranceValue> {
    if !endurance_value_type_supported(detail.ValueType) { return None; }
    if detail.ValueType == VALUE_ENUM {
        let value = io.read_enum(index, FEATURE_ENDURANCE_GAMING, "").ok()?;
        return Some(EnduranceValue { control: endurance_control_from(value), mode: None, fps: None });
    }
    let (enabled, fps) = io.read_int(index, FEATURE_ENDURANCE_GAMING, "").ok()?;
    Some(EnduranceValue {
        control: Some(if enabled { "on" } else { "off" }),
        mode: endurance_mode_from_fps(fps),
        fps: Some(fps),
    })
}

/// Some driver branches answer the Endurance GET but omit feature 1 from
/// `ctlGetSupported3DCapabilities`. Probe the documented generic INT32 ABI so
/// eligible mobile/iGPU adapters are not reduced to desktop cards.
fn probe_endurance_detail(io: &mut dyn GraphicsFeatureIo, index: usize) -> Option<ctl_3d_feature_details_t> {
    // Any successful GET is evidence the driver answers the generic INT32
    // ABI; the returned value itself is not used to synthesize a capability.
    io.read_int(index, FEATURE_ENDURANCE_GAMING, "").ok()?;
    let mut detail: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
    detail.FeatureType = FEATURE_ENDURANCE_GAMING;
    detail.ValueType = VALUE_INT32;
    detail.PerAppSupport = 0;
    detail.Value[4..8].copy_from_slice(&30_i32.to_le_bytes());
    detail.Value[8..12].copy_from_slice(&60_i32.to_le_bytes());
    detail.Value[12..16].copy_from_slice(&1_i32.to_le_bytes());
    detail.Value[16..20].copy_from_slice(&60_i32.to_le_bytes());
    Some(detail)
}

fn endurance_detail(
    io: &mut dyn GraphicsFeatureIo,
    index: usize,
    features: &[ctl_3d_feature_details_t],
) -> Option<ctl_3d_feature_details_t> {
    match feature(features, FEATURE_ENDURANCE_GAMING) {
        Some(detail) if endurance_value_type_supported(detail.ValueType) => Some(detail),
        _ => probe_endurance_detail(io, index),
    }
}

fn read_with(
    io: &mut dyn GraphicsFeatureIo,
    index: usize,
    device: &Value,
    shared: &dyn RegistryAccess,
) -> Value {
    let features = io.features(index).unwrap_or_default();

    let frame_gen_detail = feature(&features, FEATURE_FRAME_GENERATION);
    let flip_detail = feature(&features, FEATURE_GAMING_FLIP_MODES);
    let latency_detail = feature(&features, FEATURE_LOW_LATENCY);
    let frame_limit_detail = feature(&features, FEATURE_FRAME_LIMIT);
    let sharpening_detail = feature(&features, FEATURE_SHARPENING_FILTER);
    let prebuilt_detail = feature(&features, FEATURE_PREBUILT_SHADER_DOWNLOAD);
    let prebuilt_supported = is_battlemage(device["name"].as_str().unwrap_or(""), device)
        && prebuilt_detail.is_some_and(|detail| detail.ValueType == VALUE_BOOL);

    let mut supported = Map::new();
    supported.insert("frameGen".into(), json!(frame_gen_detail.is_some()));
    supported.insert("flipModes".into(), json!(flip_detail.is_some()));
    supported.insert("frameLimit".into(), json!(frame_limit_detail.is_some()));
    supported.insert("lowLatency".into(), json!(latency_detail.is_some()));
    if prebuilt_supported { supported.insert("prebuiltShaderDownload".into(), json!(true)); }

    let mut supported_options = Map::new();
    supported_options.insert(
        "frameGen".into(),
        json!(if frame_gen_detail.is_some() {
            GRAPHICS_FRAME_GEN_OPTIONS.iter().map(|name| (*name).to_owned()).collect::<Vec<String>>()
        } else {
            Vec::new()
        }),
    );
    supported_options.insert(
        "flipModes".into(),
        json!(flip_detail.map(|detail| enum_options(&detail, &flip_table())).unwrap_or_default()),
    );
    supported_options.insert(
        "lowLatency".into(),
        json!(latency_detail.map(|detail| low_latency_options(&detail)).unwrap_or_default()),
    );

    let frame_limit_range = frame_limit_detail.and_then(|detail| Range::from_detail(&detail)).map(Range::json);
    let frame_limit_live_change = frame_limit_detail
        .is_some_and(|detail| detail.FeatureMiscSupport & MISC_FLAG_LIVE_CHANGE != 0);

    let mut values = Map::new();
    values.insert(
        "frameGenOverride".into(),
        json!(frame_gen_detail
            .filter(|detail| detail.ValueType == VALUE_ENUM)
            .and_then(|_| read_enum_value(io, index, FEATURE_FRAME_GENERATION))
            .and_then(|value| match value { 0 => Some("app-choice"), 1 => Some("2x"), 2 => Some("3x"), 3 => Some("4x"), _ => None })),
    );
    values.insert(
        "flipMode".into(),
        json!(flip_detail
            .filter(|detail| detail.ValueType == VALUE_ENUM)
            .and_then(|_| read_enum_value(io, index, FEATURE_GAMING_FLIP_MODES))
            .and_then(|value| flip_table().iter().find(|(_, bit)| *bit == value).map(|(name, _)| *name))),
    );
    values.insert("frameLimit".into(), Value::Null);
    values.insert(
        "lowLatency".into(),
        json!(latency_detail
            .filter(|detail| detail.ValueType == VALUE_ENUM)
            .and_then(|_| read_enum_value(io, index, FEATURE_LOW_LATENCY))
            .and_then(|value| match value { 0 => Some("off"), 1 => Some("on"), 2 => Some("on-boost"), _ => None })),
    );

    // Sharpening: direct 3D feature 7 (Electron used an isolated child helper).
    let mut sharpening = Value::Null;
    let mut sharpening_range = Value::Null;
    let mut sharpening_reason = SHARPENING_UNAVAILABLE.to_owned();
    let mut sharpening_per_app = false;
    let mut sharpening_live_change = false;
    if let Some(detail) = sharpening_detail {
        let range = Range::from_detail(&detail);
        let valid = range.is_some_and(|range| {
            range.min == 0 && range.max == 100 && range.step == 1 && (0..=100).contains(&range.default)
        });
        if valid {
            let range = range.expect("validated above");
            sharpening_range = range.json();
            sharpening_per_app = detail.PerAppSupport != 0;
            sharpening_live_change = detail.FeatureMiscSupport & MISC_FLAG_LIVE_CHANGE != 0;
            sharpening_reason = String::new();
            supported.insert("sharpening".into(), json!(true));
            sharpening = read_int_value(io, index, FEATURE_SHARPENING_FILTER)
                .map(|(enabled, percentage)| json!({"enabled": enabled, "percentage": percentage}))
                .unwrap_or(Value::Null);
        }
    }
    values.insert("sharpening".into(), sharpening);

    if prebuilt_supported {
        values.insert(
            "prebuiltShaderDownload".into(),
            json!(read_bool_value(io, index, FEATURE_PREBUILT_SHADER_DOWNLOAD)),
        );
    }
    if frame_limit_detail.is_some() {
        values.insert(
            "frameLimit".into(),
            read_int_value(io, index, FEATURE_FRAME_LIMIT)
                .map(|(enabled, value)| json!({"enabled": enabled, "value": value}))
                .unwrap_or(Value::Null),
        );
    }

    let platform = intel_integrated_or_mobile(device);
    if platform {
        if let Some(detail) = endurance_detail(io, index, &features) {
            let controls = endurance_control_options(&detail);
            supported_options.insert("enduranceGaming".into(), json!(controls));
            supported_options.insert("enduranceGamingModes".into(), json!(endurance_mode_options(&detail)));
            if !controls.is_empty() { supported.insert("enduranceGaming".into(), json!(true)); }
            let value = read_endurance_value(io, index, &detail);
            values.insert("enduranceGaming".into(), json!(value.as_ref().and_then(|value| value.control)));
            values.insert("enduranceGamingMode".into(), json!(value.as_ref().and_then(|value| value.mode)));
        } else {
            supported.insert("enduranceGaming".into(), json!(false));
            supported_options.insert("enduranceGaming".into(), json!([] as [&str; 0]));
            supported_options.insert("enduranceGamingModes".into(), json!([] as [&str; 0]));
            values.insert("enduranceGaming".into(), Value::Null);
            values.insert("enduranceGamingMode".into(), Value::Null);
        }
    }

    // Shared GPU/NPU memory is independent of the 3D feature table.
    let mut shared_memory_range = None;
    if shared_memory_override::adapter_supported(device) {
        if let Ok(Some(state)) = shared_memory_override::read(shared, device) {
            supported.insert("sharedMemoryOverride".into(), json!(true));
            values.insert("sharedMemoryOverride".into(), state.value_json());
            shared_memory_range = Some(state.range_json());
        }
    }

    let mut state = Map::new();
    state.insert("supported".into(), Value::Object(supported));
    state.insert("supportedOptions".into(), Value::Object(supported_options));
    state.insert("frameLimitRange".into(), json!(frame_limit_range));
    state.insert("frameLimitLiveChange".into(), json!(frame_limit_live_change));
    if let Some(range) = shared_memory_range { state.insert("sharedMemoryRange".into(), range); }
    state.insert("values".into(), Value::Object(values));
    state.insert("sharpeningRange".into(), sharpening_range);
    state.insert(
        "sharpeningReason".into(),
        if sharpening_reason.is_empty() { Value::Null } else { json!(sharpening_reason) },
    );
    state.insert("sharpeningPerAppSupport".into(), json!(sharpening_per_app));
    state.insert("sharpeningLiveChange".into(), json!(sharpening_live_change));
    Value::Object(state)
}

/// Port of `decorateRtssFrameLimitState`.
fn decorate_rtss(state: &Value, frame_limit: Value) -> Value {
    let mut state = state.as_object().cloned().unwrap_or_default();
    let mut supported = state.get("supported").and_then(Value::as_object).cloned().unwrap_or_default();
    supported.insert("frameLimit".into(), json!(true));
    state.insert("supported".into(), Value::Object(supported));
    state.insert("frameLimitRange".into(), RTSS_FRAME_LIMIT_RANGE.json());
    state.insert("frameLimitSource".into(), json!("rtss"));
    state.insert("frameLimitLiveChange".into(), json!(true));
    let mut values = state.get("values").and_then(Value::as_object).cloned().unwrap_or_default();
    values.insert("frameLimit".into(), frame_limit);
    state.insert("values".into(), Value::Object(values));
    Value::Object(state)
}

/// Port of `decorateGraphicsState`.
fn decorate_graphics_state(state: &Value, rtss: Option<&Value>) -> Value {
    let Some(state) = state.as_object() else { return Value::Null };
    let rtss_ok = rtss.is_some_and(|rtss| rtss.get("ok") == Some(&Value::Bool(true)));
    if !rtss_ok {
        let mut state = state.clone();
        state.insert("frameLimitSource".into(), json!("igcl"));
        state.insert(
            "frameLimitLiveChange".into(),
            json!(state.get("frameLimitLiveChange") == Some(&Value::Bool(true))),
        );
        return Value::Object(state);
    }
    let rtss = rtss.expect("checked above");
    let limit = rtss.get("limit").and_then(Value::as_f64).filter(|value| value.is_finite())
        .map(|value| value.max(0.0).round() as i64)
        .unwrap_or(0);
    let limiter_enabled = rtss.get("limiterEnabled") != Some(&Value::Bool(false));
    let state = Value::Object(state.clone());
    decorate_rtss(
        &state,
        json!({
            "enabled": limiter_enabled && limit > 0,
            "value": if limit > 0 { limit } else { RTSS_FRAME_LIMIT_RANGE.default },
        }),
    )
}

/// The Arc Sleep Base Cap overrides the RTSS read when it is materialized:
/// an enabled base reports its persisted value, a disabled one reports 0.
fn decorate_sleep_base(rtss: Value, gate: SleepGate, base_value: Option<u64>) -> Value {
    if !gate.base_present || rtss.get("ok") != Some(&Value::Bool(true)) { return rtss; }
    let mut rtss = rtss;
    rtss["limit"] = json!(if gate.base_enabled { base_value.unwrap_or(0) } else { 0 });
    rtss["limiterEnabled"] = json!(gate.base_enabled);
    rtss
}

fn read_state(runtime: &Runtime, device_id: u64, target: &Value, use_rtss: bool, gate: SleepGate, settings: &Value) -> Value {
    let base = if target.is_null() || target_is_synthetic(target) {
        // An OS/synthetic row has no IGCL adapter: Electron's backend read
        // throws for it and degrades. Do not open a driver for it at all.
        degraded_state()
    } else {
        match (runtime.open)(device_id) {
            Ok(mut session) => read_with(&mut *session.io, session.index, &session.device, runtime.shared_memory),
            Err(_) => degraded_state(),
        }
    };
    if !use_rtss {
        return decorate_graphics_state(&base, None);
    }
    let rtss = decorate_sleep_base(runtime.frame_limit.read(), gate, base_value(settings));
    decorate_graphics_state(&base, Some(&rtss))
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

fn fail(result: &mut Value, control: &str, code: &str, message: impl Into<String>) {
    result["ok"] = json!(false);
    result["perControl"][control] = json!({"ok": false, "errorCode": code, "message": message.into()});
}

fn igcl_code(error: &IgclError) -> &'static str {
    // `game_profile_apply::error_code` is the generic branch of
    // `backend.interface.js igclErrorCode`: unsupported / invalid-argument /
    // permission-denied, and the honest io-failed fallback for the
    // 0x60000000-range 3D codes.
    error_code(error)
}

fn set_enum_control(
    io: &mut dyn GraphicsFeatureIo,
    result: &mut Value,
    index: usize,
    control: &str,
    feature_type: i32,
    requested: u32,
) {
    if let Err(error) = io.write_enum(index, feature_type, requested, "") {
        fail(result, control, igcl_code(&error), error.to_string());
        return;
    }
    let read_back = io.read_enum(index, feature_type, "").ok();
    let equal = read_back == Some(requested);
    let message = if equal {
        Value::Null
    } else {
        json!(format!(
            "read-back {} != requested {requested}",
            read_back.map_or_else(|| "unavailable".to_owned(), |value| value.to_string())
        ))
    };
    result["perControl"][control] = json!({
        "ok": equal,
        "errorCode": if equal { Value::Null } else { json!("io-failed") },
        "message": message,
        "readBackEqual": equal,
        "silentNoop": !equal,
    });
    if !equal { result["ok"] = json!(false); }
}

fn set_bool_control(
    io: &mut dyn GraphicsFeatureIo,
    result: &mut Value,
    index: usize,
    control: &str,
    feature_type: i32,
    requested: bool,
) {
    if let Err(error) = io.write_bool(index, feature_type, requested, "") {
        fail(result, control, igcl_code(&error), error.to_string());
        return;
    }
    let read_back = io.read_bool(index, feature_type, "").ok();
    let equal = read_back == Some(requested);
    result["perControl"][control] = json!({
        "ok": equal,
        "errorCode": if equal { Value::Null } else { json!("io-failed") },
        "message": if equal { Value::Null } else {
            json!(format!("read-back {} != requested {requested}",
                read_back.map_or_else(|| "null".to_owned(), |value| value.to_string())))
        },
        "readBackEqual": equal,
        "silentNoop": !equal,
    });
    if !equal { result["ok"] = json!(false); }
}

fn set_endurance_enum(
    io: &mut dyn GraphicsFeatureIo,
    result: &mut Value,
    index: usize,
    requested: &str,
    detail: &ctl_3d_feature_details_t,
) {
    let controls = endurance_control_options(detail);
    if !controls.iter().any(|option| option == requested) {
        fail(
            result,
            "enduranceGaming",
            "unsupported",
            format!("the '{requested}' option is not supported by this driver"),
        );
        return;
    }
    let value = match requested { "off" => 0, "on" => 1, _ => 2 };
    set_enum_control(io, result, index, "enduranceGaming", FEATURE_ENDURANCE_GAMING, value);
}

fn set_endurance_int(
    io: &mut dyn GraphicsFeatureIo,
    result: &mut Value,
    index: usize,
    detail: &ctl_3d_feature_details_t,
    control: Option<&str>,
    mode: Option<&str>,
) {
    let current = read_endurance_value(io, index, detail);
    let controls = endurance_control_options(detail);
    let modes = endurance_mode_options(detail);
    if control == Some("auto") {
        fail(
            result,
            "enduranceGaming",
            "unsupported",
            "This IGCL driver exposes Endurance Gaming as an On/Off FPS control; Auto is managed by the Intel Graphics Software profile layer.",
        );
        return;
    }
    if let Some(control) = control.filter(|control| !controls.iter().any(|option| option == control)) {
        fail(result, "enduranceGaming", "out-of-range", format!("unknown Endurance Gaming control '{control}'"));
        return;
    }
    if mode.is_some_and(|mode| !modes.iter().any(|option| option == mode)) {
        fail(
            result,
            "enduranceGamingMode",
            "unsupported",
            "The requested Endurance Gaming preset is outside this driver's supported FPS range.",
        );
        return;
    }
    let partial = control.is_none() || mode.is_none();
    let unreadable = current.as_ref().is_none_or(|current| {
        (control.is_some() && current.fps.is_none())
            || (mode.is_some() && current.control.is_none())
    });
    if partial && unreadable {
        // A partial update must preserve the omitted sibling; refusing is
        // safer than resetting it to a fallback.
        for (requested, control_name) in [(control.is_some(), "enduranceGaming"), (mode.is_some(), "enduranceGamingMode")] {
            if requested {
                fail(result, control_name, "io-failed", "The current Endurance Gaming value could not be read; no change was written.");
            }
        }
        return;
    }
    let range = Range::from_detail(detail);
    let requested_fps = match mode {
        Some(mode) => Some(match mode { "performance" => 60, "balanced" => 40, _ => 30 }),
        None => current.as_ref().and_then(|current| current.fps),
    };
    let target_fps = match (range, requested_fps) {
        (Some(range), Some(fps)) => range.clamp_snap(fps as f64) as i32,
        (Some(range), None) => range.clamp_snap(range.default as f64) as i32,
        (None, Some(fps)) => fps,
        (None, None) => 60,
    };
    let enabled = match control {
        Some("on") => true,
        Some("off") => false,
        _ => current.as_ref().and_then(|current| current.control) == Some("on"),
    };
    if let Err(error) = io.write_int(index, FEATURE_ENDURANCE_GAMING, enabled, target_fps, "") {
        let code = igcl_code(&error);
        let message = error.to_string();
        if control.is_some() { fail(result, "enduranceGaming", code, message.clone()); }
        if mode.is_some() { fail(result, "enduranceGamingMode", code, message); }
        return;
    }
    let read_back = io.read_int(index, FEATURE_ENDURANCE_GAMING, "").ok();
    let control_equal = control.is_none() || read_back.is_some_and(|(value, _)| value == enabled);
    let mode_equal = mode.is_none() || read_back.is_some_and(|(_, value)| value == target_fps);
    for (requested, control_name, equal) in [
        (control.is_some(), "enduranceGaming", control_equal),
        (mode.is_some(), "enduranceGamingMode", mode_equal),
    ] {
        if !requested { continue; }
        result["perControl"][control_name] = json!({
            "ok": equal,
            "errorCode": if equal { Value::Null } else { json!("io-failed") },
            "message": if equal { Value::Null } else {
                json!("read-back did not match the requested Endurance Gaming value")
            },
            "readBackEqual": equal,
            "silentNoop": !equal,
        });
        if !equal { result["ok"] = json!(false); }
    }
}

fn set_frame_limit(
    io: &mut dyn GraphicsFeatureIo,
    result: &mut Value,
    index: usize,
    detail: Option<ctl_3d_feature_details_t>,
    limit: &Value,
) {
    let Some(detail) = detail else {
        fail(result, "frameLimit", "unsupported", "the frame limit is not supported on this device");
        return;
    };
    let Some(range) = Range::from_detail(&detail) else {
        fail(result, "frameLimit", "unsupported", "no capability range reported for the frame limit");
        return;
    };
    let enabled = limit.get("enabled").and_then(Value::as_bool) == Some(true);
    let value = range.clamp_snap(limit.get("value").and_then(Value::as_f64).unwrap_or(range.min as f64)) as i32;
    if let Err(error) = io.write_int(index, FEATURE_FRAME_LIMIT, enabled, value, "") {
        fail(result, "frameLimit", igcl_code(&error), error.to_string());
        return;
    }
    let read_back = io.read_int(index, FEATURE_FRAME_LIMIT, "").ok();
    let equal = read_back.is_some_and(|(read_enabled, read_value)| read_enabled == enabled && read_value == value);
    result["perControl"]["frameLimit"] = json!({
        "ok": equal,
        "errorCode": if equal { Value::Null } else { json!("io-failed") },
        "message": if equal { Value::Null } else {
            json!(format!("read-back did not match requested frame limit {value}"))
        },
        "readBackEqual": equal,
        "silentNoop": !equal,
    });
    if !equal { result["ok"] = json!(false); }
}

fn set_sharpening(
    io: &mut dyn GraphicsFeatureIo,
    result: &mut Value,
    index: usize,
    detail: Option<ctl_3d_feature_details_t>,
    sharpening: &Value,
) {
    let Some(detail) = detail else {
        fail(result, "sharpening", "unsupported", "the driver does not report the 3D sharpening feature");
        return;
    };
    let range = Range::from_detail(&detail);
    let valid_range = range.is_some_and(|range| {
        range.min == 0 && range.max == 100 && range.step == 1
    });
    if !valid_range {
        fail(
            result,
            "sharpening",
            "unsupported",
            "the driver does not advertise sharpening as an integer 0-100 control",
        );
        return;
    }
    let enabled = sharpening.get("enabled").and_then(Value::as_bool);
    let percentage = sharpening.get("percentage").and_then(Value::as_u64).filter(|value| *value <= 100);
    let (Some(enabled), Some(percentage)) = (enabled, percentage) else {
        fail(
            result,
            "sharpening",
            "out-of-range",
            "Sharpening requires an enabled flag and an integer percentage from 0 to 100.",
        );
        return;
    };
    let value = percentage as i32;
    if let Err(error) = io.write_int(index, FEATURE_SHARPENING_FILTER, enabled, value, "") {
        fail(result, "sharpening", igcl_code(&error), error.to_string());
        return;
    }
    let read_back = io.read_int(index, FEATURE_SHARPENING_FILTER, "").ok();
    let equal = read_back.is_some_and(|(read_enabled, read_value)| read_enabled == enabled && read_value == value);
    result["perControl"]["sharpening"] = json!({
        "ok": equal,
        "errorCode": if equal { Value::Null } else { json!("io-failed") },
        "message": if equal { Value::Null } else {
            json!("read-back did not match the requested sharpening value")
        },
        "readBackEqual": equal,
        "silentNoop": !equal,
    });
    if !equal { result["ok"] = json!(false); }
}

fn apply_with_io(
    io: &mut dyn GraphicsFeatureIo,
    index: usize,
    device: &Value,
    settings: &Value,
    shared: &dyn RegistryAccess,
) -> Value {
    let features_result = io.features(index);
    // Electron gates the whole native surface on both 3D symbols being
    // present; a failed capability read degrades to that same refusal.
    let surface_up = features_result.is_ok();
    let features = features_result.unwrap_or_default();
    let mut result = json!({"ok": true, "perControl": {}});

    // Shared GPU/NPU memory is a Windows memory-manager setting and is
    // intentionally independent of the 3D-feature surface.
    if let Some(value) = settings.get("sharedMemoryOverride").filter(|value| !value.is_null()) {
        result["perControl"]["sharedMemoryOverride"] = shared_memory_override::apply(shared, device, value);
        if result["perControl"]["sharedMemoryOverride"]["ok"] != json!(true) {
            result["ok"] = json!(false);
        }
    }
    // Sharpening is a 3D feature read/written in-process (no child helper).
    if let Some(value) = settings.get("sharpening").filter(|value| !value.is_null()) {
        set_sharpening(io, &mut result, index, feature(&features, FEATURE_SHARPENING_FILTER), value);
    }

    let native_controls = [
        "enduranceGaming", "enduranceGamingMode", "frameGenOverride", "flipMode", "frameLimit",
        "lowLatency", "prebuiltShaderDownload",
    ];
    if !surface_up {
        for control in native_controls {
            if settings.get(control).is_some_and(|value| !value.is_null()) {
                fail(&mut result, control, "unavailable-symbol", "the 3D-feature API is missing in the IGCL runtime");
            }
        }
        return result;
    }

    if let Some(value) = settings.get("prebuiltShaderDownload").and_then(Value::as_bool) {
        if !is_battlemage(device["name"].as_str().unwrap_or(""), device)
            || !feature(&features, FEATURE_PREBUILT_SHADER_DOWNLOAD)
                .is_some_and(|detail| detail.ValueType == VALUE_BOOL)
        {
            fail(&mut result, "prebuiltShaderDownload", "unsupported", "Precompiled Shaders are not supported on this GPU");
        } else {
            set_bool_control(io, &mut result, index, "prebuiltShaderDownload", FEATURE_PREBUILT_SHADER_DOWNLOAD, value);
        }
    }

    let endurance_control = settings.get("enduranceGaming").and_then(Value::as_str);
    let endurance_mode = settings.get("enduranceGamingMode").and_then(Value::as_str);
    if endurance_control.is_some() || endurance_mode.is_some() {
        let platform = intel_integrated_or_mobile(device);
        let detail = if platform { endurance_detail(io, index, &features) } else { None };
        match detail {
            None => {
                if endurance_control.is_some() {
                    fail(&mut result, "enduranceGaming", "unsupported", "Endurance Gaming is only available on supported Intel integrated or mobile graphics.");
                }
                if endurance_mode.is_some() {
                    fail(&mut result, "enduranceGamingMode", "unsupported", "Endurance Gaming presets are only available on supported Intel integrated or mobile graphics.");
                }
            }
            Some(detail) if detail.ValueType == VALUE_ENUM && endurance_mode.is_some() => {
                fail(&mut result, "enduranceGamingMode", "unsupported", "This driver exposes Endurance Gaming without selectable FPS presets.");
            }
            Some(detail) if detail.ValueType == VALUE_ENUM => {
                if let Some(control) = endurance_control {
                    set_endurance_enum(io, &mut result, index, control, &detail);
                }
            }
            Some(detail) if matches!(detail.ValueType, VALUE_INT32 | VALUE_UINT32) => {
                set_endurance_int(io, &mut result, index, &detail, endurance_control, endurance_mode);
            }
            Some(_) => {
                if endurance_control.is_some() {
                    fail(&mut result, "enduranceGaming", "unsupported", "This driver exposes an undocumented Endurance Gaming value type.");
                }
                if endurance_mode.is_some() {
                    fail(&mut result, "enduranceGamingMode", "unsupported", "This driver exposes an undocumented Endurance Gaming value type.");
                }
            }
        }
    }

    if let Some(value) = settings.get("frameGenOverride").and_then(Value::as_str) {
        if feature(&features, FEATURE_FRAME_GENERATION).is_none() {
            fail(&mut result, "frameGenOverride", "unsupported", "XeSS frame generation is not supported on this device");
        } else {
            let requested = match value { "app-choice" => 0, "2x" => 1, "3x" => 2, _ => 3 };
            set_enum_control(io, &mut result, index, "frameGenOverride", FEATURE_FRAME_GENERATION, requested);
        }
    }

    if let Some(value) = settings.get("flipMode").and_then(Value::as_str) {
        match feature(&features, FEATURE_GAMING_FLIP_MODES) {
            None => fail(&mut result, "flipMode", "unsupported", "frame synchronization is not supported on this device"),
            Some(detail) => {
                let requested = flip_table().iter().find(|(name, _)| *name == value).map(|(_, bit)| *bit).unwrap_or(0);
                // The option gate only exists for ENUM capabilities (Electron's
                // `enumSupportedTypes != null` check).
                let option_ok = detail.ValueType != VALUE_ENUM
                    || enum_supported(&detail).is_none_or(|supported| supported & u64::from(requested) != 0);
                if option_ok {
                    set_enum_control(io, &mut result, index, "flipMode", FEATURE_GAMING_FLIP_MODES, requested);
                } else {
                    fail(&mut result, "flipMode", "unsupported", format!("the '{value}' option is not supported by this driver"));
                }
            }
        }
    }

    if let Some(value) = settings.get("lowLatency").and_then(Value::as_str) {
        // No caps pre-gate: the M8 probe recorded caps 0x3 (off/on only) while
        // the driver accepted On + Boost. The driver's actual answer decides.
        if feature(&features, FEATURE_LOW_LATENCY).is_none() {
            fail(&mut result, "lowLatency", "unsupported", "low latency mode is not supported on this device");
        } else {
            let requested = match value { "off" => 0, "on" => 1, _ => 2 };
            set_enum_control(io, &mut result, index, "lowLatency", FEATURE_LOW_LATENCY, requested);
        }
    }

    if let Some(limit) = settings.get("frameLimit").filter(|value| value.is_object()) {
        set_frame_limit(io, &mut result, index, feature(&features, FEATURE_FRAME_LIMIT), limit);
    }

    result
}

// ---------------------------------------------------------------------------
// RTSS-first frame limit
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct RtssOutcome {
    handled: bool,
    per_control: Value,
    restore_token: Option<Value>,
}

fn apply_rtss_frame_limit(frame_limit: &Value, io: &dyn FrameLimitIo) -> RtssOutcome {
    let options = json!({
        "enabled": frame_limit.get("enabled").and_then(Value::as_bool) == Some(true),
        "value": frame_limit.get("value").cloned().unwrap_or(Value::Null),
    });
    let result = io.apply(&options);
    let handled = result.get("ok") == Some(&Value::Bool(true))
        && result.get("used") == Some(&Value::Bool(true));
    RtssOutcome {
        handled,
        per_control: json!({"frameLimit": {"ok": true, "source": "rtss"}}),
        restore_token: result.get("restoreToken").cloned().filter(|token| !token.is_null()),
    }
}

/// Restore the pre-apply RTSS state. A failed restore is a `cleanup-pending`
/// condition: the caller must not fall back to an IGCL write.
fn rollback_rtss(outcome: &RtssOutcome, io: &dyn FrameLimitIo) -> Result<(), String> {
    if !outcome.handled { return Ok(()); }
    let Some(token) = outcome.restore_token.as_ref() else {
        return Err("RTSS frame-limit rollback token is unavailable".into());
    };
    let result = io.restore(token);
    if result.get("ok") == Some(&Value::Bool(true)) {
        Ok(())
    } else {
        Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("RTSS frame-limit rollback was not verified")
            .to_owned())
    }
}

fn driver_settings_without(settings: &Value, control: &str) -> Value {
    if let Some(object) = settings.as_object() {
        let mut object = object.clone();
        object.remove(control);
        return Value::Object(object);
    }
    Value::Object(Map::new())
}

fn empty_apply() -> Value {
    json!({"ok": true, "perControl": {}})
}

fn sanitize_driver_frame_limit(settings: &Value, range: Option<Range>) -> Result<Value, String> {
    sanitize_graphics_settings(&json!({"frameLimit": settings}), range)
        .map(|sanitized| sanitized["frameLimit"].clone())
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

pub(crate) fn get_with(
    runtime: &Runtime,
    device_id: u64,
    supplied_key: Option<&str>,
) -> Result<Option<Value>, String> {
    let gate = match gate(&runtime.settings) {
        GateDecision::Delegate => return Ok(None),
        GateDecision::Proceed(gate) => gate,
    };
    let expected = expected_device_key(&runtime.settings, device_id, supplied_key)?;
    let resolved = resolve_selected(&runtime.devices, device_id, expected.as_deref())?;
    Ok(Some(read_state(runtime, resolved.id, &resolved.target, true, gate, &runtime.settings)))
}

pub(crate) fn apply_with(
    runtime: &Runtime,
    device_id: u64,
    payload: &Value,
    supplied_key: Option<&str>,
    mut owner: Option<&mut dyn FrameLimitOwner>,
    settings_after: Option<&dyn Fn() -> Value>,
) -> Result<Option<Value>, String> {
    let gate = match gate(&runtime.settings) {
        GateDecision::Delegate => return Ok(None),
        GateDecision::Proceed(gate) => gate,
    };
    // Without a Base Cap owner the persisted Base Cap still owns the global
    // limiter and its value. Refuse before touching the driver, RTSS or the
    // registry: this host must never write the base cap or journal itself.
    // (Validation of the rest of the payload happens after this point,
    // matching the delegation guarantee that no read/write precedes the gate.)
    if owner.is_none() && gate.base_present && payload.get("frameLimit").is_some_and(|value| !value.is_null()) {
        return Ok(None);
    }
    let expected = expected_device_key(&runtime.settings, device_id, supplied_key)?;
    let resolved = resolve_selected(&runtime.devices, device_id, expected.as_deref())?;
    let target = resolved.target.clone();
    if let Some(expected) = expected.as_deref() {
        if target.is_null() || row_ambiguous(&target) || !row_has_key(&target, expected) {
            return Err(format!(
                "stale GPU target: device id {} no longer resolves to {expected}",
                resolved.id
            ));
        }
    }

    let synthetic = target_is_synthetic(&target);
    let base_state = if target.is_null() || synthetic {
        degraded_state()
    } else {
        match (runtime.open)(resolved.id) {
            Ok(mut session) => read_with(&mut *session.io, session.index, &session.device, runtime.shared_memory),
            Err(_) => degraded_state(),
        }
    };
    let rtss_state = runtime.frame_limit.read();
    let range = if rtss_state.get("ok") == Some(&Value::Bool(true)) {
        Some(RTSS_FRAME_LIMIT_RANGE)
    } else {
        base_state.get("frameLimitRange").and_then(Range::from_json)
    };
    let settings = sanitize_graphics_settings(payload, range)?;

    if target_is_synthetic(&target) {
        let mut per_control = Map::new();
        for key in settings.as_object().map(|object| object.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() {
            per_control.insert(
                key,
                json!({"ok": false, "errorCode": "unsupported", "message": "graphics features are not supported on this GPU"}),
            );
        }
        return Ok(Some(json!({
            "ok": per_control.is_empty(),
            "perControl": Value::Object(per_control),
            "graphicsState": decorate_graphics_state(&base_state, None),
        })));
    }

    let has_frame_limit = settings.get("frameLimit").is_some();

    let mut settings_for_driver = settings.clone();
    let mut owner_result: Option<Value> = None;
    let mut rtss_apply = None;
    if has_frame_limit {
        if let Some(owner) = owner.as_mut() {
            // Arc Sleep owns the Base Cap and the journal: route the single
            // frame-limit control through its transaction instead of a direct
            // RTSS or driver write.
            owner_result = Some((*owner).set_base_frame_limit(&settings["frameLimit"], expected.as_deref()));
            settings_for_driver = driver_settings_without(&settings_for_driver, "frameLimit");
        } else {
            let outcome = apply_rtss_frame_limit(&settings["frameLimit"], runtime.frame_limit);
            if !outcome.handled {
                // RTSS may expose a wider 1-1000 range than the Intel driver.
                // Re-clamp this same request against the driver range before the
                // IGCL fallback path.
                let reclamped = sanitize_driver_frame_limit(
                    &settings["frameLimit"],
                    base_state.get("frameLimitRange").and_then(Range::from_json),
                )?;
                settings_for_driver["frameLimit"] = reclamped;
            } else {
                settings_for_driver = driver_settings_without(&settings_for_driver, "frameLimit");
            }
            rtss_apply = Some(outcome);
        }
    }

    let mut driver_out = empty_apply();
    let mut driver_error: Option<String> = None;
    if settings_for_driver.as_object().is_some_and(|object| !object.is_empty()) {
        match (runtime.open)(resolved.id) {
            Ok(mut session) => {
                driver_out = apply_with_io(
                    &mut *session.io,
                    session.index,
                    &session.device,
                    &settings_for_driver,
                    runtime.shared_memory,
                );
            }
            Err(error) => {
                driver_error = Some(error);
                driver_out = json!({"ok": false, "perControl": {}});
            }
        }
    }

    let rollback = match rtss_apply.as_ref() {
        Some(outcome) if driver_out.get("ok") != Some(&Value::Bool(true)) => {
            rollback_rtss(outcome, runtime.frame_limit)
        }
        _ => Ok(()),
    };

    // A failed companion control must hand the Base Cap back through the same
    // owner, never leave the Arc Sleep cap applied.
    let mut owner_rollback: Option<Result<(), String>> = None;
    if owner_result.is_some() && driver_out.get("ok") != Some(&Value::Bool(true)) {
        if let Some(owner) = owner.as_mut() {
            let reply = (*owner).rollback();
            owner_rollback = Some(if reply.get("ok") == Some(&Value::Bool(true)) { Ok(()) } else {
                Err(reply.get("error").and_then(Value::as_str)
                    .unwrap_or("the previous FPS cap could not be restored").to_owned())
            });
        }
    }

    let use_rtss = rtss_apply.as_ref().is_none_or(|outcome| outcome.handled);
    let refreshed = settings_after.map(|load| load());
    let graphics_state = read_state(runtime, resolved.id, &target, use_rtss, gate,
        refreshed.as_ref().unwrap_or(&runtime.settings));

    let mut per_control = driver_out.get("perControl").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(outcome) = rtss_apply.as_ref().filter(|outcome| outcome.handled) {
        match (&rollback, driver_out.get("ok") == Some(&Value::Bool(true))) {
            (Ok(()), true) => {
                if let Some(entry) = outcome.per_control.get("frameLimit") {
                    per_control.insert("frameLimit".into(), entry.clone());
                }
            }
            (Ok(()), false) => {
                per_control.insert(
                    "frameLimit".into(),
                    json!({"ok": false, "errorCode": "rolled-back",
                        "message": "The FPS limit was rolled back because another graphics setting failed"}),
                );
            }
            (Err(error), _) => {
                per_control.insert(
                    "frameLimit".into(),
                    json!({"ok": false, "errorCode": "cleanup-pending",
                        "message": format!("FPS limit rollback failed: {error}")}),
                );
            }
        }
    }
    if let Some(result) = owner_result.as_ref() {
        let handled = result.get("handled") == Some(&Value::Bool(true));
        let applied = handled && result.get("ok") == Some(&Value::Bool(true));
        let entry = if !handled {
            json!({
                "ok": false,
                "errorCode": result.get("errorCode").cloned().filter(|value| !value.is_null())
                    .unwrap_or_else(|| json!("limiter-unavailable")),
                "message": result.get("error").cloned().filter(|value| !value.is_null())
                    .unwrap_or_else(|| json!("Arc Sleep could not safely apply the FPS limiter.")),
            })
        } else if applied && driver_out.get("ok") == Some(&Value::Bool(true)) {
            json!({"ok": true, "source": result.get("source").cloned().unwrap_or_else(|| json!("rtss"))})
        } else if owner_rollback.as_ref().is_none_or(|rollback| rollback.is_ok()) {
            json!({"ok": false, "errorCode": "rolled-back",
                "message": "The FPS limit was rolled back because another graphics setting failed"})
        } else {
            json!({"ok": false, "errorCode": "cleanup-pending",
                "message": format!("FPS limit rollback failed: {}",
                    owner_rollback.as_ref().and_then(|rollback| rollback.as_ref().err())
                        .map(String::as_str).unwrap_or("the previous FPS cap could not be restored"))})
        };
        per_control.insert("frameLimit".into(), entry);
    }

    if let Some(error) = driver_error {
        let rollback_message = match (&rollback, &owner_rollback) {
            (_, Some(Err(error))) => format!("FPS limit cleanup is still pending: {error}"),
            (Err(error), _) => format!("FPS limit cleanup is still pending: {error}"),
            _ => "The FPS limit change was rolled back.".to_owned(),
        };
        return Err(format!("{error}. {rollback_message}"));
    }
    let controls_ok = per_control.values().all(|entry| entry.get("ok") != Some(&Value::Bool(false)));
    let ok = driver_out.get("ok") == Some(&Value::Bool(true)) && rollback.is_ok()
        && owner_rollback.as_ref().is_none_or(|rollback| rollback.is_ok()) && controls_ok;
    Ok(Some(json!({
        "ok": ok,
        "perControl": Value::Object(per_control),
        "graphicsState": graphics_state,
    })))
}

// ---------------------------------------------------------------------------
// Event fan-out
// ---------------------------------------------------------------------------

pub type EmitHook = Arc<dyn Fn(&str, Value) + Send + Sync>;
static EMIT_HOOK: OnceLock<EmitHook> = OnceLock::new();

pub fn set_runtime_emit(emit: EmitHook) -> Result<(), String> {
    EMIT_HOOK.set(emit).map_err(|_| "Graphics event hook is already set".into())
}

/// Both surfaces that render the post-apply read-back: the main window owns
/// the Graphics page and the advanced overlay mirrors the same state.
pub fn target_roles(channel: &str) -> &'static [&'static str] {
    if channel == STATE_UPDATED_CHANNEL { &["main", "advanced-overlay"] } else { &[] }
}

/// `{ deviceId: <requested>, graphicsState }`, or `None` when the apply carried
/// no state (a degraded read-back must not emit an empty push).
pub fn state_updated_payload(requested: u64, reply: &Value) -> Option<Value> {
    let state = reply.get("graphicsState").filter(|value| !value.is_null())?;
    Some(json!({"deviceId": requested, "graphicsState": state.clone()}))
}

/// Emit the post-apply read-back exactly once. Returns whether a payload was
/// emitted so the caller can assert the single-send contract.
pub fn emit_state_updated(requested: u64, reply: &Value) -> bool {
    match EMIT_HOOK.get() {
        Some(hook) => emit_state(hook.as_ref(), requested, reply),
        None => emit_state(&|_, _| {}, requested, reply),
    }
}

fn emit_state(emit: &dyn Fn(&str, Value), requested: u64, reply: &Value) -> bool {
    let Some(payload) = state_updated_payload(requested, reply) else { return false; };
    emit(STATE_UPDATED_CHANNEL, payload);
    true
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

fn load_settings(store: &NativeStore) -> Result<Value, String> {
    super::services::native_json(store, "load-settings", json!([]))
}

/// `graphics:get`. `Ok(None)` delegates to the compatibility broker before any
/// driver or registry access (Arc Sleep gate, settings read failure, mock mode
/// or an unelevated host are handled by the caller / gate).
pub fn get(store: &NativeStore, device_id: u64, supplied_key: Option<&str>) -> Result<Option<Value>, String> {
    let settings = match load_settings(store) {
        Ok(settings) => settings,
        Err(_) => return Ok(None),
    };
    if matches!(gate(&settings), GateDecision::Delegate) { return Ok(None); }
    let devices = super::gpu_devices::list_devices_merged();
    let devices = devices.as_array().cloned().unwrap_or_default();
    let frame_limit = StoreFrameLimit(store);
    let registry = shared_memory_override::SystemRegistry;
    let open = |device_id: u64| -> Result<DriverSession, String> {
        open_session(device_id)
    };
    let run = || {
        let runtime = Runtime { devices: devices.clone(), settings: settings.clone(), open: &open, frame_limit: &frame_limit, shared_memory: &registry };
        get_with(&runtime, device_id, supplied_key)
    };
    // Serialize the whole read against Arc Sleep ticks, exactly like the
    // Electron `graphics:get` transaction.
    match super::arc_sleep_system::controller() {
        Some(controller) => controller.with_transaction(None, |_| run()),
        None => run(),
    }
}

/// `arc-sleep-base-cap-get` - the Arc Sleep panel's Base FPS Cap read.
///
/// When the controller owns the RTSS limiter this returns the RTSS-only read
/// (the controller's Base Cap, or the RTSS global limit) instead of the
/// ordinary device read. Both paths run inside the controller transaction so a
/// policy tick cannot change the cap between the read and the panel update.
pub fn base_cap_get(store: &NativeStore, device_id: u64, supplied_key: Option<&str>) -> Result<Option<Value>, String> {
    let Some(controller) = super::arc_sleep_system::controller() else { return Ok(None); };
    // Same gate as `get`/`apply`: a journal this build cannot parse belongs to a
    // foreign owner, so the panel must read that owner's view (Electron) rather
    // than a Base Cap Arc Sleep cannot prove it owns. A settings-read failure
    // delegates too, exactly like `get`.
    let Ok(settings) = load_settings(store) else { return Ok(None); };
    if matches!(gate(&settings), GateDecision::Delegate) { return Ok(None); }
    let owns_rtss = controller.get_snapshot().get("activeLimiter").and_then(Value::as_str) == Some("rtss");
    if !owns_rtss { return get(store, device_id, supplied_key); }
    let rtss = controller.with_transaction(Some("rtss"), |tx| {
        let snapshot = tx.get_snapshot();
        match snapshot.get("baseFrameLimit").and_then(super::arc_sleep_limiter::normalize_base_frame_limit) {
            Some(base) => json!({"ok": true, "limit": base["value"], "limiterEnabled": base["enabled"]}),
            None => StoreFrameLimit(store).read(),
        }
    });
    Ok(Some(decorate_graphics_state(&degraded_state(), Some(&rtss))))
}

fn base_cap_only(payload: &Value) -> bool {
    payload.as_object().is_some_and(|object| object.len() == 1 && object.contains_key("frameLimit"))
}

/// `graphics:apply`. Re-reads the settings and re-evaluates the gate under one
/// process-local lock so two renderer applies cannot interleave feature writes
/// or observe a half-migrated Arc Sleep state. The Base Cap is applied through
/// the Arc Sleep controller transaction, so the controller stays the only
/// owner of the global limiter and its journal.
pub fn apply(
    store: &NativeStore,
    device_id: u64,
    payload: &Value,
    supplied_key: Option<&str>,
) -> Result<Option<Value>, String> {
    let _guard = APPLY_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let settings = match load_settings(store) {
        Ok(settings) => settings,
        Err(_) => return Ok(None),
    };
    if matches!(gate(&settings), GateDecision::Delegate) { return Ok(None); }
    let devices = super::gpu_devices::list_devices_merged();
    let devices = devices.as_array().cloned().unwrap_or_default();
    let frame_limit = StoreFrameLimit(store);
    let registry = shared_memory_override::SystemRegistry;
    let open = |device_id: u64| -> Result<DriverSession, String> {
        open_session(device_id)
    };
    let reload = || load_settings(store).unwrap_or_else(|_| settings.clone());
    let run = |owner: Option<&mut dyn FrameLimitOwner>| {
        let runtime = Runtime { devices: devices.clone(), settings: settings.clone(), open: &open, frame_limit: &frame_limit, shared_memory: &registry };
        apply_with(&runtime, device_id, payload, supplied_key, owner, Some(&reload))
    };
    let Some(controller) = super::arc_sleep_system::controller() else {
        return run(None);
    };
    let rtss_only = base_cap_only(payload)
        && controller.get_snapshot().get("activeLimiter").and_then(Value::as_str) == Some("rtss");
    controller.with_transaction(rtss_only.then_some("rtss"), |tx| run(Some(tx)))
}

static APPLY_LOCK: Mutex<()> = Mutex::new(());

fn open_session(device_id: u64) -> Result<DriverSession, String> {
    let path = super::gpu_devices::locate_dll()
        .ok_or_else(|| "the IGCL runtime is unavailable".to_owned())?;
    let (igcl, index, device) = open_for_device(&path, device_id)?;
    Ok(DriverSession { io: Box::new(igcl), index, device })
}

// ---------------------------------------------------------------------------
// Arc Sleep IGCL frame-limit seam (gate-free, device-scoped)
// ---------------------------------------------------------------------------

/// The exact selected-adapter frame-limit state Arc Sleep compares.
struct SleepLimit {
    limit: i64,
    limiter_enabled: bool,
    range: Range,
    live_change: bool,
}

fn sleep_limit_unavailable(error: impl Into<String>) -> Value {
    json!({"ok": false, "errorCode": "unavailable", "error": error.into()})
}

fn sleep_limit_json(target: &Value, state: &SleepLimit) -> Value {
    json!({
        "deviceKey": row_key(target),
        "deviceName": target.get("name").cloned().unwrap_or(Value::Null),
        "limit": state.limit,
        "denominator": 1,
        "limiterEnabled": state.limiter_enabled,
        "frameLimitRange": state.range.json(),
        "liveChange": state.live_change,
    })
}

/// Resolve the Arc Sleep IGCL target. An explicit key comes from the journal or
/// the controller's route; otherwise the persisted selected GPU is used.
fn sleep_limit_target(store: &NativeStore, supplied_key: Option<&str>) -> Result<(u64, Value), String> {
    let key = match supplied_key {
        Some(key) if !key.trim().is_empty() => Some(key.to_owned()),
        Some(_) => return Err("invalid GPU target: expected device key must be a nonempty string".into()),
        None => {
            let settings = load_settings(store)?;
            let device_id = settings.get("deviceId").and_then(Value::as_u64)
                .ok_or("stale GPU target: a stable selected device identity is required")?;
            expected_device_key(&settings, device_id, None)?
        }
    };
    let rows = super::gpu_devices::list_devices_merged();
    let rows = rows.as_array().cloned().unwrap_or_default();
    let resolved = resolve_selected(&rows, 0, key.as_deref())?;
    Ok((resolved.id, resolved.target))
}

fn read_sleep_limit(session: &mut DriverSession) -> Result<SleepLimit, String> {
    let features = session.io.features(session.index).map_err(|error| error.to_string())?;
    let detail = feature(&features, FEATURE_FRAME_LIMIT)
        .ok_or("the frame limit is not supported on this device")?;
    let range = Range::from_detail(&detail)
        .ok_or("no capability range reported for the frame limit")?;
    let (enabled, value) = session.io.read_int(session.index, FEATURE_FRAME_LIMIT, "")
        .map_err(|error| error.to_string())?;
    Ok(SleepLimit {
        limit: i64::from(value),
        limiter_enabled: enabled,
        range,
        live_change: detail.FeatureMiscSupport & MISC_FLAG_LIVE_CHANGE != 0,
    })
}

fn open_sleep_session(store: &NativeStore, supplied_key: Option<&str>) -> Result<(DriverSession, Value), Value> {
    let (device_id, target) = sleep_limit_target(store, supplied_key)
        .map_err(sleep_limit_unavailable)?;
    if target.is_null() || target_is_synthetic(&target) {
        return Err(sleep_limit_unavailable("the selected GPU has no IGCL frame limiter"));
    }
    let session = open_session(device_id).map_err(sleep_limit_unavailable)?;
    Ok((session, target))
}

fn log_rebar_diagnostic(line: &str) {
    let Some(appdata) = std::env::var_os("APPDATA") else { return; };
    let path = std::path::PathBuf::from(appdata).join("ArcPower").join("rebar-diagnostic.log");
    let _ = std::fs::write(path, format!("{line}\n"));
}

/// Driver-owned Resizable-BAR verdict for the selected adapter.
///
/// This deliberately opens a plain IGCL session by physical identity rather
/// than reusing the Arc Sleep frame-limit session: that session rejects
/// synthetic targets and requires frame-limit capabilities, neither of which
/// has anything to do with a PCI BAR. That gate was why some real B580s
/// reported gray despite the driver exposing `resizableBarEnabled = true`.
pub(crate) fn rebar_enabled(_store: &NativeStore, supplied_key: Option<&str>) -> Option<bool> {
    let key = supplied_key.filter(|key| !key.trim().is_empty())?;
    let rows = super::gpu_devices::list_devices_merged();
    let row = rows.as_array()
        .and_then(|rows| rows.iter().find(|row| row["deviceKey"].as_str() == Some(key)))?;
    let identity = match super::gpu_apply_identity::identity_from_row(row) {
        Ok(identity) => identity,
        Err(error) => {
            log_rebar_diagnostic(&format!("identity for {key} is unusable: {error}"));
            return None;
        }
    };
    let dll = super::gpu_devices::locate_dll()?;
    let (igcl, index, _device) = match super::gpu_capabilities::open_for_identity(&dll, &identity) {
        Ok(parts) => parts,
        Err(error) => {
            log_rebar_diagnostic(&format!("cannot open IGCL for {key}: {error}"));
            return None;
        }
    };
    let verdict = igcl.rebar_enabled(index);
    log_rebar_diagnostic(&format!("key={key} index={index} verdict={verdict:?}"));
    verdict
}

/// Exact selected-adapter frame-limit read for the Arc Sleep controller.
pub(crate) fn sleep_frame_limit_read(store: &NativeStore, supplied_key: Option<&str>) -> Value {
    let (mut session, target) = match open_sleep_session(store, supplied_key) {
        Ok(parts) => parts,
        Err(reply) => return reply,
    };
    match read_sleep_limit(&mut session) {
        Ok(state) => {
            let mut reply = sleep_limit_json(&target, &state);
            reply["ok"] = json!(true);
            reply["source"] = json!("igcl");
            reply
        }
        Err(error) => sleep_limit_unavailable(error),
    }
}

/// Conditional, verified selected-adapter frame-limit write for Arc Sleep.
/// `op: "restore"` writes the saved `state`; otherwise the request is a cap
/// apply (`enabled`, `value`). Both paths require the exact `expectedState`
/// unless it is absent.
pub(crate) fn sleep_frame_limit_apply(store: &NativeStore, request: &Value) -> Value {
    let restore = request.get("op").and_then(Value::as_str) == Some("restore");
    let (mut session, target) = match open_sleep_session(store, request.get("deviceKey").and_then(Value::as_str)) {
        Ok(parts) => parts,
        Err(reply) => return reply,
    };
    let current = match read_sleep_limit(&mut session) {
        Ok(state) => state,
        Err(error) => return sleep_limit_unavailable(error),
    };
    if let Some(expected) = request.get("expectedState").filter(|value| !value.is_null()).and_then(parse_raw_state) {
        let matches = expected.limit == current.limit
            && expected.limiter_enabled == current.limiter_enabled
            && expected.denominator.is_none_or(|denominator| denominator == 1);
        if !matches {
            return json!({
                "ok": false, "used": false, "conflict": true, "errorCode": "external-change",
                "observedState": sleep_limit_json(&target, &current),
                "error": "The IGCL frame limit changed outside Arc Power",
            });
        }
    }
    let next = if restore {
        match request.get("state").and_then(parse_raw_state) {
            Some(state) => state,
            None => return json!({"ok": false, "used": false, "errorCode": "invalid-state", "error": "A valid frame-limit state is required"}),
        }
    } else {
        let value = request.get("value").and_then(Value::as_f64).unwrap_or(f64::NAN);
        if !value.is_finite() {
            return json!({"ok": false, "used": false, "errorCode": "invalid-argument", "error": "frameLimit must be { enabled: boolean, value: number }"});
        }
        RawState {
            limit: current.range.clamp_snap(value),
            denominator: Some(1),
            limiter_enabled: request.get("enabled").and_then(Value::as_bool) == Some(true),
        }
    };
    if let Err(error) = session.io.write_int(session.index, FEATURE_FRAME_LIMIT, next.limiter_enabled, next.limit as i32, "") {
        let code = match error_code(&error) {
            "permission-denied" => "elevation-required",
            "unsupported" | "invalid-argument" => "unavailable",
            _ => "io-failed",
        };
        return json!({"ok": false, "used": false, "errorCode": code, "error": error.to_string()});
    }
    let observed = match read_sleep_limit(&mut session) {
        Ok(state) => state,
        Err(error) => return json!({"ok": false, "used": false, "errorCode": "unavailable", "error": error}),
    };
    if observed.limit != next.limit || observed.limiter_enabled != next.limiter_enabled {
        return json!({
            "ok": false, "used": false, "errorCode": "io-failed",
            "observedState": sleep_limit_json(&target, &observed),
            "error": "The IGCL frame-limit read-back did not match the requested state",
        });
    }
    json!({"ok": true, "used": true, "source": "igcl", "observedState": sleep_limit_json(&target, &observed)})
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};
    use std::collections::BTreeMap;
    use std::rc::Rc;

    const KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0";
    const ERROR_UNSUPPORTED_STATUS: u32 = 0x4000_000a;

    // -----------------------------------------------------------------------
    // Feature-detail builders (the IGCL layout `int_range` / `enum_supported`
    // decode: enum mask @0, int min/max/step/default @4/8/12/16).
    // -----------------------------------------------------------------------

    fn detail(feature: i32, value_type: i32, value: [u8; 24], per_app: u8, misc: i16) -> ctl_3d_feature_details_t {
        let mut detail: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
        detail.FeatureType = feature;
        detail.ValueType = value_type;
        detail.Value = value;
        detail.PerAppSupport = per_app;
        detail.FeatureMiscSupport = misc;
        detail
    }

    fn int_detail(feature: i32, min: i32, max: i32, step: i32, default: i32) -> ctl_3d_feature_details_t {
        let mut value = [0_u8; 24];
        value[4..8].copy_from_slice(&min.to_le_bytes());
        value[8..12].copy_from_slice(&max.to_le_bytes());
        value[12..16].copy_from_slice(&step.to_le_bytes());
        value[16..20].copy_from_slice(&default.to_le_bytes());
        detail(feature, VALUE_INT32, value, 0, 0)
    }

    fn enum_detail(feature: i32, mask: u64) -> ctl_3d_feature_details_t {
        let mut value = [0_u8; 24];
        value[0..8].copy_from_slice(&mask.to_le_bytes());
        detail(feature, VALUE_ENUM, value, 0, 0)
    }

    fn bool_detail(feature: i32) -> ctl_3d_feature_details_t {
        detail(feature, VALUE_BOOL, [0_u8; 24], 0, 0)
    }

    fn b580_features(allow_list: bool) -> Vec<ctl_3d_feature_details_t> {
        let mut features = vec![
            int_detail(FEATURE_FRAME_LIMIT, 30, 300, 1, 60),
            int_detail(FEATURE_SHARPENING_FILTER, 0, 100, 1, 0),
            enum_detail(FEATURE_GAMING_FLIP_MODES, 63),
            enum_detail(FEATURE_LOW_LATENCY, if allow_list { 3 } else { 7 }),
            enum_detail(FEATURE_FRAME_GENERATION, 0),
            bool_detail(FEATURE_PREBUILT_SHADER_DOWNLOAD),
        ];
        features[0].FeatureMiscSupport = MISC_FLAG_LIVE_CHANGE;
        features
    }

    // -----------------------------------------------------------------------
    // Fakes
    // -----------------------------------------------------------------------

    #[derive(Default)]
    struct FakeState {
        /// `None` models a driver that cannot report the BAR verdict.
        rebar_enabled: Option<bool>,
        /// `None` models a missing `ctlGetSupported3DCapabilities` symbol.
        features: Option<Vec<ctl_3d_feature_details_t>>,
        enums: BTreeMap<i32, u32>,
        ints: BTreeMap<i32, (bool, i32)>,
        bools: BTreeMap<i32, bool>,
        writes: Vec<String>,
        /// When set, every write fails with this IGCL status.
        fail_write: Option<u32>,
        /// When set, reads of this feature fail (the driver refuses the GET).
        read_error: Option<i32>,
        /// When false a write is acknowledged but the stored value is kept.
        write_effect: bool,
    }

    impl FakeState {
        fn new(features: Vec<ctl_3d_feature_details_t>) -> Self {
            Self { features: Some(features), write_effect: true, ..Self::default() }
        }
        fn int(&mut self, feature: i32, enabled: bool, value: i32) -> &mut Self {
            self.ints.insert(feature, (enabled, value));
            self
        }
        fn enm(&mut self, feature: i32, value: u32) -> &mut Self {
            self.enums.insert(feature, value);
            self
        }
        fn boolean(&mut self, feature: i32, value: bool) -> &mut Self {
            self.bools.insert(feature, value);
            self
        }
    }

    struct FakeIo {
        state: Rc<RefCell<FakeState>>,
    }

    impl FakeIo {
        fn write(&self, record: String) -> Result<(), IgclError> {
            let mut state = self.state.borrow_mut();
            state.writes.push(record);
            match state.fail_write {
                Some(status) => Err(IgclError {
                    operation: "ctlGetSet3DFeature",
                    status: Some(status),
                    detail: format!("IGCL status 0x{status:08x}"),
                }),
                None => Ok(()),
            }
        }
    }

    impl GraphicsFeatureIo for FakeIo {
        fn rebar_enabled(&self, _index: usize) -> Option<bool> { self.state.borrow().rebar_enabled }
        fn features(&mut self, _index: usize) -> Result<Vec<ctl_3d_feature_details_t>, IgclError> {
            self.state.borrow().features.clone().ok_or_else(|| IgclError {
                operation: "3d-features",
                status: None,
                detail: "ctlGetSupported3DCapabilities is unavailable".into(),
            })
        }
        fn read_enum(&mut self, _index: usize, feature: i32, _app: &str) -> Result<u32, IgclError> {
            if self.state.borrow().read_error == Some(feature) {
                return Err(IgclError { operation: "ctlGetSet3DFeature", status: None, detail: "read refused".into() });
            }
            Ok(self.state.borrow().enums.get(&feature).copied().unwrap_or(0))
        }
        fn write_enum(&mut self, _index: usize, feature: i32, value: u32, _app: &str) -> Result<(), IgclError> {
            self.write(format!("enum:{feature}={value}"))?;
            if self.state.borrow().write_effect {
                self.state.borrow_mut().enums.insert(feature, value);
            }
            Ok(())
        }
        fn read_int(&mut self, _index: usize, feature: i32, _app: &str) -> Result<(bool, i32), IgclError> {
            if self.state.borrow().read_error == Some(feature) {
                return Err(IgclError { operation: "ctlGetSet3DFeature", status: None, detail: "read refused".into() });
            }
            Ok(self.state.borrow().ints.get(&feature).copied().unwrap_or((false, 0)))
        }
        fn write_int(&mut self, _index: usize, feature: i32, enabled: bool, value: i32, _app: &str) -> Result<(), IgclError> {
            self.write(format!("int:{feature}={value}/{enabled}"))?;
            if self.state.borrow().write_effect {
                self.state.borrow_mut().ints.insert(feature, (enabled, value));
            }
            Ok(())
        }
        fn read_bool(&mut self, _index: usize, feature: i32, _app: &str) -> Result<bool, IgclError> {
            if self.state.borrow().read_error == Some(feature) {
                return Err(IgclError { operation: "ctlGetSet3DFeature", status: None, detail: "read refused".into() });
            }
            Ok(self.state.borrow().bools.get(&feature).copied().unwrap_or(false))
        }
        fn write_bool(&mut self, _index: usize, feature: i32, enabled: bool, _app: &str) -> Result<(), IgclError> {
            self.write(format!("bool:{feature}={enabled}"))?;
            if self.state.borrow().write_effect {
                self.state.borrow_mut().bools.insert(feature, enabled);
            }
            Ok(())
        }
    }

    #[derive(Default)]
    struct FakeFrameLimit {
        read: RefCell<Value>,
        apply: RefCell<Value>,
        restore: RefCell<Value>,
        applied: RefCell<Vec<Value>>,
        restored: RefCell<Vec<Value>>,
    }

    impl FakeFrameLimit {
        fn with_rtss(limit: i64, enabled: bool) -> Self {
            let fake = Self::default();
            *fake.read.borrow_mut() = json!({"ok": true, "limit": limit, "limiterEnabled": enabled});
            *fake.apply.borrow_mut() = json!({"ok": true, "used": true, "restoreToken": {"profile": ""}});
            *fake.restore.borrow_mut() = json!({"ok": true});
            fake
        }
        fn unavailable() -> Self {
            let fake = Self::default();
            *fake.read.borrow_mut() = json!({"ok": false, "error": "RTSS is unavailable"});
            *fake.apply.borrow_mut() = json!({"ok": false, "used": false, "fallback": true});
            *fake.restore.borrow_mut() = json!({"ok": true});
            fake
        }
        fn applied(&self) -> Vec<Value> {
            self.applied.borrow().clone()
        }
        fn restored(&self) -> usize {
            self.restored.borrow().len()
        }
    }

    impl FrameLimitIo for FakeFrameLimit {
        fn read(&self) -> Value {
            self.read.borrow().clone()
        }
        fn apply(&self, options: &Value) -> Value {
            self.applied.borrow_mut().push(options.clone());
            self.apply.borrow().clone()
        }
        fn restore(&self, token: &Value) -> Value {
            self.restored.borrow_mut().push(token.clone());
            self.restore.borrow().clone()
        }
    }

    #[derive(Default)]
    struct FakeRegistry {
        values: RefCell<BTreeMap<String, u32>>,
        writes: RefCell<usize>,
        fault: RefCell<Option<shared_memory_override::RegistryFault>>,
    }

    impl FakeRegistry {
        fn with_max(max: u32) -> Self {
            let registry = Self::default();
            registry.values.borrow_mut().insert(
                shared_memory_override::SHARED_MEMORY_OVERRIDE_MAX_VALUE.to_owned(),
                max,
            );
            registry
        }
        fn writes(&self) -> usize {
            *self.writes.borrow()
        }
    }

    impl RegistryAccess for FakeRegistry {
        fn query_dword(&self, value_name: &str) -> Result<Option<u32>, shared_memory_override::RegistryFault> {
            if let Some(fault) = *self.fault.borrow() {
                return Err(fault);
            }
            Ok(self.values.borrow().get(value_name).copied())
        }
        fn set_dword(&self, value_name: &str, value: u32) -> Result<(), shared_memory_override::RegistryFault> {
            if let Some(fault) = *self.fault.borrow() {
                return Err(fault);
            }
            *self.writes.borrow_mut() += 1;
            self.values.borrow_mut().insert(value_name.to_owned(), value);
            Ok(())
        }
        fn delete_dword(&self, value_name: &str) -> Result<(), shared_memory_override::RegistryFault> {
            if let Some(fault) = *self.fault.borrow() {
                return Err(fault);
            }
            *self.writes.borrow_mut() += 1;
            self.values.borrow_mut().remove(value_name);
            Ok(())
        }
    }

    fn b580_device() -> Value {
        json!({
            "id": 0, "name": "Intel(R) Arc(TM) B580 Graphics",
            "pciVendorId": "0x00008086", "pciDeviceId": "0x0000e20b",
            "integrated": false, "mobile": false, "deviceKey": KEY,
        })
    }

    fn mobile_device() -> Value {
        json!({
            "id": 0, "name": "Intel(R) Arc(TM) B390 Graphics",
            "pciVendorId": "0x00008086", "pciDeviceId": "0x0000e20b",
            "integrated": true, "mobile": true, "deviceKey": KEY,
        })
    }

    fn settings() -> Value {
        json!({
            "deviceId": 0,
            "deviceKey": KEY,
            "arcSleep": {"idleEnabled": false, "adaptiveEnabled": false},
            "arcSleepFrameLimitBase": Value::Null,
            "arcSleepJournal": Value::Null,
            "arcSleepPendingBaseDisable": false,
        })
    }

    fn open_closure(
        state: Rc<RefCell<FakeState>>,
        opens: Rc<Cell<usize>>,
        device: Value,
    ) -> impl Fn(u64) -> Result<DriverSession, String> {
        move |id| {
            opens.set(opens.get() + 1);
            Ok(DriverSession {
                io: Box::new(FakeIo { state: state.clone() }),
                index: id as usize,
                device: device.clone(),
            })
        }
    }

    struct Env {
        state: Rc<RefCell<FakeState>>,
        opens: Rc<Cell<usize>>,
        device: Value,
    }

    impl Env {
        fn new(features: Vec<ctl_3d_feature_details_t>) -> Self {
            Self { state: Rc::new(RefCell::new(FakeState::new(features))), opens: Rc::new(Cell::new(0)), device: b580_device() }
        }
        fn mobile(features: Vec<ctl_3d_feature_details_t>) -> Self {
            Self { device: mobile_device(), ..Self::new(features) }
        }
        fn writes(&self) -> Vec<String> {
            self.state.borrow().writes.clone()
        }
        fn opens(&self) -> usize {
            self.opens.get()
        }
    }

    fn runtime<'a>(
        env: &'a Env,
        settings: Value,
        frame_limit: &'a FakeFrameLimit,
        registry: &'a FakeRegistry,
        open: &'a dyn Fn(u64) -> Result<DriverSession, String>,
    ) -> Runtime<'a> {
        Runtime {
            devices: vec![env.device.clone()],
            settings,
            open,
            frame_limit,
            shared_memory: registry,
        }
    }

    fn get_state(env: &Env, settings: Value, frame_limit: &FakeFrameLimit, registry: &FakeRegistry) -> Value {
        let open = open_closure(env.state.clone(), env.opens.clone(), env.device.clone());
        let runtime = runtime(env, settings, frame_limit, registry, &open);
        get_with(&runtime, 0, None).unwrap().expect("the gate must not delegate")
    }

    fn apply_payload(
        env: &Env,
        settings: Value,
        payload: Value,
        frame_limit: &FakeFrameLimit,
        registry: &FakeRegistry,
    ) -> Option<Value> {
        let open = open_closure(env.state.clone(), env.opens.clone(), env.device.clone());
        let runtime = runtime(env, settings, frame_limit, registry, &open);
        apply_with(&runtime, 0, &payload, None, None, None).unwrap()
    }

    // -----------------------------------------------------------------------
    // Sanitizer
    // -----------------------------------------------------------------------

    #[test]
    fn sanitizer_matches_the_electron_validator() {
        assert_eq!(
            sanitize_graphics_settings(&json!([1]), None).unwrap_err(),
            "graphics-settings payload must be a plain object"
        );
        assert_eq!(
            sanitize_graphics_settings(&json!({"nope": 1}), None).unwrap_err(),
            "unknown graphics setting: nope"
        );
        assert_eq!(
            sanitize_graphics_settings(&json!({"enduranceGaming": "maybe"}), None).unwrap_err(),
            "enduranceGaming must be one of: off, on, auto"
        );
        assert_eq!(
            sanitize_graphics_settings(&json!({"flipMode": "on"}), None).unwrap_err(),
            "flipMode must be one of: application-default, vsync-on, vsync-off, smooth-sync, speed-frame, smart-vsync"
        );
        assert_eq!(
            sanitize_graphics_settings(&json!({"sharedMemoryOverride": {"enabled": true, "percentage": 12}}), None).unwrap_err(),
            "sharedMemoryOverride must be { enabled: boolean, percentage: integer 13-100 }"
        );
        assert_eq!(
            sanitize_graphics_settings(&json!({"sharpening": {"enabled": true, "percentage": 101}}), None).unwrap_err(),
            "sharpening must be { enabled: boolean, percentage: integer 0-100 }"
        );
        assert_eq!(
            sanitize_graphics_settings(&json!({"frameLimit": {"enabled": true, "value": "60"}}), None).unwrap_err(),
            "frameLimit must be { enabled: boolean, value: number }"
        );
        assert_eq!(
            sanitize_graphics_settings(&json!({"frameLimit": {"enabled": true}}), None).unwrap_err(),
            "frameLimit must be { enabled: boolean, value: number }"
        );
    }

    #[test]
    fn sanitizer_clamps_to_the_supplied_range_and_falls_back_without_one() {
        // The driver range clamps a 1000 request to 300.
        let driver = sanitize_graphics_settings(
            &json!({"frameLimit": {"enabled": true, "value": 1000}}),
            Some(Range { min: 30, max: 300, step: 1, default: 60 }),
        )
        .unwrap();
        assert_eq!(driver, json!({"frameLimit": {"enabled": true, "value": 300}}));
        // The RTSS range accepts 1000.
        let rtss = sanitize_graphics_settings(
            &json!({"frameLimit": {"enabled": true, "value": 1000}}),
            Some(RTSS_FRAME_LIMIT_RANGE),
        )
        .unwrap();
        assert_eq!(rtss, json!({"frameLimit": {"enabled": true, "value": 1000}}));
        // No range: the probe-recorded fallback applies.
        let fallback = sanitize_graphics_settings(&json!({"frameLimit": {"enabled": true, "value": 5}}), None).unwrap();
        assert_eq!(fallback["frameLimit"]["value"], json!(30));
    }

    // -----------------------------------------------------------------------
    // Target resolution
    // -----------------------------------------------------------------------

    #[test]
    fn expected_device_key_requires_a_stable_selected_identity() {
        assert_eq!(
            expected_device_key(&json!({}), 0, None).unwrap_err(),
            "stale GPU target: a stable selected device identity is required"
        );
        assert_eq!(
            expected_device_key(&json!({"deviceKey": KEY, "deviceId": 1}), 0, None).unwrap_err(),
            format!("stale GPU target: selected device identity {KEY} does not match requested device id 0")
        );
        assert_eq!(
            expected_device_key(&json!({"deviceKey": KEY}), 0, None).unwrap_err(),
            "stale GPU target: the saved device identity has no associated device id"
        );
        assert_eq!(expected_device_key(&json!({"deviceKey": KEY, "deviceId": 0}), 0, None).unwrap(), Some(KEY.into()));
        assert_eq!(expected_device_key(&json!({}), 0, Some(KEY)).unwrap(), Some(KEY.into()));
        assert_eq!(
            expected_device_key(&json!({}), 0, Some("   ")).unwrap_err(),
            "invalid GPU target: expected device key must be a nonempty string"
        );
    }

    #[test]
    fn resolve_selected_reports_missing_and_ambiguous_identities() {
        let row = b580_device();
        assert_eq!(resolve_selected(&[row.clone()], 0, Some(KEY)).unwrap().id, 0);
        assert_eq!(
            resolve_selected(&[row.clone()], 0, Some("pci:other")).unwrap_err(),
            "stale GPU target: selected device identity pci:other is missing"
        );
        let mut alias = row.clone();
        alias["id"] = json!(1);
        assert_eq!(
            resolve_selected(&[row.clone(), alias.clone()], 0, Some(KEY)).unwrap_err(),
            format!("stale GPU target: selected device identity {KEY} is ambiguous")
        );
        let mut ambiguous = row.clone();
        ambiguous["identityAmbiguous"] = json!(true);
        assert_eq!(
            resolve_selected(&[ambiguous], 0, Some(KEY)).unwrap_err(),
            format!("stale GPU target: selected device identity {KEY} is missing")
        );
        // No expected key: the ordinal is used verbatim.
        assert_eq!(resolve_selected(&[row], 0, None).unwrap().target["name"], json!("Intel(R) Arc(TM) B580 Graphics"));
    }

    #[test]
    fn get_rejects_a_stale_expected_key_before_reading_the_driver() {
        let env = Env::new(b580_features(true));
        let frame_limit = FakeFrameLimit::with_rtss(60, true);
        let registry = FakeRegistry::with_max(100);
        let open = open_closure(env.state.clone(), env.opens.clone(), env.device.clone());
        let runtime = runtime(&env, settings(), &frame_limit, &registry, &open);
        assert_eq!(
            get_with(&runtime, 0, Some("pci:stale")).unwrap_err(),
            "stale GPU target: selected device identity pci:stale is missing"
        );
        assert_eq!(env.opens(), 0);
    }

    // -----------------------------------------------------------------------
    // Read
    // -----------------------------------------------------------------------

    #[test]
    fn full_b580_state_matches_the_electron_shape() {
        let env = Env::new(b580_features(true));
        {
            let mut state = env.state.borrow_mut();
            state.enm(FEATURE_FRAME_GENERATION, 2)
                .enm(FEATURE_GAMING_FLIP_MODES, 4)
                .enm(FEATURE_LOW_LATENCY, 2)
                .int(FEATURE_FRAME_LIMIT, true, 144)
                .int(FEATURE_SHARPENING_FILTER, true, 55)
                .boolean(FEATURE_PREBUILT_SHADER_DOWNLOAD, true);
        }
        let frame_limit = FakeFrameLimit::with_rtss(120, true);
        let registry = FakeRegistry::with_max(100);
        let state = get_state(&env, settings(), &frame_limit, &registry);

        assert_eq!(state["supported"]["frameGen"], json!(true));
        assert_eq!(state["supported"]["flipModes"], json!(true));
        assert_eq!(state["supported"]["frameLimit"], json!(true));
        assert_eq!(state["supported"]["lowLatency"], json!(true));
        assert_eq!(state["supported"]["prebuiltShaderDownload"], json!(true));
        assert_eq!(state["supported"]["sharpening"], json!(true));
        assert_eq!(state["supportedOptions"]["frameGen"], json!(["app-choice", "2x", "3x", "4x"]));
        assert_eq!(
            state["supportedOptions"]["flipModes"],
            json!(["application-default", "smart-vsync", "vsync-off", "vsync-on", "smooth-sync", "speed-frame"])
        );
        assert_eq!(state["supportedOptions"]["lowLatency"], json!(["off", "on"]));
        assert_eq!(state["frameLimitRange"], json!({"min": 1, "max": 1000, "step": 1, "default": 60}));
        assert_eq!(state["frameLimitSource"], json!("rtss"));
        assert_eq!(state["frameLimitLiveChange"], json!(true));
        assert_eq!(state["values"]["frameLimit"], json!({"enabled": true, "value": 120}));
        assert_eq!(state["values"]["frameGenOverride"], json!("3x"));
        assert_eq!(state["values"]["flipMode"], json!("vsync-on"));
        assert_eq!(state["values"]["lowLatency"], json!("on-boost"));
        assert_eq!(state["values"]["prebuiltShaderDownload"], json!(true));
        assert_eq!(state["values"]["sharpening"], json!({"enabled": true, "percentage": 55}));
        assert_eq!(state["sharpeningRange"], json!({"min": 0, "max": 100, "step": 1, "default": 0}));
        assert_eq!(state["sharpeningReason"], Value::Null);
        assert_eq!(state["sharpeningPerAppSupport"], json!(false));
        assert_eq!(state["sharpeningLiveChange"], json!(false));
        // Discrete Arc: no endurance or shared-memory surface.
        assert_eq!(state["supported"].get("enduranceGaming"), None);
        assert_eq!(state["supported"].get("sharedMemoryOverride"), None);
    }

    #[test]
    fn degraded_capabilities_return_the_honest_all_false_surface() {
        let env = Env::new(Vec::new());
        {
            let mut state = env.state.borrow_mut();
            state.features = None;
            // The caps symbol is missing and the generic Endurance GET is
            // refused, so the eligible mobile adapter probes and degrades.
            state.read_error = Some(FEATURE_ENDURANCE_GAMING);
        }
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        // A mobile device still exposes the shared-memory registry control even
        // when the 3D symbols are missing.
        let mobile = Env { device: mobile_device(), ..env };
        let state = get_state(&mobile, settings(), &frame_limit, &registry);
        assert_eq!(
            state["supported"],
            json!({"frameGen": false, "flipModes": false, "frameLimit": false, "lowLatency": false,
                "enduranceGaming": false, "sharedMemoryOverride": true})
        );
        assert_eq!(state["frameLimitSource"], json!("igcl"));
        assert_eq!(state["values"]["frameGenOverride"], Value::Null);
        assert_eq!(state["values"]["frameLimit"], Value::Null);
        assert_eq!(state["values"]["sharpening"], Value::Null);
        assert_eq!(state["sharpeningReason"], json!(SHARPENING_UNAVAILABLE));
        assert_eq!(state["frameLimitRange"], Value::Null);
        assert_eq!(state["sharedMemoryRange"], json!({"min": 13, "max": 100, "step": 1, "default": 57}));
        assert_eq!(state["values"]["sharedMemoryOverride"], json!({"enabled": false, "percentage": 57}));
        assert_eq!(mobile.state.borrow().writes, Vec::<String>::new());
    }

    #[test]
    fn endurance_enum_abi_reports_controls_and_current_value() {
        let mut features = b580_features(false);
        features.push(enum_detail(FEATURE_ENDURANCE_GAMING, 3));
        let env = Env::mobile(features);
        env.state.borrow_mut().enm(FEATURE_ENDURANCE_GAMING, 2);
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let state = get_state(&env, settings(), &frame_limit, &registry);
        assert_eq!(state["supported"]["enduranceGaming"], json!(true));
        assert_eq!(state["supportedOptions"]["enduranceGaming"], json!(["off", "on"]));
        assert_eq!(state["supportedOptions"]["enduranceGamingModes"], json!([]));
        assert_eq!(state["values"]["enduranceGaming"], json!("auto"));
        assert_eq!(state["values"]["enduranceGamingMode"], Value::Null);
    }

    #[test]
    fn endurance_integer_abi_reports_the_fps_presets() {
        let mut features = b580_features(false);
        features.push(int_detail(FEATURE_ENDURANCE_GAMING, 30, 60, 1, 60));
        let env = Env::mobile(features);
        env.state.borrow_mut().int(FEATURE_ENDURANCE_GAMING, true, 40);
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let state = get_state(&env, settings(), &frame_limit, &registry);
        assert_eq!(state["supportedOptions"]["enduranceGaming"], json!(["off", "on"]));
        assert_eq!(state["supportedOptions"]["enduranceGamingModes"], json!(["performance", "balanced", "battery"]));
        assert_eq!(state["values"]["enduranceGaming"], json!("on"));
        assert_eq!(state["values"]["enduranceGamingMode"], json!("balanced"));
    }

    #[test]
    fn endurance_probe_recovers_a_feature_the_caps_table_omits() {
        // The caps table has no feature 1, but the driver answers the generic
        // INT32 GET: the eligible mobile adapter keeps the control.
        let env = Env::mobile(b580_features(false));
        env.state.borrow_mut().int(FEATURE_ENDURANCE_GAMING, true, 60);
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let state = get_state(&env, settings(), &frame_limit, &registry);
        assert_eq!(state["supported"]["enduranceGaming"], json!(true));
        assert_eq!(state["supportedOptions"]["enduranceGamingModes"], json!(["performance", "balanced", "battery"]));
        assert_eq!(state["values"]["enduranceGaming"], json!("on"));
        assert_eq!(state["values"]["enduranceGamingMode"], json!("performance"));
        // A discrete adapter never probes.
        let discrete = Env::new(b580_features(false));
        let state = get_state(&discrete, settings(), &frame_limit, &registry);
        assert_eq!(state["supported"].get("enduranceGaming"), None);
    }

    #[test]
    fn prebuilt_shader_download_requires_battlemage_identity() {
        let env = Env::new(b580_features(false));
        env.state.borrow_mut().boolean(FEATURE_PREBUILT_SHADER_DOWNLOAD, true);
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let state = get_state(&env, settings(), &frame_limit, &registry);
        assert_eq!(state["supported"]["prebuiltShaderDownload"], json!(true));
        assert_eq!(state["values"]["prebuiltShaderDownload"], json!(true));

        let mut alchemist = Env::new(b580_features(false));
        alchemist.device["name"] = json!("Intel(R) Arc(TM) A770 Graphics");
        alchemist.device["pciDeviceId"] = json!("0x000056a0");
        let state = get_state(&alchemist, settings(), &frame_limit, &registry);
        assert_eq!(state["supported"].get("prebuiltShaderDownload"), None);
        assert_eq!(state["values"].get("prebuiltShaderDownload"), None);
    }

    #[test]
    fn shared_memory_is_read_for_mobile_only() {
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        registry.values.borrow_mut().insert(
            shared_memory_override::SHARED_MEMORY_OVERRIDE_VALUE.to_owned(),
            64,
        );
        let mobile = Env::mobile(b580_features(false));
        let state = get_state(&mobile, settings(), &frame_limit, &registry);
        assert_eq!(state["values"]["sharedMemoryOverride"], json!({"enabled": true, "percentage": 64}));
        assert_eq!(state["sharedMemoryRange"], json!({"min": 13, "max": 100, "step": 1, "default": 57}));

        let discrete = Env::new(b580_features(false));
        let state = get_state(&discrete, settings(), &frame_limit, &registry);
        assert_eq!(state["supported"].get("sharedMemoryOverride"), None);
        assert_eq!(state.get("sharedMemoryRange"), None);
    }

    #[test]
    fn rtss_decoration_replaces_the_driver_frame_limit() {
        let env = Env::new(b580_features(false));
        env.state.borrow_mut().int(FEATURE_FRAME_LIMIT, true, 144);
        let registry = FakeRegistry::with_max(100);

        // RTSS reports a global 90 limit.
        let rtss = FakeFrameLimit::with_rtss(90, true);
        let state = get_state(&env, settings(), &rtss, &registry);
        assert_eq!(state["frameLimitSource"], json!("rtss"));
        assert_eq!(state["supported"]["frameLimit"], json!(true));
        assert_eq!(state["values"]["frameLimit"], json!({"enabled": true, "value": 90}));

        // A disabled limiter reports the fallback value with enabled=false.
        let disabled = FakeFrameLimit::with_rtss(90, false);
        let state = get_state(&env, settings(), &disabled, &registry);
        assert_eq!(state["values"]["frameLimit"], json!({"enabled": false, "value": 90}));

        // A missing read keeps the IGCL surface and the driver value.
        let unavailable = FakeFrameLimit::unavailable();
        let state = get_state(&env, settings(), &unavailable, &registry);
        assert_eq!(state["frameLimitSource"], json!("igcl"));
        assert_eq!(state["values"]["frameLimit"], json!({"enabled": true, "value": 144}));
        assert_eq!(state["frameLimitRange"], json!({"min": 30, "max": 300, "step": 1, "default": 60}));
    }

    #[test]
    fn a_disabled_arc_sleep_base_cap_zeroes_the_rtss_read() {
        let env = Env::new(b580_features(false));
        let rtss = FakeFrameLimit::with_rtss(90, true);
        let registry = FakeRegistry::with_max(100);
        let mut settings = settings();
        settings["arcSleepFrameLimitBase"] = json!({"enabled": false, "value": 75});
        let state = get_state(&env, settings, &rtss, &registry);
        assert_eq!(state["frameLimitSource"], json!("rtss"));
        assert_eq!(state["values"]["frameLimit"], json!({"enabled": false, "value": 60}));
        // The reported range still comes from RTSS.
        assert_eq!(state["frameLimitRange"], json!({"min": 1, "max": 1000, "step": 1, "default": 60}));
    }

    // -----------------------------------------------------------------------
    // Apply
    // -----------------------------------------------------------------------

    #[test]
    fn apply_every_control_writes_then_reads_back() {
        let mut features = b580_features(true);
        features.push(int_detail(FEATURE_ENDURANCE_GAMING, 30, 60, 1, 60));
        let env = Env::mobile(features);
        env.state.borrow_mut().int(FEATURE_ENDURANCE_GAMING, false, 30);
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let payload = json!({
            "enduranceGaming": "on",
            "enduranceGamingMode": "balanced",
            "sharedMemoryOverride": {"enabled": true, "percentage": 60},
            "frameGenOverride": "3x",
            "flipMode": "smooth-sync",
            "lowLatency": "on-boost",
            "prebuiltShaderDownload": true,
            "sharpening": {"enabled": true, "percentage": 40},
        });
        let reply = apply_payload(&env, settings(), payload, &frame_limit, &registry).expect("must not delegate");
        assert_eq!(reply["ok"], json!(true), "{reply}");
        for control in [
            "enduranceGaming", "enduranceGamingMode", "sharedMemoryOverride", "frameGenOverride",
            "flipMode", "lowLatency", "prebuiltShaderDownload", "sharpening",
        ] {
            assert_eq!(reply["perControl"][control]["ok"], json!(true), "{control}: {reply}");
        }
        assert_eq!(reply["perControl"]["sharedMemoryOverride"]["warning"],
            json!(shared_memory_override::SHARED_MEMORY_RESTART_WARNING));
        {
            let state = env.state.borrow();
            assert!(state.writes.iter().any(|write| write == "enum:17=2"), "{:?}", state.writes);
            assert!(state.writes.iter().any(|write| write == "enum:9=8"), "{:?}", state.writes);
            assert!(state.writes.iter().any(|write| write == "enum:16=2"), "{:?}", state.writes);
            assert!(state.writes.iter().any(|write| write == "int:7=40/true"), "{:?}", state.writes);
            assert!(state.writes.iter().any(|write| write == "bool:18=true"), "{:?}", state.writes);
            assert!(state.writes.iter().any(|write| write == "int:1=40/true"), "{:?}", state.writes);
            assert_eq!(state.enums.get(&FEATURE_FRAME_GENERATION), Some(&2));
            assert_eq!(state.ints.get(&FEATURE_SHARPENING_FILTER), Some(&(true, 40)));
        }
        assert_eq!(registry.values.borrow()[shared_memory_override::SHARED_MEMORY_OVERRIDE_VALUE], 60);
        assert_eq!(reply["graphicsState"]["values"]["sharpening"], json!({"enabled": true, "percentage": 40}));
    }

    #[test]
    fn apply_reports_a_read_back_mismatch_without_claiming_success() {
        let env = Env::new(b580_features(false));
        env.state.borrow_mut().write_effect = false;
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let reply = apply_payload(
            &env,
            settings(),
            json!({"flipMode": "vsync-on"}),
            &frame_limit,
            &registry,
        )
        .expect("must not delegate");
        assert_eq!(reply["ok"], json!(false));
        assert_eq!(reply["perControl"]["flipMode"]["ok"], json!(false));
        assert_eq!(reply["perControl"]["flipMode"]["errorCode"], json!("io-failed"));
        assert_eq!(reply["perControl"]["flipMode"]["readBackEqual"], json!(false));
        assert_eq!(reply["perControl"]["flipMode"]["silentNoop"], json!(true));
    }

    #[test]
    fn apply_maps_igcl_refusals_to_canonical_error_codes() {
        for (status, code) in [
            (ERROR_UNSUPPORTED_STATUS, "unsupported"),
            (0x4000_000b, "invalid-argument"),
            (0x4000_0006, "permission-denied"),
            (0x6000_0001, "io-failed"),
        ] {
            let env = Env::new(b580_features(false));
            env.state.borrow_mut().fail_write = Some(status);
            let frame_limit = FakeFrameLimit::unavailable();
            let registry = FakeRegistry::with_max(100);
            let reply = apply_payload(
                &env,
                settings(),
                json!({"lowLatency": "on"}),
                &frame_limit,
                &registry,
            )
            .expect("must not delegate");
            assert_eq!(reply["ok"], json!(false));
            assert_eq!(reply["perControl"]["lowLatency"]["errorCode"], json!(code), "status 0x{status:08x}");
        }
    }

    #[test]
    fn apply_refuses_a_present_control_the_driver_does_not_report() {
        let env = Env::new(vec![enum_detail(FEATURE_LOW_LATENCY, 7)]);
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let reply = apply_payload(
            &env,
            settings(),
            json!({"frameGenOverride": "2x", "flipMode": "vsync-off"}),
            &frame_limit,
            &registry,
        )
        .expect("must not delegate");
        assert_eq!(reply["perControl"]["frameGenOverride"]["errorCode"], json!("unsupported"));
        assert_eq!(reply["perControl"]["flipMode"]["errorCode"], json!("unsupported"));
        assert_eq!(env.writes(), Vec::<String>::new());
    }

    #[test]
    fn apply_reports_unavailable_symbol_when_the_3d_surface_is_missing() {
        let env = Env::new(Vec::new());
        env.state.borrow_mut().features = None;
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let reply = apply_payload(
            &env,
            settings(),
            json!({"flipMode": "vsync-on", "sharpening": {"enabled": true, "percentage": 10}}),
            &frame_limit,
            &registry,
        )
        .expect("must not delegate");
        assert_eq!(reply["ok"], json!(false));
        assert_eq!(reply["perControl"]["flipMode"]["errorCode"], json!("unavailable-symbol"));
        // Sharpening is a 3D control too: with no caps table it is unsupported.
        assert_eq!(reply["perControl"]["sharpening"]["errorCode"], json!("unsupported"));
        assert_eq!(env.writes(), Vec::<String>::new());
    }

    #[test]
    fn apply_rejects_synthetic_targets_without_touching_the_driver() {
        let mut env = Env::new(b580_features(false));
        env.device = json!({"id": 0, "name": "NVIDIA GeForce RTX 4090", "synthetic": true,
            "backendKind": "os", "deviceKey": KEY});
        let frame_limit = FakeFrameLimit::with_rtss(60, true);
        let registry = FakeRegistry::with_max(100);
        let reply = apply_payload(
            &env,
            settings(),
            json!({"flipMode": "vsync-on", "frameLimit": {"enabled": true, "value": 60}}),
            &frame_limit,
            &registry,
        )
        .expect("must not delegate");
        assert_eq!(reply["ok"], json!(false));
        assert_eq!(reply["perControl"]["flipMode"]["errorCode"], json!("unsupported"));
        assert_eq!(reply["perControl"]["frameLimit"]["errorCode"], json!("unsupported"));
        assert_eq!(reply["perControl"]["flipMode"]["message"], json!("graphics features are not supported on this GPU"));
        assert_eq!(env.opens(), 0);
        assert_eq!(env.writes(), Vec::<String>::new());
        // Synthetic applies never touch RTSS either.
        assert!(frame_limit.applied().is_empty());
        assert_eq!(reply["graphicsState"]["frameLimitSource"], json!("igcl"));
    }

    #[test]
    fn apply_frame_limit_prefers_rtss_and_skips_the_driver_write() {
        let env = Env::new(b580_features(false));
        let frame_limit = FakeFrameLimit::with_rtss(90, true);
        let registry = FakeRegistry::with_max(100);
        let reply = apply_payload(
            &env,
            settings(),
            json!({"frameLimit": {"enabled": true, "value": 120}}),
            &frame_limit,
            &registry,
        )
        .expect("must not delegate");
        assert_eq!(reply["ok"], json!(true), "{reply}");
        assert_eq!(reply["perControl"]["frameLimit"], json!({"ok": true, "source": "rtss"}));
        assert_eq!(frame_limit.applied(), vec![json!({"enabled": true, "value": 120})]);
        assert!(!env.writes().iter().any(|write| write.starts_with("int:2=")), "{:?}", env.writes());
        assert_eq!(frame_limit.restored(), 0);
    }

    #[test]
    fn apply_frame_limit_falls_back_to_the_driver_when_rtss_refuses() {
        let env = Env::new(b580_features(false));
        let frame_limit = FakeFrameLimit::unavailable();
        let registry = FakeRegistry::with_max(100);
        let reply = apply_payload(
            &env,
            settings(),
            json!({"frameLimit": {"enabled": true, "value": 90}}),
            &frame_limit,
            &registry,
        )
        .expect("must not delegate");
        assert_eq!(reply["ok"], json!(true), "{reply}");
        assert_eq!(reply["perControl"]["frameLimit"]["ok"], json!(true));
        assert_eq!(reply["perControl"]["frameLimit"].get("source"), None);
        assert!(env.writes().iter().any(|write| write == "int:2=90/true"), "{:?}", env.writes());
        // The re-clamped driver value is used (RTSS' wider range is ignored).
        assert_eq!(reply["graphicsState"]["frameLimitSource"], json!("igcl"));
    }

    #[test]
    fn apply_frame_limit_rolls_back_when_another_control_fails() {
        let env = Env::new(b580_features(false));
        // The driver accepts the sharpening write but never stores it, so the
        // apply fails after RTSS already holds the new limit.
        env.state.borrow_mut().write_effect = false;
        let frame_limit = FakeFrameLimit::with_rtss(90, true);
        let registry = FakeRegistry::with_max(100);
        let reply = apply_payload(
            &env,
            settings(),
            json!({"frameLimit": {"enabled": true, "value": 120}, "sharpening": {"enabled": true, "percentage": 40}}),
            &frame_limit,
            &registry,
        )
        .expect("must not delegate");
        assert_eq!(reply["ok"], json!(false));
        assert_eq!(reply["perControl"]["frameLimit"]["errorCode"], json!("rolled-back"));
        assert_eq!(
            reply["perControl"]["frameLimit"]["message"],
            json!("The FPS limit was rolled back because another graphics setting failed")
        );
        assert_eq!(frame_limit.restored(), 1);
    }

    #[test]
    fn a_failed_rtss_restore_is_cleanup_pending_and_never_falls_back_to_igcl() {
        let env = Env::new(b580_features(false));
        env.state.borrow_mut().write_effect = false;
        let frame_limit = FakeFrameLimit::with_rtss(90, true);
        *frame_limit.restore.borrow_mut() = json!({"ok": false, "error": "RTSS profile changed outside Arc Power"});
        let registry = FakeRegistry::with_max(100);
        let reply = apply_payload(
            &env,
            settings(),
            json!({"frameLimit": {"enabled": true, "value": 120}, "sharpening": {"enabled": true, "percentage": 40}}),
            &frame_limit,
            &registry,
        )
        .expect("must not delegate");
        assert_eq!(reply["ok"], json!(false));
        assert_eq!(reply["perControl"]["frameLimit"]["errorCode"], json!("cleanup-pending"));
        assert_eq!(
            reply["perControl"]["frameLimit"]["message"],
            json!("FPS limit rollback failed: RTSS profile changed outside Arc Power")
        );
        // Cleanup-pending must never be papered over with an IGCL frame-limit write.
        assert!(!env.writes().iter().any(|write| write.starts_with("int:2=")), "{:?}", env.writes());
    }

    #[test]
    fn apply_frame_limit_is_delegated_when_the_arc_sleep_base_has_no_owner() {
        let env = Env::new(b580_features(false));
        let frame_limit = FakeFrameLimit::with_rtss(90, true);
        let registry = FakeRegistry::with_max(100);
        let mut owned = settings();
        owned["arcSleepFrameLimitBase"] = json!({"enabled": false, "value": 75});
        let called = Cell::new(false);
        let open = |_id: u64| -> Result<DriverSession, String> {
            called.set(true);
            Err("must not open".into())
        };
        let runtime = runtime(&env, owned, &frame_limit, &registry, &open);
        let reply = apply_with(&runtime, 0, &json!({"frameLimit": {"enabled": true, "value": 60}}), None, None, None).unwrap();
        assert!(reply.is_none(), "without the controller the persisted base cap must delegate");
        assert!(!called.get());
        assert!(frame_limit.applied().is_empty());
    }

    /// Records the Base Cap calls a Graphics apply routes through the owner.
    #[derive(Default)]
    struct FakeOwner {
        calls: RefCell<Vec<(Value, Option<String>)>>,
        rollbacks: Cell<usize>,
    }

    impl FakeOwner {
        fn reply(&self) -> Value {
            json!({"handled": true, "ok": true, "source": "rtss", "frameLimit": {"enabled": true, "value": 60}})
        }
    }

    impl FrameLimitOwner for FakeOwner {
        fn set_base_frame_limit(&mut self, limit: &Value, device_key: Option<&str>) -> Value {
            self.calls.borrow_mut().push((limit.clone(), device_key.map(str::to_owned)));
            self.reply()
        }
        fn rollback(&mut self) -> Value {
            self.rollbacks.set(self.rollbacks.get() + 1);
            json!({"ok": true})
        }
    }

    #[test]
    fn the_base_cap_is_written_only_through_the_arc_sleep_owner() {
        let env = Env::new(b580_features(false));
        let frame_limit = FakeFrameLimit::with_rtss(90, true);
        let registry = FakeRegistry::with_max(100);
        let mut settings = settings();
        settings["arcSleepFrameLimitBase"] = json!({"enabled": true, "value": 75});
        let open = open_closure(env.state.clone(), env.opens.clone(), env.device.clone());
        let runtime = runtime(&env, settings, &frame_limit, &registry, &open);
        let mut owner = FakeOwner::default();
        let reply = apply_with(&runtime, 0, &json!({"frameLimit": {"enabled": true, "value": 60}}), None,
            Some(&mut owner), None).unwrap().expect("the controller owns the base cap natively");
        assert_eq!(reply["ok"], json!(true));
        assert_eq!(reply["perControl"]["frameLimit"], json!({"ok": true, "source": "rtss"}));
        assert_eq!(owner.calls.borrow().len(), 1);
        assert_eq!(owner.calls.borrow()[0], (json!({"enabled": true, "value": 60}), Some(KEY.to_owned())));
        // The owner is the only writer: no direct RTSS or IGCL frame-limit write.
        assert!(frame_limit.applied().is_empty());
        assert!(!env.writes().iter().any(|write| write.starts_with("int:2=")), "{:?}", env.writes());
        assert_eq!(owner.rollbacks.get(), 0);
    }

    // -----------------------------------------------------------------------
    // Arc Sleep gate
    // -----------------------------------------------------------------------

    #[test]
    fn the_narrowed_gate_owns_the_states_arc_sleep_can_prove() {
        let journal = json!({
            "version": 1,
            "baseline": {"limit": 60, "denominator": 1, "limiterEnabled": true},
            "underlay": {"limit": 60, "denominator": 1, "limiterEnabled": true},
            "expected": {"limit": 90, "denominator": 1, "limiterEnabled": true},
            "route": {"source": "rtss"},
            "pending": null,
        });
        let native = [
            ("unowned", json!({})),
            ("enabled base", json!({"arcSleepFrameLimitBase": {"enabled": true, "value": 75}})),
            ("disabled base", json!({"arcSleepFrameLimitBase": {"enabled": false, "value": 75}})),
            ("idle", json!({"arcSleep": {"idleEnabled": true, "adaptiveEnabled": false}})),
            ("adaptive", json!({"arcSleep": {"idleEnabled": false, "adaptiveEnabled": true}})),
            ("pending disable", json!({"arcSleepPendingBaseDisable": true})),
            ("own journal", json!({"arcSleepJournal": journal.clone()})),
        ];
        for (label, patch) in native {
            let env = Env::new(b580_features(false));
            let frame_limit = FakeFrameLimit::with_rtss(90, true);
            let registry = FakeRegistry::with_max(100);
            let mut settings = settings();
            for (key, value) in patch.as_object().unwrap() {
                settings[key] = value.clone();
            }
            let open = open_closure(env.state.clone(), env.opens.clone(), env.device.clone());
            let runtime = runtime(&env, settings, &frame_limit, &registry, &open);
            assert!(get_with(&runtime, 0, None).unwrap().is_some(), "{label}: the read must be native");
            assert!(apply_with(&runtime, 0, &json!({"flipMode": "vsync-on"}), None, None, None).unwrap().is_some(),
                "{label}: a non-limiter apply must be native");
        }
        // A journal record this build cannot parse belongs to a foreign owner:
        // delegate before any driver, RTSS or registry access.
        let env = Env::new(b580_features(false));
        let frame_limit = FakeFrameLimit::with_rtss(90, true);
        let registry = FakeRegistry::with_max(100);
        let mut settings = settings();
        settings["arcSleepJournal"] = json!({"deviceKey": KEY});
        let open = open_closure(env.state.clone(), env.opens.clone(), env.device.clone());
        let runtime = runtime(&env, settings, &frame_limit, &registry, &open);
        assert!(get_with(&runtime, 0, None).unwrap().is_none(), "foreign journal: get must delegate");
        assert!(apply_with(&runtime, 0, &json!({"flipMode": "vsync-on"}), None, None, None).unwrap().is_none(),
            "foreign journal: apply must delegate");
        assert_eq!(env.opens(), 0, "foreign journal: no driver access");
        assert!(env.writes().is_empty(), "foreign journal: no driver write");
        assert!(frame_limit.applied().is_empty(), "foreign journal: no RTSS write");
        assert_eq!(registry.writes(), 0, "foreign journal: no registry write");
    }

    #[test]
    fn a_disabled_base_cap_still_handles_the_read_natively() {
        let env = Env::new(b580_features(false));
        let frame_limit = FakeFrameLimit::with_rtss(90, true);
        let registry = FakeRegistry::with_max(100);
        let mut settings = settings();
        settings["arcSleepFrameLimitBase"] = json!({"enabled": false, "value": 75});
        let state = get_state(&env, settings.clone(), &frame_limit, &registry);
        assert_eq!(state["frameLimitSource"], json!("rtss"));
        assert_eq!(state["values"]["frameLimit"], json!({"enabled": false, "value": 60}));
        // A non-limiter apply is still native.
        let reply = apply_payload(&env, settings, json!({"lowLatency": "on"}), &frame_limit, &registry)
            .expect("a non-limiter apply must not delegate");
        assert_eq!(reply["ok"], json!(true));
    }

    // -----------------------------------------------------------------------
    // Event fan-out
    // -----------------------------------------------------------------------

    #[test]
    fn the_state_event_is_emitted_exactly_once_for_the_requested_device() {
        let reply = json!({"ok": false, "perControl": {}, "graphicsState": {"supported": {}}});
        let sent: RefCell<Vec<(String, Value)>> = RefCell::new(Vec::new());
        let emitted = emit_state(&|channel, payload| sent.borrow_mut().push((channel.to_owned(), payload)), 7, &reply);
        assert!(emitted);
        let sent = sent.into_inner();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].0, STATE_UPDATED_CHANNEL);
        assert_eq!(sent[0].1, json!({"deviceId": 7, "graphicsState": {"supported": {}}}));

        // A degraded read-back (no graphicsState) emits nothing.
        let send_count = Cell::new(0);
        assert!(!emit_state(&|_, _| send_count.set(send_count.get() + 1), 7, &json!({"ok": false, "graphicsState": Value::Null})));
        assert_eq!(send_count.get(), 0);
        assert_eq!(state_updated_payload(7, &json!({"graphicsState": Value::Null})), None);
    }

    #[test]
    fn the_state_event_targets_main_and_the_advanced_overlay_only() {
        assert_eq!(target_roles(STATE_UPDATED_CHANNEL), &["main", "advanced-overlay"][..]);
        assert!(target_roles("graphics:get").is_empty());
        assert_eq!(
            super::super::device_selection::target_roles(STATE_UPDATED_CHANNEL),
            &["main", "advanced-overlay"][..]
        );
        assert!(super::super::device_selection::target_roles("graphics:other").is_empty());
    }
}
