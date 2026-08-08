// M1 — MockBackend contract tests (deterministic fixtures matching the A770
// matrix; runs without hardware).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend } from '../src/main/backend/mock-backend.js';

test('listDevices: one A770-matching fixture device', async () => {
  const b = new MockBackend();
  const devices = await b.listDevices();
  assert.equal(devices.length, 1);
  // M4-B: the device name carries the VRAM suffix (16 GiB a770 featureset) —
  // formatted ONCE at listDevices time.
  assert.equal(devices[0].name, 'Mock Arc A770 Graphics (fixture) 16 GB');
  assert.equal(devices[0].vramBytes, 16 * 1024 * 1024 * 1024);
  assert.equal(devices[0].pciDeviceId, '0x000056a0');
});

test('1.0.1 no-Intel: the mock enumerates NOTHING + health reports igclLoaded false (the no-Intel machine shape)', async () => {
  const b = new MockBackend({ noIntel: true });
  assert.deepEqual(await b.listDevices(), []);
  const h = await b.health();
  assert.equal(h.igclLoaded, false);
  assert.equal(h.driverVersion, null);
  assert.equal(h.levelZeroOk, false);
  assert.equal(h.error, undefined, 'no raw error text — the honest no-Intel rows must never show the IGCL error');
  // The featureset machinery still exists (the dropdown data is hidden by
  // the renderer on the noIntel flag, not by the mock).
  const fx = await b.listFeaturesets();
  assert.equal(fx.featuresets.length, 4);
});

test('getCapabilities: A770 matrix (same ranges/units as the real card)', async () => {
  // M3-D: the a770 featureset base now carries the REAL EDITABLE fan (the
  // live-verified probe path — canControl=true, modes ['auto','curve']); the
  // read-only surface is the fanCanControl:false overlay (RID_MOCK_FAN_READONLY).
  // The standard (non-extended) ranges are the extendedRanges:false overlay —
  // the featureset base carries the extended maxes natively (M2C-C verified).
  const b = new MockBackend({ fanCanControl: true, extendedRanges: false });
  const caps = await b.getCapabilities(0);
  // M4-B: the offset ranges mirror into the negative half-plane.
  assert.deepEqual(caps.ranges.gpuFreqOffsetMhz, { min: -300, max: 300, step: 1, default: 0, units: 'MHz' });
  assert.deepEqual(caps.ranges.powerLimitW, { min: 105, max: 252, step: 1, default: 210, units: 'W' });
  assert.deepEqual(caps.ranges.tempLimitC, { min: 60, max: 90, step: 1, default: 90, units: 'C' });
  assert.ok(Math.abs(caps.ranges.gpuVoltOffsetV.max - 0.234) < 1e-9);
  assert.ok(Math.abs(caps.ranges.gpuVoltOffsetV.min + 0.234) < 1e-9, 'volt offset min mirrors to -0.234');
  assert.equal(caps.controls.vramFreqOffset, false);
  assert.equal(caps.controls.vfCurve, false);
  // the editable-fan fixture: canControl=true with the learned modes
  // auto/curve (fixed is genuinely unsupported on this card — M3-D).
  assert.equal(caps.fan.canControl, true);
  assert.deepEqual(caps.fan.modes, ['auto', 'curve']);
  assert.equal(caps.fan.maxRpm, 3000);
  assert.equal(caps.fan.maxCurvePoints, 10);
  assert.equal(caps.waiverAccepted, false);
});

test('getCapabilities: M2D — the DEFAULT mock is the a770 featureset (editable fan + extended ranges, advanced mode)', async () => {
  const b = new MockBackend();
  const caps = await b.getCapabilities(0);
  // the featureset base drives the fan (real A770: editable via the M3-D
  // live-verified probe path) and the extended ranges (the bundled 2023
  // runtime is verified on this machine). M3-C-E: the mock default OC mode
  // is advanced (the extended-flow pins).
  assert.equal(caps.fan.canControl, true);
  assert.deepEqual(caps.fan.modes, ['auto', 'curve']);
  assert.equal(caps.extendedRanges, true);
  assert.equal(caps.ranges.powerLimitW.max, 315); // M3-C-D: live-verified ceiling
  assert.equal(caps.ranges.tempLimitC.max, 115);
});

