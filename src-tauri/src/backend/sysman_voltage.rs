//! Sysman voltage-target policy (legacy Alchemist frequency-domain API).
//! The adapter supplies raw driver values; this module owns unit inference,
//! the -200 mV write floor, waiver gating, target preservation, and read-back.
use serde_json::{json, Value};

pub const ALCHEMIST_NEGATIVE_VOLT_OFFSET_MIN_V: f64 = -0.200;
pub const VOLT_EPSILON: f64 = 0.0005;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VoltageReading {
    pub target_native: f64,
    pub offset_native: f64,
    pub frequency_target_mhz: Option<f64>,
    pub state_voltage_native: Option<f64>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VoltageCapabilities {
    pub max_factory_default_voltage: f64,
    pub min_oc_voltage_offset: f64,
    pub max_oc_voltage_offset: f64,
    pub max_oc_voltage: f64,
}

pub trait SysmanVoltage {
    fn read_voltage(&mut self) -> Result<VoltageReading, u32>;
    fn max_frequency_mhz(&self) -> f64;
    fn read_capabilities(&mut self) -> Option<VoltageCapabilities>;
    fn set_mode(&mut self, mode: u32) -> u32;
    fn set_frequency_target(&mut self, mhz: f64) -> u32;
    fn set_voltage_target(&mut self, target_native: f64, offset_native: f64) -> u32;
    /// Optional informational replay; the caller already holds the IGCL waiver.
    fn apply_waiver(&mut self) -> Option<u32>;
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct VoltageRequest {
    pub offset_v: f64,
    pub target_v: Option<f64>,
    pub frequency_target_mhz: Option<f64>,
    pub waiver_accepted: bool,
}

fn fail(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "errorCode": code, "message": message.into()})
}

fn finish(value: Value) -> Value { value }

/// Once a driver setter is attempted, even a failure status does not prove it
/// left the prior mode/frequency/voltage intact. This API cannot currently
/// capture and restore the previous OC mode, so expose the uncertain state.
fn partial_failure(mut value: Value) -> Value {
    value["stateMayHaveChanged"] = json!(true);
    value["message"] = json!(format!("{} Driver state may have changed; refresh before another apply.",
        value["message"].as_str().unwrap_or("Sysman voltage apply failed.")));
    value
}

pub fn describe_ze_result(code: u32) -> &'static str {
    match code {
        0x0000_0000 => "SUCCESS",
        0x0000_0001 => "NOT_READY",
        0x7800_0001 => "ERROR_UNINITIALIZED",
        0x7800_0002 => "ERROR_DEVICE_LOST",
        0x7800_0003 => "ERROR_INVALID_ARGUMENT",
        0x7800_0004 => "ERROR_OUT_OF_HOST_MEMORY",
        0x7800_0005 => "ERROR_OUT_OF_DEVICE_MEMORY",
        0x7800_0006 => "ERROR_MODULE_BUILD_FAILURE",
        0x7800_0007 => "ERROR_MODULE_LINK_FAILURE",
        0x7800_0008 => "ERROR_INSUFFICIENT_PERMISSIONS",
        0x7800_0009 => "ERROR_NOT_AVAILABLE",
        0x7800_000a => "ERROR_NOT_IMPLEMENTED",
        0x7800_000b => "ERROR_INVALID_NULL_HANDLE",
        0x7800_000c => "ERROR_INVALID_NULL_POINTER",
        0x7800_000d => "ERROR_INVALID_SIZE",
        0x7800_000e => "ERROR_UNSUPPORTED_SIZE",
        0x7800_000f => "ERROR_UNSUPPORTED_VERSION",
        0x7800_0010 => "ERROR_INVALID_FORMAT",
        0x7800_0011 => "ERROR_INVALID_SYNCHRONIZATION_OBJECT",
        0x7800_0012 => "ERROR_INVALID_ENUMERATION",
        0x7800_0013 => "ERROR_UNSUPPORTED_ENUMERATION",
        0x7800_0014 => "ERROR_UNSUPPORTED_IMAGE_FORMAT",
        0x7800_0015 => "ERROR_INVALID_NATIVE_BINARY",
        0x7800_0016 => "ERROR_INVALID_GLOBAL_NAME",
        0x7800_0017 => "ERROR_INVALID_KERNEL_NAME",
        0x7800_0018 => "ERROR_INVALID_FUNCTION_NAME",
        0x7800_0019 => "ERROR_INVALID_GROUP_SIZE_DIMENSION",
        0x7800_001a => "ERROR_INVALID_GLOBAL_WIDTH_DIMENSION",
        0x7800_001b => "ERROR_INVALID_KERNEL_ARGUMENT_INDEX",
        0x7800_001c => "ERROR_INVALID_KERNEL_ARGUMENT_SIZE",
        0x7800_001d => "ERROR_INVALID_KERNEL_ATTRIBUTE_VALUE",
        0x7800_001e => "ERROR_INVALID_MODULE_UNLINKED",
        0x7800_001f => "ERROR_INVALID_COMMAND_LIST_TYPE",
        0x7800_0020 => "ERROR_OVERLAPPING_REGIONS",
        0x7800_0021 => "ERROR_UNKNOWN",
        0x7800_0022 => "ERROR_UNSUPPORTED_FEATURE",
        0x7800_0023 => "ERROR_INVALID_OVERCLOCK_SETTING",
        0x7800_0024 => "ERROR_OVERCLOCK_NOT_SUPPORTED",
        0x7800_0025 => "ERROR_OVERCLOCK_OUT_OF_RANGE",
        0x7800_0026 => "ERROR_OVERCLOCK_WAIVER_NOT_SET",
        0x7800_0027 => "ERROR_OVERCLOCK_IGNORE_VOLTAGE_LIMIT_REQUIRED",
        0x7800_0028 => "ERROR_OVERCLOCK_INSUFFICIENT_PERMISSIONS",
        0x7800_0029 => "ERROR_INVALID_DEVICE",
        0x7800_002c => "ERROR_OPERATIONS_SYNCHRONIZATION",
        0x7800_0030 => "ERROR_INVALID_OVERCLOCK_VOLTAGE",
        0x7800_0032 => "ERROR_OVERCLOCK_FAILURE",
        0x7000_0001 => "ERROR_DEVICE_LOST",
        0x7001_0001 => "ERROR_NOT_AVAILABLE",
        0x7fff_fffe => "ERROR_UNKNOWN",
        _ => "UNKNOWN",
    }
}

