//! Windows display-mode inventory and private staged modeset seam.
//!
//! This is the native read half of Electron's `windows-display-mode.js`.
//! It enumerates attached display adapters, their monitor identities, each
//! adapter's current DEVMODE, and the driver's indexed DEVMODE list. A
//! Windows-only private writer validates the same output identity/current
//! mode immediately before `ChangeDisplaySettingsExW`; it is not routed.
//!
//! The API seam is intentionally injectable. Unit tests exercise fake readers
//! and User32 function pointers; they never call User32 or change the active
//! display mode.

use serde::Serialize;
use std::collections::HashSet;

const DISPLAY_DEVICE_ATTACHED_TO_DESKTOP: u32 = 0x0000_0001;
const ENUM_CURRENT_SETTINGS: u32 = u32::MAX;
const ENUM_MODE_FLAGS: u32 = 0;
const DISPLAY_DEVICE_LIMIT: usize = 32;
const MONITOR_DEVICE_LIMIT: usize = 32;
const MODE_LIMIT: usize = 4096;
#[cfg(windows)]
const MAX_DISPLAY_MODE_DIMENSION: u32 = 16_384;
// The read projection consumes dmDisplayFrequency at bytes 184..188.
const DEVMODE_MIN_SIZE: u16 = 188;
const DEVMODE_MAX_SIZE: u16 = 220;
const MAX_MODE_DIMENSION: u32 = 32_768;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsDisplayMode {
    pub width: u32,
    pub height: u32,
    pub refresh_rate: u32,
    pub bits_per_pixel: u32,
    pub display_flags: u32,
    pub orientation: u32,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsDisplayMonitor {
    pub device_name: String,
    pub device_string: String,
    pub state_flags: u32,
    pub device_id: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsDisplayOutput {
    pub device_name: String,
    pub display_name: String,
    pub device_id: String,
    pub monitors: Vec<WindowsDisplayMonitor>,
    pub current_mode: WindowsDisplayMode,
    pub modes: Vec<WindowsDisplayMode>,
    pub display_identity: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WindowsDisplayModeSnapshot {
    pub outputs: Vec<WindowsDisplayOutput>,
    /// False if an attached output could not be read completely or a returned
    /// mode record was malformed.
    pub complete: bool,
    /// True only when an extra row exists beyond one of the explicit bounds.
    pub truncated: bool,
}

/// Guard for a staged display modeset transaction. The device name locates the
/// Windows output, while `display_identity` prevents a reused device name from
/// selecting a replacement monitor. The current mode is a compare-before-
/// write guard so a stale transaction cannot overwrite a mode changed since
/// it was staged. Windows identity is not proof that this output maps to a
/// particular IGCL adapter/output: any caller crossing those APIs must
/// independently establish and retain that physical mapping proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayModesetGuard {
    pub(crate) device_name: String,
    pub(crate) display_identity: String,
    pub(crate) expected_current_mode: WindowsDisplayMode,
}

/// Requested mode for the private, staged modeset transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayModesetRequest {
    pub(crate) guard: DisplayModesetGuard,
    pub(crate) target_mode: WindowsDisplayMode,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DisplayModesetError {
    InvalidGuard,
    InvalidTarget,
    SnapshotReadFailed(String),
    IncompleteSnapshot,
    OutputNotFound,
    OutputAmbiguous,
    IdentityMismatch,
    CurrentModeChanged,
    UnsupportedMode,
    ApplyFailed(String),
    ReadbackMismatch,
}

/// Outcome of a staged mode change. A failed apply may still have been
/// compensated; callers must check both rollback fields before concluding the
/// display returned to its staged mode.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayModesetResult {
    pub(crate) ok: bool,
    pub(crate) error: Option<DisplayModesetError>,
    pub(crate) rollback_attempted: bool,
    pub(crate) rollback_verified: bool,
}

/// Private modeset backend contract for staged migration work.
///
/// The native writer is private and this seam is not connected to a public
/// command. `set_mode_if_unchanged` revalidates Windows identity and current
/// mode immediately before User32. Win32 provides no compare-and-swap, so an
/// external display writer can still race after that check. The shared lock
/// serializes Arc Power writers only. Windows output identity also does not
/// prove the mapping to an IGCL adapter/output. Keep this seam unrouted until
/// the caller can establish that cross-API mapping and accept the external
/// writer race.
pub(crate) trait DisplayModesetApi {
    fn read_snapshot(&mut self) -> Result<WindowsDisplayModeSnapshot, String>;

    /// Native implementations bind the backend to the exact lock proof used
    /// by the outer transaction. Fake implementations may use the live proof
    /// passed into the transaction directly.
    fn is_bound_to_display_lock(&self, display_guard: &super::display_lock::DisplayLockGuard) -> bool {
        display_guard.is_held()
    }

    fn set_mode_if_unchanged(
        &mut self,
        device_name: &str,
        display_identity: &str,
        expected_current_mode: &WindowsDisplayMode,
        target_mode: &WindowsDisplayMode,
    ) -> Result<(), String>;
}

/// Run a guarded, read-back-verified Windows display modeset transaction.
///
/// This is a private staging seam only: it does not call User32, and no
/// production backend or command is wired to it. Compensation is attempted
/// only if a fresh complete snapshot still matches both the original Windows
/// output identity and the exact mode written by this transaction. The
/// backend is contractually required to repeat those checks at the write
/// boundary, but Win32 provides no atomic compare-and-swap against external
/// display writers. The shared lock only serializes Arc Power writers, and
/// this seam remains unrouted until that gap is resolved. The transaction
/// seam cannot itself establish IGCL-to-Windows output mapping proof.
pub(crate) fn transact_display_mode(
    display_guard: &super::display_lock::DisplayLockGuard,
    api: &mut impl DisplayModesetApi,
    request: &DisplayModesetRequest,
) -> DisplayModesetResult {
    if !api.is_bound_to_display_lock(display_guard) {
        return modeset_failure(DisplayModesetError::InvalidGuard);
    }
    let guard = &request.guard;
    if guard.device_name.is_empty() || guard.display_identity.is_empty()
        || !valid_mode(&guard.expected_current_mode)
    {
        return modeset_failure(DisplayModesetError::InvalidGuard);
    }
    if !valid_mode(&request.target_mode) {
        return modeset_failure(DisplayModesetError::InvalidTarget);
    }

    let before = match read_guarded_output(api, guard) {
        Ok(output) => output,
        Err(error) => return modeset_failure(error),
    };
    if before.current_mode != guard.expected_current_mode {
        return modeset_failure(DisplayModesetError::CurrentModeChanged);
    }
    if before.current_mode == request.target_mode {
        return modeset_success();
    }
    if !mode_supported(&before, &request.target_mode) {
        return modeset_failure(DisplayModesetError::UnsupportedMode);
    }

    let apply_result = api.set_mode_if_unchanged(
        &guard.device_name,
        &guard.display_identity,
        &guard.expected_current_mode,
        &request.target_mode,
    );
    let primary_error = apply_result.err().map(DisplayModesetError::ApplyFailed);

    let after_apply = match read_guarded_output(api, guard) {
        Ok(output) => output,
        Err(error) => {
            return DisplayModesetResult {
                ok: false,
                error: Some(error),
                rollback_attempted: false,
                rollback_verified: false,
            };
        }
    };
    if after_apply.current_mode == request.target_mode && primary_error.is_none() {
        return modeset_success();
    }

    let failure = primary_error.unwrap_or(DisplayModesetError::ReadbackMismatch);
    if after_apply.current_mode != request.target_mode {
        return DisplayModesetResult {
            ok: false,
            error: Some(failure),
            rollback_attempted: false,
            rollback_verified: false,
        };
    }

    // The requested mode is still active on the original output, so attempt
    // conditional compensation back to the mode observed before the write.
    // A concurrent change between this read and the setter is rejected by the
    // setter's expected-current guard.
    let _rollback_write = api.set_mode_if_unchanged(
        &guard.device_name,
        &guard.display_identity,
        &request.target_mode,
        &guard.expected_current_mode,
    );
    let rollback_verified = read_guarded_output(api, guard)
        .is_ok_and(|output| output.current_mode == guard.expected_current_mode);
    DisplayModesetResult {
        ok: false,
        error: Some(failure),
        rollback_attempted: true,
        rollback_verified,
    }
}

fn read_guarded_output<'a>(
    api: &mut impl DisplayModesetApi,
    guard: &DisplayModesetGuard,
) -> Result<WindowsDisplayOutput, DisplayModesetError> {
    let snapshot = api.read_snapshot().map_err(DisplayModesetError::SnapshotReadFailed)?;
    if !snapshot.complete || snapshot.truncated { return Err(DisplayModesetError::IncompleteSnapshot); }
    let mut matches = snapshot.outputs.into_iter()
        .filter(|output| output.device_name == guard.device_name);
    let Some(output) = matches.next() else { return Err(DisplayModesetError::OutputNotFound) };
    if matches.next().is_some() { return Err(DisplayModesetError::OutputAmbiguous); }
    if output.display_identity != guard.display_identity {
        return Err(DisplayModesetError::IdentityMismatch);
    }
    Ok(output)
}

