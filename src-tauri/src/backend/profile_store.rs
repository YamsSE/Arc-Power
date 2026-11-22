//! Profile persistence and physical-GPU identity helpers.
use super::{migrations::SCHEMA_VERSION, store_file::{SchemaStore, StoreFile}};
use serde_json::{json, Map, Value};
use std::{collections::{HashMap, HashSet}, sync::Arc};

fn js_entries(map: &Map<String,Value>) -> Vec<(&String,&Value)> {
    fn array_index(key:&str)->Option<u32> {
        let index=key.parse::<u32>().ok()?;
        (index != u32::MAX && index.to_string() == key).then_some(index)
    }
    let mut indexed:Vec<_>=map.iter().filter_map(|entry|array_index(entry.0).map(|index|(index,entry))).collect();
    indexed.sort_by_key(|(index,_)|*index);
    indexed.into_iter().map(|(_,entry)|entry).chain(map.iter().filter(|(key,_)|array_index(key).is_none())).collect()
}

pub fn normalize_profile_gpu_key(value: &Value) -> Option<String> {
    value.as_str().filter(|s| { let len = s.encode_utf16().count(); len > 0 && len <= 256 }).map(str::to_owned)
}

/// ECMAScript WhiteSpace + LineTerminator; Rust trim additionally removes
/// U+0085 and omits BOM, so callers spell this set out rather than using
/// str::trim.
pub(crate) fn is_js_whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
}

pub(crate) fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

pub fn normalize_profile_gpu_label(value: &Value) -> Option<String> {
    value.as_str().filter(|s| !js_trim(s).is_empty() && s.encode_utf16().count() <= 256).map(|s|js_trim(s).to_owned())
}

pub fn normalize_active_profile_ids(value: &Value) -> Value {
    let mut out=Map::new();
    if let Some(map)=value.as_object() {
        for (key,id) in js_entries(map) {
            if key == "__proto__" { continue; }
            if normalize_profile_gpu_key(&json!(key)).is_some()
                && normalize_profile_gpu_key(id).is_some() { out.insert(key.clone(),id.clone()); }
        }
    }
    Value::Object(out)
}

pub fn normalize_oc_modes(value: &Value) -> Value {
    let mut out=Map::new();
    if let Some(map)=value.as_object() {
        for (key,mode) in js_entries(map) {
            if key == "__proto__" { continue; }
            if normalize_profile_gpu_key(&json!(key)).is_some()
                && matches!(mode.as_str(),Some("stock" | "advanced")) { out.insert(key.clone(),mode.clone()); }
        }
    }
    Value::Object(out)
}

pub fn active_profile_entries(settings: &Value, profiles: &[Value]) -> Vec<Value> {
    // Map construction in JS keeps the last profile with a duplicate id.
    let by_id:HashMap<&str,&Value> = profiles.iter().filter_map(|p|Some((p.get("id")?.as_str()?,p))).collect();
    let mut out=Vec::new(); let mut seen=HashSet::new(); let mut seen_keys=HashSet::new();
    let active=normalize_active_profile_ids(settings.get("activeProfileIds").unwrap_or(&Value::Null));
    for (device_key,profile_id) in js_entries(active.as_object().expect("normalized object")) {
        let id=profile_id.as_str().expect("normalized id");
        let Some(profile)=by_id.get(id) else { continue; };
        if seen.contains(id) { continue; }
        let profile_key=normalize_profile_gpu_key(profile.get("deviceKey").unwrap_or(&Value::Null));
        if profile_key.as_ref().is_some_and(|key|key != device_key) { continue; }
        let effective=profile_key.unwrap_or_else(||device_key.clone());
        if seen_keys.contains(&effective) { continue; }
        seen.insert(id.to_owned()); seen_keys.insert(effective.clone());
        out.push(json!({"profileId":id,"deviceKey":effective,"profile":profile}));
    }
    let legacy_id=settings.get("activeProfileId").and_then(Value::as_str).filter(|s|!s.is_empty());
    if let Some((id,profile))=legacy_id.and_then(|id|by_id.get(id).map(|profile|(id,*profile))) {
        if !seen.contains(id) {
            let key=normalize_profile_gpu_key(profile.get("deviceKey").unwrap_or(&Value::Null));
            if key.as_ref().is_some_and(|k|seen_keys.contains(k)) { return out; }
            out.push(json!({"profileId":id,"deviceKey":key,"profile":profile}));
        }
    }
    out
}

