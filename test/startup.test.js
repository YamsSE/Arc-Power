// M2b/M2C-C — apply-on-startup registration tests: pure value parsing + the
// real adapter (schtasks elevated task + reg.exe Run key) with injected
// execFile/runElevated fakes. NO real registry, scheduler or UAC access
// anywhere — the fakes never spawn anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunValue, parseRunValue, parseRegQuery, parseSchTasksQuery,
  createStartup, createMockStartup, psSingleQuote,
  RUN_KEY, RUN_VALUE, REG_NOT_FOUND, TASK_NAME,
  buildTaskCreateScript, buildTaskDeleteScript,
} from '../src/main/startup.js';

// ---------------------------------------------------------------------------
// Pure value building/parsing
// ---------------------------------------------------------------------------

test('buildRunValue: quotes the executable and appends --apply-profile', () => {
  assert.equal(
    buildRunValue('C:\\Program Files\\Arc Power\\Arc Power.exe', 'prof-1'),
    '"C:\\Program Files\\Arc Power\\Arc Power.exe" --apply-profile prof-1',
  );
});

test('parseRunValue: round-trips a stored value', () => {
  const value = buildRunValue('C:\\apps\\arc.exe', 'prof-1');
  assert.deepEqual(parseRunValue(value), { execPath: 'C:\\apps\\arc.exe', profileId: 'prof-1' });
});

test('parseRunValue: rejects foreign values (not ours)', () => {
  assert.equal(parseRunValue('"C:\\x.exe" --something else'), null);
  assert.equal(parseRunValue('C:\\x.exe --apply-profile p'), null); // unquoted exec path
  assert.equal(parseRunValue(''), null);
  assert.equal(parseRunValue(42), null);
  assert.equal(parseRunValue(null), null);
});

