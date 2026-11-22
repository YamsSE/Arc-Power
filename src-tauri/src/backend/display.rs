//! Native read-only Display surface (`display:get`).
//!
//! Port of Electron's `igcl-backend.js#getDisplaySettings` / `_displayOutputsOf`
//! / `_readDisplayOutput`. This slice owns display properties (identity,
//! connection, flags, HDCP/HDR capability bits, timing), the
//! `ctlGetSetDisplaySettings` GET (quantization range), the EDID /
//! panel-descriptor identity, the colour path (`ctlGetSetWireFormat` GET plus
//! the output pixel transformation), scaling (capability bitmask, current
//! settings at version 1 with the version-0 fallback, and the persisted
//! Arc Power scaling preference) and retro scaling (capability bitmask plus the
//! current enabled/type pair).
//!
//! The read-only Arc Sync monitor capability/current profile and global VRR
//! mode are also covered, as are color capabilities and saved intent (never
//! current driver calibration). Display Super Resolution is not part of this
//! read surface. An elevated, non-mock service route owns only candidates that
//! pass the complete-response preflight and guarded scaling reconciliation.
//! The separate service arm also routes only isolated quantization or Retro
//! Scaling applies when a full response can be returned under the same guard.
//! Keyed read candidates whose response is not proven equivalent fail closed
//! because the broker cannot hold this cross-host guard while it validates the
//! expected adapter key.
//!
//! No driver control is written here: every shared GET/SET export is called in
//! GET mode (`Set = 0`, `Operation = 0`, `Get = 1`) with `Size`/`Version` set
//! and no valid flags. A stale saved identity-scaling selection is returned as
//! a conditional reconciliation intent. A native owner can commit it only
//! while holding the cross-host Display mutex and after exact output, driver
//! tuple and saved-record revalidation. Candidates that may depend on
//! Electron's broader Windows active/timing fallback or duplicate output
//! identities are refused before reconciliation.
//!
//! Output handles are topology-scoped. They are re-enumerated on every read and
//! never cached, exactly like the oracle, so a hot-plug cannot leave the view on
//! stale handles.

use super::display_scaling_state::{DisplayScalingStore, ScalingSelection};
use super::display_color_capabilities::ColorCapabilityClassification;
use super::display_color_projection::project_color;
use super::display_color_state::{ColorState, DisplayColorStore};
use super::windows_display_modes::{
    WindowsDisplayModeSnapshot,
};
#[cfg(test)]
use super::windows_display_modes::WindowsDisplayMode;
use super::igcl_raw::{
    ctl_display_properties_t, ctl_display_settings_t, ctl_display_timing_t,
    ctl_intel_arc_sync_monitor_params_t, ctl_intel_arc_sync_profile_params_t,
    ctl_get_set_wire_format_config_t, ctl_retro_scaling_settings_t, ctl_scaling_settings_t,
};
use super::igcl_read_only::{describe_pixel_transformation_result, PixelTransformation, ReadOnlyIgcl};
use serde_json::{json, Value};
use std::ffi::c_void;

/// `ctl_std_display_feature_flag_t` values decoded by the oracle.
const DISPLAY_FEATURE_HDCP: u32 = 1 << 0;
const DISPLAY_FEATURE_HDR: u32 = 1 << 5;
/// `ctl_display_setting_flag_t` QUANTIZATION_RANGE (the Controllable bit).
const DISPLAY_SETTING_QUANTIZATION_RANGE: u32 = 1 << 3;
const DISPLAY_STALE_DEVICE_ERROR: &str = "The selected graphics adapter changed; refresh Display and try again.";
/// `ctl_display_config_flag_t`: active / attached / dongle / dithering.
pub(crate) const DISPLAY_CONFIG_ACTIVE: u32 = 1 << 0;
const DISPLAY_CONFIG_ATTACHED: u32 = 1 << 1;
const DISPLAY_CONFIG_DONGLE: u32 = 1 << 2;
const DISPLAY_CONFIG_DITHERING: u32 = 1 << 3;

const QUANTIZATION_OPTIONS: [&str; 3] = ["default", "limited", "full"];
/// `CTL_DISPLAY_BPC_FROM_FLAG`, in the oracle's table order.
const BPC_FLAGS: [(u32, u32); 4] = [(1, 6), (2, 8), (4, 10), (8, 12)];
/// `CTL_SCALING_TYPE` (bit index -> canonical name), in table order.
const SCALING_CAPS_NAMES: [&str; 5] =
    ["identity", "centered", "stretched", "aspect-ratio-centered-max", "custom"];
/// `CTL_RETRO_SCALING_TYPE` (bit index -> canonical name), in table order.
const RETRO_CAPS_NAMES: [&str; 2] = ["integer", "nearest-neighbour"];
const ARC_SYNC_PROFILE_NAMES: [&str; 7] = [
    "recommended", "excellent", "good", "compatible", "off", "vesa", "custom",
];
const ARC_SYNC_OFF_PROFILE: i32 = 5;
const GLOBAL_VRR_FEATURE: i32 = 14;
const GLOBAL_VRR_ENUM_VALUE_TYPE: i32 = 4;
const GLOBAL_VRR_SCOPE_SELECTION_ERROR: &str = "The global Variable Refresh Rate GET requires a driver scope-selection write; the native read is unavailable.";
pub(crate) const DISPLAY_READ_UNPROVEN_ERROR: &str = "The selected Display state could not be verified; refresh Display and try again.";
const GLOBAL_VRR_MODES: [(u32, &str); 3] = [
    (0, "fullscreen"), (1, "fullscreen-windowed"), (2, "disabled"),
];
/// The GPU-scaling methods the oracle treats as a GPU-side preference.
const GPU_SCALING_MODES: [&str; 3] = ["centered", "stretched", "aspect-ratio-centered-max"];

/// `getScalingWithCompatibility`'s answer: which version replied and what it
/// returned. `version` is 1 when the driver exposes PreferredScalingType.
pub(crate) struct ScalingRead {
    pub(crate) version: u8,
    pub(crate) settings: ctl_scaling_settings_t,
}

/// One output's scaling surface. `None` from `DisplayRead::scaling` means one
/// of the two exports is unbound, which the oracle treats as "no scaling read
/// at all"; an individual `None` inside is a call-level degradation.
pub(crate) struct ScalingSurface {
    pub(crate) caps: Option<u32>,
    pub(crate) current: Option<ScalingRead>,
}

/// One Arc Sync profile GET plus the symbol-derived capability metadata. The
/// profile is always read-only here; `controllable` only mirrors whether the
/// Electron surface has both profile symbols available.
#[derive(Clone, Copy)]
pub(crate) struct ArcSyncProfileRead {
    pub(crate) settings: ctl_intel_arc_sync_profile_params_t,
    pub(crate) controllable: bool,
}

/// One adapter-wide global VRR query, projected onto each active display.
/// This is distinct from the per-output Arc Sync profile surface.
#[derive(Clone)]
pub(crate) struct GlobalVrrSurface {
    value: Option<&'static str>,
    supported: bool,
    controllable: bool,
    reason: Option<String>,
    options: Vec<&'static str>,
}

impl GlobalVrrSurface {
    fn unavailable(reason: impl Into<String>) -> Self {
        Self { value: None, supported: false, controllable: false, reason: Some(reason.into()), options: Vec::new() }
    }

    fn readback_failed(options: Vec<&'static str>, reason: impl Into<String>) -> Self {
        Self { value: None, supported: true, controllable: false, reason: Some(reason.into()), options }
    }
}

/// The driver-facing seam. Tests supply fixture properties/settings/EDID and
/// the colour-path fixtures.
pub(crate) trait DisplayRead {
    /// The current topology's output indices, re-enumerated per read.
    /// Errors mean the native surface is unavailable; `Ok(Vec::new())` means
    /// the driver successfully reported an empty topology.
    fn outputs(&mut self) -> Result<Vec<usize>, String>;
    /// `ctlGetDisplayProperties`; `None` degrades that output's fields.
    fn properties(&mut self, output: usize) -> Option<ctl_display_properties_t>;
    /// `ctlGetSetDisplaySettings` GET; `None` degrades quantization only.
    fn settings(&mut self, output: usize) -> Option<ctl_display_settings_t>;
    /// EDID/panel-descriptor bytes; `None` degrades the label only.
    fn edid(&mut self, output: usize) -> Option<Vec<u8>>;
    /// `ctlGetSetWireFormat` GET; `None` leaves format/depth at Electron's
    /// literal defaults.
    fn wire_format(&mut self, output: usize) -> Option<ctl_get_set_wire_format_config_t>;
    /// `ctlPixelTransformationGetConfig`; overrides the wire-format answer.
    fn pixel_transformation(&mut self, output: usize) -> Option<PixelTransformation>;
    /// Combined scaling gate: `None` when either export is unbound.
    fn scaling(&mut self, output: usize) -> Option<ScalingSurface>;
    /// `ctlGetSupportedRetroScalingCapability`; `None` keeps the default
    /// "retro scaling is not exposed" capability.
    fn retro_scaling_caps(&mut self, output: usize) -> Option<u32>;
    /// `ctlGetSetRetroScaling` GET; `None` degrades to a read-back failure.
    fn retro_scaling(&mut self, output: usize) -> Option<ctl_retro_scaling_settings_t>;
    /// `ctlGetIntelArcSyncInfoForMonitor` GET; `None` degrades the monitor
    /// range while leaving the other display fields intact.
    fn arc_sync_monitor(&mut self, output: usize) -> Option<ctl_intel_arc_sync_monitor_params_t>;
    /// `ctlGetIntelArcSyncProfile` GET; `None` leaves the profile fields at
    /// their Electron defaults.
    fn arc_sync_profile(&mut self, output: usize) -> Option<ArcSyncProfileRead>;
    /// Adapter-wide global VRR mode read. `Ok(None)` leaves a fixture's
    /// default untouched; an error marks the whole native read unavailable.
    fn global_vrr(&mut self) -> Result<Option<GlobalVrrSurface>, String> { Ok(None) }
    /// `None` leaves the staged color projection untouched in fixtures.
    fn color_capabilities(&mut self, _output: usize) -> Option<(Result<ColorCapabilityClassification, String>, bool)> { None }
}

trait ColorStateRead {
    fn read_color(&self, display_key: &str) -> Result<ColorState, String>;
}
impl ColorStateRead for DisplayColorStore {
    fn read_color(&self, display_key: &str) -> Result<ColorState, String> { self.read(display_key) }
}

/// The durable scaling-preference seam (`display-scaling-state.js`).
pub(crate) trait ScalingState {
    fn read(&self, display_key: &str) -> Result<Option<ScalingSelection>, String>;
}

/// The durable compare-and-invalidate seam. Production writers must only be
/// reached while a DisplayLockGuard is alive and after the complete native
/// response has passed its ownership checks.
pub(crate) trait ScalingStateReconcile: ScalingState {
    fn invalidate_if_current(&self, display_key: &str, expected: ScalingSelection) -> Result<bool, String>;
}

impl ScalingState for DisplayScalingStore {
    fn read(&self, display_key: &str) -> Result<Option<ScalingSelection>, String> {
        DisplayScalingStore::read(self, display_key)
    }
}

impl ScalingStateReconcile for DisplayScalingStore {
    fn invalidate_if_current(&self, display_key: &str, expected: ScalingSelection) -> Result<bool, String> {
        DisplayScalingStore::invalidate_if_current(self, display_key, expected)
    }
}

/// A staged reconciliation request for a stale Arc Power identity-scaling
/// selection. Reads carry the exact record observed so a future writer can
/// compare it under the shared Display mutex before applying the update. The
/// staged reader never commits this intent; the guarded service acceptance
/// path owns the later compare/revalidation/commit step.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScalingInvalidation {
    pub(crate) display_key: String,
    pub(crate) expected: ScalingSelection,
    pub(crate) observed_enable: u8,
    pub(crate) observed_scaling_type: u32,
    pub(crate) observed_preferred_type: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ObservedScaling {
    pub(crate) enable: u8,
    pub(crate) scaling_type: u32,
    pub(crate) preferred_type: Option<u32>,
}

impl ScalingInvalidation {
    fn observed(&self) -> ObservedScaling {
        ObservedScaling {
            enable: self.observed_enable,
            scaling_type: self.observed_scaling_type,
            preferred_type: self.observed_preferred_type,
        }
    }
}

/// Re-enumerate the output topology and prove one active output still owns the
/// exact stable encoder/EDID identity, then read its scaling tuple again. Any
/// missing, duplicate, moved or unreadable identity returns no proof.
pub(crate) fn revalidate_scaling_invalidation(
    io: &mut dyn DisplayRead,
    device_key: &str,
    namespace: Option<&str>,
    invalidation: &ScalingInvalidation,
) -> Result<Option<ObservedScaling>, String> {
    let expected_suffix = match display_key_suffix(&invalidation.display_key) {
        Some(suffix) => suffix,
        None => return Ok(None),
    };
    let expected_encoder = expected_suffix.split("|edid|").next().unwrap_or("");
    if expected_encoder.is_empty() { return Ok(None); }
    let expected_output_key = format!("{device_key}|display|{expected_encoder}");
    let outputs = io.outputs()?;
    let mut encoder_counts = std::collections::HashMap::<String, usize>::new();
    let mut matching = Vec::new();
    for output in outputs {
        let Some(properties) = io.properties(output) else { continue };
        if properties.DisplayConfigFlags & DISPLAY_CONFIG_ACTIVE == 0 { continue; }
        if let Some(key) = output_encoder_key(device_key, &properties) {
            *encoder_counts.entry(key.clone()).or_default() += 1;
            let edid = io.edid(output);
            if stable_display_key(device_key, &properties, edid.as_deref())
                .and_then(|key| display_key_in_namespace(&key, namespace))
                .is_some_and(|key| key == invalidation.display_key)
            {
                matching.push(output);
            }
        }
    }
    if matching.len() != 1 || encoder_counts.get(&expected_output_key) != Some(&1) {
        return Ok(None);
    }
    let Some(current) = io.scaling(matching[0]).and_then(|surface| surface.current) else {
        return Ok(None);
    };
    Ok(Some(ObservedScaling {
        enable: current.settings.Enable,
        scaling_type: current.settings.ScalingType,
        preferred_type: (current.version == 1).then_some(current.settings.PreferredScalingType),
    }))
}

/// The result of a guarded scaling-invalidation commit. One enum, not a
/// caller-side re-derivation of the same rule, so the decline and fail-closed
/// boundaries cannot drift apart between this reconciliation and its caller.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ScalingInvalidationOutcome {
    /// Every stale record was written while the guard was held.
    Committed,
    /// Refused before the first store write. Nothing was touched, so the caller
    /// may delegate: the broker reconciles every stale record inside one of its
    /// own reads, and a hard error here would strand the Display view.
    DeclinedNothingWritten,
    /// The commit is not proven and a store write may already have happened.
    /// The caller must fail closed and must never retry across hosts.
    FailedAfterWrite(String),
}

/// Commit stale identity-selection invalidations only after the caller has
/// accepted native response ownership. The guard must cover candidate staging,
/// fresh output/scaling reads, exact store comparisons and all writes.
///
/// Every check before the conditional write loop is a pre-write refusal and is
/// reported as `DeclinedNothingWritten`; only the commit loop can produce
/// `FailedAfterWrite`. Because a multi-record reply is refused before the loop,
/// at most one record is ever written here, so a declined reply can never have
/// already written a record that the broker would write again.
pub(crate) fn reconcile_scaling_invalidations_after_ownership(
    _guard: &super::display_lock::DisplayLockGuard,
    native_ownership_accepted: bool,
    invalidations: &[ScalingInvalidation],
    store: &dyn ScalingStateReconcile,
    mut revalidate: impl FnMut(&ScalingInvalidation) -> Result<Option<ObservedScaling>, String>,
) -> ScalingInvalidationOutcome {
    if !native_ownership_accepted { return ScalingInvalidationOutcome::DeclinedNothingWritten; }
    // There is no durable multi-file transaction spanning several outputs.
    // Until one exists, a reply with multiple stale selectors is refused
    // before the first record is touched; the broker then heals all of them.
    if invalidations.len() > 1 { return ScalingInvalidationOutcome::DeclinedNothingWritten; }
    let mut seen = std::collections::HashSet::new();
    for invalidation in invalidations {
        if !seen.insert(invalidation.display_key.as_str()) || !invalidation.expected.identity_scaling {
            return ScalingInvalidationOutcome::DeclinedNothingWritten;
        }
        // An unprovable driver tuple or unreadable record is still pre-write.
        let revalidated = match revalidate(invalidation) {
            Ok(revalidated) => revalidated,
            Err(_) => return ScalingInvalidationOutcome::DeclinedNothingWritten,
        };
        if revalidated != Some(invalidation.observed()) {
            return ScalingInvalidationOutcome::DeclinedNothingWritten;
        }
        match store.read(&invalidation.display_key) {
            Ok(saved) if saved == Some(invalidation.expected) => {}
            Ok(_) => return ScalingInvalidationOutcome::DeclinedNothingWritten,
            Err(_) => return ScalingInvalidationOutcome::DeclinedNothingWritten,
        }
    }
    // All driver and store comparisons are complete before the first write.
    // The shared mutex prevents either host's apply/read transaction from
    // changing these records between this preflight and the conditional write.
    for invalidation in invalidations {
        match store.invalidate_if_current(&invalidation.display_key, invalidation.expected) {
            Ok(true) => {}
            // The record moved or the write failed after the loop started:
            // the store is no longer provably the one this reply described.
            Ok(false) => {
                return ScalingInvalidationOutcome::FailedAfterWrite(DISPLAY_READ_UNPROVEN_ERROR.to_owned())
            }
            Err(error) => return ScalingInvalidationOutcome::FailedAfterWrite(error),
        }
    }
    ScalingInvalidationOutcome::Committed
}

/// The native Display projection and any persistence work it would require.
/// Keeping these separate lets a bridge decide whether it owns the complete
/// reply before any state is changed.
#[derive(Debug)]
pub(crate) struct StagedDisplayRead {
    pub(crate) payload: Value,
    pub(crate) scaling_invalidations: Vec<ScalingInvalidation>,
    /// False when Electron's Windows display-mode fallback could change the
    /// public output list/timing, or when duplicate active encoder identities
    /// make the Rust identity projection intentionally stricter. The bridge
    /// must refuse this candidate before committing any reconciliation.
    pub(crate) native_ownership_eligible: bool,
}

/// The production seam over one already-open IGCL session.
struct SessionRead<'a> {
    session: &'a mut ReadOnlyIgcl,
    index: usize,
    handles: Vec<*mut c_void>,
}

