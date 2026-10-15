import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARC_POWER_CACHE_DIR_NAMES,
  ARC_POWER_PROFILE_CACHE_FILE_NAMES,
  consumeMaintenanceReceiptSync,
  prepareArcPowerCacheSync,
  resetArcPowerCachesSync,
  resetArcPowerDataSync,
  resolveArcPowerCacheTargets,
  resolveArcPowerVersionStatePath,
  writeMaintenanceReceiptSync,
} from '../src/main/cache-lifecycle.js';

const FIXTURE_PREFIX = 'arc-power-cache-maintenance-test-';

// All paths passed to the production helpers are descendants of a fresh fixture.
// Never obtain application data paths from the environment or Electron.
function fixture(t) {
  const tempParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tempParent, FIXTURE_PREFIX));
  assert.equal(path.dirname(root), tempParent);
  assert.ok(path.basename(root).startsWith(FIXTURE_PREFIX));
  const identity = fs.lstatSync(root);
  t.after(() => {
    assert.equal(path.dirname(root), tempParent);
    assert.ok(path.basename(root).startsWith(FIXTURE_PREFIX));
    const current = fs.lstatSync(root);
    assert.equal(current.isSymbolicLink(), false, 'fixture root must not become a link');
    assert.equal(current.dev, identity.dev);
    assert.equal(current.ino, identity.ino, 'cleanup must target the exact created fixture');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const roaming = path.join(root, 'Roaming');
  const local = path.join(root, 'Local');
  const data = path.join(roaming, 'ArcPower');
  const media = path.join(root, 'Videos', 'Arc Power');
  for (const dir of [roaming, local, data, media]) fs.mkdirSync(dir, { recursive: true });
  return { root, roaming, local, data, media };
}

function write(file, content = `sentinel:${path.basename(file)}`) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function snapshot(files) {
  return new Map(files.map((file) => [file, fs.readFileSync(file)]));
}

function assertPreserved(before) {
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes, file);
}

function seedVersion(f, version) {
  return write(resolveArcPowerVersionStatePath(f.roaming), JSON.stringify({ lastOpenedVersion: version, fixture: true }));
}

function seedCaches(f) {
  // Enumerate independently so a production resolver omission cannot make the
  // reset test pass by omitting the same legacy directory in its expectations.
  const names = ['ArcPowerCache', 'arc-power', 'rid-arc-power'];
  assert.deepEqual([...ARC_POWER_CACHE_DIR_NAMES], names);
  const roots = [f.roaming, f.local].flatMap((root) => names.map((name) => path.join(root, name)));
  roots.push(path.join(f.local, 'Arc Power', 'Cache'));
  assert.deepEqual([...resolveArcPowerCacheTargets(f.roaming, { localAppDataPath: f.local })], roots);
  const files = roots.map((root) => write(path.join(root, 'nested', 'stale-cache.bin')));
  for (const name of ARC_POWER_PROFILE_CACHE_FILE_NAMES) files.push(write(path.join(f.data, name)));
  return { roots, files };
}

function durableFiles(f) {
  return [
    write(path.join(f.data, 'settings.json'), '{"theme":"dark"}'),
    write(path.join(f.data, 'profiles', 'custom.json'), '{"name":"custom"}'),
    write(path.join(f.data, 'DriverDownloads', 'arc', 'installer.exe')),
    write(path.join(f.data, 'TuningQuarantine', 'recovery.json')),
    write(path.join(f.local, 'Arc Power', 'diagnostics.log')),
    write(path.join(f.local, 'ArcPower', 'unrelated.bin')),
    write(path.join(f.media, 'clip.mp4')),
    write(path.join(f.root, 'unrelated-app', 'sentinel.bin')),
  ];
}

function assertCachesCleared(f, caches) {
  for (const file of caches.files) assert.equal(fs.existsSync(file), false, file);
  const active = path.join(f.roaming, 'ArcPowerCache');
  assert.deepEqual(fs.readdirSync(active), []);
  for (const root of caches.roots.filter((root) => root !== active)) assert.equal(fs.existsSync(root), false, root);
}

