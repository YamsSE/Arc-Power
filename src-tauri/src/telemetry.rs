//! Native LibreHardwareMonitor telemetry lanes. The renderer-facing sample
//! shape and cadence mirror ipc-core's LHM branch; composed samples are also
//! relayed to the compatibility broker so the RTSS OSD publisher stays live
//! until it is ported.
use arc_power_tauri::backend::{
    cpu_frequency::CpuFrequency,
    d3dkmt_util::D3dkmtGpuUtil,
    gpu_devices,
    lhm_bridge::{self, LhmTelemetry},
    memory,
    native_store::NativeStore,
    pawnio,
    pdh_gpu_engine::{self, PdhGpuEngine},
    settings::TELEMETRY_POLL_MS_DEFAULT,
    vendor_telemetry::{vendor_hint_for_target, VendorTelemetry},
    wire::{self, WireValue},
};
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

const DEFAULT_POLL_MS: u64 = TELEMETRY_POLL_MS_DEFAULT;
const MIN_POLL_MS: u64 = 100;
const MAX_POLL_MS: u64 = 2000;

#[derive(Clone, Copy)]
enum VendorChoice { Disabled, Auto, Nvidia, Amd }

fn vendor_choice(target: Option<&Value>) -> VendorChoice {
    match target {
        Some(target) => match vendor_hint_for_target(Some(target)) {
            Some("nvidia") => VendorChoice::Nvidia,
            Some("amd") => VendorChoice::Amd,
            _ => VendorChoice::Disabled,
        },
        None => VendorChoice::Auto,
    }
}

struct Lane {
    latest: Arc<Mutex<Option<Value>>>,
    stop: Arc<AtomicBool>,
    started: bool,
}

pub struct TelemetryHub {
    available: bool,
    lhm: Arc<Mutex<LhmTelemetry>>,
    d3dkmt: Arc<Mutex<D3dkmtGpuUtil>>,
    pdh: Arc<Mutex<Option<PdhGpuEngine>>>,
    host_events: mpsc::SyncSender<(String, String, Value)>,
    main: Mutex<HashMap<Option<u64>, Lane>>,
    overlay: Mutex<HashMap<u64, Lane>>,
    owners: Mutex<HashMap<String, Vec<Value>>>,
    generation: AtomicU64,
}

impl TelemetryHub {
    pub fn new(host_events: mpsc::SyncSender<(String, String, Value)>) -> Self {
        let lhm = LhmTelemetry::new();
        let available = lhm.available();
        Self {
            available,
            lhm: Arc::new(Mutex::new(lhm)),
            d3dkmt: Arc::new(Mutex::new(D3dkmtGpuUtil::new())),
            pdh: Arc::new(Mutex::new(PdhGpuEngine::new())),
            host_events,
            main: Mutex::new(HashMap::new()),
            overlay: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        }
    }

    /// Read-only latest composed sample for a main telemetry lane. Stability
    /// Lab uses this without taking ownership of the renderer's lane.
    pub fn latest_for_device(&self, device_id: u64) -> Option<Value> {
        self.main.lock().ok()?
            .get(&Some(device_id))
            .and_then(|lane| lane.latest.lock().ok().and_then(|value| value.clone()))
    }

    /// Ensure the selected device has a live main telemetry lane. Stability
    /// Lab uses this before sampling instead of silently treating a cold lane
    /// as zero utilization.
    pub fn ensure_for_device(&self, device_id: u64, app: &AppHandle, store: &NativeStore) -> Result<(), String> {
        if !self.available { return Err("main telemetry bridge is unavailable".into()); }
        let mut lanes = self.main.lock().map_err(|_| "telemetry lane lock failed")?;
        if lanes.get(&Some(device_id)).is_some_and(|lane| lane.started) { return Ok(()); }
        if let Some(lane) = lanes.remove(&Some(device_id)) { lane.stop.store(true, Ordering::Release); }
        let target = device_target(device_id).ok_or("selected device is unavailable")?;
        let device_key = target["deviceKey"].as_str().map(str::to_owned);
        let choice = vendor_choice(Some(&target));
        let generation = self.next_generation();
        let lane = spawn_lane(app.clone(), self.lhm.clone(), self.d3dkmt.clone(), self.pdh.clone(),
            self.host_events.clone(), Some(device_id), Some(target), device_key, choice,
            poll_ms(store), generation);
        if !lane.started { return Err("main telemetry lane thread could not start".into()); }
        lanes.insert(Some(device_id), lane);
        Ok(())
    }

