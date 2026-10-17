import test from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { CTL_RESULT, describeResult } from '../src/main/backend/igcl-bindings.js';
import {
  applyDisplayBrightnessContrast,
  applyDisplayHueSaturation,
  lutForBrightnessContrast,
  matrixForHueSaturation,
  queryCurrentDisplayColorBlocks,
  queryDisplayColorCapabilities,
  restoreDisplayColorBlockDefaults,
} from '../src/main/backend/igcl-display-color.js';

const BLOCK_SIZE = 144;
const HANDLE = 0x1234n;

function read(buffer, offset, type) {
  return koffi.decode(buffer, offset, type);
}

function write(buffer, offset, type, value) {
  koffi.encode(buffer, offset, type, value);
}

function blockAt(pointer, index, count) {
  return new Uint8Array(koffi.view(pointer, BLOCK_SIZE * count), index * BLOCK_SIZE, BLOCK_SIZE);
}

function queryLibrary(blocks) {
  const calls = [];
  return {
    calls,
    ctlPixelTransformationGetConfig(handle, pipe) {
      calls.push({ handle, pipe, queryType: read(pipe, 8, 'uint32') });
      if (read(pipe, 256, 'uint32') === 0) {
        write(pipe, 256, 'uint32', blocks.length);
        return CTL_RESULT.ERROR_INVALID_SIZE;
      }
      const pointer = read(pipe, 264, 'void*');
      blocks.forEach((block, index) => {
        const view = blockAt(pointer, index, blocks.length);
        write(view, 0, 'uint32', BLOCK_SIZE);
        write(view, 4, 'uint8', 0);
        write(view, 8, 'uint32', block.id);
        write(view, 12, 'uint32', block.type);
        if (block.type === 3) {
          write(view, 16, 'uint32', 128);
          write(view, 20, 'uint8', 0);
          for (let value = 0; value < 9; value += 1) write(view, 72 + value * 8, 'double', value % 4 === 0 ? 1 : 0);
        } else if (block.type === 1) {
          write(view, 16, 'uint32', 40);
          write(view, 20, 'uint8', 0);
          write(view, 24, 'uint32', block.samplingType ?? 0);
          write(view, 28, 'uint32', block.sampleCount ?? 4);
          write(view, 32, 'uint32', block.channels ?? 3);
          // Simulate transient output pointers to ensure the module never
          // returns or reuses driver-owned/native-address data.
          write(view, 40, 'uint64', 0xabcden);
          write(view, 48, 'uint64', 0x12345n);
        }
      });
      return CTL_RESULT.SUCCESS;
    },
  };
}

function setLibrary(onSet, result = CTL_RESULT.SUCCESS) {
  return {
    ctlPixelTransformationSetConfig(handle, pipe) {
      onSet(handle, pipe);
      return result;
    },
  };
}

function capturedBlocks(pipe, count) {
  const pointer = read(pipe, 24, 'void*');
  return Array.from({ length: count }, (_, index) => Buffer.from(blockAt(pointer, index, count)));
}

test('capability discovery uses 272-byte two-phase GET, Query=CAPABILITY, and selects unique matching blocks', () => {
  const lib = queryLibrary([
    { id: 392960, type: 1, sampleCount: 4, channels: 1 },
    { id: 392964, type: 1, sampleCount: 4, channels: 3 },
    { id: 392965, type: 3 },
  ]);
  const result = queryDisplayColorCapabilities(lib, HANDLE);
  assert.equal(result.ok, true, result.message);
  assert.equal(lib.calls.length, 2);
  for (const call of lib.calls) {
    assert.equal(call.handle, HANDLE);
    assert.equal(read(call.pipe, 0, 'uint32'), 272);
    assert.equal(read(call.pipe, 4, 'uint8'), 0);
    assert.equal(call.queryType, 0);
  }
  assert.equal(result.blocks.length, 3);
  assert.equal(result.hueSaturationBlock.id, 392965);
  assert.equal(result.hueSaturationBlock.type, 3);
  assert.equal(result.brightnessContrastBlock.id, 392964);
  assert.equal(result.brightnessContrastBlock.type, 1);
  assert.equal(result.brightnessContrastBlock.numChannels, 3);
  assert.equal(result.brightnessContrastBlock.raw.readBigUInt64LE(40), 0n);
  assert.equal(result.brightnessContrastBlock.raw.readBigUInt64LE(48), 0n);
  assert.equal(result.hueSaturationSupported, true);
  assert.equal(result.brightnessContrastSupported, true);
});

test('capability query rejects unsafe counts and reports IGCL errors truthfully', () => {
  const countFailure = {
    ctlPixelTransformationGetConfig(_handle, pipe) {
      write(pipe, 256, 'uint32', 65);
      return CTL_RESULT.ERROR_INVALID_SIZE;
    },
  };
  const tooMany = queryDisplayColorCapabilities(countFailure, HANDLE);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.message, /unsafe block count/);

  const nativeFailure = {
    ctlPixelTransformationGetConfig() { return CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS; },
  };
  const denied = queryDisplayColorCapabilities(nativeFailure, HANDLE);
  assert.equal(denied.ok, false);
  assert.equal(denied.errorCode, 'permission-denied');
  assert.ok(denied.message.includes(describeResult(CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS)));
});

