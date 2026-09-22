import test from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { createWindowsDisplayModeController } from '../src/main/backend/windows-display-mode.js';

const DEVICE_SIZE = 840;
const MODE_SIZE = 220;
const DM_SIZE = 68;
const DM_FIELDS = 72;
const DM_ORIENTATION = 84;
const DM_BPP = 164;
const DM_WIDTH = 172;
const DM_HEIGHT = 176;
const DM_FLAGS = 180;
const DM_FREQUENCY = 184;
const DM_SENTINEL = 100;

function utf16(buffer, offset, value, length) {
  [...value].forEach((character, index) => koffi.encode(buffer, offset + index * 2, 'uint16', character.charCodeAt(0)));
  koffi.encode(buffer, offset + Math.min(value.length, length - 1) * 2, 'uint16', 0);
}

function bytesFrom(buffer) {
  const result = Buffer.alloc(MODE_SIZE);
  for (let index = 0; index < MODE_SIZE; index += 1) result[index] = koffi.decode(buffer, index, 'uint8');
  return result;
}

function fakeWin32(outputs) {
  const changes = [];
  const devices = [
    ...outputs.map((output) => ({ kind: 'adapter', name: output.name, label: output.label, id: output.id })),
  ];
  return {
    changes,
    enumDisplayDevices(parent, index, buffer) {
      const output = parent === null ? null : outputs.find((candidate) => candidate.name === parent);
      const list = parent === null ? devices : (output?.monitors ?? []);
      const item = list[index];
      if (!item) return false;
      koffi.encode(buffer, 0, 'uint32', DEVICE_SIZE);
      utf16(buffer, 4, item.name, 32);
      utf16(buffer, 68, item.label, 128);
      koffi.encode(buffer, 324, 'uint32', 1);
      utf16(buffer, 328, item.id, 128);
      return true;
    },
    enumDisplaySettings(name, index, buffer) {
      const output = outputs.find((candidate) => candidate.name === name);
      if (!output) return false;
      const mode = index === 0xffffffff ? output.current : output.modes[index];
      if (!mode) return false;
      koffi.encode(buffer, DM_SIZE, 'uint16', MODE_SIZE);
      koffi.encode(buffer, DM_FIELDS, 'uint32', output.fields);
      koffi.encode(buffer, DM_SENTINEL, 'uint32', 0xaabbccdd);
      koffi.encode(buffer, DM_ORIENTATION, 'uint16', mode.orientation ?? 1);
      koffi.encode(buffer, DM_BPP, 'uint32', mode.bitsPerPixel ?? 32);
      koffi.encode(buffer, DM_WIDTH, 'uint32', mode.width);
      koffi.encode(buffer, DM_HEIGHT, 'uint32', mode.height);
      koffi.encode(buffer, DM_FLAGS, 'uint32', mode.displayFlags ?? 0);
      koffi.encode(buffer, DM_FREQUENCY, 'uint32', mode.refreshRate);
      return true;
    },
    changeDisplaySettings(name, buffer) {
      changes.push({ name, bytes: bytesFrom(buffer) });
      return 0;
    },
  };
}

const baseModes = [
  { width: 1920, height: 1080, refreshRate: 60 },
  { width: 3840, height: 2160, refreshRate: 120 },
  { width: 3840, height: 2160, refreshRate: 120 },
];

test('enumerates attached outputs, current mode, and deduplicated supported modes', () => {
  const api = fakeWin32([{ name: '\\\\.\\DISPLAY1', label: 'Panel A', id: 'MONITOR-A', current: baseModes[0], modes: baseModes, fields: 0x12345678 }]);
  const result = createWindowsDisplayModeController({ platform: 'win32', ...api }).enumerate();
  assert.equal(result.ok, true);
  assert.equal(result.outputs.length, 1);
  assert.deepEqual(result.outputs[0].currentMode.width, 1920);
  assert.equal(result.outputs[0].modes.length, 2);
});

