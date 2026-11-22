//! Arc Sleep controller: the single owner of the transient FPS cap.
//!
//! The controller is the only writer of `arcSleepFrameLimitBase`,
//! `arcSleepJournal`, `arcSleepPendingBaseDisable` and its expected state, and
//! every automatic change is bracketed by the recovery journal in
//! [`super::arc_sleep_limiter`]. Ticks, base-cap changes and shutdown share one
//! state lock, so a Graphics read/apply wrapped in
//! [`ArcSleepController::with_transaction`] can never interleave with a limiter
//! write; `tick` never waits, it reports [`TickOutcome::Busy`] instead.
//!
//! Time and telemetry are injected ([`Clock`], [`PolicySampler`]) and every
//! provider access goes through [`LimiterIo`]; nothing here touches RTSS, IGCL,
//! the GPU or `%APPDATA%` directly.
use super::arc_sleep_limiter::{
    base_enabled, base_value, normalize_base_frame_limit, parse_journal, parse_raw_state, Journal, Limiter, LimiterIo, Range,
    RawState, RestoreOutcome, Route, WriteOutcome, DEFAULT_BASE_FPS, RTSS_FRAME_LIMIT_MAX, RTSS_FRAME_LIMIT_MIN,
};
use super::arc_sleep_policy::{
    create_arc_sleep_policy_state, normalize_arc_sleep_settings, step_arc_sleep_policy, ArcSleepSettings, ARC_SLEEP_DEFAULTS,
};
use super::settings_store::SettingsStore;
use serde_json::{json, Value};
use std::sync::{Mutex, MutexGuard, TryLockError};

/// The JS controller's `intervalMs`.
pub const TICK_INTERVAL_MS: f64 = 1000.0;
/// `fastAdjustmentApplied` stays true for this window after a fast adjustment.
pub const FAST_ADJUSTMENT_WINDOW_MS: f64 = 5000.0;
/// `arc-sleep-state-get` fallback message when no controller exists.
pub const LIMITER_UNAVAILABLE: &str = "Arc Sleep is unavailable in this runtime.";
const INVALID_JOURNAL: &str = "The saved FPS limiter recovery record is invalid; Arc Sleep paused to avoid changing an unverified cap.";
const DIFFERENT_PROVIDER: &str = "The active FPS limiter recovery record belongs to a different provider.";
const UNOWNED_SWITCH: &str = "frame limit changed outside Arc Power; change the Graphics FPS Limit to re-enable Arc Sleep control.";

fn value<T: serde::Serialize>(input: &T) -> Value { serde_json::to_value(input).unwrap_or(Value::Null) }
fn route_name(route: &Route) -> String { route.source().to_uppercase() }
fn journal_name(s: &State) -> String {
    s.journal.as_ref().map(|journal| route_name(&journal.route))
        .or_else(|| s.limiter.route().map(route_name))
        .unwrap_or_else(|| "RTSS".into())
}

/// The persisted-settings seam. Production is [`SettingsStore`], whose
/// `save_arc_sleep_state` merges the patch so a stale snapshot cannot erase a
/// journal written by a concurrent update.
pub trait ArcSleepStore: Send + Sync {
    fn load(&self) -> Result<Value, String>;
    /// The store's already-loaded snapshot, when it keeps one. The cadence uses
    /// this so adopting a policy change does not re-read the settings file while
    /// the state lock is held; every write through the store refreshes it.
    fn load_cached(&self) -> Option<Value> { None }
    fn save(&self, patch: &Value) -> Result<(), String>;
}

impl ArcSleepStore for SettingsStore {
    fn load(&self) -> Result<Value, String> { self.load_settings() }
    fn load_cached(&self) -> Option<Value> { self.load_settings_sync().ok().flatten() }
    fn save(&self, patch: &Value) -> Result<(), String> { self.save_arc_sleep_state(patch) }
}

/// One policy input sample. `nowMs` is appended by the controller from its
/// [`Clock`]; the fps fields are only populated for an eligible foreground
/// observation, which is the filter the JS controller applies before the policy.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    pub idle_ms: Option<f64>,
    pub load_percent: Option<f64>,
    pub observed_fps: Option<f64>,
    pub observed_process_id: Option<u64>,
}

/// `LimiterIo` plus the thread safety a managed host needs; the limiter takes
/// `&dyn LimiterIo`, which this upcasts to.
pub trait LimiterSeam: LimiterIo + Send + Sync {}
impl<T: LimiterIo + Send + Sync + ?Sized> LimiterSeam for T {}

pub trait PolicySampler: Send + Sync {
    fn sample(&self) -> Sample;
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> f64;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TickOutcome {
    /// A sample was taken and the resulting target applied.
    Applied,
    /// The JS cadence has not elapsed yet.
    NotDue,
    /// A transaction owns the controller; the tick wrote nothing.
    Busy,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StopOutcome {
    /// Nothing was owned, or the pre-run limiter state was restored and the
    /// journal cleared.
    Clean,
    /// The provider state moved outside Arc Power; the journal is kept and the
    /// current state preserved.
    ExternalChange,
    /// The cap is still ours: the journal is kept so the next start (or an
    /// explicit retry) can finish the restore.
    CleanupPending { status: &'static str, message: String },
}

#[derive(Clone, Copy, Debug)]
struct Diagnostics {
    gpu_util_pct: Option<f64>,
    reported_fps: Option<f64>,
    fps_status: &'static str,
    last_fast_adjustment_at_ms: Option<f64>,
}

impl Diagnostics {
    fn idle(adaptive: bool) -> Self {
        Self { gpu_util_pct: None, reported_fps: None, fps_status: if adaptive { "gpu-unavailable" } else { "disabled" }, last_fast_adjustment_at_ms: None }
    }
}

struct State {
    settings: ArcSleepSettings,
    base_frame_limit: Option<Value>,
    journal: Option<Journal>,
    invalid_journal: bool,
    pending_base_disable: bool,
    pending_base_disable_expected: Option<RawState>,
    /// The policy state as JSON because the policy module round-trips `Value`;
    /// `idleActive` rides along exactly as the JS controller stashes it.
    policy_state: Value,
    policy_source: Option<String>,
    status: &'static str,
    message: Option<String>,
    diagnostics: Diagnostics,
    limiter: Limiter,
    initialized: bool,
    stopping: bool,
    next_tick_at_ms: Option<f64>,
}

impl State {
    fn new() -> Self {
        let settings = ARC_SLEEP_DEFAULTS;
        let policy_state = value(&create_arc_sleep_policy_state(&value(&settings)));
        Self {
            settings, base_frame_limit: None, journal: None, invalid_journal: false, pending_base_disable: false,
            pending_base_disable_expected: None, policy_state, policy_source: None, status: "ready", message: None,
            diagnostics: Diagnostics::idle(false), limiter: Limiter::new(), initialized: false, stopping: false, next_tick_at_ms: None,
        }
    }

    fn has_policy(&self) -> bool { self.settings.idle_enabled || self.settings.adaptive_enabled }
    fn ready_status(&self) -> &'static str { if self.has_policy() { "ready" } else { "disabled" } }
    fn base_value(&self) -> Option<i64> { self.base_frame_limit.as_ref().filter(|base| base_enabled(base)).and_then(base_value) }
    fn reset_policy(&mut self) { self.policy_state = value(&create_arc_sleep_policy_state(&value(&self.settings))); }
}

fn status_for(source: Option<&str>, s: &State) -> &'static str {
    match source { Some("idle") => "idle", Some("adaptive") => "adaptive", _ => s.ready_status() }
}

/// `effectiveTarget`: the base cap is a ceiling for a live policy target.
fn effective_target(base: Option<&Value>, policy_target: Option<u32>) -> Option<i64> {
    let base = base.filter(|base| base_enabled(base)).and_then(base_value);
    match (base, policy_target) {
        (Some(base), Some(target)) => Some(base.min(target as i64)),
        (Some(base), None) => Some(base),
        (None, target) => target.map(i64::from),
    }
}

fn base_target(base: &Value) -> RawState {
    RawState { limit: base_value(base).unwrap_or(DEFAULT_BASE_FPS), denominator: Some(1), limiter_enabled: true }
}

/// The documented `arc-sleep-state-get` fallback for hosts with no controller.
pub fn unavailable_snapshot() -> Value {
    json!({
        "rtssAvailable": false, "activeLimiter": null, "limiterDeviceName": null, "limiterDeviceKey": null,
        "liveAdjustmentSupported": false, "frameLimitEffectiveNow": false, "baseCapFps": null, "baseFrameLimit": null,
        "effectiveCapFps": null, "policy": null, "status": "limiter-unavailable", "message": LIMITER_UNAVAILABLE,
        "diagnostics": {"gpuUtilPct": null, "reportedFps": null, "fpsStatus": "gpu-unavailable", "fastAdjustmentApplied": false},
    })
}

pub struct ArcSleepController {
    io: Box<dyn LimiterSeam>,
    sampler: Box<dyn PolicySampler>,
    clock: Box<dyn Clock>,
    store: Box<dyn ArcSleepStore>,
    state: Mutex<State>,
}

/// The pre-transaction ownership record a Graphics apply needs when it fails
/// after [`Transaction::set_base_frame_limit`] already moved the cap.
struct Snapshot {
    base: Option<Value>,
    journal: Option<Journal>,
    pending: bool,
    expected: Option<RawState>,
    status: &'static str,
    message: Option<String>,
    policy_source: Option<String>,
    raw: Option<RawState>,
}

pub struct Transaction<'a> {
    controller: &'a ArcSleepController,
    state: &'a mut State,
    required_source: Option<&'static str>,
    snapshot: Option<Snapshot>,
}

impl ArcSleepController {
    pub fn new(
        io: Box<dyn LimiterSeam>,
        sampler: Box<dyn PolicySampler>,
        clock: Box<dyn Clock>,
        store: Box<dyn ArcSleepStore>,
    ) -> Self {
        Self { io, sampler, clock, store, state: Mutex::new(State::new()) }
    }

