import test from 'node:test';
import assert from 'node:assert/strict';
import { createFanResumeController, fanOnlySettings } from '../src/main/fan-resume-controller.js';

function fixture({ fail = false, elevated = true, delayImpl = async () => {}, timers = [1, 1], throwApply = null, removeFailure = false } = {}) {
  const rows = [{ id: 6, deviceKey: 'gpu:a', bdf: '00:02.0', backendId: 2 }];
  const saved = new Map();
  const store = {
    async list() { return [...saved.values()]; },
    async get(key) { return saved.get(key) ?? null; },
    async set(row) { saved.set(row.deviceKey, structuredClone(row)); },
    async remove(key) { if (removeFailure) throw new Error('disk failure'); saved.delete(key); },
  };
  const backend = {
    async getDeviceTarget(id) { return rows.find((row) => row.id === id); },
    async getCapabilities() { return { fan: { canControl: true, modes: ['auto', 'curve', 'fixed'], maxCurvePoints: 10 } }; },
    async getCurrentSettings() { return { fanMode: 'curve', fanCurve: [{ t: 30, speedPct: 20 }, { t: 90, speedPct: 80 }], fixedFanPct: 50 }; },
    async resolvePhysicalTarget(key, proof) {
      if (key !== 'gpu:a' || proof.bdf !== '0000:00:02.0') throw new Error('identity mismatch');
      return { id: 6 };
    },
    async assertDeviceTarget(id, key, proof) {
      if (id !== 6 || !['gpu:a', 'gpu:pnp'].includes(key) || proof.bdf !== '0000:00:02.0') throw new Error('stale identity');
    },
  };
  const calls = [];
  const controller = createFanResumeController({
    backend, store, isElevated: () => elevated,
    applyRunner: { needsWorker: () => !elevated },
    delay: delayImpl, timers,
    rawApplySettings: async (...args) => {
      calls.push(args);
      if (throwApply) throw throwApply;
      return { result: { perControl: { fanMode: { ok: !fail }, fanCurve: { ok: !fail } } }, state: { fanMode: 'curve' } };
    },
  });
  return { controller, saved, calls, store, backend, rows };
}

test('fan resume defaults off and captures only live fan controls after explicit enable', async () => {
  const { controller, saved } = fixture();
  await controller.initialize();
  assert.equal((await controller.getState('gpu:a')).enabled, false);
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  assert.equal((await controller.getState('gpu:a')).enabled, true);
  assert.deepEqual(Object.keys(saved.get('gpu:a').settings).sort(), ['fanCurve', 'fanMode']);
  assert.deepEqual(fanOnlySettings({ fanMode: 'auto' }), { fanMode: 'auto' });
  assert.deepEqual(fanOnlySettings({ fanMode: 'fixed', fixedFanPct: 55 }), { fanMode: 'fixed', fixedFanPct: 55 });
  assert.throws(() => fanOnlySettings({ fanMode: 'curve', fanCurve: [{ t: 1, speedPct: 20 }, { t: 2, speedPct: 101 }] }));
});

test('resume resolves and asserts physical identity, then writes only fan settings', async () => {
  const { controller, calls, saved } = fixture();
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await controller.onResume();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 6);
  assert.deepEqual(Object.keys(calls[0][1]).sort(), ['fanCurve', 'fanMode']);
  assert.equal(calls[0][2].resumeRestore, true);
  assert.equal(calls[0][2].expectedTarget.deviceKey, 'gpu:a');
  assert.deepEqual(calls[0][2].expectedTarget.physicalTarget, saved.get('gpu:a').physicalTarget);
});

test('resume retries transient missing fan capabilities before writing', async () => {
  const { controller, backend, calls } = fixture({ timers: [1, 1] });
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  let reads = 0;
  backend.getCapabilities = async () => {
    reads += 1;
    return reads === 1 ? { fan: { canControl: false, modes: [] } }
      : { fan: { canControl: true, modes: ['auto', 'curve', 'fixed'], maxCurvePoints: 10 } };
  };
  await controller.onResume();
  assert.equal(reads, 2);
  assert.equal(calls.length, 1);
});

