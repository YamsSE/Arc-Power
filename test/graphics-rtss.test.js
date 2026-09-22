import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';

function createGraphicsHandlers({ rtssFrameLimiter, applyRunner }) {
  const target = { id: 0, deviceKey: 'pci:arc-b580-test', synthetic: false, backendKind: 'igcl' };
  const backend = {
    async getDeviceTarget() { return target; },
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
    store: { loadSettings: async () => ({}), saveSettings: async (settings) => settings },
    emit: () => {},
    rtssFrameLimiter,
    applyRunner,
  }).handlers;
}

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
    message: 'RTSS frame limit was rolled back because another graphics setting failed',
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
