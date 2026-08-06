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
  PresentMonClient, createPresentmonAdapter, resolveForegroundPid, spawnPresentMonService,
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

// ---------------------------------------------------------------------------
// M3-C-L — foreground-pid resolution + re-trackable client + the adapter's
// foreground tracking (no real service/DLL involved — injected fakes)
// ---------------------------------------------------------------------------

test('M3-C-L: resolveForegroundPid returns the foreground window pid via injected user32', () => {
  // A fake user32 lib: GetForegroundWindow returns a non-null hwnd; the pid
  // is written into the caller's uint32 buffer.
  const pidBufHolder = {};
  const fakeUser32 = {
    func: (sig) => {
      if (sig.includes('GetForegroundWindow')) return () => 0x1a2b3c4d;
      if (sig.includes('GetWindowThreadProcessId')) {
        return (hwnd, out) => {
          koffi.encode(out, 'uint32', 12345);
          return 0xabc;
        };
      }
      throw new Error(`unexpected signature ${sig}`);
    },
  };
  assert.equal(resolveForegroundPid({ lib: fakeUser32 }), 12345);
  void pidBufHolder;
});

test('M3-C-L: resolveForegroundPid returns null with no foreground window or a failing lib', () => {
  const noWindow = { func: (sig) => (sig.includes('GetForegroundWindow') ? () => null : () => { throw new Error('never'); }) };
  assert.equal(resolveForegroundPid({ lib: noWindow }), null);
  const throwing = { func: () => { throw new Error('user32 load failed'); } };
  assert.equal(resolveForegroundPid({ lib: throwing }), null);
});

/** Fake bound lib: records tracking changes, serves one consumed frame. */
function fakeLib() {
  const calls = { start: [], stop: [], consumePids: [] };
  let fps = null;
  return {
    calls,
    setFrame(v) { fps = v; },
    elements: [
      { metric: PM_METRIC.PRESENTED_FPS, stat: 0, deviceId: 0, arrayIndex: 0, dataOffset: 0, dataSize: 8 },
    ],
    pmOpenSession: (out) => { koffi.encode(out, 'void*', 1); return PM_STATUS.SUCCESS; },
    pmCloseSession: () => PM_STATUS.SUCCESS,
    pmStartTrackingProcess: (_s, pid) => { calls.start.push(pid); return PM_STATUS.SUCCESS; },
    pmStopTrackingProcess: (_s, pid) => { calls.stop.push(pid); return PM_STATUS.SUCCESS; },
    pmRegisterFrameQuery: (_s, queryOut, elBuf, n, sizeOut) => {
      // The real service fills each element's dataOffset/dataSize + the blob
      // size at register time — emulate that (blob = 16 bytes per frame).
      for (let i = 0; i < n; i++) {
        const e = koffi.decode(elBuf, i * 32, 'pm_query_element_t');
        koffi.encode(elBuf, i * 32, 'pm_query_element_t', { ...e, dataOffset: i * 8, dataSize: 8 });
      }
      koffi.encode(queryOut, 'void*', 1);
      koffi.encode(sizeOut, 'uint32', 16);
      return PM_STATUS.SUCCESS;
    },
    pmConsumeFrames: (_q, pid, blobBuf, numOut) => {
      calls.consumePids.push(pid);
      if (typeof fps === 'number') {
        koffi.encode(blobBuf, 0, 'double', fps);
        koffi.encode(numOut, 'uint32', 1);
      } else {
        koffi.encode(numOut, 'uint32', 0);
      }
      return PM_STATUS.SUCCESS;
    },
    pmFreeFrameQuery: () => PM_STATUS.SUCCESS,
    pmSetEtwFlushPeriod: () => PM_STATUS.SUCCESS,
    unavailable: [],
  };
}

