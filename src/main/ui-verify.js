// Arc Power — dev-only UI verification (`electron . --ui-verify`).
//
// Drives the REAL window (renderer + preload + IPC + MockBackend) through
// the M2a/M2b-B/M2C-B/M2D/M3-A product flows and asserts the outcomes:
//   1. shell renders (sidebar + header); M3-A: the sidebar brand is the
//      "Arc Power" text with the small blue accent bar BELOW it (the user's
//      preferred variant — no logo image);
//   1b. M2C-B B3: the header line below the GPU name is "Arc Power Ver.
//       0.1.0" (app:version IPC) — the driver version + date live in the
//       dashboard device card 'Driver version' kv ("32.0.101.8861 - Jul 05,
//       2026" from the mock driver-info fixture); no PCI ID anywhere;
//       M2C-B B2: NO capsSummary chips footer on the device card; M2C-B B8:
//       a 'Memory clock' kv row next to 'Graphics clock'; memory-clock
//       readout next to core clock; M3-A: the header has NO status dot and
//       NO "Service Status" label (the IGS indicator is gone);
//   1c. M3-A: the dashboard shows the general GPU HEALTH card (five rows:
//       Driver installed / Device detected / Clocks normal / OC working /
//       Arc Power working) — the merged Service Status card is GONE, as is
//       everything IGS (dot, half-state note, toggle button);
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
//       refusal toast (plain "The GPU driver refused the change" + the
//       error code); M2C-B B5: the "Unapplied" chips + floating Apply
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
//  12. M2C-C extended-range variant (RID_MOCK_EXTENDED_RANGES=1): the power
//      slider max is 315 W and the temp slider max 115 C; setting PL 300 and
//      applying shows the extended-range confirm dialog; Cancel aborts
//      (device untouched); Apply anyway applies and the read-back sticks at
//      300 W; restored to 210 W afterwards.
//  13. M2C-C worker-apply toast variant (RID_MOCK_WORKER_APPLY=1, runs on
//      top of the extended variant): before the apply, an info toast
//      explains "Administrator approval is needed to apply GPU settings."
//  14. M2D featureset dropdown (mock mode): present with all 4 files, the
//      live swap round trip swaps the whole UI surface to b580 percent
//      units and back (waiver preserved); the mem-clock pins track the
//      a770 featureset (2187 MHz).
//  15. M2D featureset variants (RID_MOCK_FEATURESET=b580|pro-b50|arc-igpu):
//      runFeaturesetVerify — a reduced flow per device line (OC cards /
//      no-OC note, fan editor / read-only / no-fan, monitoring, swap round
//      trip, b580 percent-unit apply).
//  16. M3-A Tweaks page: the registry-hacks catalog renders with live
//      (mock) states — mpo=Off, hags=Active, game-dvr=Default,
//      fullscreen-optimizations=Active — read-only (apply buttons disabled,
//      "Requires administrator (M3-B)" note).
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
  // M3-A: the logo IMAGE is gone — the user's preferred variant is the text
  // with the small blue accent bar BELOW it (the ::after pseudo-element).
  if (await js(`!!document.querySelector('.sidebar-brand img.sidebar-logo')`)) {
    fail('M3-A: the sidebar logo image is still rendered (the blue-bar variant was requested)');
  }
  if (!(await js(`(() => {
    const brand = document.querySelector('.sidebar-brand');
    const bar = brand ? getComputedStyle(brand, '::after') : null;
    return !!bar && bar.width === '22px' && bar.display !== 'none';
  })()`))) {
    fail('M3-A: the blue accent bar below the "Arc Power" text is missing');
  }
  step('boot', `shell rendered; brand '${brand.trim()}' + blue accent bar (no logo img); mock badge=${await js(`!!document.querySelector('.badge-mock')`)}`);

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
  // M3-A: the header status indicator is REMOVED — no dot, no 'Service
  // Status' label anywhere (IGS is no longer a status item).
  if (await js(`!!document.querySelector('.gpu-header .status-dot')`)) fail('M3-A: the header still renders a status dot');
  if (await js(`document.body.textContent.includes('Service Status')`)) fail('M3-A: "Service Status" is still rendered somewhere');
  if (await js(`document.body.textContent.includes('IGS')`)) fail('M3-A: IGS is still surfaced as a status item');
  step('version-line', `header line '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}'; no PCI text; no status dot / Service Status label`);

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

  // M2C-B B8: 'Memory clock' kv row next to 'Graphics clock' (a770
  // featureset telemetry memClockMhz = 2187).
  if (!(await waitFor(win, `(() => {
    const rows = Array.from(document.querySelectorAll('.card-grid .kv'));
    const mem = rows.find((k) => (k.getAttribute('data-label') ?? '') === 'Memory clock');
    const gfx = rows.find((k) => (k.getAttribute('data-label') ?? '') === 'Graphics clock');
    return !!mem && !!gfx && (mem.textContent ?? '').includes('2187');
  })()`))) {
    fail(`memory clock kv is '${await js(`document.querySelector('.card-grid .kv[data-label="Memory clock"]')?.textContent ?? ''`)}' (expected '2187 MHz')`);
  }
  step('mem-clock-kv', `device card memory clock kv = ${await js(`document.querySelector('.card-grid .kv[data-label="Memory clock"]')?.textContent ?? ''`)} (next to Graphics clock)`);

  // Memory clock readout next to core clock (a770 featureset: 2187 MHz).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock' && (t.querySelector('.stat-value')?.textContent ?? '') === '2187')`))) {
    fail('memory-clock readout missing or not 2187 MHz');
  }
  step('mem-clock', `memory clock readout = ${await js(`Array.from(document.querySelectorAll('#dash-readout .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock')?.querySelector('.stat-value')?.textContent ?? ''`)} MHz (compact tiles)`);

  // ONE general GPU HEALTH card (M3-A): five rows, honest per-row state,
  // no Level Zero item, no IGCL detail line (the old Service Status card +
  // IGS half-state + toggle are gone).
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`))) fail('expected exactly one GPU Health card');
  const statusTitle = await js(`document.querySelector('.health-card .card-title')?.textContent ?? ''`);
  if (statusTitle.trim() !== 'GPU Health') fail(`health card title is '${statusTitle}'`);
  if (await js(`document.querySelectorAll('.health-card .health-row').length !== 5`)) {
    fail(`health card rows: got ${await js(`document.querySelectorAll('.health-card .health-row').length`)} (expected 5)`);
  }
  const rowIds = await js(`Array.from(document.querySelectorAll('.health-card .health-row')).map((r) => r.dataset.row).join(',')`);
  if (rowIds !== 'driver,device,clocks,oc,app') fail(`health card rows are '${rowIds}' (expected driver,device,clocks,oc,app)`);
  const rowLabels = await js(`Array.from(document.querySelectorAll('.health-card .health-row-label')).map((l) => l.textContent).join('|')`);
  for (const want of ['Driver installed', 'Device detected', 'Clocks normal', 'OC working', 'Arc Power working']) {
    if (!rowLabels.includes(want)) fail(`health card missing row '${want}' (got '${rowLabels}')`);
  }
  // The mock boot state: driver + device + app rows ok, OC row unknown
  // (nothing applied yet in this session), clocks ok (waiting for telemetry
  // or live).
  const dots = await js(`Array.from(document.querySelectorAll('.health-card .health-row .status-dot')).map((d) => d.className).join('|')`);
  if (!/status-ok/.test(dots)) fail(`no ok dot on the health card: '${dots}'`);
  if (!/status-unknown/.test(dots)) fail(`no unknown dot (OC never applied) on the health card: '${dots}'`);
  if (await js(`document.querySelector('.health-card')?.textContent.includes('Level Zero')`)) fail('Level Zero is still a health item');
  if (await js(`!!document.querySelector('.igs-toggle')`)) fail('M3-A: the IGS toggle button is still rendered');
  step('health-card', `one 'GPU Health' card: rows '${rowLabels}', dots '${dots.split(' ').filter((c) => c.startsWith('status-')).join(',')}'`);

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
  // (M3-A: the IGS-on/IGS-off refusal variants are unified — IGS is no
  // longer a status item, and the refusal wording never named IGS anyway.)

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

  // An io-failed powerLimit apply fails INSTANTLY and the toast is the plain
  // driver message + code (M2C-C: the IGS-naming wording is REMOVED — the
  // real gate was elevation, docs §8c).
  backend.injectFail('powerLimitW', 'io-failed');
  await setSlider(220);
  await clearToasts();
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 10000))) {
    fail('io-failed error toast missing (instant apply)');
  }
  const refusalMsg = await js(`document.querySelector('.toast-error .toast-message')?.textContent ?? ''`);
  if (!/refused the change/.test(refusalMsg)) fail(`refusal toast is not the plain message: '${refusalMsg}'`);
  if (/Intel Graphics Software/.test(refusalMsg)) fail(`M2C-C: refusal toast still names IGS (obsolete wording): '${refusalMsg}'`);
  if (!/\(io-failed\)/.test(refusalMsg)) fail(`M2C-C: refusal toast is missing the error code: '${refusalMsg}'`);
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
  step('instant-apply', `io-failed -> ONE attempt, plain refusal toast ('${refusalMsg.trim()}'), no retry note, no progress label; recovery + baseline applied`);

  // --- 5c. M2C-C extended-range variant: full slider range, confirm dialog,
  // --- worker-apply elevation toast (RID_MOCK_EXTENDED_RANGES=1, optional
  // --- RID_MOCK_WORKER_APPLY=1 on top) -------------------------------------
  const extendedRanges = process.env.RID_MOCK_EXTENDED_RANGES === '1';
  const workerApply = process.env.RID_MOCK_WORKER_APPLY === '1';
  if (extendedRanges) {
    const setPlSlider = (value) => js(`(() => {
      const card = document.querySelector('.oc-card[data-control="powerLimitW"]');
      const input = card.querySelector('input[type="range"]');
      input.value = '${value}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return card.querySelector('.oc-value').textContent;
    })()`);
    const modalTitle = () => js(`document.querySelector('.modal .modal-title')?.textContent ?? ''`);

    // The extended ranges are exposed: slider maxes 315 W / 115 C.
    const plMax = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] input[type="range"]')?.getAttribute('max')`);
    if (plMax !== '315') fail(`M2C-C: power slider max is '${plMax}' (expected 315)`);
    const tlMax = await js(`document.querySelector('.oc-card[data-control="tempLimitC"] input[type="range"]')?.getAttribute('max')`);
    if (tlMax !== '115') fail(`M2C-C: temp slider max is '${tlMax}' (expected 115)`);
    step('extended-ranges', `extended ranges exposed: PL slider max ${plMax} W, TL slider max ${tlMax} C`);

    // 300 W -> apply -> the extended-range confirm dialog.
    await setPlSlider(300);
    if (await floatingHidden()) fail('floating Apply did not appear for the extended value');
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.modal')`))) fail('extended-range confirm dialog did not appear');
    if (!(await modalTitle()).includes('Extended power/temperature limit')) {
      fail(`extended-range dialog title is '${await modalTitle()}'`);
    }
    const dialogText = await js(`document.querySelector('.modal .modal-text')?.textContent ?? ''`);
    if (!/beyond Intel/.test(dialogText) || !/300 W/.test(dialogText)) {
      fail(`extended-range warning text is '${dialogText}' (expected the honest beyond-standard warning mentioning the BiFrost 300 W)`);
    }
    step('extended-confirm', 'extended-range confirm dialog shown with the honest beyond-standard warning');

    // Cancel: nothing applies.
    await js(`document.querySelector('.modal button.btn-ghost')?.click()`);
    await sleep(300);
    const canceledState = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(canceledState.powerLimitW - 210) > 1e-6) fail(`extended apply ran after Cancel! powerLimit=${canceledState.powerLimitW}`);
    step('extended-cancel', 'extended-range Cancel: apply aborted, device untouched (210 W)');

    // Accept: the apply proceeds; with the worker-apply variant an info
    // toast explains the UAC prompt BEFORE the apply.
    await clearToasts();
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.modal')`))) fail('extended-range confirm dialog did not reappear');
    await js(`document.querySelector('.modal button.btn-danger')?.click()`);
    if (workerApply) {
      if (!(await waitFor(win, `Array.from(document.querySelectorAll('.toast-info')).some((t) => (t.textContent ?? '').includes('Administrator approval is needed'))`, 5000))) {
        fail('M2C-C: the elevation explanation toast did not appear before the worker apply');
      }
      step('elevation-toast', `elevation explanation toast shown before the UAC prompt ('${await js(`Array.from(document.querySelectorAll('.toast-info')).find((t) => (t.textContent ?? '').includes('Administrator approval is needed'))?.querySelector('.toast-message')?.textContent ?? ''`)}')`);
    }
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('extended apply success toast missing');
    const extendedState = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(extendedState.powerLimitW - 300) > 1e-6) fail(`extended apply did not stick: powerLimit=${extendedState.powerLimitW}`);
    step('extended-apply', `extended apply (300 W) accepted through the confirm dialog, read-back ${extendedState.powerLimitW} W`);
    await clearToasts();

    // Restore the standard baseline for the later steps.
    await setPlSlider(210);
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('extended baseline restore (210 W) did not apply');
    const baseline = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(baseline.powerLimitW - 210) > 1e-6) fail(`extended baseline is not 210 W: ${baseline.powerLimitW}`);
    await clearToasts();
    step('extended-restore', 'extended baseline restored to 210 W');
  }

  // --- 5d. M2D mock featureset swap: the header dropdown round-trips the
  // --- WHOLE UI surface (mock mode only; absent in real mode) ---------------
  if (!(await waitFor(win, `!!document.querySelector('.featureset-select')`))) {
    fail('M2D: featureset dropdown missing in mock mode');
  }
  const fsOptions = await js(`Array.from(document.querySelectorAll('.featureset-select option')).map((o) => o.value)`);
  if (fsOptions.length !== 4) fail(`M2D: dropdown lists ${fsOptions.length} featuresets (expected 4)`);
  for (const want of ['a770', 'b580', 'pro-b50', 'arc-igpu']) {
    if (!fsOptions.includes(want)) fail(`M2D: dropdown options are '${fsOptions.join(',')}' (missing '${want}')`);
  }
  const fsSelected = await js(`document.querySelector('.featureset-select').value`);
  if (fsSelected !== 'a770') fail(`M2D: current selection is '${fsSelected}' (expected a770)`);
  step('fs-boot', `featureset dropdown present in mock mode: ${fsOptions.length} options, current '${fsSelected}'`);

  const swapTo = (id) => js(`(() => {
    try {
      const s = document.querySelector('.featureset-select');
      s.value = '${id}';
      s.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    } catch (e) { return 'ERR: ' + (e && e.stack ? e.stack : String(e)); }
  })()`);

  // Swap to the Battlemage featureset via the dropdown: the OC page
  // re-renders live with percent units + the b580 defaults/control set.
  await swapTo('b580');
  if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '100 %'`))) {
    fail(`M2D swap: PL readout is '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`)}' (expected '100 %')`);
  }
  const b580Caps = await js(`window.arcPower.getCapabilities(0)`);
  if (b580Caps.ranges.powerLimitW.units !== '%' || b580Caps.ranges.tempLimitC.units !== '%' || b580Caps.ranges.gpuVoltOffsetV.units !== '%') {
    fail(`M2D swap: b580 percent units not applied: ${JSON.stringify(b580Caps.ranges)}`);
  }
  if (b580Caps.controls.gpuLock === true || b580Caps.controls.vfCurve !== true) {
    fail(`M2D swap: b580 control set wrong: ${JSON.stringify(b580Caps.controls)}`);
  }
  step('fs-swap-b580', `swap -> b580: PL readout '100 %', percent units, gpuLock unsupported, vfCurve supported`);

  // M2D: the swap payload replaces the boot driver date — the b580 card must
  // NOT pair 32.0.140.4109 with the a770 boot registry date (7-5-2026).
  await js(`location.hash = '#/dashboard'`);
  await sleep(250);
  const b580DriverRow = await js(`document.querySelector('.card-grid .kv[data-label="Driver version"]')?.textContent ?? ''`);
  if (!b580DriverRow.includes('32.0.140.4109') || b580DriverRow.includes('Jul')) {
    fail(`M2D swap: stale driver date on the b580 card: '${b580DriverRow}'`);
  }
  step('fs-swap-b580-date', `swap -> b580: driver card '${b580DriverRow.trim()}' (no stale date)`);
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);

  // Swap back: the A770 surface (W units, 210 W default) returns and the
  // app-level waiver acceptance survives (consent, not driver state).
  await swapTo('a770');
  if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '210 W'`))) {
    fail(`M2D swap-back: PL readout is '${await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`)}' (expected '210 W')`);
  }
  const a770Caps = await js(`window.arcPower.getCapabilities(0)`);
  if (a770Caps.ranges.powerLimitW.units !== 'W') fail(`M2D swap-back: units not back to W: ${JSON.stringify(a770Caps.ranges.powerLimitW)}`);
  const selBack = await js(`document.querySelector('.featureset-select').value`);
  if (selBack !== 'a770') fail(`M2D swap-back: dropdown selection is '${selBack}'`);
  if ((await js(`window.arcPower.waiverGet(0)`)).accepted !== true) fail('M2D swap: waiver acceptance was lost across the swap');
  // M2D: the a770 featureset's own registry date returns with the surface.
  await js(`location.hash = '#/dashboard'`);
  await sleep(250);
  const a770DriverRow = await js(`document.querySelector('.card-grid .kv[data-label="Driver version"]')?.textContent ?? ''`);
  if (!a770DriverRow.includes('Jul 05, 2026')) fail(`M2D swap-back: a770 driver date missing on the card: '${a770DriverRow}'`);
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  step('fs-swap-back', `swap back -> a770: PL readout '210 W', W units, waiver preserved, driver date 'Jul 05, 2026'`);

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

  // --- 16. M3-A Tweaks page: the registry-hacks catalog renders with the
  // --- live (mock) states — read-only, no apply channel ---------------------
  await js(`location.hash = '#/tweaks'`);
  if (!(await waitFor(win, `document.querySelectorAll('.tweak-card').length === 4`))) {
    fail(`tweaks page did not render 4 catalog cards (got ${await js(`document.querySelectorAll('.tweak-card').length`)})`);
  }
  const tweakIds = await js(`Array.from(document.querySelectorAll('.tweak-card')).map((c) => c.dataset.tweak).join(',')`);
  if (tweakIds !== 'mpo,hags,game-dvr,fullscreen-optimizations') fail(`tweak cards are '${tweakIds}'`);
  // The mock fixture covers the whole vocabulary: mpo=Off, hags=Active,
  // game-dvr=Default, fullscreen-optimizations=Active.
  const tweakStateOf = (id) => js(`document.querySelector('.tweak-card[data-tweak="${id}"] .tweak-state-label')?.textContent ?? ''`);
  if (!(await waitFor(win, `(document.querySelector('.tweak-card[data-tweak="mpo"] .tweak-state-label')?.textContent ?? '').trim() === 'Off'`))) {
    fail(`mpo state is '${await tweakStateOf('mpo')}' (expected 'Off' — the fixture default)`);
  }
  if ((await tweakStateOf('hags')).trim() !== 'Active') fail(`hags state is '${await tweakStateOf('hags')}' (expected 'Active')`);
  if ((await tweakStateOf('game-dvr')).trim() !== 'Default') fail(`game-dvr state is '${await tweakStateOf('game-dvr')}' (expected 'Default')`);
  if ((await tweakStateOf('fullscreen-optimizations')).trim() !== 'Active') fail(`fullscreen state is '${await tweakStateOf('fullscreen-optimizations')}' (expected 'Active')`);
  // Read-side only: every apply button is disabled with the M3-B note.
  const applyBtns = await js(`Array.from(document.querySelectorAll('.tweak-card .tweak-apply')).map((b) => ({ disabled: b.disabled, text: b.textContent.trim() }))`);
  if (applyBtns.length !== 4 || applyBtns.some((b) => !b.disabled)) fail(`M3-A: apply buttons must be disabled (read-side only): ${JSON.stringify(applyBtns)}`);
  if (applyBtns.some((b) => !b.text.includes('Requires administrator (M3-B)'))) fail(`apply buttons must carry the M3-B note: ${JSON.stringify(applyBtns)}`);
  // The read values render honestly (hags shows HwSchMode=0x2; the
  // enumerate read shows the flagged-app detail).
  if (!(await js(`(document.querySelector('.tweak-card[data-tweak="hags"] .tweak-read-path')?.textContent ?? '').includes('HwSchMode')`))) {
    fail('hags read path missing HwSchMode');
  }
  if (!(await js(`(document.querySelector('.tweak-card[data-tweak="hags"] .tweak-read-data')?.textContent ?? '').includes('0x2')`))) {
    fail(`hags read value is '${await js(`document.querySelector('.tweak-card[data-tweak="hags"] .tweak-read-data')?.textContent ?? ''`)}' (expected 0x2)`);
  }
  if (!(await js(`(document.querySelector('.tweak-card[data-tweak="mpo"] .tweak-read-data')?.textContent ?? '').includes('not present')`))) {
    fail('mpo reads must show "not present" for the absent values');
  }
  // The page is read-side only at the IPC level too.
  const catalog = await js(`window.arcPower.registryCatalog()`);
  if (catalog.entries.length !== 4 || catalog.states.length !== 4) fail(`registry-catalog IPC returned ${catalog.entries.length} entries / ${catalog.states.length} states`);
  step('tweaks', `Tweaks: ${tweakIds} rendered; mpo=Off, hags=Active (HwSchMode=0x2), game-dvr=Default, fullscreen=Active; apply disabled ('Requires administrator (M3-B)')`);

  console.log('\nUI VERIFY OK\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M2D — featureset variants (RID_MOCK_FEATURESET=b580|pro-b50|arc-igpu)
// ---------------------------------------------------------------------------
//
// The full default flow is pinned to A770 values (W units, 210 W, editable
// fan, 315 W extended, ...) so a different featureset gets a REDUCED flow
// instead: boot + dropdown, the per-featureset OC/fan/monitoring surface,
// a live swap round trip through the dropdown, and (b580 only) a
// percent-unit apply round trip. Runs against MockBackend like the default.

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} fsId the RID_MOCK_FEATURESET value driving this run
 */
