// Arc Power — dev-only UI verification (`electron . --ui-verify`).
//
// Drives the REAL window (renderer + preload + IPC + MockBackend) through
// the M2a/M2b-B/M2C-B product flows and asserts the outcomes:
//   1. shell renders (sidebar + header); M2C-B B7: the sidebar brand shows
//      the blue "AP" logo before "Arc Power";
//   1b. M2C-B B3: the header line below the GPU name is "Arc Power Ver.
//       0.1.0" (app:version IPC) — the driver version + date live in the
//       dashboard device card 'Driver version' kv ("32.0.101.8861 - Jul 05,
//       2026" from the mock driver-info fixture); no PCI ID anywhere;
//       M2C-B B2: NO capsSummary chips footer on the device card; M2C-B B8:
//       a 'Memory clock' kv row next to 'Graphics clock'; memory-clock
//       readout next to core clock, ONE merged "Service Status" card,
//       "Xe Cores 32 - Shader Units 4096";
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
//   5b. M2C-B F3 instant apply: ONE attempt, no retry note, no progress
//       label — an io-failed apply fails instantly with the composed
//       refusal toast (IGS-on requirement when IGS is off; plain + code
//       when fully on); M2C-B B5: the "Unapplied" chips + floating Apply
//       clear per-`result.ok` even while the driver read-back lags;
//   6. fan editor: mode toggle, add point, preset, apply; M2C-B B1: the
//       right-side 0-100% axis renders outside the plot;
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
  if (!brand.trim().includes('Arc Power')) fail(`sidebar brand is '${brand}'`);
  // M2C-B B7: the blue "AP" logo img sits before the "Arc Power" line.
  const logoSrc = await js(`document.querySelector('.sidebar-brand img.sidebar-logo')?.getAttribute('src') ?? ''`);
  if (!logoSrc.includes('icon.png')) fail(`sidebar brand logo missing: src='${logoSrc}'`);
  step('boot', `shell rendered; brand with logo (${logoSrc}); mock badge=${await js(`!!document.querySelector('.badge-mock')`)}`);

  // --- 1b. M2C-B B3 header version line + B2/B8 dashboard device card ------
  // B3: the line below the GPU name is the APP version (app:version IPC) —
  // the driver line moved to the dashboard device card.
  if (!(await waitFor(win, `(document.querySelector('.gpu-meta')?.textContent ?? '').trim() === 'Arc Power Ver. 0.1.0'`))) {
    fail(`header version line is '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}' (expected 'Arc Power Ver. 0.1.0')`);
  }
  // B6: the page favicon points at the generated blue-AP asset.
  const favicon = await js(`document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? ''`);
  if (!favicon.includes('favicon.png')) fail(`favicon link is '${favicon}'`);
  if (await js(`document.body.textContent.includes('PCI')`)) fail('PCI ID is still shown somewhere in the UI');
  // Top-right indicator: just the dot + the static 'Service Status' label.
  const headerIndicator = await js(`document.querySelector('.gpu-status-text')?.textContent ?? ''`);
  if (!headerIndicator.includes('Service Status')) fail(`header indicator is '${headerIndicator}' (expected 'Service Status')`);
  if (headerIndicator.includes('OC control OK')) fail(`header indicator still shows the verbose IGS text: '${headerIndicator}'`);
  step('version-line', `header line '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}'; no PCI text; indicator='${headerIndicator.trim()}'`);

  // Device card: driver version kv (B3 move), compute line, no persistent
  // waiver row, NO capsSummary chips footer (B2).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.card-grid .kv')).some((k) => (k.getAttribute('data-label') ?? '') === 'Driver version' && (k.textContent ?? '').includes('32.0.101.8861 - Jul 05, 2026'))`))) {
    fail(`device card driver version kv is '${await js(`document.querySelector('.card-grid .kv[data-label="Driver version"]')?.textContent ?? ''`)}' (expected '32.0.101.8861 - Jul 05, 2026')`);
  }
  if (!(await waitFor(win, `document.body.textContent.includes('Xe Cores 32 - Shader Units 4096')`))) {
    fail('Xe cores / shader units line missing');
  }
  if (await js(`document.body.textContent.includes('OC waiver')`)) fail('persistent waiver status is still shown');
  // B2: the chips footer ("Fan curve N points", power/volt/freq/temp notes)
  // is GONE from the device card — no chips inside the card grid at all.
  const gridChips = await js(`document.querySelectorAll('.card-grid .chip').length`);
  if (gridChips !== 0) fail(`B2: device card chips footer still renders ${gridChips} chips`);
  step('device-card', 'device card: Xe Cores 32 - Shader Units 4096, no OC waiver row, no PCI row, no chips footer');

  // M2C-B B8: 'Memory clock' kv row next to 'Graphics clock' (mock
  // telemetry memClockMhz = 2000).
  if (!(await waitFor(win, `(() => {
    const rows = Array.from(document.querySelectorAll('.card-grid .kv'));
    const mem = rows.find((k) => (k.getAttribute('data-label') ?? '') === 'Memory clock');
    const gfx = rows.find((k) => (k.getAttribute('data-label') ?? '') === 'Graphics clock');
    return !!mem && !!gfx && (mem.textContent ?? '').includes('2000');
  })()`))) {
    fail(`memory clock kv is '${await js(`document.querySelector('.card-grid .kv[data-label="Memory clock"]')?.textContent ?? ''`)}' (expected '2000 MHz')`);
  }
  step('mem-clock-kv', `device card memory clock kv = ${await js(`document.querySelector('.card-grid .kv[data-label="Memory clock"]')?.textContent ?? ''`)} (next to Graphics clock)`);

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

  // --- 5b. M2C-B F3 instant apply: ONE attempt, composed refusal toasts,
  // --- no retry note, no progress label. M2C-B B5: chips + floating Apply
  // --- clear per-`result.ok` even while the driver read-back lags. --------
  const igsOff = !svcRunning && !appRunning;

  // B5 first: simulate a read-back that LAGS (the driver write succeeded,
  // the read-back still reports the old value). After the successful apply
  // the chip must clear and the button must hide against the APPLIED
  // reference, even though the driver still reads 210.
  const realApply = backend.applySettings.bind(backend);
  backend.applySettings = async (d, s) => {
    const before = backend._state.powerLimitW;
    const res = await realApply(d, s);
    backend._state.powerLimitW = before; // the read-back lags
    return res;
  };
  await setSlider(220);
  await clearToasts();
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('lagging-read-back apply success toast missing');
  await sleep(300);
  const lagState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(lagState.powerLimitW - 210) > 1e-6) fail(`read-back lag setup broken: ${lagState.powerLimitW}`);
  const chipHidden = await js(`Array.from(document.querySelectorAll('.oc-card')).every((c) => c.querySelector('.oc-dirty')?.hidden !== false)`);
  if (!chipHidden) fail('B5: an Unapplied chip is still visible after a successful apply (read-back lags)');
  if (!(await floatingHidden())) fail('B5: floating Apply still visible after a successful apply (read-back lags)');
  step('b5-lag', `B5: apply ok with lagging read-back (${lagState.powerLimitW} W) -> chips clear, Apply hidden`);
  await clearToasts();
  // Restore the real backend and re-render the OC page fresh (values snap
  // back to the 210 W read-back; the applied reference is per-page state).
  backend.applySettings = realApply;
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  if (!(await floatingHidden())) fail('floating Apply visible on a clean re-render');
  step('b5-fresh', 'B5: fresh re-render is clean (applied reference is per-render state)');

  if (igsOff) {
    // IGS fully off: an io-failed powerLimit apply fails INSTANTLY and the
    // toast names the IGS-on requirement (composed in main).
    backend.injectFail('powerLimitW', 'io-failed');
    await setSlider(220);
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 10000))) {
      fail('io-failed error toast missing (instant apply, IGS off)');
    }
    const errMsg = await js(`document.querySelector('.toast-error .toast-message')?.textContent ?? ''`);
    if (!/Intel Graphics Software/.test(errMsg)) fail(`IGS-off refusal toast does not name IGS: '${errMsg}'`);
    if (await js(`!!document.querySelector('.toast-warn')`)) fail('instant apply must NOT show a retry note');
    // The "Applying — retry N/9" surface is gone: the button never shows it.
    const btnLabel = await js(`document.querySelector('.floating-apply')?.textContent ?? ''`);
    if (btnLabel.includes('retry')) fail(`floating Apply shows a retry label: '${btnLabel}'`);
    // A one-shot io-failed backend (would succeed on a retry) must STILL
    // fail instantly — no retry attempt ever happens.
    backend.injectFail('powerLimitW', 'io-failed', true);
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 10000))) {
      fail('one-shot io-failed apply did not fail instantly (a retry must never happen)');
    }
    await sleep(300);
    if (await js(`!!document.querySelector('.toast-warn')`)) fail('instant apply: retry note appeared');
    const oneShotState = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(oneShotState.powerLimitW - 210) > 1e-6) fail(`instant apply changed the driver state: ${oneShotState.powerLimitW}`);
    backend.injectFail('powerLimitW', null);
    // Recover: apply the requested value cleanly, then restore 210 W so the
    // later profile-load step sees the same baseline in every variant.
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('recovery apply did not succeed');
    const recovered = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(recovered.powerLimitW - 220) > 1e-6) fail(`recovery did not apply 220 W: ${recovered.powerLimitW}`);
    await clearToasts();
    await setSlider(210);
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('baseline restore (210 W) did not apply');
    const baseline = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(baseline.powerLimitW - 210) > 1e-6) fail(`baseline is not 210 W: ${baseline.powerLimitW}`);
    await clearToasts();
    step('instant-igs-off', `IGS-off: io-failed -> ONE attempt, IGS-on refusal toast ('${errMsg.trim()}'), no retry note, no progress label; recovery + baseline applied`);
  } else {
    // IGS fully on (or half-state): a refusal there is rare -> plain + code.
    backend.injectFail('powerLimitW', 'io-failed');
    await setSlider(220);
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 10000))) {
      fail('io-failed error toast missing (instant apply, IGS on)');
    }
    const errMsg = await js(`document.querySelector('.toast-error .toast-message')?.textContent ?? ''`);
    if (!/refused the change/.test(errMsg)) fail(`IGS-on refusal toast is '${errMsg}' (expected plain + code)`);
    if (/Intel Graphics Software/.test(errMsg)) fail(`IGS-on refusal toast wrongly names IGS: '${errMsg}'`);
    if (await js(`!!document.querySelector('.toast-warn')`)) fail('instant apply must NOT show a retry note');
    backend.injectFail('powerLimitW', null);
    // Recovery: the driver read-back already reports 210 (the refusal never
    // wrote) — the settings are clean, so the button hides and nothing more
    // is applied (no-op suppression in action).
    await setSlider(210);
    await clearToasts();
    if (!(await floatingHidden())) fail('floating Apply visible while clean after the refusal');
    await clickApply();
    await sleep(300);
    const recovered = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(recovered.powerLimitW - 210) > 1e-6) fail(`recovery did not restore 210 W: ${recovered.powerLimitW}`);
    await clearToasts();
    step('instant-igs-on', `IGS-on: io-failed -> ONE attempt, plain refusal toast ('${errMsg.trim()}'), no retry note; recovery clean (210 W)`);
  }

  // --- 6. fan editor ---------------------------------------------------------
  const fanReadonly = process.env.RID_MOCK_FAN_READONLY === '1';
  await js(`location.hash = '#/fan'`);
  await sleep(250);
  // M2C-B B1: the right-side 0-100% axis renders OUTSIDE the plot (one tick
  // per grid line, top-down: 100% first) and the old in-plot labels are gone.
  if (!(await waitFor(win, `document.querySelectorAll('.fan-yaxis .fan-yaxis-tick').length === 5`))) {
    fail(`fan right-side axis missing (got ${await js(`document.querySelectorAll('.fan-yaxis .fan-yaxis-tick').length`)} ticks)`);
  }
  const axisTicks = await js(`Array.from(document.querySelectorAll('.fan-yaxis .fan-yaxis-tick')).map((t) => t.textContent).join(',')`);
  if (axisTicks !== '100%,75%,50%,25%,0%') fail(`fan axis ticks are '${axisTicks}' (expected 100%,75%,50%,25%,0% top-down)`);
  if (await js(`document.querySelectorAll('.fan-svg .fan-label').length !== 0`)) fail('B1: fan % labels still drawn inside the SVG plot');
  if (!(await waitFor(win, `!!document.querySelector('.fan-plot .fan-svg')`))) fail('fan plot wrapper missing');
  // M2C-B review B1: the 100%/0% edge labels must NOT be centered on the
  // stage edges (translateY(-50%) would clip their outer half under
  // .fan-stage overflow:hidden) — they hug the edge (translateY(0) /
  // translateY(-100%)) so all five render fully while the interior ticks
  // stay centered on their grid lines.
  if (!(await waitFor(win, `(() => {
    const ticks = Array.from(document.querySelectorAll('.fan-yaxis .fan-yaxis-tick'));
    if (ticks.length !== 5) return false;
    const [top, , mid, , bottom] = ticks;
    if (!top.classList.contains('fan-yaxis-tick-edge-top')) return false;
    if (!bottom.classList.contains('fan-yaxis-tick-edge-bottom')) return false;
    const midTransform = getComputedStyle(mid).transform;
    const topTransform = getComputedStyle(top).transform;
    const bottomTransform = getComputedStyle(bottom).transform;
    return topTransform !== midTransform && bottomTransform !== midTransform;
  })()`))) {
    fail('B1: fan axis edge ticks are not edge-clamped (their outer half is clipped by .fan-stage)');
  }
  step('fan-axis', `B1: right-side axis '${axisTicks}' outside the plot, aligned to the grid, edge ticks clamped`);
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
  // F3 instant: a fan REFUSAL (io-failed) must toast the COMPOSED refusal
  // message (per.message wins over the errorCode mapping — review MINOR 1).
  backend.injectFail('fanCurve', 'io-failed');
  await clearToasts();
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Apply fan settings'))?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 5000))) fail('fan apply refusal toast missing');
  const refuseMsg = await js(`document.querySelector('.toast-error .toast-message')?.textContent ?? ''`);
  if (!/refused the change/.test(refuseMsg)) fail(`fan refusal toast did not use the composed message: '${refuseMsg}'`);
  if (/read-back mismatch/.test(refuseMsg)) fail(`fan refusal toast fell back to the errorCode mapping: '${refuseMsg}'`);
  backend.injectFail('fanCurve', null);
  step('fan-fail-toast', `fan apply failure mapped: '${errMsg}' (hard) + refusal composed: '${refuseMsg}'`);

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
