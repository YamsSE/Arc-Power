import test from 'node:test';
import assert from 'node:assert/strict';
import { restoreWindowState, serializeWindowState } from '../src/main/window-state.js';

const displays = [
  { workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
  { workArea: { x: 1920, y: 0, width: 1280, height: 1000 } },
];

test('restores saved normal bounds and maximized state independently', () => {
  const saved = { version: 1, normalBounds: { x: 2050, y: 40, width: 1100, height: 800 }, maximized: true };
  assert.deepEqual(restoreWindowState(saved, displays), {
    normalBounds: { x: 2050, y: 40, width: 1100, height: 800 }, maximized: true,
  });
});

test('clamps a window from a disconnected display into a current work area', () => {
  const saved = { version: 1, normalBounds: { x: -4000, y: 3000, width: 1600, height: 1200 }, maximized: false };
  assert.deepEqual(restoreWindowState(saved, displays), {
    normalBounds: { x: 0, y: 0, width: 1600, height: 1040 }, maximized: false,
  });
});

test('invalid or missing state retains the established default size', () => {
  assert.deepEqual(restoreWindowState({ version: 2, normalBounds: { x: 8 } }, displays), {
    normalBounds: { x: 0, y: 0, width: 1280, height: 820 }, maximized: false,
  });
});

test('saved size is reduced when the only display work area is smaller', () => {
  const restored = restoreWindowState({
    version: 1, normalBounds: { x: 300, y: 100, width: 1400, height: 900 }, maximized: false,
  }, [{ workArea: { x: 100, y: 50, width: 800, height: 600 } }]);
  assert.deepEqual(restored.normalBounds, { x: 100, y: 50, width: 800, height: 600 });
});

test('serialization stores rounded normal bounds and a separate maximize flag', () => {
  assert.deepEqual(serializeWindowState({ x: -20.3, y: 10.7, width: 1280, height: 820 }, true), {
    version: 1, normalBounds: { x: -20, y: 11, width: 1280, height: 820 }, maximized: true,
  });
  assert.equal(serializeWindowState({ x: 0, y: 0, width: 0, height: 820 }, false), null);
});
