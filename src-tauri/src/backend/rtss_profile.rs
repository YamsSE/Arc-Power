//! Native RTSS profile/frame-limiter controller. Loads RTSSHooks64.dll from the
//! resolved RTSS installation and exposes the surface used by Graphics and Arc
//! Sleep: OSD renderer profile setup, global/per-game frame limits, ownership
//! snapshots and verified rollback. All writes are read back; the controller
//! fails closed instead of overwriting an externally edited RTSS profile.
use super::rtss_startup;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::{c_void, CString},
    path::Path,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const LIMITER_DISABLED_FLAG: u32 = 4;
const FRAME_LIMIT_PROPERTY: &str = "FramerateLimit";
const FRAME_LIMIT_DENOMINATOR_PROPERTY: &str = "FramerateLimitDenominator";
const SHARPENING_COMPATIBILITY_PROFILE: &str = "ArcPower.ScreenSharpen.exe";
const MIN_LIMIT: f64 = 1.0;
const MAX_LIMIT: f64 = 1000.0;
const GLOBAL_PROFILE: &str = "";

type LoadProfile = unsafe extern "system" fn(*const u8);
type SaveProfile = unsafe extern "system" fn(*const u8);
type GetProfileProperty = unsafe extern "system" fn(*const u8, *mut c_void, u32) -> i32;
type SetProfileProperty = unsafe extern "system" fn(*const u8, *mut c_void, u32) -> i32;
type UpdateProfiles = unsafe extern "system" fn();
type SetFlags = unsafe extern "system" fn(u32, u32) -> u32;
type EnumProfiles = unsafe extern "system" fn(*mut u8, u32) -> u32;
type DeleteProfile = unsafe extern "system" fn(*const u8);

trait ProfileApi: Send + Sync {
    fn load(&self, profile: &str);
    fn save(&self, profile: &str);
    fn update(&self);
    fn read(&self, property: &str) -> Option<u32>;
    fn write(&self, property: &str, value: u32) -> bool;
    fn flags(&self) -> u32;
    fn set_enabled(&self, enabled: bool) -> bool;
    fn profiles(&self) -> Option<HashSet<String>>;
    fn delete_verified(&self, profile: &str) -> bool;
    fn has_game_limit(&self) -> bool;
}

struct Api {
    module: windows_sys::Win32::Foundation::HMODULE,
    load_profile: LoadProfile,
    save_profile: SaveProfile,
    get_property: GetProfileProperty,
    set_property: SetProfileProperty,
    update_profiles: UpdateProfiles,
    set_flags: SetFlags,
    enum_profiles: EnumProfiles,
    delete_profile: Option<DeleteProfile>,
}
// Access is serialized by the controller mutex. RTSSHooks exports are free
// functions over RTSS-owned global state, so a shared handle is safe here.
unsafe impl Send for Api {}
unsafe impl Sync for Api {}

