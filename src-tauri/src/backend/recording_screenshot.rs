//! Native recording screenshots. Display capture uses GDI screen BitBlt;
//! window capture uses PrintWindow with a window-DC fallback. The PNG encoder is
//! the bundled FFmpeg so no extra image codec is shipped.
use super::{
    native_store::NativeStore,
    recording_contract::normalize_recording_capture_target,
    recording_ffmpeg::{run, runtime_executable},
};
use serde_json::Value;
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

pub fn screenshot_file_name(sample: f64) -> String {
    let value = if sample.is_finite() { sample.clamp(0.0, 0.999999999) } else { rand::random::<f64>() };
    format!("Arc Screenshot {}.png", 100 + (value * 900.0).floor() as u32)
}

pub fn collision_safe_screenshot_path(root: &Path, mut exists: impl FnMut(&Path) -> bool) -> Result<PathBuf, String> {
    for _ in 0..900 {
        let candidate = root.join(screenshot_file_name(rand::random::<f64>()));
        if !exists(&candidate) { return Ok(candidate); }
    }
    Err("Could not allocate a unique screenshot filename".into())
}

struct Capture {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

#[cfg(windows)]
fn capture_display(target: &Value) -> Result<Capture, String> {
    use std::ffi::c_void;
    use windows_sys::Win32::{
        Foundation::HWND,
        Graphics::Gdi::{
            BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
            SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
        },
    };
    let targets = super::capture_targets::capture_targets()?;
    let displays = targets.get("displays").and_then(Value::as_array).cloned().unwrap_or_default();
    let display_id = target.get("displayId").and_then(Value::as_str).unwrap_or("primary");
    let display = if display_id == "primary" {
        displays.iter().find(|display| display["primary"].as_bool() == Some(true)).or_else(|| displays.first())
    } else {
        displays.iter().find(|display| display["id"].as_str() == Some(display_id))
    }.ok_or("The selected display is no longer available.")?;
    let width = display["width"].as_u64().unwrap_or(0) as u32;
    let height = display["height"].as_u64().unwrap_or(0) as u32;
    let x = display["x"].as_i64().unwrap_or(0) as i32;
    let y = display["y"].as_i64().unwrap_or(0) as i32;
    if width <= 1 || height <= 1 { return Err("The selected display is no longer available.".into()); }
    let screen = unsafe { GetDC(std::ptr::null_mut()) };
    if screen.is_null() { return Err("Desktop capture is unavailable.".into()); }
    let memory = unsafe { CreateCompatibleDC(screen) };
    if memory.is_null() { unsafe { ReleaseDC(std::ptr::null_mut(), screen); } return Err("Desktop capture is unavailable.".into()); }
    let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = width as i32;
    info.bmiHeader.biHeight = -(height as i32);
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    info.bmiHeader.biSizeImage = width * height * 4;
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bitmap = unsafe { CreateDIBSection(memory, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0) };
    if bitmap.is_null() || bits.is_null() {
        unsafe { DeleteDC(memory); ReleaseDC(std::ptr::null_mut(), screen); }
        return Err("Desktop capture is unavailable.".into());
    }
    let previous = unsafe { SelectObject(memory, bitmap) };
    let captured = unsafe { BitBlt(memory, 0, 0, width as i32, height as i32, screen, x, y, SRCCOPY | CAPTUREBLT) } != 0;
    let mut bgra = vec![0u8; (width * height * 4) as usize];
    if captured { unsafe { std::ptr::copy_nonoverlapping(bits as *const u8, bgra.as_mut_ptr(), bgra.len()); } }
    unsafe {
        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(std::ptr::null_mut() as HWND, screen);
    }
    if !captured { return Err("Desktop capture returned no image.".into()); }
    for pixel in bgra.chunks_exact_mut(4) { pixel[3] = 255; }
    Ok(Capture { width, height, bgra })
}

fn value_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().filter(|value| value.is_finite() && *value >= 0.0 && *value <= u32::MAX as f64).map(|value| value as u64))
}

