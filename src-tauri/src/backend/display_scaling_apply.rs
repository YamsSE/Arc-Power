//! Private fake-tested transaction for the Display scaling selector.
//!
//! The private native adapter keeps output identity, driver read-back and the
//! durable selector update in one Display transaction. `display:apply` routes
//! the renderer's verified Scaling Mode shapes here (the raw flag, the GPU
//! method alias, the Custom pair and the coupled Retro-disable companion), so
//! this writer no longer waits on the service route. First-time Custom entry
//! runs Electron's two-step neutral 100x100 initialization inside the same
//! transaction and lock. The UI's Retro-entry pair is handled by the separate
//! guarded adapter-level Retro transaction, which mirrors the raw identity
//! selector without issuing a raw scaling setter, matching Electron.
//!
//! Ownership model for compensation: this transaction attributes a driver tuple
//! to itself only when (a) a read-back witness is present, (b) that witness
//! equals the tuple this transaction wrote, and (c) a fresh GET still matches
//! it. No rollback write is issued otherwise, so an absent or foreign read-back
//! reports the failure instead of overwriting whatever the driver holds.
//!
//! That is a DELIBERATE DIVERGENCE from Electron, which rolls the prior tuple
//! back whenever its SET was accepted even if the read-back reported a
//! different tuple (`igcl-display-scaling.js:147-153`); a read-back value is not
//! proof that we produced it, so this writer declines to write over a state it
//! did not set.
//!
//! The residual this cannot close is narrowly the ABA case: external writers
//! (IGS, Windows display settings, driver utilities) do not honour the Arc
//! Power Display mutex, so one that coincidentally lands on the EXACT neutral
//! tuple between our SET and our GET is indistinguishable from our own write.
//! Closing that would need an exclusion or generation mechanism those writers
//! respect; it is an accepted residual under the shared-mutex model (the D-1
//! bounded-external-writer window), not a property this transaction proves.

use super::{
    display_retro_scaling_apply::{
        RetroScalingMethod, RetroScalingObservation, RetroScalingWrite,
    },
    display_scaling_state::{DisplayScalingStore, ScalingSelection, SelectionUpdate},
    gpu_apply_identity::{self, ApplyIdentity},
    gpu_capabilities,
    igcl_read_only::ReadOnlyIgcl,
};
use serde_json::Value;
use std::{path::PathBuf, sync::{Mutex, OnceLock}, thread, time::Duration};

static DISPLAY_SCALING_APPLY_GATE: OnceLock<Mutex<()>> = OnceLock::new();

const SCALING_TYPES: [u32; 5] = [1, 2, 4, 8, 16];

/// Electron's refusal text when an active Retro scaler cannot be disabled by
/// the same request (`igcl-backend.js` applyDisplay), verbatim.
pub(crate) const RETRO_SCALING_ACTIVE_REFUSAL: &str =
    "Retro Scaling is active. Its known method must be disabled in the same request before ordinary scaling can change.";
/// Electron's coupled-exit failure text for the ordinary Scaling Mode entry.
pub(crate) const RETRO_SCALING_NOT_DISABLED_MESSAGE: &str =
    "raw scaling was not changed because Retro Scaling could not be disabled first";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayScalingOutputIdentity {
    pub(crate) device_key: String,
    pub(crate) display_key: String,
    pub(crate) active: bool,
    pub(crate) identity_verified: bool,
}

/// Driver GET projected onto the fields needed for guarded apply and restore.
/// Version zero has no preferred-scaling field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayScalingObservation {
    pub(crate) version: u8,
    pub(crate) enabled: bool,
    pub(crate) scaling_type: u32,
    pub(crate) custom_x: u32,
    pub(crate) custom_y: u32,
    pub(crate) preferred_scaling_type: Option<u32>,
}

/// One `ctlSetCurrentScaling` intent. Custom coordinates are present only for
/// type 16; the hardware-mode flag follows the Electron setter's default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayScalingWrite {
    pub(crate) enabled: bool,
    pub(crate) scaling_type: u32,
    pub(crate) custom: Option<(u32, u32)>,
    pub(crate) hardware_mode_set: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DisplayScalingWriteOutcome {
    /// Identity, capability or conditional pre-write checks declined before
    /// the first IGCL SET. The caller may safely delegate this candidate.
    NotAttempted(String),
    /// One or more version-compatible SET calls were attempted.
    Attempted {
        setter_succeeded: bool,
        result: Result<(), String>,
        error_code: Option<&'static str>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayScalingTarget {
    pub(crate) device_key: String,
    pub(crate) display_key: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayScalingApplyResult {
    pub(crate) ok: bool,
    pub(crate) error_code: Option<&'static str>,
    pub(crate) message: Option<String>,
    pub(crate) read_back: Option<DisplayScalingObservation>,
    /// True for either the requested active mode or a driver-deferred
    /// preferred GPU-scaling selection.
    pub(crate) read_back_equal: bool,
    pub(crate) active_read_back_equal: bool,
    pub(crate) preferred_read_back_equal: bool,
    pub(crate) readback_reported: bool,
    /// True when the driver accepted and verified the requested active or
    /// deferred mode. Selector persistence may still fail afterward.
    pub(crate) driver_apply_succeeded: bool,
    /// `None` means the transaction stopped before the first setter call.
    pub(crate) setter_succeeded: Option<bool>,
    /// The requested pair's own SET outcome. `None` means that SET never ran
    /// (a failed first-time Custom initialization stops before it), so the
    /// envelope must not claim the request was a silent no-op.
    pub(crate) requested_set: Option<bool>,
    pub(crate) deferred: bool,
    pub(crate) rollback_attempted: bool,
    pub(crate) rollback_verified: bool,
    pub(crate) state_may_have_changed: bool,
    pub(crate) selection_saved: bool,
    // Retained only so the private store coordinator can compensate a driver
    // apply when the durable selector commit did not happen.
    pub(crate) prior_state: Option<DisplayScalingObservation>,
}

/// The raw IGCL scaling flags this transaction owns. `custom` is the second
/// step of the two-step entry: its neutral 100x100 initialization runs inside
/// the same transaction, never as a separate request.
pub(crate) fn scaling_type_from_name(name: &str) -> Option<u32> {
    match name {
        "identity" => Some(1),
        "centered" => Some(2),
        "stretched" => Some(4),
        "aspect-ratio-centered-max" => Some(8),
        "custom" => Some(16),
        _ => None,
    }
}

pub(crate) fn scaling_name(scaling_type: u32) -> Option<&'static str> {
    match scaling_type {
        1 => Some("identity"),
        2 => Some("centered"),
        4 => Some("stretched"),
        8 => Some("aspect-ratio-centered-max"),
        16 => Some("custom"),
        _ => None,
    }
}

/// The renderer couples the raw flag to its user-facing IGS method alias. The
/// alias must describe the same selection; a contradictory pair is declined
/// whole so Electron never observes a partially applied coupling.
pub(crate) fn scaling_alias_matches(scaling_type: u32, alias: &str) -> bool {
    match scaling_type {
        1 => alias == "maintain-display-scaling",
        2 | 4 | 8 => scaling_type_from_name(alias) == Some(scaling_type),
        16 => alias == "custom",
        _ => false,
    }
}

/// One route-level Scaling Mode request. Only presence is retained for the
/// alias: the envelope mirrors the ordinary result, it never re-derives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DisplayScalingPatch {
    pub(crate) scaling_type: u32,
    /// The renderer's `{ x, y }` Custom pair. It is present only for
    /// `scalingMode: 'custom'` and never travels without that raw flag.
    pub(crate) custom: Option<(u32, u32)>,
    pub(crate) has_method_alias: bool,
    /// The renderer's `{ scalingMethod: { enabled: false, method } }` companion
    /// that must disable an active Retro scaler before ordinary scaling moves.
    pub(crate) retro_disable: Option<RetroScalingMethod>,
}

/// Outcome of one Scaling Mode transaction. `scaling` is the ordinary
/// output-handle result; the selector store coordinator runs inside it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayScalingModeApplyResult {
    pub(crate) scaling: DisplayScalingApplyResult,
    /// `Some` only when this transaction disabled an active Retro method and
    /// then had to put it back because the ordinary scaling write failed.
    pub(crate) retro_restore_ok: Option<bool>,
}

impl DisplayScalingModeApplyResult {
    pub(crate) fn failed(error_code: &'static str, message: impl Into<String>) -> Self {
        Self { scaling: failed(error_code, message), retro_restore_ok: None }
    }

    fn without_coupling(scaling: DisplayScalingApplyResult) -> Self {
        Self { scaling, retro_restore_ok: None }
    }
}

/// `Declined` means no SET was issued anywhere in the transaction, so the
/// caller may hand this candidate to the broker without double-writing.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DisplayScalingModeApplyOutcome {
    Declined,
    Applied(DisplayScalingModeApplyResult),
}

/// Durable identity-specific selector writer. The coordinator reads before
/// applying and reads again after save, so a save error after a durable commit
/// can be distinguished from a failure that left the old record intact.
pub(crate) trait DisplayScalingSelectionStore {
    fn read_selection(&mut self, display_key: &str) -> Result<Option<ScalingSelection>, String>;
    fn save_selection(&mut self, display_key: &str, update: &SelectionUpdate) -> Result<(), String>;
}

impl DisplayScalingSelectionStore for DisplayScalingStore {
    fn read_selection(&mut self, display_key: &str) -> Result<Option<ScalingSelection>, String> {
        self.read(display_key)
    }

    fn save_selection(&mut self, display_key: &str, update: &SelectionUpdate) -> Result<(), String> {
        DisplayScalingStore::save_selection(self, display_key, update).map(|_| ())
    }
}

/// Backend contract for fake-tested scaling transactions. Every method must
/// resolve the adapter and output from fresh topology; no output handle may be
/// retained across calls. `set_scaling_if_current` is a required conditional
/// write contract, not a proof that IGCL offers an atomic compare-and-set.
/// Win32/IGCL external writers do not honor the Arc Power Display mutex, so a
/// future native backend must fail closed if it cannot exclude that race and
/// verify the stable output identity immediately at the write boundary.
pub(crate) trait DisplayScalingApplyBackend {
    /// Enumerate current active-output identities for one adapter. Duplicate
    /// display keys must be retained so the transaction detects ambiguity.
    fn active_outputs(&mut self, device_key: &str) -> Result<Vec<DisplayScalingOutputIdentity>, String>;

    fn read_scaling(
        &mut self,
        device_key: &str,
        display_key: &str,
    ) -> Result<DisplayScalingObservation, String>;

    /// Implementations must re-resolve the output and compare its identity and
    /// complete observed scaling tuple with `expected_current` before writing.
    fn set_scaling_if_current(
        &mut self,
        device_key: &str,
        display_key: &str,
        expected_current: &DisplayScalingObservation,
        requested: &DisplayScalingWrite,
    ) -> DisplayScalingWriteOutcome;

    /// Current adapter-level Retro Scaling tuple. It is part of this backend
    /// only so the coupled Scaling Mode exit can order its writes like
    /// Electron; the standalone Retro control keeps its own transaction.
    /// `None` means the adapter exposes no Retro surface at all (Electron's
    /// read path gates the block on both exports), which is not "disabled".
    fn read_retro_scaling(
        &mut self,
        device_key: &str,
        display_key: &str,
    ) -> Result<Option<RetroScalingObservation>, String>;

    /// Conditional adapter-level Retro write. Implementations must compare the
    /// complete enabled/method tuple immediately before the SET.
    fn set_retro_scaling_if_current(
        &mut self,
        device_key: &str,
        display_key: &str,
        expected_current: RetroScalingObservation,
        requested: RetroScalingWrite,
    ) -> DisplayScalingWriteOutcome;
}

/// Reopen the selected adapter by captured PCI/BDF identity for each method
/// call. No IGCL output handle survives a GET or SET boundary.
struct NativeDisplayScalingBackend {
    dll_path: PathBuf,
    identity: ApplyIdentity,
    selected_device_key: String,
}

impl NativeDisplayScalingBackend {
    fn with_session<T>(
        &self,
        expected_device_key: &str,
        operation: impl FnOnce(&mut ReadOnlyIgcl, usize) -> Result<T, String>,
    ) -> Result<T, String> {
        if expected_device_key != self.selected_device_key {
            return Err("the selected graphics adapter identity changed".into());
        }
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
            (Ok(_), Err(close)) => Err(format!("IGCL session cleanup failed: {close}")),
            (Err(error), Err(close)) => Err(format!("{error}; IGCL session cleanup failed: {close}")),
        }
    }
}

