import assert from 'node:assert/strict';
import test from 'node:test';
import { createIpcHandlers } from '../src/main/ipc-core.js';

function createTaskStartupSaveHarness() {
  let settings = {
    waiverAccepted: false,
    ocOnBoot: false,
    activeProfileId: null,
    activeProfileIds: {},
    ocMode: 'stock',
    advancedModeAccepted: false,
    startWithWindows: false,
    startMinimized: false,
    closeToTray: false,
    monitorLogToFile: false,
    deviceId: null,
    deviceKey: null,
    theme: 'dark',
    arcSleep: {
      idleEnabled: true,
      adaptiveEnabled: true,
      idleAfterSeconds: 300,
      idleFps: 30,
      adaptiveMinFps: 60,
      adaptiveMaxFps: 144,
      adaptiveTargetLoadPct: 85,
    },
  };
  const applied = [];
  const startupError = new Error('task registration failed');
  const handlers = createIpcHandlers({
    backend: {},
    store: {
      async loadSettings() { return structuredClone(settings); },
      async loadProfiles() { return []; },
      async saveSettings(next) { settings = structuredClone(next); },
      async saveSettingsWithArcSleep(next, arcSleep) {
        settings = { ...structuredClone(next), arcSleep: structuredClone(arcSleep) };
        return structuredClone(settings);
      },
    },
    emit: () => {},
    startup: {
      registrationMode: 'task',
      async set() { throw startupError; },
    },
    arcSleepController: {
      async withTransaction(work) {
        return work({ async setSettings(next) { applied.push(structuredClone(next)); } });
      },
    },
  }).handlers;
  return {
    handlers,
    applied,
    startupError,
    loadSettings: async () => structuredClone(settings),
  };
}

test('Arc Sleep policy toggles turn off despite packaged startup task registration failure', async () => {
  const harness = createTaskStartupSaveHarness();

  const result = await harness.handlers['profiles-settings-save']({
    arcSleep: { idleEnabled: false, adaptiveEnabled: false },
  });

  assert.equal(result.arcSleep.idleEnabled, false);
  assert.equal(result.arcSleep.adaptiveEnabled, false);
  assert.equal((await harness.loadSettings()).arcSleep.idleEnabled, false);
  assert.equal((await harness.loadSettings()).arcSleep.adaptiveEnabled, false);
  assert.deepEqual(harness.applied, [result.arcSleep]);
});

test('startup task registration failure remains reported when startup intent changes', async () => {
  const harness = createTaskStartupSaveHarness();

  await assert.rejects(
    harness.handlers['profiles-settings-save']({ startWithWindows: true }),
    harness.startupError,
  );
  assert.equal((await harness.loadSettings()).startWithWindows, true);
});

test('OC-locked GPU waiver is not required and acceptance touches neither driver nor settings', async () => {
  let driverCalls = 0;
  let storeWrites = 0;
  const handlers = createIpcHandlers({
    backend: {
      async getCapabilities() { return { overclockingSupported: false, waiverAccepted: false }; },
      async setWaiverAccepted() { driverCalls += 1; },
    },
    store: {
      async loadSettings() { return { waiverAccepted: false }; },
      async saveSettings() { storeWrites += 1; },
    },
    emit: () => {},
  }).handlers;

  assert.deepEqual(await handlers['waiver-get'](0), { accepted: false, required: false });
  assert.deepEqual(await handlers['waiver-accept'](0), { accepted: false, required: false });
  assert.equal(driverCalls, 0);
  assert.equal(storeWrites, 0);
});

test('waiver remains an explicit requirement on OC-capable GPUs', async () => {
  let driverCalls = 0;
  let persisted = null;
  const handlers = createIpcHandlers({
    backend: {
      async getCapabilities() { return { overclockingSupported: true, waiverAccepted: false }; },
      async setWaiverAccepted() { driverCalls += 1; },
    },
    store: {
      async loadSettings() { return {}; },
      async saveSettings(settings) { persisted = settings; },
    },
    emit: () => {},
  }).handlers;

  assert.deepEqual(await handlers['waiver-get'](0), { accepted: false, required: true });
  assert.deepEqual(await handlers['waiver-accept'](0), { accepted: true, required: true });
  assert.equal(driverCalls, 1);
  assert.equal(persisted.waiverAccepted, true);
});

