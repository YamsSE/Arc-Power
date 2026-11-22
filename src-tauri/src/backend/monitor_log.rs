//! Native Monitoring log writer (port of src/main/monitor-log.js).
//! Appends one aligned line per telemetry sample to
//! `<Documents>\Arc Power\monitor-YYYYMMDD.txt`; IO failures return
//! `{ ok:false, error }` and never abort the caller.
use super::platform_context::{known_folder_path, KnownFolder};
use super::wire::WireValue;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const COLUMNS: [(&str, usize); 22] = [
    ("timestamp", 19), ("gpuClockMhz", 11), ("memClockMhz", 11), ("tempC", 5),
    ("powerW", 6), ("utilPct", 7), ("fanRpm", 6), ("cpuUtilPct", 10),
    ("cpuTempC", 8), ("cpuFreqMhz", 10), ("gpuMemUsedGb", 12), ("fps", 3),
    ("gpuVoltageV", 11), ("vramTempC", 9), ("cpuPowerW", 9), ("memoryUsedGb", 13),
    ("memoryCapacityGb", 16), ("frameTimeMs", 11), ("avgFps", 7), ("low1Pct", 7),
    ("low01Pct", 8), ("p99", 5),
];

pub(crate) fn monitor_log_header() -> String {
    COLUMNS.iter().map(|(key, width)| pad(key, *width)).collect::<Vec<_>>().join(" | ")
}

static MONITOR_LOG: OnceLock<Mutex<MonitorLog>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LocalDateTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

struct MonitorLog {
    current: Option<PathBuf>,
    header_written: bool,
}

impl MonitorLog {
    fn new() -> Self { Self { current: None, header_written: false } }

    fn append(&mut self, sample: &[(String, WireValue)], dir: &Path, now: LocalDateTime) -> Result<PathBuf, String> {
        let file = dir.join(format!("monitor-{:04}{:02}{:02}.txt", now.year, now.month, now.day));
        if self.current.as_deref() != Some(file.as_path()) {
            self.current = Some(file.clone());
            self.header_written = false;
        }
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
        if !self.header_written || !file.exists() {
            append_line(&file, &monitor_log_header())?;
            self.header_written = true;
        }
        append_line(&file, &format_sample(sample))?;
        Ok(file)
    }
}

fn append_line(file: &Path, line: &str) -> Result<(), String> {
    use std::io::Write;
    let mut handle = std::fs::OpenOptions::new().create(true).append(true).open(file)
        .map_err(|error| error.to_string())?;
    handle.write_all(line.as_bytes()).map_err(|error| error.to_string())?;
    handle.write_all(b"\n").map_err(|error| error.to_string())
}