impl DisplayScalingApplyBackend for NativeDisplayScalingBackend {
    fn active_outputs(&mut self, device_key: &str) -> Result<Vec<DisplayScalingOutputIdentity>, String> {
        self.with_session(device_key, |session, index| {
            super::display_apply::fresh_display_outputs(session, index, device_key)
                .map(|outputs| outputs.into_iter().map(|(_, identity)| DisplayScalingOutputIdentity {
                    device_key: device_key.to_owned(),
                    display_key: identity.display_key,
                    active: identity.active,
                    identity_verified: identity.identity_verified,
                }).collect())
        })
    }

    fn read_scaling(
        &mut self,
        device_key: &str,
        display_key: &str,
    ) -> Result<DisplayScalingObservation, String> {
        self.with_session(device_key, |session, index| {
            let handle = super::display_apply::resolve_display_handle(session, index, device_key, display_key)?;
            let (version, settings) = session.display_scaling(handle)
                .ok_or_else(|| "ctlGetCurrentScaling GET failed".to_owned())?;
            Ok(observation_from_igcl(version, settings.Enable, settings.ScalingType,
                settings.CustomScalingX, settings.CustomScalingY,
                (version == 1).then_some(settings.PreferredScalingType)))
        })
    }

    fn set_scaling_if_current(
        &mut self,
        device_key: &str,
        display_key: &str,
        expected_current: &DisplayScalingObservation,
        requested: &DisplayScalingWrite,
    ) -> DisplayScalingWriteOutcome {
        let mut setter_result = None;
        let operation = self.with_session(device_key, |session, index| {
            let handle = super::display_apply::resolve_display_handle(session, index, device_key, display_key)?;
            let (version, settings) = session.display_scaling(handle)
                .ok_or_else(|| "ctlGetCurrentScaling pre-write GET failed".to_owned())?;
            let current = observation_from_igcl(version, settings.Enable, settings.ScalingType,
                settings.CustomScalingX, settings.CustomScalingY,
                (version == 1).then_some(settings.PreferredScalingType));
            if &current != expected_current {
                return Err("the display scaling state changed before the guarded setter".into());
            }
            if !session.display_scaling_set_available() {
                return Err("ctlSetCurrentScaling is unavailable".into());
            }
            match session.display_apply_api().set_scaling(handle, requested.enabled,
                requested.scaling_type, requested.custom, requested.hardware_mode_set) {
                Ok(_) => {
                    setter_result = Some(Ok(()));
                    // Match Electron's post-SET settling interval before its
                    // first fresh scaling GET.
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
                    setter_result = Some(Err((error_code, message.clone())));
                    Err(message)
                }
            }
        });
        match (operation, setter_result) {
            (Ok(()), Some(Ok(()))) => DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: true, result: Ok(()), error_code: None,
            },
            (Err(_), Some(Err((error_code, message)))) => DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: false, result: Err(message), error_code: Some(error_code),
            },
            (Ok(()), Some(Err((error_code, message)))) => DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: false, result: Err(message), error_code: Some(error_code),
            },
            (Err(error), Some(Ok(()))) => DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: true,
                result: Err(format!("IGCL session cleanup failed after scaling SET: {error}")),
                error_code: Some("io-failed"),
            },
            (Err(error), None) => DisplayScalingWriteOutcome::NotAttempted(error),
            (Ok(()), None) => DisplayScalingWriteOutcome::NotAttempted("the setter outcome is unavailable".into()),
        }
    }

    fn read_retro_scaling(
        &mut self,
        device_key: &str,
        display_key: &str,
    ) -> Result<Option<RetroScalingObservation>, String> {
        self.with_session(device_key, |session, index| {
            let _output = super::display_apply::resolve_display_handle(session, index, device_key, display_key)?;
            // Electron's display read gates the whole Retro block on both
            // exports; an unbound surface is absent, never "disabled".
            if !session.display_retro_scaling_gate() { return Ok(None); }
            let adapter = session.display_adapter_handle(index)
                .ok_or_else(|| "the selected IGCL adapter handle is unavailable".to_owned())?;
            let value = session.display_retro_scaling(adapter)
                .ok_or_else(|| "ctlGetSetRetroScaling GET failed".to_owned())?;
            RetroScalingObservation::from_driver(value.Enable, value.RetroScalingType).map(Some)
        })
    }

    fn set_retro_scaling_if_current(
        &mut self,
        device_key: &str,
        display_key: &str,
        expected_current: RetroScalingObservation,
        requested: RetroScalingWrite,
    ) -> DisplayScalingWriteOutcome {
        let mut setter_result = None;
        let operation = self.with_session(device_key, |session, index| {
            let _output = super::display_apply::resolve_display_handle(session, index, device_key, display_key)?;
            let adapter = session.display_adapter_handle(index)
                .ok_or_else(|| "the selected IGCL adapter handle is unavailable".to_owned())?;
            let current = session.display_retro_scaling(adapter)
                .ok_or_else(|| "ctlGetSetRetroScaling pre-write GET failed".to_owned())?;
            let current = RetroScalingObservation::from_driver(current.Enable, current.RetroScalingType)?;
            if !current.same_effective_state(expected_current) {
                return Err("the Retro Scaling state changed before the coupled setter".into());
            }
            match session.display_apply_api()
                .set_retro_scaling(adapter, requested.enabled, requested.method.igcl())
            {
                Ok(()) => {
                    setter_result = Some(Ok(()));
                    Ok(())
                }
                Err(error) => {
                    let error_code = error.status
                        .and_then(super::gpu_apply::igcl_error_code)
                        .unwrap_or("io-failed");
                    let message = error.status.map(|status| {
                        format!("IGCL {}", super::igcl_read_only::describe_pixel_transformation_result(status))
                    }).unwrap_or_else(|| format!("IGCL {error}"));
                    setter_result = Some(Err((error_code, message.clone())));
                    Err(message)
                }
            }
        });
        match (operation, setter_result) {
            (Ok(()), Some(Ok(()))) => DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: true, result: Ok(()), error_code: None,
            },
            (Err(_), Some(Err((error_code, message)))) => DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: false, result: Err(message), error_code: Some(error_code),
            },
            (Ok(()), Some(Err((error_code, message)))) => DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: false, result: Err(message), error_code: Some(error_code),
            },
            (Err(error), Some(Ok(()))) => DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: true,
                result: Err(format!("IGCL session cleanup failed after the coupled Retro Scaling SET: {error}")),
                error_code: Some("io-failed"),
            },
            (Err(error), None) => DisplayScalingWriteOutcome::NotAttempted(error),
            (Ok(()), None) => DisplayScalingWriteOutcome::NotAttempted("the coupled Retro Scaling setter outcome is unavailable".into()),
        }
    }
}

fn observation_from_igcl(
    version: u8,
    enabled: u8,
    scaling_type: u32,
    custom_x: u32,
    custom_y: u32,
    preferred_scaling_type: Option<u32>,
) -> DisplayScalingObservation {
    DisplayScalingObservation {
        version,
        enabled: enabled != 0,
        scaling_type,
        custom_x,
        custom_y,
        preferred_scaling_type,
    }
}

enum PreparedDisplayScaling {
    Ready {
        backend: NativeDisplayScalingBackend,
        store: DisplayScalingStore,
        state_key: String,
    },
    Failed(DisplayScalingApplyResult),
}

/// Shared identity/store preamble for the native scaling entry points. Every
/// decline here happens before the first SET.
fn prepare_native_scaling(
    physical_target: &Value,
    target: &DisplayScalingTarget,
    requested: &DisplayScalingWrite,
) -> PreparedDisplayScaling {
    if !valid_target(target) {
        return PreparedDisplayScaling::Failed(failed("stale-target", "the display scaling request requires matching stable adapter and output identities"));
    }
    if !valid_write(requested) {
        return PreparedDisplayScaling::Failed(failed("out-of-range", "The display scaling request is invalid."));
    }
    let normalized = match super::display_apply::normalize_physical_target(&target.device_key, physical_target) {
        Ok(row) => row,
        Err(error) => return PreparedDisplayScaling::Failed(failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}"))),
    };
    let identity = match gpu_apply_identity::identity_from_row(&normalized) {
        Ok(identity) => identity,
        Err(error) => return PreparedDisplayScaling::Failed(failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}"))),
    };
    let Some(dll_path) = super::display_igcl_dll::locate_dll() else {
        return PreparedDisplayScaling::Failed(failed("io-failed", "The trusted Intel display runtime is unavailable."));
    };
    let namespace = super::display::color_namespace(&normalized);
    let Some(state_key) = super::display::display_key_in_namespace(&target.display_key, Some(&namespace)) else {
        return PreparedDisplayScaling::Failed(failed("stale-target", "the display scaling selector namespace could not be verified"));
    };
    PreparedDisplayScaling::Ready {
        backend: NativeDisplayScalingBackend {
            dll_path,
            identity,
            selected_device_key: target.device_key.clone(),
        },
        store: DisplayScalingStore::application_default(),
        state_key,
    }
}

/// Private native entry point for a future owner. This prepares the native
/// adapter but does not route a service command or execute during tests.
pub(crate) fn apply_display_scaling_native(
    display_guard: &super::display_lock::DisplayLockGuard,
    physical_target: &Value,
    target: &DisplayScalingTarget,
    requested: &DisplayScalingWrite,
) -> DisplayScalingApplyResult {
    match prepare_native_scaling(physical_target, target, requested) {
        PreparedDisplayScaling::Ready { mut backend, mut store, state_key } =>
            apply_display_scaling_with_store(display_guard, &mut backend, &mut store, &state_key, target, requested),
        PreparedDisplayScaling::Failed(result) => result,
    }
}

/// Native entry point for one routed Scaling Mode selection. It shares the
/// ordinary adapter/store preparation, so identity proof, the conditional
/// pre-write check and the 400 ms settle are exactly the ones the private
/// transaction already enforces.
pub(crate) fn apply_display_scaling_mode_native(
    display_guard: &super::display_lock::DisplayLockGuard,
    physical_target: &Value,
    target: &DisplayScalingTarget,
    requested: &DisplayScalingWrite,
    retro_disable: Option<RetroScalingMethod>,
) -> DisplayScalingModeApplyOutcome {
    match prepare_native_scaling(physical_target, target, requested) {
        PreparedDisplayScaling::Ready { mut backend, mut store, state_key } =>
            apply_display_scaling_mode_with_store(
                display_guard, &mut backend, &mut store, &state_key, target, requested, retro_disable,
            ),
        PreparedDisplayScaling::Failed(result) =>
            DisplayScalingModeApplyOutcome::Applied(DisplayScalingModeApplyResult::without_coupling(result)),
    }
}

