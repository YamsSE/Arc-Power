//! Process-session temperature refusal ceilings shared by the Tauri broker and
//! native host. The cache is volatile, identity-bound, monotone, and poisoned
//! globally when a refusal cannot be published safely. Profile/apply
//! orchestration remains in the compatibility service during this migration;
//! all Tauri cache reads and refusal publications go through native-store RPC.

use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use super::apply_gates::{
    extended_ranges_for, temp_capability_per_control, temp_capability_refusal,
    valid_learned_temp_ceiling,
};

const TEMP_CONTROL: &str = "tempLimitC";
const SNAPSHOT_SCHEMA_VERSION: u64 = 1;
const REFUSAL_CACHE_UNAVAILABLE_MESSAGE: &str =
    "The temperature refusal cache is unavailable after a driver refusal could not be recorded. Restart Arc Power before applying a temperature limit.";

#[derive(Debug, Default)]
pub(crate) struct ProfileTempCeilings {
    by_device: HashMap<String, f64>,
    last_snapshot_sequence: HashMap<String, u64>,
    last_publication: HashMap<String, (u64, Value)>,
    unavailable: HashSet<String>,
    session_unavailable: Option<String>,
    generation: u64,
}

static SESSION_TEMP_CEILINGS: OnceLock<Mutex<ProfileTempCeilings>> = OnceLock::new();

fn session_store() -> &'static Mutex<ProfileTempCeilings> {
    SESSION_TEMP_CEILINGS.get_or_init(|| Mutex::new(ProfileTempCeilings::default()))
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ProfileApplyPlan {
    pub routed_settings: Value,
    pub refused_per_control: Value,
}

impl ProfileTempCeilings {
    /// Process-lifetime cache status shared by the Tauri broker and native
    /// host. The cache intentionally has no disk representation.
    pub(crate) fn session_snapshot(&self, device_key: &str) -> Value {
        let unavailable = self.session_unavailable.as_deref()
            .or_else(|| self.unavailable.contains(device_key).then_some(REFUSAL_CACHE_UNAVAILABLE_MESSAGE));
        json!({
            "status": if unavailable.is_some() { "unavailable" } else { "available" },
            "reason": unavailable,
            "generation": self.generation,
            "ceilings": { "tempLimitC": self.ceiling_for(device_key) },
        })
    }

    pub(crate) fn poison_session(&mut self, reason: &str) {
        if self.session_unavailable.is_none() {
            self.session_unavailable = Some(if reason.trim().is_empty() {
                REFUSAL_CACHE_UNAVAILABLE_MESSAGE.to_owned()
            } else { reason.to_owned() });
            self.advance_generation();
        }
    }

    pub(crate) fn generation(&self) -> u64 { self.generation }

    pub(crate) fn snapshot_for_device(device_key: &str) -> Result<Value, String> {
        let store = session_store().lock().map_err(|_| REFUSAL_CACHE_UNAVAILABLE_MESSAGE.to_owned())?;
        Ok(store.session_snapshot(device_key))
    }

    /// The pure profile-apply plan for one device against the shared process
    /// session cache. Callers must decline (delegate) when the cache cannot
    /// be read at all instead of guessing the refusal.
    pub(crate) fn plan_session_profile_apply(device_key: &str, settings: &Value, caps: &Value) -> Result<ProfileApplyPlan, String> {
        let store = session_store().lock().map_err(|_| REFUSAL_CACHE_UNAVAILABLE_MESSAGE.to_owned())?;
        Ok(store.plan_profile_apply(device_key, settings, caps))
    }

