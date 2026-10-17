import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isKnownNonGameExecutable } from '../src/main/game-candidate.js';
import { GameProfileStore } from '../src/main/store/game-profile-store.js';
import { createSharpeningGameLookup } from '../src/main/sharpening-game-eligibility.js';

test('known desktop applications cannot be sharpened even if manually added to Game Profiles', () => {
  assert.equal(isKnownNonGameExecutable('C:\\Program Files\\ChatGPT\\ChatGPT.exe'), true);
  assert.equal(isKnownNonGameExecutable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'), true);
  assert.equal(isKnownNonGameExecutable('C:\\Games\\Microsoft Flight Simulator\\FlightSimulator.exe'), false, 'vendor-named game paths do not get rejected');
  assert.equal(isKnownNonGameExecutable('C:\\Games\\UnlistedTitle\\MysteryGame.exe'), false, 'unknown game names remain eligible for explicit catalog entries');
});

test('GameProfileStore caches catalog paths and invalidates the cache after catalog mutations', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-game-catalog-path-cache-'));
  const firstExe = path.join(dir, 'MysteryGame.exe');
  const secondExe = path.join(dir, 'AnotherGame.exe');
  fs.writeFileSync(firstExe, 'fixture');
  fs.writeFileSync(secondExe, 'fixture');
  const store = new GameProfileStore({ dir });
  const loadData = store._loadDataUnlocked.bind(store);
  let reads = 0;
  store._loadDataUnlocked = (...args) => { reads++; return loadData(...args); };

  try {
    assert.equal(await store.hasCatalogPath(firstExe), false);
    await store.syncCatalog([{ exePath: firstExe, processName: 'MysteryGame.exe', displayName: 'Mystery Game' }]);
    assert.equal(await store.hasCatalogPath(firstExe), true, 'catalog additions refresh the process-local path cache');
    const initialReads = reads;
    for (let index = 0; index < 20; index++) assert.equal(await store.hasCatalogPath(firstExe), true);
    assert.equal(reads, initialReads, 'foreground polling does not reload the catalog or embedded artwork');
    assert.equal(await store.hasCatalogPath(secondExe), false);
    await store.syncCatalog([{ exePath: secondExe, processName: 'AnotherGame.exe', displayName: 'Another Game' }]);
    assert.equal(await store.hasCatalogPath(firstExe), true, 'merge-safe sync preserves existing paths');
    assert.equal(await store.hasCatalogPath(secondExe), true, 'new paths appear after a write');
    await store.syncCatalog([], { authoritative: true });
    assert.equal(await store.hasCatalogPath(firstExe), false, 'authoritative catalog removal invalidates cached paths');
    assert.equal(await store.hasCatalogPath(secondExe), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('global sharpening discovers games without a Profiles visit and merges an incomplete scan', async () => {
  const game = 'c:\\games\\palworld\\palworld.exe';
  const existing = 'c:\\games\\already-catalogued.exe';
  const entries = new Set([existing]);
  let scans = 0;
  let syncs = 0;
  const lookup = createSharpeningGameLookup({
    gameProfiles: {
      async hasCatalogPath(exePath) { return entries.has(exePath); },
      async syncCatalog(apps, options) {
        syncs++;
        assert.equal(options?.authoritative, undefined, 'background scan must preserve existing games/settings');
        for (const app of apps) entries.add(app.exePath);
      },
    },
    gameScan: { async scan() {
      scans++;
      return { apps: [
        { exePath: game, displayName: 'Palworld' },
        { exePath: 'c:\\program files\\chatgpt\\chatgpt.exe', displayName: 'ChatGPT' },
      ] };
    } },
  });

  assert.equal(await lookup('C:\\Program Files\\ChatGPT\\ChatGPT.exe'), false);
  assert.equal(scans, 0, 'known desktop applications do not trigger game discovery');
  assert.deepEqual(await Promise.all([lookup(game), lookup(game.toUpperCase())]), [true, true]);
  assert.equal(scans, 1, 'concurrent lookups share one discovery scan');
  assert.equal(syncs, 1);
  assert.equal(await lookup(existing), true, 'incomplete scan retained an existing game');
  assert.equal(await lookup('c:\\tools\\unlisted-app.exe'), false);
  assert.equal(scans, 1, 'unknown foreground applications do not cause repeated scans');
  entries.add('c:\\games\\manually-added.exe');
  assert.equal(await lookup('c:\\games\\manually-added.exe'), true, 'new manual catalog membership takes effect without restart');
});

test('game discovery failure stays closed and does not repeat background scans', async () => {
  let scans = 0;
  const warnings = [];
  const lookup = createSharpeningGameLookup({
    gameProfiles: {
      async hasCatalogPath() { return false; },
      async syncCatalog() { assert.fail('a failed scan must not mutate the catalog'); },
    },
    gameScan: { async scan() { scans++; throw new Error('registry unavailable'); } },
    warn: (message) => warnings.push(message),
  });
  assert.equal(await lookup('c:\\games\\palworld\\palworld.exe'), false);
  assert.equal(await lookup('c:\\games\\palworld\\palworld.exe'), false);
  assert.equal(scans, 1);
  assert.match(warnings[0], /registry unavailable/);
});
