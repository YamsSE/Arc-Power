//! Native `profiles-settings-save`: the settings-domain keys whose patch has no
//! main-process reaction.
//!
//! `ipc-core.js` treats the channel as a read-modify-write of the persisted
//! settings document plus a set of main-process reactions: the startup
//! registration, the Scale-hotkey re-registration, the overlay re-render, the
//! memory-saving probe and the recorded senders of the recording-pill/toast
//! preferences. Rust owns the persistence half for the keys that never reach
//! those reactions. Every other patch - including a mixed patch that carries
//! one React-owned key - delegates the WHOLE patch before any read or write.
//!
//! Phase 2 adds the four flags the compatibility service only READS back from
//! its own `_settingsCache` (`startMinimized`, `closeToTray`,
//! `recordingToastsEnabled`, `overlayRecordingPill`). Because that cache cannot
//! see a native write, the host pushes the WHOLE settings snapshot on the
//! `settings-cache` host event after a landed save: the close handler, the
//! toast gate and the compatibility pill then read the saved values, and the
//! native recording pill already re-reads its own owner from the native cache
//! on its 250 ms cadence. Three residuals are accepted with that push: it has
//! no reply and no ordering guarantee against a delegated Electron save (so an
//! interleaved cross-host pair leaves the last writer in `_settingsCache`), and
//! a dropped push leaves the cache one save stale until Electron's next
//! `loadSettings()` read self-heals it. A save whose startup registration fails
//! after the settings write persists but answers an error, so it pushes nothing.
//!
//! The reply is the handler's `next` envelope, never the normalized store
//! cache. The two intentionally differ (`memorySavingMode` inheritance, the
//! `recordingToastsEnabled` cache rebuild, an unvalidated `activeProfileId`)
//! and the renderer replays `next` into its own view.
//!
//! Two further payloads stay delegated even with native keys only: a value the
//! tagged codec cannot reduce to ordinary JSON (a nested `undefined`, a
//! non-finite number, a bigint) needs the JavaScript handler's coercion, and a
//! frame the tag decoder rejects never reaches the native decision at all. A
//! top-level `undefined` member is the handler's "absent" key and stays native.
//!
//! Accepted residual: the handler also loops `theme` into the advanced-overlay
//! reaction, so Electron re-renders an open panel immediately. A native save
//! skips that push; the host's two-second advanced-overlay poll compares the
//! same `theme` and emits the panel settings itself, so the panel converges
//! instead of going stale. Advanced-overlay settings are native too: the host
//! already observes the settings file and owns the panel and global hotkey.
//! The Scale hotkey, the RTSS startup preference and the Advanced Overlay
//! fields are also native: after this settings channel returns the host
//! reloads its native registration and polls the panel. Remaining
//! Every settings-domain key is now native; only unknown keys and values the
//! tagged codec cannot reduce to plain JSON still delegate.
use super::{
    arc_sleep_policy::normalize_arc_sleep_settings,
    native_store::NativeStore,
    native_system::BuildKind,
    profile_store::active_profile_entries,
    settings::THEMES,
    settings_write::normalized_field,
    wire::{decode, WireValue},
};
use serde_json::{json, Map, Value};
use std::sync::Mutex;

const PATCH_ERROR: &str = "profiles-settings-save: patch must be an object";

// Mirrors of the Electron overlay validators in `src/main/ipc-core.js` and
// `src/main/store/profile-store.js`. Kept here so the remaining overlay keys
// can be promoted to the native settings writer without changing the saved
// envelope by even one field.
const OVERLAY_POSITIONS: [&str; 4] = ["top-left", "top-right", "bottom-left", "bottom-right"];
const OVERLAY_RENDERERS: [&str; 2] = ["rtss", "capframex"];
const OVERLAY_THEMES: [&str; 2] = ["classic", "arc"];
const OVERLAY_STAT_IDS: [&str; 21] = [
    "fps", "fps-avg", "fps-01pct-low", "fps-1pct-low", "fps-99pct", "api",
    "cpu-util", "cpu-clock", "cpu-temp", "cpu-power", "memory-util", "gpu-util",
    "gpu-clock", "gpu-voltage", "gpu-temp", "gpu-power", "gpu-fan", "gpu-mem-clock",
    "gpu-vram", "gpu-vram-temp", "frametime",
];
const OVERLAY_STATS_DEFAULT: [&str; 11] = [
    "cpu-util", "cpu-temp", "cpu-power", "memory-util", "gpu-util", "gpu-temp",
    "gpu-power", "gpu-vram", "fps", "api", "frametime",
];
const OVERLAY_SCALE_MIN: f64 = 0.5;
const OVERLAY_SCALE_MAX: f64 = 2.0;
const OVERLAY_SCALE_STEP: f64 = 0.25;
const OVERLAY_POLL_MS_MIN: f64 = 100.0;
const OVERLAY_POLL_MS_MAX: f64 = 2000.0;
const OVERLAY_POLL_MS_DEFAULT: f64 = 600.0;

fn overlay_choice(key: &str, value: &Value, allowed: &[&str]) -> Result<String, String> {
    let error = format!("{key} must be one of: {}", allowed.join(", "));
    match value.as_str() {
        Some(text) if allowed.contains(&text) => Ok(text.to_owned()),
        _ => Err(error),
    }
}

fn overlay_hex_color(key: &str, value: &Value) -> Result<String, String> {
    let error = if key == "overlayBgColor" {
        "overlayBgColor must be a hex color like #000000".to_owned()
    } else {
        "overlayColor must be a hex color like #ffffff".to_owned()
    };
    match value.as_str() {
        Some(text) if text.len() == 7 && text.starts_with('#')
            && text[1..].bytes().all(|byte| byte.is_ascii_hexdigit()) => Ok(text.to_owned()),
        _ => Err(error),
    }
}

fn overlay_flag(key: &str, patch: &Map<String, Value>, cur: &Value) -> Value {
    match patch.get(key) {
        Some(value) => json!(value == &Value::Bool(true)),
        None => cur.get(key).cloned().unwrap_or(Value::Null),
    }
}

