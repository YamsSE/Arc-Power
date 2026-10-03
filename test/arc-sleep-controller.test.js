import assert from 'node:assert/strict';
import test from 'node:test';
import { createArcSleepController } from '../src/main/arc-sleep-controller.js';

const sameState = (left, right) => left?.limit === right?.limit
  && left?.denominator === right?.denominator
  && left?.limiterEnabled === right?.limiterEnabled;

function harness({
  settings = {},
  baseFrameLimit = { enabled: false, value: 60 },
  state = { limit: 0, denominator: 1, limiterEnabled: false },
  underlay = state,
  idleSeconds = 0,
  loadSignals = { cpuUtilPct: null, gpuUtilPct: null },
  observedFps = null,
  now = () => 10000,
  unavailable = false,
  failNextApply = false,
  rtssOperationTimeoutMs = 5000,
  shutdownTimeoutMs = 5000,
} = {}) {
  let saved = {
    arcSleep: settings,
    arcSleepFrameLimitBase: baseFrameLimit,
    arcSleepJournal: null,
  };
  let current = { ...state };
  let initialUnderlay = { ...underlay };
  let isUnavailable = unavailable;
  let failNextRestorePartially = false;
  let failNextFrameLimitApply = failNextApply;
  let externalizeBeforeApply = null;
  let observedFpsCalls = 0;
  const saveHistory = [];
  const store = {
    async loadSettings() { return structuredClone(saved); },
    async saveArcSleepState(patch) {
      saveHistory.push(structuredClone(patch));
      saved = { ...saved, ...structuredClone(patch) };
    },
  };
  const rtssFrameLimiter = {
    async getFrameLimit() {
      return isUnavailable ? { ok: false, errorCode: 'unavailable' } : { ok: true, ...current };
    },
    async getFrameLimitOwnership() {
      return isUnavailable ? { ok: false, errorCode: 'unavailable' } : { ok: true, state: { ...current }, underlay: { ...initialUnderlay } };
    },
    async applyFrameLimit({ enabled, value, expectedState }) {
      if (isUnavailable) return { ok: false, used: false, available: false, errorCode: 'unavailable' };
      if (externalizeBeforeApply) {
        current = { ...externalizeBeforeApply({ enabled, value, current: { ...current } }) };
        externalizeBeforeApply = null;
      }
      if (expectedState && !sameState(current, expectedState)) return { ok: false, used: false, conflict: true, errorCode: 'external-change' };
      if (failNextFrameLimitApply) {
        failNextFrameLimitApply = false;
        return { ok: false, used: false, available: false, errorCode: 'unavailable' };
      }
      current = enabled
        ? { limit: value, denominator: 1, limiterEnabled: true }
        : { ...initialUnderlay };
      return { ok: true, used: true, restoreToken: { expectedLimit: current.limit, expectedDenominator: current.denominator, expectedEnabled: current.limiterEnabled } };
    },
    async restoreFrameLimitState({ expectedState, state: target }) {
      if (isUnavailable) return { ok: false, used: false, errorCode: 'unavailable' };
      if (!sameState(current, expectedState)) return { ok: false, used: false, conflict: true, errorCode: 'external-change' };
      if (failNextRestorePartially) {
        failNextRestorePartially = false;
        // Model RTSS committing its cap value before denominator/flag restore
        // fails. Startup must recognize this intermediate state as ours.
        current = { ...current, limit: target.limit };
        return { ok: false, used: false, errorCode: 'partial', error: 'Simulated partial RTSS restore' };
      }
      current = { ...target };
      return { ok: true, used: true, observedState: { ...current } };
    },
  };
  const createController = () => createArcSleepController({
      store,
      rtssFrameLimiter,
      getIdleSeconds: () => idleSeconds,
      getLoadSignals: async () => loadSignals,
      getObservedFps: async () => { observedFpsCalls += 1; return observedFps; },
      now,
      rtssOperationTimeoutMs,
      shutdownTimeoutMs,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
    });
  const controller = createController();
  return {
    controller,
    createController,
    store,
    rtssFrameLimiter,
    readState: () => ({ ...current }),
    setState: (next) => { current = { ...next }; },
    setUnderlay: (next) => { initialUnderlay = { ...next }; },
    setIdleSeconds: (value) => { idleSeconds = value; },
    setLoadSignals: (value) => { loadSignals = value; },
    setObservedFps: (value) => { observedFps = value; },
    observedFpsCalls: () => observedFpsCalls,
    setNow: (value) => { now = () => value; },
    setUnavailable: (value) => { isUnavailable = value; },
    setExternalizeBeforeApply: (callback) => { externalizeBeforeApply = callback; },
    failNextFrameLimitApply: () => { failNextFrameLimitApply = true; },
    failNextRestorePartially: () => { failNextRestorePartially = true; },
    savedSettings: () => structuredClone(saved),
    saveHistory,
  };
}

