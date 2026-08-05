// M1 — canonical-unit conversion + clamp/snap helpers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalUnit, canonicalToIgcl, igclToCanonical, clampAndSnap, clampGpuLock, nearlyEqual,
  clampFanPct, normalizeFanCurve,
} from '../src/main/backend/units.js';

test('canonicalUnit maps CTL_UNITS to canonical strings', () => {
  assert.equal(canonicalUnit(0), 'MHz');
  assert.equal(canonicalUnit(1), 'GTS');
  assert.equal(canonicalUnit(2), 'MTS');
  assert.equal(canonicalUnit(3), 'V');
  assert.equal(canonicalUnit(4), 'W');
  assert.equal(canonicalUnit(5), 'C');
  assert.equal(canonicalUnit(10), 'mW');
  assert.equal(canonicalUnit(13), 'mV');
  assert.equal(canonicalUnit(11), '%');
  assert.equal(canonicalUnit(9), 'RPM');
  assert.equal(canonicalUnit(99), 'UNITS_99');
});

test('canonicalToIgcl: no-op units pass through', () => {
  assert.equal(canonicalToIgcl(210, 4), 210); // W
  assert.equal(canonicalToIgcl(300, 0), 300); // MHz
  assert.equal(canonicalToIgcl(90, 5), 90); // C
});

test('canonicalToIgcl: scale to mW / mV / MTS', () => {
  assert.equal(canonicalToIgcl(210, 10), 210000); // W -> mW
  assert.equal(canonicalToIgcl(0.234, 13), 234); // V -> mV
  assert.equal(canonicalToIgcl(0.5, 2), 500); // GTS -> MTS
});

test('igclToCanonical: scale from mW / mV / MTS', () => {
  assert.equal(igclToCanonical(210000, 10), 210);
  assert.equal(igclToCanonical(234, 13), 0.234);
  assert.equal(igclToCanonical(500, 2), 0.5);
  assert.equal(igclToCanonical(48.3, 0), 48.3);
});

test('igclToCanonical round-trips with canonicalToIgcl', () => {
  for (const [units, values] of [[10, [105, 210, 252]], [13, [0, 0.005, 0.234]], [4, [210]], [0, [300]]]) {
    for (const v of values) {
      assert.ok(nearlyEqual(igclToCanonical(canonicalToIgcl(v, units), units), v), `units=${units} v=${v}`);
    }
  }
});

test('clampAndSnap: clamps out-of-range values', () => {
  const r = { min: 105, max: 252, step: 1 };
  assert.equal(clampAndSnap(50, r), 105);
  assert.equal(clampAndSnap(500, r), 252);
  assert.equal(clampAndSnap(210.7, r), 211);
});

test('clampAndSnap: snaps to step from min (A770 voltage 0..0.234 step 0.005)', () => {
  const r = { min: 0, max: 0.234, step: 0.005 };
  assert.equal(clampAndSnap(0.012, r), 0.01);
  assert.equal(clampAndSnap(0.0052, r), 0.005);
  assert.equal(clampAndSnap(0.2, r), 0.2);
  assert.equal(clampAndSnap(0.238, r), 0.234); // clamp beats snap
  assert.ok(nearlyEqual(clampAndSnap(0.12, r), 0.12));
});

test('clampAndSnap: handles NaN/Infinity defensively (non-finite -> min)', () => {
  const r = { min: 105, max: 252, step: 1 };
  assert.equal(clampAndSnap(NaN, r), 105);
  assert.equal(clampAndSnap(Infinity, r), 105);
  assert.equal(clampAndSnap(-Infinity, r), 105);
});

test('clampAndSnap: zero-step ranges pass through clamped', () => {
  const r = { min: 0, max: 100, step: 0 };
  assert.equal(clampAndSnap(42, r), 42);
  assert.equal(clampAndSnap(500, r), 100);
});

