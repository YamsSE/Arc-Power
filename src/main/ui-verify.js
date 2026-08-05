// Arc Power — dev-only UI verification (`electron . --ui-verify`).
//
// Drives the REAL window (renderer + preload + IPC + MockBackend) through
// the M2a/M2b-B product flows and asserts the outcomes, mirroring what the
// prompt requires to be verified in mock mode:
//   1. shell renders (sidebar + header);
//   1b. M2b-B dashboard redesign: driver line "32.0.101.8861 - Jul 05, 2026"
//       (mock driver-info fixture), no PCI ID anywhere, memory-clock readout
//       next to core clock, ONE merged "Service Status" card (no Level Zero
//       item, no persistent waiver row), "Xe Cores 32 - Shader Units 4096";
//   1c. IGS state card (M2a.5): the merged status card keeps the dot, the
//       half-state note and the toggle; env knobs RID_MOCK_IGS_RUNNING /
//       RID_MOCK_IGS_APP fixture the four-combination matrix;
//   2. overclocking cards render from capability ranges; M2b-B: the card
//      label is "Core offset", the floating Apply is hidden when clean and
//      appears when dirty;
//   3. first Apply shows the warranty-waiver dialog; Accept persists the
//      waiver; the apply succeeds and the state read-back refreshes; the
//      per-control toast count is exactly 1 (the other three controls are
//      no-ops and stay silent — M2b-B suppression);
//   4. a second apply does NOT re-show the dialog;
//   5. per-card reset-to-default + apply round-trips the default;
//   5b. an io-failed apply retries with backoff; the "Applied on retry"
//       warning shows ONLY when the retried apply succeeded — a fully-failed
//       retry shows the error toast and NO warn (M2b review F3);
//   6. fan editor: mode toggle, add point, preset, apply;
//   7. a failed fan apply surfaces the mapped OcErrorCode message (not the
//      raw backend message);
//   8. startup (Run-key) channels: get/set round trip + validation;
//   9. M2b-B Monitoring: readout grid + 5 collapsible Canvas segments (first
//      expanded), FPS shows "FPS unavailable" (mock fps-poll -> null);
//   9b. the 1 s FPS poll stops when navigating away from Monitoring (M2b
//      review F4, via the main-side poll counter);
//  10. M2b-B Profiles: create/save/rename/delete/load round trip, ocOnBoot
//      toggle respects the waiver gate, active-profile highlight, no-op
//      profile load shows no success toast, tray-rebuild is called on every
//      mutation;
//  11. with RID_MOCK_OFFGRID_FREQ_MHZ=48.3, the driver readout line renders
//      the off-grid value with an extra decimal, distinct from the snapped
//      slider value.
// This script is dev tooling only — it always uses MockBackend (it never
// touches hardware) and exists to catch DOM-wiring regressions that unit
// tests cannot. Profile rows created here are cleaned up before exit.

import { app } from 'electron';
import { ProfileStore } from './store/profile-store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(win, expr, timeoutMs = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const ok = await win.webContents.executeJavaScript(expr).catch(() => false);
    if (ok) return true;
    await sleep(150);
  }
  return false;
}

export class UiVerifyFailure extends Error {}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('./backend/mock-backend.js').MockBackend} backend
 * @param {() => number} [getTrayRebuilds] dev probe: tray-rebuild invocations
 * @param {() => number} [getFpsPolls] dev probe: fps-poll invocations (M2b
 *   review F4 — asserts the Monitoring poll stops on navigation away)
 */
