// M2a extension — IGS service parser (pure, no process calls) + mock adapter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseScQueryOutput,
  createMockIgs,
  ELEVATION_FAILED_MSG,
  buildElevatedScript,
  buildElevatedLaunch,
  classifyElevationError,
  getIgsServiceState,
  runElevatedCommand,
} from '../src/main/igs-service.js';

const QUERY_RUNNING = [
  'SERVICE_NAME: IntelGraphicsSoftwareService',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        STATE              : 4  RUNNING',
  '                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)',
  '        WIN32_EXIT_CODE    : 0  (0x0)',
].join('\n');

const QUERY_STOPPED = QUERY_RUNNING.replace('4  RUNNING', '1  STOPPED');

const QC_AUTO = [
  'SERVICE_NAME: IntelGraphicsSoftwareService',
  '        TYPE               : 10  WIN32_OWN_PROCESS',
  '        START_TYPE         : 2   AUTO_START',
  '        ERROR_CONTROL      : 1   NORMAL',
  '        DISPLAY_NAME       : Intel Graphics Software Service',
].join('\n');

// ---------------------------------------------------------------------------
// STATE parsing
// ---------------------------------------------------------------------------

test('parseScQueryOutput: RUNNING -> found, running', () => {
  assert.deepEqual(parseScQueryOutput(QUERY_RUNNING, '', 0), { found: true, running: true, startType: 'unknown' });
});

test('parseScQueryOutput: STOPPED -> found, not running', () => {
  assert.deepEqual(parseScQueryOutput(QUERY_STOPPED, '', 0), { found: true, running: false, startType: 'unknown' });
});

test('parseScQueryOutput: pending states count as running (still enforcing)', () => {
  for (const pending of ['2  START_PENDING', '3  STOP_PENDING']) {
    const out = parseScQueryOutput(QUERY_RUNNING.replace('4  RUNNING', pending), '', 0);
    assert.deepEqual(out, { found: true, running: true, startType: 'unknown' }, pending);
  }
});

test('parseScQueryOutput: unknown state code is found but not running', () => {
  const out = parseScQueryOutput(QUERY_RUNNING.replace('4  RUNNING', '5  PAUSED'), '', 0);
  assert.deepEqual(out, { found: true, running: false, startType: 'unknown' });
});

// ---------------------------------------------------------------------------
// START_TYPE parsing (from `sc qc`)
// ---------------------------------------------------------------------------

test('parseScQueryOutput: start type auto/manual/disabled', () => {
  assert.equal(parseScQueryOutput(QC_AUTO, '', 0).startType, 'auto');
  const manual = QC_AUTO.replace('2   AUTO_START', '3   DEMAND_START');
  assert.equal(parseScQueryOutput(manual, '', 0).startType, 'manual');
  const disabled = QC_AUTO.replace('2   AUTO_START', '4   DISABLED');
  assert.equal(parseScQueryOutput(disabled, '', 0).startType, 'disabled');
});

test('parseScQueryOutput: unknown start type -> unknown', () => {
  const bogus = QC_AUTO.replace('2   AUTO_START', '5   BOGUS_START');
  assert.equal(parseScQueryOutput(bogus, '', 0).startType, 'unknown');
});

test('parseScQueryOutput: combined query + qc output', () => {
  const out = parseScQueryOutput(`${QUERY_RUNNING}\n${QC_AUTO}`, '', 0);
  assert.deepEqual(out, { found: true, running: true, startType: 'auto' });
});

// ---------------------------------------------------------------------------
// Not found / garbage / robustness
// ---------------------------------------------------------------------------

test('parseScQueryOutput: exit 1060 (service does not exist) -> not found', () => {
  const stderr = 'The specified service does not exist as an installed service.';
  assert.deepEqual(parseScQueryOutput('', stderr, 1060), { found: false, running: false, startType: 'unknown' });
});

