//! Native lifecycle for the small recording/replay status WebView.
//!
//! The settings writer remains in the compatibility broker. This module owns
//! the normal Tauri window and receives the persisted preference plus the
//! native recording engine's state stream.

use serde_json::Value;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    mpsc, Arc, Condvar, Mutex,
};
use std::{thread, time::{Duration, Instant}};
use std::thread::JoinHandle;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

const ROLE: &str = "recording-status-pill";
const WIDTH: f64 = 48.0;
const HEIGHT: f64 = 30.0;
const MARGIN: f64 = 12.0;
const TOPMOST_REASSERT: Duration = Duration::from_secs(3);
const CREATE_RETRY_DELAY: Duration = Duration::from_secs(2);
const SHOW_RETRY_DELAY: Duration = Duration::from_secs(2);
const WORKER_CADENCE: Duration = Duration::from_millis(250);
const WORKER_START_TIMEOUT: Duration = Duration::from_secs(5);
const WORKER_SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
static NEXT_LABEL: AtomicU64 = AtomicU64::new(1_000_000);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PillBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

pub fn bounds_for_display(display: DisplayBounds) -> PillBounds {
    PillBounds {
        x: display.x + display.width - WIDTH - MARGIN,
        y: display.y + MARGIN,
        width: WIDTH,
        height: HEIGHT,
    }
}

pub fn capture_active(state: &Value) -> bool {
    if !state.is_object() { return false; }
    let modes = &state["activeModes"];
    let starting = &state["startingModes"];
    if modes.is_object() {
        return modes["video"] == true || modes["replay"] == true
            || starting.is_object() && (starting["video"] == true || starting["replay"] == true)
            || state["running"] == true && matches!(state["mode"].as_str(), Some("video" | "replay"));
    }
    if starting.is_object() && (starting["video"] == true || starting["replay"] == true) { return true; }
    state["running"] == true && matches!(state["mode"].as_str(), Some("video" | "replay"))
}

#[derive(Clone, Debug, PartialEq)]
enum Effect {
    Create(PillBounds),
    Destroy,
    SetBounds(PillBounds),
    EmitState(Value),
    Show,
}

#[derive(Default)]
struct Lifecycle {
    enabled: bool,
    state: Value,
    exists: bool,
    ready: bool,
    visible: bool,
    bounds: Option<PillBounds>,
}

impl Lifecycle {
    fn set_enabled(&mut self, enabled: bool, bounds: PillBounds) -> Vec<Effect> {
        self.enabled = enabled;
        self.reconcile(bounds, false)
    }

    fn set_state(&mut self, state: Value, bounds: PillBounds) -> Vec<Effect> {
        let changed = self.state != state;
        self.state = state;
        self.reconcile(bounds, changed)
    }

    fn retry(&mut self, bounds: PillBounds) -> Vec<Effect> {
        self.reconcile(bounds, false)
    }

    fn ready(&mut self, bounds: PillBounds) -> Vec<Effect> {
        if !self.wants_window() || !self.exists || self.ready { return Vec::new(); }
        let mut effects = self.update_bounds(bounds);
        self.ready = true;
        effects.push(Effect::EmitState(self.state.clone()));
        if !self.visible {
            self.visible = true;
            effects.push(Effect::Show);
        }
        effects
    }

    fn reconcile(&mut self, bounds: PillBounds, state_changed: bool) -> Vec<Effect> {
        if !self.wants_window() {
            if !self.exists { return Vec::new(); }
            self.exists = false;
            self.ready = false;
            self.visible = false;
            self.bounds = None;
            return vec![Effect::Destroy];
        }
        if !self.exists {
            self.exists = true;
            self.ready = false;
            self.visible = false;
            self.bounds = Some(bounds);
            return vec![Effect::Create(bounds)];
        }
        let mut effects = self.update_bounds(bounds);
        if self.ready {
            if state_changed { effects.push(Effect::EmitState(self.state.clone())); }
            if !self.visible {
                self.visible = true;
                effects.push(Effect::Show);
            }
        }
        effects
    }