test('M3-C-L: PresentMonClient.retarget stops the old pid and tracks the new on the SAME session', async () => {
  const lib = fakeLib();
  lib.setFrame(60);
  const client = new PresentMonClient({ dllPath: 'fake', lib });
  const out = await client.start(0, 100);
  assert.equal(out.ok, true);
  assert.deepEqual(lib.calls.start, [100]);

  // Retarget to a new foreground pid.
  const rt = await client.retarget(200);
  assert.equal(rt.ok, true);
  assert.deepEqual(lib.calls.stop, [100], 'the old pid is stopped');
  assert.deepEqual(lib.calls.start, [100, 200], 'the new pid is tracked on the same session');

  // poll() consumes frames for the NEW pid only.
  const sample = await client.poll();
  assert.equal(sample.fps, 60);
  assert.deepEqual(lib.calls.consumePids, [200]);

  // Retarget to the SAME pid is a no-op.
  await client.retarget(200);
  assert.deepEqual(lib.calls.stop, [100], 'no stop for a same-pid retarget');
});

test('M3-C-L: PresentMonClient.retarget fails honestly when not started', async () => {
  const client = new PresentMonClient({ dllPath: null, lib: fakeLib() });
  const out = await client.retarget(200);
  assert.equal(out.ok, false);
  assert.match(out.reason, /not found|not started/);
});

test('M3-C step-5 F2: a failed retarget clears the pid — poll() never consumes frames for the stale pid', async () => {
  const lib = fakeLib();
  lib.pmStartTrackingProcess = (_s, pid) => {
    lib.calls.start.push(pid);
    return pid === 200 ? PM_STATUS.INVALID_PID : PM_STATUS.SUCCESS;
  };
  lib.setFrame(60);
  const client = new PresentMonClient({ dllPath: 'fake', lib });
  await client.start(0, 100);
  assert.deepEqual(lib.calls.start, [100]);

  // The new pid cannot be tracked: the old tracking is stopped, and the
  // client must NOT keep naming the old pid (a stale _pid would make poll()
  // keep consuming frames for a pid the session no longer tracks).
  const rt = await client.retarget(200);
  assert.equal(rt.ok, false);
  assert.equal(client._pid, null, 'a failed retarget must reset the pid, never keep the stale one');
  assert.deepEqual(lib.calls.stop, [100], 'the old tracking is stopped');

  const sample = await client.poll();
  assert.equal(sample, null, 'no pid -> poll returns null');
  assert.deepEqual(lib.calls.consumePids, [], 'the stale pid is NEVER consumed');

  // A later retarget to a live pid starts fresh from the clean state.
  const rt2 = await client.retarget(300);
  assert.equal(rt2.ok, true);
  assert.deepEqual(lib.calls.start, [100, 200, 300], 'the live retarget starts fresh');
  assert.deepEqual(lib.calls.stop, [100], 'a clean-state retarget has no stale pid to stop');
  const s2 = await client.poll();
  assert.equal(s2.fps, 60);
  assert.deepEqual(lib.calls.consumePids, [300]);
});

test('M3-C step-5 F2: after a retarget failure the adapter\'s next poll re-resolves and starts a fresh target', async () => {
  const lib = fakeLib();
  lib.pmStartTrackingProcess = (_s, pid) => {
    lib.calls.start.push(pid);
    return pid === 200 ? PM_STATUS.INVALID_PID : PM_STATUS.SUCCESS;
  };
  lib.setFrame(60);
  let fgPid = 100;
  const client = new PresentMonClient({ dllPath: 'fake', lib });
  const adapter = createPresentmonAdapter({
    client,
    resolvePid: () => fgPid,
    spawnService: () => ({ child: null, reason: 'test' }),
    log: () => {},
  });
  let s = await adapter.poll(0);
  assert.equal(s.fps, 60);
  assert.deepEqual(lib.calls.start, [100]);

  // Focus moves to a pid that cannot be tracked: the retarget fails and the
  // client's pid is cleared (the fix) — the old tracking is gone.
  fgPid = 200;
  s = await adapter.poll(0);
  assert.equal(s, null, 'a failed retarget returns null');
  assert.equal(client._pid, null, 'the failed retarget left the client pid-less');
  assert.deepEqual(lib.calls.start, [100, 200], 'the dead pid was attempted');

  // A NEW live foreground appears: the next poll re-resolves and retargets
  // from the clean state — never the stale pid.
  fgPid = 300;
  s = await adapter.poll(0);
  assert.equal(s.fps, 60, 'the next poll recovers against the fresh target');
  assert.deepEqual(lib.calls.start, [100, 200, 300]);
  assert.deepEqual(lib.calls.stop, [100], 'the fresh retarget stops no stale pid');
  assert.deepEqual(lib.calls.consumePids, [100, 300]);
});

