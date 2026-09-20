import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createD3dkmtGpuUtilReader,
  D3DKMT_OFFSETS,
  D3DKMT_QUERYSTATISTICS_SIZE,
  d3dkmtUtilPctOf,
} from '../src/main/d3dkmt-gpu-util.js';
import { createSysStats } from '../src/main/sys-stats.js';

test('D3DKMT x64 offsets match the installed Windows SDK layout', () => {
  assert.equal(D3DKMT_QUERYSTATISTICS_SIZE, 0x328);
  assert.equal(D3DKMT_OFFSETS.adapterLuidLow, 0x04);
  assert.equal(D3DKMT_OFFSETS.adapterLuidHigh, 0x08);
  assert.equal(D3DKMT_OFFSETS.queryResult, 0x18);
  assert.equal(D3DKMT_OFFSETS.nodeSystemRunningTime, 0x128);
  assert.equal(D3DKMT_OFFSETS.queryNode, 0x320);
});

test('D3DKMT utilization uses the busiest node and its system-time denominator', () => {
  const previous = [
    { id: 0, globalRunningTime: 100n, systemRunningTime: 100n },
    { id: 1, globalRunningTime: 200n, systemRunningTime: 200n },
  ];
  const current = [
    { id: 0, globalRunningTime: 140n, systemRunningTime: 200n },
    { id: 1, globalRunningTime: 220n, systemRunningTime: 300n },
  ];
  assert.equal(d3dkmtUtilPctOf(previous, current, 100), 40);
});

test('D3DKMT utilization falls back to the observed 100-ns wall-clock counter', () => {
  assert.equal(d3dkmtUtilPctOf(
    [{ id: 0, globalRunningTime: 0n, systemRunningTime: 0n }],
    [{ id: 0, globalRunningTime: 500_000n, systemRunningTime: 0n }],
    50,
  ), 100);
});

test('D3DKMT utilization skips missing, stalled, or reset system counters', () => {
  const previous = [{ id: 0, globalRunningTime: 100n, systemRunningTime: 100n }];
  assert.equal(d3dkmtUtilPctOf(
    previous,
    [{ id: 0, globalRunningTime: 200n, systemRunningTime: 90n }],
    100,
  ), null);
  assert.equal(d3dkmtUtilPctOf(
    previous,
    [{ id: 0, globalRunningTime: 200n, systemRunningTime: 100n }],
    100,
  ), null);
  assert.equal(d3dkmtUtilPctOf(
    [{ id: 0, globalRunningTime: 100n, systemRunningTime: null }],
    [{ id: 0, globalRunningTime: 200n, systemRunningTime: null }],
    100,
  ), null);
});

test('D3DKMT reader establishes a baseline before publishing a node delta', async () => {
  const luid = { high: 0, low: 0xbb85 };
  const snapshots = [
    [
      { globalRunningTime: 10_000n, systemRunningTime: 0n },
      { globalRunningTime: 20_000n, systemRunningTime: 0n },
    ],
    [
      { globalRunningTime: 510_000n, systemRunningTime: 0n },
      { globalRunningTime: 920_000n, systemRunningTime: 0n },
    ],
  ];
  let snapshot = 0;
  let clock = 0;
  const reader = createD3dkmtGpuUtilReader({
    now: () => clock,
    queryStatistics: ({ type, nodeId = 0 }) => {
      if (type === 0) return { status: 0, nodeCount: 2 };
      return { status: 0, ...snapshots[Math.min(snapshot, snapshots.length - 1)][nodeId] };
    },
  });

  assert.equal(await reader.sample(luid), null);
  snapshot = 1;
  clock = 100;
  assert.equal(await reader.sample(luid), 90);
  reader.reset(luid);
  clock = 200;
  assert.equal(await reader.sample(luid), null, 'reset starts a fresh baseline');
});

