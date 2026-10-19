import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { createUnifiedGpuBackend, physicalTargetOf } from '../src/main/gpu-inventory.js';

async function fixture() {
  let rows = [{ id: 2, name: 'Intel Arc B580', pciVendorId: '0x8086', pciDeviceId: '0xe20b', bdf: '0000:03:00.0' }];
  let replaceDuringCaps = false;
  const requests = [];
  const backend = createUnifiedGpuBackend({
    sysinfo: null,
    backend: {
      kind: 'igcl',
      async listDevices() { return rows; },
      async getCapabilities() {
        if (replaceDuringCaps) rows = [{ ...rows[0], bdf: '0000:04:00.0' }];
        return { overclockingSupported: true, waiverAccepted: true, ranges: {}, fan: { canControl: true, modes: ['auto', 'curve'], maxCurvePoints: 32 } };
      },
    },
  });
  const [target] = await backend.listDevices();
  const expectedTarget = { deviceKey: target.deviceKey, physicalTarget: physicalTargetOf(target) };
  const handlers = createIpcHandlers({
    backend,
    emit() {},
    store: { loadSettings: async () => ({ waiverAccepted: true }), saveSettings: async v => v },
    applyRunner: {
      needsWorker: () => true,
      async apply(request) {
        requests.push(request);
        return { result: { ok: true, perControl: { fanMode: { ok: true, readBackEqual: true } } }, state: { fanMode: 'auto' } };
      },
    },
  }).handlers;
  return { target, expectedTarget, requests, apply: handlers['apply-settings'], replace: () => { replaceDuringCaps = true; } };
}

test('resume fan IPC carries the original physical proof through the final apply dispatch', async () => {
  const f = await fixture();
  const result = await f.apply(f.target.id, { fanMode: 'auto' }, { resumeRestore: true, expectedTarget: f.expectedTarget });
  assert.equal(result.result.ok, true);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].deviceKey, f.expectedTarget.deviceKey);
  assert.deepEqual(f.requests[0].physicalTarget, f.expectedTarget.physicalTarget);
  assert.deepEqual(f.requests[0].settings, { fanMode: 'auto' });
});

test('an adapter change during capability reads refuses resume before the runner writes', async () => {
  const f = await fixture();
  f.replace();
  await assert.rejects(f.apply(f.target.id, { fanMode: 'auto' }, { resumeRestore: true, expectedTarget: f.expectedTarget }), /unknown device|physical proof|stale/i);
  assert.equal(f.requests.length, 0);
});

test('resume IPC refuses non-fan settings, missing proof and malformed proof before writes', async () => {
  const f = await fixture();
  await assert.rejects(f.apply(f.target.id, { powerLimitW: 200 }, { resumeRestore: true, expectedTarget: f.expectedTarget }), /fan-only/);
  await assert.rejects(f.apply(f.target.id, { fanMode: 'auto' }, { resumeRestore: true }), /physically verified/);
  await assert.rejects(f.apply(f.target.id, { fanMode: 'auto' }, { expectedTarget: { deviceKey: f.target.deviceKey, physicalTarget: [] } }), /physical proof/);
  assert.equal(f.requests.length, 0);
});
