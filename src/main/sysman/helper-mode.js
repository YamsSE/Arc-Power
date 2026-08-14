// Arc Power - M17i/M17m the sysman-helper modes: the dedicated IGCL-free
// process for the sysman power-limits consumer. The measured root cause
// (plan M17i): the consumer's zesInit fails with ERROR_UNINITIALIZED ONLY
// when the IGCL is loaded inside an ELECTRON process - the packaged app
// (requireAdministrator) runs its applies in-process = electron + IGCL =
// the poisoned combo. The consumer therefore runs HERE, in a process that
// loads ONLY the consumer (NO backend, NO OldIgcl, NO IGCL - the
// bare-context zesInit path, proven by the M17i diagnostic ladder).
//
// TWO forms share this module (the M17j/M17l PERSISTENT stdin form
// `--sysman-helper-persist` was REMOVED in M17m run B - the detached pipe
// form supersedes it: the helper's ze context must OUTLIVE the app
// sessions, because a FRESH ze init fails for 12-20+ min after an IGCL
// write elsewhere while an EXISTING context writes through the window
// instantly):
//
// 1. The M17i ONE-SHOT form (`--sysman-helper <reqFile> <outFile>`): the
//    parent's proxy (helper-proxy.js) writes the request + the
//    parent-owned token, spawns this mode directly (the helper INHERITS
//    the parent's elevation) and polls the out file.
//    Contract:
//      request file  (JSON): { id, op: 'read' } | { id, op: 'set',
//                              sustainedW, burstW }
//      token file    (JSON): { requestId, expiresAt } - written by the
//                              parent BEFORE the request file; the
//                              parent-owned timeout marker the stale-token
//                              guard keys off.
//      result file   (JSON): { id, ok: true, sustainedW?, burstW?, peakW? }
//                             | { id, ok: false, errorCode?, message? }
//      - all three files are keyed by the SAME id (arcpower-sm-req-<id> /
//        arcpower-sm-tok-<id> / arcpower-sm-out-<id>.json);
//      - the result file is ALWAYS written before exiting (even for a
//        refusal - the parent polls the out file, never the exit code);
//      - exit 0 = the dispatch ran + the result written (a consumer
//        failure is still a written honest result); exit 1 = the request
//        could not be honored at all (unreadable / unknown op / stale
//        token).
//
// 2. The M17m PIPE form (`--sysman-helper-pipe`, no args): the DETACHED
//    machine-level helper. The same IGCL-free consumer + the same
//    retry-until-ready ze init, but the transport is a Windows NAMED PIPE
//    (\\.\pipe\arcpower-sysman, node's net) and the lifecycle is detached:
//    a client disconnect NEVER exits the helper (the M17l stdin-EOF exit
//    is NOT in this mode) - the in-flight dispatch completes, the
//    connection's buffered queue is dropped. It exits only on the IDLE
//    TIMEOUT (round-2 S1: the timer is ARMED ONLY WHILE NO CONNECTION IS
//    OPEN - cancelled on every connection-open, re-armed at the full
//    value on every connection-close; a HELD-OPEN connection keeps the
//    helper alive INDEFINITELY; the constant is HELPER-SIDE + injectable,
//    RID_SYSMAN_HELPER_IDLE_MS, default 60 min) or on the BIND CONFLICT
//    (a second helper's EADDRINUSE -> exit 0 - the existing helper is
//    alive). THE PER-CONNECTION READY SEMANTICS (round-1 S1): the ze init
//    is GLOBAL (once); a NEW connection to an already-ready helper
//    receives { type: 'ready' } as its FIRST line, immediately; a
//    connection to an initializing helper has its requests BUFFERED
//    PER-CONNECTION and receives the ready line when the global init
//    lands (before its buffered responses); the ready line is sent AT
//    MOST ONCE PER CONNECTION. THE DISPATCH IS GLOBALLY SERIALIZED (the
//    single ze context - the inFlight serialization of the stdin form
//    carries over); the responses route to the requesting connection
//    ({ id } per-connection routing). THE HELPER'S OWN LOG FILE (round-1
//    S3): %TEMP%\arcpower-sysman-helper.log - the init-retry lines + the
//    ready/response events + the PID + the init timestamp (the
//    same-helper assertion surface), non-throwing.
//
// Electron-free: the consumer is INJECTED (the seam that makes the whole
// contract testable under plain node --test - main.js wires the real
// createSysmanPowerLimits({})).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { findStaleSiblingToken } from '../apply-worker.js';