impl DisplayRead for SessionRead<'_> {
    fn outputs(&mut self) -> Result<Vec<usize>, String> {
        if !self.session.display_available() {
            self.handles.clear();
            return Err("The IGCL runtime does not expose display-output enumeration and properties.".into());
        }
        self.handles = self.session.display_outputs(self.index).map_err(|error| error.to_string())?;
        Ok((0..self.handles.len()).collect())
    }

    fn properties(&mut self, output: usize) -> Option<ctl_display_properties_t> {
        let handle = *self.handles.get(output)?;
        self.session.display_properties(handle)
    }

    fn settings(&mut self, output: usize) -> Option<ctl_display_settings_t> {
        let handle = *self.handles.get(output)?;
        self.session.display_settings(handle)
    }

    fn edid(&mut self, output: usize) -> Option<Vec<u8>> {
        let handle = *self.handles.get(output)?;
        select_edid(&self.session.display_edid_blocks(handle))
    }

    fn wire_format(&mut self, output: usize) -> Option<ctl_get_set_wire_format_config_t> {
        let handle = *self.handles.get(output)?;
        self.session.display_wire_format(handle)
    }

    fn pixel_transformation(&mut self, output: usize) -> Option<PixelTransformation> {
        let handle = *self.handles.get(output)?;
        self.session.display_pixel_transformation(handle)
    }

    fn scaling(&mut self, output: usize) -> Option<ScalingSurface> {
        // The oracle gates the whole scaling block on both exports, so an
        // absent symbol must not publish a half-read surface (or a driver call).
        if !self.session.display_scaling_gate() { return None; }
        let handle = *self.handles.get(output)?;
        let caps = self.session.display_scaling_caps(handle);
        let current = self.session.display_scaling(handle);
        Some(ScalingSurface {
            caps: caps.map(|caps| caps.SupportedScaling),
            current: current.map(|(version, settings)| ScalingRead { version, settings }),
        })
    }

    fn retro_scaling_caps(&mut self, output: usize) -> Option<u32> {
        let _ = self.handles.get(output)?;
        if !self.session.display_retro_scaling_gate() { return None; }
        let adapter = self.session.display_adapter_handle(self.index)?;
        self.session.display_retro_scaling_caps(adapter).map(|caps| caps.SupportedRetroScaling)
    }

    fn retro_scaling(&mut self, output: usize) -> Option<ctl_retro_scaling_settings_t> {
        let _ = self.handles.get(output)?;
        let adapter = self.session.display_adapter_handle(self.index)?;
        self.session.display_retro_scaling(adapter)
    }

    fn arc_sync_monitor(&mut self, output: usize) -> Option<ctl_intel_arc_sync_monitor_params_t> {
        let handle = *self.handles.get(output)?;
        self.session.display_arc_sync_monitor(handle)
    }

    fn arc_sync_profile(&mut self, output: usize) -> Option<ArcSyncProfileRead> {
        let handle = *self.handles.get(output)?;
        Some(ArcSyncProfileRead {
            settings: self.session.display_arc_sync_profile(handle)?,
            controllable: self.session.display_arc_sync_profile_control_available(),
        })
    }

    fn global_vrr(&mut self) -> Result<Option<GlobalVrrSurface>, String> {
        if !self.session.display_igsc_full_available() {
            return Ok(Some(GlobalVrrSurface::unavailable(
                "The IGSC full loader is unavailable; global Variable Refresh Rate is not exposed by this runtime.",
            )));
        }
        if !self.session.display_global_vrr_api_available() {
            return Ok(Some(GlobalVrrSurface::unavailable(
                "The global Variable Refresh Rate Mode API is not available in this IGCL runtime.",
            )));
        }
        let details = match self.session.supported_3d_features(self.index) {
            Ok(details) => details,
            // The Electron feature cache returns null on any capability-query
            // failure, which is reported as a missing VRR feature.
            Err(_) => return Ok(Some(GlobalVrrSurface::unavailable(
                "The global Variable Refresh Rate Mode feature is not reported by the driver.",
            ))),
        };
        let Some(detail) = details.iter().find(|detail| detail.FeatureType == GLOBAL_VRR_FEATURE) else {
            return Ok(Some(GlobalVrrSurface::unavailable(
                "The global Variable Refresh Rate Mode feature is not reported by the driver.",
            )));
        };
        if detail.ValueType != GLOBAL_VRR_ENUM_VALUE_TYPE {
            return Ok(Some(GlobalVrrSurface::unavailable(
                "The global Variable Refresh Rate Mode feature is not reported by the driver.",
            )));
        }
        let supported_types = u64::from_le_bytes(detail.Value[0..8].try_into().unwrap());
        let options: Vec<&'static str> = GLOBAL_VRR_MODES.iter()
            .filter(|(value, _)| supported_types & (1_u64 << *value) != 0)
            .map(|(_, name)| *name)
            .collect();
        if options.is_empty() {
            return Ok(Some(GlobalVrrSurface::unavailable(
                "The driver did not advertise any supported global Variable Refresh Rate modes.",
            )));
        }
        let current = match self.session.display_global_vrr_mode(self.index) {
            Ok(value) => value,
            Err(error) if error.status == Some(0x4000_000b) => {
                // Electron retries INVALID_ARGUMENT after selecting GLOBAL
                // with a SET. This staged Display read is GET-only, so fail the
                // entire native read and allow the broker to own that case.
                return Err(GLOBAL_VRR_SCOPE_SELECTION_ERROR.into());
            }
            Err(error) => {
                let status = error.status.map(describe_pixel_transformation_result)
                    .unwrap_or_else(|| error.to_string());
                return Ok(Some(GlobalVrrSurface::readback_failed(options,
                    format!("The driver reported global Variable Refresh Rate modes but refused read-back ({status})."))));
            }
        };
        let Some(mode) = GLOBAL_VRR_MODES.iter().find_map(|(value, name)| (*value == current).then_some(*name))
            .filter(|mode| options.contains(mode)) else {
                return Ok(Some(GlobalVrrSurface::readback_failed(options,
                    "The driver returned an unknown or unsupported global Variable Refresh Rate Mode.")));
            };
        Ok(Some(GlobalVrrSurface { value: Some(mode), supported: true, controllable: true,
            reason: None, options }))
    }

    fn color_capabilities(&mut self, output: usize) -> Option<(Result<ColorCapabilityClassification, String>, bool)> {
        let handle = *self.handles.get(output)?;
        Some((self.session.display_color_capabilities(handle), self.session.display_pixel_transformation_set_available()))
    }

}

/// Native candidate read for the guarded bridge. It resolves the adapter's
/// stable identity, then reads every enumerated output and returns only the
/// active ones. The renderer's expected key pins the session-facing ordinal
/// to the physical adapter it selected. It has no persistence side effects.
/// Production callers must use `get_staged_under_lock`, retain that guard
/// through ownership acceptance and call the conditional reconciler before
/// returning a payload. Before reconciliation, a broker retry is safe because
/// it revalidates the expected key under its own Display guard.
pub(crate) fn get_staged(device_id: u64, expected_device_key: &str) -> Result<StagedDisplayRead, String> {
    get_staged_inner(device_id, expected_device_key, None)
}

fn get_staged_inner(
    device_id: u64,
    expected_device_key: &str,
    display_guard: Option<&super::display_lock::DisplayLockGuard>,
) -> Result<StagedDisplayRead, String> {
    let path = super::display_igcl_dll::locate_dll()
        .ok_or_else(|| "The IGCL display runtime is unavailable.".to_owned())?;
    let (mut igcl, index, device) = super::gpu_capabilities::open_for_device(&path, device_id)?;
    let device_key = verify_expected_device_key(&device, expected_device_key)?;
    let adapter_name = device.get("name").and_then(Value::as_str);
    let namespace = color_namespace(&device);
    let store = DisplayScalingStore::application_default();
    let color_store = DisplayColorStore::application_default();
    // Both state inputs are read-only. The staged result carries any scaling
    // invalidation request instead of writing before the bridge accepts it.
    let windows_modes = super::windows_display_modes::read_windows_display_modes()
        .map_err(|error| error.to_string());
    let mut io = SessionRead { session: &mut igcl, index, handles: Vec::new() };
    read_payload_with_color_staged(
        &mut io, Some(&device_key), adapter_name, Some(&namespace), &store,
        Some(&color_store), Some(&windows_modes), display_guard,
    )
}

/// Production ownership path for the guarded native Display GET route. The caller
/// must acquire the shared guard before staging and keep it through any call
/// to `reconcile_scaling_invalidations_after_ownership` and response creation.
/// The unguarded `get_staged` remains a read-only fixture/candidate seam and
/// must never be returned directly by the service.
#[allow(dead_code)]
pub(crate) fn get_staged_under_lock(
    guard: &super::display_lock::DisplayLockGuard,
    device_id: u64,
    expected_device_key: &str,
) -> Result<StagedDisplayRead, String> {
    get_staged_inner(device_id, expected_device_key, Some(guard))
}

/// Complete the read-only Display ownership check under the shared cross-host
/// guard. A candidate is returned only when the native payload cannot differ
/// from Electron through its Windows timing/active fallback and any staged
/// scaling intent has been conditionally reconciled. Pre-write declines may
/// delegate because the Electron broker revalidates the expected key under its
/// own Display lock and heals every stale record inside one read. From the
/// first durable write onward the outcome fails closed. No native
/// scope-selection write is attempted.
pub(crate) fn get_if_owned_under_lock(
    guard: &super::display_lock::DisplayLockGuard,
    device_id: u64,
    expected_device_key: &str,
) -> Result<Option<Value>, String> {
    if !guard.is_held() {
        return Err("The Display transaction lock is no longer held.".into());
    }
    let staged = match get_staged_under_lock(guard, device_id, expected_device_key) {
        Ok(staged) => staged,
        // Staging performs reads only. The Electron broker revalidates the
        // expected key under its own Display lock before resolving the numeric
        // id, so any staging error can safely decline before reconciliation.
        Err(error) => return decline_before_reconciliation(error),
    };
    let accepted = accept_staged_display_read(guard, staged, |invalidations| {
        let store = DisplayScalingStore::application_default();
        reconcile_scaling_invalidations_after_ownership(
            guard,
            true,
            invalidations,
            &store,
            |invalidation| revalidate_scaling_invalidation_native(
                guard, device_id, expected_device_key, invalidation,
            ),
        )
    })?;
    Ok(accepted)
}

/// An injectable ownership-acceptance seam. Eligibility is checked before the
/// reconciliation closure can read or write durable state; a rejected
/// candidate therefore leaves the durable store untouched. The closure returns
/// the reconciliation's own tri-state outcome so a pre-write decline becomes a
/// broker delegation while an unproven commit still fails closed.
fn accept_staged_display_read(
    guard: &super::display_lock::DisplayLockGuard,
    staged: StagedDisplayRead,
    mut reconcile: impl FnMut(&[ScalingInvalidation]) -> ScalingInvalidationOutcome,
) -> Result<Option<Value>, String> {
    if !guard.is_held() {
        return Err("The Display transaction lock is no longer held.".into());
    }
    if !staged.native_ownership_eligible { return Ok(None); }
    if !staged.scaling_invalidations.is_empty() {
        match reconcile(&staged.scaling_invalidations) {
            ScalingInvalidationOutcome::Committed => {}
            // Nothing was written, so the broker can own this read and heal
            // every stale record itself.
            ScalingInvalidationOutcome::DeclinedNothingWritten => return Ok(None),
            ScalingInvalidationOutcome::FailedAfterWrite(error) => return Err(error),
        }
    }
    Ok(Some(staged.payload))
}

fn decline_before_reconciliation(_error: String) -> Result<Option<Value>, String> {
    Ok(None)
}

fn revalidate_scaling_invalidation_native(
    guard: &super::display_lock::DisplayLockGuard,
    device_id: u64,
    expected_device_key: &str,
    invalidation: &ScalingInvalidation,
) -> Result<Option<ObservedScaling>, String> {
    if !guard.is_held() {
        return Err("The Display transaction lock is no longer held.".into());
    }
    let path = super::display_igcl_dll::locate_dll()
        .ok_or_else(|| "The IGCL display runtime is unavailable.".to_owned())?;
    let (mut igcl, index, device) = super::gpu_capabilities::open_for_device(&path, device_id)?;
    let device_key = verify_expected_device_key(&device, expected_device_key)?;
    let namespace = color_namespace(&device);
    let mut io = SessionRead { session: &mut igcl, index, handles: Vec::new() };
    revalidate_scaling_invalidation(&mut io, &device_key, Some(&namespace), invalidation)
}

/// Pin a renderer-facing numeric ordinal to the exact physical adapter that
/// the current IGCL enumeration opened. A display read must not silently move
/// to another adapter after inventory reordering or accept an unproven PCI
/// identity.
fn verify_expected_device_key(device: &Value, expected_device_key: &str) -> Result<String, String> {
    if expected_device_key.trim().is_empty() {
        return Err("The selected graphics adapter identity is unavailable; refresh Display and try again.".into());
    }
    let identity = super::gpu_apply_identity::identity_from_row(device)
        .map_err(|_| "The selected graphics adapter identity could not be verified; refresh Display and try again.".to_owned())?;
    if identity.device_key != expected_device_key {
        return Err(DISPLAY_STALE_DEVICE_ERROR.into());
    }
    Ok(identity.device_key)
}

/// The whole-surface read behind `get`. Split out so fixture tests exercise the
/// exact payload assembly without a driver.
#[cfg(test)]
pub(crate) fn read_payload(
    io: &mut dyn DisplayRead,
    device_key: Option<&str>,
    adapter_name: Option<&str>,
    namespace: Option<&str>,
    store: &dyn ScalingState,
) -> Result<Value, String> {
    read_payload_with_color(io, device_key, adapter_name, namespace, store, None, None)
}

#[cfg(test)]
pub(crate) fn read_payload_staged(
    io: &mut dyn DisplayRead,
    device_key: Option<&str>,
    adapter_name: Option<&str>,
    namespace: Option<&str>,
    store: &dyn ScalingState,
) -> Result<StagedDisplayRead, String> {
    read_payload_with_color_staged(io, device_key, adapter_name, namespace, store, None, None, None)
}

fn read_payload_with_color(
    io: &mut dyn DisplayRead,
    device_key: Option<&str>,
    adapter_name: Option<&str>,
    namespace: Option<&str>,
    store: &dyn ScalingState,
    color_store: Option<&dyn ColorStateRead>,
    windows_modes: Option<&Result<WindowsDisplayModeSnapshot, String>>,
) -> Result<Value, String> {
    read_payload_with_color_staged(
        io, device_key, adapter_name, namespace, store, color_store, windows_modes, None,
    ).map(|read| read.payload)
}

fn read_payload_with_color_staged(
    io: &mut dyn DisplayRead,
    device_key: Option<&str>,
    adapter_name: Option<&str>,
    namespace: Option<&str>,
    store: &dyn ScalingState,
    color_store: Option<&dyn ColorStateRead>,
    windows_modes: Option<&Result<WindowsDisplayModeSnapshot, String>>,
    display_guard: Option<&super::display_lock::DisplayLockGuard>,
) -> Result<StagedDisplayRead, String> {
    if display_guard.is_some_and(|guard| !guard.is_held()) {
        return Err("The Display transaction lock is no longer held.".into());
    }
    let outputs = io.outputs()?;
    if outputs.is_empty() {
        return Ok(StagedDisplayRead {
            payload: surface(device_key, adapter_name, Vec::new()),
            scaling_invalidations: Vec::new(),
            native_ownership_eligible: true,
        });
    }
    let global_vrr = io.global_vrr()?;
    // Capture topology-scoped output identity once, then count adapter/encoder
    // pairs before reading any per-display intent. The encoder is the output
    // handle identity; an EDID difference cannot disambiguate duplicate active
    // handles that claim the same encoder.
    let snapshots: Vec<_> = outputs.into_iter().map(|output| {
        (output, io.properties(output), io.edid(output))
    }).collect();
    let mut identity_counts = std::collections::HashMap::<String, usize>::new();
    if let Some(device_key) = device_key {
        for (_, properties, _) in &snapshots {
            let Some(properties) = properties.as_ref().filter(|properties| {
                properties.DisplayConfigFlags & DISPLAY_CONFIG_ACTIVE != 0
            }) else { continue };
            if let Some(key) = output_encoder_key(device_key, properties) {
                *identity_counts.entry(key).or_default() += 1;
            }
        }
    }
    // Electron may promote an output or fill its timing from its Windows
    // controller when the IGCL row is inactive or has no plausible timing.
    // The native inventory has a deliberately stricter match contract, so a
    // named row in that state cannot be returned until equivalent matching is
    // established. Unnamed rows cannot enter Electron's Windows fallback.
    let mut native_ownership_eligible = !identity_counts.values().any(|count| *count > 1);
    for (_, properties, edid) in &snapshots {
        let has_edid_name = edid.as_deref().and_then(monitor_name).is_some();
        if !has_edid_name { continue; }
        let active_with_timing = properties.as_ref().is_some_and(|properties| {
            properties.DisplayConfigFlags & DISPLAY_CONFIG_ACTIVE != 0
                && plausible_timing(&properties.Display_Timing_Info)
        });
        if !active_with_timing {
            native_ownership_eligible = false;
        }
    }
    let mut displays = Vec::new();
    let mut scaling_invalidations = Vec::new();
    for (output, properties, edid) in snapshots {
        let output_device_key = match (device_key, properties.as_ref()) {
            (Some(device_key), Some(properties))
                if properties.DisplayConfigFlags & DISPLAY_CONFIG_ACTIVE != 0 => {
                    output_encoder_key(device_key, properties)
                        .filter(|key| identity_counts.get(key) == Some(&1))
                        .map(|_| device_key)
                }
            _ => None,
        };
        let display = read_output(
            io, output, output_device_key, namespace, store, color_store,
            global_vrr.as_ref(), windows_modes, &mut scaling_invalidations,
            properties, edid,
        );
        if display["flags"]["active"] == Value::Bool(true) { displays.push(display); }
    }
    Ok(StagedDisplayRead {
        payload: surface(device_key, adapter_name, displays),
        scaling_invalidations,
        native_ownership_eligible,
    })
}

pub(crate) fn output_encoder_key(
    device_key: &str,
    properties: &ctl_display_properties_t,
) -> Option<String> {
    let encoder = encoder_id(&properties.Os_display_encoder_handle)?;
    Some(format!("{device_key}|display|{encoder}"))
}

/// Build the public stable identity for one already-uniquely-resolved output.
/// The caller is responsible for counting active encoder handles first; EDID
/// is a suffix, not permission to disambiguate duplicate encoder identities.
pub(crate) fn stable_display_key(
    device_key: &str,
    properties: &ctl_display_properties_t,
    edid: Option<&[u8]>,
) -> Option<String> {
    let mut key = output_encoder_key(device_key, properties)?;
    if let Some(fingerprint) = edid.and_then(edid_fingerprint) {
        key.push_str("|edid|");
        key.push_str(&fingerprint);
    }
    Some(key)
}

fn surface(device_key: Option<&str>, adapter_name: Option<&str>, displays: Vec<Value>) -> Value {
    json!({
        "deviceKey": device_key,
        "adapterName": adapter_name,
        "displays": displays,
    })
}

/// `_readDisplayEdid`'s selection rule over the candidate blocks: the first
/// block that yields a monitor name wins; otherwise the first payload read is
/// kept so its fingerprint still contributes to the identity.
pub(crate) fn select_edid(blocks: &[Vec<u8>]) -> Option<Vec<u8>> {
    blocks.iter().find(|block| monitor_name(block).is_some()).cloned()
        .or_else(|| blocks.first().cloned())
}

