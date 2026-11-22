//! Pure window placement/serialization port of src/main/window-state.js.
use super::sidecar_file::{Sidecar, SidecarFile};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

#[derive(Clone, Copy)]
struct Rect { x: f64, y: f64, width: f64, height: f64 }

fn valid_rect(value: &Value) -> Option<Rect> {
    let rect = Rect { x: value.get("x")?.as_f64()?, y: value.get("y")?.as_f64()?,
        width: value.get("width")?.as_f64()?, height: value.get("height")?.as_f64()? };
    (rect.x.is_finite() && rect.y.is_finite() && rect.width.is_finite()
        && rect.height.is_finite() && rect.width > 0.0 && rect.height > 0.0).then_some(rect)
}

fn intersection_area(a: Rect, b: Rect) -> f64 {
    ((a.x+a.width).min(b.x+b.width)-a.x.max(b.x)).max(0.0)
        * ((a.y+a.height).min(b.y+b.height)-a.y.max(b.y)).max(0.0)
}

fn number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value >= i64::MIN as f64 && value < i64::MAX as f64 {
        json!(value as i64)
    } else { json!(value) }
}

fn bounds_value(rect: Rect) -> Value {
    json!({"x":number(rect.x),"y":number(rect.y),"width":number(rect.width),"height":number(rect.height)})
}

pub fn restore_window_state(saved: &Value, displays: &Value, defaults: Option<&Value>) -> Value {
    let version_one = saved.get("version").and_then(Value::as_f64) == Some(1.0);
    let source = if version_one { saved.get("normalBounds").and_then(valid_rect) } else { None }
        .unwrap_or_else(|| Rect {
            x: defaults.and_then(|v|v.get("x")).and_then(Value::as_f64).unwrap_or(0.0),
            y: defaults.and_then(|v|v.get("y")).and_then(Value::as_f64).unwrap_or(0.0),
            width: defaults.and_then(|v|v.get("width")).and_then(Value::as_f64).unwrap_or(1280.0),
            height: defaults.and_then(|v|v.get("height")).and_then(Value::as_f64).unwrap_or(820.0),
        });
    let areas: Vec<Rect> = displays.as_array().into_iter().flatten()
        .filter_map(|d|d.get("workArea").and_then(valid_rect)).collect();
    let mut area = areas.first().copied().unwrap_or(Rect {x:0.0,y:0.0,width:1920.0,height:1080.0});
    for candidate in areas {
        if intersection_area(source,candidate) > intersection_area(source,area) { area = candidate; }
    }
    let width = 980.0_f64.min(area.width).max(source.width.min(area.width));
    let height = 640.0_f64.min(area.height).max(source.height.min(area.height));
    let rect = Rect { width,height,
        x: area.x.max(source.x.min(area.x+area.width-width)),
        y: area.y.max(source.y.min(area.y+area.height-height)) };
    json!({"normalBounds":bounds_value(rect),"maximized":version_one && saved.get("maximized") == Some(&Value::Bool(true))})
}

pub fn serialize_window_state(normal_bounds: &Value, maximized: &Value) -> Value {
    let Some(rect) = valid_rect(normal_bounds) else { return Value::Null; };
    // JS Math.round ties go toward positive infinity (Rust round differs for negatives).
    let round = |v:f64| { let floor = v.floor(); if v-floor < 0.5 {floor} else {floor+1.0} };
    json!({"version":1,"normalBounds":bounds_value(Rect {
        x:round(rect.x),y:round(rect.y),width:round(rect.width),height:round(rect.height)
    }),"maximized":maximized == &Value::Bool(true)})
}

fn valid_state(value: &Value) -> bool {
    value.get("version").and_then(Value::as_f64) == Some(1.0)
        && value.get("normalBounds").and_then(valid_rect).is_some()
        && matches!(value.get("maximized"), Some(Value::Bool(_)))
}

