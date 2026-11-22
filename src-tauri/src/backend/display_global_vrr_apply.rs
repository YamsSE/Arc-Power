//! Private transaction core for the adapter-wide Display Global VRR mode.
//!
//! This mirrors the Electron feature-14 enum write and fresh read-back. Some
//! driver versions require feature 15 to select the global scope after the
//! first feature-14 request returns `ERROR_INVALID_ARGUMENT`; that retry is
//! included. The transaction is not connected to `display:apply`.
//!
//! Electron retries `ERROR_INSUFFICIENT_PERMISSIONS` through an identity-
//! matched display-class registry write. The native transaction uses the
//! fakeable resolver in `display_global_vrr_registry` and requires its caller
//! to be an elevated host before production routing is enabled.

use super::{
    display_lock::DisplayLockGuard,
    gpu_apply_identity::{self, ApplyIdentity},
    gpu_capabilities,
    gpu_devices,
    igcl_raw::ctl_3d_feature_details_t,
    igcl_read_only::{IgclError, ReadOnlyIgcl},
};
use serde_json::Value;
use std::path::Path;

const GLOBAL_VRR_FEATURE: i32 = 14;
const GLOBAL_OR_PER_APP_FEATURE: i32 = 15;
const ENUM_VALUE_TYPE: i32 = 4;
const ERROR_INSUFFICIENT_PERMISSIONS: u32 = 0x4000_0006;
const ERROR_INVALID_ARGUMENT: u32 = 0x4000_000b;

