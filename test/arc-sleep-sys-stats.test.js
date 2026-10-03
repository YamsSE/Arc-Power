import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createSysStats, processUsesGpuFor3d } from '../src/main/sys-stats.js';

const engine = (pid, low, utilPct, type = '3D') => ({
  name: `pid_${pid}_luid_0x00000000_0x${low.toString(16).padStart(8, '0')}_phys_0_eng_0_engtype_${type}`,
  utilPct,
});

test('foreground process requires meaningful selected-GPU 3D usage', () => {
  const selected = { high: 0, low: 0xbb85 };
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 12)], 42, selected), true);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 12)], 43, selected), false);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb86, 12)], 42, selected), false);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 0.3)], 42, selected), false);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 5)], 42, selected), false);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 12, 'Copy')], 42, selected), false);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 12), engine(42, 0xbb86, 25)], 42, selected), false);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 12), engine(42, 0xbb86, 12)], 42, selected), false);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 12), engine(42, 0xbb86, 9)], 42, selected), false);
  assert.equal(processUsesGpuFor3d([engine(42, 0xbb85, 25), engine(42, 0xbb86, 12)], 42, selected), true);
});

test('Arc Sleep foreground GPU proof expires with worker rows', async (t) => {
  let clock = 1000;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = () => {};
  const stats = createSysStats({
    deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xbb85 },
    enableDedicatedGpuSampler: true,
    spawn: () => child,
    execFile: async () => ({ stdout: '{}' }),
    now: () => clock,
    setInterval: () => 1,
    clearInterval: () => {},
  });
  t.after(() => stats.stopSlowLane());
  assert.equal(await stats.isArcSleepProcessOnActiveGpu(42), false);
  stats.startSlowLane(1000, 1);
  child.stdout.write(`${JSON.stringify({ gpuEng: [{ Name: engine(42, 0xbb85, 12).name, UtilizationPercentage: 12 }] })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await stats.isArcSleepProcessOnActiveGpu(42), true);
  clock += 3001;
  assert.equal(await stats.isArcSleepProcessOnActiveGpu(42), false);
});

test('Arc Sleep receives fresh active-adapter GPU utilization without reading CPU load', async (t) => {
  let clock = 1000;
  let cpuReads = 0;
  let resolveGpuSample;
  const gpuSampled = new Promise((resolve) => { resolveGpuSample = resolve; });
  const stats = createSysStats({
    deviceIdHex: '0xE20B',
    osLuid: { high: 0, low: 0xbb85 },
    enableDedicatedGpuSampler: true,
    usePersistentGpuSampler: false,
    now: () => clock,
    cpuUtilReader: { async read() { cpuReads += 1; return 100; } },
    d3dkmtGpuUtil: {
      async sample() {
        resolveGpuSample();
        return 73;
      },
      reset() {},
    },
    execFile: async () => ({ stdout: JSON.stringify({ gpuEng: [] }) }),
    setInterval: () => 1,
    clearInterval: () => {},
  });
  t.after(() => stats.stopSlowLane());

  stats.startSlowLane(1000, 1);
  await gpuSampled;
  // Let the dedicated sample finish committing into the selected record.
  await new Promise((resolve) => setTimeout(resolve, 0));
  const readsBeforeArcSleep = cpuReads;
  assert.deepEqual(await stats.sampleArcSleepSignals(), { gpuUtilPct: 73 });
  assert.equal(cpuReads, readsBeforeArcSleep);

  clock += 5001;
  assert.deepEqual(await stats.sampleArcSleepSignals(), { gpuUtilPct: null });
  assert.equal(cpuReads, readsBeforeArcSleep);
});
