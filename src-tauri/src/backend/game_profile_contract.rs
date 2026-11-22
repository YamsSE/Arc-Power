//! Pure game-profile contract. Native executable validation, time, and locale
//! collation are explicit inputs; this module never probes or launches a file.
use serde_json::{json, Map, Value};
use std::{cmp::Ordering, collections::HashSet};

pub const GAME_PROFILE_SCHEMA_VERSION:u64=3;
pub const MAX_BANNER_DATA_LENGTH:usize=12_000_000;

pub trait GameProfileContext {
    fn now_iso(&self)->&str;
    fn canonical_exe_path(&self,value:&Value)->Option<String>;
    fn is_safe_existing_game(&self,value:&Value)->bool;
    /// `base` corresponds to localeCompare(..., undefined, {sensitivity:'base'}).
    fn compare_text(&self,left:&str,right:&str,base:bool)->Ordering;
}

fn js_trim(text:&str)->&str {
    text.trim_matches(|c:char|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
fn utf16_len(text:&str)->usize {text.encode_utf16().count()}
fn text_slice(text:&str,max:usize)->Result<String,String> {
    let units:Vec<_>=text.encode_utf16().take(max).collect();
    String::from_utf16(&units).map_err(|_|"JS UTF-16 truncation produced a lone surrogate; refusing lossy game metadata".into())
}
fn clean_text(value:Option<&Value>,max:usize,fallback:&str)->Result<String,String> {
    match value.and_then(Value::as_str).map(js_trim).filter(|s|!s.is_empty()) {
        Some(text)=>text_slice(text,max),None=>Ok(fallback.into()),
    }
}
fn js_string(value:&Value)->String {
    match value {
        Value::Null=>String::new(),Value::String(s)=>s.clone(),Value::Bool(b)=>b.to_string(),
        Value::Object(_)=>"[object Object]".into(),
        Value::Array(values)=>values.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Number(n)=>{
            let number=n.as_f64().unwrap_or(0.0);
            if number==0.0 {return "0".into();}
            let rendered=number.to_string();
            if number.abs()>=1e21||number.abs()<1e-6 {
                let scientific=format!("{number:e}");
                let (mantissa,exponent)=scientific.split_once('e').unwrap();
                let exponent=exponent.parse::<i32>().unwrap();
                format!("{mantissa}e{}{exponent}",if exponent>=0 {"+"}else{""})
            } else {rendered}
        }
    }
}
pub fn deterministic_artwork_key(value:&Value)->String {
    let text=js_string(value).to_lowercase();
    let hash=text.encode_utf16().fold(2166136261u32,|hash,unit|(hash^unit as u32).wrapping_mul(16777619));
    format!("fallback-{hash:08x}")
}

fn data_image_exact(text:&str)->bool {
    let Some(body)=text.strip_prefix("data:image/") else{return false;};
    let Some(body)=["png;base64,","jpeg;base64,","webp;base64,"].iter().find_map(|prefix|body.strip_prefix(prefix)) else{return false;};
    let payload=body.trim_end_matches('=');
    !payload.is_empty()&&body.len()-payload.len()<=2&&payload.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'+'||b==b'/')
}
pub fn is_valid_artwork(value:&Value)->bool {
    let Some(text)=value.as_str().filter(|s|utf16_len(s)<=750000) else{return false;};
    text=="local:arc-power"||text.strip_prefix("fallback-").is_some_and(|suffix|!suffix.is_empty()&&suffix.len()<=48&&suffix.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit()||b==b'_'||b==b'-'))||data_image_exact(text)
}
pub fn is_valid_banner(value:&Value)->bool {
    value.as_str().filter(|s|utf16_len(s)<=MAX_BANNER_DATA_LENGTH).is_some_and(data_image_exact)
}
fn artwork(value:Option<&Value>,fallback:String)->Value {value.filter(|v|is_valid_artwork(v)).cloned().unwrap_or(Value::String(fallback))}
fn banner(value:Option<&Value>)->Value {value.filter(|v|is_valid_banner(v)).cloned().unwrap_or(Value::Null)}
fn clean_time(value:Option<&Value>,now:&str)->Value {value.filter(|v|v.as_str().is_some_and(|s|utf16_len(s)<=80)).cloned().unwrap_or_else(||json!(now))}
fn gpu_key(value:Option<&Value>)->Value {value.and_then(Value::as_str).filter(|s|!js_trim(s).is_empty()&&utf16_len(s)<=256).map(|s|json!(js_trim(s))).unwrap_or(Value::Null)}
fn valid_profile_id(value:&Value)->bool {value.as_str().is_some_and(|s|!s.is_empty()&&!s.chars().any(|c|js_trim(&c.to_string()).is_empty()))}
fn enum_field(out:&mut Map<String,Value>,raw:&Value,field:&str,options:&[&str]) {
    if raw.get(field).and_then(Value::as_str).is_some_and(|s|options.contains(&s)) {out.insert(field.into(),raw[field].clone());}
}
pub fn clean_graphics(raw:&Value)->Value {
    let mut out=Map::new();if !raw.is_object() {return Value::Object(out);}
    enum_field(&mut out,raw,"flipMode",&["application-default","vsync-on","vsync-off","smooth-sync","speed-frame","smart-vsync"]);
    if let Some(frame)=raw.get("frameLimit").filter(|v|v.is_object()||v.is_array()) {
        if let (Some(enabled),Some(number))=(frame.get("enabled").and_then(Value::as_bool),frame.get("value").and_then(Value::as_f64).filter(|v|v.is_finite())) {
            out.insert("frameLimit".into(),json!({"enabled":enabled,"value":number.round().clamp(1.0,1000.0) as u32}));
        }
    }
    enum_field(&mut out,raw,"lowLatency",&["off","on","on-boost"]);
    enum_field(&mut out,raw,"enduranceGaming",&["off","on"]);
    enum_field(&mut out,raw,"frameGenOverride",&["app-choice","2x","3x","4x"]);
    if let Some(sharpen)=raw.get("sharpening").filter(|v|v.is_object()) {
        if let (Some(enabled),Some(percentage))=(sharpen.get("enabled").and_then(Value::as_bool),sharpen.get("percentage").and_then(Value::as_f64).filter(|v|v.is_finite()&&v.fract()==0.0&&*v>=0.0&&*v<=100.0)) {
            out.insert("sharpening".into(),json!({"enabled":enabled,"percentage":percentage as u32}));
        }
    }
    Value::Object(out)
}

