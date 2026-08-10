// Arc Power - M9 the per-card chip state machine (pure, DOM-free,
// unit-tested): the shared Tuning + Graphics chip semantics.
//
// Each card's status element (`<span class="chip oc-chip-status" hidden>`)
// plus the NEW per-card Apply button (`.oc-chip-apply`) derive from ONE
// pure state per control:
//   - 'none'    - unsupported (supported === false) OR the control was
//                 never applied in this render AND the draft equals the
//                 loaded driver value - INVISIBLE (the hidden attribute;
//                 the CSS [hidden] fix makes it truly invisible);
//   - 'applied' - the control was applied AND the draft equals the last
//                 applied value - the green "Applied" chip;
//   - 'dirty'   - every other case (a changed setting, before OR after an
//                 apply) - the "Apply" button.
//
// The old "Unapplied" warn chip is GONE - a changed setting shows the
// per-card Apply button instead. The floating Apply button (both pages)
// is untouched (applies everything).

export type ChipState = 'none' | 'applied' | 'dirty';

/** Structural equality for the composite values (graphics frameLimit). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const ka = Object.keys(a as Record<string, unknown>);
    const kb = Object.keys(b as Record<string, unknown>);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
    }
    return true;
  }
  return false;
}

/**
 * The per-control chip state (M9):
 * - 'none' when `supported === false` OR (`key` never applied AND the
 *   draft equals the loaded driver value) - INVISIBLE;
 * - 'applied' when `key` was applied AND the draft equals the last
 *   applied - the green "Applied" chip;
 * - 'dirty' in every other case (a changed setting, before OR after an
 *   apply) - the "Apply" button.
 */
export function chipState(
  key: string,
  draft: Record<string, unknown>,
  applied: Record<string, unknown>,
  driverValue: unknown,
  supported: boolean,
): ChipState {
  if (supported === false) return 'none';
  if (key in applied) {
    return sameValue(draft[key], applied[key]) ? 'applied' : 'dirty';
  }
  return sameValue(draft[key], driverValue) ? 'none' : 'dirty';
}
