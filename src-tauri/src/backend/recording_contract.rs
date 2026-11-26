//! Pure recording contracts ported from recording-pure.js. No capture, process,
//! filesystem or GPU access. Path/locale/random helpers are intentionally absent.
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use base64::Engine;

pub const RECORDING_SCHEMA_VERSION: u64 = 2;
pub const RECORDING_EDITOR_VERSION: u64 = 1;
pub const RECORDING_MARKER_MAX_COUNT: usize = 500;
pub const RECORDING_MARKER_LABEL_MAX_LENGTH: usize = 80;
pub const ASCENT_MAX_MESSAGE_BYTES: usize = 8096;
pub const RECORDING_MODES: &[&str] = &["manual", "clips"];
pub const RECORDING_AUDIO_SOURCE_MODES: &[&str] = &["system", "custom"];
pub const RECORDING_CAPTURE_TARGET_TYPES: &[&str] = &["display", "window"];
pub const RECORDING_CAPTURE_COLOR_MODES: &[&str] = &["auto", "sdr", "hdr"];
pub const RECORDING_RATE_CONTROLS: &[&str] = &["CBR", "VBR", "CQP", "ICQ"];
pub const RECORDING_FPS: &[u64] = &[30, 60, 120];
pub const RECORDING_FPS_MIN: u64 = 1;
pub const RECORDING_FPS_MAX: u64 = 360;
pub const RECORDING_RATE_CONTROL_QUALITY_MIN: u64 = 1;
pub const RECORDING_RATE_CONTROL_QUALITY_MAX: u64 = 63;
pub const SAFE_VIDEO_EXTENSIONS: &[&str] = &[".mp4", ".mkv", ".mov", ".webm", ".m4v"];
const CODECS: &[&str] = &[
    "obs_qsv11_av1", "obs_qsv11_hevc", "obs_qsv11_v2",
    "obs_qsv_vpl_av1_tex", "obs_qsv_vpl_hevc_tex", "obs_qsv_vpl_h264_tex",
    "obs_qsv_vpl_av1", "obs_qsv_vpl_hevc", "obs_qsv_vpl_h264",
];
const EPOCH: &str = "1970-01-01T00:00:00.000Z";

fn prop<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> { v.and_then(|v| v.get(key)) }
fn finite(v: Option<&Value>) -> Option<f64> { v.and_then(Value::as_f64).filter(|n| n.is_finite()) }
fn strict_true(v: Option<&Value>) -> bool { v == Some(&Value::Bool(true)) }
fn not_false(v: Option<&Value>) -> bool { v != Some(&Value::Bool(false)) }
fn integer(v: Option<&Value>) -> Option<f64> { finite(v).filter(|n| n.fract() == 0.0) }
fn safe_integer(v: Option<&Value>) -> Option<f64> { integer(v).filter(|n| n.abs() <= 9_007_199_254_740_991.0) }
fn js_round(n: f64) -> f64 { (n + 0.5).floor() }
fn len(s: &str) -> usize { s.encode_utf16().count() }
fn whitespace(c: char) -> bool { matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}') }
fn trim(s: &str) -> &str { s.trim_matches(whitespace) }
fn bounded(v: Option<&Value>, fallback: &str, max: usize) -> String { v.and_then(Value::as_str).filter(|s| len(s) <= max).unwrap_or(fallback).into() }
fn enum_string(v: Option<&Value>, allowed: &[&str], fallback: &str) -> String { v.and_then(Value::as_str).filter(|s| allowed.contains(s)).unwrap_or(fallback).into() }
fn nullish<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> { a.filter(|v| !v.is_null()).or(b) }
fn numeric_string(s: &str) -> Option<f64> {
    let s = trim(s);
    if s.is_empty() { return Some(0.0); }
    for (prefixes, radix) in [(["0x", "0X"], 16), (["0b", "0B"], 2), (["0o", "0O"], 8)] {
        if prefixes.iter().any(|p| s.starts_with(p)) {
            let digits = &s[2..]; if digits.is_empty() { return None; }
            let mut n = 0.0; for c in digits.chars() { n = n * f64::from(radix) + f64::from(c.to_digit(radix)?); }
            return n.is_finite().then_some(n);
        }
    }
    if !s.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'+'|b'-'|b'.'|b'e'|b'E')) { return None; }
    s.parse::<f64>().ok().filter(|n| n.is_finite())
}
fn array_string(v: &Value) -> String { match v { Value::Null => String::new(), Value::String(s) => s.clone(), Value::Array(a) => a.iter().map(array_string).collect::<Vec<_>>().join(","), Value::Object(_) => "[object Object]".into(), _ => v.to_string() } }
fn number(v: Option<&Value>) -> Option<f64> { match v? { Value::Null=>Some(0.0), Value::Bool(b)=>Some(if *b {1.0}else{0.0}), Value::String(s)=>numeric_string(s), Value::Array(_)=>numeric_string(&array_string(v?)), Value::Number(n)=>n.as_f64().filter(|n|n.is_finite()), _=>None } }
fn time(v: Option<&Value>, max: f64) -> Option<f64> { finite(v).map(|n| js_round(n).clamp(0.0,max)) }
fn id(v: Option<&Value>) -> Option<&str> { v.and_then(Value::as_str).filter(|s| (8..=128).contains(&s.len()) && s.bytes().all(|b|b.is_ascii_alphanumeric() || matches!(b,b'_'|b'-'))) }
fn sliced(s: &str, max: usize) -> Result<String,String> {
    String::from_utf16(&s.encode_utf16().take(max).collect::<Vec<_>>()).map_err(|_| "Recording text truncation split a UTF-16 surrogate; native JSON cannot represent the original value".into())
}
fn process_name(v: &Value) -> Option<String> { let s=trim(v.as_str()?); (!s.is_empty() && len(s)<=256 && !s.chars().any(|c| matches!(c,'\\'|'/'|'\0'|'\r'|'\n'))).then(||s.to_owned()) }