test('capability selection fails closed when multiple equivalent transform blocks are returned', () => {
  const lib = queryLibrary([
    { id: 392964, type: 1, sampleCount: 4, channels: 3 },
    { id: 392965, type: 3 },
    { id: 392966, type: 1, sampleCount: 4, channels: 3 },
  ]);
  const result = queryDisplayColorCapabilities(lib, HANDLE);
  assert.equal(result.ok, true, result.message);
  assert.equal(result.brightnessContrastBlock, null);
  assert.equal(result.brightnessContrastSupported, false);
  assert.equal(result.hueSaturationBlock.id, 392965);
});

test('capability discovery disables unsupported RGB LUT layouts with specific reasons', () => {
  for (const [metadata, reason] of [
    [{ samplingType: 1 }, /Non-uniform/],
    [{ sampleCount: 0 }, /sample count/],
    [{ sampleCount: 1 }, /sample count/],
    [{ sampleCount: 8193 }, /sample count/],
    [{ channels: 1 }, /does not expose an RGB/],
  ]) {
    const result = queryDisplayColorCapabilities(queryLibrary([
      { id: 392964, type: 1, sampleCount: 2049, channels: 3, ...metadata },
      { id: 392965, type: 3 },
    ]), HANDLE);
    assert.equal(result.ok, true);
    assert.equal(result.brightnessContrastSupported, false);
    assert.equal(result.brightnessContrastBlock, null);
    assert.match(result.brightnessContrastUnsupportedReason, reason);
    assert.equal(result.hueSaturationSupported, true);
  }
  for (const sampleCount of [2, 2049, 8192]) {
    const result = queryDisplayColorCapabilities(queryLibrary([{ id: 392964, type: 1, sampleCount, channels: 3 }]), HANDLE);
    assert.equal(result.brightnessContrastSupported, true);
    assert.equal(result.brightnessContrastUnsupportedReason, null);
  }
});

test('Hue and saturation matrix is identity at defaults and preserves gray under hue rotation', () => {
  assert.deepEqual(matrixForHueSaturation(), [1, 0, 0, 0, 1, 0, 0, 0, 1]);
  const matrix90 = matrixForHueSaturation({ hue: 90, saturation: 1 });
  const matrix180 = matrixForHueSaturation({ hue: 180, saturation: 1 });
  assert.notDeepEqual(matrix90, matrixForHueSaturation());
  for (const matrix of [matrix90, matrix180]) {
    for (const gray of [0.25, 0.5, 0.75]) {
      for (let row = 0; row < 3; row += 1) {
        const output = (matrix[row * 3] + matrix[row * 3 + 1] + matrix[row * 3 + 2]) * gray;
        // Hue chroma rotation preserves neutral gray values.
        assert.ok(Math.abs(output - gray) < 0.00001);
      }
    }
  }
  assert.deepEqual(matrixForHueSaturation({ hue: 999, saturation: -1 }), matrixForHueSaturation({ hue: 180, saturation: 0 }));
});

