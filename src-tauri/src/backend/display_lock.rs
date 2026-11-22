//! Cross-process serialization for Display reads and applies.
//!
//! Electron takes this mutex around the complete `display:get` read (including
//! scaling invalidation persistence) and the complete `display:apply` driver
//! and selection-store transaction. A native owner must hold it from staging
//! through output revalidation and any conditional store reconciliation.
//! Windows releases ownership on process exit; `WAIT_ABANDONED` is accepted
//! because the next owner re-reads both driver and durable state before acting.

use std::time::Duration;
use std::{marker::PhantomData, rc::Rc};

pub const DISPLAY_MUTEX_NAME: &str = r"Local\ArcPower-Display-v1";

/// The unforgeable proof that a caller owns the shared Display transaction.
/// Keep it alive until the read/apply and any scaling-store update are done.
pub struct DisplayLockGuard {
    inner: super::apply_lock::ApplyLock,
    // ReleaseMutex must run on the same OS thread that acquired the mutex.
    // Native service calls are synchronous; make moving this proof to another
    // thread a compile-time error rather than relying on that convention.
    _thread_bound: PhantomData<Rc<()>>,
}

pub fn acquire() -> Result<DisplayLockGuard, String> {
    super::apply_lock::acquire_named(DISPLAY_MUTEX_NAME, Duration::from_secs(10))
        .map(|inner| DisplayLockGuard { inner, _thread_bound: PhantomData })
        .map_err(|_| "Display is busy or its cross-process lock is unavailable.".into())
}

impl DisplayLockGuard {
    /// Make it explicit at call sites that the lock proof remains live across
    /// staging, revalidation and persistence. The inner guard is intentionally
    /// private so a caller cannot construct an ownership token without waiting.
    pub fn is_held(&self) -> bool { let _ = &self.inner; true }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_name_is_the_electron_display_mutex_name() {
        assert_eq!(DISPLAY_MUTEX_NAME, r"Local\ArcPower-Display-v1");
    }

    #[test]
    fn acquisition_returns_a_live_guard() {
        let guard = acquire().expect("the local Display mutex should be available");
        assert!(guard.is_held());
    }
}
