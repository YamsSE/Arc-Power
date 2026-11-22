//! Private transaction core for one Display wire-format control.
//!
//! The service routes only an isolated `wireFormat` patch into this module
//! after complete Display ownership and capability preflight. The transaction
//! requires the shared Display mutex, reopens the selected adapter from PCI/BDF
//! proof, resolves a fresh uniquely active encoder/EDID output for every
//! operation, and verifies the driver read-back before reporting success.
//! Compensation is conditional on the current state still matching this
//! transaction's write.

use super::{
    display_apply::{self, DisplayApplyTarget, DisplayOutputIdentity},
    gpu_apply_identity::{self, ApplyIdentity},
    gpu_capabilities,
    igcl_read_only::ReadOnlyIgcl,
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

static DISPLAY_WIRE_FORMAT_GATE: OnceLock<Mutex<()>> = OnceLock::new();

const WIRE_MODELS: std::ops::RangeInclusive<i32> = 0..=3;
const WIRE_DEPTH_FLAGS: [u32; 4] = [1, 2, 4, 8];

/// Raw IGCL pair: `color_depth` is one exact `ctl_output_bpc_flags_t` bit,
/// rather than the user-facing bits-per-component number.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct WireFormatPair {
    pub color_model: i32,
    pub color_depth: u32,
}

impl WireFormatPair {
    fn valid(self) -> bool {
        WIRE_MODELS.contains(&self.color_model) && WIRE_DEPTH_FLAGS.contains(&self.color_depth)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WireFormatApplyResult {
    pub ok: bool,
    pub error_code: Option<&'static str>,
    pub message: Option<String>,
    pub read_back: Option<WireFormatPair>,
    pub read_back_equal: bool,
    /// `Some(true)` means the initial SET returned success. This distinction
    /// backs Electron's `silentNoop` result when read-back cannot prove a set.
    pub setter_succeeded: Option<bool>,
    pub rollback_attempted: bool,
    pub rollback_verified: bool,
    pub state_may_have_changed: bool,
}

impl WireFormatApplyResult {
    fn ok(read_back: WireFormatPair, setter_succeeded: Option<bool>) -> Self {
        Self {
            ok: true,
            error_code: None,
            message: None,
            read_back: Some(read_back),
            read_back_equal: true,
            setter_succeeded,
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: false,
        }
    }

    fn failed(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error_code: Some(code),
            message: Some(message.into()),
            read_back: None,
            read_back_equal: false,
            setter_succeeded: None,
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: false,
        }
    }
}

/// Fakeable seam for the transaction core. Each operation must reopen or
/// revalidate the physical adapter and resolve the stable display key afresh.
pub(crate) trait DisplayWireFormatBackend {
    fn assert_device_target(
        &mut self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
    ) -> Result<(), String>;

    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String>;

    fn read_wire_format(
        &mut self,
        expected_device_key: &str,
        expected_display_key: &str,
    ) -> Result<WireFormatPair, String>;

    fn write_wire_format(
        &mut self,
        expected_device_key: &str,
        expected_display_key: &str,
        value: WireFormatPair,
    ) -> Result<(), String>;
}

/// Transaction core. The caller must own the shared Display lock for the
/// entire adapter/output validation, GET/SET, read-back, and compensation.
pub(crate) fn apply_wire_format(
    _display_guard: &super::display_lock::DisplayLockGuard,
    backend: &mut dyn DisplayWireFormatBackend,
    target: &DisplayApplyTarget<'_>,
    requested: WireFormatPair,
) -> WireFormatApplyResult {
    let _gate = DISPLAY_WIRE_FORMAT_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if !requested.valid() {
        return WireFormatApplyResult::failed("out-of-range", "unknown wire-format model or depth flag");
    }
    if target.device_key.trim().is_empty()
        || target.display_key.trim().is_empty()
        || !target.physical_target.is_object()
        || !display_apply::display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return WireFormatApplyResult::failed(
            "stale-target",
            "the wire-format apply request requires matching stable adapter and display identities",
        );
    }