test('update download progress is emitted to the renderer while the download runs', async () => {
  const progressEvents = [];
  let receivedArguments = null;
  const handlers = createIpcHandlers({
    backend: {},
    store: { async loadSettings() { return {}; } },
    emit(channel, payload) { progressEvents.push({ channel, payload }); },
    buildKind: 'portable',
    updateDownloadOperation: async (url, onProgress, buildKind) => {
      receivedArguments = { url, buildKind };
      onProgress(42.6);
      return 'C:\\Users\\Tester\\AppData\\Local\\Temp\\arc-power-updates\\Arc-Power_Portable.exe';
    },
  }).handlers;

  const result = await handlers['update:download']('https://github.com/YamsSE/Arc-Power/releases/download/v1.2.3/Arc-Power_Portable.exe');

  assert.equal(result.ok, true);
  assert.equal(receivedArguments.buildKind, 'portable');
  assert.deepEqual(progressEvents, [{ channel: 'update:download-progress', payload: { percent: 43 } }]);
});

test('profiles settings save normalizes Arc Sleep and applies it inside its RTSS transaction', async () => {
  let settings = {
    waiverAccepted: false,
    ocOnBoot: false,
    activeProfileId: null,
    ocMode: 'stock',
    advancedModeAccepted: false,
    startWithWindows: false,
    startMinimized: false,
    closeToTray: false,
    monitorLogToFile: false,
    deviceId: null,
    deviceKey: null,
    theme: 'dark',
    arcSleep: {
      idleEnabled: false,
      adaptiveEnabled: false,
      idleAfterSeconds: 300,
      idleFps: 30,
      adaptiveMinFps: 60,
      adaptiveMaxFps: 144,
      adaptiveTargetLoadPct: 85,
    },
  };
  const applied = [];
  let writes = 0;
  const store = {
    async loadSettings() { return structuredClone(settings); },
    async loadProfiles() { return []; },
    async saveSettings(next) { settings = structuredClone(next); },
    async saveSettingsWithArcSleep(next, arcSleep) {
      writes += 1;
      settings = { ...structuredClone(next), arcSleep: structuredClone(arcSleep) };
      return structuredClone(settings);
    },
  };
  const arcSleepController = {
    async withTransaction(work) {
      applied.push('locked');
      const result = await work({
        async setSettings(next) { applied.push(next); },
      });
      applied.push('unlocked');
      return result;
    },
  };
  const handlers = createIpcHandlers({
    backend: {},
    store,
    emit: () => {},
    arcSleepController,
  }).handlers;

  const result = await handlers['profiles-settings-save']({
    arcSleep: {
      idleEnabled: true,
      adaptiveEnabled: true,
      idleAfterSeconds: 0,
      idleFps: 18,
      adaptiveMinFps: 90,
      adaptiveMaxFps: 240,
      adaptiveTargetLoadPct: 88,
    },
  });

  assert.equal(writes, 1);
  assert.deepEqual(result.arcSleep, {
    idleEnabled: true,
    adaptiveEnabled: true,
    idleAfterSeconds: 60,
    idleFps: 18,
    adaptiveMinFps: 90,
    adaptiveMaxFps: 240,
    adaptiveTargetLoadPct: 88,
  });
  assert.deepEqual(applied, ['locked', result.arcSleep, 'unlocked']);
  assert.deepEqual((await store.loadSettings()).arcSleep, result.arcSleep);
});

test('Arc Sleep runtime state IPC reads the direct snapshot while RTSS work is stalled', async () => {
  const snapshot = {
    rtssAvailable: false,
    baseCapFps: null,
    baseFrameLimit: { enabled: false, value: 60 },
    effectiveCapFps: null,
    policy: null,
    status: 'rtss-unavailable',
    message: 'RTSS is unavailable.',
  };
  let transactionReads = 0;
  const handlers = createIpcHandlers({
    backend: {},
    store: { loadSettings: async () => ({}) },
    emit: () => {},
    arcSleepController: {
      getSnapshot: () => snapshot,
      async withTransaction() { transactionReads += 1; return new Promise(() => {}); },
    },
  }).handlers;

  assert.strictEqual(await handlers['arc-sleep-state-get'](), snapshot);
  assert.equal(transactionReads, 0);
  await assert.rejects(() => handlers['arc-sleep-state-get']('unexpected'), /takes no payload/);
});

