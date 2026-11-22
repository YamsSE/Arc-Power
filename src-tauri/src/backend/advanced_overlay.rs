//! Native Advanced Overlay ownership.
//!
//! The member is an interactive, always-on-top side panel. This module owns the
//! three renderer/Electron channels (`get-state`, `toggle`, `close`) plus the
//! panel-only `advanced-overlay:settings` push. Windows are injected through
//! `PanelWindows` so channel and lifecycle tests never create a real webview.
//! The native settings store owns the Advanced Overlay values; the settings
//! patch path and the host's hotkey/panel observers apply their changes.
use super::{
    native_store::NativeStore,
    wire::{self, WireValue},
};
use serde_json::{json, Value};
use std::sync::Mutex;

pub const GET_STATE_CHANNEL: &str = "advanced-overlay:get-state";
pub const TOGGLE_CHANNEL: &str = "advanced-overlay:toggle";
pub const CLOSE_CHANNEL: &str = "advanced-overlay:close";
pub const SETTINGS_CHANNEL: &str = "advanced-overlay:settings";

pub const PANEL_WIDTH: f64 = 360.0;
pub const PANEL_HEIGHT: f64 = 616.0;
pub const PANEL_MARGIN: f64 = 8.0;

const THEMES: &[&str] = &["dark", "midnight", "light", "red", "yellow"];
const STATS: &[&str] = &[
    "fps", "fps-avg", "fps-01pct-low", "fps-1pct-low", "fps-99pct", "api",
    "cpu-util", "cpu-clock", "cpu-temp", "cpu-power", "memory-util", "gpu-util",
    "gpu-clock", "gpu-voltage", "gpu-temp", "gpu-power", "gpu-fan",
    "gpu-mem-clock", "gpu-vram", "gpu-vram-temp", "frametime",
];
const DEFAULT_STATS: &[&str] = &[
    "cpu-util", "cpu-temp", "cpu-power", "memory-util", "gpu-util", "gpu-temp",
    "gpu-power", "gpu-vram", "fps", "api", "frametime",
];

pub type LoadSettings = Box<dyn Fn() -> Result<Value, String> + Send + Sync>;
pub type HotkeyRegistered = Box<dyn Fn(&str) -> bool + Send + Sync>;
pub type PrimaryDisplay = Box<dyn Fn() -> DisplayBounds + Send + Sync>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Left,
    Right,
}

impl Position {
    fn from_value(value: Option<&Value>) -> Self {
        if value.and_then(Value::as_str) == Some("left") { Self::Left } else { Self::Right }
    }