/// `displayKeySuffix`: the driver/display portion of a stable display key, or
/// `None` when the key is not in the canonical `adapter|display|output` form.
pub(crate) fn display_key_suffix(display_key: &str) -> Option<&str> {
    let marker = display_key.find("|display|")?;
    let suffix = &display_key[marker + "|display|".len()..];
    (!suffix.is_empty()).then_some(suffix)
}

/// `displayKeyInNamespace`: re-namespace a display key onto another adapter
/// alias while preserving the physical output identity. Malformed keys and an
/// empty/absent namespace are preserved so a row never disappears during a
/// degraded read-back.
pub(crate) fn display_key_in_namespace(display_key: &str, namespace: Option<&str>) -> Option<String> {
    let Some(namespace) = namespace.filter(|value| !value.is_empty()) else {
        return Some(display_key.to_owned());
    };
    match display_key_suffix(display_key) {
        None => Some(display_key.to_owned()),
        Some(suffix) => Some(format!("{namespace}|display|{suffix}")),
    }
}

/// `displayColorNamespace`: persist scaling intent in the native PCI/BDF
/// namespace whenever the adapter's BDF is known, otherwise fall back to the
/// public adapter key. The encoder/EDID suffix still identifies the output.
pub(super) fn color_namespace(device: &Value) -> String {
    let bdf = &device["bdf"];
    let coordinate = |key: &str| bdf[key].as_i64().filter(|value| *value >= 0);
    let known_bdf = coordinate("bus").is_some() && coordinate("device").is_some()
        && coordinate("function").is_some()
        && (coordinate("bus") != Some(0) || coordinate("device") != Some(0)
            || coordinate("function") != Some(0));
    let has_pci_ids = device["pciVendorId"].as_str().is_some_and(|value| !value.is_empty())
        && device["pciDeviceId"].as_str().is_some_and(|value| !value.is_empty());
    if known_bdf && has_pci_ids {
        return super::gpu_devices::device_key(device);
    }
    device["deviceKey"].as_str().filter(|key| !key.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| super::gpu_devices::device_key(device))
}

fn read_output(
    io: &mut dyn DisplayRead,
    index: usize,
    device_key: Option<&str>,
    namespace: Option<&str>,
    store: &dyn ScalingState,
    color_store: Option<&dyn ColorStateRead>,
    global_vrr: Option<&GlobalVrrSurface>,
    windows_modes: Option<&Result<WindowsDisplayModeSnapshot, String>>,
    scaling_invalidations: &mut Vec<ScalingInvalidation>,
    properties: Option<ctl_display_properties_t>,
    edid: Option<Vec<u8>>,
) -> Value {
    let mut display = empty_display(index);
    if let Some(global_vrr) = global_vrr {
        display["globalVrrMode"] = capability(
            global_vrr.value.map_or(Value::Null, |mode| json!(mode)),
            Some(global_vrr.supported), global_vrr.controllable, global_vrr.reason.as_deref(),
            "igcl-global-vrr",
        );
        display["supportedOptions"]["globalVrrModes"] = json!(global_vrr.options);
    }
    if let Some(properties) = properties {
        if let (Some(device_key), Some(encoder)) = (device_key, encoder_id(&properties.Os_display_encoder_handle)) {
            // The encoder handle is the driver-provided physical output
            // identity. The ordinal is deliberately excluded so a re-enumerate
            // cannot retarget another monitor.
            display["displayKey"] = json!(format!("{device_key}|display|{encoder}"));
            display["identityVerified"] = json!(true);
        }
        display["connection"] = json!(connection_name(properties.Type));
        let config = properties.DisplayConfigFlags;
        display["flags"] = json!({
            "active": config & DISPLAY_CONFIG_ACTIVE != 0,
            "attached": config & DISPLAY_CONFIG_ATTACHED != 0,
            "dongleConnected": config & DISPLAY_CONFIG_DONGLE != 0,
            "ditheringEnabled": config & DISPLAY_CONFIG_DITHERING != 0,
        });
        // IGCL reports the standard display capabilities as bitmasks. The
        // oracle exposes HDCP and HDR as read-only capabilities (the Adaptive
        // Sync bit is consumed by the adapter-wide global-VRR read).
        let hdcp = properties.FeatureSupportedFlags & DISPLAY_FEATURE_HDCP != 0;
        display["hdcpSupport"] = capability(
            Value::Bool(hdcp), Some(hdcp), false, Some("Read-only display capability."), "igcl-display-properties",
        );
        let hdr = properties.FeatureSupportedFlags & DISPLAY_FEATURE_HDR != 0;
        display["hdrSupport"] = capability(
            Value::Bool(hdr), Some(hdr), false, Some("Read-only display capability."), "igcl-display-properties",
        );
        let timing = properties.Display_Timing_Info;
        if plausible_timing(&timing) {
            display["resolution"] = json!({"width": timing.HActive, "height": timing.VActive});
            display["refreshRate"] = json!(f64::from(timing.RefreshRate));
        }
    }

    // EDID: the monitor label and the physical-panel identity suffix. A block
    // without a 0xFC descriptor still contributes its fingerprint.
    if let Some(data) = edid.as_deref() {
        if let Some(name) = monitor_name(data) { display["name"] = json!(name); }
        if display["identityVerified"] == Value::Bool(true) {
            if let (Some(device_key), Some(properties)) = (device_key, properties) {
                if let Some(key) = stable_display_key(device_key, &properties, Some(&data)) {
                    display["displayKey"] = json!(key);
                }
            }
        }
    }

    // Some Arc drivers report an active output and a stable EDID, but omit
    // its active timing. Use a complete Windows inventory only when the EDID
    // name exactly identifies one row, and never replace a timing IGCL
    // already supplied. The name is only a display-presentation selector, not
    // physical identity proof, so it only supplies presentation fields.
    apply_active_output_mode_fallback(&mut display, windows_modes);

    if display["flags"]["active"] != Value::Bool(true) { return display; }

    // Quantization range. The settable control is the same export as the GET;
    // this build never fills `Set`/`ValidFlags`, so the call stays a read.
    if let Some(settings) = io.settings(index) {
        display["quantizationRange"] = quantization_name(settings.QuantizationRange);
        if settings.ControllableFlags & DISPLAY_SETTING_QUANTIZATION_RANGE != 0 {
            display["supportedOptions"]["quantizationRanges"] = json!(QUANTIZATION_OPTIONS);
        }
    }

    // Wire format. The nested structs are fully versioned and BPC values are
    // decoded from the driver's bitmask. A driver that returns only a
    // model-without-depth remains read-only because it cannot prove a
    // format/depth apply.
    if let Some(config) = io.wire_format(index) {
        let wire = decode_wire_format(&config);
        let mut formats: Vec<&'static str> = Vec::new();
        for name in &wire.supported_models {
            if let Some(canonical) = canonical_wire_model(name) {
                if !formats.contains(&canonical) { formats.push(canonical); }
            }
        }
        display["supportedOptions"]["wireFormats"] = json!(formats);
        let mut depths: Vec<u32> = Vec::new();
        for (_, depth) in &wire.supported {
            if !depths.contains(depth) { depths.push(*depth); }
        }
        display["supportedOptions"]["bpcDepths"] = json!(depths);
        if wire.current_unavailable {
            display["colorFormat"] = wire.current_model.as_deref()
                .and_then(canonical_wire_model).map_or(Value::Null, |model| json!(model));
            display["colorDepth"] = Value::Null;
        } else if let Some((model, depth)) = &wire.current {
            display["colorFormat"] = canonical_wire_model(model).map_or(Value::Null, |model| json!(model));
            display["colorDepth"] = json!(depth);
        }
    }

    // Pixel transformation is the per-output desktop colour path. Prefer its
    // output format over the legacy wire-format read when both are present:
    // the A770 reports an empty-depth YCbCr422 wire slot even while the active
    // output is RGB (the state shown by IGS).
    if let Some(pixel) = io.pixel_transformation(index) {
        if let Some(model) = pixel_color_model_to_wire(pixel.output_model) {
            display["colorFormat"] = json!(model);
        }
        if pixel.output_bits_per_color > 0 { display["colorDepth"] = json!(pixel.output_bits_per_color); }
    }

    // Scaling: the driver's SupportedScaling bitmask (the offered options) and
    // the current scaling type (a FLAG value - the probe's live read: 0x1 =
    // IDENTITY).
    if let Some(surface) = io.scaling(index) {
        if let Some(caps) = surface.caps {
            display["supportedOptions"]["scalingModes"] = json!(flag_names(caps, &SCALING_CAPS_NAMES));
        }
        if let Some(current) = surface.current {
            let settings = current.settings;
            let scaling_mode = scaling_name(settings.ScalingType);
            let preferred = (current.version == 1).then(|| scaling_name(settings.PreferredScalingType))
                .flatten();
            display["scalingMode"] = scaling_mode.map_or(Value::Null, |name| json!(name));
            display["preferredScalingMode"] = preferred.map_or(Value::Null, |name| json!(name));
            display["scalingDetails"] = json!({
                "customX": settings.CustomScalingX,
                "customY": settings.CustomScalingY,
                "hardwareModeSet": settings.HardwareModeSet != 0,
                "preferredScalingType": preferred.map_or(Value::Null, |name| json!(name)),
            });
            let scaling_key = display["displayKey"].as_str()
                .filter(|_| display["identityVerified"] == Value::Bool(true))
                .and_then(|key| display_key_in_namespace(key, namespace));
            let saved = scaling_key.as_deref()
                .and_then(|key| store.read(key).ok().flatten());
            if let Some(selection) = saved {
                if let (Some(x), Some(y)) = (selection.custom_x, selection.custom_y) {
                    display["customScalingPreference"] = json!({"x": x, "y": y});
                }
                // Version 0 has no persisted preferred type, so the record's
                // fingerprint (null) is the value it must match.
                let preferred_fingerprint = (current.version == 1).then_some(settings.PreferredScalingType);
                if selection.identity_scaling && settings.Enable != 0 && settings.ScalingType == 1
                    && selection.native_preferred_scaling_type == preferred_fingerprint
                {
                    display["scalingPreference"] = json!("display-scaling");
                    display["scalingPreferenceSource"] = json!("arc-selection");
                } else if selection.identity_scaling {
                    // Stage the invalidation so a bridge that falls back to
                    // Electron cannot mutate shared state first. Include the
                    // full observed record; a future owner must compare it
                    // under the shared writer lock before committing.
                    if let Some(key) = scaling_key.as_deref() {
                        scaling_invalidations.push(ScalingInvalidation {
                            display_key: key.to_owned(),
                            expected: selection,
                            observed_enable: settings.Enable,
                            observed_scaling_type: settings.ScalingType,
                            observed_preferred_type: preferred_fingerprint,
                        });
                    }
                }
            }
            if scaling_mode == Some("custom") {
                display["scalingPreference"] = json!("display-scaling");
                display["scalingPreferenceSource"] = Value::Null;
            } else if display["scalingPreference"].is_null() && (
                scaling_mode.is_some_and(|mode| GPU_SCALING_MODES.contains(&mode))
                    || (scaling_mode == Some("identity")
                        && preferred.is_some_and(|mode| GPU_SCALING_MODES.contains(&mode)))
            ) {
                display["scalingPreference"] = json!("gpu-scaling");
                display["scalingPreferenceSource"] = json!("igcl-preferred");
            }
        }
    }

    // Retro scaling is a separate driver surface from ordinary scaling. Read
    // both the capability bitmask and the current enabled/type pair so the
    // renderer can expose it only when a complete verified contract exists.
    if let Some(caps) = io.retro_scaling_caps(index) {
        let methods: Vec<&'static str> = flag_names(caps, &RETRO_CAPS_NAMES);
        display["supportedOptions"]["scalingMethods"] = json!(methods);
        let supported = !methods.is_empty();
        match io.retro_scaling(index) {
            Some(value) => {
                let method = retro_scaling_method(value.RetroScalingType);
                let enabled = value.Enable != 0;
                let reason = if method.is_some() { None }
                    else if !enabled { Some("Retro Scaling is off. Choose a supported method to enable it.") }
                    else { Some("The driver returned an unknown enabled retro-scaling method.") };
                display["scalingMethod"] = capability(
                    json!({"enabled": enabled, "method": method}),
                    Some(supported),
                    supported && (!enabled || method.is_some()),
                    reason,
                    "igcl",
                );
            }
            None => display["scalingMethod"] = capability(
                Value::Null, Some(supported), false, Some("Retro scaling read-back failed."), "igcl",
            ),
        }
    }

    // Arc Sync is per-output. The monitor query owns the driver's supported
    // VRR range; the profile query owns the selected profile and current range.
    // Both are GET-only, and a missing/failed query degrades only its fields.
    if let Some(monitor) = io.arc_sync_monitor(index) {
        let supported = monitor.IsIntelArcSyncSupported != 0;
        display["arcSync"]["supported"] = json!(supported);
        display["arcSync"]["minRefreshHz"] = if supported && monitor.MinimumRefreshRateInHz.is_finite() {
            json!(monitor.MinimumRefreshRateInHz)
        } else { Value::Null };
        display["arcSync"]["maxRefreshHz"] = if supported && monitor.MaximumRefreshRateInHz.is_finite() {
            json!(monitor.MaximumRefreshRateInHz)
        } else { Value::Null };
        let range = if supported {
            Some(refresh_range(monitor.MinimumRefreshRateInHz, monitor.MaximumRefreshRateInHz))
        } else { None };
        display["vrrMaximumRange"] = capability(
            range.map_or(Value::Null, |value| json!(value)),
            Some(supported), false, Some("Read-only driver capability."), "igcl",
        );
        // The driver's own per-monitor window is the authoritative admissible
        // range. The display's own Windows mode list at the resolution in use
        // may narrow it, but only when its exact-label join identifies one
        // complete output; a missing, ambiguous, or incomplete inventory falls
        // back to the driver window instead of withholding a known range.
        if supported {
            let snapshot = match windows_modes {
                Some(Ok(snapshot)) => Some(snapshot),
                _ => None,
            };
            if let Some((min_hz, max_hz)) = super::windows_display_modes::arc_sync_range_bounds(
                snapshot,
                display["name"].as_str(),
                display_resolution(&display),
                monitor.MinimumRefreshRateInHz,
                monitor.MaximumRefreshRateInHz,
            ) {
                display["arcSync"]["rangeBounds"] = json!({"minHz": min_hz, "maxHz": max_hz});
            }
        }
    }

    if let Some(profile) = io.arc_sync_profile(index) {
        let settings = profile.settings;
        let profile_name = arc_sync_profile_name(settings.IntelArcSyncProfile);
        let arc_sync_supported = display["arcSync"]["supported"].as_bool() == Some(true);
        display["arcSync"]["profile"] = profile_name.map_or(Value::Null, |name| json!(name));
        // `supported` alone is not a write contract: the setter must exist too.
        // This is the same condition the native profile transaction uses.
        display["arcSync"]["writable"] = json!(arc_sync_supported && profile.controllable);
        if settings.MinRefreshRateInHz.is_finite() && settings.MaxRefreshRateInHz.is_finite()
            && settings.MaxRefreshRateInHz > 0.0
            && settings.MaxRefreshRateInHz >= settings.MinRefreshRateInHz
        {
            display["arcSync"]["currentRange"] = json!({
                "minHz": settings.MinRefreshRateInHz,
                "maxHz": settings.MaxRefreshRateInHz,
            });
        }
        let recognized_profile = arc_sync_supported && profile_name.is_some();
        let profile_reason = if !arc_sync_supported {
            Some("Arc Sync is not supported by this display.")
        } else if profile_name.is_some() && !profile.controllable {
            Some("Arc Sync setter is not available in this driver runtime.")
        } else if profile_name.is_none() {
            Some("Arc Sync is not supported by this display.")
        } else { None };

        display["vrrMode"] = capability(
            profile_name.map_or(Value::Null, |name| json!(name)),
            Some(arc_sync_supported),
            arc_sync_supported && profile.controllable,
            profile_reason,
            "igcl",
        );

        let variable_refresh_reason = if recognized_profile && !profile.controllable {
            Some("Arc Sync setter is not available in this driver runtime.")
        } else if recognized_profile {
            None
        } else {
            Some("Arc Sync monitor support or the current Arc Sync profile is unavailable.")
        };
        display["variableRefreshRate"] = capability(
            if recognized_profile { json!(settings.IntelArcSyncProfile != ARC_SYNC_OFF_PROFILE) } else { Value::Null },
            Some(recognized_profile),
            recognized_profile && profile.controllable,
            variable_refresh_reason,
            "igcl-arc-sync-profile",
        );

        if settings.MinRefreshRateInHz.is_finite() && settings.MaxRefreshRateInHz.is_finite()
            && settings.MaxRefreshRateInHz > 0.0
            && settings.MaxRefreshRateInHz >= settings.MinRefreshRateInHz
        {
            display["vrrCurrentRange"] = capability(
                json!(refresh_range(settings.MinRefreshRateInHz, settings.MaxRefreshRateInHz)),
                Some(arc_sync_supported), false, Some("Read-only driver capability."), "igcl",
            );
        }
        if recognized_profile {
            display["supportedOptions"]["vrrModes"] = json!(ARC_SYNC_PROFILE_NAMES);
        }
    }
    if let (Some(color_store), Some((caps, setter_available))) = (color_store, io.color_capabilities(index)) {
        let saved = if display["identityVerified"] == Value::Bool(true) {
            display["displayKey"].as_str()
                .and_then(|key| display_key_in_namespace(key, namespace))
                .ok_or_else(|| "A verified physical display identity is required.".to_owned())
                .and_then(|key| color_store.read_color(&key))
        } else {
            Err("A verified physical display identity is required.".into())
        };
        project_color(&mut display, caps, saved, setter_available);
    }
    display
}

fn arc_sync_profile_name(profile: i32) -> Option<&'static str> {
    usize::try_from(profile).ok().and_then(|index| index.checked_sub(1))
        .and_then(|index| ARC_SYNC_PROFILE_NAMES.get(index).copied())
}

/// Match Electron's `Number(f32).toString()` in human-readable range strings.
/// Widening first preserves the exact IEEE-754 value returned by IGCL;
/// formatting as f32 directly can round to a shorter, different decimal.
fn js_number_string(value: f32) -> String {
    let value = f64::from(value);
    if value == 0.0 { "0".into() }
    else if value.is_nan() { "NaN".into() }
    else if value == f64::INFINITY { "Infinity".into() }
    else if value == f64::NEG_INFINITY { "-Infinity".into() }
    else { value.to_string() }
}

fn refresh_range(minimum: f32, maximum: f32) -> String {
    format!("{} Hz - {} Hz", js_number_string(minimum), js_number_string(maximum))
}

