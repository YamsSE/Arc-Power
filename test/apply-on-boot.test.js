// M2b — apply-on-startup flow tests (electron-free, MockBackend):
// the gate (ocOnBoot + waiverAccepted), the success path with read-back
// verification, and the failure path (defaults restore + fallback flag).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockBackend, createMockOldIgcl } from '../src/main/backend/mock-backend.js';
import { ProfileStore } from '../src/main/store/profile-store.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyProfile, applyProfileOnBoot, applyProfileBoot, runApplyOnStartup } from '../src/main/apply-on-boot.js';
import { EXTENDED_UNAVAILABLE_MSG } from '../src/main/apply-routing.js';
import { trayBalloonForOutcome, trayBalloonProfileFailed, trayBalloonProfileRefused } from '../src/main/tray.js';

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

const EXTENDED_PROFILE = {
  id: 'p2',
  name: '300W Boost',
  createdAt: '2026-08-05T00:00:00Z',
  schemaVersion: 1,
  settings: { powerLimitW: 300, tempLimitC: 100 },
  ocOnBoot: false,
};

// ---------------------------------------------------------------------------
// M3-C-E — config-refusal classification (boot + tray share this flow)
// ---------------------------------------------------------------------------

test('M3-C-E: a stock-mode extended profile REFUSES with the mode message — NEVER resets to defaults', async () => {
  const dir = testDir('ocmode-refuse');
  try {
    const backend = new MockBackend({ extendedRanges: true });
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p2', ocMode: 'stock' },
      profiles: [EXTENDED_PROFILE],
    });
    const logs = [];
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p2', log: (s) => logs.push(s) });
    assert.equal(out.applied, false);
    assert.match(out.reason, /Advanced OC Mode/);
    assert.equal(out.ocModeRefused, true);
    // Config-refusal classification: no reset fallback — the live OC state
    // must survive and no "defaults restored" claim may ever be made.
    assert.equal(out.fallbackApplied, undefined, 'a mode refusal never runs the defaults restore');
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210, 'the GPU state is untouched');
    assert.ok(logs.some((l) => l.includes('NO defaults restore')), 'the log says no restore ran');
    // The tray balloon for this outcome is the reason-specific refusal.
    assert.equal(trayBalloonForOutcome(out, '300W Boost'), trayBalloonProfileRefused(out.reason));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M3-C-E: the tray path (applyProfile without ocOnBoot) refuses the same way', async () => {
  const dir = testDir('ocmode-refuse-tray');
  try {
    const backend = new MockBackend({ extendedRanges: true });
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p2', ocMode: 'stock' },
      profiles: [EXTENDED_PROFILE],
    });
    const out = await applyProfile({ backend, store, profileId: 'p2' });
    assert.equal(out.applied, false);
    assert.equal(out.ocModeRefused, true);
    assert.equal(out.fallbackApplied, undefined, 'no defaults restore on the tray path either');
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M3-C-E: the worker request carries the persisted ocMode (the worker gate keys on it)', async () => {
  const dir = testDir('ocmode-runner');
  try {
    const backend = new MockBackend({ extendedRanges: true });
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p2', ocMode: 'advanced' },
      profiles: [EXTENDED_PROFILE],
    });
    let delegated = null;
    const applyRunner = {
      needsWorker: () => true,
      apply: async (req) => {
        delegated = req;
        return { worker: true, result: { ok: true, perControl: {} }, state: { powerLimitW: 300 } };
      },
      reset: async () => ({ ok: true, state: null }),
    };
    const out = await applyProfile({ backend, store, profileId: 'p2', applyRunner });
    assert.equal(out.applied, true);
    assert.equal(delegated.ocMode, 'advanced', 'the worker request carries the persisted mode');
    assert.equal(delegated.waiverAccepted, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: an advanced-mode extended profile REFUSES when the 2023 runtime is NOT capable — never a silent 252 W apply', async () => {
  const dir = testDir('f1-unavailable');
  try {
    const backend = new MockBackend({ extendedRanges: false }); // not-capable degradation
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p2', ocMode: 'advanced' },
      profiles: [EXTENDED_PROFILE],
    });
    const logs = [];
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p2', log: (s) => logs.push(s), oldIgcl: createMockOldIgcl(backend) });
    assert.equal(out.applied, false);
    assert.equal(out.reason, EXTENDED_UNAVAILABLE_MSG);
    assert.equal(out.extendedUnavailable, true);
    // Capability-refusal classification: no reset fallback — the live OC
    // state survives and no "defaults restored" claim may ever be made.
    assert.equal(out.fallbackApplied, undefined, 'a capability refusal never runs the defaults restore');
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210, 'the GPU state is untouched');
    assert.ok(logs.some((l) => l.includes('NO defaults restore')), 'the log says no restore ran');
    // The tray balloon is the reason-specific refusal.
    assert.equal(trayBalloonForOutcome(out, '300W Boost'), trayBalloonProfileRefused(out.reason));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F1: an advanced-mode extended profile still APPLIES when the 2023 runtime IS capable (in-process path)', async () => {
  const dir = testDir('f1-capable');
  try {
    const backend = new MockBackend({ extendedRanges: true });
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p2', ocMode: 'advanced' },
      profiles: [EXTENDED_PROFILE],
    });
    const out = await applyProfile({ backend, store, profileId: 'p2', oldIgcl: createMockOldIgcl(backend) });
    assert.equal(out.applied, true);
    assert.equal(out.state.powerLimitW, 300, '300 W lands via the mock old runtime');
    assert.equal(out.state.tempLimitC, 100);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

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
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1' });
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