fn overlay_number(value: Option<&Value>, default: f64) -> f64 {
    value.and_then(Value::as_f64).filter(|number| number.is_finite()).unwrap_or(default)
}

fn overlay_scale(value: Option<&Value>) -> f64 {
    let clamped = overlay_number(value, 1.0).clamp(OVERLAY_SCALE_MIN, OVERLAY_SCALE_MAX);
    // JS Math.round is half-away-from-zero; all values here are positive.
    ((clamped / OVERLAY_SCALE_STEP) + 0.5).floor() * OVERLAY_SCALE_STEP
}

fn overlay_bg_opacity(value: Option<&Value>) -> f64 {
    overlay_number(value, 0.5).clamp(0.0, 1.0)
}

fn overlay_poll_ms(value: Option<&Value>) -> f64 {
    overlay_number(value, OVERLAY_POLL_MS_DEFAULT).round()
        .clamp(OVERLAY_POLL_MS_MIN, OVERLAY_POLL_MS_MAX)
}

fn overlay_stats(value: &Value) -> Value {
    let Some(items) = value.as_array() else {
        return json!(OVERLAY_STATS_DEFAULT);
    };
    let mut out = Vec::new();
    for item in items {
        if let Some(id) = item.as_str() {
            if OVERLAY_STAT_IDS.contains(&id) && !out.iter().any(|seen: &String| seen == id) {
                out.push(id.to_owned());
            }
        }
    }
    json!(out)
}

fn overlay_device_keys(value: &Value) -> Value {
    let Some(items) = value.as_array() else { return Value::Null; };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        if let Some(key) = item.as_str() {
            if !key.is_empty() && key.chars().count() <= 256 && !out.iter().any(|seen| seen == key) {
                out.push(key.to_owned());
            }
        }
    }
    if out.is_empty() { Value::Null } else { json!(out) }
}

/// Settings-domain keys with no main-process reaction, so a native
/// read-modify-write is observationally identical to the Electron handler.
pub const PHASE1_KEYS: [&str; 35] = [
    "startWithWindows",
    "ocOnBoot",
    "activeProfileId",
    "activeProfileIds",
    "theme",
    "monitorLogToFile",
    "monitorLogMetrics",
    "arcSleep",
    "startMinimized",
    "closeToTray",
    "recordingToastsEnabled",
    "overlayRecordingPill",
    // Phase 2 tranche 1: these already have a native writer and a native
    // post-save reaction (Scale hotkey reload, Advanced Overlay poll).
    "rtssOnBoot",
    "postprocessScaleHotkey",
    "advancedOverlayEnabled",
    "advancedOverlayHotkeyLetter",
    "advancedOverlayPosition",
    "memorySavingMode",
    // Phase 2 tranche 3: the remaining overlay fields. Their Electron
    // validators are mirrored above, so the whole settings domain is native.
    "overlayEnabled",
    "overlayHotkeyLetter",
    "overlayPosition",
    "overlayRenderer",
    "overlayScale",
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
];

/// No settings-domain key still requires a compatibility-service callback.
/// Unknown keys and values the tagged codec cannot reduce to JSON still
/// delegate, so this list is intentionally empty until phase 4 removes the
/// compatibility service entirely.
pub const DELEGATED_KEYS: [&str; 0] = [];

/// Patch keys that make a startup registration failure a save failure in a
/// packaged build. A save without them still persists its intent and answers
/// the honest envelope.
const STARTUP_INTENT_KEYS: [&str; 4] =
    ["startWithWindows", "ocOnBoot", "activeProfileId", "activeProfileIds"];

/// One read-modify-write per process at a time, mirroring the handler's
/// `queueSettingsSave`: two renderer saves that both start from the same
/// snapshot would otherwise lose one of the two patches.
static SAVE_QUEUE: Mutex<()> = Mutex::new(());

enum Patch {
    /// An Electron-owned patch: the compatibility service keeps the channel.
    Delegate,
    /// The handler rejects this payload before it reads the store.
    Reject(String),
    /// Every key is native, so the native path owns the whole save.
    Native(Map<String, Value>),
}

/// Classify one channel call. This function performs no I/O: a delegated or
/// rejected patch must be decided before the store is touched.
fn classify(args: &Value) -> Patch {
    let Ok(WireValue::Array(items)) = decode(args) else {
        // A frame the tagged codec rejects is still the compatibility
        // service's to answer; its own decode owns that error text.
        return Patch::Delegate;
    };
    let Some(WireValue::Object(entries)) = items.into_iter().next() else {
        return Patch::Reject(PATCH_ERROR.into());
    };
    let mut patch = Map::new();
    for (key, value) in entries {
        match value {
            // `patch[key] === undefined` is the handler's "absent" test, so a
            // present undefined member is exactly an absent one here too.
            WireValue::Undefined => continue,
            value => {
                // The compatibility validator throws JavaScript's native
                // `.split` TypeError for non-string hotkey values. Keep that
                // malformed-input behavior on its original path.
                if key == "postprocessScaleHotkey" && !matches!(&value, WireValue::String(_)) {
                    return Patch::Delegate;
                }
                match value.into_json() {
                    Ok(value) => { patch.insert(key, value); }
                    // Non-finite numbers and other non-JSON values are readable by
                    // the JavaScript handler; let it own them rather than guessing.
                    Err(_) => return Patch::Delegate,
                }
            }
        }
    }
    if patch.keys().any(|key| !PHASE1_KEYS.contains(&key.as_str())) {
        return Patch::Delegate;
    }
    Patch::Native(patch)
}

/// The service arm. `None` delegates this call to the compatibility service.
pub fn handle(store: &NativeStore, args: &Value, kind: BuildKind) -> Option<Result<Value, String>> {
    match classify(args) {
        Patch::Delegate => None,
        Patch::Reject(error) => Some(Err(error)),
        Patch::Native(patch) => Some(save(store, &Value::Object(patch), kind)),
    }
}

