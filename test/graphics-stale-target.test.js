import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { createUnifiedGpuBackend } from '../src/main/gpu-inventory.js';

const oldKey = 'pci:0x8086:0x56a1@0000:03:00.0';
const pnp = 'PCI\\VEN_8086&DEV_56A1&SUBSYS_12345678\\REPORTED-ADAPTER';
const selected = { name: 'Intel Arc Graphics', pciVendorId: '0x8086', pciDeviceId: '0x56a1', bdf: '0000:03:00.0' };
const other = { id: 0, name: 'Other GPU', pciVendorId: '0x8086', pciDeviceId: '0xe20b', bdf: '0000:04:00.0' };
const graphics = () => ({ supported: { lowLatency: true }, supportedOptions: { lowLatency: ['off', 'on'] }, values: { lowLatency: 'off' }, frameLimitRange: null });

for (const reordered of [false, true]) {
  test(`reported 56a1 Graphics apply accepts verified PCI-to-PNP refinement${reordered ? ' after parent and worker ID reordering' : ''}`, async () => {
    const writes = [];
    const parent = createUnifiedGpuBackend({
      backend: {
        kind: 'igcl',
        async listDevices() { return reordered ? [other, { ...selected, id: 2 }] : [{ ...selected, id: 0 }]; },
        async getGraphicsSettings() { return graphics(); },
      },
      videoControllers: [{ ...selected, pnpDeviceId: pnp }],
    });
    const worker = createUnifiedGpuBackend({
      sysinfo: null,
      backend: {
        kind: 'igcl',
        async listDevices() { return [other, { ...selected, id: 7 }]; },
        async getGraphicsSettings() { return graphics(); },
        async setGraphicsSettings(id, settings) { writes.push({ id, settings }); return { ok: true, perControl: { lowLatency: { ok: true } } }; },
      },
    });
    const handlers = createIpcHandlers({
      backend: parent,
      store: { loadSettings: async () => ({ deviceId: 0, deviceKey: oldKey }), saveSettings: async value => value },
      emit() {},
      applyRunner: {
        async graphicsApplyIsolated(request) {
          assert.equal(request.deviceId, reordered ? 2 : 0);
          assert.equal(request.deviceKey, `pnp:${pnp}`);
          assert.equal(request.physicalTarget.pciDeviceId, '0x56a1');
          const target = await worker.resolvePhysicalTarget(request.deviceKey, request.physicalTarget);
          assert.equal(target.id, 7);
          await worker.assertDeviceTarget(target.id, request.deviceKey, request.physicalTarget);
          return { ...await worker.setGraphicsSettings(target.id, request.settings), graphicsState: await worker.getGraphicsSettings(target.id) };
        },
      },
    }).handlers;
    const result = await handlers['graphics:apply'](0, { lowLatency: 'on' }, oldKey);
    assert.equal(result.ok, true);
    assert.deepEqual(writes, [{ id: 7, settings: { lowLatency: 'on' } }]);
  });
}

test('Graphics reads the explicitly selected physical target after numeric ID reordering', async () => {
  const selectedKey = 'pci:0x8086:0x56a1@0000:03:00.0';
  const devices = [other, { ...selected, id: 3 }];
  const reads = [];
  const backend = createUnifiedGpuBackend({
    backend: {
      kind: 'igcl',
      async listDevices() { return devices; },
      async getGraphicsSettings(id) { reads.push(id); return graphics(); },
    },
    videoControllers: [{ ...selected, pnpDeviceId: pnp }],
  });
  const handlers = createIpcHandlers({
    backend,
    store: { loadSettings: async () => ({ deviceId: 0, deviceKey: selectedKey }) },
    emit() {},
  }).handlers;

  await handlers['graphics:get'](2, selectedKey);
  assert.deepEqual(reads, [3]);
});

test('Graphics apply fails closed for missing, unrelated, ambiguous, or absent explicit identity', async (t) => {
  for (const scenario of ['missing', 'unrelated', 'ambiguous', 'saved-id-mismatch']) {
    await t.test(scenario, async () => {
      const writes = [];
      const canonical = 'pci:selected';
      const alias = 'pci:alias';
      const inventory = scenario === 'missing' ? [other]
        : scenario === 'ambiguous' ? [{ ...selected, id: 2, deviceKey: canonical, deviceKeys: [alias] }, { ...selected, id: 3, deviceKey: 'pci:duplicate', deviceKeys: [alias] }]
          : [{ ...selected, id: 2, deviceKey: canonical, deviceKeys: scenario === 'unrelated' ? [] : [alias] }];
      const backend = {
        async listDevices() { return inventory; },
        async getDeviceTarget(id) {
          const row = inventory.find((device) => device.id === id);
          return row ? { ...row, identityAmbiguous: scenario === 'ambiguous' } : null;
        },
        async getGraphicsSettings() { return graphics(); },
        async setGraphicsSettings(id, settings) { writes.push({ id, settings }); return { ok: true, perControl: {} }; },
      };
      const handlers = createIpcHandlers({
        backend,
        store: { loadSettings: async () => ({ deviceId: scenario === 'saved-id-mismatch' ? 5 : 0, deviceKey: canonical }) },
        emit() {},
      }).handlers;
      const key = scenario === 'saved-id-mismatch' ? undefined : alias;
      await assert.rejects(handlers['graphics:apply'](0, { lowLatency: 'on' }, key), /stale GPU target/);
      assert.deepEqual(writes, []);
    });
  }
});

test('Graphics refuses unknown saved identity before any hardware call', async (t) => {
  for (const scenario of ['missing-id', 'store-error', 'missing-key']) {
    await t.test(scenario, async () => {
      const calls = [];
      const backend = {
        kind: 'igcl',
        resolvePhysicalTarget() { calls.push('resolve'); },
        async getDeviceTarget() { calls.push('target'); return { deviceKey: oldKey }; },
        async getGraphicsSettings() { calls.push('read'); return graphics(); },
        async setGraphicsSettings() { calls.push('write'); return { ok: true }; },
      };
      const handlers = createIpcHandlers({
        backend,
        store: { async loadSettings() {
          if (scenario === 'store-error') throw new Error('unreadable settings');
          return scenario === 'missing-id' ? { deviceKey: oldKey } : { deviceId: 0 };
        } },
        emit() {},
      }).handlers;
      await assert.rejects(handlers['graphics:apply'](0, { lowLatency: 'on' }), /stale GPU target/);
      await assert.rejects(handlers['graphics:get'](0), /stale GPU target/);
      assert.deepEqual(calls, []);
    });
  }
});

test('Explicit Graphics identity remains usable when saved settings cannot be read', async () => {
  const writes = [];
  const target = { ...selected, id: 2, deviceKey: oldKey };
  const backend = {
    kind: 'igcl',
    async resolvePhysicalTarget() { return target; },
    async listDevices() { return [target]; },
    async getDeviceTarget() { return target; },
    async getGraphicsSettings() { return graphics(); },
    async setGraphicsSettings(id, settings) { writes.push({ id, settings }); return { ok: true, perControl: {} }; },
  };
  const handlers = createIpcHandlers({
    backend,
    store: { async loadSettings() { throw new Error('unreadable settings'); } },
    emit() {},
  }).handlers;
  await handlers['graphics:get'](0, oldKey);
  await handlers['graphics:apply'](0, { lowLatency: 'on' }, oldKey);
  assert.deepEqual(writes, [{ id: 2, settings: { lowLatency: 'on' } }]);
});
