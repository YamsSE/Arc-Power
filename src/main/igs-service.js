// Arc Power — IntelGraphicsSoftwareService probe + control (M2a extension).
//
// The IGS service blocks OC writes (power/freq/temp) from other apps while it
// runs (docs/igcl-integration.md §8a, verified both directions on the A770).
// This module detects the service state (read-only, safe to run at boot) and
// exposes the disable/enable actions, which spawn an ELEVATED helper via
// Start-Process -Verb RunAs — those run ONLY on an explicit user click from
// the renderer, never at boot and never in mock mode.
//
// The parser is pure (no process calls) and unit-tested; the probes degrade
// to "not detected" instead of throwing — the app must not go red because a
// probe failed.

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

const SC_EXE = 'C:\\Windows\\System32\\sc.exe';
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const SERVICE_NAME = 'IntelGraphicsSoftwareService';
// sc.exe exit code for "The specified service does not exist".
const ERROR_SERVICE_DOES_NOT_EXIST = 1060;
// Win32 ERROR_CANCELLED — the locale-independent marker of a declined UAC
// prompt (Start-Process -Verb RunAs failure / sc failure surface it).
const ERROR_CANCELLED_CODE = 1223;
// Every sc.exe probe gets a hard timeout: a hung sc would otherwise stall
// boot (the renderer awaits the probe at startup). A timeout degrades to
// "not detected" like any other probe failure.
const SC_PROBE_TIMEOUT_MS = 10000;
// UAC decline / timeout surface as this exact error string (spec).
export const ELEVATION_FAILED_MSG = 'elevation declined or timed out';
// Decline signatures beyond the English "canceled by the user": localized
// PowerShell messages (de/fr/es/it), the RunAs failure when no desktop
// session can show a prompt ("requires elevation"), and the ERROR_CANCELLED
// code (1223) itself. Exit code 1223 is also classified as declined.
const ELEVATION_DECLINE_RE = /canceled by the user|cancelled by the user|abgebrochen|annul|cancelada|annull|requires elevation|elevation required|ERROR_CANCELLED|\b1223\b/i;

export const DEGRADED_STATE = Object.freeze({ found: false, running: false, startType: 'unknown' });

// ---------------------------------------------------------------------------
// Pure parser (unit-testable, no process calls)
// ---------------------------------------------------------------------------

const RUNNING_STATES = new Set(['RUNNING', 'START_PENDING', 'STOP_PENDING']);
const RUNNING_CODES = new Set(['4', '2', '3']); // RUNNING / START_PENDING / STOP_PENDING
const START_TYPE_MAP = {
  AUTO_START: 'auto',
  DEMAND_START: 'manual',
  DISABLED: 'disabled',
  '2': 'auto',
  '3': 'manual',
  '4': 'disabled',
};

/**
 * Parse `sc query` / `sc qc` output into a service state. Robust against
 * whitespace, CRLF and stderr noise; never throws.
 * @param {string} stdout output of `sc query` + `sc qc` (either may be absent)
 * @param {string} [stderr] ignored — kept for signature symmetry
 * @param {number} [exitCode] sc.exe exit code; 1060 => service does not exist
 * @returns {{ found: boolean, running: boolean, startType: 'auto'|'manual'|'disabled'|'unknown' }}
 */
export function parseScQueryOutput(stdout, stderr = '', exitCode = 0) {
  if (exitCode === ERROR_SERVICE_DOES_NOT_EXIST) {
    return { found: false, running: false, startType: 'unknown' };
  }
  const text = String(stdout ?? '').replace(/\r\n/g, '\n');
  const stateLine = matchFieldLine(text, 'STATE');
  const startLine = matchFieldLine(text, 'START_TYPE');
  if (!stateLine) {
    return { found: false, running: false, startType: parseStartType(startLine) };
  }
  return {
    found: true,
    running: parseRunning(stateLine),
    startType: parseStartType(startLine),
  };
}

/** Extract the first `FIELD : value` line (label anchored, ignores indentation). */
function matchFieldLine(text, field) {
  const m = text.match(new RegExp(`^\\s*${field}\\s*:\\s*(.+?)\\s*$`, 'm'));
  return m ? m[1] : null;
}

