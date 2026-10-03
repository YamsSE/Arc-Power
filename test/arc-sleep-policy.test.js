import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARC_SLEEP_DEFAULTS,
  createArcSleepPolicyState,
  normalizeArcSleepSettings,
  stepArcSleepPolicy
} from '../src/main/arc-sleep-policy.js';

test('normalizes defaults, bounds, booleans, and an invalid adaptive range', () => {
  assert.deepEqual(normalizeArcSleepSettings(), ARC_SLEEP_DEFAULTS);
  assert.deepEqual(normalizeArcSleepSettings({
    idleEnabled: 1,
    adaptiveEnabled: true,
    idleAfterSeconds: 1,
    idleFps: 999,
    adaptiveMinFps: 300,
    adaptiveMaxFps: 100,
    adaptiveTargetLoadPct: 1
  }), {
    idleEnabled: false,
    adaptiveEnabled: true,
    idleAfterSeconds: 60,
    idleFps: 120,
    adaptiveMinFps: ARC_SLEEP_DEFAULTS.adaptiveMinFps,
    adaptiveMaxFps: ARC_SLEEP_DEFAULTS.adaptiveMaxFps,
    adaptiveTargetLoadPct: 50
  });
  assert.equal(normalizeArcSleepSettings({ idleAfterSeconds: 'bogus' }).idleAfterSeconds, 300);
});

test('idle cap activates at the threshold and invalid idle readings mean active', () => {
  const settings = { idleEnabled: true, idleAfterSeconds: 60, idleFps: 24 };
  const state = createArcSleepPolicyState(settings);
  const idle = stepArcSleepPolicy(state, settings, { idleMs: 60000, nowMs: 10, loadPercent: null });
  assert.equal(idle.targetFps, 24);
  assert.equal(idle.source, 'idle');
  for (const idleMs of [null, -1, Number.NaN, '60000']) {
    const active = stepArcSleepPolicy(idle.state, settings, { idleMs, nowMs: 20, loadPercent: null });
    assert.equal(active.idleActive, false);
  }
});

test('idle override takes priority and resumes the adaptive target after activity', () => {
  const settings = {
    idleEnabled: true, idleAfterSeconds: 60, idleFps: 20,
    adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 100
  };
  let state = createArcSleepPolicyState(settings);
  let result = stepArcSleepPolicy(state, settings, { idleMs: 0, loadPercent: 99, nowMs: 0 });
  state = result.state;
  result = stepArcSleepPolicy(state, settings, { idleMs: 0, loadPercent: 99, nowMs: 100 });
  state = result.state;
  result = stepArcSleepPolicy(state, settings, { idleMs: 60000, loadPercent: 99, nowMs: 200 });
  assert.equal(result.targetFps, 20);
  assert.equal(result.adaptiveTargetFps, 95);
  result = stepArcSleepPolicy(result.state, settings, { idleMs: 0, loadPercent: 99, nowMs: 300 });
  assert.equal(result.targetFps, 95);
  assert.equal(result.source, 'adaptive');
});

test('adaptive hysteresis requires three high or five low samples and clamps', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 40, adaptiveTargetLoadPct: 70 };
  let state = createArcSleepPolicyState(settings);
  for (let i = 0; i < 2; i++) state = stepArcSleepPolicy(state, settings, { loadPercent: 80, nowMs: i }).state;
  assert.equal(state.adaptiveCapFps, 40);
  state = stepArcSleepPolicy(state, settings, { loadPercent: 80, nowMs: 2 }).state;
  assert.equal(state.adaptiveCapFps, 35);
  for (let i = 0; i < 5; i++) state = stepArcSleepPolicy(state, settings, { loadPercent: 50, nowMs: i + 3 }).state;
  assert.equal(state.adaptiveCapFps, 38);
  for (let i = 5; i < 15; i++) state = stepArcSleepPolicy(state, settings, { loadPercent: 50, nowMs: i + 3 }).state;
  assert.equal(state.adaptiveCapFps, 40);
  for (let i = 0; i < 15; i++) state = stepArcSleepPolicy(state, settings, { loadPercent: 90, nowMs: i + 20 }).state;
  assert.equal(state.adaptiveCapFps, 30);
});

