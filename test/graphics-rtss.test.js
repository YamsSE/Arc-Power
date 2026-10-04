import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { createArcSleepController } from '../src/main/arc-sleep-controller.js';
import { createArcSleepIGCLLimiter } from '../src/main/arc-sleep-igcl-limiter.js';

function createGraphicsHandlers({ rtssFrameLimiter, applyRunner, arcSleepController, backend: backendOverride, store: storeOverride }) {
  const target = { id: 0, deviceKey: 'pci:arc-b580-test', synthetic: false, backendKind: 'igcl' };
  const backend = backendOverride ?? {
    async getDeviceTarget() { return target; },
    async listDevices() { return [target]; },
    async getGraphicsSettings() {
      return {
        frameLimitRange: { min: 30, max: 300, step: 1, default: 60 },
        supported: { frameLimit: true, lowLatency: true },
        values: { frameLimit: { enabled: false, value: 60 }, lowLatency: 'off' },
      };
    },
  };
  return createIpcHandlers({
    backend,
    store: storeOverride ?? { loadSettings: async () => ({}), saveSettings: async (settings) => settings },
    emit: () => {},
    rtssFrameLimiter,
    arcSleepController,
    applyRunner,
  }).handlers;
}

test('graphics apply checks the saved GPU key after resolving a fresh physical target', async () => {
  const target = {
    id: 0,
    deviceKey: 'gpu:8086:56a0:0000:03:00.0',
    backendId: 2,
    synthetic: false,
    backendKind: 'igcl',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0',
  };
  const resolveArgs = [];
  let applied = null;
  const handlers = createGraphicsHandlers({
    backend: {
      async getDeviceTarget(...args) {
        resolveArgs.push(args);
        if (args.length > 1) throw new Error('identity key cannot substitute for physical proof');
        return target;
      },
      async getGraphicsSettings() {
        return {
          supported: { lowLatency: true, frameLimit: true },
          supportedOptions: { lowLatency: ['off', 'on'] },
          frameLimitRange: { min: 30, max: 300, step: 1 },
          values: { lowLatency: 'off', frameLimit: { enabled: false, value: 60 } },
        };
      },
    },
    store: { async loadSettings() { return { deviceId: 0, deviceKey: target.deviceKey }; } },
    applyRunner: {
      async graphicsApplyIsolated(request) {
        applied = request;
        return { ok: true, perControl: { lowLatency: { ok: true } } };
      },
    },
  });

  const result = await handlers['graphics:apply'](0, { lowLatency: 'on' });

  assert.equal(result.ok, true);
  assert.deepEqual(resolveArgs, [[0]]);
  assert.equal(applied.deviceKey, target.deviceKey);
  assert.equal(applied.physicalTarget.pnpDeviceId, target.pnpDeviceId);
});

