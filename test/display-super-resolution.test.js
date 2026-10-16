import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockBackend } from '../src/main/backend/mock-backend.js';
import { sanitizeDisplaySettings } from '../src/main/ipc-core.js';
import { IgclBackend } from '../src/main/backend/igcl-backend.js';
import { CTL_CUSTOM_MODE_OPERATION } from '../src/main/backend/igcl-bindings.js';
import {
  buildDisplaySettings,
  isDisplayControlDirty,
  isDisplayControlSupported,
  normalizeDisplaySettings,
  scalingMethodViewOf,
  scalingMethodOptionsForView,
  scalingModeViewOptionsForDisplay,
  superResolutionSourceModesForDisplay,
  validateDisplaySettings,
} from '../src/renderer/pure/display.ts';
import { validateDisplaySuperResolutionCapability } from '../src/main/ipc-core.js';

function createDisplayMock() {
  const featureset = JSON.parse(fs.readFileSync(new URL('../mock/featuresets/b580.json', import.meta.url), 'utf8'));
  return new MockBackend({ featureset });
}

test('Display Supernative Resolution mock exposes a verified desktop/game source-mode round trip', async () => {
  const backend = createDisplayMock();
  const before = await backend.getDisplaySettings(0);
  const display = before.displays[0];
  assert.equal(isDisplayControlSupported(display, 'superResolution'), true);
  assert.deepEqual(normalizeDisplaySettings(display).superResolution, { enabled: false });

  const target = display.superResolution.presets[0];
  assert.equal(validateDisplaySuperResolutionCapability({
    superResolution: { enabled: true, width: target.width, height: target.height, refreshRate: target.refreshRate },
  }, before, display.displayKey).ok, true);
  const applied = await backend.setDisplaySettings(0, {
    deviceKey: before.deviceKey,
    displayKey: display.displayKey,
    patch: { superResolution: { enabled: true, width: target.width, height: target.height, refreshRate: target.refreshRate } },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.perControl.superResolution.readBackEqual, true);

  const enabled = (await backend.getDisplaySettings(0)).displays[0];
  assert.equal(enabled.superResolution.enabled, true);
  assert.deepEqual(enabled.superResolution.currentSourceResolution, { width: target.width, height: target.height });
  assert.deepEqual(normalizeDisplaySettings(enabled).superResolution, {
    enabled: true,
    width: target.width,
    height: target.height,
    refreshRate: target.refreshRate,
  });

  const restored = await backend.setDisplaySettings(0, {
    deviceKey: before.deviceKey,
    displayKey: display.displayKey,
    patch: { superResolution: { enabled: false } },
  });
  assert.equal(restored.ok, true);
  assert.equal((await backend.getDisplaySettings(0)).displays[0].superResolution.enabled, false);
});

test('Display Supernative Resolution stays capability-gated and rejects unlisted modes', async () => {
  const backend = createDisplayMock();
  const before = await backend.getDisplaySettings(0);
  const display = before.displays[0];
  assert.equal(validateDisplaySettings({ superResolution: { enabled: true, width: 3333, height: 2222, refreshRate: 144 } }, display), false);
  assert.deepEqual(sanitizeDisplaySettings({ superResolution: { enabled: false, width: 1, height: 1 } }), { superResolution: { enabled: false } });
  assert.deepEqual(sanitizeDisplaySettings({ superResolution: { enabled: true, width: 3333, height: 2222, refreshRate: 144 } }), {
    superResolution: { enabled: true, width: 3333, height: 2222, refreshRate: 144 },
  });

  const out = await backend.setDisplaySettings(0, {
    deviceKey: before.deviceKey,
    displayKey: display.displayKey,
    patch: { superResolution: { enabled: true, width: 3333, height: 2222, refreshRate: 144 } },
  });
  assert.equal(out.ok, false);
  assert.equal(out.perControl.superResolution.errorCode, 'unsupported');
  assert.equal((await backend.getDisplaySettings(0)).displays[0].superResolution.enabled, false);
  assert.equal(validateDisplaySuperResolutionCapability({
    superResolution: { enabled: true, width: 3333, height: 2222, refreshRate: 144 },
  }, before, display.displayKey).ok, false);
});

test('IgclBackend Supernative Resolution verifies and restores the Windows source mode transaction', async () => {
  const customModes = [];
  let mismatchTargetRefresh = false;
  let current = { width: 1920, height: 1080, refreshRate: 144 };
  const modeList = [
    { width: 1920, height: 1080, refreshRate: 144 },
    { width: 2560, height: 1440, refreshRate: 144 },
  ];
  const controller = {
    resolve(request = {}) {
      return {
        ok: true,
        supported: true,
        output: { deviceName: 'DISPLAY1', currentMode: { ...current }, modes: modeList.map((mode) => ({ ...mode })) },
      };
    },
    apply(request) {
      const wrongRefresh = mismatchTargetRefresh && request.resolution.width === 2560;
      current = { ...request.resolution, refreshRate: request.refreshRate + (wrongRefresh ? 5 : 0) };
      return { ok: true, supported: true, deviceName: 'DISPLAY1', mode: { ...current } };
    },
    restore() {
      current = { width: 1920, height: 1080, refreshRate: 144 };
      return { ok: true, supported: true, deviceName: 'DISPLAY1', mode: { ...current } };
    },
  };
  const backend = Object.create(IgclBackend.prototype);
  backend._displayModeController = controller;
  backend._superResolutionBaseByDisplay = new Map([['display-0', { resolution: { width: 1920, height: 1080 }, refreshRate: 144 }]]);
  backend._superResolutionAddedModes = new Map();
  backend._superResolutionVerdicts = new Map();
  backend._customSourceModesOf = () => ({ supported: true, ok: true, modes: customModes.map((mode) => ({ SourceX: mode.width, SourceY: mode.height })) });
  backend._changeCustomSourceModes = (_handle, operation, modes) => {
    if (operation === CTL_CUSTOM_MODE_OPERATION.ADD) customModes.push(...modes);
    if (operation === CTL_CUSTOM_MODE_OPERATION.REMOVE) {
      for (const mode of modes) {
        const index = customModes.findIndex((candidate) => candidate.width === mode.width && candidate.height === mode.height);
        if (index >= 0) customModes.splice(index, 1);
      }
    }
    return { ok: true, supported: true };
  };
  const display = {
    displayKey: 'display-0',
    name: 'Test Display',
    resolution: { width: 1920, height: 1080 },
    refreshRate: 144,
    superResolution: {
      nativeResolution: { width: 1920, height: 1080 },
      nativeRefreshRate: 144,
    },
  };
  const enabled = await backend._applySuperResolution(null, display, { enabled: true, width: 2560, height: 1440, refreshRate: 144 });
  assert.equal(enabled.ok, true);
  assert.deepEqual(current, { width: 2560, height: 1440, refreshRate: 144 });
  assert.deepEqual(customModes, [{ width: 2560, height: 1440 }]);

  const disabled = await backend._applySuperResolution(null, { ...display, resolution: { width: 2560, height: 1440 }, refreshRate: 144 }, { enabled: false });
  assert.equal(disabled.ok, true);
  assert.deepEqual(current, { width: 1920, height: 1080, refreshRate: 144 });
  assert.deepEqual(customModes, []);

  const unavailableRefresh = await backend._applySuperResolution(null, display, {
    enabled: true,
    width: 2560,
    height: 1440,
    refreshRate: 120,
  });
  assert.equal(unavailableRefresh.ok, false);
  assert.equal(unavailableRefresh.errorCode, 'unsupported');
  assert.deepEqual(current, { width: 1920, height: 1080, refreshRate: 144 });
  assert.deepEqual(customModes, []);

  mismatchTargetRefresh = true;
  const mismatched = await backend._applySuperResolution(null, display, { enabled: true, width: 2560, height: 1440, refreshRate: 144 });
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.errorCode, 'io-failed');
  assert.deepEqual(current, { width: 1920, height: 1080, refreshRate: 144 });
  assert.deepEqual(customModes, []);
});

