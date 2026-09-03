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
// sessions. THE M17o2 MEASURED TRUTH (live, on the user's A770): the
// '12-20+ min arbitration window' NEVER EXISTED for FRESH processes - a
// fresh process's ze init succeeds ALWAYS (5/5 live-proven, even 2 s
// after a real elevated write), while the IN-PROCESS retry is provably
// PERMANENTLY STUCK (PID 9404: attempt 1459+ over 50+ min while fresh
// processes init'd fine in the same minutes - the ze loader's
// per-process state after a failed init never recovers, a FRESH PROCESS
// is required per retry). The helper's init is therefore a SINGLE
// attempt + exit 77, and the fresh-process retry rides on the proxy's
// HEAL respawn (a fresh helper whose init lands on attempt 1):
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
//    machine-level helper. The same IGCL-free consumer, but the init is
//    the M17o2 SINGLE ATTEMPT (a failed probe EXITS 77 - the in-process
//    retry was provably permanently stuck, the fresh-process retry is
//    the proxy's HEAL respawn) and the transport is a Windows NAMED PIPE
//    (\\.\pipe\arcpower-sysman, node's net) and the lifecycle is detached:
//    a client disconnect NEVER exits the helper (the M17l stdin-EOF exit
//    is NOT in this mode) - the in-flight dispatch completes, the
//    connection's buffered queue is dropped. It exits on the M23
//    SHUTDOWN OP (the app's full close - an EXPLICIT request, honored even
//    with connections open: the { ok: true } ack is written FIRST, then
//    the graceful finish(0) exits the helper - the parent's reap path),
//    on the IDLE TIMEOUT (round-2 S1: the timer is ARMED ONLY WHILE NO
//    CONNECTION IS OPEN - cancelled on every connection-open, re-armed at
//    the full value on every connection-close; a HELD-OPEN connection
//    keeps the helper alive INDEFINITELY; the constant is HELPER-SIDE +
//    injectable, RID_SYSMAN_HELPER_IDLE_MS, default HELPER_IDLE_MS =
//    30000 - M23 the CRASH-BACKSTOP idle default: 30 s after the LAST
//    connection closes, so an abnormal app exit (crash / Task-Manager
//    kill / power loss) reaps the helper; only an explicit idleMs: 0
//    (= NEVER - the M17o never-dying arm, still injectable for the
//    tests/gate harness) or a positive value override the default) or on
//    the BIND CONFLICT
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
//    S3): %TEMP%\arcpower-sysman-helper.log - the init lines + the
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
 * M17o2 THE SINGLE-ATTEMPT INIT EXIT CODE: the pipe helper's ze init is a
 * SINGLE attempt (the in-process retry is provably permanently stuck - a
 * fresh PROCESS is required per retry), and a failed init EXITS 77 (never
 * a silent linger): the proxy's HEAL hears the 0/77 exit and respawns a
 * FRESH helper process, whose fresh-process init ALWAYS lands (the M17o2
 * 5/5 live proof).
 */
export const HELPER_INIT_FAILED_EXIT_CODE = 77;

/**
 * M17o2/M17o4 THE INTENT FRESHNESS WINDOW (the wall-clock rule replacing
 * the M17o spawnTs comparison): an auto-upgrade intent is consumable iff
 * Date.now() - intent.ts <= INTENT_FRESH_WINDOW_MS (15 min). M17o4: the
 * measured ~8-min quiet horizon (the time from the last write to the
 * recovery-landing init on the user's A770) sits inside it, and the
 * proxy's heal chain (the 5 s fast cadence + the 30 s post-cap backoff)
 * keeps the intent consumable across the WHOLE recovery - the pair is
 * never lost to a long quiet wait. The accepted reboot tradeoff (N2-r2):
 * a REBOOT inside the window re-applies the user's own requested pair
 * via a fresh helper - benign, the pair is the user's explicit intent (a
 * reboot's intent is otherwise always older than the window, so
 * reboot-staleness is preserved for every older intent; the V2-clamp
 * covers PL2 meanwhile and the user re-applies - the fresh-init evidence
 * (5/5) makes the decay corner rare).
 */
