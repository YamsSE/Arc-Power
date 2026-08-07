// M3-A + M3-C-I + M4-A — GPU health row model (pure). The IGS-era combined
// mapping (mapStatus / IGS_LABELS / igsHalfState / IGS_NOTE) is REMOVED:
// with the M2C-C elevation gate, IGS state is no longer relevant to
// OC-applicability, so the dashboard's merged Service Status card became the
// general GPU HEALTH card. M3-C-I trims it to FOUR honest rows (the "Clocks
// normal" row is removed per the user's dashboard picture); M4-A adds the
// FIVEth row — "OC waiver" (Accepted ok / Not Accepted error, the ONLY
// persistent waiver display — user correction, mid-M4-A):
//   driver ("Driver installed" — detail = driver version + date like the
//           device card), device ("Device detected"), oc ("OC Status" —
//   waiver ("OC waiver" — LIVE caps.waiverAccepted), app ("Arc Power
//   working" — healthy detail "App & Service Running").
// Each row: level (ok/warn/error/unknown) + a human detail line. The health
// card re-renders on the same status slots (health/caps/bootError/driverDate)
// — telemetry ticks only refresh the live readout grid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  healthLevel,
  healthRows,
  driverRow,
  deviceRow,
  ocRow,
  waiverRow,
  appRow,
  overallHealthLevel,
  worstLevel,
  dashboardNeedsFullRender,
} from '../src/renderer/pure/status.ts';
import type { DashboardSig, HealthInput, HealthLevel } from '../src/renderer/pure/status.ts';
import type { Capabilities, DeviceInfo, HealthReport, LastApply } from '../src/renderer/types.ts';

const okHealth: HealthReport = { backend: 'igcl', igclLoaded: true, driverVersion: '0x002000000065229d', levelZeroOk: true };
const mockHealth: HealthReport = { backend: 'mock', igclLoaded: true, driverVersion: '32.0.101.8861', levelZeroOk: true };
const device: DeviceInfo = {
  id: 0, name: 'Intel Arc A770', type: 'discrete', pciVendorId: '8086', pciDeviceId: '56a0', revId: 5,
  bdf: { bus: 1, device: 0, function: 0 }, driverVersion: '0x002000000065229d', graphicsClockMHz: 2400, numXeCores: 32,
};

