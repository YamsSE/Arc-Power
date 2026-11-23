//! Read-only native system inventory for `sysinfo:get`.
//!
//! The renderer degrades every unknown field to '-' (see `pure/sysinfo.ts`),
//! so a capability we cannot prove natively is reported as null rather than
//! guessed. No driver state is written here.

use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use super::{gpu_devices, memory, native_store::NativeStore, os_gpu_inventory, windows_display_modes};

static WMI_SNAPSHOT: OnceLock<Option<Value>> = OnceLock::new();
static D3D12_EVIDENCE: OnceLock<Mutex<D3d12Evidence>> = OnceLock::new();
const D3D12_HELPER_NAME: &str = "ArcPower.D3D12UploadHeapQuery.exe";
const D3D12_MAX_TARGETS: usize = 16;
const D3D12_MAX_OUTPUT_BYTES: usize = 4096;
const D3D12_TIMEOUT: Duration = Duration::from_millis(4000);

#[derive(Default)]
struct D3d12Evidence {
    started: bool,
    positive_keys: HashSet<String>,
}

#[derive(Clone)]
struct D3d12Target {
    bdf: String,
    vendor_id: u16,
    device_id: u16,
}

impl D3d12Target {
    fn key(&self) -> String {
        format!("{}|{}|{}", self.bdf, self.vendor_id, self.device_id)
    }

    fn input_line(&self) -> String {
        format!("{},{:04x},{:04x}\n", self.bdf, self.vendor_id, self.device_id)
    }
}

