import test from 'node:test';
import assert from 'node:assert/strict';
import { validateVfCurveReadback } from '../src/main/backend/vf-curve-readback.js';

const curveRange = { voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 0, freqMaxMhz: 4300 };
const before = [
  [570, 1550], [620, 2000], [670, 2340], [720, 2580], [770, 2780],
  [820, 2930], [870, 3060], [920, 3180], [970, 3210], [1020, 3230],
].map(([Voltage, Frequency]) => ({ Voltage, Frequency }));
const requested = before.map((point) => ({ ...point }));
requested[9].Frequency -= 20;
const observedByB580 = [
  [580, 1640], [630, 2070], [680, 2390], [730, 2620], [780, 2810],
  [830, 2960], [880, 3090], [930, 3180], [980, 3200], [1030, 3210],
].map(([Voltage, Frequency]) => ({ Voltage, Frequency }));

test('B580 material driver normalization is applied and returned as the active VF curve', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: observedByB580 },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    allowDriverNormalization: true,
  });

  assert.equal(out.ok, true);
  assert.equal(out.exact, false);
  assert.equal(out.normalized, true);
  assert.equal(out.driverAdjusted, true);
  assert.equal(out.errorCode, undefined);
  assert.match(out.message, /applied a normalized VF curve/);
  assert.equal(out.appliedCurve[0].voltageV, 0.58);
  assert.equal(out.appliedCurve[0].freqMhz, 1640);
});

test('unchanged LIVE data remains a failure and is returned for the editor after a successful native write', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: before },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });

  assert.equal(out.ok, false);
  assert.equal(out.silentNoop, true);
  assert.equal(out.driverAdjusted, true);
  assert.deepEqual(out.appliedCurve[0], { voltageV: 0.57, freqMhz: 1550 });
  assert.match(out.message, /LIVE curve did not change/);
});

test('a changed curve outside the observed B580 envelope is not applied but remains visible', () => {
  const changed = observedByB580.map((point) => ({ ...point }));
  changed[0].Frequency += 1;
  const mismatch = validateVfCurveReadback({
    readBack: { ok: true, points: changed },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    allowDriverNormalization: true,
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.driverAdjusted, true);
  assert.equal(mismatch.normalized, false);
  assert.equal(mismatch.errorCode, 'driver-adjustment-out-of-range');
  assert.deepEqual(mismatch.appliedCurve[0], { voltageV: 0.58, freqMhz: 1641 });
  assert.match(mismatch.message, /outside the observed B580 normalization envelope/);

  const malformed = observedByB580.map((point) => ({ ...point }));
  malformed[4].Voltage = malformed[3].Voltage;
  const invalidOut = validateVfCurveReadback({
    readBack: { ok: true, points: malformed },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    allowDriverNormalization: true,
  });
  assert.equal(invalidOut.ok, false);
  assert.match(invalidOut.message, /valid ordered LIVE curve/);
});

test('non-Battlemage driver adjustments do not qualify for B580 normalization', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: observedByB580 },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'driver-adjustment-out-of-range');
  assert.match(out.message, /supported normalization policy/);
});

test('a valid read-back is returned for display when the before-image cannot prove the apply', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: observedByB580 },
    requestedPoints: requested,
    liveBefore: { ok: false, points: [], message: 'read failed' },
    curveRange,
  });

  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'io-failed');
  assert.equal(out.driverAdjusted, true);
  assert.deepEqual(out.appliedCurve[0], { voltageV: 0.58, freqMhz: 1640 });
  assert.match(out.message, /before-image could not be verified/);
});

test('a one-unit change is not misreported as an exact read-back', () => {
  const oneUnitReadBack = requested.map((point) => ({ ...point }));
  oneUnitReadBack[9].Frequency += 1;
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: oneUnitReadBack },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    allowDriverNormalization: true,
  });

  assert.equal(out.ok, true);
  assert.equal(out.exact, false);
  assert.equal(out.normalized, true);
});
