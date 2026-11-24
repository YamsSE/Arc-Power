//! Read-only LibreHardwareMonitor bridge and snapshot mapper. Ports
//! src/main/telemetry/lhm-provider.js; the bridge is a separate executable, so
//! no managed runtime or hardware handle enters this process.
use serde_json::{json, Map, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

const SAMPLE_TTL: Duration = Duration::from_millis(300);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);

pub fn locate_bridge() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("ARC_POWER_LHM_BRIDGE") { candidates.push(PathBuf::from(path)); }
    if let Some(root) = std::env::current_exe().ok().and_then(|path| path.parent().map(std::path::Path::to_path_buf)) {
        candidates.push(root.join("resources/lhm/ArcPower.LhmBridge.exe"));
        candidates.push(root.join("compatibility-backend/resources/lhm/ArcPower.LhmBridge.exe"));
        candidates.push(root.join("compatibility-backend/resources/app.asar.unpacked/src/main/telemetry/lhm-runtime/ArcPower.LhmBridge.exe"));
        candidates.push(root.join("compatibility-backend/src/main/telemetry/lhm-runtime/ArcPower.LhmBridge.exe"));
    }
    candidates.push(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()
        .join("src/main/telemetry/lhm-runtime/ArcPower.LhmBridge.exe"));
    candidates.into_iter().find(|path| path.is_file())
}

enum Request {
    Sample(mpsc::SyncSender<Result<Value, String>>),
    Close(mpsc::SyncSender<()>),
}

struct Bridge {
    child: Arc<Mutex<Child>>,
    requests: Option<mpsc::SyncSender<Request>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Bridge {
    fn start(executable: &PathBuf) -> Result<Self, String> {
        let mut command = Command::new(executable);
        command.current_dir(executable.parent().ok_or("LHM bridge has no parent directory")?)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|error| format!("cannot start LibreHardwareMonitor bridge: {error}"))?;
        let stdin = child.stdin.take().ok_or("LHM bridge stdin unavailable")?;
        let stdout = child.stdout.take().ok_or("LHM bridge stdout unavailable")?;
        let child = Arc::new(Mutex::new(child));
        let (requests, receiver) = mpsc::sync_channel(4);
        let worker_child = child.clone();
        let worker = match thread::Builder::new().name("arc-lhm-bridge".into()).spawn(move || {
            let mut stdin = stdin;
            let mut stdout = BufReader::new(stdout);
            while let Ok(request) = receiver.recv() {
                match request {
                    Request::Sample(reply) => {
                        let result = stdin.write_all(b"{\"op\":\"sample\"}\n")
                            .and_then(|_| stdin.flush())
                            .map_err(|error| format!("LibreHardwareMonitor bridge write failed: {error}"))
                            .and_then(|_| {
                                let mut line = String::new();
                                match stdout.read_line(&mut line) {
                                    Ok(0) => Err("LibreHardwareMonitor bridge stopped".to_owned()),
                                    Ok(_) => serde_json::from_str::<Value>(line.trim())
                                        .map_err(|_| "LibreHardwareMonitor bridge returned invalid JSON".to_owned())
                                        .and_then(|value| if value["ok"] == true { Ok(value) }
                                            else { Err(value["error"].as_str().unwrap_or("LibreHardwareMonitor bridge error").to_owned()) }),
                                    Err(error) => Err(format!("LibreHardwareMonitor bridge read failed: {error}")),
                                }
                            });
                        let _ = reply.send(result);
                    }
                    Request::Close(reply) => {
                        if let Ok(mut child) = worker_child.lock() { let _ = child.kill(); let _ = child.wait(); }
                        let _ = reply.send(());
                        return;
                    }
                }
            }
        }) {
            Ok(worker) => worker,
            Err(error) => {
                if let Ok(mut child) = child.lock() { let _ = child.kill(); let _ = child.wait(); }
                return Err(format!("cannot start LHM bridge worker: {error}"));
            }
        };
        let bridge = Self { child, requests: Some(requests), worker: Some(worker) };
        bridge.request()?;
        Ok(bridge)
    }
    fn request(&self) -> Result<Value, String> {
        let (reply, response) = mpsc::sync_channel(1);
        self.requests.as_ref().ok_or("LibreHardwareMonitor bridge is closed")?
            .send(Request::Sample(reply)).map_err(|_| "LibreHardwareMonitor bridge worker is unavailable".to_owned())?;
        response.recv_timeout(REQUEST_TIMEOUT).map_err(|_| "LibreHardwareMonitor sample timed out".to_owned())?
    }
    fn stop(&mut self) {
        if let Some(requests) = self.requests.take() {
            if let Ok(mut child) = self.child.lock() { let _ = child.kill(); }
            let (reply, response) = mpsc::sync_channel(1);
            let _ = requests.send(Request::Close(reply));
            let _ = response.recv_timeout(Duration::from_secs(2));
        }
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}
impl Drop for Bridge { fn drop(&mut self) { self.stop(); } }

/// Shared, TTL-cached bridge. A failed read closes the bridge so the next lane
/// tick can restart it without reusing a desynchronized JSON stream.
pub struct LhmTelemetry {
    executable: Option<PathBuf>,
    bridge: Option<Bridge>,
    latest: Option<(Instant, Value)>,
}
impl LhmTelemetry {
    pub fn new() -> Self { Self { executable: locate_bridge(), bridge: None, latest: None } }
    pub fn available(&self) -> bool { self.executable.is_some() }
    pub fn sample(&mut self) -> Result<Value, String> {
        if let Some((at, value)) = &self.latest {
            if at.elapsed() <= SAMPLE_TTL { return Ok(value.clone()); }
        }
        if self.bridge.is_none() {
            let executable = self.executable.as_ref().ok_or("LibreHardwareMonitor bridge is not packaged")?;
            self.bridge = Some(Bridge::start(executable)?);
        }
        let result = self.bridge.as_ref().unwrap().request();
        if result.is_err() { self.bridge = None; }
        let value = result?;
        self.latest = Some((Instant::now(), value.clone()));
        Ok(value)
    }
}

fn finite(value: Option<&Value>) -> Option<f64> { value.and_then(Value::as_f64).filter(|value| value.is_finite()) }
fn text(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty()).map(str::to_owned)
}
fn hardware_type(row: &Value) -> String { text(row.get("type")).map(|value| value.to_lowercase()).unwrap_or_default() }
fn sensor_type(sensor: &Value) -> String { text(sensor.get("type")).map(|value| value.to_lowercase()).unwrap_or_default() }
fn sensor_name(sensor: &Value) -> String { text(sensor.get("name")).map(|value| value.to_lowercase()).unwrap_or_default() }
fn sensor_value(sensor: &Value) -> Option<f64> { finite(sensor.get("value")) }