const MODES: [(u32, &str); 3] = [
    (0, "fullscreen"),
    (1, "fullscreen-windowed"),
    (2, "disabled"),
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct GlobalVrrCapabilities {
    pub supported_types: u64,
    pub global_scope_selector: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GlobalVrrDriverError {
    pub status: Option<u32>,
    pub message: String,
}

impl GlobalVrrDriverError {
    fn code(&self) -> &'static str {
        match self.status {
            Some(ERROR_INSUFFICIENT_PERMISSIONS) => "permission-denied",
            Some(ERROR_INVALID_ARGUMENT) => "invalid-argument",
            Some(0x4000_000a) => "unsupported",
            _ => "io-failed",
        }
    }
}

/// Small injected surface used by the transaction core and fake-driver tests.
pub(crate) trait GlobalVrrApplyApi {
    fn capabilities(&mut self) -> Result<Option<GlobalVrrCapabilities>, String>;
    fn read_mode(&mut self) -> Result<u32, GlobalVrrDriverError>;
    fn select_global_scope(&mut self) -> Result<(), GlobalVrrDriverError>;
    fn write_mode(&mut self, value: u32) -> Result<(), GlobalVrrDriverError>;
    fn write_registry_mode(&mut self, value: u32) -> Result<(), super::display_global_vrr_registry::VrrRegistryError>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct GlobalVrrApplyResult {
    pub ok: bool,
    pub error_code: Option<&'static str>,
    pub message: Option<String>,
    pub read_back_equal: bool,
    pub read_back: Option<&'static str>,
    pub scope_selected: bool,
    pub registry_fallback: bool,
    /// `None` is a pre-SET decline, `Some(false)` an attempted but failed
    /// write transport, and `Some(true)` a successful direct or registry SET.
    pub setter_succeeded: Option<bool>,
    /// Electron uses its fail helper for scope-selection errors on GET and
    /// omits read-back/silent-noop fields in that specific post-SET branch.
    pub readback_reported: bool,
    /// A failed SET or unverified GET can leave the requested state uncertain.
    pub state_may_have_changed: bool,
}

impl GlobalVrrApplyResult {
    fn success(mode: &'static str, scope_selected: bool, registry_fallback: bool) -> Self {
        Self {
            ok: true,
            error_code: None,
            message: None,
            read_back_equal: true,
            read_back: Some(mode),
            scope_selected,
            registry_fallback,
            setter_succeeded: Some(true),
            readback_reported: true,
            state_may_have_changed: false,
        }
    }

    fn failed(
        code: &'static str,
        message: impl Into<String>,
        scope_selected: bool,
        state_may_have_changed: bool,
    ) -> Self {
        Self {
            ok: false,
            error_code: Some(code),
            message: Some(message.into()),
            read_back_equal: false,
            read_back: None,
            scope_selected,
            registry_fallback: false,
            setter_succeeded: None,
            readback_reported: false,
            state_may_have_changed,
        }
    }

    fn with_setter_succeeded(mut self, succeeded: bool) -> Self {
        self.setter_succeeded = Some(succeeded);
        self
    }

    fn with_registry_fallback(mut self, used: bool) -> Self {
        self.registry_fallback = used;
        self
    }

    fn with_readback_reported(mut self, reported: bool) -> Self {
        self.readback_reported = reported;
        self
    }

    pub(crate) fn per_control_value(&self) -> Value {
        let mut result = serde_json::Map::new();
        result.insert("ok".into(), Value::Bool(self.ok));
        if self.setter_succeeded == Some(true) && self.readback_reported {
            result.insert("readBackEqual".into(), serde_json::json!(self.read_back_equal));
            result.insert("silentNoop".into(), serde_json::json!(!self.read_back_equal));
        }
        if !self.ok {
            if let Some(code) = self.error_code { result.insert("errorCode".into(), serde_json::json!(code)); }
            if let Some(message) = &self.message { result.insert("message".into(), serde_json::json!(message)); }
        }
        if self.registry_fallback && self.readback_reported {
            result.insert("writeTransport".into(), serde_json::json!("registry"));
        }
        Value::Object(result)
    }
}

/// Callers must hold the shared Display mutex from before identity revalidation
/// through this full SET and read-back transaction. The service invokes this
/// only after complete Display ownership/capability preflight and holds the
/// guard through its fresh public response.
pub(crate) fn apply_global_vrr_mode(
    _display_guard: &DisplayLockGuard,
    api: &mut dyn GlobalVrrApplyApi,
    requested: &str,
) -> GlobalVrrApplyResult {
    let Some((requested_value, requested_name)) = MODES.iter()
        .find(|(_, name)| *name == requested)
        .copied()
    else {
        return GlobalVrrApplyResult::failed(
            "out-of-range",
            format!("unknown global Variable Refresh Rate Mode '{requested}'"),
            false,
            false,
        );
    };

    let capabilities = match api.capabilities() {
        Ok(Some(capabilities)) => capabilities,
        Ok(None) => return GlobalVrrApplyResult::failed(
            "unsupported",
            "the driver does not expose the global Variable Refresh Rate Mode feature",
            false,
            false,
        ),
        Err(error) => return GlobalVrrApplyResult::failed("io-failed", error, false, false),
    };
    if capabilities.supported_types & (1_u64 << requested_value) == 0 {
        return GlobalVrrApplyResult::failed(
            "unsupported",
            "the requested global Variable Refresh Rate Mode is not advertised by this driver",
            false,
            false,
        );
    }

    let mut scope_selected = false;
    let mut registry_fallback = false;
    match api.write_mode(requested_value) {
        Ok(()) => {}
        Err(error) if error.status == Some(ERROR_INVALID_ARGUMENT) => {
            if !capabilities.global_scope_selector {
                return GlobalVrrApplyResult::failed(
                    "unsupported",
                    "the driver requires global VRR scope selection, but does not expose the scope selector",
                    false,
                    true,
                ).with_setter_succeeded(false);
            }
            if let Err(scope_error) = api.select_global_scope() {
                return GlobalVrrApplyResult::failed(
                    scope_error.code(),
                    format!("IGCL global VRR scope selection failed: {}", scope_error.message),
                    false,
                    true,
                ).with_setter_succeeded(false);
            }
            scope_selected = true;
            match api.write_mode(requested_value) {
                Ok(()) => {}
                Err(retry_error) if retry_error.status == Some(ERROR_INSUFFICIENT_PERMISSIONS) => {
                    if let Err(failure) = write_registry_fallback(api, requested_value, scope_selected) {
                        return failure;
                    }
                    registry_fallback = true;
                }
                Err(retry_error) => return GlobalVrrApplyResult::failed(
                    retry_error.code(),
                    format!("IGCL global VRR write failed after selecting GLOBAL scope: {}", retry_error.message),
                    scope_selected,
                    true,
                ).with_setter_succeeded(false),
            }
        }
        Err(error) if error.status == Some(ERROR_INSUFFICIENT_PERMISSIONS) => {
            if let Err(failure) = write_registry_fallback(api, requested_value, false) {
                return failure;
            }
            registry_fallback = true;
        }
        Err(error) => {
            return GlobalVrrApplyResult::failed(
                error.code(),
                format!("IGCL global VRR write failed: {}.", error.message),
                false,
                true,
            ).with_setter_succeeded(false);
        }
    }

    let read_back = match api.read_mode() {
        Ok(value) => value,
        Err(error) if error.status == Some(ERROR_INVALID_ARGUMENT) => {
            if !capabilities.global_scope_selector {
                return GlobalVrrApplyResult::failed(
                    "unsupported",
                    "the driver requires global VRR scope selection for read-back, but does not expose the scope selector",
                    scope_selected,
                    true,
                ).with_setter_succeeded(true).with_registry_fallback(registry_fallback);
            }
            if let Err(scope_error) = api.select_global_scope() {
                return GlobalVrrApplyResult::failed(
                    scope_error.code(),
                    format!("IGCL global VRR scope selection for read-back failed: {}", scope_error.message),
                    scope_selected,
                    true,
                ).with_setter_succeeded(true).with_registry_fallback(registry_fallback);
            }
            scope_selected = true;
            match api.read_mode() {
                Ok(value) => value,
                Err(read_error) => return GlobalVrrApplyResult::failed(
                    read_error.code(),
                    format!("Global Variable Refresh Rate Mode read-back failed after selecting GLOBAL scope: {}", read_error.message),
                    scope_selected,
                    true,
                ).with_setter_succeeded(true).with_registry_fallback(registry_fallback)
                    .with_readback_reported(true),
            }
        }
        Err(error) => return GlobalVrrApplyResult::failed(
            error.code(),
            format!("Global Variable Refresh Rate Mode read-back failed: {}", error.message),
            scope_selected,
            true,
        ).with_setter_succeeded(true).with_registry_fallback(registry_fallback)
            .with_readback_reported(true),
    };
    let read_back_name = MODES.iter().find_map(|(value, name)| (*value == read_back).then_some(*name));
    if read_back == requested_value {
        return GlobalVrrApplyResult::success(requested_name, scope_selected, registry_fallback);
    }
    GlobalVrrApplyResult {
        ok: false,
        error_code: Some("io-failed"),
        message: Some(format!(
            "global Variable Refresh Rate read-back {} != requested {requested_name}",
            read_back_name.unwrap_or("unknown"),
        )),
        read_back_equal: false,
        read_back: read_back_name,
        scope_selected,
        registry_fallback,
        setter_succeeded: Some(true),
        readback_reported: true,
        state_may_have_changed: true,
    }
}

fn write_registry_fallback(
    api: &mut dyn GlobalVrrApplyApi,
    requested_value: u32,
    scope_selected: bool,
) -> Result<(), GlobalVrrApplyResult> {
    api.write_registry_mode(requested_value).map_err(|error| {
        GlobalVrrApplyResult::failed(error.code(), error.message(), scope_selected, false)
            .with_setter_succeeded(false)
    })
}

/// Decode the capability details exactly as the Display reader does. The
/// adapter-wide feature uses Value[0..8] as the supported enum bitset.
pub(crate) fn capabilities_from_details(
    details: &[ctl_3d_feature_details_t],
) -> Option<GlobalVrrCapabilities> {
    let feature = details.iter().find(|detail| detail.FeatureType == GLOBAL_VRR_FEATURE)?;
    if feature.ValueType != ENUM_VALUE_TYPE { return None; }
    let supported_types = u64::from_le_bytes(feature.Value[0..8].try_into().ok()?);
    Some(GlobalVrrCapabilities {
        supported_types,
        global_scope_selector: details.iter().any(|detail| {
            detail.FeatureType == GLOBAL_OR_PER_APP_FEATURE && detail.ValueType == ENUM_VALUE_TYPE
        }),
    })
}

/// Resolve the selected native Intel row from a fresh inventory. A stale
/// ordinal, duplicate key, OS-only row, or malformed physical identity is a
/// refusal; the returned proof is then revalidated when the adapter is opened.
fn row_from_inventory<'a>(
    device_id: u64,
    expected_device_key: &str,
    inventory: &'a Value,
) -> Result<&'a Value, String> {
    if device_id > 9_007_199_254_740_991 || expected_device_key.trim().is_empty() {
        return Err("the selected graphics adapter identity is invalid".into());
    }
    let rows = inventory.as_array().ok_or("native GPU inventory is unavailable")?;
    let mut matches = rows.iter().filter(|row| {
        row["deviceKey"].as_str() == Some(expected_device_key)
    });
    let row = matches.next().ok_or("the selected graphics adapter no longer exists")?;
    if matches.next().is_some() {
        return Err("the selected graphics adapter identity is ambiguous".into());
    }
    if row["id"].as_u64() != Some(device_id)
        || row["synthetic"].as_bool() == Some(true)
        || row["backendKind"].as_str() == Some("os")
    {
        return Err("the selected graphics adapter ordinal or kind changed".into());
    }
    let identity = gpu_apply_identity::identity_from_row(row)?;
    if identity.device_key != expected_device_key {
        return Err("the selected graphics adapter key does not match its physical identity".into());
    }
    Ok(row)
}

