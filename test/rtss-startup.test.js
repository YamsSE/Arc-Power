import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acquireRtssLaunchLease, createRtssStartup, createMockRtssStartup, isTrustedRtssExecutablePath, launchRtss, resolveRtssExecutablePath, RTSS_STARTUP_KEY, RTSS_STARTUP_VALUE_NAME } from '../src/main/rtss-startup.js';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { createMockStartup } from '../src/main/startup.js';

const RTSS = 'C:\\Program Files (x86)\\RivaTuner Statistics Server\\RTSS.exe';

function fakeRegistry({ value = null, exists = true } = {}) {
  const calls = [];
  const execFileAsync = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args[0] === 'query') {
      if (!value) throw { code: 1, stderr: 'The system was unable to find the specified registry key or value.' };
      return { stdout: `HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\n    ${RTSS_STARTUP_VALUE_NAME}    REG_SZ    ${value}` };
    }
    if (args[0] === 'add') { value = args[args.indexOf('/d') + 1]; return { stdout: '' }; }
    if (args[0] === 'delete') {
      if (!value) throw { code: 1 };
      value = null;
      return { stdout: '' };
    }
    return { stdout: '' };
  };
  return { execFileAsync, calls, get value() { return value; }, exists };
}

test('RTSS path resolution prefers known installed locations and supports running-image fallback', async () => {
  assert.equal(await resolveRtssExecutablePath({ platform: 'linux' }), null);
  const known = await resolveRtssExecutablePath({ platform: 'win32', env: { ProgramFiles: 'C:\\PF' }, exists: (p) => p === 'C:\\PF\\RivaTuner Statistics Server\\RTSS.exe' });
  assert.equal(known, 'C:\\PF\\RivaTuner Statistics Server\\RTSS.exe');
  const fallback = await resolveRtssExecutablePath({ platform: 'win32', env: {}, exists: () => false, getRunningProcessImagePath: async () => RTSS });
  assert.equal(fallback, RTSS);
});

test('immediate RTSS launch starts a discovered executable detached and unreferences it', async () => {
  const calls = [];
  const child = {
    once(event, handler) {
      calls.push(event);
      if (event === 'spawn') queueMicrotask(handler);
      return this;
    },
    unref() { calls.push('unref'); },
  };
  const result = await launchRtss({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\PF' },
    exists: (filePath) => filePath === 'C:\\PF\\RivaTuner Statistics Server\\RTSS.exe',
    getRunningProcessImagePath: async () => null,
    getTrustedProgramFilesRoots: async () => ['C:\\PF'],
    realpath: (filePath) => filePath,
    lstat: () => ({ isSymbolicLink: () => false }),
    spawnProcess: (...args) => { calls.push(args); return child; },
  });
  assert.equal(result.started, true);
  assert.equal(result.reason, 'started');
  assert.equal(calls.at(-1), 'unref');
  assert.equal(calls[0][0], 'C:\\PF\\RivaTuner Statistics Server\\RTSS.exe');
  assert.deepEqual(calls[0][2], { detached: true, stdio: 'ignore', windowsHide: false });
});

test('immediate RTSS launch skips an already-running process and missing paths honestly', async () => {
  let spawns = 0;
  const running = await launchRtss({
    platform: 'win32',
    getRunningProcessImagePath: async () => RTSS,
    spawnProcess: () => { spawns += 1; },
  });
  assert.deepEqual(running, { started: false, alreadyRunning: true, executablePath: RTSS, reason: 'already-running' });
  const missing = await launchRtss({
    platform: 'win32',
    env: {},
    exists: () => false,
    getRunningProcessImagePath: async () => null,
    spawnProcess: () => { spawns += 1; },
  });
  assert.equal(missing.reason, 'executable-not-found');
  assert.equal(spawns, 0);
});

test('immediate RTSS launch reports a child-process failure without throwing', async () => {
  const child = {
    once(event, handler) {
      if (event === 'error') queueMicrotask(() => handler(new Error('access denied')));
      return this;
    },
  };
  const result = await launchRtss({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\PF' },
    exists: (filePath) => filePath === 'C:\\PF\\RivaTuner Statistics Server\\RTSS.exe',
    getRunningProcessImagePath: async () => null,
    getTrustedProgramFilesRoots: async () => ['C:\\PF'],
    realpath: (filePath) => filePath,
    lstat: () => ({ isSymbolicLink: () => false }),
    spawnProcess: () => child,
  });
  assert.equal(result.reason, 'launch-failed');
  assert.match(result.detail, /access denied/);
});

