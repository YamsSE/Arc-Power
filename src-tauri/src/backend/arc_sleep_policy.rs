//! Deterministic Arc Sleep policy. All time and telemetry are supplied by callers.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase")]
pub struct ArcSleepSettings {
    pub idle_enabled:bool, pub adaptive_enabled:bool, pub idle_after_seconds:u32,
    pub idle_fps:u32, pub adaptive_min_fps:u32, pub adaptive_max_fps:u32,
    pub adaptive_target_load_pct:u32,
}

pub const ARC_SLEEP_DEFAULTS:ArcSleepSettings=ArcSleepSettings {
    idle_enabled:false,adaptive_enabled:false,idle_after_seconds:300,idle_fps:30,
    adaptive_min_fps:60,adaptive_max_fps:144,adaptive_target_load_pct:85,
};

pub(crate) fn js_trim(text:&str)->&str {
    text.trim_matches(|c:char|matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}

fn array_string(value:&Value)->String {
    match value {
        Value::Null=>String::new(), Value::Array(items)=>items.iter().map(array_string).collect::<Vec<_>>().join(","),
        Value::String(s)=>s.clone(), Value::Object(_)=>"[object Object]".into(), _=>value.to_string(),
    }
}

pub(crate) fn js_number(value:Option<&Value>)->f64 {
    let Some(value)=value else {return f64::NAN;};
    match value {
        Value::Null=>0.0, Value::Bool(b)=>if *b {1.0}else{0.0},
        Value::Number(n)=>n.as_f64().unwrap_or(f64::NAN), Value::Object(_)=>f64::NAN,
        Value::Array(_)=>js_number(Some(&Value::String(array_string(value)))),
        Value::String(s)=>{
            let text=js_trim(s);
            if text.is_empty() {return 0.0;}
            for (prefix,base) in [("0x",16),("0X",16),("0b",2),("0B",2),("0o",8),("0O",8)] {
                if let Some(digits)=text.strip_prefix(prefix) {
                    if digits.is_empty() {return f64::NAN;}
                    let mut number=0.0;
                    for digit in digits.chars() {
                        let Some(digit)=digit.to_digit(base) else {return f64::NAN;};
                        number=number*base as f64+digit as f64;
                    }
                    return number;
                }
            }
            // Rust accepts abbreviated and case-insensitive infinity spellings;
            // Number() only accepts the exact case-sensitive Infinity token.
            let unsigned = text.strip_prefix('+').or_else(|| text.strip_prefix('-')).unwrap_or(text);
            if (unsigned.eq_ignore_ascii_case("inf") || unsigned.eq_ignore_ascii_case("infinity"))
                && unsigned != "Infinity" { return f64::NAN; }
            text.parse::<f64>().unwrap_or(f64::NAN)
        }
    }
}

fn bounded(value:Option<&Value>,minimum:u32,maximum:u32,fallback:u32)->u32 {
    let number=js_number(value);
    if !number.is_finite() {return fallback;}
    number.round().max(minimum as f64).min(maximum as f64) as u32
}

pub fn normalize_arc_sleep_settings(input:&Value)->ArcSleepSettings {
    let mut out=ArcSleepSettings {
        idle_enabled:input.get("idleEnabled")==Some(&Value::Bool(true)),
        adaptive_enabled:input.get("adaptiveEnabled")==Some(&Value::Bool(true)),
        idle_after_seconds:bounded(input.get("idleAfterSeconds"),60,3600,300),
        idle_fps:bounded(input.get("idleFps"),15,120,30),
        adaptive_min_fps:bounded(input.get("adaptiveMinFps"),30,240,60),
        adaptive_max_fps:bounded(input.get("adaptiveMaxFps"),31,500,144),
        adaptive_target_load_pct:bounded(input.get("adaptiveTargetLoadPct"),50,99,85),
    };
    if out.adaptive_min_fps>=out.adaptive_max_fps {out.adaptive_min_fps=60;out.adaptive_max_fps=144;}
    out
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase")]
pub struct ArcSleepPolicyState {
    pub adaptive_cap_fps:u32, pub above_target_samples:f64, pub moderate_load_samples:f64,
    pub below_target_samples:f64, pub fine_recovery_samples:f64,
    pub load_unavailable_since_ms:Option<f64>, pub observed_fps_samples:Vec<f64>,
    pub observed_process_id:Option<u64>,pub observed_fps_seeded:bool,
    pub seeded_process_id:Option<u64>,pub observed_fps_seen_in_window:bool,
}

pub fn create_arc_sleep_policy_state(settings:&Value)->ArcSleepPolicyState {
    ArcSleepPolicyState {
        adaptive_cap_fps:normalize_arc_sleep_settings(settings).adaptive_max_fps,
        above_target_samples:0.0,moderate_load_samples:0.0,below_target_samples:0.0,fine_recovery_samples:0.0,
        load_unavailable_since_ms:None,observed_fps_samples:Vec::new(),observed_process_id:None,
        observed_fps_seeded:false,seeded_process_id:None,observed_fps_seen_in_window:false,
    }
}

fn number(value:Option<&Value>)->Option<f64> {value.and_then(Value::as_f64).filter(|v|v.is_finite())}
fn clock(value:Option<&Value>)->Option<f64> {number(value).filter(|v|*v>=0.0)}
fn fps(value:Option<&Value>)->Option<f64> {number(value).filter(|v|*v>0.0&&*v<=1000.0)}
fn pid(value:Option<&Value>)->Option<u64> {number(value).filter(|v|*v>0.0&&*v<=9_007_199_254_740_991.0&&v.fract()==0.0).map(|v|v as u64)}
fn counter(value:Option<&Value>)->f64 {number(value).filter(|v|*v>=0.0&&v.fract()==0.0).unwrap_or(0.0)}

impl ArcSleepPolicyState {
    fn clear_observations(&mut self) {
        self.observed_fps_samples.clear();self.observed_process_id=None;
        self.observed_fps_seeded=false;self.seeded_process_id=None;self.observed_fps_seen_in_window=false;
    }
    fn clear_counters(&mut self) {
        self.above_target_samples=0.0;self.below_target_samples=0.0;
        self.moderate_load_samples=0.0;self.fine_recovery_samples=0.0;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all="camelCase")]
pub struct ArcSleepStep {
    pub state:ArcSleepPolicyState,pub target_fps:Option<u32>,pub source:Option<String>,
    pub idle_active:bool,pub adaptive_target_fps:Option<u32>,pub observed_fps_adjustment_applied:bool,
}

pub fn step_arc_sleep_policy(state:&Value,settings:&Value,sample:&Value)->ArcSleepStep {
    let config=normalize_arc_sleep_settings(settings);
    let fallback=serde_json::to_value(create_arc_sleep_policy_state(settings)).expect("finite policy defaults");
    let current=if state.is_object()||state.is_array(){state}else{&fallback};
    let now=clock(sample.get("nowMs"));let idle=clock(sample.get("idleMs"));
    let load=number(sample.get("loadPercent")).filter(|v|*v>=0.0&&*v<=100.0);
    let idle_active=config.idle_enabled&&idle.is_some_and(|v|v>=config.idle_after_seconds as f64*1000.0);
    let observed:Vec<f64>=current.get("observedFpsSamples").and_then(Value::as_array)
        .into_iter().flatten().filter_map(|v|fps(Some(v))).collect();
    let mut next=ArcSleepPolicyState {
        adaptive_cap_fps:bounded(current.get("adaptiveCapFps"),31,500,config.adaptive_max_fps).max(config.adaptive_min_fps).min(config.adaptive_max_fps),
        above_target_samples:counter(current.get("aboveTargetSamples")),
        below_target_samples:counter(current.get("belowTargetSamples")),
        moderate_load_samples:counter(current.get("moderateLoadSamples")),
        fine_recovery_samples:counter(current.get("fineRecoverySamples")),
        load_unavailable_since_ms:clock(current.get("loadUnavailableSinceMs")),
        observed_fps_samples:observed[observed.len().saturating_sub(2)..].to_vec(),
        observed_process_id:pid(current.get("observedProcessId")),
        observed_fps_seeded:current.get("observedFpsSeeded")==Some(&Value::Bool(true)),
        seeded_process_id:pid(current.get("seededProcessId")),
        observed_fps_seen_in_window:current.get("observedFpsSeenInWindow")==Some(&Value::Bool(true)),
    };
    let mut adjusted=false;
    let target=config.adaptive_target_load_pct as f64;
    let high_step=(((config.adaptive_max_fps-config.adaptive_min_fps) as f64*0.1).round() as u32).clamp(5,30);
    if let Some(load)=load {
        next.load_unavailable_since_ms=None;
        if !idle_active&&load>(target+2.0).min(99.0)&&load<(target+8.0).min(100.0) {
            next.moderate_load_samples+=1.0;next.above_target_samples=0.0;
            next.below_target_samples=0.0;next.fine_recovery_samples=0.0;next.clear_observations();
            if next.moderate_load_samples>=4.0 {
                next.adaptive_cap_fps=next.adaptive_cap_fps.saturating_sub(2).max(config.adaptive_min_fps);
                next.moderate_load_samples=0.0;
            }
        } else if (idle_active&&load>target)||load>=(target+8.0).min(100.0) {
            next.moderate_load_samples=0.0;next.fine_recovery_samples=0.0;
            next.above_target_samples+=1.0;next.below_target_samples=0.0;
            let process=pid(sample.get("observedProcessId"));let observed=fps(sample.get("observedFps"));
            if idle_active||process.is_none()||observed.is_none() {
                // JS deliberately leaves observedFpsSeenInWindow untouched here.
                next.observed_fps_samples.clear();next.observed_process_id=None;
                next.observed_fps_seeded=false;next.seeded_process_id=None;
            } else {
                let observed=observed.unwrap();next.observed_fps_seen_in_window=true;
                if process!=next.observed_process_id {next.observed_fps_samples.clear();}
                let lower_scene=next.observed_fps_samples.iter().copied().reduce(f64::min).is_some_and(|minimum|observed<=minimum-10.0);
                if lower_scene {next.observed_fps_samples.clear();next.above_target_samples=1.0;}
                next.observed_fps_samples.push(observed);next.observed_process_id=process;
                if !next.observed_fps_seeded||process!=next.seeded_process_id {
                    next.observed_fps_seeded=true;next.seeded_process_id=process;
                    if observed<=next.adaptive_cap_fps as f64-10.0 {
                        let seeded=(observed.round() as u32).max(config.adaptive_min_fps).min(config.adaptive_max_fps);
                        if seeded<next.adaptive_cap_fps {
                            next.adaptive_cap_fps=seeded;adjusted=true;next.above_target_samples=0.0;
                            next.observed_fps_samples.clear();next.observed_process_id=None;
                        }
                    }
                }
            }
            if !adjusted&&next.above_target_samples>=3.0 {
                if next.observed_fps_samples.len()>=3&&next.observed_process_id.is_some() {
                    let mut sorted=next.observed_fps_samples.clone();sorted.sort_by(f64::total_cmp);
                    let median=sorted[1];
                    if sorted[2]-sorted[0]<=5.0_f64.max(median*0.15)&&median<=next.adaptive_cap_fps as f64-10.0 {
                        let previous=next.adaptive_cap_fps;
                        next.adaptive_cap_fps=(median.round() as u32).min(previous).max(config.adaptive_min_fps);
                        adjusted=next.adaptive_cap_fps<previous;
                    }
                }
                if !adjusted {
                    let step=if next.observed_fps_seen_in_window {5}else{high_step};
                    next.adaptive_cap_fps=next.adaptive_cap_fps.saturating_sub(step).max(config.adaptive_min_fps);
                }
                next.above_target_samples=0.0;next.observed_fps_samples.clear();
                next.observed_process_id=None;next.observed_fps_seen_in_window=false;
            }
        } else if !idle_active&&load>target-8.0&&load<target-2.0 {
            next.moderate_load_samples=0.0;next.above_target_samples=0.0;next.below_target_samples=0.0;
            next.fine_recovery_samples+=1.0;next.clear_observations();
            if next.fine_recovery_samples>=4.0 {
                next.adaptive_cap_fps=(next.adaptive_cap_fps+2).min(config.adaptive_max_fps);next.fine_recovery_samples=0.0;
            }
        } else if load<=target-8.0||(idle_active&&load<target-5.0) {
            next.moderate_load_samples=0.0;next.fine_recovery_samples=0.0;next.above_target_samples=0.0;
            next.below_target_samples+=1.0;next.clear_observations();
            if next.below_target_samples>=if load<=target-15.0 {1.0}else{5.0} {
                next.adaptive_cap_fps=(next.adaptive_cap_fps+3).min(config.adaptive_max_fps);next.below_target_samples=0.0;
            }
        } else {next.clear_counters();next.clear_observations();}
    } else {
        next.clear_counters();next.clear_observations();
        if next.load_unavailable_since_ms.is_none() {next.load_unavailable_since_ms=now;}
        if let (Some(now),Some(since))=(now,next.load_unavailable_since_ms) {
            if now<since {next.load_unavailable_since_ms=Some(now);}
        }
    }
    let adaptive=if config.adaptive_enabled&&(load.is_some()||matches!((now,next.load_unavailable_since_ms),(Some(now),Some(since)) if now-since<5000.0)) {
        Some(next.adaptive_cap_fps)
    } else {None};
    ArcSleepStep {
        target_fps:if idle_active {Some(config.idle_fps)}else{adaptive},
        source:if idle_active {Some("idle".into())}else{adaptive.map(|_|"adaptive".into())},
        state:next,idle_active,adaptive_target_fps:adaptive,observed_fps_adjustment_applied:adjusted,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn value<T:Serialize>(input:T)->Value {serde_json::to_value(input).unwrap()}

    #[test]
    fn normalization_has_js_coercion_and_range_reset() {
        assert_eq!(normalize_arc_sleep_settings(&json!({})),ARC_SLEEP_DEFAULTS);
        let out=normalize_arc_sleep_settings(&json!({"idleEnabled":1,"adaptiveEnabled":true,"idleAfterSeconds":"0x100","idleFps":[24],"adaptiveMinFps":300,"adaptiveMaxFps":100,"adaptiveTargetLoadPct":null}));
        assert!(!out.idle_enabled);assert!(out.adaptive_enabled);assert_eq!(out.idle_after_seconds,256);
        assert_eq!(out.idle_fps,24);assert_eq!((out.adaptive_min_fps,out.adaptive_max_fps),(60,144));assert_eq!(out.adaptive_target_load_pct,50);
    }

    #[test]
    fn idle_override_preserves_tracking_and_resumes_after_activity() {
        let settings=json!({"idleEnabled":true,"idleAfterSeconds":60,"idleFps":20,"adaptiveEnabled":true,"adaptiveMinFps":30,"adaptiveMaxFps":100});
        let mut state=value(create_arc_sleep_policy_state(&settings));
        for _ in 0..2 {state=value(step_arc_sleep_policy(&state,&settings,&json!({"idleMs":0,"loadPercent":99})).state);}
        let idle=step_arc_sleep_policy(&state,&settings,&json!({"idleMs":60000,"loadPercent":99}));
        assert_eq!(idle.target_fps,Some(20));assert_eq!(idle.adaptive_target_fps,Some(93));
        assert_eq!(step_arc_sleep_policy(&value(idle.state),&settings,&json!({"idleMs":0,"loadPercent":99})).target_fps,Some(93));
    }

    #[test]
    fn unavailable_telemetry_expires_at_five_seconds_and_clock_rewind_restarts_grace() {
        let settings=json!({"adaptiveEnabled":true});let state=value(create_arc_sleep_policy_state(&settings));
        let first=step_arc_sleep_policy(&state,&settings,&json!({"nowMs":1000}));
        assert_eq!(first.target_fps,Some(144));
        assert_eq!(step_arc_sleep_policy(&value(&first.state),&settings,&json!({"nowMs":5999})).target_fps,Some(144));
        assert_eq!(step_arc_sleep_policy(&value(&first.state),&settings,&json!({"nowMs":6000})).target_fps,None);
        let rewound=step_arc_sleep_policy(&value(first.state),&settings,&json!({"nowMs":2}));
        assert_eq!(rewound.state.load_unavailable_since_ms,Some(2.0));
        assert_eq!(step_arc_sleep_policy(&value(rewound.state),&settings,&json!({"loadPercent":50})).target_fps,Some(144));
    }

    #[test]
    fn foreground_fps_seed_then_lower_scene_median_repositions_cap() {
        let settings=json!({"adaptiveEnabled":true,"adaptiveMinFps":30,"adaptiveMaxFps":144});
        let mut state=value(create_arc_sleep_policy_state(&settings));
        for fps in [119,120,121] {state=value(step_arc_sleep_policy(&state,&settings,&json!({"loadPercent":96,"observedFps":fps,"observedProcessId":42})).state);}
        assert_eq!(state["adaptiveCapFps"],json!(119));
        let mut last=None;
        for fps in [74,75,76] {let step=step_arc_sleep_policy(&state,&settings,&json!({"loadPercent":96,"observedFps":fps,"observedProcessId":42}));state=value(&step.state);last=Some(step);}
        let last=last.unwrap();assert_eq!(last.state.adaptive_cap_fps,75);assert!(last.observed_fps_adjustment_applied);
    }

    fn semantic_numbers(value:Value)->Value {
        match value {Value::Number(n)=>json!(n.as_f64().unwrap()),Value::Array(a)=>Value::Array(a.into_iter().map(semantic_numbers).collect()),Value::Object(o)=>Value::Object(o.into_iter().map(|(k,v)|(k,semantic_numbers(v))).collect()),other=>other}
    }

    #[test]
    fn differential_original_js_matches_thresholds_invalid_samples_and_long_sequences() {
        use std::{io::Write,process::{Command,Stdio}};
        let cwd=std::env::current_dir().unwrap();
        let repo=if cwd.join("src/main/arc-sleep-policy.js").exists(){cwd}else{cwd.parent().unwrap().to_path_buf()};
        let module=repo.join("src/main/arc-sleep-policy.js");assert!(module.exists());
        let mut cases=Vec::new();
        for target in [50,70,85,95,99] {
            let settings=json!({"idleEnabled":true,"idleAfterSeconds":60,"idleFps":20,"adaptiveEnabled":true,"adaptiveMinFps":30,"adaptiveMaxFps":240,"adaptiveTargetLoadPct":target});
            let mut samples=Vec::new();
            let mut seed=12345u64;
            for i in 0..600 {
                seed=seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                let load=match i%13 {0=>Value::Null,1=>json!("99"),2=>json!(-1),3=>json!(target as f64+2.0),4=>json!((target as f64+8.0).min(100.0)),5=>json!(target as f64-8.0),6=>json!(target as f64-2.0),7=>json!(target as f64-15.0),_=>json!((seed%10001) as f64/100.0)};
                samples.push(json!({"nowMs":if i%29==0 {0}else{i*800},"idleMs":if i%7==0 {60000}else{0},"loadPercent":load,"observedFps":if i%11==0 {Value::Null}else{json!(20+seed%180)},"observedProcessId":if i%17==0 {json!("42")}else{json!(1+seed%3)}}));
            }
            // Sustained severe, moderate, near-target, and low bands exercise
            // all debounced branches instead of only random resets.
            for load in [100.0,target as f64+3.0,target as f64-4.0,target as f64-10.0,20.0] {
                for i in 0..20 {samples.push(json!({"loadPercent":load,"nowMs":500000+i*500,"observedFps":80+i%3,"observedProcessId":42}));}
            }
            cases.push(json!({"settings":settings,"state":{"adaptiveCapFps":"200","aboveTargetSamples":-1,"observedFpsSamples":[null,0,120,121,122],"observedProcessId":42},"samples":samples}));
        }
        let script=r#"import fs from 'node:fs';import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.argv[1]).href);const cases=JSON.parse(fs.readFileSync(0,'utf8'));const out=cases.map(c=>{let s=c.state;return c.samples.map(sample=>{const r=m.stepArcSleepPolicy(s,c.settings,sample);s=r.state;return r;});});process.stdout.write(JSON.stringify(out));"#;
        let mut child=Command::new("node").args(["--input-type=module","-e",script]).arg(module).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().expect("Node is required for original-JS differential verification");
        child.stdin.take().unwrap().write_all(&serde_json::to_vec(&cases).unwrap()).unwrap();
        let output=child.wait_with_output().unwrap();assert!(output.status.success(),"{}",String::from_utf8_lossy(&output.stderr));
        let expected:Value=serde_json::from_slice(&output.stdout).unwrap();
        for (case_index,case) in cases.iter().enumerate() {
            let mut state=case["state"].clone();
            for (sample_index,sample) in case["samples"].as_array().unwrap().iter().enumerate() {
                let step=step_arc_sleep_policy(&state,&case["settings"],sample);state=value(&step.state);
                assert_eq!(semantic_numbers(value(step)),semantic_numbers(expected[case_index][sample_index].clone()),"case {case_index} sample {sample_index}");
            }
        }
    }
}
