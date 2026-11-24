//! Read-only capability/state mapping from the trusted IGCL snapshot.
//! The renderer contract mirrors src/main/backend/igcl-backend.js; unsupported
//! surfaces are reported honestly rather than inferred.
use super::device_limits::{device_limits_of, DeviceLimits};
use super::gpu_devices::{map_adapters, registry_vram_bytes};
use super::igcl_read_only::{ControlSnapshot, FanProbe, ReadOnlyIgcl};
use super::igcl_raw::{ctl_fan_properties_t, ctl_oc_control_info_t, ctl_oc_properties_t, ctl_voltage_frequency_point_t};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

/// Must match Electron's FAN_PROBE_VERSION so both hosts share one verdict.
const FAN_PROBE_VERSION: u64 = 3;
static FAN_PROBE_CACHE: OnceLock<Mutex<HashMap<String, FanProbe>>> = OnceLock::new();

fn igcl_to_canonical(value: f64, units: i32) -> f64 {
    match units {
        10 | 13 | 2 => value / 1000.0,
        12 => value * 125.0,
        _ => value,
    }
}

fn canonical_unit(units: i32) -> &'static str {
    match units {
        0 => "MHz", 1 => "GTS", 2 => "MTS", 3 => "V", 4 => "W", 5 => "C",
        9 => "RPM", 10 => "mW", 11 => "%", 12 => "MHz", 13 => "mV", _ => "UNITS",
    }
}

fn control_range(info: &ctl_oc_control_info_t) -> Value {
    json!({
        "min": igcl_to_canonical(info.min, info.units),
        "max": igcl_to_canonical(info.max, info.units),
        "step": igcl_to_canonical(info.step, info.units),
        "default": igcl_to_canonical(info.Default, info.units),
        "units": canonical_unit(info.units),
    })
}

fn supported(info: &ctl_oc_control_info_t, value: Option<f64>) -> bool {
    info.bSupported != 0 && value.is_some()
}

pub(crate) fn raw_limit_ranges(snapshot: &ControlSnapshot) -> Value {
    let mut ranges = Map::new();
    if supported(&snapshot.oc.powerLimit, snapshot.power_limit) {
        ranges.insert("powerLimitW".into(), control_range(&snapshot.oc.powerLimit));
    }
    if supported(&snapshot.oc.temperatureLimit, snapshot.temp_limit) {
        ranges.insert("tempLimitC".into(), control_range(&snapshot.oc.temperatureLimit));
    }
    Value::Object(ranges)
}

fn fan_unit(fan: &ctl_fan_properties_t) -> Option<i32> {
    if fan.supportedUnits & 0b10 != 0 { Some(1) } else if fan.supportedUnits & 0b01 != 0 { Some(0) } else { None }
}

fn fan_pct(value: i32, units: i32, max_rpm: i32) -> Option<f64> {
    if units == 1 { Some(value as f64) }
    else if units == 0 && max_rpm > 0 { Some(value as f64 / max_rpm as f64 * 100.0) }
    else { None }
}

fn fan_modes(supported_modes: u32) -> Vec<&'static str> {
    let mut modes = Vec::new();
    if supported_modes & 0b001 != 0 { modes.push("auto"); }
    if supported_modes & 0b010 != 0 { modes.push("fixed"); }
    if supported_modes & 0b100 != 0 { modes.push("curve"); }
    modes
}

fn vf_range(oc: &ctl_oc_properties_t) -> Option<Value> {
    let voltage = &oc.gpuVFCurveVoltageLimit;
    let frequency = &oc.gpuVFCurveFrequencyLimit;
    if voltage.bSupported == 0 || frequency.bSupported == 0 { return None; }
    let voltage_min = igcl_to_canonical(voltage.min, voltage.units).max(0.0);
    let voltage_max = igcl_to_canonical(voltage.max, voltage.units);
    let freq_min = igcl_to_canonical(frequency.min, frequency.units).max(0.0);
    let freq_max = igcl_to_canonical(frequency.max, frequency.units);
    if voltage_max <= voltage_min || freq_max <= freq_min { return None; }
    let voltage_step = igcl_to_canonical(voltage.step, voltage.units).abs();
    let frequency_step = igcl_to_canonical(frequency.step, frequency.units).abs();
    Some(json!({
        "voltageMinV": voltage_min, "voltageMaxV": voltage_max,
        "freqMinMhz": freq_min, "freqMaxMhz": freq_max,
        "voltageStepV": voltage_step, "frequencyStepMhz": frequency_step,
        "maxPoints": 32,
    }))
}

