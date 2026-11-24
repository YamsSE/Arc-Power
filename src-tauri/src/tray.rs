//! Native Tauri tray. Window toggle and quit are native; "Apply active
//! profile" is relayed to the compatibility service until profile apply is
//! fully native.
use serde_json::{json, Value};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};
use webview2_com::{Microsoft::Web::WebView2::Win32::ICoreWebView2_3, TrySuspendCompletedHandler};
use windows::core::Interface;

static TRAY: OnceLock<Mutex<Option<TrayIcon<Wry>>>> = OnceLock::new();
static RECORDING_STATUS: OnceLock<Mutex<&'static str>> = OnceLock::new();
static BASE_ICON: OnceLock<Mutex<Option<(Vec<u8>, u32, u32)>>> = OnceLock::new();

fn recording_status() -> &'static Mutex<&'static str> {
    RECORDING_STATUS.get_or_init(|| Mutex::new("ready"))
}

fn base_icon() -> &'static Mutex<Option<(Vec<u8>, u32, u32)>> {
    BASE_ICON.get_or_init(|| Mutex::new(None))
}

fn status_label(status: &str) -> &'static str {
    match status {
        "recording" => "Recording",
        "replay" => "Instant Replay",
        "saving" => "Saving Instant Replay",
        "error" => "Instant Replay failed",
        _ => "Ready",
    }
}

fn status_from_recording_state(state: &Value) -> &'static str {
    if state["instantReplaySave"]["status"].as_str() == Some("saving") { return "saving"; }
    if state["instantReplaySave"]["status"].as_str() == Some("error") { return "error"; }
    let modes = state.get("activeModes").and_then(Value::as_object);
    let video = modes.and_then(|modes| modes.get("video")).and_then(Value::as_bool) == Some(true)
        || (modes.is_none() && state["running"].as_bool() == Some(true) && state["mode"].as_str() == Some("video"));
    let replay = modes.and_then(|modes| modes.get("replay")).and_then(Value::as_bool) == Some(true)
        || (modes.is_none() && state["running"].as_bool() == Some(true) && state["mode"].as_str() == Some("replay"));
    if video { "recording" } else if replay { "replay" } else { "ready" }
}

/// Update the desktop-wide tray badge from the same native recording state
/// stream that feeds the WebView status pill and toasts.
pub fn set_recording_state(state: &Value) -> Result<(), String> {
    let next = status_from_recording_state(state);
    {
        let mut current = recording_status().lock().map_err(|_| "recording tray status lock failed")?;
        if *current == next { return Ok(()); }
        *current = next;
    }
    let Some(tray) = TRAY.get().and_then(|tray| tray.lock().ok().and_then(|tray| tray.as_ref().map(TrayIcon::clone))) else {
        return Ok(());
    };
    tray.set_tooltip(Some(format!("Arc Power - {}", status_label(next)))).map_err(|error| error.to_string())?;
    let icon = if next == "ready" {
        Image::from_bytes(include_bytes!("../../src/assets/tray-icon.png")).map_err(|error| error.to_string())?
    } else {
        let base = base_icon().lock().map_err(|_| "tray icon lock failed")?.clone();
        let Some((mut pixels, width, height)) = base else { return Ok(()) };
        let color = match next { "saving" => [59u8, 130, 246, 255], "replay" => [245u8, 158, 11, 255], _ => [239u8, 68, 68, 255] };
        let radius = (width.min(height) as f32 * 0.22).max(3.0);
        let center_x = width as f32 - radius - 1.0;
        let center_y = radius + 1.0;
        for y in 0..height {
            for x in 0..width {
                let dx = x as f32 - center_x;
                let dy = y as f32 - center_y;
                if dx * dx + dy * dy <= radius * radius {
                    let index = ((y * width + x) * 4) as usize;
                    if index + 3 < pixels.len() { pixels[index..index + 4].copy_from_slice(&color); }
                }
            }
        }
        Image::new_owned(pixels, width, height)
    };
    tray.set_icon(Some(icon)).map_err(|error| error.to_string())
}

pub fn create(app: &AppHandle, store: &arc_power_tauri::backend::native_store::NativeStore,
    events: mpsc::SyncSender<(String, String, Value)>) -> Result<(), String> {
    if TRAY.get().and_then(|tray| tray.lock().ok().and_then(|tray| tray.as_ref().map(|_| ()))).is_some() {
        return Ok(());
    }
    let icon = Image::from_bytes(include_bytes!("../../src/assets/tray-icon.png"))
        .map_err(|error| error.to_string())?;
    if let Ok(mut base) = base_icon().lock() {
        *base = Some((icon.rgba().to_vec(), icon.width(), icon.height()));
    }
    let (menu, _) = build_menu(app, store)?;
    let tray_events = events.clone();
    let tray = TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Arc Power")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "toggle" => toggle_main(app),
            "apply" => { let _ = tray_events.try_send(("main".to_owned(), "tray-action".to_owned(), json!({"action":"apply-profile"}))); }
            "quit" => quit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(event, TrayIconEvent::DoubleClick { button: MouseButton::Left, .. }) {
                toggle_main(tray.app_handle());
            }
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    *TRAY.get_or_init(|| Mutex::new(None)).lock().map_err(|_| "tray lock failed")? = Some(tray);
    Ok(())
}

