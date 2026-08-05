// M2b checkpoint 2 — PresentMonClient fixture tests. Pure decode pinned
// against the presentmonapi2.h v2.5.1 blob layout: a frame query element
// array (offsets filled by the service at register time) plus a real-looking
// blob of doubles -> the Monitoring sample. No DLL needed for these tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PM_STATUS, PM_STATUS_NAME, PM_METRIC, PM_UNIVERSAL_DEVICE_ID,
  decodeFrameSample, findPresentMonDll, loadPresentMon, describePmStatus,
} from '../src/main/presentmon/presentmon-client.js';

// ---------------------------------------------------------------------------
// Struct layout (pinned from presentmonapi2.h v2.5.1, MSVC x64)
// ---------------------------------------------------------------------------

test('layout: pm_query_element_t is 32 bytes with the C field offsets', () => {
  assert.equal(koffi.sizeof('pm_query_element_t'), 32);
  assert.equal(koffi.offsetof('pm_query_element_t', 'metric'), 0);
  assert.equal(koffi.offsetof('pm_query_element_t', 'stat'), 4);
  assert.equal(koffi.offsetof('pm_query_element_t', 'deviceId'), 8);
  assert.equal(koffi.offsetof('pm_query_element_t', 'arrayIndex'), 12);
  assert.equal(koffi.offsetof('pm_query_element_t', 'dataOffset'), 16);
  assert.equal(koffi.offsetof('pm_query_element_t', 'dataSize'), 24);
});

test('layout: pm_version_t is 40 bytes', () => {
  assert.equal(koffi.sizeof('pm_version_t'), 40);
});

test('layout: query elements round-trip through the koffi struct', () => {
  const buf = koffi.alloc('pm_query_element_t', 2);
  const elements = [
    { metric: PM_METRIC.DISPLAYED_FPS, stat: 0, deviceId: PM_UNIVERSAL_DEVICE_ID, arrayIndex: 0, dataOffset: 0, dataSize: 0 },
    { metric: PM_METRIC.GPU_BUSY, stat: 0, deviceId: PM_UNIVERSAL_DEVICE_ID, arrayIndex: 0, dataOffset: 8, dataSize: 8 },
  ];
  for (let i = 0; i < elements.length; i++) {
    koffi.encode(buf, i * 32, 'pm_query_element_t', elements[i]);
  }
  const out = koffi.decode(buf, 0, 'pm_query_element_t');
  assert.equal(out.metric, PM_METRIC.DISPLAYED_FPS);
  assert.equal(out.deviceId, PM_UNIVERSAL_DEVICE_ID);
  const second = koffi.decode(buf, 32, 'pm_query_element_t');
  assert.equal(second.metric, PM_METRIC.GPU_BUSY);
  assert.equal(second.dataOffset, 8);
  assert.equal(second.dataSize, 8);
});

// ---------------------------------------------------------------------------
// Frame blob decode (the PresentMon equivalent of PM_FRAME_EVENT parsing)
// ---------------------------------------------------------------------------

// Service-style layout: each element is 8-byte aligned, blob padded to 16.
// DISPLAYED_FPS @0, DISPLAYED_FRAME_TIME @8, PRESENTED_FPS @16, GPU_BUSY @24.
function makeServiceElements() {
  return [
    { metric: PM_METRIC.DISPLAYED_FPS, stat: 0, deviceId: 0, arrayIndex: 0, dataOffset: 0, dataSize: 8 },
    { metric: PM_METRIC.DISPLAYED_FRAME_TIME, stat: 0, deviceId: 0, arrayIndex: 0, dataOffset: 8, dataSize: 8 },
    { metric: PM_METRIC.PRESENTED_FPS, stat: 0, deviceId: 0, arrayIndex: 0, dataOffset: 16, dataSize: 8 },
    { metric: PM_METRIC.GPU_BUSY, stat: 0, deviceId: 0, arrayIndex: 0, dataOffset: 24, dataSize: 8 },
  ];
}

function encodeBlob(values, blobSize = 32) {
  const buf = Buffer.alloc(blobSize);
  buf.writeDoubleLE(values.fps, 0);
  buf.writeDoubleLE(values.frameTimeMs, 8);
  buf.writeDoubleLE(values.presentedFps, 16);
  buf.writeDoubleLE(values.gpuBusy, 24);
  return buf;
}

test('decodeFrameSample: 60 fps game-like frame (16.6 ms, 80% GPU busy)', () => {
  const elements = makeServiceElements();
  const blob = encodeBlob({ fps: 60.0, frameTimeMs: 16.666, presentedFps: 60.0, gpuBusy: 0.8 });
  const s = decodeFrameSample(blob, elements);
  assert.equal(s.fps, 60.0);
  assert.ok(Math.abs(s.frameTimeMs - 16.666) < 1e-9);
  assert.equal(s.presentedFps, 60.0);
  assert.equal(s.gpuBusy, 0.8);
});

test('decodeFrameSample: uncapped (vsync off) frame ~240 fps', () => {
  const elements = makeServiceElements();
  const blob = encodeBlob({ fps: 240.0, frameTimeMs: 4.16, presentedFps: 240.0, gpuBusy: 0.35 });
  const s = decodeFrameSample(blob, elements);
  assert.equal(s.fps, 240.0);
  assert.ok(Math.abs(s.frameTimeMs - 4.16) < 1e-9);
  assert.equal(s.gpuBusy, 0.35);
});