test('M3-C-L: the adapter tracks the FOREGROUND pid and re-tracks on focus change', async () => {
  const lib = fakeLib();
  let fgPid = 4242;
  const client = new PresentMonClient({ dllPath: 'fake', lib });
  const adapter = createPresentmonAdapter({
    client,
    resolvePid: () => fgPid,
    spawnService: () => ({ child: null, reason: 'test' }), // never spawns anything
    log: () => {},
  });
  lib.setFrame(144);
  let s = await adapter.poll(0);
  assert.equal(s.fps, 144, 'the first poll tracks the foreground pid');
  assert.deepEqual(lib.calls.start, [4242], 'the initial target is the foreground pid, NOT the app pid');

  // The app itself becomes the foreground: tracking moves back to the own
  // pid (never reports the app's own frames as "FPS").
  fgPid = process.pid;
  s = await adapter.poll(0);
  assert.deepEqual(lib.calls.stop, [4242]);
  assert.deepEqual(lib.calls.start, [4242, process.pid]);

  // A new game comes to the foreground: re-track.
  fgPid = 777;
  await adapter.poll(0);
  assert.deepEqual(lib.calls.stop, [4242, process.pid]);
  assert.deepEqual(lib.calls.start, [4242, process.pid, 777]);

  // The desktop is focused (null): back to the own pid — stale frames from
  // the backgrounded game are never reported.
  fgPid = null;
  lib.setFrame(null);
  await adapter.poll(0);
  assert.deepEqual(lib.calls.stop, [4242, process.pid, 777]);
  assert.deepEqual(lib.calls.start, [4242, process.pid, 777, process.pid]);
});

test('M3-C-L: a failed client start leaves the adapter unavailable (never throws)', async () => {
  const client = new PresentMonClient({ dllPath: null, lib: fakeLib() });
  // Force the client to be unavailable (no DLL path).
  const adapter = createPresentmonAdapter({
    client,
    resolvePid: () => 1,
    spawnService: () => ({ child: null, reason: 'test' }),
    log: () => {},
  });
  const s = await adapter.poll(0);
  assert.equal(s, null);
  // stop() is safe on a failed adapter.
  await adapter.stop();
});

test('M3-C-L: adapter stop kills the spawned service child and resets the latch', async () => {
  const lib = fakeLib();
  let killed = 0;
  let made = 0;
  const adapter = createPresentmonAdapter({
    createClient: () => { made += 1; return new PresentMonClient({ dllPath: 'fake', lib }); },
    resolvePid: () => 4242,
    spawnService: () => ({ child: { kill: () => { killed += 1; } } }),
    log: () => {},
  });
  lib.setFrame(60);
  await adapter.poll(0);
  assert.equal(made, 1);
  await adapter.stop();
  assert.equal(killed, 1, 'the spawned service is killed on stop');
  // The latch reset: a fresh poll creates a fresh client and starts again.
  await adapter.poll(0);
  assert.equal(made, 2, 'the adapter restarts after stop');
});

// ---------------------------------------------------------------------------
// M3-C-L F1 (review): PresentMon readiness — pmOpenSession retry with
// backoff + drained service stdio. The feasibility probe needed ~2500 ms
// before the session opened; a transient first-poll failure must never
// permanently kill FPS for the session.
// ---------------------------------------------------------------------------

