// M4-F — selectDevice core (createDeviceSwitcher): the switch-in-flight
// guard, the best-effort telemetry stop/start (the switch ALWAYS
// completes), the caps/state re-read (a read failure keeps the OLD
// device), the store state resets, and the best-effort persist
// (deviceSet failure -> warn toast, the session switch stays).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceSwitcher } from '../src/renderer/device.ts';
import { Store } from '../src/renderer/router.ts';
import type { Capabilities, DeviceState, DeviceInfo } from '../src/renderer/types.ts';

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

const capsFor = (id: number): Capabilities => ({
  oemName: 'Intel (mock)',
  deviceName: `caps name ${id}`,
  waiverAccepted: false,
  controls: {},
  ranges: {},
  fan: { canControl: false, modes: [], maxRpm: -1, maxCurvePoints: 0 },
});

const stateFor = (id: number): DeviceState => ({
  powerLimitW: 100 + id,
  gpuVoltOffsetV: null,
  gpuFreqOffsetMhz: null,
  tempLimitC: null,
  vramFreqOffsetGts: null,
  vramVoltOffsetV: null,
  gpuLock: null,
  vfCurve: null,
  fanMode: null,
  fanCurve: null,
  fixedFanPct: null,
});

interface RecordingApi {
  calls: Array<[string, number | null]>;
  telemetryStop: (id: number) => Promise<void>;
  telemetryStart: (id: number) => Promise<void>;
  getCapabilities: (id: number) => Promise<Capabilities>;
  getCurrentSettings: (id: number) => Promise<DeviceState>;
  deviceSet: (id: number) => Promise<{ deviceId: number | null }>;
}

/** A recording api with per-method failure injection. */
function makeApi(overrides: Partial<RecordingApi> = {}): RecordingApi {
  const calls: Array<[string, number | null]> = [];
  const api: RecordingApi = {
    calls,
    telemetryStop: async (id) => { calls.push(['telemetryStop', id]); },
    telemetryStart: async (id) => { calls.push(['telemetryStart', id]); },
    getCapabilities: async (id) => { calls.push(['getCapabilities', id]); return capsFor(id); },
    getCurrentSettings: async (id) => { calls.push(['getCurrentSettings', id]); return stateFor(id); },
    deviceSet: async (id) => { calls.push(['deviceSet', id]); return { deviceId: id }; },
    ...overrides,
  };
  return api;
}

/** The store seeded with the 2-device enumeration + device 0 current. */
function seededStore(): Store {
  const store = new Store();
  store.set({ devices: [device(0), device(1)], deviceId: 0, caps: capsFor(0), state: stateFor(0) });
  return store;
}

test('selectDevice: a same-id request is a no-op (no api calls, no re-render)', async () => {
  const api = makeApi();
  let switched = 0;
  const select = createDeviceSwitcher({ api, store: seededStore(), onSwitched: () => { switched += 1; }, warn: () => {} });
  await select(0);
  assert.equal(api.calls.length, 0);
  assert.equal(switched, 0);
});

test('selectDevice: an unknown id is a no-op', async () => {
  const api = makeApi();
  let switched = 0;
  const select = createDeviceSwitcher({ api, store: seededStore(), onSwitched: () => { switched += 1; }, warn: () => {} });
  await select(42);
  assert.equal(api.calls.length, 0);
  assert.equal(switched, 0);
});

test('selectDevice: the full flow — stop old, start new, caps+state re-read, store resets, persist, re-render', async () => {
  const api = makeApi();
  const store = seededStore();
  const switched: number[] = [];
  const warns: string[] = [];
  const select = createDeviceSwitcher({ api, store, onSwitched: (id) => { switched.push(id); }, warn: (t, m) => warns.push(`${t}: ${m}`) });
  await select(1);
  assert.deepEqual(api.calls, [
    ['telemetryStop', 0],
    ['telemetryStart', 1],
    ['getCapabilities', 1],
    ['getCurrentSettings', 1],
    ['deviceSet', 1],
  ]);
  const s = store.get();
  assert.equal(s.deviceId, 1);
  assert.equal(s.caps?.deviceName, 'caps name 1');
  assert.equal(s.state?.powerLimitW, 101);
  // M4-F: the monitoring series + the "OC working" row reset on switch.
  assert.equal(s.latestSample, null);
  assert.equal(s.lastApply, null);
  assert.deepEqual(switched, [1]);
  assert.deepEqual(warns, []);
});

