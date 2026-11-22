// The Display transaction lock is shared with the Tauri host. Keep this
// separate from GPU tuning: display reads may persist scaling reconciliation
// state, and display applies include a driver write plus its saved selector.
import koffi from 'koffi';

export const DISPLAY_MUTEX_NAME = 'Local\\ArcPower-Display-v1';
export const WAIT_OBJECT_0 = 0;
export const WAIT_ABANDONED = 0x80;
export const WAIT_TIMEOUT = 0x102;

let nativeCache;
let displayQueue = Promise.resolve();

async function serializeInProcess(operation, timeoutMs) {
  const previous = displayQueue;
  let release;
  const turn = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => turn);
  displayQueue = queued;
  let timer;
  const ready = await Promise.race([
    previous.then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
  ]);
  clearTimeout(timer);
  if (!ready) {
    // Keep the queue chain healthy, but mark this request as cancelled before
    // it reaches the front so a late previous completion cannot run it.
    void previous.finally(release);
    throw new Error('Display is busy; try again.');
  }
  try {
    return await operation();
  } finally {
    release();
    if (displayQueue === queued) displayQueue = Promise.resolve();
  }
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
 * Serialize a complete Display read or apply against the native Tauri host.
 * Windows owns abandoned mutexes, so a crashed process cannot strand Display.
 * Non-Windows execution is a no-op for portable unit tests.
 * @template T
 * @param {() => T|Promise<T>} operation
 * @param {{ timeoutMs?: number, pollMs?: number, sleep?: (ms:number)=>Promise<void>, api?: object|null }} [options]
 * @returns {Promise<T>}
 */
export async function withDisplayLock(operation, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 10_000;
  const pollMs = Number.isFinite(options.pollMs) ? Math.max(1, options.pollMs) : 25;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  return serializeInProcess(async () => {
    if ((options.platform ?? process.platform) !== 'win32') return operation();
    const api = Object.prototype.hasOwnProperty.call(options, 'api') ? options.api : nativeApi();
    if (!api) throw new Error('The Display transaction lock is unavailable on this host.');
    let handle = null;
    let acquired = false;
    try {
      handle = api.create(null, 0, DISPLAY_MUTEX_NAME);
      if (!handle) throw new Error('Could not create the Display transaction lock.');
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const result = Number(api.wait(handle, 0));
        if (result === WAIT_OBJECT_0 || result === WAIT_ABANDONED) { acquired = true; break; }
        if (result !== WAIT_TIMEOUT) throw new Error(`Display transaction lock wait failed (0x${result.toString(16)}).`);
        if (Date.now() >= deadline) throw new Error('Display is busy; try again.');
        // Never block Node's event-loop thread here. Another async Display
        // operation (or the worker completion that releases its mutex) needs
        // that same thread to make progress.
        await sleep(pollMs);
      }
      return await operation();
    } finally {
      if (handle) {
        if (acquired) {
          try { api.release(handle); } catch { /* best effort */ }
        }
        try { api.close(handle); } catch { /* best effort */ }
      }
    }
  }, timeoutMs);
}
