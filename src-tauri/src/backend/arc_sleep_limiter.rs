//! Arc Sleep frame-limit ownership and recovery journal.
//!
//! One provider owns the cap at a time: RTSS (global profile) is primary, the
//! selected adapter's IGCL 3D frame limit is the device-scoped fallback. Every
//! write is conditional on the exact state Arc Sleep last observed, is verified
//! by a fresh read, and is preceded by a durable journal so a crash, an
//! external edit or a failed restore can never silently keep or overwrite a cap
//! Arc Power did not prove it owns.
//!
//! The RTSS side reuses `rtss_profile.rs` (the single RTSS writer). The IGCL
//! side reuses the native Graphics frame-limit read/write surface in
//! `graphics.rs`. This module adds no driver or RTSS access of its own.
use serde_json::{json, Value};

pub const DEFAULT_BASE_FPS: i64 = 60;
pub const RTSS_FRAME_LIMIT_MIN: i64 = 1;
pub const RTSS_FRAME_LIMIT_MAX: i64 = 1000;
/// Provider availability refreshes are throttled exactly like the JS controller.
pub const RTSS_AVAILABILITY_REFRESH_MS: f64 = 5000.0;

/// The exact frame-limit state Arc Sleep compares and restores. `denominator`
/// is `None` when RTSS reports an unreadable value; the presentation-oriented
/// `rtss-frame-limit-get` read normalizes that to 1, which is not good enough
/// to prove ownership.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawState {
    pub limit: i64,
    pub denominator: Option<i64>,
    pub limiter_enabled: bool,
}

