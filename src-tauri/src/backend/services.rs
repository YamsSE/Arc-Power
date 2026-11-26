//! Incrementally migrated commands. Unknown channels are never reported as
//! successful; the host delegates them until their native implementation passes
//! compatibility checks and can replace the existing service.
use super::native_system::{self, BuildKind};
use super::game_candidate::canonical_exe_path;
use super::native_store::NativeStore;
use super::wire::{decode, encode_json, WireValue};
use serde_json::{json, Map, Value};
use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

/// Electron keeps a session map of accepted extended temperature setpoints
/// because the legacy V1 getter reports its 90 C sentinel after an extended
/// write. Mirror that map so a page refresh does not undo the visible setpoint.
static ACCEPTED_TEMPERATURES: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();

fn accepted_temperatures() -> &'static Mutex<HashMap<String, f64>> {
    ACCEPTED_TEMPERATURES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_accepted_temperature(device_key: &str, value: f64) {
    if !value.is_finite() { return; }
    if value <= 90.0 {
        if let Ok(mut map) = accepted_temperatures().lock() { map.remove(device_key); }
        return;
    }
    if let Ok(mut map) = accepted_temperatures().lock() { map.insert(device_key.to_owned(), value); }
}

fn accepted_temperature(device_key: &str) -> Option<f64> {
    accepted_temperatures().lock().ok().and_then(|map| map.get(device_key).copied())
}

/// Electron overrides the legacy V1 getter's 90 C sentinel with the accepted
/// extended setpoint for this session. Apply the same correction to a fresh
/// page/device read; a real getter value above the sentinel is trusted.
fn apply_accepted_temperature(state: &mut Value, device_key: &str) {
    let Some(accepted) = accepted_temperature(device_key) else { return; };
    let raw = state.get("tempLimitC").and_then(Value::as_f64);
    if raw.is_none_or(|raw| (raw - 90.0).abs() <= 0.5) {
        state["tempLimitC"] = json!(accepted);
        state["tempLimitCReadBackSource"] = json!("accepted-write");
        state["tempLimitCReadBackUnavailable"] = json!(false);
    }
}

/// Alchemist's negative-voltage Sysman path extends the V/F curve and can
/// make the IGCL frequency-offset getter report a derived positive value
/// (for example +172 MHz) after a voltage-only apply. Keep the user's
/// effective offset for this session so every later read (page refresh,
/// mode toggle, VF refresh) shows the requested value instead of the
/// driver's derived one. Cleared by a zero/positive voltage apply and by
/// reset-to-defaults.
static FREQUENCY_OFFSET_GUARDS: OnceLock<Mutex<HashMap<String, f64>>> = OnceLock::new();

fn frequency_offset_guards() -> &'static Mutex<HashMap<String, f64>> {
    FREQUENCY_OFFSET_GUARDS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_frequency_offset_guard(device_key: &str, value: f64) {
    if !value.is_finite() { return; }
    if let Ok(mut map) = frequency_offset_guards().lock() { map.insert(device_key.to_owned(), value); }
}

fn frequency_offset_guard(device_key: &str) -> Option<f64> {
    frequency_offset_guards().lock().ok().and_then(|map| map.get(device_key).copied())
}

pub fn forget_frequency_offset_guard(device_key: &str) {
    if let Ok(mut map) = frequency_offset_guards().lock() { map.remove(device_key); }
}

fn apply_frequency_offset_guard(state: &mut Value, device_key: &str) {
    let Some(value) = frequency_offset_guard(device_key) else { return; };
    if state.is_object() { state["gpuFreqOffsetMhz"] = json!(value); }
}

/// Electron exports this one string as `DISPLAY_SCALING_FLASH_WARNING` and
/// attaches it to every scaling surface, including the Retro method row.
const DISPLAY_SCALING_FLASH_WARNING: &str =
    "Changing the scaling mode may briefly flash the display while the driver applies the output state.";
const RETRO_SCALING_FLASH_WARNING: &str = DISPLAY_SCALING_FLASH_WARNING;

const RETRO_SCALING_RESTORED_MESSAGE: &str =
    "The previous Retro Scaling state was restored after the ordinary scaling request failed.";
const RETRO_SCALING_RESTORE_FAILED_MESSAGE: &str =
    "The previous Retro Scaling state could not be restored.";
const DEFERRED_GPU_SCALING_MESSAGE: &str =
    "GPU Scaling selection saved by the driver. No GPU resizing is needed at the current resolution.";
const IDENTITY_SCALING_MESSAGE: &str =
    "Display Scaling accepted. Arc Power remembers this selection separately from the last GPU method retained by the driver.";

/// A control that could not be started after an earlier control had already
/// changed the display. The request stays native-owned (a broker retry could
/// repeat those writes), so the control reports its own honest verdict.
const DISPLAY_CONTROL_NOT_ATTEMPTED_MESSAGE: &str =
    "The control was not attempted: the display state could not prove it safe to write after the earlier controls.";

/// Composed-only: the Scaling Mode transaction disabled the coupled Retro
/// surface and its restore of the previous state did not verify, so the
/// adapter-level Retro tuple is unknown. The plan must not write on that state,
/// and the entry must not claim the restoration Electron's own string implies.
const RETRO_SCALING_UNVERIFIED_MESSAGE: &str =
    "The previous Retro Scaling state could not be restored, so the current Retro Scaling state is unverified.";

#[derive(Clone, Copy)]
pub struct ServiceContext<'a> {
    pub build_kind: BuildKind,
    pub mock_mode: bool,
    pub store: &'a NativeStore,
}

pub fn invoke<'a>(channel: &str, args: &Value, context: ServiceContext<'a>) -> Option<Result<Value, String>> {
    let mut attempted_temperature = None;
    invoke_inner(channel, args, context, None, &mut attempted_temperature)
}

pub fn invoke_with_temperature_lease<'a>(
    channel: &str,
    args: &Value,
    context: ServiceContext<'a>,
    lease: &WireValue,
) -> Option<(Result<Value, String>, Option<f64>)> {
    let mut attempted_temperature = None;
    invoke_inner(channel, args, context, Some(lease), &mut attempted_temperature)
        .map(|result| (result, attempted_temperature))
}

/// Native-host bridge for the process-session temperature refusal cache.
/// The cache module remains an implementation detail of the backend service.
pub fn handle_temperature_refusal_cache_request(method: &str, encoded_args: &Value) -> Result<Value, String> {
    super::profile_apply_preflight::ProfileTempCeilings::handle_native_store_request(method, encoded_args)
        .and_then(|value| encode_json(&value))
}

fn invoke_inner<'a>(
    channel: &str,
    args: &Value,
    context: ServiceContext<'a>,
    temperature_lease: Option<&WireValue>,
    attempted_temperature: &mut Option<f64>,
) -> Option<Result<Value, String>> {
    if context.mock_mode && channel.starts_with("stream-") { return None; }
    if let Some(result) = native_system::invoke(channel, args, context.build_kind, context.mock_mode) {
        return Some(result);
    }
    match channel {
        "app-version" => Some((|| {
            no_payload(channel, args)?;
            encode_json(&json!({"version":env!("CARGO_PKG_VERSION")}))
        })()),
        "app-elevated" => Some((|| {
            no_payload(channel, args)?;
            let elevated = process_is_elevated();
            encode_json(&json!({"elevated":elevated,"workerApply":!elevated}))
        })()),
        "sysinfo:get" if !context.mock_mode => Some((|| {
            no_payload(channel, args)?;
            encode_json(&super::native_sysinfo::collect(Some(context.store)))
        })()),
        "health" if !context.mock_mode => Some((|| {
            no_payload(channel, args)?;
            let devices = super::gpu_devices::list_devices_merged();
            let driver_version = devices.as_array()
                .and_then(|rows| rows.first())
                .and_then(|device| device.get("driverVersion"))
                .cloned().unwrap_or(Value::Null);
            let report = json!({
                "backend": "igcl",
                "igclLoaded": true,
                "driverVersion": driver_version,
                "levelZeroOk": super::sysman::SysmanSession::load().is_ok(),
            });
            encode_json(&report)
        })()),
        "open-external" => Some(native_system::open_external(args).map(|_| json!({"t":"undefined"}))),
        "driver-monitor-status" if !context.mock_mode => Some((|| {
            no_payload_exact(channel, args)?;
            let monitor = super::driver_monitor::DriverMonitor::new(context.store.root().to_path_buf())?;
            encode_json(&monitor.status()?)
        })()),
        "driver-monitor-check" if !context.mock_mode => Some((|| {
            no_payload_exact(channel, args)?;
            let (devices, driver_date) = driver_monitor_inputs();
            let now = super::platform_context::clock_snapshot().map_err(|error| error.to_string())?.now_ms;
            let result = super::driver_monitor::check(context.store.root().to_path_buf(), &devices,
                driver_date.as_deref(), now)?;
            encode_json(&result)
        })()),
        "intel-driver-update-check" if !context.mock_mode => Some((|| {
            no_payload_exact(channel, args)?;
            encode_json(&intel_catalog()?.check())
        })()),
        "intel-driver-library" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 1 { return Err("intel-driver-library takes one payload".into()); }
            let kind = wire_string(items.first());
            if !valid_intel_kind(kind) { return Err("intel-driver-library: invalid kind".into()); }
            encode_json(&intel_catalog()?.library(kind.unwrap())?)
        })()),
        "intel-driver-release" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 2 { return Err("intel-driver-release takes two payloads".into()); }
            let kind = wire_string(items.first());
            let version = wire_string(items.get(1));
            validate_intel_download_identity(channel, kind, version)?;
            encode_json(&intel_catalog()?.resolve_release(kind.unwrap(), version.unwrap())?)
        })()),
        "intel-driver-download-status" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 2 { return Err("intel-driver-download-status takes two payloads".into()); }
            let kind = wire_string(items.first());
            let version = wire_string(items.get(1));
            validate_intel_download_identity(channel, kind, version)?;
            encode_json(&super::intel_driver_catalog::driver_download_status(
                context.store.root(), kind.unwrap(), version.unwrap()))
        })()),
        "intel-driver-download-page-open" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 2 { return Err("intel-driver-download-page-open takes one or two payloads".into()); }
            let kind = wire_string(items.first());
            if !valid_intel_kind(kind) { return Err("intel-driver-download-page-open: invalid kind".into()); }
            let kind = kind.unwrap();
            let url = match items.get(1) {
                None | Some(WireValue::Undefined) => super::intel_driver_catalog::official_download_page(kind)?.to_owned(),
                Some(WireValue::String(version)) => {
                    if !super::intel_driver_catalog::is_full_driver_version(version) {
                        return Err("intel-driver-download-page-open: invalid version".into());
                    }
                    let release = intel_catalog()?.resolve_release(kind, version)?;
                    release.get("officialPageUrl").and_then(Value::as_str)
                        .ok_or("intel-driver-download-page-open: invalid URL")?.to_owned()
                }
                Some(_) => return Err("intel-driver-download-page-open: invalid version".into()),
            };
            super::intel_driver_catalog::open_download_page(&url, kind)?;
            encode_json(&json!({"t":"undefined"}))
        })()),
        "intel-driver-download-start" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 3 { return Err("intel-driver-download-start takes three payloads".into()); }
            let kind = wire_string(items.first());
            let version = wire_string(items.get(1));
            validate_intel_download_identity(channel, kind, version)?;
            if !matches!(items.get(2), Some(WireValue::Bool(true))) {
                return Err("Intel license agreement must be explicitly accepted".into());
            }
            let service = super::intel_driver_download::IntelDriverDownloadService::shared(context.store.root())?;
            let mut progress = |payload: Value| {
                super::intel_driver_download::runtime_emit(super::intel_driver_download::PROGRESS_CHANNEL, payload);
            };
            encode_json(&service.start_download(kind.unwrap(), version.unwrap(), &mut progress)?)
        })()),
        "intel-driver-download-cancel" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 1 { return Err("intel-driver-download-cancel takes one payload".into()); }
            let kind = wire_string(items.first());
            if !valid_intel_kind(kind) { return Err("intel-driver-download-cancel: invalid kind".into()); }
            let service = super::intel_driver_download::IntelDriverDownloadService::shared(context.store.root())?;
            encode_json(&service.cancel_download(kind.unwrap())?)
        })()),
        "intel-driver-download-delete" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 2 { return Err("intel-driver-download-delete takes two payloads".into()); }
            let kind = wire_string(items.first());
            let version = wire_string(items.get(1));
            validate_intel_download_identity(channel, kind, version)?;
            let service = super::intel_driver_download::IntelDriverDownloadService::shared(context.store.root())?;
            encode_json(&service.delete_downloaded(kind.unwrap(), version.unwrap())?)
        })()),
        "intel-driver-install" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 2 { return Err("intel-driver-install takes two payloads".into()); }
            let kind = wire_string(items.first());
            let version = wire_string(items.get(1));
            validate_intel_download_identity(channel, kind, version)?;
            let service = super::intel_driver_download::IntelDriverDownloadService::shared(context.store.root())?;
            encode_json(&service.install_downloaded(kind.unwrap(), version.unwrap())?)
        })()),
        "recording-open-folder" => Some((|| {
            no_payload(channel, args)?;
            let path = recording_folder_path(context.store)?;
            std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
            native_system::open_path(&path)?;
            encode_json(&json!({"ok":true}))
        })()),
        "recording-storage-info" => Some((|| {
            no_payload(channel, args)?;
            let location = recording_folder_path(context.store)?;
            let (free, total) = std::path::Path::new(&location).ancestors().find(|path| path.exists())
                .and_then(|path| path.to_str()).and_then(disk_space)
                .map(|(free, total)| (Some(free), Some(total))).unwrap_or((None, None));
            encode_json(&json!({"location": location, "freeBytes": free, "totalBytes": total}))
        })()),
        "recording-processes-list" => Some((|| {
            no_payload(channel, args)?;
            encode_json(&json!(window_process_names()))
        })()),
        "recording-clip-copy" => Some((|| {
            let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
            if args.len() != 1 { return Err("recording-clip-copy expects one clip id".into()); }
            let WireValue::String(id) = &args[0] else { return Err("recording-clip-copy: invalid clip id".into()); };
            let path = recording_clip_path(context.store, id)?;
            super::clipboard::copy_files(&[path])?;
            encode_json(&json!({"ok":true}))
        })()),
        "postprocess-sharpening:get" | "postprocess-sharpening:set"
        | "postprocess-sharpening:select-window" | "postprocess-sharpening:stop-window"
        | "postprocess-sharpening:hotkey-get"
        | "arc-super-resolution:get" | "arc-super-resolution:set" if !context.mock_mode => {
            Some(super::postprocess_sharpening::invoke(channel, args, context.store)
                .and_then(|value| encode_json(&value)))
        }
        "postprocess-sharpening:hotkey-set" if !context.mock_mode => Some(
            super::settings_patch::with_save_queue(|| {
                super::postprocess_sharpening::invoke(channel, args, context.store)
                    .and_then(|value| encode_json(&value))
            })
        ),
        "recording-clips-list" if !context.mock_mode => Some((|| {
            no_payload(channel, args)?;
            encode_json(&super::recording_playback::clip_list(context.store)?)
        })()),
        "recording-clip-url" if !context.mock_mode => Some((|| {
            let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
            if args.len() != 1 { return Err("recording-clip-url expects one clip id".into()); }
            let WireValue::String(id) = &args[0] else { return Err("recording-clip-url: invalid clip id".into()); };
            encode_json(&json!(super::recording_playback::clip_url(context.store, id)?))
        })()),
        "recording-clip-delete" if !context.mock_mode => Some((|| {
            let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
            if args.len() != 1 { return Err("recording-clip-delete expects one clip id".into()); }
            let WireValue::String(id) = &args[0] else { return Err("recording-clip-delete: invalid clip id".into()); };
            encode_json(&super::recording_playback::clip_delete(context.store, id)?)
        })()),
        "recording-capture-targets" => Some((|| {
            let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
            if args.len() > 1 || args.first().is_some_and(|value| !matches!(value, WireValue::Bool(_))) {
                return Err("recording-capture-targets: refresh must be boolean".into());
            }
            encode_json(&super::capture_targets::capture_targets()?)
        })()),
        "monitor-log-append" => Some((|| {
            let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
            if args.len() != 1 { return Err("monitor-log-append expects one sample".into()); }
            let WireValue::Object(sample) = &args[0] else {
                return Err("monitor-log-append: sample must be a plain object".into());
            };
            encode_json(&super::monitor_log::append(sample))
        })()),
        "stream-connect" => Some((|| {
            let payload = optional_object(args)?.unwrap_or_else(|| json!({}));
            let stored = native_json(context.store, "obs-credential-load", json!([])).ok()
                .and_then(|value| value.as_str().map(str::to_owned));
            let provided = payload.get("password").and_then(Value::as_str).map(str::to_owned);
            if let Some(password) = &provided {
                let _ = native_json(context.store, "obs-credential-save", json!([password]));
            }
            let status = {
                let mut service = super::obs_stream::service().lock()
                    .map_err(|_| "OBS service lock is poisoned".to_owned())?;
                service.connect(&payload, provided.as_deref().or(stored.as_deref()))?
            };
            encode_json(&status)
        })()),
        "stream-status" => Some((|| {
            optional_object(args)?;
            let service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.status())
        })()),
        "stream-disconnect" => Some((|| {
            optional_object(args)?;
            let mut service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.disconnect())
        })()),
        "stream-scenes" => Some((|| {
            optional_object(args)?;
            let mut service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.scenes()?)
        })()),
        "stream-scene-set" => Some((|| {
            let payload = optional_object(args)?.unwrap_or_else(|| json!({}));
            let mut service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.set_scene(&payload)?)
        })()),
        "stream-start" => Some((|| {
            optional_object(args)?;
            let mut service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.start_stream()?)
        })()),
        "stream-stop" => Some((|| {
            optional_object(args)?;
            let mut service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.stop_stream()?)
        })()),
        "stream-microphone-mute" => Some((|| {
            let payload = optional_object(args)?.unwrap_or_else(|| json!({}));
            let mut service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.set_microphone_mute(&payload)?)
        })()),
        "stream-duck" => Some((|| {
            optional_object(args)?;
            let mut service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.duck()?)
        })()),
        "stream-duck-restore" => Some((|| {
            optional_object(args)?;
            let mut service = super::obs_stream::service().lock()
                .map_err(|_| "OBS service lock is poisoned".to_owned())?;
            encode_json(&service.restore_ducking())
        })()),
        "recording-choose-folder" => Some((|| {
            no_payload(channel, args)?;
            let default = recording_folder_path(context.store).ok();
            encode_json(&recording_folder_selection(context.store, super::dialogs::pick_folder(default.as_deref())?)?)
        })()),
        "game-catalog-add" => Some((|| {
            no_payload(channel, args)?;
            let reply = match super::dialogs::pick_executable(None)? {
                Some(path) => add_game_catalog_path(context.store, &path)?,
                None => game_catalog_canceled(context.store)?,
            };
            encode_json(&reply)
        })()),
        "profiles-list" => Some((|| {
            no_payload(channel, args)?;
            let profiles = native_json(context.store, "load-profiles", json!([]))?;
            let settings = native_json(context.store, "load-settings", json!([]))?;
            encode_json(&json!({"profiles": profiles, "settings": settings}))
        })()),
        "profiles-export" if !context.mock_mode => Some((|| {
            match decode(args)? {
                WireValue::Array(items) if items.is_empty() => {}
                _ => return Err("profiles-export takes no payload".into()),
            }
            let clock = super::platform_context::clock_snapshot().map_err(|error| error.to_string())?;
            let devices = super::gpu_devices::list_devices_merged();
            encode_json(&super::profile_transfer::export_envelope(context.store, &devices, &clock.now_iso)?)
        })()),
        "profiles-import" if !context.mock_mode => Some((|| {
            super::settings_patch::with_save_queue(|| {
                let WireValue::Array(items) = decode(args)? else { return Err("Expected argument array".into()); };
                let payload = items.first().cloned().unwrap_or(WireValue::Undefined);
                let devices = super::gpu_devices::list_devices_merged();
                encode_json(&super::profile_transfer::import_payload(context.store, &payload, &devices)?)
            })
        })()),
        "profiles-save" if !context.mock_mode => Some((|| {
            let WireValue::Array(items) = decode(args)? else { return Err("Expected argument array".into()); };
            let payload = items.first().cloned().unwrap_or(WireValue::Undefined);
            encode_json(&super::profile_write::save_profile(context.store, &WireValue::Array(vec![payload]), None)?)
        })()),
        "profiles-delete" if !context.mock_mode => Some((|| {
            super::settings_patch::with_save_queue(|| {
                let WireValue::Array(items) = decode(args)? else { return Err("Expected argument array".into()); };
                let payload = items.first().cloned().unwrap_or(WireValue::Undefined);
                encode_json(&super::profile_write::delete_profile(context.store, &WireValue::Array(vec![payload]))?)
            })
        })()),
        // The settings patch owns the settings-domain keys, the four cache
        // flags, Advanced Overlay fields whose panel/hotkey reactions are
        // native, and the RTSS boot preference. Remaining callback-owned
        // patches (classic overlay, Scale hotkey, memory saving, unknown
        // keys) delegate WHOLE before any read or write.
        "profiles-settings-save" if !context.mock_mode => {
            // `settings_patch` owns a plain-JSON reply. Every other native
            // channel returns wire-encoded values, and the renderer bridge
            // decodes every reply with `decodeWire` - returning the raw object
            // here made every native key fail with "Invalid wire value".
            super::settings_patch::handle(context.store, args, context.build_kind)
                .map(|result| result.and_then(|value| encode_json(&value)))
        }
        "startup-get" if !context.mock_mode => Some((|| {
            no_payload(channel, args)?;
            encode_json(&super::startup::state(context.store, context.build_kind)?)
        })()),
        "startup-set" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() != 1 { return Err("startup-set: enabled must be a boolean".into()); }
            let WireValue::Bool(enabled) = items[0] else { return Err("startup-set: enabled must be a boolean".into()); };
            super::startup::set_registration(context.build_kind, enabled)?;
            encode_json(&super::startup::state(context.store, context.build_kind)?)
        })()),
        "rtssStartupGet" if !context.mock_mode => Some((|| {
            no_payload(channel, args)?;
            super::settings_patch::with_save_queue(|| {
                let mut state = super::rtss_startup::state()?;
                let settings = native_json(context.store, "load-settings", json!([]))?;
                state["rtssOnBoot"] = json!(settings.get("rtssOnBoot").and_then(Value::as_bool) == Some(true));
                encode_json(&state)
            })
        })()),
        "rtssStartupSet" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() != 1 { return Err("rtssStartupSet: enabled must be a boolean".into()); }
            let WireValue::Bool(enabled) = items[0] else { return Err("rtssStartupSet: enabled must be a boolean".into()); };
            super::settings_patch::with_save_queue(|| {
                let mut state = super::rtss_startup::set(enabled)?;
                let mut settings = native_json(context.store, "load-settings", json!([]))?;
                if !settings.is_object() { settings = json!({}); }
                settings["rtssOnBoot"] = json!(enabled);
                native_json(context.store, "save-settings", json!([settings]))?;
                state["rtssOnBoot"] = json!(enabled);
                encode_json(&state)
            })
        })()),
        "profiles-rename" => Some((|| {
            let WireValue::Array(items) = decode(args)? else { return Err("profiles-rename expects two arguments".into()); };
            if items.len() != 2 { return Err("profiles-rename expects two arguments".into()); }
            let WireValue::String(id) = &items[0] else { return Err("profiles-rename: id must be a non-empty string".into()); };
            if id.is_empty() { return Err("profiles-rename: id must be a non-empty string".into()); }
            let WireValue::String(name) = &items[1] else { return Err("profiles-rename: name must be a non-empty string".into()); };
            let name = name.trim();
            if name.is_empty() { return Err("profiles-rename: name must be a non-empty string".into()); }
            let profiles = native_json(context.store, "load-profiles", json!([]))?;
            let mut profile = profiles.as_array().into_iter().flatten()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(id))
                .cloned()
                .ok_or_else(|| format!("profiles-rename: profile '{id}' not found"))?;
            profile["name"] = json!(name);
            native_json(context.store, "save-profile", json!([profile]))?;
            let profiles = native_json(context.store, "load-profiles", json!([]))?;
            let settings = native_json(context.store, "load-settings", json!([]))?;
            encode_json(&json!({"profiles": profiles, "settings": settings}))
        })()),
        "device-get" => Some((|| {
            no_payload(channel, args)?;
            let settings = native_json(context.store, "load-settings", json!([]))?;
            encode_json(&json!({
                "deviceId": settings.get("deviceId").cloned().unwrap_or(Value::Null),
                "deviceKey": settings.get("deviceKey").cloned().unwrap_or(Value::Null),
            }))
        })()),
        // The native preference reader only replaces Electron once inventory
        // and active-display proof are both available; otherwise it delegates.
        "device-preferred-get" if !context.mock_mode => {
            match no_payload_exact(channel, args) {
                Err(error) => Some(Err(error)),
                Ok(()) => {
                    let devices = super::gpu_devices::list_devices_merged();
                    let rows = devices.as_array().map(Vec::as_slice).unwrap_or(&[]);
                    super::device_selection::preferred_from_inventory(rows)
                        .map(|value| encode_json(&value))
                }
            }
        }
        // device-set is the only writer for the persisted device pair. The
        // native path keeps Electron's validation order and delegates when no
        // reliable inventory is present.
        "device-set" if !context.mock_mode => {
            let devices = super::gpu_devices::list_devices_merged();
            let rows = devices.as_array().map(Vec::as_slice).unwrap_or(&[]);
            if rows.is_empty() { None } else {
                Some(super::settings_patch::with_save_queue(|| {
                    match super::device_selection::device_set_or_none(context.store, rows, args) {
                        Some(result) => result.and_then(|value| encode_json(&value)),
                        None => Err("device-set: inventory is unavailable".into()),
                    }
                }))
            }
        }
        "advanced-mode-accepted-get" => Some((|| {
            no_payload(channel, args)?;
            let settings = native_json(context.store, "load-settings", json!([]))?;
            encode_json(&json!({"accepted": settings["advancedModeAccepted"].as_bool() == Some(true)}))
        })()),
        "advanced-mode-accepted-set" => Some(super::settings_patch::with_save_queue(|| {
            no_payload(channel, args)?;
            let mut settings = native_json(context.store, "load-settings", json!([]))?;
            if !settings.is_object() { settings = json!({}); }
            settings["advancedModeAccepted"] = json!(true);
            native_json(context.store, "save-settings", json!([settings]))?;
            encode_json(&json!({"accepted": true}))
        })),
        // OC mode is written to the native settings store, while in a mock run
        // the capability surface (including caps.ocMode) comes from Electron's
        // MockBackend. Keeping the writer native would let the two surfaces
        // disagree and the Tuning page's post-toggle caps re-read would snap
        // the toggle back. Both channels therefore delegate to the broker in
        // mock mode so the mode and its capability surface share one owner.
        "oc-mode-get" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() != 1 { return Err("oc-mode-get takes one device id".into()); }
            let device_id = optional_device_id(&items[0], "oc-mode-get")?;
            let settings = native_json(context.store, "load-settings", json!([]))?;
            if device_id.is_none() {
                return encode_json(&json!({"ocMode": settings["ocMode"].as_str().unwrap_or("stock")}));
            }
            let device_key = resolve_device_key(device_id.unwrap(), "oc-mode-get")?;
            match device_key {
                Some(device_key) => encode_json(&oc_mode_get(&settings, Some(&device_key))),
                None => encode_json(&json!({"ocMode":"stock","deviceKey":Value::Null,"identityConflict":true})),
            }
        })()),
        "oc-mode-set" if !context.mock_mode => Some(super::settings_patch::with_save_queue(|| {
            let items = args_array(channel, args)?;
            if items.len() != 4 { return Err("oc-mode-set expects mode, device id, device key and current mode".into()); }
            let WireValue::String(mode) = &items[0] else { return Err("oc-mode-set: ocMode must be stock or advanced".into()); };
            if mode != "stock" && mode != "advanced" { return Err("oc-mode-set: ocMode must be stock or advanced".into()); }
            let device_id = optional_device_id(&items[1], "oc-mode-set")?;
            let expected_key = optional_string(&items[2], "oc-mode-set")?;
            let expected_mode = optional_string(&items[3], "oc-mode-set")?;
            if expected_mode.as_deref().is_some_and(|mode| mode != "stock" && mode != "advanced") {
                return Err("oc-mode-set: expected current mode must be stock, advanced or null".into());
            }
            let mut settings = native_json(context.store, "load-settings", json!([]))?;
            if !settings.is_object() { settings = json!({}); }
            let device_key = match device_id {
                Some(device_id) => {
                    let device_key = match resolve_device_key(device_id, "oc-mode-set")? {
                        Some(device_key) => device_key,
                        None => return Err("oc-mode-set: selected GPU identity changed; refresh and try again".into()),
                    };
                    if expected_key.as_deref().is_some_and(|expected| expected != device_key) {
                        return Err("oc-mode-set: device key mismatch".into());
                    }
                    let current = oc_mode_get(&settings, Some(&device_key));
                    let current = current["ocMode"].as_str().unwrap_or("stock");
                    if expected_mode.as_deref().is_some_and(|expected| expected != current) {
                        return Err("oc-mode-set: current mode changed".into());
                    }
                    Some(device_key)
                }
                None => None,
            };
            let result = oc_mode_set(&mut settings, mode, device_key.as_deref());
            native_json(context.store, "save-settings", json!([settings]))?;
            encode_json(&result)
        })),
        "waiver-get" if !context.mock_mode => {
            let device_id = match device_id_arg(channel, args) {
                Ok(device_id) => device_id,
                Err(error) => return Some(Err(error)),
            };
            let path = match super::gpu_devices::locate_dll() {
                Some(path) => path,
                None => return waiver_read_failure(context.build_kind, "Intel graphics runtime was not found"),
            };
            let identity = match refusal_cache_identity_for_device_id(&path, device_id) {
                Ok(identity) => identity,
                Err(error) => return waiver_read_failure(context.build_kind, &error),
            };
            let (mode, waiver) = match native_mode_waiver_for_key(context.store, &identity.device_key) {
                Some(value) => value,
                None => return waiver_read_failure(context.build_kind, "GPU identity or mode settings are unavailable"),
            };
            let caps = match super::gpu_capabilities::capabilities_for_identity_without_fan_probe(&path, &identity, &mode, waiver) {
                Ok(caps) => caps,
                Err(error) => return waiver_read_failure(context.build_kind, &error),
            };
            Some(if caps["overclockingSupported"].as_bool() == Some(false) {
                encode_json(&json!({"accepted": false, "required": false}))
            } else {
                encode_json(&json!({"accepted": caps["waiverAccepted"].as_bool() == Some(true), "required": true}))
            })
        }
        "waiver-accept" if !context.mock_mode => {
            let (device_id, expected) = match waiver_accept_args(args, context.build_kind) {
                Ok(value) => value,
                Err(error) => return Some(Err(error)),
            };
            let path = match super::gpu_devices::locate_dll() { Some(path) => path, None => return waiver_read_failure(context.build_kind, "Intel graphics runtime was not found") };
            let identity = match refusal_cache_identity_for_device_id(&path, device_id) {
                Ok(identity) => identity,
                Err(error) => return waiver_read_failure(context.build_kind, &error),
            };
            if let Some(expected) = expected {
                if let Err(error) = super::gpu_apply_identity::ensure_same_target(&expected, &identity) {
                    return Some(Err(error));
                }
            }
            let (mode, waiver) = match native_mode_waiver_for_key(context.store, &identity.device_key) {
                Some(value) => value,
                None => return waiver_read_failure(context.build_kind, "GPU identity or mode settings are unavailable"),
            };
            let caps = match super::gpu_capabilities::capabilities_for_identity_without_fan_probe(&path, &identity, &mode, waiver) {
                Ok(caps) => caps,
                Err(error) => return waiver_read_failure(context.build_kind, &error),
            };
            if caps["overclockingSupported"].as_bool() == Some(false) {
                return Some(encode_json(&json!({"accepted": false, "required": false})));
            }
            let (mut igcl, raw_index, _) = match super::gpu_capabilities::open_for_identity(&path, &identity) {
                Ok(session) => session,
                Err(error) => return waiver_read_failure(context.build_kind, &error),
            };
            let status = igcl.apply_waiver(raw_index);
            let _ = igcl.close();
            if let Err(error) = status { return Some(Err(error.to_string())); }
            Some(super::settings_patch::with_save_queue(|| {
                let mut settings = native_json(context.store, "load-settings", json!([]))?;
                if !settings.is_object() { settings = json!({}); }
                settings["waiverAccepted"] = json!(true);
                native_json(context.store, "save-settings", json!([settings]))?;
                encode_json(&json!({"accepted": true, "required": true}))
            }))
        }
        "apply-settings" if !context.mock_mode && !process_is_elevated() => {
            match native_apply_payload(args) {
                Err(error) => Some(Err(error)),
                Ok(_) => None,
            }
        }
        "apply-settings" if !context.mock_mode && process_is_elevated() => {
            // A profile apply claims the native seam only with the renderer's
            // complete target proof; its proof errors must match the direct
            // apply's exactly.
            let profile_payload = match native_profile_apply_candidate(args) {
                Ok(payload) => payload,
                Err(error) => return Some(Err(error)),
            };
            let profile_apply = matches!(profile_payload, Some(_));
            let NativeApplyPayload { device_id, settings: requested_settings, expected_identity, .. } = match profile_payload {
                Some(payload) => payload,
                None => match native_apply_payload_with_temperature(args, temperature_lease.is_some()) {
                    Ok(Some(payload)) => payload,
                    Ok(None) => {
                        if !matches!(context.build_kind, BuildKind::Dev) {
                            if let Some(reason) = native_direct_apply_decline_reason(args) { return Some(Err(reason.into())); }
                        }
                        return None;
                    }
                    Err(error) => return Some(Err(error)),
                },
            };
            let requested_temperature = requested_settings.get("tempLimitC")
                .and_then(Value::as_f64).filter(|value| value.is_finite());
            let leased_temperature = temperature_lease.is_some() && requested_temperature.is_some();
            if temperature_lease.is_some() && !leased_temperature { return None; }
            // A profile is never an excuse for a second, unleased temperature
            // writer: an unleased profile temperature keeps its compatibility
            // broker route (lease begin/finish publication included).
            if profile_apply && requested_temperature.is_some() && temperature_lease.is_none() {
                return None;
            }
            // The caller's selected key and PCI/BDF proof must match this
            // inventory snapshot before any capability read or write.
            if expected_identity.vendor != 0x8086 { return None; }
            let _apply_lock = if leased_temperature { None } else {
                match super::apply_lock::acquire() {
                    Ok(lock) => Some(lock),
                    Err(error) => return Some(Err(error)),
                }
            };
            let path = match super::gpu_devices::locate_dll() { Some(path) => path, None => return None };
            if let Err(error) = validate_apply_target(&path, device_id, &expected_identity) {
                return if leased_temperature { None } else { Some(Err(error)) };
            }
            if leased_temperature || profile_apply {
                // Duplicate rows or a conflicting LUID are ambiguous identity:
                // delegate (no native write) instead of risking the wrong
                // adapter.
                let fresh_identity = match refusal_cache_identity_for_device_id(&path, device_id) {
                    Ok(identity) => identity,
                    Err(_) => return None,
                };
                if super::gpu_apply_identity::ensure_same_target(&expected_identity, &fresh_identity).is_err() {
                    return None;
                }
            }
            let (stored_mode, waiver) = match native_mode_waiver_for_key(context.store, &expected_identity.device_key) {
                Some(value) => value,
                None => return Some(Err("GPU mode settings are unavailable".into())),
            };
            // M4O: a profile apply always GATES as advanced (the stock/advanced
            // mode is the interactive slider gate only - a saved profile
            // applies as saved against the driver's TRUE limits), while its
            // capability read keeps the stored mode like the broker's
            // getCapabilities does.
            let mode = if profile_apply { "advanced".to_owned() } else { stored_mode.clone() };
            let mut caps = match super::gpu_capabilities::capabilities_for_identity(&path, &expected_identity, &stored_mode, waiver) {
                Ok(caps) => caps,
                Err(error) if native_only_capabilities_fallback_allowed(context.build_kind, &error) => {
                    match native_capabilities_with_probe_or_read_only(
                        &path, &expected_identity, &stored_mode, waiver,
                    ) {
                        Ok(caps) => caps,
                        Err(error) => return Some(Err(error)),
                    }
                }
                Err(error) if native_capability_error_deferable(&error) => return None,
                Err(_error) if leased_temperature => return None,
                Err(error) => return Some(Err(error)),
            };
            if leased_temperature {
                let lease = match validate_temperature_lease_snapshot(
                    temperature_lease.expect("leased temperature has a snapshot"),
                    device_id,
                    &requested_settings,
                    &expected_identity,
                ) {
                    Ok(lease) => lease,
                    Err(error) => return Some(Err(format!("native-temperature-preflight-declined: {error}"))),
                };
                let cache_identity = match refusal_cache_identity_for_device_id(&path, device_id) {
                    Ok(identity) => identity,
                    Err(_) => return None,
                };
                if super::gpu_apply_identity::ensure_same_target(&expected_identity, &cache_identity).is_err() {
                    return None;
                }
                let cache = match super::profile_apply_preflight::ProfileTempCeilings::snapshot_for_device(
                    &cache_identity.device_key,
                ) {
                    Ok(cache) => cache,
                    Err(_) => return None,
                };
                let current_ceiling = cache.get("ceilings").and_then(|ceilings| ceilings.get("tempLimitC"))
                    .and_then(Value::as_f64);
                let cache_generation = cache.get("generation").and_then(Value::as_u64);
                if cache.get("status").and_then(Value::as_str) != Some("available")
                    || cache_generation != Some(lease.cache_generation)
                    || current_ceiling != lease.learned_ceiling {
                    return None;
                }
                // The lease snapshots capabilities using the stored mode;
                // profile applies separately use advanced mode for write gating.
                if !temperature_lease_mode_matches_stored(lease.oc_mode.as_deref(), &stored_mode)
                    || !temperature_ranges_compatible(
                        caps.get("ranges").and_then(|ranges| ranges.get("tempLimitC")),
                        &lease.range,
                    ) {
                    return None;
                }
                caps["ranges"]["tempLimitC"] = lease.range.clone();
                if let Some(ceiling) = lease.learned_ceiling {
                    if !caps.get("learnedCeilings").is_some_and(Value::is_object) {
                        caps["learnedCeilings"] = json!({});
                    }
                    caps["learnedCeilings"]["tempLimitC"] = json!(ceiling);
                } else if let Some(learned) = caps.get_mut("learnedCeilings").and_then(Value::as_object_mut) {
                    learned.remove("tempLimitC");
                }
                let _lease_ordering = (&lease.epoch, lease.transaction_sequence, lease.cache_generation, &lease.target);
            }
            let request_has_fan = ["fanMode", "fanCurve", "fixedFanPct"].iter()
                .any(|key| requested_settings.get(*key).is_some_and(|value| !value.is_null()));
            if caps.get("overclockingSupported") == Some(&Value::Bool(false)) {
                let mut per_control = Map::new();
                if let Some(entries) = requested_settings.as_object() {
                    for key in entries.keys() {
                        per_control.insert(key.clone(), json!({
                            "ok": false,
                            "errorCode": "unsupported",
                            "message": "overclocking is not supported on this GPU",
                        }));
                    }
                }
                let result = json!({"ok": per_control.is_empty(), "perControl": per_control});
                let state = super::gpu_capabilities::current_settings_for_identity(&path, &expected_identity).ok().unwrap_or(Value::Null);
                if request_has_fan {
                    super::fan_resume::notify_native_apply(&expected_identity, &requested_settings, &json!({"result": result, "state": state}));
                }
                return Some(encode_json(&json!({"result": result, "state": state})));
            }
            let ranges = caps.get("ranges");
            let apply_ranges = ranges;
            // Owned copies: the profile plan below rewrites caps["ranges"],
            // so no live borrow of caps may cross the plan block.
            let limits_pci_device_id = caps.get("pciDeviceId").and_then(Value::as_str).map(str::to_owned);
            let limits_aib_vendor = caps.get("aibVendor").and_then(Value::as_str).map(str::to_owned);
            let limits = super::apply_gates::LimitsKey {
                pci_device_id: limits_pci_device_id.as_deref(),
                aib_vendor: limits_aib_vendor.as_deref(),
            };
            if let Some(refusal) = super::apply_gates::oc_mode_refusal(&mode, &requested_settings, ranges, Some(limits)) {
                let state = super::gpu_capabilities::current_settings_for_identity(&path, &expected_identity).ok().unwrap_or(Value::Null);
                let result = json!({"ok": false, "perControl": super::apply_gates::refusal_per_control(&refusal)});
                if request_has_fan { super::fan_resume::notify_native_apply(&expected_identity, &requested_settings, &json!({"result": result, "state": state})); }
                return Some(encode_json(&json!({"result": result, "state": state, "ocModeRefused": true})));
            }
            // A profile temperature refusal is owned by the shared refusal
            // cache plan below (the broker's M50 gate): its ceiling is the
            // learned cache ceiling, never the mode-gated broker range.
            if leased_temperature && !profile_apply {
                let mut effective_ranges = super::apply_gates::extended_ranges_for(&caps);
                if let (Some(broker_range), Some(effective_range)) = (
                    caps.get("ranges").and_then(|ranges| ranges.get("tempLimitC")),
                    effective_ranges.get_mut("tempLimitC"),
                ) {
                    if let (Some(broker_max), Some(effective_max)) = (
                        broker_range.get("max").and_then(Value::as_f64),
                        effective_range.get("max").and_then(Value::as_f64),
                    ) {
                        if broker_max < effective_max {
                            effective_range["max"] = json!(broker_max);
                            if effective_range.get("default").and_then(Value::as_f64).is_some_and(|default| default > broker_max) {
                                effective_range["default"] = json!(broker_max);
                            }
                        }
                    }
                }
                if let Some(refusal) = super::apply_gates::temp_capability_refusal(&requested_settings, Some(&effective_ranges)) {
                    let state = super::gpu_capabilities::current_settings_for_identity(&path, &expected_identity).ok().unwrap_or(Value::Null);
                    let result = json!({"ok": false, "perControl": super::apply_gates::temp_capability_per_control(&refusal)});
                    return Some(encode_json(&json!({"result": result, "state": state})));
                }
            }
            // Keep the requested controls unchanged here. The scalar IGCL
            // backend performs its own range clamp at the setter boundary.
            let mut settings = requested_settings.clone();
            let mut stock_vf_profile = profile_apply
                && settings.get("vfCurveProfileStock") == Some(&Value::Bool(true));
            let profile_has_vf = profile_apply && settings.get("vfCurve").is_some();
            if stock_vf_profile || profile_has_vf {
                match resolve_profile_vf_settings(&settings, &caps, &path, &expected_identity) {
                    Ok((resolved, is_stock)) => {
                        settings = resolved;
                        stock_vf_profile = is_stock;
                    }
                    Err(reply) => return Some(encode_json(&reply)),
                }
            }
            let has_vf = settings.get("vfCurve").is_some();
            let has_fan = ["fanMode", "fanCurve", "fixedFanPct"].iter()
                .any(|key| settings.get(*key).is_some_and(|value| !value.is_null()));
            let has_lock = settings.get("gpuLock").is_some_and(|value| !value.is_null());
            let voltage_units_v = apply_ranges
                .and_then(|ranges| ranges.get("gpuVoltOffsetV"))
                .and_then(|range| range.get("units"))
                .and_then(Value::as_str) == Some("V");
            let voltage_request = voltage_units_v
                .then(|| settings.get("gpuVoltOffsetV").and_then(Value::as_f64))
                .flatten();
            let negative_voltage = voltage_request.is_some_and(|value| value < -0.0005);
            let zero_voltage = voltage_request.is_some_and(|value| value.abs() <= 0.0005);
            let positive_voltage = voltage_request.is_some_and(|value| value > 0.0005);
            let power_value = settings.get("powerLimitW").and_then(Value::as_f64);
            let sysman_power_requested = mode == "advanced"
                && apply_ranges.and_then(|ranges| ranges.get("powerLimitW")).and_then(|range| range.get("units")).and_then(Value::as_str) == Some("W")
                && power_value.is_some_and(|value| value > 315.0);
            let profile_driver_ranges = caps.get("driverRanges").cloned();
            let profile_legacy = if profile_apply {
                match super::apply_gates::split_profile_by_driver_witness(
                    &settings, profile_driver_ranges.as_ref(), sysman_power_requested,
                ) {
                    Ok((_, legacy)) => Some(legacy),
                    Err(error) => return Some(Err(error)),
                }
            } else { None };
            let mut unavailable_caps = caps.clone();
            if profile_apply {
                // M4O: a profile keys the extended-unavailable probe on the
                // bundled 2023 runtime's own capability (the broker's
                // oldIgcl.isCapable override), never on the stored mode the
                // caps read used.
                if let Some(map) = unavailable_caps.as_object_mut() {
                    let (legacy_power, legacy_temp) = super::legacy_igcl::capability();
                    map.insert("extendedRanges".into(), json!(legacy_power || legacy_temp));
                }
            }
            let mut plan_refusals = json!({});
            let mut extended_unavailable_partial = false;
            if profile_apply {
                let (routed_settings, refused) = native_profile_extended_unavailable_plan(
                    &settings,
                    &unavailable_caps,
                    profile_legacy.as_ref().expect("profile routing is preflighted"),
                );
                if refused.as_object().is_some_and(|entries| !entries.is_empty()) {
                    let routed_count = routed_settings.as_object().map(|entries| entries.len()).unwrap_or(0);
                    if routed_count == 0 {
                        let state = super::gpu_capabilities::current_settings_for_identity(&path, &expected_identity).ok().unwrap_or(Value::Null);
                        let reply = json!({"result":{"ok":false,"perControl":refused},"state":state,"extendedUnavailable":true});
                        return Some(encode_json(&reply));
                    }
                    plan_refusals = refused;
                    settings = routed_settings;
                    extended_unavailable_partial = true;
                }
                // M50: the shared process refusal cache owns the learned
                // temperature ceiling for profile applies. A cache error
                // declines (the broker reproduces the refusal-cache
                // envelope); a refused temperature is routed out of the
                // native write exactly like the broker's clamp step.
                let plan = match super::profile_apply_preflight::ProfileTempCeilings::plan_session_profile_apply(
                    &expected_identity.device_key, &settings, &caps,
                ) {
                    Ok(plan) => plan,
                    Err(_) => return None,
                };
                let refused_count = plan.refused_per_control.as_object().map(|map| map.len()).unwrap_or(0);
                let routed_count = plan.routed_settings.as_object().map(|map| map.len()).unwrap_or(0);
                if refused_count > 0 && routed_count == 0 {
                    let state = super::gpu_capabilities::current_settings_for_identity(&path, &expected_identity).ok().unwrap_or(Value::Null);
                    let cache_unavailable = plan.refused_per_control.as_object().is_some_and(|map| map.values().any(|entry| {
                        entry.get("errorCode").and_then(Value::as_str) == Some("refusal-cache-unavailable")
                    }));
                    let mut all_refusals = plan.refused_per_control;
                    if let (Some(merged), Some(extended)) = (all_refusals.as_object_mut(), plan_refusals.as_object()) {
                        for (key, value) in extended { merged.insert(key.clone(), value.clone()); }
                    }
                    let mut envelope = json!({"result": {"ok": false, "perControl": all_refusals}, "state": state});
                    if cache_unavailable {
                        envelope["temperatureRefusalCacheUnavailable"] = json!(true);
                    } else {
                        envelope["capabilityCeilingRefused"] = json!(true);
                    }
                    return Some(encode_json(&envelope));
                }
                let mut merged_refusals = plan.refused_per_control;
                if let (Some(merged), Some(extended)) = (
                    merged_refusals.as_object_mut(),
                    plan_refusals.as_object(),
                ) {
                    for (key, value) in extended { merged.insert(key.clone(), value.clone()); }
                }
                plan_refusals = merged_refusals;
                settings = plan.routed_settings;
                // M4O (NEW-1): a profile clamps against the driver's TRUE
                // limits (extendedRangesFor), never the mode-gated
                // caps.ranges that would silently reduce a saved value.
                let shaped_ranges = super::apply_gates::extended_ranges_for(&caps);
                if let Some(map) = caps.as_object_mut() {
                    map.insert("ranges".into(), shaped_ranges);
                }
            }
            let ranges = caps.get("ranges");
            let mut sysman_context = if sysman_power_requested || voltage_request.is_some() {
                let (bus, device, function) = (expected_identity.bus, expected_identity.slot, expected_identity.function);
                let mut session = match super::sysman::SysmanSession::load() { Ok(session) => session, Err(_) => return None };
                let bdf = super::sysman::Bdf { domain: 0, bus, device, function };
                let Some(mut device) = session.device(bdf) else {
                    return Some(Err("the requested GPU has no unique Sysman domain match".into()));
                };
                if voltage_request.is_some()
                    && super::sysman_voltage::SysmanVoltage::read_voltage(&mut device).is_err() {
                    return Some(Err("Sysman could not read the selected GPU voltage before apply; no GPU settings were changed".into()));
                }
                if sysman_power_requested
                    && super::sysman_power::SysmanPower::read_limits(&mut device).is_err() {
                    return Some(Err("Sysman could not read the selected GPU power limits before apply; no GPU settings were changed".into()));
                }
                drop(device);
                Some((session, bdf))
            } else { None };
            let (mut igcl, raw_index, _) = match super::gpu_capabilities::open_for_identity(&path, &expected_identity) {
                Ok(session) => session,
                Err(error) => return Some(Err(error)),
            };
            let snapshot = match igcl.controls_snapshot(raw_index) {
                Ok(snapshot) => snapshot,
                Err(_) => { let _ = igcl.close(); return None; }
            };
            // The legacy Sysman undervolt extends the V/F curve and can make
            // the IGCL frequency-offset getter report a derived positive value
            // (for example +172 MHz) even though the user requested 0 MHz.
            // Preserve the user's requested/pre-apply offset in the returned
            // state so that value is never captured into a profile or sent by
            // the next apply.
            let pre_frequency_offset = snapshot.frequency_offset.filter(|value| value.is_finite());
            if profile_apply && !super::apply_gates::profile_driver_witness_still_matches(
                &settings, profile_driver_ranges.as_ref().unwrap_or(&Value::Null),
                &super::gpu_capabilities::raw_limit_ranges(&snapshot),
            ) {
                let _ = igcl.close();
                return Some(Err("DriverStore limits changed during profile preflight; no settings were written".into()));
            }
            let units = super::gpu_apply::ScalarUnits::from_oc(&snapshot.oc);
            let mut legacy_targets: Vec<(&'static str, f64)> = Vec::new();
            let split_legacy = if profile_apply {
                match super::apply_gates::split_profile_by_driver_witness(
                    &settings, profile_driver_ranges.as_ref(), sysman_power_requested,
                ) {
                    Ok((_, legacy)) => legacy,
                    Err(error) => { let _ = igcl.close(); return Some(Err(error)); }
                }
            } else {
                super::apply_gates::split_by_runtime(
                    &settings, ranges, Some(&mode), sysman_power_requested, Some(limits),
                ).1
            };
            for key in ["powerLimitW", "tempLimitC"] {
                if let Some(value) = split_legacy.get(key).and_then(Value::as_f64) {
                    legacy_targets.push((if key == "powerLimitW" { "powerLimitW" } else { "tempLimitC" }, value));
                }
            }
            let target_names = legacy_targets.iter().map(|(key, _)| *key).collect::<Vec<_>>();
            if !super::apply_gates::unsupported_legacy_targets(&target_names, &caps).is_empty() {
                let _ = igcl.close();
                return None;
            }
            let legacy_context = if legacy_targets.is_empty() { None } else {
                let legacy_path = match super::legacy_igcl::locate_dll() { Some(path) => path, None => return None };
                let legacy = match super::legacy_igcl::LegacyIgcl::load(&legacy_path) { Ok(legacy) => legacy, Err(_) => return None };
                let (index, pci_fallback) = match legacy.unique_index_for_identity(&expected_identity) {
                    Ok(index) => index,
                    Err(error) => return Some(Err(error)),
                };
                if pci_fallback {
                    let current = match igcl.enumerate_adapters() { Ok(rows) => rows, Err(error) => return Some(Err(error.to_string())) };
                    if !super::legacy_igcl::current_identity_is_unique(&current, &expected_identity, raw_index) {
                        return Some(Err("legacy IGCL PCI fallback cannot uniquely prove the current GPU".into()));
                    }
                }
                Some((legacy, index))
            };
            let temp_legacy_requested = legacy_targets.iter().any(|(key, _)| *key == "tempLimitC");
            let leased_temperature_control = leased_temperature && settings.get("tempLimitC").is_some();
            if leased_temperature_control && !temp_legacy_requested
                && caps.get("controls").and_then(|controls| controls.get("tempLimit")) != Some(&Value::Bool(true)) {
                let _ = igcl.close();
                return None;
            }
            if leased_temperature_control && !temp_legacy_requested && igcl.scalar_backend(raw_index).is_none() {
                let _ = igcl.close();
                return None;
            }
            // The broker FIFO is already held. Acquire the cross-process GPU
            // mutex only after every identity/capability/runtime preflight.
            // Keep it through every setter and read-back in a mixed profile;
            // the guard drops when this invocation returns, before lease finish.
            let _temperature_apply_lock = if leased_temperature {
                match super::apply_lock::acquire() {
                    Ok(lock) => Some(lock),
                    Err(error) => { let _ = igcl.close(); return Some(Err(error)); }
                }
            } else { None };
            // Every runtime/adapter/read availability check above completes
            // before the waiver setters. Once a setter is attempted, errors
            // return an error to this caller and never replay through the
            // compatibility broker.
            if let Some((legacy, index)) = legacy_context.as_ref() {
                if let Err(error) = legacy.apply_waiver(*index) {
                    let _ = igcl.close();
                    return Some(Err(error));
                }
            }
            if waiver {
                if let Err(error) = igcl.apply_waiver(raw_index) {
                    let _ = igcl.close();
                    return Some(Err(error.to_string()));
                }
            }
            let lock_nonzero = has_lock && (
                settings["gpuLock"]["voltageV"].as_f64().unwrap_or(0.0) != 0.0
                || settings["gpuLock"]["freqMhz"].as_f64().unwrap_or(0.0) != 0.0);
            // A positive V-unit write must not land on top of a stale legacy
            // Sysman undervolt. Verify the Sysman offset is zero first; a
            // failed clear blocks the IGCL voltage write instead of applying
            // an ambiguous pair.
            let mut voltage_cleanup_failure: Option<Value> = None;
            if positive_voltage {
                if let Some((session, bdf)) = sysman_context.as_mut() {
                    let result = sysman_voltage_clear(session, *bdf, waiver);
                    if result.get("ok") != Some(&Value::Bool(true)) {
                        voltage_cleanup_failure = Some(result);
                    }
                }
            }
            let mut scalar_settings = settings.clone();
            if lock_nonzero {
                scalar_settings["gpuFreqOffsetMhz"] = json!(0);
                scalar_settings["gpuVoltOffsetV"] = json!(0);
            }
            // The negative Alchemist offset is owned by the Sysman target API.
            // Clear the IGCL offset first (and report its result) so the two
            // writers never stack.
            if negative_voltage {
                scalar_settings["gpuVoltOffsetV"] = json!(0);
            }
            if positive_voltage && voltage_cleanup_failure.is_some() {
                if let Some(map) = scalar_settings.as_object_mut() { map.remove("gpuVoltOffsetV"); }
            }
            if let Some(map) = scalar_settings.as_object_mut() {
                for (key, _) in &legacy_targets { map.remove(*key); }
                if sysman_power_requested { map.remove("powerLimitW"); }
            }
            let mut applied = json!({"ok": true, "perControl": {}});
            if let Some(failure) = voltage_cleanup_failure {
                applied["perControl"]["gpuVoltOffsetV"] = failure;
            }
            let mut sysman_power_applied: Option<f64> = None;
            let lock_first = has_lock && !lock_nonzero
                && ["gpuFreqOffsetMhz", "gpuVoltOffsetV"].iter()
                    .any(|key| settings.get(*key).is_some_and(|value| !value.is_null()));
            if lock_first {
                let lock = match igcl.lock_backend(raw_index) {
                    Some(mut backend) => super::lock_apply::apply_gpu_lock(&settings, &caps, &mut backend),
                    None => json!({"ok": false, "perControl": {"gpuLock": {"ok": false, "errorCode": "unsupported", "message": "GPU lock API unavailable"}}}),
                };
                merge_per_control(&mut applied, &lock);
            }
            let scalar = match igcl.scalar_backend(raw_index) {
                Some(mut backend) => {
                    if leased_temperature_control && !temp_legacy_requested {
                        *attempted_temperature = super::gpu_apply::clamped_scalar(
                            &scalar_settings, &caps, super::gpu_apply::ScalarControl::TempLimit, true,
                        );
                    }
                    super::gpu_apply::apply_scalars(&scalar_settings, &caps, &units, &mut backend, true)
                }
                None => json!({"ok": false, "perControl": {}}),
            };
            merge_per_control(&mut applied, &scalar);
            if let Some((session, bdf)) = sysman_context.as_mut() {
                if negative_voltage && !lock_nonzero {
                    if applied["perControl"]["gpuVoltOffsetV"].get("readBackEqual") == Some(&Value::Bool(true)) {
                        let offset_v = settings.get("gpuVoltOffsetV").and_then(Value::as_f64).unwrap_or(0.0);
                        let mut result = sysman_voltage_apply(session, *bdf, offset_v, waiver);
                        if result.get("ok") != Some(&Value::Bool(true)) {
                            // The IGCL offset was already cleared and verified
                            // before entering Sysman. Even a Sysman preflight
                            // read failure can therefore leave the requested
                            // negative offset unapplied with the previous
                            // IGCL value removed; do not hide that partial
                            // state or attempt an unverified automatic restore.
                            result["stateMayHaveChanged"] = json!(true);
                            result["igclOffsetCleared"] = json!(true);
                            let detail = result["message"].as_str().unwrap_or("Sysman voltage offset was not applied.");
                            result["message"] = json!(format!(
                                "{detail} The IGCL voltage offset was cleared first; driver state may have changed. Refresh before another apply."
                            ));
                        }
                        applied["perControl"]["gpuVoltOffsetV"] = result;
                    }
                } else if zero_voltage || (negative_voltage && lock_nonzero) {
                    // A zero request resets both writers. A lock-owned pair
                    // also clears any stale Sysman undervolt instead of
                    // layering the requested offset under the lock.
                    let result = sysman_voltage_clear(session, *bdf, waiver);
                    let ok = result.get("ok") == Some(&Value::Bool(true));
                    if negative_voltage && lock_nonzero {
                        applied["perControl"]["gpuVoltOffsetV"] = if ok {
                            json!({"ok": true, "readBackEqual": true})
                        } else { result };
                    } else if !ok {
                        applied["perControl"]["gpuVoltOffsetV"] = result;
                    } else if applied["perControl"].get("gpuVoltOffsetV").is_none() {
                        applied["perControl"]["gpuVoltOffsetV"] = json!({"ok": true, "readBackEqual": true});
                    }
                }
            }
            if let Some((mut legacy, legacy_index)) = legacy_context {
                let mut legacy_result = json!({"ok": true, "perControl": {}});
                for (key, value) in legacy_targets {
                    let result = if key == "powerLimitW" {
                        super::legacy_igcl::apply_extended_power(&mut legacy, legacy_index, value, super::legacy_igcl::DELAYED_VERIFY_MS)
                    } else {
                        let target = super::gpu_units::clamp_and_snap(value, super::gpu_units::Range {
                            min: super::legacy_igcl::EXTENDED_TL_MIN_C,
                            max: super::legacy_igcl::EXTENDED_TL_MAX_C,
                            step: 1.0,
                        });
                        if leased_temperature { *attempted_temperature = Some(target); }
                        let result = super::legacy_igcl::apply_extended_temp(&mut legacy, legacy_index, target, super::legacy_igcl::DELAYED_VERIFY_MS);
                        if result.get("ok") == Some(&Value::Bool(true)) {
                            remember_accepted_temperature(&expected_identity.device_key, target);
                        }
                        result
                    };
                    if result.get("ok") != Some(&Value::Bool(true)) { legacy_result["ok"] = json!(false); }
                    legacy_result["perControl"][key] = result;
                }
                merge_per_control(&mut applied, &legacy_result);
            }
            if let (Some((mut session, bdf)), Some(watts)) = (
                sysman_context.take(),
                sysman_power_requested.then(|| power_value.unwrap_or(315.0)),
            ) {
                let result = match session.device(bdf) {
                    Some(mut device) => super::sysman_power::apply_power_pair(&mut device, watts),
                    None => json!({"ok": false, "errorCode": "unsupported", "message": "the requested GPU has no unique Sysman power-domain match"}),
                };
                let mut sysman_result = json!({"ok": true, "perControl": {}});
                if result.get("ok") != Some(&Value::Bool(true)) { sysman_result["ok"] = json!(false); }
                else { sysman_power_applied = result.get("sustainedW").and_then(Value::as_f64); }
                sysman_result["perControl"]["powerLimitW"] = result;
                merge_per_control(&mut applied, &sysman_result);
            }
            if has_lock && !lock_first {
                let lock = match igcl.lock_backend(raw_index) {
                    Some(mut backend) => super::lock_apply::apply_gpu_lock(&settings, &caps, &mut backend),
                    None => json!({"ok": false, "perControl": {"gpuLock": {"ok": false, "errorCode": "unsupported", "message": "GPU lock API unavailable"}}}),
                };
                merge_per_control(&mut applied, &lock);
            }
            if has_fan {
                let fan = match igcl.fan_backend(raw_index) {
                    Some(mut backend) => super::fan_apply::apply_fan(&settings, &caps, &mut backend),
                    None => json!({"ok": false, "perControl": {"fanMode": {
                        "ok": false, "errorCode": "unsupported", "message": "no fans enumerated on this device",
                    }}}),
                };
                merge_per_control(&mut applied, &fan);
            }
            if has_vf {
                let options = super::vf_apply::VfVerifyOptions {
                    driver_authoritative: super::vf_apply::is_battlemage(&caps),
                    ..Default::default()
                };
                let mut vf = match igcl.vf_backend(raw_index, units) {
                    Some(mut backend) => super::vf_apply::apply_vf_curve(&settings, &caps, &mut backend, &options),
                    None => json!({"ok": false, "perControl": {"vfCurve": {
                        "ok": false, "errorCode": "unsupported", "message": "VF backend unavailable",
                    }}}),
                };
                if stock_vf_profile && vf["ok"] == Value::Bool(true)
                    && !stock_vf_readback_matches(&settings, &vf) {
                    vf = json!({"ok": false, "perControl": {"vfCurve": {
                        "ok": false, "errorCode": "readback-unverified",
                        "message": "The applied VF curve did not match the verified STOCK curve.",
                        "readBackEqual": false, "silentNoop": false,
                        "readBackCurve": vf["perControl"]["vfCurve"]["readBackCurve"],
                    }}});
                }
                merge_per_control(&mut applied, &vf);
            }
            let _ = igcl.close();
            let candidates: Vec<_> = super::gpu_apply::SCALAR_CONTROLS.iter().copied()
                .filter(|control| super::gpu_apply::is_momentary_lie_candidate(
                    &applied["perControl"][control.canonical()]))
                .collect();
            let mut state = None;
            if !candidates.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(400));
                state = super::gpu_capabilities::current_settings_for_identity(&path, &expected_identity).ok();
                if let Some(current) = state.as_ref() {
                    for control in candidates {
                        let Some(wanted) = super::gpu_apply::clamped_scalar(&settings, &caps, control, true) else { continue; };
                        let got = current.get(control.canonical()).and_then(Value::as_f64);
                        if got.is_some_and(|got| super::gpu_units::nearly_equal(got, wanted, 1e-9)) {
                            applied["perControl"][control.canonical()] = json!({"ok": true, "readBackEqual": true});
                        }
                    }
                }
            }
            let mut result = super::gpu_apply::finalize_apply_result(applied);
            if state.is_none() {
                state = super::gpu_capabilities::current_settings_for_identity(&path, &expected_identity).ok();
            }
            if let (Some(state), Some(watts)) = (state.as_mut(), sysman_power_applied) {
                if state.is_object() { state["powerLimitW"] = json!(watts); }
            }
            if negative_voltage {
                preserve_requested_frequency_offset(
                    &mut state,
                    settings.get("gpuFreqOffsetMhz").and_then(Value::as_f64),
                    pre_frequency_offset,
                );
            }
            // A voltage-only Alchemist apply must not expose the driver's
            // derived frequency offset on any later read. Keep the user's
            // effective value for this session (an explicit frequency change
            // replaces it; a zero/positive voltage clears the guard).
            if let Some(requested) = settings.get("gpuFreqOffsetMhz").and_then(Value::as_f64) {
                let accepted = result.get("perControl").and_then(|per| per.get("gpuFreqOffsetMhz"))
                    .and_then(|entry| entry.get("ok")).and_then(Value::as_bool) == Some(true);
                if accepted { remember_frequency_offset_guard(&expected_identity.device_key, requested); }
            } else if negative_voltage {
                if frequency_offset_guard(&expected_identity.device_key).is_none() {
                    if let Some(effective) = state.as_ref()
                        .and_then(|state| state.get("gpuFreqOffsetMhz")).and_then(Value::as_f64) {
                        remember_frequency_offset_guard(&expected_identity.device_key, effective);
                    }
                }
            } else if settings.get("gpuVoltOffsetV").and_then(Value::as_f64).is_some() {
                forget_frequency_offset_guard(&expected_identity.device_key);
            }
            if let Some(state) = state.as_mut() {
                apply_frequency_offset_guard(state, &expected_identity.device_key);
            }
            if profile_apply {
                // The broker merges capabilityPerControl AFTER runApply so the
                // refusal message survives finalize's hard-error-code
                // stripping; the native merge mirrors that order.
                super::gpu_apply::merge_planned_refusals(&mut result, &plan_refusals);
            }
            let mut reply = json!({"result": result, "state": state});
            if profile_apply && plan_refusals.as_object().is_some_and(|map| !map.is_empty()) {
                // withCapabilityFlags parity: the flags are derived from the
                // final per-control results only.
                let (refused, partial) = super::gpu_apply::capability_ceiling_flags(&reply["result"]);
                if refused {
                    reply["capabilityCeilingRefused"] = json!(true);
                    if partial { reply["capabilityCeilingPartial"] = json!(true); }
                }
            }
            if extended_unavailable_partial {
                reply["extendedUnavailable"] = json!(true);
                reply["extendedUnavailablePartial"] = json!(true);
            }
            if has_fan { super::fan_resume::notify_native_apply(&expected_identity, &settings, &reply); }
            Some(encode_json(&reply))
        }
        "games-scan" if !context.mock_mode => Some((|| {
            no_payload(channel, args)?;
            let mut scan = super::game_scan::scan();
            if scan.get("error").is_none() {
                let apps = scan.get("apps").cloned().unwrap_or_else(|| json!([]));
                match native_json(context.store, "game-sync-catalog", json!([apps, {"authoritative": true}])) {
                    Ok(catalog) => scan["catalog"] = catalog,
                    Err(error) => scan["sidecarError"] = json!(format!("Game catalog unavailable: {error}")),
                }
            }
            encode_json(&scan)
        })()),
        "game-catalog-list" => Some((|| {
            no_payload(channel, args)?;
            encode_json(&native_json(context.store, "game-load-catalog", json!([]))?)
        })()),
        "game-profiles-list" => Some((|| {
            no_payload(channel, args)?;
            let profiles = native_json(context.store, "load-profiles", json!([]))?;
            let ids: Vec<Value> = profiles.as_array().into_iter().flatten()
                .filter_map(|profile| profile.get("id").filter(|id| id.is_string()).cloned()).collect();
            let associations = native_json(context.store, "game-load", json!([ids]))?;
            encode_json(&json!({"associations": associations}))
        })()),
        "game-catalog-sync" if !context.mock_mode => Some((|| {
            let payload = single_json_payload(channel, args)?;
            let rows = payload.as_array().ok_or("game-catalog-sync: payload must be an array")?;
            let current_exe = std::env::current_exe().ok().map(|path| json!(path.to_string_lossy())).unwrap_or(Value::Null);
            for row in rows {
                let path = row.get("exePath").or_else(|| row.get("ExecutablePath")).cloned().unwrap_or(Value::Null);
                if super::game_candidate::validate_safe_game_candidate(&path, &current_exe, &[], true).is_none() {
                    return Err("game-catalog-sync: executable is not a safe existing game candidate".into());
                }
            }
            let apps = super::game_scan::normalize_scanned_apps(&Value::Array(rows.clone()), true);
            let catalog = native_json(context.store, "game-sync-catalog", json!([apps, {"authoritative": true}]))?;
            encode_json(&json!({"catalog": catalog}))
        })()),
        "game-profile-save" if !context.mock_mode => Some((|| {
            let payload = single_json_payload(channel, args)?;
            let object = payload.as_object().ok_or("game-profile-save: payload must be an object")?;
            let profile_id = object.get("profileId").and_then(Value::as_str)
                .ok_or("game-profile-save: profile not found")?;
            let profiles = native_json(context.store, "load-profiles", json!([]))?;
            let profile = profiles.as_array().into_iter().flatten()
                .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
                .ok_or("game-profile-save: profile not found")?;
            let exe_path = canonical_exe_path(object.get("exePath").unwrap_or(&Value::Null))
                .ok_or("game-profile-save: exePath must be an absolute Windows path")?;
            let mut association = payload.clone();
            association["profileId"] = profile.get("id").cloned().unwrap_or_else(|| json!(profile_id));
            association["exePath"] = json!(exe_path);
            let ids: Vec<Value> = profiles.as_array().into_iter().flatten()
                .filter_map(|profile| profile.get("id").filter(|id| id.is_string()).cloned()).collect();
            let associations = native_json(context.store, "game-upsert", json!([association, ids]))?;
            encode_json(&json!({"associations": associations}))
        })()),
        "game-profile-capabilities" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.is_empty() || items.len() > 2 { return Err("game-profile-capabilities takes a device id and optional executable path".into()); }
            let WireValue::Number(device_id) = &items[0] else { return Err("game-profile-capabilities: invalid device id".into()); };
            let device_id = device_id.as_u64().ok_or("game-profile-capabilities: invalid device id")?;
            let exe_path = match items.get(1) {
                None | Some(WireValue::Undefined) | Some(WireValue::Null) => None,
                Some(WireValue::String(value)) => Some(value.as_str()),
                _ => return Err("game-profile-capabilities: exePath must be an absolute Windows executable path".into()),
            };
            let dll_path = super::gpu_devices::locate_dll().ok_or("IntelControlLib.dll was not found")?;
            encode_json(&super::game_profile_capabilities::capabilities(&dll_path, device_id, exe_path)?)
        })()),
        "game-settings-save" if !context.mock_mode => Some((|| {
            let payload = single_json_payload(channel, args)?;
            let dll_path = super::gpu_devices::locate_dll().ok_or("IntelControlLib.dll was not found")?;
            encode_json(&super::game_settings::save(context.store, &dll_path, &payload)?)
        })()),
        "game-settings-delete" if !context.mock_mode => Some((|| {
            let payload = single_json_payload(channel, args)?;
            let dll_path = super::gpu_devices::locate_dll().ok_or("IntelControlLib.dll was not found")?;
            encode_json(&super::game_settings::delete(context.store, &dll_path, &payload)?)
        })()),
        "game-profile-delete" if !context.mock_mode => Some((|| {            let payload = single_json_payload(channel, args)?;
            let object = payload.as_object().ok_or("game-profile-delete: payload must be an object")?;
            let profile_id = object.get("profileId").and_then(Value::as_str)
                .ok_or("game-profile-delete: profile not found")?;
            let profiles = native_json(context.store, "load-profiles", json!([]))?;
            if !profiles.as_array().into_iter().flatten()
                .any(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id)) {
                return Err("game-profile-delete: profile not found".into());
            }
            let ids: Vec<Value> = profiles.as_array().into_iter().flatten()
                .filter_map(|profile| profile.get("id").filter(|id| id.is_string()).cloned()).collect();
            let associations = native_json(context.store, "game-delete",
                json!([profile_id, object.get("exePath").cloned().unwrap_or(Value::Null), ids]))?;
            encode_json(&json!({"associations": associations}))
        })()),
        "stability-reports-list" => Some((|| {
            no_payload(channel, args)?;
            encode_json(&native_json(context.store, "stability-list", json!([]))?)
        })()),
        "stability-report-latest" => Some((|| {
            no_payload(channel, args)?;
            encode_json(&native_json(context.store, "stability-latest", json!([]))?)
        })()),
        "registry-catalog" if !context.mock_mode => Some((|| {
            no_payload_exact(channel, args)?;
            encode_json(&super::registry_catalog::read_catalog()?)
        })()),
        // One native dispatcher serializes layout snapshots, mutations, cache
        // publication and the apply reaction. The store side is a single
        // settings+sidecar transaction; the host publishes the committed
        // settings snapshot afterwards. Mock runs, and payloads the tagged
        // codec cannot reduce to ordinary JSON, stay with the broker.
        "overlay-layouts-list" | "overlay-layout-rename" | "overlay-layout-save"
            | "overlay-layout-select" | "overlay-layout-delete" if !context.mock_mode => {
                match super::settings_patch::with_save_queue(|| {
                    Ok(super::overlay_layout_channels::handle(context.store, channel, args))
                }) {
                    Ok(Some(result)) => Some(result),
                    Ok(None) => None,
                    Err(error) => Some(Err(error)),
                }
            }
        "overlay-layouts-list" | "overlay-layout-rename" | "overlay-layout-save"
            | "overlay-layout-select" | "overlay-layout-delete" => None,
        "list-devices" if !context.mock_mode => {
            if let Err(error) = no_payload(channel, args) { Some(Err(error)) } else {
                let devices = super::gpu_devices::list_devices_merged();
                if devices.as_array().is_some_and(|devices| !devices.is_empty()) {
                    Some(encode_json(&devices))
                } else { None }
            }
        }
        "get-capabilities" if !context.mock_mode => {
            let device_id = match device_id_arg(channel, args) {
                Ok(device_id) => device_id,
                Err(error) => return Some(Err(error)),
            };
            let Some(path) = super::gpu_devices::locate_dll() else {
                return gpu_read_failure(context.build_kind, channel, "Intel graphics runtime was not found");
            };
            let identity = match refusal_cache_identity_for_device_id(&path, device_id) {
                Ok(identity) => identity,
                Err(error) => return gpu_read_failure(context.build_kind, channel, &error),
            };
            let Some((mode, waiver)) = native_mode_waiver_for_key(context.store, &identity.device_key) else {
                return gpu_read_failure(context.build_kind, channel, "GPU mode settings are unavailable");
            };
            let mut caps = match super::gpu_capabilities::capabilities_for_identity(&path, &identity, &mode, waiver) {
                Ok(caps) => caps,
                Err(error) if native_only_capabilities_fallback_allowed(context.build_kind, &error) => {
                    match native_capabilities_with_probe_or_read_only(
                        &path, &identity, &mode, waiver,
                    ) {
                        Ok(caps) => caps,
                        Err(error) => return gpu_read_failure(context.build_kind, channel, &error),
                    }
                }
                Err(error) => return gpu_read_failure(context.build_kind, channel, &error),
            };
            let cache_identity = match refusal_cache_identity_for_device_id(&path, device_id) {
                Ok(identity) => identity,
                Err(error) => return gpu_read_failure(context.build_kind, channel, &error),
            };
            if let Err(error) = super::gpu_apply_identity::ensure_same_target(&identity, &cache_identity) {
                return gpu_read_failure(context.build_kind, channel, &error);
            }
            let cache = match super::profile_apply_preflight::ProfileTempCeilings::snapshot_for_device(&cache_identity.device_key) {
                Ok(cache) => cache,
                Err(error) => return gpu_read_failure(context.build_kind, channel, &error),
            };
            merge_temperature_refusal_cache(&mut caps, &cache, &identity.device_key);
            Some(encode_json(&caps))
        }
        "get-current-settings" if !context.mock_mode => {
            let device_id = match device_id_arg(channel, args) {
                Ok(device_id) => device_id,
                Err(error) => return Some(Err(error)),
            };
            let Some(path) = super::gpu_devices::locate_dll() else {
                return gpu_read_failure(context.build_kind, channel, "Intel graphics runtime was not found");
            };
            if native_mode_waiver(context.store, &path, device_id).is_none() {
                return gpu_read_failure(context.build_kind, channel, "GPU identity or mode settings are unavailable");
            }
            let identity = match refusal_cache_identity_for_device_id(&path, device_id) {
                Ok(identity) => identity,
                Err(error) => return gpu_read_failure(context.build_kind, channel, &error),
            };
            match super::gpu_capabilities::current_settings(&path, device_id) {
                Ok(mut state) => {
                    apply_accepted_temperature(&mut state, &identity.device_key);
                    apply_frequency_offset_guard(&mut state, &identity.device_key);
                    Some(encode_json(&state))
                }
                Err(error) => gpu_read_failure(context.build_kind, channel, &error),
            }
        }
        // M8 native Graphics surface. The arm only exists on an elevated,
        // non-mock host; `graphics::get`/`apply` additionally return `None`
        // before any driver or registry access when the narrowed Arc Sleep
        // gate says the Electron controller could own the limiter.
        "graphics:get" if graphics_native_available(context.mock_mode, process_is_elevated()) => {
            let (device_id, key) = match graphics_args(channel, args) {
                Ok(parsed) => parsed,
                Err(error) => return Some(Err(error)),
            };
            match super::graphics::get(context.store, device_id, key.as_deref()) {
                Ok(Some(state)) => Some(encode_json(&state)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        }
        "graphics:apply" if graphics_native_available(context.mock_mode, process_is_elevated()) => {
            let (device_id, payload, key) = match graphics_apply_args(channel, args) {
                Ok(parsed) => parsed,
                Err(error) => return Some(Err(error)),
            };
            match super::graphics::apply(context.store, device_id, &payload, key.as_deref()) {
                Ok(Some(reply)) => {
                    // Exactly one post-apply read-back push (even when the
                    // apply reported ok:false) - never for a delegated call.
                    super::graphics::emit_state_updated(device_id, &reply);
                    Some(encode_json(&reply))
                }
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        }
        // The native Display read owns only complete candidates whose output
        // list cannot differ through Electron's Windows timing fallback. A
        // pre-reconciliation decline delegates to the broker, which validates
        // the expected key under its own Display lock. Any decline/error after
        // reconciliation starts stays fail-closed. The separate apply arm
        // below routes only isolated, fully verified Display controls.
        "display:get" if graphics_native_available(context.mock_mode, process_is_elevated()) => {
            route_display_get(channel, args, true, |device_id, expected_key| {
                let guard = match super::display_lock::acquire() {
                    Ok(guard) => guard,
                    // Nothing has been read or reconciled yet. Let the broker
                    // retry under the same shared mutex and revalidate key.
                    Err(_) => return Ok(None),
                };
                super::display::get_if_owned_under_lock(&guard, device_id, expected_key)
            })
        }
        // Every control the shipped phases own, composed in Electron's order
        // under one Display transaction: isolated quantization, Retro Scaling,
        // wire-format, VRR, Scaling Mode (including the Custom pair), color and
        // a floating "Apply all". Unknown keys still decline whole to Electron.
        "display:apply" if graphics_native_available(context.mock_mode, process_is_elevated()) => {
            route_display_apply(channel, args, true, |device_id, device_key, display_key, plan| {
                let guard = match super::display_lock::acquire() {
                    Ok(guard) => guard,
                    // No reads or writes have occurred, so broker retry is safe.
                    Err(_) => return Ok(None),
                };
                apply_display_plan_under_lock(
                    &guard, device_id, device_key, display_key, plan, Some(context.store),
                )
            })
        }
        // `arc-sleep-base-cap-get` is the Arc Sleep panel's fast, independent
        // Base FPS Cap read. The native controller owns the limiter in this
        // host; `graphics::base_cap_get` answers from it (RTSS-only when the
        // controller owns RTSS) and runs inside the controller transaction.
        "arc-sleep-base-cap-get" if graphics_native_available(context.mock_mode, process_is_elevated()) => {
            let (device_id, key) = match graphics_args(channel, args) {
                Ok(parsed) => parsed,
                Err(error) => return Some(Err(error)),
            };
            match super::graphics::base_cap_get(context.store, device_id, key.as_deref()) {
                Ok(Some(state)) => Some(encode_json(&state)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        }
        // In-memory controller snapshot. Only a host that actually installed the
        // native controller answers here; in mock, unelevated or failed-install
        // runs the arm is absent so Electron's controller - which is started in
        // exactly those cases - keeps owning Arc Sleep.
        "arc-sleep-state-get" if super::arc_sleep_system::controller().is_some() => Some((|| {
            no_payload_exact(channel, args)?;
            let snapshot = match super::arc_sleep_system::controller() {
                Some(controller) => controller.get_snapshot(),
                None => super::arc_sleep_controller::unavailable_snapshot(),
            };
            encode_json(&snapshot)
        })()),
        "vendor-info:get" if !context.mock_mode => Some((|| {
            let items = args_array(channel, args)?;
            if items.len() > 1 { return Err("vendor-info:get takes at most a device id".into()); }
            let rows = super::gpu_devices::list_devices_merged();
            let rows = rows.as_array().cloned().unwrap_or_default();
            let explicit = !items.is_empty();
            let row = if explicit {
                match &items[0] {
                    WireValue::Undefined | WireValue::Null => None,
                    WireValue::Number(number) => number.as_u64().and_then(|id| rows.get(id as usize)).cloned(),
                    _ => None,
                }
            } else {
                let vendor_rows: Vec<&Value> = rows.iter()
                    .filter(|row| matches!(row["gpuVendor"].as_str(), Some("nvidia" | "amd"))).collect();
                (vendor_rows.len() == 1).then(|| vendor_rows[0].clone())
            };
            let nulls = json!({"vramBytes":Value::Null,"computeCores":Value::Null,"computeUnits":Value::Null});
            let Some(row) = row else { return encode_json(&nulls); };
            let vendor = row["gpuVendor"].as_str();
            if !matches!(vendor, Some("nvidia" | "amd")) { return encode_json(&nulls); }
            let info = super::vendor_telemetry::VendorTelemetry::start_for_target(Some(&row), vendor)
                .map(|adapter| adapter.device_info()).unwrap_or_default();
            let compute_units = if vendor == Some("amd") {
                amd_compute_units_of(row["name"].as_str().unwrap_or(""))
            } else { None };
            encode_json(&json!({
                "vramBytes": info.vram_bytes,
                "computeCores": info.compute_cores,
                "computeUnits": compute_units,
            }))
        })()),
        "power-limits:read" if !context.mock_mode => {
            let device_id = match device_id_arg(channel, args) {
                Ok(device_id) => device_id,
                Err(error) => return Some(Err(error)),
            };
            Some(encode_json(&read_power_limits_for_device(device_id)))
        }
        "voltage-offset:read" if !context.mock_mode => {
            let device_id = match device_id_arg(channel, args) {
                Ok(device_id) => device_id,
                Err(error) => return Some(Err(error)),
            };
            let null = Value::Null;
            let value = match super::gpu_devices::locate_dll().and_then(|path| current_bdf(&path, device_id)) {
                Some((bus, device, function)) => match super::sysman::SysmanSession::load() {
                    Ok(mut session) => match session.device(super::sysman::Bdf { domain: 0, bus, device, function }) {
                        Some(mut target) => super::sysman_voltage::read_voltage_offset(&mut target),
                        None => json!({"ok": false, "errorCode": "unsupported",
                            "message": "the Sysman legacy GPU frequency voltage-target API is unavailable on this GPU"}),
                    },
                    Err(_) => null,
                },
                None => null,
            };
            Some(encode_json(&value))
        }
        _ => None,
    }
}

fn optional_object(args: &Value) -> Result<Option<Value>, String> {
    let WireValue::Array(items) = decode(args)? else { return Err("Expected argument array".into()); };
    if items.len() > 1 { return Err("Expected at most one payload object".into()); }
    match items.into_iter().next() {
        None | Some(WireValue::Undefined) | Some(WireValue::Null) => Ok(None),
        Some(WireValue::Object(entries)) => {
            let mut object = Map::new();
            for (key, value) in entries { object.insert(key, value.into_json()?); }
            Ok(Some(Value::Object(object)))
        }
        Some(_) => Err("Expected a payload object".into()),
    }
}

/// Read a single non-negative integer device id from the wire argument array.
/// `JSON.stringify` for an argument value, matching the `assertValidDeviceId`
/// message (`invalid device id: ${JSON.stringify(v)}`).
fn js_stringify(value: Option<&WireValue>) -> String {
    match value {
        None | Some(WireValue::Undefined) => "undefined".into(),
        Some(value) => value
            .clone()
            .into_json()
            .map(|value| value.to_string())
            .unwrap_or_else(|_| "undefined".into()),
    }
}

fn invalid_device_id(value: Option<&WireValue>) -> String {
    format!("invalid device id: {}", js_stringify(value))
}

/// The Graphics channels are native only when this host owns the write (it is
/// elevated) and the mock backend is not in charge. The delegate-before-write
/// contract depends on both.
fn graphics_native_available(mock_mode: bool, elevated: bool) -> bool {
    !mock_mode && elevated
}

fn graphics_device_id(value: Option<&WireValue>) -> Result<u64, String> {
    match value {
        Some(WireValue::Number(number)) => number
            .as_u64()
            .filter(|id| *id <= 9_007_199_254_740_991)
            .ok_or_else(|| invalid_device_id(value)),
        _ => Err(invalid_device_id(value)),
    }
}

/// `graphics:get(deviceId, expectedDeviceKey?)`.
fn graphics_args(channel: &str, args: &Value) -> Result<(u64, Option<String>), String> {
    let items = args_array(channel, args)?;
    if items.len() > 2 {
        return Err(format!("{channel} takes at most a device id and an expected device key"));
    }
    let device_id = graphics_device_id(items.first())?;
    let key = graphics_expected_key(items.get(1))?;
    Ok((device_id, key))
}

/// `display:get(deviceId, expectedDeviceKey?)` argument validation for the
/// staged native read. The optional key keeps Electron compatibility callers
/// valid; native routing will require it before opening an adapter.
fn display_get_args(channel: &str, args: &Value) -> Result<(u64, Option<String>), String> {
    let items = args_array(channel, args)?;
    if items.len() > 2 { return Err(format!("{channel} expects one device id and an optional expected device key")); }
    let device_id = graphics_device_id(items.first())?;
    let expected_device_key = graphics_expected_key(items.get(1))?;
    Ok((device_id, expected_device_key))
}

/// The routing outcome of one native Display IPC call, printed once per call by
/// the `[display]` attribution line. It is a classification only: the routed
/// result is returned independently, so logging can never change the flow.
///
/// `Declined`/`Delegated` mean the route returned `None`, so the broker really
/// does own the call. `Error` means the route returned `Some(Err(..))`: the
/// renderer sees the native error and no broker fallback happens.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DisplayRouteOutcome {
    /// The native path produced the payload.
    Native,
    /// The route returned `None`; the documented broker fallback owns the call.
    Declined(&'static str),
    /// The route returned `None` before any write; Electron retries it.
    Delegated(&'static str),
    /// The route returned `Some(Err(..))`; the broker never sees this call.
    Error(&'static str),
}

impl DisplayRouteOutcome {
    fn label(self) -> String {
        match self {
            Self::Native => "native".into(),
            Self::Declined(reason) => format!("declined:{reason}"),
            Self::Delegated(reason) => format!("delegated:{reason}"),
            Self::Error(code) => format!("error:{code}"),
        }
    }
}

/// Electron's Display control order, used only to keep the one attribution line
/// readable: the request map's own iteration order is not execution order.
const DISPLAY_LOG_CONTROL_ORDER: [&str; 13] = [
    "quantizationRange",
    "wireFormat",
    "scalingMode",
    "displayScalingMethod",
    "scalingMethod",
    "hue",
    "saturation",
    "brightness",
    "contrast",
    "variableRefreshRate",
    "arcSyncRange",
    "globalVrrMode",
    "vrrMode",
];

/// Most control keys the attribution line considers for one request. A wider
/// patch is summarised as `all(16)+N`: the remainder is only counted, never
/// stored or sorted, so a huge renderer-supplied patch stays cheap to log.
const DISPLAY_LOG_MAX_CONTROL_KEYS: usize = 16;

/// The control keys a `display:apply` patch names, for the attribution line.
/// The colour acknowledgement flag and the Custom pair are companions, never
/// controls, and each key is escaped and capped before it is joined.
fn display_control_summary<'a>(keys: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let mut selected: Vec<(usize, Cow<'a, str>)> =
        Vec::with_capacity(DISPLAY_LOG_MAX_CONTROL_KEYS);
    let mut remainder = 0usize;
    for key in keys {
        if key == DISPLAY_COLOR_FLAG || key == "scalingCustom" { continue; }
        if selected.len() == DISPLAY_LOG_MAX_CONTROL_KEYS { remainder += 1; continue; }
        let rank = DISPLAY_LOG_CONTROL_ORDER
            .iter()
            .position(|owned| *owned == key)
            .unwrap_or(usize::MAX);
        selected.push((rank, display_log_text(key)));
    }
    if selected.is_empty() { return None; }
    // Only the capped set is ever sorted.
    selected.sort_by_key(|(rank, _)| *rank);
    let shown = if selected.len() <= 3 {
        selected.iter().map(|(_, key)| key.as_ref()).collect::<Vec<_>>().join("+")
    } else {
        format!("all({})", selected.len())
    };
    Some(if remainder > 0 { format!("{shown}+{remainder}") } else { shown })
}

/// Render one IPC-supplied key for the attribution line. Control characters are
/// escaped (`\n`, `\r`, `\t`, `\u{..}`) so a forged key cannot start a second
/// line, and the cap applies to the escaped text that is actually written.
fn display_log_text(value: &str) -> Cow<'_, str> {
    const MAX_CHARS: usize = 96;
    if !value.chars().any(char::is_control) && value.chars().count() <= MAX_CHARS {
        return Cow::Borrowed(value);
    }
    let mut out = String::with_capacity(MAX_CHARS);
    let mut written = 0usize;
    for ch in value.chars() {
        let mut piece = String::new();
        match ch {
            '\n' => piece.push_str("\\n"),
            '\r' => piece.push_str("\\r"),
            '\t' => piece.push_str("\\t"),
            ch if ch.is_control() => piece.push_str(&format!("\\u{{{:x}}}", ch as u32)),
            ch => piece.push(ch),
        }
        let piece_chars = piece.chars().count();
        // An escape sequence is never split; the cap is on the written text.
        if written + piece_chars > MAX_CHARS { break; }
        out.push_str(&piece);
        written += piece_chars;
    }
    Cow::Owned(out)
}

fn display_log_key(value: &str) -> String {
    display_log_text(value).into_owned()
}

/// Bounded, log-only view of one Display call. The classifier fills it from the
/// values it already parsed, so logging needs no second `decode`, no second
/// traversal of the request and no unbounded allocation. Every string in it is
/// escaped, capped, and at most 16 control keys are ever considered.
#[derive(Default)]
struct DisplayLogSummary {
    device: Option<String>,
    device_key: Option<String>,
    display_key: Option<String>,
    controls: Option<String>,
}

/// Write the one attribution line without ever panicking: a failed stderr write
/// (detached console, closed pipe) must not change a Display call.
fn display_log_write(line: std::fmt::Arguments<'_>) {
    use std::io::Write;
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// The exact `display:get` line. Split from the writer so a test can prove one
/// call still produces one line. `display:get` carries no display key, so that
/// field is `n/a`.
fn display_get_line(summary: &DisplayLogSummary, outcome: DisplayRouteOutcome) -> String {
    let device = summary.device.as_deref().unwrap_or("-");
    let device_key = summary.device_key.as_deref().unwrap_or("-");
    format!(
        "[display] get device={device} deviceKey={device_key} displayKey=n/a outcome={}",
        outcome.label(),
    )
}

/// The exact `display:apply` line: requested control keys and the outcome, never
/// a payload dump.
fn display_apply_line(summary: &DisplayLogSummary, outcome: DisplayRouteOutcome) -> String {
    let device = summary.device.as_deref().unwrap_or("-");
    let device_key = summary.device_key.as_deref().unwrap_or("-");
    let display_key = summary.display_key.as_deref().unwrap_or("-");
    let controls = summary.controls.as_deref().unwrap_or("-");
    format!(
        "[display] apply device={device} deviceKey={device_key} displayKey={display_key} controls={controls} outcome={}",
        outcome.label(),
    )
}

fn log_display_get(summary: &DisplayLogSummary, outcome: DisplayRouteOutcome) {
    display_log_write(format_args!("{}", display_get_line(summary, outcome)));
}

fn log_display_apply(summary: &DisplayLogSummary, outcome: DisplayRouteOutcome) {
    display_log_write(format_args!("{}", display_apply_line(summary, outcome)));
}

/// Keep mock/unelevated calls on Electron. An eligible native host requires a
/// stable physical adapter key. `None` is reserved for a decline before native
/// reconciliation, so the broker can revalidate the expected key under its
/// own Display lock after the native guard is released. Errors from or after
/// reconciliation fail closed.
fn route_display_get(
    channel: &str,
    args: &Value,
    native_available: bool,
    native_get: impl FnOnce(u64, &str) -> Result<Option<Value>, String>,
) -> Option<Result<Value, String>> {
    let (outcome, summary, routed) =
        classify_display_get(channel, args, native_available, native_get);
    log_display_get(&summary, outcome);
    routed
}

/// The routing decisions of `display:get`, split out so the attribution line
/// can classify every exit without duplicating them. The log summary is filled
/// here, once, from the values this parse already produced.
fn classify_display_get(
    channel: &str,
    args: &Value,
    native_available: bool,
    native_get: impl FnOnce(u64, &str) -> Result<Option<Value>, String>,
) -> (DisplayRouteOutcome, DisplayLogSummary, Option<Result<Value, String>>) {
    let mut summary = DisplayLogSummary::default();
    if !native_available { return (DisplayRouteOutcome::Declined("host"), summary, None); }
    let (device_id, expected_key) = match display_get_args(channel, args) {
        Ok(parsed) => parsed,
        // Argument parsing answered with an error; the broker never receives it.
        Err(error) => return (DisplayRouteOutcome::Error("shape"), summary, Some(Err(error))),
    };
    summary.device = Some(device_id.to_string());
    summary.device_key = expected_key.as_deref().map(display_log_key);
    let Some(expected_key) = expected_key else {
        // Also an error answer: no fallback, so it must not read as a decline.
        return (
            DisplayRouteOutcome::Error("identity"),
            summary,
            Some(Err("The selected graphics adapter identity is unavailable; refresh Display and try again.".into())),
        );
    };
    match native_get(device_id, &expected_key) {
        Ok(Some(payload)) => {
            // The returned value stays exactly `Some(encode_json(&payload))`;
            // only the label distinguishes an encode failure.
            let routed = encode_json(&payload);
            let outcome = if routed.is_ok() {
                DisplayRouteOutcome::Native
            } else {
                DisplayRouteOutcome::Error("encode")
            };
            (outcome, summary, Some(routed))
        }
        // A pre-write ownership/preflight decline releases the native guard;
        // the broker revalidates the same key under its own Display lock.
        Ok(None) => (DisplayRouteOutcome::Declined("ownership"), summary, None),
        Err(error) => (DisplayRouteOutcome::Error("fail-closed"), summary, Some(Err(error))),
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum NativeDisplayApplyField {
    QuantizationRange(i32),
    RetroScaling(super::display_retro_scaling_apply::RetroScalingWrite),
    /// The UI's coupled Retro entry request is one adapter-level write. Raw
    /// identity selects this branch but is never set; Electron adds identity
    /// and alias response mirrors only when the optional legacy alias is sent.
    RetroScalingEntry {
        write: super::display_retro_scaling_apply::RetroScalingWrite,
        has_method_alias: bool,
    },
    WireFormat(super::display_wire_format_apply::WireFormatPair),
    GlobalVrrMode(&'static str),
    ArcSyncProfile(super::display_arc_sync_apply::ArcSyncProfile),
    /// The custom Arc Sync refresh window (`arcSyncRange`), or its `null`
    /// restore. The frame-time bounds are never part of the request: the
    /// transaction reads the driver's own values immediately before its SET.
    ArcSyncRange(super::display_arc_sync_apply::ArcSyncRangeRequest),
    VariableRefreshRate(bool),
    ScalingMode(super::display_scaling_apply::DisplayScalingPatch),
    Color(super::display_color_apply::DisplayColorPatch),
}

impl NativeDisplayApplyField {
    /// Every `perControl` key this one field answers for. The colour
    /// acknowledgement is a flag, never a control; the entry step and Scaling
    /// Mode transaction each own their response mirrors.
    fn control_keys(self) -> Vec<&'static str> {
        match self {
            Self::QuantizationRange(_) => vec!["quantizationRange"],
            Self::RetroScaling(_) => vec!["scalingMethod"],
            Self::RetroScalingEntry { has_method_alias, .. } => {
                let mut keys = vec!["scalingMethod"];
                if has_method_alias {
                    keys.push("displayScalingMethod");
                    keys.push("scalingMode");
                }
                keys
            }
            Self::WireFormat(_) => vec!["wireFormat"],
            Self::GlobalVrrMode(_) => vec!["globalVrrMode"],
            Self::ArcSyncProfile(_) => vec!["vrrMode"],
            Self::ArcSyncRange(_) => vec!["arcSyncRange"],
            Self::VariableRefreshRate(_) => vec!["variableRefreshRate"],
            Self::ScalingMode(patch) => {
                let mut keys = vec!["scalingMode"];
                if patch.has_method_alias { keys.push("displayScalingMethod"); }
                if patch.retro_disable.is_some() { keys.push("scalingMethod"); }
                keys
            }
            Self::Color(patch) => patch.requested_keys().map(|key| key.name()).collect(),
        }
    }
}

/// The ordered keyed sequence one routed `display:apply` request executes:
/// Electron's control order (`igcl-backend.js:4613-5120`) with
/// `displayScalingMethod` riding on the Scaling Mode transaction it mirrors.
/// One step is the shipped single-control request; several are a floating
/// "Apply all".
#[derive(Clone, Debug, PartialEq)]
struct NativeDisplayApplyPlan {
    steps: Vec<NativeDisplayApplyField>,
}

impl NativeDisplayApplyPlan {
    fn steps(&self) -> &[NativeDisplayApplyField] { &self.steps }

    /// A copy of the keyed sequence, for assertions that must not borrow.
    #[cfg(test)]
    fn fields(&self) -> Vec<NativeDisplayApplyField> { self.steps.clone() }

    fn len(&self) -> usize { self.steps.len() }

    /// One entry per requested control key, in execution order, with the
    /// acknowledgement flag and the pre-SET companions excluded - exactly the
    /// keys `perControl` must answer for.
    #[cfg(test)]
    fn control_keys(&self) -> Vec<&'static str> {
        let mut keys = Vec::new();
        for step in &self.steps {
            for key in step.control_keys() {
                if !keys.contains(&key) { keys.push(key); }
            }
        }
        keys
    }
}

/// One routed control's verdict inside the plan.
#[derive(Debug)]
enum DisplayStepOutcome {
    /// The transaction owns this control's verdict. `ok` already folds every
    /// group/setter result the control has.
    Applied { ok: bool, per_control: Map<String, Value> },
    /// The control applied and its own transaction also handled the coupled
    /// Retro exit: it disabled the adapter surface and then put the previous
    /// state back. `restored` is that restore's verified outcome (`false` when
    /// the driver state is unknown, never a claim of success).
    ///
    /// The transaction owns `scalingMethod` from here on, so the later
    /// standalone Retro step must not write: after a verified restore a second
    /// disable would undo a failure, and after an unverified restore it would
    /// write on a state we cannot prove. Only a composed request can reach this
    /// verdict, because a single-control Scaling Mode request has no standalone
    /// Retro step to suppress.
    AppliedWithRetroRestore {
        ok: bool,
        per_control: Map<String, Value>,
        restored: bool,
    },
    /// The transaction stopped before its first SET. Delegating is only safe
    /// while no sibling has mutated anything.
    Declined,
}

struct DisplayPlanRun {
    ok: bool,
    per_control: Map<String, Value>,
}

/// Run the composer's keyed sequence under the caller's single Display
/// transaction.
///
/// A control failure is recorded and the remaining controls still run in order:
/// Electron does not roll a sibling back. A pre-SET decline is only delegable
/// before the first applied control; after it the request stays native-owned,
/// because retrying on the broker could run the same driver writes twice.
///
/// A Scaling Mode transaction that already handled the coupled Retro exit also
/// owns `scalingMethod`: the later standalone Retro step is skipped entirely, so
/// a failed apply can never re-disable the state its own restore just put back.
/// A skipped write is not a control failure - the coupled record already carries
/// the verdict, and the top-level `ok` is untouched by the skip.
fn run_display_plan(
    plan: &NativeDisplayApplyPlan,
    mut apply: impl FnMut(&NativeDisplayApplyField) -> DisplayStepOutcome,
) -> Option<DisplayPlanRun> {
    let mut run = DisplayPlanRun { ok: true, per_control: Map::new() };
    let mut mutated = false;
    let mut retro_owned = false;
    for step in plan.steps() {
        if retro_owned && matches!(step, NativeDisplayApplyField::RetroScaling(_)) {
            // Suppressed, never attempted: no SET and no verdict of its own.
            continue;
        }
        match apply(step) {
            DisplayStepOutcome::Applied { ok, per_control } => {
                // Any applied control may have reached a setter, so from here
                // the request can never fall back to Electron.
                mutated = true;
                run.ok &= ok;
                for (key, value) in per_control {
                    // The first control to answer for a key owns the entry: the
                    // coupled Retro record outranks the later standalone
                    // confirmation of the same control.
                    run.per_control.entry(key).or_insert(value);
                }
            }
            DisplayStepOutcome::AppliedWithRetroRestore { ok, per_control, restored } => {
                mutated = true;
                retro_owned = true;
                run.ok &= ok;
                for (key, value) in per_control {
                    run.per_control.entry(key).or_insert(value);
                }
                if !restored {
                    // The restore did not verify: the adapter's Retro tuple is
                    // unknown, so say that instead of inheriting the coupled
                    // "was restored" record.
                    if let Some(Value::Object(entry)) = run.per_control.get_mut("scalingMethod") {
                        entry.insert("message".into(), json!(RETRO_SCALING_UNVERIFIED_MESSAGE));
                    }
                }
            }
            DisplayStepOutcome::Declined if !mutated => return None,
            DisplayStepOutcome::Declined => {
                run.ok = false;
                for key in step.control_keys() {
                    run.per_control.entry(key.to_owned()).or_insert(json!({
                        "ok": false,
                        "errorCode": "io-failed",
                        "message": DISPLAY_CONTROL_NOT_ATTEMPTED_MESSAGE,
                    }));
                }
            }
        }
    }
    Some(run)
}

/// One apply envelope. `displayState` comes from a fresh read taken under the
/// same guard after the plan ran: a state that read cannot prove is an error,
/// never a fabricated or stale `displayState`. Absent optionals are omitted,
/// never `null`.
fn display_apply_envelope(
    run: DisplayPlanRun,
    read_state: impl FnOnce() -> Result<Option<Value>, String>,
) -> Result<Value, String> {
    let display_state = read_state()?
        .ok_or_else(|| super::display::DISPLAY_READ_UNPROVEN_ERROR.to_owned())?;
    Ok(json!({
        "ok": run.ok,
        "perControl": Value::Object(run.per_control),
        "displayState": display_state,
    }))
}

/// Shape gate for native Scaling Mode. Only the renderer's verified shapes
/// pass: the raw flag, the GPU method alias, the Custom pair (`scalingCustom`
/// only alongside `scalingMode: 'custom'`) and the coupled Retro-disable
/// companion. Retro entry is parsed separately because its raw identity value
/// identifies the Retro branch, not an ordinary scaling write. It is handed the
/// request's four scaling keys only; owning the
/// rest of the patch (a foreign key declines the whole request) is the plan
/// allowlist's job, and every decline happens before any write so Electron
/// keeps its exact multi-write and alias semantics.
fn display_scaling_patch(
    patch: &Map<String, Value>,
) -> Option<super::display_scaling_apply::DisplayScalingPatch> {
    const OWNED: [&str; 4] = ["scalingMode", "displayScalingMethod", "scalingMethod", "scalingCustom"];
    if patch.keys().any(|key| !OWNED.contains(&key.as_str())) { return None; }
    let scaling_type = super::display_scaling_apply::scaling_type_from_name(
        patch.get("scalingMode")?.as_str()?,
    )?;
    let has_method_alias = match patch.get("displayScalingMethod") {
        None => false,
        Some(value) => {
            let alias = value.as_str()?;
            if !super::display_scaling_apply::scaling_alias_matches(scaling_type, alias) { return None; }
            true
        }
    };
    let retro_disable = match patch.get("scalingMethod") {
        None => None,
        Some(value) => {
            let method = value.as_object()?;
            // Only the disable companion is coupled here. Retro entry is
            // parsed as its own adapter-level step in `display_apply_plan`.
            if method.len() != 2 || method.get("enabled")?.as_bool()? { return None; }
            Some(match method.get("method")?.as_str()? {
                "integer" => super::display_retro_scaling_apply::RetroScalingMethod::Integer,
                "nearest-neighbour" => super::display_retro_scaling_apply::RetroScalingMethod::NearestNeighbour,
                _ => return None,
            })
        }
    };
    // Custom coordinates travel only with `scalingMode: 'custom'`; the renderer
    // always sends the pair with that raw flag (`graphics.ts:2282`, `:2308`).
    // A pairless Custom request stays broker-owned because Electron derives the
    // retained pair itself (`igcl-display-scaling.js:113-119`).
    let custom = match patch.get("scalingCustom") {
        None if scaling_type == 16 => return None,
        None => None,
        Some(value) => {
            if scaling_type != 16 { return None; }
            let object = value.as_object()?;
            // Only Electron's own pair keys are accepted; a foreign key is a
            // shape `ipc-core.js:428-435` refuses itself.
            if object.len() < 2
                || object.keys().any(|key| !matches!(key.as_str(), "x" | "y" | "hardwareModeSet"))
            {
                return None;
            }
            let x = object.get("x")?.as_u64()?;
            let y = object.get("y")?.as_u64()?;
            if x > 100 || y > 100 { return None; }
            // The flag stays type-checked (`igcl-display-scaling.js:104`). The
            // native write couples hardware-mode to type 16, so an explicit
            // `false` is a shape this transaction cannot represent and stays
            // Electron-owned.
            match object.get("hardwareModeSet") {
                None | Some(Value::Bool(true)) => {}
                Some(_) => return None,
            }
            Some((x as u32, y as u32))
        }
    };
    Some(super::display_scaling_apply::DisplayScalingPatch {
        scaling_type,
        custom,
        has_method_alias,
        retro_disable,
    })
}

/// Parse Electron's Retro-entry pair as one adapter-level operation. The raw
/// `identity` selector is not sent to `ctlSetCurrentScaling` when Retro is
/// being entered; Electron uses it to identify this branch and mirrors it only with the legacy alias.
fn display_retro_entry_patch(
    patch: &Map<String, Value>,
) -> Option<(super::display_retro_scaling_apply::RetroScalingWrite, bool)> {
    if patch.keys().any(|key| !matches!(key.as_str(),
        "scalingMode" | "displayScalingMethod" | "scalingMethod"))
        || patch.get("scalingMode")?.as_str()? != "identity"
    {
        return None;
    }
    let write = retro_scaling_write(patch.get("scalingMethod")?)?;
    if !write.enabled { return None; }
    let has_method_alias = match patch.get("displayScalingMethod") {
        None => false,
        Some(value) => {
            let alias = value.as_str()?;
            let expected = match write.method {
                super::display_retro_scaling_apply::RetroScalingMethod::Integer => "integer",
                super::display_retro_scaling_apply::RetroScalingMethod::NearestNeighbour => "nearest-neighbour",
            };
            if alias != expected { return None; }
            true
        }
    };
    Some((write, has_method_alias))
}

const DISPLAY_COLOR_FLAG: &str = "replaceExistingColorSettings";

/// The four patch keys the Scaling Mode transaction owns: the raw selector, the
/// IGS method alias, the Retro exit companion and the Custom pair.
const DISPLAY_SCALING_PATCH_KEYS: [&str; 4] =
    ["scalingMode", "displayScalingMethod", "scalingMethod", "scalingCustom"];

/// Shape gate for one `quantizationRange` value.
fn quantization_range_value(value: &Value) -> Option<i32> {
    match value.as_str()? {
        "default" => Some(0),
        "limited" => Some(1),
        "full" => Some(2),
        _ => None,
    }
}

/// Shape gate for one `wireFormat` pair.
fn wire_format_pair(value: &Value) -> Option<super::display_wire_format_apply::WireFormatPair> {
    let wire = value.as_object()?;
    if wire.len() != 2 { return None; }
    let color_model = match wire.get("model")?.as_str()? {
        "RGB" => 0,
        "YCbCr420" => 1,
        "YCbCr422" => 2,
        "YCbCr444" => 3,
        _ => return None,
    };
    let color_depth = match wire.get("depth")?.as_u64()? {
        6 => 1,
        8 => 2,
        10 => 4,
        12 => 8,
        _ => return None,
    };
    Some(super::display_wire_format_apply::WireFormatPair { color_model, color_depth })
}

/// Shape gate for one adapter-wide `globalVrrMode` value.
fn global_vrr_mode(value: &Value) -> Option<&'static str> {
    match value.as_str()? {
        "fullscreen" => Some("fullscreen"),
        "fullscreen-windowed" => Some("fullscreen-windowed"),
        "disabled" => Some("disabled"),
        _ => None,
    }
}

/// Shape gate for one adapter-level `scalingMethod` write. The entry pair is
/// handled separately by `display_retro_entry_patch`; this parser also accepts
/// standalone enable/disable writes and the coupled Scaling Mode disable.
fn retro_scaling_write(
    value: &Value,
) -> Option<super::display_retro_scaling_apply::RetroScalingWrite> {
    let method = value.as_object()?;
    if method.len() != 2 { return None; }
    let enabled = method.get("enabled")?.as_bool()?;
    let method = match method.get("method")?.as_str()? {
        "integer" => super::display_retro_scaling_apply::RetroScalingMethod::Integer,
        "nearest-neighbour" => super::display_retro_scaling_apply::RetroScalingMethod::NearestNeighbour,
        _ => return None,
    };
    Some(super::display_retro_scaling_apply::RetroScalingWrite { enabled, method })
}

/// SD-5 allowlist: build the ordered keyed sequence for one `display:apply`
/// patch, or decline the whole request.
///
/// Every control key this build owns appears here in Electron's execution
/// order (`igcl-backend.js:4613-5120`): quantization, wire format, Scaling Mode
/// (with its method mirror and Retro exit companion), the Retro write, the two
/// colour groups, Variable Refresh Rate, the Arc Sync custom refresh window and
/// the global VRR mode. A key outside that set - including `scalingCustom`
/// without `scalingMode: 'custom'`, a pairless Custom request, an
/// acknowledgement-only flag and any unknown key - returns `None`, so an owned
/// subset is never applied on its own.
fn display_apply_plan(patch: &Map<String, Value>) -> Option<NativeDisplayApplyPlan> {
    // The acknowledgement flag and the Custom pair are companions, not
    // controls: they never count toward a request's control keys.
    let controls = patch.keys()
        .filter(|key| key.as_str() != DISPLAY_COLOR_FLAG && key.as_str() != "scalingCustom")
        .count();
    if controls == 0 { return None; }
    for key in patch.keys() {
        let owned = DISPLAY_SCALING_PATCH_KEYS.contains(&key.as_str())
            || matches!(key.as_str(),
                "quantizationRange" | "wireFormat" | "variableRefreshRate" | "arcSyncRange"
                    | "globalVrrMode" | "vrrMode" | "hue" | "saturation" | "brightness" | "contrast")
            || key == DISPLAY_COLOR_FLAG;
        if !owned { return None; }
    }
    // The acknowledgement is only meaningful beside a colour control; alone it
    // stays broker-owned rather than becoming an empty native apply.
    if patch.contains_key(DISPLAY_COLOR_FLAG) && !names_a_display_color_control(patch) {
        return None;
    }
    let single_control = controls == 1;
    // A composed request is a floating "Apply all": it names a control outside
    // the Scaling Mode group, so each control answers for its own `perControl`
    // entry. A request made only of the Scaling Mode group keeps the shipped
    // single-control envelope, where the Retro exit is a companion of that one
    // transaction and never a second step.
    let composed = patch.keys().any(|key| {
        !DISPLAY_SCALING_PATCH_KEYS.contains(&key.as_str()) && key != DISPLAY_COLOR_FLAG
    });
    let mut steps = Vec::new();
    let mut retro_entry = false;

    // 1. quantizationRange
    if let Some(value) = patch.get("quantizationRange") {
        steps.push(NativeDisplayApplyField::QuantizationRange(quantization_range_value(value)?));
    }
    // 2. wireFormat
    if let Some(value) = patch.get("wireFormat") {
        steps.push(NativeDisplayApplyField::WireFormat(wire_format_pair(value)?));
    }
    // 3. scalingMode, with its `displayScalingMethod` mirror and the coupled
    // Retro exit companion validated by the shipped P2/P4 shape gate. The UI's
    // Retro-entry pair occupies this order slot but has no raw scaling SET.
    let names_scaling_patch = patch.contains_key("scalingMode")
        || patch.contains_key("displayScalingMethod")
        || patch.contains_key("scalingCustom");
    if names_scaling_patch {
        let subset: Map<String, Value> = patch.iter()
            .filter(|(key, _)| DISPLAY_SCALING_PATCH_KEYS.contains(&key.as_str()))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        if let Some((write, has_method_alias)) = display_retro_entry_patch(&subset) {
            retro_entry = true;
            steps.push(NativeDisplayApplyField::RetroScalingEntry { write, has_method_alias });
        } else {
            steps.push(NativeDisplayApplyField::ScalingMode(display_scaling_patch(&subset)?));
        }
    }
    // 4. the adapter-level Retro write of a composed request. The disable pair is
    // also the companion consumed by step 3, so a composed "Apply all" carries it
    // twice by design: the coupled exit runs inside the Scaling Mode transaction
    // first, and this step then observes an already-disabled surface and writes
    // nothing. A request made only of the Scaling Mode group keeps the companion
    // inside that one transaction, exactly as shipped. Retro entry is already
    // represented by its coupled step above; a standalone enable paired with
    // another control remains broker-owned.
    if let Some(value) = patch.get("scalingMethod") {
        let write = retro_scaling_write(value)?;
        if write.enabled && !single_control && !retro_entry { return None; }
        if !retro_entry && (composed || !names_scaling_patch) {
            steps.push(NativeDisplayApplyField::RetroScaling(write));
        }
    }
    // 5. the colour groups, one transaction in Electron's hueSaturation then
    // brightnessContrast order.
    if names_a_display_color_control(patch) {
        let subset: Map<String, Value> = patch.iter()
            .filter(|(key, _)| key.as_str() == DISPLAY_COLOR_FLAG
                || super::display_color_apply::DisplayColorKey::from_name(key).is_some())
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect();
        steps.push(NativeDisplayApplyField::Color(display_color_patch(&subset)?));
    }
    // 6. variableRefreshRate
    if let Some(value) = patch.get("variableRefreshRate") {
        steps.push(NativeDisplayApplyField::VariableRefreshRate(value.as_bool()?));
    }
    // 7. the Arc Sync custom refresh window (`arcSyncRange`). `null` is the
    // defined restore, so a request without bounds of its own still routes; the
    // staged gate proves the row is writable and has an admitted window before
    // this step runs.
    if let Some(value) = patch.get("arcSyncRange") {
        steps.push(NativeDisplayApplyField::ArcSyncRange(
            super::display_arc_sync_apply::arc_sync_range_request(value)?,
        ));
    }
    // 8. globalVrrMode
    if let Some(value) = patch.get("globalVrrMode") {
        steps.push(NativeDisplayApplyField::GlobalVrrMode(global_vrr_mode(value)?));
    }
    // The legacy Arc Sync profile write is not part of the composed order, so it
    // stays a single-control request.
    if let Some(value) = patch.get("vrrMode") {
        if !single_control { return None; }
        steps.push(NativeDisplayApplyField::ArcSyncProfile(
            super::display_arc_sync_apply::ArcSyncProfile::from_name(value.as_str()?)?,
        ));
    }
    (!steps.is_empty()).then(|| NativeDisplayApplyPlan { steps })
}

/// Shape gate for native Display color. Only a patch made of 1..4 color
/// controls plus the optional `replaceExistingColorSettings` acknowledgement
/// passes. The acknowledgement is a flag, never a control: it produces no
/// `perControl` entry and never counts as a control key, so a flag-only patch
/// declines to Electron. It is handed the request's colour keys (and the flag)
/// only; a mistyped value or a foreign key still declines the whole request
/// before any write because the plan allowlist runs first.
fn display_color_patch(
    patch: &Map<String, Value>,
) -> Option<super::display_color_apply::DisplayColorPatch> {
    let mut requested = super::display_color_apply::DisplayColorPatch::default();
    let mut controls = 0;
    for (name, value) in patch {
        if name == DISPLAY_COLOR_FLAG {
            requested.replace_existing = value.as_bool()?;
            continue;
        }
        let key = super::display_color_apply::DisplayColorKey::from_name(name)?;
        requested.set(key, value.as_f64()?);
        controls += 1;
    }
    (controls > 0).then_some(requested)
}

/// True when the patch names at least one color control. The color branch must
/// be chosen before the single-control fallbacks so a color patch is either
/// served whole or declined whole.
fn names_a_display_color_control(patch: &Map<String, Value>) -> bool {
    patch.keys().any(|name| super::display_color_apply::DisplayColorKey::from_name(name).is_some())
}

/// Route every request the shipped phases own, composed in Electron's order:
/// quantization, wire format, Scaling Mode (with its method mirror and Retro
/// exit companion), the Retro write, the colour groups, Variable Refresh Rate,
/// the Arc Sync custom refresh window and the global VRR mode - plus the
/// single-control Arc Sync profile write.
/// A patch naming any control this build does not own declines whole before any
/// write; the owned subset is never applied alone.
fn route_display_apply(
    channel: &str,
    args: &Value,
    native_available: bool,
    native_apply: impl FnOnce(
        u64,
        &str,
        &str,
        NativeDisplayApplyPlan,
    ) -> Result<Option<Value>, String>,
) -> Option<Result<Value, String>> {
    let (outcome, summary, routed) =
        classify_display_apply(channel, args, native_available, native_apply);
    log_display_apply(&summary, outcome);
    routed
}

/// The routing decisions of `display:apply`, split out so the attribution line
/// can classify every exit without duplicating them. The log summary is filled
/// here, once, from the values this parse already produced. `delegated` always
/// means "no control ran", because every decline below happens before the first
/// SET; `error:fail-closed` and `error:encode` are the outcomes the broker must
/// not retry.
fn classify_display_apply(
    channel: &str,
    args: &Value,
    native_available: bool,
    native_apply: impl FnOnce(
        u64,
        &str,
        &str,
        NativeDisplayApplyPlan,
    ) -> Result<Option<Value>, String>,
) -> (DisplayRouteOutcome, DisplayLogSummary, Option<Result<Value, String>>) {
    let mut summary = DisplayLogSummary::default();
    if !native_available { return (DisplayRouteOutcome::Delegated("host"), summary, None); }
    let Ok(items) = args_array(channel, args) else { return (DisplayRouteOutcome::Delegated("shape"), summary, None); };
    summary.device = Some(match items.first() {
        Some(WireValue::Number(number)) => number.to_string(),
        Some(_) => "?".into(),
        None => "-".into(),
    });
    if items.len() != 2 { return (DisplayRouteOutcome::Delegated("shape"), summary, None); }
    let Ok(device_id) = graphics_device_id(items.first()) else { return (DisplayRouteOutcome::Delegated("shape"), summary, None); };
    let Ok(request) = items[1].clone().into_json() else { return (DisplayRouteOutcome::Delegated("shape"), summary, None); };
    let Some(object) = request.as_object() else { return (DisplayRouteOutcome::Delegated("shape"), summary, None); };
    if object.len() != 3 { return (DisplayRouteOutcome::Delegated("shape"), summary, None); }
    summary.device_key = object.get("deviceKey").and_then(Value::as_str).map(display_log_key);
    summary.display_key = object.get("displayKey").and_then(Value::as_str).map(display_log_key);
    let Some(device_key) = object.get("deviceKey").and_then(Value::as_str) else { return (DisplayRouteOutcome::Delegated("identity"), summary, None); };
    let Some(display_key) = object.get("displayKey").and_then(Value::as_str) else { return (DisplayRouteOutcome::Delegated("identity"), summary, None); };
    // The current native reader emits canonical PCI/BDF keys. PNP aliases,
    // malformed namespaces and other compatibility keys remain broker-owned.
    if !device_key.starts_with("pci:")
        || device_key.trim().is_empty()
        || !super::display_apply::display_key_belongs_to_device(device_key, display_key)
    {
        return (DisplayRouteOutcome::Delegated("identity"), summary, None);
    }
    let Some(patch) = object.get("patch").and_then(Value::as_object) else { return (DisplayRouteOutcome::Delegated("shape"), summary, None); };
    // The only walk of the patch: at most 16 keys are kept, the rest counted.
    summary.controls = display_control_summary(patch.keys().map(String::as_str));
    let Some(plan) = display_apply_plan(patch) else { return (DisplayRouteOutcome::Delegated("shape"), summary, None); };
    match native_apply(device_id, device_key, display_key, plan) {
        Ok(Some(payload)) => {
            // The returned value stays exactly `Some(encode_json(&payload))`;
            // only the label distinguishes an encode failure.
            let routed = encode_json(&payload);
            let outcome = if routed.is_ok() {
                DisplayRouteOutcome::Native
            } else {
                DisplayRouteOutcome::Error("encode")
            };
            (outcome, summary, Some(routed))
        }
        // A pre-write decline: staging, the support gate, target proof or the
        // transaction's first step all decline before any SET, so the broker
        // can safely own the request.
        Ok(None) => (DisplayRouteOutcome::Delegated("ownership"), summary, None),
        Err(error) => (DisplayRouteOutcome::Error("fail-closed"), summary, Some(Err(error))),
    }
}

/// The one staged read a native apply is allowed to act on: ownership-eligible,
/// no pending scaling invalidation, the same adapter key, and exactly one
/// active, identity-verified output for the requested display key.
fn staged_display_row<'a>(
    staged: &'a super::display::StagedDisplayRead,
    device_key: &str,
    display_key: &str,
) -> Option<&'a Value> {
    if !staged.native_ownership_eligible || !staged.scaling_invalidations.is_empty()
        || staged.payload["deviceKey"].as_str() != Some(device_key)
    {
        return None;
    }
    let displays = staged.payload["displays"].as_array()?;
    let matches: Vec<_> = displays.iter().filter(|display| {
        display["displayKey"].as_str() == Some(display_key)
            && display["identityVerified"].as_bool() == Some(true)
            && display["flags"]["active"].as_bool() == Some(true)
    }).collect();
    let [display] = matches.as_slice() else { return None; };
    Some(display)
}

/// The pre-write support proof for one routed control, decided against the same
/// staged projection for every control in the request.
fn staged_field_supported(display: &Value, field: &NativeDisplayApplyField) -> bool {
    let supported = match field {
        NativeDisplayApplyField::QuantizationRange(value) => {
            let name = match value { 0 => "default", 1 => "limited", 2 => "full", _ => return false };
            display["supportedOptions"]["quantizationRanges"].as_array()
                .is_some_and(|options| options.iter().any(|option| option.as_str() == Some(name)))
        }
        NativeDisplayApplyField::RetroScaling(requested)
        | NativeDisplayApplyField::RetroScalingEntry { write: requested, .. } => {
            let name = match requested.method {
                super::display_retro_scaling_apply::RetroScalingMethod::Integer => "integer",
                super::display_retro_scaling_apply::RetroScalingMethod::NearestNeighbour => "nearest-neighbour",
            };
            display["scalingMethod"]["controllable"].as_bool() == Some(true)
                && display["supportedOptions"]["scalingMethods"].as_array()
                    .is_some_and(|options| options.iter().any(|option| option.as_str() == Some(name)))
        }
        NativeDisplayApplyField::WireFormat(requested) => {
            let model = match requested.color_model {
                0 => "RGB",
                1 => "YCbCr420",
                2 => "YCbCr422",
                3 => "YCbCr444",
                _ => return false,
            };
            let depth = match requested.color_depth {
                1 => 6,
                2 => 8,
                4 => 10,
                8 => 12,
                _ => return false,
            };
            display["supportedOptions"]["wireFormats"].as_array()
                .is_some_and(|options| options.iter().any(|option| option.as_str() == Some(model)))
                && display["supportedOptions"]["bpcDepths"].as_array()
                    .is_some_and(|options| options.iter().any(|option| option.as_u64() == Some(depth)))
        }
        NativeDisplayApplyField::GlobalVrrMode(requested) => {
            display["globalVrrMode"]["controllable"].as_bool() == Some(true)
                && display["supportedOptions"]["globalVrrModes"].as_array()
                    .is_some_and(|options| options.iter().any(|option| option.as_str() == Some(requested)))
        }
        NativeDisplayApplyField::ArcSyncProfile(requested) => {
            display["vrrMode"]["controllable"].as_bool() == Some(true)
                && display["supportedOptions"]["vrrModes"].as_array()
                    .is_some_and(|options| options.iter().any(|option| option.as_str() == Some(requested.name())))
        }
        // The range control's advertised write contract is exactly the two
        // renderer conditions (`graphics.ts` `isDisplayControlSupported`):
        // `arcSync.writable` (which already folds `supported` and the setter,
        // `display.rs:1137`) and an admitted `rangeBounds` window. `null`
        // restore requests have no bounds of their own and are admitted on the
        // same row proof.
        NativeDisplayApplyField::ArcSyncRange(_) => {
            let arc_sync = &display["arcSync"];
            arc_sync["writable"].as_bool() == Some(true)
                && arc_sync["rangeBounds"].as_object().is_some_and(|bounds| {
                    let min_hz = bounds.get("minHz").and_then(Value::as_f64);
                    let max_hz = bounds.get("maxHz").and_then(Value::as_f64);
                    matches!((min_hz, max_hz), (Some(min_hz), Some(max_hz))
                        if min_hz.is_finite() && max_hz.is_finite() && max_hz > min_hz)
                })
        }
        NativeDisplayApplyField::VariableRefreshRate(_) => {
            display["variableRefreshRate"]["controllable"].as_bool() == Some(true)
                && display["arcSync"]["supported"].as_bool() == Some(true)
                && display["arcSync"]["profile"].as_str()
                    .and_then(super::display_arc_sync_apply::ArcSyncProfile::from_name).is_some()
        }
        NativeDisplayApplyField::ScalingMode(requested) => {
            let Some(name) = super::display_scaling_apply::scaling_name(requested.scaling_type) else {
                return false;
            };
            // A Custom selection has no agreed pair without `scalingCustom`.
            if requested.scaling_type == 16 && requested.custom.is_none() { return false; }
            display["supportedOptions"]["scalingModes"].as_array()
                .is_some_and(|options| options.iter().any(|option| option.as_str() == Some(name)))
        }
        // Electron requires a unique supported block for every requested color
        // control before its first SET. The native projection marks a control
        // controllable only when its block resolved unambiguously, the setter
        // exists and the stored intent is readable; anything else is a
        // pre-write decline that Electron must answer.
        NativeDisplayApplyField::Color(requested) => {
            !requested.is_empty()
                && requested.requested_keys().all(|key| {
                    display[key.name()]["controllable"].as_bool() == Some(true)
                })
        }
    };
    supported
}

fn retro_scaling_apply_outcome(
    applied: &super::display_retro_scaling_apply::RetroScalingApplyResult,
) -> Value {
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(applied.ok));
    if applied.ok || applied.read_back.is_some() || applied.silent_noop.is_some() {
        result.insert("readBackEqual".into(), json!(applied.read_back_equal));
    }
    if !applied.ok {
        if let Some(code) = applied.error_code { result.insert("errorCode".into(), json!(code)); }
        if let Some(message) = &applied.message { result.insert("message".into(), json!(message)); }
    }
    if applied.ok || applied.silent_noop.is_some() {
        result.insert("silentNoop".into(), json!(applied.silent_noop.unwrap_or(false)));
        result.insert("warning".into(), json!(RETRO_SCALING_FLASH_WARNING));
    }
    Value::Object(result)
}

/// Electron mirrors the adapter-level Retro result under `displayScalingMethod`
/// and `scalingMode` only when the legacy method alias was included. The current
/// renderer sends the entry pair without that alias and receives only the
/// `scalingMethod` result.
fn retro_scaling_entry_per_control(
    applied: &super::display_retro_scaling_apply::RetroScalingApplyResult,
    has_method_alias: bool,
) -> Map<String, Value> {
    let retro = retro_scaling_apply_outcome(applied);
    let mut controls = per_control_single("scalingMethod", retro.clone());
    if has_method_alias {
        let mut mirror = retro;
        if let Value::Object(fields) = &mut mirror {
            fields.insert("internal".into(), Value::Bool(true));
        }
        controls.insert("displayScalingMethod".into(), mirror.clone());
        controls.insert("scalingMode".into(), mirror);
    }
    controls
}

fn wire_format_apply_outcome(
    applied: &super::display_wire_format_apply::WireFormatApplyResult,
) -> Value {
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(applied.ok));
    // Electron emits these fields only after its SET returned success. Keep
    // that boundary explicit so a setter error is not mislabeled a silent
    // no-op, while an unavailable or mismatched read-back is.
    if applied.setter_succeeded == Some(true) {
        result.insert("readBackEqual".into(), json!(applied.read_back_equal));
        result.insert("silentNoop".into(), json!(!applied.read_back_equal));
    }
    if !applied.ok {
        if let Some(code) = applied.error_code { result.insert("errorCode".into(), json!(code)); }
        if let Some(message) = &applied.message { result.insert("message".into(), json!(message)); }
    }
    Value::Object(result)
}

fn arc_sync_apply_outcome(
    applied: &super::display_arc_sync_apply::ArcSyncApplyResult,
) -> Value {
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(applied.ok));
    if !applied.ok {
        if let Some(code) = applied.error_code { result.insert("errorCode".into(), json!(code)); }
        if let Some(message) = &applied.message { result.insert("message".into(), json!(message)); }
    }
    // Electron emits these two fields only after SET succeeded. A failed SET
    // has no read-back fields; a successful SET with a mismatch or failed GET
    // is reported as a silent no-op.
    if applied.readback_reported {
        result.insert("readBackEqual".into(), json!(applied.read_back_equal));
        result.insert("silentNoop".into(), json!(!applied.read_back_equal));
    }
    Value::Object(result)
}

fn variable_refresh_rate_apply_outcome(
    applied: &super::display_arc_sync_apply::ArcSyncApplyResult,
    requested: bool,
) -> Value {
    let mut result = arc_sync_apply_outcome(applied);
    let requested_profile = if requested {
        super::display_arc_sync_apply::ArcSyncProfile::Recommended
    } else {
        super::display_arc_sync_apply::ArcSyncProfile::Off
    };
    if applied.readback_reported {
        if let Some(actual) = applied.read_back {
            if actual != requested_profile {
                result["message"] = json!(format!(
                    "read-back profile {} != requested {}",
                    actual.igcl_value(), requested_profile.igcl_value(),
                ));
            }
        }
    }
    result
}

/// The `perControl.arcSyncRange` payload. It reuses the profile verdict fields
/// and adds the transaction's own evidence, so a driver clamp is a visible
/// mismatch (`ok: false`, `matched: false`, the observed window) instead of an
/// `ok: true` with a silently different range.
fn arc_sync_range_apply_outcome(
    applied: &super::display_arc_sync_apply::ArcSyncRangeApplyResult,
) -> Value {
    let mut result = match arc_sync_apply_outcome(&applied.result) {
        Value::Object(fields) => fields,
        _ => Map::new(),
    };
    if let Some(evidence) = applied.evidence {
        result.insert("matched".into(), json!(evidence.matched));
        result.insert("requestedMinHz".into(), json!(evidence.requested_min_hz));
        result.insert("requestedMaxHz".into(), json!(evidence.requested_max_hz));
        result.insert("readBackMinHz".into(), json!(evidence.read_back_min_hz));
        result.insert("readBackMaxHz".into(), json!(evidence.read_back_max_hz));
    }
    Value::Object(result)
}

/// The plan verdict for one Arc Sync range transaction. `None` means the
/// transaction stopped before its first SET, so the request is still open to
/// the broker.
fn arc_sync_range_step_outcome(
    applied: &super::display_arc_sync_apply::ArcSyncRangeApplyResult,
) -> Option<DisplayStepOutcome> {
    if applied.setter_succeeded().is_none() { return None; }
    Some(DisplayStepOutcome::Applied {
        ok: applied.ok(),
        per_control: per_control_single("arcSyncRange", arc_sync_range_apply_outcome(applied)),
    })
}

/// One guarded Arc Sync range step. The transaction is injected so tests can
/// prove this seam hands it the exact parsed request and shapes its verdict;
/// the driver semantics (bounds, exact window, frame-time passthrough) are the
/// transaction's own fake-backend tests.
fn apply_arc_sync_range_step(
    requested: super::display_arc_sync_apply::ArcSyncRangeRequest,
    apply: impl FnOnce(
        super::display_arc_sync_apply::ArcSyncRangeRequest,
    ) -> super::display_arc_sync_apply::ArcSyncRangeApplyResult,
) -> DisplayStepOutcome {
    match arc_sync_range_step_outcome(&apply(requested)) {
        Some(outcome) => outcome,
        None => DisplayStepOutcome::Declined,
    }
}

/// Everything one guarded Display apply shares across its controls: the lock
/// proof, the one physical target derived from a single fresh inventory, and the
/// pre-write Retro state the coupled exit decision needs.
struct DisplayApplySession<'a> {
    guard: &'a super::display_lock::DisplayLockGuard,
    device_id: u64,
    device_key: &'a str,
    display_key: &'a str,
    physical_target: &'a Value,
    dll_path: &'a std::path::Path,
    /// Retro Scaling was enabled in the one staged read.
    retro_enabled: bool,
    /// The routed request carries exactly one control, so the shipped
    /// single-control transaction semantics apply verbatim.
    single_control: bool,
}

impl<'a> DisplayApplySession<'a> {
    fn target(&self) -> super::display_apply::DisplayApplyTarget<'a> {
        super::display_apply::DisplayApplyTarget {
            device_id: self.device_id,
            device_key: self.device_key,
            physical_target: self.physical_target,
            display_key: self.display_key,
        }
    }
}

/// Electron only writes the coupled Retro exit when an active scaler actually
/// has to be left (`igcl-backend.js:4666-4669`). A single-control request keeps
/// the shipped transaction verbatim - it declines to Electron rather than
/// guessing - while the composer must decide here, because a pre-SET decline can
/// no longer be delegated once a sibling has written.
fn coupled_retro_disable(
    patch: &super::display_scaling_apply::DisplayScalingPatch,
    retro_enabled: bool,
    single_control: bool,
) -> Option<super::display_retro_scaling_apply::RetroScalingMethod> {
    if single_control { return patch.retro_disable; }
    patch.retro_disable.filter(|_| retro_enabled)
}

/// Apply one step of the plan. Each arm runs one guarded transaction; only its
/// stop-before-SET signal is translated into the plan's `Declined` verdict.
fn apply_display_step(
    session: &DisplayApplySession<'_>,
    field: &NativeDisplayApplyField,
) -> DisplayStepOutcome {
    let guard = session.guard;
    let (device_id, device_key, display_key) =
        (session.device_id, session.device_key, session.display_key);
    match *field {
        NativeDisplayApplyField::QuantizationRange(requested) => {
            let applied = super::display_apply::apply_quantization_range_native(
                guard, &session.target(), requested,
            );
            let per_control = if applied.ok {
                json!({
                    "ok": true,
                    "readBackEqual": applied.read_back_equal,
                    "silentNoop": applied.silent_noop.unwrap_or(false),
                })
            } else {
                let mut result = Map::new();
                result.insert("ok".into(), Value::Bool(false));
                if let Some(code) = applied.error_code { result.insert("errorCode".into(), json!(code)); }
                if let Some(message) = applied.message { result.insert("message".into(), json!(message)); }
                if applied.read_back.is_some() { result.insert("readBackEqual".into(), json!(applied.read_back_equal)); }
                if let Some(silent_noop) = applied.silent_noop { result.insert("silentNoop".into(), json!(silent_noop)); }
                Value::Object(result)
            };
            DisplayStepOutcome::Applied {
                ok: applied.ok,
                per_control: per_control_single("quantizationRange", per_control),
            }
        }
        NativeDisplayApplyField::RetroScaling(requested) => {
            let applied = super::display_retro_scaling_apply::apply_retro_scaling_native(
                guard, &session.target(), requested,
            );
            let per_control = retro_scaling_apply_outcome(&applied);
            DisplayStepOutcome::Applied {
                ok: applied.ok,
                per_control: per_control_single("scalingMethod", per_control),
            }
        }
        NativeDisplayApplyField::RetroScalingEntry { write, has_method_alias } => {
            let applied = super::display_retro_scaling_apply::apply_retro_scaling_native(
                guard, &session.target(), write,
            );
            DisplayStepOutcome::Applied {
                ok: applied.ok,
                per_control: retro_scaling_entry_per_control(&applied, has_method_alias),
            }
        }
        NativeDisplayApplyField::WireFormat(requested) => {
            let applied = super::display_wire_format_apply::apply_wire_format_native(
                guard, &session.target(), requested,
            );
            // `None` proves the private wire transaction stopped before its
            // first SET. The broker may retry this candidate under its own
            // lock and expected-key check; once a SET was attempted, keep the
            // native result closed to avoid double writes.
            if applied.setter_succeeded.is_none() { return DisplayStepOutcome::Declined; }
            let per_control = wire_format_apply_outcome(&applied);
            DisplayStepOutcome::Applied {
                ok: applied.ok,
                per_control: per_control_single("wireFormat", per_control),
            }
        }
        NativeDisplayApplyField::GlobalVrrMode(requested) => {
            let applied = super::display_global_vrr_apply::apply_global_vrr_mode_native(
                guard, session.dll_path, device_id, device_key, requested,
            );
            // Pre-SET declines are safe to delegate after releasing this lock;
            // all direct or registry SET attempts return a native result and
            // are never broker-retried.
            if applied.setter_succeeded.is_none() { return DisplayStepOutcome::Declined; }
            let per_control = applied.per_control_value();
            DisplayStepOutcome::Applied {
                ok: applied.ok,
                per_control: per_control_single("globalVrrMode", per_control),
            }
        }
        NativeDisplayApplyField::ArcSyncProfile(requested) => {
            let applied = super::display_arc_sync_apply::apply_arc_sync_profile_native(
                guard, &session.target(), requested,
            );
            if applied.setter_succeeded.is_none() { return DisplayStepOutcome::Declined; }
            let per_control = arc_sync_apply_outcome(&applied);
            DisplayStepOutcome::Applied {
                ok: applied.ok,
                per_control: per_control_single("vrrMode", per_control),
            }
        }
        NativeDisplayApplyField::ArcSyncRange(requested) => {
            apply_arc_sync_range_step(requested, |requested| {
                super::display_arc_sync_apply::apply_arc_sync_range_native(
                    guard, &session.target(), requested,
                )
            })
        }
        NativeDisplayApplyField::VariableRefreshRate(enabled) => {
            let requested = if enabled {
                super::display_arc_sync_apply::ArcSyncProfile::Recommended
            } else {
                super::display_arc_sync_apply::ArcSyncProfile::Off
            };
            let applied = super::display_arc_sync_apply::apply_arc_sync_profile_native(
                guard, &session.target(), requested,
            );
            if applied.setter_succeeded.is_none() { return DisplayStepOutcome::Declined; }
            let per_control = variable_refresh_rate_apply_outcome(&applied, enabled);
            DisplayStepOutcome::Applied {
                ok: applied.ok,
                per_control: per_control_single("variableRefreshRate", per_control),
            }
        }
        NativeDisplayApplyField::ScalingMode(requested) => {
            let target = super::display_scaling_apply::DisplayScalingTarget {
                device_key: device_key.to_owned(),
                display_key: display_key.to_owned(),
            };
            let write = super::display_scaling_apply::DisplayScalingWrite {
                enabled: true,
                scaling_type: requested.scaling_type,
                custom: requested.custom,
                hardware_mode_set: requested.scaling_type == 16,
            };
            let retro_disable = coupled_retro_disable(
                &requested, session.retro_enabled, session.single_control,
            );
            let applied = match super::display_scaling_apply::apply_display_scaling_mode_native(
                guard, session.physical_target, &target, &write, retro_disable,
            ) {
                // No SET was issued by this control, so it may still be
                // delegated while no sibling has written.
                super::display_scaling_apply::DisplayScalingModeApplyOutcome::Declined =>
                    return DisplayStepOutcome::Declined,
                super::display_scaling_apply::DisplayScalingModeApplyOutcome::Applied(applied) => applied,
            };
            let controls = display_scaling_step_per_control(&applied, &requested);
            scaling_mode_step_outcome(&applied, controls, session.single_control)
        }
        NativeDisplayApplyField::Color(requested) => {
            // Every group in this transaction is a deliberate verdict (an
            // unsent-group refusal, a driver rejection, a store failure or a
            // lost identity) and the staged preflight already proved the
            // target, so the result is never delegated back for a second
            // Electron SET.
            let outcome = super::display_color_apply::apply_display_color_patch_native(
                guard, &session.target(), &requested,
            );
            let controls = display_color_per_control(&requested, &outcome);
            DisplayStepOutcome::Applied { ok: outcome.ok(), per_control: controls }
        }
    }
}

/// Private native transaction for the whole routed plan: one staged read, one
/// physical target, every control in Electron's order, and one fresh public
/// Display read under the same lock. All declines happen against the staged read
/// before reconciliation or a driver setter. Once a setter seam is entered,
/// errors are returned as errors and can never fall back to Electron.
fn apply_display_plan_under_lock(
    guard: &super::display_lock::DisplayLockGuard,
    device_id: u64,
    device_key: &str,
    display_key: &str,
    plan: NativeDisplayApplyPlan,
    store: Option<&NativeStore>,
) -> Result<Option<Value>, String> {
    if !guard.is_held() {
        return Err("The Display transaction lock is no longer held.".into());
    }
    let staged = match super::display::get_staged_under_lock(guard, device_id, device_key) {
        Ok(staged) => staged,
        // This staging path is read-only. Let the broker retry if the native
        // reader cannot prove the same complete response it would return.
        Err(_) => return Ok(None),
    };
    // One staged read answers every control in the request: each support gate is
    // decided against this same pre-write projection, never a re-stage per
    // control, and any unsupported control declines the whole request before the
    // first SET so an owned subset is never applied alone.
    let Some(display) = staged_display_row(&staged, device_key, display_key) else {
        return Ok(None);
    };
    if plan.steps().iter().any(|field| !staged_field_supported(display, field)) {
        return Ok(None);
    }

    // The public renderer request intentionally carries stable keys, not the
    // broker's physicalTarget helper output. Derive proof from a fresh native
    // inventory, then the private setter independently re-enumerates and
    // checks that exact ordinal/key/proof before its first SET.
    let Some(dll_path) = super::display_igcl_dll::locate_dll() else { return Ok(None); };
    let inventory = match super::gpu_devices::list_devices(&dll_path) {
        Ok(inventory) => inventory,
        Err(_) => return Ok(None),
    };
    let Some(rows) = inventory.as_array() else { return Ok(None); };
    let rows: Vec<_> = rows.iter().filter(|row| {
        row["id"].as_u64() == Some(device_id)
            && row["deviceKey"].as_str() == Some(device_key)
            && row["synthetic"].as_bool() != Some(true)
            && row["backendKind"].as_str() != Some("os")
    }).collect();
    let [physical_target] = rows.as_slice() else { return Ok(None); };

    let session = DisplayApplySession {
        guard,
        device_id,
        device_key,
        display_key,
        physical_target,
        dll_path: &dll_path,
        retro_enabled: display["scalingMethod"]["value"]["enabled"].as_bool() == Some(true),
        single_control: plan.len() == 1,
    };
    let Some(run) = run_display_plan(&plan, |field| apply_display_step(&session, field)) else {
        // Only reachable while no control has written anything.
        return Ok(None);
    };
    // The complete fresh public payload must be produced while the same lock is
    // still held. A post-set failure is hard and must not trigger broker retry
    // because the driver may already have changed.
    let envelope = display_apply_envelope(run, || {
        super::display::get_if_owned_under_lock(guard, device_id, device_key)
    })?;
    if let Some(store) = store {
        remember_arc_sync_range(store, device_key, display_key, &plan, &envelope)?;
    }
    Ok(Some(envelope))
}

fn arc_sync_range_store(store: &NativeStore) -> Result<super::sidecar_file::SidecarFile, String> {
    use super::sidecar_file::{Sidecar, SidecarFile};
    SidecarFile::new(store.root().to_path_buf(), Sidecar::ArcSyncRanges)
}

fn saved_arc_sync_ranges(value: Option<Value>) -> Result<Map<String, Value>, String> {
    let Some(value) = value else { return Ok(Map::new()); };
    if value["version"].as_u64() != Some(1) {
        return Err("Unsupported saved Arc Sync range format.".into());
    }
    value["ranges"].as_object().cloned().ok_or_else(|| "Invalid saved Arc Sync ranges.".into())
}

fn durable_arc_sync_device_key(display_key: &str) -> Option<&str> {
    let (device_key, output) = display_key.split_once("|display|")?;
    let (encoder, edid) = output.split_once("|edid|")?;
    (device_key.starts_with("pci:") && !encoder.is_empty()
        && edid.len() == 8 && edid.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(device_key)
}

fn remember_arc_sync_range(
    store: &NativeStore,
    device_key: &str,
    display_key: &str,
    plan: &NativeDisplayApplyPlan,
    envelope: &Value,
) -> Result<(), String> {
    let requested_profile = plan.steps().iter().rev().find_map(|step| match step {
        NativeDisplayApplyField::ArcSyncRange(request) => Some(("arcSyncRange", request.profile())),
        NativeDisplayApplyField::ArcSyncProfile(profile) => Some(("vrrMode", *profile)),
        NativeDisplayApplyField::VariableRefreshRate(enabled) => Some(("variableRefreshRate", if *enabled {
            super::display_arc_sync_apply::ArcSyncProfile::Recommended
        } else {
            super::display_arc_sync_apply::ArcSyncProfile::Off
        })),
        _ => None,
    });
    let Some((control, requested_profile)) = requested_profile else { return Ok(()); };
    if durable_arc_sync_device_key(display_key) != Some(device_key) {
        return Ok(());
    }
    let per = &envelope["perControl"];
    let result = &per[control];
    if result["ok"].as_bool() != Some(true) || result["readBackEqual"].as_bool() != Some(true) {
        return Ok(());
    }
    let state = &envelope["displayState"];
    if state["deviceKey"].as_str() != Some(device_key) {
        return Ok(());
    }
    let Some(displays) = state["displays"].as_array() else { return Ok(()); };
    let mut matches = displays.iter().filter(|row| {
        row["displayKey"].as_str() == Some(display_key)
            && row["identityVerified"].as_bool() == Some(true)
            && row["flags"]["active"].as_bool() == Some(true)
    });
    let Some(display) = matches.next() else { return Ok(()); };
    if matches.next().is_some() { return Ok(()); }
    let profile = display["arcSync"]["profile"].as_str();
    if profile != Some(requested_profile.name()) { return Ok(()); }
    let next = if control == "arcSyncRange" && result["matched"].as_bool() == Some(true) {
        match profile {
            Some("custom") => {
                let current = &display["arcSync"]["currentRange"];
                if current["minHz"] != result["readBackMinHz"] || current["maxHz"] != result["readBackMaxHz"]
                    || !matches!(super::display_arc_sync_apply::arc_sync_range_request(current),
                        Some(super::display_arc_sync_apply::ArcSyncRangeRequest::Custom(_)))
                {
                    return Ok(());
                }
                Some(current.clone())
            }
            Some("recommended") => None,
            _ => return Ok(()),
        }
    } else if control != "arcSyncRange" {
        if requested_profile == super::display_arc_sync_apply::ArcSyncProfile::Custom {
            let current = &display["arcSync"]["currentRange"];
            if !matches!(super::display_arc_sync_apply::arc_sync_range_request(current),
                Some(super::display_arc_sync_apply::ArcSyncRangeRequest::Custom(_)))
            {
                return Ok(());
            }
            Some(current.clone())
        } else {
            Some(json!(requested_profile.name()))
        }
    } else {
        return Ok(());
    };
    arc_sync_range_store(store)?.transaction_optional(|old| {
        let mut ranges = saved_arc_sync_ranges(old)?;
        if ranges.get(display_key) == next.as_ref() { return Ok((None, ())); }
        match next {
            Some(value) => { ranges.insert(display_key.to_owned(), value); }
            None => { ranges.remove(display_key); }
        }
        Ok((Some(json!({ "version": 1, "ranges": ranges })), ()))
    })
}

/// Reapply previously verified Arc Sync intent once to currently proven outputs.
/// Both the saved intent and the hardware transaction share the Display lock
/// with interactive writes, so startup cannot replay a superseded setting.
pub fn restore_arc_sync_ranges(store: &NativeStore) -> Result<(), String> {
    use super::display_arc_sync_apply::{arc_sync_range_request, ArcSyncProfile, ArcSyncRangeRequest};
    let guard = super::display_lock::acquire()?;
    let ranges = saved_arc_sync_ranges(arc_sync_range_store(store)?.read()?)?;
    if ranges.is_empty() { return Ok(()); }
    let dll = super::display_igcl_dll::locate_dll().ok_or("Display driver runtime is unavailable.")?;
    let inventory = super::gpu_devices::list_devices(&dll)?;
    let inventory = inventory.as_array().ok_or("Display adapter inventory is unavailable.")?;
    for (display_key, intent) in ranges {
        let Some(device_key) = durable_arc_sync_device_key(&display_key) else { continue; };
        let (step, control) = match arc_sync_range_request(&intent) {
            Some(request @ ArcSyncRangeRequest::Custom(_)) => (
                NativeDisplayApplyField::ArcSyncRange(request), "arcSyncRange",
            ),
            _ => {
                let Some(profile) = intent.as_str().and_then(ArcSyncProfile::from_name) else { continue; };
                if profile == ArcSyncProfile::Custom { continue; }
                (NativeDisplayApplyField::ArcSyncProfile(profile), "vrrMode")
            }
        };
        let mut adapters = inventory.iter().filter(|row| {
            row["deviceKey"].as_str() == Some(device_key)
                && row["synthetic"].as_bool() != Some(true)
                && row["backendKind"].as_str() != Some("os")
        });
        let Some(device_id) = adapters.next().and_then(|row| row["id"].as_u64()) else { continue; };
        if adapters.next().is_some() { continue; }
        let staged = match super::display::get_staged_under_lock(&guard, device_id, device_key) {
            Ok(staged) => staged,
            Err(_) => continue,
        };
        let Some(display) = staged_display_row(&staged, device_key, &display_key) else { continue; };
        let current = &display["arcSync"];
        let already_applied = match step {
            NativeDisplayApplyField::ArcSyncRange(request) => {
                current["profile"].as_str() == Some("custom")
                    && arc_sync_range_request(&current["currentRange"]) == Some(request)
            }
            NativeDisplayApplyField::ArcSyncProfile(profile) => current["profile"].as_str() == Some(profile.name()),
            _ => unreachable!("saved Arc Sync intent has only range and profile forms"),
        };
        if already_applied { continue; }
        let plan = NativeDisplayApplyPlan { steps: vec![step] };
        match apply_display_plan_under_lock(&guard, device_id, device_key, &display_key, plan, None) {
            Ok(Some(result)) if result["perControl"][control]["ok"].as_bool() == Some(true) => {}
            Ok(_) => eprintln!("[display] saved Arc Sync setting could not be restored"),
            Err(error) => eprintln!("[display] saved Arc Sync setting could not be restored: {error}"),
        }
    }
    Ok(())
}

/// Electron's `perControl` entries for one Scaling Mode step: the ordinary
/// selection, the IGS method mirror when the alias travelled, and the coupled
/// Retro record (restored / not restored) when that transaction had to put the
/// previous state back.
fn display_scaling_step_per_control(
    applied: &super::display_scaling_apply::DisplayScalingModeApplyResult,
    requested: &super::display_scaling_apply::DisplayScalingPatch,
) -> Map<String, Value> {
    // Electron keys the ordinary entry under `scalingMode`; the shared helper
    // returns that entry's own fields, so wrap it here - the mirror below reads
    // it back and must never index a missing key.
    let mut controls = per_control_single(
        "scalingMode",
        Value::Object(display_scaling_mode_per_control(applied, requested.scaling_type)),
    );
    if requested.has_method_alias {
        // The IGS method alias mirrors the same native transaction.
        let mut alias = controls["scalingMode"].clone();
        if let Value::Object(alias) = &mut alias {
            alias.insert("internal".into(), Value::Bool(true));
        }
        controls.insert("displayScalingMethod".into(), alias);
    }
    if let Some(restore) = retro_restore_per_control(applied.retro_restore_ok) {
        controls.insert("scalingMethod".into(), restore);
    }
    controls
}

fn per_control_single(control: &str, value: Value) -> Map<String, Value> {
    let mut map = Map::new();
    map.insert(control.to_owned(), value);
    map
}

/// The sole verdict gate for one Scaling Mode step.
///
/// A composed request hands the coupled-Retro verdict to the plan so the later
/// standalone Retro step is suppressed. A single-control request has no such
/// step and keeps the shipped envelope verbatim, including Electron's own
/// message for the same record.
///
/// Extracted so tests can exercise the gate production actually runs instead of
/// hand-building the variant, which would keep passing if this choice changed.
fn scaling_mode_step_outcome(
    applied: &super::display_scaling_apply::DisplayScalingModeApplyResult,
    per_control: Map<String, Value>,
    single_control: bool,
) -> DisplayStepOutcome {
    if !single_control {
        if let Some(restored) = applied.retro_restore_ok {
            return DisplayStepOutcome::AppliedWithRetroRestore {
                ok: applied.scaling.ok,
                per_control,
                restored,
            };
        }
    }
    DisplayStepOutcome::Applied { ok: applied.scaling.ok, per_control }
}

/// Electron's `perControl` entries for one color patch: exactly one entry per
/// requested control, in Electron's group order, and none for the
/// acknowledgement flag. An accepted entry carries the honest
/// `readback-unavailable` verification and Electron's message verbatim; absent
/// optionals are omitted, never `null`.
fn display_color_per_control(
    requested: &super::display_color_apply::DisplayColorPatch,
    applied: &super::display_color_apply::DisplayColorApplyOutcome,
) -> Map<String, Value> {
    let mut per_control = Map::new();
    for (group, result) in &applied.groups {
        for key in group.fields() {
            if requested.value(key).is_none() { continue; }
            let entry = if result.ok {
                json!({
                    "ok": true,
                    "verification": "readback-unavailable",
                    "message": super::display_color_apply::DISPLAY_COLOR_SENT_MESSAGE,
                })
            } else {
                let mut entry = Map::new();
                entry.insert("ok".into(), Value::Bool(false));
                if let Some(code) = result.error_code { entry.insert("errorCode".into(), json!(code)); }
                if let Some(message) = &result.message { entry.insert("message".into(), json!(message)); }
                Value::Object(entry)
            };
            per_control.insert(key.name().to_owned(), entry);
        }
    }
    per_control
}

/// Electron's `perControl.scalingMode` shape. Absent optional fields are
/// omitted rather than emitted as `null`: the renderer reads `errorCode ?? ...`
/// and treats the presence of the entry itself as read-back proof.
fn display_scaling_mode_per_control(
    applied: &super::display_scaling_apply::DisplayScalingModeApplyResult,
    scaling_type: u32,
) -> Map<String, Value> {
    let scaling = &applied.scaling;
    let mut result = Map::new();
    result.insert("ok".into(), Value::Bool(scaling.ok));
    if !scaling.ok {
        if let Some(code) = scaling.error_code { result.insert("errorCode".into(), json!(code)); }
    }
    // Electron reports the verification source of the accepted tuple. A
    // refusal never reached a driver read-back, so it stays `unverified`.
    let verification = if scaling.active_read_back_equal {
        "native-active"
    } else if scaling.deferred {
        "native-preference"
    } else {
        "unverified"
    };
    result.insert("readBackEqual".into(), json!(scaling.read_back_equal));
    result.insert("activeReadBackEqual".into(), json!(scaling.active_read_back_equal));
    result.insert("preferredReadBackEqual".into(), json!(scaling.preferred_read_back_equal));
    result.insert("deferred".into(), json!(scaling.deferred));
    result.insert("verification".into(), json!(verification));
    let message = match &scaling.message {
        Some(message) => Some(message.clone()),
        None if scaling.ok && scaling.deferred => Some(DEFERRED_GPU_SCALING_MESSAGE.to_owned()),
        None if scaling.ok && scaling_type == 1 => Some(IDENTITY_SCALING_MESSAGE.to_owned()),
        None => None,
    };
    if let Some(message) = message { result.insert("message".into(), json!(message)); }
    if scaling.ok {
        result.insert("selectionSaved".into(), json!(scaling.selection_saved));
        result.insert("warning".into(), json!(DISPLAY_SCALING_FLASH_WARNING));
    }
    // Electron reports a silent no-op only after the *requested* SET returned
    // success. A first-time Custom entry that failed its neutral initialization
    // never issued that SET, so it must not claim a silent no-op either.
    if let Some(requested_set) = scaling.requested_set {
        result.insert("silentNoop".into(), json!(!scaling.ok && requested_set));
    }
    if scaling.rollback_attempted {
        result.insert("nativePreferenceRestoreOk".into(), json!(scaling.rollback_verified));
    }
    if let Some(restore_ok) = applied.retro_restore_ok {
        result.insert("retroRestoreOk".into(), json!(restore_ok));
        if !restore_ok {
            // Electron appends this to the ordinary failure message so the one
            // visible Scaling Mode entry explains the residual Retro state.
            let base = result.get("message").and_then(Value::as_str)
                .unwrap_or("Scaling failed.").to_owned();
            result.insert("message".into(), json!(format!("{base} {RETRO_SCALING_RESTORE_FAILED_MESSAGE}")));
        }
    }
    result
}

/// Electron replaces the coupled Retro entry with this internal record after it
/// restores (or fails to restore) the previous Retro state.
fn retro_restore_per_control(retro_restore_ok: Option<bool>) -> Option<Value> {
    retro_restore_ok.map(|ok| json!({
        "ok": false,
        "errorCode": "io-failed",
        "message": if ok { RETRO_SCALING_RESTORED_MESSAGE } else { RETRO_SCALING_RESTORE_FAILED_MESSAGE },
        "readBackEqual": false,
        "internal": true,
    }))
}

/// `graphics:apply(deviceId, settings, expectedDeviceKey?)`.
fn graphics_apply_args(channel: &str, args: &Value) -> Result<(u64, Value, Option<String>), String> {
    let items = args_array(channel, args)?;
    if items.len() < 2 || items.len() > 3 {
        return Err(format!("{channel} expects a device id, a settings payload and an optional expected device key"));
    }
    let device_id = graphics_device_id(items.first())?;
    let payload = items[1].clone().into_json()?;
    let key = graphics_expected_key(items.get(2))?;
    Ok((device_id, payload, key))
}

/// `graphicsExpectedDeviceKey`'s supplied-key branch: an absent argument is
/// `undefined` (resolve from settings); anything else must be a non-empty
/// string - including an explicit `null`, which Electron rejects.
fn graphics_expected_key(value: Option<&WireValue>) -> Result<Option<String>, String> {
    match value {
        None | Some(WireValue::Undefined) => Ok(None),
        Some(WireValue::String(text)) if !text.trim().is_empty() => Ok(Some(text.clone())),
        _ => Err("invalid GPU target: expected device key must be a nonempty string".into()),
    }
}

fn device_id_arg(channel: &str, args: &Value) -> Result<u64, String> {
    let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
    if args.len() != 1 { return Err(format!("{channel} expects one device id")); }
    let WireValue::Number(device_id) = &args[0] else { return Err(format!("{channel}: invalid device id")); };
    device_id.as_u64().ok_or_else(|| format!("{channel}: invalid device id"))
}

fn waiver_accept_args(args: &Value, build_kind: BuildKind) -> Result<(u64, Option<super::gpu_apply_identity::ApplyIdentity>), String> {
    let value = decode(args)?.into_json()?;
    let items = value.as_array().ok_or("waiver-accept expects an argument array")?;
    if items.is_empty() || items.len() > 2 { return Err("waiver-accept expects a device id and physical target".into()); }
    let device_id = items[0].as_u64().ok_or("waiver-accept: invalid device id")?;
    let Some(target) = items.get(1).filter(|value| !value.is_null()) else {
        return if matches!(build_kind, BuildKind::Dev) { Ok((device_id, None)) }
            else { Err("waiver-accept: selected GPU identity is unavailable; refresh and try again".into()) };
    };
    let physical = target.get("physicalTarget").ok_or("waiver-accept: physical target is missing")?;
    let identity = super::gpu_apply_identity::identity_from_row(physical)?;
    if target.get("deviceKey").and_then(Value::as_str) != Some(identity.device_key.as_str()) {
        return Err("waiver-accept: GPU key does not match physical target".into());
    }
    Ok((device_id, Some(identity)))
}

fn args_array(channel: &str, args: &Value) -> Result<Vec<WireValue>, String> {
    let WireValue::Array(items) = decode(args)? else { return Err(format!("{channel} expects an argument array")); };
    Ok(items)
}

fn single_json_payload(channel: &str, args: &Value) -> Result<Value, String> {
    let WireValue::Array(items) = decode(args)? else { return Err(format!("{channel} expects an argument array")); };
    if items.len() != 1 { return Err(format!("{channel} expects one argument")); }
    items.into_iter().next().unwrap().into_json()
}

fn optional_device_id(value: &WireValue, channel: &str) -> Result<Option<u64>, String> {
    match value {
        WireValue::Undefined | WireValue::Null => Ok(None),
        WireValue::Number(number) => number.as_u64().map(Some)
            .ok_or_else(|| format!("{channel}: invalid device id")),
        _ => Err(format!("{channel}: invalid device id")),
    }
}

fn optional_string(value: &WireValue, channel: &str) -> Result<Option<String>, String> {
    match value {
        WireValue::Undefined | WireValue::Null => Ok(None),
        WireValue::String(text) if !text.is_empty() => Ok(Some(text.clone())),
        _ => Err(format!("{channel}: expected a non-empty string or null")),
    }
}

fn resolve_device_key(device_id: u64, channel: &str) -> Result<Option<String>, String> {
    let devices = super::gpu_devices::list_devices_merged();
    let device = devices.as_array().and_then(|devices| devices.get(device_id as usize))
        .ok_or_else(|| format!("{channel}: unknown device id"))?;
    if device["synthetic"].as_bool() == Some(true) || device["backendKind"].as_str() == Some("os") {
        return Ok(None);
    }
    device["deviceKey"].as_str().map(|key| Some(key.to_owned()))
        .ok_or_else(|| format!("{channel}: device has no stable identity"))
}

fn valid_oc_mode(value: Option<&str>) -> Option<&str> {
    value.filter(|mode| matches!(*mode, "stock" | "advanced"))
}

fn amd_compute_units_of(name: &str) -> Option<u32> {
    let model = name.split_whitespace().collect::<Vec<_>>().join(" ").to_ascii_lowercase();
    if model.contains("rx 9070 xt") { Some(64) }
    else if model.contains("rx 9070 gre") { Some(48) }
    else if model.contains("rx 9070") { Some(56) }
    else if model.contains("rx 9060 xt") { Some(32) }
    else if model.contains("rx 9060") { Some(28) }
    else if model.contains("rx 9050") { Some(16) }
    else { None }
}

fn oc_mode_get(settings: &Value, device_key: Option<&str>) -> Value {
    let scalar = valid_oc_mode(settings["ocMode"].as_str()).unwrap_or("stock");
    match device_key {
        Some(device_key) => {
            let saved = valid_oc_mode(settings["ocModes"].get(device_key).and_then(Value::as_str));
            json!({"ocMode": saved.unwrap_or(scalar), "deviceKey": device_key})
        }
        None => json!({"ocMode": scalar}),
    }
}

fn oc_mode_set(settings: &mut Value, mode: &str, device_key: Option<&str>) -> Value {
    if let Some(device_key) = device_key {
        let Some(settings) = settings.as_object_mut() else { return json!({"ocMode": mode, "deviceKey": device_key}); };
        let modes = settings.entry("ocModes").or_insert_with(|| json!({}));
        if !modes.is_object() { *modes = json!({}); }
        if let Some(modes) = modes.as_object_mut() { modes.insert(device_key.to_owned(), json!(mode)); }
        json!({"ocMode": mode, "deviceKey": device_key})
    } else {
        if let Some(settings) = settings.as_object_mut() { settings.insert("ocMode".into(), json!(mode)); }
        json!({"ocMode": mode})
    }
}

// Temperature applies remain brokered until shared cache reads, result
// publication, and broker/native apply serialization are proven as one
// fail-closed contract.
const NATIVE_SCALAR_KEYS: [&str; 4] = [
    "powerLimitW", "gpuVoltOffsetV", "gpuFreqOffsetMhz", "vramFreqOffsetGts",
];

struct NativeApplyPayload {
    device_id: u64,
    settings: Value,
    expected_identity: super::gpu_apply_identity::ApplyIdentity,
    physical_target: Value,
}

#[derive(Clone)]
pub struct NativeTemperatureApplyRequest {
    pub device_id: u64,
    pub settings: Value,
    pub device_key: String,
    pub physical_target: Value,
}

/// Accept only native-subset Tauri applies with explicit renderer target
/// proof. Boot and tray applies, VF intent payloads and every unrecognized
/// apply policy keep their compatibility-broker route after their explicit
/// identity proof has been validated.
fn native_apply_payload(args: &Value) -> Result<Option<NativeApplyPayload>, String> {
    native_apply_payload_of_shape(args, NativeApplyShape::Direct)
}

/// True only for a proven payload that the elevated native apply path can
/// claim. The Tauri host uses this before entering its shared process FIFO;
/// temperature leases enter through the compatibility transaction adapter
/// instead, so a temperature-bearing profile apply must not take this path
/// (its lease transaction owns the shared coordinator while the body runs).
pub fn native_apply_transaction_candidate(args: &Value) -> bool {
    if native_apply_payload(args).ok().flatten().is_some() { return true; }
    native_profile_apply_candidate(args).ok().flatten().is_some_and(|payload| {
        !payload.settings.as_object().is_some_and(|map| {
            map.get("tempLimitC").and_then(Value::as_f64).is_some_and(f64::is_finite)
        })
    })
}

/// Which native apply payload shape a caller may claim.
#[derive(Clone, Copy, PartialEq)]
enum NativeApplyShape {
    /// Direct interactive applies: `opts` is exactly `{expectedTarget}`.
    Direct,
    /// Strict single-temperature applies that already hold a broker lease.
    LeasedTemperature,
    /// Profile applies (`opts` is exactly `{profileApply: true, expectedTarget}`).
    Profile,
}

fn native_apply_payload_with_temperature(args: &Value, allow_temperature: bool) -> Result<Option<NativeApplyPayload>, String> {
    native_apply_payload_of_shape(args, if allow_temperature {
        NativeApplyShape::LeasedTemperature
    } else {
        NativeApplyShape::Direct
    })
}

/// A proven profile apply payload (the Profiles-page Apply button shape).
/// Profiles carrying a temperature are returned too; their callers must hold
/// a broker temperature lease before the native body may run.
pub fn native_profile_apply_candidate(args: &Value) -> Result<Option<NativeApplyPayload>, String> {
    native_apply_payload_of_shape(args, NativeApplyShape::Profile)
}

fn native_apply_payload_of_shape(args: &Value, shape: NativeApplyShape) -> Result<Option<NativeApplyPayload>, String> {
    let decoded = decode(args).map_err(|_| "apply-settings requires a stable GPU key and physical proof".to_owned())?;
    let WireValue::Array(items) = decoded else {
        return Err("apply-settings requires a stable GPU key and physical proof".into());
    };
    // An absent `opts` (omitted entirely, or `undefined`/a non-object in the
    // tagged wire form) carries no `expectedTarget`, and Electron's guard only
    // runs `if (opts?.expectedTarget !== undefined)`, so nothing is checked and
    // the broker applies after its own target handling. Match that — delegate
    // to the broker unchanged.
    //
    // A `null` *proof* (`expectedTarget: null`) is NOT the same case:
    // `null !== undefined`, so Electron's guard DOES run and throws. It is
    // delegated anyway because this host has no proof to add, and the broker
    // then produces the exact rejection itself. A `null` *opts* object is the
    // ordinary absent case — `opts?.expectedTarget` short-circuits to
    // `undefined`, so Electron checks nothing and applies.
    //
    // Only a *present* but invalid proof is a genuine malformed-payload
    // rejection made natively.
    let Some(options) = items.get(2) else {
        return Ok(None);
    };
    if matches!(options, WireValue::Undefined | WireValue::Null) {
        return Ok(None);
    }
    let WireValue::Object(options) = options else {
        return Ok(None);
    };
    let Some((_, proof_value)) = options.iter().find(|(key, _)| key == "expectedTarget") else {
        return Ok(None);
    };
    if matches!(proof_value, WireValue::Undefined | WireValue::Null) {
        return Ok(None);
    }
    let expected = proof_value.clone().into_json()
        .map_err(|_| "apply-settings: expected target requires a stable GPU key and physical proof".to_owned())?;
    let device_key = expected.get("deviceKey").and_then(Value::as_str)
        .ok_or("apply-settings: expected target requires a stable GPU key and physical proof")?.to_owned();
    let proof = expected.get("physicalTarget").and_then(Value::as_object)
        .ok_or("apply-settings: expected target requires a stable GPU key and physical proof")?;
    if proof.get("deviceKey").and_then(Value::as_str) != Some(device_key.as_str()) {
        return Err("apply-settings: expected target requires a stable GPU key and physical proof".into());
    }
    let identity = super::gpu_apply_identity::identity_from_row(&Value::Object(proof.clone()))?;
    if identity.device_key != device_key {
        return Err("apply-settings: expected target requires a stable GPU key and physical proof".into());
    }

    match shape {
        NativeApplyShape::Direct | NativeApplyShape::LeasedTemperature => {
            // Any future apply policy may include broker-specific preparation
            // or partial-apply behavior. Keep it brokered after proof.
            if options.len() != 1 { return Ok(None); }
        }
        NativeApplyShape::Profile => {
            // A profile apply is exactly {profileApply: true, expectedTarget};
            // every other option combination keeps its broker route.
            if options.len() != 2
                || !options.iter().any(|(key, value)| key == "profileApply" && matches!(value, WireValue::Bool(true)))
                || options.iter().any(|(key, _)| key != "profileApply" && key != "expectedTarget") {
                return Ok(None);
            }
        }
    }

    if items.len() < 2 || items.len() > 3 { return Ok(None); }
    let mut items = items.into_iter();
    let Some(WireValue::Number(device_id)) = items.next() else { return Ok(None); };
    let Some(device_id) = device_id.as_u64() else { return Ok(None); };
    let Some(WireValue::Object(entries)) = items.next() else { return Ok(None); };
    let mut settings = Map::new();
    let has_temperature = entries.iter().any(|(key, _)| key == "tempLimitC");
    if shape == NativeApplyShape::Direct
        && entries.iter().any(|(key, _)| key == "vfCurveBaseline" || key == "vfCurveResetToDefault")
        && (entries.len() != 2 || !entries.iter().any(|(key, _)| key == "vfCurve")) {
        return Ok(None);
    }
    let temperature_allowed = shape != NativeApplyShape::Direct;
    if has_temperature {
        match shape {
            NativeApplyShape::Direct => return Ok(None),
            NativeApplyShape::LeasedTemperature if entries.len() != 1 => return Ok(None),
            _ => {}
        }
    }
    // An empty profile payload has no proven Electron counterpart here;
    // delegate it rather than guess its envelope.
    if matches!(shape, NativeApplyShape::Profile) && entries.is_empty() { return Ok(None); }
    for (key, value) in entries {
        let Ok(value) = value.into_json() else { return Ok(None); };
        if key == "vfCurve" && shape == NativeApplyShape::Profile {
            if !value.is_array() { return Ok(None); }
        } else if key == "vfCurve" || key == "fanCurve" {
            // Electron owns a large profile-VF policy (stock classification,
            // legacy-scalar repair, reference validation). The native profile
            // preflight implements the saved stock-reference cases; baseline
            // metadata and other non-native VF policies remain broker-owned.
            if !value.is_array() { return Ok(None); }
        } else if key == "vfCurveStockReference" && shape == NativeApplyShape::Profile {
            if !value.is_array() { return Ok(None); }
        } else if key == "vfCurveBaseline" && matches!(shape, NativeApplyShape::Profile | NativeApplyShape::Direct) {
            if !value.is_array() { return Ok(None); }
        } else if key == "vfCurveResetToDefault" && matches!(shape, NativeApplyShape::Profile | NativeApplyShape::Direct) {
            if value != Value::Bool(true) { return Ok(None); }
        } else if key == "fanMode" {
            if !value.as_str().is_some_and(|mode| ["auto", "curve", "fixed"].contains(&mode)) { return Ok(None); }
        } else if key == "fixedFanPct" {
            if !value.is_null() && !value.is_number() { return Ok(None); }
        } else if key == "gpuLock" {
            if !value.is_object()
                || !value.get("voltageV").and_then(Value::as_f64).is_some()
                || !value.get("freqMhz").and_then(Value::as_f64).is_some() { return Ok(None); }
        } else if key == "vfCurveProfileStock" && shape == NativeApplyShape::Profile {
            if value != Value::Bool(true) { return Ok(None); }
        } else if NATIVE_SCALAR_KEYS.contains(&key.as_str()) || (temperature_allowed && key == "tempLimitC") {
            if !value.is_null() && !value.is_number() { return Ok(None); }
        } else {
            return Ok(None);
        }
        settings.insert(key, value);
    }
    if settings.contains_key("vfCurveResetToDefault") && !settings.contains_key("vfCurve") {
        return Ok(None);
    }
    if settings.get("vfCurveProfileStock") == Some(&Value::Bool(true)) {
        if ["vfCurve", "vfCurveResetToDefault", "vfCurveBaseline", "vfCurveStockReference"]
            .iter().any(|key| settings.contains_key(*key))
            || ["gpuFreqOffsetMhz", "gpuVoltOffsetV"].iter().any(|key| {
                settings.get(*key).and_then(Value::as_f64).is_some_and(|value| value.abs() > 0.0005)
            }) {
            return Ok(None);
        }
    }
    if matches!(shape, NativeApplyShape::Profile | NativeApplyShape::Direct)
        && (settings.contains_key("vfCurveStockReference") || settings.contains_key("vfCurveBaseline")) {
        let Some(curve) = settings.get("vfCurve").and_then(Value::as_array) else { return Ok(None); };
        let reference = settings.get("vfCurveStockReference").or_else(|| settings.get("vfCurveBaseline"))
            .and_then(Value::as_array);
        let Some(reference) = reference else { return Ok(None); };
        if curve.len() < 2 || reference.len() != curve.len() || curve.len() > 32
            || !curve.iter().chain(reference).all(|point| {
                point.get("voltageV").and_then(Value::as_f64).is_some_and(f64::is_finite)
                    && point.get("freqMhz").and_then(Value::as_f64).is_some_and(f64::is_finite)
            })
            || settings.contains_key("vfCurveResetToDefault") {
            return Ok(None);
        }
    }
    Ok(Some(NativeApplyPayload {
        device_id,
        settings: Value::Object(settings),
        expected_identity: identity,
        physical_target: expected.get("physicalTarget").cloned().unwrap_or(Value::Null),
    }))
}

fn native_direct_apply_decline_reason(args: &Value) -> Option<&'static str> {
    let value = decode(args).ok()?.into_json().ok()?;
    let items = value.as_array()?;
    let settings = items.get(1)?.as_object()?;
    if items.get(2).and_then(Value::as_object)
        .and_then(|options| options.get("profileApply")).and_then(Value::as_bool) == Some(true) { return None; }
    if settings.contains_key("tempLimitC") && settings.len() > 1 {
        return Some("Apply the temperature limit separately from other tuning controls; no settings were written.");
    }
    if (settings.contains_key("vfCurveBaseline") || settings.contains_key("vfCurveResetToDefault"))
        && settings.len() > 2 {
        return Some("Apply the VF curve separately from other tuning controls; no settings were written.");
    }
    None
}

/// Resolve the renderer's STOCK VF profile marker to a freshly read and
/// validated driver STOCK curve. This mirrors Electron's profile expansion,
/// but keeps the native-only path fail-closed before any setter.
fn resolve_profile_vf_settings(
    settings: &Value,
    caps: &Value,
    path: &std::path::Path,
    identity: &super::gpu_apply_identity::ApplyIdentity,
) -> Result<(Value, bool), Value> {
    if !super::vf_apply::is_battlemage(caps) {
        return Err(profile_vf_failure(settings, "unsupported", "This profile requests a Battlemage VF curve, which this GPU does not support.", Value::Null));
    }
    let Some(range_value) = caps.get("vfCurveRange") else {
        return Err(profile_vf_failure(settings, "unsupported", "The driver STOCK VF curve could not be verified. No profile settings were written.", Value::Null));
    };
    let Ok(range) = serde_json::from_value::<super::vf_curve::VfCurveRange>(range_value.clone()) else {
        return Err(profile_vf_failure(settings, "readback-unverified", "The driver STOCK VF curve could not be verified. No profile settings were written.", Value::Null));
    };
    let Ok(state) = super::gpu_capabilities::current_settings_for_identity(path, identity) else {
        return Err(profile_vf_failure(settings, "readback-unverified", "The driver STOCK VF curve could not be read. No profile settings were written.", Value::Null));
    };
    let stock = state.get("vfCurveDefault").and_then(Value::as_array)
        .and_then(|points| serde_json::from_value::<Vec<super::vf_curve::VfCurvePoint>>(Value::Array(points.clone())).ok());
    if !super::vf_curve::is_valid_native_vf_curve(stock.as_deref(), &range) {
        return Err(profile_vf_failure(settings, "readback-unverified", "The driver STOCK VF curve could not be read and verified. No profile settings were written.", state));
    }
    let mut resolved = settings.clone();
    let Some(map) = resolved.as_object_mut() else {
        return Err(profile_vf_failure(settings, "invalid-argument", "The saved profile settings are invalid. No profile settings were written.", state));
    };
    if map.get("vfCurveProfileStock") == Some(&Value::Bool(true)) {
        map.remove("vfCurveProfileStock");
        map.insert("vfCurve".into(), serde_json::to_value(stock.unwrap()).unwrap_or(Value::Null));
        map.insert("vfCurveResetToDefault".into(), Value::Bool(true));
        return Ok((resolved, true));
    }
    if map.contains_key("vfCurveBaseline") {
        return Err(profile_vf_failure(settings, "unsupported",
            "Baseline-referenced VF profiles are not supported by the native apply path. No settings were written.", state));
    }
    let requested = map.get("vfCurve").and_then(Value::as_array)
        .and_then(|points| serde_json::from_value::<Vec<super::vf_curve::VfCurvePoint>>(Value::Array(points.clone())).ok());
    if !super::vf_curve::is_valid_native_vf_curve(requested.as_deref(), &range) {
        return Err(profile_vf_failure(settings, "out-of-range", "The saved VF curve is invalid for this GPU. No profile settings were written.", state));
    }
    let reference = map.get("vfCurveStockReference").and_then(Value::as_array)
        .and_then(|points| serde_json::from_value::<Vec<super::vf_curve::VfCurvePoint>>(Value::Array(points.clone())).ok());
    if map.contains_key("vfCurveStockReference") {
        if !super::vf_curve::is_valid_native_vf_curve(reference.as_deref(), &range)
            || !super::vf_curve::same_vf_curve(reference.as_deref(), stock.as_deref(), 0.0, 0.0) {
            return Err(profile_vf_failure(settings, "readback-unverified", "The saved STOCK reference no longer matches this device. No curve write was sent.", state));
        }
    }
    let explicit_stock_curve = super::vf_curve::same_vf_curve(requested.as_deref(), stock.as_deref(), 0.0, 0.0);
    let frequency_offset = map.get("gpuFreqOffsetMhz").and_then(Value::as_f64);
    let voltage_offset = map.get("gpuVoltOffsetV").and_then(Value::as_f64);
    let has_nonzero_core_offset = frequency_offset.is_some_and(|value| value.abs() > 0.0005)
        || voltage_offset.is_some_and(|value| value.abs() > 0.0005);
    let legacy_scalar_curve = reference.as_ref().is_some_and(|reference| {
        let offset = frequency_offset.unwrap_or(0.0);
        requested.as_ref().is_some_and(|requested| requested.len() == reference.len()
            && requested.iter().zip(reference).all(|(live, stock)| {
                live.voltage_v == stock.voltage_v && live.freq_mhz == stock.freq_mhz + offset
            }))
    });
    if has_nonzero_core_offset {
        if legacy_scalar_curve {
            map.remove("vfCurve");
            map.remove("vfCurveStockReference");
            map.remove("vfCurveResetToDefault");
            return Ok((resolved, false));
        }
        let message = if explicit_stock_curve {
            "The stock VF reset cannot be safely combined with nonzero core offsets in one profile. No settings were written."
        } else {
            "The profile combines nonzero core offsets with a custom VF curve. No settings were written."
        };
        return Err(profile_vf_failure(settings, "dependency-failed", message, state));
    }
    // Profile reset intent is one-shot UI metadata. The curve itself has
    // already been validated and the native VF writer handles its reset path.
    map.remove("vfCurveStockReference");
    map.remove("vfCurveResetToDefault");
    Ok((resolved, explicit_stock_curve))
}

fn profile_vf_failure(settings: &Value, code: &str, message: &str, state: Value) -> Value {
    let mut per_control = serde_json::Map::new();
    per_control.insert("vfCurve".into(), json!({"ok":false,"errorCode":code,"message":message}));
    if settings.get("tempLimitC").and_then(Value::as_f64).is_some_and(f64::is_finite) {
        per_control.insert("tempLimitC".into(), json!({
            "ok": false, "errorCode": "dependency-failed",
            "message": "The temperature control was not applied because the profile VF curve could not be verified.",
        }));
    }
    json!({"result":{"ok":false,"perControl":per_control},"state":state})
}

fn stock_vf_readback_matches(settings: &Value, result: &Value) -> bool {
    let points = |value: Option<&Value>| value.and_then(Value::as_array)
        .and_then(|points| serde_json::from_value::<Vec<super::vf_curve::VfCurvePoint>>(Value::Array(points.clone())).ok());
    let requested = points(settings.get("vfCurve"));
    let read_back = points(result.get("perControl").and_then(|controls| controls.get("vfCurve"))
        .and_then(|control| control.get("readBackCurve")));
    super::vf_curve::same_vf_curve(requested.as_deref(), read_back.as_deref(), 0.0, 0.0)
}

pub fn native_temperature_apply_candidate(args: &Value) -> Result<Option<NativeTemperatureApplyRequest>, String> {
    let Some(payload) = native_apply_payload_with_temperature(args, true)? else { return Ok(None); };
    if !payload.settings.as_object().is_some_and(|map| map.len() == 1) || !payload.settings.get("tempLimitC").is_some_and(|value| value.as_f64().is_some_and(f64::is_finite)) {
        return Ok(None);
    }
    Ok(Some(NativeTemperatureApplyRequest {
        device_id: payload.device_id,
        settings: payload.settings,
        device_key: payload.expected_identity.device_key,
        physical_target: payload.physical_target,
    }))
}

/// A proven profile apply that carries a finite temperature. Its caller must
/// hold a broker temperature lease (the lease begin holds the shared apply
/// FIFO), so a temperature-bearing profile apply never enters the plain
/// native FIFO branch.
#[derive(Clone)]
pub struct NativeProfileApplyRequest {
    pub device_id: u64,
    pub settings: Value,
    pub device_key: String,
    pub physical_target: Value,
    pub requested_temperature: Option<f64>,
}

pub fn native_profile_apply_request(args: &Value) -> Result<Option<NativeProfileApplyRequest>, String> {
    let Some(payload) = native_profile_apply_candidate(args)? else { return Ok(None); };
    let requested_temperature = payload.settings.get("tempLimitC")
        .and_then(Value::as_f64).filter(|value| value.is_finite());
    Ok(Some(NativeProfileApplyRequest {
        device_id: payload.device_id,
        settings: payload.settings,
        device_key: payload.expected_identity.device_key,
        physical_target: payload.physical_target,
        requested_temperature,
    }))
}

struct ValidatedTemperatureLeaseSnapshot {
    epoch: String,
    transaction_sequence: u64,
    cache_generation: u64,
    target: Value,
    range: Value,
    learned_ceiling: Option<f64>,
    oc_mode: Option<String>,
}

fn wire_field<'a>(value: &'a WireValue, key: &str) -> Option<&'a WireValue> {
    match value {
        WireValue::Object(entries) => entries.iter().find_map(|(name, child)| (name == key).then_some(child)),
        _ => None,
    }
}

fn wire_finite_number(value: &WireValue) -> Option<f64> {
    match value { WireValue::Number(value) => value.as_f64().filter(|number| number.is_finite()), _ => None }
}

fn wire_u64(value: &WireValue) -> Option<u64> {
    match value { WireValue::Number(value) => value.as_u64(), _ => None }
}

fn wire_json_without_undefined(value: &WireValue) -> Result<Value, String> {
    match value {
        WireValue::Object(entries) => {
            let mut object = Map::new();
            for (key, child) in entries {
                if matches!(child, WireValue::Undefined) { continue; }
                object.insert(key.clone(), wire_json_without_undefined(child)?);
            }
            Ok(Value::Object(object))
        }
        WireValue::Array(values) => values.iter().map(wire_json_without_undefined).collect::<Result<Vec<_>, _>>().map(Value::Array),
        _ => value.clone().into_json(),
    }
}

fn temperature_range_values(range: &Value) -> Option<(f64, f64, f64)> {
    if !matches!(range.get("units").and_then(Value::as_str), Some("C" | "%")) { return None; }
    let min = range.get("min").and_then(Value::as_f64)?;
    let max = range.get("max").and_then(Value::as_f64)?;
    let step = range.get("step").and_then(Value::as_f64)?;
    if !min.is_finite() || !max.is_finite() || !step.is_finite() || max < min || step <= 0.0 { return None; }
    Some((min, max, step))
}

fn merge_temperature_refusal_cache(caps: &mut Value, cache: &Value, device_key: &str) {
    let status = cache.get("status").and_then(Value::as_str).unwrap_or("unavailable");
    let generation = cache.get("generation").and_then(Value::as_u64).unwrap_or(0);
    caps["refusalCacheGeneration"] = json!(generation);
    caps["refusalCacheIdentity"] = json!({
        "status": if status == "available" { "resolved" } else { "unavailable" },
        "key": device_key,
        "reason": cache.get("reason").cloned().unwrap_or(Value::Null),
    });
    if status != "available" { return; }
    let Some(range) = caps.get("ranges").and_then(|ranges| ranges.get("tempLimitC")).cloned() else { return; };
    if !matches!(range.get("units").and_then(Value::as_str), Some("C" | "%")) { return; }
    let range_units = range.get("units").and_then(Value::as_str);
    let cached_units = cache.get("units").and_then(|units| units.get("tempLimitC")).and_then(Value::as_str);
    if cached_units.is_some_and(|units| Some(units) != range_units) { return; }
    let Some(ceiling) = cache.get("ceilings").and_then(|ceilings| ceilings.get("tempLimitC")).and_then(Value::as_f64) else { return; };
    if cached_units != range_units { return; }
    if !super::apply_gates::valid_learned_temp_ceiling(ceiling, &range) { return; }
    let Some(ranges) = caps.get_mut("ranges").and_then(Value::as_object_mut) else { return; };
    let Some(temp_range) = ranges.get_mut("tempLimitC").and_then(Value::as_object_mut) else { return; };
    let Some(max) = temp_range.get("max").and_then(Value::as_f64) else { return; };
    if ceiling < max {
        temp_range.insert("max".into(), json!(ceiling));
        if temp_range.get("default").and_then(Value::as_f64).is_some_and(|default| default > ceiling) {
            temp_range.insert("default".into(), json!(ceiling));
        }
    }
    if !caps.get("learnedCeilings").is_some_and(Value::is_object) { caps["learnedCeilings"] = json!({}); }
    caps["learnedCeilings"]["tempLimitC"] = json!(ceiling);
}

fn validate_temperature_lease_snapshot(
    lease: &WireValue,
    device_id: u64,
    requested_settings: &Value,
    expected_identity: &super::gpu_apply_identity::ApplyIdentity,
) -> Result<ValidatedTemperatureLeaseSnapshot, String> {
    if wire_string(Some(wire_field(lease, "type").ok_or("Native temperature lease type is missing")?))
        != Some("temperature-refusal-cache:begin")
        || wire_u64(wire_field(lease, "schemaVersion").ok_or("Native temperature lease schema is missing")?) != Some(1) {
        return Err("Native temperature lease schema is invalid".into());
    }
    let epoch = wire_string(Some(wire_field(lease, "epoch").ok_or("Native temperature lease epoch is missing")?))
        .filter(|value| value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        .ok_or("Native temperature lease epoch is invalid")?.to_owned();
    let transaction_sequence = wire_u64(wire_field(lease, "transactionSequence").ok_or("Native temperature lease sequence is missing")?)
        .filter(|sequence| *sequence > 0).ok_or("Native temperature lease sequence is invalid")?;
    let cache_generation = wire_u64(wire_field(lease, "cacheGeneration").ok_or("Native temperature cache generation is missing")?)
        .ok_or("Native temperature cache generation is invalid")?;
    let target_wire = wire_field(lease, "target").ok_or("Native temperature lease target is missing")?;
    let target = wire_json_without_undefined(target_wire)?;
    let actual_identity = super::gpu_apply_identity::identity_from_row(&target)?;
    super::gpu_apply_identity::ensure_same_target(expected_identity, &actual_identity)?;
    if wire_u64(wire_field(target_wire, "electronOrdinal").ok_or("Native temperature lease ordinal is missing")?) != Some(device_id) {
        return Err("Native temperature lease ordinal changed".into());
    }

    let requested = requested_settings.get("tempLimitC").and_then(Value::as_f64)
        .filter(|value| value.is_finite()).ok_or("Temperature request is invalid")?;
    let requested_wire = wire_field(lease, "requestedSettings").ok_or("Native temperature lease request is missing")?;
    let WireValue::Object(requested_entries) = requested_wire else { return Err("Native temperature lease request is invalid".into()); };
    if requested_entries.len() != 1
        || requested_entries[0].0 != "tempLimitC"
        || wire_finite_number(&requested_entries[0].1) != Some(requested) {
        return Err("Native temperature lease request does not match the apply".into());
    }

    let ranges_wire = wire_field(lease, "ranges").ok_or("Native temperature lease range is missing")?;
    let range_wire = wire_field(ranges_wire, "tempLimitC").ok_or("Native temperature lease range is missing")?;
    let range = wire_json_without_undefined(range_wire)?;
    if temperature_range_values(&range).is_none() { return Err("Native temperature lease range is invalid".into()); }

    let cache = wire_field(lease, "cache").ok_or("Native temperature cache snapshot is missing")?;
    if wire_string(Some(wire_field(cache, "status").ok_or("Native temperature cache status is missing")?)) != Some("available") {
        return Err("The temperature refusal cache is unavailable".into());
    }
    let range_units = range.get("units").and_then(Value::as_str);
    let cached_units = wire_field(cache, "units")
        .and_then(|units| wire_field(units, "tempLimitC"))
        .and_then(|units| wire_string(Some(units)));
    if cached_units.is_some_and(|units| Some(units) != range_units) {
        return Err("Temperature control units changed during this session".into());
    }
    let ceilings = wire_field(cache, "ceilings").ok_or("Native temperature cache ceilings are missing")?;
    let learned_ceiling = match wire_field(ceilings, "tempLimitC").ok_or("Native temperature cache ceiling is missing")? {
        WireValue::Undefined | WireValue::Null => None,
        value => Some(wire_finite_number(value).ok_or("Native temperature cache ceiling is invalid")?),
    };
    if learned_ceiling.is_some() && cached_units != range_units {
        return Err("Temperature refusal cache ceiling has no matching unit identity".into());
    }
    if learned_ceiling.is_some_and(|ceiling| !super::apply_gates::valid_learned_temp_ceiling(ceiling, &range)) {
        return Err("Native temperature cache ceiling is invalid".into());
    }
    let oc_mode = wire_field(lease, "ocMode").and_then(|value| wire_string(Some(value))).map(str::to_owned);
    Ok(ValidatedTemperatureLeaseSnapshot {
        epoch, transaction_sequence, cache_generation, target, range, learned_ceiling, oc_mode,
    })
}

/// Validate the native temperature lease begin envelope against a physical
/// target row. Exposed for the host's producer/consumer contract test; normal
/// applies use the identity already pinned by their preflight.
pub fn validate_temperature_lease_snapshot_for_target(
    lease: &WireValue,
    device_id: u64,
    requested_settings: &Value,
    expected_target: &Value,
) -> Result<(), String> {
    let expected_identity = super::gpu_apply_identity::identity_from_row(expected_target)?;
    validate_temperature_lease_snapshot(lease, device_id, requested_settings, &expected_identity).map(|_| ())
}

fn native_capability_error_deferable(error: &str) -> bool {
    error == "fan probe verdict is not cached"
}

fn waiver_read_failure(build_kind: BuildKind, error: &str) -> Option<Result<Value, String>> {
    if matches!(build_kind, BuildKind::Dev) { None }
    else { Some(Err(format!("Unable to read GPU waiver eligibility: {error}"))) }
}

fn gpu_read_failure(build_kind: BuildKind, channel: &str, error: &str) -> Option<Result<Value, String>> {
    if matches!(build_kind, BuildKind::Dev) { None }
    else { Some(Err(format!("{channel}: unable to read GPU: {error}"))) }
}

fn native_only_capabilities_fallback_allowed(build_kind: BuildKind, error: &str) -> bool {
    !matches!(build_kind, BuildKind::Dev) && native_capability_error_deferable(error)
}

/// Native-only fallback for a missing Electron fan-probe cache: run the same
/// reversible probe Electron runs, and degrade to read-only capabilities only
/// if the probe itself cannot complete. This keeps fan control available on a
/// fresh install without changing the write/restore contract.
fn native_capabilities_with_probe_or_read_only(
    path: &std::path::Path,
    identity: &super::gpu_apply_identity::ApplyIdentity,
    mode: &str,
    waiver: bool,
) -> Result<Value, String> {
    match super::gpu_capabilities::capabilities_for_identity_with_probe(path, identity, mode, waiver) {
        Ok(caps) => Ok(caps),
        Err(_) => super::gpu_capabilities::capabilities_for_identity_without_fan_probe(path, identity, mode, waiver),
    }
}

/// Mirror Electron's profile behavior when the bundled 2023 runtime cannot
/// own W/C controls: refuse just those controls and keep applying the rest of
/// the saved profile. This decision is made before any setter is opened.
fn native_profile_extended_unavailable_plan(
    settings: &Value,
    caps: &Value,
    legacy_settings: &Value,
) -> (Value, Value) {
    let targets: Vec<&str> = ["powerLimitW", "tempLimitC"].into_iter()
        .filter(|key| legacy_settings.get(*key).is_some()).collect();
    let refused = if caps.get("extendedControls").is_some_and(Value::is_object) {
        super::apply_gates::unsupported_legacy_targets(&targets, caps)
    } else if caps.get("extendedRanges") == Some(&Value::Bool(true)) { Vec::new() }
    else { targets };
    let mut routed = settings.clone();
    let mut per_control = serde_json::Map::new();
    if let Some(entries) = routed.as_object_mut() {
        for control in refused {
            entries.remove(control);
            per_control.insert(control.to_owned(), json!({
                "ok": false,
                "errorCode": "unsupported",
                "message": super::apply_gates::EXTENDED_UNAVAILABLE_MSG,
            }));
        }
    }
    (routed, Value::Object(per_control))
}

fn temperature_lease_mode_matches_stored(lease_mode: Option<&str>, stored_mode: &str) -> bool {
    lease_mode.is_none_or(|mode| mode == stored_mode)
}

fn temperature_ranges_compatible(native: Option<&Value>, broker: &Value) -> bool {
    let Some(native) = native else { return false; };
    if native.get("units") != broker.get("units") { return false; }
    let Some((native_min, native_max, native_step)) = temperature_range_values(native) else { return false; };
    let Some((broker_min, broker_max, broker_step)) = temperature_range_values(broker) else { return false; };
    let close = |left: f64, right: f64| {
        (left - right).abs() <= f64::EPSILON * 256.0 * 1.0_f64.max(left.abs()).max(right.abs())
    };
    close(native_min, broker_min)
        && close(native_step, broker_step)
        && broker_max <= native_max + f64::EPSILON * 256.0 * 1.0_f64.max(native_max.abs())
}

#[cfg(windows)]
fn process_is_elevated() -> bool {
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}
#[cfg(not(windows))]
fn process_is_elevated() -> bool { false }

fn merge_per_control(target: &mut Value, source: &Value) {
    if let Some(per_control) = source.get("perControl").and_then(Value::as_object) {
        if let Some(map) = target.get_mut("perControl").and_then(Value::as_object_mut) {
            for (key, value) in per_control { map.insert(key.clone(), value.clone()); }
        }
    }
    if source.get("ok") != Some(&Value::Bool(true)) { target["ok"] = json!(false); }
}

/// Native caps/state mode and waiver for one inventory row. Only the two
/// supported modes are migrated; unknown modes defer to the broker.
fn native_mode_waiver(store: &NativeStore, dll_path: &std::path::Path, device_id: u64) -> Option<(String, bool)> {
    let devices = super::gpu_devices::list_devices(dll_path).ok()?;
    let device = devices.as_array()?.get(device_id as usize)?;
    let device_key = device["deviceKey"].as_str()?;
    let settings = native_json(store, "load-settings", json!([])).ok()?;
    let mode = settings["ocModes"].get(device_key).and_then(Value::as_str)
        .or_else(|| settings["ocMode"].as_str())
        .unwrap_or("stock");
    if mode != "stock" && mode != "advanced" { return None; }
    Some((mode.to_owned(), settings["waiverAccepted"].as_bool().unwrap_or(false)))
}

fn native_mode_waiver_for_key(store: &NativeStore, device_key: &str) -> Option<(String, bool)> {
    let settings = native_json(store, "load-settings", json!([])).ok()?;
    let mode = settings["ocModes"].get(device_key).and_then(Value::as_str)
        .or_else(|| settings["ocMode"].as_str())
        .unwrap_or("stock");
    if mode != "stock" && mode != "advanced" { return None; }
    Some((mode.to_owned(), settings["waiverAccepted"].as_bool().unwrap_or(false)))
}

fn validate_apply_target(
    dll_path: &std::path::Path,
    device_id: u64,
    expected: &super::gpu_apply_identity::ApplyIdentity,
) -> Result<(), String> {
    let devices = super::gpu_devices::list_devices(dll_path)?;
    let rows = devices.as_array().ok_or("native GPU inventory is unavailable")?;
    let row = rows.get(device_id as usize).ok_or("selected GPU is no longer enumerated")?;
    validate_apply_target_row(row, expected)
}

fn refusal_cache_identity_for_device_id(
    dll_path: &std::path::Path,
    device_id: u64,
) -> Result<super::gpu_apply_identity::ApplyIdentity, String> {
    let devices = super::gpu_devices::list_devices(dll_path)?;
    let index = usize::try_from(device_id).map_err(|_| "GPU ordinal is invalid")?;
    let target = devices.as_array().and_then(|rows| rows.get(index))
        .ok_or("GPU ordinal no longer resolves")?;
    let (identity, _) = super::profile_apply_preflight::resolve_fresh_target(target)?;
    Ok(identity)
}

fn validate_apply_target_row(
    row: &Value,
    expected: &super::gpu_apply_identity::ApplyIdentity,
) -> Result<(), String> {
    let actual = super::gpu_apply_identity::identity_from_row(row)?;
    super::gpu_apply_identity::ensure_same_target(expected, &actual)
}

fn current_bdf(dll_path: &std::path::Path, device_id: u64) -> Option<(u32, u32, u32)> {
    let devices = super::gpu_devices::list_devices(dll_path).ok()?;
    let device = devices.as_array()?.get(device_id as usize)?;
    Some((
        device["bdf"]["bus"].as_u64()? as u32,
        device["bdf"]["device"].as_u64()? as u32,
        device["bdf"]["function"].as_u64()? as u32,
    ))
}

/// Read the same device-scoped sustained/burst limits exposed by the
/// `power-limits:read` channel. Read-only callers such as Stability use this
/// shared path so their threshold source matches Tuning's PL1 readout.
pub fn read_power_limits_for_device(device_id: u64) -> Value {
    let Some(path) = super::gpu_devices::locate_dll() else { return Value::Null; };
    let Some((bus, device, function)) = current_bdf(&path, device_id) else { return Value::Null; };
    let Ok(mut session) = super::sysman::SysmanSession::load() else { return Value::Null; };
    let Some(mut target) = session.device(super::sysman::Bdf { domain: 0, bus, device, function }) else {
        return Value::Null;
    };
    match super::sysman_power::SysmanPower::read_limits(&mut target) {
        Ok(limits) => json!({
            "sustainedW": limits.sustained_w,
            "burstW": limits.burst_w,
            "peakW": limits.peak_w,
        }),
        Err(_) => Value::Null,
    }
}

fn sysman_voltage_apply(
    session: &mut super::sysman::SysmanSession,
    bdf: super::sysman::Bdf,
    offset_v: f64,
    waiver: bool,
) -> Value {
    let request = super::sysman_voltage::VoltageRequest {
        offset_v, target_v: None, frequency_target_mhz: None, waiver_accepted: waiver,
    };
    match session.device(bdf) {
        Some(mut device) => super::sysman_voltage::apply_voltage_offset(&mut device, request),
        None => json!({
            "ok": false, "errorCode": "unsupported",
            "message": "the requested GPU has no unique Sysman frequency-domain match",
        }),
    }
}

/// Read-before-write zero clear. A verified 0 V state is left untouched, so a
/// normal positive/no-offset apply does not require a waiver merely to clear a
/// state that is already clear.
fn sysman_voltage_clear(
    session: &mut super::sysman::SysmanSession,
    bdf: super::sysman::Bdf,
    waiver: bool,
) -> Value {
    let Some(mut device) = session.device(bdf) else {
        return json!({
            "ok": false, "errorCode": "unsupported",
            "message": "the requested GPU has no unique Sysman frequency-domain match",
        });
    };
    super::sysman_voltage::clear_voltage_offset(&mut device, waiver)
}

#[cfg(test)]
fn stock_waiver(settings: &Value, device_key: &str) -> Option<bool> {
    let mode = settings["ocModes"].get(device_key).and_then(Value::as_str)
        .or_else(|| settings["ocMode"].as_str())
        .unwrap_or("stock");
    if mode != "stock" { return None; }
    Some(settings["waiverAccepted"].as_bool().unwrap_or(false))
}

fn no_payload(channel: &str, args: &Value) -> Result<(), String> {
    let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
    if !args.is_empty() { return Err(format!("{channel} does not accept a payload")); }
    Ok(())
}

/// ipc-core.js's exact no-payload message (`assertNoPayload`).
fn no_payload_exact(channel: &str, args: &Value) -> Result<(), String> {
    let WireValue::Array(args) = decode(args)? else { return Err("Expected argument array".into()); };
    if !args.is_empty() { return Err(format!("{channel} takes no payload")); }
    Ok(())
}

fn wire_string(value: Option<&WireValue>) -> Option<&str> {
    match value { Some(WireValue::String(value)) => Some(value.as_str()), _ => None }
}

fn valid_intel_kind(kind: Option<&str>) -> bool { matches!(kind, Some("arc" | "pro")) }

/// Exact `validateIntelDriverDownloadIdentity` messages from ipc-core.js.
fn validate_intel_download_identity(channel: &str, kind: Option<&str>, version: Option<&str>) -> Result<(), String> {
    if !valid_intel_kind(kind) { return Err(format!("{channel}: invalid kind")); }
    if !version.is_some_and(super::intel_driver_catalog::is_full_driver_version) {
        return Err(format!("{channel}: invalid version"));
    }
    Ok(())
}

fn intel_catalog() -> Result<&'static super::intel_driver_catalog::IntelDriverCatalog, String> {
    super::intel_driver_catalog::IntelDriverCatalog::shared()
}

#[cfg(test)]
fn driver_monitor_inputs() -> (Value, Option<String>) {
    super::driver_monitor::check_seam().unwrap_or_else(|| (Value::Array(Vec::new()), None))
}

#[cfg(not(test))]
fn driver_monitor_inputs() -> (Value, Option<String>) {
    (super::gpu_devices::list_devices_merged(), super::native_system::driver_date())
}

pub(crate) fn native_json(store: &NativeStore, method: &str, args: Value) -> Result<Value, String> {
    let encoded = store.invoke(method, &encode_json(&args)?)?;
    decode(&encoded)?.into_json()
}

/// Resolve the persisted recording folder through the same Rust owner and the
/// same absolute Win32 path rules as the recording store.
pub fn recording_settings(store: &NativeStore) -> Result<Value, String> {
    let response = native_json(store, "recording-settings", json!([]))?;
    // DomainStore wraps recording replies as {result, cache}; accept the raw
    // settings object too so this remains valid if the wrapper changes.
    Ok(response.get("result").cloned().unwrap_or(response))
}

pub fn recording_folder_path(store: &NativeStore) -> Result<String, String> {
    let settings = recording_settings(store)?;
    super::recording_paths::recording_absolute_path(settings.get("location"), "location",
        &super::recording_paths::SystemWin32Paths)
}

pub fn recording_folder_selection(store: &NativeStore, selected: Option<String>) -> Result<Value, String> {
    let settings = recording_settings(store)?;
    let Some(selected) = selected else { return Ok(json!({"canceled": true, "settings": settings})); };
    let location = super::recording_paths::recording_absolute_path(Some(&json!(selected)), "location",
        &super::recording_paths::SystemWin32Paths)?;
    std::fs::create_dir_all(&location).map_err(|error| error.to_string())?;
    Ok(json!({"canceled": false, "location": location, "settings": settings}))
}

pub fn add_game_catalog_path(store: &NativeStore, selected: &str) -> Result<Value, String> {
    let path = std::path::Path::new(selected);
    let entry = json!({
        "exePath": selected,
        "processName": path.file_name().and_then(|name| name.to_str()).unwrap_or(""),
        "displayName": path.file_stem().and_then(|name| name.to_str()).unwrap_or(""),
        "source": "manual",
    });
    store.invoke("game-add-catalog-entry", &encode_json(&json!([entry]))?)?;
    let catalog = native_json(store, "game-load-catalog", json!([]))?;
    let mut reply = catalog.as_object().cloned().unwrap_or_default();
    reply.insert("canceled".into(), json!(false));
    Ok(Value::Object(reply))
}

pub fn game_catalog_canceled(store: &NativeStore) -> Result<Value, String> {
    let catalog = native_json(store, "game-load-catalog", json!([]))?;
    let mut reply = catalog.as_object().cloned().unwrap_or_default();
    reply.insert("canceled".into(), json!(true));
    Ok(Value::Object(reply))
}

pub(super) fn overlay_defaults(settings: &Value) -> Value {
    let get = |key: &str, fallback: Value| settings.get(key).cloned().unwrap_or(fallback);
    json!({
        "position": get("overlayPosition", json!("top-left")),
        "scale": get("overlayScale", json!(1)),
        "theme": get("overlayTheme", json!("arc")),
        "stats": get("overlayStats", json!([])),
        "deviceKeys": get("overlayDeviceKeys", Value::Null),
        "background": {
            "enabled": settings.get("overlayBgEnabled") == Some(&Value::Bool(true)),
            "color": get("overlayBgColor", json!("#000000")),
            "opacity": get("overlayBgOpacity", json!(0.5)),
        },
        "advancedPosition": get("advancedOverlayPosition", json!("right")),
    })
}

fn opaque_clip_id(id: &str) -> bool {
    (8..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Resolve a clip only when its canonical path stays inside the canonical
/// recording root. This rejects traversal, absolute paths, non-video files and
/// symlink/junction escapes before any clipboard authority is used.
pub fn recording_clip_path(store: &NativeStore, id: &str) -> Result<String, String> {
    if !opaque_clip_id(id) { return Err("recording-clip-copy: invalid clip id".into()); }
    let response = native_json(store, "recording-clip-by-id", json!([id]))?;
    let clip = response.get("result").unwrap_or(&response);
    if clip.is_null() { return Err("recording-clip-copy: clip not found".into()); }
    let relative = clip.get("relativePath").and_then(Value::as_str)
        .filter(|path| !path.is_empty() && !std::path::Path::new(path).is_absolute())
        .ok_or("recording-clip-copy: clip path is unsafe")?;
    if super::recording_contract::safe_video_extension(&json!(relative)).is_none()
        || super::recording_contract::is_recording_temporary_artifact(&json!(relative)) {
        return Err("recording-clip-copy: clip path is unsafe".into());
    }
    let root = recording_folder_path(store)?;
    let canonical_root = std::fs::canonicalize(&root).map_err(|_| "recording-clip-copy: clip path is unsafe")?;
    let canonical = std::fs::canonicalize(std::path::Path::new(&root).join(relative))
        .map_err(|_| "recording-clip-copy: clip path is unsafe")?;
    if !canonical.is_file() { return Err("recording-clip-copy: clip path is unsafe".into()); }
    let root_text = canonical_root.to_string_lossy().to_lowercase();
    let candidate_text = canonical.to_string_lossy().to_lowercase();
    let prefix = if root_text.ends_with('\\') { root_text } else { format!("{root_text}\\") };
    if !candidate_text.starts_with(&prefix) { return Err("recording-clip-copy: clip path is unsafe".into()); }
    Ok(canonical.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn window_process_names() -> Vec<String> {
    use std::ffi::c_void;
    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: unsafe extern "system" fn(*mut c_void, *mut c_void) -> i32, lparam: *mut c_void) -> i32;
        fn GetWindowTextLengthW(hwnd: *mut c_void) -> i32;
        fn GetWindowTextW(hwnd: *mut c_void, text: *mut u16, max: i32) -> i32;
        fn GetWindowThreadProcessId(hwnd: *mut c_void, pid: *mut u32) -> u32;
        fn IsWindowVisible(hwnd: *mut c_void) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut c_void;
        fn QueryFullProcessImageNameW(process: *mut c_void, flags: u32, name: *mut u16, size: *mut u32) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    unsafe extern "system" fn collect(hwnd: *mut c_void, lparam: *mut c_void) -> i32 {
        if IsWindowVisible(hwnd) == 0 { return 1; }
        let length = GetWindowTextLengthW(hwnd);
        if length <= 0 { return 1; }
        let mut title = vec![0u16; (length + 1) as usize];
        if GetWindowTextW(hwnd, title.as_mut_ptr(), title.len() as i32) <= 0 { return 1; }
        if String::from_utf16_lossy(&title[..length as usize]).trim().is_empty() { return 1; }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == 0 { return 1; }
        // PROCESS_QUERY_LIMITED_INFORMATION. Elevated/protected processes
        // simply do not contribute a name, matching the filter's best effort.
        let process = OpenProcess(0x1000, 0, pid);
        if process.is_null() { return 1; }
        let mut buffer = vec![0u16; 32768];
        let mut size = buffer.len() as u32;
        let ok = QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut size);
        CloseHandle(process);
        if ok == 0 { return 1; }
        if let Some(name) = std::path::Path::new(&String::from_utf16_lossy(&buffer[..size as usize]))
            .file_stem().and_then(|stem| stem.to_str()) {
            (*(lparam as *mut Vec<String>)).push(format!("{name}.exe"));
        }
        1
    }
    let mut names: Vec<String> = Vec::new();
    unsafe { EnumWindows(collect, &mut names as *mut _ as *mut c_void); }
    let mut seen = std::collections::HashSet::new();
    names.retain(|name| seen.insert(name.clone()));
    names.sort_by(|left, right| left.to_lowercase().cmp(&right.to_lowercase()));
    names
}

#[cfg(not(windows))]
fn window_process_names() -> Vec<String> { Vec::new() }

#[cfg(windows)]
fn disk_space(path: &str) -> Option<(u64, u64)> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(directory: *const u16, free_available: *mut u64, total: *mut u64, free_total: *mut u64) -> i32;
    }
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let (mut free_available, mut total, mut free_total) = (0u64, 0u64, 0u64);
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free_available, &mut total, &mut free_total) };
    (ok != 0).then_some((free_available, total))
}

#[cfg(not(windows))]
fn disk_space(_path: &str) -> Option<(u64, u64)> { None }

/// A negative Alchemist Sysman undervolt extends the V/F curve and can make
/// the IGCL frequency-offset getter report a derived positive value even
/// though the user requested none. Keep the requested offset (or the value
/// that was present before the apply) in the returned state so the derived
/// value is never shown as a core clock or captured into a profile.
fn preserve_requested_frequency_offset(
    state: &mut Option<Value>,
    requested: Option<f64>,
    pre_apply: Option<f64>,
) {
    let Some(state) = state.as_mut().filter(|value| value.is_object()) else { return; };
    let reported = requested.filter(|value| value.is_finite())
        .or(pre_apply.filter(|value| value.is_finite()));
    if let Some(reported) = reported { state["gpuFreqOffsetMhz"] = json!(reported); }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn context(store: &NativeStore) -> ServiceContext<'_> {
        ServiceContext { build_kind: BuildKind::Dev, mock_mode: false, store }
    }
    fn fixture() -> (std::path::PathBuf, NativeStore) { fixture_mode("advanced") }
fn fixture_mode(mode: &str) -> (std::path::PathBuf, NativeStore) {
    let root = std::env::temp_dir().join(format!("arc-services-test-{:032x}", rand::random::<u128>()));
    std::fs::create_dir(&root).unwrap();
    let store = NativeStore::new(root.clone(), mode).unwrap();
    (root, store)
}
    fn service(store: &NativeStore, channel: &str, payload: Value) -> Value {
        let result = invoke(channel, &encode_json(&json!([payload])).unwrap(), context(store)).unwrap().unwrap();
        decode(&result).unwrap().into_json().unwrap()
    }
    #[test]
    fn negative_voltage_keeps_the_requested_frequency_offset() {
        let mut derived = Some(json!({"gpuFreqOffsetMhz": 172.0, "gpuVoltOffsetV": -0.075}));
        preserve_requested_frequency_offset(&mut derived, None, Some(0.0));
        assert_eq!(derived.unwrap()["gpuFreqOffsetMhz"], 0.0);

        let mut requested = Some(json!({"gpuFreqOffsetMhz": 172.0}));
        preserve_requested_frequency_offset(&mut requested, Some(50.0), Some(0.0));
        assert_eq!(requested.unwrap()["gpuFreqOffsetMhz"], 50.0);

        let mut missing = None;
        preserve_requested_frequency_offset(&mut missing, None, Some(0.0));
        assert!(missing.is_none());
    }

    #[test]
    fn derived_frequency_guard_survives_a_fresh_read_and_clears_on_reset() {
        let key = "pci:derived-frequency-guard";
        forget_frequency_offset_guard(key);
        remember_frequency_offset_guard(key, 0.0);
        let mut apply_state = json!({"gpuFreqOffsetMhz": 172.0});
        apply_frequency_offset_guard(&mut apply_state, key);
        assert_eq!(apply_state["gpuFreqOffsetMhz"], 0.0);

        let mut fresh = json!({"gpuFreqOffsetMhz": 172.0});
        apply_frequency_offset_guard(&mut fresh, key);
        assert_eq!(fresh["gpuFreqOffsetMhz"], 0.0);

        forget_frequency_offset_guard(key);
        fresh["gpuFreqOffsetMhz"] = json!(172.0);
        apply_frequency_offset_guard(&mut fresh, key);
        assert_eq!(fresh["gpuFreqOffsetMhz"], 172.0);
    }
    #[test]
    fn arc_sync_range_intent_requires_the_final_verified_physical_output() {
        let (root, store) = fixture();
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = "pci:0x00008086:0x0000e20b@3:0.0|display|1234|edid|aabbccdd";
        let values = json!({"minHz": 60.0, "maxHz": 165.0});
        let patch = json!({"arcSyncRange": values});
        let plan = display_apply_plan(patch.as_object().unwrap()).unwrap();
        let mut result = json!({
            "perControl": {"arcSyncRange": {
                "ok": true, "readBackEqual": true, "matched": true,
                "readBackMinHz": 60.0, "readBackMaxHz": 165.0,
            }},
            "displayState": {"deviceKey": device_key, "displays": [{
                "displayKey": display_key, "identityVerified": true, "flags": {"active": true},
                "arcSync": {"profile": "custom", "currentRange": values},
            }]},
        });
        let file = arc_sync_range_store(&store).unwrap();
        result["displayState"]["displays"][0]["arcSync"]["currentRange"]["minHz"] = json!(61.0);
        remember_arc_sync_range(&store, device_key, display_key, &plan, &result).unwrap();
        assert!(file.read().unwrap().is_none());

        result["displayState"]["displays"][0]["arcSync"]["currentRange"] = values.clone();
        let row = result["displayState"]["displays"][0].clone();
        result["displayState"]["displays"] = json!([row, row]);
        remember_arc_sync_range(&store, device_key, display_key, &plan, &result).unwrap();
        assert!(file.read().unwrap().is_none());

        result["displayState"]["displays"] = json!([row]);
        remember_arc_sync_range(&store, device_key, display_key, &plan, &result).unwrap();
        assert_eq!(saved_arc_sync_ranges(file.read().unwrap()).unwrap()[display_key], values);

        for (request, control, profile) in [
            (json!({"variableRefreshRate": false}), "variableRefreshRate", "off"),
            (json!({"vrrMode": "excellent"}), "vrrMode", "excellent"),
            (json!({"variableRefreshRate": true}), "variableRefreshRate", "recommended"),
        ] {
            let plan = display_apply_plan(request.as_object().unwrap()).unwrap();
            result["perControl"][control] = json!({"ok": true, "readBackEqual": true});
            result["displayState"]["displays"][0]["arcSync"]["profile"] = json!(profile);
            remember_arc_sync_range(&store, device_key, display_key, &plan, &result).unwrap();
            assert_eq!(saved_arc_sync_ranges(file.read().unwrap()).unwrap()[display_key], json!(profile));
        }

        let reset = json!({"arcSyncRange": null});
        let plan = display_apply_plan(reset.as_object().unwrap()).unwrap();
        result["displayState"]["displays"][0]["arcSync"]["profile"] = json!("recommended");
        remember_arc_sync_range(&store, device_key, display_key, &plan, &result).unwrap();
        assert!(saved_arc_sync_ranges(file.read().unwrap()).unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_game_profile_associations_use_the_native_store() {
        let (root, store) = fixture();
        store.invoke("save-profile", &encode_json(&json!([{"id":"p1","deviceKey":"gpu-a"}])).unwrap()).unwrap();
        let game_dir = root.join("steamapps").join("common").join("Fixture Game");
        std::fs::create_dir_all(&game_dir).unwrap();
        let exe = game_dir.join("Cyberpunk2077.exe");
        std::fs::write(&exe, b"fixture only").unwrap();
        let exe_json = json!(exe.to_string_lossy());
        let saved = service(&store, "game-profile-save", json!({
            "profileId": "p1", "exePath": exe_json, "displayName": "Fixture Game", "enabled": true,
        }));
        let associations = saved["associations"].as_array().unwrap();
        assert_eq!(associations.len(), 1);
        assert!(associations[0]["exePath"].as_str().unwrap().ends_with("cyberpunk2077.exe"));
        let deleted = service(&store, "game-profile-delete", json!({"profileId": "p1", "exePath": exe_json}));
        assert!(deleted["associations"].as_array().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn native_catalog_sync_applies_the_game_gate_and_catalog_store() {
        let (root, store) = fixture();
        let game_dir = root.join("steamapps").join("common").join("Fixture Game");
        std::fs::create_dir_all(&game_dir).unwrap();
        let exe = game_dir.join("Cyberpunk2077.exe");
        std::fs::write(&exe, b"fixture only").unwrap();
        let result = service(&store, "game-catalog-sync", json!([{
            "exePath": json!(exe.to_string_lossy()), "displayName": "Cyberpunk 2077",
            "processName": "Cyberpunk2077.exe", "source": "scan",
            "artwork": "data:image/png;base64,AA==", "banner": "data:image/png;base64,AA==",
        }]));
        let catalog = result["catalog"].as_array().unwrap();
        assert_eq!(catalog.len(), 1);
        assert!(catalog[0]["exePath"].as_str().unwrap().ends_with("cyberpunk2077.exe"));
        assert_eq!(catalog[0]["source"], "scan");
        assert_eq!(catalog[0]["artwork"], "data:image/png;base64,AA==");
        assert_eq!(catalog[0]["banner"], "data:image/png;base64,AA==");
        let _ = std::fs::remove_dir_all(root);
    }
    #[cfg(windows)]
    #[test]
    #[ignore = "read-only live inventory probe; writes only the temporary fixture catalog"]
    fn live_games_scan_syncs_the_native_catalog() {
        let (root, store) = fixture();
        let result = invoke("games-scan", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap();
        let result = decode(&result).unwrap().into_json().unwrap();
        assert!(result["apps"].is_array());
        assert!(result["sidecarError"].is_null(), "{}", result["sidecarError"]);
        assert!(result["catalog"].is_array());
        assert!(root.join("game-profiles.json").is_file());
        let _ = std::fs::remove_dir_all(root);
    }
    #[test]
    fn screen_postprocess_channels_are_native_or_mock_delegated() {
        let (root, store) = fixture();
        let channels = [
            "postprocess-sharpening:get", "postprocess-sharpening:set",
            "postprocess-sharpening:select-window", "postprocess-sharpening:stop-window",
            "postprocess-sharpening:hotkey-get", "postprocess-sharpening:hotkey-set",
            "arc-super-resolution:get", "arc-super-resolution:set",
        ];
        for channel in channels {
            assert!(invoke(channel, &encode_json(&json!([])).unwrap(),
                ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store }).is_none(),
                "{channel} must stay broker-owned in mock mode");
        }
        let get = invoke("postprocess-sharpening:get", &encode_json(&json!([])).unwrap(), context(&store))
            .unwrap().unwrap();
        let global = decode(&get).unwrap().into_json().unwrap();
        assert_eq!(global["value"], json!({"enabled": false, "percentage": 50}));
        assert_eq!(global["provider"], "screen");
        assert_eq!(global["requiresRestart"], false);
        assert_eq!(global["legacyManifestStatus"], "clear");
        // The capture-overlay provider is gated off in production: enabling is
        // refused, but a disabling write persists and the settings stay readable.
        let refused = invoke("postprocess-sharpening:set",
            &encode_json(&json!([{"enabled": true, "percentage": 90}])).unwrap(), context(&store)).unwrap().unwrap_err();
        assert_eq!(refused, crate::backend::postprocess_sharpening::SHARPENING_PAUSED_REASON);
        let set = invoke("postprocess-sharpening:set",
            &encode_json(&json!([{"enabled": false, "percentage": 90}])).unwrap(), context(&store)).unwrap().unwrap();
        let set = decode(&set).unwrap().into_json().unwrap();
        assert_eq!(set["value"], json!({"enabled": false, "percentage": 90}));
        assert!(root.join("postprocess-sharpening.json").is_file());
        let asr_refused = invoke("arc-super-resolution:set", &encode_json(&json!([{"enabled": true}])).unwrap(), context(&store))
            .unwrap().unwrap_err();
        assert_eq!(asr_refused, crate::backend::postprocess_sharpening::ASR_PAUSED_REASON);
        let asr = invoke("arc-super-resolution:set", &encode_json(&json!([{"enabled": false}])).unwrap(), context(&store))
            .unwrap().unwrap();
        let asr = decode(&asr).unwrap().into_json().unwrap();
        assert_eq!(asr["value"], json!({"enabled": false}));
        assert_eq!(asr["requiresRestart"], false);
        assert_eq!(asr["selection"]["phase"], "idle");
        let stopped = invoke("postprocess-sharpening:stop-window", &encode_json(&json!([])).unwrap(), context(&store))
            .unwrap().unwrap();
        let stopped = decode(&stopped).unwrap().into_json().unwrap();
        assert_eq!(stopped["selection"]["phase"], "idle");
        assert_eq!(stopped["sharpening"]["selection"]["phase"], "idle");
        let hotkey = invoke("postprocess-sharpening:hotkey-get", &encode_json(&json!([])).unwrap(), context(&store))
            .unwrap().unwrap();
        let hotkey = decode(&hotkey).unwrap().into_json().unwrap();
        assert_eq!(hotkey["accelerator"], "Alt+F10");
        assert!(hotkey["registered"].is_boolean());
        let hotkey_set = invoke("postprocess-sharpening:hotkey-set", &encode_json(&json!(["control+f8"])).unwrap(), context(&store))
            .unwrap().unwrap();
        let hotkey_set = decode(&hotkey_set).unwrap().into_json().unwrap();
        assert_eq!(hotkey_set["accelerator"], "Control+F8");
        assert_eq!(hotkey_set["registered"], false);
        assert!(hotkey_set["reason"].as_str().is_some());
        let bad = invoke("postprocess-sharpening:set", &encode_json(&json!([{"enabled": true, "percentage": 101}])).unwrap(), context(&store))
            .unwrap().unwrap_err();
        assert_eq!(bad, "Sharpening requires an enabled flag and a whole percentage from 0 to 100.");
        let payload = invoke("postprocess-sharpening:get", &encode_json(&json!([{}])).unwrap(), context(&store))
            .unwrap().unwrap_err();
        assert_eq!(payload, "postprocess-sharpening:get takes no payload");
        let asr_bad = invoke("arc-super-resolution:set", &encode_json(&json!([{"enabled": true, "method": "xess"}])).unwrap(), context(&store))
            .unwrap().unwrap_err();
        assert_eq!(asr_bad, "Arc Super Resolution requires an enabled flag.");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn version_keeps_existing_frontend_shape() {
        let (root, store) = fixture();
        let result = invoke("app-version", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap();
        assert_eq!(decode(&result).unwrap().into_json().unwrap(), json!({"version":"1.3.6"}));
        assert!(invoke("app-version", &json!({"t":"array","v":[{"t":"undefined"}]}), context(&store)).unwrap().is_err());
        let elevated = invoke("app-elevated", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap();
        let elevated = decode(&elevated).unwrap().into_json().unwrap();
        assert!(elevated["elevated"].is_boolean());
        assert_eq!(elevated["workerApply"], !elevated["elevated"].as_bool().unwrap());
        assert!(invoke("app-elevated", &json!({"t":"array","v":[{"t":"null"}]}), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_system_channels_are_owned_before_the_proxy() {
        let (root, store) = fixture();
        let build = invoke("app:build-info", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap();
        assert_eq!(decode(&build).unwrap().into_json().unwrap(), json!({"kind":"dev"}));
        assert!(invoke("driver-info", &json!({"t":"array","v":[]}),
            ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store }).is_none());
        assert!(invoke("open-external", &json!({"t":"array","v":[{"t":"string","v":"https://github.com.evil.example/YamsSE/Arc-Power"}]}), context(&store)).unwrap().is_err());
        assert!(invoke("open-external", &json!({"t":"array","v":[]}), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recording_folder_uses_the_native_store_location() {
        let (root, store) = fixture();
        let location = root.join("clips");
        let location_text = location.to_str().unwrap();
        let patch = json!([{"location": location_text}]);
        store.invoke("recording-save-settings", &encode_json(&patch).unwrap()).unwrap();
        assert_eq!(recording_folder_path(&store).unwrap(), location_text);
        assert!(invoke("recording-open-folder", &json!({"t":"array","v":[{"t":"boolean","v":true}]}), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recording_storage_info_uses_the_native_location() {
        let (root, store) = fixture();
        let location = root.join("clips");
        let patch = json!([{"location": location.to_str().unwrap()}]);
        store.invoke("recording-save-settings", &encode_json(&patch).unwrap()).unwrap();
        let reply = invoke("recording-storage-info", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap();
        let value = decode(&reply).unwrap().into_json().unwrap();
        assert_eq!(value["location"], json!(location.to_str().unwrap()));
        assert!(value["freeBytes"].is_u64() || value["freeBytes"].is_null());
        assert!(value["totalBytes"].is_u64() || value["totalBytes"].is_null());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recording_process_list_is_deduplicated_and_sorted() {
        let (root, store) = fixture();
        let reply = invoke("recording-processes-list", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap();
        let value = decode(&reply).unwrap().into_json().unwrap();
        let list = value.as_array().unwrap();
        let mut seen = std::collections::HashSet::new();
        for name in list {
            let text = name.as_str().unwrap();
            assert!(text.ends_with(".exe"));
            assert!(text.len() <= 4096);
            assert!(seen.insert(text.to_owned()));
        }
        let lowered = list.iter().map(|name| name.as_str().unwrap().to_lowercase()).collect::<Vec<_>>();
        let mut sorted = lowered.clone(); sorted.sort();
        assert_eq!(lowered, sorted);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recording_clip_copy_resolves_only_files_inside_the_recording_root() {
        let (root, store) = fixture();
        let folder = root.join("clips");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("clip.mp4"), b"video").unwrap();
        std::fs::write(root.join("outside.mp4"), b"outside").unwrap();
        let patch = json!([{"location": folder.to_str().unwrap()}]);
        store.invoke("recording-save-settings", &encode_json(&patch).unwrap()).unwrap();
        store.invoke("recording-record-clip", &encode_json(&json!([{"relativePath":"clip.mp4"}])).unwrap()).unwrap();
        let listed = native_json(&store, "recording-list-clips", json!([])).unwrap();
        let list = listed.get("result").unwrap_or(&listed).as_array().unwrap();
        let id = list[0]["id"].as_str().unwrap();
        assert_eq!(std::fs::canonicalize(recording_clip_path(&store, id).unwrap()).unwrap(),
            std::fs::canonicalize(folder.join("clip.mp4")).unwrap());
        assert!(recording_clip_path(&store, "short").is_err());
        assert!(recording_clip_path(&store, "does-not-exist").is_err());
        store.invoke("recording-record-clip", &encode_json(&json!([{"relativePath":"../outside.mp4"}])).unwrap()).unwrap();
        let listed = native_json(&store, "recording-list-clips", json!([])).unwrap();
        let traversal = listed.get("result").unwrap_or(&listed).as_array().unwrap().iter()
            .find(|clip| clip["relativePath"] == json!("../outside.mp4")).unwrap()["id"].as_str().unwrap().to_owned();
        assert!(recording_clip_path(&store, &traversal).is_err());
        assert!(invoke("recording-clip-copy", &json!({"t":"array","v":[{"t":"string","v":"short"}]}), context(&store)).unwrap().is_err());
        assert!(invoke("recording-clip-copy", &json!({"t":"array","v":[]}), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recording_capture_targets_are_native_and_strict() {
        let (root, store) = fixture();
        let reply = invoke("recording-capture-targets", &json!({"t":"array","v":[{"t":"boolean","v":true}]}), context(&store)).unwrap().unwrap();
        let value = decode(&reply).unwrap().into_json().unwrap();
        assert!(value["displays"].is_array());
        assert!(value["windows"].is_array());
        assert!(invoke("recording-capture-targets", &json!({"t":"array","v":[{"t":"string","v":"yes"}]}), context(&store)).unwrap().is_err());
        assert!(invoke("recording-capture-targets", &json!({"t":"array","v":[{},{}]}), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn recording_folder_selection_creates_the_chosen_folder_and_preserves_cancel() {
        let (root, store) = fixture();
        let selected = root.join("chosen");
        let reply = recording_folder_selection(&store, Some(selected.to_str().unwrap().to_owned())).unwrap();
        assert_eq!(reply["canceled"], json!(false));
        assert_eq!(reply["location"], json!(selected.to_str().unwrap()));
        assert!(selected.is_dir());
        let canceled = recording_folder_selection(&store, None).unwrap();
        assert_eq!(canceled["canceled"], json!(true));
        assert!(canceled["settings"].is_object());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn game_catalog_add_and_cancel_use_the_native_store() {
        let (root, store) = fixture();
        let game = root.join("Game.exe");
        std::fs::write(&game, b"fixture").unwrap();
        let added = add_game_catalog_path(&store, game.to_str().unwrap()).unwrap();
        assert_eq!(added["canceled"], json!(false));
        assert!(added["catalog"].as_array().unwrap().iter()
            .any(|entry| entry["exePath"].as_str().is_some_and(|path| path.eq_ignore_ascii_case(game.to_str().unwrap()))));
        let canceled = game_catalog_canceled(&store).unwrap();
        assert_eq!(canceled["canceled"], json!(true));
        assert_eq!(canceled["catalog"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn dialog_handlers_reject_payloads_before_showing_ui() {
        let (root, store) = fixture();
        assert!(invoke("recording-choose-folder", &json!({"t":"array","v":[{"t":"boolean","v":true}]}), context(&store)).unwrap().is_err());
        assert!(invoke("game-catalog-add", &json!({"t":"array","v":[{"t":"boolean","v":true}]}), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn read_only_store_channels_are_native_and_shaped() {
        let (root, store) = fixture();
        let profiles = decode(&invoke("profiles-list", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert!(profiles["profiles"].is_array());
        assert!(profiles["settings"].is_object());
        let device = decode(&invoke("device-get", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert!(device.get("deviceId").is_some());
        assert!(device.get("deviceKey").is_some());
        let catalog = decode(&invoke("game-catalog-list", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert!(catalog["catalog"].is_array());
        assert!(catalog["settings"].is_array());
        let associations = decode(&invoke("game-profiles-list", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert!(associations["associations"].is_array());
        let reports = decode(&invoke("stability-reports-list", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert!(reports.is_array());
        let latest = decode(&invoke("stability-report-latest", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert!(latest.is_null());
        // Layouts: the same native dispatcher owns the snapshot read and the
        // mutations, so the channel answers natively in a non-mock run.
        let layouts = decode(&invoke("overlay-layouts-list", &json!({"t":"array","v":[]}), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert_eq!(layouts["schemaVersion"], 1);
        assert_eq!(layouts["activeId"], "default");
        assert_eq!(layouts["layouts"].as_array().unwrap().len(), 1);
        assert_eq!(layouts["layouts"][0]["id"], "default");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn overlay_layout_channels_are_native_and_delegate_only_for_mock_or_unsafe_payloads() {
        use super::super::overlay_layout_channels::CHANNELS;
        let (root, store) = fixture();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        let list_args = encode_json(&json!([])).unwrap();

        // All five channels answer natively outside mock mode, and the snapshot
        // read is the same shape the handler replies with.
        let snapshot = decode(&invoke("overlay-layouts-list", &list_args, context(&store)).unwrap().unwrap()).unwrap();
        let snapshot = snapshot.into_json().unwrap();
        assert_eq!(snapshot.as_object().unwrap().keys().map(String::as_str).collect::<Vec<_>>(),
            ["schemaVersion", "activeId", "layouts"]);
        assert_eq!(snapshot["activeId"], "default");
        let saved = decode(&invoke("overlay-layout-save", &encode_json(&json!([{"id":"custom","name":"Game"}]))
            .unwrap(), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert_eq!(saved["layouts"][1]["id"], "custom");
        let renamed = decode(&invoke("overlay-layout-rename", &encode_json(&json!([{"id":"custom","name":"Renamed"}]))
            .unwrap(), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert_eq!(renamed["layouts"][1]["name"], "Renamed");
        let selected = decode(&invoke("overlay-layout-select", &encode_json(&json!(["custom"]))
            .unwrap(), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert_eq!(selected["activeId"], "custom");
        let deleted = decode(&invoke("overlay-layout-delete", &encode_json(&json!(["custom"]))
            .unwrap(), context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert_eq!(deleted["layouts"].as_array().unwrap().len(), 1);
        // A landed mutation published the settings it applied.
        assert_eq!(store.settings_store().load_settings_sync().unwrap().unwrap()["overlayPosition"], "top-left");

        // Mock mode keeps the compatibility service for every channel.
        for channel in CHANNELS { assert!(invoke(channel, &list_args, mock).is_none(), "{channel} delegates in mock mode"); }

        // Direct special-number and bigint values in fields with known JS
        // coercions are handled natively. A top-level null keeps its TypeError.
        let exotic_save = [
            json!({"t":"array","v":[{"t":"object","v":[["id",{"t":"undefined"}],["scale",{"t":"number","v":"NaN"}]]}]}),
            json!({"t":"array","v":[{"t":"object","v":[["id",{"t":"bigint","v":"123"}]]}]}),
            json!({"t":"array","v":[{"t":"object","v":[["id",{"t":"string","v":"x"}],["background",{"t":"object","v":[["opacity",{"t":"number","v":"Infinity"}]]}]]}]}),
            json!({"t":"array","v":[{"t":"null"}]}),
        ];
        for args in &exotic_save[..3] { assert!(invoke("overlay-layout-save", args, context(&store)).is_some(), "safe coercion stays native {args}"); }
        assert!(invoke("overlay-layout-save", &exotic_save[3], context(&store)).is_none(), "null keeps its TypeError");
        let unsafe_number = json!({"t":"array","v":[{"t":"object","v":[["id",{"t":"string","v":"unsafe"}],["scale",{"t":"object","v":[["toString",{"t":"string","v":"shadowed"}]]}]]}]});
        assert!(invoke("overlay-layout-save", &unsafe_number, context(&store)).is_none(), "ambiguous numeric coercion delegates");
        // The destructuring TypeError must keep its own message.
        assert!(invoke("overlay-layout-rename", &json!({"t":"array","v":[{"t":"null"}]}), context(&store)).is_none());
        // A non-string id can never match a layout: the same not-found error.
        let weird = json!({"t":"array","v":[{"t":"object","v":[["id",{"t":"number","v":"NaN"}],["name",{"t":"bigint","v":"123"}]]}]});
        let error = invoke("overlay-layout-rename", &weird, context(&store)).unwrap().unwrap_err();
        assert_eq!(error, "Overlay layout not found");
        // An explicit undefined member is the handler's "absent" value, so it
        // stays native: it inherits the same defaults an omitted field does.
        let absent = json!({"t":"array","v":[{"t":"object","v":[["id",{"t":"string","v":"absent"}],["name",{"t":"undefined"}]]}]});
        let reply = decode(&invoke("overlay-layout-save", &absent, context(&store)).unwrap().unwrap()).unwrap().into_json().unwrap();
        assert_eq!(reply["layouts"][1]["name"], "Default");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn health_channel_is_native_and_wire_encoded() {
        let (root, store) = fixture();
        let reply = invoke("health", &encode_json(&json!([])).unwrap(), context(&store))
            .expect("health is native").expect("health must answer");
        let report = decode(&reply).unwrap().into_json().unwrap();
        assert_eq!(report["backend"], json!("igcl"));
        assert_eq!(report["igclLoaded"], json!(true));
        assert!(report.get("driverVersion").is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn native_settings_patch_replies_are_wire_encoded_for_the_renderer_bridge() {
        // The renderer decodes EVERY bridge reply with decodeWire. A native
        // settings patch used to return its plain settings object here, so the
        // Settings page reported "Invalid wire value" for every native key
        // while delegated keys (whose reply comes from the broker) worked.
        let (root, store) = fixture();
        std::fs::write(root.join("settings.json"),
            br#"{"schemaVersion":3,"theme":"dark","startMinimized":false}"#).unwrap();
        let reply = service(&store, "profiles-settings-save", json!({"startMinimized": true}));
        assert_eq!(reply["startMinimized"], json!(true));
        assert_eq!(reply["theme"], json!("dark"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn amd_static_compute_units_match_published_models() {
        assert_eq!(amd_compute_units_of("AMD Radeon RX 9070 XT"), Some(64));
        assert_eq!(amd_compute_units_of("Radeon (TM) RX 9070 GRE 12GB"), Some(48));
        assert_eq!(amd_compute_units_of("AMD Radeon RX 9070 16GB"), Some(56));
        assert_eq!(amd_compute_units_of("Radeon RX 9060 XT"), Some(32));
        assert_eq!(amd_compute_units_of("Radeon RX 9060"), Some(28));
        assert_eq!(amd_compute_units_of("Radeon RX 9050"), Some(16));
        assert_eq!(amd_compute_units_of("Radeon RX 7900 XTX"), None);
    }
    #[test]
    fn settings_patch_channel_is_native_only_for_the_phase1_key_set() {
        let (root, store) = fixture();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        for patch in [json!({"theme":"light"}), json!({"startWithWindows":true}), json!({"arcSleep":{"idleEnabled":true}})] {
            let args = encode_json(&json!([patch])).unwrap();
            assert!(invoke("profiles-settings-save", &args, mock).is_none(), "mock mode delegates");
        }
        // Every React-owned key, and every mixed patch, delegates the WHOLE
        // patch before the settings file is read or written.
        let settings_path = root.join("settings.json");
        std::fs::write(&settings_path, br#"{"schemaVersion":3,"theme":"red"}"#).unwrap();
        let before = std::fs::read(&settings_path).unwrap();
        let before_modified = std::fs::metadata(&settings_path).unwrap().modified().unwrap();
        let mut patches: Vec<Value> = crate::backend::settings_patch::DELEGATED_KEYS.iter()
            .map(|key| json!({(*key): true})).collect();
        patches.push(json!({"startWithWindows":true,"reactOnlyA":true}));
        patches.push(json!({"activeProfileIds":{"gpu-a":"p1"},"reactOnlyB":true}));
        patches.push(json!({"theme":"red","reactOnlyC":true}));
        patches.push(json!({"arcSleep":{"idleFps":45},"reactOnlyD":true}));
        patches.push(json!({"notAKey":1}));
        for patch in patches {
            let args = encode_json(&json!([patch])).unwrap();
            assert!(invoke("profiles-settings-save", &args, context(&store)).is_none(), "{patch} delegates");
        }
        assert_eq!(std::fs::read(&settings_path).unwrap(), before);
        assert_eq!(std::fs::metadata(&settings_path).unwrap().modified().unwrap(), before_modified);
        // A delegated patch must not even populate the settings cache.
        assert_eq!(store.settings_store().load_settings_sync().unwrap(), None);

        // A Phase-1 patch is answered natively - including a store read failure
        // - so the arm never falls back to Electron once it owns the payload.
        // The registration write itself is driven through settings_patch's own
        // seam: a real Run/task registration has no place in the test suite.
        std::fs::write(&settings_path, b"not a settings document").unwrap();
        let invalid = invoke("profiles-settings-save", &encode_json(&json!([{"theme":"light"}])).unwrap(),
            context(&store));
        assert!(invalid.expect("Phase-1 patches are native").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn profile_write_channels_are_native_and_defer_in_mock_mode() {
        let (root, store) = fixture();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        let export_args = encode_json(&json!([])).unwrap();
        let save_args = encode_json(&json!([{
            "id": "p1", "name": "  Native  ", "ocOnBoot": true,
            "createdAt": "2026-01-01T00:00:00.000Z",
            "settings": {"powerLimitW": 210},
        }]))
        .unwrap();
        let delete_args = encode_json(&json!(["p1"])).unwrap();
        let import_args = encode_json(&json!([{
            "format": "arc-power-profile-transfer", "schemaVersion": 1, "profiles": [],
        }]))
        .unwrap();
        for (channel, args) in [
            ("profiles-export", &export_args),
            ("profiles-save", &save_args),
            ("profiles-delete", &delete_args),
            ("profiles-import", &import_args),
        ] {
            assert!(invoke(channel, args, mock).is_none(), "{channel}");
        }
        let saved = invoke("profiles-save", &save_args, context(&store))
            .unwrap()
            .unwrap();
        let saved = decode(&saved).unwrap().into_json().unwrap();
        assert_eq!(saved["profiles"][0]["name"], "Native");
        assert_eq!(saved["profiles"][0]["settings"]["powerLimitW"], 210);
        let deleted = invoke("profiles-delete", &delete_args, context(&store))
            .unwrap()
            .unwrap();
        let deleted = decode(&deleted).unwrap().into_json().unwrap();
        assert_eq!(deleted["profiles"], json!([]));
        assert!(invoke("profiles-delete", &json!({"t":"array","v":[]}), context(&store))
            .unwrap()
            .is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn profile_delete_cleans_native_game_associations() {
        let (root, store) = fixture();
        let saved = invoke(
            "profiles-save",
            &encode_json(&json!([{
                "id": "p1", "name": "Game", "ocOnBoot": false,
                "createdAt": "2026-01-01T00:00:00.000Z", "settings": {},
            }]))
            .unwrap(),
            context(&store),
        )
        .unwrap()
        .unwrap();
        assert_eq!(decode(&saved).unwrap().into_json().unwrap()["profiles"][0]["id"], "p1");
        let game_dir = root.join("steamapps").join("common").join("Fixture Game");
        std::fs::create_dir_all(&game_dir).unwrap();
        let exe = game_dir.join("Cyberpunk2077.exe");
        std::fs::write(&exe, b"fixture only").unwrap();
        let associated = service(&store, "game-profile-save", json!({
            "profileId": "p1", "exePath": json!(exe.to_string_lossy()),
            "displayName": "Fixture Game", "enabled": true,
        }));
        assert_eq!(associated["associations"].as_array().unwrap().len(), 1);
        let deleted = invoke(
            "profiles-delete",
            &encode_json(&json!(["p1"])).unwrap(),
            context(&store),
        )
        .unwrap()
        .unwrap();
        assert_eq!(decode(&deleted).unwrap().into_json().unwrap()["profiles"], json!([]));
        let associations = invoke(
            "game-profiles-list",
            &json!({"t":"array","v":[]}),
            context(&store),
        )
        .unwrap()
        .unwrap();
        let associations = decode(&associations).unwrap().into_json().unwrap();
        assert_eq!(associations["associations"], json!([]));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn profile_rename_preserves_the_store_contract() {
        let (root, store) = fixture();
        native_json(&store, "save-profile", json!([{"id":"p1","name":"Old","deviceKey":"pci:x"}])).unwrap();
        let renamed = invoke("profiles-rename", &encode_json(&json!(["p1","  New  "])).unwrap(), context(&store)).unwrap().unwrap();
        let renamed = decode(&renamed).unwrap().into_json().unwrap();
        assert_eq!(renamed["profiles"][0]["name"], "New");
        assert_eq!(renamed["profiles"][0]["deviceKey"], "pci:x");
        assert!(invoke("profiles-rename", &encode_json(&json!(["missing","Name"])).unwrap(), context(&store)).unwrap().is_err());
        assert!(invoke("profiles-rename", &encode_json(&json!(["p1"," "])).unwrap(), context(&store)).unwrap().is_err());
        assert!(invoke("profiles-rename", &encode_json(&json!(["p1"])).unwrap(), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oc_mode_persists_scalar_and_per_device_settings() {
        let mut settings = json!({"ocMode":"stock"});
        assert_eq!(oc_mode_get(&settings, None)["ocMode"], "stock");
        assert_eq!(oc_mode_set(&mut settings, "advanced", None)["ocMode"], "advanced");
        assert_eq!(oc_mode_set(&mut settings, "stock", Some("pci:x"))["deviceKey"], "pci:x");
        assert_eq!(oc_mode_get(&settings, Some("pci:x"))["ocMode"], "stock");
        assert_eq!(oc_mode_get(&settings, Some("pci:y"))["ocMode"], "advanced");
        let invalid = json!({"ocMode":"bogus","ocModes":{"pci:x":"nope"}});
        assert_eq!(oc_mode_get(&invalid, None)["ocMode"], "stock");
        assert_eq!(oc_mode_get(&invalid, Some("pci:x"))["ocMode"], "stock");
    }

    #[test]
    fn oc_mode_channel_reads_the_scalar_without_hardware() {
        let (root, store) = fixture();
        let result = invoke("oc-mode-get", &encode_json(&json!([null])).unwrap(), context(&store)).unwrap().unwrap();
        assert_eq!(decode(&result).unwrap().into_json().unwrap()["ocMode"], "advanced");
        assert!(invoke("oc-mode-get", &encode_json(&json!([])).unwrap(), context(&store)).unwrap().is_err());
        assert!(invoke("oc-mode-get", &encode_json(&json!(["bad"])).unwrap(), context(&store)).unwrap().is_err());
        assert!(invoke("oc-mode-set", &encode_json(&json!(["bogus", null, null, null])).unwrap(), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn oc_mode_channels_proxy_in_mock_mode() {
        // Mock runs must not split ownership of the OC mode between the
        // native settings store and Electron's MockBackend caps - the Tuning
        // toggle re-reads caps and would snap back otherwise.
        let (root, store) = fixture();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        let get = encode_json(&json!([null])).unwrap();
        let set = encode_json(&json!(["stock", null, null, "advanced"])).unwrap();
        assert!(invoke("oc-mode-get", &get, mock).is_none());
        assert!(invoke("oc-mode-set", &set, mock).is_none());
        // Nothing native ran: the store still holds the fixture's mode.
        let untouched = native_json(&store, "load-settings", json!([])).unwrap();
        assert_eq!(untouched["ocMode"], "advanced");
        // The real host still claims both channels and persists the write.
        let read = invoke("oc-mode-get", &get, context(&store)).unwrap().unwrap();
        assert_eq!(decode(&read).unwrap().into_json().unwrap()["ocMode"], "advanced");
        let written = invoke("oc-mode-set", &set, context(&store)).unwrap().unwrap();
        assert_eq!(decode(&written).unwrap().into_json().unwrap()["ocMode"], "stock");
        let saved = native_json(&store, "load-settings", json!([])).unwrap();
        assert_eq!(saved["ocMode"], "stock");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn list_devices_proxies_in_mock_mode() {
        let (root, store) = fixture();
        assert!(invoke("list-devices", &json!({"t":"array","v":[]}),
            ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store }).is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn device_selection_channels_proxy_in_mock_mode() {
        let (root, store) = fixture();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        for (channel, payload) in [
            ("device-preferred-get", json!([])),
            ("device-set", json!([0])),
            ("device-selection-generation-get", json!([])),
            ("device-selection-request", json!(["pci:gpu"])),
            ("device-selection-push", json!([{"deviceId": 0, "deviceKey": null, "caps": {}, "state": {}}])),
        ] {
            assert!(invoke(channel, &encode_json(&payload).unwrap(), mock).is_none(), "{channel}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn gpu_commands_proxy_in_mock_mode_and_validate_device_ids() {
        let (root, store) = fixture();
        let encoded = encode_json(&json!([0])).unwrap();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        assert!(invoke("get-capabilities", &encoded, mock).is_none());
        assert!(invoke("get-current-settings", &encoded, mock).is_none());
        assert!(invoke("get-capabilities", &json!({"t":"array","v":[]}), context(&store)).unwrap().is_err());
        assert!(invoke("get-current-settings", &json!({"t":"array","v":[-1]}), context(&store)).unwrap().is_err());
        assert_eq!(device_id_arg("test", &encoded).unwrap(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn native_caps_are_stock_only() {
        assert_eq!(stock_waiver(&json!({}), "pci:x"), Some(false));
        assert_eq!(stock_waiver(&json!({"waiverAccepted":true}), "pci:x"), Some(true));
        assert_eq!(stock_waiver(&json!({"ocMode":"advanced"}), "pci:x"), None);
        assert_eq!(stock_waiver(&json!({"ocMode":"advanced","ocModes":{"pci:x":"stock"}}), "pci:x"), Some(false));
        assert_eq!(stock_waiver(&json!({"ocMode":"stock","ocModes":{"pci:x":"advanced"}}), "pci:x"), None);
        assert_eq!(stock_waiver(&json!({"ocModes":{"pci:y":"advanced"}}), "pci:x"), Some(false));
    }
    #[test]
    fn advanced_mode_acceptance_is_native_and_persisted() {
        let (root, store) = fixture();
        let empty = json!({"t":"array","v":[]});
        let get = invoke("advanced-mode-accepted-get", &empty, context(&store)).unwrap().unwrap();
        assert_eq!(decode(&get).unwrap().into_json().unwrap()["accepted"], false);
        let set = invoke("advanced-mode-accepted-set", &empty, context(&store)).unwrap().unwrap();
        assert_eq!(decode(&set).unwrap().into_json().unwrap()["accepted"], true);
        let again = invoke("advanced-mode-accepted-get", &empty, context(&store)).unwrap().unwrap();
        assert_eq!(decode(&again).unwrap().into_json().unwrap()["accepted"], true);
        let settings = native_json(&store, "load-settings", json!([])).unwrap();
        assert_eq!(settings["advancedModeAccepted"], true);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn waiver_get_proxies_in_mock_mode_and_validates_ids() {
        let (root, store) = fixture();
        let args = encode_json(&json!([0])).unwrap();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        assert!(invoke("waiver-get", &args, mock).is_none());
        assert!(invoke("waiver-accept", &args, mock).is_none());
        assert!(invoke("waiver-get", &json!({"t":"array","v":[]}), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn waiver_read_errors_are_native_in_packaged_builds_and_defer_in_dev() {
        assert!(waiver_read_failure(BuildKind::Dev, "IGCL failed").is_none());
        for kind in [BuildKind::Portable, BuildKind::Installed] {
            assert_eq!(waiver_read_failure(kind, "IGCL failed").unwrap().unwrap_err(),
                "Unable to read GPU waiver eligibility: IGCL failed");
        }
    }
    #[test]
    fn waiver_accept_requires_physical_target_in_packaged_builds() {
        let target = apply_target("pci:0x00008086:0x0000e20b@3:0.0", 3);
        let legacy = encode_json(&json!([0])).unwrap();
        assert!(waiver_accept_args(&legacy, BuildKind::Dev).unwrap().1.is_none());
        assert!(waiver_accept_args(&legacy, BuildKind::Portable).is_err());
        let valid = encode_json(&json!([0, target])).unwrap();
        let expected = waiver_accept_args(&valid, BuildKind::Installed).unwrap().1.unwrap();
        let changed = apply_target("pci:0x00008086:0x0000e20b@4:0.0", 4);
        let changed = super::super::gpu_apply_identity::identity_from_row(&changed["physicalTarget"]).unwrap();
        assert!(super::super::gpu_apply_identity::ensure_same_target(&expected, &changed).is_err());
    }
    #[test]
    fn gpu_read_errors_are_native_in_packaged_builds_and_defer_in_dev() {
        for channel in ["get-capabilities", "get-current-settings"] {
            assert!(gpu_read_failure(BuildKind::Dev, channel, "fixture failure").is_none());
            for kind in [BuildKind::Portable, BuildKind::Installed] {
                assert_eq!(gpu_read_failure(kind, channel, "fixture failure").unwrap().unwrap_err(),
                    format!("{channel}: unable to read GPU: fixture failure"));
            }
        }
    }
    #[test]
    fn monitor_log_rejects_malformed_payloads() {
        let (root, store) = fixture();
        assert!(invoke("monitor-log-append", &json!({"t":"array","v":[]}), context(&store)).unwrap().is_err());
        assert!(invoke("monitor-log-append", &encode_json(&json!([1])).unwrap(), context(&store)).unwrap().is_err());
        assert!(invoke("monitor-log-append", &encode_json(&json!(["sample"])).unwrap(), context(&store)).unwrap().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    fn apply_target(key: &str, bus: u64) -> Value {
        json!({"deviceKey":key,"physicalTarget":{
            "deviceKey":key,"pciVendorId":"0x00008086","pciDeviceId":"0x0000e20b",
            "bdf":{"bus":bus,"device":0,"function":0},"luid":"0x00000001:0x00000002"
        }})
    }

    #[test]
    fn native_apply_payload_accepts_only_the_native_subset_with_selected_identity_proof() {
        let key = "pci:0x00008086:0x0000e20b@3:0.0";
        let expected = apply_target(key, 3);
        let encoded = encode_json(&json!([0, {"powerLimitW": 100, "gpuFreqOffsetMhz": 10}, {"expectedTarget":expected}])).unwrap();
        assert_eq!(native_apply_payload(&encoded).unwrap().unwrap().device_id, 0);
        let with_empty_opts = encode_json(&json!([0, {"tempLimitC": 80}, {}])).unwrap();
        assert!(native_apply_payload(&with_empty_opts).unwrap().is_none(), "absent proof delegates");
        let without_proof = encode_json(&json!([0, {"powerLimitW": 100}])).unwrap();
        assert!(native_apply_payload(&without_proof).unwrap().is_none(), "absent proof delegates");
        let undefined_opts = json!({"t":"array","v":[
            {"t":"number","v":0},
            {"t":"object","v":[["powerLimitW",{"t":"number","v":100}]]},
            {"t":"undefined"}
        ]});
        assert!(native_apply_payload(&undefined_opts).unwrap().is_none(), "absent proof delegates");
        let with_vf = encode_json(&json!([0, {"vfCurve": [
            {"voltageV": 0.8, "freqMhz": 2000}, {"voltageV": 1.0, "freqMhz": 2500}
        ]}, {"expectedTarget":expected}])).unwrap();
        assert!(native_apply_payload(&with_vf).unwrap().is_some());
        let with_fan = encode_json(&json!([0, {
            "fanMode": "curve",
            "fanCurve": [{"t": 40, "speedPct": 30}, {"t": 80, "speedPct": 70}]
        }, {"expectedTarget":expected}])).unwrap();
        assert!(native_apply_payload(&with_fan).unwrap().is_some());
        let with_lock = encode_json(&json!([0, {"gpuLock": {"voltageV": 0.95, "freqMhz": 2400}}, {"expectedTarget":expected}])).unwrap();
        assert!(native_apply_payload(&with_lock).unwrap().is_some());
        let with_temperature = encode_json(&json!([0, {"tempLimitC": 80}, {"expectedTarget":expected.clone()}])).unwrap();
        assert!(native_apply_payload(&with_temperature).unwrap().is_none(), "temperature applies remain broker-owned");
        let mixed_temperature = encode_json(&json!([0, {"tempLimitC": 80, "gpuFreqOffsetMhz": 10}, {"expectedTarget":expected.clone()}])).unwrap();
        assert!(native_apply_payload(&mixed_temperature).unwrap().is_none(), "mixed temperature applies remain broker-owned");
        for rejected in [
            encode_json(&json!([0, {"fanMode": "turbo"}])).unwrap(),
            encode_json(&json!([0, {"fanCurve": "not-an-array"}])).unwrap(),
            encode_json(&json!([0, {"gpuLock": {"voltageV": "0.95", "freqMhz": 2400}}])).unwrap(),
            encode_json(&json!([0, {"gpuLock": {"voltageV": 0.95}}])).unwrap(),
            encode_json(&json!([0, {"powerLimitW": "100"}])).unwrap(),
            encode_json(&json!([0, {"powerLimitW": 100}, {"profileApply": true}])).unwrap(),
            encode_json(&json!([0, {"vfCurveResetToDefault": true}])).unwrap(),
            encode_json(&json!([0, {"vfCurveBaseline": []}])).unwrap(),
            encode_json(&json!([0, {"vfCurve": "not-an-array"}])).unwrap(),
            encode_json(&json!([0])).unwrap(),
            encode_json(&json!([0, {"powerLimitW": 100}, {"expectedTarget":{"deviceKey":"gpu-a","physicalTarget":{}}}])).unwrap(),
            encode_json(&json!([0, {"powerLimitW": 100}, {"expectedTarget":expected}, 4])).unwrap(),
        ] {
            assert!(!matches!(native_apply_payload(&rejected), Ok(Some(_))));
        }
    }

    #[test]
    fn profile_apply_stays_brokered_after_physical_target_proof_validation() {
        let missing = encode_json(&json!([0, {"powerLimitW": 200}])).unwrap();
        assert!(native_apply_payload(&missing).unwrap().is_none(), "absent proof delegates");

        let profile_without_proof = encode_json(&json!([0, {"powerLimitW": 200}, {"profileApply": true}])).unwrap();
        assert!(native_apply_payload(&profile_without_proof).unwrap().is_none(), "absent proof delegates");

        let expected = apply_target("pci:0x00008086:0x0000e20b@3:0.0", 3);
        let profile = encode_json(&json!([0, {"powerLimitW": 200}, {"profileApply": true, "expectedTarget": expected.clone()}])).unwrap();
        assert!(native_apply_payload(&profile).unwrap().is_none(), "profile apply remains broker-owned");

        let unknown_option = encode_json(&json!([0, {"powerLimitW": 200}, {
            "profileApply": true, "expectedTarget": expected.clone(), "futureOption": true,
        }])).unwrap();
        assert!(native_apply_payload(&unknown_option).unwrap().is_none(), "unknown apply policy stays broker-owned");

        let unsupported = encode_json(&json!([0, {"vfCurveResetToDefault": true}, {"expectedTarget":expected.clone()}])).unwrap();
        assert!(native_apply_payload(&unsupported).unwrap().is_none(), "valid proof permits the compatibility broker route");

        let invalid_profile = encode_json(&json!([0, {"powerLimitW": 200}, {"profileApply": true,
            "expectedTarget":{"deviceKey":"gpu-a","physicalTarget":{}}}])).unwrap();
        assert!(native_apply_payload(&invalid_profile).is_err());

        let invalid = encode_json(&json!([0, {"powerLimitW": 200}, {"expectedTarget":{"deviceKey":"gpu-a","physicalTarget":{}}}])).unwrap();
        assert!(native_apply_payload(&invalid).is_err());
    }

    #[test]
    fn direct_vf_metadata_requires_an_isolated_curve_and_mixed_temperature_declines() {
        let expected = apply_target("pci:0x00008086:0x0000e20b@3:0.0", 3);
        let curve = json!([{"voltageV":0.8,"freqMhz":2000},{"voltageV":1.0,"freqMhz":2500}]);
        let args = |settings: Value| encode_json(&json!([0, settings, {"expectedTarget":expected.clone()}])).unwrap();
        for settings in [json!({"vfCurve":curve,"vfCurveBaseline":curve}),
            json!({"vfCurve":curve,"vfCurveResetToDefault":true})] {
            assert!(native_apply_payload(&args(settings)).unwrap().is_some());
        }
        let mixed_vf = args(json!({"vfCurve":curve,"vfCurveBaseline":curve,"powerLimitW":150}));
        assert!(native_apply_payload(&mixed_vf).unwrap().is_none());
        assert!(native_direct_apply_decline_reason(&mixed_vf).unwrap().contains("VF curve separately"));
        let mixed_temp = args(json!({"tempLimitC":80,"powerLimitW":150}));
        assert!(native_direct_apply_decline_reason(&mixed_temp).unwrap().contains("temperature limit separately"));
        let bad_baseline = args(json!({"vfCurve":curve,"vfCurveBaseline":[]}));
        assert!(native_apply_payload(&bad_baseline).unwrap().is_none());
    }

    #[test]
    fn profile_candidate_parses_native_vf_profiles_and_delegates_unsupported_metadata() {
        let expected = apply_target("pci:0x00008086:0x0000e20b@3:0.0", 3);
        let profile = |settings: Value| {
            encode_json(&json!([0, settings, {"profileApply": true, "expectedTarget": expected.clone()}])).unwrap()
        };
        let parsed = native_profile_apply_candidate(&profile(json!({
            "powerLimitW": 240, "gpuFreqOffsetMhz": 10,
            "fanMode": "curve", "fixedFanPct": null, "gpuLock": {"voltageV": 0.95, "freqMhz": 2400},
        }))).unwrap().unwrap();
        assert_eq!(parsed.device_id, 0);
        assert_eq!(parsed.expected_identity.device_key, "pci:0x00008086:0x0000e20b@3:0.0");
        assert!(parsed.settings.get("powerLimitW").is_some());
        // A profile carrying a temperature parses too; its caller must hold a
        // broker lease before the native body may run.
        let with_temperature = native_profile_apply_candidate(&profile(json!({
            "tempLimitC": 88, "powerLimitW": 240,
        }))).unwrap().unwrap();
        assert_eq!(with_temperature.settings.get("tempLimitC").and_then(Value::as_f64), Some(88.0));

        // Baseline metadata is admitted only far enough to receive an explicit
        // pre-write native refusal. Custom and stock-reference profiles use
        // the fresh STOCK validation below.
        for delegated in [
            json!({"vfCurveBaseline": []}),
            json!({}),
        ] {
            assert!(native_profile_apply_candidate(&profile(delegated)).unwrap().is_none(),
                "VF profiles and empty payloads keep the broker route");
        }
        // Malformed values stay delegated rather than guessed.
        assert!(native_profile_apply_candidate(&profile(json!({"fanMode": "turbo"}))).unwrap().is_none());
        assert!(native_profile_apply_candidate(&profile(json!({"powerLimitW": "240"}))).unwrap().is_none());
        assert!(native_profile_apply_candidate(&profile(json!({"tempLimitC": "88"}))).unwrap().is_none());
        assert!(native_profile_apply_candidate(&profile(json!({"vfCurveProfileStock": true}))).unwrap().is_some());
        let points = json!([
            {"voltageV":0.8,"freqMhz":2000},
            {"voltageV":1.0,"freqMhz":2500},
        ]);
        assert!(native_profile_apply_candidate(&profile(json!({"vfCurve": points}))).unwrap().is_some());
        assert!(native_profile_apply_candidate(&profile(json!({
            "vfCurve": points, "vfCurveStockReference": points,
        }))).unwrap().is_some(), "new saved custom profiles carry their STOCK reference");
        assert!(native_profile_apply_candidate(&profile(json!({"vfCurveResetToDefault": true}))).unwrap().is_none(),
            "reset intent without a curve must not silently no-op");
        assert!(native_profile_apply_candidate(&profile(json!({
            "vfCurveProfileStock": true, "gpuFreqOffsetMhz": 10,
        }))).unwrap().is_none(), "stock VF marker cannot accompany nonzero core offsets");
        assert!(native_profile_apply_candidate(&profile(json!({
            "vfCurveProfileStock": true,
            "vfCurve": [{"voltageV": 0.8, "freqMhz": 2000}, {"voltageV": 1.0, "freqMhz": 2500}],
        }))).unwrap().is_none(), "stock VF marker cannot accompany a custom curve");
        assert!(native_profile_apply_candidate(&profile(json!({
            "vfCurveProfileStock": true, "tempLimitC": 108,
        }))).unwrap().is_some(), "stock curve profiles may use the temperature refusal plan");
    }

    #[test]
    fn stock_vf_profile_requires_an_equivalent_final_curve_readback() {
        let settings = json!({"vfCurve": [
            {"voltageV": 0.8, "freqMhz": 2000},
            {"voltageV": 1.0, "freqMhz": 2500},
        ]});
        let exact = json!({"perControl":{"vfCurve":{"readBackCurve":[
            {"voltageV": 0.8, "freqMhz": 2000},
            {"voltageV": 1.0, "freqMhz": 2500},
        ]}}});
        let changed = json!({"perControl":{"vfCurve":{"readBackCurve":[
            {"voltageV": 0.8, "freqMhz": 2000},
            {"voltageV": 1.0, "freqMhz": 2490},
        ]}}});
        assert!(stock_vf_readback_matches(&settings, &exact));
        assert!(!stock_vf_readback_matches(&settings, &changed),
            "a valid but non-stock driver curve cannot report stock reset success");
    }

    #[test]
    fn stock_preflight_failure_finishes_mixed_temperature_profiles_without_poisoning_cache() {
        let failure = profile_vf_failure(
            &json!({"vfCurveProfileStock":true,"tempLimitC":88}),
            "readback-unverified",
            "The driver STOCK VF curve could not be read.",
            Value::Null,
        );
        assert_eq!(failure["result"]["perControl"]["vfCurve"]["ok"], false);
        assert_eq!(failure["result"]["perControl"]["tempLimitC"]["ok"], false);
        assert_eq!(failure["result"]["perControl"]["tempLimitC"]["errorCode"], "dependency-failed");
    }

    #[test]
    fn native_apply_transaction_candidate_admits_only_temperature_free_profiles() {
        let expected = apply_target("pci:0x00008086:0x0000e20b@3:0.0", 3);
        let encoded = |settings: Value, opts: Value| {
            encode_json(&json!([0, settings, opts])).unwrap()
        };
        // A temperature-free profile enters the plain native FIFO branch.
        assert!(native_apply_transaction_candidate(&encoded(
            json!({"powerLimitW": 240}),
            json!({"profileApply": true, "expectedTarget": expected.clone()}),
        )));
        // A temperature-bearing profile must not: its lease transaction owns
        // the shared coordinator while the body runs.
        assert!(!native_apply_transaction_candidate(&encoded(
            json!({"tempLimitC": 88}),
            json!({"profileApply": true, "expectedTarget": expected.clone()}),
        )));
        assert!(!native_apply_transaction_candidate(&encoded(
            json!({"tempLimitC": 88, "powerLimitW": 240}),
            json!({"profileApply": true, "expectedTarget": expected.clone()}),
        )));
        // Direct applies keep their existing admission.
        assert!(native_apply_transaction_candidate(&encoded(
            json!({"powerLimitW": 100}),
            json!({"expectedTarget": expected.clone()}),
        )));
        assert!(!native_apply_transaction_candidate(&encoded(
            json!({"tempLimitC": 85}),
            json!({"expectedTarget": expected}),
        )));
    }

    #[test]
    fn alchemist_temperature_profiles_keep_the_lease_separate_from_sysman_controls() {
        let key = "pci:0x00008086:0x000056a0@3:0.0";
        let expected = json!({"deviceKey":key,"physicalTarget":{
            "deviceKey":key,"pciVendorId":"0x00008086","pciDeviceId":"0x000056a0",
            "bdf":{"bus":3,"device":0,"function":0},"luid":"0x00000001:0x00000002"
        }});
        let encoded = |settings: Value| encode_json(&json!([0, settings, {
            "profileApply":true,"expectedTarget":expected.clone(),
        }])).unwrap();

        // A-series advanced temperature uses the Celsius V1/legacy lane. Its
        // lease owns the entire profile transaction even when other controls
        // will route through Sysman.
        for settings in [
            json!({"tempLimitC":105}),
            json!({"tempLimitC":105,"powerLimitW":350}),
            json!({"tempLimitC":105,"gpuVoltOffsetV":-0.05}),
            json!({"tempLimitC":105,"powerLimitW":350,"gpuVoltOffsetV":-0.05}),
        ] {
            let args = encoded(settings);
            assert!(!native_apply_transaction_candidate(&args),
                "temperature-bearing A-series profile must use the single lease transaction");
            let request = native_profile_apply_request(&args).unwrap().unwrap();
            assert!(request.requested_temperature.is_some());
        }

        // The same A-series Sysman power/voltage controls without temperature
        // retain the established plain native FIFO route.
        for settings in [
            json!({"powerLimitW":350}),
            json!({"gpuVoltOffsetV":-0.05}),
            json!({"powerLimitW":350,"gpuVoltOffsetV":-0.05}),
        ] {
            let args = encoded(settings);
            assert!(native_apply_transaction_candidate(&args),
                "temperature-free Sysman controls must remain on the plain native FIFO");
            assert_eq!(native_profile_apply_request(&args).unwrap().unwrap().requested_temperature, None);
        }
    }

    #[test]
    fn profile_request_exposes_the_temperature_lease_route() {
        let expected = apply_target("pci:0x00008086:0x0000e20b@3:0.0", 3);
        let mixed = encode_json(&json!([0, {"tempLimitC": 88, "powerLimitW": 240}, {
            "profileApply": true, "expectedTarget": expected.clone(),
        }])).unwrap();
        let request = native_profile_apply_request(&mixed).unwrap().unwrap();
        assert_eq!(request.device_id, 0);
        assert_eq!(request.device_key, "pci:0x00008086:0x0000e20b@3:0.0");
        assert_eq!(request.requested_temperature, Some(88.0));
        assert_eq!(request.settings, json!({"tempLimitC": 88, "powerLimitW": 240}));
        // A temperature-free profile never takes the lease route.
        let plain = encode_json(&json!([0, {"powerLimitW": 240}, {
            "profileApply": true, "expectedTarget": expected,
        }])).unwrap();
        assert_eq!(native_profile_apply_request(&plain).unwrap().unwrap().requested_temperature, None);
    }

    #[test]
    fn temperature_apply_stays_brokered_until_shared_cache_contract_is_complete() {
        let (root, store) = fixture();
        let expected = apply_target("pci:0x00008086:0x0000e20b@3:0.0", 3);
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        let missing_proof = encode_json(&json!([0, {"tempLimitC": 100}])).unwrap();
        assert!(native_apply_payload(&missing_proof).unwrap().is_none(), "absent proof delegates");
        for settings in [
            json!({"tempLimitC": 100}),
            json!({"tempLimitC": 100, "powerLimitW": 200}),
        ] {
            let encoded = encode_json(&json!([0, settings, {"expectedTarget":expected.clone()}])).unwrap();
            assert!(native_apply_payload(&encoded).unwrap().is_none(),
                "temperature cache synchronization and apply serialization remain broker-owned");
            assert!(invoke("apply-settings", &encoded, context(&store)).is_none(),
                "normal Tauri routing keeps temperature writes in the broker");
            assert!(invoke("apply-settings", &encoded, mock).is_none(),
                "mock apply behavior remains broker-owned");
        }
        let broker_profile = encode_json(&json!([0, {"tempLimitC": 100}, {
            "profileApply": true, "expectedTarget": expected,
        }])).unwrap();
        assert!(native_apply_payload(&broker_profile).unwrap().is_none(),
            "profile applies retain broker-side preparation");
        assert!(invoke("apply-settings", &broker_profile, context(&store)).is_none(),
            "profile temperature applies retain broker FIFO and refusal-cache publication");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn only_the_missing_fan_probe_cache_allows_proven_broker_fallback() {
        assert!(native_capability_error_deferable("fan probe verdict is not cached"));
        assert!(!native_capability_error_deferable("GPU identity changed during apply; refresh and try again"));
        assert!(!native_capability_error_deferable("IGCL failed"));
        assert!(!native_only_capabilities_fallback_allowed(BuildKind::Dev, "fan probe verdict is not cached"),
            "development keeps the broker's verified probe path");
        assert!(native_only_capabilities_fallback_allowed(BuildKind::Portable, "fan probe verdict is not cached"));
        assert!(native_only_capabilities_fallback_allowed(BuildKind::Installed, "fan probe verdict is not cached"));
        assert!(!native_only_capabilities_fallback_allowed(BuildKind::Installed, "IGCL failed"));
    }

    #[test]
    fn native_only_apply_uses_read_only_fan_caps_and_keeps_unrelated_errors_brokered() {
        assert!(native_only_capabilities_fallback_allowed(BuildKind::Installed, "fan probe verdict is not cached"));
        assert!(native_only_capabilities_fallback_allowed(BuildKind::Portable, "fan probe verdict is not cached"));
        assert!(!native_only_capabilities_fallback_allowed(BuildKind::Dev, "fan probe verdict is not cached"));
        assert!(!native_only_capabilities_fallback_allowed(BuildKind::Installed, "IGCL failed"));
    }

    #[test]
    fn saved_overclock_profile_refuses_only_v1_controls_when_runtime_is_unavailable() {
        // Read-only mirror of the user's saved Overclock payload. This pure
        // plan runs before any setter and mirrors Electron's mixed-profile
        // behavior when the bundled 2023 runtime is unavailable.
        let saved = json!({
            "powerLimitW": 260,
            "gpuVoltOffsetV": 30,
            "gpuFreqOffsetMhz": 150,
            "tempLimitC": 100,
            "vramFreqOffsetGts": 2400,
            "fanMode": "auto",
        });
        let unavailable_caps = json!({
            "extendedRanges": false,
            "extendedControls": {"powerLimitW": false, "tempLimitC": false},
            "ranges": {
                "powerLimitW": {"units":"W", "min":105, "max":315},
                "tempLimitC": {"units":"C", "min":50, "max":115},
            }
        });
        for local_mode in ["stock", "advanced"] {
            let (routed, refused) = native_profile_extended_unavailable_plan(&saved, &unavailable_caps, &json!({"powerLimitW":260,"tempLimitC":100}));
            assert_eq!(refused["powerLimitW"]["errorCode"], "unsupported", "{local_mode}");
            assert_eq!(refused["tempLimitC"]["errorCode"], "unsupported", "{local_mode}");
            assert_eq!(routed, json!({
                "gpuVoltOffsetV": 30,
                "gpuFreqOffsetMhz": 150,
                "vramFreqOffsetGts": 2400,
                "fanMode": "auto",
            }), "{local_mode}: compatible profile controls remain native-owned");
        }
        let available_caps = json!({
            "extendedRanges": true,
            "extendedControls": {"powerLimitW": true, "tempLimitC": true},
            "ranges": unavailable_caps["ranges"].clone(),
        });
        let (routed, refused) = native_profile_extended_unavailable_plan(&saved, &available_caps, &json!({"powerLimitW":260,"tempLimitC":100}));
        assert_eq!(routed, saved, "a capable runtime keeps every saved setting routed");
        assert!(refused.as_object().unwrap().is_empty());

    }

    #[test]
    fn unavailable_legacy_does_not_block_profile_values_within_driver_witness() {
        let requested = json!({"powerLimitW":247,"tempLimitC":90,"gpuFreqOffsetMhz":25});
        let raw = json!({"powerLimitW":{"units":"W","max":247},"tempLimitC":{"units":"C","max":90}});
        let caps = json!({"extendedRanges":false,"extendedControls":{"powerLimitW":false,"tempLimitC":false}});
        let (_, legacy) = super::super::apply_gates::split_profile_by_driver_witness(&requested, Some(&raw), false).unwrap();
        let (routed, refused) = native_profile_extended_unavailable_plan(&requested, &caps, &legacy);
        assert_eq!(routed, requested);
        assert_eq!(refused, json!({}));
        let above = json!({"powerLimitW":248,"tempLimitC":91,"gpuFreqOffsetMhz":25});
        let (_, legacy) = super::super::apply_gates::split_profile_by_driver_witness(&above, Some(&raw), false).unwrap();
        let (routed, refused) = native_profile_extended_unavailable_plan(&above, &caps, &legacy);
        assert_eq!(routed, json!({"gpuFreqOffsetMhz":25}));
        assert_eq!(refused["powerLimitW"]["errorCode"], "unsupported");
        assert_eq!(refused["tempLimitC"]["errorCode"], "unsupported");
    }

    #[test]
    fn temperature_lease_mode_is_compared_with_the_stored_mode_for_profiles() {
        assert!(temperature_lease_mode_matches_stored(Some("stock"), "stock"));
        assert!(!temperature_lease_mode_matches_stored(Some("advanced"), "stock"));
        assert!(temperature_lease_mode_matches_stored(None, "stock"));
    }

    #[test]
    fn temperature_lease_accepts_native_celsius_and_battlemage_percent_units() {
        let row = json!({
            "deviceKey":"pci:0x00008086:0x0000e20b@3:0.0",
            "pciVendorId":"0x00008086","pciDeviceId":"0x0000e20b",
            "bdf":{"bus":3,"device":0,"function":0},"luid":"0x00000001:0x00000002",
            "electronOrdinal":0
        });
        let expected = super::super::gpu_apply_identity::identity_from_row(&row).unwrap();
        let snapshot = |units: &str| encode_json(&json!({
            "type":"temperature-refusal-cache:begin","schemaVersion":1,
            "epoch":"0123456789abcdef0123456789abcdef","transactionSequence":1,
            "cacheGeneration":0,"target":row,
            "ranges":{"tempLimitC":{"units":units,"min":60,"max":100,"step":1}},
            "requestedSettings":{"tempLimitC":100},
            "cache":{"status":"available","ceilings":{"tempLimitC":null}},
            "ocMode":"stock"
        })).unwrap();
        let celsius = decode(&snapshot("C")).unwrap();
        let percent = decode(&snapshot("%")).unwrap();
        assert!(validate_temperature_lease_snapshot(&celsius, 0, &json!({"tempLimitC":100}), &expected).is_ok());
        assert!(validate_temperature_lease_snapshot(&percent, 0, &json!({"tempLimitC":100}), &expected).is_ok(),
            "Battlemage's IGCL temperature limit is reported as a percent-shaped control");
        let stale_unit_cache = encode_json(&json!({
            "type":"temperature-refusal-cache:begin","schemaVersion":1,
            "epoch":"0123456789abcdef0123456789abcdef","transactionSequence":1,
            "cacheGeneration":0,"target":row,
            "ranges":{"tempLimitC":{"units":"%","min":60,"max":100,"step":1}},
            "requestedSettings":{"tempLimitC":100},
            "cache":{"status":"available","ceilings":{"tempLimitC":90},"units":{"tempLimitC":"C"}},
            "ocMode":"stock"
        })).unwrap();
        let stale_result = validate_temperature_lease_snapshot(&decode(&stale_unit_cache).unwrap(), 0,
            &json!({"tempLimitC":100}), &expected);
        assert!(matches!(stale_result, Err(error) if error.contains("units changed")));
        assert!(temperature_ranges_compatible(
            Some(&json!({"units":"%","min":60,"max":100,"step":1})),
            &json!({"units":"%","min":60,"max":100,"step":1}),
        ));
        assert!(!temperature_ranges_compatible(
            Some(&json!({"units":"C","min":60,"max":100,"step":1})),
            &json!({"units":"%","min":60,"max":100,"step":1}),
        ), "equal numeric ranges with different units are never interchangeable");
        let unsupported = decode(&snapshot("F")).unwrap();
        assert!(validate_temperature_lease_snapshot(&unsupported, 0, &json!({"tempLimitC":100}), &expected).is_err());
    }

    #[test]
    fn pinned_apply_target_rejects_ordinal_reorder_before_capability_reads() {
        let expected_row = json!({"deviceKey":"pci:0x00008086:0x0000e20b@3:0.0",
            "pciVendorId":"0x00008086","pciDeviceId":"0x0000e20b",
            "bdf":{"bus":3,"device":0,"function":0},"luid":"0x00000001:0x00000002"});
        let expected = super::super::gpu_apply_identity::identity_from_row(&expected_row).unwrap();
        let reordered_at_ordinal = json!({"deviceKey":"pci:0x00008086:0x0000e20b@4:0.0",
            "pciVendorId":"0x00008086","pciDeviceId":"0x0000e20b",
            "bdf":{"bus":4,"device":0,"function":0},"luid":"0x00000001:0x00000003"});
        assert!(validate_apply_target_row(&reordered_at_ordinal, &expected).is_err());
        assert!(validate_apply_target_row(&expected_row, &expected).is_ok());
        assert_eq!(super::super::gpu_apply_identity::unique_target_index(
            &[reordered_at_ordinal.clone(), expected_row.clone()], &expected).unwrap(), 1);
    }
    #[test]
    #[ignore = "live native apply plumbing; empty payload, no writes"]
    fn live_native_apply_empty_payload_when_requested() {
        let (root, store) = fixture_mode("stock");
        let args = encode_json(&json!([0, {}])).unwrap();
        let reply = invoke("apply-settings", &args, context(&store)).expect("native path available")
            .expect("native apply reply");
        let value = decode(&reply).unwrap().into_json().unwrap();
        assert_eq!(value["result"]["ok"], true);
        assert!(value["state"].is_object());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn stream_channels_proxy_in_mock_mode() {
        let (root, store) = fixture();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        let empty = json!({"t":"array","v":[]});
        for channel in ["stream-status", "stream-scenes", "stream-connect", "stream-disconnect", "stream-start", "stream-stop", "stream-duck", "stream-duck-restore"] {
            assert!(invoke(channel, &empty, mock).is_none(), "{channel}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn apply_settings_is_native_and_fails_closed_before_any_deferral() {
        let (root, store) = fixture();
        let empty = json!({"t":"array","v":[]});
        // Mock sessions keep the compatibility broker route: that is the only
        // ownership this channel still shares with an unported command.
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        assert!(invoke("apply-settings", &empty, mock).is_none(),
            "mock runs stay broker-owned");
        // In a real run an absent renderer target proof no longer fails
        // closed; it delegates to the broker, which performs its own target
        // handling. Only a *present but malformed* proof refuses.
        assert!(invoke("apply-settings", &empty, context(&store)).is_none(),
            "absent proof delegates to the broker");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn driver_monitor_channels_are_native_and_defer_in_mock_mode() {
        let (root, store) = fixture();
        let empty = json!({"t":"array","v":[]});
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        for channel in ["driver-monitor-status", "driver-monitor-check"] {
            assert!(invoke(channel, &empty, mock).is_none(), "{channel}");
        }
        assert!(!root.join("driver-observations.json").exists(), "mock mode must not write the sidecar");
        for channel in ["driver-monitor-status", "driver-monitor-check"] {
            let error = invoke(channel, &encode_json(&json!([1])).unwrap(), context(&store)).unwrap().unwrap_err();
            assert_eq!(error, format!("{channel} takes no payload"));
        }

        let status = invoke("driver-monitor-status", &empty, context(&store)).unwrap().unwrap();
        let status = decode(&status).unwrap().into_json().unwrap();
        assert_eq!(status, json!({"schemaVersion":1,"observations":{},"transitions":{}}));

        crate::backend::driver_monitor::set_check_seam(json!([
            {"deviceKey":"pci:0x00008086:0x000056a0@3:0.0","driverVersion":"32.0.101.9030"}
        ]), Some("9-1-2026".to_owned()));
        let checked = invoke("driver-monitor-check", &empty, context(&store)).unwrap().unwrap();
        let checked = decode(&checked).unwrap().into_json().unwrap();
        assert_eq!(checked["observations"]["pci:0x00008086:0x000056a0@3:0.0"]["driverVersion"], "32.0.101.9030");
        assert_eq!(checked["observations"]["pci:0x00008086:0x000056a0@3:0.0"]["driverDate"], "9-1-2026");
        assert_eq!(checked["changes"], json!([]));
        assert!(root.join("driver-observations.json").is_file());
        let persisted = invoke("driver-monitor-status", &empty, context(&store)).unwrap().unwrap();
        let persisted = decode(&persisted).unwrap().into_json().unwrap();
        assert_eq!(persisted["observations"]["pci:0x00008086:0x000056a0@3:0.0"]["driverVersion"], "32.0.101.9030");
        // A changed version produces one native transition.
        crate::backend::driver_monitor::set_check_seam(json!([
            {"deviceKey":"pci:0x00008086:0x000056a0@3:0.0","driverVersion":"32.0.101.9031"}
        ]), Some("9-1-2026".to_owned()));
        let changed = invoke("driver-monitor-check", &empty, context(&store)).unwrap().unwrap();
        let changed = decode(&changed).unwrap().into_json().unwrap();
        assert_eq!(changed["changes"].as_array().unwrap().len(), 1);
        assert_eq!(changed["transitions"].as_object().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn intel_driver_read_only_channels_are_native_and_validate_arguments_exactly() {        let (root, store) = fixture();
        let empty = json!({"t":"array","v":[]});
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        for channel in ["intel-driver-update-check", "intel-driver-library", "intel-driver-release",
            "intel-driver-download-status", "intel-driver-download-page-open"] {
            assert!(invoke(channel, &empty, mock).is_none(), "{channel}");
        }
        let error = |channel: &str, payload: Value| {
            invoke(channel, &encode_json(&payload).unwrap(), context(&store)).unwrap().unwrap_err()
        };
        assert_eq!(error("intel-driver-update-check", json!([1])), "intel-driver-update-check takes no payload");
        assert_eq!(error("intel-driver-library", json!(["other"])), "intel-driver-library: invalid kind");
        assert_eq!(error("intel-driver-library", json!(["arc", "extra"])), "intel-driver-library takes one payload");
        assert_eq!(error("intel-driver-release", json!(["arc", "../escape"])), "intel-driver-release: invalid version");
        assert_eq!(error("intel-driver-release", json!(["other", "32.0.101.9030"])), "intel-driver-release: invalid kind");
        assert_eq!(error("intel-driver-release", json!(["arc", "32.0.101.9030", "extra"])), "intel-driver-release takes two payloads");
        assert_eq!(error("intel-driver-download-status", json!(["arc", "32.0.101"])), "intel-driver-download-status: invalid version");
        assert_eq!(error("intel-driver-download-status", json!(["arc", "32.0.101.9030", "extra"])), "intel-driver-download-status takes two payloads");
        assert_eq!(error("intel-driver-download-page-open", json!([])), "intel-driver-download-page-open: invalid kind");
        assert_eq!(error("intel-driver-download-page-open", json!(["arc", "bad"])), "intel-driver-download-page-open: invalid version");
        assert_eq!(error("intel-driver-download-page-open", json!(["arc", "32.0.101.9030", "extra"])), "intel-driver-download-page-open takes one or two payloads");

        let version = "32.0.101.9030";
        let status = invoke("intel-driver-download-status", &encode_json(&json!(["arc", version])).unwrap(), context(&store)).unwrap().unwrap();
        assert_eq!(decode(&status).unwrap().into_json().unwrap(), json!({"downloaded":false,"sizeBytes":null}));
        let target = root.join("DriverDownloads").join("arc").join(version).join("gfx_win_101.exe");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, [0x4d, 0x5a, 0, 0]).unwrap();
        let status = invoke("intel-driver-download-status", &encode_json(&json!(["arc", version])).unwrap(), context(&store)).unwrap().unwrap();
        assert_eq!(decode(&status).unwrap().into_json().unwrap(), json!({"downloaded":true,"sizeBytes":4}));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn intel_driver_download_channels_are_native_and_validate_arguments_exactly() {
        let (root, store) = fixture();
        let empty = json!({"t":"array","v":[]});
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        for channel in ["intel-driver-download-start", "intel-driver-download-cancel",
            "intel-driver-download-delete", "intel-driver-install"] {
            assert!(invoke(channel, &empty, mock).is_none(), "{channel}");
        }
        let error = |channel: &str, payload: Value| {
            invoke(channel, &encode_json(&payload).unwrap(), context(&store)).unwrap().unwrap_err()
        };
        assert_eq!(error("intel-driver-download-start", json!(["arc"])), "intel-driver-download-start: invalid version");
        assert_eq!(error("intel-driver-download-start", json!(["other", "32.0.101.9030", true])), "intel-driver-download-start: invalid kind");
        assert_eq!(error("intel-driver-download-start", json!(["arc", "32.0.101.9030", false])), "Intel license agreement must be explicitly accepted");
        assert_eq!(error("intel-driver-download-start", json!(["arc", "32.0.101.9030", true, "extra"])), "intel-driver-download-start takes three payloads");
        assert_eq!(error("intel-driver-download-cancel", json!([])), "intel-driver-download-cancel: invalid kind");
        assert_eq!(error("intel-driver-download-cancel", json!(["arc", "extra"])), "intel-driver-download-cancel takes one payload");
        assert_eq!(error("intel-driver-download-delete", json!(["arc", "../escape"])), "intel-driver-download-delete: invalid version");
        assert_eq!(error("intel-driver-download-delete", json!(["arc", "32.0.101.9030", "extra"])), "intel-driver-download-delete takes two payloads");
        assert_eq!(error("intel-driver-install", json!(["arc", "../escape"])), "intel-driver-install: invalid version");
        assert_eq!(error("intel-driver-install", json!(["arc", "32.0.101.9030", "extra"])), "intel-driver-install takes two payloads");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn display_channels_remain_broker_owned_in_mock_runs() {
        let (root, store) = fixture();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        // Mock runs remain Electron-owned. Supplying the new expected-key
        // argument must not enable native display reads in mock mode.
        assert!(invoke("display:get", &encode_json(&json!([0])).unwrap(), mock).is_none());
        assert!(invoke("display:get", &encode_json(&json!([0, "pci:gpu-a"])).unwrap(), mock).is_none());
        assert!(invoke("display:apply", &encode_json(&json!([0, {}])).unwrap(), mock).is_none());
        // The guard is irrelevant while the arm is absent, but it must not
        // admit an unelevated host either.
        assert!(!graphics_native_available(false, false));
        assert!(!root.join("settings.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn display_get_bridge_accepts_native_or_delegates_pre_mutation_declines() {
        let args = encode_json(&json!([2, "pci:gpu-a"])).unwrap();
        let payload = json!({"deviceKey":"pci:gpu-a", "adapterName":"Arc", "displays":[]});
        let mut calls = 0;

        assert!(route_display_get("display:get", &args, false, |_, _| {
            calls += 1;
            Ok(Some(payload.clone()))
        }).is_none());
        assert_eq!(calls, 0, "mock or unelevated routing must not touch the native seam");

        let no_expected_key = encode_json(&json!([2])).unwrap();
        assert_eq!(route_display_get("display:get", &no_expected_key, true, |_, _| {
            calls += 1;
            Ok(Some(payload.clone()))
        }), Some(Err("The selected graphics adapter identity is unavailable; refresh Display and try again.".into())));
        assert_eq!(calls, 0, "callers without physical identity must fail before native IO");

        let routed = route_display_get("display:get", &args, true, |device_id, key| {
            calls += 1;
            assert_eq!(device_id, 2);
            assert_eq!(key, "pci:gpu-a");
            Ok(Some(payload.clone()))
        });
        assert_eq!(calls, 1);
        assert_eq!(routed, Some(Ok(encode_json(&payload).unwrap())));

        // A keyed decline before reconciliation releases the native lock and
        // delegates; the broker now revalidates the same expected key under
        // its own Display lock.
        let mut declined = false;
        assert!(route_display_get("display:get", &args, true, |_, _| {
            declined = true;
            Ok(None)
        }).is_none());
        assert!(declined);
        // Reconciliation errors fail closed: do not hide an uncertain store
        // update by asking the broker to re-run the same read.
        assert_eq!(
            route_display_get("display:get", &args, true, |_, _| Err("reconciliation failed".into())),
            Some(Err("reconciliation failed".into())),
        );
        let stale_target = "The selected graphics adapter changed; refresh Display and try again.";
        assert_eq!(
            route_display_get("display:get", &args, true, |_, _| Err(stale_target.into())),
            Some(Err(stale_target.into())),
            "hard native errors are never downgraded into broker retries",
        );
        let runtime_unavailable = "The IGCL display runtime is unavailable.";
        assert_eq!(
            route_display_get("display:get", &args, true, |_, _| Err(runtime_unavailable.into())),
            Some(Err(runtime_unavailable.into())),
            "runtime errors from the native operation remain visible",
        );
    }

    #[test]
    fn display_get_args_validate_like_assert_valid_device_id() {
        let args = |payload: Value| encode_json(&payload).unwrap();
        assert_eq!(display_get_args("display:get", &args(json!([3]))).unwrap(), (3, None));
        assert_eq!(display_get_args("display:get", &args(json!([3, "pci:gpu-a"]))).unwrap(), (3, Some("pci:gpu-a".into())));
        // `invalid device id: ${JSON.stringify(v)}` for every non-id value.
        assert_eq!(display_get_args("display:get", &args(json!([-1]))).unwrap_err(), "invalid device id: -1");
        assert_eq!(display_get_args("display:get", &args(json!([1.5]))).unwrap_err(), "invalid device id: 1.5");
        assert_eq!(display_get_args("display:get", &args(json!(["0"]))).unwrap_err(), "invalid device id: \"0\"");
        assert_eq!(display_get_args("display:get", &args(json!([null]))).unwrap_err(), "invalid device id: null");
        assert_eq!(display_get_args("display:get", &args(json!([]))).unwrap_err(), "invalid device id: undefined");
        assert_eq!(display_get_args("display:get", &args(json!([0, 1]))).unwrap_err(), "invalid GPU target: expected device key must be a nonempty string");
        assert_eq!(display_get_args("display:get", &args(json!([0, "pci:gpu-a", "extra"]))).unwrap_err(), "display:get expects one device id and an optional expected device key");
    }

    #[test]
    fn display_get_outcomes_classify_the_attribution_line() {
        let args = encode_json(&json!([2, "pci:gpu-a"])).unwrap();
        // The documented pre-reconciliation decline: broker retries.
        let (outcome, summary, routed) = classify_display_get("display:get", &args, true, |_, _| Ok(None));
        assert_eq!(outcome, DisplayRouteOutcome::Declined("ownership"));
        assert_eq!(outcome.label(), "declined:ownership");
        assert!(routed.is_none(), "the label claims a fallback, so one must occur");
        // The summary is filled from the parse this call already did.
        assert_eq!(summary.device.as_deref(), Some("2"));
        assert_eq!(summary.device_key.as_deref(), Some("pci:gpu-a"));
        assert_eq!(summary.display_key, None);
        assert_eq!(
            display_get_line(&summary, outcome),
            "[display] get device=2 deviceKey=pci:gpu-a displayKey=n/a outcome=declined:ownership",
        );

        // Missing identity answers with an error; the broker never sees it, so
        // the label must not read as a decline.
        let no_expected_key = encode_json(&json!([2])).unwrap();
        let (outcome, _, routed) = classify_display_get("display:get", &no_expected_key, true, |_, _| Ok(None));
        assert_eq!(outcome.label(), "error:identity");
        assert!(routed.is_some_and(|routed| routed.is_err()), "an error answer is not a fallback");

        // An argument shape error is an error answer too.
        let invalid = encode_json(&json!([-1])).unwrap();
        let (outcome, _, routed) = classify_display_get("display:get", &invalid, true, |_, _| Ok(None));
        assert_eq!(outcome.label(), "error:shape");
        assert!(routed.is_some_and(|routed| routed.is_err()), "an error answer is not a fallback");

        let payload = json!({"deviceKey":"pci:gpu-a", "adapterName":"Arc", "displays":[]});
        let (outcome, _, routed) = classify_display_get("display:get", &args, true, |_, _| Ok(Some(payload.clone())));
        assert_eq!(outcome.label(), "native");
        assert_eq!(routed, Some(Ok(encode_json(&payload).unwrap())));

        // A payload the transport cannot encode is an error answer, never
        // `native`: the renderer receives the encode error.
        let mut deep = json!(1);
        for _ in 0..70 { deep = json!({"n": deep}); }
        let (outcome, _, routed) = classify_display_get("display:get", &args, true, |_, _| Ok(Some(deep.clone())));
        assert_eq!(outcome.label(), "error:encode");
        assert_eq!(routed, Some(encode_json(&deep)), "the error answer must be byte-identical");

        // A native error after reconciliation is never a broker retry.
        let (outcome, _, routed) = classify_display_get("display:get", &args, true, |_, _| Err("fail".into()));
        assert_eq!(outcome.label(), "error:fail-closed");
        assert_eq!(routed, Some(Err("fail".into())));
    }

    #[test]
    fn display_apply_outcomes_classify_the_attribution_line() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": format!("{device_key}|display|encoder-a|edid|abcd1234"),
            "patch": { "scalingMode": "centered" }
        }])).unwrap();

        // A pre-write decline never wrote: the broker safely retries.
        let (outcome, summary, routed) = classify_display_apply("display:apply", &args, true, |_, _, _, _| Ok(None));
        assert_eq!(outcome, DisplayRouteOutcome::Delegated("ownership"));
        assert_eq!(outcome.label(), "delegated:ownership");
        assert!(routed.is_none(), "the label claims a fallback, so one must occur");
        assert_eq!(summary.device.as_deref(), Some("4"));
        assert_eq!(summary.controls.as_deref(), Some("scalingMode"));

        let (outcome, _, routed) = classify_display_apply("display:apply", &args, true, |_, _, _, _| Err("fail".into()));
        assert_eq!(outcome.label(), "error:fail-closed");
        assert_eq!(routed, Some(Err("fail".into())), "an error answer is not a fallback");

        let payload = json!({"ok": true, "perControl": {}, "displayState": {}});
        let (outcome, _, routed) = classify_display_apply("display:apply", &args, true, |_, _, _, _| Ok(Some(payload.clone())));
        assert_eq!(outcome.label(), "native");
        assert_eq!(routed, Some(Ok(encode_json(&payload).unwrap())));

        // A payload with a key the transport refuses cannot encode: the native
        // apply succeeded, but the answer is an error, so the label says so.
        let unencodable = json!({"ok": true, "constructor": 1});
        let (outcome, _, routed) = classify_display_apply("display:apply", &args, true, |_, _, _, _| Ok(Some(unencodable.clone())));
        assert_eq!(outcome.label(), "error:encode");
        assert_eq!(routed, Some(encode_json(&unencodable)), "the error answer must be byte-identical");

        // A display key from another adapter is an identity decline.
        let foreign = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": "pci:other|display|encoder-a|edid|abcd1234",
            "patch": { "scalingMode": "centered" }
        }])).unwrap();
        let (outcome, _, routed) = classify_display_apply("display:apply", &foreign, true, |_, _, _, _| Ok(None));
        assert_eq!(outcome.label(), "delegated:identity");
        assert!(routed.is_none());
    }

    #[test]
    fn display_apply_log_line_carries_every_attributed_field() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "scalingMode": "stretched", "displayScalingMethod": "stretched" }
        }])).unwrap();
        let (outcome, summary, routed) =
            classify_display_apply("display:apply", &args, true, |_, _, _, _| Ok(None));
        assert!(routed.is_none());
        // The real logger path runs (never panics), and the whole line is
        // asserted: this is the check that would have caught the wire-form bug.
        log_display_apply(&summary, outcome);
        assert_eq!(
            display_apply_line(&summary, outcome),
            format!(
                "[display] apply device=4 deviceKey={device_key} displayKey={display_key} \
                 controls=scalingMode+displayScalingMethod outcome=delegated:ownership"
            ),
        );
    }

    #[test]
    fn display_log_summary_bounds_a_huge_patch_without_re_decoding() {
        // 1,000 control keys: the classifier keeps 16 and only counts the rest.
        let mut patch = Map::new();
        for index in 0..1_000 { patch.insert(format!("control{index}"), json!(true)); }
        let args = encode_json(&json!([4, {
            "deviceKey": "pci:gpu-a",
            "displayKey": "pci:gpu-a|display|encoder-a",
            "patch": patch,
        }])).unwrap();
        // Every key is unknown, so the plan declines before the native seam -
        // which must never be touched.
        let (outcome, summary, routed) = classify_display_apply(
            "display:apply", &args, true,
            |_, _, _, _| panic!("an unknown control must decline before native IO"),
        );
        assert_eq!(outcome.label(), "delegated:shape");
        assert!(routed.is_none());
        assert_eq!(summary.controls.as_deref(), Some("all(16)+984"));
        // The line builder takes only the summary: there is no request left to
        // re-decode, and the line stays bounded.
        let line = display_apply_line(&summary, outcome);
        assert!(line.ends_with("controls=all(16)+984 outcome=delegated:shape"));
        assert!(line.len() < 512, "the line stays bounded");
    }

    #[test]
    fn display_control_summary_names_requested_controls_in_execution_order() {
        let summary = |patch: Value| {
            let patch = patch;
            display_control_summary(patch.as_object().unwrap().keys().map(String::as_str))
        };
        assert_eq!(
            summary(json!({
                "scalingMode": "custom",
                "displayScalingMethod": "custom",
                "scalingCustom": {"x": 50, "y": 50}
            })).as_deref(),
            Some("scalingMode+displayScalingMethod"),
            "the Custom pair is a companion, not a control",
        );
        assert_eq!(
            summary(json!({"saturation": 1.2, "hue": 3.0})).as_deref(),
            Some("hue+saturation"),
            "the map's own key order is never the logged order",
        );
        assert_eq!(
            summary(json!({
                "quantizationRange": "full",
                "wireFormat": {"model": "RGB", "depth": 8},
                "hue": 1.0,
                "variableRefreshRate": true,
                "globalVrrMode": "disabled"
            })).as_deref(),
            Some("all(5)"),
            "a wide Apply-all request stays one short token",
        );
        assert_eq!(
            summary(json!({"replaceExistingColorSettings": true})).as_deref(),
            None,
            "the acknowledgement flag alone is not a control set",
        );
    }

    #[test]
    fn display_log_lines_escape_injected_control_characters() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let forged_device = format!("{device_key}\n[runtime] forged");
        let args = encode_json(&json!([4, {
            "deviceKey": forged_device,
            "displayKey": format!("{forged_device}|display|forged\t\u{7f}\r"),
            "patch": { "scalingMode": "centered" }
        }])).unwrap();
        let (outcome, summary, routed) =
            classify_display_apply("display:apply", &args, true, |_, _, _, _| Ok(None));
        assert!(routed.is_none());
        let line = display_apply_line(&summary, outcome);
        assert_eq!(line.lines().count(), 1, "a forged key must not start a second line");
        assert!(!line.contains('\n') && !line.contains('\r') && !line.contains('\t'));
        assert!(line.contains("\\n[runtime] forged"), "the newline is escaped, not dropped");
        assert!(line.contains("forged\\t\\u{7f}\\r"), "every control character is escaped");
        assert!(line.ends_with("outcome=delegated:ownership"));

        let get_args = encode_json(&json!([2, "pci:gpu-a\n[runtime] forged"])).unwrap();
        let (outcome, summary, _) =
            classify_display_get("display:get", &get_args, true, |_, _| Ok(None));
        let get_line = display_get_line(&summary, outcome);
        assert_eq!(get_line.lines().count(), 1, "the get line is one line too");
        assert!(get_line.contains("\\n[runtime] forged"));

        // The cap applies to the escaped text and never splits an escape.
        let control_key = "\n".repeat(200);
        let escaped_controls = display_log_text(&control_key);
        assert_eq!(escaped_controls.chars().count(), 96);
        assert_eq!(escaped_controls.matches("\\n").count(), 48);
        let long_key = "k".repeat(200);
        assert_eq!(display_log_text(&long_key).chars().count(), 96);
    }

    #[test]
    fn display_apply_bridge_routes_only_one_valid_retro_scaling_field() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "scalingMethod": { "enabled": true, "method": "nearest-neighbour" } }
        }])).unwrap();
        let response = json!({
            "ok": true,
            "perControl": { "scalingMethod": { "ok": true } },
            "displayState": { "deviceKey": device_key, "displays": [] },
        });
        let mut calls = 0;
        let routed = route_display_apply("display:apply", &args, true,
            |id, key, display, plan| {
                calls += 1;
                assert_eq!(id, 4);
                assert_eq!(key, device_key);
                assert_eq!(display, display_key);
                assert_eq!(plan.fields(), vec![NativeDisplayApplyField::RetroScaling(
                    super::super::display_retro_scaling_apply::RetroScalingWrite {
                        enabled: true,
                        method: super::super::display_retro_scaling_apply::RetroScalingMethod::NearestNeighbour,
                    }
                )]);
                Ok(Some(response.clone()))
            });
        assert_eq!(calls, 1);
        assert_eq!(routed, Some(Ok(encode_json(&response).unwrap())));
    }

    #[test]
    fn display_apply_bridge_routes_ordinary_scaling_mode_selections_natively() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        // The renderer's four verified ordinary shapes (graphics.ts
        // displayPayloadForControl): the raw flag alone, the GPU method alias,
        // and either of those plus the Retro disable companion.
        let shapes = [
            json!({ "scalingMode": "centered" }),
            json!({ "scalingMode": "stretched", "displayScalingMethod": "stretched" }),
            json!({
                "scalingMode": "identity",
                "displayScalingMethod": "maintain-display-scaling",
                "scalingMethod": { "enabled": false, "method": "nearest-neighbour" }
            }),
            json!({
                "scalingMode": "aspect-ratio-centered-max",
                "scalingMethod": { "enabled": false, "method": "integer" }
            }),
        ];
        for patch in shapes {
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": patch,
            }])).unwrap();
            let mut calls = 0;
            let routed = route_display_apply("display:apply", &args, true, |id, key, display, _| {
                calls += 1;
                assert_eq!((id, key, display), (4, device_key, display_key.as_str()));
                // A pre-write decline inside the native arm is a broker retry.
                Ok(None)
            });
            assert_eq!(calls, 1, "an ordinary Scaling Mode selection must route natively: {patch}");
            assert_eq!(routed, None);
        }
    }

    #[test]
    fn display_apply_bridge_routes_retro_entry_pair_as_one_adapter_transaction() {
        use super::super::display_retro_scaling_apply::{RetroScalingMethod, RetroScalingWrite};

        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let entry = json!({
            "scalingMode": "identity",
            "scalingMethod": { "enabled": true, "method": "integer" },
        });
        let cases = [
            (entry.clone(), false, false),
            (json!({
                "scalingMode": "identity",
                "displayScalingMethod": "nearest-neighbour",
                "scalingMethod": { "enabled": true, "method": "nearest-neighbour" },
            }), true, false),
            (json!({
                "quantizationRange": "full",
                "scalingMode": "identity",
                "scalingMethod": { "enabled": true, "method": "integer" },
                "hue": 12,
            }), false, true),
        ];
        for (patch, has_method_alias, composed) in cases {
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": patch,
            }])).unwrap();
            let mut calls = 0;
            let routed = route_display_apply("display:apply", &args, true,
                |id, key, display, plan| {
                    calls += 1;
                    assert_eq!((id, key, display), (4, device_key, display_key.as_str()));
                    let fields = plan.fields();
                    let entry_field = fields.iter().find(|field|
                        matches!(field, NativeDisplayApplyField::RetroScalingEntry { .. }))
                        .expect("the entry pair is one native Retro step");
                    assert_eq!(*entry_field, NativeDisplayApplyField::RetroScalingEntry {
                        write: RetroScalingWrite {
                            enabled: true,
                            method: if has_method_alias { RetroScalingMethod::NearestNeighbour }
                                else { RetroScalingMethod::Integer },
                        },
                        has_method_alias,
                    });
                    assert!(plan.control_keys().contains(&"scalingMethod"));
                    if has_method_alias {
                        assert!(plan.control_keys().contains(&"displayScalingMethod"));
                        assert!(plan.control_keys().contains(&"scalingMode"));
                    } else {
                        assert!(!plan.control_keys().contains(&"scalingMode"));
                    }
                    assert!(!fields.iter().any(|field|
                        matches!(field, NativeDisplayApplyField::ScalingMode(_))),
                        "Electron mirrors identity and does not call the raw scaling setter");
                    if composed {
                        assert_eq!(fields.get(1), Some(entry_field),
                            "the entry write follows earlier controls and occupies the renderer's scaling slot");
                        assert!(matches!(fields.first(), Some(NativeDisplayApplyField::QuantizationRange(2))));
                        assert!(matches!(fields.last(), Some(NativeDisplayApplyField::Color(_))));
                    } else {
                        assert_eq!(fields, vec![*entry_field]);
                    }
                    Ok(None)
                });
            assert_eq!(calls, 1, "the complete UI entry request routes as one native plan: {patch}");
            assert_eq!(routed, None);
        }
    }

    #[test]
    fn retro_entry_response_mirrors_the_single_retro_result_like_electron() {
        use super::super::display_retro_scaling_apply::{
            RetroScalingApplyResult, RetroScalingMethod, RetroScalingObservation,
        };

        let applied = RetroScalingApplyResult {
            ok: true,
            error_code: None,
            message: None,
            read_back: Some(RetroScalingObservation {
                enabled: true,
                method: Some(RetroScalingMethod::Integer),
            }),
            read_back_equal: true,
            silent_noop: Some(false),
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: false,
        };
        for has_method_alias in [false, true] {
            let controls = retro_scaling_entry_per_control(&applied, has_method_alias);
            assert_eq!(controls["scalingMethod"]["ok"], json!(true));
            assert_eq!(controls.contains_key("displayScalingMethod"), has_method_alias);
            if has_method_alias {
                assert_eq!(controls["scalingMode"]["ok"], json!(true));
                assert_eq!(controls["scalingMode"]["internal"], json!(true));
                assert_eq!(controls["displayScalingMethod"]["internal"], json!(true));
                assert_eq!(controls["displayScalingMethod"]["readBackEqual"], json!(true));
            } else {
                assert!(!controls.contains_key("scalingMode"),
                    "the renderer's alias-free entry shape has no scalingMode result in Electron");
            }
        }

        let failed_after_foreign_write = RetroScalingApplyResult {
            ok: false,
            error_code: Some("io-failed"),
            message: Some("current state may belong to another writer".into()),
            read_back: Some(RetroScalingObservation {
                enabled: true,
                method: Some(RetroScalingMethod::NearestNeighbour),
            }),
            read_back_equal: false,
            silent_noop: Some(false),
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: true,
        };
        let controls = retro_scaling_entry_per_control(&failed_after_foreign_write, false);
        assert_eq!(controls["scalingMethod"]["ok"], json!(false));
        assert!(!controls.contains_key("scalingMode"));
        let controls = retro_scaling_entry_per_control(&failed_after_foreign_write, true);
        assert_eq!(controls["scalingMode"]["ok"], json!(false));
        assert_eq!(controls["scalingMode"]["internal"], json!(true));
        assert_eq!(controls["scalingMode"]["message"], json!("current state may belong to another writer"));
    }

    #[test]
    fn display_apply_bridge_routes_custom_scaling_pairs_natively() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        // The renderer's Custom shape (graphics.ts:2282, :2308): the raw flag
        // and the remembered pair always travel together, with the IGS
        // hardware-modeset acknowledgement. The optional alias is the same
        // coupled selection Electron validates in scalingAliasPayloadError.
        let shapes = [
            (json!({ "scalingMode": "custom", "scalingCustom": { "x": 80, "y": 70, "hardwareModeSet": true } }), (80, 70), false, false),
            (json!({ "scalingMode": "custom", "scalingCustom": { "x": 100, "y": 100 } }), (100, 100), false, false),
            (json!({
                "scalingMode": "custom",
                "displayScalingMethod": "custom",
                "scalingCustom": { "x": 35, "y": 90, "hardwareModeSet": true }
            }), (35, 90), true, false),
            (json!({
                "scalingMode": "custom",
                "scalingCustom": { "x": 80, "y": 70 },
                "scalingMethod": { "enabled": false, "method": "integer" }
            }), (80, 70), false, true),
        ];
        for (patch, pair, has_method_alias, has_retro_disable) in shapes {
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": patch,
            }])).unwrap();
            let mut calls = 0;
            let routed = route_display_apply("display:apply", &args, true, |id, key, display, field| {
                calls += 1;
                assert_eq!((id, key, display), (4, device_key, display_key.as_str()));
                // A Custom pair routes as the one Scaling Mode step of its plan.
                assert_eq!(field.fields().len(), 1, "a Custom pair is one control: {patch}");
                let NativeDisplayApplyField::ScalingMode(requested) = field.fields()[0] else {
                    panic!("a Custom pair must route as a scaling mode: {patch}");
                };
                assert_eq!(requested.scaling_type, 16);
                assert_eq!(requested.custom, Some(pair));
                assert_eq!(requested.has_method_alias, has_method_alias);
                assert_eq!(requested.retro_disable.is_some(), has_retro_disable);
                Ok(None)
            });
            assert_eq!(calls, 1, "a Custom pair must route natively: {patch}");
            assert_eq!(routed, None);
        }
    }

    #[test]
    fn display_apply_bridge_keeps_custom_and_unowned_scaling_keys_broker_owned() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let declined = [
            // A pairless Custom request stays broker-owned: Electron derives
            // the retained pair itself (`igcl-display-scaling.js:113-119`).
            json!({ "scalingMode": "custom" }),
            // Coordinates never travel alone; the renderer always pairs them
            // with `scalingMode: 'custom'` (graphics.ts:2282, :2308).
            json!({ "scalingCustom": { "x": 80, "y": 70, "hardwareModeSet": true } }),
            // Coordinates with any other raw mode are Electron's to refuse.
            json!({ "scalingMode": "centered", "scalingCustom": { "x": 80, "y": 70 } }),
            json!({ "scalingMode": "identity", "scalingCustom": { "x": 80, "y": 70 } }),
            // Out-of-range or mistyped coordinates are Electron's own
            // validation paths (`ipc-core.js:428-435`).
            json!({ "scalingMode": "custom", "scalingCustom": { "x": 101, "y": 70 } }),
            json!({ "scalingMode": "custom", "scalingCustom": { "x": 80.5, "y": 70 } }),
            json!({ "scalingMode": "custom", "scalingCustom": { "x": "80", "y": 70 } }),
            json!({ "scalingMode": "custom", "scalingCustom": { "x": 80, "y": 70, "hardwareModeSet": "yes" } }),
            // The native write couples hardware-mode to type 16, so an explicit
            // `false` cannot be represented here.
            json!({ "scalingMode": "custom", "scalingCustom": { "x": 80, "y": 70, "hardwareModeSet": false } }),
            json!({ "scalingMode": "custom", "scalingCustom": { "x": 80, "y": 70, "extra": true } }),
            // An alias that disagrees with the raw flag is Electron-owned.
            json!({ "scalingMode": "centered", "displayScalingMethod": "custom" }),
            json!({ "scalingMode": "custom", "displayScalingMethod": "centered", "scalingCustom": { "x": 80, "y": 70 } }),
            json!({ "scalingMode": "centered", "displayScalingMethod": "stretched" }),
            // An enabled Retro method only couples to the raw identity entry.
            json!({ "scalingMode": "centered", "scalingMethod": { "enabled": true, "method": "integer" } }),
            json!({ "scalingMode": "identity", "scalingMethod": { "enabled": true, "method": "integer", "extra": true } }),
            json!({ "scalingMode": "identity", "displayScalingMethod": "nearest-neighbour", "scalingMethod": { "enabled": true, "method": "integer" } }),
            // Unknown raw name / disable method.
            json!({ "scalingMode": "bogus" }),
            json!({ "scalingMode": "centered", "scalingMethod": { "enabled": false, "method": "bogus" } }),
        ];
        for patch in declined {
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": patch,
            }])).unwrap();
            let mut calls = 0;
            assert!(route_display_apply("display:apply", &args, true, |_, _, _, _| {
                calls += 1;
                Ok(Some(json!({ "unexpected": true })))
            }).is_none(), "the whole request must decline before any native write: {patch}");
            assert_eq!(calls, 0, "no native arm may run for a broker-owned shape: {patch}");
        }
        // Control row: the Custom boundary must not swallow ordinary modes.
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "scalingMode": "custom" },
        }])).unwrap();
        assert!(route_display_apply("display:apply", &args, true, |_, _, _, _| Ok(None)).is_none());
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "scalingMode": "centered" },
        }])).unwrap();
        let mut calls = 0;
        assert!(route_display_apply("display:apply", &args, true, |_, _, _, _| {
            calls += 1;
            Ok(None)
        }).is_none());
        assert_eq!(calls, 1, "the Custom boundary must not swallow ordinary Scaling Mode");
    }

    #[test]
    fn display_apply_bridge_routes_color_patches_natively() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        // Every verified renderer color shape: a single control, a pair, all
        // four, and the acknowledgement flag (which is not a control).
        let shapes = [
            json!({ "hue": 12 }),
            json!({ "hue": 12, "saturation": 1.2 }),
            json!({ "brightness": -8 }),
            json!({ "contrast": 0.9, "replaceExistingColorSettings": true }),
            json!({ "hue": 12, "saturation": 1.2, "brightness": -8, "contrast": 0.9 }),
            json!({ "hue": 12, "replaceExistingColorSettings": false }),
        ];
        for patch in shapes {
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": patch.clone(),
            }])).unwrap();
            let mut calls = 0;
            let routed = route_display_apply("display:apply", &args, true, |id, key, display, field| {
                calls += 1;
                assert_eq!((id, key, display), (4, device_key, display_key.as_str()));
                assert_eq!(field.fields().len(), 1, "the colour patch is one control group set: {patch}");
                let NativeDisplayApplyField::Color(requested) = field.fields()[0] else {
                    panic!("a color patch must route as a color field: {patch}");
                };
                assert_eq!(requested.replace_existing, patch.get("replaceExistingColorSettings") == Some(&json!(true)));
                // The acknowledgement flag is never a control key.
                assert_eq!(requested.requested_keys().count(),
                    patch.as_object().unwrap().keys().filter(|key| *key != "replaceExistingColorSettings").count());
                Ok(None)
            });
            assert_eq!(calls, 1, "a color patch must route natively: {patch}");
            assert_eq!(routed, None);
        }
    }

    #[test]
    fn display_apply_bridge_keeps_unowned_color_shapes_broker_owned() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let declined = [
            // The acknowledgement flag alone is not a control and must never
            // reach a native seam.
            json!({ "replaceExistingColorSettings": true }),
            // An acknowledgement beside a non-colour control stays broker-owned:
            // the flag never becomes a control of its own.
            json!({ "replaceExistingColorSettings": true, "quantizationRange": "full" }),
            // Foreign keys and shapes Electron answers itself.
            json!({ "hue": 12, "superResolution": true }),
            json!({ "hue": 12, "aurora": true }),
            // Electron's own out-of-range path needs a string, not a number.
            json!({ "hue": "12" }),
            json!({ "hue": 12, "replaceExistingColorSettings": "yes" }),
        ];
        for patch in declined {
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": patch,
            }])).unwrap();
            let mut calls = 0;
            assert!(route_display_apply("display:apply", &args, true, |_, _, _, _| {
                calls += 1;
                Ok(Some(json!({ "unexpected": true })))
            }).is_none(), "the whole request must decline before any native write: {patch}");
            assert_eq!(calls, 0, "no native arm may run for a broker-owned shape: {patch}");
        }
    }

    #[test]
    fn color_per_control_matches_electron_and_omits_absent_optionals() {
        use super::super::display_color_apply::{
            DisplayColorApplyOutcome, DisplayColorApplyResult, DisplayColorGroup, DisplayColorPatch,
        };
        let requested = DisplayColorPatch {
            hue: Some(12.0), saturation: Some(1.2), brightness: Some(-8.0), contrast: Some(0.9),
            replace_existing: true,
        };
        let accepted = |values| DisplayColorApplyResult {
            ok: true, error_code: None,
            message: Some(super::super::display_color_apply::DISPLAY_COLOR_SENT_MESSAGE.to_owned()),
            requested: Some(values), readback_unavailable: true, intent_saved: true,
            state_may_have_changed: false,
        };
        let applied = DisplayColorApplyOutcome { groups: vec![
            (DisplayColorGroup::HueSaturation, accepted((12.0, 1.2))),
            (DisplayColorGroup::BrightnessContrast, accepted((-8.0, 0.9))),
        ] };
        let per_control = display_color_per_control(&requested, &applied);
        assert_eq!(per_control.len(), 4, "one entry per requested control");
        assert_eq!(per_control.keys().map(String::as_str).collect::<Vec<_>>(),
            vec!["hue", "saturation", "brightness", "contrast"]);
        assert!(!per_control.contains_key(super::DISPLAY_COLOR_FLAG),
            "the acknowledgement flag is never a perControl entry");
        for key in ["hue", "saturation", "brightness", "contrast"] {
            let entry = &per_control[key];
            assert_eq!(entry["ok"], json!(true));
            assert_eq!(entry["verification"], json!("readback-unavailable"));
            assert_eq!(entry["message"], json!(
                "The driver accepted the color settings. Values shown are saved by Arc Power; current-value read-back is unavailable."));
            assert!(entry.get("errorCode").is_none(), "{key} must omit absent optionals");
        }
        assert!(per_control.values().all(|entry| !entry.is_null()), "no null placeholders");

        // A refused group reports every one of its requested controls, and only
        // those controls, with Electron's error envelope.
        let requested = DisplayColorPatch { hue: Some(12.0), contrast: Some(0.9), ..DisplayColorPatch::default() };
        let refused = DisplayColorApplyOutcome { groups: vec![
            (DisplayColorGroup::HueSaturation, DisplayColorApplyResult::failed(
                "unsupported", super::super::display_color_apply::DISPLAY_COLOR_REPLACE_REQUIRED_MESSAGE)),
            (DisplayColorGroup::BrightnessContrast, DisplayColorApplyResult::failed(
                "io-failed", "The driver rejected the display color settings.")),
        ] };
        let per_control = display_color_per_control(&requested, &refused);
        assert_eq!(per_control.keys().map(String::as_str).collect::<Vec<_>>(), vec!["hue", "contrast"]);
        assert_eq!(per_control["hue"], json!({
            "ok": false,
            "errorCode": "unsupported",
            "message": "Use Apply Arc Power settings to replace the corresponding IGS adjustments with Arc Power settings.",
        }));
        assert_eq!(per_control["contrast"]["errorCode"], json!("io-failed"));
        assert!(per_control["hue"].get("verification").is_none(), "a refusal never claims read-back");
    }

    #[test]
    fn display_apply_bridge_maps_every_ordinary_scaling_mode_name() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        for (name, scaling_type) in [
            ("identity", 1),
            ("centered", 2),
            ("stretched", 4),
            ("aspect-ratio-centered-max", 8),
        ] {
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": { "scalingMode": name },
            }])).unwrap();
            let routed = route_display_apply("display:apply", &args, true, |_, _, _, plan| {
                assert_eq!(plan.fields(), vec![NativeDisplayApplyField::ScalingMode(
                    super::super::display_scaling_apply::DisplayScalingPatch {
                        scaling_type,
                        custom: None,
                        has_method_alias: false,
                        retro_disable: None,
                    }
                )]);
                Ok(Some(json!({ "ok": true })))
            });
            assert!(routed.is_some(), "{name} must route natively");
        }
    }

    #[test]
    fn display_apply_bridge_maps_the_coupled_retro_exit_companion() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": {
                "scalingMode": "identity",
                "displayScalingMethod": "maintain-display-scaling",
                "scalingMethod": { "enabled": false, "method": "nearest-neighbour" },
            },
        }])).unwrap();
        let routed = route_display_apply("display:apply", &args, true, |_, _, _, plan| {
            // A request made only of the Scaling Mode group keeps the shipped
            // single transaction: the disable pair is that transaction's
            // companion, never a second step (P2/P4 unchanged).
            assert_eq!(plan.fields(), vec![
                NativeDisplayApplyField::ScalingMode(
                    super::super::display_scaling_apply::DisplayScalingPatch {
                        scaling_type: 1,
                        custom: None,
                        has_method_alias: true,
                        retro_disable: Some(
                            super::super::display_retro_scaling_apply::RetroScalingMethod::NearestNeighbour,
                        ),
                    }
                ),
            ]);
            Ok(Some(json!({ "ok": true })))
        });
        assert!(routed.is_some());
    }

    #[test]
    fn scaling_mode_envelope_matches_electron_and_omits_absent_optionals() {
        let accepted = scaling_mode_apply_result();
        let per_control = display_scaling_mode_per_control(&accepted, 2);
        assert_eq!(per_control["ok"], json!(true));
        assert_eq!(per_control["readBackEqual"], json!(true));
        assert_eq!(per_control["activeReadBackEqual"], json!(true));
        assert_eq!(per_control["preferredReadBackEqual"], json!(true));
        assert_eq!(per_control["deferred"], json!(false));
        assert_eq!(per_control["verification"], json!("native-active"));
        assert_eq!(per_control["selectionSaved"], json!(true));
        assert_eq!(per_control["warning"], json!(DISPLAY_SCALING_FLASH_WARNING));
        assert_eq!(per_control["silentNoop"], json!(false));
        for absent in ["errorCode", "message", "nativePreferenceRestoreOk", "retroRestoreOk"] {
            assert!(!per_control.contains_key(absent), "{absent} must be omitted, never null");
        }
        assert!(per_control.values().all(|value| !value.is_null()), "no null placeholders");

        // A driver-deferred GPU preference is verified by its preferred tuple.
        let mut deferred = scaling_mode_apply_result();
        deferred.scaling.active_read_back_equal = false;
        deferred.scaling.deferred = true;
        let per_control = display_scaling_mode_per_control(&deferred, 4);
        assert_eq!(per_control["verification"], json!("native-preference"));
        assert_eq!(per_control["deferred"], json!(true));
        assert_eq!(per_control["message"], json!(DEFERRED_GPU_SCALING_MESSAGE));

        // Display Scaling names Electron's separate persisted selection.
        let per_control = display_scaling_mode_per_control(&scaling_mode_apply_result(), 1);
        assert_eq!(per_control["message"], json!(IDENTITY_SCALING_MESSAGE));
    }

    #[test]
    fn scaling_mode_refusal_envelope_has_no_set_boundary_fields() {
        use super::super::display_scaling_apply::DisplayScalingModeApplyResult;

        let refused = DisplayScalingModeApplyResult::failed(
            "unsupported", super::super::display_scaling_apply::RETRO_SCALING_ACTIVE_REFUSAL,
        );
        let per_control = display_scaling_mode_per_control(&refused, 2);
        assert_eq!(per_control["ok"], json!(false));
        assert_eq!(per_control["errorCode"], json!("unsupported"));
        assert_eq!(
            per_control["message"],
            json!(super::super::display_scaling_apply::RETRO_SCALING_ACTIVE_REFUSAL)
        );
        assert_eq!(per_control["readBackEqual"], json!(false));
        assert_eq!(per_control["deferred"], json!(false));
        assert_eq!(per_control["verification"], json!("unverified"));
        for absent in ["silentNoop", "selectionSaved", "warning", "retroRestoreOk"] {
            assert!(!per_control.contains_key(absent), "{absent} must be omitted");
        }

        // A successful SET with an unverified read-back is a silent no-op.
        let mut noop = scaling_mode_apply_result();
        noop.scaling.ok = false;
        noop.scaling.error_code = Some("io-failed");
        noop.scaling.message = Some("display scaling read-back did not verify requested type 2".into());
        noop.scaling.read_back_equal = false;
        noop.scaling.active_read_back_equal = false;
        noop.scaling.preferred_read_back_equal = false;
        noop.scaling.driver_apply_succeeded = false;
        noop.scaling.selection_saved = false;
        let per_control = display_scaling_mode_per_control(&noop, 2);
        assert_eq!(per_control["silentNoop"], json!(true));
        assert_eq!(per_control["readBackEqual"], json!(false));

        // A first-time Custom entry whose neutral initialization did not verify
        // stops before the requested pair's SET. The rollback is reported, but
        // the entry must not claim the requested selection was a silent no-op.
        let mut uninitialized = scaling_mode_apply_result();
        uninitialized.scaling.ok = false;
        uninitialized.scaling.error_code = Some("io-failed");
        uninitialized.scaling.message =
            Some("IGCL neutral custom scaling initialization did not verify".into());
        uninitialized.scaling.setter_succeeded = Some(true);
        uninitialized.scaling.requested_set = None;
        uninitialized.scaling.driver_apply_succeeded = false;
        uninitialized.scaling.read_back_equal = false;
        uninitialized.scaling.active_read_back_equal = false;
        uninitialized.scaling.preferred_read_back_equal = false;
        uninitialized.scaling.selection_saved = false;
        uninitialized.scaling.rollback_attempted = true;
        uninitialized.scaling.rollback_verified = true;
        let per_control = display_scaling_mode_per_control(&uninitialized, 16);
        assert!(!per_control.contains_key("silentNoop"),
            "the requested pair was never SET, so there is no silent no-op to report");
        assert_eq!(per_control["nativePreferenceRestoreOk"], json!(true));
        assert_eq!(per_control["verification"], json!("unverified"));
        assert_eq!(per_control["deferred"], json!(false));
        assert!(!per_control.contains_key("selectionSaved"));
        assert!(per_control.values().all(|value| !value.is_null()), "no null placeholders");

        // A first-time Custom entry whose initialization SET was accepted but
        // whose read-back is unavailable: no witness, therefore no rollback
        // write and no restoration claim. This is the exact per-control surface
        // the renderer shows for that failure.
        let mut unwitnessed = scaling_mode_apply_result();
        unwitnessed.scaling.ok = false;
        unwitnessed.scaling.error_code = Some("io-failed");
        unwitnessed.scaling.message = Some(
            "display scaling custom initialization read-back failed: display scaling GET failed: simulated post-SET read-back GET failure; no rollback was written".into());
        unwitnessed.scaling.read_back = None;
        unwitnessed.scaling.read_back_equal = false;
        unwitnessed.scaling.active_read_back_equal = false;
        unwitnessed.scaling.preferred_read_back_equal = false;
        unwitnessed.scaling.readback_reported = false;
        unwitnessed.scaling.driver_apply_succeeded = false;
        unwitnessed.scaling.setter_succeeded = Some(true);
        unwitnessed.scaling.requested_set = None;
        unwitnessed.scaling.deferred = false;
        unwitnessed.scaling.rollback_attempted = false;
        unwitnessed.scaling.rollback_verified = false;
        unwitnessed.scaling.state_may_have_changed = true;
        unwitnessed.scaling.selection_saved = false;
        let per_control = display_scaling_mode_per_control(&unwitnessed, 16);
        assert_eq!(per_control["ok"], json!(false));
        assert_eq!(per_control["errorCode"], json!("io-failed"));
        assert_eq!(per_control["readBackEqual"], json!(false));
        assert_eq!(per_control["activeReadBackEqual"], json!(false));
        assert_eq!(per_control["preferredReadBackEqual"], json!(false));
        assert_eq!(per_control["deferred"], json!(false));
        assert_eq!(per_control["verification"], json!("unverified"));
        for absent in ["selectionSaved", "warning", "silentNoop", "nativePreferenceRestoreOk", "retroRestoreOk"] {
            assert!(!per_control.contains_key(absent),
                "{absent} must be omitted when no read-back witness exists");
        }
        assert_eq!(
            per_control["message"],
            json!("display scaling custom initialization read-back failed: display scaling GET failed: simulated post-SET read-back GET failure; no rollback was written"),
        );
        assert!(per_control.values().all(|value| !value.is_null()), "no null placeholders");

        // A first-time Custom entry whose read-back proves a tuple this
        // transaction did not write (an external writer moved the mode). The
        // state is foreign, so no rollback is written and nothing claims a
        // restoration. This is the exact per-control surface for that failure.
        let mut foreign = scaling_mode_apply_result();
        foreign.scaling.ok = false;
        foreign.scaling.error_code = Some("io-failed");
        foreign.scaling.message = Some(
            "the display scaling state changed to a tuple this transaction did not set (enabled=true, type=2, custom=100x100, preferred=Some(2)) after the neutral Custom initialization; no rollback was written".into());
        foreign.scaling.read_back = None;
        foreign.scaling.read_back_equal = false;
        foreign.scaling.active_read_back_equal = false;
        foreign.scaling.preferred_read_back_equal = false;
        foreign.scaling.readback_reported = false;
        foreign.scaling.driver_apply_succeeded = false;
        foreign.scaling.setter_succeeded = Some(true);
        foreign.scaling.requested_set = None;
        foreign.scaling.deferred = false;
        foreign.scaling.rollback_attempted = false;
        foreign.scaling.rollback_verified = false;
        foreign.scaling.state_may_have_changed = true;
        foreign.scaling.selection_saved = false;
        let per_control = display_scaling_mode_per_control(&foreign, 16);
        assert_eq!(per_control["ok"], json!(false));
        assert_eq!(per_control["errorCode"], json!("io-failed"));
        assert_eq!(per_control["verification"], json!("unverified"));
        assert_eq!(per_control["readBackEqual"], json!(false));
        assert_eq!(per_control["deferred"], json!(false));
        for absent in ["selectionSaved", "warning", "silentNoop", "nativePreferenceRestoreOk", "retroRestoreOk"] {
            assert!(!per_control.contains_key(absent),
                "{absent} must be omitted for a foreign read-back too");
        }
        assert!(per_control["message"].as_str().unwrap_or_default().contains("did not set"));
        assert!(per_control.values().all(|value| !value.is_null()), "no null placeholders");
    }

    #[test]
    fn retro_restore_entries_match_electron_internal_shape() {
        let restored = retro_restore_per_control(Some(true)).unwrap();
        assert_eq!(restored["internal"], json!(true));
        assert_eq!(restored["ok"], json!(false));
        assert_eq!(restored["errorCode"], json!("io-failed"));
        assert_eq!(restored["readBackEqual"], json!(false));
        assert_eq!(restored["message"], json!(RETRO_SCALING_RESTORED_MESSAGE));

        let mut failed_restore = scaling_mode_apply_result();
        failed_restore.scaling.ok = false;
        failed_restore.scaling.error_code = Some("io-failed");
        failed_restore.scaling.message = Some("display scaling setter failed".into());
        failed_restore.scaling.selection_saved = false;
        failed_restore.retro_restore_ok = Some(false);
        let per_control = display_scaling_mode_per_control(&failed_restore, 2);
        assert_eq!(per_control["retroRestoreOk"], json!(false));
        assert_eq!(per_control["message"], json!(format!(
            "display scaling setter failed {RETRO_SCALING_RESTORE_FAILED_MESSAGE}"
        )));
        assert_eq!(
            retro_restore_per_control(Some(false)).unwrap()["message"],
            json!(RETRO_SCALING_RESTORE_FAILED_MESSAGE)
        );

        let mut restored_ok = failed_restore;
        restored_ok.retro_restore_ok = Some(true);
        let per_control = display_scaling_mode_per_control(&restored_ok, 2);
        assert_eq!(per_control["retroRestoreOk"], json!(true));
        assert_eq!(per_control["message"], json!("display scaling setter failed"));
        assert!(retro_restore_per_control(None).is_none());
    }

    fn scaling_mode_apply_result() -> super::super::display_scaling_apply::DisplayScalingModeApplyResult {
        use super::super::display_scaling_apply::{DisplayScalingApplyResult, DisplayScalingModeApplyResult};

        DisplayScalingModeApplyResult {
            scaling: DisplayScalingApplyResult {
                ok: true, error_code: None, message: None, read_back: None,
                read_back_equal: true, active_read_back_equal: true,
                preferred_read_back_equal: true, readback_reported: true,
                driver_apply_succeeded: true, setter_succeeded: Some(true),
                requested_set: Some(true),
                deferred: false, rollback_attempted: false, rollback_verified: false,
                state_may_have_changed: false, selection_saved: true, prior_state: None,
            },
            retro_restore_ok: None,
        }
    }

    #[test]
    fn retro_scaling_outcome_preserves_successful_set_silent_noop_parity() {
        use super::super::display_retro_scaling_apply::{
            RetroScalingApplyResult, RetroScalingObservation, RetroScalingMethod,
        };

        let mismatch = RetroScalingApplyResult {
            ok: false,
            error_code: Some("io-failed"),
            message: Some("read-back did not match".into()),
            read_back: Some(RetroScalingObservation {
                enabled: false,
                method: Some(RetroScalingMethod::Integer),
            }),
            read_back_equal: false,
            silent_noop: Some(true),
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: false,
        };
        let response = retro_scaling_apply_outcome(&mismatch);
        assert_eq!(response["ok"], json!(false));
        assert_eq!(response["readBackEqual"], json!(false));
        assert_eq!(response["silentNoop"], json!(true));
        assert!(response["warning"].as_str().is_some());

        let failed_get = RetroScalingApplyResult {
            read_back: None,
            ..mismatch
        };
        let response = retro_scaling_apply_outcome(&failed_get);
        assert_eq!(response["readBackEqual"], json!(false));
        assert_eq!(response["silentNoop"], json!(true));

        let exact = RetroScalingApplyResult {
            ok: true,
            error_code: None,
            message: None,
            read_back: Some(RetroScalingObservation {
                enabled: true,
                method: Some(RetroScalingMethod::Integer),
            }),
            read_back_equal: true,
            silent_noop: Some(false),
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: false,
        };
        assert_eq!(retro_scaling_apply_outcome(&exact)["silentNoop"], json!(false));
    }

    #[test]
    fn display_apply_bridge_routes_one_quantization_value() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "quantizationRange": "full" }
        }])).unwrap();
        let response = json!({
            "ok": true,
            "perControl": { "quantizationRange": { "ok": true, "readBackEqual": true } },
            "displayState": { "deviceKey": device_key, "displays": [] },
        });
        let mut calls = 0;
        let routed = route_display_apply("display:apply", &args, true,
            |id, key, display, field| {
                calls += 1;
                assert_eq!(id, 4);
                assert_eq!(key, device_key);
                assert_eq!(display, display_key);
                assert_eq!(field.fields(), vec![NativeDisplayApplyField::QuantizationRange(2)]);
                Ok(Some(response.clone()))
            });
        assert_eq!(calls, 1);
        assert_eq!(routed, Some(Ok(encode_json(&response).unwrap())));
    }

    #[test]
    fn display_apply_bridge_routes_one_wire_format_pair() {
        use super::super::display_wire_format_apply::WireFormatPair;

        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "wireFormat": { "model": "YCbCr444", "depth": 10 } }
        }])).unwrap();
        let response = json!({
            "ok": true,
            "perControl": { "wireFormat": { "ok": true, "readBackEqual": true, "silentNoop": false } },
            "displayState": { "deviceKey": device_key, "displays": [] },
        });
        let mut calls = 0;
        let routed = route_display_apply("display:apply", &args, true,
            |id, key, display, field| {
                calls += 1;
                assert_eq!(id, 4);
                assert_eq!(key, device_key);
                assert_eq!(display, display_key);
                assert_eq!(field.fields(), vec![NativeDisplayApplyField::WireFormat(WireFormatPair {
                    color_model: 3,
                    color_depth: 4,
                })]);
                Ok(Some(response.clone()))
            });
        assert_eq!(calls, 1);
        assert_eq!(routed, Some(Ok(encode_json(&response).unwrap())));
    }

    #[test]
    fn display_apply_bridge_routes_one_global_vrr_mode() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "globalVrrMode": "fullscreen-windowed" }
        }])).unwrap();
        let response = json!({
            "ok": false,
            "perControl": { "globalVrrMode": {
                "ok": false, "errorCode": "io-failed", "readBackEqual": false,
                "silentNoop": true, "writeTransport": "registry"
            } },
            "displayState": { "deviceKey": device_key, "displays": [] },
        });
        let mut calls = 0;
        let routed = route_display_apply("display:apply", &args, true,
            |id, key, display, field| {
                calls += 1;
                assert_eq!(id, 4);
                assert_eq!(key, device_key);
                assert_eq!(display, display_key);
                assert_eq!(field.fields(), vec![NativeDisplayApplyField::GlobalVrrMode("fullscreen-windowed")]);
                Ok(Some(response.clone()))
            });
        assert_eq!(calls, 1);
        assert_eq!(routed, Some(Ok(encode_json(&response).unwrap())));
    }

    #[test]
    fn display_apply_bridge_routes_one_arc_sync_profile() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "vrrMode": "excellent" }
        }])).unwrap();
        let response = json!({
            "ok": true,
            "perControl": { "vrrMode": {
                "ok": true, "readBackEqual": true, "silentNoop": false
            } },
            "displayState": { "deviceKey": device_key, "displays": [] },
        });
        let mut calls = 0;
        let routed = route_display_apply("display:apply", &args, true,
            |id, key, display, field| {
                calls += 1;
                assert_eq!(id, 4);
                assert_eq!(key, device_key);
                assert_eq!(display, display_key);
                assert_eq!(field.fields(), vec![NativeDisplayApplyField::ArcSyncProfile(
                    super::super::display_arc_sync_apply::ArcSyncProfile::Excellent,
                )]);
                Ok(Some(response.clone()))
            });
        assert_eq!(calls, 1);
        assert_eq!(routed, Some(Ok(encode_json(&response).unwrap())));
    }

    #[test]
    fn display_apply_bridge_routes_one_variable_refresh_rate_boolean() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "variableRefreshRate": false }
        }])).unwrap();
        let response = json!({
            "ok": false,
            "perControl": { "variableRefreshRate": {
                "ok": false, "errorCode": "io-failed", "readBackEqual": false,
                "silentNoop": true
            } },
            "displayState": { "deviceKey": device_key, "displays": [] },
        });
        let mut calls = 0;
        let routed = route_display_apply("display:apply", &args, true,
            |id, key, display, field| {
                calls += 1;
                assert_eq!(id, 4);
                assert_eq!(key, device_key);
                assert_eq!(display, display_key);
                assert_eq!(field.fields(), vec![NativeDisplayApplyField::VariableRefreshRate(false)]);
                Ok(Some(response.clone()))
            });
        assert_eq!(calls, 1);
        assert_eq!(routed, Some(Ok(encode_json(&response).unwrap())));
    }

    #[test]
    fn variable_refresh_rate_outcome_matches_electron_setter_boundary_and_boolean_profile() {
        use super::super::display_arc_sync_apply::{ArcSyncApplyResult, ArcSyncProfile};

        let failed_set = ArcSyncApplyResult {
            ok: false,
            error_code: Some("io-failed"),
            message: Some("IGCL ERROR_DEVICE_LOST (0x40000003)".into()),
            read_back: None,
            read_back_equal: false,
            readback_reported: false,
            setter_succeeded: Some(false),
            state_may_have_changed: true,
        };
        let failed = variable_refresh_rate_apply_outcome(&failed_set, true);
        assert_eq!(failed["ok"], json!(false));
        assert_eq!(failed["errorCode"], json!("io-failed"));
        assert!(failed.get("readBackEqual").is_none());
        assert!(failed.get("silentNoop").is_none());

        let mismatch = ArcSyncApplyResult {
            ok: false,
            error_code: Some("io-failed"),
            message: Some("read-back profile off != requested recommended".into()),
            read_back: Some(ArcSyncProfile::Off),
            read_back_equal: false,
            readback_reported: true,
            setter_succeeded: Some(true),
            state_may_have_changed: true,
        };
        let no_op = variable_refresh_rate_apply_outcome(&mismatch, true);
        assert_eq!(no_op["readBackEqual"], json!(false));
        assert_eq!(no_op["silentNoop"], json!(true));
        assert_eq!(no_op["message"], json!("read-back profile 5 != requested 1"));

        let success = ArcSyncApplyResult {
            ok: true,
            error_code: None,
            message: None,
            read_back: Some(ArcSyncProfile::Off),
            read_back_equal: true,
            readback_reported: true,
            setter_succeeded: Some(true),
            state_may_have_changed: true,
        };
        let disabled = variable_refresh_rate_apply_outcome(&success, false);
        assert_eq!(disabled["readBackEqual"], json!(true));
        assert_eq!(disabled["silentNoop"], json!(false));
    }

    #[test]
    fn arc_sync_per_control_matches_electron_setter_and_readback_fields() {
        use super::super::display_arc_sync_apply::ArcSyncApplyResult;

        let failed_set = ArcSyncApplyResult {
            ok: false,
            error_code: Some("io-failed"),
            message: Some("IGCL ERROR_DEVICE_LOST (0x40000003)".into()),
            read_back: None,
            read_back_equal: false,
            readback_reported: false,
            setter_succeeded: Some(false),
            state_may_have_changed: true,
        };
        let failed = arc_sync_apply_outcome(&failed_set);
        assert_eq!(failed["ok"], json!(false));
        assert_eq!(failed["errorCode"], json!("io-failed"));
        assert!(failed.get("readBackEqual").is_none());
        assert!(failed.get("silentNoop").is_none());

        let readback_unavailable = ArcSyncApplyResult {
            ok: false,
            error_code: Some("io-failed"),
            message: Some("set succeeded but profile read-back failed".into()),
            read_back: None,
            read_back_equal: false,
            readback_reported: true,
            setter_succeeded: Some(true),
            state_may_have_changed: true,
        };
        let failed_read = arc_sync_apply_outcome(&readback_unavailable);
        assert_eq!(failed_read["readBackEqual"], json!(false));
        assert_eq!(failed_read["silentNoop"], json!(true));

        let same_profile = ArcSyncApplyResult {
            ok: true,
            error_code: None,
            message: None,
            read_back: Some(super::super::display_arc_sync_apply::ArcSyncProfile::Excellent),
            read_back_equal: true,
            readback_reported: true,
            setter_succeeded: Some(true),
            state_may_have_changed: false,
        };
        let success = arc_sync_apply_outcome(&same_profile);
        assert_eq!(success["readBackEqual"], json!(true));
        assert_eq!(success["silentNoop"], json!(false));
    }

    #[test]
    fn wire_format_outcome_keeps_successful_set_silent_noop_distinct() {
        use super::super::display_wire_format_apply::WireFormatApplyResult;

        let set_mismatch = WireFormatApplyResult {
            ok: false,
            error_code: Some("io-failed"),
            message: Some("set succeeded but depth was unavailable".into()),
            read_back: None,
            read_back_equal: false,
            setter_succeeded: Some(true),
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: true,
        };
        let outcome = wire_format_apply_outcome(&set_mismatch);
        assert_eq!(outcome["ok"], json!(false));
        assert_eq!(outcome["readBackEqual"], json!(false));
        assert_eq!(outcome["silentNoop"], json!(true));

        let setter_failure = WireFormatApplyResult {
            setter_succeeded: Some(false),
            ..set_mismatch
        };
        let outcome = wire_format_apply_outcome(&setter_failure);
        assert!(outcome.get("silentNoop").is_none());
        assert!(outcome.get("readBackEqual").is_none());
    }

    #[test]
    fn display_apply_unsupported_requests_decline_before_native_io() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let requests = [
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "scalingMethod": { "enabled": true, "method": "integer" }, "scalingMode": "centered"
            }}),
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "scalingMethod": { "enabled": true, "method": "unknown" }
            }}),
            json!({ "deviceKey": "pnp:adapter-alias", "displayKey": display_key, "patch": {
                "scalingMethod": { "enabled": true, "method": "integer" }
            }}),
            json!({ "deviceKey": device_key, "displayKey": "pci:other|display|encoder-a|edid|abcd1234", "patch": {
                "scalingMethod": { "enabled": true, "method": "integer" }
            }}),
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "quantizationRange": "unknown"
            }}),
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "wireFormat": { "model": "RGB", "depth": 8.5 }
            }}),
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "wireFormat": { "model": "RGB", "depth": 8, "extra": true }
            }}),
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "globalVrrMode": "unknown"
            }}),
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "vrrMode": "unknown"
            }}),
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "variableRefreshRate": "disabled"
            }}),
            // A pairless Custom request stays broker-owned. The Custom pair
            // moved to display_apply_bridge_routes_custom_scaling_pairs_natively
            // when P4 began serving it; the ordinary raw/alias shapes moved when
            // P2 began serving them.
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "scalingMode": "custom"
            }}),
            json!({ "deviceKey": device_key, "displayKey": display_key, "patch": {
                "scalingMode": "centered", "scalingMethod": { "enabled": true, "method": "integer" }
            }}),
        ];
        for request in requests {
            let args = encode_json(&json!([4, request])).unwrap();
            let mut called = false;
            assert!(route_display_apply("display:apply", &args, true,
                |_, _, _, _| {
                    called = true;
                    Ok(Some(json!({"unexpected": true})))
                }).is_none());
            assert!(!called, "unsupported patches must delegate before native IO");
        }
    }

    #[test]
    fn display_apply_pre_mutation_decline_delegates_but_native_errors_stay_closed() {
        let key = "pci:0x00008086:0x0000e20b@3:0.0";
        let args = encode_json(&json!([4, {
            "deviceKey": key,
            "displayKey": format!("{key}|display|encoder-a|edid|abcd1234"),
            "patch": { "scalingMethod": { "enabled": false, "method": "integer" } }
        }])).unwrap();
        assert!(route_display_apply("display:apply", &args, true, |_, _, _, _| Ok(None)).is_none());
        assert_eq!(route_display_apply("display:apply", &args, true, |_, _, _, _| {
            Err("post-set full Display read failed".into())
        }), Some(Err("post-set full Display read failed".into())));
    }

    #[test]
    fn display_apply_bridge_composes_multi_control_requests_in_electron_order() {
        use super::super::display_color_apply::DisplayColorPatch;
        use super::super::display_scaling_apply::DisplayScalingPatch;
        use super::super::display_wire_format_apply::WireFormatPair;

        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        // The floating "Apply all" merge (graphics.ts:2343-2347) folds every
        // dirty control into ONE patch, in key order rather than execution
        // order. P4C's single-key gate declines this shape outright.
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": {
                "quantizationRange": "full",
                "hue": 12,
                "scalingMode": "centered",
                "wireFormat": { "model": "RGB", "depth": 8 },
            },
        }])).unwrap();
        let response = json!({
            "ok": true,
            "perControl": { "quantizationRange": { "ok": true } },
            "displayState": { "deviceKey": device_key, "displays": [] },
        });
        let mut calls = 0;
        let routed = route_display_apply("display:apply", &args, true, |id, key, display, plan| {
            calls += 1;
            assert_eq!((id, key, display), (4, device_key, display_key.as_str()));
            assert_eq!(plan.fields(), vec![
                NativeDisplayApplyField::QuantizationRange(2),
                NativeDisplayApplyField::WireFormat(WireFormatPair {
                    color_model: 0,
                    color_depth: 2,
                }),
                NativeDisplayApplyField::ScalingMode(DisplayScalingPatch {
                    scaling_type: 2,
                    custom: None,
                    has_method_alias: false,
                    retro_disable: None,
                }),
                NativeDisplayApplyField::Color(DisplayColorPatch {
                    hue: Some(12.0),
                    ..DisplayColorPatch::default()
                }),
            ], "one keyed step per control, in Electron's execution order");
            assert_eq!(
                plan.control_keys(),
                vec!["quantizationRange", "wireFormat", "scalingMode", "hue"],
            );
            Ok(Some(response.clone()))
        });
        assert_eq!(calls, 1, "one Apply-all reaches the guarded transaction once");
        assert_eq!(routed, Some(Ok(encode_json(&response).unwrap())));
    }

    #[test]
    fn display_apply_plan_answers_every_requested_key_from_one_final_read() {
        let patch = json!({
            "quantizationRange": "full",
            "wireFormat": { "model": "YCbCr444", "depth": 10 },
            "scalingMode": "stretched",
            "displayScalingMethod": "stretched",
            "hue": 12,
            "saturation": 1.2,
            "brightness": -8,
            "contrast": 0.9,
            "variableRefreshRate": true,
            "globalVrrMode": "fullscreen",
            "replaceExistingColorSettings": true,
        });
        let plan = display_apply_plan(patch.as_object().unwrap()).expect("every key is owned");
        let mut invoked = Vec::new();
        let run = run_display_plan(&plan, |field| {
            invoked.push(field.control_keys());
            DisplayStepOutcome::Applied {
                ok: true,
                per_control: field.control_keys().into_iter()
                    .map(|key| (key.to_owned(), json!({ "ok": true })))
                    .collect(),
            }
        }).expect("no control declined before writing");
        assert_eq!(
            invoked.concat(),
            vec![
                "quantizationRange", "wireFormat", "scalingMode", "displayScalingMethod",
                "hue", "saturation", "brightness", "contrast",
                "variableRefreshRate", "globalVrrMode",
            ],
            "Electron's execution order, one keyed step per control",
        );
        // Exactly one fresh read answers the whole plan.
        let mut reads = 0;
        let envelope = display_apply_envelope(run, || {
            reads += 1;
            Ok(Some(json!({ "deviceKey": "pci:x", "displays": [] })))
        }).expect("a fresh state exists");
        assert_eq!(reads, 1, "one final Display read for the whole plan");
        assert_eq!(envelope["ok"], json!(true));
        assert_eq!(envelope["displayState"], json!({ "deviceKey": "pci:x", "displays": [] }));
        let per_control = envelope["perControl"].as_object().unwrap();
        assert_eq!(
            per_control.keys().map(String::as_str).collect::<Vec<_>>(),
            vec![
                "quantizationRange", "wireFormat", "scalingMode", "displayScalingMethod",
                "hue", "saturation", "brightness", "contrast",
                "variableRefreshRate", "globalVrrMode",
            ],
            "one perControl entry per requested control key",
        );
        assert!(!per_control.contains_key(DISPLAY_COLOR_FLAG),
            "the acknowledgement flag is not a control");
        assert!(per_control.values().all(|value| !value.is_null()), "no null placeholders");
    }

    #[test]
    fn display_apply_plan_records_a_control_failure_and_never_rolls_a_sibling_back() {
        let plan = display_apply_plan(
            json!({ "quantizationRange": "full", "hue": 12, "globalVrrMode": "fullscreen" })
                .as_object().unwrap()
        ).expect("every control is owned");
        let mut invoked = Vec::new();
        let run = run_display_plan(&plan, |field| {
            let key = field.control_keys()[0];
            invoked.push(key);
            match field {
                NativeDisplayApplyField::Color(_) => DisplayStepOutcome::Applied {
                    ok: false,
                    per_control: per_control_single("hue", json!({
                        "ok": false,
                        "errorCode": "io-failed",
                        "message": "The driver rejected the display color settings.",
                    })),
                },
                _ => DisplayStepOutcome::Applied {
                    ok: true,
                    per_control: per_control_single(key, json!({ "ok": true, "readBackEqual": true })),
                },
            }
        }).expect("every control was attempted");
        assert_eq!(invoked, vec!["quantizationRange", "hue", "globalVrrMode"],
            "a failed control neither aborts the remaining controls nor re-runs a sibling");
        assert!(!run.ok, "one failed control fails the whole apply");
        assert_eq!(run.per_control["quantizationRange"]["ok"], json!(true),
            "an accepted sibling keeps its own verdict");
        assert_eq!(run.per_control["hue"]["ok"], json!(false));
        assert_eq!(run.per_control["globalVrrMode"]["ok"], json!(true),
            "the control after the failed one still runs");
        assert_eq!(run.per_control.len(), 3, "exactly one entry per requested key");
    }

    #[test]
    fn display_apply_bridge_declines_any_unowned_control_before_any_write() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let declined = [
            // An unknown control beside an owned one.
            json!({ "quantizationRange": "full", "superResolution": true }),
            // `scalingCustom` without `scalingMode: 'custom'`.
            json!({ "scalingMode": "centered", "scalingCustom": { "x": 80, "y": 70 } }),
            // A pairless Custom request beside another control.
            json!({ "scalingMode": "custom", "quantizationRange": "full" }),
            // A standalone enable without the raw identity entry cannot be
            // composed with another control.
            json!({ "scalingMethod": { "enabled": true, "method": "integer" }, "quantizationRange": "full" }),
            // The acknowledgement flag is not a control of its own.
            json!({ "replaceExistingColorSettings": true, "quantizationRange": "full" }),
            // A mistyped owned value is Electron's own validation path.
            json!({ "quantizationRange": "full", "brightness": "8" }),
            // The legacy Arc Sync profile is not part of the composed order.
            json!({ "vrrMode": "off", "quantizationRange": "full" }),
        ];
        for patch in declined {
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": patch,
            }])).unwrap();
            let mut calls = 0;
            assert!(route_display_apply("display:apply", &args, true, |_, _, _, _| {
                calls += 1;
                Ok(Some(json!({ "unexpected": true })))
            }).is_none(), "the whole request must decline, never a partial apply: {patch}");
            assert_eq!(calls, 0, "no native write for an unowned control: {patch}");
        }
        // Control row: the same owned controls without the unowned key route.
        let args = encode_json(&json!([4, {
            "deviceKey": device_key,
            "displayKey": display_key,
            "patch": { "quantizationRange": "full", "brightness": -8 },
        }])).unwrap();
        let mut calls = 0;
        let routed = route_display_apply("display:apply", &args, true, |_, _, _, plan| {
            calls += 1;
            assert_eq!(plan.control_keys(), vec!["quantizationRange", "brightness"]);
            Ok(Some(json!({ "ok": true })))
        });
        assert_eq!(calls, 1, "the owned pair must route natively");
        assert!(routed.is_some());
    }

    const COMPOSED_DEVICE_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0";
    const COMPOSED_DISPLAY_KEY: &str =
        "pci:0x00008086:0x0000e20b@3:0.0|display|encoder-a|edid|abcd1234";

    /// Shared driver model for the composed Retro tests: the adapter-level
    /// tuple plus every Retro SET the request actually attempted, in order.
    struct RetroDriver {
        enabled: bool,
        method: Option<super::super::display_retro_scaling_apply::RetroScalingMethod>,
        writes: Vec<super::super::display_retro_scaling_apply::RetroScalingWrite>,
        /// The Scaling Mode transaction's SECOND coupled Retro call (the
        /// restore) reports failure after moving the driver, so the tuple is
        /// left unknown - exactly the state a blind write must not touch.
        fail_restore_after_mutation: bool,
        coupled_calls: usize,
    }

    impl RetroDriver {
        fn enabled(method: super::super::display_retro_scaling_apply::RetroScalingMethod) -> Self {
            Self {
                enabled: true,
                method: Some(method),
                writes: Vec::new(),
                fail_restore_after_mutation: false,
                coupled_calls: 0,
            }
        }

        /// What the driver reports: a disabled surface normalizes the method.
        fn observation(&self) -> super::super::display_retro_scaling_apply::RetroScalingObservation {
            super::super::display_retro_scaling_apply::RetroScalingObservation {
                enabled: self.enabled,
                method: if self.enabled { self.method } else { None },
            }
        }

        fn disable_sets(&self) -> usize { self.writes.iter().filter(|write| !write.enabled).count() }
    }

    /// The Scaling Mode transaction's backend, bound to the shared Retro model
    /// so the coupled disable and its restore are visible in one write log.
    struct ComposedScalingBackend {
        retro: std::rc::Rc<std::cell::RefCell<RetroDriver>>,
        current: super::super::display_scaling_apply::DisplayScalingObservation,
        /// The ordinary scaling SET fails and leaves the prior tuple in place,
        /// so the transaction reports the failure without a scaling rollback.
        fail_scaling_set: bool,
    }

    impl super::super::display_scaling_apply::DisplayScalingApplyBackend for ComposedScalingBackend {
        fn active_outputs(
            &mut self, device_key: &str,
        ) -> Result<Vec<super::super::display_scaling_apply::DisplayScalingOutputIdentity>, String> {
            Ok(vec![super::super::display_scaling_apply::DisplayScalingOutputIdentity {
                device_key: device_key.to_owned(),
                display_key: COMPOSED_DISPLAY_KEY.to_owned(),
                active: true,
                identity_verified: true,
            }])
        }

        fn read_scaling(
            &mut self, _: &str, _: &str,
        ) -> Result<super::super::display_scaling_apply::DisplayScalingObservation, String> {
            Ok(self.current.clone())
        }

        fn set_scaling_if_current(
            &mut self, _: &str, _: &str,
            _: &super::super::display_scaling_apply::DisplayScalingObservation,
            requested: &super::super::display_scaling_apply::DisplayScalingWrite,
        ) -> super::super::display_scaling_apply::DisplayScalingWriteOutcome {
            use super::super::display_scaling_apply::DisplayScalingWriteOutcome;
            if self.fail_scaling_set {
                return DisplayScalingWriteOutcome::Attempted {
                    setter_succeeded: false,
                    result: Err("simulated ordinary scaling setter failure".into()),
                    error_code: Some("io-failed"),
                };
            }
            let (custom_x, custom_y) = requested.custom
                .map(|(x, y)| (x, y))
                .unwrap_or((self.current.custom_x, self.current.custom_y));
            self.current = super::super::display_scaling_apply::DisplayScalingObservation {
                version: self.current.version,
                enabled: requested.enabled,
                scaling_type: requested.scaling_type,
                custom_x,
                custom_y,
                preferred_scaling_type: self.current.preferred_scaling_type,
            };
            DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: true, result: Ok(()), error_code: None,
            }
        }

        fn read_retro_scaling(
            &mut self, _: &str, _: &str,
        ) -> Result<Option<super::super::display_retro_scaling_apply::RetroScalingObservation>, String> {
            Ok(Some(self.retro.borrow().observation()))
        }

        fn set_retro_scaling_if_current(
            &mut self, _: &str, _: &str,
            expected_current: super::super::display_retro_scaling_apply::RetroScalingObservation,
            requested: super::super::display_retro_scaling_apply::RetroScalingWrite,
        ) -> super::super::display_scaling_apply::DisplayScalingWriteOutcome {
            use super::super::display_scaling_apply::DisplayScalingWriteOutcome;
            let mut driver = self.retro.borrow_mut();
            if !driver.observation().same_effective_state(expected_current) {
                return DisplayScalingWriteOutcome::NotAttempted(
                    "fixture conditional write refused".into());
            }
            driver.coupled_calls += 1;
            let restoring = driver.coupled_calls == 2;
            driver.writes.push(requested);
            driver.enabled = requested.enabled;
            driver.method = if requested.enabled { Some(requested.method) } else { None };
            if restoring && driver.fail_restore_after_mutation {
                // The restore SET moved the driver but reported failure: the
                // caller must treat the tuple as unverified.
                return DisplayScalingWriteOutcome::Attempted {
                    setter_succeeded: false,
                    result: Err("simulated Retro restore failure after mutation".into()),
                    error_code: Some("io-failed"),
                };
            }
            DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: true, result: Ok(()), error_code: None,
            }
        }
    }

    struct ComposedSelectionStore;

    impl super::super::display_scaling_apply::DisplayScalingSelectionStore for ComposedSelectionStore {
        fn read_selection(
            &mut self, _: &str,
        ) -> Result<Option<super::super::display_scaling_state::ScalingSelection>, String> {
            Ok(None)
        }
        fn save_selection(
            &mut self, _: &str,
            _: &super::super::display_scaling_state::SelectionUpdate,
        ) -> Result<(), String> {
            Ok(())
        }
    }

    /// The standalone Retro transaction, bound to the same shared model, so a
    /// plan that (wrongly) executes the later step is visible as a write.
    struct ComposedRetroBackend {
        retro: std::rc::Rc<std::cell::RefCell<RetroDriver>>,
    }

    impl super::super::display_retro_scaling_apply::RetroScalingApplyBackend for ComposedRetroBackend {
        fn assert_device_target(
            &mut self, device_id: u64, expected_device_key: &str, physical_target: &Value,
        ) -> Result<(), String> {
            if device_id != 4 || expected_device_key != COMPOSED_DEVICE_KEY || !physical_target.is_object() {
                return Err("fixture identity mismatch".into());
            }
            Ok(())
        }

        fn active_outputs(
            &mut self, expected_device_key: &str,
        ) -> Result<Vec<super::super::display_apply::DisplayOutputIdentity>, String> {
            if expected_device_key != COMPOSED_DEVICE_KEY { return Ok(Vec::new()); }
            Ok(vec![super::super::display_apply::DisplayOutputIdentity {
                display_key: COMPOSED_DISPLAY_KEY.to_owned(),
                active: true,
                identity_verified: true,
            }])
        }

        fn supported_methods(&mut self, _: &str, _: &str) -> Result<Option<u32>, String> {
            Ok(Some(0b11))
        }

        fn read_mode(
            &mut self, _: &str, _: &str,
        ) -> Result<super::super::display_retro_scaling_apply::RetroScalingObservation, String> {
            Ok(self.retro.borrow().observation())
        }

        fn set_if_current(
            &mut self, _: &str, _: &str,
            expected_current: super::super::display_retro_scaling_apply::RetroScalingObservation,
            requested: super::super::display_retro_scaling_apply::RetroScalingWrite,
        ) -> Result<(), String> {
            let mut driver = self.retro.borrow_mut();
            if !driver.observation().same_effective_state(expected_current) {
                return Err("fixture conditional write refused".into());
            }
            driver.writes.push(requested);
            driver.enabled = requested.enabled;
            driver.method = if requested.enabled { Some(requested.method) } else { None };
            Ok(())
        }
    }

    /// Drive the real Scaling Mode transaction for a composed "leave Retro and
    /// change scaling" request whose ordinary scaling write fails, and return
    /// the applied result.
    fn composed_failing_scaling(
        guard: &super::super::display_lock::DisplayLockGuard,
        backend: &mut ComposedScalingBackend,
    ) -> super::super::display_scaling_apply::DisplayScalingModeApplyResult {
        let target = super::super::display_scaling_apply::DisplayScalingTarget {
            device_key: COMPOSED_DEVICE_KEY.to_owned(),
            display_key: COMPOSED_DISPLAY_KEY.to_owned(),
        };
        let write = super::super::display_scaling_apply::DisplayScalingWrite {
            enabled: true,
            scaling_type: 2,
            custom: None,
            hardware_mode_set: false,
        };
        let mut store = ComposedSelectionStore;
        match super::super::display_scaling_apply::apply_display_scaling_mode_with_store(
            guard, backend, &mut store, "p5b-state", &target, &write,
            Some(super::super::display_retro_scaling_apply::RetroScalingMethod::Integer),
        ) {
            super::super::display_scaling_apply::DisplayScalingModeApplyOutcome::Applied(applied) => applied,
            super::super::display_scaling_apply::DisplayScalingModeApplyOutcome::Declined =>
                panic!("the coupled transaction must not decline on a verified Retro surface"),
        }
    }

    /// The composed "Apply all" patch used by the Retro-restore tests: a
    /// quantization change, an ordinary scaling selection with its alias, and
    /// the Retro disable companion.
    fn composed_leave_retro_plan() -> NativeDisplayApplyPlan {
        display_apply_plan(json!({
            "quantizationRange": "full",
            "scalingMode": "centered",
            "displayScalingMethod": "centered",
            "scalingMethod": { "enabled": false, "method": "integer" },
        }).as_object().unwrap()).expect("the composed patch is owned")
    }

    #[test]
    fn composed_scaling_failure_keeps_its_own_retro_restoration() {
        use super::super::display_retro_scaling_apply::{
            RetroScalingMethod, RetroScalingWrite,
        };
        use super::super::display_scaling_apply::DisplayScalingPatch;

        let guard = super::super::display_lock::acquire().expect("the Display lock is available to tests");
        let driver = std::rc::Rc::new(std::cell::RefCell::new(RetroDriver::enabled(RetroScalingMethod::Integer)));
        let mut backend = ComposedScalingBackend {
            retro: std::rc::Rc::clone(&driver),
            current: super::super::display_scaling_apply::DisplayScalingObservation {
                version: 1, enabled: true, scaling_type: 2, custom_x: 0, custom_y: 0,
                preferred_scaling_type: Some(2),
            },
            fail_scaling_set: true,
        };
        // The real transaction: coupled disable, ordinary scaling failure, then
        // the verified restore of the previously enabled Retro state.
        let applied = composed_failing_scaling(&guard, &mut backend);
        assert_eq!(applied.retro_restore_ok, Some(true),
            "the coupled restore must verify before this test means anything");
        assert!(driver.borrow().enabled, "the restore put the prior state back");

        let plan = composed_leave_retro_plan();
        let patch = DisplayScalingPatch {
            scaling_type: 2, custom: None, has_method_alias: true,
            retro_disable: Some(RetroScalingMethod::Integer),
        };
        let mut retro_backend = ComposedRetroBackend { retro: std::rc::Rc::clone(&driver) };
        let mut invoked = Vec::new();
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::QuantizationRange(_) => DisplayStepOutcome::Applied {
                ok: true,
                per_control: per_control_single("quantizationRange", json!({ "ok": true })),
            },
            NativeDisplayApplyField::ScalingMode(_) => DisplayStepOutcome::AppliedWithRetroRestore {
                ok: applied.scaling.ok,
                per_control: display_scaling_step_per_control(&applied, &patch),
                restored: true,
            },
            NativeDisplayApplyField::RetroScaling(requested) => {
                // If the plan executes the standalone step it is the REAL
                // transaction, and it would disable the enabled surface.
                invoked.push("scalingMethod");
                let proof = json!({ "bdf": "0000:03:00.0" });
                let target = super::super::display_apply::DisplayApplyTarget {
                    device_id: 4,
                    device_key: COMPOSED_DEVICE_KEY,
                    physical_target: &proof,
                    display_key: COMPOSED_DISPLAY_KEY,
                };
                let retro = super::super::display_retro_scaling_apply::apply_retro_scaling(
                    &guard, &mut retro_backend, &target, *requested,
                );
                DisplayStepOutcome::Applied {
                    ok: retro.ok,
                    per_control: per_control_single(
                        "scalingMethod", retro_scaling_apply_outcome(&retro)),
                }
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("a request that already wrote must stay native-owned");

        let writes = driver.borrow().writes.clone();
        assert_eq!(driver.borrow().disable_sets(), 1,
            "exactly ONE Retro disable SET in the whole request: {writes:?}");
        assert_eq!(writes, vec![
            RetroScalingWrite { enabled: false, method: RetroScalingMethod::Integer },
            RetroScalingWrite { enabled: true, method: RetroScalingMethod::Integer },
        ], "the only Retro writes are the coupled disable and its restore");
        assert!(driver.borrow().enabled,
            "a failed Apply-all leaves Retro enabled, exactly as it was before the request");
        assert!(invoked.is_empty(),
            "a verified coupled restore owns scalingMethod: the standalone Retro step must be suppressed");
        assert!(!run.ok, "the failed scaling control still fails the apply");
        assert_eq!(run.per_control["quantizationRange"]["ok"], json!(true));
        // The ordinary entry is nested under its control key and the IGS alias
        // mirrors it; the coupled Retro record is the fourth and last entry.
        assert_eq!(run.per_control.len(), 4, "one entry per requested control key");
        assert_eq!(run.per_control["scalingMode"]["ok"], json!(false));
        assert_eq!(run.per_control["displayScalingMethod"]["ok"], json!(false));
        assert_eq!(run.per_control["displayScalingMethod"]["internal"], json!(true));
        assert_eq!(run.per_control["scalingMethod"], json!({
            "ok": false,
            "errorCode": "io-failed",
            "message": RETRO_SCALING_RESTORED_MESSAGE,
            "readBackEqual": false,
            "internal": true,
        }), "the coupled record states what actually happened: disabled, then restored");
    }

    #[test]
    fn composed_unverified_retro_restore_never_writes_a_blind_disable() {
        use super::super::display_retro_scaling_apply::{RetroScalingMethod, RetroScalingWrite};
        use super::super::display_scaling_apply::DisplayScalingPatch;

        let guard = super::super::display_lock::acquire().expect("the Display lock is available to tests");
        let driver = std::rc::Rc::new(std::cell::RefCell::new(RetroDriver::enabled(RetroScalingMethod::Integer)));
        driver.borrow_mut().fail_restore_after_mutation = true;
        let mut backend = ComposedScalingBackend {
            retro: std::rc::Rc::clone(&driver),
            current: super::super::display_scaling_apply::DisplayScalingObservation {
                version: 1, enabled: true, scaling_type: 2, custom_x: 0, custom_y: 0,
                preferred_scaling_type: Some(2),
            },
            fail_scaling_set: true,
        };
        let applied = composed_failing_scaling(&guard, &mut backend);
        assert_eq!(applied.retro_restore_ok, Some(false),
            "an unverified restore is reported as such, never as success");

        let plan = composed_leave_retro_plan();
        let patch = DisplayScalingPatch {
            scaling_type: 2, custom: None, has_method_alias: true,
            retro_disable: Some(RetroScalingMethod::Integer),
        };
        let mut retro_backend = ComposedRetroBackend { retro: std::rc::Rc::clone(&driver) };
        let mut invoked = Vec::new();
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::QuantizationRange(_) => DisplayStepOutcome::Applied {
                ok: true,
                per_control: per_control_single("quantizationRange", json!({ "ok": true })),
            },
            NativeDisplayApplyField::ScalingMode(_) => DisplayStepOutcome::AppliedWithRetroRestore {
                ok: applied.scaling.ok,
                per_control: display_scaling_step_per_control(&applied, &patch),
                restored: false,
            },
            NativeDisplayApplyField::RetroScaling(requested) => {
                invoked.push("scalingMethod");
                let proof = json!({ "bdf": "0000:03:00.0" });
                let target = super::super::display_apply::DisplayApplyTarget {
                    device_id: 4,
                    device_key: COMPOSED_DEVICE_KEY,
                    physical_target: &proof,
                    display_key: COMPOSED_DISPLAY_KEY,
                };
                let retro = super::super::display_retro_scaling_apply::apply_retro_scaling(
                    &guard, &mut retro_backend, &target, *requested,
                );
                DisplayStepOutcome::Applied {
                    ok: retro.ok,
                    per_control: per_control_single(
                        "scalingMethod", retro_scaling_apply_outcome(&retro)),
                }
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("a request that already wrote must stay native-owned");

        assert_eq!(driver.borrow().disable_sets(), 1,
            "the coupled disable is the only disable SET the request issued");
        assert_eq!(driver.borrow().writes, vec![
            RetroScalingWrite { enabled: false, method: RetroScalingMethod::Integer },
            RetroScalingWrite { enabled: true, method: RetroScalingMethod::Integer },
        ], "no write follows the failed restore: {:?}", driver.borrow().writes);
        assert!(invoked.is_empty(),
            "an unverified restore means an unknown driver tuple: no blind standalone disable");
        assert!(!run.ok);
        assert_eq!(run.per_control["scalingMethod"]["ok"], json!(false));
        assert_eq!(run.per_control["scalingMethod"]["internal"], json!(true));
        assert_eq!(run.per_control["scalingMethod"]["message"],
            json!(RETRO_SCALING_UNVERIFIED_MESSAGE),
            "the entry reports the unverified Retro state, not a restoration");
        assert!(run.per_control["scalingMethod"]["message"].as_str().unwrap()
            .contains("unverified"));
    }

    /// P5B review finding: the Retro-restore tests above build
    /// `AppliedWithRetroRestore` themselves, so they would keep passing if the
    /// real Scaling Mode arm stopped emitting it. This drives the production
    /// verdict gate (`scaling_mode_step_outcome`, the only code that chooses the
    /// outcome) with the IGS method alias present, for both session shapes.
    ///
    /// Red-ability: if the gate returned `Applied` for the composed session, the
    /// plan would never mark Retro as owned, the standalone `RetroScaling` step
    /// would run, and `standalone_retro_steps` / `disable_sets()` would report a
    /// second disable. If it returned `AppliedWithRetroRestore` for the
    /// single-control session, the `Applied` match below would fail.
    #[test]
    fn scaling_mode_step_gate_owns_the_coupled_retro_verdict_only_when_composed() {
        use super::super::display_retro_scaling_apply::{RetroScalingMethod, RetroScalingWrite};
        use super::super::display_scaling_apply::{DisplayScalingModeApplyResult, DisplayScalingPatch};

        let guard = super::super::display_lock::acquire().expect("the Display lock is available to tests");
        let plan = composed_leave_retro_plan();
        let patch = DisplayScalingPatch {
            scaling_type: 2, custom: None, has_method_alias: true,
            retro_disable: Some(RetroScalingMethod::Integer),
        };
        let proof = json!({ "bdf": "0000:03:00.0" });
        let target = super::super::display_apply::DisplayApplyTarget {
            device_id: 4,
            device_key: COMPOSED_DEVICE_KEY,
            physical_target: &proof,
            display_key: COMPOSED_DISPLAY_KEY,
        };

        // 1. Composed session, verified restore: the gate must hand the plan the
        // coupled verdict so the standalone Retro step is suppressed.
        let driver = std::rc::Rc::new(std::cell::RefCell::new(RetroDriver::enabled(RetroScalingMethod::Integer)));
        let mut backend = ComposedScalingBackend {
            retro: std::rc::Rc::clone(&driver),
            current: super::super::display_scaling_apply::DisplayScalingObservation {
                version: 1, enabled: true, scaling_type: 2, custom_x: 0, custom_y: 0,
                preferred_scaling_type: Some(2),
            },
            fail_scaling_set: true,
        };
        let applied = composed_failing_scaling(&guard, &mut backend);
        assert_eq!(applied.retro_restore_ok, Some(true),
            "the fixture must produce a verified coupled restore before this test means anything");

        let mut retro_backend = ComposedRetroBackend { retro: std::rc::Rc::clone(&driver) };
        let mut standalone_retro_steps = 0;
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::QuantizationRange(_) => DisplayStepOutcome::Applied {
                ok: true,
                per_control: per_control_single("quantizationRange", json!({ "ok": true })),
            },
            NativeDisplayApplyField::ScalingMode(_) => {
                let outcome = scaling_mode_step_outcome(
                    &applied, display_scaling_step_per_control(&applied, &patch), false);
                match &outcome {
                    DisplayStepOutcome::AppliedWithRetroRestore { restored: true, .. } => {}
                    other => panic!(
                        "a composed Scaling Mode step with a verified restore must hand the plan \
                         the coupled verdict: {other:?}"),
                }
                outcome
            }
            NativeDisplayApplyField::RetroScaling(requested) => {
                standalone_retro_steps += 1;
                let retro = super::super::display_retro_scaling_apply::apply_retro_scaling(
                    &guard, &mut retro_backend, &target, *requested,
                );
                DisplayStepOutcome::Applied {
                    ok: retro.ok,
                    per_control: per_control_single(
                        "scalingMethod", retro_scaling_apply_outcome(&retro)),
                }
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("a request that already wrote must stay native-owned");

        assert_eq!(standalone_retro_steps, 0,
            "the gate's coupled verdict must suppress the standalone Retro step");
        assert_eq!(driver.borrow().disable_sets(), 1,
            "exactly ONE Retro disable: the coupled exit, never a second standalone one");
        assert_eq!(driver.borrow().writes, vec![
            RetroScalingWrite { enabled: false, method: RetroScalingMethod::Integer },
            RetroScalingWrite { enabled: true, method: RetroScalingMethod::Integer },
        ]);
        assert!(!run.ok, "the failed scaling control still fails the apply");
        assert_eq!(run.per_control.len(), 4, "one entry per requested control key");
        assert_eq!(run.per_control["displayScalingMethod"]["internal"], json!(true),
            "the method alias mirrors the same transaction");
        assert_eq!(run.per_control["scalingMethod"]["message"],
            json!(RETRO_SCALING_RESTORED_MESSAGE));

        // 2. Composed session, unverified restore: the gate must still hand over
        // the verdict (with `restored: false`) so the plan reports an unknown
        // Retro tuple instead of inheriting the coupled "was restored" record.
        let driver = std::rc::Rc::new(std::cell::RefCell::new(RetroDriver::enabled(RetroScalingMethod::Integer)));
        driver.borrow_mut().fail_restore_after_mutation = true;
        let mut backend = ComposedScalingBackend {
            retro: std::rc::Rc::clone(&driver),
            current: super::super::display_scaling_apply::DisplayScalingObservation {
                version: 1, enabled: true, scaling_type: 2, custom_x: 0, custom_y: 0,
                preferred_scaling_type: Some(2),
            },
            fail_scaling_set: true,
        };
        let applied = composed_failing_scaling(&guard, &mut backend);
        assert_eq!(applied.retro_restore_ok, Some(false),
            "the fixture must produce an unverified coupled restore");

        let mut retro_backend = ComposedRetroBackend { retro: std::rc::Rc::clone(&driver) };
        let mut standalone_retro_steps = 0;
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::QuantizationRange(_) => DisplayStepOutcome::Applied {
                ok: true,
                per_control: per_control_single("quantizationRange", json!({ "ok": true })),
            },
            NativeDisplayApplyField::ScalingMode(_) => {
                let outcome = scaling_mode_step_outcome(
                    &applied, display_scaling_step_per_control(&applied, &patch), false);
                match &outcome {
                    DisplayStepOutcome::AppliedWithRetroRestore { restored: false, .. } => {}
                    other => panic!(
                        "an unverified restore must still reach the plan as the coupled verdict: {other:?}"),
                }
                outcome
            }
            NativeDisplayApplyField::RetroScaling(requested) => {
                standalone_retro_steps += 1;
                let retro = super::super::display_retro_scaling_apply::apply_retro_scaling(
                    &guard, &mut retro_backend, &target, *requested,
                );
                DisplayStepOutcome::Applied {
                    ok: retro.ok,
                    per_control: per_control_single(
                        "scalingMethod", retro_scaling_apply_outcome(&retro)),
                }
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("a request that already wrote must stay native-owned");

        assert_eq!(standalone_retro_steps, 0,
            "an unknown Retro tuple must never be written blindly by the standalone step");
        assert_eq!(driver.borrow().disable_sets(), 1);
        assert_eq!(run.per_control["scalingMethod"]["message"],
            json!(RETRO_SCALING_UNVERIFIED_MESSAGE),
            "the entry reports the unverified Retro state, not a restoration");

        // 3. Single-control session: no standalone Retro step exists, so the
        // shipped envelope stays verbatim even when the transaction restored -
        // here the raw transaction record, never the plan's unverified rewrite.
        match scaling_mode_step_outcome(
            &applied, display_scaling_step_per_control(&applied, &patch), true,
        ) {
            DisplayStepOutcome::Applied { ok, per_control } => {
                assert!(!ok);
                assert_eq!(per_control.len(), 3,
                    "scalingMode, its alias and the coupled record - nothing else");
                assert_eq!(per_control["displayScalingMethod"]["internal"], json!(true));
                assert_eq!(per_control["scalingMethod"]["message"],
                    json!(RETRO_SCALING_RESTORE_FAILED_MESSAGE),
                    "the shipped single-control envelope keeps Electron's own record");
            }
            other => panic!(
                "a single-control Scaling Mode request must keep the shipped envelope: {other:?}"),
        }

        // 4. No coupled restore means no Retro ownership: the plan must still
        // run the standalone step, so the gate cannot invent the verdict.
        let uncoupled = DisplayScalingModeApplyResult::failed("io-failed", "no coupled restore");
        assert!(matches!(
            scaling_mode_step_outcome(
                &uncoupled, per_control_single("scalingMode", json!({ "ok": false })), false),
            DisplayStepOutcome::Applied { .. }
        ), "without a coupled restore the gate must not claim scalingMethod");
    }

    #[test]
    fn composed_retro_exit_is_coupled_first_and_the_standalone_step_never_rewrites() {
        use super::super::display_retro_scaling_apply::{
            RetroScalingApplyBackend, RetroScalingMethod, RetroScalingObservation, RetroScalingWrite,
        };
        use super::super::display_scaling_apply::DisplayScalingPatch;

        const DEVICE_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0";
        const DISPLAY_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0|display|encoder-a|edid|abcd1234";

        // A composed "Apply all" leaves Retro Scaling: the disable pair is the
        // coupled companion of the Scaling Mode step AND a later standalone step.
        let patch = json!({
            "quantizationRange": "full",
            "scalingMode": "identity",
            "displayScalingMethod": "maintain-display-scaling",
            "scalingMethod": { "enabled": false, "method": "integer" },
        });
        let plan = display_apply_plan(patch.as_object().unwrap()).expect("the composed patch is owned");
        let scaling = DisplayScalingPatch {
            scaling_type: 1,
            custom: None,
            has_method_alias: true,
            retro_disable: Some(RetroScalingMethod::Integer),
        };
        assert_eq!(plan.fields(), vec![
            NativeDisplayApplyField::QuantizationRange(2),
            NativeDisplayApplyField::ScalingMode(scaling),
            NativeDisplayApplyField::RetroScaling(RetroScalingWrite {
                enabled: false,
                method: RetroScalingMethod::Integer,
            }),
        ], "the coupled exit lives inside the Scaling Mode step; the standalone Retro step follows it");

        // Electron's leavingRetro gate (`igcl-backend.js:4666-4669`): the
        // coupled write only when an active scaler actually has to be left.
        assert_eq!(coupled_retro_disable(&scaling, true, false), Some(RetroScalingMethod::Integer));
        assert_eq!(coupled_retro_disable(&scaling, false, false), None,
            "no active Retro scaler means the Scaling Mode step must not couple a write");
        // A request made only of the Scaling Mode group keeps the shipped
        // single-control transaction, which decides inside its own driver read.
        assert_eq!(coupled_retro_disable(&scaling, false, true), Some(RetroScalingMethod::Integer));

        // The standalone step runs against the state the coupled exit leaves
        // behind: Retro already disabled, so it must issue NO second SET.
        struct RetroWrites {
            current: RetroScalingObservation,
            writes: Vec<RetroScalingWrite>,
        }
        impl RetroScalingApplyBackend for RetroWrites {
            fn assert_device_target(
                &mut self, device_id: u64, expected_device_key: &str, physical_target: &Value,
            ) -> Result<(), String> {
                if device_id != 4 || expected_device_key != DEVICE_KEY || !physical_target.is_object() {
                    return Err("fixture identity mismatch".into());
                }
                Ok(())
            }
            fn active_outputs(
                &mut self, expected_device_key: &str,
            ) -> Result<Vec<super::super::display_apply::DisplayOutputIdentity>, String> {
                if expected_device_key != DEVICE_KEY { return Ok(Vec::new()); }
                Ok(vec![super::super::display_apply::DisplayOutputIdentity {
                    display_key: DISPLAY_KEY.to_owned(),
                    active: true,
                    identity_verified: true,
                }])
            }
            fn supported_methods(
                &mut self, _: &str, _: &str,
            ) -> Result<Option<u32>, String> { Ok(Some(0b11)) }
            fn read_mode(
                &mut self, _: &str, _: &str,
            ) -> Result<RetroScalingObservation, String> { Ok(self.current) }
            fn set_if_current(
                &mut self, _: &str, _: &str,
                expected_current: RetroScalingObservation,
                requested: RetroScalingWrite,
            ) -> Result<(), String> {
                if !self.current.same_effective_state(expected_current) {
                    return Err("fixture conditional write refused".into());
                }
                self.writes.push(requested);
                self.current = RetroScalingObservation {
                    enabled: requested.enabled,
                    method: requested.enabled.then_some(requested.method),
                };
                Ok(())
            }
        }

        let mut backend = RetroWrites {
            current: RetroScalingObservation { enabled: true, method: Some(RetroScalingMethod::Integer) },
            writes: Vec::new(),
        };
        // The coupled exit the Scaling Mode transaction performs: one disable SET.
        backend.set_if_current(
            DEVICE_KEY, DISPLAY_KEY, backend.current,
            RetroScalingWrite { enabled: false, method: RetroScalingMethod::Integer },
        ).expect("fixture coupled disable");
        assert_eq!(backend.writes.len(), 1, "the coupled exit is the one Retro write");
        assert!(!backend.current.enabled, "the coupled exit proved Retro disabled");

        let guard = super::super::display_lock::acquire().expect("the Display lock is available to tests");
        let proof = json!({ "bdf": "0000:03:00.0" });
        let target = super::super::display_apply::DisplayApplyTarget {
            device_id: 4,
            device_key: DEVICE_KEY,
            physical_target: &proof,
            display_key: DISPLAY_KEY,
        };
        let applied = super::super::display_retro_scaling_apply::apply_retro_scaling(
            &guard, &mut backend, &target,
            RetroScalingWrite { enabled: false, method: RetroScalingMethod::Integer },
        );
        assert!(applied.ok, "an already-disabled Retro surface is a verified no-op: {applied:?}");
        assert_eq!(applied.read_back, Some(RetroScalingObservation { enabled: false, method: None }));
        assert_eq!(applied.silent_noop, None, "no SET was issued, so there is no silent no-op");
        assert_eq!(backend.writes.len(), 1,
            "the coupled exit already disabled Retro: the standalone step must not write again");

        // (c) The composer success path is unchanged: the Scaling Mode step
        // reports success (no coupled restore), so the standalone step still
        // runs, observes the disabled surface and writes nothing.
        let success = scaling_mode_apply_result();
        let scaling_patch = super::super::display_scaling_apply::DisplayScalingPatch {
            scaling_type: 1, custom: None, has_method_alias: true,
            retro_disable: Some(RetroScalingMethod::Integer),
        };
        let mut invoked = Vec::new();
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::QuantizationRange(_) => DisplayStepOutcome::Applied {
                ok: true,
                per_control: per_control_single("quantizationRange", json!({ "ok": true })),
            },
            NativeDisplayApplyField::ScalingMode(_) => DisplayStepOutcome::Applied {
                ok: true,
                per_control: display_scaling_step_per_control(&success, &scaling_patch),
            },
            NativeDisplayApplyField::RetroScaling(requested) => {
                invoked.push("scalingMethod");
                let applied = super::super::display_retro_scaling_apply::apply_retro_scaling(
                    &guard, &mut backend, &target, *requested,
                );
                DisplayStepOutcome::Applied {
                    ok: applied.ok,
                    per_control: per_control_single(
                        "scalingMethod", retro_scaling_apply_outcome(&applied)),
                }
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("the success path stays native-owned");
        assert_eq!(invoked, vec!["scalingMethod"],
            "a successful Scaling Mode step leaves the standalone Retro step in place");
        assert_eq!(backend.writes.len(), 1,
            "that standalone step observed the disabled surface and wrote nothing");
        assert!(run.ok, "the successful request reports success");
        assert_eq!(run.per_control.len(), 4, "one entry per requested control key");
        assert_eq!(run.per_control["scalingMethod"]["ok"], json!(true));
        assert_eq!(run.per_control["scalingMethod"]["readBackEqual"], json!(true));
        assert_eq!(run.per_control["scalingMethod"]["silentNoop"], json!(false),
            "no SET ran for the standalone step, so no silent no-op is claimed");
    }

    #[test]
    fn display_apply_envelope_never_presents_an_unverified_state() {
        let run = || DisplayPlanRun { ok: true, per_control: Map::new() };
        // A read that fails, or that cannot prove a complete state, is an error:
        // never a payload with a fabricated or stale `displayState`.
        assert_eq!(
            display_apply_envelope(run(), || Err("post-set full Display read failed".into())),
            Err("post-set full Display read failed".to_string()),
        );
        assert_eq!(
            display_apply_envelope(run(), || Ok(None)),
            Err(super::super::display::DISPLAY_READ_UNPROVEN_ERROR.to_string()),
        );
        let mut reads = 0;
        let envelope = display_apply_envelope(run(), || {
            reads += 1;
            Ok(Some(json!({ "deviceKey": "pci:x", "displays": [] })))
        }).expect("a verified state produces the envelope");
        assert_eq!(reads, 1, "exactly one read feeds the envelope");
        assert_eq!(envelope["displayState"], json!({ "deviceKey": "pci:x", "displays": [] }));
        assert!(!envelope["displayState"].is_null(), "displayState is never null on success");
    }

    #[test]
    fn display_apply_plan_delegates_only_before_the_first_applied_control() {
        let plan = display_apply_plan(
            json!({ "quantizationRange": "full", "wireFormat": { "model": "RGB", "depth": 8 } })
                .as_object().unwrap()
        ).expect("both controls are owned");
        // Nothing was written yet: a pre-SET decline returns the whole request
        // to the broker, which re-validates under its own lock.
        let mut calls = 0;
        assert!(run_display_plan(&plan, |_| {
            calls += 1;
            DisplayStepOutcome::Declined
        }).is_none());
        assert_eq!(calls, 1, "the first control's decline ends the plan");

        // The first control applied, so a later decline can never become a
        // broker retry: it is recorded and the request stays native-owned.
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::QuantizationRange(_) => DisplayStepOutcome::Applied {
                ok: true,
                per_control: per_control_single("quantizationRange", json!({ "ok": true })),
            },
            _ => DisplayStepOutcome::Declined,
        }).expect("a request that already wrote stays native-owned");
        assert!(!run.ok);
        assert_eq!(run.per_control["quantizationRange"]["ok"], json!(true));
        assert_eq!(run.per_control["wireFormat"], json!({
            "ok": false,
            "errorCode": "io-failed",
            "message": DISPLAY_CONTROL_NOT_ATTEMPTED_MESSAGE,
        }));
    }

    #[test]
    fn every_shipped_single_control_shape_stays_one_step() {
        let shapes = [
            json!({ "quantizationRange": "full" }),
            json!({ "wireFormat": { "model": "RGB", "depth": 8 } }),
            json!({ "scalingMode": "centered" }),
            json!({ "scalingMode": "stretched", "displayScalingMethod": "stretched" }),
            json!({ "scalingMode": "custom", "scalingCustom": { "x": 80, "y": 70 } }),
            json!({
                "scalingMode": "custom",
                "scalingCustom": { "x": 80, "y": 70 },
                "scalingMethod": { "enabled": false, "method": "integer" },
            }),
            json!({
                "scalingMode": "identity",
                "displayScalingMethod": "maintain-display-scaling",
                "scalingMethod": { "enabled": false, "method": "nearest-neighbour" },
            }),
            json!({
                "scalingMode": "identity",
                "scalingMethod": { "enabled": true, "method": "integer" },
            }),
            json!({ "scalingMethod": { "enabled": true, "method": "integer" } }),
            json!({ "scalingMethod": { "enabled": false, "method": "integer" } }),
            json!({ "hue": 12 }),
            json!({ "hue": 12, "saturation": 1.2, "brightness": -8, "contrast": 0.9 }),
            json!({ "contrast": 0.9, "replaceExistingColorSettings": true }),
            json!({ "variableRefreshRate": false }),
            json!({ "globalVrrMode": "fullscreen" }),
            json!({ "vrrMode": "excellent" }),
            json!({ "arcSyncRange": { "minHz": 60.0, "maxHz": 165.0 } }),
            json!({ "arcSyncRange": Value::Null }),
        ];
        for shape in shapes {
            let plan = display_apply_plan(shape.as_object().unwrap())
                .unwrap_or_else(|| panic!("a shipped single-control shape must route: {shape}"));
            assert_eq!(plan.fields().len(), 1,
                "a shipped single-control shape keeps exactly one transaction: {shape}");
        }
    }

    /// The production preflight composition: one staged row, then the control's
    /// own support gate. Kept in the test module because `display:apply` now
    /// preflights a whole plan against that one row.
    fn staged_display_apply_display<'a>(
        staged: &'a super::super::display::StagedDisplayRead,
        device_key: &str,
        display_key: &str,
        field: &NativeDisplayApplyField,
    ) -> Option<&'a Value> {
        super::staged_display_row(staged, device_key, display_key)
            .filter(|display| super::staged_field_supported(display, field))
    }

    #[test]
    fn staged_display_apply_preflight_declines_before_any_setter_for_incomplete_candidates() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let quantization = NativeDisplayApplyField::QuantizationRange(2);
        let retro = NativeDisplayApplyField::RetroScaling(
            super::super::display_retro_scaling_apply::RetroScalingWrite {
                enabled: true,
                method: super::super::display_retro_scaling_apply::RetroScalingMethod::Integer,
            },
        );
        let wire = NativeDisplayApplyField::WireFormat(
            super::super::display_wire_format_apply::WireFormatPair {
                color_model: 0,
                color_depth: 2,
            },
        );
        let global_vrr = NativeDisplayApplyField::GlobalVrrMode("fullscreen-windowed");
        let arc_sync = NativeDisplayApplyField::ArcSyncProfile(
            super::super::display_arc_sync_apply::ArcSyncProfile::Excellent,
        );
        let variable_refresh_rate = NativeDisplayApplyField::VariableRefreshRate(false);
        let scaling_mode = NativeDisplayApplyField::ScalingMode(
            super::super::display_scaling_apply::DisplayScalingPatch {
                scaling_type: 4,
                custom: None,
                has_method_alias: false,
                retro_disable: None,
            },
        );
        let custom_scaling_mode = NativeDisplayApplyField::ScalingMode(
            super::super::display_scaling_apply::DisplayScalingPatch {
                scaling_type: 16,
                custom: Some((80, 70)),
                has_method_alias: false,
                retro_disable: None,
            },
        );
        let pairless_custom_scaling_mode = NativeDisplayApplyField::ScalingMode(
            super::super::display_scaling_apply::DisplayScalingPatch {
                scaling_type: 16,
                custom: None,
                has_method_alias: false,
                retro_disable: None,
            },
        );
        let display = json!({
            "displayKey": display_key,
            "identityVerified": true,
            "flags": { "active": true },
            "supportedOptions": {
                "scalingModes": ["identity", "centered", "stretched", "aspect-ratio-centered-max", "custom"],
                "quantizationRanges": ["default", "limited", "full"],
                "scalingMethods": ["integer", "nearest-neighbour"],
                "wireFormats": ["RGB", "YCbCr444"],
                "bpcDepths": [6, 8, 10],
                "globalVrrModes": ["fullscreen", "fullscreen-windowed", "disabled"]
                ,"vrrModes": ["recommended", "excellent", "good", "compatible", "off", "vesa", "custom"]
            },
            "scalingMethod": { "controllable": true },
            "scalingMode": "identity",
            "globalVrrMode": { "controllable": true },
            "vrrMode": { "controllable": true },
            "variableRefreshRate": { "controllable": true },
            "arcSync": { "supported": true, "profile": "recommended" }
        });
        let staged = |display_rows: Vec<Value>, eligible: bool| super::super::display::StagedDisplayRead {
            payload: json!({ "deviceKey": device_key, "displays": display_rows }),
            scaling_invalidations: Vec::new(),
            native_ownership_eligible: eligible,
        };
        let valid = staged(vec![display.clone()], true);
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &quantization).is_some());
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &retro).is_some());
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &wire).is_some());
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &global_vrr).is_some());
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &arc_sync).is_some());
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &variable_refresh_rate).is_some());
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &scaling_mode).is_some());
        assert!(
            staged_display_apply_display(&valid, device_key, &display_key, &custom_scaling_mode).is_some(),
            "P4 serves the Custom pair natively, so the staged preflight must accept it"
        );
        assert!(
            staged_display_apply_display(&valid, device_key, &display_key, &pairless_custom_scaling_mode).is_none(),
            "a pairless Custom request has no agreed pair and stays broker-owned"
        );

        let ineligible = staged(vec![display.clone()], false);
        assert!(staged_display_apply_display(&ineligible, device_key, &display_key, &quantization).is_none());

        let mut pending_invalidation = staged(vec![display.clone()], true);
        pending_invalidation.scaling_invalidations.push(super::super::display::ScalingInvalidation {
            display_key: display_key.clone(),
            expected: super::super::display_scaling_state::ScalingSelection {
                identity_scaling: true,
                native_preferred_scaling_type: Some(8),
                custom_x: None,
                custom_y: None,
            },
            observed_enable: 1,
            observed_scaling_type: 1,
            observed_preferred_type: Some(8),
        });
        assert!(staged_display_apply_display(&pending_invalidation, device_key, &display_key, &quantization).is_none());

        assert!(staged_display_apply_display(&valid, "pci:other", &display_key, &quantization).is_none());
        assert!(staged_display_apply_display(&staged(vec![display.clone(), display.clone()], true), device_key, &display_key, &quantization).is_none());
        let mut inactive = display.clone();
        inactive["flags"]["active"] = json!(false);
        assert!(staged_display_apply_display(&staged(vec![inactive], true), device_key, &display_key, &quantization).is_none());
        let mut unverified = display.clone();
        unverified["identityVerified"] = json!(false);
        assert!(staged_display_apply_display(&staged(vec![unverified], true), device_key, &display_key, &quantization).is_none());
        let unsupported = NativeDisplayApplyField::QuantizationRange(3);
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &unsupported).is_none());
        let unsupported_wire_depth = NativeDisplayApplyField::WireFormat(
            super::super::display_wire_format_apply::WireFormatPair {
                color_model: 0,
                color_depth: 8,
            },
        );
        assert!(staged_display_apply_display(&valid, device_key, &display_key, &unsupported_wire_depth).is_none());
        let unsupported_global_vrr = NativeDisplayApplyField::GlobalVrrMode("disabled");
        let mut no_global_vrr_support = display.clone();
        no_global_vrr_support["globalVrrMode"]["controllable"] = json!(false);
        assert!(staged_display_apply_display(
            &staged(vec![no_global_vrr_support], true),
            device_key,
            &display_key,
            &unsupported_global_vrr,
        ).is_none());
        let mut no_arc_sync_support = display.clone();
        no_arc_sync_support["vrrMode"]["controllable"] = json!(false);
        assert!(staged_display_apply_display(
            &staged(vec![no_arc_sync_support], true),
            device_key,
            &display_key,
            &arc_sync,
        ).is_none());
        let mut no_variable_refresh_control = display.clone();
        no_variable_refresh_control["variableRefreshRate"]["controllable"] = json!(false);
        assert!(staged_display_apply_display(
            &staged(vec![no_variable_refresh_control], true),
            device_key,
            &display_key,
            &variable_refresh_rate,
        ).is_none());
        let mut unknown_arc_sync_profile = display.clone();
        unknown_arc_sync_profile["arcSync"]["profile"] = json!("unknown");
        assert!(staged_display_apply_display(
            &staged(vec![unknown_arc_sync_profile], true),
            device_key,
            &display_key,
            &variable_refresh_rate,
        ).is_none());
        let mut no_ordinary_scaling = display.clone();
        no_ordinary_scaling["supportedOptions"]["scalingModes"] = json!(["identity", "custom"]);
        assert!(staged_display_apply_display(
            &staged(vec![no_ordinary_scaling], true),
            device_key,
            &display_key,
            &scaling_mode,
        ).is_none());
    }

    // --- Arc Sync custom refresh window (`arcSyncRange`) --------------------
    //
    // The range transaction, its bounds maths and its frame-time passthrough are
    // fake-backend tested in `backend/display_arc_sync_apply.rs`. These tests pin
    // the wiring `backend/services.rs` owns: the plan slot, the staged admission
    // proof, the seam handoff, and the `perControl.arcSyncRange` verdict.

    type ArcRangeRequest = super::super::display_arc_sync_apply::ArcSyncRangeRequest;

    fn arc_sync_range_custom(min_hz: f32, max_hz: f32) -> ArcRangeRequest {
        ArcRangeRequest::Custom(
            super::super::display_arc_sync_apply::ArcSyncRefreshBounds { min_hz, max_hz },
        )
    }

    /// The transaction shape after a completed SET that read back the exact
    /// window it wrote, i.e. what `arc_sync_range_apply_outcome` receives.
    fn arc_sync_range_matched(
        requested: (f32, f32),
        read_back: (f32, f32),
    ) -> super::super::display_arc_sync_apply::ArcSyncRangeApplyResult {
        use super::super::display_arc_sync_apply as arc;
        arc::ArcSyncRangeApplyResult {
            result: arc::ArcSyncApplyResult {
                ok: true,
                error_code: None,
                message: None,
                read_back: Some(arc::ArcSyncProfile::Custom),
                read_back_equal: true,
                readback_reported: true,
                setter_succeeded: Some(true),
                state_may_have_changed: true,
            },
            evidence: Some(arc::ArcSyncRangeEvidence {
                matched: true,
                requested_min_hz: requested.0,
                requested_max_hz: requested.1,
                read_back_min_hz: read_back.0,
                read_back_max_hz: read_back.1,
            }),
        }
    }

    /// The transaction shape for a driver that accepted the SET but stored a
    /// different window: `ok: false`, `matched: false`, observed values carried.
    fn arc_sync_range_clamped(
        requested: (f32, f32),
        read_back: (f32, f32),
    ) -> super::super::display_arc_sync_apply::ArcSyncRangeApplyResult {
        use super::super::display_arc_sync_apply as arc;
        arc::ArcSyncRangeApplyResult {
            result: arc::ArcSyncApplyResult {
                ok: false,
                error_code: Some("io-failed"),
                message: Some("the driver reported a different refresh window".into()),
                read_back: Some(arc::ArcSyncProfile::Custom),
                read_back_equal: false,
                readback_reported: true,
                setter_succeeded: Some(true),
                state_may_have_changed: true,
            },
            evidence: Some(arc::ArcSyncRangeEvidence {
                matched: false,
                requested_min_hz: requested.0,
                requested_max_hz: requested.1,
                read_back_min_hz: read_back.0,
                read_back_max_hz: read_back.1,
            }),
        }
    }

    /// The transaction's pre-SET refusal shape: `setter_succeeded == None` is the
    /// only signal that stays open to the broker, and no evidence exists because
    /// nothing was read or written.
    fn arc_sync_range_refused(
        code: &'static str,
        message: &str,
    ) -> super::super::display_arc_sync_apply::ArcSyncRangeApplyResult {
        use super::super::display_arc_sync_apply as arc;
        arc::ArcSyncRangeApplyResult {
            result: arc::ArcSyncApplyResult {
                ok: false,
                error_code: Some(code),
                message: Some(message.to_owned()),
                read_back: None,
                read_back_equal: false,
                readback_reported: false,
                setter_succeeded: None,
                state_may_have_changed: false,
            },
            evidence: None,
        }
    }

    /// Requirement: the window is its own plan step, ordered after the boolean
    /// Variable Refresh Rate control, and a composed "Apply all" carrying it is
    /// admitted rather than declined wholesale.
    #[test]
    fn arc_sync_range_plan_step_follows_variable_refresh_rate_and_composes() {
        let single = display_apply_plan(
            json!({ "arcSyncRange": { "minHz": 60.0, "maxHz": 165.0 } })
                .as_object().unwrap(),
        ).expect("a complete Arc Sync window is an owned control");
        assert_eq!(
            single.fields(),
            vec![NativeDisplayApplyField::ArcSyncRange(
                arc_sync_range_custom(60.0, 165.0),
            )],
            "the window is one transaction of its own",
        );
        assert_eq!(
            single.control_keys(),
            vec!["arcSyncRange"],
            "the window answers for itself only, never for the legacy vrrMode profile",
        );

        let composed = display_apply_plan(json!({
            "arcSyncRange": { "minHz": 60.0, "maxHz": 165.0 },
            "globalVrrMode": "fullscreen",
            "quantizationRange": "full",
            "variableRefreshRate": true,
        }).as_object().unwrap()).expect(
            "a floating Apply-all that carries the window beside other controls is admitted",
        );
        assert_eq!(composed.fields(), vec![
            NativeDisplayApplyField::QuantizationRange(2),
            NativeDisplayApplyField::VariableRefreshRate(true),
            NativeDisplayApplyField::ArcSyncRange(arc_sync_range_custom(60.0, 165.0)),
            NativeDisplayApplyField::GlobalVrrMode("fullscreen"),
        ], "the window runs after Variable Refresh Rate, in Electron's execution order");
        assert_eq!(
            composed.control_keys(),
            vec!["quantizationRange", "variableRefreshRate", "arcSyncRange", "globalVrrMode"],
        );

        // `null` is the defined restore and takes the same order slot.
        let restore = display_apply_plan(json!({
            "variableRefreshRate": true,
            "arcSyncRange": null,
        }).as_object().unwrap()).expect("the restore composes with the boolean control");
        assert_eq!(restore.fields(), vec![
            NativeDisplayApplyField::VariableRefreshRate(true),
            NativeDisplayApplyField::ArcSyncRange(ArcRangeRequest::Restore),
        ]);
        assert_eq!(restore.len(), 2);
    }

    /// Requirement: non-finite, `min <= 0` and `max <= min` windows never reach a
    /// writer. JSON numbers are finite, so the range gate is the only place a
    /// degenerate window could become a plan step - and it refuses first.
    #[test]
    fn arc_sync_range_shape_gate_refuses_windows_the_control_cannot_express() {
        use super::super::display_arc_sync_apply::{arc_sync_range_request, ArcSyncRefreshBounds};

        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let refused = [
            json!({ "minHz": 0.0, "maxHz": 120.0 }),
            json!({ "minHz": -0.5, "maxHz": 120.0 }),
            json!({ "minHz": 120.0, "maxHz": 60.0 }),
            json!({ "minHz": 60.0, "maxHz": 60.0 }),
            json!({ "minHz": 60.0 }),
            json!({ "minHz": "60", "maxHz": 120.0 }),
            json!({ "minHz": 60.0, "maxHz": 120.0, "frameTime": 0 }),
            json!([]),
        ];
        for value in refused {
            let patch = json!({ "arcSyncRange": value.clone() });
            assert_eq!(arc_sync_range_request(&value), None, "no admissible window: {value}");
            assert!(
                display_apply_plan(patch.as_object().unwrap()).is_none(),
                "a half-valid window declines the whole request, never a clamped guess: {value}",
            );
            let args = encode_json(&json!([4, {
                "deviceKey": device_key,
                "displayKey": display_key,
                "patch": patch,
            }])).unwrap();
            let mut calls = 0;
            assert!(route_display_apply("display:apply", &args, true, |_, _, _, _| {
                calls += 1;
                Ok(Some(json!({ "unexpected": true })))
            }).is_none(), "the malformed window stays broker-owned: {value}");
            assert_eq!(calls, 0, "zero native writers for a degenerate window: {value}");
        }

        // Non-finite bounds cannot come from JSON but are still refused at the
        // one constructor the plan gate uses, so a NaN/Inf window is unrepresentable.
        assert_eq!(ArcSyncRefreshBounds::new(f32::NAN, 120.0), None);
        assert_eq!(ArcSyncRefreshBounds::new(60.0, f32::INFINITY), None);
        assert_eq!(ArcSyncRefreshBounds::new(f32::NEG_INFINITY, 120.0), None);
        assert_eq!(ArcSyncRefreshBounds::new(0.0, 120.0), None);
        assert_eq!(ArcSyncRefreshBounds::new(120.0, 120.0), None);
        assert_eq!(
            ArcSyncRefreshBounds::new(60.0, 120.0).map(|bounds| (bounds.min_hz, bounds.max_hz)),
            Some((60.0, 120.0)),
            "a real window still parses",
        );
    }

    /// Requirement: the custom write hands the transaction exactly the requested
    /// window, once, and the shaped verdict carries the evidence.
    #[test]
    fn arc_sync_range_step_hands_the_exact_window_to_one_transaction() {
        let plan = display_apply_plan(json!({
            "variableRefreshRate": true,
            "arcSyncRange": { "minHz": 60.0, "maxHz": 165.0 },
        }).as_object().unwrap()).expect("the pair composes in order");

        let mut handed: Option<ArcRangeRequest> = None;
        let mut writer_calls = 0;
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::VariableRefreshRate(enabled) => {
                assert!(*enabled, "the boolean control ran first");
                DisplayStepOutcome::Applied {
                    ok: true,
                    per_control: per_control_single(
                        "variableRefreshRate", json!({ "ok": true })),
                }
            }
            NativeDisplayApplyField::ArcSyncRange(requested) => {
                apply_arc_sync_range_step(*requested, |seen| {
                    writer_calls += 1;
                    handed = Some(seen);
                    arc_sync_range_matched((60.0, 165.0), (60.0, 165.0))
                })
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("the range transaction ran");

        assert_eq!(writer_calls, 1, "one transaction for the whole window");
        // The request carries the profile and its two Hz bounds only: the
        // frame-time bounds are never part of it, so the pre-write GET's own
        // values (0 stays 0) ride the transaction untouched
        // (`display_arc_sync_apply::custom_range_writes_the_custom_profile_...`).
        assert_eq!(handed, Some(arc_sync_range_custom(60.0, 165.0)));

        assert!(run.ok);
        assert_eq!(run.per_control.len(), 2, "one entry per requested control");
        let entry = &run.per_control["arcSyncRange"];
        assert_eq!(entry["ok"], json!(true));
        assert_eq!(entry["matched"], json!(true));
        assert_eq!(entry["requestedMinHz"], json!(60.0));
        assert_eq!(entry["requestedMaxHz"], json!(165.0));
        assert_eq!(entry["readBackMinHz"], json!(60.0));
        assert_eq!(entry["readBackMaxHz"], json!(165.0));
        assert_eq!(entry["readBackEqual"], json!(true));
        assert_eq!(entry["silentNoop"], json!(false));
    }

    /// Requirement: a driver clamp is a visible mismatch, never `ok: true`.
    #[test]
    fn arc_sync_range_outcome_reports_a_driver_clamp_as_a_failed_mismatch() {
        let plan = display_apply_plan(
            json!({ "arcSyncRange": { "minHz": 60.0, "maxHz": 165.0 } })
                .as_object().unwrap(),
        ).expect("the window is owned");
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::ArcSyncRange(requested) => {
                apply_arc_sync_range_step(*requested, |_| {
                    // The setter succeeded; the driver stored a higher floor.
                    arc_sync_range_clamped((60.0, 165.0), (61.0, 165.0))
                })
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("a post-SET mismatch is a native verdict, never a broker retry");

        assert!(!run.ok, "a clamped window never reports success");
        let entry = &run.per_control["arcSyncRange"];
        assert_eq!(entry["ok"], json!(false), "a clamp is never `ok: true`");
        assert_eq!(entry["matched"], json!(false));
        assert_eq!(entry["requestedMinHz"], json!(60.0));
        assert_eq!(entry["requestedMaxHz"], json!(165.0));
        assert_eq!(entry["readBackMinHz"], json!(61.0), "the observed floor is reported");
        assert_eq!(entry["readBackMaxHz"], json!(165.0), "the observed ceiling is reported");
        assert_eq!(entry["readBackEqual"], json!(false));
        assert_eq!(entry["silentNoop"], json!(true));
        assert!(entry["message"].as_str().is_some_and(|message| !message.is_empty()),
            "the mismatch stays readable");
    }

    /// Requirement: a pre-SET refusal (an out-of-window request) never calls a
    /// setter, and the plan returns the request to the broker exactly as every
    /// other control's pre-SET decline does. The refusal's own wording (the
    /// requested window beside the display's real one) is pinned by
    /// `display_arc_sync_apply::out_of_bounds_requests_are_refused_with_the_real_display_window`.
    #[test]
    fn arc_sync_range_pre_set_refusal_keeps_the_request_broker_owned() {
        let plan = display_apply_plan(
            json!({ "arcSyncRange": { "minHz": 30.0, "maxHz": 60.0 } })
                .as_object().unwrap(),
        ).expect("a well-formed window is the plan's to route");

        let out_of_window = "the requested 30 Hz - 60 Hz refresh range is outside this display's 48 Hz - 180 Hz window";
        let refusal = arc_sync_range_refused("out-of-range", out_of_window);
        assert_eq!(refusal.error_code(), Some("out-of-range"));
        assert_eq!(
            refusal.setter_succeeded(),
            None,
            "a bounds refusal stops before the setter",
        );
        assert!(refusal.evidence.is_none(), "nothing was read or written");

        let mut writer_calls = 0;
        assert!(run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::ArcSyncRange(requested) => {
                apply_arc_sync_range_step(*requested, |_| {
                    writer_calls += 1;
                    arc_sync_range_refused("out-of-range", out_of_window)
                })
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).is_none(), "a pre-SET refusal stays open to the broker");
        assert_eq!(writer_calls, 1, "the transaction was consulted once");
        assert_eq!(
            arc_sync_range_refused("unsupported", "no setter").setter_succeeded(),
            None,
            "an unavailable setter is the same pre-SET decline shape",
        );
    }

    /// Requirement: `null` is the restore, admitted without bounds of its own and
    /// written as the recommended profile with the monitor window.
    #[test]
    fn arc_sync_range_restore_writes_the_recommended_profile_with_the_monitor_window() {
        let plan = display_apply_plan(json!({ "arcSyncRange": null }).as_object().unwrap())
            .expect("the restore request is admitted on its own");
        assert_eq!(
            plan.fields(),
            vec![NativeDisplayApplyField::ArcSyncRange(ArcRangeRequest::Restore)],
        );

        let mut handed: Option<ArcRangeRequest> = None;
        let mut writer_calls = 0;
        let run = run_display_plan(&plan, |field| match field {
            NativeDisplayApplyField::ArcSyncRange(requested) => {
                apply_arc_sync_range_step(*requested, |seen| {
                    writer_calls += 1;
                    handed = Some(seen);
                    // RECOMMENDED with the monitor's own window, not the
                    // intersected custom window.
                    let mut restored = arc_sync_range_matched((48.0, 180.0), (48.0, 180.0));
                    restored.result.read_back =
                        Some(super::super::display_arc_sync_apply::ArcSyncProfile::Recommended);
                    restored
                })
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("the restore transaction ran");

        assert_eq!(writer_calls, 1);
        assert_eq!(handed, Some(ArcRangeRequest::Restore), "the seam passes the restore unchanged");
        assert!(run.ok);
        let entry = &run.per_control["arcSyncRange"];
        assert_eq!(entry["ok"], json!(true));
        assert_eq!(entry["matched"], json!(true));
        assert_eq!(entry["requestedMinHz"], json!(48.0), "the monitor window is the written floor");
        assert_eq!(entry["requestedMaxHz"], json!(180.0), "the monitor window is the written ceiling");
    }

    /// Requirement: `perControl.arcSyncRange` is answered on both paths - a
    /// completed apply and the composed case where the plan already wrote and
    /// the range step can no longer be delegated.
    #[test]
    fn arc_sync_range_acknowledgement_is_present_on_success_and_decline() {
        let success_plan = display_apply_plan(
            json!({ "arcSyncRange": { "minHz": 60.0, "maxHz": 165.0 } })
                .as_object().unwrap(),
        ).expect("the window is owned");
        let applied = run_display_plan(&success_plan, |field| match field {
            NativeDisplayApplyField::ArcSyncRange(requested) => {
                apply_arc_sync_range_step(*requested, |_| {
                    arc_sync_range_matched((60.0, 165.0), (60.0, 165.0))
                })
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("the transaction ran");
        let envelope = display_apply_envelope(applied, || {
            Ok(Some(json!({ "displays": [] })))
        }).expect("a fresh state feeds the envelope");
        assert_eq!(
            envelope["perControl"]["arcSyncRange"]["ok"],
            json!(true),
            "a successful window apply answers under its own key",
        );

        // A sibling wrote first, so the range refusal is recorded here instead of
        // being delegated; the control is acknowledged, never silently dropped.
        let composed = display_apply_plan(json!({
            "quantizationRange": "full",
            "arcSyncRange": { "minHz": 60.0, "maxHz": 165.0 },
        }).as_object().unwrap()).expect("both controls are owned");
        let declined = run_display_plan(&composed, |field| match field {
            NativeDisplayApplyField::QuantizationRange(_) => DisplayStepOutcome::Applied {
                ok: true,
                per_control: per_control_single("quantizationRange", json!({ "ok": true })),
            },
            NativeDisplayApplyField::ArcSyncRange(requested) => {
                apply_arc_sync_range_step(*requested, |_| {
                    arc_sync_range_refused("out-of-range", "outside the admitted window")
                })
            }
            other => panic!("unexpected plan step: {other:?}"),
        }).expect("a request that already wrote stays native-owned");

        assert!(!declined.ok);
        assert_eq!(declined.per_control["arcSyncRange"], json!({
            "ok": false,
            "errorCode": "io-failed",
            "message": DISPLAY_CONTROL_NOT_ATTEMPTED_MESSAGE,
        }), "the declined range keeps its own acknowledgement entry");
        assert_eq!(declined.per_control["quantizationRange"]["ok"], json!(true),
            "the sibling keeps its verdict");
    }

    /// Requirement: staged admission needs the complete write contract
    /// (`arcSync.writable`) and an admitted `rangeBounds` window. Either half
    /// missing leaves the row to the renderer's visible reason and stops before
    /// the first SET (this predicate is the only gate before `run_display_plan`).
    #[test]
    fn arc_sync_range_staged_preflight_needs_the_write_contract_and_a_usable_window() {
        let device_key = "pci:0x00008086:0x0000e20b@3:0.0";
        let display_key = format!("{device_key}|display|encoder-a|edid|abcd1234");
        let display = json!({
            "displayKey": display_key,
            "identityVerified": true,
            "flags": { "active": true },
            "supportedOptions": {},
            "arcSync": {
                "supported": true,
                "writable": true,
                "rangeBounds": { "minHz": 48.0, "maxHz": 180.0 },
            },
        });
        let staged = |row: Value| super::super::display::StagedDisplayRead {
            payload: json!({ "deviceKey": device_key, "displays": [row] }),
            scaling_invalidations: Vec::new(),
            native_ownership_eligible: true,
        };
        let custom = NativeDisplayApplyField::ArcSyncRange(arc_sync_range_custom(60.0, 165.0));
        let restore = NativeDisplayApplyField::ArcSyncRange(ArcRangeRequest::Restore);

        let admitted = staged(display.clone());
        assert!(
            staged_display_apply_display(&admitted, device_key, &display_key, &custom).is_some(),
            "a writable row with an admitted window serves the custom range",
        );
        assert!(
            staged_display_apply_display(&admitted, device_key, &display_key, &restore).is_some(),
            "the restore carries no bounds of its own and rides the same row proof",
        );

        let mut no_write_contract = display.clone();
        no_write_contract["arcSync"]["writable"] = json!(false);
        let mut unprojected_contract = display.clone();
        unprojected_contract["arcSync"].as_object_mut().unwrap().remove("writable");
        let mut no_window = display.clone();
        no_window["arcSync"]["rangeBounds"] = Value::Null;
        let mut unprojected_window = display.clone();
        unprojected_window["arcSync"].as_object_mut().unwrap().remove("rangeBounds");
        let mut window_not_an_object = display.clone();
        window_not_an_object["arcSync"]["rangeBounds"] = json!(48.0);
        let mut window_without_ceiling = display.clone();
        window_without_ceiling["arcSync"]["rangeBounds"] = json!({ "minHz": 48.0 });
        let mut degenerate_window = display.clone();
        degenerate_window["arcSync"]["rangeBounds"] = json!({ "minHz": 120.0, "maxHz": 120.0 });
        let mut inverted_window = display.clone();
        inverted_window["arcSync"]["rangeBounds"] = json!({ "minHz": 180.0, "maxHz": 48.0 });
        let mut unreadable_window = display.clone();
        unreadable_window["arcSync"]["rangeBounds"] = json!({ "minHz": "48", "maxHz": 180.0 });

        for (row, why) in [
            (no_write_contract, "Arc Sync is not writable"),
            (unprojected_contract, "the host does not project a write contract"),
            (no_window, "the admitted window is null"),
            (unprojected_window, "the admitted window is absent"),
            (window_not_an_object, "the admitted window is not an object"),
            (window_without_ceiling, "the admitted window has no ceiling"),
            (degenerate_window, "the admitted window is degenerate"),
            (inverted_window, "the admitted window is inverted"),
            (unreadable_window, "the admitted window is unreadable"),
        ] {
            let row = staged(row);
            assert!(
                staged_display_apply_display(&row, device_key, &display_key, &custom).is_none(),
                "{why}: the custom window must be declined before any SET",
            );
            assert!(
                staged_display_apply_display(&row, device_key, &display_key, &restore).is_none(),
                "{why}: the restore rides the same write contract",
            );
        }
    }

    #[test]
    fn graphics_channels_delegate_in_mock_and_unelevated_hosts() {
        // The guard is what keeps a mock or unelevated host from ever reaching
        // the native driver/registry path.
        assert!(!graphics_native_available(true, true));
        assert!(!graphics_native_available(true, false));
        assert!(!graphics_native_available(false, false));
        assert!(graphics_native_available(false, true));

        let (root, store) = fixture();
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        let get = encode_json(&json!([0])).unwrap();
        let apply = encode_json(&json!([0, {"flipMode": "vsync-on"}])).unwrap();
        assert!(invoke("graphics:get", &get, mock).is_none());
        assert!(invoke("graphics:apply", &apply, mock).is_none());
        // The Arc Sleep Base FPS Cap read rides the same guard and gate.
        assert!(invoke("arc-sleep-base-cap-get", &get, mock).is_none());
        // Delegation must not create or touch any durable state.
        assert!(!root.join("settings.json").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn arc_sleep_state_get_is_absent_without_a_native_controller() {
        let (root, store) = fixture();
        let empty = encode_json(&json!([])).unwrap();
        // Mock runs keep Electron ownership.
        let mock = ServiceContext { build_kind: BuildKind::Dev, mock_mode: true, store: &store };
        assert!(invoke("arc-sleep-state-get", &empty, mock).is_none());
        // Lib tests never install the process-wide controller, so the native arm
        // must stay absent rather than answering a fabricated snapshot: Electron
        // starts its controller in exactly this situation (mock, unelevated, or a
        // failed install) and owns the channel.
        assert!(invoke("arc-sleep-state-get", &empty, context(&store)).is_none());
        // The documented fallback shape still exists for the defensive path.
        assert_eq!(
            crate::backend::arc_sleep_controller::unavailable_snapshot()["status"],
            json!("limiter-unavailable")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn graphics_argument_validation_matches_the_electron_messages() {
        let (root, _store) = fixture();
        let error = |payload: Value| match graphics_args("graphics:get", &encode_json(&payload).unwrap()) {
            Ok(_) => String::new(),
            Err(error) => error,
        };
        assert_eq!(error(json!([null])), "invalid device id: null");
        assert_eq!(error(json!(["x"])), "invalid device id: \"x\"");
        assert_eq!(error(json!([-1])), "invalid device id: -1");
        assert_eq!(error(json!([])), "invalid device id: undefined");
        assert_eq!(error(json!([0, null])), "invalid GPU target: expected device key must be a nonempty string");
        assert_eq!(error(json!([0, "  "])), "invalid GPU target: expected device key must be a nonempty string");
        assert_eq!(error(json!([0, "a", "b"])), "graphics:get takes at most a device id and an expected device key");

        let (device_id, key) = graphics_args("graphics:get", &encode_json(&json!([2, "pci:gpu"])).unwrap()).unwrap();
        assert_eq!((device_id, key.as_deref()), (2, Some("pci:gpu")));
        let (device_id, key) = graphics_args("graphics:get", &encode_json(&json!([2])).unwrap()).unwrap();
        assert_eq!((device_id, key), (2, None));

        let (device_id, payload, key) =
            graphics_apply_args("graphics:apply", &encode_json(&json!([1, {"flipMode": "vsync-on"}, "pci:gpu"])).unwrap()).unwrap();
        assert_eq!((device_id, payload, key.as_deref()), (1, json!({"flipMode": "vsync-on"}), Some("pci:gpu")));
        assert_eq!(
            graphics_apply_args("graphics:apply", &encode_json(&json!([1])).unwrap()).unwrap_err(),
            "graphics:apply expects a device id, a settings payload and an optional expected device key"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