impl Drop for Api {
    fn drop(&mut self) {
        unsafe { windows_sys::Win32::Foundation::FreeLibrary(self.module); }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct RawState {
    limit: u32,
    denominator: Option<u32>,
    limiter_enabled: bool,
}

#[derive(Clone)]
struct Snapshot {
    profile: String,
    previous: RawState,
    desired_limit: u32,
    desired_denominator: Option<u32>,
    existed: bool,
    created: bool,
}

#[derive(Clone, Copy)]
struct FlagSnapshot {
    previous_enabled: bool,
}

struct Inner {
    api: Option<Arc<dyn ProfileApi>>,
    assume_running: bool,
    executable_path: Option<String>,
    osd_snapshot: Option<Vec<(&'static str, Option<u32>, u32)>>,
    snapshots: HashMap<String, Snapshot>,
    active: HashSet<String>,
    flag_snapshot: Option<FlagSnapshot>,
}

pub struct RtssProfileController {
    inner: Mutex<Inner>,
}

fn cstring(value: &str) -> Option<CString> {
    CString::new(value.replace('\0', "")).ok()
}

fn basename(value: Option<&str>) -> String {
    value.map(str::trim).filter(|value| !value.is_empty())
        .and_then(|value| value.rsplit(['\\', '/']).next())
        .filter(|name| !name.is_empty() && *name != "." && *name != "\\")
        .unwrap_or(GLOBAL_PROFILE)
        .to_owned()
}

fn parse_state(value: &Value) -> Option<RawState> {
    let object = value.as_object()?;
    let limit = object.get("limit")?.as_u64().filter(|value| *value <= u32::MAX as u64)? as u32;
    let denominator = match object.get("denominator") {
        Some(Value::Null) => None,
        Some(value) => Some(value.as_u64().filter(|value| *value <= u32::MAX as u64)? as u32),
        None => return None,
    };
    let limiter_enabled = object.get("limiterEnabled")?.as_bool()?;
    Some(RawState { limit, denominator, limiter_enabled })
}

fn state_json(state: &RawState) -> Value {
    json!({"limit": state.limit, "denominator": state.denominator, "limiterEnabled": state.limiter_enabled})
}

fn parse_profiles(bytes: &[u8], length: usize) -> HashSet<String> {
    String::from_utf8_lossy(&bytes[..length.min(bytes.len())])
        .split(',')
        .map(|name| name.trim().to_ascii_lowercase())
        .filter(|name| !name.is_empty())
        .collect()
}

fn number(value: Option<&Value>) -> Option<f64> {
    value.and_then(Value::as_f64).filter(|value| value.is_finite())
}

// The Arc Sleep controller probes ownership frequently. A short cache keeps
// the native host from spawning tasklist on every tick while still noticing a
// stopped RTSS before a write.
fn rtss_running() -> bool {
    static CACHE: OnceLock<Mutex<Option<(Instant, bool)>>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(guard) = cache.lock() {
        if let Some((checked, running)) = *guard {
            if checked.elapsed() < Duration::from_millis(750) { return running; }
        }
    }
    let running = rtss_startup::is_running();
    if let Ok(mut guard) = cache.lock() { *guard = Some((Instant::now(), running)); }
    running
}

impl Api {
    fn open() -> Option<Self> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::System::LibraryLoader::{
            GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR,
            LOAD_LIBRARY_SEARCH_SYSTEM32,
        };
        let executable = rtss_startup::executable_path()?;
        let root = Path::new(&executable).parent()?;
        for name in ["RTSSHooks64.dll", "RTSSHooks.dll"] {
            let path = root.join(name);
            if !path.is_file() { continue; }
            let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
            if wide.contains(&0) { continue; }
            wide.push(0);
            let module = unsafe {
                LoadLibraryExW(
                    wide.as_ptr(),
                    std::ptr::null_mut(),
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32,
                )
            };
            if module.is_null() { continue; }
            let symbol = |name: &str| -> Option<unsafe extern "system" fn() -> isize> {
                let name = CString::new(name).ok()?;
                unsafe { GetProcAddress(module, name.as_ptr() as *const u8) }
            };
            let api = (|| unsafe {
                let load_profile = symbol("LoadProfile")?;
                let save_profile = symbol("SaveProfile")?;
                let get_property = symbol("GetProfileProperty")?;
                let set_property = symbol("SetProfileProperty")?;
                let update_profiles = symbol("UpdateProfiles")?;
                let set_flags = symbol("SetFlags")?;
                let enum_profiles = symbol("EnumProfiles")?;
                let delete_profile = symbol("DeleteProfile");
                Some(Self {
                    module,
                    load_profile: std::mem::transmute::<unsafe extern "system" fn() -> isize, LoadProfile>(load_profile),
                    save_profile: std::mem::transmute::<unsafe extern "system" fn() -> isize, SaveProfile>(save_profile),
                    get_property: std::mem::transmute::<unsafe extern "system" fn() -> isize, GetProfileProperty>(get_property),
                    set_property: std::mem::transmute::<unsafe extern "system" fn() -> isize, SetProfileProperty>(set_property),
                    update_profiles: std::mem::transmute::<unsafe extern "system" fn() -> isize, UpdateProfiles>(update_profiles),
                    set_flags: std::mem::transmute::<unsafe extern "system" fn() -> isize, SetFlags>(set_flags),
                    enum_profiles: std::mem::transmute::<unsafe extern "system" fn() -> isize, EnumProfiles>(enum_profiles),
                    delete_profile: delete_profile
                        .map(|pointer| std::mem::transmute::<unsafe extern "system" fn() -> isize, DeleteProfile>(pointer)),
                })
            })();
            if api.is_some() { return api; }
            unsafe { windows_sys::Win32::Foundation::FreeLibrary(module); }
        }
        None
    }

    fn load(&self, profile: &str) {
        if let Some(name) = cstring(profile) {
            unsafe { (self.load_profile)(name.as_ptr() as *const u8); }
        }
    }
    fn save(&self, profile: &str) {
        if let Some(name) = cstring(profile) {
            unsafe { (self.save_profile)(name.as_ptr() as *const u8); }
        }
    }
    fn update(&self) { unsafe { (self.update_profiles)(); } }
    fn read(&self, property: &str) -> Option<u32> {
        let name = cstring(property)?;
        let mut value = [0u8; 4];
        let ok = unsafe {
            (self.get_property)(name.as_ptr() as *const u8, value.as_mut_ptr() as *mut c_void, 4)
        };
        (ok != 0).then(|| u32::from_le_bytes(value))
    }
    fn write(&self, property: &str, value: u32) -> bool {
        let Some(name) = cstring(property) else { return false; };
        let bytes = value.to_le_bytes();
        unsafe {
            (self.set_property)(name.as_ptr() as *const u8, bytes.as_ptr() as *mut c_void, 4) != 0
        }
    }
    fn flags(&self) -> u32 { unsafe { (self.set_flags)(0xFFFF_FFFF, 0) } }
    fn set_enabled(&self, enabled: bool) -> bool {
        let desired_disabled = !enabled;
        unsafe { (self.set_flags)(!LIMITER_DISABLED_FLAG, if desired_disabled { LIMITER_DISABLED_FLAG } else { 0 }); }
        ((self.flags() & LIMITER_DISABLED_FLAG) != 0) == desired_disabled
    }
    fn profiles(&self) -> Option<HashSet<String>> {
        let mut capacity = 4096usize;
        for _ in 0..9 {
            let mut buffer = vec![0u8; capacity];
            let reported = unsafe { (self.enum_profiles)(buffer.as_mut_ptr(), capacity as u32) } as usize;
            if reported > 1024 * 1024 { return None; }
            if reported > capacity { capacity = reported; continue; }
            if reported == 0 { return Some(HashSet::new()); }
            let terminator = buffer[..reported.min(capacity)].iter().position(|byte| *byte == 0)?;
            return Some(parse_profiles(&buffer, terminator));
        }
        None
    }
    fn delete_verified(&self, profile: &str) -> bool {
        let Some(delete) = self.delete_profile else { return false; };
        let Some(name) = cstring(profile) else { return false; };
        unsafe { delete(name.as_ptr() as *const u8); }
        self.update();
        self.profiles().is_some_and(|profiles| !profiles.contains(&profile.to_ascii_lowercase()))
    }
    fn has_game_limit(&self) -> bool {
        let Some(profiles) = self.profiles() else { return true; };
        for profile in profiles {
            if profile.is_empty() { continue; }
            self.load(&profile);
            if self.read(FRAME_LIMIT_PROPERTY).is_some_and(|limit| limit > 0) {
                self.load(GLOBAL_PROFILE);
                return true;
            }
        }
        self.load(GLOBAL_PROFILE);
        false
    }
}

impl ProfileApi for Api {
    fn load(&self, profile: &str) { Api::load(self, profile); }
    fn save(&self, profile: &str) { Api::save(self, profile); }
    fn update(&self) { Api::update(self); }
    fn read(&self, property: &str) -> Option<u32> { Api::read(self, property) }
    fn write(&self, property: &str, value: u32) -> bool { Api::write(self, property, value) }
    fn flags(&self) -> u32 { Api::flags(self) }
    fn set_enabled(&self, enabled: bool) -> bool { Api::set_enabled(self, enabled) }
    fn profiles(&self) -> Option<HashSet<String>> { Api::profiles(self) }
    fn delete_verified(&self, profile: &str) -> bool { Api::delete_verified(self, profile) }
    fn has_game_limit(&self) -> bool { Api::has_game_limit(self) }
}

impl RtssProfileController {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                api: None,
                assume_running: false,
                executable_path: None,
                osd_snapshot: None,
                snapshots: HashMap::new(),
                active: HashSet::new(),
                flag_snapshot: None,
            }),
        }
    }

    fn with_api<T>(&self, action: impl FnOnce(&mut Inner, &dyn ProfileApi) -> T) -> Result<T, String> {
        self.with_api_using(action, || Api::open().map(|api| Arc::new(api) as Arc<dyn ProfileApi>))
    }

    fn with_api_using<T>(
        &self,
        action: impl FnOnce(&mut Inner, &dyn ProfileApi) -> T,
        open_api: impl FnOnce() -> Option<Arc<dyn ProfileApi>>,
    ) -> Result<T, String> {
        let mut inner = self.inner.lock().map_err(|_| "RTSS profile lock failed")?;
        if !inner.assume_running && !rtss_running() { return Err("RTSS is not running".into()); }
        if inner.api.is_none() {
            inner.api = open_api();
            inner.executable_path = rtss_startup::executable_path();
        }
        let api = inner.api.as_ref().cloned().ok_or("RTSS profile API is unavailable")?;
        Ok(action(&mut inner, api.as_ref()))
    }

    #[cfg(test)]
    fn with_fake(api: Arc<dyn ProfileApi>) -> Self {
        Self {
            inner: Mutex::new(Inner {
                api: Some(api),
                assume_running: true,
                executable_path: Some("C:\\RTSS\\RTSS.exe".into()),
                osd_snapshot: None,
                snapshots: HashMap::new(),
                active: HashSet::new(),
                flag_snapshot: None,
            }),
        }
    }

    pub fn state(&self) -> Value {
        // Do the same read-only discovery as the limiter channels. Merely
        // reporting `inner.api.is_some()` made a freshly installed/running
        // RTSS look unavailable until some unrelated call first opened the
        // hooks DLL.
        self.with_api(Self::state_value).unwrap_or_else(|error| {
            let path = self.inner.lock().ok().and_then(|inner| inner.executable_path.clone());
            json!({
                "available": false, "configured": false, "renderingMode": "unknown",
                "executablePath": path, "error": error,
            })
        })
    }

    fn state_value(inner: &mut Inner, _api: &dyn ProfileApi) -> Value {
        json!({
            "available": true,
            "configured": inner.osd_snapshot.is_some(),
            "renderingMode": if inner.osd_snapshot.is_some() { "vector2d" } else { "unknown" },
            "executablePath": inner.executable_path,
            "error": Value::Null,
        })
    }

    pub fn apply(&self, options: &Value) -> Value {
        let enabled = options.get("enabled").and_then(Value::as_bool) == Some(true);
        let result = self.with_api(|inner, api| {
            api.load(GLOBAL_PROFILE);
            if !enabled {
                let mut changed = false;
                if let Some(entries) = inner.osd_snapshot.clone() {
                    for (property, previous, desired) in entries {
                        if api.read(property) != Some(desired) { continue; }
                        if let Some(previous) = previous {
                            if !api.write(property, previous) {
                                return json!({
                                    "available": true, "configured": true, "renderingMode": "vector2d",
                                    "executablePath": inner.executable_path,
                                    "error": format!("RTSS {property} could not be restored"),
                                });
                            }
                            changed = true;
                        }
                    }
                }
                if changed {
                    api.save(GLOBAL_PROFILE);
                    api.update();
                }
                inner.osd_snapshot = None;
                return json!({
                    "available": true, "configured": false, "renderingMode": "unknown",
                    "executablePath": inner.executable_path, "error": Value::Null,
                });
            }
            let properties: [(&'static str, u32); 3] =
                [("Implementation", 1), ("AppDetectionLevel", 1), ("EnableOSD", 1)];
            let mut changes = Vec::new();
            let mut failure = None;
            for (property, desired) in properties {
                let previous = api.read(property);
                if previous == Some(desired) { continue; }
                if api.write(property, desired) {
                    changes.push((property, previous, desired));
                } else {
                    failure = Some(format!("RTSS {property} could not be updated"));
                    break;
                }
            }
            let has_changes = !changes.is_empty();
            if inner.osd_snapshot.is_none() && has_changes { inner.osd_snapshot = Some(changes); }
            if has_changes {
                api.save(GLOBAL_PROFILE);
                api.update();
            }
            if let Some(error) = failure {
                return json!({
                    "available": true, "configured": inner.osd_snapshot.is_some(),
                    "renderingMode": if inner.osd_snapshot.is_some() { "vector2d" } else { "unknown" },
                    "executablePath": inner.executable_path, "error": error,
                });
            }
            json!({
                "available": true, "configured": true, "renderingMode": "vector2d",
                "executablePath": inner.executable_path, "error": Value::Null,
            })
        });
        result.unwrap_or_else(|error| json!({
            "available": false, "configured": false, "renderingMode": "unknown",
            "executablePath": None::<String>, "error": error,
        }))
    }

    fn read_global(api: &dyn ProfileApi) -> Option<RawState> {
        api.load(GLOBAL_PROFILE);
        let limit = api.read(FRAME_LIMIT_PROPERTY)?;
        let denominator = api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY);
        Some(RawState { limit, denominator, limiter_enabled: (api.flags() & LIMITER_DISABLED_FLAG) == 0 })
    }

    pub fn get_frame_limit(&self, options: &Value) -> Value {
        let profile = basename(options.get("executablePath").and_then(Value::as_str));
        self.with_api(|_inner, api| {
            api.load(&profile);
            match (api.read(FRAME_LIMIT_PROPERTY), api.flags()) {
                (Some(limit), flags) => {
                    let denominator = api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY);
                    json!({
                        "ok": true, "available": true, "source": "rtss", "profile": profile,
                        "limit": limit, "denominator": denominator.unwrap_or(1),
                        "limiterEnabled": (flags & LIMITER_DISABLED_FLAG) == 0,
                    })
                }
                _ => json!({
                    "ok": false, "available": true, "source": "igcl", "profile": profile,
                    "error": "RTSS frame limiter read-back failed",
                }),
            }
        }).unwrap_or_else(|error| json!({
            "ok": false, "available": false, "source": "igcl", "error": error,
        }))
    }

    pub fn get_ownership(&self) -> Value {
        self.with_api(|inner, api| {
            let Some(current) = Self::read_global(api) else {
                return json!({"ok": false, "errorCode": "unavailable", "error": "RTSS global frame-limit state could not be read"});
            };
            let snapshot = inner.snapshots.get(GLOBAL_PROFILE);
            let underlay = RawState {
                limit: snapshot.map(|snapshot| snapshot.previous.limit).unwrap_or(current.limit),
                denominator: snapshot.and_then(|snapshot| snapshot.previous.denominator).or(current.denominator),
                limiter_enabled: inner.flag_snapshot
                    .map(|flag| flag.previous_enabled)
                    .unwrap_or(current.limiter_enabled),
            };
            let disable = RawState {
                limit: 0,
                denominator: current.denominator.map(|_| 1),
                limiter_enabled: if snapshot.is_some() { underlay.limiter_enabled } else { current.limiter_enabled },
            };
            json!({
                "ok": true,
                "state": state_json(&current),
                "underlay": state_json(&underlay),
                "disableState": state_json(&disable),
            })
        }).unwrap_or_else(|error| json!({
            "ok": false, "errorCode": "unavailable", "error": error,
        }))
    }

    fn restore_flag_if_idle(inner: &mut Inner, api: &dyn ProfileApi) -> Result<bool, String> {
        let Some(snapshot) = inner.flag_snapshot else { return Ok(true); };
        if !inner.active.is_empty() { return Ok(false); }
        if !snapshot.previous_enabled && api.has_game_limit() { return Ok(false); }
        let current = api.flags();
        if ((current & LIMITER_DISABLED_FLAG) != 0) != !snapshot.previous_enabled {
            return Err("RTSS limiter flag changed outside Arc Power; rollback was not verified".into());
        }
        if !api.set_enabled(snapshot.previous_enabled) {
            return Err("RTSS limiter flag rollback could not be verified".into());
        }
        inner.flag_snapshot = None;
        Ok(true)
    }

    // A failed enable must not leave a half-written profile behind. Restore
    // only fields that still equal Arc Power's target and keep the snapshot
    // when cleanup cannot be verified so a later retry has ownership proof.
    fn rollback_enable(inner: &mut Inner, api: &dyn ProfileApi, snapshot: &Snapshot) -> Option<String> {
        api.load(&snapshot.profile);
        let current_limit = api.read(FRAME_LIMIT_PROPERTY);
        let current_denominator = api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY);
        let mut changed = false;
        if current_limit == Some(snapshot.desired_limit) && snapshot.previous.limit != snapshot.desired_limit {
            if !api.write(FRAME_LIMIT_PROPERTY, snapshot.previous.limit)
                || api.read(FRAME_LIMIT_PROPERTY) != Some(snapshot.previous.limit) {
                return Some("RTSS FramerateLimit rollback could not be verified".into());
            }
            changed = true;
        }
        if let Some(desired) = snapshot.desired_denominator {
            if current_denominator == Some(desired) {
                if let Some(previous) = snapshot.previous.denominator.filter(|previous| *previous != desired) {
                    if !api.write(FRAME_LIMIT_DENOMINATOR_PROPERTY, previous)
                        || api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY) != Some(previous) {
                        return Some("RTSS FramerateLimitDenominator rollback could not be verified".into());
                    }
                    changed = true;
                }
            }
        }
        if changed && snapshot.existed { api.save(&snapshot.profile); }
        if snapshot.created && !snapshot.profile.is_empty() && !api.delete_verified(&snapshot.profile) {
            return Some("RTSS profile deletion could not be verified".into());
        }
        inner.active.remove(&snapshot.profile);
        if let Err(error) = Self::restore_flag_if_idle(inner, api) { return Some(error); }
        inner.snapshots.remove(&snapshot.profile);
        None
    }

    fn restore_token(snapshot: &Snapshot, expected: RawState) -> Value {        json!({
            "profile": snapshot.profile,
            "previousLimit": snapshot.previous.limit,
            "previousDenominator": snapshot.previous.denominator,
            "previousEnabled": snapshot.previous.limiter_enabled,
            "expectedLimit": expected.limit,
            "expectedDenominator": expected.denominator,
            "expectedEnabled": expected.limiter_enabled,
            "desiredLimit": snapshot.desired_limit,
            "desiredDenominator": snapshot.desired_denominator,
            "existed": snapshot.existed,
            "created": snapshot.created,
        })
    }

    fn rollback_token(snapshot: &Snapshot) -> Value {
        json!({
            "profile": snapshot.profile,
            "previousLimit": snapshot.previous.limit,
            "previousDenominator": snapshot.previous.denominator,
            "previousEnabled": snapshot.previous.limiter_enabled,
            "desiredLimit": snapshot.desired_limit,
            "desiredDenominator": snapshot.desired_denominator,
            "existed": snapshot.existed,
            "created": snapshot.created,
        })
    }

    pub fn apply_frame_limit(&self, options: &Value) -> Value {
        let enabled = options.get("enabled").and_then(Value::as_bool) == Some(true);
        let requested = match number(options.get("value")) {
            Some(value) if value != 0.0 => value,
            _ => 60.0,
        }.round().clamp(MIN_LIMIT, MAX_LIMIT) as u32;
        let executable = options.get("executablePath").and_then(Value::as_str);
        let profile = basename(executable);
        let remove_profile = options.get("removeProfile").and_then(Value::as_bool) == Some(true);
        let expected_value = options.get("expectedState").filter(|value| !value.is_null());
        let result = self.with_api(|inner, api| {
            match expected_value {
                Some(value) => {
                    if !profile.is_empty() {
                        return json!({
                            "ok": false, "used": false, "conflict": false, "errorCode": "invalid-state",
                            "error": "Conditional RTSS frame-limit updates require a valid global expectedState",
                        });
                    }
                    let Some(expected) = parse_state(value) else {
                        return json!({
                            "ok": false, "used": false, "conflict": false, "errorCode": "invalid-state",
                            "error": "Conditional RTSS frame-limit updates require a valid global expectedState",
                        });
                    };
                    let Some(observed) = Self::read_global(api) else {
                        return json!({"ok": false, "used": false, "conflict": false, "errorCode": "unavailable", "error": "RTSS global frame-limit state could not be read"});
                    };
                    if observed != expected {
                        return json!({
                            "ok": false, "used": false, "conflict": true, "errorCode": "external-change",
                            "observedState": state_json(&observed), "expectedState": state_json(&expected),
                            "error": "RTSS global frame-limit state changed outside Arc Power",
                        });
                    }
                }
                None => {}
            }
            api.load(&profile);
            let Some(before_limit) = api.read(FRAME_LIMIT_PROPERTY) else {
                return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimit property is unavailable"});
            };
            let before_denominator = api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY);
            let before_enabled = (api.flags() & LIMITER_DISABLED_FLAG) == 0;

            if enabled {
                let existed = profile.is_empty() || api.profiles().is_none_or(|profiles| profiles.contains(&profile.to_ascii_lowercase()));
                let mut snapshot = inner.snapshots.get(&profile).cloned().unwrap_or(Snapshot {
                    profile: profile.clone(),
                    previous: RawState { limit: before_limit, denominator: before_denominator, limiter_enabled: before_enabled },
                    desired_limit: requested,
                    desired_denominator: before_denominator.map(|_| 1),
                    existed,
                    created: false,
                });
                snapshot.desired_limit = requested;
                snapshot.desired_denominator = before_denominator.map(|_| 1);
                let mut changed = false;
                if before_limit != requested {
                    if !api.write(FRAME_LIMIT_PROPERTY, requested) || api.read(FRAME_LIMIT_PROPERTY) != Some(requested) {
                        let mut result = json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimit could not be updated"});
                        if let Some(error) = Self::rollback_enable(inner, api, &snapshot) {
                            result["cleanupPending"] = json!(true);
                            result["cleanupError"] = json!(error);
                        }
                        return result;
                    }
                    changed = true;
                    if !profile.is_empty() && !snapshot.existed { snapshot.created = true; }
                }
                if let Some(denominator) = before_denominator.filter(|value| *value != 1) {
                    if !api.write(FRAME_LIMIT_DENOMINATOR_PROPERTY, 1) {
                        let mut result = json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimitDenominator could not be updated"});
                        if let Some(error) = Self::rollback_enable(inner, api, &snapshot) {
                            result["cleanupPending"] = json!(true);
                            result["cleanupError"] = json!(error);
                        }
                        return result;
                    }
                    let _ = denominator;
                    changed = true;
                }
                if changed { api.save(&profile); }
                if inner.flag_snapshot.is_none() {
                    inner.flag_snapshot = Some(FlagSnapshot { previous_enabled: before_enabled });
                }
                if !api.set_enabled(true) {
                    let mut result = json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS frame limiter could not be enabled"});
                    if let Some(error) = Self::rollback_enable(inner, api, &snapshot) {
                        result["cleanupPending"] = json!(true);
                        result["cleanupError"] = json!(error);
                    }
                    return result;
                }
                inner.active.insert(profile.clone());
                if changed || !before_enabled { api.update(); }
                let expected = RawState {
                    limit: requested,
                    denominator: snapshot.desired_denominator,
                    limiter_enabled: true,
                };
                let rollback = Self::rollback_token(&snapshot);
                inner.snapshots.insert(profile.clone(), snapshot.clone());
                return json!({
                    "ok": true, "used": true, "source": "rtss", "profile": profile,
                    "enabled": true, "value": requested, "changed": changed,
                    "rollbackToken": rollback, "restoreToken": Self::restore_token(&snapshot, expected),
                });
            }

            let snapshot = inner.snapshots.get(&profile).cloned();
            let mut changed = false;

            if !profile.is_empty() && remove_profile {
                let Some(snapshot) = snapshot else {
                    return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS ownership snapshot unavailable; profile was not removed"});
                };
                let matches_desired = before_limit == snapshot.desired_limit
                    && snapshot.desired_denominator.is_none_or(|denominator| before_denominator == Some(denominator));
                if !matches_desired {
                    return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS profile changed outside Arc Power; cleanup was not verified"});
                }
                if snapshot.existed {
                    if snapshot.previous.limit != before_limit {
                        if !api.write(FRAME_LIMIT_PROPERTY, snapshot.previous.limit) || api.read(FRAME_LIMIT_PROPERTY) != Some(snapshot.previous.limit) {
                            return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimit could not be restored"});
                        }
                        changed = true;
                    }
                    if let Some(previous) = snapshot.previous.denominator.filter(|previous| before_denominator != Some(*previous)) {
                        if !api.write(FRAME_LIMIT_DENOMINATOR_PROPERTY, previous) || api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY) != Some(previous) {
                            return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimitDenominator could not be restored"});
                        }
                        changed = true;
                    }
                    if changed { api.save(&profile); }
                    inner.active.remove(&profile);
                    let flag_restored = match Self::restore_flag_if_idle(inner, api) {
                        Ok(value) => value,
                        Err(error) => return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": error}),
                    };
                    let restored = Self::read_profile(api, &profile);
                    inner.snapshots.remove(&profile);
                    let mut result = json!({
                        "ok": true, "used": true, "source": "rtss", "profile": profile,
                        "enabled": false, "value": 0, "changed": changed, "removed": true,
                        "profileDeleted": false, "restored": true,
                        "rollbackToken": Self::rollback_token(&snapshot),
                        "restoreToken": Self::restore_token(&snapshot, restored.unwrap_or(RawState { limit: before_limit, denominator: before_denominator, limiter_enabled: before_enabled })),
                        "flagRestored": flag_restored,
                    });
                    if !flag_restored { result["flagRestorationDeferred"] = json!(true); }
                    return result;
                }
                if snapshot.created && !api.delete_verified(&profile) {
                    return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS profile deletion could not be verified"});
                }
                inner.active.remove(&profile);
                let flag_restored = match Self::restore_flag_if_idle(inner, api) {
                    Ok(value) => value,
                    Err(error) => return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": error}),
                };
                inner.snapshots.remove(&profile);
                let mut result = json!({
                    "ok": true, "used": true, "source": "rtss", "profile": profile,
                    "enabled": false, "value": 0, "changed": snapshot.created, "removed": true,
                    "profileDeleted": snapshot.created, "rollbackToken": Self::rollback_token(&snapshot),
                    "flagRestored": flag_restored,
                });
                if !flag_restored { result["flagRestorationDeferred"] = json!(true); }
                return result;
            }

            if profile.is_empty() {
                if before_limit != 0 {
                    if !api.write(FRAME_LIMIT_PROPERTY, 0) || api.read(FRAME_LIMIT_PROPERTY) != Some(0) {
                        return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimit could not be disabled"});
                    }
                    changed = true;
                }
                if let Some(denominator) = before_denominator.filter(|value| *value != 1) {
                    if !api.write(FRAME_LIMIT_DENOMINATOR_PROPERTY, 1) || api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY) != Some(1) {
                        return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimitDenominator could not be reset"});
                    }
                    let _ = denominator;
                    changed = true;
                }
                if changed { api.save(&profile); }
                let has_active_game = inner.active.iter().any(|active| !active.is_empty());
                let preserve = has_active_game || api.has_game_limit();
                if preserve && inner.flag_snapshot.is_none() {
                    inner.flag_snapshot = Some(FlagSnapshot { previous_enabled: before_enabled });
                }
                inner.active.remove(GLOBAL_PROFILE);
                let flag_restored = if preserve {
                    if !api.set_enabled(true) {
                        return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS limiter flag could not be kept enabled for saved game caps"});
                    }
                    false
                } else {
                    match Self::restore_flag_if_idle(inner, api) {
                        Ok(value) => value,
                        Err(error) => return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": error}),
                    }
                };
                if changed { api.update(); }
                let observed = Self::read_global(api);
                let expected = observed.unwrap_or(RawState { limit: 0, denominator: None, limiter_enabled: before_enabled });
                let token = snapshot.map(|snapshot| Self::restore_token(&snapshot, expected));
                inner.snapshots.remove(GLOBAL_PROFILE);
                let mut result = json!({
                    "ok": true, "used": true, "source": "rtss", "profile": profile,
                    "enabled": false, "value": 0, "changed": changed,
                    "observedState": observed.map(|state| state_json(&state)),
                    "restoreToken": token,
                    "flagRestored": flag_restored,
                });
                if preserve || !flag_restored { result["flagRestorationDeferred"] = json!(true); }
                return result;
            }

            if let Some(snapshot) = snapshot.clone() {
                let matches_desired = before_limit == snapshot.desired_limit
                    && snapshot.desired_denominator.is_none_or(|denominator| before_denominator == Some(denominator));
                if matches_desired {
                    if snapshot.existed {
                        if snapshot.previous.limit != before_limit {
                            if !api.write(FRAME_LIMIT_PROPERTY, snapshot.previous.limit) || api.read(FRAME_LIMIT_PROPERTY) != Some(snapshot.previous.limit) {
                                return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimit could not be restored"});
                            }
                            changed = true;
                        }
                        if let Some(previous) = snapshot.previous.denominator.filter(|previous| before_denominator != Some(*previous)) {
                            if !api.write(FRAME_LIMIT_DENOMINATOR_PROPERTY, previous) || api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY) != Some(previous) {
                                return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimitDenominator could not be restored"});
                            }
                            changed = true;
                        }
                        if changed { api.save(&profile); }
                    } else if snapshot.created && !api.delete_verified(&profile) {
                        return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS profile deletion could not be verified"});
                    }
                } else if snapshot.previous.limit != before_limit {
                    if !api.write(FRAME_LIMIT_PROPERTY, snapshot.previous.limit) || api.read(FRAME_LIMIT_PROPERTY) != Some(snapshot.previous.limit) {
                        return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": "RTSS FramerateLimit could not be restored"});
                    }
                    changed = true;
                    api.save(&profile);
                }
                inner.snapshots.remove(&profile);
            }
            inner.active.remove(&profile);
            let flag_restored = match Self::restore_flag_if_idle(inner, api) {
                Ok(value) => value,
                Err(error) => return json!({"ok": false, "used": false, "fallback": true, "source": "igcl", "profile": profile, "error": error}),
            };
            if changed || flag_restored { api.update(); }
            let observed = Self::read_global(api);
            let mut result = json!({
                "ok": true, "used": true, "source": "rtss", "profile": profile,
                "enabled": false, "value": 0, "changed": changed,
                "observedState": observed.map(|state| state_json(&state)),
                "restoreToken": snapshot.map(|snapshot| Self::restore_token(&snapshot, observed.unwrap_or(snapshot.previous))),
                "flagRestored": flag_restored,
            });
            if !flag_restored { result["flagRestorationDeferred"] = json!(true); }
            result
        });
        result.unwrap_or_else(|error| json!({
            "ok": false, "used": false, "fallback": true, "source": "igcl", "error": error,
        }))
    }

    fn read_profile(api: &dyn ProfileApi, profile: &str) -> Option<RawState> {
        api.load(profile);
        Some(RawState {
            limit: api.read(FRAME_LIMIT_PROPERTY)?,
            denominator: api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY),
            limiter_enabled: (api.flags() & LIMITER_DISABLED_FLAG) == 0,
        })
    }

    pub fn restore_frame_limit(&self, token: &Value) -> Value {
        let Some(profile) = token.get("profile").and_then(Value::as_str).map(str::to_owned) else {
            return json!({"ok": false, "used": false, "error": "RTSS frame-limit rollback token is unavailable"});
        };
        let expected = parse_state(&json!({
            "limit": token.get("expectedLimit").cloned().unwrap_or(Value::Null),
            "denominator": token.get("expectedDenominator").cloned().unwrap_or(Value::Null),
            "limiterEnabled": token.get("expectedEnabled").cloned().unwrap_or(Value::Null),
        }));
        let Some(expected) = expected else {
            return json!({"ok": false, "used": false, "error": "RTSS frame-limit rollback token is unavailable"});
        };
        let previous = parse_state(&json!({
            "limit": token.get("previousLimit").cloned().unwrap_or(Value::Null),
            "denominator": token.get("previousDenominator").cloned().unwrap_or(Value::Null),
            "limiterEnabled": token.get("previousEnabled").cloned().unwrap_or(Value::Null),
        }));
        let Some(previous) = previous else {
            return json!({"ok": false, "used": false, "error": "RTSS frame-limit rollback token is unavailable"});
        };
        let existed = token.get("existed").and_then(Value::as_bool) == Some(true);
        let created = token.get("created").and_then(Value::as_bool) == Some(true);
        let result = self.with_api(|inner, api| {
            let Some(observed) = Self::read_profile(api, &profile) else {
                return json!({"ok": false, "used": false, "error": "RTSS frame-limit state could not be read"});
            };
            if observed != expected {
                return json!({
                    "ok": false, "used": false, "conflict": true,
                    "error": "RTSS profile changed outside Arc Power; rollback was not verified",
                    "observedState": state_json(&observed), "expectedState": state_json(&expected),
                });
            }
            let mut changed = false;
            if previous.limit != observed.limit {
                if !api.write(FRAME_LIMIT_PROPERTY, previous.limit) || api.read(FRAME_LIMIT_PROPERTY) != Some(previous.limit) {
                    return json!({"ok": false, "used": false, "error": "RTSS FramerateLimit could not be restored"});
                }
                changed = true;
            }
            if let Some(denominator) = previous.denominator.filter(|previous| observed.denominator != Some(*previous)) {
                if !api.write(FRAME_LIMIT_DENOMINATOR_PROPERTY, denominator) || api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY) != Some(denominator) {
                    return json!({"ok": false, "used": false, "error": "RTSS FramerateLimitDenominator could not be restored"});
                }
                changed = true;
            }
            if changed && existed { api.save(&profile); }
            if created && !profile.is_empty() && !api.delete_verified(&profile) {
                return json!({"ok": false, "used": false, "error": "RTSS profile deletion could not be verified"});
            }
            inner.active.remove(&profile);
            inner.snapshots.remove(&profile);
            let flag_restored = match Self::restore_flag_if_idle(inner, api) {
                Ok(value) => value,
                Err(error) => return json!({"ok": false, "used": false, "error": error}),
            };
            if changed || flag_restored { api.update(); }
            json!({"ok": true, "used": true, "source": "rtss", "profile": profile, "changed": changed, "restored": true, "flagRestored": flag_restored})
        });
        result.unwrap_or_else(|error| json!({"ok": false, "used": false, "error": error}))
    }

    pub fn restore_frame_limit_state(&self, options: &Value) -> Value {
        let Some(expected) = options.get("expectedState").and_then(parse_state) else {
            return json!({"ok": false, "used": false, "conflict": false, "errorCode": "invalid-state", "error": "A valid expectedState and state are required"});
        };
        let Some(target) = options.get("state").and_then(parse_state) else {
            return json!({"ok": false, "used": false, "conflict": false, "errorCode": "invalid-state", "error": "A valid expectedState and state are required"});
        };
        let retain = options.get("retainOwnership").and_then(Value::as_bool) == Some(true);
        let result = self.with_api(|inner, api| {
            let Some(observed) = Self::read_global(api) else {
                return json!({"ok": false, "used": false, "errorCode": "unavailable", "error": "RTSS global frame-limit state could not be read"});
            };
            if observed != expected {
                return json!({
                    "ok": false, "used": false, "conflict": true, "errorCode": "external-change",
                    "observedState": state_json(&observed), "expectedState": state_json(&expected),
                    "error": "RTSS global frame-limit state changed outside Arc Power",
                });
            }
            let has_active_game = inner.active.iter().any(|profile| !profile.is_empty());
            let persisted_game = !target.limiter_enabled && !has_active_game && api.has_game_limit();
            let Some(observed_after_scan) = Self::read_global(api) else {
                return json!({"ok": false, "used": false, "errorCode": "unavailable", "error": "RTSS global frame-limit state could not be read after profile scan"});
            };
            if observed_after_scan != expected {
                return json!({
                    "ok": false, "used": false, "conflict": true, "errorCode": "external-change",
                    "observedState": state_json(&observed_after_scan), "expectedState": state_json(&expected),
                    "error": "RTSS global frame-limit state changed outside Arc Power",
                });
            }
            let mut changed = false;
            if observed.limit != target.limit {
                if !api.write(FRAME_LIMIT_PROPERTY, target.limit) || api.read(FRAME_LIMIT_PROPERTY) != Some(target.limit) {
                    return json!({"ok": false, "used": false, "errorCode": "restore-failed", "error": "RTSS FramerateLimit recovery could not be verified"});
                }
                changed = true;
            }
            if observed.denominator != target.denominator {
                let Some(denominator) = target.denominator else {
                    return json!({"ok": false, "used": false, "errorCode": "restore-failed", "error": "RTSS FramerateLimitDenominator is not writable"});
                };
                if !api.write(FRAME_LIMIT_DENOMINATOR_PROPERTY, denominator) || api.read(FRAME_LIMIT_DENOMINATOR_PROPERTY) != Some(denominator) {
                    return json!({"ok": false, "used": false, "errorCode": "restore-failed", "error": "RTSS FramerateLimitDenominator recovery could not be verified"});
                }
                changed = true;
            }
            if changed { api.save(GLOBAL_PROFILE); }
            let preserve = !target.limiter_enabled && (has_active_game || persisted_game);
            let desired_enabled = if preserve { true } else { target.limiter_enabled };
            let flag_changed = observed.limiter_enabled != desired_enabled;
            if !api.set_enabled(desired_enabled) {
                return json!({"ok": false, "used": false, "errorCode": "restore-failed", "error": "RTSS limiter flag recovery could not be verified"});
            }
            let final_state = Self::read_global(api);
            let expected_final = RawState { limiter_enabled: desired_enabled, ..target };
            if final_state != Some(expected_final) {
                return json!({"ok": false, "used": false, "errorCode": "restore-failed", "observedState": final_state.map(|state| state_json(&state)), "error": "RTSS global frame-limit recovery read-back did not match"});
            }
            if changed || flag_changed { api.update(); }
            let retained = retain && target.limiter_enabled && target.limit > 0 && inner.snapshots.contains_key(GLOBAL_PROFILE);
            if retained {
                if let Some(snapshot) = inner.snapshots.get_mut(GLOBAL_PROFILE) {
                    snapshot.desired_limit = target.limit;
                    snapshot.desired_denominator = target.denominator;
                }
                inner.active.insert(GLOBAL_PROFILE.to_owned());
            } else {
                inner.snapshots.remove(GLOBAL_PROFILE);
                inner.active.remove(GLOBAL_PROFILE);
            }
            if !preserve && !retained && inner.active.is_empty() { inner.flag_snapshot = None; }
            let mut result = json!({
                "ok": true, "used": true, "source": "rtss", "restored": true, "changed": changed,
                "flagRestored": !preserve && !retained,
                "observedState": final_state.map(|state| state_json(&state)),
            });
            if retained { result["ownershipRetained"] = json!(true); }
            if preserve { result["flagRestorationDeferred"] = json!(true); }
            result
        });
        result.unwrap_or_else(|error| json!({"ok": false, "used": false, "errorCode": "unavailable", "error": error}))
    }

    pub fn ensure_sharpening_compatibility(&self) -> Value {
        self.with_api(|_inner, api| {
            let Some(profiles) = api.profiles() else {
                return json!({"ok": false, "available": true, "configured": false, "error": "RTSS profiles could not be enumerated safely"});
            };
            let key = SHARPENING_COMPATIBILITY_PROFILE.to_ascii_lowercase();
            if profiles.contains(&key) {
                api.load(SHARPENING_COMPATIBILITY_PROFILE);
                return if api.read(FRAME_LIMIT_PROPERTY) == Some(0) {
                    json!({"ok": true, "available": true, "configured": true, "profile": SHARPENING_COMPATIBILITY_PROFILE})
                } else {
                    json!({"ok": false, "available": true, "configured": false, "conflict": true, "error": format!("RTSS profile {SHARPENING_COMPATIBILITY_PROFILE} already exists with a nonzero or unreadable frame limit; it was left unchanged")})
                };
            }
            api.load(GLOBAL_PROFILE);
            if !api.write(FRAME_LIMIT_PROPERTY, 0) {
                return json!({"ok": false, "available": true, "configured": false, "error": "RTSS sharpening compatibility frame limit could not be set"});
            }
            if api.profiles().is_some_and(|profiles| profiles.contains(&key)) {
                return json!({"ok": false, "available": true, "configured": false, "conflict": true, "error": format!("RTSS profile {SHARPENING_COMPATIBILITY_PROFILE} appeared during setup; no profile was saved")});
            }
            api.save(SHARPENING_COMPATIBILITY_PROFILE);
            api.update();
            api.load(SHARPENING_COMPATIBILITY_PROFILE);
            let saved = api.read(FRAME_LIMIT_PROPERTY);
            api.load(GLOBAL_PROFILE);
            if saved != Some(0) {
                return json!({"ok": false, "available": true, "configured": false, "error": "RTSS sharpening compatibility profile read-back did not confirm FramerateLimit=0"});
            }
            json!({"ok": true, "available": true, "configured": true, "profile": SHARPENING_COMPATIBILITY_PROFILE})
        }).unwrap_or_else(|error| {
            if error == "RTSS is not running" {
                json!({"ok": true, "available": false, "configured": false, "error": Value::Null})
            } else {
                json!({"ok": false, "available": false, "configured": false, "error": error})
            }
        })
    }
}

