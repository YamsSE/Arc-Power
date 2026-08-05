// M2b-B — driver-info adapter: reg.exe query parsing + fixture mock. The
// real adapter never runs reg.exe in these tests (injected fake execFile).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createDriverInfo,
  createMockDriverInfo,
  parseRegDriverDate,
  DISPLAY_CLASS_KEY,
  DRIVER_DATE_VALUE,
  REG_NOT_FOUND,
} from '../src/main/driver-info.js';

test('parseRegDriverDate: extracts the REG_SZ value from reg query stdout', () => {
  const stdout = `
HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0000
    DriverDate    REG_SZ    7-5-2026
`;
  assert.equal(parseRegDriverDate(stdout), '7-5-2026');
});

test('parseRegDriverDate: exit 1 (value not found) -> null', () => {
  assert.equal(parseRegDriverDate('ERROR: The system was unable to find the specified registry key or value.', REG_NOT_FOUND), null);
});

test('parseRegDriverDate: garbage or missing value -> null', () => {
  assert.equal(parseRegDriverDate(''), null);
  assert.equal(parseRegDriverDate('    SomethingElse    REG_SZ    1-1-2026'), null);
  assert.equal(parseRegDriverDate('    DriverDate    REG_DWORD    0x1'), null);
  assert.equal(parseRegDriverDate(null), null);
});

test('createDriverInfo: queries the display class key with the real reg.exe command shape', async () => {
  const calls = [];
  const exec = async (exe, args) => {
    calls.push([exe, args]);
    return { stdout: `    DriverDate    REG_SZ    7-5-2026\n` };
  };
  const info = createDriverInfo({ execFile: exec });
  assert.deepEqual(await info.get(), { driverDate: '7-5-2026' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'reg');
  assert.deepEqual(calls[0][1], ['query', `${DISPLAY_CLASS_KEY}\\0000`, '/v', DRIVER_DATE_VALUE]);
});

test('createDriverInfo: a reg.exe failure degrades to null (never throws)', async () => {
  const info = createDriverInfo({
    execFile: async () => { const err = new Error('spawn reg ENOENT'); err.code = 'ENOENT'; throw err; },
  });
  assert.deepEqual(await info.get(), { driverDate: null });
});

test('createDriverInfo: value not found (exit 1) degrades to null', async () => {
  const info = createDriverInfo({
    execFile: async () => { const err = new Error('not found'); err.code = REG_NOT_FOUND; throw err; },
  });
  assert.deepEqual(await info.get(), { driverDate: null });
});

test('createDriverInfo: the adapter index is zero-padded to 0000', async () => {
  let args = null;
  const info = createDriverInfo({
    execFile: async (_exe, a) => { args = a; return { stdout: '' }; },
  });
  await info.get();
  assert.ok(args[1].endsWith('\\0000'), args[1]);
});

test('createMockDriverInfo: returns the fixture date (A770 driver 32.0.101.8861)', async () => {
  const mock = createMockDriverInfo();
  assert.deepEqual(await mock.get(), { driverDate: '7-5-2026' });
  const custom = createMockDriverInfo('1-1-2026');
  assert.deepEqual(await custom.get(), { driverDate: '1-1-2026' });
});
