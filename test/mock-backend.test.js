// M1 — MockBackend contract tests (deterministic fixtures matching the A770
// matrix; runs without hardware).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend } from '../src/main/backend/mock-backend.js';

test('listDevices: one A770-matching fixture device', async () => {
  const b = new MockBackend();
  const devices = await b.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Mock Arc A770 Graphics (fixture)');
  assert.equal(devices[0].pciDeviceId, '0x000056a0');
});

test('getCapabilities: A770 matrix (same ranges/units as the real card)', async () => {
  const b = new MockBackend();
  const caps = await b.getCapabilities(0);
  assert.deepEqual(caps.ranges.gpuFreqOffsetMhz, { min: 0, max: 300, step: 1, default: 0, units: 'MHz' });
  assert.deepEqual(caps.ranges.powerLimitW, { min: 105, max: 252, step: 1, default: 210, units: 'W' });
  assert.deepEqual(caps.ranges.tempLimitC, { min: 60, max: 90, step: 1, default: 90, units: 'C' });
  assert.ok(Math.abs(caps.ranges.gpuVoltOffsetV.max - 0.234) < 1e-9);
  assert.equal(caps.controls.vramFreqOffset, false);
  assert.equal(caps.controls.vfCurve, false);
  // M2a: the mock default reports an EDITABLE fan (canControl=true) so the
  // fan editor is fully testable in mock mode; pass fanCanControl:false for
  // the exact A770 read-only fixture (covered below).
  assert.equal(caps.fan.canControl, true);
  assert.deepEqual(caps.fan.modes, ['auto', 'curve', 'fixed']);
  assert.equal(caps.fan.maxRpm, 3000);
  assert.equal(caps.fan.maxCurvePoints, 10);
  assert.equal(caps.waiverAccepted, false);
});

test('getCapabilities: fanCanControl:false reproduces the A770 read-only fan fixture', async () => {
  const b = new MockBackend({ fanCanControl: false });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.fan.canControl, false);
  assert.deepEqual(caps.fan.modes, ['fixed']);
  assert.equal(caps.fan.maxRpm, -1);
  assert.equal(caps.fan.maxCurvePoints, 10);
});

test('getCurrentSettings: defaults resolved (powerLimit 210 W, fan curve 10 points)', async () => {
  const b = new MockBackend();
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, 210);
  assert.equal(s.gpuFreqOffsetMhz, 0);
  assert.equal(s.gpuVoltOffsetV, 0);
  assert.equal(s.tempLimitC, 90);
  assert.equal(s.vramFreqOffsetGts, null);
  assert.equal(s.vramVoltOffsetV, null);
  assert.deepEqual(s.gpuLock, { voltageV: 0, freqMhz: 0 });
  assert.equal(s.fanMode, 'curve');
  assert.equal(s.fanCurve.length, 10);
  assert.equal(s.fanCurve[9].t, 90);
  assert.equal(s.fanCurve[9].speedPct, 100);
  assert.equal(s.fixedFanPct, null);
});

test('applySettings: no-op round trip; state unchanged', async () => {
  const b = new MockBackend();
  const before = await b.getCurrentSettings(0);
  const res = await b.applySettings(0, {
    powerLimitW: before.powerLimitW,
    gpuVoltOffsetV: before.gpuVoltOffsetV,
    gpuFreqOffsetMhz: before.gpuFreqOffsetMhz,
    tempLimitC: before.tempLimitC,
  });
  assert.equal(res.ok, true);
  for (const k of ['powerLimitW', 'gpuVoltOffsetV', 'gpuFreqOffsetMhz', 'tempLimitC']) {
    assert.equal(res.perControl[k].ok, true, k);
  }
  const after = await b.getCurrentSettings(0);
  assert.deepEqual(after, before);
});

test('applySettings: clamps to fixture ranges', async () => {
  const b = new MockBackend();
  const res = await b.applySettings(0, { powerLimitW: 999, tempLimitC: 10 });
  assert.equal(res.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, 252);
  assert.equal(s.tempLimitC, 60);
});

test('applySettings: voltage snaps to 0.005 steps', async () => {
  const b = new MockBackend();
  await b.applySettings(0, { gpuVoltOffsetV: 0.012 });
  const s = await b.getCurrentSettings(0);
  assert.equal(s.gpuVoltOffsetV, 0.01);
});

