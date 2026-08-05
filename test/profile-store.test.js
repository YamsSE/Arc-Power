// M1 — ProfileStore: save/load round trips, atomic writes (simulated crash
// mid-write), migration of an old-version fixture file, refusal of newer
// schema versions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProfileStore } from '../src/main/store/profile-store.js';
import { SCHEMA_VERSION } from '../src/main/store/migrations.js';

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rid-ap-store-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

test('profiles: empty store loads [] and saves/loads round trip', async (t) => {
  const store = new ProfileStore({ dir: tempDir(t) });
  assert.deepEqual(await store.loadProfiles(), []);
  const profiles = [
    { id: 'p1', name: 'Gaming', createdAt: '2026-08-05T00:00:00.000Z', schemaVersion: SCHEMA_VERSION, settings: { powerLimitW: 220, tempLimitC: 85 }, ocOnBoot: true },
  ];
  await store.saveProfiles(profiles);
  assert.deepEqual(await store.loadProfiles(), profiles);
  // File carries schemaVersion on disk
  const raw = JSON.parse(fs.readFileSync(store.profilesPath, 'utf8'));
  assert.equal(raw.schemaVersion, SCHEMA_VERSION);
});

test('settings: defaults when missing; round trip', async (t) => {
  const store = new ProfileStore({ dir: tempDir(t) });
  assert.deepEqual(await store.loadSettings(), { waiverAccepted: false, ocOnBoot: false, activeProfileId: null });
  await store.saveSettings({ waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' });
  assert.deepEqual(await store.loadSettings(), { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' });
});

test('saveProfile upserts and deleteProfile removes', async (t) => {
  const store = new ProfileStore({ dir: tempDir(t) });
  await store.saveProfile({ id: 'a', name: 'A', createdAt: 'x', settings: { powerLimitW: 200 }, ocOnBoot: false });
  await store.saveProfile({ id: 'a', name: 'A2', createdAt: 'x', settings: { powerLimitW: 210 }, ocOnBoot: true });
  let profiles = await store.loadProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'A2');
  assert.equal(profiles[0].ocOnBoot, true);
  assert.equal(await store.deleteProfile('a'), true);
  assert.equal(await store.deleteProfile('a'), false);
  assert.deepEqual(await store.loadProfiles(), []);
});

test('atomic write: a crash mid-write leaves the previous file intact', async (t) => {
  const store = new ProfileStore({ dir: tempDir(t) });
  await store.saveProfiles([{ id: 'v1', name: 'First', createdAt: 'x', schemaVersion: SCHEMA_VERSION, settings: {}, ocOnBoot: false }]);
  const before = fs.readFileSync(store.profilesPath, 'utf8');

  // Simulate a crash: write garbage to the temp file and never rename it.
  fs.writeFileSync(`${store.profilesPath}.tmp`, '{ truncated garbage');
  // The real file must still be the last good write.
  assert.equal(fs.readFileSync(store.profilesPath, 'utf8'), before);

  // The next save succeeds and cleans up the stale temp file.
  await store.saveProfiles([{ id: 'v2', name: 'Second', createdAt: 'x', schemaVersion: SCHEMA_VERSION, settings: {}, ocOnBoot: false }]);
  assert.equal(fs.existsSync(`${store.profilesPath}.tmp`), false);
  assert.deepEqual(await store.loadProfiles(), [{ id: 'v2', name: 'Second', createdAt: 'x', schemaVersion: SCHEMA_VERSION, settings: {}, ocOnBoot: false }]);
});

test('atomic write: reader never sees a half-written file (temp is separate)', async (t) => {
  const store = new ProfileStore({ dir: tempDir(t) });
  await store.saveProfiles([]);
  // During a write the data exists only in the .tmp file
  fs.writeFileSync(`${store.profilesPath}.tmp`, JSON.stringify({ schemaVersion: SCHEMA_VERSION, profiles: [{ id: 'half', name: 'x' }] }));
  const profiles = await store.loadProfiles();
  assert.equal(profiles.length, 0); // still the committed content
});

test('atomic write: fsyncs the temp file before rename (F6 regression)', async (t) => {
  const store = new ProfileStore({ dir: tempDir(t) });
  const spy = t.mock.method(fs, 'fsyncSync', () => {});
  await store.saveProfiles([]);
  assert.equal(spy.mock.callCount(), 1);
});

test('load: old-version fixture file (v0, no schemaVersion) migrates on read', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({
    profiles: [{ name: 'Legacy', settings: { powerLimitW: 250 }, ocOnBoot: true }],
  }));
  const store = new ProfileStore({ dir });
  const profiles = await store.loadProfiles();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, 'Legacy');
  assert.equal(profiles[0].schemaVersion, 1);
  assert.equal(profiles[0].settings.powerLimitW, 250);
  assert.equal(profiles[0].ocOnBoot, true);
  // The migrated file is persisted back at the current schema
  const raw = JSON.parse(fs.readFileSync(store.profilesPath, 'utf8'));
  assert.equal(raw.schemaVersion, 1);
});

test('load: newer schemaVersion is refused, never clobbered', async (t) => {
  const dir = tempDir(t);
  const content = JSON.stringify({ schemaVersion: 99, profiles: [{ id: 'x', name: 'future' }] });
  fs.writeFileSync(path.join(dir, 'profiles.json'), content);
  const store = new ProfileStore({ dir });
  await assert.rejects(store.loadProfiles(), /newer version/);
  // the file is untouched
  assert.equal(fs.readFileSync(store.profilesPath, 'utf8'), content);
});

test('load: corrupt JSON fails with a clear error', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'profiles.json'), '{{{ not json');
  const store = new ProfileStore({ dir });
  await assert.rejects(store.loadProfiles(), /invalid JSON/);
});

test('load: settings file at current schema passes through', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 1, waiverAccepted: true, ocOnBoot: false, activeProfileId: null }));
  const store = new ProfileStore({ dir });
  assert.deepEqual(await store.loadSettings(), { waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
});
