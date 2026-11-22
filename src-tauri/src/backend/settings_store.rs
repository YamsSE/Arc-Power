//! Settings ownership and synchronous close-handler cache. All writes and cache
//! publication use one lock; failed disk writes never publish an unpersisted value.
use super::{settings::normalize_settings, settings_write::prepare_settings_write,
    store_file::{SchemaStore, StoreFile}};
use serde_json::Value;
use std::sync::{Arc, Mutex, MutexGuard};

pub struct SettingsStore {
    files: Arc<SchemaStore>,
    mode: &'static str,
    cache: Mutex<Option<Value>>,
}

impl SettingsStore {
    pub fn new(files: Arc<SchemaStore>, mode_default: &str) -> Self {
        Self { files, mode: if mode_default == "advanced" { "advanced" } else { "stock" }, cache: Mutex::new(None) }
    }

    fn cache_guard(&self) -> Result<MutexGuard<'_, Option<Value>>, String> {
        self.cache.lock().map_err(|_| "Settings cache mutex was poisoned".into())
    }

    fn read(&self) -> Result<Value, String> {
        let raw = self.files.load(StoreFile::Settings)?;
        Ok(normalize_settings(raw.as_ref(), self.mode))
    }

    pub fn load_settings(&self) -> Result<Value, String> {
        let mut cache = self.cache_guard()?;
        let loaded = self.read()?;
        *cache = Some(loaded.clone());
        Ok(loaded)
    }

    /// No I/O, matching the close-handler snapshot contract. Callers receive an
    /// owned snapshot and cannot mutate the authoritative cache.
    pub fn load_settings_sync(&self) -> Result<Option<Value>, String> {
        Ok(self.cache_guard()?.clone())
    }

    /// Nonblocking close-handler snapshot for host cadence work. A missing or
    /// contended cache is represented as `None`; this never performs disk I/O.
    pub fn try_load_settings_sync(&self) -> Option<Value> {
        self.cache.try_lock().ok()?.clone()
    }

    fn write_locked(&self, cache: &mut Option<Value>, settings: &Value, patch: Option<&Value>) -> Result<(), String> {
        if cache.is_none() { *cache = Some(self.read()?); }
        let prepared = prepare_settings_write(settings, cache.as_ref().unwrap(), patch, self.mode)?;
        self.files.save(StoreFile::Settings, &prepared.persisted)?;
        *cache = Some(prepared.cache);
        Ok(())
    }

    pub fn save_settings(&self, settings: &Value) -> Result<(), String> {
        let mut cache = self.cache_guard()?;
        self.write_locked(&mut cache, settings, None)
    }

    /// Apply a field patch to the latest cached settings snapshot under the
    /// same lock as persistence. This is for compatibility-service background
    /// writers that cannot hold the host's higher-level save queue across
    /// their async work; a stale pre-read snapshot must not erase unrelated
    /// settings committed while that work was running.
    pub fn patch_settings(&self, patch: &Value) -> Result<(), String> {
        let patch = patch.as_object().ok_or("Settings patch must be an object")?;
        let mut cache = self.cache_guard()?;
        if cache.is_none() { *cache = Some(self.read()?); }
        let mut settings = cache.as_ref().and_then(Value::as_object).cloned()
            .ok_or("Settings cache must be an object")?;
        for (key, value) in patch { settings.insert(key.clone(), value.clone()); }
        self.write_locked(&mut cache, &Value::Object(settings), None)
    }

    pub fn save_arc_sleep_state(&self, patch: &Value) -> Result<(), String> {
        let mut cache = self.cache_guard()?;
        if cache.is_none() { *cache = Some(self.read()?); }
        let settings = cache.as_ref().unwrap().clone();
        self.write_locked(&mut cache, &settings, Some(patch))
    }

    pub fn save_settings_with_arc_sleep(&self, settings: &Value, policy_patch: &Value) -> Result<(), String> {
        let mut cache = self.cache_guard()?;
        let patch = serde_json::json!({"arcSleep":policy_patch});
        self.write_locked(&mut cache, settings, Some(&patch))
    }

    /// Apply the settings owned by a normalized overlay layout as one
    /// read/modify/write under the settings cache lock. The layout sidecar is
    /// persisted by its owner before this method is called; this mutation only
    /// updates settings and returns the cache snapshot published on success.
    pub fn apply_overlay_layout(&self, layout: &Value) -> Result<Value, String> {
        let mut cache = self.cache_guard()?;
        if cache.is_none() { *cache = Some(self.read()?); }
        let settings = overlay_layout_settings(cache.as_ref().unwrap(), layout)?;
        self.write_locked(&mut cache, &settings, None)?;
        cache.as_ref().cloned().ok_or_else(|| "Settings cache was not published".into())
    }

    /// Keep a staged layout sidecar mutation and its settings-cache apply
    /// within the same settings lock. Generic and Arc Sleep settings writes
    /// cannot publish between the sidecar mutation and this operation's
    /// cache/disk update. The callback must not call back into this store.
    ///
    /// This is an internal prerequisite for native combined layout writes;
    /// renderer layout channels remain broker-owned. A settings persistence
    /// error still leaves a preceding sidecar mutation in place.
    pub(crate) fn with_overlay_layout_transaction<T>(
        &self,
        operation: impl FnOnce(&Value) -> Result<(T, Option<Value>), String>,
    ) -> Result<(T, Value), String> {
        let mut cache = self.cache_guard()?;
        if cache.is_none() { *cache = Some(self.read()?); }
        let current = cache.as_ref().cloned().ok_or("Settings cache must be an object")?;
        let (result, layout) = operation(&current)?;
        if let Some(layout) = layout {
            let settings = overlay_layout_settings(&current, &layout)?;
            self.write_locked(&mut cache, &settings, None)?;
        }
        let published = cache.as_ref().cloned().ok_or_else(|| "Settings cache was not published".to_owned())?;
        Ok((result, published))
    }
}