/**
 * A state value is "running" when it is RUNNING or one of the pending states
 * (START_PENDING/STOP_PENDING — the process is still enforcing while pending).
 * @param {string} line e.g. "4  RUNNING" / "1 STOPPED" / "2 START_PENDING"
 */
function parseRunning(line) {
  const m = line.trim().match(/^(\d)\s+([A-Z_]+)$/);
  if (!m) return false;
  return RUNNING_STATES.has(m[2]) || RUNNING_CODES.has(m[1]);
}

/**
 * @param {string|null} line e.g. "2   AUTO_START" / "3   DEMAND_START" / "4   DISABLED"
 * @returns {'auto'|'manual'|'disabled'|'unknown'}
 */
function parseStartType(line) {
  if (!line) return 'unknown';
  const m = line.trim().match(/^(\d)\s+([A-Z_]+)$/);
  if (!m) return 'unknown';
  return START_TYPE_MAP[m[2]] ?? START_TYPE_MAP[m[1]] ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Probes (read-only; safe at boot)
// ---------------------------------------------------------------------------

/**
 * Run one sc.exe invocation; never throws. Returns the exit code (null when
 * the process could not be spawned at all, and for timeouts — both treated
 * as a degraded probe). A hung sc.exe is killed after `timeoutMs` instead of
 * stalling the boot probe forever.
 */
async function runSc(args, exec = execFile, timeoutMs = SC_PROBE_TIMEOUT_MS) {
  try {
    const { stdout, stderr } = await exec(SC_EXE, args, { windowsHide: true, maxBuffer: 64 * 1024, timeout: timeoutMs });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const code = typeof err.code === 'number' ? err.code : null;
    return {
      code,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
      degraded: code === null || err?.killed === true,
    };
  }
}

/**
 * Current IGS service state. Never throws — network/parse/spawn/timeout
 * failures degrade to `{ found: false, running: false, startType: 'unknown' }`.
 * `execFile` and `probeTimeoutMs` are injectable for unit tests only.
 * @param {{ execFile?: typeof execFile, probeTimeoutMs?: number }} [deps]
 * @returns {Promise<{ found: boolean, running: boolean, startType: string }>}
 */
export async function getIgsServiceState({ execFile: exec = execFile, probeTimeoutMs = SC_PROBE_TIMEOUT_MS } = {}) {
  try {
    const query = await runSc(['query', SERVICE_NAME], exec, probeTimeoutMs);
    if (query.degraded) return { ...DEGRADED_STATE };
    const qc = await runSc(['qc', SERVICE_NAME], exec, probeTimeoutMs);
    if (qc.degraded) return { ...DEGRADED_STATE };
    const notFound = query.code === ERROR_SERVICE_DOES_NOT_EXIST || qc.code === ERROR_SERVICE_DOES_NOT_EXIST;
    return parseScQueryOutput(
      `${query.stdout}\n${qc.stdout}`,
      `${query.stderr}\n${qc.stderr}`,
      notFound ? ERROR_SERVICE_DOES_NOT_EXIST : 0,
    );
  } catch {
    return { ...DEGRADED_STATE };
  }
}

// ---------------------------------------------------------------------------
// Elevation (disable/enable — explicit user action ONLY)
// ---------------------------------------------------------------------------

/**
 * The elevated script: `sc config <svc> start= <value>`, then a best-effort
 * stop (disable) or start (enable). The config result is authoritative; the
 * stop/start is best-effort (already-stopped/running races must not fail).
 * Exported for unit-testing the quoting/exit-code invariants without ever
 * running it (the safety rule: the real commands run only on a user click).
 */
export function buildElevatedScript(configValue, withStart) {
  const cmds = [
    `$sc = '${SC_EXE}'`,
    `& $sc config ${SERVICE_NAME} start= ${configValue} | Out-Null`,
    '$cfgExit = $LASTEXITCODE',
    'if ($cfgExit -ne 0) { exit $cfgExit }',
    withStart
      ? `& $sc start ${SERVICE_NAME} | Out-Null`
      : `& $sc stop ${SERVICE_NAME} | Out-Null`,
    'exit 0',
  ];
  return cmds.join('; ');
}

/**
 * Outer launcher: Start-Process -Verb RunAs -Wait -PassThru (UAC prompt on
 * the user's machine), propagating the elevated script's exit code. A UAC
 * decline makes Start-Process fail with -ErrorAction Stop -> exit 1.
 * The launcher uses the module's absolute POWERSHELL_EXE constant (never
 * PATH-resolved 'powershell.exe') — PATH is not a trust boundary to rely on
 * at the elevation boundary.
 * Exported for unit-testing the argument quoting without executing it.
 */
export function buildElevatedLaunch(script) {
  const innerArgs = ['-NoProfile', '-Command', script]
    .map((a) => `'${a.replace(/'/g, "''")}'`)
    .join(', ');
  return `$p = Start-Process -FilePath '${POWERSHELL_EXE}' -ArgumentList ${innerArgs} -Verb RunAs -Wait -PassThru -ErrorAction Stop; if ($null -eq $p) { exit 1 }; exit $p.ExitCode`;
}

/**
 * Pure classification of an elevated-helper failure. Returns the spec string
 * `elevation declined or timed out` when the failure is a UAC decline or a
 * timeout — decline signatures: process killed by the timeout, the
 * locale-independent ERROR_CANCELLED exit code (1223), the English and
 * localized "canceled by the user" messages, and the RunAs "requires
 * elevation" failure (no desktop session can show a prompt). A spawn failure
 * (code null) also reads as declined-or-timed-out (the UI self-heals via the
 * post-action state refresh either way). Everything else reports the exit
 * code so the UI can still toast a specific error.
 * @param {unknown} err execFile rejection (or `{ code }` for a non-zero exit)
 * @returns {string}
 */
export function classifyElevationError(err) {
  const timedOut = err?.killed === true;
  const code = typeof err?.code === 'number' ? err.code : null;
  const text = `${err?.stderr ?? ''}${err?.stdout ?? ''}`;
  const declined = timedOut || code === ERROR_CANCELLED_CODE || code === null || ELEVATION_DECLINE_RE.test(text);
  if (declined) return ELEVATION_FAILED_MSG;
  return `service command failed (exit ${code})`;
}

/**
 * Run an elevated action. Returns `{ ok: true }` on success; UAC
 * decline/timeout surface as `{ ok: false, error: 'elevation declined or
 * timed out' }` — never a crash. Other non-zero exits (e.g. the service does
 * not exist) report the exit code so the UI can still toast an error.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function runElevatedCommand(script, { execFile: exec = execFile, timeoutMs = 120000 } = {}) {
  try {
    // promisified execFile resolves ONLY on exit 0 — any non-zero exit
    // rejects into the catch below. Success must not depend on a resolved
    // `code` field (promisify(execFile) resolves `{ stdout, stderr }`).
    await exec(POWERSHELL_EXE, ['-NoProfile', '-Command', buildElevatedLaunch(script)], {
      windowsHide: true,
      timeout: timeoutMs,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: classifyElevationError(err) };
  }
}

/**
 * Disable the IGS service (elevated): set start= disabled + stop it.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function disableIgsService() {
  return runElevatedCommand(buildElevatedScript('disabled', false));
}

/**
 * Re-enable the IGS service (elevated): set start= demand + start it.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function enableIgsService() {
  return runElevatedCommand(buildElevatedScript('demand', true));
}

// ---------------------------------------------------------------------------
// Adapters for the IPC layer
// ---------------------------------------------------------------------------

/**
 * Real service adapter — injected into the IPC handlers in the product path.
 */
export function createIgs() {
  return {
    getState: getIgsServiceState,
    disable: disableIgsService,
    enable: enableIgsService,
  };
}

/**
 * Mock adapter — used whenever the app runs in mock mode (tests, --ui-verify,
 * RID_BACKEND=mock). Reads RID_MOCK_IGS_RUNNING at construction: anything
 * other than "0" reports running (startType 'auto', matching this machine);
 * "0" reports stopped (startType 'disabled'). disable/enable just flip the
 * in-memory state — no elevation, no service, no spawned process.
 */
export function createMockIgs(initialRunning = process.env.RID_MOCK_IGS_RUNNING) {
  let running = initialRunning !== '0';
  return {
    getState: async () => ({ found: true, running, startType: running ? 'auto' : 'disabled' }),
    disable: async () => { running = false; return { ok: true }; },
    enable: async () => { running = true; return { ok: true }; },
  };
}
