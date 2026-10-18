import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import koffi from 'koffi';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import {
  CTL_RESULT,
  encodeDisplayProperties,
  encodeScalingSettings,
  decodeScalingSettings,
} from '../src/main/backend/igcl-bindings.js';

const DEVICE_HANDLE = 0x1234n;
const DISPLAY_HANDLE = 0x5678n;
const ENCODER_ID = Buffer.alloc(16);
Buffer.from('b580-scaling-id').copy(ENCODER_ID);
const BLOCK_SIZE = 144;

function read(buffer, offset, type) {
  return koffi.decode(buffer, offset, type);
}

function write(buffer, offset, type, value) {
  koffi.encode(buffer, offset, type, value);
}

function blockAt(pointer, index, count) {
  return new Uint8Array(koffi.view(pointer, BLOCK_SIZE * count), index * BLOCK_SIZE, BLOCK_SIZE);
}

function displayProperties() {
  const { buf } = encodeDisplayProperties();
  const put = (field, type, value) => write(buf, koffi.offsetof('ctl_display_properties_t', field), type, value);
  for (let index = 0; index < ENCODER_ID.length; index += 1) {
    write(buf, koffi.offsetof('ctl_display_properties_t', 'Os_display_encoder_handle') + index, 'uint8', ENCODER_ID[index]);
  }
  put('Type', 'int32', 1); // DisplayPort
  put('DisplayConfigFlags', 'uint32', 3); // active + attached
  const timing = koffi.offsetof('ctl_display_properties_t', 'Display_Timing_Info');
  write(buf, timing + koffi.offsetof('ctl_display_timing_t', 'HActive'), 'uint32', 1920);
  write(buf, timing + koffi.offsetof('ctl_display_timing_t', 'VActive'), 'uint32', 1080);
  write(buf, timing + koffi.offsetof('ctl_display_timing_t', 'HTotal'), 'uint32', 2200);
  write(buf, timing + koffi.offsetof('ctl_display_timing_t', 'VTotal'), 'uint32', 1125);
  write(buf, timing + koffi.offsetof('ctl_display_timing_t', 'RefreshRate'), 'float', 60);
  return buf;
}

function defaultNativeScaling(overrides = {}) {
  return {
    enable: true,
    scalingType: 1,
    preferredScalingType: 8,
    customX: 0,
    customY: 0,
    hardwareModeSet: false,
    ...overrides,
  };
}