    fn update_bounds(&mut self, bounds: PillBounds) -> Vec<Effect> {
        if self.bounds == Some(bounds) { return Vec::new(); }
        self.bounds = Some(bounds);
        if self.exists { vec![Effect::SetBounds(bounds)] } else { Vec::new() }
    }

    fn window_destroyed(&mut self) {
        self.exists = false;
        self.ready = false;
        self.visible = false;
        self.bounds = None;
    }

    fn creation_failed(&mut self) { self.window_destroyed(); }

    fn wants_window(&self) -> bool { self.enabled && capture_active(&self.state) }
}

fn can_attempt_create(retry_after: Option<Instant>, now: Instant, immediate_retry: bool) -> bool {
    immediate_retry || retry_after.is_none_or(|retry| now >= retry)
}

fn should_retry_show(wants_window: bool, ready: bool, visible: bool,
    retry_after: Option<Instant>, now: Instant) -> bool {
    wants_window && ready && !visible && retry_after.is_none_or(|retry| now >= retry)
}

fn next_show_retry(success: bool, now: Instant) -> Option<Instant> {
    if success { None } else { Some(now + SHOW_RETRY_DELAY) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowNotice { Ready, Destroyed }

#[derive(Default)]
struct PendingInputs {
    enabled: Option<bool>,
    recording: Option<Value>,
    ready_notice: Option<SequencedNotice>,
    destroyed_notice: Option<SequencedNotice>,
    shutdown: bool,
}

impl PendingInputs {
    fn is_empty(&self) -> bool {
        self.enabled.is_none() && self.recording.is_none() && self.ready_notice.is_none()
            && self.destroyed_notice.is_none() && !self.shutdown
    }

}

struct SequencedNotice {
    sequence: u64,
    target: String,
    notice: WindowNotice,
}

struct MailboxState {
    pending: PendingInputs,
    desired_enabled: bool,
    desired_recording: Option<Value>,
    active_target: Option<String>,
    next_notice_sequence: u64,
    closed: bool,
}

struct PillMailbox {
    state: Mutex<MailboxState>,
    wake: Condvar,
}

struct WorkerThread {
    handle: Option<JoinHandle<()>>,
    done: mpsc::Receiver<()>,
}

impl WorkerThread {
    fn finish(mut self) {
        match self.done.recv_timeout(WORKER_SHUTDOWN_TIMEOUT) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                if let Some(handle) = self.handle.take() { let _ = handle.join(); }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                eprintln!("[recording-pill] worker shutdown is taking too long; detaching until WebView work returns");
                let _ = self.handle.take();
            }
        }
    }
}

impl PillMailbox {
    fn new(enabled: bool) -> Self {
        Self {
            state: Mutex::new(MailboxState {
                pending: PendingInputs::default(),
                desired_enabled: enabled,
                desired_recording: None,
                active_target: None,
                next_notice_sequence: 0,
                closed: false,
            }),
            wake: Condvar::new(),
        }
    }

    fn set_enabled(&self, enabled: bool) {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed || state.desired_enabled == enabled { return; }
        state.desired_enabled = enabled;
        state.pending.enabled = Some(enabled);
        self.wake.notify_one();
    }

    fn set_recording_state(&self, recording: Value) {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed || state.desired_recording.as_ref() == Some(&recording) { return; }
        state.desired_recording = Some(recording.clone());
        state.pending.recording = Some(recording);
        self.wake.notify_one();
    }

    fn window_notice(&self, target: String, notice: WindowNotice) {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed || state.active_target.as_deref() != Some(target.as_str()) { return; }
        state.next_notice_sequence = state.next_notice_sequence.wrapping_add(1);
        let sequenced = SequencedNotice { sequence: state.next_notice_sequence, target, notice };
        match notice {
            WindowNotice::Ready => state.pending.ready_notice = Some(sequenced),
            WindowNotice::Destroyed => state.pending.destroyed_notice = Some(sequenced),
        }
        self.wake.notify_one();
    }

