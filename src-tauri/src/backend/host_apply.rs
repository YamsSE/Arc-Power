//! Host-initiated profile apply entry point (boot/tray actions).
//!
//! Boot (`--boot-apply`) and tray ("apply-profile") applies are host-originated:
//! they name a profile id, while the native apply seam is keyed on a renderer
//! `apply-settings` payload carrying physical target proof. This module turns
//! the id into that proven payload and runs the same shared profile preflight
//! planner a renderer apply uses.
//!
//! Slice 1 stops at the payload and the plan. Slice 2 (`apply_host_profile`)
//! owns the host-owned reads (settings, profiles, native inventory, the
//! `get-capabilities` snapshot) and executes the plan exactly once through
//! `execute_host_profile_apply`, on the host's single shared apply route. Every
//! case the host cannot prove returns `Delegate` so the caller keeps the
//! compatibility broker route; nothing is ever guessed, and `Delegate` always
//! means nothing was written.
//!
//! Target selection mirrors Electron's three-source precedence
//! (`src/main/apply-on-boot.js:357-364`): the profile's own `deviceKey`, then
//! the per-apply `deviceKey` argument, then the persisted
//! `settings.deviceKey`. The middle source is not optional: boot and tray
//! apply one profile per physical GPU and pass the `activeProfileIds` map key
//! when the profile carries no own key (`src/main/tray-apply.js:74-84`,
//! `src/main/boot-apply-mode.js:64`). Dropping it silently applies a legacy
//! profile to whatever GPU the global selection points at.

use super::{
    apply_gates::{
        extended_unavailable_per_control, extended_unavailable_refusal,
        is_sysman_primary_power_request, oc_mode_refusal, refusal_per_control,
        wc_unit_controls, ExtendedUnavailable, LimitsKey, EXTENDED_UNAVAILABLE_MSG,
        OC_MODE_ADVANCED,
    },
    gpu_apply_identity::{identity_from_row, ApplyIdentity},
    gpu_devices,
    profile_apply_preflight::{ProfileApplyPlan, ProfileTempCeilings},
    profile_store::ProfileStore,
    services, wire,
};
use serde_json::{json, Value};

/// Which host is asking. Only the elevated native host may apply natively;
/// mock and unelevated runs always fall back to the compatibility broker.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostApplyHost {
    ElevatedNative,
    Unelevated,
    Mock,
}

/// A host-resolved physical apply target. Unlike renderer proof, this is
/// derived from the inventory the host just read, so there is no renderer
/// session to be stale against.
#[derive(Clone, Debug, PartialEq)]
pub struct HostTarget {
    pub device_id: u64,
    pub device_key: String,
    pub physical_target: Value,
}

/// Typed failure for profile/device resolution. Every failure delegates; the
/// variants exist so the caller can log or report the exact cause.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HostApplyFailure {
    ProfileNotFound { profile_id: String },
    ProfileStore { message: String },
    ProfileInvalid { message: String },
    NoDevices,
    NoPersistedDevice,
    DeviceNotEnumerated { device_key: String },
    DeviceAmbiguous { device_key: String },
    DeviceNotWritable { device_key: String },
    DeviceIdentity { message: String },
}

impl HostApplyFailure {
    /// Electron's boot/tray reason vocabulary where it exists.
    pub fn reason(&self) -> String {
        match self {
            Self::ProfileNotFound { profile_id } => format!("profile '{profile_id}' not found"),
            Self::ProfileStore { message } => format!("profile store unavailable: {message}"),
            Self::ProfileInvalid { message } => format!("profile invalid: {message}"),
            Self::NoDevices => "no devices enumerated".into(),
            Self::NoPersistedDevice => "no persisted GPU selection".into(),
            Self::DeviceNotEnumerated { .. }
            | Self::DeviceAmbiguous { .. }
            | Self::DeviceNotWritable { .. } => {
                "stale GPU target: the persisted device is no longer enumerated".into()
            }
            Self::DeviceIdentity { message } => {
                format!("device target resolution failed: {message}")
            }
        }
    }
}

/// Why a refusal stopped the apply. The first five are config refusals made
/// before any setter; `Driver` is the driver's own per-control answer and
/// `ExecutionFailed` is the fail-closed terminal case where a setter may have
/// run. `flags` keeps Electron's reply vocabulary so the feedback slice can map
/// it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HostRefusalKind {
    Ceiling,
    ExtendedUnavailable,
    Waiver,
    CapabilityCeiling,
    RefusalCacheUnavailable,
    /// The native apply answered with per-control refusals.
    Driver,
    /// The execution failed or is unverifiable. Nothing is retried through the
    /// compatibility broker because a setter may already have run.
    ExecutionFailed,
}

impl HostRefusalKind {
    pub fn flags(self) -> Value {
        match self {
            Self::Ceiling => json!({ "ocModeRefused": true }),
            Self::ExtendedUnavailable => json!({ "extendedUnavailable": true }),
            Self::Waiver => json!({}),
            Self::CapabilityCeiling => json!({ "capabilityCeilingRefused": true }),
            Self::RefusalCacheUnavailable => json!({ "temperatureRefusalCacheUnavailable": true }),
            Self::Driver => json!({}),
            Self::ExecutionFailed => json!({ "applyFailed": true }),
        }
    }
}

/// A proven payload plus the shared preflight plan.
#[derive(Clone, Debug, PartialEq)]
pub struct HostApplyPlan {
    /// Tagged wire args, exactly the renderer `apply-settings` array shape.
    pub payload: Value,
    pub target: HostTarget,
    /// Profile settings after the planner routed refused controls out.
    pub routed_settings: Value,
    /// Per-control refusals; empty unless the planner refused a subset.
    pub refused_per_control: Value,
}

/// The host entry point's decision.
#[derive(Clone, Debug, PartialEq)]
pub enum HostApplyOutcome {
    /// The payload is proven but not yet executed. `execute_host_profile_apply`
    /// consumes it: this is the only outcome that may reach a setter.
    Planned(HostApplyPlan),
    Applied { result: Value, state: Value },
    Refused { reason: String, per_control: Value, kind: HostRefusalKind },
    AlreadyApplied { result: Value, state: Value },
    /// Nothing was written and the caller must keep the compatibility broker
    /// route. This is the only fallback signal; it is never combined with an
    /// apply.
    Delegate { reason: String },
}

impl HostApplyOutcome {
    pub fn delegate(reason: impl Into<String>) -> Self {
        Self::Delegate { reason: reason.into() }
    }

    /// Electron's `reason` field for the terminal outcomes that carry one.
    pub fn reason(&self) -> Option<&str> {
        match self {
            Self::Refused { reason, .. } | Self::Delegate { reason } => Some(reason),
            _ => None,
        }
    }
}

/// The host inputs that come from the caller (slice 2) rather than a renderer.
pub struct HostApplyInputs<'a> {
    /// Persisted app settings (`waiverAccepted`, device selection).
    pub app_settings: &'a Value,
    /// Capabilities for the resolved device.
    pub caps: &'a Value,
    /// Bundled 2023 runtime capability (`legacy_igcl::capability`).
    pub extended_capable: bool,
    /// Whether Sysman power limits are available.
    pub sysman_power_limits: bool,
}

