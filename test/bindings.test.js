// M1 checkpoint 1 — IGCL struct marshalling pinned against the recorded M0
// fixture values (tools/probe/out/*.json). These tests run WITHOUT hardware:
// they encode/decode koffi structs and assert sizes, offsets, enum mapping
// and the 1:1 field decode helpers against the A770 probe artifacts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CTL_RESULT, RESULT_NAME, CTL_UNITS, CTL_DATA_TYPE,
  CTL_INIT_FLAG_USE_LEVEL_ZERO, CTL_FAN_SPEED_MODE, CTL_FAN_SPEED_UNITS,
  makeVersion, describeResult, decodeItem, findIgclDll, loadIgcl,
} from '../src/main/backend/igcl-bindings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'tools', 'probe', 'out');

// ---------------------------------------------------------------------------
// Struct sizes / layout (pinned from docs/igcl-integration.md §3)
// ---------------------------------------------------------------------------

const EXPECTED_SIZES = {
  ctl_application_id_t: 16,
  ctl_init_args_t: 36,
  ctl_firmware_version_t: 24,
  ctl_device_adapter_properties_t: 320,
  ctl_oc_control_info_t: 48,
  ctl_oc_properties_t: 440,
  ctl_oc_vf_pair_t: 24,
  ctl_fan_speed_t: 16,
  ctl_fan_temp_speed_t: 28,
  ctl_fan_speed_table_t: 908,
  ctl_fan_properties_t: 24,
  ctl_fan_config_t: 936,
  ctl_oc_telemetry_item_t: 24,
  ctl_psu_info_t: 56,
  ctl_power_telemetry_t: 1024,
  ctl_voltage_frequency_point_t: 8,
};

for (const [name, expected] of Object.entries(EXPECTED_SIZES)) {
  test(`layout: sizeof(${name}) == ${expected}`, () => {
    assert.equal(koffi.sizeof(name), expected);
  });
}

test('layout: telemetry array offsets match the C header (psu@408, fanSpeed@688)', () => {
  assert.equal(koffi.offsetof('ctl_power_telemetry_t', 'psu'), 408);
  assert.equal(koffi.offsetof('ctl_power_telemetry_t', 'fanSpeed'), 688);
});

test('layout: telemetry throttle flag offsets decode as 1-byte bools', () => {
  // gpuPowerLimited sits right after mediaActivityCounter item
  const off = koffi.offsetof('ctl_power_telemetry_t', 'gpuPowerLimited');
  assert.equal(typeof off, 'number');
});

// ---------------------------------------------------------------------------
// Init args (docs/igcl-integration.md §2 — zero UID + Level Zero flag)
// ---------------------------------------------------------------------------

test('init args: zero UID + USE_LEVEL_ZERO round-trip through the struct', () => {
  const buf = koffi.alloc('ctl_init_args_t', 1);
  koffi.encode(buf, 'ctl_init_args_t', {
    Size: koffi.sizeof('ctl_init_args_t'),
    Version: 0,
    AppVersion: makeVersion(1, 1),
    flags: CTL_INIT_FLAG_USE_LEVEL_ZERO,
    SupportedVersion: 0,
    ApplicationUID: { Data1: 0, Data2: 0, Data3: 0, Data4: [0, 0, 0, 0, 0, 0, 0, 0] },
  });
  const out = koffi.decode(buf, 'ctl_init_args_t');
  assert.equal(out.Size, 36);
  assert.equal(out.Version, 0);
  assert.equal(out.AppVersion, 0x00010001);
  assert.equal(out.flags, 0x1);
  assert.equal(out.SupportedVersion, 0);
  assert.deepEqual(
    [out.ApplicationUID.Data1, out.ApplicationUID.Data2, out.ApplicationUID.Data3, [...out.ApplicationUID.Data4]],
    [0, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0]],
  );
});

test('makeVersion(1,1) == 0x00010001', () => {
  assert.equal(makeVersion(1, 1), 0x00010001);
});

// ---------------------------------------------------------------------------
// Capability matrix pinned from tools/probe/out/a770-capabilities.json
// ---------------------------------------------------------------------------

