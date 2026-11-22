//! Native startup splash update decision state. The release transport and
//! installer handoff live in `update_hub`; this module owns only the splash
//! gate and its retry/close semantics.

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::Duration;

pub const STARTUP_CHECK_TIMEOUT: Duration = Duration::from_secs(6);

#[derive(Default)]
struct State {
    started: bool,
    startup_settled: bool,
    startup_outcome: Option<Result<Value, String>>,
    result: Option<Value>,
    latest: Value,
    decision: Option<String>,
    update_pending: bool,
    update_in_flight: bool,
    handoff_started: bool,
    fatal_splash_failure: bool,
}

pub struct StartupUpdateCoordinator { state: Mutex<State> }

#[derive(Default)]
pub struct Transition {
    pub status: Option<Value>,
    pub decision: Option<String>,
}

impl StartupUpdateCoordinator {
    pub fn new() -> Self {
        Self { state: Mutex::new(State {
            latest: json!({"state":"checking","message":"Checking for updates..."}),
            ..State::default()
        }) }
    }

    pub fn start(&self) -> Option<Transition> {
        let mut state = self.state.lock().unwrap();
        if state.started { return None; }
        state.started = true;
        let status = json!({"state":"checking","message":"Checking for updates..."});
        state.latest = status.clone();
        Some(Transition { status: Some(status), decision: None })
    }

    pub fn latest(&self) -> Value { self.state.lock().unwrap().latest.clone() }

    /// Return the result that the titlebar may display after the splash gate.
    /// Once startup has begun, a closed splash or a timed-out check must not
    /// let a late network response create a second update prompt.
    pub fn cached_startup_result(&self) -> Option<Result<Value, String>> {
        let state = self.state.lock().unwrap();
        if !state.started { return None; }
        state.startup_outcome.clone().or_else(|| state.decision.is_some()
            .then(|| Ok(json!({"available":false}))))
    }

    fn decide(state: &mut State, action: &str) -> Option<String> {
        if state.decision.is_some() { return None; }
        state.decision = Some(action.to_owned());
        Some(action.to_owned())
    }

    pub fn finish_startup(&self, result: Result<Value, String>) -> Transition {
        let mut state = self.state.lock().unwrap();
        if state.startup_settled || state.fatal_splash_failure || state.decision.is_some() {
            return Transition::default();
        }
        state.startup_settled = true;
        match result {
            Ok(result) if result.get("available").and_then(Value::as_bool) == Some(true)
                && result.get("version").and_then(Value::as_str).is_some() => {
                state.startup_outcome = Some(Ok(result.clone()));
                state.result = Some(result.clone());
                let status = json!({"state":"available","version":result["version"],"percent":0,
                    "message":format!("Update available: v{}", result["version"].as_str().unwrap_or_default())});
                state.latest = status.clone();
                Transition { status: Some(status), decision: None }
            }
            Ok(_) => {
                state.startup_outcome = Some(result.clone());
                let status = json!({"state":"current","percent":100,"message":"Arc Power is up to date",
                    "loadingMessage":"Loading Arc Power..."});
                state.latest = status.clone();
                Transition { status: Some(status), decision: Self::decide(&mut state, "continue") }
            }
            Err(error) => {
                state.startup_outcome = Some(Err(error.clone()));
                let timed_out = error.contains("timed out");
                let message = if timed_out { "Update check timed out — continuing startup" }
                    else { "Update check unavailable — continuing startup" };
                let status = json!({"state":"error","message":message});
                state.latest = status.clone();
                Transition { status: Some(status), decision: Self::decide(&mut state, "continue") }
            }
        }
    }

    pub fn timeout(&self) -> Transition {
        let mut state = self.state.lock().unwrap();
        if state.startup_settled || state.fatal_splash_failure || state.decision.is_some() {
            return Transition::default();
        }
        state.startup_settled = true;
        state.startup_outcome = Some(Err("GitHub update check timed out".into()));
        let status = json!({"state":"error","message":"Update check timed out — continuing startup"});
        state.latest = status.clone();
        Transition { status: Some(status), decision: Self::decide(&mut state, "continue") }
    }

    pub fn choose_skip(&self) -> Result<Transition, String> {
        let mut state = self.state.lock().unwrap();
        if state.latest.get("state").and_then(Value::as_str) != Some("available") {
            return Err("No startup update choice is available".into());
        }
        state.update_pending = false;
        state.update_in_flight = false;
        Ok(Transition { status: None, decision: Self::decide(&mut state, "continue") })
    }

