// M4-D — dashboard CPU card row model (pure/sysinfo.ts): the sysinfo:get
// payload renders as five honest kv rows; every null field degrades to '—'
// (the os.cpus() fallback has no physical-core count or RAM speed — the
// card must never invent a number).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, cpuCardRows } from '../src/renderer/pure/sysinfo.ts';
import type { SysInfo } from '../src/renderer/types.ts';

const fixture: SysInfo = {
  cpu: { name: 'Intel(R) Core(TM) i7-14700K', cores: 20, threads: 28, maxClockMhz: 5600 },
  ram: { totalBytes: 34359738368, speedMhz: 6000 },
  videoControllers: [{ name: 'Intel(R) Arc(TM) A770 Graphics', vramBytes: 17179869184, pnpDeviceId: null }],
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

test('M4-D: cpuCardRows renders the fixture values', () => {
  assert.deepEqual(cpuCardRows(fixture), {
    cpu: 'Intel(R) Core(TM) i7-14700K',
    cores: '20 physical · 28 logical',
    maxClock: '5600 MHz',
    memory: '32.0 GB',
    memorySpeed: '6000 MHz',
  });
});

test('M4-D: a null payload (query never landed) renders all "—" rows', () => {
  const rows = cpuCardRows(null);
  assert.deepEqual(rows, {
    cpu: '—',
    cores: '—',
    maxClock: '—',
    memory: '—',
    memorySpeed: '—',
  });
});

test('M4-D: the os.cpus() fallback (no physical cores / no RAM speed) degrades honestly', () => {
  const rows = cpuCardRows({
    cpu: { name: 'Intel(R) Core(TM) i7-14700K', cores: null, threads: 28, maxClockMhz: 5600 },
    ram: { totalBytes: 34359738368, speedMhz: null },
    videoControllers: [],
  });
  // The physical half is unknown — only the logical half renders (never an
  // estimate); the RAM speed row degrades to '—'.
  assert.equal(rows.cores, '28 logical');
  assert.equal(rows.memorySpeed, '—');
  assert.equal(rows.cpu, 'Intel(R) Core(TM) i7-14700K');
  assert.equal(rows.memory, '32.0 GB');
});

test('M4-D: missing CPU fields degrade per-field', () => {
  const rows = cpuCardRows({ cpu: { name: null, cores: null, threads: null, maxClockMhz: null }, ram: { totalBytes: 0, speedMhz: null }, videoControllers: [] });
  assert.deepEqual(rows, { cpu: '—', cores: '—', maxClock: '—', memory: '—', memorySpeed: '—' });
});
