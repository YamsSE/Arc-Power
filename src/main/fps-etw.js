// Arc Power - M17c the ETW/PresentMon FPS lane (the preferred FPS source).
//
// The DXGI paths (fps-dxgi.js) measure the COMPOSITED DESKTOP: GFS is
// exclusive-fullscreen-only and the duplication drain counts DWM-presented
// frames, which track the DISPLAY refresh rate, not the game's render rate
// (a vsync'd 60 fps game on a 180 Hz desktop reads ~180 - the user's
// "FPS is sometimes WAY off" report; the research record is
// pipeline/fps-etw-research.md). RTSS-level accuracy needs the per-frame
// present timestamps of the GAME's swapchain; the only non-injection,
// user-mode path is the dxgkrnl ETW present-event stream, consumed by the
// official PresentMon console binary (PresentMon64.exe, MIT, vendored at
// src/main/backend/presentmon/ - asar-unpacked like the koffi/igcl
// entries).
//
// THIS APP RUNS ELEVATED (package.json requestedExecutionLevel
// requireAdministrator), which satisfies ETW's privilege requirement
// (EnableTraceEx2 -> ERROR_ACCESS_DENIED unless admin / Performance Log
// Users). The DEV run is NOT elevated - the lane's spawn would start
// PresentMon but its ETW session creation fails (PresentMon prints the
// error and exits) - the live spawn is therefore a PACKAGED-only
// validation; the dev-box tests use fake-sidecar fixtures.
//
// Spawn contract (pinned from the official README-ConsoleApplication.md,
// PresentMon v2.5.1):
//   PresentMon64.exe --process_id <pid> --output_stdout --qpc_time_ms
//                    --no_console_stats --terminate_on_proc_exit
//                    --session_name ArcPower --stop_existing_session
//   - --process_id <pid>   only the target process's frames (the
//     per-process attribution - no window->adapter mapping);
//   - --output_stdout      the CSV stream on STDOUT (never a file);
//   - --qpc_time_ms        the CPUStart column is named 'CPUStartQPCTime'
//     (milliseconds) - the run-A pure parser (presentmon-csv.ts) needs it
//     for its 1 s sub-window;
//   - --no_console_stats   suppress the console stats table - STDOUT
//     carries ONLY the CSV (the old --no_top flag name is gone in the
//     v2.x console app);
//   - --terminate_on_proc_exit  PresentMon exits when the target process
//     exits - no orphaned sidecar/session when the game closes;
//   - --session_name ArcPower + --stop_existing_session  the ETW session
//     is named ArcPower (never the default 'PresentMon', so HWiNFO/other
//     tools' sessions are untouched); a STALE session of OUR name (a
//     crashed previous instance) is stopped before the new capture.
//
// Kill discipline: stop() kills the child (child.kill() - TerminateProcess
// on Windows; PresentMon keeps no state that needs flushing - the CSV goes
// to STDOUT and is consumed in-process). A killed PresentMon process's
// ETW realtime session dies with it (Windows auto-stops a session when
// the process that started it exits), so no orphaned session can linger.
//
// Defensive (never throws): a missing/unspawnable exe, a garbage CSV
// stream, no rows for the pid, a child that dies - every failure resolves
// to null (the fps-poll falls back to the DXGI adapter). The buffered
// CSV window + the ~500 ms cadence + the 1 s pure-parse window follow the
// plan's window semantics (the fps-dxgi 500 ms displayed-window analog).
//
// The lane ring: each cadence tick with a parse result pushes ONE
// fps-percentiles entry { tMs, ftMs, frames } - ftMs = the newest row's
// present interval (lastSampleMs), frames = the entries the cadence
// interval represents at that interval (max(1, round(CADENCE_MS / ftMs))).
// The entry semantics are EXACTLY the DXGI sampler's (tick-mean frame time
// + the frames the tick counted), so the SAME pure percentile math feeds
// avgFps / 1% Low / 0.1% Low / 99% FPS. The stale horizon keeps the
// reading honest when the stream dries up (the game stopped presenting /
// ETW dropped events): after STALE_AFTER_MS without a parse the lane
// reports null and the caller falls back.
//
// Electron-free (node --test): spawn + fs + the pure parser only.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn as spawnChild } from 'node:child_process';
import { presentFpsOfCsv } from '../renderer/pure/presentmon-csv.ts';
import { pushRing, percentileStats, RING_MAX, PERCENTILE_WINDOW_MS, AVG_WINDOW_MS } from './fps-percentiles.js';

