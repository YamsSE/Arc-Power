//! Serialized fixed-root game and recording storage. Contexts refresh per call;
//! the shared sidecar lock survives reconstruction of a recording operation.
use super::{game_profile_store::GameProfileStore,recording_store::{RecordingStore,NativeRecordingFs},
    sidecar_file::{Sidecar,SidecarFile},store_context::NativeStoreContext};
use serde_json::{json,Value};
use std::{collections::HashSet,path::PathBuf,sync::{Arc,Mutex}};

pub struct DomainStore {state:Mutex<State>}
struct State {games:GameProfileStore,recording:Arc<SidecarFile>,context:Option<NativeStoreContext>}
fn ids(value:&Value)->Result<Option<HashSet<String>>,String>{
    if value.is_null(){return Ok(None);}
    let array=value.as_array().ok_or("Profile ids must be an array or null")?;
    Ok(Some(array.iter().map(|value|value.as_str().map(str::to_owned).ok_or("Profile id must be a string".to_owned())).collect::<Result<_,_>>()?))
}
impl DomainStore {
    pub fn new(root:PathBuf)->Result<Self,String>{Ok(Self{state:Mutex::new(State{
        games:GameProfileStore::new(root.clone())?,recording:Arc::new(SidecarFile::new(root,Sidecar::Recording)?),context:None,
    })})}
    pub fn argument_count(method:&str)->Option<usize>{Some(match method{
        "game-load"|"game-save"|"game-has-catalog-path"|"game-add-catalog-entry"|"game-save-settings"|"game-delete-settings"=>1,
        "game-upsert"|"game-cleanup-profile"|"game-sync-catalog"=>2,
        "game-delete"=>3,
        "game-load-catalog"|"recording-load"|"recording-settings"|"recording-list-clips"|"recording-scan-clips"=>0,
        "recording-demote-encoder"=>2,
        "recording-save-settings"|"recording-replace-clips"|"recording-add-marker"|"recording-list-markers"|
        "recording-record-clip"|"recording-attach-markers-to-clip"|"recording-clip-by-id"|"recording-delete-clip"=>1,
        _=>return None,
    })}
    pub fn invoke(&self,method:&str,args:&[Value])->Result<Value,String>{
        let expected=Self::argument_count(method).ok_or("Unknown domain store method")?;
        if args.len()!=expected{return Err("Invalid domain store argument count".into());}
        let mut state=self.state.lock().map_err(|_|"Native domain store lock failed")?;
        // Catch while holding the outer guard, so a dependency failure cannot
        // poison all otherwise independent stores. Inner transactions fail closed.
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(||{
            if state.context.is_none(){state.context=Some(NativeStoreContext::new()?);}
            let ctx=state.context.as_ref().unwrap().refresh()?;
            let game=&state.games;
            let result=match method{
                "game-load"=>json!(game.load(ids(&args[0])?.as_ref(),&ctx)?),
                "game-save"=>json!(game.save(&args[0],&ctx)?),
                "game-upsert"=>json!(game.upsert(&args[0],ids(&args[1])?.as_ref(),&ctx)?),
                "game-delete"=>json!(game.delete(&args[0],&args[1],ids(&args[2])?.as_ref(),&ctx)?),
                "game-cleanup-profile"=>json!(game.cleanup_profile(&args[0],ids(&args[1])?.as_ref(),&ctx)?),
                "game-load-catalog"=>game.load_catalog(&ctx)?,
                "game-has-catalog-path"=>json!(game.has_catalog_path(&args[0],&ctx)?),
                "game-sync-catalog"=>json!(game.sync_catalog(&args[0],&args[1],&ctx)?),
                "game-add-catalog-entry"=>game.add_catalog_entry(&args[0],&ctx)?,
                "game-save-settings"=>game.save_settings(&args[0],&ctx)?,
                "game-delete-settings"=>game.delete_settings(&args[0],&ctx)?,
                _=>{
                    let recording=RecordingStore::with_files(state.recording.clone(),Arc::new(ctx),Arc::new(NativeRecordingFs));
                    let result=match method{
                        "recording-load"=>recording.load()?,
                        "recording-settings"=>recording.settings()?,
                        "recording-save-settings"=>recording.save_settings(args.first())?,
                        "recording-demote-encoder"=>recording.demote_encoder(args.first(),args.get(1))?,
                        "recording-list-clips"=>json!(recording.list_clips()?),
                        "recording-scan-clips"=>json!(recording.scan_clips()?),
                        "recording-replace-clips"=>json!(recording.replace_clips(args.first())?),
                        "recording-add-marker"=>recording.add_marker(args.first())?,
                        "recording-list-markers"=>json!(recording.list_markers(args.first())?),
                        "recording-record-clip"=>recording.record_clip(args.first())?,
                        "recording-attach-markers-to-clip"=>recording.attach_markers_to_clip(args.first())?,
                        "recording-clip-by-id"=>recording.clip_by_id(args.first())?,
                        "recording-delete-clip"=>recording.delete_clip(args.first())?,
                        _=>return Err("Unknown domain store method".into()),
                    };
                    return Ok(json!({"result":result,"cache":recording.load_sync()?}));
                }
            };Ok(result)
        })).unwrap_or_else(|_|Err("Native store dependency failed; reload before retrying".into()))
    }
}

#[cfg(test)]mod tests{
    use super::*;
    #[test]fn private_methods_have_exact_argument_counts(){
        assert_eq!(DomainStore::argument_count("game-delete"),Some(3));
        assert_eq!(DomainStore::argument_count("recording-load"),Some(0));
        assert_eq!(DomainStore::argument_count("write-file"),None);
        assert!(ids(&json!({"path":"arbitrary"})).is_err());
        assert!(ids(&json!([2])).is_err());assert_eq!(ids(&json!(["p","p"])).unwrap().unwrap().len(),1);
    }
}
