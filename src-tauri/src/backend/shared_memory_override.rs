//! Intel integrated shared GPU/NPU memory override.
//!
//! Intel Graphics Software persists this control in DxgKrnl's global memory
//! manager key rather than through the public IGCL 3D-feature API. The value is
//! a system-wide percentage, so the adapter gate belongs to the caller; this
//! module only owns the identity-independent registry value.
//!
//! Port of `src/main/backend/shared-memory-override.js`. The Electron
//! implementation shells out to `reg.exe` (and to an elevated PowerShell for
//! the write) because its host may be unelevated. The native host only runs
//! this path when it owns the write (elevated), so the subprocess layer - and
//! its 5 s/120 s stalls - is replaced by direct, fixed-path registry calls.
//! The `timeout` / `permission-denied` error codes are retained because the
//! renderer contract exposes them and transient OS errors still map onto them.
use super::game_profile_capabilities::intel_integrated_or_mobile;
use serde_json::{json, Value};

/// `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\MemoryManager`.
pub const GRAPHICS_MEMORY_MANAGER_KEY: &str =
    r"SYSTEM\CurrentControlSet\Control\GraphicsDrivers\MemoryManager";
pub const SHARED_MEMORY_OVERRIDE_VALUE: &str = "SystemPartitionCommitLimitPercentage";
pub const SHARED_MEMORY_OVERRIDE_MAX_VALUE: &str = "SystemPartitionCommitLimitPercentageMax";
pub const SHARED_MEMORY_OVERRIDE_MIN: u32 = 13;
/// DxgKrnl publishes the ceiling only once the installed stack materializes
/// it. Intel Graphics Software still presents 13-87 % on a fresh mobile/iGPU
/// installation, so a missing optional max falls back to that bound.
pub const SHARED_MEMORY_OVERRIDE_MAX_FALLBACK: u32 = 87;
pub const SHARED_MEMORY_OVERRIDE_DEFAULT: u32 = 57;
pub const SHARED_MEMORY_RESTART_WARNING: &str =
    "Restart Windows for the new shared-memory limit to take effect.";

/// Registry failures mapped onto the renderer's canonical error codes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RegistryFault {
    Timeout,
    PermissionDenied,
    Io,
}

impl RegistryFault {
    pub fn code(self) -> &'static str {
        match self {
            RegistryFault::Timeout => "timeout",
            RegistryFault::PermissionDenied => "permission-denied",
            RegistryFault::Io => "io-failed",
        }
    }
}

/// Injectable registry seam. Tests use an in-memory map; production uses the
/// fixed HKLM key above and never touches the host during `cargo test`.
pub trait RegistryAccess {
    fn query_dword(&self, value_name: &str) -> Result<Option<u32>, RegistryFault>;
    fn set_dword(&self, value_name: &str, value: u32) -> Result<(), RegistryFault>;
    fn delete_dword(&self, value_name: &str) -> Result<(), RegistryFault>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SharedMemoryState {
    pub enabled: bool,
    pub percentage: u32,
    pub max: u32,
    pub default: u32,
    pub requires_restart: bool,
}

impl SharedMemoryState {
    pub fn range_json(&self) -> Value {
        json!({
            "min": SHARED_MEMORY_OVERRIDE_MIN,
            "max": self.max,
            "step": 1,
            "default": self.default,
        })
    }

