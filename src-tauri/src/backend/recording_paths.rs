//! Remaining pure recording helpers. Win32 paths are resolved lexically using
//! explicit cwd/per-drive cwd inputs; locale, clock, randomness and existence
//! are injected. No JS runtime, capture, file mutation or GPU API is used.
use super::recording_contract::{normalize_recording_markers,RECORDING_CLIP_NAME_PHRASES,RECORDING_RUNTIME_DIRECTORY};
use serde_json::{json,Value};
use std::{cmp::Ordering,collections::BTreeSet};

pub trait Win32PathContext {
    fn current_directory(&self)->Result<String,String>;
    /// Equivalent to the Windows =C: per-drive current-directory input.
    fn drive_current_directory(&self,drive:&str)->Option<String>;
}
/// Read-only native process environment. On other systems the caller must
/// supply an explicit Win32 context rather than reuse POSIX path semantics.
pub struct SystemWin32Paths;
impl Win32PathContext for SystemWin32Paths {
    fn current_directory(&self)->Result<String,String>{
        #[cfg(windows)] {std::env::current_dir().map_err(|e|e.to_string())?.into_os_string().into_string().map_err(|_|"Current directory contains unsupported UTF-16".into())}
        #[cfg(not(windows))] {Err("A Windows path context is required".into())}
    }
    fn drive_current_directory(&self,drive:&str)->Option<String>{
        #[cfg(windows)] {std::env::var(format!("={drive}")).ok().filter(|s|!s.is_empty())}
        #[cfg(not(windows))] {let _=drive;None}
    }
}
#[derive(Debug,Clone,Copy,PartialEq,Eq)]
pub enum RecordingCollation { Default, NumericBase }
pub trait RecordingMetadataContext {
    fn now_iso(&self)->&str;
    /// Must implement the selected localeCompare contract. There is no byte
    /// sorting fallback: unsupported locale setup must fail at the context owner.
    fn compare_text(&self,left:&str,right:&str,mode:RecordingCollation)->Ordering;
}
pub trait RecordingRandom {
    /// The injected Math.random-like callback's value before Number coercion.
    fn next_sample(&mut self)->Option<Value>;
    /// A separate native random source replaces Math.random on nonfinite input.
    /// Its contract is a finite value in [0,1); this method is never retried.
    fn fallback_sample(&mut self)->f64;
}
fn trim(s:&str)->&str{s.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))}
fn numeric_string(s:&str)->Option<f64>{
    let s=trim(s);if s.is_empty(){return Some(0.0);}
    for(prefixes,radix)in[(["0x","0X"],16),(["0b","0B"],2),(["0o","0O"],8)]{if prefixes.iter().any(|p|s.starts_with(p)){let digits=&s[2..];if digits.is_empty(){return None;}let mut n=0.0;for c in digits.chars(){n=n*f64::from(radix)+f64::from(c.to_digit(radix)?);}return n.is_finite().then_some(n);}}
    if !s.bytes().all(|b|b.is_ascii_digit()||matches!(b,b'+'|b'-'|b'.'|b'e'|b'E')){return None;}s.parse::<f64>().ok().filter(|n|n.is_finite())
}
fn js_number(value:Option<&Value>)->Option<f64>{match value?{Value::Null=>Some(0.0),Value::Bool(b)=>Some(if *b{1.0}else{0.0}),Value::Number(n)=>n.as_f64().filter(|n|n.is_finite()),Value::String(s)=>numeric_string(s),Value::Array(a)=>numeric_string(&a.iter().map(|v|if v.is_null(){String::new()}else{js_string(v)}).collect::<Vec<_>>().join(",")),_=>None}}
fn js_string(value:&Value)->String{match value{Value::Null=>"null".into(),Value::String(s)=>s.clone(),Value::Bool(b)=>b.to_string(),Value::Array(a)=>a.iter().map(|v|if v.is_null(){String::new()}else{js_string(v)}).collect::<Vec<_>>().join(","),Value::Object(_)=>"[object Object]".into(),Value::Number(n)=>{let n=n.as_f64().unwrap_or(0.0);if n==0.0{return "0".into();}if n.abs()>=1e21||n.abs()<1e-6{let scientific=format!("{n:e}");let(mantissa,exponent)=scientific.split_once('e').unwrap();let exponent=exponent.parse::<i32>().unwrap();format!("{mantissa}e{}{exponent}",if exponent>=0{"+"}else{""})}else{n.to_string()}}}}
fn truthy(v:&Value)->bool{match v{Value::Null=>false,Value::Bool(b)=>*b,Value::Number(n)=>n.as_f64().is_some_and(|n|n!=0.0),Value::String(s)=>!s.is_empty(),_=>true}}
fn separator(c:u8)->bool{matches!(c,b'\\'|b'/')}
#[derive(Debug)]
struct Root {end:usize,device:String,absolute:bool}
// Mirrors path.win32.resolve's root recognition, including extended/device
// namespaces. This is lexical parity, not filesystem/reparse-point identity.
fn root_of(path:&str)->Root{
    let b=path.as_bytes();let n=b.len();let mut root=Root{end:0,device:String::new(),absolute:false};if n==0{return root;}
    if n==1 {if separator(b[0]){root.end=1;root.absolute=true;}return root;}
    if separator(b[0]){root.absolute=true;if separator(b[1]){let mut j=2;let mut last=j;while j<n&&!separator(b[j]){j+=1;}if j<n&&j!=last{let first=&path[last..j];last=j;while j<n&&separator(b[j]){j+=1;}if j<n&&j!=last{last=j;while j<n&&!separator(b[j]){j+=1;}if j==n||j!=last{if first!="."&&first!="?"{root.device=format!("\\\\{first}\\{}",&path[last..j]);root.end=j;}else{root.device=format!("\\\\{first}");root.end=4;}}}}}else{root.end=1;}}
    else if b[0].is_ascii_alphabetic()&&b[1]==b':'{root.device=path[..2].into();root.end=2;if n>2&&separator(b[2]){root.absolute=true;root.end=3;}}root
}
fn normalized_tail(tail:&str,above_root:bool)->String{
    let mut parts:Vec<&str>=Vec::new();for part in tail.split(['\\','/']){match part{""|"."=>{},".."=>{if parts.last().is_some_and(|s|*s!=".."){parts.pop();}else if above_root{parts.push(part);}},_=>parts.push(part)}}parts.join("\\")
}
/// Node-compatible Win32 resolve with explicit current-directory authority.
/// No canonicalization, symlink traversal, filesystem query or shell is used.
pub fn resolve_win32(path:&str,ctx:&impl Win32PathContext)->Result<String,String>{
    let mut device=String::new();let mut tail=String::new();let mut absolute=false;
    for input in [Some(path),None]{
        let current=if let Some(path)=input {if path.is_empty(){continue;}path.to_owned()}else if device.is_empty(){ctx.current_directory()?}else{
            let mut cwd=match ctx.drive_current_directory(&device){Some(cwd)=>cwd,None=>ctx.current_directory()?};
            let bytes=cwd.as_bytes();if bytes.len()>=3&&cwd.get(..2).is_none_or(|s|s.to_lowercase()!=device.to_lowercase())&&bytes[2]==b'\\'{cwd=format!("{device}\\");}cwd
        };
        let root=root_of(&current);if !root.device.is_empty(){if !device.is_empty(){if root.device.to_lowercase()!=device.to_lowercase(){continue;}}else{device=root.device;}}
        if absolute{if !device.is_empty(){break;}}else{tail=format!("{}\\{tail}",&current[root.end..]);absolute=root.absolute;if absolute&&!device.is_empty(){break;}}
    }
    let tail=normalized_tail(&tail,!absolute);let result=if absolute{format!("{device}\\{tail}")}else{format!("{device}{tail}")};Ok(if result.is_empty(){".".into()}else{result})
}
fn dirname_win32(path:&str)->String{
    let b=path.as_bytes();let n=b.len();if n==0{return ".".into();}if n==1{return if separator(b[0]){path.into()}else{".".into()};}
    let mut root_end=None;let mut offset=0;
    if separator(b[0]){root_end=Some(1);offset=1;if separator(b[1]){let mut j=2;let mut last=j;while j<n&&!separator(b[j]){j+=1;}if j<n&&j!=last{last=j;while j<n&&separator(b[j]){j+=1;}if j<n&&j!=last{last=j;while j<n&&!separator(b[j]){j+=1;}if j==n{return path.into();}if j!=last{root_end=Some(j+1);offset=j+1;}}}}}
    else if b[0].is_ascii_alphabetic()&&b[1]==b':'{offset=if n>2&&separator(b[2]){3}else{2};root_end=Some(offset);}
    let mut end=None;let mut slash=true;for i in(offset..n).rev(){if separator(b[i]){if !slash{end=Some(i);break;}}else{slash=false;}}
    end.or(root_end).map(|end|path[..end].to_owned()).unwrap_or_else(||".".into())
}
fn append_component(base:&str,name:&str)->String{format!("{}{name}",if base.ends_with('\\'){base.into()}else{format!("{base}\\")})}
pub fn recording_absolute_path(value:Option<&Value>,label:&str,ctx:&impl Win32PathContext)->Result<String,String>{
    let text=value.and_then(Value::as_str).filter(|s|s.encode_utf16().count()<=4096&&!trim(s).is_empty()).ok_or_else(||format!("{label} must be a non-empty path"))?;let candidate=trim(text);
    if !root_of(candidate).absolute{return Err(format!("{label} must be an absolute path"));}resolve_win32(candidate,ctx)
}
pub fn is_path_within_root(root:Option<&Value>,candidate:Option<&Value>,allow_root:bool,ctx:&impl Win32PathContext)->Result<bool,String>{
    let(Some(root),Some(candidate))=(root.and_then(Value::as_str),candidate.and_then(Value::as_str))else{return Ok(false);};
    let root=resolve_win32(root,ctx)?.to_lowercase();let candidate=resolve_win32(candidate,ctx)?.to_lowercase();if allow_root&&candidate==root{return Ok(true);}let prefix=if root.ends_with('\\'){root}else{format!("{root}\\")};Ok(candidate.starts_with(&prefix))
}
pub fn resolve_recording_runtime_candidates(options:Option<&Value>,ctx:&impl Win32PathContext)->Result<Vec<String>,String>{
    if options==Some(&Value::Null){return Err("Cannot destructure property 'configuredPath' of '(intermediate value)(intermediate value)(intermediate value)' as it is null.".into());}
    let mut candidates=Vec::new();for key in["configuredPath","resourcesPath","portableWrapperPath","devPath"]{if let Some(value)=options.and_then(|v|v.get(key)).filter(|v|truthy(v)){let path=value.as_str().ok_or_else(||format!("{key} must be a string"))?;let path=resolve_win32(path,ctx)?;candidates.push(match key{"configuredPath"=>path,"portableWrapperPath"=>append_component(&dirname_win32(&path),RECORDING_RUNTIME_DIRECTORY),_=>append_component(&path,RECORDING_RUNTIME_DIRECTORY)});}}
    let mut seen=BTreeSet::new();Ok(candidates.into_iter().filter(|s|seen.insert(s.clone())).collect())
}
fn sample(rng:&mut impl RecordingRandom)->Result<f64,String>{
    let value=rng.next_sample();if let Some(value)=js_number(value.as_ref()){return Ok(value.clamp(0.0,0.999999999));}
    let fallback=rng.fallback_sample();if !fallback.is_finite()||!(0.0..1.0).contains(&fallback){return Err("Injected fallback random must be finite and in [0,1)".into());}Ok(fallback)
}
pub fn recording_file_name(kind:Option<&Value>,rng:&mut impl RecordingRandom)->Result<String,String>{
    let number=100.0+(sample(rng)?*900.0).floor();match kind{None=>Ok(format!("Arc Recording {number:.0}.mp4")),Some(Value::String(kind))if kind=="recording"=>Ok(format!("Arc Recording {number:.0}.mp4")),Some(Value::String(kind))if kind=="clip"=>{let index=(sample(rng)?*RECORDING_CLIP_NAME_PHRASES.len()as f64).floor()as usize;Ok(format!("{} {number:.0}.mp4",RECORDING_CLIP_NAME_PHRASES[index]))},_=>Err("Unknown recording filename kind".into())}
}
pub fn collision_safe_recording_path(root:&Value,kind:Option<&Value>,max_attempts:Option<&Value>,ctx:&impl Win32PathContext,rng:&mut impl RecordingRandom,mut exists:impl FnMut(&str)->bool)->Result<String,String>{
    let root=root.as_str().ok_or("Recording root must be a string")?;let base=resolve_win32(root,ctx)?;let max=max_attempts.map(|v|js_number(Some(v)).unwrap_or(f64::NAN)).unwrap_or(900.0);let mut attempt=0.0;
    while attempt<max{let name=recording_file_name(kind,rng)?;let candidate=append_component(&base,&name);if !exists(&candidate){return Ok(candidate);}attempt+=1.0;}Err("Could not allocate a unique recording filename".into())
}
fn finite(value:Option<&Value>)->Option<f64>{value.and_then(Value::as_f64).filter(|n|n.is_finite())}
fn nullish_text(value:Option<&Value>)->String{value.filter(|v|!v.is_null()).map(js_string).unwrap_or_default()}
pub fn sort_recording_clips(clips:Option<&Value>,ctx:&impl RecordingMetadataContext)->Vec<Value>{
    let mut clips=clips.and_then(Value::as_array).cloned().unwrap_or_default();clips.sort_by(|a,b|ctx.compare_text(&nullish_text(b.get("createdAt")),&nullish_text(a.get("createdAt")),RecordingCollation::Default).then_with(||ctx.compare_text(&nullish_text(a.get("fileName")),&nullish_text(b.get("fileName")),RecordingCollation::NumericBase)));clips
}
pub fn map_recording_markers_to_clip(markers:Option<&Value>,options:Option<&Value>,ctx:&impl RecordingMetadataContext)->Result<Value,String>{
    if options==Some(&Value::Null){return Err("Cannot read properties of null (reading 'sourceSessionId')".into());}
    let normalized=normalize_recording_markers(markers,ctx.now_iso())?;let get=|key|options.and_then(|v|v.get(key));let session=get("sourceSessionId").and_then(Value::as_str).map(trim).filter(|s|!s.is_empty());
    let start=finite(get("sourceStartMs")).map(|n|(n+0.5).floor().max(0.0));let end=finite(get("sourceEndMs")).map(|n|(n+0.5).floor().max(0.0));
    let(Some(session),Some(start),Some(end))=(session,start,end)else{return Ok(json!({"mapped":false,"reason":"interval-unavailable","attached":[],"retained":normalized}));};if end<start{return Ok(json!({"mapped":false,"reason":"interval-unavailable","attached":[],"retained":normalized}));}
    let mut attached=Vec::new();let mut retained=Vec::new();for marker in normalized{let at=marker["sourceAtMs"].as_f64().unwrap();if marker.get("sourceSessionId").and_then(Value::as_str)==Some(session)&&at>=start&&at<=end{attached.push(json!({"id":marker["id"],"atMs":at-start,"label":marker["label"],"createdAt":marker["createdAt"]}));}else{retained.push(marker);}}
    attached.sort_by(|a,b|a["atMs"].as_f64().unwrap().total_cmp(&b["atMs"].as_f64().unwrap()).then_with(||ctx.compare_text(a["createdAt"].as_str().unwrap(),b["createdAt"].as_str().unwrap(),RecordingCollation::Default)).then_with(||ctx.compare_text(a["id"].as_str().unwrap(),b["id"].as_str().unwrap(),RecordingCollation::Default)));
    Ok(json!({"mapped":true,"reason":null,"attached":attached,"retained":retained}))
}