/// One Scaling Mode selection, including the coupled Retro exit the renderer
/// sends when it leaves Retro Scaling.
///
/// Ordering mirrors the Electron oracle:
/// 1. read the current Retro tuple (pre-write; unreadable means broker retry);
/// 2. refuse the whole request, with zero writes, when Retro is active and this
///    patch cannot safely disable it;
/// 3. disable Retro FIRST and verify it;
/// 4. run the ordinary scaling transaction (conditional pre-write check, the
///    Custom neutral initialization, 400 ms settle per SET, read-back, rollback);
/// 5. when the ordinary transaction did not apply, restore the previous Retro
///    state exactly once and report it.
///
/// Step 4 reads the durable selector before its driver write, so a selector
/// failure that happens after the coupled disable is compensated by the same
/// step-5 restore: the display is left in its pre-request state either way.
///
/// Custom reaches this layer with its pair attached (`DisplayScalingPatch`),
/// and the two-step initialization lives inside the single transaction, never
/// as a second routed request.
pub(crate) fn apply_display_scaling_mode_with_store(
    display_guard: &super::display_lock::DisplayLockGuard,
    backend: &mut dyn DisplayScalingApplyBackend,
    store: &mut dyn DisplayScalingSelectionStore,
    state_key: &str,
    target: &DisplayScalingTarget,
    requested: &DisplayScalingWrite,
    retro_disable: Option<RetroScalingMethod>,
) -> DisplayScalingModeApplyOutcome {
    if scaling_name(requested.scaling_type).is_none() {
        return DisplayScalingModeApplyOutcome::Applied(DisplayScalingModeApplyResult::failed(
            "out-of-range", "The display scaling request is not a known IGCL scaling flag."));
    }
    let Ok(retro_before) = read_retro_scaling_state(backend, target) else {
        return DisplayScalingModeApplyOutcome::Declined;
    };
    let Some(retro_before) = retro_before.filter(|state| state.enabled) else {
        // No Retro surface, or no active scaler to exit. A bundled exit
        // companion is the later standalone Retro step's job, so that
        // candidate stays broker-owned; an ordinary selection is unaffected.
        if retro_disable.is_some() { return DisplayScalingModeApplyOutcome::Declined; }
        return DisplayScalingModeApplyOutcome::Applied(DisplayScalingModeApplyResult::without_coupling(
            apply_display_scaling_with_store(display_guard, backend, store, state_key, target, requested),
        ));
    };
    // REFUSAL FIRST: an enabled Retro method must be disabled by the same
    // request. An unknown active method cannot be restored, so it refuses too.
    let Some(active_method) = retro_before.method else {
        return DisplayScalingModeApplyOutcome::Applied(DisplayScalingModeApplyResult::failed(
            "unsupported", RETRO_SCALING_ACTIVE_REFUSAL));
    };
    let Some(disable_method) = retro_disable else {
        return DisplayScalingModeApplyOutcome::Applied(DisplayScalingModeApplyResult::failed(
            "unsupported", RETRO_SCALING_ACTIVE_REFUSAL));
    };
    let disable = RetroScalingWrite { enabled: false, method: disable_method };
    match backend.set_retro_scaling_if_current(
        &target.device_key, &target.display_key, retro_before, disable,
    ) {
        DisplayScalingWriteOutcome::NotAttempted(_) => return DisplayScalingModeApplyOutcome::Declined,
        // A failed setter leaves the ordinary scaler untouched, exactly like
        // Electron's coupled-exit failure.
        DisplayScalingWriteOutcome::Attempted { setter_succeeded: false, error_code, .. } =>
            return DisplayScalingModeApplyOutcome::Applied(DisplayScalingModeApplyResult::failed(
                error_code.unwrap_or("io-failed"), RETRO_SCALING_NOT_DISABLED_MESSAGE)),
        DisplayScalingWriteOutcome::Attempted { setter_succeeded: true, .. } => {}
    }
    let disabled_state = match read_retro_scaling_state(backend, target) {
        Ok(Some(state)) if !state.enabled => state,
        // The SET returned success but did not disable Retro (or the read-back
        // failed); the ordinary output scaler must not move.
        _ => return DisplayScalingModeApplyOutcome::Applied(DisplayScalingModeApplyResult::failed(
            "io-failed", RETRO_SCALING_NOT_DISABLED_MESSAGE)),
    };

    let mut result = DisplayScalingModeApplyResult::without_coupling(
        apply_display_scaling_with_store(display_guard, backend, store, state_key, target, requested),
    );
    if result.scaling.ok { return DisplayScalingModeApplyOutcome::Applied(result); }

    // The ordinary write did not apply. Restore the previously enabled Retro
    // method once, conditionally, and report whether the read-back proved it.
    let restore = retro_before.restore_write(active_method);
    let restore_ok = match backend.set_retro_scaling_if_current(
        &target.device_key, &target.display_key, disabled_state, restore,
    ) {
        DisplayScalingWriteOutcome::NotAttempted(_) => false,
        DisplayScalingWriteOutcome::Attempted { setter_succeeded, .. } => setter_succeeded
            && matches!(
                read_retro_scaling_state(backend, target),
                Ok(Some(state)) if state.matches_write(restore)
            ),
    };
    result.retro_restore_ok = Some(restore_ok);
    DisplayScalingModeApplyOutcome::Applied(result)
}

fn read_retro_scaling_state(
    backend: &mut dyn DisplayScalingApplyBackend,
    target: &DisplayScalingTarget,
) -> Result<Option<RetroScalingObservation>, ()> {
    verify_output(backend, target).map_err(|_| ())?;
    backend.read_retro_scaling(&target.device_key, &target.display_key).map_err(|_| ())
}

/// Apply one scaling selector while the caller owns the shared Display lock.
/// A failed write is compensated only if fresh GET still matches this
/// transaction's requested state; read-back and rollback both require the
/// same uniquely verified active stable output identity.
pub(crate) fn apply_display_scaling(
    _display_guard: &super::display_lock::DisplayLockGuard,
    backend: &mut dyn DisplayScalingApplyBackend,
    target: &DisplayScalingTarget,
    requested: &DisplayScalingWrite,
) -> DisplayScalingApplyResult {
    let _local_guard = DISPLAY_SCALING_APPLY_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if !valid_target(target) || !valid_write(requested) {
        return failed("out-of-range", "The display scaling request or stable output identity is invalid.");
    }
    if let Err((code, message)) = verify_output(backend, target) {
        return failed(code, message);
    }
    // Refresh the rollback point after identity verification, immediately
    // before the guarded write. The backend repeats the tuple comparison at
    // its own write boundary.
    if let Err((code, message)) = verify_output(backend, target) {
        return failed(code, message);
    }
    let rollback_point = match read_current(backend, target) {
        Ok(observation) => observation,
        Err((code, message)) => return failed(code, message),
    };
    if !safe_restore_point(&rollback_point) {
        return failed("io-failed", "The current display scaling state cannot be restored safely.");
    }
    if let Err((code, message)) = verify_output(backend, target) {
        return failed(code, message);
    }

    // Electron's first-time Custom entry is one transaction with two modesets:
    // a verified neutral 100x100 initialization, then the remembered pair. The
    // neutral step is skipped when the target IS the neutral pair or the driver
    // already proves a non-zero custom pair, so a repeat entry never writes
    // twice (`igcl-display-scaling.js:125-133`). A failed initialization must
    // never reach the second SET: it rolls the driver back instead.
    let initialized = match initialize_custom_scaling(backend, target, &rollback_point, requested) {
        Ok(state) => state,
        Err(failure) => return failure,
    };
    // The second SET guards against the tuple the driver holds now: after a
    // neutral initialization that is our own neutral tuple, not the caller's
    // prior state. `rollback_point` stays the compensation target throughout.
    let expected_current = initialized.as_ref().unwrap_or(&rollback_point);

    let (setter_succeeded, set_result, set_error_code) = match backend.set_scaling_if_current(
        &target.device_key,
        &target.display_key,
        expected_current,
        requested,
    ) {
        DisplayScalingWriteOutcome::NotAttempted(error) => {
            return failed("io-failed", format!("display scaling pre-write check failed: {error}"));
        }
        DisplayScalingWriteOutcome::Attempted { setter_succeeded, result, error_code } => {
            (setter_succeeded, result, error_code)
        }
    };
    let after_write = match read_current(backend, target) {
        Ok(observation) => observation,
        Err((code, message)) => {
            let mut result = failed_after_set(code, message, setter_succeeded);
            result.state_may_have_changed = true;
            return result;
        }
    };
    let active_read_back_equal = active_scaling_matches(&after_write, requested);
    let preferred_read_back_equal = preferred_scaling_matches(&after_write, requested);
    let read_back_equal = active_read_back_equal || is_deferred(&after_write, requested);
    let deferred = read_back_equal && is_deferred(&after_write, requested);
    if set_result.is_ok() && read_back_equal {
        return succeeded(Some(after_write), Some(rollback_point), true, deferred,
            active_read_back_equal, preferred_read_back_equal);
    }

    let primary_message = match set_result {
        Err(error) => format!("display scaling setter failed: {error}"),
        Ok(()) => after_write_message(&after_write, requested),
    };
    // Nothing moved: the driver still holds the caller's prior tuple, so there
    // is nothing of ours to undo.
    if after_write == rollback_point {
        let mut result = failed_after_set(
            set_error_code.unwrap_or("io-failed"), primary_message, setter_succeeded);
        result.read_back = Some(after_write);
        result.read_back_equal = read_back_equal;
        result.active_read_back_equal = active_read_back_equal;
        result.preferred_read_back_equal = preferred_read_back_equal;
        result.deferred = deferred;
        return result;
    }
    // A third value may be a concurrent driver/UI change. Do not overwrite it.
    // The one tuple that is ours and not the requested pair is the verified
    // neutral initialization, which this transaction must undo below.
    if !read_back_equal && Some(&after_write) != initialized.as_ref() {
        let mut result = failed_after_set(
            set_error_code.unwrap_or("io-failed"),
            format!("{primary_message}; current scaling state differs from both the requested and prior state; no rollback was written"),
            setter_succeeded);
        result.read_back = Some(after_write);
        result.state_may_have_changed = true;
        result.read_back_equal = read_back_equal;
        result.active_read_back_equal = active_read_back_equal;
        result.preferred_read_back_equal = preferred_read_back_equal;
        result.deferred = deferred;
        return result;
    }

    let restore_write = selected_restore_write(&rollback_point)
        .expect("the prior scaling state was checked as restorable before write");
    if let Err((code, message)) = verify_output(backend, target) {
        let mut result = failed_after_set(
            "io-failed",
            format!("{primary_message}; rollback skipped because output verification failed: {message}"),
            setter_succeeded);
        result.error_code = Some(code);
        result.read_back = Some(after_write);
        result.read_back_equal = read_back_equal;
        result.active_read_back_equal = active_read_back_equal;
        result.preferred_read_back_equal = preferred_read_back_equal;
        result.deferred = deferred;
        result.state_may_have_changed = true;
        return result;
    }
    let before_rollback = match read_current(backend, target) {
        Ok(observation) => observation,
        Err((code, message)) => {
            let mut result = failed_after_set(
                "io-failed",
                format!("{primary_message}; rollback state could not be read: {message}"),
                setter_succeeded);
            result.error_code = Some(code);
            result.read_back = Some(after_write);
            result.read_back_equal = read_back_equal;
            result.active_read_back_equal = active_read_back_equal;
            result.preferred_read_back_equal = preferred_read_back_equal;
            result.deferred = deferred;
            result.state_may_have_changed = true;
            return result;
        }
    };
    if before_rollback != after_write {
        let mut result = failed_after_set(
            "io-failed",
            format!("{primary_message}; scaling changed before rollback, so no rollback was written"),
            setter_succeeded);
        result.read_back = Some(before_rollback);
        result.read_back_equal = read_back_equal;
        result.active_read_back_equal = active_read_back_equal;
        result.preferred_read_back_equal = preferred_read_back_equal;
        result.deferred = deferred;
        result.state_may_have_changed = true;
        return result;
    }

    let rollback_result = match backend.set_scaling_if_current(
        &target.device_key,
        &target.display_key,
        &after_write,
        &restore_write,
    ) {
        DisplayScalingWriteOutcome::NotAttempted(error) => Err(error),
        DisplayScalingWriteOutcome::Attempted { result, .. } => result,
    };
    let rollback_read = read_current(backend, target);
    let rollback_verified = rollback_read.as_ref().is_ok_and(|actual| scaling_restored(&rollback_point, actual));
    let mut result = failed_after_set(
        set_error_code.unwrap_or("io-failed"), primary_message, setter_succeeded);
    result.read_back_equal = read_back_equal;
    result.active_read_back_equal = active_read_back_equal;
    result.preferred_read_back_equal = preferred_read_back_equal;
    result.deferred = deferred;
    result.rollback_attempted = true;
    result.rollback_verified = rollback_verified;
    match rollback_read {
        Ok(actual) => {
            result.state_may_have_changed = !rollback_verified;
            result.read_back = Some(actual);
            if rollback_verified && rollback_result.is_err() {
                result.message = Some(format!("{}; restoration is verified despite setter error: {}",
                    result.message.unwrap_or_default(), rollback_result.unwrap_err()));
            }
        }
        Err((code, message)) => {
            result.error_code = Some(code);
            result.message = Some(format!("{}; rollback read-back failed: {message}", result.message.unwrap_or_default()));
            result.state_may_have_changed = true;
        }
    }
    result
}

/// A failed result after the requested pair's SET ran. It records that SET's
/// acceptance in one place so every failure branch reports the same envelope
/// boundary: `setter_succeeded`, `requested_set` and `readback_reported`.
fn failed_after_set(
    code: &'static str,
    message: impl Into<String>,
    setter_succeeded: bool,
) -> DisplayScalingApplyResult {
    let mut result = failed(code, message);
    result.setter_succeeded = Some(setter_succeeded);
    result.requested_set = Some(setter_succeeded);
    result.readback_reported = setter_succeeded;
    result
}