pub struct WindowStateStore { file: Arc<SidecarFile> }
impl WindowStateStore {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        Ok(Self { file: Arc::new(SidecarFile::new(root, Sidecar::WindowState)?) })
    }
    pub fn load(&self) -> Result<Option<Value>, String> { self.file.read() }
    pub fn restore(&self, displays: &Value) -> Result<Option<Value>, String> {
        let Some(saved) = self.load()? else { return Ok(None); };
        let js_falsy = saved.is_null() || saved.as_bool() == Some(false)
            || saved.as_f64() == Some(0.0) || saved.as_str() == Some("");
        if js_falsy { return Ok(None); }
        Ok(Some(restore_window_state(&saved, displays, None)))
    }
    pub fn save(&self, state: &Value) -> Result<(), String> {
        if !valid_state(state) { return Err("window-state: invalid state".into()); }
        self.file.transaction(|_| Ok((state.clone(), ())))?;
        Ok(())
    }
    pub fn save_current(&self, normal_bounds: &Value, maximized: &Value) -> Result<(), String> {
        let state = serialize_window_state(normal_bounds, maximized);
        if state.is_null() { return Ok(()); }
        self.save(&state)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn display(x:i64,y:i64,w:i64,h:i64)->Value {json!({"workArea":{"x":x,"y":y,"width":w,"height":h}})}
    #[test]
    fn offscreen_bounds_return_to_primary_and_fit_small_work_area() {
        let input = json!({"version":1,"normalBounds":{"x":9000,"y":9000,"width":1280,"height":820},"maximized":true});
        let before=input.clone();
        assert_eq!(restore_window_state(&input,&json!([display(0,0,800,600)]),None),json!({"normalBounds":{"x":0,"y":0,"width":800,"height":600},"maximized":true}));
        assert_eq!(input,before);
    }
    #[test]
    fn largest_intersection_selects_negative_coordinate_secondary_monitor() {
        let saved=json!({"version":1,"normalBounds":{"x":-1800,"y":30,"width":1100,"height":700}});
        assert_eq!(restore_window_state(&saved,&json!([display(0,0,1920,1040),display(-1920,0,1920,1080)]),None),json!({"normalBounds":{"x":-1800,"y":30,"width":1100,"height":700},"maximized":false}));
    }
    #[test]
    fn ties_keep_first_display_and_bounds_are_clamped_to_minimum() {
        let saved=json!({"version":1,"normalBounds":{"x":1920,"y":-10,"width":100,"height":100}});
        assert_eq!(restore_window_state(&saved,&json!([display(0,0,1920,1080),display(3000,0,1920,1080)]),None)["normalBounds"],json!({"x":940,"y":0,"width":980,"height":640}));
    }
    #[test]
    fn invalid_state_and_displays_use_defaults_with_strict_maximized() {
        for saved in [Value::Null,json!({"version":2,"maximized":true}),json!({"version":1,"normalBounds":{"x":"0","y":0,"width":0,"height":5},"maximized":1})] {
            assert_eq!(restore_window_state(&saved,&json!([null,{"workArea":{"x":0,"y":0,"width":-1,"height":20}}]),None),json!({"normalBounds":{"x":0,"y":0,"width":1280,"height":820},"maximized":false}));
        }
        assert_eq!(restore_window_state(&json!({"version":1,"maximized":true}),&Value::Null,Some(&json!({"width":1000,"height":700})))["maximized"],json!(true));
    }
    #[test]
    fn serialization_uses_js_rounding_and_rejects_bad_rectangles() {
        assert_eq!(serialize_window_state(&json!({"x":-2.5,"y":1.5,"width":1000.5,"height":700.4}),&json!(true)),json!({"version":1,"normalBounds":{"x":-2,"y":2,"width":1001,"height":700},"maximized":true}));
        for rect in [Value::Null,json!({}),json!({"x":0,"y":0,"width":0,"height":5}),json!({"x":0,"y":0,"width":true,"height":5})] {
            assert_eq!(serialize_window_state(&rect,&json!(true)),Value::Null);
        }
        assert_eq!(serialize_window_state(&json!({"x":0,"y":0,"width":1,"height":1}),&json!(1))["maximized"],json!(false));
    }
    fn root() -> PathBuf {
        let root=std::env::temp_dir().join(format!("arc-window-state-test-{:032x}",rand::random::<u128>()));
        fs::create_dir(&root).unwrap();root
    }
    #[test]
    fn store_persists_only_valid_serialized_state() {
        let root=root();let store=WindowStateStore::new(root.clone()).unwrap();
        assert_eq!(store.load().unwrap(),None);
        let state=json!({"version":1,"normalBounds":{"x":10,"y":20,"width":1000,"height":700},"maximized":true});
        store.save(&state).unwrap();
        assert_eq!(store.load().unwrap(),Some(state.clone()));
        for invalid in [Value::Null,json!({"version":2,"normalBounds":{"x":0,"y":0,"width":10,"height":10},"maximized":false}),json!({"version":1,"normalBounds":{"x":0,"y":0,"width":0,"height":10},"maximized":false}),json!({"version":1,"normalBounds":{"x":0,"y":0,"width":10,"height":10},"maximized":1})] {
            assert!(store.save(&invalid).is_err());
        }
        assert_eq!(store.load().unwrap(),Some(state));
        assert!(root.join("window-state.json").is_file());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn malformed_document_is_never_overwritten() {
        let root=root();let store=WindowStateStore::new(root.clone()).unwrap();let path=root.join("window-state.json");
        fs::write(&path,b"broken").unwrap();
        assert!(store.load().is_err());
        assert!(store.save(&json!({"version":1,"normalBounds":{"x":0,"y":0,"width":10,"height":10},"maximized":false})).is_err());
        assert_eq!(fs::read(&path).unwrap(),b"broken");
        fs::remove_dir_all(root).unwrap();
    }
}
