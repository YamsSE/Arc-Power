//! Production adapters for the native Arc Sleep controller.
//!
//! The controller ([`super::arc_sleep_controller`]) is deliberately seam-based:
//! it owns the persisted Base Cap, the recovery journal and every decision,
//! while this module supplies the real clock, policy inputs and limiter
//! providers. Nothing here writes the Base Cap or the journal - only
//! [`super::arc_sleep_controller::ArcSleepController`] does that.
//!
//! RTSS goes through the single RTSS writer (`RtssProfileController`); the IGCL
//! fallback goes through the native Graphics frame-limit helpers, which reuse
//! that module's capability validation. A policy input the host cannot observe
//! stays `None`; this module never invents a sample.
use super::arc_sleep_controller::{ArcSleepController, ArcSleepStore, Clock, PolicySampler, Sample};
use super::arc_sleep_limiter::LimiterIo;
use super::native_store::NativeStore;
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};
use std::time::Instant;

/// Monotonic milliseconds for the controller cadence and the availability
/// throttle. Unrelated to wall-clock time, and never goes backwards.
pub struct SystemClock {
    origin: Instant,
}

impl SystemClock {
    pub fn new() -> Self { Self { origin: Instant::now() } }
}

impl Default for SystemClock {
    fn default() -> Self { Self::new() }
}

impl Clock for SystemClock {
    fn now_ms(&self) -> f64 { self.origin.elapsed().as_secs_f64() * 1000.0 }
}

/// What the host can observe for the policy without owning any provider state.
/// Implemented by the Tauri host over `TelemetryHub` and the RTSS OSD hub.
pub trait SleepEnvironment: Send + Sync {
    /// The composed main telemetry sample for a device, if the renderer lane is
    /// running.
    fn latest_sample(&self, device_id: u64) -> Option<Value>;
    /// The native RTSS foreground rows (`pid`, `fps`, `frameTimeMs`, `api`).
    fn foreground_metrics(&self) -> Value;
}

/// `PolicySampler` over the host observations:
/// - idle time from `GetLastInputInfo`;
/// - load from the selected device's native telemetry sample (`gpuUtilPct`);
/// - observed FPS/process from the native RTSS foreground rows.
pub struct SystemSampler {
    store: Arc<NativeStore>,
    environment: Arc<dyn SleepEnvironment>,
}

impl SystemSampler {
    pub fn new(store: Arc<NativeStore>, environment: Arc<dyn SleepEnvironment>) -> Self {
        Self { store, environment }
    }

    fn selected_device_id(&self) -> Option<u64> {
        super::services::native_json(&self.store, "load-settings", json!([])).ok()
            .and_then(|settings| settings.get("deviceId").and_then(Value::as_u64))
    }
}

impl PolicySampler for SystemSampler {
    fn sample(&self) -> Sample {
        let load_percent = self.selected_device_id()
            .and_then(|device_id| self.environment.latest_sample(device_id))
            .and_then(|sample| sample.get("gpuUtilPct").and_then(Value::as_f64))
            .filter(|load| load.is_finite() && (0.0..=100.0).contains(load));
        let foreground = self.environment.foreground_metrics();
        let observed_fps = foreground.get("fps").and_then(Value::as_f64)
            .filter(|fps| fps.is_finite() && *fps > 0.0 && *fps <= 1000.0);
        let observed_process_id = foreground.get("pid").and_then(Value::as_u64);
        Sample {
            idle_ms: system_idle_ms(),
            load_percent,
            observed_fps,
            observed_process_id: observed_fps.and(observed_process_id),
        }
    }
}

#[cfg(windows)]
fn system_idle_ms() -> Option<f64> {
    use windows_sys::Win32::System::SystemInformation::GetTickCount64;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
    let mut info = LASTINPUTINFO {
        cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
        dwTime: 0,
    };
    if unsafe { GetLastInputInfo(&mut info) } == 0 { return None; }
    let now = unsafe { GetTickCount64() };
    Some(now.saturating_sub(u64::from(info.dwTime)) as f64)
}

#[cfg(not(windows))]
fn system_idle_ms() -> Option<f64> { None }

/// The RTSS global frame-limit writer seam. Production is the single
/// `RtssProfileController` owned by `NativeStore`.
pub trait RtssWriter: Send + Sync {
    fn ownership(&self) -> Value;
    fn apply(&self, options: &Value) -> Value;
    fn restore_state(&self, options: &Value) -> Value;
    fn restore_token(&self, token: &Value) -> Value;
}

/// The selected-adapter frame-limit writer seam. Production reuses the native
/// Graphics feature-2 path (device-scoped and gate-free).
pub trait IgclWriter: Send + Sync {
    fn read(&self, device_key: Option<&str>) -> Value;
    fn apply(&self, request: &Value) -> Value;
}

