// Arc Power - M17i/M17j the sysman-helper proxy: the parent-side client of
// the `--sysman-helper-persist` mode (M17j - the PERSISTENT helper; the
// one-shot `--sysman-helper` mode is the dev/verification path and is
// spawned by NO ONE - this proxy always spawns the persistent form). The
// measured root cause (plan M17i): the sysman consumer's zesInit fails
// with ERROR_UNINITIALIZED ONLY when the IGCL is loaded inside an ELECTRON
// process, so the consumer must run in a dedicated helper process that
// loads ONLY the consumer (no backend, no OldIgcl, no IGCL - the
// bare-context zesInit path). The M17j arbitration window (a FRESH ze
// init fails for 8+ s after an IGCL write elsewhere, while an EXISTING
// context writes fine) is why the helper is PERSISTENT: its ze context is
// initialized ONCE at start (the retry-until-ready loop rides out the
// window) and survives every later write.
//
// This proxy mirrors the consumer contract (readLimits/setLimits - the
// runSysmanCompanion + the 'power-limits:read' channel are unchanged)
// while delegating every call to the persistent helper over its stdio:
//   - the LAZY connect: the first call spawns the persistent helper (a
//     DIRECT child_process.spawn - NO PowerShell, NO -Verb RunAs - the
//     helper INHERITS the parent's elevation: the packaged EXE's
//     requireAdministrator token / the runas worker's token / the dev
//     tree's unelevated process; only the app-arg/working-dir convention
//     transfers from the elevated-apply runner) + the ONE-TIME leftover
//     sweep of the arcpower-sm-* files at that connect (round-1 N2 -
//     never per call);
//   - the FIFO request queue (round-1 N4): one request at a time over the
//     single pipe; the { id } matching rides along;
//   - THE KILL-ON-TIMEOUT NEVER APPLIES (round-1 S2): a request timeout
//     degrades ONLY the calling readLimits/setLimits - the helper STAYS in
//     its init-retry loop and the next call reuses the same process; a
//     kill happens only on a spawn error or an unexpected exit;
//   - the IN-FLIGHT handling (round-1 N3): an unexpected helper exit
//     mid-request resolves the pending call immediately via the 'exit'
//     event - never a full timeout - and the next call re-spawns;
//   - M17k - the EAGER warm(): an idempotent eager-connect (the same
//     lazy-connect path - the FIFO + the buffered-until-ready semantics
//     unchanged; the first readLimits/setLimits rides the ready helper), a
//     warm failure degrades silently (the next call re-attempts as today),
//     the debug log records it via the EXISTING 'connect' event (round-1
//     N2 - the warm's connect is indistinguishable from the lazy connect's
//     event shape, so the verification read is unambiguous), and the
//     IN-FLIGHT LATCH (round-1 N3): ensureConnected gains a `connecting`
//     promise latch - a warm() racing the first request's lazy connect (or
//     a reconnect) NEVER double-spawns (the second spawn would orphan the
//     first helper, alive until pipe EOF, holding a ze context);
//   - the failure degrades (spawn fail / connect sweep fail / timeout /
//     protocol error / unexpected exit) -> readLimits null / setLimits
//     { ok: false, errorCode: 'helper-failed', message } - the honest
//     degrade, never a throw;
//   - the debug file log STAYS (the verdicts + the spawn/init evidence),
//     extended with the persistent-connect events: { ts, event: 'connect'
//     | 'reconnect' | 'req' | 'resp' | 'exit', ... } in %TEMP%\
//     arcpower-sysman-debug.log - non-throwing (a log failure never
//     degrades a call), removed along with the debug helper in a future
//     milestone.
//
// The COST: an apply = 2 round trips (the companion's setLimits + the
// movement re-read) -> ~1-3 s per apply once the helper is warm; the
// read-out = 1 round trip; the cadence stays per-apply/boot only (never
// per telemetry tick).
//
// Electron-free: the spawn + the sweep + the tempDir + the sleep + the
// debug-file seams are INJECTED so the whole contract is testable under
// plain node --test.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as childProcessSpawn } from 'node:child_process';
import { sweepStaleWorkerFiles } from '../elevated-apply.js';

// The per-request answer window: the helper's zesInit + the read/write
// round trip take ~1-6 s live (round-1 N3); 30 s covers the slowest legit
// spawn + the init-retry wait (the timeout NEVER kills the helper - the
// init keeps retrying in the background - round-1 S2).
export const HELPER_TIMEOUT_MS = 30000;
// A short settle delay before re-spawning after an unexpected exit (the
// old process's pipe handles must be released - the injectable sleep
// seam makes the reconnect deterministic under test).
const RECONNECT_BACKOFF_MS = 200;

