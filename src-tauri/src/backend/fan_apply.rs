//! Native fan apply core (port of Electron's `applyFan`).
//! The caller supplies a mockable backend; every mode is read-back verified.
use super::gpu_apply::igcl_error_code;
use super::gpu_units::{clamp_fan_pct, normalize_fan_curve, FanPoint};
use serde_json::{json, Map, Value};

pub const FAN_MODE_AUTO: &str = "auto";
pub const FAN_MODE_CURVE: &str = "curve";
pub const FAN_MODE_FIXED: &str = "fixed";
pub const FAN_UNITS_PERCENT: i32 = 1;

#[derive(Clone, Debug, PartialEq)]
pub struct FanConfig {
    pub mode: i32,
    pub table: Vec<(i32, i32, i32)>, // temperature, speed, units
    pub fixed_speed: i32,
    pub fixed_units: i32,
}

pub trait FanBackend {
    fn set_table(&mut self, points: &[(u32, i32)]) -> u32;
    fn set_fixed(&mut self, percent: i32) -> u32;
    fn set_default(&mut self) -> u32;
    fn read_config(&mut self) -> Result<FanConfig, u32>;
}

fn fan_pct(value: i32, units: i32, max_rpm: i32) -> Option<f64> {
    match (units, max_rpm) {
        (FAN_UNITS_PERCENT, _) => Some(f64::from(value)),
        (0, max_rpm) if max_rpm > 0 => Some(f64::from(value) / f64::from(max_rpm) * 100.0),
        _ => None,
    }
}

fn mode_name(mode: i32) -> Option<&'static str> {
    match mode { 0 => Some(FAN_MODE_AUTO), 1 => Some(FAN_MODE_FIXED), 2 => Some(FAN_MODE_CURVE), _ => None }
}

fn fail(per: &mut Map<String, Value>, ok: &mut bool, control: &str, code: &str, message: impl Into<String>) {
    *ok = false;
    per.insert(control.to_owned(), json!({"ok": false, "errorCode": code, "message": message.into()}));
}

fn verify(
    config: &FanConfig,
    expected_mode: &str,
    curve: Option<&[(u32, i32)]>,
    flat: Option<i32>,
    fixed: Option<i32>,
    max_rpm: i32,
) -> Result<(), String> {
    let got_mode = mode_name(config.mode);
    // A fixed-speed request can fall back to a flat table when the driver
    // refuses the dedicated fixed setter. The driver may keep reporting its
    // previous fixed mode while accepting that table, so a flat-table
    // verification tolerates fixed mode here and then checks either the fixed
    // speed or the table below. Without this, a card that refuses the fixed
    // setter after its first successful fixed apply fails every later manual
    // fan apply.
    let flat_mode = flat.is_some() && got_mode == Some(FAN_MODE_FIXED);
    if got_mode != Some(expected_mode) && !flat_mode {
        return Err(format!("fan mode read-back {} != requested {expected_mode}", got_mode.unwrap_or("unknown")));
    }
    if let Some(expected) = curve {
        if config.table.len() != expected.len() {
            return Err(format!("fan curve read-back {} points != requested {}", config.table.len(), expected.len()));
        }
        for (index, (temperature, speed)) in expected.iter().enumerate() {
            let (got_t, got_speed, units) = config.table[index];
            let got_pct = fan_pct(got_speed, units, max_rpm).ok_or("fan curve read-back uses an unsupported speed unit")?;
            if (f64::from(got_t) - f64::from(*temperature)).abs() > 1.0
                || (got_pct - f64::from(*speed)).abs() > 1.0 {
                return Err(format!("fan curve point {index} read-back {got_t}C/{got_pct}% != requested {temperature}C/{speed}%"));
            }
        }
    }
    if let Some(percent) = flat {
        let fixed_matches = flat_mode && fan_pct(config.fixed_speed, config.fixed_units, max_rpm)
            .is_some_and(|got| (got - f64::from(percent)).abs() <= 1.0);
        if fixed_matches { return Ok(()); }
        if config.table.len() < 2 || config.table.len() > 32 {
            return Err("flat-table read-back has an invalid point count".into());
        }
        for (index, (_, speed, units)) in config.table.iter().enumerate() {
            let got_pct = fan_pct(*speed, *units, max_rpm).ok_or("flat-table read-back uses an unsupported speed unit")?;
            if (got_pct - f64::from(percent)).abs() > 1.0 {
                return Err(format!("flat-table point {index} read-back {got_pct}% != requested {percent}%"));
            }
        }
    }
    if let Some(percent) = fixed {
        let got_pct = fan_pct(config.fixed_speed, config.fixed_units, max_rpm)
            .ok_or("fixed fan speed read-back uses an unsupported speed unit")?;
        if (got_pct - f64::from(percent)).abs() > 1.0 {
            return Err(format!("fixed fan speed read-back {got_pct}% != requested {percent}%"));
        }
    }
    Ok(())
}

