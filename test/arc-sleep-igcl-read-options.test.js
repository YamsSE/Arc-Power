import assert from 'node:assert/strict';
import test from 'node:test';
import koffi from 'koffi';
import { createArcSleepIGCLLimiter } from '../src/main/arc-sleep-igcl-limiter.js';
import { createUnifiedGpuBackend } from '../src/main/gpu-inventory.js';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import { CTL_3D_FEATURE, CTL_RESULT } from '../src/main/backend/igcl-bindings.js';

const pnp = 'PCI\\VEN_8086&DEV_56A0&SUBSYS_12345678';
const bdf = '0000:03:00.0';
const adapter = { id: 7, name: 'Intel Arc GPU', pciVendorId: '0x8086', pciDeviceId: '0x56a0', bdf, pnpDeviceId: pnp };

function graphics(frameValue) {
  return {
    supported: { frameLimit: true },
    values: { frameLimit: { enabled: true, value: frameValue } },
    frameLimitRange: { min: 30, max: 300, step: 1, default: 60 },
  };
}

test('Arc Sleep limiter forwards legacy sharpening opt-out through unified routing and keeps frame reads fresh', async () => {
  const reads = [];
  let frameValue = 60;
  const rawBackend = {
    kind: 'igcl',
    async listDevices() { return [adapter]; },
    async getGraphicsSettings(id, options) {
      reads.push({ id, options });
      return graphics(frameValue);
    },
  };
  const backend = createUnifiedGpuBackend({
    backend: rawBackend,
    videoControllers: [{ ...adapter }],
  });
  const [selectedDevice] = await backend.listDevices();
  const limiter = createArcSleepIGCLLimiter({
    backend,
    store: { async loadSettings() { return { deviceKey: selectedDevice.deviceKey }; } },
  });

  const first = await limiter.getFrameLimit();
  frameValue = 77;
  const second = await limiter.getFrameLimit();

  assert.equal(first.ok, true, first.error);
  assert.equal(first.limit, 60);
  assert.equal(second.ok, true);
  assert.equal(second.limit, 77, 'each limiter read must observe the newest native frame-limit value');
  assert.equal(reads.length, 2);
  assert.deepEqual(reads.map((read) => read.id), [7, 7], 'the wrapper must route to the backend-local device id');
  assert.deepEqual(reads.map((read) => read.options), [
    { includeLegacySharpening: false },
    { includeLegacySharpening: false },
  ]);
});

test('unified wrapper preserves default legacy Graphics reads and does not forward options to OS-only rows', async () => {
  const reads = [];
  const rawBackend = {
    kind: 'igcl',
    async listDevices() { return [adapter]; },
    async getGraphicsSettings(id, options) {
      reads.push({ id, options });
      return graphics(60);
    },
  };
  const backend = createUnifiedGpuBackend({
    backend: rawBackend,
    videoControllers: [{ ...adapter }, { id: 20, name: 'AMD Radeon Graphics', pciVendorId: '0x1002', pciDeviceId: '0x164e', pnpDeviceId: 'PCI\\VEN_1002&DEV_164E' }],
  });
  const devices = await backend.listDevices();
  const intel = devices.find((device) => device.backendKind === 'igcl');
  const osOnly = devices.find((device) => device.backendKind === 'os');

  await backend.getGraphicsSettings(intel.id);
  const osState = await backend.getGraphicsSettings(osOnly.id, { includeLegacySharpening: false });

  assert.deepEqual(reads, [{ id: 7, options: {} }]);
  assert.equal(osState.supported.frameLimit, false);
});

test('IGCL Graphics reads skip the legacy helper only when explicitly requested and keep native reads uncached', async () => {
  let legacyReads = 0;
  let frameLimitReadAttempts = 0;
  const backend = new IgclBackend({
    lib: {
      ctlGetSupported3DCapabilities() { return CTL_RESULT.SUCCESS; },
      ctlGetSet3DFeature(_device, featureBuffer) {
        if (koffi.decode(featureBuffer, koffi.offsetof('ctl_3d_feature_getset_t', 'FeatureType'), 'int32') === CTL_3D_FEATURE.FRAME_LIMIT) {
          frameLimitReadAttempts += 1;
        }
        return CTL_RESULT.ERROR_NOT_AVAILABLE;
      },
    },
    sharpening: { async run() { legacyReads += 1; return { ok: false, supported: false }; } },
  });
  backend._device = async () => ({ name: 'Intel Arc GPU', handle: {}, luid: 1 });
  backend._graphicsCapsOf = async () => new Map([[
    CTL_3D_FEATURE.FRAME_LIMIT,
    { intRange: { min: 30, max: 300, step: 1, default: 60 }, liveChange: true },
  ]]);

  await backend.getGraphicsSettings(7);
  assert.equal(legacyReads, 1, 'manual Graphics reads retain legacy sharpening by default');
  await backend.getGraphicsSettings(7, { includeLegacySharpening: false });
  assert.equal(legacyReads, 1, 'limiter reads do not spawn the legacy sharpening helper');
  assert.equal(frameLimitReadAttempts, 2, 'each call performs a fresh native frame-limit read');
});

