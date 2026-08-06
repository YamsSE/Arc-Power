// M1 + M3-C-E — migrations: pure functions, v0/v1 fixtures -> current,
// refusal of newer/unknown versions, malformed input.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateStoreData, assertCurrentSchema, SCHEMA_VERSION } from '../src/main/store/migrations.js';

test('SCHEMA_VERSION is 2 (current, M3-C-E added the ocMode slot)', () => {
  assert.equal(SCHEMA_VERSION, 2);
});

test('v0 profiles fixture migrates to v2 with normalized profiles', () => {
  const v0 = {
    profiles: [
      { name: 'Gaming', settings: { powerLimitW: 220 }, ocOnBoot: true },
      { settings: { tempLimitC: 85 } },
    ],
  };
  const out = migrateStoreData(v0, 'profiles');
  assert.equal(out.schemaVersion, 2);
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

test('v0 settings fixture migrates to v2 with defaults (no ocMode yet)', () => {
  const out = migrateStoreData({ waiverAccepted: true, ocOnBoot: false }, 'settings');
  assert.deepEqual(out, { schemaVersion: 2, waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
});

test('M3-C-E: v1 settings migrate to v2 — the normalized fields carry over, ocMode stays ABSENT (store default decides)', () => {
  const v1 = { schemaVersion: 1, waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' };
  const out = migrateStoreData(v1, 'settings');
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.waiverAccepted, true);
  assert.equal(out.ocOnBoot, true);
  assert.equal(out.activeProfileId, 'p1');
  // The migration deliberately does NOT write a mode: an absent ocMode
  // means "follow the store default" (stock for the real product, advanced
  // for mock/ui-verify) — a hardcoded 'stock' would leak into mock
  // sessions and break the extended-flow pins.
  assert.ok(!('ocMode' in out), 'ocMode stays absent after the v1->v2 migration');
});

test('M3-C-E: a v1 file that ALREADY carries ocMode keeps it through the migration', () => {
  const v1 = { schemaVersion: 1, waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' };
  const out = migrateStoreData(v1, 'settings');
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.ocMode, 'advanced');
});

test('M3-C-E: v1 profiles migrate to v2 unchanged (schema bump only)', () => {
  const v1 = { schemaVersion: 1, profiles: [{ id: 'a', name: 'X', settings: {}, ocOnBoot: false, createdAt: 't', schemaVersion: 1 }] };
  const out = migrateStoreData(v1, 'profiles');
  assert.equal(out.schemaVersion, 2);
  assert.equal(out.profiles.length, 1);
  assert.equal(out.profiles[0].name, 'X');
});

test('current-version data passes through unchanged', () => {
  const data = { schemaVersion: 2, profiles: [{ id: 'a', name: 'X' }] };
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