impl Default for RtssProfileController {
    fn default() -> Self { Self::new() }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct FakeState {
        current: String,
        values: HashMap<String, HashMap<String, u32>>,
        flags: u32,
        enumerate: bool,
        fail_next_enable: bool,
    }

    struct FakeApi {
        state: Mutex<FakeState>,
    }

    impl FakeApi {
        fn new(global: &[(&str, u32)], saved: &[(&str, &[(&str, u32)])]) -> Self {
            let mut values = HashMap::new();
            values.insert(GLOBAL_PROFILE.to_owned(), global.iter().map(|(key, value)| ((*key).to_owned(), *value)).collect());
            for (profile, entries) in saved {
                values.insert((*profile).to_owned(), entries.iter().map(|(key, value)| ((*key).to_owned(), *value)).collect());
            }
            Self { state: Mutex::new(FakeState { current: GLOBAL_PROFILE.to_owned(), values, flags: 0, enumerate: true, fail_next_enable: false }) }
        }
        fn limit(&self, profile: &str) -> Option<u32> {
            self.state.lock().unwrap().values.get(profile)?.get(FRAME_LIMIT_PROPERTY).copied()
        }
        fn set_limit(&self, profile: &str, value: u32) {
            self.state.lock().unwrap().values.get_mut(profile).unwrap().insert(FRAME_LIMIT_PROPERTY.into(), value);
        }
        fn value(&self, profile: &str, property: &str) -> Option<u32> {
            self.state.lock().unwrap().values.get(profile)?.get(property).copied()
        }
        fn has_profile(&self, profile: &str) -> bool {
            self.state.lock().unwrap().values.contains_key(profile)
        }
        fn enabled(&self) -> bool {
            self.state.lock().unwrap().flags & LIMITER_DISABLED_FLAG == 0
        }
        fn fail_next_enable(&self) {
            self.state.lock().unwrap().fail_next_enable = true;
        }
    }

