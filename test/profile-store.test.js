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

test('settings: defaults when missing; round trip (M3-C-E: ocMode)', async (t) => {
  const store = new ProfileStore({ dir: tempDir(t) });
  assert.deepEqual(await store.loadSettings(), { waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock', advancedModeAccepted: false });
  await store.saveSettings({ waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1', ocMode: 'advanced' });
  assert.deepEqual(await store.loadSettings(), { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1', ocMode: 'advanced', advancedModeAccepted: false });
});

test('M4-B: the Advanced OC Mode warning acceptance persists across store round trips', async (t) => {
  const store = new ProfileStore({ dir: tempDir(t) });
  assert.equal((await store.loadSettings()).advancedModeAccepted, false);
  await store.saveSettings({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock', advancedModeAccepted: true });
  assert.equal((await store.loadSettings()).advancedModeAccepted, true);
  // An OLD settings file without the field (a pre-M4-B install) reads false.
  const oldDir = tempDir(t);
  fs.writeFileSync(path.join(oldDir, 'settings.json'), JSON.stringify({ schemaVersion: 2, waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock' }));
  assert.equal((await new ProfileStore({ dir: oldDir }).loadSettings()).advancedModeAccepted, false);
});

test('M3-C-E: the store default ocMode is ' + "'stock' for the real product, 'advanced' for mock/ui-verify", async (t) => {
  const real = new ProfileStore({ dir: tempDir(t) });
  assert.equal((await real.loadSettings()).ocMode, 'stock');
  const mock = new ProfileStore({ dir: tempDir(t), ocModeDefault: 'advanced' });
  assert.equal((await mock.loadSettings()).ocMode, 'advanced');
  // A persisted mode always wins over the default.
  await mock.saveSettings({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock' });
  assert.equal((await mock.loadSettings()).ocMode, 'stock');
  // A garbage persisted mode degrades to the default (never a lie).
  await mock.saveSettings({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'turbo' });
  assert.equal((await mock.loadSettings()).ocMode, 'advanced');
});

// M3-C review F4 — mock/ui-verify sessions write an ISOLATED data dir, never
// the real %APPDATA%\ArcPower\settings.json. Two stores on different dirs
// must never see each other's persisted settings (the pre-fix bug: a default
// mock run flipped the REAL product's persisted ocMode to advanced, and a
// stock variant made the next real launch refuse a saved 300 W profile).
test('F4: stores on separate dirs are fully isolated — a mock-mode write never leaks into another store', async (t) => {
  const mockDir = path.join(os.tmpdir(), 'arcpower-mock'); // the main.js mock data dir
  const realDir = tempDir(t); // stands in for %APPDATA%\ArcPower
  const mockStore = new ProfileStore({ dir: mockDir, ocModeDefault: 'advanced' });
  const realStore = new ProfileStore({ dir: realDir, ocModeDefault: 'stock' });
  t.after(() => { try { fs.rmSync(mockDir, { recursive: true, force: true }); } catch { /* ignore */ } });
  // The mock session seeds its variant mode into ITS OWN dir.
  await mockStore.saveSettings({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' });
  assert.equal(fs.existsSync(path.join(mockDir, 'settings.json')), true, 'the mock write lands in the mock dir');
  // The real store's settings stay at its own defaults — nothing leaked.
  assert.deepEqual(await realStore.loadSettings(), { waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock', advancedModeAccepted: false });
  assert.equal(fs.existsSync(path.join(realDir, 'settings.json')), false, 'the mock session never wrote the real dir');
  // A stock mock variant flips only the mock dir — the real store still
  // defaults to stock, and the advanced mock store sees its own write.
  const stockMockStore = new ProfileStore({ dir: mockDir, ocModeDefault: 'advanced' });
  await stockMockStore.saveSettings({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock' });
  assert.equal((await new ProfileStore({ dir: realDir, ocModeDefault: 'stock' }).loadSettings()).ocMode, 'stock', 'the real store is untouched by the stock variant');
  assert.equal((await stockMockStore.loadSettings()).ocMode, 'stock');
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
  assert.equal(profiles[0].schemaVersion, SCHEMA_VERSION);
  assert.equal(profiles[0].settings.powerLimitW, 250);
  assert.equal(profiles[0].ocOnBoot, true);
  // The migrated file is persisted back at the current schema
  const raw = JSON.parse(fs.readFileSync(store.profilesPath, 'utf8'));
  assert.equal(raw.schemaVersion, SCHEMA_VERSION);
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

test('load: settings file at current schema passes through (M3-C-E: v2)', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 2, waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' }));
  const store = new ProfileStore({ dir });
  assert.deepEqual(await store.loadSettings(), { waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced', advancedModeAccepted: false });
});

test('M3-C-E: a v1 settings file migrates on load; the absent ocMode follows the store default', async (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ schemaVersion: 1, waiverAccepted: true, ocOnBoot: false, activeProfileId: null }));
  const real = new ProfileStore({ dir });
  assert.deepEqual(await real.loadSettings(), { waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'stock', advancedModeAccepted: false });
  // The migrated file is persisted back at the CURRENT schema (v2).
  const raw = JSON.parse(fs.readFileSync(real.settingsPath, 'utf8'));
  assert.equal(raw.schemaVersion, 2);
  assert.ok(!('ocMode' in raw), 'the migration does not pin a mode — the default decides');
  const mock = new ProfileStore({ dir, ocModeDefault: 'advanced' });
  assert.equal((await mock.loadSettings()).ocMode, 'advanced');
});
