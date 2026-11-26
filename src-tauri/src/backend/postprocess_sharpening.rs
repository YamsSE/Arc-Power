//! Native screen post-processing (Arc Image Sharpening / Arc Super Resolution).
//!
//! Ports the screen-capture runtime contract from `src/main/sharpening-screen.js`:
//! one persisted preference document, one reversible helper process, the
//! foreground-window identity gate, synchronized Scale status pushes and the
//! global-settings revision events. Live capture remains opt-in: the helper is
//! only launched after an explicit Scale selection and it is never started by a
//! preference write.
//!
//! The helper executable is the existing Electron resource. Its transitional
//! path resolver keeps the same dev/packaged locations and SHA-256 pins as
//! `sharpening-screen.js`; a native resource root can replace the resolver later
//! without changing the protocol.
use super::game_candidate::canonical_exe_path;
use super::native_store::NativeStore;
use super::wire::{decode, WireValue};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, Weak};
use std::time::{Duration, Instant};

pub const SETTINGS_FILE: &str = "postprocess-sharpening.json";
pub const LEGACY_MANIFEST_FILE: &str = "reshade-managed-games.json";
pub const STATUS_CHANNEL: &str = "postprocess-sharpening:status";
pub const GLOBAL_SETTINGS_CHANNEL: &str = "postprocess-global-settings:updated";
pub const DEFAULT_SCALE_HOTKEY: &str = "Alt+F10";
pub const WINDOW_SELECT_SECONDS: u64 = 5;
pub const IDLE_SCALE_COMMAND: &str = "SCALE 0 0 0 0";
pub const SHARPENING_PAUSED_REASON: &str = "Arc Image Sharpening capture is unavailable on this system.";
pub const ASR_PAUSED_REASON: &str = "Arc Super Resolution capture is unavailable on this system.";
pub const TURN_ON_FIRST: &str = "Turn on Arc Image Sharpening or Arc Super Resolution before pressing Scale.";
pub const NO_GAME_SELECTED: &str = "No game window was selected. Focus a game first, then press Scale again.";
pub const HELPER_MISSING: &str = "The included screen sharpening helper is missing or damaged.";
pub const HELPER_NOT_READY: &str = "The window-processing helper is not ready.";
pub const HELPER_READY_TIMEOUT: &str = "Screen sharpening helper did not become ready.";

// Same pins as sharpening-screen.js.
const HELPER_SHA256: &str = "B3A0252FB839013AF2D4BC7C884A1D79E2A67405F3131E61CB1DD5D12038709C";
const FSR_ASSETS: [(&str, &str); 3] = [
    ("ArcPower.Fsr1.hlsl", "57E00E580F8AD852F1AAD9FC471842BB5586898CD1DD69058A9FB8AF7FB4EC07"),
    ("ffx_a.h", "F60E2722FCD13989523B9164D776AB382B3692791767F3BF8BB19967F763F3FB"),
    ("ffx_fsr1.h", "93C3922362EA7FC99CBCC698CA30C98DE4F8C246D1FBB0B09E015DDEF38CE3A5"),
];
const MAX_HELPER_LINE: usize = 64 * 1024;
const MAX_REASON_CHARS: usize = 1000;
const MAX_LEGACY_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_LEGACY_GAMES: usize = 256;

const SHARPENING_TYPE_ERROR: &str = "Sharpening must be { enabled: boolean, percentage: integer 0-100 }.";
const ASR_TYPE_ERROR: &str = "Arc Super Resolution must be { enabled: boolean }.";
const IPC_SHARPENING_ERROR: &str = "Sharpening requires an enabled flag and a whole percentage from 0 to 100.";
const IPC_ASR_ERROR: &str = "Arc Super Resolution requires an enabled flag.";
const INVALID_SETTINGS: &str = "Screen post-processing settings file is invalid.";
const INVALID_GAMES: &str = "Sharpening game overrides are invalid.";
const INVALID_GAME_IDENTITY: &str = "Sharpening game override identity is invalid.";
const INVALID_ASR_GAMES: &str = "ASR game overrides are invalid.";
const INVALID_ASR_GAME_IDENTITY: &str = "ASR game override identity is invalid.";
const LINKED_SETTINGS: &str = "Sharpening settings file is linked; refusing to trust it.";
const REPAIR_SUFFIX: &str = "Repair the settings file before changing screen post-processing.";

pub type EmitHook = Arc<dyn Fn(&str, Value) + Send + Sync>;
pub type ReloadHook = Arc<dyn Fn() -> Option<u64> + Send + Sync>;

#[derive(Clone, Debug, Default)]
pub struct IdentityGuard {
    pub host_pid: u32,
    pub broker_pid: Option<u32>,
    pub host_exe: Option<String>,
    pub broker_exe: Option<String>,
}

struct RuntimeHooks {
    emit: EmitHook,
    identity: IdentityGuard,
}

static HOOKS: OnceLock<RuntimeHooks> = OnceLock::new();
static RELOAD_HOOK: OnceLock<ReloadHook> = OnceLock::new();

#[derive(Clone, Debug)]
pub struct HostRegistrationSnapshot {
    pub started: bool,
    pub generation: u64,
    pub registered: Vec<String>,
    pub scale_desired: String,
    pub scale_reason: Option<String>,
    pub advanced_desired: Option<String>,
    pub advanced_registered: bool,
    pub advanced_reason: Option<String>,
}

impl Default for HostRegistrationSnapshot {
    fn default() -> Self {
        Self {
            started: false,
            generation: 0,
            registered: Vec::new(),
            scale_desired: DEFAULT_SCALE_HOTKEY.into(),
            scale_reason: None,
            advanced_desired: None,
            advanced_registered: false,
            advanced_reason: None,
        }
    }
}

impl HostRegistrationSnapshot {
    pub fn result_for(&self, accelerator: &str) -> HotkeyRegistrationResult {
        if self.registered.iter().any(|registered| registered == accelerator) {
            HotkeyRegistrationResult { registered: true, reason: None }
        } else {
            let reason = if self.scale_desired == accelerator {
                self.scale_reason.clone()
            } else { None };
            HotkeyRegistrationResult {
                registered: false,
                reason: reason.or_else(|| Some(format!("Could not register {accelerator}; another application may use it."))),
            }
        }
    }

    /// The Advanced Overlay's live `RegisterHotKey` result. A desired shortcut
    /// that was skipped because it collides with another Arc Power shortcut is
    /// never reported as registered even when the colliding accelerator is in
    /// the registered list.
    pub fn advanced_hotkey_registered(&self, accelerator: &str) -> bool {
        self.advanced_desired.as_deref() == Some(accelerator) && self.advanced_registered
    }
}

static HOST_REGISTRATION: OnceLock<Mutex<HostRegistrationSnapshot>> = OnceLock::new();

/// Replace the host shortcut registration snapshot. The native binary calls
/// this after each `RegisterHotKey` reconciliation on its hidden message window.
pub fn publish_host_registration(registered: Vec<String>, scale_desired: String, scale_reason: Option<String>,
    advanced_desired: Option<String>, advanced_registered: bool, advanced_reason: Option<String>) {
    let state = HOST_REGISTRATION.get_or_init(|| Mutex::new(HostRegistrationSnapshot::default()));
    if let Ok(mut state) = state.lock() {
        state.generation += 1;
        state.registered = registered;
        state.scale_desired = scale_desired;
        state.scale_reason = scale_reason;
        state.advanced_desired = advanced_desired;
        state.advanced_registered = advanced_registered;
        state.advanced_reason = advanced_reason;
    }
}

pub fn mark_host_registration_started() {
    let state = HOST_REGISTRATION.get_or_init(|| Mutex::new(HostRegistrationSnapshot::default()));
    if let Ok(mut state) = state.lock() { state.started = true; }
}

pub fn host_registration_snapshot() -> Option<HostRegistrationSnapshot> {
    let state = HOST_REGISTRATION.get_or_init(|| Mutex::new(HostRegistrationSnapshot::default()));
    let state = state.lock().ok()?;
    if !state.started { return None; }
    Some(state.clone())
}

/// The Advanced Overlay reports `hotkeyRegistered` only when the host's
/// current desired accelerator matches the requested one and `RegisterHotKey`
/// succeeded. A stale snapshot with a different desired value reads false.
pub fn advanced_hotkey_registered(accelerator: &str) -> bool {
    host_registration_snapshot().is_some_and(|snapshot| snapshot.advanced_hotkey_registered(accelerator))
}

/// Install the main-window-only event sink, the process identities the
/// foreground gate must exclude, and the host-shortcut reload trigger. Called
/// once by the native host at startup.
pub fn set_runtime_hooks(emit: EmitHook, identity: IdentityGuard, reload: ReloadHook) -> Result<(), String> {
    RELOAD_HOOK.set(reload).map_err(|_| "Screen post-processing reload hook is already set")?;
    HOOKS.set(RuntimeHooks { emit, identity })
        .map_err(|_| "Screen post-processing hooks are already set".into())
}

fn runtime_emit(channel: &str, payload: Value) {
    if let Some(hooks) = HOOKS.get() { (hooks.emit)(channel, payload); }
}

// ---------------------------------------------------------------------------
// Values and validation
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SharpeningValue {
    pub enabled: bool,
    pub percentage: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AsrValue {
    pub enabled: bool,
}

impl Default for SharpeningValue {
    fn default() -> Self { Self { enabled: false, percentage: 50 } }
}

impl Default for AsrValue {
    fn default() -> Self { Self { enabled: false } }
}

impl SharpeningValue {
    fn to_json(self) -> Value { json!({"enabled":self.enabled,"percentage":self.percentage}) }
}

impl AsrValue {
    fn to_json(self) -> Value { json!({"enabled":self.enabled}) }
}

/// Accept JSON numbers that JavaScript's `Number.isInteger` would accept
/// (serde_json preserves an explicit `50.0` as a float).
fn whole_percentage(value: &Value) -> Option<u32> {
    if let Some(number) = value.as_u64() { return u32::try_from(number).ok().filter(|number| *number <= 100); }
    let number = value.as_f64()?;
    if number.fract() == 0.0 && (0.0..=100.0).contains(&number) { Some(number as u32) } else { None }
}

/// IPC-level validation (ipc-core.js's `postprocessValue` message).
pub fn validate_ipc_sharpening(value: &Value) -> Result<SharpeningValue, String> {
    let Some(object) = value.as_object() else { return Err(IPC_SHARPENING_ERROR.into()); };
    if object.keys().any(|key| key != "enabled" && key != "percentage")
        || object.get("enabled").and_then(Value::as_bool).is_none() {
        return Err(IPC_SHARPENING_ERROR.into());
    }
    let Some(percentage) = object.get("percentage").and_then(whole_percentage) else { return Err(IPC_SHARPENING_ERROR.into()); };
    Ok(SharpeningValue { enabled: object["enabled"].as_bool().unwrap(), percentage })
}

/// IPC-level validation (ipc-core.js's `asrPostprocessValue` message).
pub fn validate_ipc_asr(value: &Value) -> Result<AsrValue, String> {
    let Some(object) = value.as_object() else { return Err(IPC_ASR_ERROR.into()); };
    if object.len() != 1 || object.keys().any(|key| key != "enabled")
        || object.get("enabled").and_then(Value::as_bool).is_none() {
        return Err(IPC_ASR_ERROR.into());
    }
    Ok(AsrValue { enabled: object["enabled"].as_bool().unwrap() })
}

/// Settings-file validation, matching `validateValue` in sharpening-screen.js.
fn validate_settings_value(value: &Value) -> Result<SharpeningValue, String> {
    let Some(object) = value.as_object() else { return Err(SHARPENING_TYPE_ERROR.into()); };
    if object.len() != 2 || object.keys().any(|key| key != "enabled" && key != "percentage") {
        return Err(SHARPENING_TYPE_ERROR.into());
    }
    let Some(enabled) = object.get("enabled").and_then(Value::as_bool) else { return Err(SHARPENING_TYPE_ERROR.into()); };
    let Some(percentage) = object.get("percentage").and_then(whole_percentage) else { return Err(SHARPENING_TYPE_ERROR.into()); };
    Ok(SharpeningValue { enabled, percentage })
}

fn validate_settings_asr(value: &Value) -> Result<AsrValue, String> {
    let Some(object) = value.as_object() else { return Err(ASR_TYPE_ERROR.into()); };
    if object.len() != 1 || !object.contains_key("enabled") { return Err(ASR_TYPE_ERROR.into()); }
    let Some(enabled) = object.get("enabled").and_then(Value::as_bool) else { return Err(ASR_TYPE_ERROR.into()); };
    Ok(AsrValue { enabled })
}

// ---------------------------------------------------------------------------
// Persisted settings
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default)]
struct Settings {
    global: SharpeningValue,
    games: BTreeMap<String, SharpeningValue>,
    asr: AsrValue,
    asr_games: BTreeMap<String, AsrValue>,
}

impl Settings {
    fn to_json(&self) -> Value {
        let games = self.games.iter().map(|(key, value)| (key.clone(), value.to_json()))
            .collect::<Map<_, _>>();
        let asr_games = self.asr_games.iter().map(|(key, value)| (key.clone(), value.to_json()))
            .collect::<Map<_, _>>();
        json!({
            "global": self.global.to_json(),
            "games": games,
            "asr": self.asr.to_json(),
            "asrGames": asr_games,
        })
    }
}

enum SettingsReadError {
    Io(std::io::Error),
    Invalid(String),
}

impl SettingsReadError {
    fn message(&self) -> String {
        match self {
            Self::Io(error) => error.to_string(),
            Self::Invalid(message) => message.clone(),
        }
    }
}