fn save(store: &NativeStore, patch: &Value, kind: BuildKind) -> Result<Value, String> {
    with_save_queue(|| apply(store, patch, kind, |enabled| super::startup::set_registration(kind, enabled)))
}

/// Serialize every native read-modify-write over the shared settings file,
/// including the separate RTSS startup setting path. This mirrors the
/// compatibility service's single `queueSettingsSave` for both channels.
pub fn with_save_queue<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _queued = SAVE_QUEUE.lock()
        .map_err(|_| "profiles-settings-save: the settings save queue was poisoned".to_owned())?;
    operation()
}

/// The handler body: derive `next`, write the startup registration, persist,
/// then answer `next`. `register` is injected so the registration write is
/// exercised without touching the real Run value or logon task.
fn apply(store: &NativeStore, patch: &Value, kind: BuildKind,
    mut register: impl FnMut(bool) -> Result<(), String>) -> Result<Value, String> {
    let patch = patch.as_object().ok_or_else(|| PATCH_ERROR.to_owned())?;
    // The read also publishes the store cache, exactly like the handler's
    // `store.loadSettings()`; the write below therefore sees the same cache.
    let cur = store.settings_store().load_settings()?;
    let mut next = next_envelope(&cur, patch);
    apply_advanced_overlay_patch(&mut next, &cur, patch)?;

    // The scalar fallback survives a missing profile on purpose: it is the
    // legacy compatibility slot. Only the multi-GPU map proves an active
    // profile. An unreadable profile list keeps the scalar fallback and the
    // save still persists.
    let mut has_active_profile = next["activeProfileId"].as_str().is_some_and(|id| !id.is_empty());
    if let Ok(profiles) = super::services::native_json(store, "load-profiles", json!([])) {
        let rows = profiles.as_array().map(Vec::as_slice).unwrap_or(&[]);
        has_active_profile = !active_profile_entries(&next, rows).is_empty() || has_active_profile;
    }
    let wanted = next["startWithWindows"] == Value::Bool(true)
        || (next["ocOnBoot"] == Value::Bool(true) && has_active_profile);
    // The registration write lands BEFORE the settings write, so a partial
    // failure leaves the registration ahead of the intent and the renderer's
    // startup mismatch hint explains the disagreement honestly.
    let startup_error = register(wanted).err();

    let settings = store.settings_store();
    if patch.contains_key("arcSleep") {
        // Only this path refreshes the cached policy the Arc Sleep controller
        // adopts on its next cadence; the generic write cannot replace it.
        settings.save_settings_with_arc_sleep(&next, &next["arcSleep"])?;
    } else {
        settings.save_settings(&next)?;
    }
    if let Some(error) = startup_error {
        if kind != BuildKind::Dev && STARTUP_INTENT_KEYS.iter().any(|key| patch.contains_key(*key)) {
            return Err(error);
        }
    }
    Ok(next)
}

