import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { mapLibreHardwareMonitorSnapshot } from '../src/main/telemetry/lhm-provider.js';

test('a retained LHM GPU load after a failed query falls back to Windows utilization', async () => {
  const target = {
    id: 0,
    name: 'Intel Arc B580',
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  };
  const payloadFor = (fresh) => ({
    ok: true,
    at: Date.now(),
    hardware: [{
      identifier: '/gpu-intel/0xE20B',
      name: 'Intel Arc B580',
      type: 'GpuIntel',
      sensors: [{ name: 'GPU Core', type: 'Load', value: 82, fresh }],
    }],
  });
  const backend = {
    async listDevices() { return [target]; },
    async getDeviceTarget() { return target; },
    onRawTelemetry() { return () => {}; },
  };
  const emitted = [];
  let lhmSamples = 0;
  let windowsReads = 0;
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend,
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: {
      setTarget() {},
      startSlowLane() {},
      stopSlowLane() {},
      sampleGpuUtilForTarget: async () => {
        windowsReads += 1;
        return { gpuUtilPct: 27 };
      },
    },
    lhmTelemetry: {
      sampleForTarget: async (sampleTarget) => {
        // Simulate a good first LHM poll, then a failed driver query whose
        // old value remains in the sensor object but is marked not fresh.
        const payload = payloadFor(lhmSamples++ === 0);
        return mapLibreHardwareMonitorSnapshot(payload, sampleTarget);
      },
    },
    emit: (channel, payload) => emitted.push([channel, payload]),
  });

  try {
    await handlers['telemetry-start'](0);
    await handlers['telemetry-start'](0);
  } finally {
    await stopAllTelemetry();
  }

  const samples = emitted
    .filter(([channel]) => channel === 'telemetry:sample')
    .map(([, sample]) => sample);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].gpuUtilPct, 82);
  assert.equal(samples[0].gpuUtilSource, 'libre-hardware-monitor');
  assert.equal(samples[1].gpuUtilPct, 27);
  assert.equal(samples[1].utilPct, 27);
  assert.equal(samples[1].gpuUtilSource, 'windows-gpu-engine');
  assert.equal(windowsReads, 1, 'Windows is read only for the poll with no fresh LHM utilization');
});

test('ambiguous identical Intel adapters fall back to each adapter Windows GPU Engine sample', async () => {
  const targets = [
    {
      id: 0,
      name: 'Intel Arc A770 1',
      deviceKey: 'pnp:PCI\\VEN_8086&DEV_56A0&SUBSYS_12345678',
      pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_12345678',
      pciVendorId: '0x8086',
      pciDeviceId: '0x56A0',
    },
    {
      id: 1,
      name: 'Intel Arc A770 2',
      deviceKey: 'pnp:PCI\\VEN_8086&DEV_56A0&SUBSYS_87654321',
      pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_87654321',
      pciVendorId: '0x8086',
      pciDeviceId: '0x56A0',
    },
  ];
  let inventoryReads = 0;
  const backend = {
    async listDevices() { inventoryReads += 1; return targets; },
    async getDeviceTarget(id) { return targets[id] ?? null; },
  };
  const emitted = [];
  let lhmSamples = 0;
  let releaseLhmSamples;
  const bothLhmSamples = new Promise((resolve) => { releaseLhmSamples = resolve; });
  const releaseGuard = setTimeout(releaseLhmSamples, 1000);
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend,
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: {
      setTarget() {},
      startSlowLane() {},
      sampleGpuUtilForTarget: async (target) => ({
        gpuUtilPct: target?.id === 0 ? 27 : 74,
      }),
    },
    lhmTelemetry: {
      sampleForTarget: async () => {
        lhmSamples += 1;
        if (lhmSamples === 2) releaseLhmSamples();
        if (lhmSamples <= 2) await bothLhmSamples;
        return {
          telemetryProvider: 'LibreHardwareMonitor',
          gpuUtilPct: 82,
          gpuUtilSource: 'libre-hardware-monitor',
        };
      },
    },
    emit: (channel, payload) => emitted.push([channel, payload]),
  });

  try {
    await Promise.all([
      handlers['telemetry-start'](0),
      handlers['overlay-telemetry-start']([1]),
    ]);
  } finally {
    clearTimeout(releaseGuard);
    releaseLhmSamples();
    await stopAllTelemetry();
  }

  const samples = new Map(
    emitted
      .filter(([channel]) => channel === 'telemetry:sample')
      .map(([, sample]) => [sample.deviceId, sample]),
  );
  assert.equal(samples.get(0)?.gpuUtilPct, 27);
  assert.equal(samples.get(0)?.gpuUtilSource, 'windows-gpu-engine');
  assert.equal(samples.get(1)?.gpuUtilPct, 74);
  assert.equal(samples.get(1)?.gpuUtilSource, 'windows-gpu-engine');
  assert.equal(inventoryReads, 2, 'overlay enumeration plus one shared in-flight identity snapshot');

  await new Promise((resolve) => setTimeout(resolve, 1550));
  await handlers['telemetry-start'](0);
  await stopAllTelemetry();
  assert.equal(inventoryReads, 3, 'the cached identity snapshot refreshes after its TTL');
});
