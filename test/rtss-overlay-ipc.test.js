import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { MockBackend } from '../src/main/backend/mock-backend.js';

test('RTSS IPC reconciles a selected secondary GPU without duplicating the primary lane', async () => {
  const backend = new MockBackend({ multiDevice: true, telemetryIntervalS: 0.05 });
  const devices = await backend.listDevices();
  const primary = devices.find((device) => device.id === 0) ?? devices[0];
  const secondary = devices.find((device) => device.id !== primary.id);
  assert.ok(primary?.deviceKey);
  assert.ok(secondary?.deviceKey);

  const settings = {
    overlayEnabled: true,
    overlayDeviceKeys: [secondary.deviceKey],
    overlayPollMs: 100,
    deviceId: primary.id,
    deviceKey: primary.deviceKey,
  };
  const emitted = [];
  const known = [];
  const store = {
    async loadSettings() { return { ...settings }; },
    async saveSettings() {},
    async loadProfiles() { return []; },
  };
  const sysStats = {
    sampleFast: async () => ({}),
    sampleForTarget: async () => ({}),
    setTarget: async () => {},
    registerTarget: () => {},
    startSlowLane: async () => {},
    stopSlowLane: async () => {},
  };
  const { stopAllTelemetry } = createIpcHandlers({
    backend,
    store,
    sysStats,
    rtssOverlay: {
      setKnownDeviceKeys: (keys, order) => known.push({ keys, order }),
      publish: () => {},
    },
    emit: (channel, payload) => {
      if (channel === 'telemetry:sample') emitted.push(payload);
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.ok(known.length >= 1, 'RTSS receives the stable physical inventory order');
    const emittedKeys = new Set(emitted.map((sample) => sample.deviceKey));
    assert.ok(emittedKeys.has(secondary.deviceKey), 'the selected secondary GPU gets a native OSD lane');
    assert.equal(emittedKeys.has(primary.deviceKey), false, 'the primary dashboard lane is not duplicated by RTSS');
  } finally {
    await stopAllTelemetry();
  }
});

test('RTSS boot reconciliation cannot resurrect a lane after telemetry teardown', async () => {
  const backend = new MockBackend({ multiDevice: true });
  let resolveSettings;
  const settingsReady = new Promise((resolve) => { resolveSettings = resolve; });
  const emitted = [];
  const store = {
    async loadSettings() { return settingsReady; },
    async saveSettings() {},
    async loadProfiles() { return []; },
  };
  const { stopAllTelemetry } = createIpcHandlers({
    backend,
    store,
    sysStats: {
      sampleFast: async () => ({}),
      sampleForTarget: async () => ({}),
      startSlowLane: async () => {},
      stopSlowLane: async () => {},
    },
    rtssOverlay: { setKnownDeviceKeys: () => {}, publish: () => {} },
    emit: (channel, payload) => {
      if (channel === 'telemetry:sample') emitted.push(payload);
    },
  });

  await stopAllTelemetry();
  resolveSettings({
    overlayEnabled: true,
    overlayDeviceKeys: (await backend.listDevices()).map((device) => device.deviceKey),
    overlayPollMs: 100,
    deviceId: 0,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(emitted.length, 0, 'a settings read that completed after teardown does not restart RTSS lanes');
});

test('a newer RTSS settings save supersedes an older boot inventory read', async () => {
  const backend = new MockBackend({ multiDevice: true, telemetryIntervalS: 0.05 });
  const devices = await backend.listDevices();
  const primary = devices.find((device) => device.id === 0) ?? devices[0];
  const secondary = devices.find((device) => device.id !== primary.id);
  let listCalls = 0;
  let releaseBootInventory;
  const bootInventoryReady = new Promise((resolve) => { releaseBootInventory = resolve; });
  const originalListDevices = backend.listDevices.bind(backend);
  backend.listDevices = async () => {
    listCalls += 1;
    if (listCalls === 1) await bootInventoryReady;
    return originalListDevices();
  };
  let settings = {
    overlayEnabled: true,
    overlayDeviceKeys: [secondary.deviceKey],
    overlayPollMs: 100,
    deviceId: primary.id,
    deviceKey: primary.deviceKey,
  };
  const emitted = [];
  const store = {
    async loadSettings() { return { ...settings }; },
    async saveSettings(next) { settings = { ...next }; },
    async loadProfiles() { return []; },
  };
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend,
    store,
    startup: { registrationMode: 'run', set: async () => {} },
    sysStats: {
      sampleFast: async () => ({}),
      sampleForTarget: async () => ({}),
      startSlowLane: async () => {},
      stopSlowLane: async () => {},
    },
    rtssOverlay: { setKnownDeviceKeys: () => {}, publish: () => {} },
    emit: (channel, payload) => {
      if (channel === 'telemetry:sample') emitted.push(payload);
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(listCalls, 1, 'the boot reconciliation is waiting on its first inventory read');
    await handlers['profiles-settings-save']({ overlayEnabled: false });
    releaseBootInventory();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal(emitted.length, 0, 'the stale boot reconciliation cannot restore the disabled RTSS lane');
  } finally {
    await stopAllTelemetry();
  }
});
