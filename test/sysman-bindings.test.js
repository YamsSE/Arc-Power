// M2b checkpoint 1 — Level Zero Sysman struct marshalling pinned against the
// v1.32.0 header layouts. These tests run WITHOUT the DLL: they pin koffi
// struct sizes/offsets against hand-computed MSVC x64 layouts, decode raw
// byte fixtures (the exact bytes the driver would write), and exercise the
// two-step handle enumeration helper with a fake enumerator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ZES_OVERCLOCK_DOMAIN, ZES_OVERCLOCK_CONTROL, ZES_PENDING_ACTION,
  ZES_CONTROL_STATE, ZES_OVERCLOCK_MODE, bitmaskNames,
  ZE_RESULT_NAME, describeZeResult, zeOk,
  decodePowerLimits, enumerateHandles, findZeLoaderDll, loadSysman,
} from '../src/main/sysman/sysman-bindings.js';

// ---------------------------------------------------------------------------
// Struct layout (pinned from zes_api.h v1.32.0, MSVC x64)
// ---------------------------------------------------------------------------

test('layout: legacy power-limit struct sizes match the C header', () => {
  assert.equal(koffi.sizeof('zes_power_sustained_limit_t'), 12);
  assert.equal(koffi.sizeof('zes_power_burst_limit_t'), 8);
  assert.equal(koffi.sizeof('zes_power_peak_limit_t'), 8);
});

test('layout: field offsets match hand-computed C offsets (bool pads to 4)', () => {
  // zes_power_sustained_limit_t { ze_bool_t enabled@0; int32_t power@4; int32_t interval@8; }
  assert.equal(koffi.offsetof('zes_power_sustained_limit_t', 'enabled'), 0);
  assert.equal(koffi.offsetof('zes_power_sustained_limit_t', 'power'), 4);
  assert.equal(koffi.offsetof('zes_power_sustained_limit_t', 'interval'), 8);
  // zes_power_burst_limit_t { ze_bool_t enabled@0; int32_t power@4; }
  assert.equal(koffi.offsetof('zes_power_burst_limit_t', 'enabled'), 0);
  assert.equal(koffi.offsetof('zes_power_burst_limit_t', 'power'), 4);
  // zes_power_peak_limit_t { int32_t powerAC@0; int32_t powerDC@4; }
  assert.equal(koffi.offsetof('zes_power_peak_limit_t', 'powerAC'), 0);
  assert.equal(koffi.offsetof('zes_power_peak_limit_t', 'powerDC'), 4);
});

test('layout: overclock property structs (domain 32, control 40)', () => {
  assert.equal(koffi.sizeof('zes_overclock_properties_t'), 32);
  assert.equal(koffi.sizeof('zes_control_property_t'), 40);
  assert.equal(koffi.offsetof('zes_overclock_properties_t', 'domainType'), 16);
  assert.equal(koffi.offsetof('zes_overclock_properties_t', 'AvailableControls'), 20);
  assert.equal(koffi.offsetof('zes_control_property_t', 'MaxValue'), 8);
  assert.equal(koffi.offsetof('zes_control_property_t', 'DefaultValue'), 32);
});

// ---------------------------------------------------------------------------
// Raw-buffer decode (bytes written by hand at C offsets — pins the decode
// helper independent of koffi's own layout)
// ---------------------------------------------------------------------------

test('decodePowerLimits: decodes a driver-style 28-byte fixture buffer', () => {
  const buf = koffi.alloc('uint8', 28);
  // sustained: enabled=1 @0, power=252000 mW @4, interval=2000 ms @8
  koffi.encode(buf, 0, 'uint8', 1);
  koffi.encode(buf, 4, 'int32', 252000);
  koffi.encode(buf, 8, 'int32', 2000);
  // burst: enabled=0 @12, power=0 @16
  koffi.encode(buf, 12, 'uint8', 0);
  koffi.encode(buf, 16, 'int32', 0);
  // peak: powerAC=300000 @20, powerDC=-1 @24 (no battery -> -1 per header)
  koffi.encode(buf, 20, 'int32', 300000);
  koffi.encode(buf, 24, 'int32', -1);

  const { sustained, burst, peak } = decodePowerLimits(buf);
  assert.equal(sustained.enabled, 1);
  assert.equal(sustained.power, 252000);
  assert.equal(sustained.interval, 2000);
  assert.equal(burst.enabled, 0);
  assert.equal(burst.power, 0);
  assert.equal(peak.powerAC, 300000);
  assert.equal(peak.powerDC, -1);
});

