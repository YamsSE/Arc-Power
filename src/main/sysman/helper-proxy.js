// Arc Power - M17i/M17m the sysman-helper proxy: the parent-side client of
// the `--sysman-helper-pipe` mode (M17m - the DETACHED machine-level helper).
// The one-shot `--sysman-helper` mode is the dev/verification path and is
// spawned by NO ONE - this proxy always spawns the detached pipe form. The
// M17l stdin form (`--sysman-helper-persist`) was REMOVED in run B of M17m
// (the detached named-pipe transport supersedes it - the M17m premise: the
// helper's ze context must OUTLIVE the app sessions, because a FRESH ze init
// fails for 12-20+ min after an IGCL write elsewhere while an EXISTING
// context writes through the window instantly - the measured 11:26 failure).
// The measured root cause (plan M17i): the sysman consumer's zesInit fails
// with ERROR_UNINITIALIZED ONLY when the IGCL is loaded inside an ELECTRON
// process, so the consumer must run in a dedicated helper process that loads
// ONLY the consumer (no backend, no OldIgcl, no IGCL - the bare-context
// zesInit path).
//
// This proxy mirrors the consumer contract (readLimits/setLimits - the
// runSysmanCompanion + the 'power-limits:read' channel are unchanged) while
// delegating every call to the detached helper over the Windows NAMED PIPE
// (\\.\pipe\arcpower-sysman - node's net):
//   - M17m THE CONNECTION STATE KEYS OFF THE net.Socket LIFECYCLE ONLY
//     (round-1 S2): connect once + keep; the socket 'close' drops the
//     connection + resets the ready state + the next call reconnects. THE
//     DETACHED SPAWNED CHILD's 'exit' (incl. the EADDRINUSE loser of a bind
//     race - an existing helper is alive) is a DEBUG-LOG EVENT, NEVER a
//     socket drop: the child's death surfaces as the socket's 'close' (the
//     server side gone) - the proxy never tears down a live socket because
//     its spawned child happened to exit;
//   - THE CONNECT PATH (round-1 S2) - the warm()'s eager connect: a live
//     machine-level helper (left by a previous app session) is REUSED with
//     NO spawn (the M17m reuse shape); when the connect fails (no helper
//     alive - ECONNREFUSED/ENOENT), the detached helper is spawned (a
//     DIRECT child_process.spawn - NO PowerShell, NO -Verb RunAs - the
//     helper INHERITS the parent's elevation: the packaged EXE's
//     requireAdministrator token / the runas worker's token / the dev
//     tree's unelevated process) and the connect retries in a BOUNDED LOOP
//     (~500 ms interval, ~30 s cap - never a single attempt: a cold spawn
//     can flake on an AV scan/cold disk) + the ONE-TIME leftover sweep of
//     the arcpower-sm-* files at that connect (round-1 N2 - never per
//     call). M17n (round-1 S3): warm() is the ONLY spawn+connect path -
//     the request paths NEVER connect (a no-connection set/read answers
//     the instant not-ready verdict instead);
//   - the FIFO request queue (round-1 N4): one request at a time over the
//     single socket; the { id } matching rides along;
//   - THE KILL-ON-TIMEOUT NEVER APPLIES (round-1 S2): a request timeout
//     degrades ONLY the calling readLimits/setLimits - the helper STAYS
//     alive (it is DETACHED - the proxy has no kill handle by design) and
//     the next call reuses the same connection;
//   - the IN-FLIGHT handling (round-1 N3): the socket's unexpected 'close'
//     mid-request resolves the pending call immediately - never a full
//     timeout - and the next connection comes from the warm() (the request
//     paths never reconnect themselves - M17n);
//   - M17k - the EAGER warm(): an idempotent eager-connect (the same
//     connect path - the FIFO + the buffered-until-ready semantics
//     unchanged; the first readLimits/setLimits rides the ready helper), a
//     warm failure degrades silently (M17n: the not-ready verdicts cover
//     the calls until the next successful warm),
//     the debug log records it via the EXISTING 'connect' event (round-1
//     N2), and the IN-FLIGHT LATCH (round-1 N3): ensureConnected gains a
//     `connecting` promise latch - a warm() racing the first request's lazy
//     connect (or a reconnect) NEVER double-spawns;
//   - the failure degrades (spawn fail / connect sweep fail / timeout /
//     protocol error / connection close) -> readLimits null / setLimits
//     { ok: false, errorCode: 'helper-failed', message } - the honest
//     degrade, never a throw;
//   - M17n THE NO-WAIT APPLY (the user's measured cause: the helper's
//     zesInit NEVER lands in the user's usage pattern - the applies + the
//     boot probes keep the 12-20+ min arbitration window open, and the
//     M17l 25-min HELPER_INIT_WAIT_MS horizon made the apply WAIT for it =
//     'AGES'): THE NOT-READY CALLS ANSWER INSTANTLY. The parser still
//     recognizes the helper's { type: 'ready' } line + tracks the ready
//     state, but NO call ever waits for the ready: the set on a NOT-ready
//     helper returns { ok: false, errorCode: 'not-ready', message: 'the
//     sysman helper is still initializing (the driver arbitration window)
//     - the V2 fallback applies' } IMMEDIATELY (the apply-routing
//     companion's V2-CLAMP trigger), the read answers null immediately
//     when not-ready OR not-connected (round-1 S5 - the read-out renders
//     the session '(set)'/'-' instantly); THE 25-MIN HELPER_INIT_WAIT_MS
//     HORIZON IS DELETED (round-1 N3 - the readiness-wait was the wrong
//     design; the M17l long-horizon timeout wording + the STALE-REQUEST
//     LATE-LANDING set part die with it - a not-ready set never buffers);
//     THE NOT-READY DECISION POINT (round-1 S3): (a) a set/read with NO
//     connection answers instantly WITHOUT the spawn/connect-retry wait
//     (the warm() at boot is the ONLY spawn+connect path - the proxy's
//     request paths never connect); (b) after a connection is established,
//     the not-ready verdict defers ONE EVENT-LOOP TURN / a short bounded
//     grace (NOT_READY_GRACE_MS ~100-250 ms, the injectable sleep) for the
//     ready line - for the SET AND THE READ (round-2 N5 - a fresh-connected
//     ready helper's read is never lost: the ready line is the FIRST line
//     of any connection to an already-ready helper, the grace catches it);
//     the READY helper's round trips keep the 30 s bound (ONE pipe round
//     trip - round-2 N6); the stated consequence: only the first apply in
//     a fresh-connect window may ride the clamp despite a ready helper -
//     the steady-state (warm-connected) session satisfies the exact-value
//     path; THE READY-STATE LIFECYCLE (round-1 S3) unchanged: the ready
//     flag RESETS to false wherever the connection is dropped (the socket
//     'close' + the protocol-error drop); the ready line never resolves a
//     pending call (a call only enqueues after the ready line landed; the
//     id-less late response is still discarded);
//   - M17m THE STDERR CAPTURE IS REMOVED (run B): the spawn's stdio is
//     'ignore' - there are no pipes at all; the helper's diagnostics live
//     in ITS OWN log file (%TEMP%\arcpower-sysman-helper.log - the
//     init-retry lines + the ready/response events + the PID + the init
//     timestamp, round-1 S3) and the proxy's debug log keeps its
//     connect/req/resp/close/child-exit events;
//   - the debug file log STAYS (the verdicts + the spawn/init evidence),
//     extended with the M17m events: { ts, event: 'connect' | 'reconnect' |
//     'req' | 'resp' | 'close' | 'child-exit' | 'child-error', ... } in
//     %TEMP%\arcpower-sysman-debug.log - non-throwing (a log failure never
//     degrades a call), removed along with the debug helper in a future
//     milestone.
//
// The COST (M17n - the honest bounds, round-1 S4): an apply on a NOT-ready
// helper answers INSTANTLY (the set's not-ready verdict + the V2-clamp -
// the apply never waits); an apply on a READY helper = 2 pipe round trips
// (the companion's setLimits + the movement re-read) -> ~1-3 s per apply
// once the helper is warm; the read-out = 1 round trip; the cadence stays
// per-apply/boot only (never per telemetry tick).
//
// Electron-free: the spawn + the sweep + the tempDir + the sleep + the
// connect + the debug-file seams are INJECTED so the whole contract is
// testable under plain node --test.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn as childProcessSpawn } from 'node:child_process';
import { sweepStaleWorkerFiles } from '../elevated-apply.js';
import { SYSMAN_PIPE_NAME } from './helper-mode.js';

