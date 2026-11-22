//! Native VF curve write core (mock-verified first slice).
//! Validates the canonical curve, requires the driver's current point count,
//! refuses active core offsets, writes once, and verifies the LIVE read-back.
use super::gpu_apply::igcl_error_code;
use super::vf_curve::{
    is_valid_native_vf_curve, prepare_vf_curve_for_driver, same_vf_curve, VfCurvePoint, VfCurveRange,
};
use serde_json::{json, Value};

const OFFSET_ACTIVE_EPSILON: f64 = 0.001;

/// Post-write read policy. Electron uses 21 reads with a 15-read quorum and a
/// 100 ms cadence; B580/Battlemage accepts a driver-normalized uniform voltage
/// origin shift after a stable quorum.
#[derive(Clone, Copy, Debug)]
pub struct VfVerifyOptions {
    pub max_attempts: usize,
    pub quorum: usize,
    pub poll_ms: u64,
    pub driver_authoritative: bool,
}
impl Default for VfVerifyOptions {
    fn default() -> Self {
        Self { max_attempts: 21, quorum: 15, poll_ms: 100, driver_authoritative: false }
    }
}

fn shape_key(points: &[VfCurvePoint]) -> Vec<(i64, i64)> {
    let base = points.first().map(|point| point.voltage_v).unwrap_or(0.0);
    points.iter().map(|point| (
        (point.freq_mhz * 1000.0).round() as i64,
        ((point.voltage_v - base) * 1000.0).round() as i64,
    )).collect()
}

fn uniform_voltage_shift_mv(left: &[VfCurvePoint], right: &[VfCurvePoint]) -> Option<i64> {
    if left.len() != right.len() || left.len() < 2 { return None; }
    let shift = ((left[0].voltage_v - right[0].voltage_v) * 1000.0).round() as i64;
    left.iter().zip(right).all(|(point, other)| {
        point.freq_mhz == other.freq_mhz
            && (((point.voltage_v - other.voltage_v) * 1000.0).round() as i64) == shift
    }).then_some(shift)
}

fn stable_live(backend: &mut dyn VfBackend, options: &VfVerifyOptions) -> Result<Vec<VfCurvePoint>, u32> {
    let attempts = options.max_attempts.max(1);
    let quorum = options.quorum.clamp(1, attempts);
    let mut observations: Vec<Vec<VfCurvePoint>> = Vec::new();
    let mut last_error = 0x4000_000b_u32;
    for attempt in 0..attempts {
        match backend.read_live() {
            Ok(points) => {
                observations.push(canonical(&points));
                if observations.len() >= quorum {
                    let latest = observations.last().expect("non-empty");
                    let latest_shape = shape_key(latest);
                    let base = latest.first().map(|point| point.voltage_v).unwrap_or(0.0);
                    let matching = observations.iter().filter(|points| {
                        shape_key(points) == latest_shape
                            && (points.first().map(|point| point.voltage_v).unwrap_or(0.0) - base).abs() <= 0.004
                    }).count();
                    if matching >= quorum { return Ok(latest.clone()); }
                }
            }
            Err(result) => last_error = result,
        }
        if attempt + 1 < attempts && options.poll_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(options.poll_ms));
        }
    }
    Err(last_error)
}

pub trait VfBackend {
    fn read_stock(&mut self) -> Result<Vec<(u32, u32)>, u32>;
    fn read_live(&mut self) -> Result<Vec<(u32, u32)>, u32>;
    fn write_curve(&mut self, points: &[(u32, u32)]) -> u32;
    /// Canonical core offsets (MHz, V).
    fn read_offsets(&mut self) -> Result<(f64, f64), u32>;
}

fn fail(error_code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "perControl": {"vfCurve": {
        "ok": false, "errorCode": error_code, "message": message.into(),
    }}})
}

/// Battlemage-class adapter detection for driver-normalized VF acceptance.
pub fn is_battlemage(caps: &Value) -> bool {
    let name = caps.get("deviceName").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    ["b580", "b570", "b50", "b60", "battlemage"].iter().any(|token| name.contains(token))
}

fn canonical(points: &[(u32, u32)]) -> Vec<VfCurvePoint> {
    points.iter().map(|(voltage, frequency)| VfCurvePoint {
        voltage_v: f64::from(*voltage) / 1000.0,
        freq_mhz: f64::from(*frequency),
    }).collect()
}

