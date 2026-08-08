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
import { formatBytes, cpuCardRows, rebarState, primaryVideoController, ramMemoryType, cacheLine } from '../src/renderer/pure/sysinfo.ts';
import type { SysInfo, VideoControllerInfo } from '../src/renderer/types.ts';

const fixture: SysInfo = {
  cpu: {
    name: 'Intel(R) Core(TM) i7-14700K', cores: 20, threads: 28, maxClockMhz: 5600,
    l1CacheKb: 1470, l2CacheKb: 36864, l3CacheKb: 688128, l4CacheKb: 393216,
  },
  ram: { totalBytes: 34359738368, speedMhz: 6000, manufacturer: 'G.Skill', memoryType: 34 },
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

test('M4-D (user) + M4-D2 (§6) + M4-H: cpuCardRows bundles cores/threads (the CLOCK is live now — no static MHz part) + RAM brand/size/TYPE/speed + the Caches row', () => {
  assert.deepEqual(cpuCardRows(fixture), {
    cpu: 'Intel(R) Core(TM) i7-14700K',
    coresClock: '20 Cores / 28 Threads',
    memory: 'G.Skill 32 GB DDR5',
    memoryFreq: '@ 6000 MHz',
    caches: 'L1 1.4 MB / L2 36.0 MB / L3 672.0 MB / L4 384.0 MB',
  });
});

test('M4-H: ramMemoryType pins EVERY documented SMBIOS Type-17 code', () => {
  // The exact codes from the plan (S1 — corrected twice; 25=FBD2 is NOT DDR4).
  assert.equal(ramMemoryType(24), 'DDR3');
  assert.equal(ramMemoryType(26), 'DDR4');
  assert.equal(ramMemoryType(27), 'LPDDR');
  assert.equal(ramMemoryType(28), 'LPDDR2');
  assert.equal(ramMemoryType(29), 'LPDDR3');
  assert.equal(ramMemoryType(30), 'LPDDR4');
  assert.equal(ramMemoryType(34), 'DDR5');
  assert.equal(ramMemoryType(35), 'LPDDR5');
  assert.equal(ramMemoryType(32), 'HBM');
  assert.equal(ramMemoryType(33), 'HBM2');
  assert.equal(ramMemoryType(36), 'HBM3');
  // Everything else is OMITTED (never a wrong type): 25 = FBD2, unknown
  // codes, garbage, absent.
  assert.equal(ramMemoryType(25), null);
  assert.equal(ramMemoryType(0), null);
  assert.equal(ramMemoryType(23), null);
  assert.equal(ramMemoryType(37), null);
  assert.equal(ramMemoryType(999), null);
  assert.equal(ramMemoryType(null), null);
  assert.equal(ramMemoryType(undefined), null);
  assert.equal(ramMemoryType(Number.NaN), null);
});

test('M4-H: the memory row inserts the type between the size and the speed; a null type is omitted', () => {
  // DDR5 present.
  assert.equal(cpuCardRows(fixture).memory, 'G.Skill 32 GB DDR5');
  assert.equal(cpuCardRows(fixture).memoryFreq, '@ 6000 MHz');
  // Unknown code -> omitted (the honest line stays "G.Skill 32 GB @ 6000 MHz"
  // via the memoryFreq span).
  const unknown = { ...fixture, ram: { ...fixture.ram, memoryType: 25 } };
  const rows = cpuCardRows(unknown);
  assert.equal(rows.memory, 'G.Skill 32 GB');
  assert.equal(rows.memoryFreq, '@ 6000 MHz');
  // No speed -> no freq span (the type still renders).
  const noSpeed = { ...fixture, ram: { ...fixture.ram, speedMhz: null } };
  assert.equal(cpuCardRows(noSpeed).memory, 'G.Skill 32 GB DDR5');
  assert.equal(cpuCardRows(noSpeed).memoryFreq, null);
});

test('M4-H: the Caches row renders ONLY the levels that exist (KB -> "L1 1.4 MB")', () => {
  // L4 renders only when the payload carries it (CIM has no L4 — the mock
  // fixture does).
  const noL4: SysInfo = {
    cpu: { name: 'x', cores: 4, threads: 8, maxClockMhz: 1, l1CacheKb: 1470, l2CacheKb: 36864, l3CacheKb: 688128, l4CacheKb: null },
    ram: { totalBytes: 1, speedMhz: null, manufacturer: null, memoryType: null },
    videoControllers: [],
  };
  assert.equal(cpuCardRows(noL4).caches, 'L1 1.4 MB / L2 36.0 MB / L3 672.0 MB');
  // No caches at all -> '—' (never a fake 0).
  const bare: SysInfo = {
    cpu: { name: 'x', cores: 4, threads: 8, maxClockMhz: 1, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null },
    ram: { totalBytes: 1, speedMhz: null, manufacturer: null, memoryType: null },
    videoControllers: [],
  };
  assert.equal(cpuCardRows(bare).caches, '—');
});

test('M4-H: cacheLine formats KB as "L1 1.4 MB" (1 decimal) and degrades null/non-finite/<=0', () => {
  assert.equal(cacheLine('L1', 1470), 'L1 1.4 MB');
  assert.equal(cacheLine('L2', 36864), 'L2 36.0 MB');
  assert.equal(cacheLine('L4', 393216), 'L4 384.0 MB');
  assert.equal(cacheLine('L1', 512), 'L1 0.5 MB');
  assert.equal(cacheLine('L1', null), null);
  assert.equal(cacheLine('L1', undefined), null);
  assert.equal(cacheLine('L1', 0), null);
  assert.equal(cacheLine('L1', -5), null);
  assert.equal(cacheLine('L1', Number.NaN), null);
});

test('M4-D (user): a null payload (query never landed) renders all "—" rows', () => {
  assert.deepEqual(cpuCardRows(null), {
    cpu: '—',
    coresClock: '—',
    memory: '—',
    memoryFreq: null,
    caches: '—',
  });
});

test('M4-D: the os.cpus() fallback (no physical cores / no RAM speed / no brand) degrades honestly', () => {
  const rows = cpuCardRows({
    cpu: { name: 'Intel(R) Core(TM) i7-14700K', cores: null, threads: 28, maxClockMhz: 5600, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null },
    ram: { totalBytes: 34359738368, speedMhz: null, manufacturer: null, memoryType: null },
    videoControllers: [],
  });
  // The physical half is unknown — only the logical half renders (never an
  // estimate; the clock half is LIVE and lives in the dashboard, not here);
  // the RAM speed/brand pieces degrade out.
  assert.equal(rows.coresClock, '28 Threads');
  assert.equal(rows.memory, '32 GB');
  assert.equal(rows.memoryFreq, null);
  assert.equal(rows.caches, '—');
  assert.equal(rows.cpu, 'Intel(R) Core(TM) i7-14700K');
});

test('M4-D: missing CPU fields degrade per-field', () => {
  const rows = cpuCardRows({ cpu: { name: null, cores: null, threads: null, maxClockMhz: null, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null }, ram: { totalBytes: 0, speedMhz: null, manufacturer: null, memoryType: null }, videoControllers: [] });
  assert.deepEqual(rows, { cpu: '—', coresClock: '—', memory: '—', memoryFreq: null, caches: '—' });
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

// ---------------------------------------------------------------------------
// 1.0.1 no-Intel round — the OS GPU pick (primaryVideoController)
// ---------------------------------------------------------------------------

test('1.0.1: primaryVideoController picks the PRIMARY NON-BASIC controller (the same pick matchVideoController uses for a model-less name)', () => {
  const sysinfo: SysInfo = {
    cpu: { name: 'AMD Ryzen 5 7600', cores: 6, threads: 12, maxClockMhz: 5100, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null },
    ram: { totalBytes: 34359738368, speedMhz: 6000, manufacturer: 'G.Skill', memoryType: null },
    videoControllers: [
      { name: 'Microsoft Basic Display Adapter', vramBytes: null, pnpDeviceId: null, rebarActive: null },
      { name: 'AMD Radeon RX 7600', vramBytes: 8589934592, pnpDeviceId: 'PCI\\VEN_1002&DEV_7480&SUBSYS_24011462&REV_C7', rebarActive: false },
    ],
  };
  assert.deepEqual(primaryVideoController(sysinfo), { name: 'AMD Radeon RX 7600', vramBytes: 8589934592 });
});

test('1.0.1: primaryVideoController — an AMD-first list picks the AMD part directly; vramBytes degrades to null', () => {
  const sysinfo: SysInfo = {
    cpu: { name: 'AMD Ryzen 5 7600', cores: 6, threads: 12, maxClockMhz: 5100, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null },
    ram: { totalBytes: 34359738368, speedMhz: null, manufacturer: null, memoryType: null },
    videoControllers: [
      { name: 'AMD Radeon RX 7600', vramBytes: null, pnpDeviceId: null, rebarActive: false },
    ],
  };
  assert.deepEqual(primaryVideoController(sysinfo), { name: 'AMD Radeon RX 7600', vramBytes: null });
});

test('1.0.1: primaryVideoController — null payload / empty list / basic-only degrade to null', () => {
  assert.deepEqual(primaryVideoController(null), null);
  assert.deepEqual(primaryVideoController({ cpu: { name: 'x', cores: null, threads: null, maxClockMhz: null, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null }, ram: { totalBytes: 0, speedMhz: null, manufacturer: null, memoryType: null }, videoControllers: [] }), null);
  assert.deepEqual(primaryVideoController({ cpu: { name: 'x', cores: null, threads: null, maxClockMhz: null, l1CacheKb: null, l2CacheKb: null, l3CacheKb: null }, ram: { totalBytes: 0, speedMhz: null, manufacturer: null, memoryType: null }, videoControllers: [{ name: 'Microsoft Basic Display Adapter', vramBytes: null, pnpDeviceId: null, rebarActive: null }] }), null);
});
