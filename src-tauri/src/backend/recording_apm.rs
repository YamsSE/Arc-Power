//! Session-local action-rate sampling for recording clips. Only counts and
//! timestamps are retained; key/button identity and values are never stored.
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const SAMPLE_MS: u64 = 1_000;
const WINDOW_MS: u64 = 60_000;
const MAX_SAMPLES: usize = 86_400;

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as i64).unwrap_or(0)
}

#[derive(Default)]
struct Session {
    started_at: i64,
    events: Vec<i64>,
    samples: Vec<Value>,
    pressed: HashSet<u32>,
    source_ready: bool,
}

pub struct ApmSampler {
    sessions: Arc<Mutex<HashMap<String, Session>>>,
    stop: Arc<AtomicBool>,
}

impl Drop for ApmSampler {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

impl ApmSampler {
    pub fn new() -> Self {
        let sessions = Arc::new(Mutex::new(HashMap::<String, Session>::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let thread_sessions = sessions.clone();
        let thread_stop = stop.clone();
        let _ = thread::Builder::new().name("arc-recording-apm".into()).spawn(move || {
            while !thread_stop.load(Ordering::Acquire) {
                let has_sessions = thread_sessions.lock().map(|sessions| !sessions.is_empty()).unwrap_or(false);
                if has_sessions {
                    poll(&thread_sessions);
                    thread::sleep(Duration::from_millis(20));
                } else {
                    thread::sleep(Duration::from_millis(100));
                }
            }
        });
        Self { sessions, stop }
    }

    pub fn start(&self, session_id: &str, started_at: i64) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(session_id.to_owned(), Session {
                started_at,
                source_ready: reader_available(),
                ..Session::default()
            });
        }
    }

    pub fn stop(&self, session_id: &str) -> Option<Value> {
        let mut sessions = self.sessions.lock().ok()?;
        let mut session = sessions.remove(session_id)?;
        sample(&mut session, now_ms());
        let samples: Vec<Value> = session.samples.clone();
        let values: Vec<f64> = samples.iter().filter_map(|sample| sample["apm"].as_f64()).collect();
        Some(json!({
            "sessionId": session_id,
            "samples": samples,
            "averageApm": if values.is_empty() { Value::Null } else { json!((values.iter().sum::<f64>() / values.len() as f64).round()) },
            "peakApm": if values.is_empty() { Value::Null } else { json!(values.iter().cloned().fold(0.0, f64::max)) },
            "sourceReady": session.source_ready,
        }))
    }

    pub fn interval(&self, session_id: &str, start_ms: i64, end_ms: i64) -> Value {
        let mut sessions = match self.sessions.lock() { Ok(sessions) => sessions, Err(_) => return Value::Null };
        let Some(session) = sessions.get_mut(session_id) else { return Value::Null };
        sample(session, now_ms());
        let start = start_ms.max(0);
        let end = end_ms.max(start);
        let samples: Vec<Value> = session.samples.iter().filter(|sample| {
            sample["atMs"].as_i64().is_some_and(|at| at >= start && at <= end)
        }).map(|sample| json!({
            "atMs": sample["atMs"].as_i64().unwrap_or(0).saturating_sub(start),
            "apm": sample["apm"].clone(),
        })).collect();
        if samples.is_empty() {
            return json!({"sessionId":session_id,"samples":[],"averageApm":Value::Null,"peakApm":Value::Null,"available":session.source_ready});
        }
        let values: Vec<f64> = samples.iter().filter_map(|sample| sample["apm"].as_f64()).collect();
        json!({
            "sessionId": session_id,
            "samples": samples,
            "averageApm": (values.iter().sum::<f64>() / values.len() as f64).round(),
            "peakApm": values.iter().cloned().fold(0.0, f64::max),
            "available": session.source_ready,
        })
    }
}

fn reader_available() -> bool {
    #[cfg(windows)]
    unsafe {
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
        let _ = GetAsyncKeyState(0x10);
        true
    }
    #[cfg(not(windows))]
    false
}

fn sample(session: &mut Session, now: i64) {
    if !session.source_ready { return; }
    let elapsed = (now - session.started_at).max(0);
    let cutoff = (elapsed - WINDOW_MS as i64).max(0);
    while session.events.len() > 120_000 || session.events.first().is_some_and(|at| *at < cutoff) {
        if session.events.is_empty() { break; }
        session.events.remove(0);
    }
    let last_at = session.samples.last().and_then(|sample| sample["atMs"].as_i64());
    if last_at.is_none_or(|at| elapsed - at >= SAMPLE_MS as i64) {
        let first = session.events.iter().rev().take_while(|at| **at >= cutoff).last().copied().unwrap_or(elapsed);
        let count = session.events.iter().rev().take_while(|at| **at >= cutoff).count() as i64;
        let span = (elapsed - first).clamp(1_000, WINDOW_MS as i64).max(1);
        let apm = ((count * 60_000) / span).clamp(0, 6_000);
        session.samples.push(json!({"atMs":elapsed,"apm":apm}));
        if session.samples.len() > MAX_SAMPLES {
            let excess = session.samples.len() - MAX_SAMPLES;
            session.samples.drain(0..excess);
        }
    }
}

#[cfg(windows)]
fn poll(sessions: &Arc<Mutex<HashMap<String, Session>>>) {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    let now = now_ms();
    let Ok(mut sessions) = sessions.lock() else { return };
    for session in sessions.values_mut() {
        let elapsed = (now - session.started_at).max(0);
        let mut codes: Vec<u32> = vec![1, 2, 4, 5, 6];
        codes.extend(8..=255);
        for code in codes {
            let state = unsafe { GetAsyncKeyState(code as i32) } as u16;
            let pressed = state & 0x8000 != 0;
            let transitioned = state & 0x0001 != 0;
            if (pressed && !session.pressed.contains(&code)) || (transitioned && !session.pressed.contains(&code)) {
                session.events.push(elapsed);
            }
            if pressed { session.pressed.insert(code); } else { session.pressed.remove(&code); }
        }
        session.source_ready = true;
        sample(session, now);
    }
}

#[cfg(not(windows))]
fn poll(_sessions: &Arc<Mutex<HashMap<String, Session>>>) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_samples_are_relative_and_clamped() {
        let sampler = ApmSampler::new();
        sampler.start("video:1", now_ms());
        let value = sampler.interval("video:1", 0, 10_000);
        assert!(value.is_object());
        for sample in value["samples"].as_array().unwrap() {
            assert!(sample["atMs"].as_i64().unwrap() >= 0);
            assert!(sample["apm"].as_i64().unwrap() >= 0);
        }
        sampler.stop("video:1");
    }
}
