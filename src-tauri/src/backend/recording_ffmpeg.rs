//! Shared FFmpeg process helpers for recording clip bounding and editor jobs.
use super::native_store::NativeStore;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::{Duration, Instant};

#[derive(Default)]
pub struct RunResult {
    pub ok: bool,
    pub timed_out: bool,
    pub cancelled: bool,
    pub stderr: String,
    pub stdout: String,
}

fn setting_string(store: &NativeStore, key: &str) -> Option<String> {
    let encoded = super::wire::encode_json(&serde_json::json!([])).ok()?;
    let reply = store.invoke("recording-settings", &encoded).ok()?;
    let value = super::wire::decode(&reply).ok()?.into_json().ok()?;
    value.get("result").unwrap_or(&value).get(key).and_then(Value::as_str)
        .map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}

/// Locate one bundled runtime executable without accepting renderer paths.
pub fn runtime_executable(store: &NativeStore, name: &str) -> Option<PathBuf> {
    let env_name = if name == "ffprobe.exe" { "ARC_POWER_FFPROBE" } else { "ARC_POWER_FFMPEG" };
    if let Some(path) = std::env::var_os(env_name) {
        let path = PathBuf::from(path);
        if path.is_file() { return Some(path); }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(runtime) = setting_string(store, "runtimePath") {
        roots.push(PathBuf::from(runtime));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("resources").join("recording-runtime"));
            roots.push(parent.join("compatibility-backend").join("resources").join("recording-runtime"));
            roots.push(parent.join("recording-runtime"));
        }
    }
    roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("recording-runtime"));
    if let Ok(cwd) = std::env::current_dir() { roots.push(cwd.join("recording-runtime")); }
    roots.into_iter().map(|root| root.join("bin").join("64bit").join(name)).find(|path| path.is_file())
}

fn drain_reader(reader: impl std::io::Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(count) => { if sender.send(buffer[..count].to_vec()).is_err() { break; } }
            }
        }
    });
    receiver
}

