//! Native recording command hub. Owns the Ascent engine, editor jobs, global
//! hotkeys, settings persistence and renderer/Electron status pushes.
use super::{
    native_store::NativeStore,
    recording_contract::{self as contract, RECORDING_EDITOR_VERSION},
    recording_editor::RecordingEditor,
    recording_engine::RecordingEngine,
    recording_hotkeys::{normalize_accelerator, RecordingHotkeys},
    recording_paths::{self as paths, RecordingRandom, SystemWin32Paths},
    recording_screenshot,
    recording_wire, wire::{decode, encode_json, WireValue},
};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex, Weak,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

const HOST_EVENT_STATE: &str = "recording-state";
const HOST_EVENT_ACTION: &str = "recording-action-result";

struct Meta {
    memory_saving: bool,
    hotkeys: Value,
}

pub struct RecordingHub {
    app: AppHandle,
    host_events: mpsc::SyncSender<(String, String, Value)>,
    store: Arc<NativeStore>,
    engine: Arc<RecordingEngine>,
    editor: Arc<RecordingEditor>,
    hotkeys: RecordingHotkeys,
    meta: Arc<Mutex<Meta>>,
    leases: AtomicUsize,
    enabled: bool,
}

impl RecordingHub {
    pub fn new(app: AppHandle, host_events: mpsc::SyncSender<(String, String, Value)>, store: Arc<NativeStore>, enabled: bool) -> Arc<Self> {
        let settings = super::services::recording_settings(&store).unwrap_or_else(|_| contract::normalize_recording_settings(None));
        let meta = Arc::new(Mutex::new(Meta {
            memory_saving: profile_memory_saving(),
            hotkeys: json!({"registered":{},"conflicts":{},"error":null}),
        }));
        let emit_meta = meta.clone();
        let emit_app = app.clone();
        let emit_events = host_events.clone();
        let native_pill_owner = enabled;
        let hub_slot: Arc<Mutex<Option<Weak<RecordingHub>>>> = Arc::new(Mutex::new(None));
        let crash_slot = hub_slot.clone();
        let engine = Arc::new(RecordingEngine::new(Box::new(move |state| {
            emit_state(&emit_meta, &emit_app, &emit_events, native_pill_owner, state);
        }), Box::new(move |settings| {
            let weak = crash_slot.lock().ok().and_then(|slot| slot.clone());
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                if let Some(hub) = weak.and_then(|weak| weak.upgrade()) {
                    let _ = hub.engine.start(&hub.store, &settings, "replay");
                }
            });
        })));
        let (action_sender, action_receiver) = mpsc::channel::<String>();
        let hotkeys = RecordingHotkeys::start(action_sender);
        let editor = Arc::new(RecordingEditor::new(store.clone()));
        let hub = Arc::new(Self {
            app,
            host_events,
            store,
            engine,
            editor,
            hotkeys,
            meta,
            leases: AtomicUsize::new(0),
            enabled,
        });
        if let Ok(mut slot) = hub_slot.lock() { *slot = Some(Arc::downgrade(&hub)); }
        let weak = Arc::downgrade(&hub);
        std::thread::Builder::new().name("arc-recording-actions".into()).spawn(move || {
            while let Ok(action) = action_receiver.recv() {
                let Some(hub) = weak.upgrade() else { break };
                hub.handle_action(&action);
            }
        }).ok();
        let reserved = reserved_accelerators(&hub.store);
        let state = if enabled { hub.hotkeys.reload(&settings, &reserved) }
            else { json!({"registered":{},"conflicts":{},"error":null}) };
        hub.set_hotkey_state(state);
        hub.update_demand();
        if enabled {
            let weak = Arc::downgrade(&hub);
            std::thread::Builder::new().name("arc-recording-startup".into()).spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(4_000));
                let Some(hub) = weak.upgrade() else { return };
                let config = match hub.settings() { Ok(settings) => settings, Err(_) => return };
                let keep_warm = !profile_memory_saving();
                let auto_start = config.get("instantReplayAutoStart").and_then(Value::as_bool) == Some(true);
                if !keep_warm && !auto_start { return; }
                if !keep_warm { hub.update_demand(); }
                let mut probed = false;
                for attempt in 0..3 {
                    match hub.engine.probe(&hub.store) {
                        Ok(_) => { probed = true; break; }
                        Err(error) => eprintln!("[recording] startup probe attempt {}/3 unavailable: {}", attempt + 1, error.message),
                    }
                    std::thread::sleep(std::time::Duration::from_millis(750 * (attempt + 1)));
                }
                if !probed { return; }
                if auto_start {
                    let state = hub.engine.snapshot();
                    if state["activeModes"]["replay"].as_bool() != Some(true) {
                        if let Err(error) = hub.engine.start(&hub.store, &config, "replay") {
                            eprintln!("[recording] Instant Replay auto-start failed: {}", error.message);
                        }
                    }
                }
                // Memory saving may have been enabled while probing. Release
                // an idle child after the probe completes in that case.
                if profile_memory_saving() {
                    hub.update_demand();
                    let _ = hub.engine.shutdown_if_idle(&hub.store, true);
                }
            }).ok();
        }
        hub
    }

    pub fn handles(channel: &str) -> bool {
        matches!(channel,
            "recording-settings-get" | "recording-settings-save" | "recording-runtime-probe" |
            "recording-runtime-acquire" | "recording-runtime-release" | "recording-status" |
            "recording-start" | "recording-stop" | "recording-replay-start" | "recording-auto-start" |
            "recording-clip-save" | "recording-marker-add" | "recording-markers-list" |
            "recording-editor-start" | "recording-editor-audio" | "recording-editor-status" |
            "recording-editor-cancel" | "recording-editor-open" | "recording-editor-share" |
            "recording-editor-copy" | "recording-editor-folder")
    }

    pub fn handle(&self, channel: &str, args: &Value) -> Option<Result<Value, String>> {
        if !Self::handles(channel) { return None; }
        let action_intent = direct_action_intent(channel, args);
        let pre_action_mode = action_intent.as_ref().and_then(|_| {
            self.engine.snapshot().get("mode").and_then(Value::as_str).map(str::to_owned)
        });
        let result = match channel {
            "recording-settings-get" => self.no_payload(args, channel).and_then(|_| self.settings()),
            "recording-settings-save" => self.settings_save(args),
            "recording-runtime-probe" => self.no_payload(args, channel).and_then(|_| self.probe()),
            "recording-runtime-acquire" => self.no_payload(args, channel).and_then(|_| self.acquire()),
            "recording-runtime-release" => self.no_payload(args, channel).and_then(|_| self.release()),
            "recording-status" => self.no_payload(args, channel).and_then(|_| self.status()),
            "recording-start" => self.no_payload(args, channel).and_then(|_| self.start_video()),
            "recording-stop" => self.stop(args),
            "recording-replay-start" => self.no_payload(args, channel).and_then(|_| self.start_replay()),
            "recording-auto-start" => self.no_payload(args, channel).and_then(|_| self.auto_start()),
            "recording-clip-save" => self.clip_save(args),
            "recording-marker-add" => self.marker_add(args),
            "recording-markers-list" => self.markers_list(args),
            "recording-editor-start" => one_arg(args, channel).and_then(|payload| self.editor.start(payload)),
            "recording-editor-audio" => one_string(args, channel).and_then(|source| self.editor.audio(&source)),
            "recording-editor-status" => one_string(args, channel).and_then(|job| self.editor.status(&job)),
            "recording-editor-cancel" => one_string(args, channel).and_then(|job| self.editor.cancel(&job)),
            "recording-editor-open" => one_string(args, channel).and_then(|job| self.editor.open(&job)),
            "recording-editor-share" => one_string(args, channel).and_then(|job| self.editor.share(&job)),
            "recording-editor-copy" => one_string(args, channel).and_then(|job| self.editor.copy(&job)),
            "recording-editor-folder" => one_string(args, channel).and_then(|job| self.editor.folder(&job)),
            _ => return None,
        };
        if let Some((action, requested_mode)) = action_intent {
            // Start/stop success already comes from the recording state
            // transition. Action results carry their failures, plus both
            // outcomes for a clip save (which has no active-mode transition).
            if result.is_err() || action == "saveClip" {
                self.report_direct_action_result(
                    action,
                    requested_mode.as_deref(),
                    pre_action_mode.as_deref(),
                    &result,
                );
            }
        }
        Some(result.and_then(|value| encode_json(&value)))
    }

    fn report_direct_action_result(
        &self,
        action: &str,
        requested_mode: Option<&str>,
        pre_action_mode: Option<&str>,
        result: &Result<Value, String>,
    ) {
        let mut payload = json!({
            "action": action,
            "ok": result.is_ok(),
            "requestedMode": requested_mode,
            "preActionMode": pre_action_mode,
        });
        if let Err(error) = result { payload["error"] = json!(error); }
        let _ = self.host_events.try_send(("main".to_owned(), HOST_EVENT_ACTION.to_owned(), payload));
    }

    pub fn shutdown(&self) {
        let _ = self.engine.shutdown(&self.store);
        self.editor.shutdown();
    }

    /// React to a native `profiles-settings-save` that may have changed
    /// `memorySavingMode`. Reads the authoritative store rather than trusting a
    /// pushed cache, then refreshes the engine demand and the state envelope.
    pub fn on_settings_saved(&self) {
        let memory_saving = profile_memory_saving();
        if let Ok(mut meta) = self.meta.lock() { meta.memory_saving = memory_saving; }
        self.update_demand();
        if memory_saving { let _ = self.engine.shutdown_if_idle(&self.store, true); }
        self.emit_current_state();
    }

    /// Best-effort, read-only state for the native host's pill reconciliation.
    /// A contended engine/meta lock skips this cadence; recording workers never
    /// wait for a UI snapshot and the next tick can retry.
    pub fn try_latest_state(&self) -> Option<Value> {
        let mut state = self.engine.try_snapshot()?;
        let meta = self.meta.try_lock().ok()?;
        state["memorySavingMode"] = json!(meta.memory_saving);
        state["hotkeys"] = meta.hotkeys.clone();
        Some(state)
    }

    fn no_payload(&self, args: &Value, channel: &str) -> Result<(), String> {
        let WireValue::Array(values) = decode(args)? else { return Err("Expected argument array".into()); };
        if !values.is_empty() { return Err(format!("{channel} does not accept a payload")); }
        Ok(())
    }

    fn settings(&self) -> Result<Value, String> { super::services::recording_settings(&self.store) }

    fn status(&self) -> Result<Value, String> {
        let mut state = self.engine.snapshot();
        let meta = self.meta.lock().map_err(|_| "recording meta lock failed")?;
        state["memorySavingMode"] = json!(meta.memory_saving);
        state["hotkeys"] = meta.hotkeys.clone();
        drop(meta);
        self.emit_current_state();
        Ok(state)
    }

    fn probe(&self) -> Result<Value, String> {
        self.engine.probe(&self.store).map_err(|error| error.message)?;
        self.status()
    }

    fn acquire(&self) -> Result<Value, String> {
        self.leases.fetch_add(1, Ordering::SeqCst);
        self.update_demand();
        self.status()
    }

    fn release(&self) -> Result<Value, String> {
        let _ = self.leases.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |leases| {
            Some(leases.saturating_sub(1))
        });
        self.update_demand();
        if self.memory_saving() {
            let _ = self.engine.shutdown_if_idle(&self.store, true);
        }
        self.status()
    }

    fn update_demand(&self) {
        let keep_warm = !profile_memory_saving();
        self.engine.set_demand(self.leases.load(Ordering::SeqCst) + usize::from(keep_warm));
    }

    fn settings_save(&self, args: &Value) -> Result<Value, String> {
        let WireValue::Array(values) = decode(args)? else { return Err("Expected argument array".into()); };
        if values.len() != 1 { return Err("recording-settings-save expects one patch".into()); }
        if !matches!(values[0], WireValue::Object(_)) {
            return Err("recording-settings-save: patch must be an object".into());
        }
        let patch = recording_wire::patch(values[0].clone())?;
        let mut patch = patch;
        validate_patch(&mut patch)?;
        if let Some(location) = patch.get("location").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
            std::fs::create_dir_all(location).map_err(|error| error.to_string())?;
        }
        let settings = self.store_result("recording-save-settings", json!([patch]))?;
        let memory_saving = profile_memory_saving();
        if let Ok(mut meta) = self.meta.lock() { meta.memory_saving = memory_saving; }
        let reserved = reserved_accelerators(&self.store);
        let hotkeys = if self.enabled { self.hotkeys.reload(&settings, &reserved) }
            else { self.meta.lock().map(|meta| meta.hotkeys.clone()).unwrap_or_else(|_| json!({"registered":{},"conflicts":{},"error":null})) };
        self.set_hotkey_state(hotkeys.clone());
        self.update_demand();
        if memory_saving {
            let _ = self.engine.shutdown_if_idle(&self.store, true);
        }
        let _ = self.emit_channel("recording:settings", json!([settings.clone()]));
        self.emit_current_state();
        Ok(json!({"settings":settings,"hotkeys":hotkeys}))
    }

    fn start_video(&self) -> Result<Value, String> {
        let settings = self.settings()?;
        let location = paths::recording_absolute_path(settings.get("location"), "location", &SystemWin32Paths)?;
        std::fs::create_dir_all(&location).map_err(|error| error.to_string())?;
        let output = paths::collision_safe_recording_path(&json!(location), Some(&json!("recording")), None,
            &SystemWin32Paths, &mut SystemRandom, |candidate| Path::new(candidate).exists())?;
        match self.engine.start(&self.store, &merged_output(&settings, &output), "video") {
            Ok(state) => Ok(json!({"state":state,"outputPath":Path::new(&output).file_name().map(|value| value.to_string_lossy()).unwrap_or_default()})),
            Err(error) => {
                let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
                Err(error.message)
            }
        }
    }

    fn start_replay(&self) -> Result<Value, String> {
        let settings = self.settings()?;
        if let Some(location) = settings.get("location").and_then(Value::as_str).filter(|value| !value.trim().is_empty()) {
            std::fs::create_dir_all(location).map_err(|error| error.to_string())?;
        }
        match self.engine.start(&self.store, &settings, "replay") {
            Ok(state) => Ok(json!({"state":state,"outputPath":Value::Null})),
            Err(error) => {
                let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
                Err(error.message)
            }
        }
    }

    fn stop(&self, args: &Value) -> Result<Value, String> {
        let WireValue::Array(values) = decode(args)? else { return Err("Expected argument array".into()); };
        if values.len() > 1 { return Err("recording-stop: mode must be video or replay".into()); }
        let mode = match values.first() {
            None | Some(WireValue::Undefined) | Some(WireValue::Null) => None,
            Some(WireValue::String(value)) if value == "video" || value == "replay" => Some(value.as_str()),
            _ => return Err("recording-stop: mode must be video or replay".into()),
        };
        let state = self.engine.stop(&self.store, mode).map_err(|error| error.message)?;
        if mode == Some("replay") {
            let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
            return Ok(state);
        }
        let completed = self.engine.take_completed("video");
        let Some(completed) = completed else {
            let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
            return Ok(state);
        };
        let settings = self.settings()?;
        let root = match paths::recording_absolute_path(settings.get("location"), "location", &SystemWin32Paths) {
            Ok(root) => root,
            Err(_) => return Ok(state),
        };
        let Some(output) = completed.get("outputPath").and_then(Value::as_str) else { return Ok(state); };
        if Path::new(output).parent().map(|parent| parent.to_string_lossy().eq_ignore_ascii_case(&root)).unwrap_or(false) {
            if let Ok(metadata) = self.persist_clip_metadata(&root, output, &completed) {
                let mut state = state;
                state["completedClip"] = metadata.get("clip").cloned().unwrap_or(Value::Null);
                let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
                return Ok(state);
            }
        }
        let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
        Ok(state)
    }

    fn auto_start(&self) -> Result<Value, String> {
        let settings = self.settings()?;
        let before = self.engine.snapshot();
        if settings.get("instantReplayAutoStart").and_then(Value::as_bool) != Some(true) {
            return Ok(json!({"started":false,"reason":"disabled","state":before}));
        }
        if before["activeModes"]["replay"].as_bool() == Some(true) {
            return Ok(json!({"started":false,"reason":"already-active","state":before}));
        }
        let result = self.engine.start(&self.store, &settings, "replay");
        let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
        match result {
            Ok(state) => Ok(json!({"started":true,"reason":Value::Null,"state":state})),
            Err(error) => Err(error.message),
        }
    }

    fn clip_save(&self, args: &Value) -> Result<Value, String> {
        let payload = one_arg(args, "recording-clip-save")?;
        if !payload.is_object() { return Err("recording-clip-save: payload must be an object".into()); }
        let settings = self.settings()?;
        let location = paths::recording_absolute_path(settings.get("location"), "location", &SystemWin32Paths)?;
        let requested = payload.get("headDurationMs").and_then(Value::as_f64);
        let configured = settings.get("replayLengthSec").and_then(Value::as_f64).unwrap_or(30.0) * 1000.0;
        let duration = requested.filter(|value| value.is_finite() && *value > 0.0)
            .map(|value| value.round().min(3_600_000.0) as i64).unwrap_or(configured.round() as i64);
        std::fs::create_dir_all(&location).map_err(|error| error.to_string())?;
        let output = paths::collision_safe_recording_path(&json!(location), Some(&json!("clip")), None,
            &SystemWin32Paths, &mut SystemRandom, |candidate| Path::new(candidate).exists())?;
        let result = (|| -> Result<Value, String> {
            let response = self.engine.save_replay_clip(&self.store, &output, duration, &location)
                .map_err(|error| error.message)?;
            let response_path = response.get("path").and_then(Value::as_str)
                .filter(|path| Path::new(path).parent().map(|parent| parent.to_string_lossy().eq_ignore_ascii_case(&location)).unwrap_or(false))
                .unwrap_or(&output).to_owned();
            let metadata = self.persist_clip_metadata(&location, &response_path, &response)?;
            Ok(json!({
                "response": response,
                "outputPath": Path::new(&response_path).file_name().map(|value| value.to_string_lossy()).unwrap_or_default(),
                "clip": metadata.get("clip").cloned().unwrap_or(Value::Null),
                "markerMapping": metadata.get("markerMapping").cloned().unwrap_or(Value::Null),
                "instantReplaySave": self.engine.snapshot().get("instantReplaySave").cloned().unwrap_or(Value::Null),
            }))
        })();
        let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
        result
    }

    fn marker_add(&self, args: &Value) -> Result<Value, String> {
        let payload = one_arg(args, "recording-marker-add")?;
        if !payload.is_object() { return Err("recording-marker-add: payload must be an object".into()); }
        let state = self.engine.snapshot();
        let active = state["activeModes"]["replay"].as_bool() == Some(true)
            || state["activeModes"]["video"].as_bool() == Some(true) || state["running"].as_bool() == Some(true);
        if !active { return Err("Start recording or Instant Replay before adding a marker".into()); }
        let session = state.get("sessionId").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty())
            .map(str::to_owned)
            .or_else(|| state.get("startedAt").and_then(Value::as_f64).map(|started| format!("capture:{}", started.round())))
            .ok_or("The active recording session has no stable identity")?;
        let settings = self.settings()?;
        if settings.get("replayMarkersEnabled").and_then(Value::as_bool) == Some(false) {
            return Err("Replay markers are disabled".into());
        }
        let at = payload.get("atMs").and_then(Value::as_f64).filter(|value| value.is_finite())
            .unwrap_or_else(|| {
                let started = state.get("startedAt").and_then(Value::as_f64).unwrap_or(now_ms() as f64);
                (now_ms() as f64 - started).max(0.0)
            });
        self.store_result("recording-add-marker", json!([{
            "sessionId": session,
            "atMs": at.round() as i64,
            "label": payload.get("label").cloned().unwrap_or(Value::Null),
        }]))
    }

    fn markers_list(&self, args: &Value) -> Result<Value, String> {
        let WireValue::Array(values) = decode(args)? else { return Err("Expected argument array".into()); };
        if values.len() > 1 { return Err("recording-markers-list expects one payload".into()); }
        let payload = match values.first() {
            None | Some(WireValue::Undefined) => json!({}),
            Some(value) => value.clone().into_json()?,
        };
        if !payload.is_object() { return Err("recording-markers-list: payload must be an object".into()); }
        self.store_result("recording-list-markers", json!([payload]))
    }

    fn persist_clip_metadata(&self, root: &str, output_path: &str, payload: &Value) -> Result<Value, String> {
        let relative = Path::new(output_path).strip_prefix(root).map_err(|_| "Recording clip escaped its root")?
            .to_string_lossy().into_owned();
        if relative.is_empty() || Path::new(&relative).is_absolute() { return Err("Recording clip path is unsafe".into()); }
        let mut options = json!({
            "relativePath": relative,
            "fileName": Path::new(output_path).file_name().map(|value| value.to_string_lossy()).unwrap_or_default(),
            "editorVersion": RECORDING_EDITOR_VERSION,
        });
        for key in ["apmSamples", "apmAverage", "apmPeak", "apmAvailable"] {
            if let Some(value) = payload.get(key) { options[key] = value.clone(); }
        }
        let clip = self.store_result("recording-record-clip", json!([options]))?;
        let source_session = payload.get("sourceSessionId").or_else(|| payload.get("sessionId")).cloned().unwrap_or(Value::Null);
        let mapping = self.store_result("recording-attach-markers-to-clip", json!([{
            "relativePath": relative,
            "sourceSessionId": source_session,
            "sourceStartMs": payload.get("sourceStartMs").cloned().unwrap_or(Value::Null),
            "sourceEndMs": payload.get("sourceEndMs").cloned().unwrap_or(Value::Null),
        }])).unwrap_or(Value::Null);
        Ok(json!({
            "clip": mapping.get("clip").cloned().filter(|value| !value.is_null()).unwrap_or(clip),
            "markerMapping": mapping.get("markerMapping").cloned().unwrap_or_else(|| json!({"mapped":false,"reason":"marker-store-unavailable"})),
        }))
    }

    fn store_result(&self, method: &str, args: Value) -> Result<Value, String> {
        let encoded = encode_json(&args)?;
        let reply = self.store.invoke(method, &encoded)?;
        let value = decode(&reply)?.into_json()?;
        Ok(value.get("result").cloned().unwrap_or(value))
    }

    fn memory_saving(&self) -> bool {
        self.meta.lock().map(|meta| meta.memory_saving).unwrap_or(false)
    }

    fn set_hotkey_state(&self, state: Value) {
        if let Ok(mut meta) = self.meta.lock() { meta.hotkeys = state; }
    }

    fn emit_current_state(&self) {
        let state = self.engine.snapshot();
        emit_state(&self.meta, &self.app, &self.host_events, self.enabled, state);
    }

    fn emit_channel(&self, channel: &str, args: Value) -> Result<(), String> {
        let encoded = encode_json(&args)?;
        self.app.emit("arc-power:broker-event", json!({"channel":channel,"args":encoded})).map_err(|error| error.to_string())
    }

    fn handle_action(&self, action: &str) {
        if !self.enabled { return; }
        let state_before = self.engine.snapshot();
        let pre_mode = state_before.get("mode").and_then(Value::as_str).map(str::to_owned);
        let mut error: Option<String> = None;
        let mut output_name: Option<String> = None;
        let mut did_stop = false;
        let mut reported_action = action.to_owned();
        match action {
            "toggle" => {
                let video_active = state_before["activeModes"]["video"].as_bool() == Some(true)
                    || (state_before["running"].as_bool() == Some(true) && state_before["mode"].as_str() == Some("video"));
                if video_active {
                    reported_action = "stop".into();
                    if let Err(message) = self.engine.stop(&self.store, Some("video")) { error = Some(message.message); }
                    else { did_stop = true; self.consume_video_completion(); }
                } else {
                    reported_action = "start".into();
                    if let Err(message) = self.start_video() { error = Some(message); }
                }
            }
            "stop" => {
                let mode = if state_before["activeModes"]["video"].as_bool() == Some(true) || state_before["mode"].as_str() == Some("video") {
                    Some("video")
                } else if state_before["activeModes"]["replay"].as_bool() == Some(true) || state_before["mode"].as_str() == Some("replay") {
                    Some("replay")
                } else { None };
                if let Err(message) = self.engine.stop(&self.store, mode) { error = Some(message.message); }
                else {
                    did_stop = state_before["running"].as_bool() == Some(true);
                    if mode == Some("video") { self.consume_video_completion(); }
                }
            }
            "saveClip" => match self.save_clip_action() {
                Ok(name) => output_name = Some(name),
                Err(message) => error = Some(message),
            },
            "marker" => {
                if let Err(message) = self.marker_add(&json!({"t":"array","v":[{"t":"object","v":[]}]})) { error = Some(message); }
            }
            "screenshot" => {
                let result = (|| -> Result<String, String> {
                    let settings = self.settings()?;
                    let location = paths::recording_absolute_path(settings.get("location"), "location", &SystemWin32Paths)?;
                    std::fs::create_dir_all(&location).map_err(|error| error.to_string())?;
                    let output = recording_screenshot::collision_safe_screenshot_path(Path::new(&location), |path| path.exists())?;
                    recording_screenshot::capture_screenshot(&self.store, settings.get("captureTarget"), &output)?;
                    Ok(output.file_name().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default())
                })();
                match result {
                    Ok(name) => output_name = Some(name),
                    Err(message) => error = Some(message),
                }
            }
            _ => return,
        }
        if action == "saveClip" || error.is_some() {
            let _ = self.engine.shutdown_if_idle(&self.store, self.memory_saving());
        }
        let state = self.engine.snapshot();
        let mut result = json!({
            "action": reported_action,
            "ok": error.is_none(),
            "error": error,
            "preActionMode": pre_mode,
            "state": state,
            "instantReplaySave": state.get("instantReplaySave").cloned().unwrap_or(Value::Null),
        });
        if action == "stop" || reported_action == "stop" { result["didStop"] = json!(did_stop); }
        if let Some(name) = output_name { result["outputPath"] = json!(name); }
        let _ = self.emit_channel("recording:action", json!([result.clone()]));
        let _ = self.host_events.try_send(("main".to_owned(), HOST_EVENT_ACTION.to_owned(), result));
    }

    fn save_clip_action(&self) -> Result<String, String> {
        let settings = self.settings()?;
        let location = paths::recording_absolute_path(settings.get("location"), "location", &SystemWin32Paths)?;
        std::fs::create_dir_all(&location).map_err(|error| error.to_string())?;
        let output = paths::collision_safe_recording_path(&json!(location), Some(&json!("clip")), None,
            &SystemWin32Paths, &mut SystemRandom, |candidate| Path::new(candidate).exists())?;
        let duration = (settings.get("replayLengthSec").and_then(Value::as_f64).unwrap_or(30.0) * 1000.0).round() as i64;
        let response = self.engine.save_replay_clip(&self.store, &output, duration, &location).map_err(|error| error.message)?;
        let path = response.get("path").and_then(Value::as_str)
            .filter(|path| Path::new(path).parent().map(|parent| parent.to_string_lossy().eq_ignore_ascii_case(&location)).unwrap_or(false))
            .unwrap_or(&output);
        let _ = self.persist_clip_metadata(&location, path, &response)?;
        Ok(Path::new(path).file_name().map(|value| value.to_string_lossy().into_owned()).unwrap_or_default())
    }

    fn consume_video_completion(&self) {
        let Some(completed) = self.engine.take_completed("video") else { return; };
        let Ok(settings) = self.settings() else { return; };
        let Ok(root) = paths::recording_absolute_path(settings.get("location"), "location", &SystemWin32Paths) else { return; };
        let Some(output) = completed.get("outputPath").and_then(Value::as_str) else { return; };
        if Path::new(output).parent().map(|parent| parent.to_string_lossy().eq_ignore_ascii_case(&root)).unwrap_or(false) {
            let _ = self.persist_clip_metadata(&root, output, &completed);
        }
    }
}