    if let Err(error) = ensure_target(backend, target) {
        return WireFormatApplyResult::failed(error.code, error.message);
    }
    let _initial = match backend.read_wire_format(target.device_key, target.display_key) {
        Ok(value) if value.valid() => value,
        Ok(_) => return WireFormatApplyResult::failed("io-failed", "the driver returned an unverifiable current wire format"),
        Err(error) => return WireFormatApplyResult::failed("io-failed", format!("wire-format read failed: {error}")),
    };

    if let Err(error) = ensure_target(backend, target) {
        return WireFormatApplyResult::failed(error.code, error.message);
    }
    let before_write = match backend.read_wire_format(target.device_key, target.display_key) {
        Ok(value) if value.valid() => value,
        Ok(_) => return WireFormatApplyResult::failed("io-failed", "the driver returned an unverifiable current wire format before apply"),
        Err(error) => return WireFormatApplyResult::failed("io-failed", format!("wire-format pre-write read failed: {error}")),
    };
    if let Err(error) = ensure_target(backend, target) {
        let mut result = WireFormatApplyResult::failed(error.code, error.message);
        result.read_back = Some(before_write);
        return result;
    }
    let set_result = backend.write_wire_format(target.device_key, target.display_key, requested);
    let read_back_result = match ensure_target(backend, target) {
        Ok(()) => backend.read_wire_format(target.device_key, target.display_key),
        Err(error) => Err(error.message),
    };
    let setter_succeeded = set_result.is_ok();
    let current = read_back_result.as_ref().ok().copied();
    let read_back_equal = current == Some(requested);
    if setter_succeeded && read_back_equal {
        let mut result = WireFormatApplyResult::ok(requested, Some(true));
        result.read_back = current;
        return result;
    }

    let mut failure_message = match set_result {
        Err(error) => format!("wire-format setter failed: {error}"),
        Ok(()) => match read_back_result {
            Err(error) => format!("set succeeded but wire-format read-back failed: {error}"),
            Ok(actual) => format!("read-back {:?} != requested {:?}", actual, requested),
        },
    };

    // A missing read-back or a third value cannot be attributed to this
    // transaction; do not overwrite it with the old pair.
    if current == Some(before_write) {
        let mut result = WireFormatApplyResult::failed("io-failed", failure_message);
        result.read_back = current;
        result.setter_succeeded = Some(setter_succeeded);
        return result;
    }
    if current != Some(requested) {
        let mut result = WireFormatApplyResult::failed(
            "io-failed",
            format!("{failure_message}; current state is uncertain or externally changed; no rollback was written"),
        );
        result.read_back = current;
        result.setter_succeeded = Some(setter_succeeded);
        result.state_may_have_changed = true;
        return result;
    }

    let mut result = WireFormatApplyResult::failed("io-failed", String::new());
    result.setter_succeeded = Some(setter_succeeded);
    result.read_back_equal = read_back_equal;
    match ensure_target(backend, target) {
        Err(error) => {
            failure_message.push_str(&format!("; rollback skipped because the target changed: {}", error.message));
            result.state_may_have_changed = true;
        }
        Ok(()) => match backend.read_wire_format(target.device_key, target.display_key) {
            Ok(value) if value == before_write => {
                result.read_back = Some(value);
                result.message = Some(format!("{failure_message}; prior wire format is already present"));
                return result;
            }
            Ok(value) if value == requested => {
                if let Err(error) = ensure_target(backend, target) {
                    failure_message.push_str(&format!("; rollback skipped because the target changed: {}", error.message));
                    result.state_may_have_changed = true;
                    result.message = Some(failure_message);
                    return result;
                }
                result.rollback_attempted = true;
                let rollback_set = backend.write_wire_format(target.device_key, target.display_key, before_write);
                match ensure_target(backend, target) {
                    Err(error) => {
                        failure_message.push_str(&format!("; rollback read-back unavailable because the target changed: {}", error.message));
                        result.state_may_have_changed = true;
                    }
                    Ok(()) => match backend.read_wire_format(target.device_key, target.display_key) {
                        Ok(actual) => {
                            result.read_back = Some(actual);
                            result.rollback_verified = actual == before_write;
                            if result.rollback_verified {
                                if let Err(error) = rollback_set {
                                    failure_message.push_str(&format!("; restoration is verified despite setter error: {error}"));
                                } else {
                                    failure_message.push_str("; the previous wire format was restored and verified");
                                }
                            } else {
                                result.state_may_have_changed = true;
                                failure_message.push_str(&format!("; rollback read-back {:?} != previous {:?}", actual, before_write));
                            }
                        }
                        Err(error) => {
                            result.state_may_have_changed = true;
                            failure_message.push_str(&format!("; rollback read-back failed: {error}"));
                        }
                    },
                }
            }
            Ok(value) => {
                result.read_back = Some(value);
                result.state_may_have_changed = true;
                failure_message.push_str("; state changed before rollback; no rollback was written");
            }
            Err(error) => {
                result.state_may_have_changed = true;
                failure_message.push_str(&format!("; state became unreadable before rollback: {error}"));
            }
        },
    }
    result.message = Some(failure_message);
    result
}

