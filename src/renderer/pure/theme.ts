// Arc Power - 1.0.1 Themes: the canonical theme ids + validation.
//
// PURE and DOM-FREE (node-testable): this module must never touch
// `document` - the dataset write + the monitoring-canvas redraw live in
// app.ts / settings.ts (plan-review N8). Main-side mirrors of this list
// live in src/main/store/profile-store.js (THEMES - the persisted-truth
// owner) and src/main/ipc-core.js (the envelope validation); keep the three
// lists in lockstep.

export const THEMES = ['dark', 'midnight', 'light', 'red', 'yellow'] as const;

export type Theme = (typeof THEMES)[number];

/**
 * True when `value` is a legal theme id. Anything else (absent, garbage,
 * wrong case) is invalid - callers decide the fallback ('dark').
 */
export function isValidTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}
/**
 * Reconcile one serialized theme-save result with the live selection.
 *
 * Writes are serialized, so every successful request becomes the new
 * committed value in ProfileStore order. A failed request may roll back only
 * when its request generation is still the newest live selection. The
 * generation check is required when a later click selects the same theme.
 */
export function reconcileThemeSave(
  current: Theme,
  committed: Theme,
  requested: Theme,
  succeeded: boolean,
  requestGeneration: number,
  latestGeneration: number,
): { theme: Theme; committed: Theme } {
  if (succeeded) return { theme: current, committed: requested };
  return requestGeneration === latestGeneration
    ? { theme: committed, committed }
    : { theme: current, committed };
}
