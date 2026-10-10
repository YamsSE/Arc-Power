import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { runApplyWorker, validateWorkerResult } from '../src/main/apply-worker.js';
import { createUnifiedGpuBackend } from '../src/main/gpu-inventory.js';

async function withWorkerFiles(request, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-power-worker-test-'));
  const requestPath = path.join(directory, `arcpower-req-${request.requestId}.json`);
  const outputPath = path.join(directory, `arcpower-out-${request.requestId}.json`);
  const workerSecret = 'unit-test-worker-secret';
  const authenticatedRequest = {
    ...request,
    auth: createHmac('sha256', workerSecret).update(JSON.stringify(request)).digest('hex'),
  };
  try {
    await fs.writeFile(requestPath, JSON.stringify(authenticatedRequest), 'utf8');
    return await run({ requestPath, outputPath, directory, workerSecret });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function applyWorkerCaps() {
  return {
    overclockingSupported: true,
    extendedRanges: true,
    ranges: {
      gpuFreqOffsetMhz: { units: 'MHz', min: -300, max: 300, step: 1, default: 0 },
      powerLimitW: { units: 'W', min: 20, max: 375, step: 1, default: 200 },
      tempLimitC: { units: 'C', min: 50, max: 115, step: 1, default: 90 },
      gpuVoltOffsetV: { units: 'V', min: -0.2, max: 0.2, step: 0.001, default: 0 },
    },
    pciDeviceId: '0000:03:00.0',
    aibVendor: 'test',
    aibModel: 'test',
  };
}

function workerInventoryBackend(devices) {
  return createUnifiedGpuBackend({
    backend: {
      kind: 'igcl',
      async listDevices() { return devices; },
      async getGraphicsSettings() {
        return {
          supported: { frameLimit: true },
          frameLimitRange: { min: 30, max: 300, step: 1, default: 60 },
          values: { frameLimit: { enabled: false, value: 60 } },
        };
      },
    },
    videoControllers: [],
  });
}

test('apply worker routes game-profile writes with physical GPU proof', async () => {
  const target = {
    id: 1,
    deviceKey: 'pci:arc-a770-test',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0',
    synthetic: false,
  };
  const calls = [];
  const request = {
    requestId: 'worker-game-profile-success',
    op: 'game-profile-apply',
    deviceId: target.id,
    deviceKey: target.deviceKey,
    physicalTarget: { deviceKey: target.deviceKey, pnpDeviceId: target.pnpDeviceId },
    exePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe'),
    settings: { lowLatency: 'on' },
    enabled: true,
  };
  const result = await withWorkerFiles(request, async ({ requestPath, outputPath, workerSecret }) => {
    const exitCode = await runApplyWorker({
      reqPath: requestPath,
      outPath: outputPath,
      oldIgcl: {},
      workerSecret,
      backend: {
        async init() {},
        async getDeviceTarget(deviceId, deviceKey, physicalTarget) {
          assert.equal(deviceId, target.id);
          assert.equal(deviceKey, target.deviceKey);
          assert.deepEqual(physicalTarget, request.physicalTarget);
          return target;
        },
        async setGameProfileSettings(...args) {
          calls.push(args);
          return { ok: false, perControl: { lowLatency: { ok: false, errorCode: 'io-failed' } } };
        },
      },
    });
    return { exitCode, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.op, request.op);
  assert.equal(typeof result.output.auth, 'string');
  assert.equal(validateWorkerResult(result.output, {
    requestId: request.requestId,
    op: request.op,
    workerSecret: 'unit-test-worker-secret',
  }).ok, true);
  assert.equal(validateWorkerResult({ ...result.output, ok: true }, {
    requestId: request.requestId,
    op: request.op,
    workerSecret: 'unit-test-worker-secret',
  }).ok, false);
  assert.deepEqual(result.output.perControl, { lowLatency: { ok: false, errorCode: 'io-failed' } });
  assert.deepEqual(calls, [[target.id, request.exePath.toLowerCase(), request.settings, true]]);
});

test('apply worker resolves the selected target despite process-local GPU IDs', async (t) => {
  const pnp = 'PCI\\VEN_8086&DEV_56A0&SUBSYS_12345678';
  const pciKey = 'pci:0x8086:0x56a0@0000:03:00.0';
  const devices = [
    { id: 0, name: 'Other Intel Arc GPU', pciVendorId: '0x8086', pciDeviceId: '0x56a0', bdf: '0000:04:00.0' },
    { id: 1, name: 'Selected Intel Arc GPU', pciVendorId: '0x8086', pciDeviceId: '0x56a0', bdf: '0000:03:00.0' },
  ];
  const scenarios = [
    { name: 'reported PCI key', deviceKey: pciKey },
    { name: 'parent PNP key missing from worker aliases', deviceKey: `pnp:${pnp}` },
  ];

  for (const [index, scenario] of scenarios.entries()) {
    await t.test(scenario.name, async () => {
      const request = {
        requestId: `worker-local-id-remap-${index}`,
        op: 'graphics-apply',
        deviceId: 0,
        deviceKey: scenario.deviceKey,
        physicalTarget: {
          pnpDeviceId: pnp,
          pciVendorId: '0x8086',
          pciDeviceId: '0x56a0',
          bdf: '0000:03:00.0',
        },
        settings: { frameLimit: { enabled: true, value: 144 } },
      };
      const writes = [];
      const result = await withWorkerFiles(request, async ({ requestPath, outputPath, workerSecret }) => {
        const backend = workerInventoryBackend(devices);
        backend.setGraphicsSettings = async (id, settings) => {
          writes.push({ id, settings });
          return { ok: true, perControl: { frameLimit: { ok: true } } };
        };
        const exitCode = await runApplyWorker({ reqPath: requestPath, outPath: outputPath, backend, oldIgcl: {}, workerSecret });
        return { exitCode, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
      });

      assert.equal(result.exitCode, 0);
      assert.equal(result.output.ok, true);
      assert.deepEqual(writes, [{ id: 1, settings: request.settings }]);
    });
  }
});

test('apply worker rejects mismatched or ambiguous physical target before writing', async (t) => {
  const pnp = 'PCI\\VEN_8086&DEV_56A0&SUBSYS_12345678';
  const selected = { id: 1, name: 'Selected Intel Arc GPU', pciVendorId: '0x8086', pciDeviceId: '0x56a0', bdf: '0000:03:00.0' };
  const other = { id: 0, name: 'Other Intel Arc GPU', pciVendorId: '0x8086', pciDeviceId: '0x56a0', bdf: '0000:04:00.0' };
  const cases = [
    {
      name: 'mismatched proof',
      devices: [other, selected],
      physicalTarget: {
        pnpDeviceId: 'PCI\\VEN_1002&DEV_73BF&SUBSYS_12345678',
        pciVendorId: '0x1002',
        pciDeviceId: '0x73bf',
        bdf: '0000:03:00.0',
      },
    },
    {
      name: 'ambiguous physical match',
      devices: [other, selected, { ...selected, id: 2, name: 'Duplicate BDF GPU' }],
      physicalTarget: { pnpDeviceId: pnp, pciVendorId: '0x8086', pciDeviceId: '0x56a0', bdf: '0000:03:00.0' },
    },
    {
      name: 'synthetic parent proof matching a writable worker row',
      devices: [other, selected],
      physicalTarget: {
        deviceKey: `pnp:${pnp}`,
        pnpDeviceId: pnp,
        pciVendorId: '0x8086',
        pciDeviceId: '0x56a0',
        bdf: '0000:03:00.0',
        synthetic: true,
        backendKind: 'os',
      },
    },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(scenario.name, async () => {
      const request = {
        requestId: `worker-local-id-reject-${index}`,
        op: 'graphics-apply',
        deviceId: 0,
        deviceKey: `pnp:${pnp}`,
        physicalTarget: scenario.physicalTarget,
        settings: { frameLimit: { enabled: true, value: 144 } },
      };
      let writes = 0;
      const result = await withWorkerFiles(request, async ({ requestPath, outputPath, workerSecret }) => {
        const backend = workerInventoryBackend(scenario.devices);
        backend.setGraphicsSettings = async () => {
          writes += 1;
          return { ok: true, perControl: {} };
        };
        const exitCode = await runApplyWorker({ reqPath: requestPath, outPath: outputPath, backend, oldIgcl: {}, workerSecret });
        return { exitCode, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
      });

      assert.equal(result.exitCode, 1);
      assert.equal(result.output.ok, false);
      assert.equal(writes, 0);
    });
  }
});

test('apply worker rejects a stale physical game-profile target before writing', async () => {
  const request = {
    requestId: 'worker-game-profile-stale',
    op: 'game-profile-apply',
    deviceId: 0,
    deviceKey: 'pci:arc-b580-stale',
    physicalTarget: { deviceKey: 'pci:arc-b580-stale' },
    exePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe'),
    settings: { lowLatency: 'on' },
    enabled: true,
  };
  const result = await withWorkerFiles(request, async ({ requestPath, outputPath, workerSecret }) => {
    let writes = 0;
    const exitCode = await runApplyWorker({
      reqPath: requestPath,
      outPath: outputPath,
      oldIgcl: {},
      workerSecret,
      backend: {
        async init() {},
        async getDeviceTarget() { throw new Error('physical identity mismatch'); },
        async setGameProfileSettings() { writes += 1; return { ok: true, perControl: {} }; },
      },
    });
    return { exitCode, writes, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.writes, 0);
  assert.match(result.output.error, /stale or unsupported GPU target/);
});

test('apply worker honors a parent cancellation marker before a native write', async () => {
  const target = {
    id: 0,
    deviceKey: 'pci:arc-b580-test',
    pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0',
    synthetic: false,
  };
  const request = {
    requestId: 'worker-game-profile-canceled',
    op: 'game-profile-apply',
    deviceId: target.id,
    deviceKey: target.deviceKey,
    physicalTarget: { deviceKey: target.deviceKey, pnpDeviceId: target.pnpDeviceId },
    exePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe'),
    settings: { lowLatency: 'on' },
    enabled: true,
  };
  let releaseTarget;
  let targetStarted;
  const started = new Promise((resolve) => { targetStarted = resolve; });
  const targetGate = new Promise((resolve) => { releaseTarget = resolve; });
  const result = await withWorkerFiles(request, async ({ requestPath, outputPath, directory, workerSecret }) => {
    let writes = 0;
    const running = runApplyWorker({
      reqPath: requestPath,
      outPath: outputPath,
      workerSecret,
      oldIgcl: {},
      backend: {
        async init() {},
        async getDeviceTarget() {
          targetStarted();
          await targetGate;
          return target;
        },
        async getGraphicsSettings() { return { frameLimitRange: { min: 30, max: 300, step: 1, default: 60 } }; },
        async setGameProfileSettings() { writes += 1; return { ok: true, perControl: {} }; },
      },
    });
    await started;
    await fs.writeFile(path.join(directory, `arcpower-cancel-${request.requestId}.json`), JSON.stringify({ requestId: request.requestId, canceledAt: Date.now() }), 'utf8');
    releaseTarget();
    const exitCode = await running;
    return { exitCode, writes, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.writes, 0);
  assert.equal(result.output.canceled, true);
  assert.match(result.output.error, /parent process revoked/);
});

test('apply worker rejects a tampered authenticated request before any write', async () => {
  const request = {
    requestId: 'worker-game-profile-tampered',
    op: 'game-profile-apply',
    deviceId: 0,
    deviceKey: 'pci:arc-b580-test',
    physicalTarget: { deviceKey: 'pci:arc-b580-test', pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0' },
    exePath: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'notepad.exe'),
    settings: { lowLatency: 'on' },
    enabled: true,
  };
  const result = await withWorkerFiles(request, async ({ requestPath, outputPath, workerSecret }) => {
    const tampered = JSON.parse(await fs.readFile(requestPath, 'utf8'));
    tampered.deviceId = 99;
    await fs.writeFile(requestPath, JSON.stringify(tampered), 'utf8');
    let writes = 0;
    const exitCode = await runApplyWorker({
      reqPath: requestPath,
      outPath: outputPath,
      workerSecret,
      oldIgcl: {},
      backend: { async init() {}, async setGameProfileSettings() { writes += 1; return { ok: true, perControl: {} }; } },
    });
    return { exitCode, writes, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.writes, 0);
  assert.match(result.output.error, /authentication failed/);
});

test('apply worker checks cancellation immediately before the legacy IGCL writer', async () => {
  const request = {
    requestId: 'worker-oldigcl-canceled',
    op: 'apply',
    deviceId: 0,
    deviceKey: 'pci:arc-b580-test',
    physicalTarget: { deviceKey: 'pci:arc-b580-test', pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0' },
    ocMode: 'advanced',
    settings: { powerLimitW: 300 },
  };
  const result = await withWorkerFiles(request, async ({ requestPath, outputPath, directory, workerSecret }) => {
    let capabilityReads = 0;
    let writes = 0;
    const running = runApplyWorker({
      reqPath: requestPath,
      outPath: outputPath,
      workerSecret,
      sysmanPowerLimits: null,
      oldIgcl: {
        async isCapable() { return true; },
        isAvailable() { return true; },
        async setPowerLimitW() { writes += 1; return { ok: true, readBackEqual: true }; },
      },
      backend: {
        async init() {},
        async getCapabilities() {
          capabilityReads += 1;
          if (capabilityReads === 2) {
            await fs.writeFile(path.join(directory, `arcpower-cancel-${request.requestId}.json`), JSON.stringify({ requestId: request.requestId, canceledAt: Date.now() }), 'utf8');
          }
          return applyWorkerCaps();
        },
        async getCurrentSettings() { return {}; },
        async close() {},
      },
    });
    const exitCode = await running;
    return { exitCode, writes, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.writes, 0);
  assert.equal(result.output.canceled, true);
  assert.match(result.output.error, /parent process revoked/);
});

test('apply worker checks cancellation immediately before the Sysman writer', async () => {
  const request = {
    requestId: 'worker-sysman-canceled',
    op: 'apply',
    deviceId: 0,
    deviceKey: 'pci:arc-b580-test',
    physicalTarget: { deviceKey: 'pci:arc-b580-test', pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0' },
    ocMode: 'advanced',
    settings: { powerLimitW: 300 },
  };
  const result = await withWorkerFiles(request, async ({ requestPath, outputPath, directory, workerSecret }) => {
    let capabilityReads = 0;
    let writes = 0;
    const running = runApplyWorker({
      reqPath: requestPath,
      outPath: outputPath,
      workerSecret,
      oldIgcl: { async isCapable() { return true; }, isAvailable() { return true; } },
      sysmanPowerLimits: {
        async setLimits() { writes += 1; return { ok: true }; },
        async readLimits() { return { burstW: 300 }; },
      },
      backend: {
        async init() {},
        async getCapabilities() {
          capabilityReads += 1;
          if (capabilityReads === 2) {
            await fs.writeFile(path.join(directory, `arcpower-cancel-${request.requestId}.json`), JSON.stringify({ requestId: request.requestId, canceledAt: Date.now() }), 'utf8');
          }
          return applyWorkerCaps();
        },
        async getCurrentSettings() { return {}; },
        async close() {},
      },
    });
    const exitCode = await running;
    return { exitCode, writes, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.writes, 0);
  assert.equal(result.output.ok, false);
  assert.match(result.output.pl2Note.message, /parent process revoked/);
});

test('apply worker checks cancellation immediately before the backend bulk writer', async () => {
  const request = {
    requestId: 'worker-backend-canceled',
    op: 'apply',
    deviceId: 0,
    deviceKey: 'pci:arc-b580-test',
    physicalTarget: { deviceKey: 'pci:arc-b580-test', pnpDeviceId: 'PCI\\VEN_8086&DEV_56A0' },
    ocMode: 'advanced',
    settings: { gpuFreqOffsetMhz: 10 },
  };
  const result = await withWorkerFiles(request, async ({ requestPath, outputPath, directory, workerSecret }) => {
    let capabilityReads = 0;
    let writes = 0;
    const running = runApplyWorker({
      reqPath: requestPath,
      outPath: outputPath,
      workerSecret,
      oldIgcl: null,
      backend: {
        async init() {},
        async getCapabilities() {
          capabilityReads += 1;
          if (capabilityReads === 2) {
            await fs.writeFile(path.join(directory, `arcpower-cancel-${request.requestId}.json`), JSON.stringify({ requestId: request.requestId, canceledAt: Date.now() }), 'utf8');
          }
          return applyWorkerCaps();
        },
        async getCurrentSettings() { return {}; },
        async applySettings() { writes += 1; return { ok: true, perControl: { gpuFreqOffsetMhz: { ok: true, readBackEqual: true } } }; },
        async close() {},
      },
    });
    const exitCode = await running;
    return { exitCode, writes, output: JSON.parse(await fs.readFile(outputPath, 'utf8')) };
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.writes, 0);
  assert.equal(result.output.canceled, true);
  assert.match(result.output.error, /parent process revoked/);
});
