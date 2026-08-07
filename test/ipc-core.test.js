// M2a — IPC security surface tests (electron-free ipc-core):
//   - deviceId validation;
//   - apply-settings payload validation (whitelist keys, finite numbers,
//     well-formed arrays/objects; everything else rejected);
//   - main-process re-clamping against capability ranges;
//   - the PRODUCT PATH never auto-accepts the waiver: a backend constructed
//     without allowAutoWaiver must see no waiver call and the store must not
//     be persisted with waiverAccepted from an apply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertValidDeviceId,
  sanitizeSettings,
  clampSettings,
  createIpcHandlers,
  seedWaiverState,
  probeWaiverState,
  seedOcMode,
} from '../src/main/ipc-core.js';
import { MockBackend, createMockOldIgcl } from '../src/main/backend/mock-backend.js';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import { CTL_RESULT } from '../src/main/backend/igcl-bindings.js';
import { EXTENDED_UNAVAILABLE_MSG } from '../src/main/apply-routing.js';
import { createMockStartup } from '../src/main/startup.js';
import { ProfileStore } from '../src/main/store/profile-store.js';

// ---------------------------------------------------------------------------
// deviceId validation
// ---------------------------------------------------------------------------

test('assertValidDeviceId: accepts non-negative integers', () => {
  assert.equal(assertValidDeviceId(0), 0);
  assert.equal(assertValidDeviceId(3), 3);
});

test('assertValidDeviceId: rejects negatives, floats, strings, NaN, null', () => {
  for (const bad of [-1, 1.5, '0', NaN, null, undefined, {}, []]) {
    assert.throws(() => assertValidDeviceId(bad), /invalid device id/, String(bad));
  }
});

// ---------------------------------------------------------------------------
// apply-settings payload validation
// ---------------------------------------------------------------------------

test('sanitizeSettings: accepts a legal scalar payload and returns a clean copy', () => {
  const out = sanitizeSettings({ powerLimitW: 220, gpuVoltOffsetV: 0.1, gpuFreqOffsetMhz: 48, tempLimitC: 85 });
  assert.deepEqual(out, { powerLimitW: 220, gpuVoltOffsetV: 0.1, gpuFreqOffsetMhz: 48, tempLimitC: 85 });
});

test('sanitizeSettings: accepts well-formed gpuLock / vfCurve / fanCurve / fanMode', () => {
  const out = sanitizeSettings({
    gpuLock: { voltageV: 0.9, freqMhz: 2100 },
    vfCurve: [{ voltageV: 0.9, freqMhz: 1800 }],
    fanCurve: [{ t: 20, speedPct: 20 }, { t: 90, speedPct: 100 }],
    fanMode: 'curve',
  });
  assert.deepEqual(out, {
    gpuLock: { voltageV: 0.9, freqMhz: 2100 },
    vfCurve: [{ voltageV: 0.9, freqMhz: 1800 }],
    fanCurve: [{ t: 20, speedPct: 20 }, { t: 90, speedPct: 100 }],
    fanMode: 'curve',
  });
});

test('sanitizeSettings: rejects non-object payloads', () => {
  for (const bad of [null, undefined, 5, 'x', [], true]) {
    assert.throws(() => sanitizeSettings(bad), /plain object/);
  }
});

test('sanitizeSettings: rejects unknown keys (whitelist is CONTROLS)', () => {
  assert.throws(() => sanitizeSettings({ powerLimitW: 220, evilKey: 1 }), /unknown control: evilKey/);
});

test('sanitizeSettings: rejects non-finite / wrong-typed scalar values', () => {
  for (const bad of [NaN, Infinity, '220', null, {}, true]) {
    assert.throws(() => sanitizeSettings({ powerLimitW: bad }), /powerLimitW must be a finite number/);
  }
});

test('sanitizeSettings: rejects malformed gpuLock', () => {
  assert.throws(() => sanitizeSettings({ gpuLock: { voltageV: '0.9' } }), /gpuLock must be/);
  assert.throws(() => sanitizeSettings({ gpuLock: [0.9, 2100] }), /gpuLock must be/);
});

test('sanitizeSettings: rejects malformed curve arrays and bad fanMode', () => {
  assert.throws(() => sanitizeSettings({ fanCurve: [{ t: '20' }] }), /fanCurve points must be/);
  assert.throws(() => sanitizeSettings({ fanCurve: [{ t: 20, speedPct: 20 }, { t: 90 }] }), /fanCurve points must be/);
  assert.throws(() => sanitizeSettings({ fanCurve: 'nope' }), /fanCurve must be a non-empty array/);
  assert.throws(() => sanitizeSettings({ fanCurve: Array.from({ length: 33 }, (_, i) => ({ t: i, speedPct: i })) }), /at most 32/);
  assert.throws(() => sanitizeSettings({ fanMode: 'turbo' }), /fanMode must be one of/);
});

test('sanitizeSettings: rejects empty curve arrays (F5 regression)', () => {
  assert.throws(() => sanitizeSettings({ fanCurve: [] }), /non-empty array/);
  assert.throws(() => sanitizeSettings({ vfCurve: [] }), /non-empty array/);
});

test('sanitizeSettings: accepts a 32-point curve (the table cap), rejects 33', () => {
  const curve32 = Array.from({ length: 32 }, (_, i) => ({ t: 20 + i, speedPct: 20 + i }));
  assert.equal(sanitizeSettings({ fanCurve: curve32 }).fanCurve.length, 32);
  assert.throws(() => sanitizeSettings({ fanCurve: Array.from({ length: 33 }, (_, i) => ({ t: i, speedPct: i })) }), /at most 32/);
});

// ---------------------------------------------------------------------------
// main-process re-clamping
// ---------------------------------------------------------------------------

test('clampSettings: clamps + snaps out-of-range scalars to the capability grid', () => {
  const ranges = {
    powerLimitW: { min: 105, max: 252, step: 1, default: 210, units: 'W' },
    gpuVoltOffsetV: { min: 0, max: 0.234, step: 0.005, default: 0, units: 'V' },
  };
  const out = clampSettings({ powerLimitW: 999, gpuVoltOffsetV: 0.012 }, ranges);
  assert.equal(out.powerLimitW, 252);
  assert.equal(out.gpuVoltOffsetV, 0.01); // snapped to the 0.005 grid
});

test('clampSettings: non-scalar controls pass through untouched', () => {
  const out = clampSettings({ fanCurve: [{ t: 20, speedPct: 20 }], gpuLock: { voltageV: 0.9, freqMhz: 2100 } }, {});
  assert.deepEqual(out.fanCurve, [{ t: 20, speedPct: 20 }]);
  assert.deepEqual(out.gpuLock, { voltageV: 0.9, freqMhz: 2100 });
});

test('clampSettings: clamps an extreme gpuLock pair (F1 regression)', () => {
  // M4-B: the clamp is the documented ABSOLUTE lock ceiling (1.5 V) — the
  // gpuVoltOffsetV range (an offset bound) no longer caps the lock voltage.
  const out = clampSettings({ gpuLock: { voltageV: 99, freqMhz: -5 } }, {});
  assert.deepEqual(out.gpuLock, { voltageV: 1.5, freqMhz: 0 });
});

// ---------------------------------------------------------------------------
// product-path waiver: never auto-accepted
// ---------------------------------------------------------------------------

function fakeStore(initial = { waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock', advancedModeAccepted: false, startWithWindows: false, startMinimized: false }) {
  const saved = [];
  return {
    saved,
    loadSettings: async () => ({ ...initial }),
    saveSettings: async (s) => { saved.push({ ...s }); },
  };
}

test('apply-settings handler never auto-accepts the waiver and never persists it', async () => {
  const backend = new MockBackend(); // no allowAutoWaiver — product path
  const store = fakeStore();
  const emitted = [];
  const { handlers } = createIpcHandlers({ backend, store, emit: (ch, p) => emitted.push([ch, p]) });

  assert.equal((await backend.getCapabilities(0)).waiverAccepted, false);

  const res = await handlers['apply-settings'](0, { powerLimitW: 200 });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.perControl.powerLimitW.ok, true);

  // The waiver must still be unaccepted on the device, and the store must
  // not have been touched by the apply.
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, false);
  assert.equal(store.saved.length, 0);
});

test('waiver-accept is the ONLY path that accepts: explicit call persists + returns accepted', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const out = await handlers['waiver-accept'](0);
  assert.deepEqual(out, { accepted: true });
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].waiverAccepted, true);
});

test('apply-settings returns the fresh read-back state (IGS refresh rule)', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const { result, state } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(result.perControl.powerLimitW.ok, true);
  assert.equal(state.powerLimitW, 220);
});

