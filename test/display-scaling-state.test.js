import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createDisplayScalingStateStore } from '../src/main/backend/display-scaling-state.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-display-scaling-state-'));
  const dir = path.join(root, 'DisplayScalingSettings');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, store: createDisplayScalingStateStore({ dir }) };
}

function recordFile(dir, key) {
  return path.join(dir, `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`);
}

const selection = { identityScaling: true, nativePreferredScalingType: 4 };
const savedState = { ...selection, customX: null, customY: null };

test('memory-only store retains selection by display key and unknown selection reads null', async () => {
  const store = createDisplayScalingStateStore({ dir: null });
  assert.deepEqual(await store.read('display-a'), { ok: true, state: null });
  assert.deepEqual(await store.saveSelection('display-a', selection), { ok: true, state: savedState });
  assert.deepEqual(await store.read('display-a'), { ok: true, state: savedState });
  assert.deepEqual(await store.read('display-b'), { ok: true, state: null });
});

test('persistent records round-trip across store instances and bind to hashed physical identity', async (t) => {
  const { dir, store } = fixture(t);
  const second = createDisplayScalingStateStore({ dir });
  assert.deepEqual(await store.read('adapter|monitor-a'), { ok: true, state: null });
  assert.deepEqual(await store.saveSelection('adapter|monitor-a', { ...selection, customX: 72, customY: 68 }), {
    ok: true, state: { ...selection, customX: 72, customY: 68 },
  });
  assert.deepEqual(await second.read('adapter|monitor-a'), { ok: true, state: { ...selection, customX: 72, customY: 68 } });
  assert.deepEqual(await second.read('adapter|monitor-b'), { ok: true, state: null });
  assert.equal(fs.existsSync(recordFile(dir, 'adapter|monitor-a')), true);
});

test('saving identity and native preference without custom values preserves remembered custom pair', async (t) => {
  const { store } = fixture(t);
  await store.saveSelection('display', { ...selection, customX: 50, customY: 45 });
  assert.deepEqual(await store.saveSelection('display', { identityScaling: false, nativePreferredScalingType: null }), {
    ok: true, state: { identityScaling: false, nativePreferredScalingType: null, customX: 50, customY: 45 },
  });
});

test('corrupt, wrong-identity, oversized, and linked records fail closed', async (t) => {
  const { dir, store } = fixture(t);
  const key = 'display';
  const file = recordFile(dir, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '{broken');
  assert.equal((await store.read(key)).ok, false);
  fs.writeFileSync(file, JSON.stringify({ version: 1, displayKey: 'other', state: savedState }));
  assert.equal((await store.read(key)).ok, false);
  fs.writeFileSync(file, 'x'.repeat(16 * 1024 + 1));
  assert.equal((await store.read(key)).ok, false);
  fs.rmSync(file);
  const target = path.join(dir, 'target.json');
  fs.writeFileSync(target, JSON.stringify({ version: 1, displayKey: key, state: savedState }));
  fs.linkSync(target, file);
  assert.equal((await store.read(key)).ok, false);
  assert.equal((await store.saveSelection(key, selection)).ok, false);
});

test('invalid absolute directory and linked directory fail closed', async (t) => {
  assert.throws(() => createDisplayScalingStateStore({ dir: 'relative' }), TypeError);
  const { root } = fixture(t);
  const real = path.join(root, 'real');
  const link = path.join(root, 'linked');
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, link, 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return;
    throw error;
  }
  const store = createDisplayScalingStateStore({ dir: link });
  assert.equal((await store.read('display')).ok, false);
  assert.equal((await store.saveSelection('display', selection)).ok, false);
});

test('invalid selections are rejected without mutating the stored state', async (t) => {
  const { store } = fixture(t);
  const invalid = [
    { identityScaling: 1, nativePreferredScalingType: 0 },
    { identityScaling: true, nativePreferredScalingType: 3 },
    { identityScaling: true, nativePreferredScalingType: -1 },
    { identityScaling: true, nativePreferredScalingType: 0, customX: 50 },
    { identityScaling: true, nativePreferredScalingType: 0, customX: 101, customY: 20 },
    { identityScaling: true, nativePreferredScalingType: 0, customX: 20.5, customY: 20 },
    { identityScaling: true, nativePreferredScalingType: 0, unexpected: true },
  ];
  for (const candidate of invalid) assert.equal((await store.saveSelection('display', candidate)).ok, false);
  assert.deepEqual(await store.read('display'), { ok: true, state: null });
});
