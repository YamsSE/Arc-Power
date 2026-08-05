// Arc Power — M2C-A F3 retry-with-verify apply core (electron-free).
//
// The shared apply policy for UI Apply, tray apply, and apply-on-startup
// (docs/igcl-integration.md §8a + plan.md M2C-A F3). Evidence basis:
//   - IGS fully ON  = 100% apply success -> single attempt, no delay;
//   - IGS OFF / half-states: PL/PT writes can SILENTLY NO-OP (SUCCESS
//     returned, read-back unchanged) and the acceptance state machine flaps
//     on a minutes scale — so the apply path must be patient (retry with
//     backoff) and HONEST (never report "applied" for a silent no-op).
//
// Outcome classification per control (see classifyControl):
//   ok        — set + read-back matched. Done.
//   hard      — instant, honest failure, NO retry: OUTSIDE_RANGE family
//               (out-of-range / locked-mode / reset-required), waiver-not-set,
//               invalid-argument, unsupported-feature, unavailable-symbol.
//   retryable — transient driver refusals while the OC state machine settles:
//               io-failed (incl. NOT_AVAILABLE 0x40000007) and CRITICALLY the
//               SILENT NO-OP (SUCCESS + unchanged read-back — the backend
//               flags it with silentNoop: true).
//
// Retry schedule: backoff 1s, 2s, 4s, 8s, 12s, 12s, ... bounded by a total
// budget (60 s default, 20 s for apply-on-startup). Every retried attempt
// re-sends ONLY the failed controls (partial applies are never re-sent
// wholesale once some controls have landed) and re-verifies each by
// read-back.

/**
 * Hard (never-retried) canonical error codes. Everything else — including
 * the unmapped/io-failed class that carries NOT_AVAILABLE — is retryable.
 * @type {ReadonlySet<string>}
 */
export const HARD_ERROR_CODES = new Set([
  'waiver-not-set',
  'out-of-range',
  'locked-mode',
  'reset-required',
  'invalid-argument',
  'unsupported',
  'unavailable-symbol',
]);

export const APPLY_BUDGET_MS = 60_000;
export const APPLY_BUDGET_MS_BOOT = 20_000;
export const APPLY_BACKOFF_MS = [1000, 2000, 4000, 8000, 12_000];
// Progress surface cap: "retry N/9" — initial attempt + 8 retries covers the
// default 60 s budget (1+2+4+8+12+12+12+12 = 63 s > 60 s, so at most 8
// retries fit before the budget check cuts the 9th sleep).
export const APPLY_MAX_RETRIES = 9;

/**
 * Classify one per-control result.
 * @param {{ ok: boolean, readBackEqual?: boolean, silentNoop?: boolean, errorCode?: string } | undefined} per
 * @returns {'ok'|'hard'|'retryable'}
 */
export function classifyControl(per) {
  if (!per) return 'hard';
  if (per.ok === true && per.readBackEqual !== false) return 'ok';
  if (per.silentNoop === true) return 'retryable';
  if (per.errorCode && HARD_ERROR_CODES.has(per.errorCode)) return 'hard';
  return 'retryable';
}

/**
 * True when an ApplyResult contains at least one retryable control.
 * @param {{ ok: boolean, perControl: Record<string, { ok: boolean, readBackEqual?: boolean, silentNoop?: boolean, errorCode?: string }> }} result
 */
export function hasRetryable(result) {
  return result.ok === false
    && Object.values(result.perControl ?? {}).some((p) => classifyControl(p) === 'retryable');
}

/**
 * IGS fast path predicate (plan F3): when the IGS service + app are fully
 * ON, applies succeed on the first attempt (100% proven) — single attempt,
 * no retries. Any other state (off, half-states, degraded probe) retries.
 * @param {{ service: { running: boolean }, appRunning: boolean } | null} state
 */
export function isIgsFullyOn(state) {
  return state?.service?.running === true && state?.appRunning === true;
}

/**
 * Backoff delay before the attempt AFTER `attemptsDone` completed attempts.
 * @param {number} attemptsDone 1-based count of completed attempts
 * @param {number[]} [backoffs]
 */
export function backoffDelayMs(attemptsDone, backoffs = APPLY_BACKOFF_MS) {
  if (attemptsDone < 1) return 0;
  return backoffs[Math.min(attemptsDone, backoffs.length) - 1] ?? backoffs[backoffs.length - 1] ?? 0;
}

/**
 * Cancellable token for apply abort semantics. A fresh token per apply run;
 * abort() stops further attempts (and wakes the backoff sleep).
 */