test('applySettings: unsupported controls fail with unsupported', async () => {
  const b = new MockBackend();
  const res = await b.applySettings(0, { vramFreqOffsetGts: 0.5 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.vramFreqOffsetGts.errorCode, 'unsupported');
});

test('applySettings: fan requests fail unsupported on the A770 read-only fixture and never mutate fan state', async () => {
  const b = new MockBackend({ fanCanControl: false });
  const res = await b.applySettings(0, { fanMode: 'auto', fanCurve: [{ t: 20, speedPct: 100 }], fixedFanPct: 50 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fanMode.errorCode, 'unsupported');
  assert.equal(res.perControl.fanCurve.errorCode, 'unsupported');
  assert.equal(res.perControl.fixedFanPct.errorCode, 'unsupported');
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fanCurve[0].speedPct, 20); // unchanged
});

test('applySettings: editable fan — curve apply sorts, clamps count and %, switches mode', async () => {
  const b = new MockBackend();
  const res = await b.applySettings(0, {
    fanMode: 'curve',
    fanCurve: [
      { t: 90, speedPct: 100 }, { t: 20, speedPct: 20 }, { t: 50, speedPct: 40 },
      { t: 21, speedPct: 130 }, { t: 22, speedPct: -5 }, // clamps to 100 / 0
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.fanCurve.ok, true);
  assert.equal(res.perControl.fanMode.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fanMode, 'curve');
  assert.deepEqual(s.fanCurve.map((p) => p.t), [20, 21, 22, 50, 90]); // ascending
  assert.equal(s.fanCurve[1].speedPct, 100); // t=21 was 130 -> clamped
  assert.equal(s.fanCurve[2].speedPct, 0); // t=22 was -5 -> clamped
});

test('applySettings: editable fan — point count clamped to maxCurvePoints', async () => {
  const b = new MockBackend();
  const many = Array.from({ length: 30 }, (_, i) => ({ t: 20 + i * 2, speedPct: 20 + i }));
  const res = await b.applySettings(0, { fanCurve: many });
  assert.equal(res.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fanCurve.length, 10); // maxCurvePoints
});

test('applySettings: editable fan — fixedFanPct clamps to 0..100 and switches mode', async () => {
  const b = new MockBackend();
  const res = await b.applySettings(0, { fixedFanPct: 150 });
  assert.equal(res.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fixedFanPct, 100);
  assert.equal(s.fanMode, 'fixed');
});

test('applySettings: editable fan — auto mode switches to auto', async () => {
  const b = new MockBackend();
  const res = await b.applySettings(0, { fanMode: 'auto' });
  assert.equal(res.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fanMode, 'auto');
});

test('applySettings: injected failOn returns the canned error code', async () => {
  const b = new MockBackend({ failOn: { powerLimitW: 'out-of-range' } });
  const res = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.powerLimitW.errorCode, 'out-of-range');
});

test('applySettings: gpuLock extremes are clamped like the real backend (F1 regression)', async () => {
  const b = new MockBackend();
  const res = await b.applySettings(0, { gpuLock: { voltageV: 99, freqMhz: -5 } });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.gpuLock.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.deepEqual(s.gpuLock, { voltageV: 0.234, freqMhz: 0 });
});

test('injectFail: dev-only knob forces a control failure and clears', async () => {
  const b = new MockBackend();
  b.injectFail('fanCurve', 'out-of-range');
  const res = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  assert.equal(res.perControl.fanCurve.errorCode, 'out-of-range');
  b.injectFail('fanCurve', null);
  const ok = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  assert.equal(ok.perControl.fanCurve.ok, true);
});

// M2b review F3 — one-shot fail mode: the failure fires on the NEXT apply
// that touches the control, then clears (lets the retry succeed).
test('injectFail: once:true fails only the next apply (one-shot)', async () => {
  const b = new MockBackend();
  b.injectFail('powerLimitW', 'io-failed', true);
  const first = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(first.ok, false);
  assert.equal(first.perControl.powerLimitW.errorCode, 'io-failed');
  const second = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(second.ok, true);
  assert.equal(second.perControl.powerLimitW.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, 220);
  // A one-shot fan failure clears too.
  b.injectFail('fanCurve', 'io-failed', true);
  const fanFail = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  assert.equal(fanFail.perControl.fanCurve.errorCode, 'io-failed');
  const fanOk = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  assert.equal(fanOk.perControl.fanCurve.ok, true);
});

test('offGridFreqMhz: mock can report a driver value off the 1 MHz grid (ui-verify)', async () => {
  const b = new MockBackend({ offGridFreqMhz: 48.3 });
  const s = await b.getCurrentSettings(0);
  assert.equal(s.gpuFreqOffsetMhz, 48.3);
});

test('resetToDefaults: restores fixture defaults', async () => {
  const b = new MockBackend();
  await b.applySettings(0, { powerLimitW: 252, gpuFreqOffsetMhz: 300 });
  await b.resetToDefaults(0);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, 210);
  assert.equal(s.gpuFreqOffsetMhz, 0);
});

test('setWaiverAccepted + waiverAccepted in capabilities', async () => {
  const b = new MockBackend();
  assert.equal((await b.getCapabilities(0)).waiverAccepted, false);
  await b.setWaiverAccepted(0);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
});

test('restoreWaiverState: seeds the in-memory flag without implicit acceptance (F1 regression)', async () => {
  const b = new MockBackend();
  await b.restoreWaiverState(0, true);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
  // an apply after a restored acceptance never re-accepts; state is unchanged
  const res = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(res.ok, true);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
  // a persisted "not accepted" clears the flag again
  await b.restoreWaiverState(0, false);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, false);
});