    impl ProfileApi for FakeApi {
        fn load(&self, profile: &str) { self.state.lock().unwrap().current = profile.to_owned(); }
        fn save(&self, profile: &str) {
            let mut state = self.state.lock().unwrap();
            let current = state.current.clone();
            let values = state.values.get(&current).cloned().unwrap_or_default();
            state.values.insert(profile.to_owned(), values);
        }
        fn update(&self) {}
        fn read(&self, property: &str) -> Option<u32> {
            let state = self.state.lock().unwrap();
            state.values.get(&state.current).and_then(|values| values.get(property).copied())
                .or_else(|| match property {
                    FRAME_LIMIT_PROPERTY => Some(0),
                    FRAME_LIMIT_DENOMINATOR_PROPERTY => Some(1),
                    _ => None,
                })
        }
        fn write(&self, property: &str, value: u32) -> bool {
            let mut state = self.state.lock().unwrap();
            let current = state.current.clone();
            state.values.entry(current).or_default().insert(property.to_owned(), value);
            true
        }
        fn flags(&self) -> u32 { self.state.lock().unwrap().flags }
        fn set_enabled(&self, enabled: bool) -> bool {
            let mut state = self.state.lock().unwrap();
            if state.fail_next_enable {
                state.fail_next_enable = false;
                return false;
            }
            if enabled { state.flags &= !LIMITER_DISABLED_FLAG; } else { state.flags |= LIMITER_DISABLED_FLAG; }
            true
        }
        fn profiles(&self) -> Option<HashSet<String>> {
            let state = self.state.lock().unwrap();
            if !state.enumerate { return None; }
            Some(state.values.keys().filter(|key| !key.is_empty()).map(|key| key.to_ascii_lowercase()).collect())
        }
        fn delete_verified(&self, profile: &str) -> bool {
            let mut state = self.state.lock().unwrap();
            state.values.remove(profile);
            if state.current == profile { state.current = GLOBAL_PROFILE.to_owned(); }
            !state.values.contains_key(profile)
        }
        fn has_game_limit(&self) -> bool {
            let state = self.state.lock().unwrap();
            state.values.iter().any(|(profile, values)| !profile.is_empty() && values.get(FRAME_LIMIT_PROPERTY).is_some_and(|limit| *limit > 0))
        }
    }