fn valid_mode(mode: &WindowsDisplayMode) -> bool {
    valid_geometry(mode) && mode.refresh_rate > 0
}

fn mode_supported(output: &WindowsDisplayOutput, requested: &WindowsDisplayMode) -> bool {
    output.modes.iter().any(|candidate| {
        candidate.width == requested.width
            && candidate.height == requested.height
            && candidate.refresh_rate.abs_diff(requested.refresh_rate) <= 1
            && (requested.bits_per_pixel == 0 || candidate.bits_per_pixel == 0
                || candidate.bits_per_pixel == requested.bits_per_pixel)
            && (requested.display_flags == 0 || candidate.display_flags == requested.display_flags)
            && (requested.orientation == 0 || candidate.orientation == requested.orientation)
    })
}

fn modeset_failure(error: DisplayModesetError) -> DisplayModesetResult {
    DisplayModesetResult { ok: false, error: Some(error), rollback_attempted: false, rollback_verified: false }
}

fn modeset_success() -> DisplayModesetResult {
    DisplayModesetResult { ok: true, error: None, rollback_attempted: false, rollback_verified: false }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DisplayModeReadError {
    WindowsOnly,
}

impl std::fmt::Display for DisplayModeReadError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WindowsOnly => formatter.write_str("Windows display-mode enumeration is available only on Windows."),
        }
    }
}

impl std::error::Error for DisplayModeReadError {}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RawDisplayDevice {
    device_name: String,
    device_string: String,
    state_flags: u32,
    device_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RawMode {
    reported_size: u16,
    mode: WindowsDisplayMode,
}

/// Narrow User32 read seam. `None` means the indexed enumeration ended or that
/// the individual read failed, matching the legacy backend's fail-closed
/// behavior for an incomplete output.
trait DisplayModeApi {
    fn display_device(&mut self, parent: Option<&str>, index: usize) -> Option<RawDisplayDevice>;
    fn display_mode(&mut self, device_name: &str, index: u32) -> Option<RawMode>;
}

/// Enumerate attached Windows outputs and their supported source modes.
///
/// On non-Windows hosts this returns `WindowsOnly`. Windows mode reads are
/// always fresh; callers should not cache the result across hot-plug or
/// topology changes.
pub fn read_windows_display_modes() -> Result<WindowsDisplayModeSnapshot, DisplayModeReadError> {
    #[cfg(windows)]
    {
        let mut api = NativeDisplayModeApi;
        Ok(enumerate_with(&mut api))
    }
    #[cfg(not(windows))]
    {
        Err(DisplayModeReadError::WindowsOnly)
    }
}

fn enumerate_with(api: &mut impl DisplayModeApi) -> WindowsDisplayModeSnapshot {
    let mut outputs = Vec::new();
    let mut complete = true;
    let mut truncated = false;
    let mut adapter_scan_ended = false;
    for adapter_index in 0..DISPLAY_DEVICE_LIMIT {
        let Some(adapter) = api.display_device(None, adapter_index) else {
            adapter_scan_ended = true;
            break;
        };
        if adapter.state_flags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP == 0 { continue; }

        let mut monitors = Vec::new();
        let mut monitor_scan_ended = false;
        for monitor_index in 0..MONITOR_DEVICE_LIMIT {
            let Some(monitor) = api.display_device(Some(adapter.device_name.as_str()), monitor_index) else {
                monitor_scan_ended = true;
                break;
            };
            monitors.push(WindowsDisplayMonitor {
                device_name: monitor.device_name,
                device_string: monitor.device_string,
                state_flags: monitor.state_flags,
                device_id: monitor.device_id,
            });
        }
        if !monitor_scan_ended && api.display_device(Some(adapter.device_name.as_str()), MONITOR_DEVICE_LIMIT).is_some() {
            complete = false;
            truncated = true;
        }

        let Some(current) = api.display_mode(&adapter.device_name, ENUM_CURRENT_SETTINGS) else {
            complete = false;
            continue;
        };
        if !valid_reported_size(current.reported_size) || !valid_geometry(&current.mode) {
            complete = false;
            continue;
        }

        let mut modes = Vec::new();
        let mut seen = HashSet::new();
        let mut mode_scan_ended = false;
        for mode_index in 0..MODE_LIMIT {
            let Some(raw) = api.display_mode(&adapter.device_name, mode_index as u32) else {
                mode_scan_ended = true;
                break;
            };
            if !valid_reported_size(raw.reported_size) {
                complete = false;
                continue;
            }
            let Some(mode) = normalize_mode(raw.mode) else {
                complete = false;
                continue;
            };
            if seen.insert(mode_key(&mode)) { modes.push(mode); }
        }
        if !mode_scan_ended && api.display_mode(adapter.device_name.as_str(), MODE_LIMIT as u32).is_some() {
            complete = false;
            truncated = true;
        }

        let display_identity = output_identity(&adapter, &monitors);
        outputs.push(WindowsDisplayOutput {
            device_name: adapter.device_name,
            display_name: adapter.device_string,
            device_id: adapter.device_id,
            monitors,
            current_mode: current.mode,
            modes,
            display_identity,
        });
    }
    if !adapter_scan_ended && api.display_device(None, DISPLAY_DEVICE_LIMIT).is_some() {
        complete = false;
        truncated = true;
    }
    WindowsDisplayModeSnapshot { outputs, complete, truncated }
}

fn valid_reported_size(size: u16) -> bool {
    size >= DEVMODE_MIN_SIZE && size <= DEVMODE_MAX_SIZE
}

fn normalize_mode(mode: WindowsDisplayMode) -> Option<WindowsDisplayMode> {
    if !valid_geometry(&mode) || mode.refresh_rate == 0 {
        return None;
    }
    Some(mode)
}

fn valid_geometry(mode: &WindowsDisplayMode) -> bool {
    mode.width > 0 && mode.width <= MAX_MODE_DIMENSION
        && mode.height > 0 && mode.height <= MAX_MODE_DIMENSION
}

fn mode_key(mode: &WindowsDisplayMode) -> (u32, u32, u32, u32, u32, u32) {
    (mode.width, mode.height, mode.refresh_rate, mode.bits_per_pixel, mode.display_flags, mode.orientation)
}

fn output_identity(adapter: &RawDisplayDevice, monitors: &[WindowsDisplayMonitor]) -> String {
    let monitor_ids = monitors.iter()
        .map(|monitor| monitor.device_id.as_str())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if monitor_ids.is_empty() {
        if adapter.device_id.is_empty() { adapter.device_name.clone() } else { adapter.device_id.clone() }
    } else {
        monitor_ids.join("|")
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DisplayModeRequest<'a> {
    pub device_name: Option<&'a str>,
    pub display_identity: Option<&'a str>,
    pub display_name: Option<&'a str>,
    pub resolution: Option<(u32, u32)>,
    pub refresh_rate: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisplayResolveError {
    Incomplete,
    NotFound,
    Ambiguous,
}

/// Resolve one output using the same exact-name, monitor-identity, normalized
/// label and current-mode tie-break rules as Electron's modeset reader.
///
/// This function consumes a previously enumerated snapshot and performs no OS
/// calls. Callers must obtain a fresh snapshot for each display read.
pub fn resolve_output<'a>(
    snapshot: &'a WindowsDisplayModeSnapshot,
    request: &DisplayModeRequest<'_>,
) -> Result<&'a WindowsDisplayOutput, DisplayResolveError> {
    if !snapshot.complete { return Err(DisplayResolveError::Incomplete); }
    let outputs = &snapshot.outputs;
    let mut candidates: Vec<&WindowsDisplayOutput> = if let Some(device_name) = nonempty(request.device_name) {
        outputs.iter().filter(|output| output.device_name == device_name
            && nonempty(request.display_identity).map_or(true, |identity| output.display_identity == identity))
            .collect()
    } else {
        let matching_labels = outputs.iter().filter(|output| {
            let labels = std::iter::once(output.display_name.as_str())
                .chain(std::iter::once(output.device_id.as_str()))
                .chain(output.monitors.iter().flat_map(|monitor| [monitor.device_string.as_str(), monitor.device_id.as_str()]));
            labels.into_iter().any(|label| display_label_matches(request.display_name, label))
        }).collect::<Vec<_>>();

        if matching_labels.len() == 1 {
            matching_labels
        } else if matching_labels.len() > 1 {
            let tied = matching_labels.iter().copied().filter(|output| mode_matches(&output.current_mode, request)).collect::<Vec<_>>();
            if tied.len() == 1 { tied } else { matching_labels }
        } else if nonempty(request.display_name).is_none() && request.resolution.is_none() {
            outputs.iter().collect()
        } else {
            outputs.iter().filter(|output| mode_matches(&output.current_mode, request)).collect()
        }
    };

    // A supplied identity is an invariant even without a device name. The
    // Electron matcher only checks it with a name; fail closed here so a
    // label or mode cannot select a replacement monitor by accident.
    if let Some(identity) = nonempty(request.display_identity) {
        candidates.retain(|output| output.display_identity == identity);
    }
    match candidates.as_slice() {
        [output] => Ok(*output),
        [] => Err(DisplayResolveError::NotFound),
        _ => Err(DisplayResolveError::Ambiguous),
    }
}

fn nonempty(value: Option<&str>) -> Option<&str> {
    value.filter(|value| !value.is_empty())
}

fn normalize_label(value: &str) -> String {
    value.chars().filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase).collect()
}