test('system stats holder readiness waits for explicit no-device selection and preserves prior hooks', async () => {
  const calls = [];
  const holder = { current: null, onReady: () => calls.push('previous') };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {},
    store: { loadSettings: async () => ({}) },
    emit: () => {},
    sysStats: holder,
    onSysStatsReady: () => calls.push('arc-sleep'),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
  });
  try {
    holder.current = {};
    holder.onReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [], 'adapter readiness waits for renderer selection or explicit no-device mode');
    await handlers['telemetry-start'](null);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['previous', 'arc-sleep']);
  } finally {
    await stopAllTelemetry();
  }
});

test('system stats readiness reapplies the selected GPU before reconciliation samples', async () => {
  const targetB = {
    id: 1,
    name: 'Intel Arc B580',
    deviceKey: 'pnp:gpu-b',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B',
  };
  const calls = [];
  const holder = { current: null };
  let selectedTarget = null;
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetB]; },
      async getDeviceTarget() { return targetB; },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['arcSleepReady', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: {
      async sampleForTarget() { return {}; },
    },
    emit: () => {},
  });

  try {
    await handlers['telemetry-start'](1);
    calls.length = 0;
    selectedTarget = {
      id: 0,
      deviceKey: 'pnp:gpu-a',
      name: 'Intel Arc A750',
    };
    holder.current = {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        const sampledDeviceKey = selectedTarget?.deviceKey ?? null;
        calls.push(['adapterSample', sampledDeviceKey]);
        return { sampledDeviceKey };
      },
    };
    holder.onReady();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls.slice(0, 3), [
      ['setTarget', 'pnp:gpu-b'],
      ['arcSleepReady', 'pnp:gpu-b'],
      ['adapterSample', 'pnp:gpu-b'],
    ]);
  } finally {
    await stopAllTelemetry();
  }
});

test('system stats readiness first waits for persisted selected GPU boot target', async () => {
  const targetA = { id: 0, name: 'Intel Arc A750', deviceKey: 'pnp:gpu-a' };
  const targetB = { id: 1, name: 'Intel Arc B580', deviceKey: 'pnp:gpu-b' };
  const calls = [];
  let selectedTarget = targetA;
  let resolveTarget;
  let announceTargetStarted;
  const targetStarted = new Promise((resolve) => { announceTargetStarted = resolve; });
  const targetLookup = new Promise((resolve) => { resolveTarget = resolve; });
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        calls.push(['sample', selectedTarget?.deviceKey ?? null]);
        return {};
      },
    },
  };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetA, targetB]; },
      getDeviceTarget() {
        announceTargetStarted();
        return targetLookup;
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['ready', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  try {
    holder.onReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [], 'adapter readiness must not sample or notify on initial GPU A');

    const starting = handlers['telemetry-start'](1);
    await targetStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, [], 'Arc Sleep remains gated while persisted GPU B target is unresolved');

    resolveTarget(targetB);
    await starting;
    await new Promise((resolve) => setImmediate(resolve));
    const readyIndex = calls.findIndex(([kind]) => kind === 'ready');
    const setBIndex = calls.findIndex(([kind, key]) => kind === 'setTarget' && key === 'pnp:gpu-b');
    assert.ok(setBIndex >= 0 && setBIndex < readyIndex);
    assert.equal(calls[readyIndex]?.[1], 'pnp:gpu-b');
    assert.ok(calls.slice(readyIndex + 1).some(([kind, key]) => kind === 'sample' && key === 'pnp:gpu-b'));
    assert.ok(calls.every(([, key]) => key !== 'pnp:gpu-a'));
  } finally {
    await stopAllTelemetry();
  }
});

