// M2a — header status dot logic (pure; DOM rendering is covered by
// --ui-verify). F9: no health report yet must read as the neutral
// "Searching…" state, not "Error". M2C-B B3: the version line below the GPU
// name is the app version ("Arc Power Ver. X.XX").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthStatus, versionLine, driverLine } from '../src/renderer/components/header.ts';
import type { HealthReport } from '../src/renderer/types.ts';

const report = (patch: Partial<HealthReport>): HealthReport => ({
  backend: 'mock',
  igclLoaded: true,
  driverVersion: '32.0.101.8861',
  levelZeroOk: true,
  ...patch,
});

test('healthStatus: null health is the neutral searching state (F9 regression)', () => {
  assert.equal(healthStatus(null), 'searching');
});

test('healthStatus: a healthy report is ok', () => {
  assert.equal(healthStatus(report({})), 'ok');
});

test('healthStatus: a report with an error is error', () => {
  assert.equal(healthStatus(report({ igclLoaded: false, driverVersion: null, levelZeroOk: false, error: 'ctlInit failed' })), 'error');
});

test('healthStatus: missing igcl/level-zero is degraded, never ok', () => {
  assert.equal(healthStatus(report({ igclLoaded: false, driverVersion: null })), 'degraded');
  assert.equal(healthStatus(report({ levelZeroOk: false })), 'degraded');
});

// M2C-B B3 — the header version line replaces the driver line.
test('B3: versionLine renders "Arc Power Ver. X.XX" (header regression)', () => {
  assert.equal(versionLine('0.1.0'), 'Arc Power Ver. 0.1.0');
  assert.equal(versionLine('2.3.4'), 'Arc Power Ver. 2.3.4');
  // Degraded/missing version falls back to 0.0.0 — never an empty line.
  assert.equal(versionLine(null), 'Arc Power Ver. 0.0.0');
  assert.equal(versionLine(''), 'Arc Power Ver. 0.0.0');
});

// The driver line moved OUT of the header (B3) but stays for the dashboard
// device card — pin the helper so the dashboard keeps the dotted version.
test('B3: driverLine still formats the dotted driver version + date (dashboard device card)', () => {
  assert.equal(driverLine({ driverVersion: '0x002000000065229d' }, '7-5-2026'), '32.0.101.8861 - Jul 05, 2026');
  assert.equal(driverLine({ driverVersion: '0x002000000065229d' }, null), '32.0.101.8861');
  assert.equal(driverLine(null, '7-5-2026'), null);
});
