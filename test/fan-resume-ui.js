// Real Electron/Chromium verification of fan-resume UI and IPC against MockBackend.
// Resume is emitted on Electron's powerMonitor only; this does not sleep Windows.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function runFanResumeUiVerification(win, backend, emitResume) {
  const js = (code) => win.webContents.executeJavaScript(code);
  const pause = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));
  const waitFor = async (expression, message, attempts = 100) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (await js(expression)) return;
      await pause();
    }
    assert.fail(`${message}; state=${JSON.stringify(await js(`({ hash: location.hash, title: document.querySelector('.page-title')?.textContent ?? null, text: (document.getElementById('page')?.textContent ?? '').slice(0, 700) })`))}`);
  };
  const screenshot = async (name) => {
    const directory = path.resolve('.codex/task-artifacts/display-identity-fan-resume');
    fs.mkdirSync(directory, { recursive: true });
    const oldSize = win.getContentSize();
    win.setContentSize(oldSize[0], 1800);
    await pause();
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(directory, name), image.toPNG());
    win.setContentSize(oldSize[0], oldSize[1]);
    return directory;
  };
  const clickFanTab = async () => {
    await js(`document.querySelector('.tuning-view-btn[data-view="fan"]')?.click()`);
    await waitFor(`document.querySelector('.fan-resume-card input[aria-label="Reapply fan settings after sleep"]')`, 'Fan resume experimental card did not render');
    await waitFor(`!document.querySelector('.fan-resume-card input[aria-label="Reapply fan settings after sleep"]').disabled`, 'Fan resume state did not load');
  };
  const toggle = '.fan-resume-card input[aria-label="Reapply fan settings after sleep"]';

  const entry = backend._entry(0);
  assert.match(entry.device.name, /B580/i, 'Expected isolated B580 MockBackend fixture');
  assert.equal(entry.caps.fan.canControl, true, 'B580 mock must expose editable fan controls');
  const originalApply = backend.applySettings;
  const applyCalls = [];
  let forcedFailure = false;
  backend.applySettings = async function(deviceId, settings, ...rest) {
    applyCalls.push({ deviceId, settings: structuredClone(settings) });
    if (forcedFailure) return { ok: false, perControl: Object.fromEntries(Object.keys(settings).map(key => [key, { ok: false, errorCode: 'permission-denied' }])) };
    return originalApply.call(this, deviceId, settings, ...rest);
  };

  try {
    await waitFor(`document.getElementById('page')?.textContent?.includes('Active device')`, 'Mock startup did not finish');
    await js('window.arcPower.waiverAccept(0)');
    await js(`location.hash = '#/tuning'`);
    await waitFor(`location.hash === '#/tuning' && document.querySelector('.tuning-view-btn[data-view="fan"]')`, 'Tuning page did not render');
    await clickFanTab();

    const initialA11y = await js(`(() => { const input = document.querySelector('${toggle}'); return { checked: input.checked, role: input.getAttribute('role'), label: input.getAttribute('aria-label'), disabled: input.disabled, heading: input.closest('.fan-resume-card')?.querySelector('.card-title')?.textContent }; })()`);
    assert.deepEqual(initialA11y, { checked: false, role: 'switch', label: 'Reapply fan settings after sleep', disabled: false, heading: 'Arc Hibernation Fix' }, 'Arc Hibernation Fix must be accessible and default off');
    const staleIdentityError = await js(`window.arcPower.fanResumeSet({ enabled: true, deviceId: 0, deviceKey: 'pci:stale-gpu-identity' }).then(() => null, error => String(error))`);
    assert.match(staleIdentityError, /identity changed/i, 'Real preload IPC must reject an enable request with a stale GPU identity');
    const beforeEnable = await backend.getCurrentSettings(0);
    const startCalls = applyCalls.length;
    await screenshot('fan-resume-default-off.png');

    await js(`(() => { const input = document.querySelector('${toggle}'); input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('${toggle}')?.checked === true && !document.querySelector('${toggle}')?.disabled`, 'Enabling fan resume did not complete');
    assert.equal(applyCalls.length, startCalls, 'Enabling fan resume must read current fan state without applying settings');
    const savedPath = path.join(os.tmpdir(), `arcpower-mock-ui-${process.pid}`, 'FanResume.json');
    assert.equal(await js(`typeof window.arcPower.fanResumeGet === 'function' && typeof window.arcPower.fanResumeSet === 'function'`), true, 'Fan-resume must use the real preload IPC API');
    assert.equal(fs.existsSync(savedPath), true, `Fan resume state file was not written; UI=${JSON.stringify(await js(`({ checked: document.querySelector('${toggle}')?.checked, disabled: document.querySelector('${toggle}')?.disabled, message: document.querySelector('.fan-resume-card')?.textContent })`))}; target=${JSON.stringify(await backend.getDeviceTarget(0))}`);
    const savedDoc = JSON.parse(fs.readFileSync(savedPath, 'utf8'));
    assert.equal(savedDoc.devices.length, 1, 'Enabling via real preload IPC should persist exactly one device record');
    const saved = savedDoc.devices[0];
    assert.deepEqual(saved.settings, { fanMode: beforeEnable.fanMode, ...(beforeEnable.fanMode === 'curve' ? { fanCurve: beforeEnable.fanCurve } : {}) }, 'Saved restore target must exactly match the confirmed current fan settings');
    assert.deepEqual(Object.keys(saved.settings).sort(), beforeEnable.fanMode === 'curve' ? ['fanCurve', 'fanMode'] : ['fanMode'], 'Persisted target must contain fan-only fields');
    await screenshot('fan-resume-enabled.png');

    // Change only the editor draft. No Apply click occurs, so this must not
    // change the saved target or the mock's current fan state.
    await js(`document.querySelector('.fan-presets button')?.click()`);
    const afterDraft = await backend.getCurrentSettings(0);
    assert.deepEqual({ fanMode: afterDraft.fanMode, fanCurve: afterDraft.fanCurve }, { fanMode: beforeEnable.fanMode, fanCurve: beforeEnable.fanCurve }, 'Staging a different preset must not write to the backend');
    assert.deepEqual(JSON.parse(fs.readFileSync(savedPath, 'utf8')).devices[0].settings, saved.settings, 'Staged unapplied edits must not replace the persisted resume target');

    await js(`location.hash = '#/dashboard'`);
    await waitFor(`location.hash === '#/dashboard'`, 'Dashboard navigation did not finish');
    await js(`location.hash = '#/tuning'`);
    await waitFor(`location.hash === '#/tuning' && document.querySelector('.tuning-view-btn[data-view="fan"]')`, 'Tuning navigation did not finish');
    await clickFanTab();
    assert.equal(await js(`document.querySelector('${toggle}')?.checked`), true, 'Enabled state must persist after leaving and reopening the Fan tab');

    // Make the mock's live fan mode differ from the stored snapshot, then
    // exercise the actual controller listener through powerMonitor.emit.
    const live = entry.state;
    live.fanMode = 'auto';
    live.fanCurve = null;
    const callsBeforeResume = applyCalls.length;
    emitResume();
    await waitFor(`window.arcPower.getCurrentSettings(0).then(s => s.fanMode === ${JSON.stringify(saved.settings.fanMode)} && ${saved.settings.fanMode === 'curve' ? 'JSON.stringify(s.fanCurve) === ' + JSON.stringify(JSON.stringify(saved.settings.fanCurve)) : 'true'})`, 'Simulated resume did not restore the stored fan settings', 180);
    const resumeCalls = applyCalls.slice(callsBeforeResume);
    assert.ok(resumeCalls.length >= 1, 'Simulated resume should use the real MockBackend apply path');
    const restoredCall = resumeCalls.find((call) => call.settings.fanMode === saved.settings.fanMode);
    assert.ok(restoredCall, `No resume apply carried the stored mode: ${JSON.stringify(resumeCalls)}`);
    assert.deepEqual(restoredCall.settings, saved.settings, 'Resume apply payload must exactly match the stored fan-only settings');
    assert.deepEqual(Object.keys(restoredCall.settings).sort(), Object.keys(saved.settings).sort(), 'Resume must not include non-fan settings');
    await screenshot('fan-resume-restored.png');

    forcedFailure = true;
    emitResume();
    await waitFor(`document.querySelector('.fan-resume-card')?.textContent?.includes('no longer accepted')`, 'Resume failure was not shown on the mounted Fan card', 180);
    assert.equal(await js(`document.querySelector('${toggle}')?.checked`), true, 'A failed restore must preserve the visible opt-in preference');
    forcedFailure = false;

    await js(`(() => { const input = document.querySelector('${toggle}'); input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await waitFor(`document.querySelector('${toggle}')?.checked === false && !document.querySelector('${toggle}')?.disabled`, 'Disabling fan resume did not complete');
    assert.equal(JSON.parse(fs.readFileSync(savedPath, 'utf8')).devices.length, 0, 'Disabling via real preload IPC must remove the persisted target');

    process.stdout.write(`[fan-resume-ui] PASS target=${JSON.stringify(saved.settings)} simulatedResumePayload=${JSON.stringify(restoredCall.settings)} applyCalls=${applyCalls.length} screenshots=${path.resolve('.codex/task-artifacts/display-identity-fan-resume')}\n`);
  } finally {
    backend.applySettings = originalApply;
  }
}