fn apply_device_limits(ranges: &mut Map<String, Value>, limits: &DeviceLimits, advanced: bool) {
    let keys = [
        ("powerLimitW", limits.power_limit_w.as_ref(), Some("W")),
        ("tempLimitC", limits.temp_limit_c.as_ref(), Some("C")),
        ("gpuVoltOffsetV", limits.gpu_volt_offset_v.as_ref(), Some("V")),
    ];
    for (key, limit, expected_units) in keys {
        let Some(limit) = limit else { continue; };
        let Some(range) = ranges.get_mut(key) else { continue; };
        if range.get("units").and_then(Value::as_str) != expected_units { continue; }
        if let Some(max) = limit.max {
            let current = range.get("max").and_then(Value::as_f64);
            let next = if key == "gpuVoltOffsetV" || advanced {
                max
            } else {
                current.map_or(max, |current| current.min(max))
            };
            range["max"] = json!(next);
            if let Some(default) = range.get("default").and_then(Value::as_f64) {
                range["default"] = json!(default.min(next));
            }
        }
        if let Some(step) = limit.step { range["step"] = json!(step); }
        if key == "gpuVoltOffsetV" {
            if let Some(min) = limit.min { range["min"] = json!(min); }
        }
    }
}

fn aib_identity(subsys_vendor: u16, subsys_id: u16) -> (Option<&'static str>, Option<&'static str>) {
    let vendor = match subsys_vendor {
        0x1849 => "ASRock", 0x8086 => "Intel (Limited Edition)", 0x1025 => "Acer",
        0x1043 => "ASUS", 0x1458 => "Gigabyte", 0x1462 => "MSI", 0x3842 => "EVGA",
        0x19da => "ZOTAC", 0x1acc => "Palit", 0x1da2 => "Sapphire", 0x1682 => "XFX",
        0x148c => "PowerColor", _ => return (None, None),
    };
    let model = match (subsys_vendor, subsys_id) {
        (0x1849, 0x6001) => Some("Phantom Gaming"),
        (0x1025, 0xB102) => Some("Predator BiFrost"),
        _ => None,
    };
    (Some(vendor), model)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ProbePolicy {
    /// Production coexistence: use only a cached success, never add a probe
    /// while the Electron broker can still probe the same fan.
    Cached,
    /// Explicit live verification (ignored tests only).
    Force,
    /// Read-only state calls never need the probe.
    Skip,
}

/// Open a session and resolve the mapped device id to its raw enumeration
/// index. No control or fan probe is performed.
pub(crate) fn open_for_device(dll_path: &Path, device_id: u64)
    -> Result<(ReadOnlyIgcl, usize, Value), String> {
    let mut igcl = ReadOnlyIgcl::load(dll_path).map_err(|error| error.to_string())?;
    let adapters = igcl.enumerate_adapters().map_err(|error| error.to_string())?;
    let sorted = map_adapters(&adapters, registry_vram_bytes);
    let device = sorted.as_array().and_then(|devices| devices.get(device_id as usize)).cloned()
        .ok_or_else(|| "unknown device id".to_owned())?;
    let raw_index = unique_adapter_index(&adapters, &device)?;
    Ok((igcl, raw_index, device))
}

/// Reopen an adapter by the physical identity captured at the start of an
/// apply transaction. Numeric inventory ids are renderer-facing ordinals and
/// can select a different card after hotplug/reordering.
pub(crate) fn open_for_identity(
    dll_path: &Path,
    expected: &super::gpu_apply_identity::ApplyIdentity,
) -> Result<(ReadOnlyIgcl, usize, Value), String> {
    let mut igcl = ReadOnlyIgcl::load(dll_path).map_err(|error| error.to_string())?;
    let adapters = igcl.enumerate_adapters().map_err(|error| error.to_string())?;
    let sorted = map_adapters(&adapters, registry_vram_bytes);
    let rows = sorted.as_array().ok_or_else(|| "native GPU inventory is unavailable".to_owned())?;
    let index = super::gpu_apply_identity::unique_target_index(rows, expected)?;
    let device = rows[index].clone();
    let raw_index = unique_adapter_index(&adapters, &device)?;
    Ok((igcl, raw_index, device))
}

/// Reject ambiguous physical identities instead of silently selecting the
/// first same-model adapter when a driver reports duplicate BDFs.
fn unique_adapter_index(adapters: &[super::igcl_read_only::AdapterInfo], device: &Value) -> Result<usize, String> {
    let mut matches = adapters.iter().enumerate().filter(|(_, adapter)| {
        format!("0x{:08x}", adapter.pci_vendor_id) == device["pciVendorId"].as_str().unwrap_or("")
            &&
        format!("0x{:08x}", adapter.pci_device_id) == device["pciDeviceId"].as_str().unwrap_or("")
            && adapter.bdf.bus as u64 == device["bdf"]["bus"].as_u64().unwrap_or(u64::MAX)
            && adapter.bdf.device as u64 == device["bdf"]["device"].as_u64().unwrap_or(u64::MAX)
            && adapter.bdf.function as u64 == device["bdf"]["function"].as_u64().unwrap_or(u64::MAX)
    });
    let (index, _) = matches.next().ok_or_else(|| "device identity did not match the native enumeration".to_owned())?;
    if matches.next().is_some() { return Err("device identity is ambiguous in the native enumeration".into()); }
    Ok(index)
}

fn load_snapshot(dll_path: &Path, device_id: u64, policy: ProbePolicy)
    -> Result<(ControlSnapshot, Value, Option<FanProbe>), String> {
    let (mut igcl, raw_index, device) = open_for_device(dll_path, device_id)?;
    load_snapshot_from_open(&mut igcl, raw_index, &device, policy)
}

fn load_snapshot_for_identity(
    dll_path: &Path,
    identity: &super::gpu_apply_identity::ApplyIdentity,
    policy: ProbePolicy,
) -> Result<(ControlSnapshot, Value, Option<FanProbe>), String> {
    let (mut igcl, raw_index, device) = open_for_identity(dll_path, identity)?;
    load_snapshot_from_open(&mut igcl, raw_index, &device, policy)
}

fn load_snapshot_from_open(
    igcl: &mut ReadOnlyIgcl,
    raw_index: usize,
    device: &Value,
    policy: ProbePolicy,
) -> Result<(ControlSnapshot, Value, Option<FanProbe>), String> {
    let snapshot = igcl.controls_snapshot(raw_index).map_err(|error| error.to_string())?;
    // The probe only matters where Electron would run it: properties refuse
    // control, or their derived modes claim fixed (the B580/A770 lie).
    let probe_needed = fan_probe_needed(policy, snapshot.fan.canControl, snapshot.fan.supportedModes);
    let fan_probe = if probe_needed {
        match policy {
            ProbePolicy::Force => {
                // The probe is a reversible hardware write. Hold the shared
                // apply mutex so it cannot interleave with another writer.
                // Block for the standard timeout instead of skipping: an apply
                // that triggers a cache-miss caps read already holds the mutex
                // on another thread, and skipping the probe leaves the fan
                // read-only for the rest of the session.
                let probe_lock = super::apply_lock::acquire().ok();
                if probe_lock.is_some() {
                    let result = igcl.probe_fan_control(raw_index, snapshot.fan.maxPoints);
                    remember_fan_probe(device, result);
                    Some(result)
                } else {
                    None
                }
            }
            ProbePolicy::Cached => cached_fan_probe(&device).filter(|probe| probe.probe_ok)
                .map(Some)
                .ok_or_else(|| "fan probe verdict is not cached".to_owned())?,
            ProbePolicy::Skip => None,
        }
    } else {
        None
    };
    let _ = igcl.close();
    Ok((snapshot, device.clone(), fan_probe))
}

fn fan_probe_needed(policy: ProbePolicy, can_control: u8, supported_modes: u32) -> bool {
    policy != ProbePolicy::Skip
        && (can_control == 0 || fan_modes(supported_modes).contains(&"fixed"))
}

fn fan_probe_key(device: &Value) -> Option<String> {
    let driver = device["driverVersion"].as_str().filter(|value| !value.is_empty())?;
    let key = device["deviceKey"].as_str().filter(|value| !value.is_empty())?;
    Some(format!("{driver}|{key}"))
}

fn fan_probe_cache_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(|root| PathBuf::from(root).join("ArcPower").join("fan-probe-cache.json"))
}

