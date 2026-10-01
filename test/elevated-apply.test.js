import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplyRunner, parseWindowsBootSessionIdOutput, sweepStaleWorkerFiles, TOKEN_TTL_MS } from '../src/main/elevated-apply.js';
import { writeWorkerResult } from '../src/main/apply-worker.js';

test('Windows boot-session parser accepts CIM decimal ticks and rejects nonnumeric output', () => {
  const ticks = '639262936115000000';
  assert.equal(parseWindowsBootSessionIdOutput(`\r\n${ticks}\r\n`), ticks);
  assert.equal(parseWindowsBootSessionIdOutput(''), null);
  assert.equal(parseWindowsBootSessionIdOutput('warning\\r\\n639262936115000000'), null);
});

test('elevated apply and reset workers serialize per physical GPU', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-tuning-queue-test-'));
  const events = [];
  let activeWorkers = 0;
  let maxActiveWorkers = 0;
  try {
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => directory,
      quarantineDirectory: directory,
      systemBootSessionId: async () => 'test-boot-session',
      workerTimeoutMs: 2000,
      inProcess: {},
      spawnFn: async (_command, _args, options) => {
        const requestName = fsSync.readdirSync(directory).find((name) => name.startsWith('arcpower-req-'));
        assert.ok(requestName, 'the authenticated worker request should exist before spawn');
        const request = JSON.parse(fsSync.readFileSync(path.join(directory, requestName), 'utf8'));
        const quarantineName = fsSync.readdirSync(directory).find((name) => name.startsWith('arcpower-tuning-quarantine-'));
        assert.ok(quarantineName, 'the durable tuning lock should exist before an elevated worker starts');
        const quarantine = JSON.parse(fsSync.readFileSync(path.join(directory, quarantineName), 'utf8'));
        assert.equal(quarantine.requestId, request.requestId, 'the worker must own the reservation it will release');
        assert.equal(quarantine.status, 'in-flight');
        const outputPath = path.join(directory, `arcpower-out-${request.requestId}.json`);
        activeWorkers += 1;
        maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
        events.push(`start:${request.op}`);

        let exitHandler = null;
        let exited = false;
        const complete = async () => {
          await writeWorkerResult(outputPath, {
            requestId: request.requestId,
            op: request.op,
            ok: true,
            perControl: {},
            state: { deviceId: request.deviceId },
          }, options.env.RID_ARC_POWER_WORKER_SECRET);
          activeWorkers -= 1;
          events.push(`end:${request.op}`);
          if (exitHandler) exitHandler(0);
          else exited = true;
        };
        setTimeout(() => { void complete(); }, 15);
        return {
          on(event, handler) {
            if (event === 'exit') {
              exitHandler = handler;
              if (exited) exitHandler(0);
            }
            return this;
          },
          kill() {},
        };
      },
    });

    const target = { deviceKey: 'pci:0x00008086:0x0000e20b@3:0.0' };
    await Promise.all([
      runner.apply({ deviceId: 0, deviceKey: target.deviceKey, physicalTarget: target, settings: {} }),
      runner.apply({ deviceId: 0, deviceKey: target.deviceKey, physicalTarget: target, settings: {} }),
      runner.reset(0, target.deviceKey, target),
    ]);

    assert.equal(maxActiveWorkers, 1);
    assert.deepEqual(events, [
      'start:apply', 'end:apply',
      'start:apply', 'end:apply',
      'start:reset', 'end:reset',
    ]);
    assert.equal(fsSync.readdirSync(directory).some((name) => name.startsWith('arcpower-tuning-quarantine-')), false,
      'the durable lock should be removed after each worker is known to have exited');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('timed-out elevated apply leaves a revocation marker for a late worker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-elevated-test-'));
  let spawnOptions = null;
  let killed = false;
  let markerVisibleAtKill = false;
  try {
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => directory,
      workerTimeoutMs: 10,
      inProcess: { graphicsApply: async () => ({ ok: true, perControl: {}, graphicsState: null }) },
      spawnFn: async (_command, _args, options) => {
        spawnOptions = options;
        return {
          on() { return this; },
           kill() {
             markerVisibleAtKill = fsSync.readdirSync(directory).some((file) => file.startsWith('arcpower-cancel-'));
             killed = true;
           },
        };
      },
    });
    await assert.rejects(
      runner.graphicsApply({ deviceId: 0, settings: {} }),
      /administrator approval/,
    );
    assert.equal(killed, true);
    assert.equal(markerVisibleAtKill, true, 'timeout must publish revocation before killing the wrapper');
    assert.equal(typeof spawnOptions?.env?.RID_ARC_POWER_WORKER_SECRET, 'string');
    const files = await fs.readdir(directory);
    const cancelFile = files.find((file) => file.startsWith('arcpower-cancel-'));
    assert.ok(cancelFile, 'the parent must leave cancellation visible after killing only the wrapper');
    const marker = JSON.parse(await fs.readFile(path.join(directory, cancelFile), 'utf8'));
    assert.equal(typeof marker.cancelledAt, 'number');
    assert.equal(files.some((file) => file.startsWith('arcpower-req-')), false);
    assert.equal(files.some((file) => file.startsWith('arcpower-tok-')), false);

    const removed = await sweepStaleWorkerFiles(directory, {
      now: marker.cancelledAt + TOKEN_TTL_MS + 1,
    });
    assert.equal(removed, 1);
    assert.deepEqual(await fs.readdir(directory), []);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('elevated apply rejects an unsigned or mismatched worker result', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-elevated-auth-test-'));
  try {
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => directory,
      workerTimeoutMs: 1000,
      inProcess: { graphicsApply: async () => ({ ok: true, perControl: {}, graphicsState: null }) },
      spawnFn: async (_command, _args) => ({
        on(event, handler) {
          if (event === 'exit') {
            const request = fsSync.readdirSync(directory).find((file) => file.startsWith('arcpower-req-'));
            assert.ok(request);
            const requestId = request.slice('arcpower-req-'.length, -'.json'.length);
            const output = `arcpower-out-${requestId}.json`;
            fsSync.writeFileSync(path.join(directory, output), JSON.stringify({
              requestId,
              op: 'graphics-apply',
              ok: true,
              perControl: {},
            }), 'utf8');
            handler(0);
          }
          return this;
        },
        kill() {},
      }),
    });
    await assert.rejects(
      runner.graphicsApply({ deviceId: 0, settings: {} }),
      /administrator approval/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('timed-out elevated apply ignores a result that races in after revocation', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-elevated-late-result-test-'));
  try {
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => directory,
      workerTimeoutMs: 10,
      inProcess: { graphicsApply: async () => ({ ok: true, perControl: {}, graphicsState: null }) },
      spawnFn: async (_command, _args) => ({
        on() { return this; },
        kill() {
          const output = fsSync.readdirSync(directory).find((file) => file.startsWith('arcpower-out-'));
          assert.ok(output, 'the output path must already be allocated before timeout cancellation');
          fsSync.writeFileSync(path.join(directory, output), JSON.stringify({ ok: true, perControl: {} }), 'utf8');
        },
      }),
    });
    await assert.rejects(
      runner.graphicsApply({ deviceId: 0, settings: {} }),
      /administrator approval/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('timed-out apply keeps revocation when only the PowerShell wrapper exits', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-elevated-wrapper-exit-test-'));
  let exitHandler = null;
  try {
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => directory,
      workerTimeoutMs: 10,
      inProcess: { graphicsApply: async () => ({ ok: true, perControl: {}, graphicsState: null }) },
      spawnFn: async () => ({
        on(event, handler) {
          if (event === 'exit') exitHandler = handler;
          return this;
        },
        kill() {
          // Simulate Start-Process exiting while its RunAs child is still
          // detached. The parent must keep revocation visible in this case.
          exitHandler?.(0);
        },
      }),
    });
    await assert.rejects(
      runner.graphicsApply({ deviceId: 0, settings: {} }),
      /administrator approval/,
    );
    const files = await fs.readdir(directory);
    const cancelFile = files.find((file) => file.startsWith('arcpower-cancel-'));
    assert.ok(cancelFile, 'wrapper exit must not remove the detached worker revocation marker');
    const marker = JSON.parse(await fs.readFile(path.join(directory, cancelFile), 'utf8'));
    const removed = await sweepStaleWorkerFiles(directory, { now: marker.cancelledAt + TOKEN_TTL_MS + 1 });
    assert.ok(removed >= 1);
    assert.equal((await fs.readdir(directory)).some((file) => file.startsWith('arcpower-cancel-')), false);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an apply timeout after native entry quarantines that GPU across app runner restarts', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-tuning-quarantine-test-'));
  let spawnCount = 0;
  let nativeEntered = false;
  let currentBootSessionId = 'test-boot-session-a';
  const makeRunner = () => createApplyRunner({
    isElevated: () => false,
    tmpdir: () => directory,
    quarantineDirectory: directory,
    workerTimeoutMs: 10,
    systemBootSessionId: async () => currentBootSessionId,
    inProcess: {},
    spawnFn: async () => {
      spawnCount += 1;
      nativeEntered = true;
      // Model a worker blocked inside a native GPU call after entering apply.
      // Killing the PowerShell wrapper does not stop this simulated child.
      return { on() { return this; }, kill() {} };
    },
  });
  const target = {
    deviceId: 0,
    deviceKey: 'pci:0x00008086:0x000056c0@3:0.0',
    physicalTarget: { deviceKey: 'pci:0x00008086:0x000056c0@3:0.0' },
    settings: { vfCurve: [] },
  };

  try {
    const firstRunner = makeRunner();
    await assert.rejects(firstRunner.apply(target), /Restart Windows before applying or resetting this GPU/);
    assert.equal(nativeEntered, true);
    assert.equal(spawnCount, 1);

    await assert.rejects(firstRunner.reset(0, target.deviceKey, target.physicalTarget), /Restart Windows/);
    assert.equal(spawnCount, 1, 'reset must not start while the timed-out worker may still be running');

    const relaunchedRunner = makeRunner();
    await assert.rejects(relaunchedRunner.apply(target), /Restart Windows/);
    assert.equal(spawnCount, 1, 'the quarantine must survive an Arc Power process restart');

    currentBootSessionId = 'test-boot-session-b';
    const afterWindowsRestart = makeRunner();
    await assert.rejects(afterWindowsRestart.apply(target), /Restart Windows/);
    assert.equal(spawnCount, 2, 'a new Windows boot clears the stale quarantine before starting a new worker');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('an incomplete persisted tuning quarantine fails closed', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-invalid-quarantine-test-'));
  const deviceKey = 'pci:0x00008086:0x000056c0@3:0.0';
  const transactionKey = `tuning:${deviceKey}`;
  const fileKey = createHash('sha256').update(transactionKey).digest('hex');
  const markerPath = path.join(directory, `arcpower-tuning-quarantine-${fileKey}.json`);
  let spawnCount = 0;
  try {
    await fs.writeFile(markerPath, JSON.stringify({}), 'utf8');
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => directory,
      quarantineDirectory: directory,
      systemBootSessionId: async () => 'test-boot-session',
      inProcess: {},
      spawnFn: async () => {
        spawnCount += 1;
        return { on() { return this; }, kill() {} };
      },
    });
    await assert.rejects(runner.apply({ deviceId: 0, deviceKey, settings: {} }), /Restart Windows/);
    assert.equal(spawnCount, 0, 'an invalid safety marker must block the native worker');
    assert.equal(await fs.readFile(markerPath, 'utf8'), '{}', 'an invalid marker must not be silently deleted');
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('a failed Windows boot-session lookup is retried before the next tuning worker', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-boot-session-retry-test-'));
  let lookupCount = 0;
  let spawnCount = 0;
  try {
    const runner = createApplyRunner({
      isElevated: () => false,
      tmpdir: () => directory,
      quarantineDirectory: directory,
      systemBootSessionId: async () => {
        lookupCount += 1;
        return lookupCount === 1 ? null : 'test-boot-session';
      },
      inProcess: {},
      spawnFn: async (_command, _args, options) => {
        spawnCount += 1;
        const requestName = fsSync.readdirSync(directory).find((name) => name.startsWith('arcpower-req-'));
        const request = JSON.parse(fsSync.readFileSync(path.join(directory, requestName), 'utf8'));
        const outputPath = path.join(directory, `arcpower-out-${request.requestId}.json`);
        await writeWorkerResult(outputPath, {
          requestId: request.requestId,
          op: request.op,
          ok: true,
          perControl: {},
          state: { deviceId: request.deviceId },
        }, options.env.RID_ARC_POWER_WORKER_SECRET);
        return { on(event, handler) { if (event === 'exit') queueMicrotask(() => handler(0)); return this; }, kill() {} };
      },
    });
    const request = { deviceId: 0, deviceKey: 'pci:0x00008086:0x000056c0@3:0.0', settings: {} };

    await assert.rejects(runner.apply(request), /could not verify the Windows boot session/);
    assert.equal(spawnCount, 0, 'an unknown boot session prevents the native worker from starting');
    const result = await runner.apply(request);
    assert.equal(result.result.ok, true);
    assert.equal(lookupCount, 2, 'the null boot-session result must not be cached for the runner lifetime');
    assert.equal(spawnCount, 1);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
