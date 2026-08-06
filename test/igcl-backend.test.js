// M1 — IgclBackend logic tests against an injected fake "lib" that mimics the
// A770 driver surface (capability matrix, V2 getters/setters, fan read-only,
// telemetry). Real hardware is exercised separately by the smoke run.
//
// M3-D: the fake models the fan probe explicitly. The fake's setters return
// SUCCESS even when canControl=false (exactly like the real driver), so a
// naive probe would flip the read-only fixtures to editable — the probe is
// therefore DISABLED by default in these tests (`makeBackend` passes
// fanProbe:false); the M3-D fixtures opt in with `{ fanProbe: true }` and
// model probe-ok / write-refused / write-accepted-restore-fail via the
// fake's setter behavior (F2: the write outcome, not the final verify,
// decides the learned modes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import koffi from 'koffi';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import { MockBackend } from '../src/main/backend/mock-backend.js';
import { CTL_RESULT } from '../src/main/backend/igcl-bindings.js';

// ---------------------------------------------------------------------------
// Fake lib: mimics IntelControlLib.dll on the A770 (driver 32.0.101.8861)
// ---------------------------------------------------------------------------

const OC_MATRIX = {
  gpuFrequencyOffset: { bSupported: true, bRelative: true, bReference: true, units: 0, min: 0, max: 300, step: 1, Default: 0, reference: 2400 },
  gpuVoltageOffset: { bSupported: true, bRelative: true, bReference: true, units: 3, min: 0, max: 0.234, step: 0.005, Default: 0, reference: 0.886 },
  vramFrequencyOffset: { bSupported: false, bRelative: false, bReference: false, units: 0, min: 0, max: 0, step: 0, Default: 0, reference: 0 },
  vramVoltageOffset: { bSupported: false, bRelative: false, bReference: false, units: 0, min: 0, max: 0, step: 0, Default: 0, reference: 0 },
  powerLimit: { bSupported: true, bRelative: false, bReference: false, units: 4, min: 105, max: 252, step: 1, Default: 210, reference: 0 },
  temperatureLimit: { bSupported: true, bRelative: false, bReference: false, units: 5, min: 60, max: 90, step: 1, Default: 90, reference: 0 },
  vramMemSpeedLimit: { bSupported: false, bRelative: false, bReference: false, units: 0, min: 0, max: 0, step: 0, Default: 0, reference: 0 },
  gpuVFCurveVoltageLimit: { bSupported: false, bRelative: false, bReference: false, units: 0, min: 0, max: 0, step: 0, Default: 0, reference: 0 },
  gpuVFCurveFrequencyLimit: { bSupported: false, bRelative: false, bReference: false, units: 0, min: 0, max: 0, step: 0, Default: 0, reference: 0 },
};

