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

test('positive Alchemist voltage is blocked when Sysman state and clear writer are unavailable', async () => {
  let igclCalls = 0;
  const result = await applySettingsRouted({
    backend: {
      async applySettings() {
        igclCalls += 1;
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: true } } };
      },
    },
    deviceId: 0,
    settings: { gpuVoltOffsetV: 0.02 },
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async readVoltageOffsetResult() { return { ok: false, errorCode: 'unavailable', message: 'Sysman read unavailable' }; },
    },
    sleep: async () => {},
  });

  assert.equal(igclCalls, 0, 'IGCL positive write must require verified zero Sysman state');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.perControl.gpuVoltOffsetV.errorCode, 'unavailable');
});

test('negative Alchemist voltage clears IGCL before setting the Sysman offset', async () => {
  const calls = [];
  const result = await applySettingsRouted({
    backend: {
      async applySettings(_deviceId, settings) {
        calls.push(['igcl', settings.gpuVoltOffsetV]);
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: true } } };
      },
    },
    deviceId: 0,
    settings: { gpuVoltOffsetV: -0.05 },
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async setVoltageOffset({ offsetV }) {
        calls.push(['sysman', offsetV]);
        return { ok: true, offsetV };
      },
    },
    sleep: async () => {},
  });

  assert.deepEqual(calls, [['igcl', 0], ['sysman', -0.05]]);
  assert.equal(result.result.perControl.gpuVoltOffsetV.ok, true);
});

test('negative Alchemist voltage is blocked when IGCL zero cannot be verified', async () => {
  let sysmanCalls = 0;
  const result = await applySettingsRouted({
    backend: {
      async applySettings() {
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: false } } };
      },
    },
    deviceId: 0,
    settings: { gpuVoltOffsetV: -0.05 },
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async setVoltageOffset({ offsetV }) {
        sysmanCalls += 1;
        return { ok: true, offsetV };
      },
    },
    sleep: async () => {},
  });

  assert.equal(sysmanCalls, 0, 'Sysman negative write must not follow an unverified IGCL clear');
  assert.equal(result.result.ok, false);
  assert.equal(result.result.perControl.gpuVoltOffsetV.ok, false);
});

test('positive Alchemist voltage clears Sysman before IGCL, and zero clears both writers', async () => {
  const positiveCalls = [];
  const positive = await applySettingsRouted({
    backend: {
      async applySettings(_deviceId, settings) {
        positiveCalls.push(['igcl', settings.gpuVoltOffsetV]);
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: true } } };
      },
    },
    deviceId: 0,
    settings: { gpuVoltOffsetV: 0.02 },
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async readVoltageOffsetResult() { return { ok: true, offsetV: -0.05 }; },
      async setVoltageOffset({ offsetV }) {
        positiveCalls.push(['sysman', offsetV]);
        return { ok: true, offsetV };
      },
    },
    sleep: async () => {},
  });
  assert.deepEqual(positiveCalls, [['sysman', 0], ['igcl', 0.02]]);
  assert.equal(positive.result.perControl.gpuVoltOffsetV.ok, true);

  const zeroCalls = [];
  const zero = await applySettingsRouted({
    backend: {
      async applySettings(_deviceId, settings) {
        zeroCalls.push(['igcl', settings.gpuVoltOffsetV]);
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: true } } };
      },
    },
    deviceId: 0,
    settings: { gpuVoltOffsetV: 0 },
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async setVoltageOffset({ offsetV }) {
        zeroCalls.push(['sysman', offsetV]);
        return { ok: true, offsetV };
      },
    },
    sleep: async () => {},
  });
  assert.deepEqual(zeroCalls, [['igcl', 0], ['sysman', 0]]);
  assert.equal(zero.result.perControl.gpuVoltOffsetV.ok, true);
});