test('graphics apply rolls RTSS back when the driver apply returns a failure', async () => {
  const rtssCalls = [];
  const handlers = createGraphicsHandlers({
    rtssFrameLimiter: {
      async getFrameLimit() { return { ok: true, limit: 60, limiterEnabled: false }; },
      async applyFrameLimit(options) {
        rtssCalls.push(options);
        return rtssCalls.length === 1
          ? {
            ok: true,
            used: true,
            value: 144,
            rollbackToken: { profile: '', previousLimit: 0 },
            restoreToken: { token: 'graphics-rollback' },
          }
          : { ok: true, used: true };
      },
      async restoreFrameLimit(token) {
        assert.deepEqual(token, { token: 'graphics-rollback' });
        return { ok: true, used: true, restored: true };
      },
    },
    applyRunner: {
      async graphicsApplyIsolated() {
        return { ok: false, perControl: { lowLatency: { ok: false, errorCode: 'driver-failed' } } };
      },
    },
  });

  const result = await handlers['graphics:apply'](0, {
    frameLimit: { enabled: true, value: 144 },
    lowLatency: 'on',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(result.perControl.frameLimit, {
    ok: false,
    errorCode: 'rolled-back',
    message: 'The FPS limit was rolled back because another graphics setting failed',
  });
  assert.equal(rtssCalls.length, 1, 'the production controller restoreFrameLimit path should own rollback');
});

test('graphics apply sends the limiter to IGCL when RTSS is unavailable', async () => {
  let driverSettings = null;
  const handlers = createGraphicsHandlers({
    rtssFrameLimiter: {
      async getFrameLimit() { return { ok: false, available: false, source: 'igcl', error: 'RTSS is not running' }; },
      async applyFrameLimit() { return { ok: false, used: false, fallback: true, source: 'igcl', error: 'RTSS is not running' }; },
    },
    applyRunner: {
      async graphicsApplyIsolated({ settings }) {
        driverSettings = settings;
        return { ok: true, perControl: { frameLimit: { ok: true, source: 'igcl' } } };
      },
    },
  });

  const result = await handlers['graphics:apply'](0, { frameLimit: { enabled: true, value: 144 } });

  assert.equal(result.ok, true);
  assert.deepEqual(driverSettings, { frameLimit: { enabled: true, value: 144 } });
  assert.equal(result.graphicsState.frameLimitSource, 'igcl');
});

test('graphics apply rolls RTSS back when the isolated driver apply throws', async () => {
  let restored = 0;
  const handlers = createGraphicsHandlers({
    rtssFrameLimiter: {
      async getFrameLimit() { return { ok: true, limit: 60, limiterEnabled: false }; },
      async applyFrameLimit() {
        return {
          ok: true,
          used: true,
          value: 144,
          restoreToken: { token: 'graphics-throw-rollback' },
        };
      },
      async restoreFrameLimit(token) {
        assert.deepEqual(token, { token: 'graphics-throw-rollback' });
        restored += 1;
        return { ok: true };
      },
    },
    applyRunner: {
      async graphicsApplyIsolated() { throw new Error('driver worker failed'); },
    },
  });

  await assert.rejects(
    handlers['graphics:apply'](0, { frameLimit: { enabled: true, value: 144 }, lowLatency: 'on' }),
    /driver worker failed.*rolled back/,
  );
  assert.equal(restored, 1);
});

test('graphics apply holds the Arc Sleep transaction through driver failure and rollback', async () => {
  const events = [];
  let lowLevelRestores = 0;
  const handlers = createGraphicsHandlers({
    rtssFrameLimiter: {
      async getFrameLimit() { return { ok: true, limit: 60, denominator: 1, limiterEnabled: false }; },
      async restoreFrameLimit() { lowLevelRestores += 1; return { ok: true }; },
    },
    arcSleepController: {
      async withTransaction(work) {
        events.push('lock');
        const result = await work({
          getSnapshot: () => ({ baseFrameLimit: { enabled: false, value: 60 } }),
          async setBaseFrameLimit(value) {
            events.push(`base:${value.value}`);
            return {
              handled: true,
              ok: true,
              perControl: { frameLimit: { ok: true, source: 'rtss' } },
              async rollback() { events.push('rollback'); return { ok: true }; },
            };
          },
        });
        events.push('unlock');
        return result;
      },
    },
    applyRunner: {
      async graphicsApplyIsolated() {
        events.push('driver');
        return { ok: false, perControl: { lowLatency: { ok: false, errorCode: 'driver-failed' } } };
      },
    },
  });

  const result = await handlers['graphics:apply'](0, {
    frameLimit: { enabled: true, value: 144 },
    lowLatency: 'on',
  });

  assert.equal(result.ok, false);
  assert.deepEqual(events, ['lock', 'base:144', 'driver', 'rollback', 'unlock']);
  assert.equal(lowLevelRestores, 0, 'the controller owns exact-state rollback');
});

test('failed graphics FPS-limit apply preserves the saved Arc Sleep base when no provider is available', async () => {
  let saved = {
    arcSleep: {},
    arcSleepFrameLimitBase: { enabled: true, value: 120 },
    arcSleepJournal: null,
  };
  const store = {
    async loadSettings() { return structuredClone(saved); },
    async saveArcSleepState(patch) { saved = { ...saved, ...structuredClone(patch) }; },
  };
  const rtssFrameLimiter = {
    async getFrameLimit() { return { ok: false, available: false, error: 'RTSS is unavailable' }; },
  };
  const arcSleepController = createArcSleepController({ store, rtssFrameLimiter });
  const handlers = createGraphicsHandlers({
    rtssFrameLimiter,
    arcSleepController,
    applyRunner: {
      async graphicsApplyIsolated() {
        return { ok: false, perControl: { frameLimit: { ok: false, errorCode: 'driver-failed' } } };
      },
    },
  });

  const result = await handlers['graphics:apply'](0, { frameLimit: { enabled: false, value: 120 } });
  assert.equal(result.ok, false);
  assert.deepEqual(saved.arcSleepFrameLimitBase, { enabled: true, value: 120 });
  await arcSleepController.stop();
});

test('Arc Sleep applies IGCL read-back only to the requested adapter', async () => {
  const devices = [
    { id: 0, deviceKey: 'gpu:a', synthetic: false, backendKind: 'igcl' },
    { id: 1, deviceKey: 'gpu:b', synthetic: false, backendKind: 'igcl' },
  ];
  const handlers = createGraphicsHandlers({
    backend: {
      async listDevices() { return devices; },
      async getGraphicsSettings(id) {
        return {
          supported: { frameLimit: true },
          frameLimitRange: { min: 30, max: 300, step: 1 },
          values: { frameLimit: { enabled: false, value: id === 0 ? 60 : 75 } },
        };
      },
    },
    store: { async loadSettings() { return { deviceKey: 'gpu:a' }; } },
    arcSleepController: {
      getSnapshot() {
        return {
          activeLimiter: 'igcl',
          limiterDeviceKey: 'gpu:a',
          baseFrameLimit: { enabled: true, value: 120 },
        };
      },
    },
  });

  const other = await handlers['graphics:get'](1);
  const selected = await handlers['graphics:get'](0);

  assert.deepEqual(other.values.frameLimit, { enabled: false, value: 75 });
  assert.deepEqual(selected.values.frameLimit, { enabled: true, value: 120 });
});

test('IGCL write failure rolls back the Graphics Base Cap and clears its temporary journal', async () => {
  const device = {
    id: 0,
    deviceKey: 'gpu:8086:56a0:0000:03:00.0',
    name: 'Intel Arc B580',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0',
    synthetic: false,
    backendKind: 'igcl',
  };
  let saved = {
    deviceKey: device.deviceKey,
    arcSleep: {},
    arcSleepFrameLimitBase: { enabled: false, value: 60 },
    arcSleepJournal: null,
  };
  let applyCount = 0;
  const store = {
    async loadSettings() { return structuredClone(saved); },
    async saveArcSleepState(patch) { saved = { ...saved, ...structuredClone(patch) }; },
  };
  const backend = {
    async listDevices() { return [device]; },
    async getDeviceTarget(id, key) { return id === device.id && key === device.deviceKey ? device : null; },
    async getGraphicsSettings() {
      return {
        supported: { frameLimit: true },
        frameLimitRange: { min: 30, max: 300, step: 5 },
        frameLimitLiveChange: true,
        values: { frameLimit: { enabled: false, value: 60 } },
      };
    },
  };
  const rtssFrameLimiter = {
    async getFrameLimit() { return { ok: false, available: false, error: 'RTSS is unavailable' }; },
  };
  const applyRunner = {
    async graphicsApplyIsolated() {
      applyCount += 1;
      return { ok: false, perControl: { frameLimit: { ok: false, errorCode: 'driver-failed', message: 'IGCL refused the write' } } };
    },
  };
  const igclFrameLimiter = createArcSleepIGCLLimiter({
    backend,
    store,
    applyRunner,
    isElevated: () => true,
  });
  const arcSleepController = createArcSleepController({ store, rtssFrameLimiter, igclFrameLimiter });
  const handlers = createGraphicsHandlers({ backend, store, rtssFrameLimiter, arcSleepController, applyRunner });

  const result = await handlers['graphics:apply'](0, { frameLimit: { enabled: true, value: 144 } });

  assert.equal(result.ok, false);
  assert.equal(applyCount, 1);
  assert.deepEqual(saved.arcSleepFrameLimitBase, { enabled: false, value: 60 });
  assert.equal(saved.arcSleepJournal, null);
  await arcSleepController.stop();
});