pub fn recording_runtime_encoder_id_for_target(encoder_id: &Value, display_active: Option<&Value>) -> Value {
    if display_active != Some(&Value::Bool(false)) { return encoder_id.clone(); }
    match encoder_id.as_str() { Some("obs_qsv11_v2")=>json!("obs_qsv11_soft_v2"), Some("obs_qsv11_hevc")=>json!("obs_qsv11_hevc_soft"), Some("obs_qsv11_av1")=>json!("obs_qsv11_av1_soft"), _=>encoder_id.clone() }
}
fn percent_decode(s: &str) -> Option<String> {
    let mut bytes=Vec::new(); let input=s.as_bytes(); let mut i=0;
    while i<input.len() { if input[i]==b'%' { if i+2>=input.len(){return None;} let h=(input[i+1] as char).to_digit(16)?;let l=(input[i+2] as char).to_digit(16)?;bytes.push((h*16+l)as u8);i+=3;}else{bytes.push(input[i]);i+=1;} }
    String::from_utf8(bytes).ok()
}
pub fn recording_encoder_codec_of(value: Option<&Value>) -> Option<&'static str> {
    let s=value.and_then(Value::as_str)?;
    if let Some(codec)=CODECS.iter().find(|c| **c==s) {return Some(codec);}
    let encoded=s.strip_prefix("arc-gpu-encoder:v1:")?;
    let mut base=encoded.replace('-',"+").replace('_',"/"); base.push_str(&"=".repeat((4-encoded.len()%4)%4));
    let config=base64::engine::general_purpose::GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true);
    let engine=base64::engine::general_purpose::GeneralPurpose::new(&base64::alphabet::STANDARD,config);
    let parsed=engine.decode(base).ok().and_then(|b| serde_json::from_str::<Value>(&String::from_utf8_lossy(&b)).ok())
        .or_else(||percent_decode(encoded).and_then(|s|serde_json::from_str::<Value>(&s).ok()))?;
    let codec=nullish(parsed.get("codec"),parsed.get("c")).and_then(Value::as_str)?;
    CODECS.iter().find(|c| **c==codec).copied()
}
pub fn recording_rate_control_quality_max(rate_control: &str, encoder_id: Option<&Value>) -> u64 {
    let av1 = matches!(recording_encoder_codec_of(encoder_id),
        Some("obs_qsv11_av1" | "obs_qsv_vpl_av1" | "obs_qsv_vpl_av1_tex"));
    if rate_control == "CQP" && av1 { 63 } else { 51 }
}