function makeFakeLib(opts = {}) {
  const state = {
    gpuFreqOffsetMhz: opts.gpuFreqOffsetMhz ?? 48.3,
    gpuVoltOffsetV: opts.gpuVoltOffsetV ?? 0,
    powerLimitW: opts.powerLimitW ?? 252,
    tempLimitC: opts.tempLimitC ?? 90,
    gpuLock: { Voltage: 0, Frequency: 0 },
    fanCanControl: opts.fanCanControl ?? false,
    fanMode: 2, // TABLE
    fanTable: null, // set by ctlFanSetSpeedTableMode; defaults below
    fixedSpeed: 0, // set by ctlFanSetFixedSpeedMode
    fixedUnits: 0, // RPM until a fixed speed is set (A770-style read-back)
    telemetryEnergyJ: 395809.938172,
    telemetryT: 9662.768701,
    telemetryClock: 600,
    telemetryTemp: 36,
  };
  const calls = { waiver: 0, reset: 0, fanSetters: 0, sets: [] };
  // unit overrides for the conversion tests (default: A770 W/V)
  const units = opts.units ?? { powerLimit: 4, gpuVoltageOffset: 3 };
  const devHandle = koffi.alloc('uint8', 1);
  const fanHandle = koffi.alloc('uint8', 1);

  const encodeProps = (buf) => {
    koffi.encode(buf, 'ctl_device_adapter_properties_t', {
      Size: koffi.sizeof('ctl_device_adapter_properties_t'),
      Version: 3,
      pci_vendor_id: 0x8086,
      pci_device_id: 0x56a0,
      rev_id: 8,
      driver_version: BigInt('0x002000000065229d'),
      name: 'Intel(R) Arc(TM) A770 Graphics',
      Frequency: 2100,
      num_xe_cores: 32,
    });
  };

  const encodeOc = (buf) => {
    const obj = { Size: koffi.sizeof('ctl_oc_properties_t'), Version: 1, bSupported: true };
    const matrix = { ...OC_MATRIX };
    if (opts.tempLimitMax !== undefined) matrix.temperatureLimit = { ...matrix.temperatureLimit, max: opts.tempLimitMax };
    if (units.powerLimit !== 4) matrix.powerLimit = { ...matrix.powerLimit, units: units.powerLimit, min: 105000, max: 252000, step: 1000, Default: 210000 };
    if (units.gpuVoltageOffset !== 3) matrix.gpuVoltageOffset = { ...matrix.gpuVoltageOffset, units: units.gpuVoltageOffset, min: 0, max: 234, step: 5, Default: 0 };
    for (const [k, v] of Object.entries(matrix)) obj[k] = v;
    koffi.encode(buf, 'ctl_oc_properties_t', obj);
  };

  const getters = {
    ctlOverclockPowerLimitGetV2: (h, buf) => { koffi.encode(buf, 'double', units.powerLimit === 4 ? state.powerLimitW : state.powerLimitW * 1000); return 0; },
    ctlOverclockPowerLimitSetV2: (h, v) => { calls.sets.push(['powerLimit', v]); if (!opts.silentNoop) state.powerLimitW = units.powerLimit === 4 ? v : v / 1000; return 0; },
    ctlOverclockGpuMaxVoltageOffsetGetV2: (h, buf) => { koffi.encode(buf, 'double', units.gpuVoltageOffset === 3 ? state.gpuVoltOffsetV : state.gpuVoltOffsetV * 1000); return 0; },
    ctlOverclockGpuMaxVoltageOffsetSetV2: (h, v) => { calls.sets.push(['gpuVoltOffset', v]); if (!opts.silentNoop) state.gpuVoltOffsetV = units.gpuVoltageOffset === 3 ? v : v / 1000; return 0; },
    ctlOverclockGpuFrequencyOffsetGetV2: (h, buf) => { koffi.encode(buf, 'double', state.gpuFreqOffsetMhz); return 0; },
    ctlOverclockGpuFrequencyOffsetSetV2: (h, v) => { calls.sets.push(['gpuFreqOffset', v]); if (!opts.silentNoop) state.gpuFreqOffsetMhz = v; return 0; },
    ctlOverclockTemperatureLimitGetV2: (h, buf) => { koffi.encode(buf, 'double', state.tempLimitC); return 0; },
    ctlOverclockTemperatureLimitSetV2: (h, v) => { calls.sets.push(['tempLimit', v]); if (!opts.silentNoop) state.tempLimitC = v; return 0; },
    ctlOverclockVramMemSpeedLimitGetV2: () => CTL_RESULT.ERROR_UNSUPPORTED_FEATURE,
    ctlOverclockVramMemSpeedLimitSetV2: () => CTL_RESULT.ERROR_UNSUPPORTED_FEATURE,
    ctlOverclockVramVoltageOffsetGetV2: () => CTL_RESULT.ERROR_UNSUPPORTED_FEATURE,
    ctlOverclockVramVoltageOffsetSetV2: () => CTL_RESULT.ERROR_UNSUPPORTED_FEATURE,
  };

  const lib = {
    unavailable: [],
    ctlInit: (initArgs, apiBuf) => {
      calls.initArgs = koffi.decode(initArgs, 'ctl_init_args_t');
      koffi.encode(apiBuf, 0, 'void*', devHandle);
      return opts.ctlInitResult ?? CTL_RESULT.SUCCESS;
    },
    ctlClose: () => 0x1, // SUCCESS_STILL_OPEN_BY_ANOTHER_CALLER
    ctlEnumerateDevices: (api, countBuf, handlesBuf) => {
      if (handlesBuf === null) { koffi.encode(countBuf, 'uint32', 1); return 0; }
      koffi.encode(countBuf, 'uint32', 1);
      koffi.encode(handlesBuf, 0, 'void*', devHandle);
      return 0;
    },
    ctlGetDeviceProperties: (h, propsBuf) => { encodeProps(propsBuf); return 0; },
    ctlOverclockGetProperties: (h, ocBuf) => { if (opts.noProps) return CTL_RESULT.ERROR_UNSUPPORTED_FEATURE; encodeOc(ocBuf); return 0; },
    ctlOverclockWaiverSet: () => { calls.waiver++; return 0; },
    ctlOverclockResetToDefault: () => { calls.reset++; return 0; },
    ...getters,
    ctlOverclockGpuLockGet: (h, buf) => {
      koffi.encode(buf, 'ctl_oc_vf_pair_t', { Size: koffi.sizeof('ctl_oc_vf_pair_t'), Version: 0, Voltage: state.gpuLock.Voltage, Frequency: state.gpuLock.Frequency });
      return 0;
    },
    ctlOverclockGpuLockSet: (h, pair) => {
      calls.sets.push(['gpuLock', pair.Voltage, pair.Frequency]);
      state.gpuLock = { Voltage: pair.Voltage, Frequency: pair.Frequency };
      return 0;
    },
    ctlOverclockReadVFCurve: () => CTL_RESULT.ERROR_DATA_READ,
    ctlOverclockWriteCustomVFCurve: () => CTL_RESULT.ERROR_UNSUPPORTED_FEATURE,
    ctlEnumFans: (h, countBuf, fanBuf) => {
      if (fanBuf === null) { koffi.encode(countBuf, 'uint32', 1); return 0; }
      koffi.encode(countBuf, 'uint32', 1);
      koffi.encode(fanBuf, 0, 'void*', fanHandle);
      return 0;
    },
    ctlFanGetProperties: (h, propBuf) => {
      koffi.encode(propBuf, 'ctl_fan_properties_t', {
        Size: koffi.sizeof('ctl_fan_properties_t'), Version: 0, canControl: state.fanCanControl,
        supportedModes: opts.supportedFanModes ?? 0x2, supportedUnits: 0x1, maxRPM: -1, maxPoints: opts.fanMaxPoints ?? 10,
      });
      return 0;
    },
    ctlFanGetConfig: (h, cfgBuf) => {
      const table = state.fanTable ?? (() => {
        const t = [];
        for (let i = 0; i < 10; i++) {
          t.push({ Size: 28, Version: 0, temperature: 20 + i * 10, speed: { Size: 16, Version: 0, speed: 20 + i * 10, units: 1 } });
        }
        return t;
      })();
      koffi.encode(cfgBuf, 'ctl_fan_config_t', {
        Size: koffi.sizeof('ctl_fan_config_t'), Version: 0, mode: state.fanMode,
        speedFixed: { Size: 16, Version: 0, speed: state.fixedSpeed, units: state.fixedUnits },
        speedTable: { Size: koffi.sizeof('ctl_fan_speed_table_t'), Version: 0, numPoints: table.length, table },
      });
      return 0;
    },
    ctlFanSetFixedSpeedMode: (h, speed) => {
      calls.fanSetters++;
      state.fanMode = 1;
      state.fixedSpeed = speed.speed;
      state.fixedUnits = 1;
      return 0;
    },
    ctlFanSetSpeedTableMode: (h, tableObj) => {
      calls.fanSetters++;
      state.fanMode = 2;
      state.fanTable = tableObj.table.map((p) => ({ Size: p.Size, Version: p.Version, temperature: p.temperature, speed: { Size: p.speed.Size, Version: p.speed.Version, speed: p.speed.speed, units: p.speed.units } }));
      return 0;
    },
    ctlFanSetDefaultMode: () => { calls.fanSetters++; state.fanMode = 0; return 0; },
    ctlPowerTelemetryGet: (h, telBuf) => {
      state.telemetryEnergyJ += 2.382835;
      state.telemetryT += 0.061369;
      state.telemetryClock += 0;
      koffi.encode(telBuf, 'ctl_power_telemetry_t', {
        Size: 1024, Version: 1,
        timeStamp: { bSupported: true, units: 7, type: 9, value: state.telemetryT },
        gpuEnergyCounter: { bSupported: true, units: 6, type: 9, value: state.telemetryEnergyJ },
        gpuVoltage: { bSupported: true, units: 3, type: 9, value: 0.652 },
        gpuCurrentClockFrequency: { bSupported: true, units: 0, type: 9, value: state.telemetryClock },
        gpuCurrentTemperature: { bSupported: true, units: 5, type: 9, value: state.telemetryTemp },
        globalActivityCounter: { bSupported: true, units: 7, type: 9, value: 1454.744479 },
        renderComputeActivityCounter: { bSupported: true, units: 7, type: 9, value: 591.959025 },
        mediaActivityCounter: { bSupported: true, units: 7, type: 9, value: 123.220064 },
        vramCurrentClockFrequency: { bSupported: true, units: 0, type: 9, value: 2000 },
        vramCurrentEffectiveFrequency: { bSupported: true, units: 0, type: 9, value: 16000 },
        vramCurrentTemperature: { bSupported: true, units: 5, type: 9, value: 44 },
        fanSpeed: [{ bSupported: true, units: 9, type: 9, value: 1030 }],
        gpuPowerLimited: false, gpuTemperatureLimited: false, gpuCurrentLimited: false,
        gpuVoltageLimited: false, gpuUtilizationLimited: false,
      });
      return 0;
    },
    __state: state,
    __calls: calls,
  };
  return lib;
}

function makeBackend(fakeLib, opts = {}) {
  return new IgclBackend({
    lib: fakeLib,
    findDll: () => 'C:\\fake\\IntelControlLib.dll',
    allowAutoWaiver: opts.allowAutoWaiver ?? false,
    dllPath: 'C:\\fake\\IntelControlLib.dll',
    // M3-D: the probe is DISABLED by default in tests (the fake's setters
    // return SUCCESS even when canControl=false, so a naive probe would
    // flip the read-only fixtures to editable). Probe tests opt in.
    fanProbe: opts.fanProbe ?? false,
  });
}

// Encode an alternative ctl_fan_config_t (tests inject this to simulate a
// driver that normalizes/ignores the applied fan settings).
function encodeFanConfig(cfgBuf, { mode, numPoints = 0, speed = 0, units = 0, tablePoints = [] }) {
  koffi.encode(cfgBuf, 'ctl_fan_config_t', {
    Size: koffi.sizeof('ctl_fan_config_t'), Version: 0, mode,
    speedFixed: { Size: 16, Version: 0, speed, units },
    speedTable: { Size: koffi.sizeof('ctl_fan_speed_table_t'), Version: 0, numPoints, table: tablePoints },
  });
}

