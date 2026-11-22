#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod protocol;
mod transport;
mod lifecycle;
mod runtime;
mod registry_apply_helper;
mod roles;
mod readiness;
mod telemetry;
mod host_shell;
mod tray;
mod recording_status_pill;
mod update_hub;
mod startup_update;
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{BufReader, Write},
    path::PathBuf,
    process::{Child, Stdio},
    sync::{mpsc, Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};

const CONTRACT: &str = include_str!("../generated/bridge-contract.json");
type Reply = Result<Value, String>;

/// The exact exit attribution line. Split from the writer so a test can prove
/// the format without touching stderr.
fn exit_line(reason: &str, code: i32) -> String {
    format!("[exit] reason={reason} code={code}")
}

/// Write the one exit attribution line without ever panicking: a detached
/// console or closed pipe must not change how the host exits. Mirrors
/// `display_log_write` in `backend/services.rs`.
fn exit_log_write(reason: &str, code: i32) {
    use std::io::Write;
    let line = exit_line(reason, code);
    let _ = writeln!(std::io::stderr(), "{line}");
}
struct Writer { stdin: transport::PipeStream, next_id: u64 }
struct Broker {
    session: String,
    writer: Mutex<Option<Writer>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<u64, mpsc::SyncSender<Reply>>>,
    ready: readiness::Readiness,
    permitted: HashSet<String>,
    role_channels: HashMap<String, HashSet<String>>,
    role_events: HashMap<String, HashSet<String>>,
    events: HashSet<String>,
    closing: std::sync::atomic::AtomicBool,
    allow_exit: std::sync::atomic::AtomicBool,
    failed: std::sync::atomic::AtomicBool,
    failure_close_requested: std::sync::atomic::AtomicBool,
    maintenance_pending: std::sync::atomic::AtomicBool,
    maintenance_boot_ready: std::sync::atomic::AtomicBool,
    maintenance_native_boot_ready: std::sync::atomic::AtomicBool,
    startup_reconcile_ready: std::sync::atomic::AtomicBool,
    active_invocations: std::sync::atomic::AtomicUsize,
    tray_available: std::sync::atomic::AtomicBool,
    host_events: mpsc::SyncSender<(String, String, Value)>,
    telemetry: Arc<telemetry::TelemetryHub>,
    stability: Option<Arc<arc_power_tauri::backend::stability_runtime::StabilityRuntime>>,
    recording: Arc<arc_power_tauri::backend::recording_hub::RecordingHub>,
    recording_status_pill: Option<Arc<recording_status_pill::RecordingStatusPill>>,
    fan_resume: Arc<arc_power_tauri::backend::fan_resume::FanResumeHub>,
    device_selection: Arc<arc_power_tauri::backend::device_selection::DeviceSelectionHub>,
    rtss_osd: Arc<arc_power_tauri::backend::rtss_osd::RtssOsdHub>,
    advanced_overlay: Option<Arc<arc_power_tauri::backend::advanced_overlay::AdvancedOverlayHub>>,
    arc_sleep: Option<Arc<arc_power_tauri::backend::arc_sleep_controller::ArcSleepController>>,
    native_store: Arc<arc_power_tauri::backend::native_store::NativeStore>,
    apply_transactions: Arc<arc_power_tauri::backend::apply_transaction::ApplyTransactionCoordinator>,
    startup_update: Arc<startup_update::StartupUpdateCoordinator>,
    startup_splash_ready: std::sync::atomic::AtomicBool,
    last_store_request: std::sync::atomic::AtomicU64,
    build_kind: arc_power_tauri::backend::native_system::BuildKind,
    mock_mode: bool,
}

#[derive(Clone)]
struct ActiveInvocation(Arc<ActiveInvocationLease>);

struct ActiveInvocationLease(Arc<Broker>);

