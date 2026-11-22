//! Lossless settings-patch projection for the recording store only.
//!
//! A present undefined property must overwrite the saved property before
//! normalization. Omitting it would retain the saved value; null is not a
//! general substitute for JavaScript's numeric coercion. Every recording
//! settings leaf accepts only a typed finite number/string/boolean/array, so an
//! empty object represents an invalid scalar without changing the defaults.
//! The three nested spread containers (audio, captureTarget, hotkeys) also
//! spread undefined and an empty object identically. Never reuse this
//! projection for clip metadata, markers, or another domain's patch semantics.
use super::wire::WireValue;
use serde_json::{Map,Value};

pub fn patch(value:WireValue)->Result<Value,String>{
    Ok(match value{
        WireValue::Undefined=>Value::Object(Map::new()),
        WireValue::BigInt(_)=>return Err("BigInt is unsupported in recording settings patches".into()),
        WireValue::SpecialNumber(number)=>match number.as_str(){
            "-0"=>Value::from(0),
            "NaN"|"Infinity"|"-Infinity"=>Value::Object(Map::new()),
            _=>return Err("Invalid special number in recording settings patch".into()),
        },
        WireValue::Null=>Value::Null,
        WireValue::Bool(value)=>Value::Bool(value),
        WireValue::String(value)=>Value::String(value),
        WireValue::Number(value)=>Value::Number(value),
        WireValue::Array(values)=>Value::Array(values.into_iter().map(patch).collect::<Result<_,_>>()?),
        WireValue::Object(values)=>Value::Object(values.into_iter().map(|(key,value)|Ok((key,patch(value)?))).collect::<Result<_,String>>()?),
    })
}