// ---------------------------------------------------------------------------
// Init / discovery
// ---------------------------------------------------------------------------

test('init: zero UID + Level Zero flag; handle kept', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  await b.init();
  const args = lib.__calls.initArgs;
  assert.equal(args.ApplicationUID.Data1, 0);
  assert.equal(args.ApplicationUID.Data2, 0);
  assert.equal(args.flags, 0x1);
  assert.equal(args.AppVersion, 0x00010001);
  assert.equal(args.Size, 36);
});

test('init: throws with a clear message when ctlInit fails', async () => {
  const lib = makeFakeLib({ ctlInitResult: CTL_RESULT.ERROR_ZE_LOADER });
  const b = makeBackend(lib);
  await assert.rejects(b.init(), /Level Zero/);
  // init failure is sticky and rethrown
  await assert.rejects(b.init(), /Level Zero/);
});

test('init: fails with clear message when the DLL is not found', async () => {
  const b = new IgclBackend({ findDll: () => null });
  await assert.rejects(b.init(), /IGCL runtime DLL not found/);
});

test('listDevices: returns the A770 fixture from device properties', async () => {
  const b = makeBackend(makeFakeLib());
  const devices = await b.listDevices();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].name, 'Intel(R) Arc(TM) A770 Graphics');
  assert.equal(devices[0].pciDeviceId, '0x000056a0');
  assert.equal(devices[0].driverVersion, '0x002000000065229d');
  assert.equal(devices[0].graphicsClockMHz, 2100);
  assert.equal(devices[0].numXeCores, 32);
});

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

test('getCapabilities: A770 matrix with canonical ranges', async () => {
  const b = makeBackend(makeFakeLib());
  const caps = await b.getCapabilities(0);
  assert.equal(caps.controls.gpuFreqOffset, true);
  assert.equal(caps.controls.gpuVoltOffset, true);
  assert.equal(caps.controls.powerLimit, true);
  assert.equal(caps.controls.tempLimit, true);
  assert.equal(caps.controls.vramFreqOffset, false);
  assert.equal(caps.controls.vramVoltOffset, false);
  assert.equal(caps.controls.vfCurve, false);
  assert.equal(caps.controls.gpuLock, true);
  assert.deepEqual(caps.ranges.gpuFreqOffsetMhz, { min: 0, max: 300, step: 1, default: 0, units: 'MHz' });
  assert.deepEqual(caps.ranges.powerLimitW, { min: 105, max: 252, step: 1, default: 210, units: 'W' });
  assert.ok(Math.abs(caps.ranges.gpuVoltOffsetV.max - 0.234) < 1e-9);
  assert.ok(Math.abs(caps.ranges.gpuVoltOffsetV.step - 0.005) < 1e-12);
  assert.deepEqual(caps.ranges.tempLimitC, { min: 60, max: 90, step: 1, default: 90, units: 'C' });
  assert.equal(caps.fan.canControl, false);
  assert.deepEqual(caps.fan.modes, ['fixed']);
  assert.equal(caps.fan.maxCurvePoints, 10);
  assert.equal(caps.waiverAccepted, false);
});

test('getCapabilities: waiverAccepted reflects setWaiverAccepted', async () => {
  const b = makeBackend(makeFakeLib());
  assert.equal((await b.getCapabilities(0)).waiverAccepted, false);
  await b.setWaiverAccepted(0);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
});

test('restoreWaiverState: seeds the flag WITHOUT calling ctlOverclockWaiverSet (F1 regression)', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  await b.restoreWaiverState(0, true);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);
  assert.equal(lib.__calls.waiver, 0); // no driver waiver call on seed
  // an apply flow after a restored acceptance skips the dialog gate and
  // still never touches the driver waiver API
  const res = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(res.ok, true);
  assert.equal(lib.__calls.waiver, 0);
  // false clears the flag again (a persisted "not accepted" must not stick)
  await b.restoreWaiverState(0, false);
  assert.equal((await b.getCapabilities(0)).waiverAccepted, false);
  assert.equal(lib.__calls.waiver, 0);
});

// ---------------------------------------------------------------------------
// IOCBackend contract (G1): every typedef method exists on both backends
// ---------------------------------------------------------------------------

// The IOCBackend method surface as declared by the typedef in
// backend.interface.js — keep this list in sync with the interface.
const IOCBACKEND_METHODS = [
  'init',
  'listDevices',
  'getCapabilities',
  'getCurrentSettings',
  'applySettings',
  'resetToDefaults',
  'setWaiverAccepted',
  'restoreWaiverState',
  'sampleRawTelemetry',
  'onRawTelemetry',
  'health',
  'close',
];

const IOCBACKEND_TYPEDEF = (() => {
  const src = readFileSync(fileURLToPath(new URL('../src/main/backend/backend.interface.js', import.meta.url)), 'utf8');
  const m = src.match(/\* IOCBackend[\s\S]*?@typedef \{\{([\s\S]*?)\n \* \}\} IOCBackend/);
  assert.ok(m, 'IOCBackend typedef block not found in backend.interface.js');
  return m[1];
})();

test('IOCBackend contract: typedef declares every method and both backends implement it (G1 regression)', () => {
  for (const name of IOCBACKEND_METHODS) {
    assert.match(IOCBACKEND_TYPEDEF, new RegExp(`\\*\\s+${name}\\(`), `IOCBackend typedef is missing: ${name}`);
    assert.equal(typeof IgclBackend.prototype[name], 'function', `IgclBackend is missing IOCBackend method: ${name}`);
    assert.equal(typeof MockBackend.prototype[name], 'function', `MockBackend is missing IOCBackend method: ${name}`);
  }
});

test('getCapabilities: fan.modes uses the canonical auto|curve|fixed vocabulary (F4 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x7 });
  const b = makeBackend(lib);
  const caps = await b.getCapabilities(0);
  assert.deepEqual(caps.fan.modes, ['auto', 'fixed', 'curve']);
  // single supported mode still maps through the canonical table
  const b2 = makeBackend(makeFakeLib());
  assert.deepEqual((await b2.getCapabilities(0)).fan.modes, ['fixed']);
});

test('getCapabilities: returns an independent copy — caller mutation cannot poison the cache (F7 regression)', async () => {
  const b = makeBackend(makeFakeLib());
  const caps = await b.getCapabilities(0);
  caps.ranges.powerLimitW.max = 999;
  caps.fan.modes.push('curve');
  caps.controls.powerLimit = false;
  const again = await b.getCapabilities(0);
  assert.equal(again.ranges.powerLimitW.max, 252);
  assert.deepEqual(again.fan.modes, ['fixed']);
  assert.equal(again.controls.powerLimit, true);
});

// ---------------------------------------------------------------------------
// M3-D — the reversible fan-capability probe (the Alchemist unlock)
// ---------------------------------------------------------------------------

test('M3-D: probe disabled by default — read-only caps stay (pin regression)', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  const caps = await b.getCapabilities(0);
  assert.equal(caps.fan.canControl, false);
  assert.deepEqual(caps.fan.modes, ['fixed']);
  assert.equal(lib.__calls.fanSetters, 0, 'no probe without the fanProbe opt');
});

test('M3-D: probe-ok flips canControl, learns [auto,curve], restores to default', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib, { fanProbe: true });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.fan.canControl, true, 'effective canControl = properties || probeOk');
  assert.deepEqual(caps.fan.modes, ['auto', 'curve'], 'learned modes — never fixed (fixed writes are unsupported on this card)');
  assert.equal(caps.fan.maxCurvePoints, 10);
  assert.equal(lib.__calls.fanSetters, 2, 'one probe = table write + default-mode restore');
  assert.equal(lib.__state.fanMode, 0, 'restored: the card is left in DEFAULT mode, never table mode');
});