test('clampAndSnap: float drift guard on fractional steps', () => {
  const r = { min: 0, max: 1, step: 0.1 };
  const out = clampAndSnap(0.30000000000000004, r);
  assert.ok(nearlyEqual(out, 0.3));
});

test('clampGpuLock: in-bounds pairs pass through untouched', () => {
  const ranges = { gpuVoltOffsetV: { min: 0, max: 0.234, step: 0.005 } };
  assert.deepEqual(clampGpuLock({ voltageV: 0.15, freqMhz: 2100 }, ranges), { voltageV: 0.15, freqMhz: 2100 });
  // the unlock pair (0,0) is legal
  assert.deepEqual(clampGpuLock({ voltageV: 0, freqMhz: 0 }, ranges), { voltageV: 0, freqMhz: 0 });
});

test('clampGpuLock: extreme pairs are clamped to the documented bounds', () => {
  const ranges = { gpuVoltOffsetV: { min: 0, max: 0.234, step: 0.005 } };
  // F1 regression: voltageV=99 / freqMhz=-5 must never reach the driver.
  assert.deepEqual(clampGpuLock({ voltageV: 99, freqMhz: -5 }, ranges), { voltageV: 0.234, freqMhz: 0 });
  assert.deepEqual(clampGpuLock({ voltageV: -3, freqMhz: 99999 }, ranges), { voltageV: 0, freqMhz: 5000 });
});

test('clampGpuLock: without a voltage range, voltageV passes through (freq still bounded)', () => {
  assert.deepEqual(clampGpuLock({ voltageV: 0.9, freqMhz: 2100 }, {}), { voltageV: 0.9, freqMhz: 2100 });
  assert.deepEqual(clampGpuLock({ voltageV: 0.9, freqMhz: -1 }, {}), { voltageV: 0.9, freqMhz: 0 });
});

// ---------------------------------------------------------------------------
// Fan curve normalization (F2 — shared by IgclBackend + MockBackend)
// ---------------------------------------------------------------------------

test('clampFanPct: clamps to 0..100 and rounds to whole %', () => {
  assert.equal(clampFanPct(150), 100);
  assert.equal(clampFanPct(-5), 0);
  assert.equal(clampFanPct(33.4), 33);
  assert.equal(clampFanPct(33.6), 34);
  assert.equal(clampFanPct(100), 100);
  assert.equal(clampFanPct(0), 0);
});

test('normalizeFanCurve: rounds temps, clamps %, sorts, enforces strictly ascending (F2)', () => {
  const out = normalizeFanCurve([
    { t: 90, speedPct: 150 }, { t: 20, speedPct: -10 }, { t: 50, speedPct: 40 },
    { t: 21, speedPct: 130 }, { t: 22, speedPct: 5 }, { t: 22.4, speedPct: 7 },
  ], 10);
  assert.deepEqual(out, [
    { t: 20, speedPct: 0 },    // -10 clamped to 0
    { t: 21, speedPct: 100 },  // 130 clamped to 100
    { t: 22, speedPct: 5 },
    { t: 23, speedPct: 7 },    // 22.4 rounds to 22 -> duplicate bumped to 23
    { t: 50, speedPct: 40 },
    { t: 90, speedPct: 100 },  // 150 clamped to 100
  ]);
});

test('normalizeFanCurve: point count capped at maxPoints (0 -> 32 table cap)', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ t: 20 + i, speedPct: i }));
  assert.equal(normalizeFanCurve(many, 10).length, 10);
  assert.equal(normalizeFanCurve(many, 0).length, 32);
  // input array is never mutated
  assert.equal(many.length, 40);
  assert.equal(many[0].t, 20);
});

test('normalizeFanCurve: already-sorted curves pass through untouched', () => {
  const curve = [{ t: 20, speedPct: 20 }, { t: 55, speedPct: 23 }, { t: 90, speedPct: 100 }];
  assert.deepEqual(normalizeFanCurve(curve, 10), curve);
});