/// One cached read-only CIM collection per process, mirroring Electron's
/// `sysinfo.js`. PowerShell is a Windows component, not an app dependency.
fn wmi_snapshot() -> Option<Value> {
    WMI_SNAPSHOT.get_or_init(|| {
        let script = concat!(
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8;",
            "$ErrorActionPreference='SilentlyContinue';",
            "$cpu=Get-CimInstance Win32_Processor|Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed;",
            "$mem=Get-CimInstance Win32_PhysicalMemory|Select-Object -First 1 Manufacturer,ConfiguredClockSpeed,SMBIOSMemoryType;",
            "$bb=Get-CimInstance Win32_BaseBoard|Select-Object -First 1 Manufacturer,Product;",
            "$controllers=@(Get-CimInstance Win32_VideoController|Select-Object DeviceID,PNPDeviceID);",
            "$ranges=@(Get-CimInstance Win32_DeviceMemoryAddress -OperationTimeoutSec 2|ForEach-Object{[pscustomobject]@{S=[string]$_.StartingAddress;E=[string]$_.EndingAddress}});",
            "$alloc=@(Get-CimInstance Win32_AllocatedResource -OperationTimeoutSec 2|ForEach-Object{[pscustomobject]@{D=[string]$_.Dependent;A=[string]$_.Antecedent}});",
            "[pscustomobject]@{cpu=$cpu;physicalMemory=$mem;baseboard=$bb;controllers=$controllers;ranges=$ranges;allocations=$alloc}|ConvertTo-Json -Depth 4 -Compress",
        );
        let mut command = std::process::Command::new(
            "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let output = command.output().ok()?;
        if !output.status.success() { return None; }
        let parsed: Value = serde_json::from_slice(&output.stdout).ok()?;
        // Keep only the exact CIM identities and the two sides of each
        // allocation association needed for per-controller ReBAR fallback.
        let controllers = parsed.get("controllers").cloned().unwrap_or_else(|| json!([]));
        let allocations: Vec<Value> = parsed.get("allocations").and_then(Value::as_array)
            .map(|items| items.iter().map(|item| json!({
                "dependent": item.get("D").cloned().unwrap_or(Value::Null),
                "antecedent": item.get("A").cloned().unwrap_or(Value::Null),
            })).collect())
            .unwrap_or_default();
        let ranges = parsed.get("ranges").cloned().unwrap_or_else(|| json!([]));
        Some(json!({
            "cpu": parsed.get("cpu").cloned().unwrap_or(Value::Null),
            "physicalMemory": parsed.get("physicalMemory").cloned().unwrap_or(Value::Null),
            "baseboard": parsed.get("baseboard").cloned().unwrap_or(Value::Null),
            "controllers": controllers,
            "allocations": allocations,
            "ranges": ranges,
        }))
    }).clone()
}

fn cim_reference_field(value: &str, class_name: &str, field_name: &str) -> Option<String> {
    let lower = value.to_ascii_lowercase();
    let class = class_name.to_ascii_lowercase();
    let class_start = lower.find(&class)?;
    let tail_start = class_start.checked_add(class_name.len())?;
    let tail = &value[tail_start..];
    let lower_tail = tail.to_ascii_lowercase();
    let field = field_name.to_ascii_lowercase();
    let mut search_from = 0usize;
    let field_start = loop {
        let found = lower_tail[search_from..].find(&field)? + search_from;
        let before_ok = found == 0 || !lower_tail.as_bytes()[found - 1].is_ascii_alphanumeric()
            && lower_tail.as_bytes()[found - 1] != b'_';
        let after = found.checked_add(field.len())?;
        let after_ok = after == lower_tail.len() || !lower_tail.as_bytes()[after].is_ascii_alphanumeric()
            && lower_tail.as_bytes()[after] != b'_';
        if before_ok && after_ok { break found; }
        search_from = after;
    };
    let mut rhs = &tail[field_start + field_name.len()..];
    rhs = rhs.trim_start();
    rhs = rhs.strip_prefix('=')?.trim_start();
    if let Some(quote) = rhs.chars().next().filter(|ch| *ch == '"' || *ch == '\'') {
        rhs = &rhs[quote.len_utf8()..];
        let end = rhs.find(quote)?;
        Some(rhs[..end].replace("\\\\", "\\"))
    } else {
        let end = rhs.find(|ch: char| ch == ',' || ch == ')' || ch.is_whitespace()).unwrap_or(rhs.len());
        Some(rhs[..end].replace("\\\\", "\\"))
    }
}

fn text_eq_ci(left: Option<&str>, right: &str) -> bool {
    left.is_some_and(|value| value.trim().eq_ignore_ascii_case(right.trim()))
}

fn parse_address(value: Option<&Value>) -> Option<u64> {
    let text = value?.as_str()?.trim();
    if let Some(hex) = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")) {
        u64::from_str_radix(hex, 16).ok()
    } else {
        text.parse().ok()
    }
}

/// Match Electron's exact CIM association fallback: resolve an allocation to
/// one Win32_VideoController (or PnPEntity) by its full identity, then join
/// that allocation's memory-address range. A large range is positive proof;
/// missing or small ranges remain unknown.
fn rebar_from_wmi(snapshot: &Value, pnp_device_id: &str) -> Option<bool> {
    let controllers = snapshot.get("controllers")?.as_array()?;
    let mut matching_controllers = controllers.iter().filter(|controller| {
        text_eq_ci(controller.get("PNPDeviceID").and_then(Value::as_str), pnp_device_id)
    });
    let controller = matching_controllers.next()?;
    if matching_controllers.next().is_some() { return None; }
    let controller_id = controller.get("DeviceID").and_then(Value::as_str)?;
    let allocations = snapshot.get("allocations")?.as_array()?;
    let ranges = snapshot.get("ranges")?.as_array()?;
    let mut max_bytes = 0u64;

    for allocation in allocations {
        let Some(dependent) = allocation.get("dependent").and_then(Value::as_str) else { continue; };
        let dependent_controller = cim_reference_field(dependent, "Win32_VideoController", "DeviceID");
        let dependent_pnp = dependent_controller.is_none()
            .then(|| cim_reference_field(dependent, "Win32_PnPEntity", "DeviceID"))
            .flatten();
        let matches_controller = dependent_controller.as_deref()
            .is_some_and(|value| value.eq_ignore_ascii_case(controller_id))
            || dependent_pnp.as_deref().is_some_and(|value| value.eq_ignore_ascii_case(pnp_device_id));
        if !matches_controller { continue; }

        let Some(antecedent) = allocation.get("antecedent").and_then(Value::as_str) else { continue; };
        let Some(start_text) = cim_reference_field(antecedent, "Win32_DeviceMemoryAddress", "StartingAddress") else {
            continue;
        };
        let Some(start) = start_text.parse::<u64>().ok() else { continue; };
        let Some(range) = ranges.iter().find(|range| {
            range.get("S").and_then(Value::as_str).is_some_and(|value| value == start_text)
        }) else { continue; };
        let Some(end) = parse_address(range.get("E")) else { continue; };
        let Some(size) = end.checked_sub(start).and_then(|bytes| bytes.checked_add(1)) else { continue; };
        max_bytes = max_bytes.max(size);
    }

    (max_bytes >= 1024 * 1024 * 1024).then_some(true)
}