fn identity_from_inventory(
    device_id: u64,
    expected_device_key: &str,
    inventory: &Value,
) -> Result<ApplyIdentity, String> {
    gpu_apply_identity::identity_from_row(row_from_inventory(device_id, expected_device_key, inventory)?)
}

/// Identity-bound production entry point for the native Display service.
/// It requires the shared Display guard, resolves the current ordinal and
/// stable key from native inventory, reopens by PCI/BDF proof, and verifies
/// the reopened adapter before any feature-14 SET.
pub(crate) fn apply_global_vrr_mode_native(
    _display_guard: &DisplayLockGuard,
    dll_path: &Path,
    device_id: u64,
    expected_device_key: &str,
    requested: &str,
) -> GlobalVrrApplyResult {
    let inventory = match gpu_devices::list_devices(dll_path) {
        Ok(inventory) => inventory,
        Err(error) => return GlobalVrrApplyResult::failed(
            "io-failed", format!("native GPU identity refresh failed: {error}"), false, false,
        ),
    };
    let registry_device = match row_from_inventory(device_id, expected_device_key, &inventory) {
        Ok(row) => row.clone(),
        Err(error) => return GlobalVrrApplyResult::failed("stale-target", error, false, false),
    };
    let expected_identity = match gpu_apply_identity::identity_from_row(&registry_device) {
        Ok(identity) => identity,
        Err(error) => return GlobalVrrApplyResult::failed("stale-target", error, false, false),
    };
    let (mut session, adapter_index, adapter_row) = match gpu_capabilities::open_for_identity(dll_path, &expected_identity) {
        Ok(opened) => opened,
        Err(error) => return GlobalVrrApplyResult::failed(
            "stale-target", format!("the selected graphics adapter could not be reopened: {error}"), false, false,
        ),
    };
    let operation: Result<GlobalVrrApplyResult, String> = (|| {
        let current_identity = gpu_apply_identity::identity_from_row(&adapter_row)?;
        gpu_apply_identity::ensure_same_target(&expected_identity, &current_identity)?;
        if !session.display_igsc_full_available() || !session.display_global_vrr_api_available() {
            return Ok(GlobalVrrApplyResult::failed(
                "unsupported",
                "the global Variable Refresh Rate Mode API is not available in this IGCL runtime",
                false,
                false,
            ));
        }
        let details = session.supported_3d_features(adapter_index).map_err(|error| error.to_string())?;
        let Some(capabilities) = capabilities_from_details(&details) else {
            return Ok(GlobalVrrApplyResult::failed(
                "unsupported",
                "the driver does not expose the global Variable Refresh Rate Mode feature",
                false,
                false,
            ));
        };
        let mut api = NativeGlobalVrrApplyApi {
            session: &mut session,
            adapter_index,
            capabilities,
            registry_device: &registry_device,
        };
        Ok(apply_global_vrr_mode(_display_guard, &mut api, requested))
    })();
    let close = session.close().map_err(|error| error.to_string());
    match (operation, close) {
        (Ok(result), Ok(())) => result,
        (Ok(mut result), Err(error)) => {
            result.ok = false;
            result.error_code = Some("io-failed");
            result.message = Some(format!("IGCL session cleanup failed after the VRR transaction: {error}"));
            result
        }
        (Err(error), Ok(())) => GlobalVrrApplyResult::failed("stale-target", error, false, false),
        (Err(error), Err(close)) => GlobalVrrApplyResult::failed(
            "io-failed", format!("{error}; IGCL session cleanup failed: {close}"), false, false,
        ),
    }
}