test('system stats readiness waits for an in-flight GPU target before notifying Arc Sleep', async () => {
  const targetB = {
    id: 1,
    name: 'Intel Arc B580',
    deviceKey: 'pnp:gpu-b',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B',
  };
  const calls = [];
  let selectedTarget = {
    id: 0,
    name: 'Intel Arc A750',
    deviceKey: 'pnp:gpu-a',
  };
  let resolveTarget;
  let announceLookupStarted;
  const lookupStarted = new Promise((resolve) => { announceLookupStarted = resolve; });
  const targetLookup = new Promise((resolve) => { resolveTarget = resolve; });
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        const sampledDeviceKey = selectedTarget?.deviceKey ?? null;
        calls.push(['adapterSample', sampledDeviceKey]);
        return { sampledDeviceKey };
      },
    },
  };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetB]; },
      getDeviceTarget() {
        announceLookupStarted();
        return targetLookup;
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['arcSleepReady', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  try {
    const starting = handlers['telemetry-start'](1);
    await lookupStarted;
    holder.onReady();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(calls, [], 'readiness must not observe or sample the adapter default while target B is unresolved');

    resolveTarget(targetB);
    await starting;
    await new Promise((resolve) => setImmediate(resolve));

    const readyIndex = calls.findIndex(([kind]) => kind === 'arcSleepReady');
    const setTargetIndex = calls.findIndex(([kind, key]) => kind === 'setTarget' && key === 'pnp:gpu-b');
    assert.ok(setTargetIndex >= 0 && setTargetIndex < readyIndex, 'GPU B must be applied before Arc Sleep readiness');
    assert.equal(calls[readyIndex]?.[1], 'pnp:gpu-b');
    assert.ok(calls.slice(readyIndex + 1).some(([kind, key]) => kind === 'adapterSample' && key === 'pnp:gpu-b'));
    assert.ok(calls.every(([, key]) => key !== 'pnp:gpu-a'), 'no readiness callback or sample may observe GPU A');
  } finally {
    await stopAllTelemetry();
  }
});

test('system stats readiness follows the newer selected target while stale lookup remains pending', async () => {
  const targetA = { id: 0, name: 'Intel Arc A750', deviceKey: 'pnp:gpu-a' };
  const targetB = { id: 1, name: 'Intel Arc B580', deviceKey: 'pnp:gpu-b' };
  const lookups = new Map();
  const lookupSignals = new Map();
  const calls = [];
  let selectedTarget = { ...targetA };
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        calls.push(['sample', selectedTarget?.deviceKey ?? null]);
        return {};
      },
    },
  };
  for (const id of [0, 1]) {
    let announceStarted;
    const started = new Promise((resolve) => { announceStarted = resolve; });
    lookupSignals.set(id, { started, announceStarted });
  }
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetA, targetB]; },
      getDeviceTarget(id) {
        let resolve;
        const pending = new Promise((done) => { resolve = done; });
        lookups.set(id, { resolve });
        lookupSignals.get(id).announceStarted();
        return pending;
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['ready', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  try {
    const startA = handlers['telemetry-start'](0);
    await lookupSignals.get(0).started;
    holder.onReady();
    const startB = handlers['telemetry-start'](1);
    await lookupSignals.get(1).started;

    lookups.get(1).resolve(targetB);
    await startB;
    await new Promise((resolve) => setImmediate(resolve));

    const readyIndex = calls.findIndex(([kind]) => kind === 'ready');
    const setBIndex = calls.findIndex(([kind, key]) => kind === 'setTarget' && key === 'pnp:gpu-b');
    assert.ok(setBIndex >= 0 && setBIndex < readyIndex);
    assert.equal(calls[readyIndex]?.[1], 'pnp:gpu-b');
    assert.ok(calls.slice(readyIndex + 1).some(([kind, key]) => kind === 'sample' && key === 'pnp:gpu-b'));
    assert.ok(calls.every(([, key]) => key !== 'pnp:gpu-a'));

    lookups.get(0).resolve(targetA);
    await startA;
    assert.equal(selectedTarget.deviceKey, 'pnp:gpu-b');
    assert.ok(calls.every(([, key]) => key !== 'pnp:gpu-a'), 'stale GPU A resolution must not retarget or sample the adapter');
  } finally {
    await stopAllTelemetry();
  }
});