test('applySettings: waiver-not-set clears the stale in-memory flag (G2 regression)', async () => {
  const b = new MockBackend();
  await b.restoreWaiverState(0, true); // persisted "accepted" boot seed
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
  // Driver lost the waiver: the apply answers waiver-not-set...
  b.injectFail('powerLimitW', 'waiver-not-set');
  const res = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.powerLimitW.errorCode, 'waiver-not-set');
  // ...and the stale in-memory flag is cleared (mock parity with IgclBackend).
  assert.equal((await b.getCapabilities(0)).waiverAccepted, false);
  b.injectFail('powerLimitW', null);
  // Re-accept via the product path; the next apply succeeds without re-clearing.
  await b.setWaiverAccepted(0);
  const ok = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(ok.ok, true);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
});

test('telemetry: deterministic ramp — energy rises by the configured step', async () => {
  const b = new MockBackend();
  const s0 = await b.sampleRawTelemetry(0);
  const s1 = await b.sampleRawTelemetry(0);
  assert.ok(Math.abs(s1.gpuEnergyJ - s0.gpuEnergyJ - 19.4) < 1e-6);
  assert.ok(s1.t > s0.t);
  assert.equal(s1.gpuClockMhz - s0.gpuClockMhz, 100);
  assert.deepEqual(s1.fanRpm, [1030]);
  // deterministic: a fresh backend produces identical first samples
  const b2 = new MockBackend();
  const t0 = await b2.sampleRawTelemetry(0);
  assert.equal(t0.gpuEnergyJ, s0.gpuEnergyJ);
});

test('telemetry: onRawTelemetry subscriber + unsubscribe', async () => {
  const b = new MockBackend();
  const seen = [];
  const unsub = b.onRawTelemetry(0, (s) => seen.push(s));
  await b.sampleRawTelemetry(0);
  await b.sampleRawTelemetry(0);
  assert.equal(seen.length, 2);
  unsub();
  await b.sampleRawTelemetry(0);
  assert.equal(seen.length, 2);
});

test('health: mock reports loaded + fixture driver version', async () => {
  const b = new MockBackend();
  const h = await b.health();
  assert.equal(h.igclLoaded, true);
  assert.equal(h.levelZeroOk, true);
  assert.match(h.driverVersion, /32\.0\.101\.8861/);
});

test('close: unsubscribes subscribers', async () => {
  const b = new MockBackend();
  const seen = [];
  b.onRawTelemetry(0, (s) => seen.push(s));
  await b.close();
  await b.sampleRawTelemetry(0);
  assert.equal(seen.length, 0);
});