test('M3-D: probe ALSO runs when properties grant control but the derived modes claim fixed (F1 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true });
  const b = makeBackend(lib, { fanProbe: true });
  const caps = await b.getCapabilities(0);
  assert.equal(lib.__calls.fanSetters, 2, 'probe runs even though canControl=TRUE (IGS running — the primary usage)');
  assert.equal(caps.fan.canControl, true);
  assert.deepEqual(caps.fan.modes, ['auto', 'curve'], 'probe-learned modes replace the wrong 1<<mode fixed derivation');
});

test('M3-D: concurrent first caps calls share ONE probe promise (no double probe)', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib, { fanProbe: true });
  const [c1, c2, c3] = await Promise.all([b.getCapabilities(0), b.getCapabilities(0), b.getCapabilities(0)]);
  assert.equal(c1.fan.canControl, true);
  assert.equal(c2.fan.canControl, true);
  assert.equal(c3.fan.canControl, true);
  assert.equal(lib.__calls.fanSetters, 2, 'exactly one probe across concurrent callers');
});

test('M3-D: the probe cache is OUTSIDE the caps cache — ocMode flips do not re-probe', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib, { fanProbe: true });
  await b.getCapabilities(0);
  assert.equal(lib.__calls.fanSetters, 2);
  b.setOcMode('advanced'); // invalidates ONLY the caps cache
  const caps = await b.getCapabilities(0);
  assert.equal(caps.fan.canControl, true);
  assert.deepEqual(caps.fan.modes, ['auto', 'curve']);
  assert.equal(lib.__calls.fanSetters, 2, 'no second probe after a caps-cache invalidation');
});

test('M3-D: probe WRITE-REFUSED keeps the derived modes and read-only caps (F2 regression)', async () => {
  const lib = makeFakeLib();
  lib.ctlFanSetSpeedTableMode = (h, tableObj) => { lib.__calls.fanSetters++; return CTL_RESULT.ERROR_UNSUPPORTED_FEATURE; };
  const b = makeBackend(lib, { fanProbe: true });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.fan.canControl, false);
  assert.deepEqual(caps.fan.modes, ['fixed'], 'a write-REFUSED card keeps the derived modes — claiming auto/curve would lie');
  assert.equal(lib.__calls.fanSetters, 1, 'table write attempted; restore never needed (never entered table mode)');
  // The apply gate uses the effective value: still refused, no setter calls.
  const res = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fanCurve.errorCode, 'unsupported');
  assert.equal(lib.__calls.fanSetters, 1);
});

test('M3-D: write-accepted-but-restore-fail retries the restore (never left in table mode) — modes stay [auto,curve], still read-only (F2 regression)', async () => {
  const lib = makeFakeLib();
  lib.ctlFanSetDefaultMode = (h) => { lib.__calls.fanSetters++; return CTL_RESULT.ERROR_DATA_WRITE; };
  const b = makeBackend(lib, { fanProbe: true });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.fan.canControl, false, 'a stuck restore is itself a probe failure');
  assert.deepEqual(caps.fan.modes, ['auto', 'curve'], 'the table WRITE was accepted — the card demonstrably accepts tables (write-accepted rule)');
  assert.equal(lib.__calls.fanSetters, 3, 'table write + 2 restore retries');
});

test('M3-D: probe point count honors fp.maxPoints — min(10, maxPoints) (F3 regression)', async () => {
  const lib = makeFakeLib({ fanMaxPoints: 4 });
  const b = makeBackend(lib, { fanProbe: true });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.fan.maxCurvePoints, 4);
  assert.equal(caps.fan.canControl, true, 'a maxPoints<10 card still unlocks when it accepts tables');
  assert.deepEqual(caps.fan.modes, ['auto', 'curve']);
  assert.equal(lib.__calls.fanSetters, 2);
  assert.equal(lib.__state.fanTable.length, 4, 'sample table built with min(10, maxPoints) points and verified with the same count');
});

test('M3-D: probe-ok opens the apply gate — the effective canControl drives apply', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib, { fanProbe: true });
  assert.equal((await b.getCapabilities(0)).fan.canControl, true);
  const res = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }, { t: 50, speedPct: 40 }] });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.fanCurve.ok, true);
  assert.equal(res.perControl.fanCurve.readBackEqual, true);
  assert.equal(lib.__calls.fanSetters, 3, 'probe (table+restore) + curve apply');
});

// ---------------------------------------------------------------------------
// Read-back
// ---------------------------------------------------------------------------

test('getCurrentSettings: resolves all supported controls in canonical units', async () => {
  const b = makeBackend(makeFakeLib());
  const s = await b.getCurrentSettings(0);
  assert.equal(s.powerLimitW, 252);
  assert.equal(s.gpuFreqOffsetMhz, 48.3);
  assert.equal(s.gpuVoltOffsetV, 0);
  assert.equal(s.tempLimitC, 90);
  assert.equal(s.vramFreqOffsetGts, null);
  assert.equal(s.vramVoltOffsetV, null);
  assert.deepEqual(s.gpuLock, { voltageV: 0, freqMhz: 0 });
  assert.equal(s.vfCurve, null);
  assert.equal(s.fanMode, 'curve');
  assert.equal(s.fanCurve.length, 10);
  assert.equal(s.fanCurve[0].t, 20);
  assert.equal(s.fanCurve[0].speedPct, 20);
  assert.equal(s.fixedFanPct, null);
});

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

test('applySettings: no-op round trip (set current value) is ok and read-back equal', async () => {
  const b = makeBackend(makeFakeLib());
  const res = await b.applySettings(0, { powerLimitW: 252, gpuFreqOffsetMhz: 48.3, gpuVoltOffsetV: 0, tempLimitC: 90 });
  assert.equal(res.ok, true);
  for (const k of ['powerLimitW', 'gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'tempLimitC']) {
    assert.equal(res.perControl[k].ok, true, k);
    assert.equal(res.perControl[k].readBackEqual, true, k);
  }
});

test('applySettings: clamps to capability ranges before setting', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { powerLimitW: 999, tempLimitC: 40 });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.powerLimitW.ok, true);
  const set = lib.__calls.sets.find(([c]) => c === 'powerLimit');
  assert.equal(set[1], 252); // clamped
  const setTemp = lib.__calls.sets.find(([c]) => c === 'tempLimit');
  assert.equal(setTemp[1], 60); // clamped up
});

test('applySettings: V2 + capability-unit conversion (mW/mV driver variant)', async () => {
  const lib = makeFakeLib({ units: { powerLimit: 10, gpuVoltageOffset: 13 } });
  const b = makeBackend(lib);
  const caps = await b.getCapabilities(0);
  assert.deepEqual(caps.ranges.powerLimitW, { min: 105, max: 252, step: 1, default: 210, units: 'mW' });
  const res = await b.applySettings(0, { powerLimitW: 210, gpuVoltOffsetV: 0.1 });
  assert.equal(res.ok, true);
  const powerSet = lib.__calls.sets.find(([c]) => c === 'powerLimit');
  assert.equal(powerSet[1], 210000); // canonical W -> IGCL mW
  const voltSet = lib.__calls.sets.find(([c]) => c === 'gpuVoltOffset');
  assert.equal(voltSet[1], 100); // canonical V -> IGCL mV
  const state = await b.getCurrentSettings(0);
  assert.equal(state.powerLimitW, 210);
  assert.ok(Math.abs(state.gpuVoltOffsetV - 0.1) < 1e-9);
});

