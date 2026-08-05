// M2a — renderer pure logic: apply-settings payload validation + builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSettingsPayload,
  buildScalarSettings,
  buildFanSettings,
  computeDirty,
  isNoopApply,
  isControlDirty,
  shouldShowRetryNote,
  profileApplyOutcome,
  clampExposedRange,
  applyGiveUpSummary,
  TEMP_LIMIT_MAX_C,
} from '../src/renderer/pure/settings.ts';
import { computePresets } from '../src/renderer/pure/presets.ts';
import type { DeviceState, RangeInfo, Settings } from '../src/renderer/types.ts';

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

test('computeDirty: a payload matching the driver state is clean', () => {
  assert.equal(computeDirty({ powerLimitW: 210, gpuFreqOffsetMhz: 0 }, mockState), false);
  assert.equal(computeDirty({}, mockState), false);
});

test('computeDirty: any differing scalar / string / pair / array makes it dirty', () => {
  assert.equal(computeDirty({ powerLimitW: 220 }, mockState), true);
  assert.equal(computeDirty({ fanMode: 'auto' }, mockState), true);
  assert.equal(computeDirty({ gpuLock: { voltageV: 0.9, freqMhz: 2100 } }, mockState), true);
  assert.equal(computeDirty({ fanCurve: [{ t: 20, speedPct: 25 }, { t: 90, speedPct: 100 }] }, mockState), true);
});

test('computeDirty: a missing driver read-back counts as dirty (cannot verify)', () => {
  assert.equal(computeDirty({ vramFreqOffsetGts: 2 }, mockState), true);
});

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

// M2b review F3 — the "Applied on retry" warn only fires when the retried
// apply SUCCEEDED (retried is also set by an apply that exhausted its
// retries and failed).
test('shouldShowRetryNote: true only when the retried apply succeeded', () => {
  assert.equal(shouldShowRetryNote({ retried: true, ok: true }), true);
  assert.equal(shouldShowRetryNote({ retried: false, ok: true }), false);
  assert.equal(shouldShowRetryNote({ retried: true, ok: false }), false);
  assert.equal(shouldShowRetryNote({ ok: true }), false);
  assert.equal(shouldShowRetryNote({ retried: true }), false);
  assert.equal(shouldShowRetryNote({}), false);
});

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
// M2C-A F3 — PT clamp (92 -> 90) + honest give-up summary
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

test('F3: applyGiveUpSummary reports the honest give-up text with the attempt count', () => {
  assert.equal(applyGiveUpSummary({ gaveUp: true, attempts: 5 }), 'The driver kept refusing after 5 attempts — no more retries within the apply budget.');
  assert.equal(applyGiveUpSummary({ gaveUp: true, attempts: 1 }), 'The driver kept refusing after 1 attempt — no more retries within the apply budget.');
  assert.equal(applyGiveUpSummary({ gaveUp: false, attempts: 5 }), null);
  assert.equal(applyGiveUpSummary({}), null);
});