fn first_value(sensors: &[&Value], predicate: impl Fn(&Value) -> bool) -> Option<f64> {
    sensors.iter().filter(|sensor| predicate(sensor)).find_map(|sensor| sensor_value(sensor))
}
fn average(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}
fn sensors_of(row: &Value) -> Vec<&Value> {
    row.get("sensors").and_then(Value::as_array).map(|rows| rows.iter().collect()).unwrap_or_default()
}

fn digits_at_end(value: &str) -> Option<String> {
    let digits: String = value.chars().rev().take_while(|character| character.is_ascii_hexdigit())
        .collect::<Vec<_>>().into_iter().rev().collect();
    if digits.is_empty() { return None; }
    let digits = digits.trim_start_matches('0').to_ascii_lowercase();
    Some(if digits.is_empty() { "0000".to_owned() } else { format!("{digits:0>4}") })
}
fn number_suffix(value: Option<&Value>) -> Option<String> {
    match value {
        Some(Value::Number(number)) => number.as_u64().map(|number| format!("{number:x}")),
        Some(Value::String(value)) => Some(value.trim().to_owned()),
        _ => None,
    }.and_then(|text| digits_at_end(&text))
}
fn target_pci_device(target: Option<&Value>) -> Option<String> {
    let target = target?;
    number_suffix(target.get("pciDeviceId")).or_else(|| number_suffix(target.get("deviceIdHex")))
}
fn target_pci_vendor(target: Option<&Value>) -> Option<String> { number_suffix(target?.get("pciVendorId")) }

fn normalize_id(value: &str) -> String {
    let value = value.trim_start_matches('0');
    format!("{value:0>4}")
}
fn identifier_device_id(identifier: &str) -> Option<String> {
    identifier.split('/').find_map(|part| {
        let part = part.trim();
        let digits = part.strip_prefix("0x")?;
        let digits: String = digits.chars().take(8).collect();
        (!digits.is_empty() && digits.chars().all(|character| character.is_ascii_hexdigit()))
            .then(|| normalize_id(&digits))
    })
}