test('applySettings: unsupported controls report unsupported, overall ok=false', async () => {
  const b = makeBackend(makeFakeLib());
  const res = await b.applySettings(0, { vramFreqOffsetGts: 0.5, vramVoltOffsetV: 0.1, vfCurve: [{ voltageV: 1.0, freqMhz: 1000 }] });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.vramFreqOffsetGts.errorCode, 'unsupported');
  assert.equal(res.perControl.vramVoltOffsetV.errorCode, 'unsupported');
  assert.equal(res.perControl.vfCurve.errorCode, 'unsupported');
});

test('applySettings: fan setters are never called when canControl=false', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { fanMode: 'auto', fanCurve: [{ t: 20, speedPct: 20 }], fixedFanPct: 30 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fanMode.errorCode, 'unsupported');
  assert.equal(res.perControl.fanCurve.errorCode, 'unsupported');
  assert.equal(res.perControl.fixedFanPct.errorCode, 'unsupported');
  assert.equal(lib.__calls.fanSetters, 0);
});

test('applySettings: fan applies work on a canControl=true device (F1 regression — no ReferenceError)', async () => {
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x7 });
  const b = makeBackend(lib);
  // fixedFanPct: the path that previously threw ReferenceError
  // (CTL_FAN_SPEED_UNITS was not imported).
  const fixed = await b.applySettings(0, { fixedFanPct: 30 });
  assert.equal(fixed.ok, true);
  assert.equal(fixed.perControl.fixedFanPct.ok, true);
  assert.equal(fixed.perControl.fixedFanPct.readBackEqual, true);
  const curve = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }, { t: 50, speedPct: 40 }] });
  assert.equal(curve.ok, true);
  assert.equal(curve.perControl.fanCurve.ok, true);
  assert.equal(curve.perControl.fanCurve.readBackEqual, true);
  assert.equal(lib.__calls.fanSetters, 2);
});

test('applySettings: fan mode gate matches the mock — out-of-set modes refused with unsupported, no driver write (F5 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x4 }); // curve only
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { fixedFanPct: 30 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fixedFanPct.errorCode, 'unsupported');
  assert.match(res.perControl.fixedFanPct.message, /fan mode fixed not supported/);
  assert.equal(lib.__calls.fanSetters, 0, 'a refused mode never reaches a driver setter');
  const ok = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  assert.equal(ok.ok, true, 'an in-set mode still applies');
});

test('applySettings: fan curve apply clamps %, sorts temps, enforces ascending before the driver write (F2 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x7 });
  const b = makeBackend(lib);
  const res = await b.applySettings(0, {
    fanMode: 'curve',
    fanCurve: [
      { t: 90, speedPct: 150 }, { t: 20, speedPct: -10 }, { t: 50, speedPct: 40 },
      { t: 21, speedPct: 130 }, { t: 22, speedPct: 5 }, { t: 22.4, speedPct: 7 },
    ],
  });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.fanCurve.ok, true);
  assert.equal(res.perControl.fanCurve.readBackEqual, true);
  // the setter received the CORRECTED table: rounded temps, sorted,
  // strictly ascending, % clamped to 0..100
  const sent = lib.__state.fanTable.map((p) => ({ t: p.temperature, speedPct: p.speed.speed }));
  assert.deepEqual(sent, [
    { t: 20, speedPct: 0 },    // -10 clamped to 0
    { t: 21, speedPct: 100 },  // 130 clamped to 100
    { t: 22, speedPct: 5 },
    { t: 23, speedPct: 7 },    // 22.4 rounds to 22 -> bumped to 23 (ascending)
    { t: 50, speedPct: 40 },
    { t: 90, speedPct: 100 },  // 150 clamped to 100
  ]);
});

test('applySettings: fixedFanPct is clamped to 0..100 before the driver write (F2 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true });
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { fixedFanPct: 150 });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.fixedFanPct.ok, true);
  assert.equal(res.perControl.fixedFanPct.readBackEqual, true);
  assert.equal(lib.__state.fixedSpeed, 100);
});

test('applySettings: fan payload parity — igcl and mock normalize identically (F2 regression)', async () => {
  const payload = {
    fanMode: 'curve',
    fanCurve: [
      { t: 90, speedPct: 150 }, { t: 20, speedPct: -10 }, { t: 50, speedPct: 40 },
      { t: 21, speedPct: 130 }, { t: 22, speedPct: 5 }, { t: 22.4, speedPct: 7 },
    ],
  };
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x7 });
  const igcl = makeBackend(lib);
  const igclRes = await igcl.applySettings(0, payload);
  assert.equal(igclRes.ok, true);
  const igclTable = lib.__state.fanTable.map((p) => ({ t: p.temperature, speedPct: p.speed.speed }));

  // M2D: the a770 featureset base is the read-only fan — the parity test
  // opts into the editable-fan overlay explicitly.
  const mock = new MockBackend({ fanCanControl: true });
  const mockRes = await mock.applySettings(0, payload);
  assert.equal(mockRes.ok, true);
  const mockTable = (await mock.getCurrentSettings(0)).fanCurve.map((p) => ({ t: p.t, speedPct: p.speedPct }));

  assert.deepEqual(igclTable, mockTable);
});

test('applySettings: fan curve apply fails when read-back mode differs (F2 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x7 });
  // Driver ignores the set and stays in default/auto mode.
  lib.ctlFanGetConfig = (h, cfgBuf) => {
    encodeFanConfig(cfgBuf, { mode: 0 });
    return 0;
  };
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fanCurve.ok, false);
  assert.equal(res.perControl.fanCurve.readBackEqual, false);
  assert.match(res.perControl.fanCurve.message, /fan mode read-back auto != requested curve/);
});

test('applySettings: fan curve apply fails when read-back points differ (F2 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x7 });
  // Driver keeps the mode but stores a different table.
  lib.ctlFanGetConfig = (h, cfgBuf) => {
    encodeFanConfig(cfgBuf, { mode: 2, numPoints: 1, tablePoints: [{ Size: 28, Version: 0, temperature: 20, speed: { Size: 16, Version: 0, speed: 99, units: 1 } }] });
    return 0;
  };
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fanCurve.ok, false);
  assert.equal(res.perControl.fanCurve.readBackEqual, false);
  assert.match(res.perControl.fanCurve.message, /point 0 read-back 20C\/99% != requested 20C\/20%/);
});

test('applySettings: fan curve read-back with a driver-reported numPoints > 32 fails controlled, not throws (N1 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x7 });
  // A broken driver reports 40 points into the fixed 32-element table; the
  // sibling read-back guards numPoints <= 32 — verifyFanConfig must too,
  // returning a controlled per-control failure instead of throwing on
  // tp.speed of an undefined table entry.
  lib.ctlFanGetConfig = (h, cfgBuf) => {
    encodeFanConfig(cfgBuf, { mode: 2, numPoints: 40 });
    return 0;
  };
  const b = makeBackend(lib);
  let res;
  try {
    res = await b.applySettings(0, { fanCurve: [{ t: 20, speedPct: 20 }] });
  } catch (err) {
    assert.fail(`applySettings must not throw on a bad point count: ${err.message}`);
  }
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fanCurve.ok, false);
  assert.equal(res.perControl.fanCurve.readBackEqual, false);
  assert.equal(res.perControl.fanCurve.errorCode, 'io-failed');
  assert.match(res.perControl.fanCurve.message, /invalid point count/);
});

