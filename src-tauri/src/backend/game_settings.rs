//! Native per-game settings save/delete. Persistence, RTSS ownership and the
//! IGCL per-application apply are all native; failures compensate runtime
//! state before returning.
use super::{
    game_candidate::validate_safe_game_candidate,
    game_profile_apply,
    game_profile_capabilities,
    game_profile_contract::{clean_graphics, merge_game_gpu_profile_patch, normalize_game_gpu_profile},
    gpu_devices,
    native_store::NativeStore,
    store_context::NativeStoreContext,
    wire,
};
use serde_json::{json, Map, Value};
use std::path::Path;

#[cfg(test)]
static TEST_DEVICES: std::sync::Mutex<Option<Value>> = std::sync::Mutex::new(None);

fn store_json(store: &NativeStore, method: &str, args: Value) -> Result<Value, String> {
    let encoded = wire::encode_json(&args)?;
    let reply = store.invoke(method, &encoded)?;
    let value = wire::decode(&reply)?.into_json()?;
    Ok(value.get("result").cloned().unwrap_or(value))
}

fn devices(dll_path: &Path) -> Result<Value, String> {
    #[cfg(test)]
    if let Some(devices) = TEST_DEVICES.lock().ok().and_then(|devices| devices.clone()) {
        return Ok(devices);
    }
    gpu_devices::list_devices(dll_path).map_err(|error| error.to_string())
}

fn target_of(devices: &Value, device_key: Option<&str>, persisted: &Value) -> Option<Value> {
    let rows = devices.as_array()?;
    if let Some(key) = device_key.filter(|key| !key.is_empty()) {
        let matches = rows.iter().filter(|device| {
            device["synthetic"] != json!(true)
                && device["backendKind"] != json!("os")
                && device["identityAmbiguous"] != json!(true)
                && (device["deviceKey"] == json!(key)
                    || device["deviceKeys"].as_array().is_some_and(|keys| keys.iter().any(|value| value == key)))
        }).cloned().collect::<Vec<_>>();
        return (matches.len() == 1).then(|| matches[0].clone());
    }
    let id = persisted["deviceId"].as_u64()?;
    rows.iter().find(|device| {
        device["id"].as_u64() == Some(id)
            && device["synthetic"] != json!(true)
            && device["backendKind"] != json!("os")
            && device["identityAmbiguous"] != json!(true)
    }).cloned()
}

fn profile_targets_device(profile: &Value, target_key: Option<&str>, target: Option<&Value>) -> bool {
    let key = profile["deviceKey"].as_str().filter(|key| !key.is_empty());
    let Some(key) = key else { return true; };
    if Some(key) == target_key { return true; }
    let target = target.unwrap_or(&Value::Null);
    target["deviceKey"].as_str() == Some(key)
        || target["deviceKeys"].as_array().is_some_and(|keys| keys.iter().any(|value| value == key))
}

fn rtss_apply(store: &NativeStore, request: Value) -> Result<Value, String> {
    store_json(store, "rtss-frame-limit-apply", json!([request]))
}

fn rtss_restore(store: &NativeStore, token: &Value) -> Result<Value, String> {
    store_json(store, "rtss-frame-limit-restore", json!([token]))
}

fn graphics_without_frame_limit(graphics: &Value) -> Value {
    let mut map = graphics.as_object().cloned().unwrap_or_default();
    map.remove("frameLimit");
    Value::Object(map)
}

fn apply_driver(dll_path: &Path, target_id: u64, exe_path: &str, graphics: &Value, enabled: bool) -> Result<Value, String> {
    game_profile_apply::apply(dll_path, target_id, exe_path, graphics, enabled)
}

fn merge_apply_result(result: &mut Value, extra: Value) {
    if let Some(controls) = extra.get("perControl").and_then(Value::as_object) {
        if result["perControl"].as_object().is_none() { result["perControl"] = json!({}); }
        for (key, value) in controls { result["perControl"][key] = value.clone(); }
    }
}

