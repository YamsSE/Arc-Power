//! Native Stability Lab run controller.
//! One active run is keyed by the durable GPU key. Sampling, WHEA, workload,
//! persistence, timers and event emission are injected seams so the lifecycle
//! can be verified without a GPU, the Event Log or `%APPDATA%`.
use super::{
    stability_contract::{
        classify_stability_run, js_number, normalize_stability_report, normalize_stability_request,
        normalize_stability_sample, normalize_stable_device_key, workload_evidence_of, StabilityClock,
        STABILITY_CADENCE_DEFAULT_MS,
    },
    stability_store::StabilityStore,
    stability_whea::WheaLane,
    stability_workload::WorkloadController,
    wire::{self, WireValue},
};
use serde_json::{json, Map, Value};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

const ALREADY_ACTIVE: &str = "A Stability Lab run is already active";
const DEVICE_CHANGED: &str = "selected device changed or is no longer available";
const IMMEDIATE_UNAVAILABLE: &str = "selected device is unavailable or changed";
const WHEA_UNAVAILABLE: &str = "WHEA check unavailable";
const FALLBACK_POWER_THRESHOLD_W: f64 = 200.0;
const FALLBACK_TEMPERATURE_THRESHOLD_C: f64 = 85.0;

pub trait RunClock: Send + Sync {
    fn now_ms(&self) -> f64;
    fn now_iso(&self) -> String;
}

pub struct SystemRunClock;

impl RunClock for SystemRunClock {
    fn now_ms(&self) -> f64 {
        super::platform_context::clock_snapshot().map(|clock| clock.now_ms).unwrap_or_else(|_| {
            SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as f64).unwrap_or(0.0)
        })
    }
    fn now_iso(&self) -> String {
        super::platform_context::clock_snapshot().map(|clock| clock.now_iso)
            .unwrap_or_else(|_| "1970-01-01T00:00:00.000Z".into())
    }
}

pub trait RunSleeper: Send + Sync { fn sleep(&self, duration: Duration); }
pub struct ThreadSleeper;
impl RunSleeper for ThreadSleeper { fn sleep(&self, duration: Duration) { thread::sleep(duration); } }

pub trait RunSpawner: Send + Sync { fn spawn(&self, task: Box<dyn FnOnce() + Send>) -> Result<(), String>; }
pub struct ThreadSpawner;
impl RunSpawner for ThreadSpawner {
    fn spawn(&self, task: Box<dyn FnOnce() + Send>) -> Result<(), String> {
        thread::Builder::new().name("arc-stability-run".into()).spawn(task)
            .map(|_| ()).map_err(|error| error.to_string())
    }
}

pub trait ReportSink: Send + Sync { fn append(&self, report: &Value) -> Result<Value, String>; }

pub struct NativeReportSink { store: StabilityStore }
impl NativeReportSink {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        Ok(Self { store: StabilityStore::new(root, &Value::Null)? })
    }
}
impl ReportSink for NativeReportSink {
    fn append(&self, report: &Value) -> Result<Value, String> {
        let clock = super::platform_context::clock_snapshot().map_err(|error| error.to_string())?;
        self.store.append(report, &clock)
    }
}

pub struct StabilityRuntimeDeps {
    pub resolve_target: Box<dyn Fn(&str) -> Option<Value> + Send + Sync>,
    pub sample_target: Box<dyn Fn(&Value) -> Value + Send + Sync>,
    /// Per-engine and per-node utilization for the stressed adapter, used only
    /// for the end-of-run diagnostic log. Returns
    /// `{"engines":[{"name":"copy","utilPct":97.0}],"nodes":[{"node":1,"utilPct":97.0}]}`.
    pub engine_detail: Box<dyn Fn(&Value) -> Value + Send + Sync>,
    pub settings_snapshot: Box<dyn Fn(&Value) -> Value + Send + Sync>,
    pub ensure_telemetry: Box<dyn Fn(&Value) -> Result<(), String> + Send + Sync>,
    pub workload: Option<Box<dyn WorkloadController>>,
    pub whea: Option<Box<dyn WheaLane>>,
    pub reports: Box<dyn ReportSink>,
    pub emit: Box<dyn Fn(&Value) + Send + Sync>,
    pub clock: Box<dyn RunClock>,
    pub sleeper: Box<dyn RunSleeper>,
    pub spawner: Box<dyn RunSpawner>,
}

struct RuntimeInner {
    resolve_target: Box<dyn Fn(&str) -> Option<Value> + Send + Sync>,
    sample_target: Box<dyn Fn(&Value) -> Value + Send + Sync>,
    engine_detail: Box<dyn Fn(&Value) -> Value + Send + Sync>,
    settings_snapshot: Box<dyn Fn(&Value) -> Value + Send + Sync>,
    ensure_telemetry: Box<dyn Fn(&Value) -> Result<(), String> + Send + Sync>,
    workload: Option<Box<dyn WorkloadController>>,
    whea: Option<Box<dyn WheaLane>>,
    reports: Box<dyn ReportSink>,
    emit: Box<dyn Fn(&Value) + Send + Sync>,
    clock: Box<dyn RunClock>,
    sleeper: Box<dyn RunSleeper>,
    spawner: Box<dyn RunSpawner>,
    active: Mutex<Option<Arc<Run>>>,
}

struct Run {
    id: String,
    state: Mutex<RunState>,
    tick: Mutex<()>,
}

struct RunState {
    state: &'static str,
    target: Value,
    cadence_ms: u32,
    duration_sec: u32,
    started_ms: f64,
    started_at: String,
    ended_at: Option<String>,
    settings_snapshot: Value,
    sample_count: u64,
    fresh_sample_count: u64,
    foreground_count: u64,
    present_evidence_count: u64,
    util_evidence_count: u64,
    missing_metrics: Vec<String>,
    threshold_breaches: u64,
    thresholds: Vec<Value>,
    threshold_power_w: f64,
    threshold_temperature_c: f64,
    threshold_sources: Value,
    threshold_fallbacks: Vec<String>,
    driver_error_count: u64,
    metrics: Value,
    limits: Value,
    whea: Value,
    whea_baseline_count: f64,
    workload_active: bool,
    workload_status: &'static str,
    workload_reason: Option<String>,
    workload_submits: u64,
    workload_errors: u64,
    workload_error: Option<String>,
    workload_thread_finished: Option<bool>,
    workload_adapter_luid: Option<String>,
    /// Highest per-engine and per-node utilization seen during the run. A
    /// single instantaneous sample can land in a gap, so the summary reports
    /// peaks: `nodes=3d:0,copy:97` means the copy engine peaked at 97 % while
    /// the 3-D node never rose above zero.
    engine_peaks: std::collections::BTreeMap<String, f64>,
    node_peaks: std::collections::BTreeMap<u32, f64>,
    /// Power, temperature, clock and utilization summary for the whole run.
    metric_stats: [MetricAggregate; AGGREGATE_METRICS.len()],
    /// The per-sample utilization series, one entry per sample (null when the
    /// sample carried no reading). Node percentages have been misread three
    /// times; the raw series is what makes the next review decode the run
    /// instead of inferring it.
    util_series: Vec<Value>,
    /// Per sample: the wall interval and every node's raw tick delta behind the
    /// published percentage. Bounded, so a 30 s run is a few KB.
    util_samples: Vec<Value>,
    telemetry_status: &'static str,
    telemetry_reason: Option<String>,
    vram_target_bytes: Option<u64>,
    vram_allocated_bytes: Option<u64>,
    vram_allocation_complete: Option<bool>,
    abort_reason: Option<String>,
    abort_details: Value,
    outcome: Option<&'static str>,
    reason: Option<String>,
    finished: bool,
    report: Option<Value>,
}

impl RunState {
    fn counters(&self) -> Value {
        json!({
            "sampleCount":self.sample_count,
            "workloadActive":self.workload_active,
            "foregroundCount":self.foreground_count,
            "presentEvidenceCount":self.present_evidence_count,
            "utilEvidenceCount":self.util_evidence_count,
        })
    }
}

pub struct StabilityRuntime { inner: Arc<RuntimeInner> }

/// Metrics summarized across the whole run. The node/engine peaks prove the
/// card was loaded at some point; min/mean/max prove it stayed loaded; count
/// proves how many samples carried the metric at all. Aggregates only, so a
/// report stays small enough to keep the whole history on disk.
const AGGREGATE_METRICS: [&str; 5] = ["powerW", "currentTempC", "coreClockMhz", "vramClockMhz", "gpuUtilPct"];

/// Upper bound on the persisted per-sample diagnostics. A 30 s run at 600 ms is
/// ~50 samples; the cap only protects a pathologically short cadence.
const MAX_UTIL_SAMPLES: usize = 600;

#[derive(Clone, Copy, Debug, Default)]
struct MetricAggregate {
    count: u64,
    sum: f64,
    min: f64,
    max: f64,
}

impl MetricAggregate {
    fn observe(&mut self, value: Option<f64>) {
        let Some(value) = value.filter(|value| value.is_finite()) else { return; };
        if self.count == 0 {
            self.min = value;
            self.max = value;
        } else {
            self.min = self.min.min(value);
            self.max = self.max.max(value);
        }
        self.count += 1;
        self.sum += value;
    }

    /// A metric that never arrived reports a zero count and null values rather
    /// than a fabricated 0 W / 0 °C.
    fn to_json(&self) -> Value {
        if self.count == 0 {
            return json!({"count":0,"min":Value::Null,"mean":Value::Null,"max":Value::Null});
        }
        json!({"count":self.count,"min":self.min,"mean":self.sum / self.count as f64,"max":self.max})
    }
}

fn record_metric_aggregates(stats: &mut [MetricAggregate; AGGREGATE_METRICS.len()], metrics: &Value) {
    for (index, key) in AGGREGATE_METRICS.iter().enumerate() {
        // The sampler calls the core clock `gpuClockMhz`; the report names it
        // `coreClockMhz`, matching the label the UI shows.
        let source = if *key == "coreClockMhz" { "gpuClockMhz" } else { *key };
        stats[index].observe(metrics.get(source).and_then(Value::as_f64));
    }
}

fn metric_stats_json(stats: &[MetricAggregate; AGGREGATE_METRICS.len()]) -> Value {
    let mut out = Map::new();
    for (index, key) in AGGREGATE_METRICS.iter().enumerate() {
        out.insert((*key).into(), stats[index].to_json());
    }
    Value::Object(out)
}

/// Keep the utilization reading *and* the numbers it came from. The scalar is
/// what a reader watches; the per-node tick deltas and the wall interval are
/// what let the next review prove or disprove it without guessing. The raw
/// fields come from the telemetry sample (`gpuUtilWallMs`, `gpuUtilNodes`), so a
/// report produced before those existed simply carries nulls.
fn record_util_diagnostics(state: &mut RunState, data: &Value, normalized: &Value) {
    let raw_sample = data.get("sample").cloned().unwrap_or(Value::Null);
    let util = normalized.get("utilPct").and_then(Value::as_f64)
        .or_else(|| raw_sample.get("gpuUtilPct").and_then(Value::as_f64))
        .filter(|value| value.is_finite());
    if state.util_series.len() < MAX_UTIL_SAMPLES { state.util_series.push(json!(util)); }
    if state.util_samples.len() >= MAX_UTIL_SAMPLES { return; }
    let at_ms = raw_sample.get("t").filter(|value| value.is_number()).cloned()
        .or_else(|| data.get("receivedAtMs").filter(|value| value.is_number()).cloned())
        .or_else(|| normalized.get("sampledAtMs").filter(|value| value.is_number()).cloned())
        .unwrap_or(Value::Null);
    state.util_samples.push(json!({
        "atMs": at_ms,
        "wallMs": raw_sample.get("gpuUtilWallMs").filter(|value| value.is_number()).cloned().unwrap_or(Value::Null),
        "nodes": raw_sample.get("gpuUtilNodes").filter(|value| value.is_array()).cloned().unwrap_or(Value::Null),
    }));
}

/// Per-engine peaks keyed by engine family (`3d`, `copy`, ...). Reference
/// values are reported as measured, never clamped or smoothed.
fn engine_peaks_json(peaks: &std::collections::BTreeMap<String, f64>) -> Value {
    if peaks.is_empty() { return Value::Null; }
    Value::Object(peaks.iter().map(|(name, value)| (name.clone(), json!(value))).collect())
}

/// Per-node peaks keyed by the raw D3DKMT node ordinal, so `7:6` can be traced
/// back to the copy engine node on this driver.
fn node_peaks_json(peaks: &std::collections::BTreeMap<u32, f64>) -> Value {
    if peaks.is_empty() { return Value::Null; }
    Value::Object(peaks.iter().map(|(node, value)| (node.to_string(), json!(value))).collect())
}

#[derive(Clone, Debug)]
struct ResolvedThresholds {
    power_w: f64,
    temperature_c: f64,
    sources: Value,
    fallbacks: Vec<String>,
}

fn resolve_thresholds(inputs: &Value) -> ResolvedThresholds {
    let read = |metric: &str| -> Option<(f64, String)> {
        let row = inputs.get(metric)?;
        let value = finite_positive(row.get("value"))?;
        let source = row.get("source").and_then(Value::as_str)
            .filter(|source| !source.is_empty()).unwrap_or("device-limit").to_owned();
        Some((value, source))
    };
    let power = read("powerW");
    let temperature = read("currentTempC");
    let mut fallbacks = Vec::new();
    let (power_w, power_source) = power.unwrap_or_else(|| {
        fallbacks.push("powerW".to_owned());
        (FALLBACK_POWER_THRESHOLD_W, "fallback-default".to_owned())
    });
    let (temperature_c, temperature_source) = temperature.unwrap_or_else(|| {
        fallbacks.push("currentTempC".to_owned());
        (FALLBACK_TEMPERATURE_THRESHOLD_C, "fallback-default".to_owned())
    });
    ResolvedThresholds {
        power_w,
        temperature_c,
        sources: json!({"powerW":power_source,"currentTempC":temperature_source}),
        fallbacks,
    }
}