/// Success-only, probe-versioned read of the same cache Electron writes.
fn read_persisted_fan_probe(device: &Value) -> Option<FanProbe> {
    let key = fan_probe_key(device)?;
    let text = std::fs::read_to_string(fan_probe_cache_path()?).ok()?;
    let entry: Value = serde_json::from_str(&text).ok()?;
    if entry["probeVersion"].as_u64()? != FAN_PROBE_VERSION { return None; }
    if entry["probeOk"].as_bool()? != true { return None; }
    let entry_key = format!(
        "{}|{}",
        entry["driverVersion"].as_str()?,
        entry["deviceKey"].as_str()?,
    );
    if entry_key != key { return None; }
    Some(FanProbe {
        probe_ok: true,
        write_accepted: entry["writeAccepted"].as_bool().unwrap_or(false),
        fixed_ok: entry["fixedOk"].as_bool().unwrap_or(false),
    })
}

fn cached_fan_probe(device: &Value) -> Option<FanProbe> {
    let key = fan_probe_key(device)?;
    if let Some(cache) = FAN_PROBE_CACHE.get() {
        if let Ok(cache) = cache.lock() {
            if let Some(result) = cache.get(&key) { return Some(*result); }
        }
    }
    let result = read_persisted_fan_probe(device)?;
    if let Ok(mut cache) = FAN_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock() {
        cache.insert(key, result);
    }
    Some(result)
}

