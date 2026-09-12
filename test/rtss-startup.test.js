import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRtssStartup, createMockRtssStartup, resolveRtssExecutablePath, RTSS_STARTUP_KEY, RTSS_STARTUP_VALUE_NAME } from '../src/main/rtss-startup.js';
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