fn battlemage_power_reference_w(name: &str) -> Option<f64> {
    let name = name.to_ascii_lowercase();
    if name.contains("b580") { Some(217.0) }
    else if name.contains("b570") { Some(150.0) }
    else if name.contains("b50") { Some(70.0) }
    else if name.contains("battlemage") { Some(217.0) }
    else { None }
}

/// Resolve raw driver state into the same watts/Celsius shown by Tuning.
/// PL1 from Sysman is the first source for cards whose Tuning page displays
/// the `power-limits:read` value; Battlemage's percent-shaped slider is shown
/// in watts using its existing board-power reference.
pub fn device_threshold_inputs(
    target_name: &str,
    settings: &Value,
    power_units: Option<&str>,
    temperature_units: Option<&str>,
    power_limits: &Value,
) -> Value {
    let battlemage_reference = battlemage_power_reference_w(target_name);
    let current_power = finite_positive(settings.get("powerLimitW"));
    let tuning_power = match (current_power, power_units) {
        (Some(value), Some("W")) => Some((value, "current-settings.powerLimitW")),
        (Some(value), Some("%")) if battlemage_reference.is_some() => Some((
            value * battlemage_reference.unwrap_or(217.0) / 100.0,
            "tuning-display.powerLimitW",
        )),
        _ => None,
    };
    let sysman_power = finite_positive(power_limits.get("sustainedW"))
        .map(|value| (value, "power-limits:read.sustainedW"));
    let selected_power = if battlemage_reference.is_some() {
        tuning_power.or(sysman_power)
    } else {
        sysman_power.or(tuning_power)
    };
    let current_temperature = finite_positive(settings.get("tempLimitC"));
    let temperature = match (current_temperature, temperature_units) {
        (Some(value), Some("C")) => Some((value, "current-settings.tempLimitC")),
        (Some(value), Some("%")) if battlemage_reference.is_some() => Some((value, "tuning-display.tempLimitC")),
        _ => None,
    };
    json!({
        "powerW":selected_power.map(|(value, source)| json!({"value":value,"source":source})),
        "currentTempC":temperature.map(|(value, source)| json!({"value":value,"source":source})),
    })
}

/// The tuning snapshot stores the driver's raw value under a unit-named key:
/// `powerLimitW` holds whatever the OC control reports, and on Battlemage that
/// is a percentage of the board reference power, so 100 means 100 %, not 100 W.
/// Annotate the snapshot with the real units and, when the reference is known,
/// the derived watts, so a persisted report cannot be misread. The raw value is
/// left untouched for every other consumer, and the verdict path already
/// converts through `device_threshold_inputs`.
pub fn snapshot_unit_fields(target_name: &str, settings: &Value, units: &Value) -> Value {
    let power_units = units.get("powerLimitW").and_then(Value::as_str).filter(|units| !units.is_empty());
    let temperature_units = units.get("tempLimitC").and_then(Value::as_str).filter(|units| !units.is_empty());
    let mut fields = Map::new();
    if let Some(units) = power_units { fields.insert("powerLimitUnits".into(), json!(units)); }
    if let Some(units) = temperature_units { fields.insert("tempLimitUnits".into(), json!(units)); }
    if power_units == Some("%") {
        // Only a known board reference can be turned into watts; an unknown
        // adapter keeps the percentage and gets no invented number.
        if let Some(reference) = battlemage_power_reference_w(target_name) {
            if let Some(percent) = finite_positive(settings.get("powerLimitW")) {
                fields.insert("powerLimitWatts".into(), json!(percent * reference / 100.0));
            }
        }
    }
    Value::Object(fields)
}

impl StabilityRuntime {
    pub fn new(deps: StabilityRuntimeDeps) -> Self {
        Self { inner: Arc::new(RuntimeInner {
            resolve_target: deps.resolve_target,
            sample_target: deps.sample_target,
            engine_detail: deps.engine_detail,
            settings_snapshot: deps.settings_snapshot,
            ensure_telemetry: deps.ensure_telemetry,
            workload: deps.workload,
            whea: deps.whea,
            reports: deps.reports,
            emit: deps.emit,
            clock: deps.clock,
            sleeper: deps.sleeper,
            spawner: deps.spawner,
            active: Mutex::new(None),
        }) }
    }

    pub fn handles(channel: &str) -> bool {
        matches!(channel, "stability-run-start" | "stability-run-status" | "stability-run-cancel")
    }

    pub fn should_handle(channel: &str, mock_mode: bool) -> bool {
        !mock_mode && Self::handles(channel)
    }

    pub fn handle(&self, channel: &str, args: &Value) -> Result<Value, String> {
        match channel {
            "stability-run-start" => self.start(&start_payload(channel, args)?),
            "stability-run-status" => Ok(self.status(run_id_arg(channel, args)?.as_deref()).unwrap_or(Value::Null)),
            "stability-run-cancel" => Ok(self.cancel(run_id_arg(channel, args)?.as_deref())),
            _ => Err("Unknown Stability Lab channel".into()),
        }
    }

    pub fn start(&self, payload: &Value) -> Result<Value, String> {
        if self.inner.active.lock().map(|slot| slot.is_some()).unwrap_or(true) {
            return Err(ALREADY_ACTIVE.into());
        }
        let request = normalize_stability_request(payload)?;
        let device_key = request["deviceKey"].as_str().ok_or("stability request requires a stable device key")?.to_owned();
        let cadence_ms = request["cadenceMs"].as_u64().ok_or("stability cadence or duration is invalid")? as u32;
        let duration_sec = request["durationSec"].as_u64().ok_or("stability cadence or duration is invalid")? as u32;

        let (run, immediate_unavailable) = {
            let mut slot = self.inner.active.lock().map_err(|_| "Stability Lab lock failed")?;
            if slot.is_some() { return Err(ALREADY_ACTIVE.into()); }
            let resolved = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
                || (self.inner.resolve_target)(&device_key))).ok().flatten();
            let missing_target = resolved.is_none();
            let (target_snapshot, immediate_unavailable) = match resolved {
                Some(target) => {
                    let resolved_key = normalize_stable_device_key(target.get("deviceKey").unwrap_or(&Value::Null));
                    let mut snapshot = if target.is_object() { target.clone() } else { json!({}) };
                    if !snapshot.is_object() { snapshot = json!({}); }
                    snapshot["id"] = target.get("id").and_then(Value::as_i64).map(|id| json!(id)).unwrap_or(Value::Null);
                    snapshot["deviceKey"] = json!(resolved_key.clone().unwrap_or_else(|| device_key.clone()));
                    snapshot["name"] = target.get("name").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null);
                    let unavailable = !target_has_key(&target, &device_key);
                    (snapshot, unavailable)
                }
                None => (json!({"id":Value::Null,"deviceKey":device_key.clone(),"name":Value::Null}), true),
            };
            let immediate_unavailable = missing_target || immediate_unavailable;
            let started_ms = self.inner.clock.now_ms();
            let started_at = self.inner.clock.now_iso();
            let thresholds = resolve_thresholds(&Value::Null);
            let limits = stress_limits(&target_snapshot, &thresholds);
            let run = Arc::new(Run {
                id: new_run_id(),
                tick: Mutex::new(()),
                state: Mutex::new(RunState {
                    state: "running",
                    target: target_snapshot,
                    cadence_ms,
                    duration_sec,
                    started_ms,
                    started_at,
                    ended_at: None,
                    settings_snapshot: json!({}),
                    sample_count: 0,
                    fresh_sample_count: 0,
                    foreground_count: 0,
                    present_evidence_count: 0,
                    util_evidence_count: 0,
                    missing_metrics: Vec::new(),
                    threshold_breaches: 0,
                    thresholds: Vec::new(),
                    threshold_power_w: thresholds.power_w,
                    threshold_temperature_c: thresholds.temperature_c,
                    threshold_sources: thresholds.sources,
                    threshold_fallbacks: thresholds.fallbacks,
                    driver_error_count: 0,
                    metrics: empty_metrics(),
                    limits,
                    whea: initial_whea(self.inner.whea.is_some()),
                    whea_baseline_count: 0.0,
                    workload_active: false,
                    workload_status: if self.inner.workload.is_some() { "starting" } else { "monitor-only" },
                    workload_reason: None,
                    workload_submits: 0,
                    workload_errors: 0,
                    workload_error: None,
                    workload_thread_finished: None,
                    workload_adapter_luid: None,
                    engine_peaks: std::collections::BTreeMap::new(),
                    node_peaks: std::collections::BTreeMap::new(),
                    metric_stats: [MetricAggregate::default(); AGGREGATE_METRICS.len()],
                    util_series: Vec::new(),
                    util_samples: Vec::new(),
                    telemetry_status: "starting",
                    telemetry_reason: None,
                    vram_target_bytes: None,
                    vram_allocated_bytes: None,
                    vram_allocation_complete: None,
                    abort_reason: None,
                    abort_details: Value::Null,
                    outcome: None,
                    reason: None,
                    finished: false,
                    report: None,
                }),
            });
            *slot = Some(run.clone());
            (run, immediate_unavailable)
        };

        if immediate_unavailable {
            return Ok(self.inner.finish(&run, "unavailable", Some(IMMEDIATE_UNAVAILABLE.into())));
        }

        // Setup shares the tick gate with cancellation so a run cancelled
        // while the adapter/settings/WHEA/workload are opening cannot leak a
        // workload or a WHEA poll thread that finish already looked past.
        let setup = run.tick.lock().map_err(|_| "Stability Lab lock failed")?;
        if run.state.lock().map(|state| state.finished).unwrap_or(true) {
            return Ok(self.inner.status_of(&run));
        }
        let target = self.inner.target_of(&run);
        let settings = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || (self.inner.settings_snapshot)(&target))).unwrap_or(Value::Null);
        let settings = if settings.is_object() { settings } else { json!({}) };
        let thresholds = resolve_thresholds(settings.get("stabilityThresholdInputs").unwrap_or(&Value::Null));
        let settings = settings.as_object().cloned().map(|mut settings| {
            settings.remove("stabilityThresholdInputs");
            Value::Object(settings)
        }).unwrap_or_else(|| json!({}));
        let limits = stress_limits(&target, &thresholds);
        if let Ok(mut state) = run.state.lock() {
            state.settings_snapshot = settings;
            state.threshold_power_w = thresholds.power_w;
            state.threshold_temperature_c = thresholds.temperature_c;
            state.threshold_sources = thresholds.sources;
            state.threshold_fallbacks = thresholds.fallbacks;
            state.limits = limits;
        }

        let telemetry_result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || (self.inner.ensure_telemetry)(&target)))
            .unwrap_or_else(|_| Err("main telemetry lane could not be started".into()));
        let telemetry_available = telemetry_result.is_ok();
        if let Ok(mut state) = run.state.lock() {
            match telemetry_result {
                Ok(()) => state.telemetry_status = "running",
                Err(error) => {
                    state.telemetry_status = "unavailable";
                    state.telemetry_reason = Some(error_limit(&error));
                    push_missing(&mut state.missing_metrics, "telemetry");
                }
            }
        }

        let started_ms = run.state.lock().map(|state| state.started_ms).unwrap_or(0.0);
        let mut setup_abort = None;
        if let Some(whea) = self.inner.whea.as_ref() {
            let update = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| whea.start(started_ms))) {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => json!({"available":false,"checked":true,"error":error_limit(&error)}),
                Err(_) => json!({"available":false,"checked":true,"error":"WHEA monitor failed"}),
            };
            if let Ok(mut state) = run.state.lock() {
                state.whea = merge_objects(&state.whea, &update);
                let count = whea_error_count(&state.whea);
                state.whea_baseline_count = update.get("baselineErrorCount")
                    .and_then(Value::as_f64).filter(|value| value.is_finite()).unwrap_or(0.0).max(0.0);
                if count > state.whea_baseline_count {
                    setup_abort = Some("whea");
                    state.abort_reason = Some("whea".into());
                    state.abort_details = json!({"wheaErrorCount":count,"wheaDelta":count-state.whea_baseline_count,
                        "whea":state.whea.clone()});
                }
            }
        }

        if setup_abort.is_none() {
            if !telemetry_available {
                if let Ok(mut state) = run.state.lock() {
                    if self.inner.workload.is_some() {
                        state.workload_status = "unavailable";
                        state.workload_reason = state.telemetry_reason.clone();
                    }
                }
            } else if let Some(workload) = self.inner.workload.as_ref() {
                let update = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| workload.start(&target)))
                    .unwrap_or_else(|_| Err("stability workload failed".into()));
                if let Ok(mut state) = run.state.lock() {
                    if let Ok(value) = &update {
                        if let Some(allocation) = value.get("allocation").filter(|value| value.is_object()) {
                            state.vram_target_bytes = allocation.get("targetBytes").and_then(Value::as_u64);
                            state.vram_allocated_bytes = allocation.get("allocatedBytes").and_then(Value::as_u64);
                            state.vram_allocation_complete = allocation.get("complete").and_then(Value::as_bool);
                        }
                    }
                    match update {
                        Ok(value) if value.get("started") == Some(&Value::Bool(true)) => {
                            state.workload_active = true;
                            state.workload_status = if state.vram_allocation_complete == Some(false) { "partial" } else { "running" };
                            state.workload_adapter_luid = value.get("adapterLuid").and_then(Value::as_str).map(str::to_owned);
                            if state.workload_status == "partial" {
                                state.workload_reason = value.get("allocation").and_then(|allocation| allocation.get("reason"))
                                    .and_then(Value::as_str).map(str::to_owned);
                            }
                        }
                        Ok(value) => {
                            state.workload_status = "unavailable";
                            let reason = value.get("reason").and_then(Value::as_str).map(str::to_owned)
                                .or_else(|| value.get("allocation").and_then(|allocation| allocation.get("reason"))
                                    .and_then(Value::as_str).map(str::to_owned))
                                .unwrap_or_else(|| "the selected GPU workload could not be started".into());
                            state.workload_reason = Some(reason.clone());
                            state.workload_errors += 1;
                            state.workload_error = Some(reason);
                        }
                        Err(error) => {
                            state.workload_status = "unavailable";
                            let reason = error_limit(&error);
                            state.workload_reason = Some(reason.clone());
                            state.workload_errors += 1;
                            state.workload_error = Some(reason);
                        }
                    }
                }
            }
        }

        if let Some(reason) = setup_abort {
            drop(setup);
            self.inner.finish(&run, "aborted", Some(reason.into()));
            return Ok(self.inner.status_of(&run));
        }
        self.inner.publish(&run);
        drop(setup);
        let inner = self.inner.clone();
        let loop_run = run.clone();
        if let Err(error) = self.inner.spawner.spawn(Box::new(move || run_loop(inner, loop_run))) {
            return Ok(self.inner.finish(&run, "unavailable", Some(format!("stability run could not start: {error}"))));
        }
        Ok(self.inner.status_of(&run))
    }

    pub fn status(&self, run_id: Option<&str>) -> Option<Value> {
        let run = self.inner.active.lock().ok().and_then(|slot| slot.clone())?;
        if run_id.is_some_and(|id| !id.is_empty() && id != run.id) { return None; }
        Some(self.inner.status_of(&run))
    }

    pub fn cancel(&self, run_id: Option<&str>) -> Value {
        let Some(run) = self.inner.active.lock().ok().and_then(|slot| slot.clone()) else { return Value::Null; };
        if run_id.is_some_and(|id| !id.is_empty() && id != run.id) { return self.inner.status_of(&run); }
        self.inner.finish(&run, "cancelled", Some("cancelled by user".into()))
    }

    pub fn shutdown(&self) {
        if let Some(run) = self.inner.active.lock().ok().and_then(|slot| slot.clone()) {
            let _ = self.inner.finish(&run, "cancelled", Some("application shutdown".into()));
        }
    }
}