fn validate_patch(patch: &mut Value) -> Result<(), String> {
    const KEYS: &[&str] = &["location","runtimePath","mode","fps","resolution","encoderId","rateControl","bitrateKbps",
        "maxBitrateKbps","rateControlQuality","captureTarget","captureColorMode","showCursor","memorySavingMode",
        "replayLengthSec","instantReplayAutoStart","replayMarkersEnabled","hotkeys","audio"];
    let object = patch.as_object().cloned().ok_or("recording-settings-save: patch must be an object")?;
    for key in object.keys() {
        if !KEYS.contains(&key.as_str()) { return Err(format!("recording-settings-save: unknown field '{key}'")); }
    }
    if let Some(value) = object.get("location") {
        let text = value.as_str().ok_or("location must be a non-empty path")?;
        let path = paths::recording_absolute_path(Some(&json!(text)), "location", &SystemWin32Paths)?;
        patch["location"] = json!(path);
    }
    if let Some(value) = object.get("runtimePath") {
        let text = value.as_str().ok_or("runtimePath must be a non-empty path")?;
        if !text.is_empty() {
            let path = paths::recording_absolute_path(Some(&json!(text)), "runtimePath", &SystemWin32Paths)?;
            patch["runtimePath"] = json!(path);
        }
    }
    if let Some(value) = object.get("mode") {
        if !matches!(value.as_str(), Some("manual" | "clips")) { return Err("recording-settings-save: invalid mode".into()); }
    }
    if let Some(value) = object.get("fps") {
        if !value.as_f64().is_some_and(|value| value.fract() == 0.0 && (1.0..=360.0).contains(&value)) {
            return Err("recording-settings-save: invalid FPS".into());
        }
    }
    if let Some(value) = object.get("resolution") {
        if !matches!(value.as_str(), Some("default" | "480p" | "720p" | "900p" | "1080p" | "1440p" | "4k")) {
            return Err("recording-settings-save: invalid resolution".into());
        }
    }
    if let Some(value) = object.get("encoderId") {
        if value.as_str().is_none_or(|value| value.len() > 128) { return Err("recording-settings-save: invalid encoder id".into()); }
    }
    for key in ["bitrateKbps", "maxBitrateKbps"] {
        if let Some(value) = object.get(key) {
            if !value.as_f64().is_some_and(|value| value.is_finite() && value > 0.0) {
                return Err(format!("recording-settings-save: {key} must be a positive number"));
            }
        }
    }
    if let Some(value) = object.get("rateControl") {
        if !matches!(value.as_str(), Some("CBR" | "VBR" | "CQP" | "ICQ")) { return Err("recording-settings-save: invalid rate control".into()); }
    }
    if let Some(value) = object.get("rateControlQuality") {
        if !value.as_f64().is_some_and(|value| value.fract() == 0.0 && (1.0..=63.0).contains(&value)) {
            return Err("recording-settings-save: quality must be an integer from 1 to 63".into());
        }
    }
    if object.get("rateControl").and_then(Value::as_str) == Some("ICQ")
        && object.get("rateControlQuality").and_then(Value::as_f64).is_some_and(|value| value > 51.0) {
        return Err("recording-settings-save: ICQ quality must be an integer from 1 to 51".into());
    }
    if let Some(value) = object.get("captureColorMode") {
        if !matches!(value.as_str(), Some("auto" | "sdr" | "hdr")) { return Err("recording-settings-save: invalid capture color mode".into()); }
    }
    for key in ["showCursor", "memorySavingMode", "instantReplayAutoStart", "replayMarkersEnabled"] {
        if let Some(value) = object.get(key) {
            if !value.is_boolean() { return Err(format!("recording-settings-save: {key} must be a boolean")); }
        }
    }
    if let Some(target) = object.get("captureTarget") {
        let target = target.as_object().ok_or("recording-settings-save: capture target must be an object")?;
        if let Some(value) = target.get("type") {
            if !matches!(value.as_str(), Some("display" | "window")) { return Err("recording-settings-save: invalid capture target type".into()); }
        }
        if let Some(value) = target.get("displayId") {
            if value.as_str().is_none_or(|value| value.len() > 128) { return Err("recording-settings-save: invalid display id".into()); }
        }
        if let Some(value) = target.get("windowHandle") {
            if !value.as_f64().is_some_and(|value| value.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&value)) {
                return Err("recording-settings-save: invalid window handle".into());
            }
        }
        for (key, maximum) in [("processName", 256), ("executablePath", 4096), ("windowTitle", 512), ("windowClass", 256)] {
            if let Some(value) = target.get(key) {
                if value.as_str().is_none_or(|value| value.len() > maximum) {
                    return Err(format!("recording-settings-save: invalid {key}"));
                }
            }
        }
    }
    if let Some(value) = object.get("hotkeys") {
        if !value.is_object() { return Err("recording-settings-save: hotkeys must be an object".into()); }
    }
    if let Some(audio) = object.get("audio") {
        let audio = audio.as_object().ok_or("recording-settings-save: audio must be an object")?;
        if let Some(value) = audio.get("sourceMode") {
            if !matches!(value.as_str(), Some("system" | "custom")) { return Err("recording-settings-save: invalid audio source mode".into()); }
        }
        if let Some(processes) = audio.get("customProcesses") {
            contract::validate_recording_process_names(processes)?;
        }
        for section in ["microphone", "system"] {
            let Some(value) = audio.get(section) else { continue; };
            let value = value.as_object().ok_or_else(|| format!("recording-settings-save: {section} must be an object"))?;
            for key in ["enabled", "mono"] {
                if let Some(item) = value.get(key) {
                    if !item.is_boolean() { return Err(format!("recording-settings-save: {section}.{key} must be boolean")); }
                }
            }
            if let Some(item) = value.get("deviceId") {
                if item.as_str().is_none_or(|item| item.len() > 512) { return Err(format!("recording-settings-save: {section}.deviceId is invalid")); }
            }
            if let Some(item) = value.get("volume") {
                if !item.as_f64().is_some_and(|item| item.is_finite() && (0.0..=1.0).contains(&item)) {
                    return Err(format!("recording-settings-save: {section}.volume is invalid"));
                }
            }
        }
    }
    Ok(())
}

