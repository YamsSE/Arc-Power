// M2a.5 extension — shared status mapping (health + combined IGS state ->
// level/label). The verified rule (docs/igcl-integration.md §8a): OC writes
// are refused in the IGS half-states (service.running !== appRunning); fully
// on (app + service) and fully off both work. So:
//   - half-states read as `warning` with the direction-specific label;
//   - fully-on and fully-off read as `ok` with their own labels;
//   - degraded/error/searching still win over the warning.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapStatus, STATUS_LABEL, IGS_LABELS, IGS_NOTE, igsHalfState, healthLevel, dashboardNeedsFullRender } from '../src/renderer/pure/status.ts';
import type { DashboardSig } from '../src/renderer/pure/status.ts';
import type { Capabilities, HealthReport, IgsServiceState } from '../src/renderer/types.ts';

const okHealth: HealthReport = { backend: 'mock', igclLoaded: true, driverVersion: '32.0.101.8861', levelZeroOk: true };
// The four combinations: service running/stopped x app process running/stopped.
const igsFullyOn: IgsServiceState = { service: { found: true, running: true, startType: 'auto' }, appRunning: true };
const igsFullyOff: IgsServiceState = { service: { found: true, running: false, startType: 'disabled' }, appRunning: false };
const igsHalfSvc: IgsServiceState = { service: { found: true, running: true, startType: 'auto' }, appRunning: false };
const igsHalfApp: IgsServiceState = { service: { found: true, running: false, startType: 'disabled' }, appRunning: true };
const igsNotDetected: IgsServiceState = { service: { found: false, running: false, startType: 'unknown' }, appRunning: false };

test('mapStatus: 4-combination matrix — fully on and fully off are ok with their labels', () => {
  assert.deepEqual(mapStatus(okHealth, igsFullyOn), { level: 'ok', label: IGS_LABELS.fullyOn });
  assert.deepEqual(mapStatus(okHealth, igsFullyOff), { level: 'ok', label: IGS_LABELS.fullyOff });
});

test('mapStatus: 4-combination matrix — half-states warn with the direction-specific label', () => {
  // service on, app off -> "service running without the app"
  assert.deepEqual(mapStatus(okHealth, igsHalfSvc), { level: 'warning', label: IGS_LABELS.serviceWithoutApp });
  // service off, app on -> "app running without the service"
  assert.deepEqual(mapStatus(okHealth, igsHalfApp), { level: 'warning', label: IGS_LABELS.appWithoutService });
});

test('mapStatus: the four user-facing label texts are pinned', () => {
  assert.equal(IGS_LABELS.serviceWithoutApp, 'IGS service running without the app — OC changes may not apply');
  assert.equal(IGS_LABELS.appWithoutService, 'IGS app running without the service — OC changes may not apply');
  assert.equal(IGS_LABELS.fullyOn, 'IGS fully active — OC control OK');
  assert.equal(IGS_LABELS.fullyOff, 'IGS fully off — OC control OK');
  assert.equal(STATUS_LABEL.warning, IGS_LABELS.serviceWithoutApp);
});

test('mapStatus: degraded and error still win over the half-state warning', () => {
  const degraded: HealthReport = { backend: 'mock', igclLoaded: false, driverVersion: null, levelZeroOk: true };
  const error: HealthReport = { backend: 'mock', igclLoaded: false, driverVersion: null, levelZeroOk: false, error: 'ctlInit failed' };
  assert.equal(mapStatus(degraded, igsHalfSvc).level, 'degraded');
  assert.equal(mapStatus(error, igsHalfSvc).level, 'error');
});

test('mapStatus: healthy + service not detected / probe pending -> ok', () => {
  assert.equal(mapStatus(okHealth, igsNotDetected).level, 'ok');
  assert.equal(mapStatus(okHealth, null).level, 'ok');
});

test('mapStatus: service probe failed (found:false) but the app runs — still the half-state warning', () => {
  // Reachable on a partial sc probe failure (non-1060 exit) with the IGS app
  // still running: the mapping must warn exactly like the app-without-service
  // half-state, so the dashboard card and the header stay in agreement.
  const igs: IgsServiceState = { service: { found: false, running: false, startType: 'unknown' }, appRunning: true };
  assert.deepEqual(mapStatus(okHealth, igs), { level: 'warning', label: IGS_LABELS.appWithoutService });
});

test('igsHalfState: NOT gated on service.found — a failed probe with the app running is still a half-state', () => {
  // Regression: the card gated its note on `service.found`, so found:false +
  // appRunning:true showed "not detected" with no note while the header
  // warned — the disagreement this predicate fixes.
  const probeFailedAppOn: IgsServiceState = { service: { found: false, running: false, startType: 'unknown' }, appRunning: true };
  assert.equal(igsHalfState(probeFailedAppOn), true);
  assert.equal(igsHalfState(igsHalfSvc), true);
  assert.equal(igsHalfState(igsHalfApp), true);
  assert.equal(igsHalfState(igsFullyOn), false);
  assert.equal(igsHalfState(igsFullyOff), false);
  assert.equal(igsHalfState(igsNotDetected), false);
  assert.equal(igsHalfState(null), false);
});

test('IGS_NOTE: exact full user-facing sentence pinned (not just a substring)', () => {
  assert.equal(
    IGS_NOTE,
    'Intel Graphics Software is partially running. For OC changes to apply, either disable IGS completely or run it fully with the Tuning tab enabled.',
  );
});

test('mapStatus: null health stays searching even in a half-state', () => {
  assert.equal(mapStatus(null, igsHalfSvc).level, 'searching');
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
  igsState: igsFullyOn,
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
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ igsState: igsFullyOff })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ health: null })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ caps })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ bootError: 'No Intel Arc GPU detected' })), true);
});

test('dashboardNeedsFullRender: the first update always renders', () => {
  assert.equal(dashboardNeedsFullRender(null, dashSig()), true);
});
