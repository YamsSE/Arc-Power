import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { buildSysStatsScript, buildSysStatsWorkerScript, createSysStats } from '../src/main/sys-stats.js';

const output = (freq = 100) => JSON.stringify({
  cpu: { PercentProcessorTime: 12, PercentProcessorPerformance: freq },
  maxClockMhz: 1000,
  thermal: [],
  msaThermal: [],
  gpuMem: [],
  gpuEng: [],
  powerMeter: [],
});

function fakeChild(onRequest = () => {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = {
    write(line, callback) {
      callback?.(null);
      onRequest(String(line).trim(), child);
      return true;
    },
  };
  child.kill = () => {
    child.emit('close', 0);
  };
  return child;
}

test('system-stats worker wraps the existing query in a flushed line protocol', () => {
  const worker = buildSysStatsWorkerScript({ includeGpuEngine: false });
  assert.match(worker, /\[Console\]::In\.ReadLine\(\)/);
  assert.match(worker, /\$query = \{/);
  assert.match(worker, /\$request \+ \[char\]9 \+ \$payload/);
  assert.match(worker, /\[Console\]::Out\.Flush\(\)/);
  assert.ok(worker.includes(buildSysStatsScript({ includeGpuEngine: false })));
});

test('active slow lane reuses one persistent worker and stop is idempotent', async () => {
  const children = [];
  let oneShotCalls = 0;
  const stats = createSysStats({
    spawn: (_exe, args, options) => {
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
      assert.match(args[3], /ReadLine/);
      const child = fakeChild((id, process) => {
        process.stdout.write(`${id}\t${output()}\n`);
      });
      children.push(child);
      return child;
    },
    execFile: async () => { oneShotCalls += 1; return { stdout: output() }; },
    setInterval: () => 1,
    clearInterval: () => {},
  });

  stats.startSlowLane(999, 10);
  stats.startSlowLane(999, 10);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sample = await stats.sampleSlow();
  assert.equal(sample.cpuFreqMhz, 1000);
  assert.equal(children.length, 1);
  assert.equal(oneShotCalls, 0);
  stats.stopSlowLane(10);
  stats.stopSlowLane(10);
});

test('late system-stats worker output after stop cannot commit or trigger fallback', async () => {
  let child;
  let oneShotCalls = 0;
  const stats = createSysStats({
    spawn: () => (child = fakeChild()),
    execFile: async () => { oneShotCalls += 1; return { stdout: output(200) }; },
    setInterval: () => 1,
    clearInterval: () => {},
  });
  stats.startSlowLane(999, 11);
  const pendingSample = stats.sampleSlow();
  await new Promise((resolve) => setImmediate(resolve));
  stats.stopSlowLane(11);
  const sample = await pendingSample;
  child.stdout.write('1\t' + output(200) + '\n');
  assert.equal(sample.cpuFreqMhz, null);
  assert.equal(oneShotCalls, 0);
});

test('worker startup failure falls back to the one-shot system-stats query', async () => {
  let oneShotCalls = 0;
  const stats = createSysStats({
    spawn: () => { throw new Error('spawn denied'); },
    execFile: async () => { oneShotCalls += 1; return { stdout: output(125) }; },
    setInterval: () => 1,
    clearInterval: () => {},
  });
  stats.startSlowLane(999, 12);
  await new Promise((resolve) => setTimeout(resolve, 10));
  const sample = await stats.sampleSlow();
  assert.equal(sample.cpuFreqMhz, 1250);
  assert.ok(oneShotCalls >= 1);
  stats.stopSlowLane(12);
});
test('worker exit during a request falls back and a later sample restarts the worker', async () => {
  let spawnCalls = 0;
  let oneShotCalls = 0;
  let signalFallbackCompleted;
  const fallbackCompleted = new Promise((resolve) => { signalFallbackCompleted = resolve; });
  const stats = createSysStats({
    spawn: () => {
      spawnCalls += 1;
      const child = fakeChild((id, process) => {
        if (spawnCalls === 1) {
          setImmediate(() => process.emit('close', 1));
        } else {
          process.stdout.write(`${id}\t${output(150)}\n`);
        }
      });
      return child;
    },
    execFile: async () => {
      oneShotCalls += 1;
      try { return { stdout: output(125) }; }
      finally { signalFallbackCompleted(); }
    },
    setInterval: () => 1,
    clearInterval: () => {},
  });
  stats.startSlowLane(999, 13);
  await fallbackCompleted;
  await new Promise((resolve) => setImmediate(resolve));
  const sample = await stats.sampleSlow();
  assert.equal(sample.cpuFreqMhz, 1500);
  assert.equal(spawnCalls, 2);
  assert.equal(oneShotCalls, 1);
  stats.stopSlowLane(13);
});