fn merged_output(settings: &Value, output: &str) -> Value {
    let mut settings = settings.clone();
    settings["outputPath"] = json!(output);
    settings
}

fn recording_state_label_allowed(label: &str, native_pill_owner: bool) -> bool {
    let is_pill = label.strip_prefix("recording-status-pill-").is_some_and(|id| {
        !id.is_empty() && !id.starts_with('0') && id.bytes().all(|byte| byte.is_ascii_digit())
            && id.parse::<u64>().is_ok_and(|id| id >= 1_000_000)
    });
    !(native_pill_owner && is_pill)
}

fn emit_state(meta: &Arc<Mutex<Meta>>, app: &AppHandle, host_events: &mpsc::SyncSender<(String, String, Value)>,
    native_pill_owner: bool, mut state: Value) {
    let (memory_saving, hotkeys) = meta.lock().map(|meta| (meta.memory_saving, meta.hotkeys.clone()))
        .unwrap_or((false, json!({"registered":{},"conflicts":{},"error":null})));
    state["memorySavingMode"] = json!(memory_saving);
    state["hotkeys"] = hotkeys;
    if let Ok(args) = encode_json(&json!([state.clone()])) {
        let event = json!({"channel":"recording:state","args":args});
        if native_pill_owner {
            for (label, _) in app.webview_windows() {
                if recording_state_label_allowed(&label, true) {
                    let _ = app.emit_to(label.as_str(), "arc-power:broker-event", event.clone());
                }
            }
        } else {
            let _ = app.emit("arc-power:broker-event", event);
        }
    }
    let _ = host_events.try_send(("main".to_owned(), HOST_EVENT_STATE.to_owned(), state));
}

