// Real Electron/Chromium verification of IGS-style display scaling controls.
// Invoked only by RID_MOCK_DISPLAY_SCALING_VERIFY and MockBackend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DISPLAY_SCALING_MODE_OPTIONS, DISPLAY_RETRO_SCALING_METHOD_OPTIONS } from '../src/main/backend/backend.interface.js';

export async function runDisplayScalingUiVerification(win, backend) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await js(expression)) return;
      await pause();
    }
    assert.fail(`${message}; state=${JSON.stringify(await js(`({ hash: location.hash, title: document.querySelector('.page-title')?.textContent ?? null, text: (document.getElementById('page')?.textContent ?? '').slice(0, 800) })`))}`);
  };
  const waitForWrite = async (count, predicate, message) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (writes.length >= count && predicate()) return;
      await pause();
    }
    assert.fail(`${message}; writes=${JSON.stringify(writes.map((item) => item.patch))}; model=${JSON.stringify(model)}`);
  };
  const selectOption = async (selector, value) => {
    await js(`document.querySelector('${selector}')?.click()`);
    await waitFor(`document.querySelector('[role="option"][data-value="${value}"]')`, `Dropdown option ${value} did not appear`);
    await js(`document.querySelector('[role="option"][data-value="${value}"]')?.click()`);
  };
  const screenshot = async (name) => {
    const directory = path.resolve('.codex/task-artifacts/b580-display-scaling');
    fs.mkdirSync(directory, { recursive: true });
    const originalSize = win.getContentSize();
    win.setContentSize(originalSize[0], 2200);
    await pause();
    await js(`(() => { const page = document.querySelector('#page'); if (page) page.style.zoom = '0.65'; return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const image = await win.webContents.capturePage();
    await js(`document.querySelector('#page').style.zoom = ''`);
    win.setContentSize(originalSize[0], originalSize[1]);
    const file = path.join(directory, name);
    fs.writeFileSync(file, image.toPNG());
    return file;
  };

  const entry = backend._entry(0);
  assert.match(entry.device.name, /B580/i, 'Expected isolated B580 MockBackend fixture');
  const fixture = entry.displays[0];
  fixture.identityVerified = true;
  fixture.scalingMode = 'identity';
  fixture.preferredScalingMode = 'aspect-ratio-centered-max';
  fixture.scalingPreference = null;
  fixture.scalingPreferenceSource = null;
  fixture.scalingMethod = { value: { enabled: false, method: null }, supported: true, controllable: true, reason: null, source: 'igcl-managed-scaling' };
  fixture.supportedOptions.scalingModes = [...DISPLAY_SCALING_MODE_OPTIONS];
  fixture.supportedOptions.scalingMethods = [...DISPLAY_RETRO_SCALING_METHOD_OPTIONS];
  fixture.customScalingPreference = { x: 100, y: 100 };

  const model = {
    active: 'identity',
    preferred: 'aspect-ratio-centered-max',
    preference: null,
    preferenceSource: null,
    deferred: false,
    custom: { x: 0, y: 0, hardwareModeSet: false },
    customPreference: { x: 100, y: 100 },
    retro: { enabled: false, method: null },
    unknownRetro: false,
  };
  const originalGet = backend.getDisplaySettings;
  const originalSet = backend.setDisplaySettings;
  const writes = [];
  const wrapRetro = () => ({
    value: model.unknownRetro ? { enabled: true, method: null } : structuredClone(model.retro),
    supported: true,
    controllable: true,
    reason: null,
    source: 'igcl-managed-scaling',
  });
  backend.getDisplaySettings = async function(...args) {
    const state = await originalGet.apply(this, args);
    for (const display of state.displays ?? []) {
      if (typeof display.displayKey !== 'string' || !display.displayKey.endsWith('mock-encoder-0')) continue;
      display.scalingMode = model.active;
      display.preferredScalingMode = model.preferred;
      display.scalingPreference = model.preference;
      display.scalingPreferenceSource = model.preferenceSource;
      display.scalingDeferred = model.deferred;
      display.customScalingPreference = structuredClone(model.customPreference);
      display.scalingDetails = structuredClone(model.custom);
      display.scalingMethod = wrapRetro();
    }
    return state;
  };
  backend.setDisplaySettings = async function(deviceId, request = {}) {
    const patch = request.patch && typeof request.patch === 'object' ? request.patch : {};
    const scalingKeys = ['scalingMode', 'displayScalingMethod', 'scalingMethod'].filter((key) => Object.hasOwn(patch, key));
    if (scalingKeys.length === 0) return originalSet.call(this, deviceId, request);
    assert.equal(deviceId, 0, 'Scaling write must target the B580 mock');
    assert.equal(typeof request.deviceKey, 'string', 'Scaling write must carry a durable adapter identity');
    assert.match(request.deviceKey, /^pci:/, 'Scaling write must carry a canonical PCI adapter identity');
    assert.equal(typeof request.displayKey, 'string');
    assert.equal(request.displayKey.endsWith('mock-encoder-0'), true);
    const record = { patch: structuredClone(patch), request: structuredClone(request) };
    writes.push(record);
    const method = patch.displayScalingMethod;
    if (method === 'stretched' || method === 'centered' || method === 'aspect-ratio-centered-max') {
      model.active = 'identity';
      model.preferred = method;
      model.preference = 'gpu-scaling';
      model.preferenceSource = 'arc-selection';
      model.deferred = true;
    } else if (method === 'maintain-display-scaling') {
      model.active = 'identity';
      model.preference = 'display-scaling';
      model.preferenceSource = 'arc-selection';
      model.deferred = false;
    } else if (method === 'custom') {
      model.active = 'custom';
      model.preference = 'display-scaling';
      model.preferenceSource = 'arc-selection';
      model.deferred = false;
      model.customPreference = { x: patch.scalingCustom.x, y: patch.scalingCustom.y };
      model.custom = { customX: patch.scalingCustom.x, customY: patch.scalingCustom.y, hardwareModeSet: true, preferredScalingType: 'identity' };
    } else if (patch.scalingMode === 'custom') {
      model.active = 'custom';
      model.preference = 'display-scaling';
      model.preferenceSource = 'arc-selection';
      model.deferred = false;
      model.customPreference = { x: patch.scalingCustom.x, y: patch.scalingCustom.y };
      model.custom = { customX: patch.scalingCustom.x, customY: patch.scalingCustom.y, hardwareModeSet: true, preferredScalingType: 'identity' };
    } else if (patch.scalingMode !== undefined) {
      model.active = patch.scalingMode;
      if (patch.scalingMode === 'identity') model.deferred = false;
      if (patch.scalingMode === 'identity' && model.preference === 'gpu-scaling') {
        model.preference = 'display-scaling';
        model.preferenceSource = 'arc-selection';
      }
    }
    if (patch.scalingMethod) {
      model.retro = { enabled: patch.scalingMethod.enabled, method: patch.scalingMethod.method };
      model.unknownRetro = false;
    }
    const perControl = Object.fromEntries(scalingKeys.map((key) => [key, { ok: true, readBackEqual: true, warning: 'Mocked native scaling state accepted.' }]));
    return { ok: true, perControl };
  };

  try {
    await waitFor(`document.getElementById('page')?.textContent?.includes('Active device') && document.querySelector('.dashboard-gpu-select, .device-select')`, 'Mock startup did not finish');
    await js('window.arcPower.waiverAccept(0)');
    await js(`location.hash = '#/graphics'`);
    await waitFor(`location.hash === '#/graphics' && document.querySelector('.graphics-view-btn[data-view="display"]')`, 'Graphics page did not render');
    await js(`document.querySelector('.graphics-view-btn[data-view="display"]').click()`);
    await waitFor(`document.querySelector('[data-display-select="scalingMode"]') && document.querySelector('[data-display-select="displayScalingMethod"]')`, 'Scaling controls did not render');

    const scalingMode = '[data-display-select="scalingMode"]';
    const scalingMethod = '[data-display-select="displayScalingMethod"]';
    const colorSnapshot = async () => js(`({ mode: document.querySelector('${scalingMode}')?.dataset.value, method: document.querySelector('${scalingMethod}')?.dataset.value, note: document.querySelector('[data-control="scalingMode"] .card-note')?.textContent ?? '', customX: document.querySelector('[aria-label="Custom horizontal scaling"]')?.value ?? null, customY: document.querySelector('[aria-label="Custom vertical scaling"]')?.value ?? null })`);
    assert.equal(await js(`document.querySelector('${scalingMode}')?.dataset.value`), 'gpu-scaling', 'Identity readback with a preferred GPU method should initially select GPU Scaling');
    assert.equal(await js(`document.querySelector('${scalingMethod}')?.dataset.value`), 'aspect-ratio-centered-max', 'Initial GPU method should show the preferred aspect-ratio method');
    await screenshot('scaling-initial.png');

    assert.equal(await js(`document.querySelector('${scalingMethod}')?.dataset.value`), 'aspect-ratio-centered-max', 'Initial GPU method should restore the known preferred aspect-ratio method');
    // Simulate two rapid native selections before the scheduled apply task is
    // dispatched. The final intent should be the single submitted snapshot.
    await js(`(() => { const pick = (value) => { const select = document.querySelector('${scalingMethod}'); select?.click(); document.querySelector('[role="option"][data-value="' + value + '"]')?.click(); }; pick('centered'); pick('stretched'); })()`);
    await waitForWrite(1, () => model.preferred === 'stretched', 'Stretched GPU method was not applied');
    assert.equal(writes.at(-1).patch.scalingMode, 'stretched');
    assert.equal(writes.at(-1).patch.displayScalingMethod, 'stretched');
    assert.equal(model.active, 'identity', 'The native active mode can remain Identity when resize is deferred');
    assert.equal(model.preferred, 'stretched');
    assert.equal(model.deferred, true);
    assert.equal(model.preference, 'gpu-scaling');
    assert.equal(model.preferenceSource, 'arc-selection');
    await screenshot('scaling-gpu-stretched.png');

    await selectOption(scalingMode, 'display-scaling');
    await waitForWrite(2, () => model.preference === 'display-scaling', 'Display Scaling preference was not saved');
    assert.equal(writes.at(-1).patch.scalingMode, 'identity');
    assert.equal(model.active, 'identity');
    assert.equal(model.preferred, 'stretched', 'Changing to Display Scaling must not erase stale native GPU preference readback');
    const displayNoteState = await colorSnapshot();
    assert.equal(displayNoteState.note.includes('Arc Power saved selection: Display Scaling'), true, `Display Scaling should show Arc Power selection note; observed ${JSON.stringify(displayNoteState)}, model=${JSON.stringify(model)}`);
    await selectOption(scalingMode, 'gpu-scaling');
    await waitForWrite(3, () => model.preference === 'gpu-scaling' && model.preferred === 'stretched', 'Returning to GPU Scaling must restore remembered Stretched method');
    await selectOption(scalingMode, 'display-scaling');
    await waitForWrite(4, () => model.preference === 'display-scaling', 'Returning to Display Scaling must save Maintain Display Scaling');
    await waitFor(`document.querySelector('${scalingMethod}')?.dataset.value === 'maintain-display-scaling'`, 'Display Scaling method did not restore Maintain Display Scaling');
    const returnedDisplaySelection = await colorSnapshot();
    assert.equal(returnedDisplaySelection.mode, 'display-scaling', 'Switching away and back should preserve Display Scaling selection');
    assert.equal(returnedDisplaySelection.note.includes('Arc Power saved selection: Display Scaling'), true, 'Arc selection note should persist after switching back');

    await selectOption(scalingMethod, 'custom');
    const beforeCustomApply = await colorSnapshot();
    assert.equal(beforeCustomApply.customX, '100', 'Custom editor should start with the safe 100% horizontal preference');
    assert.equal(beforeCustomApply.customY, '100', 'Custom editor should start with the safe 100% vertical preference');
    await js(`(() => { for (const label of ['Custom horizontal scaling', 'Custom vertical scaling']) { const input = document.querySelector('[aria-label="' + label + '"]'); input.value = '95'; input.dispatchEvent(new Event('change', { bubbles: true })); } document.querySelector('[data-control="displayScalingMethod"] .oc-chip-apply')?.click(); })()`);
    await waitForWrite(5, () => model.active === 'custom', 'Custom 95% scaling was not applied');
    const customWrite = writes.at(-1).patch;
    assert.equal(customWrite.scalingMode, 'custom');
    assert.equal(customWrite.displayScalingMethod, undefined, 'Custom display scaling is represented by raw custom mode plus its percentages');
    assert.deepEqual(customWrite.scalingCustom, { x: 95, y: 95, hardwareModeSet: true }, 'Custom payload must send actual 95% values, not inactive native zeros');
    assert.equal(model.preferred, 'stretched', 'Stale preferred GPU method should remain independent from Custom display selection');
    assert.equal((await colorSnapshot()).customX, '95');
    await screenshot('scaling-custom-95.png');

    await js(`location.hash = '#/dashboard'`);
    await waitFor(`location.hash === '#/dashboard'`, 'Dashboard navigation did not finish');
    await js(`location.hash = '#/graphics'`);
    await waitFor(`location.hash === '#/graphics' && document.querySelector('.graphics-view-btn[data-view="display"]')`, 'Graphics navigation did not finish');
    await js(`document.querySelector('.graphics-view-btn[data-view="display"]').click()`);
    await waitFor(`document.querySelector('${scalingMode}') && document.querySelector('${scalingMethod}')?.dataset.value === 'custom'`, 'Saved Custom editor state did not survive route recreation');
    assert.equal((await colorSnapshot()).customX, '95');
    assert.equal((await colorSnapshot()).customY, '95');

    await selectOption(scalingMode, 'retro-scaling');
    await waitForWrite(6, () => model.retro.enabled === true && model.retro.method === 'integer', 'Retro Scaling selection did not activate');
    const retroMethodOptions = await js(`document.querySelector('[data-display-select="displayScalingMethod"]')?.options?.map((option) => option.dataset.value) ?? []`);
    assert.deepEqual(retroMethodOptions, ['integer', 'nearest-neighbour'], 'Known disabled/null Retro state should expose both supported methods');
    assert.equal(writes.at(-1).patch.scalingMode, 'identity');
    assert.deepEqual(writes.at(-1).patch.scalingMethod, { enabled: true, method: 'integer' });
    await selectOption(scalingMethod, 'nearest-neighbour');
    await waitForWrite(7, () => model.retro.method === 'nearest-neighbour', 'Nearest Neighbour Retro method did not apply');
    assert.deepEqual(writes.at(-1).patch.scalingMethod, { enabled: true, method: 'nearest-neighbour' });
    await selectOption(scalingMode, 'display-scaling');
    await waitForWrite(8, () => model.retro.enabled === false, 'Exiting Retro Scaling did not disable the known active method');
    assert.deepEqual(writes.at(-1).patch.scalingMethod, { enabled: false, method: 'nearest-neighbour' }, 'Leaving Retro must submit the known disable pair');
    await screenshot('scaling-retro-disabled.png');

    model.unknownRetro = true;
    model.retro = { enabled: true, method: null };
    await js(`location.hash = '#/dashboard'`);
    await waitFor(`location.hash === '#/dashboard'`, 'Dashboard route did not reload');
    await js(`location.hash = '#/graphics'`);
    await waitFor(`location.hash === '#/graphics' && document.querySelector('.graphics-view-btn[data-view="display"]')`, 'Graphics route did not reload');
    await js(`document.querySelector('.graphics-view-btn[data-view="display"]').click()`);
    await waitFor(`document.querySelector('[data-control="scalingMode"]')`, 'Unknown Retro capability did not render scaling mode card');
    const unknownState = await js(`({ modeOptions: [...document.querySelector('[data-display-select="scalingMode"]')?.options ?? []].map((option) => option.dataset.value), methodReadOnly: !!document.querySelector('[data-control="displayScalingMethod"].display-control-readonly'), methodText: document.querySelector('[data-control="displayScalingMethod"]')?.textContent ?? '' })`);
    assert.equal(unknownState.modeOptions.includes('retro-scaling'), false, 'Unknown enabled Retro method must hide unsafe mode selection');
    assert.equal(unknownState.methodReadOnly, true, 'Unknown enabled/null Retro method must remain read-only');

    process.stdout.write(`[display-scaling-ui] PASS screenshots=${path.resolve('.codex/task-artifacts/b580-display-scaling')} writes=${JSON.stringify(writes.map((item) => item.patch))}\n`);
  } finally {
    backend.getDisplaySettings = originalGet;
    backend.setDisplaySettings = originalSet;
  }
}
