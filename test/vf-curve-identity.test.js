import test from 'node:test';
import assert from 'node:assert/strict';
import {
  moveVfPoint,
  hasLinkedVfTerminalPlateau,
  moveVfFrequencyPoint,
  normalizeVfCurvePoints,
  prepareVfCurveForDriver,
  selectVfCurveEditorCurve,
  shouldCommitVfCurveRefresh,
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

test('Battlemage native ending plateau links either terminal frequency in the visible draft', () => {
  const plateau = live.map((point) => ({ ...point }));
  plateau.at(-1).freqMhz = plateau.at(-2).freqMhz;
  const linked = hasLinkedVfTerminalPlateau(plateau, range, true);
  assert.equal(linked, true);
  for (const index of [8, 9]) {
    for (const change of [-10, 10, 50]) {
      const next = moveVfPoint(plateau, index, plateau[index].voltageV, plateau[index].freqMhz + change, range, linked);
      assert.equal(next[8].freqMhz, plateau[index].freqMhz + change);
      assert.equal(next[9].freqMhz, plateau[index].freqMhz + change);
      assert.deepEqual(next.map((point) => point.voltageV), plateau.map((point) => point.voltageV));
    }
  }
  assert.deepEqual(moveVfPoint(plateau, 5, plateau[5].voltageV, 2920, range, linked),
    moveVfPoint(plateau, 5, plateau[5].voltageV, 2920, range));
  assert.equal(hasLinkedVfTerminalPlateau(plateau, range, false), false);
  assert.equal(hasLinkedVfTerminalPlateau(live, range, true), false);
  assert.equal(hasLinkedVfTerminalPlateau(null, range, true), false);
  const voltageOnly = moveVfPoint(plateau, 9, plateau[9].voltageV + 0.001, plateau[9].freqMhz, range, linked);
  assert.equal(voltageOnly[8].voltageV, plateau[8].voltageV);
  assert.equal(voltageOnly[9].voltageV, plateau[9].voltageV + 0.001);
});

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

test('editing within neighboring values preserves unaffected points and point index', () => {
  const moved = moveVfPoint(live, 4, 0.775, 2800, range);
  assert.equal(moved.length, live.length);
  for (let index = 0; index < live.length; index += 1) {
    if (index === 4) continue;
    assert.deepEqual(moved[index], live[index], `point ${index + 1} changed`);
  }
  assert.deepEqual(moved[4], { voltageV: 0.775, freqMhz: 2800 });
});

test('frequency edits use IGS 1 MHz granularity instead of the B580 writer step', () => {
  const stockCurve = [
    [0.67, 1020], [0.72, 1730], [0.77, 2090], [0.82, 2420], [0.87, 2630],
    [0.92, 2830], [0.97, 2960], [1.02, 3090], [1.07, 3210], [1.12, 3210],
  ].map(([voltageV, freqMhz]) => ({ voltageV, freqMhz }));
  const moved = moveVfPoint(stockCurve, 8, 1.07, 3195, range);
  assert.equal(moved[8].freqMhz, 3195);
  assert.equal(moved[9].freqMhz, 3210);
  for (let index = 0; index < stockCurve.length; index += 1) {
    if (index === 8) continue;
    assert.deepEqual(moved[index], stockCurve[index]);
  }

  const movedFrequency = moveVfFrequencyPoint(stockCurve, 8, 3195, range);
  assert.equal(movedFrequency[8].freqMhz, 3195);
  assert.equal(movedFrequency[9].freqMhz, 3210);
  assert.deepEqual(prepareVfCurveForDriver(movedFrequency, range), movedFrequency,
    'integer MHz values remain eligible for the native writer and its stable read-back check');
});

test('raising a point propagates a frequency plateau forward through lower points', () => {
  const points = [100, 200, 250, 300].map((freqMhz, index) => ({
    voltageV: 0.5 + index * 0.01,
    freqMhz,
  }));
  const moved = moveVfFrequencyPoint(points, 1, 350, {
    ...range, freqMinMhz: 0, freqMaxMhz: 4300,
  });
  assert.deepEqual(moved.map((point) => point.freqMhz), [100, 350, 350, 350]);
});

test('lowering a point propagates frequency decreases backward through higher points', () => {
  const points = [100, 200, 300, 400].map((freqMhz, index) => ({
    voltageV: 0.5 + index * 0.01,
    freqMhz,
  }));
  const moved = moveVfFrequencyPoint(points, 2, 150, {
    ...range, freqMinMhz: 0, freqMaxMhz: 4300,
  });
  assert.deepEqual(moved.map((point) => point.freqMhz), [100, 150, 150, 400]);
});

test('voltage edits cascade point spacing forward and backward within graph bounds', () => {
  const tightRange = { ...range, voltageMinV: 0.4, voltageMaxV: 0.406, freqMinMhz: 0 };
  const points = [0.4, 0.402, 0.403, 0.406].map((voltageV, index) => ({
    voltageV,
    freqMhz: 100 + index * 100,
  }));
  const forward = moveVfPoint(points, 1, 0.403, points[1].freqMhz, tightRange);
  assert.deepEqual(forward.map((point) => point.voltageV), [0.4, 0.403, 0.404, 0.406]);

  const backwardPoints = [0.399, 0.401, 0.403, 0.406].map((voltageV, index) => ({
    voltageV,
    freqMhz: 100 + index * 100,
  }));
  const backward = moveVfPoint(backwardPoints, 2, 0.4, backwardPoints[2].freqMhz, {
    ...tightRange, voltageMinV: 0.398,
  });
  assert.deepEqual(backward.map((point) => point.voltageV), [0.398, 0.399, 0.4, 0.406]);

  const atBounds = [0.4, 0.401, 0.402, 0.403].map((voltageV, index) => ({
    voltageV,
    freqMhz: 100 + index * 100,
  }));
  const bounded = moveVfPoint(atBounds, 1, 0.405, atBounds[1].freqMhz, {
    ...tightRange, voltageMaxV: 0.403,
  });
  assert.deepEqual(bounded.map((point) => point.voltageV), [0.4, 0.401, 0.402, 0.403],
    'edits clamp to the largest valid graph-bound layout');
});

test('combined voltage and frequency edit propagates both axes', () => {
  const points = [100, 200, 250, 300].map((freqMhz, index) => ({
    voltageV: 0.5 + index * 0.01,
    freqMhz,
  }));
  const moved = moveVfPoint(points, 1, 0.52, 350, {
    ...range, freqMinMhz: 0, freqMaxMhz: 4300,
  });
  assert.deepEqual(moved.map((point) => point.voltageV), [0.5, 0.52, 0.521, 0.53]);
  assert.deepEqual(moved.map((point) => point.freqMhz), [100, 350, 350, 350]);
});

test('voltage cascade stays on adapters with coarser reported grids', () => {
  const coarseRange = { ...range, voltageStepV: 0.005 };
  const points = [0.4, 0.41, 0.42, 0.43].map((voltageV, index) => ({
    voltageV,
    freqMhz: 1000 + index * 100,
  }));
  const moved = moveVfPoint(points, 1, 0.425, points[1].freqMhz, coarseRange);

  assert.deepEqual(moved.map((point) => point.voltageV), [0.4, 0.425, 0.43, 0.435]);
  assert.deepEqual(prepareVfCurveForDriver(moved, coarseRange), moved);
});

test('a deferred VF refresh cannot commit over a new draft or a new page/device', async () => {
  let resolveResponse;
  const response = new Promise((resolve) => { resolveResponse = resolve; });
  let draftPending = false;
  let currentDeviceId = 3;
  let currentDeviceKey = 'b580';
  let currentGeneration = 8;
  let committed = false;
  const requestedDeviceId = 3;
  const requestedDeviceKey = 'b580';
  const requestGeneration = 8;
  const pendingRefresh = (async () => {
    await response;
    committed = shouldCommitVfCurveRefresh(
      requestedDeviceId,
      currentDeviceId,
      requestedDeviceKey,
      currentDeviceKey,
      draftPending,
      requestGeneration,
      currentGeneration,
    );
  })();

  draftPending = true;
  resolveResponse();
  await pendingRefresh;
  assert.equal(committed, false, 'a draft created during the read must be preserved');

  assert.equal(shouldCommitVfCurveRefresh(3, 4, 'b580', 'a580', false, 8, 8), false,
    'a different selected adapter must discard the result');
  currentDeviceId = 3;
  currentDeviceKey = 'other-adapter';
  draftPending = false;
  assert.equal(shouldCommitVfCurveRefresh(3, currentDeviceId, 'b580', currentDeviceKey, false, 8, 8), false,
    'stable device ordinals cannot substitute for physical identity');
  currentDeviceKey = 'b580';
  currentGeneration = 9;
  assert.equal(shouldCommitVfCurveRefresh(3, currentDeviceId, currentDeviceKey, 'b580', false, 8, currentGeneration), false,
    'an older page request must not update a newly rendered page');
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

test('custom VF tables round-trip while exact STOCK tables are omitted from profile saves', () => {
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
  }, true);
  assert.equal('vfCurve' in stockSaved, false);
  const stockReloaded = normalizeBattlemageProfileSettings(stockSaved, {
    deviceName: 'Intel Arc B580',
    controls: { vfCurve: true },
    vfCurveRange: range,
  }, { vfCurveDefault: live, vfCurve: live });
  assert.equal('vfCurve' in stockReloaded, false);
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

test('driver preparation rejects curves requiring coordinate rounding or monotonic repair but preserves IGS frequency precision', () => {
  assert.deepEqual(prepareVfCurveForDriver(live, range), live);
  const offNativeStep = live.map((point) => ({ ...point }));
  offNativeStep[8].freqMhz = 3195;
  assert.deepEqual(prepareVfCurveForDriver(offNativeStep, range), offNativeStep,
    'integer MHz values are passed through so IGCL can apply the same 1 MHz edit IGS exposes');
  const fractionalFrequency = live.map((point) => ({ ...point }));
  fractionalFrequency[3].freqMhz += 0.4;
  assert.equal(prepareVfCurveForDriver(fractionalFrequency, range), null);
  const descending = live.map((point) => ({ ...point }));
  descending[4].freqMhz = descending[3].freqMhz - 1;
  assert.equal(prepareVfCurveForDriver(descending, range), null);
});

test('mock VF accepts the native nondecreasing terminal frequency plateau', async () => {
  const { readFileSync } = await import('node:fs');
  const { MockBackend } = await import('../src/main/backend/mock-backend.js');
  const featureset = JSON.parse(readFileSync(new URL('../mock/featuresets/b580.json', import.meta.url), 'utf8'));
  const backend = new MockBackend({ featureset });
  await backend.init();
  try {
    await backend.setWaiverAccepted(0);
    const state = await backend.getCurrentSettings(0);
    const curve = state.vfCurve.map((point) => ({ ...point }));
    curve[curve.length - 1].freqMhz = curve[curve.length - 2].freqMhz;
    const result = await backend.applySettings(0, { vfCurve: curve });
    assert.equal(result.perControl.vfCurve.ok, true);
    assert.deepEqual((await backend.getCurrentSettings(0)).vfCurve, curve);
  } finally {
    await backend.close();
  }
});