fn ze_failure(code: u32) -> Value {
    let name = describe_ze_result(code);
    fail(name, format!("{name} (0x{code:08x})"))
}

fn voltage_from_native(value: f64) -> Option<f64> {
    if !value.is_finite() { return None; }
    Some(if value.abs() > 10.0 { value / 1000.0 } else { value })
}

fn native_scale(caps: Option<VoltageCapabilities>) -> f64 {
    let Some(caps) = caps else { return 1000.0; };
    [
        caps.max_factory_default_voltage,
        caps.max_oc_voltage,
        caps.min_oc_voltage_offset,
        caps.max_oc_voltage_offset,
    ]
    .into_iter()
    .any(|value| value.is_finite() && value.abs() > 10.0)
    .then_some(1000.0)
    .unwrap_or(1.0)
}

fn voltage_to_native(value: f64, scale: f64) -> f64 {
    if scale == 1000.0 { (value * 1000.0).round() } else { value }
}

fn read_scale(reading: &VoltageReading) -> f64 {
    if reading.target_native.is_finite() && reading.target_native.abs() > 10.0 { 1000.0 } else { 1.0 }
}

fn clamp_offset(offset_v: f64) -> f64 { offset_v.max(ALCHEMIST_NEGATIVE_VOLT_OFFSET_MIN_V) }

pub fn read_voltage_offset(backend: &mut dyn SysmanVoltage) -> Value {
    let reading = match backend.read_voltage() {
        Ok(reading) => reading,
        Err(code) => return ze_failure(code),
    };
    let scale = read_scale(&reading);
    let (Some(target), Some(offset)) = (
        voltage_from_native(reading.target_native / scale),
        voltage_from_native(reading.offset_native / scale),
    ) else {
        return fail("io-failed", "the Sysman voltage offset read returned non-finite values");
    };
    let mut result = json!({"ok": true, "targetV": target, "offsetV": offset});
    if let Some(frequency) = reading.frequency_target_mhz.filter(|value| value.is_finite() && *value > 0.0) {
        result["frequencyTargetMhz"] = json!(frequency);
    }
    result
}

pub fn clear_voltage_offset(backend: &mut dyn SysmanVoltage, waiver_accepted: bool) -> Value {
    if let Ok(reading) = backend.read_voltage() {
        let scale = read_scale(&reading);
        if reading.offset_native.is_finite() && (reading.offset_native / scale).abs() <= VOLT_EPSILON {
            return json!({"ok": true, "readBackEqual": true});
        }
    }
    apply_voltage_offset(backend, VoltageRequest {
        offset_v: 0.0, target_v: None, frequency_target_mhz: None, waiver_accepted,
    })
}

