import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettingsRouted } from '../src/main/apply-routing.js';

test('positive Alchemist voltage is blocked when stale Sysman cleanup cannot verify', async () => {
  let igclCalls = 0;
  const result = await applySettingsRouted({
    backend: {
      async applySettings() {
        igclCalls += 1;
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: true } } };
      },
      async getCurrentSettings() { return { gpuVoltOffsetV: -0.05 }; },
    },
    oldIgcl: null,
    deviceId: 0,
    settings: { gpuVoltOffsetV: 0.1 },
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async readVoltageOffsetResult() { return { ok: true, offsetV: -0.05 }; },
      async setVoltageOffset() { return { ok: false, errorCode: 'io-failed', message: 'helper refused clear' }; },
    },
    sleep: async () => {},
  });

  assert.equal(igclCalls, 0, 'IGCL must not receive a positive voltage while stale Sysman state is unknown');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.perControl.gpuVoltOffsetV.errorCode, 'io-failed');
});
