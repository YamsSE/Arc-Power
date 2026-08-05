// M2b — Run-key helper tests: pure value parsing + the reg.exe adapter with
// injected execFile fakes (add/delete/query/error paths). NO real registry
// access anywhere — the fakes never spawn reg.exe.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRunValue, parseRunValue, parseRegQuery,
  createStartup, createMockStartup, RUN_KEY, RUN_VALUE, REG_NOT_FOUND,
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
// Real adapter with injected execFile fakes (never the real reg.exe)
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

test('set(enabled=true): reg add with the quoted value, returns the new state', async () => {
  const { exec, calls } = fakeExecFile([{ stdout: '' }]);
  const startup = createStartup({ execFile: exec, execPath: 'C:\\Apps\\Arc Power.exe' });
  const out = await startup.set(true, 'p1');
  assert.deepEqual(out, { enabled: true, profileId: 'p1', value: '"C:\\Apps\\Arc Power.exe" --apply-profile p1' });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', '"C:\\Apps\\Arc Power.exe" --apply-profile p1', '/f']);
  assert.equal(calls[0].opts.windowsHide, true);
});

test('set(enabled=false): reg delete; an absent value (exit 1) is success', async () => {
  const { exec, calls } = fakeExecFile([{ error: { code: REG_NOT_FOUND } }]);
  const startup = createStartup({ execFile: exec });
  const out = await startup.set(false, null);
  assert.deepEqual(out, { enabled: false, profileId: null, value: null });
  assert.deepEqual(calls[0].args, ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
});

test('set(enabled=false): a real reg.exe failure propagates', async () => {
  const { exec } = fakeExecFile([{ error: { code: 5, message: 'Access is denied' } }]);
  const startup = createStartup({ execFile: exec });
  await assert.rejects(() => startup.set(false, null), /startup delete failed/);
});

test('set(enabled=true) without profileId throws (validation is in the adapter too)', async () => {
  const startup = createStartup({ execFile: fakeExecFile([]).exec });
  await assert.rejects(() => startup.set(true, null), /profileId is required/);
});

test('get: reg query found -> enabled with profileId; not found (exit 1) -> disabled', async () => {
  const found = fakeExecFile([{ stdout: `HKEY_CURRENT_USER\\...\\Run\n    ArcPower    REG_SZ    "C:\\A.exe" --apply-profile p9` }]);
  const out1 = await createStartup({ execFile: found.exec }).get();
  assert.deepEqual(out1, { enabled: true, profileId: 'p9', value: '"C:\\A.exe" --apply-profile p9' });

  const missing = fakeExecFile([{ error: { code: REG_NOT_FOUND } }]);
  const out2 = await createStartup({ execFile: missing.exec }).get();
  assert.deepEqual(out2, { enabled: false, profileId: null, value: null });
});

test('get: a foreign value in the Run key is reported as disabled (not ours)', async () => {
  const fake = fakeExecFile([{ stdout: `...\\Run\n    SomethingElse    REG_SZ    "C:\\other.exe" --flag` }]);
  const out = await createStartup({ execFile: fake.exec }).get();
  assert.deepEqual(out, { enabled: false, profileId: null, value: null });
});

test('get: query errors propagate (caller degrades)', async () => {
  const fake = fakeExecFile([{ error: { message: 'reg not found on PATH' } }]);
  await assert.rejects(() => createStartup({ execFile: fake.exec }).get(), /startup query failed/);
});

// ---------------------------------------------------------------------------
// Mock adapter (the default for tests/ui-verify — never the registry)
// ---------------------------------------------------------------------------

test('mock startup: in-memory set/get round trip, no processes', async () => {
  const startup = createMockStartup();
  assert.deepEqual(await startup.get(), { enabled: false, profileId: null, value: null });
  const out = await startup.set(true, 'p1');
  assert.equal(out.enabled, true);
  assert.equal(out.profileId, 'p1');
  assert.deepEqual(await startup.get(), out);
  await startup.set(false, null);
  assert.deepEqual(await startup.get(), { enabled: false, profileId: null, value: null });
});

test('mock startup: enabling without a profileId throws', async () => {
  const startup = createMockStartup();
  await assert.rejects(() => startup.set(true, null), /profileId is required/);
});
