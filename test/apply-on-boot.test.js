// M2b — apply-on-startup flow tests (electron-free, MockBackend):
// the gate (ocOnBoot + waiverAccepted), the success path with read-back
// verification, and the failure path (defaults restore + fallback flag).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend } from '../src/main/backend/mock-backend.js';
import { ProfileStore } from '../src/main/store/profile-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProfile, applyProfileOnBoot, runApplyOnStartup } from '../src/main/apply-on-boot.js';
import { trayBalloonProfileFailed, trayBalloonProfileRefused } from '../src/main/tray.js';

function makeStore(dir, { settings, profiles }) {
  const store = new ProfileStore({ dir });
  fs.mkdirSync(dir, { recursive: true });
  if (settings) store.saveSettings(settings);
  if (profiles) store.saveProfiles(profiles);
  return store;
}

function testDir(name) {
  return path.join(os.tmpdir(), `arcpower-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const PROFILE = {
  id: 'p1',
  name: 'Game Boost',
  createdAt: '2026-08-05T00:00:00Z',
  schemaVersion: 1,
  settings: { powerLimitW: 240, gpuFreqOffsetMhz: 100, tempLimitC: 85 },
  ocOnBoot: false,
};

test('apply-on-boot: applies when ocOnBoot + waiver accepted (read-back verified)', async () => {
  const dir = testDir('ok');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const logs = [];
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1', log: (s) => logs.push(s) });
    assert.equal(out.applied, true);
    const state = await backend.getCurrentSettings(0);
    assert.equal(state.powerLimitW, 240);
    assert.equal(state.gpuFreqOffsetMhz, 100);
    assert.equal(state.tempLimitC, 85);
    assert.ok(logs.some((l) => l.includes('applied and read-back verified')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-on-boot: gate — ocOnBoot disabled -> not applied, device untouched', async () => {
  const dir = testDir('gate1');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'Start-at-boot is disabled');
    assert.equal(out.fallbackApplied, undefined);
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210); // untouched
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-on-boot: gate — persisted waiver not accepted -> not applied', async () => {
  const dir = testDir('gate2');
  try {
    const backend = new MockBackend();
    const store = makeStore(dir, {
      settings: { waiverAccepted: false, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'Waiver not accepted');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-on-boot: gate — driver lost the waiver -> not applied, never auto-accepted', async () => {
  const dir = testDir('gate3');
  try {
    const backend = new MockBackend();
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    // persisted accepted, but the driver says not accepted
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, false);
    assert.match(out.reason, /waiver not accepted on the device/);
    assert.equal((await backend.getCapabilities(0)).waiverAccepted, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-on-boot: missing profile -> not applied, no defaults restore', async () => {
  const dir = testDir('missing');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'nope' },
      profiles: [PROFILE],
    });
    const out = await applyProfileOnBoot({ backend, store, profileId: 'nope' });
    assert.equal(out.applied, false);
    assert.match(out.reason, /not found/);
    assert.equal(out.fallbackApplied, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-on-boot: failure -> defaults restored + fallbackApplied flag (never a partial apply)', async () => {
  const dir = testDir('fail');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    // The profile asks for 240 W; the driver (mock) refuses with io-failed.
    backend.injectFail('powerLimitW', 'io-failed');
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1', budgetMs: 10 });
    assert.equal(out.applied, false);
    assert.equal(out.fallbackApplied, true);
    assert.equal(out.result.ok, false);
    assert.equal(out.result.perControl.powerLimitW.errorCode, 'io-failed');
    // Defaults were applied (read-back verified by the flow).
    const state = await backend.getCurrentSettings(0);
    assert.equal(state.powerLimitW, 210);
    assert.equal(state.gpuFreqOffsetMhz, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('apply-on-boot: failure AND failed defaults restore -> fallbackApplied false, reason says defaults', async () => {
  const dir = testDir('fail2');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    backend.resetToDefaults = async () => { throw new Error('reset refused by driver'); };
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    backend.injectFail('powerLimitW', 'io-failed');
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1', budgetMs: 10 });
    assert.equal(out.applied, false);
    assert.equal(out.fallbackApplied, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M2b review F1 — explicit-user-action apply (tray click): skips the ocOnBoot
// gate, keeps the waiver gates; the balloon only claims "defaults restored"
// when a restore actually ran.
// ---------------------------------------------------------------------------

test('F1: tray apply with ocOnBoot OFF -> profile APPLIES (no balloon path)', async () => {
  const dir = testDir('tray1');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    // Explicit user action: the ocOnBoot gate is skipped, the waiver gates
    // are kept. The old behavior (gated on ocOnBoot) refused here and
    // ballooned a false "defaults restored".
    const out = await applyProfile({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, true);
    assert.equal(out.fallbackApplied, undefined);
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 240);
    assert.equal((await backend.getCurrentSettings(0)).gpuFreqOffsetMhz, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: tray apply still gates on the persisted waiver (never auto-accepts)', async () => {
  const dir = testDir('tray2');
  try {
    const backend = new MockBackend();
    const store = makeStore(dir, {
      settings: { waiverAccepted: false, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const out = await applyProfile({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'Waiver not accepted');
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: tray apply gates on the DEVICE waiver (driver lost it since boot)', async () => {
  const dir = testDir('tray3');
  try {
    const backend = new MockBackend();
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const out = await applyProfile({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'waiver not accepted on the device');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M2b review F1 + F2 — apply-on-startup CLI flow: ONE tray instance, and the
// failure balloon only when a restore actually ran.
// ---------------------------------------------------------------------------

function countingTray() {
  const calls = { setup: 0, balloons: [] };
  const tray = {
    displayBalloon(o) { calls.balloons.push(o); },
  };
  return {
    tray,
    setupTray: async () => { calls.setup += 1; return tray; },
    calls,
  };
}

test('NIT1: ocOnBoot OFF -> NOT applied, ONE tray, refusal balloon (no false "defaults restored")', async () => {
  const dir = testDir('startup1');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const logs = [];
    const { setupTray, calls } = countingTray();
    const out = await runApplyOnStartup({ backend, store, profileId: 'p1', setupTray, log: (s) => logs.push(s) });
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'Start-at-boot is disabled');
    assert.equal(calls.setup, 1); // F2: exactly one tray instance
    // NIT 1 regression: the gate refusal IS ballooned on the boot path (the
    // tray exists) with the reason-specific refusal text — never a false
    // "defaults restored" claim (F1).
    assert.equal(calls.balloons.length, 1);
    assert.equal(calls.balloons[0].title, 'Arc Power');
    assert.equal(calls.balloons[0].content, trayBalloonProfileRefused('Start-at-boot is disabled'));
    assert.ok(!calls.balloons[0].content.includes('defaults restored'));
    assert.ok(logs.some((l) => l.includes('tray balloon sent')));
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210); // untouched
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NIT1: waiver not accepted -> NOT applied, ONE tray, refusal balloon (reason-specific)', async () => {
  const dir = testDir('startup2');
  try {
    const backend = new MockBackend();
    const store = makeStore(dir, {
      settings: { waiverAccepted: false, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const logs = [];
    const { setupTray, calls } = countingTray();
    const out = await runApplyOnStartup({ backend, store, profileId: 'p1', setupTray, log: (s) => logs.push(s) });
    assert.equal(out.applied, false);
    assert.equal(out.reason, 'Waiver not accepted');
    assert.equal(calls.setup, 1);
    assert.equal(calls.balloons.length, 1);
    assert.equal(calls.balloons[0].title, 'Arc Power');
    assert.equal(calls.balloons[0].content, trayBalloonProfileRefused('Waiver not accepted'));
    assert.ok(logs.some((l) => l.includes('tray balloon sent')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: apply failure -> ONE tray instance reused for the failure balloon (never two)', async () => {
  const dir = testDir('startup3');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    backend.injectFail('powerLimitW', 'io-failed');
    const { setupTray, calls } = countingTray();
    const out = await runApplyOnStartup({ backend, store, profileId: 'p1', setupTray, budgetMs: 10 });
    assert.equal(out.applied, false);
    assert.equal(out.fallbackApplied, true); // defaults were restored
    assert.equal(calls.setup, 1); // F2 regression: exactly ONE setupTray call
    assert.equal(calls.balloons.length, 1);
    assert.equal(calls.balloons[0].title, 'Arc Power');
    assert.equal(calls.balloons[0].content, trayBalloonProfileFailed('Game Boost'));
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F2: apply SUCCESS path also keeps exactly one tray (no balloon)', async () => {
  const dir = testDir('startup4');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    const out = await runApplyOnStartup({ backend, store, profileId: 'p1', setupTray });
    assert.equal(out.applied, true);
    assert.equal(calls.setup, 1);
    assert.equal(calls.balloons.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: refusal balloon text is reason-appropriate (never "defaults restored")', () => {
  const refused = trayBalloonProfileRefused('Start-at-boot is disabled');
  assert.equal(refused, 'Arc Power: profile not applied — Start-at-boot is disabled');
  assert.ok(!refused.includes('defaults restored'));
});

// ---------------------------------------------------------------------------
// M2b step-5 NIT 5 — a read-back throw after apply/fallback must not crash
// or silence the outcome: degrade to state:null and keep the outcome +
// balloon logic (previously the throw escaped the try/catch and only logged).
// ---------------------------------------------------------------------------

test('NIT5: read-back throw after a SUCCESSFUL apply -> still applied, state:null, no crash', async () => {
  const dir = testDir('readback1');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    backend.getCurrentSettings = async () => { throw new Error('read-back exploded'); };
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    const out = await runApplyOnStartup({ backend, store, profileId: 'p1', setupTray });
    assert.equal(out.applied, true);
    assert.equal(out.state, null); // degraded state read, outcome intact
    assert.equal(calls.balloons.length, 0); // success balloons nothing
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NIT5: read-back throw after the defaults fallback -> failure still reported, balloon sent', async () => {
  const dir = testDir('readback2');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    backend.injectFail('powerLimitW', 'io-failed');
    backend.getCurrentSettings = async () => { throw new Error('read-back exploded'); };
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const { setupTray, calls } = countingTray();
    const out = await runApplyOnStartup({ backend, store, profileId: 'p1', setupTray, budgetMs: 10 });
    assert.equal(out.applied, false);
    assert.equal(out.fallbackApplied, true); // the restore itself ran
    assert.equal(out.state, null);
    assert.equal(calls.balloons.length, 1); // outcome balloon still fires
    assert.equal(calls.balloons[0].content, trayBalloonProfileFailed('Game Boost'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