impl Drop for ActiveInvocationLease {
    fn drop(&mut self) {
        self.0.active_invocations.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

fn begin_active_invocation(broker: &Arc<Broker>) -> Result<ActiveInvocation, String> {
    use std::sync::atomic::Ordering::SeqCst;
    if broker.maintenance_pending.load(SeqCst) {
        return Err("Arc Power is restarting for maintenance".into());
    }
    broker.active_invocations.fetch_add(1, SeqCst);
    if broker.maintenance_pending.load(SeqCst) {
        broker.active_invocations.fetch_sub(1, SeqCst);
        return Err("Arc Power is restarting for maintenance".into());
    }
    Ok(ActiveInvocation(Arc::new(ActiveInvocationLease(broker.clone()))))
}

fn wait_startup_reconcile_ready(broker: &Broker) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(35);
    while !broker.startup_reconcile_ready.load(std::sync::atomic::Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return Err("Native startup registration repair did not finish; maintenance was cancelled".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Ok(())
}

/// Clear only the WebView2 cache, using the native relaunch helper. Durable
/// data resets use the separate maintenance route below.
fn clear_cache_and_relaunch(app: &tauri::AppHandle, broker: &Arc<Broker>, args: &Value) -> Reply {
    match arc_power_tauri::backend::wire::decode(args)? {
        arc_power_tauri::backend::wire::WireValue::Array(items) if items.is_empty() => {}
        arc_power_tauri::backend::wire::WireValue::Array(_) => {
            return Err("app:clear-cache-restart does not accept a payload".into());
        }
        _ => return Err("Expected argument array".into()),
    }
    broker.wait_channel_ready("app:clear-cache-restart")?;
    use std::sync::atomic::Ordering::SeqCst;
    let startup_deadline = Instant::now() + Duration::from_secs(35);
    while !broker.maintenance_boot_ready.load(SeqCst) || !broker.maintenance_native_boot_ready.load(SeqCst) {
        if Instant::now() >= startup_deadline {
            return Err("Arc Power startup checks did not finish; cache maintenance was cancelled".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    wait_startup_reconcile_ready(broker)?;
    if broker.maintenance_pending.compare_exchange(false, true, SeqCst, SeqCst).is_err() {
        return Err("Arc Power maintenance is already in progress".into());
    }

    let download_root = broker.native_store.root().to_path_buf();
    if let Err(error) = arc_power_tauri::backend::intel_driver_download::IntelDriverDownloadService::quiesce_shared(
        &download_root, Duration::from_secs(25)) {
        let _ = arc_power_tauri::backend::intel_driver_download::IntelDriverDownloadService::resume_shared(&download_root);
        broker.maintenance_pending.store(false, SeqCst);
        return Err(error);
    }
    arc_power_tauri::backend::postprocess_sharpening::quiesce_shared();

    // The gate rejects new renderer work. Drain all requests accepted before
    // it, including compatibility callbacks, before handing off the relaunch.
    let deadline = Instant::now() + Duration::from_secs(16);
    loop {
        let pending_empty = match broker.pending.lock() {
            Ok(pending) => pending.is_empty(),
            Err(_) => {
                let _ = arc_power_tauri::backend::intel_driver_download::IntelDriverDownloadService::resume_shared(&download_root);
                broker.maintenance_pending.store(false, SeqCst);
                return Err("Broker request queue is unavailable during maintenance".into());
            }
        };
        if broker.active_invocations.load(SeqCst) == 0 && pending_empty { break; }
        if Instant::now() >= deadline {
            let _ = arc_power_tauri::backend::intel_driver_download::IntelDriverDownloadService::resume_shared(&download_root);
            broker.maintenance_pending.store(false, SeqCst);
            return Err("Arc Power requests did not drain; cache maintenance was cancelled".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let mut relaunch_args: Vec<String> = std::env::args().skip(1)
        .filter(|arg| arg == "--profile-boot")
        .collect();
    relaunch_args.push("--clear-cache".into());
    if let Err(error) = lifecycle::spawn_relaunch_waiter(relaunch_args) {
        let _ = arc_power_tauri::backend::intel_driver_download::IntelDriverDownloadService::resume_shared(&download_root);
        broker.maintenance_pending.store(false, SeqCst);
        return Err(error);
    }

    broker.allow_exit.store(true, SeqCst);
    exit_log_write("native-clear-cache-restart", 0);
    app.exit(0);
    arc_power_tauri::backend::wire::encode_json(&json!({"ok":true,"restarting":true}))
}

fn maintenance_action(args: &Value) -> Result<&'static str, String> {
    let arc_power_tauri::backend::wire::WireValue::Array(items) =
        arc_power_tauri::backend::wire::decode(args)? else {
            return Err("Expected argument array".into());
        };
    if items.len() != 1 { return Err("app:maintenance-restart requires a valid maintenance action".into()); }
    let arc_power_tauri::backend::wire::WireValue::String(action) = &items[0] else {
        return Err("app:maintenance-restart requires a valid maintenance action".into());
    };
    match action.as_str() {
        "clear-cache" => Ok("clear-cache"),
        "reset" => Ok("reset"),
        "reset-with-drivers" => Ok("reset-with-drivers"),
        _ => Err("app:maintenance-restart requires a valid maintenance action".into()),
    }
}

fn clear_rtss_boot_preference(store: &arc_power_tauri::backend::native_store::NativeStore) -> Result<(), String> {
    arc_power_tauri::backend::settings_patch::with_save_queue(|| {
        let encoded = arc_power_tauri::backend::wire::encode_json(&json!([]))?;
        let loaded = store.invoke("load-settings", &encoded)?;
        let mut settings = arc_power_tauri::backend::wire::decode(&loaded)?.into_json()?;
        if settings.as_object().is_some() && settings.get("rtssOnBoot").and_then(Value::as_bool) == Some(true) {
            settings["rtssOnBoot"] = json!(false);
            let encoded = arc_power_tauri::backend::wire::encode_json(&json!([settings]))?;
            store.invoke("save-settings", &encoded)?;
        }
        Ok(())
    })
}

fn restore_rtss_boot_preference(
    store: &arc_power_tauri::backend::native_store::NativeStore,
    previous: Option<bool>,
) -> Result<(), String> {
    let Some(previous) = previous else { return Ok(()); };
    arc_power_tauri::backend::settings_patch::with_save_queue(|| {
        let encoded = arc_power_tauri::backend::wire::encode_json(&json!([]))?;
        let loaded = store.invoke("load-settings", &encoded)?;
        let mut settings = arc_power_tauri::backend::wire::decode(&loaded)?.into_json()?;
        if settings.as_object().is_some() && settings.get("rtssOnBoot").and_then(Value::as_bool) != Some(previous) {
            settings["rtssOnBoot"] = json!(previous);
            let encoded = arc_power_tauri::backend::wire::encode_json(&json!([settings]))?;
            store.invoke("save-settings", &encoded)?;
        }
        Ok(())
    })
}

#[derive(Clone, Debug)]
struct MaintenanceCleanupSnapshot {
    startup: arc_power_tauri::backend::startup::RegistrationSnapshot,
    legacy_startup: arc_power_tauri::backend::startup::LegacyRegistrationSnapshot,
    rtss_run_value: Option<String>,
    boot_apply_task: Option<Vec<u8>>,
    rtss_on_boot: Option<bool>,
}

fn snapshot_maintenance_cleanup(broker: &Broker) -> Result<MaintenanceCleanupSnapshot, String> {
    let settings_args = arc_power_tauri::backend::wire::encode_json(&json!([]))?;
    let settings_reply = broker.native_store.invoke("load-settings", &settings_args)?;
    let settings = arc_power_tauri::backend::wire::decode(&settings_reply)?.into_json()?;
    Ok(MaintenanceCleanupSnapshot {
        startup: arc_power_tauri::backend::startup::registration_snapshot(broker.build_kind)?,
        legacy_startup: arc_power_tauri::backend::startup::legacy_registration_snapshot()?,
        rtss_run_value: arc_power_tauri::backend::rtss_startup::registration_snapshot()?,
        boot_apply_task: arc_power_tauri::backend::startup::boot_apply_task_snapshot()?,
        rtss_on_boot: settings.get("rtssOnBoot").and_then(Value::as_bool),
    })
}

fn rollback_maintenance_cleanup(broker: &Broker, snapshot: &MaintenanceCleanupSnapshot) -> Vec<String> {
    let mut failures = Vec::new();
    let mut attempt = |label: &str, result: Result<(), String>| {
        if let Err(error) = result { failures.push(format!("{label}: {error}")); }
    };
    attempt("Legacy startup registrations", arc_power_tauri::backend::startup::restore_legacy_registration(
        &snapshot.legacy_startup));
    attempt("Arc Power startup registration", arc_power_tauri::backend::startup::restore_registration(
        broker.build_kind, snapshot.startup.clone()));
    attempt("RTSS boot preference", restore_rtss_boot_preference(&broker.native_store, snapshot.rtss_on_boot));
    attempt("ArcPowerBootApply task", arc_power_tauri::backend::startup::restore_boot_apply_task(
        snapshot.boot_apply_task.as_deref()));
    attempt("RTSS startup registration", arc_power_tauri::backend::rtss_startup::restore_registration(
        snapshot.rtss_run_value.as_deref()));
    drop(attempt);
    failures
}

fn maintenance_abort_before_teardown(broker: &Broker, download_root: &std::path::Path, error: String) -> Reply {
    match arc_power_tauri::backend::intel_driver_download::IntelDriverDownloadService::resume_shared(download_root) {
        Ok(()) => {
            broker.maintenance_pending.store(false, std::sync::atomic::Ordering::SeqCst);
            Err(error)
        }
        Err(resume_error) => Err(format!("{error}; driver downloads could not resume, so Arc Power remains quiesced: {resume_error}")),
    }
}

fn maintenance_abort_with_rollback(
    broker: &Broker,
    download_root: &std::path::Path,
    snapshot: &MaintenanceCleanupSnapshot,
    error: String,
) -> Reply {
    let mut failures = rollback_maintenance_cleanup(broker, snapshot);
    if let Err(error) = arc_power_tauri::backend::intel_driver_download::IntelDriverDownloadService::resume_shared(download_root) {
        failures.push(format!("driver download service: {error}"));
    }
    if failures.is_empty() {
        broker.maintenance_pending.store(false, std::sync::atomic::Ordering::SeqCst);
        Err(error)
    } else {
        Err(format!("{error}; rollback also failed, so Arc Power remains quiesced: {}", failures.join("; ")))
    }
}

fn show_maintenance_reset_failure(error: &str) {
    let body = format!(
        "Arc Power could not finish resetting saved data. Some saved data may already have been removed. Arc Power will restart with the remaining data after clearing its WebView2 cache.\n\nDetails: {error}"
    );
    #[cfg(windows)] {
        let title: Vec<u16> = "Arc Power reset incomplete\0".encode_utf16().collect();
        let text: Vec<u16> = body.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x00000010); }
    }
    #[cfg(not(windows))]
    eprintln!("Arc Power reset incomplete: {body}");
}

/// Reset actions are fully prepared before the compatibility child is stopped.
/// The relaunch waiter is started before teardown so a late reset I/O failure
/// still returns the user to a fresh host with only the WebView2 cache cleared.
fn maintenance_and_relaunch(app: &tauri::AppHandle, broker: &Arc<Broker>, args: &Value) -> Reply {
    let action = maintenance_action(args)?;
    broker.wait_channel_ready("app:maintenance-restart")?;
    use std::sync::atomic::Ordering::SeqCst;
    let startup_deadline = Instant::now() + Duration::from_secs(35);
    while !broker.maintenance_boot_ready.load(SeqCst) || !broker.maintenance_native_boot_ready.load(SeqCst) {
        if Instant::now() >= startup_deadline {
            return Err("Arc Power startup checks did not finish; maintenance was cancelled".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    wait_startup_reconcile_ready(broker)?;
    if broker.maintenance_pending.compare_exchange(false, true, SeqCst, SeqCst).is_err() {
        return Err("Arc Power maintenance is already in progress".into());
    }

    let download_root = broker.native_store.root().to_path_buf();
    if let Err(error) = arc_power_tauri::backend::intel_driver_download::IntelDriverDownloadService::quiesce_shared(
        &download_root, Duration::from_secs(25)) {
        return maintenance_abort_before_teardown(broker, &download_root, error);
    }
    let drain_deadline = Instant::now() + Duration::from_secs(16);
    loop {
        let pending_empty = match broker.pending.lock() {
            Ok(pending) => pending.is_empty(),
            Err(_) => return maintenance_abort_before_teardown(
                broker, &download_root, "Broker request queue is unavailable during maintenance".into()),
        };
        if broker.active_invocations.load(SeqCst) == 0 && pending_empty { break; }
        if Instant::now() >= drain_deadline {
            return maintenance_abort_before_teardown(
                broker, &download_root, "Arc Power requests did not drain; maintenance was cancelled".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }

    let reset = action != "clear-cache";
    let app_data_root = if reset {
        let Some(root) = std::env::var_os("APPDATA").map(PathBuf::from) else {
            return maintenance_abort_before_teardown(broker, &download_root, "APPDATA is required for Arc Power data reset".into());
        };
        if !root.is_absolute() {
            return maintenance_abort_before_teardown(broker, &download_root, "APPDATA must be an absolute path for Arc Power data reset".into());
        }
        Some(root)
    } else { None };

    let cleanup_snapshot = if let Some(root) = app_data_root.as_ref() {
        let include_driver_downloads = action == "reset-with-drivers";
        if let Err(error) = lifecycle::preflight_arc_power_data_reset_at(root, include_driver_downloads) {
            return maintenance_abort_before_teardown(broker, &download_root, error);
        }
        match snapshot_maintenance_cleanup(broker) {
            Ok(snapshot) => Some(snapshot),
            Err(error) => return maintenance_abort_before_teardown(broker, &download_root, error),
        }
    } else { None };

    if reset {
        if let Err(error) = arc_power_tauri::backend::rtss_startup::set(false) {
            return maintenance_abort_with_rollback(broker, &download_root,
                cleanup_snapshot.as_ref().expect("reset cleanup snapshot"), error);
        }
        if let Err(error) = arc_power_tauri::backend::startup::remove_boot_apply_task() {
            return maintenance_abort_with_rollback(broker, &download_root,
                cleanup_snapshot.as_ref().expect("reset cleanup snapshot"), error);
        }
        if let Err(error) = clear_rtss_boot_preference(&broker.native_store) {
            return maintenance_abort_with_rollback(broker, &download_root,
                cleanup_snapshot.as_ref().expect("reset cleanup snapshot"), error);
        }
        if let Err(error) = arc_power_tauri::backend::startup::set_registration(broker.build_kind, false) {
            return maintenance_abort_with_rollback(broker, &download_root,
                cleanup_snapshot.as_ref().expect("reset cleanup snapshot"), error);
        }
    }

    let mut relaunch_args: Vec<String> = std::env::args().skip(1)
        .filter(|arg| arg == "--profile-boot")
        .collect();
    relaunch_args.push("--clear-cache".into());
    // A post-teardown reset error is reported in a modal dialog before this
    // process exits, so the maintenance helper must not time out while the
    // user is reading it.
    if let Err(error) = lifecycle::spawn_relaunch_waiter_indefinite(relaunch_args) {
        if let Some(snapshot) = cleanup_snapshot.as_ref() {
            return maintenance_abort_with_rollback(broker, &download_root, snapshot, error);
        }
        return maintenance_abort_before_teardown(broker, &download_root, error);
    }

    arc_power_tauri::backend::postprocess_sharpening::quiesce_shared();
    broker.shutdown();
    let reset_result = if let Some(app_data_root) = app_data_root {
        lifecycle::reset_arc_power_data_at(&app_data_root, action == "reset-with-drivers").map(|_| ())
    } else { Ok(()) };
    broker.allow_exit.store(true, SeqCst);
    match reset_result {
        Ok(()) => {
            exit_log_write("native-maintenance-restart", 0);
            app.exit(0);
            arc_power_tauri::backend::wire::encode_json(&json!({"ok":true,"restarting":true}))
        }
        Err(error) => {
            eprintln!("[maintenance] data reset failed after teardown: {error}");
            show_maintenance_reset_failure(&error);
            exit_log_write("native-maintenance-reset-failed", 1);
            app.exit(1);
            Err(error)
        }
    }
}

fn contract_set(contract: &Value, field: &str) -> HashSet<String> {
    contract[field].as_array().expect("generated bridge contract").iter().map(|v| v.as_str().unwrap().to_owned()).collect()
}

/// Native auxiliary windows are not registry proxies. Forward their
/// unmigrated channels through the main proxy, which owns the broker-ready
/// channel manifest.
fn broker_forward_target(role: &str, label: &str, mock_mode: bool) -> String {
    if !mock_mode && role == "advanced-overlay" { "main".into() } else { label.to_owned() }
}

/// Run the native main-window close bridge action. Mock runs and other window
/// roles keep the compatibility service's existing close handling.
fn native_window_close_request(
    channel: &str,
    role: &str,
    mock_mode: bool,
    args: &Value,
    handle_close: impl FnOnce() -> bool,
    on_failure: impl FnOnce(),
) -> Result<Option<Value>, String> {
    if mock_mode || role != "main" || channel != "window-close" { return Ok(None); }
    let arc_power_tauri::backend::wire::WireValue::Array(payloads) =
        arc_power_tauri::backend::wire::decode(args)? else {
            return Err("Expected argument array".into());
        };
    if !payloads.is_empty() { return Err("window-close takes no payload".into()); }
    if !handle_close() {
        on_failure();
        return Err("window-close: the close event could not be queued; service shutdown was requested".into());
    }
    Ok(Some(json!({"t":"undefined"})))
}

/// Match the product close behavior: only literal `true` plus a successfully
/// created tray icon hides the main window. A missing cache, malformed value,
/// failed read, or unavailable tray uses normal close.
fn close_to_tray_enabled(broker: &Broker) -> bool {
    broker.tray_available.load(std::sync::atomic::Ordering::SeqCst)
        && broker.native_store.settings_store().load_settings_sync().ok().flatten()
            .is_some_and(|settings| settings.get("closeToTray").and_then(Value::as_bool) == Some(true))
}

/// Let normal product exits pass the `ExitRequested` guard and run the common
/// `RunEvent::Exit` shutdown cleanup.
fn request_controlled_host_exit(app: &tauri::AppHandle, broker: &Broker) {
    broker.allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
    exit_log_write("host-exit", 0);
    app.exit(0);
}

/// Apply the product close policy to the main window only. Transport failures
/// retain the bounded cleanup path, which drains or terminates the broker.
fn handle_native_main_close(app: &tauri::AppHandle, window: &tauri::WebviewWindow, broker: &Arc<Broker>) {
    if broker.allow_exit.load(std::sync::atomic::Ordering::SeqCst) { return; }
    if broker.failed.load(std::sync::atomic::Ordering::SeqCst) {
        broker.close_failed(app.clone());
        return;
    }
    if close_to_tray_enabled(broker) {
        match window.hide() {
            Ok(()) => broker.host_event_to("main", "hide", json!({})),
            Err(error) => {
                eprintln!("[window-close] could not hide the main window: {error}");
                request_controlled_host_exit(app, broker);
            }
        }
    } else {
        request_controlled_host_exit(app, broker);
    }
}

/// Main-targeted broker events also reach live Advanced Overlay panels when the
/// event is authorized for the `advanced-overlay` role. Other roles never
/// receive this fan-out.
fn advanced_overlay_event_targets<'a>(channel: &str, mock_mode: bool,
    role_events: &HashMap<String, HashSet<String>>,
    labels: impl IntoIterator<Item = &'a String>) -> Vec<String> {
    if mock_mode || !role_events.get("advanced-overlay")
        .is_some_and(|events| events.contains(channel)) {
        return Vec::new();
    }
    labels.into_iter()
        .filter(|label| roles::role(label) == Some("advanced-overlay"))
        .cloned().collect()
}

/// Role-targeted native event sink. One place owns the label/role fan-out, so
/// a new pushed channel only has to appear in `device_selection::target_roles`.
fn role_event_sink(app: tauri::AppHandle) -> impl Fn(&str, Value) + Send + Sync + 'static {
    move |channel: &str, args: Value| {
        let targets = arc_power_tauri::backend::device_selection::target_roles(channel);
        if targets.is_empty() { return; }
        for (label, _window) in app.webview_windows() {
            if roles::role(&label).is_some_and(|role| targets.contains(&role)) {
                let _ = app.emit_to(label.as_str(), "arc-power:broker-event",
                    json!({"channel": channel, "args": args.clone()}));
            }
        }
    }
}

/// `stability:status` is a main-window-only push. Keeping the target and the
/// broker-event envelope in one helper makes that scope testable without an
/// AppHandle.
fn stability_status_target() -> &'static str { "main" }

fn stability_status_event(status: &Value) -> Value {
    let args = arc_power_tauri::backend::wire::encode_json(&json!([status]))
        .unwrap_or_else(|_| json!({"t":"array","v":[]}));
    json!({"channel":"stability:status","args":args})
}

fn recording_snapshot_due(last: Option<Instant>, now: Instant) -> bool {
    last.map_or(true, |last| now.duration_since(last) >= Duration::from_millis(250))
}

fn prefer_latest_recording_state(snapshot: Option<Value>, event: Value) -> Value {
    snapshot.unwrap_or(event)
}

fn recording_pill_enabled(settings: Result<Value, String>) -> bool {
    settings.ok().is_some_and(|settings|
        settings.get("overlayRecordingPill").and_then(Value::as_bool) == Some(true))
}

fn recording_pill_enabled_value(settings: &Value) -> bool {
    settings.get("overlayRecordingPill").and_then(Value::as_bool) == Some(true)
}

fn wait_for_device_manifest_before_renderer_ready(role: Option<&str>, native_pill_owner: bool) -> bool {
    role != Some("splash") && !(role == Some("recording-status-pill") && native_pill_owner)
}

fn native_stability_resolve(device_key: &str) -> Option<Value> {
    let devices = arc_power_tauri::backend::gpu_devices::list_devices_merged();
    let rows = devices.as_array().cloned().unwrap_or_default();
    arc_power_tauri::backend::stability_runtime::match_device_by_key(&rows, device_key)
}

fn native_stability_settings(target: &Value) -> Value {
    let Some(device_id) = target.get("id").and_then(Value::as_u64) else { return json!({}); };
    let Some(path) = arc_power_tauri::backend::gpu_devices::locate_dll() else { return json!({}); };
    let (mut settings, control_units) =
        arc_power_tauri::backend::gpu_capabilities::current_settings_with_units(&path, device_id)
            .unwrap_or_else(|_| (json!({}), Value::Null));
    if !settings.is_object() { settings = json!({}); }
    let name = target.get("name").and_then(Value::as_str).unwrap_or("");
    let power_limits = arc_power_tauri::backend::services::read_power_limits_for_device(device_id);
    let threshold_inputs = arc_power_tauri::backend::stability_runtime::device_threshold_inputs(
        name,
        &settings,
        control_units["powerLimitW"].as_str(),
        control_units["tempLimitC"].as_str(),
        &power_limits,
    );
    settings["stabilityThresholdInputs"] = threshold_inputs;
    // The snapshot keeps the driver's raw value under `powerLimitW`, which on
    // Battlemage is a percentage. Record the real units (and the derived watts
    // when the board reference is known) so the persisted report cannot read
    // 100 % as 100 W.
    if let Value::Object(fields) =
        arc_power_tauri::backend::stability_runtime::snapshot_unit_fields(name, &settings, &control_units)
    {
        for (key, value) in fields { settings[key] = value; }
    }
    settings
}

fn native_stability_sample(target: &Value, telemetry: &telemetry::TelemetryHub,
    rtss: &arc_power_tauri::backend::rtss_osd::RtssOsdHub) -> Value {
    let received_at = arc_power_tauri::backend::platform_context::clock_snapshot()
        .map(|clock| clock.now_ms).unwrap_or(0.0);
    let Some(device_id) = target.get("id").and_then(Value::as_u64) else {
        return json!({"receivedAtMs":received_at,"readError":"selected device is unavailable"});
    };
    let sample = telemetry.latest_for_device(device_id);
    let mut keys = std::collections::HashSet::new();
    if let Some(key) = target.get("deviceKey").and_then(Value::as_str) { keys.insert(key.to_owned()); }
    for key in target.get("deviceKeys").and_then(Value::as_array).into_iter().flatten() {
        if let Some(key) = key.as_str() { keys.insert(key.to_owned()); }
    }
    let identity_matches = sample.as_ref().is_some_and(|sample| {
        sample.get("deviceKey").and_then(Value::as_str).is_none_or(|key| keys.contains(key))
    });
    let foreground = rtss.foreground_metrics();
    let fps = foreground.get("fps").and_then(Value::as_f64);
    let fps_sample = if fps.is_some() || !foreground["api"].is_null() {
        json!({
            "fps":fps,
            "api":foreground.get("api").cloned().unwrap_or(Value::Null),
            "frameTimeMs":foreground.get("frameTimeMs").cloned().unwrap_or(Value::Null),
        })
    } else { Value::Null };
    let foreground_process = foreground.get("pid").and_then(Value::as_u64)
        .map(|pid| json!({"pid":pid})).unwrap_or(Value::Null);
    let read_error = if sample.is_none() { Some("telemetry sample unavailable") }
        else if !identity_matches { Some("telemetry sample identity mismatch") }
        else { None };
    json!({
        "sample":if identity_matches { sample } else { None::<Value> },
        "receivedAtMs":received_at,
        "fpsSample":fps_sample,
        "foregroundProcess":foreground_process,
        "readError":read_error,
    })
}

/// The `settings-cache` payload: the WHOLE settings snapshot, never a diff, so
/// the compatibility service can replace its cache in one step.
fn settings_cache_payload(settings: Option<Value>) -> Option<Value> {
    Some(json!({ "settings": settings? }))
}

/// Phase 2 of `profiles-settings-save`: a native save is invisible to the
/// compatibility service's `NativeProfileStore._settingsCache`, which supplies
/// the Electron/mock close policy, the toast gate and the compatibility
/// recording pill. After a landed save the host pushes the cache snapshot so
/// those readers see the saved values. The snapshot is an in-memory blocking
/// lock (no I/O) and the event is fire-and-forget: a dropped push never fails
/// or delays the save.
///
/// The native layout dispatcher reuses the same push for the same reason: its
/// transaction's committed snapshot is what the compatibility service needs to
/// resume as this request's layout defaults and as its own overlay baseline.
fn push_settings_cache(broker: &Broker) {
    // In packaged native-only runs there is no Electron NativeProfileStore
    // cache to update; cloning and forwarding a whole settings snapshot on
    // every save is pure waste. Dev/mock runs still need it for parity.
    if broker.writer.lock().unwrap().is_none() { return; }
    let settings = broker.native_store.settings_store().load_settings_sync().ok().flatten();
    if let Some(payload) = settings_cache_payload(settings) {
        broker.host_event("settings-cache", payload);
    }
}

/// After a landed native layout request: publish the transaction's own settings
/// snapshot, then refresh the surface that re-renders from it.
///
/// `ipc-core.js` publishes the committed snapshot inside its layout queue before
/// it re-applies the selected layout, so no reader can observe the reply without
/// the settings it produced. The native transaction holds the layout and
/// settings locks across both writes, so the snapshot published here is that
/// transaction's output rather than a later writer's. Rename and the snapshot
/// read never apply a layout and skip the refresh. Both steps are best effort
/// and never change the reply.
///
/// The advanced overlay panel is refreshed natively: it publishes the panel
/// payload from the settings document and re-applies its geometry, which is the
/// reaction the compatibility service performs. The software HUD envelope stays
/// with the compatibility service (its apply owns the Electron overlay window),
/// so an open classic HUD keeps its previous geometry until the next
/// settings-driven apply.
fn publish_layout_reaction(broker: &Broker, channel: &str) {
    push_settings_cache(broker);
    if arc_power_tauri::backend::overlay_layout_channels::applies_layout(channel) {
        if let Some(service) = broker.advanced_overlay.as_ref() { service.poll(); }
    }
}

/// Run the bounded registration reload and settings poll only after a
/// successful Electron-owned settings save in a normal Tauri run.
fn refresh_after_settings_save<Reload: FnOnce() -> (), Poll: FnOnce() -> ()>(channel: &str,
    mock_mode: bool, result: &Result<Value, String>, reload: Reload, poll: Poll) {
    if !mock_mode && channel == "profiles-settings-save" && result.is_ok() {
        reload();
        poll();
    }
}

/// Native aux windows are labelled by role plus a unique generation. The
/// compatibility broker's own counter starts near one million; use a high
/// numeric range so the two creators cannot collide.
static NEXT_ADVANCED_OVERLAY_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(1_000_000_000_000);

fn next_advanced_overlay_label(app: &tauri::AppHandle) -> String {
    loop {
        let generation = NEXT_ADVANCED_OVERLAY_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let label = format!("advanced-overlay-{generation}");
        if app.get_webview_window(&label).is_none() { return label; }
    }
}

fn primary_display_bounds(app: &tauri::AppHandle) -> arc_power_tauri::backend::advanced_overlay::DisplayBounds {
    use arc_power_tauri::backend::advanced_overlay::display_bounds_dip;
    match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let scale = monitor.scale_factor();
            let position = monitor.position();
            let size = monitor.size();
            display_bounds_dip(position.x, position.y, size.width, size.height, scale)
        }
        _ => display_bounds_dip(0, 0, 1920, 1080, 1.0),
    }
}

struct NativeAdvancedOverlayWindows { app: tauri::AppHandle }impl NativeAdvancedOverlayWindows {
    fn windows(&self) -> Vec<(String, tauri::WebviewWindow)> {
        let mut windows: Vec<_> = self.app.webview_windows().into_iter()
            .filter(|(label, _)| roles::role(label) == Some("advanced-overlay"))
            .collect();
        windows.sort_by(|left, right| left.0.cmp(&right.0));
        windows
    }
}

impl arc_power_tauri::backend::advanced_overlay::PanelWindows for NativeAdvancedOverlayWindows {    fn panels(&self) -> Vec<arc_power_tauri::backend::advanced_overlay::PanelSnapshot> {
        use arc_power_tauri::backend::advanced_overlay::{PanelBounds, PanelSnapshot};
        self.windows().into_iter().map(|(label, window)| {
            let scale = window.scale_factor().unwrap_or(1.0);
            let position = window.outer_position().ok().map(|value| value.to_logical::<f64>(scale));
            let size = window.inner_size().ok().map(|value| value.to_logical::<f64>(scale));
            let bounds = position.zip(size).map(|(position, size)| PanelBounds {
                x: position.x, y: position.y, width: size.width, height: size.height,
            }).unwrap_or(PanelBounds { x: 0.0, y: 0.0, width: 0.0, height: 0.0 });
            PanelSnapshot { label, visible: window.is_visible().unwrap_or(false), bounds }
        }).collect()
    }

    fn create(&self, geometry: &arc_power_tauri::backend::advanced_overlay::PanelGeometry, theme: &str) -> Result<(), String> {
        let label = next_advanced_overlay_label(&self.app);
        create_auxiliary_window(&self.app, &label, "advanced-overlay",
            geometry.x, geometry.y, geometry.width.max(1.0), geometry.height.max(1.0), Some(theme)).map(|_| ())
    }

    fn show(&self) {
        for (_, window) in self.windows() {
            let _ = window.show();
            let _ = window.set_always_on_top(true);
        }
    }

    fn hide(&self) {
        for (_, window) in self.windows() { let _ = window.hide(); }
    }

    fn destroy(&self) {
        for (_, window) in self.windows() { let _ = window.destroy(); }
    }

    fn set_bounds(&self, geometry: &arc_power_tauri::backend::advanced_overlay::PanelGeometry) {
        for (_, window) in self.windows() {
            let _ = window.set_position(tauri::LogicalPosition::new(geometry.x, geometry.y));
            let _ = window.set_size(tauri::LogicalSize::new(
                geometry.width.max(1.0), geometry.height.max(1.0)));
        }
    }

    fn emit_settings(&self, payload: &Value) {
        let args = arc_power_tauri::backend::wire::encode_json(&json!([payload]))
            .unwrap_or_else(|_| json!({"t":"array","v":[]}));
        for (label, _) in self.windows() {
            let _ = self.app.emit_to(label.as_str(), "arc-power:broker-event", json!({
                "channel": arc_power_tauri::backend::advanced_overlay::SETTINGS_CHANNEL,
                "args": args,
            }));
        }
    }
}

/// Arc Sleep policy inputs the native host can observe: the renderer's main
/// telemetry lane and the RTSS foreground rows. Nothing here writes state.
struct NativeSleepEnvironment {
    telemetry: Arc<telemetry::TelemetryHub>,
    rtss: Arc<arc_power_tauri::backend::rtss_osd::RtssOsdHub>,
}

impl arc_power_tauri::backend::arc_sleep_system::SleepEnvironment for NativeSleepEnvironment {
    fn latest_sample(&self, device_id: u64) -> Option<Value> {
        self.telemetry.latest_for_device(device_id)
    }
    fn foreground_metrics(&self) -> Value { self.rtss.foreground_metrics() }
}

impl Broker {
    fn start(app: tauri::AppHandle) -> Result<Arc<Self>, String> {        // Development-only compatibility runtime is supplied by the launcher,
        // never by renderer parameters. Distribution packaging remains gated.
        let data_root = PathBuf::from(std::env::var_os("APPDATA").ok_or("APPDATA is unavailable for native storage")?).join("ArcPower");
        let mock_mode = lifecycle::mock_selected(&std::env::args().skip(1).collect::<Vec<_>>(), std::env::var("RID_BACKEND").as_deref().ok());
        let mode = if mock_mode && std::env::var("RID_MOCK_STOCK_MODE").as_deref() != Ok("1") { "advanced" } else { "stock" };
        let build_kind = arc_power_tauri::backend::native_system::build_kind(mock_mode);
        let native_store = Arc::new(arc_power_tauri::backend::native_store::NativeStore::new(data_root, mode)?);
        let recording_status_pill = if mock_mode { None } else {
            let settings = native_store.settings_store().load_settings();
            if let Err(error) = &settings {
                eprintln!("[recording-pill] saved preference could not be loaded; starting disabled: {error}");
            }
            match recording_status_pill::RecordingStatusPill::new(app.clone(), recording_pill_enabled(settings)) {
                Ok(pill) => Some(Arc::new(pill)),
                Err(error) => {
                    eprintln!("[recording-pill] native owner unavailable; continuing without the indicator: {error}");
                    None
                }
            }
        };
        let mut random = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut random);
        let session: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
        let contract: Value = serde_json::from_str(CONTRACT).map_err(|e| e.to_string())?;
        let ready = readiness::Readiness::new();
        let (host_events, event_receiver) = mpsc::sync_channel(256);
        // Packaged, elevated runs need no compatibility service: every renderer
        // and private channel is native. Dev/mock runs still use the broker so
        // the differential fixtures keep exercising the shared contracts.
        let headless = !mock_mode && !matches!(build_kind, arc_power_tauri::backend::native_system::BuildKind::Dev);
        if headless {
            let mut channels = contract_set(&contract, "invokeChannels");
            channels.extend(contract_set(&contract, "eventChannels"));
            ready.publish(readiness::Phase::Services, channels);
        }
        let service = if headless {
            None
        } else {
        let runtime = runtime::discover()?;
        let server = transport::PipeServer::create()?;
        let mut command = runtime::command(&runtime);
        command.arg("--tauri-broker")
            .env("ARC_POWER_TAURI_SESSION", &session)
            .env("ARC_POWER_TAURI_PIPE", server.path())
            .env("ARC_POWER_TAURI_HOST_PID", std::process::id().to_string())
            .env("ARC_POWER_TAURI_HOST_EXECUTABLE", std::env::current_exe().map_err(|e| e.to_string())?)
            // The native host owns ocOnBoot applies; tell the compatibility
            // service to skip its window-path boot apply so nothing runs twice.
            .env("ARC_POWER_NATIVE_BOOT_APPLY",
                if !mock_mode && arc_power_tauri::backend::arc_sleep_system::host_elevated() { "1" } else { "0" })
            // The native host owns recording toast notifications in the same
            // elevated non-mock runs; Electron must not create a second one.
            .env("ARC_POWER_NATIVE_RECORDING_TOAST",
                if !mock_mode && arc_power_tauri::backend::arc_sleep_system::host_elevated() { "1" } else { "0" })
            .env_remove("ELECTRON_RUN_AS_NODE")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        let launch_args: Vec<String> = std::env::args().skip(1).collect();
        lifecycle::validate_launch_args(&launch_args)?;
        command.args(launch_args);
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| format!("Cannot start compatibility broker: {e}"))?;
        let stdout = child.stdout.take().ok_or("Broker stdout unavailable")?;
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Ok(Some(line)) = protocol::read_bounded_line(&mut reader) {
                eprint!("{}", String::from_utf8_lossy(&line[..line.len().min(16384)]));
            }
        });
        let pipe = match server.accept(child.id(), Duration::from_secs(120)) {
            Ok(pipe) => pipe,
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error); }
        };
        let stdin = pipe.try_clone().map_err(|e| e.to_string())?;
        let pid = child.id();
        Some((child, stdin, pipe, pid))
        };
        let (child, stdin, pipe, broker_pid) = match service {
            Some((child, stdin, pipe, pid)) => (Some(child), Some(stdin), Some(pipe), Some(pid)),
            None => (None, None, None, None),
        };
        if !mock_mode {
            let emit_app = app.clone();
            let emit: arc_power_tauri::backend::postprocess_sharpening::EmitHook = Arc::new(move |channel: &str, payload: Value| {
                let args = arc_power_tauri::backend::wire::encode_json(&json!([payload]))
                    .unwrap_or_else(|_| json!({"t":"array","v":[]}));
                let _ = emit_app.emit_to("main", "arc-power:broker-event", json!({"channel":channel,"args":args}));
            });
            let reload: arc_power_tauri::backend::postprocess_sharpening::ReloadHook =
                Arc::new(host_shell::request_reload);
            let identity = arc_power_tauri::backend::postprocess_sharpening::IdentityGuard {
                host_pid: std::process::id(),
                broker_pid: broker_pid.map(|pid| pid as u32),
                host_exe: std::env::current_exe().ok().map(|path| path.to_string_lossy().into_owned()),
                broker_exe: runtime::discover().ok().map(|runtime| runtime.executable.to_string_lossy().into_owned()),
            };
            arc_power_tauri::backend::postprocess_sharpening::set_runtime_hooks(emit, identity, reload)
                .map_err(|error| format!("Native screen post-processing hooks unavailable: {error}"))?;
            let graphics_emit: arc_power_tauri::backend::graphics::EmitHook =
                Arc::new(role_event_sink(app.clone()));
            arc_power_tauri::backend::graphics::set_runtime_emit(graphics_emit)
                .map_err(|error| format!("Native graphics hooks unavailable: {error}"))?;
        }
        let telemetry = Arc::new(telemetry::TelemetryHub::new(host_events.clone()));
        if !mock_mode { host_shell::start(host_events.clone()); }
        let recording = arc_power_tauri::backend::recording_hub::RecordingHub::new(app.clone(), host_events.clone(), native_store.clone(), !mock_mode);
        let fan_resume = {
            let notify_app = app.clone();
            arc_power_tauri::backend::fan_resume::FanResumeHub::new(native_store.clone(), Box::new(move || {
                let args = arc_power_tauri::backend::wire::encode_json(&json!([]))
                    .unwrap_or_else(|_| json!({"t":"array","v":[]}));
                let _ = notify_app.emit("arc-power:broker-event",
                    json!({"channel":arc_power_tauri::backend::fan_resume::status_channel(),"args":args}));
            }))
        };
        let device_selection = {
            let emit_app = app.clone();
            Arc::new(arc_power_tauri::backend::device_selection::DeviceSelectionHub::new(native_store.clone(),
                Box::new(role_event_sink(emit_app))))
        };
        let rtss_osd = Arc::new(arc_power_tauri::backend::rtss_osd::RtssOsdHub::new());
        let stability = if mock_mode { None } else {
            use arc_power_tauri::backend::stability_runtime::{
                NativeReportSink, StabilityRuntime, StabilityRuntimeDeps, SystemRunClock,
                ThreadSleeper, ThreadSpawner,
            };
            use arc_power_tauri::backend::stability_whea::{PowerShellWheaReader, WheaMonitor};
            use arc_power_tauri::backend::stability_workload::D3d11Workload;
            let reports = NativeReportSink::new(native_store.root().to_path_buf())
                .map_err(|error| format!("Native Stability Lab storage unavailable: {error}"))?;
            let emit_app = app.clone();
            let sample_telemetry = telemetry.clone();
            let sample_rtss = rtss_osd.clone();
            let ensure_telemetry = telemetry.clone();
            let telemetry_app = app.clone();
            let telemetry_store = native_store.clone();
            Some(Arc::new(StabilityRuntime::new(StabilityRuntimeDeps {
                resolve_target: Box::new(native_stability_resolve),
                sample_target: Box::new(move |target| native_stability_sample(target, &sample_telemetry, &sample_rtss)),
                // Diagnostic only: the run log names the engine families the
                // stressed adapter actually used, so a copy-bound workload is
                // visible without a debugger. PDH carries the driver's
                // `engtype_*` label; D3DKMT supplies the raw node ordinals that
                // the utilization metric is built from.
                engine_detail: {
                    let engines = Arc::new(std::sync::Mutex::new(
                        arc_power_tauri::backend::pdh_gpu_engine::PdhGpuEngine::new()));
                    let nodes = Arc::new(std::sync::Mutex::new(
                        arc_power_tauri::backend::d3dkmt_util::D3dkmtGpuUtil::new()));
                    Box::new(move |target| {
                        let Some(luid) = arc_power_tauri::backend::pdh_gpu_engine::luid_from_target(target) else {
                            return Value::Null;
                        };
                        let engines = engines.lock().ok()
                            .and_then(|mut reader| reader.as_mut().map(|reader| reader.sample_engines(luid)))
                            .unwrap_or_default();
                        let nodes = nodes.lock().ok().and_then(|mut reader| reader.sample_nodes(luid)).unwrap_or_default();
                        json!({
                            "engines": engines.into_iter()
                                .map(|(name, value)| json!({"name":name,"utilPct":value})).collect::<Vec<_>>(),
                            "nodes": nodes.into_iter()
                                .map(|(id, value)| json!({"node":id,"utilPct":value})).collect::<Vec<_>>(),
                        })
                    })
                },
                settings_snapshot: Box::new(native_stability_settings),
                ensure_telemetry: Box::new(move |target| {
                    let device_id = target.get("id").and_then(Value::as_u64)
                        .ok_or("selected device has no telemetry id")?;
                    ensure_telemetry.ensure_for_device(device_id, &telemetry_app, &telemetry_store)
                }),
                workload: Some(Box::new(D3d11Workload::new())),
                whea: Some(Box::new(WheaMonitor::new(Box::new(PowerShellWheaReader::system())))),
                reports: Box::new(reports),
                emit: Box::new(move |status| {
                    let _ = emit_app.emit_to(stability_status_target(), "arc-power:broker-event",
                        stability_status_event(status));
                }),
                clock: Box::new(SystemRunClock),
                sleeper: Box::new(ThreadSleeper),
                spawner: Box::new(ThreadSpawner),
            })))
        };
        let arc_sleep = if !mock_mode && arc_power_tauri::backend::arc_sleep_system::host_elevated() {
            // Elevated non-mock Tauri runs own Arc Sleep natively. Electron's
            // controller stays stopped (single-owner rule).
            let controller = arc_power_tauri::backend::arc_sleep_system::system_controller(
                native_store.clone(),
                Arc::new(NativeSleepEnvironment { telemetry: telemetry.clone(), rtss: rtss_osd.clone() }),
            );
            match arc_power_tauri::backend::arc_sleep_system::install(controller.clone()) {
                Ok(()) => Some(controller),
                Err(error) => { eprintln!("[arc-sleep] {error}"); None }
            }
        } else { None };
        let advanced_overlay = if mock_mode { None } else {
            use arc_power_tauri::backend::advanced_overlay;
            let panel_app = app.clone();
            let display_app = app.clone();
            let settings_store = native_store.clone();
            let loader: advanced_overlay::LoadSettings = Box::new(move || {
                advanced_overlay::load_settings_snapshot(&settings_store)
            });
            let hotkey: advanced_overlay::HotkeyRegistered = Box::new(|accelerator: &str| {
                arc_power_tauri::backend::postprocess_sharpening::advanced_hotkey_registered(accelerator)
            });
            let display: advanced_overlay::PrimaryDisplay =
                Box::new(move || primary_display_bounds(&display_app));
            Some(Arc::new(advanced_overlay::AdvancedOverlayHub::new(
                loader, hotkey, display, Box::new(NativeAdvancedOverlayWindows { app: panel_app }))))
        };
        let broker = Arc::new(Self {
            session, writer: Mutex::new(stdin.map(|stdin| Writer { stdin, next_id: 1 })),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            ready,
            permitted: contract_set(&contract, "invokeChannels"), events: contract_set(&contract, "eventChannels"),
            role_channels: contract["roleChannels"].as_object().map(|map| map.iter().map(|(role, channels)| {
                (role.clone(), channels.as_array().expect("generated role channels").iter().map(|channel| channel.as_str().unwrap().to_owned()).collect())
            }).collect()).unwrap_or_default(),
            role_events: contract["roleEvents"].as_object().map(|map| map.iter().map(|(role, channels)| {
                (role.clone(), channels.as_array().expect("generated role events").iter().map(|channel| channel.as_str().unwrap().to_owned()).collect())
            }).collect()).unwrap_or_default(),
            closing: std::sync::atomic::AtomicBool::new(false),
            allow_exit: std::sync::atomic::AtomicBool::new(false),
            failed: std::sync::atomic::AtomicBool::new(false),
            failure_close_requested: std::sync::atomic::AtomicBool::new(false),
            maintenance_pending: std::sync::atomic::AtomicBool::new(false),
            maintenance_boot_ready: std::sync::atomic::AtomicBool::new(headless),
            maintenance_native_boot_ready: std::sync::atomic::AtomicBool::new(false),
            startup_reconcile_ready: std::sync::atomic::AtomicBool::new(mock_mode),
            active_invocations: std::sync::atomic::AtomicUsize::new(0),
            host_events,
            tray_available: std::sync::atomic::AtomicBool::new(false),
            telemetry,
            stability,
            recording,
            recording_status_pill,
            fan_resume,
            device_selection,
            rtss_osd,
            advanced_overlay,
            arc_sleep,
            native_store,
            apply_transactions: arc_power_tauri::backend::apply_transaction::process_lifetime(),
            startup_update: Arc::new(startup_update::StartupUpdateCoordinator::new()),
            startup_splash_ready: std::sync::atomic::AtomicBool::new(false),
            last_store_request: std::sync::atomic::AtomicU64::new(0),
            build_kind, mock_mode,
        });
        if let Some(controller) = broker.arc_sleep.as_ref() {
            controller.start();
        }
        if !mock_mode {
            // Native driver downloads push progress directly to WebView2 and
            // quit the whole app after a successful installer handoff.
            let emit_app = app.clone();
            let emit = Arc::new(move |channel: &str, payload: Value| {
                let args = arc_power_tauri::backend::wire::encode_json(&json!([payload]))
                    .unwrap_or_else(|_| json!({"t":"array","v":[]}));
                let _ = emit_app.emit("arc-power:broker-event", json!({"channel":channel,"args":args}));
            });
            let quit_broker = broker.clone();
            let quit_app = app.clone();
            let quit = Arc::new(move || {
                let broker = quit_broker.clone();
                let app = quit_app.clone();
                std::thread::spawn(move || {
                    exit_log_write("driver-install-quit", 0);
                    broker.shutdown();
                    broker.allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
                    app.exit(0);
                });
            });
            arc_power_tauri::backend::intel_driver_download::set_runtime_hooks(emit, quit)
                .map_err(|error| format!("Native driver download hooks unavailable: {error}"))?;
        }
        let event_broker = Arc::downgrade(&broker);
        if !mock_mode {
            let store = broker.native_store.clone();
            let kind = broker.build_kind;
            let reconcile_broker = broker.clone();
            std::thread::spawn(move || {
                if let Err(error) = arc_power_tauri::backend::startup::reconcile(&store, kind) {
                    eprintln!("[startup] saved startup intent could not be restored: {error}");
                }
                // Maintenance waits for this one-shot startup repair before it
                // takes the registration snapshot or disables startup state.
                reconcile_broker.startup_reconcile_ready.store(true, std::sync::atomic::Ordering::SeqCst);
            });
        }
        // The early splash manifest/window operations can arrive immediately
        // after pipe connection, before setup regains control.
        app.manage(broker.clone());
        if !mock_mode && arc_power_tauri::backend::arc_sleep_system::host_elevated() {
            // Native boot apply runs after the broker is connected. The
            // compatibility service was told to skip its own window-path apply.
            let boot_broker = broker.clone();
            let boot_app = app.clone();
            std::thread::spawn(move || {
                host_boot_apply(&boot_broker, &boot_app);
                if let Err(error) = arc_power_tauri::backend::services::restore_arc_sync_ranges(&boot_broker.native_store) {
                    eprintln!("[display] saved Arc Sync ranges could not be restored: {error}");
                }
                boot_broker.maintenance_native_boot_ready.store(true, std::sync::atomic::Ordering::SeqCst);
            });
        } else {
            broker.maintenance_native_boot_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        if broker.recording_status_pill.is_some() {
            // The compatibility broker waits for this ownership signal before
            // it suppresses its Electron-style status-pill lifecycle.
            broker.host_event("recording-status-pill-owner-ready", json!({}));
        } else if !broker.mock_mode {
            broker.host_event("recording-status-pill-owner-unavailable", json!({}));
        }
        let mut last_recording_snapshot_reconcile: Option<Instant> = None;
        let mut native_previous_recording: Option<Value> = None;
        let tray_app = app.clone();
        std::thread::spawn(move || loop {
            let event = match event_receiver.recv_timeout(Duration::from_millis(250)) {
                Ok(event) => Some(event),
                Err(mpsc::RecvTimeoutError::Timeout) => None,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };
            let Some(broker) = event_broker.upgrade() else { break; };
            // One cadence driver for Arc Sleep: every host-loop wake offers a
            // tick, and the controller itself is a no-op until its slot is due.
            if let Some(controller) = broker.arc_sleep.as_ref() { controller.tick(); }
            if let Some(pill) = broker.recording_status_pill.as_ref() {
                // The host queue also carries high-rate telemetry. Reconcile
                // snapshots at most once per cadence even if that queue stays
                // busy, and do so without emitting a second recording event.
                let now = Instant::now();
                let snapshot_due = recording_snapshot_due(last_recording_snapshot_reconcile, now);
                if snapshot_due {
                    last_recording_snapshot_reconcile = Some(now);
                    if let Some(settings) = broker.native_store.settings_store().try_load_settings_sync() {
                        if let Some(pill) = broker.recording_status_pill.as_ref() {
                            pill.set_enabled(recording_pill_enabled_value(&settings));
                        }
                    }
                    if let Some(recording) = broker.recording.try_latest_state() {
                        pill.set_recording_state(recording);
                    }
                }
            }
            let Some((target, event, payload)) = event else { continue; };
            if event == "recording-state" {
                let _ = tray::set_recording_state(&payload);
                if let Some(pill) = broker.recording_status_pill.as_ref() {
                    // A bounded host event queue may contain an older state
                    // than the engine's current snapshot. Prefer the fresh
                    // nonblocking snapshot and use the event only on contention.
                    let recording = prefer_latest_recording_state(
                        broker.recording.try_latest_state(), payload.clone());
                    pill.set_recording_state(recording);
                }
            }
            if !broker.mock_mode && arc_power_tauri::backend::arc_sleep_system::host_elevated()
                && event == "recording-state" {
                let (was_video, was_replay) = native_previous_recording.as_ref()
                    .map(|state| recording_active_modes(state)).unwrap_or((false, false));
                let (is_video, is_replay) = recording_active_modes(&payload);
                for (mode, was, is) in [("video", was_video, is_video), ("replay", was_replay, is_replay)] {
                    if was == is { continue; }
                    let replay = mode == "replay";
                    let failed = was && !is && payload["error"].as_str()
                        .is_some_and(|message| !message.trim().is_empty());
                    let title = if failed {
                        if replay { "Instant Replay failed" } else { "Recording failed" }
                    } else if is {
                        if replay { "Instant Replay started" } else { "Recording started" }
                    } else if replay { "Instant Replay stopped" } else { "Recording stopped" };
                    let message = if failed {
                        payload["error"].as_str().unwrap_or("The recording stopped unexpectedly.")
                    } else if is {
                        if replay { "Recent gameplay is now being kept for Instant Replay." } else { "Video capture is now active." }
                    } else if replay { "Instant Replay is no longer active." } else { "Video capture has finished." };
                    native_recording_toast(&tray_app, &broker, json!({
                        "variant": if failed { "error" } else { "success" },
                        "title": title,
                        "message": message,
                    }));
                }
                native_previous_recording = Some(payload.clone());
            }
            if !broker.mock_mode && arc_power_tauri::backend::arc_sleep_system::host_elevated()
                && event == "recording-action-result" {
                let action = payload["action"].as_str().unwrap_or("");
                let ok = payload["ok"].as_bool() == Some(true);
                if action == "screenshot" {
                    native_recording_toast(&tray_app, &broker, json!({
                        "variant": if ok { "success" } else { "error" },
                        "title": if ok { "Screenshot saved" } else { "Screenshot failed" },
                        "message": if ok {
                            payload["outputPath"].as_str().unwrap_or("The screenshot was saved to your capture folder.")
                        } else {
                            payload["error"].as_str().unwrap_or("The recording action failed.")
                        },
                        "always": true,
                    }));
                } else if action == "saveClip" {
                    native_recording_toast(&tray_app, &broker, json!({
                        "variant": if ok { "success" } else { "error" },
                        "title": if ok { "Instant Replay saved" } else { "Save Instant Replay failed" },
                        "message": if ok {
                            "The latest moments were added to the clip library."
                        } else {
                            payload["error"].as_str().unwrap_or("The recording action failed.")
                        },
                    }));
                } else if !ok {
                    let mode = payload["requestedMode"].as_str()
                        .or_else(|| payload["preActionMode"].as_str());
                    let replay = mode == Some("replay");
                    let title = match (action, replay) {
                        ("start", true) => "Instant Replay failed",
                        ("start", false) => "Recording failed",
                        ("stop", true) => "Stop Instant Replay failed",
                        ("stop", false) => "Stop Recording failed",
                        _ => "Recording action failed",
                    };
                    native_recording_toast(&tray_app, &broker, json!({
                        "variant": "error",
                        "title": title,
                        "message": payload["error"].as_str().unwrap_or("The recording action failed."),
                    }));
                }
            }
            if !broker.mock_mode && event == "power" {
                broker.fan_resume.on_power(&payload);
                if let Some(controller) = broker.arc_sleep.as_ref() {
                    match payload["state"].as_str() {
                        // Hand the pre-run cap back before the machine sleeps and
                        // re-acquire after resume. A non-clean stop keeps the
                        // recovery journal, so report it instead of losing it.
                        Some("suspend") => match controller.stop() {
                            arc_power_tauri::backend::arc_sleep_controller::StopOutcome::Clean => {}
                            outcome => eprintln!("[arc-sleep] suspend left recovery pending: {outcome:?}"),
                        },
                        Some("resume") => { controller.start(); }
                        _ => {}
                    }
                }
                continue;
            }
            if !broker.mock_mode && event == "telemetry-sample" {
                broker.rtss_osd.publish(&payload);
                continue;
            }
            if !broker.mock_mode && event == "shortcut" && payload["action"].as_str() == Some("overlay") {
                // Native-only runs have no Electron service to show the HUD
                // window. Own the overlay WebView here as well as the RTSS OSD.
                let _ = broker.rtss_osd.toggle();
                native_overlay_toggle(&tray_app, &broker);
                continue;
            }
            if !broker.mock_mode && event == "shortcut" && payload["action"].as_str() == Some("advanced-overlay") {
                if let Some(service) = broker.advanced_overlay.as_ref() {
                    if let Err(error) = service.toggle_from_shortcut() {
                        eprintln!("[advanced-overlay] shortcut toggle failed: {error}");
                    }
                }
                continue;
            }
            if !broker.mock_mode && event == "shortcut" && payload["action"].as_str() == Some("postprocess-scale") {
                arc_power_tauri::backend::postprocess_sharpening::toggle_scale_from_hotkey_shared(
                    broker.native_store.root());
                continue;
            }
            if !broker.mock_mode && event == "tray-action"
                && payload["action"].as_str() == Some("apply-profile") {
                if host_tray_apply(&broker, &tray_app) { continue; }
            }
            // Packaged native-only runs consume host events locally (tray,
            // pill, telemetry, native toasts); there is no broker pipe to
            // forward them to. Forwarding here would fail startup.
            if broker.writer.lock().unwrap().is_none() { continue; }
            if let Err(error) = broker.send(json!({"kind":"host-event","target":target,"event":event,"payload":payload})) {
                broker.fail(&error);
                break;
            }
        });
        if !mock_mode {
            // Settings saves update the shared native store; observe it so
            // panel changes from either native or delegated settings patches
            // reach the open Advanced Overlay within a couple of seconds.
            let polling = Arc::downgrade(&broker);
            let _ = std::thread::Builder::new().name("arc-advanced-overlay-poll".into()).spawn(move || loop {
                std::thread::sleep(Duration::from_secs(2));
                let Some(broker) = polling.upgrade() else { break; };
                if broker.closing.load(std::sync::atomic::Ordering::SeqCst) { break; }
                if let Some(service) = broker.advanced_overlay.as_ref() { service.poll(); }
            });
        }
        if let Some(pipe) = pipe {
        let reading = broker.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let failure = loop {
                match protocol::read_bounded_line(&mut reader) {
                    Ok(Some(line)) => match protocol::parse_frame(&line, &reading.session) {
                        Ok(Some(frame)) => if let Err(error) = reading.receive(&app, frame) { break error; },
                        Ok(None) => { eprint!("{}", String::from_utf8_lossy(&line[..line.len().min(16384)])); },
                        Err(error) => break error,
                    },
                    Ok(None) => break "Compatibility broker exited".into(),
                    Err(error) => break format!("Compatibility broker transport failed: {error}"),
                }
            };
            reading.fail(&failure);
            if !reading.closing.load(std::sync::atomic::Ordering::SeqCst) {
                let deadline = Instant::now() + Duration::from_secs(2);
                let status = loop {
                    let status = reading.child.lock().unwrap().as_mut()
                        .and_then(|child| child.try_wait().ok().flatten());
                    if status.is_some() || Instant::now() >= deadline { break status; }
                    std::thread::sleep(Duration::from_millis(25));
                };
                if status.is_some_and(|status| status.success()) {
                    reading.allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
                    exit_log_write("broker-exited-clean", 0);
                    app.exit(0);
                } else if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = app.emit_to("main", "arc-power:broker-failed", &failure);
                } else {
                    reading.allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
                    exit_log_write("broker-failed", 1);
                    app.exit(1);
                }
            }
        });
        }
        Ok(broker)
    }

    fn fail(&self, message: &str) {
        self.failed.store(true, std::sync::atomic::Ordering::SeqCst);
        self.apply_transactions.close_unknown();
        self.ready.fail(message);
        for (_, sender) in self.pending.lock().unwrap().drain() { let _ = sender.send(Err(message.into())); }
    }

    fn wait_channel_ready(&self, channel: &str) -> Result<(), String> {
        self.ready.wait_channel(channel, Duration::from_secs(120))
    }

    fn send(&self, mut message: Value) -> Result<(), String> {
        message["v"] = json!(1);
        message["session"] = json!(self.session);
        let mut bytes = protocol::PREFIX.as_bytes().to_vec();
        bytes.extend(serde_json::to_vec(&message).map_err(|e| e.to_string())?);
        if bytes.len() > protocol::MAX_FRAME { return Err("Broker request exceeds size limit".into()); }
        bytes.push(b'\n');
        let mut guard = self.writer.lock().unwrap();
        let writer = guard.as_mut().ok_or("Compatibility service is unavailable in native-only builds")?;
        writer.stdin.write_all(&bytes).and_then(|_| writer.stdin.flush()).map_err(|e| e.to_string())
    }

    fn request(&self, mut message: Value) -> Reply {
        let failed_channel = message["channel"].as_str().unwrap_or("unknown").to_owned();
        if self.writer.lock().unwrap().is_none() {
            eprintln!("[native-only] unexpected broker request: {failed_channel}");
        }
        let (sender, receiver) = mpsc::sync_channel(1);
        let id;
        {
            // Allocate IDs and write under one lock: the broker rejects replay
            // and out-of-order request IDs across invoke and media requests.
            let mut guard = self.writer.lock().unwrap();
            let writer = guard.as_mut().ok_or_else(|| {
                format!("Compatibility service is unavailable in native-only builds (channel: {failed_channel})")
            })?;
            id = writer.next_id;
            writer.next_id += 1;
            message["v"] = json!(1); message["session"] = json!(self.session); message["id"] = json!(id);
            let mut bytes = protocol::PREFIX.as_bytes().to_vec();
            bytes.extend(serde_json::to_vec(&message).map_err(|e| e.to_string())?);
            if bytes.len() > protocol::MAX_FRAME { return Err("Broker request exceeds size limit".into()); }
            bytes.push(b'\n');
            {
                let mut pending = self.pending.lock().unwrap();
                if pending.len() >= 128 { return Err("Too many pending broker requests".into()); }
                pending.insert(id, sender);
            }
            if let Err(error) = writer.stdin.write_all(&bytes).and_then(|_| writer.stdin.flush()) {
                self.pending.lock().unwrap().remove(&id);
                return Err(error.to_string());
            }
        }
        let result = receiver.recv_timeout(Duration::from_secs(180)).map_err(|_| "Broker request timed out; operation was not retried".to_owned());
        self.pending.lock().unwrap().remove(&id);
        result?
    }

    fn host_event(&self, event: &str, payload: Value) {
        self.host_event_to("main", event, payload);
    }

    fn host_event_to(&self, target: &str, event: &str, payload: Value) {
        let _ = self.try_host_event_to(target, event, payload);
    }

    fn try_host_event_to(&self, target: &str, event: &str, payload: Value) -> bool {
        // Native/WebView callbacks must never wait for pipe I/O.
        match self.host_events.try_send((target.to_owned(), event.to_owned(), payload)) {
            Ok(()) => true,
            Err(_) => {
                self.failed.store(true, std::sync::atomic::Ordering::SeqCst);
                eprintln!("Compatibility host event queue unavailable; closing will drain the backend.");
                false
            }
        }
    }

    fn close_failed(self: &Arc<Self>, app: tauri::AppHandle) {
        if self.failure_close_requested.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
        let broker = self.clone();
        std::thread::spawn(move || {
            // Even after a transport/frontend failure, a live service owns GPU
            // cleanup. Request its existing drain before the bounded fallback.
            // Attributable first: the artifact must show the exit line before
            // the broker is killed.
            exit_log_write("close-failed", 0);
            broker.shutdown();
            broker.allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
            app.exit(0);
        });
    }

    fn receive(self: &Arc<Self>, app: &tauri::AppHandle, frame: Value) -> Result<(), String> {
        match frame["kind"].as_str() {
            Some("native-store-request") => {
                if frame.as_object().is_none_or(|object| object.keys().any(|key| !["v","session","kind","id","method","args"].contains(&key.as_str()))) {
                    return Err("Invalid native storage frame".into());
                }
                let id = frame["id"].as_u64().filter(|id| *id > 0 && *id <= 9_007_199_254_740_991).ok_or("Invalid native storage request ID")?;
                let previous = self.last_store_request.load(std::sync::atomic::Ordering::SeqCst);
                if id <= previous { return Err("Replayed native storage request".into()); }
                self.last_store_request.store(id, std::sync::atomic::Ordering::SeqCst);
                let method = frame["method"].as_str().ok_or("Invalid native storage method")?;
                if matches!(method, "apply-transaction-begin" | "apply-transaction-activate"
                    | "apply-transaction-finish" | "apply-transaction-cancel") {
                    if self.mock_mode {
                        self.send(json!({"kind":"native-store-response","id":id,"ok":false,
                            "error":{"message":"Native apply transactions are unavailable in mock mode"}}))?;
                        return Ok(());
                    }
                    let transactions = self.apply_transactions.clone();
                    let args = frame["args"].clone();
                    if method == "apply-transaction-begin" {
                        // Insert the ticket while still on the ordered pipe
                        // reader. Only the wait moves to a worker, preserving
                        // frame order without blocking later cancel/activate.
                        let prepared = match transactions.prepare_native_store_begin(&args) {
                            Ok(prepared) => prepared,
                            Err(message) => {
                                self.send(json!({"kind":"native-store-response","id":id,"ok":false,
                                    "error":{"message":message}}))?;
                                return Ok(());
                            }
                        };
                        let request_id = prepared.request_id().to_owned();
                        let worker_transactions = transactions.clone();
                        let worker_broker = Arc::clone(self);
                        let worker = std::thread::Builder::new()
                            .name("arc-native-apply-transaction".into())
                            .spawn(move || {
                                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    worker_transactions.wait_prepared_begin(prepared).and_then(|reservation| {
                                        arc_power_tauri::backend::wire::encode_json(&json!({
                                            "token": reservation.token,
                                            "sequence": reservation.sequence,
                                        }))
                                    })
                                })).unwrap_or_else(|_| Err("Native apply transaction failed before completion".into()));
                                let response = match outcome {
                                    Ok(value) => json!({"kind":"native-store-response","id":id,"ok":true,"value":value}),
                                    Err(message) => json!({"kind":"native-store-response","id":id,"ok":false,"error":{"message":message}}),
                                };
                                if let Err(error) = worker_broker.send(response) { worker_broker.fail(&error); }
                            });
                        if let Err(error) = worker {
                            // spawn() drops its closure on failure; release the
                            // synchronously inserted ticket and tombstone its
                            // request ID before acknowledging the failure.
                            let _ = transactions.cancel(&request_id);
                            self.send(json!({"kind":"native-store-response","id":id,"ok":false,
                                "error":{"message":format!("Could not start native apply transaction worker: {error}")}}))?;
                        }
                        return Ok(());
                    }

                    // These operations take only the coordinator mutex briefly.
                    // In particular, cancel is handled synchronously so it can
                    // remove a prepared ticket before its wait worker runs.
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        transactions.handle_native_store_request(method, &args)
                    })).unwrap_or_else(|_| Err("Native apply transaction failed before completion".into()));
                    let response = match outcome {
                        Ok(value) => json!({"kind":"native-store-response","id":id,"ok":true,"value":value}),
                        Err(message) => json!({"kind":"native-store-response","id":id,"ok":false,"error":{"message":message}}),
                    };
                    self.send(response)?;
                    return Ok(());
                }
                if matches!(method, "temperature-refusal-cache-read"
                    | "temperature-refusal-cache-record" | "temperature-refusal-cache-poison") {
                    let outcome = if self.mock_mode {
                        Err("Native temperature refusal cache is unavailable in mock mode".to_owned())
                    } else {
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            arc_power_tauri::backend::services::handle_temperature_refusal_cache_request(
                                method, &frame["args"],
                            )
                        })).unwrap_or_else(|_| Err("Native temperature refusal cache failed before completion".into()))
                    };
                    let response = match outcome {
                        Ok(value) => json!({"kind":"native-store-response","id":id,"ok":true,"value":value}),
                        Err(message) => json!({"kind":"native-store-response","id":id,"ok":false,"error":{"message":message}}),
                    };
                    self.send(response)?;
                    return Ok(());
                }
                if !self.mock_mode {
                    let channel = match method {
                        "update-check" => Some("update:check"),
                        "update-download" => Some("update:download"),
                        "update-install" => Some("update:install"),
                        _ => None,
                    };
                    if let Some(channel) = channel {
                        if channel == "update:check"
                            && update_hub::check_intent(&frame["args"]).ok() == Some("startup")
                        {
                            if let Some(outcome) = self.startup_update.cached_startup_result() {
                                let outcome = outcome.and_then(|value| arc_power_tauri::backend::wire::encode_json(&value));
                                let response = match outcome {
                                    Ok(value) => json!({"kind":"native-store-response","id":id,"ok":true,"value":value}),
                                    Err(message) => json!({"kind":"native-store-response","id":id,"ok":false,"error":{"message":message}}),
                                };
                                self.send(response)?;
                                return Ok(());
                            }
                        }
                        let worker_broker = Arc::clone(self);
                        let worker_app = app.clone();
                        let worker_args = frame["args"].clone();
                        let build_kind = self.build_kind;
                        let worker = std::thread::Builder::new()
                            .name("arc-native-updater".into())
                            .spawn(move || {
                                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                    update_hub::handle(&worker_app, "main", channel, &worker_args, build_kind)
                                })).unwrap_or_else(|_| Err("Native update operation failed before completion".into()));
                                let response = match outcome {
                                    Ok(value) => json!({"kind":"native-store-response","id":id,"ok":true,"value":value}),
                                    Err(message) => json!({"kind":"native-store-response","id":id,"ok":false,"error":{"message":message}}),
                                };
                                if let Err(error) = worker_broker.send(response) { worker_broker.fail(&error); }
                            });
                        if let Err(error) = worker {
                            self.send(json!({"kind":"native-store-response","id":id,"ok":false,
                                "error":{"message":format!("Could not start native update worker: {error}")}}))?;
                        }
                        return Ok(());
                    }
                }
                // An unavailable platform dependency must fail this request;
                // it must not terminate the private reader or invent a result.
                let store = Arc::clone(&self.native_store);
                let args = frame["args"].clone();
                if method == "patch-settings" {
                    // Compatibility boot reconciliation/reset writes are
                    // atomic field patches, but still join the settings save
                    // queue. Run off the pipe reader so a patch queued behind
                    // a delegated broker save cannot block that save's own
                    // native-store callbacks.
                    let worker_broker = Arc::clone(self);
                    let worker = std::thread::Builder::new()
                        .name("arc-settings-patch".into())
                        .spawn(move || {
                            let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                                arc_power_tauri::backend::settings_patch::with_save_queue(|| {
                                    store.invoke("patch-settings", &args)
                                })
                            })).unwrap_or_else(|_| Err("Native settings patch failed before completion".into()));
                            let response = match outcome {
                                Ok(value) => json!({"kind":"native-store-response","id":id,"ok":true,"value":value}),
                                Err(message) => json!({"kind":"native-store-response","id":id,"ok":false,"error":{"message":message}}),
                            };
                            if let Err(error) = worker_broker.send(response) { worker_broker.fail(&error); }
                        });
                    if let Err(error) = worker {
                        self.send(json!({"kind":"native-store-response","id":id,"ok":false,
                            "error":{"message":format!("Could not start settings patch worker: {error}")}}))?;
                    }
                    return Ok(());
                }
                let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| store.invoke(method, &args)))
                    .unwrap_or_else(|_| Err("Native storage operation failed before completion; reload its state before retrying".into()));
                let response = match outcome {
                    Ok(value) => json!({"kind":"native-store-response","id":id,"ok":true,"value":value}),
                    Err(message) => json!({"kind":"native-store-response","id":id,"ok":false,"error":{"message":message}}),
                };
                self.send(response)?;
            }
            Some("ready") => {
                let channels = frame["channels"].as_array().ok_or("Missing broker channel manifest")?.iter()
                    .map(|value| value.as_str().map(str::to_owned).ok_or("Invalid broker channel"))
                    .collect::<Result<HashSet<_>, _>>()?;
                let phase_name = match frame.get("phase") { Some(value) => Some(value.as_str().ok_or("Invalid broker readiness phase")?), None => None };
                let phase = readiness::Phase::parse(phase_name)?;
                self.ready.publish(phase, channels);
            }
            Some("response") => {
                let id = frame["id"].as_u64().ok_or("Invalid broker response id")?;
                if let Some(sender) = self.pending.lock().unwrap().remove(&id) {
                    let result = if frame["ok"] == true { Ok(frame["value"].clone()) }
                        else { Err(frame["error"]["message"].as_str().or_else(|| frame["error"].as_str()).map(str::to_owned).unwrap_or_else(|| frame["error"].to_string())) };
                    let _ = sender.send(result);
                }
            }
            Some("event") => {
                let channel = frame["channel"].as_str().ok_or("Invalid broker event")?;
                let target = frame["target"].as_str().ok_or("Missing broker event target")?;
                let payload = json!({"channel":channel,"args":frame["args"]});
                let allowed = roles::role(target).is_some_and(|role| if role == "main" { self.events.contains(channel) }
                    else { self.role_events.get(role).is_some_and(|events| events.contains(channel)) });
                if allowed && app.get_webview_window(target).is_some() {
                    app.emit_to(target, "arc-power:broker-event", payload.clone()).map_err(|e| e.to_string())?;
                }
                if target == "main" {
                    let labels: Vec<String> = app.webview_windows().into_keys().collect();
                    for label in advanced_overlay_event_targets(channel, self.mock_mode, &self.role_events, labels.iter()) {
                        // One failed panel must not terminate the broker reader;
                        // the main delivery above keeps its existing contract.
                        let _ = app.emit_to(label.as_str(), "arc-power:broker-event", payload.clone());
                    }
                }
            }
            Some("host-op") => { apply_host_operation(app, &frame)?; }
            Some("fatal") => return Err(frame["error"].as_str().unwrap_or("Broker fatal error").into()),
            _ => return Err("Unknown broker frame kind".into()),
        }
        Ok(())
    }

    fn shutdown(&self) {
        if self.closing.swap(true, std::sync::atomic::Ordering::SeqCst) { return; }
        self.apply_transactions.close_unknown();
        if let Some(pill) = self.recording_status_pill.as_ref() { pill.destroy(); }
        if let Some(arc_sleep) = self.arc_sleep.as_ref() {
            // A non-clean stop keeps the recovery journal for the next start; log
            // it so a cap left behind is attributable instead of silent.
            use arc_power_tauri::backend::arc_sleep_controller::StopOutcome;
            match arc_sleep.stop() {
                StopOutcome::Clean => {}
                StopOutcome::ExternalChange => eprintln!(
                    "[arc-sleep] the FPS cap changed outside Arc Power during shutdown; recovery kept"
                ),
                StopOutcome::CleanupPending { status, message } => eprintln!(
                    "[arc-sleep] shutdown left recovery pending ({status}): {message}"
                ),
            }
        }
        if let Some(stability) = self.stability.as_ref() { stability.shutdown(); }
        self.rtss_osd.clear();
        arc_power_tauri::backend::postprocess_sharpening::shutdown_shared();
        self.recording.shutdown();
        let _ = self.send(json!({"kind":"shutdown"}));
        let mut guard = self.child.lock().unwrap();
        let Some(child) = guard.as_mut() else { return; };
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) { return; }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill(); let _ = child.wait();
    }
}

