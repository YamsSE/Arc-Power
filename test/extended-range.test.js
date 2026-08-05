// M2C-C — extended-range confirm-dialog gating tests (pure helpers):
// requiresExtendedRangeConfirm + the exposed-range clamps on the renderer
// side (pure/settings.ts), mirroring the main-side requiresExtendedRange.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requiresExtendedRangeConfirm,
  clampExposedRange,
  TEMP_LIMIT_MAX_C,
  EXTENDED_PL_MAX_W,
  EXTENDED_TL_MAX_C,
  STD_PL_MAX_W,
  STD_TL_MAX_C,
} from '../src/renderer/pure/settings.ts';

const PL_RANGE = { min: 105, max: 315, step: 1, default: 210, units: 'W' };
const TL_RANGE = { min: 60, max: 115, step: 1, default: 90, units: 'C' };

test('requiresExtendedRangeConfirm: gated on PL > 252 or TL > 90', () => {
  assert.equal(requiresExtendedRangeConfirm({ powerLimitW: 253 }), true);
  assert.equal(requiresExtendedRangeConfirm({ powerLimitW: 252 }), false);
  assert.equal(requiresExtendedRangeConfirm({ tempLimitC: 91 }), true);
  assert.equal(requiresExtendedRangeConfirm({ tempLimitC: 90 }), false);
  assert.equal(requiresExtendedRangeConfirm({ powerLimitW: 300, tempLimitC: 85, gpuFreqOffsetMhz: 50 }), true);
  assert.equal(requiresExtendedRangeConfirm({ powerLimitW: 220, tempLimitC: 85 }), false);
  assert.equal(requiresExtendedRangeConfirm({}), false);
});

test('requiresExtendedRangeConfirm: the standard limits are 252 W / 90 C', () => {
  assert.equal(STD_PL_MAX_W, 252);
  assert.equal(STD_TL_MAX_C, 90);
  assert.equal(EXTENDED_PL_MAX_W, 315);
  assert.equal(EXTENDED_TL_MAX_C, 115);
});

test('clampExposedRange: without extended ranges the sliders stay within the standard limits', () => {
  const pl = clampExposedRange({ ...PL_RANGE, max: 315 }, 'powerLimitW', { extendedRanges: false });
  assert.equal(pl.max, STD_PL_MAX_W, 'power slider pinned to 252 W');
  const tl = clampExposedRange(TL_RANGE, 'tempLimitC', { extendedRanges: false });
  assert.equal(tl.max, TEMP_LIMIT_MAX_C, 'temp slider pinned to 90 C');
});

test('clampExposedRange: with extended ranges the FULL verified maxes are exposed', () => {
  const pl = clampExposedRange(PL_RANGE, 'powerLimitW', { extendedRanges: true });
  assert.equal(pl.max, EXTENDED_PL_MAX_W, 'power slider goes to 315 W');
  const tl = clampExposedRange(TL_RANGE, 'tempLimitC', { extendedRanges: true });
  assert.equal(tl.max, EXTENDED_TL_MAX_C, 'temp slider goes to 115 C');
});

test('clampExposedRange: in-range ranges pass through untouched', () => {
  const r = { min: 0, max: 300, step: 1, default: 0, units: 'MHz' };
  assert.equal(clampExposedRange(r, 'gpuFreqOffsetMhz', { extendedRanges: false }), r);
  const tl = clampExposedRange({ min: 60, max: 90, step: 1, default: 90, units: 'C' }, 'tempLimitC', { extendedRanges: false });
  assert.equal(tl.max, 90, 'already within the pin');
});

test('clampExposedRange: missing caps (stale cache) defaults to the safe standard clamp', () => {
  const tl = clampExposedRange(TL_RANGE, 'tempLimitC', undefined);
  assert.equal(tl.max, TEMP_LIMIT_MAX_C, 'no caps -> standard pin (safe)');
});