fn overlay_layout_settings(current: &Value, layout: &Value) -> Result<Value, String> {
    let layout = layout.as_object().ok_or("Overlay layout must be an object")?;
    let background = layout.get("background").and_then(Value::as_object)
        .ok_or("Overlay layout background must be an object")?;
    let mut settings = current.as_object().cloned().ok_or("Settings cache must be an object")?;
    for (setting, field) in [
        ("overlayPosition", "position"),
        ("overlayScale", "scale"),
        ("overlayTheme", "theme"),
        ("overlayStats", "stats"),
        ("overlayDeviceKeys", "deviceKeys"),
        ("advancedOverlayPosition", "advancedPosition"),
    ] {
        settings.insert(setting.into(), layout.get(field).cloned()
            .ok_or_else(|| format!("Overlay layout is missing {field}"))?);
    }
    settings.insert("overlayBgEnabled".into(), Value::Bool(background.get("enabled") == Some(&Value::Bool(true))));
    for (setting, field) in [("overlayBgColor", "color"), ("overlayBgOpacity", "opacity")] {
        settings.insert(setting.into(), background.get(field).cloned()
            .ok_or_else(|| format!("Overlay layout background is missing {field}"))?);
    }
    Ok(Value::Object(settings))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("arc-settings-store-{:032x}", rand::random::<u128>()));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn store(&self) -> SettingsStore { SettingsStore::new(Arc::new(SchemaStore::new(self.0.clone()).unwrap()), "stock") }
    }
    impl Drop for Fixture { fn drop(&mut self) {
        if self.0.parent() == Some(std::env::temp_dir().as_path()) { let _ = fs::remove_dir_all(&self.0); }
    } }

    #[test]
    fn cache_starts_empty_then_tracks_successful_persistence() {
        let fixture = Fixture::new(); let store = fixture.store();
        assert_eq!(store.load_settings_sync().unwrap(), None);
        assert_eq!(store.try_load_settings_sync(), None);
        let mut settings = store.load_settings().unwrap();
        assert_eq!(store.try_load_settings_sync().as_ref(), Some(&settings));
        settings["closeToTray"] = json!(true);
        store.save_settings(&settings).unwrap();
        assert_eq!(store.load_settings_sync().unwrap().unwrap()["closeToTray"], true);
        assert_eq!(fixture.store().load_settings().unwrap()["closeToTray"], true);
        let mut snapshot = store.load_settings_sync().unwrap().unwrap();
        snapshot["closeToTray"] = json!(false);
        assert_eq!(store.load_settings_sync().unwrap().unwrap()["closeToTray"], true);
    }

    #[test]
    fn later_generic_snapshot_cannot_erase_arc_sleep_journal() {
        let fixture = Fixture::new(); let store = fixture.store();
        let mut stale = store.load_settings().unwrap();
        store.save_arc_sleep_state(&json!({"arcSleepJournal":{"deviceKey":"gpu-a","before":90},"arcSleep":{"idleEnabled":true}})).unwrap();
        stale["theme"] = json!("midnight");
        store.save_settings(&stale).unwrap();
        let current = store.load_settings().unwrap();
        assert_eq!(current["theme"], "midnight");
        assert_eq!(current["arcSleep"]["idleEnabled"], true);
        assert_eq!(current["arcSleepJournal"]["deviceKey"], "gpu-a");
    }

    #[test]
    fn disk_failure_does_not_publish_failed_toggle_and_later_writes_work() {
        let fixture = Fixture::new(); let store = fixture.store();
        let original = store.load_settings().unwrap();
        let mut update = original.clone(); update["closeToTray"] = json!(true);
        let settings_path = fixture.0.join("settings.json");
        fs::write(&settings_path, br#"{"schemaVersion":999}"#).unwrap();
        assert!(store.save_settings(&update).is_err());
        assert_eq!(store.load_settings_sync().unwrap().unwrap(), original);
        assert_eq!(fs::read(&settings_path).unwrap(), br#"{"schemaVersion":999}"#);
        fs::remove_file(&settings_path).unwrap();
        store.save_settings(&update).unwrap();
        assert_eq!(store.load_settings_sync().unwrap().unwrap()["closeToTray"], true);
    }

    #[test]
    fn shared_store_serializes_arc_sleep_updates_without_lost_fields() {
        let fixture = Fixture::new(); let store = Arc::new(fixture.store());
        let a = { let store = store.clone(); std::thread::spawn(move || store.save_arc_sleep_state(&json!({"arcSleep":{"idleEnabled":true}})).unwrap()) };
        let b = { let store = store.clone(); std::thread::spawn(move || store.save_arc_sleep_state(&json!({"arcSleep":{"adaptiveEnabled":true}})).unwrap()) };
        a.join().unwrap(); b.join().unwrap();
        let current = store.load_settings().unwrap();
        assert_eq!(current["arcSleep"]["idleEnabled"], true);
        assert_eq!(current["arcSleep"]["adaptiveEnabled"], true);
    }

    #[test]
    fn overlay_layout_updates_one_snapshot_and_preserves_unrelated_settings() {
        let fixture = Fixture::new(); let store = fixture.store();
        let mut settings = store.load_settings().unwrap();
        settings["closeToTray"] = json!(true);
        store.save_settings(&settings).unwrap();
        let layout = json!({
            "position":"top-right", "scale":1.25, "theme":"classic",
            "stats":["fps"], "deviceKeys":["gpu-a"], "advancedPosition":"left",
            "background":{"enabled":true,"color":"#123456","opacity":0.75}
        });
        let saved = store.apply_overlay_layout(&layout).unwrap();
        assert_eq!(saved["overlayPosition"], "top-right");
        assert_eq!(saved["overlayScale"], 1.25);
        assert_eq!(saved["overlayStats"], json!(["fps"]));
        assert_eq!(saved["overlayBgEnabled"], true);
        assert_eq!(saved["overlayBgColor"], "#123456");
        assert_eq!(saved["advancedOverlayPosition"], "left");
        assert_eq!(saved["closeToTray"], true);
        assert_eq!(fixture.store().load_settings().unwrap(), saved);

        let mut invalid = layout;
        invalid.as_object_mut().unwrap().remove("advancedPosition");
        assert!(store.apply_overlay_layout(&invalid).is_err());
        assert_eq!(store.load_settings_sync().unwrap().unwrap(), saved);
        assert_eq!(fixture.store().load_settings().unwrap(), saved);
    }
}