/// Electron's first-time Custom entry needs a verified neutral 100x100
/// initialization unless the driver already holds a proven non-zero custom
/// pair, or the request itself is the neutral pair
/// (`igcl-display-scaling.js:125-133`). Zero coordinates are inside the valid
/// 0..100 range but never proof of an initialized pair, so they re-initialize.
fn needs_custom_initialization(
    prior: &DisplayScalingObservation,
    requested: &DisplayScalingWrite,
) -> bool {
    if requested.scaling_type != 16 || requested.custom == Some((100, 100)) { return false; }
    !(prior.scaling_type == 16
        && prior.custom_x > 0
        && prior.custom_y > 0
        && prior.custom_x <= 100
        && prior.custom_y <= 100)
}

fn neutral_custom_write() -> DisplayScalingWrite {
    DisplayScalingWrite {
        enabled: true,
        scaling_type: 16,
        custom: Some((100, 100)),
        hardware_mode_set: true,
    }
}

/// Step 1 of the Custom entry, inside the caller's single transaction and
/// `DisplayLockGuard`. The neutral SET goes through the same conditional
/// pre-write check and 400 ms settle as the remembered pair; its read-back must
/// prove the neutral tuple before step 2 may run.
///
/// `Ok(Some(observation))` is the verified neutral tuple the driver now holds:
/// step 2 compares against it, not against the caller's prior state.
fn initialize_custom_scaling(
    backend: &mut dyn DisplayScalingApplyBackend,
    target: &DisplayScalingTarget,
    prior: &DisplayScalingObservation,
    requested: &DisplayScalingWrite,
) -> Result<Option<DisplayScalingObservation>, DisplayScalingApplyResult> {
    if !needs_custom_initialization(prior, requested) { return Ok(None); }
    let neutral = neutral_custom_write();
    let (setter_succeeded, set_result, set_error_code) = match backend.set_scaling_if_current(
        &target.device_key,
        &target.display_key,
        prior,
        &neutral,
    ) {
        DisplayScalingWriteOutcome::NotAttempted(error) => return Err(failed(
            "io-failed",
            format!("display scaling custom initialization pre-write check failed: {error}"),
        )),
        DisplayScalingWriteOutcome::Attempted { setter_succeeded, result, error_code } =>
            (setter_succeeded, result, error_code),
    };
    // The setter seam already applied Electron's settling interval after an
    // accepted SET, so this GET is the neutral read-back Electron takes at
    // `igcl-display-scaling.js:143-145`.
    let read_back = read_current(backend, target);
    // A read-back value is not proof that WE produced it, so the rollback
    // witness is the neutral tuple this transaction wrote, and only when the
    // read-back proves exactly that tuple.
    let witness = read_back.as_ref().ok()
        .filter(|actual| active_scaling_matches(actual, &neutral))
        .cloned();
    let verified = set_result.is_ok() && witness.is_some();
    if verified {
        return Ok(witness);
    }
    let (code, message) = match (&set_result, &read_back) {
        (Ok(()), Err((code, error))) =>
            (*code, format!("display scaling custom initialization read-back failed: {error}")),
        (Err(error), _) =>
            (set_error_code.unwrap_or("io-failed"),
                format!("display scaling custom initialization setter failed: {error}")),
        (Ok(()), Ok(actual)) => ("io-failed", format!(
            "the display scaling state changed to a tuple this transaction did not set (enabled={}, type={}, custom={}x{}, preferred={:?}) after the neutral Custom initialization",
            actual.enabled, actual.scaling_type, actual.custom_x, actual.custom_y,
            actual.preferred_scaling_type)),
    };
    Err(custom_initialization_rollback(
        backend,
        target,
        prior,
        witness,
        setter_succeeded,
        code,
        message,
    ))
}

/// Undo a failed or mismatched neutral Custom initialization. The requested
/// pair is never attempted here.
///
/// `witness` is the neutral tuple this transaction wrote, and it is `Some` only
/// when the read-back proved exactly that tuple. A rollback write then requires
/// a fresh GET that still matches it, so a state this transaction cannot
/// attribute to itself is left untouched.
///
/// DELIBERATE DIVERGENCE FROM ELECTRON: `igcl-display-scaling.js:147-153` rolls
/// the prior tuple back whenever the initialization SET was accepted, even when
/// the read-back reported a different tuple. This writer refuses that write - a
/// read-back value is not proof that we produced it - and reports the
/// uncertainty instead. Do not "restore parity" here.
fn custom_initialization_rollback(
    backend: &mut dyn DisplayScalingApplyBackend,
    target: &DisplayScalingTarget,
    prior: &DisplayScalingObservation,
    witness: Option<DisplayScalingObservation>,
    setter_succeeded: bool,
    code: &'static str,
    message: String,
) -> DisplayScalingApplyResult {
    let mut result = failed(code, message);
    result.setter_succeeded = Some(setter_succeeded);
    result.read_back = witness;
    if !setter_succeeded {
        // The driver rejected the initialization SET; Electron reports that
        // failure without a rollback write because nothing was accepted.
        return result;
    }
    result.state_may_have_changed = true;
    // Ownership needs all three: a present witness, a witness that equals the
    // tuple we wrote, and a fresh GET that still matches it. The caller only
    // supplies a witness that satisfies the second test, so an absent witness
    // here means "we cannot prove this state is ours" and no write is issued.
    let Some(witness) = result.read_back.clone() else {
        result.message.as_mut().unwrap()
            .push_str("; no rollback was written");
        return result;
    };
    let Some(restore) = selected_restore_write(prior) else {
        result.message.as_mut().unwrap()
            .push_str("; the original scaling tuple has no safe restore request");
        return result;
    };
    let current = match read_current(backend, target) {
        Ok(current) => current,
        Err((error_code, error)) => {
            result.error_code = Some(error_code);
            result.message.as_mut().unwrap()
                .push_str(&format!("; rollback state could not be read: {error}"));
            return result;
        }
    };
    if witness != current {
        result.message.as_mut().unwrap()
            .push_str("; scaling changed before rollback, so no rollback was written");
        return result;
    }
    let set_result = match backend.set_scaling_if_current(
        &target.device_key,
        &target.display_key,
        &current,
        &restore,
    ) {
        DisplayScalingWriteOutcome::NotAttempted(error) => Err(error),
        DisplayScalingWriteOutcome::Attempted { result, .. } => result,
    };
    result.rollback_attempted = true;
    match read_current(backend, target) {
        Ok(actual) => {
            result.rollback_verified = scaling_restored(prior, &actual);
            result.state_may_have_changed = !result.rollback_verified;
            result.read_back = Some(actual);
            if result.rollback_verified && set_result.is_err() {
                result.message.as_mut().unwrap()
                    .push_str("; the prior driver mode is verified despite a rollback setter error");
            }
        }
        Err((error_code, error)) => {
            result.error_code = Some(error_code);
            result.message.as_mut().unwrap()
                .push_str(&format!("; rollback read-back failed: {error}"));
        }
    }
    result
}

/// Apply a driver scaling request and coordinate Electron's identity-specific
/// selector record under the same shared Display lock. A save error is
/// followed by a record re-read: a matching durable commit is accepted, an
/// unchanged prior record permits guarded driver compensation, and any other
/// or unreadable state returns `cleanup-pending` without overwriting it.
pub(crate) fn apply_display_scaling_with_store(
    display_guard: &super::display_lock::DisplayLockGuard,
    backend: &mut dyn DisplayScalingApplyBackend,
    store: &mut dyn DisplayScalingSelectionStore,
    state_key: &str,
    target: &DisplayScalingTarget,
    requested: &DisplayScalingWrite,
) -> DisplayScalingApplyResult {
    if !valid_target(target) || !valid_write(requested) {
        return failed("out-of-range", "The display scaling request or stable output identity is invalid.");
    }
    let previous_selection = match store.read_selection(state_key) {
        Ok(selection) => selection,
        Err(error) => return failed("io-failed", format!("display scaling selector read failed: {error}")),
    };

    let mut applied = apply_display_scaling(display_guard, backend, target, requested);
    if !applied.ok { return applied; }
    let Some(read_back) = applied.read_back.clone() else {
        return failed("io-failed", "Display scaling succeeded without a verifiable read-back tuple.");
    };
    let update = selector_update(requested, &read_back);
    let expected_selection = selection_after_update(update, previous_selection);
    let save_result = store.save_selection(state_key, &update);
    let store_read = store.read_selection(state_key);
    match store_read {
        Ok(Some(saved)) if saved == expected_selection => {
            match read_current(backend, target) {
                Ok(current) if current == read_back && scaling_request_matches(&current, requested) => {}
                Ok(_) => return selector_state_uncertain(applied, format!(
                    "The selector record was saved, but the display scaling tuple changed afterward; no rollback was written.")),
                Err((_, error)) => return selector_state_uncertain(applied, format!(
                    "The selector record was saved, but the display identity/read-back could not be confirmed afterward: {error}")),
            }
            applied.selection_saved = true;
            if let Err(error) = save_result {
                applied.message = Some(format!("The selector write reported an error, but its matching durable record was verified: {error}"));
            }
            applied
        }
        Ok(current) if current == previous_selection => {
            let save_error = save_result.err().unwrap_or_else(|| "the selector write returned success but the durable record did not change".into());
            let compensated = compensate_after_selector_failure(backend, target, applied, save_error);
            match store.read_selection(state_key) {
                Ok(current) if current == previous_selection => compensated,
                Ok(_) => selector_state_uncertain(compensated, "The selector record changed after driver compensation; it was left untouched.".into()),
                Err(error) => selector_state_uncertain(compensated, format!(
                    "The driver compensation completed, but the selector record could not be confirmed afterward: {error}")),
            }
        }
        Ok(_) => {
            let reason = save_result.err().unwrap_or_else(|| "the selector record changed to an unexpected value".into());
            selector_state_uncertain(applied, format!(
                "The driver accepted scaling, but selector persistence is uncertain ({reason}); no driver rollback was written because the store no longer matches its prior record."))
        }
        Err(error) => selector_state_uncertain(applied, format!(
            "The driver accepted scaling, but selector persistence could not be read back ({error}); no driver rollback was written because durable state is uncertain.")),
    }
}

fn selector_update(
    requested: &DisplayScalingWrite,
    actual: &DisplayScalingObservation,
) -> SelectionUpdate {
    SelectionUpdate {
        identity_scaling: requested.scaling_type == 1,
        native_preferred_scaling_type: (actual.version == 1).then_some(actual.preferred_scaling_type).flatten(),
        custom: (requested.scaling_type == 16).then_some((actual.custom_x, actual.custom_y)),
    }
}

fn selection_after_update(
    update: SelectionUpdate,
    previous: Option<ScalingSelection>,
) -> ScalingSelection {
    ScalingSelection {
        identity_scaling: update.identity_scaling,
        native_preferred_scaling_type: update.native_preferred_scaling_type,
        custom_x: update.custom.map(|(x, _)| x).or(previous.and_then(|selection| selection.custom_x)),
        custom_y: update.custom.map(|(_, y)| y).or(previous.and_then(|selection| selection.custom_y)),
    }
}

fn compensate_after_selector_failure(
    backend: &mut dyn DisplayScalingApplyBackend,
    target: &DisplayScalingTarget,
    mut applied: DisplayScalingApplyResult,
    save_error: String,
) -> DisplayScalingApplyResult {
    let actual = applied.read_back.clone().expect("successful apply has a read-back");
    let Some(prior) = applied.prior_state.clone() else {
        return selector_state_uncertain(applied, format!(
            "Selector save failed ({save_error}) and the prior driver tuple is unavailable; no rollback was written."));
    };
    applied.ok = false;
    applied.error_code = Some("io-failed");
    applied.message = Some(format!("The driver accepted scaling but selector persistence failed: {save_error}"));
    applied.selection_saved = false;
    if prior == actual {
        applied.message.as_mut().unwrap().push_str("; the prior driver mode was already present, so no rollback was needed");
        return applied;
    }
    let current = match read_current(backend, target) {
        Ok(current) => current,
        Err((_, error)) => return selector_state_uncertain(applied, format!(
            "The driver accepted scaling but selector persistence failed ({save_error}); rollback was skipped because current state could not be verified: {error}")),
    };
    if current != actual {
        return selector_state_uncertain(applied, format!(
            "The driver accepted scaling but selector persistence failed ({save_error}); current scaling changed before rollback, so no rollback was written."));
    }
    let Some(restore) = selected_restore_write(&prior) else {
        return selector_state_uncertain(applied, format!(
            "The driver accepted scaling but selector persistence failed ({save_error}); the original scaling tuple has no safe restore request."));
    };
    let set_result = match backend.set_scaling_if_current(&target.device_key, &target.display_key, &actual, &restore) {
        DisplayScalingWriteOutcome::NotAttempted(error) => Err(error),
        DisplayScalingWriteOutcome::Attempted { result, .. } => result,
    };
    applied.rollback_attempted = true;
    match read_current(backend, target) {
        Ok(rollback_read) => {
            applied.rollback_verified = scaling_restored(&prior, &rollback_read);
            applied.state_may_have_changed = !applied.rollback_verified;
            applied.read_back = Some(rollback_read);
            if applied.rollback_verified {
                applied.message.as_mut().unwrap().push_str(if set_result.is_ok() {
                    "; the prior driver mode was restored and verified"
                } else {
                    "; the prior driver mode is verified despite a rollback setter error"
                });
            } else {
                applied.error_code = Some("cleanup-pending");
                applied.message.as_mut().unwrap().push_str("; rollback did not verify, so driver state may have changed");
            }
        }
        Err((_, error)) => {
            applied.error_code = Some("cleanup-pending");
            applied.state_may_have_changed = true;
            applied.message.as_mut().unwrap().push_str(&format!("; rollback read-back failed: {error}"));
        }
    }
    applied
}