test('IgclBackend retains a retryable cleanup state when rollback cleanup is refused', async () => {
  const customModes = [];
  let current = { width: 1920, height: 1080, refreshRate: 144 };
  const controller = {
    resolve() {
      return {
        ok: true,
        supported: true,
        output: {
          deviceName: 'DISPLAY1',
          currentMode: { ...current },
          modes: [
            { width: 1920, height: 1080, refreshRate: 144 },
            { width: 2560, height: 1440, refreshRate: 144 },
          ],
        },
      };
    },
    apply(request) {
      current = {
        ...request.resolution,
        refreshRate: request.resolution.width === 2560 ? request.refreshRate + 5 : request.refreshRate,
      };
      return { ok: true, mode: { ...current } };
    },
  };
  const backend = Object.create(IgclBackend.prototype);
  backend._displayModeController = controller;
  backend._superResolutionBaseByDisplay = new Map([['display-cleanup', { resolution: { width: 1920, height: 1080 }, refreshRate: 144 }]]);
  backend._superResolutionAddedModes = new Map();
  backend._superResolutionVerdicts = new Map();
  backend._customSourceModesOf = () => ({ supported: true, ok: true, modes: customModes.map((mode) => ({ SourceX: mode.width, SourceY: mode.height })) });
  backend._changeCustomSourceModes = (_handle, operation, modes) => {
    if (operation === CTL_CUSTOM_MODE_OPERATION.ADD) customModes.push(...modes);
    if (operation === CTL_CUSTOM_MODE_OPERATION.REMOVE) return { ok: false, errorCode: 'io-failed', message: 'driver refused cleanup' };
    return { ok: true, supported: true };
  };
  const display = {
    displayKey: 'display-cleanup',
    name: 'Test Display',
    resolution: { width: 1920, height: 1080 },
    refreshRate: 144,
    superResolution: { nativeResolution: { width: 1920, height: 1080 }, nativeRefreshRate: 144 },
  };
  const result = await backend._applySuperResolution(null, display, { enabled: true, width: 2560, height: 1440, refreshRate: 144 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'cleanup-pending');
  assert.deepEqual(current, { width: 1920, height: 1080, refreshRate: 144 });
  assert.deepEqual(customModes, [{ width: 2560, height: 1440 }]);
  assert.deepEqual(backend._superResolutionAddedModes.get('display-cleanup'), [{ width: 2560, height: 1440 }]);
});

test('IgclBackend does not trust custom-mode removal without read-back', async () => {
  const customModes = [{ width: 2560, height: 1440 }];
  let current = { width: 2560, height: 1440, refreshRate: 144 };
  const controller = {
    resolve() {
      return {
        ok: true,
        supported: true,
        output: {
          deviceName: 'DISPLAY1',
          currentMode: { ...current },
          modes: [
            { width: 1920, height: 1080, refreshRate: 144 },
            { width: 2560, height: 1440, refreshRate: 144 },
          ],
        },
      };
    },
    restore() {
      current = { width: 1920, height: 1080, refreshRate: 144 };
      return { ok: true, mode: { ...current } };
    },
    apply() {
      return { ok: true, mode: { ...current } };
    },
  };
  const backend = Object.create(IgclBackend.prototype);
  backend._displayModeController = controller;
  backend._superResolutionBaseByDisplay = new Map([['display-cleanup-readback', {
    resolution: { width: 1920, height: 1080 },
    refreshRate: 144,
  }]]);
  backend._superResolutionAddedModes = new Map([['display-cleanup-readback', [{ width: 2560, height: 1440 }]]]);
  backend._superResolutionVerdicts = new Map();
  backend._customSourceModesOf = () => ({
    supported: true,
    ok: true,
    modes: customModes.map((mode) => ({ SourceX: mode.width, SourceY: mode.height })),
  });
  backend._changeCustomSourceModes = () => ({ ok: true, supported: true });

  const result = await backend._applySuperResolution(null, {
    displayKey: 'display-cleanup-readback',
    name: 'Test Display',
    resolution: { width: 2560, height: 1440 },
    refreshRate: 144,
    superResolution: { nativeResolution: { width: 1920, height: 1080 }, nativeRefreshRate: 144 },
  }, { enabled: false });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'cleanup-pending');
  assert.deepEqual(current, { width: 1920, height: 1080, refreshRate: 144 });
  assert.deepEqual(customModes, [{ width: 2560, height: 1440 }]);
});