fn remember_fan_probe(device: &Value, result: FanProbe) {
    if let Some(key) = fan_probe_key(device) {
        if let Ok(mut cache) = FAN_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new())).lock() {
            cache.insert(key, result);
        }
    }
    if result.probe_ok { persist_fan_probe(device, result); }
}

/// Best-effort success-only write in Electron's exact file shape.
fn persist_fan_probe(device: &Value, result: FanProbe) {
    let (Some(path), Some(driver), Some(key)) = (
        fan_probe_cache_path(),
        device["driverVersion"].as_str().filter(|value| !value.is_empty()),
        device["deviceKey"].as_str().filter(|value| !value.is_empty()),
    ) else { return; };
    let payload = json!({
        "driverVersion": driver,
        "deviceId": device["id"].as_u64().unwrap_or(0),
        "deviceKey": key,
        "probeVersion": FAN_PROBE_VERSION,
        "probeOk": result.probe_ok,
        "writeAccepted": result.write_accepted,
        "fixedOk": result.fixed_ok,
    });
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    let _ = std::fs::write(path, payload.to_string());
}

fn finalize_ranges_with_witness(ranges: &mut Map<String, Value>, limits: &DeviceLimits, advanced: bool) -> Map<String, Value> {
    let witness = ranges.clone();
    apply_device_limits(ranges, limits, advanced);
    witness
}

