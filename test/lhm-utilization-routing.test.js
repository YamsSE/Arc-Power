import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createIpcHandlers, mergeIntelTelemetryGpuUtil } from '../src/main/ipc-core.js';
import { mapLibreHardwareMonitorSnapshot } from '../src/main/telemetry/lhm-provider.js';
import { buildGpuEngineScript, buildGpuEngineWorkerScript, buildSysStatsScript, createSysStats, gpuUtilPctOf } from '../src/main/sys-stats.js';

test('Windows GPU Engine sampling uses a real interval and the second counter set', () => {
  const script = buildSysStatsScript();
  assert.match(script, /Get-Counter .*GPU Engine\(\*\).*Utilization Percentage.*-SampleInterval 1 -MaxSamples 2/);
  assert.match(script, /gpuEngSample\.CounterSamples/);
  assert.match(script, /Select-Object -Last 1/);
});

test('production GPU Engine sampling is separated from the broad CIM query', () => {
  const systemScript = buildSysStatsScript({ includeGpuEngine: false });
  const gpuScript = buildGpuEngineScript();
  assert.doesNotMatch(systemScript, /Get-Counter .*GPU Engine\(\*\)/, 'the slow CIM lane must not hold GPU utilization hostage');
  assert.match(systemScript, /\$gpuEng = @\(\)/, 'the broad query must still emit the backward-compatible field');
  assert.match(gpuScript, /Get-Counter .*GPU Engine\(\*\).*Utilization Percentage.*-SampleInterval 1 -MaxSamples 2/);
  assert.match(gpuScript, /Select-Object -Last 1/);
});

test('persistent GPU Engine worker keeps a continuous flushed counter stream', () => {
  const script = buildGpuEngineWorkerScript();
  assert.match(script, /Get-Counter .*GPU Engine\(\*\).*Utilization Percentage.*-SampleInterval 1 -Continuous/);
  assert.match(script, /ForEach-Object/);
  assert.match(script, /ConvertTo-Json/);
  assert.match(script, /\[Console\]::Out\.Flush\(\)/);
});

test('dedicated GPU Engine lane refreshes utilization without the slow lane wiping it', async () => {
  const target = { deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xBB85 } };
  const gpuOutput = JSON.stringify({ gpuEng: [{
    Name: 'pid_1_luid_0x00000000_0x0000bb85_phys_0_eng_0_engtype_3d',
    UtilizationPercentage: 37,
  }] });
  const systemOutput = JSON.stringify({
    cpu: { PercentProcessorTime: 0, PercentProcessorPerformance: 100 },
    maxClockMhz: 1000,
    thermal: [],
    msaThermal: [],
    gpuMem: [],
    gpuEng: [],
    powerMeter: [],
  });
  const commands = [];
  const handles = [];
  const cleared = [];
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    ...target,
    execFile: async (_exe, args) => {
      const command = String(args?.[3] ?? '');
      commands.push(command);
      return { stdout: command.includes('Get-Counter') ? gpuOutput : systemOutput };
    },
    setInterval: (fn) => {
      handles.push(fn);
      return handles.length;
    },
    clearInterval: (handle) => cleared.push(handle),
  });

  stats.startSlowLane(999, 7);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await stats.sampleGpuUtilForTarget(target).then((sample) => sample.gpuUtilPct), 37);
  await stats.sampleSlow();
  assert.equal(await stats.sampleGpuUtilForTarget(target).then((sample) => sample.gpuUtilPct), 37);
  assert.equal(commands.filter((command) => command.includes('Get-Counter')).length, 1);

  stats.stopSlowLane(7);
  assert.deepEqual(cleared.sort(), [1, 2], 'both lane timers are stopped by the shared teardown');
});

