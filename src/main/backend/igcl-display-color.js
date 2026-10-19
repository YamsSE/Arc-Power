import koffi from 'koffi';
import { CTL_RESULT, describeResult } from './igcl-bindings.js';

const PIPE_GET_SIZE = 272;
const BLOCK_SIZE = 144;
const MATRIX_SIZE = 128;
const LUT_SIZE = 40;
const PIPE_SET_SIZE = 32;
const QUERY_CAPABILITY = 0;
const QUERY_CURRENT = 1;
const OPERATION_RESTORE_DEFAULT = 1;
const OPERATION_SET = 2;
const BLOCK_LUT_1D = 1;
const BLOCK_MATRIX_3X3 = 3;
const MAX_BLOCKS = 64;
const MAX_LUT_SAMPLES = 8192;
const COPIED_BLOCKS = new WeakMap();

function write(buffer, offset, type, value) {
  koffi.encode(buffer, offset, type, value);
}

function read(buffer, offset, type) {
  return koffi.decode(buffer, offset, type);
}

function copyBytes(buffer, offset, length) {
  const copy = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) copy[index] = Number(read(buffer, offset + index, 'uint8'));
  return copy;
}

function copyInto(source, target, offset = 0, length = source.length ?? BLOCK_SIZE) {
  for (let index = 0; index < length; index += 1) {
    const value = typeof source[index] === 'number' ? source[index] : Number(read(source, index, 'uint8'));
    write(target, offset + index, 'uint8', value);
  }
}

function resultFailure(result, prefix) {
  const description = describeResult(result);
  const code = (Number(result) >>> 0) === CTL_RESULT.ERROR_UNSUPPORTED_FEATURE
    ? 'unsupported'
    : (Number(result) >>> 0) === CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS ? 'permission-denied' : 'io-failed';
  return { ok: false, result, errorCode: code, message: `${prefix}: IGCL ${description}` };
}

function missingFunction(name) {
  return {
    ok: false,
    result: CTL_RESULT.ERROR_UNSUPPORTED_FEATURE,
    errorCode: 'unsupported',
    message: `${name} is not exposed by this IGCL runtime (${describeResult(CTL_RESULT.ERROR_UNSUPPORTED_FEATURE)})`,
  };
}

function makePipeGet(queryType, { blocks = null, count = 0 } = {}) {
  const pipe = Buffer.alloc(PIPE_GET_SIZE + 16);
  write(pipe, 0, 'uint32', PIPE_GET_SIZE);
  write(pipe, 4, 'uint8', 0);
  write(pipe, 8, 'uint32', queryType);
  if (blocks) {
    write(pipe, 256, 'uint32', count);
    write(pipe, 264, 'void*', blocks);
  }
  return pipe;
}

function blockMetadata(raw) {
  const id = raw.readUInt32LE(8);
  const type = raw.readUInt32LE(12);
  const metadata = { id, type, raw };
  if (type === BLOCK_LUT_1D) {
    metadata.samplingType = raw.readUInt32LE(24);
    metadata.numSamplesPerChannel = raw.readUInt32LE(28);
    metadata.numChannels = raw.readUInt32LE(32);
    // Capability queries do not provide caller-owned sample storage. Clear
    // pointer values from the copied block; never retain native addresses.
    raw.writeBigUInt64LE(0n, 40);
    raw.writeBigUInt64LE(0n, 48);
  }
  COPIED_BLOCKS.set(metadata, Buffer.from(raw));
  return metadata;
}