    pub fn handle(&self, channel: &str, args: &Value, app: &AppHandle, store: &NativeStore) -> Option<Result<Value, String>> {
        if !self.available { return None; }
        match channel {
            "telemetry-start" => Some(self.telemetry_start(args, app, store)),
            "telemetry-stop" => Some(self.telemetry_stop(args)),
            "telemetry-latest" => Some(self.telemetry_latest(args, app, store)),
            "overlay-telemetry-start" => Some(self.overlay_start(args, app, store)),
            _ => None,
        }
    }

    fn telemetry_start(&self, args: &Value, app: &AppHandle, store: &NativeStore) -> Result<Value, String> {
        let items = args_array(args)?;
        if items.len() > 2 { return Err("telemetry-start expects a device id and optional options".into()); }
        let device_id = match items.first() {
            None | Some(WireValue::Undefined) | Some(WireValue::Null) => None,
            Some(WireValue::Number(number)) => Some(number.as_u64().ok_or("telemetry-start: invalid device id")?),
            _ => return Err("telemetry-start: invalid device id".into()),
        };
        let poll_ms = poll_ms(store);
        let target = device_id.and_then(device_target);
        let device_key = target.as_ref().and_then(|target| target["deviceKey"].as_str().map(str::to_owned));
        let choice = vendor_choice(target.as_ref());
        let _ = self.host_events.try_send(("main".to_owned(), "telemetry-target".to_owned(),
            json!({"target": target.clone().unwrap_or(Value::Null)})));
        self.stop_main(device_id);
        let generation = self.next_generation();
        let lane = spawn_lane(app.clone(), self.lhm.clone(), self.d3dkmt.clone(), self.pdh.clone(), self.host_events.clone(), device_id,
            target, device_key, choice, poll_ms, generation);
        self.main.lock().map_err(|_| "telemetry lane lock failed")?.insert(device_id, lane);
        Ok(undefined())
    }

    fn telemetry_stop(&self, args: &Value) -> Result<Value, String> {
        let items = args_array(args)?;
        if items.len() > 2 { return Err("telemetry-stop expects a device id and optional options".into()); }
        let device_id = match items.first() {
            None | Some(WireValue::Undefined) | Some(WireValue::Null) => None,
            Some(WireValue::Number(number)) => Some(number.as_u64().ok_or("telemetry-stop: invalid device id")?),
            _ => return Err("telemetry-stop: invalid device id".into()),
        };
        self.stop_main(device_id);
        Ok(undefined())
    }

    fn telemetry_latest(&self, args: &Value, app: &AppHandle, store: &NativeStore) -> Result<Value, String> {
        let items = args_array(args)?;
        if items.len() != 1 { return Err("telemetry-latest expects one device id".into()); }
        let WireValue::Number(number) = &items[0] else { return Err("telemetry-latest: invalid device id".into()); };
        let device_id = number.as_u64().ok_or("telemetry-latest: invalid device id")?;
        let existing = self.main.lock().map_err(|_| "telemetry lane lock failed")?
            .get(&Some(device_id)).and_then(|lane| lane.latest.lock().ok().and_then(|value| value.clone()));
        if let Some(sample) = existing { return wire::encode_json(&sample); }
        // A panel can open before the main renderer's first start. Start the
        // missing lane synchronously (the first sample follows on its thread)
        // and return null, matching a cold snapshot.
        let poll_ms = poll_ms(store);
        let target = device_target(device_id);
        let device_key = target.as_ref().and_then(|target| target["deviceKey"].as_str().map(str::to_owned));
        let choice = vendor_choice(target.as_ref());
        let generation = self.next_generation();
        let lane = spawn_lane(app.clone(), self.lhm.clone(), self.d3dkmt.clone(), self.pdh.clone(), self.host_events.clone(), Some(device_id),
            target, device_key, choice, poll_ms, generation);
        self.main.lock().map_err(|_| "telemetry lane lock failed")?.insert(Some(device_id), lane);
        wire::encode_json(&Value::Null)
    }

