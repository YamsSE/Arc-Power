// Cross-process GPU apply serialization shared with the Rust host.
// A Windows named mutex is owned by the kernel, so a crashed apply process
// relinquishes it (WAIT_ABANDONED) instead of stranding the product.
import koffi from 'koffi';
import { AsyncLocalStorage } from 'node:async_hooks';

export const APPLY_MUTEX_NAME = 'Local\\ArcPower-GPU-Apply-v1';
export const WAIT_OBJECT_0 = 0;
export const WAIT_ABANDONED = 0x80;
export const WAIT_TIMEOUT = 0x102;
export const BROKER_APPLY_WAIT_TIMEOUT_MS = 10_000;

let nativeCache;
let writeQueue = Promise.resolve();
let brokerTransactionQueue = Promise.resolve();
let brokerTransactionSequence = 0;
let brokerTransactionDelegate = null;
const writeQueueEntries = [];
const brokerTransactionEntries = [];
let brokerTransactionHolder = null;
const writeLockContext = new AsyncLocalStorage();
const brokerTransactionContext = new AsyncLocalStorage();

async function runFifo(queueName, operation, waitOptions) {
  const previous = queueName === 'write' ? writeQueue : brokerTransactionQueue;
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const writeEntry = queueName === 'write' ? {} : null;
  const hasEarlierWrite = queueName === 'write' && writeQueueEntries.length > 0;
  if (queueName === 'write') writeQueue = previous.then(() => turn);
  else brokerTransactionQueue = previous.then(() => turn);
  if (writeEntry) writeQueueEntries.push(writeEntry);
  try {
    if (queueName === 'write') {
      if (hasEarlierWrite) await waitForQueueTurn(previous, waitOptions, () => {});
      else await previous;
    } else {
      await previous;
    }
    return await operation();
  } finally {
    if (writeEntry) {
      const index = writeQueueEntries.indexOf(writeEntry);
      if (index !== -1) writeQueueEntries.splice(index, 1);
    }
    release();
  }
}

async function waitForQueueTurn(previous, { timeoutMs, pollMs, now, sleep }, onTimeout) {
  const waitStartedAt = now();
  const timeout = (waitedMs) => {
    onTimeout(waitedMs);
    throw new Error('GPU apply is busy; try again.');
  };
  for (;;) {
    const waitedMs = Math.max(0, now() - waitStartedAt);
    const remainingMs = timeoutMs - waitedMs;
    if (remainingMs <= 0) timeout(waitedMs);
    const ready = await Promise.race([
      previous.then(() => true),
      sleep(Math.min(pollMs, remainingMs)).then(() => false),
    ]);
    if (ready) {
      const readyAtWaitedMs = Math.max(0, now() - waitStartedAt);
      if (readyAtWaitedMs >= timeoutMs) timeout(readyAtWaitedMs);
      return;
    }
  }
}

function removeBrokerEntry(entry) {
  const index = brokerTransactionEntries.indexOf(entry);
  if (index !== -1) brokerTransactionEntries.splice(index, 1);
}

function logBrokerWaitTimeout(waiter, waitedMs, log, holderAtWaitStart) {
  const holder = brokerTransactionHolder
    ?? brokerTransactionEntries.find((entry) => entry !== waiter)
    ?? holderAtWaitStart;
  const holderLabel = holder?.label ?? 'unknown broker apply transaction';
  const heldMs = holder?.startedAt === null || holder?.startedAt === undefined
    ? 0
    : Math.max(0, holder.now() - holder.startedAt);
  try {
    log(`[Arc Power] broker apply transaction wait timed out after ${Math.round(waitedMs)}ms; holder "${holderLabel}" has held the transaction for ${Math.round(heldMs)}ms.`);
  } catch {
    // Diagnostics must not replace the busy error or affect queue recovery.
  }
}

/**
 * Serialize one full broker apply transaction. Standalone Electron and mock
 * runs use this module's process-local FIFO; normal Tauri runs delegate turn
 * ownership to the native host while preserving this async operation context.
 * Callers enter before capability reads/preflight and leave only after the
 * result has updated the broker's session refusal cache. This is distinct from
 * the cross-process Windows mutex: never keep the latter while waiting for a
 * worker process that must acquire it itself. The refusal cache remains
 * broker-owned until its native ownership migration is complete.
 *
 * This gate is deliberately non-reentrant. The direct IPC handler and the
 * profile/boot/tray apply entry points are disjoint roots; nested entry is a
 * programming error that could otherwise deadlock on a FIFO lock.
 * Queued callers wait at most 10 seconds by default; this bound never cancels
 * a transaction that has already become the active holder.
 * @template T
 * @param {() => T|Promise<T>} operation
 * @param {{ label?: string, timeoutMs?: number, pollMs?: number, now?: () => number, sleep?: (ms:number)=>Promise<void>, log?: (message:string)=>void }} [options]
 * @returns {Promise<T>}
 */
