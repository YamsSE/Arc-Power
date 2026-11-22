//! Sysman power-pair policy (sustained + burst), independent of the loader.
//! The real Level Zero adapter supplies `SysmanPower`; this core owns clamps,
//! interval preservation, and read-back verification.
use serde_json::{json, Value};

pub const SYSMAN_PL_MAX_W: f64 = 4095.0;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PowerLimits {
    pub sustained_enabled: u8,
    pub sustained_w: f64,
    pub burst_enabled: u8,
    pub burst_w: f64,
    pub peak_w: f64,
    pub interval_ms: i32,
}

pub trait SysmanPower {
    fn read_limits(&mut self) -> Result<PowerLimits, u32>;
    fn set_limits(&mut self, sustained_w: f64, burst_w: f64, interval_ms: i32) -> u32;
}

fn fail(code: &str, message: impl Into<String>) -> Value {
    json!({"ok": false, "errorCode": code, "message": message.into()})
}

/// The native setter serializes power in integer milliwatts. Reject a
/// before-image outside the supported setter range or off that grid so a
/// later compensation can restore the exact writable pair and interval.
fn restorable_milliwatts(watts: f64) -> Option<i64> {
    if !watts.is_finite() || !(1.0..=SYSMAN_PL_MAX_W).contains(&watts) { return None; }
    let milliwatts = watts * 1000.0;
    if !milliwatts.is_finite() { return None; }
    let rounded = milliwatts.round();
    if (milliwatts - rounded).abs() > 1e-6 { return None; }
    Some(rounded as i64)
}