fn read_settings_file(file: &Path) -> Result<Settings, SettingsReadError> {
    let raw = match std::fs::symlink_metadata(file) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink()
                || file_link_count(file).map(|links| links != 1).unwrap_or(true) {
                return Err(SettingsReadError::Invalid(LINKED_SETTINGS.into()));
            }
            let text = std::fs::read_to_string(file).map_err(SettingsReadError::Io)?;
            serde_json::from_str::<Value>(&text)
                .map_err(|error| SettingsReadError::Invalid(error.to_string()))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Value::Object(Map::new()),
        Err(error) => return Err(SettingsReadError::Io(error)),
    };
    let Some(object) = raw.as_object() else { return Err(SettingsReadError::Invalid(INVALID_SETTINGS.into())); };
    if object.keys().any(|key| !matches!(key.as_str(), "global" | "games" | "asr" | "asrGames")) {
        return Err(SettingsReadError::Invalid(INVALID_SETTINGS.into()));
    }
    let global = match object.get("global") {
        None | Some(Value::Null) => SharpeningValue::default(),
        Some(value) => validate_settings_value(value).map_err(SettingsReadError::Invalid)?,
    };
    let asr = match object.get("asr") {
        None | Some(Value::Null) => AsrValue::default(),
        Some(value) => validate_settings_asr(value).map_err(SettingsReadError::Invalid)?,
    };
    let mut games = BTreeMap::new();
    if let Some(Value::Null) = object.get("games") {
    } else if let Some(value) = object.get("games") {
        let Some(map) = value.as_object() else { return Err(SettingsReadError::Invalid(INVALID_GAMES.into())); };
        for (key, value) in map {
            if canonical_exe_path(&Value::String(key.clone())).as_deref() != Some(key.as_str()) {
                return Err(SettingsReadError::Invalid(INVALID_GAME_IDENTITY.into()));
            }
            games.insert(key.clone(), validate_settings_value(value).map_err(SettingsReadError::Invalid)?);
        }
    }
    let mut asr_games = BTreeMap::new();
    if let Some(Value::Null) = object.get("asrGames") {
    } else if let Some(value) = object.get("asrGames") {
        let Some(map) = value.as_object() else { return Err(SettingsReadError::Invalid(INVALID_ASR_GAMES.into())); };
        for (key, value) in map {
            if canonical_exe_path(&Value::String(key.clone())).as_deref() != Some(key.as_str()) {
                return Err(SettingsReadError::Invalid(INVALID_ASR_GAME_IDENTITY.into()));
            }
            asr_games.insert(key.clone(), validate_settings_asr(value).map_err(SettingsReadError::Invalid)?);
        }
    }
    Ok(Settings { global, games, asr, asr_games })
}

fn atomic_json(file: &Path, value: &Value) -> Result<(), String> {
    let directory = file.parent().ok_or("Screen post-processing settings directory is unavailable")?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let temporary = file.with_file_name(format!(".{}.{}.{:016x}.tmp", file.file_name().and_then(|name| name.to_str()).unwrap_or(SETTINGS_FILE),
        std::process::id(), rand::random::<u64>()));
    let result = (|| -> Result<(), String> {
        let mut handle = std::fs::OpenOptions::new().write(true).create_new(true).open(&temporary)
            .map_err(|error| error.to_string())?;
        handle.write_all(serde_json::to_string_pretty(value).map_err(|error| error.to_string())?.as_bytes())
            .map_err(|error| error.to_string())?;
        handle.sync_all().map_err(|error| error.to_string())?;
        drop(handle);
        std::fs::rename(&temporary, file).map_err(|error| error.to_string())
    })();
    if result.is_err() { let _ = std::fs::remove_file(&temporary); }
    result
}

// ---------------------------------------------------------------------------
// Helper integrity / path resolution
// ---------------------------------------------------------------------------

fn file_sha256(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let digest = Sha256::digest(&bytes);
    Some(digest.iter().map(|byte| format!("{byte:02X}")).collect())
}

fn link_count_is_one(path: &Path) -> bool { file_link_count(path).map(|links| links == 1).unwrap_or(false) }

#[cfg(windows)]
fn file_link_count(path: &Path) -> Result<u32, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
        FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let handle = unsafe { CreateFileW(wide.as_ptr(), FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, std::ptr::null(),
        OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, std::ptr::null_mut()) };
    if handle == INVALID_HANDLE_VALUE { return Err("The file could not be opened for identity checks".into()); }
    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    let ok = unsafe { GetFileInformationByHandle(handle, &mut information) };
    unsafe { CloseHandle(handle); }
    if ok == 0 { return Err("The file identity could not be read".into()); }
    Ok(information.nNumberOfLinks)
}

#[cfg(not(windows))]
fn file_link_count(_path: &Path) -> Result<u32, String> { Ok(1) }

fn helper_integrity(path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else { return false; };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() || !link_count_is_one(path) {
        return false;
    }
    if file_sha256(path).as_deref() != Some(HELPER_SHA256) { return false; }
    let Some(directory) = path.parent() else { return false; };
    FSR_ASSETS.iter().all(|(name, expected)| {
        let asset = directory.join("fsr1").join(name);
        let Ok(metadata) = std::fs::symlink_metadata(&asset) else { return false; };
        metadata.file_type().is_file() && !metadata.file_type().is_symlink() && link_count_is_one(&asset)
            && file_sha256(&asset).as_deref() == Some(*expected)
    })
}

fn helper_candidates() -> Vec<PathBuf> {
    const TAIL: &str = "src/main/sharpening-runtime/ArcPower.ScreenSharpen.exe";
    let mut candidates = Vec::new();
    if cfg!(debug_assertions) {
        if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
            candidates.push(root.join(TAIL));
        }
    }
    if let Ok(host) = std::env::current_exe() {
        for ancestor in host.ancestors().skip(1).take(5) {
            candidates.push(ancestor.join("compatibility-backend/resources/app.asar.unpacked").join(TAIL));
            candidates.push(ancestor.join("resources/app.asar.unpacked").join(TAIL));
            candidates.push(ancestor.join("app.asar.unpacked").join(TAIL));
        }
    }
    if let Some(app) = std::env::var_os("ARC_POWER_BROKER_APP_PATH") {
        let app = PathBuf::from(app);
        if app.is_dir() {
            candidates.push(app.join(TAIL));
        }
        if let Some(sibling) = app.file_name().and_then(|name| name.to_str()).map(|name| name == "app.asar") {
            if sibling {
                if let Some(directory) = app.parent() {
                    candidates.push(directory.join("app.asar.unpacked").join(TAIL));
                }
            }
        }
    }
    candidates
}

fn resolve_helper_path() -> Option<PathBuf> {
    let candidates = helper_candidates();
    candidates.iter().find(|candidate| candidate.is_file()).cloned()
        .or_else(|| candidates.into_iter().next())
}

// ---------------------------------------------------------------------------
// Helper process seam
// ---------------------------------------------------------------------------

pub trait HelperProcess: Send + Sync {
    fn write(&self, line: &str) -> Result<(), String>;
    fn close_input(&self);
    fn try_wait(&self) -> Result<Option<i32>, String>;
    fn kill(&self);
}

pub struct SpawnedHelper {
    pub process: Arc<dyn HelperProcess>,
    pub stdout: Box<dyn BufRead + Send>,
    pub stderr: Box<dyn BufRead + Send>,
}

pub trait HelperSpawner: Send + Sync {
    fn spawn(&self, executable: &Path) -> Result<SpawnedHelper, String>;
}

struct RealHelperProcess {
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
}

impl HelperProcess for RealHelperProcess {
    fn write(&self, line: &str) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|_| "Helper input is unavailable")?;
        let Some(stdin) = stdin.as_mut() else { return Err("Helper input is closed".into()); };
        writeln!(stdin, "{line}").and_then(|_| stdin.flush()).map_err(|error| error.to_string())
    }
    fn close_input(&self) {
        if let Ok(mut stdin) = self.stdin.lock() { let _ = stdin.take(); }
    }
    fn try_wait(&self) -> Result<Option<i32>, String> {
        let mut child = self.child.lock().map_err(|_| "Helper process is unavailable")?;
        child.try_wait().map(|status| status.map(|status| status.code().unwrap_or(-1))).map_err(|error| error.to_string())
    }
    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() { let _ = child.kill(); }
    }
}

struct RealHelperSpawner;

impl HelperSpawner for RealHelperSpawner {
    fn spawn(&self, executable: &Path) -> Result<SpawnedHelper, String> {
        let mut command = Command::new(executable);
        command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().ok_or("Helper stdout is unavailable")?;
        let stderr = child.stderr.take().ok_or("Helper stderr is unavailable")?;
        Ok(SpawnedHelper {
            process: Arc::new(RealHelperProcess { stdin: Mutex::new(stdin), child: Mutex::new(child) }),
            stdout: Box::new(BufReader::new(stdout)),
            stderr: Box::new(BufReader::new(stderr)),
        })
    }
}

// ---------------------------------------------------------------------------
// Foreground identity
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForegroundIdentity {
    pub pid: u32,
    pub exe_path: String,
    pub creation_filetime: String,
    pub host_descendant: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScreenTarget {
    pub pid: u32,
    pub exe_path: String,
    pub creation_filetime: String,
    pub name: String,
}

/// Pure foreground gate. Mirrors the self/exe/FILETIME checks in
/// `selectForegroundTarget` and adds the native host/broker/WebView2 exclusions.
pub fn screen_target(identity: &ForegroundIdentity, guard: &IdentityGuard) -> Result<ScreenTarget, String> {
    let exe_path = canonical_exe_path(&Value::String(identity.exe_path.clone()));
    let valid_filetime = is_valid_creation_filetime(&identity.creation_filetime);
    if identity.pid < 1 || identity.pid == guard.host_pid || Some(identity.pid) == guard.broker_pid
        || exe_path.is_none() || !valid_filetime || identity.host_descendant {
        return Err(NO_GAME_SELECTED.into());
    }
    let exe_path = exe_path.unwrap();
    let excluded = [guard.host_exe.as_deref(), guard.broker_exe.as_deref()];
    if excluded.iter().flatten().any(|excluded| canonical_exe_path(&Value::String((*excluded).to_owned()))
        .is_some_and(|value| value == exe_path)) {
        return Err(NO_GAME_SELECTED.into());
    }
    let name = exe_path.rsplit('\\').next().unwrap_or(&exe_path).to_owned();
    if name.eq_ignore_ascii_case("msedgewebview2.exe") { return Err(NO_GAME_SELECTED.into()); }
    Ok(ScreenTarget { pid: identity.pid, exe_path, creation_filetime: identity.creation_filetime.clone(), name })
}

fn is_valid_creation_filetime(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('0') && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

#[cfg(windows)]
fn is_host_descendant(pid: u32, ancestors: &[u32]) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
    };
    if pid == 0 || ancestors.is_empty() { return false; }
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE { return false; }
    let mut parents: HashMap<u32, u32> = HashMap::new();
    let mut entry = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
    let mut ok = unsafe { Process32FirstW(snapshot, &mut entry) };
    while ok != 0 {
        parents.insert(entry.th32ProcessID, entry.th32ParentProcessID);
        ok = unsafe { Process32NextW(snapshot, &mut entry) };
    }
    unsafe { CloseHandle(snapshot); }
    let mut current = pid;
    for _ in 0..64 {
        let Some(parent) = parents.get(&current).copied() else { return false; };
        if ancestors.contains(&parent) { return true; }
        if parent == 0 || parent == current { return false; }
        current = parent;
    }
    false
}

#[cfg(not(windows))]
fn is_host_descendant(_pid: u32, _ancestors: &[u32]) -> bool { false }

#[cfg(windows)]
fn detect_foreground_identity(guard: &IdentityGuard) -> Result<ForegroundIdentity, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME};
    use windows_sys::Win32::System::Threading::{
        GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    let window = unsafe { GetForegroundWindow() };
    if window.is_null() { return Err("No foreground window is available".into()); }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(window, &mut pid); }
    if pid == 0 { return Err("The foreground window has no process identity".into()); }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if process.is_null() { return Err("The foreground process could not be opened".into()); }
    let mut buffer = vec![0u16; 32768];
    let mut length = buffer.len() as u32;
    let query = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
    if query == 0 {
        unsafe { CloseHandle(process); }
        return Err("The foreground process image could not be read".into());
    }
    let mut creation = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut exit = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut kernel = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let mut user = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
    let times = unsafe { GetProcessTimes(process, &mut creation, &mut exit, &mut kernel, &mut user) };
    unsafe { CloseHandle(process); }
    if times == 0 { return Err("The foreground process creation time could not be read".into()); }
    let filetime = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
    let mut ancestors = vec![guard.host_pid];
    if let Some(broker) = guard.broker_pid { ancestors.push(broker); }
    Ok(ForegroundIdentity {
        pid,
        exe_path: String::from_utf16_lossy(&buffer[..length as usize]),
        creation_filetime: filetime.to_string(),
        host_descendant: is_host_descendant(pid, &ancestors),
    })
}

#[cfg(not(windows))]
fn detect_foreground_identity(_guard: &IdentityGuard) -> Result<ForegroundIdentity, String> {
    Err("Foreground process identity is unavailable on this platform".into())
}

pub trait ForegroundSource: Send + Sync {
    fn detect(&self) -> Result<ForegroundIdentity, String>;
}

struct Win32Foreground { guard: IdentityGuard }

impl ForegroundSource for Win32Foreground {
    fn detect(&self) -> Result<ForegroundIdentity, String> { detect_foreground_identity(&self.guard) }
}

// ---------------------------------------------------------------------------
// Hotkey grammar (ipc-core.js:validateOverlayHotkeyLetter)
// ---------------------------------------------------------------------------