/// One boot/tray apply request.
pub struct HostApplyRequest<'a> {
    pub profile_id: &'a str,
    pub host: HostApplyHost,
    /// Per-apply device key from the boot/tray entry (`entry.deviceKey`, which
    /// can be the `activeProfileIds` map key when the profile has no own key).
    /// This is the middle precedence source; `None` or `""` means "not
    /// supplied" and falls through to `app_settings.deviceKey`.
    pub device_key: Option<&'a str>,
    pub app_settings: &'a Value,
    /// Native device inventory (`list-devices` / `list_devices_merged`).
    pub inventory: &'a [Value],
    /// Capabilities, or `None` when they could not be read.
    pub caps: Option<&'a Value>,
    pub extended_capable: bool,
    pub sysman_power_limits: bool,
}

/// Resolve one profile through the single profile store reader.
pub fn resolve_profile(store: &ProfileStore, profile_id: &str) -> Result<Value, HostApplyFailure> {
    let profiles = store
        .load_profiles()
        .map_err(|message| HostApplyFailure::ProfileStore { message })?;
    resolve_profile_in(&profiles, profile_id)
}

/// Resolve one profile from an already-read profile list. The host entry reads
/// the same `load-profiles` document the renderer asks for, so it never opens a
/// second profiles reader.
pub fn resolve_profile_in(
    profiles: &[Value],
    profile_id: &str,
) -> Result<Value, HostApplyFailure> {
    let profile = profiles
        .iter()
        .find(|profile| profile.get("id").and_then(Value::as_str) == Some(profile_id))
        .ok_or_else(|| HostApplyFailure::ProfileNotFound { profile_id: profile_id.to_owned() })?;
    if !profile.get("settings").is_some_and(Value::is_object) {
        return Err(HostApplyFailure::ProfileInvalid {
            message: format!("profile '{profile_id}' has no settings object"),
        });
    }
    Ok(profile.clone())
}

/// Resolve the persisted selection against the native inventory.
///
/// This is a host-origin resolution, not renderer proof: the renderer asserts
/// a row it cached earlier, while the host derives the target from the current
/// inventory and pins it by durable key.
///
/// Precedence is Electron's three-source rule
/// (`src/main/apply-on-boot.js:357-364`):
/// `profile.deviceKey ?? request_key ?? app_settings.deviceKey`. The middle
/// source is the boot/tray entry's key (the `activeProfileIds` map key when
/// the profile has no own key: `src/main/tray-apply.js:74-84`,
/// `src/main/boot-apply-mode.js:64`); without it a legacy profile bound to
/// GPU A resolves to the global selection's GPU B. An absent or empty request
/// key behaves exactly like an absent profile key.
///
/// A missing, ambiguous or non-writable row is a hard stale-target failure —
/// never an ordinal fallback, because an ordinal is not stable across
/// re-enumeration. The numeric ordinal always comes from the matched row,
/// never from settings.
pub fn resolve_host_target(
    inventory: &[Value],
    app_settings: &Value,
    profile: &Value,
    request_key: Option<&str>,
) -> Result<HostTarget, HostApplyFailure> {
    if inventory.is_empty() {
        return Err(HostApplyFailure::NoDevices);
    }
    let key = profile
        .get("deviceKey")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
        .or_else(|| request_key.filter(|key| !key.is_empty()))
        .or_else(|| {
            app_settings
                .get("deviceKey")
                .and_then(Value::as_str)
                .filter(|key| !key.is_empty())
        })
        .ok_or(HostApplyFailure::NoPersistedDevice)?;

    let matches: Vec<&Value> = inventory
        .iter()
        .filter(|row| row_matches_key(row, key))
        .collect();
    let row = match matches.len() {
        0 => return Err(HostApplyFailure::DeviceNotEnumerated { device_key: key.into() }),
        1 => matches[0],
        _ => return Err(HostApplyFailure::DeviceAmbiguous { device_key: key.into() }),
    };
    if !writable_row(row) {
        // Intentional slice-2 coverage gap: a `pnp:`-keyed selection only
        // ever matches an OS identity row, which is non-writable here, so
        // PNP-bound profiles always delegate. Electron bridges the key with a
        // live PNP-location snapshot (`src/main/apply-on-boot.js:281-286`)
        // after one re-enumeration on a key miss (`:262-271`). That is safe
        // because the compatibility broker performs the actual apply.
        return Err(HostApplyFailure::DeviceNotWritable { device_key: key.into() });
    }
    let identity = identity_from_row(row)
        .map_err(|message| HostApplyFailure::DeviceIdentity { message })?;
    if identity.vendor != 0x8086 {
        return Err(HostApplyFailure::DeviceIdentity {
            message: "the persisted device is not an Intel adapter".into(),
        });
    }
    let device_id = row
        .get("id")
        .and_then(Value::as_u64)
        .ok_or_else(|| HostApplyFailure::DeviceIdentity {
            message: "the persisted device has no inventory ordinal".into(),
        })?;
    Ok(HostTarget {
        device_id,
        device_key: identity.device_key.clone(),
        physical_target: physical_target(&identity, row),
    })
}

/// Turn one resolved profile into the proven `apply-settings` payload, after
/// the same config gates and the same shared planner a renderer apply runs.
pub fn plan_host_profile_apply(
    profile: &Value,
    target: &HostTarget,
    inputs: &HostApplyInputs<'_>,
) -> HostApplyOutcome {
    plan_host_profile_apply_with(
        |device_key, settings, caps| {
            ProfileTempCeilings::plan_session_profile_apply(device_key, settings, caps)
        },
        profile,
        target,
        inputs,
    )
}