test('IgclBackend restores a persisted desktop baseline after a process restart', async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arc-power-supernative-'));
  const stateFile = path.join(tempDirectory, 'state.json');
  const displayKey = 'adapter|display|MONITOR-A';
  fs.writeFileSync(stateFile, JSON.stringify({
    version: 1,
    displays: {
      'MONITOR-A': {
        active: true,
        nativeResolution: { width: 1920, height: 1080 },
        nativeRefreshRate: 60,
        initialMode: { width: 1280, height: 720, refreshRate: 180 },
        windowsIdentity: 'MONITOR-A',
        addedModes: [{ width: 2560, height: 1440 }],
      },
    },
  }));
  let current = { width: 2560, height: 1440, refreshRate: 180 };
  const customModes = [{ width: 2560, height: 1440 }];
  const controller = {
    resolve() {
      return {
        ok: true,
        supported: true,
        output: {
          deviceName: 'DISPLAY1',
          displayIdentity: 'MONITOR-A',
          currentMode: { ...current },
          modes: [
            { width: 1280, height: 720, refreshRate: 180 },
            { width: 1920, height: 1080, refreshRate: 180 },
            { width: 2560, height: 1440, refreshRate: 180 },
          ],
        },
      };
    },
    apply(request) {
      current = { ...request.resolution, refreshRate: request.refreshRate };
      return { ok: true, mode: { ...current } };
    },
    restore() {
      return { ok: false, errorCode: 'no-captured-mode', message: 'fresh process' };
    },
  };
  try {
    const backend = new IgclBackend({ lib: {}, superResolutionStateFile: stateFile });
    backend._displayModeController = controller;
    backend._readDisplayEncoderId = () => 'MONITOR-A';
    backend._customSourceModesOf = () => ({
      supported: true,
      ok: true,
      modes: customModes.map((mode) => ({ SourceX: mode.width, SourceY: mode.height })),
    });
    backend._changeCustomSourceModes = (_handle, operation, modes) => {
      if (operation === CTL_CUSTOM_MODE_OPERATION.REMOVE) {
        for (const mode of modes) {
          const index = customModes.findIndex((candidate) => candidate.width === mode.width && candidate.height === mode.height);
          if (index >= 0) customModes.splice(index, 1);
        }
      }
      return { ok: true, supported: true };
    };
    const display = {
      displayKey,
      name: 'Test Display',
      resolution: { width: 2560, height: 1440 },
      refreshRate: 180,
    };
    const capability = await backend._readSuperResolutionOutput(display, null, { width: 1920, height: 1080, refreshRate: 60 });
    assert.deepEqual(capability.nativeResolution, { width: 1920, height: 1080 });
    assert.equal(capability.enabled, true);

    const restored = await backend._applySuperResolution(null, display, { enabled: false });
    assert.equal(restored.ok, true);
    assert.deepEqual(current, { width: 1280, height: 720, refreshRate: 180 });
    assert.deepEqual(customModes, []);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).displays, {});
  } finally {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('IgclBackend retains a custom mode when the IGCL output identity changes mid-transaction', async () => {
  const customModes = [];
  let encoderReads = 0;
  let current = { width: 1920, height: 1080, refreshRate: 144 };
  const controller = {
    resolve() {
      return {
        ok: true,
        supported: true,
        output: {
          deviceName: 'DISPLAY1',
          displayIdentity: 'MONITOR-A',
          currentMode: { ...current },
          modes: [
            { width: 1920, height: 1080, refreshRate: 144 },
            { width: 2560, height: 1440, refreshRate: 144 },
          ],
        },
      };
    },
    apply() {
      return { ok: true, mode: { ...current } };
    },
  };
  const backend = Object.create(IgclBackend.prototype);
  backend._displayModeController = controller;
  backend._superResolutionBaseByDisplay = new Map([['adapter|display|ENCODER-A', {
    nativeResolution: { width: 1920, height: 1080 },
    nativeRefreshRate: 144,
    initialMode: { width: 1920, height: 1080, refreshRate: 144 },
    resolution: { width: 1920, height: 1080 },
    refreshRate: 144,
  }]]);
  backend._superResolutionAddedModes = new Map();
  backend._superResolutionVerdicts = new Map();
  backend._superResolutionWindowsIdentityByDisplay = new Map();
  backend._customSourceModesOf = () => ({
    supported: true,
    ok: true,
    modes: customModes.map((mode) => ({ SourceX: mode.width, SourceY: mode.height })),
  });
  backend._changeCustomSourceModes = (_handle, operation, modes) => {
    if (operation === CTL_CUSTOM_MODE_OPERATION.ADD) customModes.push(...modes);
    return { ok: true, supported: true };
  };
  backend._readDisplayEncoderId = () => {
    encoderReads += 1;
    return encoderReads === 1 ? 'ENCODER-A' : 'ENCODER-B';
  };
  backend._readDisplayEdid = async () => ({ data: Buffer.alloc(128), size: 128 });

  const result = await backend._applySuperResolution(null, {
    displayKey: 'adapter|display|ENCODER-A',
    name: 'Test Display',
    resolution: { width: 1920, height: 1080 },
    refreshRate: 144,
  }, { enabled: true, width: 2560, height: 1440, refreshRate: 144 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'cleanup-pending');
  assert.deepEqual(customModes, [{ width: 2560, height: 1440 }]);
  assert.deepEqual(backend._superResolutionAddedModes.get('adapter|display|ENCODER-A'), [{ width: 2560, height: 1440 }]);
});

test('IgclBackend keeps ownership state when identity changes after custom-mode removal', async () => {
  const customModes = [{ width: 2560, height: 1440 }];
  let encoderReads = 0;
  let current = { width: 2560, height: 1440, refreshRate: 144 };
  const controller = {
    resolve() {
      return {
        ok: true,
        supported: true,
        output: {
          deviceName: 'DISPLAY1',
          displayIdentity: 'MONITOR-A',
          currentMode: { ...current },
          modes: [
            { width: 1920, height: 1080, refreshRate: 144 },
            { width: 2560, height: 1440, refreshRate: 144 },
          ],
        },
      };
    },
    apply() {
      return { ok: true, mode: { ...current } };
    },
    restore() {
      current = { width: 1920, height: 1080, refreshRate: 144 };
      return { ok: true, mode: { ...current } };
    },
  };
  const displayKey = 'adapter|display|ENCODER-A';
  const backend = Object.create(IgclBackend.prototype);
  backend._displayModeController = controller;
  backend._superResolutionBaseByDisplay = new Map([[displayKey, {
    nativeResolution: { width: 1920, height: 1080 },
    nativeRefreshRate: 144,
    initialMode: { width: 1920, height: 1080, refreshRate: 144 },
    resolution: { width: 1920, height: 1080 },
    refreshRate: 144,
  }]]);
  backend._superResolutionAddedModes = new Map([[displayKey, [{ width: 2560, height: 1440 }]]]);
  backend._superResolutionVerdicts = new Map();
  backend._superResolutionWindowsIdentityByDisplay = new Map();
  backend._customSourceModesOf = () => ({
    supported: true,
    ok: true,
    modes: customModes.map((mode) => ({ SourceX: mode.width, SourceY: mode.height })),
  });
  backend._changeCustomSourceModes = (_handle, operation, modes) => {
    if (operation === CTL_CUSTOM_MODE_OPERATION.REMOVE) customModes.splice(0, modes.length);
    return { ok: true, supported: true };
  };
  backend._readDisplayEncoderId = () => {
    encoderReads += 1;
    return encoderReads === 1 ? 'ENCODER-A' : 'ENCODER-B';
  };

  const result = await backend._applySuperResolution(null, {
    displayKey,
    name: 'Test Display',
    resolution: { width: 2560, height: 1440 },
    refreshRate: 144,
  }, { enabled: false });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'cleanup-pending');
  assert.deepEqual(customModes, []);
  assert.deepEqual(backend._superResolutionAddedModes.get(displayKey), [{ width: 2560, height: 1440 }]);
});

test('IgclBackend serializes display writes for one verified output', async () => {
  const backend = Object.create(IgclBackend.prototype);
  backend._displayApplyLocks = new Map();
  let active = 0;
  let maximumActive = 0;
  backend._setDisplaySettingsUnlocked = async (_deviceId, request) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { ok: true, request };
  };
  await Promise.all([
    backend.setDisplaySettings(0, { deviceKey: 'adapter', displayKey: 'display' }),
    backend.setDisplaySettings(0, { deviceKey: 'adapter', displayKey: 'display' }),
  ]);
  assert.equal(maximumActive, 1);
});