test('selectDevice: an in-flight switch guards a second call (one sequence runs)', async () => {
  const store = seededStore();
  const calls: Array<[string, number | null]> = [];
  const gateHolder: { release: (() => void) | null } = { release: null };
  const gate = new Promise<void>((resolve) => { gateHolder.release = resolve; });
  const api = makeApi({
    telemetryStop: async (id) => { calls.push(['telemetryStop', id]); await gate; },
    telemetryStart: async (id) => { calls.push(['telemetryStart', id]); },
    getCapabilities: async (id) => { calls.push(['getCapabilities', id]); return capsFor(id); },
    getCurrentSettings: async (id) => { calls.push(['getCurrentSettings', id]); return stateFor(id); },
    deviceSet: async (id) => { calls.push(['deviceSet', id]); return { deviceId: id }; },
  });
  let switched = 0;
  const select = createDeviceSwitcher({ api: api as unknown as RecordingApi, store, onSwitched: () => { switched += 1; }, warn: () => {} });
  const first = select(1);
  const second = select(1); // must be swallowed by the in-flight guard
  gateHolder.release?.();
  await Promise.all([first, second]);
  assert.deepEqual(calls, [
    ['telemetryStop', 0],
    ['telemetryStart', 1],
    ['getCapabilities', 1],
    ['getCurrentSettings', 1],
    ['deviceSet', 1],
  ]);
  assert.equal(store.get().deviceId, 1);
  assert.equal(switched, 1);
});

test('selectDevice: a telemetryStop failure is best-effort — warn toast, the switch still completes', async () => {
  const store = seededStore();
  const warns: string[] = [];
  const api = makeApi({
    telemetryStop: async () => { throw new Error('stop exploded'); },
  });
  let switched = 0;
  const select = createDeviceSwitcher({ api, store, onSwitched: () => { switched += 1; }, warn: (t, m) => warns.push(`${t}: ${m}`) });
  await select(1);
  assert.equal(store.get().deviceId, 1);
  assert.equal(switched, 1);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^Telemetry: Stopping telemetry on device 0 failed: stop exploded$/);
});

test('selectDevice: a telemetryStart failure is best-effort — warn toast, the switch still completes', async () => {
  const store = seededStore();
  const warns: string[] = [];
  const api = makeApi({
    telemetryStart: async () => { throw new Error('start exploded'); },
  });
  let switched = 0;
  const select = createDeviceSwitcher({ api, store, onSwitched: () => { switched += 1; }, warn: (t, m) => warns.push(`${t}: ${m}`) });
  await select(1);
  assert.equal(store.get().deviceId, 1);
  assert.equal(switched, 1);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^Telemetry: Starting telemetry on device 1 failed: start exploded$/);
});

test('selectDevice: a caps/state read failure keeps the OLD device (no half-switch, no persist, no re-render)', async () => {
  const store = seededStore();
  const warns: string[] = [];
  const api = makeApi({
    getCapabilities: async () => { throw new Error('caps exploded'); },
  });
  let switched = 0;
  const select = createDeviceSwitcher({ api, store, onSwitched: () => { switched += 1; }, warn: (t, m) => warns.push(`${t}: ${m}`) });
  await select(1);
  const s = store.get();
  assert.equal(s.deviceId, 0); // the session stays on the old device
  assert.equal(s.caps?.deviceName, 'caps name 0');
  assert.equal(switched, 0);
  assert.equal(api.calls.some(([name]) => name === 'deviceSet'), false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^GPU switch: Could not read device 1 state: caps exploded$/);
});

test('selectDevice: a deviceSet (persist) failure is best-effort — warn toast, the SESSION switch stays', async () => {
  const store = seededStore();
  const warns: string[] = [];
  const api = makeApi({
    deviceSet: async () => { throw new Error('persist exploded'); },
  });
  let switched = 0;
  const select = createDeviceSwitcher({ api, store, onSwitched: () => { switched += 1; }, warn: (t, m) => warns.push(`${t}: ${m}`) });
  await select(1);
  const s = store.get();
  assert.equal(s.deviceId, 1); // the session switch stays (N9)
  assert.equal(switched, 1);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /^GPU selection: The selection could not be saved — the switch stays for this session/);
});

test('selectDevice: the in-flight guard resets after a failure path (a later switch works)', async () => {
  const store = seededStore();
  let failFirst = true;
  const api = makeApi({
    getCapabilities: async (id) => {
      if (failFirst) { failFirst = false; throw new Error('transient'); }
      return capsFor(id);
    },
  });
  const select = createDeviceSwitcher({ api, store, onSwitched: () => {}, warn: () => {} });
  await select(1); // fails -> the old device stays
  assert.equal(store.get().deviceId, 0);
  await select(1); // the guard is free again -> the switch lands
  assert.equal(store.get().deviceId, 1);
});
