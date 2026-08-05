// M2a extension — shared status mapping (health + IGS service -> level/label):
//   - a healthy device with the IGS service running reads as `warning`, not ok;
//   - degraded/error/searching still win over the warning;
//   - the warning label text is pinned (shown in the header and the dashboard).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus, STATUS_LABEL, healthLevel, dashboardNeedsFullRender } from '../src/renderer/pure/status.ts';
import type { DashboardSig } from '../src/renderer/pure/status.ts';
import type { Capabilities, HealthReport, IgsServiceState } from '../src/renderer/types.ts';

const okHealth: HealthReport = { backend: 'mock', igclLoaded: true, driverVersion: '32.0.101.8861', levelZeroOk: true };
const igsRunning: IgsServiceState = { found: true, running: true, startType: 'auto' };
const igsStopped: IgsServiceState = { found: true, running: false, startType: 'disabled' };
const igsNotDetected: IgsServiceState = { found: false, running: false, startType: 'unknown' };

test('mapStatus: warning beats ok when the IGS service is running', () => {
  assert.deepEqual(mapStatus(okHealth, igsRunning), { level: 'warning', label: STATUS_LABEL.warning });
});

test('mapStatus: warning label text is pinned', () => {
  assert.equal(STATUS_LABEL.warning, "IGS service running — OC changes won't apply");
});

test('mapStatus: degraded and error still win over the warning', () => {
  const degraded: HealthReport = { backend: 'mock', igclLoaded: false, driverVersion: null, levelZeroOk: true };
  const error: HealthReport = { backend: 'mock', igclLoaded: false, driverVersion: null, levelZeroOk: false, error: 'ctlInit failed' };
  assert.equal(mapStatus(degraded, igsRunning).level, 'degraded');
  assert.equal(mapStatus(error, igsRunning).level, 'error');
});

test('mapStatus: healthy + service stopped / not detected / probe pending -> ok', () => {
  assert.equal(mapStatus(okHealth, igsStopped).level, 'ok');
  assert.equal(mapStatus(okHealth, igsNotDetected).level, 'ok');
  assert.equal(mapStatus(okHealth, null).level, 'ok');
});

test('mapStatus: null health stays searching even while the IGS service runs', () => {
  assert.equal(mapStatus(null, igsRunning).level, 'searching');
  assert.equal(mapStatus(null, null).label, 'Searching…');
});

test('healthLevel keeps the F9 semantics (null -> searching)', () => {
  assert.equal(healthLevel(null), 'searching');
  assert.equal(healthLevel(okHealth), 'ok');
});

// ---------------------------------------------------------------------------
// Dashboard re-render scoping (M2a.5-5): full re-render on status changes
// only — telemetry ticks must not rebuild the page.
// ---------------------------------------------------------------------------

const dashSig = (patch: Partial<DashboardSig> = {}): DashboardSig => ({
  igsState: igsRunning,
  health: okHealth,
  caps: null,
  bootError: null,
  ...patch,
});

test('dashboardNeedsFullRender: a telemetry tick (only latestSample changed) does NOT re-render', () => {
  const sig = dashSig();
  // latestSample is not part of the signature — the store keeps the same
  // object references for the status slots across telemetry ticks.
  assert.equal(dashboardNeedsFullRender(sig, sig), false);
  assert.equal(dashboardNeedsFullRender(sig, dashSig()), false);
});

test('dashboardNeedsFullRender: igsState / health / caps / bootError changes DO re-render', () => {
  const sig = dashSig();
  const caps: Capabilities = {
    oemName: 'oem',
    deviceName: 'dev',
    waiverAccepted: false,
    controls: {},
    ranges: {},
    fan: { canControl: false, modes: [], maxRpm: 0, maxCurvePoints: 0 },
  };
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ igsState: igsStopped })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ health: null })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ caps })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ bootError: 'No Intel Arc GPU detected' })), true);
});

test('dashboardNeedsFullRender: the first update always renders', () => {
  assert.equal(dashboardNeedsFullRender(null, dashSig()), true);
});