test('replacement selected start does not reuse startup invalidated by a different-device stop', async () => {
  const targetA = { id: 0, name: 'Intel Arc A750', deviceKey: 'pnp:gpu-a' };
  const targetB = { id: 1, name: 'Intel Arc B580', deviceKey: 'pnp:gpu-b' };
  const bLookups = [];
  const bLookupSignals = [];
  const calls = [];
  let selectedTarget = null;
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        calls.push(['sample', selectedTarget?.deviceKey ?? null]);
        return {};
      },
    },
  };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetA, targetB]; },
      getDeviceTarget(id) {
        if (id === 0) return targetA;
        let resolve;
        const pending = new Promise((done) => { resolve = done; });
        bLookups.push({ resolve });
        bLookupSignals[bLookups.length - 1]?.();
        return pending;
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['ready', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  const makeLookupSignal = () => new Promise((resolve) => { bLookupSignals.push(resolve); });
  try {
    await handlers['telemetry-start'](0);
    calls.length = 0;

    const oldBSignal = makeLookupSignal();
    const staleStartB = handlers['telemetry-start'](1);
    await oldBSignal;
    await handlers['telemetry-stop'](0, { expectReplacement: true });
    holder.onReady();

    const replacementBSignal = makeLookupSignal();
    const replacementStartB = handlers['telemetry-start'](1, { completesHandoff: true });
    await replacementBSignal;
    assert.equal(bLookups.length, 2, 'replacement must perform a fresh target lookup');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(([kind]) => kind === 'ready'), false, 'readiness must wait on the fresh B lookup');

    bLookups[1].resolve(targetB);
    await replacementStartB;
    await new Promise((resolve) => setImmediate(resolve));
    const readyIndex = calls.findIndex(([kind]) => kind === 'ready');
    const setBIndex = calls.findIndex(([kind, key]) => kind === 'setTarget' && key === 'pnp:gpu-b');
    assert.ok(setBIndex >= 0 && setBIndex < readyIndex);
    assert.equal(calls[readyIndex]?.[1], 'pnp:gpu-b');
    assert.ok(calls.slice(readyIndex + 1).some(([kind, key]) => kind === 'sample' && key === 'pnp:gpu-b'));

    const callsAfterReplacement = structuredClone(calls);
    bLookups[0].resolve(targetB);
    await staleStartB;
    assert.deepEqual(calls, callsAfterReplacement, 'late stale startup must not retarget or delete the newer lane');
    assert.equal(selectedTarget.deviceKey, 'pnp:gpu-b');
  } finally {
    await stopAllTelemetry();
  }
});

test('telemetry stop releases readiness barrier and stale target lookup cannot retarget adapter', async () => {
  const staleTargetA = { id: 0, name: 'Intel Arc A750', deviceKey: 'pnp:gpu-a' };
  const calls = [];
  let selectedTarget = { id: 2, name: 'Intel Arc B580', deviceKey: 'pnp:gpu-b' };
  let resolveTarget;
  let announceLookupStarted;
  const lookupStarted = new Promise((resolve) => { announceLookupStarted = resolve; });
  const targetLookup = new Promise((resolve) => { resolveTarget = resolve; });
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        calls.push(['sample', selectedTarget?.deviceKey ?? null]);
        return {};
      },
    },
  };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [staleTargetA]; },
      getDeviceTarget() {
        announceLookupStarted();
        return targetLookup;
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['ready', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  try {
    const starting = handlers['telemetry-start'](0);
    await lookupStarted;
    holder.onReady();
    await handlers['telemetry-stop'](0);
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(calls.some(([kind, key]) => kind === 'ready' && key === null), 'stop must release readiness on a cleared target');
    assert.equal(selectedTarget, null);

    resolveTarget(staleTargetA);
    await starting;
    assert.equal(selectedTarget, null);
    assert.ok(calls.every(([, key]) => key !== 'pnp:gpu-a'), 'stale lookup must fail its generation check before setTarget or sampling');
  } finally {
    await stopAllTelemetry();
  }
});