test('immediate RTSS launch refuses a user-writable path by default', async () => {
  let spawns = 0;
  const localPath = 'C:\\Users\\Tester\\AppData\\Local\\RivaTuner Statistics Server\\RTSS.exe';
  const result = await launchRtss({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' },
    exists: (filePath) => filePath === localPath,
    getRunningProcessImagePath: async () => null,
    spawnProcess: () => { spawns += 1; },
  });
  assert.equal(result.reason, 'untrusted-location');
  assert.equal(spawns, 0);
});

test('trusted RTSS paths ignore caller-controlled ProgramFiles roots', () => {
  const fakeFs = { realpath: (filePath) => filePath, lstat: () => ({ isSymbolicLink: () => false }) };
  const userRoot = 'C:\\Users\\Tester\\AppData\\Local';
  assert.equal(isTrustedRtssExecutablePath(
    `${userRoot}\\RivaTuner Statistics Server\\RTSS.exe`,
    { ProgramFiles: userRoot, 'ProgramFiles(x86)': userRoot },
    ['C:\\Program Files (x86)', 'C:\\Program Files'],
    fakeFs,
  ), false);
  assert.equal(isTrustedRtssExecutablePath(
    'C:\\Program Files (x86)\\RivaTuner Statistics Server\\RTSS.exe',
    { ProgramFiles: userRoot },
    ['C:\\Program Files (x86)'],
    fakeFs,
  ), true);
});

test('trusted RTSS paths reject a parent junction or reparse point', () => {
  const junction = 'C:\\Program Files (x86)\\RivaTuner Statistics Server';
  const fakeFs = {
    realpath: (filePath) => filePath.toLowerCase() === junction.toLowerCase()
      ? 'C:\\Users\\Tester\\AppData\\Local\\RivaTuner Statistics Server'
      : filePath,
    lstat: () => ({ isSymbolicLink: () => false }),
  };
  assert.equal(isTrustedRtssExecutablePath(
    `${junction}\\RTSS.exe`,
    {},
    ['C:\\Program Files (x86)'],
    fakeFs,
  ), false);
});

test('concurrent immediate RTSS launch requests share one child process', async () => {
  let spawns = 0;
  const child = {
    once(event, handler) {
      if (event === 'spawn') queueMicrotask(handler);
      return this;
    },
    unref() {},
  };
  const options = {
    platform: 'win32',
    env: { ProgramFiles: 'C:\\PF' },
    exists: (filePath) => filePath === 'C:\\PF\\RivaTuner Statistics Server\\RTSS.exe',
    getRunningProcessImagePath: async () => null,
    getTrustedProgramFilesRoots: async () => ['C:\\PF'],
    realpath: (filePath) => filePath,
    lstat: () => ({ isSymbolicLink: () => false }),
    spawnProcess: () => { spawns += 1; return child; },
  };
  const [first, second] = await Promise.all([launchRtss(options), launchRtss(options)]);
  assert.equal(first.reason, 'started');
  assert.equal(second.reason, 'started');
  assert.equal(spawns, 1);
});

test('RTSS launch lease blocks a separate process during the probe-to-spawn window', async () => {
  let present = false;
  const fs = {
    async mkdir() {},
    async openFile() {
      if (present) throw { code: 'EEXIST' };
      present = true;
      return { async close() {} };
    },
    async statFile() {
      if (!present) throw { code: 'ENOENT' };
      return { mtimeMs: 1000 };
    },
    async rmFile() { present = false; },
  };
  const first = await acquireRtssLaunchLease({ leasePath: 'C:\\Temp\\ArcPower-rtss-launch.lock', now: () => 1000, ...fs });
  const second = await acquireRtssLaunchLease({ leasePath: 'C:\\Temp\\ArcPower-rtss-launch.lock', now: () => 1000, ...fs });
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, reason: 'launch-in-progress' });
  await first.release();
  const third = await acquireRtssLaunchLease({ leasePath: 'C:\\Temp\\ArcPower-rtss-launch.lock', now: () => 1000, ...fs });
  assert.equal(third.ok, true);
  await third.release();
});

test('RTSS adapter enables/disables an independent quoted HKCU Run value', async () => {
  const fake = fakeRegistry();
  const startup = createRtssStartup({ platform: 'win32', exists: () => true, execFileAsync: fake.execFileAsync });
  const enabled = await startup.set(true);
  assert.equal(enabled.registered, true);
  const add = fake.calls.find((call) => call.args[0] === 'add');
  assert.ok(add);
  assert.deepEqual(add.args.slice(0, 4), ['add', RTSS_STARTUP_KEY, '/v', RTSS_STARTUP_VALUE_NAME]);
  assert.equal(fake.value, `"${RTSS}"`);
  const disabled = await startup.set(false);
  assert.equal(disabled.registered, false);
  assert.equal(fake.calls.at(-2).args[0], 'delete');
});