fn parse_hex_id(value: Option<&Value>) -> Option<u16> {
    let text = value?.as_str()?.trim();
    let digits = text.strip_prefix("0x").or_else(|| text.strip_prefix("0X")).unwrap_or(text);
    if digits.is_empty() || digits.len() > 8 || !digits.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(digits, 16).ok().filter(|value| *value <= u16::MAX as u32).map(|value| value as u16)
}

fn format_d3d12_bdf(domain: u64, bus: u64, device: u64, function: u64) -> Option<String> {
    if domain > 0xffff || bus > 0xff || device > 0x1f || function > 7
        || (domain, bus, device, function) == (0, 0, 0, 0)
    { return None; }
    Some(format!("{domain:04x}:{bus:02x}:{device:02x}.{function:x}"))
}

fn parse_d3d12_bdf(value: &str) -> Option<String> {
    let value = value.trim();
    let (domain_text, rest) = value.split_once(':')?;
    let (bus_text, rest) = rest.split_once(':')?;
    let (device_text, function_text) = rest.split_once('.')?;
    if domain_text.is_empty() || domain_text.len() > 4 || bus_text.is_empty() || bus_text.len() > 2
        || device_text.is_empty() || device_text.len() > 2 || function_text.len() != 1
        || function_text.contains(':') || function_text.contains('.')
    { return None; }
    let parse = |text: &str| u64::from_str_radix(text, 16).ok();
    format_d3d12_bdf(parse(domain_text)?, parse(bus_text)?, parse(device_text)?, parse(function_text)?)
}

fn d3d12_target_from_row(row: &Value) -> Option<D3d12Target> {
    if row.get("synthetic").and_then(Value::as_bool) == Some(true)
        || row.get("backendKind").and_then(Value::as_str) == Some("os")
    { return None; }
    let bdf = &row["bdf"];
    let domain = bdf.get("domain").or_else(|| bdf.get("segment")).and_then(Value::as_u64).unwrap_or(0);
    Some(D3d12Target {
        bdf: format_d3d12_bdf(
            domain,
            bdf.get("bus")?.as_u64()?,
            bdf.get("device")?.as_u64()?,
            bdf.get("function").or_else(|| bdf.get("func")).and_then(Value::as_u64).unwrap_or(0),
        )?,
        vendor_id: parse_hex_id(row.get("pciVendorId"))?,
        device_id: parse_hex_id(row.get("pciDeviceId"))?,
    })
}

fn d3d12_target_for_os_adapter(adapter: &os_gpu_inventory::OsAdapter) -> Option<D3d12Target> {
    let (bus, device, function) = adapter.bdf?;
    Some(D3d12Target {
        bdf: format_d3d12_bdf(0, bus as u64, device as u64, function as u64)?,
        vendor_id: adapter.vendor_id,
        device_id: adapter.device_id,
    })
}

