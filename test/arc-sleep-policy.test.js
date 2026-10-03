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
  assert.equal(result.adaptiveTargetFps, 93);
  result = stepArcSleepPolicy(result.state, settings, { idleMs: 0, loadPercent: 99, nowMs: 300 });
  assert.equal(result.targetFps, 93);
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

test('live foreground FPS can reposition the cap again when the same game enters a heavier scene', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 144, adaptiveTargetLoadPct: 85 };
  let state = createArcSleepPolicyState(settings);
  for (const fps of [119, 120, 121]) {
    state = stepArcSleepPolicy(state, settings, { loadPercent: 96, observedFps: fps, observedProcessId: 42 }).state;
  }
  assert.equal(state.adaptiveCapFps, 119);
  for (const fps of [74, 75, 76]) {
    const result = stepArcSleepPolicy(state, settings, { loadPercent: 96, observedFps: fps, observedProcessId: 42 });
    state = result.state;
    if (fps === 76) assert.equal(result.observedFpsAdjustmentApplied, true);
  }
  assert.equal(state.adaptiveCapFps, 75);
  for (let index = 0; index < 3; index += 1) {
    const result = stepArcSleepPolicy(state, settings, { loadPercent: 96, observedFps: 69, observedProcessId: 42 });
    state = result.state;
    assert.equal(result.observedFpsAdjustmentApplied, false);
  }
  assert.equal(state.adaptiveCapFps, 70, 'confirmed near-cap FPS must use only the five-FPS step');
});

test('missing FPS uses range-based steps and a later trustworthy FPS can seed immediately', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 144 };
  let state = createArcSleepPolicyState(settings);
  for (let index = 0; index < 3; index += 1) state = stepArcSleepPolicy(state, settings, { loadPercent: 86 }).state;
  assert.equal(state.adaptiveCapFps, 133);
  const seeded = stepArcSleepPolicy(state, settings, { loadPercent: 86, observedFps: 70, observedProcessId: 1 });
  assert.equal(seeded.state.adaptiveCapFps, 70);
  assert.equal(seeded.observedFpsAdjustmentApplied, true);
  state = seeded.state;
  for (let index = 0; index < 3; index += 1) state = stepArcSleepPolicy(state, settings, { loadPercent: 86, observedFps: 68, observedProcessId: 1 }).state;
  assert.equal(state.adaptiveCapFps, 65, 'near-cap readings must not trigger another immediate seed');
});

test('wide adaptive ranges converge under sustained high load without one-tick jumps', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 500, adaptiveTargetLoadPct: 85 };
  let state = createArcSleepPolicyState(settings);
  for (let index = 0; index < 47; index += 1) {
    const next = stepArcSleepPolicy(state, settings, { loadPercent: 86 });
    assert.ok(state.adaptiveCapFps - next.state.adaptiveCapFps <= 30);
    state = next.state;
  }
  assert.equal(state.adaptiveCapFps, 50);
  state = stepArcSleepPolicy(state, settings, { loadPercent: 86 }).state;
  assert.equal(state.adaptiveCapFps, 30);
  const atTarget = stepArcSleepPolicy(state, settings, { loadPercent: 85 });
  assert.equal(atTarget.state.aboveTargetSamples, 0);
});

test('first eligible FPS and a new foreground process seed immediately at any load above target', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 500, adaptiveTargetLoadPct: 95 };
  let result = stepArcSleepPolicy(createArcSleepPolicyState(settings), settings,
    { loadPercent: 100, observedFps: 120, observedProcessId: 7 });
  assert.equal(result.state.adaptiveCapFps, 120);
  assert.equal(result.observedFpsAdjustmentApplied, true);
  result = stepArcSleepPolicy(result.state, settings,
    { loadPercent: 100, observedFps: 116, observedProcessId: 7 });
  assert.equal(result.state.adaptiveCapFps, 120);
  assert.equal(result.observedFpsAdjustmentApplied, false);
  result = stepArcSleepPolicy(result.state, settings,
    { loadPercent: 100, observedFps: 80, observedProcessId: 8 });
  assert.equal(result.state.adaptiveCapFps, 80);
  assert.equal(result.observedFpsAdjustmentApplied, true);
});

test('an observation gap lets the same process seed again and mixed windows use the small step', () => {
  const settings = { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 500 };
  let state = stepArcSleepPolicy(createArcSleepPolicyState(settings), settings,
    { loadPercent: 99, observedFps: 120, observedProcessId: 7 }).state;
  state = stepArcSleepPolicy(state, settings, { loadPercent: 99, observedFps: 118, observedProcessId: 7 }).state;
  state = stepArcSleepPolicy(state, settings, { loadPercent: 99 }).state;
  assert.equal(state.observedFpsSeeded, false);
  assert.equal(state.adaptiveCapFps, 120);
  state = stepArcSleepPolicy(state, settings, { loadPercent: 99, observedFps: 117, observedProcessId: 7 }).state;
  assert.equal(state.adaptiveCapFps, 115, 'a mixed valid/missing window uses the small step');
  state = stepArcSleepPolicy(state, settings, { loadPercent: 99 }).state;
  const resumed = stepArcSleepPolicy(state, settings, { loadPercent: 99, observedFps: 90, observedProcessId: 7 });
  assert.equal(resumed.state.adaptiveCapFps, 90);
  assert.equal(resumed.observedFpsAdjustmentApplied, true);
});

test('idle FPS cannot seed adaptive cap or complete an earlier candidate set', () => {
  const settings = { idleEnabled: true, idleAfterSeconds: 60, idleFps: 30, adaptiveEnabled: true };
  let state = createArcSleepPolicyState(settings);
  state = stepArcSleepPolicy(state, settings, { idleMs: 0, loadPercent: 99, observedFps: 70, observedProcessId: 12 }).state;
  state = stepArcSleepPolicy(state, settings, { idleMs: 60000, loadPercent: 99, observedFps: 30, observedProcessId: 12 }).state;
  state = stepArcSleepPolicy(state, settings, { idleMs: 0, loadPercent: 99, observedFps: 70, observedProcessId: 12 }).state;
  assert.equal(state.adaptiveCapFps, 70);
  for (let index = 0; index < 2; index += 1) {
    state = stepArcSleepPolicy(state, settings, { idleMs: 0, loadPercent: 99, observedFps: 70, observedProcessId: 12 }).state;
  }
  assert.equal(state.adaptiveCapFps, 65);
});

test('same inputs produce identical transitions without hidden time dependencies', () => {
  const settings = { idleEnabled: true, adaptiveEnabled: true };
  const state = createArcSleepPolicyState(settings);
  const sample = { idleMs: 100000, loadPercent: 99, nowMs: 2000 };
  assert.deepEqual(stepArcSleepPolicy(state, settings, sample), stepArcSleepPolicy(state, settings, sample));
});