pub(crate) fn plan_host_profile_apply_with(
    planner: impl FnOnce(&str, &Value, &Value) -> Result<ProfileApplyPlan, String>,
    profile: &Value,
    target: &HostTarget,
    inputs: &HostApplyInputs<'_>,
) -> HostApplyOutcome {
    let settings = match profile.get("settings").filter(|settings| settings.is_object()) {
        Some(settings) => settings,
        None => return HostApplyOutcome::delegate("profile settings are unavailable"),
    };
    let caps = inputs.caps;
    let ranges = caps.get("ranges");
    let limits = LimitsKey {
        pci_device_id: caps.get("pciDeviceId").and_then(Value::as_str),
        aib_vendor: caps.get("aibVendor").and_then(Value::as_str),
    };

    // Electron skips both waiver gates on OC-locked devices; the driver's
    // per-control `unsupported` answers are the honest floor there.
    //
    // Known, deliberate ordering divergence: Electron probes the refusal-cache
    // latch immediately after profile lookup, before device/caps/waiver/ceiling
    // (`src/main/apply-on-boot.js:342-356`), so a poisoned cache wins over a
    // missing waiver or an above-ceiling value. Native has no
    // device-independent probe of the session latch — `profile_apply_preflight`
    // only exposes device-keyed `snapshot_for_device` / the planner — and
    // adding one would widen that module's crate surface. So the cache gate
    // stays in the planner and runs after these gates: the refusal envelope is
    // identical, but the reported reason/flags differ when the cache is
    // poisoned *and* the waiver is unaccepted or the profile is above ceiling.
    // `refusal_cache_probe_runs_after_the_waiver_and_ceiling_gates` pins this
    // order so it stays a choice, not an accident.
    if caps.get("overclockingSupported") != Some(&Value::Bool(false)) {
        if inputs.app_settings.get("waiverAccepted") != Some(&Value::Bool(true)) {
            return refused("Waiver not accepted", json!({}), HostRefusalKind::Waiver);
        }
        if caps.get("waiverAccepted") != Some(&Value::Bool(true)) {
            return refused("waiver not accepted on the device", json!({}), HostRefusalKind::Waiver);
        }
    }

    // A profile always gates as advanced: the saved values are applied as
    // saved against the driver's true limits. The ceiling refusal stays.
    if let Some(refusal) = oc_mode_refusal(OC_MODE_ADVANCED, settings, ranges, Some(limits)) {
        return refused(
            refusal.message,
            refusal_per_control(&refusal),
            HostRefusalKind::Ceiling,
        );
    }

    let sysman_primary = is_sysman_primary_power_request(settings, ranges, inputs.sysman_power_limits);
    let mut gate_caps = caps.clone();
    gate_caps["extendedRanges"] = json!(inputs.extended_capable);
    let mut unavailable = extended_unavailable_refusal(settings, &gate_caps, sysman_primary);
    if unavailable.is_none() && !inputs.extended_capable {
        let wc: Vec<&'static str> = wc_unit_controls(settings, ranges)
            .into_iter()
            .filter(|control| *control != "powerLimitW" || !sysman_primary)
            .collect();
        if !wc.is_empty() {
            unavailable = Some(ExtendedUnavailable {
                controls: wc,
                message: EXTENDED_UNAVAILABLE_MSG,
            });
        }
    }
    if let Some(unavailable) = unavailable {
        // Electron refuses only when every requested control is refused;
        // a mixed profile keeps its partial-apply behavior in the broker.
        let all_refused = settings.as_object().is_some_and(|settings| {
            !settings.is_empty()
                && settings
                    .keys()
                    .all(|key| unavailable.controls.contains(&key.as_str()))
        });
        if !all_refused {
            return HostApplyOutcome::delegate(
                "extended power/temperature controls require the compatibility broker",
            );
        }
        return refused(
            unavailable.message,
            extended_unavailable_per_control(&unavailable.controls),
            HostRefusalKind::ExtendedUnavailable,
        );
    }

    // An OC-locked device cannot apply natively; the broker owns the exact
    // per-control `unsupported` envelope.
    if caps.get("overclockingSupported") == Some(&Value::Bool(false)) {
        return HostApplyOutcome::delegate("overclocking is not supported on this GPU");
    }

    // The shared process refusal cache owns learned temperature ceilings and
    // refusal-cache authority for every profile apply.
    let plan = match planner(&target.device_key, settings, caps) {
        Ok(plan) => plan,
        Err(_) => return HostApplyOutcome::delegate("temperature refusal cache is unavailable"),
    };
    let refused_count = plan.refused_per_control.as_object().map(|map| map.len()).unwrap_or(0);
    let routed_count = plan.routed_settings.as_object().map(|map| map.len()).unwrap_or(0);
    if refused_count > 0 && routed_count == 0 {
        let cache_unavailable = plan.refused_per_control.as_object().is_some_and(|map| {
            map.values().any(|entry| {
                entry.get("errorCode").and_then(Value::as_str) == Some("refusal-cache-unavailable")
            })
        });
        let reason = plan
            .refused_per_control
            .as_object()
            .and_then(|map| map.values().find_map(|entry| entry.get("message").and_then(Value::as_str)))
            .unwrap_or("temperature capability ceiling refused")
            .to_owned();
        return refused(
            reason,
            plan.refused_per_control,
            if cache_unavailable {
                HostRefusalKind::RefusalCacheUnavailable
            } else {
                HostRefusalKind::CapabilityCeiling
            },
        );
    }

    let args = json!([
        target.device_id,
        plan.routed_settings,
        {
            "profileApply": true,
            "expectedTarget": {
                "deviceKey": target.device_key,
                "physicalTarget": target.physical_target,
            },
        },
    ]);
    let payload = match wire::encode_json(&args) {
        Ok(payload) => payload,
        Err(_) => return HostApplyOutcome::delegate("profile settings are not JSON-safe"),
    };
    // Prove the payload is claimable by the same parser the native seam uses;
    // VF profiles, unknown controls and empty profiles keep the broker route.
    match services::native_profile_apply_request(&payload) {
        Ok(Some(_)) => HostApplyOutcome::Planned(HostApplyPlan {
            payload,
            target: target.clone(),
            routed_settings: plan.routed_settings,
            refused_per_control: plan.refused_per_control,
        }),
        Ok(None) => HostApplyOutcome::delegate("the profile payload is not a proven native apply"),
        Err(error) => HostApplyOutcome::delegate(error),
    }
}

/// Full host entry point: host eligibility, profile resolution, target
/// resolution and planning. Any failure delegates to the compatibility broker.
pub fn prepare_host_profile_apply(
    store: &ProfileStore,
    request: &HostApplyRequest<'_>,
) -> HostApplyOutcome {
    if let Some(reason) = host_delegate_reason(request.host) {
        return HostApplyOutcome::delegate(reason);
    }
    let profile = match resolve_profile(store, request.profile_id) {
        Ok(profile) => profile,
        Err(failure) => return HostApplyOutcome::delegate(failure.reason()),
    };
    let target = match resolve_host_target(
        request.inventory,
        request.app_settings,
        &profile,
        request.device_key,
    ) {
        Ok(target) => target,
        Err(failure) => return HostApplyOutcome::delegate(failure.reason()),
    };
    let Some(caps) = request.caps else {
        return HostApplyOutcome::delegate("GPU capabilities are unavailable");
    };
    plan_host_profile_apply(
        &profile,
        &target,
        &HostApplyInputs {
            app_settings: request.app_settings,
            caps,
            extended_capable: request.extended_capable,
            sysman_power_limits: request.sysman_power_limits,
        },
    )
}

/// Why this host can never apply natively. `None` is the only host allowed to
/// reach a setter. Mock and unelevated runs delegate before any read.
pub fn host_delegate_reason(host: HostApplyHost) -> Option<&'static str> {
    match host {
        HostApplyHost::ElevatedNative => None,
        HostApplyHost::Mock => {
            Some("mock runs delegate GPU applies to the compatibility broker")
        }
        HostApplyHost::Unelevated => {
            Some("unelevated hosts delegate GPU applies to the compatibility broker")
        }
    }
}

/// The two capability inputs that are not part of a device snapshot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HostCapabilities {
    /// The bundled 2023 runtime can write extended power/temperature
    /// (`legacy_igcl::capability`).
    pub extended: bool,
    /// Sysman power writes are available on this host.
    pub sysman_power_limits: bool,
}

/// Host-owned reads the executor needs. Every one is a closure so the complete
/// entry point runs from fakes in tests and never reads a real device there.
/// `caps` receives the already-resolved target, so the capability read happens
/// once, for the GPU the profile actually targets.
pub struct HostApplyReads<'a> {
    /// Persisted app settings (`load-settings`).
    pub settings: &'a dyn Fn() -> Result<Value, String>,
    /// The profile list (`load-profiles`).
    pub profiles: &'a dyn Fn() -> Result<Vec<Value>, String>,
    /// Native device inventory (`list-devices` / `list_devices_merged`).
    pub inventory: &'a dyn Fn() -> Vec<Value>,
    /// Device capabilities (`get-capabilities`), or `None` when unreadable.
    pub caps: &'a dyn Fn(&HostTarget) -> Option<Value>,
    pub capabilities: HostCapabilities,
}

