//! Pure Stability Lab request, telemetry, evidence, and report contract.
use serde_json::{json,Map,Value};
use std::collections::HashSet;

pub const STABILITY_SCHEMA_VERSION:u64=1;
pub const STABILITY_CADENCE_MIN_MS:u32=250;
pub const STABILITY_CADENCE_MAX_MS:u32=2000;
pub const STABILITY_CADENCE_DEFAULT_MS:u32=600;
pub const STABILITY_DURATION_MIN_SEC:u32=10;
pub const STABILITY_DURATION_MAX_SEC:u32=900;
pub const STABILITY_MAX_REPORTS:usize=50;

pub trait StabilityClock {fn now_ms(&self)->f64;fn now_iso(&self)->&str;}

fn js_trim(text:&str)->&str {text.trim_matches(|c:char|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))}
fn slice(text:&str,max:usize)->Result<String,String> {String::from_utf16(&text.encode_utf16().take(max).collect::<Vec<_>>()).map_err(|_|"JS UTF-16 truncation produced a lone surrogate; refusing lossy stability metadata".into())}
pub fn normalize_stable_device_key(value:&Value)->Option<String> {
    value.as_str().map(js_trim).filter(|s|(2..=512).contains(&s.encode_utf16().count())).map(str::to_owned)
}
pub(crate) fn js_number(value:Option<&Value>)->f64 {
    match value {
        None=>f64::NAN,Some(Value::Null)=>0.0,Some(Value::Bool(b))=>if *b{1.0}else{0.0},
        Some(Value::Number(n))=>n.as_f64().unwrap_or(f64::NAN),Some(Value::Object(_))=>f64::NAN,
        Some(Value::Array(items))=>js_number(Some(&Value::String(items.iter().map(|v|if v.is_null(){String::new()}else{js_string(v)}).collect::<Vec<_>>().join(",")))),
        Some(Value::String(s))=>{
            let s=js_trim(s);if s.is_empty(){return 0.0;}
            for (prefix,base) in [("0x",16),("0X",16),("0b",2),("0B",2),("0o",8),("0O",8)] {
                if let Some(digits)=s.strip_prefix(prefix){if digits.is_empty(){return f64::NAN;}let mut out=0.0;for ch in digits.chars(){let Some(digit)=ch.to_digit(base)else{return f64::NAN;};out=out*base as f64+digit as f64;}return out;}
            }
            // Number() recognizes Infinity exactly; Rust also accepts inf.
            if matches!(s,"Infinity"|"+Infinity"){return f64::INFINITY;}if s=="-Infinity"{return f64::NEG_INFINITY;}
            if s.to_ascii_lowercase().contains("inf"){return f64::NAN;}
            s.parse::<f64>().unwrap_or(f64::NAN)
        }
    }
}
fn js_string(value:&Value)->String {
    match value {
        Value::Null=>"null".into(),Value::Bool(b)=>b.to_string(),Value::String(s)=>s.clone(),Value::Object(_)=>"[object Object]".into(),
        Value::Array(items)=>items.iter().map(|v|if v.is_null(){String::new()}else{js_string(v)}).collect::<Vec<_>>().join(","),
        Value::Number(n)=>number_string(n.as_f64().unwrap()),
    }
}
fn number_string(number:f64)->String {
    if number==0.0{return "0".into();}
    if number.abs()>=1e21||number.abs()<1e-6 {
        let scientific=format!("{number:e}");let (mantissa,exponent)=scientific.split_once('e').unwrap();let exponent=exponent.parse::<i32>().unwrap();
        format!("{mantissa}e{}{exponent}",if exponent>=0{"+"}else{""})
    }else{number.to_string()}
}
fn finite(value:Option<&Value>)->Option<f64> {value.and_then(Value::as_f64).filter(|v|v.is_finite())}
fn numeric_or_zero(value:Option<&Value>)->f64 {let n=js_number(value);if n.is_nan()||n==0.0{0.0}else{n}}
fn js_round(n:f64)->f64 {if !n.is_finite(){return n;}let floor=n.floor();if n-floor<0.5{floor}else{floor+1.0}}
fn nullish<'a>(raw:&'a Value,fields:&[&str])->Option<&'a Value>{fields.iter().find_map(|key|raw.get(*key).filter(|v|!v.is_null()))}
fn is_object(value:&Value)->bool {value.is_object()||value.is_array()}
fn truthy(value:&Value)->bool {match value {Value::Null=>false,Value::Bool(b)=>*b,Value::Number(n)=>n.as_f64().is_some_and(|n|n!=0.0),Value::String(s)=>!s.is_empty(),_=>true}}
fn spread(value:&Value)->Map<String,Value> {match value{Value::Object(map)=>map.clone(),Value::Array(items)=>items.iter().enumerate().map(|(i,v)|(i.to_string(),v.clone())).collect(),_=>Map::new()}}

