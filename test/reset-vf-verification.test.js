import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';

const range = {
  voltageMinV: 0.4,
  voltageMaxV: 1.5,
  freqMinMhz: 400,
  freqMaxMhz: 4300,
  maxPoints: 10,
};
const stock = [
  { voltageV: 0.57, freqMhz: 1550 },
  { voltageV: 0.62, freqMhz: 2000 },
  { voltageV: 0.67, freqMhz: 2340 },
];

function resetHandler({ state, states, deviceName = 'Intel Arc B580', vfSupported = true, reset, applyRunner, wait } = {}) {
  let reads = 0;
  const backend = {
    getDeviceTarget: async () => null,
    resetToDefaults: reset ?? (async () => {}),
    getCurrentSettings: async () => states ? states[Math.min(reads++, states.length - 1)] : state,
    getCapabilities: async () => ({
      deviceName,
      controls: { vfCurve: vfSupported, gpuLock: false },
      ranges: { gpuFreqOffsetMhz: { default: 0 } },
      vfCurveRange: range,
    }),
  };
  return createIpcHandlers({
    backend, store: {}, emit: () => {}, applyRunner, resetVerifyWait: wait ?? (async () => {}),
  }).handlers['reset-to-defaults'];
}

test('Battlemage reset succeeds only with valid matching STOCK and LIVE mV/MHz points', async () => {
  let resets = 0;
  const state = {
    gpuFreqOffsetMhz: 0,
    vfCurveDefault: stock,
    vfCurve: stock.map((point) => ({ ...point })),
  };
  state.vfCurve[0].voltageV = 0.5700000000000001;
  const reset = resetHandler({ state, reset: async () => { resets += 1; } });
  assert.deepEqual(await reset(0), { state });
  assert.equal(resets, 1);
});

test('Battlemage reset rereads a transitional LIVE curve without repeating the native reset', async () => {
  let resets = 0;
  let waits = 0;
  const settled = { gpuFreqOffsetMhz: 0, vfCurveDefault: stock, vfCurve: stock };
  const transitional = { ...settled, vfCurve: null };
  const reset = resetHandler({
    states: [transitional, settled],
    reset: async () => { resets += 1; },
    wait: async (ms) => { assert.equal(ms, 1500); waits += 1; },
  });
  assert.deepEqual(await reset(0), { state: settled });
  assert.equal(resets, 1);
  assert.equal(waits, 1);
});

test('Battlemage reset rejects a different LIVE point and retains scalar verification', async () => {
  const changedFrequency = stock.map((point) => ({ ...point }));
  changedFrequency[1].freqMhz += 1;
  await assert.rejects(
    resetHandler({ state: { gpuFreqOffsetMhz: 0, vfCurveDefault: stock, vfCurve: changedFrequency } })(0),
    /reset-to-defaults verification failed: VF curve: LIVE points do not exactly match STOCK mV\/MHz points/,
  );

  const changedVoltage = stock.map((point) => ({ ...point }));
  changedVoltage[1].voltageV += 0.001;
  await assert.rejects(
    resetHandler({ state: { gpuFreqOffsetMhz: 0, vfCurveDefault: stock, vfCurve: changedVoltage } })(0),
    /VF curve: LIVE points do not exactly match STOCK mV\/MHz points/,
  );

  await assert.rejects(
    resetHandler({ state: { gpuFreqOffsetMhz: 1, vfCurveDefault: stock, vfCurve: stock } })(0),
    /gpuFreqOffsetMhz: read-back 1 != default 0/,
  );
});

test('Battlemage reset rejects missing, wrong-count, or malformed VF read-back', async () => {
  for (const [defaultCurve, liveCurve] of [
    [null, stock],
    [stock, null],
    [stock, stock.slice(1)],
    [stock, [{ ...stock[0], voltageV: Number.NaN }, ...stock.slice(1)]],
  ]) {
    await assert.rejects(
      resetHandler({ state: { gpuFreqOffsetMhz: 0, vfCurveDefault: defaultCurve, vfCurve: liveCurve } })(0),
      /reset-to-defaults verification failed: VF curve:/,
    );
  }
});

test('reset retains non-Battlemage behavior but refuses an unverifiable Battlemage curve', async () => {
  const state = { gpuFreqOffsetMhz: 0, vfCurveDefault: null, vfCurve: null };
  assert.deepEqual(await resetHandler({ state, deviceName: 'Intel Arc A770' })(0), { state });
  await assert.rejects(
    resetHandler({ state, vfSupported: false })(0),
    /VF curve: valid STOCK and LIVE read-back unavailable/,
  );
});

test('elevated worker reset state must pass the same VF verification', async () => {
  let directResets = 0;
  let workerResets = 0;
  const state = { gpuFreqOffsetMhz: 0, vfCurveDefault: stock, vfCurve: null };
  const reset = resetHandler({
    state,
    reset: async () => { directResets += 1; },
    applyRunner: {
      needsWorker: () => true,
      reset: async () => { workerResets += 1; return { state }; },
    },
  });
  await assert.rejects(reset(0), /VF curve: valid STOCK and LIVE read-back unavailable/);
  assert.equal(workerResets, 1);
  assert.equal(directResets, 0);
});