    pub fn value_json(&self) -> Value {
        json!({"enabled": self.enabled, "percentage": self.percentage})
    }
}

fn valid_percentage(value: u32, max: u32) -> bool {
    (SHARED_MEMORY_OVERRIDE_MIN..=max).contains(&value)
}

/// The adapter gate: Intel integrated or mobile Arc only.
pub fn adapter_supported(device: &Value) -> bool {
    intel_integrated_or_mobile(device)
}

/// Read the persisted override. `Ok(None)` means the adapter is ineligible;
/// `Err` is a registry failure the caller must surface instead of hiding the
/// IGCL controls.
pub fn read(
    registry: &dyn RegistryAccess,
    device: &Value,
) -> Result<Option<SharedMemoryState>, RegistryFault> {
    if !adapter_supported(device) {
        return Ok(None);
    }
    let configured = registry.query_dword(SHARED_MEMORY_OVERRIDE_VALUE)?;
    let configured_max = registry.query_dword(SHARED_MEMORY_OVERRIDE_MAX_VALUE)?;
    // Both values are optional and DxgKrnl has safe runtime defaults. A
    // missing max therefore means "not materialized yet", not "unsupported";
    // an explicit out-of-range max still fails closed.
    let max = configured_max.unwrap_or(SHARED_MEMORY_OVERRIDE_MAX_FALLBACK);
    if !valid_percentage(max, 100) {
        return Ok(None);
    }
    let enabled = configured.is_some_and(|value| valid_percentage(value, max));
    let percentage = if enabled {
        configured.unwrap_or(SHARED_MEMORY_OVERRIDE_DEFAULT)
    } else {
        SHARED_MEMORY_OVERRIDE_DEFAULT.min(max)
    };
    Ok(Some(SharedMemoryState {
        enabled,
        percentage,
        max,
        default: SHARED_MEMORY_OVERRIDE_DEFAULT.min(max),
        requires_restart: true,
    }))
}

fn fail(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "errorCode": code, "message": message.into()})
}

fn fault_message(fault: RegistryFault, read: bool) -> String {
    match (fault, read) {
        (RegistryFault::Timeout, true) => {
            "The Windows graphics-memory read timed out; no change was attempted.".into()
        }
        (RegistryFault::Timeout, false) => {
            "The Windows graphics-memory operation timed out; no change was confirmed.".into()
        }
        (_, true) => "The current shared-memory limit could not be read; no change was attempted."
            .into(),
        (RegistryFault::PermissionDenied, false) => {
            "The elevated memory override write failed; no change was confirmed.".into()
        }
        (_, false) => "The elevated memory override write failed; no change was confirmed.".into(),
    }
}

/// Apply one shared-memory override request and return the exact `perControl`
/// entry the Electron backend produces.
pub fn apply(registry: &dyn RegistryAccess, device: &Value, settings: &Value) -> Value {
    if !adapter_supported(device) {
        return fail(
            "unsupported",
            "Shared GPU/NPU Memory Override is only available on integrated or mobile Intel Arc graphics.",
        );
    }
    let enabled = settings.get("enabled").and_then(Value::as_bool) == Some(true);
    let current = match read(registry, device) {
        Ok(Some(current)) => current,
        Ok(None) => {
            return fail(
                "unavailable-symbol",
                "The driver did not provide a safe shared-memory limit.",
            )
        }
        Err(fault) => return fail(fault.code(), fault_message(fault, true)),
    };
    if !valid_percentage(current.max, 100) {
        return fail(
            "unavailable-symbol",
            "The driver did not provide a safe shared-memory limit.",
        );
    }
    let max = current.max;
    let requested = settings
        .get("percentage")
        .and_then(Value::as_u64)
        .filter(|value| *value <= u32::MAX as u64)
        .map(|value| value as u32);
    if enabled && !requested.is_some_and(|value| valid_percentage(value, max)) {
        return fail(
            "out-of-range",
            format!(
                "Memory limit must be between {SHARED_MEMORY_OVERRIDE_MIN}% and {max}%."
            ),
        );
    }
    let percentage = requested
        .filter(|value| valid_percentage(*value, max))
        .unwrap_or(SHARED_MEMORY_OVERRIDE_DEFAULT.min(max));
    let write = if enabled {
        registry.set_dword(SHARED_MEMORY_OVERRIDE_VALUE, percentage)
    } else {
        registry.delete_dword(SHARED_MEMORY_OVERRIDE_VALUE)
    };
    if let Err(fault) = write {
        return fail(fault.code(), fault_message(fault, false));
    }
    match read(registry, device) {
        Ok(read_back) => {
            let equal = read_back.as_ref().is_some_and(|state| {
                state.enabled == enabled && (!enabled || state.percentage == percentage)
            });
            if equal {
                json!({
                    "ok": true,
                    "readBackEqual": true,
                    "warning": SHARED_MEMORY_RESTART_WARNING,
                })
            } else {
                json!({
                    "ok": false,
                    "readBackEqual": false,
                    "errorCode": "io-failed",
                    "message": "The memory override was written but could not be confirmed.",
                })
            }
        }
        Err(fault) => fail(fault.code(), fault_message(fault, false)),
    }
}