function fakeIGCL({ initialScaling, initialRetro = { enable: false, retroScalingType: 0 }, setBehavior = 'normal' } = {}) {
  let nativeScaling = defaultNativeScaling(initialScaling);
  let retroState = { ...initialRetro };
  const writes = [];
  const retroWrites = [];
  const nativeCalls = [];
  const registryCalls = [];
  const blocks = [
    { id: 392964, type: 1, sampleCount: 4, channels: 3 },
    { id: 392965, type: 3 },
  ];
  const registry = {
    async getScalingState() { registryCalls.push('getScalingState'); throw new Error('Scaling must not query the Windows registry'); },
    async setScalingState() { registryCalls.push('setScalingState'); throw new Error('Scaling must not write the Windows registry'); },
  };
  const lib = {
    ctlEnumerateDisplayOutputs() { return CTL_RESULT.SUCCESS; },
    ctlGetDisplayProperties(_handle, output) {
      const props = displayProperties();
      for (let index = 0; index < koffi.sizeof('ctl_display_properties_t'); index += 1) {
        write(output, index, 'uint8', read(props, index, 'uint8'));
      }
      return CTL_RESULT.SUCCESS;
    },
    ctlGetSupportedScalingCapability(_handle, output) {
      write(output, koffi.offsetof('ctl_scaling_caps_t', 'SupportedScaling'), 'uint32', 0x1f);
      return CTL_RESULT.SUCCESS;
    },
    ctlGetCurrentScaling(_handle, buffer) {
      const version = read(buffer, 4, 'uint8');
      const current = encodeScalingSettings({
        enable: nativeScaling.enable,
        scalingType: nativeScaling.scalingType,
        customScalingX: nativeScaling.customX,
        customScalingY: nativeScaling.customY,
        hardwareModeSet: nativeScaling.hardwareModeSet,
        preferredScalingType: nativeScaling.preferredScalingType,
        version,
      });
      for (let index = 0; index < koffi.sizeof('ctl_scaling_settings_t'); index += 1) {
        write(buffer, index, 'uint8', read(current.buf, index, 'uint8'));
      }
      return CTL_RESULT.SUCCESS;
    },
    ctlSetCurrentScaling(_handle, buffer) {
      const requested = decodeScalingSettings(buffer);
      writes.push({ ...requested, version: read(buffer, 4, 'uint8') });
      nativeCalls.push({ kind: 'scaling-set', requested: { ...requested } });
      if (setBehavior === 'reject') return CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS;
      if (setBehavior === 'noop') return CTL_RESULT.SUCCESS;
      if (requested.scalingType === 1) {
        nativeScaling = { ...nativeScaling, enable: true, scalingType: 1 };
      } else if ([2, 4, 8].includes(requested.scalingType)) {
        // IGS-style GPU mode is deferred: the selected method is preferred,
        // while current output timing remains unchanged at 1080p.
        nativeScaling = { ...nativeScaling, enable: true, scalingType: 1, preferredScalingType: requested.scalingType };
      } else if (requested.scalingType === 16) {
        nativeScaling = {
          ...nativeScaling,
          enable: true,
          scalingType: 16,
          customX: requested.customX,
          customY: requested.customY,
          hardwareModeSet: requested.hardwareModeSet,
        };
      }
      return CTL_RESULT.SUCCESS;
    },
    ctlGetSupportedRetroScalingCapability(_handle, output) {
      write(output, koffi.offsetof('ctl_retro_scaling_caps_t', 'SupportedRetroScaling'), 'uint32', 3);
      return CTL_RESULT.SUCCESS;
    },
    ctlGetSetRetroScaling(_handle, buffer) {
      const get = read(buffer, koffi.offsetof('ctl_retro_scaling_settings_t', 'Get'), 'bool');
      if (get) {
        write(buffer, koffi.offsetof('ctl_retro_scaling_settings_t', 'Enable'), 'bool', retroState.enable);
        write(buffer, koffi.offsetof('ctl_retro_scaling_settings_t', 'RetroScalingType'), 'uint32', retroState.retroScalingType);
      } else {
        const requested = {
          enable: read(buffer, koffi.offsetof('ctl_retro_scaling_settings_t', 'Enable'), 'bool'),
          retroScalingType: read(buffer, koffi.offsetof('ctl_retro_scaling_settings_t', 'RetroScalingType'), 'uint32'),
        };
        retroWrites.push(requested);
        nativeCalls.push({ kind: 'retro-set', requested: { ...requested } });
        retroState = requested;
      }
      return CTL_RESULT.SUCCESS;
    },
    ctlPixelTransformationGetConfig(_handle, pipe) {
      if (read(pipe, 256, 'uint32') === 0) {
        write(pipe, 256, 'uint32', blocks.length);
        return CTL_RESULT.ERROR_INVALID_SIZE;
      }
      const count = read(pipe, 256, 'uint32');
      const pointer = read(pipe, 264, 'void*');
      blocks.forEach((block, index) => {
        const view = blockAt(pointer, index, count);
        write(view, 0, 'uint32', BLOCK_SIZE);
        write(view, 4, 'uint8', 0);
        write(view, 8, 'uint32', block.id);
        write(view, 12, 'uint32', block.type);
        if (block.type === 3) {
          write(view, 16, 'uint32', 128);
          for (let value = 0; value < 9; value += 1) write(view, 72 + value * 8, 'double', value % 4 === 0 ? 1 : 0);
        } else {
          write(view, 16, 'uint32', 40);
          write(view, 24, 'uint32', 0);
          write(view, 28, 'uint32', block.sampleCount);
          write(view, 32, 'uint32', block.channels);
        }
      });
      return CTL_RESULT.SUCCESS;
    },
    ctlPixelTransformationSetConfig() { return CTL_RESULT.SUCCESS; },
  };
  return {
    lib,
    writes,
    registry,
    registryCalls,
    current: () => ({ ...nativeScaling }),
    currentRetro: () => ({ ...retroState }),
    retroWrites,
    nativeCalls,
    replaceCurrent(next) { nativeScaling = { ...next }; },
  };
}

const PHYSICAL = {
  name: 'Intel Arc B580',
  pciVendorId: '0x00008086',
  pciDeviceId: '0x0000e20b',
  bdf: { bus: 3, device: 0, function: 0 },
  handle: DEVICE_HANDLE,
};