test('a new resume while the canceled previous native apply settles is not lost', async () => {
  let releaseFirst;
  let enterFirst;
  const firstEntered = new Promise(resolve => { enterFirst = resolve; });
  const firstPending = new Promise(resolve => { releaseFirst = resolve; });
  const { controller, calls, backend, store } = fixture();
  let attempts = 0;
  const pendingController = createFanResumeController({ backend, store, isElevated: () => true, delay: async () => {}, timers: [1],
    rawApplySettings: async (...args) => {
      calls.push(args);
      attempts += 1;
      if (attempts === 1) { enterFirst(); await firstPending; }
      return { result: { ok: true, perControl: { fanMode: { ok: true }, fanCurve: { ok: true } } }, state: { fanMode: 'curve' } };
    },
  });
  await controller.stop();
  await pendingController.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  const oldResume = pendingController.onResume();
  await firstEntered;
  pendingController.onSuspend();
  const freshResume = pendingController.onResume();
  const duplicateResume = pendingController.onResume();
  releaseFirst();
  await Promise.all([oldResume, freshResume, duplicateResume]);
  assert.equal(attempts, 2);
  assert.equal((await pendingController.getState('gpu:a')).state, 'restored');
  await pendingController.stop();
});

test('failed fan restore does not claim success; OFF cancels and removes saved target', async () => {
  const { controller, calls, saved } = fixture({ fail: true });
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await controller.onResume();
  assert.equal(calls.length, 2);
  assert.notEqual((await controller.getState('gpu:a')).state, 'restored');
  await controller.setEnabled({ enabled: false, deviceKey: 'gpu:a' });
  assert.equal(saved.has('gpu:a'), false);
  assert.equal((await controller.getState('gpu:a')).enabled, false);
});

test('ambiguous current identity and non-elevated worker restores fail closed', async () => {
  const noElev = fixture({ elevated: false });
  await noElev.controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await noElev.controller.onResume();
  assert.equal(noElev.calls.length, 0);
  const ambiguous = fixture();
  ambiguous.backend.resolvePhysicalTarget = async () => { throw new Error('ambiguous'); };
  await ambiguous.controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await ambiguous.controller.onResume();
  assert.equal(ambiguous.calls.length, 0);
});

test('a new user apply wakes and cancels pending retry delay before joining the queue', async () => {
  let releaseDelay;
  const delayed = new Promise((resolve) => { releaseDelay = resolve; });
  const { controller, calls } = fixture({ delayImpl: () => delayed });
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  void controller.onResume();
  await new Promise((resolve) => setImmediate(resolve));
  await controller.runUserApply([6, { fanMode: 'curve', fanCurve: [{ t: 30, speedPct: 25 }, { t: 90, speedPct: 85 }] }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], undefined);
  releaseDelay();
});

test('a non-fan apply runs during resume backoff without cancelling fan restoration', async () => {
  let releaseDelay;
  const delayed = new Promise((resolve) => { releaseDelay = resolve; });
  const { controller, calls } = fixture({ delayImpl: () => delayed, timers: [100] });
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  const resume = controller.onResume();
  await new Promise((resolve) => setImmediate(resolve));
  await controller.runUserApply([6, { powerLimit: 150 }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2], undefined);
  releaseDelay();
  await resume;
  assert.equal(calls.length, 2);
  assert.equal(calls[1][2].resumeRestore, true);
});

test('a fan apply cancels only that GPU restore and leaves other GPUs queued', async () => {
  let releaseFirstDelay;
  let delayCalls = 0;
  const firstDelay = new Promise((resolve) => { releaseFirstDelay = resolve; });
  const { controller, backend, rows, calls } = fixture({
    delayImpl: () => (++delayCalls === 1 ? firstDelay : Promise.resolve()), timers: [100],
  });
  rows.push({ id: 7, deviceKey: 'gpu:b', bdf: '00:03.0', backendId: 3 });
  backend.resolvePhysicalTarget = async (key, proof) => {
    const expectedId = key === 'gpu:a' ? 6 : key === 'gpu:b' ? 7 : null;
    if (!expectedId || proof.bdf !== (key === 'gpu:a' ? '0000:00:02.0' : '0000:00:03.0')) throw new Error('identity mismatch');
    return { id: expectedId };
  };
  backend.assertDeviceTarget = async (id, key, proof) => {
    if ((key === 'gpu:a' && (id !== 6 || proof.bdf !== '0000:00:02.0'))
      || (key === 'gpu:b' && (id !== 7 || proof.bdf !== '0000:00:03.0'))) throw new Error('stale identity');
  };
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await controller.setEnabled({ enabled: true, deviceId: 7, deviceKey: 'gpu:b' });
  const resume = controller.onResume();
  await new Promise((resolve) => setImmediate(resolve));
  await controller.runUserApply([6, { fanMode: 'curve', fanCurve: [{ t: 30, speedPct: 25 }, { t: 90, speedPct: 85 }] }]);
  releaseFirstDelay();
  await resume;
  assert.deepEqual(calls.map(([id, , opts]) => [id, opts?.resumeRestore === true]), [[6, false], [7, true]]);
});