fn display_label_matches(wanted: Option<&str>, candidate: &str) -> bool {
    let Some(wanted) = nonempty(wanted) else { return false; };
    let wanted = normalize_label(wanted);
    let actual = normalize_label(candidate);
    wanted.len() >= 4 && !actual.is_empty() && (actual == wanted || actual.contains(&wanted) || wanted.contains(&actual))
}

fn mode_matches(mode: &WindowsDisplayMode, request: &DisplayModeRequest<'_>) -> bool {
    let Some((width, height)) = request.resolution else { return false; };
    if mode.width != width || mode.height != height { return false; }
    match request.refresh_rate {
        Some(refresh) if refresh.is_finite() && refresh > 0.0 => (f64::from(mode.refresh_rate) - refresh).abs() <= 1.0,
        _ => true,
    }
}

/// Normalize a display label for exact selection. This is the Display read's
/// presentation-only rule: it never proves that a Windows row belongs to a
/// particular IGCL output, so callers must not treat a match as identity proof.
pub(crate) fn normalized_display_label(label: &str) -> String {
    label.chars().filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase).collect()
}

fn output_labels(output: &WindowsDisplayOutput) -> impl Iterator<Item = &str> {
    std::iter::once(output.display_name.as_str())
        .chain(std::iter::once(output.device_id.as_str()))
        .chain(output.monitors.iter().flat_map(|monitor| {
            [monitor.device_string.as_str(), monitor.device_id.as_str()]
        }))
}

/// The refresh window a display's own Windows mode list offers.
///
/// This is the narrowing half of [`arc_sync_range_bounds`]: `None` means the
/// list cannot narrow the driver's window, not that no control is available.
/// Only a complete, untruncated inventory is accepted: a short list could hide
/// the real ceiling. The row is selected by an exact, unique normalized label,
/// the same presentation rule the Display read uses. Modes at the resolution
/// currently in use are preferred; when that resolution has no row the
/// display's whole list is used. An empty list, or a list whose only refresh
/// rate is a single value, has no usable window and yields `None`.
pub(crate) fn display_refresh_bounds(
    snapshot: &WindowsDisplayModeSnapshot,
    display_label: Option<&str>,
    resolution: Option<(u32, u32)>,
) -> Option<(u32, u32)> {
    if !snapshot.complete || snapshot.truncated { return None; }
    let wanted = display_label.map(normalized_display_label).filter(|label| !label.is_empty())?;
    let mut matches = snapshot.outputs.iter()
        .filter(|output| output_labels(output).any(|label| normalized_display_label(label) == wanted));
    let output = matches.next()?;
    if matches.next().is_some() { return None; }

    let mut rates: Vec<u32> = output.modes.iter()
        .filter(|mode| match resolution {
            Some((width, height)) => mode.width == width && mode.height == height,
            None => true,
        })
        .map(|mode| mode.refresh_rate)
        .filter(|rate| *rate > 0)
        .collect();
    if rates.is_empty() {
        rates = output.modes.iter().map(|mode| mode.refresh_rate).filter(|rate| *rate > 0).collect();
    }
    let min = *rates.iter().min()?;
    let max = *rates.iter().max()?;
    (min < max).then_some((min, max))
}

/// Intersect a display mode window with ControlLib's monitor window. The
/// result is the window a custom Arc Sync range may use; a disjoint or
/// degenerate intersection is `None` because no value could be admitted.
pub(crate) fn intersect_refresh_bounds(
    mode: (u32, u32),
    monitor: (f32, f32),
) -> Option<(f32, f32)> {
    let (monitor_min, monitor_max) = monitor;
    if !monitor_min.is_finite() || !monitor_max.is_finite() { return None; }
    let min_hz = (mode.0 as f32).max(monitor_min);
    let max_hz = (mode.1 as f32).min(monitor_max);
    (min_hz > 0.0 && max_hz > min_hz).then_some((min_hz, max_hz))
}

/// A refresh window that can admit at least one custom range: finite, a
/// positive floor, and a ceiling above it.
fn usable_refresh_window(min_hz: f32, max_hz: f32) -> Option<(f32, f32)> {
    (min_hz.is_finite() && max_hz.is_finite() && min_hz > 0.0 && max_hz > min_hz)
        .then_some((min_hz, max_hz))
}

/// The usable custom Arc Sync window for one display.
///
/// ControlLib's per-monitor window (`monitor_min_hz` / `monitor_max_hz`, from
/// `ctlGetIntelArcSyncInfoForMonitor`) is the authoritative source when it is
/// usable: it is the window the driver itself reports for this display on this
/// machine, so no value here is assumed or hardcoded. The display's own Windows
/// mode list may only NARROW that window, and only when its exact-label join
/// identifies one complete output. An unavailable, ambiguous, or incomplete
/// inventory leaves the driver window unchanged: a failure to join the two
/// sources must never withhold a control whose bounds the driver reported.
///
/// Some Intel drivers report `supported = true` but a degenerate window
/// (typically 0-0 Hz). In that case the display's own Windows mode list is the
/// fallback: it is still a per-system capability read from that display, not
/// a guess or a constant. `None` is reserved for the case where NEITHER source
/// can supply a usable window.
pub(crate) fn arc_sync_range_bounds(
    snapshot: Option<&WindowsDisplayModeSnapshot>,
    display_label: Option<&str>,
    resolution: Option<(u32, u32)>,
    monitor_min_hz: f32,
    monitor_max_hz: f32,
) -> Option<(f32, f32)> {
    let driver_window = usable_refresh_window(monitor_min_hz, monitor_max_hz);
    let mode_window = snapshot
        .and_then(|snapshot| display_refresh_bounds(snapshot, display_label, resolution));
    match (driver_window, mode_window) {
        // The mode list can narrow the driver window but never widen or veto it.
        (Some(driver), Some(mode)) => Some(intersect_refresh_bounds(mode, driver).unwrap_or(driver)),
        (Some(driver), None) => Some(driver),
        // Driver reported no usable window (e.g. 0-0 Hz): use the display's own
        // mode list rather than withholding a control the driver says exists.
        (None, Some((min, max))) => Some((min as f32, max as f32)),
        (None, None) => None,
    }
}

#[cfg(windows)]
struct NativeDisplayModeApi;

#[cfg(windows)]
const CDS_RESET: u32 = 0x4000_0000;
#[cfg(windows)]
const DM_PELSWIDTH: u32 = 0x0008_0000;
#[cfg(windows)]
const DM_PELSHEIGHT: u32 = 0x0010_0000;
#[cfg(windows)]
const DM_DISPLAYFREQUENCY: u32 = 0x0040_0000;
#[cfg(windows)]
const DISP_CHANGE_SUCCESSFUL: i32 = 0;

#[cfg(windows)]
type EnumDisplaySettingsExFn = unsafe extern "system" fn(
    *const u16,
    u32,
    *mut NativeDevModeW,
    u32,
) -> i32;
#[cfg(windows)]
type ChangeDisplaySettingsExFn = unsafe extern "system" fn(
    *const u16,
    *mut NativeDevModeW,
    *mut std::ffi::c_void,
    u32,
    *mut std::ffi::c_void,
) -> i32;

/// Windows writer adapter. The guard reference proves this backend is created
/// while the shared Arc Power Display mutex is held; Win32 still cannot rule
/// out a different process changing the mode between the final read and call.
#[cfg(windows)]
#[allow(dead_code)] // Private Windows mode writer; no Display channel routes it.
struct NativeDisplayModesetApi<'a, R: DisplayModeApi> {
    _display_guard: &'a super::display_lock::DisplayLockGuard,
    reader: R,
    enum_settings: EnumDisplaySettingsExFn,
    change_settings: ChangeDisplaySettingsExFn,
}

#[cfg(windows)]
#[allow(dead_code)] // Private Windows mode writer; no Display channel routes it.
pub(crate) fn native_display_modeset_api(
    display_guard: &super::display_lock::DisplayLockGuard,
) -> impl DisplayModesetApi + '_ {
    NativeDisplayModesetApi {
        _display_guard: display_guard,
        reader: NativeDisplayModeApi,
        enum_settings: EnumDisplaySettingsExW,
        change_settings: ChangeDisplaySettingsExW,
    }
}

#[cfg(windows)]
impl DisplayModeApi for NativeDisplayModeApi {
    fn display_device(&mut self, parent: Option<&str>, index: usize) -> Option<RawDisplayDevice> {
        let parent_wide = parent.map(wide_nul);
        let parent_ptr = parent_wide.as_ref().map_or(std::ptr::null(), |value| value.as_ptr());
        let mut device = NativeDisplayDeviceW::default();
        device.cb = std::mem::size_of::<NativeDisplayDeviceW>() as u32;
        let ok = unsafe { EnumDisplayDevicesW(parent_ptr, index as u32, &mut device, 0) };
        if ok == 0 { return None; }
        Some(RawDisplayDevice {
            device_name: read_wide_z(&device.device_name),
            device_string: read_wide_z(&device.device_string),
            state_flags: device.state_flags,
            device_id: read_wide_z(&device.device_id),
        })
    }

