// M1 — smoke runner regression test (mock backend, no hardware): the
// acceptance sequence itself (init -> discovery -> caps -> no-op -> verify
// unchanged -> telemetry -> reset-only-if-changed -> health) is covered so
// hardware runs only re-validate against the real A770.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSmoke, SmokeFailure } from '../src/main/smoke.js';
import { MockBackend } from '../src/main/backend/mock-backend.js';

function collect() {
  const lines = [];
  return { push: (s) => lines.push(s), get: () => lines };
}

test('runSmoke: full sequence passes on the mock backend', async () => {
  const out = collect();
  const res = await runSmoke(new MockBackend(), { log: out.push });
  assert.equal(res.ok, true);
  const lines = out.get();
  const text = lines.join('\n');
  assert.match(text, /\[init\] backend\.init/);
  assert.match(text, /\[discovery\] 1 device\(s\): Mock Arc A770/);
  assert.match(text, /\[caps\] supported=\[gpuFreqOffset, gpuVoltOffset, gpuLock, powerLimit, tempLimit\]/);
  assert.match(text, /\[noop\] applied current values as no-op/);
  assert.match(text, /\[verify\] no value changes detected/);
  assert.match(text, /\[reset\] no changes detected — reset NOT called/);
  assert.match(text, /\[telemetry\] sample\[2\]/);
  assert.match(text, /\[health\] final:/);
  assert.match(text, /\[close\] backend closed/);
});

test('runSmoke: reset IS called when a change is detected (regression guard)', async () => {
  // A backend whose no-op apply actually changes a value must trigger reset.
  const backend = new MockBackend();
  const origApply = backend.applySettings.bind(backend);
  let resetCalls = 0;
  const origReset = backend.resetToDefaults.bind(backend);
  backend.resetToDefaults = async () => { resetCalls++; await origReset(); };
  backend.applySettings = async (id, s, opts) => {
    const res = await origApply(id, { ...s, powerLimitW: s.powerLimitW + 5 }, opts);
    return res;
  };
  const out = collect();
  const res = await runSmoke(backend, { log: out.push });
  assert.equal(res.ok, true);
  const text = out.get().join('\n');
  assert.match(text, /CHANGE DETECTED on \[powerLimitW\]/);
  assert.match(text, /ctlOverclockResetToDefault called/);
  assert.equal(resetCalls, 1);
});

test('runSmoke: a failing init surfaces as SmokeFailure', async () => {
  const backend = new MockBackend();
  backend.init = async () => { throw new Error('no runtime'); };
  await assert.rejects(runSmoke(backend, { log: () => {} }), SmokeFailure);
});
