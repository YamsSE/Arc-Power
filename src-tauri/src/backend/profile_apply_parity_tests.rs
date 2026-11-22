//! Parity replay for the native `apply-settings` profile-apply seam.
//!
//! `fixtures/profile-apply-parity.json` is generated from the unmodified
//! Electron handler (`scripts/generate-profile-apply-parity.mjs`). This module
//! replays the same cases through the public native seam:
//!
//! * `services::native_profile_apply_request` and
//!   `services::native_apply_transaction_candidate` decide whether the host
//!   claims the payload (plain native FIFO, temperature lease, or delegate);
//! * `services::invoke` is the host entry point the compatibility fallback
//!   uses (it declines in a non-elevated, GPU-less test process exactly like a
//!   host without a usable driver);
//! * `ProfileTempCeilings::plan_profile_apply` is the exact planner the native
//!   apply body runs before its first setter, so its refusal envelope can be
//!   compared field-for-field with the Electron reply.
//!
//! The GPU setter body itself is a desktop gate: it needs elevation and a live
//! adapter, so this replay pins admission plus the refusal envelope, not the
//! writes.

use serde_json::Value;
use std::path::PathBuf;

use crate::backend::native_store::NativeStore;
use crate::backend::native_system::BuildKind;
use crate::backend::profile_apply_preflight::ProfileTempCeilings;
use crate::backend::services::{
    invoke, native_apply_transaction_candidate, native_profile_apply_request, ServiceContext,
};
use crate::backend::wire::decode;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir()
            .join(format!("arc-profile-apply-parity-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn store(&self) -> NativeStore {
        NativeStore::new(self.0.clone(), "advanced").unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        if self.0.parent() == Some(std::env::temp_dir().as_path()) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

fn data() -> Value {
    serde_json::from_str(include_str!("fixtures/profile-apply-parity.json")).unwrap()
}

/// Shared-value fixtures store one copy of each envelope and each case names
/// the index it uses.
fn shared<'a>(data: &'a Value, case: &Value, field: &str) -> &'a Value {
    let index = case[field].as_u64().expect("a shared value index") as usize;
    &data["values"][index]
}

fn equivalent(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| equivalent(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, a)| b.get(key).is_some_and(|b| equivalent(a, b)))
        }
        _ => actual == expected,
    }
}

fn keys_of(value: &Value) -> Vec<&str> {
    value
        .as_object()
        .map(|object| object.keys().map(String::as_str).collect())
        .unwrap_or_default()
}

/// The public admission decision the host makes from the wire alone.
fn native_route(wire: &Value) -> &'static str {
    match native_profile_apply_request(wire) {
        Err(_) | Ok(None) => "delegate",
        Ok(Some(request)) => {
            if request.requested_temperature.is_some() {
                "lease"
            } else {
                assert!(
                    native_apply_transaction_candidate(wire),
                    "a temperature-free profile must enter the native FIFO"
                );
                "native"
            }
        }
    }
}

#[test]
fn the_native_seam_admits_exactly_the_fixture_routes() {
    let data = data();
    for case in data["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let route = native_route(shared(&data, case, "wire"));
        assert_eq!(route, case["route"].as_str().unwrap(), "{name}: native route");
    }
    let routes: Vec<&str> = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|case| case["route"].as_str().unwrap())
        .collect();
    for required in ["native", "lease", "delegate"] {
        assert!(routes.contains(&required), "the matrix must cover {required}");
    }
}

/// The host entry point must never answer a delegated profile payload with a
/// native success, and it must keep the two temperature-bearing lease branches
/// visible (a declined lease falls back to the handler, a granted one does not).
#[test]
fn the_host_entry_point_never_claims_a_delegated_profile_apply() {
    let data = data();
    let settings = data["initialSettings"].as_str().unwrap();
    for case in data["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        // A temperature-free profile is the only route that can reach the
        // driver locator before declining. Its native body needs a live GPU,
        // which is a desktop gate and must never run from a test: the admission
        // arm above already pins its route, and the refusal arm covers the
        // temperature-bearing branches below.
        if case["route"] == "native" {
            continue;
        }
        let fixture = Fixture::new();
        std::fs::write(fixture.0.join("settings.json"), settings).unwrap();
        let store = fixture.store();
        let result = invoke(
            "apply-settings",
            shared(&data, case, "wire"),
            ServiceContext {
                build_kind: BuildKind::Dev,
                mock_mode: false,
                store: &store,
            },
        );
        match result {
            None => {
                // The seam declined before any write. Every delegated payload
                // must stay with the handler; a native/lease payload declines
                // here only because this process has no elevation or driver.
                if case["route"] == "delegate" {
                    assert_eq!(case["delegate"], true, "{name}: a delegated payload must delegate");
                }
            }
            Some(Ok(encoded)) => {
                // Only a live elevated host can produce this. When it does, the
                // native envelope must be the Electron reply.
                let reply = decode(&encoded).unwrap().into_json().unwrap();
                assert!(
                    equivalent(&reply, shared(&data, case, "expectedReply")),
                    "{name}: native reply {reply}"
                );
            }
            Some(Err(error)) => {
                // The only payloads this seam rejects before delegation are
                // renderer proofs that do not match the selected target. The
                // host answers before the handler, so the renderer shows this
                // native string: it must be the handler's message verbatim.
                assert_eq!(case["route"], "delegate", "{name}: a native error must be a delegated payload");
                assert_eq!(
                    Some(error.as_str()),
                    case["error"].as_str(),
                    "{name}: the native proof error must be the Electron message"
                );
            }
        }
    }
}