test('applies requested mode with a complete captured DEVMODE and restores it', () => {
  const api = fakeWin32([{ name: '\\\\.\\DISPLAY1', label: 'Panel A', id: 'MONITOR-A', current: baseModes[0], modes: baseModes, fields: 0x12345678 }]);
  const controller = createWindowsDisplayModeController({ platform: 'win32', ...api });
  const applied = controller.apply({ displayName: 'Panel A', resolution: { width: 3840, height: 2160 }, refreshRate: 120 });
  assert.equal(applied.ok, true);
  assert.equal(api.changes.length, 1);
  assert.equal(api.changes[0].bytes.readUInt32LE(DM_FIELDS), 0x12345678 | 0x00580000);
  assert.equal(api.changes[0].bytes.readUInt32LE(DM_WIDTH), 3840);
  const restored = controller.restore();
  assert.equal(restored.ok, true);
  assert.equal(api.changes[1].bytes.readUInt32LE(DM_WIDTH), 1920);
  assert.equal(api.changes[1].bytes.readUInt32LE(DM_FIELDS), 0x12345678);
  assert.equal(api.changes[1].bytes.readUInt16LE(DM_ORIENTATION), 1);
  assert.equal(api.changes[1].bytes.readUInt32LE(DM_SENTINEL), 0xaabbccdd);
});

test('refuses to restore a captured mode onto a replacement monitor reusing DISPLAY1', () => {
  const output = {
    name: '\\\\.\\DISPLAY1',
    label: 'Panel A',
    id: 'GPU-OUTPUT-1',
    monitors: [{ name: 'MONITOR-A', label: 'Panel A', id: 'MONITOR-A' }],
    current: baseModes[0],
    modes: baseModes,
    fields: 0x12345678,
  };
  const api = fakeWin32([output]);
  const controller = createWindowsDisplayModeController({ platform: 'win32', ...api });
  const applied = controller.apply({ displayName: 'Panel A', resolution: { width: 3840, height: 2160 }, refreshRate: 120 });
  assert.equal(applied.ok, true);
  assert.equal(controller.resolve({ deviceName: output.name }).output.displayIdentity, 'MONITOR-A');

  output.monitors[0].id = 'MONITOR-B';
  const restored = controller.restore({ deviceName: output.name, displayIdentity: 'MONITOR-A' });
  assert.equal(restored.ok, false);
  assert.equal(restored.errorCode, 'display-identity-mismatch');
  assert.equal(api.changes.length, 1);
});

test('re-arms the original-mode capture after a successful restore', () => {
  const intermediate = { width: 2560, height: 1440, refreshRate: 60 };
  const output = {
    name: '\\\\.\\DISPLAY1',
    label: 'Panel A',
    id: 'MONITOR-A',
    current: baseModes[0],
    modes: [...baseModes, intermediate],
    fields: 0x12345678,
  };
  const api = fakeWin32([output]);
  const controller = createWindowsDisplayModeController({ platform: 'win32', ...api });
  assert.equal(controller.apply({ displayName: 'Panel A', resolution: { width: 3840, height: 2160 }, refreshRate: 120 }).ok, true);
  assert.equal(controller.restore().ok, true);

  output.current = intermediate;
  assert.equal(controller.apply({ displayName: 'Panel A', resolution: { width: 3840, height: 2160 }, refreshRate: 120 }).ok, true);
  assert.equal(controller.restore().ok, true);
  assert.equal(api.changes.at(-1).bytes.readUInt32LE(DM_WIDTH), 2560);
  assert.equal(api.changes.at(-1).bytes.readUInt32LE(DM_HEIGHT), 1440);
});

test('fails closed for ambiguous, unsupported, invalid, and non-Windows requests', () => {
  const ambiguous = fakeWin32([
    { name: '\\\\.\\DISPLAY1', label: 'Panel', id: 'A', current: baseModes[0], modes: baseModes, fields: 0 },
    { name: '\\\\.\\DISPLAY2', label: 'Panel', id: 'B', current: baseModes[0], modes: baseModes, fields: 0 },
  ]);
  const controller = createWindowsDisplayModeController({ platform: 'win32', ...ambiguous });
  assert.equal(controller.apply({ displayName: 'Panel', resolution: { width: 3840, height: 2160 }, refreshRate: 120 }).errorCode, 'display-ambiguous');
  const single = fakeWin32([{ name: '\\\\.\\DISPLAY1', label: 'Panel', id: 'MONITOR-A', current: baseModes[0], modes: baseModes, fields: 0 }]);
  const singleController = createWindowsDisplayModeController({ platform: 'win32', ...single });
  assert.equal(singleController.apply({ displayName: 'Panel', resolution: { width: 800, height: 600 }, refreshRate: 60 }).errorCode, 'unsupported-display-mode');
  assert.equal(singleController.apply({ displayName: 'Panel', resolution: { width: 0, height: 600 }, refreshRate: 60 }).errorCode, 'invalid-display-mode');
  assert.equal(createWindowsDisplayModeController({ platform: 'linux' }).apply({}).errorCode, 'windows-only');
  assert.equal(ambiguous.changes.length, 0);
});
