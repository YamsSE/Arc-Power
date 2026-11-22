//! Native GitHub release update transport for the Tauri host.
//!
//! Release metadata, download authorization, SHA-256 receipts and handoff are
//! kept in this process. The renderer receives only the selected asset fields
//! and an opaque one-use receipt token.

use arc_power_tauri::backend::{native_system::BuildKind, update_release, wire};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{Condvar, Mutex, OnceLock},
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};
use url::Url;

const RELEASE_API: &str = "https://api.github.com/repos/YamsSE/Arc-Power/releases/latest";
const MAX_RELEASE_BYTES: u64 = 1024 * 1024;
const MAX_UPDATE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const UPDATE_ROOT_NAME: &str = "arc-power-updates";

#[derive(Clone)]
struct CheckedAsset {
    version: String,
    url: String,
    name: String,
    size: Option<u64>,
    digest: String,
}

#[derive(Clone)]
struct Receipt {
    build_kind: String,
    path: PathBuf,
    digest: String,
}

#[derive(Default)]
struct UpdateState {
    checked: HashMap<String, CheckedAsset>,
    check_generation: HashMap<String, String>,
    receipts: HashMap<String, Receipt>,
    installing: HashSet<String>,
}

fn state() -> &'static Mutex<UpdateState> {
    static STATE: OnceLock<Mutex<UpdateState>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(UpdateState::default()))
}

struct CheckFlight {
    result: Mutex<Option<Result<Value, String>>>,
    ready: Condvar,
}

impl CheckFlight {
    fn new() -> Self { Self { result: Mutex::new(None), ready: Condvar::new() } }
    fn is_done(&self) -> bool { self.result.lock().unwrap().is_some() }
    fn finish(&self, result: Result<Value, String>) {
        let mut current = self.result.lock().unwrap();
        if current.is_none() {
            *current = Some(result);
            self.ready.notify_all();
        }
    }
    fn wait(&self) -> Result<Value, String> {
        let mut result = self.result.lock().unwrap();
        while result.is_none() { result = self.ready.wait(result).unwrap(); }
        result.as_ref().unwrap().clone()
    }
}

#[derive(Default)]
struct CheckGate { startup: Option<std::sync::Arc<CheckFlight>>, manual: Option<std::sync::Arc<CheckFlight>> }

fn check_gate() -> &'static Mutex<CheckGate> {
    static GATE: OnceLock<Mutex<CheckGate>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(CheckGate::default()))
}

fn run_check(kind: BuildKind, intent: &str) -> Result<Value, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| check(kind, intent)))
        .unwrap_or_else(|_| Err("Native updater check failed before completion".into()))
}

/// Startup checks are shared; manual checks wait for the startup request to
/// finish, then share one fresh request with concurrent manual callers.
fn coordinated_check(kind: BuildKind, intent: &str) -> Result<Value, String> {
    if intent == "startup" {
        let (flight, owner) = {
            let mut gate = check_gate().lock().map_err(|_| "Native updater check gate was poisoned")?;
            if let Some(flight) = gate.startup.as_ref() { (flight.clone(), false) }
            else {
                let flight = std::sync::Arc::new(CheckFlight::new());
                gate.startup = Some(flight.clone());
                (flight, true)
            }
        };
        if owner { flight.finish(run_check(kind, "startup")); }
        return flight.wait();
    }
    loop {
        let (startup, flight, owner) = {
            let mut gate = check_gate().lock().map_err(|_| "Native updater check gate was poisoned")?;
            if gate.startup.as_ref().is_some_and(|flight| !flight.is_done()) {
                (gate.startup.clone(), None, false)
            } else if let Some(flight) = gate.manual.as_ref() {
                (None, Some(flight.clone()), false)
            } else {
                let flight = std::sync::Arc::new(CheckFlight::new());
                gate.manual = Some(flight.clone());
                (None, Some(flight), true)
            }
        };
        if let Some(startup) = startup { let _ = startup.wait(); continue; }
        let flight = flight.expect("manual updater check flight");
        if owner {
            flight.finish(run_check(kind, "manual"));
            let mut gate = check_gate().lock().map_err(|_| "Native updater check gate was poisoned")?;
            if gate.manual.as_ref().is_some_and(|current| std::sync::Arc::ptr_eq(current, &flight)) {
                gate.manual = None;
            }
        }
        return flight.wait();
    }
}

