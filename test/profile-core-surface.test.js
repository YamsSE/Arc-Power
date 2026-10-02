import test from 'node:test';
import assert from 'node:assert/strict';
import { hasScalarCoreOffsets, repairLegacyScalarProfile } from '../src/renderer/pure/profile-core-surface.ts';
import { validateSettingsPayload } from '../src/renderer/pure/settings.ts';

const stock = [
  { voltageV: 0.6, freqMhz: 1000 },
  { voltageV: 0.7, freqMhz: 2000 },
  { voltageV: 0.8, freqMhz: 3000 },
];
const range = {
  voltageMinV: 0.4,
  voltageMaxV: 1.5,
  freqMinMhz: 400,
  freqMaxMhz: 4300,
  voltageStepV: 0.001,
  frequencyStepMhz: 1,
  maxPoints: 32,
};

const shifted = (points, delta) => points.map((point) => ({ ...point, voltageV: point.voltageV + delta }));

test('legacy scalar repair drops only exact STOCK plus the saved frequency offset', () => {
  const legacy = {
    powerLimitW: 114,
    gpuVoltOffsetV: 0.035,
    gpuFreqOffsetMhz: 150,
    vfCurveStockReference: stock,
    vfCurve: stock.map((point) => ({ ...point, freqMhz: point.freqMhz + 150 })),
  };
  const repaired = repairLegacyScalarProfile(legacy);
  assert.equal('vfCurve' in repaired, false);
  assert.equal('vfCurveStockReference' in repaired, false);
  assert.deepEqual({ powerLimitW: repaired.powerLimitW, gpuVoltOffsetV: repaired.gpuVoltOffsetV, gpuFreqOffsetMhz: repaired.gpuFreqOffsetMhz }, {
    powerLimitW: 114, gpuVoltOffsetV: 0.035, gpuFreqOffsetMhz: 150,
  });

  const contradictoryCustom = { ...legacy, vfCurve: legacy.vfCurve.map((point, index) => ({
    ...point,
    freqMhz: point.freqMhz + (index === 1 ? 1 : 0),
  })) };
  assert.equal(repairLegacyScalarProfile(contradictoryCustom), contradictoryCustom);

  const voltageOnlyNegative = repairLegacyScalarProfile({
    gpuVoltOffsetV: -0.035,
    vfCurveStockReference: stock,
    vfCurve: stock,
  });
  assert.equal('vfCurve' in voltageOnlyNegative, false);
  assert.equal(hasScalarCoreOffsets({ gpuVoltOffsetV: -0.035 }), true);

  const genuineZeroOffsetCustom = { vfCurveStockReference: stock, vfCurve: stock.map((point, index) => ({
    ...point,
    freqMhz: point.freqMhz + (index === 1 ? 1 : 0),
  })) };
  assert.equal(repairLegacyScalarProfile(genuineZeroOffsetCustom), genuineZeroOffsetCustom);
});

