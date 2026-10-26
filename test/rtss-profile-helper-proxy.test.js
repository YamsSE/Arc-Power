import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRtssProfileHelperProxy } from '../src/main/rtss-profile-helper-proxy.js';

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
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

function makeProxy({ timeoutMs = 1000, getRuntime, log } = {}) {
  const child = new FakeChild();
  let spawnCount = 0;
  let spawnOptions = null;
  const proxy = createRtssProfileHelperProxy({
    entryPath: 'C:\\ArcPower\\rtss-profile-helper-entry.js',
    getRuntime: getRuntime ?? (async () => ({ executablePath: 'C:\\RTSS\\RTSS.exe', isRunning: true })),
    spawnFn: (_execPath, _args, options) => { spawnCount += 1; spawnOptions = options; return child; },
    timeoutMs,
    log,
  });
  return { proxy, child, get spawnCount() { return spawnCount; }, get spawnOptions() { return spawnOptions; } };
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

test('RTSS helper proxy routes fixed-target sharpening compatibility without caller-supplied profile arguments', async () => {
  const { proxy, child } = makeProxy();
  const pending = proxy.ensureScreenSharpeningCompatibility();
  await tick();
  assert.equal(child.stdin.writes.length, 1);
  assert.equal(child.stdin.writes[0].method, 'ensureScreenSharpeningCompatibility');
  assert.deepEqual(child.stdin.writes[0].args, {});
  const result = { ok: true, available: true, configured: true, profile: 'ArcPower.ScreenSharpen.exe' };
  child.respond(0, result);
  assert.deepEqual(await pending, result);
});

test('RTSS helper starts from the real executable directory for packaged app.asar launches', async () => {
  const child = new FakeChild();
  let options;
  const proxy = createRtssProfileHelperProxy({
    entryPath: 'C:\\Program Files\\Arc Power\\resources\\app.asar\\src\\main\\rtss-profile-helper-entry.js',
    execPath: 'C:\\Program Files\\Arc Power\\Arc Power.exe',
    spawnFn: (_execPath, _args, spawnOptions) => { options = spawnOptions; return child; },
    getRuntime: async () => ({ executablePath: null, isRunning: false }),
  });
  const read = proxy.getFrameLimit();
  await tick();
  assert.equal(options.cwd, 'C:\\Program Files\\Arc Power');
  child.respond(0, { ok: false });
  await read;
  proxy.close();
});

test('RTSS helper timeout kills worker, resolves callers, and never respawns or sends later calls', async () => {
  const logs = [];
  const fixture = makeProxy({ timeoutMs: 15, log: (message) => logs.push(message) });
  const { proxy, child } = fixture;
  const first = proxy.applyFrameLimit({ enabled: true, value: 120 });
  await tick();
  child.stderr.emit('data', Buffer.from('native helper initialization failed: missing RTSSHooks.dll\n'));
  const firstResult = await first;
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.source, 'rtss');
  assert.equal(firstResult.errorCode, 'unavailable');
  assert.match(firstResult.error, /timed out/i);
  assert.match(firstResult.error, /missing RTSSHooks.dll/i);
  assert.match(proxy.getState().error, /missing RTSSHooks.dll/i);
  assert.match(logs[0], /missing RTSSHooks.dll/i);
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
  child.stderr.emit('data', Buffer.from('failed to load RTSSHooks64.dll'));
  child.emit('exit', 1, null);

  const activeResult = await active;
  const queuedResult = await queued;
  assert.equal(activeResult.ok, false);
  assert.equal(activeResult.source, 'rtss');
  assert.equal(activeResult.errorCode, 'unavailable');
  assert.equal(queuedResult.ok, false);
  assert.equal(queuedResult.errorCode, 'unavailable');
  assert.match(proxy.getState().error, /exited unexpectedly/i);
  assert.match(activeResult.error, /RTSSHooks64.dll/i);
  assert.equal((await proxy.applyFrameLimit({ enabled: false })).ok, false);
  assert.equal(fixture.spawnCount, 1);
  assert.equal(child.stdin.writes.length, 1);
});

test('RTSS helper keeps only the final 2 KiB of stderr and reports it on failure', async () => {
  const fixture = makeProxy();
  const { proxy, child } = fixture;
  const pending = proxy.getFrameLimit();
  await tick();
  child.stderr.emit('data', Buffer.from(`${'x'.repeat(4096)}tail diagnostic`));
  child.emit('exit', 1, null);
  const result = await pending;
  assert.equal(result.ok, false);
  assert.match(result.error, /tail diagnostic/);
  assert.equal(Buffer.byteLength(proxy.getState().error.split('stderr tail: ')[1]), 2048);
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
  child.stderr.emit('data', Buffer.from('normal shutdown'));
  proxy.close();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(child.killed, true);
  assert.equal(proxy.isTerminal(), true);
  assert.doesNotMatch(result.error, /stderr tail:/);
  assert.equal((await proxy.getFrameLimit()).ok, false);
  assert.equal(fixture.spawnCount, 1);
});
