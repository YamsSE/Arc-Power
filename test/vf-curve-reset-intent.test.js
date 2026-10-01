import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSettings } from '../src/main/ipc-core.js';
import { validateSettingsPayload } from '../src/renderer/pure/settings.ts';

const vfCurve = [
  { voltageV: 0.7, freqMhz: 1000 },
  { voltageV: 0.8, freqMhz: 2000 },
];

test('renderer accepts an explicit VF reset intent only with its curve payload', () => {
  assert.equal(validateSettingsPayload({ vfCurve, vfCurveResetToDefault: true }), true);
  assert.equal(validateSettingsPayload({ vfCurveResetToDefault: true }), false);
  assert.equal(validateSettingsPayload({ vfCurve, vfCurveResetToDefault: false }), false);
});

test('main IPC preserves only a true VF reset intent paired with a curve', () => {
  assert.deepEqual(sanitizeSettings({ vfCurve, vfCurveResetToDefault: true }), {
    vfCurve,
    vfCurveResetToDefault: true,
  });
  assert.throws(() => sanitizeSettings({ vfCurveResetToDefault: true }), /requires vfCurve/);
  assert.throws(() => sanitizeSettings({ vfCurve, vfCurveResetToDefault: false }), /must be true/);
});