/// Port the Advanced Overlay portion of `ipc-core.js`'s settings envelope.
/// The host observes the settings file for panel updates and reloads its
/// RegisterHotKey plan on the existing two-second cadence.
fn apply_advanced_overlay_patch(next: &mut Value, current: &Value, patch: &Map<String, Value>) -> Result<(), String> {
    // The ordinary overlay fields share this Result-returning seam because
    // their Electron validators reject malformed values before any write.
    if let Some(value) = patch.get("overlayHotkeyLetter") {
        let value = value.as_str().ok_or_else(|| {
            "overlayHotkeyLetter must be a modifier chord such as Control+O or Alt+F9".to_owned()
        })?;
        let normalized = super::postprocess_sharpening::validate_overlay_hotkey_letter(value)?;
        next["overlayHotkeyLetter"] = json!(normalized);
    }
    next["overlayEnabled"] = overlay_flag("overlayEnabled", patch, current);
    if let Some(value) = patch.get("overlayPosition") {
        next["overlayPosition"] = json!(overlay_choice("overlayPosition", value, &OVERLAY_POSITIONS)?);
    }
    if let Some(value) = patch.get("overlayRenderer") {
        next["overlayRenderer"] = json!(overlay_choice("overlayRenderer", value, &OVERLAY_RENDERERS)?);
    }
    if let Some(value) = patch.get("overlayScale") {
        next["overlayScale"] = json!(overlay_scale(Some(value)));
    }
    if let Some(value) = patch.get("overlayColor") {
        next["overlayColor"] = json!(overlay_hex_color("overlayColor", value)?);
    }
    for key in ["overlayLabelColor", "overlayValueColor"] {
        if let Some(value) = patch.get(key) {
            next[key] = json!(overlay_hex_color("overlayColor", value)?);
        } else if let Some(value) = patch.get("overlayColor") {
            // Electron derives both label colors from a changed overlayColor.
            next[key] = json!(overlay_hex_color("overlayColor", value)?);
        } else {
            let derived = current.get(key).cloned()
                .or_else(|| current.get("overlayColor").cloned())
                .unwrap_or(Value::Null);
            next[key] = derived;
        }
    }
    if let Some(value) = patch.get("overlayTemperatureUnit") {
        next["overlayTemperatureUnit"] = json!(overlay_choice("overlayTemperatureUnit", value, &["C", "F"])?);
    }
    if let Some(value) = patch.get("overlayStats") {
        next["overlayStats"] = overlay_stats(value);
    }
    if let Some(value) = patch.get("overlayDeviceKeys") {
        next["overlayDeviceKeys"] = overlay_device_keys(value);
    }
    next["overlayBgEnabled"] = overlay_flag("overlayBgEnabled", patch, current);
    if let Some(value) = patch.get("overlayBgColor") {
        next["overlayBgColor"] = json!(overlay_hex_color("overlayBgColor", value)?);
    }
    if let Some(value) = patch.get("overlayBgOpacity") {
        next["overlayBgOpacity"] = json!(overlay_bg_opacity(Some(value)));
    }
    next["overlayChipNames"] = overlay_flag("overlayChipNames", patch, current);
    if let Some(value) = patch.get("overlayPollMs") {
        next["overlayPollMs"] = json!(overlay_poll_ms(Some(value)));
    }
    if let Some(value) = patch.get("overlayTheme") {
        next["overlayTheme"] = json!(overlay_choice("overlayTheme", value, &OVERLAY_THEMES)?);
    }

    if let Some(value) = patch.get("postprocessScaleHotkey") {
        let value = value.as_str().expect("classifier keeps malformed hotkey types delegated");
        let normalized = super::postprocess_sharpening::validate_postprocess_scale_hotkey(Some(value))?;
        next["postprocessScaleHotkey"] = json!(normalized);
    }

    if patch.contains_key("advancedOverlayEnabled") {
        next["advancedOverlayEnabled"] = json!(patch.get("advancedOverlayEnabled") == Some(&Value::Bool(true)));
    }

    if let Some(value) = patch.get("advancedOverlayHotkeyLetter") {
        let value = value.as_str().ok_or_else(|| {
            "overlayHotkeyLetter must be a modifier chord such as Control+O or Alt+F9".to_owned()
        })?;
        let normalized = super::postprocess_sharpening::validate_overlay_hotkey_letter(value)?;
        next["advancedOverlayHotkeyLetter"] = json!(normalized);
    }

    if let Some(value) = patch.get("advancedOverlayPosition") {
        match value.as_str() {
            Some("left" | "right") => next["advancedOverlayPosition"] = value.clone(),
            _ => return Err("advancedOverlayPosition must be one of: left, right".into()),
        }
    }

    // Match ipc-core's post-next collision order. A Scale-hotkey patch checks
    // both effective overlay chords first; an advanced-hotkey-only patch then
    // checks Scale followed by the ordinary overlay chord.
    let effective_overlay = next.get("overlayHotkeyLetter").and_then(Value::as_str).unwrap_or("O");
    let effective_scale = next.get("postprocessScaleHotkey").and_then(Value::as_str).unwrap_or("Alt+F10");
    let effective_advanced = next.get("advancedOverlayHotkeyLetter").and_then(Value::as_str).unwrap_or("P");
    if patch.contains_key("postprocessScaleHotkey")
        && (super::postprocess_sharpening::overlay_hotkeys_collide(effective_scale, effective_overlay)
            || super::postprocess_sharpening::overlay_hotkeys_collide(effective_scale, effective_advanced))
    {
        return Err("postprocessScaleHotkey must differ from both overlay hotkeys".into());
    }
    if patch.contains_key("overlayHotkeyLetter")
        && super::postprocess_sharpening::overlay_hotkeys_collide(effective_scale, effective_overlay) {
        return Err("overlayHotkeyLetter must differ from the Scale hotkey".into());
    }
    if patch.contains_key("advancedOverlayHotkeyLetter") {
        if super::postprocess_sharpening::overlay_hotkeys_collide(effective_advanced, effective_scale) {
            return Err("advancedOverlayHotkeyLetter must differ from the Scale hotkey".into());
        }
        if super::postprocess_sharpening::overlay_hotkeys_collide(effective_advanced, effective_overlay) {
            return Err("advancedOverlayHotkeyLetter must differ from the overlay hotkey (the accelerators would collide)".into());
        }
    }
    if patch.contains_key("overlayHotkeyLetter")
        && super::postprocess_sharpening::overlay_hotkeys_collide(effective_overlay, effective_advanced) {
        return Err("overlayHotkeyLetter must differ from the advanced overlay hotkey (the accelerators would collide)".into());
    }

    Ok(())
}