#[cfg(test)]
mod tests{
    use super::*;
    use crate::backend::{recording_store::{RecordingStore,RecordingStoreContext},recording_paths::{RecordingMetadataContext,RecordingCollation,Win32PathContext},wire};
    use serde_json::json;
    use std::{cmp::Ordering,path::PathBuf,sync::Arc};
    struct Context;
    impl RecordingMetadataContext for Context{
        fn now_iso(&self)->&str{"2026-11-08T12:00:00.000Z"}
        fn compare_text(&self,_:&str,_:&str,_:RecordingCollation)->Ordering{panic!("oracle settings fixtures contain no clips")}
    }
    impl Win32PathContext for Context{
        fn current_directory(&self)->Result<String,String>{Ok("C:\\fixture".into())}
        fn drive_current_directory(&self,_:&str)->Option<String>{None}
    }
    impl RecordingStoreContext for Context{
        fn uuid(&self)->String{panic!("settings do not allocate IDs")}
        fn default_location(&self)->&str{"C:\\Videos\\Arc Power"}
    }
    struct Temp(PathBuf);
    impl Drop for Temp{fn drop(&mut self){
        if self.0.parent()==Some(std::env::temp_dir().as_path())&&self.0.file_name().and_then(|n|n.to_str()).is_some_and(|n|n.starts_with("arc-recording-wire-test-")){
            let _=std::fs::remove_dir_all(&self.0);
        }
    }}
    fn equal(a:&Value,b:&Value)->bool{match(a,b){
        (Value::Number(a),Value::Number(b))=>a.as_f64()==b.as_f64(),
        (Value::Array(a),Value::Array(b))=>a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|equal(a,b)),
        (Value::Object(a),Value::Object(b))=>a.len()==b.len()&&a.iter().all(|(k,a)|b.get(k).is_some_and(|b|equal(a,b))),
        _=>a==b,
    }}
    #[test]
    fn projection_keeps_explicit_overwrites_and_numeric_zero(){
        assert_eq!(patch(WireValue::Object(vec![("fps".into(),WireValue::Undefined)])).unwrap(),json!({"fps":{}}));
        assert_eq!(patch(WireValue::SpecialNumber("-0".into())).unwrap(),json!(0));
        assert_eq!(patch(WireValue::Null).unwrap(),Value::Null);
        assert!(patch(WireValue::BigInt("12".into())).is_err());
        assert!(patch(WireValue::SpecialNumber("bad".into())).is_err());
    }
    #[test]
    fn all_settings_reset_patches_match_original_js_store(){
        // Run the original store's real saveSettings implementation with
        // in-memory read/write seams. No application, capture, or media IO.
        let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let script=r#"
          import {pathToFileURL} from 'node:url';
          const {RecordingStore}=await import(pathToFileURL(process.argv[1]));
          const {normalizeRecordingSettings}=await import(pathToFileURL(process.argv[2]));
          const {encodeTauriWire}=await import(pathToFileURL(process.argv[3]));
          const current=normalizeRecordingSettings({location:'C:/custom',runtimePath:'C:/runtime',mode:'clips',fps:144,resolution:'4k',encoderId:'obs_qsv11_av1',rateControl:'CQP',bitrateKbps:19000,maxBitrateKbps:24000,rateControlQuality:45,captureColorMode:'hdr',showCursor:true,memorySavingMode:true,replayLengthSec:120,instantReplayAutoStart:true,replayMarkersEnabled:false,captureTarget:{type:'window',displayId:'other',windowHandle:123,processName:'Game.exe',executablePath:'C:/Game.exe',windowTitle:'Game',windowClass:'GameClass'},audio:{sourceMode:'custom',customProcesses:['Game.exe'],microphone:{enabled:true,deviceId:'mic',volume:0.25,mono:true},system:{enabled:false,deviceId:'speakers',volume:0.5}},hotkeys:{toggle:'F1',saveClip:'F2',screenshot:'F3',marker:'F4'}});
          const paths=[];
          function walk(value,path=[]){for(const [key,item] of Object.entries(value)){const next=[...path,key];paths.push(next);if(item&&typeof item==='object'&&!Array.isArray(item))walk(item,next);}}
          walk(current);paths.push(['hotkeys','start'],['hotkeys','stop']);
          const values=[['undefined',undefined],['NaN',NaN],['Infinity',Infinity],['-Infinity',-Infinity],['-0',-0],['null',null]];
          const store=new RecordingStore({dir:'C:/unused-oracle',defaultLocation:'C:/Videos/Arc Power'});
          store._readData=()=>({data:{schemaVersion:2,settings:current,clips:[],markers:[]}});store._write=()=>{};
          const cases=[];
          for(const path of paths)for(const [label,value] of values){let patch=value;for(const key of [...path].reverse())patch={[key]:patch};cases.push({label:path.join('.')+'/'+label,wire:encodeTauriWire(patch),expected:await store.saveSettings(patch)});}
          console.log(JSON.stringify({current,cases}));
        "#;
        let output=std::process::Command::new("node").args(["--input-type=module","-e",script])
            .arg(root.join("src/main/store/recording-store.js"))
            .arg(root.join("src/main/recording-pure.js"))
            .arg(root.join("src/shared/tauri-wire.js")).output().expect("Node required for original recording store oracle");
        assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        let fixture:Value=serde_json::from_slice(&output.stdout).unwrap();
        assert!(fixture["cases"].as_array().unwrap().len()>250);
        let temp=Temp(std::env::temp_dir().join(format!("arc-recording-wire-test-{:032x}",rand::random::<u128>())));
        std::fs::create_dir(&temp.0).unwrap();
        let store=RecordingStore::new(temp.0.clone(),Arc::new(Context)).unwrap();
        for case in fixture["cases"].as_array().unwrap(){
            std::fs::write(temp.0.join("recording.json"),serde_json::to_vec(&json!({"schemaVersion":2,"settings":fixture["current"],"clips":[],"markers":[]})).unwrap()).unwrap();
            let patch=patch(wire::decode(&case["wire"]).unwrap()).unwrap();
            let actual=store.save_settings(Some(&patch)).unwrap();
            assert!(equal(&actual,&case["expected"]),"{}\nactual: {actual}\nexpected: {}",case["label"],case["expected"]);
        }
    }
}