fn profiles_of(data: Option<&Value>) -> Result<Vec<Value>,String> {
    match data {
        None => Ok(Vec::new()),
        Some(data) => data.get("profiles").and_then(Value::as_array).cloned()
            .ok_or_else(||"profiles.json is missing the \"profiles\" array".into()),
    }
}

pub struct ProfileStore { store:Arc<SchemaStore> }

impl ProfileStore {
    pub fn new(store:Arc<SchemaStore>) -> Self { Self { store } }

    pub fn load_profiles(&self) -> Result<Vec<Value>,String> {
        profiles_of(self.store.load(StoreFile::Profiles)?.as_ref())
    }

    pub fn save_profiles(&self,profiles:&[Value]) -> Result<(),String> {
        self.store.save(StoreFile::Profiles,&json!({"schemaVersion":SCHEMA_VERSION,"profiles":profiles}))?;
        Ok(())
    }

    pub fn save_profile(&self,profile:&Value) -> Result<(),String> {
        let incoming=profile.as_object().ok_or("Profile must be an object")?;
        self.store.transaction(StoreFile::Profiles,|current| {
            let mut profiles=profiles_of(current.as_ref())?;
            if profiles.iter().any(Value::is_null) { return Err("Cannot read the id of a null profile".into()); }
            let index=profiles.iter().position(|p|p.get("id") == profile.get("id"));
            let existing=index.map(|i|&profiles[i]);
            // Like {...profile}, preserve every incoming extension field. Only
            // the durable GPU identity/name fall back to the previous profile.
            let mut normalized=incoming.clone();
            normalized.insert("schemaVersion".into(),json!(SCHEMA_VERSION));
            for (field,label) in [("deviceKey",false),("deviceName",true)] {
                let prior=existing.and_then(|p|p.get(field));
                if incoming.contains_key(field) || prior.is_some() {
                    let value=incoming.get(field).filter(|v|!v.is_null()).or(prior).unwrap_or(&Value::Null);
                    let value=if label {normalize_profile_gpu_label(value)} else {normalize_profile_gpu_key(value)};
                    normalized.insert(field.into(),value.map(Value::String).unwrap_or(Value::Null));
                }
            }
            if let Some(index)=index { profiles[index]=Value::Object(normalized); }
            else { profiles.push(Value::Object(normalized)); }
            Ok(json!({"schemaVersion":SCHEMA_VERSION,"profiles":profiles}))
        })?;
        Ok(())
    }