test('dedicated GPU Engine cache survives PCI-only to PNP inventory enrichment', async () => {
  const pciTarget = {
    deviceKey: 'pci:0x8086:0xe20b@3:0.0',
    pciVendorId: '0x8086',
    pciDeviceId: '0xe20b',
    bdf: { bus: 3, device: 0, function: 0 },
  };
  const pnpTarget = {
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_60211849',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_60211849',
    pciVendorId: pciTarget.pciVendorId,
    pciDeviceId: pciTarget.pciDeviceId,
    deviceKeys: [pciTarget.deviceKey],
  };
  const gpuOutput = JSON.stringify({ gpuEng: [{
    Name: 'pid_1_luid_0x00000000_0x0000bb85_phys_0_eng_0_engtype_3d',
    UtilizationPercentage: 41,
  }] });
  const handles = [];
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    ...pciTarget,
    deviceIdHex: pciTarget.pciDeviceId,
    // Deliberately stale serialized LUID: the current PCI/BDF lookup must win.
    osLuid: { high: 0, low: 0xADFB },
    luidOf: async () => ({ high: 0, low: 0xBB85 }),
    execFile: async () => ({ stdout: gpuOutput }),
    setInterval: (fn) => { handles.push(fn); return handles.length; },
    clearInterval: () => {},
  });
  stats.startSlowLane(999, 1);
  await new Promise((resolve) => setTimeout(resolve, 10));
  stats.setTarget(pnpTarget);
  assert.equal((await stats.sampleGpuUtilForTarget(pnpTarget)).gpuUtilPct, 41);
  stats.stopSlowLane(1);
});

test('same-model PNP-only targets without a shared alias remain separate', () => {
  const targetA = {
    deviceKey: 'pci:0x8086:0xe20b@3:0.0',
    pciVendorId: '0x8086',
    pciDeviceId: '0xe20b',
    bdf: { bus: 3, device: 0, function: 0 },
  };
  const targetB = {
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_SECOND',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_SECOND',
    pciVendorId: targetA.pciVendorId,
    pciDeviceId: targetA.pciDeviceId,
  };
  const stats = createSysStats({ ...targetA, deviceIdHex: targetA.pciDeviceId });
  const firstKey = stats.registerTarget(targetA);
  const secondKey = stats.registerTarget(targetB);
  assert.notEqual(secondKey, firstKey, 'a same-model adapter without a shared physical alias must not borrow the first adapter');
});

test('dedicated GPU worker restarts after a previously valid stream goes stale', async () => {
  const target = { deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xBB85 } };
  const output = (value) => JSON.stringify({ gpuEng: [{
    Name: 'pid_1_luid_0x00000000_0x0000bb85_phys_0_eng_0_engtype_3d',
    UtilizationPercentage: value,
  }] }) + '\n';
  const children = [];
  const handles = [];
  let clock = 0;
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    ...target,
    luidOf: async () => target.osLuid,
    execFile: async () => ({ stdout: JSON.stringify({
      cpu: { PercentProcessorTime: 0, PercentProcessorPerformance: 100 },
      maxClockMhz: 1000,
      thermal: [],
      msaThermal: [],
      gpuMem: [],
      gpuEng: [],
      powerMeter: [],
    }) }),
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.kill = () => {
        child.stdout.end();
        child.emit('close', 0);
      };
      children.push(child);
      return child;
    },
    now: () => clock,
    setInterval: (fn) => { handles.push(fn); return handles.length; },
    clearInterval: () => {},
  });

  stats.startSlowLane(999, 1);
  children[0].stdout.write(output(37));
  await new Promise((resolve) => setTimeout(resolve, 10));
  handles[1]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await stats.sampleGpuUtilForTarget(target)).gpuUtilPct, 37);

  clock = 9001;
  handles[1]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(children.length, 2, 'a stale live worker is replaced');

  children[1].stdout.write(output(43));
  await new Promise((resolve) => setTimeout(resolve, 10));
  handles[1]();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await stats.sampleGpuUtilForTarget(target)).gpuUtilPct, 43);
  stats.stopSlowLane(1);
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

