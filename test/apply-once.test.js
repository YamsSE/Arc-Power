// M2C-B F3 + M2C-C — instant-apply core tests (electron-free).
// Pins the revised semantics (plan.md M2C F3 REVISED + M2C-C root-cause
// revision, docs §8c):
//   - ONE attempt per control: a backend that would fail N times is called
//     exactly once — no retries, no backoff, no budgets, no cancellation;
//   - the SILENT NO-OP (SUCCESS + unchanged read-back) is a per-control
//     FAIL — NEVER reported as applied (the anti-lie guarantee is exactly
//     as strong as before);
//   - hard errors (out-of-range family / waiver / invalid-argument) fail
//     instantly and keep their errorCode (renderer maps via errorMessage);
//   - M2C-C: refusals carry the PLAIN driver message + error code — the
//     IGS-on requirement wording is REMOVED (the real gate was elevation,
//     not IGS state; the elevation-aware delayed re-verification lives in
//     apply-routing.js, not here).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyOnce,
  classifyOutcome,
  refusalMessage,
  HARD_ERROR_CODES,
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
// M2C-C refusal message composition (plain driver message + code; IGS text gone)
// ---------------------------------------------------------------------------

test('M2C-C: the IGS-on requirement message is REMOVED (never emitted)', () => {
  // The root-cause revision (docs §8c): the gate was ELEVATION, not IGS —
  // the IGS-naming wording was based on the wrong root cause. The constant
  // is kept ONLY as a greppable tombstone and must be empty.
  assert.equal(REFUSAL_IGS_MSG, '');
  assert.equal(REFUSAL_IGS_MSG.includes('Intel Graphics Software'), false);
});

const refusal = (control, patch = {}) => ({ ok: false, errorCode: 'io-failed', ...patch });
const silentNoop = (control) => ({ ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true, message: `read-back unchanged (${control})` });

test('refusalMessage: EVERY refusal gets the plain driver message + code (no IGS naming)', () => {
  for (const control of ['powerLimitW', 'gpuFreqOffsetMhz', 'gpuVoltOffsetV', 'tempLimitC', 'gpuLock', 'vfCurve', 'fanCurve']) {
    assert.equal(refusalMessage(control, refusal(control)), `${REFUSAL_PLAIN_MSG} (io-failed)`, control);
    // silent no-ops too — the momentary lie is a refusal, never "applied"
    assert.equal(refusalMessage(control, silentNoop(control)), `${REFUSAL_PLAIN_MSG} (io-failed)`, `${control} silent no-op`);
  }
});

test('refusalMessage: without an error code -> plain message only', () => {
  assert.equal(refusalMessage('powerLimitW', { ok: false }), REFUSAL_PLAIN_MSG);
});

test('refusalMessage: ok/hard outcomes never get a refusal message', () => {
  assert.equal(refusalMessage('powerLimitW', { ok: true, readBackEqual: true }), null);
  assert.equal(refusalMessage('powerLimitW', { ok: false, errorCode: 'waiver-not-set' }), null);
  assert.equal(refusalMessage('powerLimitW', { ok: false, errorCode: 'out-of-range' }), null);
  assert.equal(refusalMessage('powerLimitW', undefined), null);
  // a refusal is a refusal regardless of any diagnostic text the backend
  // attached (the composed message wins — the backend text is diagnostic)
  assert.equal(refusalMessage('powerLimitW', { ok: false, errorCode: 'io-failed', message: 'raw' }), `${REFUSAL_PLAIN_MSG} (io-failed)`);
});

test('refusalMessage + classifyOutcome: a silent no-op can NEVER be reported applied (ok:true + readBackEqual:false)', async () => {
  // Hypothetical backend shape (none emits it today): the setter reports ok
  // but the read-back did not match. Both guards must treat it as a refusal
  // — classification AND message composition agree (review NIT 3).
  const per = { ok: true, readBackEqual: false };
  assert.equal(classifyOutcome(per), 'refusal');
  assert.equal(refusalMessage('powerLimitW', per), REFUSAL_PLAIN_MSG);
  // end-to-end: applyOnce forces the control to a FAILING result with the
  // composed message instead of reporting it applied
  const backend = stubBackend(() => ({ ok: true, perControl: { powerLimitW: { ...per } } }));
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220 } });
  assert.equal(out.result.ok, false, 'a silent no-op can never be reported applied');
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.powerLimitW.message, REFUSAL_PLAIN_MSG);
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
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220 } });
  assert.equal(backend.calls.length, 1, 'one attempt — no retry loop, no backoff');
  assert.equal(out.attempts, 1);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.powerLimitW.message, `${REFUSAL_PLAIN_MSG} (io-failed)`);
});

test('F3: a silent no-op is a per-control FAIL with the plain message, NEVER applied', async () => {
  const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: silentNoop('powerLimitW') } }));
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220 } });
  assert.equal(backend.calls.length, 1);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  assert.equal(out.result.perControl.powerLimitW.silentNoop, true, 'the silent no-op flag survives');
  assert.equal(out.result.perControl.powerLimitW.message, `${REFUSAL_PLAIN_MSG} (io-failed)`);
});

test('F3: hard errors fail instantly with their errorCode and NO refusal message', async () => {
  for (const code of ['out-of-range', 'waiver-not-set']) {
    const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: code } } }));
    const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220 } });
    assert.equal(backend.calls.length, 1, `${code} is never retried`);
    assert.equal(out.result.ok, false);
    assert.equal(out.result.perControl.powerLimitW.errorCode, code);
    assert.equal(out.result.perControl.powerLimitW.message, undefined, 'hard errors keep the renderer errorMessage mapping');
  }
});

test('F3/M2C-C: every refusal gets the plain message + code regardless of control', async () => {
  // powerLimit
  let out = await applyOnce({
    backend: stubBackend(() => ({ ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } })),
    deviceId: 0,
    settings: { powerLimitW: 220 },
  });
  assert.equal(out.result.perControl.powerLimitW.message, `${REFUSAL_PLAIN_MSG} (io-failed)`);

  // voltage
  out = await applyOnce({
    backend: stubBackend(() => ({ ok: false, perControl: { gpuVoltOffsetV: ioFailed('gpuVoltOffsetV') } })),
    deviceId: 0,
    settings: { gpuVoltOffsetV: 0.05 },
  });
  assert.equal(out.result.perControl.gpuVoltOffsetV.message, `${REFUSAL_PLAIN_MSG} (io-failed)`);

  // tempLimit
  out = await applyOnce({
    backend: stubBackend(() => ({ ok: false, perControl: { tempLimitC: ioFailed('tempLimitC') } })),
    deviceId: 0,
    settings: { tempLimitC: 85 },
  });
  assert.equal(out.result.perControl.tempLimitC.message, `${REFUSAL_PLAIN_MSG} (io-failed)`);
});

test('F3: success on a single attempt reports ok + per-control read-back verification', async () => {
  const backend = stubBackend(() => ({ ok: true, perControl: { powerLimitW: okResult('powerLimitW'), gpuVoltOffsetV: okResult('gpuVoltOffsetV') } }));
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220, gpuVoltOffsetV: 0.05 } });
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
  const out = await applyOnce({ backend, deviceId: 0, settings: { powerLimitW: 220, tempLimitC: 92 } });
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
