// M4-D — dashboard CPU/GPU card row model (pure/sysinfo.ts): the sysinfo:get
// payload renders as honest kv rows; every null field degrades to '—' (the
// os.cpus() fallback has no physical-core count or RAM speed — the card
// must never invent a number). M4-D (user): the cores/threads and the RAM
// brand/size/speed are BUNDLED rows. M4-D2 (§5): the RAM amount ROUNDS UP
// to the next whole GiB (34293735424 → "32 GB"); (§2) the PCIe row +
// pcieRow helper are REMOVED; (§6) the clock half of the cores row moved
// OUT of this static model (the dashboard renders the LIVE frequency from
// the telemetry tick).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, cpuCardRows, rebarState } from '../src/renderer/pure/sysinfo.ts';
import type { SysInfo, VideoControllerInfo } from '../src/renderer/types.ts';

const fixture: SysInfo = {
  cpu: { name: 'Intel(R) Core(TM) i7-14700K', cores: 20, threads: 28, maxClockMhz: 5600 },
  ram: { totalBytes: 34359738368, speedMhz: 6000, manufacturer: 'G.Skill' },
  videoControllers: [{
    name: 'Intel(R) Arc(TM) A770 Graphics',
    vramBytes: 17179869184,
    pnpDeviceId: null,
    rebarActive: true,
  }],
};

test('M4-D2: formatBytes ROUNDS UP to the next whole GiB and drops the decimal', () => {
  assert.equal(formatBytes(34293735424), '32 GB'); // 31.93 GiB -> 32 (the user's case)
  assert.equal(formatBytes(34359738368), '32 GB'); // exactly 32 GiB -> 32
  assert.equal(formatBytes(17179869184), '16 GB'); // exactly 16 GiB -> 16
  assert.equal(formatBytes(8602566656), '9 GB'); // 8.01 GiB -> 9 (documented ceil semantics)
  assert.equal(formatBytes(100 * 1024 ** 3), '100 GB');
  // Sub-GiB amounts render as whole MiB (never a rounded-up "1 GB" lie).
  assert.equal(formatBytes(512 * 1024 ** 2), '512 MB');
  assert.equal(formatBytes(0), '—');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatBytes(-1), '—');
});

test('M4-D (user) + M4-D2 (§6): cpuCardRows bundles cores/threads (the CLOCK is live now — no static MHz part) + RAM brand/size/speed', () => {
  assert.deepEqual(cpuCardRows(fixture), {
    cpu: 'Intel(R) Core(TM) i7-14700K',
    coresClock: '20 Cores / 28 Threads',
    memory: 'G.Skill 32 GB @ 6000 MHz',
  });
});

test('M4-D (user): a null payload (query never landed) renders all "—" rows', () => {
  assert.deepEqual(cpuCardRows(null), {
    cpu: '—',
    coresClock: '—',
    memory: '—',
  });
});

test('M4-D: the os.cpus() fallback (no physical cores / no RAM speed / no brand) degrades honestly', () => {
  const rows = cpuCardRows({
    cpu: { name: 'Intel(R) Core(TM) i7-14700K', cores: null, threads: 28, maxClockMhz: 5600 },
    ram: { totalBytes: 34359738368, speedMhz: null, manufacturer: null },
    videoControllers: [],
  });
  // The physical half is unknown — only the logical half renders (never an
  // estimate; the clock half is LIVE and lives in the dashboard, not here);
  // the RAM speed/brand pieces degrade out.
  assert.equal(rows.coresClock, '28 Threads');
  assert.equal(rows.memory, '32 GB');
  assert.equal(rows.cpu, 'Intel(R) Core(TM) i7-14700K');
});

test('M4-D: missing CPU fields degrade per-field', () => {
  const rows = cpuCardRows({ cpu: { name: null, cores: null, threads: null, maxClockMhz: null }, ram: { totalBytes: 0, speedMhz: null, manufacturer: null }, videoControllers: [] });
  assert.deepEqual(rows, { cpu: '—', coresClock: '—', memory: '—' });
});

// ---------------------------------------------------------------------------
// M4-D2: the PCIe row + the pcieRow helper are REMOVED (the unpopulated
// 1/1 kernel pattern made the row a permanent '—' on the A770). The ReBAR
// pill stays.
// ---------------------------------------------------------------------------

const rebarController = (rebarActive: boolean | null): VideoControllerInfo => ({
  name: 'Intel(R) Arc(TM) A770 Graphics',
  vramBytes: null,
  pnpDeviceId: null,
  rebarActive,
});

test('M4-D (user): rebarState — green on, red off, grey unknown', () => {
  assert.deepEqual(rebarState(rebarController(true)), { label: 'ReBAR on', level: 'ok' });
  assert.deepEqual(rebarState(rebarController(false)), { label: 'ReBAR off', level: 'error' });
  assert.deepEqual(rebarState(rebarController(null)), { label: 'ReBAR —', level: 'unknown' });
  assert.deepEqual(rebarState(null), { label: 'ReBAR —', level: 'unknown' });
});