test('applySettings: fixed fan speed fails when read-back speed differs (F2 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true });
  // Driver keeps fixed mode but applies a different percentage.
  lib.ctlFanGetConfig = (h, cfgBuf) => {
    encodeFanConfig(cfgBuf, { mode: 1, speed: 50, units: 1 });
    return 0;
  };
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { fixedFanPct: 30 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fixedFanPct.ok, false);
  assert.equal(res.perControl.fixedFanPct.readBackEqual, false);
  assert.match(res.perControl.fixedFanPct.message, /fixed fan speed read-back 50% != requested 30%/);
});

test('applySettings: fan auto mode fails when read-back mode differs (F2 regression)', async () => {
  const lib = makeFakeLib({ fanCanControl: true, supportedFanModes: 0x7 });
  // Driver stays in table mode instead of switching to default.
  lib.ctlFanGetConfig = (h, cfgBuf) => {
    encodeFanConfig(cfgBuf, { mode: 2 });
    return 0;
  };
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { fanMode: 'auto' });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.fanMode.ok, false);
  assert.equal(res.perControl.fanMode.readBackEqual, false);
  assert.match(res.perControl.fanMode.message, /fan mode read-back curve != requested auto/);
});

test('applySettings: waiver is gated — never auto-accepted without allowAutoWaiver', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  await b.applySettings(0, { powerLimitW: 252 });
  assert.equal(lib.__calls.waiver, 0);
  await b.setWaiverAccepted(0);
  assert.equal(lib.__calls.waiver, 1);
});

test('applySettings: allowAutoWaiver (smoke/tests) accepts once, then not again', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib, { allowAutoWaiver: true });
  await b.applySettings(0, { powerLimitW: 252 });
  await b.applySettings(0, { tempLimitC: 90 });
  assert.equal(lib.__calls.waiver, 1);
});

test('applySettings: IGCL OC error codes map to the canonical enum', async () => {
  const lib = makeFakeLib();
  // Make the power setter fail with waiver-not-set (as if the driver enforced it)
  const orig = lib.ctlOverclockPowerLimitSetV2;
  lib.ctlOverclockPowerLimitSetV2 = () => CTL_RESULT.ERROR_CORE_OVERCLOCK_WAIVER_NOT_SET;
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(res.perControl.powerLimitW.ok, false);
  assert.equal(res.perControl.powerLimitW.errorCode, 'waiver-not-set');
  lib.ctlOverclockPowerLimitSetV2 = orig;
});

test('applySettings: a waiver-not-set apply clears the stale in-memory flag (G2 regression)', async () => {
  const lib = makeFakeLib();
  // The driver LOST the waiver (reinstall / IGS reset) while settings.json
  // still says accepted: the setter answers waiver-not-set until re-accepted.
  const orig = lib.ctlOverclockPowerLimitSetV2;
  lib.ctlOverclockPowerLimitSetV2 = () => CTL_RESULT.ERROR_CORE_OVERCLOCK_WAIVER_NOT_SET;
  const b = makeBackend(lib, { allowAutoWaiver: true });
  await b.restoreWaiverState(0, true); // persisted-accepted boot seed
  assert.equal((await b.getCapabilities(0)).waiverAccepted, true);

  const res = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.powerLimitW.errorCode, 'waiver-not-set');
  // Reconciliation: the stale in-memory flag is cleared — caps now report
  // unaccepted so the renderer re-shows the waiver dialog on the next apply.
  assert.equal((await b.getCapabilities(0)).waiverAccepted, false);
  assert.equal(lib.__calls.waiver, 0); // clearing never accepts anything

  // Driver re-accepted: the next apply's waiver gate calls the driver set
  // again (once) and the apply succeeds.
  lib.ctlOverclockPowerLimitSetV2 = orig;
  const again = await b.applySettings(0, { powerLimitW: 220 });
  assert.equal(again.ok, true);
  assert.equal(lib.__calls.waiver, 1);
});

test('applySettings: read-back mismatch after set marks the control failed', async () => {
  const lib = makeFakeLib();
  const orig = lib.ctlOverclockPowerLimitSetV2;
  lib.ctlOverclockPowerLimitSetV2 = (h, v) => { lib.__state.powerLimitW = 200; return 0; }; // driver ignores the value
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { powerLimitW: 252 });
  assert.equal(res.perControl.powerLimitW.ok, false);
  assert.equal(res.ok, false);
  lib.ctlOverclockPowerLimitSetV2 = orig;
});

test('F3: a SILENT NO-OP (SUCCESS + unchanged read-back) is flagged silentNoop, never reported applied', async () => {
  // E4 evidence shape: the setter returns SUCCESS but the read-back never
  // changes (docs §8a). The backend must flag silentNoop so the retry core
  // treats it as retryable — never as "applied".
  const lib = makeFakeLib({ silentNoop: true });
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { powerLimitW: 220 });
  const per = res.perControl.powerLimitW;
  assert.equal(per.ok, false);
  assert.equal(per.readBackEqual, false);
  assert.equal(per.silentNoop, true);
  assert.equal(per.errorCode, 'io-failed');
  assert.equal(res.ok, false);
  assert.equal(lib.__state.powerLimitW, 252, 'device value unchanged (the no-op really was a no-op)');
});

test('F3 PT clamp: capabilities expose temp-limit max 90 even if the props report more', async () => {
  const lib = makeFakeLib({ tempLimitMax: 92 }); // props drift above the accepted max
  const b = makeBackend(lib);
  const caps = await b.getCapabilities(0);
  assert.equal(caps.ranges.tempLimitC.max, 90);
  assert.equal(caps.ranges.tempLimitC.default, 90);
  assert.equal(caps.ranges.powerLimitW.max, 252, 'other ranges are untouched');
});

test('F3 PT clamp: applying temp-limit 92 is clamped to 90 before the driver write', async () => {
  const lib = makeFakeLib({ tempLimitMax: 92 });
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { tempLimitC: 92 });
  assert.equal(res.ok, true);
  // The driver never saw 92 (it would refuse with 0x44000005) — it saw 90.
  assert.deepEqual(lib.__calls.sets.at(-1), ['tempLimit', 90]);
  const s = await b.getCurrentSettings(0);
  assert.equal(s.tempLimitC, 90);
});

// ---------------------------------------------------------------------------
// M2C-C extended ranges (bundled 2023 runtime capable -> full verified range)
// ---------------------------------------------------------------------------

test('M2C-C: no extended probe -> standard ranges, no flag', async () => {
  const b = makeBackend(makeFakeLib());
  const caps = await b.getCapabilities(0);
  assert.equal(caps.ranges.powerLimitW.max, 252);
  assert.equal(caps.ranges.tempLimitC.max, 90);
  assert.equal(caps.extendedRanges, undefined);
});

test('M3-C-E: extended probe capable + advanced mode -> PL max 315 / TL max 115 + the flag', async () => {
  const b = new IgclBackend({
    lib: makeFakeLib(),
    findDll: () => 'C:\\fake\\IntelControlLib.dll',
    dllPath: 'C:\\fake\\IntelControlLib.dll',
    extended: { isCapable: async () => true },
    ocMode: 'advanced',
  });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.extendedRanges, true);
  assert.equal(caps.ranges.powerLimitW.max, 315); // M3-C-D: live-verified ceiling
  assert.equal(caps.ranges.powerLimitW.min, 105, 'min stays the DriverStore value');
  assert.equal(caps.ranges.powerLimitW.default, 210, 'default stays the DriverStore value');
  assert.equal(caps.ranges.tempLimitC.max, 115);
  assert.equal(caps.ranges.tempLimitC.min, 60);
  assert.equal(caps.ranges.tempLimitC.default, 90);
});