fn same_power_value(left: f64, right: f64) -> bool {
    match (restorable_milliwatts(left), restorable_milliwatts(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn quantize_target(watts: f64) -> f64 {
    (watts * 1000.0).round() / 1000.0
}

fn same_pair(left: &PowerLimits, right: &PowerLimits) -> bool {
    left.sustained_enabled == right.sustained_enabled
        && left.burst_enabled == right.burst_enabled
        && same_power_value(left.sustained_w, right.sustained_w)
        && same_power_value(left.burst_w, right.burst_w)
        && left.interval_ms == right.interval_ms
}

fn restorable_before_image(limits: &PowerLimits) -> bool {
    restorable_milliwatts(limits.sustained_w).is_some()
        && restorable_milliwatts(limits.burst_w).is_some()
        && limits.interval_ms > 0
}

fn limits_json(limits: &PowerLimits) -> Value {
    json!({
        "sustainedEnabled": limits.sustained_enabled,
        "sustainedW": limits.sustained_w,
        "burstEnabled": limits.burst_enabled,
        "burstW": limits.burst_w,
        "intervalMs": limits.interval_ms,
    })
}

/// Retry a failed GET once. A write is never sent from an unknown state.
fn read_after_write(backend: &mut dyn SysmanPower) -> Result<PowerLimits, u32> {
    let mut last_error = 0;
    for _ in 0..2 {
        match backend.read_limits() {
            Ok(limits) => return Ok(limits),
            Err(error) => last_error = error,
        }
    }
    Err(last_error)
}

fn failure_with_rollback(
    code: &str,
    cause: impl Into<String>,
    attempted: bool,
    restored: bool,
    detail: impl Into<String>,
    set_result: Option<u32>,
    read_back: Option<&PowerLimits>,
) -> Value {
    let mut result = fail(code, cause);
    result["rollback"] = json!({
        "attempted": attempted,
        "ok": restored,
        "message": detail.into(),
        "setResult": set_result,
        "readBack": read_back.map(limits_json).unwrap_or(Value::Null),
    });
    result
}

/// Compensation is safe only while the latest read-back is exactly the pair
/// this call requested. The API has no compare-and-set operation, so a third
/// state may belong to another writer and must not be overwritten.
/// This check is best-effort: another process can still write between this
/// confirming GET and the compensating SET, and Sysman exposes no atomic guard.
fn restore_before_image(
    backend: &mut dyn SysmanPower,
    before: &PowerLimits,
    cause: String,
) -> Value {
    let set_result = backend.set_limits(before.sustained_w, before.burst_w, before.interval_ms);
    match read_after_write(backend) {
        Ok(read_back) if same_pair(&read_back, before) => {
            let detail = if set_result == 0 {
                "original sustained, burst, and interval values were restored and verified"
            } else {
                "read-back matches the original values despite a setter error"
            };
            failure_with_rollback(
                "io-failed",
                format!("{cause}; the original power pair was restored and verified"),
                true,
                true,
                detail,
                Some(set_result),
                Some(&read_back),
            )
        }
        Ok(read_back) => failure_with_rollback(
            "cleanup-pending",
            format!(
                "{cause}; compensation read-back {}/{} W at {} ms does not match the original {}/{} W at {} ms",
                read_back.sustained_w, read_back.burst_w, read_back.interval_ms,
                before.sustained_w, before.burst_w, before.interval_ms,
            ),
            true,
            false,
            "the restoration could not be verified; no further write was sent",
            Some(set_result),
            Some(&read_back),
        ),
        Err(error) => failure_with_rollback(
            "cleanup-pending",
            format!("{cause}; compensation read-back failed (0x{error:08x})"),
            true,
            false,
            "the restoration could not be verified; no further write was sent",
            Some(set_result),
            None,
        ),
    }
}

fn fail_after_write(
    backend: &mut dyn SysmanPower,
    before: &PowerLimits,
    target: &PowerLimits,
    cause: String,
) -> Value {
    let observed = match read_after_write(backend) {
        Ok(observed) => observed,
        Err(error) => return failure_with_rollback(
            "cleanup-pending",
            format!("{cause}; post-write read-back failed twice (last result 0x{error:08x})"),
            false,
            false,
            "current power limits are unknown, so no compensation write was sent",
            None,
            None,
        ),
    };

    if same_pair(&observed, before) {
        return failure_with_rollback(
            "io-failed",
            format!("{cause}; read-back confirms the original power pair is unchanged"),
            false,
            true,
            "no compensation was needed; the original values and interval remain in effect",
            None,
            Some(&observed),
        );
    }
    if same_pair(&observed, target) {
        return restore_before_image(backend, before, cause);
    }

    failure_with_rollback(
        "cleanup-pending",
        format!(
            "{cause}; current read-back {}/{} W at {} ms is neither the original pair nor the requested pair",
            observed.sustained_w, observed.burst_w, observed.interval_ms,
        ),
        false,
        false,
        "current state may belong to another writer; no compensation write was sent",
        None,
        Some(&observed),
    )
}

pub fn apply_power_pair(backend: &mut dyn SysmanPower, watts: f64) -> Value {
    if !watts.is_finite() { return fail("invalid-argument", "power limit must be finite"); }
    let target = quantize_target(watts.clamp(1.0, SYSMAN_PL_MAX_W));
    let before = match backend.read_limits() {
        Ok(limits) if limits.sustained_enabled != 1 || limits.burst_enabled != 1 => {
            return fail("unavailable", "both current Sysman power limits must be enabled for a restorable apply; no write was sent");
        }
        Ok(limits) if restorable_before_image(&limits) => limits,
        Ok(_) => return fail("unavailable", "current Sysman power limits cannot be restored exactly; no write was sent"),
        Err(error) => return fail("io-failed", format!("current Sysman power limits could not be read (0x{error:08x}); no write was sent")),
    };
    // Reduce the window in which another writer can change the baseline.
    // Sysman has no compare-and-set, so external writers can still race SET.
    match backend.read_limits() {
        Ok(current) if same_pair(&current, &before) => {}
        Ok(_) => return fail("stale-state", "Sysman power limits changed before apply; no write was sent"),
        Err(error) => return fail("io-failed", format!("Sysman power limits could not be rechecked (0x{error:08x}); no write was sent")),
    }
    let target_w = target;
    let target = PowerLimits { sustained_w: target_w, burst_w: target_w, ..before };
    let set = backend.set_limits(target.sustained_w, target.burst_w, target.interval_ms);
    if set != 0 {
        return fail_after_write(
            backend,
            &before,
            &target,
            format!("Sysman zesPowerSetLimits failed (0x{set:08x})"),
        );
    }
    match read_after_write(backend) {
        Ok(limits) if same_pair(&limits, &target) => json!({
            "ok": true,
            "sustainedW": limits.sustained_w,
            "burstW": limits.burst_w,
            "intervalMs": limits.interval_ms,
        }),
        Ok(limits) if same_pair(&limits, &before) => failure_with_rollback(
            "io-failed",
            format!(
                "Sysman read-back confirms the original {}/{} W at {} ms remains unchanged instead of requested {target_w} W",
                before.sustained_w, before.burst_w, before.interval_ms,
            ),
            false,
            true,
            "no compensation was needed; the original values and interval remain in effect",
            None,
            Some(&limits),
        ),
        Ok(limits) => failure_with_rollback(
            "cleanup-pending",
            format!(
                "Sysman read-back {}/{} W at {} ms is neither the original pair nor requested {target_w} W at {} ms",
                limits.sustained_w, limits.burst_w, limits.interval_ms, target.interval_ms,
            ),
            false,
            false,
            "current state may belong to another writer; no compensation write was sent",
            None,
            Some(&limits),
        ),
        Err(error) => failure_with_rollback(
            "cleanup-pending",
            format!("Sysman read-back failed twice (last result 0x{error:08x}); current limits are unknown"),
            false,
            false,
            "no compensation write was sent because the current pair could not be read",
            None,
            None,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn before_image() -> PowerLimits {
        PowerLimits { sustained_enabled: 1, sustained_w: 190.0, burst_enabled: 1,
            burst_w: 205.0, peak_w: 300.0, interval_ms: 2500 }
    }

    fn target_image() -> PowerLimits {
        PowerLimits { sustained_enabled: 1, sustained_w: 315.0, burst_enabled: 1,
            burst_w: 315.0, peak_w: 300.0, interval_ms: 2500 }
    }

    struct Mock {
        limits: PowerLimits,
        reads: VecDeque<Result<PowerLimits, u32>>,
        set_results: VecDeque<u32>,
        set_states: VecDeque<Option<PowerLimits>>,
        sets: Vec<(f64, f64, i32)>,
    }
    impl Default for Mock { fn default() -> Self { Self {
        limits: before_image(),
        reads: VecDeque::new(),
        set_results: VecDeque::new(),
        set_states: VecDeque::new(),
        sets: Vec::new(),
    } } }
    impl SysmanPower for Mock {
        fn read_limits(&mut self) -> Result<PowerLimits, u32> {
            self.reads.pop_front().unwrap_or(Ok(self.limits))
        }
        fn set_limits(&mut self, sustained_w: f64, burst_w: f64, interval_ms: i32) -> u32 {
            self.sets.push((sustained_w, burst_w, interval_ms));
            let result = self.set_results.pop_front().unwrap_or(0);
            match self.set_states.pop_front().flatten() {
                Some(state) => self.limits = state,
                None if result == 0 => self.limits = PowerLimits {
                    sustained_w, burst_w, interval_ms, ..self.limits
                },
                None => {}
            }
            result
        }
    }

    #[test]
    fn writes_the_pair_and_preserves_the_interval() {
        let mut backend = Mock::default();
        let result = apply_power_pair(&mut backend, 315.0);
        assert_eq!(result["ok"], true);
        assert_eq!(backend.sets, vec![(315.0, 315.0, before_image().interval_ms)]);
        assert_eq!(result["sustainedW"], 315.0);
        assert_eq!(result["burstW"], 315.0);
        assert_eq!(result["intervalMs"], before_image().interval_ms);
    }

    #[test]
    fn clamps_requested_target_to_sysman_limit() {
        let mut backend = Mock::default();
        let result = apply_power_pair(&mut backend, 5000.0);
        assert_eq!(result["ok"], true);
        assert_eq!(result["sustainedW"], SYSMAN_PL_MAX_W);
        assert_eq!(backend.sets[0].0, SYSMAN_PL_MAX_W);

        let mut quantized = Mock::default();
        let result = apply_power_pair(&mut quantized, 315.0005);
        assert_eq!(result["ok"], true);
        assert_eq!(result["sustainedW"], 315.001);
        assert_eq!(quantized.sets[0].0, 315.001);
    }

    #[test]
    fn refuses_before_write_when_before_image_cannot_be_read_or_restored() {
        let mut unreadable = Mock::default();
        unreadable.reads.push_back(Err(0x7800_0009));
        let result = apply_power_pair(&mut unreadable, 315.0);
        assert_eq!(result["ok"], false);
        assert!(unreadable.sets.is_empty());

        let mut invalid_interval = Mock::default();
        invalid_interval.limits.interval_ms = 0;
        let result = apply_power_pair(&mut invalid_interval, 315.0);
        assert_eq!(result["ok"], false);
        assert!(invalid_interval.sets.is_empty());

        let mut sustained_disabled = Mock::default();
        sustained_disabled.limits.sustained_enabled = 0;
        let result = apply_power_pair(&mut sustained_disabled, 315.0);
        assert_eq!(result["ok"], false);
        assert!(sustained_disabled.sets.is_empty());

        let mut burst_disabled = Mock::default();
        burst_disabled.limits.burst_enabled = 0;
        let result = apply_power_pair(&mut burst_disabled, 315.0);
        assert_eq!(result["ok"], false);
        assert!(burst_disabled.sets.is_empty());

        let mut off_grid = Mock::default();
        off_grid.limits.burst_w = 205.0005;
        let result = apply_power_pair(&mut off_grid, 315.0);
        assert_eq!(result["ok"], false);
        assert!(off_grid.sets.is_empty());
    }

    #[test]
    fn setter_failure_restores_only_after_readback_proves_our_target() {
        let mut backend = Mock::default();
        backend.set_results.push_back(0x7800_0009);
        // A failed setter may still have changed the pair before returning.
        backend.set_states.push_back(Some(target_image()));

        let result = apply_power_pair(&mut backend, 315.0);

        assert_eq!(result["ok"], false);
        assert_eq!(result["rollback"]["attempted"], true);
        assert_eq!(result["rollback"]["ok"], true);
        assert_eq!(backend.sets, vec![
            (315.0, 315.0, before_image().interval_ms),
            (before_image().sustained_w, before_image().burst_w, before_image().interval_ms),
        ]);
        assert_eq!(backend.limits.sustained_w, before_image().sustained_w);
        assert_eq!(backend.limits.burst_w, before_image().burst_w);
        assert_eq!(backend.limits.interval_ms, before_image().interval_ms);
    }

    #[test]
    fn does_not_write_after_readback_stays_unavailable() {
        let mut backend = Mock::default();
        backend.reads.extend([
            Ok(before_image()),
            Ok(before_image()),
            Err(0x7800_0009),
            Err(0x7800_000a),
        ]);

        let result = apply_power_pair(&mut backend, 315.0);

        assert_eq!(result["ok"], false);
        assert_eq!(result["errorCode"], "cleanup-pending");
        assert_eq!(result["rollback"]["attempted"], false);
        assert_eq!(backend.sets.len(), 1);
    }

    #[test]
    fn does_not_overwrite_a_third_state_seen_after_apply() {
        let mut backend = Mock::default();
        let external = PowerLimits { sustained_w: 222.0, burst_w: 230.0, ..before_image() };
        backend.reads.extend([Ok(before_image()), Ok(before_image()), Ok(external)]);

        let result = apply_power_pair(&mut backend, 315.0);

        assert_eq!(result["ok"], false);
        assert_eq!(result["errorCode"], "cleanup-pending");
        assert_eq!(result["rollback"]["attempted"], false);
        assert_eq!(backend.sets.len(), 1);
    }

    #[test]
    fn readback_verification_includes_enabled_flags() {
        let mut backend = Mock::default();
        backend.set_states.push_back(Some(PowerLimits {
            sustained_enabled: 0,
            ..target_image()
        }));

        let result = apply_power_pair(&mut backend, 315.0);

        assert_eq!(result["ok"], false);
        assert_eq!(result["errorCode"], "cleanup-pending");
        assert_eq!(result["rollback"]["attempted"], false);
        assert_eq!(backend.sets.len(), 1);
    }

    #[test]
    fn failed_setter_with_unchanged_readback_does_not_send_a_restore_write() {
        let mut backend = Mock::default();
        backend.set_results.push_back(0x7800_0009);

        let result = apply_power_pair(&mut backend, 315.0);

        assert_eq!(result["ok"], false);
        assert_eq!(result["rollback"]["attempted"], false);
        assert_eq!(result["rollback"]["ok"], true);
        assert_eq!(backend.sets.len(), 1);
    }

    #[test]
    fn reports_cleanup_pending_when_compensation_cannot_be_verified() {
        let mut backend = Mock::default();
        backend.set_states.push_back(Some(target_image()));
        backend.set_results.extend([0x7800_0009, 0x7800_0009]);
        backend.set_states.push_back(None);
        // The initial setter fails after reaching the requested pair. The
        // restoration setter also fails, and read-back still sees that pair.
        backend.reads.extend([Ok(before_image()), Ok(before_image()), Ok(target_image()), Ok(target_image())]);

        let result = apply_power_pair(&mut backend, 315.0);

        assert_eq!(result["ok"], false);
        assert_eq!(result["errorCode"], "cleanup-pending");
        assert_eq!(result["rollback"]["attempted"], true);
        assert_eq!(result["rollback"]["ok"], false);
        assert_eq!(backend.sets.len(), 2);
    }

    #[test]
    fn refuses_when_another_writer_changes_the_baseline_before_set() {
        let mut backend = Mock::default();
        let changed = PowerLimits { sustained_enabled: 0, ..before_image() };
        backend.reads.extend([Ok(before_image()), Ok(changed)]);
        let result = apply_power_pair(&mut backend, 315.0);
        assert_eq!(result["errorCode"], "stale-state");
        assert!(backend.sets.is_empty());
    }

    #[test]
    fn failed_restore_readback_does_not_report_an_old_observation_as_current() {
        let mut backend = Mock::default();
        backend.set_states.push_back(Some(target_image()));
        backend.set_results.push_back(0x7800_0009);
        backend.reads.extend([Ok(before_image()), Ok(before_image()), Ok(target_image()),
            Err(0x7800_0009), Err(0x7800_0009)]);
        let result = apply_power_pair(&mut backend, 315.0);
        assert_eq!(result["errorCode"], "cleanup-pending");
        assert_eq!(result["rollback"]["readBack"], Value::Null);
    }
}
