//! Process-local FIFO for complete GPU apply transactions.
//!
//! This is distinct from `apply_lock`: the FIFO covers preflight through
//! refusal-cache publication, while the named Windows mutex only serializes
//! the actual setter against other Arc Power processes. The session refusal
//! cache should be owned beside this coordinator and updated before `finish`.
//!
//! A pipe client must call `begin`, wait for its response, then call
//! `activate` and wait for that response before invoking its body. If either
//! response is lost, it must not run the body and should call `cancel`.
//! `cancel` is consequently a pre-body protocol operation; callers must never
//! use it after starting the body. Once the body runs, release with `finish`
//! or fail closed with `close_unknown`.
//!
//! Request IDs must be fresh per client operation and must not be reused.
//! Unknown cancellations are retained for ten minutes (longer than the
//! coordinator's one-minute maximum wait); live tombstones are never evicted.
//! If their bounded table fills, the coordinator closes rather than risk
//! admitting a delayed begin for a cancelled request.

use rand::RngCore;
use serde_json::{json, Value};
use std::cell::Cell;
use std::collections::{HashMap, HashSet, VecDeque};
use std::marker::PhantomData;
use std::rc::Rc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
pub const MAX_TIMEOUT_MS: u64 = 60_000;
pub const MAX_QUEUED_WAITERS: usize = 256;
pub const BUSY_MESSAGE: &str = "GPU apply is busy; try again.";

const UNAVAILABLE_MESSAGE: &str = "GPU apply coordinator is unavailable; restart Arc Power.";
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;
const COMPLETED_TOKEN_LIMIT: usize = 256;
const CANCEL_TOMBSTONE_LIMIT: usize = 512;
const CANCEL_TOMBSTONE_TTL: Duration = Duration::from_secs(10 * 60);

thread_local! {
    // Internal Rust transactions are synchronous and must not recursively
    // acquire the same FIFO from their operation body.
    static INTERNAL_TRANSACTION_HELD: Cell<bool> = Cell::new(false);
}

/// One FIFO reservation returned by `begin`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyReservation {
    pub token: String,
    pub sequence: u64,
}

/// Queue position reserved synchronously by the pipe reader. A worker may
/// consume this handle to wait for its turn without changing FIFO order.
pub struct PreparedApplyBegin {
    request_id: String,
    token: String,
    label: String,
    ticket: u64,
    enqueued_at: Instant,
    deadline: Instant,
    had_to_queue: bool,
}

impl PreparedApplyBegin {
    pub fn request_id(&self) -> &str { &self.request_id }
}

/// Read-only process-lifetime state for host integration and diagnostics.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApplyTransactionStatus {
    pub closed: bool,
    pub poisoned: bool,
    pub poison_reason: Option<String>,
}

/// One coordinator should be shared by all native and broker-mediated Tauri
/// apply roots for the lifetime of the host process.
pub struct ApplyTransactionCoordinator {
    state: Mutex<State>,
    changed: Condvar,
}

struct State {
    next_ticket: u64,
    next_sequence: u64,
    queue: VecDeque<Waiter>,
    active: Option<ActiveLease>,
    completed: HashSet<(String, String)>,
    completed_order: VecDeque<(String, String)>,
    cancel_tombstones: HashMap<String, Instant>,
    cancel_tombstone_order: VecDeque<(String, Instant)>,
    closed: bool,
    poisoned: bool,
    poison_reason: Option<String>,
}

struct Waiter {
    request_id: String,
    token: String,
    label: String,
    ticket: u64,
    enqueued_at: Instant,
    internal: bool,
}

struct ActiveLease {
    request_id: String,
    token: String,
    label: String,
    sequence: u64,
    started_at: Instant,
    phase: LeasePhase,
    internal: bool,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LeasePhase {
    Reserved,
    Activated,
}

impl Default for ApplyTransactionCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl ApplyTransactionCoordinator {
    pub fn new() -> Self {
        Self {
            state: Mutex::new(State {
                next_ticket: 1,
                next_sequence: 1,
                queue: VecDeque::new(),
                active: None,
                completed: HashSet::new(),
                completed_order: VecDeque::new(),
                cancel_tombstones: HashMap::new(),
                cancel_tombstone_order: VecDeque::new(),
                closed: false,
                poisoned: false,
                poison_reason: None,
            }),
            changed: Condvar::new(),
        }
    }

    /// Queue a client transaction and reserve the FIFO turn. Request IDs are
    /// unique to one operation and must never be reused. `timeout_ms` defaults
    /// to 10 seconds and is capped at 60 seconds; `Some(0)` permits an
    /// immediate grant only.
    /// The returned lease is Reserved and cannot run its client body yet.
    pub fn begin(
        self: &Arc<Self>,
        request_id: impl Into<String>,
        label: impl Into<String>,
        timeout_ms: Option<u64>,
    ) -> Result<ApplyReservation, String> {
        self.begin_inner(request_id.into(), label.into(), timeout_ms, false)
    }

    /// Insert a native-store begin in FIFO order without waiting. Broker pipe
    /// readers call this before spawning the response worker.
    pub fn prepare_native_store_begin(
        self: &Arc<Self>,
        encoded_args: &Value,
    ) -> Result<PreparedApplyBegin, String> {
        let args = match super::wire::decode(encoded_args)? {
            super::wire::WireValue::Array(args) => args,
            _ => return Err("GPU apply transaction arguments must be an array".into()),
        };
        if args.len() != 2 && args.len() != 3 {
            return Err("GPU apply transaction argument count is invalid".into());
        }
        let request_id = wire_string_arg(&args, 0, "request ID")?;
        let label = wire_string_arg(&args, 1, "label")?;
        let timeout_ms = wire_timeout_arg(&args, 2)?;
        self.prepare_begin_inner(request_id, label, timeout_ms, false)
    }

    /// Wait for a synchronously reserved FIFO position. Cancellation may have
    /// removed it before this worker starts; that case returns without waiting.
    pub fn wait_prepared_begin(
        self: &Arc<Self>,
        prepared: PreparedApplyBegin,
    ) -> Result<ApplyReservation, String> {
        let mut state = self.lock_state()?;
        loop {
            if state.closed || state.poisoned {
                remove_ticket(&mut state.queue, prepared.ticket);
                return Err(UNAVAILABLE_MESSAGE.into());
            }
            if state.cancel_tombstones.contains_key(&prepared.request_id)
                || !state.queue.iter().any(|waiter| waiter.ticket == prepared.ticket)
            {
                return Err("GPU apply transaction request was cancelled".into());
            }
            let now = Instant::now();
            if prepared.had_to_queue && now >= prepared.deadline {
                log_stall(&state, &prepared.request_id, &prepared.label, prepared.enqueued_at, now);
                remove_ticket(&mut state.queue, prepared.ticket);
                self.changed.notify_all();
                return Err(BUSY_MESSAGE.into());
            }
            let at_front = state.queue.front().is_some_and(|waiter| waiter.ticket == prepared.ticket);
            if at_front && state.active.is_none() {
                let sequence = state.next_sequence;
                if sequence > MAX_SAFE_SEQUENCE {
                    close_locked(&mut state, "GPU apply FIFO sequence exceeded the JavaScript safe-integer range.");
                    self.changed.notify_all();
                    return Err(UNAVAILABLE_MESSAGE.into());
                }
                state.next_sequence = match sequence.checked_add(1) {
                    Some(next) => next,
                    None => {
                        close_locked(&mut state, "GPU apply FIFO sequence counter exhausted.");
                        self.changed.notify_all();
                        return Err(UNAVAILABLE_MESSAGE.into());
                    }
                };
                let Some(waiter) = state.queue.pop_front() else {
                    close_locked(&mut state, "GPU apply FIFO queue state was inconsistent.");
                    self.changed.notify_all();
                    return Err(UNAVAILABLE_MESSAGE.into());
                };
                state.active = Some(ActiveLease {
                    request_id: waiter.request_id,
                    token: waiter.token,
                    label: waiter.label,
                    sequence,
                    started_at: Instant::now(),
                    phase: LeasePhase::Reserved,
                    internal: waiter.internal,
                });
                return Ok(ApplyReservation { token: prepared.token, sequence });
            }
            if now >= prepared.deadline {
                log_stall(&state, &prepared.request_id, &prepared.label, prepared.enqueued_at, now);
                remove_ticket(&mut state.queue, prepared.ticket);
                self.changed.notify_all();
                return Err(BUSY_MESSAGE.into());
            }
            let remaining = prepared.deadline.saturating_duration_since(now);
            match self.changed.wait_timeout(state, remaining) {
                Ok((next, _)) => state = next,
                Err(error) => {
                    let (mut poisoned_state, _) = error.into_inner();
                    close_locked(&mut poisoned_state, "GPU apply FIFO mutex was poisoned.");
                    self.changed.notify_all();
                    return Err(UNAVAILABLE_MESSAGE.into());
                }
            }
        }
    }