test('1.2.2 -> 1.2.3 clears every current and legacy Roaming/Local cache while preserving user data', (t) => {
  const f = fixture(t);
  seedVersion(f, '1.2.2');
  const caches = seedCaches(f);
  const staleCaches = snapshot(caches.files);
  const durable = snapshot(durableFiles(f));
  let beforeResetCalls = 0;
  const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', {
    localAppDataPath: f.local,
    beforeReset: () => { beforeResetCalls += 1; assertPreserved(durable); assertPreserved(staleCaches); },
  });
  assert.equal(result.reset, true);
  assert.equal(result.previousVersion, '1.2.2');
  assert.equal(beforeResetCalls, 1);
  assertCachesCleared(f, caches);
  assertPreserved(durable);
  assert.equal(JSON.parse(fs.readFileSync(result.versionStatePath, 'utf8')).lastOpenedVersion, '1.2.3');
});

test('same-version launch preserves caches and the exact version marker without a reset callback', (t) => {
  const f = fixture(t);
  const marker = seedVersion(f, '1.2.3');
  const caches = seedCaches(f);
  const unchanged = snapshot([marker, ...caches.files, ...durableFiles(f)]);
  const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', {
    localAppDataPath: f.local,
    beforeReset: () => assert.fail('same-version launch must not reset'),
  });
  assert.equal(result.reset, false);
  assertPreserved(unchanged);
});

test('a higher future version clears caches and updates the version marker', (t) => {
  const f = fixture(t);
  seedVersion(f, '1.2.3');
  const caches = seedCaches(f);
  const result = prepareArcPowerCacheSync(f.roaming, '2.0.0', { localAppDataPath: f.local });
  assert.equal(result.reset, true);
  assertCachesCleared(f, caches);
  assert.equal(JSON.parse(fs.readFileSync(result.versionStatePath, 'utf8')).lastOpenedVersion, '2.0.0');
});

test('installer forceReset clears caches even at the same version', (t) => {
  const f = fixture(t);
  const marker = seedVersion(f, '1.2.3');
  const caches = seedCaches(f);
  const durable = snapshot([marker, ...durableFiles(f)]);
  const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', { localAppDataPath: f.local, forceReset: true });
  assert.equal(result.reset, true);
  assertCachesCleared(f, caches);
  assertPreserved(durable);
});

for (const protectedRootIndex of [0, 5, 6]) {
  test(`active singleton lock survives cleanup in known cache root ${protectedRootIndex} while other lockfiles and caches are removed`, (t) => {
    const f = fixture(t);
    seedVersion(f, '1.2.3');
    const caches = seedCaches(f);
    const lockfiles = caches.roots.map((root) => write(path.join(root, 'lockfile'), `lock:${root}`));
    const activeLockPath = lockfiles[protectedRootIndex];
    const protectedRoot = path.dirname(activeLockPath);
    const rootIdentity = fs.lstatSync(protectedRoot);
    const descriptor = fs.openSync(activeLockPath, 'r');
    const lockIdentity = fs.fstatSync(descriptor);
    const originalLock = fs.readFileSync(activeLockPath);
    const durable = snapshot(durableFiles(f));
    let removals = 0;
    try {
      // A native Node handle permits deletion on Windows. Model the stricter
      // Electron singleton handle too: removing it or an ancestor must fail.
      const fsApi = { ...fs, rmSync(target, options) {
        const relative = path.relative(path.resolve(target), activeLockPath);
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
          throw Object.assign(new Error('fixture singleton lock is held without delete sharing'), { code: 'EBUSY' });
        }
        removals += 1;
        return fs.rmSync(target, options);
      } };
      const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', {
        localAppDataPath: f.local, forceReset: true, activeLockPath, fs: fsApi,
      });
      assert.equal(result.reset, true);
      assert.ok(removals > 0);
      assert.deepEqual(fs.readFileSync(activeLockPath), originalLock);
      assert.equal(fs.lstatSync(protectedRoot).ino, rootIdentity.ino, 'must preserve the containing directory');
      assert.equal(fs.lstatSync(activeLockPath).ino, lockIdentity.ino, 'must preserve the exact held file');
      assert.equal(fs.fstatSync(descriptor).ino, lockIdentity.ino, 'held descriptor remains valid');
      assert.deepEqual(fs.readdirSync(protectedRoot), ['lockfile']);
      for (const file of caches.files) assert.equal(fs.existsSync(file), false, file);
      for (const file of lockfiles.filter((file) => file !== activeLockPath)) assert.equal(fs.existsSync(file), false, file);
      const currentRoot = path.join(f.roaming, 'ArcPowerCache');
      for (const root of caches.roots.filter((root) => root !== protectedRoot && root !== currentRoot)) {
        assert.equal(fs.existsSync(root), false, root);
      }
      if (currentRoot !== protectedRoot) assert.deepEqual(fs.readdirSync(currentRoot), []);
      assertPreserved(durable);
    } finally {
      fs.closeSync(descriptor);
    }
  });
}

