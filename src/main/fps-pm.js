// Arc Power - M17d the PresentMon SERVICE FPS lane (fps-pm.js).
//
// The IGS-class FPS source: a client of the PresentMon SERVICE (the
// driver/IGS-shipped middleware - see pipeline/fps-igs-research.md). The
// service owns ONE ETW session for ALL processes; the client opens a
// session, pmStartTrackingProcess(pid) (a pipe message - CHEAP, no new ETW
// session), registers a dynamic query (DISPLAYED_FPS NEWEST_POINT + AVG
// ~500 ms window + PRESENTED_FPS AVG + PRESENT_RUNTIME NEWEST_POINT - the
// run-A pure layout module's enums + PM_QUERY_ELEMENT math; M17f: the
// sample's fps = the instant NEWEST_POINT with the windowed AVG as the
// fallback), polls per cadence tick, and
// feeds the SAME fps-percentiles ring the M17c sidecar lane uses.
//
// The composition seam (round-1 S3): this source implements the SAME
// contract as the M17c sidecar source (createPresentMonFpsSource - the
// fps-etw.js:162-447 shape) so createPresentMonLane's retarget + stale-
// horizon logic is REUSED UNCHANGED. The spawn/restart-BACKOFF does NOT
// map (the service lane has no per-pid session spawn; retarget =
// pmStartTrackingProcess + a poll).
//
// THE DRY GATE (M17d step-4 S1 redesign): API 3.3's plain
// pmPollDynamicQuery has NO output timestamp (the WithTimestamp variant's
// 5th param is the INPUT nowTimestamp, not an output - the round-1
// "newestTs-equivalent" was built on a misread API: the lane passed the
// constant address of tsBuf, decoded an unwritten buffer, and the dry gate
// marked every tick dry after the first sample) and PM_STAT_COUNT is NOT a
// supported dynamic-query stat in v2.5.1 (QueryValidation.cpp rejects it),
// so there is no count element either. The service itself IS the dry
// signal: the dynamic AVG accumulator resets after every poll
// (DynamicStat.cpp:94-101), so a poll whose window holds no new frames
// writes AVG = 0.0. The pure decoder REJECTS a <= 0 fps (fps-pm-layout.ts)
// - a dry tick decodes displayedFps null, the tick keeps lastGood
// UNSTAMPED, and the reading ages out through the at-gate (the caller
// falls back, exactly like the sidecar's unchanged-newestTs gate). There
// is NO value-identity fallback (at a steady fps it marked every tick
// dry).
//
// THE PROBE GATE (live dev-box reality, 2026-08-12): the probe
// (pm-service.js) answers serviceRunning from `sc query` under BOTH known
// names - this box has NO SCM service (the IGS service spawns
// PresentMonService.exe as its own child, Session 0, and the IGS overlay's
// own PresentMon64.exe holds the local ETW session: a live pmOpenSession
// answers SESSION_ALREADY_EXISTS / MIDDLEWARE_NOT_FOUND) - so the lane
// stays IDLE here and the fallback chain (the vendored console-exe
// sidecar) answers. On a machine with a properly-installed service the
// lane activates: probe positive -> pmOpenSession -> track -> query ->
// per-cadence polls. EVERY failure degrades to null (never a throw; the
// chain decides).
//
// NEVER CALLS pmGetApiVersion in the product path (the dev-box IGS DLL
// corrupts the heap on the call - 0xC0000374; bind-only is verified safe;
// the bindings expose getApiVersion for the unit tests only - flagged in
// the report).
//
// Electron-free (node --test) - the fake-pm-adapter fixtures (a scripted
// { openSession, registerDynamicQuery, poll... } returning crafted blobs
// through the REAL pure decoder - the cheap-oracle seam).
//
// The sample shape stays byte-identical to the M17c lane (+ the APPENDED
// presentRuntime field: 'dxgi' | 'd3d9' | 'other' | null - absent on the
// sidecar/DXGI paths, where the module scan stays the authority).

import { probePresentMonService } from './pm-service.js';
import { createPmBindings } from './pm-bindings.js';
import { pmQueryElements, pmReadPollBlob, PM_METRIC, PM_STAT, PM_GRAPHICS_RUNTIME } from '../renderer/pure/fps-pm-layout.ts';
import { pushRing, percentileStats, RING_MAX, PERCENTILE_WINDOW_MS, AVG_WINDOW_MS } from './fps-percentiles.js';

/** M17d: the cadence - the poll cadence for the service lane (the SAME
 *  ~500 ms as the sidecar lane - the fps-dxgi displayed-window analog). */
