//! Native recording playback: opaque clip URLs, range-capable clip streaming,
//! clip deletion, and cached FFmpeg thumbnails. The renderer still owns the
//! actual HTML5 video element; this module is the media backend.
use super::native_store::NativeStore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_THUMBNAIL_BYTES: u64 = 4 * 1024 * 1024;
const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(15);
static THUMBNAIL_LOCK: Mutex<()> = Mutex::new(());

pub struct MediaResponse { pub status: u16, pub headers: Vec<(String, String)>, pub body: Vec<u8> }

fn wire_empty() -> Value { json!({"t":"array","v":[]}) }
fn wire_array(values: &[Value]) -> Result<Value, String> {
    let mut items = Vec::with_capacity(values.len());
    for value in values { items.push(super::wire::encode_json(value)?); }
    Ok(json!({"t":"array","v":items}))
}
fn call(store: &NativeStore, method: &str, args: &[Value]) -> Result<Value, String> {
    let reply = store.invoke(method, &wire_array(args)?)?;
    super::wire::decode(&reply)?.into_json()
}
fn empty_args(store: &NativeStore, method: &str) -> Result<Value, String> {
    let reply = store.invoke(method, &wire_empty())?;
    super::wire::decode(&reply)?.into_json()
}
fn unwrap_result(value: Value) -> Value { value.get("result").cloned().unwrap_or(value) }

pub fn clip_list(store: &NativeStore) -> Result<Value, String> {
    let response = call(store, "recording-scan-clips", &[])
        .or_else(|_| call(store, "recording-list-clips", &[]))?;
    let clips = unwrap_result(response);
    let Some(clips) = clips.as_array() else { return Ok(Value::Array(Vec::new())); };
    let out: Vec<Value> = clips.iter().map(|clip| {
        let mut clip = clip.clone();
        if let Some(id) = clip.get("id").and_then(Value::as_str) {
            clip["thumbnailUrl"] = json!(format!("arc-power-media://thumbnail/{id}"));
        }
        clip
    }).collect();
    Ok(Value::Array(out))
}

pub fn clip_url(store: &NativeStore, id: &str) -> Result<String, String> {
    if !opaque_id(id) { return Err("recording-clip-url: invalid clip id".into()); }
    let clip = unwrap_result(call(store, "recording-clip-by-id", &[json!(id)])?);
    if clip.is_null() { return Err("recording-clip-url: clip not found".into()); }
    Ok(format!("arc-power-media://clip/{id}"))
}

pub fn clip_delete(store: &NativeStore, id: &str) -> Result<Value, String> {
    if !opaque_id(id) { return Err("recording-clip-delete: invalid clip id".into()); }
    let path = match super::services::recording_clip_path(store, id) {
        Ok(path) => path,
        Err(_) => return Ok(json!({"ok":false,"id":id,"removed":false,"reason":"not-found"})),
    };
    if let Err(error) = std::fs::remove_file(&path) {
        let reason = if error.kind() == std::io::ErrorKind::NotFound { "not-found" } else { "delete-failed" };
        return Ok(json!({"ok":false,"id":id,"removed":false,"reason":reason}));
    }
    let deleted = unwrap_result(call(store, "recording-delete-clip", &[json!(id)])?);
    if !deleted.is_null() {
        Ok(json!({"ok":true,"id":id,"removed":true,"reason":Value::Null}))
    } else {
        Ok(json!({"ok":false,"id":id,"removed":false,"reason":"not-found"}))
    }
}

pub fn serve(store: &NativeStore, url: &str, method: &str, range: Option<&str>, max_body: usize) -> Result<MediaResponse, String> {
    let rest = url.strip_prefix("arc-power-media://").ok_or("Invalid media route")?;
    let (kind, id) = rest.split_once('/').ok_or("Invalid media route")?;
    if !opaque_id(id) { return Err("Invalid opaque clip id".into()); }
    let path = super::services::recording_clip_path(store, id)?;
    if kind == "thumbnail" {
        let image = thumbnail(store, id, Path::new(&path)).ok_or("Thumbnail unavailable")?;
        let headers = vec![
            ("Cache-Control".into(), "private, max-age=3600".into()),
            ("Content-Length".into(), image.len().to_string()),
            ("Content-Type".into(), "image/jpeg".into()),
        ];
        return Ok(MediaResponse { status: 200, headers, body: if method.eq_ignore_ascii_case("HEAD") { Vec::new() } else { image } });
    }
    if kind != "clip" { return Err("Invalid media route".into()); }
    media_response(Path::new(&path), method, range, max_body)
}