// ---------------------------------------------------------------------------
// Production registry
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod system {
    use super::{RegistryAccess, RegistryFault, GRAPHICS_MEMORY_MANAGER_KEY};
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    /// `REG_DWORD`. Compared against the raw value type so a malformed value
    /// (REG_SZ or a truncated DWORD) is treated as absent instead of parsed.
    const REG_DWORD: winreg::enums::RegType = winreg::enums::RegType::REG_DWORD;
    const ERROR_ACCESS_DENIED: i32 = 5;
    const ERROR_BUSY: i32 = 170;
    const ERROR_SEM_TIMEOUT: i32 = 121;
    const ERROR_TIMEOUT: i32 = 1460;

    fn map_error(error: &std::io::Error) -> RegistryFault {
        match error.raw_os_error() {
            Some(ERROR_ACCESS_DENIED) => RegistryFault::PermissionDenied,
            Some(ERROR_BUSY) | Some(ERROR_SEM_TIMEOUT) | Some(ERROR_TIMEOUT) => {
                RegistryFault::Timeout
            }
            _ => RegistryFault::Io,
        }
    }

    fn is_missing(error: &std::io::Error) -> bool {
        error.kind() == std::io::ErrorKind::NotFound
            || error.raw_os_error() == Some(2 /* ERROR_FILE_NOT_FOUND */)
    }

    pub struct SystemRegistry;

    impl SystemRegistry {
        fn open(&self, write: bool) -> Result<RegKey, RegistryFault> {
            let flags = if write { KEY_READ | KEY_WRITE } else { KEY_READ };
            RegKey::predef(HKEY_LOCAL_MACHINE)
                .open_subkey_with_flags(GRAPHICS_MEMORY_MANAGER_KEY, flags)
                .map_err(|error| map_error(&error))
        }
    }

    impl RegistryAccess for SystemRegistry {
        fn query_dword(&self, value_name: &str) -> Result<Option<u32>, RegistryFault> {
            let key = self.open(false)?;
            match key.get_raw_value(value_name) {
                Ok(raw) if raw.vtype == REG_DWORD && raw.bytes.len() == 4 => Ok(Some(
                    u32::from_le_bytes(raw.bytes[..4].try_into().expect("len checked")),
                )),
                // A wrong-typed value is malformed input, not a transient
                // failure: DxgKrnl treats the value as optional, so it reads
                // as absent and the caller keeps its documented fallback.
                Ok(_) => Ok(None),
                Err(error) if is_missing(&error) => Ok(None),
                Err(error) => Err(map_error(&error)),
            }
        }

        fn set_dword(&self, value_name: &str, value: u32) -> Result<(), RegistryFault> {
            let key = self.open(true)?;
            key.set_value(value_name, &value).map_err(|error| map_error(&error))
        }

        fn delete_dword(&self, value_name: &str) -> Result<(), RegistryFault> {
            let key = self.open(true)?;
            match key.delete_value(value_name) {
                Ok(()) => Ok(()),
                // Deleting an already-absent override is an idempotent disable.
                Err(error) if is_missing(&error) => Ok(()),
                Err(error) => Err(map_error(&error)),
            }
        }
    }
}

#[cfg(windows)]
pub use system::SystemRegistry;

#[cfg(not(windows))]
pub struct SystemRegistry;