    fn global_fake() -> Arc<FakeApi> {
        Arc::new(FakeApi::new(&[(FRAME_LIMIT_PROPERTY, 0), (FRAME_LIMIT_DENOMINATOR_PROPERTY, 1)], &[]))
    }

    #[test]
    fn profile_names_and_state_parsing_are_bounded() {
        assert_eq!(basename(Some(r"C:\Games\Game.exe")), "Game.exe");
        assert_eq!(basename(Some("C:/Games/Game.exe")), "Game.exe");
        assert_eq!(basename(Some("")), "");
        assert_eq!(basename(None), "");
        assert_eq!(parse_state(&json!({"limit": 60, "denominator": null, "limiterEnabled": true})).unwrap().limit, 60);
        assert!(parse_state(&json!({"limit": -1, "denominator": 1, "limiterEnabled": true})).is_none());
        assert!(parse_state(&json!({"limit": 60, "denominator": "1", "limiterEnabled": true})).is_none());
        assert!(parse_state(&json!({"limit": 60, "limiterEnabled": true})).is_none());
    }

    #[test]
    fn fake_global_limit_enables_and_restores_the_previous_state() {
        let fake = global_fake();
        let controller = RtssProfileController::with_fake(fake.clone());
        let applied = controller.apply_frame_limit(&json!({"enabled": true, "value": 90}));
        assert_eq!(applied["ok"], true);
        assert_eq!(applied["used"], true);
        assert_eq!(fake.limit(GLOBAL_PROFILE), Some(90));
        assert!(fake.enabled());
        let restored = controller.restore_frame_limit(&applied["restoreToken"]);
        assert_eq!(restored["ok"], true);
        assert_eq!(fake.limit(GLOBAL_PROFILE), Some(0));
        assert!(fake.enabled());
        assert_eq!(restored["flagRestored"], true);
    }