pub fn normalize_game_gpu_profile(raw:&Value,ctx:&impl GameProfileContext)->Option<Value> {
    if !raw.is_object() {return None;}
    if let Some(key)=raw.get("deviceKey").filter(|v|!v.is_null()) {
        if !key.as_str().is_some_and(|s|!js_trim(s).is_empty()&&utf16_len(s)<=256) {return None;}
    }
    Some(json!({"deviceKey":gpu_key(raw.get("deviceKey")),"deviceName":gpu_key(raw.get("deviceName")),
        "enabled":raw.get("enabled")==Some(&Value::Bool(true)),
        "tuningProfileId":raw.get("tuningProfileId").filter(|v|valid_profile_id(v)).cloned().unwrap_or(Value::Null),
        "graphics":clean_graphics(&raw["graphics"]),"createdAt":clean_time(raw.get("createdAt"),ctx.now_iso()),"updatedAt":clean_time(raw.get("updatedAt"),ctx.now_iso())}))
}
pub fn merge_game_gpu_profile_patch(current:&Value,patch:&Value,ctx:&impl GameProfileContext)->Option<Value> {
    let mut out=current.as_object().cloned().unwrap_or_default();
    let mut graphics=current.get("graphics").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(patch)=patch.as_object() {
        if let Some(additions)=patch.get("graphics").and_then(Value::as_object) {graphics.extend(additions.clone());}
        for field in ["deviceKey","deviceName","tuningProfileId"] {if let Some(value)=patch.get(field) {out.insert(field.into(),value.clone());}}
        if let Some(enabled)=patch.get("enabled").filter(|v|v.is_boolean()) {out.insert("enabled".into(),enabled.clone());}
    }
    out.insert("graphics".into(),Value::Object(graphics));
    normalize_game_gpu_profile(&Value::Object(out),ctx)
}
pub fn merge_game_gpu_profiles(lists:&[&Value],ctx:&impl GameProfileContext)->Vec<Value> {
    let mut out:Vec<Value>=Vec::new();let mut keys:Vec<String>=Vec::new();
    for list in lists {
        for raw in list.as_array().into_iter().flatten() {
            let Some(mut profile)=normalize_game_gpu_profile(raw,ctx) else{continue;};
            let key=profile["deviceKey"].as_str().unwrap_or("__legacy__").to_owned();
            if let Some(index)=keys.iter().position(|k|*k==key) {
                if profile["deviceName"].is_null() {profile["deviceName"]=out[index]["deviceName"].clone();}
                if out[index]["createdAt"].as_str().is_some_and(|s|!s.is_empty()) {profile["createdAt"]=out[index]["createdAt"].clone();}
                out[index]=profile;
            } else {keys.push(key);out.push(profile);}
        }
    }
    out
}
fn legacy_gpu_profile(raw:&Value,ctx:&impl GameProfileContext)->Value {
    normalize_game_gpu_profile(&json!({"deviceKey":null,"deviceName":null,"enabled":raw.get("enabled"),"tuningProfileId":raw.get("tuningProfileId"),"graphics":raw.get("graphics"),"createdAt":raw.get("createdAt"),"updatedAt":raw.get("updatedAt")}),ctx).expect("legacy shape valid")
}
pub fn normalize_game_settings(raw:&Value,ctx:&impl GameProfileContext)->Result<Option<Value>,String> {
    if !raw.is_object() {return Ok(None);}let Some(exe)=ctx.canonical_exe_path(&raw["exePath"])else{return Ok(None);};
    let mut profiles=if raw["gpuProfiles"].is_array(){merge_game_gpu_profiles(&[&raw["gpuProfiles"]],ctx)}else{
        let mut profile=raw.clone();if profile.get("deviceKey").is_none(){profile["deviceKey"]=Value::Null;}
        if profile.get("deviceName").is_none(){profile["deviceName"]=Value::Null;}
        vec![normalize_game_gpu_profile(&profile,ctx).unwrap_or(Value::Null)]
    };
    if profiles.is_empty(){profiles.push(legacy_gpu_profile(raw,ctx));}
    if profiles.iter().any(Value::is_null){return Err("Cannot read properties of null (reading 'deviceKey')".into());}
    let display=profiles.iter().find(|p|p.get("deviceKey")==Some(&Value::Null)).or(profiles.first()).unwrap();
    Ok(Some(json!({"exePath":exe,"enabled":display.get("enabled")==Some(&Value::Bool(true)),
        "tuningProfileId":display.get("tuningProfileId").cloned().unwrap_or(Value::Null),
        "graphics":display.get("graphics").cloned().unwrap_or_else(||json!({})),"gpuProfiles":profiles,
        "createdAt":clean_time(raw.get("createdAt"),ctx.now_iso()),"updatedAt":clean_time(raw.get("updatedAt"),ctx.now_iso())})))
}