fn selector_state_uncertain(
    mut result: DisplayScalingApplyResult,
    message: String,
) -> DisplayScalingApplyResult {
    result.ok = false;
    result.error_code = Some("cleanup-pending");
    result.message = Some(message);
    result.selection_saved = false;
    result.state_may_have_changed = true;
    result
}

fn valid_target(target: &DisplayScalingTarget) -> bool {
    !target.device_key.trim().is_empty()
        && !target.display_key.trim().is_empty()
        && target.display_key.split_once("|display|")
            .is_some_and(|(device, suffix)| device == target.device_key && !suffix.is_empty())
}

fn valid_write(write: &DisplayScalingWrite) -> bool {
    SCALING_TYPES.contains(&write.scaling_type)
        && write.hardware_mode_set == (write.scaling_type == 16)
        && match (write.scaling_type, write.custom) {
            (16, Some((x, y))) => x <= 100 && y <= 100,
            (16, None) => false,
            (_, None) => true,
            (_, Some(_)) => false,
        }
}

fn valid_observation(observation: &DisplayScalingObservation) -> bool {
    matches!(observation.version, 0 | 1)
        && SCALING_TYPES.contains(&observation.scaling_type)
        && (observation.version == 1 || observation.preferred_scaling_type.is_none())
        && observation.preferred_scaling_type.map_or(true, |value| SCALING_TYPES.contains(&value))
        && (observation.scaling_type != 16 || (observation.custom_x <= 100 && observation.custom_y <= 100))
}

fn safe_restore_point(observation: &DisplayScalingObservation) -> bool {
    if !valid_observation(observation)
        || (observation.version == 1 && observation.preferred_scaling_type.is_none())
    {
        return false;
    }
    selected_restore_write(observation).is_some()
}

fn selected_restore_write(observation: &DisplayScalingObservation) -> Option<DisplayScalingWrite> {
    if !valid_observation(observation) { return None; }
    let selected_type = if observation.scaling_type == 16 {
        16
    } else if observation.version == 1 && observation.scaling_type == 1 {
        observation.preferred_scaling_type.unwrap_or(observation.scaling_type)
    } else {
        observation.scaling_type
    };
    // The GET tuple only proves custom coordinates while type 16 is active.
    // Do not invent neutral coordinates when a dormant preferred type happens
    // to be custom; that would make compensation lossy.
    if selected_type == 16 && observation.scaling_type != 16 { return None; }
    let custom = (selected_type == 16).then(|| {
        (observation.custom_x, observation.custom_y)
    });
    Some(DisplayScalingWrite {
        enabled: observation.enabled,
        scaling_type: selected_type,
        custom,
        hardware_mode_set: selected_type == 16,
    })
}

fn scaling_request_matches(observation: &DisplayScalingObservation, requested: &DisplayScalingWrite) -> bool {
    active_scaling_matches(observation, requested) || is_deferred(observation, requested)
}

fn active_scaling_matches(observation: &DisplayScalingObservation, requested: &DisplayScalingWrite) -> bool {
    valid_observation(observation)
        && observation.enabled == requested.enabled
        && observation.scaling_type == requested.scaling_type
        && (requested.scaling_type != 16
            || requested.custom == Some((observation.custom_x, observation.custom_y)))
}

fn preferred_scaling_matches(observation: &DisplayScalingObservation, requested: &DisplayScalingWrite) -> bool {
    observation.version == 1
        && requested.enabled
        && observation.enabled
        && requested.scaling_type != 16
        && observation.preferred_scaling_type == Some(requested.scaling_type)
}

fn is_deferred(observation: &DisplayScalingObservation, requested: &DisplayScalingWrite) -> bool {
    observation.version == 1
        && requested.enabled
        && observation.enabled
        && matches!(requested.scaling_type, 2 | 4 | 8)
        && observation.scaling_type == 1
        && observation.preferred_scaling_type == Some(requested.scaling_type)
}

fn scaling_restored(before: &DisplayScalingObservation, actual: &DisplayScalingObservation) -> bool {
    actual.enabled == before.enabled
        && actual.scaling_type == before.scaling_type
        && (before.scaling_type != 16
            || (actual.custom_x == before.custom_x && actual.custom_y == before.custom_y))
        && (before.version != 1
            || (actual.version == 1 && actual.preferred_scaling_type == before.preferred_scaling_type))
}

fn after_write_message(actual: &DisplayScalingObservation, requested: &DisplayScalingWrite) -> String {
    format!("display scaling read-back did not verify requested type {} (enabled={}, actual type={}, preferred={:?})",
        requested.scaling_type, requested.enabled, actual.scaling_type, actual.preferred_scaling_type)
}

fn verify_output(
    backend: &mut dyn DisplayScalingApplyBackend,
    target: &DisplayScalingTarget,
) -> Result<(), (&'static str, String)> {
    let outputs = backend.active_outputs(&target.device_key)
        .map_err(|error| ("io-failed", format!("active display identity read failed: {error}")))?;
    let matching: Vec<_> = outputs.iter().filter(|output| output.display_key == target.display_key).collect();
    match matching.as_slice() {
        [] => Err(("stale-target", "the selected display is no longer connected".into())),
        [output] if output.device_key == target.device_key && output.active && output.identity_verified => Ok(()),
        [_] => Err(("stale-target", "the selected display identity is not uniquely verified as active".into())),
        _ => Err(("ambiguous-target", "more than one active output has the selected stable display identity".into())),
    }
}

fn read_current(
    backend: &mut dyn DisplayScalingApplyBackend,
    target: &DisplayScalingTarget,
) -> Result<DisplayScalingObservation, (&'static str, String)> {
    verify_output(backend, target)?;
    let observation = backend.read_scaling(&target.device_key, &target.display_key)
        .map_err(|error| ("io-failed", format!("display scaling GET failed: {error}")))?;
    if !valid_observation(&observation) {
        return Err(("io-failed", "the driver returned an unknown or unsafe scaling state".into()));
    }
    Ok(observation)
}

fn failed(code: &'static str, message: impl Into<String>) -> DisplayScalingApplyResult {
    DisplayScalingApplyResult {
        ok: false, error_code: Some(code), message: Some(message.into()), read_back: None,
        read_back_equal: false, active_read_back_equal: false, preferred_read_back_equal: false,
        readback_reported: false, driver_apply_succeeded: false, setter_succeeded: None,
        requested_set: None,
        deferred: false, rollback_attempted: false,
        rollback_verified: false, state_may_have_changed: false, selection_saved: false,
        prior_state: None,
    }
}