    fn display_mode(&mut self, device_name: &str, index: u32) -> Option<RawMode> {
        let device_name = wide_nul(device_name);
        let mut native = NativeDevModeW::default();
        native.dm_size = std::mem::size_of::<NativeDevModeW>() as u16;
        let ok = unsafe { EnumDisplaySettingsExW(device_name.as_ptr(), index, &mut native, ENUM_MODE_FLAGS) };
        if ok == 0 { return None; }
        let orientation = unsafe { native.dm_union.display.dm_display_orientation };
        Some(RawMode {
            reported_size: native.dm_size,
            mode: WindowsDisplayMode {
                width: native.dm_pels_width,
                height: native.dm_pels_height,
                refresh_rate: native.dm_display_frequency,
                bits_per_pixel: native.dm_bits_per_pel,
                display_flags: native.dm_display_flags,
                // Electron reads the low word of dmDisplayOrientation.
                orientation: orientation & 0xffff,
            },
        })
    }
}

#[cfg(windows)]
impl<R: DisplayModeApi> DisplayModesetApi for NativeDisplayModesetApi<'_, R> {
    fn read_snapshot(&mut self) -> Result<WindowsDisplayModeSnapshot, String> {
        Ok(enumerate_with(&mut self.reader))
    }

    fn is_bound_to_display_lock(&self, display_guard: &super::display_lock::DisplayLockGuard) -> bool {
        std::ptr::eq(self._display_guard, display_guard) && display_guard.is_held()
    }

    fn set_mode_if_unchanged(
        &mut self,
        device_name: &str,
        display_identity: &str,
        expected_current_mode: &WindowsDisplayMode,
        target_mode: &WindowsDisplayMode,
    ) -> Result<(), String> {
        if !self._display_guard.is_held() {
            return Err("the shared Display lock is not held".into());
        }
        if target_mode.width > MAX_DISPLAY_MODE_DIMENSION || target_mode.height > MAX_DISPLAY_MODE_DIMENSION {
            return Err("display mode dimensions exceed the supported bound".into());
        }
        if !preserved_mode_fields_match(expected_current_mode, target_mode) {
            return Err("the requested mode changes DEVMODE fields outside the supported width/height/refresh write".into());
        }
        self.validate_write_target(device_name, display_identity, expected_current_mode, target_mode)?;

        // Keep the driver's complete current DEVMODE as the base, mirroring
        // Electron's mode writer. This preserves fields Windows may depend on
        // while changing only the explicitly requested source-mode values.
        let wide_name = wide_nul(device_name);
        let mut native = NativeDevModeW::default();
        native.dm_size = std::mem::size_of::<NativeDevModeW>() as u16;
        let read_ok = unsafe {
            (self.enum_settings)(wide_name.as_ptr(), ENUM_CURRENT_SETTINGS, &mut native, ENUM_MODE_FLAGS as u32)
        };
        if read_ok == 0 {
            return Err("Windows could not read the current DEVMODE before applying the display mode".into());
        }
        if !valid_reported_size(native.dm_size) || native_mode(&native) != *expected_current_mode {
            return Err("the current DEVMODE changed before the display-mode write".into());
        }

        // Recheck output identity and current mode after obtaining the raw
        // DEVMODE and immediately before calling User32. External Windows
        // writers can still race after this final snapshot: User32 has no CAS.
        self.validate_write_target(device_name, display_identity, expected_current_mode, target_mode)?;

        // Like Electron, only `dmPelsWidth`, `dmPelsHeight`, and
        // `dmDisplayFrequency` are writable request fields here. Non-zero
        // BPP/flags/orientation in the staged mode are compatibility checks;
        // they must match the current DEVMODE and are never rewritten.
        native.dm_pels_width = target_mode.width;
        native.dm_pels_height = target_mode.height;
        native.dm_display_frequency = target_mode.refresh_rate;
        native.dm_fields |= DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY;

        let result = unsafe {
            (self.change_settings)(wide_name.as_ptr(), &mut native, std::ptr::null_mut(), CDS_RESET, std::ptr::null_mut())
        };
        if result == DISP_CHANGE_SUCCESSFUL { Ok(()) }
        else { Err(format!("Windows rejected the requested display mode (result {result})")) }
    }
}

#[cfg(windows)]
impl<R: DisplayModeApi> NativeDisplayModesetApi<'_, R> {
    fn validate_write_target(
        &mut self,
        device_name: &str,
        display_identity: &str,
        expected_current_mode: &WindowsDisplayMode,
        target_mode: &WindowsDisplayMode,
    ) -> Result<(), String> {
        let snapshot = self.read_snapshot()?;
        if !snapshot.complete || snapshot.truncated {
            return Err("Windows display inventory is incomplete; refusing to change a display mode".into());
        }
        let mut matches = snapshot.outputs.into_iter()
            .filter(|output| output.device_name == device_name);
        let Some(output) = matches.next() else { return Err("the Windows display output is no longer present".into()) };
        if matches.next().is_some() { return Err("the Windows display output identity is ambiguous".into()); }
        let monitor_ids: Vec<_> = output.monitors.iter()
            .map(|monitor| monitor.device_id.as_str())
            .filter(|id| !id.is_empty())
            .collect();
        if monitor_ids.is_empty() || monitor_ids.join("|") != output.display_identity {
            return Err("a stable monitor PNP identity is unavailable for the Windows output".into());
        }
        if output.display_identity != display_identity {
            return Err("the Windows display identity changed".into());
        }
        if output.current_mode != *expected_current_mode {
            return Err("the current Windows display mode changed".into());
        }
        if !mode_supported(&output, target_mode) {
            return Err("the requested mode is not in the fresh Windows mode list".into());
        }
        Ok(())
    }
}

#[cfg(windows)]
fn native_mode(native: &NativeDevModeW) -> WindowsDisplayMode {
    let orientation = unsafe { native.dm_union.display.dm_display_orientation };
    WindowsDisplayMode {
        width: native.dm_pels_width,
        height: native.dm_pels_height,
        refresh_rate: native.dm_display_frequency,
        bits_per_pixel: native.dm_bits_per_pel,
        display_flags: native.dm_display_flags,
        orientation: orientation & 0xffff,
    }
}

#[cfg(windows)]
fn preserved_mode_fields_match(current: &WindowsDisplayMode, target: &WindowsDisplayMode) -> bool {
    (target.bits_per_pixel == 0 || target.bits_per_pixel == current.bits_per_pixel)
        && (target.display_flags == 0 || target.display_flags == current.display_flags)
        && (target.orientation == 0 || target.orientation == current.orientation)
}

#[cfg(windows)]
fn wide_nul(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn read_wide_z(value: &[u16]) -> String {
    let length = value.iter().position(|unit| *unit == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..length])
}

#[cfg(windows)]
#[repr(C)]
struct NativeDisplayDeviceW {
    cb: u32,
    device_name: [u16; 32],
    device_string: [u16; 128],
    state_flags: u32,
    device_id: [u16; 128],
    device_key: [u16; 128],
}

#[cfg(windows)]
impl Default for NativeDisplayDeviceW {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
struct NativeDisplayModeFields {
    position: [i32; 2],
    dm_display_orientation: u32,
    dm_display_fixed_output: u32,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Clone, Copy)]
union NativeDisplayModeUnion {
    printer: [i16; 8],
    display: NativeDisplayModeFields,
}

#[cfg(windows)]
#[repr(C)]
struct NativeDevModeW {
    dm_device_name: [u16; 32],
    dm_spec_version: u16,
    dm_driver_version: u16,
    dm_size: u16,
    dm_driver_extra: u16,
    dm_fields: u32,
    dm_union: NativeDisplayModeUnion,
    dm_color: i16,
    dm_duplex: i16,
    dm_y_resolution: i16,
    dm_tt_option: i16,
    dm_collate: i16,
    dm_form_name: [u16; 32],
    dm_log_pixels: u16,
    dm_bits_per_pel: u32,
    dm_pels_width: u32,
    dm_pels_height: u32,
    dm_display_flags: u32,
    dm_display_frequency: u32,
    dm_icm_method: u32,
    dm_icm_intent: u32,
    dm_media_type: u32,
    dm_dither_type: u32,
    dm_reserved1: u32,
    dm_reserved2: u32,
    dm_panning_width: u32,
    dm_panning_height: u32,
}

#[cfg(windows)]
impl Default for NativeDevModeW {
    fn default() -> Self { unsafe { std::mem::zeroed() } }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn EnumDisplayDevicesW(
        lp_device: *const u16,
        device_index: u32,
        display_device: *mut NativeDisplayDeviceW,
        flags: u32,
    ) -> i32;
    fn EnumDisplaySettingsExW(
        device_name: *const u16,
        mode_index: u32,
        devmode: *mut NativeDevModeW,
        flags: u32,
    ) -> i32;
    fn ChangeDisplaySettingsExW(
        device_name: *const u16,
        devmode: *mut NativeDevModeW,
        window: *mut std::ffi::c_void,
        flags: u32,
        lparam: *mut std::ffi::c_void,
    ) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const VALID_SIZE: u16 = 220;