/// `flag_names`/`displayFlagNames`: bit index -> name for the oracle's
/// caps-bit tables (the caps bits sit at 0..n, unlike the struct flag values).
fn flag_names(flags: u32, table: &[&'static str]) -> Vec<&'static str> {
    table.iter().enumerate()
        .filter(|(bit, _)| flags & (1 << bit) != 0)
        .map(|(_, name)| *name)
        .collect()
}

/// The oracle's decoded wire-format view (`decodeWireFormatConfig`).
struct WireFormatView {
    /// Raw IGCL model names for the valid 0..3 models, first occurrence order.
    supported_models: Vec<String>,
    /// One entry per advertised depth flag, first occurrence order.
    supported: Vec<(String, u32)>,
    /// The current pair, present only when the driver's depth is one exact flag.
    current: Option<(String, u32)>,
    /// The current model name when the depth is absent/unrecognized.
    current_model: Option<String>,
    current_unavailable: bool,
}

fn wire_model_name(model: i32) -> String {
    match model {
        0 => "RGB".into(),
        1 => "YCBCR_420".into(),
        2 => "YCBCR_422".into(),
        3 => "YCBCR_444".into(),
        other => format!("MODEL_{other}"),
    }
}

/// `canonicalWireModel`: IGCL's SCREAMING wire-model name -> the shared
/// canonical name (`YCBCR_422` -> `YCbCr422`). Unknown models are null.
fn canonical_wire_model(name: &str) -> Option<&'static str> {
    match name {
        "RGB" => Some("RGB"),
        "YCBCR_420" => Some("YCbCr420"),
        "YCBCR_422" => Some("YCbCr422"),
        "YCBCR_444" => Some("YCbCr444"),
        _ => None,
    }
}

fn decode_wire_format(config: &ctl_get_set_wire_format_config_t) -> WireFormatView {
    let mut supported_models: Vec<String> = Vec::new();
    let mut supported: Vec<(String, u32)> = Vec::new();
    for entry in &config.SupportedWireFormat {
        // An empty slot does not advertise a usable format.
        if entry.ColorDepth == 0 { continue; }
        let model = wire_model_name(entry.ColorModel);
        if (0..=3).contains(&entry.ColorModel) && !supported_models.contains(&model) {
            supported_models.push(model.clone());
        }
        for (flag, depth) in BPC_FLAGS {
            if entry.ColorDepth & flag != 0 { supported.push((model.clone(), depth)); }
        }
    }
    // The current depth is the exact flag key, not a bit test: an unrecognized
    // or combined value means the depth cannot be proven.
    let current_depth = BPC_FLAGS.iter().find(|(flag, _)| *flag == config.WireFormat.ColorDepth)
        .map(|(_, depth)| *depth);
    let current_model = wire_model_name(config.WireFormat.ColorModel);
    WireFormatView {
        supported_models,
        supported,
        current: current_depth.map(|depth| (current_model.clone(), depth)),
        current_model: current_depth.is_none().then_some(current_model),
        current_unavailable: current_depth.is_none(),
    }
}

/// `PIXEL_COLOR_MODEL_TO_WIRE`: the pixel-transformation colour model collapses
/// its full/limited pairs onto the legacy wire-format names.
fn pixel_color_model_to_wire(model: i32) -> Option<&'static str> {
    match model {
        0 | 1 => Some("RGB"),
        2 | 3 => Some("YCbCr422"),
        4 | 5 => Some("YCbCr420"),
        6 | 7 => Some("YCbCr444"),
        _ => None,
    }
}

/// `DISPLAY_SCALING_MODE_FROM_IGCL`: the struct value is a FLAG, not an index.
fn scaling_name(flag: u32) -> Option<&'static str> {
    match flag {
        1 => Some("identity"),
        2 => Some("centered"),
        4 => Some("stretched"),
        8 => Some("aspect-ratio-centered-max"),
        16 => Some("custom"),
        _ => None,
    }
}

/// `DISPLAY_RETRO_SCALING_METHOD_FROM_IGCL`: a disabled driver normalizes the
/// type to 0, so an unknown value is only an error while it claims to be on.
fn retro_scaling_method(flag: u32) -> Option<&'static str> {
    match flag {
        1 => Some("integer"),
        2 => Some("nearest-neighbour"),
        _ => None,
    }
}

/// Electron's literal default display shape (`_readDisplayOutput`). Deferred
/// controls keep the oracle's own defaults, reasons and sources so the payload
/// shape and the fallback vocabulary stay identical.
fn empty_display(index: usize) -> Value {
    json!({
        "id": index,
        "displayKey": Value::Null,
        "identityVerified": false,
        "name": Value::Null,
        "connection": "Unknown",
        "resolution": Value::Null,
        "refreshRate": Value::Null,
        "colorDepth": Value::Null,
        "colorFormat": Value::Null,
        "quantizationRange": Value::Null,
        "scalingMode": Value::Null,
        "preferredScalingMode": Value::Null,
        "scalingPreferenceSource": Value::Null,
        "customScalingPreference": Value::Null,
        "scalingPreference": Value::Null,
        "scalingDetails": Value::Null,
        "scalingMethod": capability(
            Value::Null, Some(false), false, Some("Retro scaling is not exposed by the driver interface."), "igcl",
        ),
        "globalVrrMode": capability(
            Value::Null, None, false,
            Some("Global Variable Refresh Rate Mode is not exposed by the driver interface."), "igcl",
        ),
        "vrrMode": capability(
            Value::Null, None, false,
            Some("Arc Sync profile control is not exposed by the driver interface."), "igcl",
        ),
        "variableRefreshRate": capability(
            Value::Null, None, false,
            Some("Variable refresh rate is controlled by Windows/the display path."), "igcl",
        ),
        "vrrCurrentRange": capability(
            Value::Null, None, false,
            Some("The current variable refresh-rate range is not exposed by the driver interface."), "igcl",
        ),
        "vrrMaximumRange": capability(
            Value::Null, None, false,
            Some("The maximum variable refresh-rate range is not exposed by the driver interface."), "igcl",
        ),
        "hdcpSupport": capability(
            Value::Null, None, false, Some("HDCP support is not exposed by the driver interface."), "igcl",
        ),
        "fourKSupport": capability(
            Value::Null, None, false, Some("4K support is not exposed by the driver interface."), "igcl",
        ),
        "hdrSupport": capability(
            Value::Null, None, false, Some("HDR support is not exposed by the driver interface."), "igcl",
        ),
        "hue": capability(
            Value::Null, Some(false), false, Some("Color calibration is not exposed by the driver interface."), "igcl",
        ),
        "saturation": capability(
            Value::Null, Some(false), false, Some("Color calibration is not exposed by the driver interface."), "igcl",
        ),
        "brightness": capability(
            Value::Null, Some(false), false, Some("Color calibration is not exposed by the driver interface."), "igcl",
        ),
        "contrast": capability(
            Value::Null, Some(false), false, Some("Color calibration is not exposed by the driver interface."), "igcl",
        ),
        "supportedOptions": {
            "scalingModes": [],
            "scalingMethods": [],
            "vrrModes": [],
            "globalVrrModes": [],
            "wireFormats": [],
            "bpcDepths": [],
            "quantizationRanges": [],
            "colorRanges": {},
        },
        "flags": {
            "active": false,
            "attached": false,
            "dongleConnected": false,
            "ditheringEnabled": false,
        },
        "arcSync": {
            "supported": false, "minRefreshHz": Value::Null, "maxRefreshHz": Value::Null,
            "profile": Value::Null, "writable": false,
            "rangeBounds": Value::Null, "currentRange": Value::Null,
        },
    })
}

fn apply_active_output_mode_fallback(
    display: &mut Value,
    windows_modes: Option<&Result<WindowsDisplayModeSnapshot, String>>,
) -> bool {
    if display["flags"]["active"] != Value::Bool(true)
        || display_resolution(display).is_some()
    {
        return false;
    }
    let Some(display_name) = display["name"].as_str().filter(|name| !name.is_empty()) else { return false; };
    let Some(Ok(snapshot)) = windows_modes else { return false; };
    if !snapshot.complete || snapshot.truncated { return false; }

    // The Windows mode inventory spans all adapters. A sole row in that
    // inventory does not prove it belongs to this IGCL output, so only an
    // exact, unique normalized EDID label may select a mode for presentation.
    // This is not physical identity proof and is used only for presentation.
    let wanted = normalized_exact_display_label(display_name);
    if wanted.is_empty() { return false; }
    let matches: Vec<_> = snapshot.outputs.iter().filter(|output| {
        std::iter::once(output.display_name.as_str())
            .chain(std::iter::once(output.device_id.as_str()))
            .chain(output.monitors.iter().flat_map(|monitor| [monitor.device_string.as_str(), monitor.device_id.as_str()]))
            .any(|label| normalized_exact_display_label(label) == wanted)
    }).collect();
    let [output] = matches.as_slice() else { return false; };
    let mode = &output.current_mode;
    display["flags"]["attached"] = Value::Bool(true);
    display["resolution"] = json!({"width": mode.width, "height": mode.height});
    display["refreshRate"] = json!(mode.refresh_rate);
    true
}

fn normalized_exact_display_label(label: &str) -> String {
    super::windows_display_modes::normalized_display_label(label)
}

fn display_resolution(display: &Value) -> Option<(u32, u32)> {
    let width = u32::try_from(display["resolution"]["width"].as_u64()?).ok()?;
    let height = u32::try_from(display["resolution"]["height"].as_u64()?).ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

/// `displayCapability`: `{value, supported, controllable, reason, source}`.
fn capability(
    value: Value,
    supported: Option<bool>,
    controllable: bool,
    reason: Option<&str>,
    source: &str,
) -> Value {
    json!({
        "value": value,
        "supported": supported,
        "controllable": controllable,
        "reason": reason,
        "source": source,
    })
}

fn connection_name(kind: i32) -> &'static str {
    match kind {
        1 => "DisplayPort",
        2 => "HDMI",
        3 => "DVI",
        4 => "MIPI",
        5 => "CRT",
        _ => "Unknown",
    }
}

fn quantization_name(value: i32) -> Value {
    match value {
        0 => json!("default"),
        1 => json!("limited"),
        2 => json!("full"),
        _ => Value::Null,
    }
}