fn authorize(window: &tauri::WebviewWindow) -> Result<(), String> {
    if !roles::trusted_url(window.label(), &window.url().map_err(|e| e.to_string())?) {
        return Err("Command is restricted to its fixed local role document".into());
    }
    Ok(())
}

fn wire_field<'a>(value: &'a arc_power_tauri::backend::wire::WireValue, key: &str) -> Option<&'a arc_power_tauri::backend::wire::WireValue> {
    match value {
        arc_power_tauri::backend::wire::WireValue::Object(entries) => entries.iter().find_map(|(name, child)| (name == key).then_some(child)),
        _ => None,
    }
}

fn wire_text(value: &arc_power_tauri::backend::wire::WireValue) -> Option<&str> {
    match value { arc_power_tauri::backend::wire::WireValue::String(value) => Some(value), _ => None }
}

fn wire_uint(value: &arc_power_tauri::backend::wire::WireValue) -> Option<u64> {
    match value { arc_power_tauri::backend::wire::WireValue::Number(value) => value.as_u64(), _ => None }
}

fn wire_finite(value: &arc_power_tauri::backend::wire::WireValue) -> Option<f64> {
    match value { arc_power_tauri::backend::wire::WireValue::Number(value) => value.as_f64().filter(|number| number.is_finite()), _ => None }
}

