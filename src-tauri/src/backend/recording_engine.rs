//! Native Ascent recording engine: runtime discovery, child process protocol,
//! machine-info probe, video/replay lifecycle, and Instant Replay save.
use super::{
    native_store::NativeStore,
    recording_apm::ApmSampler,
    recording_contract::{self as contract, ASCENT_MAX_MESSAGE_BYTES},
    recording_ffmpeg::trim_to_duration,
    wire,
};
use base64::Engine;
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

pub const IDLE_MESSAGE: &str = "Capture engine idle until recording is requested";
const ASCENT_SHUTDOWN: u64 = 1;
const ASCENT_QUERY_MACHINE_INFO: u64 = 2;
const ASCENT_START: u64 = 3;
const ASCENT_STOP: u64 = 4;
const ASCENT_START_REPLAY_CAPTURE: u64 = 8;
const ASCENT_STOP_REPLAY_CAPTURE: u64 = 9;

const EVENT_QUERY_MACHINE_INFO: u64 = 1;
const EVENT_ERR: u64 = 2;
const EVENT_READY: u64 = 3;
const EVENT_RECORDING_STARTED: u64 = 4;
const EVENT_RECORDING_STOPPED: u64 = 6;
const EVENT_REPLAY_STARTED: u64 = 9;
const EVENT_REPLAY_STOPPED: u64 = 11;
const EVENT_REPLAY_CAPTURE_VIDEO_STARTED: u64 = 13;
const EVENT_REPLAY_CAPTURE_VIDEO_READY: u64 = 14;
const EVENT_REPLAY_ERROR: u64 = 15;

const RECORDER_VIDEO: u64 = 1;
const RECORDER_REPLAY: u64 = 2;
const QSV_PREFERENCE: &[&str] = &[
    "obs_qsv_vpl_av1_tex", "obs_qsv_vpl_hevc_tex", "obs_qsv_vpl_h264_tex",
    "obs_qsv_vpl_av1", "obs_qsv_vpl_hevc", "obs_qsv_vpl_h264",
    "obs_qsv11_av1", "obs_qsv11_hevc", "obs_qsv11_v2",
];
const SELECTION_PREFIX: &str = "arc-gpu-encoder:v1:";
const REPLAY_FILE_WAIT_MS: u64 = 5_000;
const REPLAY_FILE_STABLE_MS: u64 = 200;
const REPLAY_TRIM_RETRY_MS: u64 = 5_000;
const REPLAY_CAPTURE_RETRY_DELAY_MS: u64 = 500;
const REPLAY_CAPTURE_RETRY_MS: u64 = 30_000;
const REPLAY_CAPTURE_LEAD_MS: i64 = 750;
const REPLAY_CAPTURE_START_SETTLE_MS: u64 = 300;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as i64).unwrap_or(0)
}

/// Diagnostics for start/stop failures that the UI only sees as a flicker.
/// The log is best-effort and never changes the recording outcome.
fn diagnostic(message: &str) {
    let Some(appdata) = std::env::var_os("APPDATA") else { return; };
    let directory = PathBuf::from(appdata).join("ArcPower");
    let _ = std::fs::create_dir_all(&directory);
    let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true)
        .open(directory.join("recording.log")) else { return; };
    let seconds = SystemTime::now().duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs()).unwrap_or(0);
    let _ = writeln!(file, "{seconds} {message}");
}

#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Modes {
    pub video: bool,
    pub replay: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineState {
    pub available: bool,
    pub running: bool,
    pub mode: Option<String>,
    pub active_modes: Modes,
    pub starting_modes: Modes,
    pub started_at: Option<i64>,
    pub session_id: Option<String>,
    pub error: Option<String>,
    pub encoders: Vec<Value>,
    pub audio_inputs: Vec<Value>,
    pub audio_outputs: Vec<Value>,
    pub probe_complete: bool,
    pub last_event: Value,
    pub instant_replay_save: Value,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            available: false,
            running: false,
            mode: None,
            active_modes: Modes::default(),
            starting_modes: Modes::default(),
            started_at: None,
            session_id: None,
            error: Some(IDLE_MESSAGE.into()),
            encoders: Vec::new(),
            audio_inputs: Vec::new(),
            audio_outputs: Vec::new(),
            probe_complete: false,
            last_event: Value::Null,
            instant_replay_save: replay_save_state("idle", None, None, None),
        }
    }
}

fn replay_save_state(status: &str, error: Option<&str>, output: Option<&str>, updated: Option<i64>) -> Value {
    let status = match status { "saving" | "ready" | "error" | "idle" => status, _ => "idle" };
    json!({
        "status": status,
        "error": if status == "error" { error.filter(|value| !value.trim().is_empty()) } else { None },
        "outputPath": if status == "ready" { output.filter(|value| !value.trim().is_empty()) } else { None },
        "updatedAt": updated,
    })
}

#[derive(Clone, Debug)]
struct Recorder {
    identifier: u64,
    recorder_type: u64,
    mode: String,
    ready: bool,
    session_id: String,
    started_at: i64,
    output_path: Option<String>,
    settings: Value,
    cancel_requested: bool,
    stop_in_flight: bool,
    started_after_cancel: bool,
}

#[derive(Clone, Debug)]
struct ReplayCapture {
    buffer_identifier: u64,
    capture_identifier: u64,
    phase: String,
}

struct Pending {
    events: Vec<u64>,
    sender: mpsc::SyncSender<Result<Value, EngineError>>,
    accept_unidentified: bool,
}

struct Core {
    state: EngineState,
    active: HashMap<String, Recorder>,
    starting: HashMap<String, Recorder>,
    completed: Vec<Value>,
    demoted: HashSet<String>,
    machine_info_ready: bool,
    replay_capture: Option<ReplayCapture>,
    replay_capture_ready_at: i64,
    fresh_child_required: bool,
    replay_save_in_flight: bool,
    disposed: bool,
    retiring: bool,
}

#[derive(Debug)]
pub struct EngineError {
    pub message: String,
    pub code: Option<i64>,
    pub timeout: bool,
}

impl EngineError {
    fn message(message: impl Into<String>) -> Self {
        Self { message: message.into(), code: None, timeout: false }
    }
    fn timeout() -> Self {
        Self { message: "Timed out waiting for Ascent".into(), code: None, timeout: true }
    }
    fn is_encoder_rejection(&self) -> bool {
        matches!(self.code, Some(-6 | -8))
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { formatter.write_str(&self.message) }
}

impl std::error::Error for EngineError {}

pub type EngineResult<T> = Result<T, EngineError>;

struct EngineInner {
    core: Mutex<Core>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<u64, Pending>>,
    next_identifier: AtomicU64,
    lifecycle: Mutex<()>,
    settings_cache: Mutex<Value>,
    demand: AtomicUsize,
    emit: Box<dyn Fn(Value) + Send + Sync>,
    crash: Box<dyn Fn(Value) + Send + Sync>,
    apm: ApmSampler,
}

pub struct RecordingEngine {
    inner: Arc<EngineInner>,
}

impl RecordingEngine {
    pub fn new(emit: Box<dyn Fn(Value) + Send + Sync>, crash: Box<dyn Fn(Value) + Send + Sync>) -> Self {
        Self {
            inner: Arc::new(EngineInner {
                core: Mutex::new(Core {
                    state: EngineState::default(),
                    active: HashMap::new(),
                    starting: HashMap::new(),
                    completed: Vec::new(),
                    demoted: HashSet::new(),
                    machine_info_ready: false,
                    replay_capture: None,
                    replay_capture_ready_at: 0,
                    fresh_child_required: false,
                    replay_save_in_flight: false,
                    disposed: false,
                    retiring: false,
                }),
                stdin: Mutex::new(None),
                child: Mutex::new(None),
                pending: Mutex::new(HashMap::new()),
                next_identifier: AtomicU64::new(1),
                lifecycle: Mutex::new(()),
                settings_cache: Mutex::new(json!({})),
                demand: AtomicUsize::new(0),
                emit,
                crash,
                apm: ApmSampler::new(),
            }),
        }
    }

    pub fn snapshot(&self) -> Value { self.inner.snapshot() }
    /// Best-effort read-only snapshot for the host cadence. Recording threads
    /// never wait behind the UI when the engine state lock is already held.
    pub fn try_snapshot(&self) -> Option<Value> { self.inner.try_snapshot() }
    pub fn set_demand(&self, demand: usize) { self.inner.demand.store(demand, Ordering::Release); }
    pub fn take_completed(&self, mode: &str) -> Option<Value> {
        let mut core = self.inner.core.lock().ok()?;
        let index = core.completed.iter().position(|capture| capture["mode"].as_str() == Some(mode))?;
        Some(core.completed.remove(index))
    }
    pub fn probe(&self, store: &NativeStore) -> EngineResult<Value> { self.inner.probe(store) }
    pub fn start(&self, store: &NativeStore, settings: &Value, mode: &str) -> EngineResult<Value> {
        self.inner.start(store, settings, mode)
    }
    pub fn stop(&self, store: &NativeStore, mode: Option<&str>) -> EngineResult<Value> {
        self.inner.stop(store, mode.map(str::to_owned).as_deref())
    }
    pub fn save_replay_clip(&self, store: &NativeStore, path: &str, head_duration: i64, thumbnail_folder: &str) -> EngineResult<Value> {
        self.inner.save_replay_clip(store, path, head_duration, thumbnail_folder)
    }
    pub fn shutdown_if_idle(&self, store: &NativeStore, memory_saving: bool) -> EngineResult<Value> {
        self.inner.shutdown_if_idle(store, memory_saving)
    }
    pub fn shutdown(&self, store: &NativeStore) -> EngineResult<Value> { self.inner.shutdown(store) }
}

impl EngineInner {
    fn snapshot(&self) -> Value {
        let core = self.core.lock().unwrap();
        serde_json::to_value(&core.state).unwrap_or_else(|_| json!({}))
    }

    fn try_snapshot(&self) -> Option<Value> {
        let core = self.core.try_lock().ok()?;
        serde_json::to_value(&core.state).ok()
    }

    fn publish(&self) {
        (self.emit)(self.snapshot());
    }

    fn publish_instant(&self, status: &str, error: Option<&str>, output: Option<&str>) {
        {
            let mut core = self.core.lock().unwrap();
            core.state.instant_replay_save = replay_save_state(status, error, output, Some(now_ms()));
        }
        self.publish();
    }

    fn refresh_capture(core: &mut Core) {
        let active: Vec<Recorder> = core.active.values().cloned().collect();
        let started_at = active.iter().map(|recorder| recorder.started_at).min();
        let session = core.active.get("replay").or_else(|| core.active.get("video"));
        core.state.running = !active.is_empty();
        core.state.mode = if core.active.contains_key("video") { Some("video".into()) }
            else if core.active.contains_key("replay") { Some("replay".into()) } else { None };
        core.state.active_modes = Modes { video: core.active.contains_key("video"), replay: core.active.contains_key("replay") };
        core.state.starting_modes = Modes { video: core.starting.contains_key("video"), replay: core.starting.contains_key("replay") };
        core.state.started_at = started_at;
        core.state.session_id = session.map(|recorder| recorder.session_id.clone());
    }