function makeBackend(dir, { deviceKey = 'main-pnp-key', ...fixtureOptions } = {}) {
  const fake = fakeIGCL(fixtureOptions);
  const backend = new IgclBackend({
    lib: fake.lib,
    displayScalingStateDir: dir,
    displayColorStateDir: path.join(dir, 'color'),
    fanProbe: false,
    vrrRegistry: fake.registry,
  });
  const device = { ...PHYSICAL, deviceKey };
  backend._device = async () => device;
  backend._displayOutputsOf = async () => [DISPLAY_HANDLE];
  return { backend, ...fake, device };
}

async function fixture(t, options, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-display-scaling-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await callback({ dir, ...makeBackend(dir, options) });
}

function displayRequest(display, deviceKey, patch) {
  return { deviceKey, displayKey: display.displayKey, patch };
}

test('GET reports deferred GPU preference and disabled Retro without issuing SETs or registry calls', async (t) => {
  await fixture(t, {}, async ({ backend, writes, registryCalls }) => {
    const first = (await backend.getDisplaySettings(0)).displays[0];
    const second = (await backend.getDisplaySettings(0)).displays[0];
    assert.equal(first.scalingMode, 'identity');
    assert.equal(first.preferredScalingMode, 'aspect-ratio-centered-max');
    assert.equal(first.scalingPreference, 'gpu-scaling');
    assert.equal(first.scalingPreferenceSource, 'igcl-preferred');
    assert.deepEqual(first.scalingMethod.value, { enabled: false, method: null });
    assert.equal(first.scalingMethod.controllable, true);
    assert.equal(second.scalingPreference, 'gpu-scaling');
    assert.equal(writes.length, 0);
    assert.deepEqual(registryCalls, []);
  });
});

test('GPU Scaling remains deferred and Display Identity persists across public adapter aliases', async (t) => {
  await fixture(t, {}, async ({ dir, backend: main, writes, registryCalls, current }) => {
    const before = (await main.getDisplaySettings(0)).displays[0];
    const appliedGpu = await main.setDisplaySettings(0, displayRequest(before, 'main-pnp-key', {
      scalingMode: 'aspect-ratio-centered-max',
    }));
    assert.equal(appliedGpu.perControl.scalingMode.ok, true);
    assert.equal(appliedGpu.perControl.scalingMode.deferred, true);
    assert.equal(appliedGpu.perControl.scalingMode.verification, 'native-preference');
    assert.equal(writes.at(-1).scalingType, 8);

    const displayApply = await main.setDisplaySettings(0, displayRequest(before, 'main-pnp-key', {
      scalingMode: 'identity',
    }));
    assert.equal(displayApply.perControl.scalingMode.ok, true);
    assert.equal(writes.at(-1).scalingType, 1);
    assert.equal(current().preferredScalingType, 8);

    const worker = makeBackend(dir, { deviceKey: 'worker-pci-key' });
    const workerDisplay = (await worker.backend.getDisplaySettings(0)).displays[0];
    assert.equal(workerDisplay.displayKey.startsWith('worker-pci-key|display|'), true);
    assert.equal(workerDisplay.scalingPreference, 'display-scaling');
    assert.equal(workerDisplay.scalingPreferenceSource, 'arc-selection');
    assert.equal(workerDisplay.preferredScalingMode, 'aspect-ratio-centered-max');
    assert.equal(workerDisplay.scalingMode, 'identity');
    assert.equal(fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).length, 1);
    assert.deepEqual(registryCalls, []);
  });
});

test('external GPU preference changes invalidate Display Identity persistently', async (t) => {
  await fixture(t, {}, async ({ dir, backend, current, replaceCurrent }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    const applied = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', { scalingMode: 'identity' }));
    assert.equal(applied.perControl.scalingMode.ok, true);
    assert.equal(current().preferredScalingType, 8);

    replaceCurrent({ ...current(), preferredScalingType: 4 });
    const changedExternally = (await backend.getDisplaySettings(0)).displays[0];
    assert.equal(changedExternally.preferredScalingMode, 'stretched');
    assert.equal(changedExternally.scalingPreference, 'gpu-scaling');
    assert.notEqual(changedExternally.scalingPreferenceSource, 'arc-selection');

    replaceCurrent({ ...current(), preferredScalingType: 8 });
    const later = makeBackend(dir, { deviceKey: 'worker-pci-key' });
    const returnedToOldPreference = (await later.backend.getDisplaySettings(0)).displays[0];
    assert.equal(returnedToOldPreference.preferredScalingMode, 'aspect-ratio-centered-max');
    assert.equal(returnedToOldPreference.scalingPreference, 'gpu-scaling');
    assert.notEqual(returnedToOldPreference.scalingPreferenceSource, 'arc-selection');
  });
});