fn clamp(value:Option<&Value>,minimum:u32,maximum:u32)->Option<u32> {let n=js_number(value);n.is_finite().then(||js_round(n).clamp(minimum as f64,maximum as f64)as u32)}
pub fn clamp_cadence_ms(value:Option<&Value>)->Option<u32>{clamp(value,STABILITY_CADENCE_MIN_MS,STABILITY_CADENCE_MAX_MS)}
pub fn clamp_duration_sec(value:Option<&Value>)->Option<u32>{clamp(value,STABILITY_DURATION_MIN_SEC,STABILITY_DURATION_MAX_SEC)}
pub fn normalize_stability_request(payload:&Value)->Result<Value,String> {
    if !payload.is_object(){return Err("stability request must be an object".into());}
    let key=normalize_stable_device_key(&payload["deviceKey"]).ok_or("stability request requires a stable device key")?;
    let cadence=clamp_cadence_ms(payload.get("cadenceMs"));let duration=clamp_duration_sec(payload.get("durationSec"));
    let (Some(cadence),Some(duration))=(cadence,duration)else{return Err("stability cadence or duration is invalid".into());};
    Ok(json!({"deviceKey":key,"cadenceMs":cadence,"durationSec":duration}))
}
pub fn normalize_timestamp_ms(value:Option<&Value>,fallback:Option<&Value>,clock:&impl StabilityClock)->f64 {
    let Some(n)=finite(value)else{return finite(fallback).unwrap_or_else(||clock.now_ms());};
    js_round(if n>0.0&&n<1e12{n*1000.0}else{n})
}
pub fn normalize_receipt_timestamp_ms(value:Option<&Value>,fallback:Option<&Value>,clock:&impl StabilityClock)->f64 {
    finite(value).or_else(||finite(fallback)).map(js_round).unwrap_or_else(||clock.now_ms())
}
pub fn normalize_stability_sample(input:&Value,now_ms:Option<&Value>,clock:&impl StabilityClock)->Result<Value,String> {
    let raw=if is_object(input){input}else{&Value::Null};
    let sample=raw.get("sample").filter(|v|is_object(v)).unwrap_or(raw);
    let fallback=now_ms.cloned().unwrap_or_else(||json!(clock.now_ms()));
    let source=normalize_timestamp_ms(nullish(sample,&["tMs","t","timestamp"]),Some(&fallback),clock);
    let received=normalize_receipt_timestamp_ms(nullish(raw,&["receivedAtMs","sampledAtMs"]),Some(&fallback),clock);
    let util=finite(sample.get("utilPct")).or_else(||finite(sample.get("gpuUtilPct")));
    let temp=finite(sample.get("tempC")).or_else(||finite(sample.get("temperatureC"))).or_else(||finite(sample.get("temperature")));
    let power=finite(sample.get("powerW")).or_else(||finite(sample.get("power")));
    let fps=raw.get("fpsSample").filter(|v|is_object(v)).and_then(|v|finite(v.get("fps")));
    let foreground=raw.get("foregroundProcess").filter(|v|is_object(v)).is_some_and(|v|v.get("exePath").is_some_and(truthy)||v.get("pid").is_some_and(truthy));
    let read_error=raw.get("readError").and_then(Value::as_str).filter(|s|!s.is_empty()).map(|s|slice(s,240)).transpose()?;
    let driver_error=raw.get("driverError")==Some(&Value::Bool(true))||sample.get("driverError")==Some(&Value::Bool(true));
    let mut normalized=spread(sample);normalized.insert("utilPct".into(),json!(util));normalized.insert("temperatureC".into(),json!(temp));normalized.insert("powerW".into(),json!(power));
    Ok(json!({"sampledAtMs":received,"receivedAtMs":received,"sourceTimestampMs":source,"sample":normalized,"utilPct":util,"temperatureC":temp,"powerW":power,
        "fps":fps,"present":fps.is_some_and(|f|f>=30.0),"foreground":foreground,"readError":read_error,"driverError":driver_error}))
}
pub fn workload_evidence_of(counters:&Value)->bool {
    let count=numeric_or_zero(counters.get("sampleCount")).max(0.0);
    let util=numeric_or_zero(counters.get("utilEvidenceCount"));
    if counters.get("workloadActive")==Some(&Value::Bool(true))&&count>0.0&&util>0.0{return true;}
    if count==0.0{return false;}let required=(count*0.8).ceil();
    numeric_or_zero(counters.get("foregroundCount"))>0.0&&(numeric_or_zero(counters.get("presentEvidenceCount"))>=required||util>=required)
}
pub fn classify_stability_run(input:&Value)->Value {
    let count=numeric_or_zero(input.get("sampleCount")).max(0.0);
    let missing=numeric_or_zero(nullish(input,&["missingSampleCount","missingMetricsCount"])).max(0.0);
    let fresh=nullish(input,&["freshSampleCount"]).map(|v|numeric_or_zero(Some(v))).unwrap_or(count-missing);
    let fresh=if fresh.is_nan(){0.0}else{fresh.max(0.0)};
    let evidence=input.get("workloadEvidence")==Some(&Value::Bool(true))||workload_evidence_of(input);
    let hint=input.get("outcomeHint").and_then(Value::as_str);
    let outcome=if input.get("cancelled")==Some(&Value::Bool(true))||hint==Some("cancelled"){"cancelled"}
        else if input.get("aborted")==Some(&Value::Bool(true))||hint==Some("aborted"){"aborted"}
        else if input.get("unavailable")==Some(&Value::Bool(true))||hint==Some("unavailable")||count==0.0{"unavailable"}
        else if !evidence{"no-workload"}
        else if fresh/count<0.8||missing>0.0||numeric_or_zero(input.get("driverErrorCount"))>0.0||numeric_or_zero(input.get("thresholdBreaches"))>0.0||numeric_or_zero(input.get("wheaErrorCount"))>0.0||input.get("allocationComplete")==Some(&Value::Bool(false)){"warning"}
        else{"passed"};
    let mut seen=HashSet::new();let missing_metrics:Vec<String>=input["missingMetrics"].as_array().into_iter().flatten().map(js_string).filter(|s|seen.insert(s.clone())).take(32).collect();
    json!({"outcome":outcome,"workloadEvidence":evidence,"freshSampleCount":fresh,"sampleCount":count,"freshRatio":if count!=0.0{fresh/count}else{0.0},"missingMetrics":missing_metrics,
        "thresholdBreaches":numeric_or_zero(input.get("thresholdBreaches")).max(0.0),"driverErrorCount":numeric_or_zero(input.get("driverErrorCount")).max(0.0),"wheaErrorCount":numeric_or_zero(input.get("wheaErrorCount")).max(0.0)})
}
pub fn normalize_stability_report(report:&Value,clock:&impl StabilityClock)->Result<Option<Value>,String> {
    if report.is_null(){return Err("Cannot read properties of null (reading 'target')".into());}
    let target=report.get("target").filter(|v|is_object(v)).unwrap_or(&Value::Null);
    let key=normalize_stable_device_key(target.get("deviceKey").filter(|v|!v.is_null()).or_else(||report.get("deviceKey")).unwrap_or(&Value::Null));
    let Some(key)=key else{return Ok(None);};
    let mut seen=HashSet::new();let mut missing=Vec::new();
    if let Some(metrics)=report["missingMetrics"].as_array(){
        // JS map() truncates every value before Set/slice, even after the
        // 32nd distinct metric. Refuse a split surrogate anywhere in input.
        for metric in metrics {let text=slice(&js_string(metric),80)?;if seen.insert(text.clone()){missing.push(text);}}
        missing.truncate(32);
    }
    let name=target.get("name").and_then(Value::as_str).map(|s|slice(s,160)).transpose()?;
    let id=finite(target.get("id")).filter(|v|v.fract()==0.0);
    let outcome=report.get("outcome").and_then(Value::as_str).filter(|s|["passed","warning","no-workload","unavailable","cancelled","aborted"].contains(s)).unwrap_or("unavailable");
    let run_id=report.get("runId").and_then(Value::as_str).filter(|s|s.encode_utf16().count()<=128).map(str::to_owned).unwrap_or_else(||format!("stability-{}",number_string(clock.now_ms())));
    let snapshot=report.get("settingsSnapshot").filter(|v|is_object(v)).map(spread).unwrap_or_default();
    let reason=report.get("reason").and_then(Value::as_str).map(|s|slice(s,240)).transpose()?;
    let mut normalized=json!({"runId":run_id,"target":{"deviceKey":key,"name":name,"id":id},"settingsSnapshot":snapshot,
        "sampleCount":js_round(numeric_or_zero(report.get("sampleCount"))).clamp(0.0,100000.0),"missingMetrics":missing,
        "workloadEvidence":report.get("workloadEvidence")==Some(&Value::Bool(true)),"outcome":outcome,
        "effectiveCadenceMs":clamp_cadence_ms(report.get("effectiveCadenceMs")).unwrap_or(STABILITY_CADENCE_MIN_MS),
        "effectiveDurationSec":clamp_duration_sec(report.get("effectiveDurationSec")).unwrap_or(STABILITY_DURATION_MIN_SEC),
        "startedAt":report.get("startedAt").filter(|v|v.is_string()).cloned().unwrap_or_else(||json!(clock.now_iso())),
        "endedAt":report.get("endedAt").filter(|v|v.is_string()).cloned().unwrap_or_else(||json!(clock.now_iso())),"reason":reason,
        "freshSampleCount":js_round(numeric_or_zero(report.get("freshSampleCount"))).max(0.0),
        "thresholdBreaches":js_round(numeric_or_zero(report.get("thresholdBreaches"))).max(0.0),
        "driverErrorCount":js_round(numeric_or_zero(report.get("driverErrorCount"))).max(0.0),
        "wheaErrorCount":js_round(numeric_or_zero(report.get("wheaErrorCount"))).max(0.0)});
    if let Some(reason)=report.get("abortReason").and_then(Value::as_str) {
        normalized["abortReason"]=json!(slice(reason,80)?);
    }
    if let Some(bytes)=finite(report.get("vramTargetBytes")) { normalized["vramTargetBytes"]=json!(bytes.max(0.0)); }
    if let Some(bytes)=finite(report.get("vramAllocatedBytes")) { normalized["vramAllocatedBytes"]=json!(bytes.max(0.0)); }
    if let Some(complete)=report.get("vramAllocationComplete").and_then(Value::as_bool) {
        normalized["vramAllocationComplete"]=json!(complete);
    }
    if let Some(rows)=report.get("thresholds").and_then(Value::as_array) {
        let mut seen=HashSet::new();
        let mut thresholds=Vec::new();
        for row in rows {
            let Some(metric)=row.get("metric").and_then(Value::as_str).filter(|metric| !metric.is_empty()) else { continue; };
            let Some(value)=finite(row.get("value")) else { continue; };
            let Some(limit)=finite(row.get("limit")) else { continue; };
            let metric=slice(metric,32)?;
            if value<=limit || !seen.insert(metric.clone()) { continue; }
            thresholds.push(json!({"metric":metric,"value":value,"limit":limit}));
            if thresholds.len()>=16 { break; }
        }
        if !thresholds.is_empty() { normalized["thresholds"]=Value::Array(thresholds); }
    }
    if let Some(limits)=report.get("thresholdLimits").filter(|value|is_object(value)) {
        let mut clean=serde_json::Map::new();
        for key in ["powerW","currentTempC"] {
            if let Some(value)=finite(limits.get(key)).filter(|value|*value>0.0) {
                clean.insert(key.into(),json!(value));
            }
        }
        if !clean.is_empty() { normalized["thresholdLimits"]=Value::Object(clean); }
    }
    if let Some(sources)=report.get("thresholdSources").filter(|value|is_object(value)) {
        let mut clean=serde_json::Map::new();
        for key in ["powerW","currentTempC"] {
            if let Some(source)=sources.get(key).and_then(Value::as_str).filter(|source|!source.is_empty()) {
                clean.insert(key.into(),json!(slice(source,80)?));
            }
        }
        if !clean.is_empty() { normalized["thresholdSources"]=Value::Object(clean); }
    }
    if let Some(fallback)=report.get("thresholdFallback").and_then(Value::as_bool) {
        normalized["thresholdFallback"]=json!(fallback);
    }
    if let Some(fallbacks)=report.get("thresholdFallbacks").and_then(Value::as_array) {
        let cleaned: Vec<Value>=fallbacks.iter().filter_map(Value::as_str)
            .filter(|metric|["powerW","currentTempC"].contains(metric))
            .map(|metric|json!(metric)).collect();
        normalized["thresholdFallbacks"]=json!(cleaned);
    }
    // Per-metric aggregates: what the card actually did during the run, so a
    // finished report can be reviewed offline instead of from a screenshot.
    if let Some(stats)=report.get("metricStats").and_then(Value::as_object) {
        let mut clean=serde_json::Map::new();
        for key in ["powerW","currentTempC","coreClockMhz","vramClockMhz","gpuUtilPct"] {
            let Some(row)=stats.get(key).and_then(Value::as_object) else { continue; };
            let count=finite(row.get("count")).unwrap_or(0.0);
            if count<1.0 { continue; }
            let (Some(min),Some(mean),Some(max))=(finite(row.get("min")),finite(row.get("mean")),finite(row.get("max"))) else { continue; };
            clean.insert(key.into(),json!({"count":js_round(count),"min":min,"mean":mean,"max":max}));
        }
        if !clean.is_empty() { normalized["metricStats"]=Value::Object(clean); }
    }
    // Engine and node peaks are reported exactly as measured: a peak is the
    // evidence that the card was loaded, so it is never clamped or smoothed.
    if let Some(peaks)=report.get("enginePeaks").and_then(Value::as_object) {
        let mut clean=serde_json::Map::new();
        for (name,value) in peaks {
            let Some(value)=finite(Some(value)) else { continue; };
            clean.insert(slice(name,24)?,json!(value));
            if clean.len()>=8 { break; }
        }
        if !clean.is_empty() { normalized["enginePeaks"]=Value::Object(clean); }
    }
    if let Some(peaks)=report.get("nodePeaks").and_then(Value::as_object) {
        let mut clean=serde_json::Map::new();
        for (node,value) in peaks {
            let Ok(node)=node.parse::<u32>() else { continue; };
            let Some(value)=finite(Some(value)) else { continue; };
            clean.insert(node.to_string(),json!(value));
            if clean.len()>=16 { break; }
        }
        if !clean.is_empty() { normalized["nodePeaks"]=Value::Object(clean); }
    }
    // Per-sample utilization diagnostics: one float per sample (null where the
    // reading was missing) and, per sample, the wall interval and per-node tick
    // deltas behind it. Bounded so a report stays a few KB.
    if let Some(series)=report.get("utilSeries").and_then(Value::as_array) {
        let cleaned:Vec<Value>=series.iter().take(600)
            .map(|value|finite(Some(value)).map_or(Value::Null,|value|json!(value))).collect();
        if !cleaned.is_empty() { normalized["utilSeries"]=json!(cleaned); }
    }
    if let Some(samples)=report.get("utilSamples").and_then(Value::as_array) {
        let mut cleaned=Vec::new();
        for sample in samples.iter().take(600) {
            let Some(object)=sample.as_object() else { continue; };
            let nodes:Option<Vec<Value>>=object.get("nodes").and_then(Value::as_array).map(|rows|rows.iter()
                .filter_map(|row|{
                    let row=row.as_array()?;
                    Some(json!([finite(row.first())?,finite(row.get(1))?,finite(row.get(2))?]))
                }).take(64).collect());
            cleaned.push(json!({
                "atMs":finite(object.get("atMs")),
                "wallMs":finite(object.get("wallMs")),
                "nodes":nodes,
            }));
        }
        if !cleaned.is_empty() { normalized["utilSamples"]=json!(cleaned); }
    }
    for key in ["workloadSubmits","workloadDraws","workloadCopies"] {
        if let Some(value)=finite(report.get(key)).filter(|value|*value>=0.0) {
            normalized[key]=json!(js_round(value));
        }
    }
    Ok(Some(normalized))
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Clock {ms:f64,iso:String}
    impl StabilityClock for Clock{fn now_ms(&self)->f64{self.ms}fn now_iso(&self)->&str{&self.iso}}
    fn semantic_numbers(value:Value)->Value {match value{Value::Number(n)=>json!(n.as_f64().unwrap()),Value::Array(a)=>Value::Array(a.into_iter().map(semantic_numbers).collect()),Value::Object(o)=>Value::Object(o.into_iter().map(|(k,v)|(k,semantic_numbers(v))).collect()),other=>other}}

    #[test]
    fn original_js_differential_normalization_classification_evidence_and_reports() {
        assert_eq!(STABILITY_CADENCE_DEFAULT_MS, 600);
        let fixture:Value=serde_json::from_str(include_str!("fixtures/stability-contract.json")).unwrap();
        let clock=Clock{ms:fixture["nowMs"].as_f64().unwrap(),iso:fixture["nowIso"].as_str().unwrap().into()};
        for (index,case) in fixture["cases"].as_array().unwrap().iter().enumerate(){
            let args=case["args"].as_array().unwrap();let op=case["op"].as_str().unwrap();let null=Value::Null;let first=args.first().unwrap_or(&null);
            let actual:Result<Value,String>=match op{
                "normalizeStableDeviceKey"=>Ok(json!(normalize_stable_device_key(first))),
                "clampCadenceMs"=>Ok(json!(clamp_cadence_ms(args.first()))),
                "clampDurationSec"=>Ok(json!(clamp_duration_sec(args.first()))),
                "normalizeStabilityRequest"=>normalize_stability_request(first),
                "normalizeTimestampMs"=>Ok(json!(normalize_timestamp_ms(args.first(),args.get(1),&clock))),
                "normalizeReceiptTimestampMs"=>Ok(json!(normalize_receipt_timestamp_ms(args.first(),args.get(1),&clock))),
                "normalizeStabilitySample"=>normalize_stability_sample(first,args.get(1),&clock),
                "workloadEvidenceOf"=>Ok(json!(workload_evidence_of(first))),
                "classifyStabilityRun"=>Ok(classify_stability_run(first)),
                "normalizeStabilityReport"=>normalize_stability_report(first,&clock).map(|v|v.unwrap_or(Value::Null)),
                _=>panic!("unknown oracle function"),
            };
            if case["rustRefusal"]==json!(true){assert!(actual.is_err(),"case {index} {op} must refuse split UTF16 surrogate");}
            else if let Some(error)=case.get("error"){assert_eq!(actual.unwrap_err(),error.as_str().unwrap(),"case {index} {op}");}
            else{assert_eq!(semantic_numbers(actual.unwrap()),semantic_numbers(case["result"].clone()),"case {index} {op}");}
        }
    }

    #[test]
    fn no_workload_can_never_pass_and_missing_metrics_warn_before_error_precedence() {
        assert_eq!(classify_stability_run(&json!({"sampleCount":10,"workloadActive":true,"utilEvidenceCount":0}))["outcome"],json!("no-workload"));
        assert_eq!(classify_stability_run(&json!({"sampleCount":10,"workloadActive":true,"utilEvidenceCount":1,"missingSampleCount":1}))["outcome"],json!("warning"));
        assert_eq!(classify_stability_run(&json!({"sampleCount":10,"workloadEvidence":true,"cancelled":true,"unavailable":true}))["outcome"],json!("cancelled"));
    }

    #[test]
    fn sample_metrics_are_strict_while_request_and_counters_coerce_numbers() {
        let clock=Clock{ms:1000.25,iso:"fixed".into()};
        let raw=json!({"sample":{"t":123,"utilPct":"80","tempC":"60","powerW":"100"},"fpsSample":{"fps":"60"}});let original=raw.clone();
        let normalized=normalize_stability_sample(&raw,None,&clock).unwrap();
        assert!(normalized["utilPct"].is_null());assert!(normalized["temperatureC"].is_null());assert!(normalized["powerW"].is_null());assert!(normalized["fps"].is_null());
        assert_eq!(normalized["sourceTimestampMs"],json!(123000.0));assert_eq!(raw,original);
        assert_eq!(clamp_cadence_ms(Some(&json!("400"))),Some(400));assert!(workload_evidence_of(&json!({"sampleCount":"10","foregroundCount":"1","presentEvidenceCount":"8"})));
    }
}