test('M3-C-E: stock mode NEVER exposes the extended ranges even with a capable probe', async () => {
  const b = new IgclBackend({
    lib: makeFakeLib(),
    findDll: () => 'C:\\fake\\IntelControlLib.dll',
    dllPath: 'C:\\fake\\IntelControlLib.dll',
    extended: { isCapable: async () => true },
    // default ocMode = stock
  });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.extendedRanges, undefined, 'no flag in stock mode');
  assert.equal(caps.ranges.powerLimitW.max, 252, 'standard max in stock mode');
  assert.equal(caps.ranges.tempLimitC.max, 90);
});

test('M3-C-E: setOcMode invalidates the caps cache — the ranges follow the mode', async () => {
  const b = new IgclBackend({
    lib: makeFakeLib(),
    findDll: () => 'C:\\fake\\IntelControlLib.dll',
    dllPath: 'C:\\fake\\IntelControlLib.dll',
    extended: { isCapable: async () => true },
  });
  const stock = await b.getCapabilities(0);
  assert.equal(stock.extendedRanges, undefined);
  assert.equal(stock.ranges.powerLimitW.max, 252);
  b.setOcMode('advanced');
  const advanced = await b.getCapabilities(0);
  assert.equal(advanced.extendedRanges, true);
  assert.equal(advanced.ranges.powerLimitW.max, 315);
  b.setOcMode('stock');
  const stockAgain = await b.getCapabilities(0);
  assert.equal(stockAgain.extendedRanges, undefined);
  assert.equal(stockAgain.ranges.powerLimitW.max, 252);
  // A no-op mode change does not clear the cache (waiverAccepted survives).
  b.setOcMode('stock');
  const cached = await b.getCapabilities(0);
  assert.equal(cached.ranges.powerLimitW.max, 252);
});

test('M2C-C: extended probe NOT capable -> standard ranges, no flag (the degradation path)', async () => {
  const b = new IgclBackend({
    lib: makeFakeLib(),
    findDll: () => 'C:\\fake\\IntelControlLib.dll',
    dllPath: 'C:\\fake\\IntelControlLib.dll',
    extended: { isCapable: async () => false },
  });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.extendedRanges, undefined);
  assert.equal(caps.ranges.powerLimitW.max, 252);
  assert.equal(caps.ranges.tempLimitC.max, 90);
});

test('M2C-C: the extended ranges are cached with the caps (queried once)', async () => {
  let probes = 0;
  const b = new IgclBackend({
    lib: makeFakeLib(),
    findDll: () => 'C:\\fake\\IntelControlLib.dll',
    dllPath: 'C:\\fake\\IntelControlLib.dll',
    extended: { isCapable: async () => { probes += 1; return true; } },
  });
  await b.getCapabilities(0);
  await b.getCapabilities(0);
  assert.equal(probes, 1, 'the capability cache keeps the extended probe at one call');
});

test('M2C-C: no OC props (unsupported device) -> extended ranges stay off even when capable', async () => {
  const lib = makeFakeLib({ noProps: true });
  const b = new IgclBackend({
    lib,
    findDll: () => 'C:\\fake\\IntelControlLib.dll',
    dllPath: 'C:\\fake\\IntelControlLib.dll',
    extended: { isCapable: async () => true },
  });
  const caps = await b.getCapabilities(0);
  assert.equal(caps.extendedRanges, undefined, 'no powerLimit control -> nothing to extend');
});

test('applySettings: gpuLock round trip', async () => {
  const b = makeBackend(makeFakeLib());
  const res = await b.applySettings(0, { gpuLock: { voltageV: 0.2, freqMhz: 2100 } });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.gpuLock.ok, true);
  const s = await b.getCurrentSettings(0);
  assert.deepEqual(s.gpuLock, { voltageV: 0.2, freqMhz: 2100 });
});

test('applySettings: gpuLock extremes are clamped before the driver write (F1 regression)', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { gpuLock: { voltageV: 99, freqMhz: -5 } });
  assert.equal(res.ok, true);
  // Clamped to the documented bounds: [0, gpuVoltOffsetV.max] / [0, 5000].
  assert.deepEqual(lib.__calls.sets.at(-1), ['gpuLock', 0.234, 0]);
  const s = await b.getCurrentSettings(0);
  assert.deepEqual(s.gpuLock, { voltageV: 0.234, freqMhz: 0 });
});

test('applySettings: vfCurve writes and verifies by read-back (F2 regression)', async () => {
  const lib = makeFakeLib();
  const stored = [];
  lib.ctlOverclockReadVFCurve = (h, type, details, numBuf, curveBuf) => {
    if (curveBuf === null) { koffi.encode(numBuf, 'uint32', stored.length); return CTL_RESULT.SUCCESS; }
    const sz = koffi.sizeof('ctl_voltage_frequency_point_t');
    for (let i = 0; i < stored.length; i++) {
      koffi.encode(curveBuf, i * sz, 'ctl_voltage_frequency_point_t', stored[i]);
    }
    return CTL_RESULT.SUCCESS;
  };
  lib.ctlOverclockWriteCustomVFCurve = (h, n, pts) => {
    stored.length = 0;
    for (let i = 0; i < n; i++) stored.push({ Voltage: pts[i].Voltage, Frequency: pts[i].Frequency });
    return CTL_RESULT.SUCCESS;
  };
  const b = makeBackend(lib);
  assert.equal((await b.getCapabilities(0)).controls.vfCurve, true);
  // ctl_voltage_frequency_point_t holds uint32 fields — use values that
  // round-trip exactly through the struct (the canonical volts<->u32 mapping
  // for VF curves is a Battlemage/M4 concern; M1 only pins the verification).
  const res = await b.applySettings(0, { vfCurve: [{ voltageV: 1, freqMhz: 1800 }, { voltageV: 1, freqMhz: 2000 }] });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.vfCurve.ok, true);
  assert.equal(res.perControl.vfCurve.readBackEqual, true);
});

test('applySettings: vfCurve fails when read-back points differ (F2 regression)', async () => {
  const lib = makeFakeLib();
  lib.ctlOverclockReadVFCurve = (h, type, details, numBuf, curveBuf) => {
    if (curveBuf === null) { koffi.encode(numBuf, 'uint32', 1); return CTL_RESULT.SUCCESS; }
    koffi.encode(curveBuf, 0, 'ctl_voltage_frequency_point_t', { Voltage: 0.9, Frequency: 1500 });
    return CTL_RESULT.SUCCESS;
  };
  lib.ctlOverclockWriteCustomVFCurve = (h, n, pts) => CTL_RESULT.SUCCESS;
  const b = makeBackend(lib);
  const res = await b.applySettings(0, { vfCurve: [{ voltageV: 1, freqMhz: 1800 }] });
  assert.equal(res.ok, false);
  assert.equal(res.perControl.vfCurve.ok, false);
  assert.equal(res.perControl.vfCurve.readBackEqual, false);
  assert.match(res.perControl.vfCurve.message, /VF curve point 0 read-back/);
});

