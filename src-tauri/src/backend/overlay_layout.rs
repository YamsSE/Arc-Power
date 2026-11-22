//! Overlay metadata normalization and atomic persistence, independent of windows.
use super::{arc_sleep_policy::{js_number,js_trim},sidecar_file::{Sidecar,SidecarFile}};
use serde_json::{json,Value};
use std::{collections::HashSet,path::PathBuf};
pub const MAX_LAYOUTS:usize=20;
pub const SCHEMA_VERSION:u64=1;
fn text(value:Option<&Value>,fallback:&str,max:usize)->String {
    value.and_then(Value::as_str).map(js_trim).filter(|s|!s.is_empty()&&s.encode_utf16().count()<=max).unwrap_or(fallback).into()
}
fn nullish<'a>(left:Option<&'a Value>,right:Option<&'a Value>)->Option<&'a Value> {
    left.filter(|v|!v.is_null()).or_else(||right.filter(|v|!v.is_null()))
}
fn field<'a>(value:Option<&'a Value>,key:&str)->Option<&'a Value>{value.and_then(|v|v.get(key))}
fn color(value:Option<&Value>)->String {
    value.and_then(Value::as_str).filter(|s|s.len()==7&&s.starts_with('#')&&s[1..].bytes().all(|b|b.is_ascii_hexdigit())).unwrap_or("#000000").into()
}
fn position(raw:Option<&Value>,fallback:Option<&Value>,allowed:&[&str],default:&str)->String {
    raw.and_then(Value::as_str).filter(|v|allowed.contains(v)).or_else(||fallback.and_then(Value::as_str).filter(|v|allowed.contains(v))).unwrap_or(default).into()
}
fn strings(values:Option<&Value>,max_length:Option<usize>)->Option<Vec<Value>> {
    let array=values?.as_array()?;let mut seen=HashSet::new();
    Some(array.iter().filter_map(|v|v.as_str()).filter(|s|max_length.is_none_or(|max|s.encode_utf16().count()<=max))
        .take(64).filter(|s|seen.insert((*s).to_owned())).map(|s|json!(s)).collect())
}
/// Metadata JSON representation. As in JSON.stringify at the old storage
/// boundary, a nonfinite background opacity serializes as null.
pub fn normalize_overlay_layout(raw:&Value,fallback:&Value)->Result<Value,String> {
    if raw.is_null()||fallback.is_null(){return Err("Overlay layout and defaults must not be null".into());}
    let id=text(raw.get("id"),&text(fallback.get("id"),"default",80),96);
    let id:String=id.encode_utf16().map(|unit|if unit<128&&((unit as u8).is_ascii_alphanumeric()||unit==45||unit==95){unit as u8 as char}else{'_'}).collect();
    let name=text(raw.get("name"),&text(fallback.get("name"),"Default",80),64);
    let raw_bg=raw.get("background");let fallback_bg=fallback.get("background");
    let scale=js_number(nullish(raw.get("scale"),fallback.get("scale")));
    let opacity=js_number(nullish(field(raw_bg,"opacity"),field(fallback_bg,"opacity")).or(Some(&Value::from(0.5))));
    Ok(json!({"id":id,"name":name,
        "position":position(raw.get("position"),fallback.get("position"),&["top-left","top-right","bottom-left","bottom-right"],"top-left"),
        "scale":if scale.is_finite(){scale.clamp(0.5,2.0)}else{1.0},
        "theme":position(raw.get("theme"),fallback.get("theme"),&["classic","arc"],"arc"),
        "stats":strings(nullish(raw.get("stats"),fallback.get("stats")),None).unwrap_or_default(),
        "deviceKeys":strings(nullish(raw.get("deviceKeys"),fallback.get("deviceKeys")),Some(256)),
        "background":{"enabled":field(raw_bg,"enabled")==Some(&Value::Bool(true))||(raw_bg.is_none()&&field(fallback_bg,"enabled")==Some(&Value::Bool(true))),
            "color":color(nullish(field(raw_bg,"color"),field(fallback_bg,"color"))),
            "opacity":if opacity.is_nan(){Value::Null}else{json!(opacity.clamp(0.0,1.0))}},
        "advancedPosition":position(raw.get("advancedPosition"),fallback.get("advancedPosition"),&["left","right"],"right")
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn json_equivalent(a:&Value,b:&Value)->bool{match(a,b){
        (Value::Number(a),Value::Number(b))=>a.as_f64()==b.as_f64(),
        (Value::Array(a),Value::Array(b))=>a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|json_equivalent(a,b)),
        (Value::Object(a),Value::Object(b))=>a.len()==b.len()&&a.iter().all(|(key,a)|b.get(key).is_some_and(|b|json_equivalent(a,b))),_=>a==b,
    }}
    #[test]
    fn original_js_layout_normalizer_matches_json_metadata_boundary(){
        let repo=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
        let mut cases=vec![json!([{},{}]),json!([null,{}]),json!([{},null])];
        let defaults=json!({"id":"fallback","name":"Original","scale":1.25,"background":{"enabled":true,"color":"#aAbBcC","opacity":0.8},"stats":["fps"],"deviceKeys":["gpu-a"]});
        let values=vec![Value::Null,json!(false),json!(true),json!(0),json!(-1),json!(2),json!(""),json!("1.25"),json!("bad"),json!("inf"),json!("-inf"),json!("infinity"),json!("Infinity"),json!("+Infinity"),json!("1e999"),json!("#123456"),json!(["fps","fps","gpu-temp",3]),json!({})];
        for key in ["id","name","position","scale","theme","stats","deviceKeys","advancedPosition"]{
            for value in &values {cases.push(json!([{key:*value},defaults]));}
        }
        for value in &values {cases.push(json!([{"background":value},defaults]));for key in ["enabled","color","opacity"]{cases.push(json!([{"background":{key:*value}},defaults]));}}
        cases.push(json!([{"id":"A😀 B","stats":["",""]},defaults]));
        let script=r#"import fs from 'node:fs';import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.argv[1]).href);const c=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify(c.map(([a,b])=>{try{return {value:m.normalizeOverlayLayout(a,b)}}catch(e){return {error:true}}})));"#;
        use std::io::Write;
        let mut child=std::process::Command::new("node").args(["--input-type=module","-e",script]).arg(repo.join("src/main/overlay-layout-store.js"))
            .stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).spawn().unwrap();
        child.stdin.take().unwrap().write_all(&serde_json::to_vec(&cases).unwrap()).unwrap();
        let output=child.wait_with_output().unwrap();assert!(output.status.success());
        let expected:Vec<Value>=serde_json::from_slice(&output.stdout).unwrap();
        for(index,args)in cases.iter().enumerate(){match normalize_overlay_layout(&args[0],&args[1]){
            Ok(value)=>assert!(json_equivalent(&value,&expected[index]["value"]),"case {index} {args}: actual={value} expected={}",expected[index]["value"]),Err(_)=>assert_eq!(expected[index]["error"],true,"case {index}"),
        }}
    }
    #[test]
    fn atomic_layout_workflow_and_default_guard_preserve_latest_state(){
        let root=std::env::temp_dir().join(format!("arc-layout-test-{:032x}",rand::random::<u128>()));
        let store=OverlayLayoutStore::new(root.clone()).unwrap();let defaults=json!({});
        assert_eq!(store.load(&defaults).unwrap()["activeId"],"default");
        assert!(store.delete(&json!("default"),&defaults).is_err());
        store.save(&json!({"id":"custom","name":"My layout"}),&defaults).unwrap();
        store.select(&json!("custom"),&defaults).unwrap();
        store.rename(&json!("custom"),&json!(" Renamed "),&defaults).unwrap();
        assert_eq!(store.load(&defaults).unwrap()["layouts"][1]["name"],"Renamed");
        assert_eq!(store.delete(&json!("custom"),&defaults).unwrap()["activeId"],"default");
        let path=root.join("overlay-layouts.json");let future=br#"{"schemaVersion":2}"#;std::fs::write(&path,future).unwrap();
        assert!(store.save(&json!({"id":"x"}),&defaults).is_err());
        assert_eq!(store.save(&Value::Null,&defaults).unwrap_err(),"overlay-layouts.json was created by a newer Arc Power version");
        assert_eq!(std::fs::read(path).unwrap(),future);
        assert_eq!(root.parent(),Some(std::env::temp_dir().as_path()));std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn serialized_nan_opacity_remains_null_and_inherits_later_defaults(){
        let root=std::env::temp_dir().join(format!("arc-layout-nan-{:032x}",rand::random::<u128>()));
        let store=OverlayLayoutStore::new(root.clone()).unwrap();
        let initial=json!({"background":{"opacity":0.7}});
        let saved=store.save_with_nonfinite_opacity(&json!({"id":"custom","background":{"opacity":null}}),&initial,true).unwrap();
        assert_eq!(saved["layouts"][1]["background"]["opacity"],Value::Null);
        let path=root.join("overlay-layouts.json");
        let persisted:Value=serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(persisted["layouts"][1]["background"]["opacity"],Value::Null);
        let later=store.load(&json!({"background":{"opacity":0.9}})).unwrap();
        assert_eq!(later["layouts"][1]["background"]["opacity"],json!(0.9));
        std::fs::remove_dir_all(root).unwrap();
    }
}
pub fn normalize_overlay_data(raw:Option<&Value>,defaults:&Value)->Result<Value,String> {
    if raw.is_some_and(|raw|js_number(raw.get("schemaVersion"))>SCHEMA_VERSION as f64){return Err("overlay-layouts.json was created by a newer Arc Power version".into());}
    let mut layouts=match raw.and_then(|raw|raw.get("layouts")).and_then(Value::as_array){
        Some(values)=>values.iter().map(|v|normalize_overlay_layout(v,defaults)).collect::<Result<Vec<_>,_>>()?,None=>Vec::new(),
    };
    layouts.truncate(MAX_LAYOUTS);
    if layouts.is_empty(){layouts.push(normalize_overlay_layout(&json!({"id":"default","name":"Default"}),defaults)?);}
    let active=raw.and_then(|v|v.get("activeId")).filter(|id|layouts.iter().any(|v|v.get("id")==Some(*id))).cloned().unwrap_or_else(||layouts[0]["id"].clone());
    Ok(json!({"schemaVersion":SCHEMA_VERSION,"activeId":active,"layouts":layouts}))
}
pub struct OverlayLayoutStore { file:SidecarFile }
impl OverlayLayoutStore {
    pub fn new(root:PathBuf)->Result<Self,String>{Ok(Self{file:SidecarFile::new(root,Sidecar::OverlayLayouts)?})}
    pub fn load(&self,defaults:&Value)->Result<Value,String>{normalize_overlay_data(self.file.read()?.as_ref(),defaults)}
    pub fn save(&self,layout:&Value,defaults:&Value)->Result<Value,String>{
        self.save_with_nonfinite_opacity(layout,defaults,false)
    }
    /// Persist the JSON.stringify representation of a JavaScript NaN opacity.
    /// The null sidecar value must remain null until the next load, when it
    /// inherits that load's current defaults just as the Electron store does.
    pub fn save_with_nonfinite_opacity(&self,layout:&Value,defaults:&Value,preserve_null_opacity:bool)->Result<Value,String>{
        self.file.transaction(|old|{
            let mut data=normalize_overlay_data(old.as_ref(),defaults)?;
            // Electron validates the existing document before normalizing input.
            let mut layout=normalize_overlay_layout(layout,defaults)?;
            if preserve_null_opacity { layout["background"]["opacity"]=Value::Null; }
            let layouts=data["layouts"].as_array_mut().unwrap();layouts.retain(|v|v["id"]!=layout["id"]);layouts.push(layout);layouts.truncate(MAX_LAYOUTS);
            Ok((data.clone(),data))
        })
    }
    pub fn rename(&self,id:&Value,name:&Value,defaults:&Value)->Result<Value,String>{self.file.transaction(|old|{
        let mut data=normalize_overlay_data(old.as_ref(),defaults)?;
        let layout=data["layouts"].as_array_mut().unwrap().iter_mut().find(|v|v.get("id")==Some(id)).ok_or("Overlay layout not found")?;
        layout["name"]=json!(text(Some(name),layout["name"].as_str().unwrap_or("Default"),64));Ok((data.clone(),data))
    })}
    pub fn select(&self,id:&Value,defaults:&Value)->Result<Value,String>{self.file.transaction(|old|{
        let mut data=normalize_overlay_data(old.as_ref(),defaults)?;
        if !data["layouts"].as_array().unwrap().iter().any(|v|v.get("id")==Some(id)){return Err("Overlay layout not found".into());}
        data["activeId"]=id.clone();Ok((data.clone(),data))
    })}
    pub fn delete(&self,id:&Value,defaults:&Value)->Result<Value,String>{self.file.transaction(|old|{
        let mut data=normalize_overlay_data(old.as_ref(),defaults)?;
        if data["layouts"].as_array().unwrap().len()<=1{return Err("The default overlay layout cannot be deleted".into());}
        let active=data["activeId"].clone();let layouts=data["layouts"].as_array_mut().unwrap();layouts.retain(|v|v.get("id")!=Some(id));
        if !layouts.iter().any(|v|v.get("id")==Some(&active)){data["activeId"]=layouts[0]["id"].clone();}Ok((data.clone(),data))
    })}
}