    fn apply_cached_settings(&self, settings: &Value) {
        if let Ok(mut cache) = self.settings_cache.lock() { *cache = settings.clone(); }
    }

    fn cached_settings(&self) -> Value {
        self.settings_cache.lock().map(|value| value.clone()).unwrap_or_else(|_| json!({}))
    }

    fn resolve_runtime(settings: &Value) -> Option<(PathBuf, PathBuf)> {
        let configured = settings.get("runtimePath").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
        let mut roots: Vec<PathBuf> = Vec::new();
        if let Some(configured) = configured { roots.push(PathBuf::from(configured)); }
        if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
                roots.push(parent.join("resources").join("recording-runtime"));
                roots.push(parent.join("compatibility-backend").join("resources").join("recording-runtime"));
                roots.push(parent.join("recording-runtime"));
            }
        }
        roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("recording-runtime"));
        if let Ok(cwd) = std::env::current_dir() { roots.push(cwd.join("recording-runtime")); }
        for root in roots {
            let executable = root.join("bin").join("64bit").join("ascent-obs.exe");
            if executable.is_file() { return Some((root, executable)); }
        }
        None
    }

    fn ensure_child(self: &Arc<Self>, settings: &Value) -> EngineResult<()> {
        if self.child.lock().map(|child| child.is_some()).unwrap_or(false)
            && self.stdin.lock().map(|stdin| stdin.is_some()).unwrap_or(false) {
            return Ok(());
        }
        if self.core.lock().map(|core| core.disposed).unwrap_or(true) { return Err(EngineError::message("Ascent engine is shut down")); }
        let Some((root, executable)) = Self::resolve_runtime(settings) else {
            {
                let mut core = self.core.lock().unwrap();
                core.state.available = false;
                core.state.error = Some("Bundled ascent-obs runtime is unavailable".into());
            }
            self.publish();
            return Err(EngineError::message("Bundled ascent-obs runtime is unavailable"));
        };
        let mut command = Command::new(&executable);
        command.current_dir(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|error| EngineError::message(error.to_string()))?;
        let stdin = child.stdin.take().ok_or_else(|| EngineError::message("Ascent stdin is unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| EngineError::message("Ascent stdout is unavailable"))?;
        let stderr = child.stderr.take().ok_or_else(|| EngineError::message("Ascent stderr is unavailable"))?;
        *self.stdin.lock().unwrap() = Some(stdin);
        *self.child.lock().unwrap() = Some(child);
        {
            let mut core = self.core.lock().unwrap();
            core.machine_info_ready = false;
            core.state.available = true;
            core.state.error = None;
            core.state.probe_complete = false;
        }
        self.publish();
        let reader_inner = self.clone();
        std::thread::Builder::new().name("arc-ascent-stdout".into()).spawn(move || {
            reader_inner.read_stdout(stdout);
        }).ok();
        let stderr_inner = self.clone();
        std::thread::Builder::new().name("arc-ascent-stderr".into()).spawn(move || {
            stderr_inner.read_stderr(stderr);
        }).ok();
        Ok(())
    }

    fn read_stdout(self: Arc<Self>, mut stdout: impl Read) {
        let mut buffer = [0u8; 8192];
        let mut decoder = Utf8Stream::default();
        let mut remainder = String::new();
        loop {
            match stdout.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    let text = decoder.push(&buffer[..count]);
                    match contract::consume_ascent_json_objects(Some(&remainder), Some(&text), ASCENT_MAX_MESSAGE_BYTES) {
                        Ok(parsed) => {
                            remainder = parsed.remainder;
                            for message in parsed.objects { self.handle_message(message); }
                        }
                        Err(error) => { self.fail_protocol(error); break; }
                    }
                }
            }
        }
        self.handle_exit();
    }

    fn read_stderr(self: Arc<Self>, mut stderr: impl Read) {
        let mut buffer = [0u8; 4096];
        let mut text = String::new();
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => {
                    text.push_str(&String::from_utf8_lossy(&buffer[..count]));
                    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
                    text = lines.pop().unwrap_or_default();
                    let diagnostic = filter_recording_stderr(&lines.join("\n"));
                    if !diagnostic.is_empty() {
                        let diagnostic: String = diagnostic.chars().take(512).collect();
                        let mut core = self.core.lock().unwrap();
                        core.state.error = Some(diagnostic);
                        drop(core);
                        self.publish();
                    }
                }
            }
        }
        let diagnostic = filter_recording_stderr(&text);
        if !diagnostic.is_empty() {
            let diagnostic: String = diagnostic.chars().take(512).collect();
            let mut core = self.core.lock().unwrap();
            core.state.error = Some(diagnostic);
            drop(core);
            self.publish();
        }
    }

    fn fail_protocol(&self, error: impl std::fmt::Display) {
        let message = format!("Ascent protocol error: {error}");
        {
            let mut core = self.core.lock().unwrap();
            core.state.available = false;
            core.state.error = Some(message.clone());
            core.active.clear();
            core.starting.clear();
            core.replay_capture = None;
            core.replay_capture_ready_at = 0;
            core.machine_info_ready = false;
            Self::refresh_capture(&mut core);
        }
        self.reject_pending(EngineError::message(message));
        self.kill_child();
        self.publish();
    }

    fn handle_exit(self: &Arc<Self>) {
        let status = {
            let mut child = self.child.lock().unwrap();
            let Some(mut target) = child.take() else { return };
            match target.try_wait() {
                Ok(Some(status)) => Some(status.code()),
                _ => { let _ = target.kill(); let _ = target.wait(); None }
            }
        };
        *self.stdin.lock().unwrap() = None;
        let code = status.flatten();
        let (disposed, retiring) = self.core.lock().map(|core| (core.disposed, core.retiring)).unwrap_or((false, false));
        if retiring {
            let mut core = self.core.lock().unwrap();
            core.active.clear();
            core.starting.clear();
            core.replay_capture = None;
            core.replay_capture_ready_at = 0;
            core.machine_info_ready = false;
            Self::refresh_capture(&mut core);
            return;
        }
        let crash_settings = {
            let core = self.core.lock().unwrap();
            let was_starting = core.starting.contains_key("replay");
            let crashed = !disposed && matches!(code, Some(value) if value == 0xC0000005u32 as i32 || value == -1073741819);
            if crashed && !was_starting {
                core.active.get("replay").map(|recorder| recorder.settings.clone())
            } else { None }
        };
        {
            let mut core = self.core.lock().unwrap();
            core.state.available = false;
            core.active.clear();
            core.starting.clear();
            core.replay_capture = None;
            core.replay_capture_ready_at = 0;
            core.machine_info_ready = false;
            core.state.error = if disposed { None } else { Some(format!("Ascent exited ({})", code.map(|code| code.to_string()).unwrap_or_else(|| "unknown".into()))) };
            Self::refresh_capture(&mut core);
        }
        self.reject_pending(EngineError::message("Ascent process exited"));
        self.publish();
        if let Some(settings) = crash_settings {
            (self.crash)(settings);
        }
    }

    fn kill_child(&self) {
        *self.stdin.lock().unwrap() = None;
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn reject_pending(&self, error: EngineError) {
        if let Ok(mut pending) = self.pending.lock() {
            for (_, request) in pending.drain() { let _ = request.sender.send(Err(EngineError::message(error.message.clone()))); }
        }
    }

    fn request(self: &Arc<Self>, command: u64, recorder_type: u64, fields: Value, events: &[u64],
        timeout: Duration, requested_identifier: Option<u64>, accept_unidentified: bool) -> EngineResult<Value> {
        let settings = self.cached_settings();
        self.ensure_child(&settings)?;
        let identifier = requested_identifier.unwrap_or_else(|| self.next_identifier.fetch_add(1, Ordering::SeqCst));
        let mut payload = fields.as_object().cloned().unwrap_or_else(Map::new);
        payload.insert("cmd".into(), json!(command));
        payload.insert("identifier".into(), json!(identifier));
        payload.insert("recorder_type".into(), json!(recorder_type));
        let mut serialized = serde_json::to_vec(&Value::Object(payload)).map_err(|error| EngineError::message(error.to_string()))?;
        if serialized.len() > ASCENT_MAX_MESSAGE_BYTES { return Err(EngineError::message("Ascent command exceeded its 8096-byte safety bound")); }
        serialized.push(b'\n');
        let (sender, receiver) = mpsc::sync_channel(1);
        self.pending.lock().unwrap().insert(identifier, Pending {
            events: events.to_vec(), sender, accept_unidentified,
        });
        let write_result = {
            let mut stdin = self.stdin.lock().unwrap();
            match stdin.as_mut() {
                Some(stdin) => stdin.write_all(&serialized).and_then(|_| stdin.flush()).map_err(|error| error.to_string()),
                None => Err("Ascent stdin is unavailable".into()),
            }
        };
        if let Err(error) = write_result {
            self.pending.lock().unwrap().remove(&identifier);
            return Err(EngineError::message(error));
        }
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.pending.lock().unwrap().remove(&identifier);
                Err(EngineError::timeout())
            }
        }
    }

    fn handle_message(self: &Arc<Self>, message: Value) {
        let event = message.get("event").and_then(Value::as_u64);
        let Some(event) = event else { return };
        if matches!(event, EVENT_RECORDING_STARTED | EVENT_RECORDING_STOPPED | EVENT_ERR
            | EVENT_REPLAY_STARTED | EVENT_REPLAY_STOPPED | EVENT_REPLAY_ERROR) {
            diagnostic(&format!("event={event} id={:?} code={:?} desc={:?}",
                message.get("identifier").and_then(Value::as_u64),
                message.get("code").and_then(Value::as_i64),
                message.get("desc").and_then(Value::as_str)));
        }
        let identifier = message.get("identifier").and_then(Value::as_u64);
        let started = matches!(event, EVENT_RECORDING_STARTED | EVENT_REPLAY_STARTED);
        let stopped = matches!(event, EVENT_RECORDING_STOPPED | EVENT_REPLAY_STOPPED);
        let event_mode = if matches!(event, EVENT_REPLAY_STARTED | EVENT_REPLAY_STOPPED) { "replay" } else { "video" };
        let mut publish = false;
        let mut cancel_stop: Option<String> = None;
        {
            let mut core = self.core.lock().unwrap();
            if event == EVENT_READY {
                for recorder in core.starting.values_mut() {
                    if identifier.is_none() || identifier == Some(recorder.identifier) { recorder.ready = true; }
                }
            }
            if started {
                let found = if core.starting.contains_key(event_mode) {
                    core.starting.get(event_mode).cloned().map(|recorder| (recorder, true))
                } else {
                    core.active.get(event_mode).cloned().map(|recorder| (recorder, false))
                };
                if let Some((recorder, was_starting)) = found {
                    let mut active = recorder.clone();
                    active.started_at = if recorder.started_at > 0 { recorder.started_at } else { now_ms() };
                    core.active.insert(recorder.mode.clone(), active.clone());
                    if recorder.cancel_requested {
                        if let Some(entry) = core.starting.get_mut(&recorder.mode) { entry.started_after_cancel = true; }
                        if !recorder.stop_in_flight { cancel_stop = Some(recorder.mode.clone()); }
                    } else if was_starting {
                        core.starting.remove(&recorder.mode);
                    }
                    self.apm.start(&active.session_id, active.started_at);
                    Self::refresh_capture(&mut core);
                    core.state.error = None;
                    publish = true;
                }
            }
            if event == EVENT_REPLAY_CAPTURE_VIDEO_READY {
                if let Some(capture) = core.replay_capture.as_mut() {
                    if identifier == Some(capture.capture_identifier) || identifier == Some(capture.buffer_identifier) {
                        capture.phase = "ready".into();
                        core.replay_capture_ready_at = now_ms();
                    }
                }
            }
            if event == EVENT_REPLAY_STOPPED {
                core.replay_capture = None;
                core.replay_capture_ready_at = 0;
            }
            if stopped {
                if let Some(recorder) = core.active.get(event_mode).cloned()
                    .or_else(|| core.starting.get(event_mode).cloned()) {
                    let apm = self.apm.stop(&recorder.session_id);
                    if recorder.mode == "video" {
                        if let Some(output_path) = recorder.output_path.clone().filter(|path| !path.trim().is_empty()) {
                            let samples: Vec<Value> = apm.as_ref().and_then(|value| value["samples"].as_array()).cloned().unwrap_or_default()
                                .into_iter().map(|sample| json!({"atMs":sample["atMs"],"apm":sample["apm"]})).collect();
                            let values: Vec<f64> = samples.iter().filter_map(|sample| sample["apm"].as_f64()).collect();
                            let mut capture = json!({
                                "mode": recorder.mode,
                                "sessionId": recorder.session_id,
                                "outputPath": output_path,
                                "sourceStartMs": 0,
                                "sourceEndMs": (now_ms() - recorder.started_at).max(0),
                                "apmAvailable": apm.as_ref().and_then(|value| value["sourceReady"].as_bool()).unwrap_or(false),
                            });
                            if !samples.is_empty() {
                                capture["apmSamples"] = json!(samples);
                                capture["apmAverage"] = json!((values.iter().sum::<f64>() / values.len() as f64).round());
                                capture["apmPeak"] = json!(values.iter().cloned().fold(0.0, f64::max));
                            }
                            core.completed.push(capture);
                            if core.completed.len() > 8 { let excess = core.completed.len() - 8; core.completed.drain(0..excess); }
                        }
                    }
                    if identifier.is_none() || core.active.get(event_mode).map(|active| active.identifier) == identifier {
                        core.active.remove(event_mode);
                    }
                    if let Some(starting) = core.starting.get(event_mode) {
                        let stopped_active = core.active.get(event_mode).is_some();
                        if identifier.is_none() || identifier == Some(starting.identifier) || stopped_active {
                            core.starting.remove(event_mode);
                        }
                    }
                    Self::refresh_capture(&mut core);
                    publish = true;
                }
            }
            core.state.last_event = {
                let mut value = message.clone();
                value["at"] = json!(now_ms());
                value
            };
        }
        if publish { self.publish(); }
        if let Some(mode) = cancel_stop {
            let engine = self.clone();
            std::thread::spawn(move || {
                if let Err(error) = engine.stop_internal(Some(&mode)) {
                    let mut core = engine.core.lock().unwrap();
                    core.state.error = Some(format!("The recording started after cancellation and could not be stopped automatically: {error}. Stop recording manually."));
                    drop(core);
                    engine.publish();
                }
            });
        }
        let pending_match = {
            let pending = self.pending.lock().unwrap();
            identifier.and_then(|id| pending.get(&id).map(|_| id))
                .or_else(|| if identifier.is_none() {
                    pending.iter().find(|(_, request)| request.accept_unidentified && request.events.contains(&event)).map(|(id, _)| *id)
                } else { None })
        };
        let Some(pending_id) = pending_match else { return };
        let request = self.pending.lock().unwrap().remove(&pending_id);
        let Some(request) = request else { return };
        if matches!(event, EVENT_ERR | EVENT_REPLAY_ERROR) {
            let message_text = message.get("desc").and_then(Value::as_str)
                .map(str::to_owned).unwrap_or_else(|| format!("Ascent command failed ({})", message.get("code").and_then(Value::as_i64).unwrap_or(0)));
            let error = EngineError { message: message_text, code: message.get("code").and_then(Value::as_i64), timeout: false };
            let _ = request.sender.send(Err(error));
        } else if request.events.contains(&event) {
            let _ = request.sender.send(Ok(message));
        } else {
            self.pending.lock().unwrap().insert(pending_id, request);
        }
    }

    fn probe(self: &Arc<Self>, store: &NativeStore) -> EngineResult<Value> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.probe_internal(store)
    }

    fn probe_internal(self: &Arc<Self>, store: &NativeStore) -> EngineResult<Value> {
        let settings = super::services::recording_settings(store).map_err(EngineError::message)?;
        self.apply_cached_settings(&settings);
        let result = self.request(ASCENT_QUERY_MACHINE_INFO, RECORDER_VIDEO, json!({}),
            &[EVENT_QUERY_MACHINE_INFO], Duration::from_secs(15), None, true);
        match result {
            Ok(response) => {
                let encoders: Vec<Value> = response.get("vid_encs").and_then(Value::as_array).cloned().unwrap_or_default()
                    .into_iter().map(|encoder| {
                        let kind = encoder.get("type").and_then(Value::as_str).unwrap_or("").to_owned();
                        let target = encoder_adapter_target(&encoder);
                        let demoted = self.core.lock().map(|core| {
                            core.demoted.contains(&encoder_demotion_key(&kind, target.as_ref()))
                                || (target.is_none() && core.demoted.contains(&encoder_demotion_key(&kind, None)))
                        }).unwrap_or(false);
                        let valid = encoder.get("valid").and_then(Value::as_bool) == Some(true);
                        let mut output = encoder;
                        output["type"] = json!(kind);
                        output["enumerated"] = json!(true);
                        output["probeValid"] = json!(valid && !demoted);
                        output["startTested"] = json!(demoted);
                        output["startSupported"] = json!(valid && !demoted);
                        output["code"] = if demoted { json!(-8) } else { Value::Null };
                        output["status"] = json!(if demoted { "start rejected" } else if valid { "" } else { "invalid" });
                        output
                    }).collect();
                let audio_inputs = normalize_audio_devices(response.get("adio_in_devs").or_else(|| response.get("audio_in_devs")));
                let audio_outputs = normalize_audio_devices(response.get("adio_out_devs").or_else(|| response.get("audio_out_devs")));
                {
                    let mut core = self.core.lock().unwrap();
                    core.machine_info_ready = true;
                    core.state.encoders = encoders;
                    core.state.audio_inputs = audio_inputs;
                    core.state.audio_outputs = audio_outputs;
                    core.state.probe_complete = true;
                    core.state.error = None;
                }
                self.publish();
                Ok(self.snapshot())
            }
            Err(error) => {
                {
                    let mut core = self.core.lock().unwrap();
                    core.machine_info_ready = false;
                    core.state.available = false;
                    core.state.encoders.clear();
                    core.state.audio_inputs.clear();
                    core.state.audio_outputs.clear();
                    core.state.probe_complete = false;
                    core.state.error = Some(format!("Recording runtime check failed: {}", error.message));
                }
                self.publish();
                Err(error)
            }
        }
    }

    fn start(self: &Arc<Self>, store: &NativeStore, settings: &Value, mode: &str) -> EngineResult<Value> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.start_internal(store, settings, mode)
    }

    fn start_internal(self: &Arc<Self>, store: &NativeStore, settings: &Value, mode: &str) -> EngineResult<Value> {
        if mode != "video" && mode != "replay" { return Err(EngineError::message("Recording mode must be video or replay")); }
        {
            let core = self.core.lock().unwrap();
            if core.active.contains_key(mode) || core.starting.contains_key(mode) {
                return Err(EngineError::message(if mode == "replay" { "Instant Replay is already active or a previous start is still pending" } else { "Recording is already active or a previous start is still pending" }));
            }
        }
        self.apply_cached_settings(settings);
        self.prepare_fresh_child();
        if !self.core.lock().unwrap().machine_info_ready {
            self.probe_internal(store)?;
        }
        let selection = parse_encoder_selection(settings.get("encoderId").and_then(Value::as_str).unwrap_or("automatic"))?;
        let encoders = self.core.lock().unwrap().state.encoders.clone();
        let encoder_id = resolve_encoder(settings.get("encoderId").and_then(Value::as_str).unwrap_or("automatic"), &encoders, selection.as_ref())?;
        let mut adapter_target = selection.as_ref().and_then(|value| value.target.clone());
        let mut runtime_encoder = encoder_id.clone();
        if let Some(target) = adapter_target.clone() {
            if let Some((resolved, runtime)) = resolve_encoder_target(&target, &encoder_id) {
                adapter_target = Some(resolved);
                if let Some(runtime) = runtime { runtime_encoder = runtime; }
            } else {
                return Err(EngineError::message(format!("Encoder selection '{}' does not match a concrete adapter target reported by the recording runtime.", settings.get("encoderId").and_then(Value::as_str).unwrap_or("automatic"))));
            }
        }
        let demoted = self.core.lock().unwrap().demoted.clone();
        if demoted.contains(&encoder_demotion_key(&encoder_id, adapter_target.as_ref()))
            || demoted.contains(&encoder_demotion_key(&encoder_id, selection.as_ref().and_then(|value| value.target.as_ref()))) {
            return Err(unsupported_encoder_error(&encoder_id, &encoders));
        }
        let capture = capture_selection(settings);
        let mut effective = settings.clone();
        effective["encoderId"] = json!(encoder_id);
        effective["runtimeEncoderId"] = json!(runtime_encoder);
        effective["encoderTarget"] = adapter_target.clone().unwrap_or(Value::Null);
        effective["runtimeAdapterTarget"] = adapter_target.clone().unwrap_or(Value::Null);
        if let Some(object) = effective.as_object_mut() {
            for (key, value) in capture.as_object().cloned().unwrap_or_default() { object.insert(key, value); }
        }
        let recorder_type = if mode == "replay" { RECORDER_REPLAY } else { RECORDER_VIDEO };
        let output_path = settings.get("outputPath").and_then(Value::as_str).map(str::to_owned);
        diagnostic(&format!("start mode={mode} requested={} encoder={encoder_id} runtime={runtime_encoder} target={adapter_target:?} output={output_path:?}",
            settings.get("encoderId").and_then(Value::as_str).unwrap_or("automatic")));
        let payload = build_start_payload(&effective, output_path.as_deref().unwrap_or(""), recorder_type);
        let fields = payload.as_object().cloned().unwrap_or_default();
        let identifier = self.next_identifier.fetch_add(1, Ordering::SeqCst);
        let recorder = Recorder {
            identifier,
            recorder_type,
            mode: mode.into(),
            ready: false,
            session_id: format!("{mode}:{identifier}"),
            started_at: now_ms(),
            output_path,
            settings: settings.clone(),
            cancel_requested: false,
            stop_in_flight: false,
            started_after_cancel: false,
        };
        {
            let mut core = self.core.lock().unwrap();
            core.starting.insert(mode.into(), recorder.clone());
            Self::refresh_capture(&mut core);
            core.state.error = None;
        }
        self.apm.start(&recorder.session_id, recorder.started_at);
        self.publish();
        let command = Value::Object(fields);
        let expected = if mode == "replay" { EVENT_REPLAY_STARTED } else { EVENT_RECORDING_STARTED };
        match self.request(ASCENT_START, recorder_type, command, &[expected], Duration::from_secs(15), Some(identifier), false) {
            Ok(_) => {
                diagnostic("started");
                let target = selection.as_ref().and_then(|value| value.target.clone()).or(adapter_target);
                {
                    let mut core = self.core.lock().unwrap();
                    let successful = runtime_encoder.clone();
                    for encoder in core.state.encoders.iter_mut() {
                        if encoder["type"].as_str() == Some(successful.as_str()) && encoder_target_matches(encoder, target.as_ref()) {
                            encoder["startTested"] = json!(true);
                            encoder["startSupported"] = json!(true);
                            encoder["status"] = json!("started");
                        }
                    }
                    core.state.error = None;
                }
                if mode == "replay" { self.publish_instant("ready", None, None); } else { self.publish(); }
                Ok(self.snapshot())
            }
            Err(error) => {
                diagnostic(&format!("start-error code={:?} timedOut={} message={}", error.code, error.timeout, error.message));
                let timed_out_ready = {
                    let core = self.core.lock().unwrap();
                    core.starting.get(mode).is_some_and(|recorder| recorder.identifier == identifier && recorder.ready)
                };
                if timed_out_ready && error.timeout {
                    if let Some(recorder) = self.core.lock().unwrap().starting.get_mut(mode) { recorder.ready = true; }
                    let mut core = self.core.lock().unwrap();
                    core.state.error = Some("Recording start is still pending; stop to cancel it.".into());
                    drop(core);
                    self.publish();
                } else {
                    self.apm.stop(&recorder.session_id);
                    let mut core = self.core.lock().unwrap();
                    if core.starting.get(mode).is_some_and(|recorder| recorder.identifier == identifier) {
                        core.starting.remove(mode);
                        Self::refresh_capture(&mut core);
                    }
                    drop(core);
                    self.publish();
                }
                if error.is_encoder_rejection() {
                    let failed_target = selection.as_ref().and_then(|value| value.target.clone()).or(adapter_target);
                    let mut core = self.core.lock().unwrap();
                    core.demoted.insert(encoder_demotion_key(&encoder_id, failed_target.as_ref()));
                    for encoder in core.state.encoders.iter_mut() {
                        if encoder["type"].as_str() == Some(encoder_id.as_str()) && encoder_target_matches(encoder, failed_target.as_ref()) {
                            encoder["startTested"] = json!(true);
                            encoder["startSupported"] = json!(false);
                            encoder["probeValid"] = json!(false);
                            encoder["code"] = json!(error.code);
                            encoder["status"] = json!("start rejected");
                        }
                    }
                    drop(core);
                    let _ = store.invoke("recording-demote-encoder", &wire::encode_json(&json!([
                        settings.get("encoderId").cloned().unwrap_or_else(|| json!(encoder_id)),
                        failed_target.clone().unwrap_or(Value::Null),
                    ])).unwrap_or_else(|_| json!({"t":"array","v":[]})));
                    self.publish();
                }
                Err(error)
            }
        }
    }

    fn prepare_fresh_child(self: &Arc<Self>) {
        let should_close = {
            let core = self.core.lock().unwrap();
            core.fresh_child_required && core.active.is_empty() && core.starting.is_empty()
        };
        if should_close {
            self.core.lock().unwrap().fresh_child_required = false;
            self.close_child_gracefully();
        }
    }

    fn stop(self: &Arc<Self>, _store: &NativeStore, mode: Option<&str>) -> EngineResult<Value> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        self.stop_internal(mode)
    }

    fn stop_internal(self: &Arc<Self>, requested_mode: Option<&str>) -> EngineResult<Value> {
        if self.child.lock().map(|child| child.is_none()).unwrap_or(true) { return Ok(self.snapshot()); }
        let modes: Vec<String> = match requested_mode {
            Some("video" | "replay") => vec![requested_mode.unwrap().to_owned()],
            _ => vec!["video".into(), "replay".into()],
        };
        let recorder = {
            let core = self.core.lock().unwrap();
            modes.iter().find_map(|mode| core.active.get(mode).cloned().or_else(|| core.starting.get(mode).cloned()))
        };
        let Some(mut recorder) = recorder else { return Ok(self.snapshot()); };
        if recorder.stop_in_flight { return Ok(self.snapshot()); }
            let was_active = self.core.lock().unwrap().active.get(&recorder.mode).is_some_and(|active| active.identifier == recorder.identifier);
        if !was_active {
            let mut core = self.core.lock().unwrap();
            if let Some(starting) = core.starting.get_mut(&recorder.mode) {
                if starting.identifier == recorder.identifier { starting.cancel_requested = true; }
            }
        }
        recorder.stop_in_flight = true;
        {
            let mut core = self.core.lock().unwrap();
            if let Some(active) = core.active.get_mut(&recorder.mode) { active.stop_in_flight = true; }
            if let Some(starting) = core.starting.get_mut(&recorder.mode) { starting.stop_in_flight = true; }
        }
        let stop_event = if recorder.recorder_type == RECORDER_REPLAY { EVENT_REPLAY_STOPPED } else { EVENT_RECORDING_STOPPED };
        let result = self.request(ASCENT_STOP, recorder.recorder_type, json!({}), &[stop_event], Duration::from_secs(10), Some(recorder.identifier), false);
        if result.is_err() { return result.map(|_| self.snapshot()); }
        {
            let mut core = self.core.lock().unwrap();
            if was_active { core.active.remove(&recorder.mode); }
            if core.starting.get(&recorder.mode).is_some_and(|starting| starting.identifier == recorder.identifier) {
                core.starting.remove(&recorder.mode);
            }
            if was_active { core.fresh_child_required = true; }
            Self::refresh_capture(&mut core);
        }
        if recorder.mode == "replay" {
            self.publish_instant("idle", None, None);
        } else {
            self.publish();
        }
        result.map(|_| self.snapshot())
    }

    fn stop_replay_clip(self: &Arc<Self>, identifier: u64) -> EngineResult<Value> {
        self.request(ASCENT_STOP_REPLAY_CAPTURE, RECORDER_REPLAY, json!({}),
            &[EVENT_REPLAY_CAPTURE_VIDEO_READY], Duration::from_secs(10), Some(identifier), false)
    }

    fn recover_replay_capture(self: &Arc<Self>) -> bool {
        let capture = self.core.lock().unwrap().replay_capture.clone();
        let Some(capture) = capture else { return true; };
        if capture.phase == "ready" {
            self.core.lock().unwrap().replay_capture = None;
            return true;
        }
        match self.stop_replay_clip(capture.buffer_identifier) {
            Ok(_) => { self.core.lock().unwrap().replay_capture = None; true }
            Err(error) if replay_capture_not_ready(&error.message) => {
                self.core.lock().unwrap().replay_capture = None;
                true
            }
            Err(error) => {
                let mut core = self.core.lock().unwrap();
                if let Some(capture) = core.replay_capture.as_mut() { capture.phase = "unknown".into(); }
                core.state.error = Some(format!("Replay clip recovery failed: {}", error.message));
                drop(core);
                self.publish();
                false
            }
        }
    }

    fn save_replay_clip(self: &Arc<Self>, store: &NativeStore, path: &str, head_duration: i64, thumbnail_folder: &str) -> EngineResult<Value> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        if self.core.lock().unwrap().replay_save_in_flight {
            return Err(EngineError::message("Instant Replay is already being saved"));
        }
        self.core.lock().unwrap().replay_save_in_flight = true;
        self.apply_cached_settings(&super::services::recording_settings(store).unwrap_or_else(|_| json!({})));
        let result = self.save_replay_internal(store, path, head_duration, thumbnail_folder, 0);
        self.core.lock().unwrap().replay_save_in_flight = false;
        result
    }

    fn save_replay_internal(self: &Arc<Self>, store: &NativeStore, path: &str, duration: i64, thumbnail_folder: &str, recovery_attempt: u32) -> EngineResult<Value> {
        let mut active = self.core.lock().unwrap().active.get("replay").cloned();
        let fail = |message: String| -> EngineError {
            self.publish_instant("error", Some(&message), None);
            EngineError::message(message)
        };
        let Some(recorder) = active.clone() else {
            return Err(fail("Start Instant Replay before saving a moment".into()));
        };
        if recorder.recorder_type != RECORDER_REPLAY { return Err(fail("Start Instant Replay before saving a moment".into())); }
        if duration <= 0 { return Err(fail("Instant Replay duration must be greater than zero".into())); }
        let has_capture = self.core.lock().unwrap().replay_capture.is_some();
        if has_capture && !self.recover_replay_capture() {
            if !self.restart_replay_buffer_after_failure(store, None) {
                return Err(fail("An Instant Replay save is still being finalized; stop and restart Instant Replay before trying again".into()));
            }
            active = self.core.lock().unwrap().active.get("replay").cloned();
            if active.is_none() { return Err(fail("Instant Replay restarted, but its buffer is not active yet".into())); }
        }
        let Some(active) = active else { return Err(fail("Instant Replay is not active".into())); };
        let buffer_identifier = active.identifier;
        let capture_identifier = self.next_identifier.fetch_add(1, Ordering::SeqCst);
        let initial_existed = usable_file(Path::new(path));
        let native_path = format!("{path}.arc-native-{capture_identifier}.mp4");
        self.publish_instant("saving", None, None);
        {
            let mut core = self.core.lock().unwrap();
            core.replay_capture = Some(ReplayCapture { buffer_identifier, capture_identifier, phase: "starting".into() });
        }
        let result = (|| -> EngineResult<Value> {
            let capture_duration = replay_capture_duration(duration, active.settings.get("replayLengthSec"));
            self.start_replay_capture_with_retry(&native_path, capture_duration, thumbnail_folder, buffer_identifier, capture_identifier)?;
            std::thread::sleep(Duration::from_millis(REPLAY_CAPTURE_START_SETTLE_MS));
            let response = self.stop_replay_clip(buffer_identifier)?;
            let source = resolve_replay_source(&response, &native_path, path, initial_existed);
            let bounded = self.enforce_duration_with_recovery(store, &source, duration, path)?;
            {
                let mut core = self.core.lock().unwrap();
                core.replay_capture = None;
            }
            if source != bounded { let _ = std::fs::remove_file(&source); }
            self.publish_instant("ready", None, Some(&bounded));
            let refreshed = self.core.lock().unwrap().active.get("replay").cloned();
            Ok(replay_ready_payload(&response, refreshed.as_ref().or(Some(&active)), &bounded, thumbnail_folder, duration, &self.apm))
        })();
        match result {
            Ok(value) => Ok(value),
            Err(error) => {
                let source = resolve_replay_source(&json!({}), &native_path, path, initial_existed);
                let completed = wait_for_file(Path::new(&source), REPLAY_FILE_WAIT_MS as u64);
                let capture = self.core.lock().unwrap().replay_capture.clone();
                if completed && capture.as_ref().is_some_and(|capture| capture.buffer_identifier == buffer_identifier && matches!(capture.phase.as_str(), "capturing" | "ready")) {
                    if let Ok(bounded) = self.enforce_duration_with_recovery(store, &source, duration, path) {
                        self.core.lock().unwrap().replay_capture = None;
                        self.publish_instant("ready", None, Some(&bounded));
                        let refreshed = self.core.lock().unwrap().active.get("replay").cloned();
                        return Ok(replay_ready_payload(&json!({"event":EVENT_REPLAY_CAPTURE_VIDEO_READY,"identifier":buffer_identifier}),
                            refreshed.as_ref().or(Some(&active)), &bounded, thumbnail_folder, duration, &self.apm));
                    }
                }
                if recovery_attempt == 0 && replay_capture_not_ready(&error.message) && active.settings.is_object() {
                    if self.restart_replay_buffer_after_failure(store, Some(&active.settings)) {
                        let _ = std::fs::remove_file(&native_path);
                        return self.save_replay_internal(store, path, duration, thumbnail_folder, recovery_attempt + 1);
                    }
                }
                if capture.as_ref().is_some_and(|capture| capture.buffer_identifier == buffer_identifier) {
                    if !self.recover_replay_capture() { let _ = self.restart_replay_buffer_after_failure(store, Some(&active.settings)); }
                } else {
                    self.core.lock().unwrap().replay_capture = None;
                }
                for candidate in [&native_path, &source] {
                    if candidate != path { let _ = std::fs::remove_file(candidate); }
                }
                if path != source { let _ = std::fs::remove_file(path); }
                Err(fail(error.message))
            }
        }
    }

    fn start_replay_capture_with_retry(self: &Arc<Self>, path: &str, duration: i64, thumbnail_folder: &str,
        buffer_identifier: u64, capture_identifier: u64) -> EngineResult<()> {
        let deadline = Instant::now() + Duration::from_millis(REPLAY_CAPTURE_RETRY_MS);
        loop {
            {
                let mut core = self.core.lock().unwrap();
                core.replay_capture = Some(ReplayCapture { buffer_identifier, capture_identifier, phase: "starting".into() });
            }
            let recent = {
                let core = self.core.lock().unwrap();
                core.replay_capture_ready_at > 0 && now_ms() - core.replay_capture_ready_at <= REPLAY_CAPTURE_RETRY_MS as i64
            };
            let timeout = if recent { Duration::from_secs(3) } else { Duration::from_secs(10) };
            match self.request(ASCENT_START_REPLAY_CAPTURE, RECORDER_REPLAY, json!({
                "path": path,
                "head_duration": duration,
                "thumbnail_folder": thumbnail_folder,
            }), &[EVENT_REPLAY_CAPTURE_VIDEO_STARTED], timeout, Some(capture_identifier), false) {
                Ok(_) => {
                    if let Some(capture) = self.core.lock().unwrap().replay_capture.as_mut() { capture.phase = "capturing".into(); }
                    self.core.lock().unwrap().replay_capture_ready_at = 0;
                    return Ok(());
                }
                Err(error) => {
                    let transient = replay_capture_already_active(&error.message)
                        || replay_capture_not_ready(&error.message)
                        || (error.timeout && recent);
                    if !transient || Instant::now() >= deadline { return Err(error); }
                    if replay_capture_already_active(&error.message) { let _ = self.stop_replay_clip(buffer_identifier); }
                    self.core.lock().unwrap().replay_capture = None;
                    std::thread::sleep(Duration::from_millis(REPLAY_CAPTURE_RETRY_DELAY_MS));
                }
            }
        }
    }

    fn restart_replay_buffer_after_failure(self: &Arc<Self>, store: &NativeStore, settings_override: Option<&Value>) -> bool {
        let replay = self.core.lock().unwrap().active.get("replay").cloned();
        let settings = replay.as_ref().map(|recorder| recorder.settings.clone()).or_else(|| settings_override.cloned());
        let Some(settings) = settings else { return false; };
        let stop_error = self.stop_internal_quiet(Some("replay"));
        if let Err(error) = stop_error {
            let video_active = {
                let core = self.core.lock().unwrap();
                core.active.contains_key("video") || core.starting.contains_key("video")
            };
            if video_active {
                let mut core = self.core.lock().unwrap();
                core.state.error = Some(format!("Replay capture recovery could not stop the shared runtime: {error}"));
                drop(core);
                self.publish();
                return false;
            }
            self.kill_child();
            let mut core = self.core.lock().unwrap();
            core.active.remove("replay");
            core.starting.remove("replay");
            core.replay_capture = None;
            core.replay_capture_ready_at = 0;
            core.fresh_child_required = false;
            core.machine_info_ready = false;
            Self::refresh_capture(&mut core);
            drop(core);
        }
        self.core.lock().unwrap().replay_capture = None;
        self.core.lock().unwrap().replay_capture_ready_at = 0;
        match self.start_internal(store, &settings, "replay") {
            Ok(_) => true,
            Err(error) => {
                let mut core = self.core.lock().unwrap();
                core.state.error = Some(format!("Instant Replay could not restart after capture finalization failed: {}", error.message));
                drop(core);
                self.publish();
                false
            }
        }
    }

    fn stop_internal_quiet(self: &Arc<Self>, mode: Option<&str>) -> Result<Value, String> {
        self.stop_internal(mode).map_err(|error| error.message)
    }

    fn enforce_duration_with_recovery(self: &Arc<Self>, store: &NativeStore, source: &str, duration: i64, destination: &str) -> EngineResult<String> {
        let deadline = Instant::now() + Duration::from_millis(REPLAY_TRIM_RETRY_MS);
        loop {
            if !wait_for_file(Path::new(source), REPLAY_FILE_WAIT_MS as u64) {
                if Instant::now() >= deadline { break; }
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
            match trim_to_duration(store, Path::new(source), duration, Path::new(destination)) {
                Ok(result) => return Ok(result.path),
                Err(error) => {
                    if Instant::now() >= deadline { return Err(EngineError::message(error)); }
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        }
        Err(EngineError::message("Replay clip could not be limited to the requested duration"))
    }

    fn shutdown_if_idle(self: &Arc<Self>, _store: &NativeStore, memory_saving: bool) -> EngineResult<Value> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        if !memory_saving || self.demand.load(Ordering::Acquire) > 0 { return Ok(self.snapshot()); }
        let should_close = {
            let core = self.core.lock().unwrap();
            core.active.is_empty() && core.starting.is_empty() && core.replay_capture.is_none() && !core.replay_save_in_flight
                && (core.state.available || core.state.probe_complete || !core.state.encoders.is_empty())
        };
        if !should_close { return Ok(self.snapshot()); }
        self.close_child_gracefully();
        {
            let mut core = self.core.lock().unwrap();
            core.state.available = false;
            core.state.encoders.clear();
            core.state.audio_inputs.clear();
            core.state.audio_outputs.clear();
            core.state.probe_complete = false;
            core.state.instant_replay_save = replay_save_state("idle", None, None, None);
            core.state.error = Some(IDLE_MESSAGE.into());
            core.machine_info_ready = false;
            core.fresh_child_required = false;
            core.replay_capture = None;
            core.replay_capture_ready_at = 0;
            Self::refresh_capture(&mut core);
        }
        self.publish();
        Ok(self.snapshot())
    }

    fn shutdown(self: &Arc<Self>, _store: &NativeStore) -> EngineResult<Value> {
        let _lifecycle = self.lifecycle.lock().unwrap();
        {
            let mut core = self.core.lock().unwrap();
            core.disposed = true;
        }
        if self.child.lock().map(|child| child.is_some()).unwrap_or(false) {
            let _ = self.stop_internal(None);
            self.close_child_gracefully();
        }
        self.reject_pending(EngineError::message("Ascent engine shut down"));
        Ok(self.snapshot())
    }

    fn close_child_gracefully(self: &Arc<Self>) {
        if self.child.lock().map(|child| child.is_none()).unwrap_or(true) { return; }
        self.core.lock().unwrap().retiring = true;
        let identifier = self.next_identifier.fetch_add(1, Ordering::SeqCst);
        let payload = json!({"cmd":ASCENT_SHUTDOWN,"identifier":identifier,"recorder_type":RECORDER_VIDEO});
        if let Ok(mut serialized) = serde_json::to_vec(&payload) {
            serialized.push(b'\n');
            if let Ok(mut stdin) = self.stdin.lock() {
                if let Some(stdin) = stdin.as_mut() { let _ = stdin.write_all(&serialized).and_then(|_| stdin.flush()); }
            }
        }
        let deadline = Instant::now() + Duration::from_millis(1_500);
        loop {
            let status = self.child.lock().unwrap().as_mut().and_then(|child| child.try_wait().ok().flatten());
            if status.is_some() || Instant::now() >= deadline { break; }
            std::thread::sleep(Duration::from_millis(25));
        }
        self.kill_child();
        {
            let mut core = self.core.lock().unwrap();
            core.machine_info_ready = false;
            core.retiring = false;
        }
        self.reject_pending(EngineError::message("Ascent process restarted"));
    }
}

// Restart keeps the caller's store so encoder demotion and settings remain
// bound to the same fixed native root.

#[derive(Default)]
struct Utf8Stream { pending: Vec<u8> }
impl Utf8Stream {
    fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        match std::str::from_utf8(&self.pending) {
            Ok(text) => { let text = text.to_owned(); self.pending.clear(); text }
            Err(error) => {
                let valid = error.valid_up_to();
                let text = String::from_utf8_lossy(&self.pending[..valid]).into_owned();
                self.pending.drain(..valid);
                if error.error_len().is_some() {
                    self.pending.remove(0);
                    let extra = String::from_utf8_lossy(&self.pending).into_owned();
                    self.pending.clear();
                    return format!("{text}{extra}");
                }
                text
            }
        }
    }
}

