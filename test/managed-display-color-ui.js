// Real Electron/Chromium verification of the managed display-color editor.
// Invoked only by RID_MOCK_DISPLAY_COLOR_VERIFY and uses MockBackend exclusively.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DISPLAY_COLOR_RANGES } from '../src/main/backend/display-color-state.js';

export async function verifyManagedDisplayColorUi(win, backend) {
  win.webContents.on('console-message', (event) => {
    process.stdout.write(`[managed-display-color-ui] renderer console ${event.level} ${event.sourceId}:${event.lineNumber}: ${event.message}\n`);
  });
  const js = async (code) => win.webContents.executeJavaScript(code);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await js(expression)) return;
      await pause();
    }
    assert.fail(`${message}; state=${JSON.stringify(await js(`({ hash: location.hash, title: document.querySelector('.page-title')?.textContent ?? null, page: (document.getElementById('page')?.textContent ?? '').slice(0, 700) })`))}`);
  };
  const screenshot = async (name) => {
    const directory = path.resolve('.codex/task-artifacts/b580-display-color');
    fs.mkdirSync(directory, { recursive: true });
    await js(`document.querySelectorAll('.toast').forEach((item) => item.remove())`);
    const originalSize = win.getContentSize();
    win.setContentSize(originalSize[0], 2400);
    await pause();
    await js(`(() => { const button = document.querySelector('.graphics-view-btn[data-view="display"]'); if (button && !button.classList.contains('active')) button.click(); })()`);
    await waitFor(`document.querySelector('.graphics-view-btn[data-view="display"]')?.classList.contains('active') && document.querySelector('[data-display-group="color"] input[aria-label="Hue"]')`, 'Display view was not stable after screenshot resize');
    await js(`(() => { const group = document.querySelector('[data-display-group="color"]'); if (group?.querySelector('.display-group-body')?.classList.contains('is-collapsed')) group.querySelector('.display-group-toggle')?.click(); })()`);
    await waitFor(`!document.querySelector('[data-display-group="color"] .display-group-body')?.classList.contains('is-collapsed')`, 'Color group was not expanded after screenshot resize');
    await js(`(() => { const page = document.querySelector('#page'); if (page) page.style.zoom = '0.6'; return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); })()`);
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(await js(`location.hash === '#/graphics' && document.querySelector('[data-display-group="color"] input[aria-label="Hue"]')?.getClientRects().length > 0`), true, 'Screenshot must show the Graphics color editor');
    const image = await win.webContents.capturePage();
    await js(`document.querySelector('#page').style.zoom = ''`);
    win.setContentSize(originalSize[0], originalSize[1]);
    const file = path.join(directory, name);
    fs.writeFileSync(file, image.toPNG());
    return file;
  };

  const entry = backend._entry(0);
  assert.match(entry.device.name, /B580/i, 'Expected the isolated B580 MockBackend fixture');
  assert.equal(entry.displays.length > 0, true, 'B580 mock must expose a display');
  const display = entry.displays[0];
  assert.equal(typeof display.displayKey, 'string');
  assert.equal(display.identityVerified, true);

  // Add a second verified mock monitor on the same B580 adapter. The UI
  // must keep the in-flight Apply scoped to the monitor it was submitted for.
  const secondDisplay = structuredClone(display);
  secondDisplay.id = 1;
  secondDisplay.name = 'Arc Power Mock Display B';
  secondDisplay.displayKey = display.displayKey.replace(/mock-encoder-0$/, 'mock-encoder-1');
  entry.displays.push(secondDisplay);

  const initialDesired = { hue: 0, saturation: 1, brightness: 0, contrast: 1 };
  const stateByDisplay = new Map([display, secondDisplay].map((item) => [item.displayKey, {
    desired: { ...initialDesired },
    lastSent: { hueSaturation: false, brightnessContrast: false },
    fixture: item,
  }]));
  const groupFor = (key) => key === 'hue' || key === 'saturation' ? 'hueSaturation' : 'brightnessContrast';
  const managedCapability = (state, key) => ({
    value: null,
    desiredValue: state.desired[key],
    lastSent: state.lastSent[groupFor(key)],
    supported: true,
    controllable: true,
    source: 'igcl-managed-color',
    reason: 'Managed by Arc Power; this driver does not provide live read-back.',
  });
  for (const state of stateByDisplay.values()) {
    for (const key of Object.keys(initialDesired)) state.fixture[key] = managedCapability(state, key);
    state.fixture.supportedOptions.colorRanges = structuredClone(DISPLAY_COLOR_RANGES);
  }

  const originalGetDisplaySettings = backend.getDisplaySettings;
  const originalSetDisplaySettings = backend.setDisplaySettings;
  const writes = [];
  const reads = [];
  let holdNextColorWrite = false;
  let holdNextScopeColorWrite = false;
  let notifyColorWriteStarted;
  let finishHeldColorWrite;
  const colorWriteStarted = new Promise((resolve) => { notifyColorWriteStarted = resolve; });
  const heldColorWrite = new Promise((resolve) => { finishHeldColorWrite = resolve; });
  let notifyScopeColorWriteStarted;
  let finishHeldScopeColorWrite;
  const scopeColorWriteStarted = new Promise((resolve) => { notifyScopeColorWriteStarted = resolve; });
  const heldScopeColorWrite = new Promise((resolve) => { finishHeldScopeColorWrite = resolve; });
  backend.getDisplaySettings = async function(...args) {
    const state = await originalGetDisplaySettings.apply(this, args);
    for (const found of state.displays) {
      const managed = stateByDisplay.get(found.displayKey);
      if (!managed) continue;
      for (const key of Object.keys(initialDesired)) found[key] = managedCapability(managed, key);
      reads.push(structuredClone({ displayKey: found.displayKey, source: found.saturation.source, lastSent: found.saturation.lastSent, desiredValue: found.saturation.desiredValue }));
    }
    return state;
  };
  backend.setDisplaySettings = async function(deviceId, request = {}) {
    const patch = request.patch && typeof request.patch === 'object' ? request.patch : {};
    const colorKeys = Object.keys(initialDesired).filter((key) => Object.hasOwn(patch, key));
    if (colorKeys.length === 0) return originalSetDisplaySettings.call(this, deviceId, request);
    const record = { deviceId, request: structuredClone(request) };
    writes.push(record);
    assert.equal(typeof request.deviceKey, 'string', 'Color write must carry the selected stable adapter identity');
    assert.equal(typeof request.displayKey, 'string', 'Color write must carry the selected stable display identity');
    assert.match(request.displayKey, /\|display\|mock-encoder-[01]$/, 'Color write must target one of the B580 mock display encoders');
    const managed = [...stateByDisplay.entries()].find(([key]) => request.displayKey.endsWith(key.slice(key.lastIndexOf('|display|'))))?.[1];
    assert.ok(managed, `Color write must target a known mock display; got ${request.displayKey}`);
    if (colorKeys.some((key) => managed.lastSent[groupFor(key)] !== true)) {
      assert.equal(patch.replaceExistingColorSettings, true, `First managed color write must explicitly acknowledge replacement of existing driver color settings; received ${JSON.stringify(patch)}; latest capability=${JSON.stringify(reads.at(-1))}`);
    }
    if (holdNextColorWrite) {
      holdNextColorWrite = false;
      notifyColorWriteStarted();
      await heldColorWrite;
    }
    if (holdNextScopeColorWrite) {
      holdNextScopeColorWrite = false;
      notifyScopeColorWriteStarted();
      await heldScopeColorWrite;
    }
    for (const key of colorKeys) {
      assert.equal(Number.isFinite(patch[key]), true, `Expected a canonical numeric ${key} value`);
      managed.desired[key] = patch[key];
      managed.fixture[key] = managedCapability(managed, key);
    }
    const groups = new Set(colorKeys.map(groupFor));
    for (const group of groups) managed.lastSent[group] = true;
    for (const key of Object.keys(initialDesired)) managed.fixture[key] = managedCapability(managed, key);
    return {
      ok: true,
      perControl: Object.fromEntries(colorKeys.map((key) => [key, {
        ok: true,
        verification: 'readback-unavailable',
        message: 'The driver accepted the Arc Power color settings; this driver does not provide live read-back.',
      }])),
    };
  };

  try {
    await waitFor(`document.getElementById('page')?.textContent?.includes('Active device') && document.querySelector('.dashboard-gpu-select, .device-select')`, 'Mock app startup did not finish resolving the B580 display device');
    await js(`window.arcPower.waiverAccept(0)`);
    await js(`location.hash = '#/graphics'`);
    await waitFor(`location.hash === '#/graphics' && document.querySelector('.graphics-view-btn[data-view="display"]')`, 'Graphics view toggle did not render');
    await js(`document.querySelector('.graphics-view-btn[data-view="display"]').click()`);
    await waitFor(`document.querySelector('[data-display-group="color"] input[aria-label="Hue"]') && document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')`, 'Display color sliders did not render');

    const initialControls = await js(`(() => {
      const color = document.querySelector('[data-display-group="color"]');
      const read = (key) => {
        const input = color.querySelector('input[aria-label="' + key[0].toUpperCase() + key.slice(1) + '"]');
        return input && { min: input.min, max: input.max, step: input.step, value: input.value };
      };
      return { hue: read('hue'), saturation: read('saturation'), brightness: read('brightness'), contrast: read('contrast'), quant: !!color.querySelector('[data-control="quantizationRange"]'), format: !!color.querySelector('[data-control="wireFormat"]') };
    })()`);
    for (const key of ['saturation', 'brightness', 'contrast']) {
      assert.deepEqual(initialControls[key], { min: '0', max: '100', step: '1', value: '50' }, `${key} should display the midpoint of its 0–100 UI range`);
    }
    assert.deepEqual(initialControls.hue, { min: '-180', max: '180', step: '1', value: '0' });
    assert.equal(initialControls.quant, true, 'Quantization Range control should remain rendered');
    assert.equal(initialControls.format, true, 'Color Format control should remain rendered');
    await js(`document.querySelector('[data-display-group="color"] .display-group-toggle')?.click()`);
    await waitFor(`document.querySelector('[data-display-group="color"] input[aria-label="Hue"]')?.getClientRects().length > 0`, 'Color group did not expand');
    await screenshot('managed-ui-initial.png');

    await js(`(() => { const slider = document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]'); slider.value = '60'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    holdNextColorWrite = true;
    await js(`document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-apply')?.click()`);
    await Promise.race([colorWriteStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('First color write did not enter the deferred backend')), 4000))]);
    assert.equal(await js(`(() => { const picker = document.querySelector('[data-display-picker]'); return picker?.disabled === true && picker.dataset.value === '0'; })()`), true, 'The display picker must lock to display A during its pending Apply');
    await js(`(() => { const picker = document.querySelector('[data-display-picker]'); const option = picker?.options?.find((item) => item.dataset.value === '1'); option?.click(); })()`);
    assert.equal(await js(`document.querySelector('[data-display-picker]')?.dataset.value`), '0', 'A synthetic attempt to select display B during Apply must be rejected');
    assert.equal(await js(`document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value`), '60', 'Display B selection attempt must not replace display A draft');
    await js(`(() => { const slider = document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]'); slider.value = '80'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await js(`document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value`), '80', 'The slider should remain editable while Apply is in flight');
    finishHeldColorWrite();
    await waitFor(`document.querySelector('.toast')?.textContent?.includes('Color settings sent') && document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value === '80' && !document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-apply')?.hidden`, 'Accepted older value must not overwrite a newer in-flight slider edit');
    assert.equal(writes.length, 1, 'The first slider Apply should produce one backend write');
    assert.equal(writes[0].request.patch.saturation, 1.2, 'UI 60% must map to canonical IGCL saturation 1.2');
    assert.equal(writes[0].request.patch.replaceExistingColorSettings, true);
    const appliedCapability = await backend.getDisplaySettings(0);
    assert.equal(appliedCapability.displays[0].saturation.value, null, 'Test must retain unavailable live read-back');
    assert.equal(appliedCapability.displays[0].saturation.desiredValue, 1.2);
    assert.equal(appliedCapability.displays[0].saturation.lastSent, true);
    await screenshot('managed-ui-applied.png');

    await js(`document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-apply')?.click()`);
    await waitFor(`document.querySelector('.toast')?.textContent?.includes('Color settings sent') && document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-status')?.textContent?.includes('Last sent')`, 'Second Apply did not send the newer slider value');
    assert.equal(writes.length, 2, 'Applying the preserved edit should produce a second backend write');
    assert.equal(writes[1].request.patch.saturation, 1.6, 'UI 80% must map to canonical IGCL saturation 1.6');
    assert.equal((await backend.getDisplaySettings(0)).displays[0].saturation.desiredValue, 1.6);

    assert.equal(await js(`document.querySelector('[data-display-picker]')?.disabled`), false, 'Display picker should unlock after Apply finishes');
    await js(`document.querySelector('[data-display-picker]')?.click()`);
    await waitFor(`document.querySelector('[data-display-picker]')?.getAttribute('aria-expanded') === 'true'`, 'Display picker did not open after Apply');
    await js(`document.querySelector('[role="option"][data-value="1"]')?.click()`);
    await waitFor(`document.querySelector('[data-display-picker]')?.dataset.value === '1' && document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value === '50'`, 'Display B did not load its independent default color state');
    const displayBState = await backend.getDisplaySettings(0);
    assert.equal(displayBState.displays.find((item) => item.displayKey.endsWith('mock-encoder-1'))?.saturation.desiredValue, 1, 'Display A’s accepted response must not change display B managed state');
    assert.equal(displayBState.displays.find((item) => item.displayKey.endsWith('mock-encoder-1'))?.saturation.lastSent, false);
    await js(`document.querySelector('[data-display-picker]')?.click()`);
    await waitFor(`document.querySelector('[data-display-picker]')?.getAttribute('aria-expanded') === 'true'`, 'Display picker did not reopen');
    await js(`document.querySelector('[role="option"][data-value="0"]')?.click()`);
    await waitFor(`document.querySelector('[data-display-picker]')?.dataset.value === '0' && document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value === '80'`, 'Switching back to display A should restore its own sent value');

    await js(`(() => { const slider = document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]'); slider.value = '70'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    holdNextScopeColorWrite = true;
    await js(`document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-apply')?.click()`);
    await Promise.race([scopeColorWriteStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('View-scope color write did not enter the deferred backend')), 4000))]);
    assert.equal(await js(`(() => { const buttons = [...document.querySelectorAll('.graphics-view-btn')]; return buttons.length === 2 && buttons.every((button) => button.disabled); })()`), true, 'Graphics and Display subview switches must be disabled during a pending Display Apply');
    await js(`document.querySelector('.graphics-view-btn[data-view="settings"]')?.click()`);
    assert.equal(await js(`document.querySelector('.graphics-view-btn[data-view="display"]')?.classList.contains('active')`), true, 'Attempting to switch views while Apply is pending must leave Display active');
    await js(`(() => { const slider = document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]'); slider.value = '80'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    finishHeldScopeColorWrite();
    await waitFor(`document.querySelector('[data-display-picker]')?.disabled === false && [...document.querySelectorAll('.graphics-view-btn')].every((button) => !button.disabled) && document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value === '80' && !document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-apply')?.hidden`, 'Apply completion must unlock view selection and preserve a newer dirty draft');
    const acceptedViewApply = await backend.getDisplaySettings(0);
    const acceptedViewDisplay = acceptedViewApply.displays.find((item) => item.displayKey.endsWith('mock-encoder-0'));
    assert.equal(acceptedViewDisplay?.saturation.desiredValue, 1.4, 'Accepted pending Apply should set managed desired saturation to 1.4');
    assert.equal(acceptedViewDisplay?.saturation.lastSent, true, 'Accepted pending Apply should record the group as last sent');
    await js(`document.querySelector('.graphics-view-btn[data-view="settings"]')?.click()`);
    await waitFor(`document.querySelector('.graphics-view-btn[data-view="settings"]')?.classList.contains('active')`, 'Graphics settings view should be selectable after Apply completes');
    await js(`document.querySelector('.graphics-view-btn[data-view="display"]')?.click()`);
    await waitFor(`document.querySelector('.graphics-view-btn[data-view="display"]')?.classList.contains('active') && document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value === '70'`, 'Display should reload the accepted 70% value after switching views');
    await js(`(() => { const slider = document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]'); slider.value = '90'; slider.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-apply')?.click(); })()`);
    await waitFor(`document.querySelector('.toast')?.textContent?.includes('Color settings sent') && document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value === '90'`, 'A subsequent Apply after subview return did not complete');
    assert.equal(writes.length, 4, 'Subview-scope Apply plus the following usable Apply should both be recorded');
    assert.equal(writes[2].request.patch.saturation, 1.4, 'Pending subview Apply should retain its submitted snapshot');
    assert.equal(writes[3].request.patch.saturation, 1.8, 'Apply after returning to Display should send the new 90% value');

    await js(`location.hash = '#/dashboard'`);
    await waitFor(`location.hash === '#/dashboard' && document.getElementById('page')?.textContent?.includes('Active device')`, 'Navigate-away did not complete');
    await js(`location.hash = '#/graphics'`);
    await waitFor(`location.hash === '#/graphics' && document.querySelector('.graphics-view-btn[data-view="display"]')`, 'Graphics page did not return');
    await js(`document.querySelector('.graphics-view-btn[data-view="display"]').click()`);
    await waitFor(`document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value === '90'`, 'Managed desired value was lost after leaving and reopening Display');
    assert.equal(await js(`document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-status')?.textContent`), 'Last sent');

    await js(`document.querySelector('[data-display-group="color"] [data-control="saturation"] button.btn-ghost')?.click()`);
    assert.equal(await js(`document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value`), '50', 'Reset should stage the canonical display default');
    await js(`document.querySelector('[data-display-group="color"] [data-control="saturation"] .oc-chip-apply')?.click()`);
    await waitFor(`document.querySelector('.toast')?.textContent?.includes('Color settings sent') && document.querySelector('[data-display-group="color"] input[aria-label="Saturation"]')?.value === '50'`, 'Reset Apply did not send the staged default');
    assert.equal(writes.length, 5, 'Reset Apply should send exactly one additional request');
    assert.equal(writes[4].request.patch.saturation, 1, 'Reset should send canonical default saturation 1.0');
    assert.equal(writes[4].request.patch.replaceExistingColorSettings, undefined, 'A previously sent group must not request replacement again');
    const finalCapability = await backend.getDisplaySettings(0);
    assert.equal(finalCapability.displays[0].saturation.value, null);
    assert.equal(finalCapability.displays[0].saturation.desiredValue, 1);
    assert.equal(finalCapability.displays[0].saturation.lastSent, true);
    await screenshot('managed-ui-reset.png');

    process.stdout.write(`[managed-display-color-ui] PASS screenshots=${path.resolve('.codex/task-artifacts/b580-display-color')} writes=${JSON.stringify(writes.map((entry) => entry.request.patch))}\n`);
  } finally {
    finishHeldColorWrite();
    finishHeldScopeColorWrite();
    backend.getDisplaySettings = originalGetDisplaySettings;
    backend.setDisplaySettings = originalSetDisplaySettings;
  }
}