    fn overlay_start(&self, args: &Value, app: &AppHandle, store: &NativeStore) -> Result<Value, String> {
        let items = args_array(args)?;
        if items.len() != 1 { return Err("overlay-telemetry-start expects one request".into()); }
        let request = items[0].clone().into_json()?;
        let (owner, requests) = match &request {
            Value::Array(values) => ("legacy".to_owned(), values.clone()),
            Value::Object(object) => {
                let owner = object.get("owner").and_then(Value::as_str).map(str::trim)
                    .filter(|owner| !owner.is_empty()).unwrap_or("legacy").to_owned();
                let requests = object.get("deviceKeys").and_then(Value::as_array)
                    .ok_or("overlay telemetry request must contain device keys or device ids")?.clone();
                (owner, requests)
            }
            _ => return Err("overlay telemetry request must contain device keys or device ids".into()),
        };
        if requests.iter().any(|value| !matches!(value, Value::Number(number) if number.as_u64().is_some())
            && !matches!(value, Value::String(text) if !text.is_empty() && text.len() <= 256)) {
            return Err("overlay telemetry request must contain device keys or non-negative device ids".into());
        }
        self.owners.lock().map_err(|_| "telemetry owner lock failed")?.insert(owner, requests);
        let union: Vec<Value> = {
            let owners = self.owners.lock().map_err(|_| "telemetry owner lock failed")?;
            let mut union = Vec::new();
            for value in owners.values().flatten() {
                if !union.contains(value) { union.push(value.clone()); }
            }
            union
        };
        // Stop and reconcile like startOverlayTelemetry: an explicit request
        // replaces the previous secondary-lane set.
        {
            let mut lanes = self.overlay.lock().map_err(|_| "telemetry lane lock failed")?;
            for (_, lane) in lanes.drain() { lane.stop.store(true, Ordering::Release); }
        }
        let devices = device_rows().unwrap_or_default();
        let poll_ms = poll_ms(store);        let mut lanes = self.overlay.lock().map_err(|_| "telemetry lane lock failed")?;
        for request in union {
            let matched = match &request {
                Value::Number(number) => number.as_u64().and_then(|id| devices.iter().find(|device| device["id"].as_u64() == Some(id))),
                Value::String(key) => devices.iter().find(|device| {
                    device["deviceKey"].as_str() == Some(key)
                        || device.get("deviceKeys").and_then(Value::as_array).is_some_and(|keys| keys.iter().any(|value| value.as_str() == Some(key)))
                }),
                _ => None,
            };
            let Some(device) = matched else { continue; };
            let Some(device_id) = device["id"].as_u64() else { continue; };
            if lanes.contains_key(&device_id) { continue; }
            let device_key = device["deviceKey"].as_str().map(str::to_owned);
            let choice = vendor_choice(Some(device));
            let generation = self.next_generation();
            let lane = spawn_lane(app.clone(), self.lhm.clone(), self.d3dkmt.clone(), self.pdh.clone(), self.host_events.clone(), Some(device_id),
                Some(device.clone()), device_key, choice, poll_ms, generation);
            lanes.insert(device_id, lane);
        }
        Ok(undefined())
    }

    fn stop_main(&self, device_id: Option<u64>) {
        if let Ok(mut lanes) = self.main.lock() {
            if let Some(lane) = lanes.remove(&device_id) { lane.stop.store(true, Ordering::Release); }
        }
    }

    fn next_generation(&self) -> u64 { self.generation.fetch_add(1, Ordering::SeqCst) + 1 }
}

