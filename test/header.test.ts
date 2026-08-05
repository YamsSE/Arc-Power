// M2a — header status dot logic (pure; DOM rendering is covered by
// --ui-verify). F9: no health report yet must read as the neutral
// "Searching…" state, not "Error".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthStatus } from '../src/renderer/components/header.ts';
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