test('a partial fan apply invalidates the previously saved restore target', async () => {
  const { controller, saved } = fixture();
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await controller.noteApply(6, { fanMode: 'curve', fanCurve: [{ t: 30, speedPct: 25 }, { t: 90, speedPct: 85 }] }, {
    result: { perControl: { fanMode: { ok: true }, fanCurve: { ok: false, errorCode: 'io-failed' } } },
  });
  assert.equal(saved.has('gpu:a'), false);
  const invalid = await controller.getState('gpu:a');
  assert.equal(invalid.enabled, true);
  assert.equal(invalid.settings, null);
  assert.match(invalid.error, /apply/i);
});

test('a curve array with a contradictory confirmed mode is never captured', async () => {
  const { controller, saved } = fixture();
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  const fanCurve = [{ t: 30, speedPct: 25 }, { t: 90, speedPct: 85 }];
  await controller.noteApply(6, { fanMode: 'curve', fanCurve }, {
    result: { perControl: { fanMode: { ok: true }, fanCurve: { ok: true } } },
    state: { fanMode: 'auto', fanCurve },
  });
  assert.equal(saved.size, 0);
  assert.equal((await controller.getState(6, 'gpu:a')).settings, null);
});

test('duplicate physical restore rows block all writes and remain safely switchable off', async () => {
  const { controller, backend, saved, calls, rows } = fixture();
  rows[0].deviceKeys = ['gpu:a', 'gpu:alias'];
  const settings = { fanMode: 'auto' };
  saved.set('gpu:a', { deviceKey: 'gpu:a', physicalTarget: { bdf: '0000:00:02.0' }, settings });
  saved.set('gpu:alias', { deviceKey: 'gpu:alias', physicalTarget: { bdf: '0000:00:02.0' }, settings: { fanMode: 'fixed', fixedFanPct: 55 } });
  backend.resolvePhysicalTarget = async (key, proof) => {
    if (!rows[0].deviceKeys.includes(key) || proof.bdf !== '0000:00:02.0') throw new Error('physical proof mismatch');
    return rows[0];
  };
  await controller.initialize();
  const before = await controller.getState(6, 'gpu:a');
  assert.equal(before.enabled, true);
  assert.equal(before.state, 'unavailable');
  await controller.onResume();
  assert.equal(calls.length, 0);
  assert.match((await controller.getState(6, 'gpu:a')).error, /ambiguous/i);
  await controller.setEnabled({ enabled: false, deviceId: 6, deviceKey: 'gpu:a' });
  assert.equal(saved.size, 0);
  assert.equal((await controller.getState(6, 'gpu:a')).enabled, false);
});

test('enabling another GPU during backoff preserves the existing GPU resume', async () => {
  let releaseDelay;
  const delayed = new Promise(resolve => { releaseDelay = resolve; });
  const { controller, rows, backend, calls } = fixture({ delayImpl: () => delayed });
  rows.push({ id: 7, deviceKey: 'gpu:b', bdf: '00:03.0', backendId: 3 });
  const originalAssert = backend.assertDeviceTarget;
  backend.assertDeviceTarget = async (id, key, proof) => {
    if (id === 7 && key === 'gpu:b' && proof.bdf === '0000:00:03.0') return;
    return originalAssert(id, key, proof);
  };
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  const resume = controller.onResume();
  await new Promise(resolve => setImmediate(resolve));
  await controller.setEnabled({ enabled: true, deviceId: 7, deviceKey: 'gpu:b' });
  releaseDelay();
  await resume;
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 6);
});

test('OFF removes the opted-in alias after its invalidated sidecar row has been removed', async () => {
  const { controller, rows } = fixture();
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await controller.noteApply(6, { fanMode: 'auto' }, { result: { perControl: { fanMode: { ok: false } } } });
  rows[0] = { ...rows[0], deviceKey: 'gpu:refined', deviceKeys: ['gpu:a', 'gpu:refined'] };
  await controller.setEnabled({ enabled: false, deviceId: 6, deviceKey: 'gpu:refined' });
  assert.equal((await controller.getState(6, 'gpu:refined')).enabled, false);
  assert.equal((await controller.getState('gpu:a')).enabled, false);
});