pub fn filter_recording_stderr(text: &str) -> String {
    text.split(['\r', '\n']).map(str::trim)
        .filter(|line| !line.is_empty() && !line.to_ascii_lowercase().contains("qavg") && !line.to_ascii_lowercase().contains("frames left in the queue on closing"))
        .collect::<Vec<_>>().join("\n")
}

fn normalize_audio_devices(value: Option<&Value>) -> Vec<Value> {
    let Some(items) = value.and_then(Value::as_array) else { return Vec::new() };
    items.iter().enumerate().filter_map(|(index, item)| {
        let object = item.as_object().cloned().unwrap_or_default();
        let pair = if object.len() == 1 && !object.contains_key("device_id") && !object.contains_key("deviceId") && !object.contains_key("id") && !object.contains_key("name") {
            object.iter().next().map(|(key, value)| (key.clone(), value.clone()))
        } else { None };
        let raw = object.get("device_id").or_else(|| object.get("id")).or_else(|| object.get("deviceId"))
            .and_then(Value::as_str).map(str::to_owned)
            .or_else(|| pair.as_ref().and_then(|(_, value)| value.as_str()).map(str::to_owned))
            .or_else(|| item.as_str().map(str::to_owned)).unwrap_or_default();
        let device_id = if raw.eq_ignore_ascii_case("default") { String::new() } else { raw.chars().take(512).collect() };
        let name: String = if !device_id.is_empty() {
            object.get("name").or_else(|| object.get("description")).and_then(Value::as_str)
                .map(str::to_owned).or_else(|| pair.as_ref().map(|(key, _)| key.clone()))
                .unwrap_or_else(|| format!("Audio device {}", index + 1)).chars().take(512).collect()
        } else { "Default device".into() };
        Some(json!({"id": if device_id.is_empty() { format!("audio-default-{index}") } else { device_id.clone() }, "deviceId": device_id, "name": name}))
    }).filter(|item| item["deviceId"].as_str().is_some_and(|value| !value.is_empty()) || item["name"].as_str() != Some("")).collect()
}

