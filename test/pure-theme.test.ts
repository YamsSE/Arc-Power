// 1.0.1 — the pure theme helpers (DOM-free by design — plan-review N8: the
// dataset write lives in app.ts/settings.ts, never here; node-testable).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEMES, isValidTheme } from '../src/renderer/pure/theme.ts';

test('THEMES: dark is the first (default) entry; the three theme ids are canonical', () => {
  assert.deepEqual(THEMES, ['dark', 'midnight', 'light']);
  assert.equal(THEMES[0], 'dark', 'dark must stay the default (absent-field fallback)');
});

test('isValidTheme: accepts exactly the three canonical ids', () => {
  for (const t of THEMES) assert.equal(isValidTheme(t), true, `'${t}' must be valid`);
});

test('isValidTheme: rejects everything else (garbage, wrong case, non-strings)', () => {
  for (const bad of [undefined, null, '', 'Dark', 'DARK', 'dark ', 'midnights', 'blue', 'light-theme', 3, 0, {}, [], true, { theme: 'light' }]) {
    assert.equal(isValidTheme(bad), false, `${JSON.stringify(bad)} must be invalid`);
  }
});
