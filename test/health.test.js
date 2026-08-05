// M1 — health() aggregator: report shape for healthy and broken backends.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectHealth } from '../src/main/health.js';
import { MockBackend } from '../src/main/backend/mock-backend.js';

test('collectHealth: healthy mock backend report', async () => {
  const h = await collectHealth(new MockBackend());
  assert.equal(h.backend, 'mock');
  assert.equal(h.igclLoaded, true);
  assert.equal(h.levelZeroOk, true);
  assert.match(h.driverVersion, /32\.0\.101\.8861/);
  assert.equal(h.error, undefined);
});

test('collectHealth: a failing backend still yields the report shape with error', async () => {
  const broken = {
    kind: 'igcl',
    async health() { throw new Error('boom'); },
  };
  const h = await collectHealth(broken);
  assert.equal(h.backend, 'igcl');
  assert.equal(h.igclLoaded, false);
  assert.equal(h.levelZeroOk, false);
  assert.equal(h.error, 'boom');
});