fn direct_action_intent(channel: &str, args: &Value) -> Option<(&'static str, Option<String>)> {
    match channel {
        "recording-start" => Some(("start", Some("video".into()))),
        "recording-replay-start" | "recording-auto-start" => Some(("start", Some("replay".into()))),
        "recording-stop" => {
            let requested_mode = match decode(args).ok() {
                Some(WireValue::Array(values)) => values.into_iter().next().and_then(|value| match value {
                    WireValue::String(mode) if mode == "video" || mode == "replay" => Some(mode),
                    _ => None,
                }),
                _ => None,
            };
            Some(("stop", requested_mode))
        }
        "recording-clip-save" => Some(("saveClip", Some("replay".into()))),
        _ => None,
    }
}

fn one_arg(args: &Value, channel: &str) -> Result<Value, String> {
    let WireValue::Array(values) = decode(args)? else { return Err("Expected argument array".into()); };
    if values.len() != 1 { return Err(format!("{channel} expects one argument")); }
    values[0].clone().into_json().map_err(|_| format!("{channel}: invalid argument"))
}

fn one_string(args: &Value, channel: &str) -> Result<String, String> {
    let WireValue::Array(values) = decode(args)? else { return Err("Expected argument array".into()); };
    if values.len() != 1 { return Err(format!("{channel} expects one argument")); }
    let WireValue::String(value) = &values[0] else { return Err(format!("{channel}: expected a string")); };
    Ok(value.clone())
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as i64).unwrap_or(0)
}

