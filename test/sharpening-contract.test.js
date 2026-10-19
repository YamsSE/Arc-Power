import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeGraphicsSettings } from '../src/main/ipc-core.js';
import { normalizeGameGpuProfile, mergeGameGpuProfilePatch } from '../src/main/store/game-profile-store.js';

test('global sharpening IPC accepts exact integer percentages and rejects malformed nested values', () => {
  assert.deepEqual(sanitizeGraphicsSettings({ sharpening: { enabled: false, percentage: 37 } }), { sharpening: { enabled: false, percentage: 37 } });
  for (const value of [
    { enabled: 1, percentage: 50 },
    { enabled: true, percentage: 50.5 },
    { enabled: true, percentage: -1 },
    { enabled: true, percentage: 101 },
    { enabled: true, percentage: 50, extra: true },
  ]) assert.throws(() => sanitizeGraphicsSettings({ sharpening: value }), /sharpening must be/);
});

test('sharpening validation preserves the existing precompiled-shader setting', () => {
  assert.deepEqual(sanitizeGraphicsSettings({ prebuiltShaderDownload: true }), { prebuiltShaderDownload: true });
  assert.deepEqual(sanitizeGraphicsSettings({ prebuiltShaderDownload: false }), { prebuiltShaderDownload: false });
  assert.deepEqual(sanitizeGraphicsSettings({
    prebuiltShaderDownload: true,
    sharpening: { enabled: false, percentage: 42 },
  }), {
    prebuiltShaderDownload: true,
    sharpening: { enabled: false, percentage: 42 },
  });
});

test('game sharpening persists per GPU and omitted patches preserve existing values', () => {
  const a = normalizeGameGpuProfile({ deviceKey: 'gpu-a', graphics: { sharpening: { enabled: true, percentage: 71 } } });
  const b = normalizeGameGpuProfile({ deviceKey: 'gpu-b', graphics: {} });
  assert.deepEqual(a.graphics.sharpening, { enabled: true, percentage: 71 });
  assert.equal(Object.hasOwn(b.graphics, 'sharpening'), false);
  const updated = mergeGameGpuProfilePatch(a, { graphics: { lowLatency: 'on' } });
  assert.deepEqual(updated.graphics.sharpening, { enabled: true, percentage: 71 });
  assert.equal(Object.hasOwn(b.graphics, 'sharpening'), false);
});