/// Release manual checks at the same six-second startup deadline used by the
/// splash coordinator. The original blocking request may still finish later,
/// but its completed flight cannot replace this settled timeout.
pub fn settle_startup_check_timeout() {
    let flight = {
        let mut gate = check_gate().lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        gate.startup.get_or_insert_with(|| std::sync::Arc::new(CheckFlight::new())).clone()
    };
    flight.finish(Err("GitHub update check timed out".into()));
}

fn build_kind_name(kind: BuildKind) -> &'static str { kind.as_str() }

fn expected_asset_name(kind: BuildKind) -> Option<&'static str> {
    match kind {
        BuildKind::Installed => Some("Arc-Power_Installer.exe"),
        BuildKind::Portable => Some("Arc-Power_Portable.exe"),
        BuildKind::Dev => None,
    }
}

fn args(args: &Value) -> Result<Vec<wire::WireValue>, String> {
    match wire::decode(args)? {
        wire::WireValue::Array(args) => Ok(args),
        _ => Err("Expected argument array".into()),
    }
}

fn parse_check_intent(args: &[wire::WireValue]) -> Result<&'static str, String> {
    if args.len() > 1 { return Err("update:check intent must be startup or manual".into()); }
    let intent = match args.first() {
        None | Some(wire::WireValue::Undefined) => "startup",
        Some(wire::WireValue::Object(fields)) => {
            if fields.iter().any(|(key, _)| key != "intent") {
                return Err("update:check intent must be startup or manual".into());
            }
            match fields.iter().find(|(key, _)| key == "intent").map(|(_, value)| value) {
                None | Some(wire::WireValue::Undefined) => "startup",
                Some(wire::WireValue::String(value)) if value == "startup" => "startup",
                Some(wire::WireValue::String(value)) if value == "manual" => "manual",
                _ => return Err("update:check intent must be startup or manual".into()),
            }
        }
        _ => return Err("update:check intent must be startup or manual".into()),
    };
    Ok(intent)
}

pub fn check_intent(args_value: &Value) -> Result<&'static str, String> {
    parse_check_intent(&args(args_value)?)
}

fn allowed_download_url(value: &str) -> Option<String> {
    let parsed = Url::parse(value).ok()?;
    let host = parsed.host_str()?.to_ascii_lowercase();
    let github_host = host == "github.com"
        || host.ends_with(".github.com")
        || host.ends_with(".githubusercontent.com");
    if parsed.scheme() != "https" || !github_host || !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    Some(parsed.to_string())
}

fn http_client(timeout: Duration) -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(timeout)
        .user_agent(format!("Arc-Power/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Native updater network client unavailable: {error}"))
}