fn wire_plain_json(value: &arc_power_tauri::backend::wire::WireValue) -> Result<Value, String> {
    match value {
        arc_power_tauri::backend::wire::WireValue::Object(entries) => {
            let mut object = serde_json::Map::new();
            for (key, child) in entries {
                if matches!(child, arc_power_tauri::backend::wire::WireValue::Undefined) { continue; }
                object.insert(key.clone(), wire_plain_json(child)?);
            }
            Ok(Value::Object(object))
        }
        arc_power_tauri::backend::wire::WireValue::Array(values) => values.iter()
            .map(wire_plain_json).collect::<Result<Vec<_>, _>>().map(Value::Array),
        _ => value.clone().into_json(),
    }
}

struct NativeLeaseEntry {
    request_id: String,
    token: String,
    sequence: u64,
    epoch: String,
    target: Value,
    ranges: Value,
    requested: Value,
    generation: u64,
    ceiling: Option<f64>,
    device_key: String,
}
static NATIVE_LEASES: std::sync::LazyLock<Mutex<HashMap<String, NativeLeaseEntry>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buffer);
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn native_transaction_request(broker: &Broker, method: &str, args: Value) -> Result<Value, String> {
    let encoded = arc_power_tauri::backend::wire::encode_json(&args)?;
    let reply = broker.apply_transactions.handle_native_store_request(method, &encoded)?;
    arc_power_tauri::backend::wire::decode(&reply)?.into_json()
}

fn native_refusal_request(method: &str, args: Value) -> Result<Value, String> {
    let encoded = arc_power_tauri::backend::wire::encode_json(&args)?;
    let reply = arc_power_tauri::backend::services::handle_temperature_refusal_cache_request(method, &encoded)?;
    arc_power_tauri::backend::wire::decode(&reply)?.into_json()
}

fn poison_native_refusal(reason: &str) {
    let _ = native_refusal_request("temperature-refusal-cache-poison", json!([reason]));
}

/// Native replacement for Electron's `__native-temperature-apply-lease:*`
/// service. It holds the native apply FIFO, publishes refusal snapshots to the
/// native cache, and produces the same begin/finish envelopes the host's
/// fail-closed lease assertions already verify.
fn native_private_invoke(broker: &Broker, channel: &str, payload: &arc_power_tauri::backend::wire::WireValue) -> Reply {
    let payload = wire_plain_json(payload)?;
    match channel {
        "__native-temperature-apply-lease:begin" => {
            let request_id = payload["requestId"].as_str()
                .filter(|value| value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
                .ok_or("Native temperature lease request ID is invalid")?.to_owned();
            let device_key = payload["deviceKey"].as_str()
                .filter(|value| !value.is_empty())
                .ok_or("Native temperature lease requires a canonical GPU key")?.to_owned();
            let target = payload["physicalTarget"].clone();
            if !target.is_object() { return Err("Native temperature lease requires physical proof".into()); }

            let opened = native_transaction_request(broker, "apply-transaction-begin",
                json!([request_id, "native-temperature-apply-lease", Value::Null]))?;
            let token = opened["token"].as_str().ok_or("Apply transaction token is missing")?.to_owned();
            let sequence = opened["sequence"].as_u64().ok_or("Apply transaction sequence is missing")?;
            native_transaction_request(broker, "apply-transaction-activate", json!([request_id, token.clone()]))?;

            let result = (|| -> Result<(String, Value, NativeLeaseEntry), String> {
                let cache = native_refusal_request("temperature-refusal-cache-read", json!([target.clone()]))?;
                if cache["status"].as_str() != Some("available") { return Err("The temperature refusal cache is unavailable".into()); }
                let args = arc_power_tauri::backend::wire::encode_json(&json!([payload["deviceId"]]))?;
                let caps_reply = arc_power_tauri::backend::services::invoke("get-capabilities", &args,
                    arc_power_tauri::backend::services::ServiceContext {
                        build_kind: broker.build_kind, mock_mode: broker.mock_mode, store: &broker.native_store,
                    }
                ).ok_or("Fresh native temperature range is unavailable")??;
                let caps = arc_power_tauri::backend::wire::decode(&caps_reply)?.into_json()?;
                if caps["deviceKey"].as_str() != Some(device_key.as_str()) { return Err("Native temperature apply target identity changed".into()); }
                let Some(range) = caps.get("ranges").and_then(|r| r.get("tempLimitC")) else {
                    return Err("Fresh native temperature range is unavailable".into());
                };
                let generation = cache["generation"].as_u64().ok_or("Refusal cache generation is missing")?;
                let ceiling = cache["ceilings"]["tempLimitC"].as_f64();
                let epoch = random_hex(16);
                let lease_id = random_hex(32);
                let requested = payload.get("requestedSettings").cloned().unwrap_or(json!({}));
                let snapshot = json!({
                    "type": "temperature-refusal-cache:begin",
                    "schemaVersion": 1,
                    "epoch": epoch.clone(),
                    "transactionSequence": sequence,
                    "cacheGeneration": generation,
                    "target": target.clone(),
                    "ranges": {"tempLimitC": range.clone()},
                    "requestedSettings": requested.clone(),
                    "cache": {"status": "available", "ceilings": {"tempLimitC": ceiling}},
                    "ocMode": caps.get("ocMode").cloned().unwrap_or(Value::Null),
                    "extendedControls": caps.get("extendedControls").cloned().unwrap_or(json!({})),
                });
                let entry = NativeLeaseEntry {
                    request_id: request_id.clone(), token, sequence, epoch, target: target.clone(),
                    ranges: json!({"tempLimitC": range.clone()}), requested,
                    generation, ceiling, device_key: device_key.clone(),
                };
                Ok((lease_id, snapshot, entry))
            })();
            match result {
                Ok((lease_id, snapshot, entry)) => {
                    if let Ok(mut leases) = NATIVE_LEASES.lock() { leases.insert(lease_id.clone(), entry); }
                    arc_power_tauri::backend::wire::encode_json(&json!({
                        "leaseId": lease_id, "requestId": request_id, "snapshot": snapshot,
                    }))
                }
                Err(error) => {
                    let _ = native_transaction_request(broker, "apply-transaction-cancel", json!([request_id]));
                    Err(error)
                }
            }
        }
        "__native-temperature-apply-lease:finish" => {
            let lease_id = payload["leaseId"].as_str()
                .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
                .ok_or("Native temperature lease ID is invalid")?.to_owned();
            let entry = NATIVE_LEASES.lock().ok()
                .and_then(|mut leases| leases.remove(&lease_id))
                .ok_or("Native temperature lease is missing or already finished")?;
            let outcome = payload["outcome"].as_str().unwrap_or("");
            if outcome == "unknown" {
                poison_native_refusal("native temperature apply outcome is unknown");
                let _ = native_transaction_request(broker, "apply-transaction-finish", json!([entry.request_id, entry.token]));
                return Err("Native temperature apply outcome is unknown; refresh before another apply".into());
            }
            let attempted = payload["attemptedValue"].as_f64().filter(|value| value.is_finite());
            let result = payload["result"].clone();
            let temp = result.get("perControl").and_then(|p| p.get("tempLimitC"));
            let ok = temp.and_then(|t| t.get("ok")).and_then(Value::as_bool);
            let code = temp.and_then(|t| t.get("errorCode")).and_then(Value::as_str);
            if outcome != "completed" || ok.is_none() || code.is_none() && ok == Some(false) {
                poison_native_refusal("malformed native temperature result");
                let _ = native_transaction_request(broker, "apply-transaction-finish", json!([entry.request_id, entry.token]));
                return Err("Native temperature lease finish payload is invalid".into());
            }
            let refused = ok == Some(false) && code == Some("out-of-range");
            let mut generation = entry.generation;
            let mut ceiling = entry.ceiling;
            let mut publication = "not-required";
            if attempted.is_some() && refused {
                let record = native_refusal_request("temperature-refusal-cache-record", json!([
                    entry.target.clone(),
                    {
                        "transactionSequence": entry.sequence,
                        "attemptedSettings": {"tempLimitC": attempted},
                        "ranges": entry.ranges.clone(),
                        "perControl": result.get("perControl").cloned(),
                    },
                ]));
                match record {
                    Ok(reply) => {
                        publication = "committed";
                        if let Some(value) = reply["generation"].as_u64() { generation = value; }
                        if let Some(value) = reply["ceiling"].as_f64() { ceiling = Some(value); }
                    }
                    Err(error) => {
                        poison_native_refusal(&error);
                        let _ = native_transaction_request(broker, "apply-transaction-finish", json!([entry.request_id, entry.token]));
                        return Err(error);
                    }
                }
            }
            native_transaction_request(broker, "apply-transaction-finish", json!([entry.request_id, entry.token]))?;
            // `temperature_finish_ack_matches` expects the key to be absent
            // when no setter ran; a JSON `null` is a different wire value.
            let attempted_settings = attempted.map(|value| json!({"tempLimitC": value}))
                .unwrap_or_else(|| json!({}));
            let finish = json!({
                "type": "temperature-refusal-cache:finish",
                "schemaVersion": 1,
                "epoch": entry.epoch,
                "transactionSequence": entry.sequence,
                "cacheGeneration": generation,
                "target": entry.target,
                "publication": publication,
                "attemptedSettings": attempted_settings,
                "ranges": entry.ranges,
                "perControl": result.get("perControl").cloned().unwrap_or(json!({})),
                "cache": {"status": "available", "ceilings": {"tempLimitC": ceiling}},
            });
            arc_power_tauri::backend::wire::encode_json(&json!({
                "leaseId": lease_id, "result": result, "snapshot": finish,
            }))
        }
        "__native-temperature-apply-lease:cancel" => {
            let request_id = payload["requestId"].as_str().unwrap_or("").to_owned();
            let released = NATIVE_LEASES.lock().ok()
                .and_then(|mut leases| leases.iter().find(|(_, entry)| entry.request_id == request_id)
                    .map(|(id, _)| id.clone()))
                .and_then(|lease_id| NATIVE_LEASES.lock().ok().and_then(|mut leases| leases.remove(&lease_id)))
                .is_some();
            if released {
                let _ = native_transaction_request(broker, "apply-transaction-cancel", json!([request_id]));
            }
            arc_power_tauri::backend::wire::encode_json(&json!({
                "requestId": request_id, "cancelled": true, "leaseReleased": released,
            }))
        }
        _ => Err(format!("Unknown native private channel: {channel}")),
    }
}

fn private_broker_request(broker: &Broker, channel: &str, payload: arc_power_tauri::backend::wire::WireValue) -> Reply {
    if channel.starts_with("__native-temperature-apply-lease:") {
        return native_private_invoke(broker, channel, &payload);
    }
    let args = arc_power_tauri::backend::wire::tagged(&arc_power_tauri::backend::wire::WireValue::Array(vec![payload]));
    broker.request(json!({"kind":"invoke","target":"main","channel":channel,"args":args}))
}

fn private_broker_request_json(broker: &Broker, channel: &str, payload: &Value) -> Reply {
    let encoded = arc_power_tauri::backend::wire::encode_json(payload)?;
    let payload = arc_power_tauri::backend::wire::decode(&encoded)?;
    private_broker_request(broker, channel, payload)
}

fn cancellation_acknowledged(broker: &Broker, request_id: &str) -> bool {
    let payload = json!({"requestId": request_id});
    let Ok(response) = private_broker_request_json(broker, "__native-temperature-apply-lease:cancel", &payload) else { return false; };
    let Ok(response) = arc_power_tauri::backend::wire::decode(&response) else { return false; };
    wire_text(wire_field(&response, "requestId").unwrap_or(&arc_power_tauri::backend::wire::WireValue::Undefined)) == Some(request_id)
        && wire_field(&response, "cancelled").is_some_and(|value| matches!(value, arc_power_tauri::backend::wire::WireValue::Bool(true)))
        && wire_field(&response, "leaseReleased").is_some_and(|value| matches!(value, arc_power_tauri::backend::wire::WireValue::Bool(_)))
}

fn begin_temperature_lease(response: &Value, request_id: &str) -> Result<(String, arc_power_tauri::backend::wire::WireValue), String> {
    let decoded = arc_power_tauri::backend::wire::decode(response)?;
    let lease_id = wire_text(wire_field(&decoded, "leaseId").ok_or("Native temperature lease ID is missing")?)
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
        .ok_or("Native temperature lease ID is invalid")?.to_owned();
    if wire_text(wire_field(&decoded, "requestId").ok_or("Native temperature lease request ID is missing")?) != Some(request_id) {
        return Err("Native temperature lease request ID did not match".into());
    }
    let snapshot = wire_field(&decoded, "snapshot").ok_or("Native temperature lease snapshot is missing")?.clone();
    Ok((lease_id, snapshot))
}

fn temperature_finish_ack_matches(
    response: &Value,
    lease_id: &str,
    begin: &arc_power_tauri::backend::wire::WireValue,
    result: &Value,
    attempted_value: Option<f64>,
) -> bool {
    let Ok(ack) = arc_power_tauri::backend::wire::decode(response) else { return false; };
    if wire_text(wire_field(&ack, "leaseId").unwrap_or(&arc_power_tauri::backend::wire::WireValue::Undefined)) != Some(lease_id) { return false; }
    let Some(finish) = wire_field(&ack, "snapshot") else { return false; };
    if wire_text(wire_field(finish, "type").unwrap_or(&arc_power_tauri::backend::wire::WireValue::Undefined)) != Some("temperature-refusal-cache:finish")
        || wire_uint(wire_field(finish, "schemaVersion").unwrap_or(&arc_power_tauri::backend::wire::WireValue::Undefined)) != Some(1)
        || wire_field(finish, "epoch") != wire_field(begin, "epoch")
        || wire_field(finish, "transactionSequence") != wire_field(begin, "transactionSequence")
        || wire_field(finish, "target") != wire_field(begin, "target")
        || wire_field(finish, "ranges") != wire_field(begin, "ranges") {
        return false;
    }
    let Some(begin_generation) = wire_uint(wire_field(begin, "cacheGeneration").unwrap_or(&arc_power_tauri::backend::wire::WireValue::Undefined)) else { return false; };
    let Some(finish_generation) = wire_uint(wire_field(finish, "cacheGeneration").unwrap_or(&arc_power_tauri::backend::wire::WireValue::Undefined)) else { return false; };
    if finish_generation < begin_generation { return false; }
    let Some(cache) = wire_field(finish, "cache") else { return false; };
    if wire_text(wire_field(cache, "status").unwrap_or(&arc_power_tauri::backend::wire::WireValue::Undefined)) != Some("available") { return false; }
    let Some(ceilings) = wire_field(cache, "ceilings") else { return false; };
    let Some(begin_cache) = wire_field(begin, "cache") else { return false; };
    let Some(begin_ceilings) = wire_field(begin_cache, "ceilings") else { return false; };
    let begin_ceiling = wire_field(begin_ceilings, "tempLimitC");
    let finish_ceiling = wire_field(ceilings, "tempLimitC");
    let ceiling_value = |value: Option<&arc_power_tauri::backend::wire::WireValue>| match value {
        Some(arc_power_tauri::backend::wire::WireValue::Undefined) | None => Some(None),
        Some(value) => wire_finite(value).map(Some),
    };
    let (Some(begin_ceiling), Some(finish_ceiling)) = (ceiling_value(begin_ceiling), ceiling_value(finish_ceiling)) else { return false; };
    if begin_ceiling.is_some_and(|previous| finish_ceiling.is_some_and(|current| current > previous)) { return false; }
    let Some(per_control) = result.get("perControl") else { return false; };
    let Some(temp_result) = per_control.get("tempLimitC") else { return false; };
    let driver_refusal = temp_result.get("ok") == Some(&Value::Bool(false))
        && temp_result.get("errorCode").and_then(Value::as_str) == Some("out-of-range");
    let expected_publication = if driver_refusal && attempted_value.is_some() { "committed" } else { "not-required" };
    if wire_text(wire_field(finish, "publication").unwrap_or(&arc_power_tauri::backend::wire::WireValue::Undefined)) != Some(expected_publication) { return false; }
    if attempted_value.is_none() && finish_ceiling != begin_ceiling { return false; }
    if finish_ceiling != begin_ceiling && finish_generation <= begin_generation { return false; }
    let Some(attempted_settings) = wire_field(finish, "attemptedSettings") else { return false; };
    let Some(ack_attempted) = wire_field(attempted_settings, "tempLimitC") else { return false; };
    match attempted_value {
        Some(expected) if wire_finite(ack_attempted) == Some(expected) => {},
        None if matches!(ack_attempted, arc_power_tauri::backend::wire::WireValue::Undefined) => {},
        _ => return false,
    }
    let Some(ack_result) = wire_field(&ack, "result") else { return false; };
    let Ok(ack_result) = wire_plain_json(ack_result) else { return false; };
    if ack_result != *result { return false; }
    let Some(ack_per_control) = wire_field(finish, "perControl") else { return false; };
    wire_plain_json(ack_per_control).ok().as_ref() == Some(per_control)
}

fn finish_temperature_lease(
    broker: &Broker,
    lease_id: &str,
    begin: &arc_power_tauri::backend::wire::WireValue,
    outcome: &str,
    result: &Value,
    attempted_value: Option<f64>,
) -> Result<(), String> {
    let encoded_result = arc_power_tauri::backend::wire::encode_json(result)?;
    let result_wire = arc_power_tauri::backend::wire::decode(&encoded_result)?;
    let attempted = attempted_value.map(|value| serde_json::Number::from_f64(value)
        .map(arc_power_tauri::backend::wire::WireValue::Number)
        .ok_or("Native temperature setter value is non-finite"))
        .transpose()?
        .unwrap_or(arc_power_tauri::backend::wire::WireValue::Undefined);
    let payload = arc_power_tauri::backend::wire::WireValue::Object(vec![
        ("leaseId".into(), arc_power_tauri::backend::wire::WireValue::String(lease_id.to_owned())),
        ("outcome".into(), arc_power_tauri::backend::wire::WireValue::String(outcome.to_owned())),
        ("attemptedValue".into(), attempted),
        ("result".into(), result_wire),
    ]);
    let response = private_broker_request(broker, "__native-temperature-apply-lease:finish", payload)?;
    if !temperature_finish_ack_matches(&response, lease_id, begin, result, attempted_value) {
        return Err("Native temperature cache publication acknowledgement is invalid".into());
    }
    Ok(())
}

fn finish_unknown_temperature_lease(broker: &Broker, lease_id: &str, reason: &str) {
    let payload = json!({"leaseId":lease_id,"outcome":"unknown","reason":reason});
    let _ = private_broker_request_json(broker, "__native-temperature-apply-lease:finish", &payload);
}

fn ordinary_apply_fallback(broker: &Broker, target: &str, args: &Value) -> Reply {
    broker.wait_channel_ready("apply-settings")?;
    broker.request(json!({"kind":"invoke","target":target,"channel":"apply-settings","args":args}))
}

/// The lease finish contract accepts only a single-control temperature result
/// (`ok` mirrored on the entry, an `errorCode` on a refusal). A pre-setter
/// decline therefore finishes with this envelope and never with the mode-gate
/// shape (an `out-of-range` entry without an attempted setter value would be
/// rejected by the broker and would poison the process-wide refusal cache).
fn temperature_pre_setter_decline() -> Value {
    json!({"ok":false,"perControl":{"tempLimitC":{
        "ok":false,"errorCode":"unsupported","message":"Native temperature apply declined before the setter."
    }}})
}

/// How a leased temperature apply must finish. Every variant is reachable
/// without a broker, so the fail-closed rules are unit-testable.
enum TemperatureLeaseDecision {
    /// The native call panicked: finish unknown and fail closed.
    Panicked { reason: &'static str, error: &'static str },
    /// No native reply: finish not-applied and let the broker answer.
    NoReply,
    /// A pre-setter capability/mode refusal: finish not-applied, then broker.
    DeclineBeforeSetter,
    /// A publishable reply with the value the lease must publish.
    Publish { response: Value, attempted_value: Option<f64>, encoded_reply: Value },
    /// The outcome is unknown: finish unknown and never fall back.
    UnknownOutcome { reason: &'static str, error: String },
    /// The native call failed before any setter: finish not-applied, no fallback.
    KnownNotApplied { error: String },
}

/// Classify a finished leased temperature execution. Anything that may have
/// reached a setter (panic, after-setter error, malformed reply) fails closed
/// with an unknown outcome and must never be retried through the broker. Only a
/// pre-setter decline (or the absence of a native reply) falls back.
fn temperature_lease_decision(
    execution: &Result<Option<(Result<Value, String>, Option<f64>)>, ()>,
    panic_reason: &'static str,
) -> TemperatureLeaseDecision {
    let execution = match execution {
        Err(()) => return TemperatureLeaseDecision::Panicked {
            reason: panic_reason,
            error: "Native temperature apply outcome is unknown; refresh before another apply",
        },
        Ok(execution) => execution,
    };
    let Some((reply, attempted_value)) = execution else {
        return TemperatureLeaseDecision::NoReply;
    };
    let attempted_value = *attempted_value;
    let encoded_reply = match reply {
        Ok(encoded_reply) => encoded_reply,
        Err(error) if attempted_value.is_some() => return TemperatureLeaseDecision::UnknownOutcome {
            reason: "native temperature apply failed after a setter attempt",
            error: format!("Native temperature apply outcome is unknown after setter attempt: {error}"),
        },
        Err(error) => return TemperatureLeaseDecision::KnownNotApplied { error: error.clone() },
    };
    let response = match arc_power_tauri::backend::wire::decode(encoded_reply).and_then(|value| value.into_json()) {
        Ok(response) => response,
        Err(error) => return TemperatureLeaseDecision::UnknownOutcome {
            reason: "native temperature result was malformed",
            error: format!("Native temperature result was malformed: {error}"),
        },
    };
    let oc_mode_refused = response.get("ocModeRefused").and_then(Value::as_bool).unwrap_or(false);
    if arc_power_tauri::backend::apply_gates::is_pre_setter_refusal(
        response.get("result").unwrap_or(&Value::Null), attempted_value, oc_mode_refused,
    ) {
        return TemperatureLeaseDecision::DeclineBeforeSetter;
    }
    TemperatureLeaseDecision::Publish { response, attempted_value, encoded_reply: encoded_reply.clone() }
}

/// How one leased apply settles on the broker seam, before the caller applies
/// its own pre-setter-decline policy. Every variant leaves the lease settled.
enum NativeApplyRun {
    /// The native reply, wire-encoded.
    Replied(Value),
    /// The native call declined before any setter; the lease is not-applied and
    /// nothing was written.
    Declined,
    /// The outcome is unknown or the call failed; never retried through the
    /// compatibility broker.
    Failed(String),
}

/// Settle a leased temperature apply: perform the finish the decision requires
/// and report what the caller may do next. `finish` publishes a
/// `completed`/`not-applied` outcome, `finish_unknown` is the fail-closed path
/// that must never publish a pre-setter refusal as a driver refusal, and
/// `shape_finish` reduces a native reply to the single-control result the finish
/// contract accepts.
fn settle_leased_apply(
    decision: TemperatureLeaseDecision,
    finish: impl FnOnce(&str, &Value, Option<f64>) -> Result<(), String>,
    finish_unknown: impl FnOnce(&'static str),
    shape_finish: impl FnOnce(&Value) -> Result<Value, (&'static str, String)>,
) -> NativeApplyRun {
    match decision {
        TemperatureLeaseDecision::Panicked { reason, error } => {
            finish_unknown(reason);
            NativeApplyRun::Failed(error.into())
        }
        TemperatureLeaseDecision::NoReply | TemperatureLeaseDecision::DeclineBeforeSetter => {
            // Nothing reached a setter: finish not-applied. The caller decides
            // whether the compatibility broker answers from here.
            match finish("not-applied", &temperature_pre_setter_decline(), None) {
                Ok(()) => NativeApplyRun::Declined,
                Err(error) => NativeApplyRun::Failed(error),
            }
        }
        TemperatureLeaseDecision::UnknownOutcome { reason, error } => {
            finish_unknown(reason);
            NativeApplyRun::Failed(error)
        }
        TemperatureLeaseDecision::KnownNotApplied { error } => {
            let known_not_applied = json!({"ok":false,"perControl":{"tempLimitC":{
                "ok":false,"errorCode":"io-failed","message":error.clone()
            }}});
            match finish("not-applied", &known_not_applied, None) {
                Ok(()) => NativeApplyRun::Failed(error),
                Err(finish_error) => NativeApplyRun::Failed(finish_error),
            }
        }
        TemperatureLeaseDecision::Publish { response, attempted_value, encoded_reply } => {
            let result = match shape_finish(&response) {
                Ok(result) => result,
                Err((reason, error)) => {
                    finish_unknown(reason);
                    return NativeApplyRun::Failed(error);
                }
            };
            match finish("completed", &result, attempted_value) {
                Ok(()) => NativeApplyRun::Replied(encoded_reply),
                Err(error) => NativeApplyRun::Failed(error),
            }
        }
    }
}

/// Settle a leased temperature apply for a renderer. Both leased paths (a direct
/// temperature apply and a profile apply that carries a temperature) share this
/// wiring, so `not-applied`, `completed` and `unknown` and the single broker
/// fallback are decided in exactly one place.
fn settle_temperature_lease(
    decision: TemperatureLeaseDecision,
    finish: impl FnOnce(&str, &Value, Option<f64>) -> Result<(), String>,
    finish_unknown: impl FnOnce(&'static str),
    fallback: impl FnOnce() -> Reply,
    shape_finish: impl FnOnce(&Value) -> Result<Value, (&'static str, String)>,
) -> Reply {
    match settle_leased_apply(decision, finish, finish_unknown, shape_finish) {
        NativeApplyRun::Replied(encoded) => Ok(encoded),
        NativeApplyRun::Declined => fallback(),
        NativeApplyRun::Failed(error) => Err(error),
    }
}

/// Everything a lease begin needs from a proven apply request. `args` is the
/// original wire payload: the native call and the renderer fallback both use it
/// unchanged.
struct LeaseBegin<'a> {
    device_id: u64,
    device_key: String,
    physical_target: Value,
    requested_settings: Value,
    args: &'a Value,
}

/// A lease that was begun and executed on the native seam, before any outcome
/// policy is applied.
enum LeaseRun {
    Executed {
        lease_id: String,
        begin_snapshot: arc_power_tauri::backend::wire::WireValue,
        execution: Result<Option<(Result<Value, String>, Option<f64>)>, ()>,
    },
    /// The begin failed and cancellation was acknowledged: nothing reached a
    /// setter, so the compatibility broker may answer.
    Declined,
    /// The begin failed and could not be proven cancelled. Terminal; never
    /// retried through the compatibility broker.
    Failed(String),
}

/// Begin the broker's temperature lease and run the native apply exactly once.
/// This is the only caller of `invoke_with_temperature_lease`, so the direct
/// renderer lease, the profile lease and the host executor share one risky
/// path.
fn run_leased_native_apply(broker: &Broker, begin: LeaseBegin<'_>) -> LeaseRun {
    let mut bytes = [0_u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    let request_id = bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>();
    let begin_payload = json!({
        "requestId": request_id,
        "deviceId": begin.device_id,
        "deviceKey": begin.device_key,
        "physicalTarget": begin.physical_target,
        "requestedSettings": begin.requested_settings,
    });
    let begin_response = match private_broker_request_json(broker, "__native-temperature-apply-lease:begin", &begin_payload) {
        Ok(response) => response,
        Err(error) => {
            return if cancellation_acknowledged(broker, &request_id) {
                LeaseRun::Declined
            } else {
                LeaseRun::Failed(format!("Could not safely cancel native temperature preflight: {error}"))
            };
        }
    };
    let (lease_id, begin_snapshot) = match begin_temperature_lease(&begin_response, &request_id) {
        Ok(value) => value,
        Err(error) => {
            return if cancellation_acknowledged(broker, &request_id) {
                LeaseRun::Declined
            } else {
                LeaseRun::Failed(format!("Native temperature lease response was invalid and could not be cancelled: {error}"))
            };
        }
    };
    let service_context = arc_power_tauri::backend::services::ServiceContext {
        build_kind: broker.build_kind,
        mock_mode: broker.mock_mode,
        store: &broker.native_store,
    };
    let execution = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        arc_power_tauri::backend::services::invoke_with_temperature_lease(
            "apply-settings", begin.args, service_context, &begin_snapshot,
        )
    })).map_err(|_| ());
    LeaseRun::Executed { lease_id, begin_snapshot, execution }
}

/// Reduce a direct temperature reply to the single-control result the lease
/// finish contract accepts.
fn direct_temperature_finish(response: &Value) -> Result<Value, (&'static str, String)> {
    let result = response.get("result").ok_or((
        "native temperature result omitted per-control outcome",
        "Native temperature result omitted its apply outcome".to_owned(),
    ))?;
    if result.get("perControl").and_then(|controls| controls.get("tempLimitC")).is_none() {
        return Err((
            "native temperature result omitted per-control outcome",
            "Native temperature result omitted its per-control outcome".to_owned(),
        ));
    }
    Ok(result.clone())
}

/// The finish contract is temperature-only for a profile apply: reduce the
/// profile reply to its tempLimitC slice (a plan refusal, a driver refusal, or
/// a success).
fn profile_temperature_finish(response: &Value) -> Result<Value, (&'static str, String)> {
    let temp_result = response.get("result")
        .and_then(|result| result.get("perControl"))
        .and_then(|per_control| per_control.get("tempLimitC"))
        .cloned()
        .filter(|entry| entry.is_object() && entry.get("ok").and_then(Value::as_bool).is_some());
    let Some(temp_result) = temp_result else {
        return Err((
            "native profile result omitted its temperature outcome",
            "Native temperature result omitted its per-control outcome".to_owned(),
        ));
    };
    Ok(json!({
        "ok": temp_result.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "perControl": {"tempLimitC": temp_result},
    }))
}

/// Map a lease run into a renderer reply. Only a pre-setter decline falls back
/// to the compatibility broker, and it does so exactly once.
fn leased_renderer_reply(
    broker: &Broker,
    target: &str,
    args: &Value,
    begin: LeaseBegin<'_>,
    panic_reason: &'static str,
    shape_finish: fn(&Value) -> Result<Value, (&'static str, String)>,
) -> Reply {
    match run_leased_native_apply(broker, begin) {
        LeaseRun::Failed(error) => Err(error),
        LeaseRun::Declined => ordinary_apply_fallback(broker, target, args),
        LeaseRun::Executed { lease_id, begin_snapshot, execution } => settle_temperature_lease(
            temperature_lease_decision(&execution, panic_reason),
            |outcome, result, attempted| finish_temperature_lease(
                broker, &lease_id, &begin_snapshot, outcome, result, attempted,
            ),
            |reason| finish_unknown_temperature_lease(broker, &lease_id, reason),
            || ordinary_apply_fallback(broker, target, args),
            shape_finish,
        ),
    }
}

fn execute_native_temperature_apply(
    broker: &Broker,
    target: &str,
    args: &Value,
    request: arc_power_tauri::backend::services::NativeTemperatureApplyRequest,
) -> Reply {
    leased_renderer_reply(
        broker,
        target,
        args,
        LeaseBegin {
            device_id: request.device_id,
            device_key: request.device_key,
            physical_target: request.physical_target,
            requested_settings: request.settings,
            args,
        },
        "native temperature apply panicked",
        direct_temperature_finish,
    )
}

/// A profile apply that carries a temperature must publish that temperature
/// through the broker's shared refusal-cache lease: the lease begin holds the
/// compatibility apply FIFO while the native body runs, and the finish
/// envelope is the temperature-only slice of the profile reply.
fn execute_native_profile_apply(
    broker: &Broker,
    target: &str,
    args: &Value,
    request: arc_power_tauri::backend::services::NativeProfileApplyRequest,
) -> Reply {
    let requested_temperature = request.requested_temperature
        .filter(|value| value.is_finite())
        .ok_or("Native profile apply requires a finite temperature")?;
    leased_renderer_reply(
        broker,
        target,
        args,
        LeaseBegin {
            device_id: request.device_id,
            device_key: request.device_key,
            physical_target: request.physical_target,
            requested_settings: json!({"tempLimitC": requested_temperature}),
            args,
        },
        "native profile apply panicked",
        profile_temperature_finish,
    )
}

/// Run one native `apply-settings` through the shared process apply FIFO. This
/// is the only caller of `acquire_internal`, so the renderer FIFO branch and
/// the host executor take exactly the same turn ordering.
fn run_native_apply_fifo(broker: &Arc<Broker>, channel: &str, args: &Value) -> NativeApplyRun {
    let transaction = match broker.apply_transactions.acquire_internal(channel, None) {
        Ok(transaction) => transaction,
        Err(error) => return NativeApplyRun::Failed(error),
    };
    let store = broker.native_store.clone();
    // The lease route contains a panic in the setter the same way. A panic may
    // have run a setter, so it is terminal: never delegate after one.
    let native = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        arc_power_tauri::backend::services::invoke(channel, args,
            arc_power_tauri::backend::services::ServiceContext {
                build_kind: broker.build_kind, mock_mode: broker.mock_mode, store: &store,
            })
    }));
    drop(transaction);
    match native {
        Ok(Some(Ok(reply))) => NativeApplyRun::Replied(reply),
        Ok(Some(Err(error))) => NativeApplyRun::Failed(error),
        // `invoke` returns `None` only before any setter: the caller may still
        // hand the request to the compatibility broker.
        Ok(None) => NativeApplyRun::Declined,
        Err(_) => NativeApplyRun::Failed("Native apply panicked before completion".into()),
    }
}

/// Which shared native apply route claims a proven profile payload. The
/// renderer's lease branch and the host executor both ask this one predicate,
/// so they cannot disagree about which route owns a profile.
enum ProfileApplyRoute {
    /// A profile that carries a temperature: the broker lease owns the FIFO.
    Lease(arc_power_tauri::backend::services::NativeProfileApplyRequest),
    /// A temperature-free profile: the native FIFO owns the turn.
    Fifo,
    /// Not a native-claimable profile payload.
    Unclaimed,
}

fn profile_apply_route(args: &Value) -> ProfileApplyRoute {
    match arc_power_tauri::backend::services::native_profile_apply_request(args) {
        Ok(Some(request)) if request.requested_temperature.is_some() => {
            ProfileApplyRoute::Lease(request)
        }
        Ok(Some(_)) if arc_power_tauri::backend::services::native_apply_transaction_candidate(args) => {
            ProfileApplyRoute::Fifo
        }
        _ => ProfileApplyRoute::Unclaimed,
    }
}

/// Which host a run is. Mock wins over elevation: a mock process must never
/// probe or apply a real device.
fn host_apply_host(mock_mode: bool, elevated: bool) -> arc_power_tauri::backend::host_apply::HostApplyHost {
    use arc_power_tauri::backend::host_apply::HostApplyHost;
    if mock_mode { HostApplyHost::Mock }
    else if elevated { HostApplyHost::ElevatedNative }
    else { HostApplyHost::Unelevated }
}

/// Read one zero-argument native store document through the same `NativeStore`
/// seam the renderer's load channels use.
fn native_store_json(
    store: &arc_power_tauri::backend::native_store::NativeStore,
    method: &str,
) -> Result<Value, String> {
    store.invoke(method, &json!({"t":"array","v":[]}))
}

/// Decode one native `apply-settings` reply into the host execution vocabulary.
fn decode_host_apply_reply(
    encoded: Value,
) -> Result<arc_power_tauri::backend::host_apply::HostApplyExecution, String> {
    let decoded = arc_power_tauri::backend::wire::decode(&encoded)?.into_json()?;
    Ok(arc_power_tauri::backend::host_apply::HostApplyExecution::Replied(decoded))
}

/// Pure composition of route selection with the two executors. Keeping this
/// separate from the broker-backed wrapper lets tests pin which route a host
/// plan takes without starting a compatibility service. An error means a setter
/// may have run, so it is terminal and never a broker fallback.
fn dispatch_host_profile_plan(
    plan: &arc_power_tauri::backend::host_apply::HostApplyPlan,
    lease: impl FnOnce(arc_power_tauri::backend::services::NativeProfileApplyRequest)
        -> Result<arc_power_tauri::backend::host_apply::HostApplyExecution, String>,
    fifo: impl FnOnce(&Value)
        -> Result<arc_power_tauri::backend::host_apply::HostApplyExecution, String>,
) -> Result<arc_power_tauri::backend::host_apply::HostApplyExecution, String> {
    use arc_power_tauri::backend::host_apply::HostApplyExecution;
    match profile_apply_route(&plan.payload) {
        ProfileApplyRoute::Lease(request) => lease(request),
        ProfileApplyRoute::Fifo => fifo(&plan.payload),
        // A proven host plan always lands on one of the two routes. Treat
        // anything else as "nothing written" so the caller may delegate.
        ProfileApplyRoute::Unclaimed => Ok(HostApplyExecution::Declined),
    }
}

/// Execute a host plan on the single shared native route.
fn run_host_profile_plan(
    broker: &Arc<Broker>,
    plan: &arc_power_tauri::backend::host_apply::HostApplyPlan,
) -> Result<arc_power_tauri::backend::host_apply::HostApplyExecution, String> {
    use arc_power_tauri::backend::host_apply::HostApplyExecution;
    dispatch_host_profile_plan(
        plan,
        |request| {
            let requested_temperature = request.requested_temperature
                .filter(|value| value.is_finite())
                .ok_or("Native profile apply requires a finite temperature")?;
            let run = run_leased_native_apply(broker, LeaseBegin {
                device_id: request.device_id,
                device_key: request.device_key,
                physical_target: request.physical_target,
                requested_settings: json!({"tempLimitC": requested_temperature}),
                args: &plan.payload,
            });
            match run {
                LeaseRun::Failed(error) => Err(error),
                LeaseRun::Declined => Ok(HostApplyExecution::Declined),
                LeaseRun::Executed { lease_id, begin_snapshot, execution } => {
                    match settle_leased_apply(
                        temperature_lease_decision(&execution, "native profile apply panicked"),
                        |outcome, result, attempted| finish_temperature_lease(
                            broker, &lease_id, &begin_snapshot, outcome, result, attempted,
                        ),
                        |reason| finish_unknown_temperature_lease(broker, &lease_id, reason),
                        profile_temperature_finish,
                    ) {
                        NativeApplyRun::Replied(encoded) => decode_host_apply_reply(encoded),
                        NativeApplyRun::Declined => Ok(HostApplyExecution::Declined),
                        NativeApplyRun::Failed(error) => Err(error),
                    }
                }
            }
        },
        |args| match run_native_apply_fifo(broker, "apply-settings", args) {
            NativeApplyRun::Replied(encoded) => decode_host_apply_reply(encoded),
            NativeApplyRun::Declined => Ok(HostApplyExecution::Declined),
            NativeApplyRun::Failed(error) => Err(error),
        },
    )
}

/// Build the default-value settings patch used by native `reset-to-defaults`.
/// Every written value comes from the device's own capability ranges, never a
/// product constant; an unproven field is simply omitted.
fn reset_settings_from_capabilities(caps: &Value, state: &Value) -> Value {
    let mut settings = serde_json::Map::new();
    if let Some(ranges) = caps.get("ranges").and_then(Value::as_object) {
        for (key, range) in ranges {
            if let Some(default) = range.get("default") {
                if default.is_number() { settings.insert(key.clone(), default.clone()); }
            }
        }
    }
    if caps.get("fan").and_then(|fan| fan.get("modes")).and_then(Value::as_array)
        .is_some_and(|modes| modes.iter().any(|mode| mode.as_str() == Some("auto"))) {
        settings.insert("fanMode".into(), json!("auto"));
    }
    if let Some(default_curve) = state.get("vfCurveDefault").filter(|value| !value.is_null()) {
        settings.insert("vfCurve".into(), default_curve.clone());
    }
    Value::Object(settings)
}

fn native_reset_to_defaults(broker: &Arc<Broker>, device_id: u64) -> Result<Value, String> {
    use arc_power_tauri::backend::wire::{decode, encode_json};
    let target = arc_power_tauri::backend::gpu_devices::list_devices_merged()
        .as_array().and_then(|rows| rows.iter().find(|row| row["id"].as_u64() == Some(device_id)))
        .cloned().ok_or_else(|| "reset-to-defaults: selected GPU is no longer available".to_owned())?;
    let target_args = encode_json(&json!([device_id]))?;
    let caps_reply = arc_power_tauri::backend::services::invoke("get-capabilities", &target_args,
        arc_power_tauri::backend::services::ServiceContext {
            build_kind: broker.build_kind, mock_mode: broker.mock_mode, store: &broker.native_store,
        }
    ).ok_or_else(|| "reset-to-defaults: GPU capabilities are unavailable".to_owned())??;
    let caps = decode(&caps_reply)?.into_json()?;
    let state_args = encode_json(&json!([device_id]))?;
    let state_reply = arc_power_tauri::backend::services::invoke("get-current-settings", &state_args,
        arc_power_tauri::backend::services::ServiceContext {
            build_kind: broker.build_kind, mock_mode: broker.mock_mode, store: &broker.native_store,
        }
    ).ok_or_else(|| "reset-to-defaults: GPU state is unavailable".to_owned())??;
    let state = decode(&state_reply)?.into_json()?;
    let settings = reset_settings_from_capabilities(&caps, &state);
    let expected = json!({
        "deviceKey": target["deviceKey"],
        "physicalTarget": {
            "deviceKey": target["deviceKey"],
            "pciVendorId": target["pciVendorId"],
            "pciDeviceId": target["pciDeviceId"],
            "bdf": target["bdf"],
            "luid": target["luid"],
        },
    });
    let args = encode_json(&json!([device_id, settings, {"expectedTarget": expected}]))?;
    match run_native_apply_fifo(broker, "apply-settings", &args) {
        NativeApplyRun::Replied(encoded) => {
            let reply = decode(&encoded)?.into_json()?;
            Ok(json!({"state": reply.get("state").cloned().unwrap_or(reply)}))
        }
        NativeApplyRun::Declined => Err("reset-to-defaults: native apply declined before any write".into()),
        NativeApplyRun::Failed(error) => Err(format!("reset-to-defaults: {error}")),
    }
}

fn recording_active_modes(state: &Value) -> (bool, bool) {
    let active = |mode: &str| -> bool {
        state["activeModes"].as_object()
            .and_then(|modes| modes.get(mode))
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                state["mode"].as_str() == Some(mode) && state["running"].as_bool() == Some(true)
            })
    };
    (active("video"), active("replay"))
}