pub fn validate_overlay_hotkey_letter(value: &str) -> Result<String, String> {
    const MESSAGE: &str = "overlayHotkeyLetter must be a modifier chord such as Control+O or Alt+F9, or a single function key such as F9";
    if value == "None" { return Ok("None".into()); }
    let source = if value.len() == 1 && value.bytes().next().is_some_and(|byte| byte.is_ascii_alphanumeric()) {
        format!("Control+{value}")
    } else { value.to_owned() };
    let mut pieces: Vec<&str> = source.split('+').collect();
    let Some(key) = pieces.pop() else { return Err(MESSAGE.into()); };
    let key_upper = key.to_ascii_uppercase();
    let valid_key = if key.len() == 1 {
        key.bytes().next().is_some_and(|byte| byte.is_ascii_alphanumeric())
    } else {
        let mut chars = key_upper.chars();
        if chars.next() != Some('F') { false } else {
            let digits: String = chars.collect();
            !digits.is_empty() && !digits.starts_with('0')
                && digits.parse::<u32>().is_ok_and(|number| (1..=24).contains(&number))
        }
    };
    // A single function key (F1-F24) is a complete hotkey; a letter or number
    // still needs a modifier chord (a bare single character was auto-prefixed).
    if !valid_key || (pieces.is_empty() && key.len() == 1) { return Err(MESSAGE.into()); }
    let mut modifiers = Vec::new();
    for piece in pieces {
        let lower = piece.to_ascii_lowercase();
        if !matches!(lower.as_str(), "control" | "ctrl" | "alt" | "shift") { return Err(MESSAGE.into()); }
        modifiers.push(lower);
    }
    let mut unique = HashSet::new();
    if !modifiers.iter().all(|modifier| unique.insert(modifier.clone())) { return Err(MESSAGE.into()); }
    let has_control = modifiers.iter().any(|modifier| modifier == "control" || modifier == "ctrl");
    let mut canonical = Vec::new();
    if has_control { canonical.push("Control".to_owned()); }
    if modifiers.iter().any(|modifier| modifier == "alt") { canonical.push("Alt".to_owned()); }
    if modifiers.iter().any(|modifier| modifier == "shift") { canonical.push("Shift".to_owned()); }
    canonical.push(key_upper);
    Ok(canonical.join("+"))
}

pub fn validate_postprocess_scale_hotkey(value: Option<&str>) -> Result<String, String> {
    let Some(value) = value else {
        return Err("overlayHotkeyLetter must be a modifier and a letter, number, or function key".into());
    };
    let accelerator = validate_overlay_hotkey_letter(value)?;
    // 'None' is the explicit off state: the host shell unregisters it.
    if accelerator == "None" { return Ok(accelerator); }
    // A single function key is a complete hotkey; a bare letter or number still
    // needs Ctrl, Alt, or Shift.
    let is_function_key = accelerator.len() > 1 && accelerator.starts_with('F');
    if !value.contains('+') && !is_function_key {
        return Err("postprocessScaleHotkey must include Ctrl, Alt, or Shift, or be a single F1-F24 key".into());
    }
    Ok(accelerator)
}

pub fn overlay_hotkeys_collide(left: &str, right: &str) -> bool {
    match (validate_overlay_hotkey_letter(left), validate_overlay_hotkey_letter(right)) {
        (Ok(left), Ok(right)) => left != "None" && right != "None" && left == right,
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Hotkey registration seam
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HotkeyRegistrationResult {
    pub registered: bool,
    pub reason: Option<String>,
}

pub trait HotkeyRegistration: Send + Sync {
    /// Current host state. `None` means the host shortcut registrar is not running.
    fn current(&self, accelerator: &str) -> Option<HotkeyRegistrationResult>;
    /// Persist-triggered refresh; returns the post-refresh state when the host
    /// shortcut registrar is available.
    fn reload(&self, accelerator: &str, timeout: Duration) -> Option<HotkeyRegistrationResult>;
}

/// Ask the hidden host window to reconcile registrations and wait, bounded,
/// for the next published generation. Settings-save reactions use this so an
/// immediate `advanced-overlay:get-state` sees the new hotkey result instead of
/// the two-second timer's stale snapshot.
pub fn reload_host_registration(timeout: Duration) -> Option<HostRegistrationSnapshot> {
    let hook = RELOAD_HOOK.get()?;
    let before = hook()?;
    let deadline = Instant::now() + timeout;
    let mut latest = host_registration_snapshot()?;
    while latest.generation <= before && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
        latest = host_registration_snapshot()?;
    }
    Some(latest)
}

struct HostShellRegistration;

impl HotkeyRegistration for HostShellRegistration {
    fn current(&self, accelerator: &str) -> Option<HotkeyRegistrationResult> {
        Some(host_registration_snapshot()?.result_for(accelerator))
    }
    fn reload(&self, accelerator: &str, timeout: Duration) -> Option<HotkeyRegistrationResult> {
        Some(reload_host_registration(timeout)?.result_for(accelerator))
    }
}

// ---------------------------------------------------------------------------
// Legacy ReShade manifest audit (legacy-sharpening-audit.js)
// ---------------------------------------------------------------------------

fn legacy_manifest(dir: &Path) -> Value {
    let manifest_path = dir.join(LEGACY_MANIFEST_FILE);
    let path_text = manifest_path.to_string_lossy().into_owned();
    let unreadable = |reason: String| json!({
        "status": "unreadable", "manifestPath": path_text, "games": [], "reason": reason,
    });
    let metadata = match std::fs::symlink_metadata(&manifest_path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return json!({"status": "clear", "manifestPath": path_text, "games": []});
        }
        Err(error) => return unreadable(error.to_string()),
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink()
        || !link_count_is_one(&manifest_path) || metadata.len() > MAX_LEGACY_MANIFEST_BYTES {
        return unreadable("The previous sharpening manifest is linked, oversized, or not a regular file.".into());
    }
    let records = match std::fs::read_to_string(&manifest_path)
        .ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()) {
        Some(Value::Object(records)) => records,
        _ => return unreadable("The previous sharpening manifest has an unsupported shape.".into()),
    };
    if records.len() > MAX_LEGACY_GAMES {
        return unreadable("The previous sharpening manifest has an unsupported shape.".into());
    }
    let mut games = Vec::new();
    for (key, entry) in &records {
        let Some(entry) = entry.as_object() else {
            return unreadable("The previous sharpening manifest contains an invalid ownership record.".into());
        };
        let Some(exe_path) = entry.get("exePath").and_then(Value::as_str) else {
            return unreadable("The previous sharpening manifest contains an invalid ownership record.".into());
        };
        let Some(mode) = entry.get("mode").and_then(Value::as_str) else {
            return unreadable("The previous sharpening manifest contains an invalid ownership record.".into());
        };
        let Some(owned) = entry.get("ownedFiles").and_then(Value::as_object) else {
            return unreadable("The previous sharpening manifest contains an invalid ownership record.".into());
        };
        if canonical_exe_path(&Value::String(exe_path.to_owned())).as_deref() != Some(key.as_str())
            || exe_path.to_lowercase() != key.as_str() || !matches!(mode, "direct" | "optiscaler") {
            return unreadable("The previous sharpening manifest contains an invalid ownership record.".into());
        }
        let Some(game_dir) = Path::new(exe_path).parent() else {
            return unreadable("The previous sharpening manifest contains an invalid ownership record.".into());
        };
        let runtime_name = if mode == "direct" { "dxgi.dll" } else { "ReShade64.dll" };
        let mut expected = [
            game_dir.join(runtime_name),
            game_dir.join("ReShade.ini"),
            game_dir.join("ArcPowerSharpening").join("ArcPowerSharpen.fx"),
            game_dir.join("ArcPowerSharpening").join("preset.ini"),
        ].iter().map(|path| path.to_string_lossy().replace('/', "\\").to_lowercase()).collect::<Vec<_>>();
        expected.sort();
        let mut actual = Vec::new();
        let invalid_owned = owned.iter().any(|(file, hash)| {
            if !Path::new(file).is_absolute() || hash.as_str().is_none_or(|hash| {
                hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            }) { return true; }
            actual.push(file.replace('/', "\\").to_lowercase());
            false
        });
        actual.sort();
        if owned.len() != expected.len() || invalid_owned || actual != expected {
            return unreadable("The previous sharpening manifest contains invalid owned-file records.".into());
        }
        games.push(json!({"exePath": exe_path, "mode": mode}));
    }
    games.sort_by(|left, right| left["exePath"].as_str().unwrap_or("").cmp(right["exePath"].as_str().unwrap_or("")));
    let status = if games.is_empty() { "clear" } else { "found" };
    json!({"status": status, "manifestPath": path_text, "games": games})
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq)]
enum PreviewMode { Scale, Asr, Sharpening }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase { Idle, Countdown, Selected }

#[derive(Clone, Debug)]
struct Selection {
    phase: Phase,
    seconds_remaining: u64,
    target_name: Option<String>,
    target: Option<ScreenTarget>,
    upscale: bool,
    sharpness: u32,
}

impl Selection {
    fn idle() -> Self {
        Self { phase: Phase::Idle, seconds_remaining: 0, target_name: None, target: None, upscale: false, sharpness: 0 }
    }
    fn countdown(seconds_remaining: u64) -> Self {
        Self { phase: Phase::Countdown, seconds_remaining, ..Self::idle() }
    }
    fn json(&self) -> Value {
        json!({
            "phase": match self.phase { Phase::Idle => "idle", Phase::Countdown => "countdown", Phase::Selected => "selected" },
            "secondsRemaining": self.seconds_remaining,
            "targetName": self.target_name,
        })
    }
}

struct HelperSignal {
    ready: bool,
    exited: Option<i32>,
    stop_requested: bool,
}

struct HelperShared {
    signal: Mutex<HelperSignal>,
    cv: Condvar,
}

#[derive(Clone)]
struct HelperHandle {
    id: u64,
    process: Arc<dyn HelperProcess>,
    shared: Arc<HelperShared>,
}

struct State {
    settings: Settings,
    settings_error: Option<String>,
    reason: Option<String>,
    running: bool,
    ready: bool,
    overlay_active: bool,
    overlay_mode: Option<PreviewMode>,
    selection: Selection,
    helper_generation: u64,
    selection_generation: u64,
    last_command: Option<String>,
    helper: Option<HelperHandle>,
    starting: bool,
    published_status: Option<String>,
}

pub struct RuntimeOptions {
    pub dir: PathBuf,
    pub helper_path: Option<PathBuf>,
    pub allow_capture_overlay: bool,
    pub allow_asr_capture: bool,
    pub ready_timeout: Duration,
    pub kill_timeout: Duration,
    pub countdown_tick: Duration,
    pub hotkey_registration_timeout: Duration,
    pub identity: IdentityGuard,
}

impl RuntimeOptions {
    pub fn production(dir: &Path) -> Self {
        let identity = HOOKS.get().map(|hooks| hooks.identity.clone()).unwrap_or_else(|| IdentityGuard {
            host_pid: std::process::id(),
            broker_pid: None,
            host_exe: std::env::current_exe().ok().map(|path| path.to_string_lossy().into_owned()),
            broker_exe: None,
        });
        Self {
            dir: dir.to_path_buf(),
            helper_path: resolve_helper_path(),
            allow_capture_overlay: true,
            allow_asr_capture: true,
            ready_timeout: Duration::from_secs(5),
            kill_timeout: Duration::from_secs(2),
            countdown_tick: Duration::from_secs(1),
            hotkey_registration_timeout: Duration::from_millis(2500),
            identity,
        }
    }
}

pub struct Seams {
    pub spawner: Arc<dyn HelperSpawner>,
    pub foreground: Arc<dyn ForegroundSource>,
    pub registration: Arc<dyn HotkeyRegistration>,
    pub integrity: Arc<dyn Fn(&Path) -> bool + Send + Sync>,
    pub emit: Option<EmitHook>,
}

impl Seams {
    fn production(options: &RuntimeOptions) -> Self {
        Self {
            spawner: Arc::new(RealHelperSpawner),
            foreground: Arc::new(Win32Foreground { guard: options.identity.clone() }),
            registration: Arc::new(HostShellRegistration),
            integrity: Arc::new(helper_integrity),
            emit: None,
        }
    }
}

pub struct SharpeningRuntime {
    options: RuntimeOptions,
    seams: Seams,
    state: Mutex<State>,
    countdown_cv: Condvar,
    startup_cv: Condvar,
    sharpening_revision: AtomicU64,
    asr_revision: AtomicU64,
    next_helper_id: AtomicU64,
}

impl SharpeningRuntime {
    pub fn new(options: RuntimeOptions, seams: Seams) -> Arc<Self> {
        let (settings, settings_error) = match read_settings_file(&options.dir.join(SETTINGS_FILE)) {
            Ok(settings) => (settings, None),
            Err(error) => (Settings::default(), Some(error.message())),
        };
        let reason = settings_error.as_ref().map(|error| format!("Sharpening settings could not be loaded and were preserved: {error}"))
            .or_else(|| if !options.allow_capture_overlay && !options.allow_asr_capture {
                Some(SHARPENING_PAUSED_REASON.to_owned())
            } else { None });
        Arc::new(Self {
            options,
            seams,
            state: Mutex::new(State {
                settings,
                settings_error,
                reason,
                running: true,
                ready: false,
                overlay_active: false,
                overlay_mode: None,
                selection: Selection::idle(),
                helper_generation: 0,
                selection_generation: 0,
                last_command: None,
                helper: None,
                starting: false,
                published_status: None,
            }),
            countdown_cv: Condvar::new(),
            startup_cv: Condvar::new(),
            sharpening_revision: AtomicU64::new(0),
            asr_revision: AtomicU64::new(0),
            next_helper_id: AtomicU64::new(1),
        })
    }