/// `LimiterIo` over the two provider owners. The controller keeps ownership of
/// the Base Cap and journal; this type only routes provider calls.
pub struct SystemLimiterIo<R: RtssWriter, I: IgclWriter> {
    rtss: R,
    igcl: I,
}

impl<R: RtssWriter, I: IgclWriter> SystemLimiterIo<R, I> {
    pub fn new(rtss: R, igcl: I) -> Self { Self { rtss, igcl } }
}

impl<R: RtssWriter, I: IgclWriter> LimiterIo for SystemLimiterIo<R, I> {
    fn rtss_ownership(&self) -> Value { self.rtss.ownership() }
    fn rtss_apply(&self, options: &Value) -> Value { self.rtss.apply(options) }
    fn rtss_restore_state(&self, options: &Value) -> Value { self.rtss.restore_state(options) }
    fn rtss_restore(&self, token: &Value) -> Value { self.rtss.restore_token(token) }
    fn igcl_read(&self, device_key: Option<&str>) -> Value { self.igcl.read(device_key) }
    fn igcl_apply(&self, request: &Value) -> Value { self.igcl.apply(request) }
}

struct StoreRtss(Arc<NativeStore>);

impl RtssWriter for StoreRtss {
    fn ownership(&self) -> Value { self.0.rtss_profile().get_ownership() }
    fn apply(&self, options: &Value) -> Value { self.0.rtss_profile().apply_frame_limit(options) }
    fn restore_state(&self, options: &Value) -> Value { self.0.rtss_profile().restore_frame_limit_state(options) }
    fn restore_token(&self, token: &Value) -> Value { self.0.rtss_profile().restore_frame_limit(token) }
}

struct StoreIgcl(Arc<NativeStore>);

impl IgclWriter for StoreIgcl {
    fn read(&self, device_key: Option<&str>) -> Value {
        super::graphics::sleep_frame_limit_read(&self.0, device_key)
    }
    fn apply(&self, request: &Value) -> Value {
        super::graphics::sleep_frame_limit_apply(&self.0, request)
    }
}

/// `ArcSleepStore` over the native settings store. Both methods are the native
/// owners, so a concurrent write can never be erased by a stale snapshot.
struct StoreSettings(Arc<NativeStore>);

impl ArcSleepStore for StoreSettings {
    fn load(&self) -> Result<Value, String> { self.0.settings_store().load_settings() }
    // The cadence adopts a policy change from the cached document: every policy
    // write in this process goes through `save_arc_sleep_state` /
    // `save_settings_with_arc_sleep`, which refresh this cache, so the tick does
    // not have to re-read the settings file while it holds the state lock.
    fn load_cached(&self) -> Option<Value> { self.0.settings_store().load_settings_sync().ok().flatten() }
    fn save(&self, patch: &Value) -> Result<(), String> { self.0.settings_store().save_arc_sleep_state(patch) }
}

/// The process-wide controller. Only the Tauri host installs it, and only for
/// an elevated, non-mock run: Electron remains the single owner elsewhere.
static CONTROLLER: OnceLock<Arc<ArcSleepController>> = OnceLock::new();

pub fn install(controller: Arc<ArcSleepController>) -> Result<(), String> {
    CONTROLLER.set(controller).map_err(|_| "The Arc Sleep controller is already installed".into())
}

pub fn controller() -> Option<&'static Arc<ArcSleepController>> { CONTROLLER.get() }

/// Build the production controller. The caller decides ownership (elevated
/// non-mock Tauri runs only) and installs it with [`install`].
pub fn system_controller(store: Arc<NativeStore>, environment: Arc<dyn SleepEnvironment>) -> Arc<ArcSleepController> {
    Arc::new(ArcSleepController::new(
        Box::new(SystemLimiterIo::new(StoreRtss(store.clone()), StoreIgcl(store.clone()))),
        Box::new(SystemSampler::new(store.clone(), environment)),
        Box::new(SystemClock::new()),
        Box::new(StoreSettings(store)),
    ))
}

/// Elevated is required for the native limiter writers.
#[cfg(windows)]
pub fn host_elevated() -> bool {
    unsafe { windows_sys::Win32::UI::Shell::IsUserAnAdmin() != 0 }
}

