//! Pure source-parity normalization and delta state. This module invokes no
//! driver API, owns no native handles and does not synthesize sensor readings.
//! Sources: igcl-backend.js sampleRawTelemetry/_computeUtilPct and
//! telemetry/telemetry-service.js handleSample.
use super::igcl_runtime::RawTelemetry;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

pub const DEFAULT_POLL_MS: u64 = 400;
pub const MIN_POLL_MS: u64 = 50;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceTelemetryContext {
    #[serde(default)] pub integrated: bool,
    #[serde(default)] pub mobile: bool,
    pub graphics_clock_mhz: Option<f64>,
}
impl DeviceTelemetryContext {
    pub fn integrated_or_mobile(&self) -> bool { self.integrated || self.mobile }
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySample {
    #[serde(skip_serializing_if = "Option::is_none")] pub t: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub gpu_clock_mhz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub mem_clock_mhz: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub temp_c: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub vram_temp_c: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub gpu_voltage_v: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub gpu_energy_j: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub vram_energy_j: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub total_energy_j: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub power_energy_j: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub fan_rpm: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")] pub util_pct: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")] pub power_w: Option<f64>,
    pub throttle: BTreeMap<String, bool>,
}

#[derive(Clone, Copy)]
struct Activity { t: f64, counter: f64 }
#[derive(Clone, Copy)]
struct Energy { t: Option<f64>, counter: Option<f64>, selected_power_counter: bool }

/// State belongs to one runtime generation. Clear it whenever the runtime,
/// adapter identity or telemetry lane changes; indices alone are not physical
/// identity. Missing samples preserve activity state but reset energy state,
/// matching the two source owners' different update policies.
#[derive(Default)]
pub struct TelemetryNormalizer {
    activity: HashMap<usize, Activity>,
    energy: HashMap<usize, Energy>,
}
impl TelemetryNormalizer {
    pub fn clear(&mut self) { self.activity.clear(); self.energy.clear(); }
    pub fn clear_adapter(&mut self, index: usize) { self.activity.remove(&index); self.energy.remove(&index); }

    /// IGCL already reports seconds, joules, MHz, Celsius, volts and RPM here.
    /// The source applies no scaling based on the native unit tags. Optional
    /// `sensor_temperature_c` must be an actual successful sensor read supplied
    /// by the caller; None leaves the field honestly absent. The runtime
    /// foundation currently does not bind those sensor APIs.
    pub fn normalize(&mut self, raw: &RawTelemetry, device: &DeviceTelemetryContext, sensor_temperature_c: Option<f64>) -> TelemetrySample {
        let item = |key: &str| raw.items.get(key).and_then(|item| finite(item.value));
        let integrated = device.integrated_or_mobile();
        let current = item("gpuCurrentClockFrequency");
        let effective = item("gpuEffectiveClock");
        let gpu_energy = item("gpuEnergyCounter");
        let total_energy = item("totalCardEnergyCounter");
        let gpu_clock = if integrated { effective.or(current).or_else(|| positive_clock(device)) } else { current.or(effective) };
        let mut sample = TelemetrySample {
            t: item("timeStamp"), gpu_clock_mhz: gpu_clock,
            mem_clock_mhz: item("vramCurrentClockFrequency").or_else(|| item("vramCurrentEffectiveFrequency")),
            temp_c: item("gpuCurrentTemperature").or_else(|| finite(sensor_temperature_c)),
            vram_temp_c: item("vramCurrentTemperature"), gpu_voltage_v: item("gpuVoltage"),
            gpu_energy_j: gpu_energy, vram_energy_j: item("vramEnergyCounter"), total_energy_j: total_energy,
            power_energy_j: if integrated { total_energy.or(gpu_energy) } else { None },
            throttle: raw.throttle.clone(), ..TelemetrySample::default()
        };
        let fans: Vec<f64> = raw.fan_rpm.iter().filter_map(|item| finite(item.value)).collect();
        if !fans.is_empty() { sample.fan_rpm = Some(fans); }
        let activity = item("globalActivityCounter").or_else(|| item("renderComputeActivityCounter"));
        sample.util_pct = self.utilization(raw.adapter_index, sample.t, activity);
        self.derive_power(raw.adapter_index, &mut sample);
        sample
    }