test('each Display control uses a verified mock target and returns a fresh matching read-back', async () => {
  const cases = [
    ['quantizationRange', { quantizationRange: 'full' }, (d) => d.quantizationRange === 'full'],
    ['wireFormat', { wireFormat: { model: 'YCbCr444', depth: 10 } }, (d) => d.colorFormat === 'YCbCr444' && d.colorDepth === 10],
    ['wireFormat', { wireFormat: { model: 'RGB', depth: 8 } }, (d) => d.colorFormat === 'RGB' && d.colorDepth === 8],
    ['scalingMode', { scalingMode: 'stretched' }, (d) => d.scalingMode === 'stretched'],
    ['displayScalingMethod', { scalingMode: 'custom', displayScalingMethod: 'custom', scalingCustom: { x: 90, y: 90, hardwareModeSet: true } }, (d) => d.scalingMode === 'custom'],
    ['scalingMethod', { scalingMode: 'identity', displayScalingMethod: 'nearest-neighbour', scalingMethod: { enabled: true, method: 'nearest-neighbour' } }, (d) => d.scalingMethod.value.method === 'nearest-neighbour'],
    ['globalVrrMode', { globalVrrMode: 'disabled' }, (d) => d.globalVrrMode.value === 'disabled'],
    ['variableRefreshRate', { variableRefreshRate: false }, (d) => d.variableRefreshRate.value === false],
    ['vrrMode', { vrrMode: 'off' }, (d) => d.vrrMode.value === 'off'],
    ['superResolution', null, (d) => d.superResolution.enabled === true],
    ['hue', { hue: 12 }, (d) => d.hue.value === 12],
    ['saturation', { saturation: 1.2 }, (d) => d.saturation.value === 1.2],
    ['brightness', { brightness: 20 }, (d) => d.brightness.value === 20],
    ['contrast', { contrast: 1.3 }, (d) => d.contrast.value === 1.3],
  ];
  for (const [control, requested, matches] of cases) {
    const backend = createDisplayMock();
    const before = await backend.getDisplaySettings(0);
    const display = before.displays[0];
    assert.equal(isDisplayControlSupported(display, control), true, `${control} capability`);
    const mode = superResolutionSourceModesForDisplay(display)[0];
    const patch = requested ?? { superResolution: { enabled: true, width: mode.width, height: mode.height, refreshRate: mode.refreshRate } };
    assert.equal(validateDisplaySettings(patch, display), true, `${control} payload validation`);
    const result = await backend.setDisplaySettings(0, {
      deviceKey: before.deviceKey,
      displayKey: display.displayKey,
      patch,
    });
    assert.equal(result.perControl[control]?.ok, true, `${control} mock apply`);
    assert.equal(result.perControl[control]?.readBackEqual, true, `${control} mock backend read-back`);
    const fresh = (await backend.getDisplaySettings(0)).displays[0];
    assert.equal(matches(fresh), true, `${control} fresh GET`);
  }
});

