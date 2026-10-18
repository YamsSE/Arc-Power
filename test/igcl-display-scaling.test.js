import test from 'node:test';
import assert from 'node:assert/strict';
import koffi from 'koffi';
import { CTL_RESULT, decodeScalingSettings, describeResult } from '../src/main/backend/igcl-bindings.js';
import { applyDisplayScaling, readDisplayScaling } from '../src/main/backend/igcl-display-scaling.js';

const HANDLE = 0x1234n;
const OFF = { enable: 5, flag: 8, x: 12, y: 16, hardware: 20, preferred: 24 };
function put(buf, state) {
  koffi.encode(buf, OFF.enable, 'bool', state.enable ?? true);
  koffi.encode(buf, OFF.flag, 'uint32', state.scalingType ?? 1);
  koffi.encode(buf, OFF.x, 'uint32', state.customX ?? 0);
  koffi.encode(buf, OFF.y, 'uint32', state.customY ?? 0);
  koffi.encode(buf, OFF.hardware, 'bool', state.hardwareModeSet ?? false);
  koffi.encode(buf, OFF.preferred, 'uint32', state.preferredScalingType ?? 1);
}
function stateFrom(buf) { return decodeScalingSettings(buf); }
function fake(initial, { getResults = [], setResults = [], setResult = CTL_RESULT.SUCCESS, transform } = {}) {
  let state = { enable: true, scalingType: 1, preferredScalingType: 1, customX: 0, customY: 0, ...initial };
  const nativeTiming = state.scalingType === 1;
  const calls = [];
  return {
    calls,
    ctlGetCurrentScaling(handle, buf) {
      calls.push({ op: 'get', handle, size: koffi.decode(buf, 0, 'uint32'), version: koffi.decode(buf, 4, 'uint8'), preferredIn: koffi.decode(buf, OFF.preferred, 'uint32') });
      const result = getResults.shift() ?? CTL_RESULT.SUCCESS;
      if (result === CTL_RESULT.SUCCESS) put(buf, state);
      return result;
    },
    ctlSetCurrentScaling(handle, buf) {
      const requested = stateFrom(buf);
      const result = setResults.shift() ?? setResult;
      calls.push({ op: 'set', handle, requested, version: koffi.decode(buf, 4, 'uint8'), result });
      if (result !== CTL_RESULT.SUCCESS) return result;
      const next = transform ? transform(requested, state, calls.length) : requested;
      // PreferredScalingType is GET-only. Emulate the observed native-timing
      // driver behavior rather than copying its zeroed SET input into GET.
      const preferred = next.preferredScalingType || ([2, 4, 8].includes(requested.scalingType) ? requested.scalingType : state.preferredScalingType);
      state = { ...next, preferredScalingType: preferred,
        scalingType: nativeTiming && [2, 4, 8].includes(next.scalingType) && next.preferredScalingType === 0 ? 1 : next.scalingType };
      return CTL_RESULT.SUCCESS;
    },
    current: () => state,
  };
}

test('GET uses 28-byte zeroed v1 layout and falls back to v0 only for compatibility errors', () => {
  const lib = fake({ scalingType: 1, preferredScalingType: 8 }, { getResults: [CTL_RESULT.ERROR_INVALID_ARGUMENT, CTL_RESULT.SUCCESS] });
  const read = readDisplayScaling(lib, HANDLE);
  assert.equal(read.ok, true);
  assert.equal(read.version, 0);
  assert.deepEqual(lib.calls.map(({ size, version }) => [size, version]), [[28, 1], [28, 0]]);
  assert.ok(lib.calls.every(call => call.preferredIn === 0));
  const noFallback = fake({}, { getResults: [CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS] });
  assert.equal(readDisplayScaling(noFallback, HANDLE).result, CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS);
  assert.equal(noFallback.calls.length, 1);
  assert.ok(describeResult(CTL_RESULT.ERROR_INVALID_ARGUMENT));
});

