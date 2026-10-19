import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MockBackend } from '../src/main/backend/mock-backend.js';
import {
  buildDisplaySettings,
  displayDriverValue,
  displaySettingValue,
  isDisplayControlDirty,
  isDisplayControlSupported,
  normalizeDisplaySettings,
  validateDisplaySettings,
} from '../src/renderer/pure/display.ts';

async function managedDisplay() {
  const featureset = JSON.parse(fs.readFileSync(new URL('../mock/featuresets/b580.json', import.meta.url), 'utf8'));
  const state = await new MockBackend({ featureset }).getDisplaySettings(0);
  const display = state.displays[0];
  const ranges = {
    hue: { min: -180, max: 180, step: 1, default: 0 },
    saturation: { min: 0, max: 2, step: 0.02, default: 1 },
    brightness: { min: -100, max: 100, step: 2, default: 0 },
    contrast: { min: 0, max: 2, step: 0.02, default: 1 },
  };
  display.supportedOptions.colorRanges = ranges;
  for (const [key, range] of Object.entries(ranges)) {
    display[key] = {
      ...display[key],
      value: null,
      desiredValue: range.default,
      lastSent: false,
      supported: true,
      controllable: true,
      source: 'igcl-managed-color',
      reason: 'IGCL does not expose a live getter; Arc Power manages this setting.',
    };
  }
  return display;
}

test('managed color desired values seed editors without being reported as native read-back', async () => {
  const display = await managedDisplay();

  assert.equal(display.hue.value, null);
  assert.equal(displayDriverValue(display, 'hue'), null);
  assert.equal(displaySettingValue(display, 'hue'), 0);
  assert.equal(isDisplayControlSupported(display, 'saturation'), true);
  const normalized = normalizeDisplaySettings(display);
  assert.deepEqual(Object.fromEntries(['hue', 'saturation', 'brightness', 'contrast'].map((key) => [key, normalized[key]])), {
    hue: 0, saturation: 1, brightness: 0, contrast: 1,
  });
});

test('managed color drafts compare against Arc Power intent across refreshes', async () => {
  const display = await managedDisplay();
  const draft = normalizeDisplaySettings(display);
  const applied = { ...draft };

  assert.equal(isDisplayControlDirty('hue', draft, display), false);
  assert.deepEqual(buildDisplaySettings(draft, display, applied), {});

  draft.saturation = 1.4;
  assert.equal(isDisplayControlDirty('saturation', draft, display), true);
  assert.deepEqual(buildDisplaySettings(draft, display, applied), { saturation: 1.4 });
  assert.equal(display.hue.value, null);
});

test('replaceExistingColorSettings accepts only an explicit boolean and is not an editable control', async () => {
  const display = await managedDisplay();

  assert.equal(validateDisplaySettings({ hue: 5, replaceExistingColorSettings: true }, display), true);
  assert.equal(validateDisplaySettings({ hue: 5, replaceExistingColorSettings: false }, display), true);
  assert.equal(validateDisplaySettings({ hue: 5, replaceExistingColorSettings: 'yes' }, display), false);
  assert.deepEqual(buildDisplaySettings({ hue: 5, replaceExistingColorSettings: true }, display, {}), { hue: 5 });
});