test('decodePowerLimits: 300 W sustained set (the M2b unlock experiment fixture)', () => {
  const buf = koffi.alloc('uint8', 28);
  koffi.encode(buf, 0, 'uint8', 1); // enabled
  koffi.encode(buf, 4, 'int32', 300000); // 300 W in mW — beyond the 252 W IGCL cap
  koffi.encode(buf, 8, 'int32', 2000);
  const { sustained } = decodePowerLimits(buf);
  assert.equal(sustained.power, 300000);
});

test('decodePowerLimits: struct objects encode back through koffi (round trip)', () => {
  const buf = koffi.alloc('uint8', 28);
  const limits = {
    sustained: { enabled: 1, power: 228000, interval: 1000 },
    burst: { enabled: 1, power: 250000 },
    peak: { powerAC: 300000, powerDC: -1 },
  };
  koffi.encode(buf, 0, 'zes_power_sustained_limit_t', limits.sustained);
  koffi.encode(buf, 12, 'zes_power_burst_limit_t', limits.burst);
  koffi.encode(buf, 20, 'zes_power_peak_limit_t', limits.peak);
  const out = decodePowerLimits(buf);
  assert.deepEqual(out, limits);
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

test('enums: domain/control bitmask values match zes_api.h v1.32.0', () => {
  assert.equal(ZES_OVERCLOCK_DOMAIN[1], 'CARD');
  assert.equal(ZES_OVERCLOCK_DOMAIN[2], 'PACKAGE');
  assert.equal(ZES_OVERCLOCK_DOMAIN[4], 'GPU_ALL');
  assert.equal(ZES_OVERCLOCK_CONTROL[2], 'FREQ_OFFSET');
  assert.equal(ZES_OVERCLOCK_CONTROL[32], 'POWER_SUSTAINED_LIMIT');
  assert.equal(ZES_OVERCLOCK_CONTROL[64], 'POWER_BURST_LIMIT');
  assert.equal(ZES_OVERCLOCK_CONTROL[128], 'POWER_PEAK_LIMIT');
  assert.equal(ZES_OVERCLOCK_CONTROL[512], 'TEMP_LIMIT');
});

test('bitmaskNames: decodes a combined bitmask into names', () => {
  // CARD + PACKAGE + GPU_ALL
  assert.deepEqual(bitmaskNames(1 | 2 | 4, ZES_OVERCLOCK_DOMAIN), ['CARD', 'PACKAGE', 'GPU_ALL']);
  // FREQ_OFFSET | POWER_SUSTAINED_LIMIT | TEMP_LIMIT
  assert.deepEqual(bitmaskNames(2 | 32 | 512, ZES_OVERCLOCK_CONTROL), ['FREQ_OFFSET', 'POWER_SUSTAINED_LIMIT', 'TEMP_LIMIT']);
  assert.deepEqual(bitmaskNames(0, ZES_OVERCLOCK_CONTROL), []);
  assert.deepEqual(bitmaskNames(0x7fffffff, ZES_OVERCLOCK_CONTROL), Object.keys(ZES_OVERCLOCK_CONTROL).map((k) => ZES_OVERCLOCK_CONTROL[k]));
});

test('pending action / control state / overclock mode enums', () => {
  assert.deepEqual(ZES_PENDING_ACTION[0], 'PENDING_NONE');
  assert.deepEqual(ZES_PENDING_ACTION[2], 'PENDING_COLD_RESET');
  assert.deepEqual(ZES_CONTROL_STATE[2], 'STATE_ACTIVE');
  assert.deepEqual(ZES_OVERCLOCK_MODE[3], 'MODE_ON');
});

// ---------------------------------------------------------------------------
// Result codes
// ---------------------------------------------------------------------------

test('describeZeResult: names old-era + OC codes, prints hex for unknowns', () => {
  assert.equal(zeOk(0), true);
  assert.equal(zeOk(0x78000001), false);
  assert.match(describeZeResult(0), /SUCCESS/);
  assert.match(describeZeResult(0x78000026), /ERROR_OVERCLOCK_WAIVER_NOT_SET/);
  assert.match(describeZeResult(0x78000025), /ERROR_OVERCLOCK_OUT_OF_RANGE/);
  assert.match(describeZeResult(0x78000009), /ERROR_NOT_AVAILABLE/);
  assert.match(describeZeResult(0x78000012), /ERROR_INVALID_ENUMERATION/);
  const unknown = describeZeResult(0x1234);
  assert.match(unknown, /UNKNOWN/);
  assert.match(unknown, /0x00001234/);
});

test('ZE_RESULT_NAME: OC-specific codes are present and stable', () => {
  assert.equal(ZE_RESULT_NAME[0x78000023], 'ERROR_INVALID_OVERCLOCK_SETTING');
  assert.equal(ZE_RESULT_NAME[0x78000024], 'ERROR_OVERCLOCK_NOT_SUPPORTED');
  assert.equal(ZE_RESULT_NAME[0x78000025], 'ERROR_OVERCLOCK_OUT_OF_RANGE');
  assert.equal(ZE_RESULT_NAME[0x78000026], 'ERROR_OVERCLOCK_WAIVER_NOT_SET');
  assert.equal(ZE_RESULT_NAME[0x7800002e], 'ERROR_INVALID_OVERCLOCK_POWER');
  assert.equal(ZE_RESULT_NAME[0x7800002f], 'ERROR_INVALID_OVERCLOCK_TEMPERATURE');
});

// ---------------------------------------------------------------------------
// enumerateHandles (two-step count/fill) — fake enumerator, no DLL
// ---------------------------------------------------------------------------

test('enumerateHandles: count query then fill with a fake enumerator', () => {
  const fakeEnum = (countBuf, arrayBuf) => {
    if (arrayBuf === null) {
      koffi.encode(countBuf, 'uint32', 3);
      return 0;
    }
    koffi.encode(countBuf, 'uint32', 3);
    // fake handles: koffi external pointers (koffi decodes 'void*' slots
    // as externals, exactly like the real loader would)
    const handles = [koffi.alloc('uint8', 1), koffi.alloc('uint8', 1), koffi.alloc('uint8', 1)];
    for (let i = 0; i < 3; i++) koffi.encode(arrayBuf, i * 8, 'void*', handles[i]);
    return 0;
  };
  const { result, handles } = enumerateHandles(fakeEnum);
  assert.equal(result, 0);
  assert.equal(handles.length, 3);
  assert.equal(typeof handles[0], 'object'); // external pointer object
  assert.ok(handles[0] !== null);
  assert.ok(handles[2] !== null);
});

test('enumerateHandles: zero-count and error results degrade cleanly', () => {
  const none = (countBuf) => { koffi.encode(countBuf, 'uint32', 0); return 0; };
  assert.deepEqual(enumerateHandles(none), { result: 0, handles: [] });

  const err = (countBuf) => { koffi.encode(countBuf, 'uint32', 0); return 0x78000012; };
  const out = enumerateHandles(err);
  assert.equal(out.result, 0x78000012);
  assert.deepEqual(out.handles, []);
});

// ---------------------------------------------------------------------------
// DLL discovery + binding (environment-dependent — tolerant assertions)
// ---------------------------------------------------------------------------

test('findZeLoaderDll: LZ_LOADER_PATH override wins when it points at a file', () => {
  const fake = path.join(os.tmpdir(), `fake-ze-loader-${Date.now()}.dll`);
  fs.writeFileSync(fake, 'fixture');
  const prev = process.env.LZ_LOADER_PATH;
  try {
    process.env.LZ_LOADER_PATH = fake;
    assert.equal(findZeLoaderDll(), fake);
  } finally {
    if (prev === undefined) delete process.env.LZ_LOADER_PATH;
    else process.env.LZ_LOADER_PATH = prev;
    fs.unlinkSync(fake);
  }
});

test('findZeLoaderDll: returns a path or null without throwing', () => {
  const p = findZeLoaderDll();
  assert.ok(p === null || typeof p === 'string');
});

test('loadSysman: binds symbols and records unavailable ones without throwing', () => {
  const dll = findZeLoaderDll();
  if (!dll) {
    assert.ok(true, 'skipped: no ze_loader.dll on this machine');
    return;
  }
  const lib = loadSysman(dll);
  assert.equal(typeof lib.zeInit, 'function');
  assert.equal(typeof lib.zesInit, 'function');
  assert.equal(typeof lib.zesPowerGetLimits, 'function');
  assert.equal(typeof lib.zesPowerSetLimits, 'function');
  assert.ok(Array.isArray(lib.unavailable));
});
