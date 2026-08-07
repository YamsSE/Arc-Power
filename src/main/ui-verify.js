// Arc Power — dev-only UI verification (`electron . --ui-verify`).
//
// Drives the REAL window (renderer + preload + IPC + MockBackend) through
// the M2a/M2b-B/M2C-B/M2D/M3-A product flows and asserts the outcomes:
//   1. shell renders (sidebar + header); M3-A: the sidebar brand is the
//      "Arc Power" text with the small blue accent bar BELOW it (the user's
//      preferred variant — no logo image);
//   1b. M2C-B B3: the header line below the GPU name is "Arc Power Ver.
//       0.9.10 Alpha" (app:version IPC + the display Alpha suffix — the IPC
//       keeps the bare semver) — the driver version + date live in the
//       dashboard device card 'Driver version' kv ("32.0.101.8861 - Jul 05,
//       2026" from the mock driver-info fixture); no PCI ID anywhere;
//       M2C-B B2: NO capsSummary chips footer on the device card; M2C-B B8:
//       a 'Memory clock' kv row next to 'Graphics clock'; memory-clock
//       readout next to core clock; M3-A: the header has NO status dot and
//       NO "Service Status" label (the IGS indicator is gone);
//   1c. M3-A + M3-C-I: the dashboard shows the general GPU HEALTH card (four
//       rows: Driver installed / Device detected / OC Status (M4-B rename of
//       "OC working") / Arc Power working — the "Clocks normal" row is
//       REMOVED) — the merged Service Status card is GONE, as is everything
//       IGS (dot, half-state note, toggle button). The driver row detail is
//       version + date like the device card; the app row healthy detail is
//       "App & Service Running".
//   2. overclocking cards render from capability ranges; M2b-B: the card
//      label is "Core clock" (M4-B user: named Core clock in BOTH Offset and
//      Clock modes), the floating Apply is hidden when clean and appears
//      when dirty;
//   3. first Apply shows the warranty-waiver dialog; Accept persists the
//      waiver; the apply succeeds and the state read-back refreshes; the
//      per-control toast count is exactly 1 (the other three controls are
//      no-ops and stay silent — M2b-B suppression);
//   4. a second apply does NOT re-show the dialog;
//   5. per-card reset-to-default + apply round-trips the default;
//   5b. M2C-B F3 instant apply: ONE attempt, no retry note, no progress
//       label — an io-failed apply fails instantly with the composed
//       refusal toast (plain "The GPU driver refused the change" + the
//       error code); M3-C-G: the per-control chips are hidden until the
//       first apply, then green "Applied" (value == last applied) or warn
//       "Unapplied" — the applied reference clears them even while the
//       driver read-back lags (B5); M3-C-F: the "Driver:" readout refreshes
//       from the fresh state after an apply without navigating away;
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
//  12. M3-C-D/E extended variant (RID_MOCK_EXTENDED_RANGES=1, mock default
//      OC mode = advanced): the power slider max is 315 W and the temp
//      slider max 115 C; setting PL 300 and applying SKIPS the per-apply
//      confirm (double-dialog decision — the mode-enable confirm already
//      warned) and the read-back sticks at 300 W; restored to 210 W after.
//  12b. M3-C-E stock variant (RID_MOCK_STOCK_MODE=1): sliders pinned to the
//      standard limits (252 W / 90 C), no extendedRanges flag, and a direct
//      300 W apply REFUSES with the mode message — device untouched, no
//      dead-end confirm dialog.
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
//  16. M3-A/M3-B Tweaks page: the registry-hacks catalog renders with live
//      (mock) states — mpo=Off, hags=Active, game-dvr=Default,
//      fullscreen-optimizations=Active; applyable entries get working
//      Enable/Disable/Revert buttons (mock apply — no elevation), fullscreen
//      stays read-only; one apply round trip refreshes the card state.
//  17. M3-B tweaks-apply variant (RID_MOCK_TWEAKS_APPLY=1): the full apply
//      flow — every entry through enable/disable/revert with per-step
//      toasts + state refresh; with RID_MOCK_REGAPPLY_FAIL='<id>:<action>'
//      the honest partial-failure path, with RID_MOCK_REGAPPLY_CANCEL=1 the
//      honest UAC-decline path.
//  18. M4-A/M4-B waiver-prompt variants: every mock session boots with a
//      DETERMINISTIC waiver state (session-seeded in main.js, pre-window —
//      the persisted variant never races the renderer's first caps query).
//      M4-B (user: "please prompt it when the Program opens"): the boot
//      waiver prompt appears in EVERY variant — CANCELLED here in the
//      unaccepted sessions (default / stock / extended / worker / featureset
//      / tweaks variants), ACCEPTED under RID_MOCK_WAIVER_BOOT_ACCEPT=1
//      (row green, no dialog anywhere after), and shown in its ACCEPTED
//      state under RID_MOCK_WAIVER_PERSISTED=1 — title + 'Status: Accepted'
//      line + single OK, clicked here (persisted acceptance at boot: the
//      boot prompt appears as a reminder, never a re-accept). The waiver
//      STATUS lives ONLY in the dashboard GPU Health card row ("OC waiver:
//      Accepted / Not Accepted", green/red — user correction, mid-M4-A): the
//      OC and Fan pages render NO waiver status (the apply-time dialog gate
//      only); the unaccepted row is clickable (opens the waiver dialog;
//      Cancel leaves it red and the next apply still gates), the accepted
//      row has no click action, and the row flips green IN PLACE on the
//      caps-change re-render.
//  19. M4-A fan-gate variant (RID_MOCK_FAN_GATE=1): the unaccepted-waiver fan
//      apply regression — the waiver dialog appears on the first fan apply
//      (Cancel -> aborted with the honest toast, device untouched; Accept ->
//      the apply lands and the dashboard waiver row flips green), plus the
//      G2 self-heal: after a waiver-not-set failure the store flag flips
//      back to unaccepted (row red again) and the NEXT apply re-shows the
//      dialog (the "fan applies fail without a prompt" bug).
//  20. M4-B: (a) the dashboard health row is renamed "OC Status" (was "OC
//      working"); (b) the freq offset ranges mirror into the negative half
//      (a770 -300..300) — the slider reaches the negative half, applies and
//      reads back -100 MHz; (c) the freq card's Offset/Clock toggle: Clock
//      mode slides over base+[min,max] (2100 + -300..300 = 1800..2400 MHz),
//      the readout + driver line show the ABSOLUTE clock, and an apply
//      stores the converted offset (2050 -> -50); (d) the gpuLock editor
//      card in the Advanced section (a770): "Editing available" expert row,
//      Apply/Reset round trip through the shared clamp, gated OFF on the
//      b580 swap; (e) the b580 variant pins the mirrored freq range
//      (-500..500) + volt % range (-100..100) with percent units intact.
//  21. M4-B (user): the Advanced OC Mode warning is a ONCE-only gate — the
//      disclaimer shows ONLY on the first Stock->Advanced toggle (Cancel
//      keeps stock; it re-asks until Enable), the acceptance is PERSISTED
//      (advanced-mode-accepted-set), and neither a later toggle in the same
//      session nor a later BOOT (RID_MOCK_ADVANCED_ACCEPTED=1 seeds the
//      accepted store) ever shows it again. Stock variant: full once-flow.
//      Knob variant: boot-persisted acceptance -> toggle shows no dialog.
// This script is dev tooling only — it always uses MockBackend (it never
// touches hardware) and exists to catch DOM-wiring regressions that unit
// tests cannot. Profile rows created here are cleaned up before exit.

import { app } from 'electron';

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

// M4-A/M4-B/M4-D: the shared waiver boot-step — MUST run in EVERY ui-verify
// variant BEFORE its own assertions (F4: the extended/stock/featureset
// variants assert modal absence around applies; the boot prompt would
// otherwise be the modal being clicked or asserted there). Every mock
// session boots with a deterministic waiver state (session-seeded in
// main.js BEFORE the window exists — the persisted variant never races the
// renderer's first caps query, F2). M4-D (user, PERMANENT acceptance —
// "skipped IF permanently accepted after accepting once"):
//   - RID_MOCK_WAIVER_PERSISTED=1 -> the store is ACCEPTED at boot: the boot
//     prompt is SKIPPED ENTIRELY (the accepted-state reminder dialog is
//     REMOVED — the dashboard health row remains the status display); this
//     step asserts NO modal ever appears after the boot sequence lands;
//   - RID_MOCK_WAIVER_PERSISTED=1 + RID_MOCK_WAIVER_LOST=1 (M4-B user fix,
//     M4-D update) -> the store STILL says accepted and the DRIVER lost the
//     waiver: the boot probe (probeWaiverState) now RESTORES the driver
//     waiver instead of clearing the store (M4-D PERMANENT acceptance — the
//     consent stands, the store is never flipped to false), so the boot
//     prompt is STILL skipped (same as the plain persisted variant) and
//     waiver-get reads accepted (the restore is pinned);
//   - RID_MOCK_WAIVER_BOOT_ACCEPT=1 -> the session is unaccepted at boot:
//     the prompt appears exactly once and this step ACCEPTS it (health row
//     green, no dialog anywhere after);
//   - default -> the prompt appears exactly once and this step CANCELS it
//     (row red, the first apply re-shows the dialog — the classic flow).
// Returns true when the session booted with the waiver accepted.
async function bootWaiverStep(win, js, waitFor) {
  const persisted = process.env.RID_MOCK_WAIVER_PERSISTED === '1';
  const waiverLost = process.env.RID_MOCK_WAIVER_LOST === '1';
  const bootAccept = process.env.RID_MOCK_WAIVER_BOOT_ACCEPT === '1';
  // M4-B step-4 F1/F5a: the boot dialog's .modal-device line must carry the
  // VRAM-suffixed name (mock caps.deviceName = formatDeviceName(...)) — the
  // regression pin for the caps-vs-device divergence. Featureset-aware:
  // a770 -> "16 GB" (the mock models the 16 GB config; the REAL card on
  // this machine is the 8 GB config — its driver qwMemorySize ~7.91 GiB
  // rounds to "8 GB" via formatDeviceName; M4-D user correction),
  // b580/pro-b50 -> "12 GB", arc-igpu -> plain (no VRAM).
  const fsId = process.env.RID_MOCK_FEATURESET;
  const expectedSuffix = fsId === 'b580' || fsId === 'pro-b50' ? ' 12 GB'
    : fsId === 'arc-igpu' ? null
    : ' 16 GB';
  const pinDeviceLine = async () => {
    const deviceText = await js(`document.querySelector('.modal .modal-device')?.textContent ?? ''`);
    if (expectedSuffix === null) {
      if (deviceText.includes(' GB')) {
        throw new UiVerifyFailure(`the boot waiver prompt names '${deviceText}' (arc-igpu has no VRAM — expected the plain name, no suffix)`);
      }
    } else if (!deviceText.includes(expectedSuffix)) {
      throw new UiVerifyFailure(`the boot waiver prompt names '${deviceText}' (expected the VRAM-suffixed name containing '${expectedSuffix}')`);
    }
    return deviceText;
  };
  if (persisted) {
    // M4-D (PERMANENT acceptance): the boot prompt must NOT appear at all.
    // The accepted store never asks again — the accepted-state reminder
    // dialog is REMOVED. Wait for the boot sequence to land (the dashboard
    // GPU Health card renders only after caps arrive — the point where a
    // (buggy) boot prompt would have shown), then assert no modal. The
    // WAIVER_LOST overlay changes nothing: the boot probe RESTORED the
    // driver waiver for the accepted store (the consent stands), so the
    // session boots silent and waiver-get reads accepted.
    if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`, 15000))) {
      throw new UiVerifyFailure(`M4-D: the persisted-accepted session did not land the dashboard health card: page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
    }
    await sleep(600);
    if (await js(`!!document.querySelector('.modal')`)) {
      throw new UiVerifyFailure(`M4-D: the boot waiver prompt appeared in a PERSISTED-ACCEPTED session (${persisted ? 'RID_MOCK_WAIVER_PERSISTED=1' : ''}${waiverLost ? ' + RID_MOCK_WAIVER_LOST=1' : ''}) — a persisted acceptance skips the boot prompt entirely; page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
    }
    if (waiverLost) {
      // M4-D pin: the boot probe RESTORED the driver waiver — the backend
      // flag is accepted again (the store was never flipped to false).
      const flag = await js(`window.arcPower.waiverGet(0)`);
      if (flag.accepted !== true) {
        throw new UiVerifyFailure('RID_MOCK_WAIVER_LOST=1 (M4-D): the boot probe did not RESTORE the driver waiver for the accepted store (waiver-get is unaccepted)');
      }
    }
    return true;
  }
  if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Warranty waiver'`, 10000))) {
    throw new UiVerifyFailure(`the boot waiver prompt did not appear (unaccepted session): page='${(await js(`(document.getElementById('page')?.textContent ?? '').slice(0, 200)`))}'`);
  }
  const deviceLine = await pinDeviceLine();
  await js(`document.querySelector('.modal button.${bootAccept ? 'btn-danger' : 'btn-ghost'}')?.click()`);
  if (!(await waitFor(win, `!document.querySelector('.modal')`, 5000))) {
    throw new UiVerifyFailure('the boot waiver prompt did not close');
  }
  // Exactly once per boot: nothing else may pop a modal spontaneously after
  // the prompt is handled (a stray dialog would mean a re-prompt bug).
  await sleep(500);
  if (await js(`!!document.querySelector('.modal')`)) {
    throw new UiVerifyFailure('a second modal appeared after the boot prompt was handled (the boot prompt must appear exactly once)');
  }
  return bootAccept;
}

export class UiVerifyFailure extends Error {}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('./backend/mock-backend.js').MockBackend} backend
 * @param {import('./store/profile-store.js').ProfileStore} store the session
 *   store (mock sessions use the ISOLATED data dir — the persisted-state
 *   checks must read THIS store, never a default-dir store that would read
 *   the real %APPDATA%\ArcPower settings.json)
 * @param {() => number} [getTrayRebuilds] dev probe: tray-rebuild invocations
 * @param {() => number} [getFpsPolls] dev probe: fps-poll invocations (M2b
 *   review F4 — asserts the Monitoring poll stops on navigation away)
 * @param {() => { minimize: number, maximizeToggle: number, close: number }} [getWindowOpCounts]
 *   M4-D dev probe: the injected window-op counters (ui-verify mode counts
 *   instead of performing the real BrowserWindow ops) — run 2 pins the
 *   integrated title-bar buttons through this.
 */
