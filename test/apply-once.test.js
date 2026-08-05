// M2C-B F3 — instant-apply core tests (electron-free).
// Pins the revised semantics (plan.md M2C F3 REVISED, docs §8a evidence):
//   - ONE attempt per control: a backend that would fail N times is called
//     exactly once — no retries, no backoff, no budgets, no cancellation;
//   - the SILENT NO-OP (SUCCESS + unchanged read-back) is a per-control
//     FAIL — NEVER reported as applied (the anti-lie guarantee is exactly
//     as strong as before);
//   - hard errors (out-of-range family / waiver / invalid-argument) fail
//     instantly and keep their errorCode (renderer maps via errorMessage);
//   - refusals get an ACTIONABLE composed message: powerLimit/freq (and
//     silent no-ops on those) name the IGS-on requirement when IGS is not
//     fully on; every other refusal gets the plain driver message; with
//     IGS fully on a refusal is plain + error code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOnce,
  classifyOutcome,
  refusalMessage,
  isIgsFullyOn,
  HARD_ERROR_CODES,
  IGS_REQUIRED_CONTROLS,
  REFUSAL_PLAIN_MSG,
  REFUSAL_IGS_MSG,
} from '../src/main/apply-once.js';
import { clampSettings } from '../src/main/ipc-core.js';
import { TEMP_LIMIT_MAX_C } from '../src/main/backend/units.js';

// ---------------------------------------------------------------------------
// Outcome classification (per-control)
// ---------------------------------------------------------------------------

test('classifyOutcome: ok when applied + read-back matches', () => {
  assert.equal(classifyOutcome({ ok: true, readBackEqual: true }), 'ok');
  assert.equal(classifyOutcome({ ok: true }), 'ok');
});

test('classifyOutcome: SILENT NO-OP (SUCCESS + unchanged read-back) is a refusal, NOT ok', () => {
  // The E4 evidence shape: the setter returned SUCCESS but the read-back
  // never changed — the backend flags silentNoop and MUST NOT report applied.
  const per = { ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true, message: 'read-back 252 != requested 220' };
  assert.equal(classifyOutcome(per), 'refusal');
});

test('classifyOutcome: hard error codes are never refusals (instant fail, errorCode kept)', () => {
  for (const code of ['waiver-not-set', 'out-of-range', 'locked-mode', 'reset-required', 'invalid-argument', 'unsupported', 'unavailable-symbol']) {
    assert.equal(classifyOutcome({ ok: false, errorCode: code }), 'hard', code);
    assert.equal(HARD_ERROR_CODES.has(code), true, code);
  }
});

test('classifyOutcome: io-failed (incl. NOT_AVAILABLE) is a refusal (instant fail)', () => {
  assert.equal(classifyOutcome({ ok: false, errorCode: 'io-failed' }), 'refusal');
  // any unmapped/unknown code degrades to refusal (safe direction)
  assert.equal(classifyOutcome({ ok: false, errorCode: undefined }), 'refusal');
  assert.equal(classifyOutcome({ ok: false }), 'refusal');
});

// ---------------------------------------------------------------------------
// IGS predicate + refusal message composition (pure)
// ---------------------------------------------------------------------------

test('isIgsFullyOn: only service running AND app running is fully on', () => {
  const fullyOn = { service: { found: true, running: true, startType: 'auto' }, appRunning: true };
  assert.equal(isIgsFullyOn(fullyOn), true);
  assert.equal(isIgsFullyOn({ service: { running: true }, appRunning: false }), false);
  assert.equal(isIgsFullyOn({ service: { running: false }, appRunning: true }), false);
  assert.equal(isIgsFullyOn({ service: { running: false }, appRunning: false }), false);
  // degraded probe (service not found) is NOT fully on
  assert.equal(isIgsFullyOn({ service: { found: false, running: false, startType: 'unknown' }, appRunning: false }), false);
  assert.equal(isIgsFullyOn(null), false);
});

const IGS_ON = { service: { found: true, running: true, startType: 'auto' }, appRunning: true };
const IGS_OFF = { service: { found: true, running: false, startType: 'disabled' }, appRunning: false };
const refusal = (control, patch = {}) => ({ ok: false, errorCode: 'io-failed', ...patch });
const silentNoop = (control) => ({ ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true, message: `read-back unchanged (${control})` });

test('IGS_REQUIRED_CONTROLS: power/freq controls are the IGS-gated ones', () => {
  assert.deepEqual([...IGS_REQUIRED_CONTROLS].sort(), ['gpuFreqOffsetMhz', 'powerLimitW', 'vramFreqOffsetGts']);
});

