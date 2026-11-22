//! Native GPU lock (fixed clock/voltage) apply core.
use super::gpu_apply::igcl_error_code;
use super::gpu_units::{clamp_gpu_lock, nearly_equal, GpuLock, LockRange};
use serde_json::{json, Value};

pub trait LockBackend {
    /// The driver pair is millivolts/MHz even though the canonical settings
    /// shape is volts/MHz.
    fn set_lock(&mut self, voltage_mv: i64, freq_mhz: i64) -> u32;
    fn get_lock(&mut self) -> Result<(f64, f64), u32>; // canonical volts/MHz
}

fn fail(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "perControl": {"gpuLock": {
        "ok": false, "errorCode": code, "message": message.into(),
    }}})
}

pub fn apply_gpu_lock(settings: &Value, caps: &Value, backend: &mut dyn LockBackend) -> Value {
    let Some(lock) = settings.get("gpuLock").filter(|value| !value.is_null()) else {
        return json!({"ok": true, "perControl": {}});
    };
    let (Some(voltage), Some(frequency)) = (
        lock.get("voltageV").and_then(Value::as_f64).filter(|value| value.is_finite()),
        lock.get("freqMhz").and_then(Value::as_f64).filter(|value| value.is_finite()),
    ) else {
        return fail("invalid-argument", "gpuLock requires finite voltageV and freqMhz");
    };
    if caps.get("controls").and_then(|controls| controls.get("gpuLock")) != Some(&Value::Bool(true)) {
        let percent = caps.get("ranges").and_then(|ranges| ranges.get("gpuVoltOffsetV"))
            .and_then(|range| range.get("units")) == Some(&json!("%"));
        return fail("unsupported", if percent {
            "Fixed Clock / Voltage lock is not supported on Battlemage percent-unit voltage controls; use the independent frequency and voltage offsets."
        } else {
            "GPU lock not supported on this device"
        });
    }
    let range = caps.get("lockRange").and_then(|value| serde_json::from_value::<LockRange>(value.clone()).ok());
    let bounded = clamp_gpu_lock(GpuLock { voltage_v: voltage, freq_mhz: frequency }, range);
    let voltage_mv = (bounded.voltage_v * 1000.0).round() as i64;
    let freq_mhz = bounded.freq_mhz.round() as i64;
    let set_result = backend.set_lock(voltage_mv, freq_mhz);
    if set_result != 0 {
        return fail(igcl_error_code(set_result).unwrap_or("io-failed"),
            format!("Fixed Clock / Voltage lock was refused by the driver (0x{set_result:08x})."));
    }
    let (read_back_equal, message) = match backend.get_lock() {
        Ok((read_voltage, read_frequency)) => {
            let equal = nearly_equal(read_voltage, bounded.voltage_v, 1e-9)
                && nearly_equal(read_frequency, bounded.freq_mhz, 1e-9);
            (equal, (!equal).then(|| format!(
                "read-back {}mV/{}MHz != requested {}V/{}MHz",
                (read_voltage * 1000.0).round(), read_frequency, bounded.voltage_v, bounded.freq_mhz)))
        }
        Err(result) => (false, Some(format!("set succeeded but read-back failed (0x{result:08x})"))),
    };
    let mut entry = serde_json::Map::new();
    entry.insert("ok".into(), json!(read_back_equal));
    if !read_back_equal { entry.insert("errorCode".into(), json!("io-failed")); }
    if let Some(message) = message { entry.insert("message".into(), json!(message)); }
    entry.insert("readBackEqual".into(), json!(read_back_equal));
    entry.insert("silentNoop".into(), json!(!read_back_equal));
    json!({"ok": read_back_equal, "perControl": {"gpuLock": Value::Object(entry)}})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps() -> Value {
        json!({"controls": {"gpuLock": true}, "lockRange": {"voltMin": 0.4, "voltMax": 1.5, "freqMin": 0, "freqMax": 4300}})
    }

    struct Mock { set_result: u32, get_result: Option<u32>, read: (f64, f64), sets: Vec<(i64, i64)> }
    impl Default for Mock { fn default() -> Self { Self { set_result: 0, get_result: None, read: (0.95, 2400.0), sets: Vec::new() } } }
    impl LockBackend for Mock {
        fn set_lock(&mut self, voltage_mv: i64, freq_mhz: i64) -> u32 { self.sets.push((voltage_mv, freq_mhz)); self.set_result }
        fn get_lock(&mut self) -> Result<(f64, f64), u32> { if let Some(result) = self.get_result { Err(result) } else { Ok(self.read) } }
    }

    #[test]
    fn clamps_converts_and_verifies_the_lock_pair() {
        let mut backend = Mock::default();
        let result = apply_gpu_lock(&json!({"gpuLock": {"voltageV": 0.95, "freqMhz": 2400}}), &caps(), &mut backend);
        assert_eq!(result["ok"], true);
        assert_eq!(backend.sets, vec![(950, 2400)]);
        assert_eq!(result["perControl"]["gpuLock"]["readBackEqual"], true);
    }

    #[test]
    fn zero_unlock_bypasses_bounds_and_refusals_are_honest() {
        let mut backend = Mock { read: (0.0, 0.0), ..Mock::default() };
        assert_eq!(apply_gpu_lock(&json!({"gpuLock": {"voltageV": 0, "freqMhz": 0}}), &caps(), &mut backend)["ok"], true);
        assert_eq!(backend.sets, vec![(0, 0)]);
        let mut refused = Mock { set_result: 0x4400_0006, ..Mock::default() };
        let result = apply_gpu_lock(&json!({"gpuLock": {"voltageV": 1.0, "freqMhz": 2500}}), &caps(), &mut refused);
        assert_eq!(result["perControl"]["gpuLock"]["errorCode"], "locked-mode");
        let mut mismatch = Mock { read: (1.0, 2499.0), ..Mock::default() };
        let result = apply_gpu_lock(&json!({"gpuLock": {"voltageV": 1.0, "freqMhz": 2500}}), &caps(), &mut mismatch);
        assert_eq!(result["ok"], false);
        assert_eq!(result["perControl"]["gpuLock"]["silentNoop"], true);
    }

    #[test]
    fn unsupported_and_malformed_requests_fail_before_writes() {
        let mut unsupported = caps();
        unsupported["controls"]["gpuLock"] = json!(false);
        let mut backend = Mock::default();
        assert_eq!(apply_gpu_lock(&json!({"gpuLock": {"voltageV": 1.0, "freqMhz": 2500}}), &unsupported, &mut backend)["perControl"]["gpuLock"]["errorCode"], "unsupported");
        assert!(backend.sets.is_empty());
        assert_eq!(apply_gpu_lock(&json!({"gpuLock": {"voltageV": "1", "freqMhz": 2500}}), &caps(), &mut backend)["perControl"]["gpuLock"]["errorCode"], "invalid-argument");
        assert!(backend.sets.is_empty());
    }
}