test('color and wire controls participate in normalization, dirty checks, and global payloads', async () => {
  const state = await createDisplayMock().getDisplaySettings(0);
  const display = state.displays[0];
  const draft = normalizeDisplaySettings(display);
  assert.deepEqual(draft.wireFormat, { model: 'RGB', depth: 10 });
  for (const key of ['hue', 'saturation', 'brightness', 'contrast']) {
    assert.equal(typeof draft[key], 'number', `${key} normalized`);
  }
  Object.assign(draft, {
    wireFormat: { model: 'YCbCr444', depth: 8 },
    hue: 12,
    saturation: 1.2,
    brightness: 20,
    contrast: 1.3,
  });
  const payload = buildDisplaySettings(draft, display, {});
  for (const key of ['wireFormat', 'hue', 'saturation', 'brightness', 'contrast']) {
    assert.equal(isDisplayControlDirty(key, draft, display), true, `${key} dirty`);
    assert.deepEqual(payload[key], draft[key], `${key} global payload`);
  }
});

test('incomplete color and wire GET data stays read-only and out of the payload', async () => {
  const state = await createDisplayMock().getDisplaySettings(0);
  const display = state.displays[0];
  display.supportedOptions.bpcDepths = [];
  display.hue = { ...display.hue, value: null, controllable: false, reason: 'IGCL CURRENT failed' };
  assert.equal(isDisplayControlSupported(display, 'wireFormat'), false);
  assert.equal(isDisplayControlSupported(display, 'hue'), false);
  const draft = { wireFormat: { model: 'YCbCr444', depth: 8 }, hue: 12 };
  assert.deepEqual(buildDisplaySettings(draft, display, {}), {});
});