struct SystemRandom;
impl RecordingRandom for SystemRandom {
    fn next_sample(&mut self) -> Option<Value> { Some(json!(rand::random::<f64>())) }
    fn fallback_sample(&mut self) -> f64 { rand::random::<f64>() }
}

fn reserved_accelerators(store: &NativeStore) -> Vec<String> {
    let settings = profile_settings();
    let mut reserved = Vec::new();
    let overlay = settings.get("overlayHotkeyLetter").and_then(Value::as_str).unwrap_or("O");
    if let Some(value) = normalize_accelerator(&if overlay.len() == 1 { format!("Control+{overlay}") } else { overlay.to_owned() }) {
        reserved.push(value);
    }
    if settings.get("advancedOverlayEnabled").and_then(Value::as_bool) == Some(true) {
        let letter = settings.get("advancedOverlayHotkeyLetter").and_then(Value::as_str).unwrap_or("P");
        if let Some(value) = normalize_accelerator(&if letter.len() == 1 { format!("Control+{letter}") } else { letter.to_owned() }) {
            reserved.push(value);
        }
    }
    if let Some(value) = normalize_accelerator(settings.get("postprocessScaleHotkey").and_then(Value::as_str).unwrap_or("Alt+F10")) {
        reserved.push(value);
    }
    let _ = store;
    reserved
}

