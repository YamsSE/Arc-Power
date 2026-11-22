//! Global recording hotkeys. Registration lives on its own Win32 message
//! loop so settings saves can report exact conflicts to the renderer.
use serde_json::{json, Map, Value};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

const MOD_ALT: u32 = 0x0001;
const MOD_CONTROL: u32 = 0x0002;
const MOD_SHIFT: u32 = 0x0004;
const MOD_NOREPEAT: u32 = 0x4000;
const HOTKEY_BASE: i32 = 1;
const WM_APP_RELOAD: u32 = 0x8000 + 1;

enum Command {
    Reload { entries: Vec<(String, String)>, reserved: Vec<String>, reply: mpsc::SyncSender<Value> },
    Stop,
}

#[derive(Clone)]
struct Registered {
    id: i32,
    action: String,
}

pub struct RecordingHotkeys {
    sender: mpsc::Sender<Command>,
}

#[cfg(windows)]
static THREAD_ID: OnceLock<u32> = OnceLock::new();

fn wake() {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::PostThreadMessageW;
        if let Some(thread_id) = THREAD_ID.get() {
            unsafe { PostThreadMessageW(*thread_id, WM_APP_RELOAD, 0, 0); }
        }
    }
}

impl RecordingHotkeys {
    pub fn start(on_action: mpsc::Sender<String>) -> Self {
        let (sender, receiver) = mpsc::channel();
        let (ready_sender, ready_receiver) = mpsc::sync_channel(1);
        let thread_sender = sender.clone();
        std::thread::Builder::new().name("arc-recording-hotkeys".into()).spawn(move || {
            run(receiver, thread_sender, on_action, ready_sender);
        }).expect("recording hotkey thread");
        let _ = ready_receiver.recv_timeout(Duration::from_secs(3));
        Self { sender }
    }

    pub fn reload(&self, settings: &Value, reserved: &[String]) -> Value {
        let mut entries = Vec::new();
        for action in ["toggle", "saveClip", "screenshot"] {
            let accelerator = settings.get("hotkeys").and_then(|value| value.get(action)).and_then(Value::as_str).unwrap_or("");
            if accelerator.trim().is_empty() { continue; }
            entries.push((action.to_owned(), accelerator.to_owned()));
        }
        let (reply_sender, reply_receiver) = mpsc::sync_channel(1);
        if self.sender.send(Command::Reload { entries, reserved: reserved.to_vec(), reply: reply_sender }).is_err() {
            return hotkey_state(Map::new(), Map::new(), Some("Recording hotkey thread is unavailable"));
        }
        wake();
        reply_receiver.recv_timeout(Duration::from_secs(3)).unwrap_or_else(|_| hotkey_state(Map::new(), Map::new(), Some("Recording hotkey registration timed out")))
    }
}

impl Drop for RecordingHotkeys {
    fn drop(&mut self) { let _ = self.sender.send(Command::Stop); wake(); }
}

fn hotkey_state(registered: Map<String, Value>, conflicts: Map<String, Value>, error: Option<&str>) -> Value {
    json!({"registered":registered,"conflicts":conflicts,"error":error})
}