    fn register_target(&self, target: String) {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed { return; }
        state.active_target = Some(target);
        state.pending.ready_notice = None;
        state.pending.destroyed_notice = None;
    }

    fn clear_target(&self, target: &str) {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.active_target.as_deref() != Some(target) { return; }
        state.active_target = None;
        if state.pending.ready_notice.as_ref().is_some_and(|notice| notice.target == target) {
            state.pending.ready_notice = None;
        }
        if state.pending.destroyed_notice.as_ref().is_some_and(|notice| notice.target == target) {
            state.pending.destroyed_notice = None;
        }
    }

    fn shutdown(&self) {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.closed { return; }
        state.closed = true;
        state.pending.shutdown = true;
        self.wake.notify_one();
    }

    fn wait_and_take(&self, timeout: Duration) -> PendingInputs {
        let mut state = self.state.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if state.pending.is_empty() && !state.closed {
            state = self.wake.wait_timeout(state, timeout)
                .unwrap_or_else(std::sync::PoisonError::into_inner).0;
        }
        std::mem::take(&mut state.pending)
    }
}

fn gate_retry_effects(
    lifecycle: &mut Lifecycle,
    effects: Vec<Effect>,
    retry_after: Option<Instant>,
    now: Instant,
    immediate_retry: bool,
) -> Vec<Effect> {
    effects.into_iter().filter_map(|effect| {
        if matches!(&effect, Effect::Create(_))
            && !can_attempt_create(retry_after, now, immediate_retry) {
            lifecycle.creation_failed();
            None
        } else {
            Some(effect)
        }
    }).collect()
}

struct WindowState {
    lifecycle: Lifecycle,
    target: Option<String>,
    window: Option<WebviewWindow>,
    last_topmost: Option<Instant>,
    retry_after: Option<Instant>,
    show_retry_after: Option<Instant>,
}

/// The Tauri host is the sole product owner. Mock Tauri never constructs this
/// service and continues to use Electron's existing compatibility lifecycle.
pub struct RecordingStatusPill {
    mailbox: Arc<PillMailbox>,
    worker: Mutex<Option<WorkerThread>>,
}

impl RecordingStatusPill {
    pub fn new(app: AppHandle, enabled: bool) -> Result<Self, String> {
        let mailbox = Arc::new(PillMailbox::new(enabled));
        let worker_mailbox = mailbox.clone();
        let (started_tx, started_rx) = mpsc::sync_channel(1);
        let (done_tx, done_rx) = mpsc::channel();
        let worker = thread::Builder::new().name("arc-recording-pill".into()).spawn(move || {
            let controller = WindowController::new(app, enabled, worker_mailbox.clone());
            let _ = started_tx.send(());
            loop {
                let input = worker_mailbox.wait_and_take(WORKER_CADENCE);
                if input.shutdown {
                    controller.shutdown();
                    break;
                }
                controller.process(input);
                controller.tick();
            }
            let _ = done_tx.send(());
        }).map_err(|error| format!("Could not start recording pill worker: {error}"))?;
        let worker = WorkerThread { handle: Some(worker), done: done_rx };
        if started_rx.recv_timeout(WORKER_START_TIMEOUT).is_err() {
            mailbox.shutdown();
            worker.finish();
            return Err("Recording pill worker did not become ready".into());
        }
        Ok(Self { mailbox, worker: Mutex::new(Some(worker)) })
    }

