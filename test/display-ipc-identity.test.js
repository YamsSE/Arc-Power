import test from 'node:test';
import assert from 'node:assert/strict';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { createUnifiedGpuBackend } from '../src/main/gpu-inventory.js';
import { displayKeyInNamespace } from '../src/main/display-identity.js';

const pnp = 'PCI\\VEN_8086&DEV_56A0&SUBSYS_12345678';
const bdf = '0000:03:00.0';
const outputKey = 'igcl-output|display|DISPLAY1';

function makeAdapter(overrides = {}) {
  return {
    id: 0,
    name: 'Intel Arc B580',
    pciVendorId: '0x8086',
    pciDeviceId: '0x56a0',
    bdf,
    pnpDeviceId: pnp,
    ...overrides,
  };
}

function makeBackend({ adapters = [makeAdapter()], controllers = [{ ...makeAdapter() }], writes = [] } = {}) {
  const backend = {
    kind: 'igcl',
    async listDevices() { return adapters; },
    async getDisplaySettings() {
      return {
        deviceKey: 'igcl-device-key',
        displays: [{ displayKey: outputKey, identityVerified: true }],
      };
    },
    async setDisplaySettings(_id, request) {
      writes.push(request);
      return { ok: true, perControl: { quantizationRange: { ok: true } } };
    },
  };
  return createUnifiedGpuBackend({ backend, videoControllers: controllers });
}

function makeHandlers(backend, applyRunner) {
  return createIpcHandlers({
    backend,
    store: { async loadSettings() { return {}; }, async saveSettings(settings) { return settings; } },
    emit() {},
    applyRunner,
  }).handlers;
}

test('display IPC reconciles a unique retained PCI alias and sends the current parent key to the worker', async () => {
  const parent = makeBackend();
  const workerWrites = [];
  const worker = makeBackend({
    adapters: [makeAdapter({ pnpDeviceId: undefined })],
    controllers: [],
    writes: workerWrites,
  });
  const [parentTarget] = await parent.listDevices();
  const oldAlias = parentTarget.deviceKeys.find((key) => key !== parentTarget.deviceKey && key.startsWith('pci:'));
  assert.ok(oldAlias, 'fixture must expose the pre-PNP PCI identity as a retained alias');
  let workerRequest;
  const applyRunner = {
    async displayApply(request) {
      workerRequest = request;
      const target = await worker.getDeviceTarget(0, request.deviceKey, request.physicalTarget);
      const displayKey = displayKeyInNamespace(request.displayKey, target.deviceKey);
      return worker.setDisplaySettings(0, {
        deviceKey: target.deviceKey,
        displayKey,
        patch: request.settings,
      });
    },
  };
  const handlers = makeHandlers(parent, applyRunner);

  const result = await handlers['display:apply'](0, {
    deviceKey: oldAlias,
    displayKey: displayKeyInNamespace(outputKey, oldAlias),
    patch: { quantizationRange: 'default' },
  });

  assert.equal(result.ok, true);
  assert.equal(workerRequest.deviceKey, parentTarget.deviceKey);
  assert.equal(workerRequest.displayKey, displayKeyInNamespace(outputKey, parentTarget.deviceKey));
  assert.equal(workerWrites.length, 1);
  assert.equal(workerWrites[0].deviceKey, 'igcl-device-key');
});

test('display IPC rejects unrelated, ambiguous, synthetic, replugged, and mismatched output identities before writes', async (t) => {
  const cases = [
    {
      name: 'unrelated GPU key',
      requestKey: 'pnp:PCI\\VEN_8086&DEV_56A0&SUBSYS_OTHER',
      adapters: [makeAdapter()],
    },
    {
      name: 'ambiguous retained alias',
      requestKey: 'pci:0x8086:0x56a0@0000:03:00.0',
      adapters: [makeAdapter(), makeAdapter({ id: 1, pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_DUPLICATE' })],
      controllers: [makeAdapter(), makeAdapter({ id: 1, pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_DUPLICATE' })],
    },
    {
      name: 'synthetic OS target',
      requestKey: 'os:synthetic-display',
      adapters: [],
      controllers: [{ id: 0, name: 'Intel Arc B580', pnpDeviceId: pnp, pciVendorId: '0x8086', pciDeviceId: '0x56a0', bdf }],
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const writes = [];
      const backend = makeBackend({ adapters: scenario.adapters, controllers: scenario.controllers, writes });
      const [target] = await backend.listDevices();
      const requestKey = scenario.requestKey;
      const handlers = makeHandlers(backend, { async displayApply() { throw new Error('must not reach display worker'); } });
      await assert.rejects(handlers['display:apply'](target.id, {
        deviceKey: requestKey,
        displayKey: displayKeyInNamespace(outputKey, requestKey),
        patch: { quantizationRange: 'default' },
      }));
      assert.equal(writes.length, 0);
    });
  }

  await t.test('replug after initial target resolution', async () => {
    let inventoryReads = 0;
    const replacement = makeAdapter({ pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0&SUBSYS_REPLACEMENT' });
    const base = {
      kind: 'igcl',
      async listDevices() { inventoryReads += 1; return [inventoryReads <= 2 ? makeAdapter() : replacement]; },
      async getDisplaySettings() { return { deviceKey: 'igcl-device-key', displays: [{ displayKey: outputKey, identityVerified: true }] }; },
      async setDisplaySettings() { writes.push('unexpected'); return { ok: true, perControl: {} }; },
    };
    const writes = [];
    const backend = createUnifiedGpuBackend({ backend: base, videoControllers: [{ ...makeAdapter() }] });
    const [target] = await backend.listDevices();
    const requestKey = target.deviceKey;
    const handlers = makeHandlers(backend, { async displayApply() { throw new Error('must not reach display worker'); } });
    await assert.rejects(handlers['display:apply'](target.id, {
      deviceKey: requestKey,
      displayKey: displayKeyInNamespace(outputKey, requestKey),
      patch: { quantizationRange: 'default' },
    }));
    assert.equal(writes.length, 0);
  });

  await t.test('display namespace must match the request adapter key', async () => {
    const writes = [];
    const backend = makeBackend({ writes });
    const [target] = await backend.listDevices();
    const handlers = makeHandlers(backend, { async displayApply() { throw new Error('must not reach display worker'); } });
    await assert.rejects(handlers['display:apply'](target.id, {
      deviceKey: target.deviceKey,
      displayKey: displayKeyInNamespace(outputKey, 'pnp:another-adapter'),
      patch: { quantizationRange: 'default' },
    }), /displayKey does not match/);
    assert.equal(writes.length, 0);
  });
});
