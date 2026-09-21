import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import {
  CTL_CUSTOM_MODE_OPERATION,
  CTL_CUSTOM_MODE_OPERATION_TYPE_ADD,
  CTL_CUSTOM_MODE_OPERATION_TYPE_GET,
  CTL_CUSTOM_MODE_OPERATION_TYPE_REMOVE,
  CTL_CUSTOM_SRC_MODE_SIZE,
  CTL_GET_SET_CUSTOM_MODE_ARGS_SIZE,
  decodeCustomModeArgs,
  decodeCustomSrcModes,
  encodeCustomModeArgs,
  encodeCustomSrcModes,
  loadIgcl,
} from '../src/main/backend/igcl-bindings.js';

test('custom mode constants and MSVC x64 layouts are pinned', () => {
  assert.deepEqual(CTL_CUSTOM_MODE_OPERATION, { GET: 0, ADD: 1, REMOVE: 2 });
  assert.equal(CTL_CUSTOM_MODE_OPERATION_TYPE_GET, 0);
  assert.equal(CTL_CUSTOM_MODE_OPERATION_TYPE_ADD, 1);
  assert.equal(CTL_CUSTOM_MODE_OPERATION_TYPE_REMOVE, 2);
  assert.equal(koffi.sizeof('ctl_custom_src_mode_t'), CTL_CUSTOM_SRC_MODE_SIZE);
  assert.equal(koffi.offsetof('ctl_custom_src_mode_t', 'SourceX'), 0);
  assert.equal(koffi.offsetof('ctl_custom_src_mode_t', 'SourceY'), 4);
  assert.equal(koffi.sizeof('ctl_get_set_custom_mode_args_t'), CTL_GET_SET_CUSTOM_MODE_ARGS_SIZE);
  assert.equal(koffi.offsetof('ctl_get_set_custom_mode_args_t', 'Size'), 0);
  assert.equal(koffi.offsetof('ctl_get_set_custom_mode_args_t', 'Version'), 4);
  assert.equal(koffi.offsetof('ctl_get_set_custom_mode_args_t', 'CustomModeOpType'), 8);
  assert.equal(koffi.offsetof('ctl_get_set_custom_mode_args_t', 'NumOfModes'), 12);
  assert.equal(koffi.offsetof('ctl_get_set_custom_mode_args_t', 'pCustomSrcModeList'), 16);
});

test('helper enforces single-add and preserves multi-remove input', () => {
  assert.throws(
    () => encodeCustomModeArgs({ operation: CTL_CUSTOM_MODE_OPERATION.ADD, modes: [{ SourceX: 1920, SourceY: 1080 }, { SourceX: 2560, SourceY: 1440 }] }),
    /exactly one mode/,
  );

  const encoded = encodeCustomModeArgs({
    operation: CTL_CUSTOM_MODE_OPERATION.REMOVE,
    modes: [{ SourceX: 1920, SourceY: 1080 }, { SourceX: 2560, SourceY: 1440 }],
  });
  assert.equal(koffi.decode(encoded.buf, 8, 'int32'), CTL_CUSTOM_MODE_OPERATION.REMOVE);
  assert.equal(koffi.decode(encoded.buf, 12, 'uint32'), 2);
  assert.deepEqual(decodeCustomSrcModes(encoded.modeBuf, 2), [
    { SourceX: 1920, SourceY: 1080 },
    { SourceX: 2560, SourceY: 1440 },
  ]);
});

test('GET supports count query and decodes returned source modes', () => {
  const query = encodeCustomModeArgs({ operation: CTL_CUSTOM_MODE_OPERATION.GET });
  assert.equal(koffi.decode(query.buf, 12, 'uint32'), 0);
  assert.equal(koffi.decode(query.buf, 16, 'void*'), null);

  const returnedModes = encodeCustomSrcModes([
    { sourceX: 1280, sourceY: 720 },
    { sourceX: 3840, sourceY: 2160 },
  ]).buf;
  koffi.encode(query.buf, 12, 'uint32', 2);
  const decoded = decodeCustomModeArgs(query.buf, { modeBuf: returnedModes });
  assert.deepEqual(decoded, {
    operation: CTL_CUSTOM_MODE_OPERATION.GET,
    numOfModes: 2,
    modes: [
      { SourceX: 1280, SourceY: 720 },
      { SourceX: 3840, SourceY: 2160 },
    ],
  });
});

test('ctlGetSetCustomMode is optional and bound with raw void* parameters', () => {
  const calls = [];
  const lib = {
    func(name, ret, params) {
      calls.push([name, ret, params]);
      if (name === 'ctlGetSetCustomMode') return () => 0;
      throw new Error('absent');
    },
  };
  const bound = loadIgcl('fake.dll', { load: () => lib });
  assert.equal(typeof bound.ctlGetSetCustomMode, 'function');
  assert.deepEqual(calls.find(([name]) => name === 'ctlGetSetCustomMode'), [
    'ctlGetSetCustomMode', 'ctl_result_t', ['void*', 'void*'],
  ]);
  const absent = loadIgcl('fake.dll', { load: () => ({ func() { throw new Error('absent'); } }) });
  assert.equal(absent.ctlGetSetCustomMode, undefined);
  assert.ok(absent.unavailable.includes('ctlGetSetCustomMode'));
});