fn d3d12_targets(rows: &[Value]) -> Vec<D3d12Target> {
    let raw_rows: Vec<&Value> = rows.iter().filter(|row| {
        row.get("synthetic").and_then(Value::as_bool) != Some(true)
            && row.get("backendKind").and_then(Value::as_str) != Some("os")
    }).collect();
    if raw_rows.len() > D3D12_MAX_TARGETS { return Vec::new(); }

    // Electron rejects every duplicate BDF instead of letting DXGI's result
    // land on whichever adapter happened to be enumerated first.
    let mut by_bdf: HashMap<String, Option<D3d12Target>> = HashMap::new();
    for row in raw_rows {
        let Some(target) = d3d12_target_from_row(row) else { continue; };
        by_bdf.entry(target.bdf.clone()).and_modify(|entry| *entry = None).or_insert(Some(target));
    }
    by_bdf.into_values().flatten().collect()
}

fn d3d12_helper_path() -> Option<PathBuf> {
    if !cfg!(debug_assertions) {
        let executable = std::env::current_exe().ok()?;
        let helper = executable.parent()?.join("resources").join(D3D12_HELPER_NAME);
        return helper.is_file().then_some(helper);
    }
    let mut roots = Vec::new();
    if let Some(executable) = std::env::current_exe().ok() {
        let mut root = executable.parent().map(Path::to_path_buf)?;
        for _ in 0..4 {
            roots.push(root.clone());
            if !root.pop() { break; }
        }
    }
    let mut candidates = Vec::new();
    for root in roots {
        candidates.push(root.join("resources").join(D3D12_HELPER_NAME));
        candidates.push(root.join("resources/app.asar.unpacked/src/main/native").join(D3D12_HELPER_NAME));
        candidates.push(root.join("compatibility-backend/resources/app.asar.unpacked/src/main/native").join(D3D12_HELPER_NAME));
    }
    if let Some(root) = Path::new(env!("CARGO_MANIFEST_DIR")).parent() {
        candidates.push(root.join("src/main/native").join(D3D12_HELPER_NAME));
    }
    candidates.into_iter().find(|path| path.is_file())
}

fn parse_d3d12_output(output: &[u8], targets: &[D3d12Target]) -> Option<HashSet<String>> {
    if output.len() > D3D12_MAX_OUTPUT_BYTES { return None; }
    let output = std::str::from_utf8(output).ok()?;
    let lines: Vec<&str> = output.lines().map(|line| line.trim_end_matches('\r')).filter(|line| !line.is_empty()).collect();
    if lines.len() != targets.len() { return None; }
    let expected: HashSet<String> = targets.iter().map(D3d12Target::key).collect();
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut positive = HashSet::new();

    for line in lines {
        let fields: Vec<&str> = line.split(',').collect();
        if fields.len() != 4 || !matches!(fields[3], "positive" | "unknown") { return None; }
        let bdf = parse_d3d12_bdf(fields[0])?;
        let parse_field = |field: &str| {
            if field.is_empty() || field.len() > 8 || !field.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return None;
            }
            u32::from_str_radix(field, 16).ok().filter(|value| *value <= u16::MAX as u32).map(|value| value as u16)
        };
        let vendor_id = parse_field(fields[1])?;
        let device_id = parse_field(fields[2])?;
        let key = format!("{bdf}|{vendor_id}|{device_id}");
        if !expected.contains(&key) { return None; }
        if counts.insert(key.clone(), 1).is_some() { return None; }
        if fields[3] == "positive" { positive.insert(key); }
    }

    Some(targets.iter().filter_map(|target| {
        let key = target.key();
        (counts.get(&key) == Some(&1) && positive.contains(&key)).then_some(key)
    }).collect())
}

