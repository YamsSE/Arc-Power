//! Native recording editor jobs: bounded trim, GIF export, audio inspection,
//! and safe artifact actions. Jobs are serialized like the Electron service.
use super::{
    clipboard, native_store::NativeStore, native_system,
    recording_contract::{self as contract, RECORDING_EDITOR_VERSION},
    recording_ffmpeg::{probe_duration, run, runtime_executable},
    recording_paths::{SystemWin32Paths, recording_absolute_path},
    wire,
};
use regex::Regex;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

const EDITOR_TRIM_MAX_MS: i64 = 3_600_000;
const GIF_MIN_MS: i64 = 1_000;
const GIF_MAX_MS: i64 = 15_000;
const GIF_MIN_FPS: u64 = 5;
const GIF_MAX_FPS: u64 = 30;
const GIF_MAX_WIDTH: u64 = 1_920;
const OUTPUT_NAME_MAX: usize = 96;
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_OPERATION_TIMEOUT_MS: u64 = 30 * 60 * 1_000;
const OPERATION_TIMEOUT_HEADROOM_MS: u64 = 30_000;
const OPERATION_TIMEOUT_PER_SECOND_MS: u64 = 20_000;
const PROBE_TIMEOUT_MS: u64 = 15_000;
const MAX_PENDING_EDITOR_JOBS: usize = 8;
const MAX_RETAINED_EDITOR_JOBS: usize = 64;

#[derive(Clone)]
struct EditorRequest {
    source_id: String,
    operation: String,
    start_ms: i64,
    end_ms: i64,
    duration_ms: i64,
    audio: String,
    fps: u64,
    width: u64,
    output_name: String,
}

struct JobState {
    state: String,
    progress: u32,
    error: Option<String>,
    clip: Option<Value>,
    artifact: Option<Value>,
    finished_at: Option<Instant>,
}

struct Job {
    job_id: String,
    request: EditorRequest,
    status: Mutex<JobState>,
    cancel: AtomicBool,
    progress: AtomicU32,
}

pub struct RecordingEditor {
    jobs: Mutex<HashMap<String, Arc<Job>>>,
    store: Arc<NativeStore>,
}

impl RecordingEditor {
    pub fn new(store: Arc<NativeStore>) -> Self {
        Self { jobs: Mutex::new(HashMap::new()), store }
    }

    pub fn start(&self, payload: Value) -> Result<Value, String> {
        let request = normalize_request(&payload)?;
        let job_id = random_id();
        let job = Arc::new(Job {
            job_id: job_id.clone(),
            request,
            status: Mutex::new(JobState {
                state: "queued".into(), progress: 0, error: None, clip: None, artifact: None,
                finished_at: None,
            }),
            cancel: AtomicBool::new(false),
            progress: AtomicU32::new(0),
        });
        let mut jobs = self.jobs.lock().map_err(|_| "editor job lock failed")?;
        prune_completed_jobs(&mut jobs);
        let pending = jobs.values().filter(|job| {
            job.status.lock().map(|status| matches!(status.state.as_str(), "queued" | "running"))
                .unwrap_or(true)
        }).count();
        if pending >= MAX_PENDING_EDITOR_JOBS {
            return Err("Too many clip exports are queued. Wait for one to finish, then try again.".into());
        }
        jobs.insert(job_id.clone(), job.clone());
        drop(jobs);
        let public = public_job(&job);
        let store = self.store.clone();
        if let Err(error) = std::thread::Builder::new().name("arc-recording-editor".into()).spawn(move || {
            run_job(store, job);
        }) {
            if let Ok(mut jobs) = self.jobs.lock() { jobs.remove(&job_id); }
            return Err(error.to_string());
        }
        Ok(public)
    }

    pub fn status(&self, job_id: &str) -> Result<Value, String> {
        let job = self.job(job_id)?;
        Ok(public_job(&job))
    }

    pub fn cancel(&self, job_id: &str) -> Result<Value, String> {
        let job = self.job(job_id)?;
        let mut status = job.status.lock().map_err(|_| "editor job lock failed")?;
        if status.state == "queued" {
            job.cancel.store(true, Ordering::Release);
            status.state = "cancelled".into();
            status.progress = 0;
            status.finished_at = Some(Instant::now());
        } else if status.state == "running" {
            job.cancel.store(true, Ordering::Release);
        }
        drop(status);
        Ok(public_job(&job))
    }

