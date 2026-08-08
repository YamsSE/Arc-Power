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
  ocModeRefusal, refusalPerControl, OC_MODE_REFUSAL_MSG, OC_CEILING_REFUSAL_MSG,
  OC_MODES, extendedUnavailableRefusal, extendedUnavailablePerControl,
} from '../src/main/apply-routing.js';
import { MockBackend, createMockOldIgcl } from '../src/main/backend/mock-backend.js';
import { loadFeatureset } from '../src/main/backend/featuresets.js';

// ---------------------------------------------------------------------------
// M3-C-E — the OC-mode gate (one shared pure refusal function)
// ---------------------------------------------------------------------------

test('ocModeRefusal: stock mode refuses anything beyond the standard limits (252 W / 90 C)', () => {
  assert.equal(ocModeRefusal('stock', { powerLimitW: 220, tempLimitC: 90 }), null);
  assert.equal(ocModeRefusal('stock', { gpuFreqOffsetMhz: 300 }), null);
  assert.equal(ocModeRefusal('stock', {}), null);
  const r1 = ocModeRefusal('stock', { powerLimitW: 253 });
  assert.deepEqual(r1, { mode: 'stock', controls: ['powerLimitW'], message: OC_MODE_REFUSAL_MSG });
  const r2 = ocModeRefusal('stock', { tempLimitC: 91 });
  assert.deepEqual(r2, { mode: 'stock', controls: ['tempLimitC'], message: OC_MODE_REFUSAL_MSG });
  const r3 = ocModeRefusal('stock', { powerLimitW: 300, tempLimitC: 100 });
  assert.deepEqual(r3.controls.sort(), ['powerLimitW', 'tempLimitC']);
  assert.equal(r3.message, OC_MODE_REFUSAL_MSG);
});

test('ocModeRefusal: advanced mode allows up to the extended ceiling (315 W / 115 C)', () => {
  assert.equal(ocModeRefusal('advanced', { powerLimitW: 315, tempLimitC: 115 }), null);
  assert.equal(ocModeRefusal('advanced', { powerLimitW: 300 }), null);
  assert.equal(ocModeRefusal('advanced', { tempLimitC: 100 }), null);
});

test('M3-C-D: above-ceiling values REFUSE in advanced mode — never clamped', () => {
  const r = ocModeRefusal('advanced', { powerLimitW: 401 });
  assert.deepEqual(r, { mode: 'advanced', controls: ['powerLimitW'], message: OC_CEILING_REFUSAL_MSG });
  const r2 = ocModeRefusal('advanced', { powerLimitW: 500, tempLimitC: 116 });
  assert.deepEqual(r2.controls.sort(), ['powerLimitW', 'tempLimitC']);
  assert.equal(r2.message, OC_CEILING_REFUSAL_MSG);
  // The gate NEVER clamps: 401 stays 401 in the refusal (the clamp layer is
  // bypassed entirely by the callers).
  assert.equal(r.controls.length, 1);
});

test('ocModeRefusal: an unknown ocMode degrades to stock (safe direction)', () => {
  const r = ocModeRefusal(undefined, { powerLimitW: 300 });
  assert.equal(r.mode, 'stock');
  const r2 = ocModeRefusal('turbo', { powerLimitW: 300 });
  assert.equal(r2.mode, 'stock');
});

test('ocModeRefusal: null/garbage settings never refuse', () => {
  assert.equal(ocModeRefusal('stock', null), null);
  assert.equal(ocModeRefusal('stock', undefined), null);
  assert.equal(ocModeRefusal('advanced', []), null);
});

test('M4-E: ocModeRefusal is unit-aware — percent-unit values (B580) are NEVER mode-refused', () => {
  const percentRanges = {
    powerLimitW: { units: '%' },
    tempLimitC: { units: '%' },
    gpuVoltOffsetV: { units: '%' },
  };
  // The b580 percent apply rides tempLimitC at its 100 % default — stock
  // mode must NOT treat 100 % as "100 C beyond the standard limit": the
  // whole apply would be refused on a device with no extended concept.
  assert.equal(ocModeRefusal('stock', { powerLimitW: 150, tempLimitC: 100, gpuVoltOffsetV: 12 }, percentRanges), null, '100 % is not 100 C');
  // Advanced ceiling too: percent values have no W/C ceiling — the range
  // clamp is the guard, never the mode gate.
  assert.equal(ocModeRefusal('advanced', { powerLimitW: 400, tempLimitC: 100 }, percentRanges), null);
  // W/C units keep the gate exactly as before (A770).
  const wcRanges = { powerLimitW: { units: 'W' }, tempLimitC: { units: 'C' } };
  assert.deepEqual(ocModeRefusal('stock', { powerLimitW: 300, tempLimitC: 100 }, wcRanges), {
    mode: 'stock', controls: ['powerLimitW', 'tempLimitC'], message: OC_MODE_REFUSAL_MSG,
  });
  assert.deepEqual(ocModeRefusal('advanced', { powerLimitW: 400 }, wcRanges), {
    mode: 'advanced', controls: ['powerLimitW'], message: OC_CEILING_REFUSAL_MSG,
  });
  // Unknown ranges keep the historical threshold behavior (backward compat).
  assert.deepEqual(ocModeRefusal('stock', { powerLimitW: 300 }), {
    mode: 'stock', controls: ['powerLimitW'], message: OC_MODE_REFUSAL_MSG,
  });
});

