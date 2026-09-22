import test from 'node:test';
import assert from 'node:assert/strict';
import { compareDriverVersions, createIntelDriverCheckLoader, intelDriverKind, newerIntelRelease } from '../src/renderer/pure/intel-driver-updates.ts';

test('orders up to four numeric driver version parts', () => {
  assert.equal(compareDriverVersions('32.0.101.7000', '32.0.101.6000'), 1);
  assert.equal(compareDriverVersions('32.0.101.6', '32.0.101.6'), 0);
  assert.equal(compareDriverVersions('32.0.100.9999', '32.0.101.1'), -1);
});

test('does not order malformed, unsafe, or suffixed versions', () => {
  assert.equal(compareDriverVersions('32.0.101.7000-beta', '32.0.101.6000'), null);
  assert.equal(compareDriverVersions('32.0.101.7000', '32.x.101.6000'), null);
  assert.equal(compareDriverVersions('9007199254740992.0', '1.0'), null);
});

test('matches only consumer Arc and Arc Pro Intel devices', () => {
  assert.equal(intelDriverKind('Intel', 'Intel Arc A770'), 'arc');
  assert.equal(intelDriverKind('intel', 'Intel Arc Graphics'), 'arc');
  assert.equal(intelDriverKind('Intel', 'Intel Arc Pro A60'), 'pro');
  assert.equal(intelDriverKind('Intel', 'Intel UHD Graphics 770'), null);
  assert.equal(intelDriverKind('NVIDIA', 'NVIDIA Arc'), null);
});

test('returns a release only when strictly newer', () => {
  const release = { version: '32.0.101.7000', releaseDate: null, officialPageUrl: 'https://intel.com' };
  const check = { arc: release, pro: null };
  assert.equal(newerIntelRelease('arc', '32.0.101.6000', check), release);
  assert.equal(newerIntelRelease('arc', release.version, check), null);
  assert.equal(newerIntelRelease('arc', 'unknown', check), null);
});

test('retries an unavailable Intel metadata check after a short backoff, then caches a complete result', async () => {
  let now = 0;
  let calls = 0;
  const available = { arc: { version: '32.0.101.7000', releaseDate: null, officialPageUrl: 'https://www.intel.com/arc' },
    pro: { version: '32.0.101.7000', releaseDate: null, officialPageUrl: 'https://www.intel.com/pro' } };
  const loader = createIntelDriverCheckLoader(async () => {
    calls++;
    return calls === 1 ? { arc: null, pro: null } : available;
  }, { now: () => now, cacheMs: 500, retryMs: 50 });

  assert.deepEqual(await loader(), { arc: null, pro: null });
  assert.deepEqual(await loader(), { arc: null, pro: null });
  assert.equal(calls, 1, 'failure is held only during the retry backoff');
  now = 50;
  assert.deepEqual(await loader(), available);
  now = 100;
  assert.deepEqual(await loader(), available);
  assert.equal(calls, 2, 'complete metadata is cached for the longer interval');
});
