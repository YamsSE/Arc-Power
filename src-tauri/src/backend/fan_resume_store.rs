//! FanResume.json persistence only. Enabling restore still requires the
//! controller's current physical GPU proof and does not happen in this store.
use super::{arc_sleep_policy::js_trim, sidecar_file::{Sidecar, SidecarFile}};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

fn finite_percent(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| value.as_f64().is_some_and(|n| n.is_finite() && (0.0..=100.0).contains(&n)))
}

fn fan_settings(settings: &Value, strict: bool) -> Result<Value, String> {
    let settings = settings.as_object().ok_or("fan-resume: invalid settings")?;
    if strict && settings.keys().any(|key| !["fanMode", "fanCurve", "fixedFanPct"].contains(&key.as_str())) {
        return Err("fan-resume: fan-only settings required".into());
    }
    let mode = settings.get("fanMode").and_then(Value::as_str).filter(|mode| ["auto", "curve", "fixed"].contains(mode))
        .ok_or("fan-resume: invalid fan mode")?;
    let mut out = json!({"fanMode":mode});
    if mode == "curve" {
        let points = settings.get("fanCurve").and_then(Value::as_array).filter(|p| (2..=32).contains(&p.len())).ok_or("fan-resume: invalid curve")?;
        let mut cleaned = Vec::new();
        let mut previous = None;
        for point in points {
            let t = finite_percent(point.get("t")).ok_or("fan-resume: invalid curve")?;
            let speed = finite_percent(point.get("speedPct")).ok_or("fan-resume: invalid curve")?;
            let current = t.as_f64().unwrap();
            if previous.is_some_and(|previous| current <= previous) { return Err("fan-resume: invalid curve".into()); }
            previous = Some(current);
            cleaned.push(json!({"t":t,"speedPct":speed}));
        }
        out["fanCurve"] = json!(cleaned);
    }
    if mode == "fixed" {
        out["fixedFanPct"] = finite_percent(settings.get("fixedFanPct")).ok_or("fan-resume: invalid fixed speed")?.clone();
    }
    Ok(out)
}

pub fn fan_only_settings(settings: &Value) -> Result<Value, String> { fan_settings(settings, true) }

pub fn clean_record(raw: &Value) -> Option<Value> {
    let key = js_trim(raw.as_object()?.get("deviceKey")?.as_str()?);
    if key.is_empty() { return None; }
    let target = raw.get("physicalTarget")?;
    // JS typeof object accepts arrays here. Preserve them; the controller is
    // responsible for validating a usable physical target before a restore.
    if !target.is_object() && !target.is_array() { return None; }
    let settings = fan_settings(raw.get("settings")?, false).ok()?;
    Some(json!({"deviceKey":key,"physicalTarget":target,"settings":settings}))
}

fn data(raw: Option<Value>) -> Result<Vec<Value>, String> {
    let Some(raw) = raw else { return Ok(Vec::new()); };
    if raw.get("schemaVersion").and_then(Value::as_f64) != Some(1.0) || !raw["devices"].is_array() {
        return Err("FanResume.json has invalid format".into());
    }
    Ok(raw["devices"].as_array().unwrap().iter().filter_map(clean_record).collect())
}