fn profile_settings() -> Value {
    let root = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("ArcPower");
    std::fs::read_to_string(root.join("settings.json")).ok()
        .and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_else(|| json!({}))
}

fn profile_memory_saving() -> bool {
    profile_settings().get("memorySavingMode").and_then(Value::as_bool) == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_merge_keeps_the_selected_folder_settings() {
        let settings = json!({"location":"C:\\Videos","fps":60});
        let merged = merged_output(&settings, "C:\\Videos\\Arc Recording 123.mp4");
        assert_eq!(merged["fps"], 60);
        assert_eq!(merged["outputPath"], "C:\\Videos\\Arc Recording 123.mp4");
    }

    #[test]
    fn patch_validation_rejects_unknown_fields_and_relative_locations() {
        assert!(validate_patch(&mut json!({"unknown":true})).is_err());
        assert!(validate_patch(&mut json!({"location":"relative"})).is_err());
        assert!(validate_patch(&mut json!({"fps":0})).is_err());
        assert!(validate_patch(&mut json!({"audio":{"microphone":{"volume":2}}})).is_err());
        let mut valid = json!({"location":"C:\\Videos\\Arc Power","fps":60,"audio":{"microphone":{"enabled":true,"volume":0.5}}});
        assert!(validate_patch(&mut valid).is_ok());
        assert_eq!(valid["location"], "C:\\Videos\\Arc Power");
    }

    #[test]
    fn native_recording_state_broadcast_skips_only_native_pill_role() {
        assert!(!recording_state_label_allowed("recording-status-pill-1000000", true));
        assert!(recording_state_label_allowed("recording-status-pill-1000000", false));
        assert!(recording_state_label_allowed("main", true));
        assert!(recording_state_label_allowed("advanced-overlay-1000000", true));
        assert!(recording_state_label_allowed("recording-status-pill-invalid", true));
    }
}
