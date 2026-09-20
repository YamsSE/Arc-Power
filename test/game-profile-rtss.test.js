import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { createRtssProfileController } from '../src/main/rtss-profile.js';

test('disabling a RTSS-owned game limiter also clears the native driver scope', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = {
    id: 0,
    deviceKey: 'pci:arc-b580-test',
    name: 'Intel Arc B580',
    deviceName: 'Intel Arc B580',
    pciVendorId: '0x8086',
    pciDeviceId: '0x0000e20b',
  };
  const nativeCalls = [];
  const rtssCalls = [];
  const previousAssignment = {
    deviceKey: device.deviceKey,
    deviceName: device.deviceName,
    enabled: true,
    tuningProfileId: null,
    graphics: { frameLimit: { enabled: true, value: 60 } },
  };
  const gameProfiles = {
    async loadCatalog() {
      return {
        catalog: [{ exePath: executablePath.toLowerCase(), processName: 'notepad.exe', displayName: 'Notepad' }],
        settings: [{ exePath: executablePath.toLowerCase(), gpuProfiles: [previousAssignment] }],
      };
    },
    async saveSettings(item) { return item; },
  };
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings(...args) {
        nativeCalls.push(args);
        return { ok: true, perControl: {} };
      },
    },
    store: {
      async loadSettings() { return { deviceId: device.id }; },
      async loadProfiles() { return []; },
    },
    gameProfiles,
    rtssFrameLimiter: {
      async applyFrameLimit(options) {
        rtssCalls.push(options);
        return { ok: true, used: true, ...(options.removeProfile ? { removed: true, flagRestored: true } : {}) };
      },
    },
    emit() {},
  });

  const response = await handlers['game-settings-save']({
    exePath: executablePath,
    deviceKey: device.deviceKey,
    deviceName: device.deviceName,
    enabled: false,
    graphics: { frameLimit: { enabled: false, value: 60 } },
  });

  assert.equal(response.apply.ok, true);
  assert.deepEqual(nativeCalls, [[device.id, executablePath.toLowerCase(), {}, false]]);
  assert.deepEqual(rtssCalls, [{ enabled: false, value: 60, executablePath: executablePath.toLowerCase(), removeProfile: true }]);
});

test('failed disable restores the previously enabled RTSS limiter', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' };
  const profiles = new Map([['notepad.exe', { limit: 60, denominator: 1 }]]);
  let currentProfile = '';
  let flags = 0;
  const functions = {
    LoadProfile(name) { currentProfile = name.toLowerCase(); },
    SaveProfile() {},
    GetProfileProperty(name, buffer) {
      const profile = profiles.get(currentProfile) ?? { limit: 0, denominator: 1 };
      const value = name === 'FramerateLimit' ? profile.limit : name === 'FramerateLimitDenominator' ? profile.denominator : null;
      if (value === null) return false;
      buffer.writeUInt32LE(value >>> 0, 0);
      return true;
    },
    SetProfileProperty(name, buffer) {
      const profile = profiles.get(currentProfile) ?? { limit: 0, denominator: 1 };
      if (name === 'FramerateLimit') profile.limit = buffer.readUInt32LE(0);
      if (name === 'FramerateLimitDenominator') profile.denominator = buffer.readUInt32LE(0);
      profiles.set(currentProfile, profile);
      return true;
    },
    UpdateProfiles() {},
    SetFlags(_mask, value) { if (value !== 0) flags = value; return flags; },
    EnumProfiles(buffer, size) {
      const text = `${[...profiles.keys()].join(',')}\0`;
      const bytes = Buffer.byteLength(text);
      if (!buffer || size === 0) return bytes;
      Buffer.from(text, 'utf8').copy(buffer, 0, 0, Math.min(size, bytes));
      return bytes;
    },
    DeleteProfile(name) { profiles.delete(name.toLowerCase()); },
  };
  const rtssFrameLimiter = createRtssProfileController({
    platform: 'win32',
    executablePath: 'C:\\Program Files\\RTSS\\RTSS.exe',
    exists: () => true,
    load: () => ({ func: (name) => functions[name] }),
  });
  await rtssFrameLimiter.applyFrameLimit({ enabled: true, value: 60, executablePath });
  let nativeAttempts = 0;
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings() {
        nativeAttempts += 1;
        return nativeAttempts === 1
          ? { ok: false, perControl: { lowLatency: { ok: false, errorCode: 'io-failed' } } }
          : { ok: true, perControl: {} };
      },
    },
    store: { async loadSettings() { return { deviceId: device.id }; }, async loadProfiles() { return []; } },
    gameProfiles: {
      async loadCatalog() {
        return {
          catalog: [{ exePath: executablePath.toLowerCase() }],
          settings: [{ exePath: executablePath.toLowerCase(), gpuProfiles: [{
            deviceKey: device.deviceKey,
            enabled: true,
            graphics: { frameLimit: { enabled: true, value: 60 } },
          }] }],
        };
      },
      async saveSettings() { throw new Error('sidecar save must not run after native failure'); },
    },
    rtssFrameLimiter,
    emit() {},
  });

  const response = await handlers['game-settings-save']({
    exePath: executablePath,
    deviceKey: device.deviceKey,
    enabled: false,
    graphics: { frameLimit: { enabled: false, value: 60 }, lowLatency: 'on' },
  });

  assert.equal(response.apply.ok, false);
  assert.equal(response.apply.cleanupPending, undefined);
  assert.deepEqual(profiles.get('notepad.exe'), { limit: 60, denominator: 1 });
});