test('readiness stays gated across telemetry stop and replacement start handoff', async () => {
  const targetA = { id: 0, name: 'Intel Arc A750', deviceKey: 'pnp:gpu-a' };
  const targetB = { id: 1, name: 'Intel Arc B580', deviceKey: 'pnp:gpu-b' };
  const lookups = new Map();
  const lookupSignals = new Map();
  let targetLookupCount = 0;
  const calls = [];
  let selectedTarget = { ...targetA };
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        calls.push(['sample', selectedTarget?.deviceKey ?? null]);
        return {};
      },
    },
  };
  for (const id of [0, 1]) {
    let announceStarted;
    const started = new Promise((resolve) => { announceStarted = resolve; });
    lookupSignals.set(id, { started, announceStarted });
  }
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetA, targetB]; },
      getDeviceTarget(id) {
        targetLookupCount += 1;
        let resolve;
        const pending = new Promise((done) => { resolve = done; });
        lookups.set(id, { resolve });
        lookupSignals.get(id).announceStarted();
        return pending;
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['ready', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  try {
    const startA = handlers['telemetry-start'](0);
    await lookupSignals.get(0).started;
    holder.onReady();
    await handlers['telemetry-stop'](0, { expectReplacement: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(([kind]) => kind === 'ready'), false, 'declared handoff must survive a turn before replacement IPC arrives');
    assert.equal(await handlers['telemetry-latest'](0), null);
    assert.equal(targetLookupCount, 1, 'stale latest(A) must not start another target lookup during A-to-B handoff');
    assert.equal(calls.some(([kind]) => kind === 'ready'), false);

    const startB = handlers['telemetry-start'](1, { completesHandoff: true });
    await lookupSignals.get(1).started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(([kind]) => kind === 'ready'), false, 'replacement target B must keep readiness gated');

    lookups.get(1).resolve(targetB);
    await startB;
    await new Promise((resolve) => setImmediate(resolve));
    const readyIndex = calls.findIndex(([kind]) => kind === 'ready');
    const setBIndex = calls.findIndex(([kind, key]) => kind === 'setTarget' && key === 'pnp:gpu-b');
    assert.ok(setBIndex >= 0 && setBIndex < readyIndex);
    assert.equal(calls[readyIndex]?.[1], 'pnp:gpu-b');
    assert.ok(calls.slice(readyIndex + 1).some(([kind, key]) => kind === 'sample' && key === 'pnp:gpu-b'));

    lookups.get(0).resolve(targetA);
    await startA;
    assert.equal(selectedTarget.deviceKey, 'pnp:gpu-b');
    assert.ok(calls.every(([, key]) => key !== 'pnp:gpu-a'));
  } finally {
    await stopAllTelemetry();
  }
});

test('stale latest during null-to-device handoff does not start or consume a target lane', async () => {
  const targetA = { id: 0, name: 'Intel Arc A750', deviceKey: 'pnp:gpu-a' };
  const targetB = { id: 1, name: 'Intel Arc B580', deviceKey: 'pnp:gpu-b' };
  const calls = [];
  let selectedTarget = targetA;
  let targetLookups = 0;
  let resolveTargetB;
  let announceTargetBStarted;
  const targetBStarted = new Promise((resolve) => { announceTargetBStarted = resolve; });
  const targetBLookup = new Promise((resolve) => { resolveTargetB = resolve; });
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        calls.push(['sample', selectedTarget?.deviceKey ?? null]);
        return {};
      },
    },
  };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetA, targetB]; },
      getDeviceTarget(id) {
        targetLookups += 1;
        if (id === 0) return targetA;
        announceTargetBStarted();
        return targetBLookup;
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['ready', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  try {
    await handlers['telemetry-start'](null);
    calls.length = 0;
    await handlers['telemetry-stop'](null, { expectReplacement: true });
    holder.onReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(([kind]) => kind === 'ready'), false);

    assert.equal(await handlers['telemetry-latest'](0), null);
    assert.equal(targetLookups, 0, 'stale latest(A) must not start a selected lane during null-to-device handoff');
    assert.equal(calls.some(([kind]) => kind === 'ready'), false, 'latest(A) must not consume the handoff barrier');

    const startB = handlers['telemetry-start'](1, { completesHandoff: true });
    await targetBStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(([kind]) => kind === 'ready'), false);
    resolveTargetB(targetB);
    await startB;
    await new Promise((resolve) => setImmediate(resolve));

    const readyIndex = calls.findIndex(([kind]) => kind === 'ready');
    const setBIndex = calls.findIndex(([kind, key]) => kind === 'setTarget' && key === 'pnp:gpu-b');
    assert.ok(setBIndex >= 0 && setBIndex < readyIndex);
    assert.equal(calls[readyIndex]?.[1], 'pnp:gpu-b');
    assert.ok(calls.slice(readyIndex + 1).some(([kind, key]) => kind === 'sample' && key === 'pnp:gpu-b'));
    assert.equal(targetLookups, 1);
  } finally {
    await stopAllTelemetry();
  }
});

