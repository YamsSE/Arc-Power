//! Native store inputs. Each context is an operation's immutable UTC snapshot.
//! ICU objects are created, used and destroyed on one worker thread. Only
//! owned strings and comparison results cross its channel; no unsafe Send.
use super::{collation::{Collator,Sensitivity},game_candidate,game_profile_contract::GameProfileContext,
    game_profile_store::GameProfileStoreContext,platform_context::{self,ClockSnapshot,KnownFolder},
    recording_paths::{RecordingCollation,RecordingMetadataContext,SystemWin32Paths,Win32PathContext},
    recording_store::RecordingStoreContext};
use serde_json::Value;
use std::{cmp::Ordering,sync::{Arc,mpsc}};

#[derive(Clone,Copy)]
pub enum StoreCollation {Default,Base,NumericBase}
struct CompareRequest{left:String,right:String,mode:StoreCollation,reply:mpsc::SyncSender<Result<Ordering,String>>}
struct Comparator{sender:mpsc::SyncSender<CompareRequest>}
impl Comparator{
    fn new(locale:String)->Result<Self,String>{
        let(sender,receiver)=mpsc::sync_channel::<CompareRequest>(32);
        let(ready,initialized)=mpsc::sync_channel(1);
        std::thread::Builder::new().name("arc-store-icu".into()).spawn(move||{
            let setup=(||{
                Ok::<_,String>((Collator::new(&locale,Sensitivity::Variant).map_err(|e|e.to_string())?,
                    Collator::new(&locale,Sensitivity::Base).map_err(|e|e.to_string())?,
                    Collator::new_with_numeric(&locale,Sensitivity::Base,true).map_err(|e|e.to_string())?))
            })();
            let(mut default,mut base,mut numeric)=match setup{Ok(collators)=>{if ready.send(Ok(())).is_err(){return;}collators},Err(error)=>{let _=ready.send(Err(error));return;}};
            while let Ok(request)=receiver.recv(){
                let collator=match request.mode{StoreCollation::Default=>&mut default,StoreCollation::Base=>&mut base,StoreCollation::NumericBase=>&mut numeric};
                let result=collator.compare(&request.left,&request.right).map_err(|e|e.to_string());
                let _=request.reply.send(result);
            }
        }).map_err(|e|format!("Cannot create store collation worker: {e}"))?;
        initialized.recv().map_err(|_|"Store collation worker stopped during initialization")??;
        Ok(Self{sender})
    }
    fn compare(&self,left:&str,right:&str,mode:StoreCollation)->Result<Ordering,String>{
        let(reply,result)=mpsc::sync_channel(1);
        self.sender.send(CompareRequest{left:left.into(),right:right.into(),mode,reply}).map_err(|_|"Store collation worker stopped")?;
        result.recv().map_err(|_|"Store collation worker stopped before replying")?
    }
}

