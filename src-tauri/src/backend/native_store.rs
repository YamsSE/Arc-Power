//! Private service API for native storage. The host supplies one fixed root;
//! neither the renderer nor the compatibility service can select filenames.
use super::{profile_store::ProfileStore, settings_store::SettingsStore,
    store_file::SchemaStore, overlay_layout::OverlayLayoutStore, wire::{self, WireValue}};
use serde_json::{json, Map, Value};
use std::{path::PathBuf, sync::{Arc, Mutex}};

pub struct NativeStore {
    root: PathBuf,
    profiles: ProfileStore,
    settings: SettingsStore,
    layouts: OverlayLayoutStore,
    layout_operation: Mutex<()>,
    stability: super::stability_store::StabilityStore,
    fan_resume: super::fan_resume_store::FanResumeStore,
    window_state: super::window_state::WindowStateStore,
    credentials: super::credentials::CredentialStore,
    domains: super::domain_store::DomainStore,
    rtss_profile: super::rtss_profile::RtssProfileController,
}

// JSON-only storage inputs retain missing settings fields. An explicitly
// undefined Arc Sleep-owned field is represented as null: the original
// dedicated writer clears these fields when they are present but undefined.
fn json_argument(value: WireValue, owned_patch: bool) -> Result<Value, String> {
    Ok(match value {
        WireValue::Undefined | WireValue::Null => Value::Null,
        WireValue::Bool(value) => value.into(),
        WireValue::String(value) => value.into(),
        WireValue::Number(value) => Value::Number(value),
        WireValue::SpecialNumber(value) if value == "-0" => json!(0),
        WireValue::Array(values) => Value::Array(values.into_iter().map(|value| json_argument(value, false)).collect::<Result<_,_>>()?),
        WireValue::Object(entries) => {
            let mut object = Map::new();
            for (key, value) in entries {
                if matches!(value, WireValue::Undefined) && !owned_patch { continue; }
                let value = if owned_patch && key == "arcSleep" { policy_argument(value)? }
                    else { json_argument(value, false)? };
                object.insert(key, value);
            }
            Value::Object(object)
        }
        WireValue::SpecialNumber(_) | WireValue::BigInt(_) => return Err("Native storage requires JSON-safe values; no value was written".into()),
    })
}

fn policy_argument(value: WireValue) -> Result<Value, String> {
    if let WireValue::Object(entries) = value {
        let mut result = Map::new();
        for (key, value) in entries {
            // A present undefined numeric policy option means use the default,
            // while null coerces to zero. An empty object preserves Number's
            // nonfinite/default semantics without inventing a JSON number.
            let value = if matches!(&value, WireValue::Undefined) || matches!(&value, WireValue::SpecialNumber(number) if number != "-0") { json!({}) }
                else { json_argument(value, false)? };
            result.insert(key, value);
        }
        Ok(Value::Object(result))
    } else { json_argument(value, false) }
}

// Window geometry follows Number.isFinite checks in the JavaScript serializer.
// Map tagged unsupported numeric values to null so the Rust serializer rejects
// those bounds as a no-op instead of turning them into a storage error.
fn window_state_argument(value: WireValue) -> Value {
    match value {
        WireValue::Undefined | WireValue::Null | WireValue::BigInt(_) => Value::Null,
        WireValue::Bool(value) => value.into(),
        WireValue::String(value) => value.into(),
        WireValue::Number(value) => Value::Number(value),
        WireValue::SpecialNumber(value) if value == "-0" => json!(0),
        WireValue::SpecialNumber(_) => Value::Null,
        WireValue::Array(values) => Value::Array(values.into_iter().map(window_state_argument).collect()),
        WireValue::Object(entries) => {
            let mut object = Map::new();
            for (key, value) in entries {
                if matches!(value, WireValue::Undefined) { continue; }
                object.insert(key, window_state_argument(value));
            }
            Value::Object(object)
        }
    }
}

// JSON.parse can produce Infinity from an extreme numeric exponent even
// though JSON.stringify emits null for it. Preserve the updater's safe-size
// and ignored-metadata behavior at this private JSON boundary.
fn update_release_argument(value: WireValue) -> Result<Value, String> {
    Ok(match value {
        WireValue::Undefined | WireValue::Null => Value::Null,
        WireValue::Bool(value) => value.into(),
        WireValue::String(value) => value.into(),
        WireValue::Number(value) => Value::Number(value),
        WireValue::SpecialNumber(value) if value == "-0" => json!(0),
        WireValue::SpecialNumber(_) => Value::Null,
        WireValue::BigInt(_) => return Err("update-release-select requires fetched JSON metadata".into()),
        WireValue::Array(values) => Value::Array(values.into_iter().map(update_release_argument).collect::<Result<_,_>>()?),
        WireValue::Object(entries) => {
            let mut object = Map::new();
            for (key, value) in entries {
                if matches!(value, WireValue::Undefined) { continue; }
                object.insert(key, update_release_argument(value)?);
            }
            Value::Object(object)
        }
    })
}

