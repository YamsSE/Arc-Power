import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RTSS_APP_OFFSETS,
  RTSS_HEADER_OFFSETS,
  RTSS_FILE_MAP_READ,
  RTSS_MAPPING_NAME,
  RTSS_SIGNATURE,
  createRtssFpsLane,
  createRtssFpsSource,
  readRtssHeader,
  readRtssSnapshot,
} from '../src/main/fps-rtss.js';

const PID = 4242;
const ENTRY_SIZE = RTSS_APP_OFFSETS.statFrameTimeBuffer + (RTSS_APP_OFFSETS.statFrameTimeBufferLength * 4);
const ENTRY_OFFSET = 64;

function fixture({ pid = PID, time0 = 1000, time1 = 2000, frames = 120, frameTimeUs = 8333, version = 0x0002000E } = {}) {
  const bytes = new Uint8Array(ENTRY_OFFSET + ENTRY_SIZE);
  const view = new DataView(bytes.buffer);
  const put = (offset, value) => view.setUint32(offset, value >>> 0, true);
  put(RTSS_HEADER_OFFSETS.signature, Buffer.from('RTSS', 'ascii').readUInt32BE(0));
  put(RTSS_HEADER_OFFSETS.version, version);
  put(RTSS_HEADER_OFFSETS.appEntrySize, ENTRY_SIZE);
  put(RTSS_HEADER_OFFSETS.appArrOffset, ENTRY_OFFSET);
  put(RTSS_HEADER_OFFSETS.appArrSize, 1);
  put(ENTRY_OFFSET + RTSS_APP_OFFSETS.processId, pid);
  new TextEncoder().encodeInto('game.exe', bytes.subarray(ENTRY_OFFSET + RTSS_APP_OFFSETS.name));
  put(ENTRY_OFFSET + RTSS_APP_OFFSETS.flags, 0x0008); // RTSS APPFLAG_D3D12
  put(ENTRY_OFFSET + RTSS_APP_OFFSETS.time0, time0);
  put(ENTRY_OFFSET + RTSS_APP_OFFSETS.time1, time1);
  put(ENTRY_OFFSET + RTSS_APP_OFFSETS.frames, frames);
  put(ENTRY_OFFSET + RTSS_APP_OFFSETS.frameTimeUs, frameTimeUs);
  put(ENTRY_OFFSET + RTSS_APP_OFFSETS.statFrameRateAvg, 120);
  put(ENTRY_OFFSET + RTSS_APP_OFFSETS.statFrameTimeCount, 300);
  for (let index = 0; index < 300; index += 1) {
    put(ENTRY_OFFSET + RTSS_APP_OFFSETS.statFrameTimeBuffer + (index * 4), frameTimeUs);
  }
  return bytes;
}

function readers(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    readUint32: (offset) => view.getUint32(offset, true),
    readByte: (offset) => view.getUint8(offset),
  };
}

test('RTSS parser reads the offset-based shared-memory layout and native API/FPS fields', () => {
  const bytes = fixture();
  const { readUint32, readByte } = readers(bytes);
  assert.equal(RTSS_SIGNATURE, Buffer.from('RTSS', 'ascii').readUInt32BE(0));
  assert.equal(readRtssHeader(readUint32)?.appArrOffset, ENTRY_OFFSET);
  const result = readRtssSnapshot(readUint32, readByte, { processId: PID });
  assert.equal(result.processId, PID);
  assert.equal(result.name, 'game.exe');
  assert.equal(result.sample.fps, 120);
  assert.equal(result.sample.frameTimeMs, 8.333);
  assert.equal(result.sample.avgFps, 120);
  assert.equal(result.sample.low1Pct, 120);
  assert.equal(result.sample.low01Pct, 120);
  assert.equal(result.sample.p99, 120);
  assert.equal(result.sample.api, 'dx12');
});

test('RTSS parser rejects an invalid signature and missing target without throwing', () => {
  const bytes = fixture();
  const { readUint32, readByte } = readers(bytes);
  new DataView(bytes.buffer).setUint32(RTSS_HEADER_OFFSETS.signature, 0xDEAD, true);
  assert.equal(readRtssHeader(readUint32), null);
  assert.equal(readRtssSnapshot(readUint32, readByte, { processId: PID }), null);

  const byteOrdered = fixture();
  new DataView(byteOrdered.buffer).setUint32(
    RTSS_HEADER_OFFSETS.signature,
    Buffer.from('RTSS', 'ascii').readUInt32LE(0),
    true,
  );
  const byteOrderedReaders = readers(byteOrdered);
  assert.equal(readRtssHeader(byteOrderedReaders.readUint32), null, 'ASCII byte order is not the MSVC RTSS signature');

  const other = fixture({ pid: 7 });
  const readersForOther = readers(other);
  assert.equal(readRtssSnapshot(readersForOther.readUint32, readersForOther.readByte, { processId: PID }), null);
});

test('RTSS parser rejects an application array outside the mapped view', () => {
  const bytes = fixture();
  const view = new DataView(bytes.buffer);
  view.setUint32(RTSS_HEADER_OFFSETS.appArrOffset, bytes.byteLength - 2, true);
  const { readUint32, readByte } = readers(bytes);
  assert.equal(readRtssHeader(readUint32, bytes.byteLength), null);
  assert.equal(readRtssSnapshot(readUint32, readByte, { processId: PID }, { byteLength: bytes.byteLength }), null);
});

test('RTSS source returns a live sample, expires a frozen entry, and closes the mapping', async () => {
  let now = 1000;
  let unmaps = 0;
  let closes = 0;
  const bytes = fixture();
  const { readUint32, readByte } = readers(bytes);
  const source = createRtssFpsSource({
    openMapping: (access, inheritHandle, name) => {
      assert.equal(access, RTSS_FILE_MAP_READ);
      assert.equal(inheritHandle, false);
      assert.equal(name, RTSS_MAPPING_NAME);
      return { handle: true };
    },
    mapView: () => bytes,
    unmapView: () => { unmaps += 1; },
    closeHandle: () => { closes += 1; },
    readUint32: (_view, offset) => readUint32(offset),
    readByte: (_view, offset) => readByte(offset),
    now: () => now,
    staleAfterMs: 500,
  });
  assert.equal((await source.poll(PID)).fps, 120);
  now = 1200;
  assert.equal((await source.poll(PID)).fps, 120);
  now = 1601;
  assert.equal(await source.poll(PID), null);
  await source.stop();
  assert.equal(unmaps, 1);
  assert.equal(closes, 1);
});

test('RTSS lane follows the foreground PID and never measures Arc Power itself', async () => {
  const calls = [];
  const source = { poll: async (pid) => { calls.push(pid); return { fps: 60 }; }, stop: async () => {} };
  let foreground = PID;
  let alive = true;
  let now = 1000;
  const lane = createRtssFpsLane({
    source,
    resolveForegroundPid: async () => foreground,
    isOwnPid: async (pid) => pid === 99,
    isPidAlive: async () => alive,
    now: () => now,
  });
  assert.deepEqual(await lane.poll(0), { fps: 60 });
  foreground = 99;
  assert.deepEqual(await lane.poll(0), { fps: 60 });
  alive = false;
  assert.equal(await lane.poll(0), null);
  assert.deepEqual(calls, [PID, PID]);
  alive = true;
  foreground = PID + 1;
  now = 2000;
  assert.deepEqual(await lane.poll(0), { fps: 60 });
  assert.deepEqual(calls, [PID, PID, PID + 1]);
  await lane.stop();
});
