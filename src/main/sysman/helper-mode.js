// Arc Power - M17i/M17j the sysman-helper modes: the dedicated IGCL-free
// process for the sysman power-limits consumer. The measured root cause
// (plan M17i): the consumer's zesInit fails with ERROR_UNINITIALIZED ONLY
// when the IGCL is loaded inside an ELECTRON process - the packaged app
// (requireAdministrator) runs its applies in-process = electron + IGCL =
// the poisoned combo. The consumer therefore runs HERE, in a process that
// loads ONLY the consumer (NO backend, NO OldIgcl, NO IGCL - the
// bare-context zesInit path, proven by the M17i diagnostic ladder).
//
// TWO forms share this module:
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
// 2. The M17j PERSISTENT form (`--sysman-helper-persist`, no req/out
//    args): the ze init happens ONCE at start with a RETRY-UNTIL-READY
//    loop (~2 s backoff - the M17j arbitration window: a FRESH ze init
//    fails for 8+ s after an IGCL write elsewhere, while an EXISTING
//    context writes fine; the window eventually closes, so the helper
//    retries until the init lands). Once ready, it serves JSON-LINE
//    requests from stdin and answers JSON-LINE responses on stdout:
//      req:  { id, op: 'read' } | { id, op: 'set', sustainedW, burstW }
//      resp: { id, ok: true, sustainedW?, burstW?, peakW? } |
//            { id, ok: false, errorCode?, message? } (the errorCode/message
//            ride VERBATIM - the refused-class taxonomy at apply-routing.js
//            keys on the exact codes)
//    and exits on stdin EOF. THE LOG CHANNEL IS PINNED (round-1 S1):
//    log() -> STDERR (the default log is console.error) - stdout carries
//    ONLY the JSON-line responses. THE READY SEMANTICS (the round-1 S2
//    buffered-until-ready half; the kill-on-timeout half lives in the
//    proxy - the helper is never killed for a request timeout):
//    requests are BUFFERED until the init completes (no handshake marker
//    needed) - the proxy's request timeout covers the wait. On stdin EOF
//    the helper exits 0 (a buffer already being served drains first; an
//    EOF during the init retry exits immediately - the parent is gone).
//
// Electron-free: the consumer is INJECTED (the seam that makes the whole
// contract testable under plain node --test - main.js wires the real
// createSysmanPowerLimits({})).

import fs from 'node:fs';
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
 * The SHARED request dispatch (both forms): the consumer call + the honest
 * result mapping. The one-shot form writes the payload to the out file;
 * the persistent form writes it as a JSON line on stdout - the payload
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

  // The shared dispatch (both helper forms - the M17j persistent mode
  // reuses the exact same request handling + result mapping).
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
 * M17j the PERSISTENT sysman-helper mode: the ze init happens ONCE at
 * start with the RETRY-UNTIL-READY loop (~2 s backoff - the measured
 * arbitration window: a FRESH ze init fails for 8+ s after an IGCL write
 * in another process, while an EXISTING context writes fine; the window
 * eventually closes, so the loop retries until the init lands). Once
 * ready, the helper serves JSON-LINE requests from stdin and answers
 * JSON-LINE responses on stdout, exiting on stdin EOF.
 *
 * THE READY SEMANTICS (the round-1 S2 buffered-until-ready half): requests
 * arriving during the init retry are BUFFERED and served once the init
 * completes - no handshake marker; the proxy's request timeout covers the
 * wait. On stdin EOF the
 * helper exits 0 - a buffer already being served drains first; an EOF
 * during the init retry exits immediately (the parent is gone, no one
 * waits for the buffered responses).
 *
 * THE LOG CHANNEL IS PINNED (round-1 S1): the default log is
 * console.error (STDERR) - stdout carries ONLY the JSON-line responses
 * (the proxy's reader treats any non-JSON stdout line as a protocol
 * error). The retries are logged via the same channel.
 *
 * The init retry creates a FRESH consumer per attempt (the real
 * createSysmanPowerLimits LATCHES its degrade - a failed ze init stays
 * unavailable on that instance, so a retry must be a new instance).
 *
 * THE STDIN CHANNEL (measured - the M17j run-A fix): electron CLOSES the
 * JS-level process.stdin at startup (the 'end'/'close' events fire
 * immediately; the piped data is never delivered), while the RAW fd-0
 * handle stays open and readable (proven live: fs.readSync(0) + a fresh
 * fs.createReadStream({ fd: 0 }) deliver the piped lines). The DEFAULT
 * input is therefore a fresh fd-0 ReadStream - under BOTH electron and
 * plain node (the fd-0 read works in either; the injected streams are
 * used by the tests).
 *
 * The function returns IMMEDIATELY - the init loop runs DETACHED and every
 * exit (the EOF exit / a dead stdout pipe) goes through the returned
 * promise, so the EOF exit can never be blocked behind a pending backoff
 * sleep.
 *
 * @param {{
 *   createConsumer: () => {
 *     readLimits: (deviceId?: number) => { sustainedW: number, burstW: number, peakW: number } | null | Promise<...>,
 *     setLimits: ({ sustainedW: number, burstW: number }) => { ok: boolean, errorCode?: string, message?: string } | Promise<...>,
 *   },
 *   log?: (s: string) => void,          // STDERR (default console.error)
 *   sleep?: (ms: number) => Promise<void>,  // the injectable backoff sleep
 *   initBackoffMs?: number,             // the ~2 s init-retry interval
 *   stdin?: NodeJS.ReadableStream,      // the JSON-line request source
 *   stdout?: { write: (s: string) => void },  // the JSON-line response sink
 * }} deps
 * @returns {Promise<number>} process exit code (0 = the EOF exit)
 */