fn map_capabilities(snapshot: &ControlSnapshot, device: &Value, oc_mode: &str, waiver: bool, probe: Option<FanProbe>) -> Value {
    let oc = &snapshot.oc;
    let vf = vf_range(oc);
    let lock_supported = snapshot.gpu_lock.is_some() && oc.gpuVoltageOffset.units != 11;
    let mut controls = Map::new();
    controls.insert("gpuFreqOffset".into(), json!(supported(&oc.gpuFrequencyOffset, snapshot.frequency_offset)));
    controls.insert("gpuVoltOffset".into(), json!(supported(&oc.gpuVoltageOffset, snapshot.voltage_offset)));
    controls.insert("gpuLock".into(), json!(lock_supported));
    controls.insert("vramFreqOffset".into(), json!(supported(&oc.vramMemSpeedLimit, snapshot.vram_freq)));
    controls.insert("vramVoltOffset".into(), json!(false));
    controls.insert("powerLimit".into(), json!(supported(&oc.powerLimit, snapshot.power_limit)));
    controls.insert("tempLimit".into(), json!(supported(&oc.temperatureLimit, snapshot.temp_limit)));
    controls.insert("vfCurve".into(), json!(vf.is_some()));
    let mut ranges = Map::new();
    if supported(&oc.gpuFrequencyOffset, snapshot.frequency_offset) {
        ranges.insert("gpuFreqOffsetMhz".into(), control_range(&oc.gpuFrequencyOffset));
    }
    if supported(&oc.gpuVoltageOffset, snapshot.voltage_offset) {
        ranges.insert("gpuVoltOffsetV".into(), control_range(&oc.gpuVoltageOffset));
    }
    if supported(&oc.powerLimit, snapshot.power_limit) {
        ranges.insert("powerLimitW".into(), control_range(&oc.powerLimit));
    }
    if supported(&oc.temperatureLimit, snapshot.temp_limit) {
        ranges.insert("tempLimitC".into(), control_range(&oc.temperatureLimit));
    }
    if supported(&oc.vramMemSpeedLimit, snapshot.vram_freq) {
        ranges.insert("vramFreqOffsetGts".into(), control_range(&oc.vramMemSpeedLimit));
    }
    // Preserve the unmodified DriverStore witness before listed/advanced
    // policy widens or narrows the renderer-facing ranges.
    let overclocking_supported = controls.values().any(|value| value == &Value::Bool(true));
    let (aib_vendor, aib_model) = aib_identity(
        device["pciSubsysVendorId"].as_u64().unwrap_or(0) as u16,
        device["pciSubsysId"].as_u64().unwrap_or(0) as u16,
    );
    let advanced = oc_mode == "advanced";
    let limits = device_limits_of(device["pciDeviceId"].as_str(), aib_vendor, advanced);
    let driver_ranges = finalize_ranges_with_witness(&mut ranges, &limits, advanced);
    let legacy = if limits.listed { Some(super::legacy_igcl::capability()) } else { None };
    let extended_controls = legacy.map(|(power, temp)| json!({"powerLimitW": power, "tempLimitC": temp}));
    let extended_ranges = advanced && legacy.is_some_and(|(power, temp)| power || temp);
    let fan_units = fan_unit(&snapshot.fan).map(|units| if units == 1 { "percent" } else { "rpm" });
    let mut fan_control = snapshot.fan.canControl != 0;
    let mut modes = fan_modes(snapshot.fan.supportedModes);
    if let Some(probe) = probe {
        fan_control |= probe.probe_ok;
        // Write-accepted is the mode truth: the card demonstrably takes
        // tables, so auto/curve are real even if a later probe step failed.
        if probe.write_accepted {
            modes = if probe.fixed_ok { vec!["auto", "curve", "fixed"] } else { vec!["auto", "curve"] };
        }
    }
    let lock_range = vf.as_ref().map(|range| json!({
        "voltMin": range["voltageMinV"], "voltMax": range["voltageMaxV"],
        "freqMin": range["freqMinMhz"], "freqMax": range["freqMaxMhz"],
    }));
    let gpu_lock_status = if lock_supported {
        json!({"state": "available", "reason": null})
    } else {
        json!({"state": "unsupported", "reason": "Fixed Clock / Voltage lock is not exposed for this adapter’s native voltage units."})
    };
    let vf_status = if vf.is_some() {
        json!({"state": "available", "reason": null})
    } else {
        json!({"state": "unsupported", "reason": "ctlOverclockReadVFCurve is unavailable in the IGCL runtime"})
    };
    let mut caps = json!({
        "oemName": "Intel",
        "deviceName": device["name"],
        "deviceKey": device["deviceKey"],
        "memType": device["memType"],
        "waiverAccepted": waiver,
        "controls": Value::Object(controls),
        "ranges": Value::Object(ranges),
        "driverRanges": Value::Object(driver_ranges),
        "controlStatus": {"gpuLock": gpu_lock_status, "vfCurve": vf_status},
        "fan": {
            "canControl": fan_control,
            "modes": modes,
            "maxRpm": snapshot.fan.maxRPM,
            "maxCurvePoints": snapshot.fan.maxPoints,
            "speedUnits": fan_units,
        },
        "lockRange": lock_range,
        "vfCurveRange": vf,
        "overclockingSupported": overclocking_supported,
        "pciDeviceId": device["pciDeviceId"],
        "aibVendor": aib_vendor,
        "aibModel": aib_model,
        "ocMode": oc_mode,
    });
    if let Some(extended_controls) = extended_controls { caps["extendedControls"] = extended_controls; }
    if extended_ranges { caps["extendedRanges"] = json!(true); }
    caps
}

fn vf_points(points: &Option<Vec<ctl_voltage_frequency_point_t>>) -> Value {
    match points {
        Some(points) if points.len() >= 2 => Value::Array(points.iter().map(|point| json!({
            "voltageV": point.Voltage as f64 / 1000.0,
            "freqMhz": point.Frequency,
        })).collect()),
        _ => Value::Null,
    }
}

