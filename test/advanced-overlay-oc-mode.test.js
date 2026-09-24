import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createIpcHandlers } from '../src/main/ipc-core.js';
import { deviceGateThresholds, extendedRangesFor, ocModeRefusal, splitByRuntime, OC_MODE_ADVANCED } from '../src/main/apply-routing.js';

const overlay = fs.readFileSync(
  fileURLToPath(new URL('../src/renderer/advanced-overlay.ts', import.meta.url)),
  'utf8',
);
const styles = fs.readFileSync(
  fileURLToPath(new URL('../src/renderer/advanced-overlay.css', import.meta.url)),
  'utf8',
);
const app = fs.readFileSync(
  fileURLToPath(new URL('../src/renderer/app.ts', import.meta.url)),
  'utf8',
);
const ipc = fs.readFileSync(
  fileURLToPath(new URL('../src/main/ipc.js', import.meta.url)),
  'utf8',
);
const preload = fs.readFileSync(
  fileURLToPath(new URL('../src/preload.cjs', import.meta.url)),
  'utf8',
);
const ipcCore = fs.readFileSync(
  fileURLToPath(new URL('../src/main/ipc-core.js', import.meta.url)),
  'utf8',
);
const tuning = fs.readFileSync(
  fileURLToPath(new URL('../src/renderer/pages/tuning.ts', import.meta.url)),
  'utf8',
);