test('RTSS adapter can remove a custom-path registration after the process exits', async () => {
  const custom = 'D:\\Tools\\RTSS\\RTSS.exe';
  const fake = fakeRegistry({ value: `"${custom}"` });
  const startup = createRtssStartup({
    platform: 'win32',
    env: {},
    exists: (filePath) => filePath === custom,
    getRunningProcessImagePath: async () => null,
    execFileAsync: fake.execFileAsync,
  });
  const current = await startup.get();
  assert.equal(current.executablePath, custom);
  assert.equal(current.registered, true);
  const removed = await startup.set(false);
  assert.equal(removed.valueExists, false);
});

test('RTSS adapter exposes process availability separately from an installed path', async () => {
  const startup = createRtssStartup({
    platform: 'win32',
    env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
    exists: () => true,
    getRunningProcessImagePath: async () => null,
    execFileAsync: fakeRegistry().execFileAsync,
  });
  assert.equal((await startup.get()).executablePath, RTSS);
  assert.equal(await startup.isRunning(), false);
});

test('RTSS adapter exposes a stale custom registration as removable after uninstall', async () => {
  const custom = 'D:\\Tools\\RTSS\\RTSS.exe';
  const fake = fakeRegistry({ value: `"${custom}"` });
  const startup = createRtssStartup({
    platform: 'win32',
    env: {},
    exists: () => false,
    getRunningProcessImagePath: async () => null,
    execFileAsync: fake.execFileAsync,
  });
  const stale = await startup.get();
  assert.equal(stale.capable, false);
  assert.equal(stale.valueExists, true);
  assert.equal(stale.registeredPath, custom);
  const removed = await startup.set(false);
  assert.equal(removed.valueExists, false);
});

test('RTSS enabling fails honestly when executable is missing', async () => {
  const fake = fakeRegistry();
  const startup = createRtssStartup({ platform: 'win32', exists: () => false, getRunningProcessImagePath: async () => null, execFileAsync: fake.execFileAsync });
  await assert.rejects(() => startup.set(true), /RTSS\.exe was not found/);
  assert.equal(fake.calls.some((call) => call.args[0] === 'add'), false);
});

test('RTSS IPC validates state and preserves rtssOnBoot through unrelated settings saves', async () => {
  let settings = { rtssOnBoot: false, startWithWindows: false, ocOnBoot: false, activeProfileId: null };
  const saved = [];
  const store = { loadSettings: async () => ({ ...settings }), loadProfiles: async () => [], saveSettings: async (next) => { settings = { ...next }; saved.push(settings); } };
  const rtssStartup = createMockRtssStartup();
  const { handlers } = createIpcHandlers({ backend: {}, store, emit: () => {}, rtssStartup });
  await assert.rejects(() => handlers.rtssStartupSet('yes'), /enabled must be a boolean/);
  const on = await handlers.rtssStartupSet(true);
  assert.equal(on.rtssOnBoot, true);
  assert.equal(settings.rtssOnBoot, true);
  await handlers['profiles-settings-save']({ theme: 'dark' });
  assert.equal(saved.at(-1).rtssOnBoot, true);
  assert.equal((await handlers.rtssStartupGet()).registered, true);
});

test('RTSS IPC serializes its setting with unrelated profile-settings saves', async () => {
  let settings = { rtssOnBoot: false, startWithWindows: false, ocOnBoot: false, activeProfileId: null };
  const store = {
    loadSettings: async () => ({ ...settings }),
    loadProfiles: async () => [],
    saveSettings: async (next) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settings = { ...next };
    },
  };
  const { handlers } = createIpcHandlers({ backend: {}, store, emit: () => {}, rtssStartup: createMockRtssStartup() });
  await Promise.all([
    handlers.rtssStartupSet(true),
    handlers['profiles-settings-save']({ theme: 'dark' }),
  ]);
  assert.equal(settings.rtssOnBoot, true);
  const off = await handlers.rtssStartupSet(false);
  assert.equal(off.rtssOnBoot, false);
  assert.equal(settings.rtssOnBoot, false);
});

test('RTSS IPC never changes Arc Power startup registration', async () => {
  const arcStartup = createMockStartup();
  const store = {
    loadSettings: async () => ({ rtssOnBoot: false, startWithWindows: false, ocOnBoot: false, activeProfileId: null }),
    loadProfiles: async () => [],
    saveSettings: async () => {},
  };
  const { handlers } = createIpcHandlers({ backend: {}, store, emit: () => {}, startup: arcStartup, rtssStartup: createMockRtssStartup() });
  await handlers.rtssStartupSet(true);
  assert.equal((await arcStartup.get()).valueExists, false);
});

test('mock RTSS startup is independent from Arc Power startup adapter', async () => {
  const startup = createMockRtssStartup({ available: false });
  await assert.rejects(() => startup.set(true), /RTSS\.exe was not found/);
  assert.equal((await startup.get()).registered, false);
});
