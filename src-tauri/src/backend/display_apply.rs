//! Private transaction core for one Display control (`quantizationRange`).
//!
//! The elevated, non-mock service routes an isolated `quantizationRange`
//! request through this guarded transaction when complete-response preflight
//! proves native ownership. Mixed patches and other Display setters remain
//! broker-owned. The injected backend keeps this transaction testable without
//! loading IGCL or writing a real display.
//!
//! The staged IGCL backend reopens the adapter by physical proof, re-enumerates
//! output handles for each read/write, and resolves one active output by the
//! stable `displayKey`. The transaction verifies the requested value by GET
//! and attempts read-back-verified compensation when a failed SET may have
//! changed the output. The service holds the shared Display guard through the
//! transaction and complete response read-back.

use super::{
    gpu_apply_identity::{self, ApplyIdentity},
    gpu_capabilities,
    igcl_raw::ctl_display_properties_t,
    igcl_read_only::ReadOnlyIgcl,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    ffi::c_void,
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

static DISPLAY_APPLY_GATE: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuantizationRange {
    Default,
    Limited,
    Full,
}

impl QuantizationRange {
    fn from_igcl(value: i32) -> Option<Self> {
        match value {
            0 => Some(Self::Default),
            1 => Some(Self::Limited),
            2 => Some(Self::Full),
            _ => None,
        }
    }

    fn igcl_value(self) -> i32 {
        match self {
            Self::Default => 0,
            Self::Limited => 1,
            Self::Full => 2,
        }
    }
}

pub(crate) struct DisplayApplyTarget<'a> {
    pub device_id: u64,
    pub device_key: &'a str,
    pub physical_target: &'a Value,
    pub display_key: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayOutputIdentity {
    pub display_key: String,
    pub active: bool,
    pub identity_verified: bool,
}

/// Backend contract for the private transaction core.
///
/// `active_outputs`, `read_quantization_range`, and
/// `write_quantization_range` must each resolve fresh output handles by the
/// stable display key. A backend must not retain a handle across calls because
/// IGCL output handles are topology-scoped.
pub(crate) trait DisplayApplyBackend {
    fn assert_device_target(
        &mut self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
    ) -> Result<(), String>;

    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String>;

    fn read_quantization_range(
        &mut self,
        expected_device_key: &str,
        expected_display_key: &str,
    ) -> Result<i32, String>;

    fn write_quantization_range(
        &mut self,
        expected_device_key: &str,
        expected_display_key: &str,
        value: i32,
    ) -> Result<(), String>;
}

/// Production adapter for the private quantization transaction. Every call
/// opens the selected adapter by its captured PCI/BDF proof and re-enumerates
/// topology-scoped output handles; no IGCL handle survives a backend method.
struct NativeDisplayApplyBackend<'guard> {
    display_guard: &'guard super::display_lock::DisplayLockGuard,
    dll_path: PathBuf,
    identity: ApplyIdentity,
    /// The public renderer key may be a verified PNP or compatibility alias;
    /// `identity.device_key` is the native IGCL PCI/BDF key used to reopen.
    selected_device_key: String,
    device_id: u64,
}

impl NativeDisplayApplyBackend<'_> {
    fn with_session<T>(
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
}

impl DisplayApplyBackend for NativeDisplayApplyBackend<'_> {
    fn assert_device_target(
        &mut self,
        device_id: u64,
        expected_device_key: &str,
        physical_target: &Value,
    ) -> Result<(), String> {
        if device_id != self.device_id {
            return Err("the selected graphics adapter ordinal changed".into());
        }
        let normalized = normalize_physical_target(expected_device_key, physical_target)?;
        let supplied = gpu_apply_identity::identity_from_row(&normalized)?;
        gpu_apply_identity::ensure_same_target(&self.identity, &supplied)?;
        self.with_session(expected_device_key, |_, _| Ok(()))
    }

    fn active_outputs(&mut self, expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
        self.with_session(expected_device_key, |session, index| {
            fresh_display_outputs(session, index, expected_device_key)
                .map(|outputs| outputs.into_iter().map(|(_, identity)| identity).collect())
        })
    }

    fn read_quantization_range(&mut self, expected_device_key: &str, expected_display_key: &str) -> Result<i32, String> {
        self.with_session(expected_device_key, |session, index| {
            let handle = resolve_display_handle(session, index, expected_device_key, expected_display_key)?;
            session.display_settings(handle)
                .map(|settings| settings.QuantizationRange)
                .ok_or_else(|| "ctlGetSetDisplaySettings GET failed".into())
        })
    }

    fn write_quantization_range(
        &mut self,
        expected_device_key: &str,
        expected_display_key: &str,
        value: i32,
    ) -> Result<(), String> {
        if QuantizationRange::from_igcl(value).is_none() {
            return Err("unknown quantization range value".into());
        }
        self.with_session(expected_device_key, |session, index| {
            let handle = resolve_display_handle(session, index, expected_device_key, expected_display_key)?;
            session.display_apply_api().set_quantization_range(handle, value)
                .map_err(|error| error.to_string())
        })
    }
}

pub(super) fn fresh_display_outputs(
    session: &ReadOnlyIgcl,
    index: usize,
    device_key: &str,
) -> Result<Vec<(*mut c_void, DisplayOutputIdentity)>, String> {
    let handles = session.display_outputs(index).map_err(|error| error.to_string())?;
    let mut candidates = Vec::with_capacity(handles.len());
    for handle in handles {
        let properties = session.display_properties(handle)
            .ok_or_else(|| "ctlGetDisplayProperties failed while resolving an apply target".to_owned())?;
        let edid = super::display::select_edid(&session.display_edid_blocks(handle));
        candidates.push((handle, properties, edid));
    }
    Ok(identify_display_outputs(device_key, &candidates))
}

fn identify_display_outputs(
    device_key: &str,
    outputs: &[(*mut c_void, ctl_display_properties_t, Option<Vec<u8>>)],
) -> Vec<(*mut c_void, DisplayOutputIdentity)> {
    let mut encoder_counts = HashMap::<String, usize>::new();
    let encoders: Vec<_> = outputs.iter().map(|(_, properties, _)| {
        if properties.DisplayConfigFlags & super::display::DISPLAY_CONFIG_ACTIVE == 0 {
            return None;
        }
        let key = super::display::output_encoder_key(device_key, properties);
        if let Some(key) = &key { *encoder_counts.entry(key.clone()).or_default() += 1; }
        key
    }).collect();

    outputs.iter().zip(encoders).map(|((handle, properties, edid), encoder)| {
        let active = properties.DisplayConfigFlags & super::display::DISPLAY_CONFIG_ACTIVE != 0;
        let identity_verified = active && encoder.as_ref()
            .is_some_and(|key| encoder_counts.get(key) == Some(&1));
        let display_key = if active {
            super::display::stable_display_key(device_key, properties, edid.as_deref()).unwrap_or_default()
        } else {
            String::new()
        };
        (*handle, DisplayOutputIdentity { display_key, active, identity_verified })
    }).collect()
}

