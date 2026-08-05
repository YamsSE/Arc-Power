// M2a — renderer pure logic: slider snap / position / formatting.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapToRange, normalizedPosition, formatValue, formatDriverValue, isOffGrid, computeDirty } from '../src/renderer/pure/slider.ts';
import type { DeviceState, RangeInfo } from '../src/renderer/types.ts';

const A770_FREQ: RangeInfo = { min: 0, max: 300, step: 1, default: 0, units: 'MHz' };
const A770_VOLT: RangeInfo = { min: 0, max: 0.234, step: 0.005, default: 0, units: 'V' };
const A770_POWER: RangeInfo = { min: 105, max: 252, step: 1, default: 210, units: 'W' };

test('snapToRange: snaps to step from min', () => {
  assert.equal(snapToRange(48.3, A770_FREQ), 48);
  assert.equal(snapToRange(48.7, A770_FREQ), 49);
  assert.equal(snapToRange(0.012, A770_VOLT), 0.01);
  assert.equal(snapToRange(0.018, A770_VOLT), 0.02);
  assert.equal(snapToRange(0.2, A770_VOLT), 0.2);
});

test('snapToRange: clamps to [min, max] and preserves bounds exactly', () => {
  assert.equal(snapToRange(999, A770_POWER), 252);
  assert.equal(snapToRange(-50, A770_POWER), 105);
  assert.equal(snapToRange(253, A770_POWER), 252);
  assert.equal(snapToRange(104, A770_POWER), 105);
  // step need not divide the range evenly (105..252 step 1 with a min offset)
  assert.equal(snapToRange(106.4, A770_POWER), 106);
  assert.equal(snapToRange(106.6, A770_POWER), 107);
});

test('snapToRange: non-finite input snaps to min (never NaN leaks)', () => {
  assert.equal(snapToRange(NaN, A770_POWER), 105);
  assert.equal(snapToRange(Infinity, A770_POWER), 105);
  assert.equal(snapToRange(-Infinity, A770_POWER), 105);
});

test('snapToRange: zero-step ranges pass through clamped', () => {
  const flat: RangeInfo = { min: 5, max: 5, step: 0, default: 5, units: 'W' };
  assert.equal(snapToRange(10, flat), 5);
});

test('snapToRange: float drift guard on fractional steps', () => {
  // 0.02 + 0.03 in binary floats is 0.050000000000000002; must still land on 0.05.
  assert.equal(snapToRange(0.02 + 0.03, A770_VOLT), 0.05);
});

test('normalizedPosition: 0 at min, 1 at max, clamped outside', () => {
  assert.equal(normalizedPosition(0, A770_FREQ), 0);
  assert.equal(normalizedPosition(300, A770_FREQ), 1);
  assert.equal(normalizedPosition(150, A770_FREQ), 0.5);
  assert.equal(normalizedPosition(-10, A770_FREQ), 0);
  assert.equal(normalizedPosition(999, A770_FREQ), 1);
  assert.equal(normalizedPosition(NaN, A770_FREQ), 0);
});

test('formatValue: volts keep 3 decimals, others integral; C maps to °C', () => {
  assert.equal(formatValue(0.1, 'V'), '0.100 V');
  assert.equal(formatValue(220, 'W'), '220 W');
  assert.equal(formatValue(85, 'C'), '85 °C');
  assert.equal(formatValue(48.5, 'MHz'), '49 MHz');
});

test('formatValue: explicit decimals override the default', () => {
  assert.equal(formatValue(48.3, 'MHz', 1), '48.3 MHz');
  assert.equal(formatValue(0.1, 'V', 4), '0.1000 V');
});

test('formatDriverValue: off-grid values render with one extra decimal (F3 regression)', () => {
  // The A770's 48.3 MHz offset is off the 1 MHz grid: must NOT render as
  // "48 MHz" (identical to the snapped slider value).
  assert.equal(formatDriverValue(48.3, A770_FREQ), '48.3 MHz');
  assert.equal(formatDriverValue(48, A770_FREQ), '48 MHz');
  assert.equal(formatDriverValue(0.0125, A770_VOLT), '0.0125 V');
  assert.equal(formatDriverValue(0.01, A770_VOLT), '0.010 V');
  assert.equal(formatDriverValue(null, A770_FREQ), 'unavailable');
  assert.equal(formatDriverValue(undefined, A770_FREQ), 'unavailable');
});

test('isOffGrid: detects driver values off the capability grid', () => {
  assert.equal(isOffGrid(48.3, A770_FREQ), true); // the real A770 quirk
  assert.equal(isOffGrid(48, A770_FREQ), false);
  assert.equal(isOffGrid(0.0125, A770_VOLT), true);
  assert.equal(isOffGrid(null, A770_FREQ), false);
  assert.equal(isOffGrid(undefined, A770_FREQ), false);
});

function deviceState(patch: Partial<DeviceState> = {}): DeviceState {
  return {
    powerLimitW: 210,
    gpuVoltOffsetV: 0,
    gpuFreqOffsetMhz: 0,
    tempLimitC: 90,
    vramFreqOffsetGts: null,
    vramVoltOffsetV: null,
    gpuLock: { voltageV: 0, freqMhz: 0 },
    vfCurve: null,
    fanMode: 'curve',
    fanCurve: [],
    fixedFanPct: null,
    ...patch,
  };
}

test('computeDirty: flags values that differ from the driver state', () => {
  const values = { powerLimitW: 220, tempLimitC: 85 };
  const dirty = computeDirty(values, deviceState(), ['powerLimitW', 'tempLimitC']);
  assert.deepEqual(dirty, { powerLimitW: true, tempLimitC: true });
  assert.deepEqual(computeDirty(values, deviceState(), ['powerLimitW']), { powerLimitW: true });
});

test('computeDirty: a fresh apply state clears the flag for applied controls (F4 regression)', () => {
  const values = { powerLimitW: 220, tempLimitC: 85 };
  // after apply, the read-back state equals the applied values for the
  // control that succeeded (tempLimitC is still pending elsewhere).
  const fresh = deviceState({ powerLimitW: 220 });
  assert.deepEqual(computeDirty(values, fresh, ['powerLimitW', 'tempLimitC']), {
    powerLimitW: false,
    tempLimitC: true,
  });
});

test('computeDirty: an unavailable driver readout keeps the control dirty', () => {
  assert.deepEqual(computeDirty({ powerLimitW: 220 }, deviceState({ powerLimitW: null }), ['powerLimitW']), {
    powerLimitW: true,
  });
});
