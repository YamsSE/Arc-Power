import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { createSysmanPowerLimits } from '../src/main/sysman/power-limits.js';

const fillOne = (count, list, handle) => {
  koffi.encode(count, 'uint32', handle === null ? 0 : 1);
  if (list !== null && handle !== null) koffi.encode(list, 'void*', handle);
  return 0;
};

function standaloneLoader({ includeLegacy = false, legacyInitThrows = false, initResult = 0 } = {}) {
  let poisoned = false;
  let initCalls = 0;
  let legacyInitCalls = 0;
  let sustainedPower = 210000;
  let voltageOffset = 0;
  const lib = {
    zesInit() {
      initCalls += 1;
      return poisoned ? 0x78000001 : initResult;
    },
    zesDriverGet: (count, list) => fillOne(count, list, 1),
    zesDeviceGet: (_driver, count, list) => fillOne(count, list, 2),
    zesDeviceEnumPowerDomains: (_device, count, list) => fillOne(count, list, 3),
    zesDeviceGetCardPowerDomain: () => 0x78000003,
    zesPowerGetLimits: (_domain, sustained, burst, peak) => {
      koffi.encode(sustained, 'zes_power_sustained_limit_t', { enabled: 1, power: sustainedPower, interval: 2000 });
      koffi.encode(burst, 'zes_power_burst_limit_t', { enabled: 1, power: sustainedPower });
      koffi.encode(peak, 'zes_power_peak_limit_t', { powerAC: 300000, powerDC: 300000 });
      return 0;
    },
    zesPowerSetLimits: (_domain, sustained) => {
      sustainedPower = koffi.decode(sustained, 'zes_power_sustained_limit_t').power;
      return 0;
    },
    zesDeviceEnumFrequencyDomains: (_device, count, list) => fillOne(count, list, 4),
    zesFrequencyGetProperties: (_handle, buffer) => {
      koffi.encode(buffer, 'zes_frequency_properties_t', {
        stype: 9, pNext: null, type: 0, onSubdevice: 0, subdeviceId: 0,
        canControl: 1, isThrottleEventSupported: 0, min: 300, max: 2400,
      });
      return 0;
    },
    zesFrequencyGetState: (_handle, buffer) => {
      koffi.encode(buffer, 'zes_frequency_state_t', {
        stype: 0x1b, pNext: null, currentVoltage: 0.7, request: 2400,
        tdp: 2400, efficient: 1000, actual: 2400, throttleReasons: 0,
      });
      return 0;
    },
    zesFrequencyOcGetVoltageTarget: (_handle, target, offset) => {
      koffi.encode(target, 'double', 1000);
      koffi.encode(offset, 'double', voltageOffset);
      return 0;
    },
    zesFrequencyOcSetMode: () => 0,
    zesFrequencyOcSetFrequencyTarget: () => 0,
    zesFrequencyOcSetVoltageTarget: (_handle, _target, offset) => { voltageOffset = offset; return 0; },
  };
  if (includeLegacy) {
    lib.zeInit = () => {
      legacyInitCalls += 1;
      if (legacyInitThrows) throw new Error('core zeInit must not be called');
      poisoned = true;
      return 0;
    };
    lib.zeDriverGet = () => 0x78000001;
    lib.zeDeviceGet = () => 0x78000001;
  }
  return {
    lib,
    get initCalls() { return initCalls; },
    get legacyInitCalls() { return legacyInitCalls; },
    get sustainedPower() { return sustainedPower; },
  };
}

test('standalone Sysman works without core ze exports for power and voltage reads/writes', () => {
  const mock = standaloneLoader();
  const logs = [];
  const adapter = createSysmanPowerLimits({
    findLoader: () => 'C:\\Windows\\System32\\ze_loader.dll',
    load: () => mock.lib,
    ensureVoltageWaiver: () => ({ ok: true }),
    log: (message) => logs.push(message),
  });

  assert.deepEqual(adapter.readLimits(), { sustainedW: 210, burstW: 210, peakW: 300 });
  assert.deepEqual(adapter.setLimits({ sustainedW: 250, burstW: 260 }), { ok: true });
  assert.equal(mock.sustainedPower, 250000);
  assert.deepEqual(adapter.readVoltageOffset(), { ok: true, targetV: 1, offsetV: 0, frequencyTargetMhz: 2400 });
  assert.equal(adapter.setVoltageOffset({ offsetV: -0.05, waiverAccepted: true }).ok, true);
  assert.equal(mock.initCalls, 1);
  assert.ok(logs.some((line) => line.includes('ze_loader.dll')));
  assert.ok(logs.some((line) => line.includes('standalone zesInit(0)')));
  assert.ok(logs.some((line) => line.includes('1 driver(s), 1 device(s), 1 usable device context(s)')));
});

test('standalone mode avoids poisoning zesInit with the unsupported core initialization sequence', () => {
  const mock = standaloneLoader({ includeLegacy: true });
  const adapter = createSysmanPowerLimits({ findLoader: () => 'fake-loader.dll', load: () => mock.lib, log: () => {} });
  assert.deepEqual(adapter.readLimits(), { sustainedW: 210, burstW: 210, peakW: 300 });
  assert.equal(mock.legacyInitCalls, 0);
  assert.equal(mock.initCalls, 1);
});

test('standalone mode never calls a core zeInit that would throw', () => {
  const mock = standaloneLoader({ includeLegacy: true, legacyInitThrows: true });
  const adapter = createSysmanPowerLimits({ findLoader: () => 'fake-loader.dll', load: () => mock.lib, log: () => {} });
  assert.deepEqual(adapter.readLimits(), { sustainedW: 210, burstW: 210, peakW: 300 });
  assert.equal(mock.legacyInitCalls, 0);
});

test('zesInit failure latches unavailable state and refuses subsequent writes', () => {
  const mock = standaloneLoader({ initResult: 0x78000001 });
  const logs = [];
  const adapter = createSysmanPowerLimits({ findLoader: () => 'fake-loader.dll', load: () => mock.lib, log: (line) => logs.push(line) });
  assert.equal(adapter.readLimits(), null);
  assert.equal(adapter.setLimits({ sustainedW: 250, burstW: 250 }).ok, false);
  assert.equal(adapter.setVoltageOffset({ offsetV: -0.05, waiverAccepted: true }).ok, false);
  assert.equal(mock.initCalls, 1);
  assert.equal(logs.filter((line) => line.includes('ERROR_UNINITIALIZED')).length, 1);
});

test('missing standalone Sysman exports latch unavailable state and refuse writes', () => {
  const lib = { zesInit: () => 0 };
  const adapter = createSysmanPowerLimits({ findLoader: () => 'fake-loader.dll', load: () => lib, log: () => {} });
  assert.equal(adapter.readLimits(), null);
  assert.equal(adapter.setLimits({ sustainedW: 250, burstW: 250 }).ok, false);
  assert.equal(adapter.setVoltageOffset({ offsetV: -0.05, waiverAccepted: true }).ok, false);
});