#[cfg(windows)]
fn run(receiver: mpsc::Receiver<Command>, _sender: mpsc::Sender<Command>, on_action: mpsc::Sender<String>, ready: mpsc::SyncSender<()>) {
    use windows_sys::Win32::{
        System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
        UI::{Input::KeyboardAndMouse::UnregisterHotKey, WindowsAndMessaging::*},
    };
    const CLASS_NAME: &[u16] = &[b'A' as u16, b'r' as u16, b'c' as u16, b'R' as u16, b'e' as u16, b'c' as u16,
        b'H' as u16, b'o' as u16, b't' as u16, b'k' as u16, b'e' as u16, b'y' as u16, 0];
    let instance = unsafe { GetModuleHandleW(std::ptr::null()) };
    let class = WNDCLASSW {
        style: 0, lpfnWndProc: Some(wndproc), cbClsExtra: 0, cbWndExtra: 0,
        hInstance: instance, hIcon: std::ptr::null_mut(), hCursor: std::ptr::null_mut(),
        hbrBackground: std::ptr::null_mut(), lpszMenuName: std::ptr::null(), lpszClassName: CLASS_NAME.as_ptr(),
    };
    unsafe { RegisterClassW(&class); }
    let title: Vec<u16> = "Arc Power Recording Hotkeys\0".encode_utf16().collect();
    let hwnd = unsafe { CreateWindowExW(0, CLASS_NAME.as_ptr(), title.as_ptr(), 0, 0, 0, 0, 0,
        std::ptr::null_mut(), std::ptr::null_mut(), instance, std::ptr::null()) };
    if hwnd.is_null() { let _ = ready.send(()); return; }
    let thread_id = unsafe { GetCurrentThreadId() };
    let _ = THREAD_ID.set(thread_id);
    let _ = ready.send(());
    let mut current: Vec<Registered> = Vec::new();
    let mut message: MSG = unsafe { std::mem::zeroed() };
    loop {
        let result = unsafe { GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) };
        if result <= 0 { break; }
        if message.message == WM_APP_RELOAD {
            while let Ok(command) = receiver.try_recv() {
                match command {
                    Command::Reload { entries, reserved, reply } => {
                        let state = apply(&mut current, &entries, &reserved);
                        let _ = reply.send(state);
                    }
                    Command::Stop => { unsafe { PostQuitMessage(0); } break; }
                }
            }
        } else if message.message == WM_HOTKEY {
            let id = message.wParam as i32;
            if let Some(hotkey) = current.iter().find(|hotkey| hotkey.id == id) {
                let _ = on_action.send(hotkey.action.clone());
            }
        } else {
            unsafe { TranslateMessage(&message); DispatchMessageW(&message); }
        }
    }
    let _ = receiver;
    let _ = on_action;
    for hotkey in current { unsafe { UnregisterHotKey(std::ptr::null_mut(), hotkey.id); } }
}

#[cfg(windows)]
fn apply(current: &mut Vec<Registered>, entries: &[(String, String)], reserved: &[String]) -> Value {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey};
    for hotkey in current.iter() { unsafe { UnregisterHotKey(std::ptr::null_mut(), hotkey.id); } }
    current.clear();
    let mut registered = Map::new();
    let mut conflicts = Map::new();
    let mut error: Option<String> = None;
    let normalized_reserved: Vec<String> = reserved.iter().filter_map(|value| normalize_accelerator(value)).collect();
    for (action, accelerator) in entries {
        let Some(normalized) = normalize_accelerator(accelerator) else {
            conflicts.insert(action.clone(), json!(accelerator));
            if error.is_none() { error = Some(format!("Could not register {accelerator}")); }
            continue;
        };
        if normalized_reserved.contains(&normalized) || registered.values().any(|value| value.as_str() == Some(normalized.as_str())) {
            conflicts.insert(action.clone(), json!(normalized));
            continue;
        }
        let Some(parsed) = parse_accelerator(&normalized) else {
            conflicts.insert(action.clone(), json!(normalized));
            continue;
        };
        let id = HOTKEY_BASE + current.len() as i32;
        if unsafe { RegisterHotKey(std::ptr::null_mut(), id, parsed.1 | MOD_NOREPEAT, parsed.2) } != 0 {
            current.push(Registered { id, action: action.clone() });
            registered.insert(action.clone(), json!(normalized));
        } else {
            conflicts.insert(action.clone(), json!(normalized));
            if error.is_none() { error = Some(format!("Could not register {normalized}")); }
        }
    }
    hotkey_state(registered, conflicts, error.as_deref())
}

#[cfg(not(windows))]
fn run(receiver: mpsc::Receiver<Command>, _sender: mpsc::Sender<Command>, _on_action: mpsc::Sender<String>, ready: mpsc::SyncSender<()>) {
    let _ = ready.send(());
    while let Ok(command) = receiver.recv() {
        if let Command::Reload { reply, .. } = command {
            let _ = reply.send(hotkey_state(Map::new(), Map::new(), Some("Global hotkeys are only available on Windows")));
        }
    }
}