fn succeeded(
    read_back: Option<DisplayScalingObservation>,
    prior_state: Option<DisplayScalingObservation>,
    read_back_equal: bool,
    deferred: bool,
    active_read_back_equal: bool,
    preferred_read_back_equal: bool,
) -> DisplayScalingApplyResult {
    DisplayScalingApplyResult {
        ok: true, error_code: None, message: None, read_back, read_back_equal,
        active_read_back_equal, preferred_read_back_equal, readback_reported: true,
        driver_apply_succeeded: true, setter_succeeded: Some(true), requested_set: Some(true),
        deferred,
        rollback_attempted: false, rollback_verified: false,
        state_may_have_changed: false, selection_saved: false, prior_state,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE_KEY: &str = "pci:gpu-a";
    const DISPLAY_KEY: &str = "pci:gpu-a|display|encoder-a|edid|abcd1234";
    const STATE_KEY: &str = "pci:gpu-a|display|encoder-a|edid|abcd1234";

    #[derive(Clone, Copy)]
    enum WriteBehavior { Exact, NoOp, Deferred, DeclineBeforeSet, FailAfterWrite, SetThenSessionError }

    #[derive(Clone, Copy)]
    enum RetroBehavior { Exact, DisableFails, DisableNoOp, RestoreFails }

    struct FakeOutput {
        identity: DisplayScalingOutputIdentity,
        observation: DisplayScalingObservation,
    }

    struct FakeBackend {
        outputs: Vec<FakeOutput>,
        writes: Vec<DisplayScalingWrite>,
        /// One entry per scaling SET in call order: `(scaling type, custom
        /// percentage pair, hardware-mode flag)`. It records the driver-visible
        /// modeset sequence, including initialization and rollback writes.
        set_order: Vec<(u32, Option<(u32, u32)>, bool)>,
        behavior: WriteBehavior,
        change_before_rollback: Option<DisplayScalingObservation>,
        change_after_first_write: Option<DisplayScalingObservation>,
        /// The first GET after a scaling SET fails, and the driver holds this
        /// tuple from then on (an external writer that does not honour the
        /// Display mutex, or a driver-side normalization).
        read_back_fails_to: Option<DisplayScalingObservation>,
        retro: RetroScalingObservation,
        retro_writes: Vec<RetroScalingWrite>,
        retro_behavior: RetroBehavior,
        retro_surface_available: bool,
        /// Cross-surface SET order: `retro` and `scaling` in call order.
        ops: Vec<&'static str>,
    }

    #[derive(Clone, Copy)]
    enum StoreBehavior { Commit, FailBeforeCommit, FailAfterCommit, ForeignCommit, ReadFailsAfterSave }

    struct FakeStore {
        state: Option<ScalingSelection>,
        behavior: StoreBehavior,
        save_count: usize,
        keys: Vec<String>,
        updates: Vec<SelectionUpdate>,
    }

    impl DisplayScalingSelectionStore for FakeStore {
        fn read_selection(&mut self, display_key: &str) -> Result<Option<ScalingSelection>, String> {
            self.keys.push(display_key.to_owned());
            if self.save_count > 0 && matches!(self.behavior, StoreBehavior::ReadFailsAfterSave) {
                return Err("simulated selector read-back failure".into());
            }
            Ok(self.state)
        }

        fn save_selection(&mut self, display_key: &str, update: &SelectionUpdate) -> Result<(), String> {
            self.keys.push(display_key.to_owned());
            self.updates.push(*update);
            self.save_count += 1;
            let next = selection_after_update(*update, self.state);
            match self.behavior {
                StoreBehavior::Commit => { self.state = Some(next); Ok(()) }
                StoreBehavior::FailBeforeCommit => Err("simulated atomic save failure".into()),
                StoreBehavior::FailAfterCommit => {
                    self.state = Some(next);
                    Err("simulated late save error after replacement".into())
                }
                StoreBehavior::ForeignCommit => {
                    self.state = Some(ScalingSelection {
                        identity_scaling: true, native_preferred_scaling_type: Some(8),
                        custom_x: Some(77), custom_y: Some(82),
                    });
                    Err("simulated concurrent selector edit".into())
                }
                StoreBehavior::ReadFailsAfterSave => { self.state = Some(next); Ok(()) }
            }
        }
    }

    fn selection_after_update(update: SelectionUpdate, previous: Option<ScalingSelection>) -> ScalingSelection {
        ScalingSelection {
            identity_scaling: update.identity_scaling,
            native_preferred_scaling_type: update.native_preferred_scaling_type,
            custom_x: update.custom.map(|(x, _)| x).or(previous.and_then(|selection| selection.custom_x)),
            custom_y: update.custom.map(|(_, y)| y).or(previous.and_then(|selection| selection.custom_y)),
        }
    }

    impl DisplayScalingApplyBackend for FakeBackend {
        fn active_outputs(&mut self, device_key: &str) -> Result<Vec<DisplayScalingOutputIdentity>, String> {
            Ok(self.outputs.iter().filter(|output| output.identity.device_key == device_key)
                .map(|output| output.identity.clone()).collect())
        }

        fn read_scaling(&mut self, device_key: &str, display_key: &str) -> Result<DisplayScalingObservation, String> {
            if self.writes.len() == 1 {
                if let Some(observation) = self.read_back_fails_to.take() {
                    if let Some(output) = self.outputs.first_mut() { output.observation = observation; }
                    return Err("simulated post-SET read-back GET failure".into());
                }
            }
            self.outputs.iter().find(|output| output.identity.device_key == device_key
                && output.identity.display_key == display_key && output.identity.active
                && output.identity.identity_verified)
                .map(|output| output.observation.clone())
                .ok_or_else(|| "fresh active output resolve failed".into())
        }

        fn set_scaling_if_current(
            &mut self,
            device_key: &str,
            display_key: &str,
            expected_current: &DisplayScalingObservation,
            requested: &DisplayScalingWrite,
        ) -> DisplayScalingWriteOutcome {
            if self.writes.len() == 1 {
                if let Some(observation) = self.change_before_rollback.take() {
                    if let Some(output) = self.outputs.first_mut() { output.observation = observation; }
                }
            }
            let matches = self.outputs.iter().filter(|output| output.identity.device_key == device_key
                && output.identity.display_key == display_key && output.identity.active
                && output.identity.identity_verified).count();
            if matches != 1 {
                return DisplayScalingWriteOutcome::NotAttempted("output identity is no longer unique".into());
            }
            let output = self.outputs.iter_mut().find(|output| output.identity.device_key == device_key
                && output.identity.display_key == display_key && output.identity.active
                && output.identity.identity_verified).expect("the unique active output remains present");
            if output.observation != *expected_current {
                return DisplayScalingWriteOutcome::NotAttempted("conditional scaling write guard changed".into());
            }
            if matches!(self.behavior, WriteBehavior::DeclineBeforeSet) {
                return DisplayScalingWriteOutcome::NotAttempted("fixture pre-write refusal".into());
            }
            let mut next = output.observation.clone();
            next.enabled = requested.enabled;
            next.scaling_type = requested.scaling_type;
            if let Some((x, y)) = requested.custom { next.custom_x = x; next.custom_y = y; }
            if next.version == 1 { next.preferred_scaling_type = Some(requested.scaling_type); }
            if matches!(self.behavior, WriteBehavior::Deferred)
                && requested.enabled && matches!(requested.scaling_type, 2 | 4 | 8)
            {
                next.scaling_type = 1;
                next.preferred_scaling_type = Some(requested.scaling_type);
            }
            self.writes.push(requested.clone());
            self.set_order.push((requested.scaling_type, requested.custom, requested.hardware_mode_set));
            self.ops.push("scaling");
            if matches!(self.behavior, WriteBehavior::NoOp) {
                return DisplayScalingWriteOutcome::Attempted {
                    setter_succeeded: true, result: Ok(()), error_code: None,
                };
            }
            output.observation = next;
            if self.writes.len() == 1 {
                if let Some(observation) = self.change_after_first_write.take() {
                    output.observation = observation;
                }
                if matches!(self.behavior, WriteBehavior::FailAfterWrite) {
                    return DisplayScalingWriteOutcome::Attempted {
                        setter_succeeded: false,
                        result: Err("simulated setter error after state changed".into()),
                        error_code: Some("io-failed"),
                    };
                }
                // The driver applied the SET, but the seam reports a failure
                // afterwards (the native backend's session-cleanup error).
                if matches!(self.behavior, WriteBehavior::SetThenSessionError) {
                    return DisplayScalingWriteOutcome::Attempted {
                        setter_succeeded: true,
                        result: Err("simulated session cleanup failure after the SET".into()),
                        error_code: Some("io-failed"),
                    };
                }
            }
            DisplayScalingWriteOutcome::Attempted {
                setter_succeeded: true, result: Ok(()), error_code: None,
            }
        }

        fn read_retro_scaling(&mut self, device_key: &str, display_key: &str) -> Result<Option<RetroScalingObservation>, String> {
            let matches = self.outputs.iter().filter(|output| output.identity.device_key == device_key
                && output.identity.display_key == display_key && output.identity.active
                && output.identity.identity_verified).count();
            if matches != 1 { return Err("fresh active output resolve failed".into()); }
            Ok(self.retro_surface_available.then_some(self.retro))
        }

        fn set_retro_scaling_if_current(
            &mut self,
            device_key: &str,
            display_key: &str,
            expected_current: RetroScalingObservation,
            requested: RetroScalingWrite,
        ) -> DisplayScalingWriteOutcome {
            let matches = self.outputs.iter().filter(|output| output.identity.device_key == device_key
                && output.identity.display_key == display_key && output.identity.active
                && output.identity.identity_verified).count();
            if matches != 1 {
                return DisplayScalingWriteOutcome::NotAttempted("output identity is no longer unique".into());
            }
            if !self.retro.same_effective_state(expected_current) {
                return DisplayScalingWriteOutcome::NotAttempted("conditional Retro Scaling write guard changed".into());
            }
            self.retro_writes.push(requested);
            self.ops.push("retro");
            match self.retro_behavior {
                RetroBehavior::DisableFails if !requested.enabled => DisplayScalingWriteOutcome::Attempted {
                    setter_succeeded: false,
                    result: Err("simulated coupled Retro disable failure".into()),
                    error_code: Some("io-failed"),
                },
                // The driver accepts the SET without changing its tuple.
                RetroBehavior::DisableNoOp if !requested.enabled => DisplayScalingWriteOutcome::Attempted {
                    setter_succeeded: true, result: Ok(()), error_code: None,
                },
                RetroBehavior::RestoreFails if requested.enabled => DisplayScalingWriteOutcome::Attempted {
                    setter_succeeded: false,
                    result: Err("simulated Retro restore failure".into()),
                    error_code: Some("io-failed"),
                },
                _ => {
                    self.retro = RetroScalingObservation {
                        enabled: requested.enabled,
                        method: requested.enabled.then_some(requested.method),
                    };
                    DisplayScalingWriteOutcome::Attempted {
                        setter_succeeded: true, result: Ok(()), error_code: None,
                    }
                }
            }
        }
    }

    fn observation() -> DisplayScalingObservation {
        DisplayScalingObservation {
            version: 1, enabled: true, scaling_type: 1, custom_x: 100,
            custom_y: 100, preferred_scaling_type: Some(1),
        }
    }

    fn request() -> (DisplayScalingTarget, DisplayScalingWrite) {
        (
            DisplayScalingTarget { device_key: DEVICE_KEY.into(), display_key: DISPLAY_KEY.into() },
            DisplayScalingWrite { enabled: true, scaling_type: 2, custom: None, hardware_mode_set: false },
        )
    }

    fn backend() -> FakeBackend {
        FakeBackend {
            outputs: vec![FakeOutput {
                identity: DisplayScalingOutputIdentity {
                    device_key: DEVICE_KEY.into(), display_key: DISPLAY_KEY.into(), active: true, identity_verified: true,
                },
                observation: observation(),
            }],
            writes: vec![], set_order: vec![], behavior: WriteBehavior::Exact,
            change_before_rollback: None, change_after_first_write: None,
            read_back_fails_to: None,
            retro: RetroScalingObservation { enabled: false, method: None },
            retro_writes: vec![], retro_behavior: RetroBehavior::Exact, retro_surface_available: true,
            ops: vec![],
        }
    }

    fn committed_store() -> FakeStore {
        FakeStore { state: None, behavior: StoreBehavior::Commit, save_count: 0, keys: vec![], updates: vec![] }
    }

    fn retro_enabled(method: RetroScalingMethod) -> RetroScalingObservation {
        RetroScalingObservation { enabled: true, method: Some(method) }
    }

    fn apply_mode(
        backend: &mut FakeBackend,
        store: &mut FakeStore,
        target: &DisplayScalingTarget,
        write: &DisplayScalingWrite,
        retro_disable: Option<RetroScalingMethod>,
    ) -> DisplayScalingModeApplyOutcome {
        let display_guard = super::super::display_lock::acquire()
            .expect("Display lock acquired for the scaling mode transaction test");
        apply_display_scaling_mode_with_store(
            &display_guard, backend, store, STATE_KEY, target, write, retro_disable,
        )
    }

    fn applied(outcome: DisplayScalingModeApplyOutcome) -> DisplayScalingModeApplyResult {
        match outcome {
            DisplayScalingModeApplyOutcome::Applied(result) => result,
            DisplayScalingModeApplyOutcome::Declined => panic!("the transaction declined before any SET"),
        }
    }

    #[test]
    fn coupling_disables_retro_before_the_ordinary_scaling_write() {
        let (target, write) = request();
        let mut backend = backend();
        backend.retro = retro_enabled(RetroScalingMethod::Integer);
        let mut store = committed_store();
        let result = applied(apply_mode(
            &mut backend, &mut store, &target, &write, Some(RetroScalingMethod::NearestNeighbour),
        ));
        assert!(result.scaling.ok && result.scaling.selection_saved);
        assert_eq!(result.retro_restore_ok, None);
        assert_eq!(backend.ops, vec!["retro", "scaling"],
            "the bundled Retro disable must run BEFORE the ordinary scaling write");
        assert_eq!(backend.retro_writes, vec![RetroScalingWrite {
            enabled: false, method: RetroScalingMethod::NearestNeighbour,
        }]);
        assert_eq!(backend.writes.len(), 1, "one ordinary scaling write for a single-control request");
        assert!(!backend.retro.enabled);
    }

    #[test]
    fn failed_ordinary_write_restores_the_previous_retro_state_once() {
        let (target, write) = request();
        let mut backend = backend();
        backend.retro = retro_enabled(RetroScalingMethod::Integer);
        backend.behavior = WriteBehavior::FailAfterWrite;
        let mut store = committed_store();
        let result = applied(apply_mode(
            &mut backend, &mut store, &target, &write, Some(RetroScalingMethod::NearestNeighbour),
        ));
        assert!(!result.scaling.ok);
        assert_eq!(result.retro_restore_ok, Some(true));
        assert_eq!(backend.ops, vec!["retro", "scaling", "scaling", "retro"]);
        let restores: Vec<_> = backend.retro_writes.iter().filter(|write| write.enabled).collect();
        assert_eq!(restores.len(), 1, "exactly one Retro restore SET");
        assert_eq!(restores[0].method, RetroScalingMethod::Integer);
        assert_eq!(backend.retro, retro_enabled(RetroScalingMethod::Integer));
        assert_eq!(backend.writes.len(), 2, "one ordinary set plus its conditional rollback, never a replay");
    }

    #[test]
    fn an_unverified_retro_restore_is_reported_without_replaying_the_scaling_write() {
        let (target, write) = request();
        let mut backend = backend();
        backend.retro = retro_enabled(RetroScalingMethod::Integer);
        backend.behavior = WriteBehavior::FailAfterWrite;
        backend.retro_behavior = RetroBehavior::RestoreFails;
        let mut store = committed_store();
        let result = applied(apply_mode(
            &mut backend, &mut store, &target, &write, Some(RetroScalingMethod::Integer),
        ));
        assert!(!result.scaling.ok);
        assert_eq!(result.retro_restore_ok, Some(false));
        assert_eq!(backend.retro_writes.len(), 2);
        assert_eq!(backend.writes.len(), 2);
        assert_eq!(backend.retro, RetroScalingObservation { enabled: false, method: None });
    }

    #[test]
    fn active_retro_without_a_bundled_disable_is_refused_before_any_write() {
        let (target, write) = request();
        let mut backend = backend();
        backend.retro = retro_enabled(RetroScalingMethod::Integer);
        let mut store = committed_store();
        let result = applied(apply_mode(&mut backend, &mut store, &target, &write, None));
        assert!(!result.scaling.ok);
        assert_eq!(result.scaling.error_code, Some("unsupported"));
        assert_eq!(result.scaling.message.as_deref(), Some(RETRO_SCALING_ACTIVE_REFUSAL));
        assert_eq!(result.retro_restore_ok, None);
        assert!(backend.writes.is_empty(), "the ordinary scaling write must not run");
        assert!(backend.retro_writes.is_empty(), "the refusal must not write Retro Scaling");
        assert!(backend.ops.is_empty());
        assert_eq!(backend.outputs[0].observation, observation());
    }

    #[test]
    fn active_retro_with_an_unknown_method_is_refused_even_with_a_disable_companion() {
        let (target, write) = request();
        let mut backend = backend();
        backend.retro = RetroScalingObservation { enabled: true, method: None };
        let mut store = committed_store();
        let result = applied(apply_mode(
            &mut backend, &mut store, &target, &write, Some(RetroScalingMethod::Integer),
        ));
        assert!(!result.scaling.ok);
        assert_eq!(result.scaling.message.as_deref(), Some(RETRO_SCALING_ACTIVE_REFUSAL));
        assert!(backend.writes.is_empty() && backend.retro_writes.is_empty() && backend.ops.is_empty());
    }

    #[test]
    fn a_failed_retro_disable_stops_before_the_ordinary_scaling_write() {
        let (target, write) = request();
        let mut backend = backend();
        backend.retro = retro_enabled(RetroScalingMethod::Integer);
        backend.retro_behavior = RetroBehavior::DisableFails;
        let mut store = committed_store();
        let result = applied(apply_mode(
            &mut backend, &mut store, &target, &write, Some(RetroScalingMethod::NearestNeighbour),
        ));
        assert!(!result.scaling.ok);
        assert_eq!(result.scaling.message.as_deref(), Some(RETRO_SCALING_NOT_DISABLED_MESSAGE));
        assert_eq!(result.retro_restore_ok, None);
        assert_eq!(backend.ops, vec!["retro"]);
        assert!(backend.writes.is_empty() && backend.outputs[0].observation == observation());
    }

    #[test]
    fn an_unverified_retro_disable_stops_before_the_ordinary_scaling_write() {
        let (target, write) = request();
        let mut backend = backend();
        backend.retro = retro_enabled(RetroScalingMethod::Integer);
        backend.retro_behavior = RetroBehavior::DisableNoOp;
        let mut store = committed_store();
        let result = applied(apply_mode(
            &mut backend, &mut store, &target, &write, Some(RetroScalingMethod::NearestNeighbour),
        ));
        assert!(!result.scaling.ok);
        assert_eq!(result.scaling.error_code, Some("io-failed"));
        assert_eq!(result.scaling.message.as_deref(), Some(RETRO_SCALING_NOT_DISABLED_MESSAGE));
        assert_eq!(backend.ops, vec!["retro"]);
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn a_disable_companion_for_an_already_disabled_retro_surface_is_left_to_the_broker() {
        let (target, write) = request();
        let mut backend = backend();
        let mut store = committed_store();
        let outcome = apply_mode(
            &mut backend, &mut store, &target, &write, Some(RetroScalingMethod::Integer),
        );
        assert_eq!(outcome, DisplayScalingModeApplyOutcome::Declined);
        assert!(backend.writes.is_empty() && backend.retro_writes.is_empty() && backend.ops.is_empty());
        assert_eq!(store.save_count, 0);
    }

    #[test]
    fn an_absent_retro_surface_does_not_block_an_ordinary_scaling_selection() {
        let (target, write) = request();
        let mut absent = backend();
        absent.retro_surface_available = false;
        let mut store = committed_store();
        let result = applied(apply_mode(&mut absent, &mut store, &target, &write, None));
        assert!(result.scaling.ok);
        assert_eq!(absent.ops, vec!["scaling"]);
        assert!(absent.retro_writes.is_empty());

        // A coupled exit on the same adapter keeps Electron's
        // unavailable-symbol semantics instead of inventing a disable.
        let mut absent_exit = backend();
        absent_exit.retro_surface_available = false;
        let mut store = committed_store();
        assert_eq!(
            apply_mode(&mut absent_exit, &mut store, &target, &write, Some(RetroScalingMethod::Integer)),
            DisplayScalingModeApplyOutcome::Declined,
        );
        assert!(absent_exit.writes.is_empty() && absent_exit.retro_writes.is_empty());
    }

    /// The renderer's Custom payload: the raw flag plus the remembered pair,
    /// always with `hardwareModeSet: true` (`graphics.ts:410-419`, `:2282`).
    fn custom_write(x: u32, y: u32) -> DisplayScalingWrite {
        DisplayScalingWrite {
            enabled: true, scaling_type: 16, custom: Some((x, y)), hardware_mode_set: true,
        }
    }

    #[test]
    fn a_custom_scaling_write_without_coordinates_is_refused_without_any_set() {
        let (target, _) = request();
        let pairless = DisplayScalingWrite {
            enabled: true, scaling_type: 16, custom: None, hardware_mode_set: true,
        };
        let mut backend = backend();
        let mut store = committed_store();
        let result = applied(apply_mode(&mut backend, &mut store, &target, &pairless, None));
        assert!(!result.scaling.ok);
        assert_eq!(result.scaling.error_code, Some("out-of-range"));
        assert!(backend.writes.is_empty() && backend.retro_writes.is_empty());
    }

    #[test]
    fn custom_entry_initializes_the_neutral_pair_before_the_remembered_pair() {
        let (target, _) = request();
        let mut backend = backend();
        let mut store = committed_store();
        let result = applied(apply_mode(&mut backend, &mut store, &target, &custom_write(80, 70), None));
        assert!(result.scaling.ok && result.scaling.selection_saved,
            "a first-time Custom entry must apply and commit its selector record");
        assert_eq!(backend.set_order, vec![
            (16, Some((100, 100)), true),
            (16, Some((80, 70)), true),
        ], "the neutral 100x100 initialization must precede the remembered pair");
        assert_eq!(result.scaling.setter_succeeded, Some(true));
        assert!(result.scaling.active_read_back_equal && !result.scaling.deferred);
        assert_eq!((backend.outputs[0].observation.custom_x, backend.outputs[0].observation.custom_y), (80, 70));
    }

    #[test]
    fn a_missing_neutral_read_back_never_writes_a_rollback() {
        let (target, _) = request();
        let mut backend = backend();
        // The neutral SET is accepted, our read-back GET fails, and an external
        // writer (IGS / Windows / a driver utility - none honour the Display
        // mutex) holds a different tuple by the next GET.
        let foreign = DisplayScalingObservation {
            version: 1, enabled: true, scaling_type: 4, custom_x: 100, custom_y: 100,
            preferred_scaling_type: Some(4),
        };
        backend.read_back_fails_to = Some(foreign.clone());
        let mut store = committed_store();
        let result = applied(apply_mode(&mut backend, &mut store, &target, &custom_write(80, 70), None));
        assert!(!result.scaling.ok);
        assert_eq!(backend.set_order, vec![(16, Some((100, 100)), true)],
            "a rollback must never write without a present witness");
        assert!(!result.scaling.rollback_attempted,
            "no rollback may be attempted when the initialization read-back is unavailable");
        assert!(!result.scaling.rollback_verified,
            "an absent witness must never be reported as a verified restoration");
        assert!(backend.writes.iter().all(|write| write.custom != Some((80, 70))),
            "the requested pair must not be attempted after a failed initialization");
        assert_eq!(backend.outputs[0].observation, foreign,
            "a state this transaction cannot attribute to itself must be left untouched");
        assert_eq!(store.save_count, 0);
        assert_eq!(result.scaling.error_code, Some("io-failed"));
        let message = result.scaling.message.as_deref().unwrap_or_default();
        assert!(message.contains("read-back"), "the failure must name the missing read-back: {message}");
        assert!(message.contains("no rollback was written"), "the failure must state the consequence: {message}");
    }

    #[test]
    fn a_rejected_neutral_initialization_never_writes_a_rollback() {
        let (target, _) = request();
        let mut backend = backend();
        // The initialization SET itself is rejected (Electron: `changed:false`,
        // no rollback write - igcl-display-scaling.js:134-141).
        backend.behavior = WriteBehavior::FailAfterWrite;
        let mut store = committed_store();
        let result = applied(apply_mode(&mut backend, &mut store, &target, &custom_write(80, 70), None));
        assert!(!result.scaling.ok);
        assert_eq!(result.scaling.setter_succeeded, Some(false));
        assert_eq!(backend.set_order, vec![(16, Some((100, 100)), true)],
            "a rejected initialization SET reports the failure without a rollback write");
        assert!(!result.scaling.rollback_attempted);
        assert!(backend.writes.iter().all(|write| write.custom != Some((80, 70))));
        assert_eq!(store.save_count, 0);
    }

    #[test]
    fn a_foreign_neutral_read_back_is_never_rolled_back() {
        let (target, _) = request();
        let mut backend = backend();
        // The neutral SET is accepted, but the read-back proves a tuple this
        // transaction never wrote: an external writer (IGS / Windows / a driver
        // utility) moved the mode to Centered before our GET.
        let foreign = DisplayScalingObservation {
            version: 1, enabled: true, scaling_type: 2, custom_x: 100, custom_y: 100,
            preferred_scaling_type: Some(2),
        };
        backend.change_after_first_write = Some(foreign.clone());
        let mut store = committed_store();
        let result = applied(apply_mode(&mut backend, &mut store, &target, &custom_write(80, 70), None));
        assert!(!result.scaling.ok && !result.scaling.selection_saved);
        assert_eq!(result.scaling.setter_succeeded, Some(true));
        assert_eq!(backend.set_order, vec![(16, Some((100, 100)), true)],
            "a read-back this transaction did not produce is never a rollback witness");
        assert!(!result.scaling.rollback_attempted,
            "no rollback may be attempted over a state this transaction did not set");
        assert!(!result.scaling.rollback_verified,
            "a foreign read-back must never be reported as a verified restoration");
        assert!(backend.writes.iter().all(|write| write.custom != Some((80, 70))),
            "the requested pair must not be attempted after a failed initialization");
        assert_eq!(backend.outputs[0].observation, foreign,
            "the external change must be left untouched");
        assert_eq!(store.save_count, 0);
        assert_eq!(result.scaling.error_code, Some("io-failed"));
        let message = result.scaling.message.as_deref().unwrap_or_default();
        assert!(message.contains("did not set"), "the failure must name the foreign state: {message}");
        assert!(message.contains("no rollback was written"), "the failure must state the consequence: {message}");
    }

    #[test]
    fn a_verified_neutral_witness_with_a_setter_error_still_rolls_back_once() {
        let (target, _) = request();
        let mut backend = backend();
        // The neutral SET is applied and its read-back proves OUR neutral tuple,
        // but the setter seam reports a failure afterwards (session cleanup).
        // That is the one state in which the initialization rollback is correct.
        backend.behavior = WriteBehavior::SetThenSessionError;
        let mut store = committed_store();
        let result = applied(apply_mode(&mut backend, &mut store, &target, &custom_write(80, 70), None));
        assert!(!result.scaling.ok && !result.scaling.selection_saved);
        assert!(result.scaling.rollback_attempted && result.scaling.rollback_verified,
            "a witness that equals the tuple we wrote still justifies the rollback");
        assert_eq!(backend.set_order, vec![
            (16, Some((100, 100)), true),
            (1, None, false),
        ], "exactly one rollback SET, and never the requested pair");
        assert!(backend.writes.iter().all(|write| write.custom != Some((80, 70))));
        assert_eq!(backend.outputs[0].observation, observation());
        assert_eq!(store.save_count, 0);
    }

    #[test]
    fn repeat_custom_entry_skips_the_neutral_initialization() {
        let (target, _) = request();
        let mut proven = backend();
        proven.outputs[0].observation = DisplayScalingObservation {
            version: 1, enabled: true, scaling_type: 16, custom_x: 80, custom_y: 70,
            preferred_scaling_type: Some(16),
        };
        let mut store = committed_store();
        let result = applied(apply_mode(&mut proven, &mut store, &target, &custom_write(80, 70), None));
        assert!(result.scaling.ok);
        assert_eq!(proven.set_order, vec![(16, Some((80, 70)), true)],
            "a driver that already proves the custom pair needs no redundant modeset");

        // An active but uninitialized pair (0/0) is not proof, so it still
        // takes the neutral initialization (igcl-display-scaling.js:126-127).
        let mut zeroed = backend();
        zeroed.outputs[0].observation = DisplayScalingObservation {
            version: 1, enabled: true, scaling_type: 16, custom_x: 0, custom_y: 0,
            preferred_scaling_type: Some(16),
        };
        let mut store = committed_store();
        let result = applied(apply_mode(&mut zeroed, &mut store, &target, &custom_write(80, 70), None));
        assert!(result.scaling.ok);
        assert_eq!(zeroed.set_order, vec![
            (16, Some((100, 100)), true),
            (16, Some((80, 70)), true),
        ], "zero coordinates are a valid range but never a proven custom pair");
    }

    #[test]
    fn a_neutral_custom_pair_is_its_own_initialization() {
        let (target, _) = request();
        let mut backend = backend();
        let mut store = committed_store();
        let result = applied(apply_mode(&mut backend, &mut store, &target, &custom_write(100, 100), None));
        assert!(result.scaling.ok);
        assert_eq!(backend.set_order, vec![(16, Some((100, 100)), true)],
            "the neutral pair must not be written twice");
    }

    #[test]
    fn custom_selector_commit_clears_identity_and_keeps_the_requested_pair() {
        let (target, _) = request();
        let prior = ScalingSelection {
            identity_scaling: true, native_preferred_scaling_type: Some(1),
            custom_x: Some(37), custom_y: Some(62),
        };
        let mut backend = backend();
        let mut store = FakeStore {
            state: Some(prior), behavior: StoreBehavior::Commit, save_count: 0,
            keys: vec![], updates: vec![],
        };
        let result = apply_with_store(&mut backend, &mut store, &target, &custom_write(80, 70));
        assert!(result.ok && result.selection_saved);
        assert_eq!(store.state, Some(ScalingSelection {
            identity_scaling: false, native_preferred_scaling_type: Some(16),
            custom_x: Some(80), custom_y: Some(70),
        }), "the per-display schema keeps the whole record and adopts the requested pair");
        assert_eq!(store.updates, vec![SelectionUpdate {
            identity_scaling: false, native_preferred_scaling_type: Some(16),
            custom: Some((80, 70)),
        }]);
        assert!(store.keys.iter().all(|key| key == STATE_KEY));
    }

    fn apply(backend: &mut FakeBackend, target: &DisplayScalingTarget, write: &DisplayScalingWrite) -> DisplayScalingApplyResult {
        let display_guard = super::super::display_lock::acquire().expect("Display lock acquired for scaling transaction test");
        apply_display_scaling(&display_guard, backend, target, write)
    }

    fn apply_with_store(
        backend: &mut FakeBackend,
        store: &mut FakeStore,
        target: &DisplayScalingTarget,
        write: &DisplayScalingWrite,
    ) -> DisplayScalingApplyResult {
        let display_guard = super::super::display_lock::acquire().expect("Display lock acquired for selector transaction test");
        apply_display_scaling_with_store(&display_guard, backend, store, STATE_KEY, target, write)
    }

    #[test]
    fn requires_one_verified_active_stable_output_and_valid_request() {
        let (target, write) = request();
        let mut duplicate = backend();
        duplicate.outputs.push(FakeOutput {
            identity: duplicate.outputs[0].identity.clone(), observation: observation(),
        });
        let result = apply(&mut duplicate, &target, &write);
        assert_eq!(result.error_code, Some("ambiguous-target"));
        assert!(duplicate.writes.is_empty());

        let mut unverified = backend();
        unverified.outputs[0].identity.identity_verified = false;
        let result = apply(&mut unverified, &target, &write);
        assert_eq!(result.error_code, Some("stale-target"));
        assert!(unverified.writes.is_empty());

        let mut invalid = backend();
        let mut bad = write.clone();
        bad.scaling_type = 16;
        bad.custom = Some((101, 100));
        bad.hardware_mode_set = true;
        let result = apply(&mut invalid, &target, &bad);
        assert_eq!(result.error_code, Some("out-of-range"));
        assert!(invalid.writes.is_empty());
    }

    #[test]
    fn verifies_active_and_driver_deferred_preferred_scaling() {
        let (target, write) = request();
        let mut active = backend();
        let result = apply(&mut active, &target, &write);
        assert!(result.ok && result.read_back_equal && !result.deferred);
        assert_eq!(active.writes.len(), 1);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(result.readback_reported && result.driver_apply_succeeded);

        let mut deferred = backend();
        deferred.behavior = WriteBehavior::Deferred;
        let result = apply(&mut deferred, &target, &write);
        assert!(result.ok && result.read_back_equal && result.deferred);
        assert!(!result.active_read_back_equal && result.preferred_read_back_equal);
        assert_eq!(result.read_back.unwrap().scaling_type, 1);
        assert_eq!(deferred.writes.len(), 1);
    }

    #[test]
    fn already_active_scaling_mode_still_calls_set_and_reads_back() {
        let (target, _) = request();
        let mut backend = backend();
        let same_mode = DisplayScalingWrite {
            enabled: true, scaling_type: 1, custom: None, hardware_mode_set: false,
        };
        let result = apply(&mut backend, &target, &same_mode);
        assert!(result.ok && result.active_read_back_equal);
        assert_eq!(result.setter_succeeded, Some(true));
        assert_eq!(backend.writes, vec![same_mode]);
    }

    #[test]
    fn prewrite_decline_is_the_only_scaling_result_open_to_broker_retry() {
        let (target, write) = request();
        let mut backend = backend();
        backend.behavior = WriteBehavior::DeclineBeforeSet;
        let result = apply(&mut backend, &target, &write);
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, None);
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn successful_set_with_unchanged_readback_reports_silent_noop() {
        let (target, write) = request();
        let mut backend = backend();
        backend.behavior = WriteBehavior::NoOp;
        let result = apply(&mut backend, &target, &write);
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(result.readback_reported);
        assert!(!result.driver_apply_succeeded);
        assert!(!result.active_read_back_equal);
    }

    #[test]
    fn failed_setter_rolls_back_and_verifies_the_original_scaling_state() {
        let (target, write) = request();
        let mut backend = backend();
        backend.behavior = WriteBehavior::FailAfterWrite;
        let result = apply(&mut backend, &target, &write);
        assert_eq!(result.error_code, Some("io-failed"));
        assert!(result.rollback_attempted && result.rollback_verified);
        assert_eq!(backend.writes.len(), 2);
        assert_eq!(backend.outputs[0].observation, observation());
    }

    #[test]
    fn never_rolls_back_a_concurrent_scaling_change() {
        let (target, write) = request();
        let external = DisplayScalingObservation { scaling_type: 4, preferred_scaling_type: Some(4), ..observation() };
        let mut after_write = backend();
        after_write.change_after_first_write = Some(external.clone());
        let result = apply(&mut after_write, &target, &write);
        assert!(!result.rollback_attempted && result.state_may_have_changed);
        assert_eq!(after_write.writes.len(), 1);
        assert_eq!(after_write.outputs[0].observation, external);

        let mut before_rollback = backend();
        before_rollback.behavior = WriteBehavior::FailAfterWrite;
        before_rollback.change_before_rollback = Some(external.clone());
        let result = apply(&mut before_rollback, &target, &write);
        assert!(result.rollback_attempted && !result.rollback_verified);
        assert_eq!(before_rollback.writes.len(), 1, "conditional setter rejects a changed state");
        assert_eq!(before_rollback.outputs[0].observation, external);
    }

    #[test]
    fn restores_legacy_version_zero_without_inventing_a_preferred_field() {
        let (target, write) = request();
        let mut backend = backend();
        backend.outputs[0].observation = DisplayScalingObservation {
            version: 0, enabled: true, scaling_type: 1, custom_x: 100, custom_y: 100,
            preferred_scaling_type: None,
        };
        backend.behavior = WriteBehavior::FailAfterWrite;
        let result = apply(&mut backend, &target, &write);
        assert!(result.rollback_attempted && result.rollback_verified);
        assert_eq!(backend.outputs[0].observation.version, 0);
        assert_eq!(backend.outputs[0].observation.scaling_type, 1);
        assert_eq!(backend.outputs[0].observation.preferred_scaling_type, None);
    }

    #[test]
    fn refuses_to_apply_when_dormant_custom_preference_has_no_proven_restore_coordinates() {
        let (target, write) = request();
        let mut backend = backend();
        backend.outputs[0].observation.preferred_scaling_type = Some(16);
        let result = apply(&mut backend, &target, &write);
        assert_eq!(result.error_code, Some("io-failed"));
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn selector_commit_preserves_the_per_display_schema_and_custom_pair() {
        let (target, write) = request();
        let prior = ScalingSelection {
            identity_scaling: true, native_preferred_scaling_type: Some(1),
            custom_x: Some(37), custom_y: Some(62),
        };
        let mut backend = backend();
        let mut store = FakeStore {
            state: Some(prior), behavior: StoreBehavior::Commit, save_count: 0,
            keys: vec![], updates: vec![],
        };
        let result = apply_with_store(&mut backend, &mut store, &target, &write);
        assert!(result.ok && result.selection_saved);
        assert_eq!(store.state, Some(ScalingSelection {
            identity_scaling: false, native_preferred_scaling_type: Some(2),
            custom_x: Some(37), custom_y: Some(62),
        }));
        assert_eq!(store.updates, vec![SelectionUpdate {
            identity_scaling: false, native_preferred_scaling_type: Some(2), custom: None,
        }]);
        assert!(store.keys.iter().all(|key| key == STATE_KEY));
    }

    #[test]
    fn selector_save_failure_restores_driver_when_the_prior_record_is_still_present() {
        let (target, write) = request();
        let mut backend = backend();
        let mut store = FakeStore {
            state: None, behavior: StoreBehavior::FailBeforeCommit, save_count: 0,
            keys: vec![], updates: vec![],
        };
        let result = apply_with_store(&mut backend, &mut store, &target, &write);
        assert!(!result.ok && !result.selection_saved);
        assert_eq!(result.error_code, Some("io-failed"));
        assert!(result.rollback_attempted && result.rollback_verified);
        assert_eq!(backend.writes.len(), 2);
        assert_eq!(backend.outputs[0].observation, observation());
        assert_eq!(store.state, None);
    }

    #[test]
    fn selector_readback_accepts_a_late_save_error_only_when_new_record_matches() {
        let (target, write) = request();
        let mut backend = backend();
        let mut store = FakeStore {
            state: None, behavior: StoreBehavior::FailAfterCommit, save_count: 0,
            keys: vec![], updates: vec![],
        };
        let result = apply_with_store(&mut backend, &mut store, &target, &write);
        assert!(result.ok && result.selection_saved);
        assert!(result.message.as_deref().unwrap_or_default().contains("matching durable record was verified"));
        assert_eq!(store.state, Some(ScalingSelection {
            identity_scaling: false, native_preferred_scaling_type: Some(2), custom_x: None, custom_y: None,
        }));
        assert_eq!(backend.writes.len(), 1, "a verified durable commit keeps the matching driver mode");
    }

    #[test]
    fn uncertain_or_foreign_selector_state_is_not_overwritten_or_compensated() {
        let (target, write) = request();
        let mut foreign_backend = backend();
        let mut store = FakeStore {
            state: None, behavior: StoreBehavior::ForeignCommit, save_count: 0,
            keys: vec![], updates: vec![],
        };
        let result = apply_with_store(&mut foreign_backend, &mut store, &target, &write);
        assert!(!result.ok && !result.selection_saved);
        assert_eq!(result.error_code, Some("cleanup-pending"));
        assert!(result.state_may_have_changed);
        assert!(!result.rollback_attempted);
        assert_eq!(foreign_backend.writes.len(), 1);
        assert_eq!(store.state, Some(ScalingSelection {
            identity_scaling: true, native_preferred_scaling_type: Some(8),
            custom_x: Some(77), custom_y: Some(82),
        }));

        let mut unreadable_backend = backend();
        let mut unreadable_store = FakeStore {
            state: None, behavior: StoreBehavior::ReadFailsAfterSave, save_count: 0,
            keys: vec![], updates: vec![],
        };
        let result = apply_with_store(&mut unreadable_backend, &mut unreadable_store, &target, &write);
        assert_eq!(result.error_code, Some("cleanup-pending"));
        assert!(!result.rollback_attempted);
        assert_eq!(unreadable_backend.writes.len(), 1);
    }

    #[test]
    fn selector_failure_compensation_still_respects_a_concurrent_driver_change() {
        let (target, write) = request();
        let external = DisplayScalingObservation { scaling_type: 4, preferred_scaling_type: Some(4), ..observation() };
        let mut backend = backend();
        backend.change_before_rollback = Some(external.clone());
        let mut store = FakeStore {
            state: None, behavior: StoreBehavior::FailBeforeCommit, save_count: 0,
            keys: vec![], updates: vec![],
        };
        let result = apply_with_store(&mut backend, &mut store, &target, &write);
        assert_eq!(result.error_code, Some("cleanup-pending"));
        assert!(result.rollback_attempted && !result.rollback_verified);
        assert_eq!(backend.writes.len(), 1);
        assert_eq!(backend.outputs[0].observation, external);
        assert_eq!(store.state, None);
    }
}
