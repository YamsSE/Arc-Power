// Arc Power - M17i/M17m the sysman-helper proxy: the parent-side client of
// the `--sysman-helper-pipe` mode (M17m - the DETACHED machine-level helper).
// The one-shot `--sysman-helper` mode is the dev/verification path and is
// spawned by NO ONE - this proxy always spawns the detached pipe form. The
// M17l stdin form (`--sysman-helper-persist`) was REMOVED in run B of M17m
// (the detached named-pipe transport supersedes it - the helper's ze context
// must OUTLIVE the app sessions). M17o2 THE MEASURED TRUTH (live, on the
// user's A770): the '12-20+ min arbitration window' NEVER EXISTED for FRESH
// processes - a fresh process's ze init succeeds ALWAYS (5/5 live-proven,
// even 2 s after a real elevated write), while the IN-PROCESS retry was
// provably PERMANENTLY STUCK (PID 9404: attempt 1459+ over 50+ min while
// fresh processes init'd fine in the same minutes; the ze loader's
// per-process state after a failed init never recovers - a FRESH PROCESS is
// required per retry). The helper therefore EXITS 77 on a failed init, and
// THIS proxy HEALS: it schedules an ensureConnected() respawn (5 s later)
// from every helper-death trigger (the socket drop + the spawned child's
// 0/77 exit), one-shot per trigger; after 30 consecutive heal-spawn deaths
// the heal CONTINUES at the 30 s backoff cadence (M17o4 - the session
// recovers whenever the machine quiets; the next warm() returns the fast
// cadence).
// M17o3 THE RUN-AS-NODE HELPER (the LIVE-PROVEN finding on the user's A770,
// 2026-08-14 - trust it): the packaged helper spawned as the ELECTRON EXE
// fails its ze init EVERY time (zesInit ERROR_UNINITIALIZED - the measured
// 3/3 packaged-helper failures at 19:04/19:05/19:34) while a NODE-process
// init succeeds in the same minutes (5/5 + the RUNASNODE probe: PL1 300
// PL2 252 read back). The electron binary run with ELECTRON_RUN_AS_NODE=1
// is a PLAIN NODE process whose ze init works (live-proven end-to-end: the
// helper-entry ran as RUN-AS-NODE, 'ze init ready on the first attempt',
// then an ELEVATED app-path apply's sysman set returned {ok:true} + the
// read-back PL2 300 W - the exact-value path PROVEN end-to-end). THE SPAWN
// THEREFORE TARGETS THE ELECTRON-FREE helper-entry.js
// (src/main/sysman/helper-entry.js - the no-electron wiring of the
// --sysman-helper-pipe branch: it imports NOTHING from 'electron', which
// the RUN-AS-NODE node cannot destructure) with ELECTRON_RUN_AS_NODE=1 in
// the merged env, NEVER the electron EXE's own --sysman-helper-pipe branch
// (which stays only for the direct-invocation parity: the pipeline's
// live-detached-e2e + the gate harness).
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
//     its spawned child happened to exit. M17o2/M17o4 THE HEAL: every
//     socket drop + the own child's 0/77 exit SCHEDULE an
//     ensureConnected() respawn (5 s later, unref'd, one-shot) - the
//     fresh-process retry; after the cap (30 consecutive heal-spawn
//     deaths, ANY exit code) the heal CONTINUES at the 30 s backoff
//     cadence - never a hot heal loop, the session recovers whenever the
//     machine quiets (the next warm() returns the fast cadence);
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
//     zesInit NEVER landed in the user's usage pattern - the in-process
//     retry was provably permanently stuck, and the M17l 25-min
//     HELPER_INIT_WAIT_MS horizon made the apply WAIT for it = 'AGES';
//     M17o2/M17o4: the fresh-process retry (the HEAL respawn - the 5 s
//     fast cadence, the 30 s post-cap backoff) makes the
//     not-ready class rare - only the heal gaps): THE NOT-READY
//     CALLS ANSWER INSTANTLY. The parser still
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
//     init lines + the ready/response events + the PID + the init
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
import { SYSMAN_PIPE_NAME, resolveIntentFilePath } from './helper-mode.js';