    fn lock(&self) -> MutexGuard<'_, State> { self.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) }

    /// Initialize, then take the first sample immediately (the JS `start`).
    pub fn start(&self) -> TickOutcome {
        let mut s = self.lock();
        let now = self.clock.now_ms();
        s.stopping = false;
        self.initialize(&mut s, None);
        self.sample_and_apply(&mut s);
        s.next_tick_at_ms = Some(now + TICK_INTERVAL_MS);
        TickOutcome::Applied
    }

    /// One cadence slot. Never queues behind a transaction.
    pub fn tick(&self) -> TickOutcome {
        let mut s = match self.state.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::WouldBlock) => return TickOutcome::Busy,
            Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        };
        // The host event loop keeps offering cadence slots after a suspend or
        // shutdown; a stopped controller must never re-acquire the limiter.
        if s.stopping { return TickOutcome::NotDue; }
        let now = self.clock.now_ms();
        if !s.initialized {
            // `tick` before `start` still initializes and samples immediately,
            // exactly like the JS `sampleAndApply`.
            self.initialize(&mut s, None);
            s.next_tick_at_ms = Some(now + TICK_INTERVAL_MS);
            self.sample_and_apply(&mut s);
            return TickOutcome::Applied;
        }
        if s.next_tick_at_ms.is_some_and(|due| now < due) { return TickOutcome::NotDue; }
        s.next_tick_at_ms = Some(now + TICK_INTERVAL_MS);
        // `arcSleep` is persisted by the settings-save path in Electron, so a
        // policy edit must be adopted here: the JS controller receives it through
        // `updateSettings`, and this host has no other production caller. Without
        // this the panel's toggle would have no effect until a restart.
        if let Some(next) = self.updated_policy(&s) {
            self.set_settings(&mut s, &next);
            return TickOutcome::Applied;
        }
        self.sample_and_apply(&mut s);
        TickOutcome::Applied
    }

    /// The persisted `arcSleep` policy, when it differs from the applied one.
    fn updated_policy(&self, s: &State) -> Option<Value> {
        // The cached snapshot keeps this off the file system: the settings store
        // is refreshed by every write in this process, which is the only writer
        // that can change `arcSleep`.
        let settings = match self.store.load_cached() {
            Some(settings) => settings,
            None => self.store.load().ok()?,
        };
        let next = settings.get("arcSleep")?.clone();
        (normalize_arc_sleep_settings(&next) != s.settings).then_some(next)
    }

    /// Restore the pre-run state and clear the journal. Ownership is never
    /// dropped silently: a failed restore keeps the journal and reports it.
    pub fn stop(&self) -> StopOutcome {
        let mut s = self.lock();
        s.stopping = true;
        s.next_tick_at_ms = None;
        let Some(journal) = s.journal.clone().filter(|_| s.initialized) else { return StopOutcome::Clean };
        let name = route_name(&journal.route);
        if journal.external_change {
            s.status = "external-change";
            s.message = Some(format!("The {name} frame limit changed outside Arc Power; the current state was preserved during shutdown."));
            return StopOutcome::ExternalChange;
        }
        let Some(current) = self.read_raw(&mut s, None, false, None) else {
            let message = format!("{name} is unavailable; recovery remains pending.");
            s.status = "recovery-pending";
            s.message = Some(message.clone());
            return StopOutcome::CleanupPending { status: "recovery-pending", message };
        };
        if current != journal.expected {
            s.status = "external-change";
            s.message = Some(format!("The {name} cap changed outside Arc Power; the current state was preserved during shutdown."));
            return StopOutcome::ExternalChange;
        }
        let pending = Journal::pending(&journal.route, journal.baseline, journal.underlay, current, journal.baseline);
        if !self.save_journal(&mut s, pending) {
            return StopOutcome::CleanupPending { status: "error", message: s.message.clone().unwrap_or_default() };
        }
        let retain = s.base_frame_limit.as_ref().is_some_and(base_enabled);
        match s.limiter.restore(&*self.io, &journal.route, current, journal.baseline, retain, true) {
            RestoreOutcome::Ok { .. } => {
                self.clear_journal(&mut s);
                let status = s.ready_status();
                s.status = status;
                s.message = None;
                StopOutcome::Clean
            }
            RestoreOutcome::Conflict { error, .. } => {
                s.status = "external-change";
                s.message = Some(error);
                StopOutcome::ExternalChange
            }
            RestoreOutcome::Failed { unavailable, error } => {
                let status = if unavailable { "recovery-pending" } else { "error" };
                s.status = status;
                s.message = Some(error.clone());
                StopOutcome::CleanupPending { status, message: error }
            }
        }
    }

    /// Serialize a full Graphics transaction (read, apply and rollback) against
    /// policy ticks and shutdown.
    pub fn with_transaction<R>(&self, required_source: Option<&'static str>, work: impl FnOnce(&mut Transaction<'_>) -> R) -> R {
        let mut state = self.lock();
        self.initialize(&mut state, required_source);
        work(&mut Transaction { controller: self, state: &mut state, required_source, snapshot: None })
    }

    /// The in-memory controller state.
    pub fn get_snapshot(&self) -> Value { self.snapshot(&self.lock()) }
    pub fn is_running(&self) -> bool { self.lock().next_tick_at_ms.is_some() }

    fn snapshot(&self, s: &State) -> Value {
        let detected_igcl = (!s.limiter.rtss_available() && s.limiter.igcl_detected()).then_some("igcl");
        let route = s.limiter.route();
        let active_limiter = route.map(Route::source).or(detected_igcl);
        let live = match route { Some(Route::Rtss) => true, Some(Route::Igcl { .. }) => s.limiter.live_change(), None => false };
        let raw = s.limiter.last_raw().filter(|raw| raw.limiter_enabled && raw.limit > 0).map(|raw| raw.limit);
        json!({
            "rtssAvailable": s.limiter.rtss_available(),
            "activeLimiter": active_limiter,
            "limiterDeviceName": s.limiter.device_name(),
            "limiterDeviceKey": route.and_then(Route::device_key),
            "liveAdjustmentSupported": live,
            "frameLimitEffectiveNow": live,
            "baseCapFps": s.base_value(),
            "baseFrameLimit": s.base_frame_limit,
            "currentFrameLimitFps": raw,
            "effectiveCapFps": if matches!(route, Some(Route::Igcl { .. })) && !s.limiter.live_change() { None } else { raw },
            "policy": s.policy_source,
            "status": s.status,
            "message": s.message,
            "diagnostics": {
                "gpuUtilPct": s.diagnostics.gpu_util_pct,
                "reportedFps": s.diagnostics.reported_fps,
                "fpsStatus": s.diagnostics.fps_status,
                "fastAdjustmentApplied": s.diagnostics.last_fast_adjustment_at_ms
                    .is_some_and(|at| self.clock.now_ms() - at <= FAST_ADJUSTMENT_WINDOW_MS),
            },
        })
    }
    // ---------------------------------------------------------------------
    // Persisted state
    // ---------------------------------------------------------------------

    /// Load persisted state, reconcile any journal and materialize the base cap.
    fn initialize(&self, s: &mut State, required_source: Option<&str>) {
        if s.initialized { return; }
        let saved = match self.store.load() {
            Ok(saved) => saved,
            // Fail closed: without its saved journal Arc Sleep cannot prove what
            // it owns, so it must never write an automatic cap.
            Err(error) => { s.invalid_journal = true; s.status = "recovery-pending"; s.message = Some(error); s.initialized = true; return; }
        };
        s.settings = normalize_arc_sleep_settings(saved.get("arcSleep").unwrap_or(&Value::Null));
        s.base_frame_limit = saved.get("arcSleepFrameLimitBase").and_then(normalize_base_frame_limit);
        let stored = saved.get("arcSleepJournal").filter(|journal| !journal.is_null());
        s.journal = stored.and_then(parse_journal);
        s.invalid_journal = stored.is_some() && s.journal.is_none();
        s.pending_base_disable = saved.get("arcSleepPendingBaseDisable") == Some(&Value::Bool(true));
        s.pending_base_disable_expected = if s.pending_base_disable { saved.get("arcSleepPendingBaseDisableExpected").and_then(parse_raw_state) } else { None };
        s.reset_policy();
        if required_source == Some("rtss") && s.journal.as_ref().is_some_and(|journal| !matches!(journal.route, Route::Rtss)) {
            // Never read or reconcile the other provider for a global RTSS-only
            // request; the transaction fails closed below.
            s.initialized = true;
            s.status = "recovery-pending";
            s.message = Some(DIFFERENT_PROVIDER.into());
            return;
        }
        if s.journal.is_some() { self.recover_journal(s); }
        if s.base_frame_limit.is_none() {
            let fallback = if required_source == Some("rtss") { self.read_from(s, &Route::Rtss) } else { self.read_raw(s, None, false, None) };
            self.ensure_base_frame_limit(s, fallback);
        }
        s.initialized = true;
        if s.invalid_journal { s.status = "recovery-pending"; s.message = Some(INVALID_JOURNAL.into()); }
        else if s.status == "ready" { s.status = s.ready_status(); }
    }

    fn persist(&self, s: &mut State, patch: Value) -> bool {
        match self.store.save(&patch) {
            Ok(()) => true,
            Err(error) => { s.status = "error"; s.message = Some(error); false }
        }
    }

    fn save_journal(&self, s: &mut State, next: Journal) -> bool {
        if !self.persist(s, json!({"arcSleepJournal": next.json()})) { return false; }
        s.journal = Some(next);
        true
    }

    fn clear_journal(&self, s: &mut State) {
        if s.journal.is_none() { return; }
        if self.persist(s, json!({"arcSleepJournal": Value::Null})) { s.journal = None; }
    }

    /// The one write that moves base cap, journal and pending-disable together,
    /// so a crash can never see a half-updated ownership record.
    fn save_base_and_journal(&self, s: &mut State, base: Option<&Value>, journal: Option<&Journal>, pending: bool, expected: Option<RawState>) -> bool {
        let base = base.and_then(|base| normalize_base_frame_limit(base));
        let patch = json!({
            "arcSleepFrameLimitBase": base.clone(),
            "arcSleepJournal": journal.map(Journal::json),
            "arcSleepPendingBaseDisable": pending,
            "arcSleepPendingBaseDisableExpected": if pending { expected.map(RawState::json) } else { None },
        });
        if !self.persist(s, patch) { return false; }
        s.base_frame_limit = base;
        s.journal = journal.cloned();
        s.pending_base_disable = pending;
        s.pending_base_disable_expected = if pending { expected } else { None };
        true
    }

    fn ensure_base_frame_limit(&self, s: &mut State, fallback: Option<RawState>) {
        if s.base_frame_limit.is_some() { return; }
        let Some(source) = s.journal.as_ref().map(|journal| journal.baseline).or(fallback) else { return };
        let base = json!({
            "enabled": source.limiter_enabled && source.limit > 0,
            "value": if source.limit > 0 { source.limit.clamp(RTSS_FRAME_LIMIT_MIN, RTSS_FRAME_LIMIT_MAX) } else { DEFAULT_BASE_FPS },
        });
        if self.persist(s, json!({"arcSleepFrameLimitBase": base.clone()})) { s.base_frame_limit = Some(base); }
    }

    // ---------------------------------------------------------------------
    // Limiter reads
    // ---------------------------------------------------------------------

    fn read_from(&self, s: &mut State, route: &Route) -> Option<RawState> {
        s.limiter.set_now(self.clock.now_ms());
        let state = s.limiter.read_from(&*self.io, route);
        self.sync_journal_route(s);
        state
    }

    fn read_raw(&self, s: &mut State, requested: Option<&Route>, prefer_current: bool, device_key: Option<&str>) -> Option<RawState> {
        s.limiter.set_now(self.clock.now_ms());
        let journal_route = if prefer_current { None } else { s.journal.as_ref().map(|journal| journal.route.clone()) };
        let state = s.limiter.read_raw(&*self.io, requested.cloned().or(journal_route).as_ref(), prefer_current, device_key);
        self.sync_journal_route(s);
        state
    }

    /// Move the journal onto the canonical device key an IGCL read resolved.
    fn sync_journal_route(&self, s: &mut State) {
        let Some(rewrite) = s.limiter.take_route_rewrite() else { return; };
        let Some(journal) = s.journal.clone() else { return; };
        if !matches!(journal.route, Route::Igcl { .. }) || journal.route == rewrite { return; }
        self.save_journal(s, Journal { route: rewrite, ..journal });
    }

    /// `applyDesiredTarget`'s first read, including the RTSS-only guard.
    fn read_current(&self, s: &mut State, required: Option<&str>) -> Option<RawState> {
        if required != Some("rtss") { return self.read_raw(s, None, false, None); }
        let state = self.read_from(s, &Route::Rtss);
        if matches!(s.limiter.route(), Some(Route::Rtss)) { state } else { None }
    }

    fn ensure_current_route(&self, s: &mut State, device_key: Option<&str>) -> Option<RawState> {
        let mut current = self.read_raw(s, None, true, device_key);
        if let (Some(journal_route), Some(route)) = (s.journal.as_ref().map(|journal| journal.route.clone()), s.limiter.route().cloned()) {
            if journal_route != route {
                if !self.recover_journal(s) { return None; }
                current = self.read_raw(s, None, true, device_key);
            }
        }
        self.normalize_base_to_range(s);
        current
    }

    fn baseline(&self, s: &State, underlay: RawState) -> RawState {
        if let Some(journal) = &s.journal { return journal.baseline; }
        match s.base_value() {
            Some(limit) => RawState { limit, denominator: Some(1), limiter_enabled: true },
            None => underlay,
        }
    }

    fn refresh_rtss(&self, s: &mut State, force: bool) {
        let now = self.clock.now_ms();
        s.limiter.set_now(now);
        s.limiter.refresh_rtss_availability(&*self.io, now, force);
    }

    fn clamp(&self, s: &State, value: f64) -> Option<i64> { s.limiter.range().unwrap_or_else(Range::rtss).clamp_target(value) }

    fn normalize_state(&self, s: &State, state: RawState) -> RawState {
        if !matches!(s.limiter.route(), Some(Route::Igcl { .. })) { return state; }
        match self.clamp(s, state.limit as f64) { Some(limit) if limit != state.limit => state.with_limit(limit), _ => state }
    }

    fn normalize_base_to_range(&self, s: &mut State) {
        if !matches!(s.limiter.route(), Some(Route::Igcl { .. })) { return; }
        let Some(base) = s.base_frame_limit.clone() else { return; };
        let Some(current) = base.get("value").and_then(Value::as_f64) else { return; };
        let Some(limit) = self.clamp(s, current) else { return; };
        if Some(limit) == base_value(&base) { return; }
        let mut next = base;
        next["value"] = json!(limit);
        if self.persist(s, json!({"arcSleepFrameLimitBase": next.clone()})) { s.base_frame_limit = Some(next); }
    }

    fn restore_outcome(&self, s: &mut State, outcome: RestoreOutcome) -> bool {
        match outcome {
            RestoreOutcome::Ok { .. } => true,
            RestoreOutcome::Conflict { error, .. } => { s.status = "external-change"; s.message = Some(error); false }
            RestoreOutcome::Failed { unavailable, error } => {
                s.status = if unavailable { "recovery-pending" } else { "error" };
                s.message = Some(error);
                false
            }
        }
    }

    /// Reconcile the durable journal against the live cap before any new write.
    fn recover_journal(&self, s: &mut State) -> bool {
        let Some(journal) = s.journal.clone() else { return true; };
        let name = route_name(&journal.route);
        if journal.external_change {
            s.status = "external-change";
            s.message = Some(format!("The {name} {UNOWNED_SWITCH}"));
            return false;
        }
        let Some(actual) = self.read_raw(s, None, false, None) else {
            s.status = "recovery-pending";
            s.message = Some(format!("{name} is unavailable; Arc Sleep will retry recovery."));
            return false;
        };
        let journal = if matches!(journal.route, Route::Igcl { .. }) {
            // Only saved restoration targets are range-normalized: `expected`
            // and `pending.from` are observed states used to attribute
            // ownership, so normalization must never mask an external writer.
            let normalized = Journal {
                baseline: self.normalize_state(s, journal.baseline),
                underlay: self.normalize_state(s, journal.underlay),
                pending: journal.pending.map(|(from, to)| (from, self.normalize_state(s, to))),
                ..journal.clone()
            };
            if normalized != journal && !self.save_journal(s, normalized.clone()) { return false; }
            self.normalize_base_to_range(s);
            normalized
        } else { journal };
        if actual == journal.baseline {
            self.clear_journal(s);
            s.status = "ready";
            s.message = None;
            return true;
        }
        if !journal.attributed(actual) {
            s.status = "external-change";
            s.message = Some(format!("The {name} frame limit no longer matches Arc Sleep's saved transition; the current state was preserved."));
            return false;
        }
        let recovery = Journal::pending(&journal.route, journal.baseline, journal.underlay, actual, journal.baseline);
        if !self.save_journal(s, recovery) { return false; }
        let retain = s.base_frame_limit.as_ref().is_some_and(base_enabled);
        let outcome = s.limiter.restore(&*self.io, &journal.route, actual, journal.baseline, retain, true);
        if !self.restore_outcome(s, outcome) { return false; }
        self.clear_journal(s);
        s.status = "ready";
        s.message = None;
        true
    }

    // ---------------------------------------------------------------------
    // Policy
    // ---------------------------------------------------------------------

    /// `readPolicySample`: build the policy input, publish diagnostics, and
    /// return the policy's target and source.
    fn read_policy_sample(&self, s: &mut State) -> (Option<u32>, Option<String>) {
        let now = self.clock.now_ms();
        let sample = self.sampler.sample();
        let settings = value(&s.settings);
        let idle_ms = sample.idle_ms.filter(|idle| idle.is_finite() && *idle >= 0.0);
        let idle_active = s.settings.idle_enabled && idle_ms.is_some_and(|idle| idle >= s.settings.idle_after_seconds as f64 * 1000.0);
        let mut state = s.policy_state.clone();
        let waking = state.get("idleActive") == Some(&Value::Bool(true)) && !idle_active;
        if waking { state = value(&create_arc_sleep_policy_state(&settings)); }
        let target = s.settings.adaptive_target_load_pct as f64;
        let severe = (target + 8.0).min(100.0);
        let load = if s.settings.adaptive_enabled { sample.load_percent } else { None }
            .filter(|load| load.is_finite() && *load >= 0.0 && *load <= 100.0);
        let (mut observed_fps, mut observed_process_id, mut reported_fps) = (None, None, None);
        let mut fps_status = if s.settings.adaptive_enabled { "gpu-unavailable" } else { "disabled" };
        if s.settings.adaptive_enabled {
            // The JS hold/severe branches collapse: hold < severe always, so any
            // load below `severe` is below-trigger.
            if idle_active {
                fps_status = "idle-priority";
            } else if load.is_some_and(|load| load < severe) {
                fps_status = "below-trigger";
            } else if load.is_some() {
                let fps = sample.observed_fps.filter(|fps| *fps > 0.0 && *fps <= 1000.0);
                reported_fps = fps;
                match (fps, sample.observed_process_id) {
                    (Some(fps), Some(process)) => { observed_fps = Some(fps); observed_process_id = Some(process); fps_status = "ready"; }
                    _ => fps_status = "rtss-unavailable",
                }
                if waking {
                    let cap = match fps {
                        Some(fps) => fps.round().max(s.settings.adaptive_min_fps as f64).min(s.settings.adaptive_max_fps as f64) as u32,
                        None => s.settings.adaptive_max_fps,
                    };
                    state["adaptiveCapFps"] = json!(cap);
                }
            }
        }
        let policy_sample = json!({
            "nowMs": now, "idleMs": idle_ms, "loadPercent": load, "observedFps": observed_fps, "observedProcessId": observed_process_id,
        });
        let step = step_arc_sleep_policy(&state, &settings, &policy_sample);
        let mut next = value(&step.state);
        next["idleActive"] = json!(step.idle_active);
        s.policy_state = next;
        let previous = s.diagnostics.last_fast_adjustment_at_ms;
        s.diagnostics = Diagnostics {
            gpu_util_pct: load, reported_fps, fps_status,
            last_fast_adjustment_at_ms: if step.observed_fps_adjustment_applied { Some(now) } else { previous },
        };
        (step.target_fps, step.source)
    }

    fn sample_and_apply(&self, s: &mut State) {
        if s.invalid_journal || s.status == "elevation-required" { return; }
        if s.journal.is_some() && matches!(s.status, "external-change" | "recovery-pending") {
            if !self.recover_journal(s) {
                self.refresh_rtss(s, false);
                s.diagnostics = Diagnostics::idle(s.settings.adaptive_enabled);
                return;
            }
        }
        let (target, source) = self.read_policy_sample(s);
        let Some(current) = self.ensure_current_route(s, None) else {
            self.pause_without_limiter(s);
            return;
        };
        self.apply_desired_target(s, target, source, true, None, Some(current));
    }

    fn pause_without_limiter(&self, s: &mut State) -> bool {
        let message = if s.journal.is_some() {
            "The saved FPS limiter is unavailable; Arc Sleep is holding its recovery journal.".to_owned()
        } else {
            s.limiter.unavailable_message()
        };
        s.status = if s.journal.is_some() { "recovery-pending" } else { "limiter-unavailable" };
        s.message = Some(message);
        false
    }

    /// `applyDesiredTarget`: the single automatic write path.
    fn apply_desired_target(&self, s: &mut State, policy_target: Option<u32>, source: Option<String>, automatic: bool, required: Option<&str>, known: Option<RawState>) -> bool {
        let mut current = known.or_else(|| self.read_current(s, required));
        if required == Some("rtss") && !matches!(s.limiter.route(), Some(Route::Rtss)) { current = None; }
        let Some(mut current) = current else { return self.pause_without_limiter(s); };
        if s.pending_base_disable && !self.apply_pending_base_disable(s, &mut current, automatic, required) { return false; }
        self.ensure_base_frame_limit(s, Some(current));
        if s.journal.as_ref().is_some_and(|journal| journal.external_change) {
            s.status = "external-change";
            s.message = Some(format!("The {} {UNOWNED_SWITCH}", journal_name(s)));
            return false;
        }
        if source.is_some() && matches!(s.limiter.route(), Some(Route::Igcl { .. })) && !s.limiter.live_change() {
            return self.static_only(s, current, automatic);
        }
        let target_fps = effective_target(s.base_frame_limit.as_ref(), policy_target).and_then(|target| self.clamp(s, target as f64));
        if s.journal.as_ref().is_some_and(|journal| journal.expected != current) {
            s.status = "external-change";
            s.message = Some(format!("The {} frame limit changed outside Arc Power; Arc Sleep stopped writing.", journal_name(s)));
            return false;
        }
        // No live policy output releases the temporary override to its exact
        // baseline; the baseline can itself be the user's enabled base cap.
        if source.is_none() && s.journal.is_some() { return self.release_to_baseline(s, current); }
        let Some(target_fps) = target_fps else {
            if s.journal.is_none() {
                s.policy_source = None;
                s.status = s.ready_status();
                s.message = None;
                return true;
            }
            return self.release_to_baseline(s, current);
        };
        let target = RawState { limit: target_fps, denominator: Some(1), limiter_enabled: true };
        let route = s.limiter.route().cloned().unwrap_or(Route::Rtss);
        if current == target {
            if source.is_some() && s.journal.is_none() {
                // Adopt what Arc Sleep already sees; the baseline is what it
                // must hand back when the policy releases.
                let underlay = s.limiter.underlay_state(&*self.io, current);
                let baseline = self.baseline(s, underlay);
                if !self.save_journal(s, Journal::settled(&route, baseline, underlay, current)) { return false; }
            }
            s.policy_source = source.clone();
            s.status = status_for(source.as_deref(), s);
            s.message = None;
            return true;
        }
        let underlay = match s.journal.as_ref() {
            Some(journal) => journal.underlay,
            None => s.limiter.underlay_state(&*self.io, current),
        };
        let baseline = self.baseline(s, underlay);
        let temporary = source.is_some();
        let base_transition = source.is_none() && s.journal.is_none();
        if (temporary || base_transition)
            && !self.save_journal(s, Journal::pending(&route, if base_transition { target } else { baseline }, underlay, current, target)) {
            return false;
        }
        let automatic = automatic && (temporary || s.journal.is_some() || base_transition);
        match s.limiter.write_cap(&*self.io, Some(current), target_fps, automatic) {
            WriteOutcome::Ok { observed } => {
                if temporary {
                    if !self.save_journal(s, Journal::settled(&route, baseline, underlay, observed)) { return false; }
                } else if base_transition {
                    self.clear_journal(s);
                }
                s.policy_source = source.clone();
                s.status = status_for(source.as_deref(), s);
                s.message = None;
                true
            }
            WriteOutcome::Conflict { observed } => {
                let underlay = s.journal.as_ref().map(|journal| journal.underlay)
                    .unwrap_or_else(|| s.limiter.underlay_state(&*self.io, current));
                let baseline = self.baseline(s, underlay);
                let expected = observed.or_else(|| s.limiter.last_known_raw()).unwrap_or(current);
                if !self.save_journal(s, Journal::external(&route, baseline, underlay, expected)) { return false; }
                s.status = "external-change";
                s.message = Some(format!("{} frame limit changed outside Arc Power; Arc Sleep stopped writing.", route_name(&route)));
                false
            }
            WriteOutcome::Failed { unavailable, elevation_required, error } => {
                s.status = if elevation_required { "elevation-required" } else if unavailable { "limiter-unavailable" } else { "error" };
                s.message = Some(error);
                false
            }
        }
    }
    /// `source` when the driver has no LIVE_CHANGE: release the journal and
    /// re-assert the saved base cap once.
    fn static_only(&self, s: &mut State, current: RawState, automatic: bool) -> bool {
        let route = s.limiter.route().cloned().unwrap_or(Route::Rtss);
        let name = route_name(&route);
        let mut current = current;
        if let Some(journal) = s.journal.clone() {
            if !journal.attributed(current) {
                s.status = "external-change";
                s.message = Some("The IGCL frame limit changed outside Arc Power; the current state was preserved.".into());
                return false;
            }
            if !self.save_journal(s, Journal::pending(&journal.route, journal.baseline, journal.underlay, current, journal.baseline)) { return false; }
            let retain = s.base_frame_limit.as_ref().is_some_and(base_enabled);
            let outcome = s.limiter.restore(&*self.io, &journal.route, current, journal.baseline, retain, true);
            if !self.restore_outcome(s, outcome) { return false; }
            self.clear_journal(s);
            let Some(state) = self.read_raw(s, None, false, None) else {
                s.status = "recovery-pending";
                s.message = Some(format!("The {name} frame limit was restored, but could not be re-read."));
                return false;
            };
            current = state;
        }
        if let Some(limit) = s.base_value() {
            let base_cap = RawState { limit, denominator: Some(1), limiter_enabled: true };
            if current != base_cap {
                match s.limiter.write_cap(&*self.io, Some(current), limit, automatic) {
                    WriteOutcome::Ok { .. } => {}
                    WriteOutcome::Conflict { .. } => {
                        s.status = "external-change";
                        s.message = Some(format!("The {name} frame limit changed outside Arc Power; the current state was preserved."));
                        return false;
                    }
                    WriteOutcome::Failed { unavailable, elevation_required, error } => {
                        s.status = if elevation_required { "elevation-required" } else if unavailable { "limiter-unavailable" } else { "error" };
                        s.message = Some(error);
                        return false;
                    }
                }
            }
        }
        s.policy_source = None;
        s.status = "igcl-static-only";
        s.message = Some("This driver does not report LIVE_CHANGE for the frame limit. The saved Base FPS Cap may affect new games, but Arc Sleep cannot adjust a running game dynamically.".into());
        true
    }

    /// Hand the exact baseline back to the provider and stop owning the cap.
    fn release_to_baseline(&self, s: &mut State, current: RawState) -> bool {
        let Some(journal) = s.journal.clone() else { return true; };
        let name = route_name(&journal.route);
        if !journal.attributed(current) {
            s.status = "external-change";
            s.message = Some(format!("The {name} frame limit no longer matches Arc Sleep's saved transition; the current state was preserved."));
            return false;
        }
        if !self.save_journal(s, Journal::pending(&journal.route, journal.baseline, journal.underlay, current, journal.baseline)) { return false; }
        let retain = s.base_frame_limit.as_ref().is_some_and(base_enabled);
        let outcome = s.limiter.restore(&*self.io, &journal.route, current, journal.baseline, retain, true);
        if !self.restore_outcome(s, outcome) { return false; }
        self.clear_journal(s);
        s.policy_source = None;
        s.status = s.ready_status();
        s.message = None;
        true
    }

    /// `applyBaseDisable`: clear the Graphics FPS Limit and settle ownership.
    fn apply_base_disable(&self, s: &mut State, current: RawState, base: &Value, automatic: bool) -> bool {
        let Some(route) = s.limiter.route().cloned() else {
            s.status = "recovery-pending";
            s.message = Some("No supported FPS limiter is available".into());
            return false;
        };
        let name = route_name(&route);
        let (underlay, target, mut request) = s.limiter.disable_target(&*self.io, current, base_value(base).unwrap_or(DEFAULT_BASE_FPS));
        if !self.save_base_and_journal(s, Some(base), Some(&Journal::pending(&route, target, underlay, current, target)), false, None) {
            return false;
        }
        request["automatic"] = json!(automatic);
        let result = match &route {
            Route::Rtss => self.io.rtss_apply(&request),
            Route::Igcl { device_key } => { request["deviceKey"] = json!(device_key); self.io.igcl_apply(&request) }
        };
        if result.get("ok") != Some(&Value::Bool(true)) || result.get("used") != Some(&Value::Bool(true)) {
            if result.get("conflict") == Some(&Value::Bool(true)) || result.get("errorCode").and_then(Value::as_str) == Some("external-change") {
                let observed = self.read_raw(s, Some(&route), false, None);
                let expected = observed.or_else(|| s.limiter.last_known_raw()).unwrap_or(current);
                let latched = Journal::external(&route, target, underlay, expected);
                self.save_base_and_journal(s, Some(base), Some(&latched), false, None);
                s.status = "external-change";
            } else {
                s.status = match result.get("errorCode").and_then(Value::as_str) {
                    Some("elevation-required") => "elevation-required",
                    Some("unavailable") => "recovery-pending",
                    _ => "error",
                };
            }
            s.message = Some(result.get("error").and_then(Value::as_str).map(str::to_owned)
                .unwrap_or_else(|| format!("{name} did not disable the Graphics FPS Limit")));
            return false;
        }
        let Some(observed) = self.read_from(s, &route) else {
            s.status = "recovery-pending";
            s.message = Some(format!("{name} became unavailable while disabling the Graphics FPS Limit; recovery is saved."));
            return false;
        };
        let deferred = result.get("flagRestorationDeferred") == Some(&Value::Bool(true));
        let unexpected = result.get("observedState").and_then(parse_raw_state).is_some_and(|applied| applied != observed)
            || observed.limit != target.limit
            || observed.denominator != target.denominator
            || (observed.limiter_enabled != target.limiter_enabled && !(deferred && observed.limiter_enabled));
        if unexpected {
            let latched = Journal::external(&route, observed, underlay, observed);
            self.save_base_and_journal(s, Some(base), Some(&latched), false, None);
            s.status = "external-change";
            s.message = Some(format!("The {name} cap changed while disabling the Graphics FPS Limit; the current state was preserved."));
            return false;
        }
        let settled = Journal::settled(&route, observed, underlay, observed);
        if !self.save_base_and_journal(s, Some(base), Some(&settled), false, None) { return false; }
        self.clear_journal(s);
        s.status = s.ready_status();
        s.message = None;
        true
    }

    /// Honor a Graphics FPS Limit change the UI made while the limiter was
    /// unavailable before taking any policy sample.
    fn apply_pending_base_disable(&self, s: &mut State, current: &mut RawState, automatic: bool, required: Option<&str>) -> bool {
        let route = s.limiter.route().cloned().unwrap_or(Route::Rtss);
        let name = route_name(&route);
        if let Some(expected) = s.pending_base_disable_expected {
            if *current != expected {
                let underlay = s.limiter.underlay_state(&*self.io, *current);
                let latched = Journal::external(&route, *current, underlay, *current);
                let base = s.base_frame_limit.clone();
                self.save_base_and_journal(s, base.as_ref(), Some(&latched), false, None);
                s.status = "external-change";
                s.message = Some(format!("The {name} frame limit changed while unavailable; the saved Graphics FPS Limit was preserved."));
                return false;
            }
        }
        let base = s.base_frame_limit.clone().unwrap_or_else(|| json!({"enabled": false, "value": DEFAULT_BASE_FPS}));
        if !self.apply_base_disable(s, *current, &base, automatic) { return false; }
        match self.read_current(s, required) {
            Some(state) => { *current = state; true }
            None => {
                s.status = "recovery-pending";
                s.message = Some(format!("{name} became unavailable after applying the pending Graphics FPS Limit change."));
                false
            }
        }
    }

    /// `setBaseFrameLimit`: the only path that changes the saved base cap.
    fn set_base_frame_limit(&self, s: &mut State, input: &Value, device_key: Option<&str>, required: Option<&str>) -> Value {
        let Some(mut next_base) = normalize_base_frame_limit(input) else {
            return json!({"handled": false, "ok": false, "error": "Arc Sleep base frame limit is invalid"});
        };
        // A global RTSS request must never migrate to a device-scoped limiter or
        // recover another provider's journal as a side effect.
        if required == Some("rtss") && s.journal.as_ref().is_some_and(|journal| !matches!(journal.route, Route::Rtss)) {
            return json!({"handled": false, "ok": false, "error": DIFFERENT_PROVIDER});
        }
        if s.invalid_journal {
            s.status = "recovery-pending";
            s.message = Some(INVALID_JOURNAL.into());
            return json!({"handled": false, "ok": false, "error": INVALID_JOURNAL});
        }
        let rearming = required.is_none() && s.journal.as_ref().is_some_and(|journal| journal.external_change);
        let journal_route = s.journal.as_ref().map(|journal| journal.route.clone());
        let current = if required == Some("rtss") {
            self.read_from(s, &Route::Rtss)
        } else if rearming {
            match journal_route.clone() { Some(route) => self.read_from(s, &route), None => None }
        } else {
            self.ensure_current_route(s, device_key)
        };
        if required == Some("rtss") && (current.is_none() || !matches!(s.limiter.route(), Some(Route::Rtss))) {
            return json!({"handled": false, "ok": false, "error": "RTSS is unavailable; the global FPS limit was not changed."});
        }
        if current.is_some() && matches!(s.limiter.route(), Some(Route::Igcl { .. })) {
            if let Some(limit) = next_base.get("value").and_then(Value::as_f64).and_then(|target| self.clamp(s, target)) {
                next_base["value"] = json!(limit);
            }
        }
        if rearming && current.is_none() {
            let message = format!("The saved {} frame limit cannot be checked; recovery must complete before Arc Sleep resumes.", journal_name(s));
            s.status = "limiter-unavailable";
            s.message = Some(message.clone());
            return json!({"handled": false, "error": message});
        }
        if rearming { return self.rearm(s, current, &next_base, journal_route); }
        // A journal that no longer matches the live state is abandoned before
        // the new base cap is applied.
        if let Some(journal) = s.journal.clone() {
            if !current.is_some_and(|current| current == journal.expected) {
                if current.is_some() {
                    self.clear_journal(s);
                    s.status = "ready";
                    s.message = None;
                } else {
                    let pending = !base_enabled(&next_base);
                    let deferred = Journal {
                        baseline: if pending { journal.underlay } else { base_target(&next_base) },
                        ..journal.clone()
                    };
                    self.save_base_and_journal(s, Some(&next_base), Some(&deferred), pending, pending.then_some(deferred.baseline));
                    let message = format!("{} The saved Graphics FPS Limit was not applied.", s.limiter.unavailable_message());
                    s.status = if pending { "recovery-pending" } else { "limiter-unavailable" };
                    s.message = Some(message.clone());
                    return json!({"handled": false, "error": message});
                }
            }
        }
        let mut next_journal = s.journal.clone();
        if let Some(journal) = s.journal.clone() {
            let baseline = if base_enabled(&next_base) {
                base_target(&next_base)
            } else if matches!(journal.route, Route::Igcl { .. }) {
                journal.underlay
            } else {
                s.limiter.disable_target_state(&*self.io, journal.underlay)
            };
            next_journal = Some(Journal {
                baseline, underlay: journal.underlay, expected: current.unwrap_or(journal.expected),
                route: journal.route.clone(), pending: None, external_change: false,
            });
        }
        let (policy_target, policy_source) = self.read_policy_sample(s);
        if !base_enabled(&next_base) && policy_target.is_none() && next_journal.is_none() {
            let Some(current) = current else {
                let message = format!("{} The Graphics FPS Limit was not changed.", s.limiter.unavailable_message());
                let expected = s.limiter.last_known_raw();
                self.save_base_and_journal(s, Some(&next_base), None, true, expected);
                s.status = "limiter-unavailable";
                s.message = Some(message.clone());
                return json!({"handled": false, "ok": false, "error": message});
            };
            return if self.apply_base_disable(s, current, &next_base, false) {
                json!({"handled": true, "ok": true, "source": s.limiter.route().map(Route::source).unwrap_or("rtss"), "frameLimit": next_base})
            } else {
                json!({"handled": false, "ok": false, "error": s.message.clone().unwrap_or_default()})
            };
        }
        let (pending, expected) = (s.pending_base_disable, s.pending_base_disable_expected);
        if !self.save_base_and_journal(s, Some(&next_base), next_journal.as_ref(), pending, expected) {
            return json!({"handled": false, "ok": false, "error": s.message.clone().unwrap_or_default()});
        }
        if self.apply_desired_target(s, policy_target, policy_source, false, required, current) {
            return json!({"handled": true, "ok": true, "source": s.limiter.route().map(Route::source).unwrap_or("rtss"), "frameLimit": next_base});
        }
        json!({"handled": false, "ok": false, "error": s.message.clone().unwrap_or_else(|| "Arc Sleep could not apply the base frame limit".into())})
    }

    /// The explicit Graphics/Base FPS Apply that relinquishes an external-change
    /// latch; only this path may re-arm automatic control.
    fn rearm(&self, s: &mut State, current: Option<RawState>, next_base: &Value, journal_route: Option<Route>) -> Value {
        let Some(current) = current else {
            return json!({"handled": false, "ok": false, "error": "The saved frame limit cannot be checked; recovery must complete before Arc Sleep resumes."});
        };
        let (previous_base, previous_journal) = (s.base_frame_limit.clone(), s.journal.clone());
        let (previous_pending, previous_expected) = (s.pending_base_disable, s.pending_base_disable_expected);
        let (policy_target, policy_source) = self.read_policy_sample(s);
        let route = journal_route.or_else(|| s.limiter.route().cloned()).unwrap_or(Route::Rtss);
        if effective_target(Some(next_base), policy_target).is_none() {
            return if self.apply_base_disable(s, current, next_base, false) {
                json!({"handled": true, "ok": true, "source": route.source(), "frameLimit": next_base})
            } else {
                json!({"handled": false, "ok": false, "error": s.message.clone().unwrap_or_default()})
            };
        }
        let baseline = if base_enabled(next_base) { base_target(next_base) } else { current };
        let rearm = Journal { baseline, underlay: current, expected: current, route: route.clone(), pending: None, external_change: false };
        if !self.save_base_and_journal(s, Some(next_base), Some(&rearm), false, None) {
            return json!({"handled": false, "ok": false, "error": s.message.clone().unwrap_or_default()});
        }
        if self.apply_desired_target(s, policy_target, policy_source, false, Some(route.source()), Some(current)) {
            return json!({"handled": true, "ok": true, "source": route.source(), "frameLimit": next_base});
        }
        // An interrupted or conflicting manual re-arm must never turn an
        // outside-owned state into automatic restore authority.
        let observed = self.read_raw(s, Some(&route), false, None);
        let mut latched = previous_journal.unwrap_or_else(|| Journal::external(&route, current, current, current));
        latched.expected = observed.unwrap_or(latched.expected);
        latched.pending = None;
        latched.external_change = true;
        self.save_base_and_journal(s, previous_base.as_ref(), Some(&latched), previous_pending, previous_expected);
        let message = s.message.clone().unwrap_or_else(|| "The external frame-limit change was preserved.".into());
        s.status = "external-change";
        s.message = Some(message.clone());
        json!({"handled": false, "ok": false, "error": message})
    }

    /// `updateSettings`: an enable transition re-acquires immediately, while
    /// disabling the last policy restores the baseline and clears ownership.
    /// `next` is the `arcSleep` policy object, exactly as JS `updateSettings`.
    fn set_settings(&self, s: &mut State, next: &Value) {
        s.settings = normalize_arc_sleep_settings(next);
        s.reset_policy();
        if s.journal.as_ref().is_some_and(|journal| journal.external_change) {
            self.refresh_rtss(s, true);
            s.diagnostics = Diagnostics::idle(s.settings.adaptive_enabled);
            s.status = "external-change";
            s.message = Some(format!("The {} {UNOWNED_SWITCH}", journal_name(s)));
            return;
        }
        if !s.has_policy() && s.journal.is_some() {
            let Some(actual) = self.read_raw(s, None, false, None) else {
                s.status = "recovery-pending";
                s.message = Some(format!("{} is unavailable; Arc Sleep will retry recovery.", journal_name(s)));
                return;
            };
            self.release_to_baseline(s, actual);
            return;
        }
        self.sample_and_apply(s);
    }
}

