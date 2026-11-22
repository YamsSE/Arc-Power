//! Recording settings/index/marker service. Media files are read for scan facts
//! only; delete_clip removes metadata, exactly as the JavaScript store does.
use super::{sidecar_file::{Sidecar,SidecarFile},store_file::reject_reparse_components,recording_contract::{self as contract,RECORDING_SCHEMA_VERSION,RECORDING_EDITOR_VERSION},recording_paths::{self as paths,RecordingMetadataContext,Win32PathContext}};
use serde_json::{json,Map,Value};
use std::{collections::HashMap,fs,path::{Component,Path,PathBuf},sync::{Arc,Mutex},time::{SystemTime,UNIX_EPOCH}};
use base64::Engine;

pub trait RecordingStoreContext:RecordingMetadataContext+Win32PathContext+Send+Sync {
    fn uuid(&self)->String;
    fn default_location(&self)->&str;
}
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct FileIdentity{pub volume:u64,pub file:u64}
#[derive(Debug,Clone)]
pub struct RecordingFileFacts{pub directory:bool,pub file:bool,pub reparse:bool,pub byte_length:u64,pub created_at:String,pub modified_at:String,pub identity:Option<FileIdentity>}
pub trait RecordingScanFs:Send+Sync {
    fn facts(&self,path:&Path)->Result<RecordingFileFacts,String>;
    fn entries(&self,path:&Path)->Result<Vec<String>,String>;
}
pub struct NativeRecordingFs;
fn iso_time(value:SystemTime)->Result<String,String>{
    let millis:i128=match value.duration_since(UNIX_EPOCH){Ok(d)=>i128::try_from(d.as_millis()).map_err(|_|"File timestamp overflow")?,Err(e)=>-i128::try_from(e.duration().as_millis()).map_err(|_|"File timestamp overflow")?};
    let days=millis.div_euclid(86_400_000);let rest=millis.rem_euclid(86_400_000);let z=days+719468;let era=z.div_euclid(146097);let day=z-era*146097;let year=(day-day/1460+day/36524-day/146096)/365;let mut year=year+era*400;let doy=day-(365*year.rem_euclid(400)+year.rem_euclid(400)/4-year.rem_euclid(400)/100);let month=(5*doy+2)/153;let date=doy-(153*month+2)/5+1;let month=month+if month<10{3}else{-9};if month<=2{year+=1;}
    if !(0..=9999).contains(&year){return Err("File timestamp is outside supported ISO year range".into());}
    Ok(format!("{year:04}-{month:02}-{date:02}T{:02}:{:02}:{:02}.{:03}Z",rest/3_600_000,(rest/60_000)%60,(rest/1000)%60,rest%1000))
}
#[cfg(windows)]
fn directory_identity(path:&Path,_metadata:&fs::Metadata)->Result<FileIdentity,String>{
    use std::{fs::OpenOptions,os::windows::{fs::OpenOptionsExt,io::AsRawHandle}};
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle,BY_HANDLE_FILE_INFORMATION,FILE_FLAG_BACKUP_SEMANTICS,FILE_FLAG_OPEN_REPARSE_POINT,FILE_SHARE_READ,FILE_SHARE_WRITE,FILE_SHARE_DELETE};
    let file=OpenOptions::new().access_mode(0).share_mode(FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE).custom_flags(FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT).open(path).map_err(|e|e.to_string())?;
    let mut info:BY_HANDLE_FILE_INFORMATION=unsafe{std::mem::zeroed()};if unsafe{GetFileInformationByHandle(file.as_raw_handle()as _,&mut info)}==0{return Err(std::io::Error::last_os_error().to_string());}
    if info.dwFileAttributes&0x400!=0{return Err("Recording root is a reparse point".into());}Ok(FileIdentity{volume:u64::from(info.dwVolumeSerialNumber),file:(u64::from(info.nFileIndexHigh)<<32)|u64::from(info.nFileIndexLow)})
}
#[cfg(unix)]
fn directory_identity(_path:&Path,metadata:&fs::Metadata)->Result<FileIdentity,String>{use std::os::unix::fs::MetadataExt;Ok(FileIdentity{volume:metadata.dev(),file:metadata.ino()})}
#[cfg(not(any(windows,unix)))]
fn directory_identity(_path:&Path,_metadata:&fs::Metadata)->Result<FileIdentity,String>{Err("Recording directory identity is unavailable".into())}
impl RecordingScanFs for NativeRecordingFs {
    fn facts(&self,path:&Path)->Result<RecordingFileFacts,String>{
        if let Some(parent)=path.parent(){reject_reparse_components(parent)?;}let metadata=fs::symlink_metadata(path).map_err(|e|e.to_string())?;
        let mut reparse=metadata.file_type().is_symlink();
        #[cfg(windows)]{use std::os::windows::fs::MetadataExt;reparse|=metadata.file_attributes()&0x400!=0;}
        let directory=metadata.is_dir();let identity=if directory&&!reparse{Some(directory_identity(path,&metadata)?)}else{None};
        let created_at=if metadata.is_file()&&!reparse{iso_time(metadata.created().map_err(|e|e.to_string())?)?}else{String::new()};
        let modified_at=if metadata.is_file()&&!reparse{iso_time(metadata.modified().map_err(|e|e.to_string())?)?}else{String::new()};
        Ok(RecordingFileFacts{directory,file:metadata.is_file(),reparse,byte_length:metadata.len(),created_at,modified_at,identity})
    }
    fn entries(&self,path:&Path)->Result<Vec<String>,String>{reject_reparse_components(path)?;fs::read_dir(path).map_err(|e|e.to_string())?.map(|entry|entry.map_err(|e|e.to_string())?.file_name().into_string().map_err(|_|"Recording filename contains unsupported UTF-16".into())).collect()}
}
fn safe_id(value:Option<&Value>)->Option<&str>{value.and_then(Value::as_str).filter(|s|(8..=128).contains(&s.len())&&s.bytes().all(|b|b.is_ascii_alphanumeric()||matches!(b,b'_'|b'-')))}
fn nullish<'a>(a:Option<&'a Value>,b:Option<&'a Value>)->Option<&'a Value>{a.filter(|v|!v.is_null()).or(b)}
fn truthy(v:&Value)->bool{match v{Value::Null=>false,Value::Bool(b)=>*b,Value::Number(n)=>n.as_f64().is_some_and(|n|n!=0.0),Value::String(s)=>!s.is_empty(),_=>true}}
fn number(value:Option<&Value>)->Option<f64>{match value?{Value::Null=>Some(0.0),Value::Bool(b)=>Some(if *b{1.0}else{0.0}),Value::Number(n)=>n.as_f64().filter(|n|n.is_finite()),Value::String(s)=>{let s=s.trim();if s.is_empty(){Some(0.0)}else if let Some(h)=s.strip_prefix("0x").or_else(||s.strip_prefix("0X")){u64::from_str_radix(h,16).ok().map(|n|n as f64)}else{s.parse::<f64>().ok().filter(|n|n.is_finite())}},Value::Array(a)if a.is_empty()=>Some(0.0),Value::Array(a)if a.len()==1=>number(if a[0].is_null(){Some(&Value::Null)}else{Some(&a[0])}),_=>None}}
fn object(value:Option<&Value>)->Map<String,Value>{value.and_then(Value::as_object).cloned().unwrap_or_default()}
fn merge(mut base:Map<String,Value>,patch:Option<&Value>)->Map<String,Value>{for(k,v)in object(patch){base.insert(k,v);}base}
fn sort<C:RecordingMetadataContext>(clips:Vec<Value>,ctx:&C)->Vec<Value>{paths::sort_recording_clips(Some(&Value::Array(clips)),ctx)}
fn decode_selection(value:&str)->Option<Value>{let s=value.strip_prefix("arc-gpu-encoder:v1:")?;let s=s.split('=').next()?.chars().filter(|c|c.is_ascii_alphanumeric()||matches!(c,'-'|'_'|'+'|'/')).collect::<String>().replace('-',"+").replace('_',"/");let mut s=s;s.push_str(&"=".repeat((4-s.len()%4)%4));let config=base64::engine::general_purpose::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true);let engine=base64::engine::general_purpose::GeneralPurpose::new(&base64::alphabet::STANDARD,config);let bytes=engine.decode(s).ok()?;serde_json::from_str(&String::from_utf8_lossy(&bytes)).ok()}
fn encoder_target_key(target:&Value)->Option<String>{
    if !target.is_object()&&!target.is_array(){return None;}let key=nullish(target.get("deviceKey"),target.get("device_key")).and_then(Value::as_str).unwrap_or("").trim();
    let raw=target.get("bdf");let integer=|v:Option<&Value>|number(v).filter(|n|n.fract()==0.0&&n.abs()<=9_007_199_254_740_991.0);
    let bdf=(||{if let Some(a)=raw.and_then(Value::as_array){let domain=number(a.first()).unwrap_or(0.0);Some(json!({"domain":domain,"bus":integer(a.get(1))?,"device":integer(a.get(2))?,"function":integer(a.get(3))?}))}
        else if let Some(b)=raw.filter(|v|v.is_object()){Some(json!({"domain":number(b.get("domain")).unwrap_or(0.0),"bus":integer(b.get("bus"))?,"device":integer(b.get("device"))?,"function":integer(nullish(b.get("function"),nullish(b.get("func"),Some(&json!(0)))))?}))}else{None}})();
    let luid=nullish(target.get("luid"),nullish(target.get("adapterLuid"),target.get("adapter_luid"))).cloned().unwrap_or(Value::Null);if key.is_empty()&&bdf.is_none()&&(luid.is_null()||luid==json!("")){return None;}
    Some(json!({"deviceKey":if key.is_empty(){Value::Null}else{json!(key)},"bdf":bdf,"luid":luid}).to_string())
}
fn persisted_encoder_matches(value:&Value,selection:&str,target:&Value)->bool{
    let Some(stored)=value.as_str().and_then(decode_selection)else{return false;};let requested=if selection.starts_with("arc-gpu-encoder:v1:"){let Some(requested)=decode_selection(selection)else{return false;};Some(requested)}else{None};
    let expected=nullish(requested.as_ref().and_then(|v|v.get("codec")),requested.as_ref().and_then(|v|v.get("c"))).cloned().unwrap_or(json!(selection));let codec=nullish(stored.get("codec"),stored.get("c"));
    let compact=json!({"deviceKey":stored.get("k").filter(|v|v.is_string()),"bdf":stored.get("b").filter(|v|v.is_array()),"luid":stored.get("l")});let stored_target=stored.get("target").filter(|v|!v.is_null()).unwrap_or(&compact);
    codec==Some(&expected)&&encoder_target_key(stored_target)==encoder_target_key(target)
}