test('parseScQueryOutput: garbage input degrades, never throws', () => {
  assert.deepEqual(parseScQueryOutput('gibberish not a service line', '', 0), { found: false, running: false, startType: 'unknown' });
  assert.deepEqual(parseScQueryOutput('', 'access denied', 5), { found: false, running: false, startType: 'unknown' });
  assert.deepEqual(parseScQueryOutput(undefined, undefined, undefined), { found: false, running: false, startType: 'unknown' });
});

test('parseScQueryOutput: CRLF line endings parse identically', () => {
  const crlf = `${QUERY_RUNNING}\n${QC_AUTO}\n`.replace(/\n/g, '\r\n');
  assert.deepEqual(parseScQueryOutput(crlf, '', 0), { found: true, running: true, startType: 'auto' });
});

test('parseScQueryOutput: odd whitespace / indentation tolerated', () => {
  const weird = '   STATE   :   4   RUNNING   \n\tSTART_TYPE : 3 DEMAND_START';
  assert.deepEqual(parseScQueryOutput(weird, '', 0), { found: true, running: true, startType: 'manual' });
});

test('parseScQueryOutput: stderr noise is ignored when stdout is valid', () => {
  assert.deepEqual(parseScQueryOutput(QUERY_RUNNING, 'WARNING: unknown keyword', 0).running, true);
});

test('parseScQueryOutput: START_TYPE without STATE still yields startType, found stays false', () => {
  assert.deepEqual(parseScQueryOutput(QC_AUTO, '', 0), { found: false, running: false, startType: 'auto' });
});

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

test('createMockIgs: default (env unset) reports running (auto)', async () => {
  delete process.env.RID_MOCK_IGS_RUNNING;
  const igs = createMockIgs();
  assert.deepEqual(await igs.getState(), { found: true, running: true, startType: 'auto' });
});

test('createMockIgs: RID_MOCK_IGS_RUNNING=0 reports stopped (disabled)', async () => {
  process.env.RID_MOCK_IGS_RUNNING = '0';
  const igs = createMockIgs();
  assert.deepEqual(await igs.getState(), { found: true, running: false, startType: 'disabled' });
  delete process.env.RID_MOCK_IGS_RUNNING;
});

test('createMockIgs: disable/enable flip the in-memory state, always ok', async () => {
  delete process.env.RID_MOCK_IGS_RUNNING;
  const igs = createMockIgs();
  assert.deepEqual(await igs.disable(), { ok: true });
  assert.deepEqual(await igs.getState(), { found: true, running: false, startType: 'disabled' });
  assert.deepEqual(await igs.enable(), { ok: true });
  assert.deepEqual(await igs.getState(), { found: true, running: true, startType: 'auto' });
});

test('ELEVATION_FAILED_MSG: pinned user-facing string', () => {
  assert.equal(ELEVATION_FAILED_MSG, 'elevation declined or timed out');
});

// ---------------------------------------------------------------------------
// Elevated command construction (string invariants only — NEVER executed)
// ---------------------------------------------------------------------------

test('buildElevatedScript: disable = config disabled + stop; config result is authoritative', () => {
  const script = buildElevatedScript('disabled', false);
  assert.match(script, /& \$sc config IntelGraphicsSoftwareService start= disabled/);
  assert.match(script, /& \$sc stop IntelGraphicsSoftwareService/);
  assert.match(script, /if \(\$cfgExit -ne 0\) \{ exit \$cfgExit \}/);
  assert.ok(script.indexOf('start IntelGraphicsSoftwareService') === -1, 'disable must not start the service');
});

test('buildElevatedScript: enable = config demand + start (best-effort)', () => {
  const script = buildElevatedScript('demand', true);
  assert.match(script, /& \$sc config IntelGraphicsSoftwareService start= demand/);
  assert.match(script, /& \$sc start IntelGraphicsSoftwareService/);
  assert.ok(script.indexOf('stop IntelGraphicsSoftwareService') === -1, 'enable must not stop the service');
});