    #[test]
    fn fake_conditional_apply_fails_closed_on_external_edits() {
        let fake = Arc::new(FakeApi::new(&[(FRAME_LIMIT_PROPERTY, 30), (FRAME_LIMIT_DENOMINATOR_PROPERTY, 1)], &[]));
        let controller = RtssProfileController::with_fake(fake.clone());
        let result = controller.apply_frame_limit(&json!({
            "enabled": true,
            "value": 60,
            "expectedState": {"limit": 60, "denominator": 1, "limiterEnabled": true},
        }));
        assert_eq!(result["ok"], false);
        assert_eq!(result["conflict"], true);
        assert_eq!(result["errorCode"], "external-change");
        assert_eq!(fake.limit(GLOBAL_PROFILE), Some(30));
    }

    #[test]
    fn fake_failed_enable_rolls_back_the_profile_write() {
        let fake = global_fake();
        let controller = RtssProfileController::with_fake(fake.clone());
        fake.fail_next_enable();
        let result = controller.apply_frame_limit(&json!({"enabled": true, "value": 60}));
        assert_eq!(result["ok"], false);
        assert_eq!(result["cleanupPending"], Value::Null);
        assert_eq!(fake.limit(GLOBAL_PROFILE), Some(0));
        assert!(fake.enabled());
    }

