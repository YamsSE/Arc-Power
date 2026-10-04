import assert from 'node:assert/strict';
import test from 'node:test';
import { createIpcHandlers } from '../src/main/ipc-core.js';

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

test('system stats holder readiness preserves prior hooks and notifies Arc Sleep', () => {
  const calls = [];
  const holder = { current: null, onReady: () => calls.push('previous') };
  createIpcHandlers({
    backend: {},
    store: { loadSettings: async () => ({}) },
    emit: () => {},
    sysStats: holder,
    onSysStatsReady: () => calls.push('arc-sleep'),
  });
  holder.current = {};
  holder.onReady();
  assert.deepEqual(calls, ['previous', 'arc-sleep']);
});