pub fn recording_bitrate_range(resolution: &str) -> Value {
    let (min,max,step,default,label)=match resolution {
        "480p"=>(1500,2500,100,2000,"1,500–2,500 Kbps"),"720p"=>(2500,5000,100,3500,"2,500–5,000 Kbps"),"900p"=>(3500,7000,100,5000,"3,500–7,000 Kbps"),
        "1080p"=>(4000,8000,100,6000,"4,000–8,000 Kbps"),"1440p"=>(8000,12000,100,10000,"8,000–12,000 Kbps"),"4k"=>(15000,50000,500,20000,"15,000–25,000+ Kbps"),_ =>(4000,8000,100,8000,"4,000–8,000 Kbps")};
    json!({"min":min,"max":max,"step":step,"default":default,"label":label})
}
pub fn clamp_recording_bitrate(value: Option<&Value>, resolution: &str) -> f64 {
    let range=recording_bitrate_range(resolution); let n=finite(value).map(js_round).unwrap_or(range["default"].as_f64().unwrap());
    let step=range["step"].as_f64().unwrap(); js_round(n.clamp(range["min"].as_f64().unwrap(),range["max"].as_f64().unwrap())/step)*step
}
pub fn normalize_recording_bitrate(value: Option<&Value>, fallback: Option<&Value>) -> Value { value.filter(|v|finite(Some(v)).is_some_and(|n|n>0.0)).cloned().or_else(||fallback.cloned()).unwrap_or(json!(8000)) }
pub fn normalize_recording_fps(value: Option<&Value>, fallback: Option<&Value>) -> u64 {
    let numeric=|v:Option<&Value>| v.filter(|v|v.is_number() || v.as_str().is_some_and(|s|!trim(s).is_empty())).and_then(|v|number(Some(v)));
    let safe_fallback=numeric(fallback).map(|n|js_round(n).clamp(1.0,360.0)).unwrap_or(60.0);
    numeric(value).map(|n|js_round(n).clamp(1.0,360.0)).unwrap_or(safe_fallback) as u64
}
fn even_dimension(value: Option<&Value>, fallback:f64)->f64 { number(value).filter(|n|*n>1.0).map(|n|{let n=js_round(n).max(2.0);if n%2.0==0.0{n}else{n+1.0}}).unwrap_or(fallback) }
pub fn recording_output_dimensions(resolution:&str,width:Option<&Value>,height:Option<&Value>)->Value {
    let w=even_dimension(width,1920.0);let h=even_dimension(height,1080.0);
    let target=match resolution {"480p"=>480.0,"720p"=>720.0,"900p"=>900.0,"1080p"=>1080.0,"1440p"=>1440.0,"4k"=>2160.0,_=>0.0};
    if target==0.0{return json!({"width":w,"height":h});}json!({"width":even_dimension(Some(&json!(target*(w/h))),w),"height":target})
}

