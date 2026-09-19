import test from 'node:test';
import assert from 'node:assert/strict';
import { createRtssProfileController } from '../src/main/rtss-profile.js';

function makeController({ deleteWorks = true, includeGameProfile = true, failDenominatorWrite = false } = {}) {
  const profiles = new Map(includeGameProfile ? [['game.exe', { limit: 60, denominator: 1 }]] : []);
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
      if (name === 'FramerateLimitDenominator' && failDenominatorWrite) return false;
      const profile = profiles.get(currentProfile) ?? { limit: 0, denominator: 1 };
      if (name === 'FramerateLimit') profile.limit = buffer.readUInt32LE(0);
      if (name === 'FramerateLimitDenominator') profile.denominator = buffer.readUInt32LE(0);
      profiles.set(currentProfile, profile);
      return true;
    },
    UpdateProfiles() {},
    SetFlags(_mask, value) {
      if (value !== 0) flags = value;
      return flags;
    },
    EnumProfiles(buffer, size) {
      const text = [...profiles.keys()].join(',') + (profiles.size > 0 ? '\0' : '');
      const bytes = Buffer.byteLength(text);
      if (!buffer || size === 0) return bytes;
      Buffer.from(text, 'utf8').copy(buffer, 0, 0, Math.min(size, bytes));
      return bytes;
    },
    DeleteProfile(name) { if (deleteWorks) profiles.delete(name.toLowerCase()); },
  };
  const controller = createRtssProfileController({
    platform: 'win32',
    executablePath: 'C:\\Program Files\\RTSS\\RTSS.exe',
    exists: () => true,
    load: () => ({ func: (name) => functions[name] }),
  });
  return { controller, profiles };
}

test('RTSS profile removal is verified before reporting success', async () => {
  const { controller, profiles } = makeController({ includeGameProfile: false });
  const applied = await controller.applyFrameLimit({ enabled: true, value: 120, executablePath: 'C:\\Games\\game.exe' });
  const result = await controller.applyFrameLimit({ enabled: false, executablePath: 'C:\\Games\\game.exe', removeProfile: true, rollbackToken: applied.rollbackToken });
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(profiles.has('game.exe'), false);
});

test('RTSS profile removal fails honestly when the profile remains', async () => {
  const { controller, profiles } = makeController({ deleteWorks: false, includeGameProfile: false });
  const applied = await controller.applyFrameLimit({ enabled: true, value: 120, executablePath: 'C:\\Games\\game.exe' });
  const result = await controller.applyFrameLimit({ enabled: false, executablePath: 'C:\\Games\\game.exe', removeProfile: true, rollbackToken: applied.rollbackToken });
  assert.equal(result.ok, false);
  assert.equal(result.used, false);
  assert.equal(profiles.has('game.exe'), true);
});

test('RTSS rollback restores a pre-existing profile and exact denominator', async () => {
  const { controller, profiles } = makeController();
  profiles.set('game.exe', { limit: 60, denominator: 2 });
  const applied = await controller.applyFrameLimit({ enabled: true, value: 144, executablePath: 'C:\\Games\\game.exe' });
  const result = await controller.applyFrameLimit({ enabled: false, executablePath: 'C:\\Games\\game.exe', removeProfile: true, rollbackToken: applied.rollbackToken });
  assert.equal(result.ok, true);
  assert.equal(result.removed, true);
  assert.equal(result.profileDeleted, false);
  assert.deepEqual(profiles.get('game.exe'), { limit: 60, denominator: 2 });
});

test('RTSS graphics transaction restore preserves the exact global denominator and flag state', async () => {
  const { controller, profiles } = makeController({ includeGameProfile: false });
  profiles.set('', { limit: 60, denominator: 2 });
  const applied = await controller.applyFrameLimit({ enabled: true, value: 144 });
  assert.equal(applied.ok, true);
  assert.ok(applied.restoreToken);
  assert.deepEqual(profiles.get(''), { limit: 144, denominator: 1 });
  const restored = await controller.restoreFrameLimit(applied.restoreToken);
  assert.equal(restored.ok, true);
  assert.deepEqual(profiles.get(''), { limit: 60, denominator: 2 });
});

test('RTSS cleanup refuses to delete an unowned profile after restart', async () => {
  const { controller, profiles } = makeController();
  const result = await controller.applyFrameLimit({ enabled: false, executablePath: 'C:\\Games\\game.exe', removeProfile: true });
  assert.equal(result.ok, false);
  assert.equal(result.cleanupPending, true);
  assert.equal(profiles.has('game.exe'), true);
});

test('RTSS rollback restores a limiter write when the later denominator write fails', async () => {
  const { controller, profiles } = makeController({ failDenominatorWrite: true });
  profiles.set('game.exe', { limit: 60, denominator: 2 });
  const result = await controller.applyFrameLimit({ enabled: true, value: 144, executablePath: 'C:\\Games\\game.exe' });
  assert.equal(result.ok, false);
  assert.equal(result.used, false);
  assert.equal(result.cleanupPending, undefined);
  assert.deepEqual(profiles.get('game.exe'), { limit: 60, denominator: 2 });
});

test('RTSS defers shared limiter-flag restore while another owned profile remains active', async () => {
  const { controller, profiles } = makeController({ includeGameProfile: false });
  const first = await controller.applyFrameLimit({ enabled: true, value: 120, executablePath: 'C:\\Games\\first.exe' });
  const second = await controller.applyFrameLimit({ enabled: true, value: 144, executablePath: 'C:\\Games\\second.exe' });

  const firstRemoved = await controller.applyFrameLimit({
    enabled: false,
    executablePath: 'C:\\Games\\first.exe',
    removeProfile: true,
    rollbackToken: first.rollbackToken,
  });
  assert.equal(firstRemoved.ok, true);
  assert.equal(firstRemoved.removed, true);
  assert.equal(firstRemoved.flagRestored, false);
  assert.equal(firstRemoved.flagRestorationDeferred, true);
  assert.equal(profiles.has('first.exe'), false);
  assert.equal(profiles.has('second.exe'), true);

  const secondRemoved = await controller.applyFrameLimit({
    enabled: false,
    executablePath: 'C:\\Games\\second.exe',
    removeProfile: true,
    rollbackToken: second.rollbackToken,
  });
  assert.equal(secondRemoved.ok, true);
  assert.equal(secondRemoved.removed, true);
  assert.equal(secondRemoved.flagRestored, true);
  assert.equal(secondRemoved.flagRestorationDeferred, undefined);
  assert.equal(profiles.has('second.exe'), false);
});