test('M3-C-E: mock stock mode exposes only the standard ranges (no flag)', async () => {
  const b = new MockBackend({ ocMode: 'stock' });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.extendedRanges, undefined);
  assert.equal(caps.ranges.powerLimitW.max, 252);
  assert.equal(caps.ranges.tempLimitC.max, 90);
  // setOcMode flips live, exactly like the real backend's cache invalidation.
  b.setOcMode('advanced');
  const adv = await b.getCapabilities(0);
  assert.equal(adv.extendedRanges, true);
  assert.equal(adv.ranges.powerLimitW.max, 315);
  b.setOcMode('stock');
  assert.equal((await b.getCapabilities(0)).extendedRanges, undefined);
});

test('getCapabilities: fanCanControl:false reproduces the read-only fan overlay (the card\'s true modes kept)', async () => {
  const b = new MockBackend({ fanCanControl: false });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.fan.canControl, false);
  assert.deepEqual(caps.fan.modes, ['auto', 'curve']);
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
  // M2D: the a770 featureset carries the extended ranges natively (max 315
  // per M3-C-D — the live-verified KMD ceiling) and the mock default mode is advanced.
  assert.equal(s.powerLimitW, 315);
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
  const b = new MockBackend({ fanCanControl: true });
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
  const b = new MockBackend({ fanCanControl: true });
  const many = Array.from({ length: 30 }, (_, i) => ({ t: 20 + i * 2, speedPct: 20 + i }));
  const res = await b.applySettings(0, { fanCurve: many });
  assert.equal(res.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fanCurve.length, 10); // maxCurvePoints
});

test('applySettings: editable fan — fixedFanPct is refused (fixed is not a real A770 mode, M3-D)', async () => {
  const b = new MockBackend({ fanCanControl: true });
  const res = await b.applySettings(0, { fixedFanPct: 150 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fixedFanPct.errorCode, 'unsupported');
  assert.match(res.perControl.fixedFanPct.message, /fan mode fixed not supported/);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fixedFanPct, null, 'fan state untouched');
  assert.equal(s.fanMode, 'curve', 'mode untouched');
});

test('applySettings: editable fan — auto mode switches to auto', async () => {
  const b = new MockBackend({ fanCanControl: true });
  const res = await b.applySettings(0, { fanMode: 'auto' });
  assert.equal(res.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.fanMode, 'auto');
});

test('applySettings: injected failOn returns the canned error code', async () => {
  const b = new MockBackend({ failOn: { powerLimitW: 'out-of-range' }, extendedRanges: false });
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
  // M4-B: the clamp is the documented ABSOLUTE ceiling (1.5 V), not the
  // 0.234 V offset bound — real lock voltages (~0.7-1.2 V) must survive.
  assert.deepEqual(s.gpuLock, { voltageV: 1.5, freqMhz: 0 });
});

test('injectFail: dev-only knob forces a control failure and clears', async () => {
  const b = new MockBackend({ fanCanControl: true });
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
  const b = new MockBackend({ fanCanControl: true });
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

// ---------------------------------------------------------------------------
// M2C-C extended ranges (the mock's bundled-2023-runtime fixture)
// ---------------------------------------------------------------------------

import { createMockOldIgcl } from '../src/main/backend/mock-backend.js';
import { EXTENDED_UNAVAILABLE_MSG } from '../src/main/apply-routing.js';

test('M2C-C: extendedRanges:true exposes PL max 315 / TL max 115 + the flag (mock default advanced)', async () => {
  const b = new MockBackend({ extendedRanges: true });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.extendedRanges, true);
  assert.equal(caps.ranges.powerLimitW.max, 315); // M3-C-D: live-verified ceiling
  assert.equal(caps.ranges.tempLimitC.max, 115);
  assert.equal(caps.ranges.powerLimitW.default, 210, 'default unchanged');
  assert.equal(b.extendedCapable, true);
});

test('M2C-C: default mock has standard ranges and is NOT extended-capable', async () => {
  // M2D: the a770 featureset carries extendedRanges natively — the standard
  // fixture is the explicit overlay (extendedRanges:false).
  const b = new MockBackend({ extendedRanges: false });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.extendedRanges, undefined);
  assert.equal(caps.ranges.powerLimitW.max, 252);
  assert.equal(b.extendedCapable, false);
});

