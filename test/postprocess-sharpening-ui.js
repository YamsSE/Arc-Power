// Focused UI verification of global and per-game screen sharpening controls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function verifyPostprocessSharpeningUi(win, postprocessSharpening, _gameProfiles, backend) {
  win.webContents.on('console-message', (event) => {
    process.stdout.write(`[postprocess-sharpening-ui] renderer console ${event.level} ${event.sourceId}:${event.lineNumber}: ${event.message}\n`);
  });
  const js = async (code) => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (error) { process.stdout.write(`[postprocess-sharpening-ui] executeJavaScript failed: ${code}\n${error?.stack ?? error}\n`); throw error; }
  };
  const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
  const chooseMode = async (label, value) => js(`(() => {
    const control = document.querySelector('.sharpening-card [role="combobox"][aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
    if (!control) throw new Error('Missing sharpening mode: ' + ${JSON.stringify(label)});
    control.click();
    const option = control.options.find((item) => item.dataset.value === ${JSON.stringify(value)});
    if (!option) throw new Error('Missing sharpening mode value: ' + ${JSON.stringify(value)});
    option.click();
  })()`);
  const applyCard = async () => js(`Array.from(document.querySelectorAll('.sharpening-card .graphics-card-actions button')).find((button) => button.textContent.trim() === 'Apply')?.click()`);
  let legacyGraphicsWrites = 0;
  const originalSetGraphicsSettings = backend.setGraphicsSettings;
  const originalGetGlobal = postprocessSharpening.getGlobal;
  let holdInitialGlobalRead = false;
  let releaseInitialGlobalRead;
  let signalInitialGlobalReadStarted;
  const initialGlobalReadGate = new Promise((resolve) => { releaseInitialGlobalRead = resolve; });
  const initialGlobalReadStarted = new Promise((resolve) => { signalInitialGlobalReadStarted = resolve; });
  postprocessSharpening.getGlobal = async function(...args) {
    if (holdInitialGlobalRead) {
      holdInitialGlobalRead = false;
      signalInitialGlobalReadStarted();
      await initialGlobalReadGate;
    }
    return originalGetGlobal.apply(this, args);
  };
  backend.setGraphicsSettings = async function(...args) {
    legacyGraphicsWrites += 1;
    return originalSetGraphicsSettings.apply(this, args);
  };
  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await js(expression)) return;
      await pause();
    }
    assert.fail(`${message}; state=${JSON.stringify(await js(`(async () => ({ hash: location.hash, title: document.querySelector('.page-title')?.textContent ?? null, page: (document.getElementById('page')?.textContent ?? '').slice(0, 500), catalog: await window.arcPower.gameCatalogList().catch((error) => String(error)) }))()`))}`);
  };
  const screenshot = async (name, selector) => {
    const directory = path.resolve('.codex/task-artifacts/sharpening-card-layout');
    fs.mkdirSync(directory, { recursive: true });
    const visible = await js(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target || target.getClientRects().length === 0) return false; document.querySelectorAll('.toast').forEach((item) => item.remove()); target.scrollIntoView({ block: 'center', inline: 'center' }); return true; })()`);
    assert.equal(visible, true, `Screenshot target was not visible: ${selector}`);
    await pause();
    const image = await win.webContents.capturePage();
    const file = path.join(directory, name);
    fs.writeFileSync(file, image.toPNG());
    return file;
  };

  try {
    await waitFor(`document.getElementById('page')?.textContent?.includes('Active device') && document.getElementById('page')?.textContent?.includes('Dashboard')`, 'Mock renderer did not finish startup');
    await js(`window.arcPower.waiverAccept(0)`);
    holdInitialGlobalRead = true;
    await js(`location.hash = '#/graphics'`);
    await Promise.race([
      initialGlobalReadStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Initial sharpening settings read did not start')), 3000)),
    ]);
    postprocessSharpening.setRuntimeStatusForTest({ active: true, reason: null });
    await pause();
    releaseInitialGlobalRead();
    await waitFor(`location.hash === '#/graphics' && document.getElementById('page')?.textContent?.includes('Image Sharpening') && !!document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')`, 'Graphics page or global sharpening control did not render');
    await waitFor(`document.querySelector('.sharpening-runtime-status')?.textContent?.includes('Sharpening is active')`, 'A runtime status event delivered before the initial settings read was lost');

    const initialGlobal = await postprocessSharpening.getGlobal();
    assert.deepEqual(initialGlobal.value, { enabled: false, percentage: 50 });
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.min`), '0');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.max`), '100');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.step`), '1');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.getAttribute('aria-valuetext')`), '50%');
    assert.equal(await js(`document.querySelector('.sharpening-card [role="combobox"]')?.dataset.value`), 'off');
    const globalHelp = await js(`document.querySelector('.sharpening-card .sharpening-help')?.textContent ?? ''`);
    assert.match(globalHelp, /only the foreground game/i);
    assert.match(globalHelp, /display connected to Intel Arc/i);
    assert.match(globalHelp, /No capture prompt/i);
    assert.match(globalHelp, /setup download/i);
    assert.match(globalHelp, /game-folder files/i);
    assert.match(globalHelp, /Windowed, borderless, and fullscreen/i);
    assert.match(globalHelp, /exclusive fullscreen capture can vary/i);
    await screenshot('global-sharpening-initial.png', '.sharpening-card');

    // Slider edits remain drafts until Apply is clicked.
    await chooseMode('Image Sharpening', 'on');
    assert.equal((await postprocessSharpening.getGlobal()).value.enabled, false, 'Changing mode applied without Apply');
    await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]'); input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal((await postprocessSharpening.getGlobal()).value.percentage, 50, 'Editing the global slider applied without user action');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.enabled === true && state.value.percentage === 0)`, 'Global 0% setting did not Apply');
    assert.equal(legacyGraphicsWrites, 0, 'Global sharpening Apply routed a write to the legacy graphics backend');
    await js(`location.hash = '#/dashboard'`);
    await pause();
    await js(`location.hash = '#/graphics'`);
    await waitFor(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.value === '0'`, 'Global value did not persist after reopening Graphics');
    assert.equal(await js(`document.querySelector('.sharpening-card [role="combobox"]')?.dataset.value`), 'on');
    await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]'); input.value = '100'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.percentage === 100)`, 'Global 100% did not Apply');
    assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 100 });
    assert.equal(legacyGraphicsWrites, 0, 'Global sharpening Apply routed a write to the legacy graphics backend');
    postprocessSharpening.setRuntimeStatusForTest({ active: true, reason: null });
    await waitFor(`document.querySelector('.sharpening-runtime-status')?.textContent?.includes('Sharpening is active')`, 'Global sharpening runtime status did not update to active');
    postprocessSharpening.setRuntimeStatusForTest({ active: false, reason: 'Screen capture is unavailable.' });
    await waitFor(`document.querySelector('.sharpening-runtime-status')?.textContent === 'Screen capture is unavailable.'`, 'Global sharpening runtime error did not reach Graphics');
    postprocessSharpening.setRuntimeStatusForTest({ active: false, reason: null });
    await waitFor(`document.querySelector('.sharpening-runtime-status')?.textContent?.includes('Applies only to recognized games')`, 'Global sharpening runtime status did not recover to idle');
    await screenshot('global-sharpening-100.png', '.sharpening-card');

    // A game profile has an override slider immediately; no setup action is
    // needed. Actual support and image quality remain game/runtime dependent.
    await js(`location.hash = '#/profiles'`);
    await waitFor(`location.hash === '#/profiles' && document.querySelector('.page-title')?.textContent === 'Profiles' && !!document.querySelector('.profiles-mode-toggle')`, 'Profiles page did not render');
    await js(`Array.from(document.querySelectorAll('.profiles-mode-toggle button')).find((button) => button.textContent.trim() === 'Game Profile')?.click()`);
    await waitFor(`document.querySelectorAll('.game-catalog-card').length > 0`, 'Mock game catalog did not populate');
    const catalog = await js(`window.arcPower.gameCatalogList()`);
    const game = catalog.catalog.find((entry) => typeof entry.exePath === 'string' && entry.exePath.toLowerCase().endsWith('.exe'));
    assert.ok(game, `Mock catalog did not expose a fixture executable path: ${JSON.stringify(catalog.catalog)}`);
    await js(`Array.from(document.querySelectorAll('.game-catalog-card')).find((button) => button.dataset.exePath === ${JSON.stringify(game.exePath)})?.click()`);
    await waitFor(`document.querySelector('.page-title')?.textContent === 'Profiles' && !!document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')`, 'Per-game sharpening slider did not render');
    let gameState = await postprocessSharpening.getGame(game.exePath);
    assert.equal(gameState.override, null, 'Fresh game profile should inherit the global value');
    assert.deepEqual(gameState.effective, { enabled: true, percentage: 100 });
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')?.min`), '0');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')?.max`), '100');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')?.step`), '1');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')?.disabled`), true);
    const gameHelp = await js(`document.querySelector('.sharpening-card .sharpening-help')?.textContent ?? ''`);
    assert.match(gameHelp, /foreground window/i);
    assert.match(gameHelp, /global Image Sharpening switch/i);
    await screenshot('game-sharpening-inherited-global.png', '.sharpening-card');

    // Disable global inheritance, then apply a 0% override and verify it does
    // not mutate the global setting. Re-enabling inheritance restores global.
    await chooseMode('Per-game Image Sharpening', 'on');
    assert.equal((await postprocessSharpening.getGame(game.exePath)).override, null, 'Changing inheritance applied without Apply');
    await waitFor(`document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')?.disabled === false`, 'Per-game override controls did not enable');
    await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]'); input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.percentage === 0)`, 'Per-game 0% override did not Apply');
    await chooseMode('Per-game Image Sharpening', 'off');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.enabled === false && state.override?.percentage === 0)`, 'Disabling the override lost its 0% strength');
    await chooseMode('Per-game Image Sharpening', 'on');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.enabled === true && state.override?.percentage === 0)`, 'Re-enabling the override lost its 0% strength');
    assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 100 }, 'Per-game override changed global sharpening');
    await screenshot('game-sharpening-override-0.png', '.sharpening-card');
    await js(`Array.from(document.querySelectorAll('.sharpening-card .graphics-card-actions button')).find((button) => button.textContent.trim() === 'Reset to default')?.click()`);
    assert.notEqual((await postprocessSharpening.getGame(game.exePath)).override, null, 'Per-game reset applied before Apply');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override === null && state.effective.percentage === 100)`, 'Returning to global inheritance did not clear the override');
    gameState = await postprocessSharpening.getGame(game.exePath);
    assert.equal(gameState.override, null);

    await js(`location.hash = '#/graphics'`);
    await waitFor(`location.hash === '#/graphics' && document.getElementById('page')?.textContent?.includes('Image Sharpening') && !!document.querySelector('.sharpening-card')`, 'Graphics page did not reopen');
    assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 100 });
    await js(`Array.from(document.querySelectorAll('.sharpening-card .graphics-card-actions button')).find((button) => button.textContent.trim() === 'Reset to default')?.click()`);
    assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 100 }, 'Global reset applied before Apply');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => !state.value.enabled && state.value.percentage === 50)`, 'Global reset did not restore defaults on Apply');
    assert.equal(legacyGraphicsWrites, 0, 'Sharpening UI routed changes to driver graphics settings');
  } finally {
    releaseInitialGlobalRead();
    postprocessSharpening.getGlobal = originalGetGlobal;
    backend.setGraphicsSettings = originalSetGraphicsSettings;
  }
}