pub fn normalize_recording_capture_target(raw:Option<&Value>)->Value {
    let get=|k|prop(raw,k);
    let display=get("displayId").and_then(Value::as_str).map(trim).filter(|s|len(s)<=128 && !s.is_empty()).unwrap_or("primary");
    let string=|key,max|trim(&bounded(get(key),"",max)).to_owned();
    json!({"type":enum_string(get("type"),RECORDING_CAPTURE_TARGET_TYPES,"display"),"displayId":display,"windowHandle":safe_integer(get("windowHandle")).filter(|n|*n>=0.0 && *n<=u32::MAX as f64).unwrap_or(0.0),
        "processName":get("processName").and_then(process_name).unwrap_or_default(),"executablePath":string("executablePath",4096),"windowTitle":string("windowTitle",512),"windowClass":string("windowClass",256)})
}
pub fn normalize_recording_audio_settings(raw:Option<&Value>)->Value {
    let mic=prop(raw,"microphone");let sys=prop(raw,"system");
    let volume=|v|finite(v).filter(|n|(0.0..=1.0).contains(n)).unwrap_or(1.0);
    let device=|v|trim(&bounded(v,"",512)).to_owned();
    let mut seen=BTreeSet::new();let processes:Vec<_>=prop(raw,"customProcesses").and_then(Value::as_array).into_iter().flatten().filter_map(process_name).filter(|s|seen.insert(s.clone())).take(3).collect();
    json!({"microphone":{"enabled":strict_true(prop(mic,"enabled")),"deviceId":device(prop(mic,"deviceId")),"volume":volume(prop(mic,"volume")),"mono":strict_true(prop(mic,"mono"))},
        "system":{"enabled":not_false(prop(sys,"enabled")),"deviceId":device(prop(sys,"deviceId")),"volume":volume(prop(sys,"volume"))},"sourceMode":enum_string(prop(raw,"sourceMode"),RECORDING_AUDIO_SOURCE_MODES,"system"),"customProcesses":processes})
}
pub fn validate_recording_process_names(value:&Value)->Result<Vec<String>,String>{
    let values=value.as_array().filter(|a|a.len()<=3).ok_or("At most three custom process names are allowed")?;
    let mut seen=BTreeSet::new();let mut names=Vec::new();for value in values{let s=process_name(value).ok_or("Custom process names must be non-empty names without paths")?;if seen.insert(s.clone()){names.push(s);}}Ok(names)
}
fn canonical_accelerator(value:Option<&Value>)->Option<String>{
    let s=value?.as_str()?.chars().filter(|c|!whitespace(*c)).collect::<String>();let mut parts:Vec<_>=s.split('+').collect();if parts.iter().any(|p|p.is_empty()){return None;}let key=parts.pop()?.to_uppercase();
    let valid=key.len()==1 && key.as_bytes()[0].is_ascii_alphanumeric() || key.strip_prefix('F').is_some_and(|s|!s.is_empty() && !s.starts_with('0') && s.bytes().all(|b|b.is_ascii_digit()) && s.parse::<u8>().is_ok_and(|n|(1..=24).contains(&n)));if !valid{return None;}
    let mut modifiers=Vec::new();for part in parts{let modifier=match part.to_ascii_lowercase().as_str(){"commandorcontrol"|"cmdorcontrol"=>"CommandOrControl","control"|"ctrl"=>"Control","alt"=>"Alt","shift"=>"Shift",_=>return None};if modifiers.contains(&modifier){return None;}modifiers.push(modifier);}
    let mut out=modifiers.join("+");if !out.is_empty(){out.push('+');}out.push_str(&key);Some(out)
}
pub fn normalize_recording_accelerator(value:Option<&Value>,fallback:&Value)->Value{canonical_accelerator(value).or_else(||canonical_accelerator(Some(fallback))).map(Value::String).unwrap_or_else(||fallback.clone())}
fn hotkey(value:Option<&Value>,fallback:&str)->Value{if value.and_then(Value::as_str).is_some_and(|s|trim(s).is_empty()){return json!("");}normalize_recording_accelerator(Some(&json!(bounded(value,fallback,32))),&json!(fallback))}
pub fn normalize_recording_settings(raw:Option<&Value>)->Value{
    let get=|k|prop(raw,k);let resolution=enum_string(get("resolution"),&["default","480p","720p","900p","1080p","1440p","4k"],"1080p");
    let bitrate=normalize_recording_bitrate(get("bitrateKbps"),None);let max_bitrate=normalize_recording_bitrate(get("maxBitrateKbps"),None).as_f64().unwrap().max(bitrate.as_f64().unwrap());
    let rate=enum_string(get("rateControl"),RECORDING_RATE_CONTROLS,"CBR");let encoder=bounded(get("encoderId"),"automatic",128);let quality_max=recording_rate_control_quality_max(&rate,Some(&json!(encoder)));
    let quality=safe_integer(get("rateControlQuality")).map(|n|n.clamp(1.0,quality_max as f64)).unwrap_or(23.0);
    let keys=get("hotkeys");let start=hotkey(prop(keys,"start"),"F9");let stop=hotkey(prop(keys,"stop"),"F10");let toggle=if let Some(v)=prop(keys,"toggle"){hotkey(Some(v),"F9")}else if start!=json!("F9"){start}else if stop!=json!("F10"){stop}else{start};
    let mode=match get("mode").and_then(Value::as_str){Some("clips"|"clips-only")=>"clips",_=>"manual"};
    json!({"location":bounded(get("location"),"",4096),"runtimePath":bounded(get("runtimePath"),"",4096),"mode":mode,"fps":normalize_recording_fps(get("fps"),None),"resolution":resolution,"encoderId":encoder,"rateControl":rate,"bitrateKbps":bitrate,"maxBitrateKbps":max_bitrate,"rateControlQuality":quality,
        "captureTarget":normalize_recording_capture_target(get("captureTarget")),"captureColorMode":enum_string(get("captureColorMode"),RECORDING_CAPTURE_COLOR_MODES,"auto"),"showCursor":strict_true(get("showCursor")),"memorySavingMode":strict_true(get("memorySavingMode")),"replayLengthSec":finite(get("replayLengthSec")).map(|n|js_round(n).clamp(5.0,3600.0)).unwrap_or(30.0),"audio":normalize_recording_audio_settings(get("audio")),"hotkeys":{"toggle":toggle,"saveClip":hotkey(prop(keys,"saveClip"),"F8"),"screenshot":hotkey(prop(keys,"screenshot"),"F7"),"marker":hotkey(prop(keys,"marker"),"F6")},"instantReplayAutoStart":strict_true(get("instantReplayAutoStart")),"replayMarkersEnabled":not_false(get("replayMarkersEnabled"))})
}

