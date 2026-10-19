import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import koffi from 'koffi';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import { CTL_RESULT, encodeDisplayProperties } from '../src/main/backend/igcl-bindings.js';
import { matrixForHueSaturation } from '../src/main/backend/igcl-display-color.js';

const DEVICE_KEY = 'physical-b580';
const DEVICE_HANDLE = 0x1234n;
const DISPLAY_HANDLE = 0x5678n;
const DEFAULT_DEVICE = { deviceKey: DEVICE_KEY, name: 'Intel Arc B580', handle: DEVICE_HANDLE };
const ENCODER_ID = Buffer.alloc(16);
Buffer.from('b580-display-id').copy(ENCODER_ID);
const DISPLAY_KEY = `${DEVICE_KEY}|display|${ENCODER_ID.toString('hex')}`;
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
  for (let index = 0; index < 16; index += 1) {
    write(buf, koffi.offsetof('ctl_display_properties_t', 'Os_display_encoder_handle') + index, 'uint8', ENCODER_ID[index] ?? 0);
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

function fakeIGCL({ setResult = CTL_RESULT.SUCCESS, lutMetadata = {} } = {}) {
  const writes = [];
  const blocks = [
    { id: 392964, type: 1, samplingType: 0, sampleCount: 4, channels: 3, ...lutMetadata },
    { id: 392965, type: 3 },
  ];
  const lib = {
    ctlEnumerateDisplayOutputs() { return CTL_RESULT.SUCCESS; },
    ctlGetDisplayProperties(_handle, output) {
      const props = displayProperties();
      for (let index = 0; index < koffi.sizeof('ctl_display_properties_t'); index += 1) {
        write(output, index, 'uint8', read(props, index, 'uint8'));
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
          write(view, 24, 'uint32', block.samplingType);
          write(view, 28, 'uint32', block.sampleCount);
          write(view, 32, 'uint32', block.channels);
        }
      });
      return CTL_RESULT.SUCCESS;
    },
    ctlPixelTransformationSetConfig(handle, pipe) {
      const count = read(pipe, 16, 'uint32');
      const pointer = read(pipe, 24, 'void*');
      const selected = Buffer.from(blockAt(pointer, 0, count));
      const entry = { handle, operation: read(pipe, 8, 'uint32'), count, blockId: selected.readUInt32LE(8), blockType: selected.readUInt32LE(12), block: selected };
      if (entry.blockType === 1) {
        const samples = read(koffi.view(pointer, BLOCK_SIZE), 40, 'void*');
        const values = koffi.view(samples, 4 * 3 * 8);
        entry.samples = Array.from({ length: 12 }, (_, index) => read(values, index * 8, 'double'));
      }
      writes.push(entry);
      return setResult;
    },
  };
  return { lib, writes };
}

function makeBackend(dir, options = {}) {
  const { lib, writes } = fakeIGCL(options);
  const backend = new IgclBackend({ lib, displayColorStateDir: dir, fanProbe: false });
  const device = options.device ?? DEFAULT_DEVICE;
  backend._device = async () => device;
  backend._displayOutputsOf = async () => [DISPLAY_HANDLE];
  return { backend, writes };
}

async function withFixture(t, options, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-display-color-integration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  await callback({ dir, ...makeBackend(dir, options) });
}

function request(patch, target = {}) {
  return {
    deviceKey: target.deviceKey ?? DEVICE_KEY,
    displayKey: target.displayKey ?? DISPLAY_KEY,
    patch,
  };
}

test('IGCL backend exposes defaults as managed intent, not native current values', async (t) => {
  await withFixture(t, {}, async ({ backend }) => {
    const state = await backend.getDisplaySettings(0);
    assert.equal(state.displays.length, 1);
    const display = state.displays[0];
    assert.equal(display.identityVerified, true);
    assert.equal(display.displayKey, DISPLAY_KEY);
    assert.deepEqual(display.flags, { active: true, attached: true, dongleConnected: false, ditheringEnabled: false });
    for (const [key, value] of Object.entries({ hue: 0, saturation: 1, brightness: 0, contrast: 1 })) {
      assert.equal(display[key].value, null, `${key} must not be represented as read-back`);
      assert.equal(display[key].desiredValue, value);
      assert.equal(display[key].supported, true);
      assert.equal(display[key].controllable, true);
      assert.equal(display[key].source, 'igcl-managed-color');
      assert.equal(display[key].lastSent, false);
    }
  });
});