test('sys-stats prefers a valid D3DKMT sample over the PDH fallback', async () => {
  const target = { deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xbb85 } };
  const commands = [];
  const handles = [];
  let resetCalls = 0;
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    ...target,
    d3dkmtGpuUtil: { sample: async () => 73, reset: () => { resetCalls += 1; } },
    execFile: async (_exe, args) => {
      const command = String(args?.[3] ?? '');
      commands.push(command);
      if (command.includes('Get-Counter')) {
        return { stdout: JSON.stringify({ gpuEng: [{
          Name: 'pid_1_luid_0x00000000_0x0000bb85_phys_0_eng_0_engtype_3d',
          UtilizationPercentage: 12,
        }] }) };
      }
      return { stdout: JSON.stringify({
        cpu: { PercentProcessorTime: 0, PercentProcessorPerformance: 100 },
        maxClockMhz: 1000,
        thermal: [],
        msaThermal: [],
        gpuMem: [],
        gpuEng: [],
        powerMeter: [],
      }) };
    },
    setInterval: (fn) => { handles.push(fn); return handles.length; },
    clearInterval: () => {},
  });

  stats.startSlowLane(999, 1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  const sample = await stats.sampleGpuUtilForTarget(target);
  assert.equal(sample.gpuUtilPct, 73);
  assert.equal(sample.gpuUtilSource, 'windows-d3dkmt');
  assert.equal(sample.gpuUtilAuthoritative, true);
  assert.ok(commands.some((command) => command.includes('Get-Counter')));
  stats.stopSlowLane(1);
  assert.equal(resetCalls, 1, 'stopping the telemetry lane clears the native baseline');
});

test('sys-stats keeps native sampling live while a slow PDH fallback is in flight', async () => {
  const target = { deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xbb85 } };
  const intervalCallbacks = [];
  let fallbackStartedResolve;
  const fallbackStarted = new Promise((resolve) => { fallbackStartedResolve = resolve; });
  let releaseFallback;
  const fallbackGate = new Promise((resolve) => { releaseFallback = resolve; });
  let nativeCalls = 0;
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    ...target,
    d3dkmtGpuUtil: {
      sample: async () => nativeCalls++ === 0 ? null : 67,
      reset: () => {},
    },
    execFile: async (_exe, args) => {
      const command = String(args?.[3] ?? '');
      if (command.includes('Get-Counter')) {
        fallbackStartedResolve();
        await fallbackGate;
        return { stdout: JSON.stringify({ gpuEng: [] }) };
      }
      return { stdout: JSON.stringify({
        cpu: { PercentProcessorTime: 0, PercentProcessorPerformance: 100 },
        maxClockMhz: 1000,
        thermal: [],
        msaThermal: [],
        gpuMem: [],
        gpuEng: [],
        powerMeter: [],
      }) };
    },
    setInterval: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearInterval: () => {},
  });

  try {
    stats.startSlowLane(999, 1);
    await fallbackStarted;
    assert.equal(intervalCallbacks.length, 2, 'slow and dedicated GPU timers are both armed');

    // The second GPU tick must be able to establish the native sample even
    // while the first tick's PowerShell fallback remains blocked.
    await intervalCallbacks[1]();
    const live = await stats.sampleGpuUtilForTarget(target);
    assert.equal(live.gpuUtilPct, 67);
    assert.equal(live.gpuUtilSource, 'windows-d3dkmt');
    assert.equal(nativeCalls, 2);
  } finally {
    releaseFallback();
    await new Promise((resolve) => setTimeout(resolve, 20));
    stats.stopSlowLane(1);
  }
});

test('a late PDH fallback cannot overwrite a newer native utilization sample', async () => {
  const target = { deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xbb85 } };
  const intervalCallbacks = [];
  let releaseFallback;
  const fallbackGate = new Promise((resolve) => { releaseFallback = resolve; });
  let releaseLuid;
  const fallbackLuidGate = new Promise((resolve) => { releaseLuid = resolve; });
  let fallbackLuidStartedResolve;
  const fallbackLuidStarted = new Promise((resolve) => { fallbackLuidStartedResolve = resolve; });
  let holdFallbackLuid = false;
  let nativeCalls = 0;
  let fallbackStartedResolve;
  const fallbackStarted = new Promise((resolve) => { fallbackStartedResolve = resolve; });
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    ...target,
    d3dkmtGpuUtil: {
      sample: async () => nativeCalls++ === 0 ? null : 73,
      reset: () => {},
    },
    luidOf: async () => {
      if (holdFallbackLuid) {
        holdFallbackLuid = false;
        fallbackLuidStartedResolve();
        await fallbackLuidGate;
      }
      return target.osLuid;
    },
    execFile: async (_exe, args) => {
      const command = String(args?.[3] ?? '');
      if (command.includes('Get-Counter')) {
        fallbackStartedResolve();
        await fallbackGate;
        return { stdout: JSON.stringify({ gpuEng: [{
          Name: 'pid_1_luid_0x00000000_0x0000bb85_phys_0_eng_0_engtype_3d',
          UtilizationPercentage: 12,
        }] }) };
      }
      return { stdout: JSON.stringify({
        cpu: { PercentProcessorTime: 0, PercentProcessorPerformance: 100 },
        maxClockMhz: 1000,
        thermal: [],
        msaThermal: [],
        gpuMem: [],
        gpuEng: [],
        powerMeter: [],
      }) };
    },
    setInterval: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearInterval: () => {},
  });

  try {
    stats.startSlowLane(999, 1);
    await fallbackStarted;
    // Hold the fallback after its async LUID lookup begins. The native tick
    // then completes during that await, exercising the final commit check.
    holdFallbackLuid = true;
    releaseFallback();
    await fallbackLuidStarted;
    await intervalCallbacks[1]();
    releaseLuid();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterFallback = await stats.sampleGpuUtilForTarget(target);
    assert.equal(afterFallback.gpuUtilPct, 73);
    assert.equal(afterFallback.gpuUtilSource, 'windows-d3dkmt');
  } finally {
    releaseFallback();
    stats.stopSlowLane(1);
  }
});

