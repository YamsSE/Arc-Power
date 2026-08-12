// Arc Power - M17d (Run E): the --profile-boot stage-timing harness.
//
// Env-gated: `ARC_POWER_PROFILE_BOOT=1` (or the `--profile-boot` argv flag)
// switches it on; otherwise `mark()` is a no-op and the module costs nothing
// in product runs. When on, each boot stage logs ONE structured line with its
// elapsed-from-launch (ms) + the delta since the previous mark, so the whole
// startup profile can be grepped out of a run's stdout:
//
//   [profile-boot] backend-init: +1234ms (420ms)
//
// The stages live in main.js (whenReady -> instance lock -> backend.init ->
// the seeds -> the adapters -> setupTray -> the boot-apply gate ->
// createWindow) + the renderer marks (first-paint / first-getCapabilities /
// boot-complete) forwarded from the window's console-message events.
//
// Electron-free so tests run under plain `node --test`.

/**
 * @returns {boolean} whether the profiling harness is enabled for this run.
 */
export function bootProfilingEnabled() {
  return process.env.ARC_POWER_PROFILE_BOOT === '1' || process.argv.includes('--profile-boot');
}

/**
 * Create a profiler. `now` + `log` are injectable for tests; the default t0
 * is the moment the profiler is created (module load = process launch for
 * the singleton below).
 * @param {{ enabled?: boolean, now?: () => number, log?: (line: string) => void }} [opts]
 */
export function createBootProfiler({ enabled = bootProfilingEnabled(), now = Date.now, log = (line) => console.log(line) } = {}) {
  const t0 = now();
  let last = t0;
  return {
    t0,
    get enabled() {
      return enabled;
    },
    /**
     * Record one boot stage. Returns null when disabled (no log line, no
     * state) - the harness's off-switch.
     * @param {string} name
     * @returns {{ name: string, elapsed: number, delta: number } | null}
     */
    mark(name) {
      if (!enabled) return null;
      const t = now();
      const elapsed = t - t0;
      const delta = t - last;
      last = t;
      log(`[profile-boot] ${name}: +${elapsed}ms (${delta}ms)`);
      return { name, elapsed, delta };
    },
  };
}

/** The session singleton - created at module import (t0 = launch). */
export const bootProfiler = createBootProfiler();

/**
 * Mark one boot stage on the session singleton. A no-op when the harness is
 * off (the product path pays one function call per stage, nothing else).
 * @param {string} name
 */
export function markProfileBoot(name) {
  return bootProfiler.mark(name);
}

/**
 * Elapsed-from-launch (ms) for the singleton - used by main.js to stamp the
 * forwarded renderer marks with the same clock as the main-process stages
 * (the renderer cannot see the main t0; its marks ride the console-message
 * events and get stamped at receipt). Null when the harness is off.
 * @returns {number|null}
 */
export function profileElapsedMs() {
  if (!bootProfiler.enabled) return null;
  return Date.now() - bootProfiler.t0;
}