test('apply-settings clamps an extreme gpuLock pair before it reaches the backend (F1 regression)', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const { result, state } = await handlers['apply-settings'](0, { gpuLock: { voltageV: 99, freqMhz: -5 } });
  assert.equal(result.perControl.gpuLock.ok, true);
  // M4-B: the documented absolute ceiling (1.5 V), not the 0.234 V offset bound.
  assert.deepEqual(state.gpuLock, { voltageV: 1.5, freqMhz: 0 });
});

test('reset-to-defaults returns the fresh read-back state', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  await handlers['apply-settings'](0, { powerLimitW: 252 });
  const { state } = await handlers['reset-to-defaults'](0);
  assert.equal(state.powerLimitW, 210);
});

test('reset-to-defaults throws when the backend ignores the reset (read-back verification, F3 regression)', async () => {
  const backend = new MockBackend();
  backend.resetToDefaults = async () => { /* driver silently ignores the reset */ };
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  await handlers['apply-settings'](0, { powerLimitW: 252 });
  await assert.rejects(
    () => handlers['reset-to-defaults'](0),
    /powerLimitW: read-back 252 != default 210/,
  );
});

test('reset-to-defaults verifies every supported control against its capability default (F3)', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  await handlers['apply-settings'](0, { powerLimitW: 252, gpuFreqOffsetMhz: 300, tempLimitC: 90 });
  // defaults per the mock matrix: 210 W / 0 MHz / 90 C / 0 V
  const { state } = await handlers['reset-to-defaults'](0);
  assert.equal(state.powerLimitW, 210);
  assert.equal(state.gpuFreqOffsetMhz, 0);
  assert.equal(state.gpuVoltOffsetV, 0);
  assert.equal(state.tempLimitC, 90);
});

// ---------------------------------------------------------------------------
// boot-time waiver seeding (F1)
// ---------------------------------------------------------------------------

test('seedWaiverState: restores the persisted acceptance into the backend without writing (F1 regression)', async () => {
  const backend = new MockBackend();
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
  await seedWaiverState(backend, store);
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
  assert.equal(store.saved.length, 0); // seeding never persists anything
});

test('seedWaiverState: a store read failure degrades to not-accepted (never a false accepted)', async () => {
  const backend = new MockBackend();
  const store = {
    loadSettings: async () => { throw new Error('cannot load settings.json: invalid JSON'); },
    saveSettings: async () => {},
  };
  await seedWaiverState(backend, store);
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, false);
});

test('seedWaiverState: persisted not-accepted leaves the flag unset', async () => {
  const backend = new MockBackend();
  await backend.setWaiverAccepted(0); // in-memory accepted (this session)
  const store = fakeStore(); // default waiverAccepted: false on disk
  await seedWaiverState(backend, store);
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, false);
});

// M4-D (user): probeWaiverState — the boot-time driver-truth probe. A
// persisted acceptance can be STALE — the driver lost the waiver while
// settings.json still says accepted. The probe writes the CURRENT power
// limit (value-neutral), surfaces waiver-not-set, and:
//   - store ACCEPTED (M4-D, PERMANENT acceptance): RESTORES the driver
//     waiver (setWaiverAccepted) — the consent stands, the store is NEVER
//     flipped to false (persistWaiverLost is removed);
//   - store UNACCEPTED (unchanged M4-B): clears the in-memory flag + the
//     persisted store so the boot prompt shows the classic Accept dialog.

test('M4-D: probeWaiverState RESTORES the driver waiver when the store says accepted (never flips the store)', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true); // boot seed from the persisted store
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
  // The driver lost the waiver: the probe's value-neutral write answers
  // waiver-not-set (once=true — only the probe's write fails).
  backend.injectFail('powerLimitW', 'waiver-not-set', true);
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' });

  await probeWaiverState(backend, store);

  // The driver waiver is RE-SET (consent stands) and the store is NEVER
  // written — no persisted false, no flip.
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
  assert.equal(store.saved.length, 0, 'the probe never persists anything for an accepted store');
});

test('probeWaiverState: a driver that HAS the waiver is untouched — no flag flip, no store write', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true);
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });

  await probeWaiverState(backend, store);

  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
  assert.equal(store.saved.length, 0);
});

test('probeWaiverState: an UNACCEPTED store keeps the M4-B behavior — flag + store cleared, setWaiverAccepted NEVER called', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true); // stale in-memory acceptance
  let setCalls = 0;
  const original = backend.setWaiverAccepted.bind(backend);
  backend.setWaiverAccepted = async (...args) => { setCalls += 1; return original(...args); };
  backend.injectFail('powerLimitW', 'waiver-not-set', true);
  const store = fakeStore({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null });

  await probeWaiverState(backend, store);

  assert.equal(setCalls, 0, 'an unaccepted store must never be auto-accepted');
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, false);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].waiverAccepted, false);
});

test('probeWaiverState: devices without a powerLimitW control are skipped (no probe write possible)', async () => {
  let applyCalls = 0;
  const noPowerBackend = {
    listDevices: async () => [{ id: 7, name: 'no-power card' }],
    getCapabilities: async () => ({ ranges: { gpuFreqOffsetMhz: { min: 0, max: 300 } } }),
    getCurrentSettings: async () => { throw new Error('must not be called'); },
    applySettings: async () => { applyCalls += 1; throw new Error('must not be called'); },
    restoreWaiverState: async () => { throw new Error('must not be called'); },
    setWaiverAccepted: async () => { throw new Error('must not be called'); },
  };
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
  await probeWaiverState(noPowerBackend, store);
  assert.equal(applyCalls, 0);
  assert.equal(store.saved.length, 0);
});

// M4-D (user, PERMANENT acceptance): an ACCEPTED store + a waiver-not-set
// apply -> MAIN silently re-sets the driver waiver + retries ONCE. The
// first attempt is never surfaced; the store is never flipped to false.

test('M4-D: an accepted store auto re-sets the driver waiver + retries ONCE (waiver-get stays accepted, retry landed)', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true); // persisted-accepted boot seed
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
  backend.injectFail('powerLimitW', 'waiver-not-set', true); // one-shot driver waiver loss
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const res = await handlers['apply-settings'](0, { powerLimitW: 220 });
  // The RETRY envelope is returned — the first waiver-not-set attempt is
  // never surfaced as a failure.
  assert.equal(res.result.ok, true);
  assert.equal(res.result.perControl.powerLimitW.ok, true);
  assert.equal(res.state.powerLimitW, 220, 'the retry landed');
  // The waiver was re-set: waiver-get stays accepted (the G2 flag clear
  // must not leak) and the store was NEVER flipped to false.
  assert.deepEqual(await handlers['waiver-get'](0), { accepted: true });
  assert.equal(store.saved.length, 0, 'the store never persists false — the consent stands');
});

test('M4-D: exactly ONE retry — a second waiver-not-set returns the retry envelope as-is', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true);
  backend.injectFail('powerLimitW', 'waiver-not-set'); // persistent: both attempts fail
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const res = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(res.result.ok, false, 'the retry also failed — reported honestly');
  assert.equal(res.result.perControl.powerLimitW.errorCode, 'waiver-not-set');
  // The G2 flag clear still applies (the retry's failure cleared it) —
  // waiver-get reports unaccepted so the NEXT apply re-prompts.
  assert.deepEqual(await handlers['waiver-get'](0), { accepted: false });
  // The store is NEVER flipped to false (persistWaiverLost is removed).
  assert.equal(store.saved.length, 0);
});

test('M4-D: an UNACCEPTED store keeps the current behavior — no auto re-set, no retry, flag cleared', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true); // stale in-memory flag only
  backend.injectFail('powerLimitW', 'waiver-not-set', true);
  let acceptCalls = 0;
  const original = backend.setWaiverAccepted.bind(backend);
  backend.setWaiverAccepted = async (...args) => { acceptCalls += 1; return original(...args); };
  const store = fakeStore({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const res = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(res.result.ok, false, 'the first attempt is surfaced for an unaccepted store');
  assert.equal(res.result.perControl.powerLimitW.errorCode, 'waiver-not-set');
  assert.equal(acceptCalls, 0, 'never auto-accept for an unaccepted store');
  // The in-memory flag was cleared (NOT accepted): the next waiver-get is
  // unaccepted so the renderer re-shows the dialog on the next apply.
  assert.deepEqual(await handlers['waiver-get'](0), { accepted: false });
  assert.equal(store.saved.length, 0);
});