test('profile capture omits STOCK and scalar-offset curves, and preserves a stable custom curve at zero offsets', async () => {
  globalThis.window = { arcPower: {}, location: { hash: '#/profiles' }, setTimeout() { return 0; } };
  const pageNode = {};
  const toastStack = { append() {} };
  globalThis.document = {
    getElementById(id) {
      if (id === 'page') return { firstElementChild: pageNode };
      if (id === 'toast-stack') return toastStack;
      return null;
    },
    createElement() {
      return {
        dataset: {},
        classList: { add() {} },
        setAttribute() {},
        addEventListener() {},
        append() {},
        remove() {},
      };
    },
    body: { append() {} },
  };
  try {
    const { captureProfileSettings, settingsFromState } = await import('../src/renderer/pages/profiles.ts');
    const stockState = { fanMode: 'auto', gpuFreqOffsetMhz: 0, gpuVoltOffsetV: 0, vfCurve: stock, vfCurveDefault: stock };
    const stockProfile = settingsFromState(stockState, true);
    assert.equal('vfCurve' in stockProfile, false, 'Battlemage zero-offset STOCK should not be persisted as a curve');
    assert.equal('vfCurveStockReference' in stockProfile, false);
    assert.equal(stockProfile.vfCurveProfileStock, true, 'the profile still records STOCK restore intent');
    assert.equal(validateSettingsPayload(stockProfile), true);
    assert.equal(validateSettingsPayload({ vfCurveProfileStock: true, vfCurve: stock }), false,
      'a stock intent cannot be combined with custom curve points');

    const offsetState = {
      fanMode: 'auto', gpuFreqOffsetMhz: 150, gpuVoltOffsetV: 0.035,
      vfCurve: stock.map((point) => ({ ...point, freqMhz: point.freqMhz + 150 })), vfCurveDefault: stock,
    };
    assert.equal('vfCurve' in settingsFromState(offsetState, true), false, 'scalar offsets suppress every VF field');

    const appState = {
      deviceId: 0,
      devices: [{ id: 0, name: 'Intel Arc B580 Graphics', deviceKey: 'b580-key' }],
      caps: { deviceName: 'Intel Arc B580 Graphics', deviceKey: 'b580-key', controls: { vfCurve: true }, vfCurveRange: range },
      state: { fanMode: 'auto', gpuFreqOffsetMhz: 0, gpuVoltOffsetV: 0 },
    };
    window.arcPower.getCurrentSettings = async () => offsetState;
    const offsetCaptured = await captureProfileSettings({ store: { get: () => appState } });
    assert.equal(offsetCaptured.settings.gpuFreqOffsetMhz, 150);
    assert.equal(offsetCaptured.settings.gpuVoltOffsetV, 0.035);
    assert.equal('vfCurve' in offsetCaptured.settings, false,
      'Battlemage scalar-profile capture must not save its offset-generated LIVE curve');
    assert.equal('vfCurveStockReference' in offsetCaptured.settings, false);
    assert.equal('vfCurveProfileStock' in offsetCaptured.settings, false);

    const custom = stock.map((point, index) => ({ ...point, voltageV: point.voltageV + (index === 1 ? 0.015 : 0) }));
    let reads = 0;
    window.arcPower.getCurrentSettings = async () => {
      reads += 1;
      return { fanMode: 'auto', gpuFreqOffsetMhz: 0, gpuVoltOffsetV: 0, vfCurve: custom, vfCurveDefault: stock };
    };
    const captured = await captureProfileSettings({ store: { get: () => appState } });
    assert.equal(reads, 2, 'custom capture must use two fresh, identical LIVE/STOCK pairs');
    assert.deepEqual(captured.settings.vfCurve, custom);
    assert.deepEqual(captured.settings.vfCurveStockReference, stock);

    const frequencyOnlyCustom = stock.map((point, index) => ({
      ...point,
      freqMhz: point.freqMhz + (index === 1 ? 50 : 0),
    }));
    let frequencyReads = 0;
    window.arcPower.getCurrentSettings = async () => {
      frequencyReads += 1;
      return {
        fanMode: 'auto', gpuFreqOffsetMhz: 0, gpuVoltOffsetV: 0,
        vfCurve: frequencyOnlyCustom, vfCurveDefault: stock,
      };
    };
    const frequencyCaptured = await captureProfileSettings({ store: { get: () => appState } });
    assert.equal(frequencyReads, 2, 'frequency-only custom capture also requires two stable LIVE/STOCK pairs');
    assert.deepEqual(frequencyCaptured.settings.vfCurve, frequencyOnlyCustom);

    window.arcPower.getCurrentSettings = async () => ({
      fanMode: 'auto', gpuFreqOffsetMhz: 0, gpuVoltOffsetV: 0,
      vfCurve: shifted(stock, 0.05), vfCurveDefault: stock,
    });
    assert.equal(await captureProfileSettings({ store: { get: () => appState } }), null,
      'uniform voltage shifts remain ambiguous instead of being silently dropped or saved as custom');
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
});

test('legacy summary hides only the narrowly repaired Battlemage curve badge', async () => {
  globalThis.window ??= { arcPower: {} };
  const { settingsSummary } = await import('../src/renderer/pages/profiles.ts');
  const legacy = {
    gpuVoltOffsetV: 0.035,
    gpuFreqOffsetMhz: 150,
    vfCurveStockReference: stock,
    vfCurve: stock.map((point) => ({ ...point, freqMhz: point.freqMhz + 150 })),
  };
  const mismatchedCustom = { ...legacy, vfCurve: legacy.vfCurve.map((point, index) => ({
    ...point,
    freqMhz: point.freqMhz + (index === 1 ? 1 : 0),
  })) };
  const focusedCaps = { deviceName: 'Intel Arc A770', ranges: {} };
  assert.equal(settingsSummary(legacy, focusedCaps, 'Intel Arc B580 Graphics').includes('VF Curve'), false);
  assert.equal(settingsSummary(mismatchedCustom, focusedCaps, 'Intel Arc B580 Graphics').includes('VF Curve'), true);
});