test('idle cap overlays the Graphics base cap and releases back to it', async (t) => {
  const h = harness({
    settings: { idleEnabled: true },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    idleSeconds: 400,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  assert.deepEqual(h.readState(), { limit: 30, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().policy, 'idle');

  await h.controller.withTransaction((transaction) => transaction.setSettings({ idleEnabled: false }));
  assert.deepEqual(h.readState(), { limit: 120, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().effectiveCapFps, 120);
});

test('Graphics base cap keeps the RTSS 1 FPS endpoint', async (t) => {
  const h = harness({
    baseFrameLimit: { enabled: true, value: 1 },
    state: { limit: 0, denominator: 1, limiterEnabled: false },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  assert.equal(h.controller.getSnapshot().baseCapFps, 1);
  assert.deepEqual(h.readState(), { limit: 1, denominator: 1, limiterEnabled: true });
});

test('adaptive cap releases to the saved underlay when load telemetry stays stale', async (t) => {
  let clock = 0;
  const h = harness({
    settings: { adaptiveEnabled: true },
    baseFrameLimit: { enabled: false, value: 60 },
    now: () => clock,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  assert.deepEqual(h.readState(), { limit: 144, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().policy, 'adaptive');

  clock = 5000;
  await h.controller.tick();
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: false });
  assert.equal(h.controller.getSnapshot().policy, null);
});

test('an external RTSS change stops Arc Sleep writes and preserves the new value', async (t) => {
  const h = harness({
    settings: { idleEnabled: true },
    idleSeconds: 400,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  h.setState({ limit: 58, denominator: 1, limiterEnabled: true });
  await h.controller.tick();
  assert.deepEqual(h.readState(), { limit: 58, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().status, 'external-change');
});

test('disabling policy preserves an outside RTSS cap instead of restoring the base', async (t) => {
  const h = harness({
    settings: { idleEnabled: true },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    idleSeconds: 400,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  h.setState({ limit: 58, denominator: 1, limiterEnabled: true });
  await h.store.saveArcSleepState({ arcSleep: { idleEnabled: false } });
  await h.controller.withTransaction((transaction) => transaction.setSettings({ idleEnabled: false }));

  assert.deepEqual(h.readState(), { limit: 58, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().status, 'external-change');
  assert.ok((await h.store.loadSettings()).arcSleepJournal, 'keep the journal so future writes remain guarded');
});

test('a policy that already matches the RTSS cap establishes an ownership journal', async (t) => {
  const h = harness({
    settings: { adaptiveEnabled: true },
    state: { limit: 144, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  const saved = await h.store.loadSettings();
  assert.deepEqual(saved.arcSleepJournal, {
    version: 1,
    baseline: { limit: 0, denominator: 1, limiterEnabled: false },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    expected: { limit: 144, denominator: 1, limiterEnabled: true },
    pending: null,
  });

  h.setState({ limit: 58, denominator: 1, limiterEnabled: true });
  await h.controller.tick();
  assert.deepEqual(h.readState(), { limit: 58, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().status, 'external-change');
});

test('a matching temporary target restores the configured base cap when policy turns off', async (t) => {
  const h = harness({
    settings: { adaptiveEnabled: true, adaptiveMinFps: 60, adaptiveMaxFps: 80 },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 80, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  await h.controller.withTransaction((transaction) => transaction.setSettings({ adaptiveEnabled: false }));
  assert.deepEqual(h.readState(), { limit: 120, denominator: 1, limiterEnabled: true });
});

test('a lower adaptive target restores the configured base cap instead of the startup cap', async (t) => {
  const h = harness({
    settings: { adaptiveEnabled: true, adaptiveMinFps: 30, adaptiveMaxFps: 35 },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 60, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    loadSignals: { cpuUtilPct: 100, gpuUtilPct: 100 },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  await h.controller.tick();
  await h.controller.tick();
  assert.equal(h.readState().limit, 30);
  await h.controller.withTransaction((transaction) => transaction.setSettings({ adaptiveEnabled: false }));

  assert.deepEqual(h.readState(), { limit: 120, denominator: 1, limiterEnabled: true });
});

test('adaptive cap responds to GPU load even when CPU load disagrees', async (t) => {
  const h = harness({
    settings: { adaptiveEnabled: true, adaptiveMinFps: 60, adaptiveMaxFps: 80 },
    loadSignals: { cpuUtilPct: 100, gpuUtilPct: 10 },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  for (let sample = 0; sample < 6; sample += 1) await h.controller.tick();
  assert.equal(h.readState().limit, 80);

  h.setLoadSignals({ cpuUtilPct: 0, gpuUtilPct: 100 });
  for (let sample = 0; sample < 3; sample += 1) await h.controller.tick();
  assert.equal(h.readState().limit, 75);
});

test('controller reads foreground FPS only under high GPU load and seeds once', async (t) => {
  const h = harness({
    settings: { adaptiveEnabled: true },
    loadSignals: { gpuUtilPct: 50 },
    observedFps: { fps: 70, processId: 7 },
  });
  t.after(() => h.controller.stop());
  await h.controller.start();
  assert.equal(h.observedFpsCalls(), 0);
  h.setLoadSignals({ gpuUtilPct: 96 });
  for (let index = 0; index < 3; index += 1) await h.controller.tick();
  assert.equal(h.observedFpsCalls(), 3);
  assert.equal(h.readState().limit, 65);
  h.setObservedFps({ fps: 50, processId: 7 });
  for (let index = 0; index < 3; index += 1) await h.controller.tick();
  assert.equal(h.readState().limit, 60);
});

test('controller does not observe capped FPS while idle cap is active', async (t) => {
  const h = harness({
    settings: { idleEnabled: true, adaptiveEnabled: true },
    loadSignals: { gpuUtilPct: 99 },
    observedFps: { fps: 30, processId: 7 },
    idleSeconds: 400,
  });
  t.after(() => h.controller.stop());
  await h.controller.start();
  await h.controller.tick();
  await h.controller.tick();
  assert.equal(h.observedFpsCalls(), 0);
  h.setIdleSeconds(0);
  h.setObservedFps({ fps: 70, processId: 7 });
  for (let index = 0; index < 3; index += 1) await h.controller.tick();
  assert.equal(h.observedFpsCalls(), 3);
  assert.equal(h.readState().limit, 65);
});

test('high CPU cannot sustain an adaptive cap when GPU telemetry disappears', async (t) => {
  let clock = 10000;
  const h = harness({
    settings: { adaptiveEnabled: true, adaptiveMinFps: 60, adaptiveMaxFps: 80 },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    loadSignals: { cpuUtilPct: 0, gpuUtilPct: 100 },
    now: () => clock,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  await h.controller.tick();
  await h.controller.tick();
  assert.equal(h.readState().limit, 75);

  h.setLoadSignals({ cpuUtilPct: 100, gpuUtilPct: null });
  await h.controller.tick();
  clock += 4999;
  await h.controller.tick();
  assert.equal(h.readState().limit, 75);
  clock += 1;
  await h.controller.tick();
  assert.deepEqual(h.readState(), { limit: 120, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().policy, null);
});

test('startup recovery recognizes an interrupted multi-field RTSS restore', async (t) => {
  const h = harness({
    baseFrameLimit: { enabled: false, value: 60 },
    state: { limit: 0, denominator: 1, limiterEnabled: true },
  });
  const baseline = { limit: 0, denominator: 1, limiterEnabled: false };
  await h.store.saveArcSleepState({
    arcSleepJournal: {
      version: 1,
      baseline,
      underlay: baseline,
      expected: { limit: 30, denominator: 1, limiterEnabled: true },
      pending: {
        from: { limit: 30, denominator: 1, limiterEnabled: true },
        to: baseline,
      },
    },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  assert.deepEqual(h.readState(), baseline);
  assert.equal((await h.store.loadSettings()).arcSleepJournal, null);
});

test('disabling the base cap during an idle override restores the original RTSS underlay', async (t) => {
  const h = harness({
    settings: { idleEnabled: true },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    idleSeconds: 400,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  const applied = await h.controller.withTransaction((transaction) => transaction.setBaseFrameLimit({ enabled: false, value: 120 }));
  assert.equal(applied.handled, true);
  await h.controller.withTransaction((transaction) => transaction.setSettings({ idleEnabled: false }));
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: false });
});

test('RTSS outage keeps an existing recovery journal for retry', async (t) => {
  const h = harness({
    state: { limit: 30, denominator: 1, limiterEnabled: true },
  });
  const baseline = { limit: 0, denominator: 1, limiterEnabled: false };
  await h.store.saveArcSleepState({
    arcSleepJournal: {
      version: 1,
      baseline,
      underlay: baseline,
      expected: { limit: 30, denominator: 1, limiterEnabled: true },
      pending: null,
    },
  });
  h.setUnavailable(true);
  t.after(() => h.controller.stop());

  await h.controller.start();
  const saved = await h.store.loadSettings();
  assert.ok(saved.arcSleepJournal);
  assert.equal(h.controller.getSnapshot().status, 'recovery-pending');
});

test('disabling policy journals a partial restore so startup can finish it', async (t) => {
  const h = harness({ settings: { idleEnabled: true }, idleSeconds: 400 });
  const recovery = h.createController();
  t.after(async () => {
    await h.controller.stop();
    await recovery.stop();
  });

  await h.controller.start();
  h.failNextRestorePartially();
  await h.store.saveArcSleepState({ arcSleep: { idleEnabled: false } });
  await h.controller.withTransaction((transaction) => transaction.setSettings({ idleEnabled: false }));

  const interrupted = await h.store.loadSettings();
  assert.deepEqual(interrupted.arcSleepJournal.pending, {
    from: { limit: 30, denominator: 1, limiterEnabled: true },
    to: { limit: 0, denominator: 1, limiterEnabled: false },
  });
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: true });

  await recovery.start();
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: false });
  assert.equal((await h.store.loadSettings()).arcSleepJournal, null);
});

test('shutdown journals a partial restore so the next startup can recover before reapplying policy', async (t) => {
  const h = harness({ settings: { idleEnabled: true }, idleSeconds: 400 });
  const recovery = h.createController();
  t.after(async () => {
    await h.controller.stop();
    await recovery.stop();
  });

  await h.controller.start();
  h.failNextRestorePartially();
  await h.controller.stop();

  const interrupted = await h.store.loadSettings();
  assert.deepEqual(interrupted.arcSleepJournal.pending, {
    from: { limit: 30, denominator: 1, limiterEnabled: true },
    to: { limit: 0, denominator: 1, limiterEnabled: false },
  });
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: true });

  await recovery.start();
  assert.deepEqual(h.readState(), { limit: 30, denominator: 1, limiterEnabled: true });
  assert.equal(recovery.getSnapshot().policy, 'idle');
  const recoveredJournal = (await h.store.loadSettings()).arcSleepJournal;
  assert.equal(recoveredJournal.pending, null);
  assert.deepEqual(recoveredJournal.expected, { limit: 30, denominator: 1, limiterEnabled: true });
});

test('shutdown during startup prevents the delayed tick timer from being installed', async () => {
  let releaseLoad;
  let markLoadStarted;
  const loadStarted = new Promise((resolve) => { markLoadStarted = resolve; });
  const loadGate = new Promise((resolve) => { releaseLoad = resolve; });
  const store = {
    async loadSettings() {
      markLoadStarted();
      await loadGate;
      return { arcSleep: {}, arcSleepFrameLimitBase: { enabled: false, value: 60 }, arcSleepJournal: null };
    },
    async saveArcSleepState() {},
  };
  const rtssFrameLimiter = {
    async getFrameLimit() { return { ok: true, limit: 0, denominator: 1, limiterEnabled: false }; },
  };
  let intervalCount = 0;
  const controller = createArcSleepController({
    store,
    rtssFrameLimiter,
    setIntervalFn: () => { intervalCount += 1; return intervalCount; },
    clearIntervalFn: () => {},
  });

  const starting = controller.start();
  await loadStarted;
  const stopping = controller.stop();
  releaseLoad();
  await Promise.all([starting, stopping]);
  assert.equal(intervalCount, 0);
});

test('a hanging startup RTSS read settles the UI and keeps queued work serialized', async () => {
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  let readCount = 0;
  let intervalCount = 0;
  let scheduledTick;
  const store = {
    async loadSettings() { return { arcSleep: {}, arcSleepFrameLimitBase: { enabled: false, value: 60 }, arcSleepJournal: null }; },
    async saveArcSleepState() {},
  };
  const controller = createArcSleepController({
    store,
    rtssFrameLimiter: {
      async getFrameLimit() {
        readCount += 1;
        if (readCount === 1) await readGate;
        return { ok: true, limit: 0, denominator: 1, limiterEnabled: false };
      },
    },
    rtssOperationTimeoutMs: 5,
    setIntervalFn: (callback) => { intervalCount += 1; scheduledTick = callback; return intervalCount; },
    clearIntervalFn: () => {},
  });

  await controller.start();
  assert.equal(intervalCount, 1);
  assert.equal(controller.getSnapshot().status, 'error');
  assert.match(controller.getSnapshot().message, /waiting for RTSS to respond/i);

  let tickFinished = false;
  const tickOperation = controller.tick();
  const tick = tickOperation.then(() => { tickFinished = true; });
  const coalescedTick = controller.tick();
  assert.strictEqual(coalescedTick, tickOperation, 'concurrent tick requests must share one queued operation');
  scheduledTick();
  scheduledTick();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tickFinished, false);
  assert.equal(readCount, 1, 'queued reads must not overlap the unresolved native read');

  releaseRead();
  await tick;
  await controller.stop();
});

test('shutdown wait is bounded while a stalled RTSS read keeps its recovery journal', async (t) => {
  let releaseRead;
  const h = harness({
    settings: { idleEnabled: true },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    idleSeconds: 400,
    shutdownTimeoutMs: 10,
  });
  t.after(async () => {
    releaseRead?.();
    await h.controller.stop();
  });

  await h.controller.start();
  assert.ok(h.savedSettings().arcSleepJournal);

  const originalGetFrameLimit = h.rtssFrameLimiter.getFrameLimit.bind(h.rtssFrameLimiter);
  let markReadStarted;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  h.rtssFrameLimiter.getFrameLimit = async () => {
    markReadStarted();
    await readGate;
    return originalGetFrameLimit();
  };
  const tick = h.controller.tick();
  await readStarted;
  await h.controller.stop();
  assert.equal(h.controller.getSnapshot().status, 'recovery-pending');
  assert.ok(h.savedSettings().arcSleepJournal, 'the saved recovery journal survives the shutdown timeout');

  releaseRead();
  await tick;
  await h.controller.stop();
  assert.equal(h.savedSettings().arcSleepJournal, null, 'serialized shutdown finishes recovery when RTSS returns');
});

test('late RTSS availability captures the existing base cap before adaptive policy can raise it', async (t) => {
  const h = harness({
    settings: { adaptiveEnabled: true },
    baseFrameLimit: null,
    state: { limit: 60, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    loadSignals: { cpuUtilPct: 10, gpuUtilPct: 100 },
    unavailable: true,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  assert.equal(h.controller.getSnapshot().baseFrameLimit, null);
  h.setUnavailable(false);
  await h.controller.tick();

  assert.equal(h.controller.getSnapshot().baseCapFps, 60);
  assert.deepEqual(h.readState(), { limit: 60, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().effectiveCapFps, 60);
});

test('RTSS outage clears the reported effective cap instead of displaying stale state', async (t) => {
  const h = harness({
    baseFrameLimit: { enabled: true, value: 60 },
    state: { limit: 60, denominator: 1, limiterEnabled: true },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  assert.equal(h.controller.getSnapshot().effectiveCapFps, 60);
  h.setUnavailable(true);
  await h.controller.tick();

  assert.equal(h.controller.getSnapshot().rtssAvailable, false);
  assert.equal(h.controller.getSnapshot().effectiveCapFps, null);
});

test('base setting and active-policy recovery baseline recover atomically after an interrupted cap write', async (t) => {
  const h = harness({
    settings: { idleEnabled: true },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    idleSeconds: 400,
  });
  const recovery = h.createController();
  t.after(async () => {
    await h.controller.stop();
    await recovery.stop();
  });

  await h.controller.start();
  h.saveHistory.length = 0;
  h.failNextFrameLimitApply();
  const changed = await h.controller.withTransaction((transaction) => transaction.setBaseFrameLimit({ enabled: true, value: 20 }));
  assert.equal(changed.handled, false);
  assert.ok(h.saveHistory.some((patch) => Object.hasOwn(patch, 'arcSleepFrameLimitBase')
    && Object.hasOwn(patch, 'arcSleepJournal')
    && patch.arcSleepJournal?.baseline.limit === 20));
  assert.equal(h.savedSettings().arcSleepFrameLimitBase.value, 20);
  assert.deepEqual(h.savedSettings().arcSleepJournal.pending, {
    from: { limit: 30, denominator: 1, limiterEnabled: true },
    to: { limit: 20, denominator: 1, limiterEnabled: true },
  });

  await recovery.start();
  assert.deepEqual(h.readState(), { limit: 20, denominator: 1, limiterEnabled: true });
  assert.equal(h.savedSettings().arcSleepJournal.expected.limit, 20);
});

test('a no-policy base disable leaves a durable transition before RTSS writes', async (t) => {
  const h = harness({
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    failNextApply: true,
  });
  const recovery = h.createController();
  t.after(async () => {
    await h.controller.stop();
    await recovery.stop();
  });

  await h.controller.start();
  const result = await h.controller.withTransaction((transaction) => transaction.setBaseFrameLimit({ enabled: false, value: 120 }));
  assert.equal(result.handled, false);
  const interrupted = h.savedSettings();
  assert.deepEqual(interrupted.arcSleepFrameLimitBase, { enabled: false, value: 120 });
  assert.deepEqual(interrupted.arcSleepJournal.pending, {
    from: { limit: 120, denominator: 1, limiterEnabled: true },
    to: { limit: 0, denominator: 1, limiterEnabled: false },
  });

  await recovery.start();
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: false });
  assert.equal(h.savedSettings().arcSleepJournal, null);
});

test('a base disable requested during an RTSS outage runs when RTSS returns in the same session', async (t) => {
  const h = harness({
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: true },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  h.setUnavailable(true);
  const result = await h.controller.withTransaction((transaction) => transaction.setBaseFrameLimit({ enabled: false, value: 120 }));
  assert.equal(result.handled, false);
  assert.equal(h.savedSettings().arcSleepPendingBaseDisable, true);
  assert.deepEqual(h.savedSettings().arcSleepPendingBaseDisableExpected, {
    limit: 120,
    denominator: 1,
    limiterEnabled: true,
  });

  h.setUnavailable(false);
  await h.controller.tick();
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: true });
  assert.equal(h.savedSettings().arcSleepPendingBaseDisable, false);
  assert.equal(h.savedSettings().arcSleepJournal, null);
});

test('a deferred base disable preserves an RTSS cap changed during the outage', async (t) => {
  const h = harness({
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: true },
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  h.setUnavailable(true);
  await h.controller.withTransaction((transaction) => transaction.setBaseFrameLimit({ enabled: false, value: 120 }));
  h.setState({ limit: 58, denominator: 1, limiterEnabled: true });
  h.setUnavailable(false);
  await h.controller.tick();

  assert.deepEqual(h.readState(), { limit: 58, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().status, 'external-change');
  assert.equal(h.savedSettings().arcSleepPendingBaseDisable, false);
  assert.equal(h.savedSettings().arcSleepJournal.externalChange, true);
});

test('a deferred base disable waits for the active policy journal to recover first', async (t) => {
  const h = harness({
    settings: { idleEnabled: true },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    idleSeconds: 400,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  assert.equal(h.readState().limit, 30);
  h.setUnavailable(true);
  await h.controller.withTransaction((transaction) => transaction.setSettings({ idleEnabled: false }));
  await h.controller.withTransaction((transaction) => transaction.setBaseFrameLimit({ enabled: false, value: 120 }));
  assert.equal(h.savedSettings().arcSleepPendingBaseDisable, true);
  assert.equal(h.savedSettings().arcSleepPendingBaseDisableExpected.limit, 0);

  h.setUnavailable(false);
  await h.controller.tick();
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: false });
  assert.equal(h.savedSettings().arcSleepPendingBaseDisable, false);
  assert.equal(h.controller.getSnapshot().status, 'disabled');
});

test('rollback keeps the prior base cap and durable recovery when RTSS disappears', async (t) => {
  const h = harness({
    baseFrameLimit: { enabled: false, value: 60 },
    state: { limit: 0, denominator: 1, limiterEnabled: false },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
  });
  const recovery = h.createController();
  t.after(async () => {
    await h.controller.stop();
    await recovery.stop();
  });

  await h.controller.start();
  const changed = await h.controller.withTransaction((transaction) => transaction.setBaseFrameLimit({ enabled: true, value: 120 }));
  assert.equal(changed.handled, true);
  assert.deepEqual(h.readState(), { limit: 120, denominator: 1, limiterEnabled: true });
  h.setUnavailable(true);
  const rollback = await changed.rollback();
  assert.equal(rollback.ok, false);
  assert.deepEqual(h.savedSettings().arcSleepFrameLimitBase, { enabled: false, value: 60 });
  assert.deepEqual(h.savedSettings().arcSleepJournal.baseline, { limit: 0, denominator: 1, limiterEnabled: false });

  h.setUnavailable(false);
  await recovery.start();
  assert.deepEqual(h.readState(), { limit: 0, denominator: 1, limiterEnabled: false });
});

test('a conditional-apply conflict at the exact policy target latches the outside RTSS state', async (t) => {
  const h = harness({
    settings: { idleEnabled: true },
    idleSeconds: 400,
  });
  t.after(() => h.controller.stop());
  h.setExternalizeBeforeApply(({ value }) => ({ limit: value, denominator: 1, limiterEnabled: true }));

  await h.controller.start();
  assert.deepEqual(h.readState(), { limit: 30, denominator: 1, limiterEnabled: true });
  assert.equal(h.controller.getSnapshot().status, 'external-change');
  assert.equal(h.savedSettings().arcSleepJournal.externalChange, true);

  await h.controller.tick();
  await h.controller.stop();
  assert.deepEqual(h.readState(), { limit: 30, denominator: 1, limiterEnabled: true });

  const restarted = h.createController();
  t.after(() => restarted.stop());
  await restarted.start();
  assert.deepEqual(h.readState(), { limit: 30, denominator: 1, limiterEnabled: true });
  assert.equal(restarted.getSnapshot().status, 'external-change');
});

test('Graphics rollback preserves an outside RTSS write that matches the requested cap', async (t) => {
  const h = harness({
    settings: { idleEnabled: true },
    baseFrameLimit: { enabled: true, value: 120 },
    state: { limit: 120, denominator: 1, limiterEnabled: true },
    underlay: { limit: 0, denominator: 1, limiterEnabled: false },
    idleSeconds: 400,
  });
  t.after(() => h.controller.stop());

  await h.controller.start();
  h.setExternalizeBeforeApply(({ value }) => ({ limit: value, denominator: 1, limiterEnabled: true }));
  const change = await h.controller.withTransaction((transaction) => transaction.setBaseFrameLimit({ enabled: true, value: 20 }));
  assert.equal(change.handled, false);
  const rollback = await change.rollback();

  assert.equal(rollback.ok, false);
  assert.deepEqual(h.readState(), { limit: 20, denominator: 1, limiterEnabled: true });
  assert.deepEqual(h.savedSettings().arcSleepFrameLimitBase, { enabled: true, value: 120 });
  assert.equal(h.savedSettings().arcSleepJournal.externalChange, true);
});
