// M2b-B — driver display helpers: IGCL uint64 -> dotted version, DriverDate
// -> "Jul 05, 2026", Xe cores -> shader units.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeDriverVersion, formatDriverDate, shaderUnits } from '../src/renderer/pure/driver.ts';

test('decodeDriverVersion: A770 fixture hex decodes to the dotted form (MSB-first 16-bit words)', () => {
  // 0x0020=32 major, 0x0000=0 minor, 0x0065=101 subminor, 0x229d=8861 build.
  assert.equal(decodeDriverVersion('0x002000000065229d'), '32.0.101.8861');
});

test('decodeDriverVersion: short hex still decodes (missing leading zeros)', () => {
  assert.equal(decodeDriverVersion('0x65229d'), '0.0.101.8861');
  assert.equal(decodeDriverVersion('0x1'), '0.0.0.1');
});

test('decodeDriverVersion: non-hex strings pass through verbatim (degraded reports)', () => {
  assert.equal(decodeDriverVersion('32.0.101.8861'), '32.0.101.8861');
  assert.equal(decodeDriverVersion('unknown'), 'unknown');
});

test('decodeDriverVersion: null/empty input returns null', () => {
  assert.equal(decodeDriverVersion(null), null);
  assert.equal(decodeDriverVersion(undefined), null);
  assert.equal(decodeDriverVersion(''), null);
  // M2b review F5: whitespace-only input is empty after trimming.
  assert.equal(decodeDriverVersion('   '), null);
});

test('formatDriverDate: M-d-yyyy becomes en-US month name with zero-padded day', () => {
  assert.equal(formatDriverDate('7-5-2026'), 'Jul 05, 2026');
  assert.equal(formatDriverDate('12-25-2025'), 'Dec 25, 2025');
  assert.equal(formatDriverDate('1-1-2026'), 'Jan 01, 2026');
});

test('formatDriverDate: unparseable input returns null (caller shows version only)', () => {
  assert.equal(formatDriverDate(null), null);
  assert.equal(formatDriverDate(undefined), null);
  assert.equal(formatDriverDate(''), null);
  assert.equal(formatDriverDate('2026-07-05'), null);
  assert.equal(formatDriverDate('7/5/2026'), null);
  assert.equal(formatDriverDate('13-1-2026'), null);
  assert.equal(formatDriverDate('0-1-2026'), null);
  assert.equal(formatDriverDate('1-32-2026'), null);
});

test('shaderUnits: A770 = 32 Xe cores * 16 EUs * 8 lanes = 4096', () => {
  assert.equal(shaderUnits(32), 4096);
  assert.equal(shaderUnits(1), 128);
});
