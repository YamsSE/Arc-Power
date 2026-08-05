// M2C-A F3 — retry-with-verify apply core tests (electron-free).
// Pins the evidence-based behavior (plan.md M2C-A F3, docs §8a):
//   - the SILENT NO-OP (SUCCESS + unchanged read-back) is a retryable
//     failure — NEVER reported as applied;
//   - retry scheduler: exact attempt counts, backoff schedule, budget cap,
//     and cancellation (abort semantics);
//   - IGS fully-on fast path: single attempt, no retries;
//   - partial re-apply: only the failed controls are re-sent;
//   - hard errors (out-of-range family / waiver / invalid-argument) are
//     never retried.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWithRetry,
  classifyControl,
  hasRetryable,
  isIgsFullyOn,
  backoffDelayMs,
  ApplyToken,
  HARD_ERROR_CODES,
  APPLY_BACKOFF_MS,
  APPLY_BUDGET_MS,
} from '../src/main/apply-retry.js';
import { clampSettings } from '../src/main/ipc-core.js';
import { TEMP_LIMIT_MAX_C } from '../src/main/backend/units.js';
import { applyGiveUpSummary } from '../src/renderer/pure/settings.ts';

// ---------------------------------------------------------------------------
// Outcome classification (per-control)
// ---------------------------------------------------------------------------

test('classifyControl: ok when applied + read-back matches', () => {
  assert.equal(classifyControl({ ok: true, readBackEqual: true }), 'ok');
  assert.equal(classifyControl({ ok: true }), 'ok');
});

test('classifyControl: SILENT NO-OP (SUCCESS + unchanged read-back) is retryable, NOT ok', () => {
  // The E4 evidence shape: the setter returned SUCCESS but the read-back
  // never changed — the backend flags silentNoop and MUST NOT report applied.
  const per = { ok: false, errorCode: 'io-failed', readBackEqual: false, silentNoop: true, message: 'read-back 252 != requested 220' };
  assert.equal(classifyControl(per), 'retryable');
  assert.equal(hasRetryable({ ok: false, perControl: { powerLimitW: per } }), true);
});

test('classifyControl: hard error codes are never retried', () => {
  for (const code of ['waiver-not-set', 'out-of-range', 'locked-mode', 'reset-required', 'invalid-argument', 'unsupported', 'unavailable-symbol']) {
    assert.equal(classifyControl({ ok: false, errorCode: code }), 'hard', code);
    assert.equal(HARD_ERROR_CODES.has(code), true, code);
  }
});

test('classifyControl: io-failed (incl. NOT_AVAILABLE) is retryable', () => {
  assert.equal(classifyControl({ ok: false, errorCode: 'io-failed' }), 'retryable');
  // any unmapped/unknown code degrades to retryable (safe direction)
  assert.equal(classifyControl({ ok: false, errorCode: undefined }), 'retryable');
  assert.equal(classifyControl({ ok: false }), 'retryable');
});

// ---------------------------------------------------------------------------
// IGS fast path + backoff schedule (pure)
// ---------------------------------------------------------------------------

test('isIgsFullyOn: only service running AND app running is fully on', () => {
  const fullyOn = { service: { found: true, running: true, startType: 'auto' }, appRunning: true };
  assert.equal(isIgsFullyOn(fullyOn), true);
  assert.equal(isIgsFullyOn({ service: { running: true }, appRunning: false }), false);
  assert.equal(isIgsFullyOn({ service: { running: false }, appRunning: true }), false);
  assert.equal(isIgsFullyOn({ service: { running: false }, appRunning: false }), false);
  // degraded probe (service not found) is NOT fully on -> retries enabled
  assert.equal(isIgsFullyOn({ service: { found: false, running: false, startType: 'unknown' }, appRunning: false }), false);
  assert.equal(isIgsFullyOn(null), false);
});

test('backoffDelayMs: 1s,2s,4s,8s,12s then capped at 12s', () => {
  assert.deepEqual(APPLY_BACKOFF_MS, [1000, 2000, 4000, 8000, 12000]);
  assert.equal(backoffDelayMs(1), 1000);
  assert.equal(backoffDelayMs(2), 2000);
  assert.equal(backoffDelayMs(3), 4000);
  assert.equal(backoffDelayMs(4), 8000);
  assert.equal(backoffDelayMs(5), 12000);
  assert.equal(backoffDelayMs(6), 12000);
  assert.equal(backoffDelayMs(20), 12000);
});

// ---------------------------------------------------------------------------
// Stub backend helpers
// ---------------------------------------------------------------------------

/** Minimal IOCBackend-shaped stub; only applySettings is scripted. */
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

const silentNoop = (control) => ({
  ok: false,
  errorCode: 'io-failed',
  readBackEqual: false,
  silentNoop: true,
  message: `read-back unchanged for ${control}`,
});
const ioFailed = (control) => ({ ok: false, errorCode: 'io-failed', message: `driver busy (${control})` });
const okResult = (control) => ({ ok: true, readBackEqual: true });