impl Transaction<'_> {
    pub fn required_source(&self) -> Option<&'static str> { self.required_source }
    pub fn get_snapshot(&self) -> Value { self.controller.snapshot(self.state) }
    pub fn set_settings(&mut self, next: &Value) { self.controller.set_settings(self.state, next) }

    /// Change the saved base cap inside the graphics transaction. The
    /// pre-transaction ownership record is captured for [`Self::rollback`].
    pub fn set_base_frame_limit(&mut self, input: &Value, device_key: Option<&str>) -> Value {
        if self.snapshot.is_none() {
            let s = &*self.state;
            self.snapshot = Some(Snapshot {
                base: s.base_frame_limit.clone(), journal: s.journal.clone(), pending: s.pending_base_disable,
                expected: s.pending_base_disable_expected, status: s.status, message: s.message.clone(),
                policy_source: s.policy_source.clone(), raw: s.limiter.last_raw(),
            });
        }
        self.controller.set_base_frame_limit(self.state, input, device_key, self.required_source)
    }

    /// Undo a base-cap change whose graphics apply failed: put the cap back
    /// first, then the ownership record, so a crash stays recoverable.
    pub fn rollback(&mut self) -> Value {
        let Some(snapshot) = self.snapshot.take() else { return json!({"ok": true}) };
        let controller = self.controller;
        let s = &mut *self.state;
        let Some(current) = snapshot.raw else { return json!({"ok": true}) };
        let Some(actual) = controller.read_raw(s, None, false, None) else {
            s.status = "recovery-pending";
            s.message = Some("The FPS limiter is unavailable; the previous FPS cap could not be restored.".into());
            return json!({"ok": false, "unavailable": true, "error": s.message});
        };
        let route = s.limiter.route().cloned().unwrap_or(Route::Rtss);
        if actual != current {
            if !s.journal.as_ref().is_some_and(|journal| journal.expected == actual) {
                let latched = Journal::external(&route, current, current, actual);
                controller.save_base_and_journal(s, snapshot.base.as_ref(), Some(&latched), snapshot.pending, snapshot.expected);
                s.status = "external-change";
                s.message = Some(format!("The {} frame limit changed outside Arc Power during Graphics apply; the current state was preserved.", route_name(&route)));
                return json!({"ok": false, "conflict": true, "error": s.message});
            }
            let underlay = snapshot.journal.as_ref().map(|journal| journal.underlay).unwrap_or(current);
            let bracket = Journal::pending(&route, current, underlay, actual, current);
            if !controller.save_base_and_journal(s, snapshot.base.as_ref(), Some(&bracket), snapshot.pending, snapshot.expected) {
                return json!({"ok": false, "error": s.message});
            }
            let retain = snapshot.base.as_ref().is_some_and(base_enabled) || snapshot.journal.is_some();
            let outcome = s.limiter.restore(&*controller.io, &route, actual, current, retain, true);
            if !controller.restore_outcome(s, outcome) {
                return json!({"ok": false, "conflict": s.status == "external-change", "error": s.message});
            }
        }
        if !controller.save_base_and_journal(s, snapshot.base.as_ref(), snapshot.journal.as_ref(), snapshot.pending, snapshot.expected) {
            return json!({"ok": false, "error": s.message});
        }
        s.status = snapshot.status;
        s.message = snapshot.message;
        s.policy_source = snapshot.policy_source;
        json!({"ok": true})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;

    const CAP_120: RawState = RawState { limit: 120, denominator: Some(1), limiter_enabled: true };
    /// A user's global RTSS profile with no limiter and no cap.
    const UNDERLAY: RawState = RawState { limit: 60, denominator: Some(1), limiter_enabled: false };

    #[derive(Clone)]
    struct FakeStore(Arc<Mutex<Value>>);

    impl FakeStore {
        fn document(&self) -> Value { self.0.lock().unwrap().clone() }
    }

    impl ArcSleepStore for FakeStore {
        fn load(&self) -> Result<Value, String> { Ok(self.document()) }
        // Mirrors `SettingsStore::load_settings_sync`: the production cadence
        // reads the cached snapshot rather than the file.
        fn load_cached(&self) -> Option<Value> { Some(self.document()) }
        fn save(&self, patch: &Value) -> Result<(), String> {
            let mut document = self.0.lock().unwrap();
            let object = document.as_object_mut().expect("settings document");
            for (key, value) in patch.as_object().expect("arc sleep patch") { object.insert(key.clone(), value.clone()); }
            Ok(())
        }
    }

    #[derive(Clone)]
    struct FakeClock(Arc<Mutex<f64>>);

    impl FakeClock {
        fn set(&self, now_ms: f64) { *self.0.lock().unwrap() = now_ms; }
    }

    impl Clock for FakeClock {
        fn now_ms(&self) -> f64 { *self.0.lock().unwrap() }
    }

    #[derive(Clone)]
    struct FakeSampler(Arc<Mutex<Sample>>);

    impl PolicySampler for FakeSampler {
        fn sample(&self) -> Sample { *self.0.lock().unwrap() }
    }

    #[derive(Clone)]
    struct FakeLimiter {
        state: Arc<Mutex<RawState>>,
        applies: Arc<AtomicUsize>,
        restores: Arc<AtomicUsize>,
        fail_restore: Arc<AtomicBool>,
    }

    impl FakeLimiter {
        fn new(state: RawState) -> Self {
            Self {
                state: Arc::new(Mutex::new(state)), applies: Arc::new(AtomicUsize::new(0)),
                restores: Arc::new(AtomicUsize::new(0)), fail_restore: Arc::new(AtomicBool::new(false)),
            }
        }
        fn state(&self) -> RawState { *self.state.lock().unwrap() }
        fn applies(&self) -> usize { self.applies.load(Ordering::SeqCst) }
        fn restores(&self) -> usize { self.restores.load(Ordering::SeqCst) }
    }

    impl LimiterIo for FakeLimiter {
        fn rtss_ownership(&self) -> Value {
            json!({"ok": true, "state": self.state().json(), "underlay": UNDERLAY.json(), "disableState": self.state().with_enabled(false).json()})
        }
        fn rtss_apply(&self, options: &Value) -> Value {
            self.applies.fetch_add(1, Ordering::SeqCst);
            if options.get("expectedState").and_then(parse_raw_state).is_some_and(|expected| expected != self.state()) {
                return json!({"ok": false, "used": false, "conflict": true, "errorCode": "external-change"});
            }
            let limit = options.get("value").and_then(Value::as_i64).unwrap_or(0);
            let enabled = options.get("enabled") == Some(&Value::Bool(true));
            *self.state.lock().unwrap() = RawState { limit, denominator: Some(1), limiter_enabled: enabled };
            json!({"ok": true, "used": true, "observedState": self.state().json()})
        }
        fn rtss_restore_state(&self, options: &Value) -> Value {
            self.restores.fetch_add(1, Ordering::SeqCst);
            if self.fail_restore.load(Ordering::SeqCst) { return json!({"ok": false, "error": "RTSS state restoration failed"}); }
            let target = options.get("state").and_then(parse_raw_state).expect("restore target");
            *self.state.lock().unwrap() = target;
            json!({"ok": true, "observedState": target.json()})
        }
        fn rtss_restore(&self, _token: &Value) -> Value { json!({"ok": true}) }
        fn igcl_read(&self, _device_key: Option<&str>) -> Value { json!({"ok": false, "error": "the fake never reads IGCL"}) }
        fn igcl_apply(&self, _request: &Value) -> Value { json!({"ok": false, "error": "the fake never writes IGCL"}) }
    }

    struct Fixture {
        store: FakeStore,
        clock: FakeClock,
        limiter: FakeLimiter,
        controller: Arc<ArcSleepController>,
    }

    impl Fixture {
        fn new(document: Value, state: RawState, sample: Sample) -> Self {
            let (store, clock, limiter) = (FakeStore(Arc::new(Mutex::new(document))), FakeClock(Arc::new(Mutex::new(1_000.0))), FakeLimiter::new(state));
            let controller = Arc::new(ArcSleepController::new(
                Box::new(limiter.clone()), Box::new(FakeSampler(Arc::new(Mutex::new(sample)))), Box::new(clock.clone()), Box::new(store.clone()),
            ));
            Self { store, clock, limiter, controller }
        }
        fn tick_at(&self, now_ms: f64) -> TickOutcome { self.clock.set(now_ms); self.controller.tick() }
        fn snapshot(&self) -> Value { self.controller.get_snapshot() }
    }

    fn adaptive_document() -> Value {
        json!({
            "arcSleep": {"adaptiveEnabled": true, "adaptiveMinFps": 60, "adaptiveMaxFps": 144, "adaptiveTargetLoadPct": 85},
            "arcSleepFrameLimitBase": {"enabled": true, "value": 144},
        })
    }
    fn idle_policy(enabled: bool) -> Value { json!({"idleEnabled": enabled, "idleAfterSeconds": 60, "idleFps": 30}) }
    fn idle_document(enabled: bool) -> Value {
        json!({"arcSleep": idle_policy(enabled), "arcSleepFrameLimitBase": {"enabled": false, "value": 60}})
    }
    fn severe_sample() -> Sample { Sample { idle_ms: Some(0.0), load_percent: Some(100.0), ..Sample::default() } }
    fn idle_sample() -> Sample { Sample { idle_ms: Some(120_000.0), ..Sample::default() } }

    fn sorted_keys(value: &Value) -> Vec<&str> {
        let mut keys: Vec<&str> = value.as_object().expect("object").keys().map(String::as_str).collect();
        keys.sort_unstable();
        keys
    }

    #[test]
    fn snapshot_matches_the_recorded_js_field_list() {
        let fixture = Fixture::new(json!({}), CAP_120, Sample::default());
        let snapshot = fixture.snapshot();
        let mut expected = vec![
            "rtssAvailable", "activeLimiter", "limiterDeviceName", "limiterDeviceKey", "liveAdjustmentSupported",
            "frameLimitEffectiveNow", "baseCapFps", "baseFrameLimit", "currentFrameLimitFps", "effectiveCapFps",
            "policy", "status", "message", "diagnostics",
        ];
        expected.sort_unstable();
        assert_eq!(sorted_keys(&snapshot), expected);
        assert_eq!(sorted_keys(&snapshot["diagnostics"]), vec!["fastAdjustmentApplied", "fpsStatus", "gpuUtilPct", "reportedFps"]);
        assert_eq!(snapshot["status"], json!("ready"));
        assert_eq!(snapshot["activeLimiter"], Value::Null);
        assert_eq!(snapshot["baseFrameLimit"], Value::Null);
        assert_eq!(snapshot["liveAdjustmentSupported"], json!(false));
        assert_eq!(snapshot["diagnostics"]["fpsStatus"], json!("disabled"));
        assert_eq!(snapshot["diagnostics"]["fastAdjustmentApplied"], json!(false));

        // The no-controller fallback is the documented ipc-core shape, which
        // has never carried `currentFrameLimitFps`.
        let fallback = unavailable_snapshot();
        assert_eq!(fallback["status"], json!("limiter-unavailable"));
        assert_eq!(fallback["message"], json!(LIMITER_UNAVAILABLE));
        assert_eq!(fallback["diagnostics"], json!({"gpuUtilPct": null, "reportedFps": null, "fpsStatus": "gpu-unavailable", "fastAdjustmentApplied": false}));
        assert!(!sorted_keys(&fallback).contains(&"currentFrameLimitFps"));
    }

    #[test]
    fn a_policy_saved_elsewhere_is_adopted_without_a_restart() {
        // The panel's only save path persists `arcSleep` through the settings
        // store; the native host never calls `set_settings` directly. The cadence
        // therefore has to pick the change up on its own.
        let fixture = Fixture::new(idle_document(false), CAP_120, idle_sample());
        assert_eq!(fixture.controller.start(), TickOutcome::Applied);
        assert_eq!(fixture.limiter.applies(), 0); // a disabled policy never touches the cap
        fixture.store.save(&json!({"arcSleep": idle_policy(true)})).unwrap();
        assert_eq!(fixture.tick_at(2_100.0), TickOutcome::Applied);
        assert_eq!(fixture.snapshot()["policy"], json!("idle"));
        assert_eq!(fixture.limiter.applies(), 1, "the adopted policy acquires the cap");
        // An unchanged document must not re-apply on every slot.
        assert_eq!(fixture.tick_at(3_200.0), TickOutcome::Applied);
        assert_eq!(fixture.limiter.applies(), 1);
    }

    #[test]
    fn a_stopped_controller_never_reapplies_until_it_is_restarted() {
        let fixture = Fixture::new(adaptive_document(), CAP_120, severe_sample());
        assert_eq!(fixture.controller.start(), TickOutcome::Applied);
        assert_eq!(fixture.limiter.applies(), 1);
        fixture.controller.stop();
        let restores = fixture.limiter.restores();
        assert!(!fixture.controller.is_running());
        // The host loop keeps offering slots after suspend; a stopped
        // controller must not re-acquire the limiter while the machine sleeps.
        assert_eq!(fixture.tick_at(1_200.0), TickOutcome::NotDue);
        assert_eq!(fixture.tick_at(2_400.0), TickOutcome::NotDue);
        assert_eq!(fixture.limiter.applies(), 1);
        assert_eq!(fixture.limiter.restores(), restores);
        // Resume re-acquires the cap through the ordinary start path.
        assert_eq!(fixture.controller.start(), TickOutcome::Applied);
        assert!(fixture.controller.is_running());
        assert_eq!(fixture.tick_at(1_100.0), TickOutcome::NotDue);
    }

    #[test]
    fn tick_samples_immediately_then_on_the_js_cadence_without_write_storms() {
        let fixture = Fixture::new(adaptive_document(), CAP_120, severe_sample());
        assert_eq!(fixture.controller.start(), TickOutcome::Applied);
        assert_eq!(fixture.limiter.applies(), 1, "the first sample applies once");
        assert_eq!(fixture.limiter.state(), RawState { limit: 144, denominator: Some(1), limiter_enabled: true });
        assert_eq!(fixture.store.document()["arcSleepJournal"]["expected"]["limit"], json!(144));
        assert_eq!(fixture.store.document()["arcSleepJournal"]["pending"], Value::Null, "a verified write settles the bracket");

        assert_eq!(fixture.tick_at(1_000.0), TickOutcome::NotDue);
        assert_eq!(fixture.tick_at(1_500.0), TickOutcome::NotDue);
        assert_eq!(fixture.limiter.applies(), 1);
        assert_eq!(fixture.tick_at(2_000.0), TickOutcome::Applied);
        assert_eq!(fixture.limiter.applies(), 1, "an identical target is never rewritten");
        assert_eq!(fixture.tick_at(3_000.0), TickOutcome::Applied);
        assert_eq!(fixture.limiter.applies(), 2, "a changed policy target is applied once");
        assert_eq!(fixture.limiter.state().limit, 136);
        assert_eq!(fixture.snapshot()["policy"], json!("adaptive"));

        let unstarted = Fixture::new(adaptive_document(), CAP_120, severe_sample());
        assert_eq!(unstarted.controller.tick(), TickOutcome::Applied, "a tick before start still samples immediately");
        assert_eq!(unstarted.limiter.applies(), 1);
    }

    #[test]
    fn disabling_the_last_policy_restores_the_baseline_and_clears_ownership() {
        let fixture = Fixture::new(idle_document(true), CAP_120, idle_sample());
        fixture.controller.start();
        assert_eq!(fixture.limiter.state(), RawState { limit: 30, denominator: Some(1), limiter_enabled: true });
        assert_ne!(fixture.store.document()["arcSleepJournal"], Value::Null);

        fixture.controller.with_transaction(None, |tx| tx.set_settings(&idle_policy(false)));
        assert_eq!(fixture.limiter.state(), UNDERLAY, "the pre-run cap is handed back");
        assert_eq!(fixture.limiter.restores(), 1);
        assert_eq!(fixture.store.document()["arcSleepJournal"], Value::Null);
        assert_eq!(fixture.store.document()["arcSleepFrameLimitBase"], json!({"enabled": false, "value": 60}));
        assert_ne!(fixture.store.document()["arcSleepPendingBaseDisable"], json!(true));
        assert_eq!(fixture.snapshot()["status"], json!("disabled"));
        assert_eq!(fixture.snapshot()["policy"], Value::Null);

        fixture.controller.with_transaction(None, |tx| tx.set_settings(&idle_policy(true)));
        assert_eq!(fixture.limiter.state(), RawState { limit: 30, denominator: Some(1), limiter_enabled: true });
        assert_eq!(fixture.limiter.applies(), 2, "re-enabling re-acquires the cap");
        assert_ne!(fixture.store.document()["arcSleepJournal"], Value::Null);
        assert_eq!(fixture.snapshot()["status"], json!("idle"));
    }

    #[test]
    fn a_transaction_and_a_tick_never_interleave_limiter_writes() {
        let fixture = Fixture::new(adaptive_document(), CAP_120, severe_sample());
        fixture.controller.start();
        let before = fixture.limiter.applies();
        let controller = fixture.controller.clone();
        let (busy, during, applied) = fixture.controller.with_transaction(None, |tx| {
            assert_eq!(tx.required_source(), None);
            let busy = controller.tick();
            let during = fixture.limiter.applies();
            (busy, during, tx.set_base_frame_limit(&json!({"enabled": true, "value": 90}), None))
        });
        assert_eq!(busy, TickOutcome::Busy, "a tick inside a transaction never becomes a second writer");
        assert_eq!(during, before, "the blocked tick wrote nothing");
        assert_eq!(applied["ok"], json!(true));
        assert_eq!(fixture.limiter.applies(), before + 1, "the base-cap write is the only write");
        assert_eq!(fixture.limiter.state(), RawState { limit: 90, denominator: Some(1), limiter_enabled: true });
        assert_eq!(fixture.snapshot()["baseCapFps"], json!(90));
        assert_eq!(fixture.controller.tick(), TickOutcome::NotDue);
    }

    #[test]
    fn stop_restores_and_clears_or_keeps_ownership_as_cleanup_pending() {
        let fixture = Fixture::new(idle_document(true), CAP_120, idle_sample());
        fixture.controller.start();
        assert_eq!(fixture.controller.stop(), StopOutcome::Clean);
        assert_eq!(fixture.limiter.state(), UNDERLAY);
        assert_eq!(fixture.store.document()["arcSleepJournal"], Value::Null);
        assert_eq!(fixture.snapshot()["status"], json!("ready"));
        assert_eq!(fixture.controller.stop(), StopOutcome::Clean, "a second stop owns nothing");

        let failing = Fixture::new(idle_document(true), CAP_120, idle_sample());
        failing.limiter.fail_restore.store(true, Ordering::SeqCst);
        failing.controller.start();
        let outcome = failing.controller.stop();
        assert!(matches!(outcome, StopOutcome::CleanupPending { status: "error", .. }), "got {outcome:?}");
        assert_eq!(failing.limiter.state().limit, 30, "the cap is still ours");
        assert_ne!(failing.store.document()["arcSleepJournal"], Value::Null, "ownership is never dropped silently");
        assert_eq!(failing.snapshot()["status"], json!("error"));
    }

    #[test]
    fn a_failed_graphics_apply_rolls_the_base_cap_back() {
        let fixture = Fixture::new(adaptive_document(), CAP_120, severe_sample());
        fixture.controller.start();
        let journal = fixture.store.document()["arcSleepJournal"].clone();
        fixture.controller.with_transaction(None, |tx| {
            assert_eq!(tx.set_base_frame_limit(&json!({"enabled": true, "value": 90}), None)["ok"], json!(true));
            assert_eq!(tx.rollback()["ok"], json!(true));
        });
        assert_eq!(fixture.limiter.state(), RawState { limit: 144, denominator: Some(1), limiter_enabled: true });
        assert_eq!(fixture.store.document()["arcSleepFrameLimitBase"], json!({"enabled": true, "value": 144}));
        assert_eq!(fixture.store.document()["arcSleepJournal"], journal);
    }
}