impl NativeStore {
    pub fn new(root: PathBuf, mode_default: &str) -> Result<Self, String> {
        let files = Arc::new(SchemaStore::new(root.clone())?);
        Ok(Self {
            root: root.clone(),
            profiles: ProfileStore::new(files.clone()),
            settings: SettingsStore::new(files, mode_default),
            layouts: OverlayLayoutStore::new(root.clone())?,
            layout_operation: Mutex::new(()),
            stability: super::stability_store::StabilityStore::new(root.clone(), &Value::Null)?,
            fan_resume: super::fan_resume_store::FanResumeStore::new(root.clone())?,
            window_state: super::window_state::WindowStateStore::new(root.clone())?,
            credentials: super::credentials::CredentialStore::new(root.clone())?,
            domains: super::domain_store::DomainStore::new(root)?,
            rtss_profile: super::rtss_profile::RtssProfileController::new(),
        })
    }

    /// Fixed application-data root (`%APPDATA%\ArcPower` in production or the
    /// caller-supplied temp root in tests). Native sidecars that live directly
    /// under this root reuse it without adding another host input.
    pub fn root(&self) -> &std::path::Path { &self.root }

    /// The settings owner (Arc Sleep persistence and the selected GPU target).
    pub fn settings_store(&self) -> &SettingsStore { &self.settings }

    /// The single RTSS profile writer.
    pub fn rtss_profile(&self) -> &super::rtss_profile::RtssProfileController { &self.rtss_profile }

    /// Serialize a sidecar mutation with applying its selected layout, while
    /// holding the shared SettingsStore cache lock across both steps. Renderer
    /// channels use the broker for cache publication and overlay reactions.
    fn mutate_layout_and_apply(&self, method: &str, value: &Value) -> Result<(Value, Value), String> {
        self.mutate_layout_and_apply_with(method, value, || {})
    }

    fn mutate_layout_and_apply_with(&self, method: &str, value: &Value, after_mutation: impl FnOnce()) -> Result<(Value, Value), String> {
        let _guard = self.layout_operation.lock().map_err(|_| "Layout operation lock was poisoned")?;
        self.settings.with_overlay_layout_transaction(|settings| {
            let defaults = super::services::overlay_defaults(settings);
            let data = match method {
                "save" => {
                    // The broker adapter already ran the JavaScript
                    // normalizer. At this boundary `null` opacity therefore
                    // represents a normalized NaN (explicit input null has
                    // already inherited its fallback) and must stay null in
                    // the sidecar for later default inheritance.
                    let preserve_null_opacity = value.get("background").and_then(|background| background.get("opacity")).is_some_and(Value::is_null);
                    self.layouts.save_with_nonfinite_opacity(value, &defaults, preserve_null_opacity)?
                },
                "select" => self.layouts.select(value, &defaults)?,
                "delete" => self.layouts.delete(value, &defaults)?,
                "rename" => self.layouts.rename(value.get("id").unwrap_or(&Value::Null), value.get("name").unwrap_or(&Value::Null), &defaults)?,
                _ => return Err("Unknown layout operation".into()),
            };
            after_mutation();
            let layouts = data["layouts"].as_array().ok_or("Invalid layout result")?;
            let selected = if method == "rename" { None } else {
                layouts.iter().find(|layout| layout.get("id") == data.get("activeId"))
                    .or_else(|| if method == "save" { layouts.first() } else { None }).cloned()
            };
            Ok((data, selected))
        })
    }

    fn load_layout_snapshot(&self) -> Result<(Value, Value), String> {
        let _guard = self.layout_operation.lock().map_err(|_| "Layout operation lock was poisoned")?;
        self.settings.with_overlay_layout_transaction(|settings| {
            let defaults = super::services::overlay_defaults(settings);
            Ok((self.layouts.load(&defaults)?, None))
        })
    }