struct NativeGlobalVrrApplyApi<'a> {
    session: &'a mut ReadOnlyIgcl,
    adapter_index: usize,
    capabilities: GlobalVrrCapabilities,
    registry_device: &'a Value,
}

impl GlobalVrrApplyApi for NativeGlobalVrrApplyApi<'_> {
    fn capabilities(&mut self) -> Result<Option<GlobalVrrCapabilities>, String> {
        Ok(Some(self.capabilities))
    }

    fn read_mode(&mut self) -> Result<u32, GlobalVrrDriverError> {
        self.session.display_global_vrr_mode(self.adapter_index).map_err(driver_error)
    }

    fn select_global_scope(&mut self) -> Result<(), GlobalVrrDriverError> {
        self.session.set_3d_scope(self.adapter_index, false, "").map_err(driver_error)
    }

    fn write_mode(&mut self, value: u32) -> Result<(), GlobalVrrDriverError> {
        self.session.write_3d_enum(self.adapter_index, GLOBAL_VRR_FEATURE, value, "").map_err(driver_error)
    }

    fn write_registry_mode(&mut self, value: u32) -> Result<(), super::display_global_vrr_registry::VrrRegistryError> {
        let mut registry = super::display_global_vrr_registry::SystemVrrRegistry;
        super::display_global_vrr_registry::set_global_vrr_mode(&mut registry, self.registry_device, value)
    }
}