fn marker_text(value:Option<&Value>)->Result<String,String>{
    let Some(s)=value.and_then(Value::as_str)else{return Ok("Marker".into());};
    let replaced=s.chars().map(|c|if c<='\u{001f}' || c=='\u{007f}'{' '}else{c}).collect::<String>();
    let mut collapsed=String::new();let mut gap=false;
    for c in replaced.chars(){if whitespace(c){gap=true;}else{if gap && !collapsed.is_empty(){collapsed.push(' ');}collapsed.push(c);gap=false;}}
    sliced(&collapsed,RECORDING_MARKER_LABEL_MAX_LENGTH)
}
pub fn normalize_recording_marker(raw:Option<&Value>,now:&str)->Result<Option<Value>,String>{
    let get=|k|prop(raw,k);let Some(marker_id)=id(get("id"))else{return Ok(None);};let clip=id(get("clipId"));
    let session=nullish(get("sourceSessionId"),get("sessionId")).and_then(Value::as_str).map(trim).filter(|s|len(s)<=128);
    let Some(at)=time(nullish(get("sourceAtMs"),get("atMs")),86_400_000.0)else{return Ok(None);};
    if session.is_none_or(str::is_empty) && clip.is_none(){return Ok(None);}
    let label=marker_text(get("label"))?;
    if label.is_empty(){return Ok(None);}
    let mut out=Map::new();out.insert("id".into(),json!(marker_id));if let Some(clip)=clip{out.insert("clipId".into(),json!(clip));}if let Some(session)=session.filter(|s|!s.is_empty()){out.insert("sourceSessionId".into(),json!(session));}
    out.insert("sourceAtMs".into(),json!(at));out.insert("label".into(),json!(label));out.insert("createdAt".into(),json!(bounded(get("createdAt"),now,64)));Ok(Some(Value::Object(out)))
}
pub fn normalize_recording_markers(value:Option<&Value>,now:&str)->Result<Vec<Value>,String>{
    let mut seen=BTreeSet::new();let mut out=Vec::new();
    for value in value.and_then(Value::as_array).into_iter().flatten(){if let Some(marker)=normalize_recording_marker(Some(value),now)?{if seen.insert(marker["id"].as_str().unwrap().to_owned()){out.push(marker);}}}
    if out.len()>RECORDING_MARKER_MAX_COUNT{out.drain(..out.len()-RECORDING_MARKER_MAX_COUNT);}Ok(out)
}
fn marker_summary(raw:&Value)->Result<Option<Value>,String>{let Some(marker_id)=id(raw.get("id"))else{return Ok(None);};let Some(at)=time(raw.get("atMs"),86_400_000.0)else{return Ok(None);};let label=marker_text(raw.get("label"))?;if label.is_empty(){return Ok(None);}Ok(Some(json!({"id":marker_id,"atMs":at,"label":label,"createdAt":bounded(raw.get("createdAt"),EPOCH,64)})))}
pub fn normalize_recording_apm_samples(value:Option<&Value>)->Vec<Value>{
    let mut out:Vec<_>=value.and_then(Value::as_array).into_iter().flatten().filter(|v|v.is_object()).filter_map(|v|Some(json!({"atMs":time(v.get("atMs"),86_400_000.0)?,"apm":time(v.get("apm"),6000.0)?}))).collect();
    out.sort_by(|a,b|a["atMs"].as_f64().unwrap().total_cmp(&b["atMs"].as_f64().unwrap()));out.truncate(86_400);out
}
pub fn map_recording_apm_samples_to_clip(samples:Option<&Value>,start:Option<&Value>,end:Option<&Value>)->Vec<Value>{
    let start=finite(start).map(|n|js_round(n).max(0.0)).unwrap_or(0.0);let end=finite(end).map(|n|js_round(n).max(start)).unwrap_or(86_400_000.0);
    normalize_recording_apm_samples(samples).into_iter().filter(|v|{let at=v["atMs"].as_f64().unwrap();at>=start && at<=end}).map(|v|json!({"atMs":v["atMs"].as_f64().unwrap()-start,"apm":v["apm"]})).collect()
}
fn js_string(value:&Value)->String{match value{Value::String(s)=>s.clone(),Value::Object(_)=>"[object Object]".into(),Value::Array(_)=>array_string(value),_=>value.to_string()}}
fn windows_basename(value:&str)->&str{let name=value.trim_end_matches(['\\','/']).rsplit(['\\','/']).next().unwrap_or("");if name.len()>=2 && name.as_bytes()[0].is_ascii_alphabetic() && name.as_bytes()[1]==b':'{&name[2..]}else{name}}
pub fn safe_video_extension(value:&Value)->Option<&'static str>{let s=js_string(value);let name=windows_basename(&s);let (before,ext)=name.rsplit_once('.')?;if before.is_empty(){return None;}let extension=format!(".{}",ext.to_ascii_lowercase());SAFE_VIDEO_EXTENSIONS.iter().find(|e|**e==extension).copied()}
pub fn is_recording_temporary_artifact(value:&Value)->bool{let text=js_string(value);let name=windows_basename(&text).to_ascii_lowercase();["native","trim","source","original","editor"].iter().any(|kind|name.contains(&format!(".arc-{kind}-")))}
pub fn normalize_recording_clip(clip:Option<&Value>)->Result<Option<Value>,String>{
    let Some(clip)=clip else{return Ok(None);};let Some(mut out)=clip.as_object().cloned()else{return Ok(None);};let Some(clip_id)=id(clip.get("id"))else{return Ok(None);};let Some(relative)=clip.get("relativePath").and_then(Value::as_str).filter(|s|!s.is_empty() && len(s)<=4096)else{return Ok(None);};
    if safe_video_extension(&json!(relative)).is_none() || is_recording_temporary_artifact(&json!(relative)){return Ok(None);}
    let mut seen=BTreeSet::new();let mut summaries=Vec::new();
    for raw in nullish(clip.get("markerSummaries"),clip.get("markers")).and_then(Value::as_array).into_iter().flatten(){if let Some(marker)=marker_summary(raw)?{if seen.insert(marker["id"].as_str().unwrap().to_owned()){summaries.push(marker);}}}
    summaries.truncate(100);
    let samples=normalize_recording_apm_samples(clip.get("apmSamples"));
    out.insert("id".into(),json!(clip_id));out.insert("relativePath".into(),json!(relative));out.insert("fileName".into(),json!(bounded(clip.get("fileName"),windows_basename(relative),512)));
    out.insert("createdAt".into(),clip.get("createdAt").filter(|v|v.is_string()).cloned().unwrap_or(json!(EPOCH)));
    if !summaries.is_empty(){out.insert("markerSummaries".into(),json!(summaries));}if !samples.is_empty(){out.insert("apmSamples".into(),json!(samples));}
    for key in ["apmAverage","apmPeak"]{if let Some(n)=time(clip.get(key),6000.0){out.insert(key.into(),json!(n));}}
    if let Some(v)=clip.get("apmAvailable").filter(|v|v.is_boolean()){out.insert("apmAvailable".into(),v.clone());}
    if integer(clip.get("editorVersion")).is_some_and(|n|n>0.0){out.insert("editorVersion".into(),clip["editorVersion"].clone());}Ok(Some(Value::Object(out)))
}
pub fn normalize_encoder_states(value:Option<&Value>)->Result<Vec<Value>,String>{
    let mut states=Vec::new();
    for item in value.and_then(Value::as_array).into_iter().flatten(){let Some(kind)=item.get("type").and_then(Value::as_str)else{continue;};let mut out=json!({"type":sliced(kind,128)?,"description":bounded(item.get("description"),kind,256),"enumerated":true,"probeValid":strict_true(item.get("probeValid"))||strict_true(item.get("valid")),"startTested":strict_true(item.get("startTested")),"startSupported":not_false(item.get("startSupported")),"code":item.get("code").filter(|v|integer(Some(v)).is_some()).cloned().unwrap_or(Value::Null),"status":bounded(item.get("status"),"",256)});
    for key in ["deviceKey","deviceName","adapterName","gpuName"]{if let Some(v)=item.get(key).and_then(Value::as_str).filter(|s|len(s)<=256 && !trim(s).is_empty()){out.as_object_mut().unwrap().insert(key.into(),json!(v));}}states.push(out);}Ok(states)
}
fn uint32(n:f64)->u32{n.rem_euclid(4_294_967_296.0)as u32}
pub fn format_dxgi_luid(value:Option<&Value>)->Option<String>{let value=value?;let low=number(value.get("low")).filter(|n|n.fract()==0.0 && n.abs()<=9_007_199_254_740_991.0)?;let high=number(value.get("high")).filter(|n|n.fract()==0.0 && n.abs()<=9_007_199_254_740_991.0)?;Some(format!("0x{:08X}:0x{:08X}",uint32(high),uint32(low)))}
pub fn normalize_dxgi_luid(value:Option<&Value>)->Option<String>{
    let value=value?;if value.is_object()||value.is_array(){return format_dxgi_luid(Some(value));}let s=trim(value.as_str()?);let (high,low)=s.split_once(':')?;
    let parse=|text:&str|->Option<f64>{let neg=text.starts_with('-');let text=text.strip_prefix('-').unwrap_or(text);let hex=text.starts_with("0x")||text.starts_with("0X")||text.bytes().any(|b|matches!(b,b'a'..=b'f'|b'A'..=b'F'));let digits=if hex{text.strip_prefix("0x").or_else(||text.strip_prefix("0X")).unwrap_or(text)}else{text};if digits.is_empty()||!digits.bytes().all(|b|b.is_ascii_hexdigit()){return None;}let radix=if hex{16}else{10};let mut n=0.0;for c in digits.chars(){n=n*f64::from(radix)+f64::from(c.to_digit(radix)?);}if neg{n=-n;} (n.abs()<=9_007_199_254_740_991.0).then_some(n)};
    format_dxgi_luid(Some(&json!({"high":parse(high)?,"low":parse(low)?})))
}

