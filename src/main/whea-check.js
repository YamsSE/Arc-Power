// Windows Hardware Error Architecture (WHEA) event monitor for Stability Lab.
// The reader is deliberately isolated behind a small async seam so the
// stability lifecycle stays testable without depending on Event Log access.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const POWERSHELL = process.env.SystemRoot
  ? `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe';
const QUERY = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '__START__',
  '$events = @(Get-WinEvent -FilterHashtable @{ LogName = "System"; ProviderName = "Microsoft-Windows-WHEA-Logger"; StartTime = $start } -ErrorAction SilentlyContinue)',
  'if ($null -eq $events) { "0" } else { $events.Count.ToString() }',
].join('; ');

function parseCount(stdout) {
  const count = Number.parseInt(String(stdout ?? '').trim().split(/\s+/)[0] ?? '', 10);
  return Number.isFinite(count) && count >= 0 ? count : null;
}

export function createWheaMonitor({
  execFileImpl = execFileAsync,
  platform = process.platform,
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (id) => clearInterval(id),
  pollMs = 1000,
} = {}) {
  let startedAtMs = null;
  let timer = null;
  let inFlight = null;
  let state = {
    available: platform === 'win32',
    checked: false,
    errorCount: 0,
    error: null,
    lastCheckedAt: null,
  };

  const refresh = async () => {
    if (startedAtMs === null || platform !== 'win32' || inFlight) return state;
    const iso = new Date(startedAtMs).toISOString().replace(/'/g, "''");
    const query = QUERY.replace('__START__', `$start = [DateTimeOffset]::Parse('${iso}').UtcDateTime`);
    inFlight = Promise.resolve(execFileImpl(POWERSHELL, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', query,
    ], { windowsHide: true, maxBuffer: 1024 * 1024 }))
      .then(({ stdout }) => {
        const errorCount = parseCount(stdout);
        state = {
          ...state,
          available: true,
          checked: true,
          errorCount: errorCount ?? state.errorCount,
          error: errorCount === null ? 'WHEA Event Log returned an invalid count' : null,
          lastCheckedAt: Date.now(),
        };
        return state;
      })
      .catch((error) => {
        state = {
          ...state,
          available: false,
          checked: true,
          error: error instanceof Error ? error.message.slice(0, 240) : String(error).slice(0, 240),
          lastCheckedAt: Date.now(),
        };
        return state;
      })
      .finally(() => { inFlight = null; });
    return inFlight;
  };

  return {
    async start(startedAt = Date.now()) {
      if (timer !== null) clearTimer(timer);
      startedAtMs = Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now();
      state = {
        available: platform === 'win32', checked: false, errorCount: 0, error: null, lastCheckedAt: null,
      };
      await refresh();
      timer = setTimer(() => { void refresh(); }, Math.max(250, Number(pollMs) || 1000));
      return { ...state };
    },
    snapshot() { return { ...state }; },
    async stop() {
      if (timer !== null) { clearTimer(timer); timer = null; }
      await refresh();
      const result = { ...state };
      startedAtMs = null;
      return result;
    },
  };
}

export { parseCount };
