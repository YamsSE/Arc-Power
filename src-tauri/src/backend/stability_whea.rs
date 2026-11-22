//! Native WHEA event-log monitor for Stability Lab.
//! The PowerShell reader is isolated behind `WheaReader` so the lifecycle can
//! be verified without touching the Windows Event Log.
use serde_json::{json, Map, Value};
use std::{
    path::PathBuf,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const DEFAULT_POLL_MS: u64 = 1000;
const MIN_POLL_MS: u64 = 250;
const ERROR_LIMIT: usize = 240;

const QUERY: &str = concat!(
    "$ErrorActionPreference = \"SilentlyContinue\"; ",
    "__START__; ",
    "$events = @(Get-WinEvent -FilterHashtable @{ LogName = \"System\"; ProviderName = \"Microsoft-Windows-WHEA-Logger\"; StartTime = $start } -ErrorAction SilentlyContinue | Where-Object { $_.TimeCreated.ToUniversalTime() -gt $start }); ",
    "if ($null -eq $events) { \"0\" } else { $events.Count.ToString() }",
);

pub trait WheaReader: Send + Sync {
    fn read(&self, started_at_iso: &str) -> Result<String, String>;
}

pub trait WheaLane: Send + Sync {
    fn start(&self, started_at_ms: f64) -> Result<Value, String>;
    fn snapshot(&self) -> Value;
    fn stop(&self) -> Result<Value, String>;
}

pub struct PowerShellWheaReader { executable: PathBuf }

impl PowerShellWheaReader {
    pub fn new(executable: PathBuf) -> Self { Self { executable } }
    pub fn system() -> Self {
        let executable = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .map(|root| root.join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe"))
            .unwrap_or_else(|| PathBuf::from("powershell.exe"));
        Self::new(executable)
    }
}

impl WheaReader for PowerShellWheaReader {
    fn read(&self, started_at_iso: &str) -> Result<String, String> {
        let escaped = started_at_iso.replace('\'', "''");
        let query = QUERY.replace("__START__", &format!("$start = [DateTimeOffset]::Parse('{escaped}').UtcDateTime"));
        let mut command = Command::new(&self.executable);
        command.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &query]);
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let output = command.output().map_err(|error| error.to_string())?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(if stderr.trim().is_empty() {
                format!("WHEA Event Log query failed ({})", output.status)
            } else { stderr.trim().to_owned() });
        }
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    }
}

struct WheaInner {
    reader: Arc<dyn WheaReader>,
    poll_ms: u64,
    started_at_ms: Mutex<Option<f64>>,
    state: Mutex<Value>,
    poll_stop: Mutex<Option<Arc<AtomicBool>>>,
    poll_thread: Mutex<Option<JoinHandle<()>>>,
}

pub struct WheaMonitor { inner: Arc<WheaInner> }

impl WheaMonitor {
    pub fn new(reader: Box<dyn WheaReader>) -> Self { Self::with_poll_ms(reader, DEFAULT_POLL_MS) }

    pub fn with_poll_ms(reader: Box<dyn WheaReader>, poll_ms: u64) -> Self {
        Self { inner: Arc::new(WheaInner {
            reader: Arc::from(reader),
            poll_ms: poll_ms.max(MIN_POLL_MS),
            started_at_ms: Mutex::new(None),
            state: Mutex::new(initial_state()),
            poll_stop: Mutex::new(None),
            poll_thread: Mutex::new(None),
        }) }
    }

    fn stop_polling(&self) {
        if let Ok(mut slot) = self.inner.poll_stop.lock() {
            if let Some(stop) = slot.take() { stop.store(true, Ordering::Release); }
        }
        let handle = self.inner.poll_thread.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle { let _ = handle.join(); }
    }
}

impl WheaLane for WheaMonitor {
    fn start(&self, started_at_ms: f64) -> Result<Value, String> {
        self.stop_polling();
        let started = if started_at_ms.is_finite() { started_at_ms } else { now_ms() };
        *self.inner.started_at_ms.lock().map_err(|_| "WHEA monitor lock failed")? = Some(started);
        *self.inner.state.lock().map_err(|_| "WHEA monitor lock failed")? = initial_state();
        self.inner.refresh();
        let stop = Arc::new(AtomicBool::new(false));
        if let Ok(mut slot) = self.inner.poll_stop.lock() { *slot = Some(stop.clone()); }
        let inner = self.inner.clone();
        let poll_ms = self.inner.poll_ms;
        let handle = thread::Builder::new().name("arc-stability-whea".into())
            .spawn(move || {
                let slices = (poll_ms / 50).max(1);
                loop {
                    for _ in 0..slices {
                        if stop.load(Ordering::Acquire) { return; }
                        thread::sleep(Duration::from_millis(50));
                    }
                    if stop.load(Ordering::Acquire) { return; }
                    inner.refresh();
                }
            })
            .map_err(|error| error.to_string())?;
        if let Ok(mut slot) = self.inner.poll_thread.lock() { *slot = Some(handle); }
        Ok(self.snapshot())
    }

    fn snapshot(&self) -> Value {
        self.inner.state.lock().map(|state| state.clone()).unwrap_or_else(|_| initial_state())
    }

    fn stop(&self) -> Result<Value, String> {
        self.stop_polling();
        self.inner.refresh();
        if let Ok(mut started) = self.inner.started_at_ms.lock() { *started = None; }
        Ok(self.snapshot())
    }
}