test('failed native game-profile apply does not persist the sidecar and rolls RTSS back', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' };
  let saveCalls = 0;
  const rtssCalls = [];
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings() { return { ok: false, perControl: { lowLatency: { ok: false, errorCode: 'io-failed' } } }; },
    },
    store: { async loadSettings() { return { deviceId: 0 }; }, async loadProfiles() { return []; } },
    gameProfiles: {
      async loadCatalog() { return { catalog: [{ exePath: executablePath.toLowerCase() }], settings: [] }; },
      async saveSettings() { saveCalls += 1; },
    },
    rtssFrameLimiter: {
      async applyFrameLimit(options) {
        rtssCalls.push(options);
        return {
          ok: true,
          used: true,
          enabled: options.enabled === true,
          ...(options.removeProfile ? { removed: true, flagRestored: true } : {}),
        };
      },
    },
    emit() {},
  });

  const response = await handlers['game-settings-save']({
    exePath: executablePath,
    deviceKey: device.deviceKey,
    enabled: true,
    graphics: { frameLimit: { enabled: true, value: 60 }, lowLatency: 'on' },
  });

  assert.equal(response.apply.ok, false);
  assert.equal(saveCalls, 0, 'a failed native apply must not be persisted');
  assert.equal(rtssCalls.length, 2, 'successful RTSS work must be rolled back when native apply fails');
  assert.equal(rtssCalls[1].removeProfile, true);
});

test('RTSS cleanup-pending failure blocks native fallback and sidecar persistence', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' };
  const nativeCalls = [];
  let saveCalls = 0;
  const previousAssignment = {
    deviceKey: device.deviceKey,
    enabled: true,
    tuningProfileId: null,
    graphics: { frameLimit: { enabled: true, value: 60 } },
  };
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings(...args) { nativeCalls.push(args); return { ok: true, perControl: {} }; },
    },
    store: { async loadSettings() { return { deviceId: 0 }; }, async loadProfiles() { return []; } },
    gameProfiles: {
      async loadCatalog() { return { catalog: [{ exePath: executablePath.toLowerCase() }], settings: [{ exePath: executablePath.toLowerCase(), gpuProfiles: [previousAssignment] }] }; },
      async saveSettings() { saveCalls += 1; },
    },
    rtssFrameLimiter: {
      async applyFrameLimit() { return { ok: false, used: false, cleanupPending: true, error: 'ownership snapshot unavailable' }; },
    },
    emit() {},
  });

  const response = await handlers['game-settings-save']({
    exePath: executablePath,
    deviceKey: device.deviceKey,
    enabled: false,
    graphics: { frameLimit: { enabled: false, value: 60 } },
  });

  assert.equal(response.apply.ok, false);
  assert.equal(response.apply.cleanupPending, true);
  assert.equal(nativeCalls.length, 0, 'cleanup uncertainty must not fall through to native fallback');
  assert.equal(saveCalls, 0, 'cleanup uncertainty must not persist the sidecar');
});

