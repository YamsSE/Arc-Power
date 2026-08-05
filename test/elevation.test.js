// M2C-C — elevation detection tests: the koffi probe is thin, so the tests
// inject a fake shell32 lib and pin the caching + safe-degradation behavior.
// The real shell32.dll is NEVER loaded here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isElevated, resetElevationCache } from '../src/main/elevation.js';

const fakeLib = (value) => ({
  func: (sig) => {
    assert.equal(sig, 'int32 IsUserAnAdmin(void)');
    return () => (value ? 1 : 0);
  },
});
const fakeLoad = (lib) => ({ load: (name) => {
  assert.equal(name, 'shell32.dll');
  return lib;
} });

test('isElevated: true when IsUserAnAdmin returns non-zero', () => {
  resetElevationCache();
  assert.equal(isElevated({ lib: fakeLib(1), koffiMod: fakeLoad(fakeLib(1)) }), true);
  resetElevationCache();
});

test('isElevated: false when IsUserAnAdmin returns zero', () => {
  resetElevationCache();
  assert.equal(isElevated({ lib: fakeLib(0), koffiMod: fakeLoad(fakeLib(0)) }), false);
  resetElevationCache();
});

test('isElevated: cached after the first call (the probe runs once)', () => {
  resetElevationCache();
  let calls = 0;
  const lib = { func: () => { calls += 1; return () => 1; } };
  const deps = { lib, koffiMod: fakeLoad(lib) };
  assert.equal(isElevated(deps), true);
  assert.equal(isElevated(deps), true);
  assert.equal(isElevated(deps), true);
  assert.equal(calls, 1, 'IsUserAnAdmin must be called exactly once (cached)');
  resetElevationCache();
});

test('isElevated: a load/binding failure degrades to false (never throws)', () => {
  resetElevationCache();
  assert.equal(isElevated({ lib: { func: () => { throw new Error('bad ABI'); } }, koffiMod: fakeLoad({ func: () => { throw new Error('bad ABI'); } }) }), false);
  assert.equal(isElevated({ lib: null, koffiMod: { load: () => { throw new Error('no shell32'); } } }), false);
  resetElevationCache();
});

test('isElevated: the safe direction is FALSE (a wrong false spawns the worker; a wrong true would silently lie)', () => {
  // Not directly observable here — pins the documented contract so a future
  // change to the failure branch is caught: after a failure, the cached
  // value is false, not null/true.
  resetElevationCache();
  isElevated({ lib: { func: () => { throw new Error('boom'); } } });
  assert.equal(isElevated({ lib: fakeLib(1), koffiMod: fakeLoad(fakeLib(1)) }), false, 'a failed probe poisons the cache to false (never re-probes into a lie)');
  resetElevationCache();
});