test('M4-D: the worker path auto re-accepts through the runner and retries ONCE', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true);
  let applyCalls = 0;
  let acceptCalls = 0;
  const applyRunner = {
    needsWorker: () => true,
    apply: async (req) => {
      applyCalls += 1;
      if (applyCalls === 1) {
        assert.equal(req.waiverAccepted, true, 'the first request carries the seeded acceptance');
        return { worker: true, result: { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'waiver-not-set' } } }, state: {} };
      }
      assert.equal(req.waiverAccepted, true, 'the retry request carries the re-set acceptance');
      return { worker: true, result: { ok: true, perControl: { powerLimitW: { ok: true, readBackEqual: true } } }, state: { powerLimitW: 220 } };
    },
    waiverAccept: async () => { acceptCalls += 1; },
    reset: async () => ({}),
  };
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, applyRunner });

  const out = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(applyCalls, 2, 'exactly one retry');
  assert.equal(acceptCalls, 1, 'the runner re-accepted the waiver exactly once');
  assert.equal(out.result.ok, true);
  assert.equal(out.state.powerLimitW, 220);
  // The parent-side flag reflects the runner acceptance.
  assert.deepEqual(await handlers['waiver-get'](0), { accepted: true });
  assert.equal(store.saved.length, 0);
});

test('M4-D: a declined silent re-set (UAC) surfaces the FIRST attempt honestly — never a fake success', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true);
  const applyRunner = {
    needsWorker: () => true,
    apply: async () => ({ worker: true, result: { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'waiver-not-set' } } }, state: {} }),
    waiverAccept: async () => { throw new Error('Apply requires administrator approval.'); },
    reset: async () => ({}),
  };
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, applyRunner });

  const out = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.errorCode, 'waiver-not-set');
});

test('telemetry-start emits samples through the injected emit channel', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const emitted = [];
  const { handlers, stopAllTelemetry } = createIpcHandlers({
    backend,
    store,
    emit: (ch, p) => emitted.push([ch, p]),
  });

  await handlers['telemetry-start'](0);
  // Product poll cadence is 500 ms — wait for two ticks.
  await new Promise((r) => setTimeout(r, 1100));
  await stopAllTelemetry();

  assert.ok(emitted.length >= 2, `expected >= 2 telemetry samples, got ${emitted.length}`);
  assert.equal(emitted[0][0], 'telemetry:sample');
  assert.equal(typeof emitted[0][1].t, 'number');
});

// ---------------------------------------------------------------------------
// Registry-catalog channel (M3-A) — read-side only: the default adapter is
// the MOCK (never runs reg.exe), and there is NO apply channel.
// ---------------------------------------------------------------------------

test('registry-catalog channel: registered, takes no payload, default adapter is the mock', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal(typeof handlers['registry-catalog'], 'function');
  await assert.rejects(() => handlers['registry-catalog']({}), /takes no payload/);

  const out = await handlers['registry-catalog']();
  assert.equal(out.entries.length, 4);
  assert.deepEqual(out.states.map((s) => s.id), out.entries.map((e) => e.id));
  // The fixture covers the whole vocabulary: disabled / enabled / default /
  // enabled (mpo / hags / game-dvr / fullscreen-optimizations).
  const byId = Object.fromEntries(out.states.map((s) => [s.id, s]));
  assert.equal(byId.mpo.state, 'disabled');
  assert.equal(byId.hags.state, 'enabled');
  assert.equal(byId['game-dvr'].state, 'default');
  assert.equal(byId['fullscreen-optimizations'].state, 'enabled');
});

test('registry-catalog channel: an injected adapter is used (never the real registry in tests)', async () => {
  const injected = {
    get: async () => ({ entries: [{ id: 'x', name: 'X', description: 'd', requiresElevation: true, absentLabel: 'a', reads: [] }], states: [] }),
  };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, registryCatalog: injected });
  const out = await handlers['registry-catalog']();
  assert.equal(out.entries[0].id, 'x');
});

test('registry-catalog channel: read-side only — no apply channel exists (M3-B)', () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal(handlers['registry-catalog-apply'], undefined);
  assert.equal(handlers['registry-catalog-enable'], undefined);
});

// ---------------------------------------------------------------------------
// Registry-apply channel (M3-B) — elevated apply: payload validation, the
// default mock adapter (never spawns/elevates), and the injected adapter.
// ---------------------------------------------------------------------------

test('registry-apply channel: validates entryId + action, default adapter is the mock', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal(typeof handlers['registry-apply'], 'function');
  await assert.rejects(() => handlers['registry-apply']('', 'enable'), /entryId must be a non-empty string/);
  await assert.rejects(() => handlers['registry-apply'](null, 'enable'), /entryId must be a non-empty string/);
  await assert.rejects(() => handlers['registry-apply']('mpo', 'explode'), /action must be one of/);
  await assert.rejects(() => handlers['registry-apply']('mpo', 1), /action must be one of/);
  // Read-only entries are rejected at the adapter (the UI hides their buttons).
  await assert.rejects(() => handlers['registry-apply']('fullscreen-optimizations', 'enable'), /read-only/);
});

test('registry-apply channel: mock apply flips the SAME mock state the registry-catalog channel reads (state refresh honesty)', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  // Fixture: mpo=disabled. Enable it via the apply channel, then re-read:
  // the next registry-catalog read MUST report enabled (the post-apply state
  // refresh path the UI uses).
  const before = await handlers['registry-catalog']();
  assert.equal(before.states.find((s) => s.id === 'mpo').state, 'disabled');
  const out = await handlers['registry-apply']('mpo', 'enable');
  assert.equal(out.ok, true);
  assert.deepEqual(out.perStep.map((p) => p.status), ['done', 'done']);
  assert.match(out.message, /MPOHack=1 written to HKLM/);
  const after = await handlers['registry-catalog']();
  assert.equal(after.states.find((s) => s.id === 'mpo').state, 'enabled');
  assert.equal(after.states.find((s) => s.id === 'mpo').reads.every((r) => r.value === '0x1'), true);
  // Revert -> default again.
  const reverted = await handlers['registry-apply']('mpo', 'revert');
  assert.equal(reverted.ok, true);
  const afterRevert = await handlers['registry-catalog']();
  assert.equal(afterRevert.states.find((s) => s.id === 'mpo').state, 'default');
});

test('registry-apply channel: an injected adapter is used (never spawns PowerShell in tests)', async () => {
  const injected = {
    apply: async (entryId, action) => ({ ok: true, message: `${entryId}:${action}`, perStep: [] }),
  };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, registryApply: injected });
  const out = await handlers['registry-apply']('mpo', 'revert');
  assert.equal(out.message, 'mpo:revert');
});

// ---------------------------------------------------------------------------
// F3 instant apply (M2C-B) — replaces the M2C-A retry-with-verify policy
// ---------------------------------------------------------------------------

function countingBackend() {
  const backend = new MockBackend();
  const calls = { apply: 0 };
  backend.applySettings = async function applyCounting(deviceId, settings) {
    calls.apply += 1;
    return MockBackend.prototype.applySettings.call(this, deviceId, settings);
  };
  return { backend, calls };
}

test('apply-settings: a refusal is instant — exactly ONE backend call, honest result', async () => {
  const { backend, calls } = countingBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  // The backend would succeed on a retry — it must never get one.
  let attempts = 0;
  backend.applySettings = async (deviceId, settings) => {
    attempts += 1;
    if (attempts === 1) {
      return { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', message: 'driver busy' } } };
    }
    return MockBackend.prototype.applySettings.call(backend, deviceId, settings);
  };

  const { result, state } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(attempts, 1, 'single attempt — no retries, no backoff');
  assert.equal(calls.apply, 0, 'the retried backend call never happened');
  assert.equal(result.ok, false);
  assert.equal(result.perControl.powerLimitW.errorCode, 'io-failed');
  // M2C-C: refusals carry the PLAIN driver message + code — the IGS-naming
  // requirement is gone (the real gate was elevation, docs §8c).
  assert.match(result.perControl.powerLimitW.message, /The GPU driver refused the change\. \(io-failed\)/);
  assert.doesNotMatch(result.perControl.powerLimitW.message, /Intel Graphics Software/);
  assert.equal(state.powerLimitW, 210, 'driver state untouched (read-back unchanged)');
});

test('apply-settings: silent no-op (SUCCESS + unchanged read-back) fails instantly, NEVER applied', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  backend.applySettings = async () => ({
    ok: false,
    perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true, message: 'read-back 210 != requested 220' } },
  });
  const { result, state } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(result.ok, false, 'a silent no-op is NEVER "applied"');
  assert.equal(result.perControl.powerLimitW.silentNoop, true);
  assert.equal(result.perControl.powerLimitW.ok, false);
  assert.match(result.perControl.powerLimitW.message, /The GPU driver refused the change\. \(io-failed\)/);
  assert.doesNotMatch(result.perControl.powerLimitW.message, /Intel Graphics Software/);
  assert.equal(state.powerLimitW, 210);
});

test('apply-settings: hard errors are instant with the errorCode kept (no refusal message)', async () => {
  const { backend, calls } = countingBackend();
  backend.injectFail('powerLimitW', 'waiver-not-set');
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const { result } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(calls.apply, 1);
  assert.equal(result.ok, false);
  assert.equal(result.perControl.powerLimitW.errorCode, 'waiver-not-set');
  assert.equal(result.perControl.powerLimitW.message, undefined, 'hard errors keep the renderer errorMessage mapping');
});

