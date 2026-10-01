// Arc Power - M2C-B F3 instant-apply core (electron-free), M2C-C revised.
//
// Replaces the M2C-A retry-with-verify apply-retry.js (feedback
// 2026-08-05: retries never changed the off-window outcome on the live A770
// and the retry UI "looks very bad" - instant is the design). Evidence basis
// (docs/igcl-integration.md §8a + §8c):
//   - the real gate is ELEVATION, not IGS state: elevated writes persist for
//     every control with IGS fully on AND fully off; non-elevated writes
//     return SUCCESS with a momentary read-back match and then revert (the
//     "momentary lie" - the M2C-B harness "on-window 100%" was this lie);
//   - therefore refusals carry the PLAIN driver message + error code only -
//     the IGS-on requirement wording was based on the wrong root cause and
//     is REMOVED (M2C-C).
//
// Therefore: ONE backend call per apply. This orchestration layer adds no
// retries, cancellation, progress UI, or retry label. Backend-specific write
// policy stays in the backend, which may use bounded read-only polling to
// verify that a successful write reached the live state. Silent-noop
// detection stays fail-closed (SUCCESS + unchanged read-back = FAIL, never
// "applied"). Elevation-aware delayed re-verification lives in
// apply-routing.js.

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
  'driver-adjustment-out-of-range',
  'driver-noop',
]);

/**
 * Controls whose writes are refused with the plain driver message. M2C-C:
 * the IGS-naming requirement is REMOVED (the real gate was elevation, not
 * IGS state - docs/igcl-integration.md §8c), so every refusal gets the same
 * plain message + error code.
 * @type {ReadonlySet<string>}
 */
export const IGS_REQUIRED_CONTROLS = new Set([]);

export const REFUSAL_PLAIN_MSG = 'The GPU driver refused the change.';
// M2C-C: the IGS-on requirement message is obsolete (wrong root cause -
// elevation is the gate). Kept as an exported constant only so the removal
// is greppable; product code never emits it.
export const REFUSAL_IGS_MSG = '';

function isVerifiedSuccess(per) {
  return per?.ok === true && (per.readBackEqual !== false || per.normalized === true);
}

/**
 * Compose the per-control failure message for a REFUSAL (instant, honest).
 * Returns null for ok/hard outcomes (hard errors keep the existing
 * errorMessage mapping in the renderer). The ok guard matches
 * classifyOutcome EXACTLY - a control is ok only when
 * an exact read-back or an explicitly verified driver normalization, so a
 * hypothetical silent no-op flagged `ok:true, readBackEqual:false` is never
 * reported applied.
 * Every refusal gets the plain driver message + error code (M2C-C).
 * @param {string} control
 * @param {{ ok: boolean, readBackEqual?: boolean, normalized?: boolean, silentNoop?: boolean, errorCode?: string, message?: string } | undefined} per
 * @returns {string | null}
 */
export function refusalMessage(control, per) {
  if (!per || isVerifiedSuccess(per)) return null;
  // VF curve failures carry actionable native/read-back diagnostics (for
  // example the exact IGCL refusal or the point that failed verification).
  // Keep those for the tuning UI instead of replacing them with the generic
  // refusal text, which made distinct B-series failures look identical.
  if (control === 'vfCurve' && typeof per.message === 'string' && per.message.trim().length > 0) {
    return per.message;
  }
  if (per.errorCode && HARD_ERROR_CODES.has(per.errorCode)) return null;
  return per.errorCode ? `${REFUSAL_PLAIN_MSG} (${per.errorCode})` : REFUSAL_PLAIN_MSG;
}

/**
 * Classify one per-control result for the instant policy.
 * @param {{ ok: boolean, readBackEqual?: boolean, normalized?: boolean, silentNoop?: boolean, errorCode?: string } | undefined} per
 * @returns {'ok'|'hard'|'refusal'}
 */
export function classifyOutcome(per) {
  if (!per) return 'hard';
  if (isVerifiedSuccess(per)) return 'ok';
  if (per.errorCode && HARD_ERROR_CODES.has(per.errorCode)) return 'hard';
  return 'refusal';
}

/**
 * Apply `settings` with exactly one backend call and no wrapper-level retry.
 * The backend owns any bounded write/readback policy. The result is the backend's
 * honest per-control verdict; refusals (incl. the silent no-op - SUCCESS +
 * unchanged read-back, flagged silentNoop by the backend) get the plain
 * refusal message attached so the UI can toast it verbatim, and are NEVER
 * reported applied: a control classifies as ok only via exact verification
 * or an explicit normalized success, so an unexplained
 * `ok:true, readBackEqual:false` backend shape is still forced to failure.
 * (M2C-C: the elevation-aware delayed re-verification lives in
 * apply-routing.js - this core stays one-shot.)
 *
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   deviceId: number,
 *   settings: Record<string, unknown>,
 *   opts?: Record<string, unknown>,
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<{
 *   result: { ok: boolean, perControl: Record<string, { ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean, normalized?: boolean, readBackCurve?: Array<{ voltageV: number, freqMhz: number }>, silentNoop?: boolean }> },
 *   attempts: number,
 *   elapsedMs: number,
 * }>}
 */
export async function applyOnce({ backend, deviceId, settings, opts = {}, log = () => {} }) {
  const started = Date.now();
  log(`[apply] single attempt for [${Object.keys(settings).join(', ')}]`);
  const attemptResult = await backend.applySettings(deviceId, settings, opts);
  const perControl = { ...(attemptResult.perControl ?? {}) };
  for (const [key, per] of Object.entries(perControl)) {
    if (!per) continue;
    const msg = refusalMessage(key, per);
    if (msg !== null) {
      // Refusals get the composed actionable message (overwrites any
      // backend diagnostic text - the user-facing wording wins) and are
      // never reported applied (ok forced false; a no-op for real backends,
      // which already emit ok:false for refusals).
      perControl[key] = { ...per, message: msg, ok: false };
    } else if (per.message !== undefined && per.normalized !== true) {
      // ok/hard outcomes carry no user-facing message here - the renderer
      // maps hard errors via errorMessage (the backend text is diagnostic),
      // except a curve mismatch where the returned driver curve matters.
      const clean = { ...per };
      delete clean.message;
      perControl[key] = clean;
    }
  }
  const ok = Object.keys(perControl).length === 0
    ? true
    : Object.values(perControl).every(isVerifiedSuccess);
  return { result: { ok, perControl }, attempts: 1, elapsedMs: Date.now() - started };
}