test('explicit handoff gates late readiness after old target barrier has completed', async () => {
  const targetA = { id: 0, name: 'Intel Arc A750', deviceKey: 'pnp:gpu-a' };
  const targetB = { id: 1, name: 'Intel Arc B580', deviceKey: 'pnp:gpu-b' };
  const calls = [];
  let selectedTarget = null;
  let resolveTargetB;
  let announceTargetBStarted;
  const targetBStarted = new Promise((resolve) => { announceTargetBStarted = resolve; });
  const targetBLookup = new Promise((resolve) => { resolveTargetB = resolve; });
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        calls.push(['sample', selectedTarget?.deviceKey ?? null]);
        return {};
      },
    },
  };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetA, targetB]; },
      getDeviceTarget(id) {
        if (id === 0) return targetA;
        announceTargetBStarted();
        return targetBLookup;
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['ready', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  try {
    await handlers['telemetry-start'](0);
    assert.equal(selectedTarget.deviceKey, 'pnp:gpu-a');
    calls.length = 0;

    await handlers['telemetry-stop'](0, { expectReplacement: true });
    holder.onReady();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(([kind]) => kind === 'ready'), false, 'handoff barrier must exist after A target barrier was removed');

    const startB = handlers['telemetry-start'](1, { completesHandoff: true });
    await targetBStarted;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.some(([kind]) => kind === 'ready'), false, 'deferred B target must continue to gate readiness');

    resolveTargetB(targetB);
    await startB;
    await new Promise((resolve) => setImmediate(resolve));
    const readyIndex = calls.findIndex(([kind]) => kind === 'ready');
    const setBIndex = calls.findIndex(([kind, key]) => kind === 'setTarget' && key === 'pnp:gpu-b');
    assert.ok(setBIndex >= 0 && setBIndex < readyIndex);
    assert.equal(calls[readyIndex]?.[1], 'pnp:gpu-b');
    assert.ok(calls.slice(readyIndex + 1).some(([kind, key]) => kind === 'sample' && key === 'pnp:gpu-b'));
  } finally {
    await stopAllTelemetry();
  }
});

test('failed replacement lookup releases readiness with cleared target instead of stale GPU', async () => {
  const targetA = { id: 0, name: 'Intel Arc A750', deviceKey: 'pnp:gpu-a' };
  const calls = [];
  let selectedTarget = null;
  const holder = {
    current: {
      setTarget(target) {
        selectedTarget = target;
        calls.push(['setTarget', selectedTarget?.deviceKey ?? null]);
      },
      startSlowLane() {},
      async sampleForTarget() {
        calls.push(['sample', selectedTarget?.deviceKey ?? null]);
        return {};
      },
    },
  };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [targetA]; },
      async getDeviceTarget(id) {
        if (id === 0) return targetA;
        throw new Error('replacement target lookup failed');
      },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: holder,
    onSysStatsReady: () => calls.push(['ready', selectedTarget?.deviceKey ?? null]),
    lhmTelemetry: { async sampleForTarget() { return {}; } },
    emit: () => {},
  });

  try {
    await handlers['telemetry-start'](0);
    calls.length = 0;
    await handlers['telemetry-stop'](0, { expectReplacement: true });
    assert.equal(selectedTarget, null);
    holder.onReady();

    await assert.rejects(() => handlers['telemetry-start'](1, { completesHandoff: true }), /replacement target lookup failed/);
    await new Promise((resolve) => setImmediate(resolve));

    const readyIndex = calls.findIndex(([kind]) => kind === 'ready');
    assert.ok(readyIndex >= 0);
    assert.equal(calls[readyIndex]?.[1], null, 'failed replacement must not replay stopped GPU A');
    assert.ok(calls.every(([, key]) => key !== 'pnp:gpu-a'));
  } finally {
    await stopAllTelemetry();
  }
});