pub(crate) fn append(sample: &[(String, WireValue)]) -> Value {
    let result = (|| {
        let now = local_now()?;
        let dir = log_dir()?;
        let mut state = MONITOR_LOG.get_or_init(|| Mutex::new(MonitorLog::new()))
            .lock().map_err(|_| "monitor log lock is poisoned".to_owned())?;
        state.append(sample, &dir, now)
    })();
    match result {
        Ok(file) => json!({"ok": true, "file": file.to_string_lossy()}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

fn log_dir() -> Result<PathBuf, String> {
    if let Some(dir) = std::env::var_os("RID_MOCK_LOG_DIR").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    known_folder_path(KnownFolder::Documents)
        .map(|documents| documents.join("Arc Power"))
        .map_err(|error| error.to_string())
}

fn format_sample(sample: &[(String, WireValue)]) -> String {
    let timestamp = number(entry(sample, "t")).and_then(local_from_epoch_seconds)
        .map(|value| format_local_datetime(value))
        .unwrap_or_else(|| "-".to_owned());
    format_sample_with_timestamp(sample, &timestamp)
}

fn format_sample_with_timestamp(sample: &[(String, WireValue)], timestamp: &str) -> String {
    COLUMNS.iter().map(|(key, width)| {
        let text = match *key {
            "timestamp" => timestamp.to_owned(),
            "gpuMemUsedGb" => format_gb(entry(sample, "gpuMemUsedBytes")),
            "memoryUsedGb" => format_gb(entry(sample, "memoryUsedBytes")),
            "memoryCapacityGb" => format_gb(entry(sample, "memoryCapacityBytes")),
            _ => cell_text(entry(sample, key)),
        };
        pad(&text, *width)
    }).collect::<Vec<_>>().join(" | ")
}

fn format_gb(value: Option<&WireValue>) -> String {
    match number(value) {
        Some(bytes) if bytes.is_finite() => one_decimal(bytes / 1e9),
        _ => "-".to_owned(),
    }
}

fn one_decimal(value: f64) -> String {
    let value = if value == 0.0 { 0.0 } else { value };
    format!("{:.1}", (value * 10.0).round() / 10.0)
}

fn entry<'a>(sample: &'a [(String, WireValue)], key: &str) -> Option<&'a WireValue> {
    sample.iter().find(|(name, _)| name == key).map(|(_, value)| value)
}

fn number(value: Option<&WireValue>) -> Option<f64> {
    match value? {
        WireValue::Number(number) => number.as_f64(),
        WireValue::SpecialNumber(text) => match text.as_str() {
            "NaN" => Some(f64::NAN),
            "Infinity" => Some(f64::INFINITY),
            "-Infinity" => Some(f64::NEG_INFINITY),
            "-0" => Some(-0.0),
            _ => None,
        },
        _ => None,
    }
}

fn cell_text(value: Option<&WireValue>) -> String {
    match value {
        None | Some(WireValue::Undefined) | Some(WireValue::Null) => "-".to_owned(),
        Some(WireValue::Array(values)) if values.is_empty() => "-".to_owned(),
        Some(WireValue::Array(values)) => values.iter().map(array_text).collect::<Vec<_>>().join(";"),
        Some(WireValue::Number(number)) => number_text(number),
        Some(value) => literal_text(value),
    }
}

/// Array cells use JavaScript `String(item)` (no toFixed rounding).
fn array_text(value: &WireValue) -> String {
    match value {
        WireValue::Array(values) => values.iter().map(array_text).collect::<Vec<_>>().join(";"),
        WireValue::Number(number) => js_number_text(number),
        value => literal_text(value),
    }
}

fn literal_text(value: &WireValue) -> String {
    match value {
        WireValue::Undefined | WireValue::Null => "-".to_owned(),
        WireValue::Bool(value) => value.to_string(),
        WireValue::String(value) => value.clone(),
        WireValue::BigInt(value) => value.clone(),
        WireValue::SpecialNumber(value) if value == "-0" => "0".to_owned(),
        WireValue::SpecialNumber(value) => value.clone(),
        WireValue::Number(number) => js_number_text(number),
        WireValue::Array(values) => values.iter().map(array_text).collect::<Vec<_>>().join(";"),
        WireValue::Object(_) => "[object Object]".to_owned(),
    }
}

/// JavaScript `String(number)` for ordinary finite values.
fn js_number_text(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() { return value.to_string(); }
    if let Some(value) = number.as_u64() { return value.to_string(); }
    match number.as_f64() {
        Some(value) if value == 0.0 => "0".to_owned(),
        Some(value) if value.is_finite() => format!("{value}"),
        Some(value) if value.is_nan() => "NaN".to_owned(),
        Some(value) if value.is_sign_positive() => "Infinity".to_owned(),
        Some(_) => "-Infinity".to_owned(),
        None => number.to_string(),
    }
}

fn number_text(number: &serde_json::Number) -> String {
    if let Some(value) = number.as_i64() { return value.to_string(); }
    if let Some(value) = number.as_u64() { return value.to_string(); }
    let Some(value) = number.as_f64() else { return number.to_string(); };
    if !value.is_finite() {
        return if value.is_nan() { "NaN".to_owned() }
            else if value.is_sign_positive() { "Infinity".to_owned() }
            else { "-Infinity".to_owned() };
    }
    if value == 0.0 { return "0".to_owned(); }
    if value.fract() == 0.0 { return format!("{value}"); }
    // Match JavaScript toFixed(1): round half away from zero, then drop a
    // trailing .0 after the Number(...) conversion.
    let rounded = (value * 10.0).round() / 10.0;
    if rounded == 0.0 { "0".to_owned() }
    else if rounded.fract() == 0.0 { format!("{rounded}") }
    else { format!("{rounded:.1}") }
}

fn pad(text: &str, width: usize) -> String {
    if text.len() >= width { text.to_owned() } else { format!("{text:>width$}") }
}

fn format_local_datetime(value: LocalDateTime) -> String {
    format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        value.year, value.month, value.day, value.hour, value.minute, value.second)
}