    pub fn production(dir: &Path) -> Result<Arc<Self>, String> {
        if !dir.is_absolute() { return Err("An absolute AppData directory is required.".into()); }
        let options = RuntimeOptions::production(dir);
        let seams = Seams::production(&options);
        Ok(Self::new(options, seams))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn emit(&self, channel: &str, payload: Value) {
        if let Some(emit) = &self.seams.emit { emit(channel, payload); return; }
        runtime_emit(channel, payload);
    }

    fn runtime_configured(&self, state: &State) -> bool {
        self.sharpening_enabled(state) || self.options.allow_asr_capture && state.settings.asr.enabled
    }

    fn runtime_enabled(&self, state: &State) -> bool {
        self.runtime_configured(state) && state.selection.phase == Phase::Selected && state.selection.target.is_some()
    }

    fn sharpening_enabled(&self, state: &State) -> bool {
        self.options.allow_capture_overlay && state.settings.global.enabled
    }

    fn asr_enabled(&self, state: &State) -> bool {
        self.options.allow_asr_capture && state.settings.asr.enabled
    }

    fn effective_sharpening(&self, state: &State) -> (bool, u32) {
        let enabled = self.options.allow_capture_overlay && state.settings.global.enabled
            && state.settings.global.percentage > 0;
        (enabled, if enabled { state.settings.global.percentage } else { 0 })
    }

    fn selected_capture_active(state: &State) -> bool {
        state.ready && state.overlay_active && state.overlay_mode == Some(PreviewMode::Scale)
    }

    fn runtime_status(&self, state: &State) -> Value {
        let selected = Self::selected_capture_active(state);
        let asr_active = selected && state.selection.upscale;
        let sharpening_active = selected && state.selection.sharpness > 0;
        let mut payload = Map::new();
        payload.insert("active".into(), json!(asr_active || sharpening_active));
        payload.insert("reason".into(), state.reason.clone().map(Value::String).unwrap_or(Value::Null));
        if selected {
            payload.insert("sharpeningActive".into(), json!(sharpening_active));
            payload.insert("asrActive".into(), json!(asr_active));
            payload.insert("sharpeningReason".into(), state.reason.clone().map(Value::String).unwrap_or(Value::Null));
            payload.insert("asrReason".into(), state.reason.clone().map(Value::String).unwrap_or(Value::Null));
        }
        let mode = if selected { Some("scale") }
            else if asr_active { Some("asr") }
            else if sharpening_active { Some("sharpening") }
            else { None };
        if let Some(mode) = mode { payload.insert("mode".into(), json!(mode)); }
        payload.insert("selection".into(), state.selection.json());
        Value::Object(payload)
    }

    fn publish_status(&self) {
        let payload = {
            let mut state = self.lock();
            let payload = self.runtime_status(&state);
            let signature = serde_json::to_string(&payload).unwrap_or_default();
            if state.published_status.as_deref() == Some(signature.as_str()) { return; }
            state.published_status = Some(signature);
            payload
        };
        self.emit(STATUS_CHANNEL, payload);
    }

    fn write_command(&self, command: &str) {
        let handle = {
            let mut state = self.lock();
            if !state.ready { return; }
            let Some(handle) = state.helper.clone() else { return; };
            if state.last_command.as_deref() == Some(command) { return; }
            state.last_command = Some(command.to_owned());
            if command == IDLE_SCALE_COMMAND && state.overlay_active {
                state.overlay_active = false;
                state.overlay_mode = None;
            }
            handle
        };
        if let Err(error) = handle.process.write(command) {
            let mut state = self.lock();
            state.reason = Some(format!("Sharpening helper command failed: {error}"));
            state.ready = false;
            drop(state);
        }
        self.publish_status();
    }

    fn write_idle_if_ready(&self) {
        let ready = self.lock().ready;
        if ready { self.write_command(IDLE_SCALE_COMMAND); }
    }

    fn apply_selected_window(&self) {
        let (target, ready) = {
            let state = self.lock();
            let target = if state.selection.phase == Phase::Selected { state.selection.target.clone() } else { None };
            (target, state.ready && state.helper.is_some())
        };
        let Some(target) = target else {
            if ready { self.write_command(IDLE_SCALE_COMMAND); }
            return;
        };
        if !ready { return; }
        let (sharpening_enabled, percentage) = { let state = self.lock(); self.effective_sharpening(&state) };
        let upscale = { let state = self.lock(); self.asr_enabled(&state) };
        let sharpness = if sharpening_enabled { percentage } else { 0 };
        {
            let mut state = self.lock();
            state.selection.upscale = upscale;
            state.selection.sharpness = sharpness;
        }
        if !upscale && sharpness == 0 {
            self.write_command(IDLE_SCALE_COMMAND);
        } else {
            self.write_command(&format!("SCALE {} {} {} {}", target.pid, target.creation_filetime, u8::from(upscale), sharpness));
        }
        self.publish_status();
    }

    fn schedule_poll(&self) {
        let enabled = {
            let state = self.lock();
            state.running && self.runtime_enabled(&state) && state.helper.is_some() && state.ready
        };
        if enabled { self.apply_selected_window(); }
    }

    fn start_helper(self: &Arc<Self>) -> bool {
        let deadline = Instant::now() + self.options.ready_timeout + Duration::from_secs(1);
        enum Action { Wait(HelperHandle), WaitStarting, Unavailable, Launch(u64) }
        let token = loop {
            let action = {
                let mut state = self.lock();
                if !state.running { return false; }
                if let Some(handle) = state.helper.clone() {
                    Action::Wait(handle)
                } else if state.starting {
                    Action::WaitStarting
                } else if !self.runtime_enabled(&state) {
                    state.reason = if self.asr_enabled(&state) { None } else { Some(SHARPENING_PAUSED_REASON.to_owned()) };
                    Action::Unavailable
                } else {
                    state.starting = true;
                    Action::Launch(state.helper_generation)
                }
            };
            match action {
                Action::Wait(handle) => return self.wait_for_ready(&handle, deadline),
                Action::WaitStarting => {
                    if Instant::now() >= deadline { return false; }
                    let state = self.lock();
                    let _ = self.startup_cv.wait_timeout(state, Duration::from_millis(50))
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
                Action::Unavailable => {
                    self.publish_status();
                    return false;
                }
                Action::Launch(token) => break token,
            }
        };
        let result = self.launch_helper(token);
        {
            let mut state = self.lock();
            state.starting = false;
            drop(state);
            self.startup_cv.notify_all();
        }
        result
    }

    fn wait_for_ready(&self, handle: &HelperHandle, deadline: Instant) -> bool {
        let mut signal = handle.shared.signal.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        while !signal.ready && signal.exited.is_none() && !signal.stop_requested {
            let now = Instant::now();
            if now >= deadline { break; }
            let (next, _) = handle.shared.cv.wait_timeout(signal, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            signal = next;
        }
        let ready = signal.ready && signal.exited.is_none() && !signal.stop_requested;
        drop(signal);
        if ready {
            let mut state = self.lock();
            if state.helper.as_ref().map(|current| current.id) != Some(handle.id) || !self.runtime_enabled(&state) {
                drop(state);
                return false;
            }
            state.ready = true;
            drop(state);
            self.publish_status();
            self.schedule_poll();
            true
        } else if handle.shared.signal.lock().map(|signal| signal.exited.is_some()).unwrap_or(false) {
            false
        } else {
            let mut state = self.lock();
            if state.helper.as_ref().map(|current| current.id) == Some(handle.id) {
                state.reason = Some(HELPER_READY_TIMEOUT.into());
                state.helper_generation += 1;
                drop(state);
                self.publish_status();
                self.stop_helper();
            }
            false
        }
    }

    fn launch_helper(self: &Arc<Self>, token: u64) -> bool {
        {
            let state = self.lock();
            if !state.running || state.helper_generation != token || !self.runtime_enabled(&state) {
                let reason = if self.asr_enabled(&state) { None } else { Some(SHARPENING_PAUSED_REASON.to_owned()) };
                drop(state);
                if self.lock().helper_generation == token { self.lock().reason = reason; }
                return false;
            }
        }
        let Some(path) = self.options.helper_path.clone() else {
            self.set_reason_and_publish(HELPER_MISSING);
            return false;
        };
        if !(self.seams.integrity)(&path) {
            self.set_reason_and_publish(HELPER_MISSING);
            return false;
        }
        self.set_reason_and_publish_clear();
        let spawned = match self.seams.spawner.spawn(&path) {
            Ok(spawned) => spawned,
            Err(error) => {
                self.set_reason_and_publish(&format!("Unable to start screen sharpening helper: {error}"));
                return false;
            }
        };
        let id = self.next_helper_id.fetch_add(1, Ordering::SeqCst);
        let shared = Arc::new(HelperShared {
            signal: Mutex::new(HelperSignal { ready: false, exited: None, stop_requested: false }),
            cv: Condvar::new(),
        });
        let handle = HelperHandle { id, process: spawned.process.clone(), shared: shared.clone() };
        {
            let mut state = self.lock();
            if !state.running || state.helper_generation != token || !self.runtime_enabled(&state) {
                drop(state);
                let _ = spawned.process.write("STOP");
                spawned.process.close_input();
                return false;
            }
            state.helper = Some(handle.clone());
            state.ready = false;
            state.overlay_active = false;
            state.overlay_mode = None;
            state.last_command = None;
        }
        self.spawn_reader(id, spawned.stdout, false);
        self.spawn_reader(id, spawned.stderr, true);
        self.spawn_waiter(id, handle.clone());
        let deadline = Instant::now() + self.options.ready_timeout;
        self.wait_for_ready(&handle, deadline)
    }

    fn set_reason_and_publish(&self, reason: &str) {
        self.lock().reason = Some(reason.to_owned());
        self.publish_status();
    }

    fn set_reason_and_publish_clear(&self) {
        self.lock().reason = None;
        self.publish_status();
    }

    fn spawn_reader(self: &Arc<Self>, id: u64, reader: Box<dyn BufRead + Send>, stderr: bool) {
        let weak = Arc::downgrade(self);
        std::thread::Builder::new().name(format!("arc-sharpen-{}", if stderr { "err" } else { "out" })).spawn(move || {
            let mut reader = reader;
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if line.len() > MAX_HELPER_LINE { line.truncate(MAX_HELPER_LINE); }
                        let Some(runtime) = weak.upgrade() else { break; };
                        if stderr { runtime.handle_stderr(id, line.trim()); }
                        else { runtime.handle_stdout(id, line.trim()); }
                    }
                }
            }
        }).ok();
    }

    fn current_helper(&self, id: u64) -> bool {
        self.lock().helper.as_ref().map(|handle| handle.id) == Some(id)
    }

    fn handle_stdout(self: &Arc<Self>, id: u64, message: &str) {
        if message.is_empty() || !self.current_helper(id) { return; }
        if message.starts_with("READY") && message.as_bytes().get(5).is_none_or(u8::is_ascii_whitespace) {
            if let Some(handle) = self.lock().helper.clone().filter(|handle| handle.id == id) {
                if let Ok(mut signal) = handle.shared.signal.lock() { signal.ready = true; }
                handle.shared.cv.notify_all();
            }
            let enabled = { let state = self.lock(); self.runtime_enabled(&state) };
            if !enabled { self.stop_helper(); return; }
            {
                let mut state = self.lock();
                if state.helper.as_ref().map(|handle| handle.id) != Some(id) { return; }
                state.ready = true;
            }
            self.publish_status();
            self.schedule_poll();
        } else if message.starts_with("ACTIVE ") {
            let Some(rest) = message.strip_prefix("ACTIVE ") else { return; };
            let tokens: Vec<&str> = rest.split_whitespace().collect();
            let valid = !tokens.is_empty() && tokens[0].bytes().all(|byte| byte.is_ascii_digit())
                && (tokens.len() == 1 || tokens.len() == 2 && matches!(tokens[1], "ASR" | "SCALE"));
            if !valid { return; }
            let mode = match tokens.get(1) { Some(&"SCALE") => PreviewMode::Scale, Some(&"ASR") => PreviewMode::Asr, _ => PreviewMode::Sharpening };
            {
                let mut state = self.lock();
                if state.helper.as_ref().map(|handle| handle.id) != Some(id) { return; }
                state.overlay_active = true;
                state.overlay_mode = Some(mode);
                state.reason = None;
            }
            self.publish_status();
        } else if message == "IDLE" {
            {
                let mut state = self.lock();
                if state.helper.as_ref().map(|handle| handle.id) != Some(id) { return; }
                state.overlay_active = false;
                state.overlay_mode = None;
            }
            self.publish_status();
        }
    }

    fn handle_stderr(self: &Arc<Self>, id: u64, message: &str) {
        if message.is_empty() || !self.current_helper(id) { return; }
        let mut reason: String = message.chars().take(MAX_REASON_CHARS).collect();
        if reason.is_empty() { return; }
        self.lock().reason = Some(std::mem::take(&mut reason));
        self.publish_status();
        let mut words = message.split_whitespace();
        if words.next().is_some_and(|word| word.eq_ignore_ascii_case("ERROR"))
            && words.next().is_some_and(|word| word.eq_ignore_ascii_case("fatal")) {
            self.lock().helper_generation += 1;
            self.stop_helper();
        }
    }

