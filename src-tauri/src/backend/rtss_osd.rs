//! Native RTSS SharedMemoryV2 OSD publisher. Writes Arc Power's Classic
//! telemetry text, reads the foreground application's RTSS FPS/frametime, and
//! owns the OSD slot lifecycle. No Koffi or Electron process is required.
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashSet},
    ffi::c_void,
    path::PathBuf,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
    time::SystemTime,
};

const MAPPING_NAME: &str = "RTSSSharedMemoryV2";
const FILE_MAP_ALL_ACCESS: u32 = 0x000F001F;
const SIGNATURE: u32 = 0x52545353;
const MIN_VERSION: u32 = 0x00020000;
const EXT_VERSION: u32 = 0x00020007;
const BUSY_VERSION: u32 = 0x0002000E;
const FRAME_TIME_VERSION: u32 = 0x00020005;
const BUFFER_VERSION: u32 = 0x0002000C;
const API_FLAGS_VERSION: u32 = 0x0002000A;
const GRAPH_SIGNATURE: u32 = 0x47523030;
const OWNER: &[u8] = b"ArcPower";
const HEADER: Header = Header { signature: 0, version: 4, app_entry_size: 8, app_arr_offset: 12, app_arr_size: 16, osd_entry_size: 20, osd_arr_offset: 24, osd_arr_size: 28, frame: 32, busy: 36 };
const ENTRY_TEXT: usize = 0;
const ENTRY_OWNER: usize = 256;
const ENTRY_EX: usize = 512;
const ENTRY_BUFFER: usize = 4608;
const ENTRY_MIN: usize = 512;
const EX_SIZE: usize = 4096;
const BUFFER_SIZE: usize = 262144;
const MAX_TEXT: usize = 4095;
const MAX_MAPPING_BYTES: usize = 64 * 1024 * 1024;
const APP_PROCESS_ID: usize = 0;
const APP_FLAGS: usize = 264;
const APP_TIME0: usize = 268;
const APP_TIME1: usize = 272;
const APP_FRAMES: usize = 276;
const APP_FRAME_TIME_US: usize = 280;
const APP_AVG_FPS: usize = 308;
const APP_FRAME_TIME_COUNT: usize = 920;
const APP_FRAME_TIME_BUFFER: usize = 924;
const APP_FRAME_TIME_CAPACITY: usize = 1024;

const DEFAULT_STATS: &[&str] = &["cpu-util", "cpu-temp", "cpu-power", "memory-util", "gpu-util", "gpu-temp", "gpu-power", "gpu-vram", "fps", "api", "frametime"];

struct Header {
    signature: usize, version: usize, app_entry_size: usize, app_arr_offset: usize, app_arr_size: usize,
    osd_entry_size: usize, osd_arr_offset: usize, osd_arr_size: usize, frame: usize, busy: usize,
}

struct FpsStats {
    fps: Option<f64>,
    avg: Option<f64>,
    low1: Option<f64>,
    low01: Option<f64>,
    p99: Option<f64>,
    frame_time: Option<f64>,
    api: Option<String>,
}

impl Default for FpsStats {
    fn default() -> Self {
        Self { fps: None, avg: None, low1: None, low01: None, p99: None, frame_time: None, api: None }
    }
}

fn frame_stats(times: &mut Vec<f64>) -> FpsStats {
    times.retain(|value| value.is_finite() && *value > 0.0 && *value <= 60_000_000.0);
    if times.is_empty() { return FpsStats::default(); }
    times.sort_by(|left, right| left.total_cmp(right));
    let mean = times.iter().sum::<f64>() / times.len() as f64;
    let avg = 1_000_000.0 / mean;
    if times.len() < 60 { return FpsStats { avg: Some(avg), ..FpsStats::default() }; }
    let p99_index = ((times.len() as f64 * 0.99).ceil() as usize).max(1) - 1;
    let p99_index = p99_index.min(times.len() - 1);
    let p99 = 1_000_000.0 / times[p99_index];
    let tail = &times[p99_index..];
    let low1 = 1_000_000.0 / (tail.iter().sum::<f64>() / tail.len() as f64);
    let low01 = if times.len() >= 300 {
        let index = ((times.len() as f64 * 0.999).ceil() as usize).max(1) - 1;
        let index = index.min(times.len() - 1);
        let tail = &times[index..];
        Some(1_000_000.0 / (tail.iter().sum::<f64>() / tail.len() as f64))
    } else { None };
    FpsStats { fps: None, avg: Some(avg), low1: Some(low1), low01, p99: Some(p99), frame_time: None, api: None }
}

struct Mapping {
    handle: *mut c_void,
    view: *mut u8,
    length: usize,
    version: u32,
    entry_size: usize,
    entry_offset: usize,
    count: usize,
    slot: Option<usize>,
}

unsafe impl Send for Mapping {}

impl Drop for Mapping {
    fn drop(&mut self) {
        if !self.view.is_null() { unsafe { windows_sys::Win32::System::Memory::UnmapViewOfFile(windows_sys::Win32::System::Memory::MEMORY_MAPPED_VIEW_ADDRESS { Value: self.view as *mut c_void }); } }
        if !self.handle.is_null() { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.handle); } }
        self.view = std::ptr::null_mut();
        self.handle = std::ptr::null_mut();
    }
}

