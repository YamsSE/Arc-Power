import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moveVfPoint,
  moveVfFrequencyPoint,
  normalizeVfCurvePoints,
  prepareVfCurveForDriver,
  selectVfCurveEditorCurve,
  sameVfCurve,
  shouldSyncVfCurveFromState,
  vfCurveNeedsWrite,
} from '../src/renderer/pure/vf-curve.ts';
import { normalizeBattlemageProfileSettings } from '../src/renderer/pure/profile-compat.ts';
globalThis.window ??= { arcPower: {} };
const { profileSettingsForCapabilities, settingsFromState } = await import('../src/renderer/pages/profiles.ts');

const range = {
  voltageMinV: 0.4,
  voltageMaxV: 1.5,
  freqMinMhz: 400,
  freqMaxMhz: 4300,
  voltageStepV: 0.001,
  frequencyStepMhz: 10,
  maxPoints: 10,
};
const live = [
  [0.57, 1550], [0.62, 2000], [0.67, 2340], [0.72, 2580], [0.77, 2780],
  [0.82, 2930], [0.87, 3060], [0.92, 3180], [0.97, 3210], [1.02, 3230],
].map(([voltageV, freqMhz]) => ({ voltageV, freqMhz }));

test('normalization preserves exact valid live point order and coordinates', () => {
  const offsetGrid = live.map((point, index) => ({ ...point, voltageV: point.voltageV + (index ? 0.003 : 0) }));
  assert.deepEqual(normalizeVfCurvePoints(offsetGrid, range, 10), offsetGrid);
});

test('editor falls back to an exact STOCK reference when LIVE is unavailable', () => {
  const stock = live.map((point) => ({ ...point }));
  const selection = selectVfCurveEditorCurve(null, stock, range);
  assert.equal(selection.source, 'stock-reference');
  assert.deepEqual(selection.points, stock);
  assert.notEqual(selection.points, stock, 'the reference is an independent editor copy');
});

test('editor prefers valid LIVE over STOCK and never repairs invalid tables', () => {
  const stock = live.map((point) => ({ ...point }));
  const current = live.map((point) => ({ ...point }));
  current[4].freqMhz += 10;
  assert.deepEqual(selectVfCurveEditorCurve(current, stock, range), {
    source: 'live',
    points: current,
  });

  const invalidStock = stock.map((point) => ({ ...point }));
  invalidStock[5].freqMhz = invalidStock[4].freqMhz - 10;
  assert.deepEqual(selectVfCurveEditorCurve(null, invalidStock, range), {
    source: 'unavailable',
    points: [],
  });
});

test('invalid tables fail closed and driver tables above ten points are never truncated', () => {
  const invalid = live.map((point) => ({ ...point }));
  invalid[4].freqMhz = invalid[3].freqMhz - 1;
  assert.deepEqual(normalizeVfCurvePoints(invalid, range, 10), []);

  const extendedRange = { ...range, maxPoints: 32 };
  const longer = Array.from({ length: 12 }, (_, index) => ({
    voltageV: 0.5 + index * 0.01,
    freqMhz: 1000 + index * 100,
  }));
  assert.deepEqual(normalizeVfCurvePoints(longer, extendedRange, 10), longer);
});

test('editing one point preserves every other point and point index', () => {
  const moved = moveVfPoint(live, 4, 0.775, 2800, range);
  assert.equal(moved.length, live.length);
  for (let index = 0; index < live.length; index += 1) {
    if (index === 4) continue;
    assert.deepEqual(moved[index], live[index], `point ${index + 1} changed`);
  }
  assert.deepEqual(moved[4], { voltageV: 0.775, freqMhz: 2800 });
});

test('B580 curve edits snap to the reported 10 MHz step without moving neighboring points', () => {
  const stockCurve = [
    [0.67, 1020], [0.72, 1730], [0.77, 2090], [0.82, 2420], [0.87, 2630],
    [0.92, 2830], [0.97, 2960], [1.02, 3090], [1.07, 3210], [1.12, 3210],
  ].map(([voltageV, freqMhz]) => ({ voltageV, freqMhz }));
  const moved = moveVfPoint(stockCurve, 8, 1.07, 3195, range);
  assert.equal(moved[8].freqMhz, 3200);
  assert.equal(moved[9].freqMhz, 3210);
  for (let index = 0; index < stockCurve.length; index += 1) {
    if (index === 8) continue;
    assert.deepEqual(moved[index], stockCurve[index]);
  }

  const movedFrequency = moveVfFrequencyPoint(stockCurve, 8, 3195, range);
  assert.equal(movedFrequency[8].freqMhz, 3200);
  assert.equal(movedFrequency[9].freqMhz, 3210);
});

test('a clean editor follows external profile state while an edited draft stays put', () => {
  assert.equal(shouldSyncVfCurveFromState(live, live.map((point) => ({ ...point }))), true);
  const edited = moveVfPoint(live, 4, 0.775, 2800, range);
  assert.equal(shouldSyncVfCurveFromState(edited, live), false);
  assert.equal(shouldSyncVfCurveFromState(live, live, true), false, 'pending STOCK reset keeps its native payload until apply completes');
});

test('profile normalization preserves custom curves and conflicting offsets for backend validation', () => {
  const custom = live.map((point, index) => ({ ...point, voltageV: point.voltageV + 0.025 + index * 0.001 }));
  const settings = { vfCurve: custom, gpuFreqOffsetMhz: 100 };
  const normalized = normalizeBattlemageProfileSettings(settings, {
    deviceName: 'Intel Arc B580',
    controls: { vfCurve: true },
    vfCurveRange: range,
  }, { vfCurveDefault: live, vfCurve: live });
  assert.deepEqual(normalized.vfCurve, custom);
  assert.equal(normalized.gpuFreqOffsetMhz, 100);
  assert.equal(normalized.gpuVoltOffsetV, undefined);
});

