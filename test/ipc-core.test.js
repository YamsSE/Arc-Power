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
import {
  assertValidDeviceId,
  sanitizeSettings,
  clampSettings,
  createIpcHandlers,
  seedWaiverState,
} from '../src/main/ipc-core.js';
import { MockBackend } from '../src/main/backend/mock-backend.js';
import { createMockIgs } from '../src/main/igs-service.js';

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
  const ranges = {
    gpuVoltOffsetV: { min: 0, max: 0.234, step: 0.005, default: 0, units: 'V' },
  };
  const out = clampSettings({ gpuLock: { voltageV: 99, freqMhz: -5 } }, ranges);
  assert.deepEqual(out.gpuLock, { voltageV: 0.234, freqMhz: 0 });
});

// ---------------------------------------------------------------------------
// product-path waiver: never auto-accepted
// ---------------------------------------------------------------------------

function fakeStore(initial = { waiverAccepted: false, ocOnBoot: false, activeProfileId: null }) {
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
  assert.deepEqual(state.gpuLock, { voltageV: 0.234, freqMhz: 0 });
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

test('apply-settings: a waiver-not-set apply clears the flag so waiver-get reports unaccepted (G2 regression)', async () => {
  const backend = new MockBackend();
  await backend.restoreWaiverState(0, true); // persisted-accepted boot seed
  assert.equal((await backend.getCapabilities(0)).waiverAccepted, true);
  backend.injectFail('powerLimitW', 'waiver-not-set'); // driver lost the waiver
  const store = fakeStore({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const res = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(res.result.ok, false);
  assert.equal(res.result.perControl.powerLimitW.errorCode, 'waiver-not-set');
  // The in-memory flag was cleared (NOT accepted): the next waiver-get is
  // unaccepted so the renderer re-shows the dialog on the next apply. The
  // store is untouched — only the in-memory flag was reconciled.
  assert.deepEqual(await handlers['waiver-get'](0), { accepted: false });
  assert.equal(store.saved.length, 0);
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
// IGS service channels (M2a extension)
// ---------------------------------------------------------------------------

/** Construct a mock IGS adapter from an env value and restore env afterwards. */
function makeEnvIgs(envValue) {
  const prev = process.env.RID_MOCK_IGS_RUNNING;
  if (envValue === undefined) delete process.env.RID_MOCK_IGS_RUNNING;
  else process.env.RID_MOCK_IGS_RUNNING = envValue;
  return {
    igs: createMockIgs(),
    restore: () => {
      if (prev === undefined) delete process.env.RID_MOCK_IGS_RUNNING;
      else process.env.RID_MOCK_IGS_RUNNING = prev;
    },
  };
}

test('igs-service channels: registered, and the no-payload channels reject payloads', async () => {
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: createMockIgs() });
  assert.equal(typeof handlers['igs-service-state'], 'function');
  assert.equal(typeof handlers['igs-service-disable'], 'function');
  assert.equal(typeof handlers['igs-service-enable'], 'function');

  for (const channel of ['igs-service-state', 'igs-service-disable', 'igs-service-enable']) {
    await assert.rejects(() => handlers[channel]({}), /takes no payload/, channel);
    await assert.rejects(() => handlers[channel](0), /takes no payload/, channel);
  }
});

test('igs-service mock: default state is running (auto) — matches this machine', async () => {
  const env = makeEnvIgs(undefined);
  try {
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: env.igs });
    assert.deepEqual(await handlers['igs-service-state'](), { found: true, running: true, startType: 'auto' });
  } finally {
    env.restore();
  }
});

test('igs-service mock: RID_MOCK_IGS_RUNNING=0 -> stopped (disabled)', async () => {
  const env = makeEnvIgs('0');
  try {
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: env.igs });
    assert.deepEqual(await handlers['igs-service-state'](), { found: true, running: false, startType: 'disabled' });
  } finally {
    env.restore();
  }
});

test('igs-service mock: disable flips to stopped+disabled, enable flips back — no spawning', async () => {
  const env = makeEnvIgs(undefined);
  try {
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: env.igs });

    assert.deepEqual(await handlers['igs-service-disable'](), { ok: true });
    assert.deepEqual(await handlers['igs-service-state'](), { found: true, running: false, startType: 'disabled' });

    assert.deepEqual(await handlers['igs-service-enable'](), { ok: true });
    assert.deepEqual(await handlers['igs-service-state'](), { found: true, running: true, startType: 'auto' });
  } finally {
    env.restore();
  }
});

test('igs-service channels: the DEFAULT adapter is the MOCK — no injection means no elevation, ever', async () => {
  const env = makeEnvIgs(undefined);
  try {
    // No `igs` injected: the default MUST be the mock adapter. With the real
    // adapter these calls would spawn an ELEVATED helper (UAC) instead of
    // flipping the in-memory state — so this test fails by construction if
    // the default ever regresses to the real service.
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });

    assert.deepEqual(await handlers['igs-service-disable'](), { ok: true });
    assert.deepEqual(await handlers['igs-service-state'](), { found: true, running: false, startType: 'disabled' });

    assert.deepEqual(await handlers['igs-service-enable'](), { ok: true });
    assert.deepEqual(await handlers['igs-service-state'](), { found: true, running: true, startType: 'auto' });
  } finally {
    env.restore();
  }
});
