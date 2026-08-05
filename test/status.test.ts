// M3-A — GPU health row model (pure). The IGS-era combined mapping
// (mapStatus / IGS_LABELS / igsHalfState / IGS_NOTE) is REMOVED: with the
// M2C-C elevation gate, IGS state is no longer relevant to OC-applicability,
// so the dashboard's merged Service Status card became the general GPU
// HEALTH card with five honest rows:
//   driver ("Driver installed"), device ("Device detected"),
//   clocks ("Clocks normal"), oc ("OC working"), app ("Arc Power working").
// Each row: level (ok/warn/error/unknown) + a human detail line. The health
// card re-renders on the same status slots (health/caps/bootError/driverDate)
// — telemetry ticks only refresh the clocks row in place.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  healthLevel,
  healthRows,
  driverRow,
  deviceRow,
  clocksRow,
  ocRow,
  appRow,
  overallHealthLevel,
  worstLevel,
  dashboardNeedsFullRender,
} from '../src/renderer/pure/status.ts';
import type { DashboardSig, HealthInput, HealthLevel } from '../src/renderer/pure/status.ts';
import type { Capabilities, DeviceInfo, HealthReport, LastApply, TelemetrySample } from '../src/renderer/types.ts';

const okHealth: HealthReport = { backend: 'igcl', igclLoaded: true, driverVersion: '32.0.101.8861', levelZeroOk: true };
const mockHealth: HealthReport = { backend: 'mock', igclLoaded: true, driverVersion: '32.0.101.8861', levelZeroOk: true };
const device: DeviceInfo = {
  id: 0, name: 'Intel Arc A770', type: 'discrete', pciVendorId: '8086', pciDeviceId: '56a0', revId: 5,
  bdf: { bus: 1, device: 0, function: 0 }, driverVersion: '0x002000000065229d', graphicsClockMHz: 2400, numXeCores: 32,
};
const sample = (clock?: number): TelemetrySample | null => (clock === undefined
  ? null
  : { t: 0, gpuClockMhz: clock, throttle: {} });

const input = (patch: Partial<HealthInput> = {}): HealthInput => ({
  health: okHealth,
  device,
  sample: null,
  lastApply: null,
  bootError: null,
  ...patch,
});

const apply = (ok: boolean, detail?: string): LastApply => ({ ok, at: 1, detail });

// ---------------------------------------------------------------------------
// healthLevel (legacy health-only mapping, kept for the header test contract)
// ---------------------------------------------------------------------------

test('healthLevel: null health is unknown (boot in progress)', () => {
  assert.equal(healthLevel(null), 'unknown');
});

test('healthLevel: healthy -> ok; error -> error; missing igcl/level-zero -> warn', () => {
  assert.equal(healthLevel(okHealth), 'ok');
  assert.equal(healthLevel({ ...okHealth, error: 'ctlInit failed' }), 'error');
  assert.equal(healthLevel({ ...okHealth, igclLoaded: false, driverVersion: null }), 'warn');
  assert.equal(healthLevel({ ...okHealth, levelZeroOk: false }), 'warn');
});

// ---------------------------------------------------------------------------
// The five health rows
// ---------------------------------------------------------------------------

test('driverRow: ok when IGCL is loaded AND a driver version is known', () => {
  assert.deepEqual(driverRow(input()), { id: 'driver', label: 'Driver installed', level: 'ok', detail: 'IGCL loaded, driver 32.0.101.8861' });
});

test('driverRow: not loaded -> error (with the backend error text)', () => {
  const degraded: HealthInput = input({ health: { backend: 'igcl', igclLoaded: false, driverVersion: null, levelZeroOk: true } });
  assert.deepEqual(driverRow(degraded), { id: 'driver', label: 'Driver installed', level: 'error', detail: 'IGCL runtime not loaded' });
  const error: HealthInput = input({ health: { backend: 'igcl', igclLoaded: false, driverVersion: null, levelZeroOk: false, error: 'ctlInit failed' } });
  assert.deepEqual(driverRow(error), { id: 'driver', label: 'Driver installed', level: 'error', detail: 'ctlInit failed' });
});

test('driverRow: loaded but no driver version -> warn (never a false ok)', () => {
  const noVer: HealthInput = input({ health: { backend: 'igcl', igclLoaded: true, driverVersion: null, levelZeroOk: true } });
  assert.deepEqual(driverRow(noVer), { id: 'driver', label: 'Driver installed', level: 'warn', detail: 'IGCL loaded, driver version unknown' });
});

test('driverRow: no report yet -> unknown, or error when the boot failed', () => {
  assert.equal(driverRow(input({ health: null })).level, 'unknown');
  const bootFailed: HealthInput = input({ health: null, bootError: 'No Intel Arc GPU detected' });
  assert.deepEqual(driverRow(bootFailed), { id: 'driver', label: 'Driver installed', level: 'error', detail: 'No Intel Arc GPU detected' });
});

test('deviceRow: device present -> ok with its name; boot error -> error; else unknown', () => {
  assert.deepEqual(deviceRow(input()), { id: 'device', label: 'Device detected', level: 'ok', detail: 'Intel Arc A770' });
  const noDev: HealthInput = input({ device: null });
  assert.equal(deviceRow(noDev).level, 'unknown');
  const bootFailed: HealthInput = input({ device: null, bootError: 'No Intel Arc GPU detected' });
  assert.deepEqual(deviceRow(bootFailed), { id: 'device', label: 'Device detected', level: 'error', detail: 'No Intel Arc GPU detected' });
});

