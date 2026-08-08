// M4-D2 — startup registration tests: the HKCU Run value ONLY (reg.exe,
// zero UAC — the M2b/M2C-C scheduled tasks are GONE). Pure value parsing +
// the real adapter (reg.exe via injected execFile fakes) + the in-memory
// mock. NO real registry, scheduler or UAC access anywhere — the fakes
// never spawn anything. The startup adapter stays DUMB
// ({ valueExists, value }); the { startWithWindows, applyOnBoot }
// derivation lives in ipc-core's startup-get (tested in ipc-core.test.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunValue, parseRunValue, parseRegQuery,
  createStartup, createMockStartup, resolveLogonExecPath,
  RUN_KEY, RUN_VALUE, REG_NOT_FOUND,
} from '../src/main/startup.js';

// ---------------------------------------------------------------------------
// Pure value building/parsing
// ---------------------------------------------------------------------------

test('buildRunValue is the bare quoted executable (no --apply-profile, no task args)', () => {
  assert.equal(
    buildRunValue('C:\\Program Files\\Arc Power\\Arc Power.exe'),
    '"C:\\Program Files\\Arc Power\\Arc Power.exe"',
  );
});

test('parseRunValue: round-trips the bare entry and rejects foreign values', () => {
  assert.deepEqual(parseRunValue(buildRunValue('C:\\apps\\arc.exe')), { execPath: 'C:\\apps\\arc.exe' });
  assert.equal(parseRunValue('"C:\\x.exe" --apply-profile p1'), null, 'an --apply-profile value is NOT ours anymore');
  assert.equal(parseRunValue('"C:\\x.exe" --flag'), null);
  assert.equal(parseRunValue('C:\\x.exe'), null); // unquoted exec path
  assert.equal(parseRunValue(''), null);
  assert.equal(parseRunValue(42), null);
  assert.equal(parseRunValue(null), null);
});

