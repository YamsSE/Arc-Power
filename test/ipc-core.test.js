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
import { hasRetryable } from '../src/main/apply-retry.js';
import { MockBackend } from '../src/main/backend/mock-backend.js';
import { createMockIgs } from '../src/main/igs-service.js';
import { createMockStartup } from '../src/main/startup.js';

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

/** Construct a mock IGS adapter from env knobs and restore the env afterwards. */
function makeEnvIgs({ running, app } = {}) {
  const prev = {
    RID_MOCK_IGS_RUNNING: process.env.RID_MOCK_IGS_RUNNING,
    RID_MOCK_IGS_APP: process.env.RID_MOCK_IGS_APP,
  };
  for (const [k, v] of Object.entries({ RID_MOCK_IGS_RUNNING: running, RID_MOCK_IGS_APP: app })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return {
    igs: createMockIgs(),
    restore: () => {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
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

test('igs-service mock: default state is fully on (service + app running) — matches this machine', async () => {
  const env = makeEnvIgs();
  try {
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: env.igs });
    assert.deepEqual(await handlers['igs-service-state'](), {
      service: { found: true, running: true, startType: 'auto' },
      appRunning: true,
    });
  } finally {
    env.restore();
  }
});

test('igs-service mock: RID_MOCK_IGS_RUNNING=0 -> service stopped (disabled), app still running', async () => {
  const env = makeEnvIgs({ running: '0' });
  try {
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: env.igs });
    assert.deepEqual(await handlers['igs-service-state'](), {
      service: { found: true, running: false, startType: 'disabled' },
      appRunning: true,
    });
  } finally {
    env.restore();
  }
});

test('igs-service mock: RID_MOCK_IGS_APP=0 -> app not running, service still running', async () => {
  const env = makeEnvIgs({ app: '0' });
  try {
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: env.igs });
    assert.deepEqual(await handlers['igs-service-state'](), {
      service: { found: true, running: true, startType: 'auto' },
      appRunning: false,
    });
  } finally {
    env.restore();
  }
});

test('igs-service mock: both knobs =0 -> fully off', async () => {
  const env = makeEnvIgs({ running: '0', app: '0' });
  try {
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: env.igs });
    assert.deepEqual(await handlers['igs-service-state'](), {
      service: { found: true, running: false, startType: 'disabled' },
      appRunning: false,
    });
  } finally {
    env.restore();
  }
});

test('igs-service mock: disable/enable flip ONLY the service part — appRunning untouched — no spawning', async () => {
  const env = makeEnvIgs({ app: '0' }); // app off: must STAY off through the toggle
  try {
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {}, igs: env.igs });

    assert.deepEqual(await handlers['igs-service-disable'](), { ok: true });
    assert.deepEqual(await handlers['igs-service-state'](), {
      service: { found: true, running: false, startType: 'disabled' },
      appRunning: false,
    });

    assert.deepEqual(await handlers['igs-service-enable'](), { ok: true });
    assert.deepEqual(await handlers['igs-service-state'](), {
      service: { found: true, running: true, startType: 'auto' },
      appRunning: false,
    });
  } finally {
    env.restore();
  }
});

test('igs-service channels: the DEFAULT adapter is the MOCK — no injection means no elevation, ever', async () => {
  const env = makeEnvIgs();
  try {
    // No `igs` injected: the default MUST be the mock adapter. With the real
    // adapter these calls would spawn an ELEVATED helper (UAC) instead of
    // flipping the in-memory state — so this test fails by construction if
    // the default ever regresses to the real service.
    const { handlers } = createIpcHandlers({ backend: new MockBackend(), store: fakeStore(), emit: () => {} });

    assert.deepEqual(await handlers['igs-service-disable'](), { ok: true });
    assert.deepEqual(await handlers['igs-service-state'](), {
      service: { found: true, running: false, startType: 'disabled' },
      appRunning: true,
    });

    assert.deepEqual(await handlers['igs-service-enable'](), { ok: true });
    assert.deepEqual(await handlers['igs-service-state'](), {
      service: { found: true, running: true, startType: 'auto' },
      appRunning: true,
    });
  } finally {
    env.restore();
  }
});

// ---------------------------------------------------------------------------
// F3 retry-with-verify (M2C-A) — replaces the M2b io-failed-only retry policy
// ---------------------------------------------------------------------------

/** Fully-off IGS stub: retries stay enabled (the default mock is fully on,
 *  which would take the single-attempt fast path). */
function fullyOffIgs() {
  return { getState: async () => ({ service: { found: true, running: false, startType: 'disabled' }, appRunning: false }) };
}