export async function runUiVerify(win, backend, store, getTrayRebuilds = () => 0, getFpsPolls = () => 0, getWindowOpCounts = () => ({ minimize: 0, maximizeToggle: 0, close: 0 })) {
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
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected)');
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

  // M4-D (user): the integrated title bar (frameless window).
  // The title bar spans the top of the window: the left drag zone, the
  // brand CENTERED (logo + 'Arc Power' with the blue gradient 'Power'),
  // the three window controls in the right cluster. The buttons are wired
  // to the injected window ops (getWindowOpCounts — ui-verify counts
  // instead of performing real minimize/close mid-verify); the max
  // button's icon follows the pushed window:maximized-changed state.
  if (!(await waitFor(win, `!!document.querySelector('#titlebar .titlebar-logo')`))) {
    fail('M4-D: the integrated title bar logo did not render');
  }
  const logo = await js(`document.querySelector('#titlebar .titlebar-logo')?.getAttribute('src') ?? ''`);
  if (!logo.includes('icon.png')) fail(`M4-D: the title bar logo src is '${logo}' (expected the assets/icon.png brand mark)`);
  const brandName = await js(`document.querySelector('#titlebar .titlebar-brand-name')?.textContent ?? ''`);
  if (brandName.trim() !== 'Arc Power') fail(`M4-D: the title bar brand name is '${brandName}' (expected 'Arc Power')`);
  // The brand must be CENTERED in the title bar (user: "move the Arc Power
  // logo & writing to the middle of the top").
  const brandCentered = await js(`(() => {
    const tb = document.querySelector('#titlebar');
    const brand = document.querySelector('#titlebar .titlebar-brand');
    if (!tb || !brand) return false;
    const tbRect = tb.getBoundingClientRect();
    const bRect = brand.getBoundingClientRect();
    const tbCx = (tbRect.left + tbRect.right) / 2;
    const bCx = (bRect.left + bRect.right) / 2;
    return Math.abs(tbCx - bCx) <= 8;
  })()`);
  if (brandCentered !== true) fail('M4-D: the title bar brand is not centered (expected the logo+name in the middle of the top)');
  // The website gradient treatment: 'Power' is background-clip:text over the
  // blue linear-gradient + glow — the name renders as the brand mark.
  const powerGradient = await js(`(() => {
    const el = document.querySelector('#titlebar .titlebar-brand-power');
    if (!el) return 'no-el';
    const cs = getComputedStyle(el);
    return cs.backgroundImage.includes('linear-gradient')
      && (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text')
      && el.textContent === 'Power';
  })()`);
  if (powerGradient !== true) fail(`M4-D: the title bar 'Power' span is not gradient-clipped: ${powerGradient}`);
  for (const op of ['minimize', 'maximize-toggle', 'close']) {
    if (!(await js(`!!document.querySelector('#titlebar .window-btn[data-op="${op}"]')`))) {
      fail(`M4-D: the title bar ${op} button is missing`);
    }
  }
  // The drag regions must be draggable and the button cluster must NOT be
  // (a drag region over the buttons would eat their clicks). The brand is
  // draggable too (the user can drag the window by the logo/name).
  const appRegion = await js(`(() => {
    const drag = document.querySelector('#titlebar .titlebar-drag');
    const brand = document.querySelector('#titlebar .titlebar-brand');
    const cluster = document.querySelector('#titlebar .titlebar-cluster');
    const of = (n) => {
      if (!n) return '';
      const cs = getComputedStyle(n);
      const v = cs.getPropertyValue('-webkit-app-region').trim()
        || cs.getPropertyValue('app-region').trim();
      return v;
    };
    return JSON.stringify({ drag: of(drag), brand: of(brand), cluster: of(cluster) });
  })()`);
  const region = JSON.parse(appRegion);
  if (region.drag !== 'drag' || region.brand !== 'drag' || region.cluster !== 'no-drag') {
    fail(`M4-D: the title bar drag regions are wrong: ${appRegion} (expected drag on the left zone + brand, no-drag cluster)`);
  }
  // The max button icon follows the pushed window:maximized-changed state
  // (single square = maximize, overlapping squares = restore).
  const maxIconState = () => js(`(() => {
    const b = document.querySelector('#titlebar .window-btn[data-op="maximize-toggle"]');
    const restore = b?.querySelector('.icon-restore');
    const maximize = b?.querySelector('.icon-maximize');
    return JSON.stringify({ restoreHidden: restore?.hidden, maxHidden: maximize?.hidden });
  })()`);
  win.webContents.send('window:maximized-changed', { maximized: true });
  await sleep(300);
  let iconState = JSON.parse(await maxIconState());
  if (iconState.restoreHidden !== false || iconState.maxHidden !== true) {
    fail(`M4-D: the max button did not flip to the RESTORE icon on window:maximized-changed {maximized:true}: ${JSON.stringify(iconState)}`);
  }
  win.webContents.send('window:maximized-changed', { maximized: false });
  await sleep(300);
  iconState = JSON.parse(await maxIconState());
  if (iconState.restoreHidden !== true || iconState.maxHidden !== false) {
    fail(`M4-D: the max button did not flip back to the MAXIMIZE icon: ${JSON.stringify(iconState)}`);
  }
  // Clicking each button performs the injected window op (the counters
  // tick — the real ops would minimize/close the verify window).
  const tbOpsBefore = { ...getWindowOpCounts() };
  await js(`document.querySelector('#titlebar .window-btn[data-op="minimize"]').click()`);
  await js(`document.querySelector('#titlebar .window-btn[data-op="maximize-toggle"]').click()`);
  await js(`document.querySelector('#titlebar .window-btn[data-op="close"]').click()`);
  await sleep(300);
  const tbOpsAfter = { ...getWindowOpCounts() };
  if (tbOpsAfter.minimize !== tbOpsBefore.minimize + 1
    || tbOpsAfter.maximizeToggle !== tbOpsBefore.maximizeToggle + 1
    || tbOpsAfter.close !== tbOpsBefore.close + 1) {
    fail(`M4-D: the title-bar buttons did not tick the injected window ops: ${JSON.stringify({ before: tbOpsBefore, after: tbOpsAfter })}`);
  }
  step('titlebar', `integrated title bar: logo (${logo}), brand '${brandName.trim()}' (blue gradient 'Power'), ${await js(`document.querySelectorAll('#titlebar .window-btn').length`)} window buttons; max icon follows window:maximized-changed; buttons ticked the window-op counters (${JSON.stringify(tbOpsAfter)})`);
  // M4-D (user): the app icon ALSO sits at the title bar's top-LEFT corner,
  // and the max/restore icons are exactly one glyph each (the restore glyph
  // is TWO overlapping squares drawn as one icon — a filled front square
  // over the back outline; the pin asserts the fill so it no longer reads
  // as two separate icons).
  const cornerIcon = await js(`document.querySelector('#titlebar .titlebar-corner-icon')?.getAttribute('src') ?? ''`);
  if (!cornerIcon.includes('icon.png')) fail(`M4-D: the title bar corner icon is '${cornerIcon}' (expected the app icon at the top-left)`);
  const restoreFill = await js(`(() => {
    const r = document.querySelector('#titlebar .icon-restore rect');
    return r ? getComputedStyle(r).fill : '';
  })()`);
  const tbRect = await js(`(() => { const b = document.querySelector('#titlebar .icon-restore'); const r = b.getBoundingClientRect(); return JSON.stringify({ w: r.width, h: r.height }); })()`);
  step('titlebar-extras', `top-left corner icon OK; restore glyph is ONE icon (front square filled: '${restoreFill}', ${JSON.parse(tbRect).w}x${JSON.parse(tbRect).h}px)`);

  // M4-D (user): the sidebar — per-tab icons left of the names, the brand
  // "Power" illuminated like the title bar, the brand BOLD.
  const sidebarIcons = await js(`Array.from(document.querySelectorAll('.sidebar-link')).map((l) => ({ label: l.querySelector('.sidebar-link-label')?.textContent, hasIcon: !!l.querySelector('.sidebar-icon') }))`);
  if (!sidebarIcons.every((i) => i.hasIcon === true && i.label)) fail(`M4-D: every sidebar link must carry an icon + label: ${JSON.stringify(sidebarIcons)}`);
  if (sidebarIcons.length !== 7) fail(`M4-D: expected 7 sidebar links with icons, got ${sidebarIcons.length}`);
  const sidebarPower = await js(`(() => {
    const el = document.querySelector('.sidebar-brand-power');
    if (!el) return 'no-el';
    const cs = getComputedStyle(el);
    return cs.backgroundImage.includes('linear-gradient')
      && (cs.backgroundClip === 'text' || cs.webkitBackgroundClip === 'text');
  })()`);
  if (sidebarPower !== true) fail(`M4-D: the sidebar 'Power' is not gradient-illuminated: ${sidebarPower}`);
  const sidebarWeight = await js(`getComputedStyle(document.querySelector('.sidebar-brand')).fontWeight`);
  if (sidebarWeight !== '800') fail(`M4-D: the sidebar brand is not BOLD (weight '${sidebarWeight}', expected 800)`);
  step('sidebar-icons', `sidebar: ${sidebarIcons.length} links each with a fitting icon; 'Power' illuminated (gradient), brand weight ${sidebarWeight}`);

  // M4-A/M4-B: the shared waiver boot-step — the boot prompt appears in
  // EVERY session: cancelled in the unaccepted sessions (Cancel here;
  // Accept under RID_MOCK_WAIVER_BOOT_ACCEPT=1), or shown in its ACCEPTED
  // state under RID_MOCK_WAIVER_PERSISTED=1 (reminder with a single OK).
  const bootAcceptedAtBoot = await bootWaiverStep(win, js, waitFor);
  step('waiver-boot', process.env.RID_MOCK_WAIVER_PERSISTED === '1'
    ? (process.env.RID_MOCK_WAIVER_LOST === '1'
      ? 'persisted store said accepted but the DRIVER lost the waiver: the boot probe RESTORED the driver waiver — boot prompt SKIPPED (permanent acceptance), waiver-get accepted'
      : 'persisted acceptance at boot: boot prompt SKIPPED entirely (permanent acceptance — the accepted-state reminder dialog is removed)')
    : `boot waiver prompt handled: ${bootAcceptedAtBoot ? 'Accepted (no dialog anywhere after)' : 'Cancelled (first apply re-shows the dialog)'}`);

  // --- waiver gate seed state (used by every waiver-flow section below) ----
  // M3-C review F4: the persisted state read must use the SESSION store — a
  // default-dir ProfileStore would read the REAL settings.json while the
  // mock session reads/writes its isolated dir (the check would always see
  // a mismatch). bootAccepted is the device-side flag (waiver-get) — the
  // source the renderer's health row reads.
  const persistedWaiver = (await store.loadSettings()).waiverAccepted === true;
  const bootAccepted = (await js(`window.arcPower.waiverGet(0)`)).accepted === true;
  if (persistedWaiver && !bootAccepted) {
    fail('boot did not seed the persisted waiver acceptance (settings.json says accepted)');
  }
  step('waiver-seed', `boot waiver state: store=${persistedWaiver ? 'accepted' : 'not accepted'}, backend=${bootAccepted ? 'accepted' : 'not accepted'}`);

  // --- 1b. M2C-B B3 header version line + B2/B8 dashboard device card ------
  // B3: the line below the GPU name is the APP version (app:version IPC) —
  // the driver line moved to the dashboard device card.
  if (!(await waitFor(win, `(document.querySelector('.gpu-meta')?.textContent ?? '').trim() === 'Arc Power Ver. 0.9.12 Alpha'`))) {
    fail(`header version line is '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}' (expected 'Arc Power Ver. 0.9.12 Alpha')`);
  }
  // B6: the page favicon points at the generated blue-AP asset.
  const favicon = await js(`document.querySelector('link[rel="icon"]')?.getAttribute('href') ?? ''`);
  if (!favicon.includes('favicon.png')) fail(`favicon link is '${favicon}'`);
  // M4-D (user): the GPU card gained the PCIe ROW ('PCIe 4.0 x16') — the
  // pin must catch the old PCI-ID text ('PCI\VEN...'), not the word 'PCI'.
  if (await js(`document.body.textContent.includes('PCI\\\\')`)) fail('PCI ID is still shown somewhere in the UI');
  // M3-A: the header status indicator is REMOVED — no dot, no 'Service
  // Status' label anywhere (IGS is no longer a status item).
  if (await js(`!!document.querySelector('.gpu-header .status-dot')`)) fail('M3-A: the header still renders a status dot');
  if (await js(`document.body.textContent.includes('Service Status')`)) fail('M3-A: "Service Status" is still rendered somewhere');
  if (await js(`document.body.textContent.includes('IGS')`)) fail('M3-A: IGS is still surfaced as a status item');
  step('version-line', `header line '${await js(`document.querySelector('.gpu-meta')?.textContent ?? ''`)}'; no PCI text; no status dot / Service Status label`);

  // Device card: driver version kv (B3 move), compute line, the waiver
  // status is a HEALTH-CARD ROW (M4-A user correction — never on the device
  // card), NO capsSummary chips footer (B2).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.card-grid .kv')).some((k) => (k.getAttribute('data-label') ?? '') === 'Driver version' && (k.textContent ?? '').includes('32.0.101.8861 - Jul 05, 2026'))`))) {
    fail(`device card driver version kv is '${await js(`document.querySelector('.card-grid .kv[data-label="Driver version"]')?.textContent ?? ''`)}' (expected '32.0.101.8861 - Jul 05, 2026')`);
  }
  if (!(await waitFor(win, `document.body.textContent.includes('Xe Cores 32 - Shader Units 4096')`))) {
    fail('Xe cores / shader units line missing');
  }
  // The waiver status row lives in the HEALTH card (below), not on the
  // device card: no 'OC waiver' text in any device-card kv row.
  if (await js(`Array.from(document.querySelectorAll('.card-grid .kv')).some((k) => (k.textContent ?? '').includes('OC waiver'))`)) fail('M4-A: the device card still shows the waiver status (the row lives in the GPU Health card)');
  // B2: the chips footer ("Fan curve N points", power/volt/freq/temp notes)
  // is GONE from the device card — no chips inside the card grid EXCEPT the
  // M4-D ReBAR pill (a deliberate new chip, excluded here).
  const gridChips = await js(`document.querySelectorAll('.card-grid .chip:not(.rebar-pill)').length`);
  if (gridChips !== 0) fail(`B2: device card chips footer still renders ${gridChips} chips`);
  step('device-card', 'device card: Xe Cores 32 - Shader Units 4096, no PCI row, no chips footer (ReBAR pill is the only chip)');

  // M4-D (user): the core + memory clock BUNDLED row ("… MHz Core /
  // 2187 MHz Memory" — a770 featureset telemetry memClockMhz = 2187).
  if (!(await waitFor(win, `(() => {
    const row = Array.from(document.querySelectorAll('.card-grid .kv'))
      .find((k) => (k.getAttribute('data-label') ?? '') === 'Clocks');
    const text = row?.textContent ?? '';
    return (text ?? '').includes('MHz Core') && text.includes('2187') && text.includes('MHz Memory');
  })()`))) {
    fail(`combined clocks kv is '${await js(`document.querySelector('.card-grid .kv[data-label="Clocks"]')?.textContent ?? ''`)}' (expected '2400 MHz Core / 2187 MHz Memory')`);
  }
  step('clocks-kv', `device card combined clocks kv = ${await js(`document.querySelector('.card-grid .kv[data-label="Clocks"]')?.textContent ?? ''`)}`);

  // Memory clock readout next to core clock (a770 featureset: 2187 MHz).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('#dash-readout .stat-tile')).some((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock' && (t.querySelector('.stat-value')?.textContent ?? '') === '2187')`))) {
    fail('memory-clock readout missing or not 2187 MHz');
  }
  step('mem-clock', `memory clock readout = ${await js(`Array.from(document.querySelectorAll('#dash-readout .stat-tile')).find((t) => (t.querySelector('.stat-label')?.textContent ?? '') === 'Memory clock')?.querySelector('.stat-value')?.textContent ?? ''`)} MHz (compact tiles)`);

  // --- M4-D (user): the CPU & memory card (sysinfo:get fixture) ----------
  // The card sits BEFORE the GPU card in the card-grid and renders the mock
  // fixture: CPU name + the BUNDLED cores/threads/clock + the BUNDLED RAM
  // brand/size/speed rows (user formats). Every field degrades to '—' when
  // null (pinned by the pure/sysinfo.ts unit tests; the fixture here is
  // all-populated).
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.card-grid > .card')).some((c) => (c.querySelector('.card-title')?.textContent ?? '') === 'CPU & memory')`, 5000))) {
    fail('M4-D: the CPU & memory card did not render');
  }
  const gridCardTitles = await js(`Array.from(document.querySelectorAll('.card-grid > .card .card-title')).map((t) => t.textContent).join('|')`);
  if (!gridCardTitles.startsWith('CPU & memory')) {
    fail(`M4-D: the CPU & memory card is not FIRST in the card-grid (before the GPU card): '${gridCardTitles}'`);
  }
  const sysinfoRows = await js(`JSON.stringify(Object.fromEntries(Array.from(document.querySelectorAll('.sysinfo-card .kv')).map((k) => [k.getAttribute('data-label'), (k.textContent ?? '').trim()])))`);
  const sysRows = JSON.parse(sysinfoRows);
  if (sysRows['CPU'] !== 'Intel(R) Core(TM) i7-14700K') fail(`M4-D: CPU row is '${sysRows['CPU']}' (expected the sysinfo fixture name)`);
  if (sysRows['Cores / clock'] !== '20 Cores / 28 Threads / @ 5600 MHz') fail(`M4-D: Cores / clock row is '${sysRows['Cores / clock']}' (expected the bundled '20 Cores / 28 Threads / @ 5600 MHz')`);
  if (sysRows['Memory'] !== 'G.Skill 32.0 GB @ 6000 MHz') fail(`M4-D: Memory row is '${sysRows['Memory']}' (expected the bundled 'G.Skill 32.0 GB @ 6000 MHz')`);
  step('m4d-cpu-card', `CPU & memory card first in the card-grid: '${sysRows['CPU']}', '${sysRows['Cores / clock']}', '${sysRows['Memory']}'`);

  // --- M4-D (user): the GPU-card PCIe row + the ReBAR pill ---------------
  // The mock fixture models a healthy setup: PCIe 4.0 x16 currently used +
  // a multi-GiB BAR (ReBAR on -> green pill).
  const pcieRowText = await js(`document.querySelector('.card-grid .kv[data-label="PCIe"]')?.textContent?.trim() ?? ''`);
  if (pcieRowText !== 'PCIe 4.0 x16') fail(`M4-D: the PCIe row is '${pcieRowText}' (expected 'PCIe 4.0 x16' — the CURRENTLY-USED link)`);
  const rebarPill = await js(`(() => {
    const pill = document.querySelector('.card-grid .kv[data-label="Resizable BAR"] .rebar-pill');
    if (!pill) return 'no-pill';
    return pill.textContent + '|' + pill.className;
  })()`);
  if (!/ReBAR on\|.*status-ok/.test(rebarPill)) fail(`M4-D: the ReBAR pill is '${rebarPill}' (expected the green 'ReBAR on')`);
  step('m4d-gpu-rows', `GPU card: PCIe '${pcieRowText}', ReBAR pill '${rebarPill.split('|')[0]}' (green)`);

  // ONE general GPU HEALTH card (M3-A + M3-C-I + M4-A): FIVE rows, honest
  // per-row state, no Level Zero item, no IGCL detail line, NO clocks row
  // (the user's dashboard picture); driver row detail = version + date like
  // the device card; app row healthy detail = "App & Service Running"; the
  // M4-A waiver row is the ONLY persistent waiver display in the app.
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`))) fail('expected exactly one GPU Health card');
  const statusTitle = await js(`document.querySelector('.health-card .card-title')?.textContent ?? ''`);
  if (statusTitle.trim() !== 'GPU Health') fail(`health card title is '${statusTitle}'`);
  if (await js(`document.querySelectorAll('.health-card .health-row').length !== 5`)) {
    fail(`health card rows: got ${await js(`document.querySelectorAll('.health-card .health-row').length`)} (expected 5)`);
  }
  const rowIds = await js(`Array.from(document.querySelectorAll('.health-card .health-row')).map((r) => r.dataset.row).join(',')`);
  if (rowIds !== 'driver,device,oc,waiver,app') fail(`health card rows are '${rowIds}' (expected driver,device,oc,waiver,app — the clocks row is removed)`);
  const rowLabels = await js(`Array.from(document.querySelectorAll('.health-card .health-row-label')).map((l) => l.textContent).join('|')`);
  for (const want of ['Driver installed', 'Device detected', 'OC Status', 'OC waiver', 'Arc Power working']) {
    if (!rowLabels.includes(want)) fail(`health card missing row '${want}' (got '${rowLabels}')`);
  }
  if (rowLabels.includes('Clocks normal')) fail('M3-C-I: the "Clocks normal" health row is still rendered');
  // M3-C-I: the driver row detail is the driver version + date like the
  // device card; the app row detail is "App & Service Running" (app-only).
  const driverDetail = await js(`document.querySelector('.health-card .health-row[data-row="driver"] .health-row-detail')?.textContent ?? ''`);
  if (!driverDetail.includes('32.0.101.8861') || !driverDetail.includes('Jul 05, 2026')) {
    fail(`M3-C-I: driver row detail is '${driverDetail}' (expected version + date)`);
  }
  const appDetail = await js(`document.querySelector('.health-card .health-row[data-row="app"] .health-row-detail')?.textContent ?? ''`);
  if (appDetail.trim() !== 'App & Service Running') fail(`M3-C-I: app row detail is '${appDetail}' (expected 'App & Service Running')`);
  // The mock boot state: driver + device + app rows ok, OC row unknown
  // (nothing applied yet in this session).
  const dots = await js(`Array.from(document.querySelectorAll('.health-card .health-row .status-dot')).map((d) => d.className).join('|')`);
  if (!/status-ok/.test(dots)) fail(`no ok dot on the health card: '${dots}'`);
  if (!/status-unknown/.test(dots)) fail(`no unknown dot (OC never applied) on the health card: '${dots}'`);
  if (await js(`document.querySelector('.health-card')?.textContent.includes('Level Zero')`)) fail('Level Zero is still a health item');
  if (await js(`!!document.querySelector('.igs-toggle')`)) fail('M3-A: the IGS toggle button is still rendered');
  step('health-card', `one 'GPU Health' card: rows '${rowLabels}', driver '${driverDetail.trim()}', app '${appDetail.trim()}'`);

  // --- M4-A (user correction): the waiver STATUS row in the health card ---
  // The ONLY persistent waiver display in the app: green "Accepted" when the
  // store caps say accepted, red "Not Accepted" otherwise — read LIVE at
  // render (the dashboard re-renders on caps changes). Unaccepted -> the row
  // is CLICKABLE (opens the waiver dialog); accepted -> no click action.
  // The boot-accept variant accepted via the boot prompt while the dashboard
  // was CURRENT, so this waitFor doubles as the "flips green IN PLACE" pin
  // (the caps-change re-render happened with no navigation).
  const waiverDetailExpr = `document.querySelector('.health-card .health-row[data-row="waiver"] .health-row-detail')?.textContent ?? ''`;
  const waiverExpected = bootAccepted ? 'Accepted' : 'Not Accepted';
  if (!(await waitFor(win, `(${waiverDetailExpr}).trim() === '${waiverExpected}'`, 5000))) {
    fail(`M4-A: the health-card waiver row reads '${await js(waiverDetailExpr)}' (expected '${waiverExpected}')`);
  }
  const waiverDot = await js(`document.querySelector('.health-card .health-row[data-row="waiver"] .status-dot')?.className ?? ''`);
  if (!(bootAccepted ? /status-ok/ : /status-error/).test(waiverDot)) {
    fail(`M4-A: the waiver row dot is '${waiverDot}' (expected ${bootAccepted ? 'ok (green)' : 'error (red)'})`);
  }
  const waiverClickable = await js(`document.querySelector('.health-card .health-row[data-row="waiver"]')?.classList.contains('health-row-clickable')`);
  if (waiverClickable === bootAccepted) fail(`M4-A: waiver row clickability is '${waiverClickable}' (expected ${!bootAccepted} — clickable only while unaccepted)`);
  step('waiver-row', `health-card waiver row: 'OC waiver — ${waiverExpected}' (${bootAccepted ? 'green, no click action' : 'red, clickable'})`);

  if (!bootAccepted) {
    // M4-A review F1: the unaccepted row is CLICKABLE — click it: the waiver
    // dialog appears; Cancel closes it; the row STAYS red (no store patch on
    // a cancel) and the first OC apply below still gates.
    await js(`document.querySelector('.health-card .health-row[data-row="waiver"]')?.click()`);
    if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Warranty waiver'`, 5000))) {
      fail('M4-A: clicking the dashboard waiver row did not open the waiver dialog');
    }
    await js(`document.querySelector('.modal button.btn-ghost')?.click()`);
    if (!(await waitFor(win, `!document.querySelector('.modal')`, 5000))) fail('M4-A: the row-click waiver dialog did not close on Cancel');
    if (!(await waitFor(win, `(${waiverDetailExpr}).trim() === 'Not Accepted'`, 5000))) {
      fail('M4-A: the waiver row flipped after a Cancel (must stay Not Accepted)');
    }
    step('waiver-row-cancel', 'dashboard waiver row click -> dialog -> Cancel -> row stays Not Accepted (the first apply below still gates)');
  }

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

  // --- 2c. M2b-B tuning UX: "Core clock" label (M4-B user: named Core
  // --- clock in BOTH Offset and Clock modes) + floating Apply ----------
  const freqTitle = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? ''`);
  if (freqTitle.trim() !== 'Core clock') fail(`freq offset card title is '${freqTitle}' (expected 'Core clock' in both modes)`);
  step('label', `freq offset card renamed to 'Core clock' (mode-independent)`);

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
  // (bootAccepted / persistedWaiver were read right after the boot step —
  // the dashboard health-row section already consumed them.)

  // ocOnBoot gate check (M2b-B): with an unaccepted waiver the start-at-boot
  // checkbox must be disabled; after acceptance it is enabled.
  if (!bootAccepted) {
    await js(`location.hash = '#/profiles'`);
    if (!(await waitFor(win, `!!document.querySelector('.boot-checkbox')`))) fail('boot checkbox did not render');
    if (!(await js(`document.querySelector('.boot-checkbox').disabled`))) fail('start-at-boot must be gated on the waiver (unaccepted)');
    // M4-D (user): in an UNACCEPTED session the profile LOAD PROMPTS — the
    // classic waiver gate. Create a throwaway profile, click Load, Cancel
    // the dialog: the load is aborted, the device stays untouched (the
    // accepted-store variants never see this — their loads are silent).
    await js(`document.querySelector('.profile-create').click()`);
    if (!(await waitFor(win, `!!document.querySelector('.modal-input')`))) fail('M4-D: create-profile modal did not open (boot-gate step)');
    await js(`(() => { const i = document.querySelector('.modal-input'); i.value = 'ui-verify gate'; })()`);
    await js(`document.querySelector('.modal button.btn-primary').click()`);
    const gateRowExpr = `Array.from(document.querySelectorAll('.profile-row')).find((r) => (r.querySelector('.profile-name')?.textContent ?? '') === 'ui-verify gate')`;
    if (!(await waitFor(win, `!!(${gateRowExpr})`))) fail('M4-D: the gate-check profile did not appear');
    await js(`(() => { const r = ${gateRowExpr}; if (!r) return false; Array.from(r.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Load')?.click(); return true; })()`);
    if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Warranty waiver'`, 5000))) {
      fail('M4-D: an unaccepted profile load did not prompt the waiver dialog');
    }
    await clearToasts();
    await js(`document.querySelector('.modal button.btn-ghost')?.click()`);
    if (!(await waitFor(win, `!document.querySelector('.modal')`, 5000))) fail('M4-D: the profile-load waiver dialog did not close on Cancel');
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.toast-info')).some((t) => (t.textContent ?? '').includes('must be accepted'))`, 5000))) {
      fail(`M4-D: the cancelled profile load did not toast the honest info: '${await js(`Array.from(document.querySelectorAll('.toast-info')).map((t) => t.textContent).join(' | ')`)}'`);
    }
    const gateState = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(gateState.powerLimitW - 210) > 1e-6) fail(`M4-D: the cancelled profile load changed the device: ${gateState.powerLimitW}`);
    await js(`(() => { const r = ${gateRowExpr}; if (!r) return false; Array.from(r.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Delete')?.click(); return true; })()`);
    if (!(await waitFor(win, `!!document.querySelector('.modal button.btn-danger')`))) fail('M4-D: the gate-profile delete confirm did not open');
    await js(`document.querySelector('.modal button.btn-danger').click()`);
    if (!(await waitFor(win, `!(${gateRowExpr})`))) fail('M4-D: the gate profile was not deleted');
    await clearToasts();
    step('boot-gate', 'start-at-boot toggle disabled while the waiver is not accepted; M4-D: an unaccepted profile Load prompts the waiver dialog (Cancel aborts, device untouched)');
    await js(`location.hash = '#/overclocking'`);
    await sleep(250);
  }
  // M3-C review F4: the navigation above re-rendered the OC page from the
  // driver state (210 W), dropping the earlier 220 W slider move. The
  // isolated mock data dir makes the unaccepted-waiver branch reachable on
  // a FRESH store, so re-move the slider deterministically — the readout
  // checks below must not depend on a persisted acceptance from a previous
  // run.
  await setSlider(220);

  const readoutBefore = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-value').textContent`);
  if (readoutBefore.trim() !== '220 W') fail(`slider readout is '${readoutBefore}' (expected '220 W')`);
  step('slider', `power slider set to 220 W (readout '${readoutBefore}')`);

  // --- M4-A (user correction): the OC page renders NO waiver status --------
  // The status row lives ONLY in the dashboard GPU Health card; this page
  // keeps nothing but the apply-time dialog gate (exercised below).
  if (await js(`(document.getElementById('page')?.textContent ?? '').includes('OC waiver')`)) {
    fail('M4-A: the OC page still renders the waiver status (dashboard health card only)');
  }
  step('waiver-absent-oc', 'OC page has no waiver status row (dashboard health card only)');

  if (bootAccepted) {
    // Count toasts AFTER a clean slate: the apply below must produce exactly
    // `expectedToasts` success toasts (see the count check after both arms).
    await clearToasts();
    await clickApply();
    await sleep(400);
    if (await js(`!!document.querySelector('.modal')`)) fail('waiver dialog appeared despite the acceptance (F1)');
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`))) fail('success toast missing after apply');
    const state = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(state.powerLimitW - 220) > 1e-6) fail(`powerLimit not applied: ${state.powerLimitW}`);
    // M4-B (user): a SAVED waiver must survive the boot AND the apply — the
    // clock write lands with no waiver-not-set and the device still reports
    // the acceptance afterwards (the persisted flag is not consumed).
    const waiverAfter = await js(`window.arcPower.waiverGet(0)`);
    if (waiverAfter.accepted !== true) fail('M4-B: the waiver acceptance was lost across the apply (persisted-accepted session)');
    step('waiver-persisted', `waiver accepted at boot (persisted or boot-accept): apply without dialog -> read-back ${state.powerLimitW} W, waiverGet still accepted`);
    // M4-D (user, PERMANENT acceptance): an ACCEPTED store + a driver that
    // loses the waiver mid-session — the apply is SILENTLY re-set + retried
    // ONCE in main (never a dialog, never a dead-end, never a persisted
    // false). Inject a one-shot waiver-not-set on the power limit: the apply
    // lands WITHOUT any dialog, the read-back sticks, and waiver-get stays
    // accepted (the consent stands).
    backend.injectFail('powerLimitW', 'waiver-not-set', true);
    await clearToasts();
    await setSlider(230);
    await clickApply();
    await sleep(400);
    if (await js(`!!document.querySelector('.modal')`)) {
      fail('M4-D: the waiver dialog appeared for an ACCEPTED store (the silent re-set + retry must handle waiver-not-set)');
    }
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) {
      fail('M4-D: the silent re-set retry did not land (success toast missing)');
    }
    const retried = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(retried.powerLimitW - 230) > 1e-6) fail(`M4-D: the silent retry did not apply 230 W: ${retried.powerLimitW}`);
    const waiverAfterRetry = await js(`window.arcPower.waiverGet(0)`);
    if (waiverAfterRetry.accepted !== true) fail('M4-D: the waiver acceptance was lost across the silent re-set');
    step('m4d-waiver-silent-retry', `driver lost the waiver mid-session (accepted store): the apply silently re-set + retried ONCE (230 W read back, no dialog), waiverGet still accepted`);
    // Restore the flow's expected baseline (the driver readout + noop-toast
    // sections below expect 220 W applied and EXACTLY ONE success toast —
    // the restore apply's toast is the one they count).
    await clearToasts();
    await setSlider(220);
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-D: the 220 W baseline restore after the silent retry did not land');
  } else {
    // M3-C review F4: with the isolated mock data dir the unaccepted branch
    // is reachable on a FRESH store (pre-fix, the shared real settings.json
    // always carried a persisted acceptance, so this branch was dead). The
    // apply click is what triggers the dialog — it was missing here.
    await clickApply();
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

    // --- M4-D review F5: the OC-side renderer auto re-prompt pin ---------
    // (the profiles twin is pinned below via m4d-profiles-retry — this pins
    // the OC page's copy of the SAME never-accepted-session defense, which
    // ui-verify no longer exercised after the accepted-store silent retry
    // replaced the old dialog-based re-prompt pin). The gate Accept above
    // persisted the acceptance; simulate a NEVER-ACCEPTED session at apply
    // time — the STORE loses the persisted acceptance (settings.json) while
    // the renderer caps + driver flag still say accepted (no gate dialog):
    // the apply answers waiver-not-set, main's silent re-set is correctly
    // NOT available (unaccepted store), and the renderer must AUTO
    // RE-PROMPT once with the fresh (driver-truth, unaccepted) caps + retry
    // on accept.
    await store.saveSettings({ ...(await store.loadSettings()), waiverAccepted: false });
    backend.injectFail('powerLimitW', 'waiver-not-set', true);
    await setSlider(230);
    await clearToasts();
    await clickApply();
    // No gate dialog was clicked — the dialog must appear BY ITSELF (the
    // renderer-side re-prompt after the surfaced waiver-not-set).
    if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Warranty waiver'`, 5000))) {
      fail('M4-D: the OC apply did not auto re-prompt the waiver dialog after a waiver-not-set failure (never-accepted store, renderer-side retry)');
    }
    // The failed first attempt is surfaced honestly (per-control error
    // toast) before the re-prompt.
    if (!(await js(`!!document.querySelector('.toast-error')`))) {
      fail('M4-D: the failed first OC attempt did not surface its honest per-control error toast before the re-prompt');
    }
    await js(`document.querySelector('.modal button.btn-danger')?.click()`);
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) {
      fail(`M4-D: the OC retry did not land (no success toast; toasts=${await js(`Array.from(document.querySelectorAll('.toast')).map((t) => t.className + ':' + t.textContent).join(' | ')`)}; driver=${JSON.stringify(await js(`window.arcPower.getCurrentSettings(0)`))}; storeWaiver=${(await store.loadSettings()).waiverAccepted}; modal=${await js(`!!document.querySelector('.modal')`)})`);
    }
    if (await js(`!!document.querySelector('.modal')`)) fail('M4-D: a second dialog appeared after the OC retry accept (exactly one re-prompt)');
    const ocRetried = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(ocRetried.powerLimitW - 230) > 1e-6) {
      fail(`M4-D: the OC retry did not apply 230 W: ${ocRetried.powerLimitW}`);
    }
    // The counter reset: a clean apply (no failure injected) shows no dialog.
    await clearToasts();
    await setSlider(220);
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-D: the OC post-retry baseline apply did not land');
    if (await js(`!!document.querySelector('.modal')`)) fail('M4-D: the OC apply re-prompted after a successful retry (the counter must reset)');
    step('m4d-oc-retry', `M4-D: OC apply hit waiver-not-set (never-accepted store) -> ONE auto re-prompt by itself -> accept -> the retry landed (${ocRetried.powerLimitW} W read back, honest per-control error toast on the first attempt); a clean apply after shows no dialog (counter reset)`);
  }

  // M4-A: the dashboard health row now reflects the acceptance — the
  // accept-time + post-apply store re-sets ({ ...caps, waiverAccepted })
  // trigger the dashboard's caps-change full re-render, flipping the row
  // green. The M3-C-G chip checks below prove the OC page did NOT
  // full-re-render on the caps change (a re-render would clear the
  // applied-reference chips).
  await js(`location.hash = '#/dashboard'`);
  if (!(await waitFor(win, `(${waiverDetailExpr}).trim() === 'Accepted'`, 5000))) {
    fail(`M4-A: the dashboard waiver row did not flip to Accepted: '${await js(waiverDetailExpr)}'`);
  }
  if (await js(`document.querySelector('.health-card .health-row[data-row="waiver"]')?.classList.contains('health-row-clickable')`)) {
    fail('M4-A: the waiver row is still clickable once accepted');
  }
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  step('waiver-row-live', 'dashboard waiver row flipped to Accepted (re-render on the caps patch)');

  // M3-C-F: the "Driver:" readout refreshes from the FRESH state after the
  // apply — WITHOUT navigating away (previously built once at render, the
  // stale part that forced the leave-and-return dance).
  const driverAfterApply = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-driver-value')?.textContent ?? ''`);
  if (!driverAfterApply.includes('220')) {
    fail(`M3-C-F: driver readout is '${driverAfterApply}' after the apply (expected the fresh 220 W)`);
  }
  step('oc-fresh-driver', `M3-C-F: driver readout updated in place to '${driverAfterApply.trim()}' (no navigation)`);

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
  // the chip must show 'Applied' and the button must hide against the
  // APPLIED reference, even though the driver still reads 210.
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
  // M3-C-G: every control in the payload applied (perControl ok) -> its chip
  // shows green 'Applied' (value == last applied); the powerLimitW chip
  // proves the lag case (the driver still reads 210, the chip still says
  // Applied against the applied reference).
  const chipMap = await js(`JSON.stringify(Array.from(document.querySelectorAll('.oc-card')).map((c) => {
    const ch = c.querySelector('.oc-chip-status');
    return [c.dataset.control, !ch || ch.hidden === true ? 'hidden' : ch.textContent];
  }))`);
  const chips = JSON.parse(chipMap);
  const plChip = chips.find(([c]) => c === 'powerLimitW');
  if (!plChip || plChip[1] !== 'Applied') fail(`M3-C-G: powerLimitW chip is '${plChip?.[1]}' (expected 'Applied' after the successful apply)`);
  for (const [c, s] of chips) {
    if (s !== 'Applied') fail(`M3-C-G: chip '${c}' is '${s}' (expected 'Applied' — the control was in the applied payload)`);
  }
  if (!(await floatingHidden())) fail('B5: floating Apply still visible after a successful apply (read-back lags)');
  step('b5-lag', `B5/G: apply ok with lagging read-back (${lagState.powerLimitW} W) -> chip 'Applied', others hidden, Apply hidden`);
  await clearToasts();
  // Restore the real backend and re-render the OC page fresh (values snap
  // back to the 210 W read-back; the applied reference is per-page state).
  backend.applySettings = realApply;
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  if (!(await floatingHidden())) fail('floating Apply visible on a clean re-render');
  // M3-C-G: on a fresh re-render no control was applied in this render —
  // every chip is hidden again.
  const freshChips = await js(`JSON.stringify(Array.from(document.querySelectorAll('.oc-card')).map((c) => c.querySelector('.oc-chip-status')?.hidden !== false))`);
  if (!JSON.parse(freshChips).every(Boolean)) fail('M3-C-G: a chip is visible on a clean re-render (applied reference is per-render state)');
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

  // --- 5b2. M4-B: negative slider territory + Offset/Clock toggle + the
  // --- gpuLock editor. The waiver is accepted here (the apply flow above),
  // --- so every apply in this block is dialog-free. -------------------------
  const setFreqSlider = (value) => js(`(() => {
    const card = document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"]');
    const input = card.querySelector('input[type="range"]');
    input.value = '${value}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return card.querySelector('.oc-value')?.textContent ?? '';
  })()`);

  // (1) NEGATIVE HALF: the mirrored freq range -300..300 (a770) — the slider
  // reaches the negative half, the readout renders it, and an apply writes
  // + reads back the negative offset.
  const freqMin = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('min')`);
  const freqMax = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('max')`);
  if (freqMin !== '-300' || freqMax !== '300') fail(`M4-B: freq slider range is '${freqMin}'..'${freqMax}' (expected -300..300 — the mirrored min)`);
  const negReadout = await setFreqSlider(-100);
  if (negReadout.trim() !== '-100 MHz') fail(`M4-B: freq slider readout is '${negReadout}' (expected '-100 MHz')`);
  if (await floatingHidden()) fail('M4-B: floating Apply did not appear for the negative freq move');
  await clearToasts();
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: negative freq apply success toast missing');
  const negState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(negState.gpuFreqOffsetMhz + 100) > 1e-6) fail(`M4-B: negative freq apply did not stick: ${negState.gpuFreqOffsetMhz}`);
  step('m4b-negative', `M4-B: freq range ${freqMin}..${freqMax} MHz, slider -100 -> readout '${negReadout.trim()}', apply -> read-back ${negState.gpuFreqOffsetMhz} MHz`);
  await clearToasts();

  // (1b) NEGATIVE VOLT half-plane: the mirrored volt range -0.234..0.234 V
  // (a770) — a -0.050 V apply writes + reads back through the clamp (the
  // finding-5b negative-volt e2e pin; step 0.005, so -0.05 is on-grid).
  const setVoltSlider = (value) => js(`(() => {
    const card = document.querySelector('.oc-card[data-control="gpuVoltOffsetV"]');
    const input = card.querySelector('input[type="range"]');
    input.value = '${value}';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return card.querySelector('.oc-value')?.textContent ?? '';
  })()`);
  const voltMin = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] input[type="range"]')?.getAttribute('min')`);
  const voltMax = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] input[type="range"]')?.getAttribute('max')`);
  if (voltMin !== '-0.234' || voltMax !== '0.234') fail(`M4-B: volt slider range is '${voltMin}'..'${voltMax}' (expected -0.234..0.234 — the mirrored min)`);
  const voltReadout = await setVoltSlider(-0.05);
  if (voltReadout.trim() !== '-0.050 V') fail(`M4-B: volt slider readout is '${voltReadout}' (expected '-0.050 V' — 3-decimal volt format)`);
  if (await floatingHidden()) fail('M4-B: floating Apply did not appear for the negative volt move');
  await clearToasts();
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: negative volt apply success toast missing');
  const negVoltState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(negVoltState.gpuVoltOffsetV + 0.05) > 1e-6) fail(`M4-B: negative volt apply did not stick: ${negVoltState.gpuVoltOffsetV}`);
  step('m4b-negative-volt', `M4-B: volt range ${voltMin}..${voltMax} V, slider -0.05 -> readout '${voltReadout.trim()}', apply -> read-back ${negVoltState.gpuVoltOffsetV} V`);
  await clearToasts();

  // (2) Offset/Clock toggle: Clock mode slides over base+[min,max] (a770
  // base 2100 -> 1800..2400), the readout shows the ABSOLUTE clock, and an
  // apply stores the CONVERTED offset (target - base).
  if (!(await js(`!!document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-freq-mode-toggle')`))) {
    fail('M4-B: the Offset/Clock segmented toggle is missing on the freq card');
  }
  await js(`Array.from(document.querySelectorAll('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-freq-mode-btn')).find((b) => b.textContent.trim() === 'Clock')?.click()`);
  await sleep(150);
  // M4-B (user): the CARD NAME is 'Core clock' in BOTH modes — the toggle
  // changes the input presentation, never the name.
  const clockTitle = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .card-title')?.textContent ?? ''`);
  if (clockTitle.trim() !== 'Core clock') fail(`M4-B: the freq card title is '${clockTitle}' in Clock mode (must stay 'Core clock')`);
  const clockMin = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('min')`);
  const clockMax = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('max')`);
  if (clockMin !== '1800' || clockMax !== '2400') fail(`M4-B: Clock-mode slider range is '${clockMin}'..'${clockMax}' (expected 1800..2400 = base 2100 + -300..300)`);
  // M4-B step-5 F2: the .oc-range meta caption under the slider must follow
  // the mode — in Clock mode it describes the ABSOLUTE-clock range (the
  // pre-fix caption stayed on the OFFSET range the card was built with).
  const clockCaption = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-meta .oc-range')?.textContent ?? ''`);
  if (!clockCaption.includes('1800') || !clockCaption.includes('2400') || clockCaption.includes('-300')) {
    fail(`M4-B: Clock-mode range caption is '${clockCaption}' (expected the 1800..2400 MHz absolute-clock range — the stale offset caption must not survive the mode flip)`);
  }
  const clockReadout = await setFreqSlider(2050);
  if (clockReadout.trim() !== '2050 MHz') fail(`M4-B: Clock-mode readout is '${clockReadout}' (expected '2050 MHz' — the absolute clock)`);
  await clearToasts();
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: clock-mode apply success toast missing');
  const clockState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(clockState.gpuFreqOffsetMhz + 50) > 1e-6) fail(`M4-B: clock-mode apply stored the wrong offset: ${clockState.gpuFreqOffsetMhz} (expected -50 = 2050 - 2100)`);
  const clockDriver = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-driver-value')?.textContent ?? ''`);
  if (!clockDriver.includes('2050')) fail(`M4-B: Clock-mode driver readout is '${clockDriver}' (expected the absolute 2050 MHz)`);
  step('m4b-clock', `M4-B: Clock mode range ${clockMin}..${clockMax} MHz, slider 2050 -> readout '${clockReadout.trim()}', apply -> offset ${clockState.gpuFreqOffsetMhz} MHz, driver '${clockDriver.trim()}'`);
  await clearToasts();

  // (3) gpuLock editor (a770: gpuLock supported): the card sits in the
  // Advanced section, the expert row reads "Editing available", Apply/Reset
  // round-trip through the shared clamp path.
  if (await js(`!!document.querySelector('.gpu-lock-editor')`) === false) {
    fail('M4-B: the gpuLock editor card is missing in the Advanced section (a770 supports gpuLock)');
  }
  const advText = await js(`document.querySelector('.advanced-card')?.textContent ?? ''`);
  if (!advText.includes('Editing available')) fail(`M4-B: the gpuLock expert row does not read 'Editing available': '${advText}'`);
  const setLockInputs = (v, f) => js(`(() => {
    const card = document.querySelector('.gpu-lock-editor');
    const vi = card.querySelector('input[data-lock-field="voltageV"]');
    const fi = card.querySelector('input[data-lock-field="freqMhz"]');
    vi.value = '${v}'; fi.value = '${f}';
    vi.dispatchEvent(new Event('input', { bubbles: true }));
    fi.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await setLockInputs(0.9, 2100);
  await clearToasts();
  await js(`Array.from(document.querySelectorAll('.gpu-lock-editor button')).find((b) => b.textContent.trim() === 'Apply')?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: gpuLock apply success toast missing');
  const lockState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (!lockState.gpuLock || Math.abs(lockState.gpuLock.voltageV - 0.9) > 1e-6 || Math.abs(lockState.gpuLock.freqMhz - 2100) > 1e-6) {
    fail(`M4-B: gpuLock apply did not stick: ${JSON.stringify(lockState.gpuLock)}`);
  }
  await clearToasts();

  // (3b) M4-B step-4 F4: a NULL fresh envelope (degraded state read after a
  // successful write) must NOT flip the 'Applied:' line to 'Dynamic
  // (unlocked)' — the driver state is unknown, keep the previous line.
  const realGetState = backend.getCurrentSettings.bind(backend);
  backend.getCurrentSettings = async () => {
    throw new Error('injected degraded state read (ui-verify)');
  };
  await setLockInputs(1.2, 2400);
  await clearToasts();
  await js(`Array.from(document.querySelectorAll('.gpu-lock-editor button')).find((b) => b.textContent.trim() === 'Apply')?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: null-state gpuLock apply success toast missing');
  backend.getCurrentSettings = realGetState;
  const nullStateLine = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
  if (nullStateLine.trim() !== 'Applied: 0.9 V / 2100 MHz') {
    fail(`M4-B: null-state apply replaced the 'Applied:' line with '${nullStateLine.trim()}' (expected the previous 'Applied: 0.9 V / 2100 MHz')`);
  }
  const nullStateRead = await js(`window.arcPower.getCurrentSettings(0)`);
  // The WRITE landed (the failure was only the state read-back) — the honest
  // follow-up read must show the applied pair, and the stale store state must
  // NOT have been clobbered by the null envelope.
  if (!nullStateRead.gpuLock || Math.abs(nullStateRead.gpuLock.voltageV - 1.2) > 1e-6 || Math.abs(nullStateRead.gpuLock.freqMhz - 2400) > 1e-6) {
    fail(`M4-B: the null-state apply did not land the write: ${JSON.stringify(nullStateRead.gpuLock)} (expected the applied 1.2 V / 2400 MHz)`);
  }
  step('m4b-nullstate', `M4-B: degraded state read (null envelope) -> 'Applied:' line kept '${nullStateLine.trim()}' (never 'Dynamic (unlocked)')`);
  await clearToasts();

  // (3b2) M4-B step-5 F3: EMPTY inputs must be rejected BEFORE conversion —
  // Number('') === 0 and the 0 V / 0 MHz pair is the legal UNLOCK: a cleared
  // field must never silently unlock the GPU (no success toast, no state
  // change, the 'Applied:' line untouched).
  await setLockInputs('', '');
  await clearToasts();
  await js(`Array.from(document.querySelectorAll('.gpu-lock-editor button')).find((b) => b.textContent.trim() === 'Apply')?.click()`);
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.toast-error .toast-message')).some((t) => (t.textContent ?? '').includes('must be numbers'))`, 5000))) {
    fail('M4-B: an empty gpuLock field did not produce the "must be numbers" error toast');
  }
  if (await js(`!!document.querySelector('.toast-success')`)) {
    fail("M4-B: an empty gpuLock field APPLIED (Number('') === 0 silently applied the 0/0 UNLOCK pair)");
  }
  const emptyState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (!emptyState.gpuLock || Math.abs(emptyState.gpuLock.voltageV - 1.2) > 1e-6 || Math.abs(emptyState.gpuLock.freqMhz - 2400) > 1e-6) {
    fail(`M4-B: an empty gpuLock field changed the driver state to ${JSON.stringify(emptyState.gpuLock)} (must stay the applied 1.2 V / 2400 MHz)`);
  }
  const emptyLine = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
  if (emptyLine.trim() !== 'Applied: 0.9 V / 2100 MHz') {
    fail(`M4-B: an empty gpuLock field flipped the 'Applied:' line to '${emptyLine.trim()}' (must keep the previous pair)`);
  }
  step('m4b-gpulock-empty', `M4-B: empty gpuLock inputs -> 'must be numbers' toast, no success, driver state untouched (${JSON.stringify(emptyState.gpuLock)}), line '${emptyLine.trim()}'`);
  await clearToasts();
  // Back to the default pair for the Reset round trip below.
  await js(`Array.from(document.querySelectorAll('.gpu-lock-editor button')).find((b) => b.textContent.trim() === 'Reset')?.click()`);

  // (3c) M4-B step-4 F3: Reset must make the 'Applied:' line agree with the
  // inputs (0/0). Force a re-render first so the editor's render-time lock
  // IS the applied pair (0.9 V / 2100 MHz) — the pre-fix code then snapped
  // the line back to that stale pair on Reset instead of 'Dynamic (unlocked)'.
  await js(`location.hash = '#/dashboard'`);
  if (!(await waitFor(win, `!!document.querySelector('.health-card')`, 5000))) fail('M4-B: dashboard did not render for the gpuLock Reset round trip');
  await js(`location.hash = '#/overclocking'`);
  if (!(await waitFor(win, `!!document.querySelector('.gpu-lock-editor')`, 5000))) fail('M4-B: OC page did not re-render with the gpuLock editor');
  const reRenderLine = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
  if (reRenderLine.trim() !== 'Applied: 0.9 V / 2100 MHz') {
    fail(`M4-B: after the re-render the 'Applied:' line is '${reRenderLine.trim()}' (expected the applied 'Applied: 0.9 V / 2100 MHz')`);
  }
  await js(`Array.from(document.querySelectorAll('.gpu-lock-editor button')).find((b) => b.textContent.trim() === 'Reset')?.click()`);
  const resetInputs = await js(`(() => {
    const card = document.querySelector('.gpu-lock-editor');
    return card.querySelector('input[data-lock-field="voltageV"]').value + '/' + card.querySelector('input[data-lock-field="freqMhz"]').value;
  })()`);
  if (resetInputs !== '0/0') fail(`M4-B: gpuLock Reset did not restore the default pair: '${resetInputs}'`);
  const resetLine = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
  if (resetLine.trim() !== 'Applied: Dynamic (unlocked)') {
    fail(`M4-B: gpuLock Reset left the 'Applied:' line as '${resetLine.trim()}' (must agree with the 0/0 inputs — 'Applied: Dynamic (unlocked)')`);
  }
  step('m4b-gpulock-reset', `M4-B: gpuLock Reset round trip after re-render: line '${reRenderLine.trim()}' -> Reset -> inputs ${resetInputs}, line '${resetLine.trim()}'`);
  await clearToasts();
  await js(`Array.from(document.querySelectorAll('.gpu-lock-editor button')).find((b) => b.textContent.trim() === 'Apply')?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: gpuLock unlock apply success toast missing');
  const unlocked = await js(`window.arcPower.getCurrentSettings(0)`);
  if (!unlocked.gpuLock || unlocked.gpuLock.voltageV !== 0 || unlocked.gpuLock.freqMhz !== 0) {
    fail(`M4-B: gpuLock unlock (0,0) did not stick: ${JSON.stringify(unlocked.gpuLock)}`);
  }
  step('m4b-gpulock', `M4-B: gpuLock editor Apply/Reset round trip (0.9 V / 2100 MHz applied + read back, null-state refusal keeps the line, Reset -> 0/0, unlock applied)`);
  await clearToasts();

  // (3d) M4-B step-5 F4: the gpuLock SUCCESS toast reports the pair the
  // driver RECEIVED — main clamps before the write (clampGpuLock: [0, 1.5 V]
  // / [0, 5000 MHz]), so typing 2.5 V must toast '1.5 V', never re-print
  // the raw typed value (the toast and the 'Applied:' line must agree).
  await setLockInputs(2.5, 2400);
  await clearToasts();
  await js(`Array.from(document.querySelectorAll('.gpu-lock-editor button')).find((b) => b.textContent.trim() === 'Apply')?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: over-clamp gpuLock apply success toast missing');
  const clampToast = await js(`document.querySelector('.toast-success .toast-message')?.textContent ?? ''`);
  if (!clampToast.includes('1.5 V / 2400 MHz')) {
    fail(`M4-B: the gpuLock success toast reports '${clampToast}' (expected the clamped read-back '1.5 V / 2400 MHz', not the typed 2.5 V)`);
  }
  const clampLine = await js(`document.querySelector('.gpu-lock-current')?.textContent ?? ''`);
  if (!clampLine.includes('1.5 V / 2400 MHz')) {
    fail(`M4-B: the gpuLock 'Applied:' line is '${clampLine.trim()}' (expected 'Applied: 1.5 V / 2400 MHz' — toast and line must agree)`);
  }
  const clampState = await js(`window.arcPower.getCurrentSettings(0)`);
  if (!clampState.gpuLock || Math.abs(clampState.gpuLock.voltageV - 1.5) > 1e-6 || clampState.gpuLock.freqMhz !== 2400) {
    fail(`M4-B: the over-clamp gpuLock apply did not clamp: ${JSON.stringify(clampState.gpuLock)} (expected 1.5 V / 2400 MHz)`);
  }
  step('m4b-gpulock-honest', `M4-B: gpuLock success toast reports the clamped read-back pair ('${clampToast.trim()}', line '${clampLine.trim()}')`);
  await clearToasts();
  // Back to the unlocked default so the baseline restore below is clean.
  await setLockInputs(0, 0);
  await js(`Array.from(document.querySelectorAll('.gpu-lock-editor button')).find((b) => b.textContent.trim() === 'Apply')?.click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: gpuLock unlock restore did not apply');
  const unlockRestored = await js(`window.arcPower.getCurrentSettings(0)`);
  if (!unlockRestored.gpuLock || unlockRestored.gpuLock.voltageV !== 0 || unlockRestored.gpuLock.freqMhz !== 0) {
    fail(`M4-B: gpuLock unlock restore did not land: ${JSON.stringify(unlockRestored.gpuLock)}`);
  }
  await clearToasts();

  // Restore: Offset mode + freq 0 + volt 0 — the later sections expect the
  // a770 baseline (the freq card must never be left in Clock mode, and the
  // volt slider must never be left in the negative half-plane).
  await js(`Array.from(document.querySelectorAll('.oc-card[data-control="gpuFreqOffsetMhz"] .oc-freq-mode-btn')).find((b) => b.textContent.trim() === 'Offset')?.click()`);
  await sleep(150);
  await setVoltSlider(0);
  await setFreqSlider(0);
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-B: freq/volt baseline restore did not apply');
  const freqRestored = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(freqRestored.gpuFreqOffsetMhz) > 1e-6) fail(`M4-B: freq baseline not restored: ${freqRestored.gpuFreqOffsetMhz}`);
  if (Math.abs(freqRestored.gpuVoltOffsetV) > 1e-6) fail(`M4-B: volt baseline not restored: ${freqRestored.gpuVoltOffsetV}`);
  await clearToasts();
  step('m4b-restore', `M4-B: back to Offset mode, freq baseline restored (${freqRestored.gpuFreqOffsetMhz} MHz), volt baseline restored (${freqRestored.gpuVoltOffsetV} V), gpuLock unlocked`);

  // --- 5c. M3-C-D/E extended + stock variants. ------------------------------
  // RID_MOCK_EXTENDED_RANGES=1 (mock default OC mode = advanced): full slider
  // range (315 W / 115 C), the extended apply SKIPS the per-apply confirm
  // (the mode-enable confirm already warned — double-dialog decision);
  // optional RID_MOCK_WORKER_APPLY=1 adds the elevation toast on top.
  // RID_MOCK_STOCK_MODE=1: stock mode — sliders pinned to the standard
  // limits and a direct above-limit apply REFUSES with the mode message
  // (never clamps, never a dead-end confirm).
  const extendedRanges = process.env.RID_MOCK_EXTENDED_RANGES === '1';
  const workerApply = process.env.RID_MOCK_WORKER_APPLY === '1';
  const stockMode = process.env.RID_MOCK_STOCK_MODE === '1';
  if (extendedRanges && !stockMode) {
    const setPlSlider = (value) => js(`(() => {
      const card = document.querySelector('.oc-card[data-control="powerLimitW"]');
      const input = card.querySelector('input[type="range"]');
      input.value = '${value}';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return card.querySelector('.oc-value').textContent;
    })()`);

    // The extended ranges are exposed: slider maxes 315 W / 115 C.
    const plMax = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] input[type="range"]')?.getAttribute('max')`);
    if (plMax !== '315') fail(`M3-C-D: power slider max is '${plMax}' (expected 315 — live-verified ceiling)`);
    const tlMax = await js(`document.querySelector('.oc-card[data-control="tempLimitC"] input[type="range"]')?.getAttribute('max')`);
    if (tlMax !== '115') fail(`M3-C-D: temp slider max is '${tlMax}' (expected 115)`);
    // The mode toggle renders with Advanced active (mock default advanced).
    const advBtn = await js(`Array.from(document.querySelectorAll('.oc-mode-btn')).find((b) => b.textContent.trim() === 'Advanced')?.classList.contains('active')`);
    if (!advBtn) fail('M3-C-E: the OC-mode toggle does not show Advanced active (mock default)');
    step('extended-ranges', `extended ranges exposed: PL slider max ${plMax} W, TL slider max ${tlMax} C, Advanced mode active`);

    // 300 W -> apply -> NO confirm dialog (double-dialog decision: the
    // mode-enable confirm already warned in Advanced mode).
    await setPlSlider(300);
    if (await floatingHidden()) fail('floating Apply did not appear for the extended value');
    await clearToasts();
    await clickApply();
    if (await js(`!!document.querySelector('.modal')`)) fail('M3-C-D: a per-apply confirm dialog appeared in Advanced mode (must be skipped)');
    if (workerApply) {
      if (!(await waitFor(win, `Array.from(document.querySelectorAll('.toast-info')).some((t) => (t.textContent ?? '').includes('Administrator approval is needed'))`, 5000))) {
        fail('M2C-C: the elevation explanation toast did not appear before the worker apply');
      }
      step('elevation-toast', `elevation explanation toast shown before the UAC prompt ('${await js(`Array.from(document.querySelectorAll('.toast-info')).find((t) => (t.textContent ?? '').includes('Administrator approval is needed'))?.querySelector('.toast-message')?.textContent ?? ''`)}')`);
    }
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('extended apply success toast missing');
    const extendedState = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(extendedState.powerLimitW - 300) > 1e-6) fail(`extended apply did not stick: powerLimit=${extendedState.powerLimitW}`);
    // M3-C-F: the driver readout shows the fresh 300 W without navigating.
    const extDriver = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] .oc-driver-value')?.textContent ?? ''`);
    if (!extDriver.includes('300')) fail(`M3-C-F: extended driver readout is '${extDriver}' (expected 300)`);
    step('extended-apply', `extended apply (300 W) applied with NO per-apply confirm, read-back ${extendedState.powerLimitW} W, driver readout '${extDriver.trim()}'`);
    await clearToasts();

    // Restore the standard baseline for the later steps.
    await setPlSlider(210);
    await clickApply();
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('extended baseline restore (210 W) did not apply');
    const baseline = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(baseline.powerLimitW - 210) > 1e-6) fail(`extended baseline is not 210 W: ${baseline.powerLimitW}`);
    await clearToasts();
    step('extended-restore', 'extended baseline restored to 210 W');
  } else if (stockMode) {
    // M3-C-E stock variant: the sliders stay within the standard limits and
    // a DIRECT above-limit request REFUSES with the mode message — never
    // clamps, never a confirm dialog (the mock default is advanced; this
    // variant flipped it to stock via RID_MOCK_STOCK_MODE=1).
    const plMax = await js(`document.querySelector('.oc-card[data-control="powerLimitW"] input[type="range"]')?.getAttribute('max')`);
    if (plMax !== '252') fail(`M3-C-E stock: power slider max is '${plMax}' (expected 252 — standard limit)`);
    const tlMax = await js(`document.querySelector('.oc-card[data-control="tempLimitC"] input[type="range"]')?.getAttribute('max')`);
    if (tlMax !== '90') fail(`M3-C-E stock: temp slider max is '${tlMax}' (expected 90)`);
    const stockBtn = await js(`Array.from(document.querySelectorAll('.oc-mode-btn')).find((b) => b.textContent.trim() === 'Stock')?.classList.contains('active')`);
    if (!stockBtn) fail('M3-C-E: the OC-mode toggle does not show Stock active');
    if (await js(`window.arcPower.getCapabilities(0).then((c) => c.extendedRanges === true)`)) {
      fail('M3-C-E stock: getCapabilities still reports extendedRanges in stock mode');
    }
    step('stock-ranges', `stock mode: PL slider max ${plMax} W, TL slider max ${tlMax} C, no extendedRanges flag`);

    // A direct 300 W apply (bypasses the slider — the UI cannot produce it)
    // must REFUSE with the mode message, never clamp to 252 and never show
    // a confirm dialog.
    const refusal = await js(`window.arcPower.applySettings(0, { powerLimitW: 300 })`);
    if (refusal.result.ok !== false) fail('M3-C-E stock: a 300 W apply in stock mode did not refuse');
    const per = refusal.result.perControl.powerLimitW;
    if (!per || per.ok !== false) fail('M3-C-E stock: the refusal is not per-control: ' + JSON.stringify(refusal.result.perControl));
    if (!/Advanced OC Mode/.test(per.message ?? '')) fail(`M3-C-E stock: refusal message is '${per?.message}' (expected the mode message)`);
    const stateAfter = await js(`window.arcPower.getCurrentSettings(0)`);
    if (Math.abs(stateAfter.powerLimitW - 210) > 1e-6) fail(`M3-C-E stock: the refusal changed the device state: ${stateAfter.powerLimitW} (must stay 210)`);
    if (await js(`!!document.querySelector('.modal')`)) fail('M3-C-E stock: a dead-end confirm dialog appeared (refusal + toast only)');
    step('stock-refusal', `stock mode: 300 W refused with the mode message, device untouched at 210 W, no dialog`);
    await clearToasts();
  }

  // --- M4-B (user): the Advanced OC Mode warning is a ONCE-only gate -------
  // Shown ONLY on the first Stock->Advanced toggle, persisted on acceptance,
  // never re-asked on a later boot. Two flows:
  //   - stock-boot session (warning unaccepted): first Advanced click shows
  //     the dialog; Cancel keeps stock; the next click shows it AGAIN;
  //     Enable flips the mode AND persists; a later Stock->Advanced round
  //     trip shows NO dialog (the persistence is the regression pin).
  //   - RID_MOCK_ADVANCED_ACCEPTED=1 (boot-persisted acceptance): a
  //     Stock->Advanced toggle shows NO dialog at all — the "saved onto
  //     next boot" case the user asked for.
  const advancedAccepted = process.env.RID_MOCK_ADVANCED_ACCEPTED === '1';
  const clickModeBtn = (label) => js(`Array.from(document.querySelectorAll('.oc-mode-btn')).find((b) => b.textContent.trim() === '${label}')?.click()`);
  const modeActive = (label) => js(`Array.from(document.querySelectorAll('.oc-mode-btn')).find((b) => b.textContent.trim() === '${label}')?.classList.contains('active')`);
  const advancedDialogTitle = `document.querySelector('.modal .modal-title')?.textContent === 'Advanced OC Mode'`;

  if (stockMode && !advancedAccepted) {
    // First toggle: the warning must appear, Cancel must keep stock mode.
    await clickModeBtn('Advanced');
    if (!(await waitFor(win, advancedDialogTitle, 5000))) fail('M4-B: the Advanced OC Mode warning did not appear on the first toggle');
    await js(`Array.from(document.querySelectorAll('.modal button')).find((b) => b.textContent.trim() === 'Cancel')?.click()`);
    if (!(await waitFor(win, `!document.querySelector('.modal')`, 5000))) fail('M4-B: the Advanced OC Mode warning did not close on Cancel');
    if (!(await modeActive('Stock'))) fail('M4-B: Cancel on the warning left the mode changed (must stay Stock)');
    // Second toggle: the warning must appear again (still unaccepted).
    await clickModeBtn('Advanced');
    if (!(await waitFor(win, advancedDialogTitle, 5000))) fail('M4-B: the warning did not re-appear on the second toggle (must re-ask until accepted)');
    // Enable: flips the mode AND persists the once-only acceptance.
    await js(`Array.from(document.querySelectorAll('.modal button')).find((b) => b.textContent.includes('Enable Advanced OC Mode'))?.click()`);
    if (!(await waitFor(win, `!document.querySelector('.modal')`, 5000))) fail('M4-B: the warning did not close on Enable');
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Advanced' && b.classList.contains('active'))`, 5000))) {
      fail('M4-B: enabling Advanced did not flip the toggle');
    }
    const acceptedAfter = await js(`window.arcPower.advancedModeAcceptedGet()`);
    if (acceptedAfter.accepted !== true) fail('M4-B: the Advanced OC Mode acceptance was not persisted');
    // Round-trip back to Stock, then to Advanced: NO dialog (persisted).
    await clickModeBtn('Stock');
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Stock' && b.classList.contains('active'))`, 5000))) {
      fail('M4-B: switching back to Stock failed');
    }
    await clickModeBtn('Advanced');
    await sleep(1200);
    if (await js(`!!document.querySelector('.modal')`)) fail('M4-B: the Advanced OC Mode warning re-appeared after a persisted acceptance');
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Advanced' && b.classList.contains('active'))`, 5000))) {
      fail('M4-B: the persisted-acceptance toggle did not flip to Advanced');
    }
    // Restore the variant's stock state for the sections below.
    await clickModeBtn('Stock');
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Stock' && b.classList.contains('active'))`, 5000))) {
      fail('M4-B: restoring Stock failed');
    }
    await clearToasts();
    step('m4b-advanced-once', 'Advanced OC Mode warning: shown on the first toggle (Cancel keeps stock, re-asked until Enable), persisted on accept, NEVER re-asked after');
  } else if (advancedAccepted && !stockMode) {
    // Boot-persisted acceptance (RID_MOCK_ADVANCED_ACCEPTED=1): a fresh
    // toggle must skip the warning entirely — the "saved onto the next
    // boot" case. Default variant boots Advanced, so round-trip through
    // Stock first and back.
    await clickModeBtn('Stock');
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Stock' && b.classList.contains('active'))`, 5000))) {
      fail('M4-B: switching to Stock failed in the persisted-acceptance session');
    }
    await clickModeBtn('Advanced');
    await sleep(1200);
    if (await js(`!!document.querySelector('.modal')`)) fail('M4-B: the Advanced OC Mode warning appeared despite a boot-persisted acceptance (RID_MOCK_ADVANCED_ACCEPTED=1)');
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.oc-mode-btn')).some((b) => b.textContent.trim() === 'Advanced' && b.classList.contains('active'))`, 5000))) {
      fail('M4-B: the toggle did not flip to Advanced (boot-persisted acceptance)');
    }
    await clearToasts();
    step('m4b-advanced-persisted', 'boot-persisted Advanced-mode acceptance: Stock->Advanced toggle shows NO warning (saved onto next boot)');
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
  // M4-B: the gpuLock editor is gated on caps.controls.gpuLock — it must
  // disappear on the b580 swap (gpuLock unsupported there).
  if (await js(`!!document.querySelector('.gpu-lock-editor')`)) {
    fail('M4-B: the gpuLock editor is still rendered on b580 (gated off — gpuLock unsupported)');
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
  // M4-B: the gpuLock editor returns with the a770 surface (gpuLock
  // supported again).
  if (await js(`!!document.querySelector('.gpu-lock-editor')`) === false) {
    fail('M4-B: the gpuLock editor did not return after the swap back to a770');
  }
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
  // M4-A (user correction): the Fan page renders NO waiver status — the row
  // lives only in the dashboard GPU Health card (the waiver was accepted
  // during the OC flow; the fan apply-time dialog gate is unaffected).
  if (await js(`(document.getElementById('page')?.textContent ?? '').includes('OC waiver')`)) {
    fail('M4-A: the fan page still renders the waiver status (dashboard health card only)');
  }
  step('waiver-absent-fan', 'fan page has no waiver status row (dashboard health card only)');
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

  // --- M4-C: Fixed tab always rendered + the honest disabled state ---------
  // The editable a770 overlay's learned modes are ['auto','curve'] (fixed
  // writes are genuinely unsupported on this card) — the Fixed chip must
  // ALWAYS render, DISABLED, with the honest note.
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.fan-mode-toggle .chip')).some((c) => (c.textContent ?? '').trim() === 'Fixed')`))) {
    fail('M4-C: the Fixed mode chip is missing from the toggle (it must ALWAYS render)');
  }
  const toggleState = await js(`JSON.stringify(Array.from(document.querySelectorAll('.fan-mode-toggle .chip')).map((c) => [c.textContent.trim(), c.disabled, c.classList.contains('chip-active')]))`);
  const toggle = JSON.parse(toggleState);
  const fixedChip = toggle.find(([label]) => label === 'Fixed');
  if (!fixedChip) fail('M4-C: the Fixed chip is not in the toggle');
  if (fixedChip[1] !== true) fail('M4-C: the Fixed chip must be DISABLED when fixed is not in caps.fan.modes');
  const autoChip = toggle.find(([label]) => label === 'Auto');
  const curveChip = toggle.find(([label]) => label === 'Curve');
  if (!autoChip || autoChip[1] !== false || !curveChip || curveChip[1] !== false) {
    fail(`M4-C: the supported Auto/Curve chips must stay enabled: ${toggleState}`);
  }
  if (toggle.some(([label, , active]) => label === 'Fixed' && active)) {
    fail('M4-C: a DISABLED Fixed chip must never render as the active mode');
  }
  const fixedNote = await js(`document.querySelector('.fan-fixed-note')?.textContent ?? ''`);
  if (!fixedNote.includes('Fixed speed is not supported on this GPU')) {
    fail(`M4-C: the honest fixed note is missing: '${fixedNote}'`);
  }
  step('fan-m4c-fixed', `M4-C: Fixed tab always renders — chip disabled (${toggleState}), note '${fixedNote.trim()}'`);

  // --- M4-C: dot hover readout + live drag readout --------------------------
  // Hover a dot: the floating readout shows "85% @ 72 °C · #N" style text.
  // Round-1 strengthening: the LAST dot is the 88C/100% TOP-EDGE point —
  // the readout must be FULLY VISIBLE (getBoundingClientRect inside the
  // stage bounds; the old above-dot parking clipped under .fan-stage
  // overflow:hidden and the previous pin only checked ro.hidden/text).
  const hoverOk = await js(`(() => {
    const dots = Array.from(document.querySelectorAll('.fan-dot'));
    const dot = dots[dots.length - 1];
    dot.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const ro = document.querySelector('.fan-dot-readout');
    if (!ro || ro.hidden) return 'readout-hidden';
    const want = dot.dataset.speed + '% @ ' + dot.dataset.t + ' °C · #' + dot.dataset.idx;
    if (ro.textContent !== want) return 'mismatch:' + ro.textContent + ' != ' + want;
    const stage = document.querySelector('.fan-stage');
    const sr = stage.getBoundingClientRect();
    const rr = ro.getBoundingClientRect();
    const inside = rr.top >= sr.top - 0.5 && rr.bottom <= sr.bottom + 0.5
      && rr.left >= sr.left - 0.5 && rr.right <= sr.right + 0.5;
    if (!inside) return 'clipped-outside-stage:' + JSON.stringify({ sr: [sr.top, sr.bottom, sr.left, sr.right], rr: [rr.top, rr.bottom, rr.left, rr.right] });
    if (Number(dot.dataset.speed) === 100 && !ro.classList.contains('fan-dot-readout-below')) {
      return 'top-edge-not-flipped';
    }
    return 'ok';
  })()`);
  if (hoverOk !== 'ok') fail(`M4-C: hover readout: ${hoverOk}`);
  await js(`document.querySelector('.fan-dot')?.dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))`);
  if (!(await waitFor(win, `document.querySelector('.fan-dot-readout')?.hidden === true`, 5000))) {
    fail('M4-C: the hover readout did not hide on pointerout');
  }
  // Drag the same dot: the readout must appear and LIVE-UPDATE during the
  // move, then hide on release.
  const dragOk = await js(`(() => {
    const stage = document.querySelector('.fan-stage');
    const rect = stage.getBoundingClientRect();
    const dot = Array.from(document.querySelectorAll('.fan-dot')).find((d) => Number(d.dataset.idx) === 1);
    dot.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 7, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 }));
    window.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: 7, clientX: rect.left + rect.width * 0.3, clientY: rect.top + rect.height * 0.4 }));
    const ro = document.querySelector('.fan-dot-readout');
    const moved = document.querySelector('.fan-dot[data-idx="1"]');
    const movedOk = moved && Number(moved.dataset.t) === 30 && Number(moved.dataset.speed) === 60;
    const roOk = !!ro && !ro.hidden && ro.textContent === '60% @ 30 °C · #1';
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 7 }));
    const hiddenAfter = document.querySelector('.fan-dot-readout')?.hidden === true;
    return movedOk && roOk && hiddenAfter
      ? 'ok'
      : JSON.stringify({ moved: moved ? [moved.dataset.t, moved.dataset.speed] : null, ro: ro?.textContent, roHidden: ro?.hidden, hiddenAfter });
  })()`);
  if (dragOk !== 'ok') fail(`M4-C: drag readout: ${dragOk}`);
  step('fan-m4c-hover', 'M4-C: dot hover readout ("60% @ 30 °C · #1"-style), live during drag, hidden on pointerout/up');

  // M4-C round-1 fix: a stale hover readout must NOT survive a mode switch —
  // hover a dot, click Auto, click Curve: the readout must stay hidden
  // (the old renderEditor-scope state survived the switch and popped the
  // readout up for the selected point with no pointer near a dot).
  const modeSwitchOk = await js(`(() => {
    const chip = (label) => Array.from(document.querySelectorAll('.fan-mode-toggle .chip')).find((c) => (c.textContent ?? '').trim() === label);
    const dot = Array.from(document.querySelectorAll('.fan-dot')).find((d) => Number(d.dataset.idx) === 3);
    if (!dot) return 'no-dot';
    dot.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    const shownBefore = document.querySelector('.fan-dot-readout')?.hidden === false;
    chip('Auto')?.click();
    chip('Curve')?.click();
    const ro = document.querySelector('.fan-dot-readout');
    const hiddenAfter = !!ro && ro.hidden === true;
    return shownBefore && hiddenAfter ? 'ok' : JSON.stringify({ shownBefore, hiddenAfter: !!ro && ro.hidden });
  })()`);
  if (modeSwitchOk !== 'ok') fail(`M4-C: stale readout after a mode switch: ${modeSwitchOk}`);
  step('fan-m4c-mode-switch', 'M4-C: the mode switch clears the hover readout (no stale readout on returning to Curve)');

  // --- M4-C: manual per-point boxes -----------------------------------------
  // Typing a colliding temp clamps between the neighbors (dot dataset.t +
  // the input value must show the clamped temp).
  const boxTemp = await js(`(() => {
    const row = document.querySelector('.fan-point-row[data-idx="2"]');
    const inp = row.querySelector('input[data-field="t"]');
    inp.value = '80';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const dot = document.querySelector('.fan-dot[data-idx="2"]');
    return dot.dataset.t + '/' + inp.value;
  })()`);
  if (boxTemp !== '69/69') fail(`M4-C: manual temp box: got '${boxTemp}' (expected 69/69 — clamped strictly between the neighbors 30+1 and 70-1)`);
  // Typing an over-range speed clamps to 100.
  const boxSpeed = await js(`(() => {
    const row = document.querySelector('.fan-point-row[data-idx="2"]');
    const inp = row.querySelector('input[data-field="speed"]');
    inp.value = '150';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    const dot = document.querySelector('.fan-dot[data-idx="2"]');
    return dot.dataset.speed + '/' + inp.value;
  })()`);
  if (boxSpeed !== '100/100') fail(`M4-C: manual speed box: got '${boxSpeed}' (expected 100/100 — clamped to 0..100)`);
  // M4-C round-1 fix: TYPED temps are clamped to the static 0..100 domain
  // like the drag path (xToTemp clamps) — clampTempBetween only clamps
  // BETWEEN neighbors, so typing 150 / -5 into the OUTER points (no
  // neighbor on that side) used to reach the driver table unclamped.
  const boxOuter = await js(`(() => {
    const rows = Array.from(document.querySelectorAll('.fan-point-row'));
    const last = rows[rows.length - 1];
    const lastInp = last.querySelector('input[data-field="t"]');
    lastInp.value = '150';
    lastInp.dispatchEvent(new Event('input', { bubbles: true }));
    const lastDot = document.querySelector('.fan-dot[data-idx="' + (rows.length - 1) + '"]');
    const first = rows[0];
    const firstInp = first.querySelector('input[data-field="t"]');
    firstInp.value = '-5';
    firstInp.dispatchEvent(new Event('input', { bubbles: true }));
    const firstDot = document.querySelector('.fan-dot[data-idx="0"]');
    return (lastDot ? lastDot.dataset.t : 'no-dot') + '/' + lastInp.value + '/' + (firstDot ? firstDot.dataset.t : 'no-dot') + '/' + firstInp.value;
  })()`);
  if (boxOuter !== '100/100/0/0') fail(`M4-C: manual temp box domain clamp: got '${boxOuter}' (expected 100/100/0/0 — typing 150 / -5 clamps to the static 0..100 domain)`);
  // M4-C round-2 fix: an EMPTIED box must NOT be treated as 0 — Number('')
  // is 0 and finite, so clearing a box used to instantly move the point to
  // 0 °C / 0 % and rewrite the box to '0' (the same bug class the gpuLock
  // editor's parseGpuLockInput already rejects). Clearing the temp AND
  // speed boxes of point 1 must leave the dot dataset unchanged and both
  // boxes as the user left them ('').
  const boxEmpty = await js(`(() => {
    const row = document.querySelector('.fan-point-row[data-idx="1"]');
    const dot = document.querySelector('.fan-dot[data-idx="1"]');
    const before = dot.dataset.t + '/' + dot.dataset.speed;
    for (const field of ['t', 'speed']) {
      const inp = row.querySelector('input[data-field="' + field + '"]');
      inp.value = '';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const after = dot.dataset.t + '/' + dot.dataset.speed;
    const tVal = row.querySelector('input[data-field="t"]').value;
    const sVal = row.querySelector('input[data-field="speed"]').value;
    return before + '|' + after + '|' + tVal + '|' + sVal;
  })()`);
  const [beBefore, beAfter, beT, beS] = boxEmpty.split('|');
  if (beBefore !== beAfter) fail(`M4-C: clearing a manual box moved the point (${beBefore} -> ${beAfter}) — an empty input must keep the previous value (Number('') is 0)`);
  if (beT !== '' || beS !== '') fail(`M4-C: cleared boxes were rewritten to '${beT}'/'${beS}' (expected both to stay '' — no point mutation on empty input)`);
  // Per-point remove: one click removes the row's point; at the 2-point
  // floor every remove button is disabled and clicking is a no-op.
  await js(`document.querySelector('.fan-point-row .fan-point-remove').click()`);
  if (!(await waitFor(win, `document.querySelectorAll('.fan-dot').length === ${pointsAfter - 1}`, 5000))) {
    fail(`M4-C: per-point remove did not remove one dot (expected ${pointsAfter - 1})`);
  }
  const floorOk = await js(`(() => {
    let guard = 0;
    while (document.querySelectorAll('.fan-dot').length > 2 && guard++ < 20) {
      document.querySelector('.fan-point-remove')?.click();
    }
    const count = document.querySelectorAll('.fan-dot').length;
    const allDisabled = Array.from(document.querySelectorAll('.fan-point-remove')).every((b) => b.disabled);
    const before = count;
    document.querySelector('.fan-point-remove')?.click();
    return count === 2 && allDisabled && document.querySelectorAll('.fan-dot').length === before;
  })()`);
  if (!floorOk) fail('M4-C: the per-point remove did not floor at MIN_CURVE_POINTS (2) with disabled buttons');
  // Re-seed a couple of points so the preset step below has a sane curve.
  await js(`Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Add point'))?.click()`);
  step('fan-m4c-boxes', 'M4-C: manual per-point boxes — colliding temp clamped between (69), speed clamped to 100, per-point remove floors at 2 (buttons disabled)');

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

  // --- 8. startup channels (M2b + M4-D plain-app task) ----------------------
  const startState = await js(`window.arcPower.startupGet()`);
  if (startState.startupRunKey?.enabled !== false) fail(`startupGet initial state: ${JSON.stringify(startState)}`);
  if (startState.applyOnBoot?.enabled !== false) fail(`startupGet initial app-task state: ${JSON.stringify(startState)}`);
  const setOn = await js(`window.arcPower.startupSet(true, 'profile-1')`);
  if (setOn.startupRunKey?.enabled !== true || setOn.startupRunKey?.profileId !== 'profile-1') fail(`startupSet(true): ${JSON.stringify(setOn)}`);
  if (!/--apply-profile profile-1/.test(setOn.startupRunKey?.value ?? '')) fail(`startupSet value: ${setOn.startupRunKey?.value}`);
  // M4-D: enabling the apply-profile registration must disable the app task
  // (coexistence — the two onlogon tasks cannot both be enabled).
  if (setOn.applyOnBoot?.enabled !== false) fail(`startupSet(true) left the app task enabled: ${JSON.stringify(setOn)}`);
  const setOff = await js(`window.arcPower.startupSet(false, null)`);
  if (setOff.startupRunKey?.enabled !== false || setOff.startupRunKey?.profileId !== null) fail(`startupSet(false): ${JSON.stringify(setOff)}`);
  const badRejected = await js(`(async () => { try { await window.arcPower.startupSet(true, null); return 'accepted'; } catch (e) { return 'rejected'; } })()`);
  if (badRejected !== 'rejected') fail(`startupSet(true, null) was not rejected (${badRejected})`);
  // M4-D: the plain-app task channel round trip + coexistence the other way.
  const appOn = await js(`window.arcPower.startupAppSet(true)`);
  if (appOn.applyOnBoot?.enabled !== true || appOn.startWithWindows !== true) fail(`startupAppSet(true): ${JSON.stringify(appOn)}`);
  if (appOn.startupRunKey?.enabled !== false) fail(`startupAppSet(true) left the apply-profile registration enabled: ${JSON.stringify(appOn)}`);
  const appOff = await js(`window.arcPower.startupAppSet(false)`);
  if (appOff.applyOnBoot?.enabled !== false || appOff.startWithWindows !== false) fail(`startupAppSet(false): ${JSON.stringify(appOff)}`);
  const badAppRejected = await js(`(async () => { try { await window.arcPower.startupAppSet('yes'); return 'accepted'; } catch (e) { return 'rejected'; } })()`);
  if (badAppRejected !== 'rejected') fail(`startupAppSet('yes') was not rejected (${badAppRejected})`);
  step('startup-ipc', `startup channels: get -> set(profile-1) -> set(off) -> app-task set(true/false, coexistence) -> invalid payloads rejected`);

  // --- 8b. M4-D: sysinfo + window-op channels through the REAL preload ------
  // The mock adapter serves the fixed fixture (never PowerShell); the
  // injected window ops COUNT in ui-verify mode (performing minimize/close
  // mid-verify would disrupt the flow) — run 2 pins the title-bar buttons
  // via getWindowOpCounts.
  const sysinfo = await js(`window.arcPower.sysinfo()`);
  if (sysinfo?.cpu?.name !== 'Intel(R) Core(TM) i7-14700K' || sysinfo?.cpu?.cores !== 20) {
    fail(`sysinfo IPC payload wrong: ${JSON.stringify(sysinfo)}`);
  }
  if (sysinfo?.videoControllers?.[0]?.name !== 'Intel(R) Arc(TM) A770 Graphics') {
    fail(`sysinfo videoControllers wrong: ${JSON.stringify(sysinfo?.videoControllers)}`);
  }
  // Snapshot BEFORE the calls (a live reference would read the post-call
  // values for both sides — the counters are a single mutable object).
  const opsBefore = { ...getWindowOpCounts() };
  await js(`window.arcPower.windowMinimize()`);
  await js(`window.arcPower.windowMaximizeToggle()`);
  await js(`window.arcPower.windowClose()`);
  const opsAfter = { ...getWindowOpCounts() };
  if (opsAfter.minimize !== opsBefore.minimize + 1
    || opsAfter.maximizeToggle !== opsBefore.maximizeToggle + 1
    || opsAfter.close !== opsBefore.close + 1) {
    fail(`window-op counters did not tick: ${JSON.stringify({ before: opsBefore, after: opsAfter })}`);
  }
  step('m4d-sysinfo-window-ops', `sysinfo:get fixture payload verified (CPU ${sysinfo.cpu.name}, ${sysinfo.cpu.cores} cores); window-minimize/maximize-toggle/close ticked the injected counters (${JSON.stringify(opsAfter)})`);

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

  // --- M4-C: canvas hover crosshair + nearest-sample popup ------------------
  // The first segment is expanded (re-opened above): pointer-move over its
  // canvas shows the popup at the NEAREST sample ("1410 MHz · 12 s ago"
  // style); pointer-leave hides it; a COLLAPSED segment never shows it.
  if (!(await waitFor(win, `(() => {
    const canvas = document.querySelector('.seg-card .seg-canvas');
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 }));
    const p = document.querySelector('.seg-popup');
    return !!p && !p.hidden;
  })()`, 10000))) {
    fail('M4-C: the monitoring hover popup did not appear on the EXPANDED segment');
  }
  const popupText = await js(`document.querySelector('.seg-popup')?.textContent ?? ''`);
  if (!/^\d+ MHz · \d+ s ago$/.test(popupText)) {
    fail(`M4-C: monitor popup text is '${popupText}' (expected '<value> MHz · <n> s ago' on the clock segment)`);
  }
  step('mon-m4c-popup', `M4-C: hover popup on the expanded clock segment: '${popupText}'`);
  // M4-C round-2 fix: RIGHT-EDGE hovers — the NEWEST sample, the common
  // case — must keep the popup inside the card. The old unclamped
  // centering (left = 10 + x with x up to w - 8) pushed the ~120px box up
  // to ~60px past the card's right edge and .seg-card{overflow:hidden}
  // clipped the "· N s ago" tail. Hover exactly at the canvas's right edge
  // (xNorm = 1 -> the newest sample) and assert the popup's
  // getBoundingClientRect() is inside the seg-card's. The flip-below is
  // asserted whenever the hovered sample sits in the no-room-above zone
  // (top-edge samples — the box used to park over the segment header):
  // whether that zone is hit depends on the telemetry value at the newest
  // sample, so the class check is conditional, the inside-card check is
  // unconditional (it fails ~60px past the right edge without the clamp).
  const popupInCard = await js(`(() => {
    const card = document.querySelector('.seg-card');
    const canvas = card.querySelector('.seg-canvas');
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 'zero-rect';
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width - 8, clientY: rect.top + rect.height * 0.5 }));
    const popup = card.querySelector('.seg-popup');
    if (!popup || popup.hidden) return 'no-popup';
    const pr = popup.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    const br = popup.parentElement.getBoundingClientRect();
    const inside = pr.left >= cr.left && pr.right <= cr.right && pr.top >= cr.top && pr.bottom <= cr.bottom;
    const py = parseFloat(popup.style.top);
    const below = popup.classList.contains('seg-popup-below');
    // No room above -> the box MUST have flipped below (and the class must
    // be present); room above -> either position is fine (the old code
    // parked it above there without clipping).
    const flipOk = !(py - 6 - pr.height < 0) || below;
    return inside && flipOk
      ? 'ok'
      : JSON.stringify({ pLeft: Math.round(pr.left), pRight: Math.round(pr.right), pTop: Math.round(pr.top), pBottom: Math.round(pr.bottom), cLeft: Math.round(cr.left), cRight: Math.round(cr.right), cTop: Math.round(cr.top), cBottom: Math.round(cr.bottom), inside, below, py, styleLeft: popup.style.left, needFlip: py - 6 - pr.height < 0 });
  })()`);
  if (popupInCard !== 'ok') fail(`M4-C: right-edge hover popup escapes the seg-card (clamp + flip-below): ${popupInCard}`);
  step('mon-m4c-popup-edge', 'M4-C: right-edge hover (newest sample) keeps the popup inside the card — horizontal clamp + top-edge flip-below');
  // M4-C round-1 fix: a STATIONARY hover must survive telemetry ticks —
  // redrawAll passes the persisted hover crosshair back into drawSeries
  // (before the fix the crosshair vanished on every tick while the popup
  // stayed). Probe canvas pixels in the crosshair's column away from the
  // sample: the dashed vertical line lights roughly half of them; without
  // persistence the column is bare (the polyline crosses it at ONE point
  // only — excluded by the band around y; the horizontal grid lines add a
  // handful at most).
  const crosshairOk = await js(`(async () => {
    const canvas = document.querySelector('.seg-card .seg-canvas');
    if (!canvas) return 'no-canvas';
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return 'zero-rect';
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * 0.45, clientY: rect.top + rect.height * 0.5 }));
    const popup = document.querySelector('.seg-popup');
    if (!popup || popup.hidden) return 'no-popup';
    const x = parseFloat(popup.style.left) - 10;
    const y = parseFloat(popup.style.top) - 8;
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    const lit = (px, py) => ctx.getImageData(Math.round(px * dpr), Math.round(py * dpr), 1, 1).data[3] > 0;
    const columnLits = () => {
      let n = 0;
      for (let yy = 12; yy < canvas.clientHeight - 20; yy += 1) {
        if (Math.abs(yy - y) < 10) continue; // the polyline crosses this column at ~y
        if (lit(x, yy)) n++;
      }
      return n;
    };
    const before = columnLits();
    if (before < 10) return 'no-crosshair-at-hover:' + before;
    await new Promise((r) => setTimeout(r, 2600)); // several telemetry ticks
    const after = columnLits();
    return after >= 10 ? 'ok' : 'crosshair-lost-after-tick:' + after + ' (before ' + before + ')';
  })()`);
  if (crosshairOk !== 'ok') fail(`M4-C: monitor crosshair persistence: ${crosshairOk}`);
  step('mon-m4c-crosshair', 'M4-C: the hover crosshair survives telemetry ticks (redrawAll passes the persisted hover through)');
  // pointer-leave hides the popup (and clears the crosshair).
  await js(`document.querySelector('.seg-canvas')?.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }))`);
  if (!(await waitFor(win, `document.querySelector('.seg-popup')?.hidden === true`, 5000))) {
    fail('M4-C: the hover popup did not hide on pointer-leave');
  }
  // A COLLAPSED segment must never show the popup (expand + collapse the
  // second segment, then hover its canvas).
  await js(`document.querySelectorAll('.seg-head')[1].click()`);
  if (!(await waitFor(win, `!document.querySelectorAll('.seg-card .seg-body')[1].hidden`, 5000))) fail('M4-C: the 2nd segment did not expand');
  await js(`document.querySelectorAll('.seg-head')[1].click()`);
  if (!(await waitFor(win, `document.querySelectorAll('.seg-card .seg-body')[1].hidden === true`, 5000))) fail('M4-C: the 2nd segment did not collapse');
  const collapsedOk = await js(`(() => {
    const body = document.querySelectorAll('.seg-card .seg-body')[1];
    const canvas = body.querySelector('.seg-canvas');
    const rect = canvas.getBoundingClientRect();
    canvas.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: rect.left + rect.width * 0.5, clientY: rect.top + rect.height * 0.5 }));
    const p = body.querySelector('.seg-popup');
    return !p || p.hidden;
  })()`);
  if (!collapsedOk) fail('M4-C: a COLLAPSED monitoring segment showed the hover popup (expanded segments only)');
  step('mon-m4c-collapsed', 'M4-C: pointer-leave hides the popup; a collapsed segment never shows it');

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
    if (st.startupRunKey?.enabled) await js(`window.arcPower.startupSet(false, null)`).catch(() => {});
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

  // --- M4-D (user): the profile LOAD auto re-prompt + single retry -------
  // A NEVER-accepted session whose load hits waiver-not-set (the driver
  // lost the waiver, no consent is persisted): MAIN cannot silently re-set
  // (the store is unaccepted), so the failure surfaces — and the renderer
  // re-prompts ONCE (the fresh caps show the driver truth) + retries on
  // accept. The retry lands with REAL changes and exactly one dialog.
  // 1. Dirty the driver state through the OC UI (the session is accepted —
  //    no dialog) so the retry is a real change (the profile holds 210 W /
  //    0 MHz).
  await js(`location.hash = '#/overclocking'`);
  await sleep(250);
  await setSliderFor('powerLimitW', 220);
  await setSliderFor('gpuFreqOffsetMhz', 50);
  await clickApply();
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-D: the retry-setup apply failed');
  await clearToasts();
  await js(`location.hash = '#/profiles'`);
  await sleep(250);
  // 2. The STORE loses the persisted acceptance (a never-accepted session)
  //    while the driver flag + renderer caps still say accepted — the load
  //    gate reads the caps (no gate dialog), the silent re-set in main
  //    reads the store (no auto re-set — the failure surfaces).
  await store.saveSettings({ ...(await store.loadSettings()), waiverAccepted: false });
  // 3. One-shot driver waiver loss on the profile apply.
  backend.injectFail('powerLimitW', 'waiver-not-set', true);
  await clearToasts();
  await clickRowButton('ui-verify profile', 'Load');
  // 4. No gate dialog; the apply answers waiver-not-set and the renderer
  //    AUTO RE-PROMPTS once with the fresh (driver-truth) caps.
  if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Warranty waiver'`, 5000))) {
    fail('M4-D: the profile load did not auto re-prompt the waiver dialog after a waiver-not-set failure (never-accepted session)');
  }
  await js(`document.querySelector('.modal button.btn-danger')?.click()`);
  // 5. Accept -> the retry runs ONCE -> the failed control (power limit)
  //    lands. NOTE: the first attempt partially applied the OTHER controls
  //    (per-control apply semantics — the injected failure only hit
  //    powerLimitW, so the freq 50->0 landed there), so the retry's only
  //    REAL change is the power limit: exactly ONE success toast + the
  //    'Profile loaded' info + no error toast + no second dialog.
  if (!(await waitFor(win, `document.querySelectorAll('.toast-success').length === 1`, 5000))) {
    fail(`M4-D: the profile-load retry did not land the power-limit change (got ${await js(`document.querySelectorAll('.toast-success').length`)} success toasts; toasts=${await js(`Array.from(document.querySelectorAll('.toast')).map((t) => t.className + ':' + t.textContent).join(' | ')`)}; driver=${JSON.stringify(await js(`window.arcPower.getCurrentSettings(0)`))}; storeWaiver=${(await store.loadSettings()).waiverAccepted}; modal=${await js(`!!document.querySelector('.modal')`)})`);
  }
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.toast-info')).some((t) => (t.textContent ?? '').includes('Profile loaded'))`, 5000))) {
    fail('M4-D: the retried profile load did not mark the profile active (no "Profile loaded" info)');
  }
  if (await js(`!!document.querySelector('.modal')`)) fail('M4-D: a second dialog appeared after the retry accept (exactly one re-prompt)');
  if (await js(`!!document.querySelector('.toast-error')`)) fail('M4-D: the retried profile load surfaced an error toast (the failed first attempt must be swallowed by the retry)');
  const retriedLoad = await js(`window.arcPower.getCurrentSettings(0)`);
  if (Math.abs(retriedLoad.powerLimitW - 210) > 1e-6 || Math.abs(retriedLoad.gpuFreqOffsetMhz) > 1e-6) {
    fail(`M4-D: the profile-load retry did not apply the profile: ${JSON.stringify({ pl: retriedLoad.powerLimitW, freq: retriedLoad.gpuFreqOffsetMhz })}`);
  }
  if ((await js(`window.arcPower.waiverGet(0)`)).accepted !== true) fail('M4-D: the re-prompt accept did not persist the waiver');
  // 6. The counter reset: a second load (accepted session now) shows NO
  //    dialog (the gate is skipped and no failure is injected).
  await clearToasts();
  await clickRowButton('ui-verify profile', 'Load');
  await sleep(600);
  if (await js(`!!document.querySelector('.modal')`)) fail('M4-D: the profile load re-prompted after a successful retry (the counter must reset)');
  step('m4d-profiles-retry', `M4-D: profile load hit waiver-not-set (never-accepted store) -> ONE auto re-prompt -> accept -> the retry landed (${retriedLoad.powerLimitW} W / ${retriedLoad.gpuFreqOffsetMhz} MHz read back, 'Profile loaded' info, no error toast); a second load shows no dialog (counter reset)`);
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

  // ocOnBoot round trip (active profile = the copy). M4-D: the toggle state
  // lives under startupRunKey (the apply-profile registration).
  await js(`document.querySelector('.boot-checkbox').click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.startupRunKey?.enabled === true)`, 5000))) fail('start-at-boot ON did not set the Run key (mock)');
  const bootProfile = await js(`window.arcPower.startupGet().then((s) => s.startupRunKey?.profileId)`);
  const copyId = await js(`window.arcPower.profilesList().then((e) => (e.profiles.find((p) => p.name === 'ui-verify copy') ?? {}).id)`);
  if (bootProfile !== copyId) fail(`Run key profile mismatch: ${bootProfile} != ${copyId}`);
  await js(`document.querySelector('.boot-checkbox').click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.startupRunKey?.enabled === false)`, 5000))) fail('start-at-boot OFF did not clear the Run key');
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

  // --- 16. M3-A/M3-B Tweaks page: the catalog renders with the live (mock)
  // --- states; applyable entries get working Enable/Disable/Revert buttons
  // --- (mock apply — no elevation), fullscreen stays read-only ------------
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
  // M3-B: the three applyable entries render ENABLED Enable/Disable/Revert
  // buttons (the M3-A disabled placeholder is gone); fullscreen renders the
  // read-only note with no buttons.
  const actionCountOf = (id) => js(`document.querySelectorAll('.tweak-card[data-tweak="${id}"] .tweak-action').length`);
  for (const id of ['mpo', 'hags', 'game-dvr']) {
    if (!(await waitFor(win, `document.querySelectorAll('.tweak-card[data-tweak="${id}"] .tweak-action').length === 3`))) {
      fail(`${id}: expected 3 action buttons (Enable/Disable/Revert), got ${await actionCountOf(id)}`);
    }
    const actionLabels = await js(`Array.from(document.querySelectorAll('.tweak-card[data-tweak="${id}"] .tweak-action')).map((b) => b.textContent.trim()).join(',')`);
    if (actionLabels !== 'Enable,Disable,Revert') fail(`${id}: action labels are '${actionLabels}'`);
    const disabledAny = await js(`Array.from(document.querySelectorAll('.tweak-card[data-tweak="${id}"] .tweak-action')).some((b) => b.disabled)`);
    if (disabledAny) fail(`${id}: an apply button is disabled while nothing is in flight`);
  }
  if (await actionCountOf('fullscreen-optimizations') !== 0) fail('fullscreen-optimizations must have NO apply buttons (read-only info)');
  if (!(await js(`!!document.querySelector('.tweak-card[data-tweak="fullscreen-optimizations"] .tweak-readonly-note')`))) {
    fail('fullscreen-optimizations is missing the read-only note');
  }
  // Every applyable card explains what its revert restores.
  for (const id of ['mpo', 'hags', 'game-dvr']) {
    const note = await js(`document.querySelector('.tweak-card[data-tweak="${id}"] .tweak-revert-note')?.textContent ?? ''`);
    if (note.trim().length < 20) fail(`${id}: revert note missing: '${note}'`);
  }
  // One apply round trip through the MOCK adapter (no elevation): mpo Enable
  // -> success toast with the per-step detail -> card state refreshes to
  // Active; Revert -> Default.
  await clearToasts();
  await js(`document.querySelector('.tweak-card[data-tweak="mpo"] .tweak-action[data-action="enable"]').click()`);
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('mpo enable success toast missing');
  if (!(await waitFor(win, `(document.querySelector('.tweak-card[data-tweak="mpo"] .tweak-state-label')?.textContent ?? '').trim() === 'Active'`, 5000))) {
    fail(`mpo state did not refresh to Active after enable (got '${await tweakStateOf('mpo')}')`);
  }
  const mpoToast = await js(`document.querySelector('.toast-success .toast-message')?.textContent ?? ''`);
  if (!/MPOHack=1 written to HKLM/.test(mpoToast)) fail(`mpo enable toast lacks the per-step detail: '${mpoToast}'`);
  await clearToasts();
  await js(`document.querySelector('.tweak-card[data-tweak="mpo"] .tweak-action[data-action="revert"]').click()`);
  if (!(await waitFor(win, `(document.querySelector('.tweak-card[data-tweak="mpo"] .tweak-state-label')?.textContent ?? '').trim() === 'Default'`, 5000))) {
    fail(`mpo state did not refresh to Default after revert (got '${await tweakStateOf('mpo')}')`);
  }
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
  const catalog = await js(`window.arcPower.registryCatalog()`);
  if (catalog.entries.length !== 4 || catalog.states.length !== 4) fail(`registry-catalog IPC returned ${catalog.entries.length} entries / ${catalog.states.length} states`);
  step('tweaks', `Tweaks: ${tweakIds} rendered; mpo=Off, hags=Active (HwSchMode=0x2), game-dvr=Default, fullscreen=Active; Enable/Disable/Revert per applyable card (mock round trip: mpo -> Active -> revert -> Default), fullscreen read-only`);

  // --- M4-D (user): the Settings tab --------------------------------------
  // New nav label + page: Start with Windows (the plain-app task via the
  // MOCK startup adapter — never spawns, never elevates), Start minimized
  // (persisted), the app version row.
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.sidebar-link')).some((a) => (a.textContent ?? '').trim() === 'Settings')`))) {
    fail('M4-D: the sidebar has no Settings nav link');
  }
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  // Version row (app:version via the header line's display format).
  if (!(await waitFor(win, `(document.querySelector('.settings-version')?.textContent ?? '').trim() === 'Arc Power Ver. 0.9.12 Alpha'`))) {
    fail(`M4-D: the Settings version row is '${await js(`document.querySelector('.settings-version')?.textContent ?? ''`)}' (expected 'Arc Power Ver. 0.9.12 Alpha')`);
  }
  const startWithBox = `document.querySelector('.settings-checkbox[data-setting="startWithWindows"]')`;
  const startMinBox = `document.querySelector('.settings-checkbox[data-setting="startMinimized"]')`;
  const closeTrayBox = `document.querySelector('.settings-checkbox[data-setting="closeToTray"]')`;
  if (!(await js(`!!${startWithBox} && !!${startMinBox} && !!${closeTrayBox}`))) fail('M4-D: the Settings toggles did not render');
  if (await js(`${startWithBox}.checked`)) fail('M4-D: Start with Windows is checked before anything enabled it');
  // Close to tray round trip (M4-D user): the checkbox persists
  // closeToTray through the profiles-settings-save channel; the main-side
  // close interception is a window-level behavior (live round).
  await js(`${closeTrayBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.closeToTray === true)`, 5000))) {
    fail('M4-D: Close to tray did not persist closeToTray=true');
  }
  if (!(await js(`${closeTrayBox}.checked`))) fail('M4-D: the Close to tray checkbox did not reflect its on state');
  await js(`${closeTrayBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.closeToTray === false)`, 5000))) {
    fail('M4-D: Close to tray did not persist closeToTray=false');
  }
  // Start minimized round trip: the checkbox persists settings.json
  // (startMinimized) through the profiles-settings-save channel.
  await js(`${startMinBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startMinimized === true)`, 5000))) {
    fail('M4-D: Start minimized did not persist startMinimized=true');
  }
  if (!(await js(`${startMinBox}.checked`))) fail('M4-D: the Start minimized checkbox did not reflect its on state');
  await js(`${startMinBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startMinimized === false)`, 5000))) {
    fail('M4-D: Start minimized did not persist startMinimized=false');
  }
  step('m4d-settings-startmin', 'Settings: Start minimized round trip persisted startMinimized true/false; version row OK');
  // Start with Windows round trip + the honest coexistence state. First
  // enable the apply-profile registration (the Profiles page's start-at-boot
  // toggle — mock): the Settings card must SHOW both states honestly.
  await js(`window.arcPower.startupSet(true, 'profile-1')`);
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  if (!(await waitFor(win, `(document.getElementById('page')?.textContent ?? '').includes('Apply active profile at boot')`))) {
    fail('M4-D: the Settings card does not show the apply-profile registration honestly while it is enabled');
  }
  // Enabling Start with Windows creates the app task AND disables the
  // apply-profile registration (coexistence — the two onlogon tasks cannot
  // both be enabled), and persists startWithWindows.
  await clearToasts();
  await js(`${startWithBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot?.enabled === true && s.startupRunKey?.enabled === false)`, 5000))) {
    fail('M4-D: enabling Start with Windows did not create the app task + disable the apply-profile task (coexistence)');
  }
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startWithWindows === true)`, 5000))) {
    fail('M4-D: Start with Windows did not persist startWithWindows=true');
  }
  if (!(await js(`${startWithBox}.checked`))) fail('M4-D: the Start with Windows checkbox did not reflect its on state');
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('M4-D: the Start with Windows enable did not toast success');
  // Toggle off: the app task is deleted (mock) + startWithWindows persists
  // false.
  await clearToasts();
  await js(`${startWithBox}.click()`);
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot?.enabled === false)`, 5000))) {
    fail('M4-D: disabling Start with Windows did not delete the app task');
  }
  if (!(await waitFor(win, `window.arcPower.profilesList().then((e) => e.settings.startWithWindows === false)`, 5000))) {
    fail('M4-D: Start with Windows did not persist startWithWindows=false');
  }
  step('m4d-settings-startwith', 'Settings: Start with Windows round trip (mock app task + coexistence with the apply-profile task + persisted startWithWindows true/false)');
  await clearToasts();

  // --- M4-D review F4: the PARTIAL-FAILURE honesty path -------------------
  // The task write lands but the settings save throws: the catch path must
  // re-query the task truth so the card shows the ENABLED task + the
  // task-vs-settings mismatch hint (never a blindly reverted checkbox that
  // lies about the task). The settings-save failure is injected by wrapping
  // the SESSION store's saveSettings — the very store the IPC handler
  // writes through (the pre-fix catch reverted the checkbox and kept stale
  // bootState, so the card read 'Not active' with no hint).
  await store.saveSettings({ ...(await store.loadSettings()), startWithWindows: false });
  const realSaveSettings = store.saveSettings.bind(store);
  let failSettingsSave = false;
  store.saveSettings = async (settings) => {
    if (failSettingsSave && settings.startWithWindows !== undefined) {
      throw new Error('injected settings-save failure (ui-verify)');
    }
    return realSaveSettings(settings);
  };
  // Re-render the Settings card so it mounts on the disabled baseline.
  await js(`location.hash = '#/dashboard'`);
  await js(`location.hash = '#/settings'`);
  await sleep(250);
  failSettingsSave = true;
  await clearToasts();
  await js(`${startWithBox}.click()`);
  // The task write lands (the app task + the coexistence delete).
  if (!(await waitFor(win, `window.arcPower.startupGet().then((s) => s.applyOnBoot?.enabled === true)`, 5000))) {
    fail('M4-D: the partial-failure task write did not land (setup)');
  }
  if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 5000))) {
    fail('M4-D: the partial-failure settings save did not surface the honest error toast');
  }
  // The card re-rendered from the TASK truth: checkbox on, 'Active' state
  // line, and the mismatch hint explaining the disagreement.
  if (!(await waitFor(win, `${startWithBox}.checked === true`, 5000))) {
    fail('M4-D: the partial failure left the checkbox contradicting the task truth (it must reflect the ENABLED task)');
  }
  if (!(await waitFor(win, `(document.getElementById('page')?.textContent ?? '').includes('The task state and the saved settings disagree')`, 5000))) {
    fail('M4-D: the partial failure did not render the task-vs-settings mismatch hint');
  }
  const partialState = await js(`Array.from(document.querySelectorAll('.settings-state')).map((e) => (e.textContent ?? '').trim()).join(' | ')`);
  if (!partialState.includes('Active: ArcPowerAppOnBoot')) {
    fail(`M4-D: the partial-failure state line does not read the task truth: '${partialState}'`);
  }
  step('m4d-settings-partial', `M4-D: partial failure (task written, settings save failed) -> the card re-read the task truth: checkbox on, 'Active: ArcPowerAppOnBoot', mismatch hint rendered, honest error toast kept`);
  failSettingsSave = false;
  store.saveSettings = realSaveSettings;
  await clearToasts();

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
  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected)');
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

  // M4-A/M4-B: the shared waiver boot-step — the boot prompt appears in
  // EVERY session; Cancel it BEFORE the per-featureset assertions (F4: the
  // b580 apply-dialog section below must see a clean page, not the boot
  // modal).
  const bootAccepted = await bootWaiverStep(win, js, waitFor);
  step('waiver-boot', `boot waiver prompt handled (${process.env.RID_MOCK_WAIVER_PERSISTED === '1' ? 'persisted acceptance: boot prompt SKIPPED entirely (M4-D permanent acceptance)' : 'cancelled'})`);

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

  // M4-A review F2: the featureset variants must not drift from the shared
  // waiver display — the dashboard GPU Health card + waiver row are pinned
  // here like the default flow (5 rows, live per-caps waiver detail).
  if (!(await waitFor(win, `document.querySelectorAll('.health-card').length === 1`))) {
    fail('expected exactly one GPU Health card');
  }
  if (await js(`document.querySelectorAll('.health-card .health-row').length !== 5`)) {
    fail(`health card rows: got ${await js(`document.querySelectorAll('.health-card .health-row').length`)} (expected 5)`);
  }
  const rowIds = await js(`Array.from(document.querySelectorAll('.health-card .health-row')).map((r) => r.dataset.row).join(',')`);
  if (rowIds !== 'driver,device,oc,waiver,app') fail(`health card rows are '${rowIds}' (expected driver,device,oc,waiver,app)`);
  const rowLabels = await js(`Array.from(document.querySelectorAll('.health-card .health-row-label')).map((l) => l.textContent).join('|')`);
  for (const want of ['Driver installed', 'Device detected', 'OC Status', 'OC waiver', 'Arc Power working']) {
    if (!rowLabels.includes(want)) fail(`health card missing row '${want}' (got '${rowLabels}')`);
  }
  const waiverDetailExpr = `document.querySelector('.health-card .health-row[data-row="waiver"] .health-row-detail')?.textContent ?? ''`;
  const waiverExpected = bootAccepted ? 'Accepted' : 'Not Accepted';
  if (!(await waitFor(win, `(${waiverDetailExpr}).trim() === '${waiverExpected}'`, 5000))) {
    fail(`M4-A: the health-card waiver row reads '${await js(waiverDetailExpr)}' (expected '${waiverExpected}')`);
  }
  const waiverDot = await js(`document.querySelector('.health-card .health-row[data-row="waiver"] .status-dot')?.className ?? ''`);
  if (!(bootAccepted ? /status-ok/ : /status-error/).test(waiverDot)) {
    fail(`M4-A: the waiver row dot is '${waiverDot}' (expected ${bootAccepted ? 'ok (green)' : 'error (red)'})`);
  }
  const waiverClickable = await js(`document.querySelector('.health-card .health-row[data-row="waiver"]')?.classList.contains('health-row-clickable')`);
  if (waiverClickable === bootAccepted) fail(`M4-A: waiver row clickability is '${waiverClickable}' (expected ${!bootAccepted} — clickable only while unaccepted)`);
  step('health-card', `GPU Health card: 5 rows '${rowLabels}'; waiver row 'OC waiver — ${waiverExpected}' (${bootAccepted ? 'green, no click action' : 'red, clickable'})`);

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
      // M4-B: the b580 freq range mirrors into the negative half-plane too
      // (-500..500) and the percent units still render with the mirror.
      const b580FreqMin = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('min')`);
      const b580FreqMax = await js(`document.querySelector('.oc-card[data-control="gpuFreqOffsetMhz"] input[type="range"]')?.getAttribute('max')`);
      if (b580FreqMin !== '-500' || b580FreqMax !== '500') fail(`M4-B: b580 freq slider range is '${b580FreqMin}'..'${b580FreqMax}' (expected -500..500)`);
      const b580VoltRange = await js(`document.querySelector('.oc-card[data-control="gpuVoltOffsetV"] .oc-meta .oc-range')?.textContent ?? ''`);
      if (!b580VoltRange.includes('-100') || !b580VoltRange.includes('100')) fail(`M4-B: b580 volt range does not mirror into the negative half: '${b580VoltRange}'`);
      // M3-C-G: the per-card Stock/Medium/Max preset chips are REMOVED.
      const presetCount = await js(`document.querySelectorAll('.oc-card .oc-presets').length`);
      if (presetCount !== 0) fail(`M3-C-G: preset chips still render (${presetCount})`);
      const adv = await js(`document.querySelector('.advanced-card')?.textContent ?? ''`);
      // M4-B: vfCurve stays read-only (no apply path) — the honest M5 text.
      // M4-D (user): the Advanced section renders ONLY supported rows — the
      // b580 surface shows the supported vfCurve + VRAM-offset rows with
      // their M5 notes and NO 'Unsupported on this GPU' rows at all (gpuLock
      // + VRAM voltage are unsupported -> their rows are REMOVED entirely,
      // the editor gated off).
      // M4-D review F1 regression: the supported filter keys on the
      // IGCL-keyed caps.controls (row.control — vramFreqOffset), NOT the
      // canonical settings key (vramFreqOffsetGts): BOTH supported M5 rows
      // MUST render (pre-fix the VRAM row was silently dropped and the old
      // note-only check passed on vfCurve alone).
      const expertRows = await js(`document.querySelectorAll('.expert-row').length`);
      if (expertRows !== 2) fail(`M4-D: b580 advanced must render exactly the 2 supported expert rows (vfCurve + VRAM offset), got ${expertRows}: '${adv}'`);
      if (!adv.includes('Custom VF curve')) fail(`M4-D: b580 advanced is missing the vfCurve row: '${adv}'`);
      if (!adv.includes('VRAM frequency offset')) fail(`M4-D: b580 advanced is missing the supported VRAM frequency offset row: '${adv}'`);
      if (!adv.includes('Supported — editing arrives in M5')) fail(`b580 advanced: a supported expert control is missing its M5 note: '${adv}'`);
      if (adv.includes('Unsupported on this GPU')) fail('M4-D: b580 advanced still renders "Unsupported on this GPU" rows (unsupported controls are removed entirely)');
      if (await js(`!!document.querySelector('.gpu-lock-editor')`)) {
        fail('M4-B: the gpuLock editor is rendered on b580 (gated off — gpuLock unsupported)');
      }
      step('oc-b580', `b580: 4 cards, PL '${plRange}', readout '${plValue}', freq ${b580FreqMin}..${b580FreqMax} MHz, volt '${b580VoltRange}', no preset chips (M3-C-G), gpuLock unsupported (no editor) / vfCurve supported`);
    } else {
      step('oc-generic', `'${fsId}': ${cards} OC cards render`);
    }
  }
  // M4-A review F2: the OC page renders NO waiver status (the row lives only
  // in the dashboard GPU Health card — the apply-time dialog gate below is
  // unaffected).
  if (await js(`(document.getElementById('page')?.textContent ?? '').includes('OC waiver')`)) {
    fail('M4-A: the OC page still renders the waiver status (dashboard health card only)');
  }
  step('waiver-absent-oc', 'OC page has no waiver status row (dashboard health card only)');

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
    // M4-C: the Fixed tab ALWAYS renders in the editable editor — disabled
    // with the honest note (the editable overlay's modes stay ['auto','curve']
    // until the live probe proves fixed writes work).
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.fan-mode-toggle .chip')).some((c) => (c.textContent ?? '').trim() === 'Fixed' && c.disabled === true)`))) {
      fail(`M4-C ('${fsId}'): the Fixed chip must render DISABLED (fixed not in the editable overlay's modes)`);
    }
    const fsFixedNote = await js(`document.querySelector('.fan-fixed-note')?.textContent ?? ''`);
    if (!fsFixedNote.includes('Fixed speed is not supported on this GPU')) {
      fail(`M4-C ('${fsId}'): the honest fixed note is missing: '${fsFixedNote}'`);
    }
    step('fan-editor', `'${fsId}': fan editor rendered (M4-C: Fixed chip disabled + honest note)`);
  }
  // M4-A review F2: the Fan page renders NO waiver status either (the row
  // lives only in the dashboard GPU Health card).
  if (await js(`(document.getElementById('page')?.textContent ?? '').includes('OC waiver')`)) {
    fail('M4-A: the fan page still renders the waiver status (dashboard health card only)');
  }
  step('waiver-absent-fan', 'fan page has no waiver status row (dashboard health card only)');

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

