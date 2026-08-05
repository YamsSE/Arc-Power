// M2a — renderer pure logic: preset chips computed within capability ranges.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePresets } from '../src/renderer/pure/presets.ts';
import { snapToRange } from '../src/renderer/pure/slider.ts';
import type { RangeInfo } from '../src/renderer/types.ts';

test('computePresets: stock is the capability default, max is the range max', () => {
  const power: RangeInfo = { min: 105, max: 252, step: 1, default: 210, units: 'W' };
  const presets = computePresets(power);
  const stock = presets.find((p) => p.id === 'stock');
  const max = presets.find((p) => p.id === 'max');
  assert.equal(stock?.value, 210);
  assert.equal(max?.value, 252);
});

test('computePresets: medium is between stock and max, snapped to step', () => {
  const power: RangeInfo = { min: 105, max: 252, step: 1, default: 210, units: 'W' };
  const medium = computePresets(power).find((p) => p.id === 'medium');
  assert.ok(medium && medium.value > 210 && medium.value < 252);
  assert.equal(Number.isInteger(medium.value), true);
});

test('computePresets: offset controls start at zero (stock) and ramp up', () => {
  const volt: RangeInfo = { min: 0, max: 0.234, step: 0.005, default: 0, units: 'V' };
  const presets = computePresets(volt);
  const stock = presets.find((p) => p.id === 'stock');
  const max = presets.find((p) => p.id === 'max');
  assert.equal(stock?.value, 0);
  assert.equal(max?.value, 0.234);
});

test('computePresets: every preset value is a legal apply value (snap round-trip)', () => {
  const volt: RangeInfo = { min: 0, max: 0.234, step: 0.005, default: 0, units: 'V' };
  for (const p of computePresets(volt)) {
    // Legal = snapping the value back onto the grid yields itself (the max
    // bound 0.234 is preserved exactly even though it is not a step multiple).
    assert.equal(snapToRange(p.value, volt), p.value, `${p.id} value ${p.value} not stable under snap`);
  }
});

test('computePresets: narrow ranges dedupe collapsed chips', () => {
  const tiny: RangeInfo = { min: 100, max: 101, step: 1, default: 100, units: 'W' };
  const presets = computePresets(tiny);
  const values = presets.map((p) => p.value);
  assert.equal(new Set(values).size, values.length, 'no duplicate chip values');
});