export function runSysmanHelperPersistentMode({
  createConsumer,
  log = (s) => console.error(`[sysman-helper-persist] ${s}`),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  initBackoffMs = INIT_RETRY_BACKOFF_MS,
  stdin = fs.createReadStream('', { fd: 0, autoClose: false }),
  stdout = process.stdout,
}) {
  const rl = readline.createInterface({ input: stdin });
  /** @type {Array<{ id?: string, op?: string, sustainedW?: unknown, burstW?: unknown }>} */
  const queue = [];
  let eof = false;       // stdin EOF seen
  let consumer = null;   // the READY consumer (null until the init lands)
  let inFlight = false;  // a dispatch in progress (requests are serialized)
  let settled = false;
  let resolveExit = () => {};
  const done = new Promise((r) => { resolveExit = r; });

  const finish = (code) => {
    if (settled) return;
    settled = true;
    try { rl.close(); } catch { /* best effort */ }
    resolveExit(code);
  };

  const maybeExit = () => {
    if (settled || !eof) return;
    // The parent is gone (EOF). A buffer already being served drains
    // first (the responses were requested before the EOF); otherwise exit
    // now - the init retry's EOF exit is immediate (the round-1 S2 parent-gone half).
    if (consumer && (queue.length > 0 || inFlight)) return;
    finish(0);
  };

  const respond = (id, payload) => {
    const body = typeof id === 'string' && id !== '' ? { id, ...payload } : payload;
    try {
      stdout.write(`${JSON.stringify(body)}\n`);
      return true;
    } catch (err) {
      // The parent's pipe is gone (it died between the EOF and now) -
      // nothing more to do.
      log(`stdout write failed: ${err.message}`);
      finish(0);
      return false;
    }
  };

  const pump = async () => {
    while (consumer && queue.length > 0 && !inFlight) {
      const req = queue.shift();
      inFlight = true;
      try {
        const { payload } = await dispatchRequest(req, consumer, log);
        if (!respond(req?.id, payload)) return;
      } catch (err) {
        // Defensive - dispatchRequest never throws (every path is caught).
        if (!respond(req?.id, { ok: false, errorCode: 'io-failed', message: err instanceof Error ? err.message : String(err) })) return;
      } finally {
        inFlight = false;
      }
    }
    maybeExit();
  };

  rl.on('line', (line) => {
    let req = null;
    try {
      req = JSON.parse(line);
    } catch {
      req = null;
    }
    if (!req || typeof req !== 'object') {
      // A malformed line: the honest refusal (never occurs from the proxy -
      // it always writes well-formed JSON lines).
      respond(null, { ok: false, errorCode: 'invalid-request', message: 'malformed request: expected a JSON line with { id, op }' });
      return;
    }
    queue.push(req);
    pump();
  });

  rl.on('close', () => {
    eof = true;
    pump();
    maybeExit();
  });

  // The init-retry loop (DETACHED - see the header note): a fresh
  // consumer per attempt (the real consumer LATCHES its degrade, so a
  // retry must be a NEW init attempt). The retries are logged (STDERR -
  // round-1 S1). An EOF exits immediately (the parent is gone - the
  // buffered requests are dropped; the proxy's request timeout covers the
  // wait on its side).
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
        log(`ze init attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}) - retrying in ~${initBackoffMs} ms`);
      }
      if (probe && typeof probe === 'object') {
        consumer = candidate;
        log(`ze init ready on attempt ${attempt}`);
        break;
      }
      if (probe === null || probe === undefined) {
        log(`ze init attempt ${attempt} not ready yet (the consumer returned no limits) - retrying in ~${initBackoffMs} ms`);
      }
      if (eof) break; // the parent is gone - nothing to serve
      await sleep(initBackoffMs);
    }
    if (!consumer) {
      maybeExit();
      return;
    }
    pump();
  };
  initLoop().catch((err) => log(`the init loop failed: ${err instanceof Error ? err.message : String(err)}`));

  return done;
}