    pub fn audio(&self, source_id: &str) -> Result<Value, String> {
        let source = safe_source(&self.store, source_id)?;
        let ffprobe = runtime_executable(&self.store, "ffprobe.exe").ok_or("Bundled FFprobe is unavailable")?;
        let tracks = audio_streams(&ffprobe, Path::new(&source))?;
        Ok(json!({
            "system": tracks.system.is_some(),
            "microphone": tracks.microphone.is_some(),
            "mixed": tracks.mixed,
            "durationMs": super::recording_ffmpeg::probe_duration(Some(ffprobe.as_path()), Path::new(&source)),
        }))
    }

    pub fn open(&self, job_id: &str) -> Result<Value, String> {
        let path = ready_artifact(&self.job(job_id)?, &self.store)?;
        native_system::open_path(&path.to_string_lossy())?;
        Ok(json!({"ok":true}))
    }

    pub fn share(&self, job_id: &str) -> Result<Value, String> {
        let path = ready_artifact(&self.job(job_id)?, &self.store)?;
        clipboard::copy_text(&path.to_string_lossy())?;
        if let Some(parent) = path.parent() { native_system::open_path(&parent.to_string_lossy())?; }
        Ok(json!({"ok":true}))
    }

    pub fn copy(&self, job_id: &str) -> Result<Value, String> {
        let path = ready_artifact(&self.job(job_id)?, &self.store)?;
        clipboard::copy_files(&[path.to_string_lossy().into_owned()])?;
        Ok(json!({"ok":true}))
    }

    pub fn folder(&self, job_id: &str) -> Result<Value, String> {
        let path = ready_artifact(&self.job(job_id)?, &self.store)?;
        let parent = path.parent().ok_or("Artifact folder is unavailable")?;
        native_system::open_path(&parent.to_string_lossy())?;
        Ok(json!({"ok":true}))
    }

    pub fn shutdown(&self) {
        if let Ok(jobs) = self.jobs.lock() {
            for job in jobs.values() {
                job.cancel.store(true, Ordering::Release);
                if let Ok(mut status) = job.status.lock() {
                    if status.state == "queued" {
                        status.state = "cancelled".into();
                        status.progress = 0;
                        status.finished_at = Some(Instant::now());
                    }
                }
            }
        }
    }

    fn job(&self, job_id: &str) -> Result<Arc<Job>, String> {
        self.jobs.lock().map_err(|_| "editor job lock failed")?
            .get(job_id).cloned().ok_or_else(|| "recording-editor-status: job not found".to_owned())
    }
}

struct AudioTracks {
    system: Option<u64>,
    microphone: Option<u64>,
    mixed: bool,
}

fn random_id() -> String {
    let value = rand::random::<u128>();
    format!("{value:032x}")
}

fn prune_completed_jobs(jobs: &mut HashMap<String, Arc<Job>>) {
    let mut completed: Vec<(Instant, String)> = jobs.iter().filter_map(|(id, job)| {
        let status = job.status.lock().ok()?;
        matches!(status.state.as_str(), "ready" | "cancelled" | "error")
            .then(|| (status.finished_at.unwrap_or_else(Instant::now), id.clone()))
    }).collect();
    completed.sort_by_key(|(finished_at, _)| *finished_at);
    let excess = completed.len().saturating_sub(MAX_RETAINED_EDITOR_JOBS);
    for (_, id) in completed.into_iter().take(excess) { jobs.remove(&id); }
}

fn public_job(job: &Job) -> Value {
    let status = job.status.lock().expect("editor job lock");
    let mut output = Map::new();
    output.insert("jobId".into(), json!(job.job_id));
    output.insert("state".into(), json!(status.state));
    output.insert("progress".into(), json!(status.progress));
    if let Some(clip) = &status.clip { output.insert("clip".into(), clip.clone()); }
    if let Some(artifact) = &status.artifact { output.insert("artifact".into(), artifact.clone()); }
    if let Some(error) = &status.error { output.insert("error".into(), json!(error)); }
    Value::Object(output)
}

fn update(job: &Job, state: Option<&str>, progress: Option<u32>, error: Option<&str>) {
    if let Ok(mut status) = job.status.lock() {
        if let Some(state) = state {
            status.state = state.into();
            if matches!(state, "ready" | "cancelled" | "error") { status.finished_at = Some(Instant::now()); }
        }
        if let Some(progress) = progress { status.progress = progress.min(100); }
        if error.is_some() { status.error = error.map(str::to_owned); }
    }
}