    fn spawn_waiter(self: &Arc<Self>, id: u64, handle: HelperHandle) {
        let weak = Arc::downgrade(self);
        std::thread::Builder::new().name("arc-sharpen-wait".into()).spawn(move || {
            let mut stop_since: Option<Instant> = None;
            let mut killed = false;
            loop {
                match handle.process.try_wait() {
                    Ok(Some(code)) => {
                        if let Some(runtime) = weak.upgrade() { runtime.handle_helper_exit(id, code); }
                        if let Ok(mut signal) = handle.shared.signal.lock() {
                            signal.exited = Some(code);
                            handle.shared.cv.notify_all();
                        }
                        return;
                    }
                    Ok(None) => {}
                    Err(_) => return,
                }
                let stopping = handle.shared.signal.lock().map(|signal| signal.stop_requested).unwrap_or(true);
                if stopping {
                    let since = *stop_since.get_or_insert_with(Instant::now);
                    if !killed && since.elapsed() >= handle_kill_timeout(&weak) {
                        handle.process.kill();
                        killed = true;
                    }
                    if killed && since.elapsed() >= handle_kill_timeout(&weak) + Duration::from_millis(500) {
                        return;
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }).ok();
    }

    fn handle_helper_exit(self: &Arc<Self>, id: u64, code: i32) {
        let mut state = self.lock();
        if state.helper.as_ref().map(|handle| handle.id) != Some(id) { return; }
        state.helper_generation += 1;
        state.helper = None;
        state.ready = false;
        state.overlay_active = false;
        state.overlay_mode = None;
        state.reason = Some(format!("Screen sharpening helper exited ({code}). Toggle sharpening off and on to retry."));
        drop(state);
        self.publish_status();
    }

    fn stop_helper(&self) {
        let handle = {
            let mut state = self.lock();
            let handle = state.helper.take();
            state.ready = false;
            state.overlay_active = false;
            state.overlay_mode = None;
            state.last_command = None;
            handle
        };
        self.publish_status();
        let Some(handle) = handle else { return; };
        if let Ok(mut signal) = handle.shared.signal.lock() {
            signal.stop_requested = true;
            handle.shared.cv.notify_all();
        }
        let _ = handle.process.write(IDLE_SCALE_COMMAND);
        let _ = handle.process.write("STOP");
        handle.process.close_input();
    }

    fn cancel_window_selection(&self) {
        {
            let mut state = self.lock();
            state.selection_generation += 1;
            state.selection = Selection::idle();
        }
        self.countdown_cv.notify_all();
        self.write_idle_if_ready();
        self.stop_helper();
        self.publish_status();
    }

    fn wait_countdown(&self, token: u64) -> bool {
        let mut state = self.lock();
        let deadline = Instant::now() + self.options.countdown_tick;
        while state.selection_generation == token {
            let now = Instant::now();
            if now >= deadline { return true; }
            let (next, _) = self.countdown_cv.wait_timeout(state, deadline - now)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state = next;
        }
        false
    }

    fn select_foreground_target(self: &Arc<Self>, token: u64) -> Result<Value, String> {
        let configured = { let state = self.lock(); self.runtime_configured(&state) };
        if !configured { return Err(TURN_ON_FIRST.into()); }
        if self.lock().selection_generation != token { return Ok(self.canceled_result()); }
        {
            let mut state = self.lock();
            state.selection = Selection::countdown(0);
        }
        self.publish_status();
        let identity = self.seams.foreground.detect()
            .map_err(|error| format!("Could not identify the foreground game window: {error}"))?;
        if self.lock().selection_generation != token { return Ok(self.canceled_result()); }
        let target = screen_target(&identity, &self.options.identity)?;
        {
            let mut state = self.lock();
            state.selection = Selection {
                phase: Phase::Selected,
                seconds_remaining: 0,
                target_name: Some(target.name.clone()),
                target: Some(target),
                upscale: false,
                sharpness: 0,
            };
        }
        let helper_ready = self.start_helper();
        if self.lock().selection_generation != token { return Ok(self.canceled_result()); }
        if !helper_ready || !self.lock().ready {
            let reason = self.lock().reason.clone();
            return Err(reason.unwrap_or_else(|| HELPER_NOT_READY.into()));
        }
        self.schedule_poll();
        self.publish_status();
        Ok(self.selected_result())
    }

    fn canceled_result(&self) -> Value {
        json!({"canceled": true, "selection": self.lock().selection.json()})
    }

    fn selected_result(&self) -> Value {
        json!({
            "canceled": false,
            "selection": self.lock().selection.json(),
            "sharpening": self.global_state(),
            "asr": self.asr_state(),
        })
    }

    pub fn select_window(self: &Arc<Self>) -> Result<Value, String> {
        if !self.runtime_configured(&self.lock()) { return Err(TURN_ON_FIRST.into()); }
        let token = {
            let mut state = self.lock();
            state.selection_generation += 1;
            state.selection = Selection::countdown(WINDOW_SELECT_SECONDS);
            state.selection_generation
        };
        self.write_idle_if_ready();
        self.stop_helper();
        self.publish_status();
        for remaining in (1..=WINDOW_SELECT_SECONDS).rev() {
            if self.lock().selection_generation != token { return Ok(self.canceled_result()); }
            self.lock().selection.seconds_remaining = remaining;
            self.publish_status();
            if !self.wait_countdown(token) { return Ok(self.canceled_result()); }
        }
        {
            let mut state = self.lock();
            if state.selection_generation != token { return Ok(self.canceled_result()); }
            state.selection.seconds_remaining = 0;
        }
        self.publish_status();
        match self.select_foreground_target(token) {
            Ok(result) => Ok(result),
            Err(error) => {
                if self.lock().selection_generation == token { self.cancel_window_selection(); }
                Err(error)
            }
        }
    }

    pub fn select_foreground_window(self: &Arc<Self>) -> Result<Value, String> {
        let token = {
            let mut state = self.lock();
            state.selection_generation += 1;
            state.selection_generation
        };
        match self.select_foreground_target(token) {
            Ok(result) => Ok(result),
            Err(error) => {
                if self.lock().selection_generation == token { self.cancel_window_selection(); }
                Err(error)
            }
        }
    }

    pub fn toggle_scale_from_hotkey(self: &Arc<Self>) -> Result<Value, String> {
        let selected = self.lock().selection.phase == Phase::Selected;
        if selected {
            self.cancel_window_selection();
            return Ok(json!({"stopped": true, "selection": self.lock().selection.json()}));
        }
        self.select_foreground_window()
    }

    pub fn stop_window(&self) -> Value {
        self.cancel_window_selection();
        json!({"selection": self.lock().selection.json(), "sharpening": self.global_state(), "asr": self.asr_state()})
    }

    fn refresh_selected_runtime(self: &Arc<Self>) {
        let (configured, enabled, started) = {
            let state = self.lock();
            (self.runtime_configured(&state), self.runtime_enabled(&state), state.running)
        };
        if !configured {
            self.cancel_window_selection();
            return;
        }
        if !enabled {
            let stop = { let state = self.lock(); state.helper.is_some() || state.starting };
            if stop { self.stop_helper(); }
            self.publish_status();
            return;
        }
        if started {
            let has_helper = self.lock().helper.is_some();
            if !has_helper { self.start_helper(); }
            else { self.schedule_poll(); }
        }
    }

    fn persist(&self, next: Settings) -> Result<(), String> {
        let mut state = self.lock();
        if let Some(error) = &state.settings_error {
            let reason = format!("Sharpening settings could not be loaded and were preserved: {error}");
            return Err(format!("{reason}. {REPAIR_SUFFIX}"));
        }
        atomic_json(&self.options.dir.join(SETTINGS_FILE), &next.to_json())?;
        state.settings = next;
        Ok(())
    }

    pub fn set_global(self: &Arc<Self>, value: SharpeningValue) -> Result<Value, String> {
        if !self.options.allow_capture_overlay && value.enabled { return Err(SHARPENING_PAUSED_REASON.into()); }
        let next = { let state = self.lock(); Settings { global: value, ..state.settings.clone() } };
        self.persist(next)?;
        self.refresh_selected_runtime();
        let state = self.global_state();
        let revision = self.sharpening_revision.fetch_add(1, Ordering::SeqCst) + 1;
        self.emit(GLOBAL_SETTINGS_CHANNEL, json!({"kind":"sharpening","revision":revision,"state":state}));
        Ok(state)
    }

    pub fn set_asr(self: &Arc<Self>, value: AsrValue) -> Result<Value, String> {
        if !self.options.allow_asr_capture && value.enabled { return Err(ASR_PAUSED_REASON.into()); }
        let next = { let state = self.lock(); Settings { asr: value, ..state.settings.clone() } };
        self.persist(next)?;
        self.refresh_selected_runtime();
        let state = self.asr_state();
        let revision = self.asr_revision.fetch_add(1, Ordering::SeqCst) + 1;
        self.emit(GLOBAL_SETTINGS_CHANNEL, json!({"kind":"asr","revision":revision,"state":state}));
        Ok(state)
    }

    pub fn global_state(&self) -> Value {
        let (value, override_count, active, selection, reason) = {
            let state = self.lock();
            (state.settings.global, state.settings.games.len(), Self::selected_capture_active(&state) && state.selection.sharpness > 0,
                state.selection.json(), state.reason.clone())
        };
        let legacy = legacy_manifest(&self.options.dir);
        let sharpening_reason = reason.or_else(|| if !self.options.allow_capture_overlay {
            Some(SHARPENING_PAUSED_REASON.to_owned())
        } else { None });
        let mut payload = Map::new();
        payload.insert("value".into(), value.to_json());
        payload.insert("overrideCount".into(), json!(override_count));
        payload.insert("runtimeReady".into(), json!(self.helper_available()));
        payload.insert("provider".into(), json!("screen"));
        payload.insert("requiresRestart".into(), json!(false));
        payload.insert("active".into(), json!(active));
        payload.insert("selection".into(), selection);
        payload.insert("legacyIntegrations".into(), legacy["games"].clone());
        payload.insert("legacyManifestPath".into(), legacy["manifestPath"].clone());
        payload.insert("legacyManifestStatus".into(), legacy["status"].clone());
        if let Some(reason) = legacy.get("reason") { payload.insert("legacyManifestReason".into(), reason.clone()); }
        if let Some(reason) = sharpening_reason { payload.insert("reason".into(), json!(reason)); }
        Value::Object(payload)
    }

    pub fn asr_state(&self) -> Value {
        let (value, active, selection, reason) = {
            let state = self.lock();
            (state.settings.asr, Self::selected_capture_active(&state) && state.selection.upscale,
                state.selection.json(), state.reason.clone())
        };
        let mut payload = Map::new();
        payload.insert("value".into(), value.to_json());
        payload.insert("runtimeReady".into(), json!(self.options.allow_asr_capture && self.helper_integrity_ok()));
        payload.insert("requiresRestart".into(), json!(false));
        payload.insert("active".into(), json!(active));
        payload.insert("selection".into(), selection);
        if !self.options.allow_asr_capture {
            payload.insert("reason".into(), json!(ASR_PAUSED_REASON));
        } else if let Some(reason) = reason {
            payload.insert("reason".into(), json!(reason));
        }
        Value::Object(payload)
    }

    fn helper_integrity_ok(&self) -> bool {
        self.options.helper_path.as_deref().is_some_and(|path| (self.seams.integrity)(path))
    }

    fn helper_available(&self) -> bool {
        self.options.allow_capture_overlay && self.helper_integrity_ok()
    }

    pub fn hotkey_get(&self, store: &NativeStore) -> Result<Value, String> {
        let settings = super::services::native_json(store, "load-settings", json!([]))?;
        let accelerator = settings.get("postprocessScaleHotkey").and_then(Value::as_str)
            .unwrap_or(DEFAULT_SCALE_HOTKEY).to_owned();
        let registration = self.seams.registration.current(&accelerator)
            .unwrap_or(HotkeyRegistrationResult { registered: false,
                reason: Some("Global shortcut registration is unavailable.".into()) });
        let reason = if registration.registered { None } else {
            Some(registration.reason.unwrap_or_else(|| {
                format!("Could not register {accelerator}; another application may use it.")
            }))
        };
        Ok(json!({"accelerator": accelerator, "registered": registration.registered, "reason": reason}))
    }

    pub fn hotkey_set(self: &Arc<Self>, store: &NativeStore, value: Option<&str>) -> Result<Value, String> {
        let accelerator = validate_postprocess_scale_hotkey(value)?;
        let mut settings = super::services::native_json(store, "load-settings", json!([]))?;
        let hud = settings.get("overlayHotkeyLetter").and_then(Value::as_str).unwrap_or("O");
        let advanced = settings.get("advancedOverlayHotkeyLetter").and_then(Value::as_str).unwrap_or("P");
        if overlay_hotkeys_collide(&accelerator, hud) || overlay_hotkeys_collide(&accelerator, advanced) {
            return Err("Scale hotkey must differ from both overlay hotkeys.".into());
        }
        let Some(object) = settings.as_object_mut() else { return Err("Settings are invalid".into()); };
        object.insert("postprocessScaleHotkey".into(), json!(accelerator));
        super::services::native_json(store, "save-settings", json!([settings]))?;
        if accelerator == "None" {
            let _ = self.seams.registration.reload(&accelerator, self.options.hotkey_registration_timeout);
            return Ok(json!({"accelerator":"None","registered":false}));
        }
        if let Some(result) = self.seams.registration.reload(&accelerator, self.options.hotkey_registration_timeout) {
            if result.registered { Ok(json!({"accelerator": accelerator, "registered": true})) }
            else {
                let reason = result.reason.unwrap_or_else(|| {
                    format!("Could not register {accelerator}; another application may use it.")
                });
                Ok(json!({"accelerator": accelerator, "registered": false, "reason": reason}))
            }
        } else {
            Ok(json!({"accelerator": accelerator, "registered": false,
                "reason": "Global shortcut registration is unavailable."}))
        }
    }

    /// Stop the helper without ending the runtime; used before a maintenance
    /// restart where the process may survive.
    pub fn quiesce(&self) {
        self.cancel_window_selection();
    }

    pub fn shutdown(&self) {
        {
            let mut state = self.lock();
            state.running = false;
            state.starting = false;
        }
        self.cancel_window_selection();
    }
}

fn handle_kill_timeout(weak: &Weak<SharpeningRuntime>) -> Duration {
    weak.upgrade().map(|runtime| runtime.options.kill_timeout).unwrap_or(Duration::from_secs(2))
}

// ---------------------------------------------------------------------------
// Shared runtime
// ---------------------------------------------------------------------------

static SHARED: OnceLock<Mutex<HashMap<PathBuf, Arc<SharpeningRuntime>>>> = OnceLock::new();

pub fn shared(root: &Path) -> Result<Arc<SharpeningRuntime>, String> {
    let mut runtimes = SHARED.get_or_init(|| Mutex::new(HashMap::new()))
        .lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(runtime) = runtimes.get(root) { return Ok(runtime.clone()); }
    let runtime = SharpeningRuntime::production(root)?;
    runtimes.insert(root.to_path_buf(), runtime.clone());
    Ok(runtime)
}

pub fn shutdown_shared() {
    if let Some(runtimes) = SHARED.get() {
        for runtime in runtimes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).values() {
            runtime.shutdown();
        }
    }
}

pub fn quiesce_shared() {
    if let Some(runtimes) = SHARED.get() {
        for runtime in runtimes.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).values() {
            runtime.quiesce();
        }
    }
}

/// The native host forwards its `postprocess-scale` shortcut here instead of
/// handing it back to Electron.
pub fn toggle_scale_from_hotkey_shared(root: &Path) {
    let Ok(runtime) = shared(root) else { return; };
    std::thread::spawn(move || {
        if let Err(error) = runtime.toggle_scale_from_hotkey() {
            eprintln!("[postprocess] Scale shortcut failed: {error}");
        }
    });
}

pub fn is_channel(channel: &str) -> bool {
    matches!(channel,
        "postprocess-sharpening:get" | "postprocess-sharpening:set"
        | "postprocess-sharpening:select-window" | "postprocess-sharpening:stop-window"
        | "postprocess-sharpening:hotkey-get" | "postprocess-sharpening:hotkey-set"
        | "arc-super-resolution:get" | "arc-super-resolution:set")
}

// ---------------------------------------------------------------------------
// Channel dispatch
// ---------------------------------------------------------------------------

fn decoded_args(args: &Value) -> Result<Vec<WireValue>, String> {
    match decode(args)? {
        WireValue::Array(items) => Ok(items),
        _ => Err("Expected argument array".into()),
    }
}

fn no_payload(channel: &str, args: &Value) -> Result<(), String> {
    if !decoded_args(args)?.is_empty() { return Err(format!("{channel} takes no payload")); }
    Ok(())
}

fn one_or_missing(channel: &str, args: &Value) -> Result<Value, String> {
    let mut items = decoded_args(args)?;
    if items.len() > 1 { return Err(format!("{channel} takes no payload")); }
    match items.pop() {
        None | Some(WireValue::Undefined) | Some(WireValue::Null) => Ok(Value::Null),
        Some(value) => Ok(value.into_json().unwrap_or(Value::Null)),
    }
}

pub fn invoke(channel: &str, args: &Value, store: &NativeStore) -> Result<Value, String> {
    let runtime = shared(store.root())?;
    match channel {
        "postprocess-sharpening:get" => {
            no_payload(channel, args)?;
            Ok(runtime.global_state())
        }
        "postprocess-sharpening:set" => {
            let payload = one_or_missing(channel, args)?;
            let value = validate_ipc_sharpening(&payload)?;
            runtime.set_global(value)
        }
        "postprocess-sharpening:select-window" => {
            no_payload(channel, args)?;
            runtime.select_window()
        }
        "postprocess-sharpening:stop-window" => {
            no_payload(channel, args)?;
            Ok(runtime.stop_window())
        }
        "postprocess-sharpening:hotkey-get" => {
            no_payload(channel, args)?;
            runtime.hotkey_get(store)
        }
        "postprocess-sharpening:hotkey-set" => {
            let payload = one_or_missing(channel, args)?;
            let value = payload.as_str().map(str::to_owned);
            runtime.hotkey_set(store, value.as_deref())
        }
        "arc-super-resolution:get" => {
            no_payload(channel, args)?;
            Ok(runtime.asr_state())
        }
        "arc-super-resolution:set" => {
            let payload = one_or_missing(channel, args)?;
            let value = validate_ipc_asr(&payload)?;
            runtime.set_asr(value)
        }
        _ => Err("Unknown screen post-processing channel".into()),
    }
}

/// Test-only helper: the module's own fixtures construct runtimes directly.
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;
    use std::collections::VecDeque;
    use std::io::{BufRead, Cursor};
    use std::sync::atomic::{AtomicBool, AtomicUsize};