#[cfg(windows)]
unsafe extern "system" fn wndproc(hwnd: windows_sys::Win32::Foundation::HWND, message: u32,
    wparam: windows_sys::Win32::Foundation::WPARAM, lparam: windows_sys::Win32::Foundation::LPARAM)
    -> windows_sys::Win32::Foundation::LRESULT {
    use windows_sys::Win32::UI::WindowsAndMessaging::DefWindowProcW;
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}

/// Canonical recording accelerator: modifiers in Control/Alt/Shift order and
/// a key limited to a single alphanumeric or F1-F24.
pub fn normalize_accelerator(value: &str) -> Option<String> {
    let compact: String = value.chars().filter(|character| !character.is_whitespace()).collect();
    if compact.is_empty() || compact.eq_ignore_ascii_case("none") { return None; }
    let mut parts: Vec<&str> = compact.split('+').collect();
    if parts.iter().any(|part| part.is_empty()) { return None; }
    let key = parts.pop()?.to_ascii_uppercase();
    let valid = (key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric())
        || key.strip_prefix('F').is_some_and(|number| !number.is_empty() && !number.starts_with('0') && number.bytes().all(|byte| byte.is_ascii_digit()) && number.parse::<u8>().is_ok_and(|number| (1..=24).contains(&number)));
    if !valid { return None; }
    let mut control = false;
    let mut alt = false;
    let mut shift = false;
    for part in parts {
        match part.to_ascii_lowercase().as_str() {
            "control" | "ctrl" | "commandorcontrol" | "cmdorcontrol" => control = true,
            "alt" => alt = true,
            "shift" => shift = true,
            _ => return None,
        }
    }
    let mut output = String::new();
    if control { output.push_str("Control+"); }
    if alt { output.push_str("Alt+"); }
    if shift { output.push_str("Shift+"); }
    output.push_str(&key);
    Some(output)
}

fn parse_accelerator(value: &str) -> Option<(String, u32, u32)> {
    let normalized = normalize_accelerator(value)?;
    let mut parts: Vec<&str> = normalized.split('+').collect();
    let key = parts.pop()?;
    let mut modifiers = 0u32;
    for part in parts {
        modifiers |= match part { "Control" => MOD_CONTROL, "Alt" => MOD_ALT, "Shift" => MOD_SHIFT, _ => return None };
    }
    let virtual_key = if key.len() == 1 {
        let character = key.as_bytes()[0];
        if character.is_ascii_uppercase() || character.is_ascii_digit() { character as u32 } else { return None; }
    } else {
        let number = key.strip_prefix('F')?.parse::<u32>().ok()?;
        if !(1..=24).contains(&number) { return None; }
        0x70 + number - 1
    };
    Some((normalized, modifiers, virtual_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accelerators_are_canonical_and_bounded() {
        assert_eq!(normalize_accelerator("f9"), Some("F9".into()));
        assert_eq!(normalize_accelerator("shift+control+7"), Some("Control+Shift+7".into()));
        assert_eq!(normalize_accelerator("CommandOrControl+Alt+F12"), Some("Control+Alt+F12".into()));
        assert!(normalize_accelerator("").is_none());
        assert!(normalize_accelerator("None").is_none());
        assert!(normalize_accelerator("Control+").is_none());
        assert!(normalize_accelerator("Control+F25").is_none());
    }

    #[test]
    fn parsed_virtual_keys_match_win32() {
        assert_eq!(parse_accelerator("F1").unwrap().2, 0x70);
        assert_eq!(parse_accelerator("F24").unwrap().2, 0x87);
        assert_eq!(parse_accelerator("Control+A").unwrap().1, MOD_CONTROL);
        assert_eq!(parse_accelerator("A").unwrap().1, 0);
    }

    #[test]
    #[ignore = "live global hotkey registration check"]
    fn live_hotkey_registration_reports_the_registered_map() {
        let (actions, _receiver) = mpsc::channel();
        let manager = RecordingHotkeys::start(actions);
        let state = manager.reload(&json!({"hotkeys":{"toggle":"Control+Alt+Shift+F24","saveClip":"","screenshot":""}}), &[]);
        assert_eq!(state["registered"]["toggle"], "Control+Alt+Shift+F24", "{state}");
        assert!(state["conflicts"].as_object().unwrap().is_empty());
    }
}
