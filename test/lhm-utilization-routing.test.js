import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';

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