    pub fn delete_profile(&self,id:&str) -> Result<bool,String> {
        // Preserve JS loadProfiles' one-time migration even on a missing-id no-op.
        self.load_profiles()?;
        const NO_CHANGE:&str="profile-store:no-profile-deleted";
        match self.store.transaction(StoreFile::Profiles,|current| {
            let profiles=profiles_of(current.as_ref())?;
            if profiles.iter().any(Value::is_null) { return Err("Cannot read the id of a null profile".into()); }
            let next:Vec<_>=profiles.iter().filter(|p|p.get("id").and_then(Value::as_str) != Some(id)).cloned().collect();
            if next.len() == profiles.len() { return Err(NO_CHANGE.into()); }
            Ok(json!({"schemaVersion":SCHEMA_VERSION,"profiles":next}))
        }) {
            Ok(_)=>Ok(true), Err(e) if e == NO_CHANGE=>Ok(false), Err(e)=>Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs,path::PathBuf};
    struct Temp(PathBuf);
    impl Temp {
        fn new()->Self {
            let path=std::env::temp_dir().join(format!("arc-profile-test-{:032x}",rand::random::<u128>()));
            fs::create_dir(&path).unwrap(); Self(path)
        }
        fn store(&self)->ProfileStore { ProfileStore::new(Arc::new(SchemaStore::new(self.0.clone()).unwrap())) }
    }
    impl Drop for Temp { fn drop(&mut self) {let _=fs::remove_dir_all(&self.0);} }

    #[test]
    fn identity_normalization_matches_js_length_trim_and_null_semantics() {
        assert_eq!(normalize_profile_gpu_key(&json!(" ")),Some(" ".into()));
        assert_eq!(normalize_profile_gpu_label(&json!("\u{feff} GPU A \u{00a0}")),Some("GPU A".into()));
        assert_eq!(normalize_profile_gpu_label(&json!("\u{0085}")),Some("\u{0085}".into()));
        assert!(normalize_profile_gpu_key(&json!("😀".repeat(129))).is_none());
        assert!(normalize_profile_gpu_label(&json!(" ".repeat(257)+"x")).is_none());
        for value in [Value::Null,json!(0),json!(""),json!([])] { assert!(normalize_profile_gpu_key(&value).is_none()); }
        assert_eq!(normalize_active_profile_ids(&json!({"gpu-a":"p1","":"p2","gpu-b":"","gpu-c":true})),json!({"gpu-a":"p1"}));
        assert_eq!(normalize_oc_modes(&json!({"gpu-a":"stock","gpu-b":"advanced","gpu-c":"bad","":"stock"})),json!({"gpu-a":"stock","gpu-b":"advanced"}));
        let malformed:Value=serde_json::from_str(r#"{"__proto__":"p1"}"#).unwrap();
        assert_eq!(normalize_active_profile_ids(&malformed),json!({}));
        assert!(active_profile_entries(&json!({"activeProfileIds":malformed}), &[json!({"id":"p1"})]).is_empty());
        let malformed:Value=serde_json::from_str(r#"{"__proto__":"advanced"}"#).unwrap();
        assert_eq!(normalize_oc_modes(&malformed),json!({}));
    }

    #[test]
    fn profiles_round_trip_unknown_fields_and_per_gpu_identity_without_mutation() {
        let temp=Temp::new(); let store=temp.store();
        assert_eq!(store.load_profiles().unwrap(),Vec::<Value>::new());
        let original=json!({"id":"p1","deviceKey":"gpu-a","deviceName":" GPU A ","extension":{"x":1},"settings":{"powerLimitW":200}});
        store.save_profile(&original).unwrap();
        store.save_profile(&json!({"id":"p2","deviceKey":"gpu-b","deviceName":"GPU B"})).unwrap();
        assert!(original.get("schemaVersion").is_none());
        let profiles=store.load_profiles().unwrap();
        assert_eq!(profiles.len(),2);
        assert_eq!(profiles[0]["extension"],json!({"x":1}));
        assert_eq!(profiles[0]["schemaVersion"],json!(3));
        assert_eq!(profiles[0]["deviceName"],json!("GPU A"));
        assert_eq!(profiles[1]["deviceKey"],json!("gpu-b"));
    }

    #[test]
    fn update_nullish_identity_falls_back_but_invalid_explicit_identity_becomes_null() {
        let temp=Temp::new(); let store=temp.store();
        store.save_profile(&json!({"id":"p1","deviceKey":"gpu-a","deviceName":"GPU A","old":true})).unwrap();
        store.save_profile(&json!({"id":"p1","deviceKey":null,"new":7})).unwrap();
        let updated=store.load_profiles().unwrap().remove(0);
        assert_eq!(updated,json!({"id":"p1","deviceKey":"gpu-a","deviceName":"GPU A","new":7,"schemaVersion":3}));
        store.save_profile(&json!({"id":"p1","deviceKey":"","deviceName":false})).unwrap();
        let updated=store.load_profiles().unwrap().remove(0);
        assert_eq!(updated["deviceKey"],Value::Null); assert_eq!(updated["deviceName"],Value::Null);
        store.save_profile(&json!({"id":"legacy"})).unwrap();
        let legacy=store.load_profiles().unwrap().remove(1);
        assert!(legacy.get("deviceKey").is_none()); assert!(legacy.get("deviceName").is_none());
    }

    #[test]
    fn delete_missing_does_not_create_file_and_delete_removes_all_duplicate_ids() {
        let temp=Temp::new(); let store=temp.store();
        assert!(!store.delete_profile("missing").unwrap());
        assert!(!temp.0.join("profiles.json").exists());
        store.save_profiles(&[json!({"id":"p1"}),json!({"id":"p2"}),json!({"id":"p1"})]).unwrap();
        let before=fs::read(temp.0.join("profiles.json")).unwrap();
        assert!(!store.delete_profile("missing").unwrap());
        assert_eq!(fs::read(temp.0.join("profiles.json")).unwrap(),before);
        assert!(store.delete_profile("p1").unwrap());
        assert_eq!(store.load_profiles().unwrap(),vec![json!({"id":"p2"})]);
    }

    #[test]
    fn corrupt_newer_and_missing_array_are_refused_without_overwrite() {
        let temp=Temp::new(); let store=temp.store(); let path=temp.0.join("profiles.json");
        for bytes in [b"corrupt".as_slice(),br#"{"schemaVersion":4,"profiles":[]}"#.as_slice(),br#"{"schemaVersion":3,"profiles":{}}"#.as_slice()] {
            fs::write(&path,bytes).unwrap();
            assert!(store.load_profiles().is_err());
            assert!(store.save_profile(&json!({"id":"p"})).is_err());
            assert!(store.delete_profile("p").is_err());
            assert_eq!(fs::read(&path).unwrap(),bytes);
        }
    }

    #[test]
    fn active_profiles_keep_physical_targets_skip_mismatches_and_deduplicate() {
        let profiles=vec![json!({"id":"a","deviceKey":"gpu-a"}),json!({"id":"b","deviceKey":"gpu-b"}),json!({"id":"legacy"}),json!({"id":"same","deviceKey":"gpu-a"})];
        let settings=json!({"activeProfileIds":{"gpu-a":"a","gpu-b":"b","gpu-wrong":"a","gpu-z":"legacy"},"activeProfileId":"same"});
        let entries=active_profile_entries(&settings,&profiles);
        assert_eq!(entries.iter().map(|v|v["profileId"].as_str().unwrap()).collect::<Vec<_>>(),vec!["a","b","legacy"]);
        assert_eq!(entries[2]["deviceKey"],json!("gpu-z"));
        assert!(active_profile_entries(&json!({"activeProfileIds":{"gpu-x":"a"}}),&profiles).is_empty());
        assert_eq!(active_profile_entries(&json!({"activeProfileId":"legacy"}),&profiles)[0]["deviceKey"],Value::Null);
        let duplicate=vec![json!({"id":"a","deviceKey":"wrong"}),json!({"id":"a","deviceKey":"gpu-a","latest":true})];
        assert_eq!(active_profile_entries(&json!({"activeProfileId":"a"}),&duplicate)[0]["profile"]["latest"],json!(true));
    }

    #[test]
    fn active_map_uses_js_numeric_keys_then_insertion_order_for_legacy_claims() {
        // serde_json's preserve_order feature is required to retain this source order.
        let settings:Value=serde_json::from_str(r#"{"activeProfileIds":{"z":"legacy","a":"legacy","10":"ten","2":"two"}}"#).unwrap();
        let profiles=vec![json!({"id":"legacy"}),json!({"id":"ten"}),json!({"id":"two"})];
        let entries=active_profile_entries(&settings,&profiles);
        assert_eq!(entries.iter().map(|v|v["deviceKey"].as_str().unwrap()).collect::<Vec<_>>(),vec!["2","10","z"]);
    }
}
