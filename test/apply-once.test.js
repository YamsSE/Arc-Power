import test from 'node:test';
import assert from 'node:assert/strict';
import { applyOnce, classifyOutcome } from '../src/main/apply-once.js';

test('VF curve refusals preserve the driver diagnostic for the tuning UI', async () => {
  const diagnostic = 'IGCL ERROR_KMD_CALL (0x0000000f)';
  const backend = {
    async applySettings() {
      return {
        ok: false,
        perControl: {
          vfCurve: { ok: false, errorCode: 'io-failed', message: diagnostic },
        },
      };
    },
  };

  const out = await applyOnce({ backend, deviceId: 0, settings: { vfCurve: [] } });
  assert.equal(out.result.perControl.vfCurve.ok, false);
  assert.equal(out.result.perControl.vfCurve.errorCode, 'io-failed');
  assert.equal(out.result.perControl.vfCurve.message, diagnostic);
});

test('other control refusals keep the established generic wording', async () => {
  const backend = {
    async applySettings() {
      return {
        ok: false,
        perControl: {
          gpuFreqOffsetMhz: { ok: false, errorCode: 'io-failed', message: 'native detail' },
        },
      };
    },
  };

  const out = await applyOnce({ backend, deviceId: 0, settings: { gpuFreqOffsetMhz: 100 } });
  assert.equal(out.result.perControl.gpuFreqOffsetMhz.message, 'The GPU driver refused the change. (io-failed)');
});

test('verified driver-normalized VF curves count as applied and retain the actual read-back', async () => {
  const message = 'The driver normalized the requested VF values; the changed LIVE curve is active.';
  const readBackCurve = [{ voltageV: 0.58, freqMhz: 1640 }];
  const backend = {
    async applySettings() {
      return {
        ok: true,
        perControl: {
          vfCurve: { ok: true, readBackEqual: false, normalized: true, message, readBackCurve },
        },
      };
    },
  };

  const out = await applyOnce({ backend, deviceId: 0, settings: { vfCurve: readBackCurve } });
  assert.equal(out.result.ok, true);
  assert.equal(out.result.perControl.vfCurve.ok, true);
  assert.equal(out.result.perControl.vfCurve.readBackEqual, false);
  assert.equal(out.result.perControl.vfCurve.normalized, true);
  assert.equal(out.result.perControl.vfCurve.message, message);
  assert.deepEqual(out.result.perControl.vfCurve.readBackCurve, readBackCurve);
  assert.equal(classifyOutcome({ ok: true, readBackEqual: false }), 'refusal');
});

test('unverified VF driver adjustment stays failed and retains the live curve and explanation', async () => {
  const message = 'The driver returned a different LIVE VF curve, but the before-image could not be verified.';
  const readBackCurve = [{ voltageV: 0.58, freqMhz: 1640 }];
  const backend = {
    async applySettings() {
      return {
        ok: false,
        perControl: {
          vfCurve: {
            ok: false,
            errorCode: 'io-failed',
            driverAdjusted: true,
            message,
            readBackCurve,
          },
        },
      };
    },
  };

  const out = await applyOnce({ backend, deviceId: 0, settings: { vfCurve: readBackCurve } });
  assert.equal(out.result.ok, false);
  assert.equal(out.result.perControl.vfCurve.ok, false);
  assert.equal(out.result.perControl.vfCurve.errorCode, 'io-failed');
  assert.equal(out.result.perControl.vfCurve.driverAdjusted, true);
  assert.equal(out.result.perControl.vfCurve.message, message);
  assert.deepEqual(out.result.perControl.vfCurve.readBackCurve, readBackCurve);
});