test('an absolute lockfile outside the fixed cache targets does not preserve any cache root', (t) => {
  const f = fixture(t);
  seedVersion(f, '1.2.3');
  const caches = seedCaches(f);
  const activeLockPath = write(path.join(f.root, 'unrelated-app', 'lockfile'));
  const before = snapshot([activeLockPath]);
  const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', {
    localAppDataPath: f.local, forceReset: true, activeLockPath,
  });
  assert.equal(result.reset, true);
  assertCachesCleared(f, caches);
  assertPreserved(before);
});

for (const [description, lockPath] of [
  ['relative path', () => 'lockfile'],
  ['arbitrary basename', (f) => path.join(f.roaming, 'ArcPowerCache', 'keep-me.bin')],
]) {
  test(`active lock protection rejects ${description} even when the app version did not change`, (t) => {
    const f = fixture(t);
    const marker = seedVersion(f, '1.2.3');
    const caches = seedCaches(f);
    const before = snapshot([marker, ...caches.files]);
    assert.throws(() => prepareArcPowerCacheSync(f.roaming, '1.2.3', {
      localAppDataPath: f.local, activeLockPath: lockPath(f),
    }), /activeLockPath|lockfile|absolute/);
    assertPreserved(before);
  });
}

function seedRecording(f, { location = f.media } = {}) {
  const recording = {
    schemaVersion: 2,
    clips: [{ id: 'clip-1', path: path.join(location, 'clip.mp4'), size: 128 }],
    markers: [{ id: 'marker-1', clipId: 'clip-1', positionMs: 500, label: 'keep this' }],
    settings: { location, enabled: true, bitrateMbps: 60, captureAudio: true, hotkey: 'Ctrl+F9' },
    stalePreference: 'remove',
  };
  write(path.join(f.data, 'recording.json'), JSON.stringify(recording));
  return recording;
}

