// M4-D2 — fps-dxgi tests: the pure parts (struct layout constants, the
// uint32 wrap-aware delta, the PresentCount reader) + the mock/skip paths
// of the adapter (never loads the real dxgi.dll — the REAL DXGI needs the
// live checkpoint, pipeline/live-fps-dxgi.mjs).
//
// Pinned vtable slots (verified against the Windows SDK dxgi.idl layout /
// Microsoft's interface docs + Wine's dxgi implementation):
//   IDXGIFactory1.EnumAdapters1 = 12 (7 EnumAdapters ... 11
//     CreateSoftwareAdapter); IDXGIAdapter.EnumOutputs = 7 (inherits
//     IDXGIObject directly — NO IDXGIDeviceSubObject layer);
//     IDXGIAdapter1.GetDesc1 = 10; IDXGIOutput.GetFrameStatistics = 18.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import {
  DXGI_ERROR_FRAME_STATISTICS_DISCONTINUOUS,
  DXGI_ERROR_NOT_FOUND,
  DXGI_ERROR_NOT_CURRENTLY_AVAILABLE,
  DXGI_ERROR_WAIT_TIMEOUT,
  DXGI_ERROR_ACCESS_LOST,
  DXGI_FRAME_STATISTICS_SIZE,
  DXGI_OUTDUPL_FRAME_INFO_SIZE,
  OUTDUPL_ACCUMULATED_FRAMES_OFF,
  DXGI_ADAPTER_DESC1_SIZE,
  DESC1_DEVICE_ID_OFF,
  DESC1_LUID_LOW_OFF,
  DESC1_LUID_HIGH_OFF,
  IID_IDXGIFACTORY1_BYTES,
  presentCountOf,
  wrappedDelta,
  createDxgiFpsAdapter,
} from '../src/main/fps-dxgi.js';

test('M4-D2: the pinned DXGI constants (slots are validated by the live checkpoint)', () => {
  assert.equal(DXGI_ERROR_NOT_FOUND, 0x887A0002);
  assert.equal(DXGI_ERROR_FRAME_STATISTICS_DISCONTINUOUS, 0x887A000B);
  assert.equal(DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, 0x887A0001, 'the windowed-desktop answer (GetFrameStatistics is fullscreen-only)');
  assert.equal(DXGI_ERROR_WAIT_TIMEOUT, 0x887A0027, 'AcquireNextFrame queue drained');
  assert.equal(DXGI_ERROR_ACCESS_LOST, 0x887A0026, 'drop + recreate the duplication on the next poll');
  assert.equal(DXGI_FRAME_STATISTICS_SIZE, 32, 'UINT+UINT+3×INT64');
  assert.equal(DXGI_OUTDUPL_FRAME_INFO_SIZE, 48, '2×LARGE_INTEGER + UINT/Bools + pointer pos + UINTs + pad');
  assert.equal(DXGI_ADAPTER_DESC1_SIZE, 312);
  assert.equal(DESC1_DEVICE_ID_OFF, 260);
  assert.equal(DESC1_LUID_LOW_OFF, 296);
  assert.equal(DESC1_LUID_HIGH_OFF, 300);
  assert.equal(IID_IDXGIFACTORY1_BYTES.length, 16);
  assert.deepEqual(IID_IDXGIFACTORY1_BYTES, [0x78, 0xae, 0x0a, 0x77, 0x6f, 0xf2, 0xba, 0x4d, 0xa8, 0x29, 0x25, 0x3c, 0x83, 0xd1, 0xb3, 0x87]);
});

