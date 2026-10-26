// Focused UI verification of global and per-game screen sharpening controls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

export async function verifyPostprocessSharpeningUi(win, postprocessSharpening, _gameProfiles, backend) {
  const makeGate = () => {
    let release;
    let signalStarted;
    const promise = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { signalStarted = resolve; });
    return { promise, started, release, signalStarted };
  };
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
  const chooseGraphicsMode = async (label, value) => js(`(() => {
    const control = document.querySelector('.graphics-stack [role="combobox"][aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
    if (!control) throw new Error('Missing graphics mode: ' + ${JSON.stringify(label)});
    control.click();
    const option = control.options.find((item) => item.dataset.value === ${JSON.stringify(value)});
    if (!option) throw new Error('Missing graphics mode value: ' + ${JSON.stringify(value)});
    option.click();
  })()`);
  const applyCard = async () => js(`Array.from(document.querySelectorAll('.sharpening-card .graphics-card-actions button')).find((button) => button.textContent.trim() === 'Apply')?.click()`);
  let legacyGraphicsWrites = 0;
  let driverWriteBaseline = 0;
  const originalSetGraphicsSettings = backend.setGraphicsSettings;
  const originalGetGraphicsSettings = backend.getGraphicsSettings;
  const originalSetGlobal = postprocessSharpening.setGlobal;
  const originalGetGlobal = postprocessSharpening.getGlobal;
  const screenPauseReason = 'Arc Image Sharpening is paused because the desktop capture overlay causes game frame-pacing and input-latency regressions. A safe native game-sharpening path is not available on the current Intel driver.';
  let forcePausedStateForTest = false;
  const withPausedScreenState = (state) => forcePausedStateForTest
    ? { ...state, runtimeReady: false, reason: screenPauseReason }
    : state;
  let failNextGlobalSet = false;
  let holdNextGlobalSet = false;
  let releaseGlobalSet;
  let signalGlobalSetStarted;
  const globalSetGate = new Promise((resolve) => { releaseGlobalSet = resolve; });
  const globalSetStarted = new Promise((resolve) => { signalGlobalSetStarted = resolve; });
  let failCombinedGlobalSet = false;
  let holdCombinedGlobalSet = false;
  let combinedGlobalSetGate = makeGate();
  let holdGraphicsSet = false;
  let graphicsSetGate = makeGate();
  let failNextGraphicsGet = false;
  const originalSetAsr = postprocessSharpening.setAsr;
  let releaseAsrSave = () => {};
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
    return withPausedScreenState(await originalGetGlobal.apply(this, args));
  };
  postprocessSharpening.setGlobal = async function(...args) {
    if (failNextGlobalSet) { failNextGlobalSet = false; throw new Error('Mock screen-sharpening write failed.'); }
    if (holdCombinedGlobalSet) {
      holdCombinedGlobalSet = false;
      combinedGlobalSetGate.signalStarted();
      await combinedGlobalSetGate.promise;
      if (failCombinedGlobalSet) { failCombinedGlobalSet = false; throw new Error('Mock combined screen-sharpening write failed.'); }
    }
    if (holdNextGlobalSet) {
      holdNextGlobalSet = false;
      signalGlobalSetStarted();
      await globalSetGate;
    }
    return withPausedScreenState(await originalSetGlobal.apply(this, args));
  };
  backend.setGraphicsSettings = async function(...args) {
    legacyGraphicsWrites += 1;
    if (holdGraphicsSet) {
      holdGraphicsSet = false;
      graphicsSetGate.signalStarted();
      await graphicsSetGate.promise;
    }
    return originalSetGraphicsSettings.apply(this, args);
  };
  backend.getGraphicsSettings = async function(...args) {
    if (failNextGraphicsGet) {
      failNextGraphicsGet = false;
      throw new Error('Mock graphics capabilities read failed.');
    }
    return originalGetGraphicsSettings.apply(this, args);
  };
  const waitFor = async (expression, message) => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      if (await js(expression)) return;
      await pause();
    }
    assert.fail(`${message}; state=${JSON.stringify(await js(`(async () => ({ hash: location.hash, title: document.querySelector('.page-title')?.textContent ?? null, runtimeStatus: document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent ?? null, page: (document.getElementById('page')?.textContent ?? '').slice(0, 500), catalog: await window.arcPower.gameCatalogList().catch((error) => String(error)) }))()`))}`);
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
    await waitFor(`(async () => !!document.querySelector('.gpu-header-gpu-pill') && Number.isInteger((await window.arcPower.deviceGet()).deviceId))()`, 'Mock renderer did not select its B580 device');
    await js(`window.arcPower.waiverAccept(0)`);
    holdInitialGlobalRead = true;
    forcePausedStateForTest = true;
    await js(`location.hash = '#/graphics'`);
    await Promise.race([
      initialGlobalReadStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Initial sharpening settings read did not start')), 3000)),
    ]);
    postprocessSharpening.setRuntimeStatusForTest({ active: true, mode: 'sharpening', reason: null });
    await pause();
    releaseInitialGlobalRead();
    await waitFor(`!!document.querySelector('.asr-card [aria-label="Arc Super Resolution"]')`, 'Arc Super Resolution control did not render');
    const asrHelp = await js(`document.querySelector('.asr-card .sharpening-help')?.textContent ?? ''`);
    assert.match(asrHelp, /smaller window while the desktop remains at its native resolution/i);
    assert.match(asrHelp, /fits that game window to the display and passes native input through/i);
    assert.match(asrHelp, /display-filling borderless window has no smaller image to scale/i);
    assert.match(asrHelp, /exclusive fullscreen may change the active display mode/i);
    assert.doesNotMatch(asrHelp, /Lanczos|captures? that smaller window|raw-input|DirectInput|mapped to the smaller window/i);
    await waitFor(`location.hash === '#/graphics' && document.getElementById('page')?.textContent?.includes('Arc Image Sharpening') && !!document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]')`, 'Graphics page or global sharpening control did not render');
    assert.equal(await js(`document.querySelector('.graphics-page-hero')?.textContent?.includes('No GPU available')`), false, 'Combined graphics verification requires the selected B580 device');
    await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent === ${JSON.stringify(screenPauseReason)}`, 'Initial screen-sharpening pause reason was lost when an earlier runtime event was merged');
    for (const status of [
      { active: true, mode: 'asr', reason: null },
      { active: false, mode: 'asr', reason: 'Synthetic ASR capture fault' },
      { active: false, mode: 'asr', reason: null },
    ]) {
      postprocessSharpening.setRuntimeStatusForTest(status);
      await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent === ${JSON.stringify(screenPauseReason)}`, 'ASR runtime status replaced the global screen-sharpening pause explanation');
    }
    await applyCard();
    await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent === ${JSON.stringify(screenPauseReason)}`, 'Apply response or settings push replaced the global screen-sharpening pause explanation');
    forcePausedStateForTest = false;
    postprocessSharpening.setRuntimeStatusForTest({ active: true, mode: 'sharpening', reason: null });
    await js(`location.hash = '#/dashboard'`);
    await pause();
    await js(`location.hash = '#/graphics'`);
    await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent?.includes('Applies only to recognized games')`, 'Global screen-sharpening status did not recover to idle after the paused settings state');
    if (process.env.RID_MOCK_POSTPROCESS_RENDERER_PROOF === '1') {
      postprocessSharpening.setRuntimeStatusForTest({ active: true, mode: 'sharpening', reason: null });
      await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent?.includes('Sharpening is active')`, 'Global sharpening runtime status did not update to active');
      postprocessSharpening.setRuntimeStatusForTest({ active: false, mode: 'sharpening', reason: 'Screen capture is unavailable.' });
      await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent === 'Screen capture is unavailable.'`, 'Global sharpening runtime error did not reach Graphics');
      postprocessSharpening.setRuntimeStatusForTest({ active: false, mode: 'sharpening', reason: null });
      await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent?.includes('Applies only to recognized games')`, 'Global sharpening runtime status did not recover to idle');
      process.stdout.write('[postprocess-sharpening-ui] PASS: paused screen-sharpening reason survives initial read, ASR status, settings push, and Apply response\n');
      return;
    }

    // Establish the supported driver's accepted baseline first. The shared
    // Graphics Apply can be dirty against an empty applied reference on first
    // load, which would otherwise make a screen-card click combined by design.
    if (await js(`document.querySelector('.floating-apply')?.hidden === false`)) {
      await js(`document.querySelector('.floating-apply')?.click()`);
      await waitFor(`document.querySelector('.floating-apply')?.hidden === true`, 'Initial driver baseline did not settle');
    }
    driverWriteBaseline = legacyGraphicsWrites;

    const initialGlobal = await postprocessSharpening.getGlobal();
    assert.deepEqual(initialGlobal.value, { enabled: false, percentage: 50 });
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]')?.min`), '0');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]')?.max`), '100');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]')?.step`), '1');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]')?.getAttribute('aria-valuetext')`), '50%');
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

    // The Graphics-level Apply also owns screen-only drafts, without routing
    // the screen value through the legacy driver graphics IPC.
    await chooseMode('Arc Image Sharpening', 'on');
    await waitFor(`document.querySelector('.floating-apply')?.hidden === false`, 'Screen-only sharpening draft did not surface the Graphics Apply button');
    failNextGlobalSet = true;
    await js(`document.querySelector('.floating-apply')?.click()`);
    await waitFor(`Array.from(document.querySelectorAll('.toast-message')).some((node) => node.textContent.includes('Mock screen-sharpening write failed'))`, 'Failed global apply did not surface its reason');
    assert.equal(await js(`document.querySelector('.floating-apply')?.hidden`), false, 'Failed screen-only draft disappeared from Graphics Apply');
    holdNextGlobalSet = true;
    await js(`document.querySelector('.floating-apply')?.click()`);
    await Promise.race([globalSetStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('Global sharpening apply did not enter the busy state')), 3000))]);
    assert.equal(await js(`document.querySelector('.floating-apply')?.disabled`), true, 'Graphics Apply stayed clickable while sharpening was busy');
    assert.equal(await js(`document.querySelector('.floating-apply')?.textContent`), 'Applying…', 'Graphics Apply did not show its busy label');
    releaseGlobalSet();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.enabled === true && state.value.percentage === 50)`, 'Graphics Apply did not save the screen-only sharpening draft');
    await waitFor(`document.querySelector('.floating-apply')?.hidden === true`, 'Graphics Apply did not hide after the sharpening draft was saved');
    await waitFor(`document.querySelector('.sharpening-card:not(.sharpening-game-card) .graphics-card-actions .btn-primary')?.textContent === 'Applied'`, 'Global sharpening card did not show inline Applied feedback');
    await waitFor(`Array.from(document.querySelectorAll('.toast-title')).some((node) => node.textContent.includes('Arc Image Sharpening saved'))`, 'Global sharpening did not show save feedback');
    assert.equal(legacyGraphicsWrites, driverWriteBaseline, 'Screen-only Graphics Apply routed a write through legacy graphics settings');
    await chooseMode('Arc Image Sharpening', 'off');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.enabled === false)`, 'Global card Apply did not restore the off baseline');

    // Slider edits remain drafts until Apply is clicked.
    assert.equal(await js(`document.querySelector('.sharpening-card .card-title')?.textContent`), 'Arc Image Sharpening');
    await chooseMode('Arc Image Sharpening', 'on');
    assert.equal((await postprocessSharpening.getGlobal()).value.enabled, false, 'Changing mode applied without Apply');
    await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]'); input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal((await postprocessSharpening.getGlobal()).value.percentage, 50, 'Editing the global slider applied without user action');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.enabled === true && state.value.percentage === 0)`, 'Global 0% setting did not Apply');
    assert.equal(legacyGraphicsWrites, driverWriteBaseline, 'Global sharpening Apply routed a write to the legacy graphics backend');
    await js(`location.hash = '#/dashboard'`);
    await pause();
    await js(`location.hash = '#/graphics'`);
    await waitFor(`document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]')?.value === '0'`, 'Global value did not persist after reopening Graphics');
    assert.equal(await js(`document.querySelector('.sharpening-card [role="combobox"]')?.dataset.value`), 'on');
    await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]'); input.value = '100'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.percentage === 100)`, 'Global 100% did not Apply');
    assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 100 });
    assert.equal(legacyGraphicsWrites, driverWriteBaseline, 'Global sharpening Apply routed a write to the legacy graphics backend');

    // Combined driver + screen Apply is gated so the graphics self-push
    // occurs while the screen card is still in flight. The card node must
    // survive renderCards(), and view changes remain blocked until both
    // independent APIs settle.
    await chooseMode('Arc Image Sharpening', 'off');
    await chooseGraphicsMode('Low Latency Mode', 'on');
    await waitFor(`!document.querySelector('.floating-apply')?.hidden`, 'Combined driver and sharpening drafts did not expose Graphics Apply');
    await js(`window.__sharpCardBeforeCombined = document.querySelector('.sharpening-card')`);
    holdCombinedGlobalSet = true;
    holdGraphicsSet = true;
    await js(`document.querySelector('.floating-apply')?.click()`);
    await Promise.all([
      Promise.race([combinedGlobalSetGate.started, new Promise((_, reject) => setTimeout(() => reject(new Error('Combined sharpening API did not start')), 3000))]),
      Promise.race([graphicsSetGate.started, new Promise((_, reject) => setTimeout(() => reject(new Error('Combined graphics API did not start')), 3000))]),
    ]);
    assert.equal(await js(`document.querySelector('.floating-apply')?.disabled`), true, 'Combined Apply stayed enabled while busy');
    assert.equal(await js(`document.querySelector('.floating-apply')?.textContent`), 'Applying…', 'Combined Apply did not show Applying');
    assert.equal(await js(`Array.from(document.querySelectorAll('.graphics-view-btn')).every((button) => button.disabled)`), true, 'Graphics view switches were not blocked while Apply was busy');
    await js(`document.querySelector('.graphics-view-btn[data-view="display"]')?.click()`);
    assert.equal(await js(`document.querySelector('.graphics-view-btn[data-view="settings"]')?.classList.contains('active')`), true, 'Graphics view switched during Apply');
    graphicsSetGate.release();
    await waitFor(`window.arcPower.graphicsGet(0).then((state) => state.values.lowLatency === 'on')`, 'Driver half of combined Apply did not complete');
    assert.equal(await js(`document.querySelector('.sharpening-card') === window.__sharpCardBeforeCombined`), true, 'Driver self-push replaced the in-flight sharpening card');
    combinedGlobalSetGate.release();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.enabled === false)`, 'Screen half of combined Apply did not complete');
    await waitFor(`document.querySelector('.floating-apply')?.hidden === true`, 'Combined Apply did not clear both successful drafts');
    await waitFor(`Array.from(document.querySelectorAll('.graphics-view-btn')).every((button) => !button.disabled)`, 'Graphics view buttons remained disabled after Apply');

    // A screen failure after the driver self-push keeps its draft and error
    // feedback attached to the preserved card, with shared Apply available.
    await chooseMode('Arc Image Sharpening', 'on');
    await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Arc Image Sharpening strength"]'); input.value = '75'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await chooseGraphicsMode('Low Latency Mode', 'off');
    combinedGlobalSetGate = makeGate();
    graphicsSetGate = makeGate();
    failCombinedGlobalSet = true;
    holdCombinedGlobalSet = true;
    holdGraphicsSet = true;
    await js(`window.__sharpCardBeforeFailure = document.querySelector('.sharpening-card'); document.querySelector('.floating-apply')?.click()`);
    await Promise.all([
      Promise.race([combinedGlobalSetGate.started, new Promise((_, reject) => setTimeout(() => reject(new Error('Combined failure sharpening API did not start')), 3000))]),
      Promise.race([graphicsSetGate.started, new Promise((_, reject) => setTimeout(() => reject(new Error('Combined failure graphics API did not start')), 3000))]),
    ]);
    graphicsSetGate.release();
    await waitFor(`window.arcPower.graphicsGet(0).then((state) => state.values.lowLatency === 'off')`, 'Driver half of combined failure scenario did not self-push');
    assert.equal(await js(`document.querySelector('.sharpening-card') === window.__sharpCardBeforeFailure`), true, 'Driver self-push replaced sharpening card before failed result');
    combinedGlobalSetGate.release();
    await waitFor(`Array.from(document.querySelectorAll('.toast-message')).some((node) => node.textContent.includes('Mock combined screen-sharpening write failed'))`, 'Combined screen failure reason was lost');
    assert.equal(await js(`document.querySelector('.sharpening-card') === window.__sharpCardBeforeFailure`), true, 'Failed sharpening card was replaced after self-push');
    assert.equal(await js(`document.querySelector('.floating-apply')?.hidden`), false, 'Failed combined screen draft disappeared from shared Apply');
    assert.equal(await js(`document.querySelector('.sharpening-card .text-error')?.textContent?.includes('Mock combined screen-sharpening write failed')`), true, 'Inline sharpening failure feedback was lost');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.enabled === true && state.value.percentage === 75)`, 'Retry after combined screen failure did not save the draft');
    driverWriteBaseline = legacyGraphicsWrites;

    postprocessSharpening.setRuntimeStatusForTest({ active: true, reason: null });
    await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent?.includes('Sharpening is active')`, 'Global sharpening runtime status did not update to active');
    postprocessSharpening.setRuntimeStatusForTest({ active: false, reason: 'Screen capture is unavailable.' });
    await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent === 'Screen capture is unavailable.'`, 'Global sharpening runtime error did not reach Graphics');
    postprocessSharpening.setRuntimeStatusForTest({ active: false, reason: null });
    await waitFor(`document.querySelector('.sharpening-card .sharpening-runtime-status')?.textContent?.includes('Applies only to recognized games')`, 'Global sharpening runtime status did not recover to idle');
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
    await waitFor(`document.querySelector('.page-title')?.textContent === 'Profiles' && !!document.querySelector('.sharpening-card input[aria-label="Per-game Arc Image Sharpening strength"]')`, 'Per-game sharpening slider did not render');
    let gameState = await postprocessSharpening.getGame(game.exePath);
    assert.equal(gameState.override, null, 'Fresh game profile should inherit the global value');
    assert.deepEqual(gameState.effective, { enabled: true, percentage: 75 });
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game Arc Image Sharpening strength"]')?.min`), '0');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game Arc Image Sharpening strength"]')?.max`), '100');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game Arc Image Sharpening strength"]')?.step`), '1');
    assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game Arc Image Sharpening strength"]')?.disabled`), true);
    const gameHelp = await js(`document.querySelector('.sharpening-card .sharpening-help')?.textContent ?? ''`);
    assert.match(gameHelp, /foreground window/i);
    assert.match(gameHelp, /global Arc Image Sharpening switch/i);
    await screenshot('game-sharpening-inherited-global.png', '.sharpening-card');

    // Disable global inheritance, then apply a 0% override and verify it does
    // not mutate the global setting. Re-enabling inheritance restores global.
    assert.equal(await js(`document.querySelector('.sharpening-game-card .card-title')?.textContent`), 'Arc Image Sharpening');
    await chooseMode('Per-game Arc Image Sharpening', 'on');
    assert.equal((await postprocessSharpening.getGame(game.exePath)).override, null, 'Changing inheritance applied without Apply');
    await waitFor(`document.querySelector('.sharpening-card input[aria-label="Per-game Arc Image Sharpening strength"]')?.disabled === false`, 'Per-game override controls did not enable');
    await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Per-game Arc Image Sharpening strength"]'); input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.percentage === 0)`, 'Per-game 0% override did not Apply');
    await waitFor(`document.querySelector('.sharpening-game-card .graphics-card-actions .btn-primary')?.textContent === 'Applied'`, 'Per-game sharpening card did not show inline Applied feedback');
    await waitFor(`Array.from(document.querySelectorAll('.toast-title')).some((node) => node.textContent.includes('Per-game sharpening saved'))`, 'Per-game sharpening did not show save feedback');
    await chooseMode('Per-game Arc Image Sharpening', 'off');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.enabled === false && state.override?.percentage === 0)`, 'Disabling the override lost its 0% strength');
    await chooseMode('Per-game Arc Image Sharpening', 'on');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.enabled === true && state.override?.percentage === 0)`, 'Re-enabling the override lost its 0% strength');
    assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 75 }, 'Per-game override changed global sharpening');
    await screenshot('game-sharpening-override-0.png', '.sharpening-card');
    await js(`Array.from(document.querySelectorAll('.sharpening-card .graphics-card-actions button')).find((button) => button.textContent.trim() === 'Reset to default')?.click()`);
    assert.notEqual((await postprocessSharpening.getGame(game.exePath)).override, null, 'Per-game reset applied before Apply');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override === null && state.effective.percentage === 75)`, 'Returning to global inheritance did not clear the override');
    gameState = await postprocessSharpening.getGame(game.exePath);
    assert.equal(gameState.override, null);

    await js(`location.hash = '#/graphics'`);
    await waitFor(`location.hash === '#/graphics' && document.getElementById('page')?.textContent?.includes('Arc Image Sharpening') && !!document.querySelector('.sharpening-card')`, 'Graphics page did not reopen');
    assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 75 });
    await js(`Array.from(document.querySelectorAll('.sharpening-card .graphics-card-actions button')).find((button) => button.textContent.trim() === 'Reset to default')?.click()`);
    assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 75 }, 'Global reset applied before Apply');
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => !state.value.enabled && state.value.percentage === 50)`, 'Global reset did not restore defaults on Apply');
    assert.equal(legacyGraphicsWrites, driverWriteBaseline, 'Sharpening UI routed changes to driver graphics settings');

    // A failed graphics capability read still leaves the independent screen
    // sharpening path editable through the shared Graphics Apply control.
    await js(`location.hash = '#/dashboard'`);
    await pause();
    failNextGraphicsGet = true;
    await js(`location.hash = '#/graphics'`);
    await waitFor(`document.querySelector('.text-error')?.textContent?.includes('Mock graphics capabilities read failed') && !!document.querySelector('.sharpening-card')`, 'Graphics read failure did not retain the screen sharpening card');
    await chooseMode('Arc Image Sharpening', 'on');
    await waitFor(`document.querySelector('.floating-apply')?.hidden === false`, 'Graphics read failure path did not expose screen-only Apply');
    await js(`document.querySelector('.floating-apply')?.click()`);
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.enabled)`, 'Screen sharpening did not save after graphics capability read failure');
    await waitFor(`document.querySelector('.floating-apply')?.hidden === true`, 'Screen-only Apply remained visible after save in graphics read failure path');
    assert.equal(legacyGraphicsWrites, driverWriteBaseline, 'Graphics read failure path routed screen sharpening through driver graphics settings');
    await js(`Array.from(document.querySelectorAll('.sharpening-card .graphics-card-actions button')).find((button) => button.textContent.trim() === 'Reset to default')?.click()`);
    await applyCard();
    await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => !state.value.enabled && state.value.percentage === 50)`, 'Graphics read failure fixture cleanup did not restore screen defaults');
    let signalAsrSaveStarted;
    const asrSaveStarted = new Promise((resolve) => { signalAsrSaveStarted = resolve; });
    const asrSaveGate = new Promise((resolve) => { releaseAsrSave = resolve; });
    postprocessSharpening.setAsr = async function(...args) {
      signalAsrSaveStarted();
      await asrSaveGate;
      return originalSetAsr.apply(this, args);
    };
    await js(`(() => { const control = document.querySelector('.asr-card [role="combobox"][aria-label="Arc Super Resolution"]'); control.click(); control.options.find((item) => item.dataset.value === 'on').click(); })()`);
    await js(`document.querySelector('.asr-card .asr-apply')?.click()`);
    await Promise.race([asrSaveStarted, new Promise((_, reject) => setTimeout(() => reject(new Error('ASR save did not start')), 3000))]);
    assert.equal(await js(`document.querySelector('.asr-card .asr-apply')?.textContent`), 'Applying…');
    assert.equal(await js(`document.querySelector('.asr-card .asr-apply')?.disabled`), true);
    assert.equal(await js(`document.querySelector('.asr-card [role="combobox"]')?.disabled`), true);
    assert.equal(await js(`Array.from(document.querySelectorAll('.asr-card .graphics-card-actions button')).every(button => button.disabled)`), true);
    releaseAsrSave();
    await waitFor(`window.arcPower.arcSuperResolutionGet().then((state) => state.value.enabled)`, 'Arc Super Resolution toggle did not persist');
    await waitFor(`document.querySelector('.asr-card .asr-apply')?.textContent === 'Applied' && !!Array.from(document.querySelectorAll('.toast-success')).find(item => item.textContent.includes('Arc Super Resolution preference saved') && item.textContent.includes('Waiting for a recognized game'))`, 'ASR save did not show Applied and an honest waiting toast');
    postprocessSharpening.setRuntimeStatusForTest({ active: false, mode: 'asr', reason: 'Synthetic capture warning' });
    await waitFor(`document.querySelector('.asr-card .sharpening-runtime-status')?.textContent === 'Synthetic capture warning'`, 'ASR runtime warning was not displayed');
    postprocessSharpening.setRuntimeStatusForTest({ active: false, reason: null });
    await waitFor(`document.querySelector('.asr-card .sharpening-runtime-status')?.textContent?.includes('Waiting for a recognized game')`, 'ASR retained a stale warning after recovery');
    postprocessSharpening.setAsr = async () => { throw new Error('Synthetic ASR save failure'); };
    await js(`(() => { const control = document.querySelector('.asr-card [role="combobox"]'); control.click(); control.options.find(item => item.dataset.value === 'off').click(); })()`);
    assert.equal(await js(`document.querySelector('.asr-card .asr-apply')?.textContent`), 'Apply');
    await js(`document.querySelector('.asr-card .asr-apply')?.click()`);
    await waitFor(`document.querySelector('.asr-card .asr-apply')?.textContent === 'Apply' && !document.querySelector('.asr-card .asr-apply')?.disabled && document.querySelector('.asr-card .text-error')?.textContent.includes('Synthetic ASR save failure') && !!Array.from(document.querySelectorAll('.toast-error')).find(item => item.textContent.includes('Arc Super Resolution apply failed'))`, 'ASR save failure did not restore controls and show both error feedback paths');
    assert.equal((await postprocessSharpening.getAsr()).value.enabled, true, 'Failed save changed the ASR preference');
    postprocessSharpening.setAsr = originalSetAsr;
    await js(`Array.from(document.querySelectorAll('.asr-card .graphics-card-actions button')).find(button => button.textContent === 'Reset to default')?.click()`);
    assert.equal(await js(`document.querySelector('.asr-card .asr-apply')?.textContent`), 'Apply');
    await js(`document.querySelector('.asr-card .asr-apply')?.click()`);
    await waitFor(`document.querySelector('.asr-card .asr-apply')?.textContent === 'Applied' && window.arcPower.arcSuperResolutionGet().then(state => !state.value.enabled)`, 'ASR did not recover after a failed save');
    assert.equal(legacyGraphicsWrites, driverWriteBaseline, 'Sharpening UI routed changes to driver graphics settings');
    process.stdout.write('[postprocess-sharpening-ui] PASS: global and per-game sharpening plus Arc Super Resolution controls\n');
  } finally {
    releaseInitialGlobalRead();
    releaseAsrSave();
    postprocessSharpening.setAsr = originalSetAsr;
    postprocessSharpening.getGlobal = originalGetGlobal;
    postprocessSharpening.setGlobal = originalSetGlobal;
    backend.setGraphicsSettings = originalSetGraphicsSettings;
    backend.getGraphicsSettings = originalGetGraphicsSettings;
  }
}
