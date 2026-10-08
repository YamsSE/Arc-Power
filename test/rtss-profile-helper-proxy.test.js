import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRtssProfileHelperProxy } from '../src/main/rtss-profile-helper-proxy.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stdin = {
      writes: [],
      write: (line) => { this.stdin.writes.push(JSON.parse(line)); },
      end: () => {},
    };
    this.killed = false;
  }

  kill() { this.killed = true; }

  respond(index, result, state = { available: true, configured: true, renderingMode: 'vector2d', executablePath: 'C:\\RTSS\\RTSS.exe', error: null }) {
    const request = this.stdin.writes[index];
    this.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: request.id, result, state })}\n`));
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeProxy({ timeoutMs = 1000, getRuntime } = {}) {
  const child = new FakeChild();
  let spawnCount = 0;
  const proxy = createRtssProfileHelperProxy({
    entryPath: 'C:\\ArcPower\\rtss-profile-helper-entry.js',
    getRuntime: getRuntime ?? (async () => ({ executablePath: 'C:\\RTSS\\RTSS.exe', isRunning: true })),
    spawnFn: () => { spawnCount += 1; return child; },
    timeoutMs,
  });
  return { proxy, child, get spawnCount() { return spawnCount; } };
}

test('RTSS helper proxy sends one request at a time and passes fresh runtime state', async () => {
  const { proxy, child } = makeProxy({
    getRuntime: async () => ({ executablePath: 'D:\\Tools\\RTSS\\RTSS.exe', isRunning: true }),
  });
  const first = proxy.applyFrameLimit({ enabled: true, value: 90 });
  const second = proxy.getFrameLimit();
  await tick();
  assert.equal(child.stdin.writes.length, 1);
  assert.deepEqual(child.stdin.writes[0].runtime, {
    executablePath: 'D:\\Tools\\RTSS\\RTSS.exe',
    isRunning: true,
  });
  assert.equal(child.stdin.writes[0].method, 'applyFrameLimit');
  child.respond(0, { ok: true, used: true });
  assert.deepEqual(await first, { ok: true, used: true });
  await tick();
  assert.equal(child.stdin.writes.length, 2);
  assert.equal(child.stdin.writes[1].method, 'getFrameLimit');
  child.respond(1, { ok: true, limit: 90 });
  assert.deepEqual(await second, { ok: true, limit: 90 });
});

test('RTSS helper timeout kills worker, resolves callers, and never respawns or sends later calls', async () => {
  const fixture = makeProxy({ timeoutMs: 15 });
  const { proxy, child } = fixture;
  const first = proxy.applyFrameLimit({ enabled: true, value: 120 });
  await tick();
  const firstResult = await first;
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.source, 'rtss');
  assert.equal(firstResult.errorCode, 'unavailable');
  assert.match(firstResult.error, /timed out/i);
  assert.equal(child.killed, true);

  const restoreResult = await proxy.restoreFrameLimitState({ expectedState: {}, state: {} });
  assert.equal(restoreResult.ok, false);
  assert.equal(restoreResult.errorCode, 'unavailable');

  const secondResult = await proxy.getFrameLimit();
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.available, false);
  assert.equal(fixture.spawnCount, 1);
  assert.equal(child.stdin.writes.length, 1);
});

test('unexpected RTSS helper exit resolves active and queued calls and disables the session worker', async () => {
  const fixture = makeProxy();
  const { proxy, child } = fixture;
  const active = proxy.applyFrameLimit({ enabled: true, value: 144 });
  const queued = proxy.getFrameLimitOwnership();
  await tick();
  assert.equal(child.stdin.writes.length, 1);
  child.emit('exit', 1, null);

  const activeResult = await active;
  const queuedResult = await queued;
  assert.equal(activeResult.ok, false);
  assert.equal(activeResult.source, 'rtss');
  assert.equal(activeResult.errorCode, 'unavailable');
  assert.equal(queuedResult.ok, false);
  assert.equal(queuedResult.errorCode, 'unavailable');
  assert.match(proxy.getState().error, /exited unexpectedly/i);
  assert.equal((await proxy.applyFrameLimit({ enabled: false })).ok, false);
  assert.equal(fixture.spawnCount, 1);
  assert.equal(child.stdin.writes.length, 1);
});

test('RTSS helper getState returns the latest cached child state synchronously', async () => {
  const { proxy, child } = makeProxy();
  assert.deepEqual(proxy.getState(), {
    available: false,
    configured: false,
    renderingMode: 'unknown',
    executablePath: null,
    error: null,
  });
  const read = proxy.getFrameLimit();
  await tick();
  const state = { available: true, configured: false, renderingMode: 'unknown', executablePath: 'C:\\RTSS\\RTSS.exe', error: null };
  child.respond(0, { ok: true, limit: 60 }, state);
  assert.deepEqual(await read, { ok: true, limit: 60 });
  assert.deepEqual(proxy.getState(), state);
});

test('RTSS helper close kills a hung worker without waiting and is terminal', async () => {
  const fixture = makeProxy({ timeoutMs: 1000 });
  const { proxy, child } = fixture;
  const pending = proxy.restoreFrameLimit('restore-token');
  await tick();
  proxy.close();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(child.killed, true);
  assert.equal(proxy.isTerminal(), true);
  assert.equal((await proxy.getFrameLimit()).ok, false);
  assert.equal(fixture.spawnCount, 1);
});