#[cfg(windows)]
fn capture_window(target: &Value) -> Result<Capture, String> {
    use std::ffi::c_void;
    use windows_sys::Win32::{
        Foundation::{HWND, RECT},
        Graphics::Gdi::{
            BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetWindowDC,
            ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
            SRCCOPY,
        },
        Storage::Xps::PrintWindow,
        UI::WindowsAndMessaging::{GetWindowRect, IsWindow, PW_RENDERFULLCONTENT},
    };
    let handle = target.get("windowHandle").and_then(value_u64).unwrap_or(0);
    if handle == 0 || handle > u32::MAX as u64 { return Err("The selected window is no longer available.".into()); }
    let hwnd = handle as u32 as HWND;
    let is_window = unsafe { IsWindow(hwnd) };
    let mut rect: RECT = unsafe { std::mem::zeroed() };
    let got_rect = unsafe { GetWindowRect(hwnd, &mut rect) };
    if is_window == 0 { return Err("The selected window is no longer available.".into()); }
    if got_rect == 0 { return Err("The selected window is no longer available.".into()); }
    let width = (rect.right - rect.left).max(0) as u32;
    let height = (rect.bottom - rect.top).max(0) as u32;
    if width <= 1 || height <= 1 { return Err("The selected window is no longer available.".into()); }
    let window_dc = unsafe { GetWindowDC(hwnd) };
    if window_dc.is_null() { return Err("The selected window is no longer available.".into()); }
    let memory = unsafe { CreateCompatibleDC(window_dc) };
    if memory.is_null() { unsafe { ReleaseDC(hwnd, window_dc); } return Err("Desktop capture is unavailable.".into()); }
    let mut info: BITMAPINFO = unsafe { std::mem::zeroed() };
    info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
    info.bmiHeader.biWidth = width as i32;
    info.bmiHeader.biHeight = -(height as i32);
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    info.bmiHeader.biSizeImage = width * height * 4;
    let mut bits: *mut c_void = std::ptr::null_mut();
    let bitmap = unsafe { CreateDIBSection(memory, &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0) };
    if bitmap.is_null() || bits.is_null() {
        unsafe { DeleteDC(memory); ReleaseDC(hwnd, window_dc); }
        return Err("Desktop capture is unavailable.".into());
    }
    let previous = unsafe { SelectObject(memory, bitmap) };
    let mut captured = unsafe { PrintWindow(hwnd, memory, PW_RENDERFULLCONTENT) } != 0;
    let mut bgra = vec![0u8; (width * height * 4) as usize];
    if captured { unsafe { std::ptr::copy_nonoverlapping(bits as *const u8, bgra.as_mut_ptr(), bgra.len()); } }
    let blank = bgra.chunks_exact(4).all(|pixel| pixel[0] == 0 && pixel[1] == 0 && pixel[2] == 0);
    if !captured || blank {
        captured = unsafe { BitBlt(memory, 0, 0, width as i32, height as i32, window_dc, 0, 0, SRCCOPY | CAPTUREBLT) } != 0;
        if captured { unsafe { std::ptr::copy_nonoverlapping(bits as *const u8, bgra.as_mut_ptr(), bgra.len()); } }
    }
    unsafe {
        SelectObject(memory, previous);
        DeleteObject(bitmap);
        DeleteDC(memory);
        ReleaseDC(hwnd, window_dc);
    }
    if !captured { return Err("The selected window returned no image.".into()); }
    for pixel in bgra.chunks_exact_mut(4) { pixel[3] = 255; }
    Ok(Capture { width, height, bgra })
}

#[cfg(not(windows))]
fn capture_display(_target: &Value) -> Result<Capture, String> { Err("Desktop capture is only available on Windows".into()) }
#[cfg(not(windows))]
fn capture_window(_target: &Value) -> Result<Capture, String> { Err("Desktop capture is only available on Windows".into()) }

fn bmp_bytes(capture: &Capture) -> Vec<u8> {
    let image_size = capture.bgra.len() as u32;
    let file_size = 54 + image_size;
    let mut bytes = Vec::with_capacity(file_size as usize);
    bytes.extend_from_slice(b"BM");
    bytes.extend_from_slice(&file_size.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&54u32.to_le_bytes());
    bytes.extend_from_slice(&40u32.to_le_bytes());
    bytes.extend_from_slice(&(capture.width as i32).to_le_bytes());
    bytes.extend_from_slice(&(-(capture.height as i32)).to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&32u16.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&image_size.to_le_bytes());
    bytes.extend_from_slice(&2835i32.to_le_bytes());
    bytes.extend_from_slice(&2835i32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&0u32.to_le_bytes());
    bytes.extend_from_slice(&capture.bgra);
    bytes
}