test('M2C-C: mock old runtime applies extended values into the state (read-back matches)', async () => {
  const b = new MockBackend({ extendedRanges: true });
  const old = createMockOldIgcl(b);
  assert.equal(await old.isCapable(), true);
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, true);
  assert.equal(b._state.powerLimitW, 300);
  const per2 = await old.setTempLimitC(100);
  assert.equal(per2.ok, true);
  assert.equal(b._state.tempLimitC, 100);
  assert.equal((await b.getCurrentSettings(0)).powerLimitW, 300);
});

test('M2C-C: mock old runtime clamps to the extended max (315 W / 115 C)', async () => {
  const b = new MockBackend({ extendedRanges: true });
  const old = createMockOldIgcl(b);
  await old.setPowerLimitW(999);
  assert.equal(b._state.powerLimitW, 315);
  await old.setTempLimitC(999);
  assert.equal(b._state.tempLimitC, 115);
});

test('M2C-C: mock old runtime NOT capable -> honest unavailable message', async () => {
  const b = new MockBackend({ extendedRanges: false }); // standard ranges
  const old = createMockOldIgcl(b);
  assert.equal(await old.isCapable(), false);
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, false);
  assert.equal(per.message, EXTENDED_UNAVAILABLE_MSG);
});

test('M2C-C: extendedFail -> the old-runtime mock answers with the honest failure', async () => {
  const b = new MockBackend({ extendedRanges: true, extendedFail: true });
  const old = createMockOldIgcl(b);
  const per = await old.setPowerLimitW(300);
  assert.equal(per.ok, false);
  assert.equal(per.message, EXTENDED_UNAVAILABLE_MSG);
  assert.equal(b._state.powerLimitW, 210, 'device untouched');
});

// ---------------------------------------------------------------------------
// M4-F — the 2-device mock (RID_MOCK_MULTI_DEVICE=1 / opts.multiDevice):
// device ids 0 AND 1; device 1 = the arc-igpu line with DISTINCT
// caps/state/waiver/telemetry; the swap rebuilds BOTH devices.
// ---------------------------------------------------------------------------

test('M4-F: single-device mock stays BYTE-IDENTICAL when the multi-device knob is off', async () => {
  const b = new MockBackend();
  const devices = await b.listDevices();
  assert.equal(devices.length, 1, 'the default session enumerates ONE device');
  assert.equal(devices[0].id, 0);
  await assert.rejects(() => b.getCapabilities(1), /unknown device id 1/, 'no second device exists');
});

test('M4-F: listDevices emits ids 0 AND 1; device 1 is the arc-igpu line with distinct names/pci/bdf', async () => {
  const b = new MockBackend({ multiDevice: true });
  const devices = await b.listDevices();
  assert.equal(devices.length, 2);
  assert.deepEqual(devices.map((d) => d.id), [0, 1]);
  assert.match(devices[0].name, /Arc A770/);
  assert.match(devices[1].name, /Arc iGPU/);
  assert.equal(devices[1].pciDeviceId, '0x00007d1d', 'the arc-igpu fixture pci id');
  assert.deepEqual(devices[1].bdf, { bus: 0, device: 2, function: 0 }, 'distinct bus slot');
  assert.equal(devices[1].vramBytes, null, 'an iGPU has no VRAM');
});