pub struct RecordingStore<C:RecordingStoreContext,F:RecordingScanFs=NativeRecordingFs>{files:Arc<SidecarFile>,ctx:Arc<C>,scan_fs:Arc<F>,mutation:Mutex<()>}
impl<C:RecordingStoreContext> RecordingStore<C,NativeRecordingFs>{
    pub fn new(root:PathBuf,ctx:Arc<C>)->Result<Self,String>{Ok(Self{files:Arc::new(SidecarFile::new(root,Sidecar::Recording)?),ctx,scan_fs:Arc::new(NativeRecordingFs),mutation:Mutex::new(())})}
}
impl<C:RecordingStoreContext,F:RecordingScanFs> RecordingStore<C,F>{
    /// Share this RecordingStore through Arc so every public mutation observes
    /// one queue. The supplied SidecarFile also serializes its file transaction.
    pub fn with_files(files:Arc<SidecarFile>,ctx:Arc<C>,scan_fs:Arc<F>)->Self{Self{files,ctx,scan_fs,mutation:Mutex::new(())}}
    fn data(&self,raw:Option<&Value>)->Result<Value,String>{
        if number(raw.and_then(|v|v.get("schemaVersion"))).is_some_and(|n|n>RECORDING_SCHEMA_VERSION as f64){return Err("recording.json was created by a newer Arc Power version".into());}
        let settings_input=nullish(raw.and_then(|v|v.get("settings")),raw);let mut settings=contract::normalize_recording_settings(settings_input);if settings["location"]==json!(""){settings["location"]=json!(self.ctx.default_location());}
        let mut clips=Vec::new();for clip in raw.and_then(|v|v.get("clips")).and_then(Value::as_array).into_iter().flatten(){if let Some(clip)=contract::normalize_recording_clip(Some(clip))?{clips.push(clip);}}
        let markers=contract::normalize_recording_markers(raw.and_then(|v|v.get("markers")),self.ctx.now_iso())?;
        Ok(json!({"schemaVersion":RECORDING_SCHEMA_VERSION,"settings":settings,"clips":sort(clips,self.ctx.as_ref()),"markers":markers}))
    }
    fn read_data(&self,raw:Option<&Value>)->Result<(Value,bool),String>{
        let data=self.data(raw)?;let raw_settings=raw.and_then(|v|v.get("settings")).filter(|v|v.is_object()||v.is_array()).or(raw);
        let mode_changed=raw_settings.and_then(|v|v.get("mode")).is_some_and(|v|v!=&data["settings"]["mode"]);
        let invalid_clips=raw.and_then(|v|v.get("clips")).and_then(Value::as_array).is_some_and(|v|v.len()!=data["clips"].as_array().unwrap().len());
        let migration=raw.and_then(|v|v.get("schemaVersion")).and_then(Value::as_f64)!=Some(RECORDING_SCHEMA_VERSION as f64)||mode_changed||invalid_clips;Ok((data,migration))
    }
    fn lock(&self)->Result<std::sync::MutexGuard<'_,()>,String>{self.mutation.lock().map_err(|_|"Recording mutation lock was poisoned".into())}
    pub fn load_sync(&self)->Result<Value,String>{self.data(self.files.read()?.as_ref())}
    pub fn load(&self)->Result<Value,String>{let _queue=self.lock()?;self.files.transaction_optional(|raw|{let(data,migrate)=self.read_data(raw.as_ref())?;Ok((migrate.then(||data.clone()),data))})}
    pub fn settings(&self)->Result<Value,String>{Ok(self.load()?["settings"].clone())}
    pub fn list_clips(&self)->Result<Vec<Value>,String>{Ok(self.load()?["clips"].as_array().unwrap().clone())}
    pub fn save_settings(&self,patch:Option<&Value>)->Result<Value,String>{let _queue=self.lock()?;self.files.transaction_optional(|raw|{
        let(mut data,_)=self.read_data(raw.as_ref())?;let current=&data["settings"];let mut settings=merge(object(Some(current)),patch);
        let mut audio=merge(object(current.get("audio")),patch.and_then(|v|v.get("audio")));
        for key in["microphone","system"]{audio.insert(key.into(),Value::Object(merge(object(current.get("audio").and_then(|v|v.get(key))),patch.and_then(|v|v.get("audio")).and_then(|v|v.get(key)))));}
        settings.insert("audio".into(),Value::Object(audio));for key in["captureTarget","hotkeys"]{settings.insert(key.into(),Value::Object(merge(object(current.get(key)),patch.and_then(|v|v.get(key)))));}
        let settings=contract::normalize_recording_settings(Some(&Value::Object(settings)));data["settings"]=settings.clone();Ok((Some(data),settings))})}
    pub fn demote_encoder(&self,selection:Option<&Value>,adapter_target:Option<&Value>)->Result<Value,String>{
        let Some(selection)=selection.and_then(Value::as_str).filter(|s|!s.is_empty())else{return self.settings();};let _queue=self.lock()?;
        self.files.transaction_optional(|raw|{let(mut data,_)=self.read_data(raw.as_ref())?;let matches=if let Some(target)=adapter_target.filter(|v|truthy(v)){persisted_encoder_matches(&data["settings"]["encoderId"],selection,target)}else{data["settings"]["encoderId"]==json!(selection)};
            if !matches{return Ok((None,data["settings"].clone()));}data["settings"]["encoderId"]=json!("automatic");let settings=contract::normalize_recording_settings(Some(&data["settings"]));data["settings"]=settings.clone();Ok((Some(data),settings))})
    }
    pub fn replace_clips(&self,clips:Option<&Value>)->Result<Vec<Value>,String>{let _queue=self.lock()?;self.files.transaction_optional(|raw|{let(mut data,_)=self.read_data(raw.as_ref())?;let clips=sort(clips.and_then(Value::as_array).into_iter().flatten().filter(|v|safe_id(v.get("id")).is_some()).take(5000).cloned().collect(),self.ctx.as_ref());data["clips"]=json!(clips);Ok((Some(data),clips))})}
    pub fn add_marker(&self,marker:Option<&Value>)->Result<Value,String>{let _queue=self.lock()?;self.files.transaction_optional(|raw|{let(mut data,_)=self.read_data(raw.as_ref())?;let mut marker=object(marker);if marker.get("id").is_none_or(Value::is_null){marker.insert("id".into(),json!(self.ctx.uuid()));}let marker=contract::normalize_recording_marker(Some(&Value::Object(marker)),self.ctx.now_iso())?.ok_or("Invalid recording marker")?;let mut markers=data["markers"].as_array().unwrap().clone();markers.push(marker.clone());data["markers"]=json!(contract::normalize_recording_markers(Some(&json!(markers)),self.ctx.now_iso())?);Ok((Some(data),marker))})}
    pub fn list_markers(&self,options:Option<&Value>)->Result<Vec<Value>,String>{if options==Some(&Value::Null){return Err("Cannot read properties of null (reading 'sessionId')".into());}let data=self.load()?;let session=options.and_then(|v|v.get("sessionId")).filter(|v|truthy(v));let clip=options.and_then(|v|v.get("clipId")).filter(|v|truthy(v));Ok(data["markers"].as_array().unwrap().iter().filter(|m|session.is_none_or(|v|m.get("sourceSessionId")==Some(v))&&clip.is_none_or(|v|m.get("clipId")==Some(v))).cloned().collect())}
    pub fn record_clip(&self,options:Option<&Value>)->Result<Value,String>{if options==Some(&Value::Null){return Err("Cannot destructure property 'relativePath' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.".into());}let _queue=self.lock()?;self.files.transaction_optional(|raw|{
        let(mut data,_)=self.read_data(raw.as_ref())?;let get=|key|options.and_then(|v|v.get(key));let relative=get("relativePath").and_then(Value::as_str).filter(|s|!s.is_empty()).ok_or("Invalid recording clip path")?;if contract::safe_video_extension(&json!(relative)).is_none(){return Err("Invalid recording clip path".into());}
        let existing=data["clips"].as_array().unwrap().iter().find(|v|v["relativePath"]==json!(relative));let mut clip=object(existing);clip.insert("id".into(),existing.and_then(|v|v.get("id")).cloned().unwrap_or_else(||json!(self.ctx.uuid())));clip.insert("relativePath".into(),json!(relative));
        let basename=relative.trim_end_matches(['\\','/']).rsplit(['\\','/']).next().unwrap_or(relative);clip.insert("fileName".into(),nullish(get("fileName"),Some(&json!(basename))).cloned().unwrap());clip.insert("createdAt".into(),existing.and_then(|v|v.get("createdAt")).cloned().unwrap_or_else(||get("createdAt").cloned().unwrap_or_else(||json!(self.ctx.now_iso()))));
        clip.insert("markerSummaries".into(),get("markerSummaries").cloned().unwrap_or(json!([])));for key in["apmSamples","apmAverage","apmPeak","apmAvailable"]{if let Some(value)=get(key){if key=="apmSamples"||(key=="apmAvailable"&&value.is_boolean())||value.as_f64().is_some_and(|n|n.is_finite()){clip.insert(key.into(),value.clone());}}}clip.insert("editorVersion".into(),get("editorVersion").cloned().unwrap_or(json!(RECORDING_EDITOR_VERSION)));
        let clip=contract::normalize_recording_clip(Some(&Value::Object(clip)))?.ok_or("Invalid recording clip metadata")?;let mut clips:Vec<_>=data["clips"].as_array().unwrap().iter().filter(|v|v["relativePath"]!=json!(relative)).cloned().collect();clips.push(clip.clone());data["clips"]=json!(sort(clips,self.ctx.as_ref()));Ok((Some(data),clip))})}
    pub fn attach_markers_to_clip(&self,options:Option<&Value>)->Result<Value,String>{if options==Some(&Value::Null){return Err("Cannot destructure property 'relativePath' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.".into());}let _queue=self.lock()?;self.files.transaction_optional(|raw|{
        let(mut data,_)=self.read_data(raw.as_ref())?;let get=|key|options.and_then(|v|v.get(key));let Some(clip)=data["clips"].as_array().unwrap().iter().find(|v|v.get("relativePath")==get("relativePath")).cloned()else{return Ok((None,Value::Null));};
        let legacy=get("sourceSessionId").is_none()&&get("sessionId").and_then(Value::as_str).is_some_and(|s|!s.trim().is_empty());let mapping=paths::map_recording_markers_to_clip(Some(&data["markers"]),Some(&json!({"sourceSessionId":nullish(get("sourceSessionId"),get("sessionId")),"sourceStartMs":if legacy{json!(0)}else{get("sourceStartMs").cloned().unwrap_or(Value::Null)},"sourceEndMs":if legacy{json!(86_400_000)}else{get("sourceEndMs").cloned().unwrap_or(Value::Null)}})),self.ctx.as_ref())?;
        let mut clips=Vec::new();for mut item in data["clips"].as_array().unwrap().clone(){if item["id"]==clip["id"]&&mapping["mapped"]==true{item["markerSummaries"]=mapping["attached"].clone();item["editorVersion"]=json!(RECORDING_EDITOR_VERSION);item=contract::normalize_recording_clip(Some(&item))?.unwrap_or(Value::Null);}clips.push(item);}
        let mapped=clips.iter().find(|v|v.get("id")==clip.get("id")).cloned().unwrap_or(Value::Null);data["clips"]=json!(sort(clips,self.ctx.as_ref()));data["markers"]=mapping["retained"].clone();let counts=json!({"mapped":mapping["mapped"],"reason":mapping["reason"],"retainedMarkerCount":mapping["retained"].as_array().unwrap().len(),"attachedMarkerCount":mapping["attached"].as_array().unwrap().len()});let mut result=object(Some(&mapped));result.insert("clip".into(),mapped);for(k,v)in counts.as_object().unwrap(){result.insert(k.clone(),v.clone());}result.insert("markerMapping".into(),counts);Ok((Some(data),Value::Object(result)))})}
    pub fn clip_by_id(&self,id:Option<&Value>)->Result<Value,String>{let Some(id)=safe_id(id)else{return Ok(Value::Null);};Ok(self.load()?["clips"].as_array().unwrap().iter().find(|clip|clip["id"]==json!(id)).cloned().unwrap_or(Value::Null))}
    pub fn delete_clip(&self,id:Option<&Value>)->Result<Value,String>{let Some(id)=safe_id(id)else{return Ok(Value::Null);};let _queue=self.lock()?;self.files.transaction_optional(|raw|{let(mut data,_)=self.read_data(raw.as_ref())?;let Some(clip)=data["clips"].as_array().unwrap().iter().find(|v|v["id"]==json!(id)).cloned()else{return Ok((None,Value::Null));};let clips=data["clips"].as_array().unwrap().iter().filter(|v|v["id"]!=json!(id)).cloned().collect();data["clips"]=json!(sort(clips,self.ctx.as_ref()));Ok((Some(data),clip))})}
    fn walk(&self,root:&Path,directory:&Path,depth:usize,known:&HashMap<String,Value>,found:&mut Vec<Value>)->Result<(),String>{
        if depth>4{return Ok(());}let facts=self.scan_fs.facts(directory)?;if facts.reparse||!facts.directory{return Err("Recording scan directory is unavailable or a reparse point".into());}
        for name in self.scan_fs.entries(directory)?{let name_path=Path::new(&name);if name.contains(['\\','/','\0'])||name_path.components().count()!=1||!matches!(name_path.components().next(),Some(Component::Normal(_))){return Err("Invalid recording scan entry name".into());}let full=directory.join(&name);let stat=self.scan_fs.facts(&full)?;if stat.reparse{continue;}if stat.directory{self.walk(root,&full,depth+1,known,found)?;}else if stat.file&&contract::safe_video_extension(&json!(full.to_string_lossy())).is_some()&&!contract::is_recording_temporary_artifact(&json!(full.to_string_lossy())){
            let relative=full.strip_prefix(root).map_err(|_|"Recording scan escaped configured root")?.to_str().ok_or("Recording relative path contains unsupported UTF-16")?.to_owned();let old=known.get(&relative);let mut clip=object(old);clip.insert("id".into(),old.and_then(|v|v.get("id")).cloned().unwrap_or_else(||json!(self.ctx.uuid())));clip.insert("fileName".into(),json!(name));clip.insert("relativePath".into(),json!(relative));clip.insert("createdAt".into(),old.and_then(|v|v.get("createdAt")).cloned().unwrap_or(json!(stat.created_at)));clip.insert("modifiedAt".into(),json!(stat.modified_at));clip.insert("byteLength".into(),json!(stat.byte_length));found.push(Value::Object(clip));}}
        Ok(())
    }
    pub fn scan_clips(&self)->Result<Vec<Value>,String>{
        let _queue=self.lock()?;let(current,_)=self.read_data(self.files.read()?.as_ref())?;let unchanged=||current["clips"].as_array().unwrap().clone();let location=current["settings"]["location"].as_str().unwrap();if location.is_empty(){return Ok(unchanged());}
        let Ok(root)=paths::recording_absolute_path(Some(&json!(location)),"location",self.ctx.as_ref()).map(PathBuf::from)else{return Ok(unchanged());};let Ok(initial)=self.scan_fs.facts(&root)else{return Ok(unchanged());};if initial.reparse||!initial.directory||initial.identity.is_none(){return Ok(unchanged());}
        let known=current["clips"].as_array().unwrap().iter().map(|clip|(clip["relativePath"].as_str().unwrap().to_owned(),clip.clone())).collect();let mut found=Vec::new();if self.walk(&root,&root,0,&known,&mut found).is_err(){return Ok(unchanged());}
        let Ok(final_root)=self.scan_fs.facts(&root)else{return Ok(unchanged());};if final_root.reparse||!final_root.directory||final_root.identity!=initial.identity{return Ok(unchanged());}
        self.files.transaction_optional(|raw|{let(mut latest,_)=self.read_data(raw.as_ref())?;if latest["settings"]["location"]!=current["settings"]["location"]{return Ok((None,latest["clips"].as_array().unwrap().clone()));}let clips=sort(found,self.ctx.as_ref());latest["clips"]=json!(clips);Ok((Some(latest),clips))})
    }
}

