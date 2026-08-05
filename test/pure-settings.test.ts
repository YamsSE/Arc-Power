// M2a — renderer pure logic: apply-settings payload validation + builders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSettingsPayload,
  buildScalarSettings,
  buildFanSettings,
} from '../src/renderer/pure/settings.ts';
import type { Settings } from '../src/renderer/types.ts';

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
