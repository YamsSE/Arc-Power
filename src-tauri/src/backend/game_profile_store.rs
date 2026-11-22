//! Serialized game association/catalog/settings store on the fixed Games sidecar.
use super::{game_profile_contract::*,sidecar_file::{Sidecar,SidecarFile}};
use serde_json::{json,Value};
use std::{collections::HashSet,path::PathBuf,sync::{Arc,Mutex}};

/// The source's legacy-association exception requires both facts separately:
/// an absent executable may retain its association, an existing unsafe file may not.
pub trait GameProfileStoreContext:GameProfileContext {
    fn is_safe_candidate_without_existence(&self,value:&Value)->bool;
    fn executable_exists(&self,value:&Value)->bool;
}
#[derive(Default)]
struct StoreState{catalog_path_cache:Option<HashSet<String>>}
pub struct GameProfileStore{file:Arc<SidecarFile>,mutation:Mutex<StoreState>}

fn merge(left:&Value,right:&Value)->Value {
    let mut map=left.as_object().cloned().unwrap_or_default();
    if let Some(right)=right.as_object(){map.extend(right.clone());}Value::Object(map)
}
fn rows(data:&Value,field:&str)->Vec<Value>{data[field].as_array().expect("normalized game collection").clone()}
fn first_path(data:&Value,field:&str,path:&Value)->Value{data[field].as_array().unwrap().iter().find(|item|item["exePath"]==*path).cloned().unwrap_or(Value::Null)}
fn remove_path(data:&mut Value,field:&str,path:&Value){data[field]=json!(rows(data,field).into_iter().filter(|item|item["exePath"]!=*path).collect::<Vec<_>>());}
fn push(data:&mut Value,field:&str,value:Value){data[field].as_array_mut().unwrap().push(value);}
fn nonempty_string(value:&Value)->bool{value.as_str().is_some_and(|s|!s.is_empty())}
fn real_artwork(value:&Value)->bool{is_valid_artwork(value)&&!value.as_str().unwrap().starts_with("fallback-")}
fn js_whitespace(c:char)->bool{matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')}
fn valid_id(value:&Value)->bool{value.as_str().is_some_and(|s|!s.is_empty()&&!s.chars().any(js_whitespace))}

impl GameProfileStore {
    pub fn new(root:PathBuf)->Result<Self,String>{Ok(Self::from_file(Arc::new(SidecarFile::new(root,Sidecar::Games)?)))}
    pub fn from_file(file:Arc<SidecarFile>)->Self{Self{file,mutation:Mutex::new(StoreState::default())}}

    fn with_data<T>(&self,state:&mut StoreState,valid_ids:Option<&HashSet<String>>,ctx:&impl GameProfileContext,
        work:impl FnOnce(&mut Value)->Result<(T,bool),String>)->Result<T,String>{
        let (result,invalidate)=self.file.transaction_optional(|raw|{
            let (mut data,migration_write)=match raw{Some(raw)=>{let normalized=migrate_game_profile_data(&raw,valid_ids,ctx)?;(normalized.data,normalized.needs_write)},None=>(empty_data(),false)};
            let migrated=data.clone();
            // The JS loader persists migrations even if a subsequent mutation
            // fails. Retain that behavior while holding one sidecar transaction.
            match work(&mut data){
                Ok((result,true))=>Ok((Some(data),(Ok(result),true))),
                Ok((result,false))=>Ok((migration_write.then_some(data),(Ok(result),false))),
                Err(error)=>Ok((migration_write.then_some(migrated),(Err(error),false))),
            }
        })?;
        if invalidate{state.catalog_path_cache=None;}result
    }
    fn state(&self)->Result<std::sync::MutexGuard<'_,StoreState>,String>{self.mutation.lock().map_err(|_|"Game profile mutation mutex was poisoned".into())}

    pub fn load(&self,valid_ids:Option<&HashSet<String>>,ctx:&impl GameProfileContext)->Result<Vec<Value>,String>{
        self.with_data(&mut *self.state()?,valid_ids,ctx,|data|Ok((rows(data,"associations"),false)))
    }
    pub fn save(&self,associations:&Value,ctx:&impl GameProfileContext)->Result<Vec<Value>,String>{
        self.with_data(&mut *self.state()?,None,ctx,|data|{
            data["associations"]=associations.clone();
            let clean=normalize_game_profile_data(data,ctx)?;let result=rows(&clean,"associations");*data=clean;Ok((result,true))
        })
    }
    pub fn upsert(&self,raw:&Value,valid_ids:Option<&HashSet<String>>,ctx:&impl GameProfileStoreContext)->Result<Vec<Value>,String>{
        let association=normalize_association(raw,ctx)?.ok_or("game-profile-save: invalid association")?;
        if valid_ids.is_some_and(|ids|!ids.contains(association["profileId"].as_str().unwrap())){return Err("game-profile-save: profile not found".into());}
        let safe=ctx.is_safe_existing_game(&association["exePath"]);
        if !safe&&!(ctx.is_safe_candidate_without_existence(&association["exePath"])&&!ctx.executable_exists(&association["exePath"])){return Err("game-profile-save: executable is not a safe existing game candidate".into());}
        self.with_data(&mut *self.state()?,valid_ids,ctx,|data|{
            let key=(&association["profileId"],&association["exePath"]);
            data["associations"]=json!(rows(data,"associations").into_iter().filter(|item|(&item["profileId"],&item["exePath"])!=key).collect::<Vec<_>>());
            push(data,"associations",association.clone());
            if safe{
                let previous=first_path(data,"catalog",&association["exePath"]);
                let mut incoming=merge(&previous,&association);
                incoming["artwork"]=if real_artwork(&association["artwork"]){association["artwork"].clone()}else{previous["artwork"].clone()};
                incoming["banner"]=if is_valid_banner(&association["banner"]){association["banner"].clone()}else{previous["banner"].clone()};
                remove_path(data,"catalog",&association["exePath"]);push(data,"catalog",normalize_catalog_entry(&incoming,ctx)?.unwrap());
                let previous=first_path(data,"settings",&association["exePath"]);
                let assignment=normalize_game_gpu_profile(&json!({"deviceKey":null,"enabled":association["enabled"],"tuningProfileId":association["profileId"],"graphics":merge(&previous["graphics"],&association["graphics"])}),ctx).unwrap();
                let mut incoming=merge(&previous,&association);
                incoming["gpuProfiles"]=json!(merge_game_gpu_profiles(&[&previous["gpuProfiles"],&json!([assignment])],ctx));
                remove_path(data,"settings",&association["exePath"]);push(data,"settings",normalize_game_settings(&incoming,ctx)?.unwrap());
            }
            let clean=normalize_game_profile_data(data,ctx)?;let result=rows(&clean,"associations");*data=clean;Ok((result,true))
        })
    }
    pub fn delete(&self,profile_id:&Value,exe_path:&Value,valid_ids:Option<&HashSet<String>>,ctx:&impl GameProfileContext)->Result<Vec<Value>,String>{
        if !valid_id(profile_id){return Err("game-profile-delete: invalid profile id".into());}
        let canonical=ctx.canonical_exe_path(exe_path).ok_or("game-profile-delete: invalid executable path")?;
        self.with_data(&mut *self.state()?,valid_ids,ctx,|data|{
            let current=rows(data,"associations");let next:Vec<_>=current.iter().filter(|item|!(item["profileId"]==*profile_id&&item["exePath"].as_str()==Some(&canonical))).cloned().collect();
            let changed=next.len()!=current.len();data["associations"]=json!(next);if changed{*data=normalize_game_profile_data(data,ctx)?;}Ok((next,changed))
        })
    }
    pub fn cleanup_profile(&self,profile_id:&Value,valid_ids:Option<&HashSet<String>>,ctx:&impl GameProfileContext)->Result<Vec<Value>,String>{
        self.with_data(&mut *self.state()?,valid_ids,ctx,|data|{
            let current=rows(data,"associations");let next:Vec<_>=current.iter().filter(|item|item["profileId"]!=*profile_id).cloned().collect();
            let current_settings=rows(data,"settings");let mut cleaned=Vec::new();
            for mut item in current_settings.clone(){
                if item["tuningProfileId"]==*profile_id{item["tuningProfileId"]=Value::Null;}
                if let Some(assignments)=item["gpuProfiles"].as_array_mut(){for assignment in assignments{if assignment["tuningProfileId"]==*profile_id{assignment["tuningProfileId"]=Value::Null;}}}
                cleaned.push(normalize_game_settings(&item,ctx)?.unwrap());
            }
            let changed=next.len()!=current.len()||cleaned!=current_settings;
            data["associations"]=json!(next);data["settings"]=json!(cleaned);if changed{*data=normalize_game_profile_data(data,ctx)?;}Ok((next,changed))
        })
    }
    pub fn load_catalog(&self,ctx:&impl GameProfileContext)->Result<Value,String>{
        let mut state=self.state()?;
        let result=self.with_data(&mut state,None,ctx,|data|Ok((json!({"catalog":data["catalog"],"settings":data["settings"]}),false)))?;
        state.catalog_path_cache=Some(result["catalog"].as_array().unwrap().iter().map(|p|p["exePath"].as_str().unwrap().to_owned()).collect());Ok(result)
    }
    pub fn has_catalog_path(&self,value:&Value,ctx:&impl GameProfileContext)->Result<bool,String>{
        let Some(canonical)=ctx.canonical_exe_path(value)else{return Ok(false);};let mut state=self.state()?;
        if state.catalog_path_cache.is_none(){let paths=self.with_data(&mut state,None,ctx,|data|Ok((rows(data,"catalog").iter().map(|p|p["exePath"].as_str().unwrap().to_owned()).collect(),false)))?;state.catalog_path_cache=Some(paths);}
        Ok(state.catalog_path_cache.as_ref().unwrap().contains(&canonical))
    }
    pub fn sync_catalog(&self,entries:&Value,options:&Value,ctx:&impl GameProfileContext)->Result<Vec<Value>,String>{
        let incoming_raw=entries.as_array().ok_or("game-catalog-sync: entries must be an array")?;
        for entry in incoming_raw{let path=entry.get("exePath").filter(|v|!v.is_null()).or_else(||entry.get("ExecutablePath")).unwrap_or(&Value::Null);if !ctx.is_safe_existing_game(path){return Err("game-catalog-sync: executable is not a safe existing game candidate".into());}}
        self.with_data(&mut *self.state()?,None,ctx,|data|{
            let incoming=normalize_catalog(entries,ctx)?;let incoming_paths:HashSet<_>=incoming.iter().map(|e|e["exePath"].as_str().unwrap().to_owned()).collect();
            let authoritative=options.get("authoritative")==Some(&Value::Bool(true));
            let mut catalog:Vec<_>=rows(data,"catalog").into_iter().filter(|item|!authoritative||item["source"]==json!("manual")||incoming_paths.contains(item["exePath"].as_str().unwrap())).collect();
            for mut entry in incoming{
                if let Some(index)=catalog.iter().position(|p|p["exePath"]==entry["exePath"]){
                    if !real_artwork(&entry["artwork"]){entry["artwork"]=catalog[index]["artwork"].clone();}
                    if nonempty_string(&catalog[index]["createdAt"]){entry["createdAt"]=catalog[index]["createdAt"].clone();}
                    catalog[index]=entry;
                }else{catalog.push(entry);}
            }
            let paths:HashSet<_>=catalog.iter().map(|e|e["exePath"].as_str().unwrap().to_owned()).collect();
            data["catalog"]=json!(catalog);if authoritative{data["settings"]=json!(rows(data,"settings").into_iter().filter(|s|paths.contains(s["exePath"].as_str().unwrap())).collect::<Vec<_>>());}
            let clean=normalize_game_profile_data(data,ctx)?;let result=rows(&clean,"catalog");*data=clean;Ok((result,true))
        })
    }
    pub fn add_catalog_entry(&self,raw:&Value,ctx:&impl GameProfileContext)->Result<Value,String>{
        if !ctx.is_safe_existing_game(&raw["exePath"]){return Err("game-catalog-add: executable is not a safe existing game candidate".into());}
        let path=json!(ctx.canonical_exe_path(&raw["exePath"]).ok_or("game-catalog-add: executable is not a safe existing game candidate")?);
        self.with_data(&mut *self.state()?,None,ctx,|data|{
            let mut incoming=raw.clone();incoming["exePath"]=path.clone();incoming["source"]=json!("manual");
            let mut entry=normalize_catalog_entry(&incoming,ctx)?.unwrap();let previous=first_path(data,"catalog",&path);
            if !previous.is_null(){if !real_artwork(&raw["artwork"]){entry["artwork"]=previous["artwork"].clone();}if nonempty_string(&previous["createdAt"]){entry["createdAt"]=previous["createdAt"].clone();}}
            remove_path(data,"catalog",&path);push(data,"catalog",entry);let clean=normalize_game_profile_data(data,ctx)?;*data=clean.clone();Ok((clean,true))
        })
    }
    pub fn save_settings(&self,raw:&Value,ctx:&impl GameProfileContext)->Result<Value,String>{
        let settings=normalize_game_settings(raw,ctx)?.ok_or("game-settings-save: invalid executable settings")?;
        if !ctx.is_safe_existing_game(&settings["exePath"]){return Err("game-settings-save: executable is not a safe existing game candidate".into());}
        self.with_data(&mut *self.state()?,None,ctx,|data|{
            if !rows(data,"catalog").iter().any(|p|p["exePath"]==settings["exePath"]){return Err("game-settings-save: executable is not present in the game catalog".into());}
            let previous=first_path(data,"settings",&settings["exePath"]);let previous_assignments=previous["gpuProfiles"].as_array().cloned().unwrap_or_default();
            let raw_assignments=raw["gpuProfiles"].as_array().cloned().unwrap_or_else(||vec![raw.clone()]);let mut patches=Vec::new();
            for item in raw_assignments{
                let normalized=normalize_game_gpu_profile(&item,ctx);let key=normalized.as_ref().map(|v|v["deviceKey"].clone()).unwrap_or(Value::Null);
                let current=previous_assignments.iter().find(|p|p["deviceKey"]==key).unwrap_or(&Value::Null);
                if let Some(patch)=merge_game_gpu_profile_patch(current,&item,ctx){patches.push(patch);}
            }
            let mut merged=merge(&previous,&settings);merged["gpuProfiles"]=json!(merge_game_gpu_profiles(&[&previous["gpuProfiles"],&json!(patches)],ctx));
            merged["createdAt"]=previous.get("createdAt").filter(|v|!v.is_null()).cloned().unwrap_or_else(||settings["createdAt"].clone());
            remove_path(data,"settings",&settings["exePath"]);push(data,"settings",normalize_game_settings(&merged,ctx)?.unwrap());
            let clean=normalize_game_profile_data(data,ctx)?;let result=first_path(&clean,"settings",&settings["exePath"]);*data=clean;Ok((result,true))
        })
    }
    pub fn delete_settings(&self,exe_path:&Value,ctx:&impl GameProfileContext)->Result<Value,String>{
        let path=json!(ctx.canonical_exe_path(exe_path).ok_or("game-settings-delete: invalid executable path")?);
        self.with_data(&mut *self.state()?,None,ctx,|data|{
            remove_path(data,"settings",&path);let clean=normalize_game_profile_data(data,ctx)?;let result=json!({"catalog":clean["catalog"],"settings":clean["settings"]});*data=clean;Ok((result,true))
        })
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    use super::super::game_candidate;
    use std::{cmp::Ordering,fs};
    struct Context{fixture:Value}
    impl Context{fn new()->Self{Self{fixture:serde_json::from_str(include_str!("fixtures/game-store-contract.json")).unwrap()}}fn member(&self,field:&str,value:&Value)->bool{let Some(path)=game_candidate::canonical_exe_path(value)else{return false;};self.fixture[field].as_array().unwrap().iter().any(|p|p.as_str()==Some(&path))}}
    impl GameProfileContext for Context{
        fn now_iso(&self)->&str{self.fixture["now"].as_str().unwrap()}
        fn canonical_exe_path(&self,value:&Value)->Option<String>{game_candidate::canonical_exe_path(value)}
        fn is_safe_existing_game(&self,value:&Value)->bool{self.member("files",value)&&self.member("lex",value)}
        fn compare_text(&self,a:&str,b:&str,base:bool)->Ordering{
            if a==b{return Ordering::Equal;}
            self.fixture["comparisons"].as_array().unwrap().iter().find(|row|row[0].as_str()==Some(a)&&row[1].as_str()==Some(b)&&row[2].as_bool()==Some(base)).unwrap_or_else(||panic!("missing oracle locale comparison {a:?} {b:?} {base}"))[3].as_i64().unwrap().cmp(&0)
        }
    }
    impl GameProfileStoreContext for Context{fn is_safe_candidate_without_existence(&self,value:&Value)->bool{self.member("lex",value)}fn executable_exists(&self,value:&Value)->bool{self.member("existing",value)}}
    struct Temp(PathBuf);
    impl Temp{fn new()->Self{let root=std::env::temp_dir().join(format!("arc-game-store-test-{:032x}",rand::random::<u128>()));fs::create_dir(&root).unwrap();Self(root)}}
    impl Drop for Temp{fn drop(&mut self){if self.0.parent()==Some(std::env::temp_dir().as_path()){let _=fs::remove_dir_all(&self.0);}}}
    fn ids(value:Option<&Value>)->Option<HashSet<String>>{value.and_then(Value::as_array).map(|values|values.iter().map(|v|v.as_str().unwrap().to_owned()).collect())}

    #[test]
    fn original_js_full_store_lifecycle_and_persisted_documents_match(){
        let ctx=Context::new();
        for scenario in ctx.fixture["scenarios"].as_array().unwrap(){
            let temp=Temp::new();let path=temp.0.join("game-profiles.json");
            if let Some(initial)=scenario["initialText"].as_str(){fs::write(&path,initial).unwrap();}
            let store=GameProfileStore::new(temp.0.clone()).unwrap();let mut previous_writes=0;
            for (index,step) in scenario["steps"].as_array().unwrap().iter().enumerate(){
                let before=fs::read(&path).ok();let args=step["args"].as_array().unwrap();let op=step["op"].as_str().unwrap();
                let actual:Result<Value,String>=match op{
                    "load"=>store.load(ids(args.first()).as_ref(),&ctx).map(|v|json!(v)),
                    "save"=>store.save(&args[0],&ctx).map(|v|json!(v)),
                    "upsert"=>store.upsert(&args[0],ids(args.get(1)).as_ref(),&ctx).map(|v|json!(v)),
                    "delete"=>store.delete(&args[0],&args[1],ids(args.get(2)).as_ref(),&ctx).map(|v|json!(v)),
                    "cleanupProfile"=>store.cleanup_profile(&args[0],ids(args.get(1)).as_ref(),&ctx).map(|v|json!(v)),
                    "loadCatalog"=>store.load_catalog(&ctx),
                    "hasCatalogPath"=>store.has_catalog_path(&args[0],&ctx).map(|v|json!(v)),
                    "syncCatalog"=>store.sync_catalog(&args[0],args.get(1).unwrap_or(&Value::Null),&ctx).map(|v|json!(v)),
                    "addCatalogEntry"=>store.add_catalog_entry(&args[0],&ctx),
                    "saveSettings"=>store.save_settings(&args[0],&ctx),
                    "deleteSettings"=>store.delete_settings(&args[0],&ctx),
                    _=>panic!("unknown store operation"),
                };
                let label=format!("{} step {index} {op}",scenario["name"].as_str().unwrap());
                if step.get("error").is_some(){assert!(actual.is_err(),"{label}: expected error");if step["corrupt"]!=json!(true){assert_eq!(actual.unwrap_err(),step["error"].as_str().unwrap(),"{label}");}}
                else{assert_eq!(actual.unwrap(),step["result"],"{label}");}
                if step["persistedText"].is_null(){assert!(!path.exists(),"{label}: missing sidecar must remain missing");}
                else if step["corrupt"]==json!(true){assert_eq!(fs::read_to_string(&path).unwrap(),step["persistedText"].as_str().unwrap(),"{label}");}
                else{let persisted:Value=serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();assert_eq!(persisted,step["persisted"],"{label}: persisted document");}
                let writes=step["writes"].as_u64().unwrap();if writes==previous_writes{assert_eq!(fs::read(&path).ok(),before,"{label}: no-op changed existing bytes");}previous_writes=writes;
            }
        }
    }

    #[test]
    fn shared_store_serializes_concurrent_association_upserts_and_restart(){
        let temp=Temp::new();let store=Arc::new(GameProfileStore::new(temp.0.clone()).unwrap());let ctx=Arc::new(Context::new());
        let threads:Vec<_>=(0..8).map(|index|{let store=store.clone();let ctx=ctx.clone();std::thread::spawn(move||store.upsert(&json!({"exePath":"C:/Games/A.EXE","displayName":"Alpha","profileId":format!("profile-{index}")}),None,&*ctx).unwrap())}).collect();
        for thread in threads{thread.join().unwrap();}assert_eq!(store.load(None,&*ctx).unwrap().len(),8);
        let restarted=GameProfileStore::new(temp.0.clone()).unwrap();assert_eq!(restarted.load(None,&*ctx).unwrap().len(),8);
        assert!(restarted.has_catalog_path(&json!("C:/Games/A.EXE"),&*ctx).unwrap());
    }
}