export const INTENT_FRESH_WINDOW_MS = 900000;

/**
 * M17m the named-pipe transport: \\.\pipe\arcpower-sysman (node's net).
 * The detached helper's listening endpoint - the app's proxy connects
 * here, and the helper's ze context (init'd when the machine was idle)
 * outlives the app sessions (M17o2: a FRESH process's init ALWAYS lands
 * - 5/5 live-proven - so the persistent context simply keeps every
 * session on an already-ready helper; the M17o2 heal respawns a fresh
 * helper when one dies, and the fresh init lands on attempt 1).
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
 * M23 (the CRASH-BACKSTOP idle default - the M17o never-dying premise is
 * RETIRED by the M17o2 5/5 fresh-process live proof + the user's explicit
 * full-close requirement): the default becomes 30000 ms - 30 s after the
 * LAST connection closes, the helper exits on its own (the abnormal-exit
 * coverage: the app crashes / is killed in Task Manager / power loss - the
 * socket dies, the idle timer arms, the helper exits). The EXPLICIT
 * shutdown op (M23 Change 1) covers the normal quit immediately; the idle
 * default covers everything else. An explicit idleMs: 0 (= NEVER arm -
 * the M17o never-dying semantics, still the explicit arm for the tests +
 * the gate harness) or a positive value overrides the default; the env
 * override RID_SYSMAN_HELPER_IDLE_MS still wins (the gate harness +
 * the live Part-C gate exercise it).
 */
export const HELPER_IDLE_MS = 30000;
export const HELPER_IDLE_MS_ENV = 'RID_SYSMAN_HELPER_IDLE_MS';

/**
 * M17o THE AUTO-UPGRADE INTENT FILE (the proxy's not-ready set verdict
 * sites write it; the helper's one-shot consumes it when the init lands):
 * %TEMP%\arcpower-sysman-intent.json - { pl1W, pl2W, ts, deviceId?, physicalTarget? }. The path is
 * overridable via the RID_SYSMAN_INTENT_FILE env var (the test seam).
 */
export const SYSMAN_INTENT_FILE_ENV = 'RID_SYSMAN_INTENT_FILE';

/** M17o the auto-upgrade intent file path (the env override ?? the default). */
export function resolveIntentFilePath() {
  const raw = process.env[SYSMAN_INTENT_FILE_ENV];
  return raw && raw.trim() !== '' ? raw : path.join(os.tmpdir(), 'arcpower-sysman-intent.json');
}