export const PM_CADENCE_MS = 500;
/** M17d: the stale horizon - a poll result older than this is not current
 *  (the same 5-tick horizon as the sidecar lane). */
export const PM_STALE_AFTER_MS = 2500;
/** M17d: the dynamic-query window (the DISPLAYED_FPS AVG window - the
 *  plan's ~500 ms; IGS's displayed-fps window class). */
export const PM_QUERY_WINDOW_MS = 500;
/** M17d: the ETW flush period while live (<= 1000 ms per the API contract;
 *  100 ms keeps the poll's window fresh at the 500 ms cadence). */
export const PM_ETW_FLUSH_PERIOD_MS = 100;
/** M17d: the session-open RETRY cadence - a failed pmOpenSession (the
 *  SESSION_ALREADY_EXISTS / MIDDLEWARE_NOT_FOUND shapes) must not retry on
 *  EVERY poll (the sidecar's restart-backoff analog: the service lane has
 *  no spawn backoff, but the session-open attempt is bounded the same way -
 *  one attempt per window). */
export const PM_SESSION_RETRY_MS = 15000;
/** M17d (step-5 N1): the mid-session death recovery - the consecutive HARD
 *  poll failures (poll.ok !== true - the dead-service class: PIPE_ERROR /
 *  BAD_HANDLE / SESSION_NOT_OPEN...) after which the tick CLOSES the session
 *  so the lane wrapper's same-pid restart path (the !source.active &&
 *  restartEligible gate) reopens it. NOT the dry window - a dry poll IS
 *  ok:true (a valid reading, just no frames in the window) and never counts.
 *  8 failures at the 500 ms cadence = 4 s of a dead service before the
 *  session gives up to the restart path. */
export const PM_RECOVERY_HARD_FAILURES = 8;

/** M17d: map the decoded PM_GRAPHICS_RUNTIME enum to the sample's
 *  presentRuntime field: 'dxgi' / 'd3d9' / null. UNKNOWN (0) -> null (no
 *  claim - the module scan stays the authority); DXGI (1) -> 'dxgi';
 *  D3D9 (2) -> 'd3d9'. The 'other' value of the sample shape is never
 *  produced by the pm3 enum (PresentMonAPI.h v3.3 pins exactly 0/1/2;
 *  Vulkan/OpenGL are DXGI-presented in PresentMon's view -> 'dxgi' - the
 *  class corroboration only) - it stays in the type for the fixtures.
 * Garbage -> null.
 * @param {unknown} runtime the decoded PM_GRAPHICS_RUNTIME value
 * @returns {'dxgi' | 'd3d9' | null}
 */
export function presentRuntimeIdOf(runtime) {
  if (runtime === PM_GRAPHICS_RUNTIME.DXGI) return 'dxgi';
  if (runtime === PM_GRAPHICS_RUNTIME.D3D9) return 'd3d9';
  return null;
}

/**
 * The PresentMon SERVICE source (the fps-etw.js source contract - the
 * composition seam). LAZY: the probe runs on the FIRST start (sc.exe +
 * reg.exe + a bind-only DLL inspection - cached for the lane's lifetime);
 * a negative probe (no SCM service / legacy api2 generation / missing DLL)
 * leaves the source permanently idle (the fallback chain answers). A
 * positive probe opens the session on the first start; a failed session
 * open retries at the PM_SESSION_RETRY_MS cadence via restartEligible.
 * Never throws.
 * @param {{
 *   probe?: () => Promise<{ serviceRunning: boolean, dllPath: string | null, apiGeneration: 'pm3' | 'api2' | null }>,
 *   bindings?: (deps: { dllPath: string }) => object | null,  // injectable createPmBindings (tests)
 *   now?: () => number,
 *   setInterval?: (fn: () => void, ms: number) => unknown,
 *   clearInterval?: (id: unknown) => void,
 * }} [deps]
 * @returns {{
 *   start: (processId: number) => void,
 *   stop: () => void,
 *   onSample: (cb: ((s: object) => void) | null) => void,
 *   latest: () => { fps: number, presentRuntime: string | null, at: number } | null,
 *   sample: (nowMs?: number) => { fps: number, avgFps: number | null, low1Pct: number | null, low01Pct: number | null, p99: number | null, frameTimeMs: null, gpuBusy: null, presentRuntime: string | null } | null,
 *   active: boolean,
 *   restartEligible: boolean,
 * }}
 */