for (const includeDriverDownloads of [false, true]) {
  for (const nested of [false, true]) {
    test(`${includeDriverDownloads ? 'stronger' : 'manual'} reset retains actual clip files ${nested ? 'deeply nested' : 'directly'} below ArcPower while deleting preference siblings`, (t) => {
      const f = fixture(t);
      const marker = seedVersion(f, '1.2.3');
      const durable = durableFiles(f);
      const location = path.join(f.data, 'Recordings', ...(nested ? ['archive', 'session'] : []));
      const recording = seedRecording(f, { location });
      const clip = write(recording.clips[0].path, 'actual recorded media bytes');
      const sidecar = write(path.join(location, 'metadata', 'clip.json'), '{"keep":"media sidecar"}');
      const removable = [path.join(f.data, 'settings.json'), path.join(f.data, 'profiles', 'custom.json')];
      const ancestorFiles = [];
      if (nested) {
        ancestorFiles.push(write(path.join(f.data, 'Recordings', 'unknown-user-file.json')));
        ancestorFiles.push(write(path.join(f.data, 'Recordings', 'archive', 'unknown-user-file.bin')));
      }
      const retained = snapshot([marker, clip, sidecar, ...ancestorFiles, ...durable.filter((file) => file.includes(`${path.sep}TuningQuarantine${path.sep}`)
        || (!includeDriverDownloads && file.includes(`${path.sep}DriverDownloads${path.sep}`)))]);
      resetArcPowerDataSync(f.roaming, { includeDriverDownloads });
      assertPreserved(retained);
      for (const file of removable) assert.equal(fs.existsSync(file), false, file);
      assert.equal(fs.existsSync(path.join(f.data, 'DriverDownloads')), !includeDriverDownloads);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data, 'recording.json'), 'utf8')), {
        schemaVersion: recording.schemaVersion,
        clips: recording.clips,
        markers: recording.markers,
        settings: { location },
      });
      if (nested) {
        // Data reset preserves the entire immediate child containing the
        // selected output, including unknown user files along its ancestors.
        assert.deepEqual(fs.readdirSync(path.join(f.data, 'Recordings')).sort(), ['archive', 'unknown-user-file.json']);
        assert.deepEqual(fs.readdirSync(path.join(f.data, 'Recordings', 'archive')).sort(), ['session', 'unknown-user-file.bin']);
      }
    });
  }
}

for (const includeDriverDownloads of [false, true]) {
  for (const relation of ['equal', 'parent', 'ancestor']) {
    test(`${includeDriverDownloads ? 'stronger' : 'manual'} reset fails closed when recording location is ${relation} to the ArcPower data directory`, (t) => {
      const f = fixture(t);
      const marker = seedVersion(f, '1.2.3');
      const location = relation === 'equal' ? f.data : relation === 'parent' ? f.roaming : f.root;
      const recording = seedRecording(f, { location });
      const before = snapshot([marker, path.join(f.data, 'recording.json'), write(recording.clips[0].path), ...durableFiles(f)]);
      const names = fs.readdirSync(f.data).sort();
      let deletionAttempts = 0;
      assert.throws(() => resetArcPowerDataSync(f.roaming, { includeDriverDownloads, fs: {
        ...fs,
        rmSync: () => { deletionAttempts += 1; throw new Error('unexpected fixture rmSync call'); },
      } }), /recording|folder/i);
      assert.equal(deletionAttempts, 0, 'unsafe location must reject before the first deletion');
      assertPreserved(before);
      assert.deepEqual(fs.readdirSync(f.data).sort(), names, 'must not leave a partial reset or recording temporary file');
    });
  }
}

for (const protectedRootIndex of [0, 1, 5, 6]) {
  test(`automatic upgrade preserves actual recording output nested in fixed cache root ${protectedRootIndex} and clears unrelated siblings`, (t) => {
    const f = fixture(t);
    seedVersion(f, '1.2.2');
    const caches = seedCaches(f);
    const protectedRoot = caches.roots[protectedRootIndex];
    const location = path.join(protectedRoot, 'exports', 'session');
    const recording = seedRecording(f, { location });
    const clip = write(recording.clips[0].path, 'media bytes inside disposable cache root');
    const sidecar = write(path.join(location, 'sidecars', 'marker.json'));
    const sibling = write(path.join(protectedRoot, 'exports', 'discard-cache.bin'));
    const preserved = snapshot([clip, sidecar, path.join(f.data, 'recording.json'), ...durableFiles(f)]);
    const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', { localAppDataPath: f.local });
    assert.equal(result.reset, true);
    assertPreserved(preserved);
    assert.equal(fs.existsSync(sibling), false);
    for (const file of caches.files) assert.equal(fs.existsSync(file), false, file);
    assert.deepEqual(fs.readdirSync(protectedRoot), ['exports']);
    assert.deepEqual(fs.readdirSync(path.join(protectedRoot, 'exports')), ['session']);
    const currentRoot = path.join(f.roaming, 'ArcPowerCache');
    for (const root of caches.roots.filter((root) => root !== protectedRoot && root !== currentRoot)) {
      assert.equal(fs.existsSync(root), false, root);
    }
    if (currentRoot !== protectedRoot) assert.deepEqual(fs.readdirSync(currentRoot), []);
    assert.equal(JSON.parse(fs.readFileSync(result.versionStatePath, 'utf8')).lastOpenedVersion, '1.2.3');
  });
}