fn is_cpu_core_clock(sensor: &Value) -> bool {
    // LHM also exposes the front-side bus as a plain `Clock` sensor named
    // "Bus Speed"; a 100 MHz FSB must never become the CPU clock ("0.1 GHz").
    if sensor_type(sensor) != "clock" { return false; }
    let name = sensor_name(sensor);
    name.contains("cpu core") || name.contains("core #")
}

fn map_system(hardware: &[&Value], out: &mut Map<String, Value>) {
    if let Some(cpu) = hardware.iter().find(|row| hardware_type(row) == "cpu") {
        let sensors = sensors_of(cpu);
        if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "load"
            && sensor_name(sensor).contains("cpu total")) { out.insert("cpuUtilPct".into(), json!(value)); }
        // Ryzen reports Core (Tdie) or Core (Tctl/Tdie), rather than the
        // Intel-style CPU Package. Prefer the die temperature over Tctl when
        // both are exposed because some older Ryzen models offset Tctl.
        let cpu_temp = ["core (tdie)", "core (tctl/tdie)", "core max", "cpu package", "cpu core"]
            .iter().find_map(|name| first_value(&sensors, |sensor| sensor_type(sensor) == "temperature"
                && sensor_name(sensor).contains(name)));
        if let Some(value) = cpu_temp {
            out.insert("cpuTempC".into(), json!(value));
        }
        let clocks: Vec<f64> = sensors.iter().filter(|sensor| is_cpu_core_clock(sensor))
            .filter_map(|sensor| sensor_value(sensor)).filter(|value| *value > 0.0).collect();
        if let Some(value) = average(&clocks) { out.insert("cpuFreqMhz".into(), json!(value)); }
        // Without the PawnIO kernel driver LHM's MSR power sensor still exists
        // but reads 0.0. Publish nothing rather than a fabricated "0.0 W"
        // (src/main/sys-stats.js:305 does the same for its power meter).
        if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "power"
            && (sensor_name(sensor).contains("cpu package") || sensor_name(sensor) == "package")).filter(|value| *value > 0.0) {
            out.insert("cpuPowerW".into(), json!(value));
        }
    }
    let memory = hardware.iter().find(|row| hardware_type(row) == "memory"
        && text(row.get("name")).is_some_and(|name| name.to_lowercase().contains("total memory")))
        .or_else(|| hardware.iter().find(|row| hardware_type(row) == "memory"));
    if let Some(memory) = memory {
        let sensors = sensors_of(memory);
        if let Some(gib) = first_value(&sensors, |sensor| sensor_type(sensor) == "data"
            && sensor_name(sensor).contains("memory used")) {
            out.insert("memoryUsedBytes".into(), json!(gib * 1024_f64.powi(3)));
        }
    }
}

fn gpu_matches(hardware: &Value, target: Option<&Value>, all_gpus: &[&Value]) -> bool {
    let Some(identifier) = text(hardware.get("identifier")).map(|value| value.to_lowercase()) else { return false; };
    if !identifier.contains("gpu-") { return false; }
    let Some(wanted) = target_pci_device(target) else { return false; };
    if identifier_device_id(&identifier).as_deref() != Some(wanted.as_str()) { return false; }
    let same_device = all_gpus.iter().filter(|row| {
        text(row.get("identifier")).map(|value| value.to_lowercase())
            .and_then(|value| identifier_device_id(&value)).as_deref() == Some(wanted.as_str())
    }).count();
    if same_device != 1 { return false; }
    let Some(vendor) = target_pci_vendor(target) else { return true; };
    let expected = match vendor.as_str() { "8086" => "gpu-intel", "1002" => "gpu-amd", "10de" => "gpu-nvidia", _ => "gpu-" };
    identifier.contains(expected)
}