fn basename(exe:&str)->&str {exe.rsplit(['\\','/']).next().unwrap_or(exe)}
pub fn normalize_catalog_entry(raw:&Value,ctx:&impl GameProfileContext)->Result<Option<Value>,String> {
    if !raw.is_object(){return Ok(None);}let Some(exe)=ctx.canonical_exe_path(&raw["exePath"])else{return Ok(None);};
    let process=clean_text(raw.get("processName"),260,basename(&exe))?;
    let display=clean_text(raw.get("displayName"),260,basename(&exe).strip_suffix(".exe").unwrap_or(basename(&exe)))?;
    Ok(Some(json!({"exePath":exe,"processName":process,"displayName":display,
        "artwork":artwork(raw.get("artwork"),deterministic_artwork_key(&json!(exe))),"banner":banner(raw.get("banner")),
        "source":if raw.get("source").and_then(Value::as_str)==Some("manual"){"manual"}else{"scan"},
        "createdAt":clean_time(raw.get("createdAt"),ctx.now_iso()),"updatedAt":clean_time(raw.get("updatedAt"),ctx.now_iso())})))
}
pub fn normalize_association(raw:&Value,ctx:&impl GameProfileContext)->Result<Option<Value>,String> {
    if !raw.is_object(){return Ok(None);}let Some(exe)=ctx.canonical_exe_path(&raw["exePath"])else{return Ok(None);};
    if !valid_profile_id(&raw["profileId"]){return Ok(None);}let profile=raw["profileId"].as_str().unwrap();
    let mut id=clean_text(raw.get("id"),160,"")?;
    if id.is_empty(){id=format!("game-{}",format!("{profile}|{exe}").as_bytes().iter().take(16).map(|b|format!("{b:02x}")).collect::<String>());}
    let mut out=normalize_catalog_entry(raw,ctx)?.expect("already validated object/path");
    out["id"]=json!(id);out["profileId"]=json!(profile);out["enabled"]=json!(raw.get("enabled")!=Some(&Value::Bool(false)));
    out["graphics"]=clean_graphics(&raw["graphics"]);
    for field in ["createdAt","updatedAt"] {out[field]=raw.get(field).filter(|v|v.is_string()).cloned().unwrap_or_else(||json!(ctx.now_iso()));}
    Ok(Some(out))
}
fn sort_metadata(items:&mut [Value],ctx:&impl GameProfileContext) {
    items.sort_by(|a,b|ctx.compare_text(&format!("{}\0{}",a["displayName"].as_str().unwrap(),a["exePath"].as_str().unwrap()),&format!("{}\0{}",b["displayName"].as_str().unwrap(),b["exePath"].as_str().unwrap()),true));
}
pub fn normalize_associations(raw:&Value,valid_ids:Option<&HashSet<String>>,ctx:&impl GameProfileContext)->Result<Vec<Value>,String> {
    let mut seen=HashSet::new();let mut out=Vec::new();
    for item in raw.as_array().into_iter().flatten(){
        let Some(association)=normalize_association(item,ctx)?else{continue;};
        let profile=association["profileId"].as_str().unwrap();
        if valid_ids.is_some_and(|ids|!ids.contains(profile)){continue;}
        let key=format!("{profile}|{}",association["exePath"].as_str().unwrap());
        if seen.insert(key){out.push(association);}
    }
    sort_metadata(&mut out,ctx);Ok(out)
}
pub fn normalize_catalog(raw:&Value,ctx:&impl GameProfileContext)->Result<Vec<Value>,String> {
    let mut out:Vec<Value>=Vec::new();
    for item in raw.as_array().into_iter().flatten(){
        let Some(mut entry)=normalize_catalog_entry(item,ctx)?else{continue;};
        if let Some(index)=out.iter().position(|p|p["exePath"]==entry["exePath"]){
            if !(is_valid_artwork(&item["artwork"])&&!item["artwork"].as_str().unwrap().starts_with("fallback-")){entry["artwork"]=out[index]["artwork"].clone();}
            if out[index]["createdAt"].as_str().is_some_and(|s|!s.is_empty()){entry["createdAt"]=out[index]["createdAt"].clone();}
            out[index]=entry;
        }else{out.push(entry);}
    }
    sort_metadata(&mut out,ctx);Ok(out)
}
pub fn normalize_settings(raw:&Value,ctx:&impl GameProfileContext)->Result<Vec<Value>,String> {
    let mut out:Vec<Value>=Vec::new();
    for item in raw.as_array().into_iter().flatten(){
        let Some(mut entry)=normalize_game_settings(item,ctx)?else{continue;};
        if let Some(index)=out.iter().position(|p|p["exePath"]==entry["exePath"]){
            entry["gpuProfiles"]=json!(merge_game_gpu_profiles(&[&out[index]["gpuProfiles"],&entry["gpuProfiles"]],ctx));
            if out[index]["createdAt"].as_str().is_some_and(|s|!s.is_empty()){entry["createdAt"]=out[index]["createdAt"].clone();}
            out[index]=normalize_game_settings(&entry,ctx)?.unwrap();
        }else{out.push(entry);}
    }
    out.sort_by(|a,b|ctx.compare_text(a["exePath"].as_str().unwrap(),b["exePath"].as_str().unwrap(),false));Ok(out)
}
fn safe_records(raw:&Value,ctx:&impl GameProfileContext)->Value {json!(raw.as_array().into_iter().flatten().filter(|item|ctx.is_safe_existing_game(&item["exePath"])).cloned().collect::<Vec<_>>())}
pub fn empty_data()->Value {json!({"schemaVersion":GAME_PROFILE_SCHEMA_VERSION,"associations":[],"catalog":[],"settings":[]})}