fn map_state(snapshot: &ControlSnapshot, _device: &Value) -> Value {
    let oc = &snapshot.oc;
    let read = |value: Option<f64>, info: &ctl_oc_control_info_t| value.map(|value| igcl_to_canonical(value, info.units));
    let lock_supported = snapshot.gpu_lock.is_some() && oc.gpuVoltageOffset.units != 11;
    let fan_units = fan_unit(&snapshot.fan);
    let max_rpm = snapshot.fan.maxRPM;
    let mut fan_mode = snapshot.fan_config.as_ref().and_then(|config| match config.mode {
        0 => Some("auto"), 1 => Some("fixed"), 2 => Some("curve"), _ => None,
    });
    let fan_curve = snapshot.fan_config.as_ref().and_then(|config| {
        let count = config.speedTable.numPoints;
        if count <= 0 || count > 32 { return None; }
        let mut points = Vec::new();
        for index in 0..count as usize {
            let point = &config.speedTable.table[index];
            let speed = fan_pct(point.speed.speed, point.speed.units, max_rpm)?;
            points.push(json!({"t": point.temperature, "speedPct": speed}));
        }
        Some(points)
    });
    let mut fixed = snapshot.fan_config.as_ref().and_then(|config| {
        let units = fan_units?;
        if config.speedFixed.units == units { fan_pct(config.speedFixed.speed, config.speedFixed.units, max_rpm) } else { None }
    });
    if fan_mode == Some("curve") {
        if let Some(points) = &fan_curve {
            if points.len() >= 2 {
                let first = points[0]["speedPct"].as_f64().unwrap_or(0.0);
                if points.iter().all(|point| (point["speedPct"].as_f64().unwrap_or(0.0) - first).abs() <= 1.0) {
                    fan_mode = Some("fixed");
                    fixed = Some(first);
                }
            }
        }
    }
    let lock = if lock_supported {
        snapshot.gpu_lock.as_ref().map(|lock| json!({"voltageV": lock.Voltage / 1000.0, "freqMhz": lock.Frequency})).unwrap_or(Value::Null)
    } else { Value::Null };
    json!({
        "powerLimitW": read(snapshot.power_limit, &oc.powerLimit),
        "gpuVoltOffsetV": read(snapshot.voltage_offset, &oc.gpuVoltageOffset),
        "gpuFreqOffsetMhz": read(snapshot.frequency_offset, &oc.gpuFrequencyOffset),
        "tempLimitC": read(snapshot.temp_limit, &oc.temperatureLimit),
        "vramFreqOffsetGts": read(snapshot.vram_freq, &oc.vramMemSpeedLimit),
        "vramVoltOffsetV": Value::Null,
        "gpuLock": lock,
        "vfCurve": vf_points(&snapshot.vf_live),
        "vfCurveDefault": vf_points(&snapshot.vf_stock),
        "vfCurveUnits": if snapshot.vf_live.is_some() || snapshot.vf_stock.is_some() { json!("V") } else { Value::Null },
        "fanMode": fan_mode,
        "fanCurve": fan_curve,
        "fixedFanPct": fixed,
    })
}

pub fn capabilities(dll_path: &Path, device_id: u64, oc_mode: &str, waiver: bool) -> Result<Value, String> {
    capabilities_with_probe(dll_path, device_id, oc_mode, waiver, false)
}

fn capabilities_with_probe(dll_path: &Path, device_id: u64, oc_mode: &str, waiver: bool, force_probe: bool)
    -> Result<Value, String> {
    let policy = if force_probe { ProbePolicy::Force } else { ProbePolicy::Cached };
    let (snapshot, device, probe) = load_snapshot(dll_path, device_id, policy)?;
    Ok(map_capabilities(&snapshot, &device, oc_mode, waiver, probe))
}

pub fn current_settings(dll_path: &Path, device_id: u64) -> Result<Value, String> {
    current_settings_with_units(dll_path, device_id).map(|(settings, _)| settings)
}

/// Read current state and the native units for its power/temperature controls
/// from the same probe-free snapshot. Stability needs these units to compare
/// percent-shaped Battlemage read-backs in the same display units as Tuning.
pub fn current_settings_with_units(dll_path: &Path, device_id: u64) -> Result<(Value, Value), String> {
    let (snapshot, device, _) = load_snapshot(dll_path, device_id, ProbePolicy::Skip)?;
    let units = json!({
        "powerLimitW":canonical_unit(snapshot.oc.powerLimit.units),
        "tempLimitC":canonical_unit(snapshot.oc.temperatureLimit.units),
    });
    Ok((map_state(&snapshot, &device), units))
}

/// Read controls for a pinned physical adapter after an apply transaction.
pub(crate) fn current_settings_for_identity(
    dll_path: &Path,
    identity: &super::gpu_apply_identity::ApplyIdentity,
) -> Result<Value, String> {
    let (snapshot, device, _) = load_snapshot_for_identity(dll_path, identity, ProbePolicy::Skip)?;
    Ok(map_state(&snapshot, &device))
}

/// Read capabilities from a pinned physical adapter. The cache/probe key is
/// computed from this same resolved row, so a reordered ordinal cannot pair
/// one adapter's capabilities with another adapter's write target.
pub(crate) fn capabilities_for_identity(
    dll_path: &Path,
    identity: &super::gpu_apply_identity::ApplyIdentity,
    oc_mode: &str,
    waiver: bool,
) -> Result<Value, String> {
    let (snapshot, device, probe) = load_snapshot_for_identity(dll_path, identity, ProbePolicy::Cached)?;
    Ok(map_capabilities(&snapshot, &device, oc_mode, waiver, probe))
}

/// Outcome of the driver's whole-device OC reset.
pub enum DriverReset { Reset, Unavailable }

