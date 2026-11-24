//! Per-overlay monitor selection. RTSS follows the game window; the Arc Power
//! HUD and Advanced Overlay are real windows and can be pinned to a display.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct MonitorSelection {
    #[serde(default)]
    pub hud: Option<String>,
    #[serde(default)]
    pub advanced: Option<String>,
}

fn store_path() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|root| root.join("ArcPower").join("overlay-monitors.json"))
}

pub fn load() -> MonitorSelection {
    let Some(path) = store_path() else { return MonitorSelection::default(); };
    let Ok(text) = std::fs::read_to_string(path) else { return MonitorSelection::default(); };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn save(selection: &MonitorSelection) -> Result<(), String> {
    let path = store_path().ok_or("APPDATA is unavailable")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("Cannot create overlay monitor folder: {error}"))?;
    }
    let text = serde_json::to_string_pretty(selection).map_err(|error| error.to_string())?;
    std::fs::write(path, text + "\n").map_err(|error| format!("Cannot save overlay monitor selection: {error}"))
}

pub fn monitor_rows(app: &tauri::AppHandle) -> Value {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten();
    let rows: Vec<Value> = monitors.iter().enumerate().map(|(index, monitor)| {
        let name = monitor.name().cloned();
        let is_primary = primary.as_ref().is_some_and(|candidate| {
            candidate.name() == monitor.name()
                && candidate.position() == monitor.position()
                && candidate.size() == monitor.size()
        });
        json!({
            "name": name.clone().unwrap_or_else(|| format!("Display {}", index + 1)),
            "label": name.unwrap_or_else(|| format!("Display {}", index + 1)),
            "width": monitor.size().width,
            "height": monitor.size().height,
            "scaleFactor": monitor.scale_factor(),
            "primary": is_primary,
        })
    }).collect();
    Value::Array(rows)
}

pub fn selected_monitor(app: &tauri::AppHandle, name: Option<&str>) -> Option<tauri::Monitor> {
    let name = name?;
    app.available_monitors().ok()?.into_iter().find(|monitor| monitor.name().map(String::as_str) == Some(name))
}

fn bounds_for(monitor: &tauri::Monitor) -> arc_power_tauri::backend::advanced_overlay::DisplayBounds {
    use arc_power_tauri::backend::advanced_overlay::display_bounds_dip;
    let scale = monitor.scale_factor();
    let position = monitor.position();
    let size = monitor.size();
    display_bounds_dip(position.x, position.y, size.width, size.height, scale)
}

pub fn advanced_display_bounds(app: &tauri::AppHandle) -> arc_power_tauri::backend::advanced_overlay::DisplayBounds {
    let selection = load();
    selected_monitor(app, selection.advanced.as_deref())
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|monitor| bounds_for(&monitor))
        .unwrap_or_else(|| arc_power_tauri::backend::advanced_overlay::display_bounds_dip(0, 0, 1920, 1080, 1.0))
}