// M2C-B F3 (instant apply): the boot/tray path uses the same one-attempt
// core — a backend that would succeed on a retry never gets one.
test('apply-on-boot: exactly ONE backend apply call (instant, no retries)', async () => {
  const dir = testDir('ononce');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    let applies = 0;
    const real = MockBackend.prototype.applySettings.bind(backend);
    backend.applySettings = async (d, s) => {
      applies += 1;
      if (applies === 1) {
        return { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed' } } };
      }
      return real(d, s);
    };
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1' });
    assert.equal(applies, 1, 'single attempt — the flow falls back to defaults instead of retrying');
    assert.equal(out.applied, false);
    assert.equal(out.fallbackApplied, true);
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210);
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
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, false);
    assert.equal(out.fallbackApplied, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// M4-D (PERMANENT acceptance) — the logon/tray apply is a MAIN-side apply:
// with a persisted acceptance and a STALE driver waiver (the M4-B user
// report scenario — the M4-D boot probe that restores the waiver runs only
// in the window path), the apply answers waiver-not-set and must SILENTLY
// re-set the driver waiver + retry the apply ONCE (mirror runApply) — never
// restore the user's OC state to defaults over a stale driver waiver, and
// never flip the persisted acceptance.
// ---------------------------------------------------------------------------

test('M4-D: accepted store + one-shot waiver-not-set -> silent re-set + retry lands, NO defaults restore, store never flipped', async () => {
  const dir = testDir('m4d-waiver-retry');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    // The driver lost the waiver while settings.json still says accepted.
    backend.injectFail('powerLimitW', 'waiver-not-set', true);
    let accepts = 0;
    const realAccept = MockBackend.prototype.setWaiverAccepted.bind(backend);
    backend.setWaiverAccepted = async (d) => { accepts += 1; return realAccept(d); };
    const logs = [];
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1', log: (s) => logs.push(s) });
    assert.equal(out.applied, true, `the retry must land: ${out.reason}`);
    assert.equal(accepts, 1, 'the driver waiver is silently re-set exactly once');
    assert.equal(out.fallbackApplied, undefined, 'NO defaults restore — the retry landed');
    const state = await backend.getCurrentSettings(0);
    assert.equal(state.powerLimitW, 240, 'the profile values are applied');
    assert.equal(state.gpuFreqOffsetMhz, 100);
    assert.equal(state.tempLimitC, 85);
    assert.equal((await backend.getCapabilities(0)).waiverAccepted, true, 'the device waiver is accepted again');
    assert.equal((await store.loadSettings()).waiverAccepted, true, 'the persisted acceptance is never flipped');
    assert.ok(logs.some((l) => l.includes('silently re-setting the driver waiver')), 'the silent re-set is logged');
    assert.ok(logs.some((l) => l.includes('applied and read-back verified')), 'the retry landed and verified');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-D: a SECOND waiver-not-set on the retry -> exactly ONE re-set, then the honest defaults restore (no loop)', async () => {
  const dir = testDir('m4d-waiver-retry2');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    // PERSISTENT waiver-not-set: the retry also answers waiver-not-set.
    backend.injectFail('powerLimitW', 'waiver-not-set');
    let accepts = 0;
    const realAccept = MockBackend.prototype.setWaiverAccepted.bind(backend);
    backend.setWaiverAccepted = async (d) => { accepts += 1; return realAccept(d); };
    const out = await applyProfileOnBoot({ backend, store, profileId: 'p1' });
    assert.equal(accepts, 1, 'exactly one silent re-set — a second waiver-not-set never loops');
    assert.equal(out.applied, false);
    assert.equal(out.fallbackApplied, true, 'the retry also failed -> the honest defaults restore runs');
    assert.equal(out.reason, 'apply failed; defaults restored');
    assert.equal(out.result.perControl.powerLimitW.errorCode, 'waiver-not-set');
    assert.equal((await backend.getCurrentSettings(0)).powerLimitW, 210, 'defaults restored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-D: the TRAY path (runner) also gets the silent re-set + retry — waiverAccept once, retry carries waiverAccepted true', async () => {
  const dir = testDir('m4d-waiver-retry-runner');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p1' },
      profiles: [PROFILE],
    });
    const requests = [];
    let accepts = 0;
    const applyRunner = {
      needsWorker: () => true,
      apply: async (req) => {
        requests.push(req);
        if (requests.length === 1) {
          return { result: { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'waiver-not-set' } } }, state: null };
        }
        return { result: { ok: true, perControl: { powerLimitW: { ok: true, readBackEqual: true } } }, state: { powerLimitW: 240, gpuFreqOffsetMhz: 100, tempLimitC: 85 } };
      },
      waiverAccept: async (deviceId) => { accepts += 1; await backend.setWaiverAccepted(deviceId); },
      reset: async () => ({ ok: true, state: null }),
    };
    const out = await applyProfile({ backend, store, profileId: 'p1', applyRunner });
    assert.equal(out.applied, true, 'the runner retry must land');
    assert.equal(accepts, 1, 'runner.waiverAccept called exactly once (silent)');
    assert.equal(requests.length, 2, 'the apply ran exactly twice (first + ONE retry)');
    assert.equal(requests[0].waiverAccepted, true, 'the first attempt carries the device-side flag');
    assert.equal(requests[1].waiverAccepted, true, 'the retry carries the re-set acceptance');
    assert.equal(out.fallbackApplied, undefined, 'no defaults restore');
    assert.equal(out.state.powerLimitW, 240);
    assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
    assert.equal((await store.loadSettings()).waiverAccepted, true, 'the persisted acceptance is never flipped');
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
    const out = await runApplyOnStartup({ backend, store, profileId: 'p1', setupTray });
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
    const out = await runApplyOnStartup({ backend, store, profileId: 'p1', setupTray });
    assert.equal(out.applied, false);
    assert.equal(out.fallbackApplied, true); // the restore itself ran
    assert.equal(out.state, null);
    assert.equal(calls.balloons.length, 1); // outcome balloon still fires
    assert.equal(calls.balloons[0].content, trayBalloonProfileFailed('Game Boost'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// M4-D2 (no-UAC boot variant): the in-app boot apply runs applyRunner-less
// and SKIPS the defaults-restore fallback REGARDLESS of errorCode (an
// unelevated logon apply must never wipe the live OC state over an
// elevation refusal � keyed on the SESSION, not the errorCode).
test('M4-D2: applyProfileBoot with a refused apply NEVER restores defaults (fallbackSkipped)', async () => {
  const dir = testDir('boot-skip-fallback');
  try {
    const backend = new MockBackend({ extendedRanges: true });
    await backend.restoreWaiverState(0, true);
    // The unelevated PL refusal maps to out-of-range-style failures: make
    // the apply itself fail (io-failed) � the skip must not depend on the
    // errorCode.
    backend.injectFail('powerLimitW', 'io-failed');
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1', ocMode: 'advanced' },
      profiles: [PROFILE],
    });
    let resetCalls = 0;
    const origReset = backend.resetToDefaults.bind(backend);
    backend.resetToDefaults = async (...a) => { resetCalls += 1; return origReset(...a); };
    const logs = [];
    const out = await applyProfileBoot({ backend, store, profileId: 'p1', log: (s) => logs.push(s) });
    assert.equal(out.applied, false);
    assert.equal(out.fallbackSkipped, true, 'the boot variant flags the skipped fallback');
    assert.equal(resetCalls, 0, 'the defaults restore NEVER runs in the boot variant');
    assert.equal(backend._state.powerLimitW, 210, 'the live OC state survives');
    assert.ok(logs.some((l) => l.includes('fallback SKIPPED')), 'the log explains the skip');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-D2: applyProfileBoot still APPLIES when the write lands (the boot flow works unelevated on mock)', async () => {
  const dir = testDir('boot-applies');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1', ocMode: 'advanced' },
      profiles: [PROFILE],
    });
    const out = await applyProfileBoot({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, true);
    assert.equal(backend._state.powerLimitW, 240, 'the profile lands');
    assert.equal(out.fallbackSkipped, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('M4-D2: applyProfileBoot gates on ocOnBoot like the boot flow (Start-at-boot is disabled)', async () => {
  const dir = testDir('boot-gate');
  try {
    const backend = new MockBackend();
    await backend.restoreWaiverState(0, true);
    const store = makeStore(dir, {
      settings: { waiverAccepted: true, ocOnBoot: false, activeProfileId: 'p1', ocMode: 'advanced' },
      profiles: [PROFILE],
    });
    const out = await applyProfileBoot({ backend, store, profileId: 'p1' });
    assert.equal(out.applied, false);
    assert.match(out.reason, /Start-at-boot is disabled/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
