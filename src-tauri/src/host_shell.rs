//! Native host shell: a hidden Win32 window for suspend/resume notifications
//! plus global hotkey registration. Overlay/power actions are relayed to the
//! compatibility service; the RTSS overlay toggle and the postprocess-scale
//! effect are owned natively. Registration state is published so the native
//! screen post-processing service can confirm a Scale hotkey change and the
//! native Advanced Overlay service can report its own registration result.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{mpsc, OnceLock};

const TIMER_ID: usize = 1;
const RELOAD_MESSAGE: u32 = 0x8001;
const HOTKEY_BASE: i32 = 1;
const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_NOREPEAT: u32 = 0x4000;

static EVENTS: OnceLock<mpsc::SyncSender<(String, String, Value)>> = OnceLock::new();
static HOST_STARTED: AtomicBool = AtomicBool::new(false);
static HOST_WINDOW: AtomicIsize = AtomicIsize::new(0);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Hotkey { id: i32, action: &'static str, accelerator: String, modifiers: u32, virtual_key: u32 }

struct HotkeyPlan {
    hotkeys: Vec<Hotkey>,
    scale_desired: String,
    scale_conflict: bool,
    advanced_desired: Option<String>,
    advanced_planned: bool,
    advanced_conflict: bool,
}

pub fn start(events: mpsc::SyncSender<(String, String, Value)>) {
    if EVENTS.set(events).is_err() { return; }
    HOST_STARTED.store(true, Ordering::SeqCst);
    arc_power_tauri::backend::postprocess_sharpening::mark_host_registration_started();
    let _ = std::thread::Builder::new().name("arc-host-shell".into()).spawn(run);
}

/// Ask the hidden host window to reconcile `RegisterHotKey` state immediately.
/// Returns the registration generation observed before the request.
pub fn request_reload() -> Option<u64> {
    if !HOST_STARTED.load(Ordering::SeqCst) { return None; }
    let before = arc_power_tauri::backend::postprocess_sharpening::host_registration_snapshot()
        .map(|snapshot| snapshot.generation).unwrap_or(0);
    let hwnd = HOST_WINDOW.load(Ordering::SeqCst) as *mut std::ffi::c_void;
    if !hwnd.is_null() {
        #[cfg(windows)]
        unsafe { windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(hwnd, RELOAD_MESSAGE, 0, 0); }
    }
    Some(before)
}

fn send(event: &str, payload: Value) {
    if let Some(events) = EVENTS.get() { let _ = events.try_send(("main".to_owned(), event.to_owned(), payload)); }
}

#[cfg(windows)]
fn run() {
    use windows_sys::Win32::{
        System::LibraryLoader::GetModuleHandleW,
        UI::WindowsAndMessaging::*,
    };
    const CLASS_NAME: &[u16] = &[b'A' as u16, b'r' as u16, b'c' as u16, b'P' as u16, b'o' as u16, b'w' as u16, b'e' as u16, b'r' as u16,
        b'H' as u16, b'o' as u16, b's' as u16, b't' as u16, b'S' as u16, b'h' as u16, b'e' as u16, b'l' as u16, b'l' as u16, 0];
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = WNDCLASSW {
        style: 0, lpfnWndProc: Some(wndproc), cbClsExtra: 0, cbWndExtra: 0,
        hInstance: instance, hIcon: std::ptr::null_mut(), hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(), lpszMenuName: std::ptr::null(), lpszClassName: CLASS_NAME.as_ptr(),
    };
    unsafe { RegisterClassW(&class); }
    let title: Vec<u16> = "Arc Power Host\0".encode_utf16().collect();
    let hwnd = unsafe { CreateWindowExW(0, CLASS_NAME.as_ptr(), title.as_ptr(), 0, 0, 0, 0, 0,
        std::ptr::null_mut(), std::ptr::null_mut(), instance, std::ptr::null()) };
    if hwnd.is_null() { return; }
    HOST_WINDOW.store(hwnd as isize, Ordering::SeqCst);
    let timer = unsafe { SetTimer(std::ptr::null_mut(), TIMER_ID, 2000, None) };
    let mut current: Vec<Hotkey> = Vec::new();
    reload(&mut current);
    let mut message: MSG = unsafe { std::mem::zeroed() };
    loop {
        let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
        if result <= 0 { break; }
        if message.message == WM_HOTKEY {
            let id = message.wParam as i32;
            if let Some(hotkey) = current.iter().find(|hotkey| hotkey.id == id) {
                send("shortcut", json!({"action": hotkey.action, "accelerator": hotkey.accelerator}));
            }
        } else if message.message == RELOAD_MESSAGE {
            reload(&mut current);
        } else if message.message == WM_TIMER && message.wParam == timer {
            reload(&mut current);
        } else {
            unsafe { TranslateMessage(&message); DispatchMessageW(&message); }
        }
    }
    HOST_WINDOW.store(0, Ordering::SeqCst);
}

#[cfg(not(windows))]
fn run() {}

#[cfg(windows)]
unsafe extern "system" fn wndproc(hwnd: windows_sys::Win32::Foundation::HWND, message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM, lparam: windows_sys::Win32::Foundation::LPARAM)
    -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::{DefWindowProcW, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND, WM_POWERBROADCAST};
    if message == WM_POWERBROADCAST {
        match wparam as u32 {
            PBT_APMSUSPEND => send("power", json!({"state": "suspend"})),
            PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND => send("power", json!({"state": "resume"})),
            _ => {}
        }
    }
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

#[cfg(windows)]
fn reload(current: &mut Vec<Hotkey>) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
    let plan = desired_hotkeys();
    let unchanged = current.len() == plan.hotkeys.len()
        && current.iter().zip(plan.hotkeys.iter())
            .all(|(current, desired)| current.action == desired.action && current.accelerator == desired.accelerator);
    if unchanged {
        publish_state(current, &plan);
        return;
    }
    for hotkey in current.iter() { unsafe { UnregisterHotKey(std::ptr::null_mut(), hotkey.id); } }
    current.clear();
    for (index, mut hotkey) in plan.hotkeys.iter().cloned().enumerate() {
        hotkey.id = HOTKEY_BASE + index as i32;
        if unsafe { RegisterHotKey(std::ptr::null_mut(), hotkey.id, hotkey.modifiers | MOD_NOREPEAT, hotkey.virtual_key) } != 0 {
            current.push(hotkey);
        }
    }
    publish_state(current, &plan);
}