#[cfg(not(windows))]
impl RegistryAccess for SystemRegistry {
    fn query_dword(&self, _value_name: &str) -> Result<Option<u32>, RegistryFault> {
        Err(RegistryFault::Io)
    }
    fn set_dword(&self, _value_name: &str, _value: u32) -> Result<(), RegistryFault> {
        Err(RegistryFault::Io)
    }
    fn delete_dword(&self, _value_name: &str) -> Result<(), RegistryFault> {
        Err(RegistryFault::Io)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    #[derive(Default)]
    struct MemoryRegistry {
        values: Mutex<BTreeMap<String, u32>>,
        fail_query: Mutex<Option<RegistryFault>>,
        fail_write: Mutex<Option<RegistryFault>>,
        writes: Mutex<usize>,
    }

    impl MemoryRegistry {
        fn with(values: &[(&str, u32)]) -> Self {
            let registry = Self::default();
            for (name, value) in values {
                registry.values.lock().unwrap().insert((*name).to_owned(), *value);
            }
            registry
        }
        fn writes(&self) -> usize {
            *self.writes.lock().unwrap()
        }
    }

    impl RegistryAccess for MemoryRegistry {
        fn query_dword(&self, value_name: &str) -> Result<Option<u32>, RegistryFault> {
            if let Some(fault) = *self.fail_query.lock().unwrap() {
                return Err(fault);
            }
            Ok(self.values.lock().unwrap().get(value_name).copied())
        }
        fn set_dword(&self, value_name: &str, value: u32) -> Result<(), RegistryFault> {
            if let Some(fault) = *self.fail_write.lock().unwrap() {
                return Err(fault);
            }
            *self.writes.lock().unwrap() += 1;
            self.values.lock().unwrap().insert(value_name.to_owned(), value);
            Ok(())
        }
        fn delete_dword(&self, value_name: &str) -> Result<(), RegistryFault> {
            if let Some(fault) = *self.fail_write.lock().unwrap() {
                return Err(fault);
            }
            *self.writes.lock().unwrap() += 1;
            self.values.lock().unwrap().remove(value_name);
            Ok(())
        }
    }

    fn mobile() -> Value {
        json!({"pciVendorId":"0x00008086","integrated":false,"mobile":true})
    }

    fn discrete() -> Value {
        json!({"pciVendorId":"0x00008086","integrated":false,"mobile":false})
    }

    fn assert_code(entry: &Value, code: &str) {
        assert_eq!(entry["ok"], json!(false), "{entry}");
        assert_eq!(entry["errorCode"], json!(code), "{entry}");
    }

    #[test]
    fn gate_is_integrated_or_mobile_intel_only() {
        assert!(adapter_supported(&mobile()));
        assert!(adapter_supported(&json!({"pciVendorId":"0x00008086","integrated":true})));
        assert!(!adapter_supported(&discrete()));
        assert!(!adapter_supported(&json!({"pciVendorId":"0x00001002","integrated":true})));
        assert_eq!(
            apply(&MemoryRegistry::default(), &discrete(), &json!({"enabled":false,"percentage":57}))
                ["errorCode"],
            json!("unsupported")
        );
    }

    #[test]
    fn read_defaults_to_the_igs_surface_when_the_optional_max_is_missing() {
        let registry = MemoryRegistry::default();
        let state = read(&registry, &mobile()).unwrap().unwrap();
        assert!(!state.enabled);
        assert_eq!(state.percentage, SHARED_MEMORY_OVERRIDE_DEFAULT);
        assert_eq!(state.range_json(), json!({"min":13,"max":87,"step":1,"default":57}));
    }

    #[test]
    fn read_honours_an_explicit_max_and_fails_closed_when_it_is_malformed() {
        let registry = MemoryRegistry::with(&[(SHARED_MEMORY_OVERRIDE_MAX_VALUE, 100)]);
        assert_eq!(read(&registry, &mobile()).unwrap().unwrap().max, 100);
        let registry = MemoryRegistry::with(&[
            (SHARED_MEMORY_OVERRIDE_MAX_VALUE, 5),
            (SHARED_MEMORY_OVERRIDE_VALUE, 57),
        ]);
        assert!(read(&registry, &mobile()).unwrap().is_none());
        let registry = MemoryRegistry::with(&[
            (SHARED_MEMORY_OVERRIDE_MAX_VALUE, 200),
        ]);
        assert!(read(&registry, &mobile()).unwrap().is_none());
    }

    #[test]
    fn read_reports_an_enabled_value_only_inside_the_published_range() {
        let registry = MemoryRegistry::with(&[(SHARED_MEMORY_OVERRIDE_VALUE, 57)]);
        let state = read(&registry, &mobile()).unwrap().unwrap();
        assert!(state.enabled);
        assert_eq!(state.percentage, 57);
        let registry = MemoryRegistry::with(&[(SHARED_MEMORY_OVERRIDE_VALUE, 12)]);
        let state = read(&registry, &mobile()).unwrap().unwrap();
        assert!(!state.enabled);
        assert_eq!(state.percentage, SHARED_MEMORY_OVERRIDE_DEFAULT);
    }

    #[test]
    fn apply_writes_then_verifies_and_requests_a_restart() {
        let registry = MemoryRegistry::with(&[(SHARED_MEMORY_OVERRIDE_MAX_VALUE, 100)]);
        let result = apply(&registry, &mobile(), &json!({"enabled":true,"percentage":64}));
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["readBackEqual"], json!(true));
        assert_eq!(result["warning"], json!(SHARED_MEMORY_RESTART_WARNING));
        assert_eq!(registry.writes(), 1);
        assert_eq!(read(&registry, &mobile()).unwrap().unwrap().percentage, 64);
    }