fn check(kind: BuildKind, intent: &str) -> Result<Value, String> {
    if intent != "startup" && intent != "manual" { return Err("update:check intent must be startup or manual".into()); }
    let key = build_kind_name(kind).to_owned();
    let generation = random_hex(16);
    {
        let mut locked = state().lock().map_err(|_| "Native updater state lock was poisoned")?;
        locked.checked.remove(&key);
        locked.check_generation.insert(key.clone(), generation.clone());
    }
    if expected_asset_name(kind).is_none() {
        return Ok(json!({"available":false}));
    }

    let client = http_client(Duration::from_secs(15))?;
    let response = client.get(RELEASE_API)
        .header(reqwest::header::ACCEPT, "application/vnd.github.v3+json")
        .send().map_err(|error| format!("GitHub release check failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("GitHub release check returned HTTP {}", response.status().as_u16()));
    }
    if response.content_length().is_some_and(|length| length > MAX_RELEASE_BYTES) {
        return Err("GitHub release metadata exceeds the native selection size limit".into());
    }
    let mut bytes = Vec::new();
    response.take(MAX_RELEASE_BYTES + 1).read_to_end(&mut bytes)
        .map_err(|error| format!("GitHub release metadata could not be read: {error}"))?;
    if bytes.len() as u64 > MAX_RELEASE_BYTES {
        return Err("GitHub release metadata exceeds the native selection size limit".into());
    }
    let release: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "GitHub release check returned invalid JSON")?;
    let selected = update_release::select(&release, &json!(key), &json!(env!("CARGO_PKG_VERSION")))?;
    let mut locked = state().lock().map_err(|_| "Native updater state lock was poisoned")?;
    if selected.get("available").and_then(Value::as_bool) != Some(true) {
        return Ok(json!({"available":false}));
    }
    let asset = CheckedAsset {
        version: selected.get("version").and_then(Value::as_str).ok_or("Native release selection omitted version")?.to_owned(),
        url: selected.get("assetUrl").and_then(Value::as_str).ok_or("Native release selection omitted URL")?.to_owned(),
        name: selected.get("assetName").and_then(Value::as_str).ok_or("Native release selection omitted name")?.to_owned(),
        size: selected.get("assetSize").and_then(Value::as_u64),
        digest: selected.get("expectedSha256").and_then(Value::as_str).ok_or("Native release selection omitted digest")?.to_owned(),
    };
    let public = json!({"available":true,"version":asset.version,"assetUrl":asset.url,
        "assetName":asset.name,"assetSize":asset.size});
    if locked.check_generation.get(&key) == Some(&generation) {
        locked.checked.insert(key, asset);
    }
    Ok(public)
}

fn redirected_url(current: &str, location: &str) -> Result<String, String> {
    let base = Url::parse(current).map_err(|_| "Update URL is invalid")?;
    let next = base.join(location).map_err(|_| "Update redirect URL is invalid")?;
    allowed_download_url(next.as_str()).ok_or_else(|| "Update redirected outside the HTTPS GitHub allowlist".into())
}

fn download_response(url: &str) -> Result<reqwest::blocking::Response, String> {
    let initial = allowed_download_url(url).ok_or("Invalid GitHub update asset URL")?;
    let client = http_client(Duration::from_secs(30 * 60))?;
    let mut current = initial;
    for hop in 0..=MAX_REDIRECTS {
        let response = client.get(&current).send()
            .map_err(|error| format!("Update download request failed: {error}"))?;
        if matches!(response.status().as_u16(), 301 | 302 | 303 | 307 | 308) {
            let location = response.headers().get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok()).ok_or("Update redirect omitted its location")?.to_owned();
            if hop == MAX_REDIRECTS { return Err("Too many update redirects".into()); }
            current = redirected_url(&current, &location)?;
            continue;
        }
        if !response.status().is_success() {
            return Err(format!("Update download returned HTTP {}", response.status().as_u16()));
        }
        if allowed_download_url(response.url().as_str()).is_none() {
            return Err("Update redirected outside the HTTPS GitHub allowlist".into());
        }
        return Ok(response);
    }
    Err("Too many update redirects".into())
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut value);
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn update_root() -> PathBuf { std::env::temp_dir().join(UPDATE_ROOT_NAME) }

fn emit_progress(app: &AppHandle, target: &str, downloaded: u64, total: Option<u64>) {
    let percent = total.filter(|value| *value > 0)
        .map(|value| ((downloaded.saturating_mul(100) / value).min(99)) as u8);
    let payload = json!({"downloadedBytes":downloaded,"totalBytes":total,"percent":percent});
    if target == "main" {
        if let Some(broker) = app.try_state::<std::sync::Arc<crate::Broker>>() {
            let transition = broker.startup_update.download_progress(&payload);
            crate::publish_startup_update_transition(app, broker.inner().as_ref(), transition);
        }
    }
    if let Ok(args) = wire::encode_json(&json!([payload])) {
        let event = json!({"channel":"update:download-progress","args":args});
        let _ = app.emit_to(target, "arc-power:broker-event", event.clone());
    }
}

