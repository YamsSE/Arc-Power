// M4-D — sysinfo module tests (electron-free): the PowerShell CIM output
// parsing, the os.cpus() fallback, the mock fixture and the AdapterRAM ->
// vramBytes degradation. The fake execFile never spawns anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSysinfoScript,
  parseCimOutput,
  collectSysinfo,
  resetSysinfoCache,
  fallbackSysinfo,
  createMockSysinfo,
  vramBytesFromAdapterRam,
  applyRegistryMemory,
  applyAllocatedBar,
  jedecBrand,
  JEDEC_BRAND,
  matchVideoController,
  vramBytesOfDevice,
} from '../src/main/sysinfo.js';
import { formatDeviceName } from '../src/main/backend/units.js';

// ---------------------------------------------------------------------------
// The PowerShell script shape
// ---------------------------------------------------------------------------

test('buildSysinfoScript: queries the CIM classes + the registry qwMemorySize VRAM source', () => {
  const script = buildSysinfoScript();
  assert.match(script, /Get-CimInstance Win32_Processor/);
  assert.match(script, /NumberOfCores/);
  assert.match(script, /NumberOfLogicalProcessors/);
  assert.match(script, /MaxClockSpeed/);
  assert.match(script, /Get-CimInstance Win32_ComputerSystem/);
  assert.match(script, /TotalPhysicalMemory/);
  assert.match(script, /Get-CimInstance Win32_PhysicalMemory/);
  assert.match(script, /ConfiguredClockSpeed/);
  assert.match(script, /Get-CimInstance Win32_VideoController/);
  assert.match(script, /AdapterRAM/);
  assert.match(script, /PNPDeviceID/);
  assert.match(script, /4d36e968-e325-11ce-bfc1-08002be10318/);
  assert.match(script, /HardwareInformation\.qwMemorySize/);
  assert.match(script, /MatchingDeviceId/);
  assert.match(script, /ConvertTo-Json/);
});