impl Mapping {
    fn open() -> Option<Self> {
        use windows_sys::Win32::System::Memory::{MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualQuery, MEMORY_BASIC_INFORMATION, MEMORY_MAPPED_VIEW_ADDRESS};
        let name: Vec<u16> = MAPPING_NAME.encode_utf16().chain(std::iter::once(0)).collect();
        let handle = unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS, 0, name.as_ptr()) };
        if handle.is_null() { return None; }
        let mapped = unsafe { MapViewOfFile(handle, FILE_MAP_ALL_ACCESS, 0, 0, 0) };
        let view = mapped.Value as *mut u8;
        if view.is_null() { unsafe { windows_sys::Win32::Foundation::CloseHandle(handle); } return None; }
        let mut info: MEMORY_BASIC_INFORMATION = unsafe { std::mem::zeroed() };
        let queried = unsafe { VirtualQuery(view as *const c_void, &mut info, std::mem::size_of::<MEMORY_BASIC_INFORMATION>()) };
        if queried == 0 { unsafe { UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: view as *mut c_void }); windows_sys::Win32::Foundation::CloseHandle(handle); } return None; }
        let length = info.RegionSize;
        if length < 40 || length > MAX_MAPPING_BYTES { unsafe { UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: view as *mut c_void }); windows_sys::Win32::Foundation::CloseHandle(handle); } return None; }
        let mut mapping = Self { handle, view, length, version: 0, entry_size: 0, entry_offset: 0, count: 0, slot: None };
        let signature = mapping.read_u32(HEADER.signature)?;
        let version = mapping.read_u32(HEADER.version)?;
        let entry_size = mapping.read_u32(HEADER.osd_entry_size)? as usize;
        let entry_offset = mapping.read_u32(HEADER.osd_arr_offset)? as usize;
        let count = mapping.read_u32(HEADER.osd_arr_size)? as usize;
        let end = entry_offset.checked_add(entry_size.checked_mul(count)?)?;
        if signature != SIGNATURE || version < MIN_VERSION || entry_size < ENTRY_MIN || entry_size > 1024 * 1024
            || entry_offset < 40 || count < 2 || count > 256 || end > MAX_MAPPING_BYTES || end > length {
            return None;
        }
        if version >= EXT_VERSION && entry_size < ENTRY_EX + EX_SIZE { return None; }
        mapping.version = version;
        mapping.entry_size = entry_size;
        mapping.entry_offset = entry_offset;
        mapping.count = count;
        Some(mapping)
    }

    fn read_u32(&self, offset: usize) -> Option<u32> {
        if offset + 4 > self.length { return None; }
        Some(unsafe { std::ptr::read_unaligned(self.view.add(offset) as *const u32) })
    }
    fn write_u32(&self, offset: usize, value: u32) -> Option<()> {
        if offset + 4 > self.length { return None; }
        unsafe { std::ptr::write_unaligned(self.view.add(offset) as *mut u32, value); }
        Some(())
    }
    fn read_byte(&self, offset: usize) -> Option<u8> {
        if offset >= self.length { return None; }
        Some(unsafe { *self.view.add(offset) })
    }
    fn write_bytes(&self, offset: usize, bytes: &[u8]) -> Option<()> {
        if offset.checked_add(bytes.len())? > self.length { return None; }
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.view.add(offset), bytes.len()); }
        Some(())
    }
    fn zero(&self, offset: usize, size: usize) -> Option<()> {
        if offset.checked_add(size)? > self.length { return None; }
        unsafe { std::ptr::write_bytes(self.view.add(offset), 0, size); }
        Some(())
    }
    fn read_text(&self, offset: usize, size: usize) -> String {
        let mut bytes = Vec::new();
        for index in 0..size {
            match self.read_byte(offset + index) { Some(0) | None => break, Some(byte) => bytes.push(byte) }
        }
        String::from_utf8_lossy(&bytes).into_owned()
    }
    fn busy(&self) -> Option<&AtomicU32> {
        if self.version < BUSY_VERSION { return None; }
        if HEADER.busy + 4 > self.length { return None; }
        Some(unsafe { &*(self.view.add(HEADER.busy) as *const AtomicU32) })
    }
    fn acquire_busy(&self) -> bool {
        let Some(busy) = self.busy() else { return true; };
        for _ in 0..8 {
            let current = busy.load(Ordering::SeqCst);
            if current & 1 != 0 { return false; }
            if busy.compare_exchange(current, current | 1, Ordering::SeqCst, Ordering::SeqCst).is_ok() { return true; }
        }
        false
    }
    fn release_busy(&self) {
        if let Some(busy) = self.busy() {
            for _ in 0..8 {
                let current = busy.load(Ordering::SeqCst);
                if current & 1 == 0 { return; }
                if busy.compare_exchange(current, current & !1, Ordering::SeqCst, Ordering::SeqCst).is_ok() { return; }
            }
        }
    }
    fn claim_slot(&mut self) -> Option<()> {
        for pass in 0..2 {
            for index in 1..self.count {
                let base = self.entry_offset + index * self.entry_size;
                if base + ENTRY_MIN > self.length { continue; }
                let owner = self.read_text(base + ENTRY_OWNER, 256);
                if if pass == 0 { owner != "ArcPower" } else { !owner.is_empty() } { continue; }
                let lock = self.acquire_busy();
                if self.version >= BUSY_VERSION && !lock { continue; }
                let current = self.read_text(base + ENTRY_OWNER, 256);
                let claimable = if pass == 0 { current == "ArcPower" } else { current.is_empty() };
                if claimable {
                    if pass == 1 { self.write_bytes(base + ENTRY_OWNER, OWNER); self.zero(base + ENTRY_OWNER + OWNER.len(), 256usize.saturating_sub(OWNER.len())); }
                    if self.version >= BUSY_VERSION { self.release_busy(); }
                    self.slot = Some(index);
                    return Some(());
                }
                if self.version >= BUSY_VERSION { self.release_busy(); }
            }
        }
        None
    }
    fn text_span(&self) -> (usize, usize) {
        if self.version >= EXT_VERSION { (ENTRY_EX, EX_SIZE) } else { (ENTRY_TEXT, 256) }
    }
    fn write_text(&mut self, text: &str) -> Option<()> {
        let slot = self.slot?;
        let base = self.entry_offset + slot * self.entry_size;
        let (offset, size) = self.text_span();
        let ansi = ansi_bytes(text);
        let lock = self.version >= BUSY_VERSION;
        if lock && !self.acquire_busy() { return None; }
        self.zero(base + offset, size)?;
        let count = ansi.len().min(size.saturating_sub(1));
        self.write_bytes(base + offset, &ansi[..count])?;
        let frame = self.read_u32(HEADER.frame)?;
        self.write_u32(HEADER.frame, frame.wrapping_add(1))?;
        if lock { self.release_busy(); }
        Some(())
    }

    fn graph_supported(&self) -> bool {
        self.version >= BUFFER_VERSION && self.entry_size >= ENTRY_BUFFER + BUFFER_SIZE
    }

    fn write_graph(&mut self, graph: &[u8]) -> Option<()> {
        let slot = self.slot?;
        if !self.graph_supported() { return None; }
        let base = self.entry_offset + slot * self.entry_size;
        let lock = self.version >= BUSY_VERSION;
        if lock && !self.acquire_busy() { return None; }
        self.zero(base + ENTRY_BUFFER, BUFFER_SIZE)?;
        self.write_bytes(base + ENTRY_BUFFER, graph)?;
        if lock { self.release_busy(); }
        Some(())
    }
    fn clear(&mut self) {
        let Some(slot) = self.slot else { return; };
        let base = self.entry_offset + slot * self.entry_size;
        let lock = self.version >= BUSY_VERSION;
        if lock && !self.acquire_busy() { return; }
        let (offset, size) = self.text_span();
        let _ = self.zero(base + offset, size);
        let _ = self.zero(base + ENTRY_OWNER, 256);
        if lock { self.release_busy(); }
        self.slot = None;
    }

    fn foreground_pid(&self) -> Option<u32> {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        let hwnd = unsafe { GetForegroundWindow() };
        if hwnd.is_null() { return None; }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(hwnd, &mut pid); }
        (pid != 0).then_some(pid)
    }

    fn foreground_fps(&self) -> FpsStats {
        let Some(pid) = self.foreground_pid() else { return FpsStats::default(); };
        self.foreground_fps_for_pid(pid)
    }

    fn foreground_fps_for_pid(&self, pid: u32) -> FpsStats {
        let app_entry_size = self.read_u32(HEADER.app_entry_size).unwrap_or(0) as usize;
        let app_offset = self.read_u32(HEADER.app_arr_offset).unwrap_or(0) as usize;
        let app_count = self.read_u32(HEADER.app_arr_size).unwrap_or(0) as usize;
        if app_entry_size < 284 || app_entry_size > 64 * 1024 || app_offset < 40 || app_count == 0 || app_count > 256 { return FpsStats::default(); }
        for index in 0..app_count {
            let base = app_offset + index * app_entry_size;
            if base + 284 > self.length { continue; }
            if self.read_u32(base + APP_PROCESS_ID) != Some(pid) { continue; }
            let time0 = self.read_u32(base + APP_TIME0).unwrap_or(0) as f64;
            let time1 = self.read_u32(base + APP_TIME1).unwrap_or(0) as f64;
            let frames = self.read_u32(base + APP_FRAMES).unwrap_or(0) as f64;
            let frame_us = self.read_u32(base + APP_FRAME_TIME_US).unwrap_or(0) as f64;
            let interval = if time1 > time0 && frames > 0.0 { (frames * 1000.0) / (time1 - time0) } else { 0.0 };
            let instant = if frame_us > 0.0 { 1_000_000.0 / frame_us } else { 0.0 };
            let fps = if interval > 0.0 { interval } else { instant };
            let fps = (fps > 0.0 && fps <= 100_000.0).then_some(fps);
            let frame_time = if frame_us > 0.0 { Some(frame_us / 1000.0) } else { fps.map(|fps| 1000.0 / fps) };
            let mut times = Vec::new();
            if self.version >= FRAME_TIME_VERSION && app_entry_size >= APP_FRAME_TIME_BUFFER + APP_FRAME_TIME_CAPACITY * 4 {
                let count = (self.read_u32(base + APP_FRAME_TIME_COUNT).unwrap_or(0) as usize).min(APP_FRAME_TIME_CAPACITY);
                for point in 0..count {
                    if let Some(value) = self.read_u32(base + APP_FRAME_TIME_BUFFER + point * 4) {
                        if value > 0 && value <= 60_000_000 { times.push(f64::from(value)); }
                    }
                }
            }
            let mut stats = frame_stats(&mut times);
            if stats.avg.is_none() && app_entry_size >= APP_AVG_FPS + 4 {
                stats.avg = self.read_u32(base + APP_AVG_FPS).filter(|value| *value > 0).map(f64::from);
            }
            stats.fps = fps;
            stats.frame_time = frame_time;
            stats.api = self.api_name(base);
            return stats;
        }
        FpsStats::default()
    }

    fn api_name(&self, base: usize) -> Option<String> {
        if self.version < API_FLAGS_VERSION { return None; }
        let flags = self.read_u32(base + APP_FLAGS)?;
        api_label(flags).map(str::to_owned)
    }
}

