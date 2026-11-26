// Arc Power UI preferences (density + scale). These are display-only and live
// with the other renderer-local UI state (hidden tabs) instead of the native
// settings store, so a profile import/export never carries them.

export type UiDensity = 'comfortable' | 'compact';

export const UI_SCALES = [0.9, 1, 1.1, 1.25] as const;

export interface UiPreferences {
  density: UiDensity;
  scale: number;
}

export const UI_PREFERENCES_KEY = 'arcpower.ui.preferences.v1';

export const DEFAULT_UI_PREFERENCES: UiPreferences = { density: 'comfortable', scale: 1 };

export function normalizeUiScale(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return UI_SCALES.find((scale) => Math.abs(scale - numeric) < 0.001) ?? 1;
}

export function normalizeUiPreferences(raw: unknown): UiPreferences {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    density: value.density === 'compact' ? 'compact' : 'comfortable',
    scale: normalizeUiScale(value.scale),
  };
}

export function readUiPreferences(storage: Storage = localStorage): UiPreferences {
  try {
    return normalizeUiPreferences(JSON.parse(storage.getItem(UI_PREFERENCES_KEY) ?? 'null'));
  } catch {
    return DEFAULT_UI_PREFERENCES;
  }
}

export function writeUiPreferences(preferences: UiPreferences, storage: Storage = localStorage): void {
  try {
    storage.setItem(UI_PREFERENCES_KEY, JSON.stringify(normalizeUiPreferences(preferences)));
  } catch {
    // Storage is best effort; the in-memory apply still happens.
  }
}

/** Apply through data attributes (CSP-safe: no inline style writes). */
export function applyUiPreferences(preferences: UiPreferences, root: HTMLElement = document.documentElement): void {
  const normalized = normalizeUiPreferences(preferences);
  root.dataset.density = normalized.density;
  if (normalized.scale === 1) {
    delete root.dataset.scale;
  } else {
    root.dataset.scale = String(normalized.scale);
  }
}

export function uiScaleLabel(scale: number): string {
  return `${Math.round(normalizeUiScale(scale) * 100)}%`;
}