fn run_d3d12_helper(path: &Path, targets: &[D3d12Target]) -> Option<HashSet<String>> {
    if !cfg!(windows) || targets.is_empty() { return None; }
    let mut command = Command::new(path);
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().ok()?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    let reader = match std::thread::Builder::new().name("arc-power-rebar-helper-output".into()).spawn(move || {
        let mut output = Vec::new();
        let mut bounded = stdout.take((D3D12_MAX_OUTPUT_BYTES + 1) as u64);
        bounded.read_to_end(&mut output).ok().map(|_| output)
    }) {
        Ok(reader) => reader,
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let mut input = String::new();
    for target in targets { input.push_str(&target.input_line()); }
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        return None;
    };
    if stdin.write_all(input.as_bytes()).is_err() {
        let _ = child.kill();
        let _ = child.wait();
        let _ = reader.join();
        return None;
    }
    drop(stdin);

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < D3D12_TIMEOUT => std::thread::sleep(Duration::from_millis(10)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return None;
            }
        }
    };
    let output = reader.join().ok().flatten()?;
    if !status.success() || output.len() > D3D12_MAX_OUTPUT_BYTES { return None; }
    parse_d3d12_output(&output, targets)
}

fn start_d3d12_evidence(rows: &[Value]) {
    if !cfg!(windows) { return; }
    let evidence = D3D12_EVIDENCE.get_or_init(|| Mutex::new(D3d12Evidence::default()));
    let targets = {
        let Ok(mut evidence) = evidence.lock() else { return; };
        if evidence.started { return; }
        evidence.started = true;
        d3d12_targets(rows)
    };
    if targets.is_empty() { return; }
    let Some(path) = d3d12_helper_path() else { return; };
    let evidence = D3D12_EVIDENCE.get().expect("evidence initialized");
    let _ = std::thread::Builder::new().name("arc-power-rebar-helper".into()).spawn(move || {
        if let Some(positive_keys) = run_d3d12_helper(&path, &targets) {
            if let Ok(mut evidence) = evidence.lock() {
                evidence.positive_keys.extend(positive_keys);
            }
        }
    });
}

fn d3d12_is_positive(target: &D3d12Target) -> bool {
    D3D12_EVIDENCE.get().and_then(|evidence| evidence.lock().ok()
        .map(|evidence| evidence.positive_keys.contains(&target.key()))).unwrap_or(false)
}

pub fn collect(store: Option<&NativeStore>) -> Value {
    let wmi = wmi_snapshot();
    json!({
        "cpu": cpu(wmi.as_ref()),
        "ram": ram(wmi.as_ref()),
        "baseboard": baseboard(wmi.as_ref()),
        "videoControllers": video_controllers(wmi.as_ref(), store),
    })
}