pub(super) fn resolve_display_handle(
    session: &ReadOnlyIgcl,
    index: usize,
    device_key: &str,
    expected_display_key: &str,
) -> Result<*mut c_void, String> {
    let outputs = fresh_display_outputs(session, index, device_key)?;
    let matches: Vec<_> = outputs.into_iter()
        .filter(|(_, identity)| identity.display_key == expected_display_key)
        .collect();
    match matches.as_slice() {
        [(handle, identity)] if identity.active && identity.identity_verified => Ok(*handle),
        [] => Err("the selected display is no longer connected".into()),
        [_] => Err("the selected display identity is not uniquely verified".into()),
        _ => Err("the selected display identity is ambiguous".into()),
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DisplayApplyResult {
    pub ok: bool,
    pub error_code: Option<&'static str>,
    pub message: Option<String>,
    /// Present when SET returned success, matching Electron's success-only
    /// silent-no-op signal for quantization writes.
    pub silent_noop: Option<bool>,
    /// Whether GET confirmed the requested value before compensation.
    pub read_back_equal: bool,
    /// Last value observed, including a rollback read-back if attempted.
    pub read_back: Option<i32>,
    pub rollback_attempted: bool,
    pub rollback_verified: bool,
    /// The final state could not be established or belongs to another writer.
    pub state_may_have_changed: bool,
}

impl DisplayApplyResult {
    fn ok() -> Self {
        Self {
            ok: true,
            error_code: None,
            message: None,
            silent_noop: None,
            read_back_equal: true,
            read_back: None,
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: false,
        }
    }

    fn failed(error_code: &'static str, message: impl Into<String>) -> Self {
        Self {
            ok: false,
            error_code: Some(error_code),
            message: Some(message.into()),
            silent_noop: None,
            read_back_equal: false,
            read_back: None,
            rollback_attempted: false,
            rollback_verified: false,
            state_may_have_changed: false,
        }
    }
}

/// Apply one quantization value with identity checks, a fresh baseline, GET
/// verification, and best-effort compensation. The required cross-process
/// guard is held by the caller for the full transaction.
pub(crate) fn apply_quantization_range(
    display_guard: &super::display_lock::DisplayLockGuard,
    backend: &mut dyn DisplayApplyBackend,
    target: &DisplayApplyTarget<'_>,
    requested: i32,
) -> DisplayApplyResult {
    apply_quantization_range_with_guard_state(display_guard.is_held(), backend, target, requested)
}

fn apply_quantization_range_with_guard_state(
    display_guard_held: bool,
    backend: &mut dyn DisplayApplyBackend,
    target: &DisplayApplyTarget<'_>,
    requested: i32,
) -> DisplayApplyResult {
    if !display_guard_held {
        return DisplayApplyResult::failed(
            "io-failed", "quantization range requires the shared Display transaction lock",
        );
    }
    // The caller's shared DisplayLockGuard must remain borrowed for this
    // entire transaction, including identity revalidation, GET/SET, read-back,
    // and any compensating write. Keep this local lock as an additional
    // same-process serialization layer; it is not a cross-host substitute.
    let _guard = DISPLAY_APPLY_GATE
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    if QuantizationRange::from_igcl(requested).is_none() {
        return DisplayApplyResult::failed("out-of-range", "unknown quantization range value");
    }
    if target.device_key.trim().is_empty()
        || target.display_key.trim().is_empty()
        || !target.physical_target.is_object()
        || !display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return DisplayApplyResult::failed(
            "stale-target",
            "the display apply request requires matching stable adapter and display identities",
        );
    }

    if let Err(error) = ensure_target(backend, target) {
        return DisplayApplyResult::failed(error.code, error.message);
    }
    let _preflight_value = match backend.read_quantization_range(target.device_key, target.display_key) {
        Ok(value) if QuantizationRange::from_igcl(value).is_some() => value,
        Ok(_) => return DisplayApplyResult::failed("io-failed", "the driver returned an unknown quantization range"),
        Err(error) => return DisplayApplyResult::failed("io-failed", format!("quantization range read failed: {error}")),
    };

    // Revalidate adapter and output identity immediately before the write.
    if let Err(error) = ensure_target(backend, target) {
        return DisplayApplyResult::failed(error.code, error.message);
    }
    let before_write = match backend.read_quantization_range(target.device_key, target.display_key) {
        Ok(value) if QuantizationRange::from_igcl(value).is_some() => value,
        Ok(_) => return DisplayApplyResult::failed("io-failed", "the driver returned an unknown quantization range before apply"),
        Err(error) => return DisplayApplyResult::failed("io-failed", format!("quantization range pre-write read failed: {error}")),
    };
    // Use the freshest observed state as the compensation target. This avoids
    // overwriting a concurrent external change observed during preflight.
    let rollback_value = before_write;

    if let Err(error) = ensure_target(backend, target) {
        let mut result = DisplayApplyResult::failed(error.code, error.message);
        result.read_back = Some(rollback_value);
        return result;
    }
    let set_result = backend.write_quantization_range(target.device_key, target.display_key, requested);
    let set_succeeded = set_result.is_ok();

    let read_back_result = match ensure_target(backend, target) {
        Ok(()) => backend.read_quantization_range(target.device_key, target.display_key),
        Err(error) => Err(error.message),
    };
    let current = read_back_result.as_ref().ok().copied();
    let read_back_equal = current == Some(requested);
    if set_result.is_ok() && read_back_equal {
        let mut result = DisplayApplyResult::ok();
        result.read_back = current;
        result.silent_noop = Some(false);
        return result;
    }
    let silent_noop = set_succeeded.then_some(!read_back_equal);

    let mut failure_message = match set_result {
        Err(error) => format!("quantization range setter failed: {error}"),
        Ok(()) => match read_back_result {
            Err(error) => format!("set succeeded but quantization range read-back failed: {error}"),
            Ok(actual) => format!("read-back {actual} != requested {requested}"),
        },
    };

    // Restore only a value proven to be our requested value. An unreadable or
    // third value may belong to another writer; never overwrite it blindly.
    let may_have_changed = current != Some(rollback_value);
    if !may_have_changed {
        let mut result = DisplayApplyResult::failed("io-failed", failure_message);
        result.read_back = current;
        result.silent_noop = silent_noop;
        return result;
    }

    if current != Some(requested) {
        let mut result = DisplayApplyResult::failed("io-failed", format!(
            "{failure_message}; current state is uncertain or externally changed; no rollback was written"));
        result.read_back = current;
        result.silent_noop = silent_noop;
        result.state_may_have_changed = true;
        return result;
    }

    let mut result = DisplayApplyResult::failed("io-failed", String::new());
    result.read_back_equal = read_back_equal;
    result.silent_noop = silent_noop;
    match ensure_target(backend, target) {
        Err(error) => {
            failure_message.push_str(&format!("; rollback skipped because the target changed: {}", error.message));
            result.state_may_have_changed = true;
        }
        Ok(()) => {
            match backend.read_quantization_range(target.device_key, target.display_key) {
                Ok(value) if value == rollback_value => {
                    result.read_back = Some(value);
                    result.message = Some(format!("{failure_message}; prior value is already present"));
                    return result;
                }
                Ok(value) if value == requested => {}
                other => {
                    result.read_back = other.ok();
                    result.state_may_have_changed = true;
                    result.message = Some(format!("{failure_message}; state changed or became unreadable before rollback; no rollback was written"));
                    return result;
                }
            }
            result.rollback_attempted = true;
            let rollback_set = backend.write_quantization_range(
                target.device_key,
                target.display_key,
                rollback_value,
            );
            match ensure_target(backend, target) {
                Err(error) => {
                    failure_message.push_str(&format!("; rollback read-back unavailable because the target changed: {}", error.message));
                    result.state_may_have_changed = true;
                }
                Ok(()) => match backend.read_quantization_range(target.device_key, target.display_key) {
                    Ok(actual) => {
                        result.read_back = Some(actual);
                        result.rollback_verified = actual == rollback_value;
                        if result.rollback_verified {
                            if let Err(error) = rollback_set {
                                // GET is authoritative for the observed state,
                                // even if the setter returned a late error.
                                failure_message.push_str(&format!("; restoration is verified despite setter error: {error}"));
                            } else {
                                failure_message.push_str("; the previous value was restored and verified");
                            }
                        } else {
                            result.state_may_have_changed = true;
                            failure_message.push_str(&format!("; rollback read-back {actual} != previous value {rollback_value}"));
                        }
                    }
                    Err(error) => {
                        result.state_may_have_changed = true;
                        failure_message.push_str(&format!("; rollback read-back failed: {error}"));
                    }
                },
            }
        }
    }
    result.message = Some(failure_message);
    result
}

/// Run the private native quantization transaction against the identity-pinned
/// IGCL adapter. The caller must acquire and hold the shared Display guard
/// before invoking this function; the reference is threaded through the full
/// GET/SET/read-back/compensation transaction. The caller must retain the
/// shared Display guard through the entire operation.
pub(crate) fn apply_quantization_range_native(
    display_guard: &super::display_lock::DisplayLockGuard,
    target: &DisplayApplyTarget<'_>,
    requested: i32,
) -> DisplayApplyResult {
    if !display_guard.is_held() {
        return DisplayApplyResult::failed(
            "io-failed", "quantization range requires the shared Display transaction lock",
        );
    }
    if QuantizationRange::from_igcl(requested).is_none() {
        return DisplayApplyResult::failed("out-of-range", "unknown quantization range value");
    }
    let normalized = match normalize_physical_target(target.device_key, target.physical_target) {
        Ok(row) => row,
        Err(error) => return DisplayApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    let identity = match gpu_apply_identity::identity_from_row(&normalized) {
        Ok(identity) => identity,
        Err(error) => return DisplayApplyResult::failed("stale-target", format!("the selected graphics adapter identity is invalid: {error}")),
    };
    if target.device_key.trim().is_empty()
        || target.display_key.trim().is_empty()
        || !display_key_belongs_to_device(target.device_key, target.display_key)
    {
        return DisplayApplyResult::failed("stale-target", "the display apply request requires matching stable adapter and display identities");
    }
    let Some(dll_path) = super::display_igcl_dll::locate_dll() else {
        return DisplayApplyResult::failed("io-failed", "The trusted Intel display runtime is unavailable.");
    };
    let mut backend = NativeDisplayApplyBackend {
        display_guard,
        dll_path,
        identity,
        selected_device_key: target.device_key.to_owned(),
        device_id: target.device_id,
    };
    apply_quantization_range(display_guard, &mut backend, target, requested)
}

/// Normalize the narrow object returned by Electron's `physicalTargetOf()` to
/// the native GPU inventory identity row used by `gpu_apply_identity`.
///
/// This proof-only form accepts the native PCI key and PCI aliases that can be
/// derived directly from it. A PNP alias needs a separate current-inventory
/// uniqueness check and is therefore not accepted here.
pub(super) fn normalize_physical_target(expected_device_key: &str, proof: &Value) -> Result<Value, String> {
    if expected_device_key.trim().is_empty() { return Err("a stable adapter key is required".into()); }
    let row = normalize_physical_proof(proof)?;
    let identity = gpu_apply_identity::identity_from_row(&row)?;
    ensure_expected_key_alias(expected_device_key, &identity)?;
    Ok(row)
}

/// Resolve a PNP key only against a caller-supplied fresh inventory. The
/// inventory rows are validated by their own PCI/BDF identity, and the alias
/// must identify one row whose physical identity is the supplied proof.
pub(super) fn normalize_physical_target_from_inventory(
    expected_device_key: &str,
    proof: &Value,
    selected_index: usize,
    inventory: &[Value],
) -> Result<Value, String> {
    if expected_device_key.trim().is_empty() { return Err("a stable adapter key is required".into()); }
    let row = normalize_physical_proof(proof)?;
    let expected_identity = gpu_apply_identity::identity_from_row(&row)?;
    if ensure_expected_key_alias(expected_device_key, &expected_identity).is_ok() {
        return Ok(row);
    }
    let Some(pnp_suffix) = expected_device_key.strip_prefix("pnp:") else {
        return Err("the selected adapter key is not derivable from the physical proof".into());
    };
    let expected_pnp = normalized_pnp(&Value::String(pnp_suffix.to_owned()))?
        .ok_or("the selected PNP adapter key is invalid")?;
    if normalized_pnp(&proof["pnpDeviceId"])?.is_some_and(|proof_pnp| proof_pnp != expected_pnp) {
        return Err("the selected PNP adapter key does not match the supplied physical proof".into());
    }
    let mut matches = Vec::new();
    for (index, candidate) in inventory.iter().enumerate() {
        if candidate["synthetic"].as_bool() == Some(true) || candidate["backendKind"].as_str() == Some("os") {
            continue;
        }
        let Ok(candidate_identity) = gpu_apply_identity::identity_from_row(candidate) else { continue; };
        if ensure_physical_identity_fields_match(candidate, &candidate_identity).is_err() { continue; }
        if normalized_pnp(&candidate["pnpDeviceId"]).ok().flatten().as_deref() == Some(expected_pnp.as_str()) {
            matches.push((index, candidate_identity));
        }
    }
    if matches.len() > 1 { return Err("the selected PNP adapter key is ambiguous in the current inventory".into()); }
    let Some((resolved_index, resolved_identity)) = matches.pop() else {
        return Err("the selected PNP adapter key is not present in the current inventory".into());
    };
    if resolved_index != selected_index {
        return Err("the selected PNP adapter key resolves to a different adapter".into());
    }
    gpu_apply_identity::ensure_same_target(&expected_identity, &resolved_identity)?;
    Ok(row)
}

/// Convert either the full native inventory row or Electron's narrower
/// `physicalTargetOf()` object into a canonical identity row. Caller-supplied
/// alias arrays are deliberately discarded.
fn normalize_physical_proof(proof: &Value) -> Result<Value, String> {
    if !proof.is_object() { return Err("a physical adapter proof is required".into()); }
    if proof["synthetic"].as_bool() == Some(true) || proof["backendKind"].as_str() == Some("os") {
        return Err("OS-only and synthetic adapters cannot receive display writes".into());
    }

    // A full native inventory row must pass its own key derivation checks. Do
    // not reinterpret a malformed row as a different proof shape.
    if proof.get("deviceKey").is_some() {
        let identity = gpu_apply_identity::identity_from_row(proof)?;
        ensure_physical_identity_fields_match(proof, &identity)?;
        validate_legacy_key_field(proof, &identity)?;
        return Ok(canonical_identity_row(&identity));
    }

    let vendor = parse_physical_pci_id(&proof["pciVendorId"], "vendor")?;
    let device = parse_physical_pci_id(&proof["pciDeviceId"], "device")?;
    let bdf = proof_bdf(proof)?;
    let luid = proof_luid(proof)?;
    let native_key = format!("pci:0x{vendor:08x}:0x{device:08x}@{}:{}.{}", bdf.1, bdf.2, bdf.3);
    let legacy_key = format!("pci:0x{vendor:04x}:0x{device:04x}@{}:{}.{}", bdf.1, bdf.2, bdf.3);
    validate_legacy_key_value(proof.get("legacyDeviceKey"), &legacy_key)?;

    let row = json!({
        "deviceKey": native_key,
        "pciVendorId": format!("0x{vendor:08x}"),
        "pciDeviceId": format!("0x{device:08x}"),
        "bdf": { "bus": bdf.1, "device": bdf.2, "function": bdf.3 },
        "luid": luid,
    });
    let identity = gpu_apply_identity::identity_from_row(&row)?;
    ensure_physical_identity_fields_match(proof, &identity)?;
    Ok(canonical_identity_row(&identity))
}

fn canonical_identity_row(identity: &ApplyIdentity) -> Value {
    json!({
        "deviceKey": identity.device_key,
        "pciVendorId": format!("0x{:08x}", identity.vendor),
        "pciDeviceId": format!("0x{:08x}", identity.device),
        "bdf": { "bus": identity.bus, "device": identity.slot, "function": identity.function },
        "luid": identity.luid,
    })
}

fn ensure_physical_identity_fields_match(proof: &Value, identity: &ApplyIdentity) -> Result<(), String> {
    if let Some(pnp) = normalized_pnp(&proof["pnpDeviceId"])? {
        let vendor = pnp_component(&pnp, "VEN_").ok_or("the PNP identity does not contain a vendor id")?;
        let device = pnp_component(&pnp, "DEV_").ok_or("the PNP identity does not contain a device id")?;
        if vendor != identity.vendor || device != identity.device {
            return Err("the PNP and PCI identifiers disagree".into());
        }
    }
    let (domain, bus, slot, function) = proof_bdf(proof)?;
    if domain != 0 || (bus, slot, function) != (identity.bus, identity.slot, identity.function) {
        return Err("the supplied PCI address does not match the native adapter identity".into());
    }
    if let Some(luid) = proof_luid(proof)? {
        if identity.luid.as_ref() != Some(&luid) {
            return Err("the supplied LUID does not match the native adapter identity".into());
        }
    }
    Ok(())
}

fn ensure_expected_key_alias(expected_device_key: &str, identity: &ApplyIdentity) -> Result<(), String> {
    let bus = identity.bus;
    let slot = identity.slot;
    let function = identity.function;
    let legacy = format!("pci:0x{:04x}:0x{:04x}@{bus}:{slot}.{function}", identity.vendor, identity.device);
    let controller = format!("pci:0x{:04x}:0x{:04x}@0000:{bus:02x}:{slot:02x}.{function}", identity.vendor, identity.device);
    if expected_device_key == identity.device_key || expected_device_key == legacy || expected_device_key == controller {
        Ok(())
    } else {
        Err("the selected adapter key is not an alias of the supplied physical proof".into())
    }
}

fn validate_legacy_key_field(proof: &Value, identity: &ApplyIdentity) -> Result<(), String> {
    let legacy = format!(
        "pci:0x{:04x}:0x{:04x}@{}:{}.{}",
        identity.vendor, identity.device, identity.bus, identity.slot, identity.function,
    );
    validate_legacy_key_value(proof.get("legacyDeviceKey"), &legacy)
}

fn validate_legacy_key_value(value: Option<&Value>, expected: &str) -> Result<(), String> {
    match value {
        None | Some(Value::Null) => Ok(()),
        Some(Value::String(value)) if value == expected => Ok(()),
        Some(Value::String(_)) => Err("the legacy adapter key does not match the physical proof".into()),
        Some(_) => Err("legacy adapter key is invalid".into()),
    }
}

fn parse_physical_pci_id(value: &Value, label: &str) -> Result<u32, String> {
    let text = match value {
        Value::String(text) => text.trim().strip_prefix("0x").or_else(|| text.trim().strip_prefix("0X"))
            .unwrap_or(text.trim()),
        Value::Number(number) => {
            let number = number.as_u64().ok_or_else(|| format!("GPU PCI {label} id is invalid"))?;
            if number > 0xffff { return Err(format!("GPU PCI {label} id is invalid")); }
            return Ok(number as u32);
        }
        _ => return Err(format!("GPU PCI {label} id is unavailable")),
    };
    if !matches!(text.len(), 4 | 8) || !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!("GPU PCI {label} id is invalid"));
    }
    let value = u32::from_str_radix(text, 16).map_err(|_| format!("GPU PCI {label} id is invalid"))?;
    if value > 0xffff { return Err(format!("GPU PCI {label} id is invalid")); }
    Ok(value)
}