const input = (patch: Partial<HealthInput> = {}): HealthInput => ({
  health: okHealth,
  device,
  sample: null,
  lastApply: null,
  bootError: null,
  driverDate: null,
  waiverAccepted: null,
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
// The four health rows
// ---------------------------------------------------------------------------

test('driverRow: ok when IGCL is loaded AND a driver version is known', () => {
  // M3-C-I: the ok detail is the driver version + date like the device card
  // (decode the IGCL hex uint64; append the registry date when known).
  assert.deepEqual(driverRow(input()), { id: 'driver', label: 'Driver installed', level: 'ok', detail: '32.0.101.8861' });
  assert.deepEqual(driverRow(input({ driverDate: '7-5-2026' })), {
    id: 'driver', label: 'Driver installed', level: 'ok', detail: '32.0.101.8861 - Jul 05, 2026',
  });
  // Already-dotted reports (mock fixture) pass through verbatim.
  assert.equal(driverRow(input({ health: mockHealth })).detail, '32.0.101.8861');
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

test('M4-A: waiverRow — LIVE caps.waiverAccepted drives Accepted/Not Accepted (unknown before caps land)', () => {
  assert.deepEqual(waiverRow(input()), { id: 'waiver', label: 'OC waiver', level: 'unknown', detail: 'Waiting for device…' });
  assert.deepEqual(waiverRow(input({ waiverAccepted: true })), { id: 'waiver', label: 'OC waiver', level: 'ok', detail: 'Accepted' });
  assert.deepEqual(waiverRow(input({ waiverAccepted: false })), { id: 'waiver', label: 'OC waiver', level: 'error', detail: 'Not Accepted' });
});

test('M3-C-I: the "Clocks normal" row is REMOVED (clocksRow no longer exists)', () => {
  const rows = healthRows(input());
  assert.ok(!rows.some((r) => r.id === 'clocks' as never), 'no clocks row');
  assert.ok(!rows.some((r) => r.label === 'Clocks normal'), 'no clocks label');
});

test('ocRow: honest tri-state — never applied / last ok / last failed', () => {
  assert.deepEqual(ocRow(input()), { id: 'oc', label: 'OC Status', level: 'unknown', detail: 'No OC apply yet in this session' });
  assert.deepEqual(ocRow(input({ lastApply: apply(true, 'Power limit applied') })), { id: 'oc', label: 'OC Status', level: 'ok', detail: 'Power limit applied' });
  assert.deepEqual(ocRow(input({ lastApply: apply(false, 'gpuFreqOffsetMhz: io-failed') })), { id: 'oc', label: 'OC Status', level: 'error', detail: 'gpuFreqOffsetMhz: io-failed' });
  assert.deepEqual(ocRow(input({ lastApply: apply(false) })), { id: 'oc', label: 'OC Status', level: 'error', detail: 'Last apply failed' });
});

test('M3-C-I: appRow healthy detail reads "App & Service Running" (app-only, NO IGS probe)', () => {
  assert.deepEqual(appRow(input()), { id: 'app', label: 'Arc Power working', level: 'ok', detail: 'App & Service Running' });
  assert.deepEqual(appRow(input({ health: mockHealth })), { id: 'app', label: 'Arc Power working', level: 'ok', detail: 'App & Service Running' });
  assert.equal(appRow(input({ health: null, bootError: 'Health check failed' })).level, 'error');
  assert.equal(appRow(input({ health: null })).level, 'unknown');
});

test('healthRows: all five rows in display order (pinned by --ui-verify)', () => {
  const rows = healthRows(input());
  assert.deepEqual(rows.map((r) => r.id), ['driver', 'device', 'oc', 'waiver', 'app']);
  assert.deepEqual(rows.map((r) => r.label), [
    'Driver installed', 'Device detected', 'OC Status', 'OC waiver', 'Arc Power working',
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
  // All-ok needs an applied OC row AND an accepted waiver (never-applied
  // reads as unknown; an unaccepted waiver reads as error).
  const healthy: HealthInput = input({ lastApply: apply(true), waiverAccepted: true });
  assert.equal(overallHealthLevel(healthRows(healthy)), 'ok');
  const failed: HealthInput = input({ lastApply: apply(false) });
  assert.equal(overallHealthLevel(healthRows(failed)), 'error');
  const unaccepted: HealthInput = input({ lastApply: apply(true), waiverAccepted: false });
  assert.equal(overallHealthLevel(healthRows(unaccepted)), 'error');
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
  sysinfo: null,
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

test('M4-D: the sysinfo landing re-renders the dashboard (the CPU card appears when it arrives)', () => {
  const sig = dashSig();
  const sysinfo = {
    cpu: { name: 'Intel(R) Core(TM) i7-14700K', cores: 20, threads: 28, maxClockMhz: 5600 },
    ram: { totalBytes: 34359738368, speedMhz: 6000, manufacturer: 'G.Skill' },
    videoControllers: [],
  };
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ sysinfo })), true);
  // The same sysinfo object reference does NOT re-render (telemetry-tick-like).
  assert.equal(dashboardNeedsFullRender(sig, dashSig({ sysinfo: null })), false);
});

test('dashboardNeedsFullRender: the first update always renders', () => {
  assert.equal(dashboardNeedsFullRender(null, dashSig()), true);
});

test('healthLevel type is the health model level set (ok/warn/error/unknown)', () => {
  const levels: HealthLevel[] = ['ok', 'warn', 'error', 'unknown'];
  assert.deepEqual(levels, ['ok', 'warn', 'error', 'unknown']);
});