/**
 * Create the sysman-helper proxy.
 * @param {{
 *   execPath?: string,             // our executable (default process.execPath)
 *   appPath?: string | null,       // dev-mode electron app dir (null = packaged EXE)
 *   tempDir?: () => string,        // the shared temp dir (default os.tmpdir)
 *   sweep?: (dir: string) => Promise<number>,  // the ONE-TIME connect sweep
 *   spawnFn?: (cmd: string, args: string[], opts: object) => object, // the spawn seam
 *   timeoutMs?: number,            // the per-request answer window (default HELPER_TIMEOUT_MS)
 *   sleep?: (ms: number) => Promise<void>,  // the reconnect backoff sleep seam
 *   debugLogPath?: () => string,   // the debug file (default %TEMP%\arcpower-sysman-debug.log)
 *   log?: (s: string) => void,
 * }} deps
 */
export function createSysmanHelperProxy({
  execPath = process.execPath,
  appPath = null,
  tempDir = () => os.tmpdir(),
  sweep = sweepStaleWorkerFiles,
  spawnFn = childProcessSpawn,
  timeoutMs = HELPER_TIMEOUT_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  debugLogPath = () => path.join(os.tmpdir(), 'arcpower-sysman-debug.log'),
  log = () => {},
} = {}) {
  const spawn = spawnFn;

  /** @type {object | null} */
  let child = null;
  /** @type {{ id: string, op: string, payload?: object, resolve: Function, timer: NodeJS.Timeout | null } | null} */
  let pending = null;
  /** @type {Array<{ id: string, op: string, payload?: object, resolve: Function }>} */
  const queue = [];
  let swept = false;    // the ONE-time leftover sweep at the first connect
  let connects = 0;     // connect count (connect vs reconnect event)
  let lastExitAt = 0;   // the reconnect backoff anchor
  let pumping = false;  // the pump re-entrancy guard
  // M17k (round-1 N3): the IN-FLIGHT connect latch - the connect promise
  // shared by every concurrent ensureConnected caller (a warm() racing the
  // first request's lazy connect or a reconnect). Without it the racers
  // would BOTH pass the `if (child)` check and double-spawn - the second
  // spawn would orphan the first helper (alive until pipe EOF, holding a
  // ze context). The latch is cleared in the finally - a failed connect
  // leaves the next call free to re-attempt.
  let connecting = null;

  // The debug file log (M17i - the packaged app's console is invisible,
  // the proxy's verdicts must be diagnosable on the user's machine):
  // ONE line per event, non-throwing (a log failure never degrades a call),
  // removed along with the debug helper in a future milestone.
  const debugLog = (event) => {
    try {
      fs.appendFileSync(debugLogPath(), `${JSON.stringify(event)}\n`, 'utf8');
    } catch { /* best effort */ }
  };

  const finishPending = (out, reason) => {
    const p = pending;
    if (!p) return;
    pending = null;
    if (p.timer) clearTimeout(p.timer);
    p.resolve({ out, reason });
  };

  /**
   * A helper exit / error / protocol failure: the pending call (if any)
   * resolves IMMEDIATELY (round-1 N3 - never the full timeout), the child
   * is dropped (the next call re-spawns; the helper is NEVER killed for a
   * timeout, only for a spawn error or an unexpected exit).
   */
  const handleExit = (proc, reason) => {
    if (child !== proc) return; // a stale event from a superseded helper
    child = null;
    lastExitAt = Date.now();
    const hadPending = pending !== null;
    finishPending(null, reason);
    debugLog({ ts: Date.now(), event: 'exit', pid: proc.pid ?? null, reason, hadPending });
    pump();
  };

  /**
   * One complete JSON line from the helper's stdout. A non-JSON line is a
   * PROTOCOL ERROR: the pending call degrades now + the helper is dropped
   * (its stdin is ended - the helper's own EOF-exit contract; a kill is
   * never used here). A response whose id matches no pending call is
   * discarded (a late answer to a timed-out call - the helper works
   * serially, so no resend is needed).
   */
  const handleLine = (line) => {
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') {
      const p = pending;
      if (p) {
        debugLog({ ts: Date.now(), event: 'resp', id: p.id, op: p.op, spawnError: 'protocol error: non-JSON stdout line', out: null });
        finishPending(null, 'protocol error: the sysman helper emitted a non-JSON stdout line');
      }
      if (child) {
        // Graceful shutdown of the broken helper (its EOF-exit contract) -
        // never a kill.
        try { child.stdin.end(); } catch { /* best effort */ }
        child = null;
        lastExitAt = Date.now();
      }
      pump();
      return;
    }
    if (pending && parsed.id === pending.id) {
      const p = pending;
      debugLog({ ts: Date.now(), event: 'resp', id: p.id, op: p.op, spawnError: null, out: parsed });
      finishPending(parsed, null);
      pump();
      return;
    }
    log(`discarding a response with no matching pending id: ${JSON.stringify(parsed).slice(0, 160)}`);
  };

  /**
   * Wire the stdio listeners of a freshly spawned helper. The stdout lines
   * are buffered across chunk boundaries (a write may split mid-line - only
   * COMPLETE lines are parsed).
   */
  const attachChild = (proc) => {
    let buf = '';
    proc.stdin.on('error', () => { /* a dead helper's stdin EPIPE is handled by the exit event */ });
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim() === '') continue; // electron emits a blank \r\n on stdout at startup - a blank line is never a response (any NON-blank non-JSON line is a protocol error)
        handleLine(line);
      }
    });
    proc.on('error', (err) => handleExit(proc, `the sysman helper failed to start (${err instanceof Error ? err.message : String(err)})`));
    proc.on('exit', (code, signal) => handleExit(proc, `the sysman helper exited unexpectedly (${signal ? `signal ${signal}` : `code ${code}`})`));
  };

  /**
   * The lazy connect: spawn the persistent helper on the first call after
   * an exit (the ONE-TIME leftover sweep of the arcpower-sm-* files runs
   * at the connect - round-1 N2 - never per call; the M17j persistent mode
   * writes no req/tok files, so the sweep is housekeeping for the one-shot
   * leftovers + a crashed parent's orphans). A throwing sweep degrades the
   * connect (never a throw - the M17i never-throw contract). M17k
   * (round-1 N3): the IN-FLIGHT LATCH - concurrent callers (a warm()
   * racing the first request's lazy connect, or a reconnect) share ONE
   * connect promise and NEVER double-spawn; the latch clears in the
   * finally, so a failed connect leaves the next call free to re-attempt.
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  const ensureConnected = async () => {
    if (child) return { ok: true };
    if (connecting) return connecting;
    connecting = (async () => {
      if (child) return { ok: true }; // a connect landed while we were waiting
      if (lastExitAt > 0) {
        const wait = RECONNECT_BACKOFF_MS - (Date.now() - lastExitAt);
        if (wait > 0) await sleep(wait);
      }
      const dir = tempDir();
      try {
        if (!swept) {
          await sweep(dir);
          swept = true;
        }
      } catch (err) {
        log(`pre-connect sweep failed: ${err.message}`);
        return { ok: false, reason: `the sysman helper could not be started (the leftover sweep failed: ${err.message})` };
      }
      const isReconnect = connects > 0;
      let proc = null;
      try {
        // The DIRECT spawn - no PowerShell, no -Verb RunAs: the helper
        // INHERITS the parent token. Dev-tree args `['.', '--sysman-helper-
        // persist']` with cwd: appPath (the elevated-apply convention - the
        // '.' avoids the space-in-arg quoting trap); the packaged EXE needs
        // no app path (round-1 S4). stdio: stdin/stdout pipes (the JSON-line
        // protocol) + stderr INHERITED (the helper's init-retry logs go to
        // the parent's console).
        proc = await spawn(
          execPath,
          appPath ? ['.', '--sysman-helper-persist'] : ['--sysman-helper-persist'],
          appPath ? { cwd: appPath, windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] } : { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] },
        );
      } catch (err) {
        log(`spawn failed: ${err.message}`);
        debugLog({ ts: Date.now(), event: isReconnect ? 'reconnect' : 'connect', spawnError: err.message });
        return { ok: false, reason: `the sysman helper could not be spawned (${err.message})` };
      }
      connects += 1;
      debugLog({ ts: Date.now(), event: isReconnect ? 'reconnect' : 'connect', pid: proc.pid ?? null, spawnError: null });
      attachChild(proc);
      child = proc;
      return { ok: true };
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  };

  /**
   * The pump: drains the FIFO queue one request at a time. A dead child is
   * (re)connected lazily; a failed connect degrades every queued call
   * honestly.
   */
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        if (!child) {
          const c = await ensureConnected();
          if (!c.ok) {
            while (queue.length > 0) {
              const call = queue.shift();
              debugLog({ ts: Date.now(), event: 'resp', id: call.id, op: call.op, spawnError: c.reason, out: null });
              call.resolve({ out: null, reason: c.reason });
            }
            break;
          }
        }
        if (pending) break; // one request at a time (round-1 N4)
        const call = queue.shift();
        pending = call;
        debugLog({ ts: Date.now(), event: 'req', id: call.id, op: call.op });
        let wrote = false;
        try {
          child.stdin.write(`${JSON.stringify({ id: call.id, op: call.op, ...call.payload })}\n`);
          wrote = true;
        } catch (err) {
          log(`stdin write failed: ${err.message}`);
        }
        if (!wrote) {
          // The helper's pipe is gone (it died between the pump and the
          // write) - degrade this call now + drop the child (the next call
          // re-spawns).
          finishPending(null, "the sysman helper's stdin write failed");
          child = null;
          lastExitAt = Date.now();
          continue;
        }
        call.timer = setTimeout(() => {
          if (pending === call) {
            // The timeout degrades ONLY this call (round-1 S2): the helper
            // is NEVER killed - it may still be inside its init-retry
            // loop, and the next call reuses the same process.
            pending = null;
            debugLog({ ts: Date.now(), event: 'resp', id: call.id, op: call.op, spawnError: `timeout after ${timeoutMs} ms`, out: null });
            call.resolve({ out: null, reason: `the sysman helper did not answer within ${timeoutMs} ms (the helper is never killed for timing out)` });
            pump();
          }
        }, timeoutMs);
      }
    } finally {
      pumping = false;
    }
  };

  /** Enqueue one call; the FIFO + the single-pipe serialization live here. */
  const enqueue = ({ op, payload }) => new Promise((resolve) => {
    queue.push({ id: randomUUID(), op, payload, resolve });
    pump();
  });

  return {
    /**
     * M17k: the idempotent EAGER connect - spawns the persistent helper +
     * lets its ze init run in the background while the app boots (the
     * boot-order fix: the helper must spawn + init BEFORE the app's own
     * IGCL activity - the backend load + the caps probes incl. the
     * fan-probe WRITES + the renderer's boot caps fetch - opens the M17j
     * arbitration window, or the init retries INSIDE the window and the
     * first apply times out). The SAME lazy-connect path (the FIFO + the
     * buffered-until-ready semantics unchanged - the first
     * readLimits/setLimits rides the ready helper); a warm failure (spawn
     * error / sweep failure) degrades SILENTLY - the next call re-attempts
     * the connect exactly as today. The debug log records the warm via the
     * EXISTING 'connect' event (round-1 N2 - the warm's connect is
     * indistinguishable from the lazy connect's event shape, so the
     * verification read is unambiguous); the in-flight latch (round-1 N3)
     * makes a warm racing the first request's lazy connect (or a
     * reconnect) share ONE connect - NEVER a double-spawn. Never throws.
     * @returns {Promise<void>}
     */
    async warm() {
      await ensureConnected().catch(() => { /* a warm failure degrades silently - the next call re-attempts as today */ });
    },
    /**
     * M17f (step-4 N2): the deviceId is ACCEPTED for the mock-scoped
     * contract and IGNORED - the consumer is device-agnostic (the real
     * layer resolves the one enumerated card power domain).
     * @param {number} [deviceId]
     * @returns {Promise<{ sustainedW: number, burstW: number, peakW: number } | null>}
     */
    async readLimits(deviceId) {
      const { out } = await enqueue({ op: 'read' });
      if (out?.ok === true
        && typeof out.sustainedW === 'number'
        && typeof out.burstW === 'number'
        && typeof out.peakW === 'number') {
        return { sustainedW: out.sustainedW, burstW: out.burstW, peakW: out.peakW };
      }
      return null;
    },
    /**
     * Write the sustained + burst pair through the persistent helper. The
     * helper's errorCode/message ride VERBATIM (round-1 N2 - no remap, or
     * the refused-class taxonomy at apply-routing.js silently degrades to
     * the generic 'failed' note). A failed delegation (spawn fail /
     * connect sweep fail / timeout / protocol error / unexpected exit)
     * answers the honest 'helper-failed' degrade.
     * @param {{ sustainedW: number, burstW: number }} limits
     * @returns {Promise<{ ok: boolean, errorCode?: string, message?: string }>}
     */
    async setLimits({ sustainedW, burstW }) {
      const { out, reason } = await enqueue({ op: 'set', payload: { sustainedW, burstW } });
      if (!out) return { ok: false, errorCode: 'helper-failed', message: reason ?? 'the sysman helper produced no result' };
      const result = { ok: out.ok === true };
      if (out.errorCode !== undefined) result.errorCode = out.errorCode;
      if (out.message !== undefined) result.message = out.message;
      return result;
    },
  };
}