    const GAME_KEY: &str = "c:\\games\\palworld\\pal\\binaries\\win64\\palworld-win64-shipping.exe";
    const GAME_EXE: &str = "C:\\Games\\Palworld\\Pal\\Binaries\\Win64\\Palworld-Win64-Shipping.exe";
    const CREATION: &str = "132537600000000000";

    fn guard() -> IdentityGuard {
        IdentityGuard {
            host_pid: 100,
            broker_pid: Some(200),
            host_exe: Some("C:\\ArcPower\\arc-power-tauri.exe".into()),
            broker_exe: Some("C:\\ArcPower\\electron.exe".into()),
        }
    }

    fn game_identity() -> ForegroundIdentity {
        ForegroundIdentity {
            pid: 4242,
            exe_path: GAME_EXE.into(),
            creation_filetime: CREATION.into(),
            host_descendant: false,
        }
    }

    struct DelayedReader {
        cursor: Cursor<Vec<u8>>,
        delay: Duration,
        slept: bool,
    }

    impl DelayedReader {
        fn new(bytes: Vec<u8>, delay: Duration) -> Self {
            Self { cursor: Cursor::new(bytes), delay, slept: false }
        }
        fn sleep_once(&mut self) {
            if !self.slept { self.slept = true; std::thread::sleep(self.delay); }
        }
    }

