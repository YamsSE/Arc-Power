// M2C-C — per-control runtime routing tests (apply-routing.js): the split
// (<=252 W / <=90 C -> DriverStore, above -> bundled 2023 runtime), the
// momentary-lie delayed re-read for the DriverStore part, the honest
// old-runtime failure, mixed applies and the extended-range gating helper.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitByRuntime, applySettingsRouted, executeApply, requiresExtendedRange,
  isMomentaryLieCandidate, createNullOldIgcl,
  STD_PL_MAX_W, STD_TL_MAX_C, EXTENDED_UNAVAILABLE_MSG, DELAYED_VERIFY_MS,
} from '../src/main/apply-routing.js';
import { MockBackend, createMockOldIgcl } from '../src/main/backend/mock-backend.js';

// ---------------------------------------------------------------------------
// splitByRuntime
// ---------------------------------------------------------------------------

test('splitByRuntime: <=252 W and <=90 C go to the DriverStore runtime', () => {
  const { driverstore, extended } = splitByRuntime({ powerLimitW: 252, tempLimitC: 90, gpuFreqOffsetMhz: 100, gpuVoltOffsetV: 0.05 });
  assert.deepEqual(driverstore, { powerLimitW: 252, tempLimitC: 90, gpuFreqOffsetMhz: 100, gpuVoltOffsetV: 0.05 });
  assert.deepEqual(extended, {});
});

test('splitByRuntime: PL > 252 and TL > 90 route to the extended (2023) runtime', () => {
  const { driverstore, extended } = splitByRuntime({ powerLimitW: 300, tempLimitC: 100, gpuFreqOffsetMhz: 100 });
  assert.deepEqual(driverstore, { gpuFreqOffsetMhz: 100 });
  assert.deepEqual(extended, { powerLimitW: 300, tempLimitC: 100 });
});

test('splitByRuntime: mixed applies split per control; null values are dropped', () => {
  const { driverstore, extended } = splitByRuntime({ powerLimitW: 280, tempLimitC: 85, fanMode: 'auto', powerLimitW2: null });
  assert.deepEqual(driverstore, { tempLimitC: 85, fanMode: 'auto' });
  assert.deepEqual(extended, { powerLimitW: 280 });
});

test('requiresExtendedRange: true only when PL > 252 or TL > 90', () => {
  assert.equal(requiresExtendedRange({ powerLimitW: 253 }), true);
  assert.equal(requiresExtendedRange({ powerLimitW: 252 }), false);
  assert.equal(requiresExtendedRange({ tempLimitC: 91 }), true);
  assert.equal(requiresExtendedRange({ tempLimitC: 90 }), false);
  assert.equal(requiresExtendedRange({ powerLimitW: 220, tempLimitC: 85, gpuFreqOffsetMhz: 100 }), false);
  assert.equal(requiresExtendedRange({}), false);
  assert.equal(requiresExtendedRange(null), false);
});

// ---------------------------------------------------------------------------
// isMomentaryLieCandidate
// ---------------------------------------------------------------------------

test('isMomentaryLieCandidate: only the SUCCESS-but-mismatch shape re-reads', () => {
  assert.equal(isMomentaryLieCandidate({ ok: false, errorCode: 'io-failed', readBackEqual: false }), true);
  assert.equal(isMomentaryLieCandidate({ ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true }), true);
  assert.equal(isMomentaryLieCandidate({ ok: true, readBackEqual: true }), false);
  assert.equal(isMomentaryLieCandidate({ ok: false, errorCode: 'out-of-range' }), false, 'hard errors never re-read');
  assert.equal(isMomentaryLieCandidate({ ok: false, errorCode: 'waiver-not-set' }), false);
  assert.equal(isMomentaryLieCandidate({ ok: false }), false);
  assert.equal(isMomentaryLieCandidate(undefined), false);
});

// ---------------------------------------------------------------------------
// Routing end-to-end (MockBackend + mock old runtime)
// ---------------------------------------------------------------------------

test('routing: an in-range apply goes entirely through the DriverStore runtime (mock old runtime untouched)', async () => {
  const backend = new MockBackend();
  const oldIgcl = {
    isCapable: async () => true,
    calls: [],
    setPowerLimitW: async () => { oldIgcl.calls.push('setPowerLimitW'); return { ok: true, readBackEqual: true }; },
    setTempLimitC: async () => { oldIgcl.calls.push('setTempLimitC'); return { ok: true, readBackEqual: true }; },
  };
  const out = await applySettingsRouted({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 220, tempLimitC: 85 } });
  assert.equal(out.result.ok, true);
  assert.equal(oldIgcl.calls.length, 0, 'no old-runtime call for in-range values');
  assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 220);
});

test('routing: PL > 252 routes to the old runtime; the DriverStore backend never sees it', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const oldIgcl = {
    isCapable: async () => true,
    calls: [],
    setPowerLimitW: async (w) => { oldIgcl.calls.push(w); return { ok: true, readBackEqual: true }; },
    setTempLimitC: async () => ({ ok: true, readBackEqual: true }),
  };
  const out = await applySettingsRouted({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300 } });
  assert.equal(out.result.ok, true);
  assert.deepEqual(oldIgcl.calls, [300]);
  assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210, 'mock driverstore state untouched');
});

