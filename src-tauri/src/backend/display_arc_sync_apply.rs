//! Private transaction for one output's Intel Arc Sync profile (`vrrMode` or
//! the boolean Variable Refresh Rate control) and its custom refresh window.
//!
//! The transaction requires the shared Display guard, fresh adapter/output
//! identity proof, preserves the current timing fields, and verifies the
//! selected profile through a fresh GET.
//!
//! The custom-range arm (`arcSyncRange`) additionally admits only a window
//! computed from this machine: ControlLib's per-monitor window is the
//! authoritative base, and the display's own Windows mode list at the
//! resolution in use may only narrow it when its exact-label join succeeds. A
//! request outside that window is refused with `out-of-range` naming the real
//! bounds; it is never clamped. `null` is the defined restore: profile
//! RECOMMENDED with the monitor-reported window. Intel owns the window in
//! RECOMMENDED (it may report its own default, e.g. 90-180 Hz, regardless of
//! what was passed), so restore is verified on the profile alone; the window
//! the driver reports is carried as evidence, not treated as a mismatch.
//!
//! The frame-time bounds (`MaxFrameTimeIncreaseInUs` / `...Decrease...`) are
//! never computed here: they are read from the driver immediately before the
//! guarded SET and passed through unchanged.
//!
//! Wiring note for the composed `display:apply` plan (owned by
//! `backend/services.rs`): the plan needs one `NativeDisplayApplyField::
//! ArcSyncRange(ArcSyncRangeRequest)` step placed after the Variable Refresh
//! Rate step, `staged_field_supported` must require `arcSync.writable == true`
//! and `arcSync.rangeBounds != null`, and the step maps the result through
//! `arc_sync_apply_outcome`-style fields (`matched`, `readBackMinHz`,
//! `readBackMaxHz`). `arc_sync_range_request` below is that step's shape gate.

use super::{
    display_apply::{self, DisplayApplyTarget, DisplayOutputIdentity},
    display_lock::DisplayLockGuard,
    gpu_apply_identity::{self, ApplyIdentity},
    gpu_capabilities,
    gpu_devices,
    igcl_read_only::ReadOnlyIgcl,
};
use serde_json::Value;
use std::{
    ffi::c_void,
    path::PathBuf,
    thread,
    time::Duration,
};

/// The driver stores both refresh windows as f32 Hz. Two values this close are
/// the same window for every real refresh rate; anything larger would hide a
/// genuine driver clamp.
const REFRESH_HZ_EPSILON: f32 = 0.01;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArcSyncProfile {
    Recommended,
    Excellent,
    Good,
    Compatible,
    Off,
    Vesa,
    Custom,
}

impl ArcSyncProfile {
    pub(crate) fn from_name(value: &str) -> Option<Self> {
        match value {
            "recommended" => Some(Self::Recommended),
            "excellent" => Some(Self::Excellent),
            "good" => Some(Self::Good),
            "compatible" => Some(Self::Compatible),
            "off" => Some(Self::Off),
            "vesa" => Some(Self::Vesa),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }

    fn from_igcl(value: i32) -> Option<Self> {
        match value {
            1 => Some(Self::Recommended), 2 => Some(Self::Excellent), 3 => Some(Self::Good),
            4 => Some(Self::Compatible), 5 => Some(Self::Off), 6 => Some(Self::Vesa),
            7 => Some(Self::Custom), _ => None,
        }
    }

    fn igcl(self) -> i32 {
        match self {
            Self::Recommended => 1, Self::Excellent => 2, Self::Good => 3,
            Self::Compatible => 4, Self::Off => 5, Self::Vesa => 6, Self::Custom => 7,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Recommended => "recommended", Self::Excellent => "excellent", Self::Good => "good",
            Self::Compatible => "compatible", Self::Off => "off", Self::Vesa => "vesa",
            Self::Custom => "custom",
        }
    }

    pub(crate) fn igcl_value(self) -> i32 { self.igcl() }
}

/// A refresh window in Hz. Both bounds come from the driver or from the
/// display's own Windows mode list; nothing here is assumed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ArcSyncRefreshBounds {
    pub(crate) min_hz: f32,
    pub(crate) max_hz: f32,
}

impl ArcSyncRefreshBounds {
    /// `None` unless the window is finite and admits at least one custom range
    /// (`0 < min < max`). A degenerate window is not a usable control.
    pub(crate) fn new(min_hz: f32, max_hz: f32) -> Option<Self> {
        (min_hz.is_finite() && max_hz.is_finite() && min_hz > 0.0 && max_hz > min_hz)
            .then_some(Self { min_hz, max_hz })
    }

    fn contains(self, other: Self) -> bool {
        other.min_hz >= self.min_hz - REFRESH_HZ_EPSILON
            && other.max_hz <= self.max_hz + REFRESH_HZ_EPSILON
    }

    fn matches(self, min_hz: f32, max_hz: f32) -> bool {
        (self.min_hz - min_hz).abs() <= REFRESH_HZ_EPSILON
            && (self.max_hz - max_hz).abs() <= REFRESH_HZ_EPSILON
    }
}

/// What the `arcSyncRange` control asks for. `Restore` is the defined restore:
/// the driver's RECOMMENDED profile with the monitor-reported window.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ArcSyncRangeRequest {
    Custom(ArcSyncRefreshBounds),
    Restore,
}

impl ArcSyncRangeRequest {
    pub(crate) fn profile(self) -> ArcSyncProfile {
        match self {
            Self::Custom(_) => ArcSyncProfile::Custom,
            Self::Restore => ArcSyncProfile::Recommended,
        }
    }
}

/// Parse the public `arcSyncRange` control. `null` restores the driver window;
/// an exact `{minHz, maxHz}` object selects a custom range. Any other shape is
/// refused so the plan never guesses at a half-valid request.
pub(crate) fn arc_sync_range_request(value: &Value) -> Option<ArcSyncRangeRequest> {
    if value.is_null() { return Some(ArcSyncRangeRequest::Restore); }
    let object = value.as_object()?;
    if object.len() != 2 { return None; }
    let min_hz = object.get("minHz")?.as_f64()? as f32;
    let max_hz = object.get("maxHz")?.as_f64()? as f32;
    ArcSyncRefreshBounds::new(min_hz, max_hz).map(ArcSyncRangeRequest::Custom)
}

/// Exactly what one guarded SET writes. Frame-time bounds are deliberately not
/// part of this value: the driver's own values are read immediately before the
/// write and passed through unchanged.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ArcSyncWrite {
    profile: ArcSyncProfile,
    min_hz: f32,
    max_hz: f32,
}