// ---------------------------------------------------------------------------
// M3-B — tweaks-apply variant (RID_MOCK_TWEAKS_APPLY=1)
// ---------------------------------------------------------------------------
//
// Drives the FULL Tweaks apply flow against the MOCK adapters (never
// spawns, never elevates): every applyable entry through
// enable/disable/revert round trips with per-step success toasts + honest
// state refresh; fullscreen stays read-only. Env overlays exercise the
// honesty paths:
//   - RID_MOCK_REGAPPLY_FAIL='<entryId>:<action>' -> that exact action fails
//     mid-way (step 1): the error toast must report the partial apply
//     (which steps landed, nothing rolled back automatically);
//   - RID_MOCK_REGAPPLY_CANCEL=1 -> mpo applies are UAC-declined: the error
//     toast must carry the honest "requires administrator approval" wording
//     and the state must stay untouched.

/**
 * @param {import('electron').BrowserWindow} win
 */
export async function runTweaksApplyVerify(win) {
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

  const failKnob = process.env.RID_MOCK_REGAPPLY_FAIL; // '<entryId>:<action>'
  const cancelKnob = process.env.RID_MOCK_REGAPPLY_CANCEL === '1';

  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected)');
  }
  // M4-A/M4-B: the shared waiver boot-step — the boot prompt appears in
  // EVERY session; Cancel it BEFORE the tweaks flow (F4: no stray modal may
  // sit over the page while the tweaks assertions run).
  await bootWaiverStep(win, js, waitFor);
  step('waiver-boot', `boot waiver prompt handled (${process.env.RID_MOCK_WAIVER_PERSISTED === '1' ? 'persisted acceptance: boot prompt SKIPPED entirely (M4-D permanent acceptance)' : 'cancelled'})`);
  await js(`location.hash = '#/tweaks'`);
  if (!(await waitFor(win, `document.querySelectorAll('.tweak-card').length === 4`))) {
    fail(`tweaks page did not render 4 catalog cards (got ${await js(`document.querySelectorAll('.tweak-card').length`)})`);
  }
  const tweakIds = await js(`Array.from(document.querySelectorAll('.tweak-card')).map((c) => c.dataset.tweak).join(',')`);
  if (tweakIds !== 'mpo,hags,game-dvr,fullscreen-optimizations') fail(`tweak cards are '${tweakIds}'`);

  const stateLabelOf = (id) => js(`document.querySelector('.tweak-card[data-tweak="${id}"] .tweak-state-label')?.textContent ?? ''`);
  const clickAction = (id, action) => js(`document.querySelector('.tweak-card[data-tweak="${id}"] .tweak-action[data-action="${action}"]').click()`);
  const waitForLabel = (id, label) => waitFor(win, `(document.querySelector('.tweak-card[data-tweak="${id}"] .tweak-state-label')?.textContent ?? '').trim() === '${label}'`, 10000);
  // The previous action's state refresh must have fully landed (buttons
  // re-enabled + card present) before the next click - a transient refresh
  // rejection blanking the cards must not race the next interaction.
  const waitButtonsEnabled = (id) => waitFor(win, `!!document.querySelector('.tweak-card[data-tweak="${id}"]') && Array.from(document.querySelectorAll('.tweak-card[data-tweak="${id}"] .tweak-action')).every((b) => !b.disabled)`, 10000);

  // Fixture states before anything runs.
  if (!(await waitFor(win, `(document.querySelector('.tweak-card[data-tweak="mpo"] .tweak-state-label')?.textContent ?? '').trim() === 'Off'`))) {
    fail('tweaks page did not render the fixture states');
  }

  // Every applyable card carries the three action buttons; fullscreen none.
  const actionCountOf = (id) => js(`document.querySelectorAll('.tweak-card[data-tweak="${id}"] .tweak-action').length`);
  for (const id of ['mpo', 'hags', 'game-dvr']) {
    if (await actionCountOf(id) !== 3) fail(`${id}: expected 3 action buttons, got ${await actionCountOf(id)}`);
    const labels = await js(`Array.from(document.querySelectorAll('.tweak-card[data-tweak="${id}"] .tweak-action')).map((b) => b.textContent.trim()).join(',')`);
    if (labels !== 'Enable,Disable,Revert') fail(`${id}: action labels are '${labels}'`);
    if (await js(`Array.from(document.querySelectorAll('.tweak-card[data-tweak="${id}"] .tweak-action')).some((b) => b.disabled)`)) {
      fail(`${id}: an action button is disabled while nothing is in flight`);
    }
  }
  if (await actionCountOf('fullscreen-optimizations') !== 0) fail('fullscreen-optimizations must have NO apply buttons');
  if (!(await js(`!!document.querySelector('.tweak-card[data-tweak="fullscreen-optimizations"] .tweak-readonly-note')`))) fail('fullscreen read-only note missing');
  step('cards', `4 cards render; 3 action buttons per applyable entry, fullscreen read-only`);

  if (cancelKnob) {
    // mpo applies are UAC-declined (mock): the honest cancel toast + the
    // state stays untouched.
    await clearToasts();
    if (!(await waitButtonsEnabled('mpo'))) fail('card absent or buttons still disabled before the next action (mpo)');
    await clickAction('mpo', 'enable');
    if (!(await waitFor(win, `Array.from(document.querySelectorAll('.toast-error')).some((t) => (t.textContent ?? '').includes('requires administrator approval'))`, 5000))) {
      fail(`UAC-decline toast missing: '${await js(`Array.from(document.querySelectorAll('.toast-error')).map((t) => t.textContent).join(' | ')`)}')'`);
    }
    if ((await stateLabelOf('mpo')).trim() !== 'Off') fail(`canceled apply must not change the state (got '${await stateLabelOf('mpo')}')`);
    await clearToasts();
    step('cancel', `UAC-decline path: honest 'requires administrator approval' toast, state untouched`);
  } else if (failKnob) {
    // That exact action fails at step 1 (mock): the error toast reports the
    // PARTIAL apply with the failed step + the no-auto-revert note.
    const [failEntry, failAction] = failKnob.split(':');
    await clearToasts();
    if (!(await waitButtonsEnabled(failEntry))) fail('card absent or buttons still disabled before the next action (failEntry)');
    await clickAction(failEntry, failAction);
    if (!(await waitFor(win, `!!document.querySelector('.toast-error')`, 5000))) fail('partial-failure toast missing');
    const msg = await js(`document.querySelector('.toast-error .toast-message')?.textContent ?? ''`);
    if (!/Partial apply/.test(msg)) fail(`partial-failure toast is not honest: '${msg}'`);
    if (!/1 of 2 step\(s\) landed, step 2 failed/.test(msg)) fail(`partial-failure toast misses the landed/failed steps: '${msg}'`);
    if (!/Nothing was rolled back automatically — use Revert/.test(msg)) fail(`partial-failure toast misses the no-auto-revert note: '${msg}'`);
    // The state refresh reflects what actually landed: the knob fails at the
    // action's LAST step (the mock clamps it there), so for mpo enable the
    // HKLM hive landed (MPOHack=1 -> 'Active') while the failing HKCU step
    // never ran. The two single-step actions (hags/game-dvr) fail their only
    // step -> nothing lands, the fixture state stays.
    if ((await stateLabelOf(failEntry)).trim() !== 'Active') fail(`partial apply state is '${await stateLabelOf(failEntry)}' (expected Active — the landed HKLM hive)`);
    await clearToasts();
    // The user can still Revert (a real revert works — the failure knob is
    // per-action).
    if (!(await waitButtonsEnabled(failEntry))) fail('card absent or buttons still disabled before the next action (failEntry revert)');
    await clickAction(failEntry, 'revert');
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('revert after a partial failure did not succeed');
    if (!(await waitForLabel(failEntry, 'Default'))) fail(`state did not refresh to Default after the post-failure revert (got '${await stateLabelOf(failEntry)}')`);
    await clearToasts();
    step('partial', `partial-failure path: honest per-step toast ('${msg}'), landed state, revert recovers`);
  } else {
    // Full round trips per entry (mock, no elevation).
    // mpo: Off -> enable -> Active -> disable -> Off -> revert -> Default.
    await clearToasts();
    if (!(await waitButtonsEnabled('mpo'))) fail('card absent or buttons still disabled before the next action (mpo roundtrip)');
    await clickAction('mpo', 'enable');
    if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('mpo enable success toast missing');
    if (!(await waitForLabel('mpo', 'Active'))) fail(`mpo did not refresh to Active (got '${await stateLabelOf('mpo')}')`);
    await clearToasts();
    if (!(await waitButtonsEnabled('mpo'))) fail('card absent or buttons still disabled before the next action (mpo disable)');
    await clickAction('mpo', 'disable');
    if (!(await waitForLabel('mpo', 'Off'))) fail(`mpo did not refresh to Off (got '${await stateLabelOf('mpo')}')`);
    await clearToasts();
    if (!(await waitButtonsEnabled('mpo'))) fail('card absent or buttons still disabled before the next action (mpo revert)');
    await clickAction('mpo', 'revert');
    if (!(await waitForLabel('mpo', 'Default'))) fail(`mpo did not refresh to Default (got '${await stateLabelOf('mpo')}')`);
    step('mpo-roundtrip', 'mpo: enable -> Active, disable -> Off, revert -> Default (state refresh per action)');

    // hags: Active -> disable -> Off -> enable -> Active.
    await clearToasts();
    if (!(await waitButtonsEnabled('hags'))) fail('card absent or buttons still disabled before the next action (hags disable)');
    await clickAction('hags', 'disable');
    if (!(await waitForLabel('hags', 'Off'))) fail(`hags did not refresh to Off (got '${await stateLabelOf('hags')}')`);
    await clearToasts();
    if (!(await waitButtonsEnabled('hags'))) fail('card absent or buttons still disabled before the next action (hags enable)');
    await clickAction('hags', 'enable');
    if (!(await waitForLabel('hags', 'Active'))) fail(`hags did not refresh to Active (got '${await stateLabelOf('hags')}')`);
    step('hags-roundtrip', 'hags: disable -> Off, enable -> Active (HwSchMode 1/2)');

    // game-dvr: Default -> enable -> Active -> revert -> Default.
    await clearToasts();
    if (!(await waitButtonsEnabled('game-dvr'))) fail('card absent or buttons still disabled before the next action (game-dvr enable)');
    await clickAction('game-dvr', 'enable');
    if (!(await waitForLabel('game-dvr', 'Active'))) fail(`game-dvr did not refresh to Active (got '${await stateLabelOf('game-dvr')}')`);
    const dvrToast = await js(`document.querySelector('.toast-success .toast-message')?.textContent ?? ''`);
    if (!/AllowGameDVR=0 written to HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\GameDVR/.test(dvrToast)) {
      fail(`game-dvr enable toast lacks the per-step detail: '${dvrToast}'`);
    }
    await clearToasts();
    if (!(await waitButtonsEnabled('game-dvr'))) fail('card absent or buttons still disabled before the next action (game-dvr revert)');
    await clickAction('game-dvr', 'revert');
    if (!(await waitForLabel('game-dvr', 'Default'))) fail(`game-dvr did not refresh to Default (got '${await stateLabelOf('game-dvr')}')`);
    step('dvr-roundtrip', `game-dvr: enable -> Active (toast '${dvrToast.trim()}'), revert -> Default`);
  }

  // The fullscreen card never changes (read-only info) and the catalog IPC
  // still lists 4 entries.
  if ((await stateLabelOf('fullscreen-optimizations')).trim() !== 'Active') fail('fullscreen read-only state changed');
  const catalog = await js(`window.arcPower.registryCatalog()`);
  if (catalog.entries.length !== 4 || catalog.states.length !== 4) fail('registry-catalog IPC mismatch after the apply flow');

  console.log(`\nUI VERIFY OK (tweaks-apply${failKnob ? `, fail=${failKnob}` : ''}${cancelKnob ? ', cancel' : ''})\n` + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}