test('M4-F: per-device caps — device 0 has the full A770 matrix, device 1 is telemetry-only', async () => {
  const b = new MockBackend({ multiDevice: true });
  const caps0 = await b.getCapabilities(0);
  const caps1 = await b.getCapabilities(1);
  assert.equal(caps0.controls.powerLimit, true);
  assert.equal(caps0.ranges.powerLimitW.max, 315, 'device 0 keeps the extended ceiling (advanced mock default)');
  assert.equal(caps0.fan.canControl, true);
  assert.equal(caps1.controls.powerLimit, false, 'the iGPU exposes no OC controls');
  assert.deepEqual(caps1.ranges, {}, 'no ranges');
  assert.equal(caps1.fan.canControl, false);
  assert.equal(caps1.extendedRanges, undefined, 'the arc-igpu is never extended-capable');
  assert.notEqual(caps0.deviceName, caps1.deviceName);
});

test('M4-F: per-device state — an apply to ONE device never leaks into the other', async () => {
  const b = new MockBackend({ multiDevice: true });
  const res = await b.applySettings(0, { powerLimitW: 240 });
  assert.equal(res.ok, true);
  assert.equal((await b.getCurrentSettings(0)).powerLimitW, 240, 'device 0 applied');
  const s1 = await b.getCurrentSettings(1);
  assert.equal(s1.powerLimitW, null, 'device 1 has no powerLimit control');
  // Unsupported-control failures are per device too.
  const fail = await b.applySettings(1, { powerLimitW: 240 });
  assert.equal(fail.ok, false);
  assert.equal(fail.perControl.powerLimitW.errorCode, 'unsupported');
  assert.equal((await b.getCurrentSettings(0)).powerLimitW, 240, 'device 0 untouched by the device-1 refusal');
});

test('M4-F: the waiver flag is PER-DEVICE (mirror the real backend per-device Map)', async () => {
  const b = new MockBackend({ multiDevice: true });
  assert.equal((await b.getCapabilities(0)).waiverAccepted, false);
  assert.equal((await b.getCapabilities(1)).waiverAccepted, false);
  await b.setWaiverAccepted(1);
  assert.equal((await b.getCapabilities(1)).waiverAccepted, true, 'device 1 accepted');
  assert.equal((await b.getCapabilities(0)).waiverAccepted, false, 'device 0 untouched');
  await b.restoreWaiverState(0, true);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
  assert.equal((await b.getCapabilities(1)).waiverAccepted, true, 'both accepted independently');
  await b.restoreWaiverState(1, false);
  assert.equal((await b.getCapabilities(1)).waiverAccepted, false);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
});

test('M4-F: per-device telemetry ramps — device 1 steps energy differently and has its own timeline', async () => {
  const b = new MockBackend({ multiDevice: true });
  const a0 = await b.sampleRawTelemetry(0);
  const a1 = await b.sampleRawTelemetry(0);
  const i0 = await b.sampleRawTelemetry(1);
  const i1 = await b.sampleRawTelemetry(1);
  // Energy step: a770 = 38.8 W * 0.5 s = 19.4 J; arc-igpu = 8 W * 0.5 = 4 J.
  assert.ok(Math.abs(a1.gpuEnergyJ - a0.gpuEnergyJ - 19.4) < 1e-6, 'device 0 ramps at the a770 step');
  assert.ok(Math.abs(i1.gpuEnergyJ - i0.gpuEnergyJ - 4) < 1e-6, 'device 1 ramps at the arc-igpu step');
  assert.notEqual(a0.t, i0.t, 'distinct timelines (the samples never collide)');
  assert.equal(a1.gpuClockMhz - a0.gpuClockMhz, 100);
  assert.equal(i1.gpuClockMhz - i0.gpuClockMhz, 100);
  assert.equal(a0.gpuClockMhz, 600, 'a770 clock base');
  assert.equal(i0.gpuClockMhz, 350, 'arc-igpu clock base');
  assert.equal(a0.tempC, 36, 'a770 temp base');
  assert.equal(i0.tempC, 45, 'arc-igpu temp base');
  assert.deepEqual(a0.fanRpm, [1030], 'the a770 has a fan');
  assert.equal(i0.fanRpm, null, 'the iGPU has no fan');
});