test('refusalMessage: powerLimit/freq refusal with IGS off names the IGS-on requirement', () => {
  for (const control of IGS_REQUIRED_CONTROLS) {
    assert.equal(refusalMessage(control, refusal(control), IGS_OFF), REFUSAL_IGS_MSG, control);
    // silent no-ops on those controls get the same IGS message
    assert.equal(refusalMessage(control, silentNoop(control), IGS_OFF), REFUSAL_IGS_MSG, `${control} silent no-op`);
  }
});

test('refusalMessage: voltage/temp refusals get the plain driver message (IGS off)', () => {
  for (const control of ['gpuVoltOffsetV', 'tempLimitC', 'gpuLock', 'vfCurve', 'fanCurve']) {
    assert.equal(refusalMessage(control, refusal(control), IGS_OFF), REFUSAL_PLAIN_MSG, control);
  }
});

test('refusalMessage: ANY refusal with IGS fully on is plain + error code', () => {
  assert.equal(refusalMessage('powerLimitW', refusal('powerLimitW', { errorCode: 'io-failed' }), IGS_ON), `${REFUSAL_PLAIN_MSG} (io-failed)`);
  assert.equal(refusalMessage('gpuVoltOffsetV', refusal('gpuVoltOffsetV', { errorCode: 'io-failed' }), IGS_ON), `${REFUSAL_PLAIN_MSG} (io-failed)`);
  assert.equal(refusalMessage('powerLimitW', silentNoop('powerLimitW'), IGS_ON), `${REFUSAL_PLAIN_MSG} (io-failed)`);
  // no error code -> plain message only
  assert.equal(refusalMessage('powerLimitW', { ok: false }, IGS_ON), REFUSAL_PLAIN_MSG);
});

test('refusalMessage: ok/hard outcomes never get a refusal message', () => {
  assert.equal(refusalMessage('powerLimitW', { ok: true, readBackEqual: true }, IGS_OFF), null);
  assert.equal(refusalMessage('powerLimitW', { ok: false, errorCode: 'waiver-not-set' }, IGS_OFF), null);
  assert.equal(refusalMessage('powerLimitW', undefined, IGS_OFF), null);
  // a refusal is a refusal regardless of any diagnostic text the backend
  // attached (the composed message wins — the backend text is diagnostic)
  assert.equal(refusalMessage('powerLimitW', { ok: false, errorCode: 'io-failed', message: 'raw' }, IGS_OFF), REFUSAL_IGS_MSG);
});

test('refusalMessage + classifyOutcome: a silent no-op can NEVER be reported applied (ok:true + readBackEqual:false)', async () => {
  // Hypothetical backend shape (none emits it today): the setter reports ok
  // but the read-back did not match. Both guards must treat it as a refusal
  // — classification AND message composition agree (review NIT 3).
  const per = { ok: true, readBackEqual: false };
  assert.equal(classifyOutcome(per), 'refusal');
  // IGS off + IGS-gated control -> the IGS-on requirement message
  assert.equal(refusalMessage('powerLimitW', per, IGS_OFF), REFUSAL_IGS_MSG);
  // IGS off + other controls -> plain
  assert.equal(refusalMessage('gpuVoltOffsetV', per, IGS_OFF), REFUSAL_PLAIN_MSG);
  // IGS fully on -> plain + code (no code -> plain only)
  assert.equal(refusalMessage('powerLimitW', per, IGS_ON), REFUSAL_PLAIN_MSG);
  // end-to-end: applyOnce forces the control to a FAILING result with the
  // composed message instead of reporting it applied
  const backend = stubBackend(() => ({ ok: true, perControl: { powerLimitW: { ...per } } }));
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220 }, opts: { igsState: IGS_OFF } });
  assert.equal(out.result.ok, false, 'a silent no-op can never be reported applied');
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.powerLimitW.message, REFUSAL_IGS_MSG);
});

// ---------------------------------------------------------------------------
// Stub backend helpers
// ---------------------------------------------------------------------------

/** Minimal IOCBackend-shaped stub; applySettings counts + scripts outcomes. */
function stubBackend(script) {
  const calls = [];
  return {
    calls,
    applySettings: async (_deviceId, settings) => {
      const out = script(calls.length, { ...settings });
      calls.push({ ...settings });
      return out;
    },
  };
}

const ioFailed = (control) => ({ ok: false, errorCode: 'io-failed', message: `driver busy (${control})` });
const okResult = (control) => ({ ok: true, readBackEqual: true });

// ---------------------------------------------------------------------------
// Instant semantics (single attempt)
// ---------------------------------------------------------------------------

test('F3: exactly ONE backend call even when the backend would fail N times', async () => {
  const backend = stubBackend((n) => {
    if (n < 99) return { ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } };
    return { ok: true, perControl: { powerLimitW: okResult('powerLimitW') } };
  });
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220 }, opts: { igsState: IGS_OFF } });
  assert.equal(backend.calls.length, 1, 'one attempt — no retry loop, no backoff');
  assert.equal(out.attempts, 1);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.powerLimitW.message, REFUSAL_IGS_MSG);
});