test('scaling choices require advertised methods and a known Retro current value', async () => {
  const state = await createDisplayMock().getDisplaySettings(0);
  const display = state.displays[0];
  assert.deepEqual(scalingModeViewOptionsForDisplay(display), ['gpu-scaling', 'display-scaling', 'retro-scaling']);
  display.supportedOptions.scalingModes = ['identity', 'centered'];
  assert.deepEqual(scalingMethodOptionsForView(display, 'gpu-scaling'), ['centered']);
  assert.deepEqual(scalingMethodOptionsForView(display, 'display-scaling'), ['maintain-display-scaling']);
  display.scalingMethod = { ...display.scalingMethod, value: null, controllable: false, reason: 'Unknown CURRENT method' };
  assert.deepEqual(scalingModeViewOptionsForDisplay(display), ['gpu-scaling', 'display-scaling']);
  assert.deepEqual(scalingMethodOptionsForView(display, 'retro-scaling'), []);
  display.supportedOptions.scalingModes = ['centered'];
  assert.deepEqual(scalingModeViewOptionsForDisplay(display), ['gpu-scaling']);
  display.supportedOptions.scalingModes = ['custom'];
  assert.deepEqual(scalingMethodOptionsForView(display, 'display-scaling'), ['custom']);
  assert.equal(scalingMethodViewOf(display), 'custom');
});

test('Supernative choices require a native baseline and higher Windows-listed modes', async () => {
  const state = await createDisplayMock().getDisplaySettings(0);
  const display = state.displays[0];
  assert.equal(superResolutionSourceModesForDisplay(display).length, 2);
  display.superResolution.modes = [];
  assert.deepEqual(superResolutionSourceModesForDisplay(display), []);
  assert.equal(isDisplayControlSupported(display, 'superResolution'), false);
  display.superResolution.modes = [{ width: 1920, height: 1080, refreshRate: 144 }];
  assert.deepEqual(superResolutionSourceModesForDisplay(display), []);
  display.superResolution.nativeResolution = null;
  assert.equal(isDisplayControlSupported(display, 'superResolution'), false);
});