#[derive(Debug,Clone,PartialEq,serde::Serialize)]
pub struct AscentJsonObjects{pub objects:Vec<Value>,pub remainder:String}
pub fn consume_ascent_json_objects(previous:Option<&str>,chunk:Option<&str>,max_bytes:usize)->Result<AscentJsonObjects,String>{
    let buffer=format!("{}{}",previous.unwrap_or(""),chunk.unwrap_or(""));if buffer.len()>max_bytes.saturating_mul(4){return Err("Ascent output buffer exceeded its safety bound".into());}
    let mut objects=Vec::new();let mut start=None;let mut depth=0usize;let mut in_string=false;let mut escaped=false;
    for (cursor,byte) in buffer.bytes().enumerate(){if start.is_none(){if byte==b'{'{start=Some(cursor);depth=1;}else if !matches!(byte,b' '|b'\t'|b'\n'|b'\r'){return Err("Unexpected bytes in Ascent JSON stream".into());}continue;}
        if in_string{if escaped{escaped=false;}else if byte==b'\\'{escaped=true;}else if byte==b'"'{in_string=false;}}else if byte==b'"'{in_string=true;}else if byte==b'{'{depth+=1;}else if byte==b'}'{depth-=1;}
        if depth==0{let raw=&buffer[start.unwrap()..cursor+1];if raw.len()>max_bytes{return Err("Ascent JSON message exceeded its safety bound".into());}let value:Value=serde_json::from_str(raw).map_err(|e|format!("Invalid Ascent JSON message: {e}"))?;if !value.is_object(){return Err("Ascent message must be a JSON object".into());}objects.push(value);start=None;in_string=false;escaped=false;}
    }
    Ok(AscentJsonObjects{objects,remainder:start.map(|start|buffer[start..].to_owned()).unwrap_or_default()})
}