export function withBrokerApplyTransaction(operation, options = {}) {
  if (brokerTransactionContext.getStore()) {
    return Promise.reject(new Error('Broker apply transaction is non-reentrant.'));
  }
  const label = typeof options.label === 'string' && options.label.trim()
    ? options.label.trim()
    : 'broker apply transaction';
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, options.timeoutMs)
    : BROKER_APPLY_WAIT_TIMEOUT_MS;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : 25;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((message) => console.warn(message));

  // Normal Tauri runs can delegate FIFO ownership to the native host while
  // keeping the existing broker operation body and refusal-cache publication
  // inside the granted turn. Standalone Electron and mock runs retain this
  // module's local queue.
  if (brokerTransactionDelegate) {
    return brokerTransactionDelegate(
      (sequence) => {
        if (!Number.isSafeInteger(sequence) || sequence <= 0) {
          throw new Error('Native apply transaction returned an invalid sequence.');
        }
        return brokerTransactionContext.run({ sequence, label }, operation);
      },
      { label, timeoutMs, pollMs, now, sleep, log },
    );
  }

  const previous = brokerTransactionQueue;
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  brokerTransactionQueue = previous.then(() => turn);
  const entry = { label, now, startedAt: null };
  const hasEarlierTransaction = brokerTransactionEntries.length > 0;
  const holderAtWaitStart = brokerTransactionHolder
    ?? brokerTransactionEntries[0]
    ?? null;
  brokerTransactionEntries.push(entry);

  return (async () => {
    try {
      if (hasEarlierTransaction) {
        await waitForQueueTurn(previous, { timeoutMs, pollMs, now, sleep }, (waitedMs) => {
          logBrokerWaitTimeout(entry, waitedMs, log, holderAtWaitStart);
        });
      } else {
        await previous;
      }
      if (brokerTransactionSequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error('Broker apply transaction sequence exhausted.');
      }
      brokerTransactionSequence += 1;
      entry.startedAt = now();
      brokerTransactionHolder = entry;
      try {
        return await brokerTransactionContext.run({ sequence: brokerTransactionSequence, label }, operation);
      } finally {
        if (brokerTransactionHolder === entry) brokerTransactionHolder = null;
      }
    } finally {
      removeBrokerEntry(entry);
      release();
    }
  })();
}

/** Install the single native FIFO owner for normal Tauri broker transactions. */
export function setBrokerApplyTransactionDelegate(delegate) {
  if (delegate !== null && typeof delegate !== 'function') {
    throw new TypeError('Broker apply transaction delegate must be a function or null.');
  }
  brokerTransactionDelegate = delegate;
}

/** The monotonically increasing sequence for the currently held broker FIFO turn. */
export function currentBrokerApplyTransactionSequence() {
  return brokerTransactionContext.getStore()?.sequence ?? null;
}

function nativeApi() {
  if (process.platform !== 'win32') return null;
  if (nativeCache !== undefined) return nativeCache;
  try {
    const kernel32 = koffi.load('kernel32.dll');
    nativeCache = {
      create: kernel32.func('void* CreateMutexW(void*, int32, str16)'),
      wait: kernel32.func('uint32 WaitForSingleObject(void*, uint32)'),
      release: kernel32.func('int32 ReleaseMutex(void*)'),
      close: kernel32.func('int32 CloseHandle(void*)'),
    };
  } catch {
    nativeCache = null;
  }
  return nativeCache;
}

/**
 * Acquire the shared apply mutex, run `operation`, and release in `finally`.
 * On non-Windows platforms the lock is a no-op (the product is Windows-only;
 * this keeps plain unit tests portable).
 * @template T
 * @param {() => T|Promise<T>} operation
 * @param {{ timeoutMs?: number, pollMs?: number, now?: () => number, sleep?: (ms:number)=>Promise<void>, api?: object|null }} [options]
 * @returns {Promise<T>}
 */
export async function withApplyLock(operation, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 10_000;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : 25;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (writeLockContext.getStore()) {
    throw new Error('The GPU apply lock is non-reentrant; nested applySettings must use its tuning-transaction token.');
  }
  return runFifo('write', async () => {
    if (process.platform !== 'win32') {
      return writeLockContext.run(true, operation);
    }
    const api = Object.prototype.hasOwnProperty.call(options, 'api') ? options.api : nativeApi();
    if (!api) throw new Error('The GPU apply lock is unavailable on this host.');
    let handle = null;
    let acquired = false;
    try {
      handle = api.create(null, 0, APPLY_MUTEX_NAME);
      if (!handle) throw new Error('Could not create the GPU apply lock.');
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = Number(api.wait(handle, 0));
        if (result === WAIT_OBJECT_0 || result === WAIT_ABANDONED) { acquired = true; break; }
        if (result !== WAIT_TIMEOUT) throw new Error(`GPU apply lock wait failed (0x${result.toString(16)}).`);
        if (Date.now() >= deadline) throw new Error('GPU apply is busy; try again.');
        await sleep(pollMs);
      }
      return await writeLockContext.run(true, operation);
    } finally {
      if (handle) {
        if (acquired) {
          try { api.release(handle); } catch { /* best effort */ }
        }
        try { api.close(handle); } catch { /* best effort */ }
      }
    }
  }, { timeoutMs, pollMs, now, sleep });
}
