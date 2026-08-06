// M2a — renderer pure logic: apply-settings payload validation + builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSettingsPayload,
  buildScalarSettings,
  buildFanSettings,
  isNoopApply,
  isControlDirty,
  profileApplyOutcome,
  clampExposedRange,
  isControlDirtyVsApplied,
  computeDirtyVsApplied,
  isScalarDirtyVsApplied,
  ocStateChanged,
  ocCapsChanged,
  TEMP_LIMIT_MAX_C,
} from '../src/renderer/pure/settings.ts';
import { computePresets } from '../src/renderer/pure/presets.ts';
import type { Capabilities, DeviceState, RangeInfo, Settings } from '../src/renderer/types.ts';

test('validateSettingsPayload: accepts a full legal payload', () => {
  const payload: unknown = {
    powerLimitW: 220,
    gpuVoltOffsetV: 0.1,
    gpuFreqOffsetMhz: 48,
    tempLimitC: 85,
    gpuLock: { voltageV: 0.9, freqMhz: 2100 },
    fanMode: 'curve',
    fanCurve: [{ t: 20, speedPct: 20 }, { t: 90, speedPct: 100 }],
    fixedFanPct: 50,
  };
  assert.equal(validateSettingsPayload(payload), true);
});

test('validateSettingsPayload: rejects non-objects and unknown keys', () => {
  for (const bad of [null, 5, 'x', [], true]) {
    assert.equal(validateSettingsPayload(bad), false);
  }
  assert.equal(validateSettingsPayload({ powerLimitW: 220, evil: 1 }), false);
  assert.equal(validateSettingsPayload({ powerLimitW: 220, fanMode: 'turbo' }), false);
});

test('validateSettingsPayload: rejects NaN / Infinity / wrong-typed scalars', () => {
  for (const bad of [NaN, Infinity, '220', null, undefined, {}]) {
    assert.equal(validateSettingsPayload({ powerLimitW: bad }), false, String(bad));
  }
  assert.equal(validateSettingsPayload({ tempLimitC: 85 }), true);
});

test('validateSettingsPayload: rejects malformed gpuLock and curve arrays', () => {
  assert.equal(validateSettingsPayload({ gpuLock: { voltageV: 'x' } }), false);
  assert.equal(validateSettingsPayload({ gpuLock: { voltageV: 0.9 } }), false);
  assert.equal(validateSettingsPayload({ fanCurve: [{ t: 20 }] }), false);
  assert.equal(validateSettingsPayload({ fanCurve: 'nope' }), false);
  assert.equal(validateSettingsPayload({ fanCurve: Array.from({ length: 33 }, (_, i) => ({ t: i, speedPct: 1 })) }), false);
  assert.equal(validateSettingsPayload({ vfCurve: [{ voltageV: 0.9, freqMhz: 1800 }] }), true);
});

test('validateSettingsPayload: rejects empty curve arrays, accepts a 32-point cap (F5 regression)', () => {
  assert.equal(validateSettingsPayload({ fanCurve: [] }), false);
  assert.equal(validateSettingsPayload({ vfCurve: [] }), false);
  const curve32 = Array.from({ length: 32 }, (_, i) => ({ t: 20 + i, speedPct: 20 + i }));
  assert.equal(validateSettingsPayload({ fanCurve: curve32 }), true);
  assert.equal(validateSettingsPayload({ fanCurve: [...curve32, { t: 99, speedPct: 99 }] }), false);
});

test('buildScalarSettings: only finite scalar values make it in', () => {
  const out = buildScalarSettings({ powerLimitW: 220, gpuVoltOffsetV: 0.1, gpuFreqOffsetMhz: 48, tempLimitC: 85, evil: 42 });
  assert.deepEqual(out, { powerLimitW: 220, gpuVoltOffsetV: 0.1, gpuFreqOffsetMhz: 48, tempLimitC: 85 });
  const clean = buildScalarSettings({ powerLimitW: NaN });
  assert.deepEqual(clean, {});
});

test('buildFanSettings: curve mode carries the curve, fixed mode the percent', () => {
  const curve: Settings = buildFanSettings('curve', [{ t: 20, speedPct: 20 }], 50);
  assert.deepEqual(curve, { fanMode: 'curve', fanCurve: [{ t: 20, speedPct: 20 }] });
  const fixed: Settings = buildFanSettings('fixed', [], 35);
  assert.deepEqual(fixed, { fanMode: 'fixed', fixedFanPct: 35 });
  const auto: Settings = buildFanSettings('auto', [], 0);
  assert.deepEqual(auto, { fanMode: 'auto' });
  for (const s of [curve, fixed, auto]) assert.equal(validateSettingsPayload(s), true);
});

