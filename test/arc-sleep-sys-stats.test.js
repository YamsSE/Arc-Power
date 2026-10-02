import assert from 'node:assert/strict';
import test from 'node:test';
import { createSysStats } from '../src/main/sys-stats.js';

test('Arc Sleep receives only live CPU and fresh active-adapter GPU utilization', async (t) => {
  let clock = 1000;
  let cpuValue = 37;
  let resolveGpuSample;
  const gpuSampled = new Promise((resolve) => { resolveGpuSample = resolve; });
  const stats = createSysStats({
    deviceIdHex: '0xE20B',
    osLuid: { high: 0, low: 0xbb85 },
    enableDedicatedGpuSampler: true,
    usePersistentGpuSampler: false,
    now: () => clock,
    cpuUtilReader: { async read() { return cpuValue; } },
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
  assert.deepEqual(await stats.sampleArcSleepSignals(), { cpuUtilPct: 37, gpuUtilPct: 73 });

  clock += 5001;
  cpuValue = null;
  assert.deepEqual(await stats.sampleArcSleepSignals(), { cpuUtilPct: null, gpuUtilPct: null });
});