test('apply-settings: success on the single attempt reports ok + fresh state', async () => {
  const { backend, calls } = countingBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const { result, state } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(calls.apply, 1);
  assert.equal(result.ok, true);
  assert.equal(result.perControl.powerLimitW.ok, true);
  assert.equal(state.powerLimitW, 220);
});

test('apply-settings: refusal message composition — every refusal is plain + code (M2C-C)', async () => {
  // M2C-C: the IGS state no longer composes messages — a refusal anywhere
  // is the plain driver message + error code.
  const backend = new MockBackend();
  const store = fakeStore();
  let n = 0;
  backend.applySettings = async () => {
    n += 1;
    return { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed' } } };
  };
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });
  const { result } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(result.perControl.powerLimitW.message, 'The GPU driver refused the change. (io-failed)');
  assert.equal(n, 1);
});

test('apply-settings: a volt/temp refusal gets the plain driver message + code (M2C-C)', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });
  backend.injectFail('gpuVoltOffsetV', 'io-failed');
  const { result } = await handlers['apply-settings'](0, { gpuVoltOffsetV: 0.05 });
  assert.equal(result.ok, false);
  assert.equal(result.perControl.gpuVoltOffsetV.message, 'The GPU driver refused the change. (io-failed)');
});

// ---------------------------------------------------------------------------
// startup channels (M2b) — the default adapter is the MOCK (never the
// registry), and payloads are validated
// ---------------------------------------------------------------------------

test('startup channels: registered; startup-get takes no payload', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal(typeof handlers['startup-get'], 'function');
  assert.equal(typeof handlers['startup-set'], 'function');
  await assert.rejects(() => handlers['startup-get']({}), /takes no payload/);
});

test('startup channels: default adapter is the mock — get/set round trip without any registry access', async () => {
  const startup = createMockStartup();
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, startup });

  // M4-D: the combined shape — both tasks reported distinctly.
  assert.deepEqual(await handlers['startup-get'](), {
    startupRunKey: { enabled: false, profileId: null, value: null, mechanism: null },
    applyOnBoot: { enabled: false, value: null },
    startWithWindows: false,
  });
  const setOut = await handlers['startup-set'](true, 'p1');
  assert.equal(setOut.startupRunKey.enabled, true);
  assert.equal(setOut.startupRunKey.profileId, 'p1');
  assert.match(setOut.startupRunKey.value, /--apply-profile p1/);
  assert.equal(setOut.applyOnBoot.enabled, false, 'coexistence: the app task stays off');
  assert.deepEqual(await handlers['startup-get'](), setOut);

  assert.deepEqual(await handlers['startup-set'](false, null), {
    startupRunKey: { enabled: false, profileId: null, value: null, mechanism: null },
    applyOnBoot: { enabled: false, value: null },
    startWithWindows: false,
  });
});

// M4-D: the plain-app task channel (Settings "Start with Windows").
test('M4-D: startup-app-set enables the app task and disables the apply-profile registration (coexistence)', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  await assert.rejects(() => handlers['startup-app-set']('yes'), /enabled must be a boolean/);
  await assert.rejects(() => handlers['startup-app-set'](1), /enabled must be a boolean/);

  const on = await handlers['startup-app-set'](true);
  assert.equal(on.applyOnBoot.enabled, true);
  assert.equal(on.applyOnBoot.value, `"${process.execPath}"`);
  assert.equal(on.startWithWindows, true);
  assert.equal(on.startupRunKey.enabled, false);

  // Enabling the apply-profile registration flips the app task back off.
  const profileOn = await handlers['startup-set'](true, 'p1');
  assert.equal(profileOn.startupRunKey.enabled, true);
  assert.equal(profileOn.applyOnBoot.enabled, false);

  const off = await handlers['startup-app-set'](false);
  assert.equal(off.applyOnBoot.enabled, false);
  assert.equal(off.startWithWindows, false);
});

test('M4-D: startup-app-set rejects when the adapter has no app-task variant (honest 404)', async () => {
  const noAppVariant = { get: async () => ({}), set: async () => ({}) };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, startup: noAppVariant });
  await assert.rejects(() => handlers['startup-app-set'](true), /no app-task variant/);
});

test('startup-set: validation — enabled must be boolean; enabling needs a profileId; disabling takes null', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  await assert.rejects(() => handlers['startup-set']('yes', 'p1'), /enabled must be a boolean/);
  await assert.rejects(() => handlers['startup-set'](true, null), /profileId is required/);
  await assert.rejects(() => handlers['startup-set'](true, ''), /profileId is required/);
  await assert.rejects(() => handlers['startup-set'](false, 'p1'), /profileId must be null/);
  await assert.rejects(() => handlers['startup-set'](1, 'p1'), /enabled must be a boolean/);
});

// M2b review F6 — a whitespace profileId would silently break the startup-get
// round trip (the Run-key value is space-delimited); reject it up front.
test('startup-set: rejects whitespace profileIds (Run-key round trip stays intact)', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  await assert.rejects(() => handlers['startup-set'](true, 'profile 1'), /must not contain whitespace/);
  await assert.rejects(() => handlers['startup-set'](true, ' p1'), /must not contain whitespace/);
  await assert.rejects(() => handlers['startup-set'](true, 'p1 '), /must not contain whitespace/);
  // A legal id still round-trips.
  const out = await handlers['startup-set'](true, 'profile-1');
  assert.equal(out.startupRunKey.enabled, true);
  assert.equal(out.startupRunKey.profileId, 'profile-1');
});

// ---------------------------------------------------------------------------
// M2b-B: driver-info, fps-poll, profiles + tray-rebuild channels
// ---------------------------------------------------------------------------

function fakeProfileStore(initialProfiles = []) {
  const profiles = [...initialProfiles];
  let settings = { waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock', advancedModeAccepted: false, startWithWindows: false, startMinimized: false, closeToTray: false };
  return {
    profiles,
    async loadProfiles() { return [...profiles]; },
    async saveProfiles(next) { profiles.splice(0, profiles.length, ...next); },
    async saveProfile(p) {
      const idx = profiles.findIndex((x) => x.id === p.id);
      if (idx >= 0) profiles[idx] = { ...p, schemaVersion: 1 };
      else profiles.push({ ...p, schemaVersion: 1 });
    },
    async deleteProfile(id) {
      const next = profiles.filter((p) => p.id !== id);
      if (next.length === profiles.length) return false;
      profiles.splice(0, profiles.length, ...next);
      return true;
    },
    async loadSettings() { return { ...settings }; },
    async saveSettings(s) { settings = { ...s }; },
  };
}

test('driver-info channel: no payload; the DEFAULT adapter returns the fixture date (no reg.exe)', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal(typeof handlers['driver-info'], 'function');
  await assert.rejects(() => handlers['driver-info']({}), /takes no payload/);
  assert.deepEqual(await handlers['driver-info'](), { driverDate: '7-5-2026' });
});

test('driver-info channel: an injected adapter is used (registry failure -> null)', async () => {
  const driverInfo = { get: async () => ({ driverDate: null }) };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, driverInfo });
  assert.deepEqual(await handlers['driver-info'](), { driverDate: null });
});

// M2C-B B3 — app:version channel: no payload; the default reads package.json
// (electron-free), an injected version is used verbatim.
test('app-version channel: no payload; the DEFAULT reads the package.json version', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal(typeof handlers['app-version'], 'function');
  await assert.rejects(() => handlers['app-version']({}), /takes no payload/);
  const { version } = await handlers['app-version']();
  assert.equal(version, '0.9.12', 'package.json version');
});

test('app-version channel: an injected version is returned (product path = app.getVersion())', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, appVersion: '2.3.4' });
  assert.deepEqual(await handlers['app-version'](), { version: '2.3.4' });
});

test('fps-poll channel: the DEFAULT adapter reports unavailable (never loads PresentMon)', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal(typeof handlers['fps-poll'], 'function');
  assert.equal(await handlers['fps-poll'](0), null);
  await assert.rejects(() => handlers['fps-poll'](-1), /invalid device id/);
});

test('fps-poll channel: an injected adapter returns its sample (never null when present)', async () => {
  const presentmon = { poll: async () => ({ fps: 144, frameTimeMs: 6.9, gpuBusy: 0.7 }) };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, presentmon });
  assert.deepEqual(await handlers['fps-poll'](0), { fps: 144, frameTimeMs: 6.9, gpuBusy: 0.7 });
});