impl WheaInner {
    fn refresh(&self) {
        let started = self.started_at_ms.lock().ok().and_then(|value| *value);
        let Some(started) = started else { return; };
        if !cfg!(windows) { return; }
        let iso = super::platform_context::ClockSnapshot::from_system_time(
            UNIX_EPOCH + Duration::from_millis(started.max(0.0).round() as u64))
            .map(|clock| clock.now_iso)
            .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into());
        let update = match self.reader.read(&iso) {
            Ok(stdout) => match parse_count(&stdout) {
                Some(count) => json!({
                    "available":true,"checked":true,"errorCount":count,
                    "error":Value::Null,"lastCheckedAt":now_ms(),
                }),
                None => json!({
                    "available":true,"checked":true,
                    "error":"WHEA Event Log returned an invalid count","lastCheckedAt":now_ms(),
                }),
            },
            Err(error) => json!({
                "available":false,"checked":true,
                "error":truncate(&error, ERROR_LIMIT),"lastCheckedAt":now_ms(),
            }),
        };
        if let Ok(mut state) = self.state.lock() { merge_object(&mut state, &update); }
    }
}

fn initial_state() -> Value {
    json!({
        "available":cfg!(windows),"checked":false,"errorCount":0,
        "error":if cfg!(windows) { Value::Null } else { json!("WHEA check unavailable") },
        "lastCheckedAt":Value::Null,
    })
}

fn merge_object(target: &mut Value, update: &Value) {
    let Some(update) = update.as_object() else { return; };
    if !target.is_object() { *target = Value::Object(Map::new()); }
    if let Some(target) = target.as_object_mut() {
        for (key, value) in update { target.insert(key.clone(), value.clone()); }
    }
}

fn truncate(text: &str, max: usize) -> String {
    String::from_utf16(&text.encode_utf16().take(max).collect::<Vec<_>>())
        .unwrap_or_else(|_| String::new())
}

pub fn parse_count(stdout: &str) -> Option<u64> {
    let token = stdout.trim().split_whitespace().next().unwrap_or("");
    let digits: String = token.chars().take_while(|ch| ch.is_ascii_digit() || matches!(ch, '-' | '+')).collect();
    digits.parse::<i64>().ok().filter(|count| *count >= 0).map(|count| count as u64)
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as f64).unwrap_or(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    struct FakeReader { outputs: Mutex<Vec<Result<String, String>>>, calls: AtomicUsize }
    impl FakeReader {
        fn new(outputs: Vec<Result<String, String>>) -> Self {
            Self { outputs: Mutex::new(outputs), calls: AtomicUsize::new(0) }
        }
        fn calls(&self) -> usize { self.calls.load(Ordering::SeqCst) }
    }
    impl WheaReader for FakeReader {
        fn read(&self, _started_at_iso: &str) -> Result<String, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let mut outputs = self.outputs.lock().unwrap();
            if outputs.is_empty() { Ok("0".into()) } else { outputs.remove(0) }
        }
    }
    impl WheaReader for Arc<FakeReader> {
        fn read(&self, started_at_iso: &str) -> Result<String, String> { (**self).read(started_at_iso) }
    }

    #[test]
    fn parse_count_matches_javascript_parse_int_and_rejects_invalid_counts() {
        assert_eq!(parse_count(" 12\n"), Some(12));
        assert_eq!(parse_count("0"), Some(0));
        assert_eq!(parse_count("-1"), None);
        assert_eq!(parse_count("garbage"), None);
        assert_eq!(parse_count("3 events"), Some(3));
    }

    #[test]
    fn start_and_stop_use_the_reader_and_keep_the_last_valid_count() {
        let reader = Arc::new(FakeReader::new(vec![Ok("0\n".into()), Ok("2".into())]));
        let monitor = WheaMonitor::with_poll_ms(Box::new(reader.clone()), 10_000);
        let started = monitor.start(1_700_000_000_000.0).unwrap();
        assert_eq!(started["available"], json!(true));
        assert_eq!(started["checked"], json!(true));
        assert_eq!(started["errorCount"], json!(0));
        let final_state = monitor.stop().unwrap();
        assert_eq!(final_state["errorCount"], json!(2));
        assert_eq!(final_state["available"], json!(true));
        assert_eq!(reader.calls(), 2);
        // A stopped monitor does not keep querying.
        let _ = monitor.stop().unwrap();
        assert_eq!(reader.calls(), 2);
    }

    #[test]
    fn reader_failure_degrades_to_unavailable_without_losing_the_count() {
        let reader = Arc::new(FakeReader::new(vec![Ok("4".into()), Err("powershell missing".into())]));
        let monitor = WheaMonitor::with_poll_ms(Box::new(reader), 10_000);
        monitor.start(1.0).unwrap();
        let state = monitor.stop().unwrap();
        assert_eq!(state["errorCount"], json!(4));
        assert_eq!(state["available"], json!(false));
        assert_eq!(state["checked"], json!(true));
        assert_eq!(state["error"], json!("powershell missing"));
        assert!(state["lastCheckedAt"].as_f64().is_some_and(|value| value > 0.0));
    }

    #[test]
    fn invalid_output_is_checked_but_keeps_the_previous_count() {
        let reader = Arc::new(FakeReader::new(vec![Ok("7".into()), Ok("not-a-count".into())]));
        let monitor = WheaMonitor::with_poll_ms(Box::new(reader), 10_000);
        monitor.start(1.0).unwrap();
        let state = monitor.stop().unwrap();
        assert_eq!(state["errorCount"], json!(7));
        assert_eq!(state["available"], json!(true));
        assert_eq!(state["error"], json!("WHEA Event Log returned an invalid count"));
    }
}