struct TargetError {
    code: &'static str,
    message: String,
}

fn ensure_target(
    backend: &mut dyn DisplayWireFormatBackend,
    target: &DisplayApplyTarget<'_>,
) -> Result<(), TargetError> {
    backend.assert_device_target(target.device_id, target.device_key, target.physical_target)
        .map_err(|error| TargetError {
            code: "stale-target",
            message: format!("the selected graphics adapter changed; refresh Display and try again: {error}"),
        })?;
    let outputs = backend.active_outputs(target.device_key).map_err(|error| TargetError {
        code: "io-failed",
        message: format!("display output enumeration failed: {error}"),
    })?;
    let matches: Vec<_> = outputs.iter().filter(|output| output.display_key == target.display_key).collect();
    if matches.is_empty() {
        return Err(TargetError { code: "stale-target", message: "the selected display is no longer connected; refresh Display and try again".into() });
    }
    if matches.len() != 1 {
        return Err(TargetError { code: "ambiguous-target", message: "the selected display is no longer uniquely connected; refresh Display and try again".into() });
    }
    if !matches[0].active || !matches[0].identity_verified {
        return Err(TargetError { code: "stale-target", message: "the selected display identity is not verified as active; refresh Display and try again".into() });
    }
    Ok(())
}

/// Join current IGCL rows to SetupAPI identities only when vendor, device,
/// and all PCI coordinates match. If the OS identity is incomplete or the
/// join is ambiguous, no PNP alias is attached. This keeps the caller's PNP
/// key as an alias while retaining the IGCL PCI/BDF row as physical proof.
fn attach_pnp_aliases(
    native_inventory: &[Value],
    os_adapters: &[super::os_gpu_inventory::OsAdapter],
) -> Vec<Value> {
    let mut inventory = native_inventory.to_vec();
    for row in &mut inventory {
        let Ok(identity) = gpu_apply_identity::identity_from_row(row) else { continue; };
        let Ok(expected_subsystem) = row_subsystem(row) else { continue; };
        let candidates: Vec<_> = os_adapters.iter().filter(|adapter| {
            adapter.vendor_id as u32 == identity.vendor
                && adapter.device_id as u32 == identity.device
                && pnp_matches_physical_ids(&adapter.pnp, identity.vendor, identity.device)
                && adapter.bdf == Some((identity.bus, identity.slot, identity.function))
                && subsystem_matches(expected_subsystem, adapter.subsys.as_deref())
                && !adapter.pnp.trim().is_empty()
        }).collect();
        if let [adapter] = candidates.as_slice() {
            row["pnpDeviceId"] = json!(adapter.pnp);
        }
    }
    inventory
}

fn pnp_matches_physical_ids(pnp: &str, vendor: u32, device: u32) -> bool {
    fn component(pnp: &str, marker: &str) -> Option<u32> {
        let normalized = pnp.to_ascii_uppercase();
        let start = normalized.find(marker)? + marker.len();
        let hex = normalized.get(start..start + 4)?;
        if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
        u32::from_str_radix(hex, 16).ok()
    }
    component(pnp, "VEN_") == Some(vendor) && component(pnp, "DEV_") == Some(device)
}