fn normalized_pnp(value: &Value) -> Result<Option<String>, String> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) if text.trim().is_empty() => Ok(None),
        Value::String(text) => Ok(Some(text.chars()
            .filter(|character| !character.is_whitespace() && *character != '\0')
            .flat_map(char::to_uppercase).collect())),
        _ => Err("GPU PNP identity is invalid".into()),
    }
}

fn pnp_component(pnp: &str, marker: &str) -> Option<u32> {
    let start = pnp.find(marker)?.checked_add(marker.len())?;
    let digits = pnp.get(start..start + 4)?;
    if !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) { return None; }
    u32::from_str_radix(digits, 16).ok()
}

fn proof_bdf(proof: &Value) -> Result<(u32, u32, u32, u32), String> {
    let primary = proof.get("bdf").filter(|value| !value.is_null());
    let controller = proof.get("controllerBdf").filter(|value| !value.is_null());
    let primary = primary.map(parse_bdf).transpose()?;
    let controller = controller.map(parse_bdf).transpose()?;
    if primary.zip(controller).is_some_and(|(left, right)| left != right) {
        return Err("the adapter and controller PCI addresses disagree".into());
    }
    primary.or(controller).ok_or_else(|| "GPU PCI address is unavailable".into())
}

fn parse_bdf(value: &Value) -> Result<(u32, u32, u32, u32), String> {
    let coordinates = if let Some(text) = value.as_str() {
        let mut parts = text.trim().split(':');
        let first = parts.next().ok_or("GPU PCI address is invalid")?;
        let second = parts.next().ok_or("GPU PCI address is invalid")?;
        let (domain, bus, tail) = if let Some(third) = parts.next() {
            if parts.next().is_some() { return Err("GPU PCI address is invalid".into()); }
            (first, second, third)
        } else {
            ("0", first, second)
        };
        let (slot, function) = tail.split_once('.').ok_or("GPU PCI address is invalid")?;
        let parse_hex = |part: &str| u32::from_str_radix(part, 16).map_err(|_| "GPU PCI address is invalid".to_owned());
        (parse_hex(domain)?, parse_hex(bus)?, parse_hex(slot)?, parse_hex(function)?)
    } else if let Some(object) = value.as_object() {
        let coordinate = |primary: &str, alternate: Option<&str>| -> Result<u32, String> {
            let value = object.get(primary).or_else(|| alternate.and_then(|name| object.get(name)))
                .and_then(Value::as_u64).ok_or("GPU PCI address is invalid")?;
            u32::try_from(value).map_err(|_| "GPU PCI address is invalid".into())
        };
        let domain = object.get("domain").or_else(|| object.get("segment"))
            .and_then(Value::as_u64).unwrap_or(0);
        (
            u32::try_from(domain).map_err(|_| "GPU PCI address is invalid")?,
            coordinate("bus", None)?,
            coordinate("device", None)?,
            coordinate("function", Some("func"))?,
        )
    } else {
        return Err("GPU PCI address is unavailable".into());
    };
    let (domain, bus, slot, function) = coordinates;
    if domain != 0 || bus > 255 || slot > 31 || function > 7 || (bus, slot, function) == (0, 0, 0) {
        return Err("GPU PCI address is invalid or cannot be represented by the IGCL identity".into());
    }
    Ok((domain, bus, slot, function))
}