    /// Tauri native-store RPC entrypoint. Every read and write independently
    /// resolves the supplied PCI/BDF/LUID against a fresh IGCL inventory.
    pub(crate) fn handle_native_store_request(method: &str, encoded_args: &Value) -> Result<Value, String> {
        let values = match super::wire::decode(encoded_args)? {
            super::wire::WireValue::Array(values) => values,
            _ => return Err("Temperature refusal cache arguments must be an array".into()),
        };
        let arg_json = |index: usize| -> Result<Value, String> {
            values.get(index).ok_or("Temperature refusal cache argument is missing".to_owned())?
                .clone().into_json()
        };
        let exact_len = |count: usize| -> Result<(), String> {
            if values.len() == count { Ok(()) } else { Err("Temperature refusal cache argument count is invalid".into()) }
        };

        match method {
            "temperature-refusal-cache-read" => {
                exact_len(1)?;
                let target = arg_json(0)?;
                let (identity, _) = resolve_fresh_target(&target)?;
                let store = session_store().lock().map_err(|_| REFUSAL_CACHE_UNAVAILABLE_MESSAGE.to_owned())?;
                Ok(store.session_snapshot(&identity.device_key))
            }
            "temperature-refusal-cache-record" => {
                let result = (|| {
                    exact_len(2)?;
                    let target = arg_json(0)?;
                    let publication = arg_json(1)?;
                    let (identity, _) = resolve_fresh_target(&target)?;
                    let sequence = publication.get("transactionSequence").and_then(Value::as_u64)
                        .filter(|sequence| *sequence > 0 && *sequence <= 9_007_199_254_740_991)
                        .ok_or("Temperature refusal cache sequence is invalid")?;
                    let attempted_settings = publication.get("attemptedSettings").cloned()
                        .ok_or("Temperature refusal attempted settings are missing")?;
                    let ranges = publication.get("ranges").cloned()
                        .ok_or("Temperature refusal ranges are missing")?;
                    let per_control = publication.get("perControl").cloned()
                        .ok_or("Temperature refusal result is missing")?;
                    if per_control.get(TEMP_CONTROL).and_then(|result| result.get("ok")) != Some(&Value::Bool(false))
                        || per_control.get(TEMP_CONTROL).and_then(|result| result.get("errorCode")).and_then(Value::as_str)
                            != Some("out-of-range") {
                        return Err("Temperature refusal result is not an out-of-range refusal".into());
                    }
                    let snapshot = json!({
                        "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
                        "transactionSequence": sequence,
                        "target": target,
                        "publication": "committed",
                        "attemptedSettings": attempted_settings,
                        "ranges": ranges,
                        "perControl": per_control,
                    });
                    let mut store = session_store().lock()
                        .map_err(|_| REFUSAL_CACHE_UNAVAILABLE_MESSAGE.to_owned())?;
                    if store.session_unavailable.is_some() {
                        return Err(REFUSAL_CACHE_UNAVAILABLE_MESSAGE.to_owned());
                    }
                    if let Some(last_sequence) = store.last_snapshot_sequence.get(&identity.device_key).copied() {
                        if sequence < last_sequence {
                            return Err("Temperature refusal publication is stale".into());
                        }
                        if sequence == last_sequence {
                            if store.last_publication.get(&identity.device_key)
                                .is_some_and(|(last, previous)| *last == sequence && previous == &snapshot) {
                                return Ok(json!({
                                    "committed": true,
                                    "generation": store.generation(),
                                    "ceiling": store.ceiling_for(&identity.device_key),
                                }));
                            }
                            return Err("Temperature refusal publication conflicts with a committed sequence".into());
                        }
                    }
                    let ceiling = store.ingest_broker_snapshot(&identity, &snapshot)?;
                    store.last_publication.insert(identity.device_key.clone(), (sequence, snapshot));
                    Ok(json!({ "committed": true, "generation": store.generation(), "ceiling": ceiling }))
                })();
                if let Err(error) = &result {
                    // This RPC is issued only for an attempted temperature
                    // refusal. Any malformed or uncommitted request poisons
                    // the whole process cache before the caller can release
                    // its apply transaction.
                    if let Ok(mut store) = session_store().lock() { store.poison_session(error); }
                }
                result
            }
            "temperature-refusal-cache-poison" => {
                exact_len(1)?;
                let reason = arg_json(0)?.as_str().filter(|value| !value.trim().is_empty())
                    .ok_or("Temperature refusal cache poison reason is invalid")?.to_owned();
                let mut store = session_store().lock()
                    .map_err(|_| REFUSAL_CACHE_UNAVAILABLE_MESSAGE.to_owned())?;
                store.poison_session(&reason);
                Ok(json!({ "poisoned": true, "generation": store.generation() }))
            }
            _ => Err("Unknown temperature refusal cache method".into()),
        }
    }

    /// Consume one authenticated broker snapshot. The producer assigns
    /// `transactionSequence` while holding the shared apply FIFO and includes
    /// the authoritative capability range and full physical target row.
    ///
    /// The wire snapshot shape is:
    /// `{schemaVersion, transactionSequence, target, publication,
    /// attemptedSettings, ranges, perControl}`. `publication` is `committed`
    /// or `unavailable`. No file persistence or driver access occurs here.
    pub fn ingest_broker_snapshot(
        &mut self,
        expected: &super::gpu_apply_identity::ApplyIdentity,
        snapshot: &Value,
    ) -> Result<Option<f64>, String> {
        let attempted = snapshot.get("attemptedSettings")
            .and_then(|settings| settings.get(TEMP_CONTROL))
            .and_then(Value::as_f64);
        if snapshot.get("schemaVersion").and_then(Value::as_u64) != Some(SNAPSHOT_SCHEMA_VERSION) {
            return if attempted.is_some() {
                self.poison(expected, "temperature refusal snapshot schema is invalid")
            } else {
                Err("temperature refusal snapshot schema is invalid".into())
            };
        }
        let Some(target) = snapshot.get("target") else {
            return if attempted.is_some() {
                self.poison(expected, "temperature refusal snapshot target is missing")
            } else {
                Err("temperature refusal snapshot target is missing".into())
            };
        };
        let actual = match super::gpu_apply_identity::identity_from_row(target) {
            Ok(actual) => actual,
            Err(error) if attempted.is_some() => return self.poison(expected, &error),
            Err(error) => return Err(error),
        };
        if let Err(error) = super::gpu_apply_identity::ensure_same_target(expected, &actual) {
            return if attempted.is_some() { self.poison(expected, &error) } else { Err(error) };
        }

        let Some(sequence) = snapshot.get("transactionSequence").and_then(Value::as_u64)
            .filter(|sequence| *sequence > 0) else {
                return if attempted.is_some() {
                    self.poison(&actual, "temperature refusal snapshot sequence is invalid")
                } else {
                    Err("temperature refusal snapshot sequence is invalid".into())
                };
            };
        if self.is_unavailable(&expected.device_key) {
            return Err(REFUSAL_CACHE_UNAVAILABLE_MESSAGE.into());
        }
        // An out-of-order response is stale regardless of its payload, so it
        // is ignored wholesale before any validation: a delayed older message
        // can neither move the ceiling nor poison the cache after a newer
        // snapshot has landed.
        if self.last_snapshot_sequence.get(&expected.device_key).is_some_and(|last| sequence <= *last) {
            return Ok(self.ceiling_for(&actual.device_key));
        }
        let per = snapshot.get("perControl").and_then(|controls| controls.get(TEMP_CONTROL));
        let publication = snapshot.get("publication").and_then(Value::as_str);
        if attempted.is_some() && publication == Some("unavailable") {
            return self.poison(&actual, REFUSAL_CACHE_UNAVAILABLE_MESSAGE);
        }

        let Some(per) = per else {
            if attempted.is_some() {
                return self.poison(&actual, "temperature refusal snapshot result is missing");
            }
            self.last_snapshot_sequence.insert(actual.device_key.clone(), sequence);
            return Ok(self.ceiling_for(&actual.device_key));
        };
        let Some(ok) = per.get("ok").and_then(Value::as_bool) else {
            return self.poison(&actual, "temperature refusal snapshot result is malformed");
        };
        if ok || per.get("errorCode").and_then(Value::as_str) != Some("out-of-range") {
            if !ok && per.get("errorCode").and_then(Value::as_str).is_none() {
                return self.poison(&actual, "temperature refusal snapshot error is malformed");
            }
            self.last_snapshot_sequence.insert(actual.device_key.clone(), sequence);
            return Ok(self.ceiling_for(&actual.device_key));
        }
        if publication != Some("committed") {
            return self.poison(&actual, "temperature refusal was not published by the broker");
        }
        let Some(attempted) = attempted.filter(|value| value.is_finite()) else {
            return self.poison(&actual, "temperature refusal has no finite attempted value");
        };
        let Some(range) = snapshot.get("ranges").and_then(|ranges| ranges.get(TEMP_CONTROL)) else {
            return self.poison(&actual, "temperature refusal snapshot range is missing");
        };
        if temperature_grid(range).is_none() {
            return self.poison(&actual, "temperature refusal snapshot range is invalid");
        }
        if !valid_temperature_grid_value(attempted, range) {
            return self.poison(&actual, "temperature refusal attempted value is outside its range or grid");
        }

        let explicit_ceiling = if per.as_object().is_some_and(|per| per.contains_key("capabilityCeiling")) {
            let Some(ceiling) = per.get("capabilityCeiling").and_then(Value::as_f64) else {
                return self.poison(&actual, "temperature refusal ceiling is malformed");
            };
            if !ceiling.is_finite() || ceiling >= attempted || !valid_learned_temp_ceiling(ceiling, range) {
                return self.poison(&actual, "temperature refusal ceiling does not precede the refused value");
            }
            Some(ceiling)
        } else {
            let (min, _, step) = temperature_grid(range)
                .ok_or_else(|| "temperature refusal snapshot range is invalid".to_owned())?;
            let candidate = ((attempted - step) * 1_000_000_000.0).round() / 1_000_000_000.0;
            if !candidate.is_finite() || candidate < min || !valid_learned_temp_ceiling(candidate, range) {
                return self.poison(&actual, "temperature refusal has no valid lower grid ceiling");
            }
            None
        };
        let recorded = match explicit_ceiling {
            Some(ceiling) => self.record_capability_ceiling(&actual.device_key, ceiling, range),
            None => self.record_refusal(&actual.device_key, attempted, range),
        };
        if recorded.is_none() && self.ceiling_for(&actual.device_key).is_none() {
            return self.poison(&actual, "temperature refusal ceiling could not be recorded");
        }
        self.last_snapshot_sequence.insert(actual.device_key.clone(), sequence);
        Ok(self.ceiling_for(&actual.device_key))
    }