test('zero Alchemist voltage reports failure if either writer clear fails', async () => {
  let sysmanCalls = 0;
  const result = await applySettingsRouted({
    backend: {
      async applySettings() {
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: true } } };
      },
    },
    deviceId: 0,
    settings: { gpuVoltOffsetV: 0 },
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async setVoltageOffset() {
        sysmanCalls += 1;
        return { ok: false, errorCode: 'io-failed', message: 'Sysman clear refused' };
      },
    },
    sleep: async () => {},
  });

  assert.equal(sysmanCalls, 1);
  assert.equal(result.result.ok, false);
  assert.match(result.result.perControl.gpuVoltOffsetV.message, /Sysman clear refused/);
});

test('zero Alchemist voltage fails when Sysman is unreadable and has no clear writer', async () => {
  const result = await applySettingsRouted({
    backend: {
      async applySettings() {
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: true } } };
      },
    },
    deviceId: 0,
    settings: { gpuVoltOffsetV: 0 },
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async readVoltageOffsetResult() { return { ok: false, errorCode: 'unavailable', message: 'Sysman read unavailable' }; },
    },
    sleep: async () => {},
  });

  assert.equal(result.result.ok, false);
  assert.equal(result.result.perControl.gpuVoltOffsetV.errorCode, 'unavailable');
  assert.match(result.result.perControl.gpuVoltOffsetV.message, /Sysman read unavailable/);
});

test('positive and zero Alchemist requests allow a missing Sysman writer only when read-back is already zero', async () => {
  const calls = [];
  const deps = {
    backend: {
      async applySettings(_deviceId, settings) {
        calls.push(settings.gpuVoltOffsetV);
        return { ok: true, perControl: { gpuVoltOffsetV: { ok: true, readBackEqual: true } } };
      },
    },
    deviceId: 0,
    ranges: { gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.234, step: 0.001 } },
    sysmanPowerLimits: {
      async readVoltageOffsetResult() { return { ok: true, offsetV: 0 }; },
    },
    sleep: async () => {},
  };

  const positive = await applySettingsRouted({ ...deps, settings: { gpuVoltOffsetV: 0.02 } });
  const zero = await applySettingsRouted({ ...deps, settings: { gpuVoltOffsetV: 0 } });

  assert.deepEqual(calls, [0.02, 0]);
  assert.equal(positive.result.perControl.gpuVoltOffsetV.ok, true);
  assert.equal(zero.result.perControl.gpuVoltOffsetV.ok, true);
});

test('Advanced profiles keep VF reference and reset metadata with the post-temperature curve call', async () => {
 const curve=[{voltageV:.7,freqMhz:1000},{voltageV:.8,freqMhz:2000}];
 for(const metadata of [{vfCurveBaseline:curve},{vfCurveStockReference:curve},{vfCurveResetToDefault:true}]) {
  const calls=[];
  const out=await applySettingsRouted({deviceId:0,settings:{tempLimitC:95,vfCurve:curve,...metadata},mode:'advanced',ranges:{tempLimitC:{units:'C',min:0,max:105}},
   backend:{async applySettings(_id,settings){calls.push(settings);return {ok:true,perControl:{vfCurve:{ok:true,readBackEqual:true}}};}},
   oldIgcl:{async setTempLimitC(){calls.push('temperature');return {ok:true,readBackEqual:true};}},sleep:async()=>{}});
  assert.equal(out.result.ok,true);assert.deepEqual(calls,['temperature',{vfCurve:curve,...metadata}]);
 }
});

test('invalid VF metadata rejects Advanced scalar phase before any setter',async()=>{
 let writes=0;
 const out=await applySettingsRouted({deviceId:0,settings:{tempLimitC:95,vfCurveStockReference:[]},mode:'advanced',ranges:{tempLimitC:{units:'C',min:0,max:105}},
 backend:{async applySettings(){writes++;}},oldIgcl:{async setTempLimitC(){writes++;}},sleep:async()=>{}});
 assert.equal(out.result.ok,false); assert.equal(writes,0);
});
