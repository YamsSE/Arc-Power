import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createManagedSharpeningControl } from '../src/main/managed-sharpening-control.js';

const digest = 'a'.repeat(64);

function harness(options = {}) {
  let spawnCount = 0;
  const commands = [];
  const children = [];
  const makeChild = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      if (!options.delayedExit) child.emit('exit', null, 'SIGTERM');
      return true;
    };
    child.stdin.on('data', (data) => commands.push(data.toString('ascii')));
    children.push(child);
    return child;
  };
  const hashFile = options.hashFile ?? (async () => digest);
  const control = createManagedSharpeningControl({
    executablePath: 'C:\\bridge.exe', expectedSha256: digest,
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false, nlink: 1 }),
    hashFile,
    spawn: (...args) => { spawnCount += 1; options.onSpawn?.(...args); return makeChild(); },
    requestTimeoutMs: options.requestTimeoutMs ?? 100,
    ...options.controlOptions,
  });
  return { control, get child() { return children[children.length - 1]; }, children, commands, get spawnCount() { return spawnCount; } };
}

function answer(child, id, { status = 0, accepted = 1, applied = 1 } = {}) {
  child.stdout.write(`RESULT ${id} ${status} ${accepted} ${applied}\n`);
}

test('lazily spawns one persistent owner and accepts fragmented results', async () => {
  const h = harness();
  const first = h.control.query({ pid: 42, creationFiletime: '18446744073709551615' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.spawnCount, 1);
  assert.match(h.commands[0], /^QUERY 1 42 18446744073709551615\n$/);
  h.child.stdout.write('RESULT 1 0 3 ');
  h.child.stdout.write('2\n');
  assert.deepEqual(await first, { status: 0, acceptedRevision: 3, appliedRevision: 2 });
  const second = h.control.set({ pid: 42, creationFiletime: '9', revision: 4, enabled: true, percentage: 80 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.spawnCount, 1);
  assert.match(h.commands[1], /^SET 2 42 9 4 1 80\n$/);
  answer(h.child, 2, { status: 2, accepted: 4, applied: 3 });
  assert.deepEqual(await second, { status: 2, acceptedRevision: 4, appliedRevision: 3 });
  await h.control.stop();
});

test('accepts native CRT CRLF while rejecting other control bytes', async () => {
  const h = harness();
  const request = h.control.query({ pid: 1, creationFiletime: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  h.child.stdout.write('RESULT 1 0 1 1\r\n');
  assert.deepEqual(await request, { status: 0, acceptedRevision: 1, appliedRevision: 1 });
  const bad = h.control.query({ pid: 1, creationFiletime: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  h.child.stdout.write('RESULT 2 0 1\r 1\n');
  await assert.rejects(bad);
  await h.control.stop();
});

test('validates input exactly and fails integrity checks before spawn', async () => {
  const h = harness();
  for (const bad of [
    { pid: 1, creationFiletime: '01' }, { pid: 1, creationFiletime: '18446744073709551616' },
    { pid: 1, creationFiletime: '1', extra: true }, { pid: 0, creationFiletime: '1' },
  ]) assert.throws(() => h.control.query(bad));
  assert.throws(() => h.control.set({ pid: 1, creationFiletime: '1', revision: 1, enabled: 1, percentage: 2 }));
  await h.control.stop();

  const badHash = harness({ controlOptions: { hashFile: async () => 'b'.repeat(64) } });
  await assert.rejects(badHash.control.query({ pid: 1, creationFiletime: '1' }), /integrity/);
  assert.equal(badHash.spawnCount, 0);
});

test('unknown, malformed, and oversized responses fail closed and kill only the owner', async () => {
  for (const output of ['RESULT 99 0 1 1\n', 'RESULT x 0 1 1\n', `${'x'.repeat(257)}\n`]) {
    const h = harness();
    const first = h.control.query({ pid: 7, creationFiletime: '3' });
    await new Promise((resolve) => setImmediate(resolve));
    const second = h.control.query({ pid: 8, creationFiletime: '3' });
    await new Promise((resolve) => setImmediate(resolve));
    h.child.stdout.write(output);
    await assert.rejects(first);
    await assert.rejects(second);
    assert.equal(h.child.killed, true);
  }
});

test('timeouts and explicit stop reject every in-flight request', async () => {
  const h = harness({ requestTimeoutMs: 20 });
  const first = h.control.query({ pid: 1, creationFiletime: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = h.control.query({ pid: 2, creationFiletime: '1' });
  await Promise.all([assert.rejects(first, /timed out/), assert.rejects(second, /timed out/)]);
  assert.equal(h.child.killed, true);
  await assert.rejects(h.control.query({ pid: 3, creationFiletime: '1' }), /unavailable/);

  const stopped = harness();
  const inflight = stopped.control.query({ pid: 1, creationFiletime: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  await stopped.control.stop();
  await assert.rejects(inflight, /stopped/);
  await assert.rejects(stopped.control.query({ pid: 1, creationFiletime: '1' }), /unavailable/);
});

test('out-of-order responses are correlated to their pending request IDs', async () => {
  const h = harness();
  const first = h.control.query({ pid: 1, creationFiletime: '1' });
  const second = h.control.query({ pid: 2, creationFiletime: '2' });
  await new Promise((resolve) => setImmediate(resolve));
  answer(h.child, 2, { accepted: 5, applied: 4 });
  answer(h.child, 1, { accepted: 3, applied: 3 });
  assert.deepEqual(await second, { status: 0, acceptedRevision: 5, appliedRevision: 4 });
  assert.deepEqual(await first, { status: 0, acceptedRevision: 3, appliedRevision: 3 });
  await h.control.stop();
});

test('requires an absolute executable path', () => {
  assert.throws(() => createManagedSharpeningControl({ executablePath: 'bridge.exe', expectedSha256: digest }), /configuration/);
});

test('caps pending requests during deferred startup and stop settles startup waiters', async () => {
  let finishHash;
  const h = harness({ hashFile: () => new Promise((resolve) => { finishHash = resolve; }), controlOptions: { maxPending: 2 } });
  const requests = [1, 2, 3].map((pid) => h.control.query({ pid, creationFiletime: '1' }));
  await assert.rejects(requests[2], /request limit/);
  await h.control.stop();
  await Promise.all([assert.rejects(requests[0], /stopped/), assert.rejects(requests[1], /stopped/)]);
  finishHash?.(digest);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.spawnCount, 0);
});

test('guards old child events after explicit restart and fails when the peer exits', async () => {
  const h = harness();
  const request = h.control.query({ pid: 1, creationFiletime: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  const old = h.child;
  old.stdout.write('RESULT 99 0 1 1\n');
  await assert.rejects(request);
  await h.control.resetFailure();
  const next = h.control.query({ pid: 2, creationFiletime: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  const current = h.child;
  assert.notEqual(current, old);
  old.emit('exit', 0, null);
  old.stdout.write('RESULT 1 0 1 1\n');
  assert.equal(h.spawnCount, 2);
  current.emit('exit', 0, null);
  await assert.rejects(next, /exited/);
});

test('stream errors fail closed without an unhandled EPIPE', async () => {
  const h = harness();
  const request = h.control.query({ pid: 1, creationFiletime: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  h.child.stdin.emit('error', new Error('EPIPE'));
  await assert.rejects(request, /EPIPE/);
  await h.control.stop();
});

test('stop stays terminal when it races resetFailure waiting for child exit', async () => {
  const h = harness({ delayedExit: true });
  const request = h.control.query({ pid: 1, creationFiletime: '1' });
  await new Promise((resolve) => setImmediate(resolve));
  const old = h.child;
  old.stdout.write('RESULT 99 0 1 1\n');
  await assert.rejects(request);
  const resetting = h.control.resetFailure();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = h.control.stop();
  old.emit('exit', null, 'SIGTERM');
  await Promise.all([resetting, stopping]);
  await assert.rejects(h.control.query({ pid: 2, creationFiletime: '1' }), /unavailable/);
  assert.equal(h.spawnCount, 1);
});
