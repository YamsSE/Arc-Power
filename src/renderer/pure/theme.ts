// Arc Power - 1.0.1 Themes: the canonical theme ids + validation.
//
// PURE and DOM-FREE (node-testable): this module must never touch
// `document` - the dataset write + the monitoring-canvas redraw live in
// app.ts / settings.ts (plan-review N8). Main-side mirrors of this list
// live in src/main/store/profile-store.js (THEMES - the persisted-truth
// owner) and src/main/ipc-core.js (the envelope validation); keep the three
// lists in lockstep.

export const THEMES = ['dark', 'midnight', 'light'] as const;

export type Theme = (typeof THEMES)[number];

/**
 * True when `value` is a legal theme id. Anything else (absent, garbage,
 * wrong case) is invalid - callers decide the fallback ('dark').
 */
export function isValidTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value);
}