test('SET retries with v0 only after v1 compatibility rejection and never sends preferred type as input', async () => {
  const lib = fake({ scalingType: 1, preferredScalingType: 1 }, { setResults: [CTL_RESULT.ERROR_UNSUPPORTED_VERSION, CTL_RESULT.SUCCESS] });
  const out = await applyDisplayScaling(lib, HANDLE, { flag: 2 });
  assert.equal(out.ok, true);
  const sets = lib.calls.filter(call => call.op === 'set');
  assert.deepEqual(sets.map(call => [call.version, call.requested.scalingType, call.requested.hardwareModeSet]), [[1, 2, false], [0, 2, false]]);
  assert.ok(sets.every(call => call.requested.preferredScalingType === 0));
});

test('GPU scaling preference without active scaling is truthfully deferred', async () => {
  const lib = fake({ scalingType: 1, preferredScalingType: 1 }, {
    transform: request => request.scalingType === 8
      ? { ...request, scalingType: 1, preferredScalingType: 8 }
      : request,
  });
  const out = await applyDisplayScaling(lib, HANDLE, { flag: 8 });
  assert.equal(out.ok, true);
  assert.equal(out.readBackEqual, false);
  assert.equal(out.preferredReadBackEqual, true);
  assert.equal(out.deferred, true);
  assert.equal(out.verification, 'native-preference');
});

test('active GPU selection and identity with stale preference use active-state proof', async () => {
  const gpu = fake({ scalingType: 8, preferredScalingType: 1 });
  const gpuOut = await applyDisplayScaling(gpu, HANDLE, { flag: 8 });
  assert.equal(gpuOut.readBackEqual, true);
  assert.equal(gpuOut.deferred, false);
  const identity = fake({ scalingType: 8, preferredScalingType: 8 }, { transform: request => ({ ...request, scalingType: 1, preferredScalingType: 8 }) });
  const identityOut = await applyDisplayScaling(identity, HANDLE, { flag: 1 });
  assert.equal(identityOut.ok, true);
  assert.equal(identityOut.readBackEqual, true);
  assert.equal(identityOut.preferredReadBackEqual, false);
});

test('custom scaling defaults to 100, preserves existing coordinates, and rejects invalid explicit input', async () => {
  const initial = fake({ scalingType: 1, customX: 0, customY: 0 });
  const first = await applyDisplayScaling(initial, HANDLE, { flag: 16 });
  assert.deepEqual([initial.current().customX, initial.current().customY], [100, 100]);
  assert.equal(first.ok, true);
  const preserved = fake({ scalingType: 16, customX: 95, customY: 91 });
  const next = await applyDisplayScaling(preserved, HANDLE, { flag: 16 });
  assert.equal(next.ok, true);
  assert.deepEqual([preserved.current().customX, preserved.current().customY], [95, 91]);
  const invalid = await applyDisplayScaling(preserved, HANDLE, { flag: 16, custom: { x: 101, y: 50 } });
  assert.equal(invalid.result, CTL_RESULT.ERROR_INVALID_ARGUMENT);
  assert.equal(preserved.calls.filter(call => call.op === 'set').length, 1);
});

test('explicit custom percent follows a verified neutral 100/100 initialization phase', async () => {
  const lib = fake({ scalingType: 1, customX: 0, customY: 0 });
  const out = await applyDisplayScaling(lib, HANDLE, { flag: 16, custom: { x: 95, y: 95 } });
  assert.equal(out.ok, true);
  assert.deepEqual(lib.calls.filter(call => call.op === 'set').map(call => [call.requested.customX, call.requested.customY]), [[100, 100], [95, 95]]);
  assert.deepEqual([lib.current().customX, lib.current().customY], [95, 95]);
});

test('unverified neutral initialization stops before requested percent and rolls back original native state', async () => {
  let writes = 0;
  const lib = fake({ scalingType: 1, preferredScalingType: 4 }, {
    transform(request, previous) {
      writes += 1;
      return writes === 1 ? previous : request;
    },
  });
  const out = await applyDisplayScaling(lib, HANDLE, { flag: 16, custom: { x: 95, y: 95 } });
  assert.equal(out.ok, false);
  assert.equal(out.initialization.readBackEqual, false);
  assert.equal(out.rollback.verified, true);
  assert.deepEqual(lib.calls.filter(call => call.op === 'set').map(call => call.requested.scalingType), [16, 4]);
});