fn json_u64(value: &Value) -> Option<u64> {
    value.as_u64().or_else(|| value.as_f64().filter(|value| value.is_finite() && *value >= 0.0 && *value <= u32::MAX as f64).map(|value| value as u64))
}

fn capture_sources(settings: &Value) -> Value {
    let source = settings.get("captureSource").cloned().unwrap_or_else(|| json!({}));
    let cursor = settings.get("showCursor").and_then(Value::as_bool) == Some(true);
    let window_handle = source.get("windowHandle").and_then(json_u64).unwrap_or(0);
    if source.get("type").and_then(Value::as_str) == Some("window") && window_handle > 0 {
        return json!({
            "monitor": {"enable":false,"force":false,"cursor":cursor,"monitor_handle":0},
            "window_capture": {"enable":true,"force":true,"cursor":cursor,"window_handle":window_handle},
        });
    }
    let monitor = source.get("monitorHandle").and_then(json_u64).unwrap_or(0);
    json!({"monitor":{"enable":true,"force":false,"cursor":cursor,"monitor_handle":monitor}})
}

fn color_settings(settings: &Value) -> Value {
    let mode = settings.get("captureColorMode").and_then(Value::as_str).unwrap_or("auto");
    let hdr = mode == "hdr" || (mode != "sdr" && settings.get("captureHdr").and_then(Value::as_bool) == Some(true));
    if hdr { json!({"color_format":"P010","color_space":"Rec2100PQ"}) }
    else { json!({"color_format":"NV12","color_space":"Rec709"}) }
}