fn curve_json(points: &[VfCurvePoint]) -> Value {
    Value::Array(points.iter().map(|point| json!({
        "voltageV": point.voltage_v, "freqMhz": point.freq_mhz,
    })).collect())
}

/// Apply one custom VF curve. Returns `{ok, perControl:{vfCurve:...}}`.
pub fn apply_vf_curve(settings: &Value, caps: &Value, backend: &mut dyn VfBackend, options: &VfVerifyOptions) -> Value {
    let Some(range_value) = caps.get("vfCurveRange") else {
        return fail("unsupported", "custom VF curve not supported on this device");
    };
    let Ok(range) = serde_json::from_value::<VfCurveRange>(range_value.clone()) else {
        return fail("unsupported", "the VF curve range is malformed");
    };
    let Some(points) = settings.get("vfCurve").and_then(Value::as_array) else {
        return fail("invalid-argument", "vfCurve must be an array of points");
    };
    let mut curve = Vec::with_capacity(points.len());
    for point in points {
        let (Some(voltage), Some(frequency)) = (
            point.get("voltageV").and_then(Value::as_f64).filter(|value| value.is_finite()),
            point.get("freqMhz").and_then(Value::as_f64).filter(|value| value.is_finite()),
        ) else {
            return fail("out-of-range", "VF curve points must be finite");
        };
        curve.push(VfCurvePoint { voltage_v: voltage, freq_mhz: frequency });
    }
    if curve.len() < 2 || curve.len() > range.max_points.max(2.0) as usize {
        return fail("out-of-range", "VF curve point count is outside the supported range");
    }
    if !curve.windows(2).all(|pair| pair[1].voltage_v > pair[0].voltage_v && pair[1].freq_mhz >= pair[0].freq_mhz) {
        return fail("out-of-range", "VF curve points must be ordered");
    }
    let Some(prepared) = prepare_vf_curve_for_driver(&curve, &range) else {
        return fail("out-of-range", "VF curve voltages must match the driver voltage step, and frequencies must be whole MHz values within the supported range");
    };

    let stock = match backend.read_stock() {
        Ok(points) => points,
        Err(result) => return fail(igcl_error_code(result).unwrap_or("readback-unverified"), "the driver STOCK VF curve could not be read"),
    };
    let live = match backend.read_live() {
        Ok(points) => points,
        Err(result) => return fail(igcl_error_code(result).unwrap_or("readback-unverified"), "the driver LIVE VF curve could not be read"),
    };
    if stock.len() != prepared.len() {
        return fail("out-of-range", format!(
            "Battlemage requires the driver's current {}-point simplified VF table; point count cannot be changed",
            stock.len()));
    }
    let stock_canonical = canonical(&stock);
    let live_canonical = canonical(&live);
    if !is_valid_native_vf_curve(Some(&stock_canonical), &range)
        || !is_valid_native_vf_curve(Some(&live_canonical), &range) {
        return fail("io-failed", "the driver returned an invalid simplified VF curve shape; no change was written");
    }
    if live.len() != prepared.len() {
        return fail("readback-unverified", "the current LIVE VF curve does not match the requested point count; no curve write was sent");
    }
    match backend.read_offsets() {
        Ok((frequency, voltage)) if frequency.abs() <= OFFSET_ACTIVE_EPSILON && voltage.abs() <= OFFSET_ACTIVE_EPSILON => {}
        Ok(_) => return fail("dependency-failed", "Reset the GPU core frequency and voltage offsets to zero before applying a custom VF curve. The driver uses both controls on the same tuning surface."),
        Err(_) => return fail("dependency-failed", "The active GPU core offsets could not be read, so the VF curve was not written. Verify both core offsets before applying a curve."),
    }
    if same_vf_curve(Some(&prepared), Some(&live_canonical), 0.0, 0.0) {
        return json!({"ok": true, "perControl": {"vfCurve": {
            "ok": true, "readBackEqual": true, "normalized": false,
            "readBackCurve": curve_json(&live_canonical),
        }}});
    }

    let native: Vec<(u32, u32)> = prepared.iter()
        .map(|point| ((point.voltage_v * 1000.0).round() as u32, point.freq_mhz.round() as u32))
        .collect();
    let set_result = backend.write_curve(&native);
    if set_result != 0 {
        return fail(igcl_error_code(set_result).unwrap_or("io-failed"), format!("IGCL result 0x{set_result:08x}"));
    }
    let after = match stable_live(backend, options) {
        Ok(points) => points,
        Err(result) => return json!({"ok": false, "perControl": {"vfCurve": {
            "ok": false, "errorCode": igcl_error_code(result).unwrap_or("readback-unverified"),
            "message": "the curve write succeeded but the LIVE read-back did not reach a stable quorum",
            "readBackEqual": false, "silentNoop": false,
        }}}),
    };
    if after.len() != prepared.len() {
        return json!({"ok": false, "perControl": {"vfCurve": {
            "ok": false, "errorCode": "driver-invalid-readback",
            "message": format!("the driver returned {}-point LIVE output for a {}-point request", after.len(), prepared.len()),
            "readBackEqual": false, "silentNoop": false, "readBackCurve": curve_json(&after),
        }}});
    }
    if !is_valid_native_vf_curve(Some(&after), &range) {
        return json!({"ok": false, "perControl": {"vfCurve": {
            "ok": false, "errorCode": "driver-invalid-readback",
            "message": "the driver returned an invalid ordered LIVE curve",
            "readBackEqual": false, "silentNoop": false, "readBackCurve": curve_json(&after),
        }}});
    }
    let exact = same_vf_curve(Some(&prepared), Some(&after), 0.0, 0.0);
    if exact {
        return json!({"ok": true, "perControl": {"vfCurve": {
            "ok": true, "readBackEqual": true, "normalized": false,
            "readBackCurve": curve_json(&after),
        }}});
    }
    if options.driver_authoritative {
        // A common voltage-origin shift alone cannot prove the requested edit
        // applied: require the LIVE shape (frequencies + relative voltages) to
        // differ from the before image.
        if shape_key(&after) == shape_key(&live_canonical) {
            return json!({"ok": false, "perControl": {"vfCurve": {
                "ok": false, "errorCode": "driver-noop",
                "message": "IGCL reported success, but no change to LIVE frequencies or relative voltage spacing was observed. Your requested draft was kept unchanged.",
                "readBackEqual": false, "silentNoop": true, "readBackCurve": curve_json(&after),
            }}});
        }
        let shift = uniform_voltage_shift_mv(&after, &prepared);
        let mut entry = serde_json::Map::new();
        entry.insert("ok".into(), json!(true));
        entry.insert("readBackEqual".into(), json!(false));
        entry.insert("normalized".into(), json!(true));
        entry.insert("driverAdjusted".into(), json!(true));
        entry.insert("silentNoop".into(), json!(false));
        if let Some(shift) = shift { entry.insert("uniformVoltageShiftMv".into(), json!(shift)); }
        entry.insert("readBackCurve".into(), curve_json(&after));
        entry.insert("message".into(), json!("IGCL reported success. The editor now shows the validated LIVE curve returned by the driver, which differs from the requested coordinates."));
        return json!({"ok": true, "perControl": {"vfCurve": Value::Object(entry)}});
    }
    json!({"ok": false, "perControl": {"vfCurve": {
        "ok": false, "errorCode": "io-failed",
        "message": "read-back VF curve did not match the requested curve",
        "readBackEqual": false, "silentNoop": true, "readBackCurve": curve_json(&after),
    }}})
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::apply_lock;
    use crate::backend::gpu_apply::{apply_scalars, ScalarUnits};
    use crate::backend::gpu_capabilities::{capabilities, current_settings, open_for_device};
    use crate::backend::gpu_units::nearly_equal;
    use crate::backend::igcl_read_only::ReadOnlyIgcl;
    use crate::backend::vf_curve::{same_vf_curve, VfCurvePoint};

    const RANGE: &str = r#"{
        "voltageMinV":0.4,"voltageMaxV":1.5,"freqMinMhz":0,"freqMaxMhz":4300,
        "voltageStepV":0.001,"frequencyStepMhz":10,"maxPoints":32
    }"#;

    fn caps() -> Value { json!({"vfCurveRange": serde_json::from_str::<Value>(RANGE).unwrap()}) }
    fn points() -> Value { json!([
        {"voltageV":0.8,"freqMhz":2000},
        {"voltageV":1.0,"freqMhz":2500},
        {"voltageV":1.2,"freqMhz":3000}
    ]) }
    fn native() -> Vec<(u32, u32)> { vec![(800, 2000), (1000, 2500), (1200, 3000)] }
    fn opts(authoritative: bool) -> VfVerifyOptions {
        VfVerifyOptions { max_attempts: 3, quorum: 2, poll_ms: 0, driver_authoritative: authoritative }
    }

    struct Mock {
        stock: Vec<(u32, u32)>,
        live: Vec<(u32, u32)>,
        after: Option<Vec<(u32, u32)>>,
        offsets: (f64, f64),
        set_result: u32,
        writes: Vec<Vec<(u32, u32)>>,
        written: bool,
    }

    impl Default for Mock {
        fn default() -> Self {
            Self { stock: native(), live: native(), after: None, offsets: (0.0, 0.0), set_result: 0, writes: Vec::new(), written: false }
        }
    }

    impl VfBackend for Mock {
        fn read_stock(&mut self) -> Result<Vec<(u32, u32)>, u32> { Ok(self.stock.clone()) }
        fn read_live(&mut self) -> Result<Vec<(u32, u32)>, u32> {
            Ok(if self.written { self.after.clone().unwrap_or_else(|| self.live.clone()) } else { self.live.clone() })
        }
        fn write_curve(&mut self, points: &[(u32, u32)]) -> u32 {
            self.written = true;
            self.writes.push(points.to_vec());
            if self.set_result == 0 && self.after.is_none() { self.after = Some(points.to_vec()); }
            self.set_result
        }
        fn read_offsets(&mut self) -> Result<(f64, f64), u32> { Ok(self.offsets) }
    }

    #[test]
    fn writes_and_verifies_an_ordered_curve() {
        let mut backend = Mock { live: vec![(750, 1900), (950, 2400), (1150, 2900)], ..Mock::default() };
        let result = apply_vf_curve(&json!({"vfCurve": points()}), &caps(), &mut backend, &opts(false));
        assert_eq!(result["ok"], true);
        assert_eq!(result["perControl"]["vfCurve"]["readBackEqual"], true);
        assert_eq!(backend.writes, vec![native()]);
    }

    #[test]
    fn already_active_curve_is_a_verified_noop() {
        let mut backend = Mock::default();
        let result = apply_vf_curve(&json!({"vfCurve": points()}), &caps(), &mut backend, &opts(false));
        assert_eq!(result["ok"], true);
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn rejects_unordered_out_of_range_and_point_count_changes_before_writes() {
        let mut backend = Mock::default();
        let unordered = json!({"vfCurve":[{"voltageV":1.0,"freqMhz":2000},{"voltageV":0.9,"freqMhz":2500}]});
        assert_eq!(apply_vf_curve(&unordered, &caps(), &mut backend, &opts(false))["perControl"]["vfCurve"]["errorCode"], "out-of-range");
        let out_of_range = json!({"vfCurve":[{"voltageV":0.8,"freqMhz":2000},{"voltageV":1.6,"freqMhz":2500}]});
        assert_eq!(apply_vf_curve(&out_of_range, &caps(), &mut backend, &opts(false))["perControl"]["vfCurve"]["errorCode"], "out-of-range");
        let mut wrong_count = Mock { stock: vec![(800, 2000), (900, 2200), (1000, 2400), (1100, 2600)], ..Mock::default() };
        assert_eq!(apply_vf_curve(&json!({"vfCurve": points()}), &caps(), &mut wrong_count, &opts(false))["perControl"]["vfCurve"]["errorCode"], "out-of-range");
        assert!(backend.writes.is_empty());
    }

    #[test]
    fn active_offsets_and_write_refusals_are_honest() {
        let mut active = Mock { offsets: (10.0, 0.0), ..Mock::default() };
        let result = apply_vf_curve(&json!({"vfCurve": points()}), &caps(), &mut active, &opts(false));
        assert_eq!(result["perControl"]["vfCurve"]["errorCode"], "dependency-failed");
        assert!(active.writes.is_empty());
        let mut refused = Mock { set_result: 0x4400_0004, live: vec![(750, 1900), (950, 2400), (1150, 2900)], ..Mock::default() };
        let result = apply_vf_curve(&json!({"vfCurve": points()}), &caps(), &mut refused, &opts(false));
        assert_eq!(result["perControl"]["vfCurve"]["errorCode"], "out-of-range");
        assert_eq!(refused.writes.len(), 1);
    }

    #[test]
    fn readback_mismatch_is_a_silent_noop() {
        let mut backend = Mock {
            live: vec![(750, 1900), (950, 2400), (1150, 2900)],
            after: Some(vec![(800, 2000), (1000, 2400), (1200, 3000)]),
            ..Mock::default()
        };
        let result = apply_vf_curve(&json!({"vfCurve": points()}), &caps(), &mut backend, &opts(false));
        assert_eq!(result["ok"], false);
        assert_eq!(result["perControl"]["vfCurve"]["silentNoop"], true);
        assert_eq!(result["perControl"]["vfCurve"]["errorCode"], "io-failed");
    }

    #[test]
    fn driver_normalized_uniform_shift_is_accepted_after_a_shape_change() {
        let mut backend = Mock {
            live: vec![(750, 1900), (950, 2400), (1150, 2900)],
            after: Some(vec![(805, 2000), (1005, 2500), (1205, 3000)]),
            ..Mock::default()
        };
        let result = apply_vf_curve(&json!({"vfCurve": points()}), &caps(), &mut backend, &opts(true));
        eprintln!("normalized result: {result}");
        assert_eq!(result["ok"], true);
        assert_eq!(result["perControl"]["vfCurve"]["ok"], true);
        assert_eq!(result["perControl"]["vfCurve"]["normalized"], true);
        assert_eq!(result["perControl"]["vfCurve"]["readBackEqual"], false);
        assert_eq!(result["perControl"]["vfCurve"]["uniformVoltageShiftMv"], 5);
    }

    #[test]
    #[ignore = "live reversible VF write; requires explicit approval"]
    fn live_reversible_vf_curve_when_approved() {
        fn parsed(value: &Value) -> Vec<VfCurvePoint> {
            value.as_array().into_iter().flatten().filter_map(|point| Some(VfCurvePoint {
                voltage_v: point.get("voltageV")?.as_f64()?,
                freq_mhz: point.get("freqMhz")?.as_f64()?,
            })).collect()
        }
        fn scalar_ok(result: &Value) -> bool {
            ["gpuFreqOffsetMhz", "gpuVoltOffsetV"].iter().all(|key| {
                result["perControl"][key]["ok"] == json!(true)
                    && result["perControl"][key]["readBackEqual"] == json!(true)
            })
        }
        fn apply_offsets(igcl: &ReadOnlyIgcl, index: usize, caps: &Value, units: &ScalarUnits, frequency: f64, voltage: f64) -> Value {
            let mut backend = igcl.scalar_backend(index).expect("scalar backend");
            apply_scalars(&json!({"gpuFreqOffsetMhz": frequency, "gpuVoltOffsetV": voltage}), caps, units, &mut backend, true)
        }
        fn apply_curve(igcl: &ReadOnlyIgcl, index: usize, caps: &Value, units: &ScalarUnits, curve: &Value, options: &VfVerifyOptions) -> Value {
            let mut backend = igcl.vf_backend(index, *units).expect("VF backend");
            apply_vf_curve(&json!({"vfCurve": curve}), caps, &mut backend, options)
        }
        fn edit_one_frequency(live: &Value, range: &Value) -> Option<Value> {
            let mut points = parsed(live);
            if points.len() < 2 { return None; }
            let min = range.get("freqMinMhz")?.as_f64()?;
            let max = range.get("freqMaxMhz")?.as_f64()?;
            // Prefer the highest non-terminal point that can rise without
            // crossing the next point; terminal plateaus are driver-owned.
            for index in (0..points.len() - 1).rev() {
                if points[index].freq_mhz + 10.0 <= points[index + 1].freq_mhz
                    && points[index].freq_mhz + 10.0 <= max {
                    points[index].freq_mhz += 10.0;
                    return Some(Value::Array(points.into_iter().map(|point| json!({"voltageV": point.voltage_v, "freqMhz": point.freq_mhz})).collect()));
                }
            }
            // Fall back to lowering a non-first point.
            for index in 1..points.len() {
                if points[index].freq_mhz - 10.0 >= points[index - 1].freq_mhz
                    && points[index].freq_mhz - 10.0 >= min {
                    points[index].freq_mhz -= 10.0;
                    return Some(Value::Array(points.into_iter().map(|point| json!({"voltageV": point.voltage_v, "freqMhz": point.freq_mhz})).collect()));
                }
            }
            None
        }

        let path = crate::backend::gpu_devices::locate_dll().expect("IGCL DLL not found");
        let waiver = std::env::var_os("APPDATA")
            .map(|root| std::path::PathBuf::from(root).join("ArcPower").join("settings.json"))
            .and_then(|file| std::fs::read_to_string(file).ok())
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .and_then(|settings| settings["waiverAccepted"].as_bool())
            .unwrap_or(false);
        assert!(waiver, "the persisted OC waiver must be accepted for a VF write");
        let caps = capabilities(&path, 0, "stock", waiver).expect("capabilities");
        assert!(caps["deviceName"].as_str().unwrap_or("").contains("B580"), "expected the B580 device");
        let state = current_settings(&path, 0).expect("state");
        let original_frequency = state["gpuFreqOffsetMhz"].as_f64().expect("current frequency offset");
        let original_voltage = state["gpuVoltOffsetV"].as_f64().expect("current voltage offset");
        let original_live = state["vfCurve"].clone();
        assert!(original_live.as_array().is_some_and(|points| points.len() >= 2), "current LIVE VF curve is unreadable");

        let _lock = apply_lock::acquire().expect("apply lock");
        let (mut igcl, index, _) = open_for_device(&path, 0).expect("IGCL session");
        let snapshot = igcl.controls_snapshot(index).expect("controls");
        let units = ScalarUnits::from_oc(&snapshot.oc);
        igcl.apply_waiver(index).expect("waiver replay");

        // VF writes require both core offsets at zero; restore them in every path.
        let zero = apply_offsets(&igcl, index, &caps, &units, 0.0, 0.0);
        let zero_ok = scalar_ok(&zero);
        let fresh = current_settings(&path, 0).expect("state after offset reset");
        let target = if zero_ok {
            edit_one_frequency(&fresh["vfCurve"], &caps["vfCurveRange"])
        } else { None };
        // Restore the LIVE table observed with offsets at zero, then restore
        // the offsets. This is reversible whether the driver folds offsets
        // into the LIVE table or keeps the table independent.
        let restore_target = fresh["vfCurve"].clone();
        let options = VfVerifyOptions { driver_authoritative: true, ..Default::default() };
        let write = target.as_ref().map(|target| apply_curve(&igcl, index, &caps, &units, target, &options));
        let restore_curve = write.as_ref().map(|_| apply_curve(&igcl, index, &caps, &units, &restore_target, &options));
        let restore_offsets = apply_offsets(&igcl, index, &caps, &units, original_frequency, original_voltage);
        let _ = igcl.close();

        let final_state = current_settings(&path, 0).expect("final state");
        let final_curve = parsed(&final_state["vfCurve"]);
        eprintln!("{}", serde_json::to_string_pretty(&json!({
            "originalOffsets": [original_frequency, original_voltage],
            "target": target, "zero": zero, "write": write, "restoreCurve": restore_curve,
            "restoreOffsets": restore_offsets, "finalOffsets": [final_state["gpuFreqOffsetMhz"], final_state["gpuVoltOffsetV"]],
        })).unwrap());

        assert!(zero_ok, "core offsets could not be verified at zero");
        let write = write.expect("no reversible VF edit was available");
        assert_eq!(write["perControl"]["vfCurve"]["ok"], json!(true), "VF edit write failed");
        assert_eq!(restore_curve.expect("VF restore was not attempted")["perControl"]["vfCurve"]["ok"], json!(true), "VF restore failed");
        assert!(scalar_ok(&restore_offsets), "core offsets could not be restored");
        assert!(nearly_equal(final_state["gpuFreqOffsetMhz"].as_f64().expect("restored frequency offset"), original_frequency, 1e-9));
        assert!(nearly_equal(final_state["gpuVoltOffsetV"].as_f64().expect("restored voltage offset"), original_voltage, 1e-9));
        assert!(same_vf_curve(Some(&parsed(&original_live)), Some(&final_curve), 0.0, 0.0), "VF curve was not restored");
    }
}

