import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('installer leaves shared cache preparation to the installed app startup', async () => {
  const [installer, main] = await Promise.all([
    readFile(new URL('../src/main/installer.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/main/main.js', import.meta.url), 'utf8'),
  ]);

  const installStart = installer.indexOf('async function installArcPower(');
  const installEnd = installer.indexOf('\nasync function ', installStart + 1);
  assert.notEqual(installStart, -1, 'installer install function exists');
  assert.notEqual(installEnd, -1, 'installer install function has a clear boundary');
  const installImplementation = installer.slice(installStart, installEnd);

  assert.doesNotMatch(installer, /import\s*\{[^}]*prepareArcPowerCacheSync[^}]*\}\s*from\s*['"]\.\/cache-lifecycle\.js['"]/);
  assert.doesNotMatch(installImplementation, /prepareArcPowerCacheSync|resetCacheDirectorySync/);

  const startupCacheGate = main.indexOf('// The version-aware cache gate must run before Electron selects userData.');
  const startupInstanceLock = main.lastIndexOf('requestSingleInstanceLock()', startupCacheGate);
  const startupCachePreparation = main.indexOf('prepareArcPowerCacheSync(app.getPath(\'appData\'), app.getVersion(), {', startupCacheGate);
  const startupUserDataSelection = main.indexOf('app.setPath(\'userData\', cachePath);', startupCachePreparation);
  assert.ok(startupCacheGate !== -1, 'startup documents the version-aware cache gate');
  assert.ok(startupInstanceLock !== -1 && startupInstanceLock < startupCachePreparation,
    'startup acquires its single-instance lock before version-aware cache preparation');
  assert.ok(startupCachePreparation > startupCacheGate && startupCachePreparation < startupUserDataSelection,
    'startup retains version-aware cache preparation before selecting userData');
});