    pub fn as_str(self) -> &'static str {
        match self { Self::Left => "left", Self::Right => "right" }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanelGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PanelGeometry {
    #[cfg(test)]
    fn bounds(self) -> PanelBounds {
        PanelBounds { x: self.x, y: self.y, width: self.width, height: self.height }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PanelBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl PanelBounds {
    fn to_json(self) -> Value {
        json!({"x": self.x, "y": self.y, "width": self.width, "height": self.height})
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct PanelSnapshot {
    pub label: String,
    pub visible: bool,
    pub bounds: PanelBounds,
}

/// The injected native-window seam. Production lists and mutates only windows
/// whose role is `advanced-overlay`; tests use an in-memory fake.
pub trait PanelWindows: Send + Sync {
    fn panels(&self) -> Vec<PanelSnapshot>;
    fn create(&self, geometry: &PanelGeometry, theme: &str) -> Result<(), String>;
    fn show(&self);
    fn hide(&self);
    fn destroy(&self);
    fn set_bounds(&self, geometry: &PanelGeometry);
    fn emit_settings(&self, payload: &Value);
}

#[derive(Clone, Debug, PartialEq)]
pub struct PanelSettings {
    pub enabled: bool,
    pub position: Position,
    pub hotkey_letter: String,
    pub theme: String,
    pub stats: Vec<String>,
}

impl Default for PanelSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            position: Position::Right,
            hotkey_letter: "Control+P".into(),
            theme: "dark".into(),
            stats: DEFAULT_STATS.iter().map(|id| (*id).to_owned()).collect(),
        }
    }
}

impl PanelSettings {
    pub fn from_value(raw: &Value) -> Self {
        let stats = match raw.get("overlayStats").and_then(Value::as_array) {
            Some(values) => {
                let mut out: Vec<String> = Vec::new();
                for value in values {
                    let Some(id) = value.as_str() else { continue; };
                    if STATS.contains(&id) && !out.iter().any(|existing| existing == id) {
                        out.push(id.to_owned());
                    }
                }
                out
            }
            None => DEFAULT_STATS.iter().map(|id| (*id).to_owned()).collect(),
        };
        Self {
            enabled: raw.get("advancedOverlayEnabled").and_then(Value::as_bool) == Some(true),
            position: Position::from_value(raw.get("advancedOverlayPosition")),
            hotkey_letter: raw.get("advancedOverlayHotkeyLetter")
                .and_then(Value::as_str)
                .and_then(canonical_accelerator)
                .unwrap_or_else(|| "Control+P".into()),
            theme: raw.get("theme").and_then(Value::as_str)
                .filter(|theme| THEMES.contains(theme)).unwrap_or("dark").to_owned(),
            stats,
        }
    }

    fn payload(&self) -> Value {
        json!({
            "position": self.position.as_str(),
            "enabled": self.enabled,
            "hotkeyLetter": self.hotkey_letter,
            "theme": self.theme,
            "stats": self.stats,
        })
    }
}

pub struct AdvancedOverlayHub {
    load_settings: LoadSettings,
    hotkey_registered: HotkeyRegistered,
    primary_display: PrimaryDisplay,
    windows: Box<dyn PanelWindows>,
    observed: Mutex<PanelSettings>,
    operations: Mutex<()>,
}

impl AdvancedOverlayHub {
    pub fn new(load_settings: LoadSettings, hotkey_registered: HotkeyRegistered,
        primary_display: PrimaryDisplay, windows: Box<dyn PanelWindows>) -> Self {
        let observed = (load_settings)().map(|value| PanelSettings::from_value(&value))
            .unwrap_or_default();
        Self {
            load_settings, hotkey_registered, primary_display, windows,
            observed: Mutex::new(observed), operations: Mutex::new(()),
        }
    }

    fn lock_operations(&self) -> std::sync::MutexGuard<'_, ()> {
        self.operations.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn handles(channel: &str) -> bool {
        matches!(channel, GET_STATE_CHANNEL | TOGGLE_CHANNEL | CLOSE_CHANNEL)
    }

    /// Mock runs leave all three channels to Electron. Normal Tauri runs own
    /// them locally.
    pub fn should_handle(channel: &str, mock_mode: bool) -> bool {
        !mock_mode && Self::handles(channel)
    }

    pub fn handle(&self, channel: &str, args: &Value) -> Option<Result<Value, String>> {
        match channel {
            GET_STATE_CHANNEL => Some(self.get_state(args)),
            TOGGLE_CHANNEL => Some(self.toggle_channel(args)),
            CLOSE_CHANNEL => Some(self.close(args)),
            _ => None,
        }
    }

    fn get_state(&self, args: &Value) -> Result<Value, String> {
        no_payload(GET_STATE_CHANNEL, args)?;
        let state = self.state_value();
        wire::encode_json(&state)
    }

    fn toggle_channel(&self, args: &Value) -> Result<Value, String> {
        no_payload(TOGGLE_CHANNEL, args)?;
        self.toggle()?;
        let state = self.state_value();
        wire::encode_json(&state)
    }

    fn close(&self, args: &Value) -> Result<Value, String> {
        no_payload(CLOSE_CHANNEL, args)?;
        let _operations = self.lock_operations();
        self.windows.hide();
        self.windows.destroy();
        Ok(json!({"t": "undefined"}))
    }

    /// Shortcut entry point: the host shell consumes the registered
    /// `advanced-overlay` action and calls this instead of forwarding it to
    /// Electron.
    pub fn toggle_from_shortcut(&self) -> Result<(), String> {
        self.toggle().map(|_| ())
    }

    fn toggle(&self) -> Result<(), String> {
        let _operations = self.lock_operations();
        let settings = self.read_settings();
        // The persisted master switch has no shortcut writer. While it is OFF
        // the shortcut changes no window and persists nothing.
        if !settings.enabled { return Ok(()); }
        let panels = self.windows.panels();
        if panels.is_empty() {
            let geometry = geometry_for(settings.position, (self.primary_display)());
            self.windows.create(&geometry, &settings.theme)?;
            self.windows.show();
            return Ok(());
        }
        if panels.iter().any(|panel| panel.visible) {
            self.windows.hide();
            // Product mode builds the panel on demand; a session hide also
            // releases its WebView.
            self.windows.destroy();
        } else {
            self.windows.show();
        }
        Ok(())
    }

    fn state_value(&self) -> Value {
        let settings = self.read_settings();
        let panels = self.windows.panels();
        let visible = panels.iter().any(|panel| panel.visible);
        let bounds = panels.iter().find(|panel| panel.visible).or_else(|| panels.first())
            .map(|panel| panel.bounds.to_json()).unwrap_or(Value::Null);
        let hotkey_registered = settings.enabled && settings.hotkey_letter != "None"
            && (self.hotkey_registered)(&settings.hotkey_letter);
        json!({
            "exists": !panels.is_empty(),
            "visible": visible,
            "bounds": bounds,
            "position": settings.position.as_str(),
            "enabled": settings.enabled,
            "hotkeyRegistered": hotkey_registered,
        })
    }

    fn read_settings(&self) -> PanelSettings {
        match (self.load_settings)() {
            Ok(value) => PanelSettings::from_value(&value),
            Err(_) => self.observed.lock().map(|settings| settings.clone()).unwrap_or_default(),
        }
    }

    /// Initial settings push for a panel that just finished loading. There is
    /// no new channel: the panel already listens for this event.
    pub fn publish_settings(&self) {
        let _operations = self.lock_operations();
        let Ok(raw) = (self.load_settings)() else { return; };
        let settings = PanelSettings::from_value(&raw);
        if let Ok(mut observed) = self.observed.lock() { *observed = settings.clone(); }
        if self.windows.panels().is_empty() { return; }
        self.windows.emit_settings(&settings.payload());
        // A panel that loaded after the master was turned off is stale; release
        // it instead of leaving an enabled=false surface visible.
        if !settings.enabled {
            self.windows.hide();
            self.windows.destroy();
        }
    }

    /// Two-second settings-file observer: pushes panel changes and reapplies
    /// geometry. A disabled master also releases the panel.
    pub fn poll(&self) {
        let _operations = self.lock_operations();
        let Ok(raw) = (self.load_settings)() else { return; };
        let settings = PanelSettings::from_value(&raw);
        let changed = {
            let Ok(mut observed) = self.observed.lock() else { return; };
            if *observed == settings { false } else { *observed = settings.clone(); true }
        };
        if !changed || self.windows.panels().is_empty() { return; }
        self.windows.emit_settings(&settings.payload());
        if !settings.enabled {
            self.windows.hide();
            self.windows.destroy();
            return;
        }
        self.windows.set_bounds(&geometry_for(settings.position, (self.primary_display)()));
    }
}

/// Read the normalized native settings document shared by the panel and poll.
pub fn load_settings_snapshot(store: &NativeStore) -> Result<Value, String> {
    let encoded = store.invoke("load-settings", &wire::encode_json(&json!([]))?)?;
    wire::decode(&encoded)?.into_json()
}

/// Anchored edge geometry on the primary display, in DIP.
pub fn geometry_for(position: Position, display: DisplayBounds) -> PanelGeometry {
    let height = PANEL_HEIGHT.min((display.height - PANEL_MARGIN * 2.0).max(0.0));
    let x = match position {
        Position::Left => display.x + PANEL_MARGIN,
        Position::Right => display.x + display.width - PANEL_WIDTH - PANEL_MARGIN,
    };
    PanelGeometry { x, y: display.y + PANEL_MARGIN, width: PANEL_WIDTH, height }
}

/// Convert Tauri's physical monitor rectangle to the DIP rectangle the panel
/// geometry and `get-state` bounds use.
pub fn display_bounds_dip(x: i32, y: i32, width: u32, height: u32, scale_factor: f64) -> DisplayBounds {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 { scale_factor } else { 1.0 };
    DisplayBounds {
        x: f64::from(x) / scale,
        y: f64::from(y) / scale,
        width: f64::from(width) / scale,
        height: f64::from(height) / scale,
    }
}

fn no_payload(channel: &str, args: &Value) -> Result<(), String> {
    let WireValue::Array(items) = wire::decode(args)? else {
        return Err("Expected argument array".into());
    };
    if !items.is_empty() { return Err(format!("{channel} takes no payload")); }
    Ok(())
}

/// Match ipc-core's `validateOverlayHotkeyLetter` canonical form. The panel
/// event carries the accelerator (`Control+P`), while the settings file may
/// still hold the historical single letter (`P`).
fn canonical_accelerator(value: &str) -> Option<String> {
    super::postprocess_sharpening::validate_overlay_hotkey_letter(value).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    };

    #[derive(Default)]
    struct FakeWindowState {
        panels: Mutex<Vec<PanelSnapshot>>,
        creates: Mutex<Vec<(String, PanelGeometry, String)>>,
        bounds: Mutex<Vec<PanelGeometry>>,
        emitted: Mutex<Vec<(String, Value)>>,
        shows: AtomicUsize,
        hides: AtomicUsize,
        destroys: AtomicUsize,
    }

    #[derive(Clone)]
    struct FakeWindows {
        state: Arc<FakeWindowState>,
        next_label: Arc<AtomicUsize>,
    }

    impl FakeWindows {
        fn new(panels: Vec<PanelSnapshot>) -> Self {
            Self {
                state: Arc::new(FakeWindowState { panels: Mutex::new(panels), ..FakeWindowState::default() }),
                next_label: Arc::new(AtomicUsize::new(1_000_000)),
            }
        }
    }

    impl PanelWindows for FakeWindows {
        fn panels(&self) -> Vec<PanelSnapshot> { self.state.panels.lock().unwrap().clone() }

        fn create(&self, geometry: &PanelGeometry, theme: &str) -> Result<(), String> {
            let label = format!("advanced-overlay-{}", self.next_label.fetch_add(1, Ordering::SeqCst));
            self.state.creates.lock().unwrap().push((label.clone(), *geometry, theme.to_owned()));
            self.state.panels.lock().unwrap().push(PanelSnapshot {
                label, visible: false, bounds: geometry.bounds(),
            });
            Ok(())
        }

        fn show(&self) {
            self.state.shows.fetch_add(1, Ordering::SeqCst);
            for panel in self.state.panels.lock().unwrap().iter_mut() { panel.visible = true; }
        }

        fn hide(&self) {
            self.state.hides.fetch_add(1, Ordering::SeqCst);
            for panel in self.state.panels.lock().unwrap().iter_mut() { panel.visible = false; }
        }

        fn destroy(&self) {
            self.state.destroys.fetch_add(1, Ordering::SeqCst);
            self.state.panels.lock().unwrap().clear();
        }

        fn set_bounds(&self, geometry: &PanelGeometry) {
            self.state.bounds.lock().unwrap().push(*geometry);
            for panel in self.state.panels.lock().unwrap().iter_mut() {
                panel.bounds = geometry.bounds();
            }
        }

        fn emit_settings(&self, payload: &Value) {
            let panels = self.state.panels.lock().unwrap().clone();
            let mut emitted = self.state.emitted.lock().unwrap();
            for panel in panels { emitted.push((panel.label, payload.clone())); }
        }
    }

    struct Harness {
        hub: Arc<AdvancedOverlayHub>,
        windows: FakeWindows,
        settings: Arc<Mutex<Value>>,
        hotkey_calls: Arc<Mutex<Vec<String>>>,
        hotkey_registered: Arc<AtomicBool>,
    }

    fn harness(settings: Value, panels: Vec<PanelSnapshot>) -> Harness {
        let settings = Arc::new(Mutex::new(settings));
        let load = settings.clone();
        let loader: LoadSettings = Box::new(move || Ok(load.lock().unwrap().clone()));
        let hotkey_calls = Arc::new(Mutex::new(Vec::new()));
        let calls = hotkey_calls.clone();
        let hotkey_registered = Arc::new(AtomicBool::new(true));
        let registered = hotkey_registered.clone();
        let hotkey: HotkeyRegistered = Box::new(move |accelerator: &str| {
            calls.lock().unwrap().push(accelerator.to_owned());
            registered.load(Ordering::SeqCst)
        });
        let display: PrimaryDisplay = Box::new(|| DisplayBounds { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 });
        let windows = FakeWindows::new(panels);
        Harness {
            hub: Arc::new(AdvancedOverlayHub::new(loader, hotkey, display, Box::new(windows.clone()))),
            windows, settings, hotkey_calls, hotkey_registered,
        }
    }

    fn enabled_settings() -> Value {
        json!({
            "advancedOverlayEnabled": true,
            "advancedOverlayPosition": "left",
            "advancedOverlayHotkeyLetter": "P",
            "theme": "midnight",
            "overlayStats": ["fps", "gpu-temp", "gpu-temp", "bogus", "api"],
        })
    }

    fn args(values: Vec<Value>) -> Value { wire::encode_json(&Value::Array(values)).unwrap() }
    fn decoded(reply: Value) -> Value { wire::decode(&reply).unwrap().into_json().unwrap() }
    fn call(hub: &AdvancedOverlayHub, channel: &str, values: Vec<Value>) -> Result<Value, String> {
        hub.handle(channel, &args(values)).unwrap()
    }

    #[test]
    fn default_state_matches_the_no_panel_shape_and_payloads_are_rejected() {
        let harness = harness(json!({}), Vec::new());
        assert_eq!(decoded(call(&harness.hub, GET_STATE_CHANNEL, Vec::new()).unwrap()), json!({
            "exists": false,
            "visible": false,
            "bounds": null,
            "position": "right",
            "enabled": false,
            "hotkeyRegistered": false,
        }));
        for channel in [GET_STATE_CHANNEL, TOGGLE_CHANNEL, CLOSE_CHANNEL] {
            assert_eq!(call(&harness.hub, channel, vec![json!(1)]).unwrap_err(),
                format!("{channel} takes no payload"));
        }
        assert!(harness.windows.state.creates.lock().unwrap().is_empty());
    }

    #[test]
    fn master_off_toggle_never_touches_windows_or_persists() {
        let harness = harness(json!({"advancedOverlayEnabled": false}), Vec::new());
        let state = decoded(call(&harness.hub, TOGGLE_CHANNEL, Vec::new()).unwrap());
        assert_eq!(state["enabled"], false);
        assert_eq!(state["exists"], false);
        assert_eq!(*harness.settings.lock().unwrap(), json!({"advancedOverlayEnabled": false}));
        assert_eq!(harness.windows.state.shows.load(Ordering::SeqCst), 0);
        assert_eq!(harness.windows.state.hides.load(Ordering::SeqCst), 0);
        assert_eq!(harness.windows.state.destroys.load(Ordering::SeqCst), 0);
        assert!(harness.windows.state.creates.lock().unwrap().is_empty());
    }

    #[test]
    fn enabled_toggle_creates_shows_then_hides_and_recreates_lazily() {
        let harness = harness(enabled_settings(), Vec::new());
        let first = decoded(call(&harness.hub, TOGGLE_CHANNEL, Vec::new()).unwrap());
        assert_eq!(first["exists"], true);
        assert_eq!(first["visible"], true);
        assert_eq!(first["bounds"], json!({"x": 8.0, "y": 8.0, "width": 360.0, "height": 616.0}));
        assert_eq!(first["position"], "left");
        assert_eq!(first["enabled"], true);
        assert_eq!(first["hotkeyRegistered"], true);
        assert_eq!(harness.windows.state.creates.lock().unwrap().as_slice(),
            &[("advanced-overlay-1000000".into(),
                PanelGeometry { x: 8.0, y: 8.0, width: 360.0, height: 616.0 }, "midnight".into())]);

        let second = decoded(call(&harness.hub, TOGGLE_CHANNEL, Vec::new()).unwrap());
        assert_eq!(second["exists"], false);
        assert_eq!(second["visible"], false);
        assert_eq!(second["bounds"], Value::Null);
        assert_eq!(harness.windows.state.hides.load(Ordering::SeqCst), 1);
        assert_eq!(harness.windows.state.destroys.load(Ordering::SeqCst), 1);

        let third = decoded(call(&harness.hub, TOGGLE_CHANNEL, Vec::new()).unwrap());
        assert_eq!(third["exists"], true);
        assert_eq!(third["visible"], true);
        assert_eq!(harness.windows.state.creates.lock().unwrap().len(), 2);
        assert_eq!(*harness.settings.lock().unwrap(), enabled_settings());
    }

    #[test]
    fn hidden_panel_is_shown_without_recreating_it() {
        let harness = harness(enabled_settings(), vec![PanelSnapshot {
            label: "advanced-overlay-1000000".into(),
            visible: false,
            bounds: PanelBounds { x: 8.0, y: 8.0, width: 360.0, height: 616.0 },
        }]);
        let state = decoded(call(&harness.hub, TOGGLE_CHANNEL, Vec::new()).unwrap());
        assert_eq!(state["exists"], true);
        assert_eq!(state["visible"], true);
        assert_eq!(harness.windows.state.shows.load(Ordering::SeqCst), 1);
        assert!(harness.windows.state.creates.lock().unwrap().is_empty());
        assert_eq!(harness.windows.state.hides.load(Ordering::SeqCst), 0);
        assert_eq!(harness.windows.state.destroys.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn close_hides_and_destroys_without_persisting_or_closing_main() {
        let harness = harness(enabled_settings(), Vec::new());
        call(&harness.hub, TOGGLE_CHANNEL, Vec::new()).unwrap();
        let before = harness.settings.lock().unwrap().clone();
        assert_eq!(call(&harness.hub, CLOSE_CHANNEL, Vec::new()).unwrap(), json!({"t": "undefined"}));
        assert_eq!(*harness.settings.lock().unwrap(), before);
        assert_eq!(harness.windows.state.hides.load(Ordering::SeqCst), 1);
        assert_eq!(harness.windows.state.destroys.load(Ordering::SeqCst), 1);
        assert!(harness.windows.state.creates.lock().unwrap()
            .iter().all(|(label, _, _)| label.starts_with("advanced-overlay-")));
        assert_eq!(harness.windows.state.creates.lock().unwrap().len(), 1);
        assert!(harness.windows.panels().is_empty());
    }

    #[test]
    fn settings_event_targets_every_panel_with_the_expected_payload() {
        let harness = harness(enabled_settings(), vec![
            PanelSnapshot { label: "advanced-overlay-1000000".into(), visible: true,
                bounds: PanelBounds { x: 8.0, y: 8.0, width: 360.0, height: 616.0 } },
            PanelSnapshot { label: "advanced-overlay-1000001".into(), visible: false,
                bounds: PanelBounds { x: 8.0, y: 8.0, width: 360.0, height: 616.0 } },
        ]);
        harness.hub.publish_settings();
        let emitted = harness.windows.state.emitted.lock().unwrap().clone();
        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0].0, "advanced-overlay-1000000");
        assert_eq!(emitted[1].0, "advanced-overlay-1000001");
        let expected = json!({
            "position": "left",
            "enabled": true,
            "hotkeyLetter": "Control+P",
            "theme": "midnight",
            "stats": ["fps", "gpu-temp", "api"],
        });
        assert_eq!(emitted[0].1, expected);
        assert_eq!(emitted[1].1, expected);
        assert_eq!(*harness.hotkey_calls.lock().unwrap(), Vec::<String>::new());
    }

    #[test]
    fn panel_load_publish_releases_a_panel_when_the_master_is_off() {
        let harness = harness(json!({"advancedOverlayEnabled": false}), vec![PanelSnapshot {
            label: "advanced-overlay-1000000".into(),
            visible: true,
            bounds: PanelBounds { x: 8.0, y: 8.0, width: 360.0, height: 616.0 },
        }]);
        harness.hub.publish_settings();
        assert_eq!(harness.windows.state.emitted.lock().unwrap().len(), 1);
        assert_eq!(harness.windows.state.hides.load(Ordering::SeqCst), 1);
        assert_eq!(harness.windows.state.destroys.load(Ordering::SeqCst), 1);
        assert!(harness.windows.panels().is_empty());
    }

    #[test]
    fn settings_poll_reapplies_geometry_and_emits_only_on_change() {
        let harness = harness(enabled_settings(), Vec::new());
        call(&harness.hub, TOGGLE_CHANNEL, Vec::new()).unwrap();
        harness.windows.state.emitted.lock().unwrap().clear();
        harness.hub.poll();
        assert!(harness.windows.state.emitted.lock().unwrap().is_empty());
        assert!(harness.windows.state.bounds.lock().unwrap().is_empty());

        *harness.settings.lock().unwrap() = json!({
            "advancedOverlayEnabled": true,
            "advancedOverlayPosition": "right",
            "advancedOverlayHotkeyLetter": "Alt+F9",
            "theme": "light",
            "overlayStats": ["gpu-util"],
        });
        // A renderer state read must not consume the pending change push.
        call(&harness.hub, GET_STATE_CHANNEL, Vec::new()).unwrap();
        harness.hub.poll();
        let emitted = harness.windows.state.emitted.lock().unwrap().clone();
        assert_eq!(emitted.len(), 1);
        assert_eq!(emitted[0].1, json!({
            "position": "right",
            "enabled": true,
            "hotkeyLetter": "Alt+F9",
            "theme": "light",
            "stats": ["gpu-util"],
        }));
        assert_eq!(harness.windows.state.bounds.lock().unwrap().as_slice(),
            &[PanelGeometry { x: 1552.0, y: 8.0, width: 360.0, height: 616.0 }]);
    }

    #[test]
    fn settings_poll_releases_the_panel_when_the_master_turns_off() {
        let harness = harness(enabled_settings(), Vec::new());
        call(&harness.hub, TOGGLE_CHANNEL, Vec::new()).unwrap();
        *harness.settings.lock().unwrap() = json!({"advancedOverlayEnabled": false});
        harness.hub.poll();
        assert_eq!(harness.windows.state.emitted.lock().unwrap().last().unwrap().1["enabled"], false);
        assert_eq!(harness.windows.state.hides.load(Ordering::SeqCst), 1);
        assert_eq!(harness.windows.state.destroys.load(Ordering::SeqCst), 1);
        assert!(harness.windows.panels().is_empty());
    }

    #[test]
    fn hotkey_registration_is_queried_and_never_assumed() {
        let harness = harness(enabled_settings(), Vec::new());
        assert_eq!(decoded(call(&harness.hub, GET_STATE_CHANNEL, Vec::new()).unwrap())["hotkeyRegistered"], true);
        assert_eq!(*harness.hotkey_calls.lock().unwrap(), vec!["Control+P".to_owned()]);
        harness.hotkey_registered.store(false, Ordering::SeqCst);
        assert_eq!(decoded(call(&harness.hub, GET_STATE_CHANNEL, Vec::new()).unwrap())["hotkeyRegistered"], false);

        *harness.settings.lock().unwrap() = json!({
            "advancedOverlayEnabled": true,
            "advancedOverlayHotkeyLetter": "None",
        });
        harness.hotkey_calls.lock().unwrap().clear();
        assert_eq!(decoded(call(&harness.hub, GET_STATE_CHANNEL, Vec::new()).unwrap())["hotkeyRegistered"], false);
        assert!(harness.hotkey_calls.lock().unwrap().is_empty());
    }

    #[test]
    fn geometry_uses_dip_edges_and_clamps_to_the_display_height() {
        let display = display_bounds_dip(0, 0, 1920, 1080, 1.0);
        assert_eq!(display, DisplayBounds { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 });
        assert_eq!(geometry_for(Position::Left, display),
            PanelGeometry { x: 8.0, y: 8.0, width: 360.0, height: 616.0 });
        assert_eq!(geometry_for(Position::Right, display),
            PanelGeometry { x: 1552.0, y: 8.0, width: 360.0, height: 616.0 });
        let clamped = geometry_for(Position::Left, DisplayBounds { x: -1920.0, y: 0.0, width: 1920.0, height: 500.0 });
        assert_eq!(clamped, PanelGeometry { x: -1912.0, y: 8.0, width: 360.0, height: 484.0 });
        let scaled = display_bounds_dip(0, 0, 2880, 1800, 1.5);
        assert_eq!(scaled, DisplayBounds { x: 0.0, y: 0.0, width: 1920.0, height: 1200.0 });
        assert_eq!(geometry_for(Position::Right, scaled).x, 1552.0);
    }

    #[test]
    fn channels_are_native_only_in_normal_tauri_and_hotkey_parser_is_canonical() {
        for channel in [GET_STATE_CHANNEL, TOGGLE_CHANNEL, CLOSE_CHANNEL] {
            assert!(AdvancedOverlayHub::should_handle(channel, false));
            assert!(!AdvancedOverlayHub::should_handle(channel, true));
        }
        assert!(!AdvancedOverlayHub::should_handle("overlay:toggle", false));
        assert_eq!(canonical_accelerator("P").as_deref(), Some("Control+P"));
        assert_eq!(canonical_accelerator("alt+f9").as_deref(), Some("Alt+F9"));
        assert_eq!(canonical_accelerator("Shift+Control+7").as_deref(), Some("Control+Shift+7"));
        assert_eq!(canonical_accelerator("None").as_deref(), Some("None"));
        assert!(canonical_accelerator("Control+Control+P").is_none());
        assert!(canonical_accelerator("P+Q").is_none());
    }
}
