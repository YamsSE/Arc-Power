// M2b/M2C-C — apply-on-startup registration tests: pure value parsing + the
// real adapter (schtasks elevated task + reg.exe Run key) with injected
// execFile/runElevated fakes. NO real registry, scheduler or UAC access
// anywhere — the fakes never spawn anything.
//
// M4-D: the plain-app variant (ArcPowerAppOnBoot, no --apply-profile) +
// the two-task coexistence rule (enabling one deletes the other in the
// same elevated call) + the combined startup-get shape
// ({ startupRunKey, applyOnBoot, startWithWindows }).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunValue, parseRunValue, parseRegQuery, parseSchTasksQuery,
  buildAppRunValue, parseAppRunValue, parseSchTasksAppQuery,
  createStartup, createMockStartup, psSingleQuote,
  RUN_KEY, RUN_VALUE, REG_NOT_FOUND, TASK_NAME, APP_TASK_NAME,
  buildTaskCreateScript, buildTaskDeleteScript,
  buildAppTaskCreateScript, buildAppTaskDeleteScript,
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

test('M4-D: buildAppRunValue is the bare quoted executable (no --apply-profile)', () => {
  assert.equal(
    buildAppRunValue('C:\\Program Files\\Arc Power\\Arc Power.exe'),
    '"C:\\Program Files\\Arc Power\\Arc Power.exe"',
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

test('M4-D: parseAppRunValue round-trips the plain entry and rejects --apply-profile values', () => {
  assert.deepEqual(parseAppRunValue(buildAppRunValue('C:\\apps\\arc.exe')), { execPath: 'C:\\apps\\arc.exe' });
  assert.equal(parseAppRunValue('"C:\\x.exe" --apply-profile p1'), null, 'an apply-profile entry is NOT a plain entry');
  assert.equal(parseAppRunValue('C:\\x.exe'), null, 'unquoted exec path');
  assert.equal(parseAppRunValue('"C:\\x.exe" --flag'), null);
  assert.equal(parseAppRunValue(''), null);
  assert.equal(parseAppRunValue(42), null);
  assert.equal(parseAppRunValue(null), null);
});

test('parseRegQuery: parses reg query output and maps absent -> null', () => {
  const out = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
    ArcPower    REG_SZ    "C:\\Apps\\Arc Power.exe" --apply-profile p1`;
  assert.deepEqual(parseRegQuery(out), { execPath: 'C:\\Apps\\Arc Power.exe', profileId: 'p1' });
  assert.equal(parseRegQuery('nothing here', 0), null);
  assert.equal(parseRegQuery('', REG_NOT_FOUND), null);
});

// ---------------------------------------------------------------------------
// Scheduled-task parsing + scripts (M2C-C + M4-D)
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

test('M4-D: parseSchTasksAppQuery parses the plain-app task action (no --apply-profile)', () => {
  const out = `Folder: \\\nTaskName: \\ArcPowerAppOnBoot\nStatus: Ready\n...\nTask To Run: "C:\\Apps\\Arc Power.exe"\n...`;
  assert.deepEqual(parseSchTasksAppQuery(out), { execPath: 'C:\\Apps\\Arc Power.exe' });
  // A --apply-profile action under the APP task name is not a plain entry.
  assert.equal(parseSchTasksAppQuery('Task To Run: "C:\\Apps\\Arc Power.exe" --apply-profile p1', 0), null);
  assert.equal(parseSchTasksAppQuery('', 0x41303), null);
  assert.equal(parseSchTasksAppQuery('', 0x41301), null);
  assert.equal(parseSchTasksAppQuery('Task To Run: "C:\\other.exe" --flag', 0), null);
});

test('buildTaskCreateScript: /sc onlogon /rl highest + deletes the app task (coexistence) in ONE elevated call', () => {
  const script = buildTaskCreateScript('C:\\Apps\\Arc Power.exe', 'p1');
  assert.match(script, /schtasks \/create \/tn ArcPowerApplyOnBoot \/sc onlogon \/rl highest/);
  assert.match(script, /"C:\\Apps\\Arc Power.exe" --apply-profile p1/);
  // M4-D coexistence: the same script deletes the plain-app task and the
  // script exits with the CREATE's code (the delete outcome is best-effort).
  assert.match(script, new RegExp(`schtasks \\/delete \\/tn ${APP_TASK_NAME} \\/f`));
  assert.match(script, /exit \$createCode/);
  // The create code is captured BEFORE the delete runs.
  const createIdx = script.indexOf('schtasks /create');
  const captureIdx = script.indexOf('$createCode = $LASTEXITCODE');
  const deleteIdx = script.indexOf(`schtasks /delete /tn ${APP_TASK_NAME}`);
  assert.ok(captureIdx > createIdx && deleteIdx > captureIdx, 'capture-then-delete ordering');
});

test('M4-D: buildAppTaskCreateScript creates ArcPowerAppOnBoot and deletes the apply-profile task (coexistence)', () => {
  const script = buildAppTaskCreateScript('C:\\Apps\\Arc Power.exe');
  assert.match(script, new RegExp(`schtasks \\/create \\/tn ${APP_TASK_NAME} \\/sc onlogon \\/rl highest`));
  // The plain entry: the bare quoted exe, no --apply-profile.
  assert.ok(script.includes("$tr = '\"C:\\Apps\\Arc Power.exe\"'"), `plain entry literal missing: ${script}`);
  assert.doesNotMatch(script, /--apply-profile/);
  assert.match(script, new RegExp(`schtasks \\/delete \\/tn ${TASK_NAME} \\/f`));
  assert.match(script, /exit \$createCode/);
});

test('M4-D review F2: the coexistence delete runs ONLY when the create succeeded (both create scripts)', () => {
  // A failed create must leave the other registration untouched — the
  // delete is gated on $createCode -eq 0, never a bare top-level statement.
  for (const script of [
    buildTaskCreateScript('C:\\Apps\\Arc Power.exe', 'p1'),
    buildAppTaskCreateScript('C:\\Apps\\Arc Power.exe'),
  ]) {
    const gated = script.match(/if \(\$createCode -eq 0\) \{ & schtasks \/delete \/tn ([A-Za-z]+) \/f \| Out-Null \}/);
    assert.ok(gated, `the delete is not gated on the create's success: ${script}`);
    assert.ok(gated[1] === 'ArcPowerAppOnBoot' || gated[1] === 'ArcPowerApplyOnBoot', `gated delete targets the OTHER task: ${gated[1]}`);
    // The delete is never an unconditional top-level statement...
    assert.doesNotMatch(script, /; & schtasks \/delete/, 'the delete must not run unconditionally');
    // ...and the create code is still captured before the gated delete,
    // with the script exiting with the CREATE's outcome either way.
    const captureIdx = script.indexOf('$createCode = $LASTEXITCODE');
    const deleteIdx = script.indexOf('schtasks /delete');
    assert.ok(captureIdx > -1 && deleteIdx > captureIdx, 'capture-then-gated-delete ordering');
    assert.match(script, /exit \$createCode/);
  }
});

test('buildTaskDeleteScript: deletes the task, treats an absent task as success', () => {
  const script = buildTaskDeleteScript();
  assert.match(script, /schtasks \/delete \/tn ArcPowerApplyOnBoot \/f/);
});

test('M4-D: buildAppTaskDeleteScript deletes the plain-app task, absent = success', () => {
  const script = buildAppTaskDeleteScript();
  assert.match(script, new RegExp(`schtasks \\/delete \\/tn ${APP_TASK_NAME} \\/f`));
  assert.match(script, /if \(\$LASTEXITCODE -ne 0\) \{ exit 0 \}/);
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

test('M4-D: a quote in execPath round-trips through buildAppTaskCreateScript', () => {
  const script = buildAppTaskCreateScript("C:\\Apps\\Arc' Power.exe");
  assert.match(script, /\$tr = '"C:\\Apps\\Arc'' Power\.exe"'/);
  const trLine = script.split(';')[0];
  assert.equal((trLine.match(/'/g) ?? []).length % 2, 0, 'balanced quoting');
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

const appTaskQueryOut = (execPath = 'C:\\Apps\\Arc Power.exe') =>
  `Folder: \\\nTaskName: \\ArcPowerAppOnBoot\nTask To Run: "${execPath}"`;

// --- set(): the apply-profile registration ---------------------------------

test('set(enabled=true): creates the ELEVATED task (deleting the app task in the SAME call), cleans the Run key', async () => {
  // Exec-call order after the elevated create: reg delete, then the get()
  // re-query (profile task present -> no reg fallback; app task absent).
  const { exec, calls } = fakeExecFile([
    { stdout: '' }, // reg delete
    { stdout: taskQueryOut('p1') }, // get(): profile task present
    { error: { code: 0x41303 } }, // get(): app task absent
  ]);
  const { runElevated, calls: elevCalls } = fakeElevated([{ ok: true }]);
  const startup = createStartup({ execFile: exec, execPath: 'C:\\Apps\\Arc Power.exe', runElevated });
  const out = await startup.set(true, 'p1');
  assert.equal(out.startupRunKey.enabled, true);
  assert.equal(out.startupRunKey.profileId, 'p1');
  assert.equal(out.startupRunKey.value, '"C:\\Apps\\Arc Power.exe" --apply-profile p1');
  assert.equal(out.startupRunKey.mechanism, 'task');
  assert.equal(out.applyOnBoot.enabled, false, 'coexistence: the app task is disabled by the same enable');
  assert.equal(out.startWithWindows, false);
  assert.equal(elevCalls.length, 1, 'exactly ONE elevated call (one UAC at enable)');
  assert.match(elevCalls[0], /schtasks \/create \/tn ArcPowerApplyOnBoot/);
  assert.match(elevCalls[0], new RegExp(`schtasks \\/delete \\/tn ${APP_TASK_NAME}`), 'the coexistence delete rides the same elevated call');
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
  // Results: elevated delete ok; reg delete -> REG_NOT_FOUND (absent).
  const { exec, calls } = fakeExecFile([{ error: { code: REG_NOT_FOUND } }]);
  const { runElevated, calls: elevCalls } = fakeElevated([{ ok: true }]);
  const startup = createStartup({ execFile: exec, runElevated });
  const out = await startup.set(false, null);
  assert.deepEqual(out.startupRunKey, { enabled: false, profileId: null, value: null, mechanism: null });
  assert.equal(out.applyOnBoot.enabled, false);
  assert.equal(out.startWithWindows, false);
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

// --- M4-D: setAppOnBoot() ---------------------------------------------------

test('M4-D: setAppOnBoot(true) creates the ELEVATED app task (deleting the apply-profile task in the SAME call) + cleans the Run key', async () => {
  // Exec-call order after the elevated create: reg delete, then the get()
  // re-query (profile task absent -> Run key absent -> app task present).
  const { exec, calls } = fakeExecFile([
    { stdout: '' }, // reg delete
    { error: { code: 0x41303 } }, // get(): profile task absent
    { error: { code: REG_NOT_FOUND } }, // get(): Run key absent
    { stdout: appTaskQueryOut() }, // get(): app task present
  ]);
  const { runElevated, calls: elevCalls } = fakeElevated([{ ok: true }]);
  const startup = createStartup({ execFile: exec, execPath: 'C:\\Apps\\Arc Power.exe', runElevated });
  const out = await startup.setAppOnBoot(true);
  assert.equal(out.applyOnBoot.enabled, true);
  assert.equal(out.applyOnBoot.value, '"C:\\Apps\\Arc Power.exe"');
  assert.equal(out.startWithWindows, true);
  assert.equal(out.startupRunKey.enabled, false, 'coexistence: the apply-profile registration is disabled');
  assert.equal(elevCalls.length, 1, 'exactly ONE elevated call');
  assert.match(elevCalls[0], new RegExp(`schtasks \\/create \\/tn ${APP_TASK_NAME} \\/sc onlogon \\/rl highest`));
  assert.doesNotMatch(elevCalls[0], /--apply-profile/);
  assert.match(elevCalls[0], new RegExp(`schtasks \\/delete \\/tn ${TASK_NAME} \\/f`), 'the coexistence delete rides the same elevated call');
  assert.ok(calls.some((c) => c.cmd === 'reg' && c.args[0] === 'delete'), 'the legacy Run key is cleaned');
});

test('M4-D: setAppOnBoot(false) deletes only the app task (elevated; absent = success)', async () => {
  // After the elevated delete: the get() re-query (profile task absent ->
  // Run key absent -> app task absent).
  const { exec } = fakeExecFile([
    { error: { code: 0x41303 } },
    { error: { code: REG_NOT_FOUND } },
    { error: { code: 0x41303 } },
  ]);
  const { runElevated, calls: elevCalls } = fakeElevated([{ ok: true }]);
  const startup = createStartup({ execFile: exec, runElevated });
  const out = await startup.setAppOnBoot(false);
  assert.equal(out.applyOnBoot.enabled, false);
  assert.equal(out.startWithWindows, false);
  assert.match(elevCalls[0], new RegExp(`schtasks \\/delete \\/tn ${APP_TASK_NAME} \\/f`));
});

test('M4-D: setAppOnBoot(true) with a declined UAC throws the honest error (nothing enabled)', async () => {
  const { exec } = fakeExecFile([]);
  const { runElevated } = fakeElevated([{ ok: false, error: 'elevation declined or timed out' }]);
  const startup = createStartup({ execFile: exec, runElevated });
  await assert.rejects(() => startup.setAppOnBoot(true), /elevation declined or timed out/);
});

// --- get(): the combined shape ----------------------------------------------

test('get: the apply-profile scheduled task is the primary mechanism', async () => {
  // Results: profile-task query ok; (no reg query needed); app-task query ok.
  const { exec } = fakeExecFile([{ stdout: taskQueryOut('p9') }, { stdout: appTaskQueryOut() }]);
  const out = await createStartup({ execFile: exec }).get();
  assert.deepEqual(out.startupRunKey, { enabled: true, profileId: 'p9', value: '"C:\\Apps\\Arc Power.exe" --apply-profile p9', mechanism: 'task' });
  assert.equal(out.applyOnBoot.enabled, true, 'the app task is reported too');
  assert.equal(out.applyOnBoot.value, '"C:\\Apps\\Arc Power.exe"');
  assert.equal(out.startWithWindows, true);
});

test('get: task absent -> Run key fallback (mechanism run-key)', async () => {
  const found = fakeExecFile([
    { error: { code: 0x41303 } }, // schtasks: profile task not found
    { stdout: `...\\Run\n    ArcPower    REG_SZ    "C:\\A.exe" --apply-profile p9` }, // Run key
    { error: { code: 0x41303 } }, // schtasks: app task not found
  ]);
  const out1 = await createStartup({ execFile: found.exec }).get();
  assert.deepEqual(out1.startupRunKey, { enabled: true, profileId: 'p9', value: '"C:\\A.exe" --apply-profile p9', mechanism: 'run-key' });
  assert.equal(out1.applyOnBoot.enabled, false);

  const missing = fakeExecFile([
    { error: { code: 0x41303 } },
    { error: { code: REG_NOT_FOUND } },
    { error: { code: 0x41303 } },
  ]);
  const out2 = await createStartup({ execFile: missing.exec }).get();
  assert.deepEqual(out2.startupRunKey, { enabled: false, profileId: null, value: null, mechanism: null });
  assert.equal(out2.applyOnBoot.enabled, false);
  assert.equal(out2.startWithWindows, false);
});

test('get: a foreign task action is ignored (falls through to the Run key)', async () => {
  const found = fakeExecFile([
    { stdout: `Task To Run: "C:\\other.exe" --flag` },
    { stdout: `...\\Run\n    ArcPower    REG_SZ    "C:\\A.exe" --apply-profile p9` },
    { error: { code: 0x41303 } },
  ]);
  const out = await createStartup({ execFile: found.exec }).get();
  assert.equal(out.startupRunKey.mechanism, 'run-key');
  assert.equal(out.startupRunKey.profileId, 'p9');
});

test('M4-D: get: an --apply-profile action under the APP task name is not a plain entry', async () => {
  const found = fakeExecFile([
    { error: { code: 0x41303 } }, // profile task absent
    { error: { code: REG_NOT_FOUND } }, // Run key absent
    { stdout: `Task To Run: "C:\\Apps\\Arc Power.exe" --apply-profile p9` }, // app task holds an apply-profile action
  ]);
  const out = await createStartup({ execFile: found.exec }).get();
  assert.equal(out.applyOnBoot.enabled, false, 'the app task is not enabled — its action is not the plain entry');
  assert.equal(out.startWithWindows, false);
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
  assert.deepEqual(await startup.get(), {
    startupRunKey: { enabled: false, profileId: null, value: null, mechanism: null },
    applyOnBoot: { enabled: false, value: null },
    startWithWindows: false,
  });
  const out = await startup.set(true, 'p1');
  assert.equal(out.startupRunKey.enabled, true);
  assert.equal(out.startupRunKey.profileId, 'p1');
  assert.equal(out.startupRunKey.mechanism, 'task');
  assert.equal(out.applyOnBoot.enabled, false);
  assert.equal(out.startWithWindows, false);
  assert.deepEqual(await startup.get(), out);
  await startup.set(false, null);
  assert.deepEqual(await startup.get(), {
    startupRunKey: { enabled: false, profileId: null, value: null, mechanism: null },
    applyOnBoot: { enabled: false, value: null },
    startWithWindows: false,
  });
});

test('M4-D: mock startup — setAppOnBoot round trip + the coexistence rule mirrors the real adapter', async () => {
  const startup = createMockStartup();
  // Enable the app task: applyOnBoot on, startupRunKey off (coexistence).
  const on = await startup.setAppOnBoot(true);
  assert.equal(on.applyOnBoot.enabled, true);
  assert.equal(on.applyOnBoot.value, `"${process.execPath}"`);
  assert.equal(on.startWithWindows, true);
  assert.deepEqual(on.startupRunKey, { enabled: false, profileId: null, value: null, mechanism: null });

  // Enabling the apply-profile registration disables the app task.
  const profileOn = await startup.set(true, 'p1');
  assert.equal(profileOn.startupRunKey.enabled, true);
  assert.equal(profileOn.startupRunKey.profileId, 'p1');
  assert.equal(profileOn.applyOnBoot.enabled, false, 'coexistence: the app task is disabled');
  assert.equal(profileOn.startWithWindows, false);

  // And back: enabling the app task disables the apply-profile registration.
  const appAgain = await startup.setAppOnBoot(true);
  assert.equal(appAgain.startupRunKey.enabled, false);
  assert.equal(appAgain.applyOnBoot.enabled, true);

  // Disabling the app task does NOT re-enable the profile registration.
  const off = await startup.setAppOnBoot(false);
  assert.equal(off.applyOnBoot.enabled, false);
  assert.equal(off.startupRunKey.enabled, false);
});

test('mock startup: enabling without a profileId throws', async () => {
  const startup = createMockStartup();
  await assert.rejects(() => startup.set(true, null), /profileId is required/);
});