pub fn apply_voltage_offset(backend: &mut dyn SysmanVoltage, request: VoltageRequest) -> Value {
    if !request.offset_v.is_finite() {
        return fail("invalid-argument", "offsetV must be a finite number");
    }
    if request.offset_v > 0.0 {
        return fail("invalid-argument", "the Sysman voltage offset path accepts only negative offsets or zero to clear");
    }
    if !request.waiver_accepted {
        return fail("waiver-not-set", "the Sysman voltage write requires an accepted overclock waiver");
    }
    let offset_v = clamp_offset(request.offset_v);
    let current = match backend.read_voltage() {
        Ok(reading) => reading,
        Err(code) => return ze_failure(code),
    };
    let caps = backend.read_capabilities();
    let scale = native_scale(caps);
    let current_target = voltage_from_native(current.target_native);
    let target_v = request.target_v.filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| current_target.filter(|value| *value > 0.0))
        .or_else(|| caps.and_then(|caps| voltage_from_native(caps.max_factory_default_voltage))
            .filter(|value| *value > 0.0))
        .or_else(|| current.state_voltage_native.and_then(voltage_from_native)
            .filter(|value| *value > 0.0));
    let frequency_target_mhz = request.frequency_target_mhz.filter(|value| value.is_finite() && *value > 0.0)
        .or_else(|| current.frequency_target_mhz.filter(|value| value.is_finite() && *value > 0.0))
        .or_else(|| Some(backend.max_frequency_mhz()).filter(|value| value.is_finite() && *value > 0.0));
    let Some(target_v) = target_v else {
        return fail("unavailable", "the Sysman voltage offset setter could not establish the current/factory voltage target");
    };
    let Some(frequency_target_mhz) = frequency_target_mhz else {
        return fail("unavailable", "the Sysman voltage offset setter could not establish the current core-frequency target");
    };
    // The per-process waiver normally comes from IGCL. This replay is
    // informational: an unsupported legacy entry point must not block a
    // working IGCL waiver.
    let _ = backend.apply_waiver();
    let mode = backend.set_mode(2);
    if mode != 0 { return partial_failure(ze_failure(mode)); }
    let frequency = backend.set_frequency_target(frequency_target_mhz);
    if frequency != 0 { return partial_failure(ze_failure(frequency)); }
    let voltage = backend.set_voltage_target(
        voltage_to_native(target_v, scale),
        voltage_to_native(offset_v, scale),
    );
    if voltage != 0 { return partial_failure(ze_failure(voltage)); }
    let after = match backend.read_voltage() {
        Ok(reading) => reading,
        Err(code) => return partial_failure(ze_failure(code)),
    };
    let after_scale = read_scale(&after);
    let after_offset = if after.offset_native.is_finite() {
        Some(after.offset_native / after_scale)
    } else { None };
    let after_target = voltage_from_native(after.target_native);
    let offset_matches = after_offset.is_some_and(|value| (value - offset_v).abs() <= VOLT_EPSILON);
    let target_valid = after_target.is_some_and(|value| if offset_v == 0.0 { value >= 0.0 } else { value > 0.0 });
    let frequency_valid = after.frequency_target_mhz.is_none_or(|value| value.is_finite() && value > 0.0);
    if !offset_matches || !target_valid || !frequency_valid {
        let mut result = fail("io-failed",
            "the Sysman voltage offset write did not persist (target, offset, or frequency read-back was invalid)");
        if let Some(target) = after_target { result["targetV"] = json!(target); }
        if let Some(offset) = after_offset { result["offsetV"] = json!(offset); }
        if let Some(frequency) = after.frequency_target_mhz { result["frequencyTargetMhz"] = json!(frequency); }
        return finish(partial_failure(result));
    }
    let mut result = json!({"ok": true, "targetV": after_target, "offsetV": after_offset});
    if let Some(frequency) = after.frequency_target_mhz { result["frequencyTargetMhz"] = json!(frequency); }
    finish(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Mock {
        target_native: f64,
        offset_native: f64,
        frequency: Option<f64>,
        state_voltage: Option<f64>,
        caps: Option<VoltageCapabilities>,
        read_error: Option<u32>,
        mode_error: u32,
        frequency_error: u32,
        voltage_error: u32,
        waiver: Option<u32>,
        calls: Vec<String>,
    }
    impl Default for Mock {
        fn default() -> Self {
            Self {
                target_native: 883.0, offset_native: 0.0,
                frequency: Some(2400.0), state_voltage: Some(883.0),
                caps: Some(VoltageCapabilities {
                    max_factory_default_voltage: 883.0,
                    min_oc_voltage_offset: -200.0,
                    max_oc_voltage_offset: 234.0,
                    max_oc_voltage: 1200.0,
                }),
                read_error: None, mode_error: 0, frequency_error: 0,
                voltage_error: 0, waiver: Some(0), calls: Vec::new(),
            }
        }
    }
    impl SysmanVoltage for Mock {
        fn read_voltage(&mut self) -> Result<VoltageReading, u32> {
            if let Some(code) = self.read_error { return Err(code); }
            Ok(VoltageReading {
                target_native: self.target_native,
                offset_native: self.offset_native,
                frequency_target_mhz: self.frequency,
                state_voltage_native: self.state_voltage,
            })
        }
        fn max_frequency_mhz(&self) -> f64 { 2400.0 }
        fn read_capabilities(&mut self) -> Option<VoltageCapabilities> { self.caps }
        fn set_mode(&mut self, mode: u32) -> u32 {
            self.calls.push(format!("mode:{mode}"));
            self.mode_error
        }
        fn set_frequency_target(&mut self, mhz: f64) -> u32 {
            self.calls.push(format!("freq:{mhz}"));
            if self.frequency_error == 0 { self.frequency = Some(mhz); }
            self.frequency_error
        }
        fn set_voltage_target(&mut self, target_native: f64, offset_native: f64) -> u32 {
            self.calls.push(format!("volt:{target_native}:{offset_native}"));
            if self.voltage_error == 0 {
                self.target_native = target_native;
                self.offset_native = offset_native;
            }
            self.voltage_error
        }
        fn apply_waiver(&mut self) -> Option<u32> {
            self.calls.push("waiver".into());
            self.waiver
        }
    }

    fn request(offset_v: f64) -> VoltageRequest {
        VoltageRequest { offset_v, waiver_accepted: true, ..VoltageRequest::default() }
    }

    #[test]
    fn reads_the_canonical_target_and_offset() {
        let mut mock = Mock::default();
        let result = read_voltage_offset(&mut mock);
        assert_eq!(result["ok"], true);
        assert_eq!(result["targetV"], 0.883);
        assert_eq!(result["offsetV"], 0.0);
        assert_eq!(result["frequencyTargetMhz"], 2400.0);
        let mut failed = Mock { read_error: Some(0x7800_0009), ..Mock::default() };
        assert_eq!(read_voltage_offset(&mut failed)["errorCode"], "ERROR_NOT_AVAILABLE");
    }

    #[test]
    fn applies_a_clamped_offset_through_the_mode_frequency_voltage_sequence() {
        let mut mock = Mock::default();
        let result = apply_voltage_offset(&mut mock, request(-0.500));
        assert_eq!(result["ok"], true);
        assert_eq!(result["targetV"], 0.883);
        assert_eq!(result["offsetV"], -0.200);
        assert_eq!(result["frequencyTargetMhz"], 2400.0);
        assert_eq!(mock.calls, vec!["waiver", "mode:2", "freq:2400", "volt:883:-200"]);
    }

    #[test]
    fn rejects_positive_offsets_and_missing_waivers() {
        let mut mock = Mock::default();
        assert_eq!(apply_voltage_offset(&mut mock, request(0.05))["errorCode"], "invalid-argument");
        let mut request = request(-0.1);
        request.waiver_accepted = false;
        assert_eq!(apply_voltage_offset(&mut mock, request)["errorCode"], "waiver-not-set");
        assert!(mock.calls.is_empty());
    }

    #[test]
    fn preserves_the_requested_target_and_frequency() {
        let mut mock = Mock::default();
        let mut request = request(-0.1);
        request.target_v = Some(0.91);
        request.frequency_target_mhz = Some(2300.0);
        let result = apply_voltage_offset(&mut mock, request);
        assert_eq!(result["ok"], true);
        assert_eq!(mock.calls, vec!["waiver", "mode:2", "freq:2300", "volt:910:-100"]);
    }

    #[test]
    fn falls_back_to_factory_capabilities_and_uses_the_volt_scale() {
        let mut mock = Mock { target_native: 0.0, state_voltage: None, ..Mock::default() };
        let result = apply_voltage_offset(&mut mock, request(-0.1));
        assert_eq!(result["ok"], true);
        assert_eq!(mock.calls, vec!["waiver", "mode:2", "freq:2400", "volt:883:-100"]);
    }

    #[test]
    fn missing_native_units_uses_the_driver_float_scale() {
        let mut mock = Mock {
            target_native: 0.883, offset_native: 0.0,
            caps: Some(VoltageCapabilities {
                max_factory_default_voltage: 0.883,
                min_oc_voltage_offset: -0.2,
                max_oc_voltage_offset: 0.234,
                max_oc_voltage: 1.2,
            }),
            ..Mock::default()
        };
        let result = apply_voltage_offset(&mut mock, request(-0.1));
        assert_eq!(result["ok"], true);
        assert_eq!(mock.calls, vec!["waiver", "mode:2", "freq:2400", "volt:0.883:-0.1"]);
    }

    #[test]
    fn getter_and_setter_failures_are_mapped() {
        let mut getter = Mock { read_error: Some(0x7800_0009), ..Mock::default() };
        let failed = apply_voltage_offset(&mut getter, request(-0.1));
        assert_eq!(failed["errorCode"], "ERROR_NOT_AVAILABLE");
        assert!(failed.get("stateMayHaveChanged").is_none());
        let mut mode = Mock { mode_error: 0x7800_0026, ..Mock::default() };
        let failed = apply_voltage_offset(&mut mode, request(-0.1));
        assert_eq!(failed["errorCode"], "ERROR_OVERCLOCK_WAIVER_NOT_SET");
        assert_eq!(failed["stateMayHaveChanged"], true);
        let mut frequency = Mock { frequency_error: 0x7800_0030, ..Mock::default() };
        let failed = apply_voltage_offset(&mut frequency, request(-0.1));
        assert_eq!(failed["errorCode"], "ERROR_INVALID_OVERCLOCK_VOLTAGE");
        assert_eq!(failed["stateMayHaveChanged"], true);
        let mut voltage = Mock { voltage_error: 0x7800_0032, ..Mock::default() };
        assert_eq!(apply_voltage_offset(&mut voltage, request(-0.1))["errorCode"], "ERROR_OVERCLOCK_FAILURE");
    }

    #[test]
    fn a_cold_or_mismatched_read_back_is_a_failure() {
        struct Cold(Mock);
        impl SysmanVoltage for Cold {
            fn read_voltage(&mut self) -> Result<VoltageReading, u32> { Ok(VoltageReading::default()) }
            fn max_frequency_mhz(&self) -> f64 { 2400.0 }
            fn read_capabilities(&mut self) -> Option<VoltageCapabilities> { self.0.caps }
            fn set_mode(&mut self, _mode: u32) -> u32 { 0 }
            fn set_frequency_target(&mut self, _mhz: f64) -> u32 { 0 }
            fn set_voltage_target(&mut self, _target: f64, _offset: f64) -> u32 { 0 }
            fn apply_waiver(&mut self) -> Option<u32> { Some(0) }
        }
        let mut cold = Cold(Mock::default());
        let result = apply_voltage_offset(&mut cold, request(-0.1));
        assert_eq!(result["ok"], false);
        assert_eq!(result["errorCode"], "io-failed");
    }

    #[test]
    fn zero_clears_and_accepts_a_zero_target() {
        let mut mock = Mock { offset_native: -150.0, ..Mock::default() };
        let result = apply_voltage_offset(&mut mock, request(0.0));
        assert_eq!(result["ok"], true);
        assert_eq!(result["offsetV"], 0.0);
        assert_eq!(mock.calls, vec!["waiver", "mode:2", "freq:2400", "volt:883:0"]);
    }

    #[test]
    fn an_already_clear_offset_is_not_rewritten_or_blocked_by_a_waiver() {
        let mut mock = Mock::default();
        let result = clear_voltage_offset(&mut mock, false);
        assert_eq!(result["ok"], true);
        assert_eq!(result["readBackEqual"], true);
        assert!(mock.calls.is_empty());
        let mut stale = Mock { offset_native: -150.0, ..Mock::default() };
        let result = clear_voltage_offset(&mut stale, true);
        assert_eq!(result["ok"], true);
        assert_eq!(stale.calls, vec!["waiver", "mode:2", "freq:2400", "volt:883:0"]);
    }
}