// ---------------------------------------------------------------------------
// M4-A — fan-gate regression variant (RID_MOCK_FAN_GATE=1)
// ---------------------------------------------------------------------------
//
// The user report: fan-curve applies FAIL without a waiver prompt. This
// variant regression-tests the unaccepted-waiver fan apply through the mock
// (the fan editor is the product apply surface — the dialog gate lives in
// the renderer, so it is exercised end-to-end here, not unit-testable):
//   1. unaccepted boot (shared boot-step cancels the boot prompt); the
//      dashboard health-card waiver row reads Not Accepted (red, clickable);
//   2. first fan apply: the waiver dialog appears -> Cancel -> the apply is
//      ABORTED with the honest info toast and the device stays untouched;
//   3. second fan apply: dialog -> Accept -> the apply LANDS (read-back
//      reflects the edited curve) and the dashboard waiver row flips green;
//   4. M4-D (PERMANENT acceptance): with the store ACCEPTED (the Accept
//      above), the driver losing the waiver mid-session (injected one-shot
//      waiver-not-set) is handled SILENTLY in main — the apply re-sets the
//      driver waiver + retries ONCE (no dialog, no error), the read-back
//      lands, and the dashboard waiver row stays green (the consent stands;
//      the store is never flipped to false).
// The packaged always-elevated path applies in-process (waiver-accept +
// apply run inside the EXE — pinned by elevated-apply.test.js); this
// variant never elevates (mock adapters).