/**
 * The M17j init-retry backoff: ~2 s between ze-init attempts (the
 * arbitration window eventually closes - the measured dev-box evidence: the
 * window closed within minutes; the retries are logged to STDERR).
 */
export const INIT_RETRY_BACKOFF_MS = 2000;

/**
 * M17m the named-pipe transport: \\.\pipe\arcpower-sysman (node's net).
 * The detached helper's listening endpoint - the app's proxy connects
 * here, and the helper's ze context (init'd when the machine was idle)
 * outlives the app sessions (the M17m premise: an EXISTING context
 * writes through the 12-20+ min arbitration window; a FRESH init cannot).
 */
export const SYSMAN_PIPE_NAME = '\\\\.\\pipe\\arcpower-sysman';

/**
 * M17m the idle-timeout constant (round-2 S1): the helper exits after
 * HELPER_IDLE_MS without any open connection. THE IDLE TIMER IS ARMED
 * ONLY WHILE NO CONNECTION IS OPEN: cancelled on every connection-open,
 * (re)armed at the full value on every connection-close; a HELD-OPEN
 * connection keeps the helper alive INDEFINITELY (the 'no connection'
 * exit condition means ZERO open connections, never zero open/close
 * events - a timer firing mid-session would exit the helper inside an
 * open arbitration window). The constant is HELPER-SIDE + injectable:
 * the env override RID_SYSMAN_HELPER_IDLE_MS (round-1 S4).
 */
export const HELPER_IDLE_MS = 60 * 60 * 1000;
export const HELPER_IDLE_MS_ENV = 'RID_SYSMAN_HELPER_IDLE_MS';

/**
 * M17m the helper's own log file (round-1 S3): %TEMP%\
 * arcpower-sysman-helper.log. The diagnostic channel moves INTO the
 * helper (the proxy-side stderr capture dies with the stdin model in run
 * B); the log carries the init-retry lines + the ready/response events +
 * the PID + the init timestamp - the same-helper assertion surface
 * (round-1 S4: the PID + the initTs are UNCHANGED across the app
 * sessions).
 */
export function defaultHelperLogFilePath() {
  return path.join(os.tmpdir(), 'arcpower-sysman-helper.log');
}

/**
 * M17m the helper's log writer: a NON-THROWING append-only file writer.
 * Every line: `[<pid>] <ISO timestamp> <message>` - the PID + the
 * timestamp prefix make the file the same-helper assertion surface.
 */
export function createSysmanHelperLogFileWriter(logFilePath = defaultHelperLogFilePath()) {
  return (message) => {
    try {
      fs.appendFileSync(logFilePath, `[${process.pid}] ${new Date().toISOString()} ${message}\n`, 'utf8');
    } catch {
      // The log is best-effort - never throw (round-1 S3: non-throwing).
    }
  };
}

