import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const source = await readFile(new URL('../src/main/installer.js', import.meta.url), 'utf8');

// Execute production functions with OS/Electron seams, without importing the
// Electron app or touching real files, processes, registry entries or caches.
function load(startMarker, endMarker, dependencies) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start);
  const fn = source.slice(start, end).replace(/^export /, '').trim();
  return new Function(...Object.keys(dependencies), `return (${fn});`)(...Object.values(dependencies));
}
const createGuard = load('export function createInstallerOperationGuard(', '\nlet withInstallerProductLock', { path });
const productPath = path.resolve('test-fixtures', 'Roaming', 'arc-power');
const setupPath = path.resolve('test-fixtures', 'Temp', 'Setup');
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function harness() {
  const events = [];
  let userData = productPath;
  let held = false;
  let allowed = true;
  const app = {
    getPath: (name) => name === 'userData' ? userData : path.resolve('test-fixtures', name),
    setPath: (name, value) => { assert.equal(name, 'userData'); userData = value; events.push(['path', value]); },
    requestSingleInstanceLock: () => { assert.equal(userData, productPath); events.push(['acquire']); held = allowed; return held; },
    releaseSingleInstanceLock: () => { assert.equal(held, true); held = false; events.push(['release']); },
    getVersion: () => '1.2.3',
    quit: () => { events.push(['quit']); },
  };
  const guard = createGuard({ electronApp: app, waitForParentExit: async () => {} });
  app.setPath('userData', setupPath);
  events.length = 0;
  return { app, guard, events, held: () => held, allow: (value) => { allowed = value; } };
}

test('guard uses captured default identity and restores temporary session before work', async () => {
  const h = harness();
  await h.guard({}, async ({ activeLockPath }) => {
    assert.equal(h.held(), true);
    assert.equal(h.app.getPath('userData'), setupPath);
    assert.equal(activeLockPath, path.join(productPath, 'lockfile'));
  });
  assert.equal(h.held(), false);
  assert.deepEqual(h.events, [['path', productPath], ['acquire'], ['path', setupPath], ['release']]);
});

test('updater waits for its parent before requesting the product lock', async () => {
  const h = harness();
  const parent = deferred();
  const guard = createGuard({ electronApp: h.app, productUserDataPath: productPath,
    waitForParentExit: async (pid) => { assert.equal(pid, 42); await parent.promise; } });
  let started = false;
  const operation = guard({ updateParentPid: 42 }, async () => { started = true; });
  assert.equal(started, false);
  assert.deepEqual(h.events, []);
  parent.resolve();
  await operation;
  assert.equal(started, true);
  assert.equal(h.held(), false);
});

test('guard rejects overlapping install and releases after failure for UI retry', async () => {
  const h = harness();
  const gate = deferred();
  const first = h.guard({}, async () => { await gate.promise; throw new Error('copy failed'); });
  await assert.rejects(h.guard({}, async () => assert.fail('overlap ran')), /already in progress/);
  gate.resolve();
  await assert.rejects(first, /copy failed/);
  assert.equal(h.held(), false);
  await h.guard({}, async () => assert.equal(h.held(), true));
  assert.equal(h.events.filter(([event]) => event === 'release').length, 2);
});

test('lock contention fails before writes and permits retry without releasing another owner', async () => {
  const h = harness();
  h.allow(false);
  await assert.rejects(h.guard({}, async () => assert.fail('contended install ran')), /Close every Arc Power/);
  assert.equal(h.app.getPath('userData'), setupPath);
  assert.equal(h.events.some(([event]) => event === 'release'), false);
  h.allow(true);
  await h.guard({}, async () => assert.equal(h.held(), true));
});

test('parent wait failure requests no lock and permits retry', async () => {
  const h = harness();
  let fail = true;
  const guard = createGuard({ electronApp: h.app, productUserDataPath: productPath,
    waitForParentExit: async () => { if (fail) throw new Error('parent still running'); } });
  await assert.rejects(guard({ updateParentPid: 42 }, async () => assert.fail('install ran')), /parent still running/);
  assert.deepEqual(h.events, []);
  fail = false;
  await guard({ updateParentPid: 42 }, async () => assert.equal(h.held(), true));
});