test('automatic upgrade preserves entire cache targets contained by the selected recording output root', (t) => {
  const f = fixture(t);
  seedVersion(f, '1.2.2');
  const caches = seedCaches(f);
  const recording = seedRecording(f, { location: f.local });
  const localFiles = caches.files.filter((file) => file.startsWith(`${f.local}${path.sep}`));
  const preserved = snapshot([write(recording.clips[0].path), path.join(f.data, 'recording.json'), ...localFiles]);
  const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', { localAppDataPath: f.local });
  assert.equal(result.reset, true);
  assertPreserved(preserved);
  for (const file of caches.files.filter((file) => !localFiles.includes(file))) assert.equal(fs.existsSync(file), false, file);
  assert.deepEqual(fs.readdirSync(path.join(f.roaming, 'ArcPowerCache')), []);
  assert.equal(fs.existsSync(path.join(f.roaming, 'arc-power')), false);
  assert.equal(fs.existsSync(path.join(f.roaming, 'rid-arc-power')), false);
});

test('automatic upgrade preserves both the active singleton lock and a nested media root in the same cache', (t) => {
  const f = fixture(t);
  seedVersion(f, '1.2.2');
  const caches = seedCaches(f);
  const protectedRoot = caches.roots[0];
  const activeLockPath = write(path.join(protectedRoot, 'lockfile'));
  const recording = seedRecording(f, { location: path.join(protectedRoot, 'exports', 'session') });
  const preserved = snapshot([activeLockPath, write(recording.clips[0].path), path.join(f.data, 'recording.json')]);
  const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', { localAppDataPath: f.local, activeLockPath });
  assert.equal(result.reset, true);
  assertPreserved(preserved);
  for (const file of caches.files) assert.equal(fs.existsSync(file), false, file);
  for (const root of caches.roots.slice(1)) assert.equal(fs.existsSync(root), false, root);
  assert.deepEqual(fs.readdirSync(protectedRoot).sort(), ['exports', 'lockfile']);
});

for (const [description, raw] of [
  ['malformed JSON', '{bad-json'],
  ['missing settings', '{}'],
  ['array settings', JSON.stringify({ settings: [] })],
  ['empty location', JSON.stringify({ settings: { location: '' } })],
  ['relative location', JSON.stringify({ settings: { location: 'Recordings' } })],
]) {
  test(`automatic cache upgrade fails closed before any deletion when recording location cannot be trusted: ${description}`, (t) => {
    const f = fixture(t);
    const marker = seedVersion(f, '1.2.2');
    const caches = seedCaches(f);
    const recordingPath = write(path.join(f.data, 'recording.json'), raw);
    const before = snapshot([marker, recordingPath, ...caches.files, ...durableFiles(f)]);
    let deletionAttempts = 0;
    assert.throws(() => prepareArcPowerCacheSync(f.roaming, '1.2.3', { localAppDataPath: f.local, fs: {
      ...fs,
      rmSync: () => { deletionAttempts += 1; throw new Error('unexpected fixture rmSync call'); },
    } }), /recording|location|absolute/i);
    assert.equal(deletionAttempts, 0, 'untrusted location must reject before the first cache deletion');
    assertPreserved(before);
  });
}