test('profile capability route forwards custom curve offsets to backend validation', () => {
  const custom = live.map((point, index) => ({ ...point, freqMhz: point.freqMhz + index + 1 }));
  const settings = {
    vfCurve: custom,
    gpuFreqOffsetMhz: 100,
    gpuVoltOffsetV: 0.025,
  };
  const forwarded = profileSettingsForCapabilities(settings, {
    deviceName: 'Intel Arc B580',
    controls: { vfCurve: true },
    vfCurveRange: range,
  }, { vfCurveDefault: live, vfCurve: live });
  assert.deepEqual(forwarded.vfCurve, custom);
  assert.equal(forwarded.gpuFreqOffsetMhz, 100);
  assert.equal(forwarded.gpuVoltOffsetV, 0.025);
});

test('profile capability route preserves VF dependency data when the surface is unavailable', () => {
  const custom = live.map((point, index) => ({ ...point, freqMhz: point.freqMhz + index + 1 }));
  const settings = {
    vfCurve: custom,
    gpuFreqOffsetMhz: 100,
    gpuVoltOffsetV: 0.025,
  };
  const forwarded = profileSettingsForCapabilities(settings, {
    deviceName: 'Intel Arc B580',
    controls: { vfCurve: false },
    vfCurveRange: range,
  }, { vfCurveDefault: live, vfCurve: live });
  assert.deepEqual(forwarded.vfCurve, custom);
  assert.equal(forwarded.gpuFreqOffsetMhz, 100);
  assert.equal(forwarded.gpuVoltOffsetV, 0.025);
});

test('profile normalization preserves offsets when STOCK identity is unavailable for backend verification', () => {
  const custom = live.map((point, index) => ({ ...point, freqMhz: point.freqMhz + index }));
  const normalized = normalizeBattlemageProfileSettings({
    vfCurve: custom,
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 0.025,
  }, {
    deviceName: 'Intel Arc B580',
    controls: { vfCurve: true },
    vfCurveRange: range,
  }, { vfCurve: live });
  assert.deepEqual(normalized.vfCurve, custom);
  assert.equal(normalized.gpuFreqOffsetMhz, 75);
  assert.equal(normalized.gpuVoltOffsetV, 0.025);
});

test('baked-pattern-looking profile curves round-trip unchanged, including exact STOCK saves', () => {
  const bakedPattern = live.map((point, index) => ({
    ...point,
    freqMhz: point.freqMhz + (index === 0 ? 0 : 100),
  }));
  const saved = settingsFromState({
    fanMode: 'auto',
    vfCurve: bakedPattern,
    vfCurveDefault: live,
  });
  assert.deepEqual(saved.vfCurve, bakedPattern);
  const reloaded = normalizeBattlemageProfileSettings(saved, {
    deviceName: 'Intel Arc B580',
    controls: { vfCurve: true },
    vfCurveRange: range,
  }, { vfCurveDefault: live, vfCurve: live });
  assert.deepEqual(reloaded.vfCurve, bakedPattern);

  const stockSaved = settingsFromState({
    fanMode: 'auto',
    gpuFreqOffsetMhz: 75,
    gpuVoltOffsetV: 0.025,
    vfCurve: live,
    vfCurveDefault: live,
  });
  assert.deepEqual(stockSaved.vfCurve, live);
  const stockReloaded = normalizeBattlemageProfileSettings(stockSaved, {
    deviceName: 'Intel Arc B580',
    controls: { vfCurve: true },
    vfCurveRange: range,
  }, { vfCurveDefault: live, vfCurve: live });
  assert.deepEqual(stockReloaded.vfCurve, live);
  assert.equal(stockReloaded.gpuFreqOffsetMhz, 75);
  assert.equal(stockReloaded.gpuVoltOffsetV, 0.025);
});

test('no-op decision skips a setter only for an exactly identical LIVE table', () => {
  assert.equal(vfCurveNeedsWrite(live, live.map((point) => ({ ...point }))), false);
  const changed = live.map((point) => ({ ...point }));
  changed[8].freqMhz -= 1;
  assert.equal(vfCurveNeedsWrite(changed, live), true);
  assert.equal(vfCurveNeedsWrite(live.slice(0, -1), live), true);
});

test('profile persistence distinguishes every custom point change from exact stock', () => {
  assert.equal(sameVfCurve(live, live, 0, 0), true);
  const custom = live.map((point) => ({ ...point }));
  custom[5].freqMhz -= 1;
  assert.equal(sameVfCurve(custom, live, 0, 0), false);
});

test('driver preparation rejects curves requiring coordinate rounding, native-step rounding, or monotonic repair', () => {
  assert.deepEqual(prepareVfCurveForDriver(live, range), live);
  const offNativeStep = live.map((point) => ({ ...point }));
  offNativeStep[8].freqMhz = 3195;
  assert.equal(prepareVfCurveForDriver(offNativeStep, range), null);
  const fractionalFrequency = live.map((point) => ({ ...point }));
  fractionalFrequency[3].freqMhz += 0.4;
  assert.equal(prepareVfCurveForDriver(fractionalFrequency, range), null);
  const descending = live.map((point) => ({ ...point }));
  descending[4].freqMhz = descending[3].freqMhz - 1;
  assert.equal(prepareVfCurveForDriver(descending, range), null);
});
