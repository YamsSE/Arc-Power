import test from 'node:test';
import assert from 'node:assert/strict';
import { createRtssProfileController } from '../src/main/rtss-profile.js';

function makeController({ deleteWorks = true, includeGameProfile = true, failDenominatorWrite = false, initialFlags = 0, discardUnsavedOnLoad = false } = {}) {
  const profiles = new Map(includeGameProfile ? [['game.exe', { limit: 60, denominator: 1 }]] : []);
  let currentProfile = '';
  let workingProfile = null;
  let flags = initialFlags;
  let profileWriteCalls = 0;
  const functions = {
    LoadProfile(name) {
      currentProfile = name.toLowerCase();
      if (discardUnsavedOnLoad) {
        const saved = profiles.get(currentProfile) ?? { limit: 0, denominator: 1 };
        workingProfile = { ...saved };
      }
    },
    SaveProfile(name) {
      if (discardUnsavedOnLoad && currentProfile === name.toLowerCase() && workingProfile) {
        profiles.set(currentProfile, { ...workingProfile });
      }
    },
    GetProfileProperty(name, buffer) {
      const profile = discardUnsavedOnLoad
        ? workingProfile ?? { limit: 0, denominator: 1 }
        : profiles.get(currentProfile) ?? { limit: 0, denominator: 1 };
      const value = name === 'FramerateLimit' ? profile.limit : name === 'FramerateLimitDenominator' ? profile.denominator : null;
      if (value === null) return false;
      buffer.writeUInt32LE(value >>> 0, 0);
      return true;
    },
    SetProfileProperty(name, buffer) {
      profileWriteCalls += 1;
      if (name === 'FramerateLimitDenominator' && failDenominatorWrite) return false;
      const profile = discardUnsavedOnLoad
        ? workingProfile ?? { limit: 0, denominator: 1 }
        : profiles.get(currentProfile) ?? { limit: 0, denominator: 1 };
      if (name === 'FramerateLimit') profile.limit = buffer.readUInt32LE(0);
      if (name === 'FramerateLimitDenominator') profile.denominator = buffer.readUInt32LE(0);
      if (discardUnsavedOnLoad) workingProfile = profile;
      else profiles.set(currentProfile, profile);
      return true;
    },
    UpdateProfiles() {},
    SetFlags(andMask, xorMask) {
      flags = ((flags & andMask) ^ xorMask) >>> 0;
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
  return { controller, profiles, get flags() { return flags; }, get profileWriteCalls() { return profileWriteCalls; } };
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

test('RTSS conditional global apply refuses an externally changed state without writing', async () => {
  const fixture = makeController({ includeGameProfile: false });
  fixture.profiles.set('', { limit: 60, denominator: 2 });
  const result = await fixture.controller.applyFrameLimit({
    enabled: true,
    value: 120,
    expectedState: { limit: 60, denominator: 1, limiterEnabled: true },
  });
  assert.equal(result.ok, false);
  assert.equal(result.used, false);
  assert.equal(result.conflict, true);
  assert.equal(result.errorCode, 'external-change');
  assert.deepEqual(result.observedState, { limit: 60, denominator: 2, limiterEnabled: true });
  assert.equal(fixture.profileWriteCalls, 0);
  assert.deepEqual(fixture.profiles.get(''), { limit: 60, denominator: 2 });
  assert.equal(fixture.flags & 4, 0);
});

test('RTSS durable global recovery restores exact raw denominator and limiter flag', async () => {
  const fixture = makeController({ includeGameProfile: false });
  fixture.profiles.set('', { limit: 144, denominator: 1 });
  await fixture.controller.applyFrameLimit({ enabled: true, value: 144 });
  const current = { limit: 144, denominator: 1, limiterEnabled: true };
  const result = await fixture.controller.restoreFrameLimitState({
    expectedState: current,
    state: { limit: 60, denominator: 3, limiterEnabled: false },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.profiles.get(''), { limit: 60, denominator: 3 });
  assert.equal(fixture.flags & 4, 4);
  assert.deepEqual(result.observedState, { limit: 60, denominator: 3, limiterEnabled: false });
});

test('RTSS recovery after restart preserves the shared limiter for saved per-game caps', async () => {
  const fixture = makeController({ includeGameProfile: false });
  fixture.profiles.set('', { limit: 144, denominator: 1 });
  fixture.profiles.set('game.exe', { limit: 60, denominator: 1 });
  const result = await fixture.controller.restoreFrameLimitState({
    expectedState: { limit: 144, denominator: 1, limiterEnabled: true },
    state: { limit: 60, denominator: 3, limiterEnabled: false },
  });

  assert.equal(result.ok, true);
  assert.equal(result.flagRestorationDeferred, true);
  assert.deepEqual(fixture.profiles.get(''), { limit: 60, denominator: 3 });
  assert.equal(fixture.flags & 4, 0, 'the RTSS shared limiter remains enabled for saved game profiles');
  assert.deepEqual(result.observedState, { limit: 60, denominator: 3, limiterEnabled: true });
});

test('RTSS recovery scans saved game caps before global writes that profile switches could discard', async () => {
  const fixture = makeController({ includeGameProfile: false, discardUnsavedOnLoad: true });
  fixture.profiles.set('', { limit: 144, denominator: 1 });
  fixture.profiles.set('game.exe', { limit: 60, denominator: 1 });
  const result = await fixture.controller.restoreFrameLimitState({
    expectedState: { limit: 144, denominator: 1, limiterEnabled: true },
    state: { limit: 60, denominator: 3, limiterEnabled: false },
  });

  assert.equal(result.ok, true);
  assert.equal(result.flagRestorationDeferred, true);
  assert.deepEqual(fixture.profiles.get(''), { limit: 60, denominator: 3 });
  assert.equal(fixture.flags & 4, 0, 'the RTSS shared limiter remains enabled for saved game profiles');
  assert.deepEqual(result.observedState, { limit: 60, denominator: 3, limiterEnabled: true });
});

test('RTSS limiter flag transitions set only the requested bit and preserve other flags', async () => {
  const fixture = makeController({ includeGameProfile: false, initialFlags: 0x24 });
  fixture.profiles.set('', { limit: 60, denominator: 2 });

  const applied = await fixture.controller.applyFrameLimit({ enabled: true, value: 120 });
  assert.equal(applied.ok, true);
  assert.equal(fixture.flags & 4, 0);
  assert.equal(fixture.flags & 0x20, 0x20);

  const released = await fixture.controller.applyFrameLimit({ enabled: false });
  assert.equal(released.ok, true);
  assert.equal(fixture.flags & 4, 4);
  assert.equal(fixture.flags & 0x20, 0x20);
});

test('RTSS durable recovery refuses a mismatched external state without writes', async () => {
  const fixture = makeController({ includeGameProfile: false });
  fixture.profiles.set('', { limit: 144, denominator: 1 });
  const result = await fixture.controller.restoreFrameLimitState({
    expectedState: { limit: 60, denominator: 1, limiterEnabled: false },
    state: { limit: 30, denominator: 1, limiterEnabled: false },
  });
  assert.equal(result.ok, false);
  assert.equal(result.conflict, true);
  assert.equal(result.errorCode, 'external-change');
  assert.deepEqual(result.observedState, { limit: 144, denominator: 1, limiterEnabled: true });
  assert.equal(fixture.profileWriteCalls, 0);
  assert.deepEqual(fixture.profiles.get(''), { limit: 144, denominator: 1 });
});

test('RTSS recovery preserves shared limiter enable while a game profile remains active', async () => {
  const fixture = makeController({ includeGameProfile: false });
  await fixture.controller.applyFrameLimit({ enabled: true, value: 120, executablePath: 'C:\\Games\\game.exe' });
  const result = await fixture.controller.restoreFrameLimitState({
    expectedState: { limit: 0, denominator: 1, limiterEnabled: true },
    state: { limit: 60, denominator: 2, limiterEnabled: false },
  });
  assert.equal(result.ok, true);
  assert.equal(result.flagRestorationDeferred, true);
  assert.deepEqual(fixture.profiles.get(''), { limit: 60, denominator: 2 });
  assert.equal(fixture.flags & 4, 0);
});

test('RTSS recovery can retain the enabled Graphics cap for a later owned cleanup', async () => {
  const fixture = makeController({ includeGameProfile: false });
  fixture.profiles.set('', { limit: 40, denominator: 3 });
  const base = await fixture.controller.applyFrameLimit({ enabled: true, value: 90 });
  assert.equal(base.ok, true);
  await fixture.controller.applyFrameLimit({ enabled: true, value: 144 });

  const retained = await fixture.controller.restoreFrameLimitState({
    expectedState: { limit: 144, denominator: 1, limiterEnabled: true },
    state: { limit: 90, denominator: 1, limiterEnabled: true },
    retainOwnership: true,
  });
  assert.equal(retained.ok, true);
  assert.equal(retained.ownershipRetained, true);
  assert.deepEqual(fixture.profiles.get(''), { limit: 90, denominator: 1 });

  const released = await fixture.controller.applyFrameLimit({ enabled: false });
  assert.equal(released.ok, true);
  assert.deepEqual(fixture.profiles.get(''), { limit: 40, denominator: 3 });
  assert.equal(fixture.flags & 4, 0);
});

test('RTSS global ownership reports exact current state and pre-cap underlay', async () => {
  const fixture = makeController({ includeGameProfile: false, initialFlags: 4 });
  fixture.profiles.set('', { limit: 60, denominator: 3 });
  await fixture.controller.applyFrameLimit({ enabled: true, value: 120 });
  const owned = await fixture.controller.getFrameLimitOwnership();
  assert.equal(owned.ok, true);
  assert.deepEqual(owned.state, { limit: 120, denominator: 1, limiterEnabled: true });
  assert.deepEqual(owned.underlay, { limit: 60, denominator: 3, limiterEnabled: false });

  const fresh = makeController({ includeGameProfile: false });
  fresh.profiles.set('', { limit: 75, denominator: 2 });
  const unowned = await fresh.controller.getFrameLimitOwnership();
  assert.equal(unowned.ok, true);
  assert.deepEqual(unowned.state, { limit: 75, denominator: 2, limiterEnabled: true });
  assert.deepEqual(unowned.underlay, unowned.state);
  assert.deepEqual(unowned.disableState, { limit: 0, denominator: 1, limiterEnabled: true });
  const disabled = await fresh.controller.applyFrameLimit({
    enabled: false,
    value: 75,
    expectedState: unowned.state,
  });
  assert.equal(disabled.ok, true);
  assert.deepEqual(disabled.observedState, unowned.disableState);
});