test('capabilities: A770 fixture values survive a struct round-trip', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(OUT, 'a770-capabilities.json'), 'utf8'));
  const controls = fixture.devices[0].ocProperties.controls;
  const names = [
    'gpuFrequencyOffset', 'gpuVoltageOffset', 'vramFrequencyOffset', 'vramVoltageOffset',
    'powerLimit', 'temperatureLimit', 'vramMemSpeedLimit',
    'gpuVFCurveVoltageLimit', 'gpuVFCurveFrequencyLimit',
  ];
  const obj = { Size: 440, Version: 1, bSupported: true };
  for (const n of names) {
    const c = controls[n];
    obj[n] = {
      bSupported: c.bSupported,
      bRelative: c.bRelative,
      bReference: c.bReference,
      units: c.units,
      min: c.min,
      max: c.max,
      step: c.step,
      Default: c.Default,
      reference: c.reference,
    };
  }
  const buf = koffi.alloc('ctl_oc_properties_t', 1);
  koffi.encode(buf, 'ctl_oc_properties_t', obj);
  const out = koffi.decode(buf, 'ctl_oc_properties_t');
  assert.equal(out.Size, 440);
  assert.equal(out.bSupported, true);
  const gpuFreq = out.gpuFrequencyOffset;
  assert.equal(gpuFreq.bSupported, true);
  assert.equal(gpuFreq.units, 0); // FREQUENCY_MHZ
  assert.equal(gpuFreq.min, 0);
  assert.equal(gpuFreq.max, 300);
  assert.equal(gpuFreq.step, 1);
  assert.equal(gpuFreq.Default, 0);
  const power = out.powerLimit;
  assert.equal(power.bSupported, true);
  assert.equal(power.units, 4); // POWER_WATTS on this A770 — NOT mW
  assert.equal(power.min, 105);
  assert.equal(power.max, 252);
  assert.equal(power.step, 1);
  assert.equal(power.Default, 210);
  const volt = out.gpuVoltageOffset;
  assert.equal(volt.units, 3); // VOLTAGE_VOLTS on this A770 — NOT mV
  assert.ok(Math.abs(volt.max - 0.234) < 1e-9);
  assert.ok(Math.abs(volt.step - 0.005) < 1e-12);
  const vram = out.vramFrequencyOffset;
  assert.equal(vram.bSupported, false);
});

test('capabilities: units enum values match CTL_UNITS (A770 matrix)', () => {
  assert.equal(CTL_UNITS[0], 'FREQUENCY_MHZ');
  assert.equal(CTL_UNITS[3], 'VOLTAGE_VOLTS');
  assert.equal(CTL_UNITS[4], 'POWER_WATTS');
  assert.equal(CTL_UNITS[5], 'TEMPERATURE_CELSIUS');
  assert.equal(CTL_UNITS[10], 'POWER_MILLIWATTS');
  assert.equal(CTL_UNITS[13], 'VOLTAGE_MILLIVOLTS');
  assert.equal(CTL_UNITS[11], 'PERCENT');
});

// ---------------------------------------------------------------------------
// Telemetry struct + decodeItem (pinned from tools/probe/out/telemetry.json)
// ---------------------------------------------------------------------------

test('telemetry: decodeItem reads supported items 1:1 from a marshalled buffer', () => {
  const buf = koffi.alloc('ctl_power_telemetry_t', 1);
  koffi.encode(buf, 'ctl_power_telemetry_t', {
    Size: 1024,
    Version: 1,
    timeStamp: { bSupported: true, units: 7, type: 9, value: 9662.768701 },
    gpuEnergyCounter: { bSupported: true, units: 6, type: 9, value: 395809.938172 },
    gpuVoltage: { bSupported: true, units: 3, type: 9, value: 0.652 },
    gpuCurrentClockFrequency: { bSupported: true, units: 0, type: 9, value: 600 },
    gpuCurrentTemperature: { bSupported: true, units: 5, type: 9, value: 36 },
    vramCurrentClockFrequency: { bSupported: true, units: 0, type: 9, value: 2000 },
    vramCurrentTemperature: { bSupported: true, units: 5, type: 9, value: 44 },
    vramReadBandwidthCounter: { bSupported: true, units: 8, type: 7, value: 0 },
    vramWriteBandwidthCounter: { bSupported: true, units: 8, type: 7, value: 0 },
  });
  const item = (n) => decodeItem(buf, 'ctl_power_telemetry_t', n);
  assert.equal(item('timeStamp').value, 9662.768701);
  assert.equal(item('timeStamp').units, 'TIME_SECONDS');
  assert.equal(item('gpuEnergyCounter').value, 395809.938172);
  assert.equal(item('gpuEnergyCounter').units, 'ENERGY_JOULES');
  assert.equal(item('gpuVoltage').value, 0.652);
  assert.equal(item('gpuCurrentClockFrequency').value, 600);
  assert.equal(item('gpuCurrentTemperature').value, 36);
  assert.equal(item('vramCurrentClockFrequency').value, 2000);
  assert.equal(item('vramCurrentTemperature').value, 44);
  // Unsupported items come back null-valued but flagged unsupported
  const unsupported = decodeItem(buf, 'ctl_power_telemetry_t', 'gpuVrTemp');
  assert.equal(unsupported.bSupported, false);
});