test('active Custom takes precedence over stale GPU preference and remembers its percentages', async (t) => {
  await fixture(t, {}, async ({ backend, current, replaceCurrent }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    const applied = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', { scalingMode: 'identity' }));
    assert.equal(applied.perControl.scalingMode.ok, true);
    replaceCurrent({ ...current(), scalingType: 16, customX: 16, customY: 95, hardwareModeSet: true, preferredScalingType: 8 });
    const activeCustom = (await backend.getDisplaySettings(0)).displays[0];
    assert.equal(activeCustom.scalingMode, 'custom');
    assert.equal(activeCustom.scalingPreference, 'display-scaling');
    assert.equal(activeCustom.scalingPreferenceSource, null);
    assert.deepEqual(activeCustom.scalingDetails && {
      customX: activeCustom.scalingDetails.customX,
      customY: activeCustom.scalingDetails.customY,
      preferredScalingType: activeCustom.scalingDetails.preferredScalingType,
    }, { customX: 16, customY: 95, preferredScalingType: 'aspect-ratio-centered-max' });
  });
});

test('Custom 95 percent initializes at 100 then applies 95 once despite its paired alias', async (t) => {
  await fixture(t, { initialScaling: { preferredScalingType: 8 } }, async ({ backend, writes, current }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    const result = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', {
      scalingMode: 'custom',
      displayScalingMethod: 'custom',
      scalingCustom: { x: 95, y: 95 },
    }));
    assert.equal(result.perControl.scalingMode.ok, true);
    assert.equal(result.perControl.displayScalingMethod.ok, true);
    assert.equal(result.perControl.displayScalingMethod.internal, true);
    assert.equal(writes.filter((entry) => entry.scalingType === 16).length, 2);
    assert.deepEqual(writes.filter((entry) => entry.scalingType === 16).map((entry) => [entry.customX, entry.customY]), [[100, 100], [95, 95]]);
    assert.deepEqual([current().customX, current().customY], [95, 95]);
  });
});

test('rejected or silent-no-op scaling SET does not persist an Arc editor selection', async (t) => {
  await fixture(t, { setBehavior: 'reject' }, async ({ dir, backend, writes }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    const rejected = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', { scalingMode: 'centered' }));
    assert.equal(rejected.perControl.scalingMode.ok, false);
    assert.equal(rejected.perControl.scalingMode.errorCode, 'permission-denied');
    assert.equal(writes.length, 1);
    assert.equal(fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).length, 0);
  });

  await fixture(t, { setBehavior: 'noop', initialScaling: { scalingType: 1, preferredScalingType: 1 } }, async ({ dir, backend, writes }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    const noOp = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', { scalingMode: 'centered' }));
    assert.equal(noOp.perControl.scalingMode.ok, false);
    assert.equal(noOp.perControl.scalingMode.silentNoop, true);
    assert.equal(writes.length, 2); // requested mode and verified rollback
    assert.equal(fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).length, 0);
  });
});

test('stale adapter/display target blocks a scaling SET', async (t) => {
  await fixture(t, {}, async ({ backend, writes }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    const wrongDevice = await backend.setDisplaySettings(0, displayRequest(display, 'different-device', { scalingMode: 'centered' }));
    assert.equal(wrongDevice.perControl.scalingMode.errorCode, 'stale-target');
    const wrongDisplay = await backend.setDisplaySettings(0, { ...displayRequest(display, 'main-pnp-key', { scalingMode: 'centered' }), displayKey: 'different-display' });
    assert.equal(wrongDisplay.perControl.scalingMode.errorCode, 'stale-target');
    assert.equal(writes.length, 0);
  });
});