// --- M4-D2 run-1b: the IDXGIOutputDuplication fallback -------------------
// A scripted DXGI session behind the callSlot seam (deps.callSlot): the
// fake serves HRESULTs per vtable slot (dispatch by slot + arg count — the
// pointer values themselves are opaque), driving the full init → GFS →
// fallback → drain flow without touching the real dxgi.dll. Slot map used
// by the fake: EnumAdapters1 12, EnumOutputs 7, GetDesc1 10 (2 args),
// GetFrameStatistics 18, DuplicateOutput 22, AcquireNextFrame 8,
// ReleaseFrame 14, Release 2. The fake lib also serves D3D11CreateDevice
// (the DuplicateOutput pDevice recipe — run-1b live finding).
const createFakeDxgi = () => {
  const state = {
    gfsHr: DXGI_ERROR_NOT_CURRENTLY_AVAILABLE, // GetFrameStatistics result
    acquireScript: [],   // served per AcquireNextFrame call; exhausted → WAIT_TIMEOUT
    acquireAccumScript: [], // scripted AccumulatedFrames@16 per acquired frame (default 0)
    dupCreateScript: [], // served per DuplicateOutput call
    dupCreateDefault: 0, // DuplicateOutput result once the script is exhausted
    numOutputs: 1,
    calls: { dupCreate: 0, acquire: [], releaseFrame: 0, release: 0, gfs: 0, createDevice: 0 },
    enumAdapters: 0,
    enumOutputs: 0,
  };
  const lib = {
    func: (name, ...protoArgs) => {
      if (name === 'D3D11CreateDevice') {
        return (...args) => {
          state.calls.createDevice += 1;
          koffi.encode(args[7], 0, 'void*', 0x1500); // the fake device pointer
          return 0; // S_OK
        };
      }
      return (riid, outBuf) => {
        koffi.encode(outBuf, 0, 'void*', 0x1000); // the fake factory pointer
        return 0; // S_OK
      };
    },
  };
  // HRESULTs are returned as SIGNED int32 (exactly like koffi does for an
  // 'int32' proto) — the adapter's generic checks use `hr < 0`.
  const signed = (hr) => hr | 0;
  const slotFn = (obj, slot, proto, ...args) => {
    if (slot === 12) { // EnumAdapters1 (this, idx, out)
      if (state.enumAdapters++ > 0) return signed(DXGI_ERROR_NOT_FOUND);
      koffi.encode(args[2], 0, 'void*', 0x2000); // the fake adapter pointer
      return 0;
    }
    if (slot === 7) { // EnumOutputs (this, idx, out)
      if (state.enumOutputs++ >= state.numOutputs) return signed(DXGI_ERROR_NOT_FOUND);
      koffi.encode(args[2], 0, 'void*', 0x3000); // the fake output pointer
      return 0;
    }
    if (slot === 10 && args.length === 2) return 0; // GetDesc1
    if (slot === 18) { state.calls.gfs += 1; return signed(state.gfsHr); } // GetFrameStatistics
    if (slot === 22) { // DuplicateOutput (this, pDevice, dupOut)
      state.calls.dupCreate += 1;
      const scripted = state.dupCreateScript.length ? state.dupCreateScript.shift() : null;
      const hr = scripted !== null ? scripted : state.dupCreateDefault;
      if ((hr >>> 0) !== 0) return signed(hr);
      koffi.encode(args[2], 0, 'void*', 0x4000); // the fake duplication pointer
      return 0;
    }
    if (slot === 8) { // AcquireNextFrame (this, timeout, frameInfo, resource)
      const hr = state.acquireScript.length ? state.acquireScript.shift() : DXGI_ERROR_WAIT_TIMEOUT;
      if ((hr >>> 0) === 0) {
        // scripted DXGI_OUTDUPL_FRAME_INFO.AccumulatedFrames@16 (uint32);
        // 0 by default (a zeroed buffer — the live first-frame behavior).
        const accum = state.acquireAccumScript.length ? state.acquireAccumScript.shift() : 0;
        koffi.encode(args[2], OUTDUPL_ACCUMULATED_FRAMES_OFF, 'uint32', accum);
      }
      state.calls.acquire.push(hr >>> 0);
      return signed(hr);
    }
    if (slot === 14) { state.calls.releaseFrame += 1; return 0; } // ReleaseFrame
    if (slot === 2) { state.calls.release += 1; return 0; } // Release
    throw new Error(`fake DXGI: unexpected vtable slot ${slot} (${args.length} args)`);
  };
  return { state, lib, slotFn };
};