test('refusalPerControl: per-control failures carry the mode message only', () => {
  const per = refusalPerControl(ocModeRefusal('stock', { powerLimitW: 300, tempLimitC: 95 }));
  assert.deepEqual(Object.keys(per).sort(), ['powerLimitW', 'tempLimitC']);
  for (const p of Object.values(per)) {
    assert.equal(p.ok, false);
    assert.equal(p.errorCode, 'out-of-range');
    assert.equal(p.message, OC_MODE_REFUSAL_MSG);
  }
});

// ---------------------------------------------------------------------------
// M3-C step-5 F1 — the capability refusal: advanced mode + a NOT-capable
// bundled 2023 runtime must refuse PL > 252 / TL > 90 BEFORE any clamp
// (never a silent 252 W / 90 C cap reported as ok:true).
// ---------------------------------------------------------------------------

test('F1: extendedUnavailableRefusal refuses extended values when caps expose NO extended ranges', () => {
  const caps = { extendedRanges: false, ranges: { powerLimitW: { units: 'W' }, tempLimitC: { units: 'C' } } };
  const r1 = extendedUnavailableRefusal({ powerLimitW: 300 }, caps);
  assert.deepEqual(r1, { controls: ['powerLimitW'], message: EXTENDED_UNAVAILABLE_MSG });
  const r2 = extendedUnavailableRefusal({ tempLimitC: 100 }, caps);
  assert.deepEqual(r2, { controls: ['tempLimitC'], message: EXTENDED_UNAVAILABLE_MSG });
  const r3 = extendedUnavailableRefusal({ powerLimitW: 300, tempLimitC: 100 }, caps);
  assert.deepEqual(r3.controls.sort(), ['powerLimitW', 'tempLimitC']);
  assert.equal(r3.message, EXTENDED_UNAVAILABLE_MSG);
  // The refusal never clamps: the requested value stays in the descriptor.
  assert.equal(r3.controls.length, 2);
});

test('F1: extendedUnavailableRefusal never fires when the capability exists (extendedRanges true)', () => {
  const caps = { extendedRanges: true, ranges: { powerLimitW: { units: 'W' }, tempLimitC: { units: 'C' } } };
  assert.equal(extendedUnavailableRefusal({ powerLimitW: 300, tempLimitC: 100 }, caps), null);
});

test('F1: extendedUnavailableRefusal never fires for in-range values or non-PL/TL controls', () => {
  const caps = { extendedRanges: false, ranges: { powerLimitW: { units: 'W' }, tempLimitC: { units: 'C' } } };
  assert.equal(extendedUnavailableRefusal({ powerLimitW: 252, tempLimitC: 90, gpuFreqOffsetMhz: 300 }, caps), null);
  assert.equal(extendedUnavailableRefusal({}, caps), null);
  assert.equal(extendedUnavailableRefusal(null, caps), null);
  // No caps at all -> the capability cannot be confirmed; the safe direction
  // is the historical threshold behavior (refuse) — never a silent clamp.
  assert.deepEqual(extendedUnavailableRefusal({ powerLimitW: 300 }, undefined), { controls: ['powerLimitW'], message: EXTENDED_UNAVAILABLE_MSG });
});

test('F1: extendedUnavailableRefusal is unit-aware — percent-unit values (B580) are NEVER refused', () => {
  const percentCaps = { extendedRanges: false, ranges: { powerLimitW: { units: '%' }, tempLimitC: { units: '%' } } };
  assert.equal(extendedUnavailableRefusal({ powerLimitW: 120, tempLimitC: 100, gpuVoltOffsetV: 12 }, percentCaps), null, '100 % is not 100 C');
  // Unknown units keep the historical threshold behavior.
  const unknownCaps = { extendedRanges: false, ranges: {} };
  assert.deepEqual(extendedUnavailableRefusal({ powerLimitW: 300 }, unknownCaps), { controls: ['powerLimitW'], message: EXTENDED_UNAVAILABLE_MSG });
});

test('F1: extendedUnavailablePerControl reports the honest unsupported shape per control', () => {
  const per = extendedUnavailablePerControl(['powerLimitW', 'tempLimitC']);
  assert.deepEqual(Object.keys(per).sort(), ['powerLimitW', 'tempLimitC']);
  for (const p of Object.values(per)) {
    assert.equal(p.ok, false);
    assert.equal(p.errorCode, 'unsupported');
    assert.equal(p.message, EXTENDED_UNAVAILABLE_MSG);
  }
});

test('OC_MODES: the persisted vocabulary is stock|advanced', () => {
  assert.deepEqual(OC_MODES, ['stock', 'advanced']);
});

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

