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

test('Arc Sleep Fast eligibility uses fresh one-shot rows after GPU worker failure', async (t) => {
  let clock = 1000;
  const intervals = [];
  let output = JSON.stringify({ gpuEng: [{ Name: engine(42, 0xbb85, 12).name, UtilizationPercentage: 12 }] });
  const stats = createSysStats({
    deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xbb85 },
    enableDedicatedGpuSampler: true,
    spawn: () => { throw new Error('worker unavailable'); },
    execFile: async () => ({ stdout: output }),
    now: () => clock,
    setInterval: (callback) => { intervals.push(callback); return intervals.length; },
    clearInterval: () => {},
  });
  t.after(() => stats.stopSlowLane());
  stats.startSlowLane(1000, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(await stats.isArcSleepProcessOnActiveGpu(42), true);
  assert.equal(await stats.isArcSleepProcessOnActiveGpu(43), false);

  output = '{}';
  clock += 1000;
  await intervals[1]();
  assert.equal(await stats.isArcSleepProcessOnActiveGpu(42), true,
    'malformed fallback output must not renew or replace the prior sample');
  clock += 2001;
  assert.equal(await stats.isArcSleepProcessOnActiveGpu(42), false);

  output = JSON.stringify({ gpuEng: [{ Name: engine(42, 0xbb86, 20).name, UtilizationPercentage: 20 }] });
  await intervals[1]();
  assert.equal(await stats.isArcSleepProcessOnActiveGpu(42), false,
    'a process on another GPU cannot qualify for the FPS cap seed');
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

test('Arc Sleep GPU sampler lease survives telemetry stop and stops after the last owner releases', (t) => {
  const intervals = [];
  const cleared = [];
  const stats = createSysStats({
    deviceIdHex: '0xE20B', osLuid: { high: 0, low: 0xbb85 },
    enableDedicatedGpuSampler: true,
    usePersistentGpuSampler: false,
    d3dkmtGpuUtil: { async sample() { return 40; }, reset() {} },
    execFile: async () => ({ stdout: JSON.stringify({ gpuEng: [] }) }),
    setInterval: (callback) => { intervals.push(callback); return intervals.length; },
    clearInterval: (id) => cleared.push(id),
  });
  t.after(() => stats.stopSlowLane());

  const releaseArcSleep = stats.acquireArcSleepGpuSampler();
  assert.equal(intervals.length, 1, 'Arc Sleep alone starts the dedicated GPU lane');
  stats.startSlowLane(1000, 1);
  assert.equal(intervals.length, 2, 'telemetry adds its slow stats lane without duplicating GPU sampling');
  stats.stopSlowLane(1);
  assert.equal(cleared.includes(1), false, 'stopping telemetry leaves the Arc Sleep GPU lane running');
  releaseArcSleep();
  assert.equal(cleared.includes(1), true, 'the last lease stops the GPU lane');
  releaseArcSleep();
  assert.equal(cleared.filter((id) => id === 1).length, 1, 'release is idempotent');
});