fn encoder_profile(encoder: &str) -> &'static str {
    if encoder.contains("qsv11_v2") || encoder.contains("qsv11_soft_v2") || encoder.contains("qsv_vpl_h264") { "high" } else { "main" }
}

pub fn build_start_payload(settings: &Value, output_path: &str, recorder_type: u64) -> Value {
    let capture_width = settings.get("captureWidth").or_else(|| settings.get("baseWidth")).and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0).map(|value| value.round().max(2.0)).unwrap_or(1920.0);
    let capture_height = settings.get("captureHeight").or_else(|| settings.get("baseHeight")).and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value > 0.0).map(|value| value.round().max(2.0)).unwrap_or(1080.0);
    let resolution = settings.get("resolution").and_then(Value::as_str).unwrap_or("1080p");
    let output = contract::recording_output_dimensions(resolution, Some(&json!(capture_width)), Some(&json!(capture_height)));
    let encoder = settings.get("runtimeEncoderId").and_then(Value::as_str)
        .or_else(|| settings.get("encoderId").and_then(Value::as_str)).unwrap_or("obs_qsv11_av1");
    let selection = parse_encoder_selection(settings.get("encoderId").and_then(Value::as_str).unwrap_or("automatic")).ok().flatten();
    let runtime_target = normalized_target(settings.get("runtimeAdapterTarget"));
    let target = normalized_target(settings.get("encoderTarget")).or_else(|| selection.and_then(|value| value.target));
    let adapter_payload = runtime_target.as_ref().and_then(|value| value.get("luid")).filter(|value| !value.is_null())
        .map(|luid| json!({"luid":luid}))
        .or_else(|| target.map(|value| {
            let mut object = Map::new();
            if let Some(key) = value.get("deviceKey").filter(|value| value.is_string()) { object.insert("device_key".into(), key.clone()); }
            if let Some(bdf) = value.get("bdf").filter(|value| !value.is_null()) { object.insert("bdf".into(), bdf.clone()); }
            if let Some(luid) = value.get("luid").filter(|value| !value.is_null()) { object.insert("luid".into(), luid.clone()); }
            Value::Object(object)
        }));
    let rate = settings.get("rateControl").and_then(Value::as_str).unwrap_or("CBR");
    let h264 = encoder.contains("qsv11_v2") || encoder.contains("qsv11_soft_v2") || encoder.contains("qsv_vpl_h264");
    let quality = settings.get("rateControlQuality").and_then(Value::as_f64).unwrap_or(23.0);
    let plugin_encoder = encoder.starts_with("obs_qsv_vpl_");
    let mut video_encoder = if plugin_encoder {
        // obs-qsvonevpl uses its own target-usage vocabulary and oneVPL option
        // names; the OBS-style preset/latency keys are ignored by that plugin.
        json!({
            "id": encoder,
            "target_usage": "TU4 (Balanced)",
            "rate_control": rate,
            "profile": encoder_profile(encoder),
            "keyint_sec": if h264 { 1 } else { 2 },
            "gop_ref_dist": if h264 { 1 } else { 4 },
            "async_depth": 4,
            "low_power": "ON",
        })
    } else {
        json!({
            "id": encoder,
            "preset": "quality",
            "target_usage": "quality",
            "rate_control": rate,
            "cbr": rate == "CBR",
            "profile": encoder_profile(encoder),
            "keyint_sec": if h264 { 1 } else { 2 },
            "latency": "normal",
            "bframes": if h264 { 0 } else { 3 },
            "enhancements": true,
        })
    };
    if rate == "CBR" || rate == "VBR" {
        video_encoder["bitrate"] = settings.get("bitrateKbps").cloned().unwrap_or(json!(8000));
        video_encoder["max_bitrate"] = if rate == "CBR" { settings.get("bitrateKbps").cloned().unwrap_or(json!(8000)) }
            else { settings.get("maxBitrateKbps").cloned().unwrap_or(json!(8000)) };
    }
    if rate == "CQP" { video_encoder["cqp"] = json!(quality.min(if encoder.contains("av1") { 63.0 } else { 51.0 })); }
    if rate == "ICQ" { video_encoder["icq_quality"] = json!(quality.min(51.0)); }
    if let Some(payload) = adapter_payload.clone() { video_encoder["adapter_target"] = payload.clone(); }
    let mut video_settings = json!({
        "fps": settings.get("fps").cloned().unwrap_or(json!(60)),
        "base_width": capture_width,
        "base_height": capture_height,
        "output_width": output["width"],
        "output_height": output["height"],
        "extra_options": color_settings(settings),
        "video_encoder": video_encoder,
    });
    if let Some(payload) = adapter_payload { video_settings["adapter_target"] = payload; }
    let mut payload = json!({
        "sources": capture_sources(settings),
        "video_settings": video_settings,
        "audio_settings": build_audio_settings(settings),
    });
    if recorder_type == RECORDER_VIDEO {
        payload["file_output"] = json!({"filename":output_path,"format":"mp4","max_file_size_bytes":0,"enbale_on_demand_spilt_video":false,"include_full_video":true});
    } else {
        let replay = settings.get("replayLengthSec").and_then(Value::as_f64).map(|value| value.ceil().max(1.0) + 1.0)
            .unwrap_or(31.0);
        payload["replay"] = json!({"max_time_sec": replay});
    }
    payload
}

