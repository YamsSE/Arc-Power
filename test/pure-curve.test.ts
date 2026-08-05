// M2a — renderer pure logic: fan curve editor math (sort, clamps, insert,
// remove, point-count clamp, ascending-temp enforcement, presets, marker).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortByTemp,
  clampPointCount,
  seedCurvePoints,
  enforceAscending,
  clampTempBetween,
  movePoint,
  addPoint,
  removePoint,
  addPointAtMidGap,
  curveDomain,
  tempToX,
  xToTemp,
  rpmMarkerY,
  fanCurvePresets,
  MIN_CURVE_POINTS,
} from '../src/renderer/pure/curve.ts';
import type { CurvePoint as CP } from '../src/renderer/pure/curve.ts';

const pts = (): CP[] => [
  { t: 20, speedPct: 20 },
  { t: 55, speedPct: 23 },
  { t: 70, speedPct: 28 },
  { t: 90, speedPct: 100 },
];

test('sortByTemp: ascending by temp, does not mutate the input', () => {
  const input = pts().reverse();
  const out = sortByTemp(input);
  assert.deepEqual(out.map((p) => p.t), [20, 55, 70, 90]);
  assert.deepEqual(input.map((p) => p.t), [90, 70, 55, 20]);
});

test('clampPointCount: caps at max but never below MIN_CURVE_POINTS', () => {
  assert.equal(clampPointCount(pts(), 10).length, 4);
  assert.equal(clampPointCount(pts(), 2).length, 2);
  assert.equal(clampPointCount(pts(), 0).length, MIN_CURVE_POINTS);
  assert.equal(clampPointCount(pts(), -1).length, MIN_CURVE_POINTS);
});

test('seedCurvePoints: seeds a 2-point ramp when the curve has fewer than 2 points (F6 regression)', () => {
  // A canControl device that reports no curve at all.
  const seeded = seedCurvePoints([], 10);
  assert.deepEqual(seeded, [{ t: 20, speedPct: 20 }, { t: 90, speedPct: 100 }]);
  assert.equal(addPointAtMidGap(seeded, 10)?.length, 3); // the editor is never stuck
  // A single reported point: ramp spans its (guarded) domain.
  const one = seedCurvePoints([{ t: 50, speedPct: 40 }], 10);
  assert.equal(one.length, 2);
  assert.deepEqual(one[0], { t: 49, speedPct: 20 });
  assert.deepEqual(one[1], { t: 51, speedPct: 100 });
});

test('seedCurvePoints: leaves a legal curve untouched (clamped to the device max)', () => {
  assert.deepEqual(seedCurvePoints(pts(), 10), pts());
  assert.equal(seedCurvePoints(pts(), 2).length, 2);
  assert.equal(seedCurvePoints([], 1).length, MIN_CURVE_POINTS); // maxPoints 1 still seeds a ramp
});

test('enforceAscending: duplicates are bumped forward by 1 °C', () => {
  const dup = [
    { t: 20, speedPct: 20 },
    { t: 20, speedPct: 40 },
    { t: 22, speedPct: 50 },
  ];
  const out = enforceAscending(dup);
  assert.equal(out[0].t, 20);
  assert.ok(out[1].t > out[0].t);
  assert.ok(out[2].t > out[1].t);
});

test('clampTempBetween: keeps the moved point strictly between neighbors', () => {
  const p = pts();
  assert.equal(clampTempBetween(p, 1, 10), 21); // above prev 20
  assert.equal(clampTempBetween(p, 1, 99), 69); // below next 70
  assert.equal(clampTempBetween(p, 1, 40), 40);
  // endpoints: no neighbor on one side -> only the other side matters
  assert.equal(clampTempBetween(p, 0, 80), 54); // strictly below next 55
  assert.equal(clampTempBetween(p, 3, -10), 71); // strictly above prev 70
});

test('movePoint: clamps temp between neighbors and speed to 0..100', () => {
  let out = movePoint(pts(), 1, 60, 120);
  assert.deepEqual(out[1], { t: 60, speedPct: 100 });
  out = movePoint(pts(), 1, 60, -5);
  assert.deepEqual(out[1], { t: 60, speedPct: 0 });
  out = movePoint(pts(), 1, 10, 40); // clamps above prev
  assert.equal(out[1].t, 21);
  assert.equal(out[1].speedPct, 40);
});