/// Reset one adapter through `ctlOverclockResetToDefault` and close the
/// session. Callers hold the shared apply locks and verify the read-back.
pub fn reset_to_default_for_device(dll_path: &Path, device_id: u64, expected_key: &str) -> Result<DriverReset, String> {
    let (mut igcl, raw_index, device) = open_for_device(dll_path, device_id)?;
    if device["deviceKey"].as_str() != Some(expected_key) {
        let _ = igcl.close();
        return Err("reset-to-defaults: selected GPU identity changed; refresh and try again".into());
    }
    let _ = igcl.apply_waiver(raw_index);
    let reset = igcl.reset_to_default(raw_index);
    let _ = igcl.close();
    match reset {
        Ok(()) => Ok(DriverReset::Reset),
        Err(error) if error.status.is_none() || error.status == Some(0x4000_000a) => Ok(DriverReset::Unavailable),
        Err(error) => Err(error.to_string()),
    }
}

/// Read capabilities and run the reversible fan probe when Electron's
/// success-only cache is missing. This is the native equivalent of Electron's
/// `_probeFanCapability` on the capability path; it writes a safe table and
/// restores default mode, so only the packaged/native-only fallback calls it.
pub(crate) fn capabilities_for_identity_with_probe(
    dll_path: &Path,
    identity: &super::gpu_apply_identity::ApplyIdentity,
    oc_mode: &str,
    waiver: bool,
) -> Result<Value, String> {
    let (snapshot, device, probe) = load_snapshot_for_identity(dll_path, identity, ProbePolicy::Force)?;
    Ok(map_capabilities(&snapshot, &device, oc_mode, waiver, probe))
}

/// Read native capabilities without probing fan control. Used by packaged
/// native-only hosts when Electron's success-only fan cache is unavailable and
/// the live probe cannot be completed; the other controls remain readable
/// while fan editing stays disabled.
pub(crate) fn capabilities_for_identity_without_fan_probe(
    dll_path: &Path,
    identity: &super::gpu_apply_identity::ApplyIdentity,
    oc_mode: &str,
    waiver: bool,
) -> Result<Value, String> {
    let (snapshot, device, _) = load_snapshot_for_identity(dll_path, identity, ProbePolicy::Skip)?;
    let mut caps = map_capabilities(&snapshot, &device, oc_mode, waiver, None);
    force_fan_read_only(&mut caps);
    Ok(caps)
}