test('cache upgrade can preserve a safe recording location from otherwise unsupported recording metadata', (t) => {
  const f = fixture(t);
  seedVersion(f, '1.2.2');
  const caches = seedCaches(f);
  const location = path.join(caches.roots[1], 'saved-media');
  const clip = write(path.join(location, 'keep.mp4'));
  const recordingPath = write(path.join(f.data, 'recording.json'), JSON.stringify({
    schemaVersion: 999, clips: null, markers: null, settings: { location },
  }));
  const preserved = snapshot([clip, recordingPath]);
  const result = prepareArcPowerCacheSync(f.roaming, '1.2.3', { localAppDataPath: f.local });
  assert.equal(result.reset, true);
  assertPreserved(preserved);
  for (const file of caches.files) assert.equal(fs.existsSync(file), false, file);
  assert.deepEqual(fs.readdirSync(caches.roots[1]), ['saved-media']);
});

for (const includeDriverDownloads of [false, true]) {
  test(`${includeDriverDownloads ? 'stronger' : 'manual'} reset preserves recording metadata, media, quarantine and marker while resetting preferences`, (t) => {
    const f = fixture(t);
    const marker = seedVersion(f, '1.2.3');
    const files = durableFiles(f);
    const recording = seedRecording(f);
    const preserved = snapshot([marker, ...files.filter((file) => !file.includes(`${path.sep}settings.json`)
      && !file.includes(`${path.sep}profiles${path.sep}`)
      && (!includeDriverDownloads || !file.includes(`${path.sep}DriverDownloads${path.sep}`)))]);
    const result = resetArcPowerDataSync(f.roaming, { includeDriverDownloads });
    assertPreserved(preserved);
    assert.equal(fs.existsSync(path.join(f.data, 'settings.json')), false);
    assert.equal(fs.existsSync(path.join(f.data, 'profiles')), false);
    assert.equal(fs.existsSync(path.join(f.data, 'DriverDownloads')), !includeDriverDownloads);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.data, 'recording.json'), 'utf8')), {
      schemaVersion: recording.schemaVersion,
      clips: recording.clips,
      markers: recording.markers,
      settings: { location: recording.settings.location },
    });
    assert.equal(result.removed.includes(path.join(f.data, 'recording.json')), false);
    assert.deepEqual(fs.readdirSync(f.data).filter((name) => name.endsWith('.tmp')), []);
  });
}

const invalidRecordingData = [
  ['malformed JSON', '{bad-json'],
  ['null', 'null'],
  ['array', '[]'],
  ['unknown schema', JSON.stringify({ schemaVersion: 3, clips: [], markers: [], settings: { location: '' } })],
  ['invalid clips', JSON.stringify({ schemaVersion: 2, clips: {}, markers: [], settings: { location: '' } })],
  ['invalid markers', JSON.stringify({ schemaVersion: 2, clips: [], markers: null, settings: { location: '' } })],
  ['missing media location', JSON.stringify({ schemaVersion: 2, clips: [], markers: [], settings: { enabled: true } })],
];
for (const [description, raw] of invalidRecordingData) {
  test(`malformed recording data fails closed before any stronger-reset deletion: ${description}`, (t) => {
    const f = fixture(t);
    const marker = seedVersion(f, '1.2.3');
    const recordingPath = write(path.join(f.data, 'recording.json'), raw);
    const before = snapshot([marker, recordingPath, ...durableFiles(f)]);
    const names = fs.readdirSync(f.data).sort();
    assert.throws(() => resetArcPowerDataSync(f.roaming, { includeDriverDownloads: true }), /Refusing to (?:reset|clean) Arc Power data because recording\.json/);
    assertPreserved(before);
    assert.deepEqual(fs.readdirSync(f.data).sort(), names, 'must not leave a partial reset or temporary recording file');
  });
}

function receiptFixture(f) {
  return {
    action: 'reset', token: 'fixture-token-0123456789abcdef', version: '1.2.3',
    launchPath: path.join(f.root, 'Arc Power.exe'), createdAt: 1_000_000,
  };
}

test('a matching maintenance receipt is consumed once and replay is rejected', (t) => {
  const f = fixture(t);
  const receipt = receiptFixture(f);
  const file = writeMaintenanceReceiptSync(f.roaming, receipt);
  const options = { ...receipt, now: receipt.createdAt + 1_000 };
  assert.deepEqual(consumeMaintenanceReceiptSync(f.roaming, options), receipt);
  assert.equal(fs.existsSync(file), false);
  assert.throws(() => consumeMaintenanceReceiptSync(f.roaming, options), /no valid maintenance confirmation/);
});