// The per-request answer window: the helper's zesInit + the read/write
// round trip take ~1-6 s live (round-1 N3); 30 s covers the slowest legit
// spawn + the init-retry wait (the timeout NEVER kills the helper - the
// init keeps retrying in the background - round-1 S2). M17n: the bound
// applies ONLY to READY-helper round trips (ONE pipe round trip - round-2
// N6) - a not-ready call never enqueues (it answers instantly).
export const HELPER_TIMEOUT_MS = 30000;
// M17n THE NOT-READY VERDICT (round-1 S3 + S6 - the pinned errorCode +
// message): the set on a not-ready helper answers this INSTANTLY - the
// apply-routing companion's V2-CLAMP trigger (the other failure classes
// keep the M17f log-only contract - they are NOT instant).
export const NOT_READY_ERROR_CODE = 'not-ready';
export const NOT_READY_MESSAGE = 'the sysman helper is still initializing (the driver arbitration window) - the V2 fallback applies';
// M17n THE READY-LINE GRACE (round-1 S3 + round-2 N5): after a connection
// is established, the not-ready verdict defers ONE EVENT-LOOP TURN / a
// short bounded grace for the ready line (the ready line is the FIRST line
// of any connection to an already-ready helper - the grace catches it - the
// first set/read on a fresh connection never races the ready line).
export const NOT_READY_GRACE_MS = 200;
// M17m THE BOUNDED CONNECT-RETRY LOOP (round-1 S2 - the post-spawn connect
// is never a single attempt: a cold spawn can flake on an AV scan / cold
// disk): the connect retries at CONNECT_RETRY_INTERVAL_MS until it lands or
// CONNECT_RETRY_CAP_MS expires. 30 s covers an electron boot + the helper's
// listen under a cold-start load.
export const CONNECT_RETRY_INTERVAL_MS = 500;
export const CONNECT_RETRY_CAP_MS = 30000;

