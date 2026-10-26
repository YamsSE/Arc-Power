// Executable renderer verification for Advanced Overlay global postprocess settings.
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function verifyAdvancedOverlayGlobalSettingsUi(win, advancedOverlayHandle, postprocessSharpening) {
  const panel = advancedOverlayHandle?.getWindow?.();
  if (!panel || panel.isDestroyed()) throw new Error('Advanced Overlay settings verifier requires the real mock panel window');
  const mainJs = (code) => win.webContents.executeJavaScript(code);
  const panelJs = (code) => panel.webContents.executeJavaScript(code);
  const waitFor = async (predicate, message, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await panelJs(predicate)) return;
      await pause(50);
    }
    throw new Error(message);
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const originalSetGlobal = postprocessSharpening.setGlobal;

  await mainJs('window.arcPower.advancedOverlayToggle()');
  await waitFor("!!document.querySelector('.adv-tab[data-tab=\\\"graphics\\\"]')", 'Advanced Overlay Graphics tab did not become available');
  await panelJs("document.querySelector('.adv-tab[data-tab=\\\"graphics\\\"]')?.click()");
  const sharp = '.graphics-card[data-control="postprocessSharpening"]';
  const asr = '.graphics-card[data-control="arcSuperResolution"]';
  await waitFor(`!!document.querySelector('${sharp} .oc-chip-apply') && !!document.querySelector('${asr} .asr-apply')`, 'Advanced Overlay global settings cards did not render');
  const first = await panelJs('window.arcPower.postprocessSharpeningGet()');
  const firstAsr = await panelJs('window.arcPower.arcSuperResolutionGet()');
  assert(first.value.enabled === false && first.value.percentage === 50, `unexpected initial sharpening state: ${JSON.stringify(first.value)}`);
  assert(firstAsr.value.enabled === false, `ASR must default off: ${JSON.stringify(firstAsr.value)}`);

  postprocessSharpening.setRuntimeStatusForTest({ active: true, mode: 'asr', sharpeningActive: true, asrActive: true, sharpeningReason: null, asrReason: null });
  await waitFor(`document.querySelector('${sharp} .sharpening-runtime-status')?.textContent.includes('Sharpening is active') && document.querySelector('${asr} .asr-runtime-status')?.textContent.includes('Arc Super Resolution is active')`, 'Concurrent ASR and sharpening did not show both independent active states');
  postprocessSharpening.setRuntimeStatusForTest({ active: true, mode: 'sharpening', sharpeningActive: true, asrActive: false, sharpeningReason: null, asrReason: 'Synthetic ASR-only failure' });
  await waitFor(`document.querySelector('${sharp} .sharpening-runtime-status')?.textContent.includes('Sharpening is active') && document.querySelector('${asr} .asr-runtime-status')?.textContent.includes('Synthetic ASR-only failure')`, 'ASR-only failure incorrectly replaced sharpening status');
  postprocessSharpening.setRuntimeStatusForTest({ active: false, reason: null });

  await panelJs(`(() => { const d = document.querySelector('${sharp} [aria-label="Arc Image Sharpening"]'); d.click(); d.options.find(o => o.dataset.value === 'on').click(); })()`);
  await panelJs(`(() => { const slider = document.querySelector('${sharp} [aria-label="Arc Image Sharpening strength"]'); slider.value = '63'; slider.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('${sharp} .oc-chip-apply').click(); })()`);
  await waitFor(`window.arcPower.postprocessSharpeningGet().then(s => s.value.enabled && s.value.percentage === 63)`, 'Advanced Overlay did not save global sharpening at 63%');
  const mainSharp = await mainJs('window.arcPower.postprocessSharpeningGet()');
  assert(mainSharp.value.enabled && mainSharp.value.percentage === 63, `main renderer did not read shared sharpening setting: ${JSON.stringify(mainSharp.value)}`);

  // A dirty panel draft survives a write originating from the main Graphics card.
  await panelJs(`(() => { const slider = document.querySelector('${sharp} [aria-label="Arc Image Sharpening strength"]'); slider.value = '72'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await mainJs('window.arcPower.postprocessSharpeningSet({ enabled: true, percentage: 72 })');
  await waitFor(`!document.querySelector('${sharp} .settings-sync-status') && document.querySelector('${sharp} .oc-chip-apply')?.disabled === true`, 'matching external sharpening value left a false conflict warning or dirty Apply state');
  await panelJs(`(() => { const slider = document.querySelector('${sharp} [aria-label="Arc Image Sharpening strength"]'); slider.value = '80'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await mainJs("location.hash = '#/graphics'");
  const mainSharpCard = '.sharpening-card:not(.sharpening-game-card)';
  const waitMain = async (predicate, message, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { if (await mainJs(predicate)) return; await pause(50); }
    throw new Error(message);
  };
  await waitMain(`!!document.querySelector('${mainSharpCard} [aria-label="Arc Image Sharpening"]')`, 'main Graphics sharpening control did not render');
  await mainJs(`(() => { const d = document.querySelector('${mainSharpCard} [aria-label="Arc Image Sharpening"]'); d.click(); d.options.find(o => o.dataset.value === 'off').click(); document.querySelector('${mainSharpCard} .graphics-card-actions .btn-primary').click(); })()`);
  await waitFor(`window.arcPower.postprocessSharpeningGet().then(s => !s.value.enabled && s.value.percentage === 72)`, 'main Graphics did not save the global sharpening change');
  await waitFor(`document.querySelector('${sharp} .settings-sync-status')?.textContent.includes('Your draft is preserved')`, 'dirty Advanced Overlay draft was not preserved with an overwrite warning');
  assert(await panelJs(`document.querySelector('${sharp} [aria-label="Arc Image Sharpening strength"]')?.value === '80'`), 'external settings push overwrote the dirty Advanced Overlay draft');

  let holdNextSharpSave = true;
  let sharpSaveHeld = false;
  let releasePanelSharpSave;
  postprocessSharpening.setGlobal = async function(value) {
    const result = await originalSetGlobal.call(this, value);
    if (!holdNextSharpSave) return result;
    holdNextSharpSave = false;
    sharpSaveHeld = true;
    await new Promise((resolve) => { releasePanelSharpSave = resolve; });
    return result;
  };
  await panelJs(`document.querySelector('${sharp} .oc-chip-apply').click()`);
  while (!sharpSaveHeld) await pause(20);
  await mainJs(`window.arcPower.postprocessSharpeningSet({ enabled: false, percentage: 41 })`);
  await waitFor(`window.arcPower.postprocessSharpeningGet().then(s => !s.value.enabled && s.value.percentage === 41)`, 'second-window sharpening write did not complete while the Overlay save was in flight');
  releasePanelSharpSave();
  postprocessSharpening.setGlobal = originalSetGlobal;
  await waitFor(`window.arcPower.postprocessSharpeningGet().then(s => !s.value.enabled && s.value.percentage === 41) && !document.querySelector('${sharp} .settings-sync-status')`, 'queued second-window write was lost after the in-flight Overlay save');

  await waitFor(`document.querySelector('${asr} .asr-runtime-status')?.textContent.includes('Waiting for a recognized game')`, 'ready ASR did not explain the waiting runtime state');
  await panelJs(`(() => { const d = document.querySelector('${asr} [aria-label="Arc Super Resolution"]'); d.click(); d.options.find(o => o.dataset.value === 'on').click(); })()`);
  const applying = await panelJs(`document.querySelector('${asr} .asr-apply')?.textContent.trim()`);
  assert(applying === 'Apply' || applying === 'Applying…', `unexpected ASR apply feedback before click: ${applying}`);
  await panelJs(`document.querySelector('${asr} .asr-apply').click()`);
  await waitFor(`document.querySelector('${asr} .asr-apply')?.textContent.trim() === 'Applied' && window.arcPower.arcSuperResolutionGet().then(s => s.value.enabled)`, 'ASR successful save did not show Applied and persist');
  const mainAsr = await mainJs('window.arcPower.arcSuperResolutionGet()');
  assert(mainAsr.value.enabled, `main renderer did not read shared ASR setting: ${JSON.stringify(mainAsr.value)}`);

  const originalGetAsr = postprocessSharpening.getAsr;
  const originalSetAsr = postprocessSharpening.setAsr;
  const savedAsr = await postprocessSharpening.getAsr();
  try {
    // Turn the mock preference off before exercising failure and gating paths.
    await panelJs(`(() => { const d = document.querySelector('${asr} [aria-label="Arc Super Resolution"]'); d.click(); d.options.find(o => o.dataset.value === 'off').click(); })()`);
    await panelJs(`document.querySelector('${asr} .asr-apply').click()`);
    await waitFor('window.arcPower.arcSuperResolutionGet().then(s => !s.value.enabled)', 'ASR mock state did not return to off');

    let failRead = true;
    postprocessSharpening.getAsr = async function() {
      if (failRead) { failRead = false; throw new Error('Synthetic Advanced Overlay ASR read failure'); }
      return originalGetAsr.call(this);
    };
    await panelJs("document.querySelector('.adv-tab[data-tab=\\\"recording\\\"]')?.click()");
    await panelJs("document.querySelector('.adv-tab[data-tab=\\\"graphics\\\"]')?.click()");
    await waitFor(`document.querySelector('${asr} .text-error')?.textContent.includes('Synthetic Advanced Overlay ASR read failure') && !!document.querySelector('${asr} .asr-retry')`, 'ASR read failure did not render an inline error and retry action');
    postprocessSharpening.getAsr = originalGetAsr;
    await panelJs(`document.querySelector('${asr} .asr-retry').click()`);
    await waitFor(`!!document.querySelector('${asr} .asr-apply') && !document.querySelector('${asr} .text-error')`, 'ASR read retry did not recover');

    postprocessSharpening.setAsr = async function(value) {
      if (value.enabled) throw new Error('Synthetic Advanced Overlay ASR save failure');
      return originalSetAsr.call(this, value);
    };
    await panelJs(`(() => { const d = document.querySelector('${asr} [aria-label="Arc Super Resolution"]'); d.click(); d.options.find(o => o.dataset.value === 'on').click(); })()`);
    await panelJs(`document.querySelector('${asr} .asr-apply').click()`);
    await waitFor(`document.querySelector('${asr} .text-error')?.textContent.includes('Synthetic Advanced Overlay ASR save failure') && document.querySelector('${asr} .asr-apply')?.textContent.trim() !== 'Applied'`, 'rejected ASR write was reported as applied instead of an inline error');

    postprocessSharpening.getAsr = async () => ({ ...savedAsr, value: { enabled: false }, runtimeReady: false, active: false, reason: 'Mock ASR runtime gate is closed.' });
    await panelJs("document.querySelector('.adv-tab[data-tab=\\\"recording\\\"]')?.click()");
    await panelJs("document.querySelector('.adv-tab[data-tab=\\\"graphics\\\"]')?.click()");
    await waitFor(`document.querySelector('${asr} .asr-runtime-status')?.textContent === 'Mock ASR runtime gate is closed.'`, 'gated ASR state did not render its reason');
    await panelJs(`(() => { const d = document.querySelector('${asr} [aria-label="Arc Super Resolution"]'); d.click(); d.options.find(o => o.dataset.value === 'on').click(); })()`);
    assert(await panelJs(`document.querySelector('${asr} .asr-apply')?.disabled === true`), 'enabled ASR apply must stay disabled while its runtime gate is closed');
    assert((await panelJs(`document.querySelector('${asr} .asr-apply')?.textContent.trim()`)) !== 'Applied', 'gated ASR must not claim an applied state');
    console.log('[advanced-overlay-global-settings-ui] PASS: rendered sharpening and ASR read/write, cross-window shared state including matching-value reconciliation and an in-flight second-window write, wait/applied feedback, read retry, rejected-write error, and gated reason');
  } finally {
    postprocessSharpening.setGlobal = originalSetGlobal;
    postprocessSharpening.getAsr = originalGetAsr;
    postprocessSharpening.setAsr = originalSetAsr;
    await originalSetAsr.call(postprocessSharpening, { enabled: false });
    await postprocessSharpening.setGlobal({ enabled: false, percentage: 50 });
  }
}