/// Construct once, then call `refresh` before each store operation to match
/// JavaScript's current-time defaults. The JS callers supply no exclusions;
/// optional native exclusions are additive to current_exe and Arc Power names.
#[derive(Clone)]
pub struct NativeStoreContext{
    clock:ClockSnapshot,location:String,current_exe:Value,excluded_paths:Vec<Value>,comparator:Arc<Comparator>,
}
impl NativeStoreContext{
    pub fn new()->Result<Self,String>{
        Self::with_locale_and_exclusions(&platform_context::current_user_bcp47_locale().map_err(|e|e.to_string())?,Vec::new())
    }
    pub fn with_locale_and_exclusions(locale:&str,excluded_paths:Vec<Value>)->Result<Self,String>{
        let clock=platform_context::clock_snapshot().map_err(|e|e.to_string())?;
        let location=platform_context::known_folder_path(KnownFolder::Videos).map_err(|e|e.to_string())?.join("Arc Power")
            .into_os_string().into_string().map_err(|_|"Videos folder contains unsupported UTF-16")?;
        let current_exe=Value::String(std::env::current_exe().map_err(|e|e.to_string())?.into_os_string().into_string().map_err(|_|"Current executable contains unsupported UTF-16")?);
        if game_candidate::canonical_exe_path(&current_exe).is_none(){return Err("Current executable has no supported Win32 identity".into());}
        SystemWin32Paths.current_directory()?;
        platform_context::uuid_v4().map_err(|e|e.to_string())?;
        let comparator=Arc::new(Comparator::new(locale.into())?);
        Ok(Self{clock,location,current_exe,excluded_paths,comparator})
    }
    pub fn refresh(&self)->Result<Self,String>{let mut next=self.clone();next.clock=platform_context::clock_snapshot().map_err(|e|e.to_string())?;Ok(next)}
    pub fn clock(&self)->&ClockSnapshot{&self.clock}
    pub fn try_compare_text(&self,left:&str,right:&str,mode:StoreCollation)->Result<Ordering,String>{self.comparator.compare(left,right,mode)}
    // Existing pure contracts return Ordering. Fail closed on a runtime ICU
    // failure: the host must catch_unwind at the request boundary. Unwinding a
    // sidecar transaction cannot commit a partially sorted document.
    fn compare(&self,left:&str,right:&str,mode:StoreCollation)->Ordering{
        self.try_compare_text(left,right,mode).unwrap_or_else(|error|panic!("Native store collation failed: {error}"))
    }
}
impl RecordingMetadataContext for NativeStoreContext{
    fn now_iso(&self)->&str{&self.clock.now_iso}
    fn compare_text(&self,left:&str,right:&str,mode:RecordingCollation)->Ordering{self.compare(left,right,match mode{RecordingCollation::Default=>StoreCollation::Default,RecordingCollation::NumericBase=>StoreCollation::NumericBase})}
}
impl Win32PathContext for NativeStoreContext{
    fn current_directory(&self)->Result<String,String>{SystemWin32Paths.current_directory()}
    fn drive_current_directory(&self,drive:&str)->Option<String>{SystemWin32Paths.drive_current_directory(drive)}
}
impl RecordingStoreContext for NativeStoreContext{
    fn uuid(&self)->String{platform_context::uuid_v4().unwrap_or_else(|error|panic!("Native store UUID failed: {error}"))}
    fn default_location(&self)->&str{&self.location}
}
impl GameProfileContext for NativeStoreContext{
    fn now_iso(&self)->&str{&self.clock.now_iso}
    fn canonical_exe_path(&self,value:&Value)->Option<String>{game_candidate::canonical_exe_path(value)}
    fn is_safe_existing_game(&self,value:&Value)->bool{game_candidate::validate_safe_game_candidate(value,&self.current_exe,&self.excluded_paths,true).is_some()}
    fn compare_text(&self,left:&str,right:&str,base:bool)->Ordering{self.compare(left,right,if base{StoreCollation::Base}else{StoreCollation::Default})}
}
impl GameProfileStoreContext for NativeStoreContext{
    fn is_safe_candidate_without_existence(&self,value:&Value)->bool{game_candidate::validate_safe_game_candidate(value,&self.current_exe,&self.excluded_paths,false).is_some()}
    fn executable_exists(&self,value:&Value)->bool{game_candidate::canonical_exe_path(value).is_some_and(|path|std::fs::metadata(path).map(|m|m.is_file()).unwrap_or(false))}
}

#[cfg(test)]
mod tests{
    use super::*;
    #[test]
    fn context_is_send_sync(){fn assert_traits<T:Send+Sync>(){}assert_traits::<NativeStoreContext>();}
    #[test]
    fn invalid_locale_fails_worker_initialization(){assert!(Comparator::new("en_US".into()).is_err());}
    #[test]
    #[cfg(windows)]
    fn shared_worker_matches_numeric_base_and_default_options(){
        let worker=Arc::new(Comparator::new("en-US".into()).unwrap());
        let threads:Vec<_>=(0..4).map(|_|{let worker=worker.clone();std::thread::spawn(move||{
            assert_eq!(worker.compare("file2","file10",StoreCollation::NumericBase).unwrap(),Ordering::Less);
            assert_eq!(worker.compare("file2","file10",StoreCollation::Default).unwrap(),Ordering::Greater);
            assert_eq!(worker.compare("Ä","a",StoreCollation::Base).unwrap(),Ordering::Equal);
        })}).collect();for thread in threads{thread.join().unwrap();}
    }
    #[test]
    #[cfg(windows)]
    fn native_snapshot_uses_known_videos_folder_and_real_exclusions(){
        let ctx=NativeStoreContext::new().unwrap();
        assert_eq!(std::path::Path::new(ctx.default_location()),platform_context::known_folder_path(KnownFolder::Videos).unwrap().join("Arc Power"));
        assert!(!ctx.is_safe_candidate_without_existence(&ctx.current_exe));
        assert!(ctx.is_safe_candidate_without_existence(&Value::String("C:\\Games\\missing.exe".into())));
        assert!(!ctx.is_safe_existing_game(&Value::String("C:\\Games\\missing.exe".into())));
        assert!(ctx.refresh().unwrap().clock.now_ms>=ctx.clock.now_ms);
    }
}
