import test from 'node:test';
import assert from 'node:assert/strict';
import { readVfCurveAfterWrite, validateVfCurveReadback } from '../src/main/backend/vf-curve-readback.js';

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
  assert.equal(out.driverAdjusted, false);
  assert.equal(out.errorCode, 'driver-noop');
  assert.deepEqual(out.appliedCurve[0], { voltageV: 0.57, freqMhz: 1550 });
  assert.match(out.message, /LIVE curve remained unchanged during verification/);
  assert.match(out.message, /Point 10 requested 1020 mV \/ 3210 MHz; LIVE remains 1020 mV \/ 3230 MHz/);
  assert.match(out.message, /No change was observed/);
});

test('B580 valid LIVE normalization just outside the captured tolerance is accepted as active', () => {
  const normalizedLive = observedByB580.map((point) => ({ ...point }));
  normalizedLive[0].Frequency += 1;
  const normalized = validateVfCurveReadback({
    readBack: { ok: true, points: normalizedLive },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    allowDriverNormalization: true,
  });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.exact, false);
  assert.equal(normalized.driverAdjusted, true);
  assert.equal(normalized.normalized, true);
  assert.equal(normalized.errorCode, undefined);
  assert.deepEqual(normalized.appliedCurve, normalizedLive.map((point) => ({
    voltageV: point.Voltage / 1000,
    freqMhz: point.Frequency,
  })));
  assert.match(normalized.message, /applied a normalized VF curve/);

  const malformed = normalizedLive.map((point) => ({ ...point }));
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

test('VF verification polls unchanged before-image data until the LIVE curve changes', async () => {
  const landed = requested.map((point) => ({ ...point }));
  let reads = 0;
  const waits = [];
  const out = await readVfCurveAfterWrite({
    readCurve: async () => {
      reads += 1;
      return { ok: true, points: reads < 3 ? before : landed };
    },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    maxAttempts: 5,
    pollIntervalMs: 100,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(out.ok, true);
  assert.equal(out.exact, true);
  assert.equal(reads, 3);
  assert.deepEqual(waits, [100, 100]);
});

test('VF verification stops polling on a driver no-op and never repeats a write', async () => {
  let reads = 0;
  const waits = [];
  const out = await readVfCurveAfterWrite({
    readCurve: async () => {
      reads += 1;
      return { ok: true, points: before };
    },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    maxAttempts: 4,
    pollIntervalMs: 50,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'driver-noop');
  assert.equal(out.silentNoop, true);
  assert.equal(reads, 4);
  assert.deepEqual(waits, [50, 50, 50]);
});

test('default VF verification allows a bounded two-second LIVE settle window', async () => {
  let reads = 0;
  const waits = [];
  const out = await readVfCurveAfterWrite({
    readCurve: async () => {
      reads += 1;
      return { ok: true, points: before };
    },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(out.errorCode, 'driver-noop');
  assert.equal(reads, 21);
  assert.equal(waits.length, 20);
  assert.deepEqual(new Set(waits), new Set([100]));
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 2000);
});
