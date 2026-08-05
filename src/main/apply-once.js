// Arc Power — M2C-B F3 instant-apply core (electron-free), M2C-C revised.
//
// Replaces the M2C-A retry-with-verify apply-retry.js (user feedback
// 2026-08-05: retries never changed the off-window outcome on the live A770
// and the retry UI "looks very bad" — instant is the design). Evidence basis
// (docs/igcl-integration.md §8a + §8c):
//   - the real gate is ELEVATION, not IGS state: elevated writes persist for
//     every control with IGS fully on AND fully off; non-elevated writes
//     return SUCCESS with a momentary read-back match and then revert (the
//     "momentary lie" — the M2C-B harness "on-window 100%" was this lie);
//   - therefore refusals carry the PLAIN driver message + error code only —
//     the IGS-on requirement wording was based on the wrong root cause and
//     is REMOVED (M2C-C).
//
// Therefore: ONE attempt per control. Zero waiting, zero progress UI, no
// cancellation, no budgets, no backoff, no retry label. The silent-noop
// detection STAYS exactly as strong as it was (SUCCESS + read-back unchanged
// = per-control FAIL, NEVER "applied"). The elevation-aware delayed
// re-verification lives in the routing layer (apply-routing.js).

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
 * Controls whose writes are refused with the plain driver message. M2C-C:
 * the IGS-naming requirement is REMOVED (the real gate was elevation, not
 * IGS state — docs/igcl-integration.md §8c), so every refusal gets the same
 * plain message + error code.
 * @type {ReadonlySet<string>}
 */
export const IGS_REQUIRED_CONTROLS = new Set([]);

export const REFUSAL_PLAIN_MSG = 'The GPU driver refused the change.';
// M2C-C: the IGS-on requirement message is obsolete (wrong root cause —
// elevation is the gate). Kept as an exported constant only so the removal
// is greppable; product code never emits it.
export const REFUSAL_IGS_MSG = '';

/**
 * Compose the per-control failure message for a REFUSAL (instant, honest).
 * Returns null for ok/hard outcomes (hard errors keep the existing
 * errorMessage mapping in the renderer). The ok guard matches
 * classifyOutcome EXACTLY — a control is ok only when
 * `ok === true && readBackEqual !== false`, so a hypothetical silent no-op
 * flagged `ok:true, readBackEqual:false` is never reported applied.
 * Every refusal gets the plain driver message + error code (M2C-C).
 * @param {string} control
 * @param {{ ok: boolean, readBackEqual?: boolean, silentNoop?: boolean, errorCode?: string, message?: string } | undefined} per
 * @returns {string | null}
 */
export function refusalMessage(control, per) {
  if (!per || (per.ok === true && per.readBackEqual !== false)) return null;
  if (per.errorCode && HARD_ERROR_CODES.has(per.errorCode)) return null;
  return per.errorCode ? `${REFUSAL_PLAIN_MSG} (${per.errorCode})` : REFUSAL_PLAIN_MSG;
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
 * Apply `settings` exactly ONCE (instant): one backend call, zero waiting,
 * no retries, no budgets, no cancellation. The result is the backend's
 * honest per-control verdict; refusals (incl. the silent no-op — SUCCESS +
 * unchanged read-back, flagged silentNoop by the backend) get the plain
 * refusal message attached so the UI can toast it verbatim, and are NEVER
 * reported applied: a control classifies as ok only via the
 * classifyOutcome guard (ok === true && readBackEqual !== false), so even a
 * hypothetical `ok:true, readBackEqual:false` backend shape is forced to a
 * failing per-control result (real backends already emit ok:false).
 * (M2C-C: the elevation-aware delayed re-verification lives in
 * apply-routing.js — this core stays one-shot.)
 *
 * @param {{
 *   backend: import('./backend/backend.interface.js').IOCBackend,
 *   deviceId: number,
 *   settings: Record<string, unknown>,
 *   opts?: Record<string, unknown>,
 *   log?: (s: string) => void,
 * }} deps
 * @returns {Promise<{
 *   result: { ok: boolean, perControl: Record<string, { ok: boolean, errorCode?: string, message?: string, readBackEqual?: boolean, silentNoop?: boolean }> },
 *   attempts: number,
 *   elapsedMs: number,
 * }>}
 */
export async function applyOnce({ backend, deviceId, settings, opts = {}, log = () => {} }) {
  const started = Date.now();
  log(`[apply] single attempt for [${Object.keys(settings).join(', ')}]`);
  const attemptResult = await backend.applySettings(deviceId, settings);
  const perControl = { ...(attemptResult.perControl ?? {}) };
  for (const [key, per] of Object.entries(perControl)) {
    if (!per) continue;
    const msg = refusalMessage(key, per);
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