const NATIVE_OVERLAY_LABEL: &str = "overlay-1000000";

fn publish_native_overlay_settings(app: &tauri::AppHandle, broker: &Broker, target: &str) {
    let settings = broker.native_store.settings_store().load_settings_sync().ok().flatten()
        .unwrap_or_else(|| json!({}));
    let text = |key: &str, fallback: &str| settings.get(key).and_then(Value::as_str)
        .unwrap_or(fallback).to_owned();
    let payload = json!({
        "scale": settings.get("overlayScale").cloned().unwrap_or(json!(1.0)),
        "renderer": text("overlayRenderer", "rtss"),
        "softwareRenderer": false,
        "enabled": settings.get("overlayEnabled").cloned().unwrap_or(json!(false)),
        "color": text("overlayColor", "#ffffff"),
        "labelColor": text("overlayLabelColor", "#ffffff"),
        "valueColor": text("overlayValueColor", "#ffffff"),
        "stats": settings.get("overlayStats").cloned().unwrap_or(json!([])),
        "position": text("overlayPosition", "top-left"),
        // The overlay renderer reads the fully-prefixed names; unprefixed keys
        // were silently ignored, so none of the appearance settings landed.
        "overlayBgEnabled": settings.get("overlayBgEnabled").cloned().unwrap_or(json!(false)),
        "overlayBgColor": text("overlayBgColor", "#000000"),
        "overlayBgOpacity": settings.get("overlayBgOpacity").cloned().unwrap_or(json!(0.5)),
        "chipNames": settings.get("overlayChipNames").cloned().unwrap_or(json!(false)),
        "pollMs": settings.get("overlayPollMs").cloned().unwrap_or(json!(600)),
        "theme": text("overlayTheme", "arc"),
        "deviceKeys": settings.get("overlayDeviceKeys").cloned().unwrap_or(Value::Null),
    });
    let _ = app.emit_to(target, "arc-power:broker-event",
        json!({"channel":"overlay:settings","args":[payload]}));
}

fn native_overlay_geometry(app: &tauri::AppHandle, broker: &Broker) -> (f64, f64, f64, f64) {
    let settings = broker.native_store.settings_store().load_settings_sync().ok().flatten()
        .unwrap_or_else(|| json!({}));
    let scale = settings.get("overlayScale").and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0).unwrap_or(1.0).clamp(0.5, 2.0);
    let position = settings.get("overlayPosition").and_then(Value::as_str).unwrap_or("top-left");
    let monitor = app.get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (origin_x, origin_y, area_w, area_h) = match monitor {
        Some(monitor) => {
            let work = monitor.work_area();
            (work.position.x as f64, work.position.y as f64, work.size.width as f64, work.size.height as f64)
        }
        None => (0.0, 0.0, 1920.0, 1080.0),
    };
    let width = (900.0 * scale).min(area_w - 32.0).max(200.0);
    let height = (500.0 * scale).min(area_h - 32.0).max(120.0);
    let margin = 16.0;
    let x = if position.ends_with("right") { origin_x + area_w - width - margin } else { origin_x + margin };
    let y = if position.starts_with("bottom") { origin_y + area_h - height - margin } else { origin_y + margin };
    (x, y, width, height)
}

/// Apply the persisted overlay geometry to a live overlay window.
fn native_overlay_apply_geometry(app: &tauri::AppHandle, broker: &Broker) {
    let Some(window) = app.get_webview_window(NATIVE_OVERLAY_LABEL) else {
        eprintln!("[overlay] geometry requested but no overlay window exists");
        return;
    };
    let (x, y, width, height) = native_overlay_geometry(app, broker);
    eprintln!("[overlay] applying geometry x={x} y={y} w={width} h={height}");
    let _ = window.set_position(tauri::Position::Physical(tauri::PhysicalPosition { x: x as i32, y: y as i32 }));
    let _ = window.set_size(tauri::Size::Physical(tauri::PhysicalSize { width: width as u32, height: height as u32 }));
}

/// Show/hide the host-owned Arc Power overlay window. The role document is the
/// same one Electron used, so the renderer contract is unchanged.
fn native_overlay_toggle(app: &tauri::AppHandle, broker: &Broker) {
    let (x, y, width, height) = native_overlay_geometry(app, broker);
    if let Some(window) = app.get_webview_window(NATIVE_OVERLAY_LABEL) {
        native_overlay_apply_geometry(app, broker);
        publish_native_overlay_settings(app, broker, NATIVE_OVERLAY_LABEL);
        if window.is_visible().unwrap_or(false) { let _ = window.hide(); }
        else { let _ = window.show(); }
        return;
    }
    if let Err(error) = create_auxiliary_window(app, NATIVE_OVERLAY_LABEL, "overlay", x, y, width, height, None) {
        eprintln!("[overlay] could not create native window: {error}");
        return;
    }
    if let Some(window) = app.get_webview_window(NATIVE_OVERLAY_LABEL) {
        let _ = window.show();
    }
}

const RECORDING_TOAST_LABEL: &str = "recording-toast-1000001";
static LAST_RECORDING_TOAST: Mutex<u64> = Mutex::new(0);
static PENDING_RECORDING_TOAST: Mutex<Option<Value>> = Mutex::new(None);

pub(crate) fn flush_pending_recording_toast(app: &tauri::AppHandle) {
    let pending = PENDING_RECORDING_TOAST.lock().ok().and_then(|mut value| value.take());
    if let Some(payload) = pending {
        let _ = app.emit_to(RECORDING_TOAST_LABEL, "arc-power:broker-event",
            json!({"channel":"recording:notification","args":[payload]}));
    }
}

/// Show one recording notification in a host-owned toast WebView. The window is
/// created lazily and destroyed after the notification expires so a single
/// toast does not leave a resident WebView process behind.
fn native_recording_toast(app: &tauri::AppHandle, broker: &Arc<Broker>, notification: Value) {
    if broker.mock_mode || !arc_power_tauri::backend::arc_sleep_system::host_elevated() { return; }
    let settings = broker.native_store.settings_store().load_settings_sync().ok().flatten();
    let enabled = settings.as_ref()
        .and_then(|value| value.get("recordingToastsEnabled"))
        .and_then(Value::as_bool) == Some(true);
    let always_show = notification["always"].as_bool() == Some(true);
    if !enabled && !always_show { return; }

    let variant = match notification["variant"].as_str() {
        Some("error") => "error", Some("info") => "info", _ => "success",
    };
    let title = notification["title"].as_str().unwrap_or("Arc Power").chars().take(120).collect::<String>();
    let message = notification["message"].as_str().unwrap_or("").chars().take(360).collect::<String>();
    let duration = notification["durationMs"].as_u64()
        .unwrap_or(4200).clamp(1600, 12000);
    let payload = json!({
        "variant": variant,
        "title": if title.trim().is_empty() { "Arc Power" } else { title.trim() },
        "message": message.trim(),
        "durationMs": duration,
    });

    let (x, y) = match app.primary_monitor() {
        Ok(Some(monitor)) => {
            let work = monitor.work_area();
            (work.position.x as f64 + work.size.width as f64 - 390.0 - 22.0,
             work.position.y as f64 + work.size.height as f64 - 88.0 - 22.0)
        }
        _ => (1600.0, 900.0),
    };
    if app.get_webview_window(RECORDING_TOAST_LABEL).is_none() {
        let theme = settings.as_ref().and_then(|value| value.get("theme")).and_then(Value::as_str);
        if let Err(error) = create_auxiliary_window(app, RECORDING_TOAST_LABEL, "recording-toast",
            x, y, 390.0, 88.0, theme) {
            eprintln!("[recording-toast] could not create window: {error}");
            return;
        }
    }
    let token = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos() as u64).unwrap_or(0);
    if let Ok(mut last) = LAST_RECORDING_TOAST.lock() { *last = token; }
    // A newly created WebView is not listening yet. Keep the notification until
    // its renderer_ready flushes it, with a delayed emit as a second path.
    if let Ok(mut pending) = PENDING_RECORDING_TOAST.lock() { *pending = Some(payload.clone()); }

    // The WebView may still be loading; a short delayed emit covers both the
    // just-created and already-live window cases.
    let emit_app = app.clone();
    let emit_payload = payload.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(180));
        let _ = emit_app.emit_to(RECORDING_TOAST_LABEL, "arc-power:broker-event",
            json!({"channel":"recording:notification","args":[emit_payload]}));
    });
    let hide_app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(duration));
        let current = LAST_RECORDING_TOAST.lock().map(|value| *value).unwrap_or(0);
        if current == token {
            if let Some(window) = hide_app.get_webview_window(RECORDING_TOAST_LABEL) {
                let _ = window.destroy();
            }
        }
    });
}