fn download(app: &AppHandle, target: &str, kind: BuildKind, asset_url: &str) -> Result<Value, String> {
    let key = build_kind_name(kind).to_owned();
    let expected_name = expected_asset_name(kind).ok_or("Update target is unavailable for this build")?;
    let asset = state().lock().map_err(|_| "Native updater state lock was poisoned")?
        .checked.get(&key).cloned().ok_or("Update asset is not authorized by the latest release check")?;
    if asset.name != expected_name || asset.url != asset_url {
        return Err("Update asset is not authorized by the latest release check".into());
    }
    let root = update_root();
    fs::create_dir_all(&root).map_err(|error| format!("Cannot create update staging directory: {error}"))?;
    let download_dir = root.join(random_hex(16));
    fs::create_dir(&download_dir).map_err(|error| format!("Cannot create update staging directory: {error}"))?;
    let destination = download_dir.join(expected_name);
    let partial = download_dir.join(format!("{expected_name}.part"));
    let result = (|| {
        let mut response = download_response(&asset.url)?;
        let content_length = response.content_length().filter(|length| *length > 0);
        if content_length.is_some_and(|length| length > MAX_UPDATE_BYTES || asset.size.is_some_and(|size| size != length)) {
            return Err("Update download size does not match release metadata".into());
        }
        let total = content_length.or(asset.size);
        if total.is_some_and(|length| length > MAX_UPDATE_BYTES) { return Err("Update asset exceeds the native download limit".into()); }
        let mut file = OpenOptions::new().write(true).create_new(true).open(&partial)
            .map_err(|error| format!("Cannot create update file: {error}"))?;
        let mut hasher = Sha256::new();
        let mut downloaded = 0u64;
        let mut buffer = [0u8; 64 * 1024];
        emit_progress(app, target, 0, total);
        loop {
            let read = response.read(&mut buffer).map_err(|error| format!("Update stream failed: {error}"))?;
            if read == 0 { break; }
            downloaded = downloaded.checked_add(read as u64).ok_or("Update download size overflow")?;
            if downloaded > MAX_UPDATE_BYTES || total.is_some_and(|length| downloaded > length) {
                return Err("Update download exceeded its declared size".into());
            }
            hasher.update(&buffer[..read]);
            file.write_all(&buffer[..read]).map_err(|error| format!("Update file write failed: {error}"))?;
            emit_progress(app, target, downloaded, total);
        }
        if downloaded == 0 || asset.size.is_some_and(|size| size != downloaded)
            || total.is_some_and(|size| size != downloaded) {
            return Err("Update download size does not match release metadata".into());
        }
        file.sync_all().map_err(|error| format!("Update file could not be flushed: {error}"))?;
        let digest = hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>();
        if digest != asset.digest { return Err("Downloaded update SHA-256 does not match the GitHub release digest".into()); }
        fs::rename(&partial, &destination).map_err(|error| format!("Verified update could not be staged: {error}"))?;
        emit_progress(app, target, downloaded, Some(downloaded));
        let token = random_hex(32);
        state().lock().map_err(|_| "Native updater state lock was poisoned")?
            .receipts.insert(token.clone(), Receipt { build_kind: key, path: destination.clone(), digest });
        Ok(json!({"ok":true,"token":token}))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&partial);
        let _ = fs::remove_file(&destination);
        let _ = fs::remove_dir(&download_dir);
    }
    result
}