/// Port of the handler's `next` literal, including its key order. Callers must
/// have proven every patch key is native; the remaining branches therefore
/// read the loaded snapshot exactly like the source's `patch.x === undefined`
/// arms do. `flag` carries the handler's `patch.x === undefined ? cur.x : patch.x
/// === true` coercion for every boolean field - `closeToTray` and
/// `startMinimized` included, where the stored value is not the answer.
fn next_envelope(cur: &Value, patch: &Map<String, Value>) -> Value {
    let current = |key: &str| cur.get(key).cloned().unwrap_or(Value::Null);
    let flag = |key: &str| json!(patch.get(key).map(|value| value == &Value::Bool(true))
        .unwrap_or_else(|| cur.get(key) == Some(&Value::Bool(true))));
    let mut next = Map::new();
    next.insert("waiverAccepted".into(), current("waiverAccepted"));
    next.insert("ocOnBoot".into(), flag("ocOnBoot"));
    next.insert("activeProfileId".into(), match patch.get("activeProfileId") {
        None => current("activeProfileId"),
        Some(Value::String(id)) if !id.is_empty() => patch["activeProfileId"].clone(),
        Some(_) => Value::Null,
    });
    if patch.contains_key("activeProfileIds") || cur.get("activeProfileIds").is_some() {
        // A raw non-array object is passed through; the store sanitizer owns
        // its values. Anything else (including an array) becomes an empty map.
        next.insert("activeProfileIds".into(), match patch.get("activeProfileIds") {
            None => current("activeProfileIds"),
            Some(Value::Object(_)) => patch["activeProfileIds"].clone(),
            Some(_) => json!({}),
        });
    }
    next.insert("ocMode".into(), current("ocMode"));
    if cur.get("ocModes").is_some() { next.insert("ocModes".into(), current("ocModes")); }
    next.insert("advancedModeAccepted".into(), current("advancedModeAccepted"));
    next.insert("startWithWindows".into(), flag("startWithWindows"));
    if patch.contains_key("rtssOnBoot") || cur.get("rtssOnBoot").is_some() {
        next.insert("rtssOnBoot".into(), flag("rtssOnBoot"));
    }
    next.insert("startMinimized".into(), flag("startMinimized"));
    next.insert("closeToTray".into(), flag("closeToTray"));
    next.insert("arcSleep".into(), next_arc_sleep(cur, patch));
    next.insert("monitorLogToFile".into(), flag("monitorLogToFile"));
    if patch.contains_key("monitorLogMetrics") || cur.get("monitorLogMetrics").is_some() {
        let metrics = match patch.get("monitorLogMetrics") {
            None => current("monitorLogMetrics"),
            Some(value) => normalized_field("monitorLogMetrics", value, oc_mode_default(cur)),
        };
        next.insert("monitorLogMetrics".into(), metrics);
    }
    next.insert("deviceId".into(), whole_non_negative(cur.get("deviceId")));
    next.insert("deviceKey".into(), match cur.get("deviceKey") {
        Some(Value::String(key)) if !key.is_empty() => current("deviceKey"),
        _ => Value::Null,
    });
    next.insert("theme".into(), match patch.get("theme") {
        // An invalid patch keeps the CURRENT theme rather than resetting it.
        Some(Value::String(theme)) if THEMES.contains(&theme.as_str()) => patch["theme"].clone(),
        _ => current("theme"),
    });
    next.insert("overlayEnabled".into(), current("overlayEnabled"));
    next.insert("overlayHotkeyLetter".into(), current("overlayHotkeyLetter"));
    next.insert("postprocessScaleHotkey".into(),
        patch.get("postprocessScaleHotkey").cloned()
            .or_else(|| cur.get("postprocessScaleHotkey").cloned()).unwrap_or_else(|| json!("Alt+F10")));
    next.insert("overlayPosition".into(), current("overlayPosition"));
    if cur.get("overlayRenderer").is_some() { next.insert("overlayRenderer".into(), current("overlayRenderer")); }
    next.insert("overlayScale".into(), current("overlayScale"));
    next.insert("overlayColor".into(), current("overlayColor"));
    for (key, fallback) in [("overlayLabelColor", "overlayColor"), ("overlayValueColor", "overlayColor")] {
        next.insert(key.into(), cur.get(key).cloned().unwrap_or_else(|| current(fallback)));
    }
    next.insert("overlayTemperatureUnit".into(),
        json!(if cur.get("overlayTemperatureUnit").and_then(Value::as_str) == Some("F") { "F" } else { "C" }));
    next.insert("overlayStats".into(), current("overlayStats"));
    next.insert("overlayDeviceKeys".into(), current("overlayDeviceKeys"));
    next.insert("overlayBgEnabled".into(), current("overlayBgEnabled"));
    next.insert("overlayBgColor".into(), current("overlayBgColor"));
    next.insert("overlayBgOpacity".into(), current("overlayBgOpacity"));
    next.insert("overlayChipNames".into(), current("overlayChipNames"));
    next.insert("overlayPollMs".into(), current("overlayPollMs"));
    next.insert("overlayTheme".into(), current("overlayTheme"));
    next.insert("overlayRecordingPill".into(), flag("overlayRecordingPill"));
    next.insert("recordingToastsEnabled".into(), flag("recordingToastsEnabled"));
    next.insert("memorySavingMode".into(), flag("memorySavingMode"));
    next.insert("advancedOverlayEnabled".into(), current("advancedOverlayEnabled"));
    next.insert("advancedOverlayHotkeyLetter".into(), current("advancedOverlayHotkeyLetter"));
    next.insert("advancedOverlayPosition".into(), current("advancedOverlayPosition"));
    Value::Object(next)
}

/// `normalizeArcSleepSettings({ ...cur.arcSleep, ...patch.arcSleep })`. A
/// non-object patch contributes nothing the normalizer keeps, so only an
/// object patch changes the merged policy.
fn next_arc_sleep(cur: &Value, patch: &Map<String, Value>) -> Value {
    let merged = match patch.get("arcSleep") {
        Some(Value::Object(entries)) => {
            let mut merged = cur.get("arcSleep").and_then(Value::as_object).cloned().unwrap_or_default();
            for (key, value) in entries { merged.insert(key.clone(), value.clone()); }
            Value::Object(merged)
        }
        _ => cur.get("arcSleep").cloned().unwrap_or(Value::Null),
    };
    serde_json::to_value(normalize_arc_sleep_settings(&merged))
        .expect("Arc Sleep settings serialize as a JSON object")
}

/// `Number.isInteger(value) && value >= 0 ? value : null`.
fn whole_non_negative(value: Option<&Value>) -> Value {
    value.filter(|value| value.as_f64().is_some_and(|number| number >= 0.0 && number.fract() == 0.0))
        .cloned().unwrap_or(Value::Null)
}