pub struct FanResumeStore { file: Arc<SidecarFile> }
impl FanResumeStore {
    pub fn new(root: PathBuf) -> Result<Self, String> { Ok(Self::from_file(Arc::new(SidecarFile::new(root, Sidecar::FanResume)?))) }
    pub fn from_file(file: Arc<SidecarFile>) -> Self { Self { file } }
    pub fn list(&self) -> Result<Vec<Value>, String> { data(self.file.read()?) }
    /// Lookup intentionally does not trim: the JS store compares the supplied
    /// key exactly against keys normalized on record insertion.
    pub fn get(&self, device_key: &Value) -> Result<Option<Value>, String> {
        Ok(self.list()?.into_iter().find(|row| row.get("deviceKey") == Some(device_key)))
    }
    pub fn set(&self, record: &Value) -> Result<Value, String> {
        let clean = clean_record(record).ok_or("fan-resume: invalid record")?;
        self.file.transaction(|raw| {
            let mut records: Vec<_> = data(raw)?.into_iter().filter(|row| row["deviceKey"] != clean["deviceKey"]).collect();
            records.push(clean.clone());
            Ok((json!({"schemaVersion":1,"devices":records}), clean.clone()))
        })
    }
    pub fn remove(&self, device_key: &Value) -> Result<(), String> {
        self.file.transaction(|raw| {
            let records: Vec<_> = data(raw)?.into_iter().filter(|row| row.get("deviceKey") != Some(device_key)).collect();
            Ok((json!({"schemaVersion":1,"devices":records}), ()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Temp(PathBuf);
    impl Temp { fn new() -> Self { let root=std::env::temp_dir().join(format!("arc-fan-resume-test-{:032x}",rand::random::<u128>())); fs::create_dir(&root).unwrap(); Self(root) } }
    impl Drop for Temp { fn drop(&mut self) { if self.0.parent()==Some(std::env::temp_dir().as_path()) { let _=fs::remove_dir_all(&self.0); } } }
    fn record(key: &str) -> Value { json!({"deviceKey":key,"physicalTarget":{"pciDeviceId":"e20b"},"settings":{"fanMode":"auto"}}) }

    #[test]
    fn original_javascript_oracle_matches_record_cleanup_and_fan_validation() {
        let cases: Value=serde_json::from_str(include_str!("fixtures/fan-resume-store-parity.json")).unwrap();
        for case in cases["records"].as_array().unwrap() {
            let temp=Temp::new(); let store=FanResumeStore::new(temp.0.clone()).unwrap();
            let result=store.set(&case["input"]);
            if case["ok"]==true { assert_eq!(result.unwrap(),case["value"],"{case}"); }
            else { assert_eq!(result.unwrap_err(),case["error"].as_str().unwrap(),"{case}"); assert!(!temp.0.join("FanResume.json").exists()); }
        }
        for case in cases["settings"].as_array().unwrap() {
            let result=fan_only_settings(&case["input"]);
            if case["ok"]==true { assert_eq!(result.unwrap(),case["value"],"{case}"); }
            else { assert_eq!(result.unwrap_err(),case["error"].as_str().unwrap(),"{case}"); }
        }
    }

    #[test]
    fn missing_reads_exact_keys_duplicate_order_and_reload() {
        let temp=Temp::new(); let root=temp.0.join("missing"); let store=FanResumeStore::new(root.clone()).unwrap();
        assert_eq!(store.list().unwrap(),Vec::<Value>::new()); assert!(!root.exists());
        for key in ["a","b"," c ","a"] { store.set(&record(key)).unwrap(); }
        assert_eq!(store.list().unwrap().iter().map(|r|r["deviceKey"].as_str().unwrap()).collect::<Vec<_>>(),vec!["b","c","a"]);
        assert!(store.get(&json!(" c ")).unwrap().is_none()); assert!(store.get(&json!("c")).unwrap().is_some());
        store.remove(&json!("c")).unwrap();
        assert_eq!(FanResumeStore::new(root.clone()).unwrap().list().unwrap(),store.list().unwrap());
        assert!(root.join("FanResume.json").is_file());
    }

    #[test]
    fn malformed_or_future_documents_are_never_overwritten_and_invalid_rows_are_filtered() {
        let temp=Temp::new(); let path=temp.0.join("FanResume.json"); let store=FanResumeStore::new(temp.0.clone()).unwrap();
        for bytes in [b"broken".as_slice(),br#"{"schemaVersion":2,"devices":[]}"#.as_slice(),br#"{"schemaVersion":"1","devices":[]}"#.as_slice(),br#"{"schemaVersion":1,"devices":{}}"#.as_slice()] {
            fs::write(&path,bytes).unwrap(); assert!(store.list().is_err()); assert!(store.set(&record("x")).is_err()); assert!(store.remove(&json!("x")).is_err()); assert_eq!(fs::read(&path).unwrap(),bytes);
        }
        fs::write(&path,serde_json::to_vec(&json!({"schemaVersion":1,"devices":[null,record(" x "),{"deviceKey":"invalid"}]})).unwrap()).unwrap();
        assert_eq!(store.list().unwrap(),vec![record("x")]);
        store.remove(&json!("absent")).unwrap();
        assert_eq!(serde_json::from_slice::<Value>(&fs::read(path).unwrap()).unwrap(),json!({"schemaVersion":1,"devices":[record("x")]}));
    }

    #[test]
    fn shared_store_serializes_concurrent_updates() {
        let temp=Temp::new(); let store=Arc::new(FanResumeStore::new(temp.0.clone()).unwrap());
        let threads:Vec<_>=(0..12).map(|i| { let store=store.clone(); std::thread::spawn(move||store.set(&record(&format!("gpu-{i}"))).unwrap()) }).collect();
        for thread in threads { thread.join().unwrap(); }
        assert_eq!(store.list().unwrap().len(),12);
    }
}
