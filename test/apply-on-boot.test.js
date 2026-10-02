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

test('startup compares rebased VF intent and ignores internal reference fields as controls',()=>{
 const saved=[{voltageV:.7,freqMhz:1000},{voltageV:.8,freqMhz:2000}];
 const settings={vfCurve:[saved[0],{...saved[1],freqMhz:1990}],vfCurveStockReference:saved};
 const state={vfCurveDefault:saved.map(p=>({...p,voltageV:p.voltageV+.1})),vfCurve:[{voltageV:.8,freqMhz:1000},{voltageV:.9,freqMhz:1990}]};
 assert.equal(profileSettingsMatchCurrentState(settings,state),true);
 const failed={ok:false,perControl:{vfCurve:{ok:false,errorCode:'io-failed'}}};
 assert.equal(reconcileAppliedProfileResult(failed,settings,state).ok,true);
 const mismatch={...state,vfCurve:[state.vfCurve[0],{...state.vfCurve[1],freqMhz:1980}]};
 assert.equal(profileSettingsMatchCurrentState(settings,mismatch),false);
 assert.equal(reconcileAppliedProfileResult(failed,settings,mismatch),failed);
 const changedStock={...state,vfCurveDefault:[state.vfCurveDefault[0],{...state.vfCurveDefault[1],freqMhz:2100}]};
 assert.equal(profileSettingsMatchCurrentState(settings,changedStock),false);
 assert.equal(reconcileAppliedProfileResult(failed,settings,changedStock),failed);
 assert.equal(profileSettingsMatchCurrentState({vfCurveStockReference:saved},state),false);
 assert.equal(reconcileAppliedProfileResult({ok:false,perControl:{vfCurve:{ok:false,errorCode:'readback-unstable'}}},settings,state).ok,false);
});