fn spawn_lane(
    app: AppHandle,
    lhm: Arc<Mutex<LhmTelemetry>>,
    d3dkmt: Arc<Mutex<D3dkmtGpuUtil>>,
    pdh: Arc<Mutex<Option<PdhGpuEngine>>>,
    host_events: mpsc::SyncSender<(String, String, Value)>,
    device_id: Option<u64>,
    target: Option<Value>,
    device_key: Option<String>,
    vendor_choice: VendorChoice,
    poll_ms: u64,
    generation: u64,
) -> Lane {
    let latest = Arc::new(Mutex::new(None));
    let stop = Arc::new(AtomicBool::new(false));
    let thread_latest = latest.clone();
    let thread_stop = stop.clone();
    let started = thread::Builder::new().name("arc-telemetry".into()).spawn(move || {
        pawnio::ensure_installed_once_async();
        let vendor = match vendor_choice {
            VendorChoice::Disabled => None,
            VendorChoice::Auto => VendorTelemetry::start_for_target(target.as_ref(), None),
            VendorChoice::Nvidia => VendorTelemetry::start_for_target(target.as_ref(), Some("nvidia")),
            VendorChoice::Amd => VendorTelemetry::start_for_target(target.as_ref(), Some("amd")),
        };
        // One estimator per lane: each PDH read then spans this lane's own poll
        // interval instead of racing another lane's collect.
        let mut cpu_frequency = CpuFrequency::new();
        while !thread_stop.load(Ordering::Acquire) {
            let mut sample = compose_sample(&lhm, &mut cpu_frequency, target.as_ref(), device_id, device_key.as_deref(), generation);
            if let Some(vendor) = vendor.as_ref() { merge_vendor(&mut sample, &vendor.sample()); }
            apply_gpu_utilization(&mut sample, target.as_ref(), &d3dkmt, &pdh);
            if let Ok(mut slot) = thread_latest.lock() { *slot = Some(sample.clone()); }
            if let Ok(args) = wire::encode_json(&json!([sample.clone()])) {
                let _ = app.emit("arc-power:broker-event", json!({"channel":"telemetry:sample","args":args}));
            }
            let _ = host_events.try_send(("main".to_owned(), "telemetry-sample".to_owned(), sample));
            let mut remaining = poll_ms;
            while remaining > 0 && !thread_stop.load(Ordering::Acquire) {
                let step = remaining.min(50);
                thread::sleep(Duration::from_millis(step));
                remaining = remaining.saturating_sub(step);
            }
        }
    }).is_ok();
    Lane { latest, stop, started }
}

fn compose_sample(lhm: &Arc<Mutex<LhmTelemetry>>, cpu_frequency: &mut CpuFrequency, target: Option<&Value>, device_id: Option<u64>, device_key: Option<&str>, generation: u64) -> Value {
    // LHM opens its hardware once at bridge startup. Wait to start that bridge
    // until the one-time PawnIO ensure attempt completes, without holding up
    // GPU/PDH sampling or blocking the telemetry-start RPC.
    let payload = pawnio::ensure_attempt_finished()
        .then(|| lhm.lock().ok().and_then(|mut bridge| bridge.sample().ok()))
        .flatten();
    let mut sample = compose_from_payload_with_memory(payload.as_ref(), target, device_id, device_key, generation,
        memory::detect_used_physical_bytes());
    apply_cpu_frequency(&mut sample, cpu_frequency);
    sample
}

/// Fill a missing CPU clock from the PDH estimate. LHM wins whenever it
/// reports a positive core clock; on a machine without the PawnIO driver the
/// estimate keeps `cpuFreqMhz` live and, when even that is unavailable, the
/// field stays absent rather than becoming a fabricated zero.
fn apply_cpu_frequency(sample: &mut Value, cpu_frequency: &mut CpuFrequency) {
    let measured = sample.get("cpuFreqMhz").and_then(Value::as_f64).is_some_and(|mhz| mhz > 0.0);
    if measured { return; }
    let Some(mhz) = cpu_frequency.sample() else { return; };
    let Some(sample) = sample.as_object_mut() else { return; };
    sample.insert("cpuFreqMhz".into(), json!(mhz));
}

#[cfg(test)]
fn compose_from_payload(payload: Option<&Value>, target: Option<&Value>, device_id: Option<u64>, device_key: Option<&str>, generation: u64) -> Value {
    compose_from_payload_with_memory(payload, target, device_id, device_key, generation, None)
}