test('clocksRow: sane advertised clock + in-range telemetry clock -> ok', () => {
  assert.equal(clocksRow(input({ sample: sample(2100) })).level, 'ok');
  assert.equal(clocksRow(input({ sample: sample(2100) })).detail, '2100 MHz live');
});

test('clocksRow: no telemetry yet -> ok but "waiting" (never a false alarm)', () => {
  assert.equal(clocksRow(input()).level, 'ok');
  assert.match(clocksRow(input()).detail, /waiting for live telemetry/);
});

test('clocksRow: zero/absent advertised clock or insane telemetry clock -> warn', () => {
  const noAdvertised: HealthInput = input({ device: { ...device, graphicsClockMHz: 0 } });
  assert.equal(clocksRow(noAdvertised).level, 'warn');
  for (const bad of [0, -5, NaN, 99999]) {
    assert.equal(clocksRow(input({ sample: sample(bad) })).level, 'warn', `clock ${bad}`);
  }
});

test('clocksRow: no device -> unknown / boot-error', () => {
  assert.equal(clocksRow(input({ device: null })).level, 'unknown');
  assert.equal(clocksRow(input({ device: null, bootError: 'boom' })).level, 'error');
});

test('ocRow: honest tri-state — never applied / last ok / last failed', () => {
  assert.deepEqual(ocRow(input()), { id: 'oc', label: 'OC working', level: 'unknown', detail: 'No OC apply yet in this session' });
  assert.deepEqual(ocRow(input({ lastApply: apply(true, 'Power limit applied') })), { id: 'oc', label: 'OC working', level: 'ok', detail: 'Power limit applied' });
  assert.deepEqual(ocRow(input({ lastApply: apply(false, 'gpuFreqOffsetMhz: io-failed') })), { id: 'oc', label: 'OC working', level: 'error', detail: 'gpuFreqOffsetMhz: io-failed' });
  assert.deepEqual(ocRow(input({ lastApply: apply(false) })), { id: 'oc', label: 'OC working', level: 'error', detail: 'Last apply failed' });
});

test('appRow: booted backend -> ok (mock named honestly); boot failure -> error; else unknown', () => {
  assert.match(appRow(input()).detail, /App running, backend igcl/);
  assert.equal(appRow(input()).level, 'ok');
  assert.match(appRow(input({ health: mockHealth })).detail, /mock backend/);
  assert.equal(appRow(input({ health: null, bootError: 'Health check failed' })).level, 'error');
  assert.equal(appRow(input({ health: null })).level, 'unknown');
});

test('healthRows: all five rows in display order (pinned by --ui-verify)', () => {
  const rows = healthRows(input());
  assert.deepEqual(rows.map((r) => r.id), ['driver', 'device', 'clocks', 'oc', 'app']);
  assert.deepEqual(rows.map((r) => r.label), [
    'Driver installed', 'Device detected', 'Clocks normal', 'OC working', 'Arc Power working',
  ]);
});

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

test('worstLevel: error > warn > unknown > ok', () => {
  assert.equal(worstLevel(['ok']), 'ok');
  assert.equal(worstLevel(['ok', 'unknown']), 'unknown');
  assert.equal(worstLevel(['unknown', 'warn']), 'warn');
  assert.equal(worstLevel(['warn', 'error']), 'error');
});

test('overallHealthLevel: the worst of the five rows drives the card level', () => {
  // All-ok needs an applied OC row (never-applied reads as unknown).
  const healthy: HealthInput = input({ lastApply: apply(true) });
  assert.equal(overallHealthLevel(healthRows(healthy)), 'ok');
  const failed: HealthInput = input({ lastApply: apply(false) });
  assert.equal(overallHealthLevel(healthRows(failed)), 'error');
  const searching: HealthInput = input({ health: null });
  assert.equal(overallHealthLevel(healthRows(searching)), 'unknown');
});

// ---------------------------------------------------------------------------
// Dashboard re-render scoping (M2a.5-5, M3-A): full re-render on status
// changes only — telemetry ticks must not rebuild the page.
// ---------------------------------------------------------------------------

const dashSig = (patch: Partial<DashboardSig> = {}): DashboardSig => ({
  health: okHealth,
  caps: null,
  bootError: null,
  driverDate: null,
  ...patch,
});

test('dashboardNeedsFullRender: an identical signature (telemetry tick) does NOT re-render', () => {
  const sig = dashSig();
  // latestSample / lastApply are not part of the signature — the store keeps
  // the same object references for the status slots across telemetry ticks.
  assert.equal(dashboardNeedsFullRender(sig, sig), false);
  assert.equal(dashboardNeedsFullRender(sig, dashSig()), false);
});

test('dashboardNeedsFullRender: health / caps / bootError / driverDate changes DO re-render (IGS slot is gone)', () => {
  const sig = dashSig();
  const caps: Capabilities = {
    oemName: 'oem',
    deviceName: 'dev',
    waiverAccepted: false,
    controls: {},
    ranges: {},
    fan: { canControl: false, modes: [], maxRpm: 0, maxCurvePoints: 0 },
  };
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ health: null })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ caps })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ bootError: 'No Intel Arc GPU detected' })), true);
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ driverDate: '7-5-2026' })), true);
});

test('dashboardNeedsFullRender: the first update always renders', () => {
  assert.equal(dashboardNeedsFullRender(null, dashSig()), true);
});

test('healthLevel type is the health model level set (ok/warn/error/unknown)', () => {
  const levels: HealthLevel[] = ['ok', 'warn', 'error', 'unknown'];
  assert.deepEqual(levels, ['ok', 'warn', 'error', 'unknown']);
});