fn normalize_request(payload: &Value) -> Result<EditorRequest, String> {
    let payload = payload.as_object().ok_or("recording-editor-start: payload must be an object")?;
    let source_id = payload.get("sourceId").and_then(Value::as_str)
        .filter(|value| (8..=128).contains(&value.len()) && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')))
        .ok_or("recording-editor-start: invalid source id")?.to_owned();
    let operation = payload.get("operation").and_then(Value::as_str)
        .filter(|value| *value == "trim" || *value == "gif").ok_or("recording-editor-start: operation must be trim or gif")?.to_owned();
    let start = integer_in(payload.get("startMs"), 0, EDITOR_TRIM_MAX_MS).ok_or("recording-editor-start: invalid time range")?;
    let end = integer_in(payload.get("endMs"), 0, EDITOR_TRIM_MAX_MS).ok_or("recording-editor-start: invalid time range")?;
    if start >= end { return Err("recording-editor-start: invalid time range".into()); }
    let duration = end - start;
    let audio = payload.get("audio").and_then(Value::as_str).unwrap_or("original").to_owned();
    if !matches!(audio.as_str(), "original" | "mute" | "system" | "microphone") {
        return Err("recording-editor-start: invalid audio selection".into());
    }
    if let Some(maximum) = payload.get("maxDurationMs") {
        let maximum = integer_in(Some(maximum), 1, EDITOR_TRIM_MAX_MS).ok_or("recording-editor-start: invalid maximum duration")?;
        if duration > maximum { return Err("recording-editor-start: selected range exceeds maximum duration".into()); }
    }
    let fps = match payload.get("fps") { None => 15, Some(value) => integer_in(Some(value), GIF_MIN_FPS as i64, GIF_MAX_FPS as i64).ok_or("recording-editor-start: invalid GIF FPS")? as u64 };
    let width = match payload.get("width") { None => 640, Some(value) => integer_in(Some(value), 2, GIF_MAX_WIDTH as i64).ok_or("recording-editor-start: invalid GIF width")? as u64 };
    if operation == "gif" && (duration < GIF_MIN_MS || duration > GIF_MAX_MS) {
        return Err("recording-editor-start: GIF duration must be 1 to 15 seconds".into());
    }
    let output_name = normalize_output_name(payload.get("outputName")).ok_or("recording-editor-start: invalid output name")?;
    Ok(EditorRequest { source_id, operation, start_ms: start, end_ms: end, duration_ms: duration, audio, fps, width, output_name })
}

fn integer_in(value: Option<&Value>, minimum: i64, maximum: i64) -> Option<i64> {
    let value = value?.as_f64().filter(|value| value.is_finite() && value.fract() == 0.0)?;
    (value >= minimum as f64 && value <= maximum as f64).then_some(value as i64)
}

fn normalize_output_name(value: Option<&Value>) -> Option<String> {
    let source = match value {
        None | Some(Value::Null) => "Arc Edit".to_owned(),
        Some(Value::String(value)) if value.is_empty() => "Arc Edit".to_owned(),
        Some(Value::String(value)) if value.len() <= OUTPUT_NAME_MAX => value.clone(),
        _ => return None,
    };
    let trimmed = source.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".."
        || trimmed.chars().any(|character| matches!(character, '\\' | '/' | '\0' | '\r' | '\n' | '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        || Path::new(trimmed).components().count() != 1
        || Path::new(trimmed).file_name().and_then(|value| value.to_str()) != Some(trimmed)
        || trimmed.starts_with('.') {
        return None;
    }
    let lowercase = trimmed.to_ascii_lowercase();
    let without = lowercase.strip_suffix(".mp4").or_else(|| lowercase.strip_suffix(".gif")).unwrap_or(&lowercase);
    let without = trimmed[..without.len()].trim();
    if without.is_empty() || without == "." || without == ".." { return None; }
    Some(without.chars().take(OUTPUT_NAME_MAX).collect())
}

fn unique_output(root: &Path, base: &str, extension: &str) -> Result<PathBuf, String> {
    for attempt in 0..100u32 {
        let suffix = if attempt == 0 { String::new() } else { format!(" ({})", attempt + 1) };
        let name_budget = OUTPUT_NAME_MAX.saturating_sub(suffix.len() + extension.len()).max(1);
        let candidate = root.join(format!("{}{suffix}{extension}", base.chars().take(name_budget).collect::<String>()));
        if !candidate.exists() { return Ok(candidate); }
    }
    Ok(root.join(format!("Arc Edit {}{extension}", &random_id()[..12])))
}

fn run_job(store: Arc<NativeStore>, job: Arc<Job>) {
    let _gate = match gate_acquire(&job) {
        Some(gate) => gate,
        None => {
            if job.cancel.load(Ordering::Acquire) {
                update(&job, Some("cancelled"), Some(0), None);
            } else {
                update(&job, Some("error"), Some(0), Some("Clip export worker could not acquire the queue."));
            }
            return;
        }
    };
    if job.cancel.load(Ordering::Acquire) {
        update(&job, Some("cancelled"), Some(0), None);
        return;
    }
    update(&job, Some("running"), Some(1), None);
    let result = run_job_inner(&store, &job);
    match result {
        Ok(()) => {}
        Err(error) => {
            if job.cancel.load(Ordering::Acquire) { update(&job, Some("cancelled"), Some(0), None); }
            else { update(&job, Some("error"), Some(0), Some(&error.chars().take(256).collect::<String>())); }
        }
    }
}

fn gate_acquire(job: &Arc<Job>) -> Option<std::sync::MutexGuard<'static, ()>> {
    // The gate is owned by the editor service; jobs run one at a time in
    // request order. A static gate also keeps the service easy to own from the
    // host without storing a guard in every job.
    static GATE: Mutex<()> = Mutex::new(());
    let guard = GATE.lock().ok()?;
    if job.cancel.load(Ordering::Acquire) { return None; }
    Some(guard)
}

fn run_job_inner(store: &NativeStore, job: &Arc<Job>) -> Result<(), String> {
    let settings = super::services::recording_settings(store)?;
    let root = settings.get("location").and_then(Value::as_str).filter(|value| !value.trim().is_empty())
        .ok_or("Source clip is unavailable")?;
    let root = PathBuf::from(recording_absolute_path(Some(&json!(root)), "location", &SystemWin32Paths)?);
    let source = safe_source(store, &job.request.source_id)?;
    let source_path = PathBuf::from(&source);
    let source_metadata = std::fs::metadata(&source_path).map_err(|_| "Source clip is unavailable")?;
    if !source_metadata.is_file() { return Err("Source clip is not a regular file".into()); }
    let extension = if job.request.operation == "gif" { ".gif" } else { ".mp4" };
    let output = unique_output(&root, &job.request.output_name, extension)?;
    let relative = output.strip_prefix(&root).map_err(|_| "Output path is unsafe")?.to_string_lossy().into_owned();
    let temp = root.join(format!("{}.arc-editor-{}.tmp", output.file_name().map(|value| value.to_string_lossy()).unwrap_or_default(), job.job_id));
    std::fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let ffmpeg = runtime_executable(store, "ffmpeg.exe").ok_or("Bundled FFmpeg is unavailable")?;
    let ffprobe = runtime_executable(store, "ffprobe.exe");
    let mut audio_index: Option<Vec<u64>> = None;
    let mut output_verified = false;
    if matches!(job.request.audio.as_str(), "system" | "microphone") {
        let tracks = audio_streams(ffprobe.as_deref().ok_or("Bundled FFprobe is unavailable")?, &source_path)?;
        let index = if job.request.audio == "system" { tracks.system } else { tracks.microphone };
        audio_index = Some(vec![index.ok_or_else(|| format!("This recording has no separate {} audio track", job.request.audio))?]);
    } else if job.request.audio == "original" {
        if let Some(ffprobe) = ffprobe.as_deref() {
            if let Ok(tracks) = audio_streams(ffprobe, &source_path) {
                if let (Some(system), Some(microphone)) = (tracks.system, tracks.microphone) {
                    if system != microphone { audio_index = Some(vec![system, microphone]); }
                }
            }
        }
    }
    let progress_job = job.clone();
    let selected_seconds = (job.request.duration_ms as f64 / 1000.0).max(0.001);
    let progress = move |elapsed: f64| {
        let value = ((elapsed / selected_seconds) * 95.0).round().clamp(0.0, 95.0) as u32;
        let _ = progress_job.progress.fetch_max(value, Ordering::SeqCst);
        if let Ok(mut status) = progress_job.status.lock() { status.progress = status.progress.max(value); }
    };
    let timeout = Duration::from_millis(operation_timeout(job.request.duration_ms));
    let mut result = None;
    if job.request.operation == "trim" && job.request.audio == "original" && audio_index.is_none() {
        let args = copy_arguments(&source_path, &temp, job.request.start_ms, job.request.end_ms);
        let copy = run(&ffmpeg, &args, timeout, Some(&job.cancel), Some(&progress));
        if copy.ok && usable(&temp) && duration_matches(ffprobe.as_deref(), &temp, job.request.duration_ms) {
            result = Some(copy);
            output_verified = true;
        } else {
            let _ = std::fs::remove_file(&temp);
        }
    }
    if result.is_none() {
        let args = if job.request.operation == "gif" {
            gif_arguments(&source_path, &temp, job.request.start_ms, job.request.end_ms, job.request.fps, job.request.width)
        } else {
            trim_arguments(&source_path, &temp, job.request.start_ms, job.request.end_ms, &job.request.audio, audio_index.as_deref())
        }.ok_or("Invalid editor bounds")?;
        result = Some(run(&ffmpeg, &args, timeout, Some(&job.cancel), Some(&progress)));
    }
    let result = result.unwrap();
    if job.cancel.load(Ordering::Acquire) || result.cancelled {
        let _ = std::fs::remove_file(&temp);
        update(job, Some("cancelled"), Some(0), None);
        return Ok(());
    }
    if !result.ok {
        let _ = std::fs::remove_file(&temp);
        return Err(if result.timed_out { "FFmpeg timed out".into() }
            else { result.stderr.lines().last().filter(|line| !line.trim().is_empty()).unwrap_or("FFmpeg failed").trim().to_owned() });
    }
    if !usable(&temp) { return Err("FFmpeg produced an invalid output".into()); }
    let current = std::fs::metadata(&source_path).map_err(|_| "Source clip changed during editing")?;
    if current.len() != source_metadata.len() || current.modified().ok() != source_metadata.modified().ok() {
        let _ = std::fs::remove_file(&temp);
        return Err("Source clip changed during editing".into());
    }
    if !output_verified && !duration_matches(ffprobe.as_deref(), &temp, job.request.duration_ms) {
        let _ = std::fs::remove_file(&temp);
        return Err("Output duration does not match the selected range".into());
    }
    if output.exists() { let _ = std::fs::remove_file(&temp); return Err("Output collision".into()); }
    std::fs::rename(&temp, &output).map_err(|error| error.to_string())?;
    if !usable(&output) { return Err("Published output is unsafe".into()); }
    if job.request.operation == "trim" {
        let source_clip = clip_by_id(store, &job.request.source_id)?;
        let markers = marker_summaries(&source_clip, job.request.start_ms, job.request.end_ms);
        let apm = contract::map_recording_apm_samples_to_clip(source_clip.get("apmSamples"), Some(&json!(job.request.start_ms)), Some(&json!(job.request.end_ms)));
        let values: Vec<f64> = apm.iter().filter_map(|sample| sample["apm"].as_f64()).collect();
        let mut metadata = json!({
            "relativePath": relative,
            "fileName": output.file_name().map(|value| value.to_string_lossy()).unwrap_or_default(),
            "editorVersion": RECORDING_EDITOR_VERSION,
            "markerSummaries": markers,
            "apmSamples": apm,
            "apmAverage": if values.is_empty() { Value::Null } else { json!((values.iter().sum::<f64>() / values.len() as f64).round()) },
            "apmPeak": if values.is_empty() { Value::Null } else { json!(values.iter().cloned().fold(0.0, f64::max)) },
        });
        if let Some(available) = source_clip.get("apmAvailable").and_then(Value::as_bool) { metadata["apmAvailable"] = json!(available); }
        let clip = store_result(store, "recording-record-clip", json!([metadata]))?;
        if let Ok(mut status) = job.status.lock() {
            status.state = "ready".into();
            status.progress = 100;
            status.clip = Some(clip);
            status.finished_at = Some(Instant::now());
        }
    } else if let Ok(mut status) = job.status.lock() {
        status.state = "ready".into();
        status.progress = 100;
        status.finished_at = Some(Instant::now());
        status.artifact = Some(json!({
            "kind":"gif","fileName":output.file_name().map(|value| value.to_string_lossy()).unwrap_or_default(),
            "relativePath":relative,"extension":".gif","durationMs":job.request.duration_ms,
            "fps":job.request.fps,"width":job.request.width,
        }));
    }
    Ok(())
}

fn safe_source(store: &NativeStore, source_id: &str) -> Result<String, String> {
    if !(8..=128).contains(&source_id.len()) || !source_id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')) {
        return Err("Invalid source clip".into());
    }
    let clip = clip_by_id(store, source_id)?;
    if clip.is_null() { return Err("Source clip is unavailable".into()); }
    super::services::recording_clip_path(store, source_id).map_err(|_| "Source clip path is unsafe".to_owned())
}

fn clip_by_id(store: &NativeStore, source_id: &str) -> Result<Value, String> {
    store_result(store, "recording-clip-by-id", json!([source_id]))
}

fn store_result(store: &NativeStore, method: &str, args: Value) -> Result<Value, String> {
    let encoded = wire::encode_json(&args)?;
    let reply = store.invoke(method, &encoded)?;
    let value = wire::decode(&reply)?.into_json()?;
    Ok(value.get("result").cloned().unwrap_or(value))
}

fn marker_summaries(clip: &Value, start: i64, end: i64) -> Vec<Value> {
    clip.get("markerSummaries").and_then(Value::as_array).into_iter().flatten()
        .filter_map(|marker| {
            let at = marker["atMs"].as_f64()? as i64;
            if at < start || at > end { return None; }
            let mut output = marker.clone();
            output["atMs"] = json!((at - start).max(0));
            Some(output)
        }).take(500).collect()
}

fn usable(path: &Path) -> bool {
    std::fs::metadata(path).map(|metadata| metadata.is_file() && metadata.len() > 0).unwrap_or(false)
}

fn duration_matches(ffprobe: Option<&Path>, path: &Path, expected_ms: i64) -> bool {
    if ffprobe.is_none() { return true; }
    probe_duration(ffprobe, path).is_some_and(|actual| actual > 0.0 && (actual - expected_ms as f64).abs() <= 250.0)
}

fn operation_timeout(duration_ms: i64) -> u64 {
    let budget = if duration_ms > 0 { ((duration_ms as u64).div_ceil(1_000)) * OPERATION_TIMEOUT_PER_SECOND_MS + OPERATION_TIMEOUT_HEADROOM_MS } else { DEFAULT_TIMEOUT_MS };
    budget.max(DEFAULT_TIMEOUT_MS).min(MAX_OPERATION_TIMEOUT_MS)
}

fn seconds(ms: i64) -> String { format!("{:.3}", ms.max(1) as f64 / 1000.0) }

fn trim_arguments(input: &Path, output: &Path, start_ms: i64, end_ms: i64, audio: &str, audio_index: Option<&[u64]>) -> Option<Vec<String>> {
    if start_ms < 0 || end_ms <= start_ms || end_ms > EDITOR_TRIM_MAX_MS { return None; }
    let mut args = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-nostdin".into(),
        "-ss".into(), seconds(start_ms), "-i".into(), input.to_string_lossy().into_owned(),
        "-t".into(), seconds(end_ms - start_ms)];
    match audio_index {
        Some([first, second, ..]) => {
            args.extend(["-filter_complex".into(), format!("[0:{first}][0:{second}]amix=inputs=2:duration=longest:normalize=0[clip_audio]"),
                "-map".into(), "0:v:0".into(), "-map".into(), "[clip_audio]".into()]);
        }
        Some([index, ..]) => args.extend(["-map".into(), "0:v:0".into(), "-map".into(), format!("0:{index}")]),
        _ => {
            args.extend(["-map".into(), "0:v:0".into()]);
            if audio != "mute" { args.extend(["-map".into(), "0:a?".into()]); }
        }
    }
    args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "18".into()]);
    if audio == "mute" { args.push("-an".into()); } else { args.extend(["-c:a".into(), "aac".into()]); }
    if audio_index.is_some() {
        args.extend(["-metadata:s:a:0".into(), format!("handler_name={}", match audio { "system" => "System Audio", "microphone" => "Microphone", _ => "Combined Audio" })]);
    }
    args.extend(["-avoid_negative_ts".into(), "make_zero".into(), "-movflags".into(), "+faststart".into(),
        "-f".into(), "mp4".into(), "-y".into(), output.to_string_lossy().into_owned()]);
    Some(args)
}