fn driver_error(error: IgclError) -> GlobalVrrDriverError {
    GlobalVrrDriverError { status: error.status, message: error.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[derive(Default)]
    struct FakeApi {
        capabilities: Option<GlobalVrrCapabilities>,
        capability_error: Option<String>,
        writes: Vec<u32>,
        write_results: VecDeque<Result<(), GlobalVrrDriverError>>,
        scopes: usize,
        scope_result: Option<Result<(), GlobalVrrDriverError>>,
        read_result: Option<Result<u32, GlobalVrrDriverError>>,
        registry_writes: Vec<u32>,
        registry_result: Option<Result<(), super::super::display_global_vrr_registry::VrrRegistryError>>,
    }

    impl GlobalVrrApplyApi for FakeApi {
        fn capabilities(&mut self) -> Result<Option<GlobalVrrCapabilities>, String> {
            if let Some(error) = &self.capability_error { return Err(error.clone()); }
            Ok(self.capabilities)
        }

        fn read_mode(&mut self) -> Result<u32, GlobalVrrDriverError> {
            self.read_result.take().unwrap_or(Ok(0))
        }

        fn select_global_scope(&mut self) -> Result<(), GlobalVrrDriverError> {
            self.scopes += 1;
            self.scope_result.take().unwrap_or(Ok(()))
        }

        fn write_mode(&mut self, value: u32) -> Result<(), GlobalVrrDriverError> {
            self.writes.push(value);
            self.write_results.pop_front().unwrap_or(Ok(()))
        }

        fn write_registry_mode(&mut self, value: u32) -> Result<(), super::super::display_global_vrr_registry::VrrRegistryError> {
            self.registry_writes.push(value);
            self.registry_result.take().unwrap_or(Ok(()))
        }
    }

    fn caps(mask: u64) -> GlobalVrrCapabilities {
        GlobalVrrCapabilities { supported_types: mask, global_scope_selector: true }
    }

    fn driver_error(status: u32, message: &str) -> GlobalVrrDriverError {
        GlobalVrrDriverError { status: Some(status), message: message.into() }
    }

    fn apply(api: &mut FakeApi, requested: &str) -> GlobalVrrApplyResult {
        let guard = super::super::display_lock::acquire().expect("display mutex");
        apply_global_vrr_mode(&guard, api, requested)
    }

    #[test]
    fn direct_write_is_verified_by_a_fresh_get() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            read_result: Some(Ok(1)),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "fullscreen-windowed");
        assert!(result.ok);
        assert_eq!(result.read_back, Some("fullscreen-windowed"));
        assert!(result.read_back_equal);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(!result.registry_fallback);
        assert_eq!(api.writes, vec![1]);
        assert_eq!(api.scopes, 0);
    }

    #[test]
    fn invalid_or_unadvertised_mode_does_not_write() {
        let mut api = FakeApi { capabilities: Some(caps(0b001)), ..FakeApi::default() };
        assert_eq!(apply(&mut api, "nope").error_code, Some("out-of-range"));
        assert_eq!(apply(&mut api, "disabled").error_code, Some("unsupported"));
        assert!(api.writes.is_empty());
    }

    #[test]
    fn invalid_argument_selects_global_scope_then_retries_once() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            write_results: VecDeque::from([
                Err(driver_error(ERROR_INVALID_ARGUMENT, "scope required")),
                Ok(()),
            ]),
            read_result: Some(Ok(2)),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "disabled");
        assert!(result.ok);
        assert!(result.scope_selected);
        assert_eq!(api.scopes, 1);
        assert_eq!(api.writes, vec![2, 2]);
        assert_eq!(result.setter_succeeded, Some(true));
    }

    #[test]
    fn scope_failure_stops_before_retrying_the_vrr_write() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            write_results: VecDeque::from([Err(driver_error(ERROR_INVALID_ARGUMENT, "scope required"))]),
            scope_result: Some(Err(driver_error(ERROR_INSUFFICIENT_PERMISSIONS, "denied"))),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "disabled");
        assert_eq!(result.error_code, Some("permission-denied"));
        assert_eq!(result.setter_succeeded, Some(false));
        assert!(api.registry_writes.is_empty());
        assert_eq!(api.scopes, 1);
        assert_eq!(api.writes, vec![2]);
    }

    #[test]
    fn insufficient_permissions_uses_registry_then_requires_fresh_igcl_readback() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            write_results: VecDeque::from([Err(driver_error(ERROR_INSUFFICIENT_PERMISSIONS, "denied"))]),
            read_result: Some(Ok(1)),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "fullscreen-windowed");
        assert!(result.ok);
        assert!(result.registry_fallback);
        assert_eq!(result.setter_succeeded, Some(true));
        assert_eq!(result.read_back, Some("fullscreen-windowed"));
        assert_eq!(result.per_control_value()["writeTransport"], "registry");
        assert_eq!(result.per_control_value()["silentNoop"], false);
        assert_eq!(api.writes, vec![1]);
        assert_eq!(api.registry_writes, vec![1]);
        assert_eq!(api.scopes, 0);
    }

    #[test]
    fn registry_fallback_failure_is_reported_without_a_broker_retry_signal() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            write_results: VecDeque::from([Err(driver_error(ERROR_INSUFFICIENT_PERMISSIONS, "denied"))]),
            registry_result: Some(Err(super::super::display_global_vrr_registry::VrrRegistryError::TargetNotFound)),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "fullscreen-windowed");
        assert!(!result.ok);
        assert_eq!(result.error_code, Some("registry-target-not-found"));
        assert_eq!(result.setter_succeeded, Some(false));
        assert!(!result.registry_fallback);
        assert_eq!(api.registry_writes, vec![1]);
        let per = result.per_control_value();
        assert_eq!(per["errorCode"], "registry-target-not-found");
        assert!(per.get("silentNoop").is_none());
        assert!(per.get("writeTransport").is_none());
    }

    #[test]
    fn other_igcl_write_failures_never_use_the_registry_fallback() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            write_results: VecDeque::from([Err(driver_error(0x4000_000a, "unsupported"))]),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "fullscreen");
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, Some(false));
        assert!(api.registry_writes.is_empty());
    }

    #[test]
    fn scoped_retry_can_use_registry_and_readback_mismatch_is_a_silent_noop() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            write_results: VecDeque::from([
                Err(driver_error(ERROR_INVALID_ARGUMENT, "scope required")),
                Err(driver_error(ERROR_INSUFFICIENT_PERMISSIONS, "denied")),
            ]),
            read_result: Some(Ok(0)),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "fullscreen-windowed");
        assert!(!result.ok);
        assert!(result.registry_fallback);
        assert_eq!(result.setter_succeeded, Some(true));
        assert_eq!(api.scopes, 1);
        assert_eq!(api.writes, vec![1, 1]);
        assert_eq!(api.registry_writes, vec![1]);
        assert_eq!(result.per_control_value()["readBackEqual"], false);
        assert_eq!(result.per_control_value()["silentNoop"], true);
        assert_eq!(result.per_control_value()["writeTransport"], "registry");
    }

    #[test]
    fn prewrite_declines_do_not_claim_a_set_or_add_silent_noop_fields() {
        let mut api = FakeApi { capabilities: Some(caps(0b001)), ..FakeApi::default() };
        let result = apply(&mut api, "disabled");
        assert_eq!(result.setter_succeeded, None);
        let per = result.per_control_value();
        assert_eq!(per["errorCode"], "unsupported");
        assert!(per.get("silentNoop").is_none());
        assert!(per.get("readBackEqual").is_none());
        assert!(api.writes.is_empty());
        assert!(api.registry_writes.is_empty());
    }

    #[test]
    fn successful_set_with_mismatched_readback_is_not_reported_as_applied() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            read_result: Some(Ok(0)),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "disabled");
        assert!(!result.ok);
        assert!(!result.read_back_equal);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(result.state_may_have_changed);
        assert_eq!(result.read_back, Some("fullscreen"));
        assert_eq!(result.error_code, Some("io-failed"));
        assert_eq!(result.per_control_value()["silentNoop"], true);
    }

    #[test]
    fn successful_set_with_unavailable_readback_is_a_silent_noop() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            read_result: Some(Err(driver_error(0x4000_000a, "read refused"))),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "fullscreen-windowed");
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(!result.read_back_equal);
        assert_eq!(result.per_control_value()["silentNoop"], true);
        assert!(api.registry_writes.is_empty(), "GET failures must not start a registry write fallback");
    }

    #[test]
    fn invalid_argument_on_readback_selects_global_scope_and_retries_get_once() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            read_result: Some(Err(driver_error(ERROR_INVALID_ARGUMENT, "scope required"))),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "fullscreen");
        assert!(result.ok);
        assert!(result.scope_selected);
        assert_eq!(api.scopes, 1);
        assert_eq!(api.writes, vec![0]);
    }

    #[test]
    fn readback_scope_failure_omits_electron_fail_branch_fields_without_retrying_set() {
        let mut api = FakeApi {
            capabilities: Some(caps(0b111)),
            read_result: Some(Err(driver_error(ERROR_INVALID_ARGUMENT, "scope required"))),
            scope_result: Some(Err(driver_error(ERROR_INSUFFICIENT_PERMISSIONS, "scope denied"))),
            ..FakeApi::default()
        };
        let result = apply(&mut api, "fullscreen");
        assert!(!result.ok);
        assert_eq!(result.setter_succeeded, Some(true));
        assert!(!result.readback_reported);
        assert_eq!(api.writes, vec![0]);
        assert!(api.registry_writes.is_empty());
        let per = result.per_control_value();
        assert!(per.get("readBackEqual").is_none());
        assert!(per.get("silentNoop").is_none());
        assert!(per.get("writeTransport").is_none());
    }

    #[test]
    fn capability_details_require_enum_feature_and_decode_advertised_bits() {
        let mut vrr: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
        vrr.FeatureType = GLOBAL_VRR_FEATURE;
        vrr.ValueType = ENUM_VALUE_TYPE;
        vrr.Value[0..8].copy_from_slice(&0b101_u64.to_le_bytes());
        let mut scope: ctl_3d_feature_details_t = unsafe { std::mem::zeroed() };
        scope.FeatureType = GLOBAL_OR_PER_APP_FEATURE;
        scope.ValueType = ENUM_VALUE_TYPE;
        let capabilities = capabilities_from_details(&[vrr, scope]).unwrap();
        assert_eq!(capabilities.supported_types, 0b101);
        assert!(capabilities.global_scope_selector);

        vrr.ValueType = 2;
        assert!(capabilities_from_details(&[vrr, scope]).is_none());
    }

    #[test]
    fn production_identity_resolution_requires_one_exact_current_native_row() {
        use serde_json::json;
        let row = |id: u64, bus: u64| json!({
            "id": id,
            "deviceKey": format!("pci:0x00008086:0x0000e20b@{bus}:0.0"),
            "pciVendorId": "0x00008086",
            "pciDeviceId": "0x0000e20b",
            "bdf": { "bus": bus, "device": 0, "function": 0 },
            "luid": "0x00000001:0x00000002",
            "synthetic": false,
            "backendKind": "intel",
        });
        let inventory = json!([row(0, 3), row(1, 4)]);
        let identity = identity_from_inventory(1, "pci:0x00008086:0x0000e20b@4:0.0", &inventory).unwrap();
        assert_eq!((identity.bus, identity.device, identity.slot), (4, 0x0e20b, 0));

        assert!(identity_from_inventory(0, "pci:0x00008086:0x0000e20b@4:0.0", &inventory).is_err());
        assert!(identity_from_inventory(0, "missing", &inventory).is_err());
        assert!(identity_from_inventory(0, "pci:0x00008086:0x0000e20b@3:0.0", &json!([row(0, 3), row(0, 3)])).is_err());

        let mut synthetic = row(1, 4);
        synthetic["synthetic"] = json!(true);
        assert!(identity_from_inventory(1, "pci:0x00008086:0x0000e20b@4:0.0", &json!([synthetic])).is_err());
        let mut os_only = row(1, 4);
        os_only["backendKind"] = json!("os");
        assert!(identity_from_inventory(1, "pci:0x00008086:0x0000e20b@4:0.0", &json!([os_only])).is_err());
    }
}