test('decodeFrameSample: frame with no display (displayed metrics null, fps falls back to presented)', () => {
  // Service writes NaN for unavailable metrics (the C++ side writes the
  // unset double value); the decoder must null them, not pass NaN through.
  // fps falls back to PRESENTED_FPS (the DISPLAYED_* path on this driver).
  const elements = makeServiceElements();
  const blob = encodeBlob({ fps: NaN, frameTimeMs: NaN, presentedFps: 120.5, gpuBusy: 0.1 });
  const s = decodeFrameSample(blob, elements);
  assert.equal(s.fps, 120.5);
  assert.equal(s.frameTimeMs, null);
  assert.equal(s.presentedFps, 120.5);
  assert.equal(s.gpuBusy, 0.1);
});

test('decodeFrameSample: minimal presented-only query (fallback path)', () => {
  const elements = [
    { metric: PM_METRIC.PRESENTED_FPS, stat: 0, deviceId: 0, arrayIndex: 0, dataOffset: 0, dataSize: 8 },
    { metric: PM_METRIC.PRESENTED_FRAME_TIME, stat: 0, deviceId: 0, arrayIndex: 0, dataOffset: 8, dataSize: 8 },
  ];
  const buf = Buffer.alloc(32);
  buf.writeDoubleLE(90.0, 0);
  buf.writeDoubleLE(11.11, 8);
  const s = decodeFrameSample(buf, elements);
  // fps falls back to PRESENTED_FPS when DISPLAYED_FPS is absent (the
  // DISPLAYED_* metrics are not exported on this A770/driver)
  assert.equal(s.fps, 90.0);
  assert.equal(s.presentedFps, 90.0);
  assert.ok(Math.abs(s.frameTimeMs - 11.11) < 1e-9);
  assert.equal(s.gpuBusy, null);
});

test('decodeFrameSample: missing elements decode as null (graceful)', () => {
  const s = decodeFrameSample(Buffer.alloc(8), []);
  assert.equal(s.fps, null);
  assert.equal(s.frameTimeMs, null);
  assert.equal(s.gpuBusy, null);
  assert.equal(s.presentedFps, null);
});

// ---------------------------------------------------------------------------
// Enums / status naming
// ---------------------------------------------------------------------------

test('PM_STATUS enum values match presentmonapi2.h v2.5.1', () => {
  assert.equal(PM_STATUS.SUCCESS, 0);
  assert.equal(PM_STATUS.SERVICE_ERROR, 4);
  assert.equal(PM_STATUS.INVALID_PID, 6);
  assert.equal(PM_STATUS.ALREADY_TRACKING_PROCESS, 7);
  assert.equal(PM_STATUS.QUERY_MALFORMED, 21);
  assert.equal(PM_STATUS.FEATURE_DISABLED, 23);
  assert.equal(PM_STATUS_NAME[4], 'SERVICE_ERROR');
});

test('PM_METRIC values match the header (frame metrics used by the client)', () => {
  assert.equal(PM_METRIC.DISPLAYED_FPS, 12);
  assert.equal(PM_METRIC.PRESENTED_FPS, 13);
  assert.equal(PM_METRIC.GPU_BUSY, 15);
  assert.equal(PM_METRIC.DISPLAYED_FRAME_TIME, 137);
  assert.equal(PM_METRIC.PRESENTED_FRAME_TIME, 139);
});

test('describePmStatus names known codes and hexes unknown ones', () => {
  assert.equal(describePmStatus(0), 'SUCCESS (0)');
  assert.equal(describePmStatus(6), 'INVALID_PID (6)');
  assert.match(describePmStatus(999), /UNKNOWN/);
});

// ---------------------------------------------------------------------------
// DLL discovery + binding (environment-dependent — tolerant assertions)
// ---------------------------------------------------------------------------

test('findPresentMonDll: PM_API2_DLL_PATH override wins when it points at a file', () => {
  const someFile = fileURLToPath(import.meta.url);
  const prev = process.env.PM_API2_DLL_PATH;
  try {
    process.env.PM_API2_DLL_PATH = someFile;
    assert.equal(findPresentMonDll(), someFile);
  } finally {
    if (prev === undefined) delete process.env.PM_API2_DLL_PATH;
    else process.env.PM_API2_DLL_PATH = prev;
  }
});

test('findPresentMonDll: returns the vendored path or null without throwing', () => {
  const p = findPresentMonDll();
  assert.ok(p === null || /PresentMonAPI2\.dll$/i.test(p));
});

test('loadPresentMon: binds the session-API symbols (skips when the DLL is absent)', () => {
  const dll = findPresentMonDll();
  if (!dll || !fs.existsSync(dll)) {
    assert.ok(true, 'skipped: vendored PresentMonAPI2.dll not present (gitignored binary)');
    return;
  }
  const lib = loadPresentMon(dll);
  assert.equal(typeof lib.pmOpenSession, 'function');
  assert.equal(typeof lib.pmCloseSession, 'function');
  assert.equal(typeof lib.pmStartTrackingProcess, 'function');
  assert.equal(typeof lib.pmRegisterFrameQuery, 'function');
  assert.equal(typeof lib.pmConsumeFrames, 'function');
  assert.equal(typeof lib.pmFreeFrameQuery, 'function');
  assert.ok(Array.isArray(lib.unavailable));
});