function installHarness({ failAt = null } = {}) {
  const h = harness();
  const plan = { installDir: path.resolve('test-fixtures', 'Installed'), executablePath: 'installed.exe', iconPath: 'icon.ico',
    startMenuShortcutPath: 'start.lnk', desktopShortcutPath: 'desktop.lnk' };
  const locked = (event) => {
    assert.equal(h.held(), true, `${event} requires the product lock`);
    assert.equal(h.app.getPath('userData'), setupPath);
    h.events.push([event]);
    if (failAt === event) throw new Error(`${event} failed`);
  };
  const launch = async () => { assert.equal(h.held(), false); h.events.push(['launch']); };
  const dependencies = {
    path, process: { pid: 1234 }, app: h.app,
    windowsPaths: () => ({ appData: path.resolve('test-fixtures', 'Roaming'), localAppData: path.resolve('test-fixtures', 'Local') }),
    createInstallationPlan: (options) => ({ ...plan, ...options, installDir: options.installDir || plan.installDir }),
    payloadRoot: () => path.resolve('test-fixtures', 'Payload'), withInstallerProductLock: h.guard,
    powershellPath: () => 'mock-powershell', execFileAsync: async () => locked('process-check'), sendProgress: () => {},
    mkdir: async () => locked('mkdir'), copyPackagedPayload: async () => locked('copy'),
    prepareArcPowerCacheSync: (_root, _version, options) => {
      locked('cache'); assert.equal(options.forceReset, true); assert.equal(options.activeLockPath, path.join(productPath, 'lockfile'));
    },
    installRtss: async () => { locked('install-rtss'); return { ok: true, installed: true }; },
    createShortcut: async () => locked('shortcut'), rm: async () => locked('remove-shortcut'),
    writeUninstallRegistration: async () => locked('register'), refreshWindowsShellIcons: async () => locked('refresh'),
    getElevationStatus: () => ({ verified: true, elevated: false }),
    launchRtss: async () => { assert.equal(h.held(), false); h.events.push(['launch-rtss']); return { started: true }; },
    launchInstalledApp: launch,
  };
  const install = load('async function installArcPower(', '\nexport function waitForProcessExit', dependencies);
  return { ...h, install, plan, launch, dependencies };
}

test('install holds lock across copy/cache/registration and releases before RTSS and app launch', async () => {
  const h = installHarness();
  const result = await h.install(null, { installRtss: true });
  assert.equal(result.ok, true);
  const events = h.events.map(([event]) => event);
  assert.ok(events.indexOf('copy') < events.indexOf('cache'));
  assert.equal(events.filter((event) => event === 'process-check').length, 2);
  assert.ok(events.indexOf('register') < events.indexOf('release'));
  assert.ok(events.indexOf('release') < events.indexOf('launch-rtss'));
  assert.ok(events.indexOf('launch-rtss') < events.indexOf('launch'));
});
for (const failAt of ['process-check', 'copy', 'cache', 'register']) {
  test(`install releases its lock after ${failAt} failure`, async () => {
    const h = installHarness({ failAt });
    await assert.rejects(h.install(null), /failed|could not check/);
    assert.equal(h.held(), false);
    assert.equal(h.app.getPath('userData'), setupPath);
    assert.equal(h.events.some(([event]) => event === 'launch'), false);
  });
}

test('installed update launches only after installation releases the shared lock', async () => {
  const h = installHarness();
  const update = load('async function runInstalledUpdate(', '\nasync function waitForUninstallLaunchHandshake', {
    path, process: { pid: 1234 }, app: h.app, windowsPaths: h.dependencies.windowsPaths,
    readInstalledUpdateRegistration: async () => ({}), validateInstalledUpdateTarget: ({ installDir }) => ({ installDir }),
    existsSync: () => true, INSTALLED_EXECUTABLE_NAME: 'Arc Power.exe', isSafeUpdateDestination: () => true,
    createInstallationPlan: h.dependencies.createInstallationPlan, installArcPower: h.install, launchInstalledApp: h.launch,
    writeFile: async () => assert.fail('successful update wrote diagnostics'),
  });
  const result = await update({ parentPid: 42, installDir: h.plan.installDir });
  assert.equal(result.ok, true);
  assert.deepEqual(h.events.slice(-3), [['release'], ['launch'], ['quit']]);
});

test('setup captures default identity before selecting temporary userData and defers lock acquisition', () => {
  const implementation = source.slice(source.indexOf('export async function runInstallerMode('));
  assert.ok(implementation.indexOf('createInstallerOperationGuard()') < implementation.indexOf("app.setPath('userData', installerUserData)"));
  assert.doesNotMatch(implementation, /requestSingleInstanceLock/);
});