test('applySettings: empty settings is a clean ok', async () => {
  const b = makeBackend(makeFakeLib());
  const res = await b.applySettings(0, {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.perControl, {});
});

test('applySettings: snapToStep:false writes back off-grid values exactly (no-op safety)', async () => {
  const lib = makeFakeLib({ gpuFreqOffsetMhz: 48.3027650143675 });
  const b = makeBackend(lib);
  // default snapping would move 48.3 -> 48 (a state change!) — the flag must
  // preserve the exact current value for smoke no-op round trips.
  const res = await b.applySettings(0, { gpuFreqOffsetMhz: 48.3027650143675 }, { snapToStep: false });
  assert.equal(res.ok, true);
  assert.equal(res.perControl.gpuFreqOffsetMhz.readBackEqual, true);
  const set = lib.__calls.sets.find(([c]) => c === 'gpuFreqOffset');
  assert.equal(set[1], 48.3027650143675);
  const state = await b.getCurrentSettings(0);
  assert.equal(state.gpuFreqOffsetMhz, 48.3027650143675);
});

test('resetToDefaults: calls ctlOverclockResetToDefault', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  await b.resetToDefaults(0);
  assert.equal(lib.__calls.reset, 1);
});

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

test('sampleRawTelemetry: maps 1:1 IGCL items to RawTelemetrySample', async () => {
  const b = makeBackend(makeFakeLib());
  const s = await b.sampleRawTelemetry(0);
  assert.equal(typeof s.t, 'number');
  assert.equal(s.gpuClockMhz, 600);
  assert.equal(s.memClockMhz, 2000);
  assert.equal(s.tempC, 36);
  assert.equal(s.vramTempC, 44);
  assert.equal(s.gpuVoltageV, 0.652);
  assert.equal(typeof s.gpuEnergyJ, 'number');
  assert.deepEqual(s.fanRpm, [1030]);
  assert.equal(s.throttle.power, false);
});

test('onRawTelemetry: subscriber receives samples; unsubscribe works', async () => {
  const b = makeBackend(makeFakeLib());
  const seen = [];
  const unsub = b.onRawTelemetry(0, (s) => seen.push(s));
  await b.sampleRawTelemetry(0);
  assert.equal(seen.length, 1);
  unsub();
  await b.sampleRawTelemetry(0);
  assert.equal(seen.length, 1);
});

// ---------------------------------------------------------------------------
// M3-C-L — utilization from the IGCL activity counters (sample-delta method)
// ---------------------------------------------------------------------------

function activityLib({ global = true, rampPerSample = 0.09, dt = 0.2, firstActivity = 1000.0 } = {}) {
  const lib = makeFakeLib();
  const st = lib.__state;
  const sampleOnce = (telBuf) => {
    st.telemetryT += dt;
    st.telemetryActivity = (st.telemetryActivity ?? firstActivity) + rampPerSample;
    koffi.encode(telBuf, 'ctl_power_telemetry_t', {
      Size: 1024, Version: 1,
      timeStamp: { bSupported: true, units: 7, type: 9, value: st.telemetryT },
      gpuCurrentClockFrequency: { bSupported: true, units: 0, type: 9, value: 600 },
      globalActivityCounter: global ? { bSupported: true, units: 7, type: 9, value: st.telemetryActivity } : { bSupported: false, units: 7, type: 9, value: 0 },
      renderComputeActivityCounter: { bSupported: true, units: 7, type: 9, value: st.telemetryActivity },
      gpuCurrentTemperature: { bSupported: true, units: 5, type: 9, value: 36 },
      gpuPowerLimited: false, gpuTemperatureLimited: false, gpuCurrentLimited: false,
      gpuVoltageLimited: false, gpuUtilizationLimited: false,
    });
  };
  lib.ctlPowerTelemetryGet = (_h, telBuf) => { sampleOnce(telBuf); return 0; };
  return lib;
}

test('M3-C-L: utilPct = activityCounterDelta / timestampDelta * 100 (documented method)', async () => {
  // 0.09 s busy per 0.2 s -> 45%.
  const b = makeBackend(activityLib());
  const s0 = await b.sampleRawTelemetry(0);
  assert.equal(s0.utilPct, undefined, 'first sample has no delta');
  const s1 = await b.sampleRawTelemetry(0);
  assert.ok(Math.abs(s1.utilPct - 45) < 1e-6, `utilPct = ${s1.utilPct} (expected 45)`);
  assert.ok(s1.utilPct >= 0 && s1.utilPct <= 100);
});

test('M3-C-L: renderComputeActivityCounter is the fallback when the global counter is unpopulated', async () => {
  const b = makeBackend(activityLib({ global: false }));
  await b.sampleRawTelemetry(0);
  const s1 = await b.sampleRawTelemetry(0);
  assert.ok(Math.abs(s1.utilPct - 45) < 1e-6, `fallback utilPct = ${s1.utilPct} (expected 45)`);
});

test('M3-C-L: no populated activity counter -> utilPct stays undefined (never 0)', async () => {
  const lib = makeFakeLib();
  lib.ctlPowerTelemetryGet = (_h, telBuf) => {
    const st = lib.__state;
    st.telemetryT += 0.2;
    koffi.encode(telBuf, 'ctl_power_telemetry_t', {
      Size: 1024, Version: 1,
      timeStamp: { bSupported: true, units: 7, type: 9, value: st.telemetryT },
      gpuCurrentClockFrequency: { bSupported: true, units: 0, type: 9, value: 600 },
      gpuPowerLimited: false, gpuTemperatureLimited: false, gpuCurrentLimited: false,
      gpuVoltageLimited: false, gpuUtilizationLimited: false,
    });
    return 0;
  };
  const b = makeBackend(lib);
  await b.sampleRawTelemetry(0);
  const s1 = await b.sampleRawTelemetry(0);
  assert.equal(s1.utilPct, undefined);
});

test('M3-C-L: a counter reset (negative delta) degrades to undefined — never a bogus value', async () => {
  const lib = makeFakeLib();
  const st = lib.__state;
  let call = 0;
  lib.ctlPowerTelemetryGet = (_h, telBuf) => {
    call++;
    st.telemetryT += 0.2;
    // Second sample: the counter "reset" below the first sample's value.
    const activity = call === 1 ? 1000.0 : 500.0;
    koffi.encode(telBuf, 'ctl_power_telemetry_t', {
      Size: 1024, Version: 1,
      timeStamp: { bSupported: true, units: 7, type: 9, value: st.telemetryT },
      globalActivityCounter: { bSupported: true, units: 7, type: 9, value: activity },
      gpuPowerLimited: false, gpuTemperatureLimited: false, gpuCurrentLimited: false,
      gpuVoltageLimited: false, gpuUtilizationLimited: false,
    });
    return 0;
  };
  const b = makeBackend(lib);
  await b.sampleRawTelemetry(0);
  const s1 = await b.sampleRawTelemetry(0);
  assert.equal(s1.utilPct, undefined);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

test('health: reports igclLoaded/driverVersion/levelZeroOk', async () => {
  const b = makeBackend(makeFakeLib());
  const h = await b.health();
  assert.equal(h.igclLoaded, false); // not initialized yet
  await b.init();
  const h2 = await b.health();
  assert.equal(h2.igclLoaded, true);
  assert.equal(h2.levelZeroOk, true);
  assert.equal(h2.driverVersion, '0x002000000065229d');
});

test('health: reports the init error when init failed', async () => {
  const lib = makeFakeLib({ ctlInitResult: CTL_RESULT.ERROR_ZE_LOADER });
  const b = makeBackend(lib);
  await assert.rejects(b.init());
  const h = await b.health();
  assert.equal(h.igclLoaded, false);
  assert.match(h.error, /Level Zero/);
});

test('close: clears state and tolerates ctlClose STILL_OPEN', async () => {
  const lib = makeFakeLib();
  const b = makeBackend(lib);
  await b.init();
  await b.close();
  assert.equal(b._apiHandle, null);
});