fn target_has_key(target: &Value, device_key: &str) -> bool {
    target.get("deviceKey").and_then(Value::as_str) == Some(device_key)
        || target.get("deviceKeys").and_then(Value::as_array)
            .is_some_and(|keys| keys.iter().any(|key| key.as_str() == Some(device_key)))
}

fn record_threshold(state: &mut RunState, metric: &str, value: f64, limit: f64) {
    if !value.is_finite() || !limit.is_finite() { return; }
    let observation = json!({"metric":metric,"value":value,"limit":limit});
    if let Some(existing) = state.thresholds.iter_mut()
        .find(|existing| existing.get("metric").and_then(Value::as_str) == Some(metric)) {
        *existing = observation;
    } else {
        state.thresholds.push(observation);
    }
}

impl RuntimeInner {
    fn target_of(&self, run: &Arc<Run>) -> Value {
        run.state.lock().map(|state| state.target.clone()).unwrap_or(Value::Null)
    }

    fn status_of(&self, run: &Arc<Run>) -> Value {
        let workload = self.workload.as_ref().and_then(|workload| {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| workload.status())).ok()
        }).unwrap_or(Value::Null);
        let Ok(state) = run.state.lock() else { return Value::Null; };
        let evidence = workload_evidence_of(&state.counters());
        let workload_submits = workload.get("workloadSubmits").and_then(Value::as_u64)
            .unwrap_or(state.workload_submits).max(state.workload_submits);
        let workload_errors = workload.get("workloadErrors").and_then(Value::as_u64)
            .unwrap_or(state.workload_errors).max(state.workload_errors);
        let workload_error = workload.get("workloadError").and_then(Value::as_str)
            .filter(|error| !error.is_empty()).map(str::to_owned).or_else(|| state.workload_error.clone());
        let workload_thread_finished = workload.get("workloadThreadFinished").and_then(Value::as_bool)
            .or(state.workload_thread_finished);
        json!({
            "runId":run.id,
            "state":state.state,
            "target":state.target.clone(),
            "effectiveCadenceMs":state.cadence_ms,
            "effectiveDurationSec":state.duration_sec,
            "sampleCount":state.sample_count,
            "freshSampleCount":state.fresh_sample_count,
            "missingMetrics":state.missing_metrics.clone(),
            "workloadEvidence":evidence,
            "foregroundCount":state.foreground_count,
            "presentEvidenceCount":state.present_evidence_count,
            "utilEvidenceCount":state.util_evidence_count,
            "workloadActive":state.workload_active,
            "workloadStatus":state.workload_status,
            "workloadReason":state.workload_reason.clone(),
            "workloadSubmits":workload_submits,
            "workloadErrors":workload_errors,
            "workloadError":workload_error,
            "workloadThreadFinished":workload_thread_finished,
            "workloadAdapterLuid":state.workload_adapter_luid.clone(),
            "thresholdBreaches":state.threshold_breaches,
            "thresholds":state.thresholds.clone(),
            "thresholdLimits":{"powerW":state.threshold_power_w,"currentTempC":state.threshold_temperature_c},
            "thresholdSources":state.threshold_sources.clone(),
            "thresholdFallback":!state.threshold_fallbacks.is_empty(),
            "thresholdFallbacks":state.threshold_fallbacks.clone(),
            "telemetryStatus":state.telemetry_status,
            "telemetryReason":state.telemetry_reason.clone(),
            "vramTargetBytes":state.vram_target_bytes,
            "vramAllocatedBytes":state.vram_allocated_bytes,
            "vramAllocationComplete":state.vram_allocation_complete,
            "abortReason":state.abort_reason.clone(),
            "abortDetails":state.abort_details.clone(),
            "metrics":state.metrics.clone(),
            "limits":state.limits.clone(),
            "whea":state.whea.clone(),
            "outcome":state.outcome,
            "reason":state.reason.clone(),
            "startedAt":state.started_at.clone(),
            "endedAt":state.ended_at.clone(),
        })
    }

    fn publish(&self, run: &Arc<Run>) {
        let status = self.status_of(run);
        if status.is_null() { return; }
        let emit = &self.emit;
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| emit(&status)));
    }

    fn tick_body(&self, run: &Arc<Run>) -> TickOutcome {
        let _tick = match run.tick.lock() { Ok(guard) => guard, Err(_) => return TickOutcome::Stop };
        let (finished, started_ms, duration_sec, cadence_ms, device_key) = {
            let Ok(state) = run.state.lock() else { return TickOutcome::Stop; };
            if state.finished { return TickOutcome::Stop; }
            let Some(device_key) = state.target.get("deviceKey").and_then(Value::as_str).map(str::to_owned) else {
                return TickOutcome::Finish("unavailable", Some(IMMEDIATE_UNAVAILABLE.into()));
            };
            (state.finished, state.started_ms, state.duration_sec, state.cadence_ms, device_key)
        };
        if finished { return TickOutcome::Stop; }
        let now = self.clock.now_ms();
        if now - started_ms >= duration_sec as f64 * 1000.0 {
            let whea = self.whea.as_ref().map(|whea| whea.snapshot()).unwrap_or_else(|| json!({}));
            let abort = if let Ok(mut state) = run.state.lock() {
                state.whea = merge_objects(&state.whea, &whea);
                let count = whea_error_count(&state.whea);
                let delta = (count - state.whea_baseline_count).max(0.0);
                let abort = abort_reason_for(None, delta);
                if let Some(reason) = abort {
                    state.abort_reason = Some(reason.into());
                    state.abort_details = json!({"wheaErrorCount":count,"wheaDelta":delta,"whea":state.whea.clone()});
                }
                abort
            } else { None };
            return abort.map(|reason| TickOutcome::Finish("aborted", Some(reason.into())))
                .unwrap_or(TickOutcome::Finish("completed", None));
        }

        let Some(live) = (self.resolve_target)(&device_key) else {
            return TickOutcome::Finish("unavailable", Some(DEVICE_CHANGED.into()));
        };
        if !target_has_key(&live, &device_key) {
            return TickOutcome::Finish("unavailable", Some(DEVICE_CHANGED.into()));
        }
        let target = {
            let Ok(mut state) = run.state.lock() else { return TickOutcome::Stop; };
            let mut target = state.target.clone();
            if !target.is_object() { target = json!({}); }
            target["id"] = live.get("id").and_then(Value::as_i64).map(|id| json!(id)).unwrap_or(Value::Null);
            target["name"] = live.get("name").filter(|value| !value.is_null()).cloned()
                .or_else(|| state.target.get("name").filter(|value| !value.is_null()).cloned())
                .unwrap_or(Value::Null);
            target["deviceKey"] = json!(device_key);
            state.target = target.clone();
            target
        };

        let data = (self.sample_target)(&target);
        let engine_detail = std::panic::catch_unwind(std::panic::AssertUnwindSafe(
            || (self.engine_detail)(&target))).unwrap_or(Value::Null);
        let received_ms = self.clock.now_ms();
        let contract_clock = ContractClock { ms: received_ms, iso: self.clock.now_iso() };
        let normalized = normalize_stability_sample(&data, Some(&json!(received_ms)), &contract_clock)
            .unwrap_or_else(|error| fallback_sample(received_ms, &error));

        let whea = self.whea.as_ref().map(|whea| whea.snapshot()).unwrap_or_else(|| json!({}));
        let mut abort_reason = None;
        if let Ok(mut state) = run.state.lock() {
            let source = normalized.get("sample").cloned().unwrap_or_else(|| json!({}));
            let metrics = metrics_of(&source, &normalized);
            state.metrics = metrics.clone();
            {
                // One `deref_mut` for both maps: two field borrows through the
                // guard would be rejected as overlapping.
                let RunState { engine_peaks, node_peaks, metric_stats, .. } = &mut *state;
                record_engine_peaks(engine_peaks, node_peaks, &engine_detail);
                record_metric_aggregates(metric_stats, &metrics);
            }
            record_util_diagnostics(&mut state, &data, &normalized);
            state.whea = merge_objects(&state.whea, &whea);
            state.sample_count += 1;
            let read_error = normalized.get("readError").and_then(Value::as_str).filter(|text| !text.is_empty());
            let received = normalized.get("sampledAtMs").and_then(Value::as_f64).unwrap_or(received_ms);
            let age = (received_ms - received).max(0.0);
            if read_error.is_none() && age <= 1000.0f64.max(cadence_ms as f64 * 2.5) { state.fresh_sample_count += 1; }
            if normalized.get("foreground") == Some(&Value::Bool(true)) { state.foreground_count += 1; }
            if normalized.get("present") == Some(&Value::Bool(true)) { state.present_evidence_count += 1; }
            if normalized.get("utilPct").and_then(Value::as_f64).is_some_and(|value| value >= 10.0) {
                state.util_evidence_count += 1;
            }
            if read_error.is_some() { push_missing(&mut state.missing_metrics, "telemetry"); }
            if normalized.get("temperatureC").is_none_or(|value| value.is_null()) { push_missing(&mut state.missing_metrics, "temperature"); }
            if normalized.get("powerW").is_none_or(|value| value.is_null()) { push_missing(&mut state.missing_metrics, "power"); }
            if normalized.get("driverError") == Some(&Value::Bool(true)) { state.driver_error_count += 1; }
            let temperature = normalized.get("temperatureC").and_then(Value::as_f64);
            let power = normalized.get("powerW").and_then(Value::as_f64);
            let thermal_limit = state.threshold_temperature_c;
            let power_limit = state.threshold_power_w;
            if thermal_limit.is_finite() && temperature.is_some_and(|value| value > thermal_limit) {
                state.threshold_breaches += 1;
                if let Some(value) = temperature { record_threshold(&mut state, "tempC", value, thermal_limit); }
            }
            if power_limit.is_finite() && power.is_some_and(|value| value > power_limit) {
                state.threshold_breaches += 1;
                if let Some(value) = power { record_threshold(&mut state, "powerW", value, power_limit); }
            }
            let whea_count = whea_error_count(&state.whea);
            let whea_delta = (whea_count - state.whea_baseline_count).max(0.0);
            abort_reason = abort_reason_for(temperature, whea_delta);
            if let Some(reason) = abort_reason {
                state.abort_reason = Some(reason.into());
                state.abort_details = match reason {
                    "gpu-temperature" => json!({"temperatureC":temperature,"wheaErrorCount":whea_error_count(&state.whea),
                        "whea":state.whea.clone()}),
                    "whea" => json!({"wheaErrorCount":whea_count,"wheaDelta":whea_delta,"whea":state.whea.clone()}),
                    _ => Value::Null,
                };
            }
        }
        self.publish(run);
        if let Some(reason) = abort_reason {
            return TickOutcome::Finish("aborted", Some(reason.into()));
        }
        let ended = self.clock.now_ms();
        if ended - started_ms >= duration_sec as f64 * 1000.0 { TickOutcome::Finish("completed", None) }
        else { TickOutcome::Continue }
    }

    fn finish(&self, run: &Arc<Run>, outcome: &'static str, reason: Option<String>) -> Value {
        let _tick = match run.tick.lock() { Ok(guard) => guard, Err(_) => return Value::Null };
        let latest_whea = self.whea.as_ref().map(|whea| whea.snapshot()).unwrap_or_else(|| json!({}));
        {
            let Ok(mut state) = run.state.lock() else { return Value::Null; };
            if state.finished { return state.report.clone().unwrap_or(Value::Null); }
            state.whea = merge_objects(&state.whea, &latest_whea);
            state.finished = true;
            state.state = if outcome == "aborted" { "aborted" } else { "completed" };
            state.outcome = Some(outcome);
            state.reason = reason;
            if outcome == "aborted" && state.abort_reason.is_none() {
                state.abort_reason = state.reason.clone();
            }
            state.ended_at = Some(self.clock.now_iso());
        }

        let _whea_stop = match self.whea.as_ref() {
            Some(whea) => match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| whea.stop())) {
                Ok(Ok(value)) => value,
                Ok(Err(error)) => json!({"available":false,"checked":true,"error":error_limit(&error)}),
                Err(_) => json!({"available":false,"checked":true,"error":"WHEA monitor failed"}),
            },
            None => json!({}),
        };
        let report = {
            let Ok(mut state) = run.state.lock() else { return Value::Null; };
            let whea_count = whea_error_count(&state.whea);
            let whea_delta = (whea_count - state.whea_baseline_count).max(0.0);
            // Read (not stop) the workload counters before the report is built:
            // the cleanup stop happens after persistence by design, and these
            // counters are the offline proof that the 3-D path really executed.
            let workload_snapshot = self.workload.as_ref()
                .map(|workload| std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| workload.status())))
                .and_then(Result::ok).unwrap_or(Value::Null);
            if outcome != "aborted" {
                state.reason = append_whea_reason(state.reason.clone(), whea_delta);
            }
            let verdict = classify_stability_run(&json!({
                "sampleCount":state.sample_count,
                "freshSampleCount":state.fresh_sample_count,
                "missingMetrics":state.missing_metrics.clone(),
                "workloadActive":state.workload_active,
                "foregroundCount":state.foreground_count,
                "presentEvidenceCount":state.present_evidence_count,
                "utilEvidenceCount":state.util_evidence_count,
                "driverErrorCount":state.driver_error_count,
                "thresholdBreaches":state.threshold_breaches,
                "thresholds":state.thresholds.clone(),
                "wheaErrorCount":whea_count,
                "allocationComplete":state.vram_allocation_complete,
                "outcomeHint":outcome,
                "cancelled":outcome=="cancelled",
                "aborted":outcome=="aborted",
                "unavailable":outcome=="unavailable",
            }));
            let report_input = json!({
                "runId":run.id,
                "target":state.target.clone(),
                "settingsSnapshot":state.settings_snapshot.clone(),
                "sampleCount":state.sample_count,
                "freshSampleCount":state.fresh_sample_count,
                "missingMetrics":state.missing_metrics.clone(),
                "workloadEvidence":verdict["workloadEvidence"],
                "outcome":verdict["outcome"],
                "effectiveCadenceMs":state.cadence_ms,
                "effectiveDurationSec":state.duration_sec,
                "startedAt":state.started_at.clone(),
                "endedAt":state.ended_at.clone(),
                "reason":state.reason.clone(),
                "abortReason":state.abort_reason.clone(),
                "abortDetails":state.abort_details.clone(),
                "thresholdBreaches":state.threshold_breaches,
                "thresholds":state.thresholds.clone(),
                "thresholdLimits":{"powerW":state.threshold_power_w,"currentTempC":state.threshold_temperature_c},
                "thresholdSources":state.threshold_sources.clone(),
                "thresholdFallback":!state.threshold_fallbacks.is_empty(),
                "thresholdFallbacks":state.threshold_fallbacks.clone(),
                "driverErrorCount":state.driver_error_count,
                "wheaErrorCount":whea_count,
                "vramTargetBytes":state.vram_target_bytes,
                "vramAllocatedBytes":state.vram_allocated_bytes,
                "vramAllocationComplete":state.vram_allocation_complete,
                // Offline review of a finished run: what the card actually did,
                // not only whether the verdict found a breach.
                "metricStats":metric_stats_json(&state.metric_stats),
                "enginePeaks":engine_peaks_json(&state.engine_peaks),
                "nodePeaks":node_peaks_json(&state.node_peaks),
                // The diagnostic trail: one utilization float per sample, and
                // per sample the wall interval plus every node's raw tick delta.
                "utilSeries":Value::Array(state.util_series.clone()),
                "utilSamples":Value::Array(state.util_samples.clone()),
                // Workload counters were log-only; the report has to stand on
                // its own or the next review needs the console again.
                "workloadSubmits":workload_snapshot.get("workloadSubmits").and_then(Value::as_u64).unwrap_or(0),
                "workloadDraws":workload_snapshot.get("workloadDraws").and_then(Value::as_u64).unwrap_or(0),
                "workloadCopies":workload_snapshot.get("workloadCopies").and_then(Value::as_u64).unwrap_or(0),
            });
            let clock = ContractClock { ms:self.clock.now_ms(), iso:self.clock.now_iso() };
            let report = normalize_stability_report(&report_input, &clock).ok().flatten().unwrap_or(Value::Null);
            state.report = Some(report.clone());
            report
        };

        let append_error = if report.is_null() {
            Some("Invalid stability report".to_owned())
        } else {
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.reports.append(&report)))
                .unwrap_or_else(|_| Err("report store failed".into())).err()
        };
        if let Some(error) = append_error {
            if let Ok(mut state) = run.state.lock() {
                state.reason = append_reason(state.reason.clone(), &format!("report persistence failed: {error}"));
            }
        }

        let mut cleanup_error = None;
        let mut workload_draws = 0u64;
        let mut workload_copies = 0u64;
        if let Some(workload) = self.workload.as_ref() {
            let stopped = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| workload.stop()))
                .unwrap_or_else(|_| Err("stability workload failed".into()));
            if let Err(error) = stopped { cleanup_error = Some(error); }
            let diagnostics = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| workload.status()))
                .unwrap_or(Value::Null);
            workload_draws = diagnostics.get("workloadDraws").and_then(Value::as_u64).unwrap_or(0);
            workload_copies = diagnostics.get("workloadCopies").and_then(Value::as_u64).unwrap_or(0);
            if let Ok(mut state) = run.state.lock() {
                state.workload_submits = state.workload_submits.max(
                    diagnostics.get("workloadSubmits").and_then(Value::as_u64).unwrap_or(0));
                state.workload_errors = state.workload_errors.max(
                    diagnostics.get("workloadErrors").and_then(Value::as_u64).unwrap_or(0));
                state.workload_error = diagnostics.get("workloadError").and_then(Value::as_str)
                    .filter(|error| !error.is_empty()).map(str::to_owned).or_else(|| state.workload_error.clone());
                state.workload_thread_finished = diagnostics.get("workloadThreadFinished").and_then(Value::as_bool)
                    .or(state.workload_thread_finished);
                if let Some(error) = &cleanup_error {
                    state.workload_errors += 1;
                    state.workload_error = Some(format!("GPU workload cleanup failed: {error}"));
                    state.workload_reason = append_reason(state.workload_reason.clone(), &format!("GPU workload cleanup failed: {error}"));
                }
            }
        }
        let (workload_submits, workload_errors, workload_thread_finished, workload_error, engine_summary, node_summary) =
            run.state.lock().map(|state| (
                state.workload_submits, state.workload_errors, state.workload_thread_finished.unwrap_or(false),
                state.workload_error.clone(), engine_peak_summary(&state.engine_peaks), node_peak_summary(&state.node_peaks)))
            .unwrap_or_else(|_| (0, 0, false, None, String::new(), String::new()));
        let error_suffix = workload_error.map(|error| {
            let line = error.replace('\r', " ").replace('\n', " ").replace('"', "'");
            format!(" error=\"{line}\"")
        }).unwrap_or_default();
        // Engine detail is diagnostic only: `nodes=` is the peak per engine
        // family for the stressed adapter and `d3dNodes=` the raw D3DKMT node
        // ordinals, so a copy-bound run is visible without a debugger.
        let engine_suffix = if engine_summary.is_empty() { String::new() } else { format!(" nodes={engine_summary}") };
        let node_suffix = if node_summary.is_empty() { String::new() } else { format!(" d3dNodes={node_summary}") };
        eprintln!("[stability] runId={} submits={} errors={} threadFinished={} draws={} copies={}{}{}{}", run.id,
            workload_submits, workload_errors, workload_thread_finished, workload_draws, workload_copies,
            engine_suffix, node_suffix, error_suffix);

        self.publish(run);
        if let Ok(mut slot) = self.active.lock() {
            if slot.as_ref().is_some_and(|active| Arc::ptr_eq(active, run)) { *slot = None; }
        }
        report
    }
}