#[cfg(windows)]
fn local_now() -> Result<LocalDateTime, String> {
    use windows_sys::Win32::Foundation::SYSTEMTIME;
    use windows_sys::Win32::System::SystemInformation::GetLocalTime;
    let mut value: SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { GetLocalTime(&mut value) };
    checked_local(value).ok_or_else(|| "GetLocalTime returned invalid fields".to_owned())
}

#[cfg(not(windows))]
fn local_now() -> Result<LocalDateTime, String> {
    let snapshot = super::platform_context::clock_snapshot().map_err(|error| error.to_string())?;
    parse_iso_utc(&snapshot.now_iso).ok_or_else(|| "clock snapshot is not parseable".to_owned())
}

#[cfg(windows)]
fn local_from_epoch_seconds(seconds: f64) -> Option<LocalDateTime> {
    use windows_sys::Win32::Foundation::{FILETIME, SYSTEMTIME};
    use windows_sys::Win32::System::Time::{FileTimeToSystemTime, SystemTimeToTzSpecificLocalTime};
    if !seconds.is_finite() { return None; }
    let millis = (seconds * 1000.0).trunc();
    if !millis.is_finite() || millis.abs() > 8.64e15 { return None; }
    // FILETIME counts 100 ns ticks from 1601-01-01; Unix epoch offset below.
    let ticks = (millis as i64).checked_add(11_644_473_600_000)?.checked_mul(10_000)?;
    if ticks < 0 { return None; }
    let file_time = FILETIME { dwLowDateTime: ticks as u32, dwHighDateTime: (ticks >> 32) as u32 };
    let mut utc: SYSTEMTIME = unsafe { std::mem::zeroed() };
    if unsafe { FileTimeToSystemTime(&file_time, &mut utc) } == 0 { return None; }
    let mut local: SYSTEMTIME = unsafe { std::mem::zeroed() };
    if unsafe { SystemTimeToTzSpecificLocalTime(std::ptr::null(), &utc, &mut local) } == 0 { return None; }
    checked_local(local)
}

#[cfg(not(windows))]
fn local_from_epoch_seconds(seconds: f64) -> Option<LocalDateTime> {
    if !seconds.is_finite() { return None; }
    let millis = (seconds * 1000.0).trunc();
    if !millis.is_finite() || millis.abs() > 8.64e15 { return None; }
    let duration = std::time::Duration::from_millis(millis.unsigned_abs() as u64);
    let instant = if millis >= 0.0 { std::time::UNIX_EPOCH.checked_add(duration) }
        else { std::time::UNIX_EPOCH.checked_sub(duration) }?;
    let snapshot = super::platform_context::ClockSnapshot::from_system_time(instant).ok()?;
    parse_iso_utc(&snapshot.now_iso)
}

#[cfg(not(windows))]
fn parse_iso_utc(text: &str) -> Option<LocalDateTime> {
    let year = text.get(0..4)?.parse().ok()?;
    let month = text.get(5..7)?.parse().ok()?;
    let day = text.get(8..10)?.parse().ok()?;
    let hour = text.get(11..13)?.parse().ok()?;
    let minute = text.get(14..16)?.parse().ok()?;
    let second = text.get(17..19)?.parse().ok()?;
    Some(LocalDateTime { year, month, day, hour, minute, second })
}