pub fn run(
    executable: &Path,
    args: &[String],
    timeout: Duration,
    cancel: Option<&AtomicBool>,
    progress: Option<&(dyn Fn(f64) + Sync)>,
) -> RunResult {
    let mut command = Command::new(executable);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child: Child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return RunResult { stderr: error.to_string(), ..RunResult::default() },
    };
    let stdout = child.stdout.take().map(drain_reader);
    let stderr = child.stderr.take().map(drain_reader);
    let deadline = Instant::now() + timeout;
    let mut result = RunResult::default();
    loop {
        if cancel.is_some_and(|flag| flag.load(Ordering::Acquire)) {
            result.cancelled = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        if Instant::now() >= deadline {
            result.timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                result.ok = status.success();
                break;
            }
            Ok(None) => {}
            Err(error) => {
                result.stderr.push_str(&error.to_string());
                let _ = child.kill();
                break;
            }
        }
        if let Some(receiver) = &stderr {
            while let Ok(chunk) = receiver.try_recv() {
                result.stderr.push_str(&String::from_utf8_lossy(&chunk));
                if result.stderr.len() > 8192 { result.stderr = result.stderr[result.stderr.len() - 8192..].to_owned(); }
                if let Some(callback) = progress {
                    if let Some(seconds) = last_time_seconds(&result.stderr) { callback(seconds); }
                }
            }
        }
        if let Some(receiver) = &stdout {
            while let Ok(chunk) = receiver.try_recv() {
                result.stdout.push_str(&String::from_utf8_lossy(&chunk));
                if result.stdout.len() > 8192 { result.stdout = result.stdout[result.stdout.len() - 8192..].to_owned(); }
            }
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    if let Some(receiver) = stderr {
        while let Ok(chunk) = receiver.try_recv() { result.stderr.push_str(&String::from_utf8_lossy(&chunk)); }
    }
    if let Some(receiver) = stdout {
        while let Ok(chunk) = receiver.try_recv() { result.stdout.push_str(&String::from_utf8_lossy(&chunk)); }
    }
    result
}

fn last_time_seconds(stderr: &str) -> Option<f64> {
    let marker = stderr.rfind("time=")?;
    let text = &stderr[marker + 5..];
    let end = text.find(|character: char| character.is_whitespace()).unwrap_or(text.len());
    let mut parts = text[..end].split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

pub fn probe_duration(ffprobe: Option<&Path>, file_path: &Path) -> Option<f64> {
    let ffprobe = ffprobe?;
    let args = vec![
        "-v".into(), "error".into(),
        "-show_entries".into(), "format=duration".into(),
        "-of".into(), "json".into(),
        "-i".into(), file_path.to_string_lossy().into_owned(),
    ];
    let result = run(ffprobe, &args, Duration::from_secs(15), None, None);
    if !result.ok { return None; }
    let value: Value = serde_json::from_str(&result.stdout).ok()?;
    let duration = value["format"]["duration"].as_str().and_then(|value| value.parse::<f64>().ok())
        .or_else(|| value["format"]["duration"].as_f64())?;
    (duration.is_finite() && duration > 0.0).then_some(duration * 1000.0)
}

/// Keep one bounded operation shared by replay-save duration correction and
/// the editor. The caller supplies a completed source; publication is atomic.
pub struct TrimResult {
    pub path: String,
}

fn retryable(error: &std::io::Error) -> bool {
    matches!(error.kind(), std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::WouldBlock)
        || matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

fn retry_file<T>(mut operation: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if retryable(&error) && Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(error),
        }
    }
}

fn usable(path: &Path) -> bool {
    std::fs::metadata(path).map(|metadata| metadata.is_file() && metadata.len() > 0).unwrap_or(false)
}

fn seconds(ms: i64) -> String {
    format!("{:.3}", ms.max(1) as f64 / 1000.0)
}

pub fn copy_arguments(input: &Path, output: &Path, duration_ms: i64, source_duration_ms: Option<f64>) -> Vec<String> {
    let duration = seconds(duration_ms);
    let mut args: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-nostdin".into()];
    if let Some(source_duration) = source_duration_ms.filter(|value| *value > 0.0) {
        let offset = ((source_duration - duration_ms as f64).max(0.0)) / 1000.0;
        args.extend(["-i".into(), input.to_string_lossy().into_owned(), "-ss".into(), format!("{offset:.3}")]);
    } else {
        args.extend(["-sseof".into(), format!("-{duration}"), "-i".into(), input.to_string_lossy().into_owned()]);
    }
    args.extend(["-map".into(), "0:v:0".into(), "-map".into(), "0:a?".into(),
        "-t".into(), duration, "-c".into(), "copy".into(),
        "-avoid_negative_ts".into(), "make_zero".into(), "-movflags".into(), "+faststart".into(),
        "-f".into(), "mp4".into(), "-y".into(), output.to_string_lossy().into_owned()]);
    args
}

pub fn reencode_arguments(input: &Path, output: &Path, duration_ms: i64) -> Vec<String> {
    let duration = seconds(duration_ms);
    vec!["-hide_banner".into(), "-loglevel".into(), "error".into(), "-nostdin".into(),
        "-sseof".into(), format!("-{duration}"), "-i".into(), input.to_string_lossy().into_owned(),
        "-map".into(), "0:v:0".into(), "-map".into(), "0:a?".into(),
        "-t".into(), duration, "-c:v".into(), "libx264".into(),
        "-preset".into(), "ultrafast".into(), "-crf".into(), "18".into(), "-c:a".into(), "aac".into(),
        "-avoid_negative_ts".into(), "make_zero".into(), "-f".into(), "mp4".into(), "-y".into(),
        output.to_string_lossy().into_owned()]
}

fn fallback_path(destination: &Path) -> Option<PathBuf> {
    let parent = destination.parent()?;
    let stem = destination.file_stem()?.to_string_lossy();
    let extension = destination.extension().map(|value| value.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
    for index in 1..=100 {
        let suffix = if index == 1 { " (trimmed)".to_owned() } else { format!(" (trimmed {index})") };
        let candidate = parent.join(format!("{stem}{suffix}.{extension}"));
        if !candidate.exists() { return Some(candidate); }
    }
    None
}

fn publish(temp: &Path, destination: &Path, replace_in_place: bool, source: &Path) -> Result<PathBuf, String> {
    if !replace_in_place {
        if retry_file(|| std::fs::rename(temp, destination)).is_ok() { return Ok(destination.to_path_buf()); }
        let fallback = fallback_path(destination).ok_or("No fallback recording path is available")?;
        retry_file(|| std::fs::rename(temp, &fallback)).map_err(|error| error.to_string())?;
        return Ok(fallback);
    }
    let backup = destination.with_file_name(format!("{}.arc-original-{}.tmp",
        destination.file_name().map(|value| value.to_string_lossy()).unwrap_or_default(),
        rand::random::<u64>()));
    if retry_file(|| std::fs::rename(source, &backup)).is_err() {
        let fallback = fallback_path(destination).ok_or("The recording file is still in use")?;
        retry_file(|| std::fs::rename(temp, &fallback)).map_err(|error| error.to_string())?;
        return Ok(fallback);
    }
    if retry_file(|| std::fs::rename(temp, destination)).is_err() {
        let restored = retry_file(|| std::fs::rename(&backup, destination)).is_ok();
        if restored {
            let fallback = fallback_path(destination).ok_or("The recording file is still in use")?;
            retry_file(|| std::fs::rename(temp, &fallback)).map_err(|error| error.to_string())?;
            return Ok(fallback);
        }
        return Err("The bounded recording could not be published".into());
    }
    let _ = retry_file(|| std::fs::remove_file(&backup));
    Ok(destination.to_path_buf())
}

/// Bound a completed replay source to its requested tail. Fails closed: an
/// unbounded rolling buffer is never returned as a successful clip.
pub fn trim_to_duration(store: &NativeStore, source: &Path, duration_ms: i64, destination: &Path) -> Result<TrimResult, String> {
    if duration_ms <= 0 || !usable(source) { return Err("Replay clip source is unavailable".into()); }
    let ffmpeg = runtime_executable(store, "ffmpeg.exe").ok_or("Bundled FFmpeg is unavailable")?;
    let ffprobe = runtime_executable(store, "ffprobe.exe");
    let replace_in_place = same_path(source, destination);
    let token = rand::random::<u64>();
    let temp = destination.with_file_name(format!("{}.arc-trim-{token}.tmp",
        destination.file_name().map(|value| value.to_string_lossy()).unwrap_or_default()));
    if same_path(&temp, source) { return Err("Invalid replay trim destination".into()); }
    let snapshot = source.with_file_name(format!("{}.arc-source-{token}.mp4",
        source.file_name().map(|value| value.to_string_lossy()).unwrap_or_default()));
    let snapshot_ok = retry_file(|| std::fs::copy(source, &snapshot)).is_ok() && usable(&snapshot);
    let trimmed_source = if snapshot_ok { snapshot.clone() } else { source.to_path_buf() };
    let output_matches = |path: &Path| {
        if ffprobe.is_none() { return true; }
        probe_duration(ffprobe.as_deref(), path).is_some_and(|actual| actual > 0.0 && actual <= duration_ms as f64 + 750.0)
    };
    let render = |input: &Path| -> bool {
        let source_duration = probe_duration(ffprobe.as_deref(), input);
        let copy = copy_arguments(input, &temp, duration_ms, source_duration);
        if run(&ffmpeg, &copy, Duration::from_secs(30), None, None).ok && usable(&temp) && output_matches(&temp) {
            return true;
        }
        let _ = std::fs::remove_file(&temp);
        let reencode = reencode_arguments(input, &temp, duration_ms);
        if run(&ffmpeg, &reencode, Duration::from_secs(30), None, None).ok && usable(&temp) && output_matches(&temp) {
            return true;
        }
        let _ = std::fs::remove_file(&temp);
        false
    };
    let mut rendered = render(&trimmed_source);
    if !rendered && snapshot_ok {
        rendered = render(source);
    }
    let result = if rendered {
        publish(&temp, destination, replace_in_place, source)
    } else {
        Err("Replay clip could not be limited to the requested duration".into())
    };
    let _ = retry_file(|| std::fs::remove_file(&snapshot));
    if result.is_err() { let _ = retry_file(|| std::fs::remove_file(&temp)); }
    result.map(|path| TrimResult { path: path.to_string_lossy().into_owned() })
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_and_reencode_arguments_preserve_the_exact_tail() {
        let copy = copy_arguments(Path::new("in.mp4"), Path::new("out.mp4"), 12_345, Some(30_000.0));
        assert!(copy.windows(2).any(|pair| pair == ["-t", "12.345"]));
        assert!(copy.windows(2).any(|pair| pair == ["-ss", "17.655"]));
        let reencode = reencode_arguments(Path::new("in.mp4"), Path::new("out.mp4"), 2_000);
        assert!(reencode.windows(2).any(|pair| pair == ["-c:v", "libx264"]));
        assert!(reencode.windows(2).any(|pair| pair == ["-t", "2.000"]));
    }

    #[test]
    fn progress_parser_reads_the_last_timestamp() {
        assert_eq!(last_time_seconds("frame=1 time=00:01:02.50 bitrate=x"), Some(62.5));
        assert_eq!(last_time_seconds("no timestamp"), None);
    }

    #[test]
    #[ignore = "live FFmpeg synthetic trim check"]
    fn live_synthetic_clip_is_bounded_to_the_requested_tail() {
        let root = std::env::temp_dir().join(format!("arc-trim-test-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let store = NativeStore::new(root.clone(), "advanced").unwrap();
        let ffmpeg = runtime_executable(&store, "ffmpeg.exe").unwrap();
        let ffprobe = runtime_executable(&store, "ffprobe.exe").unwrap();
        let source = root.join("source.mp4");
        let args: Vec<String> = ["-hide_banner","-loglevel","error","-f","lavfi","-i","testsrc=size=320x180:rate=30",
            "-t","3","-c:v","libx264","-preset","ultrafast","-pix_fmt","yuv420p","-y"]
            .into_iter().map(str::to_owned).chain([source.to_string_lossy().into_owned()]).collect();
        assert!(run(&ffmpeg, &args, Duration::from_secs(30), None, None).ok);
        let expected = probe_duration(Some(&ffprobe), &source).unwrap();
        assert!(expected >= 2_500.0);
        let destination = root.join("bounded.mp4");
        let result = trim_to_duration(&store, &source, 1_500, &destination).unwrap();
        let actual = probe_duration(Some(&ffprobe), Path::new(&result.path)).unwrap();
        assert!(actual > 0.0 && actual <= 1_750.0, "bounded duration {actual}");
        std::fs::remove_dir_all(root).unwrap();
    }
}
