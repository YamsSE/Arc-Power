// M4-E — the --boot-apply mode tests (boot-apply-mode.js): the silent-exit
// gates (settings off / no active profile / settings read failure), the
// applied path (exit semantics — no tray, no dwell), and the failure path
// (honest balloon + dwell + exit-ready outcome). Electron-free with injected
// deps — mirrors the runApplyOnStartup test shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend } from '../src/main/backend/mock-backend.js';
import { ProfileStore } from '../src/main/store/profile-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runBootApplyMode, BOOT_APPLY_DWELL_MS } from '../src/main/boot-apply-mode.js';
import { trayBalloonProfileRefused, trayBalloonProfileFailed } from '../src/main/tray.js';

function testDir(name) {
  return path.join(os.tmpdir(), `arcpower-bootapply-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeStore(dir, { settings, profiles }) {
  const store = new ProfileStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  if (settings) store.saveSettings(settings);
  if (profiles) store.saveProfiles(profiles);
  return store;
}

const PROFILE = {
  id: 'p1',
  name: 'Game Boost',
  createdAt: '2026-08-05T00:00:00Z',
  schemaVersion: 1,
  settings: { powerLimitW: 240, gpuFreqOffsetMhz: 100, tempLimitC: 85 },
  ocOnBoot: false,
};

function countingTray() {
  const calls = { setups: 0, balloons: [] };
  const tray = {
    displayBalloon(o) { calls.balloons.push(o); },
  };
  return {
    setupTray: async () => { calls.setups += 1; return tray; },
    calls,
  };
}

test('M4-E: ocOnBoot OFF -> silent exit, NO apply, NO tray, NO dwell', async () => {
  const dir = testDir('off');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    let applied = 0;
    const out = await runBootApplyMode({
      store,
      apply: async () => { applied += 1; return { applied: true }; },
      setupTray,
      dwellMs: 5,
    });
    assert.equal(out.action, 'silent-exit');
    assert.equal(applied, 0, 'no apply when the boot setting is off');
    assert.equal(calls.setups, 0, 'no tray on the silent path');
    assert.equal(calls.balloons.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-E: no ACTIVE profile -> silent exit (no apply, no tray)', async () => {
  const dir = testDir('noactive');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: null },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    let applied = 0;
    const out = await runBootApplyMode({
      store,
      apply: async () => { applied += 1; return { applied: true }; },
      setupTray,
      dwellMs: 5,
    });
    assert.equal(out.action, 'silent-exit');
    assert.equal(applied, 0);
    assert.equal(calls.setups, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-E: a settings read failure -> silent exit (a logon task never error-spams)', async () => {
  const dir = testDir('storefail');
  try {
    const store = new ProfileStore({ dir });
    fs.mkdirSync(dir, { recursive: true });
    // Corrupt the settings file so loadSettings throws.
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json', 'utf8');
    const { setupTray, calls } = countingTray();
    const out = await runBootApplyMode({
      store,
      apply: async () => { throw new Error('must not run'); },
      setupTray,
      dwellMs: 5,
    });
    assert.equal(out.action, 'silent-exit');
    assert.equal(calls.setups, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-E: on + apply success -> { action: applied }, NO tray, NO dwell', async () => {
  const dir = testDir('applied');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    let seenId = null;
    const out = await runBootApplyMode({
      store,
      apply: async (profileId) => { seenId = profileId; return { applied: true }; },
      setupTray,
      dwellMs: 5,
    });
    assert.equal(out.action, 'applied');
    assert.equal(seenId, 'p1', 'the ACTIVE profile is applied (no id argument)');
    assert.equal(calls.setups, 0, 'no tray on success — the process exits right after the apply');
    assert.equal(calls.balloons.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-E: on + apply failure -> ONE tray, the honest refusal balloon, the dwell, then the exit-ready outcome', async () => {
  const dir = testDir('failed');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    const started = Date.now();
    const out = await runBootApplyMode({
      store,
      apply: async () => ({ applied: false, reason: 'apply failed; defaults restore skipped (logon applies need administrator approval)' }),
      setupTray,
      dwellMs: 60,
    });
    const elapsed = Date.now() - started;
    assert.equal(out.action, 'failed');
    assert.equal(out.reason, 'apply failed; defaults restore skipped (logon applies need administrator approval)');
    assert.equal(calls.setups, 1, 'exactly ONE tray instance (mirror F2)');
    assert.equal(calls.balloons.length, 1);
    assert.equal(calls.balloons[0].title, 'Arc Power');
    // fallbackSkipped is undefined on this failure -> the reason-specific
    // refusal balloon (never a false "defaults restored" claim).
    assert.equal(
      calls.balloons[0].content,
      trayBalloonProfileRefused('apply failed; defaults restore skipped (logon applies need administrator approval)'),
    );
    assert.ok(!calls.balloons[0].content.includes('defaults restored'), 'no false "defaults restored" claim');
    assert.ok(elapsed >= 55, `the dwell ran before the exit: ${elapsed} ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-E: failure with an actual defaults restore -> the "defaults restored" balloon is honest (mirror F1)', async () => {
  const dir = testDir('failed-restore');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    const out = await runBootApplyMode({
      store,
      apply: async () => ({ applied: false, reason: 'apply failed; defaults restored', fallbackApplied: true }),
      setupTray,
      dwellMs: 1,
    });
    assert.equal(out.action, 'failed');
    assert.equal(calls.balloons[0].content, trayBalloonProfileFailed('Game Boost'));
    assert.ok(calls.balloons[0].content.includes('defaults restored'), 'a restore that actually ran may claim it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-E: an apply THROW degrades to the failure path (balloon + dwell), never a crash', async () => {
  const dir = testDir('throw');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    const out = await runBootApplyMode({
      store,
      apply: async () => { throw new Error('backend exploded'); },
      setupTray,
      dwellMs: 1,
    });
    assert.equal(out.action, 'failed');
    assert.match(out.reason, /backend exploded/);
    assert.equal(calls.balloons.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-E: a tray/balloon failure on the failure path never blocks the exit (best-effort balloon)', async () => {
  const dir = testDir('trayfail');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    let setups = 0;
    const out = await runBootApplyMode({
      store,
      apply: async () => ({ applied: false, reason: 'nope' }),
      setupTray: async () => { setups += 1; throw new Error('no shell'); },
      dwellMs: 1,
    });
    assert.equal(out.action, 'failed', 'the failure outcome survives a broken tray');
    assert.equal(setups, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-E: the default dwell constant is the ~10 s visibility window', () => {
  assert.equal(BOOT_APPLY_DWELL_MS, 10000);
});