    fn poison<T>(&mut self, target: &super::gpu_apply_identity::ApplyIdentity, reason: &str) -> Result<T, String> {
        self.unavailable.insert(target.device_key.clone());
        Err(reason.to_owned())
    }

    pub fn is_unavailable(&self, device_key: &str) -> bool {
        self.session_unavailable.is_some() || self.unavailable.contains(device_key)
    }

    /// Learn one lower temperature ceiling from a driver refusal. The
    /// refused value is snapped down by one range step, matching Electron's
    /// no-repeat rule; this method does not talk to a driver.
    pub fn record_refusal(
        &mut self,
        device_key: &str,
        refused_value: f64,
        range: &Value,
    ) -> Option<f64> {
        let (min, _, step) = temperature_grid(range)?;
        if !refused_value.is_finite() { return None; }
        let ceiling = refused_value - step;
        if !ceiling.is_finite() || ceiling < min { return None; }
        let snapped = (ceiling * 1_000_000_000.0).round() / 1_000_000_000.0;
        self.lower(device_key, snapped)
    }

    /// Record an explicit runtime ceiling only when it is finite, in-range,
    /// and on the reported Celsius grid.
    pub fn record_capability_ceiling(
        &mut self,
        device_key: &str,
        ceiling: f64,
        range: &Value,
    ) -> Option<f64> {
        let (min, max, _) = temperature_grid(range)?;
        if !ceiling.is_finite() || ceiling < min || ceiling > max
            || !valid_learned_temp_ceiling(ceiling, range)
        {
            return None;
        }
        self.lower(device_key, ceiling)
    }

    /// Consume a per-control result envelope as inert data. Production apply
    /// routes must decide when ownership permits calling this helper.
    pub fn record_per_control_refusal(
        &mut self,
        device_key: &str,
        per_control: &Value,
        attempted_settings: &Value,
        ranges: &Value,
    ) -> Option<f64> {
        let result = per_control.get(TEMP_CONTROL)?.as_object()?;
        if result.get("ok") != Some(&Value::Bool(false))
            || result.get("errorCode").and_then(Value::as_str) != Some("out-of-range")
        {
            return None;
        }
        let range = ranges.get(TEMP_CONTROL)?;
        if result.contains_key("capabilityCeiling") {
            let ceiling = result.get("capabilityCeiling")?.as_f64()?;
            return self.record_capability_ceiling(device_key, ceiling, range);
        }
        let refused_value = attempted_settings.get(TEMP_CONTROL)?.as_f64()?;
        self.record_refusal(device_key, refused_value, range)
    }

    pub fn ceiling_for(&self, device_key: &str) -> Option<f64> {
        self.by_device.get(device_key).copied()
    }