fn row_subsystem(row: &Value) -> Result<Option<(u16, u16)>, ()> {
    let vendor = row["pciSubsysVendorId"].as_u64().and_then(|value| u16::try_from(value).ok());
    let device = row["pciSubsysId"].as_u64().and_then(|value| u16::try_from(value).ok());
    match (vendor, device) {
        (None, None) => Ok(None),
        (Some(vendor), Some(device)) if vendor != 0 && device != 0 => Ok(Some((vendor, device))),
        _ => Err(()),
    }
}

fn subsystem_matches(expected: Option<(u16, u16)>, actual: Option<&str>) -> bool {
    let Some((vendor, device)) = expected else { return true; };
    actual.is_some_and(|actual| actual.eq_ignore_ascii_case(&format!("{device:04X}{vendor:04X}")))
}

pub(super) fn native_inventory_with_pnp(dll_path: &Path) -> Result<Vec<Value>, String> {
    let listed = super::gpu_devices::list_devices(dll_path)?;
    let native = listed.as_array().ok_or("the current IGCL inventory is unavailable")?;
    let os = super::os_gpu_inventory::enumerate_for_alias_validation()?;
    Ok(attach_pnp_aliases(native, &os))
}

fn selected_inventory_index(device_id: u64) -> Result<usize, String> {
    usize::try_from(device_id).map_err(|_| "the selected graphics adapter ordinal is invalid".into())
}

pub(super) fn normalize_wire_target_from_inventory(
    expected_device_key: &str,
    physical_target: &Value,
    device_id: u64,
    inventory: &[Value],
) -> Result<Value, String> {
    display_apply::normalize_physical_target_from_inventory(
        expected_device_key,
        physical_target,
        selected_inventory_index(device_id)?,
        inventory,
    )
}

struct NativeDisplayWireFormatBackend {
    dll_path: PathBuf,
    identity: ApplyIdentity,
    selected_device_key: String,
    device_id: u64,
}

impl NativeDisplayWireFormatBackend {
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

impl DisplayWireFormatBackend for NativeDisplayWireFormatBackend {
    fn assert_device_target(
        &mut self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
    ) -> Result<(), String> {
        if device_id != self.device_id { return Err("the selected graphics adapter ordinal changed".into()); }
        let normalized = if expected_device_key.starts_with("pnp:") {
            let inventory = native_inventory_with_pnp(&self.dll_path)?;
            normalize_wire_target_from_inventory(expected_device_key, physical_target, device_id, &inventory)?
        } else {
            display_apply::normalize_physical_target(expected_device_key, physical_target)?
        };
        let supplied = gpu_apply_identity::identity_from_row(&normalized)?;
        gpu_apply_identity::ensure_same_target(&self.identity, &supplied)?;
        self.with_session(expected_device_key, |_, _| Ok(()))
    }

    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
        self.with_session(expected_device_key, |session, index| {
            display_apply::fresh_display_outputs(session, index, expected_device_key)
                .map(|outputs| outputs.into_iter().map(|(_, identity)| identity).collect())
        })
    }

    fn read_wire_format(&mut self, expected_device_key: &str, expected_display_key: &str) -> Result<WireFormatPair, String> {
        self.with_session(expected_device_key, |session, index| {
            let handle = display_apply::resolve_display_handle(session, index, expected_device_key, expected_display_key)?;
            let config = session.display_wire_format(handle)
                .ok_or_else(|| "ctlGetSetWireFormat GET failed".to_owned())?;
            let value = WireFormatPair { color_model: config.WireFormat.ColorModel, color_depth: config.WireFormat.ColorDepth };
            value.valid().then_some(value)
                .ok_or_else(|| "the driver did not return one verifiable current wire-format pair".into())
        })
    }

    fn write_wire_format(&mut self, expected_device_key: &str, expected_display_key: &str, value: WireFormatPair) -> Result<(), String> {
        if !value.valid() { return Err("unknown wire-format model or depth flag".into()); }
        self.with_session(expected_device_key, |session, index| {
            let handle = display_apply::resolve_display_handle(session, index, expected_device_key, expected_display_key)?;
            session.display_apply_api().set_wire_format(handle, value.color_model, value.color_depth)
                .map_err(|error| error.to_string())
        })
    }
}

