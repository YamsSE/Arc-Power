import test from 'node:test';
import assert from 'node:assert/strict';
import { readStableVfCurve, readVfCurveAfterWrite, validateVfCurveReadback } from '../src/main/backend/vf-curve-readback.js';

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

test('a materially different valid LIVE curve is not accepted as a normalized apply', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: observedByB580 },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });

  assert.equal(out.ok, false);
  assert.equal(out.exact, false);
  assert.equal(out.normalized, false);
  assert.equal(out.driverAdjusted, true);
  assert.equal(out.errorCode, 'driver-adjusted');
  assert.match(out.message, /point 1 is 580 mV/);
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

test('a small valid driver rewrite is still unverified without a measured tolerance', () => {
  const normalizedLive = observedByB580.map((point) => ({ ...point }));
  normalizedLive[0].Frequency += 1;
  const normalized = validateVfCurveReadback({
    readBack: { ok: true, points: normalizedLive },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(normalized.ok, false);
  assert.equal(normalized.exact, false);
  assert.equal(normalized.driverAdjusted, true);
  assert.equal(normalized.normalized, false);
  assert.equal(normalized.errorCode, 'driver-adjusted');
  assert.deepEqual(normalized.appliedCurve, normalizedLive.map((point) => ({
    voltageV: point.Voltage / 1000,
    freqMhz: point.Frequency,
  })));
  assert.match(normalized.message, /apply was not verified/);

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

test('a valid but changed LIVE curve is not accepted solely because its shape is valid', () => {
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: observedByB580 },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });
  assert.equal(out.ok, false);
  assert.equal(out.normalized, false);
  assert.equal(out.errorCode, 'driver-adjusted');
  assert.match(out.message, /apply was not verified/);
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

test('a one MHz read-back difference is not reported as an applied curve', () => {
  const oneUnitReadBack = requested.map((point) => ({ ...point }));
  oneUnitReadBack[9].Frequency += 1;
  const out = validateVfCurveReadback({
    readBack: { ok: true, points: oneUnitReadBack },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
  });

  assert.equal(out.ok, false);
  assert.equal(out.exact, false);
  assert.equal(out.normalized, false);
  assert.equal(out.errorCode, 'driver-adjusted');
});

test('VF verification polls unchanged before-image data until the LIVE curve changes', async () => {
  const landed = requested.map((point) => ({ ...point }));
  let reads = 0;
  const waits = [];
  const out = await readVfCurveAfterWrite({
    readCurve: async () => {
      reads += 1;
      return { ok: true, points: reads <= 5 ? before : landed };
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
  assert.equal(reads, 10, 'the second stable five-read batch confirms the settled curve');
  assert.deepEqual(waits, [100]);
});

test('VF verification keeps polling through a valid intermediate mismatch until the exact request lands', async () => {
  const intermediate = requested.map((point) => ({ ...point }));
  intermediate[4].Frequency += 1;
  let reads = 0;
  const waits = [];
  const out = await readVfCurveAfterWrite({
    readCurve: async () => {
      reads += 1;
      return { ok: true, points: reads <= 5 ? intermediate : requested };
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
  assert.equal(reads, 10, 'the second stable five-read batch confirms the settled curve');
  assert.deepEqual(waits, [100]);
});

test('VF verification continues bounded read-only polling after an unstable quorum', async () => {
  let reads = 0;
  const waits = [];
  const out = await readVfCurveAfterWrite({
    readCurve: async () => {
      const sample = reads++;
      if (sample < 5) {
        const unstable = before.map((point) => ({ ...point, Voltage: point.Voltage + sample }));
        return { ok: true, points: unstable };
      }
      return { ok: true, points: requested };
    },
    requestedPoints: requested,
    liveBefore: { ok: true, points: before },
    curveRange,
    maxAttempts: 2,
    pollIntervalMs: 100,
    wait: async (ms) => waits.push(ms),
  });

  assert.equal(out.ok, true);
  assert.equal(out.exact, true);
  assert.equal(reads, 10, 'one unstable quorum is followed by one stable exact quorum');
  assert.deepEqual(waits, [100]);
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
  assert.equal(reads, 20, 'each of four no-op observations requires a five-read quorum');
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
  assert.equal(reads, 105, 'each settle observation is stabilized by five immediate LIVE reads');
  assert.equal(waits.length, 20);
  assert.deepEqual(new Set(waits), new Set([100]));
  assert.equal(waits.reduce((sum, ms) => sum + ms, 0), 2000);
});