#[cfg(test)]
mod tests{
    use super::*;
    use super::super::recording_paths::RecordingCollation;
    use std::sync::atomic::{AtomicUsize,Ordering as AtomicOrdering};
    struct Temp(PathBuf);
    impl Temp{fn new()->Self{let root=std::env::temp_dir().join(format!("arc-recording-store-test-{:032x}",rand::random::<u128>()));fs::create_dir(&root).unwrap();Self(root)}}
    impl Drop for Temp{fn drop(&mut self){let Ok(root)=fs::canonicalize(&self.0)else{return;};let Ok(temp)=fs::canonicalize(std::env::temp_dir())else{return;};if root.parent()==Some(temp.as_path())&&root.file_name().and_then(|n|n.to_str()).is_some_and(|n|n.starts_with("arc-recording-store-test-"))&&!fs::symlink_metadata(&self.0).map(|m|m.file_type().is_symlink()).unwrap_or(true){let _=fs::remove_dir_all(root);}}}
    struct Context{now:String,location:String,comparisons:Value,uuid:AtomicUsize}
    impl RecordingMetadataContext for Context{
        fn now_iso(&self)->&str{&self.now}
        fn compare_text(&self,left:&str,right:&str,mode:RecordingCollation)->std::cmp::Ordering{
            if left==right{return std::cmp::Ordering::Equal;}
            let row=self.comparisons.as_array().unwrap().iter().find(|r|r[0].as_str()==Some(left)&&r[1].as_str()==Some(right)&&r[2].as_bool()==Some(mode==RecordingCollation::NumericBase)).unwrap_or_else(||panic!("Missing original locale comparator: {left:?} {right:?} {mode:?}"));row[3].as_i64().unwrap().cmp(&0)
        }
    }
    impl Win32PathContext for Context{fn current_directory(&self)->Result<String,String>{Ok("C:\\Fixture".into())}fn drive_current_directory(&self,_drive:&str)->Option<String>{None}}
    impl RecordingStoreContext for Context{fn uuid(&self)->String{format!("recording_{:06}",self.uuid.fetch_add(1,AtomicOrdering::SeqCst)+1)}fn default_location(&self)->&str{&self.location}}
    fn context(data:&Value)->Arc<Context>{Arc::new(Context{now:data["now"].as_str().unwrap().into(),location:data["defaultLocation"].as_str().unwrap().into(),comparisons:data["comparisons"].clone(),uuid:AtomicUsize::new(0)})}
    fn equivalent(a:&Value,b:&Value)->bool{match(a,b){(Value::Number(a),Value::Number(b))=>a.as_f64()==b.as_f64(),(Value::Array(a),Value::Array(b))=>a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|equivalent(a,b)),(Value::Object(a),Value::Object(b))=>a.len()==b.len()&&a.iter().all(|(k,a)|b.get(k).is_some_and(|b|equivalent(a,b))),_=>a==b}}
    fn file_bytes(path:&Path)->Option<Vec<u8>>{match fs::read(path){Ok(bytes)=>Some(bytes),Err(e)if e.kind()==std::io::ErrorKind::NotFound=>None,Err(e)=>panic!("Cannot inspect test sidecar: {e}")}}
    #[test]
    fn original_javascript_recording_store_operation_sequences(){
        let data:Value=serde_json::from_str(include_str!("fixtures/recording-store-parity.json")).unwrap();let mut count=0;
        for sequence in data["fixtures"].as_array().unwrap(){let temp=Temp::new();let sidecar=temp.0.join("recording.json");if !sequence["initial"].is_null(){let mut bytes=vec![0xef,0xbb,0xbf];bytes.extend(serde_json::to_vec(&sequence["initial"]).unwrap());fs::write(&sidecar,bytes).unwrap();}let ctx=context(&data);let store=RecordingStore::new(temp.0.clone(),ctx.clone()).unwrap();
            for step in sequence["operations"].as_array().unwrap(){count+=1;let method=step["method"].as_str().unwrap();let args=step["args"].as_array().unwrap();let arg=|i|args.get(i);let before=file_bytes(&sidecar);
                let result:Result<Value,String>=match method{"loadSync"=>store.load_sync(),"load"=>store.load(),"settings"=>store.settings(),"saveSettings"=>store.save_settings(arg(0)),"demoteEncoder"=>store.demote_encoder(arg(0),arg(1)),"listClips"=>store.list_clips().map(|v|json!(v)),"replaceClips"=>store.replace_clips(arg(0)).map(|v|json!(v)),"addMarker"=>store.add_marker(arg(0)),"listMarkers"=>store.list_markers(arg(0)).map(|v|json!(v)),"recordClip"=>store.record_clip(arg(0)),"attachMarkersToClip"=>store.attach_markers_to_clip(arg(0)),"clipById"=>store.clip_by_id(arg(0)),"deleteClip"=>store.delete_clip(arg(0)),_=>panic!("Unrecognized original method {method}")};
                if let Some(error)=step.get("error"){assert_eq!(result.unwrap_err(),error.as_str().unwrap(),"{} {method}",sequence["name"]);}else{let actual=result.unwrap_or_else(|e|panic!("{} {method}: {e}",sequence["name"]));assert!(equivalent(&actual,&step["expected"]),"{} {method}: actual={actual} expected={}",sequence["name"],step["expected"]);}
                let raw=store.files.read().unwrap().unwrap_or(Value::Null);assert!(equivalent(&raw,&step["rawAfter"]),"{} {method}: stored={raw} expected={}",sequence["name"],step["rawAfter"]);
                if step["writes"]==0{assert_eq!(file_bytes(&sidecar),before,"{method} must not rewrite sidecar");}assert_eq!(ctx.uuid.load(AtomicOrdering::SeqCst),step["uuidCalls"].as_u64().unwrap()as usize,"{} {method}: UUID call count",sequence["name"]);
            }
        }assert_eq!(count,60);
    }
    #[test]
    fn file_dates_and_corrupt_data_fail_without_replacing_bytes(){
        assert_eq!(iso_time(UNIX_EPOCH).unwrap(),"1970-01-01T00:00:00.000Z");assert_eq!(iso_time(UNIX_EPOCH+std::time::Duration::from_secs(1709164800)).unwrap(),"2024-02-29T00:00:00.000Z");
        let data:Value=serde_json::from_str(include_str!("fixtures/recording-store-parity.json")).unwrap();let temp=Temp::new();let path=temp.0.join("recording.json");fs::write(&path,b"broken original bytes").unwrap();let store=RecordingStore::new(temp.0.clone(),context(&data)).unwrap();assert!(store.save_settings(Some(&json!({"fps":144}))).is_err());assert_eq!(fs::read(path).unwrap(),b"broken original bytes");
    }
    #[test]
    fn concurrent_nested_patches_reload_latest_and_metadata_delete_keeps_media(){
        let data:Value=serde_json::from_str(include_str!("fixtures/recording-store-parity.json")).unwrap();let temp=Temp::new();let store=Arc::new(RecordingStore::new(temp.0.clone(),context(&data)).unwrap());store.load().unwrap();
        let a={let store=store.clone();std::thread::spawn(move||store.save_settings(Some(&json!({"audio":{"microphone":{"enabled":true}}}))).unwrap())};let b={let store=store.clone();std::thread::spawn(move||store.save_settings(Some(&json!({"audio":{"microphone":{"volume":0.25}}}))).unwrap())};a.join().unwrap();b.join().unwrap();let settings=store.settings().unwrap();assert_eq!(settings["audio"]["microphone"]["enabled"],true);assert_eq!(settings["audio"]["microphone"]["volume"],0.25);
        let media=temp.0.join("keep.mp4");fs::write(&media,b"authorized test media remains intact").unwrap();let clip=store.record_clip(Some(&json!({"relativePath":"keep.mp4"}))).unwrap();store.delete_clip(clip.get("id")).unwrap();assert_eq!(fs::read(media).unwrap(),b"authorized test media remains intact");
    }

    #[cfg(windows)]
    struct ScanFixture{root:PathBuf,files:Arc<SidecarFile>,mode:&'static str,root_calls:AtomicUsize}
    #[cfg(windows)]
    impl RecordingScanFs for ScanFixture{
        fn facts(&self,path:&Path)->Result<RecordingFileFacts,String>{
            let directory=path==self.root;let name=path.file_name().and_then(|s|s.to_str()).unwrap_or("");if self.mode=="partial"&&name=="new.mp4"{return Err("Injected partial walk failure".into());}
            let calls=if directory{self.root_calls.fetch_add(1,AtomicOrdering::SeqCst)+1}else{0};Ok(RecordingFileFacts{directory,file:!directory,reparse:name=="junction.mp4",byte_length:123,created_at:"2026-11-08T12:34:56.789Z".into(),modified_at:"2026-11-08T12:34:56.789Z".into(),identity:directory.then_some(FileIdentity{volume:1,file:if self.mode=="root-changed"&&calls>=3{2}else{1}})})
        }
        fn entries(&self,path:&Path)->Result<Vec<String>,String>{assert_eq!(path,self.root);if self.mode=="settings-changed"||self.mode=="location-changed"{self.files.transaction(|raw|{let mut raw=raw.unwrap();raw["settings"]["fps"]=json!(144);if self.mode=="location-changed"{raw["settings"]["location"]=json!("C:\\Other");}Ok((raw,()))})?;}Ok(vec!["known.mp4".into(),"new.mp4".into(),"hidden.arc-native-job.mp4".into(),"junction.mp4".into(),"notes.txt".into()])}
    }
    #[cfg(windows)]
    #[test]
    fn scan_preserves_partial_and_replaced_roots_and_reloads_commit_state(){
        let mut data:Value=serde_json::from_str(include_str!("fixtures/recording-store-parity.json")).unwrap();data["comparisons"].as_array_mut().unwrap().extend([json!(["new.mp4","known.mp4",true,1]),json!(["known.mp4","new.mp4",true,-1])]);for mode in["complete","partial","root-changed","settings-changed","location-changed"]{let temp=Temp::new();let files=Arc::new(SidecarFile::new(temp.0.clone(),Sidecar::Recording).unwrap());let root=PathBuf::from("C:\\Recording Fixture");let old=json!({"schemaVersion":2,"settings":{"location":root.to_str().unwrap(),"fps":60},"clips":[{"id":"clip_001","relativePath":"known.mp4","fileName":"known.mp4","createdAt":"2026-11-08T12:34:56.789Z","apmSamples":[{"atMs":0,"apm":7}],"apmAvailable":true}],"markers":[]});files.transaction(|_|Ok((old,()))).unwrap();let before=fs::read(temp.0.join("recording.json")).unwrap();let scan=Arc::new(ScanFixture{root,files:files.clone(),mode,root_calls:AtomicUsize::new(0)});let store=RecordingStore::with_files(files.clone(),context(&data),scan);let result=store.scan_clips().unwrap();let raw=files.read().unwrap().unwrap();
            if mode=="partial"||mode=="root-changed"{assert_eq!(result.len(),1);assert_eq!(fs::read(temp.0.join("recording.json")).unwrap(),before);}else if mode=="location-changed"{assert_eq!(result.len(),1);assert_eq!(raw["settings"]["location"],"C:\\Other");}else{assert_eq!(result.len(),2);assert!(result.iter().all(|v|v["relativePath"]!="junction.mp4"&&v["relativePath"]!="hidden.arc-native-job.mp4"));let known=result.iter().find(|v|v["relativePath"]=="known.mp4").unwrap();assert_eq!(known["apmAvailable"],true);assert_eq!(known["apmSamples"][0]["apm"].as_f64(),Some(7.0));}if mode=="settings-changed"||mode=="location-changed"{assert_eq!(raw["settings"]["fps"],144);}
        }
    }
    #[cfg(windows)]
    #[test]
    fn native_scan_facts_reject_reparse_ancestors_when_link_creation_is_available(){
        let temp=Temp::new();let target=temp.0.join("target");fs::create_dir(&target).unwrap();fs::write(target.join("test.mp4"),b"fixture").unwrap();let link=temp.0.join("link");if std::os::windows::fs::symlink_dir(&target,&link).is_err(){return;}assert!(NativeRecordingFs.facts(&link).unwrap().reparse);assert!(NativeRecordingFs.facts(&link.join("test.mp4")).is_err());fs::remove_dir(link).unwrap();
    }
}