#[cfg(windows)]
fn publish_state(current: &[Hotkey], plan: &HotkeyPlan) {
    let registered = current.iter().map(|hotkey| hotkey.accelerator.clone()).collect::<Vec<_>>();
    let scale_registered = registered.iter().any(|accelerator| accelerator == &plan.scale_desired);
    let reason = if scale_registered { None }
        else if plan.scale_conflict {
            Some(format!("Scale hotkey {} conflicts with another Arc Power shortcut.", plan.scale_desired))
        } else {
            Some(format!("Could not register {}; another application may use it.", plan.scale_desired))
        };
    let advanced_registered = plan.advanced_planned && plan.advanced_desired.as_ref()
        .is_some_and(|accelerator| registered.iter().any(|value| value == accelerator));
    let advanced_reason = if advanced_registered || plan.advanced_desired.is_none() { None }
        else if plan.advanced_conflict {
            Some(format!("Advanced overlay hotkey {} conflicts with another Arc Power shortcut.",
                plan.advanced_desired.as_deref().unwrap_or_default()))
        } else {
            Some(format!("Could not register {}; another application may use it.",
                plan.advanced_desired.as_deref().unwrap_or_default()))
        };
    arc_power_tauri::backend::postprocess_sharpening::publish_host_registration(
        registered, plan.scale_desired.clone(), reason,
        plan.advanced_desired.clone(), advanced_registered, advanced_reason);
}

#[cfg(not(windows))]
fn reload(_current: &mut Vec<Hotkey>) {}

fn desired_hotkeys() -> HotkeyPlan {
    let settings = settings_snapshot();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let overlay = settings.get("overlayHotkeyLetter").and_then(Value::as_str).unwrap_or("O");
    if let Some(hotkey) = parse_accelerator(overlay, "overlay") {
        if seen.insert(hotkey.accelerator.clone()) { out.push(hotkey); }
    }
    let mut advanced_desired = None;
    let mut advanced_planned = false;
    let mut advanced_conflict = false;
    if settings.get("advancedOverlayEnabled").and_then(Value::as_bool) == Some(true) {
        let advanced = settings.get("advancedOverlayHotkeyLetter").and_then(Value::as_str).unwrap_or("P");
        if let Some(hotkey) = parse_accelerator(advanced, "advanced-overlay") {
            advanced_desired = Some(hotkey.accelerator.clone());
            if seen.contains(&hotkey.accelerator) {
                advanced_conflict = true;
            } else {
                seen.insert(hotkey.accelerator.clone());
                out.push(hotkey);
                advanced_planned = true;
            }
        }
    }
    let scale = settings.get("postprocessScaleHotkey").and_then(Value::as_str).unwrap_or("Alt+F10");
    let mut scale_desired = scale.to_owned();
    let mut scale_conflict = false;
    if let Some(hotkey) = parse_accelerator(scale, "postprocess-scale") {
        scale_desired = hotkey.accelerator.clone();
        if seen.contains(&hotkey.accelerator) {
            scale_conflict = true;
        } else if seen.insert(hotkey.accelerator.clone()) {
            out.push(hotkey);
        }
    }
    HotkeyPlan { hotkeys: out, scale_desired, scale_conflict, advanced_desired, advanced_planned, advanced_conflict }
}