test('routing: mixed apply uses BOTH runtimes in one call', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const oldIgcl = {
    isCapable: async () => true,
    calls: [],
    setPowerLimitW: async (w) => { oldIgcl.calls.push(w); return { ok: true, readBackEqual: true }; },
    setTempLimitC: async (c) => { oldIgcl.calls.push(c); return { ok: true, readBackEqual: true }; },
  };
  const out = await applySettingsRouted({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300, tempLimitC: 85, gpuFreqOffsetMhz: 50 } });
  assert.equal(out.result.ok, true);
  assert.deepEqual(oldIgcl.calls, [300]);
  const state = await backend.getCurrentSettings(0);
  assert.equal(state.gpuFreqOffsetMhz, 50, 'driverstore control applied');
  assert.equal(state.powerLimitW, 210, 'extended control did not touch the driverstore state');
});

test('routing: old-runtime failure on a future driver = honest per-control fail with the clear message', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const oldIgcl = createNullOldIgcl(); // not capable — the degradation path
  const out = await applySettingsRouted({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300 } });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.powerLimitW.errorCode, 'unsupported');
  assert.equal(out.result.perControl.powerLimitW.message, EXTENDED_UNAVAILABLE_MSG);
});

test('routing: a real old-runtime failure (out-of-range) stays a per-control fail', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const oldIgcl = {
    isCapable: async () => true,
    setPowerLimitW: async () => ({ ok: false, errorCode: 'out-of-range', readBackEqual: false, message: 'IGCL ERROR_CORE_OVERCLOCK_POWER_OUTSIDE_RANGE (0x44000004)' }),
    setTempLimitC: async () => ({ ok: true, readBackEqual: true }),
  };
  const out = await applySettingsRouted({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300, tempLimitC: 95 } });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.tempLimitC.ok, true, 'independent controls stay independent');
});

test('routing: the momentary-lie guard upgrades a lagging driverstore read-back on the delayed re-read', async () => {
  const backend = new MockBackend();
  // The setter reports SUCCESS but the immediate read-back lags (210) — the
  // write lands before the delayed re-read (220).
  backend.applySettings = async (deviceId, settings) => {
    if (settings.powerLimitW !== undefined) {
      // apply but keep the read-back lagging
      return { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true, message: 'read-back 210 != requested 220' } } };
    }
    return MockBackend.prototype.applySettings.call(backend, deviceId, settings);
  };
  backend.getCurrentSettings = async (deviceId) => {
    const state = await MockBackend.prototype.getCurrentSettings.call(backend, deviceId);
    // the delayed re-read sees the value (the write persisted)
    return { ...state, powerLimitW: 220 };
  };
  const slept = [];
  const out = await applySettingsRouted({
    backend, oldIgcl: createNullOldIgcl(), deviceId: 0,
    settings: { powerLimitW: 220 },
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(out.result.ok, true, 'delayed match = the write persisted');
  assert.equal(out.result.perControl.powerLimitW.ok, true);
  assert.equal(out.result.perControl.powerLimitW.message, undefined, 'the refusal message is cleared on upgrade');
  assert.deepEqual(slept, [DELAYED_VERIFY_MS]);
});

test('routing: a still-mismatched delayed re-read stays an honest fail', async () => {
  const backend = new MockBackend();
  backend.applySettings = async () => ({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true, message: 'read-back 210 != requested 220' } } });
  backend.getCurrentSettings = async (deviceId) => {
    const state = await MockBackend.prototype.getCurrentSettings.call(backend, deviceId);
    return { ...state, powerLimitW: 210 }; // never changes
  };
  const out = await applySettingsRouted({ backend, oldIgcl: createNullOldIgcl(), deviceId: 0, settings: { powerLimitW: 220 } });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
});

test('routing: hard errors are NEVER re-read (no sleep, no upgrade)', async () => {
  const backend = new MockBackend();
  backend.applySettings = async () => ({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'waiver-not-set' } } });
  const slept = [];
  const out = await applySettingsRouted({ backend, oldIgcl: createNullOldIgcl(), deviceId: 0, settings: { powerLimitW: 220 }, sleep: async (ms) => { slept.push(ms); } });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.errorCode, 'waiver-not-set');
  assert.deepEqual(slept, [], 'no delayed re-read for hard errors');
});

test('routing: empty settings -> ok with no per-control results', async () => {
  const backend = new MockBackend();
  const out = await applySettingsRouted({ backend, oldIgcl: createNullOldIgcl(), deviceId: 0, settings: {} });
  assert.equal(out.result.ok, true);
  assert.deepEqual(out.result.perControl, {});
});

// ---------------------------------------------------------------------------
// executeApply (clamp + routed apply + state read-back)
// ---------------------------------------------------------------------------

test('executeApply: clamps to the capability ranges then routes; returns the fresh state', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const oldIgcl = createMockOldIgcl(backend);
  const out = await executeApply({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 999, tempLimitC: 200, gpuFreqOffsetMhz: 50 } });
  assert.equal(out.result.ok, true);
  assert.equal(out.state.powerLimitW, 315, 'clamped to the extended max');
  assert.equal(out.state.tempLimitC, 115, 'clamped to the extended TL max');
  assert.equal(out.state.gpuFreqOffsetMhz, 50);
});

test('executeApply: extended values land in the mock state via the mock old runtime (read-back matches)', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const oldIgcl = createMockOldIgcl(backend);
  const out = await executeApply({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300 } });
  assert.equal(out.result.ok, true);
  assert.equal(out.result.perControl.powerLimitW.ok, true);
  assert.equal(out.state.powerLimitW, 300);
});

test('executeApply: extended fail (extendedFail mock) -> honest per-control failure', async () => {
  const backend = new MockBackend({ extendedRanges: true, extendedFail: true });
  const oldIgcl = createMockOldIgcl(backend);
  const out = await executeApply({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300 } });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.message, EXTENDED_UNAVAILABLE_MSG);
});
