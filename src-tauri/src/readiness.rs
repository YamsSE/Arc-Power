use std::{collections::HashSet, sync::{Condvar, Mutex}, time::{Duration, Instant}};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Phase { Splash, Initializing, Services }

impl Phase {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value {
            Some("splash") => Ok(Self::Splash), Some("initializing") => Ok(Self::Initializing),
            Some("services") | None => Ok(Self::Services), _ => Err("Invalid broker readiness phase".into()),
        }
    }
}

struct Manifest { phase: Phase, channels: HashSet<String> }

pub struct Readiness {
    state: Mutex<Result<Manifest, String>>,
    changed: Condvar,
}

impl Readiness {
    pub fn new() -> Self {
        Self { state: Mutex::new(Ok(Manifest { phase: Phase::Initializing, channels: HashSet::new() })), changed: Condvar::new() }
    }

    pub fn publish(&self, phase: Phase, channels: HashSet<String>) {
        let mut state = self.state.lock().unwrap();
        // Transport failure is terminal even if an already-read manifest races
        // the writer failure notification.
        if state.is_ok() { *state = Ok(Manifest { phase, channels }); }
        self.changed.notify_all();
    }

    pub fn fail(&self, message: &str) {
        *self.state.lock().unwrap() = Err(message.to_owned());
        self.changed.notify_all();
    }

    pub fn wait_channel(&self, channel: &str, timeout: Duration) -> Result<(), String> {
        let mut deadline = Some(Instant::now() + timeout);
        let mut state = self.state.lock().unwrap();
        loop {
            let manifest = state.as_ref().map_err(Clone::clone)?;
            if manifest.channels.contains(channel) { return Ok(()); }
            if manifest.phase == Phase::Splash {
                // A displayed update choice belongs to the user. It is not a
                // slow backend initialization and must not expire the main UI.
                deadline = None;
                state = self.changed.wait(state).unwrap();
                continue;
            }
            let remaining = deadline.get_or_insert_with(|| Instant::now() + timeout).saturating_duration_since(Instant::now());
            if remaining.is_zero() { return Err("Compatibility broker startup timed out".into()); }
            state = self.changed.wait_timeout(state, remaining).unwrap().0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, mpsc};

    #[test]
    fn splash_choice_outlives_timeout_then_initialization_gets_its_own_deadline() {
        let readiness = Arc::new(Readiness::new());
        readiness.publish(Phase::Splash, HashSet::from(["splash:update-choice".into()]));
        assert!(readiness.wait_channel("splash:update-choice", Duration::from_millis(20)).is_ok());
        let waiting = readiness.clone();
        let (sender, receiver) = mpsc::sync_channel(1);
        let thread = std::thread::spawn(move || { sender.send(waiting.wait_channel("list-devices", Duration::from_millis(40))).unwrap(); });
        assert!(matches!(receiver.recv_timeout(Duration::from_millis(120)), Err(mpsc::RecvTimeoutError::Timeout)));
        let initializing = Instant::now();
        readiness.publish(Phase::Initializing, HashSet::new());
        assert!(receiver.recv_timeout(Duration::from_secs(1)).unwrap().unwrap_err().contains("timed out"));
        assert!(initializing.elapsed() >= Duration::from_millis(30));
        thread.join().unwrap();
    }

    #[test]
    fn services_or_terminal_failure_wake_waiting_main() {
        let readiness = Arc::new(Readiness::new());
        readiness.publish(Phase::Splash, HashSet::new());
        let waiting = readiness.clone();
        let thread = std::thread::spawn(move || waiting.wait_channel("list-devices", Duration::from_millis(40)));
        readiness.publish(Phase::Services, HashSet::from(["list-devices".into()]));
        assert!(thread.join().unwrap().is_ok());
        readiness.fail("disconnected");
        readiness.publish(Phase::Services, HashSet::from(["list-devices".into()]));
        assert_eq!(readiness.wait_channel("list-devices", Duration::from_millis(40)), Err("disconnected".into()));
        assert!(Phase::parse(Some("unknown")).is_err());
    }
}