export function createPmFpsSource(deps = {}) {
  const probe = deps.probe ?? probePresentMonService;
  const createBindings = deps.bindings ?? createPmBindings;
  const now = deps.now ?? (() => Date.now());
  const setCadenceTimer = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearCadenceTimer = deps.clearInterval ?? ((id) => clearInterval(id));

  // The probe gate (cached for the lane's lifetime - sc.exe/reg.exe once).
  let probeResult = null;      // the resolved probe or null (never started / failed)
  let probePromise = null;     // the in-flight probe (single-flight)
  let probePositive = false;   // serviceRunning && pm3 && dllPath - the lane can act
  let bindings = null;         // the bound pm adapter (from the probe's dllPath)
  let session = null;          // the open PM_SESSION handle (null = closed/failed)
  let queryHandle = null;      // the registered dynamic-query handle
  let queryElements = null;    // the pure layout descriptors { elements, blobSize }
  let blob = null;             // the koffi-alloc'd poll blob
  let pid = null;              // the tracked process id (null = idle)
  let generation = 0;          // guards the async probe/session continuations
                               // against a newer start (the sidecar's
                               // generation pattern - a fast retarget pair
                               // must never track the OLD pid)
  let timer = null;            // the cadence timer id
  let lastGood = null;         // { fps, presentRuntime, at }
  let ring = [];               // the fps-percentiles ring (per-source)
  let sampleCb = null;         // the onSample callback
  let lastSessionAttemptAt = 0; // the session-open retry clock
  let lastDegradeLogged = 0;
  let hardFailures = 0; // consecutive HARD poll failures (the mid-session death recovery streak)

  const log = (text) => {
    const at = now();
    if (at - lastDegradeLogged > 5000) {
      lastDegradeLogged = at;
      console.log(`[fps-pm] ${text}`);
    }
  };

  const stopCadence = () => {
    if (timer !== null) {
      try { clearCadenceTimer(timer); } catch { /* best effort */ }
      timer = null;
    }
  };

  const ensureCadence = () => {
    if (timer === null) timer = setCadenceTimer(tick, PM_CADENCE_MS);
  };

  // The probe gate: run ONCE (cached), resolve the lane's availability.
  // A negative probe (no SCM service / legacy api2 / missing DLL) is
  // permanent for the lane's lifetime - the fallback chain answers.
  const ensureProbe = () => {
    if (probeResult !== null || probePromise !== null) return probePromise ?? Promise.resolve(probeResult);
    probePromise = Promise.resolve()
      .then(() => probe())
      .then((result) => {
        probeResult = result && typeof result === 'object' ? result : null;
        probePositive = probeResult !== null
          && probeResult.serviceRunning === true
          && probeResult.apiGeneration === 'pm3'
          && typeof probeResult.dllPath === 'string'
          && probeResult.dllPath.length > 0;
        if (!probePositive) {
          log(`service unavailable (serviceRunning=${probeResult?.serviceRunning}, generation=${probeResult?.apiGeneration}, dllPath=${probeResult?.dllPath}) - the fallback chain answers`);
        }
        return probeResult;
      })
      .catch(() => {
        probeResult = null;
        probePositive = false;
        return null;
      });
    return probePromise;
  };

  // Bind the pm surface ONCE (bind-only - never a pm* call here beyond the
  // session/query/poll flow; the probe's generation was already bind-checked).
  const ensureBindings = () => {
    if (bindings !== null) return bindings;
    const result = probeResult;
    if (!result || typeof result.dllPath !== 'string' || result.dllPath.length === 0) return null;
    try {
      bindings = createBindings({ dllPath: result.dllPath });
    } catch {
      bindings = null;
    }
    if (bindings && bindings.generation !== 'pm3') bindings = null;
    return bindings;
  };

  // Open the service session + register the dynamic query (the register/
  // poll/decode flow - the pure layout descriptors). A failure latches the
  // retry clock (restartEligible gates the retries).
  const openSession = async () => {
    if (session !== null) return true;
    lastSessionAttemptAt = now();
    try {
      const pm = ensureBindings();
      if (!pm || typeof pm.openSession !== 'function') return false;
      const opened = pm.openSession();
      if (!opened || opened.ok !== true || opened.session === null) {
        log(`pmOpenSession failed - the service lane stays idle (the fallback chain answers)`);
        return false;
      }
      session = opened.session;
      if (typeof pm.setEtwFlushPeriod === 'function') {
        try { pm.setEtwFlushPeriod(session, PM_ETW_FLUSH_PERIOD_MS); } catch { /* best effort */ }
      }
      if (typeof pm.registerDynamicQuery === 'function') {
        queryElements = pmQueryElements([
          // M17f: the INSTANT display rate (PM_STAT_NEWEST_POINT - the
          // newest frame's value, no windowing - the accuracy lever: the
          // sample's fps = newest ?? avg). Registered FIRST so the blob's
          // first value slot is the preferred rate.
          { metric: PM_METRIC.DISPLAYED_FPS, stat: PM_STAT.NEWEST_POINT },
          { metric: PM_METRIC.DISPLAYED_FPS, stat: PM_STAT.AVG }, // the display-cadence fps (what IGS shows) - the fallback
          { metric: PM_METRIC.PRESENTED_FPS, stat: PM_STAT.AVG }, // the Present() call-rate fps
          { metric: PM_METRIC.PRESENT_RUNTIME, stat: PM_STAT.NEWEST_POINT }, // the API class (the badge corroboration)
        ]);
        const registered = pm.registerDynamicQuery(session, queryElements.elements, queryElements.blobSize, PM_QUERY_WINDOW_MS);
        if (registered && registered.ok === true && registered.handle !== null) {
          queryHandle = registered.handle;
          blob = registered.blob;
        } else {
          log('pmRegisterDynamicQuery failed - the service lane stays idle');
          try { pm.closeSession(session); } catch { /* best effort */ }
          session = null;
          return false;
        }
      }
      return session !== null && queryHandle !== null;
    } catch {
      session = null;
      return false;
    }
  };

  const closeSession = () => {
    if (session !== null) {
      try { bindings?.closeSession?.(session); } catch { /* best effort */ }
    }
    session = null;
    queryHandle = null;
    blob = null;
    queryElements = null;
  };

  /**
   * Track a pid (the retarget entry): the probe gate + the lazy session
   * open + pmStartTrackingProcess. A NEW pid on an open session is a pipe
   * message (CHEAP - the plan's retarget claim). Never throws.
   * @param {number} processId
   */
  const start = (processId) => {
    if (!Number.isInteger(processId) || processId <= 0) return;
    if (pid === processId) {
      // Same-pid restart (the lane wrapper's alive-gated branch): make sure
      // the cadence runs (the session died -> reopen it; a failed reopen
      // leaves the lane idle for the restart-eligible window).
      const myGen = generation;
      void ensureProbe().then(() => {
        if (myGen !== generation || !probePositive) return;
        if (session === null) {
          void openSession().then((ok) => {
            if (myGen !== generation || !ok) return;
            if (typeof bindings.startTrackingProcess === 'function') {
              try { bindings.startTrackingProcess(session, processId); } catch { /* best effort */ }
            }
            ensureCadence();
          });
          return;
        }
        ensureCadence();
      });
      return;
    }
    // A NEW pid: stop the old tracking + track the new one.
    stop();
    pid = processId;
    const myGen = ++generation;
    void ensureProbe().then(() => {
      if (myGen !== generation || !probePositive) return;
      void openSession().then((ok) => {
        if (myGen !== generation || !ok) return;
        if (typeof bindings.startTrackingProcess === 'function') {
          try { bindings.startTrackingProcess(session, processId); } catch { /* best effort */ }
        }
        ensureCadence();
        log(`tracking pid ${processId} via the PresentMon service`);
      });
    });
  };

  /** Stop tracking + the cadence + clear the readings. The SESSION stays
   *  open (the service owns one session for all processes - a retarget is
   *  a pipe message; the session dies with the process on quit). */
  const stop = () => {
    generation += 1;
    const oldPid = pid;
    pid = null;
    hardFailures = 0; // a retarget is a fresh start - the streak never spans sessions
    stopCadence();
    if (oldPid !== null && session !== null && typeof bindings?.stopTrackingProcess === 'function') {
      try { bindings.stopTrackingProcess(session, oldPid); } catch { /* best effort */ }
    }
    lastGood = null;
    ring = [];
  };

  /** The last successful poll (never stale-filtered - the raw reading). */
  const latest = () => lastGood;

  // ONE cadence tick: poll the dynamic query -> the pure decode -> the
  // ring entry + onSample. Never throws. The DRY-STREAM gate (the M17d
  // step-4 S1 redesign): the plain poll has no output timestamp, so the
  // service's own behavior is the signal - a poll whose window holds no
  // new frames writes AVG = 0.0 (the accumulator resets every poll,
  // DynamicStat.cpp:94-101), and the pure decoder rejects a <= 0 fps, so a
  // dry tick decodes displayedFps null. The tick keeps lastGood UNSTAMPED
  // on a null/0-fps/degenerate poll - it ages out through the at-gate and
  // the caller falls back (the sidecar's unchanged-newestTs semantics,
  // verbatim). There is NO value-identity gate (at a steady fps it marked
  // every tick dry).
  const tick = () => {
    try {
      if (session === null || queryHandle === null || blob === null || pid === null) return;
      if (typeof bindings.pollDynamicQuery !== 'function') return;
      const poll = bindings.pollDynamicQuery(queryHandle, pid, blob, queryElements.blobSize);
      if (!poll || poll.ok !== true) {
        // A HARD poll failure (the dead-service class - BAD_HANDLE /
        // PIPE_ERROR / SESSION_NOT_OPEN...). NOT the dry window (a dry poll
        // answers ok:true - a valid reading with no frames in the window).
        // Count the streak; past the threshold, close the session so the
        // lane wrapper's same-pid restart path (the !source.active &&
        // restartEligible gate) reopens it - a dead service must never
        // leave this source active-forever (the stale-active shape that
        // suppressed the wrapper's same-pid restarts).
        hardFailures += 1;
        if (hardFailures >= PM_RECOVERY_HARD_FAILURES) {
          hardFailures = 0;
          log(`the poll failed ${PM_RECOVERY_HARD_FAILURES}x in a row (a dead service?) - closing the session so the restart path reopens it`);
          closeSession();
        }
        return; // a failed poll keeps lastGood
      }
      hardFailures = 0; // any successful poll resets the streak
      if (!(poll.numSwapChains > 0)) return; // no data for the pid - keep lastGood unstamped
      const decoded = pmReadPollBlob(queryElements.elements, poll.bytes);
      // M17f: the sample's fps = the DISPLAYED_FPS NEWEST_POINT (the
      // instant display rate) with the AVG as the fallback. The DRY gate
      // follows the preference: (newest ?? avg) === null -> a garbage blob
      // / a <= 0 fps (the dry-window answer) - keep lastGood unstamped.
      // A NEWEST-present / AVG-null blob PASSES the gate (the preferred
      // value is real even when the windowed AVG is dry).
      const fps = decoded === null ? null : (decoded.displayedFpsNewest ?? decoded.displayedFps);
      if (decoded === null || fps === null) return;
      const at = now();
      const runtime = presentRuntimeIdOf(decoded.presentRuntime);
      const sample = { fps, presentRuntime: runtime, at };
      lastGood = sample;
      const ftMs = 1000 / fps;
      const frames = Math.max(1, Math.round(PM_CADENCE_MS / ftMs));
      ring = pushRing(ring, { tMs: at, ftMs, frames }, RING_MAX);
      if (sampleCb) {
        try { sampleCb(sample); } catch { /* a subscriber failure never breaks the lane */ }
      }
    } catch { /* a tick never throws */ }
  };

  /**
   * The full fps sample the fps-poll consumes - freshness-gated (a lastGood
   * older than PM_STALE_AFTER_MS is not current -> null -> the fallback
   * chain answers) with the percentile stats from the lane's own ring.
   * The presentRuntime rides the sample (the APPENDED field - the overlay
   * badge's class corroboration when the module scan yields null).
   * NEVER throws.
   * @param {number} [nowMs]
   * @returns {object | null}
   */
  const sample = (nowMs) => {
    try {
      const at = nowMs ?? now();
      const last = lastGood;
      if (last === null || at - last.at > PM_STALE_AFTER_MS) return null;
      const stats = percentileStats(ring, at, PERCENTILE_WINDOW_MS, AVG_WINDOW_MS);
      return {
        fps: Math.round(last.fps * 10) / 10,
        avgFps: stats === null ? null : stats.avgFps,
        low1Pct: stats === null ? null : stats.low1Pct,
        low01Pct: stats === null ? null : stats.low01Pct,
        p99: stats === null ? null : stats.p99,
        frameTimeMs: null,
        gpuBusy: null,
        presentRuntime: last.presentRuntime,
      };
    } catch {
      return null;
    }
  };

  return {
    start,
    stop,
    onSample: (cb) => { sampleCb = cb; },
    latest,
    sample,
    get active() {
      return session !== null && queryHandle !== null && pid !== null;
    },
    // The service lane's restartEligible = the SESSION/QUERY state, NOT
    // the spawn: the probe must be positive (a restart could succeed) AND
    // the session-open retry window must have elapsed (a failed open - the
    // SESSION_ALREADY_EXISTS / MIDDLEWARE_NOT_FOUND shapes - must not loop
    // per poll; one bounded attempt per PM_SESSION_RETRY_MS).
    get restartEligible() {
      return probePositive && (now() - lastSessionAttemptAt) >= PM_SESSION_RETRY_MS;
    },
  };
}