test('stopping and restarting telemetry clears the previous native GPU sample', async () => {
  const target = { deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xbb85 } };
  const intervalCallbacks = [];
  const nativeValues = [73, null, 81];
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    ...target,
    d3dkmtGpuUtil: {
      sample: async () => nativeValues.shift() ?? null,
      reset: () => {},
    },
    execFile: async () => ({ stdout: JSON.stringify({ gpuEng: [] }) }),
    setInterval: (fn) => { intervalCallbacks.push(fn); return intervalCallbacks.length; },
    clearInterval: () => {},
  });

  stats.startSlowLane(999, 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await stats.sampleGpuUtilForTarget(target)).gpuUtilPct, 73);

  stats.stopSlowLane(1);
  assert.equal((await stats.sampleGpuUtilForTarget(target)).gpuUtilPct, null);

  stats.startSlowLane(999, 2);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await stats.sampleGpuUtilForTarget(target)).gpuUtilPct, null, 'restart waits for a fresh native pair');

  await intervalCallbacks[3]();
  assert.equal((await stats.sampleGpuUtilForTarget(target)).gpuUtilPct, 81);
  stats.stopSlowLane(2);
});

test('stopping telemetry prevents a blocked fallback lookup from committing', async () => {
  const target = { deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xbb85 } };
  let releaseLuid;
  const luidGate = new Promise((resolve) => { releaseLuid = resolve; });
  let fallbackLuidStartedResolve;
  const fallbackLuidStarted = new Promise((resolve) => { fallbackLuidStartedResolve = resolve; });
  let holdFallbackLuid = false;
  let fallbackStartedResolve;
  const fallbackStarted = new Promise((resolve) => { fallbackStartedResolve = resolve; });
  let releaseFallbackRows;
  const fallbackRowsGate = new Promise((resolve) => { releaseFallbackRows = resolve; });
  const stats = createSysStats({
    enableDedicatedGpuSampler: true,
    ...target,
    d3dkmtGpuUtil: { sample: async () => null, reset: () => {} },
    luidOf: async () => {
      if (holdFallbackLuid) {
        holdFallbackLuid = false;
        fallbackLuidStartedResolve();
        await luidGate;
      }
      return target.osLuid;
    },
    execFile: async (_exe, args) => {
      const command = String(args?.[3] ?? '');
      if (command.includes('Get-Counter')) {
        fallbackStartedResolve();
        await fallbackRowsGate;
        return { stdout: JSON.stringify({ gpuEng: [{
          Name: 'pid_1_luid_0x00000000_0x0000bb85_phys_0_eng_0_engtype_3d',
          UtilizationPercentage: 12,
        }] }) };
      }
      return { stdout: JSON.stringify({
        cpu: { PercentProcessorTime: 0, PercentProcessorPerformance: 100 },
        maxClockMhz: 1000,
        thermal: [],
        msaThermal: [],
        gpuMem: [],
        gpuEng: [],
        powerMeter: [],
      }) };
    },
    setInterval: (fn) => ({ fn }),
    clearInterval: () => {},
  });

  stats.startSlowLane(999, 1);
  await fallbackStarted;
  holdFallbackLuid = true;
  releaseFallbackRows();
  await fallbackLuidStarted;
  stats.stopSlowLane(1);
  releaseLuid();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const afterStop = await stats.sampleGpuUtilForTarget(target);
  assert.equal(afterStop.gpuUtilPct, null);
  assert.equal(afterStop.gpuUtilSource, null);
});