test('profiles channels: list -> save (create) -> rename -> delete round trip with validation', async () => {
  const store = fakeProfileStore();
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {} });

  assert.deepEqual(await handlers['profiles-list'](), { profiles: [], settings: { waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock', advancedModeAccepted: false, startWithWindows: false, startMinimized: false, closeToTray: false } });
  await assert.rejects(() => handlers['profiles-list']({}), /takes no payload/);

  const afterSave = await handlers['profiles-save']({ id: 'p1', name: '  My Profile  ', settings: { powerLimitW: 220 }, ocOnBoot: false });
  assert.equal(afterSave.profiles.length, 1);
  assert.equal(afterSave.profiles[0].name, 'My Profile'); // trimmed
  assert.deepEqual(afterSave.profiles[0].settings, { powerLimitW: 220 });
  assert.equal(typeof afterSave.profiles[0].createdAt, 'string');

  const afterRename = await handlers['profiles-rename']('p1', 'Renamed');
  assert.equal(afterRename.profiles[0].name, 'Renamed');
  // Rename preserves createdAt and settings.
  assert.equal(afterRename.profiles[0].createdAt, afterSave.profiles[0].createdAt);

  const afterDelete = await handlers['profiles-delete']('p1');
  assert.deepEqual(afterDelete.profiles, []);
});

test('profiles-save: overwrite keeps createdAt, validates settings + name + id + ocOnBoot', async () => {
  const store = fakeProfileStore();
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {} });

  const created = await handlers['profiles-save']({ id: 'p1', name: 'First', settings: { powerLimitW: 220 }, ocOnBoot: false });
  const overwritten = await handlers['profiles-save']({ id: 'p1', name: 'Second', settings: { tempLimitC: 85 }, ocOnBoot: true });
  assert.equal(overwritten.profiles.length, 1);
  assert.equal(overwritten.profiles[0].createdAt, created.profiles[0].createdAt);
  assert.deepEqual(overwritten.profiles[0].settings, { tempLimitC: 85 });
  assert.equal(overwritten.profiles[0].ocOnBoot, true);

  for (const bad of [null, 5, 'x', [], { id: '' }, { id: 'p', name: '' }, { id: 'p', name: '  ' }]) {
    await assert.rejects(() => handlers['profiles-save'](bad), /profiles-save/, JSON.stringify(bad));
  }
  await assert.rejects(() => handlers['profiles-save']({ id: 'p', name: 'n', settings: { evil: 1 }, ocOnBoot: false }), /unknown control: evil/);
  await assert.rejects(() => handlers['profiles-save']({ id: 'p', name: 'n', settings: { powerLimitW: 'x' }, ocOnBoot: false }), /finite number/);
  await assert.rejects(() => handlers['profiles-save']({ id: 'p', name: 'n', settings: {}, ocOnBoot: 'yes' }), /ocOnBoot must be a boolean/);
});

// M2b review F6 — profile ids become Run-key values (startup-set); reject
// whitespace so the startup-get round trip can never break.
test('profiles-save: rejects whitespace profile ids (Run-key round trip stays intact)', async () => {
  const store = fakeProfileStore();
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {} });
  for (const badId of ['profile 1', ' p1', 'p1 ', 'a\tb']) {
    await assert.rejects(
      () => handlers['profiles-save']({ id: badId, name: 'n', settings: {}, ocOnBoot: false }),
      /must not contain whitespace/,
      JSON.stringify(badId),
    );
  }
  assert.equal(store.profiles.length, 0);
});

test('profiles-delete / profiles-rename: reject empty ids and unknown profiles', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeProfileStore(), emit: () => {} });
  await assert.rejects(() => handlers['profiles-delete'](''), /non-empty string/);
  await assert.rejects(() => handlers['profiles-rename']('', 'x'), /non-empty string/);
  await assert.rejects(() => handlers['profiles-rename']('missing', 'x'), /not found/);
});

test('profiles-settings-save: read-modify-write never clobbers waiverAccepted (nor ocMode)', async () => {
  const store = fakeProfileStore();
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {} });

  // Seed an accepted waiver (as waiver-accept would).
  await store.saveSettings({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced', advancedModeAccepted: false, startWithWindows: false, startMinimized: false, closeToTray: false });

  const out = await handlers['profiles-settings-save']({ activeProfileId: 'p1', ocOnBoot: true });
  assert.deepEqual(out, { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1', ocMode: 'advanced', advancedModeAccepted: false, startWithWindows: false, startMinimized: false, closeToTray: false });
  const clear = await handlers['profiles-settings-save']({ ocOnBoot: false, activeProfileId: null });
  assert.deepEqual(clear, { waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced', advancedModeAccepted: false, startWithWindows: false, startMinimized: false, closeToTray: false });

  for (const bad of [null, 5, 'x', []]) {
    await assert.rejects(() => handlers['profiles-settings-save'](bad), /patch must be an object/);
  }
});

test('M4-B: advanced-mode-accepted get/set — the once-only warning acceptance persists (get is false until an explicit set)', async () => {
  // Stateful fake: loadSettings reflects the saves (the plain fakeStore
  // always returns its initial snapshot, which cannot assert a round trip).
  const store = fakeProfileStore();
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {} });

  assert.deepEqual(await handlers['advanced-mode-accepted-get'](), { accepted: false });
  await assert.rejects(() => handlers['advanced-mode-accepted-get']({}), /takes no payload/);
  await assert.rejects(() => handlers['advanced-mode-accepted-set']({}), /takes no payload/);

  assert.deepEqual(await handlers['advanced-mode-accepted-set'](), { accepted: true });
  assert.deepEqual(await handlers['advanced-mode-accepted-get'](), { accepted: true });
  assert.equal((await store.loadSettings()).advancedModeAccepted, true);
  // The set is idempotent and never touches the other settings.
  assert.equal((await store.loadSettings()).ocMode, 'stock');
  assert.equal((await store.loadSettings()).waiverAccepted, false);
});

test('M4-B: profiles-settings-save never clobbers advancedModeAccepted (like ocMode)', async () => {
  const store = fakeProfileStore();
  await store.saveSettings({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock', advancedModeAccepted: true, startWithWindows: false, startMinimized: false });
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {} });

  const out = await handlers['profiles-settings-save']({ ocOnBoot: true });
  assert.equal(out.advancedModeAccepted, true, 'the once-only acceptance survives the profiles patch');
});

test('M4-D: profiles-settings-save persists the Settings-tab fields (startWithWindows/startMinimized/closeToTray) without touching the rest', async () => {
  const store = fakeProfileStore();
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {} });

  const out = await handlers['profiles-settings-save']({ startWithWindows: true, startMinimized: true });
  assert.equal(out.startWithWindows, true);
  assert.equal(out.startMinimized, true);
  assert.equal(out.ocOnBoot, false, 'the profiles fields stay untouched');
  assert.equal(out.waiverAccepted, false, 'waiverAccepted stays untouched');
  assert.deepEqual(await store.loadSettings(), {
    waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock',
    advancedModeAccepted: false, startWithWindows: true, startMinimized: true, closeToTray: false,
  });
  // Turning one back off keeps the other.
  const back = await handlers['profiles-settings-save']({ startMinimized: false });
  assert.equal(back.startMinimized, false);
  assert.equal(back.startWithWindows, true);
  // Absent fields keep the current values (read-modify-write).
  const untouched = await handlers['profiles-settings-save']({ ocOnBoot: true });
  assert.equal(untouched.startWithWindows, true);
  assert.equal(untouched.startMinimized, false);
  // M4-D (user): closeToTray persists through the same channel.
  const tray = await handlers['profiles-settings-save']({ closeToTray: true });
  assert.equal(tray.closeToTray, true);
  assert.equal(tray.startWithWindows, true, 'the other fields stay untouched');
});

test('M4-B (user): a persisted-accepted session applies CLOCKS and a FAN CURVE with no waiver-not-set and no waiver-accept call', async () => {
  // Boot-time seeding (seedWaiverState) restored the persisted acceptance
  // into the in-memory flag — the same state the real product path boots.
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true);
  let waiverAcceptCalls = 0;
  const original = backend.setWaiverAccepted.bind(backend);
  backend.setWaiverAccepted = async (...args) => { waiverAcceptCalls += 1; return original(...args); };

  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true, 'the seeded session boots accepted');

  const res = await handlers['apply-settings'](0, {
    gpuFreqOffsetMhz: 25,
    fanCurve: [{ t: 0, speedPct: 20 }, { t: 100, speedPct: 100 }],
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.perControl.gpuFreqOffsetMhz.ok, true);
  assert.equal(res.result.perControl.fanCurve.ok, true);
  const perErrors = Object.entries(res.result.perControl).filter(([, p]) => !p.ok).map(([k, p]) => `${k}:${p.errorCode}`);
  assert.deepEqual(perErrors, [], `no control failed: ${perErrors.join(', ')}`);
  // The acceptance is neither consumed nor re-issued: no waiver-accept call,
  // no store write, and the device flag stays accepted.
  assert.equal(waiverAcceptCalls, 0);
  assert.equal(store.saved.length, 0);
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
});