    #[test]
    fn apply_disable_deletes_the_value_and_verifies_absence() {
        let registry = MemoryRegistry::with(&[(SHARED_MEMORY_OVERRIDE_VALUE, 57)]);
        let result = apply(&registry, &mobile(), &json!({"enabled":false,"percentage":57}));
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(registry.writes(), 1);
        assert!(!read(&registry, &mobile()).unwrap().unwrap().enabled);
    }

    #[test]
    fn apply_refuses_an_out_of_range_percentage_without_writing() {
        let registry = MemoryRegistry::with(&[(SHARED_MEMORY_OVERRIDE_MAX_VALUE, 100)]);
        let result = apply(&registry, &mobile(), &json!({"enabled":true,"percentage":101}));
        assert_code(&result, "out-of-range");
        assert_eq!(result["message"], json!("Memory limit must be between 13% and 100%."));
        assert_eq!(registry.writes(), 0);
    }

    #[test]
    fn read_and_write_faults_map_to_the_canonical_codes() {
        let registry = MemoryRegistry::with(&[(SHARED_MEMORY_OVERRIDE_MAX_VALUE, 100)]);
        *registry.fail_query.lock().unwrap() = Some(RegistryFault::Timeout);
        let result = apply(&registry, &mobile(), &json!({"enabled":true,"percentage":57}));
        assert_code(&result, "timeout");
        assert_eq!(
            result["message"],
            json!("The Windows graphics-memory read timed out; no change was attempted.")
        );
        *registry.fail_query.lock().unwrap() = None;
        *registry.fail_write.lock().unwrap() = Some(RegistryFault::PermissionDenied);
        let result = apply(&registry, &mobile(), &json!({"enabled":true,"percentage":57}));
        assert_code(&result, "permission-denied");
        *registry.fail_write.lock().unwrap() = None;
        *registry.fail_write.lock().unwrap() = Some(RegistryFault::Timeout);
        let result = apply(&registry, &mobile(), &json!({"enabled":true,"percentage":57}));
        assert_code(&result, "timeout");
        assert_eq!(
            result["message"],
            json!("The Windows graphics-memory operation timed out; no change was confirmed.")
        );
        assert_eq!(registry.writes(), 0);
    }

    #[test]
    fn apply_fails_closed_when_the_read_back_cannot_confirm_the_write() {
        // The write lands, then the registry refuses the confirming read.
        struct Unconfirmable(MemoryRegistry);
        impl RegistryAccess for Unconfirmable {
            fn query_dword(&self, name: &str) -> Result<Option<u32>, RegistryFault> {
                if name == SHARED_MEMORY_OVERRIDE_VALUE
                    && self.0.values.lock().unwrap().contains_key(name)
                {
                    return Err(RegistryFault::Io);
                }
                self.0.query_dword(name)
            }
            fn set_dword(&self, name: &str, value: u32) -> Result<(), RegistryFault> {
                self.0.set_dword(name, value)
            }
            fn delete_dword(&self, name: &str) -> Result<(), RegistryFault> {
                self.0.delete_dword(name)
            }
        }
        let registry = Unconfirmable(MemoryRegistry::with(&[(SHARED_MEMORY_OVERRIDE_MAX_VALUE, 100)]));
        let result = apply(&registry, &mobile(), &json!({"enabled":true,"percentage":64}));
        assert_code(&result, "io-failed");
        assert_eq!(
            result["message"],
            json!("The elevated memory override write failed; no change was confirmed.")
        );
    }
}