fn copy_arguments(input: &Path, output: &Path, start_ms: i64, end_ms: i64) -> Vec<String> {
    vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-nostdin".into(),
        "-ss".into(), seconds(start_ms), "-i".into(), input.to_string_lossy().into_owned(),
        "-t".into(), seconds(end_ms - start_ms), "-map".into(), "0:v:0".into(),
        "-map".into(), "0:a?".into(), "-c".into(), "copy".into(),
        "-avoid_negative_ts".into(), "make_zero".into(), "-movflags".into(), "+faststart".into(),
        "-f".into(), "mp4".into(), "-y".into(), output.to_string_lossy().into_owned()]
}

fn gif_arguments(input: &Path, output: &Path, start_ms: i64, end_ms: i64, fps: u64, width: u64) -> Option<Vec<String>> {
    if end_ms <= start_ms || end_ms - start_ms < GIF_MIN_MS || end_ms - start_ms > GIF_MAX_MS { return None; }
    Some(vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-nostdin".into(),
        "-ss".into(), seconds(start_ms), "-i".into(), input.to_string_lossy().into_owned(),
        "-t".into(), seconds(end_ms - start_ms), "-vf".into(), format!("fps={fps},scale={width}:-2:flags=lanczos"),
        "-loop".into(), "0".into(), "-f".into(), "gif".into(), "-y".into(), output.to_string_lossy().into_owned()])
}

