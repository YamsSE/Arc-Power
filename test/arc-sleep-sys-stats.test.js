import assert from 'node:assert/strict';
import test from 'node:test';
import { createSysStats } from '../src/main/sys-stats.js';

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