#[derive(Debug)]
pub struct GameProfileLoad {pub data:Value,pub needs_write:bool}

/// Pure body of GameProfileStore._loadDataUnlocked after BOM/JSON parsing.
pub fn migrate_game_profile_data(data:&Value,valid_ids:Option<&HashSet<String>>,ctx:&impl GameProfileContext)->Result<GameProfileLoad,String> {
    if !data.is_object(){return Err("Cannot load game-profiles.json: root must be an object".into());}
    let version=data["schemaVersion"].as_f64().filter(|v|v.is_finite()&&v.fract()==0.0&&*v>=1.0).ok_or("Cannot load game-profiles.json: invalid schema version")?;
    if version>GAME_PROFILE_SCHEMA_VERSION as f64{return Err("game-profiles.json uses a newer unsupported schema".into());}
    if !data["associations"].is_array(){return Err("Cannot load game-profiles.json: associations must be an array".into());}
    let associations=normalize_associations(&data["associations"],valid_ids,ctx)?;
    let migrated_catalog=if version==1.0{&data["associations"]}else{&data["catalog"]};
    let migrated_settings=if version==1.0{&data["associations"]}else{&data["settings"]};
    // Null v1 associations throw in JS's item.exePath mapping rather than being
    // silently discarded. Refuse them without mutating a persisted file.
    if version==1.0&&data["associations"].as_array().unwrap().iter().any(Value::is_null){return Err("Cannot migrate null v1 game association".into());}
    let mut catalog=normalize_catalog(&safe_records(migrated_catalog,ctx),ctx)?;
    for entry in &mut catalog {
        if let Some(association)=associations.iter().find(|a|a["exePath"]==entry["exePath"]){
            entry["processName"]=association["processName"].clone();entry["displayName"]=association["displayName"].clone();
            if is_valid_artwork(&association["artwork"]){entry["artwork"]=association["artwork"].clone();}
            if is_valid_banner(&association["banner"]){entry["banner"]=association["banner"].clone();}
        }
    }
    let mut settings=normalize_settings(&safe_records(migrated_settings,ctx),ctx)?;
    for association in &associations {
        if !ctx.is_safe_existing_game(&association["exePath"]){continue;}
        if !catalog.iter().any(|p|p["exePath"]==association["exePath"]){catalog.push(normalize_catalog_entry(association,ctx)?.unwrap());}
        if !settings.iter().any(|p|p["exePath"]==association["exePath"]){settings.push(normalize_game_settings(association,ctx)?.unwrap());}
    }
    let catalog=normalize_catalog(&json!(catalog),ctx)?;let settings=normalize_settings(&json!(settings),ctx)?;
    let unsafe_catalog=data["catalog"].as_array().into_iter().flatten().any(|p|!ctx.is_safe_existing_game(&p["exePath"]));
    let unsafe_settings=data["settings"].as_array().into_iter().flatten().any(|p|!ctx.is_safe_existing_game(&p["exePath"]));
    let needs_write=version!=GAME_PROFILE_SCHEMA_VERSION as f64||associations.len()!=data["associations"].as_array().unwrap().len()
        ||unsafe_catalog||unsafe_settings||catalog!=normalize_catalog(&safe_records(&data["catalog"],ctx),ctx)?
        ||settings!=normalize_settings(&safe_records(&data["settings"],ctx),ctx)?;
    Ok(GameProfileLoad {data:json!({"schemaVersion":3,"associations":associations,"catalog":catalog,"settings":settings}),needs_write})
}