    pub fn set_enabled(&self, enabled: bool) { self.mailbox.set_enabled(enabled); }
    pub fn set_recording_state(&self, recording: Value) { self.mailbox.set_recording_state(recording); }
    pub fn renderer_ready(&self, target: &str) { self.mailbox.window_notice(target.to_owned(), WindowNotice::Ready); }
    pub fn window_destroyed(&self, target: &str) { self.mailbox.window_notice(target.to_owned(), WindowNotice::Destroyed); }

    pub fn destroy(&self) {
        self.mailbox.shutdown();
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() { worker.finish(); }
        }
    }
}

impl Drop for RecordingStatusPill {
    fn drop(&mut self) {
        self.mailbox.shutdown();
        let worker = self.worker.get_mut().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        if let Some(worker) = worker { worker.finish(); }
    }
}

struct WindowController {
    app: AppHandle,
    mailbox: Arc<PillMailbox>,
    state: Mutex<WindowState>,
}

impl WindowController {
    fn new(app: AppHandle, enabled: bool, mailbox: Arc<PillMailbox>) -> Self {
        let mut lifecycle = Lifecycle::default();
        lifecycle.enabled = enabled;
        Self {
            app,
            mailbox,
            state: Mutex::new(WindowState { lifecycle, target: None, window: None, last_topmost: None,
                retry_after: None, show_retry_after: None }),
        }
    }

    fn process(&self, input: PendingInputs) {
        let PendingInputs { enabled, recording, ready_notice, destroyed_notice, .. } = input;
        self.update(|state, bounds| apply_desired_inputs(&mut state.lifecycle, bounds, enabled, recording));
        let mut notices = [ready_notice, destroyed_notice].into_iter().flatten().collect::<Vec<_>>();
        notices.sort_by_key(|notice| notice.sequence);
        for notice in notices {
            match notice.notice {
                WindowNotice::Ready => self.renderer_ready(&notice.target),
                WindowNotice::Destroyed => self.window_destroyed(&notice.target),
            }
        }
    }

    fn renderer_ready(&self, target: &str) {
        self.update(|state, bounds| {
            let effects = if state.target.as_deref() == Some(target) { state.lifecycle.ready(bounds) }
            else { Vec::new() };
            (effects, false)
        });
    }

    fn window_destroyed(&self, target: &str) {
        if let Ok(mut state) = self.state.lock() {
            if state.target.as_deref() != Some(target) { return; }
            state.target = None;
            state.window = None;
            state.last_topmost = None;
            state.show_retry_after = None;
            state.retry_after = Some(Instant::now() + CREATE_RETRY_DELAY);
            state.lifecycle.window_destroyed();
        }
        self.mailbox.clear_target(target);
    }

    fn tick(&self) {
        let Ok(mut state) = self.state.lock() else { return; };
        if !self.window_exists(&state) {
            let had_window = state.target.is_some() || state.window.is_some();
            let old_target = state.target.take();
            state.target = None;
            state.window = None;
            state.last_topmost = None;
            state.show_retry_after = None;
            state.lifecycle.window_destroyed();
            if let Some(target) = old_target { self.mailbox.clear_target(&target); }
            if had_window { state.retry_after = Some(Instant::now() + CREATE_RETRY_DELAY); }
            let now = Instant::now();
            if state.lifecycle.wants_window() && state.retry_after.is_none_or(|retry| now >= retry) {
                state.retry_after = None;
                let bounds = bounds_for_display(display_for_anchor(&self.app));
                for effect in state.lifecycle.retry(bounds) { self.apply_effect(&mut state, effect); }
            }
            return;
        }
        let now = Instant::now();
        if !state.lifecycle.wants_window() || !state.lifecycle.ready { return; }
        let visible = state.window.as_ref().is_some_and(|window| window.is_visible().unwrap_or(false));
        if should_retry_show(state.lifecycle.wants_window(), state.lifecycle.ready, visible,
            state.show_retry_after, now) {
            self.show_window(&mut state);
        }
        if !visible {
            return;
        }
        state.show_retry_after = None;
        let Some(window) = state.window.as_ref() else { return; };
        if state.last_topmost.is_some_and(|last| now.duration_since(last) < TOPMOST_REASSERT) { return; }
        if let Err(error) = window.set_always_on_top(true) {
            eprintln!("[recording-pill] could not restore topmost state: {error}");
        }
        state.last_topmost = Some(now);
    }