test('IGCL backend leaves unsupported LUT layouts disabled and explains why', async (t) => {
  for (const [lutMetadata, reason] of [[{ samplingType: 1 }, /Non-uniform/], [{ sampleCount: 8193 }, /sample count/]]) {
    await withFixture(t, { lutMetadata }, async ({ backend, writes }) => {
      const state = await backend.getDisplaySettings(0);
      const display = state.displays[0];
      for (const key of ['brightness', 'contrast']) {
        assert.equal(display[key].supported, false);
        assert.equal(display[key].controllable, false);
        assert.match(display[key].reason, reason);
      }
      assert.equal(display.hue.controllable, true);
      const result = await backend.setDisplaySettings(0, request({ brightness: 20, replaceExistingColorSettings: true }));
      assert.equal(result.ok, false);
      assert.equal(result.perControl.brightness.errorCode, 'unsupported');
      assert.equal(writes.length, 0);
    });
  }
});

test('first SET requires explicit IGS replacement acknowledgement and writes nothing without it', async (t) => {
  await withFixture(t, {}, async ({ backend, writes }) => {
    const blocked = await backend.setDisplaySettings(0, request({ hue: 30 }));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.perControl.hue.errorCode, 'unsupported');
    assert.match(blocked.perControl.hue.message, /replace the corresponding IGS/);
    assert.equal(writes.length, 0);

    const applied = await backend.setDisplaySettings(0, request({ hue: 30, replaceExistingColorSettings: true }));
    assert.equal(applied.ok, true);
    assert.equal(applied.perControl.hue.ok, true);
    assert.equal(applied.perControl.hue.verification, 'readback-unavailable');
    assert.equal(applied.perControl.hue.readBackEqual, undefined);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].operation, 2);
    assert.equal(writes[0].count, 1);
    assert.equal(writes[0].blockId, 392965);
    assert.equal(writes[0].blockType, 3);

  });
});

test('hue and saturation patches merge, persist across a fresh backend, and leave RGB LUT controls intact', async (t) => {
  await withFixture(t, {}, async ({ dir, backend, writes }) => {
    const hueResult = await backend.setDisplaySettings(0, request({ hue: 37, replaceExistingColorSettings: true }));
    assert.equal(hueResult.perControl.hue.ok, true);
    const saturationResult = await backend.setDisplaySettings(0, request({ saturation: 1.4 }));
    assert.equal(saturationResult.perControl.saturation.ok, true);
    assert.equal(writes.length, 2);
    const expectedMatrix = matrixForHueSaturation({ hue: 37, saturation: 1.4 });
    for (let index = 0; index < 9; index += 1) {
      assert.ok(Math.abs(writes[1].block.readDoubleLE(72 + index * 8) - expectedMatrix[index]) < 1e-12);
    }

    const restartedFixture = makeBackend(dir);
    const restarted = restartedFixture.backend;
    const afterRestart = (await restarted.getDisplaySettings(0)).displays[0];
    assert.equal(afterRestart.hue.value, null);
    assert.equal(afterRestart.hue.desiredValue, 37);
    assert.equal(afterRestart.hue.lastSent, true);
    assert.equal(afterRestart.saturation.desiredValue, 1.4);
    assert.equal(afterRestart.saturation.lastSent, true);

    const brightnessResult = await restarted.setDisplaySettings(0, request({ brightness: 20, replaceExistingColorSettings: true }));
    assert.equal(brightnessResult.perControl.brightness.ok, true);
    assert.equal(restartedFixture.writes.length, 1);
    assert.equal(restartedFixture.writes[0].blockId, 392964);
    assert.equal(restartedFixture.writes[0].blockType, 1);
    const final = (await makeBackend(dir).backend.getDisplaySettings(0)).displays[0];
    assert.equal(final.hue.desiredValue, 37);
    assert.equal(final.saturation.desiredValue, 1.4);
    assert.equal(final.brightness.desiredValue, 20);
    assert.equal(final.contrast.desiredValue, 1);
  });
});

test('corrupt persistent state fails closed without native color writes', async (t) => {
  await withFixture(t, {}, async ({ dir, backend, writes }) => {
    const file = path.join(dir, `${crypto.createHash('sha256').update(DISPLAY_KEY, 'utf8').digest('hex')}.json`);
    fs.writeFileSync(file, '{broken json');
    const state = (await backend.getDisplaySettings(0)).displays[0];
    assert.equal(state.hue.value, null);
    assert.equal(state.hue.desiredValue, undefined);
    assert.equal(state.hue.controllable, false);
    const result = await backend.setDisplaySettings(0, request({ hue: 10, replaceExistingColorSettings: true }));
    assert.equal(result.ok, false);
    assert.equal(result.perControl.hue.errorCode, 'io-failed');
    assert.equal(writes.length, 0);
  });
});