    impl std::io::Read for DelayedReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.sleep_once();
            self.cursor.read(buffer)
        }
    }

    impl BufRead for DelayedReader {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            self.sleep_once();
            self.cursor.fill_buf()
        }
        fn consume(&mut self, amount: usize) { self.cursor.consume(amount); }
    }

    struct FakeProcessState {
        commands: Mutex<Vec<String>>,
        running: AtomicBool,
        killed: AtomicBool,
        exit_on_stop: bool,
        exit_on_close: bool,
    }

    struct FakeProcess { state: Arc<FakeProcessState> }

    impl HelperProcess for FakeProcess {
        fn write(&self, line: &str) -> Result<(), String> {
            self.state.commands.lock().unwrap().push(line.to_owned());
            if line == "STOP" && self.state.exit_on_stop { self.state.running.store(false, Ordering::SeqCst); }
            Ok(())
        }
        fn close_input(&self) {
            if self.state.exit_on_close { self.state.running.store(false, Ordering::SeqCst); }
        }
        fn try_wait(&self) -> Result<Option<i32>, String> {
            Ok(if self.state.running.load(Ordering::SeqCst) { None } else { Some(0) })
        }
        fn kill(&self) {
            self.state.killed.store(true, Ordering::SeqCst);
            self.state.running.store(false, Ordering::SeqCst);
        }
    }

    struct FakePlan {
        stdout: String,
        stderr: String,
        exit_on_stop: bool,
        exit_on_close: bool,
    }

    impl FakePlan {
        fn ready() -> Self {
            Self { stdout: "READY screen-sharpen-v1\n".into(), stderr: String::new(), exit_on_stop: true, exit_on_close: true }
        }
        fn ready_active() -> Self {
            Self { stdout: "READY screen-sharpen-v1\nACTIVE 4242 SCALE\n".into(), stderr: String::new(), exit_on_stop: true, exit_on_close: true }
        }
    }

    struct FakeSpawner {
        plans: Mutex<VecDeque<FakePlan>>,
        children: Mutex<Vec<Arc<FakeProcessState>>>,
        spawns: AtomicUsize,
    }

    impl FakeSpawner {
        fn new(plans: Vec<FakePlan>) -> Self {
            Self { plans: Mutex::new(plans.into()), children: Mutex::new(Vec::new()), spawns: AtomicUsize::new(0) }
        }
        fn first(&self) -> Arc<FakeProcessState> { self.children.lock().unwrap()[0].clone() }
        fn commands(&self) -> Vec<String> { self.first().commands.lock().unwrap().clone() }
    }

    impl HelperSpawner for FakeSpawner {
        fn spawn(&self, _executable: &Path) -> Result<SpawnedHelper, String> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            let plan = self.plans.lock().unwrap().pop_front().unwrap_or_else(FakePlan::ready);
            let state = Arc::new(FakeProcessState {
                commands: Mutex::new(Vec::new()),
                running: AtomicBool::new(true),
                killed: AtomicBool::new(false),
                exit_on_stop: plan.exit_on_stop,
                exit_on_close: plan.exit_on_close,
            });
            self.children.lock().unwrap().push(state.clone());
            Ok(SpawnedHelper {
                process: Arc::new(FakeProcess { state }),
                stdout: Box::new(Cursor::new(plan.stdout.into_bytes())),
                stderr: Box::new(DelayedReader::new(plan.stderr.into_bytes(), Duration::from_millis(120))),
            })
        }
    }

    struct FakeForeground { identity: Mutex<Result<ForegroundIdentity, String>> }    impl FakeForeground {
        fn new() -> Self { Self { identity: Mutex::new(Ok(game_identity())) } }
        fn set(&self, identity: Result<ForegroundIdentity, String>) { *self.identity.lock().unwrap() = identity; }
    }

    impl ForegroundSource for FakeForeground {
        fn detect(&self) -> Result<ForegroundIdentity, String> { self.identity.lock().unwrap().clone() }
    }

    struct FakeRegistration {
        registered: Mutex<bool>,
        reason: Mutex<Option<String>>,
        reloads: Mutex<Vec<String>>,
    }

    impl FakeRegistration {
        fn new(registered: bool) -> Self {
            Self { registered: Mutex::new(registered), reason: Mutex::new(None), reloads: Mutex::new(Vec::new()) }
        }
        fn set(&self, registered: bool, reason: Option<&str>) {
            *self.registered.lock().unwrap() = registered;
            *self.reason.lock().unwrap() = reason.map(str::to_owned);
        }
    }

    impl HotkeyRegistration for FakeRegistration {
        fn current(&self, _accelerator: &str) -> Option<HotkeyRegistrationResult> {
            Some(HotkeyRegistrationResult {
                registered: *self.registered.lock().unwrap(),
                reason: self.reason.lock().unwrap().clone(),
            })
        }
        fn reload(&self, accelerator: &str, _timeout: Duration) -> Option<HotkeyRegistrationResult> {
            self.reloads.lock().unwrap().push(accelerator.to_owned());
            Some(HotkeyRegistrationResult {
                registered: *self.registered.lock().unwrap(),
                reason: self.reason.lock().unwrap().clone(),
            })
        }
    }

    struct Fixture {
        dir: PathBuf,
        runtime: Arc<SharpeningRuntime>,
        store: NativeStore,
        events: Arc<Mutex<Vec<(String, Value)>>>,
        spawner: Arc<FakeSpawner>,
        foreground: Arc<FakeForeground>,
        registration: Arc<FakeRegistration>,
    }

    impl Fixture {
        fn new() -> Self { Self::custom(None, vec![FakePlan::ready_active()], 25, 60, true) }
        fn custom(saved: Option<Value>, plans: Vec<FakePlan>, countdown_ms: u64, kill_ms: u64, integrity: bool) -> Self {
            let dir = std::env::temp_dir().join(format!("arc-postprocess-test-{:032x}", rand::random::<u128>()));
            std::fs::create_dir_all(&dir).unwrap();
            if let Some(saved) = &saved {
                std::fs::write(dir.join(SETTINGS_FILE), serde_json::to_string(saved).unwrap()).unwrap();
            }
            let events = Arc::new(Mutex::new(Vec::new()));
            let spawner = Arc::new(FakeSpawner::new(plans));
            let foreground = Arc::new(FakeForeground::new());
            let registration = Arc::new(FakeRegistration::new(true));
            let emit_events = events.clone();
            let seams = Seams {
                spawner: spawner.clone(),
                foreground: foreground.clone(),
                registration: registration.clone(),
                integrity: Arc::new(move |_path: &Path| integrity),
                emit: Some(Arc::new(move |channel: &str, payload: Value| {
                    emit_events.lock().unwrap().push((channel.to_owned(), payload));
                })),
            };
            let options = RuntimeOptions {
                dir: dir.clone(),
                helper_path: Some(dir.join("ArcPower.ScreenSharpen.exe")),
                allow_capture_overlay: true,
                allow_asr_capture: true,
                ready_timeout: Duration::from_millis(250),
                kill_timeout: Duration::from_millis(kill_ms),
                countdown_tick: Duration::from_millis(countdown_ms),
                hotkey_registration_timeout: Duration::from_millis(100),
                identity: guard(),
            };
            let runtime = SharpeningRuntime::new(options, seams);
            let store = NativeStore::new(dir.clone(), "advanced").unwrap();
            Self { dir, runtime, store, events, spawner, foreground, registration }
        }
        fn events(&self, channel: &str) -> Vec<Value> {
            self.events.lock().unwrap().iter().filter(|(name, _)| name == channel)
                .map(|(_, payload)| payload.clone()).collect()
        }
        fn saved(&self) -> Value {
            serde_json::from_str(&std::fs::read_to_string(self.dir.join(SETTINGS_FILE)).unwrap()).unwrap()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
    }

    fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if predicate() { return true; }
            std::thread::sleep(Duration::from_millis(5));
        }
        predicate()
    }

    fn games_saved() -> Value {
        let mut games = Map::new();
        games.insert(GAME_KEY.into(), json!({"enabled": false, "percentage": 12}));
        let mut asr_games = Map::new();
        asr_games.insert(GAME_KEY.into(), json!({"enabled": true}));
        json!({
            "global": {"enabled": true, "percentage": 83},
            "games": games,
            "asr": {"enabled": true},
            "asrGames": asr_games,
        })
    }

    #[test]
    fn settings_are_validated_preserved_and_unknown_keys_refuse_writes() {
        let fixture = Fixture::custom(Some(games_saved()), vec![FakePlan::ready()], 25, 60, true);
        let global = fixture.runtime.global_state();
        assert_eq!(global["value"], json!({"enabled": true, "percentage": 83}));
        assert_eq!(global["overrideCount"], 1);
        assert_eq!(global["provider"], "screen");
        assert_eq!(global["requiresRestart"], false);
        assert_eq!(global["runtimeReady"], true);
        assert_eq!(global["legacyManifestStatus"], "clear");
        assert_eq!(global["legacyIntegrations"], json!([]));
        assert!(global.get("reason").is_none());

        let updated = fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 91 }).unwrap();
        assert_eq!(updated["value"], json!({"enabled": true, "percentage": 91}));
        let saved = fixture.saved();
        assert_eq!(saved["global"], json!({"enabled": true, "percentage": 91}));
        assert_eq!(saved["games"][GAME_KEY], json!({"enabled": false, "percentage": 12}));
        assert_eq!(saved["asr"], json!({"enabled": true}));
        assert_eq!(saved["asrGames"][GAME_KEY], json!({"enabled": true}));

        let invalid = Value::Object({
            let mut object = Map::new();
            object.insert("global".into(), json!({"enabled": true, "percentage": 83}));
            object.insert("future".into(), json!(1));
            object
        });
        let broken = Fixture::custom(Some(invalid.clone()), vec![], 25, 60, true);
        let state = broken.runtime.global_state();
        let reason = state["reason"].as_str().unwrap();
        assert!(reason.contains("settings could not be loaded"), "{reason}");
        assert_eq!(state["value"], json!({"enabled": false, "percentage": 50}));
        let error = broken.runtime.set_global(SharpeningValue { enabled: true, percentage: 40 }).unwrap_err();
        assert!(error.contains("Repair the settings file before changing screen post-processing."), "{error}");
        let untouched: Value = serde_json::from_str(&std::fs::read_to_string(broken.dir.join(SETTINGS_FILE)).unwrap()).unwrap();
        assert_eq!(untouched, invalid);

        let bad_percentage = Fixture::custom(Some(json!({"global": {"enabled": true, "percentage": 101}})), vec![], 25, 60, true);
        assert!(bad_percentage.runtime.global_state()["reason"].as_str().unwrap().contains("settings could not be loaded"));
    }

    #[test]
    fn ipc_values_match_the_electron_messages() {
        assert_eq!(validate_ipc_sharpening(&json!(null)).unwrap_err(), IPC_SHARPENING_ERROR);
        for value in [json!({}), json!([]), json!({"enabled": 1, "percentage": 50}),
            json!({"enabled": true, "percentage": 0.5}), json!({"enabled": true, "percentage": 101}),
            json!({"enabled": true, "percentage": -1}), json!({"enabled": true, "percentage": 50, "path": "game.exe"})] {
            assert_eq!(validate_ipc_sharpening(&value).unwrap_err(), IPC_SHARPENING_ERROR, "{value}");
        }
        assert_eq!(validate_ipc_sharpening(&json!({"enabled": true, "percentage": 50.0})).unwrap(),
            SharpeningValue { enabled: true, percentage: 50 });
        assert_eq!(validate_ipc_asr(&json!({"enabled": true})).unwrap(), AsrValue { enabled: true });
        for value in [json!(null), json!({}), json!({"enabled": 1}), json!({"enabled": true, "method": "xess"})] {
            assert_eq!(validate_ipc_asr(&value).unwrap_err(), IPC_ASR_ERROR);
        }
        assert_eq!(no_payload("postprocess-sharpening:get", &json!({"t":"array","v":[]})).unwrap(), ());
        assert_eq!(no_payload("postprocess-sharpening:get", &json!({"t":"array","v":[{"t":"null"}]})).unwrap_err(),
            "postprocess-sharpening:get takes no payload");
        assert_eq!(one_or_missing("postprocess-sharpening:set", &json!({"t":"array","v":[]})).unwrap(), Value::Null);
        assert_eq!(one_or_missing("postprocess-sharpening:set", &json!({"t":"array","v":[]})).unwrap(), Value::Null);
        assert_eq!(one_or_missing("postprocess-sharpening:set", &json!({"t":"array","v":[{"t":"null"},{"t":"null"}]})).unwrap_err(),
            "postprocess-sharpening:set takes no payload");
    }

    #[test]
    fn foreground_gate_rejects_self_broker_webview2_and_bad_filetimes() {
        let policy = guard();
        let accepted = screen_target(&game_identity(), &policy).unwrap();
        assert_eq!(accepted.pid, 4242);
        assert_eq!(accepted.exe_path, GAME_KEY);
        assert_eq!(accepted.name, "palworld-win64-shipping.exe");
        assert_eq!(accepted.creation_filetime, CREATION);

        let rejected = [
            ForegroundIdentity { pid: 100, ..game_identity() },
            ForegroundIdentity { pid: 200, ..game_identity() },
            ForegroundIdentity { pid: 0, ..game_identity() },
            ForegroundIdentity { exe_path: "C:\\ArcPower\\arc-power-tauri.exe".into(), ..game_identity() },
            ForegroundIdentity { exe_path: "C:\\ArcPower\\electron.exe".into(), ..game_identity() },
            ForegroundIdentity { exe_path: "C:\\ArcPower\\msedgewebview2.exe".into(), ..game_identity() },
            ForegroundIdentity { host_descendant: true, ..game_identity() },
            ForegroundIdentity { exe_path: "C:\\Games\\Palworld\\pal.dll".into(), ..game_identity() },
            ForegroundIdentity { creation_filetime: "0".into(), ..game_identity() },
            ForegroundIdentity { creation_filetime: "01".into(), ..game_identity() },
            ForegroundIdentity { creation_filetime: "abc".into(), ..game_identity() },
            ForegroundIdentity { creation_filetime: "18446744073709551616".into(), ..game_identity() },
        ];
        for identity in rejected {
            assert_eq!(screen_target(&identity, &policy).unwrap_err(), NO_GAME_SELECTED, "{identity:?}");
        }
    }

    #[test]
    fn select_window_starts_the_helper_and_sends_the_scale_command() {
        let fixture = Fixture::new();
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 75 }).unwrap();
        let result = fixture.runtime.select_foreground_window().unwrap();
        assert_eq!(result["canceled"], json!(false));
        assert_eq!(result["selection"]["phase"], json!("selected"));
        assert_eq!(result["selection"]["targetName"], json!("palworld-win64-shipping.exe"));
        assert_eq!(result["sharpening"]["value"], json!({"enabled": true, "percentage": 75}));
        assert_eq!(result["asr"]["value"], json!({"enabled": false}));
        let commands = fixture.spawner.commands();
        assert!(commands.contains(&format!("SCALE 4242 {CREATION} 0 75")), "{commands:?}");
        assert!(wait_until(Duration::from_secs(2), || {
            fixture.runtime.global_state()["active"] == json!(true)
        }));
        let status = fixture.events(STATUS_CHANNEL).into_iter().rev()
            .find(|status| status["sharpeningActive"] == json!(true)).expect("active status");
        assert_eq!(status["active"], json!(true));
        assert_eq!(status["asrActive"], json!(false));
        assert_eq!(status["sharpeningActive"], json!(true));
        assert_eq!(status["mode"], json!("scale"));
        assert_eq!(status["sharpeningReason"], Value::Null);
        assert_eq!(status["asrReason"], Value::Null);
        assert_eq!(status["selection"]["targetName"], json!("palworld-win64-shipping.exe"));
    }

    #[test]
    fn asr_only_scale_uses_the_upscale_flag_and_keeps_the_global_shape() {
        let fixture = Fixture::new();
        fixture.runtime.set_asr(AsrValue { enabled: true }).unwrap();
        let result = fixture.runtime.select_foreground_window().unwrap();
        assert_eq!(result["selection"]["phase"], json!("selected"));
        assert_eq!(result["asr"]["value"], json!({"enabled": true}));
        let commands = fixture.spawner.commands();
        assert!(commands.contains(&format!("SCALE 4242 {CREATION} 1 0")), "{commands:?}");
        assert!(wait_until(Duration::from_secs(2), || fixture.runtime.asr_state()["active"] == json!(true)));
        let asr = fixture.runtime.asr_state();
        assert_eq!(asr["requiresRestart"], json!(false));
        assert_eq!(asr["selection"]["phase"], json!("selected"));
        assert!(asr.get("reason").is_none());
    }

    #[test]
    fn ready_timeout_and_missing_helper_fail_closed() {
        let fixture = Fixture::custom(None, vec![FakePlan { stdout: String::new(), ..FakePlan::ready() }], 25, 60, true);
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 50 }).unwrap();
        let error = fixture.runtime.select_foreground_window().unwrap_err();
        assert_eq!(error, HELPER_READY_TIMEOUT);
        assert_eq!(fixture.runtime.global_state()["selection"]["phase"], json!("idle"));
        assert!(fixture.spawner.commands().iter().any(|command| command == "STOP"));

        let damaged = Fixture::custom(None, vec![], 25, 60, false);
        damaged.runtime.set_global(SharpeningValue { enabled: true, percentage: 50 }).unwrap();
        let error = damaged.runtime.select_foreground_window().unwrap_err();
        assert_eq!(error, HELPER_MISSING);
        assert_eq!(damaged.runtime.global_state()["runtimeReady"], json!(false));
        assert_eq!(damaged.runtime.global_state()["reason"], json!(HELPER_MISSING));
        assert_eq!(damaged.spawner.spawns.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn stderr_reason_and_fatal_shutdown_are_published() {
        let fixture = Fixture::custom(None, vec![FakePlan {
            stdout: "READY screen-sharpen-v1\n".into(),
            stderr: "WARN capture is temporarily unavailable\n".into(),
            exit_on_stop: true, exit_on_close: true,
        }], 25, 60, true);
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 50 }).unwrap();
        fixture.runtime.select_foreground_window().unwrap();
        assert!(wait_until(Duration::from_secs(2), || {
            fixture.runtime.global_state()["reason"] == json!("WARN capture is temporarily unavailable")
        }));
        assert!(fixture.events(STATUS_CHANNEL).iter()
            .any(|status| status["reason"] == json!("WARN capture is temporarily unavailable")));

        let fatal = Fixture::custom(None, vec![FakePlan {
            stdout: "READY screen-sharpen-v1\n".into(),
            stderr: "ERROR fatal capture device lost\n".into(),
            exit_on_stop: true, exit_on_close: true,
        }], 25, 60, true);
        fatal.runtime.set_global(SharpeningValue { enabled: true, percentage: 50 }).unwrap();
        fatal.runtime.select_foreground_window().unwrap();
        assert!(wait_until(Duration::from_secs(2), || {
            fatal.spawner.commands().iter().any(|command| command == "STOP")
        }));
        assert!(fatal.runtime.global_state()["active"] == json!(false));
    }

    #[test]
    fn helper_idle_clears_the_active_status() {
        let fixture = Fixture::custom(None, vec![FakePlan {
            stdout: "READY screen-sharpen-v1\nACTIVE 4242 SCALE\nIDLE\n".into(),
            stderr: String::new(),
            exit_on_stop: true, exit_on_close: true,
        }], 25, 60, true);
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 60 }).unwrap();
        fixture.runtime.select_foreground_window().unwrap();
        assert!(wait_until(Duration::from_secs(2), || {
            let events = fixture.events(STATUS_CHANNEL);
            events.iter().any(|status| status["sharpeningActive"] == json!(true))
                && events.iter().any(|status| status["active"] == json!(false)
                    && status["selection"]["phase"] == json!("selected"))
        }));
        assert_eq!(fixture.runtime.global_state()["active"], json!(false));
        assert!(fixture.spawner.commands().contains(&format!("SCALE 4242 {CREATION} 0 60")));
    }

    #[test]
    fn stop_window_sends_idle_and_stop_then_kills_a_stuck_helper() {
        let fixture = Fixture::custom(None, vec![FakePlan {
            stdout: "READY screen-sharpen-v1\nACTIVE 4242 SCALE\n".into(),
            stderr: String::new(),
            exit_on_stop: false, exit_on_close: false,
        }], 25, 60, true);
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 50 }).unwrap();
        fixture.runtime.select_foreground_window().unwrap();
        assert!(wait_until(Duration::from_secs(2), || fixture.runtime.global_state()["active"] == json!(true)));
        let result = fixture.runtime.stop_window();
        assert_eq!(result["selection"]["phase"], json!("idle"));
        assert_eq!(result["sharpening"]["active"], json!(false));
        let commands = fixture.spawner.commands();
        assert!(commands.iter().any(|command| command == IDLE_SCALE_COMMAND), "{commands:?}");
        assert!(commands.iter().any(|command| command == "STOP"), "{commands:?}");
        assert!(wait_until(Duration::from_secs(2), || fixture.spawner.first().killed.load(Ordering::SeqCst)));
    }

    #[test]
    fn countdown_cancellation_returns_canceled_without_spawning() {
        let fixture = Fixture::custom(None, vec![FakePlan::ready()], 1_000, 60, true);
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 50 }).unwrap();
        let runtime = fixture.runtime.clone();
        let select = std::thread::spawn(move || runtime.select_window());
        assert!(wait_until(Duration::from_secs(2), || {
            fixture.events(STATUS_CHANNEL).iter().any(|status| status["selection"]["phase"] == json!("countdown"))
        }));
        let stopped = fixture.runtime.stop_window();
        assert_eq!(stopped["selection"]["phase"], json!("idle"));
        let result = select.join().unwrap().unwrap();
        assert_eq!(result["canceled"], json!(true));
        assert_eq!(result["selection"]["phase"], json!("idle"));
        assert_eq!(fixture.spawner.spawns.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn status_events_are_deduplicated_and_global_revisions_are_monotonic() {
        let fixture = Fixture::new();
        fixture.runtime.stop_window();
        let initial = fixture.events(STATUS_CHANNEL).len();
        fixture.runtime.stop_window();
        fixture.runtime.stop_window();
        assert_eq!(fixture.events(STATUS_CHANNEL).len(), initial, "identical status must not be re-emitted");

        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 40 }).unwrap();
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 41 }).unwrap();
        fixture.runtime.set_asr(AsrValue { enabled: true }).unwrap();
        fixture.runtime.set_asr(AsrValue { enabled: false }).unwrap();
        let updates = fixture.events(GLOBAL_SETTINGS_CHANNEL);
        assert_eq!(updates.len(), 4);
        assert_eq!((updates[0]["kind"].as_str(), updates[0]["revision"].as_u64()), (Some("sharpening"), Some(1)));
        assert_eq!((updates[1]["kind"].as_str(), updates[1]["revision"].as_u64()), (Some("sharpening"), Some(2)));
        assert_eq!((updates[2]["kind"].as_str(), updates[2]["revision"].as_u64()), (Some("asr"), Some(1)));
        assert_eq!((updates[3]["kind"].as_str(), updates[3]["revision"].as_u64()), (Some("asr"), Some(2)));
        assert_eq!(updates[3]["state"]["value"], json!({"enabled": false}));
    }

    #[test]
    fn select_reports_identity_errors_and_resets_the_selection() {
        let fixture = Fixture::new();
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 50 }).unwrap();
        fixture.foreground.set(Err("detector offline".into()));
        assert_eq!(fixture.runtime.select_foreground_window().unwrap_err(),
            "Could not identify the foreground game window: detector offline");
        assert_eq!(fixture.runtime.global_state()["selection"]["phase"], json!("idle"));

        fixture.foreground.set(Ok(ForegroundIdentity { pid: 100, ..game_identity() }));
        assert_eq!(fixture.runtime.select_foreground_window().unwrap_err(), NO_GAME_SELECTED);
        assert_eq!(fixture.spawner.spawns.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn hotkey_grammar_canonicalizes_and_rejects_collisions() {
        assert_eq!(validate_postprocess_scale_hotkey(Some("alt+f10")).unwrap(), "Alt+F10");
        assert_eq!(validate_postprocess_scale_hotkey(Some("ctrl+shift+9")).unwrap(), "Control+Shift+9");
        assert_eq!(validate_postprocess_scale_hotkey(Some("Shift+Alt+F24")).unwrap(), "Alt+Shift+F24");
        assert_eq!(validate_overlay_hotkey_letter("o").unwrap(), "Control+O");
        assert_eq!(validate_overlay_hotkey_letter("None").unwrap(), "None");
        // 'None' is the explicit off state, not an invalid chord.
        assert_eq!(validate_postprocess_scale_hotkey(Some("None")).unwrap(), "None");
        for invalid in ["O", "9"] {
            assert_eq!(validate_postprocess_scale_hotkey(Some(invalid)).unwrap_err(),
                "postprocessScaleHotkey must include Ctrl, Alt, or Shift, or be a single F1-F24 key", "{invalid}");
        }
        for invalid in ["Control+F25", "Control+F01", "Control+Control+A", "Control", "Ctrl+Alt+", "Alt+Control", ""] {
            assert!(validate_postprocess_scale_hotkey(Some(invalid)).is_err(), "{invalid}");
        }
        assert_eq!(validate_postprocess_scale_hotkey(None).unwrap_err(),
            "overlayHotkeyLetter must be a modifier and a letter, number, or function key");
        assert!(overlay_hotkeys_collide("Control+O", "O"));
        assert!(overlay_hotkeys_collide("o", "Control+O"));
        assert!(overlay_hotkeys_collide("Alt+F10", "alt+f10"));
        assert!(!overlay_hotkeys_collide("None", "None"));
        assert!(!overlay_hotkeys_collide("Alt+F10", "Control+O"));
    }

    #[test]
    fn hotkey_channels_persist_and_report_registration_state() {
        let fixture = Fixture::new();
        let current = fixture.runtime.hotkey_get(&fixture.store).unwrap();
        assert_eq!(current["accelerator"], json!("Alt+F10"));
        assert_eq!(current["registered"], json!(true));
        assert_eq!(current["reason"], Value::Null);

        fixture.registration.set(false, Some("reserved by another app"));
        let unavailable = fixture.runtime.hotkey_get(&fixture.store).unwrap();
        assert_eq!(unavailable["registered"], json!(false));
        assert_eq!(unavailable["reason"], json!("reserved by another app"));

        fixture.registration.set(true, None);
        let updated = fixture.runtime.hotkey_set(&fixture.store, Some("control+f9")).unwrap();
        assert_eq!(updated, json!({"accelerator": "Control+F9", "registered": true}));
        let settings = super::super::services::native_json(&fixture.store, "load-settings", json!([])).unwrap();
        assert_eq!(settings["postprocessScaleHotkey"], json!("Control+F9"));
        assert_eq!(fixture.registration.reloads.lock().unwrap().as_slice(), ["Control+F9"]);

        assert_eq!(fixture.runtime.hotkey_set(&fixture.store, Some("Alt+F8")).unwrap_err(),
            "Scale hotkey must differ from both overlay hotkeys.");
        assert_eq!(fixture.runtime.hotkey_set(&fixture.store, Some("O")).unwrap_err(),
            "postprocessScaleHotkey must include Ctrl, Alt, or Shift, or be a single F1-F24 key");
        // A single function key is now a valid scale hotkey.
        assert_eq!(fixture.runtime.hotkey_set(&fixture.store, Some("F9")).unwrap()["accelerator"], json!("F9"));
        assert_eq!(fixture.runtime.hotkey_set(&fixture.store, None).unwrap_err(),
            "overlayHotkeyLetter must be a modifier and a letter, number, or function key");

        fixture.registration.set(false, None);
        let failed = fixture.runtime.hotkey_set(&fixture.store, Some("Alt+F7")).unwrap();
        assert_eq!(failed["registered"], json!(false));
        assert_eq!(failed["reason"], json!("Could not register Alt+F7; another application may use it."));
    }

    #[test]
    fn legacy_manifest_audit_preserves_the_electron_shape() {
        let fixture = Fixture::new();
        let manifest = json!({
            "c:\\games\\fixture\\fixture.exe": {
                "exePath": "C:\\Games\\Fixture\\Fixture.exe",
                "mode": "direct",
                "ownedFiles": {
                    "C:\\Games\\Fixture\\dxgi.dll": "a".repeat(64),
                    "C:\\Games\\Fixture\\ReShade.ini": "b".repeat(64),
                    "C:\\Games\\Fixture\\ArcPowerSharpening\\ArcPowerSharpen.fx": "c".repeat(64),
                    "C:\\Games\\Fixture\\ArcPowerSharpening\\preset.ini": "d".repeat(64),
                }
            }
        });
        std::fs::write(fixture.dir.join(LEGACY_MANIFEST_FILE), serde_json::to_string(&manifest).unwrap()).unwrap();
        let state = fixture.runtime.global_state();
        assert_eq!(state["legacyManifestStatus"], json!("found"));
        assert_eq!(state["legacyIntegrations"], json!([{"exePath": "C:\\Games\\Fixture\\Fixture.exe", "mode": "direct"}]));
        assert!(state["legacyManifestPath"].as_str().unwrap().ends_with(LEGACY_MANIFEST_FILE));

        std::fs::write(fixture.dir.join(LEGACY_MANIFEST_FILE), b"not json").unwrap();
        let unreadable = fixture.runtime.global_state();
        assert_eq!(unreadable["legacyManifestStatus"], json!("unreadable"));
        assert!(unreadable["legacyManifestReason"].as_str().is_some());
        assert_eq!(unreadable["legacyIntegrations"], json!([]));
    }

    #[test]
    fn capture_gates_preserve_values_and_reject_activation() {
        let dir = std::env::temp_dir().join(format!("arc-postprocess-gate-{:032x}", rand::random::<u128>()));
        std::fs::create_dir_all(&dir).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let emit_events = events.clone();
        let seams = Seams {
            spawner: Arc::new(FakeSpawner::new(Vec::new())),
            foreground: Arc::new(FakeForeground::new()),
            registration: Arc::new(FakeRegistration::new(true)),
            integrity: Arc::new(|_: &Path| true),
            emit: Some(Arc::new(move |channel: &str, payload: Value| {
                emit_events.lock().unwrap().push((channel.to_owned(), payload));
            })),
        };
        let runtime = SharpeningRuntime::new(RuntimeOptions {
            dir: dir.clone(),
            helper_path: Some(dir.join("helper.exe")),
            allow_capture_overlay: false,
            allow_asr_capture: false,
            ready_timeout: Duration::from_millis(100),
            kill_timeout: Duration::from_millis(60),
            countdown_tick: Duration::from_millis(20),
            hotkey_registration_timeout: Duration::from_millis(100),
            identity: guard(),
        }, seams);
        let global = runtime.global_state();
        assert_eq!(global["runtimeReady"], json!(false));
        assert_eq!(global["reason"], json!(SHARPENING_PAUSED_REASON));
        assert_eq!(runtime.set_global(SharpeningValue { enabled: true, percentage: 50 }).unwrap_err(), SHARPENING_PAUSED_REASON);
        assert_eq!(runtime.set_asr(AsrValue { enabled: true }).unwrap_err(), ASR_PAUSED_REASON);
        assert_eq!(runtime.asr_state()["reason"], json!(ASR_PAUSED_REASON));
        assert!(!dir.join(SETTINGS_FILE).exists(), "a rejected write must not create the settings file");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn null_top_level_settings_fall_back_to_defaults() {
        let fixture = Fixture::custom(Some(json!({
            "global": null, "games": null, "asr": null, "asrGames": null,
        })), vec![], 25, 60, true);
        let state = fixture.runtime.global_state();
        assert!(state.get("reason").is_none(), "{state}");
        assert_eq!(state["value"], json!({"enabled": false, "percentage": 50}));
        assert_eq!(state["overrideCount"], json!(0));
        assert_eq!(fixture.runtime.asr_state()["value"], json!({"enabled": false}));
    }

    #[test]
    fn settings_file_validation_rejects_malformed_game_identity() {
        let fixture = Fixture::custom(Some(json!({
            "games": {"C:\\Games\\Fixture\\Fixture.exe": {"enabled": true, "percentage": 50}},
        })), vec![], 25, 60, true);
        assert!(fixture.runtime.global_state()["reason"].as_str().unwrap().contains("settings could not be loaded"));
        let bad_asr = Fixture::custom(Some(json!({"asr": {"enabled": true, "speed": 2}})), vec![], 25, 60, true);
        assert!(bad_asr.runtime.global_state()["reason"].as_str().unwrap().contains("settings could not be loaded"));
    }

    #[cfg(windows)]
    #[test]
    fn concurrent_starts_share_one_helper_process() {
        let fixture = Fixture::new();
        fixture.runtime.set_global(SharpeningValue { enabled: true, percentage: 55 }).unwrap();
        {
            let mut state = fixture.runtime.lock();
            state.selection = Selection {
                phase: Phase::Selected,
                seconds_remaining: 0,
                target_name: Some("palworld-win64-shipping.exe".into()),
                target: Some(ScreenTarget {
                    pid: 4242, exe_path: GAME_KEY.into(), creation_filetime: CREATION.into(),
                    name: "palworld-win64-shipping.exe".into(),
                }),
                upscale: false,
                sharpness: 0,
            };
        }
        let first = fixture.runtime.clone();
        let second = fixture.runtime.clone();
        let one = std::thread::spawn(move || first.start_helper());
        let two = std::thread::spawn(move || second.start_helper());
        assert!(one.join().unwrap());
        assert!(two.join().unwrap());
        assert_eq!(fixture.spawner.spawns.load(Ordering::SeqCst), 1);
        assert!(fixture.spawner.commands().contains(&format!("SCALE 4242 {CREATION} 0 55")));
        fixture.runtime.stop_window();
    }

    #[test]
    fn bundled_helper_resolves_from_the_source_checkout_and_matches_the_pin() {
        let path = resolve_helper_path().expect("the source checkout helper path");
        assert!(path.is_file(), "{}", path.display());
        assert!(path.ends_with("src\\main\\sharpening-runtime\\ArcPower.ScreenSharpen.exe"), "{}", path.display());
        assert!(helper_integrity(&path), "the bundled helper and FSR assets must match the production pin");
    }

    #[test]
    fn advanced_hotkey_registration_requires_the_desired_shortcut_to_be_registered() {
        let mut snapshot = HostRegistrationSnapshot {
            started: true,
            registered: vec!["Control+P".into()],
            advanced_desired: Some("Control+P".into()),
            advanced_registered: true,
            ..HostRegistrationSnapshot::default()
        };
        assert!(snapshot.advanced_hotkey_registered("Control+P"));
        assert!(!snapshot.advanced_hotkey_registered("Control+O"));
        snapshot.advanced_registered = false;
        assert!(!snapshot.advanced_hotkey_registered("Control+P"));
        snapshot.advanced_desired = Some("Control+O".into());
        snapshot.advanced_registered = true;
        assert!(!snapshot.advanced_hotkey_registered("Control+P"));
    }
}