test('M3-C-L F1: spawnPresentMonService uses DRAINED stdio (never a blocking pipe)', () => {
  // The service runs with --enable-stdio-log; a pipe nobody reads fills its
  // 64 KB buffer and blocks the service. The spawn opts must use 'ignore'.
  let captured = null;
  const out = spawnPresentMonService({
    serviceExe: 'C:\\fake\\PresentMonService.exe',
    spawn: (_exe, _args, opts) => { captured = opts; return { on: () => {} }; },
  });
  assert.ok(out.child, 'the fake child is returned');
  assert.equal(captured.stdio, 'ignore', 'stdio must be ignored/drained, not a pipe');
  assert.equal(captured.windowsHide, true);
});

test('M3-C-L F1: pmOpenSession is retried with backoff before declaring the client unavailable', async () => {
  const lib = fakeLib();
  let opens = 0;
  lib.pmOpenSession = (out) => {
    opens += 1;
    if (opens < 3) return PM_STATUS.SERVICE_ERROR; // transient: service still coming up
    koffi.encode(out, 'void*', 1);
    return PM_STATUS.SUCCESS;
  };
  lib.setFrame(60);
  const client = new PresentMonClient({
    dllPath: 'fake', lib,
    openAttempts: 8, openRetryMs: 0, sleep: async () => {},
  });
  const out = await client.start(0, 100);
  assert.equal(out.ok, true, 'the transient first failures must not fail the start');
  assert.equal(opens, 3, 'pmOpenSession ran the retry loop');
  assert.equal(client.available, true, 'a recovered session keeps the client available');
  const sample = await client.poll();
  assert.equal(sample.fps, 60);
});

test('M3-C-L F1: only after ALL open attempts fail is the client declared unavailable', async () => {
  const lib = fakeLib();
  let opens = 0;
  lib.pmOpenSession = () => { opens += 1; return PM_STATUS.SERVICE_ERROR; };
  const client = new PresentMonClient({
    dllPath: 'fake', lib,
    openAttempts: 3, openRetryMs: 0, sleep: async () => {},
  });
  const out = await client.start(0, 100);
  assert.equal(out.ok, false);
  assert.equal(opens, 3, 'every attempt ran');
  assert.equal(client.available, false, 'declared unavailable only after the retries');
  assert.match(client.availableReason, /3 attempts/);
});

test('M3-C-L F1: the adapter retries a TRANSIENT first-poll start failure and never latches off', async () => {
  const fakeClient = {
    available: true,
    startCalls: 0,
    async start() {
      this.startCalls += 1;
      // The service is still coming up: the first two starts fail, the
      // third succeeds — a transient first failure.
      if (this.startCalls <= 2) return { ok: false, reason: 'service not ready yet' };
      return { ok: true };
    },
    async poll() { return { fps: 60, frameTimeMs: 16.6, gpuBusy: 0.5 }; },
    async retarget() { return { ok: true }; },
    async stop() {},
  };
  const adapter = createPresentmonAdapter({
    client: fakeClient,
    resolvePid: () => 4242,
    spawnService: () => ({ child: null, reason: 'test' }),
    startAttempts: 5, startRetryMs: 0, sleep: async () => {},
    log: () => {},
  });
  const s = await adapter.poll(0);
  assert.equal(s.fps, 60, 'a transient first failure must eventually return a sample');
  assert.equal(fakeClient.startCalls, 3, 'the start was retried until it succeeded');
  // Never permanently latched off: later polls still return samples.
  const s2 = await adapter.poll(0);
  assert.equal(s2.fps, 60);
  assert.equal(fakeClient.startCalls, 3, 'no re-start after the latch succeeded');
});