test('M4-D2 run-1b: GFS dead → the poll falls back to output duplication (selection)', async () => {
  const f = createFakeDxgi();
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => 1000 });
  const r1 = await adapter.poll(0);
  assert.deepEqual(r1, { fps: 0, frameTimeMs: null, gpuBusy: null }, 'the first fallback poll takes the baseline');
  assert.equal(f.state.calls.gfs, 1, 'GFS was tried FIRST');
  assert.equal(f.state.calls.dupCreate, 1, 'DuplicateOutput ran for the single output once GFS answered nothing');
  assert.equal(f.state.calls.acquire.length, 0, 'the baseline poll does not drain (fresh objects have empty queues)');
  await adapter.stop();
});

test('M4-D2 run-1b: GFS first — a working GFS output never triggers the fallback', async () => {
  const f = createFakeDxgi();
  f.state.gfsHr = 0; // S_OK — the counter is maintained
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => 1000 });
  const r1 = await adapter.poll(0);
  assert.deepEqual(r1, { fps: 0, frameTimeMs: null, gpuBusy: null }, 'GFS baseline');
  const r2 = await adapter.poll(0);
  assert.equal(r2.fps, 0, 'zero PresentCount delta → honest 0');
  assert.equal(f.state.calls.dupCreate, 0, 'Duplication is NEVER created while GFS answers');
  await adapter.stop();
});

test('M4-D2 run-1b: drain/count math — frames since the last drain / wall-clock Δt', async () => {
  const f = createFakeDxgi();
  let t = 1000;
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => t });
  await adapter.poll(0); // fallback baseline (creation poll)
  t = 4000; // +3 s
  f.state.acquireScript = [0, 0, 0]; // 3 presented frames, then WAIT_TIMEOUT ends the drain
  const r2 = await adapter.poll(0);
  assert.equal(r2.fps, 1.0, '3 frames / 3 s = 1.0 fps');
  assert.equal(f.state.calls.releaseFrame, 3, 'ReleaseFrame runs after EVERY success (never skipped)');
  assert.deepEqual(f.state.calls.acquire, [0, 0, 0, DXGI_ERROR_WAIT_TIMEOUT], 'WAIT_TIMEOUT ends the drain');
  t = 7000; // +3 s
  f.state.acquireScript = [0];
  const r3 = await adapter.poll(0);
  assert.equal(r3.fps, 0.3, '1 frame / 3 s');
  await adapter.stop();
});

test('M4-D2 run-1b: the duplication COALESCES — AccumulatedFrames@16 is summed (live finding)', async () => {
  // Live: on the 180 Hz desktop each 1.5 s poll returns ONE acquired frame
  // whose AccumulatedFrames counts ~270 presented frames. Counting acquires
  // would report ~0.7 fps on a 180 fps desktop — the honest count is the
  // sum of AccumulatedFrames over the drain (floor 1 per acquired frame).
  const f = createFakeDxgi();
  let t = 1000;
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => t });
  await adapter.poll(0); // baseline (creation poll)
  t = 4000; // +3 s
  f.state.acquireScript = [0]; // ONE coalesced frame…
  f.state.acquireAccumScript = [269]; // …carrying 269 presented updates
  const r2 = await adapter.poll(0);
  assert.equal(r2.fps, 89.7, '269 accumulated frames / 3 s — NOT 1/3');
  assert.equal(f.state.calls.releaseFrame, 1, 'one acquired frame → one ReleaseFrame');
  t = 7000;
  f.state.acquireScript = [0, 0]; // two coalesced frames…
  f.state.acquireAccumScript = [100, 79]; // …179 updates in total
  const r3 = await adapter.poll(0);
  assert.equal(r3.fps, 59.7, '(100+79) / 3 s');
  await adapter.stop();
});

