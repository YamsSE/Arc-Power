// M4-D2 — sys-stats tests (electron-free): the formatted-counter mapping,
// the per-tick CIM parse, the LUID instance matcher, the mock fixture and
// the injectable-query adapter. The fake execFile never spawns anything.
//
// Fix round 2: the raw-counter rolling deltas (deltaPct/deltaPerfPct/
// prevUtil/prevPerf) were REMOVED — the module reads the OS-FORMATTED
// counters as single samples. The tests below pin the formatted path.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSysStatsScript,
  parseSysStatsOutput,
  freqFromPerfPct,
  instanceMatchesLuid,
  createSysStats,
  createMockSysStats,
} from '../src/main/sys-stats.js';

// ---------------------------------------------------------------------------
// The per-tick script shape
// ---------------------------------------------------------------------------

test('buildSysStatsScript: one query reads all sources from the FORMATTED class', () => {
  const script = buildSysStatsScript();
  // Fix round 2: the CPU counters come from the FORMATTED class (the OS's
  // own 0..100 values) — the raw class + the 100ns timestamp are GONE.
  assert.match(script, /Win32_PerfFormattedData_Counters_ProcessorInformation/);
  assert.doesNotMatch(script, /Win32_PerfRawData_Counters_ProcessorInformation/);
  assert.doesNotMatch(script, /Timestamp_PerfTime/);
  assert.match(script, /PercentProcessorTime/);
  assert.match(script, /PercentProcessorPerformance/);
  assert.match(script, /Win32_Processor/);
  assert.match(script, /MaxClockSpeed/);
  assert.match(script, /Win32_PerfFormattedData_Counters_ThermalZoneInformation/);
  assert.match(script, /Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory/);
  assert.match(script, /DedicatedUsage/);
  assert.match(script, /ConvertTo-Json/);
});

// ---------------------------------------------------------------------------
// parseSysStatsOutput
// ---------------------------------------------------------------------------

const OUTPUT = JSON.stringify({
  cpu: {
    Name: '_Total',
    PercentProcessorTime: 19,
    PercentProcessorPerformance: 130,
  },
  maxClockMhz: 3301,
  thermal: [
    { Name: '\\_TZ.TZ00', Temperature: 301 },
    { Name: '\\_TZ.TZ01', Temperature: 303 },
  ],
  gpuMem: [
    { Name: 'luid_0x00000000_0x0000ADFB_phys_0', DedicatedUsage: 2243596288 },
    { Name: 'luid_0x00000000_0x0000B1BB_phys_0', DedicatedUsage: 57049088 },
  ],
});

test('parseSysStatsOutput: maps the FORMATTED per-tick sample (no raw delta fields)', () => {
  const raw = parseSysStatsOutput(OUTPUT);
  // Fix round 2: PercentProcessorTime/Performance are the OS-formatted
  // values, mapped straight through — no Timestamp_PerfTime, no deltas.
  assert.equal(raw.fmtUtil, 19);
  assert.equal(raw.fmtPerf, 130);
  assert.equal(raw.maxClockMhz, 3301);
  // The max across all thermal zones is reported (K×10).
  assert.equal(raw.tempK10Max, 303);
  assert.equal(raw.gpuMemRows.length, 2);
  assert.equal(raw.gpuMemRows[0].name, 'luid_0x00000000_0x0000ADFB_phys_0');
  assert.equal(raw.gpuMemRows[0].dedicatedUsage, 2243596288);
});

test('parseSysStatsOutput: garbage / missing classes degrade per-field', () => {
  assert.deepEqual(parseSysStatsOutput('not json'), {
    fmtUtil: null, fmtPerf: null, maxClockMhz: null, tempK10Max: null, gpuMemRows: [],
  });
  const empty = parseSysStatsOutput(JSON.stringify({ cpu: null, thermal: null, gpuMem: null }));
  assert.equal(empty.fmtUtil, null);
  assert.equal(empty.fmtPerf, null);
  assert.equal(empty.tempK10Max, null, 'a 0/unavailable thermal zone degrades to null (never a fake 0 °C)');
  assert.deepEqual(empty.gpuMemRows, []);
  const zeroTemp = parseSysStatsOutput(JSON.stringify({ cpu: {}, thermal: [{ Temperature: 0 }], gpuMem: [] }));
  assert.equal(zeroTemp.tempK10Max, null, 'Temperature 0 -> null');
});