pub fn build_audio_settings(settings: &Value) -> Value {
    let audio = contract::normalize_recording_audio_settings(settings.get("audio"));
    let microphone = &audio["microphone"];
    let system = &audio["system"];
    let input_id = microphone.get("deviceId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("default");
    let output_id = system.get("deviceId").and_then(Value::as_str).filter(|value| !value.trim().is_empty()).unwrap_or("default");
    let custom = audio.get("sourceMode").and_then(Value::as_str) == Some("custom");
    let output_enabled = system.get("enabled").and_then(Value::as_bool) == Some(true) && !custom;
    let percent = |value: Option<&Value>| -> i64 { ((value.and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 1.0)) * 100.0).round() as i64 };
    let input_volume = percent(microphone.get("volume"));
    let output_volume = percent(system.get("volume"));
    json!({
        "sample_rate": 48000,
        "mono": false,
        "input": {"type":"wasapi_input_capture","device_id":input_id,"enable":microphone.get("enabled").and_then(Value::as_bool).unwrap_or(false),"volume":input_volume,"mono":microphone.get("mono").and_then(Value::as_bool).unwrap_or(false)},
        "output": {"type":"wasapi_output_capture","device_id":output_id,"enable":output_enabled,"volume":output_volume,"mono":false},
        "extra_options": {
            "sample_rate": 48000,
            "source_mode": audio.get("sourceMode").cloned().unwrap_or_else(|| json!("system")),
            "audio_sources": [
                {"type":1,"device_id":input_id,"name":"input_mic","enable":microphone.get("enabled").and_then(Value::as_bool).unwrap_or(false),"volume":input_volume,"mono":microphone.get("mono").and_then(Value::as_bool).unwrap_or(false),"use_device_timing":false,"tracks":5},
                {"type":0,"device_id":output_id,"name":"output_game","enable":output_enabled,"volume":output_volume,"mono":false,"use_device_timing":true,"tracks":3},
            ],
            "audio_capture_process2": audio.get("customProcesses").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().map(|process| json!({
                "process_name": process,
                "enable": custom,
                "volume": output_volume,
                "mono": false,
                "tracks": 3,
            })).collect::<Vec<_>>(),
        },
    })
}

fn capture_selection(settings: &Value) -> Value {
    let target = contract::normalize_recording_capture_target(settings.get("captureTarget"));
    let targets = super::capture_targets::capture_targets().unwrap_or_else(|_| json!({"displays":[],"windows":[]}));
    let displays = targets.get("displays").and_then(Value::as_array).cloned().unwrap_or_default();
    let windows = targets.get("windows").and_then(Value::as_array).cloned().unwrap_or_default();
    if target["type"] == "window" {
        let handle = target["windowHandle"].as_f64().filter(|value| value.is_finite() && *value >= 0.0).map(|value| value as u64).unwrap_or(0);
        if let Some(window) = windows.iter().find(|window| window["handle"].as_u64() == Some(handle) && window_identity_matches(window, &target)) {
            return json!({
                "captureTarget": target,
                "captureWidth": window["width"],
                "captureHeight": window["height"],
                "captureSource": {"type":"window","windowHandle":handle},
                "captureHdr": false,
            });
        }
    }
    let display = if target["displayId"].as_str() == Some("primary") {
        displays.iter().find(|display| display["primary"].as_bool() == Some(true)).or_else(|| displays.first())
    } else {
        displays.iter().find(|display| display["id"] == target["displayId"])
    };
    if let Some(display) = display {
        return json!({
            "captureTarget": {"type":"display","displayId":display["id"],"windowHandle":0,"processName":"","executablePath":"","windowTitle":"","windowClass":""},
            "captureWidth": display["width"],
            "captureHeight": display["height"],
            "captureSource": {"type":"display","monitorHandle":display["handle"]},
            "captureHdr": display["hdr"].as_bool() == Some(true),
        });
    }
    json!({
        "captureTarget": {"type":"display","displayId":"primary","windowHandle":0,"processName":"","executablePath":"","windowTitle":"","windowClass":""},
        "captureWidth": 1920,
        "captureHeight": 1080,
        "captureSource": {"type":"display","monitorHandle":0},
        "captureHdr": false,
    })
}