/// Some drivers may expose the previous mode briefly after accepting a table.
/// Re-read only; never repeat a write or accept an unverified configuration.
fn verify_with_settle(
    backend: &mut dyn FanBackend,
    expected_mode: &str,
    curve: Option<&[(u32, i32)]>,
    flat: Option<i32>,
    fixed: Option<i32>,
    max_rpm: i32,
    wait: &mut dyn FnMut(),
) -> Result<(), String> {
    let mut last_error = String::new();
    // The fan controller can lag a mode/flat-table switch, and the delay grows
    // after several rapid applies. Keep re-reading for ~1.8 s without ever
    // repeating a setter; an unverified write still fails.
    for attempt in 0..12 {
        if attempt > 0 { wait(); }
        match backend.read_config()
            .map_err(|result| format!("fan set succeeded but read-back failed (0x{result:08x})"))
            .and_then(|config| verify(&config, expected_mode, curve, flat, fixed, max_rpm)) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn mode_mismatch(message: &str) -> bool {
    message.starts_with("fan mode read-back")
}

/// The driver can accept the table setter yet keep reporting its previous
/// mode. A curve/fixed re-entry (default, then the requested setter) is the
/// same mode-flip recovery the fan probe already uses to restore defaults.
/// It runs at most once, and only after a successful write whose read-back
/// mismatched on the mode - never after a refused write.
fn verify_table_with_reentry(
    backend: &mut dyn FanBackend,
    native: &[(u32, i32)],
    max_rpm: i32,
    wait: &mut impl FnMut(),
) -> Result<(), String> {
    let first = verify_with_settle(backend, FAN_MODE_CURVE, Some(native), None, None, max_rpm, &mut *wait);
    let Err(message) = first else { return first; };
    if !mode_mismatch(&message) { return Err(message); }
    if backend.set_default() != 0 { return Err(message); }
    wait();
    if backend.set_table(native) != 0 { return Err(message); }
    verify_with_settle(backend, FAN_MODE_CURVE, Some(native), None, None, max_rpm, &mut *wait)
}

fn verify_fixed_with_reentry(
    backend: &mut dyn FanBackend,
    percent: i32,
    max_rpm: i32,
    wait: &mut impl FnMut(),
) -> Result<(), String> {
    let first = verify_with_settle(backend, FAN_MODE_FIXED, None, None, Some(percent), max_rpm, &mut *wait);
    let Err(message) = first else { return first; };
    if !mode_mismatch(&message) { return Err(message); }
    if backend.set_default() != 0 { return Err(message); }
    wait();
    if backend.set_fixed(percent) != 0 { return Err(message); }
    verify_with_settle(backend, FAN_MODE_FIXED, None, None, Some(percent), max_rpm, &mut *wait)
}

fn verify_flat_with_reentry(
    backend: &mut dyn FanBackend,
    native: &[(u32, i32)],
    percent: i32,
    max_rpm: i32,
    wait: &mut impl FnMut(),
) -> Result<(), String> {
    let first = verify_with_settle(backend, FAN_MODE_CURVE, None, Some(percent), None, max_rpm, &mut *wait);
    let Err(message) = first else { return first; };
    if !mode_mismatch(&message) { return Err(message); }
    if backend.set_default() != 0 { return Err(message); }
    wait();
    if backend.set_table(native) != 0 { return Err(message); }
    verify_with_settle(backend, FAN_MODE_CURVE, None, Some(percent), None, max_rpm, &mut *wait)
}

fn verify_auto_with_reassert(
    backend: &mut dyn FanBackend,
    max_rpm: i32,
    wait: &mut impl FnMut(),
) -> Result<(), String> {
    let first = verify_with_settle(backend, FAN_MODE_AUTO, None, None, None, max_rpm, &mut *wait);
    let Err(message) = first else { return first; };
    if !mode_mismatch(&message) { return Err(message); }
    if backend.set_default() != 0 { return Err(message); }
    verify_with_settle(backend, FAN_MODE_AUTO, None, None, None, max_rpm, &mut *wait)
}

fn curve_points(settings: &Value, max_points: f64) -> Option<Vec<FanPoint>> {
    let points = settings.get("fanCurve")?.as_array()?;
    let parsed: Vec<FanPoint> = points.iter().filter_map(|point| Some(FanPoint {
        t: point.get("t")?.as_f64()?,
        speed_pct: point.get("speedPct")?.as_f64()?,
    })).collect();
    (parsed.len() == points.len()).then(|| normalize_fan_curve(&parsed, max_points))
}

pub fn apply_fan(settings: &Value, caps: &Value, backend: &mut dyn FanBackend) -> Value {
    let mut per = Map::new();
    let mut ok = true;
    let fan = caps.get("fan").cloned().unwrap_or(Value::Null);
    let requested: Vec<&str> = ["fanMode", "fanCurve", "fixedFanPct"].iter()
        .filter(|key| settings.get(**key).is_some_and(|value| !value.is_null()))
        .copied().collect();
    if requested.is_empty() { return json!({"ok": true, "perControl": per}); }
    let can_control = fan.get("canControl") == Some(&Value::Bool(true));
    if !can_control {
        for control in requested { fail(&mut per, &mut ok, control, "unsupported", "fan control is read-only on this device (canControl=false)"); }
        return json!({"ok": ok, "perControl": per});
    }
    let modes: Vec<String> = fan.get("modes").and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect();
    let mut mode = settings.get("fanMode").and_then(Value::as_str).map(str::to_owned);
    if mode.is_none() {
        if settings.get("fanCurve").is_some_and(|value| !value.is_null()) { mode = Some(FAN_MODE_CURVE.into()); }
        else if settings.get("fixedFanPct").is_some_and(|value| !value.is_null()) { mode = Some(FAN_MODE_FIXED.into()); }
    }
    let Some(mode) = mode else { return json!({"ok": false, "perControl": {"fanMode": {"ok": false, "errorCode": "out-of-range", "message": "fan mode could not be derived"}}}); };
    if !modes.contains(&mode) {
        for control in requested { fail(&mut per, &mut ok, control, "unsupported", format!("fan mode {mode} not supported on this device")); }
        return json!({"ok": ok, "perControl": per});
    }
    if mode == FAN_MODE_CURVE && settings.get("fanCurve").is_none() {
        fail(&mut per, &mut ok, "fanMode", "out-of-range", "fanCurve is required for curve mode");
        return json!({"ok": ok, "perControl": per});
    }
    if mode == FAN_MODE_FIXED && settings.get("fixedFanPct").and_then(Value::as_f64).is_none() {
        fail(&mut per, &mut ok, "fanMode", "out-of-range", "fixedFanPct is required for fixed mode");
        return json!({"ok": ok, "perControl": per});
    }
    let max_rpm = fan.get("maxRpm").and_then(Value::as_i64).unwrap_or(-1) as i32;
    let max_points = fan.get("maxCurvePoints").and_then(Value::as_f64).unwrap_or(32.0);
    let mut curve_ok = false;
    let expected_curve = curve_points(settings, max_points);
    if settings.get("fanCurve").is_some_and(|value| !value.is_null()) {
        let Some(expected) = expected_curve.as_ref() else {
            fail(&mut per, &mut ok, "fanCurve", "out-of-range", "fanCurve points are invalid");
            return json!({"ok": ok, "perControl": per});
        };
        if expected.len() < 2 {
            fail(&mut per, &mut ok, "fanCurve", "out-of-range", "fanCurve requires at least two points");
            return json!({"ok": ok, "perControl": per});
        }
        let native: Vec<(u32, i32)> = expected.iter().map(|point| (point.t.max(0.0) as u32, point.speed_pct.round() as i32)).collect();
        let set_result = backend.set_table(&native);
        if set_result != 0 {
            fail(&mut per, &mut ok, "fanCurve", igcl_error_code(set_result).unwrap_or("io-failed"), format!("IGCL result 0x{set_result:08x}"));
        } else {
            let verification = verify_table_with_reentry(&mut *backend, &native, max_rpm,
                &mut || std::thread::sleep(std::time::Duration::from_millis(150)));
            match verification {
                Ok(()) => { curve_ok = true; per.insert("fanCurve".into(), json!({"ok": true, "readBackEqual": true})); }
                Err(message) => {
                    ok = false;
                    per.insert("fanCurve".into(), json!({"ok": false, "readBackEqual": false, "errorCode": "io-failed", "message": message}));
                }
            }
        }
    }
    let mut fixed_ok = false;
    if let Some(value) = settings.get("fixedFanPct").and_then(Value::as_f64) {
        if !value.is_finite() { fail(&mut per, &mut ok, "fixedFanPct", "out-of-range", "fixedFanPct must be finite"); }
        else {
            let percent = clamp_fan_pct(value).round() as i32;
            let mut flat = false;
            let set_result = backend.set_fixed(percent);
            if set_result == 0 {
                let verification = verify_fixed_with_reentry(&mut *backend, percent, max_rpm,
                    &mut || std::thread::sleep(std::time::Duration::from_millis(150)));
                match verification {
                    Ok(()) => { fixed_ok = true; per.insert("fixedFanPct".into(), json!({"ok": true, "readBackEqual": true})); }
                    Err(message) => { ok = false; per.insert("fixedFanPct".into(), json!({"ok": false, "readBackEqual": false, "errorCode": "io-failed", "message": message})); }
                }
            } else if set_result == 0x4000_000a || set_result == 0x4000_0007 {
                flat = true;
            } else {
                fail(&mut per, &mut ok, "fixedFanPct", igcl_error_code(set_result).unwrap_or("io-failed"), format!("IGCL result 0x{set_result:08x}"));
            }
            if flat {
                let native = [(20_u32, percent), (100_u32, percent)];
                let table_result = backend.set_table(&native);
                if table_result != 0 {
                    fail(&mut per, &mut ok, "fixedFanPct", igcl_error_code(table_result).unwrap_or("io-failed"), format!("IGCL result 0x{table_result:08x}"));
                } else {
                    let verification = verify_flat_with_reentry(&mut *backend, &native, percent, max_rpm,
                        &mut || std::thread::sleep(std::time::Duration::from_millis(150)));
                    match verification {
                        Ok(()) => { fixed_ok = true; per.insert("fixedFanPct".into(), json!({"ok": true, "readBackEqual": true})); }
                        Err(message) => { ok = false; per.insert("fixedFanPct".into(), json!({"ok": false, "readBackEqual": false, "errorCode": "io-failed", "message": message})); }
                    }
                }
            }
        }
    }
    if let Some(requested_mode) = settings.get("fanMode").and_then(Value::as_str) {
        match requested_mode {
            FAN_MODE_CURVE => {
                let entry = if curve_ok { json!({"ok": true, "readBackEqual": true}) }
                    else { per.get("fanCurve").cloned().unwrap_or_else(|| json!({"ok": false, "errorCode": "io-failed", "message": "fan curve apply failed"})) };
                per.insert("fanMode".into(), entry);
                if !curve_ok { ok = false; }
            }
            FAN_MODE_FIXED => {
                let entry = if fixed_ok { json!({"ok": true, "readBackEqual": true}) }
                    else { per.get("fixedFanPct").cloned().unwrap_or_else(|| json!({"ok": false, "errorCode": "io-failed", "message": "fixed fan speed apply failed"})) };
                per.insert("fanMode".into(), entry);
                if !fixed_ok { ok = false; }
            }
            FAN_MODE_AUTO => {
                let set_result = backend.set_default();
                if set_result != 0 {
                    fail(&mut per, &mut ok, "fanMode", igcl_error_code(set_result).unwrap_or("io-failed"), format!("IGCL result 0x{set_result:08x}"));
                } else {
                    let verification = verify_auto_with_reassert(&mut *backend, max_rpm,
                        &mut || std::thread::sleep(std::time::Duration::from_millis(150)));
                    match verification {
                        Ok(()) => { per.insert("fanMode".into(), json!({"ok": true, "readBackEqual": true})); }
                        Err(message) => { ok = false; per.insert("fanMode".into(), json!({"ok": false, "readBackEqual": false, "errorCode": "io-failed", "message": message})); }
                    }
                }
            }
            other => fail(&mut per, &mut ok, "fanMode", "out-of-range", format!("unknown fan mode {other}")),
        }
    }
    json!({"ok": ok, "perControl": per})
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAPS: &str = r#"{
        "fan": {"canControl": true, "modes": ["auto", "curve", "fixed"], "maxRpm": 3000, "maxCurvePoints": 10}
    }"#;

    fn caps() -> Value { serde_json::from_str(CAPS).unwrap() }
    fn curve() -> Value { json!([{"t": 40, "speedPct": 30}, {"t": 80, "speedPct": 70}]) }

    struct Mock {
        mode: i32,
        table: Vec<(i32, i32, i32)>,
        fixed: i32,
        set_table_result: u32,
        set_fixed_result: u32,
        set_default_result: u32,
        writes: Vec<(&'static str, Vec<(u32, i32)>)>,
    }

    impl Default for Mock {
        fn default() -> Self {
            Self { mode: 0, table: Vec::new(), fixed: 0, set_table_result: 0, set_fixed_result: 0, set_default_result: 0, writes: Vec::new() }
        }
    }

    impl FanBackend for Mock {
        fn set_table(&mut self, points: &[(u32, i32)]) -> u32 {
            self.writes.push(("table", points.to_vec()));
            if self.set_table_result == 0 {
                self.mode = 2;
                self.table = points.iter().map(|(t, p)| (*t as i32, *p, FAN_UNITS_PERCENT)).collect();
            }
            self.set_table_result
        }
        fn set_fixed(&mut self, percent: i32) -> u32 {
            self.writes.push(("fixed", vec![(percent as u32, percent)]));
            if self.set_fixed_result == 0 { self.mode = 1; self.fixed = percent; }
            self.set_fixed_result
        }
        fn set_default(&mut self) -> u32 {
            self.writes.push(("default", Vec::new()));
            if self.set_default_result == 0 { self.mode = 0; }
            self.set_default_result
        }
        fn read_config(&mut self) -> Result<FanConfig, u32> {
            Ok(FanConfig { mode: self.mode, table: self.table.clone(), fixed_speed: self.fixed, fixed_units: FAN_UNITS_PERCENT })
        }
    }

    struct Delayed { inner: Mock, stale: FanConfig, stale_reads: usize }
    impl FanBackend for Delayed {
        fn set_table(&mut self, points: &[(u32, i32)]) -> u32 { self.inner.set_table(points) }
        fn set_fixed(&mut self, percent: i32) -> u32 { self.inner.set_fixed(percent) }
        fn set_default(&mut self) -> u32 { self.inner.set_default() }
        fn read_config(&mut self) -> Result<FanConfig, u32> {
            if self.stale_reads > 0 { self.stale_reads -= 1; Ok(self.stale.clone()) }
            else { self.inner.read_config() }
        }
    }

    #[test]
    fn delayed_fan_modes_are_verified_without_repeating_setters() {
        for (settings, initial_mode) in [
            (json!({"fanMode":"curve","fanCurve":curve()}), 0),
            (json!({"fanMode":"fixed","fixedFanPct":55}), 0),
            (json!({"fanMode":"auto"}), 2),
        ] {
            let mut backend = Delayed { inner: Mock::default(), stale_reads: 1,
                stale: FanConfig { mode: initial_mode, table: vec![], fixed_speed: 0, fixed_units: 1 } };
            let result = apply_fan(&settings, &caps(), &mut backend);
            assert_eq!(result["ok"], true, "{result}");
            assert_eq!(backend.inner.writes.len(), 1);
        }
    }

    #[test]
    fn persistent_previous_mode_gets_one_mode_flip_then_fails() {
        let mut backend = Delayed { inner: Mock::default(), stale_reads: 100,
            stale: FanConfig { mode: 0, table: vec![], fixed_speed: 0, fixed_units: 1 } };
        let result = apply_fan(&json!({"fanMode":"curve","fanCurve":curve()}), &caps(), &mut backend);
        assert_eq!(result["ok"], false);
        assert_eq!(result["perControl"]["fanCurve"]["message"], "fan mode read-back auto != requested curve");
        // The first table write, one default re-entry, and one retry. A refused
        // write or a table-point mismatch never reaches this recovery.
        assert_eq!(backend.inner.writes.len(), 3);
        assert_eq!(backend.inner.writes.iter().map(|write| write.0).collect::<Vec<_>>(),
            vec!["table", "default", "table"]);
    }

    #[test]
    fn a_driver_stuck_in_auto_accepts_the_table_after_one_mode_flip() {
        struct StuckUntilReset { inner: Mock, reset: bool }
        impl FanBackend for StuckUntilReset {
            fn set_table(&mut self, points: &[(u32, i32)]) -> u32 {
                let result = self.inner.set_table(points);
                if !self.reset { self.inner.mode = 0; }
                result
            }
            fn set_fixed(&mut self, percent: i32) -> u32 { self.inner.set_fixed(percent) }
            fn set_default(&mut self) -> u32 {
                let result = self.inner.set_default();
                self.reset = true;
                result
            }
            fn read_config(&mut self) -> Result<FanConfig, u32> { self.inner.read_config() }
        }
        let mut backend = StuckUntilReset { inner: Mock::default(), reset: false };
        let result = apply_fan(&json!({"fanMode":"curve","fanCurve":curve()}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(backend.inner.writes.iter().map(|write| write.0).collect::<Vec<_>>(),
            vec!["table", "default", "table"]);
        assert_eq!(backend.inner.mode, 2);
    }

    #[test]
    fn auto_is_reasserted_once_when_the_driver_keeps_the_previous_mode() {
        struct SlowDefault { inner: Mock, calls: usize }
        impl FanBackend for SlowDefault {
            fn set_table(&mut self, points: &[(u32, i32)]) -> u32 { self.inner.set_table(points) }
            fn set_fixed(&mut self, percent: i32) -> u32 { self.inner.set_fixed(percent) }
            fn set_default(&mut self) -> u32 {
                self.inner.writes.push(("default", Vec::new()));
                self.calls += 1;
                if self.calls > 1 { self.inner.mode = 0; }
                0
            }
            fn read_config(&mut self) -> Result<FanConfig, u32> { self.inner.read_config() }
        }
        let mut backend = SlowDefault { inner: Mock { mode: 2, ..Mock::default() }, calls: 0 };
        let result = apply_fan(&json!({"fanMode":"auto"}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(backend.inner.mode, 0);
        assert_eq!(backend.inner.writes.len(), 2);
    }

    #[test]
    fn applies_curve_fixed_and_auto_with_readback() {
        let mut backend = Mock::default();
        let result = apply_fan(&json!({"fanMode": "curve", "fanCurve": curve()}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(backend.mode, 2);
        let mut backend = Mock::default();
        let result = apply_fan(&json!({"fanMode": "fixed", "fixedFanPct": 55}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(backend.mode, 1);
        assert_eq!(backend.fixed, 55);
        let mut backend = Mock::default();
        let result = apply_fan(&json!({"fanMode": "auto"}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(backend.mode, 0);
    }

    #[test]
    fn flat_table_fallback_is_used_when_fixed_is_refused() {
        let mut backend = Mock { set_fixed_result: 0x4000_000a, ..Mock::default() };
        let result = apply_fan(&json!({"fanMode": "fixed", "fixedFanPct": 50}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(backend.writes.last().unwrap().0, "table");
        assert_eq!(backend.mode, 2);
    }

    #[test]
    fn flat_table_fallback_accepts_a_driver_that_keeps_reporting_fixed() {
        struct FixedModeTable(Mock);
        impl FanBackend for FixedModeTable {
            fn set_table(&mut self, points: &[(u32, i32)]) -> u32 {
                self.0.writes.push(("table", points.to_vec()));
                // The driver refuses the fixed setter but accepts the flat
                // table while leaving its mode at fixed and its old fixed speed.
                self.0.mode = 1;
                self.0.fixed = 0;
                self.0.table = points.iter().map(|(t, p)| (*t as i32, *p, FAN_UNITS_PERCENT)).collect();
                self.0.set_table_result
            }
            fn set_fixed(&mut self, percent: i32) -> u32 {
                self.0.writes.push(("fixed", vec![(percent as u32, percent)]));
                self.0.set_fixed_result
            }
            fn set_default(&mut self) -> u32 { self.0.set_default() }
            fn read_config(&mut self) -> Result<FanConfig, u32> { self.0.read_config() }
        }
        let mut backend = FixedModeTable(Mock { set_fixed_result: 0x4000_000a, ..Mock::default() });
        let result = apply_fan(&json!({"fanMode": "fixed", "fixedFanPct": 55}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(backend.0.mode, 1);
        assert_eq!(backend.0.fixed, 0);
        assert!(backend.0.table.iter().all(|(_, percent, _)| *percent == 55));
    }

    #[test]
    fn fixed_mode_preserves_the_fixed_speed_failure() {
        let mut backend = Mock { set_fixed_result: 0x4000_0001, ..Mock::default() };
        let result = apply_fan(&json!({"fanMode": "fixed", "fixedFanPct": 50}), &caps(), &mut backend);
        assert_eq!(result["perControl"]["fixedFanPct"]["message"], "IGCL result 0x40000001");
        assert_eq!(result["perControl"]["fanMode"], result["perControl"]["fixedFanPct"]);
    }

    #[test]
    fn read_only_missing_data_and_bad_modes_fail_before_writes() {
        let mut read_only = caps();
        read_only["fan"]["canControl"] = json!(false);
        let mut backend = Mock::default();
        let result = apply_fan(&json!({"fanMode": "auto"}), &read_only, &mut backend);
        assert_eq!(result["perControl"]["fanMode"]["errorCode"], "unsupported");
        assert!(backend.writes.is_empty());
        let mut backend = Mock::default();
        let result = apply_fan(&json!({"fanMode": "curve"}), &caps(), &mut backend);
        assert_eq!(result["perControl"]["fanMode"]["errorCode"], "out-of-range");
        assert!(backend.writes.is_empty());
        let mut backend = Mock::default();
        let result = apply_fan(&json!({"fanMode": "curve", "fanCurve": curve(), "fixedFanPct": 50}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
    }

    #[test]
    fn readback_mismatch_is_reported() {
        struct Bad(Mock);
        impl FanBackend for Bad {
            fn set_table(&mut self, points: &[(u32, i32)]) -> u32 { self.0.set_table(points) }
            fn set_fixed(&mut self, percent: i32) -> u32 { self.0.set_fixed(percent) }
            fn set_default(&mut self) -> u32 { self.0.set_default() }
            fn read_config(&mut self) -> Result<FanConfig, u32> {
                Ok(FanConfig { mode: 2, table: vec![(40, 30, FAN_UNITS_PERCENT)], fixed_speed: 0, fixed_units: FAN_UNITS_PERCENT })
            }
        }
        let mut backend = Bad(Mock::default());
        let result = apply_fan(&json!({"fanMode": "curve", "fanCurve": curve()}), &caps(), &mut backend);
        assert_eq!(result["ok"], false);
        assert_eq!(result["perControl"]["fanCurve"]["readBackEqual"], false);
        assert_eq!(result["perControl"]["fanMode"], result["perControl"]["fanCurve"]);
    }

    #[test]
    fn edited_preset_point_is_sent_and_verified() {
        let preset = json!([{ "t": 30, "speedPct": 20 }, { "t": 50, "speedPct": 40 }, { "t": 80, "speedPct": 70 }]);
        let edited = json!([{ "t": 30, "speedPct": 20 }, { "t": 53, "speedPct": 45 }, { "t": 80, "speedPct": 70 }]);
        let mut backend = Mock::default();
        assert_eq!(apply_fan(&json!({"fanMode": "curve", "fanCurve": preset}), &caps(), &mut backend)["ok"], true);
        let result = apply_fan(&json!({"fanMode": "curve", "fanCurve": edited}), &caps(), &mut backend);
        assert_eq!(result["ok"], true, "{result}");
        assert_eq!(backend.writes.last().unwrap().1, vec![(30, 20), (53, 45), (80, 70)]);

        struct Mismatch(Mock);
        impl FanBackend for Mismatch {
            fn set_table(&mut self, points: &[(u32, i32)]) -> u32 { self.0.set_table(points) }
            fn set_fixed(&mut self, percent: i32) -> u32 { self.0.set_fixed(percent) }
            fn set_default(&mut self) -> u32 { self.0.set_default() }
            fn read_config(&mut self) -> Result<FanConfig, u32> {
                let mut config = self.0.read_config()?;
                config.table[1].1 = 40;
                Ok(config)
            }
        }
        let mut mismatch = Mismatch(Mock::default());
        let result = apply_fan(&json!({"fanMode": "curve", "fanCurve": edited}), &caps(), &mut mismatch);
        assert_eq!(mismatch.0.writes.last().unwrap().1, vec![(30, 20), (53, 45), (80, 70)]);
        assert_eq!(result["perControl"]["fanCurve"]["message"], "fan curve point 1 read-back 53C/40% != requested 53C/45%");
        assert_eq!(result["perControl"]["fanMode"], result["perControl"]["fanCurve"]);
    }

    #[test]
    fn descending_speeds_are_sent_unchanged_and_driver_failure_is_preserved() {
        let mut backend = Mock { set_table_result: 0x4000_0001, ..Mock::default() };
        let result = apply_fan(&json!({"fanMode": "curve", "fanCurve": [
            {"t": 60, "speedPct": 40}, {"t": 73, "speedPct": 51}, {"t": 80, "speedPct": 45}
        ]}), &caps(), &mut backend);
        assert_eq!(backend.writes[0].1, vec![(60, 40), (73, 51), (80, 45)]);
        assert_eq!(result["perControl"]["fanCurve"]["message"], "IGCL result 0x40000001");
        assert_eq!(result["perControl"]["fanMode"], result["perControl"]["fanCurve"]);
    }
}