test('partially failed native game-profile apply restores the previous driver scope', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' };
  const nativeCalls = [];
  const rtssCalls = [];
  let nativeAttempts = 0;
  let saveCalls = 0;
  const previousAssignment = {
    deviceKey: device.deviceKey,
    enabled: true,
    tuningProfileId: null,
    graphics: { lowLatency: 'off', frameLimit: { enabled: true, value: 60 } },
  };
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings(...args) {
        nativeCalls.push(args);
        nativeAttempts += 1;
        if (nativeAttempts === 1) {
          return { ok: false, perControl: { lowLatency: { ok: false, errorCode: 'io-failed' } }, message: 'native write partially failed' };
        }
        return { ok: true, perControl: {} };
      },
    },
    store: { async loadSettings() { return { deviceId: 0 }; }, async loadProfiles() { return []; } },
    gameProfiles: {
      async loadCatalog() {
        return { catalog: [{ exePath: executablePath.toLowerCase() }], settings: [{ exePath: executablePath.toLowerCase(), gpuProfiles: [previousAssignment] }] };
      },
      async saveSettings() { saveCalls += 1; },
    },
    rtssFrameLimiter: {
      async applyFrameLimit(options) {
        rtssCalls.push(options);
        return {
          ok: true,
          used: true,
          enabled: options.enabled === true,
          ...(options.removeProfile ? { removed: true, flagRestored: true } : {}),
        };
      },
    },
    emit() {},
  });

  const response = await handlers['game-settings-save']({
    exePath: executablePath,
    deviceKey: device.deviceKey,
    enabled: true,
    graphics: { frameLimit: { enabled: true, value: 120 }, lowLatency: 'on' },
  });

  assert.equal(response.apply.ok, false);
  assert.equal(response.apply.cleanupPending, undefined);
  assert.equal(saveCalls, 0);
  assert.equal(nativeCalls.length, 2, 'the partial native write must be followed by a native rollback');
  assert.deepEqual(nativeCalls[1], [device.id, executablePath.toLowerCase(), { lowLatency: 'off' }, true]);
  assert.equal(rtssCalls.length, 3, 'the RTSS write must also be rolled back');
  assert.equal(rtssCalls[1].enabled, false);
  assert.equal(rtssCalls[1].removeProfile, true);
  assert.equal(rtssCalls[2].enabled, true);
});