/// Pure body of _saveDataUnlocked. Validation is provided by the native owner.
pub fn normalize_game_profile_data(data:&Value,ctx:&impl GameProfileContext)->Result<Value,String> {
    Ok(json!({"schemaVersion":3,"associations":normalize_associations(&data["associations"],None,ctx)?,
        "catalog":normalize_catalog(&safe_records(&data["catalog"],ctx),ctx)?,"settings":normalize_settings(&safe_records(&data["settings"],ctx),ctx)?}))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Context {fixture:Value}
    impl Context {fn new()->Self{Self{fixture:serde_json::from_str(include_str!("fixtures/game-profile-contract.json")).unwrap()}}}
    impl GameProfileContext for Context {
        fn now_iso(&self)->&str {self.fixture["now"].as_str().unwrap()}
        fn canonical_exe_path(&self,value:&Value)->Option<String> {
            let text=value.as_str()?;
            self.fixture["canonical"].as_array().unwrap().iter().find(|pair|pair[0].as_str()==Some(text)).and_then(|pair|pair[1].as_str()).map(str::to_owned)
        }
        fn is_safe_existing_game(&self,value:&Value)->bool {
            let Some(path)=self.canonical_exe_path(value)else{return false;};
            self.fixture["safe"].as_array().unwrap().iter().any(|v|v.as_str()==Some(&path))
        }
        fn compare_text(&self,left:&str,right:&str,base:bool)->Ordering {
            let row=self.fixture["comparisons"].as_array().unwrap().iter().find(|row|row[0].as_str()==Some(left)&&row[1].as_str()==Some(right)&&row[2].as_bool()==Some(base)).unwrap_or_else(||panic!("missing injected collation pair {left:?} {right:?} {base}"));
            row[3].as_i64().unwrap().cmp(&0)
        }
    }

    #[test]
    fn original_js_differential_contract_fixtures() {
        let ctx=Context::new();
        for (index,case) in ctx.fixture["cases"].as_array().unwrap().iter().enumerate() {
            let args=case["args"].as_array().unwrap();let op=case["op"].as_str().unwrap();
            let actual:Result<Value,String>=match op {
                "deterministicArtworkKey"=>Ok(json!(deterministic_artwork_key(&args[0]))),
                "isValidArtwork"=>Ok(json!(is_valid_artwork(&args[0]))),
                "isValidBanner"=>Ok(json!(is_valid_banner(&args[0]))),
                "cleanGraphics"=>Ok(clean_graphics(&args[0])),
                "normalizeGameGpuProfile"=>Ok(normalize_game_gpu_profile(&args[0],&ctx).unwrap_or(Value::Null)),
                "mergeGameGpuProfilePatch"=>Ok(merge_game_gpu_profile_patch(&args[0],&args[1],&ctx).unwrap_or(Value::Null)),
                "mergeGameGpuProfiles"=>Ok(json!(merge_game_gpu_profiles(&args.iter().collect::<Vec<_>>(),&ctx))),
                "normalizeGameSettings"=>normalize_game_settings(&args[0],&ctx).map(|v|v.unwrap_or(Value::Null)),
                "normalizeCatalogEntry"=>normalize_catalog_entry(&args[0],&ctx).map(|v|v.unwrap_or(Value::Null)),
                "normalizeAssociation"=>normalize_association(&args[0],&ctx).map(|v|v.unwrap_or(Value::Null)),
                "normalizeAssociations"=>normalize_associations(&args[0],None,&ctx).map(|v|json!(v)),
                "normalizeCatalog"=>normalize_catalog(&args[0],&ctx).map(|v|json!(v)),
                "normalizeSettings"=>normalize_settings(&args[0],&ctx).map(|v|json!(v)),
                "migrate"=>migrate_game_profile_data(&args[0],None,&ctx).map(|v|json!({"data":v.data,"needsWrite":v.needs_write})),
                _=>panic!("unknown oracle operation"),
            };
            if case["rustRefusal"]==json!(true){assert!(actual.is_err(),"case {index} {op} must refuse unrepresentable JS surrogate");}
            else if let Some(error)=case.get("error"){assert_eq!(actual.unwrap_err(),error.as_str().unwrap(),"case {index} {op}");}
            else {assert_eq!(actual.unwrap(),case["result"],"case {index} {op}");}
        }
    }

    #[test]
    fn artwork_banner_limits_and_exact_regex_boundaries() {
        let prefix="data:image/png;base64,";
        let at_limit=format!("{prefix}{}","A".repeat(750000-prefix.len()));
        assert!(is_valid_artwork(&json!(at_limit)));
        assert!(!is_valid_artwork(&json!(format!("{at_limit}A"))));
        let banner_limit=format!("{prefix}{}","A".repeat(MAX_BANNER_DATA_LENGTH-prefix.len()));
        assert!(is_valid_banner(&json!(banner_limit)));
        assert!(!is_valid_banner(&json!(format!("{banner_limit}A"))));
        for suffix in ["\n","\r","\u{2028}","===","-A"] {
            assert!(!is_valid_banner(&json!(format!("data:image/png;base64,A{suffix}"))));
        }
    }

    #[test]
    fn valid_profile_filter_and_read_migration_are_immutable() {
        let ctx=Context::new();
        let source=json!({"schemaVersion":1,"associations":[{"exePath":"C:/Games/A.EXE","profileId":"p-a"},{"exePath":"C:/Games/B.EXE","profileId":"p-b"}]});
        let original=source.clone();
        let ids=HashSet::from(["p-b".to_owned()]);
        let normalized=normalize_associations(&source["associations"],Some(&ids),&ctx).unwrap();
        assert_eq!(normalized.len(),1);assert_eq!(normalized[0]["profileId"],json!("p-b"));
        // A supplied candidate validator can deny every path without probing a disk.
        struct Deny<'a>(&'a Context);
        impl GameProfileContext for Deny<'_>{
            fn now_iso(&self)->&str{self.0.now_iso()}
            fn canonical_exe_path(&self,v:&Value)->Option<String>{self.0.canonical_exe_path(v)}
            fn is_safe_existing_game(&self,_:&Value)->bool{false}
            fn compare_text(&self,a:&str,b:&str,base:bool)->Ordering{self.0.compare_text(a,b,base)}
        }
        let migration=migrate_game_profile_data(&source,Some(&ids),&Deny(&ctx)).unwrap();
        assert!(migration.needs_write);assert_eq!(migration.data["catalog"],json!([]));assert_eq!(migration.data["settings"],json!([]));
        assert_eq!(migration.data["associations"].as_array().unwrap().len(),1);assert_eq!(source,original);
    }
}
