// M2a — F4: renderer/main clamp-snap parity sweep.
//
// snapToRange (src/renderer/pure/slider.ts) and clampAndSnap
// (src/main/backend/units.js) are two copies of one algorithm — a
// cross-layer import of main-process code into the renderer bundle is not
// acceptable with the current build, so the copies stay. This matrix sweep
// pins them bit-identical over a property grid (bounds, fractional steps,
// off-grid values, float-drift inputs, non-finite values) so the renderer
// sliders and the main-process clamps can never drift.
//
// Plain .js on purpose: tsc only typechecks test/**/*.ts, and importing a
// main-process .js module from a .ts test would need a declaration shim.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampAndSnap } from '../src/main/backend/units.js';
import { snapToRange } from '../src/renderer/pure/slider.ts';

const RANGES = [
  { min: 105, max: 252, step: 1 },            // A770 power limit (min != 0)
  { min: 0, max: 0.234, step: 0.005 },        // A770 voltage (fractional step)
  { min: 0, max: 300, step: 1 },              // A770 freq offset
  { min: 60, max: 90, step: 1 },              // A770 temp limit
  { min: -50, max: 50, step: 0.1 },           // negative min + fractional step
  { min: 5, max: 5, step: 0 },                // zero step (pass-through clamp)
  { min: 0, max: 100, step: 3 },              // step that does not divide the range
  { min: 0, max: 1, step: 0.0078125 },        // binary-fraction step
];

const VALUES = [
  NaN, Infinity, -Infinity,
  -999, -0.001, 0, 0.001, 0.005, 0.007, 0.012, 0.0125, 0.018, 0.02, 0.05,
  5.005, 6.5, 12.345, 48.3, 48.7, 49.99999999999999, 55, 60, 85.5, 89.9,
  90, 105, 106.4, 106.6, 210.7, 252, 252.4, 253, 300, 999,
  0.02 + 0.03, // float drift: 0.050000000000000002
  0.1 + 0.2,   // float drift: 0.30000000000000004
  105 + 0.1 * 3,
];

test('snapToRange vs clampAndSnap: bit-identical over the property matrix (F4)', () => {
  for (const range of RANGES) {
    for (const value of VALUES) {
      const main = clampAndSnap(value, range);
      const renderer = snapToRange(value, range);
      assert.equal(renderer, main, `range=${JSON.stringify(range)} value=${value}: renderer ${renderer} != main ${main}`);
    }
  }
});