    fn shutdown(&self) {
        self.update(|state, bounds| {
            let changed = state.lifecycle.enabled;
            (state.lifecycle.set_enabled(false, bounds), changed)
        });
    }

    fn update(&self, transition: impl FnOnce(&mut WindowState, PillBounds) -> (Vec<Effect>, bool)) {
        let Ok(mut state) = self.state.lock() else { return; };
        if !self.window_exists(&state) {
            let had_window = state.target.is_some() || state.window.is_some();
            let old_target = state.target.take();
            state.target = None;
            state.window = None;
            state.last_topmost = None;
            state.show_retry_after = None;
            state.lifecycle.window_destroyed();
            if let Some(target) = old_target { self.mailbox.clear_target(&target); }
            if had_window { state.retry_after = Some(Instant::now() + CREATE_RETRY_DELAY); }
        }
        let bounds = bounds_for_display(display_for_anchor(&self.app));
        let (effects, changed) = transition(&mut state, bounds);
        // Only an actual state/preference change can bypass a prior creation
        // failure cooldown. Repeated unchanged snapshots/settings may carry a
        // Create effect from the pure lifecycle, so gate it and restore the
        // lifecycle's non-existent-window state before retrying next cadence.
        if changed { state.retry_after = None; }
        let now = Instant::now();
        // Read the cooldown before borrowing the lifecycle mutably.
        let retry_after = state.retry_after;
        let effects = gate_retry_effects(&mut state.lifecycle, effects, retry_after, now, changed);
        for effect in effects { self.apply_effect(&mut state, effect); }
    }

    fn window_exists(&self, state: &WindowState) -> bool {
        state.target.as_deref().is_some_and(|target| self.app.get_webview_window(target).is_some())
    }

    fn live_window<'a>(&self, state: &'a WindowState) -> Option<&'a WebviewWindow> {
        if self.window_exists(state) { state.window.as_ref() } else { None }
    }

    fn apply_effect(&self, state: &mut WindowState, effect: Effect) {
        match effect {
            Effect::Create(bounds) => {
                let target = next_target(&self.app);
                self.mailbox.register_target(target.clone());
                match crate::create_auxiliary_window(&self.app, &target, ROLE,
                    bounds.x, bounds.y, bounds.width, bounds.height, None) {
                    Ok(window) => {
                        state.target = Some(target);
                        state.window = Some(window);
                        state.last_topmost = Some(Instant::now());
                        state.show_retry_after = None;
                        state.retry_after = None;
                    }
                    Err(error) => {
                        self.mailbox.clear_target(&target);
                        state.lifecycle.creation_failed();
                        state.retry_after = Some(Instant::now() + CREATE_RETRY_DELAY);
                        eprintln!("[recording-pill] native WebView creation failed: {error}");
                    }
                }
            }
            Effect::Destroy => {
                state.last_topmost = None;
                state.show_retry_after = None;
                state.retry_after = None;
                let target = state.target.take();
                if let Some(target) = target.as_deref() { self.mailbox.clear_target(target); }
                if let Some(window) = state.window.take() {
                    let _ = window.hide();
                    let _ = window.destroy();
                }
            }
            Effect::SetBounds(bounds) => {
                if let Some(window) = self.live_window(state) {
                    if let Err(error) = window.set_position(tauri::LogicalPosition::new(bounds.x, bounds.y)) {
                        eprintln!("[recording-pill] display placement update failed: {error}");
                    }
                    if let Err(error) = window.set_size(tauri::LogicalSize::new(bounds.width, bounds.height)) {
                        eprintln!("[recording-pill] display size update failed: {error}");
                    }
                }
            }
            Effect::EmitState(recording) => {
                let Some(target) = state.target.as_deref() else { return; };
                if !self.window_exists(state) { return; }
                let args = arc_power_tauri::backend::wire::encode_json(&serde_json::json!([recording]))
                    .unwrap_or_else(|_| serde_json::json!({"t":"array","v":[]}));
                let _ = self.app.emit_to(target, "arc-power:broker-event", serde_json::json!({
                    "channel":"recording:state", "args":args,
                }));
            }
            Effect::Show => {
                self.show_window(state);
            }
        }
    }

    fn show_window(&self, state: &mut WindowState) {
        let now = Instant::now();
        let Some(window) = self.live_window(state) else { return; };
        let mut success = true;
        if let Err(error) = crate::show_inactive(window) {
            eprintln!("[recording-pill] non-activating show failed: {error}");
            success = false;
        }
        if let Err(error) = window.set_always_on_top(true) {
            eprintln!("[recording-pill] topmost setup failed: {error}");
            success = false;
        }
        if !window.is_visible().unwrap_or(false) { success = false; }
        state.last_topmost = Some(now);
        state.show_retry_after = next_show_retry(success, now);
    }
}