test('buildElevatedLaunch: RunAs + Wait + PassThru, error propagation, inner single quotes doubled', () => {
  const script = "& 'C:\\Windows\\System32\\sc.exe' config X start= disabled";
  const launch = buildElevatedLaunch(script);
  assert.match(launch, /Start-Process/);
  assert.match(launch, /-Verb RunAs -Wait -PassThru/);
  assert.match(launch, /-ErrorAction Stop/);
  assert.match(launch, /exit \$p\.ExitCode/);
  // The elevated launcher must use the module's ABSOLUTE powershell path —
  // never a PATH-resolved 'powershell.exe' at the elevation boundary.
  assert.ok(launch.includes("-FilePath 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'"), `launch: ${launch}`);
  // The inner script is a single-quoted -ArgumentList element; embedded
  // single quotes must be doubled (PowerShell '...''...' escaping).
  assert.ok(launch.includes("'& ''C:\\Windows\\System32\\sc.exe'' config X start= disabled'"), `launch: ${launch}`);
});

// ---------------------------------------------------------------------------
// classifyElevationError (pure classification of elevated-helper failures)
// ---------------------------------------------------------------------------

test('classifyElevationError: timeout (killed) is a decline -> spec string', () => {
  assert.equal(classifyElevationError({ killed: true, code: null, signal: 'SIGTERM' }), ELEVATION_FAILED_MSG);
});

test('classifyElevationError: exit code 1223 (ERROR_CANCELLED) is a decline -> spec string', () => {
  assert.equal(classifyElevationError({ code: 1223 }), ELEVATION_FAILED_MSG);
  assert.equal(classifyElevationError({ code: 1223, stderr: '' }), ELEVATION_FAILED_MSG);
});

test('classifyElevationError: English "canceled by the user" stderr is a decline -> spec string', () => {
  const err = { code: 1, stderr: 'Start-Process : This command cannot be run due to the error: The operation was canceled by the user.' };
  assert.equal(classifyElevationError(err), ELEVATION_FAILED_MSG);
});

test('classifyElevationError: localized decline messages are declines (de/fr/es)', () => {
  for (const stderr of [
    'Start-Process : Der Vorgang wurde vom Benutzer abgebrochen.',
    "Start-Process : L'opération a été annulée par l'utilisateur.",
    'Start-Process : La operación fue cancelada por el usuario.',
    'Start-Process : L\'operazione è stata annullata dall\'utente.',
  ]) {
    assert.equal(classifyElevationError({ code: 1, stderr }), ELEVATION_FAILED_MSG, stderr);
  }
});

test('classifyElevationError: RunAs decline signature ("requires elevation") is a decline -> spec string', () => {
  const err = { code: 1, stderr: 'Start-Process : This command cannot be run due to the error: The requested operation requires elevation.' };
  assert.equal(classifyElevationError(err), ELEVATION_FAILED_MSG);
});

test('classifyElevationError: spawn failure (code null) -> spec string (self-healing path)', () => {
  assert.equal(classifyElevationError({ code: null, stderr: '' }), ELEVATION_FAILED_MSG);
  assert.equal(classifyElevationError({}), ELEVATION_FAILED_MSG);
});

test('classifyElevationError: other non-zero exits -> "service command failed (exit N)"', () => {
  assert.equal(classifyElevationError({ code: 1060, stderr: 'The specified service does not exist as an installed service.' }), 'service command failed (exit 1060)');
  assert.equal(classifyElevationError({ code: 1, stderr: 'Access is denied.' }), 'service command failed (exit 1)');
  assert.equal(classifyElevationError({ code: 5 }), 'service command failed (exit 5)');
});

// ---------------------------------------------------------------------------
// Probes: timeout + degraded paths (injected execFile, never real sc.exe)
// ---------------------------------------------------------------------------

test('getIgsServiceState: every sc.exe probe carries a 10s timeout — a hung probe can never stall boot', async () => {
  const seen = [];
  const exec = async (cmd, args, options) => {
    seen.push({ cmd, args, timeout: options?.timeout });
    throw Object.assign(new Error('spawn failed'), { code: null, killed: true });
  };
  const state = await getIgsServiceState({ execFile: exec });
  assert.deepEqual(state, { found: false, running: false, startType: 'unknown' });
  assert.ok(seen.length >= 1, 'the state probe must invoke execFile');
  assert.equal(seen[0].cmd, 'C:\\Windows\\System32\\sc.exe');
  assert.equal(seen[0].timeout, 10000);
});

