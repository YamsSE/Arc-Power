import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDisplayColorStateStore,
  DISPLAY_COLOR_DEFAULTS,
} from '../src/main/backend/display-color-state.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-display-color-state-'));
  const dir = path.join(root, 'DisplayColorSettings');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir, store: createDisplayColorStateStore({ dir }) };
}

function recordFile(dir, displayKey) {
  const digest = createHash('sha256').update(displayKey, 'utf8').digest('hex');
  return path.join(dir, `${digest}.json`);
}

test('missing display record returns unsent defaults without creating a directory or file', async (t) => {
  const { dir, store } = fixture(t);
  assert.deepEqual(await store.read('adapter|monitor-A'), {
    ok: true,
    values: DISPLAY_COLOR_DEFAULTS,
    sent: { hueSaturation: false, brightnessContrast: false },
  });
  assert.equal(fs.existsSync(dir), false);
});

test('memory-only store persists each group independently', async () => {
  const store = createDisplayColorStateStore({ dir: null });
  assert.equal((await store.read('display-a')).sent.hueSaturation, false);
  assert.deepEqual(await store.saveGroup('display-a', 'hueSaturation', { hue: 24, saturation: 1.2 }), {
    ok: true,
    values: { hue: 24, saturation: 1.2, brightness: 0, contrast: 1 },
    sent: { hueSaturation: true, brightnessContrast: false },
  });
  assert.deepEqual(await store.saveGroup('display-a', 'brightnessContrast', { brightness: 18, contrast: 1.4 }), {
    ok: true,
    values: { hue: 24, saturation: 1.2, brightness: 18, contrast: 1.4 },
    sent: { hueSaturation: true, brightnessContrast: true },
  });
  assert.equal((await store.read('display-b')).values.hue, 0);
});

test('separate store instances reread and merge the current on-disk record', async (t) => {
  const { dir, store } = fixture(t);
  const second = createDisplayColorStateStore({ dir });
  assert.equal((await store.saveGroup('physical-output', 'hueSaturation', { hue: -32, saturation: 0.8 })).ok, true);
  assert.equal((await second.saveGroup('physical-output', 'brightnessContrast', { brightness: -20, contrast: 1.6 })).ok, true);
  assert.deepEqual(await store.read('physical-output'), {
    ok: true,
    values: { hue: -32, saturation: 0.8, brightness: -20, contrast: 1.6 },
    sent: { hueSaturation: true, brightnessContrast: true },
  });
});

test('display keys are hashed into separate files and records bind to the exact identity', async (t) => {
  const { dir, store } = fixture(t);
  await store.saveGroup('adapter|monitor-A', 'hueSaturation', { hue: 5, saturation: 1 });
  await store.saveGroup('adapter|monitor-B', 'hueSaturation', { hue: 75, saturation: 1 });
  assert.notEqual(recordFile(dir, 'adapter|monitor-A'), recordFile(dir, 'adapter|monitor-B'));
  assert.equal((await store.read('adapter|monitor-A')).values.hue, 5);
  assert.equal((await store.read('adapter|monitor-B')).values.hue, 75);
  const raw = JSON.parse(fs.readFileSync(recordFile(dir, 'adapter|monitor-A'), 'utf8'));
  raw.displayKey = 'adapter|monitor-B';
  fs.writeFileSync(recordFile(dir, 'adapter|monitor-A'), JSON.stringify(raw));
  assert.equal((await store.read('adapter|monitor-A')).ok, false);
});

test('invalid groups, extra keys, nonfinite, out-of-range, and off-step values are rejected without mutation', async (t) => {
  const { store } = fixture(t);
  const invalid = [
    ['unknown', { hue: 1 }],
    ['hueSaturation', { hue: 2, saturation: 1, brightness: 0 }],
    ['hueSaturation', { hue: Number.NaN, saturation: 1 }],
    ['hueSaturation', { hue: 181, saturation: 1 }],
    ['hueSaturation', { hue: 1, saturation: 1.01 }],
    ['brightnessContrast', { brightness: 1, contrast: 1 }],
    ['brightnessContrast', { brightness: 0, contrast: Infinity }],
  ];
  for (const [group, values] of invalid) {
    assert.equal((await store.saveGroup('display', group, values)).ok, false);
  }
  assert.deepEqual((await store.read('display')).values, DISPLAY_COLOR_DEFAULTS);
});

test('corrupt, unknown-field, oversized and linked records fail closed', async (t) => {
  const { dir, store } = fixture(t);
  const key = 'display';
  const file = recordFile(dir, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, '{broken');
  assert.equal((await store.read(key)).ok, false);

  fs.writeFileSync(file, JSON.stringify({ version: 1, displayKey: key, values: { ...DISPLAY_COLOR_DEFAULTS, extra: 1 }, sent: { hueSaturation: false, brightnessContrast: false } }));
  assert.equal((await store.read(key)).ok, false);

  fs.writeFileSync(file, 'x'.repeat(16 * 1024 + 1));
  assert.equal((await store.read(key)).ok, false);

  fs.rmSync(file);
  const linkedTarget = path.join(dir, 'target.json');
  fs.writeFileSync(linkedTarget, JSON.stringify({ version: 1, displayKey: key, values: DISPLAY_COLOR_DEFAULTS, sent: { hueSaturation: false, brightnessContrast: false } }));
  fs.linkSync(linkedTarget, file);
  assert.equal((await store.read(key)).ok, false);
  assert.equal((await store.saveGroup(key, 'hueSaturation', { hue: 10, saturation: 1 })).ok, false);
});

test('invalid range records and linked settings directories fail closed', async (t) => {
  const { dir, store } = fixture(t);
  const key = 'display';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(recordFile(dir, key), JSON.stringify({ version: 1, displayKey: key, values: { ...DISPLAY_COLOR_DEFAULTS, contrast: 2.5 }, sent: { hueSaturation: false, brightnessContrast: false } }));
  assert.equal((await store.read(key)).ok, false);

  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-display-color-link-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const real = path.join(parent, 'real');
  const link = path.join(parent, 'linked');
  fs.mkdirSync(real);
  try { fs.symlinkSync(real, link, 'junction'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return;
    throw error;
  }
  const linkedStore = createDisplayColorStateStore({ dir: link });
  assert.equal((await linkedStore.read('display')).ok, false);
  assert.equal((await linkedStore.saveGroup('display', 'hueSaturation', { hue: 10, saturation: 1 })).ok, false);
});