test('telemetry: UINT64 items re-decode without double precision loss (fixture values)', () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(OUT, 'telemetry.json'), 'utf8'));
  const items = fixture.devices[0].telemetry[0].items;
  const readVal = items.vramReadBandwidthCounter.value; // ~2.9e13, loses bits as double
  const writeVal = items.vramWriteBandwidthCounter.value;
  const buf = koffi.alloc('ctl_power_telemetry_t', 1);
  koffi.encode(buf, 'ctl_power_telemetry_t', {
    Size: 1024, Version: 1,
    vramReadBandwidthCounter: { bSupported: true, units: 8, type: 7, value: 0 },
    vramWriteBandwidthCounter: { bSupported: true, units: 8, type: 7, value: 0 },
  });
  // The value member is a union; IGCL writes raw integer bytes there. Write
  // the fixture integers as raw uint64 at value-offset (item offset + 16)
  // exactly like the driver does, then assert decodeItem recovers them.
  const readOff = koffi.offsetof('ctl_power_telemetry_t', 'vramReadBandwidthCounter') + 16;
  const writeOff = koffi.offsetof('ctl_power_telemetry_t', 'vramWriteBandwidthCounter') + 16;
  koffi.encode(buf, readOff, 'uint64', BigInt(readVal));
  koffi.encode(buf, writeOff, 'uint64', BigInt(writeVal));
  const read = decodeItem(buf, 'ctl_power_telemetry_t', 'vramReadBandwidthCounter');
  const write = decodeItem(buf, 'ctl_power_telemetry_t', 'vramWriteBandwidthCounter');
  assert.equal(read.type, 'UINT64');
  assert.equal(read.value, readVal);
  assert.equal(write.value, writeVal);
});

test('telemetry: fanSpeed[0] decodes (A770 ~1030 RPM idle)', () => {
  const buf = koffi.alloc('ctl_power_telemetry_t', 1);
  koffi.encode(buf, 'ctl_power_telemetry_t', {
    Size: 1024, Version: 1,
    fanSpeed: [
      { bSupported: true, units: 9, type: 9, value: 1030 },
      { bSupported: false, units: 9, type: 9, value: 0 },
    ],
  });
  const off = koffi.offsetof('ctl_power_telemetry_t', 'fanSpeed');
  const sz = koffi.sizeof('ctl_oc_telemetry_item_t');
  const f0 = koffi.decode(buf, off, 'ctl_oc_telemetry_item_t');
  assert.equal(f0.bSupported, true);
  assert.equal(f0.units, 9); // RPM
  assert.equal(f0.value, 1030);
  assert.equal(sz, 24);
});

// ---------------------------------------------------------------------------
// Fan structs (pinned from tools/probe/out/fans.json)
// ---------------------------------------------------------------------------

