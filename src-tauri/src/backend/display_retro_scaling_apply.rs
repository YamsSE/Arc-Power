//! Private guarded transaction for adapter-level Retro Scaling (`scalingMethod`).
//!
//! This slice is staged only: it reopens the selected adapter by physical
//! identity, proves the selected output is uniquely active, verifies the
//! driver's capability and read-back, and conditionally restores only a value
//! observed to be written by this transaction. It has no service route.

use super::{
    display_apply::{self, DisplayApplyTarget, DisplayOutputIdentity},
    gpu_apply_identity::{self, ApplyIdentity},
    gpu_capabilities,
    gpu_devices,
    igcl_read_only::ReadOnlyIgcl,
};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};

static DISPLAY_RETRO_SCALING_GATE: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum RetroScalingMethod {
    Integer,
    NearestNeighbour,
}

impl RetroScalingMethod {
    pub(crate) fn igcl(self) -> u32 {
        match self { Self::Integer => 1, Self::NearestNeighbour => 2 }
    }

    fn from_igcl(value: u32) -> Option<Self> {
        match value { 1 => Some(Self::Integer), 2 => Some(Self::NearestNeighbour), _ => None }
    }

    fn supported_flag(self) -> u32 { 1 << (self.igcl() - 1) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RetroScalingWrite {
    pub(crate) enabled: bool,
    pub(crate) method: RetroScalingMethod,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct RetroScalingObservation {
    pub(crate) enabled: bool,
    /// Disabled drivers may normalize this field to zero.
    pub(crate) method: Option<RetroScalingMethod>,
}

impl RetroScalingObservation {
    pub(crate) fn from_driver(enabled: u8, method: u32) -> Result<Self, String> {
        if enabled > 1 { return Err("the driver returned an invalid Retro Scaling enabled flag".into()); }
        let enabled = enabled != 0;
        let method = RetroScalingMethod::from_igcl(method);
        if enabled && method.is_none() {
            return Err("the driver returned an unknown enabled Retro Scaling method".into());
        }
        Ok(Self { enabled, method })
    }

    /// The requested write is fully described by the observed tuple.
    pub(crate) fn matches_write(self, requested: RetroScalingWrite) -> bool {
        self.enabled == requested.enabled
            && (!requested.enabled || self.method == Some(requested.method))
    }

    /// Disabled drivers normalize the method to zero, so a disabled tuple is
    /// compared by its enable flag only.
    pub(crate) fn same_effective_state(self, other: Self) -> bool {
        self.enabled == other.enabled && (!self.enabled || self.method == other.method)
    }

    pub(crate) fn restore_write(self, disabled_method: RetroScalingMethod) -> RetroScalingWrite {
        RetroScalingWrite {
            enabled: self.enabled,
            method: self.method.unwrap_or(disabled_method),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RetroScalingApplyResult {
    pub(crate) ok: bool,
    pub(crate) error_code: Option<&'static str>,
    pub(crate) message: Option<String>,
    pub(crate) read_back: Option<RetroScalingObservation>,
    pub(crate) read_back_equal: bool,
    /// Mirrors Electron's post-SET signal: SUCCESS from SET with an
    /// unconfirmed or mismatched GET is reported as a silent no-op.
    pub(crate) silent_noop: Option<bool>,
    pub(crate) rollback_attempted: bool,
    pub(crate) rollback_verified: bool,
    pub(crate) state_may_have_changed: bool,
}

impl RetroScalingApplyResult {
    fn success(read_back: RetroScalingObservation) -> Self {
        Self { ok: true, error_code: None, message: None, read_back: Some(read_back),
            read_back_equal: true, silent_noop: None, rollback_attempted: false, rollback_verified: false,
            state_may_have_changed: false }
    }

    fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self { ok: false, error_code: Some(code), message: Some(message.into()), read_back: None,
            read_back_equal: false, silent_noop: None, rollback_attempted: false, rollback_verified: false,
            state_may_have_changed: false }
    }
}

/// Every method resolves the current adapter and output again. In particular,
/// `set_if_current` compares the complete enabled/method state immediately
/// before issuing the adapter-level IGCL setter.
pub(crate) trait RetroScalingApplyBackend {
    fn assert_device_target(
        &mut self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
    ) -> Result<(), String>;

    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String>;
    fn supported_methods(&mut self, expected_device_key: &str, display_key: &str) -> Result<Option<u32>, String>;
    fn read_mode(&mut self, expected_device_key: &str, display_key: &str) -> Result<RetroScalingObservation, String>;
    fn set_if_current(
        &mut self,
        expected_device_key: &str,
        display_key: &str,
        expected_current: RetroScalingObservation,
        requested: RetroScalingWrite,
    ) -> Result<(), String>;
}

/// Apply one adapter-level Retro Scaling selection while the caller owns the
/// shared Display lock. The selected display remains part of the guard even
/// though IGCL applies Retro Scaling through the adapter handle.
pub(crate) fn apply_retro_scaling(
    display_guard: &super::display_lock::DisplayLockGuard,
    backend: &mut dyn RetroScalingApplyBackend,
    target: &DisplayApplyTarget<'_>,
    requested: RetroScalingWrite,
) -> RetroScalingApplyResult {
    apply_retro_scaling_with_guard_state(display_guard.is_held(), backend, target, requested)
}

fn apply_retro_scaling_with_guard_state(
    display_guard_held: bool,
    backend: &mut dyn RetroScalingApplyBackend,
    target: &DisplayApplyTarget<'_>,
    requested: RetroScalingWrite,
) -> RetroScalingApplyResult {
    if !display_guard_held {
        return RetroScalingApplyResult::failed(
            "io-failed", "Retro Scaling requires the shared Display transaction lock",
        );
    }
    let _local_guard = DISPLAY_RETRO_SCALING_GATE.get_or_init(|| Mutex::new(()))
        .lock().unwrap_or_else(std::sync::PoisonError::into_inner);

    if target.device_key.trim().is_empty() || target.display_key.trim().is_empty()
        || !target.physical_target.is_object()
        || !display_apply::display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return RetroScalingApplyResult::failed(
            "stale-target", "Retro Scaling requires matching stable adapter and display identities",
        );
    }

    if let Err((code, message)) = ensure_target(backend, target) {
        return RetroScalingApplyResult::failed(code, message);
    }
    let Some(supported) = (match backend.supported_methods(target.device_key, target.display_key) {
        Ok(value) => value,
        Err(error) => return RetroScalingApplyResult::failed("io-failed", format!("Retro Scaling capability read failed: {error}")),
    }) else {
        return RetroScalingApplyResult::failed("unsupported", "the driver does not expose Retro Scaling capabilities");
    };
    if requested.enabled && supported & requested.method.supported_flag() == 0 {
        return RetroScalingApplyResult::failed("unsupported", "the requested Retro Scaling method is not advertised by this driver");
    }

    let before = match backend.read_mode(target.device_key, target.display_key) {
        Ok(value) => value,
        Err(error) => return RetroScalingApplyResult::failed("io-failed", format!("Retro Scaling read failed: {error}")),
    };
    if before.matches_write(requested) { return RetroScalingApplyResult::success(before); }

    if let Err((code, message)) = ensure_target(backend, target) {
        let mut result = RetroScalingApplyResult::failed(code, message);
        result.read_back = Some(before);
        return result;
    }
    let current = match backend.read_mode(target.device_key, target.display_key) {
        Ok(value) => value,
        Err(error) => return RetroScalingApplyResult::failed("io-failed", format!("Retro Scaling pre-write read failed: {error}")),
    };
    if current.matches_write(requested) { return RetroScalingApplyResult::success(current); }

    if let Err((code, message)) = ensure_target(backend, target) {
        let mut result = RetroScalingApplyResult::failed(code, message);
        result.read_back = Some(current);
        return result;
    }
    let set_result = backend.set_if_current(target.device_key, target.display_key, current, requested);
    let set_succeeded = set_result.is_ok();

    if let Err((code, message)) = ensure_target(backend, target) {
        let mut result = RetroScalingApplyResult::failed(code, message);
        result.read_back = None;
        result.silent_noop = set_succeeded.then_some(true);
        result.state_may_have_changed = true;
        return result;
    }
    let read_back = match backend.read_mode(target.device_key, target.display_key) {
        Ok(value) => value,
        Err(error) => {
            let mut result = RetroScalingApplyResult::failed("io-failed", format!(
                "Retro Scaling setter {} but read-back failed: {error}",
                if set_succeeded { "succeeded" } else { "failed" },
            ));
            result.silent_noop = set_succeeded.then_some(true);
            result.state_may_have_changed = true;
            return result;
        }
    };
    let read_back_equal = read_back.matches_write(requested);
    if set_result.is_ok() && read_back_equal {
        let mut result = RetroScalingApplyResult::success(read_back);
        result.silent_noop = Some(false);
        return result;
    }
    let silent_noop = set_succeeded.then_some(!read_back_equal);

    let primary_message = match set_result {
        Err(error) => format!("Retro Scaling setter failed: {error}"),
        Ok(()) => format!("Retro Scaling read-back {read_back:?} does not match the request {requested:?}"),
    };
    if read_back.same_effective_state(current) {
        let mut result = RetroScalingApplyResult::failed("io-failed", primary_message);
        result.read_back = Some(read_back);
        result.silent_noop = silent_noop;
        return result;
    }
    if !read_back_equal {
        let mut result = RetroScalingApplyResult::failed("io-failed", format!(
            "{primary_message}; current state may belong to another writer, so no rollback was written"));
        result.read_back = Some(read_back);
        result.silent_noop = silent_noop;
        result.state_may_have_changed = true;
        return result;
    }

    let rollback = current.restore_write(requested.method);
    if let Err((_, message)) = ensure_target(backend, target) {
        let mut result = RetroScalingApplyResult::failed("io-failed", format!(
            "{primary_message}; rollback skipped because target verification failed: {message}"));
        result.read_back = Some(read_back);
        result.state_may_have_changed = true;
        return result;
    }
    let before_rollback = match backend.read_mode(target.device_key, target.display_key) {
        Ok(value) if value.matches_write(requested) => value,
        Ok(value) => {
            let mut result = RetroScalingApplyResult::failed("io-failed", format!(
                "{primary_message}; Retro Scaling changed before rollback, so no rollback was written"));
            result.read_back = Some(value);
            result.state_may_have_changed = true;
            return result;
        }
        Err(error) => {
            let mut result = RetroScalingApplyResult::failed("io-failed", format!(
                "{primary_message}; current state could not be verified before rollback: {error}"));
            result.read_back = Some(read_back);
            result.state_may_have_changed = true;
            return result;
        }
    };
    if let Err((_, message)) = ensure_target(backend, target) {
        let mut result = RetroScalingApplyResult::failed("io-failed", format!(
            "{primary_message}; rollback skipped because target verification failed: {message}"));
        result.read_back = Some(before_rollback);
        result.state_may_have_changed = true;
        return result;
    }
    let rollback_result = backend.set_if_current(target.device_key, target.display_key, before_rollback, rollback);
    let mut result = RetroScalingApplyResult::failed("io-failed", primary_message);
    result.read_back_equal = read_back_equal;
    result.silent_noop = silent_noop;
    result.rollback_attempted = true;
    if let Err((_, error)) = ensure_target(backend, target) {
        result.message = Some(format!("{}; rollback verification failed: {error}", result.message.unwrap_or_default()));
        result.state_may_have_changed = true;
        return result;
    }
    match backend.read_mode(target.device_key, target.display_key) {
        Ok(actual) => {
            result.rollback_verified = actual.same_effective_state(current);
            result.read_back = Some(actual);
            result.state_may_have_changed = !result.rollback_verified;
            if result.rollback_verified && rollback_result.is_err() {
                result.message = Some(format!("{}; prior Retro Scaling state is verified despite rollback setter error: {}",
                    result.message.unwrap_or_default(), rollback_result.unwrap_err()));
            }
        }
        Err(error) => {
            result.message = Some(format!("{}; rollback verification failed: {error}", result.message.unwrap_or_default()));
            result.state_may_have_changed = true;
        }
    }
    result
}

fn ensure_target(
    backend: &mut dyn RetroScalingApplyBackend,
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

struct NativeRetroScalingBackend<'guard> {
    display_guard: &'guard super::display_lock::DisplayLockGuard,
    dll_path: PathBuf,
    identity: ApplyIdentity,
    selected_device_key: String,
    device_id: u64,
}

impl NativeRetroScalingBackend<'_> {
    fn with_adapter<T>(
        &self,
        expected_device_key: &str,
        operation: impl FnOnce(&mut ReadOnlyIgcl, usize) -> Result<T, String>,
    ) -> Result<T, String> {
        if !self.display_guard.is_held() {
            return Err("the shared Display transaction lock is no longer held".into());
        }
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

    fn with_output<T>(
        &self,
        expected_device_key: &str,
        display_key: &str,
        operation: impl FnOnce(&mut ReadOnlyIgcl, usize, *mut std::ffi::c_void) -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_adapter(expected_device_key, |session, index| {
            let _output = display_apply::resolve_display_handle(session, index, expected_device_key, display_key)?;
            let adapter = session.display_adapter_handle(index)
                .ok_or_else(|| "the selected IGCL adapter handle is unavailable".to_owned())?;
            operation(session, index, adapter)
        })
    }
}

impl RetroScalingApplyBackend for NativeRetroScalingBackend<'_> {
    fn assert_device_target(
        &mut self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
    ) -> Result<(), String> {
        if device_id != self.device_id { return Err("the selected graphics adapter ordinal changed".into()); }
        let normalized = display_apply::normalize_physical_target(expected_device_key, physical_target)?;
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

    fn supported_methods(&mut self, expected_device_key: &str, display_key: &str) -> Result<Option<u32>, String> {
        self.with_output(expected_device_key, display_key, |session, _, adapter| {
            Ok(session.display_retro_scaling_caps(adapter).map(|caps| caps.SupportedRetroScaling))
        })
    }

    fn read_mode(&mut self, expected_device_key: &str, display_key: &str) -> Result<RetroScalingObservation, String> {
        self.with_output(expected_device_key, display_key, |session, _, adapter| {
            let value = session.display_retro_scaling(adapter)
                .ok_or_else(|| "ctlGetSetRetroScaling GET failed".to_owned())?;
            RetroScalingObservation::from_driver(value.Enable, value.RetroScalingType)
        })
    }

    fn set_if_current(
        &mut self,
        expected_device_key: &str,
        display_key: &str,
        expected_current: RetroScalingObservation,
        requested: RetroScalingWrite,
    ) -> Result<(), String> {
        self.with_output(expected_device_key, display_key, |session, _, adapter| {
            let current = session.display_retro_scaling(adapter)
                .ok_or_else(|| "ctlGetSetRetroScaling pre-write GET failed".to_owned())?;
            let current = RetroScalingObservation::from_driver(current.Enable, current.RetroScalingType)?;
            if !current.same_effective_state(expected_current) {
                return Err("Retro Scaling state changed before the guarded setter".into());
            }
            let caps = session.display_retro_scaling_caps(adapter)
                .ok_or_else(|| "ctlGetSupportedRetroScalingCapability GET failed".to_owned())?;
            if requested.enabled && caps.SupportedRetroScaling & requested.method.supported_flag() == 0 {
                return Err("the requested Retro Scaling method is no longer supported".into());
            }
            let set_result = session.display_apply_api()
                .set_retro_scaling(adapter, requested.enabled, requested.method.igcl())
                .map_err(|error| error.to_string());
            // Electron waits for the driver transition after calling this
            // API. Wait on error too because a failed status does not prove
            // that no partial display change occurred.
            thread::sleep(Duration::from_millis(400));
            set_result
        })
    }
}

/// Identity-bound production entry point for a future native service caller.
/// It requires the caller-held Display lock and verifies the ordinal, key,
/// physical proof, current active output, and reopened adapter before SET.
/// The service route remains closed pending whole-response Display parity.
pub(crate) fn apply_retro_scaling_native(
    display_guard: &super::display_lock::DisplayLockGuard,
    target: &DisplayApplyTarget<'_>,
    requested: RetroScalingWrite,
) -> RetroScalingApplyResult {
    // This check precedes DLL lookup and the fresh device enumeration below.
    if !display_guard.is_held() {
        return RetroScalingApplyResult::failed(
            "io-failed", "Retro Scaling requires the shared Display transaction lock",
        );
    }
    if target.device_key.trim().is_empty() || target.display_key.trim().is_empty()
        || !display_apply::display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return RetroScalingApplyResult::failed("stale-target", "Retro Scaling requires matching stable adapter and display identities");
    }
    let Some(dll_path) = super::display_igcl_dll::locate_dll() else {
        return RetroScalingApplyResult::failed("io-failed", "The trusted Intel display runtime is unavailable.");
    };
    let inventory = match gpu_devices::list_devices(&dll_path) {
        Ok(value) => value,
        Err(error) => return RetroScalingApplyResult::failed("stale-target", format!("native GPU identity refresh failed: {error}")),
    };
    let Some(rows) = inventory.as_array() else {
        return RetroScalingApplyResult::failed("stale-target", "native GPU inventory is unavailable");
    };
    let matches: Vec<_> = rows.iter().enumerate().filter(|(_, row)| {
        row["id"].as_u64() == Some(target.device_id)
            && row["deviceKey"].as_str() == Some(target.device_key)
            && row["synthetic"].as_bool() != Some(true)
            && row["backendKind"].as_str() != Some("os")
    }).collect();
    let [(selected_index, selected_row)] = matches.as_slice() else {
        return RetroScalingApplyResult::failed("stale-target", "the selected graphics adapter ordinal or identity changed");
    };
    let normalized = match display_apply::normalize_physical_target_from_inventory(
        target.device_key, target.physical_target, *selected_index, rows,
    ) {
        Ok(row) => row,
        Err(error) => return RetroScalingApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    let identity = match gpu_apply_identity::identity_from_row(&normalized) {
        Ok(identity) => identity,
        Err(error) => return RetroScalingApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    let selected_identity = match gpu_apply_identity::identity_from_row(selected_row) {
        Ok(identity) => identity,
        Err(error) => return RetroScalingApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    if let Err(error) = gpu_apply_identity::ensure_same_target(&identity, &selected_identity) {
        return RetroScalingApplyResult::failed("stale-target", error);
    }
    let mut backend = NativeRetroScalingBackend {
        display_guard,
        dll_path,
        identity,
        selected_device_key: target.device_key.to_owned(),
        device_id: target.device_id,
    };
    apply_retro_scaling(display_guard, &mut backend, target, requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::OnceLock;

    const DEVICE_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0";
    const DISPLAY_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0|display|encoder-a|edid|abcd1234";
    const ALL_METHODS: u32 = 0b11;

    #[derive(Clone, Copy)]
    enum WriteBehavior { Exact, NoOp, FailAfterWrite, ThirdValue }

    struct FakeBackend {
        identity_ok: bool,
        outputs: Vec<DisplayOutputIdentity>,
        supported: Option<u32>,
        current: RetroScalingObservation,
        writes: Vec<RetroScalingWrite>,
        behavior: WriteBehavior,
        reads: usize,
        read_error_at: Option<usize>,
        identity_checks: usize,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                identity_ok: true,
                outputs: vec![DisplayOutputIdentity { display_key: DISPLAY_KEY.into(), active: true, identity_verified: true }],
                supported: Some(ALL_METHODS),
                current: RetroScalingObservation { enabled: false, method: None },
                writes: Vec::new(),
                behavior: WriteBehavior::Exact,
                reads: 0,
                read_error_at: None,
                identity_checks: 0,
            }
        }
    }

    impl RetroScalingApplyBackend for FakeBackend {
        fn assert_device_target(&mut self, id: u64, key: &str, proof: &Value) -> Result<(), String> {
            self.identity_checks += 1;
            if !self.identity_ok || id != 0 || key != DEVICE_KEY || !proof.is_object() {
                return Err("fixture identity mismatch".into());
            }
            Ok(())
        }

        fn active_outputs(&mut self, key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
            if key != DEVICE_KEY { return Err("fixture device key mismatch".into()); }
            Ok(self.outputs.clone())
        }

        fn supported_methods(&mut self, key: &str, display: &str) -> Result<Option<u32>, String> {
            if key != DEVICE_KEY || display != DISPLAY_KEY { return Err("fixture target mismatch".into()); }
            Ok(self.supported)
        }

        fn read_mode(&mut self, key: &str, display: &str) -> Result<RetroScalingObservation, String> {
            if key != DEVICE_KEY || display != DISPLAY_KEY { return Err("fixture target mismatch".into()); }
            self.reads += 1;
            if self.read_error_at == Some(self.reads) { return Err("fixture read failure".into()); }
            Ok(self.current)
        }

        fn set_if_current(
            &mut self,
            key: &str,
            display: &str,
            expected: RetroScalingObservation,
            requested: RetroScalingWrite,
        ) -> Result<(), String> {
            if key != DEVICE_KEY || display != DISPLAY_KEY { return Err("fixture target mismatch".into()); }
            if !self.current.same_effective_state(expected) { return Err("fixture conditional write refused".into()); }
            self.writes.push(requested);
            match self.behavior {
                WriteBehavior::Exact => {
                    self.current = RetroScalingObservation { enabled: requested.enabled, method: requested.enabled.then_some(requested.method) };
                    Ok(())
                }
                WriteBehavior::NoOp => Ok(()),
                WriteBehavior::FailAfterWrite => {
                    self.current = RetroScalingObservation { enabled: requested.enabled, method: requested.enabled.then_some(requested.method) };
                    Err("fixture setter reported failure after mutation".into())
                }
                WriteBehavior::ThirdValue => {
                    self.current = RetroScalingObservation { enabled: true, method: Some(RetroScalingMethod::NearestNeighbour) };
                    Ok(())
                }
            }
        }
    }

    fn target() -> DisplayApplyTarget<'static> {
        static PROOF: OnceLock<Value> = OnceLock::new();
        DisplayApplyTarget {
            device_id: 0,
            device_key: DEVICE_KEY,
            physical_target: PROOF.get_or_init(|| json!({ "bdf": "0000:03:00.0" })),
            display_key: DISPLAY_KEY,
        }
    }

    fn apply(backend: &mut FakeBackend, requested: RetroScalingWrite) -> RetroScalingApplyResult {
        let guard = super::super::display_lock::acquire().expect("Display lock is available to fake transaction tests");
        apply_retro_scaling(&guard, backend, &target(), requested)
    }

    #[test]
    fn missing_display_guard_fails_before_backend_reads_or_writes() {
        let mut backend = FakeBackend::new();
        let result = apply_retro_scaling_with_guard_state(
            false, &mut backend, &target(), integer_enabled(),
        );
        assert!(!result.ok);
        assert_eq!(result.error_code, Some("io-failed"));
        assert!(result.message.as_deref().unwrap().contains("shared Display transaction lock"));
        assert_eq!(backend.identity_checks, 0);
        assert_eq!(backend.reads, 0);
        assert!(backend.writes.is_empty());
    }

    fn integer_enabled() -> RetroScalingWrite {
        RetroScalingWrite { enabled: true, method: RetroScalingMethod::Integer }
    }

    #[test]
    fn successful_apply_is_identity_guarded_and_read_back_verified() {
        let mut backend = FakeBackend::new();
        let result = apply(&mut backend, integer_enabled());
        assert!(result.ok);
        assert!(result.read_back_equal);
        assert_eq!(result.read_back, Some(RetroScalingObservation {
            enabled: true, method: Some(RetroScalingMethod::Integer),
        }));
        assert_eq!(result.silent_noop, Some(false));
        assert!(backend.identity_checks >= 3, "identity is checked before read, pre-write and read-back");
        assert_eq!(backend.writes, vec![integer_enabled()]);
    }

    #[test]
    fn stale_adapter_and_duplicate_or_inactive_outputs_are_rejected_before_write() {
        let mut backend = FakeBackend::new();
        backend.identity_ok = false;
        let result = apply(&mut backend, integer_enabled());
        assert_eq!(result.error_code, Some("stale-target"));
        assert!(backend.writes.is_empty());

        let mut backend = FakeBackend::new();
        let duplicate = backend.outputs[0].clone();
        backend.outputs.push(duplicate);
        let result = apply(&mut backend, integer_enabled());
        assert_eq!(result.error_code, Some("ambiguous-target"));
        assert!(backend.writes.is_empty());

        let mut backend = FakeBackend::new();
        backend.outputs[0].active = false;
        let result = apply(&mut backend, integer_enabled());
        assert_eq!(result.error_code, Some("stale-target"));
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn unsupported_method_is_rejected_before_write() {
        let mut backend = FakeBackend::new();
        backend.supported = Some(0b10);
        let result = apply(&mut backend, integer_enabled());
        assert_eq!(result.error_code, Some("unsupported"));
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn setter_error_after_mutation_gets_conditional_verified_compensation() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::FailAfterWrite;
        let result = apply(&mut backend, integer_enabled());
        assert!(!result.ok);
        assert!(result.rollback_attempted);
        assert!(result.rollback_verified);
        assert!(!result.state_may_have_changed);
        assert_eq!(result.silent_noop, None, "a failed setter is not a silent no-op");
        assert_eq!(backend.writes, vec![integer_enabled(), RetroScalingWrite {
            enabled: false, method: RetroScalingMethod::Integer,
        }]);
    }

    #[test]
    fn third_value_and_unreadable_readback_are_never_overwritten() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::ThirdValue;
        let result = apply(&mut backend, integer_enabled());
        assert!(!result.ok);
        assert!(result.state_may_have_changed);
        assert!(!result.rollback_attempted);
        assert_eq!(result.silent_noop, Some(true));
        assert_eq!(backend.writes, vec![integer_enabled()]);

        let mut backend = FakeBackend::new();
        backend.read_error_at = Some(3);
        let result = apply(&mut backend, integer_enabled());
        assert!(!result.ok);
        assert!(result.state_may_have_changed);
        assert!(!result.rollback_attempted);
        assert_eq!(backend.writes, vec![integer_enabled()]);
    }

    #[test]
    fn successful_silent_noop_is_not_reported_as_applied() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::NoOp;
        let result = apply(&mut backend, integer_enabled());
        assert!(!result.ok);
        assert!(!result.read_back_equal);
        assert_eq!(result.read_back, Some(RetroScalingObservation { enabled: false, method: None }));
        assert!(!result.rollback_attempted);
        assert!(!result.state_may_have_changed);
        assert_eq!(result.silent_noop, Some(true));

        let mut backend = FakeBackend::new();
        backend.read_error_at = Some(3);
        let result = apply(&mut backend, integer_enabled());
        assert!(!result.ok);
        assert_eq!(result.read_back, None);
        assert!(!result.read_back_equal);
        assert_eq!(result.silent_noop, Some(true), "successful SET with failed GET mirrors Electron");
    }
}