test('getIgsServiceState: a hung sc.exe degrades after the probe timeout instead of stalling boot', async () => {
  const exec = (_cmd, _args, options) => new Promise((resolve, reject) => {
    // Mimic promisified execFile's timeout kill: reject with killed:true
    // once the probe's own timeout fires (never resolve — a real hang).
    setTimeout(() => reject(Object.assign(new Error('timeout'), { killed: true, code: null })), options?.timeout ?? 0);
  });
  const t0 = Date.now();
  const state = await getIgsServiceState({ execFile: exec, probeTimeoutMs: 50 });
  const elapsed = Date.now() - t0;
  assert.deepEqual(state, { found: false, running: false, startType: 'unknown' });
  assert.ok(elapsed >= 50, `degraded before the probe timeout window (${elapsed}ms) — timeout option not honored`);
  assert.ok(elapsed < 1000, `degraded long after the probe timeout (${elapsed}ms) — the probe must not hang boot`);
});

test('getIgsServiceState: a numeric non-zero exit (1060) is NOT degraded — parsed as not found', async () => {
  const exec = async (cmd, args) => {
    if (args[0] === 'query') {
      throw Object.assign(new Error('exit 1060'), { code: 1060, stdout: '', stderr: 'The specified service does not exist as an installed service.' });
    }
    return { stdout: '', stderr: '' };
  };
  const state = await getIgsServiceState({ execFile: exec });
  assert.deepEqual(state, { found: false, running: false, startType: 'unknown' });
});

test('buildElevatedLaunch: -ArgumentList elements are quoted; the script stays one element before -Verb', () => {
  const launch = buildElevatedLaunch(buildElevatedScript('disabled', false));
  assert.match(launch, /-ArgumentList '-NoProfile', '-Command', /);
  assert.match(launch, /' -Verb RunAs -Wait -PassThru/);
  // The doubled-quoted exe path survives inside the quoted script element.
  assert.ok(launch.includes("''C:\\Windows\\System32\\sc.exe''"), launch);
});

// ---------------------------------------------------------------------------
// runElevatedCommand (injected execFile — never the real elevated helper)
// ---------------------------------------------------------------------------

test('runElevatedCommand: a resolved execFile (exit 0) is a success', async () => {
  // promisify(execFile) resolves `{ stdout, stderr }` — NO `code` field.
  // Without the fix, `code` destructures as undefined, `code === 0` is never
  // true, and this falls through to classifyElevationError({ code: undefined })
  // -> ELEVATION_FAILED_MSG. This test fails on the old implementation.
  const exec = async (cmd, args) => {
    assert.equal(cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    assert.equal(args[0], '-NoProfile');
    assert.equal(args[1], '-Command');
    return { stdout: '', stderr: '' };
  };
  const result = await runElevatedCommand(buildElevatedScript('disabled', false), { execFile: exec });
  assert.deepEqual(result, { ok: true });
});

test('runElevatedCommand: reject { code: 1223 } (ERROR_CANCELLED decline) routes through the classifier', async () => {
  const exec = async () => {
    throw Object.assign(new Error('declined'), { code: 1223, stderr: '' });
  };
  const result = await runElevatedCommand(buildElevatedScript('disabled', false), { execFile: exec });
  assert.deepEqual(result, { ok: false, error: ELEVATION_FAILED_MSG });
});

test('runElevatedCommand: reject { code: 5 } reports "service command failed (exit 5)"', async () => {
  const exec = async () => {
    throw Object.assign(new Error('exit 5'), { code: 5, stderr: 'Access is denied.' });
  };
  const result = await runElevatedCommand(buildElevatedScript('demand', true), { execFile: exec });
  assert.deepEqual(result, { ok: false, error: 'service command failed (exit 5)' });
});