/// Native "Apply active profile" coordinator shared by the tray and boot paths.
/// Planning every entry before any setter is crucial: if one active GPU cannot
/// be proved natively, the WHOLE action stays broker-owned instead of applying
/// some profiles twice. Boot additionally honours the `ocOnBoot` intent.
/// Returns `true` only when the native host owned the complete action.
fn host_profile_apply_all(
    broker: &Arc<Broker>,
    app: &tauri::AppHandle,
    label: &str,
    require_oc_on_boot: bool,
) -> bool {
    use arc_power_tauri::backend::host_apply::{
        execute_host_profile_apply, host_delegate_reason, plan_host_profile, HostApplyOutcome,
        HostApplyReads, HostCapabilities, HostTarget,
    };
    let active_invocation = match begin_active_invocation(broker) {
        Ok(guard) => guard,
        // Another apply owns the shared route. Consume this click rather than
        // relaying it to the broker, whose Electron apply would race the owner.
        Err(error) => { eprintln!("[{label}] ignored while another apply is active: {error}"); return true; }
    };
    let host = host_apply_host(
        broker.mock_mode,
        arc_power_tauri::backend::arc_sleep_system::host_elevated(),
    );
    if let Some(reason) = host_delegate_reason(host) {
        eprintln!("[{label}] delegated: {reason}");
        return false;
    }
    let store = broker.native_store.clone();
    let settings = match native_store_json(&store, "load-settings") {
        Ok(settings) => settings,
        Err(error) => { eprintln!("[{label}] settings unavailable: {error}"); return false; }
    };
    // The boot path only applies when the user configured start-at-boot. With
    // no intent there is nothing to write and the broker applies nothing either.
    if require_oc_on_boot && settings.get("ocOnBoot").and_then(Value::as_bool) != Some(true) {
        return true;
    }
    let profiles = match native_store_json(&store, "load-profiles")
        .and_then(|value| value.as_array().cloned()
            .ok_or_else(|| "Profiles document is not an array".to_owned()))
    {
        Ok(profiles) => profiles,
        Err(error) => { eprintln!("[{label}] {error}"); return false; }
    };
    let entries = arc_power_tauri::backend::profile_store::active_profile_entries(&settings, &profiles);
    if entries.is_empty() { return true; }
    let inventory = arc_power_tauri::backend::gpu_devices::list_devices_merged()
        .as_array().cloned().unwrap_or_default();
    let (legacy_power, legacy_temp) = arc_power_tauri::backend::legacy_igcl::capability();
    let capabilities = HostCapabilities {
        extended: legacy_power || legacy_temp,
        sysman_power_limits: arc_power_tauri::backend::sysman::SysmanSession::load().is_ok(),
    };
    let caps = |target: &HostTarget| -> Option<Value> {
        let encoded = arc_power_tauri::backend::wire::encode_json(&json!([target.device_id])).ok()?;
        let result = arc_power_tauri::backend::services::invoke(
            "get-capabilities", &encoded,
            arc_power_tauri::backend::services::ServiceContext {
                build_kind: broker.build_kind,
                mock_mode: broker.mock_mode,
                store: &store,
            },
        )?.ok()?;
        arc_power_tauri::backend::wire::decode(&result).ok()?.into_json().ok()
    };

    let mut prepared: Vec<(String, String, u64, HostApplyOutcome)> = Vec::new();
    for entry in &entries {
        let profile_id = entry["profileId"].as_str().unwrap_or_default().to_owned();
        let device_key = entry["deviceKey"].as_str().unwrap_or_default().to_owned();
        let reads = HostApplyReads {
            settings: &|| Ok(settings.clone()),
            profiles: &|| Ok(profiles.clone()),
            inventory: &|| inventory.clone(),
            caps: &caps,
            capabilities,
        };
        let outcome = plan_host_profile(host, &profile_id, Some(&device_key), &reads);
        let (device_id, plannable) = match &outcome {
            HostApplyOutcome::Planned(plan) => (plan.target.device_id, true),
            _ => (0, false),
        };
        if !plannable {
            eprintln!("[{label}] delegated profile '{profile_id}': {:?}", outcome.reason());
            return false;
        }
        prepared.push((profile_id, device_key, device_id, outcome));
    }

    // Execute off the host event loop: capability reads and GPU writes are slow,
    // and the loop still has to tick Arc Sleep and route telemetry. The active
    // invocation guard moves into the worker so it stays owned until the last
    // profile finishes.
    let exec_broker = broker.clone();
    let exec_app = app.clone();
    let thread_name = format!("arc-{label}");
    let log_label = label.to_owned();
    let spawned = std::thread::Builder::new().name(thread_name).spawn(move || {
        let _active_invocation = active_invocation;
        for (profile_id, device_key, device_id, outcome) in prepared {
            let outcome = execute_host_profile_apply(
                outcome, |plan| run_host_profile_plan(&exec_broker, plan),
            );
            match outcome {
                HostApplyOutcome::Applied { state, .. } | HostApplyOutcome::AlreadyApplied { state, .. } => {
                    // The renderer bridge only listens on this envelope; a raw
                    // channel emit would never reach its `ipcRenderer.on`.
                    let _ = exec_app.emit_to("main", "arc-power:broker-event", json!({
                        "channel": "device:state-updated",
                        "args": [{
                            "deviceId": device_id, "deviceKey": device_key, "state": state,
                        }],
                    }));
                }
                other => eprintln!("[{log_label}] profile '{profile_id}' did not apply: {other:?}"),
            }
        }
    });
    match spawned {
        Ok(_) => true,
        Err(error) => { eprintln!("[{label}] executor could not start: {error}"); false }
    }
}

/// Tray "Apply active profile" - always applies every active entry.
fn host_tray_apply(broker: &Arc<Broker>, app: &tauri::AppHandle) -> bool {
    host_profile_apply_all(broker, app, "tray-apply", false)
}

/// Boot apply - honours `ocOnBoot`, uses the same exactly-once coordinator as
/// the tray, and owns the whole action or none of it.
fn host_boot_apply(broker: &Arc<Broker>, app: &tauri::AppHandle) -> bool {
    if let Err(error) = broker.wait_channel_ready("apply-settings") {
        eprintln!("[boot-apply] broker apply channel unavailable: {error}");
        return false;
    }
    host_profile_apply_all(broker, app, "boot-apply", true)
}

#[tauri::command]
async fn bridge_invoke(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Broker>>, channel: String, args: Value) -> Reply {
    authorize(&window)?;
    let broker = state.inner().clone();
    let target = window.label().to_owned();
    let role = roles::role(&target).ok_or("Unknown native window role")?;
    let allowed = if role == "main" { broker.permitted.contains(&channel) }
        else { broker.role_channels.get(role).is_some_and(|channels| channels.contains(&channel)) };
    if !allowed { return Err("Channel is not authorized for this window role".into()); }
    if role == "splash" && !broker.mock_mode
        && matches!(channel.as_str(), "splash:update-choice" | "splash:update-now") {
        let app = window.app_handle().clone();
        let broker = broker.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            apply_native_startup_update_choice(&app, &broker, &channel, &args)
        }).await.map_err(|error| error.to_string())?;
    }
    if role == "main" && !broker.mock_mode && channel == "app:clear-cache-restart" {
        let app = window.app_handle().clone();
        let broker = broker.clone();
        return tauri::async_runtime::spawn_blocking(move || clear_cache_and_relaunch(&app, &broker, &args))
            .await.map_err(|error| error.to_string())?;
    }
    if role == "main" && !broker.mock_mode && channel == "app:maintenance-restart" {
        let app = window.app_handle().clone();
        let broker = broker.clone();
        return tauri::async_runtime::spawn_blocking(move || maintenance_and_relaunch(&app, &broker, &args))
            .await.map_err(|error| error.to_string())?;
    }
    let active_invocation = if broker.mock_mode { None } else {
        Some(begin_active_invocation(&broker)?)
    };
    let broker_target = broker_forward_target(role, &target, broker.mock_mode);
    if channel == "boot-apply-outcome" {
        // Native boot apply does not maintain Electron's outcome record; the
        // renderer accepts null, and a missing record is honest.
        return arc_power_tauri::backend::wire::encode_json(&Value::Null);
    }
    if role == "main" && !broker.mock_mode && channel == "fps-poll" {
        // The native RTSS publisher already owns the foreground FPS/frametime
        // rows, including the Graphics-API badge. No broker probe is needed.
        return arc_power_tauri::backend::wire::encode_json(&broker.rtss_osd.foreground_metrics());
    }
    if role == "main" && !broker.mock_mode && channel == "reset-to-defaults" {
        let args_json = arc_power_tauri::backend::wire::decode(&args)?.into_json()?;
        let device_id = args_json.as_array()
            .and_then(|items| items.first())
            .and_then(Value::as_u64)
            .ok_or("reset-to-defaults expects one device id")?;
        let result = native_reset_to_defaults(&broker, device_id);
        return result.and_then(|value| arc_power_tauri::backend::wire::encode_json(&value));
    }
    if role == "main" && !broker.mock_mode && channel == "apply-settings"
        && arc_power_tauri::backend::arc_sleep_system::host_elevated() {
        if let Ok(Some(request)) = arc_power_tauri::backend::services::native_temperature_apply_candidate(&args) {
            // The private broker lease holds the compatibility apply FIFO and
            // supplies the fresh range/refusal-cache snapshot. Only a strict,
            // single-temperature request with explicit physical target proof
            // can enter the native setter path; profile and mixed-control
            // payloads continue through their existing broker route.
            let broker = broker.clone();
            let target = broker_target.clone();
            let args = args.clone();
            let active_invocation = active_invocation.clone();
            return tauri::async_runtime::spawn_blocking(move || {
                let _active_invocation = active_invocation;
                execute_native_temperature_apply(&broker, &target, &args, request)
            }).await.map_err(|error| error.to_string())?;
        }
        // A proven profile apply that carries a temperature routes through
        // the same shared lease (the lease begin owns the apply FIFO); a
        // temperature-free profile keeps the plain native FIFO branch below.
        if let ProfileApplyRoute::Lease(request) = profile_apply_route(&args) {
            let broker = broker.clone();
            let target = broker_target.clone();
            let args = args.clone();
            let active_invocation = active_invocation.clone();
            return tauri::async_runtime::spawn_blocking(move || {
                let _active_invocation = active_invocation;
                execute_native_profile_apply(&broker, &target, &args, request)
            }).await.map_err(|error| error.to_string())?;
        }
    }
    if role == "main" && !broker.mock_mode
        && matches!(channel.as_str(), "update:check" | "update:download" | "update:install") {
        if channel == "update:check" && update_hub::check_intent(&args)? == "startup" {
            if let Some(result) = broker.startup_update.cached_startup_result() {
                return result.and_then(|value| arc_power_tauri::backend::wire::encode_json(&value));
            }
        }
        let app = window.app_handle().clone();
        let target = target.clone();
        let build_kind = broker.build_kind;
        let active_invocation = active_invocation.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _active_invocation = active_invocation;
            update_hub::handle(&app, &target, &channel, &args, build_kind)
        }).await.map_err(|error| error.to_string())?;
    }
    if let Some(reply) = native_window_close_request(&channel, role, broker.mock_mode, &args,
        || { handle_native_main_close(&window.app_handle(), &window, &broker); true },
        || broker.close_failed(window.app_handle().clone()))? {
        return Ok(reply);
    }
    if !broker.mock_mode && channel == "window-minimize" {
        let arc_power_tauri::backend::wire::WireValue::Array(payloads) =
            arc_power_tauri::backend::wire::decode(&args)? else {
                return Err("Expected argument array".into());
            };
        if !payloads.is_empty() { return Err("window-minimize takes no payload".into()); }
        window.minimize().map_err(|error| error.to_string())?;
        broker.host_event_to(&target, "minimize", json!({}));
        return Ok(json!({"t":"undefined"}));
    }
    if !broker.mock_mode && channel == "window-maximize-toggle" {
        let arc_power_tauri::backend::wire::WireValue::Array(payloads) =
            arc_power_tauri::backend::wire::decode(&args)? else {
                return Err("Expected argument array".into());
            };
        if !payloads.is_empty() { return Err("window-maximize-toggle takes no payload".into()); }
        if window.is_maximized().map_err(|error| error.to_string())? {
            window.unmaximize().map_err(|error| error.to_string())?;
        } else {
            window.maximize().map_err(|error| error.to_string())?;
        }
        // The existing Tauri window-event path publishes maximized-changed and
        // bounds-changed to the compatibility proxy after the state transition.
        return Ok(json!({"t":"undefined"}));
    }
    if !broker.mock_mode && channel == "tray-rebuild" {
        return tray::rebuild(&window.app_handle(), &broker.native_store)
            .and_then(|value| arc_power_tauri::backend::wire::encode_json(&value));
    }
    if arc_power_tauri::backend::advanced_overlay::AdvancedOverlayHub::should_handle(&channel, broker.mock_mode) {
        let Some(service) = broker.advanced_overlay.as_ref() else {
            return Err("Advanced overlay service is unavailable".into());
        };
        return service.handle(&channel, &args)
            .unwrap_or_else(|| Err("Advanced overlay service is unavailable".into()));
    }
    if !broker.mock_mode {
        let app = window.app_handle().clone();
        if let Some(result) = broker.telemetry.handle(&channel, &args, &app, &broker.native_store) {
            return result;
        }
    }
    if arc_power_tauri::backend::stability_runtime::StabilityRuntime::should_handle(&channel, broker.mock_mode) {
        let Some(service) = broker.stability.clone() else { return Err("Stability Lab is unavailable".into()); };
        let channel = channel.clone();
        let args = args.clone();
        let active_invocation = active_invocation.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _active_invocation = active_invocation;
            service.handle(&channel, &args)
                .and_then(|value| arc_power_tauri::backend::wire::encode_json(&value))
        }).await.map_err(|error| error.to_string())?;
    }
    if !broker.mock_mode && arc_power_tauri::backend::recording_hub::RecordingHub::handles(&channel) {
        let broker = broker.clone();
        let channel = channel.clone();
        let args = args.clone();
        let active_invocation = active_invocation.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _active_invocation = active_invocation;
            broker.recording.handle(&channel, &args)
                .unwrap_or_else(|| Err("Recording service is unavailable".into()))
        }).await.map_err(|error| error.to_string())?;
    }
    if !broker.mock_mode && arc_power_tauri::backend::fan_resume::FanResumeHub::handles(&channel) {
        let broker = broker.clone();
        let channel = channel.clone();
        let args = args.clone();
        let active_invocation = active_invocation.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _active_invocation = active_invocation;
            broker.fan_resume.handle(&channel, &args)
                .and_then(|value| arc_power_tauri::backend::wire::encode_json(&value))
        }).await.map_err(|error| error.to_string())?;
    }
    if !broker.mock_mode && arc_power_tauri::backend::device_selection::DeviceSelectionHub::handles(&channel) {
        let broker = broker.clone();
        let channel = channel.clone();
        let args = args.clone();
        let active_invocation = active_invocation.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _active_invocation = active_invocation;
            broker.device_selection.handle(&channel, &args)
                .unwrap_or_else(|| Err("Device selection service is unavailable".into()))
        }).await.map_err(|error| error.to_string())?;
    }
    if !broker.mock_mode && matches!(channel.as_str(), "overlay:get-state" | "overlay:toggle" | "overlay-resize")
        && arc_power_tauri::backend::rtss_osd::RtssOsdHub::handles_overlay(&broker.native_store) {
        let result = match channel.as_str() {
            "overlay:get-state" => broker.rtss_osd.state(),
            "overlay:toggle" => broker.rtss_osd.toggle(),
            _ => Value::Null,
        };
        return arc_power_tauri::backend::wire::encode_json(&result);
    }
    if !broker.mock_mode && (matches!(channel.as_str(), "intel-driver-download-start" | "intel-driver-install" | "registry-catalog" | "registry-apply")
        || arc_power_tauri::backend::postprocess_sharpening::is_channel(&channel)) {
        // Long-running native work runs on the blocking pool: driver
        // transfers/installs can hold a worker for the 30-minute budget, and
        // registry helper calls and screen post-processing selection waits
        // are synchronous but bounded. This keeps the UI responsive.
        let broker = broker.clone();
        let channel = channel.clone();
        let args = args.clone();
        let target = broker_target.clone();
        let active_invocation = active_invocation.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _active_invocation = active_invocation;
            let store = broker.native_store.clone();
            if let Some(result) = arc_power_tauri::backend::services::invoke(&channel, &args,
                arc_power_tauri::backend::services::ServiceContext { build_kind: broker.build_kind, mock_mode: broker.mock_mode, store: &store }) {
                return result;
            }
            if channel == "registry-apply" && !broker.mock_mode {
                // Both elevated and unelevated non-mock Tauri use the fixed
                // Rust helper with native registry calls. It never falls back
                // to Electron after helper launch may have begun.
                return registry_apply_helper::launch(&args);
            }
            broker.wait_channel_ready(&channel)?;
            broker.request(json!({"kind":"invoke","target":target,"channel":channel,"args":args}))
        }).await.map_err(|error| error.to_string())?;
    }
    if role == "main" && !broker.mock_mode && channel == "apply-settings"
        && arc_power_tauri::backend::arc_sleep_system::host_elevated()
        && arc_power_tauri::backend::services::native_apply_transaction_candidate(&args) {
        let broker = broker.clone();
        let channel = channel.clone();
        let target = broker_target.clone();
        let args = args.clone();
        let active_invocation = active_invocation.clone();
        return tauri::async_runtime::spawn_blocking(move || {
            let _active_invocation = active_invocation;
            match run_native_apply_fifo(&broker, &channel, &args) {
                NativeApplyRun::Replied(reply) => Ok(reply),
                NativeApplyRun::Declined => {
                    // Native preflight declined before a setter. Release the
                    // logical turn before the compatibility operation acquires
                    // it through the same native FIFO adapter.
                    broker.wait_channel_ready(&channel)?;
                    broker.request(json!({"kind":"invoke","target":target,"channel":channel,"args":args}))
                }
                NativeApplyRun::Failed(error) => Err(error),
            }
        }).await.map_err(|error| error.to_string())?;
    }
    if let Some(result) = arc_power_tauri::backend::services::invoke(&channel, &args,
        arc_power_tauri::backend::services::ServiceContext { build_kind: broker.build_kind, mock_mode: broker.mock_mode, store: &broker.native_store }) {
        if !broker.mock_mode && result.is_ok() {
            if channel == "profiles-settings-save" {
                // The save already landed; the cache push is best effort and
                // must never turn a successful save into a failure.
                push_settings_cache(broker.as_ref());
                // memorySavingMode is now native; the recording hub must update
                // its own meta and idle-shutdown state from the saved settings.
                broker.recording.on_settings_saved();
                let _ = arc_power_tauri::backend::postprocess_sharpening::reload_host_registration(
                    Duration::from_millis(750));
                if let Some(service) = broker.advanced_overlay.as_ref() { service.poll(); }
                // Overlay appearance/geometry saves must reach the live HUD
                // window immediately, not only on the next renderer_ready.
                let patch = arc_power_tauri::backend::wire::decode(&args).ok()
                    .and_then(|value| value.into_json().ok())
                    .and_then(|value| value.as_array().and_then(|items| items.first()).cloned());
                let overlay_changed = patch.as_ref().and_then(Value::as_object).is_some_and(|fields| {
                    fields.keys().any(|key| key.starts_with("overlay"))
                });
                if overlay_changed {
                    let overlay_app = window.app_handle();
                    native_overlay_apply_geometry(&overlay_app, &broker);
                    publish_native_overlay_settings(&overlay_app, &broker, "main");
                    publish_native_overlay_settings(&overlay_app, &broker, NATIVE_OVERLAY_LABEL);
                }
            } else if arc_power_tauri::backend::overlay_layout_channels::handles(&channel) {
                publish_layout_reaction(broker.as_ref(), &channel);
            }
        }
        return result;
    }
    let active_invocation = active_invocation.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _active_invocation = active_invocation;
        let invoke_channel = channel.clone();
        let invoke_target = broker_target.clone();
        let invoke_args = args.clone();
        // Readiness must not be awaited while holding SAVE_QUEUE: compatibility
        // boot can need that queue to finish its atomic settings patch before
        // the broker publishes the ready phase.
        broker.wait_channel_ready(&invoke_channel)?;
        let invoke = || {
            let result = broker.request(json!({"kind":"invoke","target":invoke_target,"channel":invoke_channel,"args":invoke_args}));
            refresh_after_settings_save(&invoke_channel, broker.mock_mode, &result,
                || {
                    let _ = arc_power_tauri::backend::postprocess_sharpening::reload_host_registration(
                        Duration::from_millis(750));
                },
                || {
                    if let Some(service) = broker.advanced_overlay.as_ref() { service.poll(); }
                });
            result
        };
        if !broker.mock_mode && (matches!(channel.as_str(),
            "profiles-settings-save" | "device-set" | "waiver-accept")
            || arc_power_tauri::backend::overlay_layout_channels::handles(&channel)) {
            // Native declines for settings/layout handlers fall back to the
            // compatibility service, whose callbacks mutate the same native
            // settings file. Hold the shared queue across that round trip;
            // nested native-store callbacks deliberately do not acquire it.
            arc_power_tauri::backend::settings_patch::with_save_queue(invoke)
        } else {
            invoke()
        }
    }).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn renderer_ready(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Broker>>) -> Result<(), String> {
    authorize(&window)?;
    let broker = state.inner().clone();
    let target = window.label().to_owned();
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let role = roles::role(&target);
        let native_recording_pill = role == Some("recording-status-pill")
            && broker.recording_status_pill.is_some();
        if role == Some("splash") && broker.mock_mode { broker.wait_channel_ready("splash:update-choice")?; }
        else if wait_for_device_manifest_before_renderer_ready(role, native_recording_pill) {
            broker.wait_channel_ready("list-devices")?;
        }
        if native_recording_pill {
            if let Some(pill) = broker.recording_status_pill.as_ref() { pill.renderer_ready(&target); }
        }
        if roles::role(&target) == Some("recording-toast") {
            flush_pending_recording_toast(&app);
        }
        if roles::role(&target) == Some("overlay") {
            publish_native_overlay_settings(&app, &broker, &target);
        }
        if roles::role(&target) == Some("advanced-overlay") {
            if let Some(service) = broker.advanced_overlay.as_ref() { service.publish_settings(); }
        }
        broker.host_event_to(&target, "did-finish-load", json!({}));
        broker.host_event_to(&target, "ready", json!({}));
        // In a native-only run there is no Electron service to send the
        // `startup-splash-dismiss` host operation. Once the main renderer is
        // ready, hand off from the splash ourselves.
        if role == Some("main") && broker.startup_splash_ready.load(std::sync::atomic::Ordering::SeqCst) {
            let _ = dismiss_native_startup_splash(&app, broker.as_ref());
        }
        if role == Some("splash") && !broker.mock_mode {
            broker.startup_splash_ready.store(true, std::sync::atomic::Ordering::SeqCst);
            let status = broker.startup_update.latest();
            publish_startup_update_status(&app, &target, &status);
            present_startup_splash(&app, &target, &status);
        }
        Ok(())
    })
        .await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn renderer_failed(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Broker>>) -> Result<(), String> {
    authorize(&window)?;
    if window.label() != "main" {
        if roles::role(window.label()) == Some("splash") && !state.mock_mode {
            let transition = state.startup_update.fatal();
            publish_startup_update_transition(&window.app_handle(), state.inner().as_ref(), transition);
        }
        state.host_event_to(window.label(), "render-process-gone", json!({"reason":"Renderer initialization failed"}));
        return window.destroy().map_err(|e| e.to_string());
    }
    state.failed.store(true, std::sync::atomic::Ordering::SeqCst);
    window.show().map_err(|e| e.to_string())
}

#[tauri::command]
async fn renderer_log(window: tauri::WebviewWindow, state: tauri::State<'_, Arc<Broker>>, level: u8, message: String) -> Result<(), String> {
    authorize(&window)?;
    if level > 3 || message.len() > 16384 { return Err("Invalid renderer log".into()); }
    state.host_event_to(window.label(), "console-message", json!({"level":level,"message":message}));
    Ok(())
}

fn create_auxiliary_window(app: &tauri::AppHandle, target: &str, role: &str,
    x: f64, y: f64, width: f64, height: f64, theme: Option<&str>) -> Result<tauri::WebviewWindow, String> {
    if role == "main" || roles::role(target) != Some(role) { return Err("Invalid auxiliary role label".into()); }
    if app.get_webview_window(target).is_some() { return Err("Auxiliary target already exists".into()); }
    let document = roles::document(role).ok_or("Unknown auxiliary role")?;
    let (red, green, blue) = roles::theme_background(theme.unwrap_or("dark")).ok_or("Invalid auxiliary theme")?;
    let mut url = url::Url::parse(&format!("tauri://localhost/{document}")).map_err(|e| e.to_string())?;
    if let Some(theme) = theme {
        url.query_pairs_mut().append_pair("theme", theme);
    }
    let navigation_app = app.clone();
    let navigation_target = target.to_owned();
    let passive = roles::passive(role);
    let splash = role == "splash";
    let mut builder = tauri::WebviewWindowBuilder::new(app, target, tauri::WebviewUrl::CustomProtocol(url))
        .title("Arc Power").position(x, y).inner_size(if splash { 500.0 } else { width }, if splash { 500.0 } else { height })
        .decorations(false).visible(false).resizable(false).minimizable(false).maximizable(false)
        .transparent(passive).background_color(if passive { tauri::webview::Color(0, 0, 0, 0) }
            else if splash { tauri::webview::Color(9, 11, 18, 255) } else { tauri::webview::Color(red, green, blue, 255) })
        .always_on_top(!splash).skip_taskbar(true).shadow(role == "advanced-overlay").focused(false).focusable(!passive)
        .on_navigation(move |url| {
            let allowed = roles::trusted_url(&navigation_target, url);
            if allowed {
                if let Some(broker) = navigation_app.try_state::<Arc<Broker>>() { broker.host_event_to(&navigation_target, "will-navigate", json!({})); }
            }
            allowed
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if let Some(broker) = window.app_handle().try_state::<Arc<Broker>>() { broker.host_event_to(window.label(), "did-start-loading", json!({})); }
            }
        });
    if let Some(port) = lifecycle::ui_test_port(&std::env::args().skip(1).collect::<Vec<_>>())? {
        builder = builder.devtools(true).additional_browser_args(&format!("--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"));
    }
    if let Ok(app_data) = std::env::var("APPDATA") { builder = builder.data_directory(PathBuf::from(app_data).join("ArcPowerTauriCache")); }
    if splash { builder = builder.center(); }
    let window = builder.build().map_err(|e| e.to_string())?;
    if passive {
        let configured = window.set_ignore_cursor_events(true).map_err(|error| error.to_string());
        cleanup_auxiliary_after_setup_failure(configured, || { let _ = window.destroy(); })?;
    }
    #[cfg(windows)]
    {
        let configured = install_process_failure_handler(&window).map_err(|error| error.to_string());
        cleanup_auxiliary_after_setup_failure(configured, || { let _ = window.destroy(); })?;
    }
    Ok(window)
}