fn api_label(flags: u32) -> Option<&'static str> {
    match flags & 0xFFFF {
        0x0001 => Some("OGL"),
        0x0002 | 0x0003 => Some("OTHER"),
        0x0004 | 0x0005 => Some("DX9"),
        0x0006 => Some("DX10"),
        0x0007 => Some("DX11"),
        0x0008 | 0x0009 => Some("DX12"),
        0x000A => Some("VULKAN"),
        _ => None,
    }
}

fn ansi_bytes(text: &str) -> Vec<u8> {
    use windows_sys::Win32::Globalization::WideCharToMultiByte;
    let wide: Vec<u16> = text.encode_utf16().collect();
    if wide.is_empty() { return Vec::new(); }
    let required = unsafe { WideCharToMultiByte(0, 0, wide.as_ptr(), wide.len() as i32, std::ptr::null_mut(), 0, std::ptr::null(), std::ptr::null_mut()) };
    if required <= 0 { return text.chars().filter(|c| c.is_ascii()).map(|c| c as u8).collect(); }
    let mut buffer = vec![0u8; required as usize];
    let written = unsafe { WideCharToMultiByte(0, 0, wide.as_ptr(), wide.len() as i32, buffer.as_mut_ptr(), buffer.len() as i32, std::ptr::null(), std::ptr::null_mut()) };
    if written <= 0 { return Vec::new(); }
    buffer.truncate(written as usize);
    buffer
}

