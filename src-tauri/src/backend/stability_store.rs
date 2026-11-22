//! Serialized Stability Lab history on the fixed stability.json sidecar.
use super::{sidecar_file::{Sidecar,SidecarFile},stability_contract::{js_number,normalize_stability_report,StabilityClock,STABILITY_MAX_REPORTS,STABILITY_SCHEMA_VERSION}};
use serde_json::{json,Value};
use std::{path::PathBuf,sync::Arc};

pub struct StabilityStore {file:Arc<SidecarFile>,limit:usize}
impl StabilityStore {
    pub fn new(root:PathBuf,limit:&Value)->Result<Self,String> {
        Ok(Self::from_file(Arc::new(SidecarFile::new(root,Sidecar::Stability)?),limit))
    }
    pub fn from_file(file:Arc<SidecarFile>,limit:&Value)->Self {
        let number=js_number(Some(limit));
        let number=if number.is_nan()||number==0.0{STABILITY_MAX_REPORTS as f64}else{number};
        Self{file,limit:number.round().clamp(1.0,STABILITY_MAX_REPORTS as f64)as usize}
    }
    fn data(&self,raw:Option<Value>,clock:&impl StabilityClock)->Result<Value,String> {
        let raw=raw.unwrap_or(Value::Null);
        // Preserve the original JS > comparison, including numeric-string
        // future versions; malformed JSON is rejected by SidecarFile first.
        if js_number(raw.get("schemaVersion"))>STABILITY_SCHEMA_VERSION as f64 {
            return Err("stability.json was created by a newer Arc Power version".into());
        }
        let mut reports=Vec::new();
        for report in raw["reports"].as_array().into_iter().flatten(){
            if let Some(report)=normalize_stability_report(report,clock)?{reports.push(report);}
        }
        if reports.len()>self.limit{reports.drain(..reports.len()-self.limit);}
        Ok(json!({"schemaVersion":STABILITY_SCHEMA_VERSION,"reports":reports}))
    }
    pub fn load_sync(&self,clock:&impl StabilityClock)->Result<Value,String>{self.load(clock)}
    pub fn load(&self,clock:&impl StabilityClock)->Result<Value,String>{self.data(self.file.read()?,clock)}
    pub fn list(&self,clock:&impl StabilityClock)->Result<Vec<Value>,String>{Ok(self.load(clock)?["reports"].as_array().expect("normalized reports").clone())}
    pub fn latest(&self,clock:&impl StabilityClock)->Result<Option<Value>,String>{Ok(self.list(clock)?.pop())}
    pub fn append(&self,report:&Value,clock:&impl StabilityClock)->Result<Value,String> {
        let normalized=normalize_stability_report(report,clock)?.ok_or("Invalid stability report")?;
        self.file.transaction(|raw|{
            let current=self.data(raw,clock)?;
            let mut reports:Vec<_>=current["reports"].as_array().unwrap().iter().filter(|item|item["runId"]!=normalized["runId"]).cloned().collect();
            reports.push(normalized.clone());
            if reports.len()>self.limit{reports.drain(..reports.len()-self.limit);}
            Ok((json!({"schemaVersion":STABILITY_SCHEMA_VERSION,"reports":reports}),normalized.clone()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    struct Clock;
    impl StabilityClock for Clock{fn now_ms(&self)->f64{1_800_000_000_000.0}fn now_iso(&self)->&str{"2027-01-15T08:00:00.000Z"}}
    struct Temp(PathBuf);
    impl Temp{fn new()->Self{let root=std::env::temp_dir().join(format!("arc-stability-test-{:032x}",rand::random::<u128>()));fs::create_dir(&root).unwrap();Self(root)}}
    impl Drop for Temp{fn drop(&mut self){if self.0.parent()==Some(std::env::temp_dir().as_path()){let _=fs::remove_dir_all(&self.0);}}}
    fn report(id:impl Into<String>)->Value{json!({"runId":id.into(),"deviceKey":"gpu-a","outcome":"passed","sampleCount":10})}

    #[test]
    fn missing_load_creates_nothing_and_append_replaces_duplicate_then_bounds_history() {
        let temp=Temp::new();let root=temp.0.join("missing");let store=StabilityStore::new(root.clone(),&json!(3)).unwrap();
        assert_eq!(store.load(&Clock).unwrap(),json!({"schemaVersion":1,"reports":[]}));assert!(!root.exists());assert!(store.latest(&Clock).unwrap().is_none());
        for id in ["a","b","c","d"]{store.append(&report(id),&Clock).unwrap();}
        let ids=|values:Vec<Value>|values.into_iter().map(|v|v["runId"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        assert_eq!(ids(store.list(&Clock).unwrap()),vec!["b","c","d"]);
        let mut replacement=report("c");replacement["outcome"]=json!("warning");store.append(&replacement,&Clock).unwrap();
        assert_eq!(ids(store.list(&Clock).unwrap()),vec!["b","d","c"]);assert_eq!(store.latest(&Clock).unwrap().unwrap()["outcome"],json!("warning"));
        assert_eq!(StabilityStore::new(root,&json!(3)).unwrap().load_sync(&Clock).unwrap(),store.load(&Clock).unwrap());
    }

    #[test]
    fn bom_newer_and_corrupt_documents_preserve_original_bytes() {
        let temp=Temp::new();let store=StabilityStore::new(temp.0.clone(),&Value::Null).unwrap();let path=temp.0.join("stability.json");
        fs::write(&path,b"\xef\xbb\xbf{\"schemaVersion\":1,\"reports\":[]}").unwrap();assert!(store.list(&Clock).unwrap().is_empty());
        for bytes in [b"broken".as_slice(),br#"{"schemaVersion":2,"reports":[]}"#.as_slice(),br#"{"schemaVersion":"2","reports":[]}"#.as_slice(),br#"{"schemaVersion":1,"reports":[null]}"#.as_slice()] {
            fs::write(&path,bytes).unwrap();assert!(store.load(&Clock).is_err());assert!(store.append(&report("x"),&Clock).is_err());assert_eq!(fs::read(&path).unwrap(),bytes);
        }
    }

    #[test]
    fn shared_instance_serializes_appends_and_default_history_never_exceeds_fifty() {
        let temp=Temp::new();let store=Arc::new(StabilityStore::new(temp.0.clone(),&json!(1000)).unwrap());
        let threads:Vec<_>=(0..8).map(|thread|{let store=store.clone();std::thread::spawn(move||for item in 0..10{store.append(&report(format!("{thread}-{item}")),&Clock).unwrap();})}).collect();
        for thread in threads{thread.join().unwrap();}
        let reports=store.list(&Clock).unwrap();assert_eq!(reports.len(),50);
        assert_eq!(reports.iter().map(|r|r["runId"].as_str().unwrap()).collect::<std::collections::HashSet<_>>().len(),50);
        let raw:Value=serde_json::from_slice(&fs::read(temp.0.join("stability.json")).unwrap()).unwrap();assert_eq!(raw["reports"].as_array().unwrap().len(),50);
    }

    #[test]
    fn invalid_reports_do_not_write_and_legacy_schema_is_normalized_on_append() {
        let temp=Temp::new();let store=StabilityStore::new(temp.0.clone(),&json!(0)).unwrap();let path=temp.0.join("stability.json");
        assert!(store.append(&json!({"deviceKey":"x"}),&Clock).is_err());assert!(!path.exists());
        fs::write(&path,br#"{"reports":[{"deviceKey":"gpu-a","runId":"old"},{}]}"#).unwrap();
        assert_eq!(store.list(&Clock).unwrap().len(),1);store.append(&report("new"),&Clock).unwrap();
        assert_eq!(store.load(&Clock).unwrap()["schemaVersion"],json!(1));assert_eq!(store.list(&Clock).unwrap().len(),2);
    }
}