export const PRESENTMON_FILENAME = 'PresentMon64.exe';

/** M17c: the cadence - how often the buffered CSV window is parsed into a
 *  sample (the fps-dxgi poll's 400-600 ms displayed-window analog; ~2
 *  parse ticks per displayed second). */
export const CADENCE_MS = 500;

/** M17c: the stale horizon - a parse result older than this is not a
 *  current reading (the stream dried up / ETW dropped events); the lane
 *  reports null and the caller falls back to the DXGI adapter. 5 cadence
 *  ticks. */
export const STALE_AFTER_MS = 2500;

/** M17c: the stdout line buffer - the header + the most recent data rows
 *  (the pure parse windows over the newest row's 1 s; 1024 rows ≈ 5.7 s
 *  at 180 fps / ~17 s at 60 fps - far beyond the window with margin). */
export const MAX_BUFFERED_LINES = 1024;

/** M17c (step-4 N3): the sidecar RESTART backoff - a same-target restart
 *  is skipped within this window when no prior spawn EVER produced a
 *  header. The unelevated dev run is the trigger: ETW session creation
 *  fails, PresentMon prints the error and exits, the lane is left
 *  active:false, and the next poll would restart it for the same pid - a
 *  perpetual per-second spawn/exit loop. A spawn that demonstrably worked
 *  (a header arrived) restarts immediately on a crash. */
export const RESTART_BACKOFF_MS = 15000;

/** The pinned spawn flags (see the header comment for the rationale). */
export const PRESENTMON_ARGS = [
  '--process_id',
  '--output_stdout',
  '--qpc_time_ms',
  '--no_console_stats',
  '--terminate_on_proc_exit',
  '--session_name',
  'ArcPower',
  '--stop_existing_session',
];

/**
 * M17c: locate the vendored PresentMon64.exe. Resolution order (mirrors
 * the oldIgclDllPath / bundledSetupPath patterns):
 *   1. the packaged layout: resources/app.asar.unpacked (asarUnpack -
 *      native payloads must live OUTSIDE the archive to be spawnable);
 *   2. the MIRROR of the module's own location: the app.asar segment (when
 *      the module loads from inside an archive) is replaced with
 *      app.asar.unpacked - the dist-smoke mode runs the packaged payload
 *      under the dev electron binary whose resourcesPath points at the
 *      dev resources, so the unpacked copy sits next to the loaded asar;
 *   3. the dev tree (no app.asar segment -> the mirror IS the repo copy).
 * Never throws - a missing file reports null (the lane degrades honestly;
 * the smoke gate fails on it).
 * @returns {string | null}
 */
export function presentMonExePath() {
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'src', 'main', 'backend', 'presentmon', PRESENTMON_FILENAME);
    if (fs.existsSync(unpacked)) return unpacked;
  }
  const here = fileURLToPath(new URL('.', import.meta.url));
  const mirror = path.join(here.replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked'), 'backend', 'presentmon', PRESENTMON_FILENAME);
  return fs.existsSync(mirror) ? mirror : null;
}

/**
 * M17c: the PresentMon lane SOURCE - the sidecar lifecycle + the CSV
 * stream -> sample pipeline. Never throws; every failure resolves to
 * null. The spawn + the CSV parse are INJECTABLE (the fake-sidecar test
 * fixtures); the default csvParse is the run-A pure parser.
 * @param {{
 *   exePath?: string | null,     // the PresentMon64.exe path (default presentMonExePath())
 *   spawn?: (cmd: string, args: string[], opts: object) => object,  // injectable child spawn (tests)
 *   csvParse?: (csvText: string, processId: number) => { fps: number, lastSampleMs: number, newestTs: number | null } | null,  // injectable parser (default presentFpsOfCsv; newestTs = the newest ROW's timestamp - the dry-stream signal)
 *   now?: () => number,          // injectable wall clock (ms)
 *   setInterval?: (fn: () => void, ms: number) => unknown,  // injectable cadence timer (tests)
 *   clearInterval?: (id: unknown) => void,                  // injectable cadence timer (tests)
 * }} [deps]
 * @returns {{
 *   start: (processId: number) => void,
 *   stop: () => void,
 *   onSample: (cb: ((s: { fps: number, lastSampleMs: number, at: number }) => void) | null) => void,
 *   latest: () => { fps: number, lastSampleMs: number, at: number } | null,
 *   sample: (nowMs?: number) => { fps: number, avgFps: number | null, low1Pct: number | null, low01Pct: number | null, p99: number | null, frameTimeMs: null, gpuBusy: null } | null,
 *   active: boolean,
 * }}
 */