fn media_response(path: &Path, method: &str, range: Option<&str>, max_body: usize) -> Result<MediaResponse, String> {
    let mut file = File::open(path).map_err(|_| "Clip not found")?;
    let size = file.metadata().map_err(|_| "Clip not found")?.len();
    let range = parse_byte_range(range, size);
    if range.is_none() {
        return Ok(MediaResponse { status: 416, headers: vec![
            ("Accept-Ranges".into(), "bytes".into()),
            ("Content-Range".into(), format!("bytes */{size}")),
            ("Content-Length".into(), "0".into()),
        ], body: Vec::new() });
    }
    let range = range.unwrap();
    let start = range.0;
    let mut end = range.1;
    let partial = range.2;
    let mut capped = false;
    if !method.eq_ignore_ascii_case("HEAD") && max_body > 0 && size > 0
        && end.saturating_sub(start) + 1 > max_body as u64 {
        end = start + max_body as u64 - 1;
        capped = true;
    }
    let status = if partial || capped { 206 } else { 200 };
    let length = if size == 0 { 0 } else { end.saturating_sub(start) + 1 };
    let content_type = media_content_type(path);
    let mut headers = vec![
        ("Accept-Ranges".into(), "bytes".into()),
        ("Content-Length".into(), length.to_string()),
        ("Content-Type".into(), content_type.into()),
    ];
    if partial || end != size.saturating_sub(1) {
        headers.push(("Content-Range".into(), format!("bytes {start}-{end}/{size}")));
    }
    if method.eq_ignore_ascii_case("HEAD") || length == 0 {
        return Ok(MediaResponse { status, headers, body: Vec::new() });
    }
    file.seek(SeekFrom::Start(start)).map_err(|_| "Clip read failed")?;
    let mut body = vec![0u8; length as usize];
    file.read_exact(&mut body).map_err(|_| "Clip read failed")?;
    Ok(MediaResponse { status, headers, body })
}

fn parse_byte_range(value: Option<&str>, size: u64) -> Option<(u64, u64, bool)> {
    if value.is_none() || value.is_some_and(|value| value.trim().is_empty()) {
        return Some((0, size.saturating_sub(1), false));
    }
    let value = value?.trim();
    let value = value.strip_prefix("bytes=")?;
    if value.contains(',') || size == 0 { return None; }
    let (start_text, end_text) = value.split_once('-')?;
    if start_text.is_empty() && end_text.is_empty() { return None; }
    let (start, end) = if start_text.is_empty() {
        let suffix: u64 = end_text.parse().ok()?;
        if suffix == 0 { return None; }
        (size.saturating_sub(suffix), size - 1)
    } else {
        let start: u64 = start_text.parse().ok()?;
        if start >= size { return None; }
        let end = if end_text.is_empty() { size - 1 } else { end_text.parse::<u64>().ok()?.min(size - 1) };
        if end < start { return None; }
        (start, end)
    };
    Some((start, end, true))
}

fn media_content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("mp4" | "m4v") => "video/mp4",
        Some("mkv") => "video/x-matroska",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        _ => "application/octet-stream",
    }
}