pub const RECORDING_RUNTIME_DIRECTORY: &str = "recording-runtime";
pub const RECORDING_NON_DISPLAY_ENCODER_IDS: &[(&str,&str)] = &[("obs_qsv11_v2","obs_qsv11_soft_v2"),("obs_qsv11_hevc","obs_qsv11_hevc_soft"),("obs_qsv11_av1","obs_qsv11_av1_soft")];
pub const RECORDING_CLIP_NAME_PHRASES: &[&str] = &["Great Play","Nice Shot","Outplay","Genius Play","Beautiful Moment","Arc Moment","Crazy Clip"];
pub fn recording_resolutions()->Value{json!([
    {"id":"default","width":0,"height":0,"label":"Default"},{"id":"480p","width":854,"height":480,"label":"480p"},{"id":"720p","width":1280,"height":720,"label":"720p"},{"id":"900p","width":1600,"height":900,"label":"900p"},
    {"id":"1080p","width":1920,"height":1080,"label":"1080p"},{"id":"1440p","width":2560,"height":1440,"label":"1440p"},{"id":"4k","width":3840,"height":2160,"label":"4K"}])}
pub fn recording_bitrate_ranges()->Value{let mut ranges=Map::new();for id in ["default","480p","720p","900p","1080p","1440p","4k"]{ranges.insert(id.into(),recording_bitrate_range(id));}Value::Object(ranges)}
pub fn default_recording_settings()->Value{normalize_recording_settings(None)}