    pub fn invoke(&self, method: &str, encoded_args: &Value) -> Result<Value, String> {
        let expected = match method {
            "load-profiles" | "load-settings" | "stability-load" | "stability-list" | "stability-latest" | "fan-resume-list" | "window-state-load" | "obs-credential-load" | "overlay-layout-list-snapshot" => 0,
            "save-profiles" | "save-profile" | "delete-profile" | "save-settings" | "patch-settings" | "save-arc-sleep-state" | "apply-overlay-layout" | "fan-resume-get" | "fan-resume-set" | "fan-resume-remove" | "window-state-save" | "obs-credential-save" => 1,
            "save-settings-with-arc-sleep" => 2,
            "update-release-select" => 3,
            "registry-apply-plan" => 2,
            "window-state-restore" => 1,
            "window-state-save-current" => 2,
            "overlay-layout-load"=>1,
            "overlay-layout-mutate-and-apply"=>2,
            "overlay-layout-save"|"overlay-layout-select"|"overlay-layout-delete"=>2,
            "overlay-layout-rename"=>3,
            "stability-append"=>1,
            "rtss-profile-state"|"rtss-frame-limit-ownership"|"rtss-sharpening-compatibility"=>0,
            "rtss-profile-apply"|"rtss-frame-limit-get"|"rtss-frame-limit-apply"|"rtss-frame-limit-restore"|"rtss-frame-limit-restore-state"=>1,
            _ => super::domain_store::DomainStore::argument_count(method).ok_or("Unknown native storage method")?,
        };
        let WireValue::Array(args) = wire::decode(encoded_args)? else { return Err("Native storage arguments must be an array".into()); };
        if args.len() != expected { return Err("Invalid native storage argument count".into()); }
        let layout_mutation = if method == "overlay-layout-mutate-and-apply" {
            match args.first() {
                Some(WireValue::String(operation)) if matches!(operation.as_str(), "save" | "select" | "delete" | "rename") => Some(operation.clone()),
                _ => return Err("overlay-layout-mutate-and-apply expects save, select, delete or rename".into()),
            }
        } else { None };
        let args = args.into_iter().enumerate().map(|(index, value)| {
            if method == "save-settings-with-arc-sleep" && index == 1 { policy_argument(value) }
            else if method == "overlay-layout-mutate-and-apply" && index == 1 {
                if matches!(value, WireValue::Undefined) && layout_mutation.as_deref() == Some("save") {
                    Ok(json!({}))
                } else { json_argument(value, false) }
            }
            else if matches!(method, "window-state-restore" | "window-state-save-current") { Ok(window_state_argument(value)) }
            else if method == "update-release-select" { update_release_argument(value) }
            else { json_argument(value, method == "save-arc-sleep-state") }
        }).collect::<Result<Vec<_>, _>>()?;
        // Individual broker requests participate in sidecar ordering, but
        // their separate apply request is not part of this critical section.
        let _layout_guard = if method.starts_with("overlay-layout-")
            && !matches!(method, "overlay-layout-mutate-and-apply" | "overlay-layout-list-snapshot") {
            Some(self.layout_operation.lock().map_err(|_| "Layout operation lock was poisoned")?)
        } else { None };
        let result = match method {
            "load-profiles" => Value::Array(self.profiles.load_profiles()?),
            "load-settings" => self.settings.load_settings()?,
            "save-profiles" => {
                self.profiles.save_profiles(args[0].as_array().ok_or("Profiles must be an array")?)?;
                Value::Null
            }
            "save-profile" => { self.profiles.save_profile(&args[0])?; Value::Null }
            "delete-profile" => self.profiles.delete_profile(args[0].as_str().ok_or("Profile id must be a string")?)?.into(),
            "save-settings" => {
                self.settings.save_settings(&args[0])?;
                json!({"cache":self.settings.load_settings_sync()?})
            }
            "patch-settings" => {
                self.settings.patch_settings(&args[0])?;
                json!({"cache":self.settings.load_settings_sync()?})
            }
            "apply-overlay-layout" => json!({"cache":self.settings.apply_overlay_layout(&args[0])?}),
            "overlay-layout-list-snapshot" => {
                let (data, cache)=self.load_layout_snapshot()?;
                json!({"data":data,"cache":cache})
            }
            "save-arc-sleep-state" => {
                self.settings.save_arc_sleep_state(&args[0])?;
                json!({"cache":self.settings.load_settings_sync()?})
            }
            "save-settings-with-arc-sleep" => {
                self.settings.save_settings_with_arc_sleep(&args[0], &args[1])?;
                json!({"cache":self.settings.load_settings_sync()?})
            }
            "update-release-select" => super::update_release::select(&args[0], &args[1], &args[2])?,
            "registry-apply-plan" => super::registry_catalog::plan_apply(&args[0], &args[1])?,
            "overlay-layout-load"=>self.layouts.load(&args[0])?,
            "overlay-layout-mutate-and-apply"=>{
                let (data, cache)=self.mutate_layout_and_apply(layout_mutation.as_deref().unwrap(), &args[1])?;
                json!({"data":data,"cache":cache})
            }
            "overlay-layout-save"=>self.layouts.save(&args[0],&args[1])?,
            "overlay-layout-rename"=>self.layouts.rename(&args[0],&args[1],&args[2])?,
            "overlay-layout-select"=>self.layouts.select(&args[0],&args[1])?,
            "overlay-layout-delete"=>self.layouts.delete(&args[0],&args[1])?,
            "stability-load"=>self.stability.load(&super::platform_context::clock_snapshot().map_err(|error|error.to_string())?)?,
            "stability-list"=>Value::Array(self.stability.list(&super::platform_context::clock_snapshot().map_err(|error|error.to_string())?)?),
            "stability-latest"=>self.stability.latest(&super::platform_context::clock_snapshot().map_err(|error|error.to_string())?)?.unwrap_or(Value::Null),
            "stability-append"=>self.stability.append(&args[0],&super::platform_context::clock_snapshot().map_err(|error|error.to_string())?)?,
            "fan-resume-list"=>Value::Array(self.fan_resume.list()?),
            "fan-resume-get"=>self.fan_resume.get(&args[0])?.unwrap_or(Value::Null),
            "fan-resume-set"=>self.fan_resume.set(&args[0])?,
            "fan-resume-remove"=>{self.fan_resume.remove(&args[0])?;Value::Null},
            "window-state-load"=>self.window_state.load()?.unwrap_or(Value::Null),
            "window-state-save"=>{self.window_state.save(&args[0])?;Value::Null},
            "window-state-restore"=>self.window_state.restore(&args[0])?.unwrap_or(Value::Null),
            "window-state-save-current"=>{self.window_state.save_current(&args[0],&args[1])?;Value::Null},
            "obs-credential-load"=>self.credentials.load()?.map(Value::String).unwrap_or(Value::Null),
            "obs-credential-save"=>{let password=args[0].as_str().ok_or("obs-credential-save: password must be a string")?;self.credentials.save(password)?;Value::Null},
            "rtss-profile-state"=>self.rtss_profile.state(),
            "rtss-profile-apply"=>self.rtss_profile.apply(&args[0]),
            "rtss-frame-limit-get"=>self.rtss_profile.get_frame_limit(&args[0]),
            "rtss-frame-limit-ownership"=>self.rtss_profile.get_ownership(),
            "rtss-frame-limit-apply"=>self.rtss_profile.apply_frame_limit(&args[0]),
            "rtss-frame-limit-restore"=>self.rtss_profile.restore_frame_limit(&args[0]),
            "rtss-frame-limit-restore-state"=>self.rtss_profile.restore_frame_limit_state(&args[0]),
            "rtss-sharpening-compatibility"=>self.rtss_profile.ensure_sharpening_compatibility(),
            _ => self.domains.invoke(method,&args)?,
        };
        wire::encode_json(&result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self { let path = std::env::temp_dir().join(format!("arc-native-store-{:032x}",rand::random::<u128>())); std::fs::create_dir(&path).unwrap(); Self(path) }
        fn store(&self) -> NativeStore { NativeStore::new(self.0.clone(), "advanced").unwrap() }
    }
    impl Drop for Fixture { fn drop(&mut self) { if self.0.parent() == Some(std::env::temp_dir().as_path()) { let _ = std::fs::remove_dir_all(&self.0); } } }
    fn call(store: &NativeStore, method: &str, args: Value) -> Result<Value, String> {
        wire::decode(&store.invoke(method, &wire::encode_json(&args)?)?)?.into_json()
    }
    #[test]
    fn service_uses_fixed_root_and_native_profile_and_settings_owners() {
        let fixture = Fixture::new(); let store = fixture.store();
        assert_eq!(call(&store,"load-profiles",json!([])).unwrap(),json!([]));
        let mut settings = call(&store,"load-settings",json!([])).unwrap();
        assert_eq!(settings["ocMode"],"advanced");
        settings["theme"] = json!("red");
        assert_eq!(call(&store,"save-settings",json!([settings])).unwrap()["cache"]["theme"],"red");
        call(&store,"save-profile",json!([{"id":"p1","deviceKey":"gpu-a"}])).unwrap();
        assert_eq!(call(&store,"load-profiles",json!([])).unwrap()[0]["deviceKey"],"gpu-a");
        assert_eq!(call(&store,"delete-profile",json!(["p1"])).unwrap(),true);
        assert_eq!(call(&store,"delete-profile",json!(["p1"])).unwrap(),false);
    }
    #[test]
    fn service_owns_overlay_layouts_and_stability_history() {
        let fixture=Fixture::new();let store=fixture.store();
        let defaults=json!({"theme":"arc","stats":["fps"]});
        call(&store,"overlay-layout-save",json!([{"id":"test","name":"Test"},defaults])).unwrap();
        call(&store,"overlay-layout-rename",json!(["test","Renamed",defaults])).unwrap();
        assert_eq!(call(&store,"overlay-layout-select",json!(["test",defaults])).unwrap()["activeId"],"test");
        let loaded=call(&store,"overlay-layout-load",json!([defaults])).unwrap();
        assert!(loaded["layouts"].as_array().unwrap().iter().any(|value|value["id"]=="test"&&value["name"]=="Renamed"));
        call(&store,"overlay-layout-delete",json!(["test",defaults])).unwrap();
        assert_eq!(call(&store,"stability-latest",json!([])).unwrap(),Value::Null);
        let report=json!({"runId":"native-report","deviceKey":"gpu-a","outcome":"passed"});
        call(&store,"stability-append",json!([report])).unwrap();
        assert_eq!(call(&store,"stability-latest",json!([])).unwrap()["runId"],"native-report");
        assert_eq!(call(&store,"stability-list",json!([])).unwrap().as_array().unwrap().len(),1);
        assert!(fixture.0.join("overlay-layouts.json").is_file());assert!(fixture.0.join("stability.json").is_file());
    }
    #[test]
    fn combined_layout_store_mutation_returns_the_committed_settings_cache() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let saved = call(&store, "overlay-layout-mutate-and-apply", json!([
            "save", {"id":"custom","name":"Game","position":"bottom-right","scale":1.5}
        ])).unwrap();
        assert_eq!(saved["data"]["activeId"], "default");
        assert_eq!(saved["cache"]["overlayPosition"], "top-left");

        let selected = call(&store, "overlay-layout-mutate-and-apply", json!(["select", "custom"])).unwrap();
        assert_eq!(selected["data"]["activeId"], "custom");
        assert_eq!(selected["cache"]["overlayPosition"], "bottom-right");
        assert_eq!(selected["cache"]["overlayScale"], 1.5);

        let renamed = call(&store, "overlay-layout-mutate-and-apply", json!([
            "rename", {"id":"custom","name":"Renamed"}
        ])).unwrap();
        assert_eq!(renamed["data"]["layouts"][1]["name"], "Renamed");
        assert_eq!(renamed["cache"], selected["cache"]);

        let deleted = call(&store, "overlay-layout-mutate-and-apply", json!(["delete", "custom"])).unwrap();
        assert_eq!(deleted["data"]["activeId"], "default");
        assert_eq!(deleted["cache"]["overlayPosition"], "top-left");
    }
    #[test]
    fn layout_list_snapshot_reads_defaults_and_cache_under_one_settings_lock() {
        let fixture = Fixture::new();
        let store = fixture.store();
        call(&store, "overlay-layout-mutate-and-apply", json!([
            "save", {"id":"custom","position":"bottom-left","scale":1.25}
        ])).unwrap();
        let selected = call(&store, "overlay-layout-mutate-and-apply", json!(["select", "custom"])).unwrap();
        let snapshot = call(&store, "overlay-layout-list-snapshot", json!([])).unwrap();
        assert_eq!(snapshot["data"]["activeId"], "custom");
        assert_eq!(snapshot["data"]["layouts"][1]["position"], "bottom-left");
        assert_eq!(snapshot["cache"], selected["cache"]);
        assert_eq!(snapshot["cache"]["overlayPosition"], snapshot["data"]["layouts"][1]["position"]);
    }
    #[test]
    fn combined_layout_save_preserves_nan_null_for_future_default_inheritance() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let saved = call(&store, "overlay-layout-mutate-and-apply", json!([
            "save", {"id":"custom","background":{"opacity":null}}
        ])).unwrap();
        assert_eq!(saved["data"]["layouts"][1]["background"]["opacity"], Value::Null);
        let raw: Value = serde_json::from_slice(&std::fs::read(fixture.0.join("overlay-layouts.json")).unwrap()).unwrap();
        assert_eq!(raw["layouts"][1]["background"]["opacity"], Value::Null);
        let loaded = call(&store, "overlay-layout-load", json!([{"background":{"opacity":0.9}}])).unwrap();
        assert_eq!(loaded["layouts"][1]["background"]["opacity"], json!(0.9));
    }
    #[test]
    fn combined_layout_operations_serialize_and_apply_the_final_selection() {
        let fixture = Fixture::new();
        let store = Arc::new(fixture.store());
        let defaults = json!({});
        for (id, position) in [("a", "top-right"), ("b", "bottom-left")] {
            store.mutate_layout_and_apply("save", &json!({"id":id,"position":position})).unwrap();
        }
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = ["a", "b"].into_iter().map(|id| {
            let store = store.clone(); let barrier = barrier.clone();
            std::thread::spawn(move || { barrier.wait(); store.mutate_layout_and_apply("select", &json!(id)).unwrap(); })
        }).collect();
        barrier.wait();
        for worker in workers { worker.join().unwrap(); }
        let data = call(&store, "overlay-layout-load", json!([defaults])).unwrap();
        let selected = data["layouts"].as_array().unwrap().iter().find(|item| item["id"] == data["activeId"]).unwrap();
        assert_eq!(call(&store, "load-settings", json!([])).unwrap()["overlayPosition"], selected["position"]);
        let before = data.clone();
        assert!(store.mutate_layout_and_apply("select", &json!("missing")).is_err());
        assert_eq!(call(&store, "overlay-layout-load", json!([defaults])).unwrap(), before);
    }

    #[test]
    fn combined_layout_holds_settings_lock_through_apply_and_serializes_arc_sleep_writes() {
        let fixture = Fixture::new();
        let store = Arc::new(fixture.store());
        let mut initial = store.settings.load_settings().unwrap();
        initial["closeToTray"] = json!(true);
        store.settings.save_settings(&initial).unwrap();
        store.mutate_layout_and_apply("save", &json!({"id":"a","position":"top-right"})).unwrap();

        let (mutated_tx, mutated_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let combined = {
            let store = store.clone();
            std::thread::spawn(move || store.mutate_layout_and_apply_with("select", &json!("a"), || {
                mutated_tx.send(()).unwrap();
                release_rx.recv().unwrap();
            }).unwrap())
        };
        mutated_rx.recv().unwrap();

        // The sidecar has changed, but cache publication is paused. The shared
        // SettingsStore mutex remains held across both steps of the operation.
        assert!(store.settings.try_load_settings_sync().is_none());
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let arc_sleep_writer = {
            let store = store.clone();
            std::thread::spawn(move || {
                started_tx.send(()).unwrap();
                store.settings.save_arc_sleep_state(&json!({"arcSleep":{"idleEnabled":true}})).unwrap();
                done_tx.send(()).unwrap();
            })
        };
        started_rx.recv().unwrap();
        assert!(done_rx.try_recv().is_err(), "settings writer must wait for the combined layout lock");

        release_tx.send(()).unwrap();
        combined.join().unwrap();
        arc_sleep_writer.join().unwrap();
        done_rx.recv().unwrap();

        let data = call(&store, "overlay-layout-load", json!([{}])).unwrap();
        let selected = data["layouts"].as_array().unwrap().iter()
            .find(|layout| layout["id"] == data["activeId"]).unwrap();
        let current = store.settings.load_settings().unwrap();
        assert_eq!(data["activeId"], "a");
        assert_eq!(current["overlayPosition"], selected["position"]);
        assert_eq!(current["overlayPosition"], "top-right");
        assert_eq!(current["closeToTray"], true);
        assert_eq!(current["arcSleep"]["idleEnabled"], true);
    }

    #[test]
    fn combined_layout_keeps_sidecar_mutation_when_settings_persistence_fails() {
        let fixture = Fixture::new();
        let store = fixture.store();
        let initial = store.settings.load_settings().unwrap();
        store.mutate_layout_and_apply("save", &json!({"id":"a","position":"top-right"})).unwrap();

        let settings_path = fixture.0.join("settings.json");
        let future_settings = br#"{"schemaVersion":999}"#;
        std::fs::write(&settings_path, future_settings).unwrap();
        assert!(store.mutate_layout_and_apply("select", &json!("a")).is_err());

        let data = call(&store, "overlay-layout-load", json!([{}])).unwrap();
        assert_eq!(data["activeId"], "a");
        let cached = store.settings.load_settings_sync().unwrap().unwrap();
        assert_eq!(cached["overlayPosition"], initial["overlayPosition"]);
        assert_eq!(std::fs::read(settings_path).unwrap(), future_settings);
    }

    #[test]
    fn rename_waits_until_combined_apply_finishes() {
        let fixture = Fixture::new(); let store = Arc::new(fixture.store());
        let (mutated_tx, mutated_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let writer = { let store = store.clone(); std::thread::spawn(move || {
            store.mutate_layout_and_apply_with("save", &json!({"id":"a"}), || {
                mutated_tx.send(()).unwrap(); release_rx.recv().unwrap();
            }).unwrap();
        }) };
        mutated_rx.recv().unwrap();
        // The mutation has completed while the settings apply has not. The
        // same lock guards broker-side rename for this entire interval.
        assert!(store.layout_operation.try_lock().is_err());
        release_tx.send(()).unwrap(); writer.join().unwrap();
        let renamed = call(&store, "overlay-layout-rename", json!(["a", "After", {}])).unwrap();
        assert_eq!(renamed["layouts"].as_array().unwrap().iter().find(|v| v["id"] == "a").unwrap()["name"], "After");
    }

    /// The renderer dispatcher claim: a layout snapshot read cannot observe a
    /// half-published mutation. The read waits for the transaction and then
    /// returns the sidecar and the settings it committed together.
    #[test]
    fn layout_snapshot_reads_cannot_interleave_with_the_combined_transaction() {
        use crate::backend::native_system::BuildKind;
        use crate::backend::services::{invoke, ServiceContext};
        let fixture = Fixture::new();
        let store = Arc::new(fixture.store());
        let service = ServiceContext { build_kind: BuildKind::Dev, mock_mode: false, store: &store };
        invoke("overlay-layout-save", &wire::encode_json(&json!([{"id":"custom","position":"bottom-right","scale":1.5}])).unwrap(),
            service).unwrap().unwrap();

        let (paused_tx, paused_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let mutation = {
            let store = store.clone();
            std::thread::spawn(move || store.mutate_layout_and_apply_with("select", &json!("custom"), || {
                paused_tx.send(()).unwrap(); release_rx.recv().unwrap();
            }).unwrap())
        };
        paused_rx.recv().unwrap();

        let (listed_tx, listed_rx) = std::sync::mpsc::channel();
        let reader = {
            let store = store.clone();
            std::thread::spawn(move || {
                let result = invoke("overlay-layouts-list", &wire::encode_json(&json!([])).unwrap(),
                    ServiceContext { build_kind: BuildKind::Dev, mock_mode: false, store: &store });
                listed_tx.send(result).unwrap();
            })
        };
        assert!(listed_rx.try_recv().is_err(), "a snapshot read must wait for the mutation");
        release_tx.send(()).unwrap();
        mutation.join().unwrap();
        let listed = listed_rx.recv().unwrap().unwrap().unwrap();
        reader.join().unwrap();
        let listed = wire::decode(&listed).unwrap().into_json().unwrap();
        assert_eq!(listed["activeId"], "custom");
        assert_eq!(listed["layouts"][1]["position"], "bottom-right");
        let cache = store.settings.load_settings_sync().unwrap().unwrap();
        assert_eq!(cache["overlayPosition"], "bottom-right");
        assert_eq!(cache["overlayScale"], 1.5);
    }
    #[test]
    fn service_owns_fan_resume_sidecar_at_the_fixed_root() {
        let fixture=Fixture::new();let store=fixture.store();
        assert_eq!(call(&store,"fan-resume-list",json!([])).unwrap(),json!([]));
        let record=json!({"deviceKey":"gpu-a","physicalTarget":{"bdf":"00:02.0"},"settings":{"fanMode":"fixed","fixedFanPct":42}});
        assert_eq!(call(&store,"fan-resume-set",json!([record])).unwrap(),record);
        assert_eq!(call(&store,"fan-resume-get",json!(["gpu-a"])).unwrap(),record);
        assert_eq!(call(&store,"fan-resume-get",json!(["absent"])).unwrap(),Value::Null);
        assert!(call(&store,"fan-resume-list",json!([1])).is_err());
        assert!(call(&store,"fan-resume-get",json!([])).is_err());
        assert!(call(&store,"fan-resume-remove",json!([])).is_err());
        call(&store,"fan-resume-remove",json!(["gpu-a"])).unwrap();
        assert_eq!(call(&store,"fan-resume-list",json!([])).unwrap(),json!([]));
        assert!(fixture.0.join("FanResume.json").is_file());
    }
    #[test]
    fn service_owns_window_state_sidecar_at_the_fixed_root() {
        let fixture=Fixture::new();let store=fixture.store();
        assert_eq!(call(&store,"window-state-load",json!([])).unwrap(),Value::Null);
        let state=json!({"version":1,"normalBounds":{"x":10,"y":20,"width":1000,"height":700},"maximized":true});
        call(&store,"window-state-save",json!([state.clone()])).unwrap();
        assert_eq!(call(&store,"window-state-load",json!([])).unwrap(),state);
        assert!(call(&store,"window-state-load",json!([1])).is_err());
        assert!(call(&store,"window-state-save",json!([])).is_err());
        assert!(call(&store,"window-state-save",json!([{"version":2}])).is_err());
        assert_eq!(call(&store,"window-state-load",json!([])).unwrap(),state);
        assert!(fixture.0.join("window-state.json").is_file());
    }
    #[cfg(windows)]
    #[test]
    fn service_owns_dpapi_credentials_at_the_fixed_root() {
        let fixture=Fixture::new();let store=fixture.store();
        assert_eq!(call(&store,"obs-credential-load",json!([])).unwrap(),Value::Null);
        call(&store,"obs-credential-save",json!(["secret"])).unwrap();
        assert_eq!(call(&store,"obs-credential-load",json!([])).unwrap(),json!("secret"));
        assert!(call(&store,"obs-credential-save",json!([null])).is_err());
        assert!(call(&store,"obs-credential-save",json!(["x".repeat(513)])).is_err());
        assert_eq!(call(&store,"obs-credential-load",json!([])).unwrap(),json!("secret"));
        assert!(fixture.0.join("obs-stream-password.bin").is_file());
    }
    #[test]
    fn invalid_or_arbitrary_path_requests_never_create_files() {
        let fixture = Fixture::new(); let store = fixture.store();
        for (method,args) in [("write-file",json!(["C:/arbitrary",{}])),("load-settings",json!(["elsewhere"])),("save-profiles",json!([{}])),("save-profile",json!([null]))] {
            assert!(call(&store,method,args).is_err());
        }
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(),0);
    }
    #[test]
    fn service_routes_rtss_profile_methods_with_exact_argument_counts() {
        let fixture = Fixture::new(); let store = fixture.store();
        let state = call(&store, "rtss-profile-state", json!([])).unwrap();
        assert!(state.get("available").unwrap().is_boolean());
        let limit = call(&store, "rtss-frame-limit-get", json!([{}])).unwrap();
        assert!(limit.get("ok").unwrap().is_boolean());
        let ownership = call(&store, "rtss-frame-limit-ownership", json!([])).unwrap();
        assert!(ownership.get("ok").unwrap().is_boolean());
        assert!(call(&store, "rtss-frame-limit-get", json!([])).is_err());
        assert!(call(&store, "rtss-profile-apply", json!([])).is_err());
        assert!(call(&store, "rtss-profile-state", json!([{}])).is_err());
    }
    #[test]
    fn undefined_generic_fields_are_omitted_but_owned_patch_clears_fields() {
        let fixture = Fixture::new(); let store = fixture.store();
        call(&store,"save-arc-sleep-state",json!([{"arcSleepJournal":{"before":90}}])).unwrap();
        let args = json!({"t":"array","v":[{"t":"object","v":[["arcSleepJournal",{"t":"undefined"}]]}]});
        let result = wire::decode(&store.invoke("save-arc-sleep-state",&args).unwrap()).unwrap().into_json().unwrap();
        assert_eq!(result["cache"]["arcSleepJournal"],Value::Null);
        call(&store,"save-arc-sleep-state",json!([{"arcSleep":{"idleAfterSeconds":120}}])).unwrap();
        let args = json!({"t":"array","v":[{"t":"object","v":[["arcSleep",{"t":"object","v":[["idleAfterSeconds",{"t":"undefined"}]]}]]}]});
        let result = wire::decode(&store.invoke("save-arc-sleep-state",&args).unwrap()).unwrap().into_json().unwrap();
        assert_eq!(result["cache"]["arcSleep"]["idleAfterSeconds"],300);
        let args = json!({"t":"array","v":[{"t":"object","v":[["arcSleep",{"t":"object","v":[["idleFps",{"t":"number","v":"-0"}]]}]]}]});
        let result = wire::decode(&store.invoke("save-arc-sleep-state",&args).unwrap()).unwrap().into_json().unwrap();
        assert_eq!(result["cache"]["arcSleep"]["idleFps"],15);
        assert!(store.invoke("save-settings",&json!({"t":"array","v":[{"t":"number","v":"NaN"}]})).is_err());
    }
}