// The per-request answer window: the helper's zesInit + the read/write
// round trip take ~1-6 s live (round-1 N3); 30 s covers the slowest legit
// spawn + the SINGLE-attempt init (the timeout NEVER kills the helper -
// M17o2 a failed init EXITS 77 and the HEAL respawns a fresh process).
// M17n: the bound
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
// M17o2 THE HEAL (the fresh-process retry - the in-process retry was
// provably permanently stuck): the proxy schedules an ensureConnected()
// respawn HELPER_RESPAWN_DELAY_MS after a helper death - from the TOP of
// handleDrop (BEFORE the stale-guard, so the nulled-socket drops - the
// write-failure + protocol-error paths - still heal via the socket's
// 'close') AND from the own spawned child's 0/77 exit. The timer is
// unref()d + ONE-SHOT (a failed heal is never re-armed); the fire-time
// guard is ensureConnected's own socket check + the connecting latch (an
// over-eager heal is a no-op reconnect).
// M17o4 THE RECOVERY HORIZON: HELPER_RESPAWN_DELAY_MS is the 5 s FAST
// cadence (the measured ~7-8 s per death cycle); after the cap the heal
// CONTINUES at the slow HEAL_BACKOFF_DELAY_MS cadence - the session
// recovers whenever the machine quiets (the measured quiet horizon
// ~8 min; the backoff covers everything after the ~3.5-4 min fast
// cadence's nominal horizon). At the 30 s backoff the next heal fires
// after the connect-retry latch clears.
export const HELPER_RESPAWN_DELAY_MS = 5000;
// M17o2 THE HEAL CAP (r2-S2 / r3-N1) + M17o4 THE POST-CAP BACKOFF:
// consecutiveHealSpawns counts EVERY heal-driven spawn's death regardless
// of the exit code (a heal-spawn flag on the child + the counter), checked
// at SCHEDULE time (the one scheduleHeal site). After
// MAX_CONSECUTIVE_HEAL_SPAWNS consecutive deaths the heal does NOT stop -
// it CONTINUES at the slow HEAL_BACKOFF_DELAY_MS cadence (the delay
// selection at the one scheduleHeal site; the anti-hot-loop property kept
// - a heal loop against a permanently dying helper must not respawn at
// the fast cadence; the request path stays instant-not-ready meanwhile -
// the M17n contract untouched). The counter increments PAST the cap and
// resets on ANY successful socket landing AND on warm() - the socket-
// landing reset returns the cadence to fast (the next app session; no
// decay clause - nothing exists to exercise it post-cap).
export const MAX_CONSECUTIVE_HEAL_SPAWNS = 30;
// M17o4 THE POST-CAP BACKOFF DELAY: the heal's slow cadence after the
// cap (one unref'd timer per trigger - never a hot loop).
export const HEAL_BACKOFF_DELAY_MS = 30000;
// M23 CHANGE 2 THE SHUTDOWN BOUND (ms): the best-effort, bounded
// shutdown handshake - the op's ack-or-close wait. ~1 s covers the
// helper's ack write + the socket teardown; the idle backstop (the
// helper exits HELPER_IDLE_MS after the last connection closes) covers
// a dropped/never-reached op. MODULE SCOPE: the destructuring default
// parameter `shutdownBoundMs = HELPER_SHUTDOWN_BOUND_MS` is evaluated
// BEFORE the function body runs - a body-level const would throw
// ReferenceError on every omitted-arg call (step-4 round-2 S1).
export const HELPER_SHUTDOWN_BOUND_MS = 1000;

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
 *   resourcesPath?: string | null, // M17o3 the packaged resources dir (default process.resourcesPath - electron sets it in the packaged EXE; the injectable test seam)
 *   tempDir?: () => string,        // the shared temp dir (default os.tmpdir)
 *   sweep?: (dir: string) => Promise<number>,  // the ONE-TIME connect sweep
 *   spawnFn?: (cmd: string, args: string[], opts: object) => object, // the spawn seam
 *   connectFn?: (pipeName: string) => Promise<object>,  // M17m the connect seam (default: net.connect)
 *   pipeName?: string,             // M17m the named pipe (default \\.\pipe\arcpower-sysman)
 *   timeoutMs?: number,            // the per-request answer window (default HELPER_TIMEOUT_MS - the 30 s bound, READY round trips only)
 *   readyGraceMs?: number,         // M17n the ready-line grace (default NOT_READY_GRACE_MS - ~100-250 ms)
 *   connectRetryIntervalMs?: number,  // M17m the connect-retry interval (default 500 ms)
 *   connectRetryCapMs?: number,    // M17m the connect-retry cap (default 30 s)
 *   healDelayMs?: number,          // M17o2 the heal respawn delay (default HELPER_RESPAWN_DELAY_MS - 5 s; the test seam)
 *   maxConsecutiveHealSpawns?: number,  // M17o4 the heal cap (default MAX_CONSECUTIVE_HEAL_SPAWNS - 30; the test seam - the heals continue at the backoff cadence after it)
 *   healBackoffDelayMs?: number,   // M17o4 the post-cap backoff delay (default HEAL_BACKOFF_DELAY_MS - 30 s; the test seam)
 *   shutdownBoundMs?: number,      // M23 the shutdown handshake bound (default ~1 s; the test seam)
 *   sleep?: (ms: number) => Promise<void>,  // the retry-interval sleep seam
 *   debugLogPath?: () => string,   // the debug file (default %TEMP%\arcpower-sysman-debug.log)
 *   log?: (s: string) => void,
 * }} deps
 */