// ---------------------------------------------------------------------------
// M2b-B — dirty / no-op detection (floating Apply + toast suppression)
// ---------------------------------------------------------------------------

const mockState: DeviceState = {
  powerLimitW: 210,
  gpuVoltOffsetV: 0,
  gpuFreqOffsetMhz: 0,
  tempLimitC: 90,
  vramFreqOffsetGts: null,
  vramVoltOffsetV: null,
  gpuLock: { voltageV: 0, freqMhz: 0 },
  vfCurve: null,
  fanMode: 'curve',
  fanCurve: [{ t: 20, speedPct: 20 }, { t: 90, speedPct: 100 }],
  fixedFanPct: null,
};

test('isNoopApply: requested == pre-apply state is a no-op; a real change is not', () => {
  assert.equal(isNoopApply('powerLimitW', { powerLimitW: 210 }, mockState), true);
  assert.equal(isNoopApply('powerLimitW', { powerLimitW: 220 }, mockState), false);
  assert.equal(isNoopApply('gpuFreqOffsetMhz', { powerLimitW: 220, gpuFreqOffsetMhz: 0 }, mockState), true);
});

test('isNoopApply: controls not present in the payload are never judged', () => {
  assert.equal(isNoopApply('tempLimitC', { powerLimitW: 220 }, mockState), true);
});

test('isControlDirty: number / string / gpuLock / curve comparisons stay type-honest', () => {
  assert.equal(isControlDirty('powerLimitW', { powerLimitW: 210.0000001 }, mockState), true);
  assert.equal(isControlDirty('fanMode', { fanMode: 'curve' }, mockState), false);
  assert.equal(isControlDirty('gpuLock', { gpuLock: { voltageV: 0, freqMhz: 0 } }, mockState), false);
  assert.equal(isControlDirty('fanCurve', { fanCurve: [{ t: 20, speedPct: 20 }, { t: 90, speedPct: 100 }] }, mockState), false);
});

test('isControlDirty: a missing driver read-back counts as dirty (cannot verify)', () => {
  assert.equal(isControlDirty('vramFreqOffsetGts', { vramFreqOffsetGts: 2 }, mockState), true);
});

// M2b review F3 — the "Applied on retry" warn was deleted with the retry
// machinery (M2C-B F3 instant apply): no retry note exists anymore. The
// remaining post-apply surface is profileApplyOutcome (M2b step-5 NIT 2):
// a partially-failed profile load must NOT mark the profile active nor
// claim "applied to the GPU" (the per-control error toasts already covered
// it); only result.ok may gate the active mark.

// M2b step-5 NIT 2 — a partially-failed profile load must NOT mark the
// profile active nor claim "applied to the GPU" (the per-control error
// toasts already covered it); only result.ok may gate the active mark.
test('profileApplyOutcome: partial failure never marks active or claims applied', () => {
  assert.deepEqual(profileApplyOutcome({ ok: false }, 'Game Boost', 3), { markActive: false, toast: null });
  assert.deepEqual(profileApplyOutcome({ ok: false }, 'Game Boost', 0), { markActive: false, toast: null });
  const full = profileApplyOutcome({ ok: true }, 'Game Boost', 3);
  assert.deepEqual(full, { markActive: true, toast: '"Game Boost" applied to the GPU.' });
  const noop = profileApplyOutcome({ ok: true }, 'Game Boost', 0);
  assert.deepEqual(noop, { markActive: true, toast: '"Game Boost" matches the current GPU state — nothing changed.' });
});

// ---------------------------------------------------------------------------
// M2C-A F3 — PT clamp (92 -> 90)
// ---------------------------------------------------------------------------

test('F3 PT clamp: the renderer ceiling is 90 C', () => {
  assert.equal(TEMP_LIMIT_MAX_C, 90);
});

test('F3 PT clamp: clampExposedRange pins the temp-limit max to 90 (sliders + presets)', () => {
  const drifted = { min: 60, max: 92, step: 1, default: 90, units: 'C' };
  const clamped = clampExposedRange(drifted, 'tempLimitC');
  assert.equal(clamped?.max, 90);
  // Presets derive from the clamped range: no chip may ever exceed 90.
  const presets = computePresets(clamped as RangeInfo);
  assert.ok(presets.every((p) => p.value <= 90), JSON.stringify(presets));
  assert.equal(Math.max(...presets.map((p) => p.value)), 90);
});

