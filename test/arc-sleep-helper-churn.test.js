import assert from 'node:assert/strict';
import test from 'node:test';
import koffi from 'koffi';
import { createArcSleepController } from '../src/main/arc-sleep-controller.js';
import { createArcSleepIGCLLimiter } from '../src/main/arc-sleep-igcl-limiter.js';
import { createUnifiedGpuBackend } from '../src/main/gpu-inventory.js';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import { CTL_3D_FEATURE, CTL_PROPERTY_VALUE_TYPE, CTL_RESULT } from '../src/main/backend/igcl-bindings.js';

const luid = '0000000000001234';
const intel = {
  name: 'Intel(R) Arc(TM) B580 Graphics',
  pnpDeviceId: 'PCI\\VEN_8086&DEV_E20B',
  pciVendorId: '0x8086',
  pciDeviceId: '0xe20b',
  bdf: '0000:03:00.0',
  luid,
};
const amd = {
  name: 'AMD Radeon(TM) Graphics',
  pnpDeviceId: 'PCI\\VEN_1002&DEV_164E',
  pciVendorId: '0x1002',
  pciDeviceId: '0x164e',
  bdf: '0000:00:08.0',
  luid: '0000000000000010',
};

test('idle Arc Sleep ticks do not query the legacy sharpening helper through the production backend chain', async (t) => {
  let nativeReads = 0;
  let sharpeningReads = 0;
  let scheduledTick;
  const fakeLib = {
    ctlGetSupported3DCapabilities() { throw new Error('frame-limit capabilities should use the seeded cache'); },
    ctlGetSet3DFeature(_handle, buffer) {
      const bSetOffset = koffi.offsetof('ctl_3d_feature_getset_t', 'bSet');
      const valueOffset = koffi.offsetof('ctl_3d_feature_getset_t', 'Value');
      assert.equal(koffi.decode(buffer, bSetOffset, 'bool'), false, 'the regression only performs native reads');
      nativeReads += 1;
      koffi.encode(buffer, valueOffset, 'bool', true);
      koffi.encode(buffer, valueOffset + 4, 'int32', 60);
      return CTL_RESULT.SUCCESS;
    },
  };
  const igcl = new IgclBackend({
    lib: fakeLib,
    sharpening: { async run({ action }) { assert.equal(action, 'read'); sharpeningReads += 1; return { ok: false, supported: false }; } },
    fanProbe: false,
    sharedMemoryOverride: null,
    displayModeController: null,
    vrrRegistry: null,
  });
  igcl._devices = [{
    id: 0,
    ...intel,
    type: 'GRAPHICS',
    handle: {},
    integrated: false,
    mobile: false,
  }];
  igcl._graphicsCapsCache.set(0, new Map([[
    CTL_3D_FEATURE.FRAME_LIMIT,
    { featureType: CTL_3D_FEATURE.FRAME_LIMIT, valueType: CTL_PROPERTY_VALUE_TYPE.INT32, intRange: { min: 1, max: 1000, step: 1 }, liveChange: true },
  ]]));
  const backendReads = [];
  const actualGetGraphicsSettings = igcl.getGraphicsSettings.bind(igcl);
  igcl.getGraphicsSettings = (deviceId, options) => {
    backendReads.push({ deviceId, options });
    return actualGetGraphicsSettings(deviceId, options);
  };

  const backend = createUnifiedGpuBackend({ backend: igcl, videoControllers: [amd, intel] });
  const devices = await backend.listDevices();
  const selected = devices.find((device) => device.backendKind === 'igcl');
  assert.ok(selected, 'the Intel adapter should be available in the unified inventory');
  const settings = {
    deviceKey: selected.deviceKey,
    arcSleep: { idleEnabled: false, adaptiveEnabled: false },
    arcSleepFrameLimitBase: { enabled: false, value: 60 },
    arcSleepJournal: null,
  };
  const store = {
    async loadSettings() { return settings; },
    async saveArcSleepState() {},
  };
  const limiter = createArcSleepIGCLLimiter({
    backend,
    store,
    applyRunner: { async graphicsApplyIsolated() { throw new Error('policies-off ticks must not write the GPU'); } },
    isElevated: () => false,
  });
  let rtssReads = 0;
  const controller = createArcSleepController({
    store,
    rtssFrameLimiter: {
      async getFrameLimit() { rtssReads += 1; return { ok: false, available: false, errorCode: 'unavailable' }; },
      async applyFrameLimit() { throw new Error('RTSS-unavailable ticks must not write'); },
    },
    igclFrameLimiter: limiter,
    setIntervalFn(callback) { scheduledTick = callback; return 1; },
    clearIntervalFn() {},
    intervalMs: 1000,
  });

  await controller.start();
  assert.equal(typeof scheduledTick, 'function');
  const initialBackendReads = backendReads.length;
  const initialNativeReads = nativeReads;
  for (let i = 0; i < 5; i += 1) await controller.tick();
  await controller.stop();

  const measuredReads = backendReads.slice(initialBackendReads);
  assert.ok(measuredReads.length > 0, 'controller ticks should continue fresh native frame-limit reads');
  assert.ok(nativeReads > initialNativeReads, 'each tick path should reach the live IGCL frame-limit read');
  assert.ok(rtssReads >= 1, 'startup should observe RTSS unavailability');
  assert.ok(measuredReads.every(({ deviceId }) => deviceId === 0), 'AMD OS-only rows must never be forwarded to IGCL');
  assert.ok(measuredReads.every(({ options }) => options?.includeLegacySharpening === false), 'all Arc Sleep reads must opt out of the legacy helper');
  assert.equal(sharpeningReads, 0, 'idle policies, disabled base cap, and empty journal must launch no legacy helper reads');
  t.diagnostic(`5 ticks: ${measuredReads.length} fresh IGCL frame-limit reads, ${sharpeningReads} sharpening helper reads`);
});