test('partial native failure restores a pre-existing RTSS profile instead of deleting it', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' };
  const profiles = new Map([['notepad.exe', { limit: 60, denominator: 2 }]]);
  let currentProfile = '';
  let flags = 0;
  const functions = {
    LoadProfile(name) { currentProfile = name.toLowerCase(); },
    SaveProfile() {},
    GetProfileProperty(name, buffer) {
      const profile = profiles.get(currentProfile) ?? { limit: 0, denominator: 1 };
      const value = name === 'FramerateLimit' ? profile.limit : name === 'FramerateLimitDenominator' ? profile.denominator : null;
      if (value === null) return false;
      buffer.writeUInt32LE(value >>> 0, 0);
      return true;
    },
    SetProfileProperty(name, buffer) {
      const profile = profiles.get(currentProfile) ?? { limit: 0, denominator: 1 };
      if (name === 'FramerateLimit') profile.limit = buffer.readUInt32LE(0);
      if (name === 'FramerateLimitDenominator') profile.denominator = buffer.readUInt32LE(0);
      profiles.set(currentProfile, profile);
      return true;
    },
    UpdateProfiles() {},
    SetFlags(_mask, value) { if (value !== 0) flags = value; return flags; },
    EnumProfiles(buffer, size) {
      const text = `${[...profiles.keys()].join(',')}\0`;
      const bytes = Buffer.byteLength(text);
      if (!buffer || size === 0) return bytes;
      Buffer.from(text, 'utf8').copy(buffer, 0, 0, Math.min(size, bytes));
      return bytes;
    },
    DeleteProfile(name) { profiles.delete(name.toLowerCase()); },
  };
  const rtssFrameLimiter = createRtssProfileController({
    platform: 'win32',
    executablePath: 'C:\\Program Files\\RTSS\\RTSS.exe',
    exists: () => true,
    load: () => ({ func: (name) => functions[name] }),
  });
  const nativeCalls = [];
  let nativeAttempts = 0;
  const previousAssignment = {
    deviceKey: device.deviceKey,
    enabled: true,
    tuningProfileId: null,
    graphics: { lowLatency: 'off', frameLimit: { enabled: true, value: 60 } },
  };
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings(...args) {
        nativeCalls.push(args);
        nativeAttempts += 1;
        return nativeAttempts === 1
          ? { ok: false, message: 'native write partially failed', perControl: {} }
          : { ok: true, perControl: {} };
      },
    },
    store: { async loadSettings() { return { deviceId: device.id }; }, async loadProfiles() { return []; } },
    gameProfiles: {
      async loadCatalog() { return { catalog: [{ exePath: executablePath.toLowerCase() }], settings: [{ exePath: executablePath.toLowerCase(), gpuProfiles: [previousAssignment] }] }; },
      async saveSettings() { throw new Error('sidecar save must not run after native failure'); },
    },
    rtssFrameLimiter,
    emit() {},
  });

  const response = await handlers['game-settings-save']({
    exePath: executablePath,
    deviceKey: device.deviceKey,
    enabled: true,
    graphics: { frameLimit: { enabled: true, value: 144 }, lowLatency: 'on' },
  });

  assert.equal(response.apply.ok, false);
  assert.equal(nativeCalls.length, 2);
  assert.deepEqual(nativeCalls[1], [device.id, executablePath.toLowerCase(), { lowLatency: 'off' }, true]);
  assert.deepEqual(profiles.get('notepad.exe'), { limit: 60, denominator: 2 });
});

test('deleting a game profile clears native scope before removing the sidecar', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' };
  const nativeCalls = [];
  let deleted = false;
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings(...args) { nativeCalls.push(args); return { ok: true, perControl: {} }; },
    },
    store: { async loadSettings() { return { deviceId: 0 }; } },
    gameProfiles: {
      async loadCatalog() {
        return {
          catalog: [{ exePath: executablePath.toLowerCase() }],
          settings: [{ exePath: executablePath.toLowerCase(), gpuProfiles: [{ deviceKey: device.deviceKey, enabled: true, graphics: { frameLimit: { enabled: true, value: 60 } } }] }],
        };
      },
      async deleteSettings() { deleted = true; return { catalog: [], settings: [] }; },
    },
    rtssFrameLimiter: { async applyFrameLimit(options) { return { ok: true, used: true, ...(options.removeProfile ? { removed: true, flagRestored: true } : {}) }; } },
    emit() {},
  });

  await handlers['game-settings-delete']({ exePath: executablePath });
  assert.deepEqual(nativeCalls, [[device.id, executablePath.toLowerCase(), {}, false]]);
  assert.equal(deleted, true);
});