/**
 * @param {import('electron').BrowserWindow} win
 * @param {import('./backend/mock-backend.js').MockBackend} backend
 */
export async function runFanGateVerify(win, backend) {
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

  if (!(await waitFor(win, `document.querySelectorAll('.sidebar-link').length === 7`))) {
    fail('sidebar did not render (7 nav links expected)');
  }
  // M4-A/M4-B: the shared boot-step — the session boots unaccepted -> the
  // boot prompt appears exactly once -> Cancel it (the fan gate below then
  // sees a clean page with a still-unaccepted waiver).
  await bootWaiverStep(win, js, waitFor);
  step('waiver-boot', 'boot waiver prompt handled (cancelled — the fan gate runs unaccepted)');

  const pointsCount = () => js(`document.querySelectorAll('.fan-dot').length`);
  const clickApply = () => js(`(() => { const b = Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Apply fan settings')); if (!b) return false; b.click(); return true; })()`);
  const clickRemove = () => js(`(() => { const b = Array.from(document.querySelectorAll('#page button')).find((b) => b.textContent.includes('Remove point')); if (!b) return false; b.click(); return true; })()`);
  // M4-A (user correction): the waiver STATUS lives ONLY in the dashboard
  // GPU Health card — assert the row state there (red + clickable while
  // unaccepted, green + no click action once accepted).
  const waiverDetailExpr = `document.querySelector('.health-card .health-row[data-row="waiver"] .health-row-detail')?.textContent ?? ''`;
  const expectRow = async (detail, clickable) => {
    if (!(await waitFor(win, `(${waiverDetailExpr}).trim() === '${detail}'`, 5000))) {
      fail(`M4-A: the dashboard waiver row is '${await js(waiverDetailExpr)}' (expected '${detail}')`);
    }
    const clickableNow = await js(`document.querySelector('.health-card .health-row[data-row="waiver"]')?.classList.contains('health-row-clickable')`);
    if (clickableNow !== clickable) fail(`M4-A: the waiver row clickability is '${clickableNow}' (expected ${clickable})`);
  };
  const rowDotOk = () => js(`document.querySelector('.health-card .health-row[data-row="waiver"] .status-dot')?.className ?? ''`);
  const goDashboard = async (label) => {
    await js(`location.hash = '#/dashboard'`);
    await sleep(250);
    step(label, `navigated to the dashboard (waiver row state check)`);
  };
  const goFan = async () => {
    await js(`location.hash = '#/fan'`);
    await sleep(250);
  };

  // --- 1. the dashboard health row shows the unaccepted state ---------------
  await goDashboard('fan-gate-dashboard');
  if (!(await waitFor(win, `document.querySelectorAll('.health-card .health-row').length === 5`))) fail('health card did not render the 5 rows');
  await expectRow('Not Accepted', true);
  if (!/status-error/.test(await rowDotOk())) fail('M4-A: the waiver row dot is not red while unaccepted');
  step('fan-gate-row', 'dashboard waiver row: Not Accepted (red) + clickable (unaccepted boot)');
  // The fan page itself renders NO waiver status (dashboard health card only).
  await goFan();
  if (!(await waitFor(win, `!!document.querySelector('.fan-dot')`))) fail('fan editor dots did not render');
  if (await js(`(document.getElementById('page')?.textContent ?? '').includes('OC waiver')`)) {
    fail('M4-A: the fan page still renders the waiver status (dashboard health card only)');
  }
  step('fan-gate-no-pill', 'fan page has no waiver status row (dashboard health card only)');

  // Make the pending curve a REAL change (10 -> 9 points) so the apply is
  // never a silent no-op.
  const pointsBefore = await pointsCount();
  await clickRemove();
  if (!(await waitFor(win, `document.querySelectorAll('.fan-dot').length === ${pointsBefore - 1}`))) fail('fan point removal did not render');
  step('fan-gate-dirty', `curve edited: ${pointsBefore} -> ${pointsBefore - 1} points`);

  // --- 2. cancel flow: dialog -> Cancel -> aborted + honest toast ---------
  await clickApply();
  if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Warranty waiver'`))) {
    fail('fan apply did not show the waiver dialog while unaccepted');
  }
  step('fan-gate-dialog', 'fan apply shows the waiver dialog (unaccepted store)');
  await clearToasts();
  await js(`document.querySelector('.modal button.btn-ghost')?.click()`);
  if (!(await waitFor(win, `!document.querySelector('.modal')`, 5000))) fail('waiver dialog did not close on Cancel');
  if (!(await waitFor(win, `Array.from(document.querySelectorAll('.toast-info')).some((t) => (t.textContent ?? '').includes('The warranty waiver must be accepted before changing fan settings.'))`, 5000))) {
    fail('fan apply Cancel: honest info toast missing');
  }
  const untouched = await js(`window.arcPower.getCurrentSettings(0)`);
  if (untouched.fanCurve?.length !== pointsBefore || untouched.fanMode !== 'curve') {
    fail(`fan apply ran after Cancel! read-back=${JSON.stringify({ mode: untouched.fanMode, points: untouched.fanCurve?.length })}`);
  }
  step('fan-gate-cancel', `Cancel: apply aborted, device untouched (${untouched.fanCurve?.length} points), honest toast`);

  // --- 3. accept flow: dialog -> Accept -> the apply LANDS -----------------
  await clickApply();
  if (!(await waitFor(win, `document.querySelector('.modal .modal-title')?.textContent === 'Warranty waiver'`))) {
    fail('fan apply did not re-show the waiver dialog after Cancel');
  }
  await clearToasts();
  await js(`document.querySelector('.modal button.btn-danger')?.click()`);
  if (!(await waitFor(win, `!document.querySelector('.modal')`, 5000))) fail('waiver dialog did not close on Accept');
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) fail('fan apply success toast missing after Accept');
  const landed = await js(`window.arcPower.getCurrentSettings(0)`);
  if (landed.fanCurve?.length !== pointsBefore - 1 || landed.fanMode !== 'curve') {
    fail(`fan apply did not land: read-back=${JSON.stringify({ mode: landed.fanMode, points: landed.fanCurve?.length })}`);
  }
  // The dashboard row flipped green — the accept-time + post-apply store
  // re-sets trigger the caps-change re-render.
  await goDashboard('fan-gate-row-accepted');
  await expectRow('Accepted', false);
  if (!/status-ok/.test(await rowDotOk())) fail('M4-A: the waiver row dot is not green once accepted');
  if ((await js(`window.arcPower.waiverGet(0)`)).accepted !== true) fail('waiver not accepted on the device after the fan Accept');
  step('fan-gate-accept', `Accept -> apply landed (${landed.fanCurve?.length} points read back), dashboard waiver row flipped to Accepted (green, not clickable)`);
  await goFan();

  // --- 4. M4-D: the driver loses the waiver mid-session (accepted store) ---
  // The injected ONE-SHOT waiver-not-set mirrors the real driver losing the
  // waiver. M4-D (user, PERMANENT acceptance): with the persisted
  // acceptance TRUE (the fan Accept above), a waiver-not-set apply is
  // SILENTLY re-set + retried ONCE in main — never a dialog, never a
  // dead-end, never a persisted false. The dashboard row stays green (the
  // consent stands — the M4-B "flip to unaccepted + re-prompt" behavior is
  // gone for accepted stores).
  backend.injectFail('fanCurve', 'waiver-not-set', true);
  await clearToasts();
  await clickApply();
  await sleep(400);
  if (await js(`!!document.querySelector('.modal')`)) {
    fail('M4-D: the waiver dialog appeared for an accepted store (the silent re-set + retry must handle waiver-not-set)');
  }
  if (!(await waitFor(win, `!!document.querySelector('.toast-success')`, 5000))) {
    fail('M4-D: the silent retry after waiver-not-set did not land (success toast missing)');
  }
  const healed = await js(`window.arcPower.getCurrentSettings(0)`);
  if (healed.fanCurve?.length !== pointsBefore - 1 || healed.fanMode !== 'curve') {
    fail(`M4-D: the silent retry did not land: read-back=${JSON.stringify({ mode: healed.fanMode, points: healed.fanCurve?.length })}`);
  }
  await goDashboard('fan-gate-heal-dashboard');
  await expectRow('Accepted', false);
  if (!/status-ok/.test(await rowDotOk())) fail('M4-A: the waiver row dot is not green after the silent re-set');
  if ((await js(`window.arcPower.waiverGet(0)`)).accepted !== true) {
    fail('M4-D: the waiver acceptance was lost across the silent re-set (consent stands)');
  }
  step('fan-gate-g2', `M4-D: waiver-not-set apply with an accepted store -> silent re-set + retry landed (${healed.fanCurve?.length} points), NO dialog, dashboard row stays Accepted (the consent stands)`);

  console.log('\nUI VERIFY OK (fan-gate)\n' + steps.map((s) => '  ' + s).join('\n'));
  app.exit(0);
}