fn window_identity_matches(window: &Value, target: &Value) -> bool {
    let text = |value: &Value, key: &str| value.get(key).and_then(Value::as_str).unwrap_or("").trim().to_ascii_lowercase();
    let path = |value: &Value, key: &str| text(value, key).replace('/', "\\");
    let has_identity = !text(target, "executablePath").is_empty() || !text(target, "processName").is_empty();
    if has_identity {
        if !target["executablePath"].as_str().unwrap_or("").is_empty() && !window["executablePath"].as_str().unwrap_or("").is_empty() {
            if path(target, "executablePath") != path(window, "executablePath") { return false; }
        } else if !text(target, "processName").is_empty() && text(target, "processName") != text(window, "processName") {
            return false;
        }
    } else if text(target, "windowTitle").is_empty() || text(target, "windowTitle") != text(window, "title") {
        return false;
    }
    text(target, "windowClass").is_empty() || text(window, "windowClass").is_empty() || text(target, "windowClass") == text(window, "windowClass")
}

#[derive(Clone)]
struct EncoderSelection { codec: String, target: Option<Value> }

fn parse_encoder_selection(value: &str) -> EngineResult<Option<EncoderSelection>> {
    let Some(encoded) = value.strip_prefix(SELECTION_PREFIX) else { return Ok(None) };
    let parsed: Value = (|| {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(encoded.trim_end_matches('=')).ok()?;
        serde_json::from_slice(&bytes).ok()
    })().or_else(|| {
        percent_decode(encoded).and_then(|text| serde_json::from_str(&text).ok())
    }).ok_or_else(|| EngineError::message(format!("Encoder selection '{value}' is malformed or does not contain a stable physical adapter target.")))?;
    let codec = parsed.get("codec").or_else(|| parsed.get("c")).and_then(Value::as_str)
        .ok_or_else(|| EngineError::message(format!("Encoder selection '{value}' is malformed or does not contain a stable physical adapter target.")))?;
    if !QSV_PREFERENCE.contains(&codec) {
        return Err(EngineError::message(format!("Encoder selection '{value}' is malformed or does not contain a stable physical adapter target.")));
    }
    let compact = json!({
        "deviceKey": parsed.get("k").filter(|value| value.is_string()),
        "bdf": parsed.get("b").filter(|value| value.is_array()),
        "luid": parsed.get("l").cloned().unwrap_or(Value::Null),
    });
    let target = normalized_target(Some(parsed.get("target").filter(|value| !value.is_null()).unwrap_or(&compact)))
        .ok_or_else(|| EngineError::message(format!("Encoder selection '{value}' is malformed or does not contain a stable physical adapter target.")))?;
    Ok(Some(EncoderSelection { codec: codec.to_owned(), target: Some(target) }))
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() { return None; }
            let high = (bytes[index + 1] as char).to_digit(16)?;
            let low = (bytes[index + 2] as char).to_digit(16)?;
            output.push((high * 16 + low) as u8);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).ok()
}

fn normalized_target(value: Option<&Value>) -> Option<Value> {
    let value = value?;
    if !value.is_object() && !value.is_array() { return None; }
    let key = value.get("deviceKey").or_else(|| value.get("device_key")).or_else(|| value.get("k"))
        .and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    let bdf_raw = value.get("bdf").or_else(|| value.get("b"));
    let bdf = if let Some(array) = bdf_raw.and_then(Value::as_array) {
        Some(json!({"domain":array.first().and_then(Value::as_u64).unwrap_or(0),"bus":array.get(1).and_then(Value::as_u64),"device":array.get(2).and_then(Value::as_u64),"function":array.get(3).and_then(Value::as_u64)}))
    } else if let Some(object) = bdf_raw.filter(|value| value.is_object()) {
        Some(json!({"domain":object.get("domain").and_then(Value::as_u64).unwrap_or(0),"bus":object.get("bus").and_then(Value::as_u64),"device":object.get("device").and_then(Value::as_u64),"function":object.get("function").or_else(|| object.get("func")).and_then(Value::as_u64).unwrap_or(0)}))
    } else { None };
    let luid = value.get("luid").or_else(|| value.get("adapterLuid")).or_else(|| value.get("adapter_luid")).or_else(|| value.get("l")).cloned().unwrap_or(Value::Null);
    if key.is_none() && bdf.is_none() && luid.is_null() { return None; }
    let mut output = Map::new();
    if let Some(key) = key { output.insert("deviceKey".into(), json!(key)); }
    if let Some(bdf) = bdf { output.insert("bdf".into(), bdf); }
    if !luid.is_null() { output.insert("luid".into(), luid); }
    Some(Value::Object(output))
}

fn encoder_adapter_target(encoder: &Value) -> Option<Value> {
    normalized_target(encoder.get("adapter_target").or_else(|| encoder.get("adapterTarget")).or_else(|| encoder.get("target")))
        .or_else(|| normalized_target(Some(encoder)))
}

fn encoder_demotion_key(codec: &str, target: Option<&Value>) -> String {
    format!("{codec}|{}", target.map(|value| value.to_string()).unwrap_or_else(|| "legacy".into()))
}

fn encoder_target_matches(encoder: &Value, target: Option<&Value>) -> bool {
    let runtime = encoder_adapter_target(encoder);
    match runtime {
        Some(runtime) => target.and_then(|value| normalized_target(Some(value))).is_some_and(|target| targets_match(&runtime, &target)),
        None => target.and_then(|value| normalized_target(Some(value))).is_none(),
    }
}

fn targets_match(left: &Value, right: &Value) -> bool {
    let mut compared = false;
    if let (Some(left), Some(right)) = (left.get("deviceKey").and_then(Value::as_str), right.get("deviceKey").and_then(Value::as_str)) {
        compared = true;
        if left != right { return false; }
    }
    if left.get("bdf").is_some() && right.get("bdf").is_some() {
        compared = true;
        if left["bdf"] != right["bdf"] { return false; }
    }
    if let (Some(left), Some(right)) = (left.get("luid").filter(|value| !value.is_null()), right.get("luid").filter(|value| !value.is_null())) {
        compared = true;
        if left != right { return false; }
    }
    compared
}

fn is_usable(encoder: &Value) -> bool {
    encoder["enumerated"].as_bool() == Some(true) && encoder["probeValid"].as_bool() == Some(true) && encoder["startSupported"].as_bool() == Some(true)
}

fn unsupported_encoder_error(requested: &str, encoders: &[Value]) -> EngineError {
    let available: Vec<&str> = encoders.iter().filter(|encoder| is_usable(encoder)).filter_map(|encoder| encoder["type"].as_str()).collect();
    let suffix = if available.is_empty() { " The runtime did not report a usable Intel QSV encoder.".to_owned() } else { format!(" Usable encoders: {}.", available.join(", ")) };
    EngineError::message(if requested == "automatic" {
        format!("Intel AV1 is not available from the bundled ascent-obs runtime. Select Intel H264 or Intel HEVC explicitly if you want to use another codec.{suffix}")
    } else {
        format!("Encoder '{requested}' is not valid or start-supported by the bundled ascent-obs runtime. Select a valid H264, HEVC, or AV1 encoder.{suffix}")
    })
}

fn resolve_encoder(requested: &str, encoders: &[Value], selection: Option<&EncoderSelection>) -> EngineResult<String> {
    let codec = selection.map(|value| value.codec.as_str()).unwrap_or(requested);
    if codec == "automatic" {
        // Prefer the bundled obs-qsvonevpl texture encoders (the actively used
        // Intel path with the better quality controls), then fall back to the
        // built-in QSV encoders.
        for candidate in ["obs_qsv_vpl_av1_tex", "obs_qsv_vpl_av1", "obs_qsv11_av1"] {
            if encoders.iter().any(|encoder| encoder["type"].as_str() == Some(candidate) && is_usable(encoder)) {
                return Ok(candidate.into());
            }
        }
        return Err(unsupported_encoder_error(codec, encoders));
    }
    if !QSV_PREFERENCE.contains(&codec) || !encoders.iter().any(|encoder| encoder["type"].as_str() == Some(codec) && is_usable(encoder)) {
        return Err(unsupported_encoder_error(codec, encoders));
    }
    Ok(codec.to_owned())
}

fn resolve_encoder_target(target: &Value, encoder: &str) -> Option<(Value, Option<String>)> {
    let devices = super::gpu_devices::list_devices_merged();
    let devices = devices.as_array()?;
    let wanted_key = target.get("deviceKey").and_then(Value::as_str);
    let wanted_bdf = target.get("bdf").and_then(bdf_text);
    let wanted_luid = target.get("luid").and_then(|value| contract::normalize_dxgi_luid(Some(value)));
    let matches: Vec<&Value> = devices.iter().filter(|device| {
        let key_match = wanted_key.is_some() && device.get("deviceKey").and_then(Value::as_str) == wanted_key;
        let bdf_match = wanted_bdf.is_some() && device.get("bdf").and_then(bdf_text) == wanted_bdf;
        let luid_match = wanted_luid.is_some() && device_luid(device) == wanted_luid;
        key_match || bdf_match || luid_match
    }).collect();
    if matches.len() != 1 { return None; }
    let device = matches[0];
    let display_active = device.get("displayActive").and_then(Value::as_bool).unwrap_or(true);
    let runtime = contract::recording_runtime_encoder_id_for_target(&json!(encoder), Some(&json!(display_active)));
    let luid = device_luid(device);
    let mut resolved = Map::new();
    if let Some(key) = device.get("deviceKey").and_then(Value::as_str) { resolved.insert("deviceKey".into(), json!(key)); }
    if let Some(bdf) = device.get("bdf").filter(|value| !value.is_null()) { resolved.insert("bdf".into(), bdf.clone()); }
    if let Some(luid) = luid { resolved.insert("luid".into(), json!(luid)); }
    if resolved.is_empty() { return None; }
    Some((Value::Object(resolved), runtime.as_str().filter(|value| *value != encoder).map(str::to_owned)))
}

fn bdf_text(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        let text = text.trim();
        if let Some((bus_device, function)) = text.rsplit_once('.') {
            let mut parts = bus_device.rsplitn(2, ':');
            let device = parts.next()?;
            let bus = parts.next()?.rsplit(':').next()?;
            return Some(format!("{}:{}.{}", u64::from_str_radix(bus.trim_start_matches("0x"), 16).ok()?, u64::from_str_radix(device, 16).ok()?, function.parse::<u64>().ok()?));
        }
    }
    let object = value.as_object()?;
    Some(format!("{}:{}.{}", object.get("bus")?.as_u64()?, object.get("device")?.as_u64()?, object.get("function").or_else(|| object.get("func")).and_then(Value::as_u64).unwrap_or(0)))
}

fn device_luid(device: &Value) -> Option<String> {
    device.get("osLuid").and_then(|value| contract::normalize_dxgi_luid(Some(value)))
        .or_else(|| device.get("luid").and_then(|value| contract::normalize_dxgi_luid(Some(value))))
        .or_else(|| device.get("adapterLuid").and_then(|value| contract::normalize_dxgi_luid(Some(value))))
}