/// The 16-byte OS encoder handle as lowercase hex, or `None` when all zero.
fn encoder_id(bytes: &[u8; 16]) -> Option<String> {
    bytes.iter().any(|byte| *byte != 0)
        .then(|| bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// `_plausibleDisplayTiming`: an inactive output reports 0x0 @ 0 Hz.
pub(crate) fn plausible_timing(timing: &ctl_display_timing_t) -> bool {
    let refresh = f64::from(timing.RefreshRate);
    refresh.is_finite() && refresh > 10.0 && refresh <= 1000.0
        && timing.HActive > 320 && timing.HActive <= 16384
        && timing.VActive > 200 && timing.VActive <= 16384
        && timing.PixelClock > 0 && timing.PixelClock < 20_000_000_000
}

/// `edidMonitorName`: the EDID 0xFC display-name descriptor, trimmed.
pub(crate) fn monitor_name(data: &[u8]) -> Option<String> {
    let bytes = &data[..data.len().min(128)];
    let mut offset = 0x36;
    while offset + 18 <= bytes.len() {
        if bytes[offset] == 0 && bytes[offset + 1] == 0 && bytes[offset + 2] == 0
            && bytes[offset + 3] == 0xfc && bytes[offset + 4] == 0
        {
            let name: String = bytes[offset + 5..offset + 18].iter()
                .filter(|byte| (0x20..0x7f).contains(*byte))
                .map(|byte| char::from(*byte))
                .collect();
            let trimmed = name.trim_end_matches([' ', '\t']);
            if !trimmed.trim().is_empty() { return Some(trimmed.trim().to_owned()); }
        }
        offset += 18;
    }
    None
}

/// `edidFingerprintOf`: FNV-1a over the first 128 bytes, 8 lowercase hex.
/// Only an identity namespace, never a security hash.
pub(crate) fn edid_fingerprint(data: &[u8]) -> Option<String> {
    if data.len() < 128 { return None; }
    let mut hash: u32 = 2_166_136_261;
    for byte in &data[..128] { hash = (hash ^ u32::from(*byte)).wrapping_mul(16_777_619); }
    Some(format!("{hash:08x}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::display_scaling_state::SelectionUpdate;
    use super::super::windows_display_modes::WindowsDisplayOutput;
    use std::collections::HashMap;

    const DEVICE_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0";

    #[derive(Default)]
    struct Fixture {
        outputs: Vec<usize>,
        output_error: Option<String>,
        global_vrr: Option<GlobalVrrSurface>,
        global_vrr_error: Option<String>,
        properties: HashMap<usize, ctl_display_properties_t>,
        settings: HashMap<usize, ctl_display_settings_t>,
        edid: HashMap<usize, Vec<u8>>,
        wire_format: HashMap<usize, ctl_get_set_wire_format_config_t>,
        pixel: HashMap<usize, PixelTransformation>,
        scaling: HashMap<usize, ScalingSurface>,
        retro_caps: HashMap<usize, u32>,
        retro: HashMap<usize, ctl_retro_scaling_settings_t>,
        arc_sync_monitor: HashMap<usize, ctl_intel_arc_sync_monitor_params_t>,
        arc_sync_profile: HashMap<usize, ArcSyncProfileRead>,
        color: HashMap<usize, (Result<ColorCapabilityClassification, String>, bool)>,
    }

    impl DisplayRead for Fixture {
        fn outputs(&mut self) -> Result<Vec<usize>, String> {
            match &self.output_error {
                Some(error) => Err(error.clone()),
                None => Ok(self.outputs.clone()),
            }
        }
        fn properties(&mut self, output: usize) -> Option<ctl_display_properties_t> {
            self.properties.get(&output).copied()
        }
        fn settings(&mut self, output: usize) -> Option<ctl_display_settings_t> {
            self.settings.get(&output).copied()
        }
        fn edid(&mut self, output: usize) -> Option<Vec<u8>> {
            self.edid.get(&output).cloned()
        }
        fn wire_format(&mut self, output: usize) -> Option<ctl_get_set_wire_format_config_t> {
            self.wire_format.get(&output).copied()
        }
        fn pixel_transformation(&mut self, output: usize) -> Option<PixelTransformation> {
            self.pixel.get(&output).copied()
        }
        fn scaling(&mut self, output: usize) -> Option<ScalingSurface> {
            self.scaling.get(&output).map(|surface| ScalingSurface {
                caps: surface.caps,
                current: surface.current.as_ref().map(|current| ScalingRead {
                    version: current.version, settings: current.settings,
                }),
            })
        }
        fn retro_scaling_caps(&mut self, output: usize) -> Option<u32> {
            self.retro_caps.get(&output).copied()
        }
        fn retro_scaling(&mut self, output: usize) -> Option<ctl_retro_scaling_settings_t> {
            self.retro.get(&output).copied()
        }
        fn arc_sync_monitor(&mut self, output: usize) -> Option<ctl_intel_arc_sync_monitor_params_t> {
            self.arc_sync_monitor.get(&output).copied()
        }
        fn arc_sync_profile(&mut self, output: usize) -> Option<ArcSyncProfileRead> {
            self.arc_sync_profile.get(&output).copied()
        }
        fn global_vrr(&mut self) -> Result<Option<GlobalVrrSurface>, String> {
            match &self.global_vrr_error {
                Some(error) => Err(error.clone()),
                None => Ok(self.global_vrr.clone()),
            }
        }
        fn color_capabilities(&mut self, output: usize) -> Option<(Result<ColorCapabilityClassification, String>, bool)> {
            self.color.get(&output).cloned()
        }
    }

    fn windows_output(device_name: &str, display_name: &str, width: u32, height: u32, refresh_rate: u32) -> WindowsDisplayOutput {
        let mode = WindowsDisplayMode { width, height, refresh_rate, bits_per_pixel: 32, display_flags: 0, orientation: 0 };
        WindowsDisplayOutput {
            device_name: device_name.into(), display_name: display_name.into(), device_id: String::new(),
            monitors: Vec::new(), current_mode: mode.clone(), modes: vec![mode],
            display_identity: format!("MONITOR-{device_name}"),
        }
    }

    #[test]
    fn active_output_missing_igcl_timing_uses_only_a_unique_windows_mode() {
        let snapshot = Ok(WindowsDisplayModeSnapshot {
            complete: true,
            truncated: false,
            outputs: vec![
                windows_output("DISPLAY1", "Panel A", 1920, 1080, 60),
                windows_output("DISPLAY2", "Panel B", 2560, 1440, 144),
            ],
        });
        let mut display = json!({"name":"Panel A", "flags":{"active":true,"attached":false},
            "resolution":null, "refreshRate":null});
        apply_active_output_mode_fallback(&mut display, Some(&snapshot));
        assert_eq!(display["flags"]["active"], true);
        assert_eq!(display["flags"]["attached"], true);
        assert_eq!(display["resolution"], json!({"width":1920,"height":1080}));
        assert_eq!(display["refreshRate"], 60);

        // A label that matches multiple Windows outputs without a timing
        // discriminator must remain unavailable; the native reader cannot
        // guess which monitor belongs to this IGCL handle.
        let ambiguous = Ok(WindowsDisplayModeSnapshot {
            complete: true,
            truncated: false,
            outputs: vec![
                windows_output("DISPLAY1", "Shared Panel", 1920, 1080, 60),
                windows_output("DISPLAY2", "Shared Panel", 2560, 1440, 144),
            ],
        });
        let mut display = json!({"name":"Shared Panel", "flags":{"active":true,"attached":false},
            "resolution":null, "refreshRate":null});
        apply_active_output_mode_fallback(&mut display, Some(&ambiguous));
        assert_eq!(display["resolution"], Value::Null);
        assert_eq!(display["flags"]["attached"], false);

        // A single Windows row with a mismatched EDID label is not identity
        // proof: the row may belong to another adapter, so fail closed.
        let single = Ok(WindowsDisplayModeSnapshot {
            complete: true,
            truncated: false,
            outputs: vec![windows_output("DISPLAY1", "Windows label", 3840, 2160, 120)],
        });
        let mut display = json!({"name":"EDID label", "flags":{"active":true,"attached":false},
            "resolution":null, "refreshRate":null});
        assert_eq!(apply_active_output_mode_fallback(&mut display, Some(&single)), false);
        assert_eq!(display["resolution"], Value::Null);

        let matching_single = Ok(WindowsDisplayModeSnapshot {
            complete: true,
            truncated: false,
            outputs: vec![windows_output("DISPLAY1", "edid label", 3840, 2160, 120)],
        });
        let mut display = json!({"name":"EDID label", "flags":{"active":true,"attached":false},
            "resolution":null, "refreshRate":null});
        assert_eq!(apply_active_output_mode_fallback(&mut display, Some(&matching_single)), true);
        assert_eq!(display["resolution"], json!({"width":3840,"height":2160}));
        assert_eq!(display["resolution"], json!({"width":3840,"height":2160}),
            "the presentation fallback remains available to the Display read");

        let incomplete = Ok(WindowsDisplayModeSnapshot {
            complete: false,
            truncated: false,
            outputs: vec![windows_output("DISPLAY1", "Panel A", 1920, 1080, 60)],
        });
        let mut display = json!({"name":"Panel A", "flags":{"active":true,"attached":false},
            "resolution":null, "refreshRate":null});
        apply_active_output_mode_fallback(&mut display, Some(&incomplete));
        assert_eq!(display["resolution"], Value::Null);

        // IGCL's plausible active timing stays authoritative.
        let mut display = json!({"name":"Panel A", "flags":{"active":true,"attached":false},
            "resolution":{"width":1280,"height":720}, "refreshRate":75});
        apply_active_output_mode_fallback(&mut display, Some(&snapshot));
        assert_eq!(display["resolution"], json!({"width":1280,"height":720}));
        assert_eq!(display["refreshRate"], 75);
    }

    fn gpu_row(bus: u32) -> Value {
        json!({
            "pciVendorId": "0x00008086",
            "pciDeviceId": "0x0000e20b",
            "deviceKey": DEVICE_KEY,
            "bdf": {"bus": bus, "device": 0, "function": 0},
            "luid": "0x00000001:0x00000002",
        })
    }

    #[test]
    fn display_read_requires_the_renderer_selected_physical_gpu() {
        assert_eq!(verify_expected_device_key(&gpu_row(3), DEVICE_KEY).unwrap(), DEVICE_KEY);
        assert_eq!(verify_expected_device_key(&gpu_row(3), "pci:another-gpu").unwrap_err(), DISPLAY_STALE_DEVICE_ERROR);
        assert!(verify_expected_device_key(&gpu_row(3), "  ").unwrap_err().contains("identity is unavailable"));

        let mut malformed = gpu_row(3);
        malformed["deviceKey"] = json!("spoofed-key");
        assert!(verify_expected_device_key(&malformed, DEVICE_KEY).unwrap_err().contains("could not be verified"));
        assert!(verify_expected_device_key(&gpu_row(0), DEVICE_KEY).unwrap_err().contains("could not be verified"));
    }

    #[test]
    fn duplicate_active_output_identity_is_not_published_as_verified() {
        use super::super::display_color_capabilities::{classify_color_capability_blocks, ColorTransformBlockMetadata};

        let mut fixture = two_monitor_fixture();
        let mut duplicate = fixture.properties[&0];
        duplicate.Type = 2;
        fixture.properties.insert(1, duplicate);
        // Even a different EDID cannot disambiguate two active driver rows
        // that claim the same adapter-scoped encoder handle.
        fixture.edid.insert(1, edid(Some("Different Panel")));
        let caps = classify_color_capability_blocks(&[ColorTransformBlockMetadata {
            id: 1, block_type: 3, sampling_type: None, num_samples_per_channel: None, num_channels: None,
        }]);
        fixture.color.insert(0, (Ok(caps.clone()), true));
        fixture.color.insert(1, (Ok(caps), true));
        let color_store = FixtureColorStore(Default::default());

        let payload = read_payload_with_color(
            &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some("physical-bdf"),
            &FixtureStore::default(), Some(&color_store), None,
        ).unwrap();
        let displays = payload["displays"].as_array().unwrap();
        assert_eq!(displays.len(), 2);
        for display in displays {
            assert_eq!(display["identityVerified"], json!(false));
            assert_eq!(display["displayKey"], Value::Null);
            assert_eq!(display["hue"]["controllable"], json!(false));
            assert!(display["hue"].get("desiredValue").is_none());
        }
        assert!(color_store.0.borrow().is_empty(), "ambiguous output keys must not load saved per-display intent");
    }

    struct FixtureColorStore(std::cell::RefCell<Vec<String>>);
    impl ColorStateRead for FixtureColorStore {
        fn read_color(&self, key: &str) -> Result<ColorState, String> {
            self.0.borrow_mut().push(key.to_owned());
            Ok(ColorState { hue: 12.0, hue_saturation_sent: true, ..ColorState::default() })
        }
    }

    #[test]
    fn color_projection_uses_physical_namespace_and_keeps_intent_separate() {
        use super::super::display_color_capabilities::{classify_color_capability_blocks, ColorTransformBlockMetadata};
        let mut fixture = two_monitor_fixture();
        let caps = classify_color_capability_blocks(&[ColorTransformBlockMetadata {
            id: 1, block_type: 3, sampling_type: None, num_samples_per_channel: None, num_channels: None,
        }]);
        fixture.color.insert(0, (Ok(caps), true));
        let store = FixtureColorStore(Default::default());
        let payload = read_payload_with_color(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some("physical-bdf"), &FixtureStore::default(), Some(&store), None).unwrap();
        let output = &payload["displays"][0];
        assert_eq!(output["hue"]["value"], Value::Null);
        assert_eq!(output["hue"]["desiredValue"], json!(12.0));
        assert_eq!(output["hue"]["lastSent"], true);
        assert_eq!(output["hue"]["controllable"], true);
        assert_eq!(output["brightness"]["controllable"], false);
        assert!(store.0.borrow()[0].starts_with("physical-bdf|display|"));
    }

    #[test]
    fn color_projection_refuses_unverified_display_identity() {
        use super::super::display_color_capabilities::{classify_color_capability_blocks, ColorTransformBlockMetadata};
        let mut fixture = two_monitor_fixture();
        let caps = classify_color_capability_blocks(&[ColorTransformBlockMetadata {
            id: 1, block_type: 3, sampling_type: None, num_samples_per_channel: None, num_channels: None,
        }]);
        fixture.color.insert(0, (Ok(caps), true));
        let store = FixtureColorStore(Default::default());
        let payload = read_payload_with_color(&mut fixture, None, None, None,
            &FixtureStore::default(), Some(&store), None).unwrap();
        let hue = &payload["displays"][0]["hue"];
        assert_eq!(hue["supported"], true);
        assert_eq!(hue["controllable"], false);
        assert_eq!(hue["reason"], "A verified physical display identity is required.");
        assert!(hue.get("desiredValue").is_none());
        assert!(store.0.borrow().is_empty());
    }

    /// Read-only durable-store seam. Reconciliation is represented in the
    /// staged result; fixtures never expose a writer to that path.
    #[derive(Default)]
    struct FixtureStore {
        state: Option<ScalingSelection>,
        unreadable: bool,
    }

    impl ScalingState for FixtureStore {
        fn read(&self, _display_key: &str) -> Result<Option<ScalingSelection>, String> {
            if self.unreadable { return Err("Display scaling state is unreadable.".into()); }
            Ok(self.state)
        }
    }

    #[derive(Default)]
    struct FixtureReconcileStore {
        records: std::cell::RefCell<std::collections::HashMap<String, ScalingSelection>>,
        writes: std::cell::RefCell<Vec<String>>,
    }

    impl ScalingState for FixtureReconcileStore {
        fn read(&self, display_key: &str) -> Result<Option<ScalingSelection>, String> {
            Ok(self.records.borrow().get(display_key).copied())
        }
    }

    impl ScalingStateReconcile for FixtureReconcileStore {
        fn invalidate_if_current(&self, display_key: &str, expected: ScalingSelection) -> Result<bool, String> {
            let mut records = self.records.borrow_mut();
            if records.get(display_key).copied() != Some(expected) || !expected.identity_scaling {
                return Ok(false);
            }
            records.insert(display_key.to_owned(), ScalingSelection { identity_scaling: false, ..expected });
            self.writes.borrow_mut().push(display_key.to_owned());
            Ok(true)
        }
    }

    fn staged_stale_scaling_fixture() -> (Fixture, ScalingInvalidation) {
        let mut fixture = colour_fixture();
        let expected = ScalingSelection {
            identity_scaling: true,
            native_preferred_scaling_type: Some(8),
            custom_x: Some(90),
            custom_y: Some(70),
        };
        let staged = read_payload_staged(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &FixtureStore { state: Some(expected), ..FixtureStore::default() })
            .expect("fixture output should produce a staged scaling invalidation");
        assert_eq!(staged.scaling_invalidations.len(), 1);
        (fixture, staged.scaling_invalidations[0].clone())
    }

    #[test]
    fn scaling_reconciliation_waits_for_ownership_then_rechecks_output_driver_and_record() {
        let (mut fixture, invalidation) = staged_stale_scaling_fixture();
        let guard = super::super::display_lock::acquire().unwrap();
        let store = FixtureReconcileStore::default();
        store.records.borrow_mut().insert(invalidation.display_key.clone(), invalidation.expected);
        let mut rechecks = 0;

        assert_eq!(reconcile_scaling_invalidations_after_ownership(
            &guard, false, std::slice::from_ref(&invalidation), &store,
            |_| { rechecks += 1; Ok(None) },
        ), ScalingInvalidationOutcome::DeclinedNothingWritten);
        assert_eq!(rechecks, 0, "unaccepted native reads cannot inspect or mutate shared state");
        assert!(store.writes.borrow().is_empty());

        assert_eq!(reconcile_scaling_invalidations_after_ownership(
            &guard, true, &[invalidation.clone(), invalidation.clone()], &store,
            |_| { rechecks += 1; Ok(Some(ObservedScaling {
                enable: invalidation.observed_enable,
                scaling_type: invalidation.observed_scaling_type,
                preferred_type: invalidation.observed_preferred_type,
            })) },
        ), ScalingInvalidationOutcome::DeclinedNothingWritten);
        assert_eq!(rechecks, 0, "several stale selectors decline before the first record is touched");
        assert!(store.writes.borrow().is_empty());

        assert_eq!(reconcile_scaling_invalidations_after_ownership(
            &guard, true, std::slice::from_ref(&invalidation), &store,
            |intent| revalidate_scaling_invalidation(&mut fixture, DEVICE_KEY, Some(DEVICE_KEY), intent),
        ), ScalingInvalidationOutcome::Committed);
        assert_eq!(store.writes.borrow().as_slice(), &[invalidation.display_key.clone()]);
        assert_eq!(store.records.borrow().get(&invalidation.display_key), Some(&ScalingSelection {
            identity_scaling: false, ..invalidation.expected
        }));
    }

    #[test]
    fn scaling_reconciliation_refuses_changed_driver_tuple_duplicate_output_and_saved_record() {
        let guard = super::super::display_lock::acquire().unwrap();

        let (mut changed_driver, invalidation) = staged_stale_scaling_fixture();
        let state = &mut changed_driver.scaling.get_mut(&0).unwrap().current.as_mut().unwrap().settings;
        state.PreferredScalingType = 8; // The live fingerprint returned to the saved value after staging.
        let store = FixtureReconcileStore::default();
        store.records.borrow_mut().insert(invalidation.display_key.clone(), invalidation.expected);
        assert_eq!(reconcile_scaling_invalidations_after_ownership(
            &guard, true, std::slice::from_ref(&invalidation), &store,
            |intent| revalidate_scaling_invalidation(&mut changed_driver, DEVICE_KEY, Some(DEVICE_KEY), intent),
        ), ScalingInvalidationOutcome::DeclinedNothingWritten);
        assert!(store.writes.borrow().is_empty());
        assert_eq!(store.records.borrow().get(&invalidation.display_key), Some(&invalidation.expected));

        let (mut duplicate, duplicate_invalidation) = staged_stale_scaling_fixture();
        let mut second = duplicate.properties[&0];
        second.DisplayConfigFlags |= DISPLAY_CONFIG_ACTIVE;
        duplicate.properties.insert(1, second);
        let store = FixtureReconcileStore::default();
        store.records.borrow_mut().insert(duplicate_invalidation.display_key.clone(), duplicate_invalidation.expected);
        assert_eq!(reconcile_scaling_invalidations_after_ownership(
            &guard, true, std::slice::from_ref(&duplicate_invalidation), &store,
            |intent| revalidate_scaling_invalidation(&mut duplicate, DEVICE_KEY, Some(DEVICE_KEY), intent),
        ), ScalingInvalidationOutcome::DeclinedNothingWritten);
        assert!(store.writes.borrow().is_empty(), "duplicate active encoder handles cannot be reconciled");

        let (mut current_driver, current_invalidation) = staged_stale_scaling_fixture();
        let changed_record = ScalingSelection { identity_scaling: false, ..current_invalidation.expected };
        let store = FixtureReconcileStore::default();
        store.records.borrow_mut().insert(current_invalidation.display_key.clone(), changed_record);
        assert_eq!(reconcile_scaling_invalidations_after_ownership(
            &guard, true, std::slice::from_ref(&current_invalidation), &store,
            |intent| revalidate_scaling_invalidation(&mut current_driver, DEVICE_KEY, Some(DEVICE_KEY), intent),
        ), ScalingInvalidationOutcome::DeclinedNothingWritten);
        assert!(store.writes.borrow().is_empty(), "a newer saved selection cannot be overwritten by an old intent");
    }

    fn read_fixture(fixture: &mut Fixture) -> Value {
        read_payload(fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &FixtureStore::default()).expect("fixture output enumeration should succeed")
    }

    fn zeroed_properties() -> ctl_display_properties_t {
        unsafe { std::mem::zeroed() }
    }

    fn zeroed_settings() -> ctl_display_settings_t {
        unsafe { std::mem::zeroed() }
    }

    fn timing(width: u32, height: u32, refresh: f32) -> ctl_display_timing_t {
        let mut timing = unsafe { std::mem::zeroed::<ctl_display_timing_t>() };
        timing.HActive = width;
        timing.VActive = height;
        timing.HTotal = width + 160;
        timing.VTotal = height + 41;
        timing.RefreshRate = refresh;
        timing.PixelClock = u64::from(width) * u64::from(height) * 4;
        timing
    }

    fn encoder(first: u8) -> [u8; 16] {
        let mut bytes = [0_u8; 16];
        bytes[0] = first;
        bytes[15] = 0xaa;
        bytes
    }

    /// A 128-byte EDID block with an optional 0xFC monitor-name descriptor.
    fn edid(name: Option<&str>) -> Vec<u8> {
        let mut data = vec![0_u8; 128];
        data[0..8].copy_from_slice(&[0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00]);
        data[8..10].copy_from_slice(&[0x4d, 0x53]);
        if let Some(name) = name {
            let offset = 0x36;
            data[offset + 3] = 0xfc;
            let mut written = 0;
            for byte in name.bytes().take(13) {
                data[offset + 5 + written] = byte;
                written += 1;
            }
        }
        data
    }

    /// DP active (HDCP + HDR + quantization), HDMI active, inactive output.
    fn two_monitor_fixture() -> Fixture {
        let mut fixture = Fixture { outputs: vec![0, 1, 2], ..Fixture::default() };

        let mut display_port = zeroed_properties();
        display_port.Type = 1;
        display_port.Os_display_encoder_handle = encoder(0x41);
        display_port.DisplayConfigFlags =
            DISPLAY_CONFIG_ACTIVE | DISPLAY_CONFIG_ATTACHED | DISPLAY_CONFIG_DITHERING;
        display_port.FeatureSupportedFlags = DISPLAY_FEATURE_HDCP | DISPLAY_FEATURE_HDR;
        display_port.Display_Timing_Info = timing(2560, 1440, 144.0);
        fixture.properties.insert(0, display_port);

        let mut hdmi = zeroed_properties();
        hdmi.Type = 2;
        hdmi.Os_display_encoder_handle = encoder(0x42);
        hdmi.DisplayConfigFlags = DISPLAY_CONFIG_ACTIVE | DISPLAY_CONFIG_ATTACHED | DISPLAY_CONFIG_DONGLE;
        hdmi.FeatureSupportedFlags = DISPLAY_FEATURE_HDR;
        hdmi.Display_Timing_Info = timing(1920, 1080, 60.0);
        fixture.properties.insert(1, hdmi);

        // The probe's inactive shape: attached-ish flags unset, 0x0 @ 0 Hz.
        let mut inactive = zeroed_properties();
        inactive.Type = 1;
        inactive.Os_display_encoder_handle = encoder(0x43);
        fixture.properties.insert(2, inactive);

        let mut settings = zeroed_settings();
        settings.ControllableFlags = DISPLAY_SETTING_QUANTIZATION_RANGE;
        settings.QuantizationRange = 2;
        fixture.settings.insert(0, settings);

        fixture.edid.insert(0, edid(Some("MSI G27C4 E3")));
        fixture.edid.insert(1, edid(Some("LG TV SSCR2")));
        fixture
    }

    #[test]
    fn two_monitor_fixture_decodes_to_the_electron_payload() {
        let mut fixture = two_monitor_fixture();
        let payload = read_fixture(&mut fixture);

        assert_eq!(payload["deviceKey"], json!(DEVICE_KEY));
        assert_eq!(payload["adapterName"], json!("Intel Arc B580"));
        let displays = payload["displays"].as_array().unwrap();
        assert_eq!(displays.len(), 2, "only active outputs are returned");

        let dp = &displays[0];
        assert_eq!(dp["id"], json!(0));
        assert_eq!(dp["identityVerified"], json!(true));
        assert_eq!(dp["name"], json!("MSI G27C4 E3"));
        assert_eq!(dp["connection"], json!("DisplayPort"));
        assert_eq!(dp["resolution"], json!({"width": 2560, "height": 1440}));
        assert_eq!(dp["refreshRate"], json!(144.0));
        assert_eq!(dp["flags"], json!({
            "active": true, "attached": true, "dongleConnected": false, "ditheringEnabled": true,
        }));
        // HDCP + HDR both come from the supported bitmask.
        assert_eq!(dp["hdcpSupport"], json!({
            "value": true, "supported": true, "controllable": false,
            "reason": "Read-only display capability.", "source": "igcl-display-properties",
        }));
        assert_eq!(dp["hdrSupport"]["value"], json!(true));
        assert_eq!(dp["quantizationRange"], json!("full"));
        assert_eq!(dp["supportedOptions"]["quantizationRanges"], json!(["default", "limited", "full"]));

        // Identity: <deviceKey>|display|<encoder hex>|edid|<fnv1a8>.
        let key = dp["displayKey"].as_str().unwrap();
        let encoder_hex: String = encoder(0x41).iter().map(|b| format!("{b:02x}")).collect();
        let mut parts = key.split('|');
        assert_eq!(parts.next(), Some(DEVICE_KEY));
        assert_eq!(parts.next(), Some("display"));
        assert_eq!(parts.next(), Some(encoder_hex.as_str()));
        assert_eq!(parts.next(), Some("edid"));
        let fingerprint = parts.next().unwrap();
        assert_eq!(fingerprint.len(), 8);
        assert_eq!(
            key,
            format!("{DEVICE_KEY}|display|{encoder_hex}|edid|{}",
                edid_fingerprint(&edid(Some("MSI G27C4 E3"))).unwrap()),
        );

        let hdmi = &displays[1];
        assert_eq!(hdmi["id"], json!(1));
        assert_eq!(hdmi["connection"], json!("HDMI"));
        assert_eq!(hdmi["resolution"], json!({"width": 1920, "height": 1080}));
        assert_eq!(hdmi["flags"]["dongleConnected"], json!(true));
        assert_eq!(hdmi["flags"]["ditheringEnabled"], json!(false));
        assert_eq!(hdmi["hdcpSupport"]["value"], json!(false));
        assert_eq!(hdmi["hdrSupport"]["value"], json!(true));
        // No settings fixture for the HDMI output: quantization degrades only.
        assert_eq!(hdmi["quantizationRange"], Value::Null);
        assert_eq!(hdmi["supportedOptions"]["quantizationRanges"], json!([]));
        assert_eq!(hdmi["name"], json!("LG TV SSCR2"));
    }

    #[test]
    fn native_display_ownership_preflight_rejects_electron_only_windows_fallbacks() {
        let stage = read_payload_staged(&mut two_monitor_fixture(), Some(DEVICE_KEY),
            Some("Intel Arc B580"), Some(DEVICE_KEY), &FixtureStore::default()).unwrap();
        assert!(stage.native_ownership_eligible,
            "inactive rows without an EDID name cannot be promoted by Electron's fallback");

        let mut named_inactive = two_monitor_fixture();
        named_inactive.edid.insert(2, edid(Some("Disconnected Panel")));
        let stage = read_payload_staged(&mut named_inactive, Some(DEVICE_KEY),
            Some("Intel Arc B580"), Some(DEVICE_KEY), &FixtureStore::default()).unwrap();
        assert!(!stage.native_ownership_eligible,
            "Electron may promote a named inactive row through Windows mode lookup");

        let mut active_without_timing = two_monitor_fixture();
        let mut props = active_without_timing.properties[&0];
        props.Display_Timing_Info = timing(0, 0, 0.0);
        active_without_timing.properties.insert(0, props);
        let stage = read_payload_staged(&mut active_without_timing, Some(DEVICE_KEY),
            Some("Intel Arc B580"), Some(DEVICE_KEY), &FixtureStore::default()).unwrap();
        assert!(!stage.native_ownership_eligible,
            "Electron may fill a named active row's missing timing from Windows");

        let mut duplicate_encoder = two_monitor_fixture();
        let mut props = duplicate_encoder.properties[&1];
        props.Os_display_encoder_handle = encoder(0x41);
        duplicate_encoder.properties.insert(1, props);
        let stage = read_payload_staged(&mut duplicate_encoder, Some(DEVICE_KEY),
            Some("Intel Arc B580"), Some(DEVICE_KEY), &FixtureStore::default()).unwrap();
        assert!(!stage.native_ownership_eligible,
            "the native projection intentionally withholds duplicate active identities");

        let mut unnamed_active_without_timing = two_monitor_fixture();
        let mut props = unnamed_active_without_timing.properties[&0];
        props.Display_Timing_Info = timing(0, 0, 0.0);
        unnamed_active_without_timing.properties.insert(0, props);
        unnamed_active_without_timing.edid.remove(&0);
        let stage = read_payload_staged(&mut unnamed_active_without_timing, Some(DEVICE_KEY),
            Some("Intel Arc B580"), Some(DEVICE_KEY), &FixtureStore::default()).unwrap();
        assert!(stage.native_ownership_eligible,
            "without an EDID name Electron cannot run its Windows fallback");
    }

    #[test]
    fn an_ineligible_display_candidate_is_rejected_before_scaling_reconciliation() {
        use std::cell::Cell;

        let mut fixture = colour_fixture();
        fixture.edid.insert(2, edid(Some("Disconnected Panel")));
        let expected = ScalingSelection {
            identity_scaling: true, native_preferred_scaling_type: Some(8),
            custom_x: Some(90), custom_y: Some(70),
        };
        let store = FixtureStore { state: Some(expected), ..FixtureStore::default() };
        let staged = read_payload_with_color_staged(
            &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &store, None, None, None,
        ).unwrap();
        assert!(!staged.native_ownership_eligible);
        assert_eq!(staged.scaling_invalidations.len(), 1);

        let guard = super::super::display_lock::acquire().unwrap();
        let reconcile_calls = Cell::new(0);
        let accepted = accept_staged_display_read(&guard, staged, |_| {
            reconcile_calls.set(reconcile_calls.get() + 1);
            ScalingInvalidationOutcome::Committed
        }).unwrap();
        assert!(accepted.is_none());
        assert_eq!(reconcile_calls.get(), 0,
            "candidate rejection must precede any scaling-store read or write");
    }

    #[test]
    fn staging_failures_decline_before_reconciliation_for_keyed_broker_retry() {
        assert_eq!(decline_before_reconciliation(DISPLAY_STALE_DEVICE_ERROR.into()), Ok(None));
        assert_eq!(decline_before_reconciliation("The IGCL display runtime is unavailable.".into()), Ok(None));
        assert_eq!(decline_before_reconciliation(GLOBAL_VRR_SCOPE_SELECTION_ERROR.into()), Ok(None));
    }

    #[test]
    fn accept_maps_the_reconciliation_outcome_to_payload_decline_or_failure() {
        use std::cell::Cell;

        let (mut fixture, invalidation) = staged_stale_scaling_fixture();
        let expected = invalidation.expected;
        let mut make_staged = || {
            read_payload_with_color_staged(
                &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
                &FixtureStore { state: Some(expected), ..FixtureStore::default() }, None, None, None,
            ).unwrap()
        };
        let guard = super::super::display_lock::acquire().unwrap();
        let reconcile_calls = Cell::new(0);

        // A pre-write decline is a broker delegation, never a hard error.
        let mut staged = make_staged();
        staged.native_ownership_eligible = true;
        assert_eq!(staged.scaling_invalidations.len(), 1);
        assert_eq!(accept_staged_display_read(&guard, staged, |_| {
            reconcile_calls.set(reconcile_calls.get() + 1);
            ScalingInvalidationOutcome::DeclinedNothingWritten
        }).unwrap(), None);
        assert_eq!(reconcile_calls.get(), 1);

        let mut staged = make_staged();
        staged.native_ownership_eligible = true;
        assert_eq!(accept_staged_display_read(&guard, staged, |_| {
            ScalingInvalidationOutcome::FailedAfterWrite("reconciliation write may have partially completed".into())
        }).unwrap_err(), "reconciliation write may have partially completed");
    }

    /// A reconcile store that proves the preflight but then refuses or fails the
    /// commit, so a write-phase outcome is observable without mutating a
    /// durable record.
    #[derive(Default)]
    struct RefusingCommitStore {
        state: Option<ScalingSelection>,
        error: Option<String>,
        attempts: std::cell::RefCell<Vec<String>>,
    }

    impl ScalingState for RefusingCommitStore {
        fn read(&self, _display_key: &str) -> Result<Option<ScalingSelection>, String> {
            Ok(self.state)
        }
    }

    impl ScalingStateReconcile for RefusingCommitStore {
        fn invalidate_if_current(&self, display_key: &str, _expected: ScalingSelection) -> Result<bool, String> {
            self.attempts.borrow_mut().push(display_key.to_owned());
            match &self.error {
                Some(error) => Err(error.clone()),
                None => Ok(false),
            }
        }
    }

    fn stale_scaling_selection() -> ScalingSelection {
        ScalingSelection {
            identity_scaling: true, native_preferred_scaling_type: Some(8),
            custom_x: Some(90), custom_y: Some(70),
        }
    }

    /// Stage one read of `fixture` against a stale identity-scaling record. A
    /// plain function keeps the fixture borrow free between successive staging
    /// and reconciliation calls in one test.
    fn stage_stale_scaling_read(fixture: &mut Fixture, expected: ScalingSelection) -> StagedDisplayRead {
        read_payload_with_color_staged(
            fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &FixtureStore { state: Some(expected), ..FixtureStore::default() }, None, None, None,
        ).expect("fixture output should produce a staged scaling invalidation")
    }

    /// Both active outputs carry a stale identity-scaling record, so one read
    /// stages two independent invalidations.
    fn two_stale_scaling_read(fixture: &mut Fixture) -> StagedDisplayRead {
        fixture.scaling.insert(1, scaling_surface(1, scaling_settings(1, 1, 3, (100, 80), 0)));
        let staged = stage_stale_scaling_read(fixture, stale_scaling_selection());
        assert_eq!(staged.scaling_invalidations.len(), 2,
            "both active outputs must stage an invalidation for this fixture");
        assert!(staged.native_ownership_eligible);
        staged
    }

    #[test]
    fn two_stale_scaling_records_decline_before_any_store_write() {
        let mut fixture = colour_fixture();
        let staged = two_stale_scaling_read(&mut fixture);
        let guard = super::super::display_lock::acquire().unwrap();
        let store = FixtureReconcileStore::default();
        for invalidation in &staged.scaling_invalidations {
            store.records.borrow_mut().insert(invalidation.display_key.clone(), invalidation.expected);
        }

        let accepted = accept_staged_display_read(&guard, staged, |invalidations| {
            reconcile_scaling_invalidations_after_ownership(
                &guard, true, invalidations, &store,
                |intent| revalidate_scaling_invalidation(&mut fixture, DEVICE_KEY, Some(DEVICE_KEY), intent),
            )
        });

        assert_eq!(accepted, Ok(None),
            "two stale records must decline so the broker can self-heal every record in one read");
        assert!(store.writes.borrow().is_empty(), "a decline must not write any record");
        assert!(store.records.borrow().values().all(|selection| selection.identity_scaling),
            "a decline must leave every stale record untouched");
    }

    #[test]
    fn a_refused_single_record_commit_still_fails_closed() {
        let mut fixture = colour_fixture();
        let expected = stale_scaling_selection();
        let staged = stage_stale_scaling_read(&mut fixture, expected);
        assert_eq!(staged.scaling_invalidations.len(), 1);
        let guard = super::super::display_lock::acquire().unwrap();
        let store = RefusingCommitStore { state: Some(expected), ..RefusingCommitStore::default() };

        let accepted = accept_staged_display_read(&guard, staged, |invalidations| {
            reconcile_scaling_invalidations_after_ownership(
                &guard, true, invalidations, &store,
                |intent| revalidate_scaling_invalidation(&mut fixture, DEVICE_KEY, Some(DEVICE_KEY), intent),
            )
        });

        assert_eq!(accepted, Err(DISPLAY_READ_UNPROVEN_ERROR.to_owned()),
            "a single record that may not commit must fail closed, never decline");
        assert_eq!(store.attempts.borrow().len(), 1, "the commit attempt is observable");
    }

    #[test]
    fn a_reconcile_error_after_the_preflight_still_fails_closed() {
        let mut fixture = colour_fixture();
        let expected = stale_scaling_selection();
        let staged = stage_stale_scaling_read(&mut fixture, expected);
        assert_eq!(staged.scaling_invalidations.len(), 1);
        let guard = super::super::display_lock::acquire().unwrap();
        let store = RefusingCommitStore {
            state: Some(expected),
            error: Some("reconciliation write may have partially completed".into()),
            ..RefusingCommitStore::default()
        };

        let accepted = accept_staged_display_read(&guard, staged, |invalidations| {
            reconcile_scaling_invalidations_after_ownership(
                &guard, true, invalidations, &store,
                |intent| revalidate_scaling_invalidation(&mut fixture, DEVICE_KEY, Some(DEVICE_KEY), intent),
            )
        });

        assert_eq!(accepted, Err("reconciliation write may have partially completed".to_owned()),
            "a failure raised after the preflight must never turn into a broker decline");
        assert_eq!(store.attempts.borrow().len(), 1, "the failing commit was attempted");
    }

    #[test]
    fn a_single_stale_scaling_record_is_written_once_and_accepted() {
        let mut fixture = colour_fixture();
        let expected = stale_scaling_selection();
        let store = FixtureReconcileStore::default();

        let staged = stage_stale_scaling_read(&mut fixture, expected);
        assert_eq!(staged.scaling_invalidations.len(), 1);
        let display_key = staged.scaling_invalidations[0].display_key.clone();
        store.records.borrow_mut().insert(display_key.clone(), expected);
        let guard = super::super::display_lock::acquire().unwrap();

        let accepted = accept_staged_display_read(&guard, staged, |invalidations| {
            reconcile_scaling_invalidations_after_ownership(
                &guard, true, invalidations, &store,
                |intent| revalidate_scaling_invalidation(&mut fixture, DEVICE_KEY, Some(DEVICE_KEY), intent),
            )
        }).expect("the single stale record must be reconciled natively");
        let payload = accepted.expect("a committed reconciliation returns the native payload");
        assert_eq!(payload["displays"].as_array().unwrap().len(), 2);
        assert_eq!(store.writes.borrow().as_slice(), std::slice::from_ref(&display_key),
            "the stale record is invalidated exactly once");
        assert_eq!(store.records.borrow().get(&display_key),
            Some(&ScalingSelection { identity_scaling: false, ..expected }));

        // Replaying the same stale candidate must not invalidate it again.
        let mut retry_fixture = colour_fixture();
        let retry = stage_stale_scaling_read(&mut retry_fixture, expected);
        let second = accept_staged_display_read(&guard, retry, |invalidations| {
            reconcile_scaling_invalidations_after_ownership(
                &guard, true, invalidations, &store,
                |intent| revalidate_scaling_invalidation(&mut retry_fixture, DEVICE_KEY, Some(DEVICE_KEY), intent),
            )
        });
        assert_eq!(store.writes.borrow().len(), 1, "a record is never invalidated twice");
        assert!(!matches!(second, Ok(Some(_))),
            "an already invalidated record is never re-accepted as stale");
    }

    #[test]
    fn payload_keeps_the_oracle_key_set_and_deferred_defaults() {
        let mut fixture = two_monitor_fixture();
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        let mut keys: Vec<&str> = dp.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        let mut expected = vec![
            "id", "displayKey", "identityVerified", "name", "connection", "resolution",
            "refreshRate", "colorDepth", "colorFormat", "quantizationRange", "scalingMode",
            "preferredScalingMode", "scalingPreferenceSource", "customScalingPreference",
            "scalingPreference", "scalingDetails", "scalingMethod",
            "globalVrrMode", "vrrMode", "variableRefreshRate", "vrrCurrentRange",
            "vrrMaximumRange", "hdcpSupport", "fourKSupport", "hdrSupport", "hue",
            "saturation", "brightness", "contrast", "supportedOptions", "flags", "arcSync",
        ];
        expected.sort_unstable();
        assert_eq!(keys, expected);

        // Deferred controls keep Electron's literal defaults.
        assert_eq!(dp["colorDepth"], Value::Null);
        assert_eq!(dp["colorFormat"], Value::Null);
        assert_eq!(dp["scalingMode"], Value::Null);
        assert_eq!(dp["scalingDetails"], Value::Null);
        assert_eq!(dp["fourKSupport"], json!({
            "value": Value::Null, "supported": Value::Null, "controllable": false,
            "reason": "4K support is not exposed by the driver interface.", "source": "igcl",
        }));
        assert_eq!(dp["hue"]["reason"], json!("Color calibration is not exposed by the driver interface."));
        assert_eq!(dp["arcSync"], json!({
            "supported": false, "minRefreshHz": Value::Null, "maxRefreshHz": Value::Null,
            "profile": Value::Null, "writable": false,
            "rangeBounds": Value::Null, "currentRange": Value::Null,
        }));
        assert!(dp.get("superResolution").is_none(), "Display Super Resolution is not part of the public payload");
        assert_eq!(dp["supportedOptions"]["wireFormats"], json!([]));
        assert_eq!(dp["supportedOptions"]["colorRanges"], json!({}));
        let mut option_keys: Vec<&str> = dp["supportedOptions"].as_object().unwrap().keys().map(String::as_str).collect();
        option_keys.sort_unstable();
        assert_eq!(option_keys,
            vec!["bpcDepths", "colorRanges", "globalVrrModes", "quantizationRanges",
                "scalingMethods", "scalingModes", "vrrModes", "wireFormats"]);
    }

    #[test]
    fn arc_sync_monitor_and_profile_gets_fill_the_read_only_vrr_surface() {
        let mut fixture = two_monitor_fixture();
        fixture.arc_sync_monitor.insert(0, arc_sync_monitor(true, 48.0, 180.0));
        fixture.arc_sync_profile.insert(0, arc_sync_profile(1, 90.0, 180.0, true));

        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["arcSync"], json!({
            "supported": true,
            "minRefreshHz": 48.0,
            "maxRefreshHz": 180.0,
            "profile": "recommended",
            "writable": true,
            "rangeBounds": {"minHz": 48.0, "maxHz": 180.0},
            "currentRange": {"minHz": 90.0, "maxHz": 180.0},
        }));
        assert_eq!(dp["vrrMaximumRange"], json!({
            "value": "48 Hz - 180 Hz", "supported": true, "controllable": false,
            "reason": "Read-only driver capability.", "source": "igcl",
        }));
        assert_eq!(dp["vrrCurrentRange"], json!({
            "value": "90 Hz - 180 Hz", "supported": true, "controllable": false,
            "reason": "Read-only driver capability.", "source": "igcl",
        }));
        assert_eq!(dp["vrrMode"], json!({
            "value": "recommended", "supported": true, "controllable": true,
            "reason": Value::Null, "source": "igcl",
        }));
        assert_eq!(dp["variableRefreshRate"], json!({
            "value": true, "supported": true, "controllable": true,
            "reason": Value::Null, "source": "igcl-arc-sync-profile",
        }));
        assert_eq!(dp["supportedOptions"]["vrrModes"], json!(ARC_SYNC_PROFILE_NAMES));

        // OFF is a recognized profile and reports VRR disabled, while the
        // current range stays read-only and no write path is exercised.
        fixture.arc_sync_profile.insert(0, arc_sync_profile(ARC_SYNC_OFF_PROFILE, 48.0, 180.0, false));
        let off = read_fixture(&mut fixture);
        let dp = &off["displays"][0];
        assert_eq!(dp["arcSync"]["profile"], json!("off"));
        assert_eq!(dp["variableRefreshRate"]["value"], json!(false));
        assert_eq!(dp["variableRefreshRate"]["controllable"], json!(false));
        assert_eq!(dp["variableRefreshRate"]["reason"], json!("Arc Sync setter is not available in this driver runtime."));
    }

    #[test]
    fn unsupported_or_unknown_arc_sync_data_does_not_create_vrr_controls() {
        let mut fixture = two_monitor_fixture();
        fixture.arc_sync_monitor.insert(0, arc_sync_monitor(false, 0.0, 0.0));
        fixture.arc_sync_profile.insert(0, arc_sync_profile(99, 0.0, 0.0, true));

        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["arcSync"], json!({
            "supported": false,
            "minRefreshHz": Value::Null,
            "maxRefreshHz": Value::Null,
            "profile": Value::Null,
            "writable": false,
            "rangeBounds": Value::Null,
            "currentRange": Value::Null,
        }));
        assert_eq!(dp["vrrMaximumRange"]["supported"], json!(false));
        assert_eq!(dp["vrrMode"]["supported"], json!(false));
        assert_eq!(dp["vrrMode"]["controllable"], json!(false));
        assert_eq!(dp["variableRefreshRate"]["value"], Value::Null);
        assert_eq!(dp["variableRefreshRate"]["supported"], json!(false));
        assert_eq!(dp["vrrCurrentRange"]["supported"], Value::Null);
        assert_eq!(dp["supportedOptions"]["vrrModes"], json!([]));
    }

    #[test]
    fn arc_sync_range_bounds_come_from_the_display_mode_list_and_monitor_window() {
        let mut fixture = two_monitor_fixture();
        // The monitor window is 48-180 while the display's own mode list at
        // the resolution in use runs to 240: the driver window is the ceiling.
        fixture.arc_sync_monitor.insert(0, arc_sync_monitor(true, 48.0, 180.0));
        fixture.arc_sync_profile.insert(0, arc_sync_profile(7, 180.0, 180.0, true));
        let mode = |rate: u32| WindowsDisplayMode {
            width: 2560, height: 1440, refresh_rate: rate,
            bits_per_pixel: 32, display_flags: 0, orientation: 0,
        };
        let snapshot = super::super::windows_display_modes::WindowsDisplayModeSnapshot {
            outputs: vec![super::super::windows_display_modes::WindowsDisplayOutput {
                device_name: "DISPLAY1".into(),
                display_name: "MSI G27C4 E3".into(),
                device_id: "GPU-A".into(),
                monitors: vec![],
                current_mode: mode(144),
                modes: [48_u32, 60, 100, 144, 165, 180, 240].into_iter().map(mode).collect(),
                display_identity: "MONITOR-A".into(),
            }],
            complete: true,
            truncated: false,
        };
        let windows = Ok(snapshot);
        let payload = read_payload_with_color(
            &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &FixtureStore::default(), None, Some(&windows),
        ).unwrap();
        let dp = &payload["displays"][0];
        assert_eq!(dp["arcSync"]["rangeBounds"], json!({"minHz": 48.0, "maxHz": 180.0}));
        assert_eq!(dp["arcSync"]["writable"], json!(true));
        assert_eq!(dp["arcSync"]["currentRange"], json!({"minHz": 180.0, "maxHz": 180.0}));

        // Without the setter the profile is readable but not writable, so no
        // Arc Sync range control may be exposed even with a valid window.
        fixture.arc_sync_profile.insert(0, arc_sync_profile(7, 180.0, 180.0, false));
        let payload = read_payload_with_color(
            &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &FixtureStore::default(), None, Some(&windows),
        ).unwrap();
        assert_eq!(payload["displays"][0]["arcSync"]["writable"], json!(false));
        assert_eq!(payload["displays"][0]["arcSync"]["rangeBounds"], json!({"minHz": 48.0, "maxHz": 180.0}));
    }

    #[test]
    fn arc_sync_range_bounds_fall_back_to_the_driver_window_without_a_complete_mode_inventory() {
        let mut fixture = two_monitor_fixture();
        fixture.arc_sync_monitor.insert(0, arc_sync_monitor(true, 48.0, 180.0));
        fixture.arc_sync_profile.insert(0, arc_sync_profile(7, 180.0, 180.0, true));
        let failed: Result<super::super::windows_display_modes::WindowsDisplayModeSnapshot, String> =
            Err("enumeration failed".into());
        let payload = read_payload_with_color(
            &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &FixtureStore::default(), None, Some(&failed),
        ).unwrap();
        // The driver reports the window itself, so an unreadable Windows
        // inventory cannot gate the control: the driver window is admitted.
        assert_eq!(payload["displays"][0]["arcSync"]["rangeBounds"],
            json!({"minHz": 48.0, "maxHz": 180.0}));
        assert_eq!(payload["displays"][0]["arcSync"]["minRefreshHz"], json!(48.0));

        // An incomplete or truncated inventory falls back the same way.
        let mut incomplete = super::super::windows_display_modes::WindowsDisplayModeSnapshot {
            outputs: Vec::new(), complete: false, truncated: false,
        };
        let incomplete_payload = read_payload_with_color(
            &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &FixtureStore::default(), None, Some(&Ok(incomplete.clone())),
        ).unwrap();
        assert_eq!(incomplete_payload["displays"][0]["arcSync"]["rangeBounds"],
            json!({"minHz": 48.0, "maxHz": 180.0}));
        incomplete.truncated = true;
        let truncated_payload = read_payload_with_color(
            &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &FixtureStore::default(), None, Some(&Ok(incomplete)),
        ).unwrap();
        assert_eq!(truncated_payload["displays"][0]["arcSync"]["rangeBounds"],
            json!({"minHz": 48.0, "maxHz": 180.0}));
    }

    #[test]
    fn arc_sync_range_bounds_are_admitted_when_the_edid_name_has_no_windows_row() {
        let mut fixture = two_monitor_fixture();
        // The real B580: IGCL's EDID name ("MSI G27C4 E3") is not a label
        // Windows reports for the output, so the mode-list join selects
        // nothing. The driver's own window must still reach the renderer, and
        // the current range stays the driver's actual one.
        fixture.arc_sync_monitor.insert(0, arc_sync_monitor(true, 48.0, 180.0));
        fixture.arc_sync_profile.insert(0, arc_sync_profile(1, 90.0, 180.0, true));
        let mode = |rate: u32| WindowsDisplayMode {
            width: 1920, height: 1080, refresh_rate: rate,
            bits_per_pixel: 32, display_flags: 0, orientation: 0,
        };
        let windows = Ok(super::super::windows_display_modes::WindowsDisplayModeSnapshot {
            outputs: vec![super::super::windows_display_modes::WindowsDisplayOutput {
                device_name: "\\\\.\\DISPLAY1".into(),
                display_name: "Intel(R) Arc(TM) B580 Graphics".into(),
                device_id: "PCI\\VEN_8086&DEV_E20B".into(),
                monitors: vec![super::super::windows_display_modes::WindowsDisplayMonitor {
                    device_name: "MONITOR1".into(),
                    device_string: "Generic PnP Monitor".into(),
                    state_flags: 0,
                    device_id: "MONITOR\\MSI3C4\\{4d36e96e-e325-11ce-bfc1-08002be10318}\\0004".into(),
                }],
                current_mode: mode(180),
                modes: [48_u32, 60, 100, 144, 165, 180].into_iter().map(mode).collect(),
                display_identity: "MONITOR-REAL".into(),
            }],
            complete: true,
            truncated: false,
        });
        let payload = read_payload_with_color(
            &mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
            &FixtureStore::default(), None, Some(&windows),
        ).unwrap();
        let dp = &payload["displays"][0];
        assert_eq!(dp["arcSync"]["rangeBounds"], json!({"minHz": 48.0, "maxHz": 180.0}));
        assert_eq!(dp["arcSync"]["writable"], json!(true));
        assert_eq!(dp["arcSync"]["currentRange"], json!({"minHz": 90.0, "maxHz": 180.0}));
        assert_eq!(dp["vrrCurrentRange"]["value"], json!("90 Hz - 180 Hz"));
        assert_eq!(dp["vrrMaximumRange"]["value"], json!("48 Hz - 180 Hz"));
    }

    #[test]
    fn refresh_range_format_keeps_the_float_value_electron_would_stringify() {
        assert_eq!(js_number_string(59.94_f32), "59.939998626708984");
        assert_eq!(refresh_range(59.94_f32, 180.0), "59.939998626708984 Hz - 180 Hz");
        assert_eq!(js_number_string(f32::INFINITY), "Infinity");
        assert_eq!(js_number_string(f32::NEG_INFINITY), "-Infinity");
        assert_eq!(js_number_string(f32::NAN), "NaN");
        assert_eq!(js_number_string(-0.0), "0");
    }

    #[test]
    fn failed_properties_hide_the_output_and_keep_the_surface() {
        let mut fixture = two_monitor_fixture();
        fixture.properties.remove(&1);
        let payload = read_fixture(&mut fixture);
        let displays = payload["displays"].as_array().unwrap();
        assert_eq!(displays.len(), 1, "an output without properties is never active");
        assert_eq!(displays[0]["id"], json!(0));
        assert_eq!(payload["deviceKey"], json!(DEVICE_KEY));
        assert_eq!(payload["adapterName"], json!("Intel Arc B580"));
    }

    #[test]
    fn unsupported_settings_control_degrades_only_quantization() {
        let mut fixture = two_monitor_fixture();
        fixture.settings.clear();
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["quantizationRange"], Value::Null);
        assert_eq!(dp["supportedOptions"]["quantizationRanges"], json!([]));
        // Everything the properties/EDID read owns is untouched.
        assert_eq!(dp["identityVerified"], json!(true));
        assert_eq!(dp["resolution"], json!({"width": 2560, "height": 1440}));
        assert_eq!(dp["hdcpSupport"]["value"], json!(true));
    }

    #[test]
    fn controllable_bit_is_required_for_the_quantization_option_list() {
        let mut fixture = two_monitor_fixture();
        // A recognized current value without the Controllable bit must not
        // advertise the option list (Electron's UI-hint contract).
        fixture.settings.get_mut(&0).unwrap().ControllableFlags = 0;
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["quantizationRange"], json!("full"));
        assert_eq!(dp["supportedOptions"]["quantizationRanges"], json!([]));
        // An unknown driver value maps to null, never a raw enum number.
        fixture.settings.get_mut(&0).unwrap().ControllableFlags = DISPLAY_SETTING_QUANTIZATION_RANGE;
        fixture.settings.get_mut(&0).unwrap().QuantizationRange = 9;
        let payload = read_fixture(&mut fixture);
        assert_eq!(payload["displays"][0]["quantizationRange"], Value::Null);
    }

    #[test]
    fn empty_topology_is_successful_but_unavailable_enumeration_is_an_error() {
        // A successful zero-output topology is distinct from a missing or
        // failed native surface so the guarded service can fail closed with a
        // useful runtime error instead of treating both as an empty display.
        let mut fixture = Fixture::default();
        assert_eq!(
            read_fixture(&mut fixture),
            json!({"deviceKey": DEVICE_KEY, "adapterName": "Intel Arc B580", "displays": []}),
        );
        fixture.global_vrr_error = Some("scope-selection write required".into());
        assert_eq!(
            read_payload(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
                &FixtureStore::default()).unwrap(),
            json!({"deviceKey": DEVICE_KEY, "adapterName": "Intel Arc B580", "displays": []}),
            "empty output lists do not need a global-VRR read",
        );

        fixture.global_vrr_error = None;
        fixture.output_error = Some("display enumeration failed".into());
        assert_eq!(
            read_payload(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"), Some(DEVICE_KEY),
                &FixtureStore::default()).unwrap_err(),
            "display enumeration failed",
        );
    }

    #[test]
    fn global_vrr_mode_and_options_are_adapter_wide_and_read_only() {
        let mut fixture = two_monitor_fixture();
        fixture.global_vrr = Some(GlobalVrrSurface {
            value: Some("fullscreen-windowed"), supported: true, controllable: true,
            reason: None, options: GLOBAL_VRR_MODES.iter().map(|(_, mode)| *mode).collect(),
        });
        let payload = read_fixture(&mut fixture);
        for output in payload["displays"].as_array().unwrap() {
            assert_eq!(output["globalVrrMode"], json!({
                "value": "fullscreen-windowed", "supported": true, "controllable": true,
                "reason": Value::Null, "source": "igcl-global-vrr",
            }));
            assert_eq!(output["supportedOptions"]["globalVrrModes"],
                json!(["fullscreen", "fullscreen-windowed", "disabled"]));
        }
    }

    #[test]
    fn global_vrr_readback_refusal_keeps_advertised_options_but_not_a_value() {
        let mut fixture = two_monitor_fixture();
        fixture.global_vrr = Some(GlobalVrrSurface::readback_failed(
            vec!["fullscreen", "disabled"], "IGCL refused the read"));
        let payload = read_fixture(&mut fixture);
        let mode = &payload["displays"][0]["globalVrrMode"];
        assert_eq!(mode["value"], Value::Null);
        assert_eq!(mode["supported"], true);
        assert_eq!(mode["controllable"], false);
        assert_eq!(mode["reason"], "IGCL refused the read");
        assert_eq!(payload["displays"][0]["supportedOptions"]["globalVrrModes"],
            json!(["fullscreen", "disabled"]));
    }

    #[test]
    fn global_vrr_scope_selection_case_marks_the_whole_native_read_unavailable() {
        let mut fixture = two_monitor_fixture();
        fixture.global_vrr_error = Some(
            GLOBAL_VRR_SCOPE_SELECTION_ERROR.to_owned());
        let error = read_payload(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &FixtureStore::default()).unwrap_err();
        assert!(error.contains("scope-selection write"));
    }

    #[test]
    fn single_active_output_without_identity_namespace_still_reads() {
        let mut fixture = two_monitor_fixture();
        // No stable adapter key: the encoder/EDID suffix cannot be formed, so
        // the display is unverified but its driver fields still decode.
        let payload = read_payload(&mut fixture, None, None, None, &FixtureStore::default()).unwrap();
        assert_eq!(payload["deviceKey"], Value::Null);
        assert_eq!(payload["adapterName"], Value::Null);
        let dp = &payload["displays"][0];
        assert_eq!(dp["displayKey"], Value::Null);
        assert_eq!(dp["identityVerified"], json!(false));
        assert_eq!(dp["name"], json!("MSI G27C4 E3"));
        assert_eq!(dp["connection"], json!("DisplayPort"));
    }

    #[test]
    fn malformed_edid_keeps_the_fingerprint_and_drops_the_name() {
        let mut fixture = two_monitor_fixture();
        let block = edid(None);
        fixture.edid.insert(0, block.clone());
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["name"], Value::Null);
        assert_eq!(dp["identityVerified"], json!(true));
        assert_eq!(
            dp["displayKey"],
            json!(format!("{DEVICE_KEY}|display|{}|edid|{}",
                encoder(0x41).iter().map(|b| format!("{b:02x}")).collect::<String>(),
                edid_fingerprint(&block).unwrap())),
        );
        // A truncated block has no fingerprint either: identity stays encoder-only.
        fixture.edid.insert(0, block[..64].to_vec());
        let payload = read_fixture(&mut fixture);
        assert_eq!(
            payload["displays"][0]["displayKey"],
            json!(format!("{DEVICE_KEY}|display|{}",
                encoder(0x41).iter().map(|b| format!("{b:02x}")).collect::<String>())),
        );
        // No EDID at all leaves the label null without failing the read.
        fixture.edid.remove(&0);
        let payload = read_fixture(&mut fixture);
        assert_eq!(payload["displays"][0]["name"], Value::Null);
        assert_eq!(payload["displays"][0]["resolution"], json!({"width": 2560, "height": 1440}));
    }

    #[test]
    fn implausible_timing_leaves_resolution_and_refresh_null() {
        let mut fixture = two_monitor_fixture();
        let properties = fixture.properties.get_mut(&0).unwrap();
        properties.Display_Timing_Info = zeroed_properties().Display_Timing_Info;
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["resolution"], Value::Null);
        assert_eq!(dp["refreshRate"], Value::Null);
        assert_eq!(dp["flags"]["active"], json!(true));

        // Each bound is enforced: a zero pixel clock alone is implausible.
        let mut zero_clock = timing(2560, 1440, 144.0);
        zero_clock.PixelClock = 0;
        assert!(!plausible_timing(&zero_clock));
        assert!(plausible_timing(&timing(2560, 1440, 144.0)));
        assert!(!plausible_timing(&timing(2560, 1440, 1.0)));
        assert!(!plausible_timing(&timing(2560, 1440, 2000.0)));
        assert!(!plausible_timing(&timing(320, 1440, 60.0)));
        assert!(!plausible_timing(&timing(2560, 200, 60.0)));
    }

    #[test]
    fn monitor_name_and_fingerprint_match_the_oracle_parsers() {
        assert_eq!(monitor_name(&edid(Some("MSI G27C4 E3"))).as_deref(), Some("MSI G27C4 E3"));
        // Trailing spaces/tabs are stripped, non-printable bytes filtered.
        let mut block = edid(Some("LG TV"));
        let offset = 0x36;
        block[offset + 10] = 0x0a;
        block[offset + 11] = b' ';
        block[offset + 12] = b'\t';
        assert_eq!(monitor_name(&block).as_deref(), Some("LG TV"));
        // A descriptor that only contains padding is not a name.
        let blank = edid(Some(""));
        assert_eq!(monitor_name(&blank), None);
        assert_eq!(monitor_name(&edid(None)), None);
        assert_eq!(monitor_name(&edid(Some("MSI"))[..64]), None);

        // FNV-1a 32-bit, offset basis 2166136261 / prime 16777619.        assert_eq!(edid_fingerprint(&edid(None)).unwrap().len(), 8);
        assert_eq!(edid_fingerprint(&[0_u8; 127]), None);
        let mut block = vec![0_u8; 128];
        block[..3].copy_from_slice(&[1, 2, 3]);
        let mut expected: u32 = 2_166_136_261;
        for byte in &block { expected = (expected ^ u32::from(*byte)).wrapping_mul(16_777_619); }
        assert_eq!(edid_fingerprint(&block).unwrap(), format!("{expected:08x}"));
    }

    #[test]
    fn edid_selection_prefers_a_named_block_then_the_first_payload() {
        let bare = edid(None);
        let named = edid(Some("MSI G27C4 E3"));
        // The EDID block wins when it carries the name.
        assert_eq!(select_edid(&[named.clone(), bare.clone()]), Some(named.clone()));
        // A nameless EDID block is superseded by a named panel descriptor.
        assert_eq!(select_edid(&[bare.clone(), named.clone()]), Some(named.clone()));
        // With no name anywhere the first payload still feeds the fingerprint.
        assert_eq!(select_edid(&[bare.clone()]), Some(bare.clone()));
        assert_eq!(select_edid(&[bare.clone(), edid(None)]), Some(bare));
        assert_eq!(select_edid(&[]), None);
    }

    // -- Round 2: colour path / scaling ------------------------------------

    fn wire_entry(model: i32, depth: u32) -> super::super::igcl_raw::ctl_wire_format_t {
        let mut entry: super::super::igcl_raw::ctl_wire_format_t = unsafe { std::mem::zeroed() };
        entry.Size = std::mem::size_of::<super::super::igcl_raw::ctl_wire_format_t>() as u32;
        entry.ColorModel = model;
        entry.ColorDepth = depth;
        entry
    }

    fn wire_config(
        supported: [(i32, u32); 4],
        current: (i32, u32),
    ) -> ctl_get_set_wire_format_config_t {
        let mut config: ctl_get_set_wire_format_config_t = unsafe { std::mem::zeroed() };
        config.Size = std::mem::size_of::<ctl_get_set_wire_format_config_t>() as u32;
        config.Operation = 0;
        for (index, (model, depth)) in supported.into_iter().enumerate() {
            config.SupportedWireFormat[index] = wire_entry(model, depth);
        }
        config.WireFormat = wire_entry(current.0, current.1);
        config
    }

    fn scaling_settings(
        enable: u8,
        scaling_type: u32,
        preferred: u32,
        custom: (u32, u32),
        hardware: u8,
    ) -> ctl_scaling_settings_t {
        let mut settings: ctl_scaling_settings_t = unsafe { std::mem::zeroed() };
        settings.Size = std::mem::size_of::<ctl_scaling_settings_t>() as u32;
        settings.Enable = enable;
        settings.ScalingType = scaling_type;
        settings.PreferredScalingType = preferred;
        settings.CustomScalingX = custom.0;
        settings.CustomScalingY = custom.1;
        settings.HardwareModeSet = hardware;
        settings
    }

    fn scaling_surface(version: u8, settings: ctl_scaling_settings_t) -> ScalingSurface {
        ScalingSurface { caps: Some(0b00110), current: Some(ScalingRead { version, settings }) }
    }

    fn retro_settings(enable: u8, retro_type: u32) -> ctl_retro_scaling_settings_t {
        let mut settings: ctl_retro_scaling_settings_t = unsafe { std::mem::zeroed() };
        settings.Size = std::mem::size_of::<ctl_retro_scaling_settings_t>() as u32;
        settings.Get = 1;
        settings.Enable = enable;
        settings.RetroScalingType = retro_type;
        settings
    }

    fn arc_sync_monitor(supported: bool, min_refresh: f32, max_refresh: f32) -> ctl_intel_arc_sync_monitor_params_t {
        let mut value = unsafe { std::mem::zeroed::<ctl_intel_arc_sync_monitor_params_t>() };
        value.IsIntelArcSyncSupported = u8::from(supported);
        value.MinimumRefreshRateInHz = min_refresh;
        value.MaximumRefreshRateInHz = max_refresh;
        value
    }

    fn arc_sync_profile(profile: i32, min_refresh: f32, max_refresh: f32, controllable: bool) -> ArcSyncProfileRead {
        let mut settings = unsafe { std::mem::zeroed::<ctl_intel_arc_sync_profile_params_t>() };
        settings.IntelArcSyncProfile = profile;
        settings.MinRefreshRateInHz = min_refresh;
        settings.MaxRefreshRateInHz = max_refresh;
        ArcSyncProfileRead { settings, controllable }
    }

    /// The active DP output with every round-2 control populated: RGB/6-8-10-12
    /// wire slots whose current value is YCbCr422/10, a pixel-transform read
    /// that says the desktop is really RGB/8, v1 scaling at identity with a
    /// centred preferred type, and both retro-scaling methods.
    fn colour_fixture() -> Fixture {
        let mut fixture = two_monitor_fixture();
        fixture.wire_format.insert(0,
            wire_config([(0, 0b0011), (2, 0b0110), (0, 0), (3, 0b1000)], (2, 0b0100)));
        fixture.pixel.insert(0, PixelTransformation { output_model: 0, output_bits_per_color: 8 });
        fixture.scaling.insert(0,
            scaling_surface(1, scaling_settings(1, 1, 2, (100, 80), 0)));
        fixture.retro_caps.insert(0, 0b11);
        fixture.retro.insert(0, retro_settings(1, 2));
        fixture
    }

    /// The fixture's canonical display identity. The scaling store is keyed by
    /// the namespaced display key, not the bare device key.
    fn fixture_display_key() -> String {
        let payload = read_payload(&mut two_monitor_fixture(), Some(DEVICE_KEY),
            Some("Intel Arc B580"), Some(DEVICE_KEY), &FixtureStore::default()).unwrap();
        payload["displays"][0]["displayKey"].as_str().unwrap().to_owned()
    }

    #[test]
    fn colour_path_decodes_wire_format_pixel_transform_scaling_and_retro() {
        let mut fixture = colour_fixture();
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];

        // Wire format: canonical, de-duplicated, falsy models dropped.
        assert_eq!(dp["supportedOptions"]["wireFormats"], json!(["RGB", "YCbCr422", "YCbCr444"]));
        assert_eq!(dp["supportedOptions"]["bpcDepths"], json!([6, 8, 10, 12]));
        // The pixel transform wins over the wire slot's YCbCr422/10.
        assert_eq!(dp["colorFormat"], json!("RGB"));
        assert_eq!(dp["colorDepth"], json!(8));

        assert_eq!(dp["supportedOptions"]["scalingModes"], json!(["centered", "stretched"]));
        assert_eq!(dp["scalingMode"], json!("identity"));
        assert_eq!(dp["preferredScalingMode"], json!("centered"));
        assert_eq!(dp["scalingDetails"], json!({
            "customX": 100, "customY": 80, "hardwareModeSet": false,
            "preferredScalingType": "centered",
        }));
        // No saved Arc Power selection: the driver's identity/centred pair is
        // presented as the IGS-preferred GPU scaling.
        assert_eq!(dp["scalingPreference"], json!("gpu-scaling"));
        assert_eq!(dp["scalingPreferenceSource"], json!("igcl-preferred"));
        assert_eq!(dp["customScalingPreference"], Value::Null);

        assert_eq!(dp["supportedOptions"]["scalingMethods"], json!(["integer", "nearest-neighbour"]));
        assert_eq!(dp["scalingMethod"], json!({
            "value": {"enabled": true, "method": "nearest-neighbour"},
            "supported": true, "controllable": true, "reason": Value::Null, "source": "igcl",
        }));
    }

    #[test]
    fn a_matching_saved_selection_reports_display_scaling_and_the_custom_pair() {
        let mut fixture = colour_fixture();
        let store = FixtureStore {
            state: Some(ScalingSelection {
                identity_scaling: true, native_preferred_scaling_type: Some(2),
                custom_x: Some(90), custom_y: Some(70),
            }),
            ..FixtureStore::default()
        };
        let payload = read_payload(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &store).unwrap();
        let dp = &payload["displays"][0];
        assert_eq!(dp["scalingPreference"], json!("display-scaling"));
        assert_eq!(dp["scalingPreferenceSource"], json!("arc-selection"));
        assert_eq!(dp["customScalingPreference"], json!({"x": 90, "y": 70}));
        // A version-0 driver has no persisted preferred type, so the record
        // must match null instead of the struct's 0.
        fixture.scaling.insert(0, scaling_surface(0, scaling_settings(1, 1, 8, (100, 80), 0)));
        let store = FixtureStore {
            state: Some(ScalingSelection {
                identity_scaling: true, native_preferred_scaling_type: None,
                custom_x: None, custom_y: None,
            }),
            ..FixtureStore::default()
        };
        let payload = read_payload(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &store).unwrap();
        let dp = &payload["displays"][0];
        assert_eq!(dp["preferredScalingMode"], Value::Null);
        assert_eq!(dp["scalingDetails"]["preferredScalingType"], Value::Null);
        assert_eq!(dp["scalingPreference"], json!("display-scaling"));
        assert_eq!(dp["scalingPreferenceSource"], json!("arc-selection"));
    }

    #[test]
    fn an_identity_selection_override_is_staged_without_a_store_write() {
        let mut fixture = colour_fixture();
        let expected = ScalingSelection {
            identity_scaling: true, native_preferred_scaling_type: Some(8),
            custom_x: Some(90), custom_y: Some(70),
        };
        let store = FixtureStore {
            // Same identity selection, but recorded against a different
            // preferred type: the driver has moved on.
            state: Some(expected),
            ..FixtureStore::default()
        };
        let staged = read_payload_staged(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &store).unwrap();
        let payload = &staged.payload;
        let dp = &payload["displays"][0];
        assert_eq!(dp["customScalingPreference"], json!({"x": 90, "y": 70}));
        // No display-scaling claim, so the GPU-scaling fallback applies.
        assert_eq!(dp["scalingPreference"], json!("gpu-scaling"));
        assert_eq!(dp["scalingPreferenceSource"], json!("igcl-preferred"));
        assert_eq!(staged.scaling_invalidations, vec![ScalingInvalidation {
            display_key: fixture_display_key(),
            expected,
            observed_enable: 1,
            observed_scaling_type: 1,
            observed_preferred_type: Some(2),
        }]);

        // A saved identity selection that is already false needs no intent.
        let store = FixtureStore {
            state: Some(ScalingSelection { identity_scaling: false, ..Default::default() }),
            ..FixtureStore::default()
        };
        let staged = read_payload_staged(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &store).unwrap();
        assert!(staged.scaling_invalidations.is_empty());
        // An unreadable store keeps the driver verdict and creates no intent.
        let store = FixtureStore { unreadable: true, ..FixtureStore::default() };
        let staged = read_payload_staged(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &store).unwrap();
        assert_eq!(staged.payload["displays"][0]["scalingPreference"], json!("gpu-scaling"));
        assert!(staged.scaling_invalidations.is_empty());
    }

    #[test]
    fn custom_scaling_always_reports_display_scaling_with_a_null_source() {
        let mut fixture = two_monitor_fixture();
        fixture.scaling.insert(0, ScalingSurface {
            caps: Some(0b10000),
            current: Some(ScalingRead { version: 1, settings: scaling_settings(1, 16, 2, (70, 60), 1) }),
        });
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["supportedOptions"]["scalingModes"], json!(["custom"]));
        assert_eq!(dp["scalingMode"], json!("custom"));
        assert_eq!(dp["scalingDetails"]["hardwareModeSet"], json!(true));
        assert_eq!(dp["scalingPreference"], json!("display-scaling"));
        assert_eq!(dp["scalingPreferenceSource"], Value::Null);
    }

    #[test]
    fn wire_format_current_unavailable_keeps_the_model_and_nulls_the_depth() {
        let mut fixture = two_monitor_fixture();
        // Combined depth flags: no exact CTL_DISPLAY_BPC_FROM_FLAG key.
        fixture.wire_format.insert(0, wire_config([(0, 0b0011), (0, 0), (0, 0), (0, 0)], (2, 0b0011)));
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["colorFormat"], json!("YCbCr422"));
        assert_eq!(dp["colorDepth"], Value::Null);
        assert_eq!(dp["supportedOptions"]["wireFormats"], json!(["RGB"]));
        assert_eq!(dp["supportedOptions"]["bpcDepths"], json!([6, 8]));

        // A zero current depth is the same model-only shape.
        fixture.wire_format.insert(0, wire_config([(0, 0), (0, 0), (0, 0), (0, 0)], (1, 0)));
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["colorFormat"], json!("YCbCr420"));
        assert_eq!(dp["colorDepth"], Value::Null);
        assert_eq!(dp["supportedOptions"]["wireFormats"], json!([]));
        assert_eq!(dp["supportedOptions"]["bpcDepths"], json!([]));

        // An unknown model is never presented as a canonical format.
        fixture.wire_format.insert(0, wire_config([(0, 0), (0, 0), (0, 0), (0, 0)], (9, 0)));
        let payload = read_fixture(&mut fixture);
        assert_eq!(payload["displays"][0]["colorFormat"], Value::Null);
        assert_eq!(payload["displays"][0]["colorDepth"], Value::Null);
    }

    #[test]
    fn pixel_transform_only_overrides_the_fields_it_can_prove() {
        let mut fixture = colour_fixture();
        // Zero bits-per-colour keeps the wire depth; the model still wins.
        fixture.pixel.insert(0, PixelTransformation { output_model: 4, output_bits_per_color: 0 });
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["colorFormat"], json!("YCbCr420"));
        assert_eq!(dp["colorDepth"], json!(10), "the wire-format depth is retained");

        // An unknown pixel model keeps the wire format entirely.
        fixture.pixel.insert(0, PixelTransformation { output_model: 8, output_bits_per_color: 0 });
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        assert_eq!(dp["colorFormat"], json!("YCbCr422"));
        assert_eq!(dp["colorDepth"], json!(10));
    }

    #[test]
    fn retro_scaling_uses_the_oracle_capability_and_reason_strings() {
        // Enabled with an unknown method: not controllable, explicit reason.
        let mut fixture = colour_fixture();
        fixture.retro.insert(0, retro_settings(1, 3));
        let payload = read_fixture(&mut fixture);
        assert_eq!(payload["displays"][0]["scalingMethod"], json!({
            "value": {"enabled": true, "method": Value::Null},
            "supported": true, "controllable": false,
            "reason": "The driver returned an unknown enabled retro-scaling method.", "source": "igcl",
        }));

        // Disabled: the unknown type is opaque, so the control stays available.
        fixture.retro.insert(0, retro_settings(0, 0));
        let payload = read_fixture(&mut fixture);
        assert_eq!(payload["displays"][0]["scalingMethod"], json!({
            "value": {"enabled": false, "method": Value::Null},
            "supported": true, "controllable": true,
            "reason": "Retro Scaling is off. Choose a supported method to enable it.", "source": "igcl",
        }));

        // Capability read succeeded, current read failed.
        fixture.retro.remove(&0);
        let payload = read_fixture(&mut fixture);
        assert_eq!(payload["displays"][0]["scalingMethod"], json!({
            "value": Value::Null, "supported": true, "controllable": false,
            "reason": "Retro scaling read-back failed.", "source": "igcl",
        }));

        // Capability bitmask advertises nothing.
        fixture.retro.insert(0, retro_settings(1, 1));
        fixture.retro_caps.insert(0, 0);
        let payload = read_fixture(&mut fixture);
        assert_eq!(payload["displays"][0]["supportedOptions"]["scalingMethods"], json!([]));
        assert_eq!(payload["displays"][0]["scalingMethod"]["supported"], json!(false));
        assert_eq!(payload["displays"][0]["scalingMethod"]["controllable"], json!(false));
    }

    #[test]
    fn unsupported_colour_exports_keep_the_oracle_defaults() {
        let mut fixture = two_monitor_fixture();
        let payload = read_fixture(&mut fixture);
        let dp = &payload["displays"][0];
        // Wire format + pixel transform.
        assert_eq!(dp["colorFormat"], Value::Null);
        assert_eq!(dp["colorDepth"], Value::Null);
        assert_eq!(dp["supportedOptions"]["wireFormats"], json!([]));
        assert_eq!(dp["supportedOptions"]["bpcDepths"], json!([]));
        // Scaling.
        assert_eq!(dp["supportedOptions"]["scalingModes"], json!([]));
        assert_eq!(dp["scalingMode"], Value::Null);
        assert_eq!(dp["preferredScalingMode"], Value::Null);
        assert_eq!(dp["scalingDetails"], Value::Null);
        assert_eq!(dp["scalingPreference"], Value::Null);
        assert_eq!(dp["scalingPreferenceSource"], Value::Null);
        assert_eq!(dp["customScalingPreference"], Value::Null);
        // Retro scaling keeps the literal default capability, reason included.
        assert_eq!(dp["supportedOptions"]["scalingMethods"], json!([]));
        assert_eq!(dp["scalingMethod"], json!({
            "value": Value::Null, "supported": false, "controllable": false,
            "reason": "Retro scaling is not exposed by the driver interface.", "source": "igcl",
        }));
    }

    #[test]
    fn staged_display_read_defers_reconciliation_until_native_ownership_is_accepted() {
        let root = std::env::temp_dir().join(format!("arc-display-read-test-{:032x}", rand::random::<u128>()));
        let dir = root.join("DisplayScalingSettings");
        std::fs::create_dir_all(&root).unwrap();
        let store = DisplayScalingStore::at(dir.clone()).unwrap();
        let key = fixture_display_key();
        store.save_selection(&key, &SelectionUpdate {
            identity_scaling: true, native_preferred_scaling_type: Some(8),
            custom: Some((90, 70)),
        }).unwrap();
        let expected = store.read(&key).unwrap().unwrap();
        let record_path = dir.join(format!("{}.json", {
            use sha2::{Digest, Sha256};
            Sha256::digest(key.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect::<String>()
        }));
        let original = std::fs::read(&record_path).unwrap();

        let mut fixture = colour_fixture();
        let staged = read_payload_staged(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &store).unwrap();
        assert_eq!(staged.scaling_invalidations, vec![ScalingInvalidation {
            display_key: key.clone(), expected, observed_enable: 1, observed_scaling_type: 1,
            observed_preferred_type: Some(2),
        }]);
        assert_eq!(store.read(&key).unwrap(), Some(expected));
        assert_eq!(std::fs::read(&record_path).unwrap(), original,
            "a staged read cannot mutate shared state before ownership is accepted");

        // Repeated stale reads keep returning the same compare-before-write
        // intent; neither the file nor its custom coordinates are changed.
        let repeated = read_payload_staged(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &store).unwrap();
        assert_eq!(repeated.scaling_invalidations, staged.scaling_invalidations);
        assert_eq!(std::fs::read(&record_path).unwrap(), original);

        // If the driver later returns to the saved fingerprint, the staged
        // reader still sees the old Arc selection. This is why the service
        // must keep delegating until it can commit the intent safely.
        fixture.scaling.insert(0, scaling_surface(1, scaling_settings(1, 1, 8, (100, 80), 0)));
        let returned = read_payload_staged(&mut fixture, Some(DEVICE_KEY), Some("Intel Arc B580"),
            Some(DEVICE_KEY), &store).unwrap();
        assert_eq!(returned.payload["displays"][0]["scalingPreference"], json!("display-scaling"));
        assert!(returned.scaling_invalidations.is_empty());
        assert_eq!(std::fs::read(&record_path).unwrap(), original);
        // The store lives under the temp root, never %APPDATA%.
        assert!(record_path.is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn display_keys_are_renamespaced_only_when_canonical_and_named() {
        let canonical = format!("{DEVICE_KEY}|display|4100|edid|0f0e0d0c");
        // The adapter alias is rewritten; the output suffix is preserved.
        assert_eq!(
            display_key_in_namespace(&canonical, Some("pci:0x00008086:0x0000e20b@4:0.0")).as_deref(),
            Some("pci:0x00008086:0x0000e20b@4:0.0|display|4100|edid|0f0e0d0c"),
        );
        // Malformed, suffix-less and empty keys are preserved verbatim.
        assert_eq!(display_key_in_namespace("tray-monitor", Some(DEVICE_KEY)).as_deref(), Some("tray-monitor"));
        assert_eq!(display_key_in_namespace("a|display|", Some(DEVICE_KEY)).as_deref(), Some("a|display|"));
        // An absent or empty namespace preserves the caller's key.
        assert_eq!(display_key_in_namespace(&canonical, None).as_deref(), Some(canonical.as_str()));
        assert_eq!(display_key_in_namespace(&canonical, Some("")).as_deref(), Some(canonical.as_str()));
        // Only the first marker separates the namespace from the suffix.
        assert_eq!(
            display_key_in_namespace("old|display|out|display|tail", Some("new")).as_deref(),
            Some("new|display|out|display|tail"),
        );
        assert_eq!(display_key_suffix("old|display|out|display|tail"), Some("out|display|tail"));
        assert_eq!(display_key_suffix(&canonical), Some("4100|edid|0f0e0d0c"));
        assert_eq!(display_key_suffix("no-marker"), None);
    }

    #[test]
    fn colour_namespace_prefers_the_pci_identity_and_falls_back_to_the_adapter_key() {
        let hardware = json!({
            "deviceKey": "public-alias", "pciVendorId": "0x00008086", "pciDeviceId": "0x0000e20b",
            "bdf": {"bus": 3, "device": 0, "function": 0},
        });
        assert_eq!(color_namespace(&hardware), DEVICE_KEY);
        // A zeroed BDF is the binding's "not supplied" shape: keep the alias.
        let zero_bdf = json!({
            "deviceKey": "public-alias", "pciVendorId": "0x00008086", "pciDeviceId": "0x0000e20b",
            "bdf": {"bus": 0, "device": 0, "function": 0},
        });
        assert_eq!(color_namespace(&zero_bdf), "public-alias");
        // A missing PCI id also keeps the alias.
        let no_device_id = json!({
            "deviceKey": "public-alias", "pciVendorId": "0x00008086",
            "bdf": {"bus": 3, "device": 0, "function": 0},
        });
        assert_eq!(color_namespace(&no_device_id), "public-alias");
        // With neither, the hardware key is still the last resort.
        let bare = json!({"bdf": {"bus": 3, "device": 0, "function": 0}});
        assert_eq!(color_namespace(&bare), super::super::gpu_devices::device_key(&bare));
    }
}