enum TickOutcome {
    Continue,
    Stop,
    Finish(&'static str, Option<String>),
}

fn run_loop(inner: Arc<RuntimeInner>, run: Arc<Run>) {
    loop {
        if run.state.lock().map(|state| state.finished).unwrap_or(true) { return; }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| inner.tick_body(&run)));
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(_) => TickOutcome::Finish("unavailable", Some("stability sampling failed".into())),
        };
        match outcome {
            TickOutcome::Continue => {}
            TickOutcome::Stop => return,
            TickOutcome::Finish(outcome, reason) => { inner.finish(&run, outcome, reason); return; }
        }
        let cadence = run.state.lock().map(|state| state.cadence_ms).unwrap_or(STABILITY_CADENCE_DEFAULT_MS) as u64;
        let mut remaining = cadence;
        while remaining > 0 {
            if run.state.lock().map(|state| state.finished).unwrap_or(true) { return; }
            let step = remaining.min(25);
            inner.sleeper.sleep(Duration::from_millis(step));
            remaining -= step;
        }
    }
}

struct ContractClock { ms: f64, iso: String }
impl StabilityClock for ContractClock {
    fn now_ms(&self) -> f64 { self.ms }
    fn now_iso(&self) -> &str { &self.iso }
}

fn start_payload(channel: &str, args: &Value) -> Result<Value, String> {
    let WireValue::Array(items) = wire::decode(args)? else { return Err("Expected argument array".into()); };
    if items.len() > 1 { return Err(format!("{channel} takes one payload")); }
    match items.into_iter().next() {
        None | Some(WireValue::Undefined) => Ok(json!({})),
        Some(value) => value.into_json(),
    }
}

fn run_id_arg(channel: &str, args: &Value) -> Result<Option<String>, String> {
    let WireValue::Array(items) = wire::decode(args)? else { return Err("Expected argument array".into()); };
    if items.len() > 1 { return Err(format!("{channel} takes at most one run id")); }
    match items.into_iter().next() {
        None | Some(WireValue::Undefined) | Some(WireValue::Null) => Ok(None),
        Some(WireValue::String(value)) => Ok(Some(value)),
        Some(_) => Err(format!("{channel}: run id must be a string")),
    }
}

pub fn match_device_by_key(devices: &[Value], device_key: &str) -> Option<Value> {
    let matches: Vec<&Value> = devices.iter().filter(|device| {
        device.get("deviceKey").and_then(Value::as_str) == Some(device_key)
            || device.get("deviceKeys").and_then(Value::as_array)
                .is_some_and(|keys| keys.iter().any(|key| key.as_str() == Some(device_key)))
    }).collect();
    (matches.len() == 1).then(|| matches[0].clone())
}

fn new_run_id() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!("{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15])
}

fn initial_whea(available: bool) -> Value {
    json!({
        "available":available,
        "checked":false,
        "errorCount":0,
        "baselineErrorCount":0,
        "error":if available { Value::Null } else { json!(WHEA_UNAVAILABLE) },
        "lastCheckedAt":Value::Null,
    })
}

fn abort_reason_for(temperature_c: Option<f64>, whea_error_count: f64) -> Option<&'static str> {
    if temperature_c.is_some_and(|temperature| temperature >= 90.0) {
        Some("gpu-temperature")
    } else if whea_error_count > 0.0 {
        Some("whea")
    } else {
        None
    }
}

fn empty_metrics() -> Value {
    json!({
        "gpuClockMhz":Value::Null,"vramClockMhz":Value::Null,"powerW":Value::Null,"fanRpm":Value::Null,
        "currentTempC":Value::Null,"vramTempC":Value::Null,"gpuUtilPct":Value::Null,"vramUsedBytes":Value::Null,
    })
}

fn finite_positive(value: Option<&Value>) -> Option<f64> {
    let number = js_number(value);
    (number.is_finite() && number > 0.0).then_some(number)
}

fn stress_limits(target: &Value, thresholds: &ResolvedThresholds) -> Value {
    let graphics_clock = finite_positive(target.get("graphicsClockMHz"));
    let vram_bytes = finite_positive(target.get("vramBytes"));
    json!({
        "gpuClockMhz":3000.0f64.max(graphics_clock.map(|clock| clock * 1.25).unwrap_or(0.0)),
        "vramClockMhz":3000.0,
        "powerW":thresholds.power_w,
        "fanRpm":3000.0,
        "vramTempC":100.0,
        "currentTempC":thresholds.temperature_c,
        "gpuUtilPct":100.0,
        "vramUsedBytes":vram_bytes.unwrap_or(8.0 * 1024.0 * 1024.0 * 1024.0),
    })
}