test('F3: a silent no-op is a per-control FAIL with the IGS-conditional message, NEVER applied', async () => {
  const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: silentNoop('powerLimitW') } }));
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220 }, opts: { igsState: IGS_OFF } });
  assert.equal(backend.calls.length, 1);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.powerLimitW.silentNoop, true, 'the silent no-op flag survives');
  assert.equal(out.result.perControl.powerLimitW.message, REFUSAL_IGS_MSG);
});

test('F3: hard errors fail instantly with their errorCode and NO refusal message', async () => {
  for (const code of ['out-of-range', 'waiver-not-set']) {
    const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: code } } }));
    const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220 }, opts: { igsState: IGS_OFF } });
    assert.equal(backend.calls.length, 1, `${code} is never retried`);
    assert.equal(out.result.ok, false);
    assert.equal(out.result.perControl.powerLimitW.errorCode, code);
    assert.equal(out.result.perControl.powerLimitW.message, undefined, 'hard errors keep the renderer errorMessage mapping');
  }
});

test('F3: refusal with IGS off names IGS (power), plain message (volt); IGS on -> plain + code', async () => {
  // powerLimit + IGS off
  let out = await applyOnce({
    backend: stubBackend(() => ({ ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } })),
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { igsState: IGS_OFF },
  });
  assert.equal(out.result.perControl.powerLimitW.message, REFUSAL_IGS_MSG);

  // voltage + IGS off -> plain
  out = await applyOnce({
    backend: stubBackend(() => ({ ok: false, perControl: { gpuVoltOffsetV: ioFailed('gpuVoltOffsetV') } })),
    deviceId: 0,
    settings: { gpuVoltOffsetV: 0.05 },
    opts: { igsState: IGS_OFF },
  });
  assert.equal(out.result.perControl.gpuVoltOffsetV.message, REFUSAL_PLAIN_MSG);

  // tempLimit + IGS off -> plain
  out = await applyOnce({
    backend: stubBackend(() => ({ ok: false, perControl: { tempLimitC: ioFailed('tempLimitC') } })),
    deviceId: 0,
    settings: { tempLimitC: 85 },
    opts: { igsState: IGS_OFF },
  });
  assert.equal(out.result.perControl.tempLimitC.message, REFUSAL_PLAIN_MSG);

  // powerLimit + IGS fully on -> plain + code
  out = await applyOnce({
    backend: stubBackend(() => ({ ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } })),
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { igsState: IGS_ON },
  });
  assert.equal(out.result.perControl.powerLimitW.message, `${REFUSAL_PLAIN_MSG} (io-failed)`);
});

test('F3: success on a single attempt reports ok + per-control read-back verification', async () => {
  const backend = stubBackend(() => ({ ok: true, perControl: { powerLimitW: okResult('powerLimitW'), gpuVoltOffsetV: okResult('gpuVoltOffsetV') } }));
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220, gpuVoltOffsetV: 0.05 }, opts: { igsState: IGS_ON } });
  assert.equal(backend.calls.length, 1);
  assert.equal(out.result.ok, true);
  assert.equal(out.result.perControl.powerLimitW.ok, true);
  assert.equal(out.result.perControl.gpuVoltOffsetV.ok, true);
  assert.equal(out.result.perControl.powerLimitW.message, undefined);
});

test('F3: partial results stay honest — ok + hard in one apply', async () => {
  const backend = stubBackend(() => ({
    ok: false,
    perControl: {
      powerLimitW: okResult('powerLimitW'),
      tempLimitC: { ok: false, errorCode: 'out-of-range', message: '0x44000005' },
    },
  }));
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220, tempLimitC: 92 }, opts: { igsState: IGS_OFF } });
  assert.equal(out.result.ok, false, 'partial result stays honest');
  assert.equal(out.result.perControl.powerLimitW.ok, true);
  assert.equal(out.result.perControl.tempLimitC.errorCode, 'out-of-range');
});

// ---------------------------------------------------------------------------
// PT clamp (92 -> 90) — backend constant + ipc validation clamp
// ---------------------------------------------------------------------------

test('F3 PT clamp: the shared ceiling is 90 C', () => {
  assert.equal(TEMP_LIMIT_MAX_C, 90);
});

test('F3 PT clamp: main-process validation clamps tempLimitC to the capped range', () => {
  const ranges = { tempLimitC: { min: 60, max: TEMP_LIMIT_MAX_C, step: 1, default: 90, units: 'C' } };
  const out = clampSettings({ tempLimitC: 92 }, ranges);
  assert.equal(out.tempLimitC, 90);
});