for (const [description, overrides] of [
  ['forged token', { token: 'another-token-0123456789abcdef' }],
  ['different action', { action: 'reset-with-drivers' }],
  ['different version', { version: '1.2.4' }],
  ['different executable', { launchPath: 'different-executable.exe' }],
  ['expired', { now: 1_000_000 + 5 * 60_000 + 1 }],
  ['future dated', { now: 999_999 }],
]) {
  test(`maintenance receipt rejects ${description} and retains the confirmation`, (t) => {
    const f = fixture(t);
    const receipt = receiptFixture(f);
    const file = writeMaintenanceReceiptSync(f.roaming, receipt);
    const before = snapshot([file, ...durableFiles(f)]);
    assert.throws(() => consumeMaintenanceReceiptSync(f.roaming, {
      ...receipt, now: receipt.createdAt + 1_000, ...overrides,
    }), /stale or does not match this launch/);
    assertPreserved(before);
  });
}

test('cache cleanup aborts before deleting an earlier cache root when a later root is a real junction', (t) => {
  const f = fixture(t);
  const caches = seedCaches(f);
  const before = snapshot([...caches.files, ...durableFiles(f)]);
  const destination = path.join(f.root, 'junction-target');
  const targetSentinel = write(path.join(destination, 'keep.bin'));
  // This legacy target is intentionally later than the first populated root.
  const junction = path.join(f.local, 'rid-arc-power');
  fs.rmSync(junction, { recursive: true });
  fs.symlinkSync(destination, junction, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { if (fs.existsSync(junction)) fs.unlinkSync(junction); });
  const unchanged = new Map([...before].filter(([file]) => !file.startsWith(`${junction}${path.sep}`)));
  unchanged.set(targetSentinel, fs.readFileSync(targetSentinel));
  assert.throws(() => resetArcPowerCachesSync(f.roaming, { localAppDataPath: f.local }), /symbolic link or reparse point/);
  assertPreserved(unchanged);
  assert.equal(fs.lstatSync(junction).isSymbolicLink(), true);
});

test('data reset aborts before deletion when a reset candidate is a real junction', (t) => {
  const f = fixture(t);
  const destination = path.join(f.root, 'junction-target');
  const sentinel = write(path.join(destination, 'keep.bin'));
  const junction = path.join(f.data, 'profiles');
  fs.symlinkSync(destination, junction, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { if (fs.existsSync(junction)) fs.unlinkSync(junction); });
  const before = snapshot([sentinel, write(path.join(f.data, 'settings.json')), seedVersion(f, '1.2.3')]);
  assert.throws(() => resetArcPowerDataSync(f.roaming), /symbolic link or reparse point/);
  assertPreserved(before);
  assert.equal(fs.lstatSync(junction).isSymbolicLink(), true);
});

test('a junction child of the protected lock root aborts before deletion of any other cache', (t) => {
  const f = fixture(t);
  const caches = seedCaches(f);
  const protectedRoot = path.join(f.local, 'rid-arc-power');
  const activeLockPath = write(path.join(protectedRoot, 'lockfile'));
  const destination = path.join(f.root, 'junction-target');
  const sentinel = write(path.join(destination, 'keep.bin'));
  const junction = path.join(protectedRoot, 'linked-child');
  fs.symlinkSync(destination, junction, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => { if (fs.existsSync(junction)) fs.unlinkSync(junction); });
  const before = snapshot([activeLockPath, sentinel, ...caches.files, ...durableFiles(f)]);
  assert.throws(() => resetArcPowerCachesSync(f.roaming, { localAppDataPath: f.local, activeLockPath }), /symbolic link or reparse point/);
  assertPreserved(before);
  assert.equal(fs.lstatSync(junction).isSymbolicLink(), true);
});
