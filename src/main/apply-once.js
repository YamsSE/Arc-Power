// Arc Power — M2C-B F3 instant-apply core (electron-free).
//
// Replaces the M2C-A retry-with-verify apply-retry.js (user feedback
// 2026-08-05: retries never changed the off-window outcome on the live A770
// and the retry UI "looks very bad" — instant is the design). Evidence basis
// (docs/igcl-integration.md §8a + tools/validate/m2c-acceptance.js):
//   - IGS fully ON  = 100% success on the FIRST attempt;
//   - IGS OFF: power/temp writes can SILENTLY NO-OP (SUCCESS returned,
//     read-back unchanged); retries never changed that (0/3 with retries);
//   - >252 W is hard-refused everywhere.
//
// Therefore: ONE attempt per control. Zero waiting, zero progress UI, no
// cancellation, no budgets, no backoff, no retry label. The silent-noop
// detection STAYS exactly as strong as it was (SUCCESS + read-back unchanged
// = per-control FAIL, NEVER "applied"). Refusals fail instantly with an
// ACTIONABLE message composed against the live IGS state:
//   - powerLimit/freq refusals (and silent no-ops on those controls) with
//     IGS not fully on name the IGS-on requirement;
//   - every other refusal gets the plain driver message;
//   - with IGS fully on (a refusal there is rare), plain message + code.

/**
 * Hard (never-retried, not-a-refusal) canonical error codes. These keep
 * their existing user-facing messages (errorMessage in pure/errors.ts);
 * everything else that fails is a refusal (instant, actionable message).
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

/**
 * Controls whose writes need Intel Graphics Software running (verified on
 * the A770: power/freq writes are refused or silently no-op'd while IGS is
 * not fully on; voltage/temp writes are not gated the same way).
 * @type {ReadonlySet<string>}
 */
export const IGS_REQUIRED_CONTROLS = new Set(['powerLimitW', 'gpuFreqOffsetMhz', 'vramFreqOffsetGts']);

export const REFUSAL_PLAIN_MSG = 'The GPU driver refused the change.';
export const REFUSAL_IGS_MSG =
  'The GPU driver refused the change - power and frequency writes need Intel Graphics Software running. Start IGS and apply again.';

/**
 * IGS fast path predicate (plan F3): when the IGS service + app are fully
 * ON, applies succeed on the first attempt (100% proven). Used for refusal
 * message composition — with IGS fully on, a refusal is plain + code.
 * @param {{ service: { running: boolean }, appRunning: boolean } | null} state
 */
export function isIgsFullyOn(state) {
  return state?.service?.running === true && state?.appRunning === true;
}

/**
 * Classify one per-control result for the instant policy.
 * @param {{ ok: boolean, readBackEqual?: boolean, silentNoop?: boolean, errorCode?: string } | undefined} per
 * @returns {'ok'|'hard'|'refusal'}
 */
export function classifyOutcome(per) {
  if (!per) return 'hard';
  if (per.ok === true && per.readBackEqual !== false) return 'ok';
  if (per.errorCode && HARD_ERROR_CODES.has(per.errorCode)) return 'hard';
  return 'refusal';
}

/**
 * Compose the per-control failure message for a REFUSAL (instant, actionable
 * — the F3 revision's honest message layer). Returns null for ok/hard
 * outcomes (hard errors keep the existing errorMessage mapping in the
 * renderer). The ok guard matches classifyOutcome EXACTLY — a control is ok
 * only when `ok === true && readBackEqual !== false`, so a hypothetical
 * silent no-op flagged `ok:true, readBackEqual:false` is never reported
 * applied (it gets a composed refusal message like any other refusal):
 *   - powerLimit/freq refusal or silent no-op + IGS NOT fully on
 *     -> the IGS-on requirement message;
 *   - any refusal with IGS fully on (rare) -> plain message + error code;
 *   - voltage/temp/other refusals -> plain driver message.
 * @param {string} control
 * @param {{ ok: boolean, readBackEqual?: boolean, silentNoop?: boolean, errorCode?: string, message?: string } | undefined} per
 * @param {{ service: { running: boolean }, appRunning: boolean } | null} igsState
 * @returns {string | null}
 */
export function refusalMessage(control, per, igsState) {
  if (!per || (per.ok === true && per.readBackEqual !== false)) return null;
  if (per.errorCode && HARD_ERROR_CODES.has(per.errorCode)) return null;
  if (isIgsFullyOn(igsState)) {
    return per.errorCode ? `${REFUSAL_PLAIN_MSG} (${per.errorCode})` : REFUSAL_PLAIN_MSG;
  }
  if (IGS_REQUIRED_CONTROLS.has(control)) return REFUSAL_IGS_MSG;
  return REFUSAL_PLAIN_MSG;
}

/**
 * Apply `settings` exactly ONCE (instant): one backend call, zero waiting,
 * no retries, no budgets, no cancellation. The result is the backend's
 * honest per-control verdict; refusals (incl. the silent no-op — SUCCESS +
 * unchanged read-back, flagged silentNoop by the backend) get the composed
 * refusal message attached so the UI can toast it verbatim, and are NEVER
 * reported applied: a control classifies as ok only via the
 * classifyOutcome guard (ok === true && readBackEqual !== false), so even a
 * hypothetical `ok:true, readBackEqual:false` backend shape is forced to a
 * failing per-control result (real backends already emit ok:false).
 *
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   deviceId: number,
 *   settings: Record<string, unknown>,
 *   opts?: { igsState?: { service: { running: boolean }, appRunning: boolean } | null },
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<{
 *   result: { ok: boolean, perControl: Record<string, { ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean, silentNoop?: boolean }> },
 *   attempts: number,
 *   elapsedMs: number,
 * }>}
 */
export async function applyOnce({ backend, deviceId, settings, opts = {}, log = () => {} }) {
  const { igsState = null } = opts;
  const started = Date.now();
  log(`[apply] single attempt for [${Object.keys(settings).join(', ')}]`);
  const attemptResult = await backend.applySettings(deviceId, settings);
  const perControl = { ...(attemptResult.perControl ?? {}) };
  for (const [key, per] of Object.entries(perControl)) {
    if (!per) continue;
    const msg = refusalMessage(key, per, igsState);
    if (msg !== null) {
      // Refusals get the composed actionable message (overwrites any
      // backend diagnostic text — the user-facing wording wins) and are
      // never reported applied (ok forced false; a no-op for real backends,
      // which already emit ok:false for refusals).
      perControl[key] = { ...per, message: msg, ok: false };
    } else if (per.message !== undefined) {
      // ok/hard outcomes carry no user-facing message here — the renderer
      // maps hard errors via errorMessage (the backend text is diagnostic).
      const clean = { ...per };
      delete clean.message;
      perControl[key] = clean;
    }
  }
  const ok = Object.keys(perControl).length === 0
    ? true
    : Object.values(perControl).every((p) => p.ok === true);
  return { result: { ok, perControl }, attempts: 1, elapsedMs: Date.now() - started };
}