export function createSysmanHelperProxy({
  execPath = process.execPath,
  appPath = null,
  resourcesPath = process.resourcesPath, // M17o3 the packaged resources dir (electron sets it; the injectable test seam)
  tempDir = () => os.tmpdir(),
  sweep = sweepStaleWorkerFiles,
  spawnFn = childProcessSpawn,
  connectFn = defaultConnect,
  pipeName = SYSMAN_PIPE_NAME,
  timeoutMs = HELPER_TIMEOUT_MS,
  readyGraceMs = NOT_READY_GRACE_MS,
  connectRetryIntervalMs = CONNECT_RETRY_INTERVAL_MS,
  connectRetryCapMs = CONNECT_RETRY_CAP_MS,
  healDelayMs = HELPER_RESPAWN_DELAY_MS,
  maxConsecutiveHealSpawns = MAX_CONSECUTIVE_HEAL_SPAWNS, // M17o4 the heal cap (the backoff engages at >= it)
  healBackoffDelayMs = HEAL_BACKOFF_DELAY_MS, // M17o4 the post-cap slow cadence
  shutdownBoundMs = HELPER_SHUTDOWN_BOUND_MS, // M23 the shutdown handshake bound (~1 s; the test seam)
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
  // M17o2 THE HEAL state: the pending respawn timer (null = none) + the
  // consecutive heal-spawn death counter (the cap - r2-S2/r3-N1). The
  // counter resets on ANY successful socket landing AND on warm().
  let healTimer = null;
  let consecutiveHealSpawns = 0;
  // M23 CHANGE 2 (the full-close reap): THE SHUTDOWN FLAG. Set BEFORE the
  // shutdown op is sent - it gates scheduleHeal ITSELF (the single heal-
  // schedule site), so NEITHER trigger can respawn a helper after an
  // intentional close: the shutdown's own socket 'close' (handleDrop) and
  // the spawned child's graceful exit code 0 (handleChildEvent - the
  // helper's finish(0) fires it) would otherwise schedule a respawn 5 s
  // later and the orphan helper would reappear. The flag makes the
  // intentional close a dead-end: no respawn, no reconnect, no orphan.
  let shuttingDown = false;

  /**
   * M17o2 THE HEAL SCHEDULE (the single schedule site): a helper death
   * (the socket drop via the TOP of handleDrop - BEFORE the stale-guard,
   * so the nulled-socket drops still land here through the socket's
   * 'close' - or the own spawned child's 0/77 exit) schedules ONE
   * ensureConnected() respawn after HELPER_RESPAWN_DELAY_MS. There is NO
   * socket-gate at schedule time (unconditional scheduling is safe by
   * design): the guard moves to FIRE time - the callback calls
   * ensureConnected(), whose socket-first check + connecting latch make an
   * over-eager heal a no-op reconnect (never a double-spawn). The timer is
   * unref()d + ONE-SHOT (a failed heal is never re-armed - no retry loop
   * of its own; the next trigger schedules a fresh heal).
   * M17o4 THE POST-CAP BACKOFF: the DELAY SELECTION - once
   * consecutiveHealSpawns reaches maxConsecutiveHealSpawns (the cap), the
   * heal CONTINUES at the slow healBackoffDelayMs cadence instead of the
   * fast healDelayMs (checked here - the one site; the heal NEVER stops:
   * the horizon guess is removed entirely, the session recovers whenever
   * the machine quiets; the socket-landing / warm() counter reset returns
   * the cadence to fast).
   * M23 CHANGE 2: the SHUTDOWN GATE lives HERE - the ONE scheduleHeal
   * site. When shuttingDown is set (the intentional full close), the heal
   * is a DEAD-END: BOTH trigger sites (handleDrop's socket 'close' AND
   * handleChildEvent's spawned-child exit 0 - the graceful shutdown's own
   * exit) funnel through this gate and can never respawn. No heal timer,
   * no reconnect, no orphan helper 5 s later.
   */
  const scheduleHeal = (reason) => {
    if (shuttingDown) return; // M23: the intentional close is a dead-end - never respawn
    if (healTimer) return; // one pending heal (the same death's socket close + child exit land in quick succession)
    healTimer = setTimeout(() => {
      healTimer = null;
      // THE FIRE-TIME GUARD: ensureConnected's socket check + the
      // connecting latch (a heal racing a warm shares the latch - never a
      // double-spawn). A failed heal degrades silently (the not-ready
      // verdicts cover the calls; a later trigger schedules afresh).
      ensureConnected({ healSpawn: true }).catch(() => { /* best effort */ });
    }, consecutiveHealSpawns >= maxConsecutiveHealSpawns ? healBackoffDelayMs : healDelayMs);
    try { healTimer.unref?.(); } catch { /* best effort */ }
    debugLog({ ts: Date.now(), event: 'heal', reason });
  };

  // The debug file log (M17i - the packaged app's console is invisible,
  // the proxy's verdicts must be diagnosable on the user's machine):
  // ONE line per event, non-throwing (a log failure never degrades a call),
  // removed along with the debug helper in a future milestone.
  const debugLog = (event) => {
    try {
      fs.appendFileSync(debugLogPath(), `${JSON.stringify(event)}\n`, 'utf8');
    } catch { /* best effort */ }
  };

  /**
   * M17o THE AUTO-UPGRADE INTENT (the 'no one waits 15 minutes' contract):
   * the not-ready SET verdict writes the pair the apply wanted into
   * %TEMP%\arcpower-sysman-intent.json ({ pl1W, pl2W, ts } - the
   * RID_SYSMAN_INTENT_FILE override) so the detached helper's ONE-SHOT
   * applies the exact value when its ze init finally lands (the window
   * closes; the existing helper then raises PL2 from the clamp value to
   * the requested value - no user action, no waiting). ATOMIC (tmp +
   * rename - a crash mid-write can never leave a partial intent for the
   * helper's parse), try/catch log-only (an intent write failure NEVER
   * degrades the instant not-ready verdict), NEVER on reads or the ready
   * path.
   */
  const writeAutoUpgradeIntent = ({ pl1W, pl2W }) => {
    try {
      if (!Number.isFinite(pl1W) || !Number.isFinite(pl2W)) return;
      const target = resolveIntentFilePath();
      const tmp = `${target}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pl1W, pl2W, ts: Date.now() }), 'utf8');
      fs.renameSync(tmp, target);
    } catch (err) {
      log(`auto-upgrade intent write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
   * M17o2 THE HEAL HOOK (r2-S1): the heal is scheduled at the TOP -
   * BEFORE the stale-guard. The write-failure + protocol-error drops null
   * the socket before the 'close' fires, so a post-guard hook would miss
   * the dead-socket-write death - the genuine helper-death case; the
   * top-of-handleDrop schedule is the single schedule point for every
   * socket-driven drop (a stale close is an over-eager heal at most - a
   * no-op reconnect via ensureConnected's socket-first check).
   */
  const handleDrop = (sock, reason) => {
    if (!shuttingDown) scheduleHeal(reason); // M17o2 - BEFORE the stale-guard (unconditional: an over-eager heal is a no-op at fire time). M23: the shutdown's own close NEVER respawns (shuttingDown gates the schedule here + at the single scheduleHeal site).
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
   * M17o2 THE HEAL TRIGGERS: (a) EVERY heal-driven spawn's death (the
   * healSpawn flag on the child) increments consecutiveHealSpawns -
   * ANY exit code (r2-S2); (b) the own child's 0/77 exit SCHEDULES the
   * heal (77 = the fresh-process init retry; 0 = the EADDRINUSE loser -
   * there the fire is an over-eager no-op while the existing helper's
   * socket is live, the connect-first shape).
   */
  const handleChildEvent = (event, proc, reason, code, signal) => {
    debugLog({ ts: Date.now(), event, pid: proc?.pid ?? null, reason, code, signal });
    if (event === 'child-exit') {
      if (proc?.healSpawn) consecutiveHealSpawns += 1; // EVERY heal-driven spawn death counts, regardless of the exit code
      // M23: the graceful shutdown exits the helper with code 0 - BOTH
      // exit codes are gated by shuttingDown here (for clarity) AND at the
      // single scheduleHeal site, so the reap's own child-exit can never
      // respawn.
      if (!shuttingDown && (code === 0 || code === 77)) scheduleHeal(`the spawned helper exited (code ${code})`);
    }
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
   * token.
   * M17o3 THE RUN-AS-NODE SPAWN SHAPE (the LIVE-PROVEN finding on the
   * user's A770, 2026-08-14): the target is the ELECTRON-FREE
   * helper-entry.js (src/main/sysman/helper-entry.js - the no-electron
   * wiring of the --sysman-helper-pipe branch) with ELECTRON_RUN_AS_NODE=1
   * in the merged env - NEVER the electron EXE's own --sysman-helper-pipe
   * branch (the packaged helper spawned as the ELECTRON EXE fails its ze
   * init EVERY time - zesInit ERROR_UNINITIALIZED, the 3/3 measured -
   * while a plain NODE process's init succeeds in the same minutes, 5/5 +
   * the RUNASNODE probe: PL1 300 PL2 252 read back; the electron binary
   * with ELECTRON_RUN_AS_NODE=1 IS a plain node process, whose ze init
   * works - the exact-value path proven end-to-end). Dev-tree (appPath
   * set): the entry is the REAL src file under appPath + cwd: appPath;
   * packaged (appPath null): the entry is the app.asar's INTERNAL path
   * under resourcesPath (process.resourcesPath - the electron's node
   * resolves the .asar paths; the asarUnpacked koffi redirect rides
   * along). The env merge `{ ...process.env, ELECTRON_RUN_AS_NODE: '1' }`
   * preserves the parent's env (the RID_* overrides + the elevation
   * token).
   * M17o2: a HEAL-driven spawn flags the child (proc.healSpawn) - the
   * cap counter counts that flag's deaths (the r2-S2 rule, ANY exit code).
   * @returns {Promise<{ ok: boolean, pid?: number | null, reason?: string }>}
   */
  const spawnDetachedHelper = async ({ healSpawn = false } = {}) => {
    try {
      // M17o3 the entry path: dev-tree = the real src file (appPath set);
      // packaged = the app.asar's internal path (appPath null - the
      // electron's node resolves it). The `?? ''` covers the plain-node
      // consumers without process.resourcesPath (the tests) - the packaged
      // EXE always has it set.
      const entry = appPath
        ? path.join(appPath, 'src', 'main', 'sysman', 'helper-entry.js')
        : path.join(resourcesPath ?? '', 'app.asar', 'src', 'main', 'sysman', 'helper-entry.js');
      const opts = {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // M17o3: the helper runs as PLAIN NODE, never the electron EXE
      };
      if (appPath) opts.cwd = appPath; // the dev-tree cwd stays the app dir
      const proc = await spawn(execPath, [entry, '--sysman-helper-pipe'], opts);
      if (healSpawn) proc.healSpawn = true; // M17o2 the heal-cap flag (r3-N1)
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
   * warm free to re-attempt. M17o2 THE HEAL: the heal's fire-time call
   * rides this same path with { healSpawn: true } - its spawn carries the
   * heal flag (the r2-S2 cap counter) and ANY successful socket landing
   * (heal or warm) resets the consecutive-heal-spawn counter.
   * @returns {Promise<{ ok: boolean, reason?: string }>}
   */
  const ensureConnected = async ({ healSpawn = false } = {}) => {
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
          consecutiveHealSpawns = 0; // M17o2: ANY successful socket landing resets the heal counter (M17o4: the cadence returns to fast)
          debugLog({ ts: Date.now(), event: isReconnect ? 'reconnect' : 'connect', pid: spawnedPid, spawnError: null });
          attachSocket(sock);
          socket = sock;
          return { ok: true };
        }
        if (!spawned) {
          spawned = true;
          const s = await spawnDetachedHelper({ healSpawn });
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
          // M17o: a DRAINED SET also writes the AUTO-UPGRADE INTENT (the
          // helper hasn't init'd yet - the one-shot WILL consume it at
          // init-land).
          while (queue.length > 0) {
            const call = queue.shift();
            debugLog({ ts: Date.now(), event: 'resp', id: call.id, op: call.op, spawnError: NOT_READY_MESSAGE, out: null });
            if (call.op === 'set') writeAutoUpgradeIntent({ pl1W: call.payload?.sustainedW, pl2W: call.payload?.burstW });
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
            // is NEVER killed - it may still be inside its SINGLE-attempt
            // init (M17o2: a failed init exits 77 and the heal respawns),
            // and the next call reuses the same connection.
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
      // M17o2/M17o4 THE COUNTER RESET + THE CADENCE RETURN (r3-N1): warm()
      // resets the consecutive-heal-spawn counter - the next app session's
      // boot warm restores the FAST heal cadence even after the backoff
      // phase (the heal itself NEVER stopped - M17o4: after the cap it
      // continued at the slow cadence; the reset returns it to fast;
      // stated plainly, no decay clause - nothing exists to exercise it
      // post-cap).
      consecutiveHealSpawns = 0;
      await ensureConnected().catch(() => { /* a warm failure degrades silently - the not-ready verdicts cover the calls */ });
    },
    /**
     * M23 CHANGE 2 (the full-close reap): the PARENT-SIDE shutdown - the
     * mirror of warm(): warm = the ONLY spawn path, shutdown = the ONLY
     * kill path. Sends { id, op: 'shutdown' } on the current socket and
     * waits for the ack-or-close, then destroys the socket. The helper
     * acks { ok: true } FIRST and finishes (the graceful `helper exiting
     * (code 0)`), which fires handleChildEvent - the heal is gated by the
     * shuttingDown flag (set BEFORE the send), so the reap's own exit can
     * NEVER respawn an orphan helper ~5 s later.
     * Bounded (~1 s - shutdownBoundMs): a busy/dropped helper resolves the
     * bound instead of the ack; the helper-side idle backstop (the 30 s
     * crash-backstop default / the 0 explicit arm) covers the downstream
     * reap. Idempotent (a second call is a no-op) + NEVER throws - the
     * full-close path is fire-and-forget in the window branch and
     * bounded-awaited in the worker/boot-apply branches.
     * @returns {Promise<void>}
     */
    async shutdown() {
      if (shuttingDown) return; // idempotent
      shuttingDown = true;
      // Belt-and-braces: a pending heal timer is cancelled so it can never
      // fire a respawn from a trigger that raced the flag (the scheduleHeal
      // gate already swallows it - this makes the dead-end absolute).
      if (healTimer) {
        try { clearTimeout(healTimer); } catch { /* best effort */ }
        healTimer = null;
      }
      const sock = socket;
      if (!sock) return; // nothing connected - the helper's idle backstop reaps it
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { sock.destroy(); } catch { /* best effort */ }
      };
      try {
        // THE BOUND: the ack-or-close may never arrive (a dropped write / a
        // busy helper). The bound RACES the enqueue, force-resolves
        // whatever is in flight (no dangling 30 s pending timeout), and
        // resolves the handshake; the helper-side idle backstop covers the
        // reap of a helper that never saw the op.
        await Promise.race([
          enqueue({ op: 'shutdown' }), // the ack { id, ok: true } OR the socket close resolves it
          sleep(shutdownBoundMs).then(() => {
            if (pending) finishPending(null, 'the sysman helper did not acknowledge the shutdown within the bound');
            while (queue.length > 0) {
              const call = queue.shift();
              call.resolve({ out: null, reason: 'the sysman helper did not acknowledge the shutdown within the bound' });
            }
          }),
        ]);
        debugLog({ ts: Date.now(), event: 'resp', op: 'shutdown', spawnError: null, out: { ok: true } });
      } catch (err) {
        log(`shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        release();
      }
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
        // M17o: the not-ready SET writes the AUTO-UPGRADE INTENT (the pair
        // the apply wanted) - the detached helper's one-shot applies the
        // exact value when its ze init lands (the V2-clamp covers PL2
        // meanwhile - the 'no one waits 15 minutes' contract).
        writeAutoUpgradeIntent({ pl1W: sustainedW, pl2W: burstW });
        return { ok: false, errorCode: NOT_READY_ERROR_CODE, message: NOT_READY_MESSAGE };
      }
      const { out, reason } = await enqueue({ op: 'set', payload: { sustainedW, burstW } });
      if (!out) return { ok: false, errorCode: 'helper-failed', message: reason ?? 'the sysman helper produced no result' };
      const result = { ok: out.ok === true };
      if (out.errorCode !== undefined) result.errorCode = out.errorCode;
      if (out.message !== undefined) result.message = out.message;
      return result;
    },

    // M26: voltage offset methods. Reuse readiness/FIFO/timeout/degrade
    // semantics without auto-upgrade PL intent for voltage.

    /**
     * M26: read the current GPU voltage offset via the Sysman frequency OC
     * getter. Not-ready or not-connected returns null immediately.
     * @param {number} [_deviceId] accepted for device-scoped consumer parity;
     *   the one elevated helper is intentionally device-agnostic.
     * @returns {Promise<{ targetV: number, offsetV: number } | null>}
     */
    async readVoltageOffset(_deviceId = 0) {
      if (!(await readyGate())) return null;
      const { out } = await enqueue({ op: 'read-voltage' });
      if (out?.ok === true
        && Number.isFinite(out.targetV)
        && Number.isFinite(out.offsetV)) {
        return { targetV: out.targetV, offsetV: out.offsetV };
      }
      return null;
    },

    /**
     * M26: set the GPU voltage offset via the Sysman frequency OC setter.
     * Not-ready or not-connected returns the not-ready verdict immediately.
     * Finite guards run before the call; the result rides VERBATIM.
     * Voltage not-ready must NOT write arcpower-sysman-intent.json.
     * @param {{ offsetV: number }} params
     * @param {number} [_deviceId] accepted for device-scoped consumer parity;
     *   the one elevated helper is intentionally device-agnostic.
     * @returns {Promise<{ ok: boolean, offsetV?: number, errorCode?: string, message?: string }>}
     */
    async setVoltageOffset({ offsetV }, _deviceId = 0) {
      if (!Number.isFinite(offsetV)) {
        return { ok: false, errorCode: 'invalid-argument', message: 'offsetV must be a finite number' };
      }
      if (!(await readyGate())) {
        debugLog({ ts: Date.now(), event: 'resp', op: 'set-voltage', spawnError: NOT_READY_MESSAGE, out: null });
        return { ok: false, errorCode: NOT_READY_ERROR_CODE, message: NOT_READY_MESSAGE };
      }
      const { out, reason } = await enqueue({ op: 'set-voltage', payload: { offsetV } });
      if (!out) return { ok: false, errorCode: 'helper-failed', message: reason ?? 'the sysman helper produced no result' };
      const result = { ok: out.ok === true };
      if (out.offsetV !== undefined) result.offsetV = out.offsetV;
      if (out.errorCode !== undefined) result.errorCode = out.errorCode;
      if (out.message !== undefined) result.message = out.message;
      return result;
    },
  };
}