    #[test]
    fn fake_created_game_profile_is_removed_after_restore() {
        let fake = global_fake();
        let controller = RtssProfileController::with_fake(fake.clone());
        let applied = controller.apply_frame_limit(&json!({
            "enabled": true, "value": 60, "executablePath": "C:\\Games\\Game.exe",
        }));
        assert_eq!(applied["ok"], true);
        assert_eq!(fake.limit("Game.exe"), Some(60));
        assert!(fake.has_profile("Game.exe"));
        let restored = controller.restore_frame_limit(&applied["restoreToken"]);
        assert_eq!(restored["ok"], true);
        assert!(!fake.has_profile("Game.exe"));
        assert_eq!(fake.limit(GLOBAL_PROFILE), Some(0));
    }

    #[test]
    fn fake_external_edit_blocks_token_restore() {
        let fake = global_fake();
        let controller = RtssProfileController::with_fake(fake.clone());
        let applied = controller.apply_frame_limit(&json!({"enabled": true, "value": 60}));
        fake.set_limit(GLOBAL_PROFILE, 45);
        let restored = controller.restore_frame_limit(&applied["restoreToken"]);
        assert_eq!(restored["ok"], false);
        assert_eq!(restored["conflict"], true);
        assert_eq!(fake.limit(GLOBAL_PROFILE), Some(45));
    }

