import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { mapLibreHardwareMonitorSnapshot } from '../src/main/telemetry/lhm-provider.js';
import { buildSysStatsScript, gpuUtilPctOf } from '../src/main/sys-stats.js';

test('Windows GPU Engine sampling uses a real interval and the second counter set', () => {
  const script = buildSysStatsScript();
  assert.match(script, /Get-Counter .*GPU Engine\(\*\).*Utilization Percentage.*-SampleInterval 1 -MaxSamples 2/);
  assert.match(script, /gpuEngSample\.CounterSamples/);
  assert.match(script, /Select-Object -Last 1/);
});

test('Windows GPU Engine aggregation matches Task Manager busiest-engine semantics', () => {
  const luid = { high: 0, low: 0xBB85 };
  const rows = [
    { name: 'pid_1_luid_0x00000000_0x0000BB85_phys_0_eng_0_engtype_3D', utilPct: 12 },
    { name: 'pid_2_luid_0x00000000_0x0000BB85_phys_0_eng_0_engtype_3D', utilPct: 8 },
    { name: 'pid_3_luid_0x00000000_0x0000BB85_phys_0_eng_5_engtype_Compute', utilPct: 30 },
    { name: 'pid_4_luid_0x00000000_0x0000BB85_phys_1_eng_0_engtype_3D', utilPct: 45 },
    { name: 'pid_5_luid_0x00000000_0x0000ADFB_phys_0_eng_0_engtype_3D', utilPct: 99 },
  ];
  assert.equal(gpuUtilPctOf(rows, luid), 45, 'sum processes per physical engine, then select the busiest engine');
  assert.equal(gpuUtilPctOf(rows.map((row) => ({ ...row, utilPct: 0 })), luid), 0, 'zero is a populated sample');
  assert.equal(gpuUtilPctOf(rows.map((row) => ({ ...row, utilPct: null })), luid), null, 'all-null rows are unavailable');
});

test('Windows GPU Engine utilization wins over LHM and remains the stale-value fallback', async () => {
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
  assert.equal(samples[0].gpuUtilPct, 27);
  assert.equal(samples[0].gpuUtilSource, 'windows-gpu-engine');
  assert.equal(samples[1].gpuUtilPct, 27);
  assert.equal(samples[1].utilPct, 27);
  assert.equal(samples[1].gpuUtilSource, 'windows-gpu-engine');
  assert.equal(windowsReads, 2, 'Windows is authoritative for every poll');
});

test('LHM Intel utilization is used only when the fresh Windows value is unavailable', async () => {
  const target = {
    id: 0,
    name: 'Intel Arc B580',
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  };
  const emitted = [];
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [target]; },
      async getDeviceTarget() { return target; },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: {
      setTarget() {},
      startSlowLane() {},
      stopSlowLane() {},
      sampleGpuUtilForTarget: async () => ({ gpuUtilPct: null }),
    },
    lhmTelemetry: {
      sampleForTarget: async () => ({
        telemetryProvider: 'LibreHardwareMonitor',
        gpuUtilPct: 82,
        gpuUtilSource: 'libre-hardware-monitor',
      }),
    },
    emit: (channel, payload) => emitted.push([channel, payload]),
  });

  try {
    await handlers['telemetry-start'](0);
  } finally {
    await stopAllTelemetry();
  }

  const sample = emitted.find(([channel]) => channel === 'telemetry:sample')?.[1];
  assert.equal(sample?.gpuUtilPct, 82);
  assert.equal(sample?.utilPct, 82);
  assert.equal(sample?.gpuUtilSource, 'libre-hardware-monitor');
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
  assert.equal(inventoryReads, 1, 'Windows authority avoids an unnecessary LHM identity read');

  await new Promise((resolve) => setTimeout(resolve, 1550));
  await handlers['telemetry-start'](0);
  await stopAllTelemetry();
  assert.equal(inventoryReads, 1, 'Windows authority continues to avoid an LHM identity read');
});

test('LHM null CPU wattage does not erase the native system power sample', async () => {
  const target = {
    id: 0,
    name: 'Intel Arc B580',
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  };
  const emitted = [];
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [target]; },
      async getDeviceTarget() { return target; },
      onRawTelemetry() { return () => {}; },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: {
      setTarget() {},
      startSlowLane() {},
      stopSlowLane() {},
      sampleForTarget: async () => ({ cpuPowerW: 44.5, cpuUtilPct: 51, memoryUsedBytes: 123 }),
      sampleGpuUtilForTarget: async () => ({ gpuUtilPct: 27 }),
    },
    lhmTelemetry: {
      sampleForTarget: async () => ({
        telemetryProvider: 'LibreHardwareMonitor',
        cpuPowerW: null,
        cpuUtilPct: null,
        memoryUsedBytes: null,
        gpuUtilPct: 82,
        gpuUtilSource: 'libre-hardware-monitor',
      }),
    },
    emit: (channel, payload) => emitted.push([channel, payload]),
  });

  try {
    await handlers['telemetry-start'](0);
  } finally {
    await stopAllTelemetry();
  }

  const sample = emitted.find(([channel]) => channel === 'telemetry:sample')?.[1];
  assert.equal(sample?.cpuPowerW, 44.5);
  assert.equal(sample?.cpuUtilPct, 51);
  assert.equal(sample?.memoryUsedBytes, 123);
  assert.equal(sample?.gpuUtilPct, 27);
  assert.equal(sample?.gpuUtilSource, 'windows-gpu-engine');
});