impl ArcSyncWrite {
    fn preserving_range(profile: ArcSyncProfile, observed: ArcSyncProfileObservation) -> Self {
        Self { profile, min_hz: observed.min_refresh_hz(), max_hz: observed.max_refresh_hz() }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum ArcSyncRequest {
    Profile(ArcSyncProfile),
    Range(ArcSyncRangeRequest),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ArcSyncProfileObservation {
    profile: ArcSyncProfile,
    max_refresh_bits: u32,
    min_refresh_bits: u32,
    max_frame_time_increase_us: u32,
    max_frame_time_decrease_us: u32,
}

impl ArcSyncProfileObservation {
    fn from_driver(
        profile: i32,
        max_refresh_hz: f32,
        min_refresh_hz: f32,
        max_frame_time_increase_us: u32,
        max_frame_time_decrease_us: u32,
    ) -> Result<Self, String> {
        let profile = ArcSyncProfile::from_igcl(profile)
            .ok_or_else(|| "the driver returned an unknown Arc Sync profile".to_owned())?;
        if !max_refresh_hz.is_finite() || !min_refresh_hz.is_finite() || max_refresh_hz < min_refresh_hz {
            return Err("the driver returned an invalid Arc Sync refresh range".into());
        }
        Ok(Self {
            profile,
            max_refresh_bits: max_refresh_hz.to_bits(),
            min_refresh_bits: min_refresh_hz.to_bits(),
            max_frame_time_increase_us,
            max_frame_time_decrease_us,
        })
    }

    fn with_profile(self, profile: ArcSyncProfile) -> Self { Self { profile, ..self } }

    fn with_write(self, write: ArcSyncWrite) -> Self {
        Self {
            profile: write.profile,
            max_refresh_bits: write.max_hz.to_bits(),
            min_refresh_bits: write.min_hz.to_bits(),
            ..self
        }
    }

    fn max_refresh_hz(self) -> f32 { f32::from_bits(self.max_refresh_bits) }
    fn min_refresh_hz(self) -> f32 { f32::from_bits(self.min_refresh_bits) }
    fn range(self) -> ArcSyncRefreshBounds {
        ArcSyncRefreshBounds { min_hz: self.min_refresh_hz(), max_hz: self.max_refresh_hz() }
    }

    /// Profile-only parity: a sibling control may legitimately change the
    /// timing fields, exactly as Electron's profile read-back tolerates.
    fn matches_profile(self, requested: ArcSyncProfile) -> bool { self.profile == requested }

    /// Range parity: the profile and the exact window this transaction wrote.
    fn matches_write(self, write: ArcSyncWrite) -> bool {
        self.profile == write.profile && self.range().matches(write.min_hz, write.max_hz)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArcSyncApplyResult {
    pub(crate) ok: bool,
    pub(crate) error_code: Option<&'static str>,
    pub(crate) message: Option<String>,
    pub(crate) read_back: Option<ArcSyncProfile>,
    pub(crate) read_back_equal: bool,
    pub(crate) readback_reported: bool,
    /// `None` means this transaction declined before calling the setter.
    pub(crate) setter_succeeded: Option<bool>,
    pub(crate) state_may_have_changed: bool,
}

impl ArcSyncApplyResult {
    fn success(profile: ArcSyncProfile) -> Self {
        Self { ok: true, error_code: None, message: None, read_back: Some(profile),
            read_back_equal: true, readback_reported: true, setter_succeeded: Some(true),
            state_may_have_changed: false }
    }

    fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self { ok: false, error_code: Some(code), message: Some(message.into()), read_back: None,
            read_back_equal: false, readback_reported: false, setter_succeeded: None,
            state_may_have_changed: false }
    }
}

/// Structured evidence for one range transaction: what was asked for and what
/// the driver actually reported. `matched` is false for a driver clamp, and
/// the observed window is carried alongside the profile result so the caller
/// can report it without re-reading.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ArcSyncRangeEvidence {
    pub(crate) matched: bool,
    pub(crate) requested_min_hz: f32,
    pub(crate) requested_max_hz: f32,
    pub(crate) read_back_min_hz: f32,
    pub(crate) read_back_max_hz: f32,
}

/// The range entry point's result. The profile result shape is deliberately
/// unchanged so the existing `vrrMode` / Variable Refresh Rate response is
/// untouched.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ArcSyncRangeApplyResult {
    pub(crate) result: ArcSyncApplyResult,
    /// `None` when the transaction declined before any driver GET.
    pub(crate) evidence: Option<ArcSyncRangeEvidence>,
}

impl ArcSyncRangeApplyResult {
    pub(crate) fn ok(&self) -> bool { self.result.ok }
    pub(crate) fn error_code(&self) -> Option<&'static str> { self.result.error_code }
    pub(crate) fn message(&self) -> Option<&str> { self.result.message.as_deref() }
    pub(crate) fn setter_succeeded(&self) -> Option<bool> { self.result.setter_succeeded }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ArcSyncWriteOutcome {
    /// A target, capability, or pre-write check declined before calling SET.
    NotAttempted(String),
    /// SET was called. A reported failure is still closed to broker retry.
    Attempted {
        setter_succeeded: bool,
        error_code: Option<&'static str>,
        message: Option<String>,
    },
}

/// Each operation must resolve a fresh output handle from the pinned adapter
/// and display identities. `write_if_current` compares the full profile record
/// immediately before applying the requested profile and window.
pub(crate) trait ArcSyncApplyBackend {
    fn assert_device_target(&mut self, device_id: u64, expected_device_key: &str, proof: &Value) -> Result<(), String>;
    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String>;
    fn supported(&mut self, expected_device_key: &str, display_key: &str) -> Result<bool, String>;
    /// The full write contract: monitor support AND both profile symbols.
    fn writable(&mut self, expected_device_key: &str, display_key: &str) -> Result<bool, String>;
    /// ControlLib's monitor-reported window, before any intersection.
    fn monitor_window(
        &mut self,
        expected_device_key: &str,
        display_key: &str,
    ) -> Result<Option<ArcSyncRefreshBounds>, String>;
    /// The admitted custom window: ControlLib's monitor window, optionally
    /// narrowed by the display's own Windows mode list, computed from this
    /// machine's data.
    fn range_bounds(
        &mut self,
        expected_device_key: &str,
        display_key: &str,
    ) -> Result<Option<ArcSyncRefreshBounds>, String>;
    fn read_profile(&mut self, expected_device_key: &str, display_key: &str) -> Result<ArcSyncProfileObservation, String>;
    fn write_if_current(
        &mut self,
        expected_device_key: &str,
        display_key: &str,
        expected: ArcSyncProfileObservation,
        requested: ArcSyncWrite,
    ) -> ArcSyncWriteOutcome;
}

pub(crate) fn apply_arc_sync_profile(
    display_guard: &DisplayLockGuard,
    backend: &mut dyn ArcSyncApplyBackend,
    target: &DisplayApplyTarget<'_>,
    requested: ArcSyncProfile,
) -> ArcSyncApplyResult {
    apply_arc_sync_with_guard_state(
        display_guard.is_held(), backend, target, ArcSyncRequest::Profile(requested), &mut None,
    )
}

/// Apply one custom Arc Sync refresh window, or restore the driver's own
/// window (`Restore`). Admission requires the verified write contract and a
/// window computed from this machine; the request is refused, never clamped,
/// when it falls outside that window.
pub(crate) fn apply_arc_sync_range(
    display_guard: &DisplayLockGuard,
    backend: &mut dyn ArcSyncApplyBackend,
    target: &DisplayApplyTarget<'_>,
    requested: ArcSyncRangeRequest,
) -> ArcSyncRangeApplyResult {
    let mut evidence = None;
    let result = apply_arc_sync_with_guard_state(
        display_guard.is_held(), backend, target, ArcSyncRequest::Range(requested), &mut evidence,
    );
    ArcSyncRangeApplyResult { result, evidence }
}

/// The shared transaction. `evidence` is only ever filled by the read-back
/// verification of a range request; profile callers pass a throwaway slot so
/// their result shape stays unchanged.
fn apply_arc_sync_with_guard_state(
    guard_is_held: bool,
    backend: &mut dyn ArcSyncApplyBackend,
    target: &DisplayApplyTarget<'_>,
    request: ArcSyncRequest,
    evidence: &mut Option<ArcSyncRangeEvidence>,
) -> ArcSyncApplyResult {
    *evidence = None;
    if !guard_is_held {
        return ArcSyncApplyResult::failed("io-failed", "Arc Sync requires the shared Display transaction lock");
    }
    if target.device_key.trim().is_empty() || target.display_key.trim().is_empty()
        || !target.physical_target.is_object()
        || !display_apply::display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return ArcSyncApplyResult::failed("stale-target", "Arc Sync requires matching stable adapter and display identities");
    }
    if let Err((code, message)) = ensure_target(backend, target) {
        return ArcSyncApplyResult::failed(code, message);
    }
    match backend.supported(target.device_key, target.display_key) {
        Ok(true) => {}
        Ok(false) => return ArcSyncApplyResult::failed("unsupported", "Arc Sync profile control is not supported by this display"),
        Err(error) => return ArcSyncApplyResult::failed("io-failed", format!("Arc Sync capability read failed: {error}")),
    }

    // A range control needs the complete write contract: monitor support alone
    // would let the row appear and then fail. Decline before any read/write.
    let mut monitor_window = None;
    let mut admitted_bounds = None;
    if let ArcSyncRequest::Range(range_request) = request {
        match backend.writable(target.device_key, target.display_key) {
            Ok(true) => {}
            Ok(false) => return ArcSyncApplyResult::failed(
                "unsupported", "the Arc Sync profile setter is not available in this driver runtime",
            ),
            Err(error) => return ArcSyncApplyResult::failed(
                "io-failed", format!("Arc Sync write capability read failed: {error}"),
            ),
        }
        let bounds = match backend.range_bounds(target.device_key, target.display_key) {
            Ok(Some(bounds)) => bounds,
            Ok(None) => return ArcSyncApplyResult::failed(
                "io-failed",
                "the display did not report a refresh window this control can admit",
            ),
            Err(error) => return ArcSyncApplyResult::failed(
                "io-failed", format!("Arc Sync refresh bounds read failed: {error}"),
            ),
        };
        let window = match backend.monitor_window(target.device_key, target.display_key) {
            Ok(window) => window,
            Err(error) => return ArcSyncApplyResult::failed(
                "io-failed", format!("Arc Sync monitor window read failed: {error}"),
            ),
        };
        // A custom range is admitted by `bounds`, which can come from the
        // display's own mode list when Intel reports a degenerate 0-0 Hz window
        // despite claiming Arc Sync support. Restore uses the same fallback.
        if let ArcSyncRangeRequest::Custom(wanted) = range_request {
            if !ArcSyncRefreshBounds::new(wanted.min_hz, wanted.max_hz).is_some_and(|valid| valid == wanted) {
                return ArcSyncApplyResult::failed("out-of-range",
                    "the requested Arc Sync refresh range must be finite with 0 < minHz < maxHz");
            }
            if !bounds.contains(wanted) {
                return ArcSyncApplyResult::failed("out-of-range", format!(
                    "the requested {} Hz - {} Hz refresh range is outside this display's {} Hz - {} Hz window",
                    wanted.min_hz, wanted.max_hz, bounds.min_hz, bounds.max_hz,
                ));
            }
        }
        monitor_window = window;
        admitted_bounds = Some(bounds);
    }

    if let Err((code, message)) = ensure_target(backend, target) {
        return ArcSyncApplyResult::failed(code, message);
    }
    let current = match backend.read_profile(target.device_key, target.display_key) {
        Ok(value) => value,
        Err(error) => return ArcSyncApplyResult::failed("io-failed", format!("Arc Sync pre-write read failed: {error}")),
    };

    let write = match request {
        ArcSyncRequest::Profile(profile) => ArcSyncWrite::preserving_range(profile, current),
        ArcSyncRequest::Range(ArcSyncRangeRequest::Custom(wanted)) => ArcSyncWrite {
            profile: ArcSyncProfile::Custom, min_hz: wanted.min_hz, max_hz: wanted.max_hz,
        },
        ArcSyncRequest::Range(ArcSyncRangeRequest::Restore) => {
            // Intel owns the window in RECOMMENDED and may report its own
            // default regardless of what is passed. If the raw driver window is
            // unusable, pass the same per-display admitted window a custom
            // request would use; verification is on the profile alone.
            let window = monitor_window
                .or(admitted_bounds)
                .expect("a range request resolves at least one per-display window");
            ArcSyncWrite { profile: ArcSyncProfile::Recommended, min_hz: window.min_hz, max_hz: window.max_hz }
        }
    };

    if let Err((code, message)) = ensure_target(backend, target) {
        return ArcSyncApplyResult::failed(code, message);
    }

    let set_result = match backend.write_if_current(target.device_key, target.display_key, current, write) {
        ArcSyncWriteOutcome::NotAttempted(error) => {
            return ArcSyncApplyResult::failed("io-failed", format!("Arc Sync pre-write check failed: {error}"));
        }
        ArcSyncWriteOutcome::Attempted { setter_succeeded: false, error_code, message } => {
            let mut result = ArcSyncApplyResult::failed(
                error_code.unwrap_or("io-failed"),
                message.unwrap_or_else(|| "IGCL rejected the Arc Sync profile setter".into()),
            );
            result.setter_succeeded = Some(false);
            result.state_may_have_changed = true;
            return result;
        }
        ArcSyncWriteOutcome::Attempted { setter_succeeded: true, error_code: Some(code), message } => {
            let mut result = ArcSyncApplyResult::failed(
                code,
                message.unwrap_or_else(|| "The Arc Sync profile setter completed with a native error".into()),
            );
            result.setter_succeeded = Some(true);
            result.state_may_have_changed = true;
            return result;
        }
        ArcSyncWriteOutcome::Attempted { setter_succeeded: true, error_code: None, message: Some(message) } => {
            let mut result = ArcSyncApplyResult::failed("io-failed", message);
            result.setter_succeeded = Some(true);
            result.state_may_have_changed = true;
            return result;
        }
        ArcSyncWriteOutcome::Attempted { setter_succeeded: true, error_code: None, message: None } => true,
    };
    debug_assert!(set_result);
    if let Err((code, message)) = ensure_target(backend, target) {
        let mut result = ArcSyncApplyResult::failed(code, message);
        result.setter_succeeded = Some(true);
        result.state_may_have_changed = true;
        return result;
    }
    let read_back = match backend.read_profile(target.device_key, target.display_key) {
        Ok(value) => value,
        Err(error) => {
            let mut result = ArcSyncApplyResult::failed("io-failed", format!(
                "set succeeded but profile read-back failed: {error}",
            ));
            result.setter_succeeded = Some(true);
            result.readback_reported = true;
            result.state_may_have_changed = true;
            return result;
        }
    };
    let matched = match request {
        ArcSyncRequest::Profile(profile) => read_back.matches_profile(profile),
        // A custom window is ours: require the exact values we wrote. For
        // RECOMMENDED, Intel owns the window and can report its own default
        // (observed on a B580: 90-180 Hz after writing 48-180 Hz). Only the
        // profile is ours to verify; the observed window is reported as
        // evidence so the user still sees what the driver settled on.
        ArcSyncRequest::Range(ArcSyncRangeRequest::Custom(_)) => read_back.matches_write(write),
        ArcSyncRequest::Range(ArcSyncRangeRequest::Restore) => {
            read_back.matches_profile(ArcSyncProfile::Recommended)
        }
    };
    if let ArcSyncRequest::Range(_) = request {
        *evidence = Some(ArcSyncRangeEvidence {
            matched,
            requested_min_hz: write.min_hz,
            requested_max_hz: write.max_hz,
            read_back_min_hz: read_back.min_refresh_hz(),
            read_back_max_hz: read_back.max_refresh_hz(),
        });
    }
    if matched {
        let mut result = ArcSyncApplyResult::success(read_back.profile);
        result.state_may_have_changed = read_back != current;
        return result;
    }
    let primary = match request {
        ArcSyncRequest::Profile(profile) => format!(
            "read-back profile {} != requested {}", read_back.profile.name(), profile.name(),
        ),
        // Never claim success for a window the driver did not accept: name both
        // the requested and the observed values.
        ArcSyncRequest::Range(_) => format!(
            "the driver reported {} at {} Hz - {} Hz instead of {} at {} Hz - {} Hz",
            read_back.profile.name(), read_back.min_refresh_hz(), read_back.max_refresh_hz(),
            write.profile.name(), write.min_hz, write.max_hz,
        ),
    };
    let mut result = ArcSyncApplyResult::failed("io-failed", primary);
    result.read_back = Some(read_back.profile);
    result.read_back_equal = matched;
    result.readback_reported = true;
    result.setter_succeeded = Some(true);
    result.state_may_have_changed = read_back != current;
    result
}

fn ensure_target(
    backend: &mut dyn ArcSyncApplyBackend,
    target: &DisplayApplyTarget<'_>,
) -> Result<(), (&'static str, String)> {
    backend.assert_device_target(target.device_id, target.device_key, target.physical_target)
        .map_err(|error| ("stale-target", format!("the selected graphics adapter changed: {error}")))?;
    let outputs = backend.active_outputs(target.device_key)
        .map_err(|error| ("io-failed", format!("display output enumeration failed: {error}")))?;
    let matches: Vec<_> = outputs.iter().filter(|output| output.display_key == target.display_key).collect();
    match matches.as_slice() {
        [output] if output.active && output.identity_verified => Ok(()),
        [] => Err(("stale-target", "the selected display is no longer connected".into())),
        [_] => Err(("stale-target", "the selected display identity is not uniquely verified".into())),
        _ => Err(("ambiguous-target", "the selected display identity is ambiguous".into())),
    }
}

struct NativeArcSyncBackend<'guard> {
    display_guard: &'guard DisplayLockGuard,
    dll_path: PathBuf,
    identity: ApplyIdentity,
    selected_device_key: String,
    device_id: u64,
}

impl NativeArcSyncBackend<'_> {
    fn with_output<T>(
        &self,
        expected_device_key: &str,
        display_key: &str,
        operation: impl FnOnce(&mut ReadOnlyIgcl, *mut c_void) -> Result<T, String>,
    ) -> Result<T, String> {
        if !self.display_guard.is_held() { return Err("the shared Display transaction lock is no longer held".into()); }
        if expected_device_key != self.selected_device_key { return Err("the selected graphics adapter identity changed".into()); }
        let (mut session, index, device) = gpu_capabilities::open_for_identity(&self.dll_path, &self.identity)?;
        let result = (|| {
            let current = gpu_apply_identity::identity_from_row(&device)?;
            gpu_apply_identity::ensure_same_target(&self.identity, &current)?;
            let handle = display_apply::resolve_display_handle(&session, index, expected_device_key, display_key)?;
            operation(&mut session, handle)
        })();
        let close = session.close().map_err(|error| error.to_string());
        match (result, close) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(format!("IGCL session cleanup failed: {error}")),
            (Err(error), Err(close)) => Err(format!("{error}; IGCL session cleanup failed: {close}")),
        }
    }

    fn with_adapter<T>(
        &self,
        expected_device_key: &str,
        operation: impl FnOnce(&mut ReadOnlyIgcl, usize) -> Result<T, String>,
    ) -> Result<T, String> {
        if !self.display_guard.is_held() { return Err("the shared Display transaction lock is no longer held".into()); }
        if expected_device_key != self.selected_device_key { return Err("the selected graphics adapter identity changed".into()); }
        let (mut session, index, device) = gpu_capabilities::open_for_identity(&self.dll_path, &self.identity)?;
        let result = (|| {
            let current = gpu_apply_identity::identity_from_row(&device)?;
            gpu_apply_identity::ensure_same_target(&self.identity, &current)?;
            operation(&mut session, index)
        })();
        let close = session.close().map_err(|error| error.to_string());
        match (result, close) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), Ok(())) => Err(error),
            (Ok(_), Err(error)) => Err(format!("IGCL session cleanup failed: {error}")),
            (Err(error), Err(close)) => Err(format!("{error}; IGCL session cleanup failed: {close}")),
        }
    }
}