test('missing load retains target for five seconds, then drops it until telemetry recovers', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 90 };
  let state = createArcSleepPolicyState(settings);
  let result = stepArcSleepPolicy(state, settings, { loadPercent: 50, nowMs: 1000 });
  state = result.state;
  result = stepArcSleepPolicy(state, settings, { loadPercent: null, nowMs: 1001 });
  assert.equal(result.targetFps, 90);
  result = stepArcSleepPolicy(result.state, settings, { loadPercent: null, nowMs: 6001 });
  assert.equal(result.targetFps, null);
  result = stepArcSleepPolicy(result.state, settings, { loadPercent: 50, nowMs: 6002 });
  assert.equal(result.targetFps, 90);
});

test('stable foreground FPS seeds the downward cap once per process', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 144, adaptiveTargetLoadPct: 85 };
  let state = createArcSleepPolicyState(settings);
  for (const fps of [69, 70, 71]) {
    state = stepArcSleepPolicy(state, settings, { loadPercent: 96, observedFps: fps, observedProcessId: 42 }).state;
  }
  assert.equal(state.adaptiveCapFps, 65);
  for (let index = 0; index < 3; index += 1) {
    state = stepArcSleepPolicy(state, settings, { loadPercent: 96, observedFps: 50, observedProcessId: 42 }).state;
  }
  assert.equal(state.adaptiveCapFps, 60);
  for (let index = 0; index < 3; index += 1) {
    state = stepArcSleepPolicy(state, settings, { loadPercent: 96, observedFps: 48, observedProcessId: 43 }).state;
  }
  assert.equal(state.adaptiveCapFps, 43);
});

test('missing, mixed-process, or noisy FPS keeps the gradual high-load step', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 144 };
  for (const observations of [
    [{}, {}, {}],
    [{ observedFps: 70, observedProcessId: 1 }, { observedFps: 70, observedProcessId: 2 }, { observedFps: 70, observedProcessId: 1 }],
    [{ observedFps: 40, observedProcessId: 1 }, { observedFps: 70, observedProcessId: 1 }, { observedFps: 100, observedProcessId: 1 }],
  ]) {
    let state = createArcSleepPolicyState(settings);
    for (const observation of observations) state = stepArcSleepPolicy(state, settings, { loadPercent: 99, ...observation }).state;
    assert.equal(state.adaptiveCapFps, 139);
  }
});

test('idle FPS cannot seed adaptive cap or complete an earlier candidate set', () => {
  const settings = { idleEnabled: true, idleAfterSeconds: 60, idleFps: 30, adaptiveEnabled: true };
  let state = createArcSleepPolicyState(settings);
  state = stepArcSleepPolicy(state, settings, { idleMs: 0, loadPercent: 99, observedFps: 70, observedProcessId: 12 }).state;
  state = stepArcSleepPolicy(state, settings, { idleMs: 60000, loadPercent: 99, observedFps: 30, observedProcessId: 12 }).state;
  state = stepArcSleepPolicy(state, settings, { idleMs: 0, loadPercent: 99, observedFps: 70, observedProcessId: 12 }).state;
  assert.equal(state.adaptiveCapFps, 139);
  for (let index = 0; index < 2; index += 1) {
    state = stepArcSleepPolicy(state, settings, { idleMs: 0, loadPercent: 99, observedFps: 70, observedProcessId: 12 }).state;
  }
  assert.equal(state.adaptiveCapFps, 139);
});

test('same inputs produce identical transitions without hidden time dependencies', () => {
  const settings = { idleEnabled: true, adaptiveEnabled: true };
  const state = createArcSleepPolicyState(settings);
  const sample = { idleMs: 100000, loadPercent: 99, nowMs: 2000 };
  assert.deepEqual(stepArcSleepPolicy(state, settings, sample), stepArcSleepPolicy(state, settings, sample));
});