test('Hue/saturation SET copies one selected block and writes operation 2 with no persistence flags', () => {
  const capability = queryDisplayColorCapabilities(queryLibrary([{ id: 392965, type: 3 }]), HANDLE);
  let captured;
  const result = applyDisplayHueSaturation(setLibrary((handle, pipe) => {
    assert.equal(handle, HANDLE);
    assert.equal(read(pipe, 0, 'uint32'), 32);
    assert.equal(read(pipe, 4, 'uint8'), 0);
    assert.equal(read(pipe, 8, 'uint32'), 2);
    assert.equal(read(pipe, 12, 'uint32'), 0);
    assert.equal(read(pipe, 16, 'uint32'), 1);
    captured = capturedBlocks(pipe, 1)[0];
  }), HANDLE, capability.hueSaturationBlock, { hue: 90, saturation: 1.5 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.readBackEqual, undefined);
  assert.equal(captured.readUInt32LE(8), 392965);
  assert.equal(captured.readUInt32LE(12), 3);
  assert.equal(captured.readUInt32LE(16), 128);
  assert.ok(Math.abs(captured.readDoubleLE(72) - result.matrix[0]) < 1e-12);
});

test('brightness/contrast LUT clamps endpoints and encodes samples in channel-major order', () => {
  assert.deepEqual(lutForBrightnessContrast({ sampleCount: 4, channels: 3 }), [
    0, 1 / 3, 2 / 3, 1,
    0, 1 / 3, 2 / 3, 1,
    0, 1 / 3, 2 / 3, 1,
  ]);
  const curve = lutForBrightnessContrast({ brightness: 100, contrast: 2, sampleCount: 3, channels: 1 });
  assert.deepEqual(curve, [0.25, 0.875, 1]);
  assert.equal(lutForBrightnessContrast({ brightness: 0, contrast: 2, sampleCount: 3, channels: 1 })[1], 0.625);
  assert.equal(lutForBrightnessContrast({ brightness: 0, contrast: 0, sampleCount: 2, channels: 1 })[1], 0.75);
  assert.throws(() => lutForBrightnessContrast({ sampleCount: 8193 }), /sampleCount/);
});

test('brightness/contrast SET targets one copied LUT block, preserving sampling metadata and using live sample memory', () => {
  const capability = queryDisplayColorCapabilities(queryLibrary([{ id: 392964, type: 1, sampleCount: 4, channels: 3 }]), HANDLE);
  let captured;
  let values;
  const result = applyDisplayBrightnessContrast(setLibrary((handle, pipe) => {
    assert.equal(handle, HANDLE);
    assert.equal(read(pipe, 8, 'uint32'), 2);
    assert.equal(read(pipe, 12, 'uint32'), 0);
    assert.equal(read(pipe, 16, 'uint32'), 1);
    captured = capturedBlocks(pipe, 1)[0];
    const samplePointer = read(koffi.view(read(pipe, 24, 'void*'), BLOCK_SIZE), 40, 'void*');
    const sampleView = koffi.view(samplePointer, 4 * 3 * 8);
    values = Array.from({ length: 12 }, (_, index) => read(sampleView, index * 8, 'double'));
  }), HANDLE, capability.brightnessContrastBlock, { brightness: 100, contrast: 2 });
  assert.equal(result.ok, true, result.message);
  assert.equal(result.readBackEqual, undefined);
  assert.equal(captured.readUInt32LE(8), 392964);
  assert.equal(captured.readUInt32LE(12), 1);
  assert.equal(captured.readUInt32LE(16), 40);
  assert.equal(captured.readUInt32LE(24), 0);
  assert.equal(captured.readUInt32LE(28), 4);
  assert.equal(captured.readUInt32LE(32), 3);
  assert.equal(captured.readBigUInt64LE(48), 0n);
  assert.deepEqual(values, [
    0.25, 2 / 3, 1, 1,
    0.25, 2 / 3, 1, 1,
    0.25, 2 / 3, 1, 1,
  ]);
});

test('brightness/contrast rejects unsupported nonuniform sampling and malformed LUT metadata', () => {
  const cap = queryDisplayColorCapabilities(queryLibrary([{ id: 392964, type: 1, samplingType: 1 }]), HANDLE);
  const rejected = applyDisplayBrightnessContrast({}, HANDLE, cap.blocks.find((block) => block.id === 392964), {});
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'invalid-argument');
  assert.match(rejected.message, /Non-uniform/);
});

test('restore defaults is scoped to selected blocks and never sends NumBlocks=0', () => {
  const cap = queryDisplayColorCapabilities(queryLibrary([
    { id: 392964, type: 1 },
    { id: 392965, type: 3 },
  ]), HANDLE);
  let captured;
  const result = restoreDisplayColorBlockDefaults(setLibrary((handle, pipe) => {
    assert.equal(handle, HANDLE);
    assert.equal(read(pipe, 8, 'uint32'), 1);
    assert.equal(read(pipe, 12, 'uint32'), 0);
    assert.equal(read(pipe, 16, 'uint32'), 1);
    captured = capturedBlocks(pipe, 1)[0];
  }), HANDLE, [cap.brightnessContrastBlock]);
  assert.equal(result.ok, true);
  assert.equal(captured.readUInt32LE(8), 392964);
  assert.equal(captured.readUInt32LE(12), 1);

  let called = false;
  const empty = restoreDisplayColorBlockDefaults(setLibrary(() => { called = true; }), HANDLE, []);
  assert.equal(empty.ok, false);
  assert.equal(called, false);

  const altered = { ...cap.brightnessContrastBlock, raw: Buffer.from(cap.brightnessContrastBlock.raw) };
  altered.raw.writeUInt32LE(900000, 8);
  const rejected = restoreDisplayColorBlockDefaults(setLibrary(() => { called = true; }), HANDLE, [altered]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'invalid-argument');
  assert.equal(called, false);
});

test('optional CURRENT query is separate and unsupported functions do not fake success', () => {
  const lib = queryLibrary([{ id: 1, type: 3 }]);
  const current = queryCurrentDisplayColorBlocks(lib, HANDLE);
  assert.equal(current.ok, true, current.message);
  assert.equal(lib.calls[0].queryType, 1);

  const unsupported = queryDisplayColorCapabilities({}, HANDLE);
  assert.equal(unsupported.ok, false);
  assert.equal(unsupported.errorCode, 'unsupported');
  assert.ok(unsupported.message.includes(describeResult(CTL_RESULT.ERROR_UNSUPPORTED_FEATURE)));
});
