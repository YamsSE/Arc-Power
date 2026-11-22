//! Pure VF migration core. No hardware calls or write-success claims live here.
//!
//! Coordinates retain the renderer's volts/MHz representation. IGCL request
//! evidence retains its separate `Voltage`/`Frequency` JSON representation.
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const VF_EDITOR_MAX_POINTS: usize = 10;
pub const VF_MIN_POINTS: usize = 2;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfCurvePoint {
    pub voltage_v: f64,
    pub freq_mhz: f64,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VfCurveRange {
    pub voltage_min_v: f64,
    pub voltage_max_v: f64,
    pub freq_min_mhz: f64,
    pub freq_max_mhz: f64,
    #[serde(default)]
    pub voltage_step_v: Option<f64>,
    #[serde(default)]
    pub frequency_step_mhz: Option<f64>,
    pub max_points: f64,
}

fn finite_point(point: &VfCurvePoint) -> bool {
    point.voltage_v.is_finite() && point.freq_mhz.is_finite()
}

fn ordered(previous: &VfCurvePoint, point: &VfCurvePoint) -> bool {
    point.voltage_v > previous.voltage_v && point.freq_mhz >= previous.freq_mhz
}

/// A saved reference may move only by one common voltage translation.
pub fn matches_vf_curve_reference(saved: &[VfCurvePoint], fresh: &[VfCurvePoint]) -> bool {
    if saved.len() < VF_MIN_POINTS || saved.len() != fresh.len() {
        return false;
    }
    let shift = fresh[0].voltage_v - saved[0].voltage_v;
    shift.is_finite()
        && saved.iter().zip(fresh).enumerate().all(|(index, (point, other))| {
            finite_point(point)
                && other.voltage_v.is_finite()
                && point.freq_mhz == other.freq_mhz
                && (index == 0 || ordered(&saved[index - 1], point))
                && (other.voltage_v - point.voltage_v - shift).abs() <= 1e-9
        })
}

fn is_on_grid(value: f64, origin: f64, step: f64) -> bool {
    if !value.is_finite() || !origin.is_finite() || !step.is_finite() || step <= 0.0 {
        return false;
    }
    let position = (value - origin) / step;
    (position - position.round()).abs() <= 1e-7
}

/// Reject any coordinate that needs repair; preserve point identity and plateau.
/// Like the source helper, this deliberately does not apply `maxPoints` or the
/// native frequency step. Native table validation is a separate operation.
pub fn prepare_vf_curve_for_driver(
    points: &[VfCurvePoint],
    range: &VfCurveRange,
) -> Option<Vec<VfCurvePoint>> {
    if points.len() < VF_MIN_POINTS {
        return None;
    }
    let min_frequency = range.freq_min_mhz.ceil();
    let max_frequency = range.freq_max_mhz.floor();
    if !min_frequency.is_finite()
        || !max_frequency.is_finite()
        || min_frequency > max_frequency
        || points.len() as f64 > max_frequency - min_frequency + 1.0
    {
        return None;
    }
    let voltage_step = range.voltage_step_v
        .filter(|step| step.is_finite() && *step > 0.0).unwrap_or(0.001);
    points.iter().enumerate().all(|(index, point)| {
        finite_point(point)
            && point.voltage_v >= range.voltage_min_v
            && point.voltage_v <= range.voltage_max_v
            && is_on_grid(point.voltage_v, range.voltage_min_v, voltage_step)
            && point.freq_mhz.fract() == 0.0
            && point.freq_mhz >= min_frequency
            && point.freq_mhz <= max_frequency
            && (index == 0 || ordered(&points[index - 1], point))
    }).then(|| points.to_vec())
}

/// Match Number(value.toFixed(9)), including exact binary halfway values.
/// Rust's formatter uses ties-to-even, while JS toFixed chooses the larger
/// decimal integer after taking the absolute value. Do the rounding exactly.
fn fixed_nine(value: f64) -> f64 {
    if !value.is_finite() || value.abs() >= 1e21 {
        return value;
    }
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let fraction = bits & ((1_u64 << 52) - 1);
    let significand = if exponent == 0 { fraction } else { fraction | (1_u64 << 52) };
    let power = if exponent == 0 { -1074 } else { exponent - 1075 };
    let scaled = significand as u128 * 1_000_000_000;
    let rounded = if power >= 0 {
        scaled << power as u32
    } else {
        let shift = (-power) as u32;
        if shift >= 128 { 0 } else {
            let integral = scaled >> shift;
            let remainder = scaled & ((1_u128 << shift) - 1);
            integral + u128::from(remainder >= (1_u128 << (shift - 1)))
        }
    };
    let sign = if value.is_sign_negative() { "-" } else { "" };
    format!("{sign}{}.{:09}", rounded / 1_000_000_000, rounded % 1_000_000_000)
        .parse().unwrap_or(value)
}

pub fn rebase_vf_curve_to_reference(
    requested: &[VfCurvePoint],
    saved: &[VfCurvePoint],
    fresh: &[VfCurvePoint],
    range: &VfCurveRange,
) -> Option<Vec<VfCurvePoint>> {
    if !matches_vf_curve_reference(saved, fresh) || requested.len() != saved.len() {
        return None;
    }
    let translated: Vec<_> = requested.iter().zip(saved).zip(fresh)
        .map(|((point, old), new)| VfCurvePoint {
            voltage_v: fixed_nine(new.voltage_v + point.voltage_v - old.voltage_v),
            freq_mhz: point.freq_mhz,
        }).collect();
    prepare_vf_curve_for_driver(&translated, range)
}

pub fn same_vf_curve(
    left: Option<&[VfCurvePoint]>,
    right: Option<&[VfCurvePoint]>,
    voltage_tolerance_v: f64,
    frequency_tolerance_mhz: f64,
) -> bool {
    let (Some(left), Some(right)) = (left, right) else { return false; };
    left.len() == right.len() && left.iter().zip(right).all(|(point, other)| {
        finite_point(point) && finite_point(other)
            && (point.voltage_v - other.voltage_v).abs() <= voltage_tolerance_v
            && (point.freq_mhz - other.freq_mhz).abs() <= frequency_tolerance_mhz
    })
}

pub fn should_sync_vf_curve_from_state(
    draft: Option<&[VfCurvePoint]>, applied: Option<&[VfCurvePoint]>, pending: bool,
) -> bool {
    !pending && same_vf_curve(draft, applied, 0.0, 0.0)
}

pub fn vf_curve_needs_write(requested: Option<&[VfCurvePoint]>, live: Option<&[VfCurvePoint]>) -> bool {
    !same_vf_curve(requested, live, 0.0, 0.0)
}

/// Native reads may contain fractional frequencies and off-grid voltages;
/// validating a native table must not silently turn it into a write payload.
pub fn is_valid_native_vf_curve(points: Option<&[VfCurvePoint]>, range: &VfCurveRange) -> bool {
    if !range.voltage_min_v.is_finite() || !range.voltage_max_v.is_finite()
        || !range.freq_min_mhz.is_finite() || !range.freq_max_mhz.is_finite()
        || range.voltage_min_v > range.voltage_max_v || range.freq_min_mhz > range.freq_max_mhz
    {
        return false;
    }
    let max_points = if range.max_points.is_finite() && range.max_points > 0.0 {
        range.max_points.floor()
    } else { 32.0 };
    let Some(points) = points else { return false; };
    points.len() >= VF_MIN_POINTS && points.len() as f64 <= max_points
        && points.iter().enumerate().all(|(index, point)| {
            finite_point(point)
                && point.voltage_v >= range.voltage_min_v && point.voltage_v <= range.voltage_max_v
                && point.freq_mhz >= range.freq_min_mhz && point.freq_mhz <= range.freq_max_mhz
                && (index == 0 || ordered(&points[index - 1], point))
        })
}

pub fn normalize_vf_curve_points(points: Option<&[VfCurvePoint]>, range: &VfCurveRange) -> Vec<VfCurvePoint> {
    if is_valid_native_vf_curve(points, range) { points.unwrap().to_vec() } else { vec![] }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VfCurveEditorSelection {
    pub source: String,
    pub points: Vec<VfCurvePoint>,
}

pub fn select_vf_curve_editor_curve(
    live: Option<&[VfCurvePoint]>, stock: Option<&[VfCurvePoint]>, range: &VfCurveRange,
) -> VfCurveEditorSelection {
    let (source, points) = if is_valid_native_vf_curve(live, range) {
        ("live", live.unwrap())
    } else if is_valid_native_vf_curve(stock, range) {
        ("stock-reference", stock.unwrap())
    } else { ("unavailable", &[][..]) };
    VfCurveEditorSelection { source: source.into(), points: points.to_vec() }
}

pub fn has_linked_vf_terminal_plateau(stock: Option<&[VfCurvePoint]>, range: &VfCurveRange, battlemage: bool) -> bool {
    battlemage && is_valid_native_vf_curve(stock, range) && {
        let stock = stock.unwrap();
        stock[stock.len() - 2].freq_mhz == stock[stock.len() - 1].freq_mhz
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenVfRequest {
    pub request: String,
    pub source: String,
    pub live: String,
}

fn integer(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0)
}

// JSON.stringify uses decimal notation below 1e21, scientific notation above.
// All accepted values are integral JS Numbers; overflow after subtraction is
// serialized as null, matching JSON.stringify rather than panicking.
fn js_integer_json(value: f64) -> String {
    if !value.is_finite() { return "null".into(); }
    if value == 0.0 { return "0".into(); }
    if value.abs() < 1e21 { return value.to_string(); }
    let scientific = format!("{value:e}");
    let (mantissa, exponent) = scientific.split_once('e').unwrap();
    let exponent: i32 = exponent.parse().unwrap();
    format!("{mantissa}e{exponent:+}")
}

fn evidence_key(points: &Value, origin: f64) -> Option<String> {
    let points = points.as_array()?;
    if points.len() < VF_MIN_POINTS { return None; }
    let mut key = String::from("[");
    for (index, point) in points.iter().enumerate() {
        let voltage = integer(point.get("Voltage")?)?;
        let frequency = integer(point.get("Frequency")?)?;
        if index > 0 { key.push(','); }
        key.push_str(&format!("[{},{}]", js_integer_json(voltage - origin), js_integer_json(frequency)));
    }
    key.push(']');
    Some(key)
}

/// Evidence only: callers must separately ensure device identity, freshness,
/// successful write/read-back and cache invalidation before suppressing a write.
pub fn proven_vf_request(requested: &Value, stock: &Value, effective: &Value) -> Option<ProvenVfRequest> {
    let origin = integer(stock.get(0)?.get("Voltage")?)?;
    Some(ProvenVfRequest {
        request: evidence_key(requested, origin)?,
        source: evidence_key(stock, origin)?,
        live: evidence_key(effective, origin)?,
    })
}

pub fn matches_proven_vf_request(proven: Option<&ProvenVfRequest>, requested: &Value, stock: &Value, live: &Value) -> bool {
    match (proven, proven_vf_request(requested, stock, live)) {
        (Some(previous), Some(current)) => *previous == current,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn range() -> VfCurveRange {
        VfCurveRange { voltage_min_v: 0.5, voltage_max_v: 1.3, freq_min_mhz: 100.0,
            freq_max_mhz: 3000.0, voltage_step_v: Some(0.001), frequency_step_mhz: Some(50.0), max_points: 32.0 }
    }
    fn curve() -> Vec<VfCurvePoint> {
        vec![VfCurvePoint {voltage_v: 0.7, freq_mhz: 1200.0},
            VfCurvePoint {voltage_v: 0.9, freq_mhz: 2800.0},
            VfCurvePoint {voltage_v: 1.0, freq_mhz: 2800.0}]
    }
    fn shifted(points: &[VfCurvePoint], shift: f64) -> Vec<VfCurvePoint> {
        points.iter().map(|p| VfCurvePoint {voltage_v: p.voltage_v + shift, ..*p}).collect()
    }

    #[test]
    fn prepare_preserves_plateau_and_integer_mhz_ignoring_native_frequency_step() {
        let mut points = curve(); points[0].freq_mhz = 1201.0;
        let mut range = range(); range.max_points = 2.0;
        assert_eq!(prepare_vf_curve_for_driver(&points, &range), Some(points));
    }

    #[test]
    fn prepare_rejects_repairable_coordinates_instead_of_moving_them() {
        for case in 0..7 {
            let mut points = curve();
            match case {
                0 => points[0].voltage_v = 0.7005,
                1 => points[1].voltage_v = points[0].voltage_v,
                2 => points[1].freq_mhz = 1199.0,
                3 => points[0].freq_mhz = 1200.5,
                4 => points[0].voltage_v = 0.499,
                5 => points[2].freq_mhz = 3001.0,
                _ => points[0].voltage_v = f64::NAN,
            }
            assert!(prepare_vf_curve_for_driver(&points, &range()).is_none(), "case {case}");
        }
        assert!(prepare_vf_curve_for_driver(&curve()[..1], &range()).is_none());
        let mut narrow = range(); narrow.freq_min_mhz = 2800.0; narrow.freq_max_mhz = 2801.0;
        let points: Vec<_> = curve().iter().map(|p| VfCurvePoint {freq_mhz: 2800.0, ..*p}).collect();
        assert!(prepare_vf_curve_for_driver(&points, &narrow).is_none());
    }

    #[test]
    fn voltage_grid_fallback_and_nonzero_origin_match_renderer() {
        let mut range = range(); range.voltage_min_v = 0.5003; range.voltage_step_v = Some(0.002);
        let points = shifted(&curve(), 0.0003);
        assert_eq!(prepare_vf_curve_for_driver(&points, &range), Some(points));
        range = super::tests::range(); range.voltage_step_v = Some(f64::NAN);
        assert!(prepare_vf_curve_for_driver(&curve(), &range).is_some());
    }

    #[test]
    fn native_validation_does_not_round_compact_or_apply_write_grid() {
        let mut points = curve(); points[0].freq_mhz = 1200.5; points[0].voltage_v = 0.7005;
        assert!(is_valid_native_vf_curve(Some(&points), &range()));
        assert_eq!(normalize_vf_curve_points(Some(&points), &range()), points);
        assert!(prepare_vf_curve_for_driver(&points, &range()).is_none());
        let many: Vec<_> = (0..16).map(|i| VfCurvePoint {voltage_v: 0.6 + i as f64 * 0.01, freq_mhz: 1500.0}).collect();
        assert_eq!(normalize_vf_curve_points(Some(&many), &range()).len(), 16);
        let mut limited = range(); limited.max_points = 15.9;
        assert!(!is_valid_native_vf_curve(Some(&many), &limited));
        limited.max_points = f64::NAN;
        assert!(is_valid_native_vf_curve(Some(&many), &limited));
    }

    #[test]
    fn reference_translation_and_rebase_preserve_explicit_point_edits() {
        let saved = curve(); let fresh = shifted(&saved, 0.01);
        let mut requested = shifted(&saved, -0.02); requested[1].freq_mhz = 2799.0;
        assert!(matches_vf_curve_reference(&saved, &fresh));
        assert_eq!(rebase_vf_curve_to_reference(&requested, &saved, &fresh, &range()),
            Some(vec![VfCurvePoint {voltage_v: 0.69, freq_mhz: 1200.0},
                VfCurvePoint {voltage_v: 0.89, freq_mhz: 2799.0}, VfCurvePoint {voltage_v: 0.99, freq_mhz: 2800.0}]));
        let mut changed = fresh.clone(); changed[1].voltage_v += 0.001;
        assert!(!matches_vf_curve_reference(&saved, &changed));
        changed = fresh.clone(); changed[2].freq_mhz -= 1.0;
        assert!(rebase_vf_curve_to_reference(&requested, &saved, &changed, &range()).is_none());
        assert!(rebase_vf_curve_to_reference(&requested[..2], &saved, &fresh, &range()).is_none());
        assert!(rebase_vf_curve_to_reference(&shifted(&saved, 0.4), &saved, &fresh, &range()).is_none());
    }

    #[test]
    fn exact_write_and_draft_sync_are_stricter_than_readback_tolerance() {
        let points = curve(); let live = shifted(&points, 0.0001);
        assert!(same_vf_curve(Some(&points), Some(&live), 0.0005, 1.0));
        assert!(vf_curve_needs_write(Some(&points), Some(&live)));
        assert!(!should_sync_vf_curve_from_state(Some(&points), Some(&live), false));
        assert!(should_sync_vf_curve_from_state(Some(&points), Some(&points), false));
        assert!(!should_sync_vf_curve_from_state(Some(&points), Some(&points), true));
        assert!(vf_curve_needs_write(None, None));
        assert!(same_vf_curve(Some(&[]), Some(&[]), 0.0, 0.0));
    }

    #[test]
    fn selection_prefers_verified_live_and_stock_is_only_a_reference() {
        let stock = curve(); let live = shifted(&stock, 0.01);
        assert_eq!(select_vf_curve_editor_curve(Some(&live), Some(&stock), &range()).source, "live");
        assert_eq!(select_vf_curve_editor_curve(None, Some(&stock), &range()).source, "stock-reference");
        assert_eq!(select_vf_curve_editor_curve(None, None, &range()).source, "unavailable");
        assert!(has_linked_vf_terminal_plateau(Some(&stock), &range(), true));
        assert!(!has_linked_vf_terminal_plateau(Some(&stock), &range(), false));
    }

    #[test]
    fn normalized_request_evidence_tolerates_common_origin_motion_only() {
        let stock = json!([{"Voltage":700,"Frequency":1200},{"Voltage":900,"Frequency":2800}]);
        let request = json!([{"Voltage":680,"Frequency":1201},{"Voltage":880,"Frequency":2799}]);
        let live = json!([{"Voltage":680,"Frequency":1200},{"Voltage":880,"Frequency":2800}]);
        let proof = proven_vf_request(&request, &stock, &live).unwrap();
        assert_eq!(serde_json::to_value(&proof).unwrap(), json!({
            "request":"[[-20,1201],[180,2799]]", "source":"[[0,1200],[200,2800]]", "live":"[[-20,1200],[180,2800]]"
        }));
        let translated = |value: &Value| {
            let mut value = value.clone();
            for p in value.as_array_mut().unwrap() { p["Voltage"] = json!(p["Voltage"].as_i64().unwrap() + 10); }
            value
        };
        assert!(matches_proven_vf_request(Some(&proof), &translated(&request), &translated(&stock), &translated(&live)));
        assert!(!matches_proven_vf_request(Some(&proof), &request, &stock, &request));
        assert!(!matches_proven_vf_request(None, &request, &stock, &live));
    }

    #[test]
    fn evidence_rejects_malformed_integer_inputs_without_coercing_them() {
        let stock = json!([{"Voltage":700,"Frequency":1200},{"Voltage":900,"Frequency":2800}]);
        for invalid in [Value::Null, json!([]), json!([{"Voltage":700,"Frequency":1200}]),
            json!([{"Voltage":"700","Frequency":1200},{"Voltage":900,"Frequency":2800}]),
            json!([{"Voltage":700.5,"Frequency":1200},{"Voltage":900,"Frequency":2800}]),
            json!([{"voltageV":0.7,"freqMhz":1200},{"voltageV":0.9,"freqMhz":2800}])]
        {
            assert!(proven_vf_request(&invalid, &stock, &stock).is_none());
            assert!(proven_vf_request(&stock, &invalid, &stock).is_none());
            assert!(proven_vf_request(&stock, &stock, &invalid).is_none());
        }
        // This helper is evidence equality, not geometry/point-count validation.
        let different_count = json!([{"Voltage":700,"Frequency":1200},{"Voltage":900,"Frequency":2800},{"Voltage":950,"Frequency":2800}]);
        assert!(proven_vf_request(&different_count, &stock, &stock).is_some());
    }

    #[test]
    fn public_point_json_uses_existing_renderer_names() {
        let point: VfCurvePoint = serde_json::from_value(json!({"voltageV":0.7,"freqMhz":1200})).unwrap();
        assert_eq!(point, curve()[0]);
        assert_eq!(serde_json::to_value(point).unwrap(), json!({"voltageV":0.7,"freqMhz":1200.0}));
    }

    #[test]
    fn js_decimal_rounding_and_large_integer_evidence_keep_source_spelling() {
        assert_eq!(fixed_nine(0.0009765625), 0.000976563);
        assert_eq!(fixed_nine(-0.0009765625), -0.000976563);
        assert_eq!(fixed_nine(f64::MIN_POSITIVE), 0.0);
        assert_eq!(js_integer_json(1_000_000_000_000_000_100.0), "1000000000000000100");
        assert_eq!(js_integer_json(1e21), "1e+21");
        assert_eq!(js_integer_json(-0.0), "0");
    }
}