test('parseRegQuery: parses reg query output and maps absent -> null', () => {
  const out = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
    ArcPower    REG_SZ    "C:\\Apps\\Arc Power.exe" --apply-profile p1`;
  assert.deepEqual(parseRegQuery(out), { execPath: 'C:\\Apps\\Arc Power.exe', profileId: 'p1' });
  assert.equal(parseRegQuery('nothing here', 0), null);
  assert.equal(parseRegQuery('', REG_NOT_FOUND), null);
});

// ---------------------------------------------------------------------------
// Scheduled-task parsing + scripts (M2C-C)
// ---------------------------------------------------------------------------

test('parseSchTasksQuery: parses the task action into execPath + profileId', () => {
  const out = `Folder: \\\nTaskName: \\ArcPowerApplyOnBoot\nStatus: Ready\n...\nTask To Run: "C:\\Apps\\Arc Power.exe" --apply-profile p1\n...`;
  assert.deepEqual(parseSchTasksQuery(out), { execPath: 'C:\\Apps\\Arc Power.exe', profileId: 'p1' });
});

test('parseSchTasksQuery: absent task (0x41303 / 0x41301) and foreign actions -> null', () => {
  assert.equal(parseSchTasksQuery('', 0x41303), null);
  assert.equal(parseSchTasksQuery('', 0x41301), null);
  assert.equal(parseSchTasksQuery('Task To Run: "C:\\other.exe" --flag', 0), null);
});

test('buildTaskCreateScript: /sc onlogon /rl highest with the quoted command', () => {
  const script = buildTaskCreateScript('C:\\Apps\\Arc Power.exe', 'p1');
  assert.match(script, /schtasks \/create \/tn ArcPowerApplyOnBoot \/sc onlogon \/rl highest/);
  assert.match(script, /"C:\\Apps\\Arc Power.exe" --apply-profile p1/);
  assert.match(script, /exit \$LASTEXITCODE/);
});

test('buildTaskDeleteScript: deletes the task, treats an absent task as success', () => {
  const script = buildTaskDeleteScript();
  assert.match(script, /schtasks \/delete \/tn ArcPowerApplyOnBoot \/f/);
});

test('M3: psSingleQuote doubles single quotes (the PowerShell literal rule)', () => {
  assert.equal(psSingleQuote('plain'), 'plain');
  assert.equal(psSingleQuote("p'1"), "p''1");
  assert.equal(psSingleQuote("a'b'c"), "a''b''c");
  assert.equal(psSingleQuote("''"), "''''");
});

test('M3: a quote in profileId/execPath round-trips through buildTaskCreateScript without breaking the PS literal', () => {
  const script = buildTaskCreateScript("C:\\Apps\\Arc' Power.exe", "p'1");
  // The interpolated value must be PS-single-quote-escaped (' -> '').
  assert.match(script, /\$tr = '"C:\\Apps\\Arc'' Power\.exe" --apply-profile p''1'/);
  // Every ' in the literal is doubled: the number of ' in the $tr line is even.
  const trLine = script.split(';')[0];
  assert.equal((trLine.match(/'/g) ?? []).length % 2, 0, 'balanced quoting — the script parses');
  // The task command itself stays intact.
  assert.match(script, /schtasks \/create \/tn ArcPowerApplyOnBoot \/sc onlogon \/rl highest/);
});

test('M3: buildTaskDeleteScript stays well-formed with the same quoting rule', () => {
  // No interpolated user data, but the delete script must still be a valid
  // balanced single-quoted literal set.
  const script = buildTaskDeleteScript();
  const quoted = script.match(/'/g) ?? [];
  assert.equal(quoted.length % 2, 0, 'balanced quoting');
  assert.match(script, /schtasks \/delete \/tn ArcPowerApplyOnBoot \/f/);
});

// ---------------------------------------------------------------------------
// Real adapter with injected execFile/runElevated fakes
// ---------------------------------------------------------------------------

function fakeExecFile(results) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const r = results.shift();
    if (r && r.error) throw r.error;
    return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  };
  return { exec, calls };
}

function fakeElevated(results) {
  const calls = [];
  const runElevated = async (script) => {
    calls.push(script);
    const r = results.shift();
    if (r && r.error) throw r.error;
    return r ?? { ok: true };
  };
  return { runElevated, calls };
}

const taskQueryOut = (profileId, execPath = 'C:\\Apps\\Arc Power.exe') =>
  `Folder: \\\nTaskName: \\ArcPowerApplyOnBoot\nTask To Run: "${execPath}" --apply-profile ${profileId}`;

test('set(enabled=true): creates the ELEVATED task, cleans the Run key, reports mechanism task', async () => {
  const { exec, calls } = fakeExecFile([{ stdout: '' }]);
  const { runElevated, calls: elevCalls } = fakeElevated([{ ok: true }]);
  const startup = createStartup({ execFile: exec, execPath: 'C:\\Apps\\Arc Power.exe', runElevated });
  const out = await startup.set(true, 'p1');
  assert.deepEqual(out, {
    enabled: true, profileId: 'p1',
    value: '"C:\\Apps\\Arc Power.exe" --apply-profile p1',
    mechanism: 'task',
  });
  assert.equal(elevCalls.length, 1, 'exactly ONE elevated call (one UAC at enable)');
  assert.match(elevCalls[0], /schtasks \/create \/tn ArcPowerApplyOnBoot/);
  // the Run key cleanup ran (reg delete)
  assert.ok(calls.some((c) => c.cmd === 'reg' && c.args[0] === 'delete'));
});

test('set(enabled=true): an elevated failure (UAC declined) throws with the honest error', async () => {
  const { exec } = fakeExecFile([]);
  const { runElevated } = fakeElevated([{ ok: false, error: 'elevation declined or timed out' }]);
  const startup = createStartup({ execFile: exec, runElevated });
  await assert.rejects(() => startup.set(true, 'p1'), /elevation declined or timed out/);
});

test('set(enabled=false): deletes the task (elevated) + the Run key (absent = success)', async () => {
  const { exec, calls } = fakeExecFile([{ error: { code: REG_NOT_FOUND } }]);
  const { runElevated, calls: elevCalls } = fakeElevated([{ ok: true }]);
  const startup = createStartup({ execFile: exec, runElevated });
  const out = await startup.set(false, null);
  assert.deepEqual(out, { enabled: false, profileId: null, value: null, mechanism: null });
  assert.match(elevCalls[0], /schtasks \/delete \/tn ArcPowerApplyOnBoot/);
  assert.ok(calls.some((c) => c.cmd === 'reg' && c.args[0] === 'delete'));
});

test('set(enabled=false): an elevated task-delete failure propagates', async () => {
  const { exec } = fakeExecFile([]);
  const { runElevated } = fakeElevated([{ ok: false, error: 'elevation declined or timed out' }]);
  const startup = createStartup({ execFile: exec, runElevated });
  await assert.rejects(() => startup.set(false, null), /elevation declined or timed out/);
});

test('set(enabled=true) without profileId throws (validation is in the adapter too)', async () => {
  const startup = createStartup({ execFile: fakeExecFile([]).exec });
  await assert.rejects(() => startup.set(true, null), /profileId is required/);
});

test('get: the scheduled task is the primary mechanism', async () => {
  const { exec } = fakeExecFile([{ stdout: taskQueryOut('p9') }]);
  const out = await createStartup({ execFile: exec }).get();
  assert.deepEqual(out, { enabled: true, profileId: 'p9', value: '"C:\\Apps\\Arc Power.exe" --apply-profile p9', mechanism: 'task' });
});

test('get: task absent -> Run key fallback (mechanism run-key)', async () => {
  const found = fakeExecFile([
    { error: { code: 0x41303 } }, // schtasks: task not found
    { stdout: `...\\Run\n    ArcPower    REG_SZ    "C:\\A.exe" --apply-profile p9` },
  ]);
  const out1 = await createStartup({ execFile: found.exec }).get();
  assert.deepEqual(out1, { enabled: true, profileId: 'p9', value: '"C:\\A.exe" --apply-profile p9', mechanism: 'run-key' });

  const missing = fakeExecFile([
    { error: { code: 0x41303 } },
    { error: { code: REG_NOT_FOUND } },
  ]);
  const out2 = await createStartup({ execFile: missing.exec }).get();
  assert.deepEqual(out2, { enabled: false, profileId: null, value: null, mechanism: null });
});

test('get: a foreign task action is ignored (falls through to the Run key)', async () => {
  const found = fakeExecFile([
    { stdout: `Task To Run: "C:\\other.exe" --flag` },
    { stdout: `...\\Run\n    ArcPower    REG_SZ    "C:\\A.exe" --apply-profile p9` },
  ]);
  const out = await createStartup({ execFile: found.exec }).get();
  assert.equal(out.mechanism, 'run-key');
  assert.equal(out.profileId, 'p9');
});

test('get: query errors propagate (caller degrades)', async () => {
  const fake = fakeExecFile([{ error: { message: 'schtasks not found' } }, { error: { message: 'reg not found on PATH' } }]);
  await assert.rejects(() => createStartup({ execFile: fake.exec }).get(), /startup query failed/);
});

// ---------------------------------------------------------------------------
// Mock adapter (the default for tests/ui-verify — nothing real)
// ---------------------------------------------------------------------------

test('mock startup: in-memory set/get round trip, no processes, mechanism task', async () => {
  const startup = createMockStartup();
  assert.deepEqual(await startup.get(), { enabled: false, profileId: null, value: null, mechanism: null });
  const out = await startup.set(true, 'p1');
  assert.equal(out.enabled, true);
  assert.equal(out.profileId, 'p1');
  assert.equal(out.mechanism, 'task');
  assert.deepEqual(await startup.get(), out);
  await startup.set(false, null);
  assert.deepEqual(await startup.get(), { enabled: false, profileId: null, value: null, mechanism: null });
});

test('mock startup: enabling without a profileId throws', async () => {
  const startup = createMockStartup();
  await assert.rejects(() => startup.set(true, null), /profileId is required/);
});