fn compose_from_payload_with_memory(payload: Option<&Value>, target: Option<&Value>, device_id: Option<u64>, device_key: Option<&str>, generation: u64, memory_used_bytes: Option<u64>) -> Value {
    let mut sample = Map::new();
    sample.insert("t".into(), json!(now_ms()));
    sample.insert("deviceId".into(), device_id.map_or(Value::Null, |id| json!(id)));
    sample.insert("deviceKey".into(), device_key.map_or(Value::Null, |key| json!(key)));
    sample.insert("deviceKeys".into(), device_key.map_or(Value::Null, |key| json!([key])));
    sample.insert("deviceName".into(), target.and_then(|target| target["name"].as_str()).map_or(Value::Null, |name| json!(name)));
    if let Some(vram) = target.and_then(|target| target["vramBytes"].as_f64()).filter(|value| *value > 0.0) {
        sample.insert("vramTotalBytes".into(), json!(vram));
    }
    sample.insert("sessionGeneration".into(), json!(generation));
    if let Some(payload) = payload {
        for (key, value) in lhm_bridge::map_snapshot(payload, target) { sample.insert(key, value); }
    }
    // Match Electron's hybrid lane precedence: a real LHM memory sensor wins;
    // otherwise use the fast GlobalMemoryStatusEx total-minus-available value.
    // When both sources fail, publish null instead of an LHM placeholder.
    if sample.get("memoryUsedBytes").is_none_or(Value::is_null) {
        sample.insert("memoryUsedBytes".into(), memory_used_bytes.map_or(Value::Null, |bytes| json!(bytes as f64)));
    }
    if let Some(util) = sample.get("gpuUtilPct").cloned() { sample.insert("utilPct".into(), util); }
    Value::Object(sample)
}

fn merge_vendor(sample: &mut Value, vendor: &Map<String, Value>) {
    let Some(sample) = sample.as_object_mut() else { return; };
    for (key, value) in vendor { sample.insert(key.clone(), value.clone()); }
    if let Some(utilization) = sample.get("utilPct").cloned() {
        sample.insert("gpuUtilPct".into(), utilization);
        sample.remove("gpuUtilSource");
    }
}

fn apply_gpu_utilization(
    sample: &mut Value,
    target: Option<&Value>,
    d3dkmt: &Arc<Mutex<D3dkmtGpuUtil>>,
    pdh: &Arc<Mutex<Option<PdhGpuEngine>>>,
) {
    let Some(luid) = target.and_then(pdh_gpu_engine::luid_from_target) else { return; };
    let detail = d3dkmt.lock().ok().and_then(|mut reader| reader.sample_detail(luid))
        .filter(|detail| !detail.nodes.is_empty());
    let mut utilization = detail.as_ref().and_then(|detail| detail.nodes.iter().map(|node| node.pct).reduce(f64::max));
    let mut source = "windows-d3dkmt";
    if utilization.is_none() {
        utilization = pdh.lock().ok().and_then(|mut reader| reader.as_mut().and_then(|reader| reader.sample(luid)));
        source = "windows-gpu-engine";
    }
    let Some(utilization) = utilization else { return; };
    let Some(sample) = sample.as_object_mut() else { return; };
    sample.insert("gpuUtilPct".into(), json!(utilization));
    sample.insert("gpuUtilSource".into(), json!(source));
    sample.insert("utilPct".into(), json!(utilization));
    // The numbers behind the scalar: the wall interval and every node's raw
    // tick delta and percentage over it. A Stability run persists these, so the
    // utilization reading can be audited instead of inferred.
    if let Some(detail) = detail {
        sample.insert("gpuUtilWallMs".into(), json!(detail.wall_ms));
        sample.insert("gpuUtilNodes".into(), json!(detail.nodes.iter()
            .map(|node| json!([node.node, node.delta_ticks, node.pct])).collect::<Vec<_>>()));
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as f64).unwrap_or(0.0)
}