test('native SET rejection is not persisted and NaN is rejected before a native write', async (t) => {
  await withFixture(t, { setResult: CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS }, async ({ dir, backend, writes }) => {
    const rejected = await backend.setDisplaySettings(0, request({ saturation: 1.2, replaceExistingColorSettings: true }));
    assert.equal(rejected.ok, false);
    assert.equal(rejected.perControl.saturation.errorCode, 'permission-denied');
    assert.equal(writes.length, 1);
    const afterRejection = (await backend.getDisplaySettings(0)).displays[0];
    assert.equal(afterRejection.saturation.desiredValue, 1);
    assert.equal(afterRejection.saturation.lastSent, false);

    const invalid = await backend.setDisplaySettings(0, request({ contrast: Number.NaN, replaceExistingColorSettings: true }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.perControl.contrast.errorCode, 'out-of-range');
    assert.equal(writes.length, 1);
    assert.equal((await makeBackend(dir).backend.getDisplaySettings(0)).displays[0].contrast.desiredValue, 1);
  });
});

test('wrong adapter or display identity blocks the managed color write', async (t) => {
  await withFixture(t, {}, async ({ backend, writes }) => {
    const wrongDevice = await backend.setDisplaySettings(0, request({ hue: 45, replaceExistingColorSettings: true }, { deviceKey: 'different-adapter' }));
    assert.equal(wrongDevice.ok, false);
    assert.equal(wrongDevice.perControl.hue.errorCode, 'stale-target');

    const wrongDisplay = await backend.setDisplaySettings(0, request({ hue: 45, replaceExistingColorSettings: true }, { displayKey: 'different-display' }));
    assert.equal(wrongDisplay.ok, false);
    assert.equal(wrongDisplay.perControl.hue.errorCode, 'stale-target');
    assert.equal(writes.length, 0);
  });
});

test('managed color state crosses parent and worker aliases for one physical B580', async (t) => {
  await withFixture(t, {}, async ({ dir }) => {
    const physical = {
      name: 'Intel Arc B580',
      pciVendorId: '0x00008086',
      pciDeviceId: '0x0000e20b',
      bdf: { bus: 3, device: 0, function: 0 },
      handle: DEVICE_HANDLE,
    };
    const parentFixture = makeBackend(dir, { device: { ...physical, deviceKey: 'parent-pnp-key' } });
    const workerFixture = makeBackend(dir, { device: { ...physical, deviceKey: 'worker-pci-key' } });

    const parentBefore = (await parentFixture.backend.getDisplaySettings(0)).displays[0];
    const workerBefore = (await workerFixture.backend.getDisplaySettings(0)).displays[0];
    const suffix = `display|${ENCODER_ID.toString('hex')}`;
    assert.equal(parentBefore.displayKey, `parent-pnp-key|${suffix}`);
    assert.equal(workerBefore.displayKey, `worker-pci-key|${suffix}`);

    const workerHue = await workerFixture.backend.setDisplaySettings(0, request(
      { hue: 42, replaceExistingColorSettings: true },
      { deviceKey: 'worker-pci-key', displayKey: workerBefore.displayKey },
    ));
    assert.equal(workerHue.perControl.hue.ok, true);
    const parentAfterWorker = (await makeBackend(dir, { device: { ...physical, deviceKey: 'parent-pnp-key' } }).backend.getDisplaySettings(0)).displays[0];
    assert.equal(parentAfterWorker.displayKey, parentBefore.displayKey);
    assert.equal(parentAfterWorker.hue.value, null);
    assert.equal(parentAfterWorker.hue.desiredValue, 42);
    assert.equal(parentAfterWorker.hue.lastSent, true);

    const parentSaturation = await parentFixture.backend.setDisplaySettings(0, request(
      { saturation: 1.36 },
      { deviceKey: 'parent-pnp-key', displayKey: parentAfterWorker.displayKey },
    ));
    assert.equal(parentSaturation.perControl.saturation.ok, true);
    const workerAfterParent = (await makeBackend(dir, { device: { ...physical, deviceKey: 'worker-pci-key' } }).backend.getDisplaySettings(0)).displays[0];
    assert.equal(workerAfterParent.displayKey, workerBefore.displayKey);
    assert.equal(workerAfterParent.hue.value, null);
    assert.equal(workerAfterParent.hue.desiredValue, 42);
    assert.equal(workerAfterParent.saturation.desiredValue, 1.36);
    assert.equal(workerAfterParent.hue.lastSent, true);
    assert.equal(workerAfterParent.saturation.lastSent, true);
    assert.equal(fs.readdirSync(dir).filter((entry) => entry.endsWith('.json')).length, 1);
  });
});