export async function runUiVerify(win, backend, getTrayRebuilds = () => 0, getFpsPolls = () => 0) {
  const log = (s) => console.log(`[ui-verify] ${s}`);
  const steps = [];
  const step = (n, msg) => {
    steps.push(`[${n}] ${msg}`);
    log(msg);
  };
  const fail = (msg) => {
    throw new UiVerifyFailure(msg);
  };
  const js = (code) => win.webContents.executeJavaScript(code);
  const clearToasts = () => js(`document.querySelectorAll('.toast').forEach((t) => t.remove())`);

  // --- 1. shell renders -----------------------------------------------------
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 6`))) {
    fail('sidebar did not render (6 nav links expected)');
  }
  const brand = await js(`document.querySelector('.sidebar-brand')?.textContent ?? ''`);
  if (brand.trim() !== 'Arc Power') fail(`sidebar brand is '${brand}'`);
  step('boot', `shell rendered; brand='${brand.trim()}'; mock badge=${await js(`!!document.querySelector('.badge-mock')`)}`);

  // --- 1b. M2b-B dashboard redesign ----------------------------------------
  // Driver line: dotted version from the hex DeviceInfo + the fixture date
  // from the mock driver-info adapter. No PCI anywhere.
  if (!(await waitFor(win, `(document.querySelector('.gpu-meta')?.textContent ?? '').includes('32.0.101.8861 - Jul 05, 2026')`))) {
    fail(`header driver line is '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}' (expected '32.0.101.8861 - Jul 05, 2026')`);
  }
  if (await js(`document.body.textContent.includes('PCI')`)) fail('PCI ID is still shown somewhere in the UI');
  // Top-right indicator: just the dot + the static 'Service Status' label
  // (the verbose IGS text moved into the dot tooltip / the status card).
  const headerIndicator = await js(`document.querySelector('.gpu-status-text')?.textContent ?? ''`);
  if (!headerIndicator.includes('Service Status')) fail(`header indicator is '${headerIndicator}' (expected 'Service Status')`);
  if (headerIndicator.includes('OC control OK')) fail(`header indicator still shows the verbose IGS text: '${headerIndicator}'`);
  step('driver-line', `header driver line '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}'; no PCI text; indicator='${headerIndicator.trim()}'`);

  // Device card: compute line, no persistent waiver row.
  if (!(await waitFor(win, `document.body.textContent.includes('Xe Cores 32 - Shader Units 4096')`))) {
    fail('Xe cores / shader units line missing');
  }
  if (await js(`document.body.textContent.includes('OC waiver')`)) fail('persistent waiver status is still shown');
  step('device-card', 'device card: Xe Cores 32 - Shader Units 4096, no OC waiver row, no PCI row');

  // Memory clock readout next to core clock (mock telemetry: 2000 MHz).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock' && (t.querySelector('.stat-value')?.textContent ?? '') === '2000')`))) {
    fail('memory-clock readout missing or not 2000 MHz');
  }
  step('mem-clock', `memory clock readout = ${await js(`Array.from(document.querySelectorAll('#dash-readout .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock')?.querySelector('.stat-value')?.textContent ?? ''`)} MHz (compact tiles)`);

  // ONE merged Service Status card; no Level Zero item.
  if (!(await waitFor(win, `document.querySelectorAll('.status-card').length === 1`))) fail('expected exactly one merged Service Status card');
  const statusTitle = await js(`document.querySelector('.status-card .card-title')?.textContent ?? ''`);
  if (statusTitle.trim() !== 'Service Status') fail(`merged card title is '${statusTitle}'`);
  if (await js(`document.querySelector('.status-card')?.textContent.includes('Level Zero')`)) fail('Level Zero is still a status item');
  if (await js(`document.querySelector('.status-card')?.textContent.includes('IGCL runtime')`)) fail('IGCL line shown in the healthy state (degraded-only)');
  step('status-card', `one merged 'Service Status' card; no Level Zero item; IGCL detail hidden while healthy`);

  // --- 1c. IGS state matrix on the merged card (M2a.5 semantics) -----------
  // The verified rule (docs/igcl-integration.md §8a): half-states (service
  // and app disagree) block OC writes -> warning + note; fully-on and
  // fully-off -> ok, no note. The toggle flips ONLY the service part.
  const svcRunning = process.env.RID_MOCK_IGS_RUNNING !== '0';
  const appRunning = process.env.RID_MOCK_IGS_APP !== '0';
  const igsBtnText = () => js(`document.querySelector('.igs-toggle')?.textContent ?? ''`);

  const expectIgsUi = async (svc, app) => {
    const level = svc === app ? 'ok' : 'warning';
    if (!(await waitFor(win, `!!document.querySelector('.status-${level}')`))) {
      fail(`status dot is not ${level} for svc=${svc} app=${app}`);
    }
    const note = await js(`document.querySelector('.igs-note')?.textContent ?? ''`);
    if (svc !== app) {
      if (!note.includes('partially running')) fail(`IGS half-state note missing: '${note}'`);
    } else if (note !== '') {
      fail(`IGS note shown in the fully-${svc ? 'on' : 'off'} state: '${note}'`);
    }
    const btn = await igsBtnText();
    const expectedBtn = svc ? 'Disable IGS service' : 'Re-enable IGS service';
    if (btn.trim() !== expectedBtn) fail(`IGS button is '${btn}' (expected '${expectedBtn}')`);
    const state = await js(`window.arcPower.getIgsServiceState()`);
    if (state.service.running !== svc || state.appRunning !== app || state.service.startType !== (svc ? 'auto' : 'disabled')) {
      fail(`mock IGS state: ${JSON.stringify(state)} (expected svc=${svc} app=${app})`);
    }
  };

  const comboName = (svc, app) => {
    if (svc && app) return 'fully on';
    if (!svc && !app) return 'fully off';
    return svc ? 'half (service on, app off)' : 'half (app on, service off)';
  };

  await expectIgsUi(svcRunning, appRunning);
  step('igs', `status card: initial ${comboName(svcRunning, appRunning)} — dot ${svcRunning === appRunning ? 'ok' : 'warning'}, note ${svcRunning !== appRunning ? 'shown' : 'absent'}, '${(await igsBtnText()).trim()}'`);

  await js(`document.querySelector('.igs-toggle')?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`))) fail('IGS toggle success toast missing');
  await expectIgsUi(!svcRunning, appRunning);
  step('igs-toggle', `IGS toggle (mock): svc ${svcRunning ? 'disabled' : 'enabled'} -> ${comboName(!svcRunning, appRunning)}, toast ok`);

  await clearToasts();
  await js(`document.querySelector('.igs-toggle')?.click()`);
  if (!(await waitFor(win, `(document.querySelector('.igs-toggle')?.textContent ?? '').trim() === '${svcRunning ? 'Disable IGS service' : 'Re-enable IGS service'}'`))) {
    fail('button did not flip back after the second toggle');
  }
  await expectIgsUi(svcRunning, appRunning);
  await clearToasts();
  step('igs-roundtrip', `IGS toggle round trip (mock): back to ${comboName(svcRunning, appRunning)}`);

  // --- 2. overclocking cards ------------------------------------------------
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  if (!(await waitFor(win, `document.querySelectorAll('.oc-card').length >= 4`))) {
    fail('expected >= 4 overclocking cards (mock A770 matrix)');
  }
  step('oc', `${await js(`document.querySelectorAll('.oc-card').length`)} control cards rendered`);

  // --- 2b. off-grid driver readout (RID_MOCK_OFFGRID_FREQ_MHZ knob) -------
  const offGridFreq = process.env.RID_MOCK_OFFGRID_FREQ_MHZ;
  if (offGridFreq !== undefined) {
    const expected = String(Number(offGridFreq));
    if (!(await waitFor(win, `(() => {
      const line = document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-driver')?.textContent ?? '';
      return line.includes('${expected} MHz') && line.includes('Driver:');
    })()`))) {
      fail(`off-grid driver line missing '${expected} MHz'`);
    }
    const driverText = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-driver')?.textContent ?? ''`);
    const sliderReadout = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-value')?.textContent ?? ''`);
    if (!driverText.includes(`${expected} MHz`)) fail(`driver line is '${driverText}' (expected 'Driver: ${expected} MHz')`);
    if (sliderReadout.trim() === `${expected} MHz`) fail(`off-grid value must be distinguishable: slider readout is '${sliderReadout}'`);
    step('oc-offgrid', `off-grid driver readout renders '${driverText.trim()}' (slider snapped to '${sliderReadout.trim()}')`);
  }

  // --- 2c. M2b-B tuning UX: "Core offset" label + floating Apply ----------
  const freqTitle = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? ''`);
  if (freqTitle.trim() !== 'Core offset') fail(`freq offset card title is '${freqTitle}' (expected 'Core offset')`);
  step('label', `freq offset card renamed to 'Core offset'`);

  const floatingHidden = () => js(`(() => { const b = document.querySelector('.floating-apply'); return !b || b.hidden === true; })()`);
  const setSlider = async (value) => {
    const result = await js(`(() => {
      const card = document.querySelector('.oc-card[data-control="powerLimitW"]');
      const input = card.querySelector('input[type="range"]');
      input.value = '${value}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return card.querySelector('.oc-value').textContent;
    })()`);
    return result;
  };
  const clickApply = () => js(`(() => { const b = document.querySelector('.floating-apply'); if (b && !b.hidden) { b.click(); return true; } return false; })()`);

  // Clean state (non-off-grid): the floating Apply must be hidden.
  if (offGridFreq === undefined) {
    if (!(await floatingHidden())) fail('floating Apply is visible while the settings are clean');
    step('float-clean', 'floating Apply hidden while clean');
    await setSlider(220);
    if (await floatingHidden()) fail('floating Apply did not appear after the slider moved');
    step('float-dirty', 'floating Apply appears when a setting is dirty');
  } else {
    await setSlider(220);
    if (await floatingHidden()) fail('floating Apply did not appear (off-grid state is dirty)');
    step('float-dirty', 'floating Apply appears (off-grid fixture: freq is dirty)');
  }

  // --- 3. waiver gate: persisted acceptance must skip the dialog (F1) --------
  const persistedWaiver = (await new ProfileStore().loadSettings()).waiverAccepted === true;
  const bootAccepted = (await js(`window.arcPower.waiverGet(0)`)).accepted === true;
  if (persistedWaiver && !bootAccepted) {
    fail('boot did not seed the persisted waiver acceptance (settings.json says accepted)');
  }
  step('waiver-seed', `boot waiver state: store=${persistedWaiver ? 'accepted' : 'not accepted'}, backend=${bootAccepted ? 'accepted' : 'not accepted'}`);

  // ocOnBoot gate check (M2b-B): with an unaccepted waiver the start-at-boot
  // checkbox must be disabled; after acceptance it is enabled.
  if (!bootAccepted) {
    await js(`location.hash = '#/profiles'`);
    if (!(await waitFor(win, `!!document.querySelector('.boot-checkbox')`))) fail('boot checkbox did not render');
    if (!(await js(`document.querySelector('.boot-checkbox').disabled`))) fail('start-at-boot must be gated on the waiver (unaccepted)');
    step('boot-gate', 'start-at-boot toggle disabled while the waiver is not accepted');
    await js(`location.hash = '#/overclocking'`);
    await sleep(250);
  }

  const readoutBefore = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value').textContent`);
  if (readoutBefore.trim() !== '220 W') fail(`slider readout is '${readoutBefore}' (expected '220 W')`);
  step('slider', `power slider set to 220 W (readout '${readoutBefore}')`);

  if (bootAccepted) {
    // Count toasts AFTER a clean slate: the apply below must produce exactly
    // `expectedToasts` success toasts (see the count check after both arms).
    await clearToasts();
    await clickApply();
    await sleep(400);
    if (await js(`!!document.querySelector('.modal')`)) fail('waiver dialog appeared despite a persisted acceptance (F1)');
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`))) fail('success toast missing after apply');
    const state = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(state.powerLimitW - 220) > 1e-6) fail(`powerLimit not applied: ${state.powerLimitW}`);
    step('waiver-persisted', `persisted acceptance seeded at boot: apply without dialog -> read-back ${state.powerLimitW} W`);
  } else {
    if (!(await waitFor(win, `!!document.querySelector('.modal')`))) fail('waiver dialog did not appear on first apply');
    step('waiver', 'waiver dialog shown before first apply (not auto-accepted)');

    await js(`document.querySelector('.modal button.btn-ghost')?.click()`);
    await sleep(300);
    const cancelledState = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(cancelledState.powerLimitW - 210) > 1e-6) fail(`apply ran after Cancel! powerLimit=${cancelledState.powerLimitW}`);
    step('waiver-cancel', 'Cancel: apply aborted, device untouched (210 W)');

    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.modal')`))) fail('waiver dialog did not reappear');
    // Clean slate before the final Accept so the toast count below is exact.
    await clearToasts();
    await js(`document.querySelector('.modal button.btn-danger')?.click()`);
    if (!(await waitFor(win, `!document.querySelector('.modal')`))) fail('waiver dialog did not close on Accept');
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`))) fail('success toast missing after apply');
    const accepted = await js(`window.arcPower.waiverGet(0)`);
    if (!accepted.accepted) fail('waiver not accepted on the device after Accept');
    const state = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(state.powerLimitW - 220) > 1e-6) fail(`powerLimit not applied: ${state.powerLimitW}`);
    step('apply', `accept -> apply -> toast -> read-back refreshed to ${state.powerLimitW} W`);
  }

  // --- 3b. M2b-B no-op suppression: the payload carries all 4 controls, but
  // --- only power changed -> EXACTLY one success toast (the no-ops stay
  // --- silent). Off-grid fixture: freq is also dirty -> two toasts.
  const expectedToasts = offGridFreq !== undefined ? 2 : 1;
  if (!(await waitFor(win, `document.querySelectorAll('.toast-success').length === ${expectedToasts}`, 5000))) {
    fail(`expected ${expectedToasts} success toast(s) (no-op suppression), got ${await js(`document.querySelectorAll('.toast-success').length`)}`);
  }
  step('noop-toasts', `no-op suppression: ${expectedToasts} success toast(s) for ${expectedToasts} real change(s), silent elsewhere`);
  await clearToasts();

  // --- 4. second apply: no dialog -------------------------------------------
  if (!(await clickApply())) {
    // Clean after the first apply (non-off-grid): dirty it again first.
    await setSlider(230);
    if (await floatingHidden()) fail('floating Apply did not reappear after moving the slider');
    await clickApply();
  }
  await sleep(400);
  const dialogAgain = await js(`!!document.querySelector('.modal')`);
  if (dialogAgain) fail('waiver dialog re-appeared on second apply (waiver lost?)');
  step('waiver2', 'second apply: no dialog, waiver accepted + persisted');

  // --- 5. per-card reset-to-default + apply ---------------------------------
  await setSlider(220);
  const resetResult = await js(`(() => {
    const card = document.querySelector('.oc-card[data-control="powerLimitW"]');
    Array.from(card.querySelectorAll('button')).find((b) => b.textContent.includes('Reset to default'))?.click();
    return card.querySelector('.oc-value').textContent;
  })()`);
  if (resetResult.trim() !== '210 W') fail(`reset-to-default readout is '${resetResult}' (expected '210 W')`);
  await clickApply();
  await sleep(400);
  const afterReset = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(afterReset.powerLimitW - 210) > 1e-6) fail(`reset apply failed: ${afterReset.powerLimitW}`);
  step('reset', `reset to default 210 W applied, read-back ${afterReset.powerLimitW} W`);

  // --- 5b. M2b-B retry note (M2b review F3) + F3 retry-with-verify ---------
  // The "Applied on retry" warn is shown ONLY when the retried apply
  // succeeded; a persistent io-failed apply exhausts its retries, fails, and
  // must show the error toast with NO warn note. F3 (M2C-A): when the mock
  // IGS is fully ON the fast path takes a single attempt by design — then we
  // assert the no-retry behavior instead (success without any retry note,
  // honest failure without retries on an always-failing backend).
  if (svcRunning && appRunning) {
    // Fast path: one attempt, immediate honest outcome, no retry note.
    backend.injectFail('powerLimitW', 'io-failed');
    await setSlider(220);
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 10000))) {
      fail('io-failed error toast missing on the IGS-on fast path');
    }
    await sleep(300);
    if (await js(`!!document.querySelector('.toast-warn')`)) {
      fail('fast path must NOT retry — a retry note appeared on the IGS-on apply');
    }
    backend.injectFail('powerLimitW', null);
    await setSlider(210);
    await clearToasts();
    await clickApply();
    await sleep(400);
    const recovered = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(recovered.powerLimitW - 210) > 1e-6) fail(`recovery did not restore 210 W: ${recovered.powerLimitW}`);
    await clearToasts();
    step('retry-note', 'IGS-on fast path: io-failed -> single attempt, error toast, NO retry note; recovery applied');
  } else {
    // First: a PERSISTENT io-failed apply exhausts its retries and fails — the
    // error toast appears and the warn note must NOT (it would be a lie).
    backend.injectFail('powerLimitW', 'io-failed');
    await setSlider(220);
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 10000))) {
      fail('io-failed error toast missing (always-fail retry)');
    }
    await sleep(300);
    if (await js(`!!document.querySelector('.toast-warn')`)) {
      fail('fully-failed retried apply must NOT show the "Applied on retry" note');
    }
    backend.injectFail('powerLimitW', null);
    // Then: a ONE-SHOT io-failed apply retries and succeeds — the note IS
    // shown and the read-back lands on the requested value.
    backend.injectFail('powerLimitW', 'io-failed', true);
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.toast-warn')).some((t) => (t.textContent ?? '').includes('Applied on retry'))`, 10000))) {
      fail('retried-and-succeeded apply did not show the "Applied on retry" note');
    }
    await sleep(300);
    if (await js(`!!document.querySelector('.toast-error')`)) {
      fail('one-shot retry ended in failure — an error toast appeared next to the note');
    }
    const retriedState = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(retriedState.powerLimitW - 220) > 1e-6) fail(`one-shot retry did not apply 220 W: ${retriedState.powerLimitW}`);
    // Recover: restore defaults via the OC UI.
    await setSlider(210);
    await clearToasts();
    await clickApply();
    await sleep(400);
    const recovered = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(recovered.powerLimitW - 210) > 1e-6) fail(`recovery did not restore 210 W: ${recovered.powerLimitW}`);
    await clearToasts();
    step('retry-note', 'io-failed apply: failed retry -> error toast only (no warn); one-shot retry -> "Applied on retry" note + 220 W read back');
  }

  // --- 6. fan editor ---------------------------------------------------------
  const fanReadonly = process.env.RID_MOCK_FAN_READONLY === '1';
  await js(`location.hash = '#/fan'`);
  await sleep(250);
  if (fanReadonly) {
    if (!(await waitFor(win, `!!document.querySelector('.fan-card')`))) fail('fan card did not render');
    const dots = await js(`document.querySelectorAll('.fan-dot').length`);
    if (dots !== 0) fail(`read-only fan page rendered ${dots} draggable dots`);
    const note = await js(`document.querySelector('.fan-card .card-note')?.textContent ?? ''`);
    if (!/read-only/i.test(note)) fail(`read-only note missing: '${note}'`);
    const applyBtn = await js(`Array.from(document.querySelectorAll('#page button')).some((b) => b.textContent.includes('Apply fan'))`);
    if (applyBtn) fail('read-only fan page shows an Apply button');
    step('fan-readonly', 'read-only fan path: mode + curve + RPM rendered, editing disabled, note shown');
    console.log('\nUI VERIFY OK\n' + steps.map((s) => '  ' + s).join('\n'));
    app.exit(0);
    return;
  }
  if (!(await waitFor(win, `!!document.querySelector('.fan-dot')`))) fail('fan editor dots did not render');
  const pointsBefore = await js(`document.querySelectorAll('.fan-dot').length`);
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Remove point'))?.click()`);
  await sleep(250);
  const pointsRemoved = await js(`document.querySelectorAll('.fan-dot').length`);
  if (pointsRemoved !== pointsBefore - 1) fail(`remove point: ${pointsBefore} -> ${pointsRemoved}`);
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Add point'))?.click()`);
  await sleep(250);
  const pointsAfter = await js(`document.querySelectorAll('.fan-dot').length`);
  if (pointsAfter !== pointsRemoved + 1) fail(`add point: ${pointsRemoved} -> ${pointsAfter}`);
  step('fan', `fan editor: remove ${pointsBefore} -> ${pointsRemoved}, add -> ${pointsAfter} (clamp at ${pointsAfter})`);

  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Add point'))?.click()`);
  await sleep(250);
  const pointsClamped = await js(`document.querySelectorAll('.fan-dot').length`);
  if (pointsClamped !== pointsAfter) fail(`add point past the clamp: ${pointsAfter} -> ${pointsClamped}`);
  step('fan-clamp', `add point blocked at the ${pointsClamped}-point device max`);

  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.trim() === 'Max cooling')?.click()`);
  await sleep(250);
  const presetLast = await js(`(() => {
    const dots = Array.from(document.querySelectorAll('.fan-dot')).map((d) => ({ t: Number(d.dataset.t), s: Number(d.dataset.speed) }));
    return JSON.stringify(dots.at(-1));
  })()`);
  step('fan-preset', `fan preset 'Max cooling' applied; last point ${presetLast}`);

  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Apply fan settings'))?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('fan apply success toast missing');
  const fanState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (fanState.fanMode !== 'curve' || fanState.fanCurve.length < 2) fail(`fan apply not reflected in read-back: ${JSON.stringify(fanState.fanCurve?.length)} points`);
  step('fan-apply', `fan apply OK (mode ${fanState.fanMode}, ${fanState.fanCurve.length} points read back)`);

  // --- 7. fan apply failure surfaces the mapped OcErrorCode message --------
  backend.injectFail('fanCurve', 'out-of-range');
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Apply fan settings'))?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 5000))) fail('fan apply failure toast missing');
  const errMsg = await js(`document.querySelector('.toast-error .toast-message')?.textContent ?? ''`);
  if (!/outside the range/i.test(errMsg)) fail(`fan failure toast not mapped via errorMessage: '${errMsg}'`);
  backend.injectFail('fanCurve', null);
  step('fan-fail-toast', `fan apply failure mapped: '${errMsg}'`);

  // --- 8. startup (Run-key) channels (M2b) ----------------------------------
  const startState = await js(`window.arcPower.startupGet()`);
  if (startState.enabled !== false) fail(`startupGet initial state: ${JSON.stringify(startState)}`);
  const setOn = await js(`window.arcPower.startupSet(true, 'profile-1')`);
  if (setOn.enabled !== true || setOn.profileId !== 'profile-1') fail(`startupSet(true): ${JSON.stringify(setOn)}`);
  if (!/--apply-profile profile-1/.test(setOn.value ?? '')) fail(`startupSet value: ${setOn.value}`);
  const setOff = await js(`window.arcPower.startupSet(false, null)`);
  if (setOff.enabled !== false || setOff.profileId !== null) fail(`startupSet(false): ${JSON.stringify(setOff)}`);
  const badRejected = await js(`(async () => { try { await window.arcPower.startupSet(true, null); return 'accepted'; } catch (e) { return 'rejected'; } })()`);
  if (badRejected !== 'rejected') fail(`startupSet(true, null) was not rejected (${badRejected})`);
  step('startup-ipc', `startup channels: get -> set(profile-1) -> set(off) -> invalid payload rejected`);

  // --- 9. M2b-B Monitoring: readout grid + collapsible Canvas segments ------
  await js(`location.hash = '#/monitoring'`);
  if (!(await waitFor(win, `document.querySelectorAll('.seg-card').length === 5`))) {
    fail(`expected 5 monitoring segments, got ${await js(`document.querySelectorAll('.seg-card').length`)}`);
  }
  const firstOpen = await js(`!document.querySelector('.seg-card .seg-body').hidden`);
  const othersHidden = await js(`Array.from(document.querySelectorAll('.seg-card .seg-body')).slice(1).every((b) => b.hidden === true)`);
  if (!firstOpen || !othersHidden) fail(`segment defaults wrong: firstOpen=${firstOpen} othersHidden=${othersHidden}`);
  step('mon-segments', '5 segments render; first expanded, rest collapsed');

  await js(`document.querySelector('.seg-head').click()`);
  const collapsedNow = await js(`document.querySelector('.seg-card .seg-body').hidden`);
  if (!collapsedNow) fail('first segment did not collapse on header click');
  await js(`document.querySelector('.seg-head').click()`);
  const reopened = await js(`!document.querySelector('.seg-card .seg-body').hidden`);
  if (!reopened) fail('first segment did not re-expand');
  step('mon-collapse', 'segment header click toggles collapse/expand (chevron)');

  const monLabels = await js(`Array.from(document.querySelectorAll('.mon-readout .stat-label')).map((l) => l.textContent).join(',')`);
  for (const want of ['Core clock', 'Memory clock', 'Temperature', 'Power', 'Utilization', 'Fan', 'FPS']) {
    if (!monLabels.includes(want)) fail(`monitoring readout missing '${want}' (got '${monLabels}')`);
  }
  step('mon-readout', `monitoring readout grid: ${monLabels}`);

  if (!(await waitFor(win, `(document.querySelector('.mon-fps-note')?.textContent ?? '').includes('FPS unavailable')`, 5000))) {
    fail('FPS did not degrade to "FPS unavailable" (mock fps-poll)');
  }
  step('mon-fps', `FPS unavailable shown gracefully: '${await js(`document.querySelector('.mon-fps-note')?.textContent ?? ''`)}'`);

  const canvases = await js(`document.querySelectorAll('.seg-canvas').length`);
  if (canvases !== 5) fail(`expected 5 canvases, got ${canvases}`);
  step('mon-canvas', `${canvases} canvas graphs rendered from telemetry pushes`);

  // --- 9b. M2b review F4: the 1 s FPS poll must stop on navigation away ---
  const pollsOnEnter = getFpsPolls();
  await sleep(2600);
  const pollsWhileOnPage = getFpsPolls();
  if (pollsWhileOnPage <= pollsOnEnter) {
    fail(`fps-poll did not tick while on Monitoring (${pollsOnEnter} -> ${pollsWhileOnPage})`);
  }
  await js(`location.hash = '#/dashboard'`);
  await sleep(400);
  const pollsAfterLeave = getFpsPolls();
  await sleep(2600);
  const pollsLater = getFpsPolls();
  if (pollsLater !== pollsAfterLeave) {
    fail(`fps-poll kept firing after leaving Monitoring (${pollsAfterLeave} -> ${pollsLater})`);
  }
  step('mon-leave', `fps-poll stopped on navigation away (ticked ${pollsWhileOnPage - pollsOnEnter}x while on page; ${pollsLater - pollsAfterLeave} after leaving)`);

  // --- 10. M2b-B Profiles: round trip + ocOnBoot gate + tray-rebuild --------
  const cleanupProfiles = async () => {
    const env = await js(`window.arcPower.profilesList()`);
    for (const p of env.profiles.filter((x) => (x.name ?? '').startsWith('ui-verify'))) {
      await js(`window.arcPower.profilesDelete('${p.id}')`).catch(() => {});
    }
    const st = await js(`window.arcPower.startupGet()`);
    if (st.enabled) await js(`window.arcPower.startupSet(false, null)`).catch(() => {});
  };
  await cleanupProfiles(); // stale leftovers from a crashed previous run

  await js(`location.hash = '#/profiles'`);
  if (!(await waitFor(win, `!!document.querySelector('.profile-create')`))) fail('profiles page did not render the create button');
  if (!(await waitFor(win, `!!document.querySelector('.boot-checkbox')`))) fail('start-at-boot checkbox did not render');

  // After the OC flow the waiver is accepted (either this run or persisted):
  // the toggle must be enabled now.
  if (await js(`document.querySelector('.boot-checkbox').disabled`)) fail('start-at-boot still disabled after the waiver was accepted');
  step('boot-gate2', 'start-at-boot toggle enabled once the waiver is accepted');

  const rowByName = (name) => `Array.from(document.querySelectorAll('.profile-row')).find((r) => (r.querySelector('.profile-name')?.textContent ?? '') === '${name}')`;
  const clickRowButton = (name, label) => js(`(() => { const r = ${rowByName(name)}; if (!r) return false; const b = Array.from(r.querySelectorAll('button')).find((b) => b.textContent.trim() === '${label}'); if (!b) return false; b.click(); return true; })()`);

  // Create "ui-verify profile" from the current (default) driver settings.
  await js(`document.querySelector('.profile-create').click()`);
  if (!(await waitFor(win, `!!document.querySelector('.modal-input')`))) fail('create-profile modal did not open');
  await js(`(() => { const i = document.querySelector('.modal-input'); i.value = 'ui-verify profile'; })()`);
  await js(`document.querySelector('.modal button.btn-primary').click()`);
  if (!(await waitFor(win, `!!${rowByName('ui-verify profile')}`))) fail('created profile did not appear in the list');
  step('profiles-create', `created 'ui-verify profile' from current settings`);

  // Change the driver state THROUGH the OC UI (keeps the store honest — a
  // raw api.applySettings would bypass the store and break the no-op
  // comparison in the profile load), then load the profile: real change ->
  // exactly two success toasts (power + freq).
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  const setSliderFor = async (control, value) => js(`(() => {
    const card = document.querySelector('.oc-card[data-control="${control}"]');
    const input = card.querySelector('input[type="range"]');
    input.value = '${value}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await setSliderFor('powerLimitW', 220);
  await setSliderFor('gpuFreqOffsetMhz', 50);
  if (await floatingHidden()) fail('floating Apply did not appear for the setup change');
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('setup apply (220 W / 50 MHz) failed');
  await clearToasts();
  await js(`location.hash = '#/profiles'`);
  await sleep(250);

  await clearToasts();
  await clickRowButton('ui-verify profile', 'Load');
  if (!(await waitFor(win, `document.querySelectorAll('.toast-success').length === 2`, 5000))) {
    fail(`profile load did not toast the two real changes (got ${await js(`document.querySelectorAll('.toast-success').length`)} success toasts)`);
  }
  const activeAfterLoad = await js(`window.arcPower.profilesList().then((e) => e.settings.activeProfileId)`);
  const createdId = await js(`window.arcPower.profilesList().then((e) => (e.profiles.find((p) => p.name === 'ui-verify profile') ?? {}).id)`);
  if (activeAfterLoad !== createdId) fail(`load did not mark the profile active (${activeAfterLoad} != ${createdId})`);
  if (!(await waitFor(win, `!!document.querySelector('.profile-row.profile-active')`))) fail('active profile is not highlighted');
  step('profiles-load', 'load applied the profile: 2 toasts, active highlight, activeProfileId persisted');
  await clearToasts();

  // No-op load: create a copy of the CURRENT state, load it -> silent.
  await js(`document.querySelector('.profile-create').click()`);
  if (!(await waitFor(win, `!!document.querySelector('.modal-input')`))) fail('create modal did not reopen');
  await js(`(() => { const i = document.querySelector('.modal-input'); i.value = 'ui-verify copy'; })()`);
  await js(`document.querySelector('.modal button.btn-primary').click()`);
  if (!(await waitFor(win, `!!${rowByName('ui-verify copy')}`))) fail('copy profile did not appear');
  await clearToasts();
  await clickRowButton('ui-verify copy', 'Load');
  await sleep(600);
  if (await js(`!!document.querySelector('.toast-success')`)) fail('no-op profile load toasted a success');
  const noopInfo = await js(`Array.from(document.querySelectorAll('.toast-info')).map((t) => t.textContent).join(' ')`);
  if (!noopInfo.includes('nothing changed')) fail(`no-op load info missing: '${noopInfo}'`);
  step('profiles-noop', `no-op profile load: no success toast, info 'matches the current GPU state'`);
  await clearToasts();

  // ocOnBoot round trip (active profile = the copy).
  await js(`document.querySelector('.boot-checkbox').click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.enabled === true)`, 5000))) fail('start-at-boot ON did not set the Run key (mock)');
  const bootProfile = await js(`window.arcPower.startupGet().then((s) => s.profileId)`);
  const copyId = await js(`window.arcPower.profilesList().then((e) => (e.profiles.find((p) => p.name === 'ui-verify copy') ?? {}).id)`);
  if (bootProfile !== copyId) fail(`Run key profile mismatch: ${bootProfile} != ${copyId}`);
  await js(`document.querySelector('.boot-checkbox').click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.enabled === false)`, 5000))) fail('start-at-boot OFF did not clear the Run key');
  step('ocOnBoot', `start-at-boot toggle round trip via the Run key (profile ${bootProfile})`);
  await clearToasts();

  // Rename.
  await clickRowButton('ui-verify copy', 'Rename');
  if (!(await waitFor(win, `!!document.querySelector('.modal-input')`))) fail('rename modal did not open');
  await js(`(() => { const i = document.querySelector('.modal-input'); i.value = 'ui-verify renamed'; })()`);
  await js(`document.querySelector('.modal button.btn-primary').click()`);
  if (!(await waitFor(win, `!!${rowByName('ui-verify renamed')}`))) fail('rename did not update the list');
  step('profiles-rename', `renamed 'ui-verify copy' -> 'ui-verify renamed'`);

  // Delete the active profile: row disappears, active slot clears, the Run
  // key is removed (it was off already), tray-rebuild keeps counting.
  const rebuildsBefore = getTrayRebuilds();
  await clickRowButton('ui-verify renamed', 'Delete');
  if (!(await waitFor(win, `!!document.querySelector('.modal button.btn-danger')`))) fail('delete confirm modal did not open');
  await js(`document.querySelector('.modal button.btn-danger').click()`);
  if (!(await waitFor(win, `!${rowByName('ui-verify renamed')}`))) fail('deleted profile still in the list');
  const activeAfterDelete = await js(`window.arcPower.profilesList().then((e) => e.settings.activeProfileId)`);
  if (activeAfterDelete !== null) fail(`deleting the active profile left activeProfileId='${activeAfterDelete}'`);
  step('profiles-delete', `deleted the active profile; active slot cleared; Run key untouched (was off)`);

  const rebuildsAfter = getTrayRebuilds();
  if (rebuildsAfter <= rebuildsBefore) fail(`tray-rebuild was not called after profile mutations (${rebuildsBefore} -> ${rebuildsAfter})`);
  step('tray-rebuild', `tray menu rebuilt on profile changes (hook calls ${rebuildsAfter})`);

  // Cleanup: remove every ui-verify* profile and any Run key we left set.
  await cleanupProfiles();
  const leftover = await js(`window.arcPower.profilesList().then((e) => e.profiles.filter((p) => (p.name ?? '').startsWith('ui-verify')).length)`);
  if (leftover !== 0) fail(`cleanup left ${leftover} ui-verify profiles`);
  step('profiles-cleanup', `ui-verify profile cleanup: ${leftover} leftovers`);

  console.log('\nUI VERIFY OK\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}