#[derive(Clone)]
struct Settings {
    enabled: bool,
    renderer: String,
    position: String,
    scale: f64,
    label_color: String,
    value_color: String,
    temperature_unit: String,
    stats: HashSet<String>,
    monitored_keys: Option<HashSet<String>>,
    hotkey_registered: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false, renderer: "rtss".into(), position: "top-left".into(), scale: 1.0,
            label_color: "#FFFFFF".into(), value_color: "#FFFFFF".into(), temperature_unit: "C".into(),
            stats: DEFAULT_STATS.iter().map(|value| (*value).to_owned()).collect(), monitored_keys: None, hotkey_registered: true,
        }
    }
}

fn settings_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from).map(|root| root.join("ArcPower").join("settings.json"))
}

fn load_settings() -> Settings {
    let Some(path) = settings_path() else { return Settings::default(); };
    let Ok(text) = std::fs::read_to_string(path) else { return Settings::default(); };
    let Ok(value) = serde_json::from_str::<Value>(text.trim_start_matches('\u{feff}')) else { return Settings::default(); };
    settings_from_value(&value)
}

fn settings_from_value(value: &Value) -> Settings {
    let color = |key: &str, fallback: &str| value.get(key).and_then(Value::as_str)
        .filter(|value| value.len() == 7 && value.starts_with('#') && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit()))
        .map(|value| value.to_ascii_uppercase()).unwrap_or_else(|| fallback.to_owned());
    let stats = match value.get("overlayStats").and_then(Value::as_array) {
        Some(items) => items.iter().filter_map(Value::as_str).map(str::to_owned).collect(),
        None => DEFAULT_STATS.iter().map(|value| (*value).to_owned()).collect(),
    };
    let hotkey = value.get("overlayHotkeyLetter").and_then(Value::as_str).unwrap_or("O");
    Settings {
        enabled: value.get("overlayEnabled").and_then(Value::as_bool) == Some(true),
        renderer: value.get("overlayRenderer").and_then(Value::as_str).unwrap_or("rtss").to_owned(),
        position: value.get("overlayPosition").and_then(Value::as_str).unwrap_or("top-left").to_owned(),
        scale: value.get("overlayScale").and_then(Value::as_f64).unwrap_or(1.0),
        label_color: color("overlayLabelColor", &color("overlayColor", "#FFFFFF")),
        value_color: color("overlayValueColor", &color("overlayColor", "#FFFFFF")),
        temperature_unit: value.get("overlayTemperatureUnit").and_then(Value::as_str).unwrap_or("C").to_owned(),
        stats,
        monitored_keys: value.get("overlayDeviceKeys").and_then(Value::as_array)
            .map(|keys| keys.iter().filter_map(Value::as_str).map(str::to_owned).collect::<HashSet<_>>()),
        hotkey_registered: !hotkey.eq_ignore_ascii_case("none") && !hotkey.trim().is_empty(),
    }
}