fn cleanup_auxiliary_after_setup_failure<T>(result: Result<T, String>, cleanup: impl FnOnce()) -> Result<T, String> {
    if result.is_err() { cleanup(); }
    result
}

fn create_auxiliary(app: &tauri::AppHandle, args: &Value) -> Result<(), String> {
    let target = args["target"].as_str().ok_or("Missing auxiliary target")?;
    let role = args["role"].as_str().ok_or("Missing auxiliary role")?;
    if role == "main" || roles::role(target) != Some(role) { return Err("Invalid auxiliary role label".into()); }
    if app.get_webview_window(target).is_some() { return Err("Auxiliary target already exists".into()); }
    let (x, y, width, height) = roles::bounds(role, &args["bounds"])?;
    create_auxiliary_window(app, target, role, x, y, width, height, args["theme"].as_str())?;
    Ok(())
}

fn show_inactive(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)] {
        let handle = window.hwnd().map_err(|e| e.to_string())?;
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(handle.0.cast(), windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE); }
        Ok(())
    }
    #[cfg(not(windows))] { window.show().map_err(|e| e.to_string()) }
}

#[tauri::command]
fn window_drag(window: tauri::WebviewWindow, maximize: bool) -> Result<(), String> {
    authorize(&window)?;
    if !matches!(roles::role(window.label()), Some("main" | "advanced-overlay" | "splash")) { return Err("This role cannot drag a window".into()); }
    if maximize && window.label() != "main" { return Err("Only the main window can maximize".into()); }
    if maximize { if window.is_maximized().map_err(|e| e.to_string())? { window.unmaximize() } else { window.maximize() } }
    else { window.start_dragging() }.map_err(|e| e.to_string())
}

fn publish_startup_update_transition(
    app: &tauri::AppHandle,
    broker: &Broker,
    transition: startup_update::Transition,
) {
    if let Some(status) = transition.status {
        for (label, _window) in app.webview_windows() {
            if roles::role(&label) == Some("splash") && !broker.mock_mode {
                publish_startup_update_status(app, &label, &status);
                if broker.startup_splash_ready.load(std::sync::atomic::Ordering::SeqCst) {
                    present_startup_splash(app, &label, &status);
                }
            }
        }
    }
    if let Some(action) = transition.decision {
        broker.host_event_to("main", "startup-update-decision", json!({"action":action}));
    }
}

fn publish_startup_update_status(app: &tauri::AppHandle, target: &str, status: &Value) {
    let args = arc_power_tauri::backend::wire::encode_json(&json!([status]))
        .unwrap_or_else(|_| json!({"t":"array","v":[]}));
    let _ = app.emit_to(target, "arc-power:broker-event", json!({"channel":"splash:update-status","args":args}));
}

fn present_startup_splash(app: &tauri::AppHandle, target: &str, status: &Value) {
    let Some(window) = app.get_webview_window(target) else { return; };
    if status.get("state").and_then(Value::as_str) == Some("available") {
        let _ = window.set_skip_taskbar(false);
        let _ = window.show();
        let _ = window.set_focus();
    } else if !window.is_visible().unwrap_or(false) {
        let _ = show_inactive(&window);
    }
}

fn dismiss_native_startup_splash(app: &tauri::AppHandle, broker: &Broker) -> Result<(), String> {
    let Some(window) = app.get_webview_window("splash-1000000") else { return Ok(()); };
    let (allowed, transition) = broker.startup_update.close();
    publish_startup_update_transition(app, broker, transition);
    if !allowed { return Err("Startup update prompt is still active".into()); }
    window.destroy().map_err(|error| error.to_string())
}

fn should_start_native_startup_update(broker: &Broker, launch_args: &[String]) -> bool {
    !broker.mock_mode
        && matches!(broker.build_kind, arc_power_tauri::backend::native_system::BuildKind::Installed
            | arc_power_tauri::backend::native_system::BuildKind::Portable)
        && std::env::var("ARC_POWER_PROFILE_BOOT").as_deref() != Ok("1")
        && !launch_args.iter().any(|arg| matches!(arg.as_str(), "--profile-boot" | "--clear-cache")
            || arg.starts_with("--arc-power-maintenance="))
}

fn startup_check_result(app: &tauri::AppHandle, kind: arc_power_tauri::backend::native_system::BuildKind) -> Result<Value, String> {
    let args = arc_power_tauri::backend::wire::encode_json(&json!([{"intent":"startup"}]))?;
    let encoded = update_hub::handle(app, "main", "update:check", &args, kind)?;
    arc_power_tauri::backend::wire::decode(&encoded)?.into_json()
}

fn start_native_startup_update(app: &tauri::AppHandle, broker: &Arc<Broker>) {
    let Some(initial) = broker.startup_update.start() else { return; };
    publish_startup_update_transition(app, broker, initial);
    let worker_app = app.clone();
    let worker_broker = broker.clone();
    let kind = broker.build_kind;
    let spawned = std::thread::Builder::new().name("arc-startup-update-check".into()).spawn(move || {
        let app = worker_app;
        let broker = worker_broker;
        let (sender, receiver) = mpsc::channel();
        let check_app = app.clone();
        let check = std::thread::Builder::new().name("arc-update-check-request".into()).spawn(move || {
            let _ = sender.send(startup_check_result(&check_app, kind));
        });
        if let Err(error) = check {
            let transition = broker.startup_update.finish_startup(Err(format!("Could not start native update check: {error}")));
            publish_startup_update_transition(&app, &broker, transition);
            return;
        }
        let transition = match receiver.recv_timeout(startup_update::STARTUP_CHECK_TIMEOUT) {
            Ok(result) => broker.startup_update.finish_startup(result),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                update_hub::settle_startup_check_timeout();
                broker.startup_update.timeout()
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => broker.startup_update.finish_startup(Err("Native update check stopped".into())),
        };
        publish_startup_update_transition(&app, &broker, transition);
    });
    if let Err(error) = spawned {
        let transition = broker.startup_update.finish_startup(Err(format!("Could not start native update check: {error}")));
        publish_startup_update_transition(app, broker, transition);
    }
}

fn apply_native_startup_update_choice(app: &tauri::AppHandle, broker: &Arc<Broker>, channel: &str, args: &Value) -> Reply {
    let decoded = arc_power_tauri::backend::wire::decode(args)?;
    if channel == "splash:update-choice" {
        let arc_power_tauri::backend::wire::WireValue::Array(values) = decoded else { return Err("Expected argument array".into()); };
        if values.len() != 1 || wire_text(&values[0]) != Some("skip") {
            return Err("startup update choice must be skip".into());
        }
        let transition = broker.startup_update.choose_skip()?;
        publish_startup_update_transition(app, broker, transition);
        // Electron used to send the dismiss operation after this choice.
        let _ = dismiss_native_startup_splash(app, broker);
        return Ok(json!({"ok":true,"action":"continue"}));
    }
    let arc_power_tauri::backend::wire::WireValue::Array(values) = decoded else { return Err("Expected argument array".into()); };
    if !values.is_empty() { return Err("splash:update-now does not accept a payload".into()); }
    let (asset_url, _known_size, transition) = broker.startup_update.begin_update()?;
    publish_startup_update_transition(app, broker, transition);
    let download_args = arc_power_tauri::backend::wire::encode_json(&json!([asset_url]))?;
    let result = (|| {
        let receipt = update_hub::handle(app, "main", "update:download", &download_args, broker.build_kind)?;
        let receipt = arc_power_tauri::backend::wire::decode(&receipt)?.into_json()?;
        let token = receipt.get("token").and_then(Value::as_str).ok_or("Native update download omitted its receipt")?;
        if !broker.startup_update.may_start_install() { return Err("Startup update was aborted".into()); }
        publish_startup_update_transition(app, broker, broker.startup_update.installing());
        let install_args = arc_power_tauri::backend::wire::encode_json(&json!([token]))?;
        update_hub::handle(app, "main", "update:install", &install_args, broker.build_kind)?;
        let handoff = broker.startup_update.start_handoff();
        // The native updater owns process exit. The latest status is already
        // published before install starts, so no event is needed after exit.
        drop(handoff);
        Ok(json!({"ok":true}))
    })();
    match result {
        Ok(value) => Ok(value),
        Err(error) => {
            let transition = broker.startup_update.update_failed();
            publish_startup_update_transition(app, broker, transition);
            Err(error)
        }
    }
}