impl ArcSyncApplyBackend for NativeArcSyncBackend<'_> {
    fn assert_device_target(&mut self, device_id: u64, expected_device_key: &str, proof: &Value) -> Result<(), String> {
        if device_id != self.device_id { return Err("the selected graphics adapter ordinal changed".into()); }
        if expected_device_key != self.selected_device_key {
            return Err("the selected graphics adapter identity changed".into());
        }
        // PNP keys are accepted only after the one-time fresh-inventory alias
        // proof in `apply_arc_sync_profile_native`. Revalidate the immutable
        // physical proof against the canonical key captured from IGCL here.
        let normalized = display_apply::normalize_physical_target(&self.identity.device_key, proof)?;
        let supplied = gpu_apply_identity::identity_from_row(&normalized)?;
        gpu_apply_identity::ensure_same_target(&self.identity, &supplied)?;
        self.with_adapter(expected_device_key, |_, _| Ok(()))
    }

    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
        self.with_adapter(expected_device_key, |session, index| {
            display_apply::fresh_display_outputs(session, index, expected_device_key)
                .map(|outputs| outputs.into_iter().map(|(_, identity)| identity).collect())
        })
    }

    fn supported(&mut self, expected_device_key: &str, display_key: &str) -> Result<bool, String> {
        self.with_output(expected_device_key, display_key, |session, handle| {
            if !session.display_arc_sync_profile_control_available() { return Ok(false); }
            let monitor = session.display_arc_sync_monitor(handle)
                .ok_or_else(|| "ctlGetIntelArcSyncInfoForMonitor GET failed".to_owned())?;
            Ok(monitor.IsIntelArcSyncSupported != 0)
        })
    }

    fn writable(&mut self, expected_device_key: &str, display_key: &str) -> Result<bool, String> {
        self.with_output(expected_device_key, display_key, |session, handle| {
            // Both profile symbols and the full IGSC loader, the same condition
            // the renderer's `arcSync.writable` mirrors.
            if !session.display_arc_sync_profile_control_available() { return Ok(false); }
            let monitor = session.display_arc_sync_monitor(handle)
                .ok_or_else(|| "ctlGetIntelArcSyncInfoForMonitor GET failed".to_owned())?;
            Ok(monitor.IsIntelArcSyncSupported != 0)
        })
    }

    fn monitor_window(
        &mut self,
        expected_device_key: &str,
        display_key: &str,
    ) -> Result<Option<ArcSyncRefreshBounds>, String> {
        self.with_output(expected_device_key, display_key, |session, handle| {
            let monitor = session.display_arc_sync_monitor(handle)
                .ok_or_else(|| "ctlGetIntelArcSyncInfoForMonitor GET failed".to_owned())?;
            if monitor.IsIntelArcSyncSupported == 0 { return Ok(None); }
            Ok(ArcSyncRefreshBounds::new(
                monitor.MinimumRefreshRateInHz, monitor.MaximumRefreshRateInHz,
            ))
        })
    }

    fn range_bounds(
        &mut self,
        expected_device_key: &str,
        display_key: &str,
    ) -> Result<Option<ArcSyncRefreshBounds>, String> {
        let (monitor_min, monitor_max, label, resolution) = self.with_output(
            expected_device_key, display_key,
            |session, handle| {
                let monitor = session.display_arc_sync_monitor(handle)
                    .ok_or_else(|| "ctlGetIntelArcSyncInfoForMonitor GET failed".to_owned())?;
                let label = super::display::select_edid(&session.display_edid_blocks(handle))
                    .as_deref()
                    .and_then(super::display::monitor_name);
                let properties = session.display_properties(handle);
                let resolution = properties.as_ref()
                    .filter(|properties| super::display::plausible_timing(&properties.Display_Timing_Info))
                    .map(|properties| (
                        properties.Display_Timing_Info.HActive,
                        properties.Display_Timing_Info.VActive,
                    ));
                Ok((monitor.MinimumRefreshRateInHz, monitor.MaximumRefreshRateInHz, label, resolution))
            },
        )?;
        // This is a read-only User32 enumeration performed under the same
        // Display guard the transaction already holds; it writes nothing. It
        // can only narrow the driver window: if the inventory is missing or
        // its exact-label join fails, `arc_sync_range_bounds` keeps the
        // driver's own per-monitor window. This is the same rule `display:get`
        // uses, so the advertised row and the write path cannot disagree.
        let snapshot = super::windows_display_modes::read_windows_display_modes().ok();
        Ok(super::windows_display_modes::arc_sync_range_bounds(
            snapshot.as_ref(), label.as_deref(), resolution, monitor_min, monitor_max,
        ).and_then(|(min_hz, max_hz)| ArcSyncRefreshBounds::new(min_hz, max_hz)))
    }

    fn read_profile(&mut self, expected_device_key: &str, display_key: &str) -> Result<ArcSyncProfileObservation, String> {
        self.with_output(expected_device_key, display_key, |session, handle| {
            let value = session.display_arc_sync_profile(handle)
                .ok_or_else(|| "ctlGetIntelArcSyncProfile GET failed".to_owned())?;
            ArcSyncProfileObservation::from_driver(value.IntelArcSyncProfile,
                value.MaxRefreshRateInHz, value.MinRefreshRateInHz,
                value.MaxFrameTimeIncreaseInUs, value.MaxFrameTimeDecreaseInUs)
        })
    }

    fn write_if_current(
        &mut self,
        expected_device_key: &str,
        display_key: &str,
        expected: ArcSyncProfileObservation,
        requested: ArcSyncWrite,
    ) -> ArcSyncWriteOutcome {
        let mut setter_outcome = None;
        let operation = self.with_output(expected_device_key, display_key, |session, handle| {
            if !session.display_arc_sync_profile_control_available() {
                return Err("the Arc Sync profile setter is unavailable".into());
            }
            let current = session.display_arc_sync_profile(handle)
                .ok_or_else(|| "ctlGetIntelArcSyncProfile pre-write GET failed".to_owned())?;
            let current = ArcSyncProfileObservation::from_driver(current.IntelArcSyncProfile,
                current.MaxRefreshRateInHz, current.MinRefreshRateInHz,
                current.MaxFrameTimeIncreaseInUs, current.MaxFrameTimeDecreaseInUs)?;
            if current != expected { return Err("Arc Sync profile or timing changed before the guarded setter".into()); }
            let monitor = session.display_arc_sync_monitor(handle)
                .ok_or_else(|| "ctlGetIntelArcSyncInfoForMonitor pre-write GET failed".to_owned())?;
            if monitor.IsIntelArcSyncSupported == 0 { return Err("Arc Sync is no longer supported by this display".into()); }
            // The frame-time bounds are the driver's own values from the GET
            // that immediately precedes this SET; 0 stays 0. Only the profile
            // and the requested window are ever ours.
            let set_result = session.display_apply_api().set_arc_sync_profile(handle, requested.profile.igcl(),
                requested.max_hz, requested.min_hz,
                expected.max_frame_time_increase_us, expected.max_frame_time_decrease_us);
            match set_result {
                Ok(()) => {
                    setter_outcome = Some(ArcSyncWriteOutcome::Attempted {
                        setter_succeeded: true, error_code: None, message: None,
                    });
                    // Electron waits this long after a successful SET before
                    // the verification GET so the driver has time to settle.
                    thread::sleep(Duration::from_millis(400));
                    Ok(())
                }
                Err(error) => {
                    let error_code = error.status
                        .and_then(super::gpu_apply::igcl_error_code)
                        .unwrap_or("io-failed");
                    let message = error.status.map(|status| {
                        format!("IGCL {}", super::igcl_read_only::describe_pixel_transformation_result(status))
                    }).unwrap_or_else(|| format!("IGCL {error}"));
                    setter_outcome = Some(ArcSyncWriteOutcome::Attempted {
                        setter_succeeded: false, error_code: Some(error_code), message: Some(message),
                    });
                    Err(error.to_string())
                }
            }
        });
        match (operation, setter_outcome) {
            (Ok(()), Some(outcome)) => outcome,
            (Err(_), Some(outcome @ ArcSyncWriteOutcome::Attempted { setter_succeeded: false, .. })) => outcome,
            (Err(error), Some(ArcSyncWriteOutcome::Attempted { setter_succeeded: true, .. })) => {
                ArcSyncWriteOutcome::Attempted {
                    setter_succeeded: true,
                    error_code: Some("io-failed"),
                    message: Some(format!("IGCL session cleanup failed after Arc Sync SET: {error}")),
                }
            }
            (Err(error), Some(ArcSyncWriteOutcome::NotAttempted(_))) => ArcSyncWriteOutcome::NotAttempted(error),
            (Err(error), None) => ArcSyncWriteOutcome::NotAttempted(error),
            (Ok(()), None) => ArcSyncWriteOutcome::NotAttempted("the setter outcome is unavailable".into()),
        }
    }
}