fn force_fan_read_only(caps: &mut Value) {
    if let Some(fan) = caps.get_mut("fan").and_then(Value::as_object_mut) {
        fan.insert("canControl".into(), Value::Bool(false));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::igcl_raw::ctl_oc_vf_pair_t;

    #[test]
    fn native_device_identity_requires_a_unique_vendor_device_and_bdf() {
        use crate::backend::igcl_read_only::{AdapterBdf, AdapterInfo};
        let adapter = AdapterInfo { index: 0, name: "Arc".into(), device_type: 1,
            pci_vendor_id: 0x8086, pci_device_id: 0xe20b, rev_id: 0,
            pci_subsys_id: 0, pci_subsys_vendor_id: 0,
            bdf: AdapterBdf { bus: 3, device: 0, function: 0 }, luid: None,
            driver_version: String::new(), graphics_adapter_properties: 0,
            graphics_clock_mhz: 0, num_xe_cores: 0 };
        let row = json!({"pciVendorId":"0x00008086", "pciDeviceId":"0x0000e20b",
            "bdf":{"bus":3,"device":0,"function":0}});
        assert_eq!(unique_adapter_index(&[adapter.clone()], &row).unwrap(), 0);
        assert!(unique_adapter_index(&[adapter.clone(), adapter.clone()], &row).is_err());
        let mut wrong_vendor = row.clone();
        wrong_vendor["pciVendorId"] = json!("0x000010de");
        assert!(unique_adapter_index(&[adapter], &wrong_vendor).is_err());
    }

    fn check(condition: bool, message: &str) { assert!(condition, "{message}"); }

    #[test]
    #[ignore = "live read-only IGCL capability/state probe"]
    fn live_capabilities_and_state_when_requested() {
        let path = crate::backend::gpu_devices::locate_dll().expect("IGCL DLL not found");
        let caps = capabilities(&path, 0, "stock", false).expect("capabilities");
        let state = current_settings(&path, 0).expect("state");
        let encoded = serde_json::to_string_pretty(&json!({"caps": caps, "state": state})).unwrap();
        std::fs::write("C:/Users/Yams/AppData/Local/Temp/opencode/rust-caps.json", &encoded).unwrap();
        eprintln!("{encoded}");
    }

    #[test]
    #[ignore = "live reversible fan write probe; requires explicit approval"]
    fn live_fan_probe_when_approved() {
        let path = crate::backend::gpu_devices::locate_dll().expect("IGCL DLL not found");
        let caps = capabilities_with_probe(&path, 0, "stock", false, true).expect("capabilities");
        let state = current_settings(&path, 0).expect("state");
        eprintln!("{}", serde_json::to_string_pretty(&json!({"fan": caps["fan"], "state": state})).unwrap());
        assert_eq!(caps["fan"]["canControl"], json!(true), "probe should unlock fan control");
        assert_eq!(caps["fan"]["modes"], json!(["auto", "curve", "fixed"]), "probe should learn all modes");
        assert_eq!(state["fanMode"].as_str(), Some("auto"), "fan must be restored to auto");
    }

    #[test]
    fn device_limits_finalize_stock_and_advanced_ranges() {
        let mut ranges = Map::new();
        ranges.insert("powerLimitW".into(), json!({"min":50,"max":300,"step":1,"default":200,"units":"W"}));
        ranges.insert("tempLimitC".into(), json!({"min":50,"max":100,"step":1,"default":80,"units":"C"}));
        ranges.insert("gpuVoltOffsetV".into(), json!({"min":0,"max":0.250,"step":0.005,"default":0,"units":"V"}));
        apply_device_limits(&mut ranges, &device_limits_of(Some("0x000056a1"), Some("ASRock"), false), false);
        assert_eq!(ranges["powerLimitW"]["max"], 216.0);
        assert_eq!(ranges["tempLimitC"]["max"], 90.0);
        assert_eq!(ranges["gpuVoltOffsetV"]["min"], -0.5);
        assert_eq!(ranges["gpuVoltOffsetV"]["step"], 0.001);
        apply_device_limits(&mut ranges, &device_limits_of(Some("0x000056a1"), Some("ASRock"), true), true);
        assert_eq!(ranges["powerLimitW"]["max"], 270.0);
        assert_eq!(ranges["tempLimitC"]["max"], 115.0);
        assert_eq!(ranges["gpuVoltOffsetV"]["min"], -0.8);
    }

    #[test]
    fn advanced_finalization_preserves_raw_driver_ranges() {
        let mut ranges = Map::new();
        ranges.insert("powerLimitW".into(), json!({"min":50,"max":247,"step":1,"units":"W"}));
        ranges.insert("tempLimitC".into(), json!({"min":50,"max":90,"step":1,"units":"C"}));
        let raw = finalize_ranges_with_witness(&mut ranges, &device_limits_of(Some("0x000056a0"), Some("Acer"), true), true);
        assert_eq!(raw["powerLimitW"]["max"], 247);
        assert_eq!(raw["tempLimitC"]["max"], 90);
        assert!(ranges["powerLimitW"]["max"].as_f64().unwrap() > 247.0);
        assert!(ranges["tempLimitC"]["max"].as_f64().unwrap() > 90.0);
    }

    #[test]
    fn missing_fan_probe_fallback_keeps_other_capabilities_and_disables_fan_control() {
        let mut caps = json!({"fan":{"canControl":true,"modes":["auto","fixed"]},
            "controls":{"powerLimit":true},"ranges":{"powerLimitW":{"min":1,"max":2}}});
        force_fan_read_only(&mut caps);
        assert_eq!(caps["fan"]["canControl"], json!(false));
        assert_eq!(caps["fan"]["modes"], json!(["auto","fixed"]));
        assert_eq!(caps["controls"]["powerLimit"], json!(true));
        assert_eq!(caps["ranges"]["powerLimitW"]["max"], json!(2));
    }

    #[test]
    fn waiver_read_skips_fan_probe_even_when_cache_would_be_required() {
        assert!(fan_probe_needed(ProbePolicy::Cached, 0, 0));
        assert!(!fan_probe_needed(ProbePolicy::Skip, 0, 0));
    }

    #[test]
    fn mapping_keeps_the_expected_shapes() {
        let _ = std::mem::size_of::<ctl_oc_vf_pair_t>();
        check(fan_modes(0b111) == vec!["auto", "fixed", "curve"], "fan mode order");
        check(fan_pct(50, 1, 3000) == Some(50.0), "percent fan");
        check(fan_pct(1500, 0, 3000) == Some(50.0), "rpm fan");
        check(fan_pct(10, 0, -1).is_none(), "unknown rpm fan");
        check(canonical_unit(11) == "%", "percent unit");
        check(canonical_unit(13) == "mV", "millivolt unit");
        check(igcl_to_canonical(1500.0, 13) == 1.5, "mV conversion");
        check(aib_identity(0x1849, 0x6021) == (Some("ASRock"), None), "aib vendor");
        check(aib_identity(0x1849, 0x6001) == (Some("ASRock"), Some("Phantom Gaming")), "aib model");
        check(aib_identity(1, 2) == (None, None), "unknown aib");
    }
}