pub fn rebuild(app: &AppHandle, store: &arc_power_tauri::backend::native_store::NativeStore) -> Result<Value, String> {
    let Some(tray) = TRAY.get().and_then(|tray| tray.lock().ok().and_then(|tray| tray.as_ref().map(TrayIcon::clone))) else {
        return Ok(json!({"ok":true}));
    };
    let (menu, _) = build_menu(app, store)?;
    tray.set_menu(Some(menu)).map_err(|error| error.to_string())?;
    Ok(json!({"ok":true}))
}

fn build_menu(app: &AppHandle, store: &arc_power_tauri::backend::native_store::NativeStore) -> Result<(Menu<Wry>, bool), String> {
    use arc_power_tauri::backend::wire;
    let load = |method: &str| -> Option<Value> {
        let args = wire::encode_json(&json!([])).ok()?;
        let reply = store.invoke(method, &args).ok()?;
        wire::decode(&reply).ok()?.into_json().ok()
    };
    let settings = load("load-settings").unwrap_or_else(|| json!({}));
    let profiles = load("load-profiles").unwrap_or_else(|| json!([]));
    let has_active = !arc_power_tauri::backend::profile_store::active_profile_entries(
        &settings, profiles.as_array().map(Vec::as_slice).unwrap_or(&[])).is_empty();
    let toggle = MenuItem::with_id(app, "toggle", "Show / Hide window", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let apply = has_active.then(|| MenuItem::with_id(app, "apply", "Apply active profile", true, None::<&str>))
        .transpose().map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let mut items: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = vec![&toggle];
    if let Some(apply) = &apply { items.push(apply); }
    items.push(&quit);
    let menu = Menu::with_items(app, &items).map_err(|error| error.to_string())?;
    Ok((menu, has_active))
}

fn toggle_main(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return; };
    if window.is_minimized().unwrap_or(false) {
        resume_main_webview(app);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    } else if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        suspend_main_webview(app);
    } else {
        resume_main_webview(app);
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Ask WebView2 to release its renderer memory while the window is hidden to
/// the tray. The DOM is preserved; `resume_main_webview` restores it. The
/// overlay/advanced-overlay/toast windows are separate WebViews and are not
/// affected.
pub fn suspend_main_webview(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Let the hide reach the WebView2 controller; TrySuspend fails on a
        // visible webview.
        std::thread::sleep(Duration::from_millis(200));
        let Some(window) = app.get_webview_window("main") else { return; };
        let _ = window.with_webview(|webview| {
            let controller = webview.controller();
            let Ok(core) = (unsafe { controller.CoreWebView2() }) else { return; };
            let Ok(core3) = core.cast::<ICoreWebView2_3>() else { return; };
            let handler = TrySuspendCompletedHandler::create(Box::new(|_, _| Ok(())));
            let _ = unsafe { core3.TrySuspend(&handler) };
        });
    });
}

pub fn resume_main_webview(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else { return; };
    let _ = window.with_webview(|webview| {
        let controller = webview.controller();
        let Ok(core) = (unsafe { controller.CoreWebView2() }) else { return; };
        let Ok(core3) = core.cast::<ICoreWebView2_3>() else { return; };
        let _ = unsafe { core3.Resume() };
    });
}

fn quit(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        // Attributable first: the artifact must show the exit line before the
        // broker is killed.
        crate::exit_log_write("tray-quit", 0);
        if let Some(broker) = app.try_state::<std::sync::Arc<crate::Broker>>() {
            broker.shutdown();
            broker.allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        app.exit(0);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_state_badges_match_the_electron_tray_contract() {
        assert_eq!(status_from_recording_state(&json!({"running":false,"activeModes":{"video":false,"replay":false}})), "ready");
        assert_eq!(status_from_recording_state(&json!({"running":true,"activeModes":{"video":true,"replay":false}})), "recording");
        assert_eq!(status_from_recording_state(&json!({"running":true,"activeModes":{"video":false,"replay":true}})), "replay");
        assert_eq!(status_from_recording_state(&json!({"activeModes":{"video":true},"instantReplaySave":{"status":"saving"}})), "saving");
        assert_eq!(status_from_recording_state(&json!({"activeModes":{"video":true},"instantReplaySave":{"status":"error"}})), "error");
        assert_eq!(status_label("recording"), "Recording");
    }
}
