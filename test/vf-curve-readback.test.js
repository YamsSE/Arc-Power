import test from 'node:test';
import assert from 'node:assert/strict';
import { readStableVfCurve, readVfCurveAfterWrite, readVfCurveOnce, validateVfCurveReadback } from '../src/main/backend/vf-curve-readback.js';

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

test('stable LIVE read ignores one transient voltage-shift sample', async () => {
  const shifted = before.map((point) => ({ ...point, Voltage: point.Voltage + 75 }));
  const samples = [shifted, before, before, before, before];
  let reads = 0;
  const result = await readStableVfCurve({
    readCurve: async () => ({ ok: true, points: samples[reads++] }),
    pollIntervalMs: 0,
    wait: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.consensus, 4);
  assert.deepEqual(result.points, before);
  assert.equal(reads, 5);
});

test('stable LIVE read fails closed when no curve reaches quorum', async () => {
  let reads = 0;
  const result = await readStableVfCurve({
    readCurve: async () => {
      const sample = reads++;
      return {
        ok: true,
        points: before.map((point) => ({ ...point, Voltage: point.Voltage + sample })),
      };
    },
    pollIntervalMs: 0,
    wait: async () => {},
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'readback-unstable');
  assert.deepEqual(result.points, []);
});

test('a materially different valid LIVE curve is accepted as a normalized apply', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: observedByB580 },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });

  assert.equal(out.ok, true);
  assert.equal(out.exact, false);
  assert.equal(out.normalized, true);
  assert.equal(out.readBackEqual, false);
  assert.equal(out.driverAdjusted, true);
  assert.equal(out.errorCode, undefined);
  assert.match(out.message, /Applied/);
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
  assert.match(out.message, /LIVE VF curve remained unchanged during verification/);
  assert.match(out.message, /Point 10 requested 1020 mV \/ 3210 MHz; LIVE remains 1020 mV \/ 3230 MHz/);
  assert.match(out.message, /No change was observed/);
});

test('a small valid driver rewrite is accepted and malformed tables remain rejected', () => {
  const normalizedLive = observedByB580.map((point) => ({ ...point }));
  normalizedLive[0].Frequency += 1;
  const normalized = validateVfCurveReadback({
    readBack: { ok: true, points: normalizedLive },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
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
  assert.match(normalized.message, /LIVE curve/);

  const malformed = normalizedLive.map((point) => ({ ...point }));
  malformed[4].Voltage = malformed[3].Voltage;
  const invalidOut = validateVfCurveReadback({
    readBack: { ok: true, points: malformed },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(invalidOut.ok, false);
  assert.equal(invalidOut.errorCode, 'driver-invalid-readback');
  assert.match(invalidOut.message, /valid ordered LIVE curve/);
});

test('a valid changed LIVE curve is accepted only when it differs from the before-image', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: observedByB580 },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(out.ok, true);
  assert.equal(out.normalized, true);
});

test('exact LIVE read-back is an applied result', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: requested },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(out.ok, true);
  assert.equal(out.exact, true);
  assert.equal(out.normalized, false);
  assert.deepEqual(out.appliedCurve, requested.map((point) => ({
    voltageV: point.Voltage / 1000,
    freqMhz: point.Frequency,
  })));
});

test('missing and out-of-range LIVE read-backs fail closed', () => {
  const missing = validateVfCurveReadback({
    readBack: { ok: false, errorCode: 'readback-unverified', message: 'LIVE read failed' },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.errorCode, 'readback-unverified');

  const outOfRange = requested.map((point) => ({ ...point }));
  outOfRange[0].Voltage = 300;
  const invalid = validateVfCurveReadback({
    readBack: { ok: true, points: outOfRange },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.errorCode, 'driver-invalid-readback');
});

test('a LIVE point-count change is rejected even when its points are otherwise valid', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: requested.slice(1) },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'driver-invalid-readback');
});

test('a valid read-back is returned for display when the before-image cannot prove the apply', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: observedByB580 },
    requestedPoints: requested,
    liveBefore: { ok: false, points: [], message: 'read failed' },
    curveRange,
  });

  assert.equal(out.ok, false);
  assert.equal(out.errorCode, 'readback-unverified');
  assert.equal(out.driverAdjusted, false);
  assert.deepEqual(out.appliedCurve[0], { voltageV: 0.58, freqMhz: 1640 });
  assert.match(out.message, /before-image could not be verified/);
});

test('a valid one MHz driver normalization is reported as applied', () => {
  const oneUnitReadBack = requested.map((point) => ({ ...point }));
  oneUnitReadBack[9].Frequency += 1;
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: oneUnitReadBack },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });

  assert.equal(out.ok, true);
  assert.equal(out.exact, false);
  assert.equal(out.normalized, true);
});

test('VF verification accepts a normalized LIVE table with one post-setter read and one settle delay', async () => {
  const landed = requested.map((point) => ({ ...point }));
  landed[0].Frequency += 10;
  let reads = 0;
  const waits = [];
  const out = await readVfCurveAfterWrite({
    readCurve: async () => {
      reads += 1;
      return { ok: true, points: landed };
    },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    maxAttempts: 5,
    pollIntervalMs: 100,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(out.ok, true);
  assert.equal(out.normalized, true);
  assert.equal(reads, 1, 'one validated LIVE sample is used after the setter');
  assert.deepEqual(waits, [100]);
});

test('VF verification reports a one-shot unchanged LIVE curve as a no-op', async () => {
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
  assert.equal(reads, 1, 'readback uses one sample and never repeats a write');
  assert.deepEqual(waits, [50]);
});

test('apply before-image accepts a valid single LIVE sample without a read quorum', async () => {
  let reads = 0;
  const liveBefore = await readVfCurveOnce({
    readCurve: async () => {
      reads += 1;
      return { ok: true, points: before };
    },
  });
  assert.equal(liveBefore.ok, true);
  assert.deepEqual(liveBefore.points, before);
  assert.equal(reads, 1);
});