test('F3 PT clamp: an already-legal range and other controls pass through untouched', () => {
  const legal = { min: 60, max: 90, step: 1, default: 90, units: 'C' };
  assert.equal(clampExposedRange(legal, 'tempLimitC'), legal, 'same object when already legal');
  const pl = { min: 105, max: 252, step: 1, default: 210, units: 'W' };
  assert.equal(clampExposedRange(pl, 'powerLimitW'), pl);
  assert.equal(clampExposedRange(undefined, 'tempLimitC'), undefined);
});

// ---------------------------------------------------------------------------
// M2C-B B5 — applied-reference dirty detection (chips + floating Apply)
// ---------------------------------------------------------------------------
// (a) the dirty reference for the "Unapplied" chips AND the floating Apply
//     button: per-`result.ok` control it becomes the APPLIED value, so the
//     chip clears and the button hides even while the driver read-back lags;
// (b) the no-op suppression comparison (isNoopApply) stays against the
//     driver read-back — the silent-success rule survives.

test('B5: an applied control is clean against its applied value even when the driver read-back lags', () => {
  // Apply 220 W succeeded; the driver read-back still reports 210.
  const laggingState: DeviceState = { ...mockState, powerLimitW: 210 };
  const applied = { powerLimitW: 220 };
  assert.equal(isControlDirtyVsApplied('powerLimitW', { powerLimitW: 220 }, laggingState, applied), false);
  assert.equal(isScalarDirtyVsApplied('powerLimitW', 220, laggingState, applied), false);
  assert.equal(computeDirtyVsApplied({ powerLimitW: 220 }, laggingState, applied), false);
});

test('B5: a control NOT in the applied reference judges against the driver read-back', () => {
  const applied = { powerLimitW: 220 };
  assert.equal(isControlDirtyVsApplied('gpuFreqOffsetMhz', { gpuFreqOffsetMhz: 50 }, mockState, applied), true);
  assert.equal(isControlDirtyVsApplied('gpuFreqOffsetMhz', { gpuFreqOffsetMhz: 0 }, mockState, applied), false);
  // the old dirty predicate is unchanged for controls outside the reference
  assert.equal(isControlDirty('gpuFreqOffsetMhz', { gpuFreqOffsetMhz: 50 }, mockState), true);
});

test('B5: moving the slider after a successful apply re-dirties the control', () => {
  const laggingState: DeviceState = { ...mockState, powerLimitW: 210 };
  const applied = { powerLimitW: 220 };
  assert.equal(isScalarDirtyVsApplied('powerLimitW', 230, laggingState, applied), true, 'new slider value is dirty');
  assert.equal(isScalarDirtyVsApplied('powerLimitW', 220, laggingState, applied), false, 'same as applied is clean');
});

test('B5: a missing driver read-back still counts as dirty (cannot verify) unless applied', () => {
  const applied = { vramFreqOffsetGts: 2 };
  assert.equal(isScalarDirtyVsApplied('vramFreqOffsetGts', 2, mockState, applied), false, 'applied reference covers it');
  assert.equal(isScalarDirtyVsApplied('vramFreqOffsetGts', 3, mockState, applied), true);
  assert.equal(isControlDirtyVsApplied('vramFreqOffsetGts', { vramFreqOffsetGts: 2 }, mockState, {}), true);
});

test('B5(b): repeat-apply of an identical value stays silent (no-op suppression against the read-back)', () => {
  // The value already equals the driver read-back BEFORE the apply: a
  // success must not toast — unchanged from M2b-B. The applied reference
  // never leaks into this comparison (isNoopApply takes no reference).
  assert.equal(isNoopApply('powerLimitW', { powerLimitW: 210 }, mockState), true);
  assert.equal(isNoopApply('powerLimitW', { powerLimitW: 220 }, mockState), false);
});

test('B5: computeDirtyVsApplied is any-dirty across the payload', () => {
  const laggingState: DeviceState = { ...mockState, powerLimitW: 210 };
  const applied = { powerLimitW: 220 };
  assert.equal(computeDirtyVsApplied({ powerLimitW: 220, gpuFreqOffsetMhz: 0 }, laggingState, applied), false);
  assert.equal(computeDirtyVsApplied({ powerLimitW: 220, gpuFreqOffsetMhz: 50 }, laggingState, applied), true);
});