test('hasRetryable (F3 replacement for the M2b io-failed-only predicate): true for io-failed and silent no-ops, never for hard outcomes', () => {
  assert.equal(hasRetryable({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed' } } }), true);
  assert.equal(hasRetryable({ ok: false, perControl: { powerLimitW: { ok: false, silentNoop: true } } }), true);
  assert.equal(hasRetryable({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'waiver-not-set' } } }), false);
  assert.equal(hasRetryable({ ok: true, perControl: {} }), false);
  assert.equal(hasRetryable({ ok: false, perControl: {} }), false);
});

function countingBackend() {
  const backend = new MockBackend();
  const calls = { apply: 0 };
  backend.applySettings = async function applyCounting(deviceId, settings) {
    calls.apply += 1;
    return MockBackend.prototype.applySettings.call(this, deviceId, settings);
  };
  return { backend, calls };
}

test('apply-settings: an io-failed apply is retried with backoff and marked retried on success', async () => {
  const { backend, calls } = countingBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, igs: fullyOffIgs(), applyRetryBackoffs: [1, 1], applyBudgetMs: 60_000 });

  // Fail io-failed twice, then succeed on the third attempt.
  const realApply = backend.applySettings.bind(backend);
  let fails = 2;
  let attempts = 0;
  backend.applySettings = async (deviceId, settings) => {
    attempts += 1;
    if (fails > 0) {
      fails -= 1;
      return { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', message: 'driver busy' } } };
    }
    return realApply(deviceId, settings);
  };

  const { result, state } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(attempts, 3); // initial + 2 retries
  assert.equal(calls.apply, 1); // only the final attempt reached the backend
  assert.equal(result.ok, true);
  assert.equal(result.retried, true);
  assert.equal(result.attempts, 3);
  assert.equal(result.gaveUp, false);
  assert.equal(state.powerLimitW, 220);
});

test('apply-settings: an always-io-failed apply gives up within the budget, retried: true, honest result', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({
    backend, store, emit: () => {}, igs: fullyOffIgs(),
    // Deterministic give-up: attempt 1, retry at +1 ms, attempt 2, then the
    // 1000 ms backoff exceeds the 10 ms budget.
    applyRetryBackoffs: [1, 1000], applyBudgetMs: 10,
  });

  backend.applySettings = async () => ({
    ok: false,
    perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', message: 'driver busy' } },
  });
  const attemptCount = { n: 0 };
  const orig = backend.applySettings.bind(backend);
  backend.applySettings = async (d, s) => { attemptCount.n += 1; return orig(d, s); };

  const { result } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(attemptCount.n, 2);
  assert.equal(result.ok, false);
  assert.equal(result.retried, true);
  assert.equal(result.gaveUp, true);
  assert.equal(result.perControl.powerLimitW.errorCode, 'io-failed');
});

test('apply-settings: non-io-failed errors are NEVER retried (waiver/out-of-range are hard)', async () => {
  const { backend, calls } = countingBackend();
  backend.injectFail('powerLimitW', 'waiver-not-set');
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, igs: fullyOffIgs() });

  const { result } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(calls.apply, 1);
  assert.equal(result.retried, false);
  assert.equal(result.perControl.powerLimitW.errorCode, 'waiver-not-set');
});

test('apply-settings: success on the first attempt is not marked retried', async () => {
  const { backend, calls } = countingBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} });

  const { result } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(calls.apply, 1);
  assert.equal(result.retried, false);
  assert.equal(result.ok, true);
});

test('apply-settings: partial re-apply — a hard-failed control keeps its honest result, retry sends only the retryable one', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const sent = [];
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, igs: fullyOffIgs(), applyRetryBackoffs: [1, 1], applyBudgetMs: 60_000 });

  let n = 0;
  backend.applySettings = async (d, s) => {
    n += 1;
    sent.push({ ...s });
    if (n < 3) {
      return {
        ok: false,
        perControl: {
          powerLimitW: { ok: false, errorCode: 'io-failed', message: 'driver busy' },
          tempLimitC: { ok: false, errorCode: 'waiver-not-set', message: 'waiver' },
        },
      };
    }
    return { ok: true, perControl: { powerLimitW: { ok: true, readBackEqual: true } } };
  };
  const { result } = await handlers['apply-settings'](0, { powerLimitW: 220, tempLimitC: 85 });
  assert.equal(n, 3);
  assert.equal(result.retried, true);
  // The hard-failed control (waiver) is never re-sent after the first
  // attempt and its honest failure survives into the final result.
  assert.deepEqual(Object.keys(sent[1]).sort(), ['powerLimitW']);
  assert.deepEqual(Object.keys(sent[2]).sort(), ['powerLimitW']);
  assert.equal(result.ok, false, 'partial result stays honest');
  assert.equal(result.perControl.tempLimitC.errorCode, 'waiver-not-set');
  assert.equal(result.perControl.powerLimitW.ok, true);
});

// --- F3 additions: fast path, progress events, cancel, silent no-op --------

test('apply-settings: IGS fully ON -> single attempt even when the backend would fail', async () => {
  const { backend } = countingBackend();
  const store = fakeStore();
  const attempts = { n: 0 };
  backend.applySettings = async (d, s) => {
    attempts.n += 1;
    return { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', message: 'busy' } } };
  };
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {} }); // default mock igs = fully on

  const { result } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(attempts.n, 1, 'fast path: single attempt, no retries');
  assert.equal(result.retried, false);
  assert.equal(result.gaveUp, true, 'a retryable refusal on the fast path is still a give-up (summary fires)');
  assert.equal(result.ok, false, 'still honest: the failure is reported');
});