    /// Create the pure profile-apply decision for a known learned ceiling.
    /// A refused temperature control is removed from the routed settings so
    /// callers can preserve the existing partial-apply contract. No writes
    /// are performed here.
    pub fn plan_profile_apply(
        &self,
        device_key: &str,
        settings: &Value,
        caps: &Value,
    ) -> ProfileApplyPlan {
        let unchanged = || ProfileApplyPlan {
            routed_settings: settings.clone(),
            refused_per_control: json!({}),
        };
        if self.is_unavailable(device_key) && settings.get(TEMP_CONTROL).and_then(Value::as_f64).is_some_and(f64::is_finite) {
            let refused_per_control = settings.as_object().map(|settings| settings.keys().map(|key| {
                (key.clone(), json!({
                    "ok": false,
                    "errorCode": "refusal-cache-unavailable",
                    "message": REFUSAL_CACHE_UNAVAILABLE_MESSAGE,
                }))
            }).collect()).map(Value::Object).unwrap_or_else(|| json!({}));
            return ProfileApplyPlan { routed_settings: json!({}), refused_per_control };
        }
        let Some(range) = caps.get("ranges").and_then(|ranges| ranges.get(TEMP_CONTROL)) else {
            return unchanged();
        };
        let local_ceiling = self.ceiling_for(device_key)
            .filter(|value| valid_learned_temp_ceiling(*value, range));
        let caps_ceiling = caps.get("learnedCeilings")
            .and_then(|learned| learned.get(TEMP_CONTROL))
            .and_then(Value::as_f64)
            .filter(|value| valid_learned_temp_ceiling(*value, range));
        let Some(ceiling) = (match (local_ceiling, caps_ceiling) {
            (Some(local), Some(existing)) => Some(local.min(existing)),
            (Some(local), None) => Some(local),
            (None, Some(existing)) => Some(existing),
            (None, None) => None,
        }) else { return unchanged(); };

        let mut profiled_caps = caps.clone();
        let Some(caps_object) = profiled_caps.as_object_mut() else { return unchanged(); };
        let mut learned = caps_object.get("learnedCeilings")
            .and_then(Value::as_object).cloned().unwrap_or_default();
        learned.insert(TEMP_CONTROL.to_owned(), json!(ceiling));
        caps_object.insert("learnedCeilings".to_owned(), Value::Object(learned));

        let effective_ranges = extended_ranges_for(&profiled_caps);
        let Some(refusal) = temp_capability_refusal(settings, Some(&effective_ranges)) else {
            return unchanged();
        };
        let mut routed_settings = settings.clone();
        if let Some(settings) = routed_settings.as_object_mut() {
            settings.remove(TEMP_CONTROL);
        } else {
            return unchanged();
        }
        ProfileApplyPlan {
            routed_settings,
            refused_per_control: temp_capability_per_control(&refusal),
        }
    }

    fn lower(&mut self, device_key: &str, candidate: f64) -> Option<f64> {
        if device_key.trim().is_empty() || !candidate.is_finite() { return None; }
        if self.by_device.get(device_key).is_some_and(|existing| *existing <= candidate) {
            return None;
        }
        self.by_device.insert(device_key.to_owned(), candidate);
        self.advance_generation();
        Some(candidate)
    }

    fn advance_generation(&mut self) {
        if self.generation < 9_007_199_254_740_991 { self.generation += 1; }
    }
}

/// Resolve a cache target without consulting numeric ordinals. A missing or
/// malformed PCI id, zero/missing BDF, absent/invalid LUID, duplicate key,
/// duplicate LUID, or changed physical identity fails closed.
pub(crate) fn resolve_fresh_target(target: &Value) -> Result<(super::gpu_apply_identity::ApplyIdentity, Value), String> {
    if !canonical_pci_id(target.get("pciVendorId")) || !canonical_pci_id(target.get("pciDeviceId")) {
        return Err("Temperature refusal cache target has malformed PCI identifiers".into());
    }
    let expected = super::gpu_apply_identity::identity_from_row(target)?;
    if expected.vendor != 0x8086 { return Err("Temperature refusal cache target is not an Intel adapter".into()); }
    if !canonical_luid(expected.luid.as_deref()) || !canonical_device_key(&expected.device_key) {
        return Err("Temperature refusal cache PCI/BDF/LUID identity is unavailable".into());
    }
    let path = super::gpu_devices::locate_dll().ok_or("IGCL inventory is unavailable")?;
    let devices = super::gpu_devices::list_devices(&path)?;
    let rows = devices.as_array().ok_or("IGCL inventory is invalid")?;
    let mut keys = HashSet::new();
    let mut luids = HashSet::new();
    let mut matched = None;
    for (index, row) in rows.iter().enumerate() {
        if !canonical_pci_id(row.get("pciVendorId")) || !canonical_pci_id(row.get("pciDeviceId")) {
            return Err("Fresh IGCL inventory has malformed PCI identifiers".into());
        }
        let identity = super::gpu_apply_identity::identity_from_row(row)?;
        if identity.vendor != 0x8086 || !canonical_luid(identity.luid.as_deref()) {
            return Err("Fresh IGCL inventory has an invalid writable identity".into());
        }
        if !canonical_device_key(&identity.device_key) {
            return Err("Fresh IGCL inventory has a malformed PCI/BDF key".into());
        }
        if !keys.insert(identity.device_key.clone()) || !luids.insert(identity.luid.clone().unwrap_or_default()) {
            return Err("Fresh IGCL inventory contains ambiguous PCI/LUID identities".into());
        }
        if identity.device_key == expected.device_key {
            super::gpu_apply_identity::ensure_same_target(&expected, &identity)?;
            matched = Some((index, identity));
        }
    }
    let (_, current) = matched.ok_or("Temperature refusal cache target no longer resolves")?;
    Ok((current, devices))
}

fn canonical_pci_id(value: Option<&Value>) -> bool {
    value.and_then(Value::as_str).is_some_and(|value| value.len() == 10 && value.starts_with("0x")
        && value.bytes().skip(2).all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()))
}

fn canonical_luid(value: Option<&str>) -> bool {
    value.is_some_and(|value| {
        value.len() == 21
            && value.starts_with("0x")
            && value.get(2..10).is_some_and(|part| part.bytes().all(|byte| byte.is_ascii_hexdigit()))
            && value.get(10..13).is_some_and(|part| part == ":0x")
            && value.get(13..21).is_some_and(|part| part.bytes().all(|byte| byte.is_ascii_hexdigit()))
            && value.to_ascii_lowercase() == value
            && value.to_ascii_lowercase() != "0x00000000:0x00000000"
    })
}