// M3-C review F2 — a null device state (the store was never populated / a
// refusal landed no state) must NEVER throw: the dirty helpers treat it as
// "nothing applied yet" (missing controls not dirty). Before the fix the
// renderer stored the refusal envelope's state:null unconditionally, and
// updateFloating/computeDirtyVsApplied crashed on the null state.
test('F2: the dirty helpers are NULL-SAFE — a null state never throws and is never dirty', () => {
  assert.equal(computeDirtyVsApplied({ powerLimitW: 220 }, null, {}), false, 'no applied reference, null state -> not dirty');
  assert.equal(computeDirtyVsApplied({ powerLimitW: 220, gpuFreqOffsetMhz: 50 }, null, {}), false);
  assert.equal(isControlDirty('powerLimitW', { powerLimitW: 220 }, null), false);
  assert.equal(isControlDirty('fanCurve', { fanCurve: [{ t: 20, speedPct: 20 }] }, null), false);
  assert.equal(isNoopApply('powerLimitW', { powerLimitW: 220 }, null), true, 'null state -> no-op (nothing to compare)');
  assert.equal(isScalarDirtyVsApplied('powerLimitW', 220, null, {}), false);
  assert.equal(isScalarDirtyVsApplied('powerLimitW', 230, null, {}), false);
  // The APPLIED reference still decides when it covers the control.
  assert.equal(isScalarDirtyVsApplied('powerLimitW', 220, null, { powerLimitW: 220 }), false);
  assert.equal(isScalarDirtyVsApplied('powerLimitW', 230, null, { powerLimitW: 220 }), true);
  assert.equal(isControlDirtyVsApplied('powerLimitW', { powerLimitW: 230 }, null, { powerLimitW: 220 }), true);
  assert.equal(isControlDirtyVsApplied('powerLimitW', { powerLimitW: 220 }, null, { powerLimitW: 220 }), false);
});

// ---------------------------------------------------------------------------
// M3-C-F — the OC-page refresh signatures (pure)
// ---------------------------------------------------------------------------

const baseState: DeviceState = {
  powerLimitW: 210, gpuVoltOffsetV: 0, gpuFreqOffsetMhz: 0, tempLimitC: 90,
  vramFreqOffsetGts: null, vramVoltOffsetV: null,
  gpuLock: { voltageV: 0, freqMhz: 0 }, vfCurve: null,
  fanMode: 'curve', fanCurve: [{ t: 20, speedPct: 20 }], fixedFanPct: null,
};

test('M3-C-F: ocStateChanged — the same reference / identical content does NOT refresh', () => {
  assert.equal(ocStateChanged(null, null), false);
  assert.equal(ocStateChanged(baseState, baseState), false);
  assert.equal(ocStateChanged(baseState, { ...baseState }), false, 'deep-equal copies are not a change');
  assert.equal(ocStateChanged({ ...baseState }, { ...baseState }), false);
});

test('M3-C-F: ocStateChanged — a scalar / nested / null-vs-value change DOES refresh', () => {
  assert.equal(ocStateChanged(null, baseState), true);
  assert.equal(ocStateChanged(baseState, null), true);
  assert.equal(ocStateChanged(baseState, { ...baseState, powerLimitW: 220 }), true);
  assert.equal(ocStateChanged(baseState, { ...baseState, fanCurve: [{ t: 30, speedPct: 40 }] }), true, 'nested content');
  assert.equal(ocStateChanged(baseState, { ...baseState, gpuLock: { voltageV: 0.9, freqMhz: 2100 } }), true);
  assert.equal(ocStateChanged(baseState, { ...baseState, vramFreqOffsetGts: 2 }), true, 'null -> value');
});

test('M3-C-F: ocCapsChanged — content comparison, the post-apply waiver re-set is NOT a surface change', () => {
  const caps: Capabilities = {
    oemName: 'o', deviceName: 'd', waiverAccepted: false, controls: { powerLimit: true },
    ranges: { powerLimitW: { min: 105, max: 252, step: 1, default: 210, units: 'W' } },
    fan: { canControl: false, modes: [], maxRpm: -1, maxCurvePoints: 0 },
  };
  assert.equal(ocCapsChanged(null, null), false);
  assert.equal(ocCapsChanged(null, caps), true);
  assert.equal(ocCapsChanged(caps, caps), false);
  assert.equal(ocCapsChanged(caps, { ...caps }), false, 'identical content, new reference');
  assert.equal(ocCapsChanged(caps, { ...caps, waiverAccepted: true }), false, 'the post-apply waiver re-set must NOT re-render');
  assert.equal(ocCapsChanged(caps, { ...caps, extendedRanges: true }), true);
  const extended = { ...caps, ranges: { ...caps.ranges, powerLimitW: { ...caps.ranges.powerLimitW, max: 315 } }, extendedRanges: true };
  assert.equal(ocCapsChanged(caps, extended), true, 'a mode toggle changed the ranges');
});
