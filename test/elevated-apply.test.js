import test from 'node:test';
import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApplyRunner, sweepStaleWorkerFiles, TOKEN_TTL_MS } from '../src/main/elevated-apply.js';

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
