import test from 'node:test';
import assert from 'node:assert/strict';
import { profileSettingsMatchCurrentState, reconcileAppliedProfileResult, shouldRetryStartupApply } from '../src/main/apply-on-boot.js';

test('startup does not fast-path a matching power limit while Sysman PL2 is available', () => {
  const settings = { powerLimitW: 300, tempLimitC: 90 };
  const state = { powerLimitW: 300, tempLimitC: 90 };
  assert.equal(profileSettingsMatchCurrentState(settings, state, {
    setLimits: async () => ({ ok: true }),
  }), false);
  assert.equal(profileSettingsMatchCurrentState(settings, state, null), true);
});

test('startup apply retries only transient driver failures', () => {
  assert.equal(shouldRetryStartupApply({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'busy' } } }), true);
  assert.equal(shouldRetryStartupApply({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', message: 'KMD is temporarily not ready' } } }), true);
  assert.equal(shouldRetryStartupApply({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'unsupported' } } }), false);
  assert.equal(shouldRetryStartupApply({ ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed', message: 'access denied' } } }), false);
});

test('startup apply reconciles a live-state-confirmed read-back mismatch', () => {
  const result = reconcileAppliedProfileResult(
    {
      ok: false,
      perControl: {
        gpuVoltOffsetV: { ok: false, errorCode: 'io-failed', message: 'read-back mismatch' },
        tempLimitC: { ok: true, readBackEqual: true },
      },
    },
    { gpuVoltOffsetV: -0.028, tempLimitC: 90 },
    { gpuVoltOffsetV: -0.028, tempLimitC: 90 },
  );
  assert.equal(result.ok, true);
  assert.equal(result.reconciledFromLiveState, true);
  assert.equal(result.perControl.gpuVoltOffsetV.reconciledFromLiveState, true);
});

test('startup apply never reconciles an explicit refusal', () => {
  const result = reconcileAppliedProfileResult(
    { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'unsupported' } } },
    { powerLimitW: 200 },
    { powerLimitW: 200 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reconciledFromLiveState, undefined);
});

test('startup apply never reconciles a Sysman voltage failure from IGCL state', () => {
  const result = reconcileAppliedProfileResult(
    {
      ok: false,
      perControl: {
        gpuVoltOffsetV: { ok: false, errorCode: 'io-failed', message: 'Sysman clear failed' },
      },
    },
    { gpuVoltOffsetV: 0 },
    { gpuVoltOffsetV: 0 },
    { sysmanPowerLimits: { setVoltageOffset: async () => ({ ok: false }) } },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reconciledFromLiveState, undefined);
});

test('startup apply never reconciles an incomplete per-control result', () => {
  const result = reconcileAppliedProfileResult(
    { ok: false, perControl: { powerLimitW: { ok: false, errorCode: 'io-failed' } } },
    { powerLimitW: 200, tempLimitC: 90 },
    { powerLimitW: 200, tempLimitC: 90 },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reconciledFromLiveState, undefined);
});