test('M3-C-L F1: a PERMANENTLY unavailable client is not retried (no wasted backoff)', async () => {
  const fakeClient = {
    available: false, // missing DLL / exhausted open-session retries — permanent
    startCalls: 0,
    async start() {
      this.startCalls += 1;
      return { ok: false, reason: 'PresentMonAPI2.dll not found' };
    },
    async poll() { return null; },
    async retarget() { return { ok: false, reason: 'not started' }; },
    async stop() {},
  };
  const adapter = createPresentmonAdapter({
    client: fakeClient,
    resolvePid: () => 4242,
    spawnService: () => ({ child: null, reason: 'test' }),
    startAttempts: 5, startRetryMs: 0, sleep: async () => {},
    log: () => {},
  });
  const s = await adapter.poll(0);
  assert.equal(s, null);
  assert.equal(fakeClient.startCalls, 1, 'a permanently-unavailable client is tried exactly once');
});

// ---------------------------------------------------------------------------
// M3-C-L F1 (round 2): dead-pid start-loop exhaustion must not latch FPS
// off. A pmStartTrackingProcess -> INVALID_PID failure leaves the client
// `available` TRUE (only the session is dropped), so the outer loop used to
// burn every attempt on the SAME stale pid and then keep the client with
// the start latch set — every later poll skipped the start block and
// returned null: FPS dead for the session.
// ---------------------------------------------------------------------------

test('M3-C-L F1 (round 2): the foreground pid is RE-RESOLVED on every start attempt (focus change mid-loop recovers)', async () => {
  const lib = fakeLib();
  const DEAD = 1111;
  lib.pmStartTrackingProcess = (_s, pid) => {
    lib.calls.start.push(pid);
    return pid === DEAD ? PM_STATUS.INVALID_PID : PM_STATUS.SUCCESS;
  };
  lib.setFrame(75);
  // The pid resolved at loop entry (DEAD) exits between resolvePid() and
  // pmStartTrackingProcess; a focus change brings up a live pid (2222) for
  // the second attempt.
  let resolves = 0;
  const adapter = createPresentmonAdapter({
    client: new PresentMonClient({ dllPath: 'fake', lib }),
    resolvePid: () => { resolves += 1; return resolves === 1 ? DEAD : 2222; },
    spawnService: () => ({ child: null, reason: 'test' }),
    startAttempts: 3, startRetryMs: 0, sleep: async () => {},
    log: () => {},
  });
  const s = await adapter.poll(0);
  assert.equal(s.fps, 75, 'the focus change inside the retry loop must recover the start');
  assert.deepEqual(lib.calls.start, [DEAD, 2222], 'each attempt re-resolved the foreground pid (never the stale dead pid twice)');
});

test('M3-C-L F1 (round 2): exhausted start attempts with the client still available reset the latch and recover on the next poll', async () => {
  const lib = fakeLib();
  const DEAD = 3333;
  lib.pmStartTrackingProcess = (_s, pid) => {
    lib.calls.start.push(pid);
    return pid === DEAD ? PM_STATUS.INVALID_PID : PM_STATUS.SUCCESS;
  };
  lib.setFrame(90);
  let made = 0;
  let dead = true;
  const adapter = createPresentmonAdapter({
    createClient: () => { made += 1; return new PresentMonClient({ dllPath: 'fake', lib }); },
    resolvePid: () => (dead ? DEAD : 4444),
    spawnService: () => ({ child: null, reason: 'test' }),
    startAttempts: 2, startRetryMs: 0, sleep: async () => {},
    log: () => {},
  });
  // Every attempt races the same dead pid: the loop exhausts with
  // `available` still true — before the fix the latch stayed set and FPS
  // was dead for the rest of the session.
  const s1 = await adapter.poll(0);
  assert.equal(s1, null, 'the exhausted start returns null');
  assert.deepEqual(lib.calls.start, [DEAD, DEAD], 'both attempts hit the dead pid');
  // A focus change brings up a live pid: the next poll must RE-ENTER the
  // start block (fresh client, fresh pid) instead of returning null forever.
  dead = false;
  const s2 = await adapter.poll(0);
  assert.equal(s2.fps, 90, 'the next poll re-enters the start block against the fresh pid');
  assert.equal(made, 2, 'the exhausted start dropped the client; the next poll created a fresh one');
  assert.deepEqual(lib.calls.start, [DEAD, DEAD, 4444], 'the fresh client tracked the live pid');
});