fn selected_inventory_row<'a>(
    device_id: u64,
    inventory: &'a [Value],
) -> Result<(usize, &'a Value), String> {
    let matches: Vec<_> = inventory.iter().enumerate().filter(|(_, row)| {
        row["id"].as_u64() == Some(device_id)
            && row["synthetic"].as_bool() != Some(true)
            && row["backendKind"].as_str() != Some("os")
    }).collect();
    match matches.as_slice() {
        [(index, row)] => Ok((*index, *row)),
        [] => Err("the selected graphics adapter ordinal or identity changed".into()),
        _ => Err("the selected graphics adapter identity is ambiguous".into()),
    }
}

/// Resolve one fresh native Arc Sync backend for the pinned target, then run
/// the transaction. Both the profile and the range entry points share this
/// identity proof so they cannot drift.
fn with_native_arc_sync<T>(
    display_guard: &DisplayLockGuard,
    target: &DisplayApplyTarget<'_>,
    operation: impl FnOnce(&DisplayLockGuard, &mut NativeArcSyncBackend<'_>) -> T,
) -> Result<T, ArcSyncApplyResult> {
    if !display_guard.is_held() {
        return Err(ArcSyncApplyResult::failed("io-failed", "Arc Sync requires the shared Display transaction lock"));
    }
    if target.device_key.trim().is_empty() || target.display_key.trim().is_empty()
        || !display_apply::display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return Err(ArcSyncApplyResult::failed("stale-target", "Arc Sync requires matching stable adapter and display identities"));
    }
    let Some(dll_path) = super::display_igcl_dll::locate_dll() else {
        return Err(ArcSyncApplyResult::failed("io-failed", "The trusted Intel display runtime is unavailable."));
    };
    let inventory = match if target.device_key.starts_with("pnp:") {
        super::display_wire_format_apply::native_inventory_with_pnp(&dll_path).map(Value::Array)
    } else {
        gpu_devices::list_devices(&dll_path)
    } {
        Ok(value) => value,
        Err(error) => return Err(ArcSyncApplyResult::failed("stale-target", format!("native GPU identity refresh failed: {error}"))),
    };
    let Some(rows) = inventory.as_array() else {
        return Err(ArcSyncApplyResult::failed("stale-target", "native GPU inventory is unavailable"));
    };
    let (selected_index, selected_row) = match selected_inventory_row(target.device_id, rows) {
        Ok(value) => value,
        Err(error) => return Err(ArcSyncApplyResult::failed("stale-target", error)),
    };
    let normalized = match display_apply::normalize_physical_target_from_inventory(
        target.device_key, target.physical_target, selected_index, rows,
    ) {
        Ok(row) => row,
        Err(error) => return Err(ArcSyncApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}"))),
    };
    let identity = match gpu_apply_identity::identity_from_row(&normalized) {
        Ok(identity) => identity,
        Err(error) => return Err(ArcSyncApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}"))),
    };
    let selected_identity = match gpu_apply_identity::identity_from_row(selected_row) {
        Ok(identity) => identity,
        Err(error) => return Err(ArcSyncApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}"))),
    };
    if let Err(error) = gpu_apply_identity::ensure_same_target(&identity, &selected_identity) {
        return Err(ArcSyncApplyResult::failed("stale-target", error));
    }
    let mut backend = NativeArcSyncBackend { display_guard, dll_path, identity,
        selected_device_key: target.device_key.to_owned(), device_id: target.device_id };
    Ok(operation(display_guard, &mut backend))
}