fn consume_receipt(token: &str, kind: BuildKind) -> Result<Receipt, String> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
        return Err("Invalid update receipt".into());
    }
    let key = build_kind_name(kind);
    let receipt = state().lock().map_err(|_| "Native updater state lock was poisoned")?
        .receipts.get(token).cloned().ok_or("Update receipt is unavailable; download the update again")?;
    if receipt.build_kind != key { return Err("Update receipt is unavailable; download the update again".into()); }
    let root = update_root().canonicalize().map_err(|_| "Update staging directory is unavailable")?;
    let path = receipt.path.canonicalize().map_err(|_| "Downloaded update is unavailable")?;
    if !path.starts_with(&root) || path.file_name().and_then(|value| value.to_str()) != expected_asset_name(kind) {
        return Err("Invalid downloaded update path".into());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|_| "Downloaded update is unavailable")?;
    if !metadata.file_type().is_file() { return Err("Downloaded update is not a regular file".into()); }
    let mut file = File::open(&path).map_err(|_| "Downloaded update is unavailable")?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| "Downloaded update could not be verified")?;
        if read == 0 { break; }
        hasher.update(&buffer[..read]);
    }
    if hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect::<String>() != receipt.digest {
        return Err("Downloaded update changed after verification; download it again".into());
    }
    Ok(receipt)
}

fn mark_installing(token: &str, enabled: bool) -> Result<(), String> {
    let mut state = state().lock().map_err(|_| "Native updater state lock was poisoned")?;
    if enabled {
        if !state.installing.insert(token.to_owned()) { return Err("This update is already being installed".into()); }
    } else {
        state.installing.remove(token);
    }
    Ok(())
}

fn install(app: &AppHandle, token: &str, kind: BuildKind) -> Result<Value, String> {
    let receipt = consume_receipt(token, kind)?;
    mark_installing(token, true)?;
    let result = (|| {
        let broker = app.try_state::<std::sync::Arc<crate::Broker>>()
            .ok_or("Native update host state is unavailable")?;
        let host = std::env::current_exe().map_err(|error| error.to_string())?;
        let mut command;
        if kind == BuildKind::Installed {
            let install_dir = host.parent().filter(|path| path.is_absolute()).ok_or("Cannot locate installed Arc Power directory")?;
            command = Command::new(&receipt.path);
            command.arg("--update")
                .arg("--update-parent-pid").arg(std::process::id().to_string())
                .arg("--update-install-dir").arg(install_dir);
            command.current_dir(std::env::temp_dir());
        } else if kind == BuildKind::Portable {
            let target = std::env::var_os("PORTABLE_EXECUTABLE_FILE").map(PathBuf::from)
                .filter(|path| path.is_absolute()).ok_or("Portable wrapper path is unavailable")?;
            command = Command::new(host);
            command.arg("--portable-update").arg(std::process::id().to_string())
                .arg(&receipt.path).arg(&receipt.digest).arg(&target);
            command.current_dir(std::env::temp_dir());
        } else { return Err("Update target is unavailable for this build".into()); }
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x00000008 | 0x00000200); // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        }
        command.spawn().map_err(|error| format!("Could not start native update handoff: {error}"))?;
        state().lock().map_err(|_| "Native updater state lock was poisoned")?
            .receipts.remove(token);
        broker.allow_exit.store(true, std::sync::atomic::Ordering::SeqCst);
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(250));
            crate::exit_log_write("update-handoff", 0);
            app.exit(0);
        });
        Ok(wire::tagged(&wire::WireValue::Undefined))
    })();
    if result.is_err() { let _ = mark_installing(token, false); }
    result
}

pub fn handle(app: &AppHandle, target: &str, channel: &str, args_value: &Value, kind: BuildKind) -> Result<Value, String> {
    let args = args(args_value)?;
    match channel {
        "update:check" => {
            let intent = parse_check_intent(&args)?;
            coordinated_check(kind, intent).and_then(|value| wire::encode_json(&value))
        }
        "update:download" => {
            if args.len() != 1 { return Err("update:download expects one asset URL".into()); }
            let wire::WireValue::String(url) = &args[0] else { return Err("invalid asset URL".into()); };
            download(app, target, kind, url).and_then(|value| wire::encode_json(&value))
        }
        "update:install" => {
            if args.len() != 1 { return Err("update:install expects one update receipt".into()); }
            let wire::WireValue::String(token) = &args[0] else { return Err("missing update receipt".into()); };
            install(app, token, kind)
        }
        _ => Err("Native update service does not handle this channel".into()),
    }
}