    fn begin_inner(
        self: &Arc<Self>,
        request_id: String,
        label: String,
        timeout_ms: Option<u64>,
        internal: bool,
    ) -> Result<ApplyReservation, String> {
        let prepared = self.prepare_begin_inner(request_id, label, timeout_ms, internal)?;
        self.wait_prepared_begin(prepared)
    }

    fn prepare_begin_inner(
        &self,
        request_id: String,
        label: String,
        timeout_ms: Option<u64>,
        internal: bool,
    ) -> Result<PreparedApplyBegin, String> {
        if request_id.is_empty() || request_id.len() > 256 {
            return Err("GPU apply transaction request ID is invalid".into());
        }
        let label = normalized_label(label);
        let timeout = Duration::from_millis(timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).min(MAX_TIMEOUT_MS));
        let enqueued_at = Instant::now();
        let deadline = enqueued_at.checked_add(timeout).unwrap_or_else(|| {
            enqueued_at + Duration::from_millis(DEFAULT_TIMEOUT_MS)
        });
        let token = new_token();
        let mut state = self.lock_state()?;
        ensure_open(&state)?;
        prune_cancel_tombstones(&mut state, Instant::now());
        if state.cancel_tombstones.contains_key(&request_id) {
            // Reject before allocating a ticket or sequence. A cancellation
            // racing this worker consumes only its exact, unique request ID.
            return Err("GPU apply transaction request was cancelled".into());
        }
        if state.completed.iter().any(|(completed_id, _)| completed_id == &request_id) {
            return Err("GPU apply transaction request ID was already completed".into());
        }
        if state.active.as_ref().is_some_and(|lease| lease.request_id == request_id)
            || state.queue.iter().any(|waiter| waiter.request_id == request_id)
        {
            return Err("GPU apply transaction request ID is already in use".into());
        }
        if state.queue.len() >= MAX_QUEUED_WAITERS {
            return Err(BUSY_MESSAGE.into());
        }
        let had_to_queue = state.active.is_some() || !state.queue.is_empty();
        let ticket = state.next_ticket;
        state.next_ticket = match ticket.checked_add(1) {
            Some(next) => next,
            None => {
                close_locked(&mut state, "GPU apply FIFO ticket counter exhausted.");
                self.changed.notify_all();
                return Err(UNAVAILABLE_MESSAGE.into());
            }
        };
        state.queue.push_back(Waiter {
            request_id: request_id.clone(),
            token: token.clone(),
            label: label.clone(),
            ticket,
            enqueued_at,
            internal,
        });
        self.changed.notify_all();
        Ok(PreparedApplyBegin {
            request_id,
            token,
            label,
            ticket,
            enqueued_at,
            deadline,
            had_to_queue,
        })
    }

    /// Acknowledge the reserved lease before the client starts its body.
    /// Repeating the same acknowledgement is safe if its response was lost.
    pub fn activate(&self, request_id: &str, token: &str) -> Result<u64, String> {
        let mut state = self.lock_state()?;
        ensure_open(&state)?;
        let Some(active) = state.active.as_mut() else {
            return Err("GPU apply transaction lease is no longer active".into());
        };
        if active.request_id != request_id || active.token != token || active.internal {
            return Err("GPU apply transaction lease does not match".into());
        }
        active.phase = LeasePhase::Activated;
        Ok(active.sequence)
    }

    /// Acquire and activate a Rust-owned transaction. The returned guard
    /// releases the FIFO on every normal return or unwind.
    pub fn acquire_internal(
        self: &Arc<Self>,
        label: impl Into<String>,
        timeout_ms: Option<u64>,
    ) -> Result<InternalApplyGuard, String> {
        if INTERNAL_TRANSACTION_HELD.with(Cell::get) {
            return Err("GPU apply transaction is non-reentrant.".into());
        }
        let token = new_token();
        let request_id = format!("internal:{token}");
        let reservation = self.begin_inner(request_id.clone(), label.into(), timeout_ms, true)?;
        let sequence = match self.activate_internal(&request_id, &reservation.token) {
            Ok(sequence) => sequence,
            Err(error) => {
                self.cancel_internal(&request_id);
                return Err(error);
            }
        };
        INTERNAL_TRANSACTION_HELD.with(|held| held.set(true));
        Ok(InternalApplyGuard {
            coordinator: Arc::clone(self),
            request_id,
            token: reservation.token,
            sequence,
            not_send: PhantomData,
        })
    }

    fn activate_internal(&self, request_id: &str, token: &str) -> Result<u64, String> {
        let mut state = self.lock_state()?;
        ensure_open(&state)?;
        let Some(active) = state.active.as_mut() else {
            return Err("GPU apply transaction lease is no longer active".into());
        };
        if active.request_id != request_id || active.token != token || !active.internal {
            return Err("GPU apply transaction lease does not match".into());
        }
        active.phase = LeasePhase::Activated;
        Ok(active.sequence)
    }

    /// Complete a matching activated external transaction. A recent duplicate
    /// finish is idempotent so a lost response cannot strand the FIFO.
    pub fn finish(&self, request_id: &str, token: &str) -> Result<(), String> {
        let mut state = self.lock_state()?;
        let key = (request_id.to_owned(), token.to_owned());
        if state.completed.contains(&key) {
            return Ok(());
        }
        ensure_open(&state)?;
        let Some(active) = state.active.as_ref() else {
            return Err("GPU apply transaction lease is no longer active".into());
        };
        if active.request_id != request_id || active.token != token || active.internal {
            return Err("GPU apply transaction lease does not match".into());
        }
        if active.phase != LeasePhase::Activated {
            return Err("GPU apply transaction lease was not activated".into());
        }
        state.active = None;
        remember_completed(&mut state, key);
        self.changed.notify_all();
        Ok(())
    }

    /// Cancel only from the pre-body adapter path. In particular, an adapter
    /// that did not receive the `activate` response must cancel and must not
    /// invoke its body. The request ID can remove queued work or the matching
    /// Reserved/Activated lease; active operation bodies must use `finish`.
    pub fn cancel(&self, request_id: &str) -> Result<bool, String> {
        let mut state = self.lock_state()?;
        if state.closed || state.poisoned {
            return Ok(false);
        }
        let now = Instant::now();
        prune_cancel_tombstones(&mut state, now);
        if state.cancel_tombstones.contains_key(request_id) {
            return Ok(true);
        }
        if state.completed.iter().any(|(completed_id, _)| completed_id == request_id) {
            return Ok(false);
        }
        if state.active.as_ref().is_some_and(|active| active.request_id == request_id && active.internal)
            || state.queue.iter().any(|waiter| waiter.request_id == request_id && waiter.internal)
        { return Ok(false); }
        let active_removed = state.active.as_ref().is_some_and(|active| active.request_id == request_id);
        if active_removed { state.active = None; }
        let before = state.queue.len();
        state.queue.retain(|waiter| waiter.request_id != request_id);
        let queue_removed = state.queue.len() != before;
        if !insert_cancel_tombstone(&mut state, request_id.to_owned(), now) {
            // Never evict a live cancellation and accidentally admit its late
            // begin. Saturation fails the coordinator closed instead.
            close_locked(&mut state, "GPU apply cancellation tombstone capacity exhausted.");
            self.changed.notify_all();
            return Err(UNAVAILABLE_MESSAGE.into());
        }
        if active_removed || queue_removed || state.cancel_tombstones.contains_key(request_id) {
            self.changed.notify_all();
        }
        // An unknown ID is recorded too: its begin worker may still be delayed
        // before taking the coordinator mutex.
        Ok(true)
    }