test('game-profile deletion compensates earlier GPU cleanup when a later GPU fails', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const devices = [
    { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' },
    { id: 1, deviceKey: 'pci:arc-a770-test', name: 'Intel Arc A770' },
  ];
  const nativeCalls = [];
  let deleted = false;
  const assignments = devices.map((device) => ({
    deviceKey: device.deviceKey,
    enabled: true,
    graphics: { lowLatency: 'on' },
  }));
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return devices; },
      async getDeviceTarget(deviceId) { return devices.find((device) => device.id === deviceId) ?? null; },
      async setGameProfileSettings(...args) {
        nativeCalls.push(args);
        return nativeCalls.length === 2
          ? { ok: false, message: 'second GPU cleanup failed' }
          : { ok: true, perControl: {} };
      },
    },
    store: { async loadSettings() { return { deviceId: 0 }; } },
    gameProfiles: {
      async loadCatalog() { return { catalog: [{ exePath: executablePath.toLowerCase() }], settings: [{ exePath: executablePath.toLowerCase(), gpuProfiles: assignments }] }; },
      async deleteSettings() { deleted = true; return {}; },
    },
    emit() {},
  });

  await assert.rejects(
    handlers['game-settings-delete']({ exePath: executablePath }),
    /second GPU cleanup failed/,
  );
  assert.equal(deleted, false);
  assert.deepEqual(nativeCalls, [
    [0, executablePath.toLowerCase(), {}, false],
    [1, executablePath.toLowerCase(), {}, false],
    [1, executablePath.toLowerCase(), { lowLatency: 'on' }, true],
    [0, executablePath.toLowerCase(), { lowLatency: 'on' }, true],
  ]);
});

test('game-profile deletion keeps the sidecar when RTSS cleanup is unverified', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' };
  const nativeCalls = [];
  let deleted = false;
  const assignment = { deviceKey: device.deviceKey, enabled: true, graphics: { frameLimit: { enabled: true, value: 60 } } };
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings(...args) { nativeCalls.push(args); return { ok: true, perControl: {} }; },
    },
    store: { async loadSettings() { return { deviceId: 0 }; } },
    gameProfiles: {
      async loadCatalog() { return { catalog: [{ exePath: executablePath.toLowerCase() }], settings: [{ exePath: executablePath.toLowerCase(), gpuProfiles: [assignment] }] }; },
      async deleteSettings() { deleted = true; return {}; },
    },
    rtssFrameLimiter: {
      async applyFrameLimit() { return { ok: true, used: true, removed: true, flagRestored: false, error: 'limiter flag rollback was not verified' }; },
    },
    emit() {},
  });

  await assert.rejects(handlers['game-settings-delete']({ exePath: executablePath }), /RTSS cleanup failed/);
  assert.equal(deleted, false);
  assert.equal(nativeCalls.length, 2, 'native cleanup is compensated when RTSS removal is unverified');
  assert.deepEqual(nativeCalls[1], [device.id, executablePath.toLowerCase(), assignment.graphics, true]);
});

test('game-profile deletion restores runtime and sidecar when persistence deletion fails', async () => {
  const executablePath = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe');
  const device = { id: 0, deviceKey: 'pci:arc-b580-test', name: 'Intel Arc B580' };
  const assignment = { deviceKey: device.deviceKey, enabled: true, graphics: { lowLatency: 'on' } };
  const nativeCalls = [];
  let restoredSettings = null;
  const existing = { exePath: executablePath.toLowerCase(), gpuProfiles: [assignment] };
  const { handlers } = createIpcHandlers({
    backend: {
      async listDevices() { return [device]; },
      async getDeviceTarget() { return device; },
      async setGameProfileSettings(...args) { nativeCalls.push(args); return { ok: true, perControl: {} }; },
    },
    store: { async loadSettings() { return { deviceId: 0 }; } },
    gameProfiles: {
      async loadCatalog() { return { catalog: [{ exePath: executablePath.toLowerCase() }], settings: [existing] }; },
      async deleteSettings() { throw new Error('disk became unavailable'); },
      async saveSettings(item) { restoredSettings = item; return item; },
    },
    emit() {},
  });

  await assert.rejects(
    handlers['game-settings-delete']({ exePath: executablePath }),
    /persistence failed/,
  );
  assert.deepEqual(nativeCalls, [
    [device.id, executablePath.toLowerCase(), {}, false],
    [device.id, executablePath.toLowerCase(), assignment.graphics, true],
  ]);
  assert.deepEqual(restoredSettings, existing);
});