impl RawState {
    pub fn with_limit(self, limit: i64) -> Self { Self { limit, ..self } }
    pub fn with_denominator(self, denominator: Option<i64>) -> Self { Self { denominator, ..self } }
    pub fn with_enabled(self, limiter_enabled: bool) -> Self { Self { limiter_enabled, ..self } }
    pub fn json(self) -> Value {
        json!({
            "limit": self.limit,
            "denominator": self.denominator,
            "limiterEnabled": self.limiter_enabled,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Route {
    Rtss,
    Igcl { device_key: String },
}

impl Route {
    pub fn source(&self) -> &'static str {
        match self {
            Route::Rtss => "rtss",
            Route::Igcl { .. } => "igcl",
        }
    }

    pub fn device_key(&self) -> Option<&str> {
        match self {
            Route::Rtss => None,
            Route::Igcl { device_key } => Some(device_key),
        }
    }

    pub fn json(&self) -> Value {
        match self {
            Route::Rtss => json!({"source": "rtss"}),
            Route::Igcl { device_key } => json!({"source": "igcl", "deviceKey": device_key}),
        }
    }
}

fn integer(value: Option<&Value>) -> Option<i64> {
    let value = value?;
    let number = value.as_f64()?;
    if !number.is_finite() || number.fract() != 0.0 { return None; }
    (number >= 0.0 && number <= 9_007_199_254_740_991.0).then_some(number as i64)
}

/// `rawState()`: a readable exact state, or `None`.
pub fn parse_raw_state(value: &Value) -> Option<RawState> {
    let object = value.as_object()?;
    let limit = integer(object.get("limit"))?;
    let limiter_enabled = object.get("limiterEnabled")?.as_bool()?;
    let denominator = match object.get("denominator") {
        None | Some(Value::Null) => None,
        Some(value) => Some(integer(Some(value))?),
    };
    Some(RawState { limit, denominator, limiter_enabled })
}

/// `validRoute()`: a missing route means RTSS; an IGCL route needs a durable
/// device key.
pub fn parse_route(value: Option<&Value>) -> Option<Route> {
    match value {
        None | Some(Value::Null) => Some(Route::Rtss),
        Some(value) => match value.get("source").and_then(Value::as_str) {
            Some("rtss") => Some(Route::Rtss),
            Some("igcl") => value.get("deviceKey").and_then(Value::as_str)
                .filter(|key| !key.is_empty())
                .map(|device_key| Route::Igcl { device_key: device_key.to_owned() }),
            _ => None,
        },
    }
}

pub fn same_route(left: &Route, right: &Route) -> bool {
    left == right
}

/// The durable recovery record. `pending` brackets an in-flight transition;
/// `external_change` latches an unowned edit so automatic writes stop.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Journal {
    pub baseline: RawState,
    pub underlay: RawState,
    pub expected: RawState,
    pub route: Route,
    pub pending: Option<(RawState, RawState)>,
    pub external_change: bool,
}

impl Journal {
    pub fn json(&self) -> Value {
        let mut value = json!({
            "version": 1,
            "baseline": self.baseline.json(),
            "underlay": self.underlay.json(),
            "expected": self.expected.json(),
            "route": self.route.json(),
            "pending": self.pending.map(|(from, to)| json!({"from": from.json(), "to": to.json()})),
        });
        if self.external_change { value["externalChange"] = json!(true); }
        value
    }

    /// A pending transition journal: the write about to happen is bracketed so
    /// an interrupted run can be attributed on the next startup.
    pub fn pending(route: &Route, baseline: RawState, underlay: RawState, from: RawState, to: RawState) -> Self {
        Self { baseline, underlay, expected: from, route: route.clone(), pending: Some((from, to)), external_change: false }
    }

    /// The settled journal persisted only after a verified write.
    pub fn settled(route: &Route, baseline: RawState, underlay: RawState, expected: RawState) -> Self {
        Self { baseline, underlay, expected, route: route.clone(), pending: None, external_change: false }
    }

    /// Preserve an unowned observation and stop automatic writes.
    pub fn external(route: &Route, baseline: RawState, underlay: RawState, expected: RawState) -> Self {
        Self { baseline, underlay, expected, route: route.clone(), pending: None, external_change: true }
    }

    pub fn attributed(&self, actual: RawState) -> bool {
        if actual == self.baseline || actual == self.expected { return true; }
        self.pending.is_some_and(|(from, to)| transition_states(from, to).contains(&actual))
    }
}

/// `validJournal()`.
pub fn parse_journal(value: &Value) -> Option<Journal> {
    let object = value.as_object()?;
    if integer(object.get("version")) != Some(1) { return None; }
    let baseline = parse_raw_state(object.get("baseline")?)?;
    let underlay = object.get("underlay").and_then(|value| parse_raw_state(value)).unwrap_or(baseline);
    let expected = parse_raw_state(object.get("expected")?)?;
    let route = parse_route(object.get("route"))?;
    let pending = match object.get("pending") {
        None | Some(Value::Null) => None,
        Some(value) => {
            let from = parse_raw_state(value.get("from")?)?;
            let to = parse_raw_state(value.get("to")?)?;
            Some((from, to))
        }
    };
    Some(Journal {
        baseline,
        underlay,
        expected,
        route,
        pending,
        external_change: object.get("externalChange") == Some(&Value::Bool(true)),
    })
}

/// The intermediate states a single provider write can legitimately leave
/// behind (limit, then denominator, then the enable flag).
pub fn transition_states(from: RawState, to: RawState) -> Vec<RawState> {
    let mut states = vec![
        from,
        from.with_limit(to.limit),
        from.with_limit(to.limit).with_denominator(to.denominator),
        to,
    ];
    states.dedup();
    states
}

/// `normalizeBaseFrameLimit()`.
pub fn normalize_base_frame_limit(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let enabled = object.get("enabled")?.as_bool()?;
    let number = object.get("value").and_then(Value::as_f64);
    let value = match number {
        Some(number) if number.is_finite() => number.round().max(RTSS_FRAME_LIMIT_MIN as f64).min(RTSS_FRAME_LIMIT_MAX as f64) as i64,
        _ => DEFAULT_BASE_FPS,
    };
    Some(json!({"enabled": enabled, "value": value}))
}

pub fn base_value(base: &Value) -> Option<i64> { base.get("value").and_then(Value::as_f64).filter(|value| value.is_finite()).map(|value| value.round() as i64) }
pub fn base_enabled(base: &Value) -> bool { base.get("enabled").and_then(Value::as_bool) == Some(true) }

/// The provider seams. Production wires these to `NativeStore` RTSS methods and
/// the native Graphics frame-limit path; tests wire them to fakes.
pub trait LimiterIo {
    fn rtss_ownership(&self) -> Value;
    fn rtss_apply(&self, options: &Value) -> Value;
    fn rtss_restore_state(&self, options: &Value) -> Value;
    fn rtss_restore(&self, token: &Value) -> Value;
    /// Exact selected-adapter frame-limit read (device-scoped, gate-free).
    fn igcl_read(&self, device_key: Option<&str>) -> Value;
    /// Verified selected-adapter frame-limit write (device-scoped, gate-free).
    fn igcl_apply(&self, request: &Value) -> Value;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Range { pub min: i64, pub max: i64, pub step: i64 }

impl Range {
    pub fn rtss() -> Self { Self { min: RTSS_FRAME_LIMIT_MIN, max: RTSS_FRAME_LIMIT_MAX, step: 1 } }

    pub fn from_json(value: &Value) -> Option<Self> {
        let min = value.get("min").and_then(Value::as_f64)?;
        let max = value.get("max").and_then(Value::as_f64)?;
        let step = value.get("step").and_then(Value::as_f64).unwrap_or(1.0);
        if !(min.is_finite() && max.is_finite() && step.is_finite()) || max <= min { return None; }
        Some(Self { min: min as i64, max: max as i64, step: if step > 0.0 { step as i64 } else { 1 } })
    }

    /// Arc Sleep's grid-anchored clamp (`clampTargetToRange`).
    pub fn clamp_target(self, value: f64) -> Option<i64> {
        if !value.is_finite() { return None; }
        let step = self.step.max(1);
        let clamped = value.round().max(self.min as f64).min(self.max as f64);
        let snapped = self.min as f64 + ((clamped - self.min as f64) / step as f64).round() * step as f64;
        Some((snapped.round() as i64).clamp(self.min, self.max))
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WriteOutcome {
    Ok { observed: RawState },
    Conflict { observed: Option<RawState> },
    Failed { unavailable: bool, elevation_required: bool, error: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RestoreOutcome {
    Ok { observed: RawState, flag_restoration_deferred: bool },
    Conflict { observed: Option<RawState>, error: String },
    Failed { unavailable: bool, error: String },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReadFailure {
    Unavailable,
}

/// The selected limiter provider plus the last verified raw state.
#[derive(Default)]
pub struct Limiter {
    route: Option<Route>,
    device_name: Option<String>,
    range: Option<Range>,
    live_change: bool,
    last_raw: Option<RawState>,
    last_known_raw: Option<RawState>,
    rtss_available: bool,
    rtss_checked_at_ms: Option<f64>,
    igcl_read_error: Option<String>,
    route_rewrite: Option<Route>,
    /// The controller's clock for the availability-refresh throttle.
    now_ms: f64,
}

impl Limiter {
    pub fn new() -> Self { Self::default() }

    /// Set the clock used by the provider-availability throttle.
    pub fn set_now(&mut self, now_ms: f64) { self.now_ms = now_ms; }

    pub fn route(&self) -> Option<&Route> { self.route.as_ref() }
    pub fn device_name(&self) -> Option<&str> { self.device_name.as_deref() }
    pub fn range(&self) -> Option<Range> { self.range }
    pub fn live_change(&self) -> bool { self.live_change }
    pub fn last_raw(&self) -> Option<RawState> { self.last_raw }
    /// The selected GPU driver answered an IGCL frame-limit read at least once
    /// this session, even if the current snapshot has no usable cap value.
    pub fn igcl_detected(&self) -> bool {
        self.igcl_read_error.is_none()
            && (self.device_name.is_some() || self.range.is_some() || self.last_known_raw.is_some())
    }
    pub fn last_known_raw(&self) -> Option<RawState> { self.last_known_raw }
    pub fn rtss_available(&self) -> bool { self.rtss_available }
    pub fn igcl_read_error(&self) -> Option<&str> { self.igcl_read_error.as_deref() }

    pub fn unavailable_message(&self) -> String {
        match self.igcl_read_error.as_deref() {
            Some(error) => format!("RTSS and the selected GPU driver FPS limiter are unavailable. IGCL read failed: {error}"),
            None => "RTSS and the selected GPU driver FPS limiter are unavailable.".to_owned(),
        }
    }

    /// Consume a route canonicalization produced by the adapter (an IGCL alias
    /// resolved to the physical device key).
    pub fn take_route_rewrite(&mut self) -> Option<Route> { self.route_rewrite.take() }

    /// Read-only RTSS presence probe, throttled like the JS controller.
    pub fn refresh_rtss_availability(&mut self, io: &dyn LimiterIo, now_ms: f64, force: bool) -> bool {
        if !force && self.rtss_checked_at_ms.is_some_and(|at| now_ms - at < RTSS_AVAILABILITY_REFRESH_MS) {
            return self.rtss_available;
        }
        self.rtss_checked_at_ms = Some(now_ms);
        let result = io.rtss_ownership();
        self.rtss_available = result.get("ok") == Some(&Value::Bool(true))
            && parse_raw_state(result.get("state").unwrap_or(&Value::Null)).is_some();
        self.rtss_available
    }

    /// `readFromRoute()`.
    pub fn read_from(&mut self, io: &dyn LimiterIo, route: &Route) -> Option<RawState> {
        let requested = route;
        let result = match route {
            Route::Rtss => io.rtss_ownership(),
            Route::Igcl { device_key } => io.igcl_read(Some(device_key)),
        };
        let exact = match route {
            Route::Rtss => result.get("state").filter(|value| value.is_object()).unwrap_or(&result),
            Route::Igcl { .. } => &result,
        };
        let state = if result.get("ok") == Some(&Value::Bool(true)) { parse_raw_state(exact) } else { None };
        let Some(state) = state else {
            match route {
                Route::Rtss => {
                    self.rtss_available = false;
                    self.rtss_checked_at_ms = Some(self.now_ms);
                }
                Route::Igcl { .. } => {
                    self.igcl_read_error = Some(result.get("error").and_then(Value::as_str)
                        .unwrap_or("The selected GPU driver did not return a readable frame limit.").to_owned());
                }
            }
            return None;
        };
        let mut verified = route.clone();
        if let Route::Igcl { device_key } = requested {
            let Some(canonical) = result.get("deviceKey").and_then(Value::as_str).filter(|key| !key.is_empty()) else {
                self.igcl_read_error = Some("The selected GPU driver did not return a canonical device identity.".to_owned());
                return None;
            };
            verified = Route::Igcl { device_key: canonical.to_owned() };
            if canonical != device_key {
                self.route_rewrite = Some(verified.clone());
            }
        }
        self.igcl_read_error = None;
        self.route = Some(verified.clone());
        self.device_name = result.get("deviceName").and_then(Value::as_str).map(str::to_owned);
        self.range = match &verified {
            Route::Rtss => Some(Range::rtss()),
            Route::Igcl { .. } => result.get("frameLimitRange").and_then(Range::from_json),
        };
        self.live_change = matches!(verified, Route::Rtss) || result.get("liveChange") == Some(&Value::Bool(true));
        self.last_raw = Some(state);
        self.last_known_raw = Some(state);
        if matches!(verified, Route::Rtss) {
            self.rtss_available = true;
            self.rtss_checked_at_ms = Some(self.now_ms);
        }
        Some(state)
    }

    /// `readRawState()`: prefer an explicit route, then the journal's, then
    /// RTSS with the device-scoped IGCL fallback.
    pub fn read_raw(&mut self, io: &dyn LimiterIo, requested: Option<&Route>, prefer_current: bool, device_key: Option<&str>) -> Option<RawState> {
        if let Some(route) = requested {
            let state = self.read_from(io, route);
            if state.is_none() { self.last_raw = None; }
            return state;
        }
        if self.route.is_some() && prefer_current {
            if let Some(route) = self.route.clone() {
                let state = self.read_from(io, &route);
                if state.is_some() { return state; }
            }
        }
        if let Some(state) = self.read_from(io, &Route::Rtss) { return Some(state); }
        let result = io.igcl_read(device_key);
        if result.get("ok") == Some(&Value::Bool(true)) {
            let Some(key) = result.get("deviceKey").and_then(Value::as_str).filter(|key| !key.is_empty()).map(str::to_owned) else { return None; };
            let Some(state) = parse_raw_state(&json!({
                "limit": result.get("limit").cloned().unwrap_or(Value::Null),
                "denominator": result.get("denominator").cloned().unwrap_or(json!(1)),
                "limiterEnabled": result.get("limiterEnabled").cloned().unwrap_or(Value::Null),
            })) else { return None; };
            self.igcl_read_error = None;
            self.route = Some(Route::Igcl { device_key: key });
            self.device_name = result.get("deviceName").and_then(Value::as_str).map(str::to_owned);
            self.range = result.get("frameLimitRange").and_then(Range::from_json);
            self.live_change = result.get("liveChange") == Some(&Value::Bool(true));
            self.last_raw = Some(state);
            self.last_known_raw = Some(state);
            return Some(state);
        }
        if result.get("ok") != Some(&Value::Bool(true)) {
            self.igcl_read_error = Some(result.get("error").and_then(Value::as_str)
                .unwrap_or("The selected GPU driver did not return a readable frame limit.").to_owned());
        }
        self.last_raw = None;
        self.range = None;
        self.live_change = false;
        self.device_name = None;
        self.route = None;
        None
    }

    pub fn underlay_state(&mut self, io: &dyn LimiterIo, fallback: RawState) -> RawState {
        if matches!(self.route, Some(Route::Igcl { .. })) { return fallback; }
        let result = io.rtss_ownership();
        if result.get("ok") == Some(&Value::Bool(true)) {
            return parse_raw_state(result.get("underlay").unwrap_or(&Value::Null)).unwrap_or(fallback);
        }
        fallback
    }

    pub fn disable_target_state(&mut self, io: &dyn LimiterIo, fallback: RawState) -> RawState {
        if matches!(self.route, Some(Route::Igcl { .. })) { return fallback; }
        let result = io.rtss_ownership();
        if result.get("ok") == Some(&Value::Bool(true)) {
            return parse_raw_state(result.get("disableState").unwrap_or(&Value::Null)).unwrap_or(fallback);
        }
        fallback
    }

    fn apply_on_route(io: &dyn LimiterIo, route: &Route, request: &Value) -> Value {
        match route {
            Route::Rtss => io.rtss_apply(request),
            Route::Igcl { device_key } => {
                let mut request = request.clone();
                request["deviceKey"] = json!(device_key);
                io.igcl_apply(&request)
            }
        }
    }

    /// `writeCap()`: conditional write + verified read-back.
    pub fn write_cap(&mut self, io: &dyn LimiterIo, expected: Option<RawState>, target_fps: i64, automatic: bool) -> WriteOutcome {
        let Some(route) = self.route.clone().or_else(|| Some(Route::Rtss)) else {
            return WriteOutcome::Failed { unavailable: true, elevation_required: false, error: "RTSS frame limiter is unavailable".into() };
        };
        let request = json!({
            "enabled": true,
            "value": target_fps,
            "expectedState": expected.map(RawState::json),
            "automatic": automatic,
        });
        let result = Self::apply_on_route(io, &route, &request);
        if result.get("conflict") == Some(&Value::Bool(true)) || result.get("errorCode").and_then(Value::as_str) == Some("external-change") {
            let observed = self.read_raw(io, Some(&route), false, None);
            return WriteOutcome::Conflict { observed };
        }
        if result.get("ok") != Some(&Value::Bool(true)) || result.get("used") != Some(&Value::Bool(true)) {
            return WriteOutcome::Failed {
                unavailable: result.get("available") == Some(&Value::Bool(false))
                    || result.get("errorCode").and_then(Value::as_str) == Some("unavailable"),
                elevation_required: result.get("errorCode").and_then(Value::as_str) == Some("elevation-required"),
                error: result.get("error").and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{} did not apply the Arc Sleep cap", route.source().to_uppercase())),
            };
        }
        let observed = self.read_from(io, &route);
        let requested = parse_raw_state(result.get("observedState").unwrap_or(&Value::Null)).unwrap_or(RawState {
            limit: target_fps,
            denominator: if matches!(route, Route::Rtss) && expected.and_then(|state| state.denominator).is_none() { None } else { Some(1) },
            limiter_enabled: true,
        });
        let Some(observed) = observed.filter(|observed| *observed == requested && observed.limiter_enabled) else {
            return WriteOutcome::Failed {
                unavailable: false,
                elevation_required: false,
                error: format!("{} cap read-back did not match Arc Sleep target", route.source().to_uppercase()),
            };
        };
        WriteOutcome::Ok { observed }
    }

    /// `restoreState()`: conditional restore + verified read-back.
    pub fn restore(&mut self, io: &dyn LimiterIo, route: &Route, expected: RawState, target: RawState, retain_ownership: bool, automatic: bool) -> RestoreOutcome {
        let request = match route {
            Route::Rtss => json!({
                "expectedState": expected.json(),
                "state": target.json(),
                "retainOwnership": retain_ownership,
            }),
            Route::Igcl { device_key } => json!({
                "expectedState": expected.json(),
                "state": target.json(),
                "deviceKey": device_key,
                "automatic": automatic,
            }),
        };
        let result = match route {
            Route::Rtss => io.rtss_restore_state(&request),
            Route::Igcl { .. } => io.igcl_apply(&json!({
                "op": "restore",
                "expectedState": expected.json(),
                "state": target.json(),
                "deviceKey": route.device_key(),
                "automatic": automatic,
                "retainOwnership": retain_ownership,
            })),
        };
        if result.get("conflict") == Some(&Value::Bool(true)) || result.get("errorCode").and_then(Value::as_str) == Some("external-change") {
            return RestoreOutcome::Conflict {
                observed: parse_raw_state(result.get("observedState").unwrap_or(&Value::Null)),
                error: result.get("error").and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{} frame-limit state changed outside Arc Power", route.source().to_uppercase())),
            };
        }
        if result.get("ok") != Some(&Value::Bool(true)) {
            return RestoreOutcome::Failed {
                unavailable: matches!(result.get("errorCode").and_then(Value::as_str), Some("unavailable" | "elevation-required")),
                error: result.get("error").and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| format!("{} state restoration failed", route.source().to_uppercase())),
            };
        }
        let observed = parse_raw_state(result.get("observedState").unwrap_or(&Value::Null))
            .or_else(|| self.read_raw(io, Some(route), false, None));
        let flag_deferred = result.get("flagRestorationDeferred") == Some(&Value::Bool(true));
        let Some(observed) = observed else {
            return RestoreOutcome::Failed { unavailable: true, error: format!("{} recovery read-back is unavailable", route.source().to_uppercase()) };
        };
        let fields_match = observed.limit == target.limit && observed.denominator == target.denominator;
        let flag_matches = observed.limiter_enabled == target.limiter_enabled
            || (flag_deferred && observed.limiter_enabled);
        if !fields_match || !flag_matches {
            return RestoreOutcome::Failed {
                unavailable: false,
                error: format!("{} recovery read-back did not match the saved baseline", route.source().to_uppercase()),
            };
        }
        self.route = Some(route.clone());
        if matches!(route, Route::Rtss) { self.rtss_available = true; }
        self.last_raw = Some(observed);
        self.last_known_raw = Some(observed);
        RestoreOutcome::Ok { observed, flag_restoration_deferred: flag_deferred }
    }

    /// The state a `cleanup-pending` write must restore to, and the state a
    /// base disable targets, for the current provider.
    pub fn disable_target(&mut self, io: &dyn LimiterIo, current: RawState, base_fps: i64) -> (RawState, RawState, Value) {
        let route = self.route.clone().unwrap_or(Route::Rtss);
        let underlay = self.underlay_state(io, current);
        let disable = match route {
            Route::Rtss => self.disable_target_state(io, underlay),
            Route::Igcl { .. } => RawState { limiter_enabled: false, ..current },
        };
        let value = match route {
            Route::Rtss => base_fps,
            Route::Igcl { .. } => disable.limit,
        };
        (underlay, disable, json!({"enabled": false, "value": value, "expectedState": current.json()}))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    const RTSS: RawState = RawState { limit: 120, denominator: Some(1), limiter_enabled: true };
    const BASE: RawState = RawState { limit: 60, denominator: Some(1), limiter_enabled: true };

    struct FakeIo {
        state: RefCell<RawState>,
        ownership_ok: bool,
        applies: RefCell<Vec<Value>>,
        restores: RefCell<Vec<Value>>,
        conflict: Option<String>,
    }

    impl Default for FakeIo {
        fn default() -> Self {
            Self {
                state: RefCell::new(BASE),
                ownership_ok: true,
                applies: RefCell::new(Vec::new()),
                restores: RefCell::new(Vec::new()),
                conflict: None,
            }
        }
    }

    impl FakeIo {
        fn new(state: RawState) -> Self { Self { state: RefCell::new(state), ownership_ok: true, ..Self::default() } }
    }

    impl LimiterIo for FakeIo {
        fn rtss_ownership(&self) -> Value {
            if !self.ownership_ok { return json!({"ok": false, "errorCode": "unavailable"}); }
            json!({"ok": true, "state": self.state.borrow().json(), "underlay": BASE.json(), "disableState": self.state.borrow().with_enabled(false).json()})
        }
        fn rtss_apply(&self, options: &Value) -> Value {
            self.applies.borrow_mut().push(options.clone());
            if !self.ownership_ok { return json!({"ok": false, "used": false, "errorCode": "unavailable"}); }
            let expected = options.get("expectedState").filter(|value| !value.is_null()).and_then(parse_raw_state);
            if expected.is_some_and(|expected| expected != *self.state.borrow()) {
                return json!({"ok": false, "used": false, "conflict": true, "errorCode": "external-change"});
            }
            let enabled = options.get("enabled") == Some(&Value::Bool(true));
            let value = options.get("value").and_then(Value::as_f64).unwrap_or(0.0).round() as i64;
            *self.state.borrow_mut() = RawState { limit: value, denominator: Some(1), limiter_enabled: enabled };
            if let Some(error) = &self.conflict { return json!({"ok": false, "used": false, "error": error}); }
            json!({"ok": true, "used": true, "source": "rtss", "observedState": self.state.borrow().json()})
        }
        fn rtss_restore_state(&self, options: &Value) -> Value {
            self.restores.borrow_mut().push(options.clone());
            if !self.ownership_ok { return json!({"ok": false, "errorCode": "unavailable"}); }
            let expected = options.get("expectedState").and_then(parse_raw_state);
            if expected.is_some_and(|expected| expected != *self.state.borrow()) {
                return json!({"ok": false, "conflict": true, "errorCode": "external-change"});
            }
            let target = options.get("state").and_then(parse_raw_state).unwrap();
            *self.state.borrow_mut() = target;
            json!({"ok": true, "observedState": target.json()})
        }
        fn rtss_restore(&self, _token: &Value) -> Value { json!({"ok": true}) }
        fn igcl_read(&self, _device_key: Option<&str>) -> Value {
            json!({"ok": true, "deviceKey": "gpu-a", "deviceName": "Arc B580", "limit": 100, "denominator": 1, "limiterEnabled": true, "frameLimitRange": {"min": 30, "max": 300, "step": 1}, "liveChange": true})
        }
        fn igcl_apply(&self, request: &Value) -> Value { json!({"ok": true, "used": true, "observedState": request.get("state").cloned().unwrap_or(Value::Null)}) }
    }

    fn journal_with_pending() -> Journal {
        Journal::pending(&Route::Rtss, BASE, BASE, RTSS, RTSS.with_limit(90))
    }

    #[test]
    fn journal_round_trips_and_rejects_unreadable_records() {
        let journal = Journal::external(&Route::Igcl { device_key: "gpu-a".into() }, BASE, BASE, RTSS);
        assert_eq!(parse_journal(&journal.json()), Some(journal.clone()));
        assert!(parse_journal(&json!({"version": 2})).is_none());
        assert!(parse_journal(&json!({"version": 1, "route": {"source": "igcl"}})).is_none());
        assert!(parse_journal(&json!({"version": 1, "baseline": {"limit":1,"denominator":null,"limiterEnabled":true}, "expected": {"limit":1,"denominator":null,"limiterEnabled":true}, "pending": null})).is_some());
    }

    #[test]
    fn pending_transition_attributes_intermediate_provider_states_only() {
        let journal = journal_with_pending();
        assert!(journal.attributed(RTSS));
        assert!(journal.attributed(RTSS.with_limit(90)));
        assert!(journal.attributed(BASE));
        assert!(!journal.attributed(BASE.with_limit(75)));
        let unsettled = Journal { pending: None, ..journal.clone() };
        assert!(!unsettled.attributed(RTSS.with_limit(90)));
    }

    #[test]
    fn provider_switch_reads_resolve_and_canonicalize_the_device_key() {
        let io = FakeIo::new(RTSS);
        let mut limiter = Limiter::new();
        let state = limiter.read_from(&io, &Route::Igcl { device_key: "alias".into() }).unwrap();
        assert_eq!(state.limit, 100);
        assert_eq!(limiter.route(), Some(&Route::Igcl { device_key: "gpu-a".into() }));
        assert_eq!(limiter.take_route_rewrite(), Some(Route::Igcl { device_key: "gpu-a".into() }));
        assert_eq!(limiter.take_route_rewrite(), None, "the rewrite is consumed once");
        assert_eq!(limiter.range(), Some(Range { min: 30, max: 300, step: 1 }));
        assert!(limiter.live_change());
    }

    #[test]
    fn write_cap_verifies_read_back_and_fails_closed_on_external_change() {
        let io = FakeIo::new(RTSS);
        let mut limiter = Limiter::new();
        limiter.read_from(&io, &Route::Rtss).unwrap();
        assert_eq!(limiter.write_cap(&io, Some(RTSS), 90, true), WriteOutcome::Ok { observed: RTSS.with_limit(90) });
        // The provider changed between read and write: the conditional apply
        // refuses, and the limiter re-reads the unowned state.
        *io.state.borrow_mut() = RTSS.with_limit(144);
        assert_eq!(limiter.write_cap(&io, Some(RTSS.with_limit(90)), 60, true), WriteOutcome::Conflict { observed: Some(RTSS.with_limit(144)) });
    }

    #[test]
    fn restore_reports_cleanup_pending_when_the_provider_cannot_be_read() {
        let mut io = FakeIo::new(RTSS);
        io.ownership_ok = false;
        let mut limiter = Limiter::new();
        let outcome = limiter.restore(&io, &Route::Rtss, RTSS, BASE, true, true);
        assert!(matches!(outcome, RestoreOutcome::Failed { unavailable: true, .. }));
        // A readable provider whose live state moved still reports the conflict
        // rather than a blanket unavailability.
        io.ownership_ok = true;
        let failed = limiter.restore(&io, &Route::Rtss, BASE.with_limit(75), BASE, true, true);
        assert!(matches!(failed, RestoreOutcome::Conflict { .. }));
    }

    #[test]
    fn base_disable_switches_the_target_with_the_provider() {
        let io = FakeIo::new(RTSS);
        let mut limiter = Limiter::new();
        limiter.read_from(&io, &Route::Rtss).unwrap();
        let (_, disable, request) = limiter.disable_target(&io, RTSS, 60);
        assert!(!disable.limiter_enabled);
        assert_eq!(request["value"], json!(60));
        limiter.read_from(&io, &Route::Igcl { device_key: "gpu-a".into() }).unwrap();
        let (_, disable, request) = limiter.disable_target(&io, RawState { limit: 100, denominator: Some(1), limiter_enabled: true }, 60);
        assert_eq!(disable.limit, 100);
        assert_eq!(request["value"], json!(100));
    }

    #[test]
    fn range_clamps_on_the_provider_grid() {
        assert_eq!(Range::rtss().clamp_target(0.4), Some(1));
        assert_eq!(Range::rtss().clamp_target(1000.6), Some(1000));
        assert_eq!(Range { min: 30, max: 300, step: 5 }.clamp_target(62.0), Some(60));
    }
}