test('entering Retro uses only the adapter API and reads the selected methods back', async (t) => {
  await fixture(t, {}, async ({ backend, writes, retroWrites, currentRetro, nativeCalls }) => {
    let display = (await backend.getDisplaySettings(0)).displays[0];
    assert.deepEqual(display.scalingMethod.value, { enabled: false, method: null });
    const integer = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', {
      scalingMode: 'identity',
      displayScalingMethod: 'integer',
      scalingMethod: { enabled: true, method: 'integer' },
    }));
    assert.equal(integer.perControl.scalingMethod.ok, true);
    assert.equal(integer.perControl.displayScalingMethod.internal, true);
    assert.equal(integer.perControl.scalingMode.internal, true);
    assert.equal(writes.length, 0, 'Retro selection must not SET ordinary output scaling');
    assert.deepEqual(retroWrites, [{ enable: true, retroScalingType: 1 }]);
    assert.deepEqual(nativeCalls.map((call) => call.kind), ['retro-set']);
    assert.deepEqual(currentRetro(), { enable: true, retroScalingType: 1 });

    display = (await backend.getDisplaySettings(0)).displays[0];
    assert.deepEqual(display.scalingMethod.value, { enabled: true, method: 'integer' });
    const nearest = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', {
      scalingMode: 'identity',
      displayScalingMethod: 'nearest-neighbour',
      scalingMethod: { enabled: true, method: 'nearest-neighbour' },
    }));
    assert.equal(nearest.perControl.scalingMethod.ok, true);
    assert.equal(nearest.perControl.displayScalingMethod.internal, true);
    assert.equal(writes.length, 0);
    assert.deepEqual(retroWrites, [
      { enable: true, retroScalingType: 1 },
      { enable: true, retroScalingType: 2 },
    ]);
    assert.deepEqual((await backend.getDisplaySettings(0)).displays[0].scalingMethod.value, {
      enabled: true,
      method: 'nearest-neighbour',
    });
  });
});

test('leaving Retro disables it before the ordinary GPU Scaling SET', async (t) => {
  await fixture(t, { initialRetro: { enable: true, retroScalingType: 2 } }, async ({ backend, writes, retroWrites, nativeCalls, currentRetro }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    assert.deepEqual(display.scalingMethod.value, { enabled: true, method: 'nearest-neighbour' });
    const result = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', {
      scalingMode: 'aspect-ratio-centered-max',
      displayScalingMethod: 'aspect-ratio-centered-max',
      scalingMethod: { enabled: false, method: 'nearest-neighbour' },
    }));
    assert.equal(result.perControl.scalingMethod.ok, true);
    assert.equal(result.perControl.scalingMode.ok, true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].scalingType, 8);
    assert.deepEqual(retroWrites, [{ enable: false, retroScalingType: 2 }]);
    assert.deepEqual(nativeCalls.map((call) => call.kind), ['retro-set', 'scaling-set']);
    assert.equal(currentRetro().enable, false);
  });
});

test('failed ordinary scaling after Retro disable restores the previous Retro method', async (t) => {
  await fixture(t, { initialRetro: { enable: true, retroScalingType: 2 }, setBehavior: 'reject' }, async ({ backend, writes, retroWrites, nativeCalls, currentRetro }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    const result = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', {
      scalingMode: 'aspect-ratio-centered-max',
      displayScalingMethod: 'aspect-ratio-centered-max',
      scalingMethod: { enabled: false, method: 'nearest-neighbour' },
    }));
    assert.equal(result.perControl.scalingMode.ok, false);
    assert.equal(result.perControl.scalingMode.errorCode, 'permission-denied');
    assert.equal(result.perControl.scalingMode.retroRestoreOk, true);
    assert.equal(writes.length, 1);
    assert.deepEqual(retroWrites, [
      { enable: false, retroScalingType: 2 },
      { enable: true, retroScalingType: 2 },
    ]);
    assert.deepEqual(nativeCalls.map((call) => call.kind), ['retro-set', 'scaling-set', 'retro-set']);
    assert.deepEqual(currentRetro(), { enable: true, retroScalingType: 2 });
  });
});

test('corrupt scaling selection state blocks a coupled Retro transition before any native writes', async (t) => {
  await fixture(t, { initialRetro: { enable: true, retroScalingType: 1 } }, async ({ dir, backend, writes, retroWrites, nativeCalls }) => {
    const display = (await backend.getDisplaySettings(0)).displays[0];
    const suffix = `display|${ENCODER_ID.toString('hex')}`;
    const namespace = 'pci:0x00008086:0x0000e20b@3:0.0';
    const stateKey = `${namespace}|${suffix}`;
    const file = path.join(dir, `${crypto.createHash('sha256').update(stateKey, 'utf8').digest('hex')}.json`);
    fs.writeFileSync(file, '{corrupt scaling state');

    const result = await backend.setDisplaySettings(0, displayRequest(display, 'main-pnp-key', {
      scalingMode: 'aspect-ratio-centered-max',
      displayScalingMethod: 'aspect-ratio-centered-max',
      scalingMethod: { enabled: false, method: 'integer' },
    }));
    assert.equal(result.perControl.scalingMode.ok, false);
    assert.equal(result.perControl.scalingMode.errorCode, 'io-failed');
    assert.equal(writes.length, 0);
    assert.equal(retroWrites.length, 0);
    assert.deepEqual(nativeCalls, []);
  });
});