/** The default connect seam: node's net.connect to the named pipe. */
const defaultConnect = (pipeName) => new Promise((resolve, reject) => {
  const sock = net.connect({ path: pipeName });
  const onError = (err) => {
    try { sock.destroy(); } catch { /* best effort */ }
    reject(err);
  };
  sock.once('connect', () => {
    sock.removeListener('error', onError);
    resolve(sock);
  });
  sock.once('error', onError);
});

/**
 * Create the sysman-helper proxy.
 * @param {{
 *   execPath?: string,             // our executable (default process.execPath)
 *   appPath?: string | null,       // dev-mode electron app dir (null = packaged EXE)
 *   tempDir?: () => string,        // the shared temp dir (default os.tmpdir)
 *   sweep?: (dir: string) => Promise<number>,  // the ONE-TIME connect sweep
 *   spawnFn?: (cmd: string, args: string[], opts: object) => object, // the spawn seam
 *   connectFn?: (pipeName: string) => Promise<object>,  // M17m the connect seam (default: net.connect)
 *   pipeName?: string,             // M17m the named pipe (default \\.\pipe\arcpower-sysman)
 *   timeoutMs?: number,            // the per-request answer window (default HELPER_TIMEOUT_MS - the 30 s bound, READY round trips only)
 *   readyGraceMs?: number,         // M17n the ready-line grace (default NOT_READY_GRACE_MS - ~100-250 ms)
 *   connectRetryIntervalMs?: number,  // M17m the connect-retry interval (default 500 ms)
 *   connectRetryCapMs?: number,    // M17m the connect-retry cap (default 30 s)
 *   sleep?: (ms: number) => Promise<void>,  // the retry-interval sleep seam
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
  connectFn = defaultConnect,
  pipeName = SYSMAN_PIPE_NAME,
  timeoutMs = HELPER_TIMEOUT_MS,
  readyGraceMs = NOT_READY_GRACE_MS,
  connectRetryIntervalMs = CONNECT_RETRY_INTERVAL_MS,
  connectRetryCapMs = CONNECT_RETRY_CAP_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  debugLogPath = () => path.join(os.tmpdir(), 'arcpower-sysman-debug.log'),
  log = () => {},
} = {}) {
  const spawn = spawnFn;

  /** @type {object | null} */
  // M17m THE CONNECTION STATE KEYS OFF THE net.Socket LIFECYCLE ONLY
  // (round-1 S2): the live socket (null = not connected). The spawned
  // detached child is NOT part of the connection state - its 'exit' is a
  // debug-log event, never a socket drop.
  let socket = null;
  /** @type {boolean} */
  // M17l/M17n THE READY STATE: true once the CURRENT connection's
  // { type: 'ready' } line was recognized (round-1 S3 - it resets wherever
  // the connection is dropped: the socket 'close' + the protocol-error
  // drop). M17n: it gates the call-site decision - a not-ready call
  // answers INSTANTLY (the ready line NEVER resolves a pending call -
  // round-1 S4 - and a call only enqueues after the ready landed).
  let ready = false;
  /** @type {{ id: string, op: string, payload?: object, resolve: Function, timer: NodeJS.Timeout | null } | null} */
  let pending = null;
  /** @type {Array<{ id: string, op: string, payload?: object, resolve: Function }>} */
  const queue = [];
  let swept = false;    // the ONE-time leftover sweep at the first connect
  let connects = 0;     // socket-connect count (connect vs reconnect event)
  let pumping = false;  // the pump re-entrancy guard
  /** @type {number | null} */
  let spawnedPid = null; // the last detached child's pid (the connect-event evidence)
  // M17k (round-1 N3): the IN-FLIGHT connect latch - the connect promise
  // shared by every concurrent ensureConnected caller (a warm() racing the
  // first request's lazy connect or a reconnect). Without it the racers
  // would BOTH pass the `if (socket)` check and double-spawn (and
  // double-connect). The latch is cleared in the finally - a failed
  // connect leaves the next call free to re-attempt.
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
   * M17m THE SOCKET 'close' DROP (round-1 S2): the connection state keys
   * off the net.Socket lifecycle ONLY - a 'close' (the helper exited / the
   * pipe broke) drops the connection + resets the ready state + the next
   * call reconnects. The pending call (if any) resolves IMMEDIATELY
   * (round-1 N3 - never the full timeout). This is the ONLY place the
   * connection state drops on the socket's own lifecycle (the protocol-
   * error and write-failure drops below are proxy-initiated - they destroy
   * the socket first, so the 'close' listener sees socket !== sock and
   * returns).
   */
  const handleDrop = (sock, reason) => {
    if (socket !== sock) return; // a stale close from a superseded socket
    socket = null;
    ready = false;
    const hadPending = pending !== null;
    finishPending(null, reason);
    debugLog({ ts: Date.now(), event: 'close', reason, hadPending });
    pump();
  };

  /**
   * M17m THE DETACHED SPAWNED CHILD's lifecycle (round-1 S2): the child's
   * 'error'/'exit' events are DEBUG-LOG EVENTS, NEVER a socket drop - incl.
   * the EADDRINUSE loser of a bind race (the loser exits 0 because the
   * existing helper is alive; the connect-retry loop then connects to the
   * EXISTING helper). The child's death surfaces as the socket's 'close'
   * (the server side gone) - the socket-keyed drop handles it.
   */
  const handleChildEvent = (event, proc, reason, code, signal) => {
    debugLog({ ts: Date.now(), event, pid: proc?.pid ?? null, reason, code, signal });
  };

  /**
   * One complete JSON line from the helper over the socket. A non-JSON line
   * is a PROTOCOL ERROR: the pending call degrades now + the connection is
   * dropped (the socket is destroyed - the helper itself is NEVER killed: a
   * disconnect never exits the detached helper). A response whose id
   * matches no pending call is discarded (a late answer to a timed-out
   * call - the READ path's late landing - the helper works serially, so no
   * resend is needed).
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
        debugLog({ ts: Date.now(), event: 'resp', id: p.id, op: p.op, spawnError: 'protocol error: non-JSON line', out: null });
        finishPending(null, 'protocol error: the sysman helper emitted a non-JSON line');
      }
      if (socket) {
        // The broken connection is dropped (never a kill - the detached
        // helper is not the proxy's to kill; a disconnect never exits it).
        try { socket.destroy(); } catch { /* best effort */ }
        socket = null;
        // M17l/M17n (round-1 S3): the dropped connection's ready state
        // dies with it (the next connection's calls re-wait its ready
        // line - through the M17n grace only, never a long horizon).
        ready = false;
      }
      pump();
      return;
    }
    // M17l/M17n THE READY-SIGNAL recognition: { type: 'ready' } - the
    // helper's ze init landed (the FIRST line of this connection). It
    // FLIPS the ready state + records the debug 'ready' event (round-1
    // N1); it NEVER resolves a pending call (round-1 S4): a pending call
    // is answered only by its own { id, ... } response. The
    // discrimination is unambiguous: the ready line has no id, and no
    // response shape carries 'type' (incl. the id-less malformed-request
    // refusal).
    if (parsed.type === 'ready') {
      ready = true;
      debugLog({ ts: Date.now(), event: 'ready' });
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
   * Wire the socket listeners of a fresh connection. The lines are buffered
   * across chunk boundaries (a write may split mid-line - only COMPLETE
   * lines are parsed).
   */
  const attachSocket = (sock) => {
    let buf = '';
    try { sock.setEncoding?.('utf8'); } catch { /* best effort */ }
    sock.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim() === '') continue; // a blank line is never a response (any NON-blank non-JSON line is a protocol error)
        handleLine(line);
      }
    });
    // M17m THE SOCKET-KEYED LIFECYCLE (round-1 S2): the 'close' is the
    // single lifecycle drop point (a Windows named-pipe client gets
    // 'error' then 'close' when the server side dies - the error is logged
    // for diagnostics, the close does the drop).
    sock.on('error', (err) => {
      debugLog({ ts: Date.now(), event: 'socket-error', reason: err instanceof Error ? err.message : String(err) });
    });
    sock.on('close', () => handleDrop(sock, 'the sysman helper connection closed (the helper exited or the pipe broke)'));
  };

  /**
   * Wire the detached spawned child: unref() (the child must never keep
   * the parent's event loop alive) + the debug-log-only lifecycle events
   * (round-1 S2 - the child's exit is NEVER a socket drop).
   */
  const attachChild = (proc) => {
    try { proc.unref?.(); } catch { /* best effort */ }
    proc.on('error', (err) => handleChildEvent('child-error', proc, err instanceof Error ? err.message : String(err), null, null));
    proc.on('exit', (code, signal) => handleChildEvent('child-exit', proc, null, code, signal));
  };

  /**
   * Spawn the DETACHED helper (M17m round-1 S3): { detached: true,
   * windowsHide: true, stdio: 'ignore' } + the child's unref() - the
   * helper must outlive this app session and the parent must never wait on
   * it; the pipes are IGNORED (the M17l stderr capture dies with the stdin
   * model - the helper's diagnostics live in its OWN log file). The DIRECT
   * spawn - no PowerShell, no -Verb RunAs: the helper INHERITS the parent
   * token. Dev-tree args `['.', '--sysman-helper-pipe']` with cwd: appPath
   * (the elevated-apply convention - the '.' avoids the space-in-arg
   * quoting trap); the packaged EXE needs no app path (round-1 S4).
   * @returns {Promise<{ ok: boolean, pid?: number | null, reason?: string }>}
   */
  const spawnDetachedHelper = async () => {
    try {
      const proc = await spawn(
        execPath,
        appPath ? ['.', '--sysman-helper-pipe'] : ['--sysman-helper-pipe'],
        appPath ? { cwd: appPath, detached: true, windowsHide: true, stdio: 'ignore' } : { detached: true, windowsHide: true, stdio: 'ignore' },
      );
      attachChild(proc);
      spawnedPid = proc.pid ?? null;
      return { ok: true, pid: proc.pid ?? null };
    } catch (err) {
      log(`spawn failed: ${err.message}`);
      return { ok: false, reason: `the sysman helper could not be spawned (${err.message})` };
    }
  };

  /**
   * The connect (M17m round-1 S2 - the warm()'s path; M17n round-1 S3:
   * this is the ONLY spawn+connect path, the request paths never call
   * it): CONNECTS to the named pipe FIRST - a live machine-level helper
   * is reused with NO spawn (the M17m reuse shape); when the connect
   * fails (no helper alive), the DETACHED helper is spawned ONCE + the
   * connect retries in a BOUNDED LOOP (~500 ms interval, ~30 s cap -
   * never a single attempt). The ONE-TIME leftover sweep of the
   * arcpower-sm-* files runs at the connect (round-1 N2 - never per
   * call; the pipe mode writes no req/tok files, so the sweep is
   * housekeeping for the one-shot leftovers + a crashed parent's
   * orphans). A throwing sweep degrades the connect (never a throw - the
   * M17i never-throw contract). M17k (round-1 N3): the IN-FLIGHT LATCH -
   * concurrent warmers share ONE connect promise and NEVER double-spawn;
   * the latch clears in the finally, so a failed connect leaves the next
   * warm free to re-attempt.
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  const ensureConnected = async () => {
    if (socket) return { ok: true };
    if (connecting) return connecting;
    connecting = (async () => {
      if (socket) return { ok: true }; // a connect landed while we were waiting
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
      // M17m THE BOUNDED CONNECT-RETRY LOOP (round-1 S2): the first connect
      // attempt can fail (no helper alive yet - ECONNREFUSED/ENOENT); the
      // detached helper is spawned ONCE, then the connect retries at
      // ~500 ms until it lands or the ~30 s cap expires (a cold spawn can
      // flake on an AV scan / cold disk). The spawned child's exit is a
      // DEBUG-LOG EVENT (incl. the EADDRINUSE loser: an existing helper is
      // alive - the loop then connects to IT).
      const deadline = Date.now() + connectRetryCapMs;
      let spawned = false;
      let lastReason = 'the connection was not accepted';
      while (Date.now() < deadline) {
        let sock = null;
        try {
          sock = await connectFn(pipeName);
        } catch (err) {
          lastReason = err instanceof Error ? err.message : String(err);
        }
        if (sock) {
          connects += 1;
          debugLog({ ts: Date.now(), event: isReconnect ? 'reconnect' : 'connect', pid: spawnedPid, spawnError: null });
          attachSocket(sock);
          socket = sock;
          return { ok: true };
        }
        if (!spawned) {
          spawned = true;
          const s = await spawnDetachedHelper();
          if (!s.ok) {
            debugLog({ ts: Date.now(), event: isReconnect ? 'reconnect' : 'connect', pid: null, spawnError: s.reason });
            return { ok: false, reason: s.reason };
          }
        }
        await sleep(connectRetryIntervalMs);
      }
      debugLog({ ts: Date.now(), event: isReconnect ? 'reconnect' : 'connect', pid: spawnedPid, spawnError: `no connection within ${connectRetryCapMs} ms (${lastReason})` });
      return { ok: false, reason: `the sysman helper did not accept a connection within ${connectRetryCapMs} ms (${lastReason})` };
    })();
    try {
      return await connecting;
    } finally {
      connecting = null;
    }
  };

  /**
   * The pump: drains the FIFO queue one request at a time. M17n: the proxy
   * NEVER connects from the request path - a call that lost its connection
   * after the call-site gate (the socket dropped before the pump drained
   * it) answers the not-ready verdict INSTANTLY (round-1 S3 - the
   * spawn/connect-retry wait is the warm()'s job only; the apply must
   * NEVER wait).
   */
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length > 0) {
        if (!socket) {
          // M17n THE NOT-READY DRAIN (round-1 S3): no connection -> every
          // queued call answers the not-ready verdict instantly (no
          // spawn/connect-retry wait). The set's not-ready out rides
          // VERBATIM (the same pinned errorCode/message the call-site gate
          // answers); the read degrades to null through the same out.
          while (queue.length > 0) {
            const call = queue.shift();
            debugLog({ ts: Date.now(), event: 'resp', id: call.id, op: call.op, spawnError: NOT_READY_MESSAGE, out: null });
            call.resolve({ out: { ok: false, errorCode: NOT_READY_ERROR_CODE, message: NOT_READY_MESSAGE }, reason: null });
          }
          break;
        }
        if (pending) break; // one request at a time (round-1 N4)
        const call = queue.shift();
        pending = call;
        debugLog({ ts: Date.now(), event: 'req', id: call.id, op: call.op });
        // M17n: THE HORIZON-SELECTION BLOCK IS DELETED (round-1 N3 - the
        // 25-min HELPER_INIT_WAIT_MS is gone; the not-ready calls never
        // enqueue, so the timeout applies ONLY to READY-helper round
        // trips - ONE pipe round trip, the 30 s bound).
        // The timer is assigned BEFORE the write: the timeout must be
        // clearable even when the response lands synchronously inside the
        // write (the injected test fakes answer inline - a timer created
        // after the response could never be cleared and would keep the
        // process alive for the whole bound; the real helper's async pipe
        // answers always arrive after this block).
        call.timer = setTimeout(() => {
          if (pending === call) {
            // The timeout degrades ONLY this call (round-1 S2): the helper
            // is NEVER killed - it may still be inside its init-retry
            // loop, and the next call reuses the same connection.
            pending = null;
            debugLog({ ts: Date.now(), event: 'resp', id: call.id, op: call.op, spawnError: `timeout after ${timeoutMs} ms`, out: null });
            call.resolve({ out: null, reason: `the sysman helper did not answer within ${timeoutMs} ms (the helper is never killed for timing out)` });
            pump();
          }
        }, timeoutMs);
        let wrote = false;
        try {
          socket.write(`${JSON.stringify({ id: call.id, op: call.op, ...call.payload })}\n`);
          wrote = true;
        } catch (err) {
          log(`socket write failed: ${err.message}`);
        }
        if (!wrote) {
          // The connection is gone (it died between the pump and the
          // write) - degrade this call now + drop the connection (the next
          // call reconnects).
          debugLog({ ts: Date.now(), event: 'resp', id: call.id, op: call.op, spawnError: "the sysman helper's socket write failed", out: null });
          finishPending(null, "the sysman helper's socket write failed");
          try { socket.destroy(); } catch { /* best effort */ }
          socket = null;
          ready = false;
          continue;
        }
      }
    } finally {
      pumping = false;
    }
  };

  /** Enqueue one call; the FIFO + the single-socket serialization live here. */
  const enqueue = ({ op, payload }) => new Promise((resolve) => {
    queue.push({ id: randomUUID(), op, payload, resolve });
    pump();
  });

  /**
   * M17n THE NOT-READY DECISION POINT (round-1 S3 + round-2 N5): the gate
   * every setLimits/readLimits call passes BEFORE enqueueing. Returns true
   * when the call may ride the ready round trip:
   *   (a) NO connection (socket null - incl. a warm's in-flight connect) ->
   *       INSTANT not-ready verdict (the spawn/connect-retry wait is the
   *       warm()'s job only - the proxy's request paths NEVER connect);
   *   (b) a connection WITHOUT the ready line -> the not-ready verdict
   *       defers ONE EVENT-LOOP TURN / a short bounded grace
   *       (readyGraceMs ~100-250 ms, the injectable sleep) for the ready
   *       line - the ready line is the FIRST line of any connection to an
   *       already-ready helper, so the grace catches it (a fresh-connected
   *       ready helper's first set/read is never lost); when the grace
   *       expires without the ready line -> the instant not-ready verdict.
   * The 30 s bound then applies ONLY to ready-helper round trips (ONE pipe
   * round trip - round-2 N6).
   * @returns {Promise<boolean>} true = enqueue the round trip; false =
   *   answer the instant not-ready verdict
   */
  const readyGate = async () => {
    if (!socket) return false;
    if (ready) return true;
    await sleep(readyGraceMs);
    return ready && socket !== null;
  };

  return {
    /**
     * M17k: the idempotent EAGER connect - connects to the live helper or
     * spawns the detached helper + lets its ze init run in the background
     * while the app boots (the boot-order fix: the helper must init BEFORE
     * the app's own IGCL activity - the backend load + the caps probes incl.
     * the fan-probe WRITES + the renderer's boot caps fetch - opens the M17j
     * arbitration window, or the init retries INSIDE the window and the
     * first apply times out). M17n (round-1 S3): warm() is the ONLY
     * spawn+connect path - the request paths NEVER connect (a no-connection
     * set/read answers the instant not-ready verdict instead). A warm
     * failure (spawn error / sweep failure / connect-cap expiry) degrades
     * SILENTLY - the not-ready verdicts cover the calls until the next
     * successful warm. The debug log records the warm via the EXISTING
     * 'connect' event (round-1 N2 - the warm's connect is indistinguishable
     * from the connect event's shape, so the verification read is
     * unambiguous); the in-flight latch (round-1 N3) makes a warm racing
     * another warm share ONE connect - NEVER a double-spawn. Never throws.
     * @returns {Promise<void>}
     */
    async warm() {
      await ensureConnected().catch(() => { /* a warm failure degrades silently - the not-ready verdicts cover the calls */ });
    },
    /**
     * M17f (step-4 N2): the deviceId is ACCEPTED for the mock-scoped
     * contract and IGNORED - the consumer is device-agnostic (the real
     * layer resolves the one enumerated card power domain).
     * M17n (round-1 S5 + round-2 N5): a NOT-READY or NOT-CONNECTED read
     * answers NULL IMMEDIATELY (the same ready-line grace as the set) -
     * the read-out renders the session '(set)'/'-' instantly; the boot
     * one-shot + the per-apply refresh never hang; the 30 s bound applies
     * only to ready-helper round trips.
     * @param {number} [deviceId]
     * @returns {Promise<{ sustainedW: number, burstW: number, peakW: number } | null>}
     */
    async readLimits(deviceId) {
      if (!(await readyGate())) return null;
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
     * Write the sustained + burst pair through the detached helper. The
     * helper's errorCode/message ride VERBATIM (round-1 N2 - no remap, or
     * the refused-class taxonomy at apply-routing.js silently degrades to
     * the generic 'failed' note). A failed delegation (spawn fail /
     * connect sweep fail / timeout / protocol error / connection close)
     * answers the honest 'helper-failed' degrade.
     * M17n THE INSTANT NOT-READY (round-1 S3): a set on a NOT-ready or
     * NOT-CONNECTED helper answers { ok: false, errorCode: 'not-ready',
     * message: NOT_READY_MESSAGE } IMMEDIATELY (the ready-line grace
     * first when the connection exists) - the apply NEVER waits; the
     * apply-routing companion's V2-CLAMP fallback triggers on this
     * errorCode ONLY.
     * @param {{ sustainedW: number, burstW: number }} limits
     * @returns {Promise<{ ok: boolean, errorCode?: string, message?: string }>}
     */
    async setLimits({ sustainedW, burstW }) {
      if (!(await readyGate())) {
        debugLog({ ts: Date.now(), event: 'resp', op: 'set', spawnError: NOT_READY_MESSAGE, out: null });
        return { ok: false, errorCode: NOT_READY_ERROR_CODE, message: NOT_READY_MESSAGE };
      }
      const { out, reason } = await enqueue({ op: 'set', payload: { sustainedW, burstW } });
      if (!out) return { ok: false, errorCode: 'helper-failed', message: reason ?? 'the sysman helper produced no result' };
      const result = { ok: out.ok === true };
      if (out.errorCode !== undefined) result.errorCode = out.errorCode;
      if (out.message !== undefined) result.message = out.message;
      return result;
    },
  };
}