    /// Fail closed during an indeterminate outcome or host shutdown, releasing
    /// every waiter and active lease. Refusal-cache poisoning belongs to the
    /// host integration and should be committed alongside this call.
    pub fn close_unknown(&self) {
        match self.state.lock() {
            Ok(mut state) => close_locked(&mut state, "GPU apply transaction outcome is unknown; host is closing."),
            Err(error) => close_locked(&mut error.into_inner(), "GPU apply FIFO mutex was poisoned."),
        }
        self.changed.notify_all();
    }

    pub fn status(&self) -> ApplyTransactionStatus {
        match self.lock_state() {
            Ok(state) => ApplyTransactionStatus {
                closed: state.closed,
                poisoned: state.poisoned,
                poison_reason: state.poison_reason.clone(),
            },
            Err(_) => ApplyTransactionStatus {
                closed: true,
                poisoned: true,
                poison_reason: Some("GPU apply FIFO mutex was poisoned.".into()),
            },
        }
    }

    /// Dispatch the four native-store transaction operations. Arguments use
    /// the shared tagged wire format; the result is encoded for the existing
    /// native-store response path.
    pub fn handle_native_store_request(
        self: &Arc<Self>,
        method: &str,
        encoded_args: &Value,
    ) -> Result<Value, String> {
        let args = match super::wire::decode(encoded_args)? {
            super::wire::WireValue::Array(args) => args,
            _ => return Err("GPU apply transaction arguments must be an array".into()),
        };
        let arg = |index: usize| args.get(index).ok_or("GPU apply transaction argument is missing".to_owned());
        let string_arg = |index: usize, label: &str| -> Result<String, String> {
            match arg(index)? {
                super::wire::WireValue::String(value) if !value.is_empty() => Ok(value.clone()),
                _ => Err(format!("GPU apply transaction {label} is invalid")),
            }
        };
        let timeout_arg = |index: usize| -> Result<Option<u64>, String> {
            match args.get(index) {
                None | Some(super::wire::WireValue::Undefined) | Some(super::wire::WireValue::Null) => Ok(None),
                Some(super::wire::WireValue::Number(value)) => value.as_u64().map(Some)
                    .ok_or("GPU apply transaction timeout is invalid".into()),
                _ => Err("GPU apply transaction timeout is invalid".into()),
            }
        };
        let exact_len = |expected: usize| -> Result<(), String> {
            if args.len() == expected { Ok(()) }
            else { Err("GPU apply transaction argument count is invalid".into()) }
        };

        let response = match method {
            "apply-transaction-begin" => {
                if args.len() != 2 && args.len() != 3 {
                    return Err("GPU apply transaction argument count is invalid".into());
                }
                let reservation = self.begin(
                    string_arg(0, "request ID")?,
                    string_arg(1, "label")?,
                    timeout_arg(2)?,
                )?;
                json!({"token": reservation.token, "sequence": reservation.sequence})
            }
            "apply-transaction-activate" => {
                exact_len(2)?;
                let sequence = self.activate(&string_arg(0, "request ID")?, &string_arg(1, "token")?)?;
                json!({"sequence": sequence})
            }
            "apply-transaction-finish" => {
                exact_len(2)?;
                self.finish(&string_arg(0, "request ID")?, &string_arg(1, "token")?)?;
                json!({"finished": true})
            }
            "apply-transaction-cancel" => {
                exact_len(1)?;
                let cancelled = self.cancel(&string_arg(0, "request ID")?)?;
                json!({"cancelled": cancelled})
            }
            _ => return Err("Unknown native apply transaction method".into()),
        };
        super::wire::encode_json(&response)
    }

    fn release_internal(&self, request_id: &str, token: &str) {
        let Ok(mut state) = self.lock_state() else { return; };
        let matches = state.active.as_ref().is_some_and(|active| {
            active.internal && active.request_id == request_id && active.token == token
        });
        if matches {
            state.active = None;
            self.changed.notify_all();
        }
    }

    fn cancel_internal(&self, request_id: &str) {
        let Ok(mut state) = self.lock_state() else { return; };
        if state.active.as_ref().is_some_and(|active| active.internal && active.request_id == request_id) {
            state.active = None;
        }
        state.queue.retain(|waiter| waiter.request_id != request_id || !waiter.internal);
        self.changed.notify_all();
    }

    fn lock_state(&self) -> Result<MutexGuard<'_, State>, String> {
        match self.state.lock() {
            Ok(state) => Ok(state),
            Err(error) => {
                let mut state = error.into_inner();
                close_locked(&mut state, "GPU apply FIFO mutex was poisoned.");
                self.changed.notify_all();
                Err(UNAVAILABLE_MESSAGE.into())
            }
        }
    }
}

/// Process-wide owner to share among the host's broker and native services.
pub fn process_lifetime() -> Arc<ApplyTransactionCoordinator> {
    static COORDINATOR: OnceLock<Arc<ApplyTransactionCoordinator>> = OnceLock::new();
    Arc::clone(COORDINATOR.get_or_init(|| Arc::new(ApplyTransactionCoordinator::new())))
}

/// RAII release for native synchronous apply bodies.
pub struct InternalApplyGuard {
    coordinator: Arc<ApplyTransactionCoordinator>,
    request_id: String,
    token: String,
    sequence: u64,
    // Keep this guard on the acquiring thread so the thread-local reentrancy
    // marker is always cleared by Drop on that same thread.
    not_send: PhantomData<Rc<()>>,
}

impl InternalApplyGuard {
    pub fn sequence(&self) -> u64 {
        self.sequence
    }
}

impl Drop for InternalApplyGuard {
    fn drop(&mut self) {
        if std::thread::panicking() {
            // A native setter may have reached the driver before unwind, so do
            // not release queued writers into an indeterminate outcome.
            self.coordinator.close_unknown();
        } else {
            self.coordinator.release_internal(&self.request_id, &self.token);
        }
        INTERNAL_TRANSACTION_HELD.with(|held| held.set(false));
    }
}

fn ensure_open(state: &State) -> Result<(), String> {
    if state.closed || state.poisoned { Err(UNAVAILABLE_MESSAGE.into()) } else { Ok(()) }
}

fn close_locked(state: &mut State, reason: &str) {
    state.closed = true;
    state.poisoned = true;
    state.poison_reason = Some(reason.to_owned());
    state.active = None;
    state.queue.clear();
    state.cancel_tombstones.clear();
    state.cancel_tombstone_order.clear();
}

fn normalized_label(label: String) -> String {
    let label = label.trim();
    if label.is_empty() { "GPU apply transaction".into() }
    else { label.chars().take(128).collect() }
}

