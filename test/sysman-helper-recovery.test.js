import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createSysmanHelperProxy } from '../src/main/sysman/helper-proxy.js';

const tempDirs = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

class FakeSocket extends EventEmitter {
  acknowledgeShutdown = true;
  setEncoding() {}
  write(data) {
    const message = JSON.parse(String(data).trim());
    if (message.op === 'shutdown' && this.acknowledgeShutdown) {
      queueMicrotask(() => this.emit('data', `${JSON.stringify({ id: message.id, ok: true })}\n`));
    }
    return true;
  }
  destroy() { this.emit('close'); }
}

class FakeChild extends EventEmitter {
  exitCode = null;
  signalCode = null;
  killCalls = 0;
  constructor(pid) { super(); this.pid = pid; }
  unref() {}
  kill() { this.killCalls += 1; return true; }
}

function makeTimers() {
  const timers = [];
  return {
    timers,
    setTimeoutFn(fn, ms) {
      const timer = { fn, ms, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutFn(timer) {
      const index = timers.indexOf(timer);
      if (index >= 0) timers.splice(index, 1);
    },
    async fireNext() {
      const timer = timers.shift();
      assert.ok(timer, 'expected a scheduled heal timer');
      timer.fn();
      for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
      return timer;
    },
  };
}

function makeHarness({ connectFn, spawnFn, ...overrides }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sysman-recovery-'));
  tempDirs.push(dir);
  const timers = makeTimers();
  const proxy = createSysmanHelperProxy({
    appPath: dir,
    tempDir: () => dir,
    sweep: async () => 0,
    connectFn,
    spawnFn,
    sleep: async () => {},
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
    debugLogPath: () => path.join(dir, 'debug.log'),
    connectRetryCapMs: 20,
    ...overrides,
  });
  return { proxy, timers, dir };
}

function markReady(socket) {
  socket.emit('data', `${JSON.stringify({ type: 'ready' })}\n`);
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('native helper exit heals by spawning a fresh process and sanitizes only the child environment', async () => {
  const originalKeys = Object.keys(process.env);
  const legacyKey = originalKeys.find((key) => key.toUpperCase() === 'ZES_ENABLE_SYSMAN');
  const originalValue = legacyKey === undefined ? undefined : process.env[legacyKey];
  process.env.zes_enable_sysman = '1';
  const children = [];
  const spawnOptions = [];
  let phase = 'initial';
  let healCalls = 0;
  const sockets = [new FakeSocket()];
  let connects = 0;
  const h = makeHarness({
    connectFn: async () => {
      connects += 1;
      if (phase === 'initial') throw new Error('pipe unavailable');
      healCalls += 1;
      if (healCalls === 1) throw new Error('pipe unavailable');
      return sockets[1] ??= new FakeSocket();
    },
    spawnFn: async (_cmd, _args, options) => {
      spawnOptions.push(options);
      const child = new FakeChild(100 + children.length);
      children.push(child);
      return child;
    },
    healDelayMs: 1,
    connectRetryCapMs: 5,
    sleep: async () => (phase === 'initial'
      ? new Promise((resolve) => setTimeout(resolve, 1))
      : Promise.resolve()),
  });
  try {
    const warming = h.proxy.warm();
    while (children.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(children.length, 1);
    const parentFlagKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'ZES_ENABLE_SYSMAN');
    assert.ok(parentFlagKey);
    assert.equal(process.env[parentFlagKey], '1');
    assert.equal(Object.keys(spawnOptions[0].env).some((key) => key.toUpperCase() === 'ZES_ENABLE_SYSMAN'), false);
    assert.equal(spawnOptions[0].env.ELECTRON_RUN_AS_NODE, '1');
    const parentPathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH');
    const childPathKey = Object.keys(spawnOptions[0].env).find((key) => key.toUpperCase() === 'PATH');
    assert.equal(spawnOptions[0].env[childPathKey], process.env[parentPathKey]);
    const spawnEvent = fs.readFileSync(path.join(h.dir, 'debug.log'), 'utf8').split('\n')
      .filter(Boolean).map((line) => JSON.parse(line)).find((event) => event.event === 'child-spawn');
    assert.equal(spawnEvent.inheritedLegacySysmanFlag, true);
    assert.deepEqual(Object.keys(spawnEvent).sort(), ['event', 'inheritedLegacySysmanFlag', 'ts']);

    children[0].emit('exit', 3221226505, null);
    await warming;
    phase = 'heal';
    await h.timers.fireNext();
    assert.equal(children.length, 2);
    assert.equal(healCalls, 2);
  } finally {
    await h.proxy.shutdown();
    if (legacyKey === undefined) delete process.env.zes_enable_sysman;
    else {
      delete process.env.zes_enable_sysman;
      process.env[legacyKey] = originalValue;
    }
  }
});

test('a heal that joins a failing connect sweep re-arms after the shared latch clears', async () => {
  let releaseBlockedConnect;
  let connects = 0;
  let phase = 'initial';
  let retryConnects = 0;
  const children = [];
  const socket = new FakeSocket();
  const h = makeHarness({
    connectRetryCapMs: 5,
    connectFn: async () => {
      connects += 1;
      if (phase === 'initial' && connects === 2) {
        await new Promise((resolve) => { releaseBlockedConnect = resolve; });
        throw new Error('connect sweep ended');
      }
      if (phase === 'initial') throw new Error('pipe unavailable');
      retryConnects += 1;
      if (retryConnects === 1) throw new Error('pipe unavailable');
      return socket;
    },
    spawnFn: async () => {
      const child = new FakeChild(200 + children.length);
      children.push(child);
      return child;
    },
    healDelayMs: 1,
  });
  try {
    const warming = h.proxy.warm();
    await flush();
    assert.equal(children.length, 1);
    children[0].emit('exit', 3221226505, null);
    await h.timers.fireNext(); // joins the in-flight connect promise
    assert.equal(connects, 2);
    await new Promise((resolve) => setTimeout(resolve, 15));
    releaseBlockedConnect();
    await warming;
    phase = 'retry';
    await flush();
    assert.equal(h.timers.timers.length, 1, 'failed shared heal must arm a follow-up timer');
    await h.timers.fireNext();
    assert.equal(children.length, 2, 'the retry starts a fresh helper process');
    assert.equal(retryConnects, 2);
  } finally {
    releaseBlockedConnect?.();
    await h.proxy.shutdown();
  }
});

test('child errors heal, while intentional shutdown suppresses exit, error, and socket-close recovery', async () => {
  const children = [];
  const sockets = [new FakeSocket(), new FakeSocket()];
  let connects = 0;
  const h = makeHarness({
    connectFn: async () => {
      connects += 1;
      if (connects % 2 === 1) throw new Error('pipe unavailable');
      return sockets[connects === 2 ? 0 : 1];
    },
    spawnFn: async () => {
      const child = new FakeChild(300 + children.length);
      children.push(child);
      return child;
    },
  });
  await h.proxy.warm();
  sockets[0].emit('close');
  children[0].emit('error', new Error('native child failure'));
  assert.equal(h.timers.timers.length, 1);
  await h.timers.fireNext();
  assert.equal(children.length, 2);
  await h.proxy.shutdown();
  children[1].emit('error', new Error('shutdown race'));
  children[1].emit('exit', 3221226505, null);
  sockets[1].emit('close');
  assert.equal(h.timers.timers.length, 0);
});

test('shutdown timeout terminates only the detached helper spawned by this proxy', async () => {
  const ownedChild = new FakeChild(325);
  let ownedSocket;
  let ownedConnects = 0;
  const owned = makeHarness({
    connectFn: async () => {
      ownedConnects += 1;
      if (ownedConnects === 1) throw new Error('pipe unavailable before the owned helper starts');
      ownedSocket ??= new FakeSocket();
      return ownedSocket;
    },
    spawnFn: async () => ownedChild,
    shutdownBoundMs: 1,
    sleep: async () => {},
  });
  await owned.proxy.warm();
  markReady(ownedSocket);
  ownedSocket.acknowledgeShutdown = false;
  await owned.proxy.shutdown();
  assert.equal(ownedChild.killCalls, 1, 'an owned child is reaped if it does not answer explicit shutdown');

  const reusedSocket = new FakeSocket();
  reusedSocket.acknowledgeShutdown = false;
  let reusedSpawnCalls = 0;
  const reused = makeHarness({
    connectFn: async () => reusedSocket,
    spawnFn: async () => { reusedSpawnCalls += 1; throw new Error('a reused helper must not be spawned again'); },
    shutdownBoundMs: 1,
    sleep: async () => {},
  });
  await reused.proxy.warm();
  markReady(reusedSocket);
  await reused.proxy.shutdown();
  assert.equal(reusedSpawnCalls, 0, 'shutdown timeout does not invent ownership of a reused helper');
});

test('successful shutdown ack cancels the child-termination deadline', async () => {
  const ownedChild = new FakeChild(326);
  let ownedSocket;
  let ownedConnects = 0;
  const h = makeHarness({
    connectFn: async () => {
      ownedConnects += 1;
      if (ownedConnects === 1) throw new Error('pipe unavailable before the owned helper starts');
      ownedSocket ??= new FakeSocket();
      return ownedSocket;
    },
    spawnFn: async () => ownedChild,
    shutdownBoundMs: 15,
  });
  await h.proxy.warm();
  markReady(ownedSocket);
  await h.proxy.shutdown();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(ownedChild.killCalls, 0, 'a late timeout must not kill a helper after a successful shutdown ack');
});

test('shutdown during a pending connect prevents a late helper respawn', async () => {
  let releaseConnect;
  let connects = 0;
  const children = [];
  const h = makeHarness({
    connectFn: async () => {
      connects += 1;
      if (connects === 1) throw new Error('pipe unavailable');
      await new Promise((resolve) => { releaseConnect = resolve; });
      throw new Error('pipe unavailable after shutdown');
    },
    spawnFn: async () => {
      const child = new FakeChild(350 + children.length);
      children.push(child);
      return child;
    },
    connectRetryCapMs: 100,
  });
  try {
    const warming = h.proxy.warm();
    while (!releaseConnect) await new Promise((resolve) => setImmediate(resolve));
    children[0].emit('exit', 3221226505, null);
    await h.timers.fireNext();
    await h.proxy.shutdown();
    releaseConnect();
    await warming;
    await flush();
    assert.equal(children.length, 1);
    assert.equal(h.timers.timers.length, 0);
  } finally {
    releaseConnect?.();
    await h.proxy.shutdown();
  }
});

test('repeated heal-spawn deaths switch to the bounded backoff cadence', async () => {
  const children = [];
  const firstSocket = new FakeSocket();
  let sockets = [firstSocket, new FakeSocket()];
  let connects = 0;
  const h = makeHarness({
    connectFn: async () => {
      connects += 1;
      if (connects % 2 === 1) throw new Error('pipe unavailable');
      return sockets.shift();
    },
    spawnFn: async () => {
      const child = new FakeChild(400 + children.length);
      children.push(child);
      return child;
    },
    maxConsecutiveHealSpawns: 1,
    healDelayMs: 7,
    healBackoffDelayMs: 19,
  });
  try {
    await h.proxy.warm();
    children[0].emit('exit', 3221226505, null);
    // The current socket is still live, so close it to model process death.
    // The connect sweep then launches the first heal-spawn.
    firstSocket.emit('close');
    const first = await h.timers.fireNext();
    assert.equal(first.ms, 7);
    assert.equal(children.length, 2);
    children[1].emit('exit', null, 'SIGTERM');
    assert.equal(h.timers.timers[0].ms, 19);
  } finally {
    await h.proxy.shutdown();
  }
});

test('a ready helper restores the fast heal cadence without clearing the rolling failure breaker', async () => {
  const children = [];
  const sockets = [];
  let failConnect = true;
  const h = makeHarness({
    maxConsecutiveHealSpawns: 1,
    maxHelperFailuresInWindow: 3,
    healDelayMs: 5,
    healBackoffDelayMs: 19,
    connectFn: async () => {
      if (failConnect) {
        failConnect = false;
        throw new Error('pipe unavailable');
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    spawnFn: async () => {
      const child = new FakeChild(450 + children.length);
      children.push(child);
      return child;
    },
  });
  try {
    await h.proxy.warm();
    markReady(sockets[0]);
    sockets[0].emit('close');
    failConnect = true;
    await h.timers.fireNext(); // first heal-spawn, connected to a helper that already owns the pipe
    assert.equal(children.length, 2);
    children[1].emit('exit', 2, null);
    assert.equal(h.timers.timers[0].ms, 19, 'the consecutive heal-spawn counter selects slow cadence');
    markReady(sockets[1]);
    await h.timers.fireNext(); // existing healthy helper makes the old backoff timer a no-op
    sockets[1].emit('close');
    assert.equal(h.timers.timers[0].ms, 5, 'ready restores fast cadence');

    // Readiness resets only the cadence counter: all three distinct native
    // failures still trip the independent rolling session breaker.
    children[0].emit('exit', -1073740791, null);
    children[1].emit('error', new Error('native fail-fast'));
    // Exercise a third distinct child through the same event wiring by using
    // a fresh helper spawn after firing the queued heal.
    failConnect = true;
    await h.timers.fireNext();
    assert.equal(children.length, 3);
    children[2].emit('exit', 3221226505, null);
    assert.equal(h.timers.timers.length, 0, 'the rolling breaker remains tripped after ready');
  } finally {
    await h.proxy.shutdown();
  }
});

test('three abnormal child crashes within five minutes stop automatic recovery for this session', async () => {
  let now = 0;
  const children = [];
  const sockets = [];
  let nextConnectFails = true;
  const h = makeHarness({
    nowFn: () => now,
    helperFailureWindowMs: 5 * 60 * 1000,
    maxHelperFailuresInWindow: 3,
    healDelayMs: 5,
    connectFn: async () => {
      if (nextConnectFails) {
        nextConnectFails = false;
        throw new Error('pipe unavailable');
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    spawnFn: async () => {
      const child = new FakeChild(500 + children.length);
      children.push(child);
      return child;
    },
  });
  try {
    await h.proxy.warm();
    markReady(sockets[0]);
    for (let failure = 0; failure < 2; failure += 1) {
      now += 15000;
      children[failure].emit('exit', -1073740791, null); // signed 0xC0000409 fail-fast
      sockets[failure].emit('close');
      nextConnectFails = true;
      await h.timers.fireNext();
      assert.equal(children.length, failure + 2);
      markReady(sockets[failure + 1]);
    }
    now += 15000;
    children[2].emit('exit', 3221226505, null); // unsigned 0xC0000409 fail-fast
    await h.proxy.warm();
    assert.equal(children.length, 3, 'opening the breaker preserves an already connected helper');
    sockets[2].emit('close');
    assert.equal(h.timers.timers.length, 0, 'opening the breaker cancels queued recovery');
    await h.proxy.warm();
    await flush();
    assert.equal(children.length, 3, 'warm/reconnect paths cannot spawn after the breaker opens');
    assert.equal(h.timers.timers.length, 0);
  } finally {
    await h.proxy.shutdown();
  }
});

test('child error and exit for one process count once; code 77 and clean bind-loser exits are excluded', async () => {
  const children = [];
  const sockets = [];
  let failNextConnect = true;
  const h = makeHarness({
    maxHelperFailuresInWindow: 1,
    healDelayMs: 5,
    connectFn: async () => {
      if (failNextConnect) {
        failNextConnect = false;
        throw new Error('pipe unavailable');
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    spawnFn: async () => {
      const child = new FakeChild(600 + children.length);
      children.push(child);
      return child;
    },
  });
  try {
    await h.proxy.warm();
    children[0].emit('error', new Error('native child failure'));
    children[0].emit('exit', 3221226505, null);
    assert.equal(h.timers.timers.length, 0, 'the error opens the one-failure test breaker');
    assert.equal(fs.readFileSync(path.join(h.dir, 'debug.log'), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line)).filter((event) => event.event === 'recovery-stopped').length, 1);
  } finally {
    await h.proxy.shutdown();
  }

  const excludedChildren = [];
  let excludedFirstConnect = true;
  const excluded = makeHarness({
    maxHelperFailuresInWindow: 1,
    connectFn: async () => {
      if (excludedFirstConnect) {
        excludedFirstConnect = false;
        throw new Error('pipe unavailable');
      }
      return new FakeSocket();
    },
    spawnFn: async () => {
      const child = new FakeChild(700 + excludedChildren.length);
      excludedChildren.push(child);
      return child;
    },
  });
  try {
    await excluded.proxy.warm();
    excludedChildren[0].emit('exit', 77, null);
    excludedChildren[0].emit('exit', 0, null);
    assert.equal(fs.readFileSync(path.join(excluded.dir, 'debug.log'), 'utf8').includes('recovery-stopped'), false);
  } finally {
    await excluded.proxy.shutdown();
  }
});

test('a breaker opening during a deferred connect prevents the later child spawn', async () => {
  const children = [];
  const sockets = [];
  let connects = 0;
  let releaseDeferredConnect;
  let holdNextConnect = false;
  const h = makeHarness({
    maxHelperFailuresInWindow: 1,
    healDelayMs: 5,
    connectFn: async () => {
      connects += 1;
      if (connects === 1) throw new Error('pipe unavailable');
      if (holdNextConnect) {
        holdNextConnect = false;
        await new Promise((resolve) => { releaseDeferredConnect = resolve; });
        throw new Error('pipe became unavailable');
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    spawnFn: async () => {
      const child = new FakeChild(800 + children.length);
      children.push(child);
      return child;
    },
  });
  try {
    await h.proxy.warm();
    assert.equal(children.length, 1);
    sockets[0].emit('close');
    holdNextConnect = true;
    const warming = h.proxy.warm();
    while (!releaseDeferredConnect) await new Promise((resolve) => setImmediate(resolve));
    children[0].emit('exit', 3221226505, null);
    releaseDeferredConnect();
    await warming;
    await flush();
    assert.equal(children.length, 1, 'spawn is refused after the breaker opens during connectFn');
    assert.equal(h.timers.timers.length, 0, 'opening the breaker cancels automatic recovery');
  } finally {
    releaseDeferredConnect?.();
    await h.proxy.shutdown();
  }
});

test('failure-window configuration seams require positive finite integers and a clock function', () => {
  for (const [key, value] of [
    ['helperFailureWindowMs', 0],
    ['helperFailureWindowMs', Infinity],
    ['maxHelperFailuresInWindow', 1.5],
    ['maxHelperFailuresInWindow', -1],
    ['nowFn', 5],
  ]) {
    assert.throws(() => createSysmanHelperProxy({ [key]: value }), TypeError);
  }
});