fn opaque_id(id: &str) -> bool {
    (8..=128).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn thumbnail(store: &NativeStore, id: &str, path: &Path) -> Option<Vec<u8>> {
    let _guard = THUMBNAIL_LOCK.lock().ok()?;
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 { return None; }
    let modified = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_millis();
    let digest = Sha256::digest(format!("{id}\0{}\0{modified}", metadata.len()).as_bytes());
    let key: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    let cache_dir = std::env::var_os("APPDATA").map(|root| PathBuf::from(root).join("ArcPower").join("recording-thumbnails"))?;
    let output = cache_dir.join(format!("{key}.jpg"));
    if let Some(image) = read_thumbnail(&output) { return Some(image); }
    std::fs::create_dir_all(&cache_dir).ok()?;
    let executable = ffmpeg_path(store)?;
    let temporary = cache_dir.join(format!("{key}.tmp-{}-{}", std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_nanos()));
    for seek in ["0.5", "0"] {
        if run_ffmpeg(&executable, path, &temporary, seek).is_some() {
            if std::fs::rename(&temporary, &output).is_err() {
                if let Some(image) = read_thumbnail(&output) { let _ = std::fs::remove_file(&temporary); return Some(image); }
            }
            let _ = std::fs::remove_file(&temporary);
            return read_thumbnail(&output);
        }
        let _ = std::fs::remove_file(&temporary);
    }
    None
}

fn read_thumbnail(path: &Path) -> Option<Vec<u8>> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_THUMBNAIL_BYTES { return None; }
    std::fs::read(path).ok()
}

fn run_ffmpeg(executable: &Path, input: &Path, output: &Path, seek: &str) -> Option<()> {
    let mut command = Command::new(executable);
    // A thumbnail needs one frame. Avoid a full decoder thread pool for each preview.
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-threads", "1",
        "-filter_threads", "1", "-ss", seek, "-i"])
        .arg(input)
        .args(["-map", "0:v:0", "-frames:v", "1", "-vf", "scale=640:-2:force_original_aspect_ratio=decrease",
            "-threads", "1", "-q:v", "3", "-f", "mjpeg", "-y"])
        .arg(output)
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + THUMBNAIL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success().then_some(()),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => { let _ = child.kill(); let _ = child.wait(); return None; }
        }
    }
}