fn canonical_device_key(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("pci:") else { return false; };
    let Some((pci, bdf)) = rest.split_once('@') else { return false; };
    let mut ids = pci.split(':');
    let Some(vendor) = ids.next() else { return false; };
    let Some(device) = ids.next() else { return false; };
    if ids.next().is_some() { return false; }
    let Some((bus, slot_function)) = bdf.split_once(':') else { return false; };
    let Some((slot, function)) = slot_function.split_once('.') else { return false; };
    let canonical_pci_id = |value: &str| value.len() == 10 && value.starts_with("0x")
        && value.bytes().skip(2).all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase());
    canonical_pci_id(vendor) && canonical_pci_id(device)
        && bus.parse::<u32>().is_ok_and(|value| value <= 255)
        && slot.parse::<u32>().is_ok_and(|value| value <= 31)
        && function.parse::<u32>().is_ok_and(|value| value <= 7)
}

fn temperature_grid(range: &Value) -> Option<(f64, f64, f64)> {
    if range.get("units").and_then(Value::as_str) != Some("C") { return None; }
    let min = range.get("min").and_then(Value::as_f64)?;
    let max = range.get("max").and_then(Value::as_f64)?;
    let step = range.get("step").and_then(Value::as_f64)?;
    if !min.is_finite() || !max.is_finite() || !step.is_finite() || max < min || step <= 0.0 {
        return None;
    }
    Some((min, max, step))
}

