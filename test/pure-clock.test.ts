// M4-B — absolute-clock conversion (pure): the Offset/Clock toggle's
// clock<->offset round trip, the translated slider range, and the rounding
// rule (step 1 MHz).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockToOffset, offsetToClock, clockRangeFromOffsetRange } from '../src/renderer/pure/clock.ts';
import type { RangeInfo } from '../src/renderer/types.ts';

const OFFSET_RANGE: RangeInfo = { min: -300, max: 300, step: 1, default: 0, units: 'MHz' };

test('clockToOffset: target clock -> offset (base + offset = target)', () => {
  assert.equal(clockToOffset(2050, 2100), -50);
  assert.equal(clockToOffset(2400, 2100), 300);
  assert.equal(clockToOffset(1800, 2100), -300);
  assert.equal(clockToOffset(2100, 2100), 0);
  // b580 base 2850
  assert.equal(clockToOffset(2950, 2850), 100);
});

test('clockToOffset: rounds at step 1 MHz (float-drift guard)', () => {
  assert.equal(clockToOffset(2100.4, 2100), 0);
  assert.equal(clockToOffset(2149.6, 2100), 50);
});

test('offsetToClock: offset -> absolute clock (the readout in Clock mode)', () => {
  assert.equal(offsetToClock(-100, 2100), 2000);
  assert.equal(offsetToClock(0, 2100), 2100);
  assert.equal(offsetToClock(300, 2100), 2400);
  assert.equal(offsetToClock(48.3, 2100), 2148.3, 'off-grid offsets translate honestly');
});

test('offsetToClock/clockToOffset round trip', () => {
  for (const offset of [-300, -150, 0, 75, 300]) {
    assert.equal(clockToOffset(offsetToClock(offset, 2100), 2100), offset);
  }
});

test('clockRangeFromOffsetRange: translates min/max/default by baseClock', () => {
  const clock = clockRangeFromOffsetRange(OFFSET_RANGE, 2100);
  assert.deepEqual(clock, { min: 1800, max: 2400, step: 1, default: 2100, units: 'MHz' });
  const b580 = clockRangeFromOffsetRange({ min: -500, max: 500, step: 1, default: 0, units: 'MHz' }, 2850);
  assert.equal(b580.min, 2350);
  assert.equal(b580.max, 3350);
});

test('clockRangeFromOffsetRange: a snapped clock maps back to an in-range offset', () => {
  const clock = clockRangeFromOffsetRange(OFFSET_RANGE, 2100);
  for (const value of [1800, 1801, 2050, 2399, 2400]) {
    const offset = clockToOffset(value, 2100);
    assert.ok(offset >= -300 && offset <= 300, `clock ${value} -> offset ${offset} out of range`);
  }
});