#[cfg(windows)]
fn checked_local(value: windows_sys::Win32::Foundation::SYSTEMTIME) -> Option<LocalDateTime> {
    let date = LocalDateTime {
        year: i32::from(value.wYear), month: u32::from(value.wMonth), day: u32::from(value.wDay),
        hour: u32::from(value.wHour), minute: u32::from(value.wMinute), second: u32::from(value.wSecond),
    };
    (date.year >= 1 && (1..=12).contains(&date.month) && (1..=31).contains(&date.day)
        && date.hour < 24 && date.minute < 60 && date.second < 60).then_some(date)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::wire::{decode, encode_json};

    fn sample_entries(sample: Value) -> Vec<(String, WireValue)> {
        let encoded = encode_json(&json!([sample])).unwrap();
        let WireValue::Array(mut args) = decode(&encoded).unwrap() else { panic!("array") };
        let WireValue::Object(entries) = args.remove(0) else { panic!("object") };
        entries
    }

    fn fixed_sample() -> Vec<(String, WireValue)> {
        sample_entries(json!({
            "t": 1700000000,
            "gpuClockMhz": 2400,
            "memClockMhz": 1187.5,
            "tempC": 60,
            "powerW": 38.79999999993015,
            "utilPct": 42,
            "fanRpm": [1200, 0],
            "cpuUtilPct": null,
            "gpuMemUsedBytes": 3000000000_u64,
            "fps": 60,
            "gpuVoltageV": 1.05,
            "vramTempC": 72,
            "cpuPowerW": 88.5,
            "memoryUsedBytes": 12400000000_u64,
            "memoryCapacityBytes": 34359738368_u64,
            "frameTimeMs": 16.6667,
            "avgFps": 59.9,
            "low1Pct": 55.5,
            "low01Pct": 50.1,
            "p99": 17.2
        }))
    }

    #[test]
    fn header_and_line_match_electron_oracle() {
        assert_eq!(monitor_log_header(),
            "          timestamp | gpuClockMhz | memClockMhz | tempC | powerW | utilPct | fanRpm | cpuUtilPct | cpuTempC | cpuFreqMhz | gpuMemUsedGb | fps | gpuVoltageV | vramTempC | cpuPowerW |  memoryUsedGb | memoryCapacityGb | frameTimeMs |  avgFps | low1Pct | low01Pct |   p99");
        assert_eq!(format_sample_with_timestamp(&fixed_sample(), "2023-11-14 22:13:20"),
            "2023-11-14 22:13:20 |        2400 |      1187.5 |    60 |   38.8 |      42 | 1200;0 |          - |        - |          - |          3.0 |  60 |         1.1 |        72 |      88.5 |          12.4 |             34.4 |        16.7 |    59.9 |    55.5 |     50.1 |  17.2");
    }

    #[test]
    fn cells_handle_missing_empty_and_nonfinite_values() {
        let sample = sample_entries(json!({"fanRpm": [], "powerW": 3.0, "fps": 1.25, "cpuUtilPct": "n/a"}));
        assert_eq!(format_sample_with_timestamp(&sample, "-"),
            "                  - |           - |           - |     - |      3 |       - |      - |        n/a |        - |          - |            - | 1.3 |           - |         - |         - |             - |                - |           - |       - |       - |        - |     -");
    }

    #[test]
    fn array_cells_use_javascript_string_not_tofixed() {
        let sample = sample_entries(json!({"fanRpm": [1200.55, 0.1]}));
        assert!(format_sample_with_timestamp(&sample, "-").contains("1200.55;0.1"));
    }

    #[test]
    fn float_cells_match_javascript_tofixed() {
        let number = |value: f64| serde_json::Number::from_f64(value).unwrap();
        for (value, expected) in [
            (1.25, "1.3"), (-1.25, "-1.3"), (1.96, "2"), (2.675, "2.7"),
            (0.05, "0.1"), (0.04, "0"), (99.99, "100"), (3.0, "3"), (-0.0, "0"),
        ] {
            assert_eq!(number_text(&number(value)), expected, "{value}");
        }
        assert_eq!(one_decimal(1.96), "2.0");
        assert_eq!(one_decimal(1.25), "1.3");
        assert_eq!(one_decimal(-0.0), "0.0");
    }

    #[test]
    fn append_writes_one_header_per_process_and_recreates_after_delete() {
        let root = std::env::temp_dir().join(format!("arc-monitor-log-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let now = LocalDateTime { year: 2026, month: 11, day: 8, hour: 12, minute: 0, second: 0 };
        let sample = fixed_sample();
        let mut log = MonitorLog::new();
        let file = log.append(&sample, &root, now).unwrap();
        log.append(&sample, &root, now).unwrap();
        let first = std::fs::read_to_string(&file).unwrap();
        assert_eq!(first.matches(&monitor_log_header()).count(), 1);
        assert_eq!(first.lines().count(), 3);
        std::fs::remove_file(&file).unwrap();
        log.append(&sample, &root, now).unwrap();
        let recreated = std::fs::read_to_string(&file).unwrap();
        assert_eq!(recreated.matches(&monitor_log_header()).count(), 1);
        assert_eq!(recreated.lines().count(), 2);
        std::fs::remove_dir_all(root).unwrap();
    }
}