// ---------------------------------------------------------------------------
// No-op detection end to end
// ---------------------------------------------------------------------------

test('F3: silent no-op is retried, NEVER reported as applied, until a read-back matches', async () => {
  // Two silent no-ops, then the value finally lands.
  const backend = stubBackend((n) => {
    if (n < 2) return { ok: false, perControl: { powerLimitW: silentNoop('powerLimitW') } };
    return { ok: true, perControl: { powerLimitW: okResult('powerLimitW') } };
  });
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { backoffs: [1, 1], budgetMs: APPLY_BUDGET_MS, igsState: null },
  });
  assert.equal(backend.calls.length, 3, 'initial + 2 retries for 2 silent no-ops');
  assert.equal(out.attempts, 3);
  assert.equal(out.retried, true);
  assert.equal(out.gaveUp, false);
  assert.equal(out.result.ok, true);
  assert.equal(out.result.perControl.powerLimitW.ok, true);
});

test('F3: a permanently silent-no-op apply gives up honestly and reports NOT applied', async () => {
  const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: silentNoop('powerLimitW') } }));
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    // Budget exhausted after the second attempt: attempt 1 (t=0), retry at
    // +1 ms, attempt 2, then 2 + 1000 > 10 -> give up.
    opts: { backoffs: [1, 1000], budgetMs: 10, igsState: null },
  });
  assert.equal(out.gaveUp, true);
  assert.equal(out.attempts, 2);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.ok, false);
  // The silent no-op must NEVER flip to "applied".
  assert.equal(out.result.perControl.powerLimitW.silentNoop, true);
});

// ---------------------------------------------------------------------------
// Retry scheduler
// ---------------------------------------------------------------------------

test('F3: exactly N+1 attempts when the backend refuses N times then succeeds', async () => {
  const refuses = 3;
  const backend = stubBackend((n) => {
    if (n < refuses) return { ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } };
    return { ok: true, perControl: { powerLimitW: okResult('powerLimitW') } };
  });
  const progress = [];
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { backoffs: [1, 2, 4], budgetMs: APPLY_BUDGET_MS, igsState: null },
    onProgress: (p) => progress.push(p),
  });
  assert.equal(backend.calls.length, refuses + 1, 'exactly N+1 attempts');
  assert.equal(out.attempts, refuses + 1);
  assert.equal(out.result.ok, true);
  // Progress fired once per retry with ascending attempt numbers.
  assert.deepEqual(progress.map((p) => p.attempt), [1, 2, 3]);
  assert.ok(progress.every((p) => p.controls.includes('powerLimitW')));
});

test('F3: budget cap bounds the retries (give-up instead of looping forever)', async () => {
  const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } }));
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    // Deterministic cut: attempts 1..2 fit the 10 ms budget with 1 ms
    // backoffs, the third retry's 1000 ms delay exceeds it.
    opts: { backoffs: [1, 1, 1000], budgetMs: 10, igsState: null },
  });
  assert.equal(out.gaveUp, true);
  assert.equal(out.attempts, 3);
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.powerLimitW.errorCode, 'io-failed');
});

test('F3: cancellation stops further attempts (abort semantics)', async () => {
  const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } }));
  const token = new ApplyToken();
  const promise = applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { backoffs: [500], budgetMs: 60_000, igsState: null },
    signal: token,
  });
  await new Promise((r) => setTimeout(r, 60));
  token.abort();
  const out = await promise;
  assert.equal(out.cancelled, true);
  assert.equal(out.attempts, 1, 'only the first attempt ran');
  assert.equal(out.result.ok, false);
});

test('F3: a pre-aborted token runs no attempts at all', async () => {
  let calls = 0;
  const backend = { applySettings: async () => { calls += 1; return { ok: true, perControl: {} }; } };
  const token = new ApplyToken();
  token.abort();
  const out = await applyWithRetry({ backend, deviceId: 0, settings: { powerLimitW: 220 }, signal: token });
  assert.equal(calls, 0);
  assert.equal(out.cancelled, true);
  assert.equal(out.attempts, 0);
});

// ---------------------------------------------------------------------------
// IGS fast path
// ---------------------------------------------------------------------------

test('F3: IGS fully ON -> a single attempt even when the backend would fail', async () => {
  const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } }));
  const fullyOn = { service: { found: true, running: true, startType: 'auto' }, appRunning: true };
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { igsState: fullyOn, backoffs: [1], budgetMs: 60_000 },
  });
  assert.equal(backend.calls.length, 1, 'single attempt on the fully-on fast path');
  assert.equal(out.attempts, 1);
  assert.equal(out.retried, false);
  assert.equal(out.gaveUp, true, 'a retryable refusal on the fast path is still a give-up (summary fires)');
  assert.equal(out.result.ok, false, 'still honest: the failure is reported');
});