export class ApplyToken {
  constructor() {
    this.aborted = false;
    this._listeners = new Set();
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    for (const fn of this._listeners) { try { fn(); } catch { /* never throw from a listener */ } }
  }

  onAbort(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
}

/**
 * Sleep that resolves true after `ms` — or immediately with false when the
 * token aborts during the wait.
 * @param {number} ms
 * @param {ApplyToken|null} token
 * @returns {Promise<boolean>}
 */
export function cancellableSleep(ms, token = null) {
  return new Promise((resolve) => {
    if (token?.aborted) return resolve(false);
    const unsub = token ? token.onAbort(() => { clearTimeout(timer); resolve(false); }) : null;
    const timer = setTimeout(() => { unsub?.(); resolve(true); }, ms);
  });
}

/**
 * Apply `settings` with retry-with-verify. Retries ONLY the retryable
 * controls (partial re-apply), respects the IGS fast path, honors the budget
 * and the abort token, and reports the honest partial state on give-up.
 *
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   deviceId: number,
 *   settings: Record<string, unknown>,
 *   opts?: {
 *     budgetMs?: number,
 *     igsState?: { service: { running: boolean }, appRunning: boolean } | null,
 *     backoffs?: number[],
 *   },
 *   signal?: ApplyToken | null,
 *   onProgress?: (p: { attempt: number, retryOf: number, controls: string[], elapsedMs: number }) => void,
 *   onAttempt?: (attempt: number, result: { ok: boolean, perControl: Record<string, unknown> }) => void,
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<{
 *   result: { ok: boolean, perControl: Record<string, { ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean, silentNoop?: boolean }> },
 *   attempts: number,
 *   retried: boolean,
 *   gaveUp: boolean,
 *   cancelled: boolean,
 *   elapsedMs: number,
 * }>}
 */
export async function applyWithRetry({ backend, deviceId, settings, opts = {}, signal = null, onProgress = () => {}, onAttempt = () => {}, log = () => {} }) {
  const {
    budgetMs = APPLY_BUDGET_MS,
    igsState = null,
    backoffs = APPLY_BACKOFF_MS,
  } = opts;

  const fastPath = isIgsFullyOn(igsState);
  const started = Date.now();
  let pending = { ...settings };
  const perControl = {};
  let attempts = 0;
  let retried = false;
  let gaveUp = false;
  let cancelled = false;

  while (true) {
    if (signal?.aborted) { cancelled = true; break; }

    const attemptResult = await backend.applySettings(deviceId, pending);
    attempts += 1;
    if (attempts > 1) retried = true;
    // Per-attempt hook (acceptance harness): records each attempt's full
    // detail (codes, read-backs) without the policy loop duplicating.
    onAttempt(attempts, attemptResult);
    for (const [key, per] of Object.entries(attemptResult.perControl ?? {})) {
      perControl[key] = per;
    }

    // Partition the still-pending controls: ok/hard leave the retry set
    // (their final result is kept); retryable ones are re-sent next round.
    const retryKeys = [];
    for (const key of Object.keys(pending)) {
      if (classifyControl(perControl[key]) === 'retryable') retryKeys.push(key);
    }

    if (retryKeys.length === 0) break;              // everything landed or failed hard
    // IGS fully on: single attempt only (defensive — on-window is 100%).
    // A retryable refusal here is still a refusal, so mark the give-up to
    // keep the summary toast consistent with the off-window path.
    if (fastPath) { gaveUp = true; break; }
    if (signal?.aborted) { cancelled = true; break; }

    const elapsedMs = Date.now() - started;
    const delay = backoffDelayMs(attempts, backoffs);
    if (elapsedMs + delay > budgetMs) { gaveUp = true; break; }

    onProgress({ attempt: attempts, retryOf: APPLY_MAX_RETRIES, controls: retryKeys, elapsedMs });
    log(`[apply] attempt ${attempts + 1} for [${retryKeys.join(', ')}] after ${delay} ms (budget ${budgetMs} ms)`);
    if (!(await cancellableSleep(delay, signal))) { cancelled = true; break; }

    // Partial re-apply: only the failed controls, never the whole set.
    const next = {};
    for (const key of retryKeys) next[key] = pending[key];
    pending = next;
  }

  const ok = Object.values(perControl).length === 0
    ? true
    : Object.values(perControl).every((p) => p.ok === true);
  const result = { ok, perControl };

  // Attach the standard retried flag (renderer shouldShowRetryNote) plus the
  // F3 honesty metadata (attempts / gaveUp / cancelled) in one envelope.
  const meta = { retried, attempts, gaveUp, cancelled, elapsedMs: Date.now() - started };
  return { result: { ...result, ...meta }, ...meta };
}
