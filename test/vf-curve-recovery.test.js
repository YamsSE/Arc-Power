import test from 'node:test';
import assert from 'node:assert/strict';
import { discardVfCurveDraft, observeVfCurveSnapshot, verifiedVfCurveApplySnapshot, vfCurveEditorContextIsCurrent } from '../src/renderer/pure/vf-curve-recovery.ts';
import { shouldCommitVfCurveRefresh } from '../src/renderer/pure/vf-curve.ts';

const range = { voltageMinV: 0.4, voltageMaxV: 1.5, freqMinMhz: 400, freqMaxMhz: 4300, maxPoints: 10 };
const live = [{ voltageV: 0.7, freqMhz: 1600 }, { voltageV: 0.8, freqMhz: 2400 }];
const stock = [{ voltageV: 0.65, freqMhz: 1500 }, { voltageV: 0.75, freqMhz: 2300 }];

test('missing and invalid background reads preserve the last readable native curve without claiming a change', () => {
  for (const failedRead of [undefined, null, [], [{ voltageV: 0.9, freqMhz: 2000 }, { voltageV: 0.8, freqMhz: 2100 }]]) {
    const observation = observeVfCurveSnapshot(live, failedRead, range);
    assert.equal(observation.changed, false);
    assert.deepEqual(observation.points, live);
  }
});

test('read recovery still detects an actual change against the pre-failure snapshot', () => {
  const unavailable = observeVfCurveSnapshot(live, null, range);
  assert.equal(observeVfCurveSnapshot(unavailable.points, live, range).changed, false);
  const changed = live.map((point) => ({ ...point }));
  changed[1].freqMhz += 1;
  assert.equal(observeVfCurveSnapshot(unavailable.points, changed, range).changed, true);
  const translated = live.map((point) => ({ ...point, voltageV: point.voltageV + 0.023 }));
  assert.equal(observeVfCurveSnapshot(unavailable.points, translated, range).changed, true);
  assert.equal(observeVfCurveSnapshot(unavailable.points, translated, range, true).changed, false);
});

test('Battlemage common voltage origin drift preserves the visible snapshot and pending coordinates', () => {
  const visible = live.map((point) => ({ ...point }));
  const draft = live.map((point) => ({ ...point, freqMhz: point.freqMhz + 1 }));
  let observed = live;
  for (const originMv of [670, 776, 780, 784, 795]) {
    const sample = live.map((point) => ({ ...point, voltageV: (originMv + Math.round((point.voltageV - live[0].voltageV) * 1000)) / 1000 }));
    const observation = observeVfCurveSnapshot(observed, sample, range, true);
    assert.equal(observation.changed, false);
    observed = observation.points;
  }
  assert.deepEqual(visible, live);
  assert.deepEqual(draft, live.map((point) => ({ ...point, freqMhz: point.freqMhz + 1 })));
});

test('Battlemage shape comparison rejects frequency, spacing and native count changes', () => {
  const shifted = live.map((point) => ({ ...point, voltageV: point.voltageV + 0.023 }));
  const frequencyChanged = shifted.map((point, index) => ({ ...point, freqMhz: point.freqMhz + index }));
  const spacingChanged = shifted.map((point, index) => ({ ...point, voltageV: point.voltageV + index / 1000 }));
  const countChanged = [...shifted, { voltageV: 0.923, freqMhz: 3000 }];
  for (const sample of [frequencyChanged, spacingChanged, countChanged]) {
    assert.equal(observeVfCurveSnapshot(live, sample, range, true).changed, true);
  }
  const fractionalNativeCoordinates = live.map((point) => ({ ...point, voltageV: point.voltageV + 0.0231 }));
  assert.equal(observeVfCurveSnapshot(live, fractionalNativeCoordinates, range, true).changed, true);
});

test('a verified apply snapshot becomes the reference for following translated LIVE pushes', () => {
  const applied = live.map((point, index) => ({ ...point, freqMhz: point.freqMhz + index }));
  const reference = observeVfCurveSnapshot(live, applied, range, true).points;
  const background = applied.map((point) => ({ ...point, voltageV: point.voltageV + 0.125 }));
  assert.equal(observeVfCurveSnapshot(reference, background, range, true).changed, false);
  assert.equal(observeVfCurveSnapshot(live, background, range, true).changed, true);
});

test('an own changed-curve broadcast before the Apply response can be superseded by verified LIVE success', async () => {
  const applied = live.map((point, index) => ({ ...point, freqMhz: point.freqMhz + index }));
  let finishApply;
  const pendingResponse = new Promise((resolve) => { finishApply = resolve; });
  const response = pendingResponse.then((curve) => verifiedVfCurveApplySnapshot(true,
    shouldCommitVfCurveRefresh(1, 1, 'b580', 'b580', false, 4, 4), curve, range));
  assert.equal(observeVfCurveSnapshot(live, applied, range, true).changed, true,
    'the earlier state broadcast would freeze the before-image');
  finishApply(applied);
  const verified = await response;
  assert.deepEqual(verified, applied);
  const laterOrigin = applied.map((point) => ({ ...point, voltageV: point.voltageV + 0.023 }));
  assert.equal(observeVfCurveSnapshot(verified, laterOrigin, range, true).changed, false);
});

