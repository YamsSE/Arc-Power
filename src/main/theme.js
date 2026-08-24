// Shared main-process software theme contract.
// The renderer/store/IPC mirrors carry the canonical list independently;
// this module owns only first-paint backgrounds and defensive normalization.

export const THEME_BACKGROUNDS = Object.freeze({
  dark: '#0f1116',
  midnight: '#0b1020',
  light: '#f2f4f8',
  red: '#1a0d10',
  yellow: '#1a1608',
});

export const SOFTWARE_THEMES = Object.freeze(Object.keys(THEME_BACKGROUNDS));

export function normalizeTheme(value) {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(THEME_BACKGROUNDS, value)
    ? value
    : 'dark';
}

export function themeBackground(value) {
  return THEME_BACKGROUNDS[normalizeTheme(value)];
}