function writeTelemetry(buffer, type, timestamp = 12) {
  const item = (value, units) => ({ bSupported: true, units, type: 9, value });
  koffi.encode(buffer, type, {
    Size: koffi.sizeof(type),
    Version: 1,
    timeStamp: item(timestamp, 7),
    gpuCurrentClockFrequency: item(1750, 0),
    gpuCurrentTemperature: item(61, 5),
  });
}

test('IGCL raw telemetry uses GC-owned native buffers on V2 success, V1 fallback, and error', async () => {
  let v2Calls = 0;
  const successfulV2 = new IgclBackend({ lib: {
    ctlPowerTelemetryGetV2(_device, buffer) {
      assert.ok(Buffer.isBuffer(buffer));
      v2Calls += 1;
      writeTelemetry(buffer, 'ctl_power_telemetry_v2_t');
      return CTL_RESULT.SUCCESS;
    },
  } });
  successfulV2._device = async () => ({ handle: {}, integrated: false, mobile: false });
  for (let i = 0; i < 40; i += 1) {
    const sample = await successfulV2.sampleRawTelemetry(7);
    assert.equal(sample.gpuClockMhz, 1750);
    assert.equal(sample.tempC, 61);
    assert.equal(sample.t, 12);
  }
  assert.equal(v2Calls, 40);

  let fallbackV1Calls = 0;
  const fallback = new IgclBackend({ lib: {
    ctlPowerTelemetryGetV2(_device, buffer) {
      assert.ok(Buffer.isBuffer(buffer));
      return CTL_RESULT.ERROR_NOT_AVAILABLE;
    },
    ctlPowerTelemetryGet(_device, buffer) {
      assert.ok(Buffer.isBuffer(buffer));
      fallbackV1Calls += 1;
      writeTelemetry(buffer, 'ctl_power_telemetry_t', 13);
      return CTL_RESULT.SUCCESS;
    },
  } });
  fallback._device = async () => ({ handle: {}, integrated: false, mobile: false });
  const fallbackSample = await fallback.sampleRawTelemetry(7);
  assert.equal(fallbackSample.gpuClockMhz, 1750);
  assert.equal(fallbackSample.tempC, 61);
  assert.equal(fallbackSample.t, 13);
  assert.equal(fallbackV1Calls, 1);

  const failed = new IgclBackend({ lib: {
    ctlPowerTelemetryGetV2(_device, buffer) {
      assert.ok(Buffer.isBuffer(buffer));
      return CTL_RESULT.ERROR_DEVICE_LOST;
    },
  } });
  failed._device = async () => ({ handle: {}, integrated: false, mobile: false });
  await assert.rejects(() => failed.sampleRawTelemetry(7), /ctlPowerTelemetryGetV2 failed/);
});

test('IGCL temperature sensor enumeration uses GC-owned buffers and preserves first-sensor fallback and error results', () => {
  let propertyCalls = 0;
  let temperatureCalls = 0;
  const backend = new IgclBackend({ lib: {
    ctlEnumTemperatureSensors(_device, countBuffer, handlesBuffer) {
      assert.ok(Buffer.isBuffer(countBuffer));
      if (handlesBuffer === null) {
        koffi.encode(countBuffer, 0, 'uint32', 2);
        return CTL_RESULT.SUCCESS;
      }
      assert.ok(Buffer.isBuffer(handlesBuffer));
      assert.equal(handlesBuffer.byteLength, koffi.sizeof('void*') * 2);
      koffi.encode(handlesBuffer, 0, 'void*', 0x1111n);
      koffi.encode(handlesBuffer, koffi.sizeof('void*'), 'void*', 0x2222n);
      return CTL_RESULT.SUCCESS;
    },
    ctlTemperatureGetProperties(_handle, propertiesBuffer) {
      assert.ok(Buffer.isBuffer(propertiesBuffer));
      propertyCalls += 1;
      return CTL_RESULT.ERROR_NOT_AVAILABLE;
    },
    ctlTemperatureGetState(handle, temperatureBuffer) {
      assert.ok(Buffer.isBuffer(temperatureBuffer));
      temperatureCalls += 1;
      assert.equal(koffi.address(handle), 0x1111n, 'when GPU-domain classification is unavailable, retain the first-sensor fallback');
      koffi.encode(temperatureBuffer, 0, 'double', 62.5);
      return CTL_RESULT.SUCCESS;
    },
  } });
  for (let i = 0; i < 40; i += 1) {
    assert.equal(backend._temperatureSensorTempC({ handle: {} }, 7), 62.5);
  }
  assert.equal(propertyCalls, 80);
  assert.equal(temperatureCalls, 40);

  const failed = new IgclBackend({ lib: {
    ctlEnumTemperatureSensors(_device, countBuffer, handlesBuffer) {
      assert.ok(Buffer.isBuffer(countBuffer));
      if (handlesBuffer === null) koffi.encode(countBuffer, 0, 'uint32', 1);
      return handlesBuffer === null ? CTL_RESULT.SUCCESS : CTL_RESULT.ERROR_DEVICE_LOST;
    },
    ctlTemperatureGetState() { assert.fail('state must not be read after failed enumeration'); },
  } });
  assert.equal(failed._temperatureSensorTempC({ handle: {} }, 8), undefined);
});