/// Run the private wire-format transaction through the strict Display DLL
/// selector after the service's complete-response preflight.
pub(crate) fn apply_wire_format_native(
    display_guard: &super::display_lock::DisplayLockGuard,
    target: &DisplayApplyTarget<'_>,
    requested: WireFormatPair,
) -> WireFormatApplyResult {
    if !requested.valid() {
        return WireFormatApplyResult::failed("out-of-range", "unknown wire-format model or depth flag");
    }
    if target.device_key.trim().is_empty() || target.display_key.trim().is_empty()
        || !display_apply::display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return WireFormatApplyResult::failed("stale-target", "the wire-format apply request requires matching stable adapter and display identities");
    }
    let Some(dll_path) = super::display_igcl_dll::locate_dll() else {
        return WireFormatApplyResult::failed("io-failed", "The trusted Intel display runtime is unavailable.");
    };
    let normalized = if target.device_key.starts_with("pnp:") {
        let inventory = match native_inventory_with_pnp(&dll_path) {
            Ok(inventory) => inventory,
            Err(error) => return WireFormatApplyResult::failed("stale-target", format!("the complete current graphics adapter inventory is unavailable: {error}")),
        };
        normalize_wire_target_from_inventory(target.device_key, target.physical_target, target.device_id, &inventory)
    } else {
        display_apply::normalize_physical_target(target.device_key, target.physical_target)
    };
    let normalized = match normalized {
        Ok(row) => row,
        Err(error) => return WireFormatApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    let identity = match gpu_apply_identity::identity_from_row(&normalized) {
        Ok(identity) => identity,
        Err(error) => return WireFormatApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    let mut backend = NativeDisplayWireFormatBackend {
        dll_path,
        identity,
        selected_device_key: target.device_key.to_owned(),
        device_id: target.device_id,
    };
    apply_wire_format(display_guard, &mut backend, target, requested)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::OnceLock;

    const DEVICE_KEY: &str = "pci:gpu-a";
    const DISPLAY_KEY: &str = "pci:gpu-a|display|encoder-a|edid|abcd1234";
    const BEFORE: WireFormatPair = WireFormatPair { color_model: 0, color_depth: 2 };
    const REQUESTED: WireFormatPair = WireFormatPair { color_model: 3, color_depth: 4 };
    const THIRD: WireFormatPair = WireFormatPair { color_model: 1, color_depth: 8 };

    #[derive(Clone, Copy)]
    enum WriteBehavior { Exact, NoOp, ThirdValue, FailAfterWrite, FailRollback }

    struct FakeBackend {
        key: String,
        active: bool,
        verified: bool,
        duplicate: bool,
        current: WireFormatPair,
        behavior: WriteBehavior,
        output_change_on_check: Option<usize>,
        target_change_on_check: Option<usize>,
        output_checks: usize,
        target_checks: usize,
        reads: usize,
        writes: Vec<WireFormatPair>,
        read_fail_on: Option<usize>,
        read_change_on: Option<(usize, WireFormatPair)>,
    }

    impl FakeBackend {
        fn new() -> Self {
            Self {
                key: DISPLAY_KEY.into(), active: true, verified: true, duplicate: false,
                current: BEFORE, behavior: WriteBehavior::Exact,
                output_change_on_check: None, target_change_on_check: None,
                output_checks: 0, target_checks: 0, reads: 0, writes: Vec::new(),
                read_fail_on: None, read_change_on: None,
            }
        }
    }

    impl DisplayWireFormatBackend for FakeBackend {
        fn assert_device_target(&mut self, device_id: u64, expected_device_key: &str, physical_target: &Value) -> Result<(), String> {
            self.target_checks += 1;
            if self.target_change_on_check == Some(self.target_checks) || device_id != 0
                || expected_device_key != DEVICE_KEY || physical_target != &json!({"bdf":"0000:03:00.0"})
            { return Err("physical adapter proof changed".into()); }
            Ok(())
        }

        fn active_outputs(&mut self, _expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
            self.output_checks += 1;
            if self.output_change_on_check == Some(self.output_checks) { self.key = "pci:gpu-a|display|replacement".into(); }
            let output = DisplayOutputIdentity { display_key: self.key.clone(), active: self.active, identity_verified: self.verified };
            let mut outputs = vec![output.clone()];
            if self.duplicate { outputs.push(output); }
            Ok(outputs)
        }

        fn read_wire_format(&mut self, _expected_device_key: &str, _expected_display_key: &str) -> Result<WireFormatPair, String> {
            self.reads += 1;
            if let Some((on, value)) = self.read_change_on { if on == self.reads { self.current = value; } }
            if self.read_fail_on == Some(self.reads) { return Err("fixture read failure".into()); }
            Ok(self.current)
        }

        fn write_wire_format(&mut self, _expected_device_key: &str, _expected_display_key: &str, value: WireFormatPair) -> Result<(), String> {
            self.writes.push(value);
            match self.behavior {
                WriteBehavior::Exact => self.current = value,
                WriteBehavior::NoOp => {}
                WriteBehavior::ThirdValue => self.current = THIRD,
                WriteBehavior::FailAfterWrite if self.writes.len() == 1 => { self.current = value; return Err("fixture setter failure".into()); }
                WriteBehavior::FailRollback if self.writes.len() == 1 => { self.current = value; return Err("fixture setter failure".into()); }
                WriteBehavior::FailRollback => return Err("fixture rollback failure".into()),
                WriteBehavior::FailAfterWrite => self.current = value,
            }
            Ok(())
        }
    }

    fn target() -> DisplayApplyTarget<'static> {
        static PROOF: OnceLock<Value> = OnceLock::new();
        DisplayApplyTarget {
            device_id: 0,
            device_key: DEVICE_KEY,
            physical_target: PROOF.get_or_init(|| json!({"bdf":"0000:03:00.0"})),
            display_key: DISPLAY_KEY,
        }
    }

    fn apply(backend: &mut FakeBackend, target: &DisplayApplyTarget<'_>, value: WireFormatPair) -> WireFormatApplyResult {
        let guard = super::super::display_lock::acquire().expect("shared Display lock should be available");
        apply_wire_format(&guard, backend, target, value)
    }

    #[test]
    fn exact_wire_format_set_is_verified() {
        let mut backend = FakeBackend::new();
        let result = apply(&mut backend, &target(), REQUESTED);
        assert!(result.ok);
        assert_eq!(result.read_back, Some(REQUESTED));
        assert!(result.read_back_equal);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(!result.rollback_attempted);
        assert_eq!(backend.writes, vec![REQUESTED]);
    }

    #[test]
    fn already_selected_wire_format_still_sets_and_reports_verified_readback() {
        let mut backend = FakeBackend::new();
        backend.current = REQUESTED;
        let result = apply(&mut backend, &target(), REQUESTED);
        assert!(result.ok);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(result.read_back_equal);
        assert_eq!(backend.writes, vec![REQUESTED]);
    }

    #[test]
    fn invalid_pair_or_mismatched_target_is_rejected_before_driver_io() {
        let mut backend = FakeBackend::new();
        let invalid = WireFormatPair { color_model: 9, color_depth: 4 };
        let result = apply(&mut backend, &target(), invalid);
        assert_eq!(result.error_code, Some("out-of-range"));
        assert!(backend.writes.is_empty());
        assert_eq!(backend.target_checks, 0);

        let mut backend = FakeBackend::new();
        let mut wrong_device = target();
        wrong_device.display_key = "pci:other|display|encoder-a";
        let result = apply(&mut backend, &wrong_device, REQUESTED);
        assert_eq!(result.error_code, Some("stale-target"));
        assert!(backend.writes.is_empty());
        assert_eq!(backend.target_checks, 0);
    }

    #[test]
    fn inactive_unverified_duplicate_and_stale_outputs_fail_closed() {
        for configure in 0..4 {
            let mut backend = FakeBackend::new();
            match configure {
                0 => backend.active = false,
                1 => backend.verified = false,
                2 => backend.duplicate = true,
                _ => backend.output_change_on_check = Some(1),
            }
            let result = apply(&mut backend, &target(), REQUESTED);
            assert!(!result.ok);
            assert!(backend.writes.is_empty());
        }
    }

    #[test]
    fn current_wire_format_must_be_exactly_verifiable_before_write() {
        let mut backend = FakeBackend::new();
        backend.current = WireFormatPair { color_model: 0, color_depth: 3 };
        let result = apply(&mut backend, &target(), REQUESTED);
        assert_eq!(result.error_code, Some("io-failed"));
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn successful_silent_noop_is_not_reported_as_applied() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::NoOp;
        let result = apply(&mut backend, &target(), REQUESTED);
        assert!(!result.ok);
        assert!(!result.read_back_equal);
        assert_eq!(result.setter_succeeded, Some(true));
        assert_eq!(result.read_back, Some(BEFORE));
        assert!(!result.rollback_attempted);
        assert_eq!(backend.writes, vec![REQUESTED]);
    }

    #[test]
    fn successful_set_with_unavailable_readback_preserves_set_success() {
        let mut backend = FakeBackend::new();
        backend.read_fail_on = Some(3);
        let result = apply(&mut backend, &target(), REQUESTED);
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(!result.read_back_equal);
        assert!(result.state_may_have_changed);
        assert!(!result.rollback_attempted);
    }

    #[test]
    fn setter_error_after_mutation_gets_conditional_verified_compensation() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::FailAfterWrite;
        let result = apply(&mut backend, &target(), REQUESTED);
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, Some(false));
        assert!(result.rollback_attempted);
        assert!(result.rollback_verified);
        assert_eq!(result.read_back, Some(BEFORE));
        assert_eq!(backend.writes, vec![REQUESTED, BEFORE]);
    }

    #[test]
    fn third_party_state_and_target_change_are_never_overwritten_by_compensation() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::ThirdValue;
        let result = apply(&mut backend, &target(), REQUESTED);
        assert!(!result.ok);
        assert!(!result.rollback_attempted);
        assert!(result.state_may_have_changed);
        assert_eq!(backend.writes, vec![REQUESTED]);

        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::FailAfterWrite;
        // Identity checks before GET/SET/read-back and rollback preflight
        // pass; the final pre-write check models an adapter change.
        backend.target_change_on_check = Some(6);
        let result = apply(&mut backend, &target(), REQUESTED);
        assert!(!result.ok);
        assert!(!result.rollback_attempted);
        assert!(result.state_may_have_changed);
        assert_eq!(backend.writes, vec![REQUESTED]);
    }

    #[test]
    fn failed_rollback_is_reported_without_claiming_restoration() {
        let mut backend = FakeBackend::new();
        backend.behavior = WriteBehavior::FailRollback;
        let result = apply(&mut backend, &target(), REQUESTED);
        assert!(!result.ok);
        assert!(result.rollback_attempted);
        assert!(!result.rollback_verified);
        assert!(result.state_may_have_changed);
        assert_eq!(backend.writes, vec![REQUESTED, BEFORE]);
    }

    const PCI_DEVICE_KEY: &str = "pci:0x00008086:0x0000e20b@3:0.0";
    const PNP_DEVICE_KEY: &str = "pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000";

    fn physical_proof() -> Value {
        json!({
            "pnpDeviceId": "PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000",
            "pciVendorId": "0x8086",
            "pciDeviceId": "0xe20b",
            "bdf": "0000:03:00.0",
            "osLuid": "0x00000001:0x00000002",
            "controllerBdf": "0000:03:00.0",
            "controllerLuid": "0x00000001:0x00000002",
            "physicalToken": "fixture-token",
            "legacyDeviceKey": "pci:0x8086:0xe20b@3:0.0",
            "synthetic": false,
        })
    }

    fn physical_row() -> Value {
        display_apply::normalize_physical_target(PCI_DEVICE_KEY, &physical_proof()).unwrap()
    }

    fn os_adapter(pnp: &str, bdf: Option<(u32, u32, u32)>, subsys: Option<&str>) -> super::super::os_gpu_inventory::OsAdapter {
        super::super::os_gpu_inventory::OsAdapter {
            name: "Intel Arc B580".into(),
            pnp: pnp.into(),
            vendor_id: 0x8086,
            device_id: 0xe20b,
            subsys: subsys.map(str::to_owned),
            bdf,
            vram_bytes: None,
            gpu_vendor: "intel",
            integrated: false,
            mobile: false,
        }
    }

    #[test]
    fn pnp_alias_join_requires_complete_exact_physical_identity_and_keeps_pci_proof() {
        let proof = physical_proof();
        let native = physical_row();
        let os = os_adapter("PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000", Some((3, 0, 0)), None);
        let joined = attach_pnp_aliases(&[native], &[os]);
        assert_eq!(joined[0]["pnpDeviceId"], json!("PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000"));

        let resolved = normalize_wire_target_from_inventory(PNP_DEVICE_KEY, &proof, 0, &joined).unwrap();
        let identity = gpu_apply_identity::identity_from_row(&resolved).unwrap();
        assert_eq!(identity.device_key, PCI_DEVICE_KEY);
        assert_eq!((identity.vendor, identity.device, identity.bus, identity.slot, identity.function),
            (0x8086, 0xe20b, 3, 0, 0));

        let incomplete = os_adapter("PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000", None, None);
        let joined = attach_pnp_aliases(&[physical_row()], &[incomplete]);
        assert!(joined[0].get("pnpDeviceId").is_none());
        assert!(normalize_wire_target_from_inventory(PNP_DEVICE_KEY, &proof, 0, &joined).is_err());

        let wrong_ids = os_adapter("PCI\\VEN_1002&DEV_E20B&SUBSYS_00000000", Some((3, 0, 0)), None);
        let joined = attach_pnp_aliases(&[physical_row()], &[wrong_ids]);
        assert!(joined[0].get("pnpDeviceId").is_none());
    }

    #[test]
    fn pnp_alias_join_rejects_ambiguous_subsystem_and_selected_index_cases() {
        let mut proof = physical_proof();
        proof["pnpDeviceId"] = json!("PCI\\VEN_8086&DEV_E20B&SUBSYS_12341458");
        let pnp_key = "pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_12341458";
        let mut native = physical_row();
        native["pciSubsysVendorId"] = json!(0x1458);
        native["pciSubsysId"] = json!(0x1234);

        let wrong_subsystem = os_adapter(
            "PCI\\VEN_8086&DEV_E20B&SUBSYS_99991458", Some((3, 0, 0)), Some("99991458"),
        );
        let joined = attach_pnp_aliases(&[native.clone()], &[wrong_subsystem]);
        assert!(joined[0].get("pnpDeviceId").is_none());

        let matching = os_adapter(
            "PCI\\VEN_8086&DEV_E20B&SUBSYS_12341458", Some((3, 0, 0)), Some("12341458"),
        );
        let ambiguous_os = attach_pnp_aliases(&[native.clone()], &[matching.clone(), matching]);
        assert!(ambiguous_os[0].get("pnpDeviceId").is_none());

        let valid_os = os_adapter(
            "PCI\\VEN_8086&DEV_E20B&SUBSYS_12341458", Some((3, 0, 0)), Some("12341458"),
        );
        let duplicate_native = attach_pnp_aliases(&[native.clone(), native.clone()], &[valid_os.clone()]);
        assert!(normalize_wire_target_from_inventory(pnp_key, &proof, 0, &duplicate_native)
            .unwrap_err().contains("ambiguous"));

        let mut other_native = native.clone();
        other_native["bdf"]["bus"] = json!(4);
        other_native["deviceKey"] = json!(super::super::gpu_devices::device_key(&other_native));
        let reordered = attach_pnp_aliases(&[other_native, native], &[valid_os]);
        assert!(normalize_wire_target_from_inventory(pnp_key, &proof, 0, &reordered)
            .unwrap_err().contains("different adapter"));
    }
}