test('Advanced Overlay exposes the Alchemist Stock/Advanced mode flow', () => {
  assert.match(overlay, /isAlchemistGpuName\(caps\.deviceName, caps\)/);
  assert.match(overlay, /showAdvancedModeConfirm\(caps\.deviceName \|\| 'this GPU'\)/);
  assert.match(overlay, /api\.advancedModeAcceptedGet\(\)/);
  assert.match(overlay, /api\.advancedModeAcceptedSet\(\)/);
  assert.match(overlay, /api\.ocModeSet\(mode, deviceId, deviceKey\)/);
  assert.match(overlay, /api\.ocModeSet\(previousMode, deviceId, deviceKey, mode\)/);
  assert.match(overlay, /api\.getCapabilities\(deviceId\)/);
  assert.match(overlay, /api\.getCurrentSettings\(deviceId\)/);
  assert.match(overlay, /api\.onOcModeUpdated\(/);
  assert.match(overlay, /const appliedMode = freshCaps\.ocMode === 'advanced' \|\| freshCaps\.ocMode === 'stock'/);
  assert.match(overlay, /button\.setAttribute\('aria-pressed', String\(selected\)\)/);
  assert.match(overlay, /if \(activeTab === 'tuning' && panelIdentityMatches\(deviceId, deviceKey, generation\)\)/);
  assert.match(overlay, /ocModeChangeBusy/);
  assert.match(overlay, /adv-oc-mode-btn/);
  assert.match(styles, /\.adv-oc-mode-btn\.active/);
});

test('Advanced Overlay carries the selected mode from capability snapshots', () => {
  assert.match(overlay, /ocMode: pushed\.caps\.ocMode === 'advanced' \? 'advanced' : 'stock'/);
  assert.match(overlay, /ocMode: caps\?\.ocMode === 'advanced' \? 'advanced' : 'stock'/);
  assert.match(overlay, /ocMode: payload\.caps\.ocMode === 'advanced' \|\| payload\.caps\.ocMode === 'stock'/);
});

test('OC mode readback is broadcast to both renderer tuning surfaces', () => {
  assert.match(app, /ocMode: payload\.caps\.ocMode === 'advanced' \|\| payload\.caps\.ocMode === 'stock'/);
  assert.match(app, /api\.onOcModeUpdated\(/);
  assert.match(app, /caps: payload\.caps,/);
  assert.match(app, /state: payload\.state,/);
  assert.match(app, /const ocModeRefreshRevisions = new Map<string, number>\(\)/);
  assert.match(app, /payload\.revision <= lastRevision/);
  assert.match(ipc, /channel === 'oc-mode-set'/);
  assert.match(ipc, /OC_MODE_UPDATED_CHANNEL/);
  assert.match(ipc, /target\.webContents\.send\(OC_MODE_UPDATED_CHANNEL, payload\)/);
  assert.match(ipc, /handlers\['get-capabilities'\]\(deviceId\)/);
  assert.match(ipc, /handlers\['get-current-settings'\]\(deviceId\)/);
  assert.match(preload, /onOcModeUpdated/);
  assert.match(preload, /ipcRenderer\.on\('oc-mode:updated'/);
  assert.match(ipcCore, /expectedDeviceKey = null/);
  assert.match(ipcCore, /device key mismatch/);
  assert.match(ipc, /caps = null;/);
  assert.match(ipc, /state = null;/);
  assert.match(ipc, /let ocModeSetQueue = Promise\.resolve\(\)/);
  assert.match(ipc, /let nextOcModeRevision = 0/);
  assert.match(ipc, /revision: ocModeRevision/);
  assert.match(ipc, /if \(channel === 'oc-mode-set'\) \{[\s\S]*?finally \{/);
  assert.match(ipc, /global oc-mode-set calls do not broadcast, but they still own the/);
  assert.match(app, /\(selected\?\.deviceKey \?\? null\) !== payload\.deviceKey/);
  assert.match(tuning, /toggleAttribute\('inert', fanSnapshotUnavailable\)/);
  assert.match(tuning, /api\.ocModeSet\(previousMode, deviceId, deviceKey, mode\)/);
  assert.match(ipcCore, /expectedCurrentMode = null/);
  assert.match(ipcCore, /current mode changed/);
});

test('OC mode writes reject stale physical identity and stale rollback mode', async () => {
  const target = { id: 0, deviceKey: 'pci:arc-test', name: 'Intel Arc A750' };
  const persisted = { ocMode: 'stock', ocModes: {} };
  let backendMode = 'stock';
  const { handlers } = createIpcHandlers({
    backend: {
      getDeviceTarget: async () => target,
      setOcMode: async (mode) => { backendMode = mode; },
    },
    store: {
      loadSettings: async () => ({ ...persisted, ocModes: { ...persisted.ocModes } }),
      saveSettings: async (next) => {
        Object.assign(persisted, next);
        persisted.ocModes = { ...(next.ocModes ?? {}) };
      },
    },
    emit: () => {},
  });

  await handlers['oc-mode-set']('advanced', 0, target.deviceKey, 'stock');
  assert.equal(backendMode, 'advanced');
  await assert.rejects(
    () => handlers['oc-mode-set']('stock', 0, target.deviceKey, 'stock'),
    /current mode changed/,
  );
  await assert.rejects(
    () => handlers['oc-mode-set']('stock', 0, 'pci:other-gpu', 'advanced'),
    /device key mismatch/,
  );
  assert.equal(backendMode, 'advanced');
});

test('A580 stock and Advanced wattage ceilings are explicit and keep the voltage floor unchanged', () => {
  const ranges = extendedRangesFor({
    pciDeviceId: '0x000056a2',
    ranges: {
      powerLimitW: { units: 'W', min: 50, max: 200 },
      tempLimitC: { units: 'C', min: 60, max: 90 },
      gpuVoltOffsetV: { units: 'V', min: -0.500, max: 0.234, step: 0.005 },
    },
  });
  assert.equal(ranges.powerLimitW.max, 300);
  assert.equal(ranges.tempLimitC.max, 115);
  assert.equal(ranges.gpuVoltOffsetV.min, -0.200, 'the existing routed negative-voltage safety floor remains intact');

  const unlisted = extendedRangesFor({
    pciDeviceId: '0x0000ffff',
    ranges: { powerLimitW: { units: 'W', min: 50, max: 200 } },
  });
  assert.equal(unlisted.powerLimitW.max, 315);
});

test('A580 gates at 180 W stock and allows up to 300 W Advanced', () => {
  const ranges = {
    powerLimitW: { units: 'W', min: 50, max: 300 },
    tempLimitC: { units: 'C', min: 60, max: 90 },
  };
  const a580 = { pciDeviceId: '0x000056a2' };
  assert.equal(deviceGateThresholds(a580, false, ranges).plMax, 180);
  assert.equal(deviceGateThresholds(a580, true, ranges).plMax, 300);
  assert.equal(ocModeRefusal('stock', { powerLimitW: 180 }, ranges, a580), null);
  assert.deepEqual(ocModeRefusal('stock', { powerLimitW: 181 }, ranges, a580)?.controls, ['powerLimitW']);
  assert.equal(ocModeRefusal('advanced', { powerLimitW: 300 }, ranges, a580), null);
  const refusal = ocModeRefusal('advanced', { powerLimitW: 301 }, ranges, a580);
  assert.deepEqual(refusal?.controls, ['powerLimitW']);
});

test('A580 Advanced routing changes at 180 W while other Alchemist routes keep their existing limits', () => {
  const ranges = { powerLimitW: { units: 'W' } };
  const a580 = { pciDeviceId: '0x000056a2' };
  assert.deepEqual(splitByRuntime({ powerLimitW: 180 }, ranges, OC_MODE_ADVANCED, null, a580), {
    driverstore: { powerLimitW: 180 }, extended: {},
  });
  for (const watts of [181, 210]) {
    assert.deepEqual(splitByRuntime({ powerLimitW: watts }, ranges, OC_MODE_ADVANCED, null, a580), {
      driverstore: {}, extended: { powerLimitW: watts },
    });
  }
  assert.deepEqual(splitByRuntime({ powerLimitW: 300 }, ranges, OC_MODE_ADVANCED, {}, a580), {
    driverstore: {}, extended: {},
  }, '300 W is left to the existing Sysman-primary path');

  const a380 = { pciDeviceId: '0x000056a5' };
  assert.equal(deviceGateThresholds(a380, false).plMax, 66);
  assert.equal(deviceGateThresholds(a380, true).plMax, 225);
  assert.deepEqual(splitByRuntime({ powerLimitW: 67 }, ranges, OC_MODE_ADVANCED, null, a380), {
    driverstore: {}, extended: { powerLimitW: 67 },
  });
  const a310 = { pciDeviceId: '0x000056a6' };
  assert.equal(deviceGateThresholds(a310, false).plMax, 75);
  assert.equal(deviceGateThresholds(a310, true).plMax, 75);
  assert.deepEqual(splitByRuntime({ powerLimitW: 75 }, ranges, OC_MODE_ADVANCED, null, a310), {
    driverstore: { powerLimitW: 75 }, extended: {},
  });
});