test('tray-rebuild channel: no payload; calls the injected hook', async () => {
  let calls = 0;
  const rebuildTray = async () => { calls += 1; };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, rebuildTray });
  await assert.rejects(() => handlers['tray-rebuild']({}), /takes no payload/);
  assert.deepEqual(await handlers['tray-rebuild'](), { ok: true });
  assert.equal(calls, 1);
});

test('tray-rebuild channel: the default hook is a no-op (never throws without a tray)', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.deepEqual(await handlers['tray-rebuild'](), { ok: true });
});

// ---------------------------------------------------------------------------
// M4-D: sysinfo channel (CPU card + VRAM source) — read-side, no payload,
// the DEFAULT adapter is the mock fixture (never spawns PowerShell)
// ---------------------------------------------------------------------------

test('M4-D: sysinfo:get — no payload, the default adapter returns the mock fixture', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  assert.equal(typeof handlers['sysinfo:get'], 'function');
  await assert.rejects(() => handlers['sysinfo:get']({}), /takes no payload/);
  const out = await handlers['sysinfo:get']();
  assert.equal(out.cpu.name, 'Intel(R) Core(TM) i7-14700K');
  assert.equal(out.cpu.cores, 20);
  assert.equal(out.cpu.threads, 28);
  assert.equal(out.cpu.maxClockMhz, 5600);
  assert.equal(out.ram.totalBytes, 34359738368);
  assert.equal(out.ram.speedMhz, 6000);
  assert.equal(out.videoControllers.length, 1);
  assert.equal(out.videoControllers[0].name, 'Intel(R) Arc(TM) A770 Graphics');
  assert.equal(out.videoControllers[0].vramBytes, 17179869184);
});

test('M4-D: sysinfo:get — an injected adapter is used (the product path cache)', async () => {
  const sysinfo = { get: async () => ({ cpu: { name: 'Real CPU', cores: 24, threads: 32, maxClockMhz: 5000 }, ram: { totalBytes: 1, speedMhz: null }, videoControllers: [] }) };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, sysinfo });
  assert.deepEqual(await handlers['sysinfo:get'](), { cpu: { name: 'Real CPU', cores: 24, threads: 32, maxClockMhz: 5000 }, ram: { totalBytes: 1, speedMhz: null }, videoControllers: [] });
});

// ---------------------------------------------------------------------------
// M4-D: window-op channels (integrated title bar) — no payload; the default
// ops are no-ops; the injected ops are called
// ---------------------------------------------------------------------------

test('M4-D: window channels — registered, take no payload, call the injected ops', async () => {
  const calls = [];
  const windowOps = {
    minimize: async () => { calls.push('minimize'); },
    maximizeToggle: async () => { calls.push('maximizeToggle'); },
    close: async () => { calls.push('close'); },
  };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, windowOps });
  for (const ch of ['window-minimize', 'window-maximize-toggle', 'window-close']) {
    assert.equal(typeof handlers[ch], 'function', ch);
    await assert.rejects(() => handlers[ch]({}), /takes no payload/, ch);
    await assert.rejects(() => handlers[ch](0), /takes no payload/, ch);
  }
  await handlers['window-minimize']();
  await handlers['window-maximize-toggle']();
  await handlers['window-close']();
  assert.deepEqual(calls, ['minimize', 'maximizeToggle', 'close']);
});

test('M4-D: window channels — the DEFAULT ops are no-ops (tests never touch a BrowserWindow)', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  await handlers['window-minimize']();
  await handlers['window-maximize-toggle']();
  await handlers['window-close']();
  assert.ok(true, 'no throw — no window exists in tests');
});

// ---------------------------------------------------------------------------
// M2C-C elevation: the app-elevated channel + the apply-runner delegation
// ---------------------------------------------------------------------------

test('app-elevated: reports elevated + workerApply from the injected deps', async () => {
  const { handlers } = createIpcHandlers({
    backend: new MockBackend(), store: fakeStore(), emit: () => {},
    isElevated: () => true,
    applyRunner: { needsWorker: () => false },
  });
  assert.deepEqual(await handlers['app-elevated'](), { elevated: true, workerApply: false });
});

test('app-elevated: a runner that needs the worker reports workerApply true', async () => {
  const { handlers } = createIpcHandlers({
    backend: new MockBackend(), store: fakeStore(), emit: () => {},
    isElevated: () => false,
    applyRunner: { needsWorker: () => true, apply: async () => ({}), waiverAccept: async () => {}, reset: async () => ({}) },
  });
  assert.deepEqual(await handlers['app-elevated'](), { elevated: false, workerApply: true });
});

test('app-elevated: takes no payload', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  await assert.rejects(() => handlers['app-elevated']({}), /takes no payload/);
});

// ---------------------------------------------------------------------------
// M3-C-E — the OC-mode channels + backend caps-cache invalidation
// ---------------------------------------------------------------------------

test('oc-mode-get: returns the persisted mode; oc-mode-set persists + invalidates the backend caps cache', async () => {
  const backend = new MockBackend({ ocMode: 'stock' });
  const store = fakeStore({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock' });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });
  assert.deepEqual(await handlers['oc-mode-get'](), { ocMode: 'stock' });
  // Stock -> the mock's getCapabilities reports standard ranges.
  const stockCaps = await handlers['get-capabilities'](0);
  assert.equal(stockCaps.extendedRanges, undefined);
  assert.equal(stockCaps.ranges.powerLimitW.max, 252);
  // Toggle to advanced: persisted + the caps cache is invalidated.
  assert.deepEqual(await handlers['oc-mode-set']('advanced'), { ocMode: 'advanced' });
  assert.equal(store.saved.at(-1).ocMode, 'advanced', 'the mode is persisted');
  const advancedCaps = await handlers['get-capabilities'](0);
  assert.equal(advancedCaps.extendedRanges, true);
  assert.equal(advancedCaps.ranges.powerLimitW.max, 315);
  // Toggle back.
  assert.deepEqual(await handlers['oc-mode-set']('stock'), { ocMode: 'stock' });
  const stockAgain = await handlers['get-capabilities'](0);
  assert.equal(stockAgain.extendedRanges, undefined);
});

test('oc-mode-set: rejects anything that is not stock|advanced', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  for (const bad of ['turbo', '', null, 5, undefined]) {
    await assert.rejects(() => handlers['oc-mode-set'](bad), /must be one of stock, advanced/);
  }
});

test('oc-mode-get: takes no payload', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });
  await assert.rejects(() => handlers['oc-mode-get']({}), /takes no payload/);
});

test('apply-settings: a non-elevated runner delegates the apply (worker path), returning the worker envelope', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const store = fakeStore({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' });
  let delegated = null;
  const applyRunner = {
    needsWorker: () => true,
    apply: async (req) => {
      delegated = req;
      return { worker: true, result: { ok: true, perControl: { powerLimitW: { ok: true, readBackEqual: true } } }, state: { powerLimitW: 300 } };
    },
    waiverAccept: async () => {},
    reset: async () => ({}),
  };
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, applyRunner });
  const out = await handlers['apply-settings'](0, { powerLimitW: 300 });
  assert.deepEqual(delegated.settings, { powerLimitW: 300 });
  // M3-C-E: the request carries the persisted ocMode so the worker's own
  // gate keys on the real mode (its caps always report extendedRanges).
  assert.equal(delegated.ocMode, 'advanced');
  assert.equal(out.result.ok, true);
  assert.equal(out.state.powerLimitW, 300);
});

test('M3-C-E: apply-settings REFUSES beyond-standard values in stock mode BEFORE any clamp/delegation', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'stock' });
  let delegated = false;
  const applyRunner = {
    needsWorker: () => true,
    apply: async () => { delegated = true; return { result: { ok: true, perControl: {} }, state: {} }; },
    waiverAccept: async () => {},
    reset: async () => ({}),
  };
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, applyRunner });
  const out = await handlers['apply-settings'](0, { powerLimitW: 300 });
  assert.equal(delegated, false, 'the worker must never be spawned for a mode refusal');
  assert.equal(out.result.ok, false);
  assert.equal(out.ocModeRefused, true);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.match(out.result.perControl.powerLimitW.message, /Advanced OC Mode/);
  // M3-C review F2: the refusal carries the FRESH device state, never null —
  // a null state would null the renderer store's device state (the OC page
  // renders 'Loading…' forever and the dirty helpers throw on it).
  assert.ok(out.state !== null, 'the refusal envelope must not null the state');
  assert.equal(out.state.powerLimitW, 210, 'the state is the pre-apply read-back');
  assert.equal(backend._state.powerLimitW, 210, 'the refusal never touches the device');
});