fn settings_snapshot() -> Value {
    let Some(app_data) = std::env::var_os("APPDATA") else { return json!({}); };
    let path = std::path::PathBuf::from(app_data).join("ArcPower").join("settings.json");
    let Ok(text) = std::fs::read_to_string(path) else { return json!({}); };
    serde_json::from_str(&text).ok().filter(Value::is_object).unwrap_or_else(|| json!({}))
}

fn parse_accelerator(value: &str, action: &'static str) -> Option<Hotkey> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("none") { return None; }
    let source = if value.len() == 1 && value.chars().next()?.is_ascii_alphanumeric() {
        format!("Control+{value}")
    } else { value.to_owned() };
    let mut pieces: Vec<&str> = source.split('+').map(str::trim).filter(|piece| !piece.is_empty()).collect();
    let key = pieces.pop()?;
    let virtual_key = virtual_key_of(key)?;
    let mut modifiers = 0u32;
    let mut names = Vec::new();
    for piece in pieces {
        match piece.to_ascii_lowercase().as_str() {
            "control" | "ctrl" => { modifiers |= MOD_CONTROL; names.push("Control"); }
            "alt" => { modifiers |= MOD_ALT; names.push("Alt"); }
            "shift" => { modifiers |= MOD_SHIFT; names.push("Shift"); }
            _ => return None,
        }
    }
    // A single function key is a complete hotkey; a letter or number needs a chord.
    let is_function_key = key.len() > 1;
    if modifiers == 0 && !is_function_key { return None; }
    names.sort_by_key(|name| match *name { "Control" => 0, "Alt" => 1, _ => 2 });
    names.dedup();
    let mut canonical: Vec<String> = names.into_iter().map(str::to_owned).collect();
    canonical.push(key.to_ascii_uppercase());
    Some(Hotkey { id: 0, action, accelerator: canonical.join("+"), modifiers, virtual_key })
}

fn virtual_key_of(key: &str) -> Option<u32> {
    let key = key.to_ascii_uppercase();
    if key.len() == 1 {
        let character = key.chars().next()?;
        if character.is_ascii_uppercase() || character.is_ascii_digit() { return Some(character as u32); }
        return None;
    }
    if let Some(number) = key.strip_prefix('F').and_then(|number| number.parse::<u32>().ok()) {
        if (1..=24).contains(&number) { return Some(0x70 + number - 1); }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_are_canonicalized_and_limited_to_the_settings_grammar() {
        assert_eq!(parse_accelerator("O", "overlay").unwrap().accelerator, "Control+O");
        assert_eq!(parse_accelerator("alt+f10", "postprocess-scale").unwrap().accelerator, "Alt+F10");
        assert_eq!(parse_accelerator("Control+Shift+9", "overlay").unwrap().modifiers, MOD_CONTROL | MOD_SHIFT);
        assert!(parse_accelerator("O", "overlay").unwrap().modifiers & MOD_CONTROL != 0);
        assert!(parse_accelerator("None", "overlay").is_none());
        assert!(parse_accelerator("Alt+Control", "overlay").is_none());
        assert!(parse_accelerator("Control+F25", "overlay").is_none());
    }

    #[test]
    fn virtual_keys_cover_letters_digits_and_function_keys() {
        assert_eq!(virtual_key_of("A"), Some('A' as u32));
        assert_eq!(virtual_key_of("7"), Some('7' as u32));
        assert_eq!(virtual_key_of("F1"), Some(0x70));
        assert_eq!(virtual_key_of("F24"), Some(0x87));
        assert_eq!(virtual_key_of("F25"), None);
    }

    #[test]
    fn registration_snapshot_reports_conflicts_and_missing_registrations() {
        arc_power_tauri::backend::postprocess_sharpening::mark_host_registration_started();
        let overlay = Hotkey { id: 1, action: "overlay", accelerator: "Control+O".into(),
            modifiers: MOD_CONTROL, virtual_key: 'O' as u32 };
        let conflict = HotkeyPlan {
            hotkeys: vec![overlay.clone()],
            scale_desired: "Control+P".into(),
            scale_conflict: true,
            advanced_desired: None,
            advanced_planned: false,
            advanced_conflict: false,
        };
        publish_state(std::slice::from_ref(&overlay), &conflict);
        let snapshot = arc_power_tauri::backend::postprocess_sharpening::host_registration_snapshot().unwrap();
        assert!(snapshot.result_for("Control+O").registered);
        assert_eq!(snapshot.result_for("Control+P").reason.as_deref(),
            Some("Scale hotkey Control+P conflicts with another Arc Power shortcut."));

        let missing = HotkeyPlan { hotkeys: vec![], scale_desired: "Alt+F10".into(), scale_conflict: false,
            advanced_desired: None, advanced_planned: false, advanced_conflict: false };
        publish_state(&[], &missing);
        let snapshot = arc_power_tauri::backend::postprocess_sharpening::host_registration_snapshot().unwrap();
        assert_eq!(snapshot.result_for("Alt+F10").reason.as_deref(),
            Some("Could not register Alt+F10; another application may use it."));
    }
}
