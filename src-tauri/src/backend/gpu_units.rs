//! Pure port of src/main/backend/units.js. Numeric APIs intentionally accept
//! f64, as their source contracts accept numbers; callers must not coerce JSON
//! strings/null into numbers. Name/identity APIs accept JSON to retain the
//! source's explicit String(), nullish and strict-boolean behavior.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;

pub const INTEGRATED_DEDICATED_MEMORY_PLACEHOLDER_BYTES: f64 = 268_435_456.0;
pub const GPU_LOCK_FREQ_MAX_MHZ: f64 = 5000.0;
pub const GPU_LOCK_VOLT_MAX_V: f64 = 1.5;
pub const TEMP_LIMIT_MAX_C: f64 = 90.0;
pub const VOLT_OFFSET_MAX_V: f64 = 0.234;
pub const VOLT_OFFSET_STEP_V: f64 = 0.001;
pub const INTEL_GDDR6_TOKENS: &[&str] = &["a310","a350","a370","a380","a580","a750","a770","b50","b570","b580","b60"];

fn js_round(value: f64) -> f64 {
    if !value.is_finite() || value.fract() == 0.0 { return value; }
    let floor = value.floor();
    let result = if value-floor < 0.5 {floor} else {floor+1.0};
    if result == 0.0 && value.is_sign_negative() {-0.0} else {result}
}
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {f64::NAN}
    else if a == 0.0 && b == 0.0 {if a.is_sign_negative() || b.is_sign_negative() {-0.0} else {0.0}}
    else {a.min(b)}
}
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {f64::NAN}
    else if a == 0.0 && b == 0.0 {if a.is_sign_positive() || b.is_sign_positive() {0.0} else {-0.0}}
    else {a.max(b)}
}
pub fn dedicated_memory_bytes_of(value: f64, integrated_or_mobile: bool) -> Option<f64> {
    if !value.is_finite() || value.fract() != 0.0 || value <= 0.0
        || (integrated_or_mobile && value <= INTEGRATED_DEDICATED_MEMORY_PLACEHOLDER_BYTES) {None} else {Some(value)}
}
pub fn canonical_unit(units: f64) -> String {
    let name = match units {
        0.0|12.0 => "MHz",1.0=>"GTS",2.0=>"MTS",3.0=>"V",4.0=>"W",5.0=>"C",
        6.0=>"ENERGY_JOULES",7.0=>"TIME_SECONDS",8.0=>"MEMORY_BYTES",9.0=>"RPM",
        10.0=>"mW",11.0=>"%",13.0=>"mV",14.0=>"BANDWIDTH_MBPS",_=>return format!("UNITS_{}",number_string(units)),
    }; name.into()
}
pub fn canonical_to_igcl(value: f64, units: f64) -> f64 {
    match units {10.0|13.0|2.0=>value*1000.0,12.0=>value/125.0,_=>value}
}
pub fn igcl_to_canonical(value: f64, units: f64) -> f64 {
    match units {10.0|13.0|2.0=>value/1000.0,12.0=>value*125.0,_=>value}
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Range {pub min: f64,pub max: f64,pub step: f64}
pub fn clamp_and_snap(value: f64, range: Range) -> f64 {
    if !value.is_finite() {return range.min;}
    let snapped = if range.step > 0.0 {
        let snapped = range.min + js_round((value-range.min)/range.step)*range.step;
        js_round(snapped/range.step)*range.step
    } else {value};
    js_min(range.max,js_max(range.min,snapped))
}
pub fn nearly_equal(a: f64,b: f64,eps: f64) -> bool {(a-b).abs()<=eps}
pub fn clamp_fan_pct(pct: f64) -> f64 {js_min(100.0,js_max(0.0,js_round(pct)))}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct FanPoint {pub t: f64,pub speed_pct: f64}
pub fn normalize_fan_curve(points: &[FanPoint], max_points: f64) -> Vec<FanPoint> {
    let cap = if max_points>0.0 {max_points.trunc() as usize} else {32};
    let mut table: Vec<_> = points.iter().take(cap).map(|p| FanPoint{t:js_min(100.0,js_max(20.0,js_round(p.t))),speed_pct:clamp_fan_pct(p.speed_pct)}).collect();
    // Stable, as Array.sort is. NaN subtraction compares as zero in JS.
    table.sort_by(|a,b| (a.t-b.t).partial_cmp(&0.0).unwrap_or(Ordering::Equal));
    for i in 1..table.len() {if table[i].t<=table[i-1].t {table[i].t=table[i-1].t+1.0;}}
    // A duplicate at the top of the range must not be pushed past 100 C;
    // the driver silently rejects such a table and stays in Auto. Pull the
    // top run back so the table is strictly ascending inside the domain.
    if let Some(last) = table.last() {
        if last.t > 100.0 {
            let end = table.len() - 1;
            table[end].t = 100.0;
            for i in (0..end).rev() {
                if table[i].t >= table[i+1].t { table[i].t = table[i+1].t - 1.0; }
            }
        }
    }
    table
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct GpuLock {pub voltage_v:f64,pub freq_mhz:f64}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct LockRange {pub volt_min:Option<f64>,pub volt_max:Option<f64>,pub freq_min:Option<f64>,pub freq_max:Option<f64>}
pub fn clamp_gpu_lock(lock:GpuLock,range:Option<LockRange>)->GpuLock {
    if lock.voltage_v==0.0 && lock.freq_mhz==0.0 {return GpuLock{voltage_v:0.0,freq_mhz:0.0};}
    let r=range.unwrap_or_default();
    let finite=|value:Option<f64>,fallback|value.filter(|v|v.is_finite()).unwrap_or(fallback);
    let vmin=js_max(0.0,finite(r.volt_min,0.0));let vmax=finite(r.volt_max,GPU_LOCK_VOLT_MAX_V);
    let fmin=js_max(0.0,finite(r.freq_min,0.0));let fmax=finite(r.freq_max,GPU_LOCK_FREQ_MAX_MHZ);
    GpuLock{voltage_v:if lock.voltage_v==0.0 {0.0}else{js_min(js_max(vmin,lock.voltage_v),vmax)},
        freq_mhz:if lock.freq_mhz==0.0 {0.0}else{js_min(js_max(fmin,lock.freq_mhz),fmax)}}
}

fn number_string(value:f64)->String {
    if value.is_nan(){return "NaN".into();}if value==f64::INFINITY{return "Infinity".into();}if value==f64::NEG_INFINITY{return "-Infinity".into();}
    if value==0.0{return "0".into();}
    if value.abs()>=1e21 || value.abs()<1e-6 {
        let text=format!("{value:e}");let (m,e)=text.split_once('e').unwrap();let exponent:i32=e.parse().unwrap();
        return if exponent>=0{format!("{m}e+{exponent}")}else{format!("{m}e{exponent}")};
    }value.to_string()
}
fn string(value:&Value)->String {
    match value {Value::Null=>"null".into(),Value::Bool(v)=>v.to_string(),Value::Number(v)=>number_string(v.as_f64().unwrap()),
        Value::String(v)=>v.clone(),Value::Array(v)=>v.iter().map(|v|if v.is_null(){String::new()}else{string(v)}).collect::<Vec<_>>().join(","),Value::Object(_)=>"[object Object]".into()}
}
fn field_string(device:&Value,key:&str)->String {device.get(key).filter(|v|!v.is_null()).map(string).unwrap_or_default()}
fn words(text:&str)->Vec<String> {
    text.to_lowercase().split(|c:char|!c.is_ascii_alphanumeric()).filter(|s|!s.is_empty()).map(str::to_owned).collect()
}
// JS \b uses ASCII letters/digits/underscore as word characters. Keep '_' in
// classification tokens, unlike the GDDR6 table's explicit [a-z0-9]+ regex.
fn boundary_words(text:&str)->Vec<String> {
    text.to_lowercase().split(|c:char|!(c.is_ascii_alphanumeric()||c=='_')).filter(|s|!s.is_empty()).map(str::to_owned).collect()
}
pub fn vram_mem_type_of_name(name:&Value)->Option<&'static str> {
    let text=if name.is_null(){String::new()}else{string(name)};
    let tokens=words(&text);INTEL_GDDR6_TOKENS.iter().any(|t|tokens.iter().any(|s|s==t)).then_some("GDDR6")
}
/// Name is JSON because the source returns the original falsey name unchanged.
pub fn format_device_name(name:&Value,vram_bytes:Option<f64>,mem_type:Option<&str>)->Value {
    let truthy=match name {Value::Null=>false,Value::Bool(v)=>*v,Value::Number(v)=>v.as_f64()!=Some(0.0),Value::String(s)=>!s.is_empty(),_=>true};
    let Some(bytes)=vram_bytes.filter(|n|n.is_finite()&&n.fract()==0.0&&*n>0.0) else{return name.clone();};
    if !truthy{return name.clone();}
    let plain=string(name);
    if bytes>=1_073_741_824.0 {
        let memory_type=mem_type.filter(|s|!s.is_empty()).or_else(||vram_mem_type_of_name(name));
        Value::String(format!("{plain} {}GB{}",number_string((bytes/1_073_741_824.0).ceil()),memory_type.map(|s|format!(" {s}")).unwrap_or_default()))
    }else{Value::String(format!("{plain} {} MB",number_string((bytes/1_048_576.0).floor())))}
}
pub fn device_hardware_key(device:&Value)->String {
    let vendor=field_string(device,"pciVendorId").to_lowercase();let pci=field_string(device,"pciDeviceId").to_lowercase();
    let bdf=device.get("bdf").unwrap_or(&Value::Null);
    let coordinate=|key|bdf.get(key).and_then(Value::as_f64).filter(|n|n.is_finite()&&n.fract()==0.0).unwrap_or(-1.0);
    let(mut bus,mut slot,mut function)=(coordinate("bus"),coordinate("device"),coordinate("function"));
    if bus==0.0&&slot==0.0&&function==0.0 {bus=-1.0;slot=-1.0;function=-1.0;}
    format!("pci:{vendor}:{pci}@{}:{}.{}",number_string(bus),number_string(slot),number_string(function))
}
fn decimal_model(token:&str,prefix:char,min:usize,max:usize,suffix:&str)->bool {
    token.strip_prefix(prefix).and_then(|s|s.strip_suffix(suffix)).is_some_and(|s|s.len()>=min&&s.len()<=max&&s.bytes().all(|c|c.is_ascii_digit()))
}
fn phrase(text:&str,phrase:&str)->bool {
    text.match_indices(phrase).any(|(at,_)|{
        let is_word=|c:char|c.is_ascii_alphanumeric()||c=='_';
        !text[..at].chars().next_back().is_some_and(is_word)&&!text[at+phrase.len()..].chars().next().is_some_and(is_word)
    })
}
fn js_space(c:char)->bool {matches!(c,'\t'|'\n'|'\u{000b}'|'\u{000c}'|'\r'|' '|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')}
fn strip_memory_suffix(name:&str)->&str {
    for (index,c) in name.char_indices() {
        if !js_space(c){continue;}
        let rest=name[index..].trim_start_matches(js_space);
        let digits=rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits==0{continue;}
        let rest=rest[digits..].trim_start_matches(js_space);
        let Some(rest)=rest.strip_prefix("gb")else{continue;};
        if rest.is_empty(){return &name[..index];}
        let token=rest.trim_start_matches(js_space);
        if token.len()<rest.len()&&!token.is_empty()&&!token.chars().any(js_space){return &name[..index];}
    }name
}
pub fn is_integrated_style_device(device:&Value)->bool {
    let raw_name=field_string(device,"name").to_lowercase();
    let name=strip_memory_suffix(&raw_name);
    let tokens=boundary_words(name);let has=|s:&str|tokens.iter().any(|t|t==s);let arc=has("arc");
    if has("iris")||has("uhd")||phrase(&name,"hd graphics")||phrase(&name,"xe graphics"){return true;}
    if arc&&(tokens.iter().any(|t|decimal_model(t,'a',2,4,"m")||decimal_model(t,'b',2,4,"m"))
        ||has("b370")||has("b390")||has("mobile")||has("integrated")||has("igpu")){return true;}
    if !arc {
        // intel(?:\s*\([^)]*\))?\s+graphics with outer word boundaries.
        for (at,_) in name.match_indices("intel") {
            if at>0&&name[..at].chars().next_back().is_some_and(|c|c.is_ascii_alphanumeric()||c=='_'){continue;}
            let mut rest=&name[at+5..];let trimmed=rest.trim_start_matches(js_space);
            if let Some(parenthesized)=trimmed.strip_prefix('('){if let Some(end)=parenthesized.find(')'){rest=&parenthesized[end+1..];}}
            let trimmed=rest.trim_start_matches(js_space);
            if trimmed.len()<rest.len()&&phrase(trimmed,"graphics")&&trimmed.starts_with("graphics"){return true;}
        }
    }
    arc&&!tokens.iter().any(|t|decimal_model(t,'a',3,3,"")||decimal_model(t,'b',2,3,"")||t=="pro")
}
pub fn is_intel_integrated_or_mobile_arc(device:&Value)->bool {
    let vendor=device.get("pciVendorId").and_then(|raw|match raw {
        Value::Number(n)=>n.as_f64().filter(|n|n.fract()==0.0&&*n>=0.0&&*n<=65535.0).map(|n|format!("{:04x}",n as u32)),
        Value::String(s)=>{let lower=s.trim_matches(js_space).to_lowercase();let mut hex=lower.strip_prefix("0x").unwrap_or(&lower);
            while hex.len()>1&&hex.starts_with('0')&&hex.as_bytes()[1].is_ascii_hexdigit(){hex=&hex[1..];}
            if !hex.is_empty()&&hex.len()<=4&&hex.bytes().all(|b|b.is_ascii_hexdigit()){Some(format!("{hex:0>4}"))}
            else if (5..=8).contains(&hex.len())&&hex.bytes().all(|b|b.is_ascii_hexdigit())&&hex.ends_with("8086"){Some("8086".into())}else{None}},_=>None});
    if vendor.is_some_and(|v|v!="8086"){return false;}
    device.get("integrated")==Some(&Value::Bool(true))||device.get("mobile")==Some(&Value::Bool(true))||is_integrated_style_device(device)
}
/// Preserve the source's localeCompare contract by injecting the same locale's
/// key comparator. Rust byte ordering is not a general replacement for ICU.
pub fn sort_devices_discrete_first_by(devices:&Value,mut compare_keys:impl FnMut(&str,&str)->Ordering)->Vec<Value> {
    let Some(devices)=devices.as_array()else{return vec![];};let mut result=devices.clone();
    result.sort_by(|a,b|is_integrated_style_device(a).cmp(&is_integrated_style_device(b))
        .then_with(||compare_keys(&device_hardware_key(a),&device_hardware_key(b))));result
}
pub fn is_arc_device(device:&Value)->bool {
    let name=field_string(device,"name").to_lowercase();
    boundary_words(&name).iter().any(|t|t=="arc")&&!is_integrated_style_device(device)&&!name.contains("basic")&&!name.contains("microsoft")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn equivalent(left:&Value,right:&Value)->bool {
        match (left,right) {
            (Value::Number(a),Value::Number(b))=>a.as_f64()==b.as_f64(),
            (Value::Array(a),Value::Array(b))=>a.len()==b.len()&&a.iter().zip(b).all(|(a,b)|equivalent(a,b)),
            (Value::Object(a),Value::Object(b))=>a.len()==b.len()&&a.iter().all(|(key,value)|b.get(key).is_some_and(|other|equivalent(value,other))),
            _=>left==right,
        }
    }
    #[test]
    fn differential_source_fixtures() {
        let fixtures:Value=serde_json::from_str(include_str!("fixtures/gpu-units-source.json")).unwrap();
        for (index,case) in fixtures["cases"].as_array().unwrap().iter().enumerate() {
            let args=&case["args"];let number=|i:usize|args[i].as_f64().unwrap();
            let actual=match case["fn"].as_str().unwrap() {
                "canonicalUnit"=>json!(canonical_unit(number(0))),
                "canonicalToIgcl"=>json!(canonical_to_igcl(number(0),number(1))),
                "igclToCanonical"=>json!(igcl_to_canonical(number(0),number(1))),
                "dedicatedMemoryBytesOf"=>json!(dedicated_memory_bytes_of(number(0),args[1].as_bool().unwrap())),
                "clampAndSnap"=>json!(clamp_and_snap(number(0),serde_json::from_value(args[1].clone()).unwrap())),
                "clampFanPct"=>json!(clamp_fan_pct(number(0))),
                "nearlyEqual"=>json!(nearly_equal(number(0),number(1),number(2))),
                "normalizeFanCurve"=>json!(normalize_fan_curve(&serde_json::from_value::<Vec<FanPoint>>(args[0].clone()).unwrap(),number(1))),
                "clampGpuLock"=>json!(clamp_gpu_lock(serde_json::from_value(args[0].clone()).unwrap(),serde_json::from_value(args[1].clone()).unwrap())),
                "vramMemTypeOfName"=>json!(vram_mem_type_of_name(&args[0])),
                "formatDeviceName"=>format_device_name(&args[0],args[1].as_f64(),args[2].as_str()),
                "deviceHardwareKey"=>json!(device_hardware_key(&args[0])),
                "isIntegratedStyleDevice"=>json!(is_integrated_style_device(&args[0])),
                "isIntelIntegratedOrMobileArc"=>json!(is_intel_integrated_or_mobile_arc(&args[0])),
                "isArcDevice"=>json!(is_arc_device(&args[0])),
                "sortDevicesDiscreteFirst"=>json!(sort_devices_discrete_first_by(&args[0],|a,b|{
                    let sample=fixtures["keyComparisons"].as_array().unwrap().iter().find(|sample|sample["a"]==a&&sample["b"]==b).expect("recorded source locale comparison");
                    sample["order"].as_i64().unwrap().cmp(&0)
                })),
                other=>panic!("unhandled fixture {other}"),
            };
            assert!(equivalent(&actual,&case["expected"]),"fixture {index} {}: actual {actual}, expected {}",case["fn"],case["expected"]);
        }
    }
    #[test]
    fn nonfinite_and_signed_zero_numeric_semantics_are_not_json_null() {
        assert_eq!(clamp_and_snap(f64::NAN,Range{min:3.0,max:9.0,step:1.0}),3.0);
        assert!(clamp_fan_pct(f64::NAN).is_nan());
        assert_eq!(clamp_fan_pct(f64::INFINITY),100.0);
        assert!(!nearly_equal(f64::INFINITY,f64::INFINITY,1e-9));
        assert!(js_round(-0.5).is_sign_negative());
        assert_eq!(js_round(-1.5),-1.0);
        assert!(dedicated_memory_bytes_of(f64::INFINITY,false).is_none());
        let lock=clamp_gpu_lock(GpuLock{voltage_v:f64::NAN,freq_mhz:0.0},None);
        assert!(lock.voltage_v.is_nan());assert_eq!(lock.freq_mhz,0.0);
    }
    #[test]
    fn duplicate_top_temperature_is_pulled_back_into_range() {
        let points = vec![
            FanPoint { t: 0.0, speed_pct: 20.0 },
            FanPoint { t: 50.0, speed_pct: 30.0 },
            FanPoint { t: 100.0, speed_pct: 80.0 },
            FanPoint { t: 100.0, speed_pct: 100.0 },
        ];
        let table = normalize_fan_curve(&points, 10.0);
        assert_eq!(table.iter().map(|p| p.t).collect::<Vec<_>>(), vec![20.0, 50.0, 99.0, 100.0]);
        assert_eq!(table.iter().map(|p| p.speed_pct).collect::<Vec<_>>(), vec![20.0, 30.0, 80.0, 100.0]);
        assert!(table.iter().all(|p| (20.0..=100.0).contains(&p.t)));
    }
    #[test]
    fn frontend_json_decimal_preserves_javascript_number_bits() {
        let parsed: f64 = serde_json::from_str("0.234").unwrap();
        assert_eq!(parsed.to_bits(), 0.234_f64.to_bits(),
            "JSON parser changed input: parsed={parsed:.18}, literal={:.18}; parsed bits={:016x}, literal bits={:016x}",
            0.234_f64, parsed.to_bits(), 0.234_f64.to_bits());
    }
}
