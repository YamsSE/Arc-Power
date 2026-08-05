// M2C-C — apply-worker contract tests: the request/result file round trip,
// the honest result envelope (requestId/op/ok/perControl/state/error), the
// worker never spawning anything (electron-free by construction — the runner
// tests pin the spawn side), and the invalid-request paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runApplyWorker, findStaleSiblingToken } from '../src/main/apply-worker.js';
import { MockBackend, createMockOldIgcl } from '../src/main/backend/mock-backend.js';

function testDir(name) {
  return path.join(os.tmpdir(), `arcpower-worker-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

async function readJson(p) {
  return JSON.parse(await fs.promises.readFile(p, 'utf8'));
}

test('worker: apply round trip — result file carries requestId/op/ok/perControl/state', async () => {
  const dir = testDir('apply');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({
      requestId: 'req-1', op: 'apply', deviceId: 0,
      settings: { powerLimitW: 220, gpuFreqOffsetMhz: 50 },
    }));
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 0, 'exit 0 = result written');
    const result = await readJson(outPath);
    assert.equal(result.requestId, 'req-1');
    assert.equal(result.op, 'apply');
    assert.equal(result.ok, true);
    assert.equal(result.perControl.powerLimitW.ok, true);
    assert.equal(result.perControl.gpuFreqOffsetMhz.ok, true);
    assert.equal(result.state.powerLimitW, 220);
    assert.equal(result.error, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker: extended values route through the bundled-2023-runtime mock in the worker too', async () => {
  const dir = testDir('extended');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({
      requestId: 'req-2', op: 'apply', deviceId: 0, settings: { powerLimitW: 300 },
    }));
    const backend = new MockBackend({ extendedRanges: true });
    await backend.restoreWaiverState(0, true);
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 0);
    const result = await readJson(outPath);
    assert.equal(result.ok, true);
    assert.equal(result.state.powerLimitW, 300, 'the worker reads back the persisted value');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker: an apply failure is an HONEST result (ok:false + perControl), exit 0 — the parent reads it', async () => {
  const dir = testDir('fail');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({
      requestId: 'req-3', op: 'apply', deviceId: 0, settings: { powerLimitW: 220 },
    }));
    const backend = new MockBackend();
    backend.injectFail('powerLimitW', 'io-failed');
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 0, 'exit 0 even for an apply failure — the result file is the truth');
    const result = await readJson(outPath);
    assert.equal(result.ok, false);
    assert.equal(result.perControl.powerLimitW.ok, false);
    assert.match(result.perControl.powerLimitW.message, /The GPU driver refused the change\. \(io-failed\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker: waiver-accept op seeds nothing but accepts on the device', async () => {
  const dir = testDir('waiver');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({ requestId: 'req-4', op: 'waiver-accept', deviceId: 0 }));
    const backend = new MockBackend();
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 0);
    const result = await readJson(outPath);
    assert.equal(result.ok, true);
    assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker: reset op resets defaults and returns the verified state', async () => {
  const dir = testDir('reset');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({ requestId: 'req-5', op: 'reset', deviceId: 0 }));
    const backend = new MockBackend();
    await backend.applySettings(0, { powerLimitW: 240 });
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 0);
    const result = await readJson(outPath);
    assert.equal(result.ok, true);
    assert.equal(result.state.powerLimitW, 210);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker: an unreadable request file writes an honest error result', async () => {
  const dir = testDir('unreadable');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'missing.json');
    const outPath = path.join(dir, 'out.json');
    const backend = new MockBackend();
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 1);
    const result = await readJson(outPath);
    assert.equal(result.ok, false);
    assert.match(result.error, /request unreadable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('worker: malformed requests are rejected (bad deviceId, bad op, bad settings)', async () => {
  for (const req of [
    { requestId: 'x', op: 'apply', deviceId: -1, settings: {} },
    { requestId: 'x', op: 'apply', deviceId: 1.5, settings: {} },
    { requestId: 'x', op: 'explode', deviceId: 0 },
    { requestId: 'x', op: 'apply', deviceId: 0, settings: 'nope' },
    { requestId: 'x', op: 'apply', deviceId: 0, settings: { evil: 1 } },
  ]) {
    const dir = testDir('bad');
    fs.mkdirSync(dir, { recursive: true });
    try {
      const reqPath = path.join(dir, 'req.json');
      const outPath = path.join(dir, 'out.json');
      await fs.promises.writeFile(reqPath, JSON.stringify(req));
      const backend = new MockBackend();
      const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
      assert.equal(code, 1, JSON.stringify(req));
      const result = await readJson(outPath);
      assert.equal(result.ok, false, JSON.stringify(req));
      assert.equal(typeof result.error, 'string');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('worker: closes the backend and the old runtime after the run (no leaks)', async () => {
  const dir = testDir('close');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({ requestId: 'r', op: 'apply', deviceId: 0, settings: {} }));
    let closed = 0;
    const backend = {
      init: async () => {}, close: async () => { closed += 1; },
      restoreWaiverState: async () => {},
      getCapabilities: async () => ({ ranges: {} }),
      getCurrentSettings: async () => ({}),
      applySettings: async () => ({ ok: true, perControl: {} }),
    };
    const oldIgcl = { close: async () => { closed += 10; } };
    await runApplyWorker({ reqPath, outPath, backend, oldIgcl, log: () => {} });
    assert.equal(closed, 11, 'backend.close() + oldIgcl.close() both ran');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S2: a delegation request carrying waiverAccepted succeeds against a backend that was NEVER seeded', async () => {
  const dir = testDir('s2-never-seeded');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({
      requestId: 'req-s2', op: 'apply', deviceId: 0,
      settings: { powerLimitW: 220 },
      waiverAccepted: true, // the parent's flag rides in the request
    }));
    const backend = new MockBackend(); // never seeded — the worker must not fail on the waiver
    assert.equal((await backend.getCapabilities(0)).waiverAccepted, false);
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 0);
    const result = await readJson(outPath);
    assert.equal(result.ok, true, 'the worker restores the flag from the request and applies');
    assert.equal(result.perControl.powerLimitW.ok, true);
    assert.equal((await backend.getCapabilities(0)).waiverAccepted, true, 'the worker-side flag is set for its own caps');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: the worker refuses to run when a stale sibling token exists (the parent gave up)', async () => {
  const dir = testDir('m2-stale');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({ requestId: 'req-x', op: 'apply', deviceId: 0, settings: { powerLimitW: 220 } }));
    await fs.promises.writeFile(path.join(dir, 'arcpower-tok-req-x.json'),
      JSON.stringify({ requestId: 'req-x', expiresAt: Date.now() - 1000 })); // expired
    const backend = new MockBackend();
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 1, 'refusal = exit 1');
    const result = await readJson(outPath);
    assert.equal(result.ok, false);
    assert.match(result.error, /request superseded/);
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210, 'the apply never ran');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2: a FRESH sibling token does not block the worker (the parent is alive)', async () => {
  const dir = testDir('m2-fresh');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({ requestId: 'req-y', op: 'apply', deviceId: 0, settings: { powerLimitW: 220 } }));
    await fs.promises.writeFile(path.join(dir, 'arcpower-tok-req-y.json'),
      JSON.stringify({ requestId: 'req-y', expiresAt: Date.now() + 600000 })); // live
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 0);
    const result = await readJson(outPath);
    assert.equal(result.ok, true, 'a live token = the parent is waiting, apply proceeds');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M2/M1: findStaleSiblingToken — only THIS request\'s expired token blocks', async () => {
  const dir = testDir('m2-find');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const now = Date.now();
    assert.equal(await findStaleSiblingToken(dir, 'a', now), null, 'empty dir -> none');
    await fs.promises.writeFile(path.join(dir, 'arcpower-tok-a.json'), JSON.stringify({ requestId: 'a', expiresAt: now - 1 }));
    assert.equal(path.basename(await findStaleSiblingToken(dir, 'a', now)), 'arcpower-tok-a.json');
    await fs.promises.writeFile(path.join(dir, 'arcpower-tok-b.json'), JSON.stringify({ requestId: 'b', expiresAt: now + 1000 }));
    await fs.promises.writeFile(path.join(dir, 'arcpower-tok-c.json'), 'not json');
    assert.equal(path.basename(await findStaleSiblingToken(dir, 'a', now)), 'arcpower-tok-a.json', 'still the only stale one for THIS request');
    assert.equal(await findStaleSiblingToken(dir, 'b', now), null, 'a FRESH token for this request -> no block');
    assert.equal(await findStaleSiblingToken(dir, 'a', now - 10000), null, 'before any expiry -> none');
    assert.equal(await findStaleSiblingToken(dir, 'b', now - 10000), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: a FOREIGN expired token does not block this request (per-requestId guard)', async () => {
  const dir = testDir('m1-foreign');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({ requestId: 'req-mine', op: 'apply', deviceId: 0, settings: { powerLimitW: 220 } }));
    // A crashed OTHER parent's leftover: expired, but for a DIFFERENT request.
    await fs.promises.writeFile(path.join(dir, 'arcpower-tok-other.json'),
      JSON.stringify({ requestId: 'req-other', expiresAt: Date.now() - 1000 }));
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 0, 'a foreign expired token must NOT supersede this request');
    const result = await readJson(outPath);
    assert.equal(result.ok, true);
    assert.equal(result.state.powerLimitW, 220, 'the apply landed despite the foreign leftover');
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 220);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M1: an expired token for THIS request blocks the worker even with a foreign leftover present', async () => {
  const dir = testDir('m1-own');
  fs.mkdirSync(dir, { recursive: true });
  try {
    const reqPath = path.join(dir, 'req.json');
    const outPath = path.join(dir, 'out.json');
    await fs.promises.writeFile(reqPath, JSON.stringify({ requestId: 'req-own', op: 'apply', deviceId: 0, settings: { powerLimitW: 220 } }));
    await fs.promises.writeFile(path.join(dir, 'arcpower-tok-own.json'),
      JSON.stringify({ requestId: 'req-own', expiresAt: Date.now() - 1000 })); // expired, THIS request
    await fs.promises.writeFile(path.join(dir, 'arcpower-tok-foreign.json'),
      JSON.stringify({ requestId: 'req-foreign', expiresAt: Date.now() - 1000 })); // expired, foreign
    const backend = new MockBackend();
    const code = await runApplyWorker({ reqPath, outPath, backend, oldIgcl: createMockOldIgcl(backend), log: () => {} });
    assert.equal(code, 1, 'the matching expired token must still refuse the run');
    const result = await readJson(outPath);
    assert.equal(result.ok, false);
    assert.match(result.error, /request superseded/);
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210, 'the apply never ran');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