    #[derive(Clone)]
    struct FakeOutput {
        adapter: RawDisplayDevice,
        monitors: Vec<RawDisplayDevice>,
        current: Option<RawMode>,
        modes: Vec<Option<RawMode>>,
    }

    struct FakeApi {
        outputs: Vec<FakeOutput>,
        mode_calls: usize,
    }

    impl DisplayModeApi for FakeApi {
        fn display_device(&mut self, parent: Option<&str>, index: usize) -> Option<RawDisplayDevice> {
            if let Some(parent) = parent {
                return self.outputs.iter().find(|output| output.adapter.device_name == parent)
                    .and_then(|output| output.monitors.get(index)).cloned();
            }
            self.outputs.get(index).map(|output| output.adapter.clone())
        }

        fn display_mode(&mut self, device_name: &str, index: u32) -> Option<RawMode> {
            self.mode_calls += 1;
            let output = self.outputs.iter().find(|output| output.adapter.device_name == device_name)?;
            if index == ENUM_CURRENT_SETTINGS { return output.current.clone(); }
            output.modes.get(index as usize).cloned().flatten()
        }
    }

    fn device(name: &str, label: &str, id: &str, flags: u32) -> RawDisplayDevice {
        RawDisplayDevice {
            device_name: name.to_string(),
            device_string: label.to_string(),
            state_flags: flags,
            device_id: id.to_string(),
        }
    }

    fn mode(width: u32, height: u32, refresh: u32) -> RawMode {
        RawMode {
            reported_size: VALID_SIZE,
            mode: WindowsDisplayMode {
                width,
                height,
                refresh_rate: refresh,
                bits_per_pixel: 32,
                display_flags: 0,
                orientation: 0,
            },
        }
    }

    fn fake_api(outputs: Vec<FakeOutput>) -> FakeApi {
        FakeApi { outputs, mode_calls: 0 }
    }

    #[cfg(windows)]
    struct FakeWin32ModesetState {
        current: WindowsDisplayMode,
        reported_size: u16,
        change_result: i32,
        enum_calls: usize,
        change_calls: Vec<(String, WindowsDisplayMode, u32, u32, bool, bool)>,
    }

    #[cfg(windows)]
    impl Default for FakeWin32ModesetState {
        fn default() -> Self {
            Self {
                current: WindowsDisplayMode {
                    width: 1920, height: 1080, refresh_rate: 60,
                    bits_per_pixel: 32, display_flags: 0, orientation: 0,
                },
                reported_size: DEVMODE_MAX_SIZE,
                change_result: DISP_CHANGE_SUCCESSFUL,
                enum_calls: 0,
                change_calls: Vec::new(),
            }
        }
    }

    #[cfg(windows)]
    thread_local! { static FAKE_WIN32_MODESET: RefCell<FakeWin32ModesetState> = RefCell::new(FakeWin32ModesetState::default()); }

    #[cfg(windows)]
    unsafe extern "system" fn fake_enum_current_settings(
        device_name: *const u16,
        mode_index: u32,
        raw: *mut NativeDevModeW,
        flags: u32,
    ) -> i32 {
        assert_eq!(read_wide_z(unsafe { std::slice::from_raw_parts(device_name, 32) }), "DISPLAY1");
        assert_eq!(mode_index, ENUM_CURRENT_SETTINGS);
        assert_eq!(flags, ENUM_MODE_FLAGS as u32);
        let native = unsafe { &mut *raw };
        FAKE_WIN32_MODESET.with(|state| {
            let mut state = state.borrow_mut();
            state.enum_calls += 1;
            native.dm_size = state.reported_size;
            native.dm_fields = 0x0000_0002;
            native.dm_bits_per_pel = state.current.bits_per_pixel;
            native.dm_pels_width = state.current.width;
            native.dm_pels_height = state.current.height;
            native.dm_display_flags = state.current.display_flags;
            native.dm_display_frequency = state.current.refresh_rate;
            native.dm_union = NativeDisplayModeUnion {
                display: NativeDisplayModeFields {
                    position: [0, 0],
                    dm_display_orientation: state.current.orientation,
                    dm_display_fixed_output: 0,
                },
            };
        });
        1
    }

    #[cfg(windows)]
    unsafe extern "system" fn fake_change_display_settings(
        device_name: *const u16,
        raw: *mut NativeDevModeW,
        window: *mut std::ffi::c_void,
        flags: u32,
        lparam: *mut std::ffi::c_void,
    ) -> i32 {
        let name = read_wide_z(unsafe { std::slice::from_raw_parts(device_name, 32) });
        let native = unsafe { &*raw };
        let actual = native_mode(native);
        FAKE_WIN32_MODESET.with(|state| {
            let mut state = state.borrow_mut();
            state.change_calls.push((name, actual, native.dm_fields, flags, window.is_null(), lparam.is_null()));
            state.change_result
        })
    }