/**
 * M17m the helper's own log file (round-1 S3): %TEMP%\
 * arcpower-sysman-helper.log. The diagnostic channel moves INTO the
 * helper (the proxy-side stderr capture dies with the stdin model in run
 * B); the log carries the init lines + the ready/response events +
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
 * @param {{ id?: string, op?: string, sustainedW?: unknown, burstW?: unknown, deviceId?: number, physicalTarget?: object|null }} req
 * @param {{
 *   readLimits: (deviceId?: number, physicalTarget?: object|null) => object | null | Promise<object | null>,
 *   setLimits: ({ sustainedW: number, burstW: number }, deviceId?: number, physicalTarget?: object|null) => object | Promise<object>,
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
      limits = await consumer.readLimits(req?.deviceId, req?.physicalTarget ?? null);
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
      result = await consumer.setLimits({ sustainedW, burstW }, req?.deviceId, req?.physicalTarget ?? null);
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
 *     readLimits: (deviceId?: number, physicalTarget?: object|null) => { sustainedW: number, burstW: number, peakW: number } | null | Promise<...>,
 *     setLimits: ({ sustainedW: number, burstW: number }, deviceId?: number, physicalTarget?: object|null) => { ok: boolean, errorCode?: string, message?: string } | Promise<...>,
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
 * that outlives the app sessions. The same IGCL-free consumer as the
 * one-shot form - but the init is the M17o2 SINGLE ATTEMPT (a failed
 * init EXITS 77 - the in-process retry is provably permanently stuck,
 * the fresh-process retry rides on the proxy's HEAL respawn) - and the
 * transport is
 * a Windows named pipe (\\\\.\\pipe\\arcpower-sysman - node's net) and
 * the lifecycle is detached: a client disconnect NEVER exits the helper
 * (the M17l stdin-EOF exit was REMOVED in run B along with the stdin
 * form) - the in-flight dispatch
 * completes, the connection's buffered queue is dropped. The helper exits
 * only on the IDLE TIMEOUT (round-2 S1: the timer is ARMED ONLY WHILE NO
 * CONNECTION IS OPEN - cancelled on every connection-open, re-armed at
 * the full value on every connection-close; a HELD-OPEN connection keeps
 * the helper alive INDEFINITELY; the env override
 * RID_SYSMAN_HELPER_IDLE_MS, default HELPER_IDLE_MS = 0 = NEVER (M17o the
 * never-dying helper - the timer is never armed, the helper lives until
 * reboot) or on the
 * BIND CONFLICT (a second helper's EADDRINUSE -> exit 0 - the existing
 * helper is alive, the proxy retries the connect).
 *
 * THE PER-CONNECTION READY SEMANTICS (round-1 S1): the ze init is GLOBAL
 * (once - the M17o2 single attempt; a failed init EXITS
 * HELPER_INIT_FAILED_EXIT_CODE); a NEW connection to an
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
 * the init lines + the ready/response events + the PID + the init
 * timestamp (the same-helper assertion surface). The pipe-mode caller
 * (main.js) pins the consumer's log to the same file.
 *
 * The init is a SINGLE attempt on a FRESH consumer (the M17o2 measured
 * finding: the real createSysmanPowerLimits LATCHES its degrade - a
 * failed ze init stays unavailable on that instance forever, and the
 * ze loader's per-process state after a failed init NEVER recovers - so
 * the ONLY working retry is a fresh PROCESS, which the proxy's HEAL
 * respawn provides; the helper's own loop was provably permanently
 * stuck).
 *
 * @param {{
 *   createConsumer: () => {
 *     readLimits: (deviceId?: number, physicalTarget?: object|null) => { sustainedW: number, burstW: number, peakW: number } | null | Promise<...>,
 *     setLimits: ({ sustainedW: number, burstW: number }, deviceId?: number, physicalTarget?: object|null) => { ok: boolean, errorCode?: string, message?: string } | Promise<...>,
 *   },
 *   log?: (s: string) => void,          // default: the file writer (round-1 S3)
 *   logFilePath?: string,               // the helper's log file (default %TEMP%\arcpower-sysman-helper.log)
 *   idleMs?: number,                    // the idle timeout (default: the RID override ?? 30000 = the M23 crash-backstop; an EXPLICIT 0 = NEVER - the M17o never-dying arm; any positive value arms the exit timer)
 *   pipeName?: string,                  // the named pipe (default \\.\pipe\arcpower-sysman)
 *   netModule?: typeof import('node:net'),  // the injectable net seam
 * }} deps
 * @returns {Promise<number>} process exit code (0 = the idle exit / the
 *   EADDRINUSE bind-conflict exit; 77 = the single-attempt ze init failed
 *   - HELPER_INIT_FAILED_EXIT_CODE, the fresh-process retry; 1 = another
 *   listen error)
 */