test('M3-C-D: apply-settings REFUSES above-ceiling values in advanced mode — never clamps', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });
  const out = await handlers['apply-settings'](0, { powerLimitW: 401 });
  assert.equal(out.result.ok, false);
  assert.equal(out.ocModeRefused, true);
  assert.equal(out.result.perControl.powerLimitW.errorCode, 'out-of-range');
  assert.ok(!/clamp/.test(out.result.perControl.powerLimitW.message), 'never a silent clamp');
  assert.equal(backend._state.powerLimitW, 210);
});

// ---------------------------------------------------------------------------
// M3-C review F3 — the oc-mode boot pre-seed (seedOcMode): the backend's
// FIRST getCapabilities must already expose the persisted mode's range set.
// The boot race it fixes: the window + IPC were registered before the
// seeding, so a persisted-advanced session rendered 252 W / 90 C sliders
// until a later self-heal.
// ---------------------------------------------------------------------------

function ocModeStoreDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rid-ap-ocmode-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  return dir;
}

test('F3: seedOcMode with a persisted-advanced store — the FIRST getCapabilities already reports extended ranges', async (t) => {
  const store = new ProfileStore({ dir: ocModeStoreDir(t), ocModeDefault: 'stock' });
  await store.saveSettings({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' });
  // The backend is constructed with the STOCK default — exactly the boot
  // race: its caps would be cached stock without the seeding.
  const backend = new MockBackend({ extendedRanges: true, ocMode: 'stock' });
  assert.ok(!(await backend.getCapabilities(0)).extendedRanges,  'precondition: stock caps before the seed');
  const seeded = await seedOcMode(backend, store);
  assert.equal(seeded, 'advanced');
  const caps = await backend.getCapabilities(0);
  assert.equal(caps.extendedRanges, true, 'the FIRST caps query after seeding is advanced');
  assert.equal(caps.ranges.powerLimitW.max, 315);
  assert.equal(caps.ranges.tempLimitC.max, 115);
});

test('F3: seedOcMode with a persisted-stock store keeps the first caps query stock (extended ranges hidden)', async (t) => {
  const store = new ProfileStore({ dir: ocModeStoreDir(t), ocModeDefault: 'advanced' });
  await store.saveSettings({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'stock' });
  const backend = new MockBackend({ extendedRanges: true }); // mock default advanced
  assert.equal((await backend.getCapabilities(0)).extendedRanges, true, 'precondition: advanced caps before the seed');
  const seeded = await seedOcMode(backend, store);
  assert.equal(seeded, 'stock');
  const caps = await backend.getCapabilities(0);
  assert.ok(!caps.extendedRanges,  'the FIRST caps query after seeding is stock');
  assert.equal(caps.ranges.powerLimitW.max, 252);
});

test('F3: seedOcMode degrades to null (never throws) when the store read fails', async (t) => {
  const store = new ProfileStore({ dir: ocModeStoreDir(t) });
  fs.rmSync(path.join(store.dir, 'settings.json'), { force: true });
  const storePath = store.settingsPath;
  // Corrupt the settings file so loadSettings throws.
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, '{ corrupt json');
  const backend = new MockBackend({ extendedRanges: true, ocMode: 'stock' });
  const seeded = await seedOcMode(backend, store);
  assert.equal(seeded, null);
  // The backend keeps its construction default — degraded, never a crash.
  assert.ok(!(await backend.getCapabilities(0)).extendedRanges, 'the backend keeps its construction default');
});

test('apply-settings: a runner that throws (UAC canceled) propagates the honest error', async () => {
  const { handlers } = createIpcHandlers({
    backend: new MockBackend(), store: fakeStore(), emit: () => {},
    applyRunner: { needsWorker: () => true, apply: async () => { throw new Error('Apply requires administrator approval.'); }, waiverAccept: async () => {}, reset: async () => ({}) },
  });
  await assert.rejects(() => handlers['apply-settings'](0, { powerLimitW: 220 }), /administrator approval/);
});

test('waiver-accept: a non-elevated runner delegates to the elevated worker', async () => {
  const store = fakeStore();
  let delegated = null;
  const applyRunner = {
    needsWorker: () => true,
    apply: async () => ({}),
    waiverAccept: async (deviceId) => { delegated = deviceId; },
    reset: async () => ({}),
  };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {}, applyRunner });
  const out = await handlers['waiver-accept'](0);
  assert.equal(out.accepted, true);
  assert.equal(delegated, 0, 'the elevated worker accepted the waiver');
  assert.equal(store.saved.at(-1).waiverAccepted, true, 'the persisted settings record the acceptance');
});

test('waiver-accept: a declined runner surfaces the honest error (nothing persisted)', async () => {
  const store = fakeStore();
  const { handlers } = createIpcHandlers({
    backend: new MockBackend(), store, emit: () => {},
    applyRunner: { needsWorker: () => true, waiverAccept: async () => { throw new Error('Apply requires administrator approval.'); }, apply: async () => ({}), reset: async () => ({}) },
  });
  await assert.rejects(() => handlers['waiver-accept'](0), /administrator approval/);
  assert.equal(store.saved.length, 0, 'nothing persisted after a declined UAC');
});

test('reset-to-defaults: a non-elevated runner delegates the reset and verifies the worker state', async () => {
  const store = fakeStore();
  let delegated = false;
  const applyRunner = {
    needsWorker: () => true,
    apply: async () => ({}),
    waiverAccept: async () => {},
    reset: async (deviceId) => {
      delegated = true;
      return { ok: true, state: await new MockBackend().getCurrentSettings(deviceId) };
    },
  };
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {}, applyRunner });
  const out = await handlers['reset-to-defaults'](0);
  assert.equal(delegated, true);
  assert.equal(out.state.powerLimitW, 210);
});

test('reset-to-defaults: a runner that throws (UAC canceled) propagates', async () => {
  const { handlers } = createIpcHandlers({
    backend: new MockBackend(), store: fakeStore(), emit: () => {},
    applyRunner: { needsWorker: () => true, reset: async () => { throw new Error('Apply requires administrator approval.'); }, apply: async () => ({}), waiverAccept: async () => {} },
  });
  await assert.rejects(() => handlers['reset-to-defaults'](0), /administrator approval/);
});

// ---------------------------------------------------------------------------
// M2C-C S1: the extended probe wired into the REAL backend — the ipc-core
// clamp path must pass 300 W through un-capped when the probe reports
// capable (the "silent cap" regression), and clamp to 252 W without it.
// ---------------------------------------------------------------------------

