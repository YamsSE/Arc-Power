// M4-F — pure device-selection helpers: the boot selection preference, the
// selector visibility rule and the selector option list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBootDevice, showDeviceSelector, deviceSelectorOptions } from '../src/renderer/pure/device.ts';
import type { DeviceInfo } from '../src/renderer/types.ts';

const device = (id: number, name = `GPU ${id}`): DeviceInfo => ({
  id,
  name,
  type: 'GRAPHICS',
  pciVendorId: '0x00008086',
  pciDeviceId: '0x0',
  revId: 0,
  bdf: { bus: 0, device: 0, function: 0 },
  driverVersion: '32.0.101.8861',
  graphicsClockMHz: 1000,
  numXeCores: 8,
  vramBytes: null,
});

test('resolveBootDevice: the persisted id wins when it matches an enumerated device', () => {
  const devices = [device(0, 'A770 16 GB'), device(1, 'Arc iGPU')];
  assert.equal(resolveBootDevice(devices, 1), 1);
  assert.equal(resolveBootDevice(devices, 0), 0);
});

test('resolveBootDevice: null persisted id falls back to devices[0]', () => {
  const devices = [device(0), device(1)];
  assert.equal(resolveBootDevice(devices, null), 0);
});

test('resolveBootDevice: a stale persisted id (not enumerated) falls back to devices[0]', () => {
  const devices = [device(0), device(1)];
  assert.equal(resolveBootDevice(devices, 7), 0);
});

test('resolveBootDevice: empty enumeration resolves to null (the caller degrades)', () => {
  assert.equal(resolveBootDevice([], 1), null);
  assert.equal(resolveBootDevice([], null), null);
});

test('showDeviceSelector: hidden with 1 device or none (single-device degradation)', () => {
  assert.equal(showDeviceSelector([]), false);
  assert.equal(showDeviceSelector([device(0)]), false);
});

test('showDeviceSelector: rendered with 2+ devices', () => {
  assert.equal(showDeviceSelector([device(0), device(1)]), true);
  assert.equal(showDeviceSelector([device(0), device(1), device(2)]), true);
});

test('deviceSelectorOptions: one option per device, label = the device name (VRAM suffix included), selected marks the current id', () => {
  const devices = [device(0, 'Mock Arc A770 Graphics (fixture) 16 GB'), device(1, 'Mock Arc iGPU (fixture)')];
  const opts = deviceSelectorOptions(devices, 1);
  assert.deepEqual(opts, [
    { id: 0, label: 'Mock Arc A770 Graphics (fixture) 16 GB', selected: false },
    { id: 1, label: 'Mock Arc iGPU (fixture)', selected: true },
  ]);
});

test('deviceSelectorOptions: no current id -> nothing selected', () => {
  const opts = deviceSelectorOptions([device(0), device(1)], null);
  assert.equal(opts.some((o) => o.selected), false);
});