/// One execution on the host's shared apply route.
#[derive(Clone, Debug, PartialEq)]
pub enum HostApplyExecution {
    /// The native route answered with its decoded `apply-settings` envelope
    /// (`{"result": {...}, "state": ...}` plus any envelope flags).
    Replied(Value),
    /// The native route declined before any setter. Nothing was written, so the
    /// caller may still hand the profile to the compatibility broker.
    Declined,
}

/// Plan one host apply without executing it. Shared by `apply_host_profile`
/// and the tray coordinator, which must know whether EVERY active profile can
/// be owned natively before any setter runs; otherwise one delegated GPU would
/// be applied twice (once natively, once by the broker relay).
pub fn plan_host_profile(
    host: HostApplyHost,
    profile_id: &str,
    device_key: Option<&str>,
    reads: &HostApplyReads<'_>,
) -> HostApplyOutcome {
    if let Some(reason) = host_delegate_reason(host) {
        return HostApplyOutcome::delegate(reason);
    }
    let settings = match (reads.settings)() {
        Ok(settings) => settings,
        Err(error) => {
            return HostApplyOutcome::delegate(format!("app settings are unavailable: {error}"))
        }
    };
    let profiles = match (reads.profiles)() {
        Ok(profiles) => profiles,
        Err(error) => {
            return HostApplyOutcome::delegate(format!("profile store unavailable: {error}"))
        }
    };
    let profile = match resolve_profile_in(&profiles, profile_id) {
        Ok(profile) => profile,
        Err(failure) => return HostApplyOutcome::delegate(failure.reason()),
    };
    let inventory = (reads.inventory)();
    let target = match resolve_host_target(&inventory, &settings, &profile, device_key) {
        Ok(target) => target,
        Err(failure) => return HostApplyOutcome::delegate(failure.reason()),
    };
    let Some(caps) = (reads.caps)(&target) else {
        return HostApplyOutcome::delegate("GPU capabilities are unavailable");
    };
    plan_host_profile_apply(
        &profile,
        &target,
        &HostApplyInputs {
            app_settings: &settings,
            caps: &caps,
            extended_capable: reads.capabilities.extended,
            sysman_power_limits: reads.capabilities.sysman_power_limits,
        },
    )
}

/// Full host entry point for a boot/tray apply: eligibility, reads, planning
/// and one execution. `execute` receives the plan only when it is `Planned`, so
/// a `Delegate` or `Refused` outcome performs zero executions.
pub fn apply_host_profile(
    host: HostApplyHost,
    profile_id: &str,
    device_key: Option<&str>,
    reads: &HostApplyReads<'_>,
    execute: impl FnOnce(&HostApplyPlan) -> Result<HostApplyExecution, String>,
) -> HostApplyOutcome {
    let planned = plan_host_profile(host, profile_id, device_key, reads);
    execute_host_profile_apply(planned, execute)
}

/// Execute a prepared outcome at most once. `Planned` is handed to `execute`;
/// every other outcome is returned untouched, so a refusal or a delegate never
/// reaches a setter. An execution error fails closed as
/// `Refused { kind: ExecutionFailed }` and never becomes `Delegate`, because a
/// setter may already have run.
pub fn execute_host_profile_apply(
    outcome: HostApplyOutcome,
    execute: impl FnOnce(&HostApplyPlan) -> Result<HostApplyExecution, String>,
) -> HostApplyOutcome {
    let HostApplyOutcome::Planned(plan) = outcome else {
        return outcome;
    };
    match execute(&plan) {
        Ok(HostApplyExecution::Replied(reply)) => outcome_from_reply(reply),
        Ok(HostApplyExecution::Declined) => HostApplyOutcome::delegate(
            "the native profile apply declined before any setter",
        ),
        Err(error) => execution_failed(format!(
            "profile apply failed and may have changed the GPU: {error}"
        )),
    }
}

/// Map one decoded `apply-settings` envelope into the shared outcome
/// vocabulary. Only an explicit `result.ok: true` is `Applied`.
fn outcome_from_reply(reply: Value) -> HostApplyOutcome {
    let Some(result) = reply.get("result").filter(|result| result.is_object()).cloned() else {
        return execution_failed(
            "the native profile apply reply omitted its per-control result",
        );
    };
    let state = reply.get("state").cloned().unwrap_or(Value::Null);
    if result.get("ok").and_then(Value::as_bool) == Some(true) {
        return HostApplyOutcome::Applied { result, state };
    }
    let per_control = result
        .get("perControl")
        .filter(|per_control| per_control.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    let reason = per_control
        .as_object()
        .and_then(|map| {
            map.values()
                .find_map(|entry| entry.get("message").and_then(Value::as_str))
        })
        .unwrap_or("the GPU driver refused the profile")
        .to_owned();
    HostApplyOutcome::Refused { reason, per_control, kind: HostRefusalKind::Driver }
}

fn execution_failed(reason: impl Into<String>) -> HostApplyOutcome {
    HostApplyOutcome::Refused {
        reason: reason.into(),
        per_control: json!({}),
        kind: HostRefusalKind::ExecutionFailed,
    }
}

fn refused(reason: impl Into<String>, per_control: Value, kind: HostRefusalKind) -> HostApplyOutcome {
    HostApplyOutcome::Refused { reason: reason.into(), per_control, kind }
}

fn row_matches_key(row: &Value, key: &str) -> bool {
    stable_key(row) == key
        || row
            .get("deviceKeys")
            .and_then(Value::as_array)
            .is_some_and(|keys| keys.iter().any(|candidate| candidate.as_str() == Some(key)))
}

fn stable_key(row: &Value) -> String {
    row.get("deviceKey")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| gpu_devices::device_key(row))
}

fn writable_row(row: &Value) -> bool {
    row.get("synthetic").and_then(Value::as_bool) != Some(true)
        && row.get("backendKind").and_then(Value::as_str) != Some("os")
        && row.get("identityAmbiguous").and_then(Value::as_bool) != Some(true)
}

