// M1 — migrations: pure functions, v0 fixture -> current, refusal of
// newer/unknown versions, malformed input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateStoreData, assertCurrentSchema, SCHEMA_VERSION } from '../src/main/store/migrations.js';

test('SCHEMA_VERSION is 1 (current)', () => {
  assert.equal(SCHEMA_VERSION, 1);
});

test('v0 profiles fixture migrates to v1 with normalized profiles', () => {
  const v0 = {
    profiles: [
      { name: 'Gaming', settings: { powerLimitW: 220 }, ocOnBoot: true },
      { settings: { tempLimitC: 85 } },
    ],
  };
  const out = migrateStoreData(v0, 'profiles');
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.profiles.length, 2);
  assert.equal(out.profiles[0].id, 'profile-0');
  assert.equal(out.profiles[0].name, 'Gaming');
  assert.equal(out.profiles[0].ocOnBoot, true);
  assert.equal(out.profiles[0].settings.powerLimitW, 220);
  assert.equal(out.profiles[1].id, 'profile-1');
  assert.equal(out.profiles[1].name, 'Profile 2');
  assert.equal(out.profiles[1].ocOnBoot, false);
  assert.equal(out.profiles[1].createdAt, new Date(0).toISOString());
});

test('v0 settings fixture migrates to v1 with defaults', () => {
  const out = migrateStoreData({ waiverAccepted: true, ocOnBoot: false }, 'settings');
  assert.deepEqual(out, { schemaVersion: 1, waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
});

test('current-version data passes through unchanged', () => {
  const data = { schemaVersion: 1, profiles: [{ id: 'a', name: 'X' }] };
  const out = migrateStoreData(data, 'profiles');
  assert.deepEqual(out, data);
});

test('newer schemaVersion is refused with a clear error', () => {
  assert.throws(() => migrateStoreData({ schemaVersion: 99 }, 'profiles'), /newer version of Arc Power/);
  assert.throws(() => migrateStoreData({ schemaVersion: 99 }, 'settings'), /newer/);
});

test('unknown future versions in assertCurrentSchema are refused', () => {
  assert.throws(() => assertCurrentSchema({ schemaVersion: 5 }), /newer/);
});

test('malformed input is refused', () => {
  assert.throws(() => migrateStoreData(null, 'profiles'), /expected an object/);
  assert.throws(() => migrateStoreData([], 'profiles'), /expected an object/);
  assert.throws(() => migrateStoreData('x', 'profiles'), /expected an object/);
  assert.throws(() => migrateStoreData({ schemaVersion: -1 }, 'profiles'), /not a non-negative integer/);
  assert.throws(() => migrateStoreData({ schemaVersion: 1.5 }, 'profiles'), /not a non-negative integer/);
});

test('migrations do not mutate the input object', () => {
  const v0 = { profiles: [{ name: 'A' }] };
  const snapshot = JSON.stringify(v0);
  migrateStoreData(v0, 'profiles');
  assert.equal(JSON.stringify(v0), snapshot);
});