fn apply_host_operation(app: &tauri::AppHandle, frame: &Value) -> Result<(), String> {
    let operation = frame["operation"].as_str().ok_or("Invalid host operation")?;
    if operation == "startup-splash-dismiss" {
        if !frame["args"].as_object().is_some_and(|args| args.is_empty()) { return Err("Invalid startup splash dismissal".into()); }
        let broker = app.state::<Arc<Broker>>();
        if broker.mock_mode { return Err("Native startup splash is unavailable in mock mode".into()); }
        dismiss_native_startup_splash(app, broker.inner())?;
        return Ok(());
    }
    if operation == "maintenance-drained" {
        if !frame["args"].as_object().is_some_and(|args| args.is_empty()) {
            return Err("Invalid maintenance drain notification".into());
        }
        app.state::<Arc<Broker>>().maintenance_boot_ready.store(
            true,
            std::sync::atomic::Ordering::SeqCst,
        );
        return Ok(());
    }
    if operation == "host-exit" {
        request_controlled_host_exit(app, app.state::<Arc<Broker>>().inner().as_ref());
        return Ok(());
    }
    if operation == "host-relaunch" {
        let args = frame["args"]["args"].as_array().ok_or("Missing relaunch arguments")?.iter()
            .map(|arg| arg.as_str().map(str::to_owned).ok_or("Invalid relaunch argument"))
            .collect::<Result<Vec<_>, _>>()?;
        lifecycle::spawn_relaunch_waiter(args)?;
        app.state::<Arc<Broker>>().allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
        exit_log_write("host-relaunch", 0);
        app.exit(0);
        return Ok(());
    }
    if operation == "recording-pill-settings" {
        let args = frame["args"].as_object().ok_or("Invalid recording pill settings")?;
        if args.len() != 1 || !args.contains_key("enabled") {
            return Err("Invalid recording pill settings".into());
        }
        let enabled = args["enabled"].as_bool().ok_or("Invalid recording pill preference")?;
        let broker = app.state::<Arc<Broker>>();
        let Some(pill) = broker.recording_status_pill.as_ref() else {
            return Err("Native recording pill is unavailable".into());
        };
        pill.set_enabled(enabled);
        return Ok(());
    }
    if operation != "window" { return Err("Unknown native operation".into()); }
    let args = &frame["args"];
    if args["action"] == "create" { return create_auxiliary(app, args); }
    let target = args["target"].as_str().unwrap_or("main");
    let role = roles::role(target).ok_or("Invalid native operation target")?;
    let Some(window) = app.get_webview_window(target) else { return Ok(()); };
    let result = match args["action"].as_str() {
        Some("show") => window.show(), Some("hide") => window.hide(), Some("focus") => window.set_focus(),
        Some("showInactive") => { show_inactive(&window)?; Ok(()) },
        Some("setAlwaysOnTop") => window.set_always_on_top(args["value"].as_bool().ok_or("Invalid always-on-top value")?),
        Some("setIgnoreMouseEvents") => window.set_ignore_cursor_events(args["value"].as_bool().ok_or("Invalid cursor value")?),
        Some("setSkipTaskbar") => window.set_skip_taskbar(args["value"].as_bool().ok_or("Invalid taskbar value")?),
        Some("setBackgroundColor") => {
            let value = args["color"].as_str().ok_or("Invalid background color")?;
            let hex = value.strip_prefix('#').ok_or("Invalid background color")?;
            if !matches!(hex.len(), 6 | 8) || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Err("Invalid background color".into()); }
            let byte = |i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap();
            window.set_background_color(Some(tauri::webview::Color(byte(0), byte(2), byte(4), if hex.len() == 8 { byte(6) } else { 255 })))
        },
        Some("minimize") => window.minimize(), Some("maximize") => window.maximize(),
        Some("unmaximize") => window.unmaximize(), Some("restore") => window.unminimize(),
        Some("close") | Some("destroy") => window.destroy(),
        Some("setTitle") => window.set_title(args["title"].as_str().ok_or("Invalid title")?),
        Some("setBounds") => {
            let bounds = args.get("bounds").unwrap_or(args);
            if let (Some(width), Some(height)) = (bounds["width"].as_f64(), bounds["height"].as_f64()) {
                let minimum = if role == "main" { (980.0, 640.0) } else { (1.0, 1.0) };
                if !(minimum.0..=16384.0).contains(&width) || !(minimum.1..=16384.0).contains(&height) { return Err("Invalid window size".into()); }
                window.set_size(tauri::LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
            }
            if let (Some(x), Some(y)) = (bounds["x"].as_f64(), bounds["y"].as_f64()) {
                if !x.is_finite() || !y.is_finite() || x.abs() > 100000.0 || y.abs() > 100000.0 { return Err("Invalid window position".into()); }
                window.set_position(tauri::LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        Some("setProgress") => {
            let progress = args["progress"].as_f64().unwrap_or(-1.0);
            let status = if progress < 0.0 { tauri::window::ProgressBarStatus::None } else { tauri::window::ProgressBarStatus::Normal };
            window.set_progress_bar(tauri::window::ProgressBarState { status: Some(status), progress: Some((progress.clamp(0.0, 1.0) * 100.0) as u64) })
        }
        _ => return Err("Unknown window operation".into()),
    };
    result.map_err(|e| e.to_string())?;
    if args["action"] == "showInactive" { app.state::<Arc<Broker>>().host_event_to(target, "show", json!({})); }
    if let Some(action @ ("show" | "hide" | "focus" | "minimize" | "restore")) = args["action"].as_str() {
        app.state::<Arc<Broker>>().host_event_to(target, action, json!({}));
    }
    Ok(())
}

#[cfg(windows)]
fn install_process_failure_handler(window: &tauri::WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle().clone();
    let target = window.label().to_owned();
    window.with_webview(move |platform| unsafe {
        let result = (|| {
            let view = platform.controller().CoreWebView2()?;
            let mut token = 0i64;
            let failure_app = app.clone();
            let failure_target = target.clone();
            view.add_ProcessFailed(&webview2_com::ProcessFailedEventHandler::create(Box::new(move |_, _| {
                if let Some(broker) = failure_app.try_state::<Arc<Broker>>() {
                    broker.host_event_to(&failure_target, "render-process-gone", json!({"reason":"WebView2 process failed"}));
                    if failure_target != "main" {
                        if roles::role(&failure_target) == Some("splash") && !broker.mock_mode {
                            let transition = broker.startup_update.fatal();
                            publish_startup_update_transition(&failure_app, broker.inner().as_ref(), transition);
                        }
                        if let Some(window) = failure_app.get_webview_window(&failure_target) { let _ = window.destroy(); }
                        return Ok(());
                    }
                    eprintln!("WebView2 process failed; stopping Arc Power through the service cleanup path. No operations will be replayed.");
                    // The renderer can no longer reliably display an error.
                    // Stop through the existing drain/fan/recording cleanup,
                    // rather than automatically recreating a GPU-writing UI.
                    let broker = broker.inner().clone();
                    std::thread::spawn(move || { let _ = broker.send(json!({"kind":"shutdown"})); });
                }
                Ok(())
            })), &mut token)?;
            Ok::<(), webview2_com::Error>(())
        })();
        if let Err(error) = result {
            eprintln!("Cannot install WebView2 process failure handler; stopping through service cleanup: {error}");
            if let Some(broker) = app.try_state::<Arc<Broker>>() {
                if target != "main" {
                    broker.host_event_to(&target, "render-process-gone", json!({"reason":"WebView2 failure handler unavailable"}));
                    if roles::role(&target) == Some("splash") && !broker.mock_mode {
                        let transition = broker.startup_update.fatal();
                        publish_startup_update_transition(&app, broker.inner().as_ref(), transition);
                    }
                    if let Some(window) = app.get_webview_window(&target) { let _ = window.destroy(); }
                    return;
                }
                let broker = broker.inner().clone();
                std::thread::spawn(move || { let _ = broker.send(json!({"kind":"shutdown"})); });
            }
        }
    })
}

fn main() {
    let launch_args: Vec<String> = std::env::args().skip(1).collect();
    match runtime::run_portable_update_if_requested(&launch_args) {
        Ok(Some(code)) => std::process::exit(code),
        Err(error) => {
            runtime::show_portable_update_error(&error);
            eprintln!("Arc Power portable update rejected: {error}");
            std::process::exit(1);
        },
        Ok(None) => {}
    }
    match registry_apply_helper::run_if_requested(&launch_args) {
        Ok(true) => return,
        Err(error) => { eprintln!("Arc Power registry helper rejected startup: {error}"); std::process::exit(1); },
        Ok(false) => {}
    }
    match runtime::run_installer_if_requested(&launch_args) {
        Ok(Some(code)) => std::process::exit(code),
        Err(error) => { eprintln!("Arc Power installer startup rejected: {error}"); std::process::exit(1); },
        Ok(None) => {}
    }
    match lifecycle::run_relaunch_waiter(&launch_args) {
        Ok(true) => return,
        Err(error) => { eprintln!("{error}"); std::process::exit(1); },
        _ => {}
    }
    if lifecycle::is_boot_apply(&launch_args) {
        match runtime::run_boot_apply() {
            Ok(code) => std::process::exit(code),
            Err(error) => { eprintln!("{error}"); std::process::exit(1); }
        }
    }
    if let Err(error) = lifecycle::validate_launch_args(&launch_args)
        .and_then(|_| lifecycle::prepare_mock_environment(&launch_args))
        .and_then(|_| lifecycle::clear_webview_cache_if_requested(&launch_args)) {
        eprintln!("Arc Power startup rejected: {error}"); std::process::exit(1);
    }
    let setup_launch_args = launch_args.clone();
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bridge_invoke, renderer_ready, renderer_failed, renderer_log, window_drag])
        .register_asynchronous_uri_scheme_protocol("arc-power-media", |context, request, responder| {
            let authorized = context.webview_label() == "main"
                && context.app_handle().get_webview_window("main").is_some_and(|window| authorize(&window).is_ok());
            let Some(state) = context.app_handle().try_state::<Arc<Broker>>().filter(|_| authorized) else {
                responder.respond(tauri::http::Response::builder().status(404).body(Vec::<u8>::new()).unwrap());
                return;
            };
            let broker = state.inner().clone();
            let mock = broker.mock_mode;
            std::thread::spawn(move || {
                let response = (|| -> Result<tauri::http::Response<Vec<u8>>, String> {
                    let url = protocol::media_source_url(&request.uri().to_string())?;
                    let method = request.method().as_str();
                    if !matches!(method, "GET" | "HEAD") { return Err("Unsupported media method".into()); }
                    let range = request.headers().get("range").and_then(|value| value.to_str().ok());
                    if mock {
                        let mut headers = json!({});
                        if let Some(range) = range { headers["range"] = json!(range); }
                        broker.wait_channel_ready("recording-clip-url")?;
                        let value = broker.request(json!({"kind":"media","target":"main","request":{"url":url,"method":method,"headers":headers}}))?;
                        let status = value["status"].as_u64().filter(|status| matches!(status, 200 | 206 | 404 | 405 | 413 | 416 | 500)).ok_or("Invalid media status")? as u16;
                        let bytes = base64::engine::general_purpose::STANDARD.decode(value["bodyBase64"].as_str().unwrap_or("")).map_err(|error| error.to_string())?;
                        if bytes.len() > protocol::MAX_MEDIA_BODY { return Err("Media response exceeds bounded range limit".into()); }
                        let mut response = tauri::http::Response::builder().status(status);
                        if let Some(headers) = value["headers"].as_object() {
                            for name in ["content-type", "content-length", "content-range", "accept-ranges", "cache-control"] {
                                if let Some(value) = headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).and_then(|(_, value)| value.as_str()) {
                                    response = response.header(name, value);
                                }
                            }
                        }
                        response.body(bytes).map_err(|error| error.to_string())
                    } else {
                        let media = arc_power_tauri::backend::recording_playback::serve(
                            &broker.native_store, &url, method, range, protocol::MAX_MEDIA_BODY)?;
                        let mut response = tauri::http::Response::builder().status(media.status);
                        for (name, value) in media.headers { response = response.header(name, value); }
                        response.body(media.body).map_err(|error| error.to_string())
                    }
                })().unwrap_or_else(|error| tauri::http::Response::builder().status(404).body(error.into_bytes()).unwrap());
                responder.respond(response);
            });
        })
        .setup(move |app| {
            let navigation_app = app.handle().clone();
            let mut builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("renderer/index.html".into()))
                .title("Arc Power").inner_size(1280.0, 820.0).min_inner_size(980.0, 640.0)
                .decorations(false).visible(false).background_color(tauri::webview::Color(13, 17, 23, 255))
                .on_navigation(move |url| {
                    let allowed = protocol::trusted_main_url(url);
                    if allowed {
                        if let Some(broker) = navigation_app.try_state::<Arc<Broker>>() {
                            broker.host_event("will-navigate", json!({}));
                        }
                    }
                    allowed
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_page_load(|window, payload| {
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                        if let Some(broker) = window.app_handle().try_state::<Arc<Broker>>() { broker.host_event("did-start-loading", json!({})); }
                    }
                });
            if let Some(port) = lifecycle::ui_test_port(&std::env::args().skip(1).collect::<Vec<_>>()).map_err(std::io::Error::other)? {
                builder = builder.devtools(true).additional_browser_args(&format!("--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"));
            }
            if let Ok(app_data) = std::env::var("APPDATA") {
                builder = builder.data_directory(PathBuf::from(app_data).join("ArcPowerTauriCache"));
            }
            let window = builder.build()?;
            let broker = Broker::start(app.handle().clone()).map_err(std::io::Error::other)?;
            if should_start_native_startup_update(&broker, &setup_launch_args) {
                match create_auxiliary_window(app.handle(), "splash-1000000", "splash", 0.0, 0.0, 500.0, 500.0, None) {
                    Ok(_) => start_native_startup_update(app.handle(), &broker),
                    Err(error) => {
                        eprintln!("Native startup splash unavailable: {error}");
                        let transition = broker.startup_update.fatal();
                        publish_startup_update_transition(app.handle(), &broker, transition);
                    }
                }
            }
            if !broker.mock_mode {
                match tray::create(app.handle(), &broker.native_store, broker.host_events.clone()) {
                    Ok(()) => broker.tray_available.store(true, std::sync::atomic::Ordering::SeqCst),
                    Err(error) => eprintln!("Native tray unavailable: {error}"),
                }
            }
            let _ = broker;
            #[cfg(windows)]
            install_process_failure_handler(&window)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            let Some(state) = window.app_handle().try_state::<Arc<Broker>>() else { return; };
            let target = window.label();
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if target == "main" && !state.mock_mode {
                        if !state.allow_exit.load(std::sync::atomic::Ordering::SeqCst) {
                            api.prevent_close();
                            if let Some(main_window) = window.app_handle().get_webview_window("main") {
                                handle_native_main_close(window.app_handle(), &main_window, state.inner());
                            }
                        }
                    } else {
                        api.prevent_close();
                        if target == "main" && state.failed.load(std::sync::atomic::Ordering::SeqCst) {
                            state.inner().close_failed(window.app_handle().clone());
                        } else if roles::role(target) == Some("splash") && !state.mock_mode {
                            let (allowed, transition) = state.startup_update.close();
                            publish_startup_update_transition(window.app_handle(), state.inner().as_ref(), transition);
                            if allowed { let _ = window.destroy(); }
                        } else {
                            state.host_event_to(target, "close", json!({}));
                        }
                    }
                }
                tauri::WindowEvent::Focused(focused) => {
                    if let Ok(minimized) = window.is_minimized() { state.host_event_to(target, if minimized { "minimize" } else { "restore" }, json!({})); }
                    state.host_event_to(target, if *focused { "focus" } else { "blur" }, json!({}));
                }
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    if let Ok(minimized) = window.is_minimized() { state.host_event_to(target, if minimized { "minimize" } else { "restore" }, json!({})); }
                    let scale = window.scale_factor().unwrap_or(1.0);
                    let position = window.outer_position().ok().map(|p| p.to_logical::<f64>(scale));
                    let size = window.inner_size().ok().map(|s| s.to_logical::<f64>(scale));
                    state.host_event_to(target, "maximized-changed", json!({"maximized":window.is_maximized().unwrap_or(false)}));
                    if let (Some(position), Some(size)) = (position, size) {
                        state.host_event_to(target, "bounds-changed", json!({"bounds":{"x":position.x,"y":position.y,"width":size.width,"height":size.height}}));
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if roles::role(target) == Some("recording-status-pill") {
                        if let Some(pill) = state.recording_status_pill.as_ref() { pill.window_destroyed(target); }
                    }
                    state.host_event_to(target, "destroyed", json!({}));
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!()).expect("Arc Power native host initialization failed");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if let Some(broker) = app.try_state::<Arc<Broker>>() {
                if !broker.allow_exit.load(std::sync::atomic::Ordering::SeqCst) {
                    api.prevent_exit();
                    if broker.failed.load(std::sync::atomic::Ordering::SeqCst) { broker.inner().close_failed(app.clone()); }
                }
            }
        }
        if let tauri::RunEvent::Exit = event {
            if let Some(broker) = app.try_state::<Arc<Broker>>() { broker.shutdown(); }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authorized_events() -> HashMap<String, HashSet<String>> {
        HashMap::from([
            ("advanced-overlay".to_owned(),
                ["advanced-overlay:settings", "device:state-updated"].into_iter().map(str::to_owned).collect()),
            ("overlay".to_owned(), ["overlay:settings"].into_iter().map(str::to_owned).collect()),
            ("main".to_owned(), ["advanced-overlay:settings", "overlay:settings"].into_iter().map(str::to_owned).collect()),
        ])
    }

    #[test]
    fn native_advanced_overlay_forwards_unmigrated_channels_through_main() {
        assert_eq!(broker_forward_target("advanced-overlay", "advanced-overlay-1000000000000", false), "main");
        assert_eq!(broker_forward_target("advanced-overlay", "advanced-overlay-1000000000000", true),
            "advanced-overlay-1000000000000");
        assert_eq!(broker_forward_target("overlay", "overlay-1000000", false), "overlay-1000000");
        assert_eq!(broker_forward_target("main", "main", false), "main");
    }

    #[test]
    fn native_window_close_preserves_broker_policy_and_mock_routing() {
        use arc_power_tauri::backend::wire;
        use std::cell::Cell;
        let no_args = wire::encode_json(&json!([])).unwrap();
        let extra_arg = wire::encode_json(&json!([true])).unwrap();
        let closes = Cell::new(0);
        let failures = Cell::new(0);
        let reply = native_window_close_request("window-close", "main", false, &no_args,
            || { closes.set(closes.get() + 1); true }, || failures.set(failures.get() + 1)).unwrap();
        assert_eq!(reply, Some(json!({"t":"undefined"})));
        assert_eq!(closes.get(), 1);

        assert_eq!(native_window_close_request("window-close", "main", true, &no_args,
            || { closes.set(closes.get() + 1); true }, || failures.set(failures.get() + 1)).unwrap(), None);
        assert_eq!(native_window_close_request("window-close", "overlay", false, &no_args,
            || { closes.set(closes.get() + 1); true }, || failures.set(failures.get() + 1)).unwrap(), None);
        assert_eq!(closes.get(), 1, "mock and non-main requests must stay brokered");
        assert!(native_window_close_request("window-close", "main", false, &extra_arg,
            || { closes.set(closes.get() + 1); true }, || failures.set(failures.get() + 1)).is_err());
        assert_eq!(closes.get(), 1, "invalid payload must not emit a close event");
        assert_eq!(failures.get(), 0, "invalid args and delegated requests must not request shutdown");
    }

    #[test]
    fn native_window_close_queue_failure_requests_bounded_shutdown() {
        use arc_power_tauri::backend::wire;
        use std::cell::Cell;
        let no_args = wire::encode_json(&json!([])).unwrap();
        let shutdowns = Cell::new(0);
        let error = native_window_close_request("window-close", "main", false, &no_args,
            || false, || shutdowns.set(shutdowns.get() + 1)).unwrap_err();
        assert!(error.contains("close event could not be queued"));
        assert_eq!(shutdowns.get(), 1, "a dropped close event must enter the close-failed cleanup path");
    }

    #[test]
    fn advanced_overlay_event_fanout_is_role_and_channel_authorized() {
        let role_events = authorized_events();
        let labels = vec![
            "main".to_owned(),
            "advanced-overlay-1000000".to_owned(),
            "advanced-overlay-1000001".to_owned(),
            "overlay-1000000".to_owned(),
            "advanced-overlay-bad".to_owned(),
        ];
        assert_eq!(advanced_overlay_event_targets("advanced-overlay:settings", false, &role_events, labels.iter()),
            vec!["advanced-overlay-1000000", "advanced-overlay-1000001"]);
        assert_eq!(advanced_overlay_event_targets("device:state-updated", false, &role_events, labels.iter()),
            vec!["advanced-overlay-1000000", "advanced-overlay-1000001"]);
        assert!(advanced_overlay_event_targets("overlay:settings", false, &role_events, labels.iter()).is_empty());
        assert!(advanced_overlay_event_targets("not-authorized", false, &role_events, labels.iter()).is_empty());
        assert!(advanced_overlay_event_targets("advanced-overlay:settings", true, &role_events, labels.iter()).is_empty());
    }

    #[test]
    fn stability_status_event_is_main_only_and_wire_encoded() {
        use arc_power_tauri::backend::wire;
        let payload = stability_status_event(&json!({"runId":"run-1","state":"running"}));
        assert_eq!(stability_status_target(), "main");
        assert_eq!(payload["channel"], json!("stability:status"));
        let args = wire::decode(&payload["args"]).unwrap().into_json().unwrap();
        assert_eq!(args[0]["runId"], json!("run-1"));
        assert_eq!(args[0]["state"], json!("running"));

        let contract: Value = serde_json::from_str(CONTRACT).unwrap();
        let roles = contract["roleEvents"].as_object().unwrap();
        assert!(roles["main"].as_array().unwrap().contains(&json!("stability:status")));
        for role in ["overlay", "advanced-overlay", "splash", "recording-toast", "recording-status-pill"] {
            assert!(!roles[role].as_array().unwrap().contains(&json!("stability:status")),
                "stability:status must not reach the {role} role");
        }
    }

    #[test]
    fn stability_runtime_channels_are_native_but_only_outside_mock_mode() {
        use arc_power_tauri::backend::stability_runtime::StabilityRuntime;
        for channel in ["stability-run-start", "stability-run-status", "stability-run-cancel"] {
            assert!(StabilityRuntime::handles(channel));
            assert!(StabilityRuntime::should_handle(channel, false));
            assert!(!StabilityRuntime::should_handle(channel, true), "{channel} must delegate in mock mode");
        }
        assert!(!StabilityRuntime::should_handle("stability-reports-list", false));
    }

    #[test]
    fn settings_cache_payload_carries_the_whole_snapshot() {
        assert_eq!(settings_cache_payload(Some(json!({"closeToTray": true}))),
            Some(json!({"settings": {"closeToTray": true}})));
        // An unpublished cache publishes nothing rather than an empty snapshot.
        assert_eq!(settings_cache_payload(None), None);
    }

    #[test]
    fn recording_snapshot_reconciliation_is_cadence_bounded() {
        let start = Instant::now();
        assert!(recording_snapshot_due(None, start));
        assert!(!recording_snapshot_due(Some(start), start + Duration::from_millis(249)));
        assert!(recording_snapshot_due(Some(start), start + Duration::from_millis(250)));
    }

    #[test]
    fn recording_state_events_prefer_latest_snapshot_and_fall_back_on_contention() {
        let event = json!({"running": false});
        let latest = json!({"running": true});
        assert_eq!(prefer_latest_recording_state(Some(latest.clone()), event.clone()), latest);
        assert_eq!(prefer_latest_recording_state(None, event.clone()), event);
    }

    #[test]
    fn recording_pill_startup_fails_closed_on_settings_error_and_accepts_later_valid_value() {
        assert!(!recording_pill_enabled(Err("settings parse failed".into())));
        assert!(!recording_pill_enabled(Ok(json!({"overlayRecordingPill": false}))));
        assert!(!recording_pill_enabled(Ok(json!({"overlayRecordingPill": "invalid"}))));
        assert!(recording_pill_enabled(Ok(json!({"overlayRecordingPill": true}))));
        assert!(recording_pill_enabled_value(&json!({"overlayRecordingPill": true})));
    }

    #[test]
    fn native_pill_readiness_does_not_wait_on_unrelated_device_manifest() {
        assert!(!wait_for_device_manifest_before_renderer_ready(Some("recording-status-pill"), true));
        assert!(wait_for_device_manifest_before_renderer_ready(Some("recording-status-pill"), false));
        assert!(wait_for_device_manifest_before_renderer_ready(Some("advanced-overlay"), true));
        assert!(wait_for_device_manifest_before_renderer_ready(Some("main"), false));
        assert!(!wait_for_device_manifest_before_renderer_ready(Some("splash"), false));
    }

    #[test]
    fn successful_settings_save_refreshes_registration_then_polls_overlay() {
        let order = std::sync::Mutex::new(Vec::new());
        let result: Result<Value, String> = Ok(json!({"saved": true}));
        refresh_after_settings_save("profiles-settings-save", false, &result,
            || order.lock().unwrap().push("reload"),
            || order.lock().unwrap().push("poll"));
        assert_eq!(*order.lock().unwrap(), vec!["reload", "poll"]);
        assert_eq!(result, Ok(json!({"saved": true})));
    }

    #[test]
    fn failed_mock_or_unrelated_saves_do_not_refresh() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let refreshes = AtomicUsize::new(0);
        let refresh = || { refreshes.fetch_add(1, Ordering::SeqCst); };
        let failed: Result<Value, String> = Err("save failed".into());
        refresh_after_settings_save("profiles-settings-save", false, &failed, &refresh, &refresh);
        refresh_after_settings_save("profiles-settings-save", true, &Ok(json!({})), &refresh, &refresh);
        refresh_after_settings_save("get-capabilities", false, &Ok(json!({})), &refresh, &refresh);
        assert_eq!(refreshes.load(Ordering::SeqCst), 0);
    }

    /// Production source only: everything before the module's own test block,
    /// so the expected tags in the test below are never counted as exit sites.
    fn production_source(source: &str) -> &str {
        source.split("\n#[cfg(test)]").next().unwrap_or(source)
    }

    #[test]
    fn exit_attribution_line_has_the_artifact_format() {
        assert_eq!(exit_line("tray-quit", 0), "[exit] reason=tray-quit code=0");
        assert_eq!(exit_line("broker-failed", 1), "[exit] reason=broker-failed code=1");
    }

    #[test]
    fn every_deliberate_exit_has_exactly_one_stable_reason_tag() {
        const MAIN: &str = include_str!("main.rs");
        const TRAY: &str = include_str!("tray.rs");
        let source = [production_source(MAIN), production_source(TRAY)].concat();
        let tags = [
            "broker-exited-clean",
            "broker-failed",
            "close-failed",
            "driver-install-quit",
            "host-exit",
            "host-relaunch",
            "native-clear-cache-restart",
            "native-maintenance-reset-failed",
            "native-maintenance-restart",
            "tray-quit",
        ];
        for tag in tags {
            assert_eq!(source.matches(&format!("exit_log_write(\"{tag}\"")).count(), 1,
                "exit tag {tag} must be written by exactly one exit site");
        }
        assert_eq!(source.matches("app.exit(").count(), tags.len(),
            "every app exit site must be attributable");
    }

    fn encoded(value: &Value) -> Value {
        arc_power_tauri::backend::wire::encode_json(value).expect("wire encode")
    }

    fn decision(
        execution: &Result<Option<(Result<Value, String>, Option<f64>)>, ()>,
    ) -> TemperatureLeaseDecision {
        temperature_lease_decision(execution, "test panic")
    }

    #[test]
    fn pre_setter_mode_refusals_decline_instead_of_poisoning_the_cache() {
        // The mode/ceiling gate answers before any setter with an out-of-range
        // entry that carries no capability ceiling. Publishing that as a
        // driver refusal is rejected by the lease finish contract and poisons
        // the process-wide refusal cache, so it must finish not-applied and
        // hand the authoritative envelope back to the broker.
        let temperature = encoded(&json!({
            "result": {"ok": false, "perControl": {"tempLimitC": {
                "ok": false, "errorCode": "out-of-range", "message": "above ceiling",
            }}},
            "state": null,
            "ocModeRefused": true,
        }));
        assert!(matches!(
            decision(&Ok(Some((Ok(temperature), None)))),
            TemperatureLeaseDecision::DeclineBeforeSetter
        ));
        // A power-only above-ceiling profile refuses with no tempLimitC entry
        // at all: same pre-setter decline, never the unknown finish.
        let power_only = encoded(&json!({
            "result": {"ok": false, "perControl": {"powerLimitW": {
                "ok": false, "errorCode": "out-of-range", "message": "above ceiling",
            }}},
            "state": null,
            "ocModeRefused": true,
        }));
        assert!(matches!(
            decision(&Ok(Some((Ok(power_only), None)))),
            TemperatureLeaseDecision::DeclineBeforeSetter
        ));
        // The same envelope after a setter attempt is never a decline.
        let after_setter = encoded(&json!({
            "result": {"ok": false, "perControl": {"tempLimitC": {
                "ok": false, "errorCode": "out-of-range", "message": "above ceiling",
            }}},
            "ocModeRefused": true,
        }));
        assert!(matches!(
            decision(&Ok(Some((Ok(after_setter), Some(90.0))))),
            TemperatureLeaseDecision::Publish { attempted_value: Some(90.0), .. }
        ));
        // A capability-ceiling refusal (finite ceiling, no mode flag) is a real
        // driver refusal and stays publishable.
        let capability = encoded(&json!({
            "result": {"ok": false, "perControl": {"tempLimitC": {
                "ok": false, "errorCode": "out-of-range", "capabilityCeiling": 90.0,
            }}},
            "state": null,
        }));
        assert!(matches!(
            decision(&Ok(Some((Ok(capability), None)))),
            TemperatureLeaseDecision::Publish { attempted_value: None, .. }
        ));
    }

    #[test]
    fn lease_decisions_fail_closed_only_after_a_setter_and_never_fall_back() {
        // No native reply at all: not-applied plus the broker's envelope.
        assert!(matches!(decision(&Ok(None)), TemperatureLeaseDecision::NoReply));
        // A panic is unknown and must fail closed, before any reply exists.
        assert!(matches!(
            decision(&Err(())),
            TemperatureLeaseDecision::Panicked { error, .. }
                if error == "Native temperature apply outcome is unknown; refresh before another apply"
        ));
        // An error before any setter is known-not-applied: no fallback re-apply.
        let pre_setter: Result<Value, String> = Err("preflight failed".into());
        match decision(&Ok(Some((pre_setter, None)))) {
            TemperatureLeaseDecision::KnownNotApplied { error } => assert_eq!(error, "preflight failed"),
            _ => panic!("an error before any setter must finish not-applied"),
        }
        // An error after a setter attempt is unknown: the broker must never
        // retry an apply that may already have changed hardware.
        let after_setter: Result<Value, String> = Err("setter failed".into());
        match decision(&Ok(Some((after_setter, Some(90.0))))) {
            TemperatureLeaseDecision::UnknownOutcome { reason, error } => {
                assert_eq!(reason, "native temperature apply failed after a setter attempt");
                assert!(error.contains("outcome is unknown after setter attempt"));
            }
            _ => panic!("an error after a setter must fail closed"),
        }
        // A malformed reply is unknown even with no attempted value.
        match decision(&Ok(Some((Ok("not a wire value".into()), None)))) {
            TemperatureLeaseDecision::UnknownOutcome { reason, error } => {
                assert_eq!(reason, "native temperature result was malformed");
                assert!(error.starts_with("Native temperature result was malformed"));
            }
            _ => panic!("a malformed reply must fail closed"),
        }
        // A successful reply publishes the untouched encoded reply.
        let success = encoded(&json!({"result": {"ok": true, "perControl": {
            "tempLimitC": {"ok": true, "readBackEqual": true},
        }}, "state": null}));
        match decision(&Ok(Some((Ok(success.clone()), Some(90.0))))) {
            TemperatureLeaseDecision::Publish { response, attempted_value, encoded_reply } => {
                assert_eq!(attempted_value, Some(90.0));
                assert_eq!(encoded_reply, success);
                assert_eq!(response["result"]["ok"], true);
            }
            _ => panic!("a successful reply must publish"),
        }
    }

    #[test]
    fn pre_setter_decline_matches_the_lease_finish_contract_shape() {
        // Exactly one temperature control, a boolean `ok` mirrored on the
        // entry, and an errorCode on the refusal: the broker's finish
        // validator accepts this as not-applied without an attempted value.
        let decline = temperature_pre_setter_decline();
        assert_eq!(decline["ok"], false);
        let per_control = decline["perControl"].as_object().expect("perControl object");
        assert_eq!(per_control.len(), 1);
        let entry = &per_control["tempLimitC"];
        assert_eq!(entry["ok"], false);
        assert_eq!(decline["ok"], entry["ok"]);
        assert!(entry["errorCode"].as_str().is_some_and(|code| !code.is_empty()));
        // Never the mode-gate shape that the finish contract rejects.
        assert_ne!(entry["errorCode"], "out-of-range");
    }

    /// Everything the leased wiring did on the broker seam, in order.
    #[derive(Default)]
    struct LeaseSeam {
        finishes: Vec<(String, Value, Option<f64>)>,
        unknown_finishes: Vec<&'static str>,
        fallbacks: Vec<(String, Value)>,
    }

    /// Drive the real decision → finish → fallback wiring with a recording fake
    /// in place of the private lease channels: no broker, no hardware.
    fn settle_observed(
        decision: TemperatureLeaseDecision,
        target: &str,
        args: &Value,
        broker_envelope: &Value,
    ) -> (Reply, LeaseSeam) {
        let seam = std::cell::RefCell::new(LeaseSeam::default());
        let reply = settle_temperature_lease(
            decision,
            |outcome, result, attempted| {
                seam.borrow_mut().finishes.push((outcome.to_owned(), result.clone(), attempted));
                Ok(())
            },
            |reason| seam.borrow_mut().unknown_finishes.push(reason),
            || {
                seam.borrow_mut().fallbacks.push((target.to_owned(), args.clone()));
                Ok(broker_envelope.clone())
            },
            |response| response.get("result").cloned()
                .ok_or(("test reply omitted its result", "test reply omitted its result".to_owned())),
        );
        (reply, seam.into_inner())
    }

    #[test]
    fn declined_leases_finish_not_applied_once_and_fall_back_on_both_paths() {
        // Both leased paths (a direct temperature apply and a profile apply that
        // carries a temperature) run the same wiring; each drives its own reply
        // shape so a regression in either arm is caught.
        let direct_args = json!([{"tempLimitC": 90}]);
        let profile_args = json!([{"profileId": "gaming", "settings": {"tempLimitC": 90}}]);
        // A pre-setter mode refusal: the direct path answers with a tempLimitC
        // entry, a power-only above-ceiling profile with no temperature entry.
        let direct_decline = json!({"result": {"ok": false, "perControl": {"tempLimitC": {
            "ok": false, "errorCode": "out-of-range", "message": "above ceiling",
        }}}, "state": null, "ocModeRefused": true});
        let profile_decline = json!({"result": {"ok": false, "perControl": {"powerLimitW": {
            "ok": false, "errorCode": "out-of-range", "message": "above ceiling",
        }}}, "state": null, "ocModeRefused": true});
        // A publishable driver refusal: finite capability ceiling, no mode flag.
        let direct_publish = json!({"result": {"ok": false, "perControl": {"tempLimitC": {
            "ok": false, "errorCode": "out-of-range", "capabilityCeiling": 90.0,
        }}}, "state": null});
        let profile_publish = json!({"result": {"ok": false, "perControl": {
            "powerLimitW": {"ok": true},
            "tempLimitC": {"ok": false, "errorCode": "out-of-range", "capabilityCeiling": 90.0},
        }}, "state": null});
        let broker_envelope = json!({
            "result": {"ok": false, "perControl": {"tempLimitC": {
                "ok": false, "errorCode": "out-of-range", "message": "mode-gated",
            }}},
            "state": {"ocMode": "stock"},
            "fromBroker": true,
        });

        for (path, args, decline, publish) in [
            ("direct", &direct_args, &direct_decline, &direct_publish),
            ("profile", &profile_args, &profile_decline, &profile_publish),
        ] {
            // 1-4: an `ocModeRefused` pre-setter decline finishes not-applied,
            // falls back exactly once with the original arguments, and returns
            // the broker's envelope without ever reaching the poison path.
            let decision = temperature_lease_decision(&Ok(Some((Ok(encoded(decline)), None))), "test panic");
            assert!(matches!(decision, TemperatureLeaseDecision::DeclineBeforeSetter), "{path}");
            let (reply, seam) = settle_observed(decision, "main", args, &broker_envelope);
            assert_eq!(seam.finishes.len(), 1, "{path}: a decline finishes the lease exactly once");
            assert_eq!(seam.finishes[0].0, "not-applied", "{path}: never completed and never unknown");
            assert_eq!(seam.finishes[0].1, temperature_pre_setter_decline(), "{path}");
            assert_eq!(seam.finishes[0].2, None, "{path}");
            assert!(seam.unknown_finishes.is_empty(), "{path}: the poison path is never reached");
            assert_eq!(seam.fallbacks.len(), 1, "{path}: the fallback runs exactly once");
            assert_eq!(seam.fallbacks[0].0, "main", "{path}");
            assert_eq!(seam.fallbacks[0].1, *args, "{path}: the fallback keeps the original arguments");
            assert_eq!(reply, Ok(broker_envelope.clone()), "{path}: the broker's envelope is returned");
            assert_ne!(reply, Ok(temperature_pre_setter_decline()), "{path}: never a native-built envelope");

            // 5: a publishable driver refusal finishes completed and performs no
            // fallback, so the test fails if every refusal is made a decline.
            let decision = temperature_lease_decision(&Ok(Some((Ok(encoded(publish)), Some(90.0)))), "test panic");
            assert!(matches!(&decision, TemperatureLeaseDecision::Publish { attempted_value, .. } if *attempted_value == Some(90.0)),
                "{path}: a driver refusal is publishable");
            let (reply, seam) = settle_observed(decision, "main", args, &broker_envelope);
            assert_eq!(seam.finishes.len(), 1, "{path}: a driver refusal finishes exactly once");
            assert_eq!(seam.finishes[0].0, "completed", "{path}: a driver refusal is publishable");
            assert_eq!(seam.finishes[0].1, publish["result"], "{path}: the reply is published as-is");
            assert_eq!(seam.finishes[0].2, Some(90.0), "{path}: the attempted value is published");
            assert!(seam.unknown_finishes.is_empty(), "{path}");
            assert!(seam.fallbacks.is_empty(), "{path}: a publishable refusal never falls back");
            assert_eq!(reply, Ok(encoded(publish)), "{path}: the native reply is returned unchanged");

            // 6: an error after a setter attempt finishes unknown and never
            // falls back, because the hardware may already have changed.
            let after_setter: Result<Value, String> = Err("setter failed".into());
            let decision = temperature_lease_decision(&Ok(Some((after_setter, Some(90.0)))), "test panic");
            let (reply, seam) = settle_observed(decision, "main", args, &broker_envelope);
            assert_eq!(seam.unknown_finishes.len(), 1, "{path}: the unknown outcome is reported once");
            assert!(seam.finishes.is_empty(), "{path}: never a completed or not-applied finish");
            assert!(seam.fallbacks.is_empty(), "{path}: an unknown outcome never falls back");
            match reply {
                Err(error) => assert!(error.contains("outcome is unknown after setter attempt"), "{path}: {error}"),
                Ok(value) => panic!("{path}: an after-setter failure must fail closed, got {value:?}"),
            }
        }
    }

    #[test]
    fn reset_defaults_come_only_from_device_capabilities() {
        let caps = json!({
            "ranges": {
                "powerLimitW": {"min": 100, "max": 250, "default": 200},
                "gpuFreqOffsetMhz": {"min": -300, "max": 300, "default": 0},
                "tempLimitC": {"min": 50, "max": 100}
            },
            "fan": {"modes": ["auto", "curve", "fixed"]}
        });
        let state = json!({"vfCurveDefault": [[0, 900], [1, 2000]]});
        let patch = reset_settings_from_capabilities(&caps, &state);
        assert_eq!(patch["powerLimitW"], json!(200));
        assert_eq!(patch["gpuFreqOffsetMhz"], json!(0));
        assert!(patch.get("tempLimitC").is_none(), "a missing default must not be guessed");
        assert_eq!(patch["fanMode"], json!("auto"));
        assert_eq!(patch["vfCurve"], state["vfCurveDefault"]);
    }

    #[test]
    fn recording_active_modes_accepts_the_native_and_broker_state_shapes() {
        let native = json!({"activeModes":{"video":true,"replay":false}});
        assert_eq!(recording_active_modes(&native), (true, false));
        let broker = json!({"mode":"replay","running":true});
        assert_eq!(recording_active_modes(&broker), (false, true));
        let stopped = json!({"mode":"video","running":false});
        assert_eq!(recording_active_modes(&stopped), (false, false));
    }

    #[test]
    fn host_profile_plan_composition_routes_temperature_to_lease_and_plain_to_fifo() {
        use arc_power_tauri::backend::host_apply::{HostApplyExecution, HostApplyPlan, HostTarget};
        let key = "pci:0x00008086:0x0000e20b@3:0.0";
        let expected = json!({"deviceKey":key,"physicalTarget":{
            "deviceKey":key,"pciVendorId":"0x00008086","pciDeviceId":"0x0000e20b",
            "bdf":{"bus":3,"device":0,"function":0},"luid":"0x00000001:0x00000002"
        }});
        let plan_for = |settings: Value| HostApplyPlan {
            payload: arc_power_tauri::backend::wire::encode_json(&json!([
                3, settings, {"profileApply": true, "expectedTarget": expected.clone()},
            ])).unwrap(),
            target: HostTarget { device_id: 3, device_key: key.to_owned(), physical_target: expected.clone() },
            routed_settings: json!({}),
            refused_per_control: json!({}),
        };

        let with_temperature = plan_for(json!({"tempLimitC": 85, "powerLimitW": 200}));
        let (mut leases, mut fifos) = (0, 0);
        let out = dispatch_host_profile_plan(
            &with_temperature,
            |request| {
                leases += 1;
                assert_eq!(request.requested_temperature, Some(85.0));
                assert_eq!(request.device_id, 3);
                Ok(HostApplyExecution::Declined)
            },
            |_| { fifos += 1; Ok(HostApplyExecution::Declined) },
        ).unwrap();
        assert!(matches!(out, HostApplyExecution::Declined));
        assert_eq!((leases, fifos), (1, 0), "temperature must take the lease, never the FIFO");

        let temperature_free = plan_for(json!({"powerLimitW": 200}));
        let (mut leases, mut fifos) = (0, 0);
        let out = dispatch_host_profile_plan(
            &temperature_free,
            |_| { leases += 1; Ok(HostApplyExecution::Declined) },
            |args| {
                fifos += 1;
                let decoded = arc_power_tauri::backend::wire::decode(args).unwrap().into_json().unwrap();
                assert_eq!(decoded[1]["tempLimitC"], Value::Null);
                Ok(HostApplyExecution::Declined)
            },
        ).unwrap();
        assert!(matches!(out, HostApplyExecution::Declined));
        assert_eq!((leases, fifos), (0, 1), "a temperature-free profile must take the FIFO");

        let unclaimed = HostApplyPlan {
            payload: arc_power_tauri::backend::wire::encode_json(&json!([3, {"powerLimitW": 200}, {}])).unwrap(),
            target: HostTarget { device_id: 3, device_key: key.to_owned(), physical_target: expected },
            routed_settings: json!({}),
            refused_per_control: json!({}),
        };
        let out = dispatch_host_profile_plan(
            &unclaimed,
            |_| panic!("an unproven plan must never reach the lease"),
            |_| panic!("an unproven plan must never reach the FIFO"),
        ).unwrap();
        assert!(matches!(out, HostApplyExecution::Declined), "an unproven plan writes nothing");
    }

}