fn merge_objects(base: &Value, update: &Value) -> Value {
    let mut result = base.as_object().cloned().unwrap_or_else(Map::new);
    if let Some(update) = update.as_object() {
        for (key, value) in update { result.insert(key.clone(), value.clone()); }
    }
    Value::Object(result)
}

fn append_reason(base: Option<String>, extra: &str) -> Option<String> {
    let base = base.filter(|text| !text.is_empty());
    Some(match base {
        Some(base) => format!("{base}; {extra}"),
        None => extra.to_owned(),
    })
}

fn append_whea_reason(reason: Option<String>, whea_count: f64) -> Option<String> {
    if whea_count <= 0.0 { return reason; }
    let suffix = format!("{} WHEA error{} detected during the test",
        whea_count as u64, if whea_count == 1.0 { "" } else { "s" });
    Some(append_reason(reason, &suffix).unwrap_or(suffix))
}

fn whea_error_count(whea: &Value) -> f64 {
    whea.get("errorCount").and_then(Value::as_f64).filter(|value| value.is_finite()).unwrap_or(0.0).max(0.0)
}

fn error_limit(error: &str) -> String {
    String::from_utf16(&error.encode_utf16().take(240).collect::<Vec<_>>()).unwrap_or_default()
}

fn push_missing(list: &mut Vec<String>, metric: &str) {
    if !list.iter().any(|item| item == metric) { list.push(metric.to_owned()); }
}

/// The engine families in the order a Stability log should read them. Copy and
/// 3-D first because that pair answers "was this a copy-only run".
const ENGINE_ORDER: &[&str] = &["3d", "copy", "compute", "videoDecode", "videoEncode", "other"];

/// Records the highest per-engine and per-node utilization seen so far. Util
/// only steps when a submission retires, so one sample can land in a gap; the
/// run summary keeps peaks instead of whatever the last sample happened to see.
fn record_engine_peaks(
    engines: &mut std::collections::BTreeMap<String, f64>,
    nodes: &mut std::collections::BTreeMap<u32, f64>,
    detail: &Value,
) {
    if let Some(rows) = detail.get("engines").and_then(Value::as_array) {
        for row in rows {
            let Some(name) = row.get("name").and_then(Value::as_str).filter(|name| !name.is_empty()) else { continue; };
            let Some(value) = row.get("utilPct").and_then(Value::as_f64).filter(|value| value.is_finite()) else { continue; };
            let slot = engines.entry(name.to_owned()).or_insert(value);
            *slot = slot.max(value);
        }
    }
    if let Some(rows) = detail.get("nodes").and_then(Value::as_array) {
        for row in rows {
            let Some(id) = row.get("node").and_then(Value::as_u64).and_then(|id| u32::try_from(id).ok()) else { continue; };
            let Some(value) = row.get("utilPct").and_then(Value::as_f64).filter(|value| value.is_finite()) else { continue; };
            let slot = nodes.entry(id).or_insert(value);
            *slot = slot.max(value);
        }
    }
}

fn engine_peak_summary(peaks: &std::collections::BTreeMap<String, f64>) -> String {
    let mut names: Vec<&String> = peaks.keys().collect();
    names.sort_by_key(|name| ENGINE_ORDER.iter().position(|known| known == name).unwrap_or(ENGINE_ORDER.len()));
    names.iter().map(|name| format!("{}:{:.0}", name, peaks[*name])).collect::<Vec<_>>().join(",")
}

fn node_peak_summary(peaks: &std::collections::BTreeMap<u32, f64>) -> String {
    peaks.iter().map(|(id, value)| format!("{id}:{value:.0}")).collect::<Vec<_>>().join(",")
}

fn finite_metric(source: &Value, key: &str) -> Value {
    source.get(key).and_then(Value::as_f64).filter(|value| value.is_finite()).map(|value| json!(value)).unwrap_or(Value::Null)
}

fn metrics_of(source: &Value, normalized: &Value) -> Value {
    let fan_rpm = source.get("fanRpm").and_then(Value::as_array).and_then(|values| values.first())
        .and_then(Value::as_f64).filter(|value| value.is_finite());
    let vram_temp = source.get("vramTempC").and_then(Value::as_f64).filter(|value| value.is_finite())
        .or_else(|| source.get("memTempC").and_then(Value::as_f64).filter(|value| value.is_finite()));
    let gpu_util = source.get("gpuUtilPct").and_then(Value::as_f64).filter(|value| value.is_finite())
        .or_else(|| normalized.get("utilPct").and_then(Value::as_f64).filter(|value| value.is_finite()));
    json!({
        "gpuClockMhz":finite_metric(source, "gpuClockMhz"),
        "vramClockMhz":finite_metric(source, "memClockMhz"),
        "powerW":normalized.get("powerW").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null),
        "fanRpm":fan_rpm.map(|value| json!(value)).unwrap_or(Value::Null),
        "currentTempC":normalized.get("temperatureC").filter(|value| !value.is_null()).cloned().unwrap_or(Value::Null),
        "vramTempC":vram_temp.map(|value| json!(value)).unwrap_or(Value::Null),
        "gpuUtilPct":gpu_util.map(|value| json!(value)).unwrap_or(Value::Null),
        "vramUsedBytes":finite_metric(source, "gpuMemUsedBytes"),
    })
}