export async function runFeaturesetVerify(win, fsId) {
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
  const noOc = fsId === 'pro-b50' || fsId === 'arc-igpu';

  // --- boot: shell + dropdown -----------------------------------------------
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 6`))) {
    fail('sidebar did not render (6 nav links expected)');
  }
  // M3-A (shared shell): the brand is text + blue bar (no logo image), and
  // the IGS indicator is gone everywhere.
  if (await js(`!!document.querySelector('.sidebar-brand img.sidebar-logo')`)) fail('M3-A: sidebar logo image still rendered');
  if (await js(`document.body.textContent.includes('Service Status')`)) fail('M3-A: "Service Status" still rendered');
  if (await js(`document.body.textContent.includes('IGS')`)) fail('M3-A: IGS still surfaced as a status item');
  if (!(await waitFor(win, `!!document.querySelector('.badge-mock')`))) fail('mock badge missing');
  if (!(await waitFor(win, `!!document.querySelector('.featureset-select')`))) fail('featureset dropdown missing in mock mode');
  const options = await js(`Array.from(document.querySelectorAll('.featureset-select option')).map((o) => o.value)`);
  if (options.length !== 4) fail(`dropdown lists ${options.length} featuresets (expected 4)`);
  const selected = await js(`document.querySelector('.featureset-select').value`);
  if (selected !== fsId) fail(`current selection is '${selected}' (expected '${fsId}')`);
  step('boot', `shell + dropdown rendered: ${options.join(', ')} (current '${selected}')`);

  // --- boot: wait for caps + state in the store -----------------------------
  // The renderer boot (health -> devices -> probes -> caps -> telemetry)
  // finishes AFTER the shell renders; the dashboard full-renders when caps
  // arrive (its render signature includes caps) — the device-card 'Compute'
  // row is the signal. Navigating to a caps-driven page before this leaves
  // it stuck on 'Loading device capabilities…' (no page onUpdate).
  await js(`location.hash = '#/dashboard'`);
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.card-grid .kv')).some((k) => (k.getAttribute('data-label') ?? '') === 'Compute')`, 10000))) {
    fail(`boot did not deliver caps: page='${await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`)}'`);
  }
  step('boot-caps', `boot delivered caps (device card 'Compute' row)`);

  // --- overclocking surface per featureset ----------------------------------
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);

  if (noOc) {
    const cards = await waitFor(win, `document.querySelectorAll('.oc-card').length === 0`, 8000)
      ? 0
      : await js(`document.querySelectorAll('.oc-card').length`);
    if (cards !== 0) fail(`expected 0 OC cards on '${fsId}', got ${cards}`);
    if (!(await waitFor(win, `document.body.textContent.includes('No overclocking controls are available')`))) {
      fail(`no-OC note missing for '${fsId}'`);
    }
    const floatingHidden = await js(`(() => { const b = document.querySelector('.floating-apply'); return !b || b.hidden === true; })()`);
    if (!floatingHidden) fail('floating Apply visible on a no-OC device');
    step('oc-none', `'${fsId}': 0 OC cards, no-OC note, no floating Apply`);
  } else {
    if (!(await waitFor(win, `document.querySelectorAll('.oc-card').length === 4`, 8000))) {
      fail(`expected 4 OC cards on '${fsId}', got ${await js(`document.querySelectorAll('.oc-card').length`)}; page='${await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 300)`)}'`);
    }
    const plRange = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-meta .oc-range')?.textContent ?? ''`);
    const plValue = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? ''`);
    if (fsId === 'b580') {
      if (!plRange.includes('%')) fail(`b580 PL range does not show % units: '${plRange}'`);
      if (plValue.trim() !== '100 %') fail(`b580 PL readout is '${plValue}' (expected '100 %')`);
      const plMax = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] input[type="range"]')?.getAttribute('max')`);
      if (plMax !== '150') fail(`b580 PL slider max is '${plMax}' (expected 150)`);
      const presetTexts = await js(`Array.from(document.querySelectorAll('.oc-card[data-control="powerLimitW"] .oc-presets .chip')).map((c) => c.textContent).join(',')`);
      if (!/Stock/.test(presetTexts) || !/Max/.test(presetTexts)) fail(`b580 percent presets missing: '${presetTexts}'`);
      const adv = await js(`document.querySelector('.advanced-card')?.textContent ?? ''`);
      if (!adv.includes('Unsupported on this GPU')) fail(`b580 advanced: an expert control is not marked unsupported: '${adv}'`);
      if (!adv.includes('Supported — editing arrives in M4')) fail(`b580 advanced: vfCurve not marked supported: '${adv}'`);
      step('oc-b580', `b580: 4 cards, PL '${plRange}', readout '${plValue}', presets '${presetTexts}', gpuLock unsupported / vfCurve supported`);
    } else {
      step('oc-generic', `'${fsId}': ${cards} OC cards render`);
    }
  }

  // --- fan surface per featureset -------------------------------------------
  await js(`location.hash = '#/fan'`);
  await sleep(250);
  const fanReadonly = process.env.RID_MOCK_FAN_READONLY === '1';
  if (fsId === 'arc-igpu') {
    if (!(await waitFor(win, `document.body.textContent.includes('does not expose a fan')`))) {
      fail('iGPU fan page does not show the no-fan note');
    }
    if (await js(`!!document.querySelector('.fan-dot')`)) fail('iGPU fan page rendered editor dots');
    step('fan-igpu', 'arc-igpu: no-fan note, no editor');
  } else if (fanReadonly) {
    if (!(await waitFor(win, `!!document.querySelector('.fan-card')`))) fail('fan card did not render');
    const note = await js(`document.querySelector('.fan-card .card-note')?.textContent ?? ''`);
    if (!/read-only/i.test(note)) fail(`read-only note missing: '${note}'`);
    step('fan-readonly', `'${fsId}' + RID_MOCK_FAN_READONLY: read-only fan rendered`);
  } else {
    if (!(await waitFor(win, `!!document.querySelector('.fan-dot')`))) fail('fan editor dots did not render');
    step('fan-editor', `'${fsId}': fan editor rendered`);
  }

  // --- monitoring readouts render per featureset ----------------------------
  await js(`location.hash = '#/monitoring'`);
  await sleep(250);
  if (!(await waitFor(win, `document.querySelectorAll('.seg-card').length === 5`))) {
    fail(`expected 5 monitoring segments, got ${await js(`document.querySelectorAll('.seg-card').length`)}`);
  }
  const fanTile = await js(`Array.from(document.querySelectorAll('.mon-readout .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Fan')?.querySelector('.stat-value')?.textContent ?? ''`);
  if (fsId === 'arc-igpu') {
    if (fanTile !== '—') fail(`iGPU fan tile should read '—' (no fan), got '${fanTile}'`);
    step('mon-igpu', `arc-igpu: monitoring renders, fan tile '${fanTile}'`);
  } else {
    step('mon', `'${fsId}': monitoring readouts render (fan tile '${fanTile}')`);
  }

  // --- live swap round trip through the dropdown ----------------------------
  const swapTo = (id) => js(`(() => {
    const s = document.querySelector('.featureset-select');
    s.value = '${id}';
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  await swapTo('a770');
  if (!(await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '210 W'`))) {
    fail('swap to a770 did not re-render the OC page with W units');
  }
  const a770Caps = await js(`window.arcPower.getCapabilities(0)`);
  if (a770Caps.ranges.powerLimitW.units !== 'W' || a770Caps.ranges.powerLimitW.max !== 315) {
    fail(`swap to a770: caps wrong: ${JSON.stringify(a770Caps.ranges.powerLimitW)}`);
  }
  step('swap-a770', `swap -> a770: OC re-rendered '210 W', PL range max ${a770Caps.ranges.powerLimitW.max} W`);
  // M2D: the swap payload carries the featureset driver date — the a770 card
  // must show its own registry date even when the boot featureset had none.
  await js(`location.hash = '#/dashboard'`);
  await sleep(250);
  const a770Row = await js(`document.querySelector('.card-grid .kv[data-label="Driver version"]')?.textContent ?? ''`);
  if (!a770Row.includes('Jul 05, 2026')) fail(`swap to a770: driver date missing on the card: '${a770Row}'`);
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  await swapTo(fsId);
  const backOk = fsId === 'b580'
    ? await waitFor(win, `(document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value')?.textContent ?? '').trim() === '100 %'`)
    : await waitFor(win, `document.querySelectorAll('.oc-card').length === 0`);
  if (!backOk) fail(`swap back to '${fsId}' did not restore its surface`);
  if (fsId === 'b580') {
    // M2D: the unverified b580 swap must clear the a770 date, not pair it
    // with the b580 driver version.
    await js(`location.hash = '#/dashboard'`);
    await sleep(250);
    const backRow = await js(`document.querySelector('.card-grid .kv[data-label="Driver version"]')?.textContent ?? ''`);
    if (backRow.includes('Jul')) fail(`swap back to b580: stale driver date on the card: '${backRow}'`);
    await js(`location.hash = '#/overclocking'`);
    await sleep(250);
  }
  step('swap-back', `swap back -> '${fsId}': original surface restored`);

  // --- b580 percent-unit apply round trip -----------------------------------
  if (fsId === 'b580') {
    const setSlider = (value) => js(`(() => {
      const card = document.querySelector('.oc-card[data-control="powerLimitW"]');
      const input = card.querySelector('input[type="range"]');
      input.value = '${value}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return card.querySelector('.oc-value').textContent;
    })()`);
    const clickApply = () => js(`(() => { const b = document.querySelector('.floating-apply'); if (b && !b.hidden) { b.click(); return true; } return false; })()`);
    if ((await js(`window.arcPower.waiverGet(0)`)).accepted !== true) {
      await setSlider(120);
      await clearToasts();
      if (!(await clickApply())) fail('floating Apply did not appear for the b580 percent apply');
      if (!(await waitFor(win, `!!document.querySelector('.modal')`))) fail('waiver dialog did not appear for the first b580 apply');
      await js(`document.querySelector('.modal button.btn-danger')?.click()`);
    } else {
      await setSlider(120);
      if (!(await clickApply())) fail('floating Apply did not appear for the b580 percent apply');
    }
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) {
      fail('b580 percent apply success toast missing');
    }
    // NIT 3 (M2D): a per-control routing failure (tempLimitC 100 % routed to
    // the 2023 runtime) would toast an error even when the PL toast is
    // green — assert the whole apply succeeded: no error toast + ALL four
    // scalar controls read back their applied values.
    if (await js(`!!document.querySelector('.toast-error')`)) fail('b580 percent apply showed a per-control error toast');
    const applied = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(applied.powerLimitW - 120) > 1e-6) fail(`b580 percent apply did not stick: ${applied.powerLimitW}`);
    if (applied.tempLimitC !== 100 || applied.gpuVoltOffsetV !== 0 || applied.gpuFreqOffsetMhz !== 0) {
      fail(`b580 percent apply: driverstore controls not all applied: ${JSON.stringify(applied)}`);
    }
    await clearToasts();
    await setSlider(100);
    if (!(await clickApply())) fail('floating Apply did not reappear for the b580 restore');
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('b580 percent restore did not apply');
    if (await js(`!!document.querySelector('.toast-error')`)) fail('b580 percent restore showed a per-control error toast');
    step('b580-apply', `b580 percent apply round trip: 120 % -> read-back ${applied.powerLimitW} %, restored to 100 % (all 4 controls driverstore, no error toast)`);
  }

  console.log(`\nUI VERIFY OK (featureset: ${fsId})\n` + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}
