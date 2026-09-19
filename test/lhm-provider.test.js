import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIBRE_HARDWARE_MONITOR_SOURCE,
  LIBRE_HARDWARE_MONITOR_VERSION,
  createLhmTelemetry,
  lhmGpuUtilizationTargetIsUnique,
  mapLibreHardwareMonitorSnapshot,
} from '../src/main/telemetry/lhm-provider.js';

function snapshot() {
  return {
    ok: true,
    at: 123,
    hardware: [
      {
        identifier: '/intelcpu/0',
        name: 'CPU',
        type: 'Cpu',
        sensors: [
          { name: 'CPU Total', type: 'Load', value: 44 },
          { name: 'Core Max', type: 'Temperature', value: 65 },
          { name: 'CPU Core #1', type: 'Clock', value: 4100 },
          { name: 'CPU Core #2', type: 'Clock', value: 3900 },
          { name: 'CPU Package', type: 'Power', value: 91 },
        ],
      },
      {
        identifier: '/ram',
        name: 'Total Memory',
        type: 'Memory',
        sensors: [{ name: 'Memory Used', type: 'Data', value: 12.5 }],
      },
      {
        identifier: '/gpu-intel/0xE20B',
        name: 'Intel Arc B580',
        type: 'GpuIntel',
        sensors: [
          { name: 'GPU Core', type: 'Temperature', value: 70 },
          { name: 'GPU Core', type: 'Clock', value: 3000 },
          { name: 'GPU Memory', type: 'Clock', value: 2400 },
          { name: 'GPU Core', type: 'Voltage', value: 1.02 },
          { name: 'GPU Package', type: 'Power', value: 158 },
          { name: 'GPU Fan', type: 'Fan', value: 1200 },
          { name: 'GPU Memory Used', type: 'SmallData', value: 2048 },
          { name: 'GPU Core', type: 'Load', value: 8, fresh: true },
          { name: 'GPU Render/Compute', type: 'Load', value: 23 },
          { name: 'GPU Media', type: 'Load', value: 5 },
          { name: 'GPU Memory', type: 'Load', value: 92 },
        ],
      },
    ],
  };
}

test('LHM snapshot maps Intel global GPU load while keeping system and device sensors', () => {
  const sample = mapLibreHardwareMonitorSnapshot(snapshot(), {
    pciVendorId: '0x8086',
    pciDeviceId: '0x0000E20B',
  });
  assert.equal(sample.telemetryProvider, LIBRE_HARDWARE_MONITOR_SOURCE);
  assert.equal(sample.telemetryProviderVersion, LIBRE_HARDWARE_MONITOR_VERSION);
  assert.equal(sample.cpuUtilPct, 44);
  assert.equal(sample.cpuFreqMhz, 4000);
  assert.equal(sample.memoryUsedBytes, 12.5 * 1024 ** 3);
  assert.equal(sample.gpuClockMhz, 3000);
  assert.equal(sample.powerW, 158);
  assert.deepEqual(sample.fanRpm, [1200]);
  assert.equal(sample.gpuMemUsedBytes, 2048 * 1024 ** 2);
  assert.equal(sample.gpuUtilPct, 8, 'use device-wide GPU Core load, not component or memory load');
  assert.equal(sample.gpuUtilSource, 'libre-hardware-monitor');
});

test('LHM Intel GPU load accepts zero and rejects invalid percentages', () => {
  const payload = snapshot();
  const gpu = payload.hardware.find((row) => row.type === 'GpuIntel');
  const coreLoad = gpu.sensors.find((sensor) => sensor.type === 'Load' && sensor.name === 'GPU Core');
  coreLoad.value = 0;
  let sample = mapLibreHardwareMonitorSnapshot(payload, {
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  });
  assert.equal(sample.gpuUtilPct, 0, 'zero is a valid utilization sample');

  coreLoad.value = 100.1;
  sample = mapLibreHardwareMonitorSnapshot(payload, {
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  });
  assert.equal(sample.gpuUtilPct, null);
  assert.equal(sample.gpuUtilSource, null);
});