fn map_gpu(hardware: &[&Value], target: Option<&Value>, out: &mut Map<String, Value>) {
    let gpus: Vec<&Value> = hardware.iter().filter(|row| hardware_type(row).starts_with("gpu")).copied().collect();
    let Some(gpu) = gpus.iter().find(|row| gpu_matches(row, target, &gpus)) else { return; };
    let sensors = sensors_of(gpu);
    if hardware_type(gpu) == "gpuintel" {
        if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "load"
            && sensor_name(sensor) == "gpu core" && sensor.get("fresh") == Some(&Value::Bool(true))) {
            if (0.0..=100.0).contains(&value) {
                out.insert("gpuUtilPct".into(), json!(value));
                out.insert("gpuUtilSource".into(), json!("libre-hardware-monitor"));
            }
        }
    }
    if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "clock" && sensor_name(sensor) == "gpu core") {
        out.insert("gpuClockMhz".into(), json!(value));
    }
    if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "clock"
        && ["gpu memory", "memory clock", "vram"].iter().any(|name| sensor_name(sensor).contains(name))) {
        out.insert("memClockMhz".into(), json!(value));
    }
    if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "temperature"
        && ["gpu core", "gpu package", "gpu"].iter().any(|name| sensor_name(sensor).contains(name))) {
        out.insert("tempC".into(), json!(value));
    }
    if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "temperature"
        && ["vram", "gpu memory", "memory junction"].iter().any(|name| sensor_name(sensor).contains(name))) {
        out.insert("vramTempC".into(), json!(value));
    }
    if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "voltage"
        && ["gpu core", "gpu"].iter().any(|name| sensor_name(sensor).contains(name))) {
        out.insert("gpuVoltageV".into(), json!(value));
    }
    if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "power"
        && ["gpu package", "gpu power", "gpu"].iter().any(|name| sensor_name(sensor).contains(name))) {
        out.insert("powerW".into(), json!(value));
    }
    if let Some(value) = first_value(&sensors, |sensor| sensor_type(sensor) == "fan"
        && ["gpu fan", "gpu"].iter().any(|name| sensor_name(sensor).contains(name))) {
        out.insert("fanRpm".into(), json!([value]));
    }
    if let Some(value) = first_value(&sensors, |sensor| (sensor_type(sensor) == "smalldata" || sensor_type(sensor) == "data")
        && ["gpu memory used", "memory used", "vram used"].iter().any(|name| sensor_name(sensor).contains(name))) {
        out.insert("gpuMemUsedBytes".into(), json!(value * 1024_f64.powi(2)));
    }
}

