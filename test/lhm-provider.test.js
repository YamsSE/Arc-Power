import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIBRE_HARDWARE_MONITOR_SOURCE,
  LIBRE_HARDWARE_MONITOR_VERSION,
  createLhmTelemetry,
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
          // The hybrid deliberately ignores this LHM load sensor.
          { name: 'GPU Core', type: 'Load', value: 8 },
        ],
      },
    ],
  };
}

test('LHM snapshot maps system and selected-GPU sensors without using LHM GPU load', () => {
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
  assert.equal(sample.gpuUtilPct, undefined);
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
});

test('LHM provider reports an absent bridge without falling back to old samplers', async () => {
  const provider = createLhmTelemetry({ runtimeDirectory: 'C:\\path-that-does-not-exist' });
  assert.equal(provider.available(), false);
  assert.equal(await provider.sampleForTarget({ pciDeviceId: '0xE20B' }), null);
  assert.equal(provider.status().running, false);
  await provider.close();
});