fn apply_unsupported(graphics: &Value, extra: Value) -> Value {
    let mut map = Map::new();
    for key in graphics.as_object().into_iter().flat_map(|object| object.keys()) {
        map.insert(key.clone(), json!({"ok":false,"errorCode":"unsupported","message":"the selected graphics adapter cannot apply per-game driver settings"}));
    }
    let mut result = json!({"ok": false, "skipped": true, "perControl": map, "message": "the selected graphics adapter cannot apply all per-game driver settings"});
    merge_apply_result(&mut result, extra);
    result
}

pub fn save(store: &NativeStore, dll_path: &Path, payload: &Value) -> Result<Value, String> {
    let object = payload.as_object().ok_or("game-settings-save: payload must be an object")?;
    if let Some(graphics) = object.get("graphics") {
        if !graphics.is_object() { return Err("game-settings-save: graphics must be an object".into()); }
        if let Some(sharpening) = graphics.get("sharpening") {
            if !sharpening.is_object()
                || sharpening.as_object().is_some_and(|sharpening| sharpening.keys().any(|key| key != "enabled" && key != "percentage"))
                || sharpening.get("enabled").and_then(Value::as_bool).is_none()
                || sharpening.get("percentage").and_then(Value::as_u64).filter(|value| *value <= 100).is_none() {
                return Err("game-settings-save: sharpening must be { enabled: boolean, percentage: integer 0-100 }".into());
            }
        }
    }
    if object.contains_key("gpuProfiles") { return Err("game-settings-save: save one GPU assignment at a time".into()); }
    for key in ["deviceKey", "deviceName"] {
        if let Some(value) = object.get(key).filter(|value| !value.is_null()) {
            if !value.as_str().is_some_and(|value| !value.trim().is_empty() && value.len() <= 256) {
                return Err(format!("game-settings-save: {key} must be a non-empty stable GPU key or null"));
            }
        }
    }
    let ctx = NativeStoreContext::new()?;
    let clean = clean_graphics(&object.get("graphics").cloned().unwrap_or(Value::Null));
    let current_exe = std::env::current_exe().ok().map(|path| json!(path.to_string_lossy())).unwrap_or(Value::Null);
    let exe_path = super::game_candidate::canonical_exe_path(object.get("exePath").unwrap_or(&Value::Null))
        .ok_or("game-settings-save: exePath must be an absolute Windows path")?;
    let exe = validate_safe_game_candidate(&json!(exe_path), &current_exe, &[], true)
        .ok_or("game-settings-save: executable is not a safe existing game candidate")?;
    let catalog = store_json(store, "game-load-catalog", json!([]))?;
    if !catalog["catalog"].as_array().is_some_and(|entries| entries.iter().any(|entry| entry["exePath"].as_str() == Some(exe.as_str()))) {
        return Err("game-settings-save: executable is not present in the game catalog".into());
    }
    let persisted = store_json(store, "load-settings", json!([]))?;
    let previous = catalog["settings"].as_array().and_then(|items| items.iter().find(|item| item["exePath"].as_str() == Some(exe.as_str()))).cloned().unwrap_or(Value::Null);
    let target_key = object.get("deviceKey").and_then(Value::as_str).map(str::trim).filter(|key| !key.is_empty());
    let previous_assignment = previous["gpuProfiles"].as_array()
        .and_then(|items| items.iter().find(|item| item["deviceKey"].as_str() == target_key)).cloned().unwrap_or(Value::Null);
    let mut patch = payload.clone();
    patch["exePath"] = json!(exe);
    patch["deviceKey"] = target_key.map(|key| json!(key)).unwrap_or(Value::Null);
    patch["graphics"] = clean.clone();
    let assignment = merge_game_gpu_profile_patch(&previous_assignment, &patch, &ctx)
        .ok_or("game-settings-save: invalid GPU assignment")?;
    let found = devices(dll_path).unwrap_or_else(|_| json!([]));
    let target = target_of(&found, target_key, &persisted);
    let target_id = target.as_ref().and_then(|target| target["id"].as_u64());
    if let Some(profile_id) = assignment["tuningProfileId"].as_str().filter(|value| !value.is_empty()) {
        let profiles = store_json(store, "load-profiles", json!([]))?;
        let profile = profiles.as_array().and_then(|items| items.iter().find(|profile| profile["id"].as_str() == Some(profile_id)))
            .ok_or("game-settings-save: tuning profile was not found")?;
        if !profile_targets_device(profile, target_key, target.as_ref()) {
            return Err("game-settings-save: tuning profile belongs to another GPU".into());
        }
    }
    let enabled = assignment["enabled"] == json!(true);
    let mut graphics = assignment["graphics"].clone();
    let mut xe_fg_refusal = Value::Null;
    if graphics.get("frameGenOverride").is_some_and(|value| !value.is_null()) {
        let capabilities = target_id.and_then(|id| game_profile_capabilities::capabilities(dll_path, id, Some(&exe)).ok());
        if capabilities.as_ref().is_none_or(|caps| caps["xeFg"] != json!(true)) {
            if let Some(map) = graphics.as_object_mut() { map.remove("frameGenOverride"); }
            if enabled {
                xe_fg_refusal = json!({"ok":false,"errorCode":"unsupported","message": capabilities.as_ref().and_then(|caps| caps["xeFgReason"].as_str()).unwrap_or("XeFG is unavailable for this executable.")});
            }
        }
    }
    let mut final_assignment = assignment.clone();
    final_assignment["graphics"] = graphics.clone();
    let final_assignment = normalize_game_gpu_profile(&final_assignment, &ctx).ok_or("game-settings-save: invalid GPU assignment")?;
    let frame_limit = graphics.get("frameLimit").filter(|value| value.is_object()).cloned();
    let previous_frame_limit_enabled = previous_assignment["graphics"]["frameLimit"]["enabled"] == json!(true);
    let mut rtss_handled = false;
    let mut rtss_result = Value::Null;
    if let Some(frame_limit) = &frame_limit {
        let effective_limit_enabled = enabled && frame_limit["enabled"] == json!(true);
        let request = json!({
            "enabled": effective_limit_enabled,
            "value": frame_limit["value"],
            "executablePath": exe,
            "removeProfile": previous_frame_limit_enabled && !effective_limit_enabled,
        });
        rtss_result = rtss_apply(store, request)?;
        if rtss_result["cleanupPending"] == json!(true) {
            let message = rtss_result["cleanupError"].as_str().or_else(|| rtss_result["error"].as_str()).unwrap_or("RTSS cleanup could not be verified");
            return Ok(json!({
                "settings": previous,
                "apply": {"ok": false, "cleanupPending": true,
                    "perControl": {"frameLimit": {"ok": false, "errorCode": "cleanup-pending", "message": message}},
                    "message": format!("RTSS frame-limit cleanup failed: {message}")},
            }));
        }
        rtss_handled = rtss_result["ok"] == json!(true) && rtss_result["used"] == json!(true);
    }
    let driver_graphics = if rtss_handled { graphics_without_frame_limit(&graphics) } else { graphics.clone() };
    let reset_driver_scope = !enabled;
    let requires_driver = driver_graphics.as_object().is_some_and(|map| !map.is_empty()) || reset_driver_scope;
    let rtss_extra = json!({"perControl": if rtss_handled { json!({"frameLimit":{"ok":true,"source":"rtss"}}) } else { json!({}) }});
    let mut driver_attempted = false;
    let mut apply = if !requires_driver {
        let mut result = json!({"ok": true, "perControl": {}});
        merge_apply_result(&mut result, rtss_extra);
        result
    } else if let Some(target_id) = target_id {
        driver_attempted = true;
        let mut result = match apply_driver(dll_path, target_id, &exe, &driver_graphics, enabled) {
            Ok(result) => result,
            Err(error) => json!({"ok": false, "perControl": {}, "message": error}),
        };
        merge_apply_result(&mut result, rtss_extra);
        result
    } else {
        apply_unsupported(&driver_graphics, rtss_extra)
    };
    if xe_fg_refusal != Value::Null {
        apply["ok"] = json!(false);
        apply["perControl"]["frameGenOverride"] = xe_fg_refusal;
    }
    let mut previous_graphics = previous_assignment["graphics"].clone();
    if rtss_handled { previous_graphics = graphics_without_frame_limit(&previous_graphics); }
    if apply["ok"] != json!(true) {
        let mut rollback_errors = Vec::new();
        if driver_attempted {
            if let Some(target_id) = target_id {
                if apply_driver(dll_path, target_id, &exe, &previous_graphics, previous_assignment["enabled"] == json!(true)).is_err() {
                    rollback_errors.push("native rollback was not applied".to_owned());
                }
            }
        }
        if rtss_handled && rtss_result["restoreToken"] != Value::Null {
            if let Err(error) = rtss_restore(store, &rtss_result["restoreToken"]) { rollback_errors.push(format!("RTSS rollback failed: {error}")); }
        }
        if !rollback_errors.is_empty() {
            apply["cleanupPending"] = json!(true);
            apply["message"] = json!(format!("{} runtime cleanup was not applied.", rollback_errors.join(" ")));
        }
        return Ok(json!({"settings": previous, "apply": apply}));
    }
    let save_payload = json!({"exePath": exe, "gpuProfiles": [final_assignment]});
    match store_json(store, "game-save-settings", json!([save_payload])) {
        Ok(settings) => Ok(json!({"settings": settings, "apply": apply})),
        Err(error) => {
            let mut cleanup = Vec::new();
            if driver_attempted {
                if let Some(target_id) = target_id {
                    if apply_driver(dll_path, target_id, &exe, &previous_graphics, previous_assignment["enabled"] == json!(true)).is_err() { cleanup.push("native rollback was not applied"); }
                }
            }
            if rtss_handled && rtss_result["restoreToken"] != Value::Null && rtss_restore(store, &rtss_result["restoreToken"]).is_err() { cleanup.push("RTSS rollback was not applied"); }
            Err(format!("game-settings-save: profile persistence failed ({error}). {}", if cleanup.is_empty() { "Runtime changes were rolled back." } else { "Runtime cleanup is still pending." }))
        }
    }
}