// ---------------------------------------------------------------------------
// The single-sample frequency mapping (fix round 2 — no delta math)
// ---------------------------------------------------------------------------

test('freqFromPerfPct: round(MaxClockSpeed × % Processor Performance / 100)', () => {
  assert.equal(freqFromPerfPct(50, 3300), 1650);
  assert.equal(freqFromPerfPct(100, 3300), 3300);
  assert.equal(freqFromPerfPct(130.3030303030303, 3300), 4300, 'the kept ~4.3 GHz pin');
  // The live machine (i7-5775C, BCLK-overclocked Z97): the formatted
  // counter reads 130 at all loads, MaxClockSpeed is 3301 →
  // round(3301 × 130 / 100) = 4291 MHz — the user's exact "4.3 GHz".
  assert.equal(freqFromPerfPct(130, 3301), 4291, 'live BCLK-OC evidence: 130 × 3301 → 4291');
  assert.equal(freqFromPerfPct(100, 3301), 3301, 'a stock machine reading 100 honestly reads base × 100%');
  assert.equal(freqFromPerfPct(null, 3300), null);
  assert.equal(freqFromPerfPct(50, null), null);
  assert.equal(freqFromPerfPct(50, 0), null);
});

test('instanceMatchesLuid: the perf-counter names encode luid_0x<high>_0x<low>_phys<N>', () => {
  assert.equal(instanceMatchesLuid('luid_0x00000000_0x0000ADFB_phys_0', { high: 0, low: 0xADFB }), true);
  assert.equal(instanceMatchesLuid('luid_0x00000000_0x0000ADFB_phys_1', { high: 0, low: 0xADFB }), true, 'any phys index');
  assert.equal(instanceMatchesLuid('luid_0x00000000_0x0000B1BB_phys_0', { high: 0, low: 0xADFB }), false);
  assert.equal(instanceMatchesLuid(null, { high: 0, low: 0xADFB }), false);
  assert.equal(instanceMatchesLuid('luid_0x00000000_0x0000ADFB_phys_0', null), false);
});

// ---------------------------------------------------------------------------
// The real adapter with an injected execFile + luidOf
// ---------------------------------------------------------------------------

test('fix-round-2: ONE formatted sample yields real values — no baseline-null tick, no deltas', async () => {
  // Regression for the F2 fix: the OLD raw-delta adapter returned null
  // for util/freq on the first sample (baseline) and then garbage deltas
  // on the real machine. The formatted path must return values from the
  // very first sample, straight from the OS-formatted counters.
  const calls = [];
  const stats = createSysStats({
    execFile: async (...args) => {
      calls.push(args);
      return { stdout: OUTPUT };
    },
    luidOf: async () => ({ high: 0, low: 0xADFB }),
    deviceIdHex: '0x56a0',
  });
  const first = await stats.sample();
  assert.equal(first.cpuUtilPct, 19, 'util = the formatted "% Processor Time" (0..100), first sample');
  assert.equal(first.cpuFreqMhz, 4291, 'freq = round(3301 × 130 / 100) — the live 4.3 GHz, first sample');
  assert.equal(first.cpuTempC, 30.3, 'K×10 -> °C (instant, not a delta)');
  assert.equal(first.gpuMemUsedBytes, 2243596288, 'gpuMem matched by LUID (instant, not a delta)');
  // The SAME single sample served again (no rolling state to corrupt it).
  const second = await stats.sample();
  assert.deepEqual(second, first, 'identical formatted samples -> identical values (no delta drift)');
  assert.ok(calls.length === 2, 'one PowerShell query per tick');
});