test('a thrown user fan apply invalidates its saved record and preserves the original error', async () => {
  const original = new Error('apply runner failed');
  const { controller, saved } = fixture({ throwApply: original });
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await assert.rejects(controller.runUserApply([6, { fanMode: 'curve', fanCurve: [{ t: 30, speedPct: 25 }, { t: 90, speedPct: 85 }] }]), (error) => error === original);
  assert.equal(saved.has('gpu:a'), false);
});

test('failed sidecar invalidation blocks resume in memory while preserving the enabled preference', async () => {
  const { controller, saved, calls } = fixture({ removeFailure: true });
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  await controller.noteApply(6, { fanMode: 'curve', fanCurve: [{ t: 30, speedPct: 25 }, { t: 90, speedPct: 85 }] }, {
    result: { perControl: { fanMode: { ok: true }, fanCurve: { ok: false, errorCode: 'io-failed' } } },
  });
  assert.equal(saved.has('gpu:a'), true);
  await controller.onResume();
  assert.equal(calls.length, 0);
  assert.equal((await controller.getState(6, 'gpu:a')).enabled, true);
});

test('real retry timer is cleared by OFF', async () => {
  const { controller, calls } = fixture({ delayImpl: null, timers: [30_000] });
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  controller.onResume();
  await new Promise((resolve) => setImmediate(resolve));
  await controller.setEnabled({ enabled: false, deviceId: 6, deviceKey: 'gpu:a' });
  assert.equal(calls.length, 0);
});

test('PCI to PNP refinement follows a unique physical alias; mismatched proof is rejected', async () => {
  const { controller, saved, rows } = fixture();
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  Object.assign(rows[0], {
    deviceKey: 'gpu:pnp', deviceKeys: ['gpu:a', 'gpu:pnp'],
    pnpDeviceId: 'PCI\\VEN_8086&DEV_1234&SUBSYS_00000000',
  });
  assert.equal((await controller.getState(6, 'gpu:pnp')).enabled, true);
  const curve = [{ t: 30, speedPct: 25 }, { t: 90, speedPct: 85 }];
  await controller.noteApply(6, { fanCurve: curve }, {
    result: { perControl: { fanCurve: { ok: true } } },
    state: { fanMode: 'curve', fanCurve: curve },
  });
  assert.equal(saved.get('gpu:a').physicalTarget.pnpDeviceId, 'PCI\\VEN_8086&DEV_1234&SUBSYS_00000000');
  Object.assign(rows[0], { pnpDeviceId: 'PCI\\VEN_8086&DEV_9999&SUBSYS_00000000' });
  const ambiguous = await controller.getState(6, 'gpu:pnp');
  assert.equal(ambiguous.enabled, true);
  assert.equal(ambiguous.state, 'unavailable');
  await controller.setEnabled({ enabled: false, deviceId: 6, deviceKey: 'gpu:pnp' });
  assert.equal((await controller.getState(6, 'gpu:pnp')).enabled, false);
});

test('OFF through the refined key removes the uniquely matched original sidecar row', async () => {
  const { controller, saved, rows } = fixture();
  await controller.setEnabled({ enabled: true, deviceId: 6, deviceKey: 'gpu:a' });
  Object.assign(rows[0], { deviceKey: 'gpu:pnp', deviceKeys: ['gpu:a', 'gpu:pnp'] });
  await controller.setEnabled({ enabled: false, deviceId: 6, deviceKey: 'gpu:pnp' });
  assert.equal(saved.has('gpu:a'), false);
});

test('a saved PNP key can match a current PCI-only row only through unique physical resolution', async () => {
  const { controller, store, backend } = fixture();
  const proof = { pnpDeviceId: 'PCI\\VEN_8086&DEV_1234', pciVendorId: '8086', pciDeviceId: '1234', bdf: '0000:00:02.0' };
  await store.set({ deviceKey: 'gpu:pnp', physicalTarget: proof, settings: { fanMode: 'auto' } });
  backend.resolvePhysicalTarget = async (key, savedProof) => {
    if (key !== 'gpu:pnp' || savedProof.pciDeviceId !== '1234') throw new Error('no unique physical match');
    return { id: 6 };
  };
  await controller.initialize();
  assert.equal((await controller.getState(6, 'gpu:a')).enabled, true);
  backend.resolvePhysicalTarget = async () => ({ id: 7 });
  assert.equal((await controller.getState(6, 'gpu:a')).enabled, false);
});