fn fallback_sample(received_ms: f64, error: &str) -> Value {
    json!({
        "sampledAtMs":received_ms,"receivedAtMs":received_ms,"sourceTimestampMs":received_ms,
        "sample":{},"utilPct":Value::Null,"temperatureC":Value::Null,"powerW":Value::Null,
        "fps":Value::Null,"present":false,"foreground":false,
        "readError":error_limit(error),"driverError":false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::atomic::{AtomicUsize, Ordering}};

    #[test]
    fn engine_peaks_keep_the_busiest_sample_and_read_in_engine_order() {
        let mut engines = std::collections::BTreeMap::new();
        let mut nodes = std::collections::BTreeMap::new();
        record_engine_peaks(&mut engines, &mut nodes, &json!({
            "engines":[{"name":"copy","utilPct":97.0},{"name":"3d","utilPct":0.0}],
            "nodes":[{"node":0,"utilPct":0.0},{"node":1,"utilPct":97.0}],
        }));
        // A later, quieter sample must not overwrite the busy phase: the whole
        // point of reporting peaks is that 0 % is often just a sampling gap.
        record_engine_peaks(&mut engines, &mut nodes, &json!({
            "engines":[{"name":"copy","utilPct":12.0},{"name":"3d","utilPct":41.0}],
            "nodes":[{"node":1,"utilPct":12.0}],
        }));
        assert_eq!(engine_peak_summary(&engines), "3d:41,copy:97");
        assert_eq!(node_peak_summary(&nodes), "0:0,1:97");
        record_engine_peaks(&mut engines, &mut nodes, &Value::Null);
        assert_eq!(engine_peak_summary(&engines), "3d:41,copy:97");
        assert_eq!(engine_peak_summary(&std::collections::BTreeMap::new()), "");
    }

    #[test]
    fn metric_aggregates_summarize_count_min_mean_max() {
        let mut stats = [MetricAggregate::default(); AGGREGATE_METRICS.len()];
        for sample in [
            json!({"powerW":100.0,"currentTempC":60.0,"gpuClockMhz":2800.0,"vramClockMhz":2375.0,"gpuUtilPct":80.0}),
            json!({"powerW":140.0,"currentTempC":64.0,"gpuClockMhz":2600.0,"vramClockMhz":2375.0,"gpuUtilPct":100.0}),
            // A sample with a missing metric must not drag the statistics to 0.
            json!({"powerW":Value::Null,"currentTempC":62.0,"gpuClockMhz":Value::Null,"vramClockMhz":2375.0,"gpuUtilPct":90.0}),
        ] { record_metric_aggregates(&mut stats, &sample); }
        let out = metric_stats_json(&stats);
        assert_eq!(out["powerW"]["count"], json!(2));
        assert_eq!(out["powerW"]["min"], json!(100.0));
        assert_eq!(out["powerW"]["mean"], json!(120.0));
        assert_eq!(out["powerW"]["max"], json!(140.0));
        // The sampler's `gpuClockMhz` is reported as `coreClockMhz`.
        assert_eq!(out["coreClockMhz"]["count"], json!(2));
        assert_eq!(out["coreClockMhz"]["min"], json!(2600.0));
        assert_eq!(out["coreClockMhz"]["max"], json!(2800.0));
        assert_eq!(out["vramClockMhz"]["count"], json!(3));
        assert_eq!(out["gpuUtilPct"]["max"], json!(100.0));
        assert_eq!(out["currentTempC"]["mean"], json!(62.0));
    }

    #[test]
    fn a_single_sample_run_reports_min_mean_max_and_an_absent_metric_stays_null() {
        let mut stats = [MetricAggregate::default(); AGGREGATE_METRICS.len()];
        record_metric_aggregates(&mut stats, &json!({
            "powerW":122.0,"currentTempC":60.0,"gpuClockMhz":2850.0,"vramClockMhz":2375.0,"gpuUtilPct":100.0,
        }));
        assert_eq!(metric_stats_json(&stats)["powerW"], json!({"count":1,"min":122.0,"mean":122.0,"max":122.0}));
        // A metric that never arrived keeps a zero count instead of a fake 0 W.
        let mut empty = [MetricAggregate::default(); AGGREGATE_METRICS.len()];
        empty[0].observe(None);
        assert_eq!(metric_stats_json(&empty)["powerW"]["count"], json!(0));
        assert!(metric_stats_json(&empty)["powerW"]["mean"].is_null());
    }

    #[test]
    fn snapshot_units_flag_percent_devices_and_derive_watts_only_when_known() {
        // A B580 reports the power limit as a percentage of its reference power.
        let percent = snapshot_unit_fields("Intel(R) Arc(TM) B580 Graphics 12GB GDDR6",
            &json!({"powerLimitW":100.0,"tempLimitC":100.0}),
            &json!({"powerLimitW":"%","tempLimitC":"%"}));
        assert_eq!(percent["powerLimitUnits"], json!("%"));
        assert_eq!(percent["tempLimitUnits"], json!("%"));
        assert_eq!(percent["powerLimitWatts"], json!(217.0));
        // A genuine watt device keeps its own units and gains no derived value.
        let watts = snapshot_unit_fields("Intel(R) Arc(TM) A770 Graphics",
            &json!({"powerLimitW":190.0,"tempLimitC":90.0}),
            &json!({"powerLimitW":"W","tempLimitC":"C"}));
        assert_eq!(watts["powerLimitUnits"], json!("W"));
        assert_eq!(watts["tempLimitUnits"], json!("C"));
        assert!(watts.get("powerLimitWatts").is_none());
        // A percentage on an unknown board is labelled, but no watts are invented.
        let unknown = snapshot_unit_fields("Some GPU", &json!({"powerLimitW":80.0}), &json!({"powerLimitW":"%"}));
        assert_eq!(unknown["powerLimitUnits"], json!("%"));
        assert!(unknown.get("powerLimitWatts").is_none());
        // No reported units means no annotation at all.
        assert_eq!(snapshot_unit_fields("Intel Arc B580", &json!({}), &Value::Null), json!({}));
    }

    struct TestClock { ms: Mutex<f64> }
    impl TestClock {
        fn new(ms: f64) -> Arc<Self> { Arc::new(Self { ms: Mutex::new(ms) }) }
        fn advance(&self, ms: f64) { *self.ms.lock().unwrap() += ms; }
    }
    impl RunClock for TestClock {
        fn now_ms(&self) -> f64 { *self.ms.lock().unwrap() }
        fn now_iso(&self) -> String { "2026-01-01T00:00:00.000Z".into() }
    }

    struct TestSleeper { clock: Arc<TestClock> }
    impl RunSleeper for TestSleeper {
        fn sleep(&self, duration: Duration) { self.clock.advance(duration.as_millis() as f64); }
    }

    #[derive(Default)]
    struct ManualSpawner { tasks: Mutex<Vec<Box<dyn FnOnce() + Send>>> }
    impl RunSpawner for ManualSpawner {
        fn spawn(&self, task: Box<dyn FnOnce() + Send>) -> Result<(), String> {
            self.tasks.lock().unwrap().push(task); Ok(())
        }
    }
    impl ManualSpawner {
        fn run_all(&self) {
            loop {
                let task = { let mut tasks = self.tasks.lock().unwrap(); if tasks.is_empty() { None } else { Some(tasks.remove(0)) } };
                match task { Some(task) => task(), None => break }
            }
        }
    }

    struct FakeWorkload {
        log: Arc<Mutex<Vec<&'static str>>>,
        result: Value,
        starts: AtomicUsize,
        stops: AtomicUsize,
        status: Mutex<Value>,
    }
    impl FakeWorkload {
        fn new(log: Arc<Mutex<Vec<&'static str>>>, result: Value) -> Arc<Self> {
            Arc::new(Self { log, result, starts: AtomicUsize::new(0), stops: AtomicUsize::new(0), status: Mutex::new(json!({"active":false})) })
        }
    }
    impl WorkloadController for FakeWorkload {
        fn start(&self, _target: &Value) -> Result<Value, String> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            self.log.lock().unwrap().push("workload.start");
            Ok(self.result.clone())
        }
        fn stop(&self) -> Result<(), String> {
            self.stops.fetch_add(1, Ordering::SeqCst);
            self.log.lock().unwrap().push("workload.stop");
            Ok(())
        }
        fn status(&self) -> Value { self.status.lock().unwrap().clone() }
    }

    struct FakeWhea { log: Arc<Mutex<Vec<&'static str>>>, state: Mutex<Value>, stop_state: Value }
    impl FakeWhea {
        fn new(log: Arc<Mutex<Vec<&'static str>>>, stop_state: Value) -> Arc<Self> {
            Arc::new(Self { log, state: Mutex::new(json!({"available":true,"checked":true,"errorCount":0,"error":null})), stop_state })
        }
    }
    impl WheaLane for FakeWhea {
        fn start(&self, _started_at_ms: f64) -> Result<Value, String> {
            self.log.lock().unwrap().push("whea.start");
            let mut state = self.state.lock().unwrap();
            let baseline = state["errorCount"].as_f64().unwrap_or(0.0);
            state["baselineErrorCount"] = json!(baseline);
            Ok(state.clone())
        }
        fn snapshot(&self) -> Value { self.state.lock().unwrap().clone() }
        fn stop(&self) -> Result<Value, String> {
            self.log.lock().unwrap().push("whea.stop");
            let mut stopped = self.stop_state.clone();
            let observed = whea_error_count(&self.state.lock().unwrap());
            if whea_error_count(&stopped) < observed { stopped["errorCount"] = json!(observed); }
            *self.state.lock().unwrap() = stopped.clone();
            Ok(stopped)
        }
    }

    struct RecordingSink { log: Arc<Mutex<Vec<&'static str>>>, reports: Mutex<Vec<Value>>, fail: Option<String> }
    impl ReportSink for RecordingSink {
        fn append(&self, report: &Value) -> Result<Value, String> {
            self.log.lock().unwrap().push("append");
            if let Some(error) = &self.fail { return Err(error.clone()); }
            self.reports.lock().unwrap().push(report.clone());
            Ok(report.clone())
        }
    }

    fn push(log: &Arc<Mutex<Vec<&'static str>>>, entry: &'static str) { log.lock().unwrap().push(entry); }

    fn emitter(log: Arc<Mutex<Vec<&'static str>>>, statuses: Arc<Mutex<Vec<Value>>>) -> Box<dyn Fn(&Value) + Send + Sync> {
        Box::new(move |status| {
            if status["state"] == json!("completed") || status["state"] == json!("aborted") { push(&log, "publish"); }
            statuses.lock().unwrap().push(status.clone());
        })
    }

    fn target(key: &str) -> Value {
        json!({"id":2,"name":"Intel Arc B580","deviceKey":key,"pciVendorId":"0x8086","pciDeviceId":"0x56a0",
            "luid":"0:1","graphicsClockMHz":2800,"vramBytes":12_000_000_000u64})
    }

    fn good_sample() -> Value {
        json!({
            "sample":{"gpuClockMhz":2400,"memClockMhz":9500,"gpuUtilPct":95,"tempC":60,"powerW":100,
                "fanRpm":[1800],"vramTempC":65,"gpuMemUsedBytes":1234},
            "fpsSample":{"fps":60},"foregroundProcess":{"pid":42},
        })
    }

    fn static_resolver(value: Option<Value>) -> Box<dyn Fn(&str) -> Option<Value> + Send + Sync> {
        Box::new(move |_| value.clone())
    }

    struct Harness {
        runtime: StabilityRuntime,
        spawner: Arc<ManualSpawner>,
        workload: Option<Arc<FakeWorkload>>,
        whea: Arc<FakeWhea>,
        reports: Arc<RecordingSink>,
        statuses: Arc<Mutex<Vec<Value>>>,
        log: Arc<Mutex<Vec<&'static str>>>,
        telemetry_ensures: Arc<AtomicUsize>,
        telemetry_error: Arc<Mutex<Option<String>>>,
    }

    fn harness(target_value: Option<Value>, sample: impl Fn(&Value) -> Value + Send + Sync + 'static,
        settings: Value, workload_result: Option<Value>, whea_stop: Value, fail_append: Option<String>) -> Harness {
        harness_with_engine_detail(target_value, sample, settings, workload_result, whea_stop, fail_append, Value::Null)
    }

    fn harness_with_engine_detail(target_value: Option<Value>, sample: impl Fn(&Value) -> Value + Send + Sync + 'static,
        settings: Value, workload_result: Option<Value>, whea_stop: Value, fail_append: Option<String>,
        engine_detail: Value) -> Harness {
        let clock = TestClock::new(1_800_000_000_000.0);
        let spawner = Arc::new(ManualSpawner::default());
        let log = Arc::new(Mutex::new(Vec::new()));
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let whea = FakeWhea::new(log.clone(), whea_stop);
        let reports = Arc::new(RecordingSink { log: log.clone(), reports: Mutex::new(Vec::new()), fail: fail_append });
        let workload = workload_result.map(|result| FakeWorkload::new(log.clone(), result));
        let telemetry_ensures = Arc::new(AtomicUsize::new(0));
        let telemetry_ensure_count = telemetry_ensures.clone();
        let telemetry_error = Arc::new(Mutex::new(None));
        let telemetry_failure = telemetry_error.clone();
        let runtime = StabilityRuntime::new(StabilityRuntimeDeps {
            resolve_target: static_resolver(target_value),
            sample_target: Box::new(sample),
            engine_detail: Box::new(move |_| engine_detail.clone()),
            settings_snapshot: Box::new(move |_| settings.clone()),
            ensure_telemetry: Box::new(move |_| {
                telemetry_ensure_count.fetch_add(1, Ordering::SeqCst);
                telemetry_failure.lock().unwrap().clone().map_or(Ok(()), Err)
            }),
            workload: workload.clone().map(|workload| Box::new(FakeWorkloadRef(workload)) as Box<dyn WorkloadController>),
            whea: Some(Box::new(FakeWheaRef(whea.clone()))),
            reports: Box::new(RecordingSinkRef(reports.clone())),
            emit: emitter(log.clone(), statuses.clone()),
            clock: Box::new(TestClockRef(clock.clone())),
            sleeper: Box::new(TestSleeper { clock: clock.clone() }),
            spawner: Box::new(ManualSpawnerRef(spawner.clone())),
        });
        Harness { runtime, spawner, workload, whea, reports, statuses, log, telemetry_ensures, telemetry_error }
    }

    // Thin forwarding wrappers keep the shared test doubles inspectable while
    // the runtime owns boxed trait objects.
    struct FakeWorkloadRef(Arc<FakeWorkload>);
    impl WorkloadController for FakeWorkloadRef {
        fn start(&self, target: &Value) -> Result<Value, String> { self.0.start(target) }
        fn stop(&self) -> Result<(), String> { self.0.stop() }
        fn status(&self) -> Value { self.0.status() }
    }
    struct FakeWheaRef(Arc<FakeWhea>);
    impl WheaLane for FakeWheaRef {
        fn start(&self, started_at_ms: f64) -> Result<Value, String> { self.0.start(started_at_ms) }
        fn snapshot(&self) -> Value { self.0.snapshot() }
        fn stop(&self) -> Result<Value, String> { self.0.stop() }
    }
    struct RecordingSinkRef(Arc<RecordingSink>);
    impl ReportSink for RecordingSinkRef {
        fn append(&self, report: &Value) -> Result<Value, String> { self.0.append(report) }
    }
    struct TestClockRef(Arc<TestClock>);
    impl RunClock for TestClockRef {
        fn now_ms(&self) -> f64 { self.0.now_ms() }
        fn now_iso(&self) -> String { self.0.now_iso() }
    }
    struct ManualSpawnerRef(Arc<ManualSpawner>);
    impl RunSpawner for ManualSpawnerRef {
        fn spawn(&self, task: Box<dyn FnOnce() + Send>) -> Result<(), String> { self.0.spawn(task) }
    }

    fn default_harness() -> Harness {
        harness(Some(target("gpu-a")), |_| good_sample(), json!({}),
            Some(json!({"started":true,"adapterLuid":"0:1"})), json!({"available":true,"checked":true,"errorCount":0,"error":null}), None)
    }

    fn start_payload(cadence: u64, duration: u64) -> Value {
        json!({"deviceKey":"gpu-a","cadenceMs":cadence,"durationSec":duration})
    }

    #[test]
    fn abort_policy_has_only_the_temperature_and_whea_thresholds() {
        assert_eq!(abort_reason_for(Some(89.9), 0.0), None);
        assert_eq!(abort_reason_for(Some(90.0), 0.0), Some("gpu-temperature"));
        assert_eq!(abort_reason_for(Some(70.0), 1.0), Some("whea"));
        assert_eq!(abort_reason_for(None, 0.0), None);
    }

    #[test]
    fn active_whea_error_aborts_once_and_preserves_the_latest_metrics() {
        let h = default_harness();
        h.runtime.start(&start_payload(500, 30)).unwrap();
        h.whea.state.lock().unwrap()["errorCount"] = json!(1);
        h.spawner.run_all();

        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(report["outcome"], json!("aborted"));
        assert_eq!(report["reason"], json!("whea"));
        assert_eq!(report["abortReason"], json!("whea"));
        assert_eq!(report["wheaErrorCount"], json!(1.0));
        assert_eq!(report["sampleCount"], json!(1.0));
        assert_eq!(h.runtime.status(None), None);
        let status = h.statuses.lock().unwrap();
        let aborted: Vec<_> = status.iter().filter(|status| status["state"] == json!("aborted")).collect();
        assert_eq!(aborted.len(), 1);
        assert_eq!(aborted[0]["metrics"]["gpuUtilPct"], json!(95.0));
        assert_eq!(aborted[0]["whea"]["errorCount"], json!(1));
        assert_eq!(aborted[0]["abortDetails"]["wheaDelta"], json!(1.0));
    }

    #[test]
    fn preexisting_whea_entries_are_reported_but_do_not_abort() {
        let h = default_harness();
        h.whea.state.lock().unwrap()["errorCount"] = json!(4);
        let status = h.runtime.start(&start_payload(1000, 10)).unwrap();
        assert_eq!(status["state"], json!("running"));
        assert_eq!(status["whea"]["baselineErrorCount"], json!(4.0));
        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(report["outcome"], json!("warning"));
        assert_eq!(report["wheaErrorCount"], json!(4.0));
        assert!(report["reason"].is_null());
    }

    #[test]
    fn whea_observed_after_user_cancel_does_not_change_the_abort_reason() {
        let h = harness(Some(target("gpu-a")), |_| good_sample(), json!({}),
            Some(json!({"started":true})),
            json!({"available":true,"checked":true,"errorCount":1,"baselineErrorCount":0}), None);
        h.runtime.start(&start_payload(500, 30)).unwrap();
        let report = h.runtime.cancel(None);
        assert_eq!(report["outcome"], json!("cancelled"));
        assert_eq!(report["reason"], json!("cancelled by user"));
        assert!(report["abortReason"].is_null());
        assert_eq!(report["wheaErrorCount"], json!(0.0));
        assert_eq!(h.statuses.lock().unwrap().last().unwrap()["state"], json!("completed"));
        h.spawner.run_all();
    }

    #[test]
    fn temperature_at_ninety_aborts_but_eighty_nine_point_nine_completes() {
        let at_limit = harness(Some(target("gpu-a")), |_| {
            let mut sample = good_sample();
            sample["sample"]["tempC"] = json!(90.0);
            sample
        }, json!({"stabilityThresholdInputs":{
            "powerW":{"value":217,"source":"test-device"},
            "currentTempC":{"value":100,"source":"test-device"}
        }}), Some(json!({"started":true})),
            json!({"available":true,"checked":true,"errorCount":0}), None);
        at_limit.runtime.start(&start_payload(500, 30)).unwrap();
        at_limit.spawner.run_all();
        let aborted = at_limit.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(aborted["outcome"], json!("aborted"));
        assert_eq!(aborted["reason"], json!("gpu-temperature"));
        assert_eq!(aborted["abortReason"], json!("gpu-temperature"));
        assert_eq!(at_limit.statuses.lock().unwrap().last().unwrap()["abortDetails"]["temperatureC"], json!(90.0));

        let below_limit = harness(Some(target("gpu-a")), |_| {
            let mut sample = good_sample();
            sample["sample"]["tempC"] = json!(89.9);
            sample
        }, json!({"stabilityThresholdInputs":{
            "powerW":{"value":217,"source":"test-device"},
            "currentTempC":{"value":100,"source":"test-device"}
        }}), Some(json!({"started":true})),
            json!({"available":true,"checked":true,"errorCount":0}), None);
        below_limit.runtime.start(&start_payload(1000, 10)).unwrap();
        below_limit.spawner.run_all();
        let completed = below_limit.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(completed["outcome"], json!("passed"));
        assert!(completed["abortReason"].is_null());
    }

    #[test]
    fn run_start_ensures_telemetry_or_exposes_the_failure() {
        let available = default_harness();
        let status = available.runtime.start(&start_payload(500, 30)).unwrap();
        assert_eq!(available.telemetry_ensures.load(Ordering::SeqCst), 1);
        assert_eq!(status["telemetryStatus"], json!("running"));
        available.runtime.cancel(None);

        let unavailable = default_harness();
        *unavailable.telemetry_error.lock().unwrap() = Some("telemetry lane unavailable".into());
        let status = unavailable.runtime.start(&start_payload(500, 30)).unwrap();
        assert_eq!(status["telemetryStatus"], json!("unavailable"));
        assert_eq!(status["telemetryReason"], json!("telemetry lane unavailable"));
        assert_eq!(status["workloadStatus"], json!("unavailable"));
        assert_eq!(unavailable.workload.as_ref().unwrap().starts.load(Ordering::SeqCst), 0);
        assert!(status["missingMetrics"].as_array().unwrap().contains(&json!("telemetry")));
        unavailable.runtime.cancel(None);
    }

    #[test]
    fn partial_vram_allocation_is_reported_and_cannot_pass_as_full_success() {
        let h = harness(Some(target("gpu-a")), |_| good_sample(), json!({}),
            Some(json!({"started":true,"allocation":{
                "targetBytes":9_600_000_000u64,"allocatedBytes":3_774_873_600u64,
                "complete":false,"reason":"target not reached"
            }})),
            json!({"available":true,"checked":true,"errorCount":0}), None);
        let status = h.runtime.start(&start_payload(1000, 10)).unwrap();
        assert_eq!(status["workloadStatus"], json!("partial"));
        assert_eq!(status["vramTargetBytes"], json!(9_600_000_000u64));
        assert_eq!(status["vramAllocatedBytes"], json!(3_774_873_600u64));
        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(report["outcome"], json!("warning"));
        assert_eq!(report["vramTargetBytes"], json!(9_600_000_000.0));
        assert_eq!(report["vramAllocatedBytes"], json!(3_774_873_600.0));
        assert_eq!(report["vramAllocationComplete"], json!(false));

        let unavailable = harness(Some(target("gpu-a")), |_| good_sample(), json!({}),
            Some(json!({"started":false,"reason":"render target allocation failed","allocation":{
                "targetBytes":9_600_000_000u64,"allocatedBytes":0u64,"complete":false,
                "reason":"render target allocation failed"
            }})),
            json!({"available":true,"checked":true,"errorCount":0}), None);
        let status = unavailable.runtime.start(&start_payload(500, 30)).unwrap();
        assert_eq!(status["workloadStatus"], json!("unavailable"));
        assert_eq!(status["workloadReason"], json!("render target allocation failed"));
        assert_eq!(status["vramAllocatedBytes"], json!(0));
        assert_eq!(status["vramAllocationComplete"], json!(false));
        unavailable.runtime.cancel(None);
        let failed = unavailable.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(failed["vramTargetBytes"], json!(9_600_000_000.0));
        assert_eq!(failed["vramAllocatedBytes"], json!(0.0));
    }

    #[test]
    fn status_shape_matches_status_of_run_exactly() {
        let h = default_harness();
        let status = h.runtime.start(&start_payload(500, 30)).unwrap();
        let keys: std::collections::HashSet<&str> = status.as_object().unwrap().keys().map(String::as_str).collect();
        let expected: std::collections::HashSet<&str> = [
            "runId", "state", "target", "effectiveCadenceMs", "effectiveDurationSec",
            "sampleCount", "freshSampleCount", "missingMetrics", "workloadEvidence",
            "foregroundCount", "presentEvidenceCount", "utilEvidenceCount", "workloadActive",
            "workloadStatus", "workloadReason", "workloadSubmits", "workloadErrors",
            "workloadError", "workloadThreadFinished", "workloadAdapterLuid",
            "thresholdBreaches", "thresholds", "thresholdLimits", "thresholdSources",
            "thresholdFallback", "thresholdFallbacks", "telemetryStatus", "telemetryReason",
            "vramTargetBytes", "vramAllocatedBytes", "vramAllocationComplete",
            "abortReason", "abortDetails", "metrics", "limits", "whea", "outcome",
            "reason", "startedAt", "endedAt",
        ].into_iter().collect();
        assert_eq!(keys, expected);
        assert_eq!(status["target"]["deviceKey"], json!("gpu-a"));
        assert_eq!(status["metrics"].as_object().unwrap().len(), 8);
        assert_eq!(status["limits"].as_object().unwrap().len(), 8);
        assert_eq!(status["workloadReason"], Value::Null);
        assert_eq!(status["outcome"], Value::Null);
        assert_eq!(status["endedAt"], Value::Null);
        h.runtime.cancel(None);
        h.spawner.run_all();
    }

    #[test]
    fn request_validation_and_clamps_match_the_contract() {
        let h = default_harness();
        assert_eq!(h.runtime.start(&json!("nope")).unwrap_err(), "stability request must be an object");
        assert_eq!(h.runtime.start(&json!({})).unwrap_err(), "stability request requires a stable device key");
        assert_eq!(h.runtime.start(&json!({"deviceKey":"gpu-a"})).unwrap_err(), "stability cadence or duration is invalid");
        let status = h.runtime.start(&json!({"deviceKey":"  gpu-a  ","cadenceMs":1,"durationSec":5000})).unwrap();
        assert_eq!(status["effectiveCadenceMs"], json!(250));
        assert_eq!(status["effectiveDurationSec"], json!(900));
        h.runtime.shutdown();
        h.spawner.run_all();

        let status = h.runtime.start(&json!({"deviceKey":"gpu-a","cadenceMs":99999,"durationSec":1})).unwrap();
        assert_eq!(status["effectiveCadenceMs"], json!(2000));
        assert_eq!(status["effectiveDurationSec"], json!(10));
        h.runtime.shutdown();
        h.spawner.run_all();
    }

    #[test]
    fn immediate_unavailable_returns_a_report_and_clears_the_run() {
        let h = harness(None, |_| good_sample(), json!({}), Some(json!({"started":true})),
            json!({"available":true,"checked":true,"errorCount":0}), None);
        let report = h.runtime.start(&start_payload(500, 30)).unwrap();
        assert_eq!(report["outcome"], json!("unavailable"));
        assert_eq!(report["reason"], json!(IMMEDIATE_UNAVAILABLE));
        assert_eq!(report["target"]["deviceKey"], json!("gpu-a"));
        assert_eq!(report["sampleCount"], json!(0.0));
        assert_eq!(h.reports.reports.lock().unwrap().len(), 1);
        assert_eq!(h.workload.as_ref().unwrap().starts.load(Ordering::SeqCst), 0);
        assert_eq!(h.workload.as_ref().unwrap().stops.load(Ordering::SeqCst), 1);
        assert!(h.runtime.status(None).is_none());
        assert_eq!(h.statuses.lock().unwrap().last().unwrap()["state"], json!("completed"));
    }

    #[test]
    fn a_second_start_is_refused_while_a_run_is_active() {
        let h = default_harness();
        let status = h.runtime.start(&start_payload(500, 30)).unwrap();
        assert_eq!(status["state"], json!("running"));
        assert_eq!(h.runtime.start(&start_payload(500, 30)).unwrap_err(), ALREADY_ACTIVE);
        h.runtime.shutdown();
        h.spawner.run_all();
        assert!(h.runtime.status(None).is_none());
    }

    #[test]
    fn status_and_cancel_follow_the_empty_and_mismatched_run_id_rules() {
        let h = default_harness();
        assert!(h.runtime.status(None).is_none());
        assert!(h.runtime.cancel(None).is_null());

        let run = h.runtime.start(&start_payload(500, 30)).unwrap();
        let run_id = run["runId"].as_str().unwrap().to_owned();
        assert_eq!(h.runtime.status(None).unwrap()["runId"], json!(run_id));
        assert_eq!(h.runtime.status(Some("")).unwrap()["runId"], json!(run_id));
        assert!(h.runtime.status(Some("another-run")).is_none());

        let mismatch = h.runtime.cancel(Some("another-run"));
        assert_eq!(mismatch["runId"], json!(run_id));
        assert_eq!(mismatch["state"], json!("running"));
        assert!(h.runtime.status(None).is_some());

        let report = h.runtime.cancel(Some(&run_id));
        assert_eq!(report["outcome"], json!("cancelled"));
        assert_eq!(report["reason"], json!("cancelled by user"));
        assert!(report["abortReason"].is_null());
        assert!(h.runtime.status(None).is_none());
        assert!(h.runtime.cancel(Some(&run_id)).is_null());
        h.spawner.run_all();
    }

    #[test]
    fn wire_channels_validate_payloads_and_run_ids() {
        let h = default_harness();
        assert_eq!(h.runtime.handle("stability-run-start", &wire::encode_json(&json!([])).unwrap()).unwrap_err(),
            "stability request requires a stable device key");
        assert_eq!(h.runtime.handle("stability-run-start", &wire::encode_json(&json!([null])).unwrap()).unwrap_err(),
            "stability request must be an object");
        let start_args = wire::encode_json(&json!([{"deviceKey":"gpu-a","cadenceMs":500,"durationSec":30}])).unwrap();
        let status = h.runtime.handle("stability-run-start", &start_args).unwrap();
        let run_id = status["runId"].as_str().unwrap().to_owned();
        assert_eq!(h.runtime.handle("stability-run-start", &start_args).unwrap_err(), ALREADY_ACTIVE);

        assert_eq!(h.runtime.handle("stability-run-status", &wire::encode_json(&json!([])).unwrap()).unwrap()["runId"],
            json!(run_id));
        assert_eq!(h.runtime.handle("stability-run-status", &wire::encode_json(&json!(["another"])).unwrap()).unwrap(),
            Value::Null);
        assert_eq!(h.runtime.handle("stability-run-status", &wire::encode_json(&json!([7])).unwrap()).unwrap_err(),
            "stability-run-status: run id must be a string");
        assert_eq!(h.runtime.handle("stability-run-cancel", &wire::encode_json(&json!([null])).unwrap()).unwrap()["outcome"],
            json!("cancelled"));
        assert_eq!(h.runtime.handle("stability-run-cancel", &wire::encode_json(&json!([{}])).unwrap()).unwrap_err(),
            "stability-run-cancel: run id must be a string");
        assert!(h.runtime.handle("stability-run-cancel", &wire::encode_json(&json!([])).unwrap()).unwrap().is_null());
        h.spawner.run_all();
    }

    #[test]
    fn duration_samples_at_zero_then_cadence_and_finishes_in_required_order() {
        let h = default_harness();
        h.runtime.start(&start_payload(1000, 10)).unwrap();
        h.log.lock().unwrap().clear();
        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(report["sampleCount"], json!(10.0));
        assert_eq!(report["freshSampleCount"], json!(10.0));
        assert_eq!(report["effectiveCadenceMs"], json!(1000));
        assert_eq!(report["effectiveDurationSec"], json!(10));
        assert_eq!(report["outcome"], json!("passed"));
        assert_eq!(report["workloadEvidence"], json!(true));
        assert_eq!(*h.log.lock().unwrap(), vec!["whea.stop", "append", "workload.stop", "publish"]);
        assert_eq!(h.workload.as_ref().unwrap().stops.load(Ordering::SeqCst), 1);
        assert_eq!(h.whea.stop_state["available"], json!(true));
        assert!(h.runtime.status(None).is_none());
    }

    #[test]
    fn durable_key_re_resolution_finishes_unavailable() {
        let first = target("gpu-a");
        let second = target("gpu-b");
        let resolutions = Arc::new(Mutex::new(VecDeque::from(vec![Some(first), Some(second)])));
        let clock = TestClock::new(1_800_000_000_000.0);
        let spawner = Arc::new(ManualSpawner::default());
        let log = Arc::new(Mutex::new(Vec::new()));
        let statuses = Arc::new(Mutex::new(Vec::new()));
        let whea = FakeWhea::new(log.clone(), json!({"available":true,"checked":true,"errorCount":0}));
        let reports = Arc::new(RecordingSink { log: log.clone(), reports: Mutex::new(Vec::new()), fail: None });
        let runtime = StabilityRuntime::new(StabilityRuntimeDeps {
            resolve_target: Box::new(move |_| resolutions.lock().unwrap().pop_front().flatten()),
            sample_target: Box::new(|_| good_sample()),
            engine_detail: Box::new(|_| Value::Null),
            settings_snapshot: Box::new(|_| json!({})),
            ensure_telemetry: Box::new(|_| Ok(())),
            workload: None,
            whea: Some(Box::new(FakeWheaRef(whea))),
            reports: Box::new(RecordingSinkRef(reports.clone())),
            emit: emitter(log.clone(), statuses),
            clock: Box::new(TestClockRef(clock.clone())),
            sleeper: Box::new(TestSleeper { clock }),
            spawner: Box::new(ManualSpawnerRef(spawner.clone())),
        });
        let status = runtime.start(&start_payload(500, 30)).unwrap();
        assert_eq!(status["target"]["deviceKey"], json!("gpu-a"));
        spawner.run_all();
        let report = reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(report["outcome"], json!("unavailable"));
        assert_eq!(report["reason"], json!(DEVICE_CHANGED));
        assert_eq!(report["sampleCount"], json!(0.0));
        assert!(runtime.status(None).is_none());
    }

    #[test]
    fn monitor_only_idle_telemetry_classifies_no_workload() {
        let idle = |_: &Value| json!({"sample":{"tempC":50,"powerW":40},"foregroundProcess":Value::Null});
        let h = harness(Some(target("gpu-a")), idle, json!({}), None,
            json!({"available":true,"checked":true,"errorCount":0}), None);
        let run = h.runtime.start(&start_payload(1000, 10)).unwrap();
        assert_eq!(run["workloadStatus"], json!("monitor-only"));
        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(report["outcome"], json!("no-workload"));
        assert_eq!(report["workloadEvidence"], json!(false));
        assert_eq!(report["sampleCount"], json!(10.0));
    }

    #[test]
    fn workload_start_refusal_stays_monitor_only_for_the_rest_of_the_run() {
        let idle = |_: &Value| json!({"sample":{"tempC":50,"powerW":40}});
        let h = harness(Some(target("gpu-a")), idle, json!({}),
            Some(json!({"started":false,"reason":"adapter busy"})),
            json!({"available":true,"checked":true,"errorCount":0}), None);
        let run = h.runtime.start(&start_payload(1000, 10)).unwrap();
        assert_eq!(run["workloadStatus"], json!("unavailable"));
        assert_eq!(run["workloadReason"], json!("adapter busy"));
        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(report["outcome"], json!("no-workload"));
        assert_eq!(h.workload.as_ref().unwrap().starts.load(Ordering::SeqCst), 1);
        assert_eq!(h.workload.as_ref().unwrap().stops.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn run_thresholds_use_device_limits_or_report_the_fixed_fallbacks() {
        let device_limits = harness(Some(target("gpu-a")), |_| good_sample(), json!({
            "powerLimitW":100,
            "tempLimitC":100,
            "stabilityThresholdInputs":{
                "powerW":{"value":190,"source":"power-limits:read.sustainedW"},
                "currentTempC":{"value":100,"source":"current-settings.tempLimitC"}
            }
        }), Some(json!({"started":true})),
            json!({"available":true,"checked":true,"errorCount":0}), None);
        let status = device_limits.runtime.start(&start_payload(1000, 10)).unwrap();
        assert_eq!(status["thresholdLimits"], json!({"powerW":190.0,"currentTempC":100.0}));
        assert_eq!(status["thresholdSources"], json!({
            "powerW":"power-limits:read.sustainedW",
            "currentTempC":"current-settings.tempLimitC"
        }));
        assert_eq!(status["thresholdFallback"], json!(false));
        assert_eq!(status["thresholdFallbacks"], json!([]));
        let report = device_limits.runtime.cancel(None);
        assert!(report["settingsSnapshot"].get("stabilityThresholdInputs").is_none());
        assert_eq!(report["thresholdLimits"], status["thresholdLimits"]);
        assert_eq!(report["thresholdSources"], status["thresholdSources"]);
        assert_eq!(report["thresholdFallback"], json!(false));
        assert_eq!(report["thresholdFallbacks"], json!([]));

        let missing_limits = harness(Some(target("gpu-a")), |_| good_sample(), json!({
            "powerLimitW":100,
            "tempLimitC":100,
            "stabilityThresholdInputs":null
        }), Some(json!({"started":true})),
            json!({"available":true,"checked":true,"errorCount":0}), None);
        let status = missing_limits.runtime.start(&start_payload(1000, 10)).unwrap();
        assert_eq!(status["thresholdLimits"], json!({"powerW":200.0,"currentTempC":85.0}));
        assert_eq!(status["thresholdSources"], json!({
            "powerW":"fallback-default",
            "currentTempC":"fallback-default"
        }));
        assert_eq!(status["thresholdFallback"], json!(true));
        assert_eq!(status["thresholdFallbacks"], json!(["powerW","currentTempC"]));
        let report = missing_limits.runtime.cancel(None);
        assert_eq!(report["thresholdFallback"], json!(true));
        assert_eq!(report["thresholdLimits"], status["thresholdLimits"]);
        assert_eq!(report["thresholdFallbacks"], json!(["powerW","currentTempC"]));
    }

    #[test]
    fn device_threshold_inputs_match_tuning_units_and_power_limit_read() {
        let b580 = device_threshold_inputs(
            "Intel Arc B580",
            &json!({"powerLimitW":100,"tempLimitC":100}),
            Some("%"),
            Some("%"),
            &json!({"sustainedW":190}),
        );
        assert_eq!(b580["powerW"], json!({"value":217.0,"source":"tuning-display.powerLimitW"}));
        assert_eq!(b580["currentTempC"], json!({"value":100.0,"source":"tuning-display.tempLimitC"}));

        let alchemist = device_threshold_inputs(
            "Intel Arc A770",
            &json!({"powerLimitW":220,"tempLimitC":90}),
            Some("W"),
            Some("C"),
            &json!({"sustainedW":190}),
        );
        assert_eq!(alchemist["powerW"], json!({"value":190.0,"source":"power-limits:read.sustainedW"}));
        assert_eq!(alchemist["currentTempC"], json!({"value":90.0,"source":"current-settings.tempLimitC"}));

        let unavailable = device_threshold_inputs("Unknown GPU", &json!({}), None, None, &Value::Null);
        assert!(unavailable["powerW"].is_null());
        assert!(unavailable["currentTempC"].is_null());
    }

    #[test]
    fn stale_samples_and_threshold_breaches_warn_and_persist_counts() {
        let clock = TestClock::new(1_800_000_000_000.0);
        let stale_clock = clock.clone();
        let stale = move |_: &Value| {
            let mut sample = good_sample();
            sample["receivedAtMs"] = json!(stale_clock.now_ms() - 5000.0);
            sample["sample"]["tempC"] = json!(80);
            sample["sample"]["powerW"] = json!(300);
            sample
        };
        let h = harness(Some(target("gpu-a")), stale, json!({
            "tempLimitC":70,"powerLimitW":250,
            "stabilityThresholdInputs":{
                "powerW":{"value":250,"source":"current-settings.powerLimitW"},
                "currentTempC":{"value":70,"source":"current-settings.tempLimitC"}
            }
        }),
            Some(json!({"started":true})), json!({"available":true,"checked":true,"errorCount":0}), None);
        h.runtime.start(&start_payload(1000, 10)).unwrap();
        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        assert_eq!(report["outcome"], json!("warning"));
        assert_eq!(report["sampleCount"], json!(10.0));
        assert_eq!(report["freshSampleCount"], json!(0.0));
        assert_eq!(report["thresholdBreaches"], json!(20.0));
        assert_eq!(report["thresholds"], json!([
            {"metric":"tempC","value":80.0,"limit":70.0},
            {"metric":"powerW","value":300.0,"limit":250.0}
        ]));
        let status = h.statuses.lock().unwrap().last().cloned().unwrap();
        assert_eq!(status["thresholds"], report["thresholds"]);
    }

    #[test]
    fn workload_submit_diagnostics_are_published_and_persisted() {
        let h = default_harness();
        *h.workload.as_ref().unwrap().status.lock().unwrap() = json!({
            "active":true,"workloadSubmits":12,"workloadErrors":1,
            "workloadDraws":176,"workloadCopies":704,
            "workloadError":"D3D11 event query read failed (0x887a0005)",
            "workloadThreadFinished":true
        });
        let started = h.runtime.start(&start_payload(1000, 10)).unwrap();
        assert_eq!(started["workloadSubmits"], json!(12));
        assert_eq!(started["workloadErrors"], json!(1));
        assert_eq!(started["workloadError"], json!("D3D11 event query read failed (0x887a0005)"));

        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        let status = h.statuses.lock().unwrap().last().cloned().unwrap();
        assert_eq!(status["workloadSubmits"], json!(12));
        assert_eq!(status["workloadErrors"], json!(1));
        assert_eq!(status["workloadError"], json!("D3D11 event query read failed (0x887a0005)"));
        assert_eq!(status["workloadThreadFinished"], json!(true));
        assert_eq!(report["thresholdBreaches"], json!(0.0));
        // The worked counters are part of the persisted report, not log-only.
        assert_eq!(report["workloadSubmits"], json!(12.0));
        assert_eq!(report["workloadDraws"], json!(176.0));
        assert_eq!(report["workloadCopies"], json!(704.0));
    }

    #[test]
    fn the_report_keeps_the_utilization_series_and_the_deltas_behind_it() {
        let h = harness(Some(target("gpu-a")), |_| json!({
            "sample":{"gpuClockMhz":2400,"memClockMhz":9500,"gpuUtilPct":93.2,"utilPct":93.2,
                "tempC":60,"powerW":100,"fanRpm":[1800],
                "gpuUtilWallMs":600.0,
                "gpuUtilNodes":[[0,5_592_000,93.2],[7,81_600,1.36]]},
            "fpsSample":{"fps":60},"foregroundProcess":{"pid":42},
        }), json!({}), Some(json!({"started":true,"adapterLuid":"0:1"})),
            json!({"available":true,"checked":true,"errorCount":0,"error":null}), None);
        h.runtime.start(&start_payload(600, 10)).unwrap();
        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        let series = report["utilSeries"].as_array().expect("series must persist");
        let samples = report["utilSamples"].as_array().expect("samples must persist");
        // One entry per sample, in order, so the series can be indexed against
        // the run's own cadence.
        assert_eq!(series.len(), samples.len());
        assert_eq!(series.len(), report["sampleCount"].as_f64().unwrap() as usize);
        assert_eq!(series[0], json!(93.2));
        // The raw interval and per-node tick deltas are what make 93.2 auditable.
        assert_eq!(samples[0]["wallMs"], json!(600.0));
        assert_eq!(samples[0]["nodes"][0], json!([0.0, 5_592_000.0, 93.2]));
        assert_eq!(samples[0]["nodes"][1], json!([7.0, 81_600.0, 1.36]));
        // A sample without a reading is a null slot, never a fabricated zero.
        assert!(samples[0]["atMs"].is_number());
    }

    #[test]
    fn the_persisted_report_carries_metric_aggregates_and_engine_peaks() {
        let h = harness_with_engine_detail(Some(target("gpu-a")), |_| good_sample(), json!({}),
            Some(json!({"started":true,"adapterLuid":"0:1"})),
            json!({"available":true,"checked":true,"errorCount":0,"error":null}), None,
            json!({"engines":[{"name":"3d","utilPct":99.0},{"name":"copy","utilPct":97.0}],
                "nodes":[{"node":0,"utilPct":83.0},{"node":7,"utilPct":6.0}]}));
        h.runtime.start(&start_payload(600, 2)).unwrap();
        h.spawner.run_all();
        let report = h.reports.reports.lock().unwrap().last().cloned().unwrap();
        // The 2 s request clamps to the 10 s minimum duration, so the run samples
        // t=0..9600 ms every 600 ms: 17 samples.
        assert_eq!(report["sampleCount"], json!(17.0));
        assert_eq!(report["effectiveCadenceMs"], json!(600));
        assert_eq!(report["enginePeaks"]["3d"], json!(99.0));
        assert_eq!(report["enginePeaks"]["copy"], json!(97.0));
        assert_eq!(report["nodePeaks"]["0"], json!(83.0));
        assert_eq!(report["nodePeaks"]["7"], json!(6.0));
        let stats = &report["metricStats"];
        assert_eq!(stats["powerW"]["count"], json!(17.0));
        assert_eq!(stats["powerW"]["mean"], json!(100.0));
        assert_eq!(stats["currentTempC"]["max"], json!(60.0));
        assert_eq!(stats["gpuUtilPct"]["min"], json!(95.0));
        // Existing fields keep their names and meaning.
        assert_eq!(report["outcome"], json!("passed"));
        assert_eq!(report["workloadEvidence"], json!(true));
    }

    #[test]
    fn cancellation_and_append_failures_are_reported_without_losing_cleanup_order() {
        let h = harness(Some(target("gpu-a")), |_| good_sample(), json!({}),
            Some(json!({"started":true})), json!({"available":true,"checked":true,"errorCount":0}),
            Some("disk full".into()));
        h.runtime.start(&start_payload(500, 30)).unwrap();
        h.log.lock().unwrap().clear();
        let report = h.runtime.cancel(None);
        assert_eq!(report["outcome"], json!("cancelled"));
        assert_eq!(*h.log.lock().unwrap(), vec!["whea.stop", "append", "workload.stop", "publish"]);
        let published = h.statuses.lock().unwrap().last().cloned().unwrap();
        assert_eq!(published["reason"], json!("cancelled by user; report persistence failed: disk full"));
        assert!(h.runtime.status(None).is_none());
        h.spawner.run_all();
    }

    #[test]
    fn native_report_sink_appends_to_the_stability_store() {
        struct Clock;
        impl StabilityClock for Clock {
            fn now_ms(&self) -> f64 { 1_800_000_000_000.0 }
            fn now_iso(&self) -> &str { "2027-01-15T08:00:00.000Z" }
        }
        let root = std::env::temp_dir().join(format!("arc-stability-sink-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let sink = NativeReportSink::new(root.clone()).unwrap();
        sink.append(&json!({"runId":"run-1","deviceKey":"gpu-a","outcome":"passed","sampleCount":3})).unwrap();
        let store = StabilityStore::new(root.clone(), &Value::Null).unwrap();
        assert_eq!(store.list(&Clock).unwrap()[0]["runId"], json!("run-1"));
        assert_eq!(store.list(&Clock).unwrap()[0]["sampleCount"], json!(3.0));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn exactly_one_device_matches_a_durable_key() {
        let devices = vec![target("gpu-a"), target("gpu-b")];
        assert_eq!(match_device_by_key(&devices, "gpu-a").unwrap()["name"], json!("Intel Arc B580"));
        let alias = json!({"deviceKey":"pnp:test","deviceKeys":["pnp:test","pci:test"]});
        assert_eq!(match_device_by_key(&[alias.clone()], "pci:test").unwrap()["deviceKey"], json!("pnp:test"));
        assert!(match_device_by_key(&[alias.clone(), alias], "pci:test").is_none());
        assert!(match_device_by_key(&devices, "gpu-missing").is_none());
    }
}