test('fix-round-2: formatted util/freq map through the adapter under load (fmtUtil 100)', async () => {
  // The load case from the live probe: formatted util 100, perf still 130
  // (locked BCLK ratio — the clock does not change with load).
  const stats = createSysStats({
    execFile: async () => ({ stdout: JSON.stringify({
      cpu: { PercentProcessorTime: 100, PercentProcessorPerformance: 130 },
      maxClockMhz: 3301,
      thermal: [{ Temperature: 303 }],
      gpuMem: [],
    }) }),
  });
  const out = await stats.sample();
  assert.equal(out.cpuUtilPct, 100, 'under load the util reads the formatted 100 — never the raw-delta 28.8/0/0 collapse');
  assert.equal(out.cpuFreqMhz, 4291, 'the freq row is load-invariant 4.3 GHz here — never 19–27 GHz');
});

test("createSysStats: missing formatted fields degrade to null (honest em-dash)", async () => {
  const stats = createSysStats({
    execFile: async () => ({ stdout: JSON.stringify({
      cpu: null,
      maxClockMhz: null,
      thermal: [{ Temperature: 0 }],
      gpuMem: [],
    }) }),
  });
  const out = await stats.sample();
  assert.equal(out.cpuUtilPct, null);
  assert.equal(out.cpuFreqMhz, null);
  assert.equal(out.cpuTempC, null);
  assert.equal(out.gpuMemUsedBytes, null);
});

test('createSysStats: an unmatched LUID degrades gpuMem to null; a failed query keeps the last values', async () => {
  let n = 0;
  const stats = createSysStats({
    execFile: async () => {
      n += 1;
      if (n === 1) throw new Error('powershell absent');
      return { stdout: JSON.stringify({
        cpu: { PercentProcessorTime: 19, PercentProcessorPerformance: 130 },
        maxClockMhz: 3301,
        thermal: [{ Temperature: 303 }],
        gpuMem: [],
      }) };
    },
    luidOf: async () => null, // unmatched -> null
    deviceIdHex: '0x56a0',
  });
  const first = await stats.sample();
  assert.deepEqual(first, { cpuUtilPct: null, cpuTempC: null, cpuFreqMhz: null, gpuMemUsedBytes: null }, 'a query failure degrades honestly, never throws');
  const second = await stats.sample();
  assert.equal(second.gpuMemUsedBytes, null, 'unmatched LUID -> null');
  assert.equal(second.cpuTempC, 30.3);
  assert.equal(second.cpuUtilPct, 19);
  assert.equal(second.cpuFreqMhz, 4291);
});

test('createSysStats: no deviceIdHex -> gpuMem stays null (no LUID lookup attempted)', async () => {
  const stats = createSysStats({
    execFile: async () => ({ stdout: JSON.stringify({
      cpu: { PercentProcessorTime: 19, PercentProcessorPerformance: 130 },
      maxClockMhz: 3301,
      thermal: [{ Temperature: 300 }],
      gpuMem: [{ Name: 'luid_0x00000000_0x0000ADFB_phys_0', DedicatedUsage: 2243596288 }],
    }) }),
  });
  const out = await stats.sample();
  assert.equal(out.gpuMemUsedBytes, null);
  assert.equal(out.cpuTempC, 30);
  assert.equal(out.cpuUtilPct, 19);
  assert.equal(out.cpuFreqMhz, 4291);
});

// ---------------------------------------------------------------------------
// The mock fixture (fixed deterministic values for ui-verify)
// ---------------------------------------------------------------------------

test('createMockSysStats: fixed deterministic values, never spawns anything', async () => {
  const mock = createMockSysStats();
  assert.deepEqual(await mock.sample(), { cpuUtilPct: 42, cpuTempC: 61, cpuFreqMhz: 4300, gpuMemUsedBytes: 2971324416 });
  assert.deepEqual(await mock.sample(), { cpuUtilPct: 42, cpuTempC: 61, cpuFreqMhz: 4300, gpuMemUsedBytes: 2971324416 }, 'stable across ticks');
  const overridden = createMockSysStats({ cpuUtilPct: 9 });
  assert.equal((await overridden.sample()).cpuUtilPct, 9);
});
