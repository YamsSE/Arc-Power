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
  FAN_DOMAIN,
  tempToX,
  xToTemp,
  rpmMarkerY,
  fanCurvePresets,
  fanSpeedTicks,
  FAN_AXIS_TICKS,
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

test('seedCurvePoints: seeds a 2-point ramp across the STATIC 0..100 domain when the curve has fewer than 2 points (F6 regression)', () => {
  // A canControl device that reports no curve at all — the seeded ramp now
  // spans the STATIC 0..100 °C axis (M4-B), not the old dynamic span.
  const seeded = seedCurvePoints([], 10);
  assert.deepEqual(seeded, [{ t: 0, speedPct: 20 }, { t: 100, speedPct: 100 }]);
  assert.equal(addPointAtMidGap(seeded, 10)?.length, 3); // the editor is never stuck
  // A single reported point: ramp spans the (static) domain.
  const one = seedCurvePoints([{ t: 50, speedPct: 40 }], 10);
  assert.equal(one.length, 2);
  assert.deepEqual(one[0], { t: 0, speedPct: 20 });
  assert.deepEqual(one[1], { t: 100, speedPct: 100 });
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

test('curveDomain: STATIC 0..100 °C regardless of the curve (M4-B regression)', () => {
  // M4-B (user): deleting a curve point must NEVER narrow the temp axis —
  // the domain is static 0..100 no matter what the curve contains.
  assert.deepEqual(curveDomain(pts()), { minT: 0, maxT: 100 });
  const flat = [{ t: 50, speedPct: 20 }, { t: 50, speedPct: 80 }];
  assert.deepEqual(curveDomain(flat), { minT: 0, maxT: 100 });
  assert.deepEqual(curveDomain([]), { minT: 0, maxT: 100 });
  // The user scenario shape: a NARROW curve (all points near the middle)
  // still leaves the whole 0..100 axis for dragging.
  assert.deepEqual(
    curveDomain([{ t: 60, speedPct: 40 }, { t: 70, speedPct: 60 }]),
    { minT: 0, maxT: 100 },
  );
  assert.deepEqual(curveDomain([{ t: 100, speedPct: 100 }]), { minT: 0, maxT: 100 });
});

test('M4-B: tempToX/xToTemp round-trip across the STATIC FAN_DOMAIN (axis edges reachable)', () => {
  // The drag regression: with the static domain, the axis extremes are
  // always reachable — x=0 maps to 0 °C and x=100 to 100 °C, and the
  // round-trip is exact at any x.
  assert.equal(tempToX(0, FAN_DOMAIN), 0);
  assert.equal(tempToX(100, FAN_DOMAIN), 100);
  for (const x of [0, 12.5, 25, 50, 75, 100]) {
    assert.equal(tempToX(xToTemp(x, FAN_DOMAIN), FAN_DOMAIN), x);
  }
});

test('M4-B: the delete-then-drag user scenario — removing a point never narrows the drag space', () => {
  // The exact user report: deleting a curve point narrowed the axis so the
  // remaining points could not be moved to higher/lower temps. With the
  // static domain, after the delete the remaining points still drag all the
  // way to 0 °C and 100 °C (clampTempBetween only constrains between
  // neighbors, and nothing else shrinks the space).
  let curve: CP[] = [
    { t: 20, speedPct: 20 },
    { t: 50, speedPct: 50 },
    { t: 80, speedPct: 80 },
  ];
  curve = removePoint(curve, 1); // delete a point
  assert.deepEqual(curve.map((p) => p.t), [20, 80]);
  // The domain is unchanged by the delete.
  assert.deepEqual(curveDomain(curve), { minT: 0, maxT: 100 });
  // The remaining top point can still be dragged to 100 °C...
  curve = movePoint(curve, 1, 100, 100);
  assert.equal(curve[1].t, 100);
  // ...and the remaining bottom point can still be dragged to 0 °C.
  curve = movePoint(curve, 0, 0, 20);
  assert.equal(curve[0].t, 0);
  assert.deepEqual(curveDomain(curve), { minT: 0, maxT: 100 });
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

// M2C-B B1 — the right-side 0-100% axis ticks (mirror of the bottom temp
// axis): one tick per horizontal grid line, 100% at the top (y 0), 0% at
// the bottom (y 100), labels OUTSIDE the plot.
test('B1: fanSpeedTicks covers 0..100% at the five grid lines, top-down', () => {
  assert.deepEqual(FAN_AXIS_TICKS, [0, 25, 50, 75, 100]);
  const ticks = fanSpeedTicks();
  assert.equal(ticks.length, 5);
  assert.deepEqual(ticks.map((t) => t.pct), [100, 75, 50, 25, 0]);
  assert.deepEqual(ticks.map((t) => t.y), [0, 25, 50, 75, 100]);
  // the y of each tick is the grid line it aligns to (top-down SVG y)
  assert.ok(ticks.every((t) => t.y === 100 - t.pct));
});

// M4-C — the manual per-point input path: typing goes through the EXISTING
// pure helpers (movePoint for the temp clamp-between + speed 0..100 clamp,
// clampPointCount for the count clamp, removePoint for the per-point remove).

test('M4-C input path: typing a temp that collides with the next neighbor clamps strictly between (movePoint)', () => {
  // The mock A770 default curve segment: typing 78 into the 70 °C point
  // collides with the 78 °C neighbor -> clamped to 77 (next.t - 1).
  const p = [
    { t: 20, speedPct: 20 }, { t: 55, speedPct: 23 }, { t: 70, speedPct: 28 },
    { t: 78, speedPct: 30 }, { t: 90, speedPct: 100 },
  ];
  const out = movePoint(p, 2, 78, 28);
  assert.equal(out[2].t, 77, 'a colliding temp is clamped strictly below the next neighbor');
  assert.equal(out[2].speedPct, 28, 'typing a temp never touches the speed');
  // Typing below the previous neighbor clamps strictly above it.
  const low = movePoint(p, 2, 50, 28);
  assert.equal(low[2].t, 56, 'prev.t + 1');
  // A legal temp passes through unclamped.
  assert.equal(movePoint(p, 2, 65, 28)[2].t, 65);
});

test('M4-C input path: typing a speed clamps to 0..100 (movePoint)', () => {
  const p = pts();
  assert.equal(movePoint(p, 1, 55, 150)[1].speedPct, 100);
  assert.equal(movePoint(p, 1, 55, -20)[1].speedPct, 0);
  assert.equal(movePoint(p, 1, 55, 42.4)[1].speedPct, 42); // rounded to whole %
});

test('M4-C input path: clampPointCount keeps the count clamp (typing never overflows the device max)', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ t: i * 5, speedPct: 20 + i }));
  const out = clampPointCount(many, 10);
  assert.equal(out.length, 10);
  assert.deepEqual(clampPointCount(many, 10), clampPointCount(many, 10)); // idempotent
});

test('M4-C input path: the per-point remove uses removePoint and never drops below MIN_CURVE_POINTS', () => {
  let p = pts(); // 4 points
  for (let i = 0; i < 5; i++) p = removePoint(p, 0);
  assert.equal(p.length, MIN_CURVE_POINTS, 'the floor is MIN_CURVE_POINTS');
  const again = removePoint(p, 0);
  assert.equal(again.length, MIN_CURVE_POINTS, 'a remove at the floor is a no-op');
  assert.deepEqual(again, p, 'the no-op returns a copy, never a mutation');
});
