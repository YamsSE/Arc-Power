//! Cross-process GPU apply serialization.
//! Electron and the native host share one Windows named mutex so a renderer
//! apply cannot interleave with a boot/tray/fan-resume apply in the broker.
//! The kernel abandons the mutex if its owner exits, so a crashed writer does
//! not lock the product out permanently.
use std::time::{Duration, Instant};

pub const APPLY_MUTEX_NAME: &str = r"Local\ArcPower-GPU-Apply-v1";

#[cfg(windows)]
pub struct ApplyLock {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl Drop for ApplyLock {
    fn drop(&mut self) {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::ReleaseMutex;
        unsafe {
            let _ = ReleaseMutex(self.handle);
            let _ = CloseHandle(self.handle);
        }
    }
}

#[cfg(windows)]
pub fn acquire() -> Result<ApplyLock, String> {
    acquire_named(APPLY_MUTEX_NAME, Duration::from_secs(10))
}

/// Bounded probe acquisition: a capabilities read must never wait for a
/// long apply just to run the reversible fan probe. The caller skips the
/// probe when the lock is busy and stays read-only.
#[cfg(windows)]
pub fn try_acquire(timeout: Duration) -> Result<ApplyLock, String> {
    acquire_named(APPLY_MUTEX_NAME, timeout)
}

#[cfg(windows)]
pub fn acquire_named(name: &str, timeout: Duration) -> Result<ApplyLock, String> {
    use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
    let mut wide: Vec<u16> = name.encode_utf16().collect();
    wide.push(0);
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
    if handle.is_null() { return Err("could not create the GPU apply mutex".into()); }
    let started = Instant::now();
    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        let millis = remaining.as_millis().min(u32::MAX as u128) as u32;
        let result = unsafe { WaitForSingleObject(handle, millis) };
        if result == WAIT_OBJECT_0 || result == WAIT_ABANDONED {
            return Ok(ApplyLock { handle });
        }
        if result != WAIT_TIMEOUT {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle); }
            return Err(format!("GPU apply mutex wait failed (0x{result:08x})"));
        }
        if started.elapsed() >= timeout {
            unsafe { windows_sys::Win32::Foundation::CloseHandle(handle); }
            return Err("GPU apply is busy; try again".into());
        }
    }
}

#[cfg(not(windows))]
pub struct ApplyLock;

#[cfg(not(windows))]
impl Drop for ApplyLock {
    fn drop(&mut self) {}
}

#[cfg(not(windows))]
pub fn acquire() -> Result<ApplyLock, String> { Ok(ApplyLock) }
#[cfg(not(windows))]
pub fn try_acquire(_timeout: Duration) -> Result<ApplyLock, String> { Ok(ApplyLock) }
#[cfg(not(windows))]
pub fn acquire_named(_name: &str, _timeout: Duration) -> Result<ApplyLock, String> { Ok(ApplyLock) }

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_name() -> String {
        format!(r"Local\ArcPower-Test-Apply-{:032x}", rand::random::<u128>())
    }

    #[test]
    #[ignore = "requires a concurrent Electron/Node lock holder"]
    #[cfg(windows)]
    fn live_waits_for_an_external_holder() {
        let started = Instant::now();
        let lock = acquire().unwrap();
        let elapsed = started.elapsed();
        eprintln!("waited for the shared apply lock: {elapsed:?}");
        drop(lock);
        assert!(elapsed >= Duration::from_millis(1_000), "the shared mutex was not observed as held");
    }

    #[test]
    #[cfg(windows)]
    fn acquire_and_release_roundtrip() {
        let name = unique_name();
        let first = acquire_named(&name, Duration::from_millis(500)).unwrap();
        drop(first);
        let second = acquire_named(&name, Duration::from_millis(500)).unwrap();
        drop(second);
    }

    #[test]
    #[cfg(windows)]
    fn contention_times_out_then_recovers_after_release() {
        use std::sync::mpsc;
        let name = unique_name();
        let held = acquire_named(&name, Duration::from_millis(500)).unwrap();
        let (tx, rx) = mpsc::channel();
        let worker_name = name.clone();
        let worker = std::thread::spawn(move || {
            tx.send(acquire_named(&worker_name, Duration::from_millis(50)).is_err()).unwrap();
        });
        assert!(rx.recv().unwrap(), "second owner must time out while held");
        worker.join().unwrap();
        drop(held);
        acquire_named(&name, Duration::from_millis(500)).unwrap();
    }

    #[test]
    #[cfg(windows)]
    fn abandoned_owner_is_recovered() {
        use std::sync::mpsc;
        let name = unique_name();
        let (tx, rx) = mpsc::channel();
        let worker_name = name.clone();
        let worker = std::thread::spawn(move || {
            let lock = acquire_named(&worker_name, Duration::from_millis(500)).unwrap();
            std::mem::forget(lock); // exit the owning thread without releasing
            tx.send(()).unwrap();
        });
        rx.recv().unwrap();
        worker.join().unwrap();
        // The thread exited while owning the mutex: the next wait is abandoned.
        let recovered = acquire_named(&name, Duration::from_millis(500)).unwrap();
        drop(recovered);
    }
}