fn valid_temperature_grid_value(value: f64, range: &Value) -> bool {
    let Some((min, max, step)) = temperature_grid(range) else { return false; };
    if !value.is_finite() || value < min || value > max { return false; }
    let grid = (value - min) / step;
    if !grid.is_finite() { return false; }
    let snapped = min + grid.round() * step;
    let scale = 1.0_f64.max(value.abs()).max(snapped.abs()).max(min.abs());
    (value - snapped).abs() <= f64::EPSILON * 256.0 * scale
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_row(bus: u64) -> Value {
        json!({
            "deviceKey": format!("pci:0x00008086:0x0000e20b@{bus}:0.0"),
            "pciVendorId": "0x00008086",
            "pciDeviceId": "0x0000e20b",
            "bdf": {"bus": bus, "device": 0, "function": 0},
            "luid": "0x00000001:0x00000002"
        })
    }

    fn snapshot(sequence: u64, bus: u64, attempted: Option<f64>, per: Value, publication: &str) -> Value {
        let mut attempted_settings = serde_json::Map::new();
        if let Some(value) = attempted { attempted_settings.insert(TEMP_CONTROL.into(), json!(value)); }
        json!({
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION,
            "transactionSequence": sequence,
            "target": target_row(bus),
            "publication": publication,
            "attemptedSettings": attempted_settings,
            "ranges": {"tempLimitC": temp_range(115.0)},
            "perControl": {"tempLimitC": per}
        })
    }

    fn expected(bus: u64) -> super::super::gpu_apply_identity::ApplyIdentity {
        super::super::gpu_apply_identity::identity_from_row(&target_row(bus)).unwrap()
    }

    fn temp_range(max: f64) -> Value {
        json!({"units":"C", "min":50.0, "max":max, "step":1.0, "default":90.0})
    }

    #[test]
    fn broker_snapshots_are_target_bound_versioned_and_monotone() {
        let target = expected(3);
        let mut store = ProfileTempCeilings::default();
        assert_eq!(store.ingest_broker_snapshot(
            &target,
            &snapshot(1, 3, Some(108.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed"),
        ).unwrap(), Some(107.0));
        assert_eq!(store.ingest_broker_snapshot(
            &target,
            &snapshot(2, 3, Some(100.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed"),
        ).unwrap(), Some(99.0));

        // A delayed older response cannot raise the ceiling after a newer
        // refusal has already lowered it.
        assert_eq!(store.ingest_broker_snapshot(
            &target,
            &snapshot(1, 3, Some(120.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed"),
        ).unwrap(), Some(99.0));
        assert_eq!(store.ceiling_for(&target.device_key), Some(99.0));
        assert!(!store.is_unavailable(&target.device_key));
    }

    #[test]
    fn a_stale_snapshot_with_an_invalid_attempted_value_is_ignored_not_poisoned() {
        let target = expected(3);
        let mut store = ProfileTempCeilings::default();
        assert_eq!(store.ingest_broker_snapshot(
            &target,
            &snapshot(2, 3, Some(100.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed"),
        ).unwrap(), Some(99.0));
        // A delayed older response is ignored before its payload is
        // validated: an out-of-range attempted value (or a missing one) in a
        // stale message can neither move the ceiling nor poison the cache,
        // which would otherwise block temperature applies for the session.
        assert_eq!(store.ingest_broker_snapshot(
            &target,
            &snapshot(1, 3, Some(120.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed"),
        ).unwrap(), Some(99.0));
        assert_eq!(store.ingest_broker_snapshot(
            &target,
            &snapshot(1, 3, None, json!({"ok":false,"errorCode":"out-of-range"}), "committed"),
        ).unwrap(), Some(99.0));
        assert_eq!(store.ceiling_for(&target.device_key), Some(99.0));
        assert!(!store.is_unavailable(&target.device_key));
        // The sequence watermark did not regress, so a newer response still
        // ingests normally.
        assert_eq!(store.ingest_broker_snapshot(
            &target,
            &snapshot(3, 3, Some(99.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed"),
        ).unwrap(), Some(98.0));
    }

    #[test]
    fn broker_snapshots_fail_closed_on_identity_or_publication_failure() {
        let target = expected(3);
        let wrong_target = snapshot(1, 4, Some(108.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed");
        let mut store = ProfileTempCeilings::default();
        assert!(store.ingest_broker_snapshot(&target, &wrong_target).is_err());
        assert!(store.is_unavailable(&target.device_key));

        let mut store = ProfileTempCeilings::default();
        let unavailable = snapshot(2, 3, Some(108.0), json!({"ok":false,"errorCode":"out-of-range"}), "unavailable");
        assert!(store.ingest_broker_snapshot(&target, &unavailable).is_err());
        assert!(store.is_unavailable(&target.device_key));
        let profile = store.plan_profile_apply(
            &target.device_key,
            &json!({"tempLimitC":108.0,"powerLimitW":200.0}),
            &json!({"ranges":{"tempLimitC":temp_range(115.0)}}),
        );
        assert_eq!(profile.routed_settings, json!({}));
        assert_eq!(profile.refused_per_control["tempLimitC"]["errorCode"], "refusal-cache-unavailable");
        assert_eq!(profile.refused_per_control["powerLimitW"]["errorCode"], "refusal-cache-unavailable");

        // A later response cannot clear a publication failure during this
        // process session, even if it carries a plausible committed value.
        let valid = snapshot(3, 3, Some(100.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed");
        assert!(store.ingest_broker_snapshot(&target, &valid).is_err());
        assert!(store.is_unavailable(&target.device_key));
    }

    #[test]
    fn malformed_broker_range_or_ceiling_poison_only_the_target_session_entry() {
        let target = expected(3);
        let other = expected(4);
        let mut store = ProfileTempCeilings::default();
        let mut invalid_range = snapshot(1, 3, Some(108.0), json!({"ok":false,"errorCode":"out-of-range"}), "committed");
        invalid_range["ranges"][TEMP_CONTROL]["units"] = json!("%");
        assert!(store.ingest_broker_snapshot(&target, &invalid_range).is_err());
        assert!(store.is_unavailable(&target.device_key));
        assert!(!store.is_unavailable(&other.device_key));

        let malformed_ceiling = snapshot(1, 4, Some(108.0), json!({
            "ok":false,"errorCode":"out-of-range","capabilityCeiling":"90"
        }), "committed");
        assert!(store.ingest_broker_snapshot(&other, &malformed_ceiling).is_err());
        assert!(store.is_unavailable(&other.device_key));

        let higher_target = expected(5);
        let nonlower_ceiling = snapshot(1, 5, Some(108.0), json!({
            "ok":false,"errorCode":"out-of-range","capabilityCeiling":109.0
        }), "committed");
        assert!(store.ingest_broker_snapshot(&higher_target, &nonlower_ceiling).is_err());
        assert!(store.is_unavailable(&higher_target.device_key));
    }

    #[test]
    fn non_temperature_and_non_ceiling_results_do_not_create_learned_entries() {
        let target = expected(3);
        let mut store = ProfileTempCeilings::default();
        let non_ceiling = snapshot(1, 3, Some(108.0), json!({"ok":false,"errorCode":"io-failed"}), "not-required");
        assert_eq!(store.ingest_broker_snapshot(&target, &non_ceiling).unwrap(), None);
        let no_temperature = snapshot(2, 3, None, json!({"ok":true}), "not-required");
        assert_eq!(store.ingest_broker_snapshot(&target, &no_temperature).unwrap(), None);
        assert_eq!(store.ceiling_for(&target.device_key), None);
        assert!(!store.is_unavailable(&target.device_key));
    }

    #[test]
    fn only_out_of_range_temperature_results_learn_one_step_below_refusal() {
        let mut store = ProfileTempCeilings::default();
        let ranges = json!({"tempLimitC":temp_range(115.0)});
        assert_eq!(store.record_per_control_refusal(
            "pci:gpu-a",
            &json!({"tempLimitC":{"ok":false,"errorCode":"out-of-range"}}),
            &json!({"tempLimitC":108.0}),
            &ranges,
        ), Some(107.0));
        assert_eq!(store.record_per_control_refusal(
            "pci:gpu-a",
            &json!({"tempLimitC":{"ok":false,"errorCode":"io-failed"}}),
            &json!({"tempLimitC":100.0}),
            &ranges,
        ), None);
        assert_eq!(store.record_per_control_refusal(
            "pci:gpu-a",
            &json!({"tempLimitC":{"ok":true,"errorCode":"out-of-range"}}),
            &json!({"tempLimitC":100.0}),
            &ranges,
        ), None);
        assert_eq!(store.ceiling_for("pci:gpu-a"), Some(107.0));
    }

    #[test]
    fn explicit_ceilings_require_a_valid_grid_and_never_raise_the_device_entry() {
        let mut store = ProfileTempCeilings::default();
        let range = temp_range(115.0);
        assert_eq!(store.record_capability_ceiling("pci:gpu-a", 103.0, &range), Some(103.0));
        assert_eq!(store.record_capability_ceiling("pci:gpu-a", 105.0, &range), None);
        assert_eq!(store.record_capability_ceiling("pci:gpu-a", 102.5, &range), None);
        assert_eq!(store.record_capability_ceiling("pci:gpu-b", 109.0, &range), Some(109.0));
        assert_eq!(store.ceiling_for("pci:gpu-a"), Some(103.0));
        assert_eq!(store.ceiling_for("pci:gpu-b"), Some(109.0));
    }

    #[test]
    fn learned_ceiling_filters_only_the_refused_profile_control() {
        let mut store = ProfileTempCeilings::default();
        let range = temp_range(90.0);
        assert_eq!(store.record_refusal("pci:gpu-a", 115.0, &range), Some(114.0));
        let caps = json!({"ranges":{"tempLimitC":range}});
        let plan = store.plan_profile_apply(
            "pci:gpu-a",
            &json!({"tempLimitC":115.0, "gpuFreqOffsetMhz":30.0}),
            &caps,
        );
        assert_eq!(plan.routed_settings, json!({"gpuFreqOffsetMhz":30.0}));
        assert_eq!(plan.refused_per_control["tempLimitC"]["errorCode"], "out-of-range");
        assert_eq!(plan.refused_per_control["tempLimitC"]["capabilityCeiling"], 114.0);

        let at_ceiling = store.plan_profile_apply("pci:gpu-a", &json!({"tempLimitC":114.0}), &caps);
        assert_eq!(at_ceiling.routed_settings, json!({"tempLimitC":114.0}));
        assert_eq!(at_ceiling.refused_per_control, json!({}));
    }

    #[test]
    fn profile_plan_uses_a_valid_caps_marker_when_local_session_has_none() {
        let store = ProfileTempCeilings::default();
        let caps = json!({
            "ranges":{"tempLimitC":temp_range(90.0)},
            "learnedCeilings":{"tempLimitC":104.0}
        });
        let plan = store.plan_profile_apply("pci:gpu-a", &json!({"tempLimitC":105.0}), &caps);
        assert_eq!(plan.routed_settings, json!({}));
        assert_eq!(plan.refused_per_control["tempLimitC"]["capabilityCeiling"], 104.0);
    }

    #[test]
    fn profile_plan_keeps_the_stricter_of_local_and_caps_ceilings() {
        let range = temp_range(90.0);
        let caps = json!({
            "ranges":{"tempLimitC":range},
            "learnedCeilings":{"tempLimitC":104.0}
        });
        let mut store = ProfileTempCeilings::default();
        store.record_refusal("pci:gpu-a", 103.0, &temp_range(115.0));
        let stricter_local = store.plan_profile_apply("pci:gpu-a", &json!({"tempLimitC":103.0}), &caps);
        assert_eq!(stricter_local.refused_per_control["tempLimitC"]["capabilityCeiling"], 102.0);

        store.record_refusal("pci:gpu-b", 106.0, &temp_range(115.0));
        let stricter_caps = store.plan_profile_apply("pci:gpu-b", &json!({"tempLimitC":105.0}), &caps);
        assert_eq!(stricter_caps.refused_per_control["tempLimitC"]["capabilityCeiling"], 104.0);
    }

    #[test]
    fn learned_marker_uses_the_shared_extended_range_grid_tolerance() {
        let range = temp_range(115.0);
        let just_outside_shared_tolerance = 90.0 + f64::EPSILON * 64.0 * 90.0;
        assert!(!valid_learned_temp_ceiling(just_outside_shared_tolerance, &range));

        let mut store = ProfileTempCeilings::default();
        assert_eq!(store.record_capability_ceiling(
            "pci:gpu-a", just_outside_shared_tolerance, &range,
        ), None);
        let caps = json!({
            "ranges":{"tempLimitC":range},
            "learnedCeilings":{"tempLimitC":just_outside_shared_tolerance}
        });
        let settings = json!({"tempLimitC":100.0});
        let plan = store.plan_profile_apply("pci:gpu-a", &settings, &caps);
        assert_eq!(plan.routed_settings, settings);
        assert_eq!(plan.refused_per_control, json!({}));
    }

    #[test]
    fn missing_or_invalid_session_entries_leave_profile_settings_untouched() {
        let mut store = ProfileTempCeilings::default();
        let range = temp_range(90.0);
        store.record_refusal("pci:gpu-a", 130.0, &range);
        let caps = json!({"ranges":{"tempLimitC":range}});
        let settings = json!({"tempLimitC":115.0, "gpuFreqOffsetMhz":30.0});
        let no_entry = store.plan_profile_apply("pci:gpu-b", &settings, &caps);
        assert_eq!(no_entry.routed_settings, settings);
        assert_eq!(no_entry.refused_per_control, json!({}));
        let ignored_over_extended_range = store.plan_profile_apply("pci:gpu-a", &settings, &caps);
        assert_eq!(ignored_over_extended_range.routed_settings, settings);
        assert_eq!(ignored_over_extended_range.refused_per_control, json!({}));

        let caps_only = json!({
            "ranges":{"tempLimitC":temp_range(90.0)},
            "learnedCeilings":{"tempLimitC":104.5}
        });
        let invalid_marker = store.plan_profile_apply("pci:gpu-b", &settings, &caps_only);
        assert_eq!(invalid_marker.routed_settings, settings);
        assert_eq!(invalid_marker.refused_per_control, json!({}));
    }

    #[test]
    fn direct_capability_marker_is_not_reinterpreted_when_invalid() {
        let mut store = ProfileTempCeilings::default();
        let ranges = json!({"tempLimitC":temp_range(115.0)});
        assert_eq!(store.record_per_control_refusal(
            "pci:gpu-a",
            &json!({"tempLimitC":{"ok":false,"errorCode":"out-of-range","capabilityCeiling":103.5}}),
            &json!({"tempLimitC":110.0}),
            &ranges,
        ), None);
        assert_eq!(store.ceiling_for("pci:gpu-a"), None);
    }

    #[test]
    fn shared_refusal_cache_fixtures_match_rust_preflight_decisions() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/temperature-refusal-cache-v1.json"
        )).unwrap();
        let mut learning_decisions = 0;
        for scenario in fixture["learningCases"].as_array().unwrap() {
            let mut store = ProfileTempCeilings::default();
            for operation in scenario["operations"].as_array().unwrap() {
                let result = &operation["result"];
                let range = operation["range"].clone();
                let ranges = json!({"tempLimitC":range});
                let attempted = &operation["attempted"];
                if attempted.get("nonFinite").and_then(Value::as_str) == Some("NaN") {
                    assert_eq!(
                        store.record_refusal("pci:0x00008086:0x0000e20b@3:0.0", f64::NAN, &range),
                        None,
                        "{} rejects non-finite attempted temperatures",
                        scenario["id"].as_str().unwrap(),
                    );
                } else {
                    let attempted_settings = if result.get(TEMP_CONTROL).is_some() {
                        let mut settings = serde_json::Map::new();
                        settings.insert(TEMP_CONTROL.to_owned(), attempted.clone());
                        Value::Object(settings)
                    } else {
                        json!({"powerLimitW":attempted})
                    };
                    store.record_per_control_refusal(
                        "pci:0x00008086:0x0000e20b@3:0.0",
                        result,
                        &attempted_settings,
                        &ranges,
                    );
                }

                let expected = operation["expectedCeilings"].as_array().unwrap()
                    .last().unwrap().as_f64();
                assert_eq!(
                    store.ceiling_for("pci:0x00008086:0x0000e20b@3:0.0"),
                    expected,
                    "{} resulting ceiling after operation {}",
                    scenario["id"].as_str().unwrap(),
                    learning_decisions + 1,
                );
                learning_decisions += 1;
            }
        }
        assert_eq!(learning_decisions, 13);
    }

    #[test]
    fn shared_refusal_cache_identity_fixtures_match_rust_identity_seams() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../fixtures/temperature-refusal-cache-v1.json"
        )).unwrap();
        let mut decisions = 0;
        for scenario in fixture["identityCases"].as_array().unwrap() {
            let selected = &scenario["selected"];
            let expected = super::super::gpu_apply_identity::identity_from_row(selected);
            let result = expected.and_then(|expected| {
                let writable_rows = scenario["inventory"].as_array().unwrap().iter()
                    .filter(|row| row["writable"] == Value::Bool(true))
                    .cloned()
                    .collect::<Vec<_>>();
                super::super::gpu_apply_identity::unique_target_index(&writable_rows, &expected)
                    .map(|index| (index, expected.device_key))
            });
            if scenario["expected"]["status"] == "resolved" {
                let (index, key) = result.unwrap_or_else(|error| {
                    panic!("{} unexpectedly rejected: {error}", scenario["id"])
                });
                assert_eq!(index, scenario["expected"]["index"].as_u64().unwrap() as usize,
                    "{}", scenario["id"]);
                assert_eq!(key, scenario["expected"]["deviceKey"].as_str().unwrap(),
                    "{}", scenario["id"]);
            } else {
                assert!(result.is_err(), "{} unexpectedly resolved", scenario["id"]);
            }
            decisions += 1;
        }
        assert_eq!(decisions, 9);
    }

    fn profile_caps() -> Value {
        json!({
            "pciDeviceId": "0x0000e20b",
            "ranges": {"tempLimitC": {"units": "C", "min": 50.0, "max": 115.0, "step": 1.0, "default": 90.0}},
        })
    }

    #[test]
    fn profile_plan_routes_a_learned_ceiling_refusal_and_keeps_other_controls() {
        let target = expected(3);
        let mut store = ProfileTempCeilings::default();
        assert_eq!(store.ingest_broker_snapshot(
            &target,
            &snapshot(1, 3, Some(108.0), json!({"ok": false, "errorCode": "out-of-range"}), "committed"),
        ).unwrap(), Some(107.0));

        // A mixed profile routes the refused temperature out and refuses only
        // that control with the M50 marker shape the broker merges after
        // runApply (ok:false + out-of-range + finite capabilityCeiling +
        // message).
        let plan = store.plan_profile_apply(&target.device_key,
            &json!({"tempLimitC": 108, "powerLimitW": 240}), &profile_caps());
        assert_eq!(plan.routed_settings, json!({"powerLimitW": 240}));
        let refused = plan.refused_per_control.as_object().unwrap();
        assert_eq!(refused.len(), 1);
        let temp = refused.get("tempLimitC").unwrap();
        assert_eq!(temp["ok"], json!(false));
        assert_eq!(temp["errorCode"], json!("out-of-range"));
        assert_eq!(temp["capabilityCeiling"], json!(107.0));
        assert!(temp["message"].as_str().unwrap().contains("exceeds the effective capability ceiling of 107"));

        // A temperature-only profile is a whole-payload refusal: the caller
        // answers with {result, state, capabilityCeilingRefused: true}.
        let whole = store.plan_profile_apply(&target.device_key,
            &json!({"tempLimitC": 120}), &profile_caps());
        assert_eq!(whole.routed_settings, json!({}));
        assert_eq!(whole.refused_per_control.as_object().unwrap().len(), 1);

        // At or below the learned ceiling the plan routes everything.
        let unchanged = store.plan_profile_apply(&target.device_key,
            &json!({"tempLimitC": 100, "powerLimitW": 240}), &profile_caps());
        assert_eq!(unchanged.refused_per_control, json!({}));
        assert_eq!(unchanged.routed_settings, json!({"tempLimitC": 100, "powerLimitW": 240}));
    }

    #[test]
    fn profile_plan_refuses_everything_only_while_the_cache_is_unavailable() {
        let target = expected(3);
        let mut store = ProfileTempCeilings::default();
        store.poison_session("test poison");
        let plan = store.plan_profile_apply(&target.device_key,
            &json!({"tempLimitC": 88, "powerLimitW": 240}), &profile_caps());
        assert_eq!(plan.routed_settings, json!({}));
        let refused = plan.refused_per_control.as_object().unwrap();
        assert_eq!(refused.len(), 2);
        for entry in refused.values() {
            assert_eq!(entry["errorCode"], json!("refusal-cache-unavailable"));
        }
        // A temperature-free profile is unaffected by the cache state.
        let no_temp = store.plan_profile_apply(&target.device_key,
            &json!({"powerLimitW": 240}), &profile_caps());
        assert_eq!(no_temp.routed_settings, json!({"powerLimitW": 240}));
        assert_eq!(no_temp.refused_per_control, json!({}));
    }
}