test('M4-F: onRawTelemetry dispatches PER-DEVICE (a device-0 subscriber never sees device-1 samples)', async () => {
  const b = new MockBackend({ multiDevice: true });
  const seen0 = [];
  const seen1 = [];
  const unsub0 = b.onRawTelemetry(0, (s) => seen0.push(s));
  const unsub1 = b.onRawTelemetry(1, (s) => seen1.push(s));
  await b.sampleRawTelemetry(0);
  await b.sampleRawTelemetry(1);
  assert.equal(seen0.length, 1);
  assert.equal(seen1.length, 1);
  assert.equal(seen0[0].gpuClockMhz, 600);
  assert.equal(seen1[0].gpuClockMhz, 350);
  unsub0();
  await b.sampleRawTelemetry(0);
  assert.equal(seen0.length, 1, 'unsubscribed device-0 cb stays quiet');
  assert.equal(seen1.length, 1);
  // close() clears both device channels.
  await b.close();
  await b.sampleRawTelemetry(1);
  assert.equal(seen1.length, 1);
});

test('M4-F: resetToDefaults is per device', async () => {
  const b = new MockBackend({ multiDevice: true });
  await b.applySettings(0, { powerLimitW: 240 });
  await b.resetToDefaults(0);
  assert.equal((await b.getCurrentSettings(0)).powerLimitW, 210, 'device 0 reset');
  const s1 = await b.getCurrentSettings(1);
  assert.equal(s1.gpuFreqOffsetMhz, null, 'device 1 untouched by the device-0 reset');
});

test('M4-F: pciProperties is per device — the iGPU has no ReBAR capability', async () => {
  const b = new MockBackend({ multiDevice: true });
  const p0 = await b.pciProperties(0);
  assert.equal(p0.resizableBarSupported, true);
  assert.equal(p0.resizableBarEnabled, true);
  const p1 = await b.pciProperties(1);
  assert.equal(p1.resizableBarSupported, false, 'no ReBAR on the iGPU');
  assert.equal(p1.resizableBarEnabled, false);
  assert.deepEqual([p1.bus, p1.device, p1.function], [0, 2, 0]);
});

test('M4-F: setOcMode rebuilds the caps of BOTH devices', async () => {
  const b = new MockBackend({ multiDevice: true, extendedRanges: true });
  assert.equal((await b.getCapabilities(0)).ranges.powerLimitW.max, 315);
  assert.equal((await b.getCapabilities(1)).extendedRanges, undefined);
  b.setOcMode('stock');
  assert.equal((await b.getCapabilities(0)).ranges.powerLimitW.max, 252, 'device 0 caps rebuilt to stock');
  assert.equal((await b.getCapabilities(1)).extendedRanges, undefined, 'device 1 stays non-extended');
  b.setOcMode('advanced');
  assert.equal((await b.getCapabilities(0)).ranges.powerLimitW.max, 315);
});

test('M4-F: setFeatureset (the M2D swap) rebuilds BOTH devices; device 1 stays the arc-igpu line', async () => {
  const b = new MockBackend({ multiDevice: true });
  await b.setFeatureset('b580');
  const devices = await b.listDevices();
  assert.equal(devices.length, 2, 'the multi-device session keeps both devices after a swap');
  const caps0 = await b.getCapabilities(0);
  assert.match(caps0.deviceName, /B580/, 'device 0 carries the swapped featureset');
  const caps1 = await b.getCapabilities(1);
  assert.match(caps1.deviceName, /iGPU/, 'device 1 stays the arc-igpu line');
  assert.equal(await b.getCurrentSettings(1).then((s) => s.fanMode), null, 'device 1 rebuilt fresh (no fan)');
  // The swap resets device 0's timeline but preserves its waiver (consent).
  await b.setWaiverAccepted(0);
  await b.setFeatureset('a770');
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true, 'the waiver survives a swap');
  const devices2 = await b.listDevices();
  assert.equal(devices2.length, 2);
});