export function runSysmanHelperPipeMode({
  createConsumer,
  log,
  logFilePath,
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
    // M23 THE CRASH-BACKSTOP IDLE DEFAULT: idleMs === 0 (an EXPLICIT arm -
    // the M17o never-dying semantics, still injectable) = NEVER arm the
    // timer; the DEFAULT (30000) + any positive value arms the exit timer
    // (the helper exits HELPER_IDLE_MS after the last connection closes -
    // the abnormal-app-exit backstop).
    if (idleMs > 0) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        if (conns.size > 0) return; // a connection opened while the timer was pending
        helperLog(`idle timer fired (${idleMs} ms without connections) - exiting 0`);
        finish(0);
      }, idleMs);
      helperLog(`idle timer armed (${idleMs} ms)`);
    }
  };

  /**
   * M17o THE AUTO-UPGRADE ONE-SHOT: an app session's apply that answered
   * the proxy's INSTANT 'not-ready' verdict (the sysman helper wasn't
   * ready - the user's 'no one waits 15 minutes' contract) wrote the
   * auto-upgrade intent (%TEMP%\arcpower-sysman-intent.json - the
   * RID_SYSMAN_INTENT_FILE override) with the pair the apply wanted. When
   * THIS helper's init lands, the one-shot applies that pair
   * through the SAME internal set dispatch the pipe set uses - PL2 = the
   * exact requested value arrives with no user action and no waiting.
   * M17o2/M17o4 FRESHNESS (the WALL-CLOCK WINDOW - the spawnTs rule is
   * REMOVED): consumable iff Date.now() - intent.ts <=
   * INTENT_FRESH_WINDOW_MS (15 min - the measured ~8-min quiet horizon
   * sits inside it; the heal's 5 s fast cadence + the 30 s post-cap
   * backoff keep the pair consumable across the whole recovery). NOT a
   * 30-min cutoff and not a spawn comparison: the window covers the
   * heal-spawned helper and preserves reboot-staleness for older intents
   * (a REBOOT inside the window re-applies the user's own requested pair
   * via a fresh helper - benign, the pair is the user's explicit intent;
   * the N2-r2 accepted tradeoff, stated).
   * Parse failure = no intent + a helper-log line - the ready path NEVER
   * crashes on the intent file. The file is DELETED regardless of the
   * apply outcome (one-shot by construction).
   */
  const consumeAutoUpgradeIntent = async () => {
    const intentPath = resolveIntentFilePath();
    let raw = null;
    try {
      raw = await fs.promises.readFile(intentPath, 'utf8');
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        helperLog(`intent read failed: ${err instanceof Error ? err.message : String(err)} - no intent (the ready path never crashes on it)`);
      }
      return; // no intent file (or unreadable) - nothing to upgrade
    }
    let intent = null;
    try {
      intent = JSON.parse(raw);
    } catch (err) {
      helperLog(`intent parse failed: ${err instanceof Error ? err.message : String(err)} - no intent (the ready path never crashes on it)`);
      return;
    }
    if (!intent || typeof intent !== 'object' || typeof intent.pl1W !== 'number' || typeof intent.pl2W !== 'number' || typeof intent.ts !== 'number') {
      helperLog('intent ignored: the intent file is malformed (expected { pl1W, pl2W, ts, deviceId?, physicalTarget? }) - no intent');
      return;
    }
    if (Date.now() - intent.ts > INTENT_FRESH_WINDOW_MS) {
      helperLog(`intent ignored: ts=${intent.ts} is ${Date.now() - intent.ts} ms old (older than the ${INTENT_FRESH_WINDOW_MS} ms freshness window) - it belongs to a previous session/reboot (discarded)`);
      try { await fs.promises.unlink(intentPath); } catch (err) { helperLog(`intent delete failed: ${err instanceof Error ? err.message : String(err)}`); }
      return;
    }
    // Apply through the SAME internal dispatch the pipe set uses (the
    // one-shot runs BEFORE the ready sweep, so the global serialization
    // latch is trivially free - no pipe set can be in flight).
    const { payload } = await dispatchRequest({
      op: 'set',
      sustainedW: intent.pl1W,
      burstW: intent.pl2W,
      deviceId: intent.deviceId,
      physicalTarget: intent.physicalTarget ?? null,
    }, consumer, helperLog);
    try { await fs.promises.unlink(intentPath); } catch (err) { helperLog(`intent delete failed: ${err instanceof Error ? err.message : String(err)}`); }
    if (payload && payload.ok === true) {
      helperLog(`intent applied: PL1 ${intent.pl1W} W PL2 ${intent.pl2W} W`);
    } else {
      helperLog(`intent apply failed: ${payload?.errorCode ?? 'unknown'} (${payload?.message ?? 'no message'})`);
    }
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
      // THE M23 CHANGE 1 SHUTDOWN OP (the app full-close reap): SPECIAL-
      // CASED in the pipe scope - an EXPLICIT request, honored even with
      // connections open (it is NOT the idle timer, which stays
      // connection-gated). The { ok: true } ack is written FIRST so the
      // proxy's awaited call resolves BEFORE the socket dies, then the
      // GRACEFUL finish(0) (the existing teardown: close server/sockets,
      // resolve the exit) exits the helper. dispatchRequest is shared
      // with the one-shot form and has NO finish access - the shutdown
      // never rides it (the one-shot's exit stays covered by its returned
      // exitCode path). The op is consumed EVEN while the global init is
      // pending (settled guards the init-loop + the ready sweep), so a
      // full close never leaves an orphan helper behind a slow init.
      if (req.op === 'shutdown') {
        respond(sock, req?.id, { ok: true });
        helperLog(`shutdown op received (id=${String(req?.id ?? '<none>')}) - finishing 0`);
        finish(0);
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

  // THE GLOBAL INIT - THE M17o2 SINGLE ATTEMPT (the measured finding: the
  // in-process retry is provably PERMANENTLY STUCK - PID 9404 retried ze
  // init every 2 s for 50+ min (attempt 1459+) while fresh processes
  // init'd fine in the same minutes; the ze loader's per-process state
  // after a failed init NEVER recovers - a FRESH PROCESS is required per
  // retry). The init therefore runs ONCE: a failed probe EXITS 77
  // (HELPER_INIT_FAILED_EXIT_CODE) and the proxy's HEAL respawns a fresh
  // helper process (whose fresh-process init ALWAYS lands - the 5/5 live
  // proof). When the init lands, every open connection receives the ready
  // line NOW (the per-connection ready sweep - before its buffered
  // responses drain; the sweep precedes the pump). The connections that
  // open later get it on connect (the consumer is set); the readySent flag
  // makes it at-most-once per connection.
  const initLoop = async () => {
    let candidate = null;
    let probe = null;
    try {
      candidate = createConsumer();
      // The init probe only establishes that the helper's Sysman context is
      // alive. It is deliberately marked as a probe so a multi-GPU consumer
      // may inspect one read-only domain without authorizing an ordinal
      // target for later requests.
      probe = await candidate.readLimits(null, { probe: true });
    } catch (err) {
      if (settled) return; // a bind conflict resolved mid-probe - the exit stays 0
      helperLog(`ze init failed on the first attempt (${err instanceof Error ? err.message : String(err)}) - exiting ${HELPER_INIT_FAILED_EXIT_CODE} (the in-process retry is gone: the next warm() spawns a FRESH helper process, whose init lands on attempt 1)`);
      finish(HELPER_INIT_FAILED_EXIT_CODE);
      return;
    }
    // THE SETTLE-CHECK ORDER (N3 pinned): FIRST the settled guard - a bind
    // conflict (EADDRINUSE) that resolved mid-probe must keep the exit 0.
    if (settled) return;
    if (probe && typeof probe === 'object') {
      consumer = candidate;
      initTs = new Date().toISOString();
      helperLog(`ze init ready on the first attempt (initTs=${initTs})`);
      // M17o THE AUTO-UPGRADE ONE-SHOT: BEFORE the ready sweep (no pipe
      // set can be in flight - the global serialization latch is
      // irrelevant by construction). Consumes a not-ready apply's intent
      // through the same internal set dispatch (never throws - the
      // ready path is crash-free by contract).
      await consumeAutoUpgradeIntent();
      for (const conn of conns.values()) sendReady(conn);
      pump();
      return;
    }
    helperLog(`ze init failed on the first attempt (the consumer returned no limits) - exiting ${HELPER_INIT_FAILED_EXIT_CODE} (the in-process retry is gone: the next warm() spawns a FRESH helper process, whose init lands on attempt 1)`);
    finish(HELPER_INIT_FAILED_EXIT_CODE);
  };
  initLoop().catch((err) => helperLog(`the init failed: ${err instanceof Error ? err.message : String(err)}`));

  // THE IDLE TIMER: armed at start (no connection is open yet).
  armIdleTimer();

  return done;
}