fn usable_file(path: &Path) -> bool {
    std::fs::metadata(path).map(|metadata| metadata.is_file() && metadata.len() > 0).unwrap_or(false)
}

fn wait_for_file(path: &Path, timeout_ms: u64) -> bool {
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    let mut previous: Option<(u64, SystemTime)> = None;
    let mut stable_since = Instant::now();
    loop {
        let current = std::fs::metadata(path).ok().filter(|metadata| metadata.is_file() && metadata.len() > 0)
            .and_then(|metadata| metadata.modified().ok().map(|modified| (metadata.len(), modified)));
        if let Some(current) = current {
            if previous != Some(current) {
                previous = Some(current);
                stable_since = Instant::now();
            } else if stable_since.elapsed() >= Duration::from_millis(REPLAY_FILE_STABLE_MS) {
                return true;
            }
        } else {
            previous = None;
            stable_since = Instant::now();
        }
        if Instant::now() >= deadline { return previous.is_some(); }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn replay_capture_duration(requested_ms: i64, replay_length: Option<&Value>) -> i64 {
    let duration = requested_ms.max(1);
    let buffer = replay_length.and_then(Value::as_f64).map(|value| (value * 1000.0).round().max(0.0) as i64).unwrap_or(0);
    if buffer > 0 && duration >= buffer { duration + REPLAY_CAPTURE_LEAD_MS } else { duration }
}

fn replay_capture_already_active(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("already capturing") || lower.contains("already started") || lower.contains("already active") || lower.contains("capture is already active")
}

fn replay_capture_not_ready(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("not capturing") || lower.contains("replay is offline") || lower.contains("replays are offline")
        || (lower.contains("replay buffer") && (lower.contains("not active") || lower.contains("not ready") || lower.contains("isn't")))
        || lower.contains("not active")
}

fn resolve_replay_source(response: &Value, native_path: &str, requested_path: &str, requested_existed: bool) -> String {
    let response_path = response.get("path").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
    let response_is_requested = requested_existed && response_path.is_some_and(|value| same_path(value, requested_path));
    let mut candidates: Vec<&str> = Vec::new();
    if let Some(path) = response_path.filter(|_| !response_is_requested) { candidates.push(path); }
    candidates.push(native_path);
    if !requested_existed { candidates.push(requested_path); }
    candidates.into_iter().find(|candidate| usable_file(Path::new(candidate))).unwrap_or(native_path).to_owned()
}

fn same_path(left: &str, right: &str) -> bool {
    Path::new(left).to_string_lossy().eq_ignore_ascii_case(&Path::new(right).to_string_lossy())
}

fn replay_ready_payload(response: &Value, active: Option<&Recorder>, clip_path: &str, thumbnail_folder: &str,
    requested_duration: i64, apm: &ApmSampler) -> Value {
    let source_session = response.get("sourceSessionId").and_then(Value::as_str).map(str::to_owned)
        .or_else(|| active.map(|recorder| recorder.session_id.clone()));
    let native_duration = response.get("durationMs").and_then(Value::as_i64).map(|value| value.max(0));
    let replay_started = active.map(|recorder| recorder.started_at).unwrap_or(0);
    let native_video_start = response.get("video_start_time").and_then(Value::as_i64).map(|value| (value - replay_started).max(0));
    let native_start = response.get("sourceStartMs").and_then(Value::as_i64).map(|value| value.max(0)).or(native_video_start);
    let native_end = response.get("sourceEndMs").and_then(Value::as_i64).map(|value| value.max(0))
        .or_else(|| native_start.zip(native_duration).map(|(start, duration)| start + duration));
    let elapsed = (now_ms() - replay_started).max(0);
    let requested = requested_duration.max(1);
    let interval_valid = native_start.zip(native_end).is_some_and(|(start, end)| {
        end >= start && start <= elapsed + 5_000 && end <= elapsed + 5_000
            && (end > start || elapsed < 1_000) && (end - start) <= requested + 5_000
            && native_duration.is_none_or(|duration| ((end - start) - duration).abs() <= 5_000)
    });
    let interval_duration = if interval_valid { (native_end.unwrap() - native_start.unwrap()).max(1) } else { 0 };
    let duration = if interval_valid { requested.min(interval_duration) } else { requested.min((elapsed.max(1)).max(1)) };
    let end = if interval_valid { native_end.unwrap() } else { duration.max(elapsed) };
    let start = if interval_valid { native_start.unwrap().max(end - duration) } else { (end - duration).max(0) };
    let interval = source_session.as_deref().map(|session| apm.interval(session, start, end)).unwrap_or(Value::Null);
    let mut output = response.clone();
    output["event"] = json!("replay_ready");
    output["type"] = json!("replay_ready");
    output["nativeEvent"] = response.get("event").cloned().unwrap_or(json!(EVENT_REPLAY_CAPTURE_VIDEO_READY));
    output["sessionId"] = json!(source_session);
    output["sourceSessionId"] = json!(source_session);
    output["identifier"] = response.get("identifier").cloned().or_else(|| active.map(|recorder| json!(recorder.identifier))).unwrap_or(Value::Null);
    output["path"] = json!(clip_path);
    output["durationMs"] = json!((end - start).max(0));
    output["sourceStartMs"] = json!(start);
    output["sourceEndMs"] = json!(end);
    output["thumbnailFolder"] = json!(response.get("thumbnailFolder").and_then(Value::as_str).unwrap_or(thumbnail_folder));
    if let Some(samples) = interval.get("samples").and_then(Value::as_array).filter(|samples| !samples.is_empty()) {
        output["apmSamples"] = json!(samples);
        output["apmAverage"] = interval.get("averageApm").cloned().unwrap_or(Value::Null);
        output["apmPeak"] = interval.get("peakApm").cloned().unwrap_or(Value::Null);
    }
    if let Some(available) = interval.get("available").and_then(Value::as_bool) { output["apmAvailable"] = json!(available); }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_payload_matches_the_ascent_contract() {
        let settings = json!({
            "resolution":"1080p","fps":60,"encoderId":"obs_qsv11_av1","runtimeEncoderId":"obs_qsv11_av1",
            "rateControl":"CBR","bitrateKbps":6000,"maxBitrateKbps":8000,"rateControlQuality":23,
            "captureWidth":2560,"captureHeight":1440,"captureColorMode":"sdr","captureHdr":false,
            "captureSource":{"type":"display","monitorHandle":42},"showCursor":true,
            "replayLengthSec":30,
            "audio":{"microphone":{"enabled":true,"deviceId":"mic","volume":0.5,"mono":false},"system":{"enabled":true,"deviceId":"out","volume":1},"sourceMode":"system","customProcesses":[]},
        });
        let payload = build_start_payload(&settings, "C:\\clips\\out.mp4", RECORDER_VIDEO);
        assert_eq!(payload["video_settings"]["base_width"], 2560.0);
        assert_eq!(payload["video_settings"]["output_height"], 1080.0);
        assert_eq!(payload["video_settings"]["video_encoder"]["id"], "obs_qsv11_av1");
        assert_eq!(payload["video_settings"]["video_encoder"]["bitrate"], 6000);
        assert_eq!(payload["audio_settings"]["extra_options"]["audio_sources"][0]["volume"], 50);
        assert_eq!(payload["file_output"]["filename"], "C:\\clips\\out.mp4");
        assert!(payload.get("replay").is_none());
        assert_eq!(payload["sources"]["monitor"]["monitor_handle"], 42);
    }

    #[test]
    fn replay_payload_uses_the_rolling_buffer_without_a_file_output() {
        let settings = json!({"resolution":"720p","fps":30,"encoderId":"obs_qsv11_hevc","replayLengthSec":10,"audio":{}});
        let payload = build_start_payload(&settings, "", RECORDER_REPLAY);
        assert!(payload.get("file_output").is_none());
        assert_eq!(payload["replay"]["max_time_sec"], 11.0);
    }

    #[test]
    fn encoder_selection_decodes_base64url_and_targets() {
        let value = json!({"codec":"obs_qsv11_av1","target":{"deviceKey":"gpu-a","bdf":{"domain":0,"bus":3,"device":0,"function":0}}});
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap());
        let parsed = parse_encoder_selection(&format!("{SELECTION_PREFIX}{encoded}")).unwrap().unwrap();
        assert_eq!(parsed.codec, "obs_qsv11_av1");
        assert_eq!(parsed.target.as_ref().unwrap()["deviceKey"], "gpu-a");
        assert!(parse_encoder_selection("automatic").unwrap().is_none());
        assert!(parse_encoder_selection(&format!("{SELECTION_PREFIX}not-json")).is_err());
    }

    #[test]
    fn stderr_filter_drops_non_actionable_muxer_lines() {
        assert_eq!(filter_recording_stderr("Qavg: 123\nframes left in the queue on closing\nEncoder failed"), "Encoder failed");
    }

    #[test]
    fn replay_transient_messages_are_classified() {
        assert!(replay_capture_already_active("capture is already active"));
        assert!(replay_capture_not_ready("Replay buffer is not active"));
        assert!(replay_capture_not_ready("not capturing"));
        assert!(!replay_capture_not_ready("encoder failed"));
    }

    #[test]
    fn float_json_window_handles_remain_usable() {
        assert_eq!(json_u64(&json!(42.0)), Some(42));
        assert_eq!(json_u64(&json!(42)), Some(42));
        assert_eq!(json_u64(&json!(-1.0)), None);
    }

    #[test]
    #[ignore = "live read-only ascent-obs machine-info probe"]
    fn live_ascent_probe_reports_encoders_and_audio() {
        let root = std::env::var_os("APPDATA").map(PathBuf::from).unwrap().join("ArcPower");
        let store = NativeStore::new(root, "advanced").unwrap();
        let engine = RecordingEngine::new(Box::new(|_| {}), Box::new(|_| {}));
        let state = engine.probe(&store).unwrap();
        assert_eq!(state["available"], true);
        assert_eq!(state["probeComplete"], true);
        assert!(!state["encoders"].as_array().unwrap().is_empty());
        let _ = engine.shutdown(&store);
    }

    #[test]
    #[ignore = "live Instant Replay start/stop check; captures the desktop for two seconds"]
    fn live_replay_start_and_stop() {
        let root = std::env::var_os("APPDATA").map(PathBuf::from).unwrap().join("ArcPower");
        let store = NativeStore::new(root, "advanced").unwrap();
        let engine = RecordingEngine::new(Box::new(|_| {}), Box::new(|_| {}));
        let mut settings = super::super::services::recording_settings(&store).unwrap();
        settings["encoderId"] = json!("automatic");
        settings["replayLengthSec"] = json!(5);
        settings["captureTarget"] = json!({"type":"display","displayId":"primary","windowHandle":0,"processName":"","executablePath":"","windowTitle":"","windowClass":""});
        let state = engine.start(&store, &settings, "replay").expect("live replay start");
        assert_eq!(state["activeModes"]["replay"], true);
        std::thread::sleep(Duration::from_millis(2_000));
        let stopped = engine.stop(&store, Some("replay")).expect("live replay stop");
        assert_eq!(stopped["activeModes"]["replay"], false);
        let _ = engine.shutdown(&store);
    }
}