fn safe_text(value: &str) -> String {
    value.chars().filter(|character| {
        let code = *character as u32;
        (0x20..=0x7E).contains(&code) || *character == '°' || matches!(*character, '\n' | '\r' | '\t')
    }).collect()
}
fn escape(value: &str) -> String {
    safe_text(value).replace('\\', "\\\\").replace('<', "\\<").replace('>', "\\>")
}
fn color(value: &str, fallback: &str) -> String {
    let value = value.trim_start_matches('#');
    if value.len() == 6 && value.bytes().all(|byte| byte.is_ascii_hexdigit()) { value.to_ascii_uppercase() }
    else { fallback.trim_start_matches('#').to_ascii_uppercase() }
}
fn number(value: Option<f64>, digits: usize, fallback: &str) -> String {
    match value.filter(|value| value.is_finite()) {
        Some(value) => { let factor = 10f64.powi(digits as i32); format!("{}", (value * factor).round() / factor) }
        None => fallback.into(),
    }
}
fn temperature(value: Option<f64>, unit: &str) -> String {
    let displayed = value.map(|value| if unit == "F" { value * 9.0 / 5.0 + 32.0 } else { value });
    format!("{}°{}", number(displayed, 0, "-"), if unit == "F" { "F" } else { "C" })
}
fn short_gpu(name: &str) -> String {
    let normalized = safe_text(name).replace("(R)", " ").replace("(r)", " ").replace("(TM)", " ").replace("(tm)", " ");
    let mut parts: Vec<&str> = normalized.split_whitespace().filter(|token| {
        !matches!(token.to_ascii_lowercase().as_str(), "nvidia" | "geforce" | "intel" | "arc" | "amd" | "ati" | "radeon" | "graphics" | "gpu" | "laptop" | "mobile" | "display" | "adapter" | "controller" | "video" | "corporation" | "inc" | "r" | "tm")
    }).collect();
    if parts.is_empty() { parts.push("GPU"); }
    parts.join(" ")
}
fn position_tag(position: &str) -> &'static str {
    match position { "top-right" => "<P2>", "bottom-left" => "<P6>", "bottom-right" => "<P8>", _ => "<P0>" }
}