export function createPresentMonFpsSource(deps = {}) {
  const spawn = deps.spawn ?? spawnChild;
  const csvParse = deps.csvParse ?? presentFpsOfCsv;
  const now = deps.now ?? (() => Date.now());
  const setCadenceTimer = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearCadenceTimer = deps.clearInterval ?? ((id) => clearInterval(id));

  let exePath = deps.exePath === undefined ? presentMonExePath() : deps.exePath;
  let child = null;        // the live sidecar child (null = idle)
  let childPid = null;     // the pid the child captures (the --process_id value)
  let generation = 0;      // guards the child 'exit' handler against a NEWER child
  let timer = null;        // the cadence timer id (null until the first start)
  let header = null;       // the CSV header line (the FIRST non-empty stdout line)
  let lines = [];          // the buffered data rows (most recent MAX_BUFFERED_LINES)
  let pending = '';        // the partial line between stdout chunks
  let lastGood = null;     // the last successful parse { fps, lastSampleMs, at, newestTs } - `at` is only re-stamped on ticks that saw NEW data (the dry-stream gate)
  let lastGoodBufferIdentity = null; // M17c (step-5 N3): the buffered window's identity (row count + newest row text) at the last re-stamp - the no-timestamp stream's dry signal
  let ring = [];           // the fps-percentiles ring (per-source - never shared with DXGI)
  let sampleCb = null;     // the onSample callback
  let lastDegradeLogged = 0; // the last degrade-note timestamp (log-once-per-event)
  // M17c (step-4 N3): the restart-backoff state - when the last spawn
  // happened (wall-clock) + whether any spawn EVER produced a header (the
  // sidecar demonstrably worked once - a crash after that is a genuine
  // recovery candidate; no-header exits are the ETW-access-denied shape
  // that must not loop).
  let lastStartAt = 0;
  let everSawHeader = false;

  const log = (text) => {
    const at = now();
    if (at - lastDegradeLogged > 5000) {
      lastDegradeLogged = at;
      console.log(`[fps-etw] ${text}`);
    }
  };

  // Split one stdout chunk into complete lines; the partial tail stays in
  // `pending` until the next chunk. A header line is detected as the first
  // non-empty line (PresentMon writes it once, before the first row).
  const ingestChunk = (chunk) => {
    try {
      pending += chunk;
      const complete = pending.split(/\r?\n/);
      pending = complete.pop() ?? '';
      for (const line of complete) {
        if (line.trim().length === 0) continue;
        if (header === null) {
          header = line.trim();
          // M17c (step-4 N3): a header proves the sidecar STARTED (it got
          // past ETW session setup and wrote the CSV contract) - the
          // restart backoff's evidence signal.
          everSawHeader = true;
          continue;
        }
        lines.push(line.trim());
        if (lines.length > MAX_BUFFERED_LINES) lines.splice(0, lines.length - MAX_BUFFERED_LINES);
      }
    } catch { /* ingest never throws - the buffer degrades */ }
  };

  // Rebuild the CSV text the pure parser consumes: the header + the
  // buffered rows (a joined string - the parse is a pure function of it).
  const bufferedCsv = () => {
    if (header === null) return '';
    return [header, ...lines].join('\n');
  };

  // M17c (step-5 N3): the buffered window's IDENTITY - the row count +
  // the newest buffered row's text. Every ingested row changes the count
  // (below MAX_BUFFERED_LINES) or the newest-row text (the cap evicts
  // from the FRONT, never the newest row), so an unchanged identity means
  // the buffer gained NOTHING since the last parse - the dry-stream
  // signal for streams without a timestamp column (newestTs null).
  const bufferIdentity = () => {
    const n = lines.length;
    return n === 0 ? '' : `${n}:${lines[n - 1]}`;
  };

  // ONE cadence tick: parse the buffered window + push the ring entry +
  // notify onSample. Never throws.
  // M17c (step-4 S1): the DRY-STREAM gate. The pure parse's 1-second window
  // is keyed on the newest ROW's timestamp, not wall-clock - so a buffered
  // re-parse keeps succeeding after the stream dries up (the game stopped
  // presenting / ETW dropped events) and the at-gate alone could never
  // notice. The parse result's newestTs is that ROW clock: an UNCHANGED
  // newestTs across ticks means no new present arrived - the tick must NOT
  // re-stamp lastGood.at (no ring entry, no onSample - nothing was
  // presented), so the existing `at - last.at > STALE_AFTER_MS` gate fires
  // and the lane reports null (the caller falls back to the DXGI adapter).
  // A direct sample()-level now-vs-newestTs comparison is NOT used: the
  // sidecar's CPUStartQPCTime is QPC-derived (per-boot counter, ms), not
  // wall-clock epoch ms - the raw difference is meaningless; the
  // unchanged-newestTs signal is the honest dry-stream detector. Streams
  // without a timestamp column (newestTs null - the step-5 N3 case) use
  // the BUFFER-IDENTITY gate instead: an unchanged buffered window (row
  // count + newest-row text) across ticks is the same no-new-presents
  // signal, so the null fallback can no longer re-stamp lastGood forever.
  const tick = () => {
    try {
      if (child === null || childPid === null) return;
      const at = now();
      const csv = bufferedCsv();
      if (csv.length === 0) return; // no header yet - nothing to parse
      const result = csvParse(csv, childPid);
      if (result === null) return; // no rows for the pid / garbage - keep lastGood
      if (lastGood !== null) {
        const hasTs = result.newestTs !== null && result.newestTs !== undefined
          && lastGood.newestTs !== null && lastGood.newestTs !== undefined;
        const dry = hasTs
          ? result.newestTs === lastGood.newestTs // a timestamped stream: the newest ROW clock unchanged -> no new present
          : bufferIdentity() === lastGoodBufferIdentity; // a no-timestamp stream (step-5 N3): the unchanged buffered window -> no new present
        if (dry) {
          // The buffer gained NO newer row since the last tick - the stream
          // is dry (or the target stopped presenting). Keep the last-good
          // reading un-stamped: it ages out through the at-gate instead of
          // being refreshed forever.
          return;
        }
      }
      const sample = { fps: result.fps, lastSampleMs: result.lastSampleMs, at, newestTs: result.newestTs ?? null };
      lastGood = sample;
      lastGoodBufferIdentity = bufferIdentity();
      const frames = Math.max(1, Math.round(CADENCE_MS / result.lastSampleMs));
      ring = pushRing(ring, { tMs: at, ftMs: result.lastSampleMs, frames }, RING_MAX);
      if (sampleCb) {
        try { sampleCb(sample); } catch { /* a subscriber failure never breaks the lane */ }
      }
    } catch { /* a tick never throws */ }
  };

  const killChild = () => {
    const c = child;
    child = null;
    childPid = null;
    if (c && typeof c.kill === 'function') {
      try { c.kill(); } catch { /* best effort */ }
    }
  };

  const stopCadence = () => {
    if (timer !== null) {
      try { clearCadenceTimer(timer); } catch { /* best effort */ }
      timer = null;
    }
  };

  const ensureCadence = () => {
    if (timer === null) {
      timer = setCadenceTimer(tick, CADENCE_MS);
    }
  };

  /**
   * Spawn the sidecar for a pid (a no-op on an invalid pid / absent exe /
   * spawn failure - the lane degrades to null, never throws).
   * @param {number} processId the target process id (--process_id)
   */
  const start = (processId) => {
    if (!Number.isInteger(processId) || processId <= 0) return;
    stop();
    if (exePath === null) {
      log(`sidecar unavailable (${PRESENTMON_FILENAME} not found) - FPS falls back to DXGI`);
      return;
    }
    // M17c (step-4 N3): stamp the restart-backoff clock at every spawn
    // attempt (a failed attempt starts the window too - the loop must be
    // bounded by attempts, not by success).
    lastStartAt = now();
    const myGen = ++generation;
    try {
      child = spawn(exePath, [...PRESENTMON_ARGS.slice(0, 1), String(processId), ...PRESENTMON_ARGS.slice(1)], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      childPid = processId;
      header = null;
      lines = [];
      pending = '';
      const out = child.stdout;
      if (out) {
        if (typeof out.setEncoding === 'function') out.setEncoding('utf8');
        out.on('data', ingestChunk);
      }
      const err = child.stderr;
      if (err) {
        if (typeof err.setEncoding === 'function') err.setEncoding('utf8');
        err.on('data', (chunk) => {
          try {
            const text = String(chunk).trim();
            if (text.length > 0) log(`sidecar stderr: ${text}`);
          } catch { /* best effort */ }
        });
      }
      if (typeof child.on === 'function') {
        child.on('error', (err) => {
          if (myGen !== generation) return; // a newer start owns the lane
          log(`sidecar spawn error: ${err.message} - FPS falls back to DXGI`);
          killChild();
        });
        child.on('exit', () => {
          if (myGen !== generation) return; // a newer start owns the lane
          log(`sidecar exited (target pid ${processId} gone or the session ended)`);
          killChild();
        });
      }
      ensureCadence();
      log(`started for pid ${processId}`);
    } catch (err) {
      // spawn throws (ENOENT etc.) - the lane degrades, never throws.
      if (myGen === generation) {
        log(`spawn failed: ${err.message} - FPS falls back to DXGI`);
        killChild();
      }
    }
  };

  /** Kill the sidecar + stop the cadence + clear the per-pid state + the
   *  readings (a retarget never reports the previous game's rate; the
   *  ring rebuilds from the new target's stream). */
  const stop = () => {
    generation += 1;
    stopCadence();
    killChild();
    header = null;
    lines = [];
    pending = '';
    lastGood = null;
    lastGoodBufferIdentity = null;
    ring = [];
  };

  /** The last successful parse (never stale-filtered - the raw reading;
   *  null when nothing parsed yet). */
  const latest = () => lastGood;

  /**
   * The full fps sample the fps-poll consumes - freshness-gated (a
   * lastGood older than STALE_AFTER_MS is not a current reading -> null ->
   * the caller falls back to the DXGI adapter) with the percentile stats
   * from the lane's own ring. M17c (step-4 S1): lastGood.at is ONLY
   * re-stamped on ticks whose parse saw a NEWER row (the dry-stream gate
   * in tick()), so this at-gate is the honest stale horizon - a dry ETW
   * stream ages the last-good reading out exactly like a silent sidecar.
   * NEVER throws.
   * @param {number} [nowMs]
   * @returns {{ fps: number, avgFps: number | null, low1Pct: number | null, low01Pct: number | null, p99: number | null, frameTimeMs: null, gpuBusy: null } | null}
   */
  const sample = (nowMs) => {
    try {
      const at = nowMs ?? now();
      const last = lastGood;
      if (last === null || at - last.at > STALE_AFTER_MS) return null;
      const stats = percentileStats(ring, at, PERCENTILE_WINDOW_MS, AVG_WINDOW_MS);
      return {
        fps: Math.round(last.fps * 10) / 10,
        avgFps: stats === null ? null : stats.avgFps,
        low1Pct: stats === null ? null : stats.low1Pct,
        low01Pct: stats === null ? null : stats.low01Pct,
        p99: stats === null ? null : stats.p99,
        frameTimeMs: null,
        gpuBusy: null,
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
      return child !== null;
    },
    // M17c (step-4 N3): a same-target RESTART is eligible when the
    // sidecar ever produced a header (it demonstrably worked - a crash
    // recovery restarts immediately) OR the restart backoff elapsed (a
    // fresh attempt after 10-30 s - the ETW spawn loop becomes a bounded
    // one-attempt-per-backoff cadence instead of a per-second loop).
    get restartEligible() {
      return everSawHeader || (now() - lastStartAt) >= RESTART_BACKOFF_MS;
    },
  };
}

/**
 * M17c: the RETARGETING lane wrapper the fps-poll consumes - resolves the
 * foreground pid, restarts the sidecar on a pid change, and composes the
 * lane's sample. The caller (fps-poll in ipc-core) consults it FIRST and
 * falls back to the DXGI adapter when it reports null.
 *
 * RETARGET RULES (pinned - the HWiNFO wrong-process-pitfall handling):
 *   - no foreground window / probe failure (pid null)  -> keep the last
 *     target (a transient probe miss must not kill a game capture);
 *   - the foreground is Arc Power's own process tree (isOwnPid) -> keep
 *     the last target (the app must never measure itself; a game behind
 *     the app window keeps presenting and the lane keeps reporting it);
 *   - a NEW pid -> stop the old sidecar + start the new one;
 *   - the same pid with a dead sidecar -> restart it ONLY when the
 *     target process is still alive (the sidecar crashed / self-
 *     terminated while the target runs). M17c (step-4 N3): the restart
 *     is BACKOFF-GATED - a spawn that never produced a header (the
 *     unelevated ETW-access-denied shape: PresentMon prints + exits)
 *     waits out RESTART_BACKOFF_MS before another attempt (a per-second
 *     spawn loop is forbidden); a sidecar that once produced a header
 *     (it demonstrably worked) restarts immediately on a crash. M17c
 *     (step-5 S1): the restart is ALSO alive-GATED - the target that
 *     EXITED (--terminate_on_proc_exit self-exits the sidecar when the
 *     captured game closes, and the foreground transitions to the app's
 *     own window / the desktop keep the dead pid as targetPid) must NOT
 *     re-spawn the sidecar on every poll. isPidAlive(pid) is the gate:
 *     a dead target stays idle until a NEW pid arrives (the new-pid
 *     branch spawns unconditionally - unchanged).
 * The lane stays IDLE until the first poll (the sidecar spawns lazily -
 * no capture before anything asks for FPS).
 * @param {{
 *   source: ReturnType<typeof createPresentMonFpsSource>,
 *   resolveForegroundPid: () => Promise<number | null>,  // the foreground-window->pid resolver (foreground-api detectPid in the product path)
 *   isOwnPid?: (pid: number) => Promise<boolean>,        // the app's own process tree (main + renderer pids; default: nothing is ours)
 *   isPidAlive?: (pid: number) => Promise<boolean>,      // the same-pid restart's target-alive gate (default: the process.kill(pid, 0) probe - true when the process exists, false when the signal fails e.g. ESRCH)
 * }} deps
 * @returns {{ poll: (deviceId: number) => Promise<object | null>, stop: () => Promise<void>, retarget: () => Promise<void>, targetPid: number | null }}
 */
export function createPresentMonLane({ source, resolveForegroundPid, isOwnPid = async () => false, isPidAlive = async (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } } }) {
  let targetPid = null; // the pid the lane currently captures (null = idle)

  const retarget = async () => {
    try {
      const pid = await resolveForegroundPid();
      if (pid === null || !Number.isInteger(pid) || pid <= 0) return; // no foreground / probe failure -> keep the last target
      if (await isOwnPid(pid)) return; // the app's own window -> never measure ourselves
      if (pid === targetPid) {
        // M17c (step-5 S1): the same-pid restart is gated on the target
        // being ALIVE - a game that closed self-exits the sidecar
        // (--terminate_on_proc_exit) while the foreground transitions to
        // the app / desktop keep the dead pid as targetPid; without the
        // gate every poll would re-spawn the sidecar + re-create the ETW
        // session (a per-second spawn/teardown loop, forever). A dead
        // target stays idle until a NEW pid arrives.
        if (!source.active && source.restartEligible && await isPidAlive(pid)) source.start(pid); // sidecar died -> restart on the same target (M17c N3: gated by the restart backoff when no spawn ever produced a header - the unelevated ETW spawn loop is a bounded one-attempt-per-backoff cadence, never a per-second loop)
        return;
      }
      targetPid = pid;
      source.stop();
      source.start(pid); // a NEW target always spawns immediately (the backoff never blocks a new capture)
    } catch { /* retargeting never throws - a probe failure keeps the lane as-is */ }
  };

  /** The fps-poll entry: retarget first, then the lane's fresh sample. */
  const poll = async () => {
    await retarget();
    return source.sample();
  };

  const stop = async () => {
    try {
      source.stop();
    } catch { /* best effort */ }
    targetPid = null;
  };

  return { poll, stop, retarget, get targetPid() { return targetPid; } };
}