fn ffmpeg_path(store: &NativeStore) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("ARC_POWER_FFMPEG") {
        let path = PathBuf::from(path);
        if path.is_file() { return Some(path); }
    }
    let mut roots = Vec::new();
    let settings = empty_args(store, "recording-settings").ok().map(unwrap_result).unwrap_or(Value::Null);
    if let Some(runtime) = settings.get("runtimePath").and_then(Value::as_str).filter(|value| !value.is_empty()) {
        roots.push(PathBuf::from(runtime));
    }
    if let Some(root) = std::env::current_exe().ok().and_then(|path| path.parent().map(Path::to_path_buf)) {
        roots.push(root.join("resources/recording-runtime"));
        roots.push(root.join("compatibility-backend/resources/recording-runtime"));
    }
    roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("recording-runtime"));
    roots.into_iter().map(|root| root.join("bin/64bit/ffmpeg.exe")).find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn byte_ranges_match_the_electron_contract() {
        assert_eq!(parse_byte_range(None, 100), Some((0, 99, false)));
        assert_eq!(parse_byte_range(Some("bytes=10-19"), 100), Some((10, 19, true)));
        assert_eq!(parse_byte_range(Some("bytes=90-"), 100), Some((90, 99, true)));
        assert_eq!(parse_byte_range(Some("bytes=-10"), 100), Some((90, 99, true)));
        assert_eq!(parse_byte_range(Some("bytes=100-"), 100), None);
        assert_eq!(parse_byte_range(Some("bytes=20-10"), 100), None);
        assert_eq!(parse_byte_range(Some("bytes=0-1,3-4"), 100), None);
        assert_eq!(parse_byte_range(Some("bytes=0-0"), 0), None);
    }

    #[test]
    fn native_clip_listing_streaming_and_delete_round_trip() {
        let root = std::env::temp_dir().join(format!("arc-playback-store-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let clips = root.join("clips");
        std::fs::create_dir(&clips).unwrap();
        let store = NativeStore::new(root.clone(), "advanced").unwrap();
        call(&store, "recording-save-settings", &[json!({"location": clips.to_str().unwrap()})]).unwrap();
        std::fs::write(clips.join("clip.mp4"), (0u8..64).collect::<Vec<_>>()).unwrap();
        call(&store, "recording-record-clip", &[json!({"relativePath":"clip.mp4"})]).unwrap();
        let list = clip_list(&store).unwrap();
        let clip = &list.as_array().unwrap()[0];
        let id = clip["id"].as_str().unwrap();
        assert!(clip["thumbnailUrl"].as_str().unwrap().ends_with(&format!("/thumbnail/{id}")));
        assert_eq!(clip_url(&store, id).unwrap(), format!("arc-power-media://clip/{id}"));
        let response = serve(&store, &format!("arc-power-media://clip/{id}"), "GET", Some("bytes=8-15"), 4 * 1024 * 1024).unwrap();
        assert_eq!(response.status, 206);
        assert_eq!(response.body, (8u8..16).collect::<Vec<_>>());
        assert!(clip_delete(&store, id).unwrap()["removed"].as_bool().unwrap());
        assert!(!clips.join("clip.mp4").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn opaque_ids_and_content_types_are_bounded() {
        assert!(opaque_id("abcdefgh"));
        assert!(opaque_id("clip_123-ABC"));
        assert!(!opaque_id("short"));
        assert!(!opaque_id("../escape"));
        assert_eq!(media_content_type(Path::new("a.MP4")), "video/mp4");
        assert_eq!(media_content_type(Path::new("a.mkv")), "video/x-matroska");
    }

    #[test]
    #[ignore = "live read-only playback check against the existing recording library"]
    fn live_existing_clip_streams_and_thumbnails() {
        let root = std::env::var_os("APPDATA").map(PathBuf::from).unwrap().join("ArcPower");
        let store = NativeStore::new(root, "advanced").unwrap();
        let list = unwrap_result(call(&store, "recording-list-clips", &[]).unwrap());
        let id = list.as_array().and_then(|clips| clips.first()).and_then(|clip| clip["id"].as_str()).unwrap().to_owned();
        assert_eq!(clip_url(&store, &id).unwrap(), format!("arc-power-media://clip/{id}"));
        let response = serve(&store, &format!("arc-power-media://clip/{id}"), "GET", Some("bytes=0-15"), 4 * 1024 * 1024).unwrap();
        assert_eq!(response.status, 206);
        assert_eq!(response.body.len(), 16);
        let thumbnail = serve(&store, &format!("arc-power-media://thumbnail/{id}"), "GET", None, 4 * 1024 * 1024).unwrap();
        assert_eq!(thumbnail.status, 200);
        assert_eq!(&thumbnail.body[..2], &[0xff, 0xd8]);
    }
    #[test]
    fn media_responses_are_bounded_and_range_exact() {
        let root = std::env::temp_dir().join(format!("arc-playback-test-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("clip.mp4");
        std::fs::write(&path, (0u8..100).collect::<Vec<_>>()).unwrap();
        let response = media_response(&path, "GET", Some("bytes=10-19"), 4 * 1024 * 1024).unwrap();
        assert_eq!(response.status, 206);
        assert_eq!(response.body, (10u8..20).collect::<Vec<_>>());
        assert!(response.headers.iter().any(|(name, value)| name == "Content-Range" && value == "bytes 10-19/100"));
        let capped = media_response(&path, "GET", Some("bytes=0-99"), 16).unwrap();
        assert_eq!(capped.status, 206);
        assert_eq!(capped.body.len(), 16);
        assert!(capped.headers.iter().any(|(name, value)| name == "Content-Range" && value == "bytes 0-15/100"));
        let head = media_response(&path, "HEAD", None, 4 * 1024 * 1024).unwrap();
        assert_eq!(head.status, 200);
        assert!(head.body.is_empty());
        assert_eq!(head.headers.iter().find(|(name, _)| name == "Content-Length").unwrap().1, "100");
        let invalid = media_response(&path, "GET", Some("bytes=100-"), 4 * 1024 * 1024).unwrap();
        assert_eq!(invalid.status, 416);
        std::fs::remove_dir_all(root).unwrap();
    }
}