fn proof_luid(proof: &Value) -> Result<Option<String>, String> {
    let mut result = None;
    for name in ["osLuid", "controllerLuid", "luid", "adapterLuid"] {
        match proof.get(name) {
            None | Some(Value::Null) => {}
            Some(Value::String(value)) if value.trim().is_empty() => {}
            Some(Value::String(value)) => {
                if result.as_ref().is_some_and(|prior| prior != value) {
                    return Err("the adapter and controller LUIDs disagree".into());
                }
                result = Some(value.clone());
            }
            Some(_) => return Err("GPU LUID identity is invalid".into()),
        }
    }
    Ok(result)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DisplayAliasError { InvalidDisplayKey, StaleTarget, AmbiguousTarget }

/// Rewrite a renderer display key to the selected native inventory key only
/// when the old key identifies exactly one row and that row is the selected
/// device. This mirrors Electron's PNP/legacy alias gate without routing it.
fn rewrite_display_key_alias(
    requested_device_key: &str,
    display_key: &str,
    selected_index: usize,
    devices: &[Value],
) -> Result<String, DisplayAliasError> {
    let (prefix, suffix) = display_key.split_once("|display|").ok_or(DisplayAliasError::InvalidDisplayKey)?;
    if prefix != requested_device_key || suffix.is_empty() || requested_device_key.trim().is_empty() {
        return Err(DisplayAliasError::InvalidDisplayKey);
    }
    let matches = devices.iter().enumerate().filter(|(_, device)| {
        device["deviceKey"].as_str() == Some(requested_device_key)
            || device["deviceKeys"].as_array().is_some_and(|aliases| {
                aliases.iter().any(|alias| alias.as_str() == Some(requested_device_key))
            })
    }).collect::<Vec<_>>();
    if matches.len() > 1 { return Err(DisplayAliasError::AmbiguousTarget); }
    let Some((index, matched)) = matches.first().copied() else { return Err(DisplayAliasError::StaleTarget); };
    if index != selected_index { return Err(DisplayAliasError::StaleTarget); }
    let canonical = matched["deviceKey"].as_str().filter(|value| !value.trim().is_empty())
        .ok_or(DisplayAliasError::StaleTarget)?;
    Ok(format!("{canonical}|display|{suffix}"))
}

/// Public response projection for the staged native quantization control.
/// Every non-null patch field gets an outcome; controls outside the staged
/// slice fail individually so mixed patches cannot look fully successful.
fn display_apply_reply(
    result: &DisplayApplyResult,
    patch: &Value,
    requested_device_key: &str,
    display_state: Option<Value>,
) -> Value {
    let display_state = display_state.map(|state| namespace_display_state(state, requested_device_key))
        .unwrap_or(Value::Null);
    let mut per_control = serde_json::Map::new();
    if requested_device_key.trim().is_empty() {
        per_control.insert("deviceKey".into(), json!({
            "ok": false,
            "errorCode": "stale-target",
            "message": "a stable adapter key is required for the Display result",
        }));
        return json!({ "ok": false, "perControl": per_control, "displayState": display_state });
    }
    let Some(controls) = patch.as_object() else {
        per_control.insert("patch".into(), json!({
            "ok": false,
            "errorCode": "out-of-range",
            "message": "display apply patch must be an object",
        }));
        return json!({ "ok": false, "perControl": per_control, "displayState": display_state });
    };
    for (control, value) in controls.iter().filter(|(_, value)| !value.is_null()) {
        if control != "quantizationRange" {
            per_control.insert(control.clone(), json!({
                "ok": false,
                "errorCode": "unsupported",
                "message": format!("native Display apply does not yet support '{control}'"),
            }));
            continue;
        }
        let public_value = match value.as_str() {
            Some("default") => Some(0),
            Some("limited") => Some(1),
            Some("full") => Some(2),
            _ => None,
        };
        if public_value.is_none() {
            per_control.insert(control.clone(), json!({
                "ok": false,
                "errorCode": "out-of-range",
                "message": "unknown quantization range",
            }));
            continue;
        }
        let mut outcome = json!({ "ok": result.ok, "readBackEqual": result.read_back_equal });
        if let Some(silent_noop) = result.silent_noop {
            outcome["silentNoop"] = json!(silent_noop);
        }
        if !result.ok {
            outcome["errorCode"] = json!(result.error_code.unwrap_or("io-failed"));
            outcome["message"] = json!(result.message.as_deref().unwrap_or("display quantization apply failed"));
        }
        if result.state_may_have_changed { outcome["stateMayHaveChanged"] = json!(true); }
        per_control.insert(control.clone(), outcome);
    }
    let ok = result.ok && per_control.values().all(|control| control["ok"].as_bool() == Some(true));
    json!({ "ok": ok, "perControl": per_control, "displayState": display_state })
}

fn namespace_display_state(mut state: Value, requested_device_key: &str) -> Value {
    if requested_device_key.trim().is_empty() || !state.is_object() { return state; }
    state["deviceKey"] = json!(requested_device_key);
    if let Some(displays) = state.get_mut("displays").and_then(Value::as_array_mut) {
        for display in displays {
            if !display.is_object() { continue; }
            let Some(suffix) = display.get("displayKey").and_then(Value::as_str)
                .and_then(|display_key| display_key.split_once("|display|")
                    .filter(|(_, suffix)| !suffix.is_empty())
                    .map(|(_, suffix)| suffix.to_owned())) else { continue; };
            display["displayKey"] = json!(format!("{requested_device_key}|display|{suffix}"));
        }
    }
    state
}

struct TargetError {
    code: &'static str,
    message: String,
}

fn ensure_target(
    backend: &mut dyn DisplayApplyBackend,
    target: &DisplayApplyTarget<'_>,
) -> Result<(), TargetError> {
    backend
        .assert_device_target(target.device_id, target.device_key, target.physical_target)
        .map_err(|error| TargetError {
            code: "stale-target",
            message: format!("the selected graphics adapter changed; refresh Display and try again: {error}"),
        })?;
    let outputs = backend.active_outputs(target.device_key).map_err(|error| TargetError {
        code: "io-failed",
        message: format!("display output enumeration failed: {error}"),
    })?;
    let matches: Vec<_> = outputs
        .iter()
        .filter(|output| output.display_key == target.display_key)
        .collect();
    if matches.is_empty() {
        return Err(TargetError {
            code: "stale-target",
            message: "the selected display is no longer connected; refresh Display and try again".into(),
        });
    }
    if matches.len() != 1 {
        return Err(TargetError {
            code: "ambiguous-target",
            message: "the selected display is no longer uniquely connected; refresh Display and try again".into(),
        });
    }
    if !matches[0].active || !matches[0].identity_verified {
        return Err(TargetError {
            code: "stale-target",
            message: "the selected display identity is not verified as active; refresh Display and try again".into(),
        });
    }
    Ok(())
}

pub(super) fn display_key_belongs_to_device(device_key: &str, display_key: &str) -> bool {
    display_key
        .split_once("|display|")
        .is_some_and(|(prefix, suffix)| prefix == device_key && !suffix.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use crate::backend::igcl_raw::ctl_display_properties_t;

    const DEVICE_KEY: &str = "pci:gpu-a";
    const DISPLAY_KEY: &str = "pci:gpu-a|display|encoder-a|edid|abcd1234";

    #[derive(Clone, Copy)]
    enum WriteBehavior {
        Exact,
        NoOp,
        ClampToOne,
        FailAfterWrite,
        FailRollback,
    }

    struct FakeBackend {
        key: String,
        active: bool,
        verified: bool,
        duplicate: bool,
        current: i32,
        write_behavior: WriteBehavior,
        output_changes_on_check: Option<usize>,
        target_changes_on_check: Option<usize>,
        output_checks: usize,
        target_checks: usize,
        writes: Vec<i32>,
        read_fail_on: Option<usize>,
        read_change_on: Option<(usize, i32)>,
        reads: usize,
    }

    impl FakeBackend {
        fn new(current: i32) -> Self {
            Self {
                key: DISPLAY_KEY.into(), active: true, verified: true, duplicate: false,
                current, write_behavior: WriteBehavior::Exact,
                output_changes_on_check: None, target_changes_on_check: None,
                output_checks: 0, target_checks: 0, writes: Vec::new(),
                read_fail_on: None, read_change_on: None, reads: 0,
            }
        }
    }

    impl DisplayApplyBackend for FakeBackend {
        fn assert_device_target(
            &mut self,
            device_id: u64,
            expected_device_key: &str,
            physical_target: &Value,
        ) -> Result<(), String> {
            self.target_checks += 1;
            if self.target_changes_on_check == Some(self.target_checks)
                || device_id != 0 || expected_device_key != DEVICE_KEY
                || physical_target != &json!({"bdf": "0000:03:00.0"})
            {
                return Err("physical adapter proof changed".into());
            }
            Ok(())
        }

        fn active_outputs(&mut self, _expected_device_key: &str) -> Result<Vec<DisplayOutputIdentity>, String> {
            self.output_checks += 1;
            if self.output_changes_on_check == Some(self.output_checks) {
                self.key = "pci:gpu-a|display|replacement".into();
            }
            let output = DisplayOutputIdentity {
                display_key: self.key.clone(), active: self.active, identity_verified: self.verified,
            };
            let mut outputs = vec![output.clone()];
            if self.duplicate { outputs.push(output); }
            Ok(outputs)
        }

        fn read_quantization_range(&mut self, _device_key: &str, _display_key: &str) -> Result<i32, String> {
            self.reads += 1;
            if let Some((on, value)) = self.read_change_on { if on == self.reads { self.current = value; } }
            if self.read_fail_on == Some(self.reads) { return Err("fixture read failure".into()); }
            Ok(self.current)
        }

        fn write_quantization_range(&mut self, _device_key: &str, _display_key: &str, value: i32) -> Result<(), String> {
            self.writes.push(value);
            let call = self.writes.len();
            match self.write_behavior {
                WriteBehavior::Exact => self.current = value,
                WriteBehavior::NoOp => {}
                WriteBehavior::ClampToOne => self.current = if call == 1 { 1 } else { value },
                WriteBehavior::FailAfterWrite => { self.current = value; return Err("fixture setter failure".into()); }
                WriteBehavior::FailRollback if call == 1 => { self.current = value; return Err("fixture setter failure".into()); },
                WriteBehavior::FailRollback => return Err("fixture rollback failure".into()),
            }
            Ok(())
        }
    }

    fn target() -> DisplayApplyTarget<'static> {
        // The physical proof is static for the fixture so its borrowed target
        // can be shared across the small transaction tests.
        static PROOF: OnceLock<Value> = OnceLock::new();
        DisplayApplyTarget {
            device_id: 0,
            device_key: DEVICE_KEY,
            physical_target: PROOF.get_or_init(|| json!({"bdf": "0000:03:00.0"})),
            display_key: DISPLAY_KEY,
        }
    }

    fn apply_with_display_lock(
        backend: &mut dyn DisplayApplyBackend,
        target: &DisplayApplyTarget<'_>,
        requested: i32,
    ) -> DisplayApplyResult {
        let display_guard = super::super::display_lock::acquire()
            .expect("the shared Display transaction guard should be available");
        apply_quantization_range(&display_guard, backend, target, requested)
    }

    fn electron_physical_proof() -> Value {
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

    #[test]
    fn missing_display_guard_fails_before_any_quantization_io() {
        let mut backend = FakeBackend::new(0);
        let result = apply_quantization_range_with_guard_state(false, &mut backend, &target(), 2);
        assert!(!result.ok);
        assert_eq!(result.error_code, Some("io-failed"));
        assert!(result.message.as_deref().unwrap().contains("shared Display transaction lock"));
        assert_eq!(backend.target_checks, 0);
        assert_eq!(backend.output_checks, 0);
        assert_eq!(backend.reads, 0);
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn native_output_keys_require_a_unique_active_encoder_before_edid_identity() {
        let mut unique: ctl_display_properties_t = unsafe { std::mem::zeroed() };
        unique.DisplayConfigFlags = 1;
        unique.Os_display_encoder_handle[0] = 1;
        let mut duplicate_a = unique;
        duplicate_a.Os_display_encoder_handle[0] = 2;
        let duplicate_b = duplicate_a;
        let mut inactive = unique;
        inactive.DisplayConfigFlags = 0;
        inactive.Os_display_encoder_handle[0] = 3;
        let outputs = vec![
            (1 as *mut std::ffi::c_void, unique, Some(vec![0x11; 128])),
            (2 as *mut std::ffi::c_void, duplicate_a, Some(vec![0x22; 128])),
            (3 as *mut std::ffi::c_void, duplicate_b, Some(vec![0x33; 128])),
            (4 as *mut std::ffi::c_void, inactive, Some(vec![0x44; 128])),
        ];

        let identities = identify_display_outputs(DEVICE_KEY, &outputs);

        assert!(identities[0].1.active && identities[0].1.identity_verified);
        assert_eq!(identities[0].1.display_key, super::super::display::stable_display_key(
            DEVICE_KEY, &unique, outputs[0].2.as_deref(),
        ).unwrap());
        assert!(identities[1..3].iter().all(|(_, identity)| {
            identity.active && !identity.identity_verified
        }), "different EDID bytes cannot disambiguate a duplicated active encoder");
        assert!(!identities[3].1.active && !identities[3].1.identity_verified);
        assert!(identities[3].1.display_key.is_empty());
    }

    #[test]
    fn electron_physical_proof_normalizes_and_requires_a_derived_selected_key() {
        let proof = electron_physical_proof();
        let expected_native = "pci:0x00008086:0x0000e20b@3:0.0";
        let expected_keys = [
            expected_native,
            "pci:0x8086:0xe20b@3:0.0",
            "pci:0x8086:0xe20b@0000:03:00.0",
        ];
        for expected_key in expected_keys {
            let row = normalize_physical_target(expected_key, &proof).unwrap();
            let identity = gpu_apply_identity::identity_from_row(&row).unwrap();
            assert_eq!(identity.device_key, expected_native);
            assert_eq!(identity.bus, 3);
            assert_eq!(identity.slot, 0);
            assert_eq!(identity.luid.as_deref(), Some("0x00000001:0x00000002"));
        }
        let pnp_key = "pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000";
        assert!(normalize_physical_target(pnp_key, &proof).is_err(), "PNP aliases require inventory uniqueness");

        let mut inventory_row = normalize_physical_proof(&proof).unwrap();
        inventory_row["pnpDeviceId"] = proof["pnpDeviceId"].clone();
        let normalized = normalize_physical_target_from_inventory(pnp_key, &proof, 0, &[inventory_row.clone()]).unwrap();
        assert_eq!(normalized["deviceKey"], json!(expected_native));

        let mut duplicate_proof = electron_physical_proof();
        duplicate_proof["bdf"] = json!("0000:04:00.0");
        duplicate_proof["controllerBdf"] = json!("0000:04:00.0");
        duplicate_proof["osLuid"] = json!("0x00000003:0x00000004");
        duplicate_proof["controllerLuid"] = json!("0x00000003:0x00000004");
        duplicate_proof["legacyDeviceKey"] = json!("pci:0x8086:0xe20b@4:0.0");
        let mut duplicate_row = normalize_physical_proof(&duplicate_proof).unwrap();
        duplicate_row["pnpDeviceId"] = proof["pnpDeviceId"].clone();
        let duplicate_inventory = vec![inventory_row.clone(), duplicate_row.clone()];
        assert!(normalize_physical_target_from_inventory(pnp_key, &proof, 0, &duplicate_inventory)
            .unwrap_err().contains("ambiguous"));

        duplicate_row["pnpDeviceId"] = json!("PCI\\VEN_8086&DEV_E20B&SUBSYS_11111111");
        let reordered_inventory = vec![duplicate_row, inventory_row];
        let normalized = normalize_physical_target_from_inventory(pnp_key, &proof, 1, &reordered_inventory).unwrap();
        assert_eq!(normalized["deviceKey"], json!(expected_native));
    }

    #[test]
    fn full_inventory_rows_do_not_establish_aliases_from_caller_supplied_fields() {
        let proof = electron_physical_proof();
        let mut row = normalize_physical_proof(&proof).unwrap();
        row["pnpDeviceId"] = proof["pnpDeviceId"].clone();
        row["deviceKeys"] = json!(["pnp:forged-alias"]);
        assert!(normalize_physical_target("pnp:forged-alias", &row).is_err());

        row["legacyDeviceKey"] = json!("pnp:forged-alias");
        assert!(normalize_physical_target("pnp:forged-alias", &row).is_err());
    }

    #[test]
    fn electron_physical_proof_rejects_conflicting_or_synthetic_identity_fields() {
        let mut proof = electron_physical_proof();
        proof["legacyDeviceKey"] = json!("pci:0x1002:0xe20b@3:0.0");
        assert!(normalize_physical_target("pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000", &proof).is_err());

        let mut proof = electron_physical_proof();
        proof["pnpDeviceId"] = json!("PCI\\VEN_8086&DEV_1111&SUBSYS_00000000");
        assert!(normalize_physical_target("pnp:PCI\\VEN_8086&DEV_1111&SUBSYS_00000000", &proof).is_err());

        let mut proof = electron_physical_proof();
        proof["controllerBdf"] = json!("0000:04:00.0");
        assert!(normalize_physical_target("pci:0x00008086:0x0000e20b@3:0.0", &proof).is_err());

        let mut proof = electron_physical_proof();
        proof["controllerLuid"] = json!("0x00000003:0x00000004");
        assert!(normalize_physical_target("pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000", &proof).is_err());

        let mut proof = electron_physical_proof();
        proof["synthetic"] = json!(true);
        assert!(normalize_physical_target("pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_00000000", &proof).is_err());

        let mut native_row = normalize_physical_target(
            "pci:0x00008086:0x0000e20b@3:0.0", &electron_physical_proof(),
        ).unwrap();
        native_row["pnpDeviceId"] = json!("PCI\\VEN_1002&DEV_E20B&SUBSYS_00000000");
        assert!(normalize_physical_target("pci:0x00008086:0x0000e20b@3:0.0", &native_row).is_err());
    }

    #[test]
    fn display_key_alias_rewrite_requires_one_current_row_and_the_selected_device() {
        let devices = vec![
            json!({"deviceKey":"pci:native-a", "deviceKeys":["pci:native-a", "pnp:gpu-a"]}),
            json!({"deviceKey":"pci:native-b", "deviceKeys":["pci:native-b", "pnp:gpu-b"]}),
        ];
        assert_eq!(rewrite_display_key_alias(
            "pnp:gpu-a", "pnp:gpu-a|display|encoder-a|edid|hash", 0, &devices,
        ).unwrap(), "pci:native-a|display|encoder-a|edid|hash");
        assert_eq!(rewrite_display_key_alias(
            "pnp:gpu-a", "pnp:gpu-a|display|encoder-a", 1, &devices,
        ), Err(DisplayAliasError::StaleTarget));
        assert_eq!(rewrite_display_key_alias(
            "pnp:gpu-missing", "pnp:gpu-missing|display|encoder-a", 0, &devices,
        ), Err(DisplayAliasError::StaleTarget));
        assert_eq!(rewrite_display_key_alias(
            "pnp:gpu-a", "pnp:gpu-b|display|encoder-a", 0, &devices,
        ), Err(DisplayAliasError::InvalidDisplayKey));

        let ambiguous = vec![devices[0].clone(), json!({
            "deviceKey":"pci:native-c", "deviceKeys":["pci:native-c", "pnp:gpu-a"],
        })];
        assert_eq!(rewrite_display_key_alias(
            "pnp:gpu-a", "pnp:gpu-a|display|encoder-a", 0, &ambiguous,
        ), Err(DisplayAliasError::AmbiguousTarget));
    }

    #[test]
    fn public_reply_reports_mixed_patch_controls_individually() {
        let mut result = DisplayApplyResult::ok();
        result.read_back = Some(2);
        let requested_key = "pnp:renderer-alias";
        let reply = display_apply_reply(&result, &json!({
            "quantizationRange":"full",
            "wireFormat":{"model":"rgb","depth":10},
            "brightness":0.5,
        }), requested_key, Some(json!({
            "deviceKey":"pci:native-key",
            "displays":[
                {"displayKey":"pci:native-key|display|encoder-a|edid|hash"},
                {"displayKey":"unparseable-display-key"},
            ],
        })));
        assert_eq!(reply["ok"], json!(false));
        assert_eq!(reply["perControl"]["quantizationRange"]["ok"], json!(true));
        assert_eq!(reply["perControl"]["quantizationRange"]["readBackEqual"], json!(true));
        for control in ["wireFormat", "brightness"] {
            assert_eq!(reply["perControl"][control]["ok"], json!(false));
            assert_eq!(reply["perControl"][control]["errorCode"], json!("unsupported"));
        }
        assert_eq!(reply["displayState"]["deviceKey"], json!(requested_key));
        assert_eq!(reply["displayState"]["displays"][0]["displayKey"],
            json!("pnp:renderer-alias|display|encoder-a|edid|hash"));
        assert_eq!(reply["displayState"]["displays"][1]["displayKey"], json!("unparseable-display-key"));

        let quantization_only = display_apply_reply(&result, &json!({"quantizationRange":"full"}), requested_key, None);
        assert_eq!(quantization_only["ok"], json!(true));
        assert_eq!(quantization_only["perControl"].as_object().unwrap().len(), 1);

        let malformed = display_apply_reply(&result, &json!(["not", "an", "object"]), requested_key, None);
        assert_eq!(malformed["ok"], json!(false));
        assert_eq!(malformed["perControl"]["patch"]["ok"], json!(false));
        assert_eq!(malformed["perControl"]["patch"]["errorCode"], json!("out-of-range"));

        let missing_key = display_apply_reply(&result, &json!({"quantizationRange":"full"}), " ", None);
        assert_eq!(missing_key["ok"], json!(false));
        assert_eq!(missing_key["perControl"]["deviceKey"]["errorCode"], json!("stale-target"));
    }

    #[test]
    fn exact_set_is_confirmed_by_fresh_readback() {
        let mut backend = FakeBackend::new(0);
        let result = apply_with_display_lock(&mut backend, &target(), 2);
        assert!(result.ok);
        assert!(result.read_back_equal);
        assert_eq!(result.read_back, Some(2));
        assert_eq!(result.silent_noop, Some(false));
        assert!(!result.rollback_attempted);
        assert_eq!(backend.writes, vec![2]);
    }

    #[test]
    fn invalid_or_mismatched_identity_is_rejected_before_io() {
        let mut backend = FakeBackend::new(0);
        let mut invalid = target();
        invalid.display_key = "pci:other|display|encoder-a";
        let result = apply_with_display_lock(&mut backend, &invalid, 2);
        assert_eq!(result.error_code, Some("stale-target"));
        assert!(backend.writes.is_empty());
        assert_eq!(backend.target_checks, 0);

        let mut backend = FakeBackend::new(0);
        backend.target_changes_on_check = Some(1);
        let result = apply_with_display_lock(&mut backend, &target(), 2);
        assert_eq!(result.error_code, Some("stale-target"));
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn ambiguous_inactive_and_unverified_outputs_fail_closed() {
        for configure in [0, 1, 2] {
            let mut backend = FakeBackend::new(0);
            match configure {
                0 => backend.duplicate = true,
                1 => backend.active = false,
                _ => backend.verified = false,
            }
            let result = apply_with_display_lock(&mut backend, &target(), 1);
            assert!(!result.ok);
            assert!(backend.writes.is_empty());
        }
    }

    #[test]
    fn duplicate_active_output_identity_is_rejected_before_control_io() {
        let mut backend = FakeBackend::new(0);
        backend.duplicate = true;
        let result = apply_with_display_lock(&mut backend, &target(), 1);
        assert_eq!(result.error_code, Some("ambiguous-target"));
        assert_eq!(backend.reads, 0, "an ambiguous output must be rejected before reading or writing its setting");
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn successful_set_that_silently_does_nothing_is_not_reported_as_applied() {
        let mut backend = FakeBackend::new(0);
        backend.write_behavior = WriteBehavior::NoOp;
        let result = apply_with_display_lock(&mut backend, &target(), 2);
        assert!(!result.ok);
        assert!(!result.read_back_equal);
        assert_eq!(result.silent_noop, Some(true));
        assert_eq!(result.read_back, Some(0));
        assert!(!result.rollback_attempted, "the original value is already present");
        assert_eq!(backend.writes, vec![2]);
        let reply = display_apply_reply(&result, &json!({"quantizationRange":"full"}), DEVICE_KEY, None);
        assert_eq!(reply["perControl"]["quantizationRange"]["silentNoop"], json!(true));
    }

    #[test]
    fn third_value_is_not_overwritten_by_rollback() {
        let mut backend = FakeBackend::new(0);
        backend.write_behavior = WriteBehavior::ClampToOne;
        let result = apply_with_display_lock(&mut backend, &target(), 2);
        assert!(!result.ok);
        assert!(!result.rollback_attempted);
        assert!(result.state_may_have_changed);
        assert_eq!(result.read_back, Some(1));
        assert_eq!(backend.writes, vec![2]);
    }

    #[test]
    fn setter_error_after_mutation_attempts_compensating_restore() {
        let mut backend = FakeBackend::new(0);
        backend.write_behavior = WriteBehavior::FailAfterWrite;
        let result = apply_with_display_lock(&mut backend, &target(), 2);
        assert!(!result.ok);
        assert!(result.rollback_attempted);
        assert!(result.rollback_verified);
        assert_eq!(result.read_back, Some(0));
        assert_eq!(backend.writes, vec![2, 0]);
    }

    #[test]
    fn rollback_failure_is_reported_without_claiming_restoration() {
        let mut backend = FakeBackend::new(0);
        backend.write_behavior = WriteBehavior::FailRollback;
        let result = apply_with_display_lock(&mut backend, &target(), 2);
        assert!(!result.ok);
        assert!(result.rollback_attempted);
        assert!(!result.rollback_verified);
        assert_eq!(result.read_back, Some(2));
        assert!(result.message.unwrap().contains("rollback read-back 2"));
    }

    #[test]
    fn output_topology_change_before_set_never_reuses_the_old_target() {
        let mut backend = FakeBackend::new(0);
        // First resolution is valid; the second models a hotplug during
        // preflight. The changed display key must stop the transaction.
        backend.output_changes_on_check = Some(2);
        let result = apply_with_display_lock(&mut backend, &target(), 2);
        assert_eq!(result.error_code, Some("stale-target"));
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn target_changing_after_set_prevents_a_misdirected_rollback() {
        let mut backend = FakeBackend::new(0);
        backend.write_behavior = WriteBehavior::FailAfterWrite;
        // Target checks: before read, before pre-write read, before set,
        // after set/readback, then rollback. Change the adapter proof at the
        // last check so compensation is not sent to a possibly new output.
        backend.target_changes_on_check = Some(5);
        let result = apply_with_display_lock(&mut backend, &target(), 2);
        assert!(!result.ok);
        assert!(!result.rollback_attempted);
        assert!(!result.rollback_verified);
        assert_eq!(backend.writes, vec![2]);
        assert!(result.message.unwrap().contains("rollback skipped"));
    }

    #[test]
    fn unreadable_or_externally_changed_state_is_never_overwritten() {
        let mut unreadable = FakeBackend::new(0);
        unreadable.read_fail_on = Some(3);
        let result = apply_with_display_lock(&mut unreadable, &target(), 2);
        assert!(!result.rollback_attempted && result.state_may_have_changed);
        assert_eq!(unreadable.writes, vec![2]);

        let mut changed = FakeBackend::new(0);
        changed.write_behavior = WriteBehavior::FailAfterWrite;
        changed.read_change_on = Some((4, 1));
        let result = apply_with_display_lock(&mut changed, &target(), 2);
        assert!(!result.rollback_attempted && result.state_may_have_changed);
        assert_eq!(changed.writes, vec![2]);
    }

    #[test]
    fn out_of_range_request_does_not_touch_the_backend() {
        let mut backend = FakeBackend::new(0);
        let result = apply_with_display_lock(&mut backend, &target(), 3);
        assert_eq!(result.error_code, Some("out-of-range"));
        assert_eq!(backend.target_checks, 0);
        assert!(backend.writes.is_empty());
        assert_eq!(QuantizationRange::Full.igcl_value(), 2);
    }
}