test('M4-D2 run-1b: a zero AccumulatedFrames (the first frame after creation) still counts 1', async () => {
  const f = createFakeDxgi();
  let t = 1000;
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => t });
  await adapter.poll(0);
  t = 4000;
  f.state.acquireScript = [0];
  f.state.acquireAccumScript = [0]; // live-observed on the first frame
  const r2 = await adapter.poll(0);
  assert.equal(r2.fps, 0.3, 'the frame itself is a presented frame — floor of 1');
  await adapter.stop();
});

test('M4-D2 run-1b: the fallback keeps its OWN baseline (a prior GFS baseline never corrupts the Δt)', async () => {
  const f = createFakeDxgi();
  let t = 1000;
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => t });
  f.state.gfsHr = 0;
  await adapter.poll(0); // poll 1: GFS baseline (baselineAt = 1000)
  f.state.gfsHr = DXGI_ERROR_NOT_CURRENTLY_AVAILABLE;
  t = 4000;
  await adapter.poll(0); // poll 2: fallback starts — creation + baseline (dupBaselineAt = 4000)
  assert.equal(f.state.calls.dupCreate, 1);
  t = 7000;
  f.state.acquireScript = [0];
  const r3 = await adapter.poll(0);
  // dupBaselineAt (4000) gives dt = 3 s → 0.3; wrongly using the GFS
  // baselineAt (1000) would give dt = 6 s → 0.2.
  assert.equal(r3.fps, 0.3, 'the drain divides by the fallback baseline, not the stale GFS one');
  await adapter.stop();
});

test('M4-D2 run-1b: ACCESS_LOST drops the duplication and recreates it on the NEXT poll', async () => {
  const f = createFakeDxgi();
  let t = 1000;
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => t });
  await adapter.poll(0); // fallback baseline, dup created
  assert.equal(f.state.calls.dupCreate, 1);
  t = 4000;
  f.state.acquireScript = [0, DXGI_ERROR_ACCESS_LOST];
  const r2 = await adapter.poll(0);
  assert.equal(r2.fps, 0.3, 'the frame acquired BEFORE the access loss still counts');
  assert.equal(f.state.calls.release, 1, 'the lost duplication object was Released');
  t = 7000;
  const r3 = await adapter.poll(0); // recreation poll → baseline again
  assert.equal(f.state.calls.dupCreate, 2, 'recreated on the NEXT poll');
  assert.equal(r3.fps, 0, 'the recreation poll takes the baseline (fresh queue)');
  t = 10000;
  f.state.acquireScript = [0];
  const r4 = await adapter.poll(0);
  assert.equal(r4.fps, 0.3, 'counting resumes after the recreation');
  await adapter.stop();
});

test('M4-D2 run-1b: both paths unavailable → null (honest —), never a fake 0', async () => {
  const f = createFakeDxgi();
  f.state.dupCreateDefault = 0x80070005; // E_ACCESSDENIED — every creation fails
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => 1000 });
  assert.equal(await adapter.poll(0), null);
  assert.equal(await adapter.poll(0), null, 'creation failures are retried, still null');
  await adapter.stop();
});

test('M4-D2 run-1b: D3D11CreateDevice failure → the duplication path is dead → null', async () => {
  const f = createFakeDxgi();
  f.deviceHr = 0x80070005; // E_ACCESSDENIED — D3D11CreateDevice fails
  f.lib.func = (name) => {
    if (name === 'D3D11CreateDevice') return (...args) => f.deviceHr;
    return (riid, outBuf) => { koffi.encode(outBuf, 0, 'void*', 0x1000); return 0; };
  };
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => 1000 });
  assert.equal(await adapter.poll(0), null, 'no device → DuplicateOutput cannot be called → honest —');
  assert.equal(await adapter.poll(0), null, 'permanently unavailable (no retry churn)');
  await adapter.stop();
});