function getBlocks(lib, displayHandle, queryType) {
  if (!displayHandle) return { ok: false, result: CTL_RESULT.ERROR_INVALID_NULL_HANDLE, errorCode: 'invalid-argument', message: `IGCL ${describeResult(CTL_RESULT.ERROR_INVALID_NULL_HANDLE)}` };
  if (typeof lib?.ctlPixelTransformationGetConfig !== 'function' || lib.ctlPixelTransformationGetConfig.unavailable) {
    return missingFunction('ctlPixelTransformationGetConfig');
  }

  try {
    const countQuery = makePipeGet(queryType);
    const countResult = lib.ctlPixelTransformationGetConfig(displayHandle, countQuery);
    const count = Number(read(countQuery, 256, 'uint32')) >>> 0;
    // IGCL's two-phase query reports INVALID_SIZE while filling NumBlocks.
    // Accept that sizing response only when it also provides a valid count.
    if (countResult !== CTL_RESULT.SUCCESS && countResult !== CTL_RESULT.ERROR_INVALID_SIZE) {
      return resultFailure(countResult, 'Pixel transformation block count query failed');
    }
    if (!Number.isInteger(count) || count < 1 || count > MAX_BLOCKS) {
      return {
        ok: false,
        result: countResult,
        errorCode: 'unsupported',
        message: `Pixel transformation returned an unsafe block count (${count})`,
      };
    }

    const blockBuffer = Buffer.alloc(BLOCK_SIZE * count + 16);
    for (let index = 0; index < count; index += 1) {
      const offset = index * BLOCK_SIZE;
      write(blockBuffer, offset, 'uint32', BLOCK_SIZE);
      write(blockBuffer, offset + 4, 'uint8', 0);
    }
    const dataQuery = makePipeGet(queryType, { blocks: blockBuffer, count });
    const result = lib.ctlPixelTransformationGetConfig(displayHandle, dataQuery);
    if (result !== CTL_RESULT.SUCCESS) return resultFailure(result, 'Pixel transformation block query failed');
    const returnedCount = Number(read(dataQuery, 256, 'uint32')) >>> 0;
    if (returnedCount < 1 || returnedCount > count) {
      return {
        ok: false,
        result,
        errorCode: 'io-failed',
        message: `Pixel transformation returned an invalid block count (${returnedCount})`,
      };
    }
    const blocks = [];
    for (let index = 0; index < returnedCount; index += 1) {
      const offset = index * BLOCK_SIZE;
      const raw = copyBytes(blockBuffer, offset, BLOCK_SIZE);
      if (raw.readUInt32LE(0) !== BLOCK_SIZE) {
        return {
          ok: false,
          result,
          errorCode: 'io-failed',
          message: `Pixel transformation returned an invalid block size for block ${index}`,
        };
      }
      blocks.push(blockMetadata(raw));
    }
    return { ok: true, result, message: `IGCL ${describeResult(result)}`, blocks };
  } catch (error) {
    return {
      ok: false,
      result: CTL_RESULT.ERROR_UNKNOWN,
      errorCode: 'io-failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Query the display pipeline capabilities; this intentionally never depends on CURRENT state. */
export function queryDisplayColorCapabilities(lib, displayHandle) {
  const query = getBlocks(lib, displayHandle, QUERY_CAPABILITY);
  if (!query.ok) return query;
  const matrixCandidates = query.blocks.filter((block) => block.type === BLOCK_MATRIX_3X3);
  const lutCandidates = query.blocks.filter((block) => block.type === BLOCK_LUT_1D && block.numChannels === 3);
  const hueSaturationBlock = matrixCandidates.length === 1 ? matrixCandidates[0] : null;
  const selectedLut = lutCandidates.length === 1 ? lutCandidates[0] : null;
  const hueSaturationUnsupportedReason = hueSaturationBlock ? null
    : matrixCandidates.length > 1 ? 'Multiple hue/saturation transform blocks are ambiguous.'
      : 'This output does not expose a hue/saturation matrix.';
  const brightnessContrastUnsupportedReason = !selectedLut
    ? lutCandidates.length > 1 ? 'Multiple RGB color LUT blocks are ambiguous.' : 'This output does not expose an RGB color LUT.'
    : selectedLut.samplingType !== 0 ? 'Non-uniform LUT sampling is unsupported without verified sample positions.'
      : !Number.isInteger(selectedLut.numSamplesPerChannel) || selectedLut.numSamplesPerChannel < 2 || selectedLut.numSamplesPerChannel > MAX_LUT_SAMPLES
        ? `RGB LUT sample count must be from 2 through ${MAX_LUT_SAMPLES}.` : null;
  const brightnessContrastBlock = brightnessContrastUnsupportedReason ? null : selectedLut;
  return {
    ...query,
    hueSaturationBlock,
    brightnessContrastBlock,
    hueSaturationSupported: hueSaturationBlock !== null,
    brightnessContrastSupported: brightnessContrastBlock !== null,
    hueSaturationUnsupportedReason,
    brightnessContrastUnsupportedReason,
  };
}

function finiteClamped(value, min, max, name) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be a finite number`);
  return Math.min(max, Math.max(min, value));
}

/** Build a BT.709 RGB matrix with hue rotation in UV space and saturation scaling. */
export function matrixForHueSaturation({ hue = 0, saturation = 1 } = {}) {
  const degrees = finiteClamped(Number(hue), -180, 180, 'hue');
  const sat = finiteClamped(Number(saturation), 0, 2, 'saturation');
  if (degrees === 0 && sat === 1) return [1, 0, 0, 0, 1, 0, 0, 0, 1];

  const angle = (degrees * Math.PI) / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  // BT.709 luma and chroma basis, with RGB = inverse(Y, U, V).
  const toYuv = [
    0.2126, 0.7152, 0.0722,
    -0.114572, -0.385428, 0.5,
    0.5, -0.454153, -0.045847,
  ];
  const fromYuv = [
    1, 0, 1.5748,
    1, -0.187324, -0.468124,
    1, 1.8556, 0,
  ];
  const rotateScale = [
    1, 0, 0,
    0, sat * cosine, -sat * sine,
    0, sat * sine, sat * cosine,
  ];
  const multiply = (left, right) => {
    const output = Array(9).fill(0);
    for (let row = 0; row < 3; row += 1) {
      for (let column = 0; column < 3; column += 1) {
        for (let index = 0; index < 3; index += 1) output[(row * 3) + column] += left[(row * 3) + index] * right[(index * 3) + column];
      }
    }
    return output;
  };
  return multiply(fromYuv, multiply(rotateScale, toYuv));
}

/** Generate one uniform brightness/contrast curve and replicate it per channel. */
export function lutForBrightnessContrast({ brightness = 0, contrast = 1, sampleCount = 256, channels = 3 } = {}) {
  const bright = finiteClamped(Number(brightness), -100, 100, 'brightness');
  const contrastValue = finiteClamped(Number(contrast), 0, 2, 'contrast');
  if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > MAX_LUT_SAMPLES) {
    throw new RangeError(`sampleCount must be an integer from 2 through ${MAX_LUT_SAMPLES}`);
  }
  if (![1, 3].includes(channels)) throw new RangeError('channels must be 1 or 3');
  const offset = bright / 400;
  const ctlContrast = 1 + ((contrastValue - 1) * 0.25);
  // IGS uses gamma 2.2 as its neutral reference; the neutral exponent is 1.
  const exponent = 2.2 / 2.2;
  const curve = Array.from({ length: sampleCount }, (_, index) => {
    const input = index / (sampleCount - 1);
    const adjusted = Math.min(1, Math.max(0, (input * ctlContrast) + offset));
    return Math.pow(adjusted, exponent);
  });
  return Array.from({ length: channels }, () => curve.slice()).flat();
}

function validateSelectedBlock(block, expectedType) {
  const original = block && COPIED_BLOCKS.get(block);
  if (!original || !Buffer.isBuffer(block.raw) || block.raw.length !== BLOCK_SIZE || !block.raw.equals(original)) {
    throw new TypeError('block must be an unchanged copied capability block');
  }
  if (block.id !== original.readUInt32LE(8) || block.type !== original.readUInt32LE(12) || block.type !== expectedType) {
    throw new RangeError(`expected a capability block of type ${expectedType}`);
  }
  if (block.raw.readUInt32LE(0) !== BLOCK_SIZE) throw new RangeError('capability block size is invalid');
}

function allocateSetPipe(lib, displayHandle, operation, blockBuffers) {
  if (!displayHandle) return { ok: false, result: CTL_RESULT.ERROR_INVALID_NULL_HANDLE, errorCode: 'invalid-argument', message: `IGCL ${describeResult(CTL_RESULT.ERROR_INVALID_NULL_HANDLE)}` };
  if (typeof lib?.ctlPixelTransformationSetConfig !== 'function' || lib.ctlPixelTransformationSetConfig.unavailable) return missingFunction('ctlPixelTransformationSetConfig');
  if (!Array.isArray(blockBuffers) || blockBuffers.length < 1 || blockBuffers.length > MAX_BLOCKS) {
    return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, errorCode: 'invalid-argument', message: `Pixel transformation set requires 1 to ${MAX_BLOCKS} selected blocks` };
  }
  const blocks = Buffer.alloc(BLOCK_SIZE * blockBuffers.length + 16);
  blockBuffers.forEach((block, index) => copyInto(block, blocks, index * BLOCK_SIZE));
  const set = Buffer.alloc(PIPE_SET_SIZE + 16);
  write(set, 0, 'uint32', PIPE_SET_SIZE);
  write(set, 4, 'uint8', 0);
  write(set, 8, 'uint32', operation);
  write(set, 12, 'uint32', 0);
  write(set, 16, 'uint32', blockBuffers.length);
  write(set, 24, 'void*', blocks);
  const result = lib.ctlPixelTransformationSetConfig(displayHandle, set);
  if (result !== CTL_RESULT.SUCCESS) return resultFailure(result, 'Pixel transformation write failed');
  return { ok: true, result, message: `IGCL ${describeResult(result)}` };
}

export function applyDisplayHueSaturation(lib, displayHandle, block, { hue = 0, saturation = 1 } = {}) {
  try {
    validateSelectedBlock(block, BLOCK_MATRIX_3X3);
    const matrix = matrixForHueSaturation({ hue, saturation });
    const raw = Buffer.from(block.raw);
    // Replace only the selected transform payload, preserving the copied
    // capability block's identity and metadata.
    raw.writeUInt32LE(MATRIX_SIZE, 16);
    raw.writeUInt8(0, 20);
    for (let index = 0; index < 3; index += 1) {
      raw.writeDoubleLE(0, 24 + (index * 8));
      raw.writeDoubleLE(0, 48 + (index * 8));
    }
    matrix.forEach((value, index) => raw.writeDoubleLE(value, 72 + (index * 8)));
    const result = allocateSetPipe(lib, displayHandle, OPERATION_SET, [raw]);
    return result.ok ? { ...result, requested: { hue, saturation }, matrix } : result;
  } catch (error) {
    return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, errorCode: 'invalid-argument', message: error instanceof Error ? error.message : String(error) };
  }
}

export function applyDisplayBrightnessContrast(lib, displayHandle, block, { brightness = 0, contrast = 1 } = {}) {
  let lutValues;
  let lutStorage;
  try {
    validateSelectedBlock(block, BLOCK_LUT_1D);
    const sampleCount = block.numSamplesPerChannel;
    const channels = block.numChannels;
    if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > MAX_LUT_SAMPLES) throw new RangeError(`LUT sample count must be from 2 through ${MAX_LUT_SAMPLES}`);
    if (![1, 3].includes(channels)) throw new RangeError('LUT channel count must be 1 or 3');
    if (block.samplingType !== 0) throw new RangeError('Non-uniform LUT sampling is unsupported without verified sample positions');

    lutValues = lutForBrightnessContrast({ brightness, contrast, sampleCount, channels });
    lutStorage = Buffer.alloc(lutValues.length * 8);
    lutValues.forEach((value, index) => write(lutStorage, index * 8, 'double', value));

    const raw = Buffer.from(block.raw);
    raw.writeUInt32LE(LUT_SIZE, 16);
    raw.writeUInt8(0, 20);
    raw.writeUInt32LE(sampleCount, 28);
    raw.writeUInt32LE(channels, 32);
    // Pointer-sized fields refer only to this call's owned, live allocation.
    const nativeBlock = Buffer.alloc(BLOCK_SIZE);
    copyInto(raw, nativeBlock);
    write(nativeBlock, 40, 'void*', lutStorage);
    write(nativeBlock, 48, 'void*', 0n);
    const result = allocateSetPipe(lib, displayHandle, OPERATION_SET, [nativeBlock]);
    return result.ok ? { ...result, requested: { brightness, contrast }, sampleCount, channels } : result;
  } catch (error) {
    return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, errorCode: 'invalid-argument', message: error instanceof Error ? error.message : String(error) };
  }
}

export function restoreDisplayColorBlockDefaults(lib, displayHandle, blocks) {
  try {
    if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > MAX_BLOCKS) {
      return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, errorCode: 'invalid-argument', message: `Restore requires 1 to ${MAX_BLOCKS} explicitly selected blocks` };
    }
    const ids = new Set();
    const rawBlocks = blocks.map((block) => {
      const original = block && COPIED_BLOCKS.get(block);
      if (!original || !Buffer.isBuffer(block.raw) || block.raw.length !== BLOCK_SIZE || !block.raw.equals(original)
        || block.id !== original.readUInt32LE(8) || block.type !== original.readUInt32LE(12)) {
        throw new TypeError('restore blocks must be copied capability blocks with matching id and type');
      }
      if (ids.has(block.id)) throw new RangeError(`duplicate pixel transformation block id ${block.id}`);
      ids.add(block.id);
      return Buffer.from(block.raw);
    });
    return allocateSetPipe(lib, displayHandle, OPERATION_RESTORE_DEFAULT, rawBlocks);
  } catch (error) {
    return { ok: false, result: CTL_RESULT.ERROR_INVALID_ARGUMENT, errorCode: 'invalid-argument', message: error instanceof Error ? error.message : String(error) };
  }
}

/** CURRENT queries are opt-in diagnostics; capability enumeration is separate. */
export function queryCurrentDisplayColorBlocks(lib, displayHandle) {
  return getBlocks(lib, displayHandle, QUERY_CURRENT);
}