test('only successful valid LIVE responses for the same physical adapter and page generation can revive an editor', () => {
  for (const [id, key, generation] of [[2, 'b580', 4], [1, 'different-adapter', 4], [1, 'b580', 5]]) {
    const matchesEditor = shouldCommitVfCurveRefresh(1, id, 'b580', key, false, 4, generation);
    assert.equal(verifiedVfCurveApplySnapshot(true, matchesEditor, live, range), null);
  }
  assert.equal(verifiedVfCurveApplySnapshot(true, false, live, range), null, 'leaving Tuning invalidates the response');
  assert.equal(verifiedVfCurveApplySnapshot(false, true, live, range), null);
  for (const unreadable of [null, undefined, [], [{ voltageV: 0.8, freqMhz: 2100 }, { voltageV: 0.7, freqMhz: 2200 }]]) {
    assert.equal(verifiedVfCurveApplySnapshot(true, true, unreadable, range), null);
  }
});

test('refresh requests do not invalidate an in-flight scalar Apply or strand its busy state', async () => {
  let finishApply;
  let applying = true;
  let refreshGeneration = 2;
  const pageGeneration = 4;
  const pending = new Promise((resolve) => { finishApply = resolve; }).finally(() => {
    if (vfCurveEditorContextIsCurrent(1, 1, 'b580', 'b580', true, 4, pageGeneration)) applying = false;
  });
  refreshGeneration += 1;
  assert.equal(shouldCommitVfCurveRefresh(1, 1, 'b580', 'b580', false, 2, refreshGeneration), false,
    'the driver-read generation changed, independently of the page lifetime');
  assert.equal(vfCurveEditorContextIsCurrent(1, 1, 'b580', 'b580', true, 4, pageGeneration), true);
  finishApply();
  await pending;
  assert.equal(applying, false);
});

test('leaving Tuning rejects delayed reads and capability or waiver continuations even before another render', async () => {
  for (const continuation of ['driver-refresh', 'failure-capabilities', 'waiver-retry']) {
    let finishRequest;
    let tuningPageActive = true;
    let writes = 0;
    const pending = new Promise((resolve) => { finishRequest = resolve; }).then(() => {
      if (vfCurveEditorContextIsCurrent(1, 1, 'b580', 'b580', tuningPageActive, 4, 4)) writes += 1;
    });
    tuningPageActive = false;
    finishRequest();
    await pending;
    assert.equal(writes, 0, continuation);
  }
  assert.equal(vfCurveEditorContextIsCurrent(1, 1, 'b580', 'b580', true, 4, 5), false,
    'returning to a freshly rendered Tuning page still rejects the old operation');
});

test('LIVE and STOCK failures and changes remain independent and samples are copied', () => {
  const liveObservation = observeVfCurveSnapshot(live, null, range);
  const stockObservation = observeVfCurveSnapshot(stock, stock.map((point) => ({ ...point, freqMhz: point.freqMhz + 1 })), range);
  assert.equal(liveObservation.changed, false);
  assert.equal(stockObservation.changed, true);
  const next = live.map((point) => ({ ...point }));
  const accepted = observeVfCurveSnapshot(null, next, range);
  assert.equal(accepted.changed, false);
  next[0].freqMhz += 100;
  assert.deepEqual(accepted.points, live);
});

test('discard removes both pending point edits and staged native reset without mutating the applied table', () => {
  const discarded = discardVfCurveDraft(live);
  assert.deepEqual(discarded.draft, live);
  assert.equal(discarded.nativeApplyDraft, null);
  discarded.draft[0].freqMhz += 100;
  assert.equal(live[0].freqMhz, 1600);
});

test('a deferred discard-and-refresh cannot replace a newer draft, device or page', async () => {
  const requested = { id: 1, key: 'b580', generation: 4 };
  const discarded = discardVfCurveDraft(live);
  for (const current of [
    { id: 1, key: 'b580', generation: 4, dirty: true },
    { id: 2, key: 'b580', generation: 4, dirty: false },
    { id: 1, key: 'other-physical-gpu', generation: 4, dirty: false },
    { id: 1, key: 'b580', generation: 5, dirty: false },
  ]) {
    let finishRead;
    const read = new Promise((resolve) => { finishRead = resolve; });
    const pending = read.then(() => shouldCommitVfCurveRefresh(requested.id, current.id,
      requested.key, current.key, current.dirty, requested.generation, current.generation));
    finishRead(discarded.draft);
    assert.equal(await pending, false);
  }
  assert.equal(shouldCommitVfCurveRefresh(1, 1, 'b580', 'b580', false, 4, 4), true);
});