fn audio_streams(ffprobe: &Path, source: &Path) -> Result<AudioTracks, String> {
    let args = vec!["-v".into(), "error".into(), "-show_streams".into(), "-of".into(), "json".into(),
        "-i".into(), source.to_string_lossy().into_owned()];
    let result = run(ffprobe, &args, Duration::from_millis(PROBE_TIMEOUT_MS), None, None);
    if !result.ok { return Err("Could not inspect recording audio".into()); }
    let parsed: Value = serde_json::from_str(&result.stdout).map_err(|_| "Could not inspect recording audio")?;
    let streams = parsed.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
    let audio: Vec<&Value> = streams.iter().filter(|stream| stream["codec_type"].as_str() == Some("audio") && stream["index"].as_u64().is_some()).collect();
    let system_regex = Regex::new(r"(?i)\b(system|desktop|game|output_game)\b").expect("audio regex");
    let microphone_regex = Regex::new(r"(?i)\b(microphone|mic|input_mic)\b").expect("audio regex");
    let named = |regex: &Regex| -> Option<u64> {
        let matches: Vec<u64> = audio.iter().filter(|stream| {
            let text = format!("{} {}", stream["tags"]["title"].as_str().unwrap_or(""), stream["tags"]["handler_name"].as_str().unwrap_or(""));
            regex.is_match(&text)
        }).filter_map(|stream| stream["index"].as_u64()).collect();
        (matches.len() == 1).then_some(matches[0])
    };
    Ok(AudioTracks { system: named(&system_regex), microphone: named(&microphone_regex), mixed: !audio.is_empty() })
}