    /// The source tolerates a missing/failing power-telemetry surface only for
    /// integrated/mobile devices. The caller supplies wall-clock seconds and
    /// an optional successful sensor read. It must propagate discrete-device
    /// errors rather than invoke this fallback for them.
    pub fn unavailable(&mut self, index: usize, device: &DeviceTelemetryContext, wall_time_seconds: f64, sensor_temperature_c: Option<f64>) -> Result<TelemetrySample, &'static str> {
        if !device.integrated_or_mobile() { return Err("power telemetry failures must remain visible for discrete adapters"); }
        if !wall_time_seconds.is_finite() { return Err("wall-clock timestamp must be finite"); }
        let mut sample = TelemetrySample { t: Some(wall_time_seconds), gpu_clock_mhz: positive_clock(device),
            temp_c: finite(sensor_temperature_c), ..TelemetrySample::default() };
        self.derive_power(index, &mut sample);
        Ok(sample)
    }

    fn utilization(&mut self, index: usize, t: Option<f64>, counter: Option<f64>) -> Option<f64> {
        let (Some(t), Some(counter)) = (t, counter) else { return None; };
        let previous = self.activity.insert(index, Activity { t, counter })?;
        let dt = t - previous.t;
        let dc = counter - previous.counter;
        if !dt.is_finite() || !dc.is_finite() || dt <= 0.0 || dc < 0.0 { return None; }
        let util = dc / dt * 100.0;
        util.is_finite().then(|| util.clamp(0.0, 100.0))
    }
    fn derive_power(&mut self, index: usize, sample: &mut TelemetrySample) {
        let selected_power_counter = sample.power_energy_j.is_some();
        let counter = if selected_power_counter { sample.power_energy_j } else { sample.gpu_energy_j };
        let current = Energy { t: sample.t, counter, selected_power_counter };
        if let Some(previous) = self.energy.insert(index, current) {
            if previous.selected_power_counter != selected_power_counter { return; }
            if let (Some(t), Some(previous_t), Some(energy), Some(previous_energy)) = (current.t, previous.t, counter, previous.counter) {
                let dt = t - previous_t; let de = energy - previous_energy;
                if dt.is_finite() && de.is_finite() && dt > 0.0 && de >= 0.0 { sample.power_w = Some(de / dt); }
            }
        }
    }
}
fn finite(value: Option<f64>) -> Option<f64> { value.filter(|value| value.is_finite()) }
fn positive_clock(device: &DeviceTelemetryContext) -> Option<f64> { finite(device.graphics_clock_mhz).filter(|clock| *clock > 0.0) }

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::igcl_runtime::TelemetryItem;
    use serde_json::{json, Value};
    #[test]
    fn source_oracle_sequences_match() {
        let fixture: Value = serde_json::from_str(include_str!("fixtures/gpu-telemetry.json")).unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let context: DeviceTelemetryContext = serde_json::from_value(case["device"].clone()).unwrap();
            let mut normalizer = TelemetryNormalizer::default();
            let mut actual = Vec::new();
            for input in case["inputs"].as_array().unwrap() {
                let index = input["adapterIndex"].as_u64().unwrap_or(0) as usize;
                let sensor = input["sensorTemperatureC"].as_f64();
                let sample = if input["unavailable"].as_bool() == Some(true) {
                    normalizer.unavailable(index, &context, input["wallTimeSeconds"].as_f64().unwrap(), sensor).unwrap()
                } else {
                    let items = input["items"].as_object().unwrap().iter().map(|(name, value)| (name.clone(), TelemetryItem {
                        units: 0, data_type: 9, value: value.as_f64(), exact_integer: None,
                    })).collect();
                    let raw = RawTelemetry { adapter_index: index, api: "fixture", items,
                        fan_rpm: input["fanRpm"].as_array().map(|fans| fans.iter().map(|value| TelemetryItem {
                            units: 0, data_type: 9, value: value.as_f64(), exact_integer: None,
                        }).collect()).unwrap_or_default(),
                        throttle: serde_json::from_value(input["throttle"].clone()).unwrap_or_default() };
                    normalizer.normalize(&raw, &context, sensor)
                };
                actual.push(serde_json::to_value(sample).unwrap());
            }
            assert_eq!(json!(actual), case["expected"], "{}", case["name"]);
        }
    }
    #[test]
    fn unavailable_discrete_adapter_is_not_a_successful_empty_sample() {
        assert!(TelemetryNormalizer::default().unavailable(0, &DeviceTelemetryContext::default(), 1.0, None).is_err());
    }
    #[test]
    fn state_is_isolated_and_explicitly_resettable() {
        let mut state = TelemetryNormalizer::default();
        assert!(state.utilization(0, Some(1.0), Some(1.0)).is_none());
        assert!(state.utilization(1, Some(2.0), Some(2.0)).is_none());
        assert_eq!(state.utilization(0, Some(2.0), Some(1.5)), Some(50.0));
        state.clear_adapter(0); assert!(state.utilization(0, Some(3.0), Some(2.0)).is_none());
        state.clear(); assert!(state.utilization(1, Some(3.0), Some(3.0)).is_none());
    }
}