pub(crate) fn apply_arc_sync_profile_native(
    display_guard: &DisplayLockGuard,
    target: &DisplayApplyTarget<'_>,
    requested: ArcSyncProfile,
) -> ArcSyncApplyResult {
    match with_native_arc_sync(display_guard, target, |guard, backend| {
        apply_arc_sync_profile(guard, backend, target, requested)
    }) {
        Ok(result) => result,
        Err(result) => result,
    }
}

/// Native entry point for the `arcSyncRange` control. The identity proof, the
/// guard, and the read-back verification are the same ones the profile
/// transaction uses.
pub(crate) fn apply_arc_sync_range_native(
    display_guard: &DisplayLockGuard,
    target: &DisplayApplyTarget<'_>,
    requested: ArcSyncRangeRequest,
) -> ArcSyncRangeApplyResult {
    match with_native_arc_sync(display_guard, target, |guard, backend| {
        apply_arc_sync_range(guard, backend, target, requested)
    }) {
        Ok(result) => result,
        // Identity/loader failures never reached a driver GET.
        Err(result) => ArcSyncRangeApplyResult { result, evidence: None },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::OnceLock;

    const DEVICE_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0";
    const DISPLAY_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0|display|encoder-a|edid|abcd1234";

    #[derive(Clone, Copy)]
    enum WriteBehavior { Exact, NoOp, DeclineBeforeSet, FailAfterWrite, ReadbackFailure, ThirdProfile, TimingChanged, ClampRange }

    struct FakeBackend {
        identity_ok: bool,
        outputs: Vec<DisplayOutputIdentity>,
        supported: bool,
        writable: bool,
        monitor: Option<ArcSyncRefreshBounds>,
        bounds: Option<ArcSyncRefreshBounds>,
        current: ArcSyncProfileObservation,
        writes: Vec<ArcSyncWrite>,
        /// The frame-time bounds the transaction actually handed the setter.
        last_frame_time_bounds: Option<(u32, u32)>,
        behavior: WriteBehavior,
        identity_checks: usize,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                identity_ok: true,
                outputs: vec![DisplayOutputIdentity { display_key: DISPLAY_KEY.into(), active: true, identity_verified: true }],
                supported: true,
                writable: true,
                monitor: ArcSyncRefreshBounds::new(48.0, 180.0),
                bounds: ArcSyncRefreshBounds::new(48.0, 180.0),
                current: ArcSyncProfileObservation::from_driver(1, 180.0, 90.0, 2_000, 1_000).unwrap(),
                writes: Vec::new(),
                last_frame_time_bounds: None,
                behavior: WriteBehavior::Exact,
                identity_checks: 0,
            }
        }

        fn written_profiles(&self) -> Vec<ArcSyncProfile> {
            self.writes.iter().map(|write| write.profile).collect()
        }

        fn written_windows(&self) -> Vec<(f32, f32)> {
            self.writes.iter().map(|write| (write.min_hz, write.max_hz)).collect()
        }
    }

    impl ArcSyncApplyBackend for FakeBackend {
        fn assert_device_target(&mut self, id: u64, key: &str, proof: &Value) -> Result<(), String> {
            self.identity_checks += 1;
            if !self.identity_ok || id != 0 || key != DEVICE_KEY || !proof.is_object() {
                return Err("fixture identity mismatch".into());
            }
            Ok(())
        }
        fn active_outputs(&mut self, key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
            if key != DEVICE_KEY { return Err("fixture key mismatch".into()); }
            Ok(self.outputs.clone())
        }
        fn supported(&mut self, key: &str, display: &str) -> Result<bool, String> {
            if key != DEVICE_KEY || display != DISPLAY_KEY { return Err("fixture target mismatch".into()); }
            Ok(self.supported)
        }
        fn writable(&mut self, key: &str, display: &str) -> Result<bool, String> {
            if key != DEVICE_KEY || display != DISPLAY_KEY { return Err("fixture target mismatch".into()); }
            Ok(self.writable)
        }
        fn monitor_window(&mut self, key: &str, display: &str) -> Result<Option<ArcSyncRefreshBounds>, String> {
            if key != DEVICE_KEY || display != DISPLAY_KEY { return Err("fixture target mismatch".into()); }
            Ok(self.monitor)
        }
        fn range_bounds(&mut self, key: &str, display: &str) -> Result<Option<ArcSyncRefreshBounds>, String> {
            if key != DEVICE_KEY || display != DISPLAY_KEY { return Err("fixture target mismatch".into()); }
            Ok(self.bounds)
        }
        fn read_profile(&mut self, key: &str, display: &str) -> Result<ArcSyncProfileObservation, String> {
            if key != DEVICE_KEY || display != DISPLAY_KEY { return Err("fixture target mismatch".into()); }
            if matches!(self.behavior, WriteBehavior::ReadbackFailure) && !self.writes.is_empty() {
                return Err("fixture post-SET readback failed".into());
            }
            Ok(self.current)
        }
        fn write_if_current(&mut self, key: &str, display: &str,
            expected: ArcSyncProfileObservation, requested: ArcSyncWrite) -> ArcSyncWriteOutcome {
            if key != DEVICE_KEY || display != DISPLAY_KEY || self.current != expected {
                return ArcSyncWriteOutcome::NotAttempted("fixture conditional write refused".into());
            }
            if matches!(self.behavior, WriteBehavior::DeclineBeforeSet) {
                return ArcSyncWriteOutcome::NotAttempted("fixture pre-write refusal".into());
            }
            self.writes.push(requested);
            self.last_frame_time_bounds = Some((
                expected.max_frame_time_increase_us, expected.max_frame_time_decrease_us,
            ));
            match self.behavior {
                WriteBehavior::Exact => {
                    self.current = expected.with_write(requested);
                    ArcSyncWriteOutcome::Attempted { setter_succeeded: true, error_code: None, message: None }
                }
                WriteBehavior::NoOp => ArcSyncWriteOutcome::Attempted {
                    setter_succeeded: true, error_code: None, message: None,
                },
                WriteBehavior::DeclineBeforeSet => unreachable!("decline handled before recording a SET"),
                WriteBehavior::FailAfterWrite => {
                    self.current = expected.with_write(requested);
                    ArcSyncWriteOutcome::Attempted {
                        setter_succeeded: false, error_code: Some("io-failed"),
                        message: Some("IGCL fixture setter failure".into()),
                    }
                }
                WriteBehavior::ReadbackFailure => {
                    self.current = expected.with_write(requested);
                    ArcSyncWriteOutcome::Attempted { setter_succeeded: true, error_code: None, message: None }
                }
                WriteBehavior::ThirdProfile => {
                    self.current = expected.with_write(requested);
                    self.current.profile = ArcSyncProfile::Compatible;
                    ArcSyncWriteOutcome::Attempted { setter_succeeded: true, error_code: None, message: None }
                }
                WriteBehavior::TimingChanged => {
                    self.current = expected.with_write(requested);
                    self.current.max_refresh_bits = (expected.max_refresh_hz() + 1.0).to_bits();
                    ArcSyncWriteOutcome::Attempted { setter_succeeded: true, error_code: None, message: None }
                }
                // A driver that accepts the SET but stores a narrower window.
                WriteBehavior::ClampRange => {
                    self.current = expected.with_write(requested);
                    self.current.min_refresh_bits = (requested.min_hz + 1.0).to_bits();
                    ArcSyncWriteOutcome::Attempted { setter_succeeded: true, error_code: None, message: None }
                }
            }
        }
    }

    fn target() -> DisplayApplyTarget<'static> {
        static PROOF: OnceLock<Value> = OnceLock::new();
        DisplayApplyTarget { device_id: 0, device_key: DEVICE_KEY,
            physical_target: PROOF.get_or_init(|| json!({"bdf":"0000:03:00.0"})), display_key: DISPLAY_KEY }
    }

    fn pnp_alias_proof() -> Value {
        json!({
            "id": 0,
            "deviceKey": DEVICE_KEY,
            "pciVendorId": "0x00008086",
            "pciDeviceId": "0x0000e20b",
            "bdf": {"bus": 3, "device": 0, "function": 0},
            "luid": "0x00000001:0x00000002",
            "pnpDeviceId": "PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000",
            "legacyDeviceKey": "pci:0x8086:0xe20b@3:0.0",
        })
    }

    fn apply(backend: &mut FakeBackend, requested: ArcSyncProfile) -> ArcSyncApplyResult {
        let guard = super::super::display_lock::acquire().expect("Display lock is available to fake Arc Sync tests");
        apply_arc_sync_profile(&guard, backend, &target(), requested)
    }

    #[test]
    fn pnp_alias_resolves_to_the_selected_canonical_inventory_row() {
        let pnp_key = "pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000";
        let mut row = pnp_alias_proof();
        let inventory = vec![row.clone()];
        let (selected_index, selected) = selected_inventory_row(0, &inventory).unwrap();
        assert_eq!(selected["deviceKey"], json!(DEVICE_KEY));
        let normalized = display_apply::normalize_physical_target_from_inventory(
            pnp_key, &row, selected_index, &inventory,
        ).unwrap();
        assert_eq!(normalized["deviceKey"], json!(DEVICE_KEY));

        // A duplicate PNP identity cannot silently select the first adapter.
        row["id"] = json!(1);
        row["bdf"] = json!({"bus": 4, "device": 0, "function": 0});
        row["deviceKey"] = json!("pci:0x00008086:0x0000e20b@4:0.0");
        row["legacyDeviceKey"] = json!("pci:0x8086:0xe20b@4:0.0");
        let ambiguous = vec![inventory[0].clone(), row];
        assert!(display_apply::normalize_physical_target_from_inventory(
            pnp_key, &ambiguous[0], 0, &ambiguous,
        ).unwrap_err().contains("ambiguous"));
    }

    #[test]
    fn missing_guard_fails_before_backend_io() {
        let mut backend = FakeBackend::new();
        let result = apply_arc_sync_with_guard_state(
            false, &mut backend, &target(), ArcSyncRequest::Profile(ArcSyncProfile::Excellent), &mut None,
        );
        assert_eq!(result.error_code, Some("io-failed"));
        assert_eq!(backend.identity_checks, 0);
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn successful_profile_write_preserves_timing_and_verifies_readback() {
        let mut backend = FakeBackend::new();
        let current = backend.current;
        let result = apply(&mut backend, ArcSyncProfile::Excellent);
        assert!(result.ok && result.read_back_equal);
        assert_eq!(result.read_back, Some(ArcSyncProfile::Excellent));
        assert_eq!(backend.current.max_refresh_bits, current.max_refresh_bits);
        assert_eq!(backend.current.min_refresh_bits, current.min_refresh_bits);
        assert_eq!(backend.current.max_frame_time_increase_us, current.max_frame_time_increase_us);
        assert_eq!(backend.current.max_frame_time_decrease_us, current.max_frame_time_decrease_us);
        assert_eq!(backend.written_profiles(), vec![ArcSyncProfile::Excellent]);
    }

    #[test]
    fn unsupported_or_stale_output_is_rejected_before_set() {
        let mut backend = FakeBackend::new();
        backend.supported = false;
        assert_eq!(apply(&mut backend, ArcSyncProfile::Excellent).error_code, Some("unsupported"));
        assert!(backend.writes.is_empty());

        let mut backend = FakeBackend::new();
        backend.identity_ok = false;
        assert_eq!(apply(&mut backend, ArcSyncProfile::Excellent).error_code, Some("stale-target"));
        assert!(backend.writes.is_empty());

        let mut backend = FakeBackend::new();
        backend.outputs.push(backend.outputs[0].clone());
        assert_eq!(apply(&mut backend, ArcSyncProfile::Excellent).error_code, Some("ambiguous-target"));
        assert!(backend.writes.is_empty());

        let mut backend = FakeBackend::new();
        backend.outputs[0].active = false;
        assert_eq!(apply(&mut backend, ArcSyncProfile::Excellent).error_code, Some("stale-target"));
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn already_selected_profile_still_calls_set_and_verifies_like_electron() {
        let mut backend = FakeBackend::new();
        let result = apply(&mut backend, ArcSyncProfile::Recommended);
        assert!(result.ok);
        assert!(result.read_back_equal);
        assert!(result.readback_reported);
        assert_eq!(result.setter_succeeded, Some(true));
        assert_eq!(backend.written_profiles(), vec![ArcSyncProfile::Recommended]);
    }

    #[test]
    fn successful_set_with_unchanged_profile_is_reported_as_silent_noop() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::NoOp;
        let result = apply(&mut backend, ArcSyncProfile::Excellent);
        assert!(!result.ok);
        assert!(!result.state_may_have_changed);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(result.readback_reported);
        assert_eq!(result.read_back, Some(ArcSyncProfile::Recommended));

    }

    #[test]
    fn failed_set_is_closed_to_broker_retry_and_has_no_readback_fields() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::FailAfterWrite;
        let result = apply(&mut backend, ArcSyncProfile::Excellent);
        assert!(!result.ok);
        assert!(result.state_may_have_changed);
        assert_eq!(result.setter_succeeded, Some(false));
        assert!(!result.readback_reported);
        assert_eq!(result.read_back, None);
    }

    #[test]
    fn prewrite_decline_is_the_only_result_open_to_broker_retry() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::DeclineBeforeSet;
        let result = apply(&mut backend, ArcSyncProfile::Excellent);
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, None);
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn profile_readback_matches_electron_profile_only_semantics() {
        let mut backend = FakeBackend::new();
        let before = backend.current;
        backend.behavior = WriteBehavior::TimingChanged;
        let result = apply(&mut backend, ArcSyncProfile::Excellent);
        assert!(result.ok);
        assert!(result.read_back_equal);
        assert!(result.readback_reported);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(result.state_may_have_changed);
        assert_eq!(backend.current.profile, ArcSyncProfile::Excellent);
        assert_ne!(backend.current.max_refresh_bits, before.max_refresh_bits);
    }

    #[test]
    fn successful_set_with_unavailable_readback_reports_electron_silent_noop_shape() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::ReadbackFailure;
        let result = apply(&mut backend, ArcSyncProfile::Excellent);
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(result.readback_reported);
        assert!(!result.read_back_equal);
        assert_eq!(result.read_back, None);
        assert!(result.state_may_have_changed);
    }

    #[test]
    fn third_party_profile_is_observed_without_compensating_write() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::ThirdProfile;
        let result = apply(&mut backend, ArcSyncProfile::Excellent);
        assert!(!result.ok);
        assert!(result.state_may_have_changed);
        assert_eq!(result.read_back, Some(ArcSyncProfile::Compatible));
        assert_eq!(backend.written_profiles(), vec![ArcSyncProfile::Excellent]);
    }

    fn apply_range(backend: &mut FakeBackend, requested: ArcSyncRangeRequest) -> ArcSyncRangeApplyResult {
        let guard = super::super::display_lock::acquire().expect("Display lock is available to fake Arc Sync tests");
        apply_arc_sync_range(&guard, backend, &target(), requested)
    }

    fn custom(min_hz: f32, max_hz: f32) -> ArcSyncRangeRequest {
        ArcSyncRangeRequest::Custom(
            ArcSyncRefreshBounds::new(min_hz, max_hz).expect("fixture window is valid"),
        )
    }

    #[test]
    fn custom_range_writes_the_custom_profile_with_the_exact_window_and_frame_time_passthrough() {
        let mut backend = FakeBackend::new();
        // The live driver reports 0/0 frame-time bounds; they must stay 0.
        backend.current = ArcSyncProfileObservation::from_driver(5, 180.0, 48.0, 0, 0).unwrap();
        let result = apply_range(&mut backend, custom(60.0, 165.0));

        assert!(result.ok(), "{:?}", result.message());
        assert!(result.result.read_back_equal);
        assert_eq!(result.result.read_back, Some(ArcSyncProfile::Custom));
        let evidence = result.evidence.expect("a completed range transaction reports evidence");
        assert!(evidence.matched);
        assert_eq!((evidence.requested_min_hz, evidence.requested_max_hz), (60.0, 165.0));
        assert_eq!((evidence.read_back_min_hz, evidence.read_back_max_hz), (60.0, 165.0));
        assert_eq!(backend.written_profiles(), vec![ArcSyncProfile::Custom]);
        assert_eq!(backend.written_windows(), vec![(60.0, 165.0)]);
        assert_eq!(backend.current.max_refresh_bits, 165.0_f32.to_bits());
        assert_eq!(backend.current.min_refresh_bits, 60.0_f32.to_bits());
        // Frame-time bounds are the driver's, unchanged.
        assert_eq!(backend.last_frame_time_bounds, Some((0, 0)));
        assert_eq!(backend.current.max_frame_time_increase_us, 0);
        assert_eq!(backend.current.max_frame_time_decrease_us, 0);
        assert!(result.result.state_may_have_changed);
    }

    #[test]
    fn frame_time_bounds_from_the_guarded_get_are_passed_through_unchanged() {
        let mut backend = FakeBackend::new();
        backend.current = ArcSyncProfileObservation::from_driver(7, 144.0, 48.0, 2_500, 750).unwrap();
        let result = apply_range(&mut backend, custom(48.0, 144.0));
        assert!(result.ok(), "{:?}", result.message());
        assert_eq!(backend.last_frame_time_bounds, Some((2_500, 750)));
        assert_eq!(backend.current.max_frame_time_increase_us, 2_500);
        assert_eq!(backend.current.max_frame_time_decrease_us, 750);
    }

    #[test]
    fn a_clamping_driver_is_reported_with_observed_values_and_never_ok() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::ClampRange;
        let result = apply_range(&mut backend, custom(60.0, 165.0));

        assert!(!result.ok());
        assert!(!result.result.read_back_equal);
        assert!(result.result.readback_reported);
        assert_eq!(result.result.setter_succeeded, Some(true));
        assert_eq!(result.result.read_back, Some(ArcSyncProfile::Custom));
        let evidence = result.evidence.expect("a completed range transaction reports evidence");
        assert!(!evidence.matched);
        // The fixture clamps the floor up by one Hz.
        assert_eq!(evidence.read_back_min_hz, 61.0);
        assert_eq!(evidence.read_back_max_hz, 165.0);
        let message = result.message().unwrap_or_default().to_owned();
        assert!(message.contains("61") && message.contains("165"), "message names the observed window: {message}");
        assert!(message.contains("60"), "message names the requested window: {message}");
    }

    #[test]
    fn out_of_bounds_requests_are_refused_with_the_real_display_window() {
        let mut backend = FakeBackend::new();
        backend.bounds = ArcSyncRefreshBounds::new(48.0, 180.0);

        let too_high = apply_range(&mut backend, custom(48.0, 240.0));
        assert!(!too_high.ok());
        assert_eq!(too_high.error_code(), Some("out-of-range"));
        let message = too_high.message().unwrap_or_default().to_owned();
        assert!(message.contains("240"), "names the refused value: {message}");
        assert!(message.contains("48") && message.contains("180"), "names the real bounds: {message}");
        assert_eq!(too_high.setter_succeeded(), None);
        assert!(too_high.evidence.is_none(), "nothing was read or written");

        let too_low = apply_range(&mut backend, custom(30.0, 120.0));
        assert_eq!(too_low.error_code(), Some("out-of-range"));
        assert!(too_low.message().unwrap_or_default().contains("180"));

        // Defensive: a caller can construct the bounds struct directly.
        let invalid = apply_range(&mut backend, ArcSyncRangeRequest::Custom(
            ArcSyncRefreshBounds { min_hz: 180.0, max_hz: 48.0 },
        ));
        assert_eq!(invalid.error_code(), Some("out-of-range"));
        assert!(backend.writes.is_empty(), "refusals never reach the setter");
    }

    #[test]
    fn apply_admits_exactly_the_shared_display_get_window_when_the_windows_join_fails() {
        // `display:get` and this backend both derive the admitted window with
        // `windows_display_modes::arc_sync_range_bounds`. When no Windows row
        // can be identified, the driver's own window is the rule, so what the
        // renderer advertises is exactly what the write path admits.
        let derived = super::super::windows_display_modes::arc_sync_range_bounds(
            None, Some("MSI G27C4 E3"), Some((1920, 1080)), 48.0, 180.0,
        ).expect("the driver reported a usable window");
        assert_eq!(derived, (48.0, 180.0));

        let mut backend = FakeBackend::new();
        backend.monitor = ArcSyncRefreshBounds::new(48.0, 180.0);
        backend.bounds = ArcSyncRefreshBounds::new(derived.0, derived.1);
        let applied = apply_range(&mut backend, custom(48.0, 180.0));
        assert!(applied.ok(), "{:?}", applied.message());
        assert_eq!(backend.written_windows(), vec![(48.0, 180.0)]);

        // One Hz above the advertised ceiling is refused with the real bound,
        // never clamped, and never reaches the setter.
        let refused = apply_range(&mut backend, custom(48.0, 181.0));
        assert_eq!(refused.error_code(), Some("out-of-range"));
        assert!(refused.message().unwrap_or_default().contains("180"));
        assert_eq!(backend.written_windows(), vec![(48.0, 180.0)]);
    }

    #[test]
    fn restore_writes_the_recommended_profile_with_the_monitor_window() {
        let mut backend = FakeBackend::new();
        backend.monitor = ArcSyncRefreshBounds::new(48.0, 180.0);
        backend.bounds = ArcSyncRefreshBounds::new(60.0, 180.0);
        let result = apply_range(&mut backend, ArcSyncRangeRequest::Restore);

        assert!(result.ok(), "{:?}", result.message());
        assert_eq!(backend.written_profiles(), vec![ArcSyncProfile::Recommended]);
        // The restore window is the monitor's own, not the intersected one.
        assert_eq!(backend.written_windows(), vec![(48.0, 180.0)]);
        assert_eq!(result.result.read_back, Some(ArcSyncProfile::Recommended));
    }

    #[test]
    fn restore_succeeds_when_intel_reports_its_own_recommended_window() {
        // On the real B580, writing RECOMMENDED with the monitor window
        // (48-180 Hz) made the driver report its own default (90-180 Hz). The
        // profile is what we asked for, so this is a successful restore and the
        // differing window must stay visible as evidence. The same driver
        // behaviour for a CUSTOM request must still be a failure.
        let mut backend = FakeBackend::new();
        backend.monitor = ArcSyncRefreshBounds::new(48.0, 180.0);
        backend.bounds = ArcSyncRefreshBounds::new(48.0, 180.0);
        backend.behavior = WriteBehavior::ClampRange;
        let restored = apply_range(&mut backend, ArcSyncRangeRequest::Restore);
        assert!(restored.ok(), "{:?}", restored.message());
        assert_eq!(restored.result.read_back, Some(ArcSyncProfile::Recommended));
        let evidence = restored.evidence.expect("restore reports evidence");
        assert!(evidence.matched);
        assert_eq!((evidence.requested_min_hz, evidence.requested_max_hz), (48.0, 180.0));
        assert_eq!((evidence.read_back_min_hz, evidence.read_back_max_hz), (49.0, 180.0));

        let mut custom_backend = FakeBackend::new();
        custom_backend.monitor = ArcSyncRefreshBounds::new(48.0, 180.0);
        custom_backend.bounds = ArcSyncRefreshBounds::new(48.0, 180.0);
        custom_backend.behavior = WriteBehavior::ClampRange;
        let clamped = apply_range(&mut custom_backend, custom(48.0, 180.0));
        assert!(!clamped.ok(), "a clamped custom window is still a failure");
        assert!(!clamped.evidence.expect("evidence").matched);
    }

    #[test]
    fn custom_range_is_admitted_when_the_driver_reports_no_raw_window() {
        // A driver can claim Arc Sync support while reporting a 0-0 Hz window.
        // The admitted window then comes from the display's own mode list, so a
        // custom request must not be blocked by the missing raw driver window.
        let mut backend = FakeBackend::new();
        backend.monitor = None;
        backend.bounds = ArcSyncRefreshBounds::new(48.0, 180.0);
        let applied = apply_range(&mut backend, custom(60.0, 144.0));
        assert!(applied.ok(), "{:?}", applied.message());
        assert_eq!(backend.written_windows(), vec![(60.0, 144.0)]);

        // Restore also works from the fallback window: RECOMMENDED is verified
        // by profile alone, so a 0-0 driver window cannot block it.
        let mut restore_backend = FakeBackend::new();
        restore_backend.monitor = None;
        restore_backend.bounds = ArcSyncRefreshBounds::new(48.0, 180.0);
        let restored = apply_range(&mut restore_backend, ArcSyncRangeRequest::Restore);
        assert!(restored.ok(), "{:?}", restored.message());
        assert_eq!(restore_backend.written_windows(), vec![(48.0, 180.0)]);
    }

    #[test]
    fn unsupported_unwritable_or_unbounded_range_requests_decline_before_the_setter() {
        let mut unsupported = FakeBackend::new();
        unsupported.supported = false;
        let result = apply_range(&mut unsupported, custom(60.0, 120.0));
        assert_eq!(result.error_code(), Some("unsupported"));
        assert!(result.evidence.is_none());
        assert!(unsupported.writes.is_empty());

        let mut unwritable = FakeBackend::new();
        unwritable.writable = false;
        let result = apply_range(&mut unwritable, custom(60.0, 120.0));
        assert_eq!(result.error_code(), Some("unsupported"));
        assert!(result.message().unwrap_or_default().contains("setter"));
        assert!(result.evidence.is_none());
        assert!(unwritable.writes.is_empty());

        let mut no_bounds = FakeBackend::new();
        no_bounds.bounds = None;
        let result = apply_range(&mut no_bounds, custom(60.0, 120.0));
        assert_eq!(result.error_code(), Some("io-failed"));
        assert!(result.message().unwrap_or_default().contains("refresh window"));
        assert!(no_bounds.writes.is_empty());

        // A restore with no admitted window from either source is still
        // refused before any SET. (A 0-0 driver window alone is no longer a
        // refusal: the mode-list fallback supplies the window.)
        let mut no_restore_bounds = FakeBackend::new();
        no_restore_bounds.bounds = None;
        let result = apply_range(&mut no_restore_bounds, ArcSyncRangeRequest::Restore);
        assert_eq!(result.error_code(), Some("io-failed"));
        assert!(no_restore_bounds.writes.is_empty());
    }

    #[test]
    fn arc_sync_range_payload_shape_gate_accepts_only_null_or_an_exact_pair() {
        assert_eq!(arc_sync_range_request(&Value::Null), Some(ArcSyncRangeRequest::Restore));
        assert_eq!(
            arc_sync_range_request(&json!({"minHz": 60.0, "maxHz": 120.0})),
            Some(custom(60.0, 120.0)),
        );
        // Extra/missing keys, wrong types, and degenerate windows are refused.
        assert_eq!(arc_sync_range_request(&json!({"minHz": 60.0, "maxHz": 120.0, "x": 1})), None);
        assert_eq!(arc_sync_range_request(&json!({"minHz": 60.0})), None);
        assert_eq!(arc_sync_range_request(&json!({"minHz": "60", "maxHz": 120.0})), None);
        assert_eq!(arc_sync_range_request(&json!({"minHz": 120.0, "maxHz": 60.0})), None);
        assert_eq!(arc_sync_range_request(&json!({"minHz": 60.0, "maxHz": 60.0})), None);
        assert_eq!(arc_sync_range_request(&json!({"minHz": 0.0, "maxHz": 120.0})), None);
        assert_eq!(arc_sync_range_request(&json!([])), None);
    }
}
