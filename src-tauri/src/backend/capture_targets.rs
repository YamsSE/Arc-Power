//! Native display/window inventory for recording capture targets.
//! Replaces the PowerShell Add-Type probe and Electron screen metadata.
use serde_json::{json, Value};

#[cfg(windows)]
fn utf16_len(units: &[u16]) -> String { String::from_utf16_lossy(units) }

#[cfg(windows)]
fn utf16_z(units: &[u16]) -> String {
    let end = units.iter().position(|unit| *unit == 0).unwrap_or(units.len());
    utf16_len(&units[..end])
}

#[cfg(windows)]
fn hdr_by_gdi_name() -> std::collections::HashMap<String, bool> {
    use std::collections::HashMap;
    use windows_sys::Win32::Devices::Display::*;
    let mut path_count = 0u32;
    let mut mode_count = 0u32;
    if unsafe { GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut path_count, &mut mode_count) } != 0 {
        return HashMap::new();
    }
    let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); path_count as usize];
    let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); mode_count as usize];
    if unsafe { QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &mut path_count, paths.as_mut_ptr(),
        &mut mode_count, modes.as_mut_ptr(), std::ptr::null_mut()) } != 0 {
        return HashMap::new();
    }
    let mut result = HashMap::new();
    for path in paths.iter().take(path_count as usize) {
        let mut source = DISPLAYCONFIG_SOURCE_DEVICE_NAME::default();
        source.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        source.header.size = std::mem::size_of::<DISPLAYCONFIG_SOURCE_DEVICE_NAME>() as u32;
        source.header.adapterId = path.sourceInfo.adapterId;
        source.header.id = path.sourceInfo.id;
        if unsafe { DisplayConfigGetDeviceInfo(&mut source.header) } != 0 { continue; }
        let name = utf16_z(&source.viewGdiDeviceName);
        if name.is_empty() { continue; }
        let mut color = DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO::default();
        color.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
        color.header.size = std::mem::size_of::<DISPLAYCONFIG_GET_ADVANCED_COLOR_INFO>() as u32;
        color.header.adapterId = path.targetInfo.adapterId;
        color.header.id = path.targetInfo.id;
        // advancedColorEnabled is bit 1 of the advanced-color flags.
        let hdr = unsafe { DisplayConfigGetDeviceInfo(&mut color.header) } == 0
            && (unsafe { color.Anonymous.value } & 2) != 0;
        result.insert(name.to_lowercase(), hdr);
    }
    result
}

#[cfg(windows)]
unsafe extern "system" fn monitor_callback(monitor: windows_sys::Win32::Graphics::Gdi::HMONITOR,
    _hdc: windows_sys::Win32::Graphics::Gdi::HDC, _rect: *mut windows_sys::Win32::Foundation::RECT,
    lparam: windows_sys::Win32::Foundation::LPARAM) -> windows_sys::core::BOOL {
    use windows_sys::Win32::Graphics::Gdi::{GetMonitorInfoW, MONITORINFOEXW};
    let displays = &mut *(lparam as *mut Vec<Value>);
    let mut info: MONITORINFOEXW = std::mem::zeroed();
    info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if GetMonitorInfoW(monitor, &mut info.monitorInfo) == 0 { return 1; }
    let id = utf16_z(&info.szDevice).trim().to_owned();
    let width = info.monitorInfo.rcMonitor.right - info.monitorInfo.rcMonitor.left;
    let height = info.monitorInfo.rcMonitor.bottom - info.monitorInfo.rcMonitor.top;
    if id.is_empty() || width <= 1 || height <= 1 { return 1; }
    let label = format!("{id} {width}x{height}");
    displays.push(json!({
        "id": id,
        "label": label,
        "handle": monitor as usize as u32,
        "x": info.monitorInfo.rcMonitor.left,
        "y": info.monitorInfo.rcMonitor.top,
        "width": width,
        "height": height,
        "primary": (info.monitorInfo.dwFlags & 1) != 0,
    }));
    1
}

#[cfg(windows)]
fn process_identity(pid: u32) -> (String, String) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    if pid == 0 { return (String::new(), String::new()); }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() { return (String::new(), String::new()); }
    let mut buffer = vec![0u16; 32768];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) };
    unsafe { CloseHandle(handle); }
    if ok == 0 { return (String::new(), String::new()); }
    let path = utf16_len(&buffer[..size as usize]);
    let name = std::path::Path::new(&path).file_stem().and_then(|stem| stem.to_str())
        .map(|stem| format!("{stem}.exe")).unwrap_or_default();
    (name, path)
}