fn apply_desired_inputs(
    lifecycle: &mut Lifecycle,
    bounds: PillBounds,
    enabled: Option<bool>,
    recording: Option<Value>,
) -> (Vec<Effect>, bool) {
    let mut effects = Vec::new();
    let mut changed = false;
    if let Some(enabled) = enabled {
        changed |= lifecycle.enabled != enabled;
        effects.extend(lifecycle.set_enabled(enabled, bounds));
    }
    if let Some(recording) = recording {
        changed |= lifecycle.state != recording;
        effects.extend(lifecycle.set_state(recording, bounds));
    }
    (effects, changed)
}

fn next_target(app: &AppHandle) -> String {
    loop {
        let generation = NEXT_LABEL.fetch_add(1, Ordering::SeqCst);
        let target = format!("{ROLE}-{generation}");
        if app.get_webview_window(&target).is_none() { return target; }
    }
}

fn display_for_anchor(app: &AppHandle) -> DisplayBounds {
    let anchor = app.get_webview_window("main").and_then(|window| {
        let position = window.outer_position().ok()?;
        let size = window.outer_size().ok()?;
        Some((i64::from(position.x), i64::from(position.y), i64::from(size.width), i64::from(size.height)))
    });
    let monitors = app.available_monitors().unwrap_or_default();
    let selected = anchor.and_then(|anchor| monitors.iter().max_by_key(|monitor| intersection_area(anchor, monitor))
        .filter(|monitor| intersection_area(anchor, monitor) > 0).cloned())
        .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = selected else {
        let fallback = crate::primary_display_bounds(app);
        return DisplayBounds { x: fallback.x, y: fallback.y, width: fallback.width, height: fallback.height };
    };
    let position = monitor.position();
    let size = monitor.size();
    let dip = arc_power_tauri::backend::advanced_overlay::display_bounds_dip(
        position.x, position.y, size.width, size.height, monitor.scale_factor());
    DisplayBounds { x: dip.x, y: dip.y, width: dip.width, height: dip.height }
}

