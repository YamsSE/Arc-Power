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