    pub fn begin_update(&self) -> Result<(String, Option<u64>, Transition), String> {
        let mut state = self.state.lock().unwrap();
        if state.fatal_splash_failure {
            return Err("Startup update is no longer available".into());
        }
        if state.update_in_flight { return Err("Startup update is already in progress".into()); }
        let result = state.result.as_ref().ok_or("No startup update is available")?;
        let url = result.get("assetUrl").and_then(Value::as_str).filter(|value| value.starts_with("https://"))
            .ok_or("No startup update is available")?.to_owned();
        let size = result.get("assetSize").and_then(Value::as_u64).filter(|value| *value > 0);
        state.update_pending = true;
        state.update_in_flight = true;
        state.handoff_started = false;
        let status = json!({"state":"downloading","percent":if size.is_some() { json!(0) } else { Value::Null },
            "message":if size.is_some() { "Downloading update... 0%" } else { "Downloading update..." }});
        state.latest = status.clone();
        Ok((url, size, Transition { status: Some(status), decision: None }))
    }

    pub fn download_progress(&self, payload: &Value) -> Transition {
        let mut state = self.state.lock().unwrap();
        if !state.update_pending || state.fatal_splash_failure { return Transition::default(); }
        let percent = payload.get("percent").and_then(Value::as_u64).map(|value| value.min(99));
        let downloaded = payload.get("downloadedBytes").and_then(Value::as_u64).unwrap_or(0);
        let downloaded_mb = downloaded as f64 / (1024.0 * 1024.0);
        let message = percent.map(|value| format!("Downloading update... {value}%"))
            .unwrap_or_else(|| format!("Downloading update... {downloaded_mb:.1} MB"));
        let status = json!({"state":"downloading","percent":percent,"message":message,"downloadedBytes":downloaded});
        let publish = if let Some(previous) = state.latest.get("percent").and_then(Value::as_u64) {
            percent != Some(previous)
        } else {
            downloaded / (10 * 1024 * 1024)
                != state.latest.get("downloadedBytes").and_then(Value::as_u64).unwrap_or(0) / (10 * 1024 * 1024)
        };
        state.latest = status.clone();
        Transition { status: publish.then_some(status), decision: None }
    }

    pub fn start_handoff(&self) -> Transition {
        let mut state = self.state.lock().unwrap();
        if state.fatal_splash_failure || !state.update_pending { return Transition::default(); }
        let status = json!({"state":"restarting","percent":100,"message":"Update downloaded — restarting Arc Power"});
        state.latest = status.clone();
        state.handoff_started = true;
        Transition { status: Some(status), decision: None }
    }

    pub fn installing(&self) -> Transition {
        let mut state = self.state.lock().unwrap();
        if state.fatal_splash_failure || !state.update_pending { return Transition::default(); }
        let status = json!({"state":"restarting","percent":100,"message":"Update downloaded — restarting Arc Power"});
        state.latest = status.clone();
        Transition { status: Some(status), decision: None }
    }

    pub fn may_start_install(&self) -> bool {
        let state = self.state.lock().unwrap();
        state.update_pending && !state.fatal_splash_failure
    }

    pub fn update_failed(&self) -> Transition {
        let mut state = self.state.lock().unwrap();
        state.update_in_flight = false;
        state.handoff_started = false;
        if state.fatal_splash_failure { return Transition::default(); }
        let version = state.result.as_ref().and_then(|result| result.get("version")).cloned();
        let mut status = json!({"state":"available","percent":0,"error":true,
            "message":"Update failed — choose UPDATE NOW to retry or SKIP FOR NOW"});
        if let Some(version) = version { status["version"] = version; }
        state.latest = status.clone();
        Transition { status: Some(status), decision: None }
    }

    pub fn fatal(&self) -> Transition {
        let mut state = self.state.lock().unwrap();
        if state.fatal_splash_failure { return Transition::default(); }
        state.fatal_splash_failure = true;
        if state.startup_outcome.is_none() {
            state.startup_outcome = Some(Err("Startup splash failed".into()));
        }
        let abort = state.update_pending;
        state.update_pending = false;
        state.update_in_flight = false;
        state.handoff_started = false;
        Transition { status: None, decision: Self::decide(&mut state, if abort { "abort" } else { "continue" }) }
    }

    /// Returns true when the splash may close. A pending replacement blocks
    /// close until the user skips, a fatal error aborts, or handoff starts.
    pub fn close(&self) -> (bool, Transition) {
        let mut state = self.state.lock().unwrap();
        if state.update_pending && !state.handoff_started && !state.fatal_splash_failure {
            return (false, Transition::default());
        }
        let decision = if state.update_pending && state.handoff_started {
            None
        } else { Self::decide(&mut state, "continue") };
        (true, Transition { status: None, decision })
    }
}