test('M2D: splitByRuntime is unit-aware — percent-unit values are NEVER extended (B580)', () => {
  const percentRanges = {
    powerLimitW: { units: '%' },
    tempLimitC: { units: '%' },
    gpuVoltOffsetV: { units: '%' },
  };
  const { driverstore, extended } = splitByRuntime({ powerLimitW: 120, tempLimitC: 100, gpuVoltOffsetV: 12 }, percentRanges);
  assert.deepEqual(driverstore, { powerLimitW: 120, tempLimitC: 100, gpuVoltOffsetV: 12 });
  assert.deepEqual(extended, {}, '100 % is not 100 C — the DriverStore runtime handles percent units');
  // W/C units still route above the DriverStore clamps (A770).
  const wcRanges = { powerLimitW: { units: 'W' }, tempLimitC: { units: 'C' } };
  const wc = splitByRuntime({ powerLimitW: 300, tempLimitC: 115 }, wcRanges);
  assert.deepEqual(wc.driverstore, {});
  assert.deepEqual(wc.extended, { powerLimitW: 300, tempLimitC: 115 });
  // No ranges -> the historical threshold behavior (backward compatible).
  const none = splitByRuntime({ powerLimitW: 300, tempLimitC: 100 });
  assert.deepEqual(none.extended, { powerLimitW: 300, tempLimitC: 100 });
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
  assert.equal(out.state.powerLimitW, 315, 'clamped to the extended max (M3-C-D: 315 W, live-verified)');
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

test('F1: executeApply REFUSES extended values when the 2023 runtime is NOT capable — never a silent 252 W clamp', async () => {
  const backend = new MockBackend({ extendedRanges: false }); // not-capable degradation
  const oldIgcl = createMockOldIgcl(backend);
  const out = await executeApply({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300, tempLimitC: 100 } });
  assert.equal(out.result.ok, false, 'a not-capable runtime must never report ok:true');
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.tempLimitC.ok, false);
  assert.equal(out.result.perControl.powerLimitW.errorCode, 'unsupported');
  assert.equal(out.result.perControl.powerLimitW.message, EXTENDED_UNAVAILABLE_MSG);
  assert.equal(out.result.perControl.tempLimitC.message, EXTENDED_UNAVAILABLE_MSG);
  // The refusal never touches the device: the state is the untouched default.
  assert.equal(out.state.powerLimitW, 210, 'the fresh state read-back is the untouched device state');
  assert.equal(backend._state.powerLimitW, 210, 'the clamp never ran');
  assert.equal(backend._state.tempLimitC, 90, 'the clamp never ran');
});

test('F1: executeApply — the extended-capable case still applies 300 W through the same path', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const oldIgcl = createMockOldIgcl(backend);
  const out = await executeApply({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300, tempLimitC: 100 } });
  assert.equal(out.result.ok, true);
  assert.equal(out.state.powerLimitW, 300);
  assert.equal(out.state.tempLimitC, 100);
});

test('executeApply: extended fail (extendedFail mock) -> honest per-control failure', async () => {
  const backend = new MockBackend({ extendedRanges: true, extendedFail: true });
  const oldIgcl = createMockOldIgcl(backend);
  const out = await executeApply({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 300 } });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.message, EXTENDED_UNAVAILABLE_MSG);
});

test('M2D: executeApply — B580 percent apply of ALL four controls -> all driverstore, no EXTENDED_UNAVAILABLE', async () => {
  const backend = new MockBackend({ featureset: loadFeatureset('b580') });
  const oldIgcl = createMockOldIgcl(backend);
  // The renderer always sends all four scalar controls (tempLimitC rides at
  // its 100 % default) — every b580 apply must go to the DriverStore runtime.
  const out = await executeApply({
    backend, oldIgcl, deviceId: 0,
    settings: { powerLimitW: 120, tempLimitC: 100, gpuVoltOffsetV: 12, gpuFreqOffsetMhz: 50 },
  });
  assert.equal(out.result.ok, true, 'the percent tempLimitC must not fail the whole apply');
  for (const key of ['powerLimitW', 'tempLimitC', 'gpuVoltOffsetV', 'gpuFreqOffsetMhz']) {
    assert.equal(out.result.perControl[key].ok, true, `${key} applied via the DriverStore runtime`);
    assert.notEqual(out.result.perControl[key].message, EXTENDED_UNAVAILABLE_MSG);
  }
  assert.equal(out.state.powerLimitW, 120);
  assert.equal(out.state.tempLimitC, 100);
  assert.equal(out.state.gpuVoltOffsetV, 12);
  assert.equal(out.state.gpuFreqOffsetMhz, 50);
});

test('M2D: executeApply — A770 tempLimitC 115 (C units) still routes to the extended bucket', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const oldIgcl = createMockOldIgcl(backend);
  const out = await executeApply({ backend, oldIgcl, deviceId: 0, settings: { powerLimitW: 220, tempLimitC: 115 } });
  assert.equal(out.result.ok, true);
  assert.equal(out.result.perControl.tempLimitC.ok, true, 'C-unit TL above 90 goes through the 2023 runtime');
  assert.equal(out.state.tempLimitC, 115);
  assert.equal(out.state.powerLimitW, 220, 'the in-range PL control stays on the DriverStore path');
});