pub fn delete(store: &NativeStore, dll_path: &Path, payload: &Value) -> Result<Value, String> {
    let object = payload.as_object().ok_or("game-settings-delete: payload must be an object")?;
    let exe = super::game_candidate::canonical_exe_path(object.get("exePath").unwrap_or(&Value::Null))
        .ok_or("game-settings-delete: exePath must be an absolute Windows path")?;
    let catalog = store_json(store, "game-load-catalog", json!([]))?;
    let existing = catalog["settings"].as_array().and_then(|items| items.iter().find(|item| item["exePath"].as_str() == Some(exe.as_str()))).cloned().unwrap_or(Value::Null);
    let assignments = existing["gpuProfiles"].as_array().cloned().unwrap_or_default();
    let persisted = store_json(store, "load-settings", json!([]))?;
    let found = devices(dll_path)?;
    let mut cleared = std::collections::HashSet::new();
    let mut attempted: Vec<(Value, Value)> = Vec::new();
    let compensate = |attempted: &[(Value, Value)]| {
        let mut error = None;
        for (target, assignment) in attempted.iter().rev() {
            if let Some(id) = target["id"].as_u64() {
                if apply_driver(dll_path, id, &exe, &assignment["graphics"].clone(), assignment["enabled"] == json!(true)).is_err() {
                    error = Some("native rollback was not applied".to_owned());
                }
            }
        }
        error
    };
    for assignment in &assignments {
        let target_key = assignment["deviceKey"].as_str().filter(|key| !key.is_empty());
        let target = target_of(&found, target_key, &persisted);
        let Some(target) = target else {
            let error = compensate(&attempted);
            return Err(format!("game-settings-delete: cannot resolve the configured GPU for {}{}", target_key.unwrap_or("the legacy assignment"), error.map(|e| format!(" Runtime cleanup is still pending: {e}")).unwrap_or_default()));
        };
        let identity = target["deviceKey"].as_str().map(str::to_owned)
            .or_else(|| target["id"].as_u64().map(|id| format!("id:{id}"))).unwrap_or_default();
        if !cleared.insert(identity) { continue; }
        attempted.push((target.clone(), assignment.clone()));
        if let Some(id) = target["id"].as_u64() {
            let applied = apply_driver(dll_path, id, &exe, &json!({}), false)
                .unwrap_or_else(|error| json!({"ok": false, "message": error}));
            if applied["ok"] != json!(true) {
                let error = compensate(&attempted);
                return Err(format!("game-settings-delete: native cleanup failed for {}{}", target["deviceKey"].as_str().unwrap_or("the selected GPU"), error.map(|e| format!(" Runtime cleanup is still pending: {e}")).unwrap_or_default()));
            }
        }
    }
    let had_frame_limit = assignments.iter().any(|assignment| assignment["graphics"]["frameLimit"]["enabled"] == json!(true));
    if had_frame_limit {
        let rtss_result = rtss_apply(store, json!({"enabled": false, "executablePath": exe, "removeProfile": true}))?;
        if rtss_result["ok"] != json!(true) || rtss_result["used"] != json!(true)
            || rtss_result["removed"] != json!(true)
            || (rtss_result["flagRestored"] != json!(true) && rtss_result["flagRestorationDeferred"] != json!(true)) {
            let error = compensate(&attempted);
            return Err(format!("game-settings-delete: RTSS cleanup failed: {}{}", rtss_result["error"].as_str().unwrap_or("profile removal was not verified"), error.map(|e| format!(" Runtime cleanup is still pending: {e}")).unwrap_or_default()));
        }
    }
    match store_json(store, "game-delete-settings", json!([exe])) {
        Ok(result) => Ok(result),
        Err(error) => {
            let native = compensate(&attempted);
            if had_frame_limit {
                if let Some(assignment) = assignments.iter().find(|assignment| assignment["graphics"]["frameLimit"]["enabled"] == json!(true)) {
                    let _ = rtss_apply(store, json!({"enabled": true, "value": assignment["graphics"]["frameLimit"]["value"], "executablePath": exe}));
                }
            }
            if !existing.is_null() { let _ = store_json(store, "game-save-settings", json!([existing])); }
            Err(format!("game-settings-delete: persistence failed ({error}).{}", native.map(|e| format!(" Runtime cleanup is still pending: {e}")).unwrap_or_else(|| " Runtime and sidecar state were restored.".into())))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn fixture() -> (std::path::PathBuf, NativeStore, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("arc-game-settings-{:032x}", rand::random::<u128>()));
        std::fs::create_dir(&root).unwrap();
        let store = NativeStore::new(root.clone(), "advanced").unwrap();
        let game_dir = root.join("steamapps").join("common").join("Fixture Game");
        std::fs::create_dir_all(&game_dir).unwrap();
        let exe = game_dir.join("Cyberpunk2077.exe");
        std::fs::write(&exe, b"fixture only").unwrap();
        let entries = json!([{"exePath": exe.to_string_lossy(), "displayName": "Cyberpunk 2077", "processName": "Cyberpunk2077.exe", "source": "scan"}]);
        store.invoke("game-sync-catalog", &wire::encode_json(&json!([entries, {"authoritative": true}])).unwrap()).unwrap();
        *TEST_DEVICES.lock().unwrap() = Some(json!([{"id": 0, "deviceKey": "gpu-a", "deviceKeys": ["gpu-a"]}]));
        (root, store, exe)
    }

    #[test]
    fn native_save_and_delete_use_the_fake_driver_seam() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (root, store, exe) = fixture();
        game_profile_apply::TEST_APPLY.lock().unwrap().push(json!({"ok": true, "perControl": {}}));
        game_profile_apply::TEST_APPLY.lock().unwrap().push(json!({"ok": true, "perControl": {}}));
        let saved = save(&store, Path::new("unused"), &json!({
            "exePath": exe.to_string_lossy(), "deviceKey": "gpu-a",
            "enabled": true, "graphics": {"lowLatency": "on"},
        })).unwrap();
        assert_eq!(saved["apply"]["ok"], true);
        let settings = &saved["settings"];
        assert_eq!(settings["gpuProfiles"][0]["deviceKey"], "gpu-a");
        assert_eq!(settings["gpuProfiles"][0]["graphics"]["lowLatency"], "on");
        let deleted = delete(&store, Path::new("unused"), &json!({"exePath": exe.to_string_lossy()})).unwrap();
        assert!(deleted["settings"].as_array().is_none() || deleted["settings"].as_array().is_some_and(|items| items.is_empty()));
        *TEST_DEVICES.lock().unwrap() = None;
        game_profile_apply::TEST_APPLY.lock().unwrap().clear();
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn native_save_rejects_missing_catalog_or_invalid_sharpening() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (root, store, exe) = fixture();
        let missing = root.join("steamapps").join("common").join("Missing.exe");
        assert!(save(&store, Path::new("unused"), &json!({"exePath": missing.to_string_lossy()})).is_err());
        assert!(save(&store, Path::new("unused"), &json!({
            "exePath": exe.to_string_lossy(),
            "graphics": {"sharpening": {"enabled": true, "percentage": 101}},
        })).is_err());
        *TEST_DEVICES.lock().unwrap() = None;
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "approved live low-risk per-game write; uses a temporary sidecar and preserves the real catalog"]
    fn live_low_risk_save_and_delete() {
        let _guard = TEST_LOCK.lock().unwrap();
        game_profile_apply::TEST_APPLY.lock().unwrap().clear();
        let (root, store, _fixture_exe) = fixture();
        *TEST_DEVICES.lock().unwrap() = None;
        let exe = std::env::var("ARC_POWER_TEST_GAME_EXE").map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::path::PathBuf::from(r"D:\SteamLibrary\steamapps\common\Punishing Gray Raven\PGR.exe"));
        assert!(exe.is_file(), "approved live game executable is missing: {}", exe.display());
        let entries = json!([{"exePath": exe.to_string_lossy(), "displayName": "Punishing: Gray Raven", "processName": "PGR.exe", "source": "scan"}]);
        store.invoke("game-sync-catalog", &wire::encode_json(&json!([entries, {"authoritative": false}])).unwrap()).unwrap();
        let dll = crate::backend::gpu_devices::locate_dll().expect("IntelControlLib.dll");
        let found = devices(&dll).expect("devices");
        let device_key = found.as_array().and_then(|items| items.first())
            .and_then(|device| device["deviceKey"].as_str()).expect("physical device key").to_owned();
        let saved = save(&store, &dll, &json!({
            "exePath": exe.to_string_lossy(), "deviceKey": device_key,
            "enabled": true, "graphics": {"lowLatency": "off"},
        })).expect("live save");
        eprintln!("live per-game save: {}", serde_json::to_string(&saved).unwrap());
        assert_eq!(saved["apply"]["ok"], true, "{saved}");
        assert_eq!(saved["apply"]["perControl"]["lowLatency"]["ok"], true, "{saved}");
        let deleted = delete(&store, &dll, &json!({"exePath": exe.to_string_lossy()})).expect("live delete");
        assert!(deleted["settings"].as_array().is_none_or(|items| items.is_empty()), "{deleted}");
        let catalog = store.invoke("game-load-catalog", &wire::encode_json(&json!([])).unwrap()).unwrap();
        let catalog = wire::decode(&catalog).unwrap().into_json().unwrap();
        assert!(catalog["settings"].as_array().is_none_or(|items| items.is_empty()), "{catalog}");
        let _ = std::fs::remove_dir_all(root);
    }
}