    #[cfg(windows)]
    fn fake_native_modeset_api<'a>(
        display_guard: &'a super::super::display_lock::DisplayLockGuard,
        current: WindowsDisplayMode,
    ) -> NativeDisplayModesetApi<'a, FakeApi> {
        NativeDisplayModesetApi {
            _display_guard: display_guard,
            reader: fake_api(vec![FakeOutput {
                adapter: device("DISPLAY1", "Panel A", "GPU-A", DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
                monitors: vec![device("MONITOR1", "Panel A", "MONITOR-A", 0)],
                current: Some(RawMode { reported_size: VALID_SIZE, mode: current.clone() }),
                modes: vec![
                    Some(RawMode { reported_size: VALID_SIZE, mode: current }),
                    Some(mode(2560, 1440, 120)),
                    None,
                ],
            }]),
            enum_settings: fake_enum_current_settings,
            change_settings: fake_change_display_settings,
        }
    }

    #[test]
    fn enumerates_only_attached_outputs_with_current_and_deduplicated_supported_modes() {
        let mut api = fake_api(vec![
            FakeOutput {
                adapter: device("\\\\.\\DISPLAY1", "Intel Adapter", "GPU-A", DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
                monitors: vec![device("MONITOR1", "Panel A", "MONITOR-A", 0)],
                current: Some(mode(1920, 1080, 180)),
                modes: vec![
                    Some(mode(1920, 1080, 180)),
                    Some(mode(3840, 2160, 120)),
                    Some(mode(3840, 2160, 120)),
                    None,
                ],
            },
            FakeOutput {
                adapter: device("\\\\.\\DISPLAY2", "Inactive Adapter", "GPU-B", 0),
                monitors: vec![],
                current: Some(mode(1920, 1080, 60)),
                modes: vec![Some(mode(1920, 1080, 60)), None],
            },
        ]);

        let snapshot = enumerate_with(&mut api);
        assert!(snapshot.complete);
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.outputs.len(), 1);
        assert_eq!(snapshot.outputs[0].current_mode.width, 1920);
        assert_eq!(snapshot.outputs[0].current_mode.refresh_rate, 180);
        assert_eq!(snapshot.outputs[0].modes.len(), 2);
        assert_eq!(snapshot.outputs[0].display_identity, "MONITOR-A");
    }

    #[test]
    fn rejects_invalid_devmode_sizes_and_modes_but_keeps_scanning_the_bounded_list() {
        let mut bad_size = mode(2560, 1440, 60);
        bad_size.reported_size = 187;
        let too_large = mode(40000, 2160, 60);
        let mut api = fake_api(vec![FakeOutput {
            adapter: device("DISPLAY1", "Panel A", "GPU-A", DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
            monitors: vec![],
            current: Some(mode(1920, 1080, 60)),
            modes: vec![Some(bad_size), Some(too_large), Some(mode(2560, 1440, 60)), None],
        }]);

        let snapshot = enumerate_with(&mut api);
        assert!(!snapshot.complete);
        assert!(!snapshot.truncated);
        assert_eq!(snapshot.outputs[0].modes, vec![mode(2560, 1440, 60).mode]);
    }

    #[test]
    fn resolver_uses_device_identity_and_rejects_ambiguous_labels() {
        let mut api = fake_api(vec![
            FakeOutput {
                adapter: device("DISPLAY1", "Intel Adapter", "GPU-A", DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
                monitors: vec![device("MONITOR1", "Panel A", "MONITOR-A", 0)],
                current: Some(mode(1920, 1080, 60)),
                modes: vec![Some(mode(1920, 1080, 60)), None],
            },
            FakeOutput {
                adapter: device("DISPLAY2", "Intel Adapter", "GPU-B", DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
                monitors: vec![device("MONITOR2", "Panel A", "MONITOR-B", 0)],
                current: Some(mode(2560, 1440, 144)),
                modes: vec![Some(mode(2560, 1440, 144)), None],
            },
        ]);
        let snapshot = enumerate_with(&mut api);

        let request = DisplayModeRequest {
            display_name: Some("Panel A"),
            resolution: Some((2560, 1440)),
            refresh_rate: Some(144.0),
            ..Default::default()
        };
        assert_eq!(resolve_output(&snapshot, &request).unwrap().device_name, "DISPLAY2");

        let ambiguous = DisplayModeRequest { display_name: Some("Intel Adapter"), ..Default::default() };
        assert_eq!(resolve_output(&snapshot, &ambiguous).unwrap_err(), DisplayResolveError::Ambiguous);

        let wrong_identity = DisplayModeRequest {
            device_name: Some("DISPLAY1"),
            display_identity: Some("MONITOR-B"),
            ..Default::default()
        };
        assert_eq!(resolve_output(&snapshot, &wrong_identity).unwrap_err(), DisplayResolveError::NotFound);
        let contradictory_identity = DisplayModeRequest {
            display_identity: Some("MONITOR-A"), display_name: Some("Panel A"),
            resolution: Some((2560, 1440)), refresh_rate: Some(144.0), ..Default::default()
        };
        assert_eq!(resolve_output(&snapshot, &contradictory_identity).unwrap_err(), DisplayResolveError::NotFound);
    }

    #[test]
    fn marks_mode_inventory_truncated_when_a_row_exists_beyond_the_limit() {
        let modes = (0..=MODE_LIMIT).map(|_| Some(mode(1920, 1080, 60))).collect();
        let mut api = fake_api(vec![FakeOutput {
            adapter: device("DISPLAY1", "Panel A", "GPU-A", DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
            monitors: vec![],
            current: Some(mode(1920, 1080, 60)),
            modes,
        }]);

        let snapshot = enumerate_with(&mut api);
        assert!(!snapshot.complete);
        assert!(snapshot.truncated);
        assert!(snapshot.outputs[0].modes.len() == 1);
        assert_eq!(api.mode_calls, MODE_LIMIT + 2); // current, bounded list, one overflow probe
    }

    #[test]
    fn adapter_and_monitor_overflow_mark_inventory_incomplete() {
        let output = FakeOutput {
            adapter: device("DISPLAY1", "Panel A", "GPU-A", DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
            monitors: vec![], current: Some(mode(1920, 1080, 60)), modes: vec![None],
        };
        let mut adapters = fake_api(vec![output.clone(); DISPLAY_DEVICE_LIMIT + 1]);
        let snapshot = enumerate_with(&mut adapters);
        assert!(snapshot.truncated && !snapshot.complete);
        let mut many_monitors = output;
        many_monitors.monitors = vec![device("MONITOR", "Panel", "ID", 0); MONITOR_DEVICE_LIMIT + 1];
        let snapshot = enumerate_with(&mut fake_api(vec![many_monitors]));
        assert!(snapshot.truncated && !snapshot.complete);
    }

    #[test]
    fn invalid_current_geometry_makes_snapshot_incomplete() {
        for (width, height) in [(0, 1080), (1920, 0), (32_769, 1080)] {
            let mut api = fake_api(vec![FakeOutput {
                adapter: device("DISPLAY1", "Panel A", "GPU-A", DISPLAY_DEVICE_ATTACHED_TO_DESKTOP),
                monitors: vec![], current: Some(mode(width, height, 60)), modes: vec![None],
            }]);
            let snapshot = enumerate_with(&mut api);
            assert!(!snapshot.complete);
            assert!(snapshot.outputs.is_empty());
        }
    }

    fn output(device_name: &str, identity: &str, current_mode: WindowsDisplayMode) -> WindowsDisplayOutput {
        WindowsDisplayOutput {
            device_name: device_name.to_owned(),
            display_name: "Panel A".to_owned(),
            device_id: "GPU-A".to_owned(),
            monitors: vec![],
            current_mode,
            modes: vec![mode(1920, 1080, 60).mode, mode(2560, 1440, 120).mode],
            display_identity: identity.to_owned(),
        }
    }

    struct FakeModesetApi {
        snapshot: WindowsDisplayModeSnapshot,
        writes: Vec<(String, WindowsDisplayMode)>,
        fail_first_after_write: bool,
        change_before_rollback: Option<WindowsDisplayMode>,
        change_after_first_write: Option<WindowsDisplayMode>,
    }

    impl DisplayModesetApi for FakeModesetApi {
        fn read_snapshot(&mut self) -> Result<WindowsDisplayModeSnapshot, String> {
            Ok(self.snapshot.clone())
        }

        fn set_mode_if_unchanged(
            &mut self,
            device_name: &str,
            display_identity: &str,
            expected_current_mode: &WindowsDisplayMode,
            target_mode: &WindowsDisplayMode,
        ) -> Result<(), String> {
            if self.writes.len() == 1 {
                if let Some(mode) = self.change_before_rollback.take() {
                    self.snapshot.outputs[0].current_mode = mode;
                }
            }
            let Some(output) = self.snapshot.outputs.iter_mut()
                .find(|output| output.device_name == device_name)
            else { return Err("output missing".into()) };
            if output.display_identity != display_identity || output.current_mode != *expected_current_mode {
                return Err("conditional write guard changed".into());
            }
            output.current_mode = target_mode.clone();
            self.writes.push((device_name.to_owned(), target_mode.clone()));
            if self.writes.len() == 1 {
                if let Some(mode) = self.change_after_first_write.take() {
                    self.snapshot.outputs[0].current_mode = mode;
                }
                if self.fail_first_after_write {
                    return Err("simulated write error after mode changed".into());
                }
            }
            Ok(())
        }
    }

    fn modeset_request() -> DisplayModesetRequest {
        DisplayModesetRequest {
            guard: DisplayModesetGuard {
                device_name: "DISPLAY1".into(),
                display_identity: "MONITOR-A".into(),
                expected_current_mode: mode(1920, 1080, 60).mode,
            },
            target_mode: mode(2560, 1440, 120).mode,
        }
    }

    fn fake_modeset_api(current_mode: WindowsDisplayMode) -> FakeModesetApi {
        FakeModesetApi {
            snapshot: WindowsDisplayModeSnapshot {
                outputs: vec![output("DISPLAY1", "MONITOR-A", current_mode)],
                complete: true,
                truncated: false,
            },
            writes: vec![],
            fail_first_after_write: false,
            change_before_rollback: None,
            change_after_first_write: None,
        }
    }

    fn run_modeset(api: &mut FakeModesetApi, request: &DisplayModesetRequest) -> DisplayModesetResult {
        let display_guard = super::super::display_lock::acquire().expect("Display lock acquired for staged transaction test");
        transact_display_mode(&display_guard, api, request)
    }

    #[test]
    fn staged_modeset_requires_complete_identity_and_current_mode_guards_before_writing() {
        let mut stale = fake_modeset_api(mode(1280, 720, 60).mode);
        let result = run_modeset(&mut stale, &modeset_request());
        assert_eq!(result.error, Some(DisplayModesetError::CurrentModeChanged));
        assert!(stale.writes.is_empty());

        let mut replaced = fake_modeset_api(mode(1920, 1080, 60).mode);
        replaced.snapshot.outputs[0].display_identity = "MONITOR-B".into();
        let result = run_modeset(&mut replaced, &modeset_request());
        assert_eq!(result.error, Some(DisplayModesetError::IdentityMismatch));
        assert!(replaced.writes.is_empty());

        let mut incomplete = fake_modeset_api(mode(1920, 1080, 60).mode);
        incomplete.snapshot.complete = false;
        let result = run_modeset(&mut incomplete, &modeset_request());
        assert_eq!(result.error, Some(DisplayModesetError::IncompleteSnapshot));
        assert!(incomplete.writes.is_empty());

        let mut truncated = fake_modeset_api(mode(1920, 1080, 60).mode);
        truncated.snapshot.truncated = true;
        let result = run_modeset(&mut truncated, &modeset_request());
        assert_eq!(result.error, Some(DisplayModesetError::IncompleteSnapshot));
        assert!(truncated.writes.is_empty());
    }

    #[test]
    fn staged_modeset_applies_only_supported_target_and_verifies_fresh_readback() {
        let mut api = fake_modeset_api(mode(1920, 1080, 60).mode);
        let result = run_modeset(&mut api, &modeset_request());
        assert!(result.ok);
        assert_eq!(api.writes, vec![("DISPLAY1".into(), mode(2560, 1440, 120).mode)]);
        assert_eq!(api.snapshot.outputs[0].current_mode, mode(2560, 1440, 120).mode);

        let mut unsupported = fake_modeset_api(mode(1920, 1080, 60).mode);
        let mut request = modeset_request();
        request.target_mode = mode(3840, 2160, 120).mode;
        let result = run_modeset(&mut unsupported, &request);
        assert_eq!(result.error, Some(DisplayModesetError::UnsupportedMode));
        assert!(unsupported.writes.is_empty());
    }

    #[test]
    fn failed_write_rolls_back_only_while_identity_and_written_mode_still_match() {
        let initial = mode(1920, 1080, 60).mode;
        let target = mode(2560, 1440, 120).mode;
        let mut api = fake_modeset_api(initial.clone());
        api.fail_first_after_write = true;
        let result = run_modeset(&mut api, &modeset_request());
        assert_eq!(result.error, Some(DisplayModesetError::ApplyFailed("simulated write error after mode changed".into())));
        assert!(result.rollback_attempted && result.rollback_verified);
        assert_eq!(api.writes, vec![("DISPLAY1".into(), target.clone()), ("DISPLAY1".into(), initial.clone())]);
        assert_eq!(api.snapshot.outputs[0].current_mode, initial);

        let mut concurrent = fake_modeset_api(mode(1920, 1080, 60).mode);
        concurrent.fail_first_after_write = true;
        let external = mode(1280, 720, 60).mode;
        concurrent.change_before_rollback = Some(external.clone());
        let result = run_modeset(&mut concurrent, &modeset_request());
        assert!(result.rollback_attempted);
        assert!(!result.rollback_verified);
        assert_eq!(concurrent.writes.len(), 1, "guard rejects rollback after an external mode change");
        assert_eq!(concurrent.snapshot.outputs[0].current_mode, external);
    }

    #[test]
    fn modeset_does_not_rollback_a_mode_changed_by_another_writer() {
        let mut api = fake_modeset_api(mode(1920, 1080, 60).mode);
        let external = mode(1280, 720, 60).mode;
        api.change_after_first_write = Some(external.clone());
        let result = run_modeset(&mut api, &modeset_request());
        assert_eq!(result.error, Some(DisplayModesetError::ReadbackMismatch));
        assert!(!result.rollback_attempted);
        assert_eq!(api.writes.len(), 1);
        assert_eq!(api.snapshot.outputs[0].current_mode, external);
    }

    #[cfg(windows)]
    #[test]
    fn native_win32_structure_layout_matches_user32_contract() {
        use std::mem::{offset_of, size_of};
        assert_eq!(size_of::<NativeDisplayDeviceW>(), 840);
        assert_eq!(offset_of!(NativeDisplayDeviceW, state_flags), 324);
        assert_eq!(size_of::<NativeDevModeW>(), 220);
        assert_eq!(offset_of!(NativeDevModeW, dm_size), 68);
        assert_eq!(offset_of!(NativeDevModeW, dm_fields), 72);
        assert_eq!(offset_of!(NativeDevModeW, dm_bits_per_pel), 168);
        assert_eq!(offset_of!(NativeDevModeW, dm_pels_width), 172);
        assert_eq!(offset_of!(NativeDevModeW, dm_pels_height), 176);
        assert_eq!(offset_of!(NativeDevModeW, dm_display_flags), 180);
        assert_eq!(offset_of!(NativeDevModeW, dm_display_frequency), 184);
    }

    #[cfg(windows)]
    #[test]
    fn native_modeset_revalidates_identity_and_uses_only_electron_mode_fields() {
        let current = mode(1920, 1080, 60).mode;
        let target = mode(2560, 1440, 120).mode;
        FAKE_WIN32_MODESET.with(|state| *state.borrow_mut() = FakeWin32ModesetState {
            current: current.clone(), ..FakeWin32ModesetState::default()
        });
        let guard = super::super::display_lock::acquire().unwrap();
        let mut api = fake_native_modeset_api(&guard, current.clone());
        api.set_mode_if_unchanged("DISPLAY1", "MONITOR-A", &current, &target).unwrap();

        FAKE_WIN32_MODESET.with(|state| {
            let state = state.borrow();
            assert_eq!(state.enum_calls, 1);
            assert_eq!(state.change_calls, vec![(
                "DISPLAY1".into(),
                WindowsDisplayMode { width: 2560, height: 1440, refresh_rate: 120, ..current.clone() },
                0x0000_0002 | DM_PELSWIDTH | DM_PELSHEIGHT | DM_DISPLAYFREQUENCY,
                CDS_RESET,
                true,
                true,
            )]);
        });
    }

    #[cfg(windows)]
    #[test]
    fn native_modeset_refuses_stale_identity_and_unwritable_auxiliary_fields() {
        let current = mode(1920, 1080, 60).mode;
        let guard = super::super::display_lock::acquire().unwrap();

        for (identity, target) in [
            ("MONITOR-B", mode(2560, 1440, 120).mode),
            ("MONITOR-A", WindowsDisplayMode { bits_per_pixel: 24, ..mode(2560, 1440, 120).mode }),
            ("MONITOR-A", WindowsDisplayMode { display_flags: 1, ..mode(2560, 1440, 120).mode }),
            ("MONITOR-A", WindowsDisplayMode { orientation: 1, ..mode(2560, 1440, 120).mode }),
        ] {
            FAKE_WIN32_MODESET.with(|state| *state.borrow_mut() = FakeWin32ModesetState {
                current: current.clone(), ..FakeWin32ModesetState::default()
            });
            let mut api = fake_native_modeset_api(&guard, current.clone());
            assert!(api.set_mode_if_unchanged("DISPLAY1", identity, &current, &target).is_err());
            FAKE_WIN32_MODESET.with(|state| {
                let state = state.borrow();
                assert!(state.change_calls.is_empty(), "invalid request must not call ChangeDisplaySettingsExW");
            });
        }
    }

    fn bounds_output(label: &str, identity: &str, modes: Vec<WindowsDisplayMode>) -> WindowsDisplayOutput {
        WindowsDisplayOutput {
            device_name: "DISPLAY1".into(),
            display_name: label.into(),
            device_id: "GPU-A".into(),
            monitors: vec![],
            current_mode: modes[0].clone(),
            modes,
            display_identity: identity.into(),
        }
    }

    fn bounds_snapshot(outputs: Vec<WindowsDisplayOutput>) -> WindowsDisplayModeSnapshot {
        WindowsDisplayModeSnapshot { outputs, complete: true, truncated: false }
    }

    fn refresh_modes(resolution: (u32, u32), rates: &[u32]) -> Vec<WindowsDisplayMode> {
        rates.iter().map(|rate| WindowsDisplayMode {
            width: resolution.0, height: resolution.1, refresh_rate: *rate,
            bits_per_pixel: 32, display_flags: 0, orientation: 0,
        }).collect()
    }

    #[test]
    fn refresh_bounds_intersect_the_display_mode_list_with_the_monitor_window() {
        let snapshot = bounds_snapshot(vec![bounds_output("Panel A", "MONITOR-A",
            refresh_modes((1920, 1080), &[48, 60, 100, 144, 165, 180, 240]))]);

        // A 48-240 display inside a 48-180 driver window is 48-180.
        assert_eq!(arc_sync_range_bounds(Some(&snapshot), Some("Panel A"), Some((1920, 1080)), 48.0, 180.0),
            Some((48.0, 180.0)));
        // A 60-240 display inside a 30-240 driver window is 60-240: the mode
        // list narrows the floor and the driver window stays the ceiling.
        let slow = bounds_snapshot(vec![bounds_output("Panel B", "MONITOR-B",
            refresh_modes((1920, 1080), &[60, 120, 165, 240]))]);
        assert_eq!(arc_sync_range_bounds(Some(&slow), Some("Panel B"), Some((1920, 1080)), 30.0, 240.0),
            Some((60.0, 240.0)));
        // The driver window is the binding ceiling when the display offers more.
        assert_eq!(arc_sync_range_bounds(Some(&snapshot), Some("Panel A"), Some((1920, 1080)), 60.0, 120.0),
            Some((60.0, 120.0)));
    }

    #[test]
    fn refresh_bounds_use_the_current_resolution_then_fall_back_to_the_whole_list() {
        let mut modes = refresh_modes((1920, 1080), &[48, 60, 144, 180]);
        modes.extend(refresh_modes((2560, 1440), &[60, 120]));
        let snapshot = bounds_snapshot(vec![bounds_output("Panel A", "MONITOR-A", modes)]);

        assert_eq!(display_refresh_bounds(&snapshot, Some("Panel A"), Some((1920, 1080))), Some((48, 180)));
        // A resolution with no row uses the display's whole mode list.
        assert_eq!(display_refresh_bounds(&snapshot, Some("Panel A"), Some((3840, 2160))), Some((48, 180)));
        // The overall list spans both resolutions.
        assert_eq!(display_refresh_bounds(&snapshot, Some("Panel A"), Some((2560, 1440))), Some((60, 120)));
        assert_eq!(display_refresh_bounds(&snapshot, Some("Panel A"), None), Some((48, 180)));
    }

    #[test]
    fn refresh_bounds_fall_back_to_the_driver_window_when_the_join_is_unusable() {
        // The real B580 case: Windows reports the adapter label and the
        // monitor's generic/PNP identity, not the EDID monitor name IGCL
        // returns, so the exact-label join selects no output.
        let real_world = bounds_snapshot(vec![WindowsDisplayOutput {
            device_name: "\\\\.\\DISPLAY1".into(),
            display_name: "Intel(R) Arc(TM) B580 Graphics".into(),
            device_id: "PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000".into(),
            monitors: vec![WindowsDisplayMonitor {
                device_name: "MONITOR1".into(),
                device_string: "Generic PnP Monitor".into(),
                state_flags: 0,
                device_id: "MONITOR\\MSI3C4\\{4d36e96e-e325-11ce-bfc1-08002be10318}\\0004".into(),
            }],
            current_mode: refresh_modes((1920, 1080), &[180])[0].clone(),
            modes: refresh_modes((1920, 1080), &[48, 60, 120, 144, 180]),
            display_identity: "MONITOR-REAL".into(),
        }]);
        // The narrowing helper cannot identify the row...
        assert_eq!(display_refresh_bounds(&real_world, Some("MSI G27C4 E3"), Some((1920, 1080))), None);
        // ...but the driver's own window is still admitted.
        assert_eq!(arc_sync_range_bounds(Some(&real_world), Some("MSI G27C4 E3"), Some((1920, 1080)),
            48.0, 180.0), Some((48.0, 180.0)));

        // Ambiguous, incomplete, truncated, empty, single-value, and
        // unreadable inventories are all narrowing failures, not hard gates.
        let ambiguous = bounds_snapshot(vec![
            bounds_output("Panel A", "MONITOR-A", refresh_modes((1920, 1080), &[48, 180])),
            bounds_output("Panel A", "MONITOR-B", refresh_modes((1920, 1080), &[60, 120])),
        ]);
        assert_eq!(arc_sync_range_bounds(Some(&ambiguous), Some("Panel A"), None, 48.0, 180.0),
            Some((48.0, 180.0)));

        let mut incomplete = bounds_snapshot(vec![bounds_output("Panel A", "MONITOR-A",
            refresh_modes((1920, 1080), &[48, 180]))]);
        incomplete.complete = false;
        assert_eq!(arc_sync_range_bounds(Some(&incomplete), Some("Panel A"), None, 48.0, 180.0),
            Some((48.0, 180.0)));

        let mut truncated = bounds_snapshot(vec![bounds_output("Panel A", "MONITOR-A",
            refresh_modes((1920, 1080), &[48, 180]))]);
        truncated.truncated = true;
        assert_eq!(arc_sync_range_bounds(Some(&truncated), Some("Panel A"), None, 48.0, 180.0),
            Some((48.0, 180.0)));

        let empty = bounds_snapshot(vec![WindowsDisplayOutput {
            modes: Vec::new(), ..bounds_output("Panel A", "MONITOR-A", refresh_modes((1920, 1080), &[60, 120]))
        }]);
        assert_eq!(arc_sync_range_bounds(Some(&empty), Some("Panel A"), None, 48.0, 180.0),
            Some((48.0, 180.0)));

        let single = bounds_snapshot(vec![bounds_output("Panel A", "MONITOR-A",
            refresh_modes((1920, 1080), &[60]))]);
        assert_eq!(arc_sync_range_bounds(Some(&single), Some("Panel A"), None, 48.0, 180.0),
            Some((48.0, 180.0)));

        // No label at all, or no inventory at all, keeps the driver window.
        let joined = bounds_snapshot(vec![bounds_output("Panel A", "MONITOR-A",
            refresh_modes((1920, 1080), &[48, 180]))]);
        assert_eq!(arc_sync_range_bounds(Some(&joined), None, None, 48.0, 180.0), Some((48.0, 180.0)));
        assert_eq!(arc_sync_range_bounds(Some(&joined), Some(""), None, 48.0, 180.0), Some((48.0, 180.0)));
        assert_eq!(arc_sync_range_bounds(None, Some("Panel A"), Some((1920, 1080)), 48.0, 180.0),
            Some((48.0, 180.0)));

        // A disjoint join is contradictory data: the mode list narrows, it
        // never vetoes, so the driver window stands unchanged.
        let disjoint = bounds_snapshot(vec![bounds_output("Panel A", "MONITOR-A",
            refresh_modes((1920, 1080), &[120, 144]))]);
        assert_eq!(arc_sync_range_bounds(Some(&disjoint), Some("Panel A"), None, 48.0, 90.0),
            Some((48.0, 90.0)));

        // The presented narrowing helper still refuses an incomplete or
        // ambiguous inventory on its own.
        assert_eq!(display_refresh_bounds(&incomplete, Some("Panel A"), None), None);
        assert_eq!(display_refresh_bounds(&truncated, Some("Panel A"), None), None);
        assert_eq!(display_refresh_bounds(&ambiguous, Some("Panel A"), None), None);
        assert_eq!(display_refresh_bounds(&joined, Some("Panel B"), None), None);
        assert_eq!(display_refresh_bounds(&joined, None, None), None);
        assert_eq!(display_refresh_bounds(&joined, Some(""), None), None);
    }

    #[test]
    fn refresh_bounds_use_the_driver_window_verbatim_and_fail_closed_only_when_it_is_unusable() {
        // An arbitrary window exposes any hidden ceiling or floor: the driver
        // value is returned exactly, with no assumption about Intel hardware.
        assert_eq!(arc_sync_range_bounds(None, Some("MSI G27C4 E3"), Some((1920, 1080)), 31.5, 211.0),
            Some((31.5, 211.0)));
        let unmatched = bounds_snapshot(vec![bounds_output("Panel B", "MONITOR-B",
            refresh_modes((1920, 1080), &[60, 240]))]);
        assert_eq!(arc_sync_range_bounds(Some(&unmatched), Some("MSI G27C4 E3"), None, 31.5, 211.0),
            Some((31.5, 211.0)));

        // Degenerate or unreadable driver windows admit no custom range.
        for (min_hz, max_hz) in [
            (0.0, 180.0), (-48.0, 180.0), (48.0, 48.0), (180.0, 48.0),
            (f32::NAN, 180.0), (48.0, f32::INFINITY),
        ] {
            assert_eq!(arc_sync_range_bounds(None, Some("Panel A"), None, min_hz, max_hz), None,
                "driver window {min_hz}-{max_hz} admits no custom range");
        }
    }

    #[test]
    fn refresh_bounds_fall_back_to_the_mode_list_when_the_driver_reports_no_window() {
        // A real driver can report Arc Sync support with a 0-0 Hz window. The
        // display's own Windows mode list is still a per-system capability read
        // and must keep the control available instead of disabling the row.
        let matched = bounds_snapshot(vec![bounds_output("Panel A", "MONITOR-A",
            refresh_modes((1920, 1080), &[48, 60, 120, 180]))]);
        assert_eq!(arc_sync_range_bounds(Some(&matched), Some("Panel A"), Some((1920, 1080)), 0.0, 0.0),
            Some((48.0, 180.0)));
        assert_eq!(arc_sync_range_bounds(Some(&matched), Some("Panel A"), None, f32::NAN, 48.0),
            Some((48.0, 180.0)));
        // With neither source usable there is still nothing honest to admit.
        assert_eq!(arc_sync_range_bounds(None, Some("Panel A"), Some((1920, 1080)), 0.0, 0.0), None);
    }

    #[test]
    fn refresh_bounds_require_a_usable_intersection() {
        // The two windows are disjoint: no custom range can be admitted.
        assert_eq!(intersect_refresh_bounds((48, 90), (120.0, 180.0)), None);
        // A single shared value is degenerate for a min < max request.
        assert_eq!(intersect_refresh_bounds((48, 120), (120.0, 240.0)), None);
        assert_eq!(intersect_refresh_bounds((48, 180), (f32::NAN, 180.0)), None);
        assert_eq!(intersect_refresh_bounds((48, 180), (48.0, 180.0)), Some((48.0, 180.0)));
    }

    #[cfg(windows)]
    #[test]
    fn native_modeset_rejects_stale_raw_devmode_and_preserves_user32_failure() {
        let current = mode(1920, 1080, 60).mode;
        let target = mode(2560, 1440, 120).mode;
        let guard = super::super::display_lock::acquire().unwrap();

        FAKE_WIN32_MODESET.with(|state| *state.borrow_mut() = FakeWin32ModesetState {
            current: mode(1280, 720, 60).mode,
            ..FakeWin32ModesetState::default()
        });
        let mut stale = fake_native_modeset_api(&guard, current.clone());
        assert!(stale.set_mode_if_unchanged("DISPLAY1", "MONITOR-A", &current, &target).is_err());
        FAKE_WIN32_MODESET.with(|state| assert!(state.borrow().change_calls.is_empty()));

        FAKE_WIN32_MODESET.with(|state| *state.borrow_mut() = FakeWin32ModesetState {
            current: current.clone(), reported_size: 187,
            ..FakeWin32ModesetState::default()
        });
        let mut malformed = fake_native_modeset_api(&guard, current.clone());
        assert!(malformed.set_mode_if_unchanged("DISPLAY1", "MONITOR-A", &current, &target).is_err());
        FAKE_WIN32_MODESET.with(|state| assert!(state.borrow().change_calls.is_empty()));

        FAKE_WIN32_MODESET.with(|state| *state.borrow_mut() = FakeWin32ModesetState {
            current: current.clone(), change_result: -2,
            ..FakeWin32ModesetState::default()
        });
        let mut rejected = fake_native_modeset_api(&guard, current.clone());
        let error = rejected.set_mode_if_unchanged("DISPLAY1", "MONITOR-A", &current, &target).unwrap_err();
        assert!(error.contains("result -2"));
        FAKE_WIN32_MODESET.with(|state| assert_eq!(state.borrow().change_calls.len(), 1));
    }
}