fn cpu(wmi: Option<&Value>) -> Value {
    let wmi_cpu = wmi.and_then(|value| value.get("cpu")).filter(|value| value.is_object());
    let text = |key: &str| wmi_cpu.and_then(|value| value.get(key)).and_then(Value::as_str).map(str::to_owned);
    let number = |key: &str| wmi_cpu.and_then(|value| value.get(key)).and_then(Value::as_u64);
    json!({
        "name": text("Name").or_else(|| registry_string(
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString")),
        "cores": number("NumberOfCores"),
        "threads": number("NumberOfLogicalProcessors").or_else(logical_processors),
        "maxClockMhz": number("MaxClockSpeed").or_else(|| registry_dword(
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0", "~MHz")),
    })
}

fn ram(wmi: Option<&Value>) -> Value {
    let wmi_mem = wmi.and_then(|value| value.get("physicalMemory")).filter(|value| value.is_object());
    let total = memory::physical_memory().map(|value| value.total_bytes).unwrap_or(0);
    json!({
        "totalBytes": total,
        "speedMhz": wmi_mem.and_then(|value| value.get("ConfiguredClockSpeed")).and_then(Value::as_u64),
        "manufacturer": wmi_mem.and_then(|value| value.get("Manufacturer")).and_then(Value::as_str)
            .map(str::to_owned),
        "memoryType": wmi_mem.and_then(|value| value.get("SMBIOSMemoryType")).and_then(Value::as_u64),
    })
}

fn baseboard(wmi: Option<&Value>) -> Value {
    let wmi_board = wmi.and_then(|value| value.get("baseboard")).filter(|value| value.is_object());
    let text = |key: &str, registry: &str| wmi_board.and_then(|value| value.get(key)).and_then(Value::as_str)
        .map(str::to_owned).or_else(|| registry_string(r"HARDWARE\DESCRIPTION\System\BIOS", registry));
    json!({
        "manufacturer": text("Manufacturer", "BaseBoardManufacturer"),
        "product": text("Product", "BaseBoardProduct"),
    })
}

fn video_controllers(wmi: Option<&Value>, store: Option<&NativeStore>) -> Value {
    let rows = gpu_devices::list_devices_merged().as_array().cloned().unwrap_or_default();
    let adapters = os_gpu_inventory::enumerate();
    #[cfg(not(test))]
    if store.is_some() { start_d3d12_evidence(&rows); }
    let mut d3d12_target_counts: HashMap<String, usize> = HashMap::new();
    for target in adapters.iter().filter_map(d3d12_target_for_os_adapter) {
        *d3d12_target_counts.entry(target.key()).or_default() += 1;
    }
    let active_names: Vec<String> = windows_display_modes::read_windows_display_modes()
        .ok()
        .map(|snapshot| snapshot.outputs.iter().map(|output| output.display_name.clone()).collect())
        .unwrap_or_default();
    let controllers: Vec<Value> = adapters.into_iter().map(|adapter| {
        let matching_rows: Vec<&Value> = rows.iter().filter(|row| {
            let vendor = row["pciVendorId"].as_str().and_then(|value| {
                u32::from_str_radix(value.trim_start_matches("0x"), 16).ok()
            });
            let device = row["pciDeviceId"].as_str().and_then(|value| {
                u32::from_str_radix(value.trim_start_matches("0x"), 16).ok()
            });
            let same_pci = vendor == Some(adapter.vendor_id as u32) && device == Some(adapter.device_id as u32);
            let location_matches = adapter.bdf.map_or(true, |(bus, slot, function)| {
                row["bdf"]["bus"].as_u64() == Some(bus as u64)
                    && row["bdf"]["device"].as_u64() == Some(slot as u64)
                    && row["bdf"]["function"].as_u64() == Some(function as u64)
            });
            same_pci && location_matches
        }).collect();
        let row = (matching_rows.len() == 1).then(|| matching_rows[0]);
        // The driver's own ctlPciGetProperties verdict is primary; WMI BAR
        // rows are only a fallback for drivers that do not export it.
        let driver_rebar = store.and_then(|native_store| {
            row.and_then(|row| row["deviceKey"].as_str())
                .and_then(|key| super::graphics::rebar_enabled(native_store, Some(key)))
        });
        // The OS fallback resolves allocation associations by exact PNP and
        // controller identity, matching Electron's per-controller join.
        let wmi_rebar = wmi.and_then(|value| rebar_from_wmi(value, &adapter.pnp));
        // Electron's bounded D3D12 helper provides positive evidence only and
        // intentionally overrides a disabled IGCL report. Keep the same
        // exact BDF/PCI identity and unique-row requirement here.
        let d3d12_target = d3d12_target_for_os_adapter(&adapter);
        let d3d12_rebar = d3d12_target.as_ref().is_some_and(|target| {
            d3d12_target_counts.get(&target.key()) == Some(&1) && d3d12_is_positive(target)
        });
        let rebar = if d3d12_rebar { Some(true) } else { driver_rebar.or(wmi_rebar) };
        let rebar_source = if d3d12_rebar { Some("d3d12") }
            else if driver_rebar.is_some() { Some("igcl") }
            else if wmi_rebar.is_some() { Some("wmi") } else { None };
        let driver = row.and_then(|value| value["driverVersion"].as_str()).map(str::to_owned);
        let vram = adapter.vram_bytes
            .or_else(|| row.and_then(|value| value["vramBytes"].as_u64()));
        json!({
            "name": adapter.name,
            "vramBytes": vram,
            "pnpDeviceId": adapter.pnp,
            "driverVersion": driver,
            "displayActive": active_names.iter().any(|name| name == &adapter.name),
            "locationInfo": adapter.bdf.map(|(bus, device, function)| {
                format!("PCI bus {bus}, device {device}, function {function}")
            }),
            // A large WMI memory range proves ReBAR; otherwise stay honest.
            "rebarActive": rebar.map(Value::Bool).unwrap_or(Value::Null),
            // Diagnostic only: which source produced the verdict on this host.
            "rebarSource": rebar_source,
        })
    }).collect();
    json!(controllers)
}

#[cfg(windows)]
fn registry_string(path: &str, value: &str) -> Option<String> {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ};
    let path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let mut key: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut key) } != 0 {
        return None;
    }
    let mut kind = 0u32;
    let mut length = 0u32;
    let query = unsafe {
        RegQueryValueExW(key, value.as_ptr(), std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut length)
    };
    if query != 0 || length == 0 {
        unsafe { RegCloseKey(key); }
        return None;
    }
    let mut buffer = vec![0u16; (length as usize / 2) + 1];
    let query = unsafe {
        RegQueryValueExW(key, value.as_ptr(), std::ptr::null(), &mut kind,
            buffer.as_mut_ptr() as *mut u8, &mut length)
    };
    unsafe { RegCloseKey(key); }
    if query != 0 { return None; }
    let text = String::from_utf16_lossy(&buffer[..(length as usize / 2)])
        .trim_end_matches('\0').trim().to_owned();
    (!text.is_empty()).then_some(text)
}

#[cfg(not(windows))]
fn registry_string(_path: &str, _value: &str) -> Option<String> { None }

#[cfg(windows)]
fn registry_dword(path: &str, value: &str) -> Option<u64> {
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ, REG_DWORD};
    let path: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let value: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let mut key: HKEY = std::ptr::null_mut();
    if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, path.as_ptr(), 0, KEY_READ, &mut key) } != 0 {
        return None;
    }
    let mut kind = 0u32;
    let mut number = 0u32;
    let mut length = std::mem::size_of::<u32>() as u32;
    let query = unsafe {
        RegQueryValueExW(key, value.as_ptr(), std::ptr::null(), &mut kind,
            &mut number as *mut u32 as *mut u8, &mut length)
    };
    unsafe { RegCloseKey(key); }
    (query == 0 && kind == REG_DWORD).then_some(number as u64)
}

#[cfg(not(windows))]
fn registry_dword(_path: &str, _value: &str) -> Option<u64> { None }

#[cfg(windows)]
fn logical_processors() -> Option<u64> {
    use windows_sys::Win32::System::SystemInformation::{GetSystemInfo, SYSTEM_INFO};
    let mut info: SYSTEM_INFO = unsafe { std::mem::zeroed() };
    unsafe { GetSystemInfo(&mut info); }
    (info.dwNumberOfProcessors > 0).then_some(info.dwNumberOfProcessors as u64)
}

#[cfg(not(windows))]
fn logical_processors() -> Option<u64> { None }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_sysinfo_always_has_the_full_envelope() {
        let value = collect(None);
        for key in ["cpu", "ram", "baseboard", "videoControllers"] {
            assert!(value.get(key).is_some(), "{key} must be present");
        }
        assert!(value["ram"]["totalBytes"].is_number());
        assert!(value["videoControllers"].is_array());
    }
}
