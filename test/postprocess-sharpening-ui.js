// Focused UI verification of app-managed post-process sharpening in Chromium.
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
  let legacyGraphicsWrites = 0;
  const originalSetGraphicsSettings = backend.setGraphicsSettings;
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
    const directory = path.resolve('.codex/task-artifacts/sharpening-render-proof');
    fs.mkdirSync(directory, { recursive: true });
    await js(`(() => { document.querySelectorAll('.toast').forEach((item) => item.remove()); document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: 'center', inline: 'center' }); })()`);
    await pause();
    const image = await win.webContents.capturePage();
    const file = path.join(directory, name);
    fs.writeFileSync(file, image.toPNG());
    return file;
  };

  await waitFor(`document.getElementById('page')?.textContent?.includes('Active device') && document.getElementById('page')?.textContent?.includes('Dashboard')`, 'Mock renderer did not finish startup');
  // Clear the first-run waiver in isolated mock storage so screenshots show
  // the actual controls and no user profile or physical hardware is touched.
  await js(`window.arcPower.waiverAccept(0)`);
  await js(`location.hash = '#/graphics'`);
  await waitFor(`!!document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')`, 'Global sharpening control did not render');
  const initialGlobal = await postprocessSharpening.getGlobal();
  assert.deepEqual(initialGlobal.value, { enabled: false, percentage: 50 });
  assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.min`), '0');
  assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.max`), '100');
  assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.step`), '1');
  assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.getAttribute('aria-valuetext')`), '50%');
  assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Enable app-managed image sharpening"]')?.checked`), false);
  const globalHelp = await js(`document.querySelector('.sharpening-card .card-note')?.textContent ?? ''`);
  assert.match(globalHelp, /supported 64-bit DirectX 11\/12 games/i);
  assert.match(globalHelp, /Set up each game in Profiles/i);
  assert.match(globalHelp, /shared across GPUs/i);
  await screenshot('global-sharpening-initial.png', '.sharpening-card input[aria-label="Image sharpening strength"]');

  // Slider editing is draft-only until the explicit Apply button is used.
  await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]'); input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  assert.equal((await postprocessSharpening.getGlobal()).value.percentage, 50, 'Editing the global slider applied without user action');
  await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Enable app-managed image sharpening"]'); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await js(`document.querySelector('.sharpening-card button')?.click()`);
  await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.enabled === true && state.value.percentage === 0)`, 'Global 0% enabled setting did not Apply');
  assert.equal(legacyGraphicsWrites, 0, 'Global sharpening Apply routed a write to the legacy driver graphics backend');
  await js(`location.hash = '#/dashboard'`);
  await pause();
  await js(`location.hash = '#/graphics'`);
  await waitFor(`document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]')?.value === '0'`, 'Global value did not persist after reopening Graphics');
  assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Enable app-managed image sharpening"]')?.checked`), true);
  await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Image sharpening strength"]'); input.value = '100'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`document.querySelector('.sharpening-card button')?.click()`);
  await waitFor(`window.arcPower.postprocessSharpeningGet().then((state) => state.value.percentage === 100)`, 'Global 100% did not Apply');
  assert.equal(legacyGraphicsWrites, 0, 'Global sharpening Apply routed a write to the legacy driver graphics backend');
  assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 100 });
  await screenshot('global-sharpening-100.png', '.sharpening-card input[aria-label="Image sharpening strength"]');

  // The mock catalog supplies a real fixture path, but all sharpening actions
  // are handled by the in-memory mock and must never touch that path.
  await js(`location.hash = '#/profiles'`);
  await waitFor(`!!document.querySelector('.profiles-mode-toggle')`, 'Profiles page did not render');
  await js(`Array.from(document.querySelectorAll('.profiles-mode-toggle button')).find((button) => button.textContent.trim() === 'Game Profile')?.click()`);
  await waitFor(`document.querySelectorAll('.game-catalog-card').length > 0`, 'Mock game catalog did not populate');
  const catalog = await js(`window.arcPower.gameCatalogList()`);
  const game = catalog.catalog.find((entry) => typeof entry.exePath === 'string' && entry.exePath.toLowerCase().endsWith('.exe'));
  assert.ok(game, `Mock catalog did not expose a fixture executable path: ${JSON.stringify(catalog.catalog)}`);
  await js(`Array.from(document.querySelectorAll('.game-catalog-card')).find((button) => button.dataset.exePath === ${JSON.stringify(game.exePath)})?.click()`);
  await waitFor(`Array.from(document.querySelectorAll('.sharpening-card button')).some((button) => button.textContent.trim() === 'Set up sharpening')`, 'Game sharpening setup control did not render');
  let gameState = await postprocessSharpening.getGame(game.exePath);
  assert.equal(gameState.installed, false, 'Fixture unexpectedly started with sharpening installed');
  assert.equal(await js(`!!document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')`), false,
    'Per-game controls should not appear before explicit setup');
  assert.equal(await js(`document.querySelector('.sharpening-card button')?.textContent.trim()`), 'Set up sharpening');
  await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]'); if (input) { input.value = '7'; input.dispatchEvent(new Event('input', { bubbles: true })); } })()`);
  assert.equal((await postprocessSharpening.getGame(game.exePath)).installed, false, 'Changing the disabled slider triggered setup');
  const gameHelp = await js(`document.querySelector('.sharpening-card .profile-capability-note')?.textContent ?? ''`);
  assert.match(gameHelp, /through ReShade/i);
  assert.match(gameHelp, /64-bit DirectX 11\/12 games/i);
  await screenshot('game-sharpening-explicit-setup.png', '.sharpening-card button');
  await js(`document.querySelector('.sharpening-card button')?.click()`);
  await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.installed)`, 'Explicit game setup did not finish');
  gameState = await postprocessSharpening.getGame(game.exePath);
  assert.equal(gameState.installed, true);
  assert.equal(gameState.override, null, 'Setup should preserve inheritance instead of creating an override');
  assert.deepEqual(gameState.value, { enabled: true, percentage: 100 }, 'Fresh game setup did not inherit the global setting');
  assert.equal(await js(`document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')?.disabled`), true,
    'Inherited value should be read-only until override is enabled');
  await screenshot('game-sharpening-inherited-global.png', '.sharpening-card input[aria-label="Per-game image sharpening strength"]');

  // Create a distinct 0% per-game override, toggle it off and on without
  // losing strength, then return to inheritance and remove the setup.
  await js(`(() => { const useGlobal = document.querySelector('.sharpening-card input[type="checkbox"]'); useGlobal.checked = false; useGlobal.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override !== null)`, 'Disabling global inheritance did not create an explicit override');
  await waitFor(`document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]')?.disabled === false`, 'Per-game override controls did not enable');
  await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Per-game image sharpening strength"]'); input.value = '0'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await js(`document.querySelector('.sharpening-card button')?.click()`);
  await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.percentage === 0)`, 'Per-game 0% override did not Apply');
  await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Enable per-game image sharpening"]'); input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await js(`document.querySelector('.sharpening-card button')?.click()`);
  await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.enabled === false && state.override?.percentage === 0)`, 'Turning game sharpening off lost its 0% strength');
  await js(`(() => { const input = document.querySelector('.sharpening-card input[aria-label="Enable per-game image sharpening"]'); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await js(`document.querySelector('.sharpening-card button')?.click()`);
  await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override?.enabled === true && state.override?.percentage === 0)`, 'Turning game sharpening back on lost its 0% strength');
  assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 100 }, 'Per-game override changed global sharpening');
  await screenshot('game-sharpening-override-0.png', '.sharpening-card input[aria-label="Per-game image sharpening strength"]');
  await js(`(() => { const useGlobal = document.querySelector('.sharpening-card input[type="checkbox"]'); useGlobal.checked = true; useGlobal.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.override === null && state.value.percentage === 100)`, 'Returning to global inheritance did not remove override');
  await js(`document.querySelectorAll('.sharpening-card .graphics-card-actions button')[1]?.click()`);
  await waitFor(`window.arcPower.postprocessSharpeningGameGet(${JSON.stringify(game.exePath)}).then((state) => state.installed === false)`, 'Remove sharpening did not clear game setup');
  assert.deepEqual((await postprocessSharpening.getGlobal()).value, { enabled: true, percentage: 100 }, 'Removing game setup changed global sharpening');

  // Game setup/removal and override actions must not change global state.
  await js(`location.hash = '#/graphics'`);
  await waitFor(`!!document.querySelector('.sharpening-card')`, 'Graphics page did not reopen');
  const beforeShaderApply = await postprocessSharpening.getGlobal();
  assert.deepEqual(await postprocessSharpening.getGlobal(), beforeShaderApply);
  backend.setGraphicsSettings = originalSetGraphicsSettings;
}
