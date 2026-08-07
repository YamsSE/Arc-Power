// M4-D — dashboard CPU/GPU card row model (pure/sysinfo.ts): the sysinfo:get
// payload renders as honest kv rows; every null field degrades to '—' (the
// os.cpus() fallback has no physical-core count or RAM speed — the card
// must never invent a number). M4-D (user): the cores/threads/clock and the
// RAM brand/size/speed are BUNDLED rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, cpuCardRows, pcieRow, rebarState } from '../src/renderer/pure/sysinfo.ts';
import type { SysInfo, VideoControllerInfo } from '../src/renderer/types.ts';

const fixture: SysInfo = {
  cpu: { name: 'Intel(R) Core(TM) i7-14700K', cores: 20, threads: 28, maxClockMhz: 5600 },
  ram: { totalBytes: 34359738368, speedMhz: 6000, manufacturer: 'G.Skill' },
  videoControllers: [{
    name: 'Intel(R) Arc(TM) A770 Graphics',
    vramBytes: 17179869184,
    pnpDeviceId: null,
    pcie: { currentGen: 4, currentWidth: 16, maxGen: 4, maxWidth: 16 },
    rebarActive: true,
  }],
};

test('M4-D: formatBytes renders GB figures; null/zero/non-finite degrade to "—"', () => {
  assert.equal(formatBytes(34359738368), '32.0 GB');
  assert.equal(formatBytes(17179869184), '16.0 GB');
  assert.equal(formatBytes(100 * 1024 ** 3), '100 GB'); // >= 100 GiB -> rounded, no decimal
  assert.equal(formatBytes(0), '—');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(Number.NaN), '—');
  assert.equal(formatBytes(-1), '—');
});

test('M4-D (user): cpuCardRows bundles cores/threads/clock and RAM brand/size/speed', () => {
  assert.deepEqual(cpuCardRows(fixture), {
    cpu: 'Intel(R) Core(TM) i7-14700K',
    coresClock: '20 Cores / 28 Threads / @ 5600 MHz',
    memory: 'G.Skill 32.0 GB @ 6000 MHz',
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
  // The physical half is unknown — only the logical half + clock render
  // (never an estimate); the RAM speed/brand pieces degrade out.
  assert.equal(rows.coresClock, '28 Threads / @ 5600 MHz');
  assert.equal(rows.memory, '32.0 GB');
  assert.equal(rows.cpu, 'Intel(R) Core(TM) i7-14700K');
});

test('M4-D: missing CPU fields degrade per-field', () => {
  const rows = cpuCardRows({ cpu: { name: null, cores: null, threads: null, maxClockMhz: null }, ram: { totalBytes: 0, speedMhz: null, manufacturer: null }, videoControllers: [] });
  assert.deepEqual(rows, { cpu: '—', coresClock: '—', memory: '—' });
});

// ---------------------------------------------------------------------------
// M4-D (user): the GPU-card PCIe row + the ReBAR pill.
// ---------------------------------------------------------------------------

const pcieController = (pcie: VideoControllerInfo['pcie']): VideoControllerInfo => ({
  name: 'Intel(R) Arc(TM) A770 Graphics',
  vramBytes: null,
  pnpDeviceId: null,
  pcie,
  rebarActive: null,
});

test('M4-D (user): pcieRow renders the CURRENTLY-USED link ("PCIe 4.0 x16")', () => {
  assert.equal(pcieRow(pcieController({ currentGen: 4, currentWidth: 16, maxGen: 4, maxWidth: 16 })), 'PCIe 4.0 x16');
  assert.equal(pcieRow(pcieController({ currentGen: 3, currentWidth: 8, maxGen: 3, maxWidth: 16 })), 'PCIe 3.0 x8');
});

test('M4-D (user): pcieRow degrades to "—" when the kernel does not populate the link (live-verified 1/1 pattern)', () => {
  assert.equal(pcieRow(null), '—');
  assert.equal(pcieRow(undefined), '—');
  assert.equal(pcieRow(pcieController({ currentGen: 1, currentWidth: 1, maxGen: 1, maxWidth: 1 })), '—');
  assert.equal(pcieRow(pcieController({ currentGen: null, currentWidth: null, maxGen: null, maxWidth: null })), '—');
});

test('M4-D (user): rebarState — green on, red off, grey unknown', () => {
  assert.deepEqual(rebarState({ ...pcieController(null), rebarActive: true }), { label: 'ReBAR on', level: 'ok' });
  assert.deepEqual(rebarState({ ...pcieController(null), rebarActive: false }), { label: 'ReBAR off', level: 'error' });
  assert.deepEqual(rebarState({ ...pcieController(null), rebarActive: null }), { label: 'ReBAR —', level: 'unknown' });
  assert.deepEqual(rebarState(null), { label: 'ReBAR —', level: 'unknown' });
});