fn physical_target(identity: &ApplyIdentity, row: &Value) -> Value {
    let mut target = json!({
        "deviceKey": identity.device_key,
        "pciVendorId": format!("0x{:08x}", identity.vendor),
        "pciDeviceId": format!("0x{:08x}", identity.device),
        "bdf": {
            "bus": identity.bus,
            "device": identity.slot,
            "function": identity.function,
        },
    });
    if let Some(luid) = row.get("luid").and_then(Value::as_str).filter(|luid| !luid.is_empty()) {
        target["luid"] = json!(luid);
    }
    target
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backend::store_file::SchemaStore;
    use std::{fs, path::PathBuf, sync::Arc};

    struct Temp(PathBuf);
    impl Temp {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("arc-host-apply-test-{:032x}", rand::random::<u128>()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn store(&self) -> ProfileStore {
            ProfileStore::new(Arc::new(SchemaStore::new(self.0.clone()).unwrap()))
        }
    }
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn key(bus: u64) -> String {
        format!("pci:0x00008086:0x0000e20b@{bus}:0.0")
    }

    fn row(bus: u64, id: u64) -> Value {
        json!({
            "id": id,
            "deviceKey": key(bus),
            "pciVendorId": "0x00008086",
            "pciDeviceId": "0x0000e20b",
            "bdf": {"bus": bus, "device": 0, "function": 0},
            "luid": format!("0x0000000{bus}:0x00000002"),
            "integrated": false,
        })
    }

    fn capabilities(overclocking: bool, waiver: bool, learned_temp: Option<f64>) -> Value {
        json!({
            "pciDeviceId": "0x0000e20b",
            "aibVendor": "Intel",
            "overclockingSupported": overclocking,
            "waiverAccepted": waiver,
            "ranges": {
                "powerLimitW": {"units": "W", "min": 60.0, "max": 250.0, "step": 1.0},
                "tempLimitC": {"units": "C", "min": 50.0, "max": 90.0, "step": 1.0},
                "gpuFreqOffsetMhz": {"units": "MHz", "min": -100.0, "max": 100.0, "step": 1.0},
                "gpuVoltOffsetV": {"units": "V", "min": -0.2, "max": 0.0, "step": 0.001},
            },
            "learnedCeilings": learned_temp.map(|value| json!({"tempLimitC": value})),
        })
    }

    fn target() -> HostTarget {
        resolve_host_target(
            &[row(4, 0), row(3, 1)],
            &json!({"deviceKey": key(3)}),
            &json!({"settings": {}}),
            None,
        )
        .unwrap()
    }

    #[test]
    fn profile_resolution_reports_missing_and_malformed_documents() {
        let temp = Temp::new();
        let store = temp.store();
        store
            .save_profile(&json!({"id": "p1", "deviceKey": key(3), "settings": {"powerLimitW": 200}}))
            .unwrap();

        let profile = resolve_profile(&store, "p1").unwrap();
        assert_eq!(profile["settings"]["powerLimitW"], json!(200));

        let missing = resolve_profile(&store, "missing").unwrap_err();
        assert_eq!(missing.reason(), "profile 'missing' not found");
        assert!(matches!(missing, HostApplyFailure::ProfileNotFound { .. }));

        store.save_profile(&json!({"id": "bad", "settings": "nope"})).unwrap();
        let invalid = resolve_profile(&store, "bad").unwrap_err();
        assert!(matches!(invalid, HostApplyFailure::ProfileInvalid { .. }));

        fs::write(temp.0.join("profiles.json"), b"corrupt").unwrap();
        let broken = resolve_profile(&store, "p1").unwrap_err();
        assert!(matches!(broken, HostApplyFailure::ProfileStore { .. }));
    }

    #[test]
    fn host_target_resolution_pins_the_persisted_key_without_ordinal_fallback() {
        let inventory = vec![row(4, 0), row(3, 1)];
        // The profile's per-GPU key wins over the persisted selection.
        let target = resolve_host_target(
            &inventory,
            &json!({"deviceId": 1, "deviceKey": key(3)}),
            &json!({"deviceKey": key(4), "settings": {}}),
            None,
        )
        .unwrap();
        assert_eq!(target.device_id, 0);
        assert_eq!(target.device_key, key(4));
        assert_eq!(target.physical_target["deviceKey"], json!(key(4)));
        assert_eq!(target.physical_target["bdf"], json!({"bus": 4, "device": 0, "function": 0}));
        assert_eq!(target.physical_target["luid"], json!("0x00000004:0x00000002"));

        let stale = resolve_host_target(
            &inventory,
            &json!({"deviceId": 1, "deviceKey": key(7)}),
            &json!({"settings": {}}),
            None,
        )
        .unwrap_err();
        assert_eq!(
            stale.reason(),
            "stale GPU target: the persisted device is no longer enumerated"
        );
        assert!(matches!(stale, HostApplyFailure::DeviceNotEnumerated { .. }));

        let ambiguous = vec![row(3, 0), row(3, 1)];
        assert!(matches!(
            resolve_host_target(&ambiguous, &json!({"deviceKey": key(3)}), &json!({}), None).unwrap_err(),
            HostApplyFailure::DeviceAmbiguous { .. }
        ));

        let mut os = row(3, 0);
        os["synthetic"] = json!(true);
        os["backendKind"] = json!("os");
        assert!(matches!(
            resolve_host_target(&[os], &json!({"deviceKey": key(3)}), &json!({}), None).unwrap_err(),
            HostApplyFailure::DeviceNotWritable { .. }
        ));

        assert!(matches!(
            resolve_host_target(&inventory, &json!({}), &json!({}), None).unwrap_err(),
            HostApplyFailure::NoPersistedDevice
        ));
    }

    #[test]
    fn request_device_key_selects_the_active_profile_gpu_before_the_global_selection() {
        // B1 regression: boot/tray apply one profile per physical GPU and pass
        // the `activeProfileIds` map key when the profile has no own key
        // (apply-on-boot.js:357-364). The global selection points at GPU B, so
        // dropping the middle source applies this profile to the wrong GPU.
        let inventory = vec![row(4, 0), row(3, 1)];
        let app_settings = json!({"deviceKey": key(3)});
        let target = resolve_host_target(
            &inventory,
            &app_settings,
            &json!({"id": "p", "settings": {"powerLimitW": 200}}),
            Some(&key(4)),
        )
        .unwrap();
        assert_eq!(target.device_id, 0, "ordinal comes from the matched row");
        assert_eq!(target.device_key, key(4));
        assert_eq!(target.physical_target["bdf"], json!({"bus": 4, "device": 0, "function": 0}));

        // The profile's own key still outranks the request key.
        let bound = resolve_host_target(
            &inventory,
            &app_settings,
            &json!({"deviceKey": key(3), "settings": {}}),
            Some(&key(4)),
        )
        .unwrap();
        assert_eq!(bound.device_key, key(3));
        assert_eq!(bound.device_id, 1);

        // No request key: the old two-source path is unchanged.
        let legacy = resolve_host_target(
            &inventory,
            &app_settings,
            &json!({"settings": {}}),
            None,
        )
        .unwrap();
        assert_eq!(legacy.device_key, key(3));
        assert_eq!(legacy.device_id, 1);

        // A request key that no row matches is a stale target, never a
        // fallback to the global selection.
        let stale = resolve_host_target(
            &inventory,
            &app_settings,
            &json!({"settings": {}}),
            Some(&key(7)),
        )
        .unwrap_err();
        assert!(matches!(stale, HostApplyFailure::DeviceNotEnumerated { .. }));
    }

    #[test]
    fn an_empty_request_device_key_falls_through_to_the_global_selection() {
        let inventory = vec![row(4, 0), row(3, 1)];
        let app_settings = json!({"deviceKey": key(3)});
        let profile = json!({"settings": {"powerLimitW": 200}});
        let target = resolve_host_target(&inventory, &app_settings, &profile, Some("")).unwrap();
        assert_eq!(target.device_key, key(3));
        assert_eq!(target.device_id, 1);

        // An empty global key is still "no persisted selection".
        assert!(matches!(
            resolve_host_target(&inventory, &json!({"deviceKey": ""}), &profile, Some("")).unwrap_err(),
            HostApplyFailure::NoPersistedDevice
        ));
    }

    #[test]
    fn payload_carries_a_consistent_expected_target_and_the_profile_settings() {
        let settings = json!({"powerLimitW": 200, "gpuFreqOffsetMhz": 50});
        let profile = json!({"id": "p", "deviceKey": key(3), "settings": settings});
        let target = target();
        let app_settings = json!({"waiverAccepted": true});
        let caps = capabilities(true, true, None);
        let outcome = plan_host_profile_apply(
            &profile,
            &target,
            &HostApplyInputs {
                app_settings: &app_settings,
                caps: &caps,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        let HostApplyOutcome::Planned(plan) = outcome else {
            panic!("clean profile must plan a payload: {outcome:?}");
        };
        assert_eq!(plan.routed_settings, settings);
        assert_eq!(plan.refused_per_control, json!({}));

        let args = wire::decode(&plan.payload).unwrap().into_json().unwrap();
        let args = args.as_array().unwrap();
        assert_eq!(args[0], json!(1));
        assert_eq!(args[1], settings, "profile settings are sent verbatim");
        let options = args[2].as_object().unwrap();
        assert_eq!(options["profileApply"], json!(true));
        let expected = &options["expectedTarget"];
        assert_eq!(expected["deviceKey"], json!(key(3)));
        assert_eq!(expected["physicalTarget"]["deviceKey"], expected["deviceKey"]);
        assert_eq!(expected["physicalTarget"]["pciVendorId"], json!("0x00008086"));
        assert_eq!(expected["physicalTarget"]["pciDeviceId"], json!("0x0000e20b"));
        assert_eq!(
            expected["physicalTarget"]["bdf"],
            json!({"bus": 3, "device": 0, "function": 0})
        );
        let identity = identity_from_row(&expected["physicalTarget"]).unwrap();
        assert_eq!(identity.device_key, key(3));
    }

    #[test]
    fn ceiling_and_waiver_gates_refuse_without_a_payload() {
        let profile = json!({"id": "p", "settings": {"powerLimitW": 350}});
        let target = target();
        let caps = capabilities(true, true, None);
        let accepted = json!({"waiverAccepted": true});
        let outcome = plan_host_profile_apply(
            &profile,
            &target,
            &HostApplyInputs {
                app_settings: &accepted,
                caps: &caps,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        let HostApplyOutcome::Refused { reason, per_control, kind } = outcome else {
            panic!("above-ceiling profile must refuse: {outcome:?}");
        };
        assert_eq!(kind, HostRefusalKind::Ceiling);
        assert_eq!(reason, crate::backend::apply_gates::OC_CEILING_REFUSAL_MSG);
        assert_eq!(per_control["powerLimitW"]["ok"], json!(false));
        assert_eq!(kind.flags()["ocModeRefused"], json!(true));

        let not_accepted = json!({});
        let outcome = plan_host_profile_apply(
            &profile,
            &target,
            &HostApplyInputs {
                app_settings: &not_accepted,
                caps: &caps,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        assert!(matches!(
            outcome,
            HostApplyOutcome::Refused { kind: HostRefusalKind::Waiver, ref reason, .. }
                if reason == "Waiver not accepted"
        ));

        let device_not_accepted = capabilities(true, false, None);
        let outcome = plan_host_profile_apply(
            &profile,
            &target,
            &HostApplyInputs {
                app_settings: &accepted,
                caps: &device_not_accepted,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        assert!(matches!(
            outcome,
            HostApplyOutcome::Refused { kind: HostRefusalKind::Waiver, ref reason, .. }
                if reason == "waiver not accepted on the device"
        ));
    }

    #[test]
    fn oc_locked_devices_skip_both_waiver_gates_before_delegating() {
        // An OC-locked device (`overclockingSupported: false`) must not be
        // stopped by either waiver gate: Electron skips both there and lets the
        // driver's per-control `unsupported` answers own the floor.
        let target = target();
        let locked = capabilities(false, false, None);
        let not_accepted = json!({"waiverAccepted": false});

        let above = json!({"id": "p", "settings": {"powerLimitW": 350}});
        let outcome = plan_host_profile_apply(
            &above,
            &target,
            &HostApplyInputs {
                app_settings: &not_accepted,
                caps: &locked,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        let HostApplyOutcome::Refused { kind, .. } = outcome else {
            panic!("OC-locked above-ceiling profile must reach the ceiling gate: {outcome:?}");
        };
        assert_eq!(kind, HostRefusalKind::Ceiling);

        let clean = json!({"id": "p", "settings": {"powerLimitW": 200}});
        let outcome = plan_host_profile_apply(
            &clean,
            &target,
            &HostApplyInputs {
                app_settings: &not_accepted,
                caps: &locked,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        assert!(
            matches!(
                outcome,
                HostApplyOutcome::Delegate { ref reason }
                    if reason.contains("overclocking is not supported")
            ),
            "OC-locked in-limits profile must delegate, not refuse a waiver: {outcome:?}"
        );
    }

    #[test]
    fn refusal_cache_probe_runs_after_the_waiver_and_ceiling_gates() {
        // O1 (deliberate divergence): Electron probes the refusal-cache latch
        // before device/caps/waiver/ceiling (apply-on-boot.js:342-356). Native
        // has no device-independent session probe, so the gate lives in the
        // planner and runs last. Pin the order so a poisoned cache never masks
        // the waiver or ceiling reason by accident.
        let target = target();
        let mut cache = ProfileTempCeilings::default();
        cache.poison_session("cache unavailable");
        let caps = capabilities(true, true, None);
        let calls = std::cell::Cell::new(0u32);

        let not_accepted = json!({});
        let profile = json!({"id": "p", "settings": {"tempLimitC": 100}});
        let outcome = plan_host_profile_apply_with(
            |device_key: &str, settings: &Value, caps: &Value| {
                calls.set(calls.get() + 1);
                Ok(cache.plan_profile_apply(device_key, settings, caps))
            },
            &profile,
            &target,
            &HostApplyInputs {
                app_settings: &not_accepted,
                caps: &caps,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        assert!(
            matches!(
                outcome,
                HostApplyOutcome::Refused { kind: HostRefusalKind::Waiver, ref reason, .. }
                    if reason == "Waiver not accepted"
            ),
            "the waiver gate must run before the refusal-cache probe: {outcome:?}"
        );
        assert_eq!(calls.get(), 0, "the planner must not run before the waiver gate");

        let accepted = json!({"waiverAccepted": true});
        let above = json!({"id": "p", "settings": {"tempLimitC": 100, "powerLimitW": 350}});
        let outcome = plan_host_profile_apply_with(
            |device_key: &str, settings: &Value, caps: &Value| {
                calls.set(calls.get() + 1);
                Ok(cache.plan_profile_apply(device_key, settings, caps))
            },
            &above,
            &target,
            &HostApplyInputs {
                app_settings: &accepted,
                caps: &caps,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        assert!(
            matches!(outcome, HostApplyOutcome::Refused { kind: HostRefusalKind::Ceiling, .. }),
            "the ceiling gate must run before the refusal-cache probe: {outcome:?}"
        );
        assert_eq!(calls.get(), 0, "the planner must not run before the ceiling gate");
    }

    #[test]
    fn capability_and_cache_refusals_come_from_the_shared_planner() {
        let target = target();
        let accepted = json!({"waiverAccepted": true});
        let temp_only = json!({"id": "p", "settings": {"tempLimitC": 100}});
        let learned = capabilities(true, true, Some(90.0));
        let outcome = plan_host_profile_apply(
            &temp_only,
            &target,
            &HostApplyInputs {
                app_settings: &accepted,
                caps: &learned,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        let HostApplyOutcome::Refused { reason, per_control, kind } = outcome else {
            panic!("learned ceiling must refuse a hotter profile: {outcome:?}");
        };
        assert_eq!(kind, HostRefusalKind::CapabilityCeiling);
        assert_eq!(per_control["tempLimitC"]["ok"], json!(false));
        assert_eq!(per_control["tempLimitC"]["capabilityCeiling"], json!(90.0));
        assert!(reason.contains("90"), "{reason}");
        assert_eq!(kind.flags()["capabilityCeilingRefused"], json!(true));

        // A refusal-cache-unavailable session produces the same per-control
        // map a renderer apply gets, because both go through the planner.
        let mut cache = ProfileTempCeilings::default();
        cache.poison_session("cache unavailable");
        let profile = json!({"id": "p", "settings": {"tempLimitC": 100, "powerLimitW": 200}});
        let clean_caps = capabilities(true, true, None);
        let outcome = plan_host_profile_apply_with(
            |device_key, settings, caps| Ok(cache.plan_profile_apply(device_key, settings, caps)),
            &profile,
            &target,
            &HostApplyInputs {
                app_settings: &accepted,
                caps: &clean_caps,
                extended_capable: true,
                sysman_power_limits: false,
            },
        );
        let HostApplyOutcome::Refused { per_control, kind, .. } = outcome else {
            panic!("an unavailable refusal cache must refuse: {outcome:?}");
        };
        assert_eq!(kind, HostRefusalKind::RefusalCacheUnavailable);
        assert_eq!(
            per_control["tempLimitC"]["errorCode"],
            json!("refusal-cache-unavailable")
        );
        assert_eq!(
            per_control["powerLimitW"]["errorCode"],
            json!("refusal-cache-unavailable")
        );
        let renderer = cache.plan_profile_apply(&target.device_key, &profile["settings"], &clean_caps);
        assert_eq!(per_control, renderer.refused_per_control);
        assert_eq!(kind.flags()["temperatureRefusalCacheUnavailable"], json!(true));
    }

    #[test]
    fn mock_and_unelevated_hosts_delegate_without_a_payload() {
        let temp = Temp::new();
        let store = temp.store();
        for (host, expected) in [
            (HostApplyHost::Mock, "mock"),
            (HostApplyHost::Unelevated, "unelevated"),
        ] {
            let request = HostApplyRequest {
                profile_id: "p",
                host,
                device_key: None,
                app_settings: &json!({}),
                inventory: &[],
                caps: None,
                extended_capable: false,
                sysman_power_limits: false,
            };
            let outcome = prepare_host_profile_apply(&store, &request);
            assert!(matches!(
                outcome,
                HostApplyOutcome::Delegate { ref reason } if reason.contains(expected)
            ));
            assert!(outcome.reason().is_some_and(|reason| reason.contains(expected)));
        }
    }

    #[test]
    fn elevated_host_resolves_a_profile_end_to_end() {
        let temp = Temp::new();
        let store = temp.store();
        store
            .save_profile(&json!({"id": "p", "deviceKey": key(3), "settings": {"powerLimitW": 200}}))
            .unwrap();
        let inventory = vec![row(3, 1)];
        let app_settings = json!({"waiverAccepted": true});
        let caps = capabilities(true, true, None);
        let request = HostApplyRequest {
            profile_id: "p",
            host: HostApplyHost::ElevatedNative,
            device_key: None,
            app_settings: &app_settings,
            inventory: &inventory,
            caps: Some(&caps),
            extended_capable: true,
            sysman_power_limits: false,
        };
        let HostApplyOutcome::Planned(plan) = prepare_host_profile_apply(&store, &request) else {
            panic!("elevated host must plan the persisted profile");
        };
        assert_eq!(plan.target.device_id, 1);
        assert_eq!(plan.target.device_key, key(3));
    }

    fn applying_profile() -> Value {
        json!({"id": "p", "deviceKey": key(3), "settings": {"powerLimitW": 200}})
    }

    fn reads<'a>(
        settings: &'a Value,
        caps: &'a Value,
        counters: &'a std::cell::Cell<u32>,
    ) -> (
        Box<dyn Fn() -> Result<Value, String> + 'a>,
        Box<dyn Fn() -> Result<Vec<Value>, String> + 'a>,
        Box<dyn Fn() -> Vec<Value> + 'a>,
        Box<dyn Fn(&HostTarget) -> Option<Value> + 'a>,
    ) {
        // The counter makes "mock/unelevated never read the device" observable.
        let profiles = vec![applying_profile()];
        let inventory = vec![row(3, 1)];
        let read_settings = Box::new(move || {
            counters.set(counters.get() + 1);
            Ok(settings.clone())
        });
        let read_profiles = Box::new(move || Ok(profiles.clone()));
        let read_inventory = Box::new(move || inventory.clone());
        let read_caps = Box::new(move |_target: &HostTarget| Some(caps.clone()));
        (read_settings, read_profiles, read_inventory, read_caps)
    }

    #[test]
    fn a_planned_payload_executes_exactly_once_and_applies_the_reply() {
        let settings = json!({"waiverAccepted": true, "deviceKey": key(3)});
        let caps = capabilities(true, true, None);
        let reads_counter = std::cell::Cell::new(0u32);
        let executions = std::cell::Cell::new(0u32);
        let (read_settings, read_profiles, read_inventory, read_caps) =
            reads(&settings, &caps, &reads_counter);
        let outcome = apply_host_profile(
            HostApplyHost::ElevatedNative,
            "p",
            None,
            &HostApplyReads {
                settings: &*read_settings,
                profiles: &*read_profiles,
                inventory: &*read_inventory,
                caps: &*read_caps,
                capabilities: HostCapabilities { extended: true, sysman_power_limits: false },
            },
            |plan| {
                executions.set(executions.get() + 1);
                // The executed payload is the proven `apply-settings` array.
                let args = wire::decode(&plan.payload).unwrap().into_json().unwrap();
                assert_eq!(args.as_array().unwrap().len(), 3);
                assert_eq!(args[2]["profileApply"], json!(true));
                Ok(HostApplyExecution::Replied(json!({
                    "result": {"ok": true, "perControl": {}},
                    "state": {"powerLimitW": 200},
                })))
            },
        );
        assert_eq!(executions.get(), 1, "one call, one execution");
        assert_eq!(reads_counter.get(), 1);
        let HostApplyOutcome::Applied { result, state } = outcome else {
            panic!("a successful native reply must report Applied: {outcome:?}");
        };
        assert_eq!(result["ok"], json!(true));
        assert_eq!(state["powerLimitW"], json!(200));
    }

    #[test]
    fn planning_is_side_effect_free_and_a_delegate_never_reaches_the_setter() {
        let settings = json!({"waiverAccepted": true, "deviceKey": key(3)});
        let caps = capabilities(true, true, None);
        let reads_counter = std::cell::Cell::new(0u32);
        let executions = std::cell::Cell::new(0u32);
        let (read_settings, read_profiles, read_inventory, read_caps) =
            reads(&settings, &caps, &reads_counter);
        let host_reads = HostApplyReads {
            settings: &*read_settings,
            profiles: &*read_profiles,
            inventory: &*read_inventory,
            caps: &*read_caps,
            capabilities: HostCapabilities { extended: true, sysman_power_limits: false },
        };
        let planned = plan_host_profile(HostApplyHost::ElevatedNative, "p", None, &host_reads);
        assert!(matches!(planned, HostApplyOutcome::Planned(_)), "{planned:?}");
        assert_eq!(executions.get(), 0, "planning must not execute");

        let outcome = execute_host_profile_apply(planned, |_plan| {
            executions.set(executions.get() + 1);
            Ok(HostApplyExecution::Replied(json!({
                "result": {"ok": true, "perControl": {}},
                "state": {"powerLimitW": 200},
            })))
        });
        assert!(matches!(outcome, HostApplyOutcome::Applied { .. }), "{outcome:?}");
        assert_eq!(executions.get(), 1, "one prepared plan, one execution");

        // A profile that cannot be proved produces no plan and reaches no setter.
        let delegated = plan_host_profile(HostApplyHost::ElevatedNative, "missing", None, &host_reads);
        let after = execute_host_profile_apply(delegated, |_plan| {
            executions.set(executions.get() + 1);
            Ok(HostApplyExecution::Replied(json!({"result": {"ok": true}})))
        });
        assert!(matches!(after, HostApplyOutcome::Delegate { .. }), "{after:?}");
        assert_eq!(executions.get(), 1, "a delegate must not run a setter");
    }

    #[test]
    fn driver_refusals_map_to_refused_and_after_setter_errors_fail_closed() {
        let settings = json!({"waiverAccepted": true, "deviceKey": key(3)});
        let caps = capabilities(true, true, None);
        let reads_counter = std::cell::Cell::new(0u32);
        let (read_settings, read_profiles, read_inventory, read_caps) =
            reads(&settings, &caps, &reads_counter);
        let host_reads = HostApplyReads {
            settings: &*read_settings,
            profiles: &*read_profiles,
            inventory: &*read_inventory,
            caps: &*read_caps,
            capabilities: HostCapabilities { extended: true, sysman_power_limits: false },
        };

        // A per-control refusal is never reported as applied.
        let refused = apply_host_profile(
            HostApplyHost::ElevatedNative,
            "p",
            None,
            &host_reads,
            |_| {
                Ok(HostApplyExecution::Replied(json!({
                    "result": {"ok": false, "perControl": {"powerLimitW": {
                        "ok": false, "errorCode": "out-of-range", "message": "above ceiling",
                    }}},
                    "state": {"powerLimitW": 150},
                })))
            },
        );
        let HostApplyOutcome::Refused { ref reason, ref per_control, kind } = refused else {
            panic!("a driver refusal must map to Refused: {refused:?}");
        };
        assert_eq!(kind, HostRefusalKind::Driver);
        assert_eq!(reason, "above ceiling");
        assert_eq!(per_control["powerLimitW"]["ok"], json!(false));

        // An error after a setter may have run fails closed: terminal, and
        // never a fallback signal the caller could re-apply through.
        let failed = apply_host_profile(
            HostApplyHost::ElevatedNative,
            "p",
            None,
            &host_reads,
            |_| Err("setter failed".into()),
        );
        let HostApplyOutcome::Refused { reason, kind, .. } = &failed else {
            panic!("an after-setter error must fail closed: {failed:?}");
        };
        assert_eq!(*kind, HostRefusalKind::ExecutionFailed);
        assert!(reason.contains("setter failed"), "{reason}");
        assert_eq!(kind.flags()["applyFailed"], json!(true));
        assert!(
            !matches!(failed, HostApplyOutcome::Delegate { .. }),
            "an executed apply must never also signal a broker fallback"
        );
        assert!(!matches!(failed, HostApplyOutcome::Applied { .. }));

        // A reply without its per-control result is unverifiable: fail closed.
        let malformed = apply_host_profile(
            HostApplyHost::ElevatedNative,
            "p",
            None,
            &host_reads,
            |_| Ok(HostApplyExecution::Replied(json!({"state": {}}))),
        );
        assert!(matches!(
            malformed,
            HostApplyOutcome::Refused { kind: HostRefusalKind::ExecutionFailed, .. }
        ));
    }

    #[test]
    fn a_native_pre_setter_decline_delegates_without_a_second_execution() {
        let settings = json!({"waiverAccepted": true, "deviceKey": key(3)});
        let caps = capabilities(true, true, None);
        let reads_counter = std::cell::Cell::new(0u32);
        let executions = std::cell::Cell::new(0u32);
        let (read_settings, read_profiles, read_inventory, read_caps) =
            reads(&settings, &caps, &reads_counter);
        let outcome = apply_host_profile(
            HostApplyHost::ElevatedNative,
            "p",
            None,
            &HostApplyReads {
                settings: &*read_settings,
                profiles: &*read_profiles,
                inventory: &*read_inventory,
                caps: &*read_caps,
                capabilities: HostCapabilities { extended: true, sysman_power_limits: false },
            },
            |_| {
                executions.set(executions.get() + 1);
                Ok(HostApplyExecution::Declined)
            },
        );
        assert_eq!(executions.get(), 1, "the decline is one execution, not two");
        assert!(
            matches!(outcome, HostApplyOutcome::Delegate { .. }),
            "a pre-setter decline is the caller's fallback: {outcome:?}"
        );
    }

    #[test]
    fn mock_and_unelevated_hosts_read_nothing_and_never_execute() {
        let settings = json!({"waiverAccepted": true, "deviceKey": key(3)});
        let caps = capabilities(true, true, None);
        for (host, expected) in [
            (HostApplyHost::Mock, "mock"),
            (HostApplyHost::Unelevated, "unelevated"),
        ] {
            let reads_counter = std::cell::Cell::new(0u32);
            let executions = std::cell::Cell::new(0u32);
            let (read_settings, read_profiles, read_inventory, read_caps) =
                reads(&settings, &caps, &reads_counter);
            let outcome = apply_host_profile(
                host,
                "p",
                None,
                &HostApplyReads {
                    settings: &*read_settings,
                    profiles: &*read_profiles,
                    inventory: &*read_inventory,
                    caps: &*read_caps,
                    capabilities: HostCapabilities { extended: true, sysman_power_limits: false },
                },
                |_| {
                    executions.set(executions.get() + 1);
                    Ok(HostApplyExecution::Replied(json!({"result": {"ok": true}})))
                },
            );
            assert_eq!(executions.get(), 0, "{expected}: no execution");
            assert_eq!(reads_counter.get(), 0, "{expected}: no device read");
            assert!(
                matches!(outcome, HostApplyOutcome::Delegate { ref reason } if reason.contains(expected)),
                "{expected}: {outcome:?}"
            );
        }
    }

    #[test]
    fn a_refused_plan_never_reaches_the_executor() {
        let settings = json!({"deviceKey": key(3)}); // no waiver accepted
        let caps = capabilities(true, true, None);
        let reads_counter = std::cell::Cell::new(0u32);
        let executions = std::cell::Cell::new(0u32);
        let (read_settings, read_profiles, read_inventory, read_caps) =
            reads(&settings, &caps, &reads_counter);
        let outcome = apply_host_profile(
            HostApplyHost::ElevatedNative,
            "p",
            None,
            &HostApplyReads {
                settings: &*read_settings,
                profiles: &*read_profiles,
                inventory: &*read_inventory,
                caps: &*read_caps,
                capabilities: HostCapabilities { extended: true, sysman_power_limits: false },
            },
            |_| {
                executions.set(executions.get() + 1);
                Ok(HostApplyExecution::Declined)
            },
        );
        assert_eq!(executions.get(), 0, "a refused plan performs zero executions");
        assert!(matches!(
            outcome,
            HostApplyOutcome::Refused { kind: HostRefusalKind::Waiver, .. }
        ));
        // A delegate handed straight to the executor also performs zero work.
        let executions = std::cell::Cell::new(0u32);
        let outcome = execute_host_profile_apply(
            HostApplyOutcome::delegate("nothing to do"),
            |_| {
                executions.set(executions.get() + 1);
                Ok(HostApplyExecution::Declined)
            },
        );
        assert_eq!(executions.get(), 0, "Delegate performs zero executions");
        assert!(matches!(outcome, HostApplyOutcome::Delegate { .. }));
    }
}