/// Capture the selected display/window into a PNG under the recording root.
pub fn capture_screenshot(store: &NativeStore, target: Option<&Value>, output: &Path) -> Result<PathBuf, String> {
    let target = normalize_recording_capture_target(target);
    let capture = if target["type"] == "window" { capture_window(&target)? } else { capture_display(&target)? };
    std::fs::create_dir_all(output.parent().unwrap_or_else(|| Path::new("."))).map_err(|error| error.to_string())?;
    let mut reservation = OpenOptions::new().write(true).create_new(true).open(output).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists { "Screenshot output already exists".to_owned() } else { error.to_string() }
    })?;
    reservation.flush().ok();
    drop(reservation);
    let token = rand::random::<u64>();
    let bmp = output.with_file_name(format!("{}.arc-shot-{token}.bmp", output.file_name().map(|value| value.to_string_lossy()).unwrap_or_default()));
    let result = (|| -> Result<(), String> {
        std::fs::write(&bmp, bmp_bytes(&capture)).map_err(|error| error.to_string())?;
        let ffmpeg = runtime_executable(store, "ffmpeg.exe").ok_or("Bundled FFmpeg is unavailable")?;
        let args = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(),
            "-i".into(), bmp.to_string_lossy().into_owned(),
            "-frames:v".into(), "1".into(), "-y".into(), output.to_string_lossy().into_owned()];
        let run = run(&ffmpeg, &args, Duration::from_secs(30), None, None);
        if !run.ok { return Err("Screenshot PNG encoding failed".into()); }
        let metadata = std::fs::metadata(output).map_err(|_| "Screenshot PNG encoding failed")?;
        if !metadata.is_file() || metadata.len() == 0 { return Err("Screenshot PNG encoding failed".into()); }
        Ok(())
    })();
    let _ = std::fs::remove_file(&bmp);
    if result.is_err() { let _ = std::fs::remove_file(output); }
    result.map(|_| output.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn screenshot_names_and_bmp_header_are_bounded() {
        assert_eq!(screenshot_file_name(0.0), "Arc Screenshot 100.png");
        assert_eq!(screenshot_file_name(0.999999), "Arc Screenshot 999.png");
        let capture = Capture { width: 2, height: 1, bgra: vec![1, 2, 3, 255, 4, 5, 6, 255] };
        let bytes = bmp_bytes(&capture);
        assert_eq!(&bytes[..2], b"BM");
        assert_eq!(bytes.len(), 54 + 8);
        assert_eq!(i32::from_le_bytes(bytes[18..22].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(bytes[22..26].try_into().unwrap()), -1);
    }

    #[test]
    fn screenshot_collision_allocator_is_bounded() {
        let root = Path::new("C:\\Videos");
        let mut calls = 0;
        let path = collision_safe_screenshot_path(root, |_| { calls += 1; calls <= 3 }).unwrap();
        assert!(path.to_string_lossy().ends_with(".png"));
        assert_eq!(calls, 4);
        assert_eq!(value_u64(&json!(123.0)), Some(123));
        assert_eq!(value_u64(&json!(-1.0)), None);
    }

    #[test]
    #[ignore = "live desktop screenshot check"]
    fn live_display_screenshot_is_a_valid_png() {
        let root = std::env::temp_dir().join(format!("arc-shot-test-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let store = NativeStore::new(root.clone(), "advanced").unwrap();
        let output = root.join("shot.png");
        capture_screenshot(&store, Some(&json!({"type":"display","displayId":"primary"})), &output).unwrap();
        let bytes = std::fs::read(&output).unwrap();
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "live window screenshot check; set ARC_SHOT_HWND"]
    fn live_window_screenshot_is_a_valid_png() {
        let handle: u64 = std::env::var("ARC_SHOT_HWND").expect("ARC_SHOT_HWND").parse().expect("numeric hwnd");
        let root = std::env::temp_dir().join(format!("arc-window-shot-test-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let store = NativeStore::new(root.clone(), "advanced").unwrap();
        let output = root.join("window.png");
        capture_screenshot(&store, Some(&json!({"type":"window","windowHandle":handle})), &output).unwrap();
        let bytes = std::fs::read(&output).unwrap();
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