test('requested custom SET failure after verified initialization restores captured native selection', async () => {
  const lib = fake({ scalingType: 1, preferredScalingType: 8 }, { setResults: [CTL_RESULT.SUCCESS, CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS, CTL_RESULT.SUCCESS] });
  const out = await applyDisplayScaling(lib, HANDLE, { flag: 16, custom: { x: 95, y: 95 } });
  assert.equal(out.ok, false);
  assert.equal(out.initialization.readBackEqual, true);
  assert.equal(out.rollback.verified, true);
  assert.deepEqual(lib.calls.filter(call => call.op === 'set').map(call => call.requested.scalingType), [16, 16, 8]);
});

test('refused SET is reported without rollback; accepted unverified SET rolls back and verifies it separately', async () => {
  const refused = fake({ scalingType: 1, preferredScalingType: 1 }, { setResult: CTL_RESULT.ERROR_INSUFFICIENT_PERMISSIONS });
  const denied = await applyDisplayScaling(refused, HANDLE, { flag: 4 });
  assert.equal(denied.ok, false);
  assert.equal(denied.changed, false);
  assert.equal('rollback' in denied, false);
  assert.equal(refused.calls.filter(call => call.op === 'set').length, 1);

  let writes = 0;
  const mismatch = fake({ scalingType: 1, preferredScalingType: 1 }, {
    transform(request) {
      writes += 1;
      return writes === 1 ? { ...request, scalingType: 1, preferredScalingType: 1 } : request;
    },
  });
  const failed = await applyDisplayScaling(mismatch, HANDLE, { flag: 4 });
  assert.equal(failed.ok, false);
  assert.equal(failed.readBackEqual, false);
  assert.equal(failed.rollback.verified, true);
  assert.deepEqual(mismatch.calls.filter(call => call.op === 'set').map(call => call.requested.scalingType), [4, 1]);
});

test('rollback verifies the original Identity plus GPU preference and preserves a disabled scaler', async () => {
  for (const enable of [true, false]) {
    let writes = 0;
    const lib = fake({ enable, scalingType: 1, preferredScalingType: 8 }, {
      transform(request, previous) { return ++writes === 1 ? { ...previous, enable: true } : request; },
    });
    const out = await applyDisplayScaling(lib, HANDLE, { flag: 4 });
    assert.equal(out.ok, false);
    assert.equal(out.rollback.verified, true);
    assert.equal(out.rollback.readBack.settings.enable, enable);
    assert.equal(out.rollback.readBack.settings.scalingType, 1);
    assert.equal(out.rollback.readBack.settings.preferredScalingType, 8);
  }
});

test('version zero readback cannot prove a preferred-only GPU selection', async () => {
  const lib = fake({ scalingType: 1, preferredScalingType: 8 }, {
    getResults: [CTL_RESULT.ERROR_UNSUPPORTED_VERSION, CTL_RESULT.SUCCESS, CTL_RESULT.ERROR_UNSUPPORTED_VERSION, CTL_RESULT.SUCCESS],
  });
  const out = await applyDisplayScaling(lib, HANDLE, { flag: 8 });
  assert.equal(out.ok, false);
  assert.equal(out.deferred, false);
  assert.equal(out.preferredReadBackEqual, false);
});

test('unavailable functions and thrown getters fail without a native SET', async () => {
  const unavailable = () => { throw new Error('must not call an unavailable function'); };
  unavailable.unavailable = true;
  assert.equal(readDisplayScaling({ ctlGetCurrentScaling: unavailable }, HANDLE).result, CTL_RESULT.ERROR_UNSUPPORTED_FEATURE);
  const read = readDisplayScaling({ ctlGetCurrentScaling() { throw new Error('driver exception'); } }, HANDLE);
  assert.equal(read.ok, false);
  assert.match(read.error, /driver exception/);
  const lib = fake({ scalingType: 123, preferredScalingType: 0 });
  assert.equal((await applyDisplayScaling(lib, HANDLE, { flag: 8 })).ok, false);
  assert.equal(lib.calls.filter(call => call.op === 'set').length, 0);
});