// Minimal fake IGCL lib: enough surface for IgclBackend.init/device-enum +
// getCapabilities (PL/TL V2 pairs supported) — no fan, no lock, no VF curve.
function makeFakeIgclLib() {
  const devHandle = koffi.alloc('uint8', 1);
  return {
    ctlInit: (_args, apiBuf) => { koffi.encode(apiBuf, 'void*', devHandle); return CTL_RESULT.SUCCESS; },
    ctlClose: () => CTL_RESULT.SUCCESS,
    ctlEnumerateDevices: (_api, countBuf, listBuf) => {
      koffi.encode(countBuf, 'uint32', 1);
      if (listBuf !== null) koffi.encode(listBuf, 'void*', devHandle);
      return CTL_RESULT.SUCCESS;
    },
    ctlGetDeviceProperties: (_h, propsBuf) => {
      koffi.encode(propsBuf, 'ctl_device_adapter_properties_t', {
        Size: koffi.sizeof('ctl_device_adapter_properties_t'),
        Version: 3,
        pci_vendor_id: 0x8086,
        pci_device_id: 0x56a0,
        rev_id: 8,
        driver_version: BigInt('0x002000000065229d'),
        name: 'Fake Arc GPU',
        Frequency: 2100,
        num_xe_cores: 32,
      });
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockGetProperties: (_h, ocBuf) => {
      const control = (bSupported, units, min, max, step, Default) => ({ bSupported, bRelative: false, bReference: false, units, min, max, step, Default, reference: 0 });
      koffi.encode(ocBuf, 'ctl_oc_properties_t', {
        Size: koffi.sizeof('ctl_oc_properties_t'),
        Version: 1,
        bSupported: true,
        gpuFrequencyOffset: control(false, 0, 0, 0, 0, 0),
        gpuVoltageOffset: control(false, 3, 0, 0, 0, 0),
        vramFrequencyOffset: control(false, 0, 0, 0, 0, 0),
        vramVoltageOffset: control(false, 0, 0, 0, 0, 0),
        powerLimit: control(true, 4, 105, 252, 1, 210),
        temperatureLimit: control(true, 5, 60, 90, 1, 90),
      });
      return CTL_RESULT.SUCCESS;
    },
    ctlOverclockPowerLimitGetV2: (_h, buf) => { koffi.encode(buf, 'double', 252); return CTL_RESULT.SUCCESS; },
    ctlOverclockPowerLimitSetV2: () => CTL_RESULT.SUCCESS,
    ctlOverclockTemperatureLimitGetV2: (_h, buf) => { koffi.encode(buf, 'double', 90); return CTL_RESULT.SUCCESS; },
    ctlOverclockTemperatureLimitSetV2: () => CTL_RESULT.SUCCESS,
  };
}

const capturingRunner = (result) => ({
  needsWorker: () => true,
  apply: async (req) => {
    capturingRunner.delegated = req;
    return result ?? { worker: true, result: { ok: true, perControl: {} }, state: {} };
  },
  waiverAccept: async () => {},
  reset: async () => ({}),
});

test('M3-C-E: a capable extended probe + ADVANCED mode reports the extended ranges (PL max 315 / TL max 115 + flag)', async () => {
  const backend = new IgclBackend({ lib: makeFakeIgclLib(), extended: { isCapable: async () => true }, ocMode: 'advanced' });
  await backend.init();
  const caps = await backend.getCapabilities(0);
  assert.equal(caps.extendedRanges, true);
  assert.equal(caps.ranges.powerLimitW.max, 315); // M3-C-D: live-verified ceiling
  assert.equal(caps.ranges.tempLimitC.max, 115);
  assert.equal(caps.ranges.powerLimitW.min, 105, 'min/default stay the DriverStore values');
});

test('M3-C-E: a capable probe in STOCK mode reports the standard ranges (no flag, 252 W / 90 C)', async () => {
  const backend = new IgclBackend({ lib: makeFakeIgclLib(), extended: { isCapable: async () => true } });
  await backend.init();
  const caps = await backend.getCapabilities(0);
  assert.equal(caps.extendedRanges, undefined);
  assert.equal(caps.ranges.powerLimitW.max, 252);
  assert.equal(caps.ranges.tempLimitC.max, 90);
});

test('S1: WITHOUT the probe the real backend reports the standard ranges (no flag, 252 W / 90 C)', async () => {
  const backend = new IgclBackend({ lib: makeFakeIgclLib() });
  await backend.init();
  const caps = await backend.getCapabilities(0);
  assert.equal(caps.extendedRanges, undefined);
  assert.equal(caps.ranges.powerLimitW.max, 252);
  assert.equal(caps.ranges.tempLimitC.max, 90);
});

test('S1: the ipc-core clamp path passes 300 W through UN-CAPPED under a capable probe + advanced mode (the silent cap is gone)', async () => {
  const backend = new IgclBackend({ lib: makeFakeIgclLib(), extended: { isCapable: async () => true }, ocMode: 'advanced' });
  await backend.init();
  const { handlers } = createIpcHandlers({ backend, store: fakeStore({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' }), emit: () => {}, applyRunner: capturingRunner() });
  const out = await handlers['apply-settings'](0, { powerLimitW: 300 });
  assert.equal(out.result.ok, true);
  assert.equal(capturingRunner.delegated.settings.powerLimitW, 300, '300 W must reach the apply unchanged');
});

test('F1: without a probe (advanced) the clamp no longer silently caps — a 300 W request REFUSES with EXTENDED_UNAVAILABLE_MSG', async () => {
  const backend = new IgclBackend({ lib: makeFakeIgclLib(), ocMode: 'advanced' });
  await backend.init();
  const { handlers } = createIpcHandlers({ backend, store: fakeStore({ waiverAccepted: false, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' }), emit: () => {}, applyRunner: capturingRunner() });
  capturingRunner.delegated = undefined; // clear the shared capturing slot
  const out = await handlers['apply-settings'](0, { powerLimitW: 300 });
  assert.equal(out.result.ok, false, 'never a false ok:true at the clamped 252 W');
  assert.equal(out.extendedUnavailable, true);
  assert.equal(capturingRunner.delegated, undefined, 'nothing is delegated for a capability refusal');
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.powerLimitW.message, EXTENDED_UNAVAILABLE_MSG);
  assert.ok(out.state !== null, 'the refusal carries the fresh state');
  assert.equal(out.state.powerLimitW, 252, 'the device was never touched (the driver read-back)');
});

test('F1: apply-settings REFUSES 300 W in ADVANCED mode when the 2023 runtime is NOT capable — never a silent 252 W clamp', async () => {
  const backend = new MockBackend({ extendedRanges: false }); // not-capable degradation
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' });
  let delegated = false;
  const applyRunner = {
    needsWorker: () => true,
    apply: async () => { delegated = true; return { result: { ok: true, perControl: {} }, state: {} }; },
    waiverAccept: async () => {},
    reset: async () => ({}),
  };
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, applyRunner });
  const out = await handlers['apply-settings'](0, { powerLimitW: 300, tempLimitC: 100 });
  assert.equal(delegated, false, 'the worker must never be spawned for a capability refusal');
  assert.equal(out.result.ok, false, 'a not-capable runtime must never report ok:true');
  assert.equal(out.extendedUnavailable, true);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.tempLimitC.ok, false);
  assert.equal(out.result.perControl.powerLimitW.errorCode, 'unsupported');
  assert.equal(out.result.perControl.powerLimitW.message, EXTENDED_UNAVAILABLE_MSG);
  // The refusal carries the FRESH state and never touches the device.
  assert.ok(out.state !== null, 'the refusal envelope must not null the state');
  assert.equal(out.state.powerLimitW, 210, 'the state is the pre-apply read-back');
  assert.equal(backend._state.powerLimitW, 210, 'the clamp never ran');
  assert.equal(backend._state.tempLimitC, 90, 'the clamp never ran');
});

test('F1: apply-settings still applies 300 W in advanced mode when the 2023 runtime IS capable', async () => {
  const backend = new MockBackend({ extendedRanges: true });
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null, ocMode: 'advanced' });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, oldIgcl: createMockOldIgcl(backend) });
  const out = await handlers['apply-settings'](0, { powerLimitW: 300 });
  assert.equal(out.result.ok, true);
  assert.equal(out.result.perControl.powerLimitW.ok, true);
  assert.equal(out.state.powerLimitW, 300, '300 W lands, unclamped, via the mock old runtime');
});

test('M3-C-E: STOCK mode + no probe -> a 300 W request REFUSES (the gate, not the clamp)', async () => {
  const backend = new IgclBackend({ lib: makeFakeIgclLib() });
  await backend.init();
  const { handlers } = createIpcHandlers({ backend, store: fakeStore(), emit: () => {}, applyRunner: capturingRunner() });
  capturingRunner.delegated = undefined; // clear the shared capturing slot
  const out = await handlers['apply-settings'](0, { powerLimitW: 300 });
  assert.equal(out.result.ok, false);
  assert.equal(capturingRunner.delegated, undefined, 'nothing is delegated for a mode refusal');
  assert.match(out.result.perControl.powerLimitW.message, /Advanced OC Mode/);
});

// ---------------------------------------------------------------------------
// M2C-C S2: waiver state across the worker boundary
// ---------------------------------------------------------------------------

test('S2: the delegation request carries the parent-side waiverAccepted flag', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true);
  const { handlers } = createIpcHandlers({ backend, store: fakeStore(), emit: () => {}, applyRunner: capturingRunner() });
  await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(capturingRunner.delegated.waiverAccepted, true, 'an accepted parent flag rides in the request');
});

test('S2: an UN-accepted parent flag is carried as waiverAccepted:false (never omitted)', async () => {
  const backend = new MockBackend(); // never accepted
  const { handlers } = createIpcHandlers({ backend, store: fakeStore(), emit: () => {}, applyRunner: capturingRunner() });
  await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(capturingRunner.delegated.waiverAccepted, false);
});

test('S2: waiver-accept THROUGH the worker sets the parent-side in-memory flag (no split-brain)', async () => {
  const backend = new MockBackend();
  const { handlers } = createIpcHandlers({
    backend, store: fakeStore(), emit: () => {},
    applyRunner: { needsWorker: () => true, apply: async () => ({}), waiverAccept: async () => {}, reset: async () => ({}) },
  });
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, false);
  const out = await handlers['waiver-accept'](0);
  assert.equal(out.accepted, true);
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true, 'the parent flag must reflect the worker acceptance');
});

test('S2: the G2 wedge is closed — a waiver-not-set worker result clears the parent flag so the dialog re-shows', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true); // stale seeded-true parent flag
  const { handlers } = createIpcHandlers({
    backend, store: fakeStore(), emit: () => {},
    applyRunner: {
      needsWorker: () => true,
      apply: async () => ({
        worker: true,
        // the driver lost the waiver mid-session: every control fails
        result: { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'waiver-not-set' } } },
        state: {},
      }),
      waiverAccept: async () => {},
      reset: async () => ({}),
    },
  });
  const out = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(out.result.ok, false);
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, false, 'getCapabilities must re-report unaccepted — the dialog re-shows');
});