/** The RID_SYSMAN_HELPER_IDLE_MS env override (round-1 S4), or null. */
function idleMsFromEnv() {
  const raw = process.env[HELPER_IDLE_MS_ENV];
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The SHARED request dispatch (both forms): the consumer call + the honest
 * result mapping. The one-shot form writes the payload to the out file;
 * the pipe form writes it as a JSON line on the connection - the payload
 * shape is IDENTICAL so the proxy's consumer contract never diverges.
 * @param {{ id?: string, op?: string, sustainedW?: unknown, burstW?: unknown }} req
 * @param {{
 *   readLimits: (deviceId?: number) => object | null | Promise<object | null>,
 *   setLimits: ({ sustainedW: number, burstW: number }) => object | Promise<object>,
 * }} consumer
 * @param {(s: string) => void} log
 * @returns {Promise<{ payload: object, exitCode: number }>}
 */
async function dispatchRequest(req, consumer, log) {
  const op = req?.op;
  if (op === 'read') {
    // The read dispatch: readLimits -> { ok: true, sustainedW?, burstW?,
    // peakW? } | { ok: false, errorCode?, message? } - a null read (the
    // consumer's honest degrade) becomes the unavailable refusal.
    let limits = null;
    try {
      limits = await consumer.readLimits();
    } catch (err) {
      log(`readLimits failed: ${err.message}`);
    }
    if (limits && typeof limits === 'object') {
      return { payload: { ok: true, ...limits }, exitCode: 0 };
    }
    return { payload: { ok: false, errorCode: 'unavailable', message: 'the sysman power-limits read returned no limits (the consumer is unavailable)' }, exitCode: 0 };
  }

  if (op === 'set') {
    // The set dispatch: the setLimits result rides VERBATIM (round-1 N2) -
    // the consumer's errorCode/message are never remapped (the
    // refused-class taxonomy at apply-routing.js keys on the exact codes).
    // Step-5 N2: the pair is finite-guarded BEFORE the call (a garbage
    // payload would otherwise reach the consumer's own invalid-argument
    // path - defensive, unreachable in practice: the proxy builds the req).
    const sustainedW = req.sustainedW;
    const burstW = req.burstW;
    if (!Number.isFinite(sustainedW) || !Number.isFinite(burstW)) {
      return { payload: { ok: false, errorCode: 'invalid-argument', message: 'sustainedW and burstW must be finite numbers' }, exitCode: 1 };
    }
    let result = null;
    try {
      result = await consumer.setLimits({ sustainedW, burstW });
    } catch (err) {
      log(`setLimits failed: ${err.message}`);
      result = { ok: false, errorCode: 'io-failed', message: err.message };
    }
    if (!result || typeof result !== 'object') {
      result = { ok: false, errorCode: 'io-failed', message: 'the setLimits call returned no result' };
    }
    return { payload: result, exitCode: 0 };
  }

  return { payload: { ok: false, errorCode: 'invalid-op', message: `invalid request: unknown op '${String(op)}'` }, exitCode: 1 };
}

/**
 * Run one sysman-helper request and exit.
 * @param {{
 *   reqPath: string,
 *   outPath: string,
 *   consumer: {
 *     readLimits: (deviceId?: number) => { sustainedW: number, burstW: number, peakW: number } | null | Promise<...>,
 *     setLimits: ({ sustainedW: number, burstW: number }) => { ok: boolean, errorCode?: string, message?: string } | Promise<...>,
 *   },
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<number>} process exit code (0 = dispatch ran + result written)
 */
export async function runSysmanHelperMode({ reqPath, outPath, consumer, log = () => {} }) {
  const reqBaseName = path.basename(reqPath);
  const reqNameMatch = reqBaseName.match(/^arcpower-sm-req-(.+)\.json$/);
  let req = null;
  try {
    const raw = await fs.promises.readFile(reqPath, 'utf8');
    req = JSON.parse(raw);
  } catch (err) {
    log(`request unreadable: ${err.message}`);
    await writeOut(outPath, { ok: false, errorCode: 'request-unreadable', message: `request unreadable: ${err.message}` }, reqNameMatch ? reqNameMatch[1] : null);
    return 1;
  }
  const id = typeof req?.id === 'string' && req.id !== '' ? req.id : (reqNameMatch ? reqNameMatch[1] : null);
  const op = req?.op;

  // M17i stale-token guard (the findStaleSiblingToken pattern,
  // apply-worker.js:99-114): the parent writes the arcpower-sm-tok-<id>
  // token with an expiry BEFORE spawning; an already-expired token FOR THIS
  // id means the parent gave up (timeout/crash) before this helper started
  // - refuse so a late write can never land after the parent reported a
  // failure. The id is derived from the request content or, failing that,
  // the request filename (arcpower-sm-req-<id>.json).
  const staleToken = await findStaleSiblingToken(path.dirname(reqPath), id, Date.now(), 'arcpower-sm-tok-');
  if (staleToken) {
    log(`refusing to run: stale parent token ${path.basename(staleToken)} (the parent gave up)`);
    await writeOut(outPath, { ok: false, errorCode: 'superseded', message: 'request superseded: the parent process gave up before this helper started' }, id);
    return 1;
  }

  // The shared dispatch (both helper forms - the pipe mode reuses the exact
  // same request handling + result mapping).
  const { payload, exitCode } = await dispatchRequest(req, consumer, log);
  await writeOut(outPath, payload, id);
  return exitCode;
}

/**
 * Write the result file (atomic-ish: the write AFTER the dispatch - the
 * parent polls the file, so it must never observe a placeholder).
 */
async function writeOut(outPath, payload, id) {
  try {
    await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  } catch { /* dir exists */ }
  const body = typeof id === 'string' && id !== '' ? { id, ...payload } : payload;
  await fs.promises.writeFile(outPath, JSON.stringify(body), 'utf8');
}

/**
 * M17m the DETACHED PIPE sysman-helper mode: the machine-level helper
 * that outlives the app sessions. The same IGCL-free consumer + the same
 * retry-until-ready ze init as the one-shot form, but the transport is
 * a Windows named pipe (\\\\.\\pipe\\arcpower-sysman - node's net) and
 * the lifecycle is detached: a client disconnect NEVER exits the helper
 * (the M17l stdin-EOF exit was REMOVED in run B along with the stdin
 * form) - the in-flight dispatch
 * completes, the connection's buffered queue is dropped. The helper exits
 * only on the IDLE TIMEOUT (round-2 S1: the timer is ARMED ONLY WHILE NO
 * CONNECTION IS OPEN - cancelled on every connection-open, re-armed at
 * the full value on every connection-close; a HELD-OPEN connection keeps
 * the helper alive INDEFINITELY; the env override
 * RID_SYSMAN_HELPER_IDLE_MS, default HELPER_IDLE_MS = 60 min) or on the
 * BIND CONFLICT (a second helper's EADDRINUSE -> exit 0 - the existing
 * helper is alive, the proxy retries the connect).
 *
 * THE PER-CONNECTION READY SEMANTICS (round-1 S1): the ze init is GLOBAL
 * (once - the retry-until-ready loop); a NEW connection to an
 * already-ready helper receives { type: 'ready' } as its FIRST line,
 * immediately (the write happens synchronously inside the connection
 * handler); a connection to an initializing helper has its requests
 * BUFFERED PER-CONNECTION and receives the ready line when the global
 * init lands (before its buffered responses); the ready line is sent AT
 * MOST ONCE PER CONNECTION (the readySent flag per connection). THE
 * DISPATCH IS GLOBALLY SERIALIZED (the single ze context - the removed
 * stdin form's inFlight serialization carries over; one dispatch at a time
 * across ALL connections, FIFO in arrival order); the responses route to
 * the requesting connection ({ id } per-connection routing).
 *
 * THE HELPER'S OWN LOG FILE (round-1 S3): the default log is a
 * NON-THROWING append-only writer to %TEMP%\arcpower-sysman-helper.log -
 * the init-retry lines + the ready/response events + the PID + the init
 * timestamp (the same-helper assertion surface). The pipe-mode caller
 * (main.js) pins the consumer's log to the same file.
 *
 * The init retry creates a FRESH consumer per attempt (the real
 * createSysmanPowerLimits LATCHES its degrade - a failed ze init stays
 * unavailable on that instance, so a retry must be a new instance).
 *
 * @param {{
 *   createConsumer: () => {
 *     readLimits: (deviceId?: number) => { sustainedW: number, burstW: number, peakW: number } | null | Promise<...>,
 *     setLimits: ({ sustainedW: number, burstW: number }) => { ok: boolean, errorCode?: string, message?: string } | Promise<...>,
 *   },
 *   log?: (s: string) => void,          // default: the file writer (round-1 S3)
 *   logFilePath?: string,               // the helper's log file (default %TEMP%\arcpower-sysman-helper.log)
 *   sleep?: (ms: number) => Promise<void>,  // the injectable backoff sleep
 *   initBackoffMs?: number,             // the ~2 s init-retry interval
 *   idleMs?: number,                    // the idle timeout (default: the RID override ?? 60 min)
 *   pipeName?: string,                  // the named pipe (default \\.\pipe\arcpower-sysman)
 *   netModule?: typeof import('node:net'),  // the injectable net seam
 * }} deps
 * @returns {Promise<number>} process exit code (0 = the idle exit / the
 *   EADDRINUSE bind-conflict exit; 1 = another listen error)
 */
export function runSysmanHelperPipeMode({
  createConsumer,
  log,
  logFilePath,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  initBackoffMs = INIT_RETRY_BACKOFF_MS,
  idleMs = idleMsFromEnv() ?? HELPER_IDLE_MS,
  pipeName = SYSMAN_PIPE_NAME,
  netModule = net,
}) {
  const helperLog = log ?? createSysmanHelperLogFileWriter(logFilePath ?? defaultHelperLogFilePath());
  // The GLOBAL state: the single ze context (init'd once) + the globally
  // serialized dispatch (one in-flight dispatch at a time across ALL
  // connections - the removed stdin form's inFlight carries over).
  let consumer = null;      // the READY consumer (null until the init lands)
  let initTs = null;        // the init timestamp (the same-helper assertion)
  let inFlight = false;     // a dispatch in progress (globally serialized)
  let settled = false;
  let resolveExit = () => {};
  const done = new Promise((r) => { resolveExit = r; });
  /** @type {Map<import('node:net').Socket, { sock: import('node:net').Socket, queue: object[], readySent: boolean }>} */
  const conns = new Map();
  let idleTimer = null;
  let server = null;

  const finish = (code) => {
    if (settled) return;
    settled = true;
    try { if (idleTimer) clearTimeout(idleTimer); } catch { /* best effort */ }
    try { server?.close(); } catch { /* best effort */ }
    helperLog(`helper exiting (code ${code})`);
    resolveExit(code);
  };

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (conns.size > 0) return; // a HELD-OPEN connection - never armed
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (conns.size > 0) return; // a connection opened while the timer was pending
      helperLog(`idle timer fired (${idleMs} ms without connections) - exiting 0`);
      finish(0);
    }, idleMs);
    helperLog(`idle timer armed (${idleMs} ms)`);
  };

  /**
   * The per-connection response write (the { id } routing). The ready
   * line and the response shapes never collide: the ready line carries
   * ONLY 'type'; no response shape carries one.
   */
  const respond = (sock, id, payload) => {
    const body = typeof id === 'string' && id !== '' ? { id, ...payload } : payload;
    try {
      sock.write(`${JSON.stringify(body)}\n`);
      return true;
    } catch (err) {
      helperLog(`response write failed: ${err.message} (the connection is gone)`);
      return false;
    }
  };

  /**
   * THE PER-CONNECTION READY LINE: { type: 'ready' }, no id, AT MOST ONCE
   * PER CONNECTION (the readySent flag is set before the write - the
   * guarantee holds by construction even on a write failure).
   */
  const sendReady = (conn) => {
    if (conn.readySent || settled) return true;
    conn.readySent = true;
    try {
      conn.sock.write(`${JSON.stringify({ type: 'ready' })}\n`);
      helperLog('ready sent to a connection');
      return true;
    } catch (err) {
      helperLog(`ready write failed: ${err.message} (the connection is gone)`);
      return false;
    }
  };

  /**
   * The next dispatch entry: the per-connection FIFO scan - the first
   * connection with a buffered request owns the next dispatch (the GLOBAL
   * serialization - one ze-context call at a time; the response routes to
   * the requesting connection).
   */
  const nextRequest = () => {
    for (const conn of conns.values()) {
      if (conn.queue.length > 0) return { conn, req: conn.queue.shift() };
    }
    return null;
  };

  const pump = async () => {
    while (!settled && consumer && !inFlight) {
      const entry = nextRequest();
      if (!entry) break;
      inFlight = true;
      const { conn, req } = entry;
      try {
        const { payload } = await dispatchRequest(req, consumer, helperLog);
        const wrote = respond(conn.sock, req?.id, payload);
        helperLog(`response id=${String(req?.id ?? '<none>')} op=${String(req?.op)} ok=${payload?.ok === true}${wrote ? '' : ' (write failed - the connection is gone)'}`);
      } catch (err) {
        // Defensive - dispatchRequest never throws (every path is caught).
        respond(conn.sock, req?.id, { ok: false, errorCode: 'io-failed', message: err instanceof Error ? err.message : String(err) });
      } finally {
        inFlight = false;
      }
    }
  };

  server = netModule.createServer((sock) => {
    if (settled) {
      sock.destroy();
      return;
    }
    const conn = { sock, queue: [], readySent: false };
    conns.set(sock, conn);
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    helperLog(`connection open (${conns.size} open)`);
    // THE PER-CONNECTION READY SEMANTICS: a connection to an ALREADY-READY
    // helper receives the ready line as its FIRST line, IMMEDIATELY (the
    // write is synchronous inside the connection handler - before any
    // 'data' event of this socket is delivered); a connection to an
    // INITIALIZING helper is buffered (its queue) + greeted when the
    // GLOBAL init lands (the initLoop sweep below).
    if (consumer) sendReady(conn);
    const rl = readline.createInterface({ input: sock });
    rl.on('line', (line) => {
      if (settled || !conns.has(sock)) return;
      let req = null;
      try {
        req = JSON.parse(line);
      } catch {
        req = null;
      }
      if (!req || typeof req !== 'object') {
        // The honest refusal (never occurs from the proxy - it always
        // writes well-formed JSON lines). The id-less refusal carries
        // ok/errorCode, never 'type' - the ready-line discrimination is
        // unambiguous.
        respond(sock, null, { ok: false, errorCode: 'invalid-request', message: 'malformed request: expected a JSON line with { id, op }' });
        return;
      }
      conn.queue.push(req);
      helperLog(`request id=${String(req?.id ?? '<none>')} op=${String(req?.op)} (queued)`);
      pump();
    });
    sock.on('close', () => {
      try { rl.close(); } catch { /* best effort */ }
      if (conns.delete(sock)) {
        // A DISCONNECT NEVER EXITS THE HELPER: the in-flight dispatch
        // (globally) completes - its response write just fails on the dead
        // socket; the connection's BUFFERED queue is dropped (the conn is
        // gone from the scan). The idle timer re-arms at the FULL value.
        helperLog(`connection closed (${conns.size} open)`);
        armIdleTimer();
      }
    });
    sock.on('error', () => {
      // The socket error is followed by 'close' - the cleanup above runs.
    });
  });

  server.on('error', (err) => {
    // THE BIND CONFLICT: a second helper's listen fails with EADDRINUSE ->
    // EXIT 0 (the existing helper is alive - the proxy retries the
    // connect). Any other listen error -> exit 1 (never hang).
    if (err && err.code === 'EADDRINUSE') {
      helperLog('listen failed: EADDRINUSE (the existing helper is alive) - exiting 0');
      finish(0);
    } else {
      helperLog(`listen failed: ${err && err.code ? err.code : String(err)} - exiting 1`);
      finish(1);
    }
  });
  server.listen(pipeName);

  // The GLOBAL init-retry loop (DETACHED): a fresh consumer per attempt.
  // When the init lands, every open connection receives the ready line
  // NOW (the per-connection ready sweep - before its buffered responses
  // drain; the sweep precedes the pump). The connections that open later
  // get it on connect (the consumer is set); the readySent flag makes it
  // at-most-once per connection.
  const initLoop = async () => {
    let attempt = 0;
    while (!consumer && !settled) {
      attempt += 1;
      let candidate = null;
      let probe = null;
      try {
        candidate = createConsumer();
        probe = await candidate.readLimits();
      } catch (err) {
        helperLog(`ze init attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}) - retrying in ~${initBackoffMs} ms`);
      }
      if (probe && typeof probe === 'object') {
        consumer = candidate;
        initTs = new Date().toISOString();
        helperLog(`ze init ready on attempt ${attempt} (initTs=${initTs})`);
        for (const conn of conns.values()) sendReady(conn);
        pump();
        return;
      }
      if (probe === null || probe === undefined) {
        helperLog(`ze init attempt ${attempt} not ready yet (the consumer returned no limits) - retrying in ~${initBackoffMs} ms`);
      }
      if (settled) return;
      await sleep(initBackoffMs);
    }
  };
  initLoop().catch((err) => helperLog(`the init loop failed: ${err instanceof Error ? err.message : String(err)}`));

  // THE IDLE TIMER: armed at start (no connection is open yet).
  armIdleTimer();

  return done;
}