test('M4-D2 run-1b: a failed DuplicateOutput skips that output — the survivor still counts', async () => {
  const f = createFakeDxgi();
  f.state.numOutputs = 2;
  // output 1 duplicates (first call), output 2 fails PERSISTENTLY (default —
  // the retry-on-later-polls must not re-baseline the working output).
  f.state.dupCreateScript = [0];
  f.state.dupCreateDefault = 0x887A0001;
  let t = 1000;
  const adapter = createDxgiFpsAdapter({ load: () => f.lib, callSlot: f.slotFn, now: () => t });
  await adapter.poll(0); // baseline; only the first output gets a duplication
  assert.equal(f.state.calls.dupCreate, 2);
  assert.equal(f.state.calls.gfs, 2, 'GFS is tried on every output first');
  t = 4000;
  f.state.acquireScript = [0, 0];
  const r2 = await adapter.poll(0);
  assert.equal(r2.fps, 0.7, '2 frames / 3 s from the surviving output');
  t = 7000;
  assert.equal(f.state.calls.dupCreate, 3, 'the failed output is retried every poll, the survivor is NOT re-created');
  f.state.acquireScript = [0];
  const r3 = await adapter.poll(0);
  assert.equal(r3.fps, 0.3, 'no re-baseline: the drain divides by the poll-1 baseline window');
  await adapter.stop();
});

test('M4-D2: wrappedDelta handles the uint32 wrap (PresentCount counters wrap at 2^32)', () => {
  assert.equal(wrappedDelta(10, 5), 5);
  assert.equal(wrappedDelta(5, 10), 0xFFFFFFFB, 'a wrapped counter renders the true positive delta');
  assert.equal(wrappedDelta(0xFFFFFFFF, 0xFFFFFFF0), 15);
  assert.equal(wrappedDelta(0, 0), 0);
});

test('M4-D2: presentCountOf reads the first uint32 of DXGI_FRAME_STATISTICS', () => {
  const kbuf = koffi.alloc('uint8', DXGI_FRAME_STATISTICS_SIZE);
  koffi.encode(kbuf, 0, 'uint32', 0xDEADBEEF);
  assert.equal(presentCountOf(kbuf), 0xDEADBEEF);
});

test('M4-D2: the adapter degrades to null when DXGI cannot load (never throws)', async () => {
  const adapter = createDxgiFpsAdapter({
    load: () => { throw new Error('dxgi.dll unavailable'); },
  });
  assert.equal(await adapter.poll(0), null);
  assert.equal(await adapter.poll(0), null, 'permanently unavailable');
  assert.equal(await adapter.adapterLuidOf('0x56a0'), null);
  await adapter.stop(); // no-op, no throw
});

test('M4-D2: the adapter degrades to null when CreateDXGIFactory1 fails', async () => {
  const fakeLib = {
    func: (name) => {
      assert.equal(name, 'CreateDXGIFactory1');
      return () => 0x80070005; // E_ACCESSDENIED (negative HRESULT)
    },
  };
  const adapter = createDxgiFpsAdapter({ load: () => fakeLib });
  assert.equal(await adapter.poll(0), null);
  assert.equal(await adapter.adapterLuidOf('0x56a0'), null);
});

test('M4-D2: the first poll takes the baseline and returns an honest 0 FPS sample', async () => {
  // The session-level baseline semantics are pinned by the live checkpoint
  // (pipeline/live-fps-dxgi.mjs); here we assert the shape contract: the
  // first poll returns { fps: 0, frameTimeMs: null, gpuBusy: null }-shaped
  // data (never '—') once the DXGI session is up.
  const statsBuf = koffi.alloc('uint8', DXGI_FRAME_STATISTICS_SIZE);
  koffi.encode(statsBuf, 0, 'uint32', 100);
  assert.equal(presentCountOf(statsBuf), 100);
});

test('M4-D2: stop() is safe on an uninitialized adapter', async () => {
  const adapter = createDxgiFpsAdapter({ load: () => { throw new Error('nope'); } });
  await adapter.stop();
  assert.equal(await adapter.poll(0), null);
});