test('M4-D2: the ReBAR cross-check sources are queried; the PCIe plumbing is GONE', () => {
  const script = buildSysinfoScript();
  // The per-device pnputil parser (one-line layout) is kept...
  assert.match(script, /pnputil \/enum-devices \/instanceid/);
  assert.match(script, /Memory Resources:\\s\*0x/);
  // ...and the allocated-resource cross-check (Win32_AllocatedResource +
  // Win32_DeviceMemoryAddress joined by the video controller DeviceID,
  // 64-bit ranges via [Convert]::ToInt64) is added.
  assert.match(script, /Get-CimInstance Win32_DeviceMemoryAddress/);
  assert.match(script, /Get-CimInstance Win32_AllocatedResource/);
  assert.match(script, /Win32_VideoController \\\(DeviceID/);
  assert.match(script, /\[Convert\]::ToInt64/);
  // The PCIe-link property queries are REMOVED (the row was deleted).
  assert.doesNotMatch(script, /DEVPKEY_PciDevice/);
  assert.doesNotMatch(script, /CurrentLinkSpeed/);
});

// ---------------------------------------------------------------------------
// CIM output parsing
// ---------------------------------------------------------------------------

// The exact JSON PowerShell emits for a typical A770 desktop (the same
// property casing ConvertTo-Json produces for CimInstances). The AdapterRAM
// carries the LIVE-verified saturation plateau (0x7FFFFFF0 family — a 32-bit
// field cannot hold 16 GiB); the TRUE size comes from the registry
// qwMemorySize row matched by PNPDeviceID prefix.
const CIM_STDOUT = JSON.stringify({
  cpu: {
    Name: '13th Gen Intel(R) Core(TM) i7-13700K',
    NumberOfCores: 16,
    NumberOfLogicalProcessors: 24,
    MaxClockSpeed: 5400,
  },
  computerSystem: { TotalPhysicalMemory: 34359738368 },
  physicalMemory: { Manufacturer: '0420', ConfiguredClockSpeed: 6000 },
  videoControllers: [
    { DeviceID: 'VideoController1', Name: 'Intel(R) Arc(TM) A770 Graphics', AdapterRAM: 2147479552, PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08\\6&183F91F5&0&00080008', MaxBarBytes: 16777216 },
    { DeviceID: 'VideoController2', Name: 'Microsoft Basic Display Adapter', AdapterRAM: 0, PNPDeviceID: 'ROOT\\BASIC_DISPLAY\\0000', MaxBarBytes: 0 },
  ],
  registryMemory: [
    { PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08', MemoryBytes: 17179869184 },
  ],
  // M4-D2: the Win32_AllocatedResource cross-check rows (the A770's
  // 20 MB window — the LIVE range on this machine is 0xF6000000-0xF73FFFFF,
  // far below 1 GiB: ReBAR off).
  allocatedBar: [
    { PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08\\6&183F91F5&0&00080008', MaxBarBytes: 20971520 },
    { PNPDeviceID: 'ROOT\\BASIC_DISPLAY\\0000', MaxBarBytes: 0 },
  ],
});

test('parseCimOutput: maps the CIM fields into the canonical shape', () => {
  const out = parseCimOutput(CIM_STDOUT);
  assert.deepEqual(out.cpu, {
    name: '13th Gen Intel(R) Core(TM) i7-13700K',
    cores: 16,
    threads: 24,
    maxClockMhz: 5400,
  });
  // M4-D2: the raw SPD JEDEC code "0420" decodes to G.Skill.
  assert.deepEqual(out.ram, { totalBytes: 34359738368, speedMhz: 6000, manufacturer: 'G.Skill' });
  assert.equal(out.videoControllers.length, 2);
  assert.deepEqual(out.videoControllers[0], {
    name: 'Intel(R) Arc(TM) A770 Graphics',
    vramBytes: 17179869184,
    pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08\\6&183F91F5&0&00080008',
    rebarActive: false,
  });
  assert.ok(!('pcie' in out.videoControllers[0]), 'the pcie field is REMOVED');
  // A 0-AdapterRAM basic-display fallback degrades to null vramBytes.
  assert.deepEqual(out.videoControllers[1], {
    name: 'Microsoft Basic Display Adapter',
    vramBytes: null,
    pnpDeviceId: 'ROOT\\BASIC_DISPLAY\\0000',
    rebarActive: null,
  });
});

test('M4-D2: rebarActive = any >= 1 GiB range from EITHER source (pnputil OR the allocated-resource cross-check)', () => {
  // pnputil small + cross-check BIG -> on (the cross-check catches what
  // pnputil misses on other machines and vice versa).
  const merged = applyAllocatedBar(
    [{ name: 'Arc', vramBytes: null, pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0', rebarActive: null, _pnputilBarBytes: 16777216 }],
    [{ PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0', MaxBarBytes: 4294967296 }],
  );
  assert.equal(merged[0].rebarActive, true);
  // pnputil BIG + cross-check small -> on.
  const merged2 = applyAllocatedBar(
    [{ name: 'Arc', vramBytes: null, pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0', rebarActive: null, _pnputilBarBytes: 4294967296 }],
    [{ PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0', MaxBarBytes: 20971520 }],
  );
  assert.equal(merged2[0].rebarActive, true);
  // Both small -> off (the live A770 case).
  const merged3 = applyAllocatedBar(
    [{ name: 'Arc', vramBytes: null, pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0', rebarActive: null, _pnputilBarBytes: 16777216 }],
    [{ PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0', MaxBarBytes: 20971520 }],
  );
  assert.equal(merged3[0].rebarActive, false);
  // No cross-check row -> pnputil decides; no pnp id -> untouched.
  assert.equal(applyAllocatedBar(
    [{ name: 'Arc', vramBytes: null, pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0', rebarActive: null, _pnputilBarBytes: 0 }],
    [],
  )[0].rebarActive, null);
  assert.equal(applyAllocatedBar(
    [{ name: 'Arc', vramBytes: null, pnpDeviceId: null, rebarActive: true }],
    [{ PNPDeviceID: 'X', MaxBarBytes: 4294967296 }],
  )[0].rebarActive, true, 'no pnp id -> untouched');
});

// ---------------------------------------------------------------------------
// M4-D2 §4: the JEDEC manufacturer-ID -> brand map (sourced from the JEP106
// table; the live module F3-2400C11-8GXM renders "0420" = G.Skill)
// ---------------------------------------------------------------------------

test('M4-D2: jedecBrand decodes the pinned JEDEC codes', () => {
  assert.equal(jedecBrand('0420'), 'G.Skill', 'live-verified: F3-2400C11-8GXM');
  assert.equal(jedecBrand('CE00'), 'Samsung');
  assert.equal(jedecBrand('AD00'), 'SK Hynix');
  assert.equal(jedecBrand('2C00'), 'Micron');
  assert.equal(jedecBrand('9801'), 'Kingston');
  assert.equal(jedecBrand('9E02'), 'Corsair');
  assert.equal(jedecBrand('CB04'), 'ADATA');
  assert.equal(jedecBrand('EF04'), 'Team Group');
  assert.equal(jedecBrand('0205'), 'Patriot');
  assert.equal(jedecBrand('9B05'), 'Crucial');
});

test('M4-D2: jedecBrand is case-insensitive and covers the count-first packing', () => {
  assert.equal(jedecBrand('0420'), jedecBrand('0420'.toLowerCase()), 'case-insensitive');
  assert.equal(jedecBrand('ce00'), 'Samsung');
  assert.equal(jedecBrand('04CD'), 'G.Skill', 'the count-first packing of the current-table G.Skill code');
  assert.equal(jedecBrand('0198'), 'Kingston', 'the count-first packing of Kingston');
});

test('M4-D2: jedecBrand passes unknown codes and real names through honestly', () => {
  assert.equal(jedecBrand('1234'), '1234', 'unknown hex code passes through');
  assert.equal(jedecBrand('Samsung'), 'Samsung', 'a real brand name passes through');
  assert.equal(jedecBrand('G Skill Intl'), 'G Skill Intl');
  assert.equal(jedecBrand(''), null);
  assert.equal(jedecBrand(null), null);
  assert.equal(jedecBrand(undefined), null);
  assert.equal(jedecBrand(42), null);
  assert.equal(jedecBrand('ABCDE'), 'ABCDE', 'a longer hex-ish string passes through (not a 2-byte code)');
  assert.equal(Object.keys(JEDEC_BRAND).length >= 15, true, 'the map covers both packings of every listed brand');
});

test('parseCimOutput: a saturated AdapterRAM (0xFFFFFFFF) degrades to null vramBytes', () => {
  const stdout = JSON.stringify({
    cpu: { Name: 'CPU', NumberOfCores: 8, NumberOfLogicalProcessors: 8, MaxClockSpeed: 3000 },
    computerSystem: { TotalPhysicalMemory: 8589934592 },
    physicalMemory: { ConfiguredClockSpeed: null },
    videoControllers: [{ Name: 'Intel(R) Arc(TM) A770 Graphics', AdapterRAM: 0xFFFFFFFF, PNPDeviceID: 'X' }],
  });
  const out = parseCimOutput(stdout);
  assert.equal(out.videoControllers[0].vramBytes, null);
  assert.equal(out.ram.speedMhz, null, 'absent RAM speed degrades to null');
});

test('parseCimOutput: garbage / empty output degrades to the empty shape (never throws)', () => {
  assert.deepEqual(parseCimOutput('not json at all'), { cpu: {}, ram: {}, videoControllers: [] });
  assert.deepEqual(parseCimOutput(''), { cpu: {}, ram: {}, videoControllers: [] });
  assert.deepEqual(parseCimOutput(null), { cpu: {}, ram: {}, videoControllers: [] });
});

test('parseCimOutput: missing classes degrade per-field (cpu nulls, empty controllers)', () => {
  const out = parseCimOutput(JSON.stringify({ cpu: null, computerSystem: null, physicalMemory: null, videoControllers: null }));
  assert.deepEqual(out.cpu, { name: null, cores: null, threads: null, maxClockMhz: null });
  assert.equal(out.ram.totalBytes, 0);
  assert.equal(out.ram.speedMhz, null);
  assert.deepEqual(out.videoControllers, []);
});

// ---------------------------------------------------------------------------
// vramBytesFromAdapterRam degradation
// ---------------------------------------------------------------------------

test('vramBytesFromAdapterRam: genuinely small 32-bit byte counts pass through', () => {
  assert.equal(vramBytesFromAdapterRam(1073741824), 1073741824); // 1 GiB
  assert.equal(vramBytesFromAdapterRam(536870912), 536870912); // 512 MiB
  assert.equal(vramBytesFromAdapterRam(2146435071), 2146435071); // just below the plateau
});

test('vramBytesFromAdapterRam: suspicious/saturated values degrade to null', () => {
  assert.equal(vramBytesFromAdapterRam(0xFFFFFFFF), null); // >4GB saturation
  assert.equal(vramBytesFromAdapterRam(0x7FFFFFFF), null); // classic sentinel
  assert.equal(vramBytesFromAdapterRam(0x80000000), null); // top bit set
  assert.equal(vramBytesFromAdapterRam(2147479552), null); // 0x7FFFFFF0 — the LIVE A770 plateau (really 16 GiB)
  assert.equal(vramBytesFromAdapterRam(0x7FF00000), null); // the plateau floor
  // The real CIM field is a UInt32 — big byte counts can only saturate, so
  // values like 8 GiB / 16 GiB never pass through AdapterRAM (the registry
  // qwMemorySize UInt64 is the source for big VRAM).
  assert.equal(vramBytesFromAdapterRam(8589934592), null); // 8 GiB
  assert.equal(vramBytesFromAdapterRam(17179869184), null); // 16 GiB
  assert.equal(vramBytesFromAdapterRam(0), null);
  assert.equal(vramBytesFromAdapterRam(-1), null);
  assert.equal(vramBytesFromAdapterRam(NaN), null);
  assert.equal(vramBytesFromAdapterRam(Infinity), null);
  assert.equal(vramBytesFromAdapterRam('big'), null);
  assert.equal(vramBytesFromAdapterRam(null), null);
  assert.equal(vramBytesFromAdapterRam(undefined), null);
});

// ---------------------------------------------------------------------------
// applyRegistryMemory — the RELIABLE VRAM source (HardwareInformation.
// qwMemorySize UInt64, matched by PNPDeviceID prefix; live-verified on the
// A770: AdapterRAM saturates to the 0x7FFFFFF0 plateau while the registry
// carries the true 16 GiB).
// ---------------------------------------------------------------------------

test('applyRegistryMemory: the registry UInt64 wins over a saturated AdapterRAM (the A770 live case)', () => {
  const controllers = [{
    name: 'Intel(R) Arc(TM) A770 Graphics',
    vramBytes: null, // AdapterRAM 2147479552 -> degraded
    pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_60011849&REV_08\\6&183F91F5&0&00080008',
  }];
  const registryMemory = [
    { PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_60011849&REV_08', MemoryBytes: 17179869184 },
  ];
  const out = applyRegistryMemory(controllers, registryMemory);
  assert.equal(out[0].vramBytes, 17179869184, 'the true 16 GiB comes from the registry');
});

test('applyRegistryMemory: the registry wins over a small honest AdapterRAM too', () => {
  const controllers = [{
    name: 'Intel(R) Arc(TM) A770 Graphics',
    vramBytes: 1073741824, // 1 GiB (honest-looking but wrong)
    pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_60011849&REV_08\\6&1&0&00080008',
  }];
  const out = applyRegistryMemory(controllers, [
    { PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_60011849&REV_08', MemoryBytes: 17179869184 },
  ]);
  assert.equal(out[0].vramBytes, 17179869184);
});

test('applyRegistryMemory: no matching registry row keeps the AdapterRAM value; missing pnp id stays untouched', () => {
  const controllers = [
    { name: 'Intel(R) Arc(TM) A770 Graphics', vramBytes: null, pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0' },
    { name: 'Microsoft Basic Display Adapter', vramBytes: 536870912, pnpDeviceId: null },
  ];
  const out = applyRegistryMemory(controllers, [
    { PNPDeviceID: 'PCI\\VEN_1002&DEV_0000', MemoryBytes: 4294967296 },
  ]);
  assert.equal(out[0].vramBytes, null, 'no matching row -> AdapterRAM stays');
  assert.equal(out[1].vramBytes, 536870912, 'no pnp id -> untouched');
});

test('parseCimOutput: the registryMemory rows join by PNPDeviceID prefix (end to end)', () => {
  const stdout = JSON.stringify({
    cpu: { Name: 'Intel(R) Core(TM) i7-14700K', NumberOfCores: 20, NumberOfLogicalProcessors: 28, MaxClockSpeed: 5600 },
    computerSystem: { TotalPhysicalMemory: 34359738368 },
    physicalMemory: { Manufacturer: 'G.Skill', ConfiguredClockSpeed: 6000 },
    videoControllers: [{ Name: 'Intel(R) Arc(TM) A770 Graphics', AdapterRAM: 2147479552, PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_60011849&REV_08\\6&183F91F5&0&00080008' }],
    registryMemory: [{ PNPDeviceID: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_60011849&REV_08', MemoryBytes: 17179869184 }],
  });
  const out = parseCimOutput(stdout);
  assert.equal(out.videoControllers.length, 1);
  assert.equal(out.videoControllers[0].vramBytes, 17179869184);
  assert.equal(out.videoControllers[0].name, 'Intel(R) Arc(TM) A770 Graphics');
});

// ---------------------------------------------------------------------------
// collectSysinfo: the injectable execFile + the os.cpus() fallback
// ---------------------------------------------------------------------------

function fakeExecFile(stdoutOrError) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (stdoutOrError instanceof Error) throw stdoutOrError;
    return { stdout: stdoutOrError };
  };
  return { exec, calls };
}

test('collectSysinfo: runs the query once per session and caches it (one query per session)', async () => {
  resetSysinfoCache();
  const { exec, calls } = fakeExecFile(CIM_STDOUT);
  const first = await collectSysinfo({ execFile: exec });
  const second = await collectSysinfo({ execFile: exec });
  assert.equal(calls.length, 1, 'the cache must serve the second call');
  assert.equal(calls[0].cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.ok(Array.isArray(calls[0].args));
  assert.equal(first.cpu.name, '13th Gen Intel(R) Core(TM) i7-13700K');
  assert.equal(second, first, 'the cached object is returned verbatim');
  assert.equal(first.ram.totalBytes, 34359738368);
  assert.equal(first.ram.speedMhz, 6000);
  assert.equal(first.videoControllers[0].vramBytes, 17179869184);
  resetSysinfoCache();
});

test('collectSysinfo: PowerShell failure falls back to os.cpus()/os.totalmem() honestly', async () => {
  resetSysinfoCache();
  const { exec } = fakeExecFile(new Error('spawn powershell ENOENT'));
  const out = await collectSysinfo({ execFile: exec });
  // CPU name/threads/clock come from os.cpus(); cores + RAM speed +
  // controllers degrade honestly.
  const cpus = (await import('node:os')).cpus();
  assert.equal(out.cpu.name, cpus[0].model);
  assert.equal(out.cpu.threads, cpus.length);
  assert.equal(out.cpu.maxClockMhz, cpus[0].speed);
  assert.equal(out.cpu.cores, null, 'os.cpus() cannot distinguish physical cores — never an estimate');
  assert.equal(out.ram.speedMhz, null, 'RAM speed degrades honestly');
  assert.equal(out.ram.totalBytes, (await import('node:os')).totalmem());
  assert.deepEqual(out.videoControllers, [], 'no CIM -> no controller list');
  resetSysinfoCache();
});

test('M4-D review F3: the query timeout is SHORT (10 s default) and an explicit override is honored', async () => {
  resetSysinfoCache();
  const { exec, calls } = fakeExecFile(CIM_STDOUT);
  await collectSysinfo({ execFile: exec });
  assert.equal(calls[0].opts.timeout, 10000, 'the default timeout must be 10 s (a hung PowerShell must not block boot for a minute)');
  resetSysinfoCache();
  const { exec: exec2, calls: calls2 } = fakeExecFile(CIM_STDOUT);
  await collectSysinfo({ execFile: exec2, timeoutMs: 5000 });
  assert.equal(calls2[0].opts.timeout, 5000, 'an explicit timeoutMs override wins');
  resetSysinfoCache();
});

test('M4-D review F3: a TIMED-OUT query (ETIMEDOUT) lands in the honest os.cpus() fallback, never throws', async () => {
  resetSysinfoCache();
  const timedOut = new Error('ETIMEDOUT');
  timedOut.code = 'ETIMEDOUT';
  timedOut.killed = true;
  const { exec } = fakeExecFile(timedOut);
  const out = await collectSysinfo({ execFile: exec, timeoutMs: 10000 });
  const cpus = (await import('node:os')).cpus();
  assert.equal(out.cpu.name, cpus[0].model, 'the timeout fallback keeps the CPU rows');
  assert.deepEqual(out.videoControllers, [], 'the timeout fallback degrades the controllers honestly');
  assert.equal(out.ram.speedMhz, null);
  resetSysinfoCache();
});

test('collectSysinfo: garbage stdout also falls back (never returns junk)', async () => {
  resetSysinfoCache();
  const { exec } = fakeExecFile('UAC prompt interleaved garbage');
  const out = await collectSysinfo({ execFile: exec });
  assert.equal(typeof out.cpu.name, 'string');
  assert.deepEqual(out.videoControllers, []);
  resetSysinfoCache();
});

test('fallbackSysinfo: the honest os.cpus() shape (no throw on exotic platforms)', () => {
  const out = fallbackSysinfo();
  assert.equal(out.ram.speedMhz, null);
  assert.deepEqual(out.videoControllers, []);
  assert.equal(typeof out.ram.totalBytes, 'number');
  assert.ok(out.ram.totalBytes > 0);
});

// ---------------------------------------------------------------------------
// Mock fixture
// ---------------------------------------------------------------------------

test('createMockSysinfo: fixed deterministic fixture for mock/ui-verify', async () => {
  const mock = createMockSysinfo();
  const out = await mock.get();
  assert.equal(out.cpu.name, 'Intel(R) Core(TM) i7-14700K');
  assert.equal(out.cpu.cores, 20);
  assert.equal(out.cpu.threads, 28);
  assert.equal(out.cpu.maxClockMhz, 5600);
  assert.equal(out.ram.totalBytes, 34359738368);
  assert.equal(out.ram.speedMhz, 6000);
  assert.equal(out.videoControllers.length, 1);
  assert.equal(out.videoControllers[0].name, 'Intel(R) Arc(TM) A770 Graphics');
  assert.equal(out.videoControllers[0].vramBytes, 17179869184);
  assert.match(out.videoControllers[0].pnpDeviceId, /^PCI\\VEN_8086/);
});

// ---------------------------------------------------------------------------
// VRAM enrichment matching (M4-D user addition)
// ---------------------------------------------------------------------------

const CONTROLLERS = [
  { name: 'Intel(R) Arc(TM) A770 Graphics', vramBytes: 17179869184, pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_00000000&REV_08' },
  { name: 'Intel(R) UHD Graphics 770', vramBytes: null, pnpDeviceId: 'PCI\\VEN_8086&DEV_A780&SUBSYS_00000000&REV_04' },
  { name: 'Microsoft Basic Display Adapter', vramBytes: null, pnpDeviceId: 'ROOT\\BASIC_DISPLAY\\0000' },
];

test('matchVideoController: exact normalized name match wins', () => {
  const m = matchVideoController('Intel(R) Arc(TM) A770 Graphics', CONTROLLERS);
  assert.equal(m.name, 'Intel(R) Arc(TM) A770 Graphics');
  assert.equal(m.vramBytes, 17179869184);
});

test('matchVideoController: GPU-family token match for differently-worded names', () => {
  const m = matchVideoController('Intel Arc A770', CONTROLLERS);
  assert.equal(m.name, 'Intel(R) Arc(TM) A770 Graphics', 'shared family token "arc" + model token "a770"');
});

test('matchVideoController: falls to the primary non-basic adapter for a MODEL-LESS name', () => {
  // A name with NO model token ('Intel(R) Arc(TM) Graphics' style, e.g. a
  // renamed device) matches the primary non-basic adapter (the FIRST
  // non-basic controller in CIM order), never the basic-display fallback —
  // even when the basic adapter is listed first. M4-D review F1: this
  // fallback is restricted to model-less names — a name that names a
  // SPECIFIC model ('Some Odd Name 9000' carries the '9000' model token)
  // which matched no controller degrades to null instead of claiming the
  // primary's VRAM (a wrong cross-card claim is worse than an honest null).
  const mixed = [
    { name: 'Microsoft Basic Display Adapter', vramBytes: null, pnpDeviceId: 'ROOT\\BASIC_DISPLAY\\0000' },
    { name: 'Intel(R) UHD Graphics 770', vramBytes: null, pnpDeviceId: 'PCI\\VEN_8086&DEV_A780&SUBSYS_00000000&REV_04' },
  ];
  const m = matchVideoController('Intel(R) Arc(TM) Graphics', mixed);
  assert.equal(m.name, 'Intel(R) UHD Graphics 770');
  assert.equal(matchVideoController('Some Odd Name 9000', mixed), null, 'a model-bearing name never falls back to the primary');
});

test('M4-D review F1: a bare family token never matches — cross-model family names return null', () => {
  // 'Intel Arc A750' shares ONLY the family token 'arc' with the A770 row:
  // the family-token path must not claim the A770's 16 GiB (the pre-fix
  // `familyShared > 0 && shared >= 1` matched on the bare family token).
  assert.equal(matchVideoController('Intel(R) Arc(TM) A750 Graphics', CONTROLLERS), null);
  assert.equal(matchVideoController('Intel Arc A750', CONTROLLERS), null);
  assert.equal(matchVideoController('Intel Arc A750', [CONTROLLERS[0]]), null, 'the reviewer-observed case: A750 device vs an A770-only list');
  assert.equal(vramBytesOfDevice({ name: 'Intel(R) Arc(TM) A750' }, { videoControllers: CONTROLLERS }), null);
  assert.equal(vramBytesOfDevice({ name: 'Intel Arc A750' }, { videoControllers: CONTROLLERS }), null, 'the A750 must never claim 16 GiB from the A770 row');
});

test('M4-D review F1: a model-less family name matches ONLY via the primary non-basic fallback', () => {
  // 'Intel(R) Arc(TM) Graphics' has no model token: the family-token path
  // must NOT match the A770 (no shared model token), and the primary
  // non-basic fallback applies only while a non-basic controller exists —
  // a basic-display-only list degrades honestly to null.
  assert.equal(matchVideoController('Intel(R) Arc(TM) Graphics', CONTROLLERS).name, 'Intel(R) Arc(TM) A770 Graphics', 'model-less name -> primary non-basic adapter');
  assert.equal(matchVideoController('Intel(R) Arc(TM) Graphics', [{ name: 'Microsoft Basic Display Adapter', vramBytes: null, pnpDeviceId: 'X' }]), null, 'model-less name with no non-basic primary -> null');
});

test('M4-D review F1: the correct A770 still matches (family + model token) and reports 16 GiB', () => {
  assert.equal(matchVideoController('Intel Arc A770', CONTROLLERS).name, 'Intel(R) Arc(TM) A770 Graphics');
  assert.equal(vramBytesOfDevice({ name: 'Intel Arc A770' }, { videoControllers: CONTROLLERS }), 17179869184);
});

test('matchVideoController: basic-display-only lists and empty input -> null', () => {
  assert.equal(matchVideoController('Intel(R) Arc(TM) A770 Graphics', [{ name: 'Microsoft Basic Display Adapter', vramBytes: null, pnpDeviceId: 'X' }]), null);
  assert.equal(matchVideoController('', CONTROLLERS), null);
  assert.equal(matchVideoController('Intel(R) Arc(TM) A770 Graphics', []), null);
  assert.equal(matchVideoController(null, CONTROLLERS), null);
});

test('vramBytesOfDevice: matched controller vramBytes; null when unmatched/degraded/empty', () => {
  const sysinfo = { videoControllers: CONTROLLERS };
  assert.equal(vramBytesOfDevice({ name: 'Intel(R) Arc(TM) A770 Graphics' }, sysinfo), 17179869184);
  assert.equal(vramBytesOfDevice({ name: 'Intel(R) Arc(TM) A770' }, sysinfo), 17179869184, 'family token match');
  assert.equal(vramBytesOfDevice({ name: 'Intel(R) UHD Graphics 770' }, sysinfo), null, 'controller with null vramBytes stays null');
  assert.equal(vramBytesOfDevice({ name: 'Arc A770' }, null), null);
  assert.equal(vramBytesOfDevice({ name: 'Arc A770' }, { videoControllers: [] }), null);
  // A matched controller whose vramBytes degraded (saturated AdapterRAM)
  // stays null — formatDeviceName then keeps the plain name.
  const saturated = { videoControllers: [{ name: 'Intel(R) Arc(TM) A770 Graphics', vramBytes: null, pnpDeviceId: 'X' }] };
  assert.equal(vramBytesOfDevice({ name: 'Intel(R) Arc(TM) A770 Graphics' }, saturated), null);
});

test('M4-D review F3: a skipped sysinfo (the tray-only --apply-profile flow) degrades to null — the plain device name survives', () => {
  // main.js now skips collectSysinfo entirely in the --apply-profile flow
  // (tray-only — the VRAM suffix is never displayed; the CIM query would
  // only delay the logon apply). The provider must degrade on the EXACT
  // value the boot path passes (undefined) exactly like null, so
  // formatDeviceName keeps the plain name — no suffix, no crash.
  assert.equal(vramBytesOfDevice({ name: 'Intel(R) Arc(TM) A770 Graphics' }, undefined), null);
  assert.equal(vramBytesOfDevice({ name: 'Intel(R) Arc(TM) A770 Graphics' }, null), null);
  assert.equal(
    formatDeviceName('Intel(R) Arc(TM) A770 Graphics', vramBytesOfDevice({ name: 'Intel(R) Arc(TM) A770 Graphics' }, undefined)),
    'Intel(R) Arc(TM) A770 Graphics',
    'the skipped-sysinfo boot path keeps the plain device name',
  );
});