    #[test]
    fn fake_osd_profile_restores_only_values_it_changed() {
        let fake = Arc::new(FakeApi::new(&[
            ("Implementation", 2), ("AppDetectionLevel", 0), ("EnableOSD", 0),
        ], &[]));
        let controller = RtssProfileController::with_fake(fake.clone());
        let enabled = controller.apply(&json!({"enabled": true}));
        assert_eq!(enabled["configured"], true);
        assert_eq!(fake.value(GLOBAL_PROFILE, "Implementation"), Some(1));
        assert_eq!(fake.value(GLOBAL_PROFILE, "AppDetectionLevel"), Some(1));
        assert_eq!(fake.value(GLOBAL_PROFILE, "EnableOSD"), Some(1));
        let disabled = controller.apply(&json!({"enabled": false}));
        assert_eq!(disabled["configured"], false);
        assert_eq!(fake.value(GLOBAL_PROFILE, "Implementation"), Some(2));
        assert_eq!(fake.value(GLOBAL_PROFILE, "AppDetectionLevel"), Some(0));
        assert_eq!(fake.value(GLOBAL_PROFILE, "EnableOSD"), Some(0));
    }

    #[test]
    fn fake_state_discovers_an_already_running_rtss_without_writes() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let controller = RtssProfileController::new();
        controller.inner.lock().unwrap().assume_running = true;
        let opens = AtomicUsize::new(0);
        let fake: Arc<dyn ProfileApi> = global_fake();
        let state = controller.with_api_using(RtssProfileController::state_value, || {
            opens.fetch_add(1, Ordering::SeqCst);
            Some(fake)
        }).unwrap();
        assert_eq!(state["available"], true);
        assert_eq!(state["configured"], false);
        assert_eq!(opens.load(Ordering::SeqCst), 1, "an uninitialized controller must attempt API discovery");
        assert!(controller.inner.lock().unwrap().api.is_some());
    }

    #[test]
    fn unavailable_controller_reports_igcl_fallback() {
        let controller = RtssProfileController::new();
        let state = controller.get_frame_limit(&json!({}));
        if state["ok"] != true { assert_eq!(state["source"], "igcl"); }
        let ownership = controller.get_ownership();
        if ownership["ok"] != true { assert_eq!(ownership["errorCode"], "unavailable"); }
    }
}