test('LHM Intel GPU load rejects retained values from a poll that did not refresh the sensor', () => {
  const payload = snapshot();
  const gpu = payload.hardware.find((row) => row.type === 'GpuIntel');
  const coreLoad = gpu.sensors.find((sensor) => sensor.type === 'Load' && sensor.name === 'GPU Core');
  coreLoad.value = 82;
  coreLoad.fresh = false;

  let sample = mapLibreHardwareMonitorSnapshot(payload, {
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  });
  assert.equal(sample.gpuUtilPct, null);
  assert.equal(sample.gpuUtilSource, null);

  // Older/partial bridge responses cannot prove the value was refreshed,
  // even when their top-level snapshot timestamp is current.
  delete coreLoad.fresh;
  sample = mapLibreHardwareMonitorSnapshot(payload, {
    pciVendorId: '0x8086',
    pciDeviceId: '0xE20B',
  });
  assert.equal(sample.gpuUtilPct, null);
  assert.equal(sample.gpuUtilSource, null);
});

test('LHM GPU load is not used for non-Intel adapters', () => {
  const payload = snapshot();
  payload.hardware.push({
    identifier: '/gpu-amd/0x73FF',
    name: 'AMD GPU',
    type: 'GpuAmd',
    sensors: [{ name: 'GPU Core', type: 'Load', value: 64 }],
  });
  const sample = mapLibreHardwareMonitorSnapshot(payload, {
    pciVendorId: '0x1002',
    pciDeviceId: '0x73FF',
  });
  assert.equal(sample.gpuUtilPct, null);
  assert.equal(sample.gpuUtilSource, null);
});

test('LHM Intel GPU utilization requires a unique PCI identity and exact stable adapter key', () => {
  const target = {
    id: 0,
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_12345678',
    pciVendorId: '0x00008086',
    pciDeviceId: '0x0000E20B',
  };
  const secondIdenticalCard = {
    ...target,
    id: 1,
    deviceKey: 'pnp:PCI\\VEN_8086&DEV_E20B&SUBSYS_87654321',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_87654321',
  };

  assert.equal(lhmGpuUtilizationTargetIsUnique(target, [target]), true);
  assert.equal(
    lhmGpuUtilizationTargetIsUnique(target, [target, secondIdenticalCard]),
    false,
    'a single LHM row cannot identify which of two same-PCI-ID cards produced the load sample',
  );
  assert.equal(
    lhmGpuUtilizationTargetIsUnique({ ...target, deviceKey: 'pnp:another-adapter' }, [target]),
    false,
    'a matching PCI ID without an exact inventory key is not sufficient physical identity',
  );
});

test('LHM GPU hotspot-only temperature does not map to VRAM temperature', () => {
  const payload = snapshot();
  payload.hardware.find((row) => row.type === 'GpuIntel').sensors.push(
    { name: 'GPU Hot Spot', type: 'Temperature', value: 86 },
    { name: 'GPU Junction', type: 'Temperature', value: 87 },
  );
  const sample = mapLibreHardwareMonitorSnapshot(payload, {
    pciVendorId: '0x8086',
    pciDeviceId: '0x0000E20B',
  });
  assert.equal(sample.vramTempC, null);
});

test('LHM GPU explicit memory temperature maps to VRAM temperature', () => {
  const payload = snapshot();
  payload.hardware.find((row) => row.type === 'GpuIntel').sensors.push(
    { name: 'Memory Junction', type: 'Temperature', value: 74 },
  );
  const sample = mapLibreHardwareMonitorSnapshot(payload, {
    pciVendorId: '0x8086',
    pciDeviceId: '0x0000E20B',
  });
  assert.equal(sample.vramTempC, 74);
});

test('LHM GPU mapping refuses duplicate PCI device ids instead of using ordinal identity', () => {
  const payload = snapshot();
  payload.hardware.push({
    ...payload.hardware.find((row) => row.type === 'GpuIntel'),
    identifier: '/gpu-intel/0xE20B/duplicate',
  });
  const sample = mapLibreHardwareMonitorSnapshot(payload, {
    pciVendorId: '0x8086',
    pciDeviceId: '0x0000E20B',
  });
  assert.equal(sample.gpuClockMhz, null);
  assert.equal(sample.gpuMemUsedBytes, null);
  assert.equal(sample.gpuUtilPct, null);
});

test('LHM provider reports an absent bridge without falling back to old samplers', async () => {
  const provider = createLhmTelemetry({ runtimeDirectory: 'C:\\path-that-does-not-exist' });
  assert.equal(provider.available(), false);
  assert.equal(await provider.sampleForTarget({ pciDeviceId: '0xE20B' }), null);
  assert.equal(provider.status().running, false);
  await provider.close();
});