#[cfg(not(windows))]
pub fn host_elevated() -> bool { false }

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::arc_sleep_limiter::parse_raw_state;
    use std::sync::Mutex;

    #[derive(Default)]
    struct FakeRtss(Mutex<Vec<String>>);

    impl RtssWriter for FakeRtss {
        fn ownership(&self) -> Value {
            self.0.lock().unwrap().push("ownership".into());
            json!({"ok": true, "state": {"limit": 60, "denominator": 1, "limiterEnabled": true}})
        }
        fn apply(&self, _options: &Value) -> Value {
            self.0.lock().unwrap().push("apply".into());
            json!({"ok": true, "used": true, "observedState": {"limit": 90, "denominator": 1, "limiterEnabled": true}})
        }
        fn restore_state(&self, _options: &Value) -> Value {
            self.0.lock().unwrap().push("restore-state".into());
            json!({"ok": true, "observedState": {"limit": 60, "denominator": 1, "limiterEnabled": true}})
        }
        fn restore_token(&self, _token: &Value) -> Value {
            self.0.lock().unwrap().push("restore-token".into());
            json!({"ok": true})
        }
    }

    #[derive(Default)]
    struct FakeIgcl(Mutex<Vec<String>>);

    impl IgclWriter for FakeIgcl {
        fn read(&self, device_key: Option<&str>) -> Value {
            self.0.lock().unwrap().push(format!("read:{device_key:?}"));
            json!({"ok": true, "deviceKey": "gpu-a", "limit": 100, "denominator": 1, "limiterEnabled": true})
        }
        fn apply(&self, request: &Value) -> Value {
            self.0.lock().unwrap().push(format!("apply:{}", request.get("op").and_then(Value::as_str).unwrap_or("cap")));
            json!({"ok": true, "used": true, "observedState": request.get("state").cloned().unwrap_or(Value::Null)})
        }
    }

    #[test]
    fn limiter_io_routes_each_provider_to_its_owner() {
        let io = SystemLimiterIo::new(FakeRtss::default(), FakeIgcl::default());
        assert_eq!(io.rtss_ownership()["state"]["limit"], json!(60));
        assert_eq!(io.rtss_apply(&json!({}))["used"], json!(true));
        assert_eq!(io.rtss_restore_state(&json!({}))["ok"], json!(true));
        assert_eq!(io.rtss_restore(&json!({}))["ok"], json!(true));
        assert_eq!(io.igcl_read(Some("gpu-a"))["deviceKey"], json!("gpu-a"));
        assert_eq!(io.igcl_apply(&json!({"op": "restore"}))["ok"], json!(true));
        // RTSS calls never reach the IGCL seam and vice versa.
        assert_eq!(&*io.rtss.0.lock().unwrap(), &["ownership", "apply", "restore-state", "restore-token"]);
        assert_eq!(&*io.igcl.0.lock().unwrap(), &["read:Some(\"gpu-a\")", "apply:restore"]);
    }

    struct FakeEnvironment {
        sample: Option<Value>,
        foreground: Value,
        device: Option<u64>,
    }

    impl SleepEnvironment for FakeEnvironment {
        fn latest_sample(&self, device_id: u64) -> Option<Value> {
            if Some(device_id) == self.device { self.sample.clone() } else { None }
        }
        fn foreground_metrics(&self) -> Value { self.foreground.clone() }
    }

    fn sampler(environment: FakeEnvironment) -> SystemSampler {
        // The sampler only touches the settings store for the selected device.
        // Tests use a throwaway store root so no %APPDATA% data is read.
        let root = std::env::temp_dir().join(format!("arc-sleep-sampler-{:032x}", rand::random::<u128>()));
        std::fs::create_dir_all(&root).unwrap();
        let store = Arc::new(NativeStore::new(root, "advanced").unwrap());
        SystemSampler::new(store, Arc::new(environment))
    }

    #[test]
    fn sampler_keeps_unavailable_inputs_none() {
        let sampler = sampler(FakeEnvironment {
            sample: None,
            foreground: json!({"pid": Value::Null, "fps": Value::Null, "frameTimeMs": Value::Null, "api": Value::Null}),
            device: None,
        });
        let sample = sampler.sample();
        assert_eq!(sample.load_percent, None);
        assert_eq!(sample.observed_fps, None);
        assert_eq!(sample.observed_process_id, None);
    }

    #[test]
    fn sampler_reads_load_and_foreground_rows_without_fabricating() {
        let sampled = sampler(FakeEnvironment {
            sample: Some(json!({"gpuUtilPct": 87.5})),
            foreground: json!({"pid": 4242, "fps": 118.0, "frameTimeMs": 8.47, "api": "DX12"}),
            device: Some(3),
        });
        // Without a persisted selected device id the telemetry sample is never
        // attributed to a device, but the foreground rows still resolve.
        let sample = sampled.sample();
        assert_eq!(sample.load_percent, None);
        assert_eq!(sample.observed_fps, Some(118.0));
        assert_eq!(sample.observed_process_id, Some(4242));
        // Out-of-range provider values are dropped, never clamped or invented.
        let invalid = sampler(FakeEnvironment {
            sample: None,
            foreground: json!({"pid": 4242, "fps": 0.0}),
            device: None,
        }).sample();
        assert_eq!(invalid.load_percent, None);
        assert_eq!(invalid.observed_fps, None);
        assert_eq!(invalid.observed_process_id, None);
    }

    #[test]
    fn raw_state_parser_accepts_the_controller_provider_shape() {
        let state = parse_raw_state(&json!({"limit": 60, "denominator": null, "limiterEnabled": true})).unwrap();
        assert_eq!(state.limit, 60);
        assert_eq!(state.denominator, None);
    }
}