/// The native preflight planner must reproduce the Electron capability
/// refusals field-for-field: the refused control set, its field order, the
/// routed controls, and the capability flags the reply carries.
#[test]
fn native_preflight_reproduces_the_electron_capability_refusals() {
    let data = data();
    let device_key = data["deviceKey"].as_str().unwrap();
    let mut checked = 0;
    for case in data["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        if case["route"] != "lease" {
            continue;
        }
        let caps = shared(&data, case, "caps");
        if caps.is_null() {
            continue;
        }
        let request = native_profile_apply_request(shared(&data, case, "wire"))
            .unwrap()
            .unwrap_or_else(|| panic!("{name}: a lease route must expose a native request"));
        let mut store = ProfileTempCeilings::default();
        if let Some(reason) = case["cacheFailure"].as_str() {
            store.poison_session(reason);
        }
        let plan = store.plan_profile_apply(device_key, &request.settings, caps);
        let expected = shared(&data, case, "expectedPerControl");
        let expected_object = expected.as_object().unwrap();

        let refused = plan.refused_per_control.as_object().unwrap();
        let electron_refused: Vec<(&String, &Value)> = expected_object
            .iter()
            .filter(|(_, entry)| entry.get("ok") == Some(&Value::Bool(false)))
            .collect();
        assert_eq!(refused.len(), electron_refused.len(), "{name}: refused control count");
        for ((native_key, native_entry), (electron_key, electron_entry)) in
            refused.iter().zip(electron_refused)
        {
            assert_eq!(native_key, electron_key, "{name}: refused control order");
            assert!(
                equivalent(native_entry, electron_entry),
                "{name}: {native_key} native={native_entry} electron={electron_entry}"
            );
            assert_eq!(
                keys_of(native_entry),
                keys_of(electron_entry),
                "{name}: {native_key} field order"
            );
        }

        let applied: Vec<&str> = expected_object
            .iter()
            .filter(|(_, entry)| entry.get("ok") == Some(&Value::Bool(true)))
            .map(|(key, _)| key.as_str())
            .collect();
        // The routed settings are the planner's internal write set, ordered by
        // the incoming payload. The renderer-visible order is the per-control
        // map asserted above, so only membership is compared here.
        let mut routed = keys_of(&plan.routed_settings);
        let mut applied = applied;
        routed.sort_unstable();
        applied.sort_unstable();
        assert_eq!(routed, applied, "{name}: routed controls");

        let reply_keys = shared(&data, case, "expectedReplyKeys").as_array().unwrap();
        let has = |key: &str| reply_keys.iter().any(|value| value.as_str() == Some(key));
        let cache_unavailable = refused.values().any(|entry| {
            entry.get("errorCode").and_then(Value::as_str) == Some("refusal-cache-unavailable")
        });
        let whole = plan
            .routed_settings
            .as_object()
            .is_some_and(|map| map.is_empty());
        if refused.is_empty() {
            // A clean temperature profile must not carry any capability flag.
            assert!(
                !has("capabilityCeilingRefused")
                    && !has("capabilityCeilingPartial")
                    && !has("temperatureRefusalCacheUnavailable"),
                "{name}: a clean plan carries no capability flags"
            );
        } else if whole {
            assert_eq!(
                has("temperatureRefusalCacheUnavailable"),
                cache_unavailable,
                "{name}: cache-unavailable flag"
            );
            assert_eq!(
                has("capabilityCeilingRefused"),
                !cache_unavailable,
                "{name}: whole-payload ceiling flag"
            );
        } else {
            // services.rs derives the flags from the FINAL per-control map, so
            // the partial test compares the valid capability entries with every
            // control that landed beside them (applied + refused).
            let valid = expected_object
                .values()
                .filter(|entry| {
                    entry.get("ok") == Some(&Value::Bool(false))
                        && entry.get("errorCode").and_then(Value::as_str) == Some("out-of-range")
                        && entry
                            .get("capabilityCeiling")
                            .and_then(Value::as_f64)
                            .is_some_and(f64::is_finite)
                })
                .count();
            assert!(has("capabilityCeilingRefused"), "{name}: partial ceiling flag");
            assert_eq!(
                has("capabilityCeilingPartial"),
                valid < expected_object.len(),
                "{name}: partial flag"
            );
        }
        checked += 1;
    }
    assert!(checked >= 5, "the lease matrix must stay broad: {checked}");
}