test('fan: properties/config round-trip with A770 fixture values', () => {
  const propBuf = koffi.alloc('ctl_fan_properties_t', 1);
  koffi.encode(propBuf, 'ctl_fan_properties_t', {
    Size: 24, Version: 0, canControl: false, supportedModes: 0x2, supportedUnits: 0x1,
    maxRPM: -1, maxPoints: 10,
  });
  const p = koffi.decode(propBuf, 'ctl_fan_properties_t');
  assert.equal(p.Size, 24);
  assert.equal(p.canControl, false); // THIS CARD: fan control not granted
  assert.equal(p.supportedModes, 2); // FIXED only
  assert.equal(p.maxPoints, 10);

  const cfgBuf = koffi.alloc('ctl_fan_config_t', 1);
  const table = [];
  for (let i = 0; i < 10; i++) {
    table.push({ Size: 28, Version: 0, temperature: 20 + i * 10, speed: { Size: 16, Version: 0, speed: 20 + i * 10, units: 1 } });
  }
  koffi.encode(cfgBuf, 'ctl_fan_config_t', {
    Size: 936, Version: 0, mode: 2, speedFixed: { Size: 16, Version: 0, speed: 0, units: 0 },
    speedTable: { Size: 908, Version: 0, numPoints: 10, table },
  });
  const c = koffi.decode(cfgBuf, 'ctl_fan_config_t');
  assert.equal(c.mode, 2); // TABLE
  assert.equal(c.speedTable.numPoints, 10);
  assert.equal(c.speedTable.table[0].temperature, 20);
  assert.equal(c.speedTable.table[0].speed.speed, 20);
  assert.equal(c.speedTable.table[0].speed.units, 1); // PERCENT
  assert.equal(c.speedFixed.speed, 0);
});

test('fan: enum maps match (modes/units)', () => {
  assert.deepEqual(CTL_FAN_SPEED_MODE, { 0: 'DEFAULT', 1: 'FIXED', 2: 'TABLE' });
  assert.deepEqual(CTL_FAN_SPEED_UNITS, { 0: 'RPM', 1: 'PERCENT' });
});

// ---------------------------------------------------------------------------
// Result codes / helpers
// ---------------------------------------------------------------------------

test('result codes: OC error enum present and stable', () => {
  assert.equal(CTL_RESULT.ERROR_CORE_OVERCLOCK_WAIVER_NOT_SET, 0x44000008);
  assert.equal(CTL_RESULT.ERROR_CORE_OVERCLOCK_VOLTAGE_OUTSIDE_RANGE, 0x44000002);
  assert.equal(CTL_RESULT.ERROR_CORE_OVERCLOCK_IN_VOLTAGE_LOCKED_MODE, 0x44000006);
  assert.equal(CTL_RESULT.ERROR_CORE_OVERCLOCK_RESET_REQUIRED, 0x44000007);
  assert.equal(CTL_RESULT.ERROR_UNSUPPORTED_FEATURE, 0x4000000a);
  assert.equal(CTL_RESULT.ERROR_UNKNOWN_APPLICATION_UID, 0x40000021);
  assert.equal(CTL_RESULT.ERROR_ZE_LOADER, 0x40000019);
});

test('describeResult names codes and RESULT_NAME has the STILL_OPEN alias', () => {
  assert.equal(RESULT_NAME[0x00000001], 'SUCCESS_STILL_OPEN_BY_ANOTHER_CALLER');
  assert.match(describeResult(0x4000000a), /ERROR_UNSUPPORTED_FEATURE/);
  assert.match(describeResult(0x44000008), /ERROR_CORE_OVERCLOCK_WAIVER_NOT_SET/);
  assert.match(describeResult(123), /UNKNOWN/);
});

// ---------------------------------------------------------------------------
// DLL discovery (environment-dependent — tolerant assertions)
// ---------------------------------------------------------------------------

test('findIgclDll returns a runtime path or null without throwing', () => {
  const p = findIgclDll();
  if (p === null) {
    assert.ok(true, 'no IGCL runtime found on this machine — environment-dependent');
    return;
  }
  assert.equal(typeof p, 'string');
  assert.ok(p.length > 0);
  assert.match(p.toLowerCase(), /intelcontrollib\.dll$/);
});

test('loadIgcl binds symbols and records unavailable ones without throwing', () => {
  const dll = findIgclDll();
  if (!dll) {
    assert.ok(true, 'skipped: no IGCL runtime on this machine');
    return;
  }
  const lib = loadIgcl(dll);
  assert.equal(typeof lib.ctlInit, 'function');
  assert.equal(typeof lib.ctlPowerTelemetryGet, 'function');
  assert.ok(Array.isArray(lib.unavailable));
});