test('parseRegQuery: parses reg query output and maps absent -> null', () => {
  const out = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
    ArcPower    REG_SZ    "C:\\Apps\\Arc Power.exe"`;
  assert.deepEqual(parseRegQuery(out), { execPath: 'C:\\Apps\\Arc Power.exe' });
  assert.equal(parseRegQuery('nothing here', 0), null);
  assert.equal(parseRegQuery('', REG_NOT_FOUND), null);
});

test('parseRegQuery: an --apply-profile value under our name is ignored (not ours)', () => {
  const out = `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run
    ArcPower    REG_SZ    "C:\\Apps\\Arc Power.exe" --apply-profile p1`;
  assert.equal(parseRegQuery(out, 0), null);
});

// ---------------------------------------------------------------------------
// Real adapter with injected execFile fakes (never spawns anything)
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

const regQueryOut = (execPath = 'C:\\Apps\\Arc Power.exe') =>
  `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\n    ArcPower    REG_SZ    "${execPath}"`;

test('get: absent value (exit 1) -> { valueExists:false }; present -> { valueExists:true, value }', async () => {
  const missing = fakeExecFile([{ error: { code: REG_NOT_FOUND } }]);
  assert.deepEqual(await createStartup({ execFile: missing.exec }).get(), { valueExists: false, value: null });
  assert.equal(missing.calls[0].cmd, 'reg');
  assert.deepEqual(missing.calls[0].args, ['query', RUN_KEY, '/v', RUN_VALUE]);

  const found = fakeExecFile([{ stdout: regQueryOut() }]);
  const startup = createStartup({ execFile: found.exec, execPath: 'C:\\Apps\\Arc Power.exe' });
  assert.deepEqual(await startup.get(), { valueExists: true, value: '"C:\\Apps\\Arc Power.exe"' });
});

test('get: a query failure (reg.exe missing) degrades to absent — never a boot blocker', async () => {
  const broken = fakeExecFile([{ error: { message: 'reg not found on PATH' } }]);
  assert.deepEqual(await createStartup({ execFile: broken.exec }).get(), { valueExists: false, value: null });
});

test('set(true): reg add with the bare quoted exe, ZERO elevation, returns the composed raw state', async () => {
  // Results: reg add ok, then the get() re-query.
  const { exec, calls } = fakeExecFile([{ stdout: '' }, { stdout: regQueryOut() }]);
  const startup = createStartup({ execFile: exec, execPath: 'C:\\Apps\\Arc Power.exe' });
  const out = await startup.set(true);
  assert.deepEqual(out, { valueExists: true, value: '"C:\\Apps\\Arc Power.exe"' });
  assert.deepEqual(calls[0], {
    cmd: 'reg',
    args: ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', '"C:\\Apps\\Arc Power.exe"', '/f'],
    opts: { windowsHide: true },
  });
  assert.equal(calls.length, 2, 'add + the get re-query — nothing elevated');
});

test('set(true): a reg add failure throws the honest error', async () => {
  const { exec } = fakeExecFile([{ error: { message: 'access denied' } }]);
  const startup = createStartup({ execFile: exec });
  await assert.rejects(() => startup.set(true), /reg add failed: access denied/);
});

test('set(false): reg delete; an absent value (exit 1) is success', async () => {
  const { exec, calls } = fakeExecFile([{ error: { code: REG_NOT_FOUND } }, { error: { code: REG_NOT_FOUND } }]);
  const startup = createStartup({ execFile: exec });
  assert.deepEqual(await startup.set(false), { valueExists: false, value: null });
  assert.deepEqual(calls[0].args, ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
});

test('set(false): a non-not-found delete failure throws', async () => {
  const { exec } = fakeExecFile([{ error: { message: 'reg broke' } }]);
  const startup = createStartup({ execFile: exec });
  await assert.rejects(() => startup.set(false), /reg delete failed: reg broke/);
});

test('M4-D2: the adapter NEVER touches schtasks / tasks / elevation — no task names exist anywhere', async () => {
  const src = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/main/startup.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(src, /schtasks/);
  assert.doesNotMatch(src, /RunAs/);
  assert.doesNotMatch(src, /setAppOnBoot/);
  assert.doesNotMatch(src, /TASK_NAME/);
});

// ---------------------------------------------------------------------------
// Mock adapter (the default for tests/ui-verify — nothing real)
// ---------------------------------------------------------------------------

test('mock startup: in-memory set/get round trip, no processes, raw shape', async () => {
  const startup = createMockStartup();
  assert.deepEqual(await startup.get(), { valueExists: false, value: null });
  const on = await startup.set(true);
  assert.deepEqual(on, { valueExists: true, value: `"${process.execPath}"` });
  assert.deepEqual(await startup.get(), on);
  const off = await startup.set(false);
  assert.deepEqual(off, { valueExists: false, value: null });
});

test('mock startup: an initial valueExists=true seeds the raw state', async () => {
  const startup = createMockStartup({ valueExists: true });
  assert.deepEqual(await startup.get(), { valueExists: true, value: `"${process.execPath}"` });
});

test('resolveLogonExecPath: packaged portable parent (Arc-Power-*.exe) wins over the temp extraction', async () => {
  const calls = [];
  const fakeExec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    return { stdout: 'C:\\Users\\yams\\Downloads\\Arc-Power-0.9.14.exe' };
  };
  const path = await resolveLogonExecPath({
    execFile: fakeExec,
    isPackaged: true,
    ppid: 4242,
    execPath: 'C:\\Users\\yams\\AppData\\Local\\Temp\\asdf\\Arc Power.exe',
  });
  assert.equal(path, 'C:\\Users\\yams\\Downloads\\Arc-Power-0.9.14.exe');
  assert.ok(calls[0].includes('4242'), 'the parent query targets the ppid');
});

test('resolveLogonExecPath: a non-Arc parent (win-unpacked / dev) falls back to process.execPath', async () => {
  const fakeExec = async () => ({ stdout: 'C:\\Windows\\System32\\cmd.exe' });
  const path = await resolveLogonExecPath({
    execFile: fakeExec,
    isPackaged: true,
    ppid: 1,
    execPath: 'C:\\prog\\Arc Power.exe',
  });
  assert.equal(path, 'C:\\prog\\Arc Power.exe');
});

test('resolveLogonExecPath: query failure falls back to process.execPath; dev mode skips the query', async () => {
  const boom = async () => { throw new Error('no powershell'); };
  const p1 = await resolveLogonExecPath({ execFile: boom, isPackaged: true, ppid: 5, execPath: 'X:\\a.exe' });
  assert.equal(p1, 'X:\\a.exe');
  const p2 = await resolveLogonExecPath({ execFile: boom, isPackaged: false, ppid: 5, execPath: 'X:\\b.exe' });
  assert.equal(p2, 'X:\\b.exe');
});

test('createStartup: the logonExecPath override drives the Run value (portable story)', async () => {
  const calls = [];
  const fakeExec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (args[0] === 'query') { const err = new Error('not found'); err.code = 1; throw err; }
    return { stdout: '' };
  };
  const startup = createStartup({ execFile: fakeExec, logonExecPath: 'C:\\Users\\yams\\Downloads\\Arc-Power-0.9.14.exe' });
  await startup.set(true);
  const add = calls.find((c) => c.includes(' add '));
  assert.ok(add && add.includes('"C:\\Users\\yams\\Downloads\\Arc-Power-0.9.14.exe"'), `add used the logon path: ${add}`);
});