fn graph_bytes(values: &[f64]) -> Vec<u8> {
    let samples: Vec<f32> = values.iter().rev().take(512).rev().filter(|value| value.is_finite()).map(|value| *value as f32).collect();
    let length = 36 + samples.len() * 4;
    let mut bytes = vec![0u8; length];
    bytes[0..4].copy_from_slice(&GRAPH_SIGNATURE.to_le_bytes());
    bytes[4..8].copy_from_slice(&(length as u32).to_le_bytes());
    bytes[8..12].copy_from_slice(&(-32i32).to_le_bytes());
    bytes[12..16].copy_from_slice(&(-5i32).to_le_bytes());
    bytes[16..20].copy_from_slice(&1i32.to_le_bytes());
    bytes[20..24].copy_from_slice(&0u32.to_le_bytes());
    bytes[24..28].copy_from_slice(&0f32.to_le_bytes());
    bytes[28..32].copy_from_slice(&50f32.to_le_bytes());
    bytes[32..36].copy_from_slice(&(samples.len() as u32).to_le_bytes());
    for (index, value) in samples.iter().enumerate() {
        bytes[36 + index * 4..40 + index * 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}

struct Publisher {
    mapping: Option<Mapping>,
    settings: Settings,
    last_mtime: Option<SystemTime>,
    visible: bool,
    latest: BTreeMap<String, Value>,
    frame_history: Vec<f64>,
}

impl Publisher {
    fn new() -> Self { Self { mapping: None, settings: load_settings(), last_mtime: None, visible: true, latest: BTreeMap::new(), frame_history: Vec::new() } }
    fn refresh(&mut self) {
        let mtime = settings_path().and_then(|path| std::fs::metadata(path).ok()).and_then(|metadata| metadata.modified().ok());
        if mtime == self.last_mtime { return; }
        self.last_mtime = mtime;
        self.update_settings(load_settings());
    }
    fn update_settings(&mut self, settings: Settings) {
        let previous = std::mem::replace(&mut self.settings, settings);
        if self.settings.enabled != previous.enabled || self.settings.renderer != previous.renderer {
            self.visible = self.settings.enabled && self.settings.renderer != "capframex";
        }
        if !self.settings.enabled || self.settings.renderer == "capframex" {
            self.visible = false;
            if let Some(mapping) = self.mapping.as_mut() { mapping.clear(); }
            self.mapping = None;
        }
    }
    fn ensure_mapping(&mut self) -> bool {
        if self.mapping.as_ref().is_some_and(|mapping| mapping.view.is_null()) { self.mapping = None; }
        if self.mapping.is_none() { self.mapping = Mapping::open(); }
        self.mapping.is_some()
    }
    fn publish(&mut self, sample: Option<Value>) {
        self.refresh();
        if let Some(sample) = sample {
            let key = sample.get("deviceKey").and_then(Value::as_str).map(str::to_owned)
                .or_else(|| sample.get("deviceKeys").and_then(Value::as_array).and_then(|keys| keys.iter().find_map(Value::as_str)).map(str::to_owned))
                .or_else(|| sample.get("deviceId").and_then(Value::as_u64).map(|id| format!("id:{id}")))
                .unwrap_or_else(|| "default".into());
            // Hot-plugged devices must not accumulate telemetry indefinitely.
            if !self.latest.contains_key(&key) && self.latest.len() >= 32 {
                if let Some(oldest_key) = self.latest.keys().next().cloned() { self.latest.remove(&oldest_key); }
            }
            self.latest.insert(key, sample);
        }
        if !self.settings.enabled || self.settings.renderer == "capframex" || !self.visible { return; }
        if !self.ensure_mapping() { return; }
        if let Some(mapping) = self.mapping.as_mut() {
            if mapping.slot.is_none() && mapping.claim_slot().is_none() { return; }
        }
        let stats = self.mapping.as_ref().map(|mapping| mapping.foreground_fps()).unwrap_or_default();
        if let Some(frame_time) = stats.frame_time.filter(|value| *value > 0.0) {
            self.frame_history.push(frame_time);
            if self.frame_history.len() > 512 { self.frame_history.drain(0..self.frame_history.len() - 512); }
        }
        let graph_supported = self.mapping.as_ref().is_some_and(|mapping| mapping.graph_supported());
        let text = build_text(&self.settings, &self.latest, &stats, graph_supported);
        if let Some(mapping) = self.mapping.as_mut() {
            if mapping.write_text(&text).is_none() {
                // A stale/restarted RTSS mapping is reopened on the next tick.
                self.mapping = None;
                return;
            }
            if self.settings.stats.contains("frametime") && mapping.graph_supported() {
                let graph = graph_bytes(&self.frame_history);
                let _ = mapping.write_graph(&graph);
            }
        }
    }
    fn foreground_metrics(&mut self) -> Value {
        self.refresh();
        if !self.ensure_mapping() {
            return json!({"pid":Value::Null,"fps":Value::Null,"frameTimeMs":Value::Null,"api":Value::Null});
        }
        let (pid, stats) = match self.mapping.as_ref() {
            Some(mapping) => {
                let pid = mapping.foreground_pid();
                let stats = pid.map(|pid| mapping.foreground_fps_for_pid(pid)).unwrap_or_default();
                (pid, stats)
            }
            None => (None, FpsStats::default()),
        };
        json!({"pid":pid,"fps":stats.fps,"frameTimeMs":stats.frame_time,"api":stats.api})
    }

    fn toggle(&mut self) -> Value {
        self.refresh();
        if self.settings.enabled && self.settings.renderer != "capframex" {
            self.visible = !self.visible;
            if self.visible { self.publish(None); } else if let Some(mapping) = self.mapping.as_mut() { mapping.clear(); self.mapping = None; }
        }
        self.state()
    }
    fn state(&self) -> Value {
        json!({
            "provider": "rtss",
            "available": self.mapping.is_some(),
            "exists": self.mapping.is_some(),
            "visible": self.visible && self.settings.enabled,
            "bounds": Value::Null,
            "position": self.settings.position,
            "scale": self.settings.scale,
            "enabled": self.settings.enabled && self.settings.renderer != "capframex",
            "hotkeyRegistered": self.settings.hotkey_registered,
        })
    }
    fn clear(&mut self) {
        if let Some(mapping) = self.mapping.as_mut() { mapping.clear(); }
        self.mapping = None;
    }
}

fn build_text(settings: &Settings, latest: &BTreeMap<String, Value>, stats: &FpsStats, graph_supported: bool) -> String {
    let enabled = |id: &str| settings.stats.contains(id);
    let mut lines = Vec::new();
    let mut push = |line: String| if !line.is_empty() { lines.push(line); };
    let label = color(&settings.label_color, "FFFFFF");
    let value = color(&settings.value_color, "FFFFFF");
    let row = |name: &str, fields: Vec<String>| {
        if fields.is_empty() { return String::new(); }
        format!("<C0={label}><C0>{}<C1={value}><C1> {}<C>", escape(name), fields.into_iter().map(|field| escape(&field)).collect::<Vec<_>>().join(" "))
    };
    let mut fps_fields = Vec::new();
    if enabled("fps") { fps_fields.push(number(stats.fps, 0, "-")); }
    if enabled("fps-avg") { fps_fields.push(format!("AVG {}", number(stats.avg, 0, "-"))); }
    if enabled("fps-1pct-low") { fps_fields.push(format!("1% {}", number(stats.low1, 0, "-"))); }
    if enabled("fps-01pct-low") { fps_fields.push(format!("0.1% {}", number(stats.low01, 0, "-"))); }
    if enabled("fps-99pct") { fps_fields.push(format!("99% {}", number(stats.p99, 0, "-"))); }
    push(row("FPS", fps_fields));
    let mut cpu_fields = Vec::new();
    if enabled("cpu-util") { cpu_fields.push(format!("{}%", number(latest.values().find_map(|sample| sample.get("cpuUtilPct").and_then(Value::as_f64)), 0, "-"))); }
    if enabled("cpu-clock") { cpu_fields.push(format!("{}GHz", number(latest.values().find_map(|sample| sample.get("cpuFreqMhz").and_then(Value::as_f64)).map(|value| value / 1000.0), 1, "-"))); }
    if enabled("cpu-temp") { cpu_fields.push(temperature(latest.values().find_map(|sample| sample.get("cpuTempC").and_then(Value::as_f64)), &settings.temperature_unit)); }
    if enabled("cpu-power") { cpu_fields.push(format!("{}W", number(latest.values().find_map(|sample| sample.get("cpuPowerW").and_then(Value::as_f64)), 1, "-"))); }
    push(row("CPU", cpu_fields));
    if enabled("memory-util") {
        let bytes = latest.values().find_map(|sample| sample.get("memoryUsedBytes").and_then(Value::as_f64));
        push(row("RAM", vec![number(bytes.map(|value| value / 1_000_000_000.0), 1, "-") + "GB"]));
    }
    for (key, sample) in latest.iter() {
        if settings.monitored_keys.as_ref().is_some_and(|keys| !keys.is_empty() && !keys.contains(key) && !key.starts_with("id:")) { continue; }
        let name = sample.get("deviceName").and_then(Value::as_str).map(short_gpu).unwrap_or_else(|| "GPU".into());
        let mut fields = Vec::new();
        if enabled("gpu-util") { fields.push(format!("{}%", number(sample.get("gpuUtilPct").and_then(Value::as_f64), 0, "-"))); }
        if enabled("gpu-clock") { fields.push(format!("{}MHz", number(sample.get("gpuClockMhz").and_then(Value::as_f64), 0, "-"))); }
        if enabled("gpu-temp") { fields.push(temperature(sample.get("tempC").and_then(Value::as_f64), &settings.temperature_unit)); }
        if enabled("gpu-voltage") { fields.push(format!("{}V", number(sample["gpuVoltageV"].as_f64(), 3, "-"))); }
        if enabled("gpu-power") { fields.push(format!("{}W", number(sample.get("powerW").and_then(Value::as_f64), 0, "-"))); }
        if enabled("gpu-fan") {
            let rpm = sample.get("fanRpm").and_then(|value| value.as_f64().or_else(|| value.as_array().and_then(|items| items.first()).and_then(Value::as_f64)));
            fields.push(format!("{}RPM", number(rpm, 0, "-")));
        }
        push(row(&name, fields));
        let mut fields = Vec::new();
        if enabled("gpu-mem-clock") { fields.push(format!("{}MHz", number(sample["memClockMhz"].as_f64(), 0, "-"))); }
        if enabled("gpu-vram") {
            let used = sample.get("gpuMemUsedBytes").or_else(|| sample.get("vramUsedBytes")).and_then(Value::as_f64);
            let total = sample.get("vramTotalBytes").and_then(Value::as_f64);
            fields.push(match (used, total) {
                (Some(used), Some(total)) => format!("{:.1}/{:.1}GB", used / 1_000_000_000.0, total / 1_000_000_000.0),
                (Some(used), None) => format!("{:.0}GB", used / 1_000_000_000.0),
                _ => "-".into(),
            });
        }
        if enabled("gpu-vram-temp") { fields.push(temperature(sample["vramTempC"].as_f64(), &settings.temperature_unit)); }
        push(row(&format!("{name} VRAM"), fields));
    }
    if enabled("api") { if let Some(api) = stats.api.as_ref().filter(|api| !api.is_empty()) { push(row("API", vec![api.clone()])); } }
    if enabled("frametime") { push(row("Frametime", vec![format!("{}ms", number(stats.frame_time, 2, "-"))])); }
    let body = lines.join("\n");
    let graph = if enabled("frametime") && graph_supported { "\n<OBJ=00000000>".to_owned() } else { String::new() };
    let font = (((settings.scale.clamp(0.5, 2.0)) * 14.0).round().max(8.0).min(28.0)) as u32;
    format!("{}{}<FNT=Tahoma,{font},700,1><C0={label}><C0><C1={value}><C1>{body}{graph}",
        position_tag(&settings.position), "")
        .chars().take(MAX_TEXT).collect()
}

pub struct RtssOsdHub {
    publisher: Mutex<Publisher>,
}

impl RtssOsdHub {
    pub fn new() -> Self { Self { publisher: Mutex::new(Publisher::new()) } }
    pub fn publish(&self, sample: &Value) {
        if let Ok(mut publisher) = self.publisher.lock() { publisher.publish(Some(sample.clone())); }
    }
    pub fn foreground_metrics(&self) -> Value {
        self.publisher.lock().map(|mut publisher| publisher.foreground_metrics())
            .unwrap_or_else(|_| json!({"pid":Value::Null,"fps":Value::Null,"frameTimeMs":Value::Null,"api":Value::Null}))
    }
    pub fn toggle(&self) -> Value {
        self.publisher.lock().map(|mut publisher| publisher.toggle()).unwrap_or_else(|_| json!({}))
    }
    pub fn state(&self) -> Value {
        self.publisher.lock().map(|mut publisher| {
            publisher.refresh();
            publisher.ensure_mapping();
            publisher.state()
        }).unwrap_or_else(|_| json!({}))
    }
    pub fn apply_settings(&self, value: &Value) {
        if let Ok(mut publisher) = self.publisher.lock() {
            publisher.update_settings(settings_from_value(value));
            publisher.publish(None);
        }
    }
    pub fn clear(&self) {
        if let Ok(mut publisher) = self.publisher.lock() { publisher.clear(); }
    }
    pub fn handles_overlay(store: &super::native_store::NativeStore) -> bool {
        let Ok(args) = super::wire::encode_json(&json!([])) else { return true; };
        store.invoke("load-settings", &args).ok()
            .and_then(|reply| super::wire::decode(&reply).ok())
            .and_then(|value| value.into_json().ok())
            .map(|value| value.get("overlayRenderer").and_then(Value::as_str).unwrap_or("rtss") != "capframex")
            .unwrap_or(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_contains_classic_rows_and_escapes_values() {
        let settings = Settings { enabled: true, ..Settings::default() };
        let mut latest = BTreeMap::new();
        latest.insert("gpu".into(), json!({"deviceName":"Intel Arc B580","gpuUtilPct":42.0,"tempC":61.0,"powerW":180.0}));
        let stats = FpsStats { fps: Some(60.0), avg: Some(59.0), frame_time: Some(16.67), api: Some("DX12".into()), ..FpsStats::default() };
        let text = build_text(&settings, &latest, &stats, true);
        assert!(text.starts_with("<P0>"));
        assert!(text.contains("<C0=FFFFFF><C0>FPS<C1=FFFFFF><C1> 60<C>"));
        assert!(text.contains("B580"));
        assert!(text.contains("DX12"));
        assert!(text.len() <= MAX_TEXT);
    }

    #[test]
    fn frametime_graph_tag_requires_buffer_support() {
        let settings = Settings {
            enabled: true,
            stats: ["fps", "frametime"].into_iter().map(str::to_owned).collect(),
            ..Settings::default()
        };
        let latest = BTreeMap::new();
        let stats = FpsStats { fps: Some(60.0), frame_time: Some(16.67), ..FpsStats::default() };
        assert!(build_text(&settings, &latest, &stats, true).contains("<OBJ=00000000>"));
        assert!(!build_text(&settings, &latest, &stats, false).contains("<OBJ="));
    }

    #[test]
    fn api_labels_match_the_canonical_overlay_vocabulary() {
        assert_eq!(api_label(0x0001), Some("OGL"));
        assert_eq!(api_label(0x0002), Some("OTHER"));
        assert_eq!(api_label(0x0004), Some("DX9"));
        assert_eq!(api_label(0x0006), Some("DX10"));
        assert_eq!(api_label(0x0007), Some("DX11"));
        assert_eq!(api_label(0x0009), Some("DX12"));
        assert_eq!(api_label(0x000A), Some("VULKAN"));
        assert_eq!(api_label(0), None);
    }

    #[test]
    fn ansi_encoding_keeps_degree_text_safe() {
        let bytes = ansi_bytes("CPU 55°C");
        assert!(!bytes.is_empty());
        assert_eq!(bytes.last(), Some(&b'C'));
    }

    #[test]
    fn settings_parser_defaults_and_colors_are_bounded() {
        let settings = Settings::default();
        assert!(settings.stats.contains("gpu-util"));
        assert_eq!(color("#12abef", "FFFFFF"), "12ABEF");
        assert_eq!(color("bad", "abcdef"), "ABCDEF");
        assert_eq!(short_gpu("Intel(R) Arc(TM) B580 Graphics"), "B580");
    }

    #[test]
    #[ignore = "live RTSS shared-memory slot write/read; requires RTSS running"]
    fn live_rtss_mapping_claim_write_and_clear() {
        let mut mapping = Mapping::open().expect("RTSSSharedMemoryV2");
        mapping.claim_slot().expect("claim OSD slot");
        let slot = mapping.slot.expect("claimed OSD slot");
        mapping.write_text("ArcPower native OSD test").expect("write OSD text");
        let (offset, _) = mapping.text_span();
        let base = mapping.entry_offset + slot * mapping.entry_size;
        let text = mapping.read_text(base + offset, 256);
        assert!(text.contains("ArcPower native OSD test"), "{text}");
        mapping.clear();
        assert!(mapping.read_text(base + offset, 256).is_empty());
    }

    #[test]
    #[ignore = "live RTSS OSD hub publish/read; requires RTSS running and overlayRenderer=rtss"]
    fn live_rtss_hub_publishes_classic_text() {
        let hub = RtssOsdHub::new();
        let sample = json!({
            "deviceKey":"gpu-a","deviceName":"Intel(R) Arc(TM) B580 Graphics",
            "cpuUtilPct":12.0,"cpuTempC":51.0,"cpuPowerW":65.0,"memoryUsedBytes":8_000_000_000.0,
            "gpuUtilPct":42.0,"tempC":61.0,"powerW":180.0,"gpuMemUsedBytes":2_000_000_000.0,
            "vramTotalBytes":12_000_000_000.0
        });
        let mut text = String::new();
        for _ in 0..20 {
            hub.publish(&sample);
            std::thread::sleep(std::time::Duration::from_millis(50));
            let mapping = Mapping::open().expect("RTSSSharedMemoryV2");
            let Some(slot) = (1..mapping.count).find(|slot| {
                mapping.read_text(mapping.entry_offset + slot * mapping.entry_size + ENTRY_OWNER, 256) == "ArcPower"
            }) else { continue; };
            let (offset, size) = mapping.text_span();
            let base = mapping.entry_offset + slot * mapping.entry_size;
            text = mapping.read_text(base + offset, size.min(4096));
            if text.contains("CPU") { break; }
        }
        assert!(text.contains("CPU"), "{text}");
        assert!(text.contains("B580"), "{text}");
        assert!(text.contains("FPS"), "{text}");
        hub.clear();
    }
}
