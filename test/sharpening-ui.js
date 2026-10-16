// Focused rendered UI verification for global and per-game image sharpening.
// This is invoked only by the RID_MOCK_SHARPENING_VERIFY ui-verify branch.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function verifySharpeningUi(win, backend, gameProfiles) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (await js(expression)) return;
      await pause();
    }
    assert.fail(`${message}; state=${JSON.stringify(await js(`(async () => ({ hash: location.hash, ready: document.readyState, title: document.querySelector('.page-title')?.textContent ?? null, page: (document.getElementById('page')?.textContent ?? '').slice(0, 260), toast: document.querySelector('.toast')?.textContent ?? null, game: await window.arcPower.gameCatalogList().catch((error) => String(error)), devices: await window.arcPower.listDevices().catch(() => null), selected: await window.arcPower.deviceGet().catch(() => null) }))()`))}`);
  };
  const screenshot = async (name) => {
    const directory = path.resolve('.codex/task-artifacts/legacy-sharpening-audit');
    fs.mkdirSync(directory, { recursive: true });
    const image = await win.webContents.capturePage();
    const file = path.join(directory, name);
    fs.writeFileSync(file, image.toPNG());
    return file;
  };
  const prepareScreenshot = async (selector) => {
    await js(`(() => {
      document.querySelectorAll('.toast').forEach((toast) => toast.remove());
      const target = document.querySelector(${JSON.stringify(selector)});
      target?.scrollIntoView({ block: 'center' });
    })()`);
    await pause();
  };

  let sharpeningAdvertised = false;
  let globalValue = { enabled: true, percentage: 72 };
  let globalWrites = [];
  let gameWrites = [];
  const originalGetGraphics = backend.getGraphicsSettings;
  const originalSetGraphics = backend.setGraphicsSettings;
  const originalGameCaps = backend.getGameProfileCapabilities;
  const originalSetGame = backend.setGameProfileSettings;
  backend.getGraphicsSettings = async function(deviceId = 0) {
    const state = await originalGetGraphics.call(this, deviceId);
    return {
      ...state,
      supported: { ...state.supported, sharpening: sharpeningAdvertised },
      sharpeningRange: sharpeningAdvertised ? { min: 0, max: 100, step: 1, default: 38 } : null,
      sharpeningReason: sharpeningAdvertised ? null : 'The mock driver does not expose sharpening.',
      sharpeningPerAppSupport: sharpeningAdvertised,
      sharpeningLiveChange: false,
      values: { ...state.values, sharpening: sharpeningAdvertised ? { ...globalValue } : null },
    };
  };
  backend.setGraphicsSettings = async function(deviceId = 0, settings = {}) {
    if (Object.prototype.hasOwnProperty.call(settings, 'sharpening')) {
      globalWrites.push({ deviceId, settings: structuredClone(settings) });
      globalValue = structuredClone(settings.sharpening);
      return { ok: true, perControl: { sharpening: { ok: true, readBackEqual: true } } };
    }
    return originalSetGraphics.call(this, deviceId, settings);
  };
  backend.getGameProfileCapabilities = async function(deviceId = 0, exePath) {
    const caps = await originalGameCaps.call(this, deviceId, exePath);
    return {
      ...caps,
      sharpening: sharpeningAdvertised,
      sharpeningRange: sharpeningAdvertised ? { min: 0, max: 100, step: 1, default: 38 } : null,
      sharpeningReason: sharpeningAdvertised ? null : 'The mock driver does not expose sharpening.',
      sharpeningPerAppSupport: sharpeningAdvertised,
      sharpeningLiveChange: false,
    };
  };
  backend.setGameProfileSettings = async function(deviceId = 0, exePath, settings = {}, enabled = true) {
    gameWrites.push({ deviceId, exePath, settings: structuredClone(settings), enabled });
    return { ok: true, perControl: { sharpening: { ok: true, readBackEqual: true }, profileScope: { ok: true, readBackEqual: true } } };
  };

  try {
    await waitFor(`document.getElementById('page')?.textContent?.includes('Active device') && document.getElementById('page')?.textContent?.includes('Dashboard')`,
      'Mock GPU inventory did not finish renderer bootstrap');
    // Accept the mock-only OC waiver in isolated test storage so the real
    // game-profile Apply control is unobstructed by the first-run dialog.
    await js(`window.arcPower.waiverAccept(0)`);
    // Graphics' no-device guard intentionally paints a static fallback. Let
    // the app's inventory + selected-device boot sequence settle first, then
    // enter Graphics as the user would from the sidebar.
    await new Promise((resolve) => setTimeout(resolve, 900));
    await js(`location.hash = '#/dashboard'`);
    await pause();
    await js(`location.hash = '#/graphics'`);
    await waitFor(`document.querySelector('.graphics-page-hero .page-title')?.textContent === 'Graphics'`, 'Graphics page did not render');
    assert.equal(await js(`!!document.querySelector('.graphics-card[data-control="sharpening"]')`), false,
      'Global sharpening control was shown while the driver capability was absent');

    const devices = await backend.listDevices();
    assert.ok(devices.length >= 1, 'The focused UI runner must expose a mock GPU');
    const primary = devices[0];
    const secondary = { deviceKey: 'sharpening-secondary-fixture-gpu', name: 'Secondary GPU fixture' };
    await js(`location.hash = '#/profiles'`);
    await waitFor(`!!document.querySelector('.profiles-mode-toggle')`, 'Profiles page did not render');
    await js(`Array.from(document.querySelectorAll('.profiles-mode-toggle button')).find((button) => button.textContent.trim() === 'Game Profile')?.click()`);
    await waitFor(`document.querySelectorAll('.game-catalog-card').length >= 1`, 'Game catalog did not render');
    let catalog = await gameProfiles.loadCatalog();
    const cyberpunk = catalog.catalog.find((entry) => entry.exePath.toLowerCase().endsWith('cyberpunk2077.exe'));
    assert.ok(cyberpunk, `Mock Cyberpunk executable was not present in the isolated game catalog: ${JSON.stringify(catalog.catalog)}`);

    // A pre-existing disabled assignment carries unrelated fields for both
    // GPUs; subsequent sharpening edits must preserve all of them.
    await gameProfiles.saveSettings({
      exePath: cyberpunk.exePath,
      gpuProfiles: [
        { deviceKey: primary.deviceKey, deviceName: primary.name, enabled: false, graphics: { flipMode: 'vsync-on', lowLatency: 'on' } },
        { deviceKey: secondary.deviceKey, deviceName: secondary.name, enabled: false, graphics: { flipMode: 'vsync-off', frameLimit: { enabled: true, value: 72 } } },
      ],
    });
    await js(`document.querySelector('.game-catalog-refresh')?.click()`);
    await waitFor(`document.querySelectorAll('.game-catalog-card').length >= 1`, 'Game catalog refresh did not finish');
    await js(`Array.from(document.querySelectorAll('.game-catalog-card')).find((button) => (button.dataset.exePath ?? '').toLowerCase().endsWith('cyberpunk2077.exe'))?.click()`);
    await waitFor(`!!document.querySelector('.game-profile-detail')`, 'Game Profile detail did not render');
    assert.equal(await js(`!!document.querySelector('[aria-label="Per-game image sharpening enabled"]')`), false,
      'Per-game sharpening control was shown while the driver capability was absent');

    sharpeningAdvertised = true;
    await js(`document.querySelector('.game-profile-back')?.click()`);
    await pause();
    await js(`Array.from(document.querySelectorAll('.game-catalog-card')).find((button) => (button.dataset.exePath ?? '').toLowerCase().endsWith('cyberpunk2077.exe'))?.click()`);
    await waitFor(`!!document.querySelector('[aria-label="Per-game image sharpening enabled"]')`, 'Per-game sharpening did not appear after capability was advertised');
    assert.equal(await js(`document.querySelectorAll('.game-profile-gpu-switch button').length`), 1,
      'Game Profile should expose only the mock GPU present in this runner');
    const initialGameSlider = await js(`document.querySelector('.profile-sharpening-slider')?.outerHTML ?? null`);
    assert.match(initialGameSlider ?? '', /min="0"/);
    assert.match(initialGameSlider ?? '', /max="100"/);
    assert.match(initialGameSlider ?? '', /step="1"/);
    assert.equal(await js(`document.querySelector('.profile-sharpening-slider')?.getAttribute('aria-valuetext')`), '72%',
      'An unset per-game sharpening value must display the current global strength');
    assert.equal(await js(`document.querySelector('[aria-label="Per-game image sharpening enabled"]')?.checked`), true,
      'An unset per-game sharpening value must display the current global enabled state');
    assert.equal(await js(`Array.from(document.querySelectorAll('.game-profile-detail .profile-setting-row')).find((row) => row.querySelector('strong')?.textContent.trim() === 'Image Sharpening')?.textContent.includes('Using global sharpening: On (72%)')`), true,
      'An unset per-game sharpening value must explain that it currently inherits global On (72%)');
    let initialCatalog = await gameProfiles.loadCatalog();
    let initialGame = initialCatalog.settings.find((item) => item.exePath === cyberpunk.exePath);
    assert.equal(Object.hasOwn(initialGame.gpuProfiles.find((gpu) => gpu.deviceKey === primary.deviceKey).graphics, 'sharpening'), false,
      'Showing inherited global state must not create a stored per-game sharpening override');
    await prepareScreenshot(`.game-profile-detail .profile-setting-row:has(.profile-sharpening-slider)`);
    await screenshot('game-profile-sharpening.png');

    // Changing strength in an inherited enabled state must preserve On and
    // create the explicit game override only after the user changes a control.
    await js(`(() => { const input = document.querySelector('.profile-sharpening-slider'); input.value = '64'; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`window.arcPower.gameCatalogList().then(({ settings }) => settings.some((item) => item.exePath.toLowerCase().endsWith('cyberpunk2077.exe') && item.gpuProfiles.some((gpu) => gpu.deviceKey === '${primary.deviceKey}' && gpu.graphics.sharpening?.enabled === true && gpu.graphics.sharpening?.percentage === 64)))`,
      'Changing per-game strength changed its inherited enable state or failed to persist 64%');
    await js(`(() => { const input = document.querySelector('[aria-label="Per-game image sharpening enabled"]'); input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`window.arcPower.gameCatalogList().then(({ settings }) => settings.some((item) => item.exePath.toLowerCase().endsWith('cyberpunk2077.exe') && item.gpuProfiles.some((gpu) => gpu.deviceKey === '${primary.deviceKey}' && gpu.graphics.sharpening?.enabled === false && gpu.graphics.sharpening?.percentage === 64)))`,
      'Explicitly turning the game override off did not persist while retaining 64%');
    await js(`(() => { const input = document.querySelector('[aria-label="Per-game image sharpening enabled"]'); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`window.arcPower.gameCatalogList().then(({ settings }) => settings.some((item) => item.exePath.toLowerCase().endsWith('cyberpunk2077.exe') && item.gpuProfiles.some((gpu) => gpu.deviceKey === '${primary.deviceKey}' && gpu.graphics.sharpening?.enabled === true && gpu.graphics.sharpening?.percentage === 64)))`,
      'Separate per-game enable switch did not persist enabled 64% sharpening');
    let saved = await gameProfiles.loadCatalog();
    let savedGame = saved.settings.find((item) => item.exePath === cyberpunk.exePath);
    const primarySaved = savedGame.gpuProfiles.find((gpu) => gpu.deviceKey === primary.deviceKey);
    const secondarySaved = savedGame.gpuProfiles.find((gpu) => gpu.deviceKey === secondary.deviceKey);
    assert.deepEqual(primarySaved.graphics, { flipMode: 'vsync-on', lowLatency: 'on', sharpening: { enabled: true, percentage: 64 } },
      'Primary GPU save clobbered unrelated profile graphics fields');
    assert.deepEqual(secondarySaved.graphics, { flipMode: 'vsync-off', frameLimit: { enabled: true, value: 72 } },
      'Primary GPU save changed the secondary GPU assignment');
    assert.equal(primarySaved.enabled, false, 'Editing sharpening unexpectedly enabled Use Profile');
    assert.deepEqual(globalValue, { enabled: true, percentage: 72 }, 'Per-game sharpening changed the global setting');
    assert.ok(gameWrites.length >= 2 && gameWrites.every((write) => write.enabled === false)
      && gameWrites.at(-1).settings.sharpening?.enabled === true
      && gameWrites.at(-1).settings.sharpening?.percentage === 64,
    `Saving an override while Use Profile is off must keep the native per-game scope disabled: ${JSON.stringify(gameWrites)}`);

    // Reopening the view must restore the stored value and GPU assignment.
    await js(`document.querySelector('.game-profile-back')?.click()`);
    await pause();
    await js(`Array.from(document.querySelectorAll('.game-catalog-card')).find((button) => (button.dataset.exePath ?? '').toLowerCase().endsWith('cyberpunk2077.exe'))?.click()`);
    await waitFor(`document.querySelector('.profile-sharpening-slider')?.value === '64'`, 'Per-game sharpening did not survive closing and reopening the profile');
    saved = await gameProfiles.loadCatalog();
    savedGame = saved.settings.find((item) => item.exePath === cyberpunk.exePath);
    assert.equal(savedGame.gpuProfiles.find((gpu) => gpu.deviceKey === primary.deviceKey).graphics.sharpening.percentage, 64);
    assert.deepEqual(savedGame.gpuProfiles.find((gpu) => gpu.deviceKey === secondary.deviceKey).graphics,
      { flipMode: 'vsync-off', frameLimit: { enabled: true, value: 72 } },
      'Saving sharpening to the visible GPU changed the independently persisted second GPU assignment');
    await prepareScreenshot(`.game-profile-detail .profile-setting-row:has(.profile-sharpening-slider)`);
    await screenshot('game-profile-sharpening-per-gpu.png');

    // Enable the primary assignment and prove the IPC path sends its own
    // graphics payload. Disabling it must retain profile fields and global.
    const writesBeforeEnable = gameWrites.length;
    await js(`document.querySelectorAll('.game-profile-gpu-switch button')[0]?.click()`);
    await waitFor(`document.querySelector('.profile-sharpening-slider')?.value === '64'`, 'Returning to primary GPU lost the 64% override');
    await js(`(() => { const input = document.querySelector('.game-use-profile'); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.game-use-profile')?.checked === true`, 'Use Profile did not enable');
    for (let attempt = 0; attempt < 60 && gameWrites.length === writesBeforeEnable; attempt += 1) await pause();
    assert.equal(gameWrites.length, writesBeforeEnable + 1, 'Enabling Use Profile did not call the mock per-game driver path');
    assert.equal(gameWrites[writesBeforeEnable].deviceId, primary.id);
    assert.equal(gameWrites[writesBeforeEnable].enabled, true);
    assert.equal(gameWrites[writesBeforeEnable].settings.sharpening.percentage, 64);
    await js(`(() => { const input = document.querySelector('.game-use-profile'); input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('.game-use-profile')?.checked === false`, 'Use Profile did not disable');
    for (let attempt = 0; attempt < 60 && gameWrites.length < writesBeforeEnable + 2; attempt += 1) await pause();
    assert.equal(gameWrites.length, writesBeforeEnable + 2, 'Disabling Use Profile did not call the scoped disable path');
    assert.equal(gameWrites[writesBeforeEnable + 1].enabled, false);
    saved = await gameProfiles.loadCatalog();
    savedGame = saved.settings.find((item) => item.exePath === cyberpunk.exePath);
    assert.equal(savedGame.gpuProfiles.find((gpu) => gpu.deviceKey === primary.deviceKey).enabled, false);
    assert.equal(savedGame.gpuProfiles.find((gpu) => gpu.deviceKey === primary.deviceKey).graphics.sharpening.percentage, 64);
    assert.deepEqual(globalValue, { enabled: true, percentage: 72 }, 'Disabling a game override changed global sharpening');

    // General Graphics page: off/on switch and 0-100 integer slider; actual
    // drag-like range input must dirty the per-control Apply and round-trip.
    await js(`location.hash = '#/graphics'`);
    await waitFor(`!!document.querySelector('.graphics-card[data-control="sharpening"]')`, 'Global sharpening did not appear on Graphics > General');
    const globalSlider = await js(`document.querySelector('.graphics-card[data-control="sharpening"] input[type="range"]')?.outerHTML ?? null`);
    assert.match(globalSlider ?? '', /min="0"/);
    assert.match(globalSlider ?? '', /max="100"/);
    assert.match(globalSlider ?? '', /step="1"/);
    assert.equal(await js(`document.querySelector('.graphics-card[data-control="sharpening"] [data-graphics-toggle="sharpening"]')?.value`), 'on',
      'Global sharpening must have a separate enable switch');
    await js(`(() => { const toggle = document.querySelector('.graphics-card[data-control="sharpening"] [data-graphics-toggle="sharpening"]'); toggle.click(); document.querySelector('.shared-dropdown-menu [role="option"][data-value="off"]')?.click(); })()`);
    assert.equal(await js(`document.querySelector('.graphics-card[data-control="sharpening"] .graphics-fps-slider-row')?.hidden`), true,
      `Turning global sharpening off did not hide its strength slider: ${JSON.stringify(await js(`({ toggle: document.querySelector('.graphics-card[data-control="sharpening"] [data-graphics-toggle="sharpening"]')?.value, row: document.querySelector('.graphics-card[data-control="sharpening"] .graphics-fps-slider-row')?.outerHTML })`))}`);
    await js(`(() => { const toggle = document.querySelector('.graphics-card[data-control="sharpening"] [data-graphics-toggle="sharpening"]'); toggle.click(); document.querySelector('.shared-dropdown-menu [role="option"][data-value="on"]')?.click(); })()`);
    assert.equal(await js(`document.querySelector('.graphics-card[data-control="sharpening"] .graphics-fps-slider-row')?.hidden`), false,
      'Turning global sharpening on did not reveal its strength slider');
    await waitFor(`document.querySelector('.graphics-card[data-control="sharpening"] input[type="range"]')?.value === '72'`, 'Global setting did not read back as 72%');
    await prepareScreenshot('.graphics-card[data-control="sharpening"]');
    await screenshot('graphics-general-sharpening.png');
    await js(`(() => { const slider = document.querySelector('.graphics-card[data-control="sharpening"] input[type="range"]'); slider.value = '83'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await js(`document.querySelector('.graphics-card[data-control="sharpening"] input[type="range"]')?.getAttribute('aria-valuetext')`), '83%');
    assert.equal(await js(`document.querySelector('.graphics-card[data-control="sharpening"] .graphics-fps-value')?.textContent`), '83%');
    assert.equal(await js(`document.querySelector('.graphics-card[data-control="sharpening"] .oc-chip-apply')?.hidden`), false,
      'Changing the slider did not expose the sharpening Apply button');
    await js(`document.querySelector('.graphics-card[data-control="sharpening"] .oc-chip-apply')?.click()`);
    await waitFor(`window.arcPower.graphicsGet(0).then((state) => state.values.sharpening?.percentage === 83)`, 'Global 83% Apply did not refresh to applied state');
    await waitFor(`document.querySelector('.graphics-card[data-control="sharpening"] .oc-chip-apply')?.hidden === true && document.querySelector('.graphics-card[data-control="sharpening"] .oc-chip-status')?.textContent === 'Applied'`,
      'Global sharpening per-control Apply did not finish its applied read-back');
    assert.equal(await js(`document.querySelector('.graphics-card[data-control="sharpening"] .graphics-fps-value')?.textContent`), '83%',
      'Global sharpening percentage readout did not retain the applied value');
    assert.deepEqual(globalWrites.at(-1), { deviceId: primary.id, settings: { sharpening: { enabled: true, percentage: 83 } } },
      'Global Apply sent an unexpected payload or lost the enable switch');
    assert.equal(await js(`document.querySelector('.graphics-card[data-control="sharpening"] .oc-chip-apply')?.hidden`), true,
      'Applied global slider remained dirty');
    const applyVisibility = await js(`({ pageApplyVisible: document.querySelector('.graphics-general-actions .floating-apply')?.hidden === false, dirtyCards: Array.from(document.querySelectorAll('.graphics-card')).filter((card) => card.querySelector('.oc-chip-apply')?.hidden === false).map((card) => card.dataset.control ?? card.querySelector('.card-title')?.textContent ?? 'unknown') })`);
    process.stdout.write(`[sharpening-ui] graphics page Apply QA: ${JSON.stringify(applyVisibility)}\n`);
    assert.ok(!applyVisibility.pageApplyVisible || applyVisibility.dirtyCards.length > 0,
      `The page-level Graphics Apply remained visible without any dirty per-control Apply: ${JSON.stringify(applyVisibility)}`);
    await prepareScreenshot('.graphics-card[data-control="sharpening"]');
    await screenshot('graphics-general-sharpening-applied.png');

    // Revert global state to the runner's isolated initial value before exit.
    globalValue = { enabled: false, percentage: 38 };
  } finally {
    backend.getGraphicsSettings = originalGetGraphics;
    backend.setGraphicsSettings = originalSetGraphics;
    backend.getGameProfileCapabilities = originalGameCaps;
    backend.setGameProfileSettings = originalSetGame;
  }
}