test('addPoint: inserts, sorts, enforces ascending; null at the point limit', () => {
  const out = addPoint(pts(), 80, 50, 10);
  assert.equal(out?.length, 5);
  assert.deepEqual(out?.map((p) => p.t), [20, 55, 70, 80, 90]);

  const full = clampPointCount(pts(), 4); // already at max 4
  assert.equal(addPoint(full, 60, 50, 4), null);
});

test('removePoint: removes by index, never below MIN_CURVE_POINTS', () => {
  assert.equal(removePoint(pts(), 0).length, 3);
  assert.equal(removePoint(pts(), 0)[0].t, 55);
  const two = [{ t: 20, speedPct: 20 }, { t: 90, speedPct: 100 }];
  assert.deepEqual(removePoint(two, 1), two); // at minimum: no-op
});

test('addPointAtMidGap: inserts at the midpoint of the widest gap', () => {
  const p = [
    { t: 20, speedPct: 20 },
    { t: 25, speedPct: 22 },
    { t: 90, speedPct: 100 },
  ];
  const out = addPointAtMidGap(p, 10);
  assert.equal(out?.length, 4);
  assert.deepEqual(out?.map((q) => q.t), [20, 25, 58, 90]); // 58 = round((25+90)/2)
});

test('addPointAtMidGap: null when at max or no gap >= 2 °C', () => {
  assert.equal(addPointAtMidGap(pts(), 4), null);
  const tight = [
    { t: 20, speedPct: 20 },
    { t: 21, speedPct: 22 },
    { t: 22, speedPct: 24 },
  ];
  assert.equal(addPointAtMidGap(tight, 10), null);
});

test('curveDomain: spans min..max, guards flat curves', () => {
  assert.deepEqual(curveDomain(pts()), { minT: 20, maxT: 90 });
  const flat = [{ t: 50, speedPct: 20 }, { t: 50, speedPct: 80 }];
  const d = curveDomain(flat);
  assert.ok(d.maxT > d.minT);
});

test('tempToX / xToTemp: round-trip across the domain', () => {
  const d = { minT: 20, maxT: 90 };
  assert.equal(tempToX(20, d), 0);
  assert.equal(tempToX(90, d), 100);
  assert.ok(Math.abs(xToTemp(tempToX(55, d), d) - 55) < 1e-9);
  assert.ok(Math.abs(xToTemp(-10, d) - 20) < 1e-9); // clamped
  assert.ok(Math.abs(xToTemp(200, d) - 90) < 1e-9);
});

test('rpmMarkerY: 0 RPM at the bottom (y=100), maxRpm at the top', () => {
  assert.equal(rpmMarkerY(0, 3000), 100);
  assert.equal(rpmMarkerY(3000, 3000), 0);
  assert.equal(rpmMarkerY(1500, 3000), 50);
  assert.equal(rpmMarkerY(9999, 3000), 0); // clamped
  assert.equal(rpmMarkerY(1030, -1), 100); // unknown maxRpm -> bottom
});

test('fanCurvePresets: point count honors the device max, temps ascending', () => {
  const d = { minT: 20, maxT: 90 };
  for (const p of fanCurvePresets(d, 10)) {
    assert.ok(p.points.length >= MIN_CURVE_POINTS && p.points.length <= 10);
    const ts = p.points.map((q) => q.t);
    assert.ok(ts.every((t, i) => i === 0 || t > ts[i - 1]), `${p.id} must be ascending`);
    assert.ok(p.points.every((q) => q.speedPct >= 0 && q.speedPct <= 100));
  }
  // clamped to a 2-point minimum on tiny devices
  assert.equal(fanCurvePresets(d, 1)[0].points.length, MIN_CURVE_POINTS);
});

test('fanCurvePresets: stock ends at 100% and quiet stays under', () => {
  const d = { minT: 20, maxT: 90 };
  const stock = fanCurvePresets(d, 10).find((p) => p.id === 'stock');
  const quiet = fanCurvePresets(d, 10).find((p) => p.id === 'quiet');
  assert.equal(stock?.points.at(-1)?.speedPct, 100);
  assert.ok((quiet?.points.at(-1)?.speedPct ?? 0) < 100);
});