#[cfg(test)]
mod tests{
    use super::*;
    fn equivalent(a:&Value,b:&Value)->bool{match(a,b){(Value::Number(a),Value::Number(b))=>a.as_f64()==b.as_f64(),(Value::Array(a),Value::Array(b))=>a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|equivalent(a,b)),(Value::Object(a),Value::Object(b))=>a.len()==b.len()&&a.iter().all(|(k,a)|b.get(k).is_some_and(|b|equivalent(a,b))),_=>a==b}}
    fn call(name:&str,args:&[Value])->Result<Value,String>{
        let a=|i|args.get(i);let string=|i,default:&str|a(i).and_then(Value::as_str).unwrap_or(default).to_owned();
        Ok(match name{
            "normalizeRecordingSettings"=>normalize_recording_settings(a(0)),"normalizeRecordingCaptureTarget"=>normalize_recording_capture_target(a(0)),"normalizeRecordingAudioSettings"=>normalize_recording_audio_settings(a(0)),
            "validateRecordingProcessNames"=>json!(validate_recording_process_names(a(0).unwrap_or(&Value::Null))?),
            "normalizeRecordingFps"=>json!(normalize_recording_fps(a(0),a(1))),"normalizeRecordingBitrate"=>normalize_recording_bitrate(a(0),a(1)),
            "recordingBitrateRange"=>recording_bitrate_range(&string(0,if args.is_empty(){"1080p"}else{""})),"clampRecordingBitrate"=>json!(clamp_recording_bitrate(a(0),&string(1,if args.len()<2{"1080p"}else{""}))),
            "recordingOutputDimensions"=>recording_output_dimensions(&string(0,"default"),a(1),a(2)),"recordingRateControlQualityMax"=>json!(recording_rate_control_quality_max(&string(0,""),a(1))),
            "recordingEncoderCodecOf"=>json!(recording_encoder_codec_of(a(0))),"recordingRuntimeEncoderIdForTarget"=>recording_runtime_encoder_id_for_target(a(0).unwrap_or(&Value::Null),a(1)),
            "normalizeRecordingAccelerator"=>normalize_recording_accelerator(a(0),a(1).unwrap_or(&Value::Null)),
            "formatDxgiLuid"=>json!(format_dxgi_luid(a(0))),"normalizeDxgiLuid"=>json!(normalize_dxgi_luid(a(0))),
            "normalizeRecordingMarker"=>normalize_recording_marker(a(0),&string(1,EPOCH))?.unwrap_or(Value::Null),"normalizeRecordingMarkers"=>json!(normalize_recording_markers(a(0),&string(1,EPOCH))?),
            "normalizeRecordingApmSamples"=>json!(normalize_recording_apm_samples(a(0))),"mapRecordingApmSamplesToClip"=>json!(map_recording_apm_samples_to_clip(a(0),a(1),a(2))),
            "normalizeRecordingClip"=>normalize_recording_clip(a(0))?.unwrap_or(Value::Null),"normalizeEncoderStates"=>json!(normalize_encoder_states(a(0))?),
            "safeVideoExtension"=>json!(safe_video_extension(a(0).unwrap_or(&Value::Null))),"isRecordingTemporaryArtifact"=>json!(is_recording_temporary_artifact(a(0).unwrap_or(&Value::Null))),
            "consumeAscentJsonObjects"=>serde_json::to_value(consume_ascent_json_objects(a(0).and_then(Value::as_str),a(1).and_then(Value::as_str),a(2).and_then(Value::as_u64).map(|n|n as usize).unwrap_or(ASCENT_MAX_MESSAGE_BYTES))?).unwrap(),
            _=>return Err(format!("Unknown fixture method {name}"))})
    }
    #[test]
    fn original_javascript_differential_contract_fixtures(){
        let data:Value=serde_json::from_str(include_str!("fixtures/recording-contract-parity.json")).unwrap();
        for(index,fixture)in data["fixtures"].as_array().unwrap().iter().enumerate(){let name=fixture["method"].as_str().unwrap();let result=call(name,fixture["args"].as_array().unwrap());
            if let Some(error)=fixture.get("error"){let actual=result.unwrap_err();if error.as_str()==Some("json-parse"){assert!(actual.starts_with("Invalid Ascent JSON message:"));}else{assert_eq!(actual,error.as_str().unwrap(),"fixture {index}");}}else{let actual=result.unwrap_or_else(|error|panic!("fixture {index} {name}: {error}"));assert!(equivalent(&actual,&fixture["expected"]),"fixture {index} {name} args={} actual={actual} expected={}",fixture["args"],fixture["expected"]);}}
        assert!(equivalent(&default_recording_settings(),&data["defaults"]));assert_eq!(recording_resolutions(),data["resolutions"]);assert!(equivalent(&recording_bitrate_ranges(),&data["bitrateRanges"]));
    }
    #[test]
    fn marker_cap_keeps_last_unique_entries_and_sample_sort_is_stable(){
        let markers:Vec<_>=(0..510).map(|n|json!({"id":format!("marker{n:04}"),"sessionId":"session","atMs":n})).collect();let result=normalize_recording_markers(Some(&json!(markers)),EPOCH).unwrap();assert_eq!(result.len(),500);assert_eq!(result[0]["id"],"marker0010");
        let samples=normalize_recording_apm_samples(Some(&json!([{"atMs":5,"apm":1},{"atMs":5,"apm":2},{"atMs":3,"apm":3}])));assert_eq!(samples[0]["apm"].as_f64(),Some(3.0));assert_eq!(samples[1]["apm"].as_f64(),Some(1.0));assert_eq!(samples[2]["apm"].as_f64(),Some(2.0));
    }
    #[test]
    fn utf16_split_surrogates_fail_explicitly_without_replacing_user_text(){
        let bad_label=format!("{}😀","a".repeat(79));
        let marker=json!({"id":"marker_01","sessionId":"session","atMs":1,"label":bad_label});
        assert!(normalize_recording_marker(Some(&marker),EPOCH).unwrap_err().contains("split a UTF-16 surrogate"));
        assert!(normalize_recording_markers(Some(&json!([marker])),EPOCH).is_err());
        let clip=json!({"id":"clip_001","relativePath":"clip.mp4","markerSummaries":[{"id":"marker_01","atMs":1,"label":bad_label}]});
        assert!(normalize_recording_clip(Some(&clip)).is_err());
        assert!(normalize_encoder_states(Some(&json!([{"type":format!("{}😀","a".repeat(127))}]))).is_err());
        let safe=json!({"id":"marker_01","sessionId":"session","atMs":1,"label":format!("{}😀end","a".repeat(78))});
        assert_eq!(normalize_recording_marker(Some(&safe),EPOCH).unwrap().unwrap()["label"],format!("{}😀","a".repeat(78)));
    }
}