#[cfg(test)]
mod tests{
    use super::*;
    struct Context<'a>{fixture:&'a Value,comparisons:&'a Value,now:&'a str}
    impl Win32PathContext for Context<'_>{
        fn current_directory(&self)->Result<String,String>{Ok(self.fixture["context"]["cwd"].as_str().unwrap().into())}
        fn drive_current_directory(&self,drive:&str)->Option<String>{self.fixture["context"]["drives"].get(drive).and_then(Value::as_str).map(str::to_owned)}
    }
    impl RecordingMetadataContext for Context<'_>{
        fn now_iso(&self)->&str{self.now}
        fn compare_text(&self,left:&str,right:&str,mode:RecordingCollation)->Ordering{
            let base=mode==RecordingCollation::NumericBase;
            let row=self.comparisons.as_array().unwrap().iter().find(|row|row[0].as_str()==Some(left)&&row[1].as_str()==Some(right)&&row[2].as_bool()==Some(base)).unwrap_or_else(||panic!("Missing real JavaScript locale oracle: {left:?} {right:?} {mode:?}"));
            row[3].as_i64().unwrap().cmp(&0)
        }
    }
    struct Random<'a>{fixture:&'a Value,calls:usize,fallback_calls:usize}
    impl RecordingRandom for Random<'_>{
        fn next_sample(&mut self)->Option<Value>{let samples=self.fixture["samples"].as_array().unwrap();let value=samples[self.calls%samples.len()].clone();self.calls+=1;Some(value)}
        fn fallback_sample(&mut self)->f64{self.fallback_calls+=1;self.fixture["fallback"].as_f64().unwrap()}
    }
    fn equivalent(a:&Value,b:&Value)->bool{match(a,b){(Value::Number(a),Value::Number(b))=>a.as_f64()==b.as_f64(),(Value::Array(a),Value::Array(b))=>a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|equivalent(a,b)),(Value::Object(a),Value::Object(b))=>a.len()==b.len()&&a.iter().all(|(k,a)|b.get(k).is_some_and(|b|equivalent(a,b))),_=>a==b}}
    #[test]
    fn all_seven_original_exports_match_windows_path_and_locale_oracles(){
        let data:Value=serde_json::from_str(include_str!("fixtures/recording-paths-parity.json")).unwrap();
        let fixtures=data["fixtures"].as_array().unwrap();assert_eq!(fixtures.len(),188);
        for(index,fixture)in fixtures.iter().enumerate(){
            let ctx=Context{fixture,comparisons:&data["comparisons"],now:data["now"].as_str().unwrap()};let mut random=Random{fixture,calls:0,fallback_calls:0};let args=fixture["args"].as_array().unwrap();let a=|i|args.get(i);let method=fixture["method"].as_str().unwrap();let mut exists_calls=Vec::new();
            let result:Result<Value,String>=match method{
                "recordingFileName"=>recording_file_name(a(0),&mut random).map(Value::String),
                "collisionSafeRecordingPath"=>collision_safe_recording_path(a(0).unwrap_or(&Value::Null),a(1),a(2),&ctx,&mut random,|candidate|{exists_calls.push(candidate.to_owned());exists_calls.len()<=fixture["collisions"].as_u64().unwrap()as usize}).map(Value::String),
                "recordingAbsolutePath"=>recording_absolute_path(a(0),a(1).and_then(Value::as_str).unwrap_or("location"),&ctx).map(Value::String),
                "isPathWithinRoot"=>is_path_within_root(a(0),a(1),a(2).and_then(|v|v.get("allowRoot")).is_some_and(truthy),&ctx).map(Value::Bool),
                "resolveRecordingRuntimeCandidates"=>resolve_recording_runtime_candidates(a(0),&ctx).map(|v|json!(v)),
                "sortRecordingClips"=>Ok(json!(sort_recording_clips(a(0),&ctx))),
                "mapRecordingMarkersToClip"=>map_recording_markers_to_clip(a(0),a(1),&ctx),
                _=>panic!("Unknown fixture method {method}")};
            if let Some(error)=fixture.get("error"){if error=="path-type"{assert!(result.is_err(),"fixture {index} must reject non-string path");}else{assert_eq!(result.unwrap_err(),error.as_str().unwrap(),"fixture {index} {method}");}}
            else{let actual=result.unwrap_or_else(|error|panic!("fixture {index} {method}: {error}"));assert!(equivalent(&actual,&fixture["expected"]),"fixture {index} {method} args={} actual={actual} expected={}",fixture["args"],fixture["expected"]);}
            assert_eq!(random.calls,fixture["calls"].as_u64().unwrap()as usize,"fixture {index}: random callback count");assert_eq!(random.fallback_calls,fixture["fallbackCalls"].as_u64().unwrap()as usize,"fixture {index}: fallback count");assert_eq!(json!(exists_calls),fixture["existsCalls"],"fixture {index}: existence probes");
        }
    }
    #[test]
    fn unavailable_locale_is_not_silently_replaced_with_byte_order(){
        let data:Value=serde_json::from_str(include_str!("fixtures/recording-paths-parity.json")).unwrap();
        // The fixture deliberately includes equal-under-base accents and numeric
        // names. Their exact locale outcomes are supplied by the original JS;
        // no Rust lexical fallback can make a missing matrix entry pass.
        assert!(data["comparisons"].as_array().unwrap().iter().any(|row|row[0]=="Éclair 1.mp4"&&row[1]=="eclair 1.mp4"&&row[2]==true&&row[3]==0));
    }
    #[test]
    fn invalid_native_random_fallback_fails_instead_of_fabricating_a_filename(){
        struct BadRandom;impl RecordingRandom for BadRandom{fn next_sample(&mut self)->Option<Value>{None}fn fallback_sample(&mut self)->f64{f64::NAN}}
        assert!(recording_file_name(None,&mut BadRandom).unwrap_err().contains("fallback random"));
    }
    #[cfg(windows)]
    #[test]
    fn native_context_resolves_absolute_current_directory_without_spawning(){
        let ctx=SystemWin32Paths;let cwd=ctx.current_directory().unwrap();assert!(root_of(&cwd).absolute);assert_eq!(resolve_win32(".",&ctx).unwrap(),resolve_win32(&cwd,&ctx).unwrap());
    }
}