fn poll_ms(store: &NativeStore) -> u64 {
    let value = wire::encode_json(&json!([])).ok()
        .and_then(|args| store.invoke("load-settings", &args).ok())
        .and_then(|reply| wire::decode(&reply).ok().and_then(|value| value.into_json().ok()));
    let Some(settings) = value else { return DEFAULT_POLL_MS; };
    let value = settings.get("overlayPollMs").and_then(Value::as_f64).filter(|value| value.is_finite())
        .unwrap_or(DEFAULT_POLL_MS as f64);
    (value.round() as u64).clamp(MIN_POLL_MS, MAX_POLL_MS)
}

fn device_rows() -> Option<Vec<Value>> {
    gpu_devices::list_devices_merged().as_array().cloned()
}

fn device_target(device_id: u64) -> Option<Value> {
    device_rows()?.into_iter().find(|device| device["id"].as_u64() == Some(device_id))
}

fn args_array(args: &Value) -> Result<Vec<WireValue>, String> {
    let WireValue::Array(values) = wire::decode(args)? else { return Err("Expected argument array".into()); };
    Ok(values)
}

fn undefined() -> Value { json!({"t":"undefined"}) }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poll_cadence_is_bounded() {
        // Pure clamp check without a store.
        assert_eq!(DEFAULT_POLL_MS, 600);
        assert_eq!((50_u64).clamp(MIN_POLL_MS, MAX_POLL_MS), MIN_POLL_MS);
        assert_eq!((5000_u64).clamp(MIN_POLL_MS, MAX_POLL_MS), MAX_POLL_MS);
        assert_eq!((500_u64).clamp(MIN_POLL_MS, MAX_POLL_MS), 500);
    }

    #[test]
    fn argument_shapes_reject_malformed_requests() {
        assert!(args_array(&json!({"t":"null"})).is_err());
        assert!(args_array(&json!({"t":"array","v":[]})).is_ok());
        assert_eq!(undefined(), json!({"t":"undefined"}));
    }

    #[test]
    fn vendor_samples_override_matching_fields_and_own_utilization() {
        let mut sample = json!({"gpuUtilPct": 10.0, "gpuUtilSource": "libre-hardware-monitor", "tempC": 50.0});
        let mut vendor = Map::new();
        vendor.insert("utilPct".into(), json!(65.0));
        vendor.insert("powerW".into(), json!(120.0));
        merge_vendor(&mut sample, &vendor);
        assert_eq!(sample["gpuUtilPct"], 65.0);
        assert_eq!(sample["utilPct"], 65.0);
        assert_eq!(sample["powerW"], 120.0);
        assert_eq!(sample["tempC"], 50.0);
        assert!(sample.get("gpuUtilSource").is_none());
    }

    #[test]
    fn latest_for_device_reads_only_the_matching_main_lane() {
        let (sender, _receiver) = mpsc::sync_channel(1);
        let hub = TelemetryHub::new(sender);
        assert!(hub.latest_for_device(7).is_none());
        let lane = Lane {
            latest: Arc::new(Mutex::new(Some(json!({"deviceId":7,"gpuUtilPct":88.0})))),
            stop: Arc::new(AtomicBool::new(false)),
            started: true,
        };
        hub.main.lock().unwrap().insert(Some(7), lane);
        assert_eq!(hub.latest_for_device(7).unwrap()["gpuUtilPct"], 88.0);
        assert!(hub.latest_for_device(8).is_none());
    }

    #[test]
    fn sample_shape_matches_the_renderer_contract() {
        let payload = json!({"ok":true,"hardware":[
            {"type":"Cpu","sensors":[{"type":"Load","name":"CPU Total","value":20.0}]},
            {"type":"GpuIntel","identifier":"/gpu-intel/0/0x56a0","sensors":[
                {"type":"Load","name":"GPU Core","value":44.0,"fresh":true},
                {"type":"Power","name":"GPU Package","value":150.0}
            ]}
        ]});
        let target = json!({"name":"Intel Arc B580","pciVendorId":"0x8086","pciDeviceId":"0x56a0"});
        let sample = compose_from_payload(Some(&payload), Some(&target), Some(2), Some("pci:0x8086:0x56a0@3:0.0"), 9);
        assert_eq!(sample["deviceId"], 2);
        assert_eq!(sample["deviceKey"], "pci:0x8086:0x56a0@3:0.0");
        assert_eq!(sample["deviceKeys"], json!(["pci:0x8086:0x56a0@3:0.0"]));
        assert_eq!(sample["deviceName"], "Intel Arc B580");
        assert_eq!(sample["sessionGeneration"], 9);
        assert_eq!(sample["cpuUtilPct"], 20.0);
        assert_eq!(sample["gpuUtilPct"], 44.0);
        assert_eq!(sample["utilPct"], 44.0);
        assert_eq!(sample["powerW"], 150.0);
        let system = compose_from_payload(None, None, None, None, 10);
        assert_eq!(system["deviceId"], Value::Null);
        assert_eq!(system["deviceKey"], Value::Null);
        assert!(system.get("cpuUtilPct").is_none());
    }

    #[test]
    fn system_memory_fallback_matches_hybrid_precedence_and_degrades_to_null() {
        let lhm_payload = json!({"ok":true,"hardware":[
            {"type":"Memory","name":"Total Memory","sensors":[
                {"type":"Data","name":"Memory Used","value":12.0}
            ]}
        ]});
        let lhm_sample = compose_from_payload_with_memory(Some(&lhm_payload), None, None, None, 11, Some(12_400_000_000));
        assert_eq!(lhm_sample["memoryUsedBytes"], 12.0 * 1024_f64.powi(3),
            "a real LHM value keeps Electron's hybrid-lane precedence");

        let no_lhm_memory = json!({"ok":true,"hardware":[]});
        let mut sampled = compose_from_payload_with_memory(Some(&no_lhm_memory), None, None, None, 12, Some(12_400_000_000));
        assert_eq!(sampled["memoryUsedBytes"], 12_400_000_000_f64);
        let mut vendor = Map::new();
        vendor.insert("gpuMemUsedBytes".into(), json!(512 * 1024 * 1024_u64));
        merge_vendor(&mut sampled, &vendor);
        assert_eq!(sampled["memoryUsedBytes"], 12_400_000_000_f64,
            "the native null-device vendor lane keeps VRAM separate from system RAM");
        assert_eq!(sampled["gpuMemUsedBytes"], 512 * 1024 * 1024_u64);

        let unavailable = compose_from_payload_with_memory(Some(&no_lhm_memory), None, None, None, 13, None);
        assert_eq!(unavailable["memoryUsedBytes"], Value::Null,
            "failed system and LHM samples degrade to null");
    }

    #[test]
    fn missing_lhm_clock_falls_back_to_the_pdh_estimate_but_never_to_zero() {
        use arc_power_tauri::backend::cpu_frequency::PerformancePercent;
        struct Fixed(Option<f64>);
        impl PerformancePercent for Fixed {
            fn read_percent(&mut self) -> Option<f64> { self.0 }
        }
        let reader = || CpuFrequency::with_percent(Some(3301), Some(Box::new(Fixed(Some(130.0)))));

        // No PawnIO driver: LHM reports no CPU clock, so the estimate fills in.
        let mut sample = json!({"cpuUtilPct": 18.0, "cpuTempC": Value::Null});
        apply_cpu_frequency(&mut sample, &mut reader());
        assert_eq!(sample["cpuFreqMhz"], 4291.0);
        assert!(sample["cpuTempC"].is_null(), "temperature keeps degrading to null");

        // An LHM zero is not a measurement: replace it with the estimate.
        let mut zeroed = json!({"cpuFreqMhz": 0.0});
        apply_cpu_frequency(&mut zeroed, &mut reader());
        assert_eq!(zeroed["cpuFreqMhz"], 4291.0);

        // A positive LHM core clock always wins.
        let mut measured = json!({"cpuFreqMhz": 4000.0});
        apply_cpu_frequency(&mut measured, &mut reader());
        assert_eq!(measured["cpuFreqMhz"], 4000.0);

        // Without a counter or base clock the field is omitted, never 0.0.
        let mut absent = json!({});
        let mut unavailable = CpuFrequency::with_percent(Some(3301), None);
        apply_cpu_frequency(&mut absent, &mut unavailable);
        assert!(absent.get("cpuFreqMhz").is_none(), "an unavailable estimate is omitted, not zeroed");
    }
}