fn intersection_area(anchor: (i64, i64, i64, i64), monitor: &tauri::Monitor) -> u64 {
    let position = monitor.position();
    let size = monitor.size();
    let left = i64::from(position.x);
    let top = i64::from(position.y);
    let right = left.saturating_add(i64::from(size.width));
    let bottom = top.saturating_add(i64::from(size.height));
    let anchor_right = anchor.0.saturating_add(anchor.2);
    let anchor_bottom = anchor.1.saturating_add(anchor.3);
    let width = right.min(anchor_right).saturating_sub(left.max(anchor.0)).max(0) as u64;
    let height = bottom.min(anchor_bottom).saturating_sub(top.max(anchor.1)).max(0) as u64;
    width.saturating_mul(height)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn bounds() -> PillBounds {
        bounds_for_display(DisplayBounds { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 })
    }

    #[test]
    fn activity_includes_starting_modes_and_legacy_running_shape() {
        assert!(capture_active(&json!({"activeModes":{"video":true}})));
        assert!(capture_active(&json!({"activeModes":{"replay":true}})));
        assert!(capture_active(&json!({"activeModes":{},"startingModes":{"video":true}})));
        assert!(capture_active(&json!({"startingModes":{"replay":true}})));
        assert!(capture_active(&json!({"running":true,"mode":"video"})));
        assert!(capture_active(&json!({"running":true,"mode":"replay"})));
        assert!(!capture_active(&json!({"activeModes":{"video":false,"replay":false}})));
        assert!(!capture_active(&json!({"running":true,"mode":"screenshot"})));
        assert!(!capture_active(&Value::Null));
    }

    #[test]
    fn enabled_idle_does_not_build_and_active_state_creates_once() {
        let mut lifecycle = Lifecycle::default();
        assert!(lifecycle.set_enabled(true, bounds()).is_empty());
        assert_eq!(lifecycle.set_state(json!({"activeModes":{"replay":true}}), bounds()),
            vec![Effect::Create(bounds())]);
        assert!(lifecycle.set_state(json!({"activeModes":{"video":true}}), bounds()).is_empty());
    }

    #[test]
    fn readiness_replays_latest_state_then_shows_and_stop_destroys() {
        let mut lifecycle = Lifecycle::default();
        lifecycle.set_enabled(true, bounds());
        lifecycle.set_state(json!({"startingModes":{"replay":true}}), bounds());
        let latest = json!({"activeModes":{"replay":true},"elapsedSeconds":3});
        lifecycle.set_state(latest.clone(), bounds());
        assert_eq!(lifecycle.ready(bounds()), vec![
            Effect::EmitState(latest.clone()),
            Effect::Show,
        ]);
        assert!(lifecycle.set_state(latest, bounds()).is_empty());
        assert_eq!(lifecycle.set_state(json!({"activeModes":{"video":false,"replay":false}}), bounds()),
            vec![Effect::Destroy]);
        assert!(lifecycle.ready(bounds()).is_empty());
    }

    #[test]
    fn display_placement_keeps_primary_margin_and_negative_origin() {
        assert_eq!(bounds(), PillBounds { x: 1860.0, y: 12.0, width: 48.0, height: 30.0 });
        assert_eq!(bounds_for_display(DisplayBounds { x: -1920.0, y: 0.0, width: 1920.0, height: 1080.0 }),
            PillBounds { x: -60.0, y: 12.0, width: 48.0, height: 30.0 });
    }

    #[test]
    fn disabling_or_losing_activity_destroys_renderer() {
        let mut lifecycle = Lifecycle::default();
        lifecycle.set_enabled(true, bounds());
        lifecycle.set_state(json!({"activeModes":{"video":true}}), bounds());
        assert_eq!(lifecycle.set_enabled(false, bounds()), vec![Effect::Destroy]);
        assert_eq!(lifecycle.set_enabled(true, bounds()), vec![Effect::Create(bounds())]);
    }

    #[test]
    fn failed_creation_is_not_reported_as_existing_and_can_retry() {
        let mut lifecycle = Lifecycle::default();
        lifecycle.set_enabled(true, bounds());
        assert_eq!(lifecycle.set_state(json!({"startingModes":{"video":true}}), bounds()),
            vec![Effect::Create(bounds())]);
        lifecycle.creation_failed();
        assert!(!lifecycle.exists);
        assert_eq!(lifecycle.retry(bounds()), vec![Effect::Create(bounds())]);
    }

    #[test]
    fn busy_worker_coalesces_latest_state_and_keeps_current_target_events() {
        // Simulate the worker being inside a slow native create call by not
        // draining this bounded mailbox while host callbacks keep arriving.
        let mailbox = PillMailbox::new(false);
        mailbox.register_target("recording-status-pill-2".into());
        for revision in 0..1000 {
            mailbox.set_recording_state(json!({"revision":revision}));
        }
        mailbox.set_enabled(true);
        mailbox.set_enabled(false);
        mailbox.set_enabled(true);
        mailbox.window_notice("recording-status-pill-1".into(), WindowNotice::Ready);
        mailbox.window_notice("recording-status-pill-2".into(), WindowNotice::Ready);
        mailbox.window_notice("recording-status-pill-1".into(), WindowNotice::Destroyed);
        mailbox.window_notice("recording-status-pill-2".into(), WindowNotice::Destroyed);
        mailbox.window_notice("recording-status-pill-2".into(), WindowNotice::Ready);

        let batch = mailbox.wait_and_take(Duration::ZERO);
        assert_eq!(batch.enabled, Some(true));
        assert_eq!(batch.recording, Some(json!({"revision":999})));
        assert_eq!(batch.ready_notice.as_ref().map(|notice| notice.target.as_str()),
            Some("recording-status-pill-2"));
        assert_eq!(batch.destroyed_notice.as_ref().map(|notice| notice.target.as_str()),
            Some("recording-status-pill-2"));
        assert!(batch.ready_notice.as_ref().unwrap().sequence > batch.destroyed_notice.as_ref().unwrap().sequence);

        // A worker that resumes after the slow call sees subsequent updates in
        // a fresh batch, rather than losing them to a full channel.
        mailbox.set_enabled(false);
        let resumed = mailbox.wait_and_take(Duration::ZERO);
        assert_eq!(resumed.enabled, Some(false));
    }

    #[test]
    fn show_retry_is_bounded_and_retries_when_a_ready_pill_is_hidden() {
        let now = Instant::now();
        assert!(should_retry_show(true, true, false, None, now));
        let retry = next_show_retry(false, now).unwrap();
        assert!(!should_retry_show(true, true, false, Some(retry), now + Duration::from_millis(250)));
        assert!(should_retry_show(true, true, false, Some(retry), retry));
        assert!(!should_retry_show(true, true, true, Some(retry), retry));
        assert!(!should_retry_show(false, true, false, None, now));
        assert_eq!(next_show_retry(true, now), None);
    }

    #[test]
    fn unchanged_updates_obey_creation_cooldown_but_changed_inputs_retry_early() {
        let now = Instant::now();
        let retry_after = Some(now + CREATE_RETRY_DELAY);
        assert!(can_attempt_create(None, now, false));
        assert!(!can_attempt_create(retry_after, now + Duration::from_millis(250), false));
        assert!(can_attempt_create(retry_after, now + Duration::from_millis(250), true));
        assert!(can_attempt_create(retry_after, now + CREATE_RETRY_DELAY, false));

        let mut lifecycle = Lifecycle::default();
        lifecycle.set_enabled(true, bounds());
        let active = json!({"activeModes":{"video":true}});
        assert_eq!(lifecycle.set_state(active.clone(), bounds()), vec![Effect::Create(bounds())]);
        lifecycle.creation_failed();
        let repeated_snapshot = lifecycle.set_state(active.clone(), bounds());
        assert!(gate_retry_effects(&mut lifecycle, repeated_snapshot, retry_after,
            now + Duration::from_millis(250), false).is_empty());
        assert!(!lifecycle.exists);

        let changed_snapshot = lifecycle.set_state(json!({"activeModes":{"replay":true}}), bounds());
        assert_eq!(gate_retry_effects(&mut lifecycle, changed_snapshot, retry_after,
            now + Duration::from_millis(250), true), vec![Effect::Create(bounds())]);
        assert!(lifecycle.exists);
    }
}