/// The store's OC-mode default, recovered from the normalized snapshot so the
/// field normalizers keep their constructor-derived fallback.
fn oc_mode_default(cur: &Value) -> &'static str {
    if cur.get("ocMode").and_then(Value::as_str) == Some("advanced") { "advanced" } else { "stock" }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::wire::encode_json;
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        /// Seeds the exact sidecar text captured from the Electron run, so the
        /// patch port is compared against the handler's own file shape.
        fn new(settings: Option<&str>, profiles: &str) -> Self {
            let path = std::env::temp_dir().join(format!("arc-settings-patch-{:032x}", rand::random::<u128>()));
            fs::create_dir(&path).unwrap();
            if let Some(text) = settings { fs::write(path.join("settings.json"), text).unwrap(); }
            fs::write(path.join("profiles.json"), profiles).unwrap();
            Self(path)
        }
        fn store(&self, mode: &str) -> NativeStore { NativeStore::new(self.0.clone(), mode).unwrap() }
        fn bytes(&self, file: &str) -> Option<Vec<u8>> { fs::read(self.0.join(file)).ok() }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            if self.0.parent() == Some(std::env::temp_dir().as_path()) { let _ = fs::remove_dir_all(&self.0); }
        }
    }

    fn equivalent(actual: &Value, expected: &Value) -> bool {
        match (actual, expected) {
            (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
            (Value::Array(a), Value::Array(b)) => a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b)),
            (Value::Object(a), Value::Object(b)) => a.len() == b.len()
                && a.iter().all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b))),
            _ => actual == expected,
        }
    }

    fn fixture_data() -> Value {
        serde_json::from_str(include_str!("fixtures/settings-patch-parity.json")).unwrap()
    }

    fn keys_of(value: &Value) -> Vec<&str> {
        value.as_object().unwrap().keys().map(String::as_str).collect()
    }

    /// Shared-value fixtures store one copy of each envelope and each case
    /// names the index it uses.
    fn shared<'a>(data: &'a Value, case: &Value, field: &str) -> &'a Value {
        &data["values"][case[field].as_u64().unwrap() as usize]
    }

    fn expected_keys<'a>(data: &'a Value, case: &Value, field: &str) -> Vec<&'a str> {
        shared(data, case, field).as_array().unwrap().iter().map(|key| key.as_str().unwrap()).collect()
    }

    /// Replays one case captured from the unmodified handler. `wire` is the
    /// renderer's own tagged encoding of the argument list.
    fn replay(data: &Value, case: &Value) {
        let name = &case["name"];
        let initial_settings = shared(data, case, "initialSettingsJson");
        let initial_settings = initial_settings.as_str();
        let initial_profiles = shared(data, case, "initialProfilesJson").as_str().unwrap();
        let fixture = Fixture::new(initial_settings, initial_profiles);
        let store = fixture.store(case["mode"].as_str().unwrap());
        let before_settings = fixture.bytes("settings.json");
        let before_profiles = fixture.bytes("profiles.json");
        let unchanged = |fixture: &Fixture| {
            assert_eq!(fixture.bytes("settings.json"), before_settings, "{name}: settings must not change");
            assert_eq!(fixture.bytes("profiles.json"), before_profiles, "{name}: profiles must not change");
        };
        let mut calls = Vec::new();
        let registration = &case["registration"];
        // `registrationMode: 'task'` is the packaged adapter; that is also the
        // only mode where a registration failure can fail the save.
        let kind = if registration["mode"] == "task" { BuildKind::Installed } else { BuildKind::Dev };
        let result = match classify(&case["wire"]) {
            Patch::Delegate => {
                assert_eq!(case["delegate"], true, "{name}: expected a delegated patch");
                unchanged(&fixture);
                return;
            }
            Patch::Reject(error) => {
                assert_eq!(case["delegate"], false, "{name}: a rejected payload is decided natively");
                assert_eq!(case["expectedError"].as_str(), Some(error.as_str()), "{name}");
                assert!(shared(data, case, "expectedPersisted").is_null(),
                    "{name}: a rejected patch persists nothing");
                unchanged(&fixture);
                return;
            }
            Patch::Native(patch) => {
                assert_eq!(case["delegate"], false, "{name}: a Phase-1 patch must be native");
                apply(&store, &Value::Object(patch), kind, |enabled| {
                    calls.push(json!(enabled));
                    match registration["error"].as_str() {
                        Some(error) => Err(error.to_owned()),
                        None => Ok(()),
                    }
                })
            }
        };
        assert_eq!(json!(calls), registration["calls"], "{name}: registration");
        if let Some(expected) = case["expectedError"].as_str() {
            let error = result.err().unwrap_or_else(|| panic!("{name}: expected the save to fail with {expected}"));
            assert_eq!(error, expected, "{name}");
        } else {
            let next = result.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert!(equivalent(&next, shared(data, case, "expectedNext")), "{name}: next={next}");
            assert_eq!(keys_of(&next), expected_keys(data, case, "expectedNextKeys"), "{name}: next key order");
        }
        let persisted: Value = serde_json::from_slice(&fixture.bytes("settings.json")
            .unwrap_or_else(|| panic!("{name}: settings were not persisted")))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(equivalent(&persisted, shared(data, case, "expectedPersisted")),
            "{name}: persisted={persisted}");
        assert_eq!(keys_of(&persisted), expected_keys(data, case, "expectedPersistedKeys"),
            "{name}: persisted key order");
        assert_eq!(fixture.bytes("profiles.json"), before_profiles, "{name}: the patch never writes profiles");
    }

    #[test]
    fn phase1_patches_match_the_electron_handler() {
        let data = fixture_data();
        let cases = data["cases"].as_array().unwrap();
        assert!(cases.len() >= 120, "the differential matrix must stay broad: {}", cases.len());
        for case in cases { replay(&data, case); }
        let delegated = cases.iter().filter(|case| case["delegate"] == true).count();
        // Every still-delegated key gets its own case, plus the mixed/unknown
        // cases; the floor moves with the key list as phases promote keys.
        assert!(delegated >= DELEGATED_KEYS.len(),
            "the delegate matrix must cover every React-owned key: {delegated}");
    }

    /// A2: every React-owned key - and any unknown key - delegates the WHOLE
    /// patch before the store is read or written.
    #[test]
    fn reaction_and_unknown_keys_delegate_without_touching_the_store() {
        let fixture = Fixture::new(None, "{\"schemaVersion\":3,\"profiles\":[]}");
        let sentinel = br#"{"schemaVersion":3,"waiverAccepted":true,"theme":"red"}"#;
        fs::write(fixture.0.join("settings.json"), sentinel).unwrap();
        fs::write(fixture.0.join("profiles.json"), br#"{"schemaVersion":3,"profiles":[]}"#).unwrap();
        let before_modified = fs::metadata(fixture.0.join("settings.json")).unwrap().modified().unwrap();
        let store = fixture.store("advanced");
        let mut patches: Vec<Value> = DELEGATED_KEYS.iter().map(|key| json!({(*key): true})).collect();
        patches.push(json!({"startWithWindows":true,"reactOnlyA":true}));
        patches.push(json!({"arcSleep":{"idleEnabled":true},"reactOnlyB":true}));
        patches.push(json!({"theme":"red","reactOnlyC":true}));
        patches.push(json!({"startWithWindows":true,"monitorLogMetrics":["fps"],"reactOnlyD":100}));
        patches.push(json!({"notAKey":1}));
        for patch in patches {
            let args = encode_json(&json!([patch])).unwrap();
            assert!(handle(&store, &args, BuildKind::Dev).is_none(), "{patch} must delegate");
        }
        assert_eq!(fs::read(fixture.0.join("settings.json")).unwrap(), sentinel);
        assert_eq!(fs::metadata(fixture.0.join("settings.json")).unwrap().modified().unwrap(), before_modified);
        // A delegated patch must not even populate the settings cache.
        assert_eq!(store.settings_store().load_settings_sync().unwrap(), None);
    }

    /// R7: a non-object payload is rejected with the handler's own message,
    /// before any read or write.
    #[test]
    fn non_object_patches_are_rejected_before_the_store_is_read() {
        let fixture = Fixture::new(None, "{\"schemaVersion\":3,\"profiles\":[]}");
        let store = fixture.store("advanced");
        for args in [json!({"t":"array","v":[]}), json!({"t":"array","v":[{"t":"undefined"}]}),
            json!({"t":"array","v":[{"t":"null"}]}), json!({"t":"array","v":[{"t":"string","v":"x"}]}),
            json!({"t":"array","v":[{"t":"number","v":42}]}), json!({"t":"array","v":[{"t":"boolean","v":true}]}),
            json!({"t":"array","v":[{"t":"array","v":[]}]})] {
            assert_eq!(handle(&store, &args, BuildKind::Dev).unwrap().unwrap_err(), PATCH_ERROR);
        }
        assert_eq!(store.settings_store().load_settings_sync().unwrap(), None);
        assert!(!fixture.0.join("settings.json").exists());
    }

    /// R3: the registration is derived from the merged intent and written
    /// BEFORE the settings; a failure still persists, and only a packaged
    /// build whose patch carried explicit startup intent reports the error.
    #[test]
    fn startup_matrix_matches_the_handler() {
        let profiles = json!([{"id":"p1","deviceKey":"gpu-a"}]);
        // (stored settings, expected registration)
        let rows = [
            (json!({"startWithWindows":false,"ocOnBoot":false}), false),
            (json!({"startWithWindows":true,"ocOnBoot":false}), true),
            (json!({"startWithWindows":false,"ocOnBoot":true}), false),
            (json!({"ocOnBoot":true,"activeProfileId":"p1"}), true),
            // The legacy scalar fallback survives a missing profile.
            (json!({"ocOnBoot":true,"activeProfileId":"ghost"}), true),
            (json!({"ocOnBoot":true,"activeProfileIds":{"gpu-a":"p1"}}), true),
            // A bound profile can only be active for its own adapter.
            (json!({"ocOnBoot":true,"activeProfileIds":{"gpu-b":"p1"}}), false),
            (json!({"ocOnBoot":true,"activeProfileIds":{"gpu-a":"ghost"}}), false),
            (json!({"ocOnBoot":true,"activeProfileId":null,"activeProfileIds":{"gpu-a":"p1"}}), true),
        ];
        for (settings, wanted) in rows {
            // `theme` carries no startup intent; `ocOnBoot` does.
            for (patch, explicit_intent) in [(json!({"ocOnBoot":true}), true), (json!({"theme":"light"}), false)] {
                for register_ok in [true, false] {
                    for kind in [BuildKind::Dev, BuildKind::Installed] {
                        let label = format!("{settings} {patch} register_ok={register_ok} {kind:?}");
                        let fixture = Fixture::new(None, "{\"schemaVersion\":3,\"profiles\":[]}");
                        let store = fixture.store("advanced");
                        store.settings_store().save_settings(&settings).unwrap();
                        store.invoke("save-profiles", &encode_json(&json!([profiles])).unwrap()).unwrap();
                        let mut calls = Vec::new();
                        let mut at_registration = Vec::new();
                        let result = apply(&store, &patch, kind, |enabled| {
                            calls.push(enabled);
                            // The registration write must precede the settings
                            // write, so the file still holds the pre-save value.
                            at_registration.push(fs::read(fixture.0.join("settings.json")).ok());
                            if register_ok { Ok(()) } else { Err("startup-set: denied".into()) }
                        });
                        assert_eq!(calls, vec![wanted], "registration intent: {label}");
                        let before = at_registration.pop().unwrap()
                            .map(|bytes| serde_json::from_slice::<Value>(&bytes).unwrap())
                            .unwrap();
                        // Both fields a patch can move still hold their stored
                        // value, so the registration provably runs first.
                        assert_eq!(before["ocOnBoot"], json!(settings["ocOnBoot"] == json!(true)),
                            "the registration runs before the settings write: {label}");
                        assert_eq!(before["theme"], json!(match settings["theme"].as_str() {
                            Some(theme) if THEMES.contains(&theme) => theme,
                            _ => "dark",
                        }), "the registration runs before the settings write: {label}");
                        let expected_error = !register_ok && kind != BuildKind::Dev && explicit_intent;
                        match result {
                            Ok(next) => {
                                assert!(!expected_error, "a labelled startup failure must be reported: {label}");
                                assert_eq!(next["ocOnBoot"], patch.get("ocOnBoot").map(|value| value == &json!(true))
                                    .unwrap_or(settings["ocOnBoot"] == json!(true)),
                                    "next mirrors the merged intent: {label}");
                                let read = store.settings_store().load_settings().unwrap();
                                assert_eq!(read["theme"], next["theme"], "the save still persists: {label}");
                            }
                            Err(error) => {
                                assert!(expected_error, "only packaged + explicit intent reports it: {label}");
                                assert_eq!(error, "startup-set: denied", "{label}");
                                let read = store.settings_store().load_settings().unwrap();
                                assert_eq!(read["ocOnBoot"], true,
                                    "settings still persisted on a registration error: {label}");
                            }
                        }
                    }
                }
            }
        }
    }

    /// R4: an Arc Sleep patch merges into the cached policy through the Arc
    /// Sleep writer, so the controller's cached-policy adoption sees it, and
    /// no unrelated field moves.
    #[test]
    fn arc_sleep_patches_merge_through_the_arc_sleep_writer() {
        // The generic save path deliberately cannot replace Arc Sleep state, so
        // the seed is the stored document itself.
        let seed = json!({"schemaVersion":3,
            "waiverAccepted":true,"deviceKey":"gpu-a","ocMode":"advanced","theme":"midnight",
            "activeProfileIds":{"gpu-a":"p1"},"ocModes":{"gpu-a":"advanced"},
            "rtssOnBoot":true,"monitorLogMetrics":["fps"],
            "arcSleep":{"idleEnabled":false,"adaptiveEnabled":false,"idleAfterSeconds":900,"idleFps":30,
                "adaptiveMinFps":90,"adaptiveMaxFps":120,"adaptiveTargetLoadPct":85},
        });
        let fixture = Fixture::new(Some(&seed.to_string()), "{\"schemaVersion\":3,\"profiles\":[]}");
        let store = fixture.store("advanced");
        let before = store.settings_store().load_settings().unwrap();

        let next = apply(&store, &json!({"arcSleep":{"idleEnabled":true,"idleFps":45}}), BuildKind::Dev, |_| Ok(())).unwrap();
        assert_eq!(next["arcSleep"], json!({
            "idleEnabled":true,"adaptiveEnabled":false,"idleAfterSeconds":900,"idleFps":45,
            "adaptiveMinFps":90,"adaptiveMaxFps":120,"adaptiveTargetLoadPct":85,
        }));
        // The controller reads this cache on its next cadence.
        assert_eq!(store.settings_store().load_settings_sync().unwrap().unwrap()["arcSleep"], next["arcSleep"]);
        let after = store.settings_store().load_settings().unwrap();
        for key in ["waiverAccepted", "deviceKey", "activeProfileIds", "ocModes", "rtssOnBoot",
            "monitorLogMetrics", "ocMode", "theme"] {
            assert_eq!(after[key], before[key], "{key} must not move");
        }
        assert_eq!(after["arcSleep"]["idleAfterSeconds"], 900);
    }

    /// Phase 2: the four promoted flags answer the patch-aware `=== true`
    /// coercion - an absent key keeps the stored value and any non-true patch
    /// value is FALSE, never the stored true - and the settings cache that the
    /// `settings-cache` push reads carries the answer for the whole snapshot.
    #[test]
    fn promoted_flags_coerce_the_patch_and_publish_the_cache() {
        let seed = json!({"schemaVersion":3,"startMinimized":true,"closeToTray":true,
            "overlayRecordingPill":true,"recordingToastsEnabled":true,"theme":"red"});
        let flags = |value: &Value| json!([value["startMinimized"], value["closeToTray"],
            value["overlayRecordingPill"], value["recordingToastsEnabled"]]);
        // (patch, expected [startMinimized, closeToTray, pill, toasts]).
        let rows = [
            (json!({"startMinimized":false}), json!([false, true, true, true])),
            (json!({"closeToTray":false}), json!([true, false, true, true])),
            (json!({"overlayRecordingPill":false}), json!([true, true, false, true])),
            (json!({"recordingToastsEnabled":false}), json!([true, true, true, false])),
            // `patch.x === true`: a non-true value reads false, not the stored true.
            (json!({"closeToTray":"true"}), json!([true, false, true, true])),
            (json!({"startMinimized":1}), json!([false, true, true, true])),
            (json!({"overlayRecordingPill":0}), json!([true, true, false, true])),
            (json!({"recordingToastsEnabled":"yes"}), json!([true, true, true, false])),
            // An absent key keeps the stored value.
            (json!({"theme":"light"}), json!([true, true, true, true])),
            (json!({"startWithWindows":true,"closeToTray":false}), json!([true, false, true, true])),
        ];
        for (patch, expected) in rows {
            let fixture = Fixture::new(Some(&seed.to_string()), "{\"schemaVersion\":3,\"profiles\":[]}");
            let store = fixture.store("advanced");
            let next = handle(&store, &encode_json(&json!([patch.clone()])).unwrap(), BuildKind::Dev)
                .unwrap_or_else(|| panic!("{patch} is a native save")).unwrap();
            assert_eq!(flags(&next), expected, "{patch}: reply");
            // The push payload source: a blocking in-memory snapshot, no I/O.
            let snapshot = store.settings_store().load_settings_sync().unwrap()
                .unwrap_or_else(|| panic!("{patch}: the save publishes the settings cache"));
            assert_eq!(flags(&snapshot), expected, "{patch}: pushed snapshot");
            assert_eq!(snapshot["theme"], if patch.get("theme").is_some() { json!("light") } else { json!("red") },
                "{patch}: an unrelated field must not move");
        }
        // The same coercion in the other direction: a stored false becomes true.
        let off = json!({"schemaVersion":3,"startMinimized":false,"closeToTray":false,
            "overlayRecordingPill":false,"recordingToastsEnabled":false});
        let fixture = Fixture::new(Some(&off.to_string()), "{\"schemaVersion\":3,\"profiles\":[]}");
        let store = fixture.store("advanced");
        let next = handle(&store, &encode_json(&json!([{"closeToTray":true}])).unwrap(), BuildKind::Dev)
            .unwrap().unwrap();
        assert_eq!(flags(&next), json!([false, true, false, false]));
        assert_eq!(flags(&store.settings_store().load_settings_sync().unwrap().unwrap()),
            json!([false, true, false, false]));
    }

    #[test]
    fn phase1_and_delegated_key_lists_cover_the_handler_patch_keys() {
        assert_eq!(PHASE1_KEYS.iter().filter(|key| DELEGATED_KEYS.contains(key)).count(), 0);
        assert_eq!(PHASE1_KEYS.len() + DELEGATED_KEYS.len(), 35);
        for key in DELEGATED_KEYS { assert!(!PHASE1_KEYS.contains(&key)); }
    }
}