fn wire_string_arg(args: &[super::wire::WireValue], index: usize, label: &str) -> Result<String, String> {
    match args.get(index) {
        Some(super::wire::WireValue::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(format!("GPU apply transaction {label} is invalid")),
    }
}

fn wire_timeout_arg(args: &[super::wire::WireValue], index: usize) -> Result<Option<u64>, String> {
    match args.get(index) {
        None | Some(super::wire::WireValue::Undefined) | Some(super::wire::WireValue::Null) => Ok(None),
        Some(super::wire::WireValue::Number(value)) => value.as_u64().map(Some)
            .ok_or("GPU apply transaction timeout is invalid".into()),
        _ => Err("GPU apply transaction timeout is invalid".into()),
    }
}

fn new_token() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn remove_ticket(queue: &mut VecDeque<Waiter>, ticket: u64) {
    if let Some(index) = queue.iter().position(|waiter| waiter.ticket == ticket) {
        queue.remove(index);
    }
}

#[cfg(test)]
mod tests {
    //! Behavioural coverage for the single apply FIFO. Assertions are written
    //! against what a caller observes - which body ran, in what order, and what
    //! the broker received - rather than against internal counters. The one
    //! deliberate exception is the prepared-ticket seam, which is the real pipe
    //! path: the ordered reader inserts the ticket and only the wait moves to a
    //! worker, so it is the only deterministic way to fix arrival order across
    //! threads. Time is driven through that same seam (deadlines) and through
    //! the tombstone table's own expiry field, never by sleeping.

    use super::*;
    use crate::backend::wire;
    use std::panic::AssertUnwindSafe;
    use std::sync::mpsc;

    const WAIT_LIMIT: Duration = Duration::from_secs(10);

    fn new_coordinator() -> Arc<ApplyTransactionCoordinator> {
        Arc::new(ApplyTransactionCoordinator::new())
    }

    /// Encode arguments exactly as `encodeTauriWire([...])` does on the broker
    /// side, so the suite exercises the pipe contract and not a private Rust
    /// convenience.
    fn wire_args(values: &[Value]) -> Value {
        wire::encode_json(&Value::Array(values.to_vec())).unwrap()
    }

    fn begin_args(request_id: &str, label: &str, timeout_ms: Option<u64>) -> Value {
        let mut values = vec![json!(request_id), json!(label)];
        if let Some(timeout_ms) = timeout_ms {
            values.push(json!(timeout_ms));
        }
        wire_args(&values)
    }

    /// Decode a response the way the broker's `decodeTauriWire` does, so a
    /// field rename or tag change fails here instead of in a live run.
    fn decode_response(value: &Value) -> Value {
        wire::decode(value).unwrap().into_json().unwrap()
    }

    fn pipe_request(
        coordinator: &Arc<ApplyTransactionCoordinator>,
        method: &str,
        args: Value,
    ) -> Result<Value, String> {
        coordinator
            .handle_native_store_request(method, &args)
            .map(|value| decode_response(&value))
    }

    fn acquire_and_activate(
        coordinator: &Arc<ApplyTransactionCoordinator>,
        request_id: &str,
    ) -> ApplyReservation {
        let reservation = coordinator.begin(request_id, "apply", None).unwrap();
        assert_eq!(
            coordinator.activate(request_id, &reservation.token).unwrap(),
            reservation.sequence,
        );
        reservation
    }

    fn release_external(
        coordinator: &Arc<ApplyTransactionCoordinator>,
        request_id: &str,
        reservation: &ApplyReservation,
    ) {
        coordinator.finish(request_id, &reservation.token).unwrap();
    }

    // ---- ordering -----------------------------------------------------------

    #[test]
    fn reserved_tickets_are_granted_in_arrival_order_not_thread_start_order() {
        let coordinator = new_coordinator();
        // Arrival order is fixed by the pipe reader, exactly as the host does
        // it, before any worker exists.
        let prepared = (0..5)
            .map(|index| {
                coordinator
                    .prepare_native_store_begin(&begin_args(
                        &format!("order-{index}"),
                        &format!("apply {index}"),
                        None,
                    ))
                    .unwrap()
            })
            .collect::<Vec<_>>();

        let observed = Arc::new(Mutex::new(Vec::new()));
        let mut workers = Vec::new();
        // Start the workers in reverse so a grant cannot follow start order.
        for (index, prepared) in prepared.into_iter().enumerate().rev() {
            let coordinator = Arc::clone(&coordinator);
            let observed = Arc::clone(&observed);
            workers.push(std::thread::spawn(move || {
                let request_id = format!("order-{index}");
                let reservation = coordinator.wait_prepared_begin(prepared).unwrap();
                let sequence = coordinator.activate(&request_id, &reservation.token).unwrap();
                assert_eq!(sequence, reservation.sequence);
                observed.lock().unwrap().push((index, sequence));
                coordinator.finish(&request_id, &reservation.token).unwrap();
            }));
        }
        for worker in workers {
            worker.join().unwrap();
        }

        let observed = observed.lock().unwrap().clone();
        assert_eq!(observed.iter().map(|(index, _)| *index).collect::<Vec<_>>(), vec![0, 1, 2, 3, 4]);
        let sequences = observed.iter().map(|(_, sequence)| *sequence).collect::<Vec<_>>();
        assert!(sequences.windows(2).all(|pair| pair[1] > pair[0]), "{sequences:?}");
        let mut unique = sequences.clone();
        unique.sort_unstable();
        unique.dedup();
        assert_eq!(unique.len(), sequences.len(), "a sequence was reused: {sequences:?}");
    }

    #[test]
    fn a_timed_out_waiter_leaves_the_queue_and_is_never_admitted_late() {
        let coordinator = new_coordinator();
        let holder = acquire_and_activate(&coordinator, "holder");

        // A zero budget behind a held turn is the documented busy refusal.
        let immediate = coordinator
            .prepare_native_store_begin(&begin_args("immediate", "immediate apply", Some(0)))
            .unwrap();
        assert_eq!(
            coordinator.wait_prepared_begin(immediate).err().unwrap(),
            BUSY_MESSAGE,
        );

        // The abandoned ticket must not block or jump the waiter behind it.
        let prepared = coordinator
            .prepare_native_store_begin(&begin_args("patient", "patient apply", None))
            .unwrap();
        let waiter = {
            let coordinator = Arc::clone(&coordinator);
            std::thread::spawn(move || {
                let reservation = coordinator.wait_prepared_begin(prepared)?;
                coordinator.activate("patient", &reservation.token)?;
                coordinator.finish("patient", &reservation.token)
            })
        };
        release_external(&coordinator, "holder", &holder);
        waiter.join().unwrap().unwrap();

        // The timed-out request was never granted a turn, even after the
        // holder released it.
        assert_eq!(
            coordinator.activate("immediate", &"0".repeat(32)).err().unwrap(),
            "GPU apply transaction lease is no longer active",
        );
        let next = acquire_and_activate(&coordinator, "after-timeouts");
        release_external(&coordinator, "after-timeouts", &next);
    }

    #[test]
    fn a_cancelled_reservation_never_runs_its_body() {
        let coordinator = new_coordinator();
        let prepared = coordinator
            .prepare_native_store_begin(&begin_args("cancelled", "apply", None))
            .unwrap();
        assert!(coordinator.cancel("cancelled").unwrap());
        assert_eq!(
            coordinator.wait_prepared_begin(prepared).err().unwrap(),
            "GPU apply transaction request was cancelled",
        );

        // Cancelling a queued waiter must not disturb the holder's turn.
        let holder = acquire_and_activate(&coordinator, "holder");
        let queued = coordinator
            .prepare_native_store_begin(&begin_args("queued", "queued apply", None))
            .unwrap();
        assert!(coordinator.cancel("queued").unwrap());
        assert_eq!(
            coordinator.wait_prepared_begin(queued).err().unwrap(),
            "GPU apply transaction request was cancelled",
        );
        assert_eq!(
            coordinator.begin("intruder", "intruder", Some(0)).err().unwrap(),
            BUSY_MESSAGE,
        );
        release_external(&coordinator, "holder", &holder);

        let after = acquire_and_activate(&coordinator, "after-cancel");
        release_external(&coordinator, "after-cancel", &after);
    }

    // ---- the protocol -------------------------------------------------------

    #[test]
    fn the_protocol_requires_begin_then_activate_then_finish() {
        let coordinator = new_coordinator();
        let unknown_token = "0".repeat(32);

        // activate / finish without begin.
        assert_eq!(
            coordinator.activate("ghost", &unknown_token).err().unwrap(),
            "GPU apply transaction lease is no longer active",
        );
        assert_eq!(
            coordinator.finish("ghost", &unknown_token).err().unwrap(),
            "GPU apply transaction lease is no longer active",
        );

        let reservation = coordinator.begin("ordered", "apply", None).unwrap();
        // finish before activate.
        assert_eq!(
            coordinator.finish("ordered", &reservation.token).err().unwrap(),
            "GPU apply transaction lease was not activated",
        );
        // A rejected finish must not have released the reserved turn.
        assert_eq!(
            coordinator.begin("intruder", "intruder", Some(0)).err().unwrap(),
            BUSY_MESSAGE,
        );
        // A mismatched id or token cannot acknowledge the lease.
        assert_eq!(
            coordinator.activate("ordered", &unknown_token).err().unwrap(),
            "GPU apply transaction lease does not match",
        );
        assert_eq!(
            coordinator.activate("other", &reservation.token).err().unwrap(),
            "GPU apply transaction lease does not match",
        );

        // Double activate is the documented lost-response retry: the same
        // sequence, so the broker's `started.sequence !== lease.sequence`
        // check still holds.
        let sequence = coordinator.activate("ordered", &reservation.token).unwrap();
        assert_eq!(sequence, reservation.sequence);
        assert_eq!(
            coordinator.activate("ordered", &reservation.token).unwrap(),
            sequence,
        );

        // Double finish is the documented lost-response retry.
        coordinator.finish("ordered", &reservation.token).unwrap();
        coordinator.finish("ordered", &reservation.token).unwrap();
    }

    #[test]
    fn a_request_id_must_be_fresh_for_every_operation() {
        let coordinator = new_coordinator();

        // Live as an active lease.
        let holder = acquire_and_activate(&coordinator, "duplicate");
        assert_eq!(
            coordinator.begin("duplicate", "apply", Some(0)).err().unwrap(),
            "GPU apply transaction request ID is already in use",
        );
        release_external(&coordinator, "duplicate", &holder);
        // Reuse after the body ran would be a second write for one request.
        assert_eq!(
            coordinator.begin("duplicate", "apply", None).err().unwrap(),
            "GPU apply transaction request ID was already completed",
        );

        // Live as a queued ticket.
        let holder = acquire_and_activate(&coordinator, "queued-holder");
        let prepared = coordinator
            .prepare_native_store_begin(&begin_args("queued-id", "apply", None))
            .unwrap();
        assert_eq!(
            coordinator.begin("queued-id", "apply", None).err().unwrap(),
            "GPU apply transaction request ID is already in use",
        );
        assert!(coordinator.cancel("queued-id").unwrap());
        assert_eq!(
            coordinator.wait_prepared_begin(prepared).err().unwrap(),
            "GPU apply transaction request was cancelled",
        );
        release_external(&coordinator, "queued-holder", &holder);

        // Unusable ids are refused before they can take a ticket.
        assert_eq!(
            coordinator.begin("", "apply", None).err().unwrap(),
            "GPU apply transaction request ID is invalid",
        );
        assert_eq!(
            coordinator.begin("x".repeat(257), "apply", None).err().unwrap(),
            "GPU apply transaction request ID is invalid",
        );
    }

    // ---- lost messages ------------------------------------------------------

    #[test]
    fn a_lost_begin_response_is_recovered_by_cancelling_before_the_body() {
        // main.js: a failed or lost begin response reaches `cancelBeforeRun`,
        // so the body never runs and only the request ID is known.
        let coordinator = new_coordinator();
        let holder = acquire_and_activate(&coordinator, "holder");
        let prepared = coordinator
            .prepare_native_store_begin(&begin_args("lost-begin", "apply", None))
            .unwrap();

        assert_eq!(
            pipe_request(
                &coordinator,
                "apply-transaction-cancel",
                wire_args(&[json!("lost-begin")]),
            )
            .unwrap(),
            json!({"cancelled": true}),
        );
        assert_eq!(
            coordinator.wait_prepared_begin(prepared).err().unwrap(),
            "GPU apply transaction request was cancelled",
        );

        // The holder's turn is untouched and is released normally.
        release_external(&coordinator, "holder", &holder);

        // A begin whose response was lost after the turn was already granted
        // leaves a Reserved lease that only its own request ID can release.
        let granted = coordinator.begin("lost-begin-ack", "apply", None).unwrap();
        assert!(coordinator.cancel("lost-begin-ack").unwrap());
        assert_eq!(
            coordinator.activate("lost-begin-ack", &granted.token).err().unwrap(),
            "GPU apply transaction lease is no longer active",
        );

        let next = acquire_and_activate(&coordinator, "after-lost-begin");
        release_external(&coordinator, "after-lost-begin", &next);
    }

    #[test]
    fn a_lost_activate_response_is_recovered_by_cancelling_before_the_body() {
        let coordinator = new_coordinator();
        let reservation = coordinator.begin("lost-activate", "apply", None).unwrap();
        // The host applied the activation but the response never arrived, so
        // the broker cancels instead of running its body.
        assert_eq!(
            coordinator.activate("lost-activate", &reservation.token).unwrap(),
            reservation.sequence,
        );
        assert_eq!(
            pipe_request(
                &coordinator,
                "apply-transaction-cancel",
                wire_args(&[json!("lost-activate")]),
            )
            .unwrap(),
            json!({"cancelled": true}),
        );

        // The turn is free and the abandoned lease can never be activated.
        assert_eq!(
            coordinator.activate("lost-activate", &reservation.token).err().unwrap(),
            "GPU apply transaction lease is no longer active",
        );
        let next = acquire_and_activate(&coordinator, "after-lost-activate");
        assert!(next.sequence > reservation.sequence);
        release_external(&coordinator, "after-lost-activate", &next);
    }

    #[test]
    fn a_lost_finish_acknowledgement_cannot_release_a_later_transaction() {
        let coordinator = new_coordinator();
        let first = acquire_and_activate(&coordinator, "first");
        release_external(&coordinator, "first", &first);

        let second = acquire_and_activate(&coordinator, "second");
        // The broker retries a finish whose response was lost. It is idempotent
        // for its own lease only.
        assert_eq!(
            pipe_request(
                &coordinator,
                "apply-transaction-finish",
                wire_args(&[json!("first"), json!(first.token)]),
            )
            .unwrap(),
            json!({"finished": true}),
        );
        // The replay must not have freed the second transaction's turn: its own
        // finish still succeeds only while it is the active lease.
        release_external(&coordinator, "second", &second);

        // A finish carrying the right id but the wrong token cannot release a
        // live turn either.
        let third = acquire_and_activate(&coordinator, "third");
        assert_eq!(
            coordinator.finish("third", &"0".repeat(32)).err().unwrap(),
            "GPU apply transaction lease does not match",
        );
        release_external(&coordinator, "third", &third);
    }

    #[test]
    fn close_unknown_poisons_the_coordinator_and_releases_every_waiter() {
        let coordinator = new_coordinator();
        let holder = acquire_and_activate(&coordinator, "holder");
        let prepared = coordinator
            .prepare_native_store_begin(&begin_args("waiter", "waiter apply", None))
            .unwrap();
        let waiter = {
            let coordinator = Arc::clone(&coordinator);
            std::thread::spawn(move || coordinator.wait_prepared_begin(prepared))
        };

        coordinator.close_unknown();

        assert_eq!(
            waiter.join().unwrap().err().unwrap(),
            "GPU apply coordinator is unavailable; restart Arc Power.",
        );
        let status = coordinator.status();
        assert!(status.closed);
        assert!(status.poisoned);
        assert_eq!(
            status.poison_reason.as_deref(),
            Some("GPU apply transaction outcome is unknown; host is closing."),
        );

        // The indeterminate holder cannot report a successful release, so the
        // broker's finish retry fails closed instead of freeing the turn.
        assert_eq!(
            coordinator.finish("holder", &holder.token).err().unwrap(),
            "GPU apply coordinator is unavailable; restart Arc Power.",
        );
        // No new work is admitted and cancellation is not claimed.
        assert_eq!(
            coordinator.begin("after-close", "apply", None).err().unwrap(),
            "GPU apply coordinator is unavailable; restart Arc Power.",
        );
        assert!(!coordinator.cancel("after-close").unwrap());
    }

    // ---- cancellation tombstones -------------------------------------------

    #[test]
    fn a_cancelled_request_id_stays_dead_and_a_delayed_begin_is_rejected() {
        // The tombstone must outlive the longest wait the coordinator allows.
        assert!(CANCEL_TOMBSTONE_TTL >= Duration::from_millis(MAX_TIMEOUT_MS));

        let coordinator = new_coordinator();
        // Cancelling an unknown id is how a delayed begin is defused.
        assert!(coordinator.cancel("delayed").unwrap());
        assert_eq!(
            coordinator
                .prepare_native_store_begin(&begin_args("delayed", "apply", None))
                .err()
                .unwrap(),
            "GPU apply transaction request was cancelled",
        );
        assert_eq!(
            coordinator.begin("delayed", "apply", None).err().unwrap(),
            "GPU apply transaction request was cancelled",
        );
        // Repeated cancellation stays acknowledged and keeps the id dead.
        assert!(coordinator.cancel("delayed").unwrap());
        assert_eq!(
            coordinator.begin("delayed", "apply", None).err().unwrap(),
            "GPU apply transaction request was cancelled",
        );
    }

    #[test]
    fn a_tombstone_expires_after_its_ttl_and_not_before() {
        // Deterministic clock: insert the tombstone already aged past its
        // expiry instead of sleeping for ten minutes.
        let coordinator = new_coordinator();
        {
            let mut state = coordinator.state.lock().unwrap();
            let now = Instant::now();
            assert!(insert_cancel_tombstone(
                &mut state,
                "aged".into(),
                now - CANCEL_TOMBSTONE_TTL - Duration::from_secs(1),
            ));
            assert!(state.cancel_tombstones.contains_key("aged"));
        }

        // The expired entry is pruned, so the bounded table cannot leak for the
        // lifetime of the process.
        let reservation = coordinator.begin("aged", "apply", None).unwrap();
        assert_eq!(
            coordinator.activate("aged", &reservation.token).unwrap(),
            reservation.sequence,
        );
        release_external(&coordinator, "aged", &reservation);
        {
            let state = coordinator.state.lock().unwrap();
            assert!(!state.cancel_tombstones.contains_key("aged"));
        }
    }

    #[test]
    fn a_full_tombstone_table_closes_the_coordinator_instead_of_evicting_a_live_tombstone() {
        let coordinator = new_coordinator();
        for index in 0..CANCEL_TOMBSTONE_LIMIT {
            assert!(coordinator.cancel(&format!("cancelled-{index}")).unwrap());
        }
        assert_eq!(
            coordinator.cancel("overflow").err().unwrap(),
            "GPU apply coordinator is unavailable; restart Arc Power.",
        );

        // Evicting a live tombstone could admit its delayed begin, so the whole
        // coordinator closes instead.
        let status = coordinator.status();
        assert!(status.closed);
        assert!(status.poisoned);
        assert!(status.poison_reason.unwrap().contains("tombstone capacity"));
        assert_eq!(
            coordinator.begin("cancelled-0", "apply", None).err().unwrap(),
            "GPU apply coordinator is unavailable; restart Arc Power.",
        );
    }

    // ---- limits -------------------------------------------------------------

    #[test]
    fn the_waiter_queue_is_bounded_and_reports_the_busy_message() {
        let coordinator = new_coordinator();
        let mut reserved = Vec::new();
        for index in 0..MAX_QUEUED_WAITERS {
            let request_id = format!("waiter-{index}");
            coordinator
                .prepare_native_store_begin(&begin_args(&request_id, "apply", None))
                .unwrap();
            reserved.push(request_id);
        }

        assert_eq!(
            coordinator
                .prepare_native_store_begin(&begin_args("overflow", "apply", None))
                .err()
                .unwrap(),
            BUSY_MESSAGE,
        );
        assert_eq!(
            coordinator.begin("overflow-blocking", "apply", Some(0)).err().unwrap(),
            BUSY_MESSAGE,
        );
        // A full queue refuses the caller; it does not close the coordinator.
        assert!(!coordinator.status().closed);

        // Draining the queue restores service for the same process.
        for request_id in &reserved {
            assert!(coordinator.cancel(request_id).unwrap());
        }
        let reservation = acquire_and_activate(&coordinator, "after-drain");
        release_external(&coordinator, "after-drain", &reservation);
    }

    #[test]
    fn timeouts_default_and_clamp_to_the_documented_bounds() {
        // The broker's `waitForQueueTurn` and this refusal share one literal.
        assert_eq!(BUSY_MESSAGE, "GPU apply is busy; try again.");
        assert_eq!(DEFAULT_TIMEOUT_MS, 10_000);
        assert_eq!(MAX_TIMEOUT_MS, 60_000);

        let coordinator = new_coordinator();
        let defaulted = coordinator
            .prepare_native_store_begin(&begin_args("defaulted", "apply", None))
            .unwrap();
        assert_eq!(
            defaulted.deadline.duration_since(defaulted.enqueued_at),
            Duration::from_millis(DEFAULT_TIMEOUT_MS),
        );
        // A caller asking for longer than the maximum gets the maximum, which is
        // what keeps the wait inside the tombstone TTL.
        let clamped = coordinator
            .prepare_native_store_begin(&begin_args("clamped", "apply", Some(u64::MAX)))
            .unwrap();
        assert_eq!(
            clamped.deadline.duration_since(clamped.enqueued_at),
            Duration::from_millis(MAX_TIMEOUT_MS),
        );
        let immediate = coordinator
            .prepare_native_store_begin(&begin_args("immediate", "apply", Some(0)))
            .unwrap();
        assert_eq!(immediate.deadline, immediate.enqueued_at);
        for request_id in ["defaulted", "clamped", "immediate"] {
            assert!(coordinator.cancel(request_id).unwrap());
        }

        // A zero budget still grants an idle coordinator, and only an idle one.
        let reservation = coordinator.begin("zero-budget", "apply", Some(0)).unwrap();
        assert_eq!(
            coordinator.begin("blocked", "apply", Some(0)).err().unwrap(),
            BUSY_MESSAGE,
        );
        assert_eq!(
            coordinator.activate("zero-budget", &reservation.token).unwrap(),
            reservation.sequence,
        );
        release_external(&coordinator, "zero-budget", &reservation);
    }

    // ---- sequences ----------------------------------------------------------

    #[test]
    fn sequences_are_monotonic_and_never_reused() {
        let coordinator = new_coordinator();
        let mut sequences = Vec::new();
        for index in 0..5 {
            let request_id = format!("sequence-{index}");
            let reservation = acquire_and_activate(&coordinator, &request_id);
            assert!(reservation.sequence > 0);
            assert!(reservation.sequence <= MAX_SAFE_SEQUENCE);
            sequences.push(reservation.sequence);
            release_external(&coordinator, &request_id, &reservation);
        }
        assert!(sequences.windows(2).all(|pair| pair[1] > pair[0]), "{sequences:?}");

        // A cancelled reservation consumed its sequence too: the next grant is
        // still strictly greater, never a recycled number.
        let abandoned = coordinator.begin("abandoned", "apply", None).unwrap();
        assert!(coordinator.cancel("abandoned").unwrap());
        let next = acquire_and_activate(&coordinator, "after-abandon");
        assert!(next.sequence > *sequences.last().unwrap());
        assert!(next.sequence > abandoned.sequence);
        release_external(&coordinator, "after-abandon", &next);
    }

    #[test]
    fn the_sequence_counter_stops_at_the_javascript_safe_integer_boundary() {
        // The broker stores sequences as doubles; beyond 2^53 - 1 ordering
        // would silently corrupt.
        assert_eq!(MAX_SAFE_SEQUENCE, (1u64 << 53) - 1);

        let coordinator = new_coordinator();
        {
            let mut state = coordinator.state.lock().unwrap();
            state.next_sequence = MAX_SAFE_SEQUENCE;
        }
        let last = acquire_and_activate(&coordinator, "last-safe");
        assert_eq!(last.sequence, MAX_SAFE_SEQUENCE);
        release_external(&coordinator, "last-safe", &last);

        // The next grant would exceed the range, so the coordinator closes
        // rather than handing the broker an unrepresentable sequence.
        assert_eq!(
            coordinator.begin("beyond-safe", "apply", None).err().unwrap(),
            "GPU apply coordinator is unavailable; restart Arc Power.",
        );
        let status = coordinator.status();
        assert!(status.closed);
        assert!(status.poisoned);
        assert!(status.poison_reason.unwrap().contains("safe-integer"));
    }

    #[test]
    fn the_completed_token_table_is_bounded_and_a_replayed_finish_fails_closed() {
        let coordinator = new_coordinator();
        let oldest = acquire_and_activate(&coordinator, "completed-0");
        release_external(&coordinator, "completed-0", &oldest);
        for index in 1..=COMPLETED_TOKEN_LIMIT {
            let request_id = format!("completed-{index}");
            let reservation = acquire_and_activate(&coordinator, &request_id);
            release_external(&coordinator, &request_id, &reservation);
        }

        // The oldest completion was evicted from the bounded table. Its replay
        // must fail closed instead of reporting a release it did not perform.
        assert_eq!(
            coordinator.finish("completed-0", &oldest.token).err().unwrap(),
            "GPU apply transaction lease is no longer active",
        );
        assert!(!coordinator.status().closed);
        let next = acquire_and_activate(&coordinator, "after-eviction");
        release_external(&coordinator, "after-eviction", &next);
    }

    // ---- concurrency --------------------------------------------------------

    #[test]
    fn internal_apply_fifo_serializes_a_second_acquisition() {
        let coordinator = Arc::new(ApplyTransactionCoordinator::new());
        let guard = coordinator.acquire_internal("apply-settings", None).unwrap();

        // The same thread is non-reentrant by construction (a temperature
        // lease body must never nest a second FIFO turn).
        assert!(matches!(
            coordinator.acquire_internal("apply-settings", None),
            Err(message) if message == "GPU apply transaction is non-reentrant.",
        ));
        // A concurrent waiter holds a short budget and hits the busy refusal
        // while the profile guard owns the turn.
        let waiter = Arc::clone(&coordinator);
        let busy = std::thread::spawn(move || {
            waiter.acquire_internal("apply-settings", Some(0)).err()
        }).join().unwrap();
        assert_eq!(busy.as_deref(), Some(BUSY_MESSAGE));

        // The broker protocol cannot acknowledge, cancel or release a native
        // body's turn: those operations must go through the guard.
        assert_eq!(
            coordinator.activate(&guard.request_id, &guard.token).err().unwrap(),
            "GPU apply transaction lease does not match",
        );
        assert_eq!(
            coordinator.finish(&guard.request_id, &guard.token).err().unwrap(),
            "GPU apply transaction lease does not match",
        );
        assert!(!coordinator.cancel(&guard.request_id).unwrap());
        assert_eq!(
            coordinator.activate("intruder", &guard.token).err().unwrap(),
            "GPU apply transaction lease does not match",
        );

        // The released turn is acquirable again, which also proves the
        // thread-local reentrancy marker was cleared on drop.
        drop(guard);
        let second = coordinator.acquire_internal("apply-settings", None).unwrap();
        drop(second);
    }

    #[test]
    fn a_panicking_native_body_closes_the_coordinator_instead_of_releasing_the_turn() {
        let coordinator = new_coordinator();
        let panicked = std::panic::catch_unwind(AssertUnwindSafe({
            let coordinator = Arc::clone(&coordinator);
            move || {
                let _guard = coordinator.acquire_internal("panicking apply", None).unwrap();
                panic!("driver fault after a partial write");
            }
        }));
        assert!(panicked.is_err());

        // The setter may have reached the driver, so the outcome is unknown:
        // queued writers must not be released into it.
        let status = coordinator.status();
        assert!(status.closed);
        assert!(status.poisoned);
        assert!(status.poison_reason.unwrap().contains("outcome is unknown"));
        // The marker was cleared on unwind, so the refusal is the closed
        // coordinator and not a stale non-reentrancy error.
        assert_eq!(
            coordinator.acquire_internal("after-panic", None).err().unwrap(),
            "GPU apply coordinator is unavailable; restart Arc Power.",
        );
        assert_eq!(
            coordinator.begin("after-panic", "apply", None).err().unwrap(),
            "GPU apply coordinator is unavailable; restart Arc Power.",
        );
    }

    #[test]
    fn two_threads_contending_on_begin_both_complete_without_deadlock() {
        let coordinator = new_coordinator();
        let (sender, receiver) = mpsc::channel();
        let mut workers = Vec::new();
        for index in 0..2 {
            let coordinator = Arc::clone(&coordinator);
            let sender = sender.clone();
            workers.push(std::thread::spawn(move || {
                let request_id = format!("thread-{index}");
                let outcome = coordinator.begin(&request_id, "apply", None).and_then(|reservation| {
                    let sequence = coordinator.activate(&request_id, &reservation.token)?;
                    coordinator.finish(&request_id, &reservation.token)?;
                    Ok(sequence)
                });
                let _ = sender.send(outcome);
            }));
        }
        drop(sender);

        let mut sequences = Vec::new();
        for _ in 0..2 {
            sequences.push(
                receiver
                    .recv_timeout(WAIT_LIMIT)
                    .expect("both contending apply threads must complete")
                    .unwrap(),
            );
        }
        for worker in workers {
            worker.join().unwrap();
        }
        sequences.sort_unstable();
        assert_ne!(sequences[0], sequences[1], "two turns shared one sequence");
        assert!(sequences.iter().all(|sequence| *sequence > 0 && *sequence <= MAX_SAFE_SEQUENCE));
    }

    #[test]
    fn native_and_broker_transactions_share_one_fifo_without_deadlock() {
        let coordinator = new_coordinator();

        // A broker turn is held while a prepared broker waiter queues behind it.
        let broker = acquire_and_activate(&coordinator, "broker");
        let prepared = coordinator
            .prepare_native_store_begin(&begin_args("broker-waiter", "apply", None))
            .unwrap();
        let (sender, receiver) = mpsc::channel();
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            std::thread::spawn(move || {
                let outcome = coordinator.wait_prepared_begin(prepared).and_then(|reservation| {
                    let sequence = coordinator.activate("broker-waiter", &reservation.token)?;
                    coordinator.finish("broker-waiter", &reservation.token)?;
                    Ok(sequence)
                });
                let _ = sender.send(outcome);
            })
        };
        release_external(&coordinator, "broker", &broker);
        let waiter_sequence = receiver
            .recv_timeout(WAIT_LIMIT)
            .expect("the broker waiter must finish")
            .unwrap();
        worker.join().unwrap();
        assert_eq!(waiter_sequence, broker.sequence + 1);

        // A native body holds the turn while a broker begin queues behind it.
        let guard = coordinator.acquire_internal("native", None).unwrap();
        let native_sequence = guard.sequence();
        let (sender, receiver) = mpsc::channel();
        let worker = {
            let coordinator = Arc::clone(&coordinator);
            std::thread::spawn(move || {
                let outcome = coordinator.begin("native-waiter", "apply", None).and_then(|reservation| {
                    let sequence = coordinator.activate("native-waiter", &reservation.token)?;
                    coordinator.finish("native-waiter", &reservation.token)?;
                    Ok(sequence)
                });
                let _ = sender.send(outcome);
            })
        };
        drop(guard);
        let broker_sequence = receiver
            .recv_timeout(WAIT_LIMIT)
            .expect("the broker waiter must finish after the native guard")
            .unwrap();
        worker.join().unwrap();
        assert_eq!(broker_sequence, native_sequence + 1);
    }

    #[test]
    fn the_process_lifetime_coordinator_is_a_single_instance() {
        // Every native root and the broker bridge must share one FIFO.
        assert!(Arc::ptr_eq(&process_lifetime(), &process_lifetime()));
    }

    // ---- cross-host wire contract ------------------------------------------

    #[test]
    fn the_pipe_protocol_matches_the_broker_adapter() {
        let coordinator = new_coordinator();
        // main.js: randomUUID().replaceAll('-', '') -> 32 lowercase hex.
        let request_id = "0123456789abcdef0123456789abcdef";

        // begin: [requestId, label, timeoutMs] -> { token, sequence }.
        let encoded_begin = coordinator
            .handle_native_store_request(
                "apply-transaction-begin",
                &begin_args(request_id, "apply-profile", Some(10_000)),
            )
            .unwrap();
        assert_eq!(encoded_begin["t"].as_str(), Some("object"));
        let lease = decode_response(&encoded_begin);
        let lease = lease.as_object().unwrap();
        assert_eq!(lease.len(), 2, "the broker reads exactly token and sequence");
        let token = lease["token"].as_str().unwrap();
        assert_eq!(token.len(), 32);
        assert!(token.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
        let sequence = lease["sequence"].as_u64().unwrap();
        assert!(sequence > 0 && sequence <= MAX_SAFE_SEQUENCE);

        // activate: [requestId, token] -> { sequence } equal to the lease.
        assert_eq!(
            pipe_request(
                &coordinator,
                "apply-transaction-activate",
                wire_args(&[json!(request_id), json!(token)]),
            )
            .unwrap(),
            json!({"sequence": sequence}),
        );

        // finish: [requestId, token] -> { finished: true }.
        for _ in 0..2 {
            assert_eq!(
                pipe_request(
                    &coordinator,
                    "apply-transaction-finish",
                    wire_args(&[json!(request_id), json!(token)]),
                )
                .unwrap(),
                json!({"finished": true}),
            );
        }

        // cancel: [requestId] -> { cancelled: boolean }, both answers.
        assert_eq!(
            pipe_request(
                &coordinator,
                "apply-transaction-cancel",
                wire_args(&[json!("never-started")]),
            )
            .unwrap(),
            json!({"cancelled": true}),
        );
        assert_eq!(
            pipe_request(
                &coordinator,
                "apply-transaction-cancel",
                wire_args(&[json!(request_id)]),
            )
            .unwrap(),
            json!({"cancelled": false}),
        );

        // The optional timeout may be omitted or sent as JS `undefined`.
        for (args, cancelled_id) in [
            (wire_args(&[json!("two-args"), json!("apply")]), "two-args"),
            (
                json!({"t":"array","v":[
                    {"t":"string","v":"undefined-timeout"},
                    {"t":"string","v":"apply"},
                    {"t":"undefined"}
                ]}),
                "undefined-timeout",
            ),
        ] {
            let reservation = pipe_request(&coordinator, "apply-transaction-begin", args).unwrap();
            assert!(reservation["sequence"].as_u64().unwrap() > 0);
            assert_eq!(
                pipe_request(
                    &coordinator,
                    "apply-transaction-cancel",
                    wire_args(&[json!(cancelled_id)]),
                )
                .unwrap(),
                json!({"cancelled": true}),
            );
        }

        // Argument-shape errors are the plain messages main.js surfaces.
        for (method, args, message) in [
            ("apply-transaction-unknown", wire_args(&[]), "Unknown native apply transaction method"),
            ("apply-transaction-activate", wire_args(&[json!("id")]), "GPU apply transaction argument count is invalid"),
            ("apply-transaction-finish", wire_args(&[json!("id"), json!("token"), json!("extra")]), "GPU apply transaction argument count is invalid"),
            ("apply-transaction-cancel", wire_args(&[]), "GPU apply transaction argument count is invalid"),
            ("apply-transaction-begin", wire_args(&[json!(""), json!("apply")]), "GPU apply transaction request ID is invalid"),
            ("apply-transaction-begin", wire_args(&[json!("id"), json!("apply"), json!("soon")]), "GPU apply transaction timeout is invalid"),
            ("apply-transaction-begin", wire_args(&[json!("id"), json!("apply"), json!(-1)]), "GPU apply transaction timeout is invalid"),
        ] {
            assert_eq!(pipe_request(&coordinator, method, args).err().unwrap(), message, "{method}");
        }
        // Both entry points agree on the envelope shape.
        for entry in [
            coordinator.handle_native_store_request("apply-transaction-begin", &json!({"t":"null"})),
            coordinator
                .prepare_native_store_begin(&json!({"t":"null"}))
                .map(|_| json!(null)),
        ] {
            assert_eq!(
                entry.err().unwrap(),
                "GPU apply transaction arguments must be an array",
            );
        }
        assert_eq!(
            coordinator
                .prepare_native_store_begin(&wire_args(&[json!("id")]))
                .err()
                .unwrap(),
            "GPU apply transaction argument count is invalid",
        );
    }
}

fn remember_completed(state: &mut State, key: (String, String)) {
    if state.completed.insert(key.clone()) {
        state.completed_order.push_back(key);
    }
    while state.completed_order.len() > COMPLETED_TOKEN_LIMIT {
        if let Some(expired) = state.completed_order.pop_front() {
            state.completed.remove(&expired);
        }
    }
}

fn prune_cancel_tombstones(state: &mut State, now: Instant) {
    while state.cancel_tombstone_order.front().is_some_and(|(_, expires_at)| *expires_at <= now) {
        let Some((request_id, expires_at)) = state.cancel_tombstone_order.pop_front() else { break; };
        if state.cancel_tombstones.get(&request_id) == Some(&expires_at) {
            state.cancel_tombstones.remove(&request_id);
        }
    }
}

fn insert_cancel_tombstone(state: &mut State, request_id: String, now: Instant) -> bool {
    if state.cancel_tombstones.contains_key(&request_id) { return true; }
    prune_cancel_tombstones(state, now);
    if state.cancel_tombstones.len() >= CANCEL_TOMBSTONE_LIMIT { return false; }
    let expires_at = now + CANCEL_TOMBSTONE_TTL;
    state.cancel_tombstones.insert(request_id.clone(), expires_at);
    state.cancel_tombstone_order.push_back((request_id, expires_at));
    true
}

fn log_stall(state: &State, request_id: &str, requested_label: &str, enqueued_at: Instant, now: Instant) {
    let waited_ms = now.duration_since(enqueued_at).as_millis();
    let waited_ms = waited_ms.min(u64::MAX as u128) as u64;
    let (holder_label, duration_ms, duration_word) = if let Some(active) = state.active.as_ref() {
        let duration_ms = active.started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        (active.label.as_str(), duration_ms, "held")
    } else if let Some(holder) = state.queue.front().filter(|waiter| waiter.request_id != request_id) {
        let duration_ms = holder.enqueued_at.elapsed().as_millis().min(u64::MAX as u128) as u64;
        (holder.label.as_str(), duration_ms, "waited")
    } else {
        ("no active holder", waited_ms, "waited")
    };
    eprintln!(
        "[Arc Power] apply transaction \"{requested_label}\" timed out after {waited_ms}ms; holder \"{holder_label}\" has {duration_word} {duration_ms}ms."
    );
}