test('apply-settings: retry progress is pushed as apply:progress events (deviceId-scoped)', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const emitted = [];
  const { handlers } = createIpcHandlers({ backend, store, emit: (ch, p) => emitted.push([ch, p]), igs: fullyOffIgs(), applyRetryBackoffs: [1, 1], applyBudgetMs: 60_000 });

  let n = 0;
  const real = MockBackend.prototype.applySettings.bind(backend);
  backend.applySettings = async (d, s) => {
    n += 1;
    if (n < 3) return { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed' } } };
    return real(d, s);
  };

  await handlers['apply-settings'](0, { powerLimitW: 220 });
  const progress = emitted.filter(([ch]) => ch === 'apply:progress');
  assert.equal(progress.length, 2, 'one progress event per retry');
  assert.deepEqual(progress.map(([, p]) => p.deviceId), [0, 0]);
  assert.deepEqual(progress.map(([, p]) => p.attempt), [1, 2]);
  assert.ok(progress.every(([, p]) => Array.isArray(p.controls) && p.controls.includes('powerLimitW')));
});

test('apply-cancel: aborts the in-flight apply; the handler returns the honest partial result', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, igs: fullyOffIgs(), applyRetryBackoffs: [500], applyBudgetMs: 60_000 });

  backend.applySettings = async () => ({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed' } } });

  const pending = handlers['apply-settings'](0, { powerLimitW: 220 });
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(await handlers['apply-cancel'](0), { ok: true });
  const { result } = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.ok, false);
  assert.equal(result.perControl.powerLimitW.errorCode, 'io-failed');
});

test('apply-settings: a SILENT NO-OP (SUCCESS + unchanged read-back) is retried, never reported applied', async () => {
  const backend = new MockBackend();
  const store = fakeStore();
  const { handlers } = createIpcHandlers({ backend, store, emit: () => {}, igs: fullyOffIgs(), applyRetryBackoffs: [1, 1], applyBudgetMs: 60_000 });

  let n = 0;
  const real = MockBackend.prototype.applySettings.bind(backend);
  backend.applySettings = async (d, s) => {
    n += 1;
    if (n < 3) {
      // E4 evidence shape: SUCCESS + read-back unchanged (the driver accepted
      // nothing). The backend flags silentNoop: true — must be retried.
      return { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true, message: 'read-back 210 != requested 220' } } };
    }
    return real(d, s);
  };

  const { result, state } = await handlers['apply-settings'](0, { powerLimitW: 220 });
  assert.equal(n, 3);
  assert.equal(result.retried, true);
  assert.equal(result.ok, true);
  assert.equal(result.perControl.powerLimitW.ok, true);
  assert.equal(state.powerLimitW, 220);
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

  assert.deepEqual(await handlers['startup-get'](), { enabled: false, profileId: null, value: null });
  const setOut = await handlers['startup-set'](true, 'p1');
  assert.equal(setOut.enabled, true);
  assert.equal(setOut.profileId, 'p1');
  assert.match(setOut.value, /--apply-profile p1/);
  assert.deepEqual(await handlers['startup-get'](), setOut);

  assert.deepEqual(await handlers['startup-set'](false, null), { enabled: false, profileId: null, value: null });
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
  assert.equal(out.enabled, true);
  assert.equal(out.profileId, 'profile-1');
});

// ---------------------------------------------------------------------------
// M2b-B: driver-info, fps-poll, profiles + tray-rebuild channels
// ---------------------------------------------------------------------------

function fakeProfileStore(initialProfiles = []) {
  const profiles = [...initialProfiles];
  let settings = { waiverAccepted: false, ocOnBoot: false, activeProfileId: null };
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

  assert.deepEqual(await handlers['profiles-list'](), { profiles: [], settings: { waiverAccepted: false, ocOnBoot: false, activeProfileId: null } });
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

test('profiles-settings-save: read-modify-write never clobbers waiverAccepted', async () => {
  const store = fakeProfileStore();
  const { handlers } = createIpcHandlers({ backend: new MockBackend(), store, emit: () => {} });

  // Seed an accepted waiver (as waiver-accept would).
  await store.saveSettings({ waiverAccepted: true, ocOnBoot: false, activeProfileId: null });

  const out = await handlers['profiles-settings-save']({ activeProfileId: 'p1', ocOnBoot: true });
  assert.deepEqual(out, { waiverAccepted: true, ocOnBoot: true, activeProfileId: 'p1' });
  const clear = await handlers['profiles-settings-save']({ ocOnBoot: false, activeProfileId: null });
  assert.deepEqual(clear, { waiverAccepted: true, ocOnBoot: false, activeProfileId: null });

  for (const bad of [null, 5, 'x', []]) {
    await assert.rejects(() => handlers['profiles-settings-save'](bad), /patch must be an object/);
  }
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