#[cfg(windows)]
unsafe extern "system" fn window_callback(hwnd: windows_sys::Win32::Foundation::HWND,
    lparam: windows_sys::Win32::Foundation::LPARAM) -> windows_sys::core::BOOL {
    use base64::Engine;
    use windows_sys::Win32::Foundation::{POINT, RECT};
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetClassNameW, GetClientRect,
        GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow, IsWindowVisible};
    let windows = &mut *(lparam as *mut Vec<Value>);
    if IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 { return 1; }
    let length = GetWindowTextLengthW(hwnd);
    let mut title = String::new();
    if length > 0 {
        let mut buffer = vec![0u16; (length + 1) as usize];
        if GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) > 0 {
            title = utf16_z(&buffer);
        }
    }
    let mut rect: RECT = std::mem::zeroed();
    if GetWindowRect(hwnd, &mut rect) == 0 {
        let mut client: RECT = std::mem::zeroed();
        let mut origin = POINT { x: 0, y: 0 };
        if GetClientRect(hwnd, &mut client) == 0 || ClientToScreen(hwnd, &mut origin) == 0 { return 1; }
        rect = RECT { left: origin.x, top: origin.y,
            right: origin.x + (client.right - client.left), bottom: origin.y + (client.bottom - client.top) };
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    let (process_name, executable_path) = process_identity(pid);
    if title.trim().is_empty() { title = process_name.clone(); }
    if width <= 1 || height <= 1 || title.trim().is_empty() { return 1; }
    let mut class_buffer = [0u16; 256];
    let class_length = GetClassNameW(hwnd, class_buffer.as_mut_ptr(), class_buffer.len() as i32);
    let window_class = if class_length > 0 {
        utf16_len(&class_buffer[..class_length as usize]).trim().to_owned()
    } else { String::new() };
    let title = title.trim();
    windows.push(json!({
        "handle": hwnd as usize as u32,
        "title": title,
        "titleBase64": base64::engine::general_purpose::STANDARD.encode(title.as_bytes()),
        "processName": process_name,
        "executablePath": executable_path,
        "windowClass": window_class,
        "x": rect.left,
        "y": rect.top,
        "width": width,
        "height": height,
    }));
    1
}

#[cfg(windows)]
pub fn capture_targets() -> Result<Value, String> {
    use windows_sys::Win32::Foundation::LPARAM;
    use windows_sys::Win32::Graphics::Gdi::EnumDisplayMonitors;
    use windows_sys::Win32::UI::WindowsAndMessaging::EnumWindows;
    let hdr = hdr_by_gdi_name();
    let mut displays: Vec<Value> = Vec::new();
    unsafe { EnumDisplayMonitors(std::ptr::null_mut(), std::ptr::null(), Some(monitor_callback),
        &mut displays as *mut _ as LPARAM); }
    for display in &mut displays {
        let enabled = display.get("id").and_then(Value::as_str)
            .and_then(|name| hdr.get(&name.to_lowercase())).copied().unwrap_or(false);
        if let Some(object) = display.as_object_mut() { object.insert("hdr".into(), json!(enabled)); }
    }
    let mut windows: Vec<Value> = Vec::new();
    unsafe { EnumWindows(Some(window_callback), &mut windows as *mut _ as LPARAM); }
    Ok(json!({"displays": displays, "windows": windows}))
}

#[cfg(not(windows))]
pub fn capture_targets() -> Result<Value, String> { Ok(json!({"displays": [], "windows": []})) }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_targets_returns_normalized_arrays() {
        let value = capture_targets().unwrap();
        for display in value["displays"].as_array().unwrap() {
            assert!(display["id"].as_str().is_some_and(|id| !id.is_empty()));
            assert!(display["width"].as_i64().unwrap() > 1);
            assert!(display["height"].as_i64().unwrap() > 1);
            assert!(display["hdr"].is_boolean());
        }
        for window in value["windows"].as_array().unwrap() {
            assert!(window["handle"].as_u64().is_some());
            assert!(window["titleBase64"].as_str().is_some());
            assert!(window["width"].as_i64().unwrap() > 1);
            assert!(window["height"].as_i64().unwrap() > 1);
        }
    }
}
