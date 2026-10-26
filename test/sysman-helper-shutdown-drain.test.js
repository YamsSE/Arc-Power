import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Duplex } from 'node:stream';
import { test } from 'node:test';
import { runSysmanHelperPipeMode } from '../src/main/sysman/helper-mode.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

class FakeSocket extends Duplex {
  lines = [];
  blockNextWrite = null;
  _read() {}
  _write(chunk, _encoding, callback) {
    const line = String(chunk).trim();
    this.lines.push(JSON.parse(line));
    if (this.blockNextWrite) {
      const release = this.blockNextWrite;
      this.blockNextWrite = null;
      release.resolve();
      release.promise.then(() => callback());
      return;
    }
    callback();
  }
}

class FakeServer extends EventEmitter {
  listen() {}
  close() { this.closed = true; }
  connect(sock) { this.emit('connection', sock); }
}

function harness(createConsumer, { idleMs = 0, shutdownDrainMs } = {}) {
  const server = new FakeServer();
  const done = runSysmanHelperPipeMode({
    createConsumer,
    log() {},
    idleMs,
    ...(shutdownDrainMs === undefined ? {} : { shutdownDrainMs }),
    netModule: { createServer: (cb) => { server.on('connection', cb); return server; } },
  });
  return { server, done };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('shutdown drains active consumer work and its response write before ack and exit', async () => {
  const active = deferred();
  const dispatchWrite = deferred();
  const writeReached = deferred();
  let workReads = 0;
  const { server, done } = harness(() => ({
    readLimits: async (_id, target) => {
      if (target?.probe) return { sustainedW: 1 };
      workReads += 1;
      return active.promise;
    },
    setLimits: async () => ({ ok: true }),
  }));
  const sock = new FakeSocket();
  const queuedSock = new FakeSocket();
  server.connect(sock);
  server.connect(queuedSock);
  await tick();
  sock.push(`${JSON.stringify({ id: 'active', op: 'read' })}\n`);
  await tick();
  sock.blockNextWrite = { resolve: () => writeReached.resolve(), promise: dispatchWrite.promise };
  active.resolve({ sustainedW: 10, burstW: 20 });
  await writeReached.promise;
  assert.ok(sock.blockNextWrite === null, 'the active response write should start');
  queuedSock.push(`${JSON.stringify({ id: 'queued', op: 'read' })}\n`);
  sock.push(`${JSON.stringify({ id: 'stop', op: 'shutdown' })}\n`);
  let exited = false;
  done.then(() => { exited = true; });
  await tick();
  assert.equal(exited, false, 'exit waits for the active response write callback');
  dispatchWrite.resolve();
  await done;
  assert.deepEqual(sock.lines.filter((line) => line.id).map((line) => line.id), ['active', 'stop']);
  assert.equal(sock.lines.find((line) => line.id === 'stop').ok, true);
  assert.equal(workReads, 1, 'shutdown discards queued work and prevents a second consumer call');
  assert.equal(server.closed, true);
  assert.equal(queuedSock.destroyed, true, 'queued peers are closed after the shutdown ack drains');
});

test('shutdown rejects connections raced after the stop transition', async () => {
  const { server, done } = harness(() => ({
    readLimits: async (_id, target) => target?.probe ? { sustainedW: 1 } : { sustainedW: 1 },
    setLimits: async () => ({ ok: true }),
  }));
  const sock = new FakeSocket();
  server.connect(sock);
  await tick();
  sock.push(`${JSON.stringify({ id: 'stop', op: 'shutdown' })}\n`);
  await tick();
  assert.equal(server.closed, true, 'the listener stops accepting as soon as shutdown is handled');

  const racedSock = new FakeSocket();
  server.connect(racedSock);
  assert.equal(racedSock.destroyed, true, 'a connection callback after stopping destroys the new socket');
  assert.equal(await done, 0);
  assert.equal(racedSock.destroyed, true);
  assert.deepEqual(sock.lines.filter((line) => line.id).map((line) => line.id), ['stop']);
});

test('shutdown during consumer initialization waits for the probe to settle', async () => {
  const probe = deferred();
  const { server, done } = harness(() => ({
    readLimits: async () => probe.promise,
    setLimits: async () => ({ ok: true }),
  }));
  const sock = new FakeSocket();
  server.connect(sock);
  sock.push(`${JSON.stringify({ id: 'stop', op: 'shutdown' })}\n`);
  let exited = false;
  done.then(() => { exited = true; });
  await tick();
  assert.equal(exited, false);
  probe.resolve({ sustainedW: 1 });
  assert.equal(await done, 0);
});

test('shutdown watchdog exits when initialization never settles and the client disconnects', async () => {
  const probe = deferred();
  const { server, done } = harness(() => ({
    readLimits: async () => probe.promise,
    setLimits: async () => ({ ok: true }),
  }), { shutdownDrainMs: 10 });
  const sock = new FakeSocket();
  server.connect(sock);
  sock.push(`${JSON.stringify({ id: 'stop', op: 'shutdown' })}\n`);
  await tick();
  sock.destroy();
  assert.equal(await done, 1, 'a permanently pending probe cannot strand the helper after its client disconnects');
  assert.equal(server.closed, true);
  assert.equal(sock.destroyed, true);
});

test('shutdown watchdog exits when an active dispatch never settles', async () => {
  const active = deferred();
  const { server, done } = harness(() => ({
    readLimits: async (_id, target) => target?.probe ? { sustainedW: 1 } : active.promise,
    setLimits: async () => ({ ok: true }),
  }), { shutdownDrainMs: 10 });
  const sock = new FakeSocket();
  server.connect(sock);
  await tick();
  sock.push(`${JSON.stringify({ id: 'read', op: 'read' })}\n`);
  await tick();
  sock.push(`${JSON.stringify({ id: 'stop', op: 'shutdown' })}\n`);
  assert.equal(await done, 1, 'a permanently pending consumer call cannot strand a stopping helper');
  assert.equal(server.closed, true);
  assert.equal(sock.destroyed, true);
});

test('idle timer firing during shutdown drain cannot bypass initialization', async () => {
  const probe = deferred();
  const { server, done } = harness(() => ({
    readLimits: async () => probe.promise,
    setLimits: async () => ({ ok: true }),
  }), { idleMs: 10 });
  const sock = new FakeSocket();
  server.connect(sock);
  sock.push(`${JSON.stringify({ id: 'stop', op: 'shutdown' })}\n`);
  let exited = false;
  done.then(() => { exited = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(exited, false, 'the pending idle timer cannot finish a shutdown drain');
  probe.resolve({ sustainedW: 1 });
  assert.equal(await done, 0);
});

test('shutdown ack write disconnect settles and still completes cleanup', async () => {
  const { server, done } = harness(() => ({
    readLimits: async (_id, target) => target?.probe ? { sustainedW: 1 } : { sustainedW: 1 },
    setLimits: async () => ({ ok: true }),
  }));
  const sock = new FakeSocket();
  server.connect(sock);
  await tick();
  const started = deferred();
  const callbackGate = deferred();
  sock.blockNextWrite = { resolve: () => started.resolve(), promise: callbackGate.promise };
  sock.push(`${JSON.stringify({ id: 'stop', op: 'shutdown' })}\n`);
  await started.promise;
  let exited = false;
  done.then(() => { exited = true; });
  await tick();
  assert.equal(exited, false, 'the shutdown ack write callback is still pending');
  sock.destroy();
  assert.equal(await done, 0);
  assert.equal(server.closed, true);
});