fn ready_artifact(job: &Arc<Job>, store: &NativeStore) -> Result<PathBuf, String> {
    let status = job.status.lock().map_err(|_| "editor job lock failed")?;
    if status.state != "ready" { return Err("recording-editor: job is not ready".into()); }
    let relative = status.artifact.as_ref().and_then(|artifact| artifact["relativePath"].as_str())
        .or_else(|| status.clip.as_ref().and_then(|clip| clip["relativePath"].as_str()))
        .map(str::to_owned)
        .ok_or("recording-editor: artifact is unavailable")?;
    drop(status);
    let settings = super::services::recording_settings(store)?;
    let root = settings.get("location").and_then(Value::as_str).filter(|value| !value.trim().is_empty())
        .ok_or("recording-editor: artifact path is unsafe")?;
    let root = PathBuf::from(recording_absolute_path(Some(&json!(root)), "location", &SystemWin32Paths)?);
    let candidate = root.join(&relative);
    let canonical_root = std::fs::canonicalize(&root).map_err(|_| "recording-editor: artifact path is unsafe")?;
    let canonical = std::fs::canonicalize(&candidate).map_err(|_| "recording-editor: artifact path is unsafe")?;
    if !canonical.starts_with(&canonical_root) || !canonical.is_file() {
        return Err("recording-editor: artifact path is unsafe".into());
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn editor_request_validation_matches_the_electron_bounds() {
        let payload = json!({"sourceId":"abcdefgh","operation":"trim","startMs":1000,"endMs":4000,"audio":"original","outputName":"Clip"});
        let request = normalize_request(&payload).unwrap();
        assert_eq!(request.duration_ms, 3000);
        assert_eq!(request.output_name, "Clip");
        let gif = json!({"sourceId":"abcdefgh","operation":"gif","startMs":0,"endMs":1500,"fps":10,"width":320});
        assert_eq!(normalize_request(&gif).unwrap().fps, 10);
        assert!(normalize_request(&json!({"sourceId":"bad","operation":"trim","startMs":0,"endMs":10})).is_err());
        assert!(normalize_request(&json!({"sourceId":"abcdefgh","operation":"gif","startMs":0,"endMs":16000})).is_err());
        assert!(normalize_output_name(Some(&json!("..\\escape"))).is_none());
        assert_eq!(normalize_output_name(Some(&json!("Clip.mp4"))), Some("Clip".into()));
    }

    #[test]
    fn ffmpeg_arguments_are_bounded() {
        let trim = trim_arguments(Path::new("in.mp4"), Path::new("out.mp4"), 1000, 2500, "system", Some(&[2])).unwrap();
        assert!(trim.windows(2).any(|pair| pair == ["-t", "1.500"]));
        assert!(trim.windows(2).any(|pair| pair == ["-map", "0:2"]));
        let gif = gif_arguments(Path::new("in.mp4"), Path::new("out.gif"), 0, 2000, 15, 640).unwrap();
        assert!(gif.windows(2).any(|pair| pair == ["-vf", "fps=15,scale=640:-2:flags=lanczos"]));
        assert!(gif_arguments(Path::new("in.mp4"), Path::new("out.gif"), 0, 900, 15, 640).is_none());
    }

    #[test]
    fn output_names_are_sanitized_and_avoid_traversal() {
        assert_eq!(normalize_output_name(Some(&json!("Arc Edit"))), Some("Arc Edit".into()));
        assert_eq!(normalize_output_name(Some(&json!("Arc Edit.gif"))), Some("Arc Edit".into()));
        assert!(normalize_output_name(Some(&json!("C:\\clip"))).is_none());
        assert!(normalize_output_name(Some(&json!(".hidden"))).is_none());
    }

    #[test]
    #[ignore = "live synthetic editor trim check"]
    fn live_editor_trim_publishes_a_clip_and_metadata() {
        let root = std::env::temp_dir().join(format!("arc-editor-test-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let store = Arc::new(NativeStore::new(root.clone(), "advanced").unwrap());
        store.invoke("recording-save-settings", &wire::encode_json(&json!([{"location":root.to_string_lossy()}])).unwrap()).unwrap();
        let ffmpeg = runtime_executable(&store, "ffmpeg.exe").unwrap();
        let source = root.join("source.mp4");
        let args: Vec<String> = ["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=320x180:rate=30",
            "-t","3","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-y"]
            .into_iter().map(str::to_owned).chain([source.to_string_lossy().into_owned()]).collect();
        assert!(run(&ffmpeg, &args, Duration::from_secs(30), None, None).ok);
        let clip = store.invoke("recording-record-clip", &wire::encode_json(&json!([{"relativePath":"source.mp4"}])).unwrap()).unwrap();
        let clip = wire::decode(&clip).unwrap().into_json().unwrap();
        let source_id = clip["result"]["id"].as_str().unwrap();
        let editor = RecordingEditor::new(store.clone());
        let job = editor.start(json!({"sourceId":source_id,"operation":"trim","startMs":500,"endMs":1500,"audio":"mute","outputName":"Trimmed"})).unwrap();
        let job_id = job["jobId"].as_str().unwrap().to_owned();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut final_job = job;
        while final_job["state"].as_str() == Some("queued") || final_job["state"].as_str() == Some("running") {
            assert!(std::time::Instant::now() < deadline, "editor job timed out: {final_job}");
            std::thread::sleep(Duration::from_millis(100));
            final_job = editor.status(&job_id).unwrap();
        }
        assert_eq!(final_job["state"], "ready", "{final_job}");
        let output = root.join(final_job["clip"]["relativePath"].as_str().unwrap());
        assert!(output.is_file());
        drop(editor);
        drop(store);
        std::fs::remove_dir_all(root).unwrap();
    }
}