/// Map an LHM payload exactly as the Electron provider does, omitting unsupported
/// (null) fields so the caller can merge without erasing another source.
pub fn map_snapshot(payload: &Value, target: Option<&Value>) -> Map<String, Value> {
    let mut out = Map::new();
    let Some(hardware) = payload.get("hardware").and_then(Value::as_array) else { return out; };
    let hardware: Vec<&Value> = hardware.iter().collect();
    map_system(&hardware, &mut out);
    map_gpu(&hardware, target, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn payload() -> Value {
        json!({"ok":true,"hardware":[
            {"type":"Cpu","sensors":[
                {"type":"Load","name":"CPU Total","value":23.0},
                {"type":"Temperature","name":"CPU Package","value":55.0},
                {"type":"Clock","name":"CPU Core #1","value":4000.0},
                {"type":"Clock","name":"CPU Core #2","value":4200.0},
                {"type":"Power","name":"CPU Package","value":65.0}
            ]},
            {"type":"Memory","name":"Total Memory","sensors":[
                {"type":"Data","name":"Memory Used","value":12.0}
            ]},
            {"type":"GpuIntel","identifier":"/gpu-intel/0/0x56a0","sensors":[
                {"type":"Load","name":"GPU Core","value":42.0,"fresh":true},
                {"type":"Clock","name":"GPU Core","value":2400.0},
                {"type":"Temperature","name":"GPU Core","value":61.0},
                {"type":"Power","name":"GPU Package","value":180.0},
                {"type":"Fan","name":"GPU Fan","value":1300.0},
                {"type":"SmallData","name":"GPU Memory Used","value":2048.0}
            ]}
        ]})
    }
    #[test]
    fn maps_system_and_matching_gpu_fields() {
        let target = json!({"pciVendorId":"0x00008086","pciDeviceId":"0x000056a0"});
        let mapped = map_snapshot(&payload(), Some(&target));
        assert_eq!(mapped["cpuUtilPct"], 23.0);
        assert_eq!(mapped["cpuTempC"], 55.0);
        assert_eq!(mapped["cpuFreqMhz"], 4100.0);
        assert_eq!(mapped["cpuPowerW"], 65.0);
        assert_eq!(mapped["memoryUsedBytes"], 12.0 * 1024_f64.powi(3));
        assert_eq!(mapped["gpuUtilPct"], 42.0);
        assert_eq!(mapped["gpuUtilSource"], "libre-hardware-monitor");
        assert_eq!(mapped["gpuClockMhz"], 2400.0);
        assert_eq!(mapped["tempC"], 61.0);
        assert_eq!(mapped["powerW"], 180.0);
        assert_eq!(mapped["fanRpm"], json!([1300.0]));
        assert_eq!(mapped["gpuMemUsedBytes"], 2048.0 * 1024_f64.powi(2));
    }
    #[test]
    fn refuses_ambiguous_or_mismatched_gpu_identity() {
        let target = json!({"pciVendorId":"0x00008086","pciDeviceId":"0x000056a0"});
        assert!(map_snapshot(&payload(), Some(&json!({"pciDeviceId":"0x000056a1"}))).get("gpuClockMhz").is_none());
        let mut duplicated = payload();
        let gpu = duplicated["hardware"][2].clone();
        duplicated["hardware"].as_array_mut().unwrap().push(gpu);
        assert!(map_snapshot(&duplicated, Some(&target)).get("gpuClockMhz").is_none());
    }
    #[test]
    fn no_target_keeps_system_values_but_not_gpu_values() {
        let mapped = map_snapshot(&payload(), None);
        assert_eq!(mapped["cpuUtilPct"], 23.0);
        assert!(mapped.get("gpuClockMhz").is_none());
    }
    #[test]
    fn maps_ryzen_die_temperature_and_package_power() {
        let mut fixture = payload();
        fixture["hardware"][0]["sensors"] = json!([
            {"type":"Temperature","name":"Core (Tctl)","value":75.0},
            {"type":"Temperature","name":"Core (Tdie)","value":55.0},
            {"type":"Temperature","name":"Core (Tctl/Tdie)","value":60.0},
            {"type":"Power","name":"Package","value":85.0}
        ]);
        let mapped = map_snapshot(&fixture, None);
        assert_eq!(mapped["cpuTempC"], 55.0);
        assert_eq!(mapped["cpuPowerW"], 85.0);
        fixture["hardware"][0]["sensors"][1]["value"] = Value::Null;
        assert_eq!(map_snapshot(&fixture, None)["cpuTempC"], 60.0);
    }
    #[test]
    fn fresh_gate_only_applies_to_intel_gpu_load() {
        let mut stale = payload();
        stale["hardware"][2]["sensors"][0]["fresh"] = json!(false);
        let target = json!({"pciVendorId":"0x00008086","pciDeviceId":"0x000056a0"});
        assert!(map_snapshot(&stale, Some(&target)).get("gpuUtilPct").is_none());
    }
    #[test]
    fn non_positive_cpu_power_is_omitted_instead_of_published_as_zero() {
        // Without the PawnIO kernel driver LHM's MSR power sensor still exists
        // but reads 0.0. Electron publishes nothing there (sys-stats.js:305)
        // because a fabricated "0.0 W" is worse than the honest "-".
        for value in [0.0, -1.0] {
            let mut fixture = payload();
            fixture["hardware"][0]["sensors"][4]["value"] = json!(value);
            let mapped = map_snapshot(&fixture, None);
            assert!(mapped.get("cpuPowerW").is_none(), "{value} W must not be published");
            assert_eq!(mapped["cpuTempC"], 55.0, "the other sensors stay mapped");
        }
        assert_eq!(map_snapshot(&payload(), None)["cpuPowerW"], 65.0, "a positive value passes through unchanged");
    }
    #[test]
    fn bus_speed_and_zero_core_clocks_never_become_the_cpu_clock() {
        // LHM exposes the FSB as a plain "Bus Speed" clock sensor. The broad
        // clock fallback turned its 100 MHz into "0.1 GHz".
        let mut fixture = payload();
        fixture["hardware"][0]["sensors"] = json!([
            {"type":"Load","name":"CPU Total","value":12.0},
            {"type":"Clock","name":"Bus Speed","value":100.0},
            {"type":"Clock","name":"CPU Core #1","value":0.0}
        ]);
        let mapped = map_snapshot(&fixture, None);
        assert!(mapped.get("cpuFreqMhz").is_none(), "a bus-speed or zero core clock is not a CPU frequency");
        // AMD-style core names still average into the reported clock.
        fixture["hardware"][0]["sensors"].as_array_mut().unwrap()
            .push(json!({"type":"Clock","name":"Core #1","value":3800.0}));
        assert_eq!(map_snapshot(&fixture, None)["cpuFreqMhz"], 3800.0);
    }
}