test('stale authoritative Windows utilization is not replaced by a lower LHM value', async () => {
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
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: {
      setTarget() {},
      startSlowLane() {},
      stopSlowLane() {},
      sampleGpuUtilForTarget: async () => ({
        gpuUtilPct: null,
        gpuUtilSource: 'windows-gpu-engine',
        gpuUtilAuthoritative: true,
      }),
    },
    lhmTelemetry: {
      sampleForTarget: async () => ({
        telemetryProvider: 'LibreHardwareMonitor',
        gpuUtilPct: 2,
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
  assert.equal(sample?.gpuUtilPct, null);
  assert.equal(sample?.utilPct, null);
  assert.equal(sample?.gpuUtilSource, null);
});

test('Windows GPU Engine authority is false when the selected target has no routable LUID', async () => {
  const target = {
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  };
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    luidOf: async () => null,
  });
  const sample = await stats.sampleGpuUtilForTarget(target);
  assert.equal(sample.gpuUtilPct, null);
  assert.equal(sample.gpuUtilSource, null);
  assert.equal(sample.gpuUtilAuthoritative, false);
});

test('native Windows utilization remains authoritative when LHM is unavailable', () => {
  const merged = mergeIntelTelemetryGpuUtil(
    { gpuUtilPct: 60, cpuUtilPct: 9 },
    { utilPct: 4, gpuUtilPct: 5, tempC: 72 },
    { gpuUtilPct: 48, gpuUtilSource: 'windows-d3dkmt', gpuUtilAuthoritative: true },
  );
  assert.equal(merged.gpuUtilPct, 48);
  assert.equal(merged.utilPct, 48);
  assert.equal(merged.gpuUtilSource, 'windows-d3dkmt');
  assert.equal(merged.tempC, 72);
  assert.equal(merged.cpuUtilPct, 9);
});

test('native Windows utilization publishes honest null while warming', () => {
  const merged = mergeIntelTelemetryGpuUtil(
    {},
    { utilPct: 4, gpuUtilPct: 5 },
    { gpuUtilPct: null, gpuUtilSource: null, gpuUtilAuthoritative: true },
  );
  assert.equal(merged.gpuUtilPct, null);
  assert.equal(merged.utilPct, null);
  assert.equal(merged.gpuUtilSource, null);
});

test('Intel telemetry lane does not let IGCL overwrite native Windows utilization', async () => {
  const target = {
    id: 0,
    name: 'Intel Arc B580',
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  };
  const rawCallbacks = new Set();
  const emitted = [];
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend: {
      async listDevices() { return [target]; },
      async getDeviceTarget() { return target; },
      onRawTelemetry(_deviceId, callback) { rawCallbacks.add(callback); return () => rawCallbacks.delete(callback); },
      async sampleRawTelemetry() {
        for (const callback of rawCallbacks) callback({ t: Date.now(), utilPct: 4, gpuUtilPct: 5, tempC: 72 });
      },
    },
    store: { loadSettings: async () => ({ overlayPollMs: 400 }) },
    sysStats: {
      setTarget() {},
      sampleFast: async () => ({ gpuUtilPct: 60, cpuUtilPct: 9 }),
      sampleGpuUtilForTarget: async () => ({
        gpuUtilPct: 48,
        gpuUtilSource: 'windows-d3dkmt',
        gpuUtilAuthoritative: true,
      }),
      startSlowLane() {},
      stopSlowLane() {},
    },
    // This is the production fallback branch under test: no LHM bridge.
    lhmTelemetry: null,
    emit: (channel, payload) => {
      if (channel === 'telemetry:sample') emitted.push(payload);
    },
  });

  try {
    await handlers['telemetry-start'](0);
    await handlers['overlay-telemetry-start']([0]);
  } finally {
    await stopAllTelemetry();
  }

  const samples = emitted.filter((sample) => sample.deviceId === 0);
  assert.ok(samples.length >= 2, 'main and overlay Intel lanes both publish');
  for (const sample of samples) {
    assert.equal(sample.gpuUtilPct, 48);
    assert.equal(sample.utilPct, 48);
    assert.equal(sample.gpuUtilSource, 'windows-d3dkmt');
    assert.equal(sample.tempC, 72);
  }
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