test('F3 regression (M2C-A NIT 3): fast-path retryable refusal sets gaveUp so the give-up summary fires', async () => {
  // IGS fully on + a retryable outcome (silent no-op) on the first attempt:
  // no retry, but the refusal must count as a give-up so the honest summary
  // toast fires exactly like on the off-window path.
  const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: silentNoop('powerLimitW') } }));
  const fullyOn = { service: { found: true, running: true, startType: 'auto' }, appRunning: true };
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { igsState: fullyOn, backoffs: [1], budgetMs: 60_000 },
  });
  assert.equal(backend.calls.length, 1, 'single attempt on the fully-on fast path');
  assert.equal(out.gaveUp, true);
  assert.equal(out.result.ok, false);
  const summary = applyGiveUpSummary(out);
  assert.notEqual(summary, null, 'the give-up summary toast text is produced');
  assert.match(summary, /refusing after 1 attempt/);
});

test('F3: IGS half-state / off / degraded probe -> retries enabled', async () => {
  const half = { service: { found: true, running: true, startType: 'auto' }, appRunning: false };
  const backend = stubBackend((n) => {
    if (n < 1) return { ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } };
    return { ok: true, perControl: { powerLimitW: okResult('powerLimitW') } };
  });
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { igsState: half, backoffs: [1], budgetMs: 60_000 },
  });
  assert.equal(out.attempts, 2, 'half-state retries');
  assert.equal(out.result.ok, true);
});

// ---------------------------------------------------------------------------
// Partial re-apply
// ---------------------------------------------------------------------------

test('F3: after one control lands, a retry re-sends ONLY the failed control', async () => {
  const sent = [];
  const backend = stubBackend((n, settings) => {
    sent.push({ ...settings });
    if (n === 0) {
      return {
        ok: false,
        perControl: {
          powerLimitW: okResult('powerLimitW'),
          gpuFreqOffsetMhz: ioFailed('gpuFreqOffsetMhz'),
        },
      };
    }
    return { ok: true, perControl: { gpuFreqOffsetMhz: okResult('gpuFreqOffsetMhz') } };
  });
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220, gpuFreqOffsetMhz: 100 },
    opts: { backoffs: [1], budgetMs: 60_000, igsState: null },
  });
  assert.deepEqual(Object.keys(sent[0]).sort(), ['gpuFreqOffsetMhz', 'powerLimitW']);
  assert.deepEqual(sent[1], { gpuFreqOffsetMhz: 100 }, 'only the failed control is re-sent');
  assert.equal(out.result.ok, true);
  assert.equal(out.result.perControl.powerLimitW.ok, true);
  assert.equal(out.result.perControl.gpuFreqOffsetMhz.ok, true);
});

test('F3: a hard-failed control is dropped from retries but keeps its honest result', async () => {
  const sent = [];
  const backend = stubBackend((n, settings) => {
    sent.push({ ...settings });
    if (n === 0) {
      return {
        ok: false,
        perControl: {
          tempLimitC: { ok: false, errorCode: 'out-of-range', message: '0x44000005' },
          powerLimitW: ioFailed('powerLimitW'),
        },
      };
    }
    return { ok: true, perControl: { powerLimitW: okResult('powerLimitW') } };
  });
  const out = await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220, tempLimitC: 92 },
    opts: { backoffs: [1], budgetMs: 60_000, igsState: null },
  });
  assert.deepEqual(sent[1], { powerLimitW: 220 }, 'the out-of-range control is never re-sent');
  assert.equal(out.result.ok, false, 'partial result stays honest');
  assert.equal(out.result.perControl.tempLimitC.errorCode, 'out-of-range');
  assert.equal(out.result.perControl.powerLimitW.ok, true);
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

test('F3: hard errors (out-of-range / waiver) are never retried', async () => {
  for (const code of ['out-of-range', 'waiver-not-set']) {
    const backend = stubBackend(() => ({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: code } } }));
    const out = await applyWithRetry({
      backend,
      deviceId: 0,
      settings: { powerLimitW: 220 },
      opts: { backoffs: [1], budgetMs: 60_000, igsState: null },
    });
    assert.equal(backend.calls.length, 1, `${code} is never retried`);
    assert.equal(out.retried, false);
    assert.equal(out.gaveUp, false);
    assert.equal(out.result.perControl.powerLimitW.errorCode, code);
  }
});

test('F3: onAttempt fires once per backend attempt with the raw per-attempt result (harness hook)', async () => {
  const backend = stubBackend((n) => {
    if (n < 2) return { ok: false, perControl: { powerLimitW: ioFailed('powerLimitW') } };
    return { ok: true, perControl: { powerLimitW: okResult('powerLimitW') } };
  });
  const attempts = [];
  await applyWithRetry({
    backend,
    deviceId: 0,
    settings: { powerLimitW: 220 },
    opts: { backoffs: [1, 1], budgetMs: 60_000, igsState: null },
    onAttempt: (n, result) => attempts.push({ n, ok: result.ok, code: result.perControl.powerLimitW.errorCode }),
  });
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.map((a) => a.n), [1, 2, 3]);
  assert.deepEqual(attempts.map((a) => a.code), ['io-failed', 'io-failed', undefined]);
  assert.deepEqual(attempts.map((a) => a.ok), [false, false, true]);
});
